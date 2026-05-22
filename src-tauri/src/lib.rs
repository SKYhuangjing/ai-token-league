use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

// ── Sidecar types ──────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct SidecarResponse {
    id: String,
    ok: bool,
    #[serde(default)]
    data: Value,
    #[serde(default)]
    error: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct SidecarEvent {
    event: String,
    data: Value,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct SidecarRequest {
    id: String,
    command: String,
    args: Value,
}

// ── State ──────────────────────────────────────────────────────────

struct TrayMenuMeta {
    action: String,
    url: String,
}

struct SidecarState {
    tx: mpsc::Sender<SidecarRequest>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<SidecarResponse>>>>,
    #[allow(dead_code)]
    event_tx: broadcast::Sender<SidecarEvent>,
    tray_actions: Arc<Mutex<HashMap<String, TrayMenuMeta>>>,
    tray_rebuild_pending: Arc<AtomicBool>,
    child: Arc<std::sync::Mutex<Option<Child>>>,
    dead: Arc<AtomicBool>,
}

#[derive(Clone)]
struct BackgroundState {
    status: Arc<Mutex<Value>>,
}

struct PendingUpdate {
    update: tauri_plugin_updater::Update,
    path: std::path::PathBuf,
}

impl Drop for PendingUpdate {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

impl Default for BackgroundState {
    fn default() -> Self {
        Self {
            status: Arc::new(Mutex::new(json!({
                "enabled": false,
                "running": false,
                "lastRunAt": null,
                "lastMode": "disabled",
                "lastResult": null,
                "lastError": null,
                "nextRunAt": null,
                "updateCheck": {"status": "idle"}
            }))),
        }
    }
}

impl Drop for SidecarState {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(ref mut c) = *child {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
}

async fn set_background_status(background: &BackgroundState, patch: Value) {
    let mut status = background.status.lock().await;
    if let (Some(target), Some(source)) = (status.as_object_mut(), patch.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn apply_launch_at_login(app: &AppHandle, config: &Value) {
    let enabled = config
        .get("launchAtLogin")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    if let Err(e) = result {
        eprintln!(
            "[autostart] {} failed: {}",
            if enabled { "enable" } else { "disable" },
            e
        );
    }
}

// ── Sidecar communication ──────────────────────────────────────────

async fn call_sidecar(state: &SidecarState, command: &str, args: Value) -> Result<Value, String> {
    if state.dead.load(Ordering::Relaxed) {
        return Err("sidecar process exited".to_string());
    }

    let id = format!("req_{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    let request = SidecarRequest {
        id: id.clone(),
        command: command.to_string(),
        args,
    };

    let (tx, rx) = oneshot::channel();
    {
        let mut map = state.pending.lock().await;
        map.insert(id.clone(), tx);
    }

    state
        .tx
        .send(request)
        .await
        .map_err(|_| "sidecar channel closed".to_string())?;

    let response = tokio::time::timeout(sidecar_timeout_for_command(command), rx)
        .await
        .map_err(|_| "sidecar timeout".to_string())?
        .map_err(|_| "sidecar response dropped".to_string())?;

    if response.ok {
        Ok(response.data)
    } else {
        Err(response.error)
    }
}

fn sidecar_timeout_for_command(command: &str) -> std::time::Duration {
    match command {
        "usage:scan"
        | "usage:scan-start"
        | "usage:scan-status"
        | "usage:summary"
        | "usage:trend"
        | "usage:workdirs"
        | "usage:detail-page"
        | "usage:detail-window"
        | "usage:sync"
        | "usage:sync-start" => std::time::Duration::from_secs(10 * 60),
        _ => std::time::Duration::from_secs(30),
    }
}

// ── Sidecar lifecycle ──────────────────────────────────────────────

fn spawn_sidecar(app: AppHandle) -> Result<SidecarState, String> {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());

    // Try resource dir first (packaged), then workspace target (dev)
    let resource_dir_path = app.path().resource_dir().unwrap_or_default();

    let collector_path = {
        let binary_name = if cfg!(target_os = "windows") {
            "atl-collector.exe"
        } else {
            "atl-collector"
        };

        // Packaged: resource dir — use PathBuf::join to avoid mixed separators
        // with the \\?\ prefix that Windows resource_dir() returns.
        let from_resource = resource_dir_path.join(binary_name);
        // Dev: workspace target/debug
        let from_debug = std::path::PathBuf::from(&cwd)
            .join("target")
            .join("debug")
            .join(binary_name);
        // Dev: workspace target/release
        let from_release = std::path::PathBuf::from(&cwd)
            .join("target")
            .join("release")
            .join(binary_name);

        if from_resource.exists() {
            from_resource.to_string_lossy().to_string()
        } else if from_debug.exists() {
            from_debug.to_string_lossy().to_string()
        } else if from_release.exists() {
            from_release.to_string_lossy().to_string()
        } else {
            return Err(format!(
                "atl-collector binary not found (tried {}, {}, {})",
                from_resource.display(),
                from_debug.display(),
                from_release.display()
            ));
        }
    };

    let mut cmd = Command::new(&collector_path);
    cmd.arg("--sidecar")
        .env(
            "ATL_RESOURCE_DIR",
            resource_dir_path.to_string_lossy().to_string(),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn collector ({}): {}", collector_path, e))?;

    let stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take().ok_or("No stderr")?;

    let child_handle = Arc::new(std::sync::Mutex::new(Some(child)));
    let dead = Arc::new(AtomicBool::new(false));

    // Forward sidecar stderr to process stderr for debugging
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(l) => eprintln!("[sidecar] {}", l),
                Err(_) => break,
            }
        }
    });

    let pending: Arc<Mutex<HashMap<String, oneshot::Sender<SidecarResponse>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let (event_tx, _) = broadcast::channel::<SidecarEvent>(64);
    let (req_tx, mut req_rx) = mpsc::channel::<SidecarRequest>(128);

    // Writer thread — exits when sidecar stdin closes or channel drops
    thread::spawn(move || {
        let mut stdin = stdin;
        while let Some(request) = req_rx.blocking_recv() {
            let line = serde_json::to_string(&request).unwrap();
            if writeln!(stdin, "{}", line).is_err() {
                break;
            }
            let _ = stdin.flush();
        }
    });

    // Reader thread — when it exits, the sidecar is dead
    let pending_reader = pending.clone();
    let event_tx_reader = event_tx.clone();
    let app_reader = app.clone();
    let dead_reader = dead.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            // Response (has "id")
            if let Ok(resp) = serde_json::from_str::<SidecarResponse>(&line) {
                if !resp.id.is_empty() {
                    let mut map = pending_reader.blocking_lock();
                    if let Some(tx) = map.remove(&resp.id) {
                        let _ = tx.send(resp);
                    }
                    continue;
                }
            }
            // Event (has "event")
            if let Ok(evt) = serde_json::from_str::<SidecarEvent>(&line) {
                if !evt.event.is_empty() {
                    let _ = event_tx_reader.send(evt.clone());
                    // Handle special events in Rust
                    match evt.event.as_str() {
                        "tray:rebuild" => {
                            let app = app_reader.clone();
                            tauri::async_runtime::spawn(async move {
                                rebuild_tray_menu_coalesced(&app).await;
                            });
                        }
                        "app:restart" => {
                            app_reader.restart();
                        }
                        _ => {}
                    }
                    let _ = app_reader.emit(&evt.event, &evt.data);
                }
            }
        }
        // Sidecar process exited — mark as dead and fail pending requests
        dead_reader.store(true, Ordering::Relaxed);
        let mut map = pending_reader.blocking_lock();
        for (_, tx) in map.drain() {
            let _ = tx.send(SidecarResponse {
                id: String::new(),
                ok: false,
                data: Value::Null,
                error: "sidecar process exited".to_string(),
            });
        }
        eprintln!("[sidecar] process exited unexpectedly");
    });

    Ok(SidecarState {
        tx: req_tx,
        pending,
        event_tx,
        tray_actions: Arc::new(Mutex::new(HashMap::new())),
        tray_rebuild_pending: Arc::new(AtomicBool::new(false)),
        child: child_handle,
        dead,
    })
}

