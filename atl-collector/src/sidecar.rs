use collector_core::config;
use collector_core::protocol::{Command, SidecarRequest, SidecarResponse};
use collector_core::scanner;
use collector_core::sync::SyncOutcome;
use collector_core::version;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const USAGE_CACHE_TTL_MS: i64 = 5 * 60 * 1000;

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
        let command_name = request.command.clone();
        let args_summary =
            collector_core::observability::summarize_command_args(&command_name, &request.args);
        let started = std::time::Instant::now();
        if command_name != "runtime:log"
            && command_name != "ping"
            && command_name != "diagnostics:status"
            && command_name != "diagnostics:clear-runtime-log"
        {
            collector_core::observability::append_runtime_event(
                "sidecar",
                "command_start",
                "info",
                serde_json::json!({
                    "command": command_name.clone(),
                    "args": args_summary
                }),
            );
        }
        let result = handle_command(request, &mut runtime).await;
        if command_name != "runtime:log"
            && command_name != "ping"
            && command_name != "diagnostics:status"
            && command_name != "diagnostics:clear-runtime-log"
        {
            collector_core::observability::append_runtime_event(
                "sidecar",
                if result.is_ok() {
                    "command_end"
                } else {
                    "command_error"
                },
                if result.is_ok() { "info" } else { "error" },
                serde_json::json!({
                    "command": command_name.clone(),
                    "durationMs": started.elapsed().as_millis() as u64,
                    "result": collector_core::observability::summarize_command_result(&command_name, &result)
                }),
            );
        }
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

struct PendingCursorConnect {
    uuid: String,
    code_verifier: String,
    expires_at: i64,
}

