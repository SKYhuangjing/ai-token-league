use collector_core::protocol::{Command, SidecarRequest, SidecarResponse};
use collector_core::config;
use collector_core::scanner;
use collector_core::version;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, Write};
use std::path::PathBuf;

pub async fn run() -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut runtime = SidecarRuntime::default();

    let reader = stdin.lock();
    for line in reader.lines() {
        let line = line.map_err(|e| format!("stdin read error: {}", e))?;
        if line.trim().is_empty() {
            continue;
        }

        let request: SidecarRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let id = request.id.clone();
        let result = handle_command(request, &mut runtime).await;
        let response = match result {
            Ok(data) => SidecarResponse::ok(id, data),
            Err(e) => SidecarResponse::error(id, e),
        };

        let out = serde_json::to_string(&response).unwrap_or_default();
        let _ = writeln!(stdout, "{}", out);
        let _ = stdout.flush();
    }

    Ok(())
}

#[derive(Default)]
struct SidecarRuntime {
    source_cache: HashMap<String, Vec<serde_json::Value>>,
    last_scan_status: Option<serde_json::Value>,
    next_scan_task_id: u64,
}

async fn handle_command(
    request: SidecarRequest,
    runtime: &mut SidecarRuntime,
) -> Result<serde_json::Value, String> {
    let command = Command::from_str(&request.command)
        .ok_or_else(|| format!("unknown command: {}", request.command))?;

    match command {
        Command::Ping => Ok(serde_json::json!({"ok": true, "ts": chrono::Utc::now().timestamp_millis()})),
        Command::AppVersion => Ok(version::client_metadata()),
        Command::ConfigGet => {
            let c = config::ensure_desktop_config();
            Ok(sanitize_config_value(&c))
        }
        Command::ConfigInit => {
            let c = config::init_config(request.args, true);
            Ok(sanitize_config_value(&c))
        }
        Command::ConfigUpdate => {
            let current = config::ensure_desktop_config();
            let c = config::update_config(request.args, &current, true);
            Ok(sanitize_config_value(&c))
        }
        Command::ProvidersAddRoot => {
            let provider_id = request.args["providerId"].as_str().unwrap_or("");
            let path = request.args["path"].as_str().unwrap_or("");
            let current = config::ensure_desktop_config();
            let c = config::add_provider_root(provider_id, path, &current);
            Ok(sanitize_config_value(&c))
        }
        Command::ConfigRemoveProviderRoot => {
            let provider_id = request.args["providerId"].as_str()
                .or_else(|| request.args[0].as_str())
                .unwrap_or("");
            let path = request.args["rootPath"].as_str()
                .or_else(|| request.args[1].as_str())
                .unwrap_or("");
            let current = config::ensure_desktop_config();
            let c = config::remove_provider_root(provider_id, path, &current);
            Ok(sanitize_config_value(&c))
        }
        Command::WorkdirsSetAlias => {
            let hash = request.args["workdirHash"].as_str().unwrap_or("");
            let alias = request.args["alias"].as_str().unwrap_or("");
            let current = config::ensure_desktop_config();
            let c = config::set_workdir_alias(hash, alias, &current);
            Ok(sanitize_config_value(&c))
        }
        Command::UsageScan => {
            let cfg = config::ensure_desktop_config();
            let force = request.args["force"].as_bool().unwrap_or(false);
            let result = scanner::scan_usage_async(&cfg, &mut runtime.source_cache).await;
            if force || !runtime.source_cache.is_empty() {
                runtime.source_cache = result.source_index.clone();
            }
            Ok(serde_json::json!({
                "items": result.items,
                "health": result.health,
                "cacheVersion": collector_core::schema::USAGE_CACHE_VERSION,
                "rowCount": result.items.len(),
                "scannedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "sourceFingerprint": source_fingerprint(&result.items),
                "fromCache": false
            }))
        }
        Command::UsageSync => {
            let cfg = config::ensure_desktop_config();
            if cfg.api_base_url.is_empty() {
                return Err("API base URL not configured".to_string());
            }
            let scan_result = scanner::scan_usage_async(&cfg, &mut runtime.source_cache).await;
            let sync_result = collector_core::sync::sync_usage(
                &cfg,
                &scan_result.items,
                &cfg.api_base_url,
            )
            .await?;
            Ok(serde_json::json!({
                "accepted": sync_result.accepted,
                "rejected": sync_result.rejected,
                "bucketCount": sync_result.bucket_count,
                "uploadedBucketCount": sync_result.uploaded_bucket_count,
                "noopBucketCount": sync_result.noop_bucket_count,
                "queued": sync_result.queued,
                "queuePending": sync_result.queue_pending,
                "queueUploaded": sync_result.queue_uploaded,
                "scanned": scan_result.items.len()
            }))
        }
        Command::ProvidersHealth => {
            let cfg = config::ensure_desktop_config();
            Ok(provider_health(&cfg))
        }
        Command::IdentityExportPrepare => {
            let cfg = config::load_config().ok_or("Not initialized")?;
            Ok(config::export_identity(&cfg))
        }
        Command::IdentityImportApply => {
            let current = config::load_config().ok_or("Not initialized")?;
            let c = config::import_identity(request.args, &current, true);
            Ok(sanitize_config_value(&c))
        }
        Command::TrayMenuData => {
            let cfg = config::load_config();
            let scan_result = if let Some(c) = cfg.as_ref() {
                Some(scanner::scan_usage_async(c, &mut runtime.source_cache).await)
            } else {
                None
            };
            let total_tokens: i64 = scan_result
                .as_ref()
                .map(|r| r.items.iter().map(|i| i["totalTokens"].as_i64().unwrap_or(0)).sum())
                .unwrap_or(0);

            Ok(serde_json::json!([
                {"id": "status", "label": format!("Total: {} tokens", total_tokens), "action": "noop"},
                {"type": "separator"},
                {"id": "refresh", "label": "Refresh Now", "action": "refresh"},
                {"id": "open", "label": "Open", "action": "open"},
                {"type": "separator"},
                {"id": "quit", "label": "Quit", "action": "quit"}
            ]))
        }
        Command::BackgroundStatus => {
            Ok(serde_json::json!({
                "running": false,
                "lastRunAt": null,
                "lastMode": "disabled",
                "lastResult": null,
                "lastError": null,
                "nextRunAt": null,
                "updateCheck": {"status": "idle"}
            }))
        }
        Command::ConfigExportPrepare => {
            let cfg = config::load_config().ok_or("Not initialized")?;
            Ok(config::export_config(&cfg))
        }
        Command::ConfigImportApply => {
            let imported = request.args;
            let c = config::import_config(imported)?;
            Ok(sanitize_config_value(&c))
        }
        Command::DiagnosticsExportPrepare => {
            let cfg = config::ensure_desktop_config();
            Ok(collector_core::diagnostics::export_diagnostics(
                &cfg,
                &serde_json::json!(null),
                &[],
                &[],
            ))
        }
        Command::ApiCheck => {
            let url = request.args["apiBaseUrl"].as_str().unwrap_or("").to_string();
            check_api_connection(&url).await
        }
        Command::CursorAddToken => {
            let current = config::ensure_desktop_config();
            let next = config::add_cursor_token(request.args, &current)?;
            Ok(sanitize_config_value(&next))
        }
        Command::CursorRemoveToken => {
            let current = config::ensure_desktop_config();
            let next = config::remove_cursor_token(request.args, &current);
            Ok(sanitize_config_value(&next))
        }
        Command::ConfigIgnoreAutoSource => {
            let provider_id = request.args["providerId"].as_str()
                .or_else(|| request.args[0].as_str())
                .unwrap_or("");
            let source_id = request.args["sourceId"].as_str()
                .or_else(|| request.args[1].as_str())
                .unwrap_or("");
            let current = config::ensure_desktop_config();
            let next = config::ignore_auto_source(provider_id, source_id, &current);
            Ok(sanitize_config_value(&next))
        }
        Command::ConfigUnignoreAutoSource => {
            let provider_id = request.args["providerId"].as_str()
                .or_else(|| request.args[0].as_str())
                .unwrap_or("");
            let source_id = request.args["sourceId"].as_str()
                .or_else(|| request.args[1].as_str())
                .unwrap_or("");
            let current = config::ensure_desktop_config();
            let next = config::unignore_auto_source(provider_id, source_id, &current);
            Ok(sanitize_config_value(&next))
        }
        Command::MyIdentity => my_identity().await,
        Command::UpdateDownloadInstaller => download_installer().await,
        Command::UpdateEnforcementStatus => Ok(serde_json::json!({"mandatory": false, "compatible": true, "status": "compatible"})),
        Command::AppResetLocalData => {
            config::reset_local_data();
            Ok(serde_json::json!({"ok": true}))
        }
        Command::AppResetWithCloud => {
            let cfg = config::load_config().ok_or("No participant identity found")?;
            if cfg.api_base_url.is_empty() {
                return Err("Configure API base URL first".to_string());
            }
            let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let payload = serde_json::json!({
                "participantId": cfg.participant_id,
                "timestamp": timestamp
            });
            let signature = collector_core::crypto::sign_payload(&cfg.identity_private_key, &payload);
            let client = reqwest::Client::new();
            let body = serde_json::json!({
                "participantId": cfg.participant_id,
                "timestamp": timestamp,
                "signature": signature
            });
            let resp = client
                .delete(format!("{}/api/participant/data", cfg.api_base_url.trim_end_matches('/')))
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Cloud delete failed: {}", e))?;
            if !resp.status().is_success() {
                return Err(format!("Cloud delete failed: {}", resp.status()));
            }
            config::reset_local_data();
            Ok(serde_json::json!({"ok": true}))
        }
        Command::TrayRebuildMenu | Command::TrayRefreshNow => {
            Ok(serde_json::json!({"ok": true}))
        }
        Command::UsageScanStart | Command::UsageScanStatus => {
            if command == Command::UsageScanStatus {
                return Ok(runtime.last_scan_status.clone().unwrap_or_else(|| serde_json::json!({
                    "running": false,
                    "syncRunning": false,
                    "taskId": null,
                    "snapshot": null,
                    "error": null,
                    "syncError": null
                })));
            }

            let cfg = config::ensure_desktop_config();
            runtime.next_scan_task_id = runtime.next_scan_task_id.saturating_add(1);
            let task_id = runtime.next_scan_task_id;
            let started_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let result = scanner::scan_usage_async(&cfg, &mut runtime.source_cache).await;
            runtime.source_cache = result.source_index.clone();
            let finished_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let status = serde_json::json!({
                "running": false,
                "syncRunning": false,
                "taskId": task_id,
                "startedAt": started_at,
                "finishedAt": finished_at,
                "error": null,
                "syncError": null,
                "snapshot": {
                    "items": result.items,
                    "health": result.health,
                    "cacheVersion": collector_core::schema::USAGE_CACHE_VERSION,
                    "rowCount": result.items.len(),
                    "scannedAt": finished_at,
                    "sourceFingerprint": source_fingerprint(&result.items),
                    "fromCache": false
                }
            });
            runtime.last_scan_status = Some(status.clone());
            Ok(status)
        }
        Command::PricingModelPrices => model_prices().await,
    }
}