// ── Tray ───────────────────────────────────────────────────────────

async fn rebuild_tray_menu(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let menu_data = match call_sidecar(&state, "tray:menu-data", json!(null)).await {
        Ok(d) => d,
        Err(_) => return,
    };

    let items = match menu_data.as_array() {
        Some(a) => a,
        None => return,
    };

    // Collect action metadata
    let mut actions: HashMap<String, TrayMenuMeta> = HashMap::new();

    let mut menu_builder = MenuBuilder::new(app);
    for item in items {
        if item.get("type").and_then(|v| v.as_str()) == Some("separator") {
            menu_builder = menu_builder.item(&PredefinedMenuItem::separator(app).unwrap());
            continue;
        }
        let label = item.get("label").and_then(|v| v.as_str()).unwrap_or("");
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let disabled = item
            .get("disabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let action = item
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let url = item
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let menu_item = MenuItemBuilder::new(label)
            .id(id)
            .enabled(!disabled)
            .build(app);

        match menu_item {
            Ok(mi) => {
                menu_builder = menu_builder.item(&mi);
                if !action.is_empty() {
                    actions.insert(id.to_string(), TrayMenuMeta { action, url });
                }
            }
            Err(_) => continue,
        }
    }

    let menu = match menu_builder.build() {
        Ok(m) => m,
        Err(_) => return,
    };

    // Store action map
    {
        let mut map = state.tray_actions.lock().await;
        *map = actions;
    }

    // Get tray and set menu
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_menu(Some(menu));
    }
}