#[derive(Default)]
struct SidecarRuntime {
    last_scan_status: Arc<Mutex<Option<serde_json::Value>>>,
    sync_running: Arc<Mutex<bool>>,
    full_reconcile_running: Arc<Mutex<bool>>,
    worker_lock: Arc<tokio::sync::Mutex<()>>,
    next_scan_task_id: u64,
    tray_estimated_cost_usd: Option<f64>,
    pending_cursor_connect: Option<PendingCursorConnect>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanSyncStatus {
    pub running: bool,
    pub sync_running: bool,
    pub phase: Option<collector_core::sync::SyncRunPhase>,
    pub started: Option<bool>,
    pub task_id: Option<u64>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub force: Option<bool>,
    pub error: Option<String>,
    pub sync_result: Option<serde_json::Value>,
    pub sync_error: Option<String>,
    pub snapshot: Option<serde_json::Value>,
}

async fn handle_command(
    request: SidecarRequest,
    runtime: &mut SidecarRuntime,
) -> Result<serde_json::Value, String> {
    let command = Command::from_str(&request.command)
        .ok_or_else(|| format!("unknown command: {}", request.command))?;

    match command {
        Command::Ping => {
            Ok(serde_json::json!({"ok": true, "ts": chrono::Utc::now().timestamp_millis()}))
        }
        Command::AppVersion => Ok(version::client_metadata()),
        Command::ConfigGet => {
            let c = ensure_config_with_api_connection().await;
            Ok(sanitize_config_value(&c))
        }
        Command::ConfigInit => {
            let input = prepare_config_input(request.args, None).await;
            let c = config::init_config(input, true);
            mark_full_reconcile_pending_for_api_change("", &c.api_base_url);
            Ok(sanitize_config_value(&c))
        }
        Command::ConfigUpdate => {
            let current = config::ensure_desktop_config();
            let input = prepare_config_input(request.args, Some(&current)).await;
            let c = config::update_config(input, &current, true);
            mark_full_reconcile_pending_for_api_change(&current.api_base_url, &c.api_base_url);
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
            let provider_id = request.args["providerId"]
                .as_str()
                .or_else(|| request.args[0].as_str())
                .unwrap_or("");
            let path = request.args["rootPath"]
                .as_str()
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
            invalidate_usage_caches_after_alias_change()?;
            Ok(sanitize_config_value(&c))
        }
        Command::UsageScan => {
            let cfg = config::ensure_desktop_config();
            let force = request.args["force"].as_bool().unwrap_or(false);
            usage_snapshot(&cfg, force).await
        }
        Command::UsageSummary => local_usage_query(|store| {
            let range = arg_str(&request.args, "range", "today");
            store.summary(&range)
        }),
        Command::UsageTrend => local_usage_query(|store| {
            let range = arg_str(&request.args, "range", "today");
            let grain = arg_str(&request.args, "grain", "day");
            store.trend(&range, &grain)
        }),
        Command::UsageWorkdirs => local_usage_query(|store| {
            let range = arg_str(&request.args, "range", "today");
            let limit = arg_i64(&request.args, "limit", 100);
            store.workdirs(&range, limit)
        }),
        Command::UsageDetailPage => local_usage_query(|store| {
            let range = arg_str(&request.args, "range", "today");
            let page = arg_i64(&request.args, "page", 1).max(1);
            let page_size = arg_i64(&request.args, "pageSize", 100).clamp(1, 500);
            store.detail_window(&range, (page - 1) * page_size, page_size)
        }),
        Command::UsageDetailWindow => local_usage_query(|store| {
            let range = arg_str(&request.args, "range", "today");
            let offset = arg_i64(&request.args, "offset", 0);
            let limit = arg_i64(&request.args, "limit", 100);
            store.detail_window(&range, offset, limit)
        }),
        Command::UsageSync => {
            let cfg = config::ensure_desktop_config();
            if cfg.api_base_url.is_empty() {
                return Err("API base URL not configured".to_string());
            }
            let snapshot = usage_snapshot(&cfg, false).await?;
            let _worker_guard = runtime.worker_lock.lock().await;
            let sync_result = sync_snapshot(&cfg, &snapshot).await?;
            trigger_full_reconcile_if_pending(
                &sync_result,
                &cfg,
                Some(snapshot_items(&snapshot)),
                &runtime.full_reconcile_running,
                &runtime.worker_lock,
                &runtime.sync_running,
            );
            Ok(sync_result)
        }
        Command::UsageSyncStart => {
            let existing_status = read_scan_status(&runtime.last_scan_status);
            if existing_status
                .get("running")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
                || existing_status
                    .get("syncRunning")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
            {
                return Ok(existing_status);
            }
            if read_bool_state(&runtime.sync_running) {
                let status =
                    serde_json::json!({"running": false, "syncRunning": true, "started": false});
                write_scan_status(&runtime.last_scan_status, status.clone());
                return Ok(status);
            }
            let cfg = config::ensure_desktop_config();
            if cfg.api_base_url.is_empty() {
                return Err("API base URL not configured".to_string());
            }
            runtime.next_scan_task_id = runtime.next_scan_task_id.saturating_add(1);
            let task_id = runtime.next_scan_task_id;
            let started_at =
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let status = serde_json::json!({
                "running": false,
                "syncRunning": true,
                "phase": "uploading",
                "started": true,
                "taskId": task_id,
                "startedAt": started_at,
                "finishedAt": null,
                "force": false,
                "error": null,
                "syncResult": null,
                "syncError": null,
                "snapshot": null
            });
            write_scan_status(&runtime.last_scan_status, status.clone());
            write_bool_state(&runtime.sync_running, true);
            let scan_status = Arc::clone(&runtime.last_scan_status);
            let reconcile_running = Arc::clone(&runtime.full_reconcile_running);
            let worker_lock = Arc::clone(&runtime.worker_lock);
            let sync_running = Arc::clone(&runtime.sync_running);
            tokio::spawn(async move {
                let snapshot_result = usage_snapshot(&cfg, false).await;
                let finished_at =
                    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let finished_status = match snapshot_result {
                    Ok(snapshot) => {
                        let _worker_guard = worker_lock.lock().await;
                        match sync_snapshot(&cfg, &snapshot).await {
                            Ok(sync_result) => {
                                trigger_full_reconcile_if_pending(
                                    &sync_result,
                                    &cfg,
                                    Some(snapshot_items(&snapshot)),
                                    &reconcile_running,
                                    &worker_lock,
                                    &sync_running,
                                );
                                serde_json::json!({
                                    "running": false,
                                    "syncRunning": false,
                                    "phase": null,
                                    "started": true,
                                    "taskId": task_id,
                                    "startedAt": started_at,
                                    "finishedAt": finished_at,
                                    "force": false,
                                    "error": null,
                                    "syncResult": sync_result,
                                    "syncError": null,
                                    "snapshot": snapshot
                                })
                            }
                            Err(error) => {
                                let now = chrono::Utc::now()
                                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                                persist_sync_status(
                                    &cfg,
                                    SyncOutcome::Failed,
                                    &now,
                                    &now,
                                    None,
                                    &error,
                                );
                                serde_json::json!({
                                    "running": false,
                                    "syncRunning": false,
                                    "started": true,
                                    "taskId": task_id,
                                    "startedAt": started_at,
                                    "finishedAt": finished_at,
                                    "force": false,
                                    "error": null,
                                    "syncResult": null,
                                    "syncError": error,
                                    "snapshot": snapshot
                                })
                            }
                        }
                    }
                    Err(error) => {
                        let now =
                            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                        persist_sync_status(&cfg, SyncOutcome::Failed, &now, &now, None, &error);
                        serde_json::json!({
                            "running": false,
                            "syncRunning": false,
                            "started": true,
                            "taskId": task_id,
                            "startedAt": started_at,
                            "finishedAt": finished_at,
                            "force": false,
                            "error": error,
                            "syncResult": null,
                            "syncError": null,
                            "snapshot": null
                        })
                    }
                };
                write_scan_status(&scan_status, finished_status);
                write_bool_state(&sync_running, false);
            });
            Ok(status)
        }
        Command::ProvidersHealth => {
            let cfg = config::ensure_desktop_config();
            Ok(serde_json::json!(scanner::provider_health(&cfg)))
        }
        Command::IdentityExportPrepare => {
            let cfg = config::load_config().ok_or("Not initialized")?;
            Ok(config::export_identity(&cfg))
        }
        Command::IdentityImportApply => {
            let current = config::load_config().ok_or("Not initialized")?;
            let c = config::import_identity(request.args, &current, true);
            if !c.api_base_url.trim().is_empty() {
                collector_core::reconcile::mark_full_reconcile_pending(
                    &c.api_base_url,
                    collector_core::reconcile::FullReconcileTrigger::BackupRestore,
                );
            }
            Ok(sanitize_config_value(&c))
        }
        Command::TrayMenuData => {
            let cfg = config::load_config();
            if let Some(c) = cfg.as_ref() {
                let cached = read_usage_cache();
                let items = cached
                    .as_ref()
                    .and_then(|value| value.get("items").and_then(|v| v.as_array()).cloned())
                    .unwrap_or_default();
                let scanned_at = cached
                    .as_ref()
                    .and_then(|value| value.get("scannedAt").and_then(|v| v.as_str()));
                let identity = if !c.api_base_url.is_empty() && !c.participant_id.is_empty() {
                    my_identity().await.ok()
                } else {
                    None
                };
                Ok(build_tray_menu_data(
                    c,
                    &items,
                    scanned_at,
                    runtime.tray_estimated_cost_usd,
                    identity.as_ref(),
                ))
            } else {
                Ok(build_tray_menu_data_without_config())
            }
        }
        Command::TrayCostState => {
            runtime.tray_estimated_cost_usd = request
                .args
                .get("estimatedCostUsd")
                .and_then(|value| value.as_f64())
                .filter(|value| value.is_finite() && *value >= 0.0);
            Ok(serde_json::json!({"ok": true}))
        }
        Command::BackgroundStatus => Ok(serde_json::json!({
            "running": false,
            "lastRunAt": null,
            "lastMode": "disabled",
            "lastResult": null,
            "lastError": null,
            "nextRunAt": null,
            "updateCheck": {"status": "idle"}
        })),
        Command::ConfigExportPrepare => {
            let cfg = config::load_config().ok_or("Not initialized")?;
            Ok(config::export_config(&cfg))
        }
        Command::ConfigImportApply => {
            let mode = request
                .args
                .get("__importMode")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mut imported = request.args;
            if let Some(obj) = imported.as_object_mut() {
                obj.remove("__importMode");
            }
            let (c, summary) = config::import_config_with_summary(imported, mode.as_deref())?;
            let mut value = sanitize_config_value(&c);
            if let Some(obj) = value.as_object_mut() {
                obj.insert("importResult".to_string(), summary);
            }
            Ok(value)
        }
        Command::DiagnosticsExportPrepare => {
            let cfg = config::ensure_desktop_config();
            Ok(collector_core::diagnostics::export_diagnostics(&cfg))
        }
        Command::DiagnosticsStatus => Ok(collector_core::observability::diagnostics_status()),
        Command::DiagnosticsClearRuntimeLog => {
            let result = collector_core::observability::clear_runtime_log();
            Ok(result)
        }
        Command::RuntimeLog => {
            let source = request.args["source"].as_str().unwrap_or("renderer");
            let event = request.args["event"].as_str().unwrap_or("event");
            let level = request.args["level"].as_str().unwrap_or("info");
            let data = request
                .args
                .get("data")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            collector_core::observability::append_runtime_event(source, event, level, data);
            Ok(serde_json::json!({"ok": true}))
        }
        Command::LocalBackupExportPrepare => collector_core::local_backup::export_local_backup(),
        Command::LocalBackupStatus => Ok(collector_core::local_backup::backup_status()),
        Command::LocalBackupCreate => {
            let reason = request.args["reason"].as_str().unwrap_or("manual");
            collector_core::local_backup::create_backup_in_configured_directory(reason)
        }
        Command::LocalBackupClear => collector_core::local_backup::clear_configured_backups(),
        Command::LocalBackupRunDueAuto => collector_core::local_backup::run_due_auto_backup(),
        Command::LocalBackupInspect => collector_core::local_backup::inspect_backup(&request.args),
        Command::LocalBackupRestoreApply => {
            let result = collector_core::local_backup::restore_local_backup(request.args)?;
            let cfg = config::ensure_desktop_config();
            if !cfg.api_base_url.trim().is_empty() {
                collector_core::reconcile::mark_full_reconcile_pending(
                    &cfg.api_base_url,
                    collector_core::reconcile::FullReconcileTrigger::BackupRestore,
                );
            }
            Ok(result)
        }
        Command::ApiCheck => {
            let url = request.args["apiBaseUrl"]
                .as_str()
                .unwrap_or("")
                .to_string();
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
        Command::CursorConnectStart => {
            let uuid = collector_core::provider::cursor_auth::generate_uuid();
            let code_verifier = collector_core::provider::cursor_auth::generate_code_verifier();
            let challenge =
                collector_core::provider::cursor_auth::compute_challenge(&code_verifier);
            let login_url = format!(
                "https://cursor.com/loginDeepControl?uuid={}&challenge={}&mode=login",
                uuid, challenge
            );
            let expires_at = chrono::Utc::now().timestamp() + 300;
            runtime.pending_cursor_connect = Some(PendingCursorConnect {
                uuid,
                code_verifier,
                expires_at,
            });
            Ok(serde_json::json!({"loginUrl": login_url, "expiresIn": 300}))
        }
        Command::CursorConnectPoll => {
            let pending = runtime.pending_cursor_connect.take();
            match pending {
                None => Err("no pending connect".to_string()),
                Some(p) => {
                    if chrono::Utc::now().timestamp() > p.expires_at {
                        return Err("expired".to_string());
                    }
                    let result =
                        collector_core::provider::cursor_auth::poll_auth(&p.uuid, &p.code_verifier)
                            .await;
                    match result {
                        Ok(auth_result) => {
                            // Extract sub from accessToken JWT
                            let (sub, exp) =
                                collector_core::provider::cursor_auth::extract_jwt_claims(
                                    &auth_result.access_token,
                                );
                            // Fetch email from cursor.com/api/auth/me
                            let sub_for_cookie = sub.clone().unwrap_or_default();
                            let account_info = if !sub_for_cookie.is_empty() {
                                collector_core::provider::cursor_auth::fetch_account_info(
                                    &auth_result.access_token,
                                    &sub_for_cookie,
                                )
                                .await
                                .ok()
                            } else {
                                None
                            };
                            let email = account_info
                                .as_ref()
                                .map(|i| i.email.clone())
                                .unwrap_or_default();
                            let auth_id = auth_result.auth_id.clone();
                            let now = chrono::Utc::now().to_rfc3339();
                            // Save account to config
                            let current = config::ensure_desktop_config();
                            let participant_id = &current.participant_id;
                            let account_hash = if !email.is_empty() {
                                collector_core::provider::cursor_auth::compute_account_hash(
                                    &email,
                                    participant_id,
                                )
                            } else {
                                collector_core::crypto::sha256_hex(&format!(
                                    "cursor-dashboard:{}:{}",
                                    &auth_id, participant_id
                                ))
                            };
                            let account = config::CursorAccount {
                                access_token: auth_result.access_token,
                                refresh_token: auth_result.refresh_token,
                                auth_id,
                                sub: sub.unwrap_or_default(),
                                email,
                                account_hash,
                                access_token_expires_at: exp,
                                last_refresh_at: Some(now),
                                auth_status: "active".to_string(),
                                ignored: false,
                                added_at: Some(chrono::Utc::now().to_rfc3339()),
                            };
                            let next = config::upsert_cursor_account(account, &current);
                            Ok(sanitize_config_value(&next))
                        }
                        Err(e) => {
                            // Put pending back if still pending (404)
                            if e.contains("pending") || e.contains("404") {
                                runtime.pending_cursor_connect = Some(p);
                                Err("pending".to_string())
                            } else {
                                Err(e)
                            }
                        }
                    }
                }
            }
        }
        Command::CursorConnectCancel => {
            runtime.pending_cursor_connect = None;
            Ok(serde_json::json!({"cancelled": true}))
        }
        Command::CursorDisconnect => {
            let index = request.args["index"].as_u64().unwrap_or(0) as usize;
            let current = config::ensure_desktop_config();
            let mut next = current;
            if index < next.cursor_dashboard_usage.accounts.len() {
                next.cursor_dashboard_usage.accounts.remove(index);
                config::save_config(&next);
            }
            Ok(sanitize_config_value(&next))
        }
        Command::ConfigIgnoreAutoSource => {
            let provider_id = request.args["providerId"]
                .as_str()
                .or_else(|| request.args[0].as_str())
                .unwrap_or("");
            let source_id = request.args["sourceId"]
                .as_str()
                .or_else(|| request.args[1].as_str())
                .unwrap_or("");
            let current = config::ensure_desktop_config();
            let next = config::ignore_auto_source(provider_id, source_id, &current);
            Ok(sanitize_config_value(&next))
        }
        Command::ConfigUnignoreAutoSource => {
            let provider_id = request.args["providerId"]
                .as_str()
                .or_else(|| request.args[0].as_str())
                .unwrap_or("");
            let source_id = request.args["sourceId"]
                .as_str()
                .or_else(|| request.args[1].as_str())
                .unwrap_or("");
            let current = config::ensure_desktop_config();
            let next = config::unignore_auto_source(provider_id, source_id, &current);
            Ok(sanitize_config_value(&next))
        }
        Command::MyIdentity => my_identity().await,
        Command::UsageFullReconcileStart => {
            if read_bool_state(&runtime.full_reconcile_running) {
                return Ok(serde_json::json!({"ok": false, "error": "already running"}));
            }
            let cfg = config::ensure_desktop_config();
            if cfg.api_base_url.is_empty() {
                return Err("API base URL not configured".to_string());
            }
            let trigger = if let Some(trigger_str) = request.args["trigger"].as_str() {
                match trigger_str {
                    "api_base_url_changed" => {
                        collector_core::reconcile::FullReconcileTrigger::ApiBaseUrlChanged
                    }
                    "first_server_identity" => {
                        collector_core::reconcile::FullReconcileTrigger::FirstServerIdentity
                    }
                    "backup_restore" => {
                        collector_core::reconcile::FullReconcileTrigger::BackupRestore
                    }
                    "previous_failed" => {
                        collector_core::reconcile::FullReconcileTrigger::PreviousFailed
                    }
                    _ => collector_core::reconcile::FullReconcileTrigger::MissingHistoryDetected,
                }
            } else {
                collector_core::reconcile::FullReconcileTrigger::MissingHistoryDetected
            };
            collector_core::reconcile::mark_full_reconcile_pending(&cfg.api_base_url, trigger);
            let reconcile_running = Arc::clone(&runtime.full_reconcile_running);
            let worker_lock = Arc::clone(&runtime.worker_lock);
            let sync_running = Arc::clone(&runtime.sync_running);
            write_bool_state(&reconcile_running, true);
            spawn_full_reconcile_job(cfg, None, reconcile_running, worker_lock, sync_running);
            Ok(serde_json::json!({"ok": true, "status": "started"}))
        }
        Command::UsageFullReconcileStatus => {
            let cfg = config::ensure_desktop_config();
            let state = collector_core::reconcile::load_full_reconcile_state(&cfg.api_base_url);
            let running = read_bool_state(&runtime.full_reconcile_running);
            Ok(serde_json::json!({
                "status": serde_json::to_value(&state.status).unwrap_or(serde_json::Value::String("idle".to_string())),
                "trigger": state.trigger.as_ref().map(|t| serde_json::to_value(t).unwrap_or_default()),
                "startedAt": state.started_at,
                "updatedAt": state.updated_at,
                "completedAt": state.completed_at,
                "checkedBucketCount": state.checked_bucket_count,
                "totalBucketCount": state.total_bucket_count,
                "matchedBucketCount": state.matched_bucket_count,
                "missingBucketCount": state.missing_bucket_count,
                "differentBucketCount": state.different_bucket_count,
                "repairUploadedBucketCount": state.repair_uploaded_bucket_count,
                "queuedBucketCount": state.queued_bucket_count,
                "unknownLegacyBucketCount": state.unknown_legacy_bucket_count,
                "lastError": state.last_error,
                "running": running
            }))
        }
        Command::UpdateDownloadInstaller => download_installer().await,
        Command::UpdateEnforcementStatus => {
            Ok(serde_json::json!({"mandatory": false, "compatible": true, "status": "compatible"}))
        }
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
                "deviceId": cfg.device_id,
                "timestamp": timestamp
            });
            let signature =
                collector_core::crypto::sign_payload(&cfg.identity_private_key, &payload);
            let client = reqwest::Client::new();
            let body = serde_json::json!({
                "participantId": cfg.participant_id,
                "deviceId": cfg.device_id,
                "timestamp": timestamp,
                "signature": signature
            });
            let resp = client
                .delete(format!(
                    "{}/api/participant/data",
                    cfg.api_base_url.trim_end_matches('/')
                ))
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
        Command::TrayRebuildMenu | Command::TrayRefreshNow => Ok(serde_json::json!({"ok": true})),
        Command::UsageScanStart | Command::UsageScanStatus => {
            if command == Command::UsageScanStatus {
                return Ok(read_scan_status(&runtime.last_scan_status));
            }

            let force = request.args["force"].as_bool().unwrap_or(false);
            let sync_after = request.args["syncAfter"].as_bool().unwrap_or(false);
            let existing_status = read_scan_status(&runtime.last_scan_status);
            if existing_status
                .get("running")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
                || existing_status
                    .get("syncRunning")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
            {
                return Ok(existing_status);
            }
            if read_bool_state(&runtime.sync_running) {
                let status =
                    serde_json::json!({"running": false, "syncRunning": true, "started": false});
                write_scan_status(&runtime.last_scan_status, status.clone());
                return Ok(status);
            }

            let cfg = config::ensure_desktop_config();
            runtime.next_scan_task_id = runtime.next_scan_task_id.saturating_add(1);
            let task_id = runtime.next_scan_task_id;
            let started_at =
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let status = serde_json::json!({
                "running": true,
                "syncRunning": false,
                "taskId": task_id,
                "startedAt": started_at,
                "finishedAt": null,
                "force": force,
                "error": null,
                "syncResult": null,
                "syncError": null,
                "snapshot": null
            });
            write_scan_status(&runtime.last_scan_status, status.clone());

            let scan_status = Arc::clone(&runtime.last_scan_status);
            let reconcile_running = Arc::clone(&runtime.full_reconcile_running);
            let worker_lock = Arc::clone(&runtime.worker_lock);
            let sync_running = Arc::clone(&runtime.sync_running);
            tokio::spawn(async move {
                let result = usage_snapshot(&cfg, force).await;
                let finished_at =
                    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let finished_status = match result {
                    Ok(snapshot) => {
                        if sync_after && !cfg.api_base_url.is_empty() {
                            write_scan_status(
                                &scan_status,
                                serde_json::json!({
                                    "running": false,
                                    "syncRunning": true,
                                    "phase": "uploading",
                                    "started": true,
                                    "taskId": task_id,
                                    "startedAt": started_at,
                                    "finishedAt": null,
                                    "force": force,
                                    "error": null,
                                    "syncResult": null,
                                    "syncError": null,
                                    "snapshot": snapshot
                                }),
                            );
                            let _worker_guard = worker_lock.lock().await;
                            match sync_snapshot(&cfg, &snapshot).await {
                                Ok(sync_result) => {
                                    trigger_full_reconcile_if_pending(
                                        &sync_result,
                                        &cfg,
                                        Some(snapshot_items(&snapshot)),
                                        &reconcile_running,
                                        &worker_lock,
                                        &sync_running,
                                    );
                                    let sync_finished_at = chrono::Utc::now()
                                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                                    serde_json::json!({
                                        "running": false,
                                        "syncRunning": false,
                                        "phase": null,
                                        "started": true,
                                        "taskId": task_id,
                                        "startedAt": started_at,
                                        "finishedAt": sync_finished_at,
                                        "force": force,
                                        "error": null,
                                        "syncResult": sync_result,
                                        "syncError": null,
                                        "snapshot": snapshot
                                    })
                                }
                                Err(error) => {
                                    let sync_finished_at = chrono::Utc::now()
                                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                                    serde_json::json!({
                                        "running": false,
                                        "syncRunning": false,
                                        "phase": null,
                                        "started": true,
                                        "taskId": task_id,
                                        "startedAt": started_at,
                                        "finishedAt": sync_finished_at,
                                        "force": force,
                                        "error": null,
                                        "syncResult": null,
                                        "syncError": error,
                                        "snapshot": snapshot
                                    })
                                }
                            }
                        } else {
                            serde_json::json!({
                                "running": false,
                                "syncRunning": false,
                                "taskId": task_id,
                                "startedAt": started_at,
                                "finishedAt": finished_at,
                                "force": force,
                                "error": null,
                                "syncResult": null,
                                "syncError": null,
                                "snapshot": snapshot
                            })
                        }
                    }
                    Err(error) => serde_json::json!({
                        "running": false,
                        "syncRunning": false,
                        "taskId": task_id,
                        "startedAt": started_at,
                        "finishedAt": finished_at,
                        "force": force,
                        "error": error,
                        "syncResult": null,
                        "syncError": null,
                        "snapshot": null
                    }),
                };
                write_scan_status(&scan_status, finished_status);
            });
            Ok(status)
        }
        Command::PricingModelPrices => model_prices().await,
    }
}

