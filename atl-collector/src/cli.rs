use std::collections::{BTreeMap, HashMap};

use collector_core::config::{self, AppConfig};
use collector_core::local_usage_store::{LocalUsageStore, UsageFilters};
use collector_core::scanner;
use serde_json::{json, Value};

use crate::board;
use crate::pricing;

/// Typed CLI errors with stable exit codes for scripts:
/// 1 generic, 10 not initialized, 11 empty local data, 12 network/server.
/// (2 stays clap's argument-error code.)
pub enum CliError {
    Message(String),
    NotInitialized,
    EmptyData,
    Network(String),
}

impl CliError {
    pub fn exit_code(&self) -> i32 {
        match self {
            CliError::Message(_) => 1,
            CliError::NotInitialized => 10,
            CliError::EmptyData => 11,
            CliError::Network(_) => 12,
        }
    }

    pub fn message(&self) -> String {
        match self {
            CliError::Message(text) | CliError::Network(text) => text.clone(),
            CliError::NotInitialized => {
                "Not initialized. Run 'atl-collector init' first.".to_string()
            }
            CliError::EmptyData => {
                "Local usage database is empty. Run 'atl-collector scan' first, or launch the \
                 desktop app once, then retry."
                    .to_string()
            }
        }
    }
}

impl From<String> for CliError {
    fn from(value: String) -> Self {
        CliError::Message(value)
    }
}

impl From<&str> for CliError {
    fn from(value: &str) -> Self {
        CliError::Message(value.to_string())
    }
}

const STRING_KEYS: &[&str] = &[
    "nickname",
    "apiBaseUrl",
    "language",
    "theme",
    "shareCardOrientation",
];

const BOOL_KEYS: &[&str] = &[
    "showEstimatedCost",
    "launchAtLogin",
    "hideDockIcon",
    "desktopAutoInitialized",
    "autoRefreshEnabled",
    "showShareCloudUrl",
    "showSharePolaroidFrame",
    "showShareAnonymousName",
];

const NUMBER_KEYS: &[&str] = &["refreshIntervalMinutes", "runtimeLogRetentionDays"];

pub async fn run(cmd: crate::Commands) -> Result<(), CliError> {
    match cmd {
        crate::Commands::Init { nickname, api } => {
            let input = serde_json::json!({
                "nickname": nickname.unwrap_or_else(|| "anonymous".to_string()),
                "apiBaseUrl": api.unwrap_or_default()
            });
            let cfg = config::init_config(input, true);
            println!("Initialized: {} ({})", cfg.nickname, cfg.participant_id);
        }
        crate::Commands::Health => {
            let cfg = config::load_config();
            match cfg {
                Some(c) => {
                    println!(
                        "OK  participant={} device={}",
                        c.participant_id, c.device_id
                    );
                }
                None => {
                    println!("NOT INITIALIZED  run 'atl-collector init' first");
                }
            }
        }
        crate::Commands::Status { json } => cmd_status(json)?,
        crate::Commands::Scan { full, json } => cmd_scan(full, json).await?,
        crate::Commands::Sync {
            full_resync,
            json,
        } => cmd_sync(full_resync, json).await?,
        crate::Commands::Usage {
            range,
            view,
            grain,
            limit,
            offset,
            provider,
            model,
            workdir,
            cost,
            json,
        } => {
            let filters = UsageFilters {
                provider,
                model,
                workdir,
            };
            cmd_usage(&range, &view, &grain, limit, offset, &filters, cost, json).await?
        }
        crate::Commands::Top {
            range,
            limit,
            json,
        } => {
            let cfg = require_config()?;
            board::board_query(&range).map_err(CliError::Message)?;
            board::cmd_top(&cfg, &range, limit, json)
                .await
                .map_err(CliError::Network)?
        }
        crate::Commands::Rank { range, json } => {
            let cfg = require_config()?;
            board::board_query(&range).map_err(CliError::Message)?;
            board::cmd_rank(&cfg, &range, json)
                .await
                .map_err(CliError::Network)?
        }
        crate::Commands::Config { action } => cmd_config(action)?,
        crate::Commands::Roots { action } => cmd_roots(action)?,
        crate::Commands::Register => {
            let cfg = config::load_config().ok_or("Not initialized")?;
            if cfg.api_base_url.is_empty() {
                return Err("API base URL not configured".into());
            }
            let client = reqwest::Client::new();
            collector_core::sync::register_device(&client, &cfg, &cfg.api_base_url).await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "registered": true,
                    "participantId": cfg.participant_id,
                    "deviceId": cfg.device_id
                }))
                .unwrap()
            );
        }
        crate::Commands::Reconcile { full } => {
            let cfg = config::load_config().ok_or("Not initialized")?;
            if cfg.api_base_url.is_empty() {
                return Err("API base URL not configured".into());
            }
            if !full {
                return Err("reconcile requires --full".into());
            }
            collector_core::reconcile::mark_full_reconcile_pending(
                &cfg.api_base_url,
                collector_core::reconcile::FullReconcileTrigger::ApiBaseUrlChanged,
            );
            let cache = HashMap::new();
            let result = scanner::scan_usage_async(&cfg, cache).await;
            if !result.provider_errors.is_empty() {
                return Err(format!(
                    "scan incomplete; refusing reconcile: {:?}",
                    result.provider_errors
                )
                .into());
            }
            let options = collector_core::reconcile::FullReconcileOptions {
                resume: true,
                ..Default::default()
            };
            let reconcile_result = collector_core::reconcile::full_reconcile_usage(
                &cfg,
                &result.items,
                &cfg.api_base_url,
                options,
            )
            .await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "status": serde_json::to_value(&reconcile_result.status).unwrap(),
                    "checked": reconcile_result.checked_bucket_count,
                    "matched": reconcile_result.matched_bucket_count,
                    "missing": reconcile_result.missing_bucket_count,
                    "different": reconcile_result.different_bucket_count,
                    "repaired": reconcile_result.repair_uploaded_bucket_count,
                    "queued": reconcile_result.queued_bucket_count,
                    "serverOnlyScopes": reconcile_result.server_only_scope_count,
                    "prunedScopes": reconcile_result.pruned_scope_count,
                    "rebuiltDailyScopes": reconcile_result.rebuilt_daily_scope_count,
                    "conflictedScopes": reconcile_result.conflicted_scope_count
                }))
                .unwrap()
            );
        }
        crate::Commands::ExportIdentity => {
            let cfg = config::load_config().ok_or("Not initialized")?;
            let identity = config::export_identity(&cfg);
            println!("{}", serde_json::to_string_pretty(&identity).unwrap());
        }
        crate::Commands::ImportIdentity { file } => {
            let content = std::fs::read_to_string(&file)
                .map_err(|e| format!("Cannot read {}: {}", file, e))?;
            let identity: serde_json::Value =
                serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?;
            let cfg = config::load_config().ok_or("Not initialized")?;
            let _ = config::import_identity(identity, &cfg, true);
            println!("Identity imported");
        }
    }
    Ok(())
}