fn sanitize_config_value(config: &config::AppConfig) -> serde_json::Value {
    let mut value = serde_json::to_value(config).unwrap_or_default();
    if let Some(obj) = value.as_object_mut() {
        obj.remove("identityPrivateKey");
        if let Some(cursor) = obj.get_mut("cursorDashboardUsage").and_then(|v| v.as_object_mut()) {
            if cursor.get("workosSessionToken").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                cursor.insert("workosSessionToken".to_string(), serde_json::json!(""));
            } else {
                cursor.insert("workosSessionToken".to_string(), serde_json::json!("[configured]"));
            }
            if let Some(tokens) = cursor.get_mut("workosSessionTokens").and_then(|v| v.as_array_mut()) {
                for token in tokens {
                    if let Some(token_obj) = token.as_object_mut() {
                        if token_obj.get("token").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                            token_obj.insert("token".to_string(), serde_json::json!(""));
                        } else {
                            token_obj.insert("token".to_string(), serde_json::json!("[configured]"));
                        }
                    }
                }
            }
        }
    }
    value
}

fn provider_health(config: &config::AppConfig) -> serde_json::Value {
    let codex = collector_core::provider::codex_local::CodexProvider;
    let claude = collector_core::provider::claude_code_local::ClaudeCodeLocalProvider;
    let cursor = collector_core::provider::cursor_dashboard::CursorDashboardProvider;
    let codex_roots = codex.scan_sessions(config);
    let claude_roots = claude.scan_sessions(config);
    let cursor_sources = cursor.discover_sources(config);
    serde_json::json!([
        {
            "providerId": codex.id(),
            "enabled": config.provider_enabled.get(codex.id()).copied().unwrap_or(true),
            "detected": !codex_roots.is_empty(),
            "ok": !codex_roots.is_empty(),
            "roots": codex_roots,
            "scannedFiles": codex_roots.len()
        },
        {
            "providerId": claude.id(),
            "enabled": config.provider_enabled.get(claude.id()).copied().unwrap_or(true),
            "detected": !claude_roots.is_empty(),
            "ok": !claude_roots.is_empty(),
            "roots": claude_roots,
            "scannedFiles": claude_roots.len()
        },
        {
            "providerId": cursor.id(),
            "enabled": config.provider_enabled.get(cursor.id()).copied().unwrap_or(false),
            "detected": !cursor_sources.is_empty(),
            "ok": !cursor_sources.is_empty(),
            "roots": cursor_sources.iter().map(|s| s.account_name.clone()).collect::<Vec<_>>(),
            "scannedFiles": cursor_sources.len()
        }
    ])
}