fn trigger_full_reconcile_if_pending(
    sync_result: &serde_json::Value,
    cfg: &config::AppConfig,
    items: Option<Vec<serde_json::Value>>,
    reconcile_running: &Arc<Mutex<bool>>,
    worker_lock: &Arc<tokio::sync::Mutex<()>>,
    sync_running: &Arc<Mutex<bool>>,
) {
    if sync_result
        .get("fullReconcilePending")
        .and_then(|v| v.as_bool())
        != Some(true)
    {
        return;
    }
    if read_bool_state(reconcile_running) {
        return;
    }
    write_bool_state(reconcile_running, true);
    spawn_full_reconcile_job(
        cfg.clone(),
        items,
        Arc::clone(reconcile_running),
        Arc::clone(worker_lock),
        Arc::clone(sync_running),
    );
}

fn spawn_full_reconcile_job(
    cfg: config::AppConfig,
    initial_items: Option<Vec<serde_json::Value>>,
    reconcile_running: Arc<Mutex<bool>>,
    worker_lock: Arc<tokio::sync::Mutex<()>>,
    sync_running: Arc<Mutex<bool>>,
) {
    tokio::spawn(async move {
        let result_items = if let Some(items) = initial_items {
            items
        } else {
            match collector_core::local_usage_store::LocalUsageStore::open_default()
                .and_then(|store| store.all_usage_items())
            {
                Ok(items) => items,
                Err(error) => {
                    mark_full_reconcile_failed(
                        &cfg.api_base_url,
                        format!(
                            "cannot load local usage facts for full reconcile: {}",
                            error
                        ),
                    );
                    write_bool_state(&reconcile_running, false);
                    return;
                }
            }
        };
        loop {
            while read_bool_state(&sync_running) {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let options = collector_core::reconcile::FullReconcileOptions {
                resume: true,
                max_batches_per_run: 1,
                ..Default::default()
            };
            let result = {
                let _worker_guard = worker_lock.lock().await;
                collector_core::reconcile::full_reconcile_usage(
                    &cfg,
                    &result_items,
                    &cfg.api_base_url,
                    options,
                )
                .await
            };
            match result {
                Ok(result)
                    if result.status == collector_core::reconcile::FullReconcileStatus::Pending =>
                {
                    tokio::task::yield_now().await;
                    continue;
                }
                _ => break,
            }
        }
        write_bool_state(&reconcile_running, false);
    });
}

fn snapshot_items(snapshot: &serde_json::Value) -> Vec<serde_json::Value> {
    snapshot
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

fn mark_full_reconcile_failed(api_base_url: &str, error: String) {
    let mut state = collector_core::reconcile::load_full_reconcile_state(api_base_url);
    state.status = collector_core::reconcile::FullReconcileStatus::Failed;
    state.last_error = error;
    state.updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    collector_core::reconcile::save_full_reconcile_state(api_base_url, &state);
}

fn mark_full_reconcile_pending_for_api_change(previous: &str, next: &str) {
    let previous = config::normalize_api_base_url(previous);
    let next = config::normalize_api_base_url(next);
    if next.is_empty() || previous == next {
        return;
    }
    collector_core::reconcile::mark_full_reconcile_pending(
        &next,
        collector_core::reconcile::FullReconcileTrigger::ApiBaseUrlChanged,
    );
}

fn default_scan_status() -> serde_json::Value {
    serde_json::to_value(ScanSyncStatus::default()).unwrap_or_else(|_| serde_json::json!({}))
}

fn read_scan_status(status: &Arc<Mutex<Option<serde_json::Value>>>) -> serde_json::Value {
    status
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_else(default_scan_status)
}

fn write_scan_status(status: &Arc<Mutex<Option<serde_json::Value>>>, value: serde_json::Value) {
    if let Ok(mut guard) = status.lock() {
        *guard = Some(value);
    }
}

fn read_bool_state(status: &Arc<Mutex<bool>>) -> bool {
    status.lock().map(|guard| *guard).unwrap_or(false)
}

fn write_bool_state(status: &Arc<Mutex<bool>>, value: bool) {
    if let Ok(mut guard) = status.lock() {
        *guard = value;
    }
}

fn sanitize_config_value(config: &config::AppConfig) -> serde_json::Value {
    let mut value = serde_json::to_value(config).unwrap_or_default();
    if let Some(obj) = value.as_object_mut() {
        obj.remove("identityPrivateKey");
        if let Some(cursor) = obj
            .get_mut("cursorDashboardUsage")
            .and_then(|v| v.as_object_mut())
        {
            if cursor
                .get("workosSessionToken")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .is_empty()
            {
                cursor.insert("workosSessionToken".to_string(), serde_json::json!(""));
            } else {
                cursor.insert(
                    "workosSessionToken".to_string(),
                    serde_json::json!("[configured]"),
                );
            }
            if let Some(tokens) = cursor
                .get_mut("workosSessionTokens")
                .and_then(|v| v.as_array_mut())
            {
                for token in tokens {
                    if let Some(token_obj) = token.as_object_mut() {
                        if token_obj
                            .get("token")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .is_empty()
                        {
                            token_obj.insert("token".to_string(), serde_json::json!(""));
                        } else {
                            token_obj
                                .insert("token".to_string(), serde_json::json!("[configured]"));
                        }
                    }
                }
            }
            if let Some(accounts) = cursor.get_mut("accounts").and_then(|v| v.as_array_mut()) {
                for account in accounts {
                    if let Some(acc) = account.as_object_mut() {
                        acc.insert("accessToken".to_string(), serde_json::json!("[configured]"));
                        acc.insert(
                            "refreshToken".to_string(),
                            serde_json::json!("[configured]"),
                        );
                        if let Some(email) = acc.get("email").and_then(|v| v.as_str()) {
                            let at_idx = email.find('@').unwrap_or(email.len());
                            if at_idx > 0 {
                                let masked = format!("{}***{}", &email[..1], &email[at_idx..]);
                                acc.insert("email".to_string(), serde_json::json!(masked));
                            }
                        }
                    }
                }
            }
        }
    }
    value
}

async fn prepare_config_input(
    input: serde_json::Value,
    current: Option<&config::AppConfig>,
) -> serde_json::Value {
    let Some(api_value) = input.get("apiBaseUrl") else {
        return input;
    };
    let Some(raw_api) = api_value.as_str() else {
        return input;
    };
    let normalized = config::normalize_api_base_url(raw_api);
    let previous = current
        .map(|c| config::normalize_api_base_url(&c.api_base_url))
        .unwrap_or_default();
    let needs_check = current.is_none()
        || normalized != previous
        || (normalized.len() > 0
            && current
                .and_then(|c| c.api_connection.get("checkedAt").and_then(|v| v.as_str()))
                .unwrap_or("")
                .is_empty());
    if !needs_check {
        let mut next = input;
        if let Some(obj) = next.as_object_mut() {
            obj.insert("apiBaseUrl".to_string(), serde_json::json!(normalized));
        }
        return next;
    }

    let api_connection = check_api_connection(&normalized)
        .await
        .unwrap_or_else(|error| serde_json::json!({
            "ok": false,
            "status": "unreachable",
            "apiBaseUrl": normalized,
            "checkedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "message": error
        }));
    let mut next = input;
    if let Some(obj) = next.as_object_mut() {
        obj.insert("apiBaseUrl".to_string(), serde_json::json!(normalized));
        obj.insert("apiConnection".to_string(), api_connection);
        if normalized != previous {
            obj.insert("syncStatus".to_string(), serde_json::json!({}));
            obj.insert("lastSyncAt".to_string(), serde_json::json!(""));
            obj.insert("lastSyncStatus".to_string(), serde_json::json!(""));
            obj.insert("lastSyncApiBaseUrl".to_string(), serde_json::json!(""));
            obj.insert("lastSyncError".to_string(), serde_json::json!(""));
        }
    }
    next
}

async fn ensure_config_with_api_connection() -> config::AppConfig {
    let current = config::ensure_desktop_config();
    let normalized = config::normalize_api_base_url(&current.api_base_url);
    if normalized.is_empty()
        || current
            .api_connection
            .get("checkedAt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .len()
            > 0
    {
        return current;
    }

    let api_connection = check_api_connection(&normalized)
        .await
        .unwrap_or_else(|error| serde_json::json!({
            "ok": false,
            "status": "unreachable",
            "apiBaseUrl": normalized,
            "checkedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "message": error
        }));
    let mut next = current;
    next.api_connection = api_connection;
    config::save_config(&next);
    next
}

async fn usage_snapshot(cfg: &config::AppConfig, force: bool) -> Result<serde_json::Value, String> {
    let mut local_store = collector_core::local_usage_store::LocalUsageStore::open_default().ok();
    if !force {
        if let Some(cached) =
            read_usage_cache().filter(|snapshot| is_fresh_usage_cache(snapshot, cfg))
        {
            let sqlite_ready = local_store
                .as_ref()
                .map(|store| store.has_usage_facts().unwrap_or(false))
                .unwrap_or(true);
            if sqlite_ready {
                return Ok(public_usage_snapshot(cached, true));
            }
        }
    }
    let result = if let Some(store) = local_store.as_mut() {
        scanner::scan_usage_async_with_source_cache(cfg, store).await
    } else {
        let source_cache = read_source_index_cache();
        scanner::scan_usage_async(cfg, source_cache).await
    };
    let snapshot = build_usage_snapshot(result.items, result.health, false, cfg);
    if let Some(store) = local_store.as_mut() {
        let scanned_at = snapshot
            .get("scannedAt")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let items = snapshot
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        store.replace_source_cache(&result.source_index, scanned_at)?;
        store.replace_usage_facts(&items, scanned_at)?;
        clear_json_source_index_cache();
    } else {
        write_source_index_cache(&result.source_index, &snapshot)?;
    }
    write_usage_cache(&snapshot)?;
    Ok(snapshot)
}

fn local_usage_query(
    query: impl FnOnce(
        &collector_core::local_usage_store::LocalUsageStore,
    ) -> Result<serde_json::Value, String>,
) -> Result<serde_json::Value, String> {
    let store = collector_core::local_usage_store::LocalUsageStore::open_default()?;
    query(&store)
}

fn arg_str(args: &serde_json::Value, key: &str, default_value: &str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or(default_value)
        .to_string()
}

fn arg_i64(args: &serde_json::Value, key: &str, default_value: i64) -> i64 {
    args.get(key)
        .and_then(|v| v.as_i64())
        .unwrap_or(default_value)
}

fn build_usage_snapshot(
    items: Vec<serde_json::Value>,
    health: Vec<serde_json::Value>,
    from_cache: bool,
    cfg: &config::AppConfig,
) -> serde_json::Value {
    let scanned_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let row_count = items.len();
    let fingerprint = source_fingerprint(&items);
    let config_fingerprint = usage_source_config_fingerprint(cfg);
    serde_json::json!({
        "items": items,
        "health": health,
        "cacheVersion": collector_core::schema::USAGE_CACHE_VERSION,
        "rowCount": row_count,
        "scannedAt": scanned_at,
        "sourceFingerprint": fingerprint,
        "usageSourceConfigFingerprint": config_fingerprint,
        "fromCache": from_cache
    })
}

fn public_usage_snapshot(mut snapshot: serde_json::Value, from_cache: bool) -> serde_json::Value {
    if let Some(obj) = snapshot.as_object_mut() {
        obj.insert("fromCache".to_string(), serde_json::json!(from_cache));
        obj.remove("sourceIndex");
    }
    snapshot
}

fn read_usage_cache() -> Option<serde_json::Value> {
    let content = fs::read_to_string(config::usage_cache_path()).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    let version = value
        .get("cacheVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if version == collector_core::schema::USAGE_CACHE_VERSION as u64 {
        Some(value)
    } else {
        None
    }
}

fn write_usage_cache(snapshot: &serde_json::Value) -> Result<(), String> {
    config::ensure_app_dir();
    let mut light_snapshot = snapshot.clone();
    if let Some(obj) = light_snapshot.as_object_mut() {
        obj.remove("sourceIndex");
    }
    let text = serde_json::to_string_pretty(&light_snapshot).map_err(|e| e.to_string())?;
    fs::write(config::usage_cache_path(), format!("{}\n", text)).map_err(|e| e.to_string())
}

fn invalidate_usage_caches_after_alias_change() -> Result<(), String> {
    match fs::remove_file(config::usage_cache_path()) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    clear_json_source_index_cache();
    if let Ok(mut store) = collector_core::local_usage_store::LocalUsageStore::open_default() {
        store.clear_source_cache()?;
    }
    Ok(())
}

fn is_fresh_usage_cache(snapshot: &serde_json::Value, cfg: &config::AppConfig) -> bool {
    if snapshot
        .get("usageSourceConfigFingerprint")
        .and_then(|v| v.as_str())
        != Some(usage_source_config_fingerprint(cfg).as_str())
    {
        return false;
    }
    let Some(scanned_at) = snapshot.get("scannedAt").and_then(|v| v.as_str()) else {
        return false;
    };
    let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(scanned_at) else {
        return false;
    };
    chrono::Utc::now().timestamp_millis() - parsed.timestamp_millis() < USAGE_CACHE_TTL_MS
}

fn source_cache_from_snapshot(
    snapshot: Option<&serde_json::Value>,
) -> HashMap<String, Vec<serde_json::Value>> {
    let mut result = HashMap::new();
    let Some(snapshot) = snapshot else {
        return result;
    };
    let raw_source_index = snapshot.get("sourceIndex").unwrap_or(snapshot);
    let source_index = raw_source_index.get("sources").unwrap_or(raw_source_index);
    if let Some(obj) = source_index.as_object() {
        for (fingerprint, value) in obj {
            if let Some(items) = value.as_array() {
                result.insert(fingerprint.clone(), items.clone());
            } else if let Some(items) = value.get("items").and_then(|v| v.as_array()) {
                result.insert(fingerprint.clone(), items.clone());
            }
        }
    }
    result
}

fn read_source_index_cache() -> HashMap<String, Vec<serde_json::Value>> {
    let split_cache = read_split_source_index_cache();
    if !split_cache.is_empty() {
        return split_cache;
    }
    if let Some(value) = fs::read_to_string(config::source_index_cache_path())
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
    {
        return source_cache_from_snapshot(Some(&value));
    }
    source_cache_from_snapshot(read_usage_cache().as_ref())
}

fn clear_json_source_index_cache() {
    let _ = fs::remove_file(config::source_index_cache_path());
    let dir = config::source_index_cache_dir();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) == Some("json") {
                let _ = fs::remove_file(path);
            }
        }
    }
    let _ = fs::remove_dir(&dir);
}