async fn rebuild_tray_menu_coalesced(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let pending = state.tray_rebuild_pending.clone();
    if pending.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    rebuild_tray_menu(app).await;
    pending.store(false, Ordering::SeqCst);
}

fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Use template tray icon on macOS (adapts to dark/light menu bar)
    let Some(default_icon) = app.default_window_icon().cloned() else {
        eprintln!("[tray] default window icon not available; skipping tray setup");
        return Ok(());
    };
    let icon = if cfg!(target_os = "macos") {
        app.path()
            .resolve(
                "icons/tray-iconTemplate.png",
                tauri::path::BaseDirectory::Resource,
            )
            .ok()
            .and_then(|p| std::fs::read(&p).ok())
            .and_then(|bytes| tauri::image::Image::from_bytes(&bytes).ok())
            .unwrap_or(default_icon)
    } else {
        default_icon
    };
    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("AI Token League")
        .show_menu_on_left_click(true)
        .on_menu_event(|tray, event| {
            let id_owned = event.id().as_ref().to_string();
            let app_handle = tray.app_handle().clone();

            tauri::async_runtime::spawn(async move {
                let state = app_handle.state::<SidecarState>();
                let (action, url) = {
                    let actions = state.tray_actions.lock().await;
                    match actions.get(&id_owned) {
                        Some(meta) => (meta.action.clone(), meta.url.clone()),
                        None => (String::new(), String::new()),
                    }
                };

                match action.as_str() {
                    "open" => {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "refresh" => {
                        let _ = app_handle.emit("tray:refresh-start", ());
                        match run_sidecar_refresh(&app_handle, false).await {
                            Ok(_) => {
                                rebuild_tray_menu_coalesced(&app_handle).await;
                                let _ = app_handle.emit("tray:refresh-done", ());
                            }
                            Err(error) => {
                                let _ = app_handle.emit("tray:refresh-failed", json!(error));
                            }
                        }
                    }
                    "visit-cloud" => {
                        if !url.is_empty() {
                            let _ = tauri_plugin_opener::open_url(&url, None::<&str>);
                        }
                    }
                    "quit" => {
                        app_handle.exit(0);
                    }
                    "noop" => {}
                    _ => {}
                }
            });
        })
        .build(app)?;

    // Build initial menu (async)
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        rebuild_tray_menu(&app_clone).await;
    });

    Ok(())
}

// ── Tauri commands ─────────────────────────────────────────────────

#[tauri::command]
async fn forward_to_sidecar(
    app: AppHandle,
    state: State<'_, SidecarState>,
    command: String,
    args: Value,
) -> Result<Value, String> {
    let result = call_sidecar(&state, &command, args).await?;
    if command_updates_usage_cache(&command, &result) {
        rebuild_tray_menu_coalesced(&app).await;
    }
    Ok(result)
}

fn command_updates_usage_cache(command: &str, result: &Value) -> bool {
    if matches!(command, "usage:scan" | "usage:scan-start" | "usage:sync") {
        return true;
    }
    if command != "usage:scan-status" {
        return false;
    }
    let terminal = !status_bool(result, "running") && !status_bool(result, "syncRunning");
    let has_fresh_payload = result
        .get("snapshot")
        .filter(|value| !value.is_null())
        .is_some()
        || result
            .get("syncResult")
            .filter(|value| !value.is_null())
            .is_some();
    terminal && has_fresh_payload
}

