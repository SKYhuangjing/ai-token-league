use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
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
}

// ── Sidecar communication ──────────────────────────────────────────

async fn call_sidecar(
    state: &SidecarState,
    command: &str,
    args: Value,
) -> Result<Value, String> {
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

    let response = tokio::time::timeout(std::time::Duration::from_secs(30), rx)
        .await
        .map_err(|_| "sidecar timeout".to_string())?
        .map_err(|_| "sidecar response dropped".to_string())?;

    if response.ok {
        Ok(response.data)
    } else {
        Err(response.error)
    }
}

// ── Sidecar lifecycle ──────────────────────────────────────────────

fn resolve_node_path() -> String {
    // Prefer stable absolute locations when launched from Finder or a packaged app.
    // This avoids paying login-shell startup cost on the common macOS paths.
    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ];
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.to_string();
        }
    }

    // Terminal/dev launches usually have node in PATH already.
    if Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
    {
        return "node".to_string();
    }

    // Last resort: nvm/fnm/volta can require shell initialisation.
    for shell in &["/bin/zsh", "/bin/bash"] {
        if let Ok(out) = Command::new(shell)
            .args(["-l", "-c", "command -v node"])
            .output()
        {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() && std::path::Path::new(&path).exists() {
                return path;
            }
        }
    }

    // Fallback — will fail with a clear error if node is truly missing
    "node".to_string()
}

fn spawn_sidecar(app: AppHandle) -> Result<SidecarState, String> {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());

    // Try resource dir first (packaged), then cwd (dev)
    let resource_dir = app
        .path()
        .resource_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let script_path = {
        let from_resource = format!("{}/src/desktop/sidecar.cjs", resource_dir);
        let from_cwd = format!("{}/src/desktop/sidecar.cjs", cwd);
        if std::path::Path::new(&from_resource).exists() {
            from_resource
        } else {
            from_cwd
        }
    };

    let node_path = resolve_node_path();
    let mut child = Command::new(&node_path)
        .arg(&script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar (node={}): {}", node_path, e))?;

    let stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take().ok_or("No stderr")?;

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

    // Writer thread
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

    // Reader thread
    let pending_reader = pending.clone();
    let event_tx_reader = event_tx.clone();
    let app_reader = app.clone();
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
                                rebuild_tray_menu(&app).await;
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
    });

    Ok(SidecarState {
        tx: req_tx,
        pending,
        event_tx,
        tray_actions: Arc::new(Mutex::new(HashMap::new())),
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
        let label = item
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let disabled = item.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false);
        let action = item.get("action").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();

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

fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Use template tray icon on macOS (adapts to dark/light menu bar)
    let default_icon = app.default_window_icon().cloned().unwrap();
    let icon = if cfg!(target_os = "macos") {
        app.path().resolve("icons/tray-iconTemplate.png", tauri::path::BaseDirectory::Resource)
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
                        let _ = call_sidecar(&app_handle.state::<SidecarState>(), "usage:scan-start", json!(null)).await;
                        rebuild_tray_menu(&app_handle).await;
                        let _ = app_handle.emit("tray:refresh-done", ());
                    }
                    "visit-cloud" => {
                        if !url.is_empty() {
                            use tauri_plugin_shell::ShellExt;
                            let _ = app_handle.shell().open(&url, None);
                        }
                    }
                    "quit" => {
                        app_handle.exit(0);
                    }
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
    state: State<'_, SidecarState>,
    command: String,
    args: Value,
) -> Result<Value, String> {
    call_sidecar(&state, &command, args).await
}

#[tauri::command]
async fn platform() -> String {
    if cfg!(target_os = "macos") { "darwin".into() }
    else if cfg!(target_os = "windows") { "windows".into() }
    else { "linux".into() }
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
            Ok(json!({"canceled": false, "filePath": p.to_string_lossy(), "usageRowCount": row_count}))
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
            let identity: Value =
                serde_json::from_str(&content).map_err(|e| e.to_string())?;
            call_sidecar(&state, "identity:import:apply", identity).await
        }
        None => Ok(json!({"canceled": true})),
    }
}

#[tauri::command]
async fn import_config_dialog(
    app: AppHandle,
    state: State<'_, SidecarState>,
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
            let config: Value =
                serde_json::from_str(&content).map_err(|e| e.to_string())?;
            call_sidecar(&state, "config:import:apply", config).await
        }
        None => Ok(json!({"canceled": true})),
    }
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
    let api_base = call_sidecar(state, "config:get", json!(null)).await.ok()
        .and_then(|v| v.get("apiBaseUrl").and_then(|u| u.as_str()).map(|s| s.to_string()));
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
    let updater = app.updater_builder()
        .endpoints(endpoints)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let update_available = update.is_some();
    let latest_version = update.as_ref().map(|u| u.version.clone()).unwrap_or_default();
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
async fn download_update(app: AppHandle, state: State<'_, SidecarState>) -> Result<Value, String> {
    use tauri_plugin_updater::UpdaterExt;
    let endpoints = updater_endpoints(&state).await;
    if endpoints.is_empty() {
        return Err("Cloud not configured".to_string());
    }
    let updater = app.updater_builder()
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
    update
        .download_and_install(
            |chunk_len, total| {
                downloaded += chunk_len as u64;
                let elapsed = start.elapsed().as_secs_f64();
                let percent = total.map(|t| if t > 0 { (downloaded * 100 / t) as u64 } else { 0 }).unwrap_or(0);
                let bps = if elapsed > 0.0 { (downloaded as f64 / elapsed) as u64 } else { 0 };
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
    Ok(json!({ "ok": true }))
}

#[tauri::command]
async fn install_and_restart(app: AppHandle) -> Result<(), String> {
    app.restart();
}

#[tauri::command]
async fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    app.shell().open(&url, None).map_err(|e| e.to_string())
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

fn chrono_ts() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    format!("{}", secs)
}

fn checked_at_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap();
    let secs = duration.as_secs();
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
        let days_in_year = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) { 366 } else { 365 };
        if remaining_days < days_in_year { break; }
        remaining_days -= days_in_year;
        y += 1;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let month_days: [u64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0;
    while m < 12 && remaining_days >= month_days[m] {
        remaining_days -= month_days[m];
        m += 1;
    }
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m + 1, remaining_days + 1, hours, minutes, seconds)
}

// ── Entry ──────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let state = spawn_sidecar(app.handle().clone())?;
            app.manage(state);

            // Setup tray
            setup_tray(app.handle())?;

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
            platform,
            set_dock_visible,
            export_identity_dialog,
            export_config_dialog,
            export_diagnostics_dialog,
            import_identity_dialog,
            import_config_dialog,
            add_provider_root_dialog,
            check_update,
            download_update,
            install_and_restart,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