fn read_split_source_index_cache() -> HashMap<String, Vec<serde_json::Value>> {
    let mut result = HashMap::new();
    let Ok(entries) = fs::read_dir(config::source_index_cache_dir()) else {
        return result;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if path.file_name().and_then(|value| value.to_str()) == Some("manifest.json") {
            continue;
        }
        let Some(fingerprint) = path
            .file_stem()
            .and_then(|value| value.to_str())
            .and_then(source_cache_fingerprint_from_stem)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
        else {
            continue;
        };
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        if value
            .get("cacheVersion")
            .and_then(|v| v.as_u64())
            .is_some_and(|version| version != collector_core::schema::USAGE_CACHE_VERSION as u64)
        {
            continue;
        }
        if let Some(items) = value.as_array() {
            result.insert(fingerprint, items.clone());
        } else if let Some(items) = value.get("items").and_then(|v| v.as_array()) {
            result.insert(fingerprint, items.clone());
        }
    }
    result
}

fn write_source_index_cache(
    source_index: &HashMap<String, Vec<serde_json::Value>>,
    snapshot: &serde_json::Value,
) -> Result<(), String> {
    config::ensure_app_dir();
    let dir = config::source_index_cache_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut keep_files = HashSet::new();
    for (fingerprint, items) in source_index {
        if fingerprint.trim().is_empty() {
            continue;
        }
        let file_name = source_cache_file_name(fingerprint);
        keep_files.insert(file_name.clone());
        let path = dir.join(&file_name);
        if path.exists() {
            continue;
        }
        let value = serde_json::json!({
            "cacheVersion": collector_core::schema::USAGE_CACHE_VERSION,
            "fingerprint": fingerprint,
            "items": items
        });
        let text = serde_json::to_string(&value).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, format!("{}\n", text)).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    }
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if file_name != "manifest.json" && !keep_files.contains(file_name) {
                let _ = fs::remove_file(path);
            }
        }
    }
    let manifest = serde_json::json!({
        "cacheVersion": collector_core::schema::USAGE_CACHE_VERSION,
        "scannedAt": snapshot.get("scannedAt").cloned().unwrap_or(serde_json::Value::Null),
        "sourceFingerprint": snapshot.get("sourceFingerprint").cloned().unwrap_or(serde_json::Value::Null),
        "usageSourceConfigFingerprint": snapshot.get("usageSourceConfigFingerprint").cloned().unwrap_or(serde_json::Value::Null),
        "sourceCount": source_index.len()
    });
    let text = serde_json::to_string(&manifest).map_err(|e| e.to_string())?;
    fs::write(dir.join("manifest.json"), format!("{}\n", text)).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(config::source_index_cache_path());
    Ok(())
}