fn require_config() -> Result<AppConfig, CliError> {
    config::load_config().ok_or(CliError::NotInitialized)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Scan local sources with the persistent local database as the incremental
/// source cache (same production path as the desktop sidecar), then persist
/// results back into the database. A scan with provider errors is refused so
/// a failing provider never wipes its own history.
async fn scan_and_persist(cfg: &AppConfig, full: bool) -> Result<(scanner::ScanResult, bool), String> {
    let mut store = LocalUsageStore::open_default().ok();
    if full {
        if let Some(store) = store.as_mut() {
            store.clear_source_cache()?;
        }
    }
    let result = if let Some(store) = store.as_mut() {
        scanner::scan_usage_async_with_source_cache(cfg, store).await
    } else {
        scanner::scan_usage_async(cfg, HashMap::new()).await
    };
    if !result.provider_errors.is_empty() {
        let mut detail: Vec<String> = result
            .provider_errors
            .iter()
            .map(|(id, err)| format!("{}: {}", id, err))
            .collect();
        detail.sort();
        return Err(format!(
            "scan incomplete; local database not updated. Retry, or disable the failing provider with\n  \
             atl-collector config set providerEnabled.<providerId> false\nFailing providers:\n  {}",
            detail.join("\n  ")
        ));
    }
    let mut persisted = false;
    if let Some(store) = store.as_mut() {
        let scanned_at = now_iso();
        store.replace_source_cache(&result.source_index, &scanned_at)?;
        store.replace_usage_facts(&result.items, &scanned_at)?;
        persisted = true;
    }
    Ok((result, persisted))
}

fn provider_totals(items: &[Value]) -> Vec<Value> {
    let mut totals: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    for item in items {
        let id = item["providerId"].as_str().unwrap_or("unknown").to_string();
        let entry = totals.entry(id).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += item["totalTokens"].as_i64().unwrap_or(0);
    }
    let mut rows: Vec<Value> = totals
        .into_iter()
        .map(|(id, (count, tokens))| {
            json!({ "providerId": id, "items": count, "totalTokens": tokens })
        })
        .collect();
    rows.sort_by_key(|row| -row["totalTokens"].as_i64().unwrap_or(0));
    rows
}

async fn cmd_scan(full: bool, json_out: bool) -> Result<(), CliError> {
    let cfg = require_config()?;
    let started = std::time::Instant::now();
    let (result, persisted) = scan_and_persist(&cfg, full).await?;
    let duration = started.elapsed().as_secs_f64();
    let totals = provider_totals(&result.items);
    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "scannedItems": result.items.len(),
                "scannedAt": now_iso(),
                "persisted": persisted,
                "durationSec": (duration * 10.0).round() / 10.0,
                "providers": totals,
            }))
            .map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    if persisted {
        println!(
            "Scan complete: {} items saved to local database ({:.1}s)",
            result.items.len(),
            duration
        );
    } else {
        println!(
            "Scan complete: {} items (warning: local database unavailable, results not saved) ({:.1}s)",
            result.items.len(),
            duration
        );
    }
    for row in &totals {
        let count = row["items"].as_i64().unwrap_or(0);
        println!(
            "  {:<28} {:>12}  ({} {})",
            row["providerId"].as_str().unwrap_or("?"),
            format_tokens_compact(row["totalTokens"].as_i64().unwrap_or(0)),
            format_int(count),
            rows_label(count)
        );
    }
    Ok(())
}