#[tauri::command]
async fn rebuild_tray_menu_command(app: AppHandle) -> Result<Value, String> {
    rebuild_tray_menu_coalesced(&app).await;
    Ok(json!({"ok": true}))
}

#[tauri::command]
async fn update_config(
    app: AppHandle,
    state: State<'_, SidecarState>,
    input: Value,
) -> Result<Value, String> {
    let config = call_sidecar(&state, "config:update", input).await?;
    apply_launch_at_login(&app, &config);
    Ok(config)
}

#[tauri::command]
async fn platform() -> String {
    if cfg!(target_os = "macos") {
        "darwin".into()
    } else if cfg!(target_os = "windows") {
        "windows".into()
    } else {
        "linux".into()
    }
}

// ── File dialog commands ───────────────────────────────────────────

#[tauri::command]
async fn export_identity_dialog(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let data = call_sidecar(&state, "identity:export:prepare", json!(null)).await?;
    let file_path = app
        .dialog()
        .file()
        .set_title("Export AI Token League Profile")
        .set_file_name("ai-token-league-profile.json")
        .add_filter("JSON", &["json"])
        .blocking_save_file();
    match file_path {
        Some(path) => {
            let p = path.into_path().map_err(|e| e.to_string())?;
            std::fs::write(&p, serde_json::to_string_pretty(&data).unwrap() + "\n")
                .map_err(|e| e.to_string())?;
            Ok(json!({"canceled": false, "filePath": p.to_string_lossy()}))
        }
        None => Ok(json!({"canceled": true})),
    }
}

#[tauri::command]
async fn export_config_dialog(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let data = call_sidecar(&state, "config:export:prepare", json!(null)).await?;
    let file_path = app
        .dialog()
        .file()
        .set_title("Export AI Token League Config")
        .set_file_name("ai-token-league-config.json")
        .add_filter("JSON", &["json"])
        .blocking_save_file();
    match file_path {
        Some(path) => {
            let p = path.into_path().map_err(|e| e.to_string())?;
            std::fs::write(&p, serde_json::to_string_pretty(&data).unwrap() + "\n")
                .map_err(|e| e.to_string())?;
            Ok(json!({"canceled": false, "filePath": p.to_string_lossy()}))
        }
        None => Ok(json!({"canceled": true})),
    }
}