async fn check_api_connection(api_base_url: &str) -> Result<serde_json::Value, String> {
    let normalized = config::normalize_api_base_url(api_base_url);
    let checked_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    if normalized.is_empty() {
        return Ok(serde_json::json!({
            "ok": true,
            "status": "not_configured",
            "apiBaseUrl": "",
            "checkedAt": checked_at,
            "message": "API not configured"
        }));
    }
    let health_url = format!("{}/api/health", normalized);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    match client.get(health_url).send().await {
        Ok(resp) => {
            let status = resp.status();
            let body: serde_json::Value = resp.json().await.unwrap_or_else(|_| serde_json::json!({}));
            if !status.is_success() || body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                return Ok(serde_json::json!({
                    "ok": false,
                    "status": "unreachable",
                    "apiBaseUrl": normalized,
                    "checkedAt": checked_at,
                    "message": format!("{} {}", status.as_u16(), status.canonical_reason().unwrap_or(""))
                }));
            }
            Ok(serde_json::json!({
                "ok": true,
                "status": "reachable",
                "apiBaseUrl": normalized,
                "checkedAt": checked_at,
                "dbType": body["dbType"].clone(),
                "serverTime": body["serverTime"].clone(),
                "serverVersion": body["serverVersion"].clone(),
                "serverProtocolVersion": body["serverProtocolVersion"].clone(),
                "supportedClientProtocol": body["supportedClientProtocol"].clone(),
                "latestClientVersion": body["latestClientVersion"].clone(),
                "compatibility": body["compatibility"].clone(),
                "release": body["release"].clone(),
                "message": "API reachable"
            }))
        }
        Err(error) => Ok(serde_json::json!({
            "ok": false,
            "status": "unreachable",
            "apiBaseUrl": normalized,
            "checkedAt": checked_at,
            "message": format!("API health check failed: {}", error)
        })),
    }
}