async fn cmd_sync(full_resync: bool, json_out: bool) -> Result<(), CliError> {
    let cfg = require_config()?;
    if cfg.api_base_url.is_empty() {
        return Err("API base URL not configured. Set it with:\n  atl-collector config set apiBaseUrl <url>".into());
    }
    if full_resync {
        config::clear_sync_manifest();
    }
    let started = std::time::Instant::now();
    eprintln!("Scanning local sources ...");
    let (result, _) = scan_and_persist(&cfg, false).await?;
    eprintln!("Uploading to {} ...", cfg.api_base_url);
    let sync_result =
        collector_core::sync::sync_usage(&cfg, &result.items, &cfg.api_base_url).await?;
    let duration = started.elapsed().as_secs_f64();
    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "scannedItems": result.items.len(),
                "accepted": sync_result.accepted,
                "rejected": sync_result.rejected,
                "noopBucketCount": sync_result.noop_bucket_count,
                "queued": sync_result.queued,
                "durationSec": (duration * 10.0).round() / 10.0,
            }))
            .map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    println!(
        "Synced {} items: accepted={}, rejected={}, noop={}, queued={} ({:.1}s)",
        result.items.len(),
        sync_result.accepted,
        sync_result.rejected,
        sync_result.noop_bucket_count,
        sync_result.queued,
        duration
    );
    Ok(())
}