#[tauri::command]
async fn export_diagnostics_dialog(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let data = call_sidecar(&state, "diagnostics:export:prepare", json!(null)).await?;
    let ts = chrono_ts();
    let default_name = format!("ai-token-league-diagnostics-{}.json", ts);
    let file_path = app
        .dialog()
        .file()
        .set_title("Export AI Token League Diagnostics")
        .set_file_name(&default_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file();
    match file_path {
        Some(path) => {
            let p = path.into_path().map_err(|e| e.to_string())?;
            std::fs::write(&p, serde_json::to_string_pretty(&data).unwrap() + "\n")
                .map_err(|e| e.to_string())?;
            let row_count = data
                .get("usageCache")
                .and_then(|u| u.get("rowCount"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let log_count = data
                .get("runtimeLog")
                .and_then(|u| u.as_array())
                .map(|v| v.len())
                .unwrap_or(0);
            Ok(
                json!({"canceled": false, "filePath": p.to_string_lossy(), "usageRowCount": row_count, "logCount": log_count}),
            )
        }
        None => Ok(json!({"canceled": true})),
    }
}

#[tauri::command]
async fn reveal_runtime_log_directory() -> Result<(), String> {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let dir = home.join(".ai-token-league").join("log");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_local_backup_dialog(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let data = call_sidecar(&state, "local-backup:export:prepare", json!(null)).await?;
    let ts = chrono_ts();
    let default_name = format!("ai-token-league-backup-{}.json", ts);
    let file_path = app
        .dialog()
        .file()
        .set_title("Back Up AI Token League Local Data")
        .set_file_name(&default_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file();
    match file_path {
        Some(path) => {
            let p = path.into_path().map_err(|e| e.to_string())?;
            std::fs::write(&p, serde_json::to_string_pretty(&data).unwrap() + "\n")
                .map_err(|e| e.to_string())?;
            let entry_count = data
                .get("entries")
                .and_then(|entries| entries.as_array())
                .map(|entries| entries.len())
                .unwrap_or(0);
            Ok(
                json!({"canceled": false, "filePath": p.to_string_lossy(), "entryCount": entry_count}),
            )
        }
        None => Ok(json!({"canceled": true})),
    }
}

#[tauri::command]
async fn import_identity_dialog(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let file_path = app
        .dialog()
        .file()
        .set_title("Import AI Token League Profile")
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    match file_path {
        Some(path) => {
            let p = path.into_path().map_err(|e| e.to_string())?;
            let content = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
            let identity: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
            call_sidecar(&state, "identity:import:apply", identity).await
        }
        None => Ok(json!({"canceled": true})),
    }
}

#[tauri::command]
async fn import_config_dialog(
    app: AppHandle,
    state: State<'_, SidecarState>,
    mode: Option<String>,
) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let file_path = app
        .dialog()
        .file()
        .set_title("Import AI Token League Config")
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    match file_path {
        Some(path) => {
            let p = path.into_path().map_err(|e| e.to_string())?;
            let content = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
            let mut config: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
            if let Some(m) = mode {
                if let Some(obj) = config.as_object_mut() {
                    obj.insert("__importMode".to_string(), serde_json::json!(m));
                }
            }
            call_sidecar(&state, "config:import:apply", config).await
        }
        None => Ok(json!({"canceled": true})),
    }
}

#[tauri::command]
async fn restore_local_backup_dialog(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let file_path = app
        .dialog()
        .file()
        .set_title("Restore AI Token League Local Data")
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    match file_path {
        Some(path) => {
            let p = path.into_path().map_err(|e| e.to_string())?;
            let content = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
            let backup: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
            call_sidecar(&state, "local-backup:restore:apply", backup).await
        }
        None => Ok(json!({"canceled": true})),
    }
}

#[tauri::command]
async fn choose_local_backup_directory_dialog(app: AppHandle) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let dir_path = app
        .dialog()
        .file()
        .set_title("Choose AI Token League Backup Folder")
        .blocking_pick_folder();
    match dir_path {
        Some(path) => {
            let p = path.into_path().map_err(|e| e.to_string())?;
            Ok(json!({"canceled": false, "directory": p.to_string_lossy()}))
        }
        None => Ok(json!({"canceled": true})),
    }
}

#[tauri::command]
async fn pick_local_backup_dialog(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let file_path = app
        .dialog()
        .file()
        .set_title("Choose AI Token League Backup")
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    match file_path {
        Some(path) => {
            let p = path.into_path().map_err(|e| e.to_string())?;
            let content = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
            let backup: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
            let summary = call_sidecar(&state, "local-backup:inspect", backup).await?;
            Ok(json!({"canceled": false, "filePath": p.to_string_lossy(), "summary": summary}))
        }
        None => Ok(json!({"canceled": true})),
    }
}

#[tauri::command]
async fn restore_local_backup_file(
    state: State<'_, SidecarState>,
    file_path: String,
) -> Result<Value, String> {
    let content = std::fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let backup: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    call_sidecar(&state, "local-backup:restore:apply", backup).await
}

#[tauri::command]
async fn reveal_local_backup_directory(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn clear_local_backups(state: State<'_, SidecarState>) -> Result<Value, String> {
    call_sidecar(&state, "local-backup:clear", json!(null)).await
}

#[tauri::command]
async fn add_provider_root_dialog(
    app: AppHandle,
    state: State<'_, SidecarState>,
    provider_id: String,
) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let dir_path = app
        .dialog()
        .file()
        .set_title("Add local source location")
        .blocking_pick_folder();
    match dir_path {
        Some(path) => {
            let p = path.into_path().map_err(|e| e.to_string())?;
            call_sidecar(
                &state,
                "providers:add-root",
                json!({"providerId": provider_id, "path": p.to_string_lossy()}),
            )
            .await
        }
        None => Ok(json!({"canceled": true})),
    }
}

// ── Updater commands ─────────────────────────────────────────────

async fn updater_endpoints(state: &SidecarState) -> Vec<url::Url> {
    let api_base = call_sidecar(state, "config:get", json!(null))
        .await
        .ok()
        .and_then(|v| {
            v.get("apiBaseUrl")
                .and_then(|u| u.as_str())
                .map(|s| s.to_string())
        });
    if let Some(base) = api_base {
        let base = base.trim_end_matches('/');
        let url_str = format!("{}/api/tauri/update.json", base);
        url::Url::parse(&url_str).into_iter().collect()
    } else {
        vec![]
    }
}

#[tauri::command]
async fn check_update(app: AppHandle, state: State<'_, SidecarState>) -> Result<Value, String> {
    use tauri_plugin_updater::UpdaterExt;
    let endpoints = updater_endpoints(&state).await;
    if endpoints.is_empty() {
        return Ok(json!({
            "updateAvailable": false,
            "code": "cloud_not_configured",
            "message": "Configure Cloud Connection before checking updates"
        }));
    }
    let updater = app
        .updater_builder()
        .endpoints(endpoints)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let update_available = update.is_some();
    let latest_version = update
        .as_ref()
        .map(|u| u.version.clone())
        .unwrap_or_default();
    let message = if update_available {
        format!("Version {} is available", latest_version)
    } else {
        "Current version is up to date".to_string()
    };
    Ok(json!({
        "code": if update_available { "update_available" } else { "up_to_date" },
        "checkedAt": checked_at_iso(),
        "update": {
            "updateAvailable": update_available,
            "latestVersion": latest_version,
        },
        "message": message,
    }))
}

#[tauri::command]
async fn download_update(
    app: AppHandle,
    state: State<'_, SidecarState>,
    pending: State<'_, Arc<tokio::sync::Mutex<Option<PendingUpdate>>>>,
) -> Result<Value, String> {
    use tauri_plugin_updater::UpdaterExt;
    let endpoints = updater_endpoints(&state).await;
    if endpoints.is_empty() {
        return Err("Cloud not configured".to_string());
    }
    let updater = app
        .updater_builder()
        .endpoints(endpoints)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else {
        return Err("No update available".to_string());
    };
    let mut downloaded = 0u64;
    let start = std::time::Instant::now();
    let bytes = update
        .download(
            |chunk_len, total| {
                downloaded += chunk_len as u64;
                let elapsed = start.elapsed().as_secs_f64();
                let percent = total
                    .map(|t| {
                        if t > 0 {
                            (downloaded * 100 / t) as u64
                        } else {
                            0
                        }
                    })
                    .unwrap_or(0);
                let bps = if elapsed > 0.0 {
                    (downloaded as f64 / elapsed) as u64
                } else {
                    0
                };
                let _ = app.emit(
                    "update:progress",
                    json!({ "downloadProgress": { "percent": percent, "bytesPerSecond": bps } }),
                );
            },
            || {
                let _ = app.emit("update:progress", json!({ "status": "downloaded" }));
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    let temp_dir = std::env::temp_dir().join("ai-token-league-update");
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let temp_path = temp_dir.join(format!("{}.update", update.version));
    std::fs::write(&temp_path, &bytes).map_err(|e| e.to_string())?;
    *pending.lock().await = Some(PendingUpdate {
        update,
        path: temp_path,
    });
    Ok(json!({ "ok": true }))
}

#[tauri::command]
async fn install_and_restart(
    app: AppHandle,
    pending: State<'_, Arc<tokio::sync::Mutex<Option<PendingUpdate>>>>,
) -> Result<(), String> {
    let mut guard = pending.lock().await;
    let pending_update = guard.take().ok_or("No downloaded update to install")?;
    let bytes = std::fs::read(&pending_update.path)
        .map_err(|e| format!("Failed to read update file: {}", e))?;
    pending_update
        .update
        .install(&bytes)
        .map_err(|e| e.to_string())?;
    app.restart();
}

#[tauri::command]
async fn open_url(_app: AppHandle, url: String) -> Result<(), String> {
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_dock_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let policy = if visible {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        app.set_activation_policy(policy)
            .map_err(|e| format!("Failed to set activation policy: {}", e))?;
    }
    let _ = visible; // suppress unused on non-macOS
    let _ = app;
    Ok(())
}

#[tauri::command]
async fn background_status(background: State<'_, BackgroundState>) -> Result<Value, String> {
    Ok(background.status.lock().await.clone())
}

async fn run_sidecar_refresh(app: &AppHandle, sync_to_cloud: bool) -> Result<Value, String> {
    let command = if sync_to_cloud {
        "usage:sync-start"
    } else {
        "usage:scan-start"
    };
    let args = if sync_to_cloud {
        json!(null)
    } else {
        json!({"force": true})
    };
    let sidecar = app.state::<SidecarState>();
    let mut status = call_sidecar(&sidecar, command, args).await?;
    for _ in 0..600 {
        if !status_bool(&status, "running") && !status_bool(&status, "syncRunning") {
            if let Some(error) = status_error(&status) {
                return Err(error);
            }
            return Ok(status);
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let sidecar = app.state::<SidecarState>();
        status = call_sidecar(&sidecar, "usage:scan-status", json!(null)).await?;
    }
    Err("background refresh timeout".to_string())
}

fn status_bool(status: &Value, key: &str) -> bool {
    status.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn status_error(status: &Value) -> Option<String> {
    status
        .get("error")
        .or_else(|| status.get("syncError"))
        .and_then(|v| v.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
}

fn background_refresh_payload<'a>(status: &'a Value, mode: &str) -> &'a Value {
    if mode == "sync" {
        status
            .get("syncResult")
            .filter(|value| !value.is_null())
            .unwrap_or(status)
    } else {
        status
            .get("snapshot")
            .filter(|value| !value.is_null())
            .unwrap_or(status)
    }
}

fn background_refresh_count(payload: &Value) -> u64 {
    payload
        .get("scanned")
        .or_else(|| payload.get("rowCount"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
}

fn background_refresh_interval_secs(config: Option<&Value>) -> u64 {
    config
        .and_then(|v| v.get("refreshIntervalMinutes"))
        .and_then(|v| v.as_u64())
        .unwrap_or(15)
        .max(1)
        .saturating_mul(60)
}

fn background_api_base_url(config: Option<&Value>) -> String {
    config
        .and_then(|v| v.get("apiBaseUrl"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn start_background_refresh(app: AppHandle, background: BackgroundState) {
    tauri::async_runtime::spawn(async move {
        let mut next_run_at: Option<u64> = None;
        let mut last_interval_secs: u64 = 0;
        loop {
            let config = {
                let sidecar = app.state::<SidecarState>();
                call_sidecar(&sidecar, "config:get", json!(null)).await.ok()
            };
            let refresh_secs = background_refresh_interval_secs(config.as_ref());
            let now = unix_now_secs();
            if next_run_at.is_none() || last_interval_secs != refresh_secs {
                next_run_at = Some(now.saturating_add(refresh_secs));
                last_interval_secs = refresh_secs;
            }
            let due_at = next_run_at.unwrap_or_else(|| now.saturating_add(refresh_secs));
            set_background_status(
                &background,
                json!({
                    "enabled": true,
                    "running": false,
                    "nextRunAt": iso_from_unix_secs(due_at),
                    "updateCheck": {"status": "idle"}
                }),
            )
            .await;

            if now < due_at {
                tokio::time::sleep(std::time::Duration::from_secs(
                    (due_at - now).min(60).max(1),
                ))
                .await;
                continue;
            }

            let started_at = checked_at_iso();
            set_background_status(
                &background,
                json!({
                    "running": true,
                    "lastRunAt": started_at,
                    "lastError": null,
                    "lastResult": null,
                    "nextRunAt": null
                }),
            )
            .await;
            let _ = app.emit("tray:refresh-start", json!(null));

            let sync_to_cloud = !background_api_base_url(config.as_ref()).is_empty();
            let mode = if sync_to_cloud { "sync" } else { "scan" };
            let result = run_sidecar_refresh(&app, sync_to_cloud).await;

            match result {
                Ok(value) => {
                    let payload = background_refresh_payload(&value, mode);
                    let count = background_refresh_count(payload);
                    let text = if mode == "sync" {
                        if payload.get("queued").and_then(|v| v.as_bool()) == Some(true) {
                            format!("Queued {} rows", count)
                        } else {
                            format!("Uploaded {} rows", count)
                        }
                    } else {
                        format!("Refreshed {} rows", count)
                    };
                    set_background_status(&background, json!({
                        "running": false,
                        "lastMode": mode,
                        "lastResult": text,
                        "lastError": null,
                        "cacheScannedAt": payload.get("scannedAt").cloned().unwrap_or(Value::Null),
                        "sourceFingerprint": payload.get("sourceFingerprint").cloned().unwrap_or(Value::Null),
                        "rowCount": count
                    })).await;
                    rebuild_tray_menu_coalesced(&app).await;
                    let _ = app.emit("tray:refresh-done", json!(null));
                }
                Err(error) => {
                    set_background_status(
                        &background,
                        json!({
                            "running": false,
                            "lastMode": mode,
                            "lastResult": "Failed",
                            "lastError": error
                        }),
                    )
                    .await;
                    let _ = app.emit("tray:refresh-failed", json!(null));
                }
            }
            next_run_at = Some(unix_now_secs().saturating_add(refresh_secs));
        }
    });
}

fn start_local_backup_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let sidecar = app.state::<SidecarState>();
            let _ = call_sidecar(&sidecar, "local-backup:run-due-auto", json!(null)).await;
            tokio::time::sleep(std::time::Duration::from_secs(
                seconds_until_next_local_midnight(),
            ))
            .await;
        }
    });
}

fn chrono_ts() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    format!("{}", secs)
}

fn unix_now_secs() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn seconds_until_next_local_midnight() -> u64 {
    use chrono::{Duration, Local};
    let now = Local::now();
    let tomorrow = now.date_naive() + Duration::days(1);
    let Some(next_midnight) = tomorrow.and_hms_opt(0, 0, 0) else {
        return 3600;
    };
    let delta = next_midnight - now.naive_local();
    delta.num_seconds().max(60) as u64
}

fn checked_at_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let duration = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    iso_from_unix_secs(duration.as_secs())
}

fn iso_from_unix_secs(secs: u64) -> String {
    // Simple ISO-like format: YYYY-MM-DDTHH:MM:SSZ
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;
    // Days since epoch to Y-M-D (simplified leap year calc)
    let mut y = 1970;
    let mut remaining_days = days;
    loop {
        let days_in_year = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
            366
        } else {
            365
        };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        y += 1;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let month_days: [u64; 12] = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut m = 0;
    while m < 12 && remaining_days >= month_days[m] {
        remaining_days -= month_days[m];
        m += 1;
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m + 1,
        remaining_days + 1,
        hours,
        minutes,
        seconds
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_interval_defaults_and_clamps() {
        assert_eq!(background_refresh_interval_secs(None), 15 * 60);
        assert_eq!(
            background_refresh_interval_secs(Some(&json!({"refreshIntervalMinutes": 0}))),
            60
        );
        assert_eq!(
            background_refresh_interval_secs(Some(&json!({"refreshIntervalMinutes": 3}))),
            3 * 60
        );
    }

    #[test]
    fn background_payload_prefers_terminal_result() {
        let sync_status = json!({
            "syncResult": {"scanned": 7, "queued": true},
            "snapshot": {"rowCount": 99}
        });
        let scan_status = json!({
            "snapshot": {"rowCount": 11}
        });
        assert_eq!(
            background_refresh_count(background_refresh_payload(&sync_status, "sync")),
            7
        );
        assert_eq!(
            background_refresh_count(background_refresh_payload(&scan_status, "scan")),
            11
        );
    }

    #[test]
    fn terminal_refresh_errors_are_exposed() {
        assert_eq!(
            status_error(
                &json!({"running": false, "syncRunning": false, "syncError": "upload failed"})
            ),
            Some("upload failed".to_string())
        );
        assert_eq!(
            status_error(&json!({"running": false, "syncRunning": false, "error": "scan failed"})),
            Some("scan failed".to_string())
        );
        assert_eq!(status_error(&json!({"error": ""})), None);
    }
}

// ── Entry ──────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let state = spawn_sidecar(app.handle().clone())?;
            app.manage(state);
            let background = BackgroundState::default();
            app.manage(background.clone());
            app.manage(Arc::new(tokio::sync::Mutex::new(None::<PendingUpdate>)));

            // Setup tray
            setup_tray(app.handle())?;
            start_background_refresh(app.handle().clone(), background);
            start_local_backup_scheduler(app.handle().clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<SidecarState>();
                if let Ok(config) = call_sidecar(&state, "config:get", json!(null)).await {
                    apply_launch_at_login(&handle, &config);
                }
            });

            // Window close → hide to tray
            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(w) = app_handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            forward_to_sidecar,
            rebuild_tray_menu_command,
            update_config,
            platform,
            set_dock_visible,
            background_status,
            export_identity_dialog,
            export_config_dialog,
            export_diagnostics_dialog,
            reveal_runtime_log_directory,
            export_local_backup_dialog,
            import_identity_dialog,
            import_config_dialog,
            restore_local_backup_dialog,
            choose_local_backup_directory_dialog,
            pick_local_backup_dialog,
            restore_local_backup_file,
            reveal_local_backup_directory,
            clear_local_backups,
            add_provider_root_dialog,
            check_update,
            download_update,
            install_and_restart,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