async fn model_prices() -> Result<serde_json::Value, String> {
    let cfg = config::ensure_desktop_config();
    if cfg.api_base_url.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    get_json(&format!("{}/api/model-prices", cfg.api_base_url)).await
}

async fn my_identity() -> Result<serde_json::Value, String> {
    let cfg = config::ensure_desktop_config();
    if cfg.api_base_url.is_empty() || cfg.participant_id.is_empty() {
        return Ok(serde_json::json!({"identityMode": "public", "displayName": ""}));
    }
    let url = format!(
        "{}/api/board/my-identity?participantId={}",
        cfg.api_base_url,
        urlencoding::encode(&cfg.participant_id)
    );
    match get_json(&url).await {
        Ok(v) => Ok(v),
        Err(_) => Ok(serde_json::json!({"identityMode": "public", "displayName": ""})),
    }
}

async fn download_installer() -> Result<serde_json::Value, String> {
    let cfg = config::ensure_desktop_config();
    if cfg.api_base_url.is_empty() {
        return Ok(serde_json::json!({"ok": false, "error": "cloud not configured"}));
    }
    let release_config = get_json(&format!("{}/api/release/config", cfg.api_base_url)).await?;
    let platform = version::client_metadata()["clientPlatform"].as_str().unwrap_or("").to_string();
    let installer = release_config
        .pointer(&format!("/release/installers/{}", platform))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let Some(url) = installer.get("url").and_then(|v| v.as_str()) else {
        return Ok(serde_json::json!({"ok": false, "error": format!("no installer available for {}", platform)}));
    };
    let file_name = installer
        .get("fileName")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .unwrap_or_else(|| url.rsplit('/').next().unwrap_or("ai-token-league-installer").to_string());
    let dir = std::env::temp_dir().join("ai-token-league-installer");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file_path = dir.join(file_name);
    let bytes = reqwest::get(url)
        .await
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;
    if let Some(expected) = installer.get("sha256").and_then(|v| v.as_str()).filter(|v| !v.is_empty() && *v != "placeholder") {
        let actual = collector_core::crypto::sha256_bytes_hex(&bytes);
        if actual != expected {
            let _ = fs::remove_file(&file_path);
            return Ok(serde_json::json!({"ok": false, "error": format!("checksum mismatch: expected {}, got {}", expected, actual)}));
        }
    }
    Ok(serde_json::json!({"ok": true, "filePath": path_to_string(file_path)}))
}

async fn get_json(url: &str) -> Result<serde_json::Value, String> {
    let resp = reqwest::get(url).await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("{} {}", status.as_u16(), text));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

fn source_fingerprint(items: &[serde_json::Value]) -> String {
    let mut parts = items
        .iter()
        .map(|item| {
            format!(
                "{}|{}|{}|{}|{}|{}|{}|{}",
                item["day"].as_str().unwrap_or(""),
                item.get("hour").and_then(|v| v.as_i64()).unwrap_or(0),
                item["toolCode"].as_str().unwrap_or(""),
                item["providerId"].as_str().unwrap_or(""),
                item["workdirHash"].as_str().unwrap_or(""),
                item["model"].as_str().unwrap_or(""),
                item["totalTokens"].as_i64().unwrap_or(0),
                item["sourceFingerprint"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>();
    parts.sort();
    collector_core::crypto::sha256_hex(&parts.join("\n"))
}