fn build_status_value(cfg: &AppConfig) -> Value {
    let store = LocalUsageStore::open_readonly_default().ok();
    let has_data = store
        .as_ref()
        .map(|s| s.has_usage_facts().unwrap_or(false))
        .unwrap_or(false);
    let totals = if has_data {
        store
            .as_ref()
            .and_then(|s| s.summary("all", &UsageFilters::default()).ok())
            .map(|v| v["totals"].clone())
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    json!({
        "participantId": cfg.participant_id,
        "deviceId": cfg.device_id,
        "nickname": cfg.nickname,
        "apiBaseUrl": cfg.api_base_url,
        "language": cfg.language,
        "theme": cfg.theme,
        "sync": serde_json::to_value(&cfg.sync_status).unwrap_or(Value::Null),
        "localData": {
            "hasData": has_data,
            "rows": totals["rows"].as_i64().unwrap_or(0),
            "totalTokens": totals["totalTokens"].as_i64().unwrap_or(0),
        },
    })
}

fn cmd_status(json_out: bool) -> Result<(), CliError> {
    let cfg = require_config()?;
    let value = build_status_value(&cfg);
    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    let sync = &value["sync"];
    let last_status = sync["lastStatus"]
        .as_str()
        .unwrap_or("never")
        .to_string();
    let last_success = sync["lastSuccessAt"].as_str().unwrap_or("-");
    println!("{:<16}{}", "participantId", cfg.participant_id);
    println!("{:<16}{}", "deviceId", cfg.device_id);
    println!("{:<16}{}", "nickname", cfg.nickname);
    println!(
        "{:<16}{}",
        "apiBaseUrl",
        if cfg.api_base_url.is_empty() {
            "(not set)"
        } else {
            cfg.api_base_url.as_str()
        }
    );
    println!(
        "{:<16}{} / {}",
        "language/theme",
        if cfg.language.is_empty() {
            "(default)"
        } else {
            cfg.language.as_str()
        },
        cfg.theme
    );
    if last_status == "never" {
        println!("{:<16}never", "lastSync");
    } else {
        println!("{:<16}{} at {}", "lastSync", last_status, last_success);
    }
    let last_error = sync["lastError"].as_str().unwrap_or("");
    if !last_error.is_empty() {
        println!("{:<16}{}", "lastSyncError", last_error);
    }
    let local = &value["localData"];
    if local["hasData"].as_bool().unwrap_or(false) {
        println!(
            "{:<16}{} rows, {} tokens (all time)",
            "localData",
            format_int(local["rows"].as_i64().unwrap_or(0)),
            format_tokens_compact(local["totalTokens"].as_i64().unwrap_or(0))
        );
    } else {
        println!("{:<16}empty. Run 'atl-collector scan' first.", "localData");
    }
    Ok(())
}

fn open_usage_store() -> Result<LocalUsageStore, CliError> {
    let store = LocalUsageStore::open_readonly_default().map_err(|_| CliError::EmptyData)?;
    if !store.has_usage_facts()? {
        return Err(CliError::EmptyData);
    }
    Ok(store)
}

fn valid_day(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        match index {
            4 | 7 => {
                if *byte != b'-' {
                    return false;
                }
            }
            _ => {
                if !byte.is_ascii_digit() {
                    return false;
                }
            }
        }
    }
    let month: u32 = value[5..7].parse().unwrap_or(0);
    let day: u32 = value[8..10].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

fn validate_range(range: &str) -> Result<(), String> {
    if matches!(range, "today" | "7d" | "last7" | "30d" | "last30" | "all" | "") {
        return Ok(());
    }
    if let Some((from, to)) = range.split_once("..") {
        if (from.is_empty() || valid_day(from)) && (to.is_empty() || valid_day(to)) {
            return Ok(());
        }
    }
    Err(format!(
        "Invalid range '{}'. Use today, 7d, 30d, all, or YYYY-MM-DD..YYYY-MM-DD.",
        range
    ))
}

async fn cmd_usage(
    range: &str,
    view: &str,
    grain: &str,
    limit: usize,
    offset: usize,
    filters: &UsageFilters,
    cost: bool,
    json_out: bool,
) -> Result<(), CliError> {
    validate_range(range)?;
    if !matches!(grain, "day" | "week" | "month" | "hour") {
        return Err(format!(
            "Unknown grain '{}'. Use day, week, month, or hour.",
            grain
        )
        .into());
    }
    if cost && view != "summary" {
        return Err(
            "--cost is only supported with --view summary (per-model prices need the model breakdown)"
                .into(),
        );
    }
    let store = open_usage_store()?;
    let limit = (limit as i64).clamp(1, 500);
    let offset = (offset as i64).max(0);
    let mut value = match view {
        "summary" => store.summary(range, filters)?,
        "trend" => store.trend(range, grain, filters)?,
        "workdirs" => store.workdirs(range, limit, filters)?,
        "detail" => store.detail_window(range, offset, limit, filters)?,
        other => {
            return Err(format!(
                "Unknown view '{}'. Use summary, trend, workdirs, or detail.",
                other
            )
            .into())
        }
    };
    if !filters.is_empty() {
        value["filters"] = json!({
            "provider": filters.provider,
            "model": filters.model,
            "workdir": filters.workdir,
        });
    }
    if cost {
        apply_cost(&mut value, range, filters, &store).await?;
    }
    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    let rendered = match view {
        "summary" => render_summary(&value),
        "trend" => render_trend(&value),
        "workdirs" => render_workdirs(&value),
        _ => render_detail(&value),
    };
    print!("{}{}", filter_line(&value), rendered);
    Ok(())
}

/// Fetch server model prices and attach a cost estimate to a summary value:
/// per-model costs land on the models rows (costUsd) and an aggregate block
/// lands on value["cost"].
async fn apply_cost(
    value: &mut Value,
    range: &str,
    filters: &UsageFilters,
    store: &LocalUsageStore,
) -> Result<(), CliError> {
    let cfg = require_config()?;
    if cfg.api_base_url.is_empty() {
        return Err("API base URL not configured. Cost estimation needs server model prices. \
                    Set it with:\n  atl-collector config set apiBaseUrl <url>"
            .into());
    }
    let payload = board::fetch_json(&cfg.api_base_url, "/api/model-prices")
        .await
        .map_err(CliError::Network)?;
    let price_map = pricing::build_price_map(&payload);
    let models = store.model_breakdown(range, filters)?;
    let mut total_usd = 0.0f64;
    let mut unpriced_tokens = 0i64;
    let mut unpriced: Vec<Value> = Vec::new();
    let mut quality = "exact_price";
    let mut cost_by_model: HashMap<String, f64> = HashMap::new();
    for row in &models {
        match pricing::estimate_model_cost(row, &price_map) {
            Some(cost) => {
                total_usd += cost.total_usd;
                if !cost.exact {
                    quality = "estimated_price";
                }
                if let Some(name) = row.get("model").and_then(Value::as_str) {
                    cost_by_model.insert(name.to_string(), cost.total_usd);
                }
            }
            None => {
                let tokens = row.get("totalTokens").and_then(Value::as_i64).unwrap_or(0);
                unpriced_tokens += tokens;
                if tokens > 0 {
                    quality = "unknown_price";
                    unpriced.push(json!({
                        "model": row.get("model").cloned().unwrap_or(Value::Null),
                        "totalTokens": tokens,
                    }));
                }
            }
        }
    }
    let round_usd = |v: f64| (v * 1_000_000.0).round() / 1_000_000.0;
    if let Some(rows) = value.get_mut("models").and_then(Value::as_array_mut) {
        for row in rows {
            if let Some(name) = row.get("name").and_then(Value::as_str) {
                if let Some(cost) = cost_by_model.get(name) {
                    row["costUsd"] = json!(round_usd(*cost));
                }
            }
        }
    }
    value["cost"] = json!({
        "estimatedCostUsd": round_usd(total_usd),
        "costQuality": quality,
        "unpricedTokens": unpriced_tokens,
        "unpricedModels": unpriced,
        "pricingSource": "server:/api/model-prices",
    });
    Ok(())
}

/// Full settings view for terminal read-back: export config (already strips
/// sync bookkeeping and Cursor tokens), restore fields the export drops, and
/// mask the identity private key.
fn settings_view(cfg: &AppConfig) -> Value {
    let mut value = config::export_config(cfg);
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "autoRefreshEnabled".to_string(),
            json!(cfg.auto_refresh_enabled),
        );
        obj.insert("silentUpdateMode".to_string(), json!(cfg.silent_update_mode));
        obj.insert(
            "identityPrivateKey".to_string(),
            json!("(hidden — use export-identity)"),
        );
    }
    value
}

fn lookup_path<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    let mut current = value;
    for part in key.split('.') {
        current = current.get(part)?;
    }
    Some(current)
}