fn source_cache_file_name(fingerprint: &str) -> String {
    format!(
        "v{}-{}.json",
        collector_core::schema::USAGE_CACHE_VERSION,
        fingerprint
    )
}

fn source_cache_fingerprint_from_stem(stem: &str) -> Option<&str> {
    let prefix = format!("v{}-", collector_core::schema::USAGE_CACHE_VERSION);
    stem.strip_prefix(&prefix)
}

async fn sync_snapshot(
    cfg: &config::AppConfig,
    snapshot: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let items = snapshot
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let started_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    match collector_core::sync::sync_usage(cfg, &items, &cfg.api_base_url).await {
        Ok(sync_result) => {
            let finished_at =
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let result = serde_json::json!({
                "accepted": sync_result.accepted,
                "rejected": sync_result.rejected,
                "bucketCount": sync_result.bucket_count,
                "uploadedBucketCount": sync_result.uploaded_bucket_count,
                "noopBucketCount": sync_result.noop_bucket_count,
                "queued": sync_result.queued,
                "queuePending": sync_result.queue_pending,
                "queueUploaded": sync_result.queue_uploaded,
                "queueAttempted": sync_result.queue_attempted,
                "queueFailed": sync_result.queue_failed,
                "newFailedBucketCount": sync_result.new_failed_bucket_count,
                "fullReconcilePending": sync_result.full_reconcile_pending,
                "scanned": items.len(),
                "rowCount": items.len(),
                "scannedAt": snapshot.get("scannedAt").cloned().unwrap_or(serde_json::Value::Null),
                "sourceFingerprint": snapshot.get("sourceFingerprint").cloned().unwrap_or(serde_json::Value::Null)
            });
            persist_sync_status(
                cfg,
                SyncOutcome::Success,
                &started_at,
                &finished_at,
                Some(&result),
                "",
            );
            Ok(result)
        }
        Err(error) => {
            let finished_at =
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            persist_sync_status(
                cfg,
                SyncOutcome::Failed,
                &started_at,
                &finished_at,
                None,
                &error,
            );
            Err(error)
        }
    }
}