fn scalar_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn cmd_config(action: crate::ConfigAction) -> Result<(), CliError> {
    match action {
        crate::ConfigAction::List => {
            let cfg = require_config()?;
            println!(
                "{}",
                serde_json::to_string_pretty(&settings_view(&cfg)).map_err(|e| e.to_string())?
            );
        }
        crate::ConfigAction::Get { key } => {
            let cfg = require_config()?;
            let view = settings_view(&cfg);
            let found = lookup_path(&view, &key).ok_or_else(|| {
                format!(
                    "Unknown setting '{}'. Run 'atl-collector config list' to see all keys.",
                    key
                )
            })?;
            match found {
                Value::String(s) => println!("{}", s),
                other => println!(
                    "{}",
                    serde_json::to_string_pretty(other).map_err(|e| e.to_string())?
                ),
            }
        }
        crate::ConfigAction::Set { key, value } => {
            let cfg = require_config()?;
            let patch = config_key_to_patch(&key, &value)?;
            let next = config::update_config(patch, &cfg, true);
            let view = settings_view(&next);
            let effective = lookup_path(&view, &key)
                .map(scalar_string)
                .unwrap_or_else(|| value.clone());
            println!("{} = {}", key, effective);
        }
    }
    Ok(())
}

fn parse_bool_value(value: &str) -> Result<bool, String> {
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Ok(true),
        "false" | "0" | "no" | "off" => Ok(false),
        _ => Err(format!("not a boolean: '{}'", value)),
    }
}

fn parse_number_value(key: &str, value: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| format!("Expected a non-negative integer for '{}', got '{}'", key, value))
}

fn config_key_to_patch(key: &str, value: &str) -> Result<Value, String> {
    if let Some(provider_id) = key.strip_prefix("providerEnabled.") {
        if provider_id.is_empty() {
            return Err("Provider id missing after 'providerEnabled.'".to_string());
        }
        let enabled = parse_bool_value(value)
            .map_err(|_| format!("Expected a boolean (true/false) for '{}', got '{}'", key, value))?;
        return Ok(json!({ "providerEnabled": { provider_id: enabled } }));
    }
    if let Some(field) = key.strip_prefix("localBackup.") {
        let patch = match field {
            "enabled" => json!({ "localBackup": { "enabled": parse_bool_value(value)
                .map_err(|_| format!("Expected a boolean (true/false) for '{}', got '{}'", key, value))? } }),
            "directory" => json!({ "localBackup": { "directory": value } }),
            "retentionCount" => json!({ "localBackup": { "retentionCount": parse_number_value(key, value)? } }),
            _ => {
                return Err(format!(
                    "Unknown localBackup field '{}'. Use enabled, directory, or retentionCount.",
                    field
                ))
            }
        };
        return Ok(patch);
    }
    if STRING_KEYS.contains(&key) {
        if key == "theme" {
            // Theme is an enum in the desktop app; accept any case from the
            // terminal but reject unknown values instead of silently falling
            // back to the default theme.
            let lowered = value.to_ascii_lowercase();
            if !matches!(lowered.as_str(), "light" | "dark" | "system") {
                return Err(format!(
                    "Invalid theme '{}'. Use light, dark, or system.",
                    value
                ));
            }
            return Ok(json!({ key: lowered }));
        }
        return Ok(json!({ key: value }));
    }
    if BOOL_KEYS.contains(&key) {
        let parsed = parse_bool_value(value)
            .map_err(|_| format!("Expected a boolean (true/false) for '{}', got '{}'", key, value))?;
        return Ok(json!({ key: parsed }));
    }
    if NUMBER_KEYS.contains(&key) {
        return Ok(json!({ key: parse_number_value(key, value)? }));
    }
    Err(format!(
        "Unknown setting '{}'. Run 'atl-collector config list' to see all keys; \
         provider toggles use 'providerEnabled.<providerId>'.",
        key
    ))
}

fn cmd_roots(action: crate::RootsAction) -> Result<(), CliError> {
    let cfg = require_config()?;
    match action {
        crate::RootsAction::List => {
            if cfg.provider_roots.is_empty() {
                println!("No extra scan roots configured.");
                return Ok(());
            }
            let mut providers: Vec<&String> = cfg.provider_roots.keys().collect();
            providers.sort();
            for provider in providers {
                println!("{}:", provider);
                for root in &cfg.provider_roots[provider] {
                    println!("  {}", root);
                }
            }
        }
        crate::RootsAction::Add { provider, path } => {
            let next = config::add_provider_root(&provider, &path, &cfg);
            config::save_config(&next);
            println!("Added scan root for {}: {}", provider, path);
        }
        crate::RootsAction::Remove { provider, path } => {
            let next = config::remove_provider_root(&provider, &path, &cfg);
            config::save_config(&next);
            println!("Removed scan root for {}: {}", provider, path);
        }
    }
    Ok(())
}

fn format_int(n: i64) -> String {
    let digits = n.abs().to_string();
    let mut out = String::new();
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if n < 0 {
        format!("-{}", out)
    } else {
        out
    }
}

pub(crate) fn format_tokens_compact(n: i64) -> String {
    let sign = if n < 0 { "-" } else { "" };
    let value = n.abs() as f64;
    let scaled = |divisor: f64, unit: &str| {
        let text = format!("{:.2}", value / divisor);
        let text = text.trim_end_matches('0').trim_end_matches('.');
        format!("{}{}{}", sign, text, unit)
    };
    if value >= 1_000_000_000.0 {
        scaled(1_000_000_000.0, "B")
    } else if value >= 1_000_000.0 {
        scaled(1_000_000.0, "M")
    } else if value >= 1_000.0 {
        scaled(1_000.0, "K")
    } else {
        format!("{}{}", sign, n.abs())
    }
}

fn period_label(from: &str, to: &str) -> String {
    match (from.is_empty(), to.is_empty()) {
        (true, true) => "all time".to_string(),
        (false, true) => format!("from {}", from),
        (true, false) => format!("through {}", to),
        (false, false) => {
            if from == to {
                from.to_string()
            } else {
                format!("{} .. {}", from, to)
            }
        }
    }
}

fn rows_label(n: i64) -> &'static str {
    if n == 1 {
        "row"
    } else {
        "rows"
    }
}

fn breakdown_section(title: &str, rows: &[Value]) -> String {
    if rows.is_empty() {
        return format!("\n{}\n  (no data in this range)", title);
    }
    let width = rows
        .iter()
        .map(|row| row["name"].as_str().unwrap_or("").chars().count())
        .max()
        .unwrap_or(0)
        .max(4);
    let mut out = format!("\n{}\n", title);
    for row in rows {
        let cost_suffix = row
            .get("costUsd")
            .and_then(Value::as_f64)
            .map(|cost| format!("  ≈{}", pricing::format_usd(cost)))
            .unwrap_or_default();
        out.push_str(&format!(
            "  {:<width$} {:>12}  ({} {}){}\n",
            row["name"].as_str().unwrap_or(""),
            format_tokens_compact(row["totalTokens"].as_i64().unwrap_or(0)),
            format_int(row["rows"].as_i64().unwrap_or(0)),
            rows_label(row["rows"].as_i64().unwrap_or(0)),
            cost_suffix,
            width = width
        ));
    }
    out
}


fn filter_line(value: &Value) -> String {
    let Some(filters) = value.get("filters").filter(|f| f.as_object().is_some()) else {
        return String::new();
    };
    let active: Vec<String> = [("provider", "provider"), ("model", "model"), ("workdir", "workdir")]
        .iter()
        .filter_map(|(key, label)| {
            filters
                .get(*key)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(|v| format!("{}~{}", label, v))
        })
        .collect();
    if active.is_empty() {
        String::new()
    } else {
        format!("  filtered by {}\n", active.join(", "))
    }
}

fn render_summary(value: &Value) -> String {
    let totals = &value["totals"];
    let total = totals["totalTokens"].as_i64().unwrap_or(0);
    let mut out = format!(
        "Usage {} ({})\n",
        value["range"].as_str().unwrap_or(""),
        period_label(
            value["from"].as_str().unwrap_or(""),
            value["to"].as_str().unwrap_or("")
        )
    );
    out.push_str(&format!(
        "  total {} tokens ({}) across {} rows\n",
        format_int(total),
        format_tokens_compact(total),
        format_int(totals["rows"].as_i64().unwrap_or(0))
    ));
    out.push_str(&format!(
        "  input {}  output {}  cacheRead {}  cacheWrite {}  reasoning {}\n",
        format_tokens_compact(totals["inputTokens"].as_i64().unwrap_or(0)),
        format_tokens_compact(totals["outputTokens"].as_i64().unwrap_or(0)),
        format_tokens_compact(totals["cacheReadTokens"].as_i64().unwrap_or(0)),
        format_tokens_compact(totals["cacheWriteTokens"].as_i64().unwrap_or(0)),
        format_tokens_compact(totals["reasoningTokens"].as_i64().unwrap_or(0))
    ));
    if let Some(cost) = value.get("cost").filter(|c| !c.is_null()) {
        let usd = cost["estimatedCostUsd"].as_f64().unwrap_or(0.0);
        let quality = cost["costQuality"].as_str().unwrap_or("unknown_price");
        let unpriced = cost["unpricedTokens"].as_i64().unwrap_or(0);
        let mut line = format!(
            "  cost ≈ {} ({})",
            pricing::format_usd(usd),
            quality
        );
        if unpriced > 0 {
            let unpriced_models = cost["unpricedModels"].as_array().map(|a| a.len()).unwrap_or(0);
            line.push_str(&format!(
                "; excludes {} across {} unpriced models",
                format_tokens_compact(unpriced),
                unpriced_models
            ));
        }
        out.push_str(&line);
        out.push('\n');
    }
    let empty: Vec<Value> = Vec::new();
    out.push_str(&breakdown_section(
        "By provider",
        value["providers"].as_array().unwrap_or(&empty),
    ));
    out.push_str(&breakdown_section(
        "By model",
        value["models"].as_array().unwrap_or(&empty),
    ));
    out.push_str(&breakdown_section(
        "By workdir",
        value["workdirs"].as_array().unwrap_or(&empty),
    ));
    out
}

fn trend_bar(tokens: i64, max: i64) -> String {
    if max <= 0 {
        return String::new();
    }
    let width = ((tokens as f64 / max as f64) * 30.0).round() as usize;
    let width = width.max(if tokens > 0 { 1 } else { 0 }).min(30);
    "█".repeat(width)
}