fn persist_sync_status(
    cfg: &config::AppConfig,
    status: SyncOutcome,
    started_at: &str,
    finished_at: &str,
    result: Option<&serde_json::Value>,
    error: &str,
) {
    let previous = cfg.sync_status.clone();
    let last_success_at = if status == SyncOutcome::Success {
        finished_at.to_string()
    } else {
        previous.last_success_at
    };
    let last_success_source_fingerprint = if status == SyncOutcome::Success {
        result
            .and_then(|v| v.get("sourceFingerprint"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    } else {
        previous.last_success_source_fingerprint
    };
    let sync_status = serde_json::json!({
        "apiBaseUrl": cfg.api_base_url,
        "lastAttemptAt": started_at,
        "lastFinishedAt": finished_at,
        "lastSuccessAt": last_success_at,
        "lastStatus": serde_json::to_value(status).unwrap_or(serde_json::Value::String("failed".to_string())),
        "lastError": error,
        "lastSuccessSourceFingerprint": last_success_source_fingerprint,
        "lastResult": result.cloned().unwrap_or(serde_json::Value::Null)
    });
    let mut next = cfg.clone();
    next.sync_status = serde_json::from_value(sync_status).unwrap_or_default();
    next.last_sync_at = Some(finished_at.to_string());
    next.last_sync_status = Some(
        serde_json::to_value(status)
            .unwrap_or(serde_json::Value::String("failed".to_string()))
            .as_str()
            .unwrap_or("failed")
            .to_string(),
    );
    next.last_sync_api_base_url = Some(cfg.api_base_url.clone());
    next.last_sync_error = if error.is_empty() {
        None
    } else {
        Some(error.to_string())
    };
    config::save_config(&next);
}

const TRAY_PROVIDER_NAMES: &[(&str, &str)] = &[
    ("claude_code_local", "Claude Code"),
    ("codex_local", "Codex"),
    ("cursor_dashboard_usage", "Cursor"),
];

fn build_tray_menu_data_without_config() -> serde_json::Value {
    let lang = "zh-CN";
    serde_json::json!([
        tray_action("open", tray_t(lang, "tray.open", &[]), "open"),
        tray_action("refresh", tray_t(lang, "tray.refresh", &[]), "refresh"),
        tray_action("cloud", tray_t(lang, "tray.cloudLocal", &[]), "noop"),
        {"type": "separator"},
        tray_action("no-usage", tray_t(lang, "tray.noUsage", &[]), "noop"),
        {"type": "separator"},
        tray_action("quit", tray_t(lang, "tray.quit", &[]), "quit")
    ])
}

fn build_tray_menu_data(
    cfg: &config::AppConfig,
    items: &[serde_json::Value],
    scanned_at: Option<&str>,
    estimated_cost_usd: Option<f64>,
    identity: Option<&serde_json::Value>,
) -> serde_json::Value {
    let lang = if cfg.language.trim().is_empty() {
        "zh-CN"
    } else {
        cfg.language.as_str()
    };
    let today = collector_core::date::local_day();
    let mut menu = Vec::new();

    menu.push(tray_action("open", tray_t(lang, "tray.open", &[]), "open"));
    let refresh_label = scanned_at
        .and_then(format_tray_time)
        .map(|time| tray_t(lang, "tray.refreshWithTime", &[("time", time)]))
        .unwrap_or_else(|| tray_t(lang, "tray.refresh", &[]));
    menu.push(tray_action("refresh", refresh_label, "refresh"));

    if !cfg.api_base_url.trim().is_empty() {
        menu.push(serde_json::json!({
            "id": "visit-cloud",
            "label": tray_cloud_label(lang, cfg, identity),
            "action": "visit-cloud",
            "url": normalize_external_url(&cfg.api_base_url)
        }));
    } else {
        menu.push(tray_action(
            "cloud",
            tray_t(lang, "tray.cloudLocal", &[]),
            "noop",
        ));
    }
    menu.push(serde_json::json!({"type": "separator"}));

    let today_items: Vec<&serde_json::Value> = items
        .iter()
        .filter(|row| row["day"].as_str() == Some(today.as_str()))
        .collect();
    if today_items.is_empty() {
        menu.push(tray_action(
            "no-usage",
            tray_t(lang, "tray.noUsage", &[]),
            "noop",
        ));
    } else {
        let total_today: i64 = today_items
            .iter()
            .map(|row| row["totalTokens"].as_i64().unwrap_or(0))
            .sum();
        menu.push(tray_action(
            "tokens-today",
            tray_t(
                lang,
                "tray.tokensToday",
                &[("count", format_token_count(total_today, lang))],
            ),
            "noop",
        ));

        if let Some(total_cost) = estimated_cost_usd.filter(|cost| *cost > 0.0) {
            menu.push(tray_action(
                "cost",
                tray_t(lang, "tray.cost", &[("cost", format_cost_usd(total_cost))]),
                "noop",
            ));
        }

        menu.push(serde_json::json!({"type": "separator"}));
        let top_models = top_token_groups(&today_items, "model", 3);
        if !top_models.is_empty() {
            menu.push(tray_disabled(
                "models-title",
                tray_t(lang, "tray.modelsTitle", &[]),
            ));
            for (idx, (model, tokens)) in top_models.into_iter().enumerate() {
                menu.push(tray_action(
                    &format!("model-{}", idx),
                    format!(
                        "  {}  {}",
                        short_model_name(&model),
                        format_token_count(tokens, lang)
                    ),
                    "noop",
                ));
            }
        }

        let providers = top_token_groups(&today_items, "providerId", usize::MAX);
        if !providers.is_empty() {
            menu.push(tray_disabled(
                "providers-title",
                tray_t(lang, "tray.providersTitle", &[]),
            ));
            for (idx, (provider, tokens)) in providers.into_iter().enumerate() {
                menu.push(tray_action(
                    &format!("provider-{}", idx),
                    format!(
                        "  {}  {}",
                        provider_display_name(&provider),
                        format_token_count(tokens, lang)
                    ),
                    "noop",
                ));
            }
        }
    }

    menu.push(serde_json::json!({"type": "separator"}));
    menu.push(tray_action("quit", tray_t(lang, "tray.quit", &[]), "quit"));
    serde_json::Value::Array(menu)
}

fn tray_action(id: &str, label: String, action: &str) -> serde_json::Value {
    serde_json::json!({ "id": id, "label": label, "action": action })
}

fn tray_disabled(id: &str, label: String) -> serde_json::Value {
    serde_json::json!({ "id": id, "label": label, "disabled": true, "action": "noop" })
}

fn tray_t(lang: &str, key: &str, params: &[(&str, String)]) -> String {
    let text = match (lang, key) {
        ("en", "tray.open") => "Open Main Page",
        ("en", "tray.refresh") => "Refresh Now",
        ("en", "tray.quit") => "Quit",
        ("en", "tray.tokensToday") => "📊 Today: {count} tokens",
        ("en", "tray.cost") => "💰 Est. cost: {cost}",
        ("en", "tray.noUsage") => "No local usage",
        ("en", "tray.refreshWithTime") => "Refresh Now ({time})",
        ("en", "tray.user") => "👤 {name}",
        ("en", "tray.anonymousUser") => "{name}",
        ("en", "tray.visitCloud") => "Visit Cloud ({name})",
        ("en", "tray.visitCloudNoName") => "Visit Cloud",
        ("en", "tray.cloudLocal") => "Local only",
        ("en", "tray.modelsTitle") => "Models",
        ("en", "tray.providersTitle") => "Sources",
        (_, "tray.open") => "打开主页面",
        (_, "tray.refresh") => "立即刷新",
        (_, "tray.quit") => "退出",
        (_, "tray.tokensToday") => "📊 今日令牌: {count}",
        (_, "tray.cost") => "💰 预估费用: {cost}",
        (_, "tray.noUsage") => "暂无本地用量",
        (_, "tray.refreshWithTime") => "立即刷新 ({time})",
        (_, "tray.user") => "👤 {name}",
        (_, "tray.anonymousUser") => "{name}",
        (_, "tray.visitCloud") => "访问云端 ({name})",
        (_, "tray.visitCloudNoName") => "访问云端",
        (_, "tray.cloudLocal") => "仅本地",
        (_, "tray.modelsTitle") => "模型消耗",
        (_, "tray.providersTitle") => "来源",
        _ => key,
    };
    params.iter().fold(text.to_string(), |acc, (key, value)| {
        acc.replace(&format!("{{{}}}", key), value)
    })
}

fn tray_cloud_label(
    lang: &str,
    cfg: &config::AppConfig,
    identity: Option<&serde_json::Value>,
) -> String {
    if let Some(identity) = identity {
        if identity["identityMode"].as_str() == Some("anonymous") {
            if let Some(display_name) = identity["displayName"]
                .as_str()
                .filter(|v| !v.trim().is_empty())
            {
                let name = tray_t(
                    lang,
                    "tray.anonymousUser",
                    &[("name", display_name.to_string())],
                );
                return tray_t(lang, "tray.visitCloud", &[("name", name)]);
            }
        }
    }
    if !cfg.nickname.trim().is_empty() {
        let name = tray_t(lang, "tray.user", &[("name", cfg.nickname.clone())]);
        return tray_t(lang, "tray.visitCloud", &[("name", name)]);
    }
    tray_t(lang, "tray.visitCloudNoName", &[])
}

fn format_tray_time(value: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.with_timezone(&chrono::Local).format("%H:%M").to_string())
}

fn normalize_external_url(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{}", trimmed)
    }
}