fn render_trend(value: &Value) -> String {
    let mut out = format!(
        "Trend {} by {} ({})\n",
        value["range"].as_str().unwrap_or(""),
        value["grain"].as_str().unwrap_or("day"),
        period_label(
            value["from"].as_str().unwrap_or(""),
            value["to"].as_str().unwrap_or("")
        )
    );
    let rows = value["items"].as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        out.push_str("  (no data in this range)\n");
        return out;
    }
    let max = rows
        .iter()
        .map(|row| row["totalTokens"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    for row in &rows {
        let tokens = row["totalTokens"].as_i64().unwrap_or(0);
        out.push_str(&format!(
            "  {} {:>10}  {}\n",
            row["bucket"].as_str().unwrap_or("?"),
            format_tokens_compact(tokens),
            trend_bar(tokens, max)
        ));
    }
    out
}

fn render_workdirs(value: &Value) -> String {
    let rows = value["items"].as_array().cloned().unwrap_or_default();
    let mut out = format!(
        "Workdirs {} ({})\n",
        value["range"].as_str().unwrap_or(""),
        period_label(
            value["from"].as_str().unwrap_or(""),
            value["to"].as_str().unwrap_or("")
        )
    );
    if rows.is_empty() {
        out.push_str("  (no data in this range)\n");
        return out;
    }
    let width = rows
        .iter()
        .map(|row| {
            let name = row["name"].as_str().unwrap_or("");
            if name.is_empty() {
                "(unnamed)".chars().count()
            } else {
                name.chars().count()
            }
        })
        .max()
        .unwrap_or(0)
        .max(8);
    for row in &rows {
        let name = row["name"].as_str().unwrap_or("");
        out.push_str(&format!(
            "  {:<width$} {:>12}  ({} {})\n",
            if name.is_empty() { "(unnamed)" } else { name },
            format_tokens_compact(row["totalTokens"].as_i64().unwrap_or(0)),
            format_int(row["rows"].as_i64().unwrap_or(0)),
            rows_label(row["rows"].as_i64().unwrap_or(0)),
            width = width
        ));
    }
    out
}

fn render_detail(value: &Value) -> String {
    let rows = value["items"].as_array().cloned().unwrap_or_default();
    let total_rows = value["totalRows"].as_i64().unwrap_or(0);
    let offset = value["offset"].as_i64().unwrap_or(0);
    let mut out = format!(
        "Detail {} — {} rows total, showing {}..{}\n",
        value["range"].as_str().unwrap_or(""),
        format_int(total_rows),
        offset + 1,
        offset + rows.len() as i64
    );
    if rows.is_empty() {
        out.push_str("  (no data in this range)\n");
        return out;
    }
    let provider_width = rows
        .iter()
        .map(|row| row["providerId"].as_str().unwrap_or("").chars().count())
        .max()
        .unwrap_or(0)
        .max(8);
    let model_width = rows
        .iter()
        .map(|row| row["model"].as_str().unwrap_or("").chars().count())
        .max()
        .unwrap_or(0)
        .max(5)
        .min(24);
    for row in &rows {
        out.push_str(&format!(
            "  {} {:<pw$} {:<mw$} {:>10}  {}\n",
            row["day"].as_str().unwrap_or("?"),
            row["providerId"].as_str().unwrap_or(""),
            {
                let model = row["model"].as_str().unwrap_or("");
                if model.chars().count() > 24 {
                    format!("{:.21}...", model)
                } else {
                    model.to_string()
                }
            },
            format_tokens_compact(row["totalTokens"].as_i64().unwrap_or(0)),
            {
                let workdir = row["workdirDisplayName"].as_str().unwrap_or("");
                if workdir.is_empty() {
                    "(unnamed)"
                } else {
                    workdir
                }
            },
            pw = provider_width,
            mw = model_width
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_tokens_compact_scales() {
        assert_eq!(format_tokens_compact(0), "0");
        assert_eq!(format_tokens_compact(999), "999");
        assert_eq!(format_tokens_compact(81_375), "81.38K");
        assert_eq!(format_tokens_compact(200_887_532), "200.89M");
        assert_eq!(format_tokens_compact(1_200_000_000), "1.2B");
        assert_eq!(format_tokens_compact(-1_500), "-1.5K");
    }

    #[test]
    fn format_int_groups_thousands() {
        assert_eq!(format_int(1_234_567), "1,234,567");
        assert_eq!(format_int(999), "999");
        assert_eq!(format_int(-12_000), "-12,000");
    }

    #[test]
    fn config_patch_direct_keys_are_typed() {
        assert_eq!(
            config_key_to_patch("theme", "dark").unwrap(),
            json!({ "theme": "dark" })
        );
        assert_eq!(
            config_key_to_patch("theme", "SYSTEM").unwrap(),
            json!({ "theme": "system" })
        );
        assert_eq!(
            config_key_to_patch("showEstimatedCost", "true").unwrap(),
            json!({ "showEstimatedCost": true })
        );
        assert_eq!(
            config_key_to_patch("refreshIntervalMinutes", "30").unwrap(),
            json!({ "refreshIntervalMinutes": 30 })
        );
    }

    #[test]
    fn theme_rejects_unknown_enum_values() {
        let err = config_key_to_patch("theme", "purple").unwrap_err();
        assert!(err.contains("light, dark, or system"), "{}", err);
    }

    #[test]
    fn range_validation_rejects_garbage_and_bad_dates() {
        for good in [
            "today",
            "7d",
            "last7",
            "30d",
            "last30",
            "all",
            "",
            "2026-09-01..2026-09-15",
            "..2026-09-15",
            "2026-09-01..",
            "..",
        ] {
            assert!(validate_range(good).is_ok(), "expected ok: {}", good);
        }
        for bad in [
            "bogus",
            "30dd",
            "2026-09-15",
            "2026-13-99..2026-99-99",
            "7..30",
            "2026-9-1..2026-9-2",
        ] {
            assert!(validate_range(bad).is_err(), "expected err: {}", bad);
        }
    }

    #[test]
    fn config_patch_provider_toggle_and_local_backup() {
        assert_eq!(
            config_key_to_patch("providerEnabled.zcode_local", "off").unwrap(),
            json!({ "providerEnabled": { "zcode_local": false } })
        );
        assert_eq!(
            config_key_to_patch("localBackup.retentionCount", "10").unwrap(),
            json!({ "localBackup": { "retentionCount": 10 } })
        );
        assert_eq!(
            config_key_to_patch("localBackup.enabled", "no").unwrap(),
            json!({ "localBackup": { "enabled": false } })
        );
    }

    #[test]
    fn config_patch_rejects_unknown_keys_and_bad_values() {
        assert!(config_key_to_patch("identityPrivateKey", "x").is_err());
        assert!(config_key_to_patch("unknownKey", "x").is_err());
        assert!(config_key_to_patch("showEstimatedCost", "maybe").is_err());
        assert!(config_key_to_patch("refreshIntervalMinutes", "abc").is_err());
        assert!(config_key_to_patch("localBackup.bogus", "x").is_err());
        assert!(config_key_to_patch("providerEnabled.", "true").is_err());
    }

    #[test]
    fn settings_view_masks_private_key_and_restores_dropped_fields() {
        let cfg = config::init_config(json!({}), false);
        let view = settings_view(&cfg);
        assert_eq!(
            view["identityPrivateKey"].as_str().unwrap(),
            "(hidden — use export-identity)"
        );
        assert!(view["autoRefreshEnabled"].is_boolean());
        assert!(view["cursorDashboardUsage"]["accounts"]
            .as_array()
            .map(|accounts| accounts.is_empty())
            .unwrap_or(false));
    }

    #[test]
    fn lookup_path_walks_nested_keys() {
        let value = json!({ "a": { "b": { "c": 7 } }, "list": [1, 2] });
        assert_eq!(lookup_path(&value, "a.b.c"), Some(&json!(7)));
        assert_eq!(lookup_path(&value, "a.b"), Some(&json!({ "c": 7 })));
        assert_eq!(lookup_path(&value, "a.bogus"), None);
        assert_eq!(lookup_path(&value, "list.0"), None);
    }

    #[test]
    fn render_summary_includes_totals_and_sections() {
        let value = json!({
            "range": "7d",
            "from": "2026-09-09",
            "to": "2026-09-15",
            "totals": {
                "rows": 100,
                "inputTokens": 1_000_000,
                "outputTokens": 500_000,
                "cacheReadTokens": 10_000_000,
                "cacheWriteTokens": 0,
                "reasoningTokens": 100_000,
                "totalTokens": 11_600_000
            },
            "providers": [ { "name": "zcode_local", "totalTokens": 11_000_000, "rows": 90 } ],
            "models": [ { "name": "glm-5.3", "totalTokens": 11_600_000, "rows": 100 } ],
            "workdirs": []
        });
        let text = render_summary(&value);
        assert!(text.contains("Usage 7d (2026-09-09 .. 2026-09-15)"));
        assert!(text.contains("11,600,000 tokens (11.6M)"));
        assert!(text.contains("By provider"));
        assert!(text.contains("zcode_local"));
        assert!(text.contains("By model"));
        assert!(text.contains("(no data in this range)"));
    }

    #[test]
    fn render_trend_draws_bars() {
        let value = json!({
            "range": "7d",
            "grain": "day",
            "from": "2026-09-14",
            "to": "2026-09-15",
            "items": [
                { "bucket": "2026-09-14", "totalTokens": 500 },
                { "bucket": "2026-09-15", "totalTokens": 1_000 }
            ]
        });
        let text = render_trend(&value);
        assert!(text.contains("2026-09-15"));
        assert!(text.contains("1K"));
        assert!(text.contains("█"));
        let empty = json!({ "range": "7d", "grain": "day", "from": "", "to": "", "items": [] });
        assert!(render_trend(&empty).contains("(no data in this range)"));
    }

    #[test]
    fn provider_totals_are_sorted_by_tokens() {
        let items = vec![
            json!({ "providerId": "a", "totalTokens": 100 }),
            json!({ "providerId": "b", "totalTokens": 300 }),
            json!({ "providerId": "a", "totalTokens": 50 }),
        ];
        let rows = provider_totals(&items);
        assert_eq!(rows[0]["providerId"], json!("b"));
        assert_eq!(rows[0]["totalTokens"], json!(300));
        assert_eq!(rows[1]["providerId"], json!("a"));
        assert_eq!(rows[1]["items"], json!(2));
    }

    #[test]
    fn period_label_covers_all_shapes() {
        assert_eq!(period_label("", ""), "all time");
        assert_eq!(period_label("2026-09-15", "2026-09-15"), "2026-09-15");
        assert_eq!(
            period_label("2026-09-09", "2026-09-15"),
            "2026-09-09 .. 2026-09-15"
        );
        assert_eq!(period_label("", "2026-09-15"), "through 2026-09-15");
    }
}