fn format_token_count(count: i64, lang: &str) -> String {
    let abs = count.abs();
    if lang.starts_with("zh") {
        if abs >= 100_000_000 {
            let digits = if abs >= 1_000_000_000 { 1 } else { 2 };
            return format!("{:.*}亿", digits, count as f64 / 100_000_000.0);
        }
        if abs >= 10_000 {
            let digits = if abs >= 10_000_000 { 0 } else { 1 };
            return format!("{}万", trim_fixed(count as f64 / 10_000.0, digits));
        }
        return format_integer(count);
    }
    if abs >= 1_000_000_000 {
        return format!("{}B", trim_fixed(count as f64 / 1_000_000_000.0, 1));
    }
    if abs >= 1_000_000 {
        return format!("{}M", trim_fixed(count as f64 / 1_000_000.0, 1));
    }
    if abs >= 1_000 {
        return format!("{}K", trim_fixed(count as f64 / 1_000.0, 1));
    }
    format_integer(count)
}

fn format_integer(value: i64) -> String {
    let raw = value.abs().to_string();
    let mut out = String::new();
    for (idx, ch) in raw.chars().rev().enumerate() {
        if idx > 0 && idx % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    let mut formatted: String = out.chars().rev().collect();
    if value < 0 {
        formatted.insert(0, '-');
    }
    formatted
}

fn trim_fixed(value: f64, digits: usize) -> String {
    let mut text = format!("{:.*}", digits, value);
    if text.contains('.') {
        while text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.pop();
        }
    }
    text
}

fn format_cost_usd(cost: f64) -> String {
    if cost > 0.0 && cost < 0.01 {
        return "<$0.01".to_string();
    }
    format!("${:.2}", cost)
}

fn top_token_groups(items: &[&serde_json::Value], field: &str, limit: usize) -> Vec<(String, i64)> {
    let mut totals: HashMap<String, i64> = HashMap::new();
    for item in items {
        let key = item[field].as_str().unwrap_or("unknown").to_string();
        *totals.entry(key).or_insert(0) += item["totalTokens"].as_i64().unwrap_or(0);
    }
    let mut groups: Vec<(String, i64)> = totals.into_iter().collect();
    groups.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    groups.truncate(limit);
    groups
}

fn short_model_name(model: &str) -> String {
    model.rsplit('/').next().unwrap_or(model).to_string()
}

fn provider_display_name(provider: &str) -> String {
    TRAY_PROVIDER_NAMES
        .iter()
        .find(|(id, _)| *id == provider)
        .map(|(_, name)| (*name).to_string())
        .unwrap_or_else(|| provider.to_string())
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
            let body: serde_json::Value =
                resp.json().await.unwrap_or_else(|_| serde_json::json!({}));
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
    let platform = version::client_metadata()["clientPlatform"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let installer = release_config
        .pointer(&format!("/release/installers/{}", platform))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let Some(url) = installer.get("url").and_then(|v| v.as_str()) else {
        return Ok(
            serde_json::json!({"ok": false, "error": format!("no installer available for {}", platform)}),
        );
    };
    let file_name = installer
        .get("fileName")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .unwrap_or_else(|| {
            url.rsplit('/')
                .next()
                .unwrap_or("ai-token-league-installer")
                .to_string()
        });
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
    if let Some(expected) = installer
        .get("sha256")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty() && *v != "placeholder")
    {
        let actual = collector_core::crypto::sha256_bytes_hex(&bytes);
        if actual != expected {
            let _ = fs::remove_file(&file_path);
            return Ok(
                serde_json::json!({"ok": false, "error": format!("checksum mismatch: expected {}, got {}", expected, actual)}),
            );
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

fn usage_source_config_fingerprint(cfg: &config::AppConfig) -> String {
    let cursor_accounts = cfg
        .cursor_dashboard_usage
        .accounts
        .iter()
        .map(|account| {
            serde_json::json!({
                "authId": account.auth_id,
                "sub": account.sub,
                "emailHash": collector_core::crypto::sha256_hex(&account.email),
                "accountHash": account.account_hash,
                "authStatus": account.auth_status,
                "ignored": account.ignored
            })
        })
        .collect::<Vec<_>>();
    let cursor_tokens = cfg
        .cursor_dashboard_usage
        .workos_session_tokens
        .iter()
        .map(|token| {
            serde_json::json!({
                "tokenHash": collector_core::crypto::sha256_hex(&token.token),
                "accountNameHash": collector_core::crypto::sha256_hex(&token.account_name)
            })
        })
        .collect::<Vec<_>>();
    let source_config = serde_json::json!({
        "providerEnabled": sorted_bool_map(&cfg.provider_enabled),
        "providerRoots": sorted_vec_map(&cfg.provider_roots),
        "providerIgnoredAutoSources": sorted_vec_map(&cfg.provider_ignored_auto_sources),
        "cursorDashboardUsage": {
            "legacyTokenHash": collector_core::crypto::sha256_hex(&cfg.cursor_dashboard_usage.workos_session_token),
            "tokens": cursor_tokens,
            "accounts": cursor_accounts
        }
    });
    collector_core::crypto::sha256_hex(&source_config.to_string())
}

fn sorted_bool_map(input: &HashMap<String, bool>) -> BTreeMap<String, bool> {
    input
        .iter()
        .map(|(key, value)| (key.clone(), *value))
        .collect()
}

fn sorted_vec_map(input: &HashMap<String, Vec<String>>) -> BTreeMap<String, Vec<String>> {
    input
        .iter()
        .map(|(key, value)| {
            let mut values = value.clone();
            values.sort();
            (key.clone(), values)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use collector_core::scanner::SourceCache;
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn test_config() -> config::AppConfig {
        config::AppConfig {
            participant_id: "p_test".to_string(),
            nickname: "sky".to_string(),
            nickname_auto_generated: false,
            identity_public_key: "pk".to_string(),
            identity_private_key: "sk".to_string(),
            device_id: "d_test".to_string(),
            api_base_url: "league.example.com".to_string(),
            language: "zh-CN".to_string(),
            show_estimated_cost: true,
            show_raw_tokens: false,
            auto_refresh_enabled: true,
            silent_update_mode: "auto_download".to_string(),
            refresh_interval_minutes: 15,
            launch_at_login: false,
            hide_dock_icon: false,
            desktop_auto_initialized: true,
            cursor_dashboard_usage: config::CursorDashboardUsageConfig::default(),
            local_backup: config::LocalBackupConfig::default(),
            runtime_log_retention_days: 3,
            api_connection: serde_json::json!({}),
            sync_status: config::SyncStatusRecord::default(),
            workdir_aliases: HashMap::new(),
            provider_roots: HashMap::new(),
            provider_enabled: HashMap::new(),
            provider_ignored_auto_sources: HashMap::new(),
            created_at: None,
            updated_at: None,
            imported_at: None,
            last_sync_at: None,
            last_sync_status: None,
            last_sync_api_base_url: None,
            last_sync_error: None,
        }
    }

    fn temp_home() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("atl-sidecar-test-{}", suffix))
    }

    #[test]
    fn tray_menu_matches_develop_contract_shape() {
        let cfg = test_config();
        let today = collector_core::date::local_day();
        let items = vec![
            serde_json::json!({
                "day": today,
                "providerId": "codex_local",
                "model": "openai/gpt-5",
                "inputTokens": 1000,
                "outputTokens": 500,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0,
                "reasoningTokens": 0,
                "totalTokens": 1500
            }),
            serde_json::json!({
                "day": collector_core::date::add_days(&collector_core::date::local_day(), -1).unwrap(),
                "providerId": "claude_code_local",
                "model": "claude-sonnet",
                "totalTokens": 9999
            }),
            serde_json::json!({
                "day": collector_core::date::local_day(),
                "providerId": "claude_code_local",
                "model": "anthropic/claude-sonnet",
                "inputTokens": 200,
                "outputTokens": 300,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0,
                "reasoningTokens": 0,
                "totalTokens": 500
            }),
        ];
        let menu = build_tray_menu_data(
            &cfg,
            &items,
            Some("2026-05-16T10:30:00.000Z"),
            Some(0.003),
            Some(&serde_json::json!({"identityMode": "anonymous", "displayName": "anon"})),
        );
        let labels = menu
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["label"].as_str())
            .collect::<Vec<_>>();

        assert_eq!(labels[0], "打开主页面");
        assert!(labels[1].starts_with("立即刷新 ("));
        assert_eq!(labels[2], "访问云端 (anon)");
        assert!(labels.iter().any(|label| *label == "📊 今日令牌: 2,000"));
        assert!(labels
            .iter()
            .any(|label| label.starts_with("💰 预估费用: ")));
        assert!(labels.iter().any(|label| *label == "模型消耗"));
        assert!(labels.iter().any(|label| *label == "  gpt-5  1,500"));
        assert!(labels.iter().any(|label| *label == "来源"));
        assert!(labels.iter().any(|label| *label == "  Codex  1,500"));
        assert_eq!(labels.last().copied(), Some("退出"));
        assert_eq!(
            menu.as_array().unwrap()[2]["url"],
            "http://league.example.com"
        );
    }

    #[test]
    fn usage_cache_freshness_uses_five_minute_ttl() {
        let cfg = test_config();
        let fingerprint = usage_source_config_fingerprint(&cfg);
        let fresh = serde_json::json!({
            "cacheVersion": collector_core::schema::USAGE_CACHE_VERSION,
            "scannedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "usageSourceConfigFingerprint": fingerprint
        });
        let stale = serde_json::json!({
            "cacheVersion": collector_core::schema::USAGE_CACHE_VERSION,
            "scannedAt": (chrono::Utc::now() - chrono::Duration::minutes(10))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "usageSourceConfigFingerprint": fingerprint
        });

        assert!(is_fresh_usage_cache(&fresh, &cfg));
        assert!(!is_fresh_usage_cache(&stale, &cfg));
    }

    #[test]
    fn usage_cache_freshness_rejects_changed_source_config() {
        let cfg = test_config();
        let mut changed = cfg.clone();
        changed.provider_roots.insert(
            "claude_code_local".to_string(),
            vec!["/tmp/other-claude-root".to_string()],
        );
        let snapshot = serde_json::json!({
            "cacheVersion": collector_core::schema::USAGE_CACHE_VERSION,
            "scannedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "usageSourceConfigFingerprint": usage_source_config_fingerprint(&cfg)
        });

        assert!(is_fresh_usage_cache(&snapshot, &cfg));
        assert!(!is_fresh_usage_cache(&snapshot, &changed));
    }

    #[test]
    fn tray_token_count_uses_locale_suffixes() {
        assert_eq!(format_token_count(38_790_000, "zh-CN"), "3879万");
        assert_eq!(format_token_count(12_345, "zh-CN"), "1.2万");
        assert_eq!(format_token_count(120_000_000, "zh-CN"), "1.20亿");
        assert_eq!(format_token_count(1_200_000_000, "zh-CN"), "12.0亿");
        assert_eq!(format_token_count(38_790_000, "en"), "38.8M");
        assert_eq!(format_token_count(1_200_000_000, "en"), "1.2B");
    }

    #[test]
    fn source_cache_restores_direct_and_wrapped_source_index() {
        let direct = serde_json::json!({
            "sourceIndex": {
                "fingerprint-a": [{"day": "2026-05-16", "totalTokens": 1}]
            }
        });
        let wrapped = serde_json::json!({
            "sourceIndex": {
                "sources": {
                    "fingerprint-b": {"items": [{"day": "2026-05-16", "totalTokens": 2}]}
                }
            }
        });
        let source_index_cache = serde_json::json!({
            "sources": {
                "fingerprint-c": [{"day": "2026-05-16", "totalTokens": 3}]
            }
        });

        assert_eq!(
            source_cache_from_snapshot(Some(&direct))["fingerprint-a"].len(),
            1
        );
        assert_eq!(
            source_cache_from_snapshot(Some(&wrapped))["fingerprint-b"].len(),
            1
        );
        assert_eq!(
            source_cache_from_snapshot(Some(&source_index_cache))["fingerprint-c"].len(),
            1
        );
    }

    #[tokio::test]
    async fn workdir_alias_clears_cached_usage_sources() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let previous_home = std::env::var("HOME").ok();
        let home = temp_home();
        std::env::set_var("HOME", &home);

        config::init_config(serde_json::json!({}), true);
        fs::write(config::usage_cache_path(), "{}\n").unwrap();
        let mut store = collector_core::local_usage_store::LocalUsageStore::open_default().unwrap();
        store
            .replace_source_cache(
                &HashMap::from([(
                    "source-fingerprint".to_string(),
                    vec![serde_json::json!({
                        "day": "2026-05-25",
                        "workdirHash": "workdir-hash",
                        "workdirDisplayName": "old-name"
                    })],
                )]),
                "now",
            )
            .unwrap();
        assert!(store.take_cached_source("source-fingerprint").is_some());
        drop(store);

        let request = SidecarRequest {
            id: "test".to_string(),
            command: "workdirs:set-alias".to_string(),
            args: serde_json::json!({
                "workdirHash": "workdir-hash",
                "alias": "new-name"
            }),
        };
        let mut runtime = SidecarRuntime::default();
        let result = handle_command(request, &mut runtime).await.unwrap();

        assert_eq!(result["workdirAliases"]["workdir-hash"], "new-name");
        assert!(!config::usage_cache_path().exists());
        let mut store = collector_core::local_usage_store::LocalUsageStore::open_default().unwrap();
        assert!(store.take_cached_source("source-fingerprint").is_none());

        let _ = fs::remove_dir_all(&home);
        if let Some(v) = previous_home {
            std::env::set_var("HOME", v);
        } else {
            std::env::remove_var("HOME");
        }
    }

    #[tokio::test]
    async fn config_import_apply_returns_sanitized_join_summary() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let previous_home = std::env::var("HOME").ok();
        let home = temp_home();
        std::env::set_var("HOME", &home);

        config::init_config(serde_json::json!({}), true);
        fs::write(config::queue_path(), "[]\n").unwrap();
        fs::write(config::usage_cache_path(), "{}\n").unwrap();
        fs::write(config::manifest_path(), "{}\n").unwrap();

        let request = SidecarRequest {
            id: "test".to_string(),
            command: "config:import:apply".to_string(),
            args: serde_json::json!({
                "__importMode": "join_existing_participant",
                "participantId": "p-imported",
                "nickname": "imported",
                "identityPublicKey": "pub-imported",
                "identityPrivateKey": "priv-imported",
                "deviceId": "d-imported",
                "cursorDashboardUsage": {
                    "accounts": [{
                        "accessToken": "secret-at",
                        "refreshToken": "secret-rt",
                        "authId": "auth1"
                    }]
                }
            }),
        };
        let mut runtime = SidecarRuntime::default();
        let result = handle_command(request, &mut runtime).await.unwrap();
        let content = serde_json::to_string(&result).unwrap();

        assert_eq!(result["participantId"].as_str(), Some("p-imported"));
        assert_eq!(
            result["importResult"]["mode"].as_str(),
            Some("join_existing_participant")
        );
        assert_eq!(
            result["importResult"]["newDeviceId"].as_str(),
            result["deviceId"].as_str()
        );
        assert!(!content.contains("identityPrivateKey"));
        assert!(!content.contains("priv-imported"));
        assert!(!content.contains("secret-at"));
        assert!(!content.contains("secret-rt"));
        assert!(!config::queue_path().exists());
        assert!(!config::usage_cache_path().exists());
        assert!(!config::manifest_path().exists());

        let _ = fs::remove_dir_all(&home);
        if let Some(v) = previous_home {
            std::env::set_var("HOME", v);
        } else {
            std::env::remove_var("HOME");
        }
    }
}
