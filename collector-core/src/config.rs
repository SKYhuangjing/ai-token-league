use crate::crypto::{generate_identity, new_id};
use crate::sync::SyncOutcome;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[cfg(test)]
pub static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub const DEFAULT_AUTO_REFRESH_ENABLED: bool = true;
pub const DEFAULT_SILENT_UPDATE_MODE: &str = "auto_download";
pub const SILENT_UPDATE_MODES: &[&str] = &["notify", "auto_download", "auto_apply_on_idle"];

fn app_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".ai-token-league")
}

pub fn config_path() -> PathBuf {
    app_dir().join("config.json")
}

pub fn queue_path() -> PathBuf {
    app_dir().join("upload-queue.json")
}

pub fn usage_cache_path() -> PathBuf {
    app_dir().join("usage-cache.json")
}

pub fn local_usage_db_path() -> PathBuf {
    app_dir().join("usage-local.sqlite3")
}

pub fn source_index_cache_path() -> PathBuf {
    app_dir().join("source-index-cache.json")
}

pub fn source_index_cache_dir() -> PathBuf {
    app_dir().join("source-index-cache")
}

pub fn runtime_log_dir() -> PathBuf {
    app_dir().join("log")
}

pub fn runtime_log_path() -> PathBuf {
    let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
    runtime_log_dir().join(format!("runtime.{}.log", day))
}

pub fn legacy_runtime_log_path() -> PathBuf {
    app_dir().join("runtime-log.jsonl")
}

pub fn manifest_path() -> PathBuf {
    app_dir().join("sync-manifest.json")
}

pub fn sync_state_path() -> PathBuf {
    app_dir().join("sync-state.json")
}

pub fn ensure_app_dir() {
    let _ = fs::create_dir_all(app_dir());
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn normalize_api_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

pub fn generated_nickname() -> String {
    let suffix: String = new_id("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(6)
        .collect();
    if suffix.is_empty() {
        "player".to_string()
    } else {
        format!("player-{}", suffix.to_ascii_lowercase())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTokenRecord {
    pub token: String,
    #[serde(default)]
    pub account_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorAccount {
    pub access_token: String,
    pub refresh_token: String,
    pub auth_id: String,
    #[serde(default)]
    pub sub: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub account_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token_expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_refresh_at: Option<String>,
    #[serde(default = "default_auth_status")]
    pub auth_status: String,
    #[serde(default)]
    pub ignored: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_at: Option<String>,
}

fn default_auth_status() -> String {
    "active".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorDashboardUsageConfig {
    #[serde(default)]
    pub workos_session_token: String,
    #[serde(default)]
    pub workos_session_tokens: Vec<CursorTokenRecord>,
    #[serde(default)]
    pub accounts: Vec<CursorAccount>,
}

impl Default for CursorDashboardUsageConfig {
    fn default() -> Self {
        Self {
            workos_session_token: String::new(),
            workos_session_tokens: vec![],
            accounts: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBackupConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub directory: String,
    #[serde(default = "default_backup_retention")]
    pub retention_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_backup_at: Option<String>,
}

impl Default for LocalBackupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            directory: String::new(),
            retention_count: default_backup_retention(),
            last_backup_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub participant_id: String,
    #[serde(default = "default_nickname")]
    pub nickname: String,
    #[serde(default)]
    pub nickname_auto_generated: bool,
    pub identity_public_key: String,
    pub identity_private_key: String,
    pub device_id: String,
    #[serde(default)]
    pub api_base_url: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub show_estimated_cost: bool,
    #[serde(default)]
    pub show_raw_tokens: bool,
    #[serde(default = "default_true")]
    pub auto_refresh_enabled: bool,
    #[serde(default = "default_silent_update_mode")]
    pub silent_update_mode: String,
    #[serde(default = "default_refresh_interval")]
    pub refresh_interval_minutes: u64,
    #[serde(default)]
    pub launch_at_login: bool,
    #[serde(default)]
    pub hide_dock_icon: bool,
    #[serde(default)]
    pub desktop_auto_initialized: bool,
    #[serde(default)]
    pub cursor_dashboard_usage: CursorDashboardUsageConfig,
    #[serde(default)]
    pub local_backup: LocalBackupConfig,
    #[serde(default = "default_runtime_log_retention_days")]
    pub runtime_log_retention_days: u64,
    #[serde(default)]
    pub api_connection: serde_json::Value,
    #[serde(default, deserialize_with = "null_as_default")]
    pub sync_status: SyncStatusRecord,
    #[serde(default)]
    pub workdir_aliases: HashMap<String, String>,
    #[serde(default)]
    pub provider_roots: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub provider_enabled: HashMap<String, bool>,
    #[serde(default)]
    pub provider_ignored_auto_sources: HashMap<String, Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_api_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusRecord {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub api_base_url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub last_attempt_at: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub last_finished_at: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub last_success_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<SyncOutcome>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub last_error: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub last_success_source_fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_result: Option<serde_json::Value>,
}

fn default_nickname() -> String {
    "anonymous".to_string()
}
fn default_true() -> bool {
    true
}
fn default_silent_update_mode() -> String {
    DEFAULT_SILENT_UPDATE_MODE.to_string()
}
fn default_refresh_interval() -> u64 {
    15
}
fn default_backup_retention() -> u64 {
    7
}
fn default_runtime_log_retention_days() -> u64 {
    3
}

fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

pub fn normalize_silent_update_mode(value: &str) -> &str {
    if SILENT_UPDATE_MODES.contains(&value) {
        value
    } else {
        DEFAULT_SILENT_UPDATE_MODE
    }
}

pub fn load_config() -> Option<AppConfig> {
    let path = config_path();
    if !path.exists() {
        return None;
    }
    let content = fs::read_to_string(&path).ok()?;
    let mut config: AppConfig = serde_json::from_str(&content).ok()?;
    // Fix runtime fields
    config.auto_refresh_enabled = DEFAULT_AUTO_REFRESH_ENABLED;
    config.silent_update_mode = DEFAULT_SILENT_UPDATE_MODE.to_string();
    Some(config)
}

fn merge_object_values(
    base: serde_json::Value,
    override_value: serde_json::Value,
) -> serde_json::Value {
    let mut merged = base;
    if let (Some(target), Some(source)) = (merged.as_object_mut(), override_value.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    merged
}

pub fn load_build_preset() -> serde_json::Value {
    const ALLOWED_KEYS: &[&str] = &[
        "apiBaseUrl",
        "nickname",
        "language",
        "refreshIntervalMinutes",
        "launchAtLogin",
        "showEstimatedCost",
        "showRawTokens",
        "providerEnabled",
    ];

    let mut candidates = Vec::new();
    if let Ok(resource_dir) = std::env::var("ATL_RESOURCE_DIR") {
        if !resource_dir.trim().is_empty() {
            candidates.push(
                PathBuf::from(resource_dir)
                    .join("assets")
                    .join("preset.json"),
            );
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("assets").join("preset.json"));
    }

    for path in candidates {
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(raw) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        let Some(raw_obj) = raw.as_object() else {
            continue;
        };
        let mut result = serde_json::Map::new();
        for key in ALLOWED_KEYS {
            if let Some(value) = raw_obj.get(*key) {
                result.insert((*key).to_string(), value.clone());
            }
        }
        return serde_json::Value::Object(result);
    }
    serde_json::json!({})
}

pub fn ensure_desktop_config() -> AppConfig {
    if let Some(mut current) = load_config() {
        let cleaned_deprecated_cursor_sources = cleanup_deprecated_cursor_sources(&mut current);
        if !current.desktop_auto_initialized {
            if cleaned_deprecated_cursor_sources {
                save_config(&current);
            }
            return current;
        }
        if current.nickname.trim().is_empty() || current.nickname == "anonymous" {
            current.nickname = generated_nickname();
            current.nickname_auto_generated = true;
            save_config(&current);
        } else if cleaned_deprecated_cursor_sources {
            save_config(&current);
        }
        return current;
    }
    let mut input = load_build_preset();
    if let Some(obj) = input.as_object_mut() {
        obj.insert(
            "desktopAutoInitialized".to_string(),
            serde_json::json!(true),
        );
        if !obj.contains_key("nickname") {
            obj.insert(
                "nickname".to_string(),
                serde_json::json!(generated_nickname()),
            );
            obj.insert("nicknameAutoGenerated".to_string(), serde_json::json!(true));
        }
    }
    init_config(input, true)
}

pub fn save_config(config: &AppConfig) {
    ensure_app_dir();
    // Fix runtime fields before save
    let mut fixed = config.clone();
    fixed.auto_refresh_enabled = DEFAULT_AUTO_REFRESH_ENABLED;
    fixed.silent_update_mode = DEFAULT_SILENT_UPDATE_MODE.to_string();
    cleanup_deprecated_cursor_sources(&mut fixed);
    let json = serde_json::to_string_pretty(&fixed).unwrap_or_default();
    let _ = fs::write(config_path(), format!("{}\n", json));
}

pub fn init_config(input: serde_json::Value, persist: bool) -> AppConfig {
    let input = merge_object_values(load_build_preset(), input);
    let identity = generate_identity();
    let interval = input["refreshIntervalMinutes"]
        .as_u64()
        .unwrap_or(15)
        .max(1);
    let fallback_nickname = generated_nickname();

    let config = AppConfig {
        participant_id: identity.participant_id,
        nickname: input["nickname"]
            .as_str()
            .unwrap_or(&fallback_nickname)
            .to_string(),
        nickname_auto_generated: input["nicknameAutoGenerated"]
            .as_bool()
            .unwrap_or(!input["nickname"].is_string()),
        identity_public_key: identity.identity_public_key,
        identity_private_key: identity.identity_private_key,
        device_id: new_id("d"),
        api_base_url: normalize_api_base_url(input["apiBaseUrl"].as_str().unwrap_or("")),
        language: input["language"].as_str().unwrap_or("").to_string(),
        show_estimated_cost: input["showEstimatedCost"].as_bool().unwrap_or(false),
        show_raw_tokens: input["showRawTokens"].as_bool().unwrap_or(false),
        auto_refresh_enabled: DEFAULT_AUTO_REFRESH_ENABLED,
        silent_update_mode: DEFAULT_SILENT_UPDATE_MODE.to_string(),
        refresh_interval_minutes: interval,
        launch_at_login: input["launchAtLogin"].as_bool().unwrap_or(false),
        hide_dock_icon: input["hideDockIcon"].as_bool().unwrap_or(false),
        desktop_auto_initialized: input["desktopAutoInitialized"].as_bool().unwrap_or(false),
        cursor_dashboard_usage: CursorDashboardUsageConfig::default(),
        local_backup: LocalBackupConfig::default(),
        runtime_log_retention_days: default_runtime_log_retention_days(),
        api_connection: input
            .get("apiConnection")
            .cloned()
            .filter(|v| !v.is_null())
            .unwrap_or_else(|| serde_json::json!({})),
        sync_status: SyncStatusRecord::default(),
        workdir_aliases: HashMap::new(),
        provider_roots: HashMap::new(),
        provider_enabled: serde_json::from_value(
            input
                .get("providerEnabled")
                .cloned()
                .unwrap_or(serde_json::json!({})),
        )
        .unwrap_or_default(),
        provider_ignored_auto_sources: HashMap::new(),
        created_at: Some(now_iso()),
        updated_at: None,
        imported_at: None,
        last_sync_at: None,
        last_sync_status: None,
        last_sync_api_base_url: None,
        last_sync_error: None,
    };

    if persist {
        save_config(&config);
    }
    config
}

pub fn export_identity(config: &AppConfig) -> serde_json::Value {
    serde_json::json!({
        "participantId": config.participant_id,
        "nickname": config.nickname,
        "identityPublicKey": config.identity_public_key,
        "identityPrivateKey": config.identity_private_key
    })
}

pub fn import_identity(
    identity: serde_json::Value,
    current: &AppConfig,
    persist: bool,
) -> AppConfig {
    let mut config = current.clone();
    config.participant_id = identity["participantId"]
        .as_str()
        .unwrap_or(&config.participant_id)
        .to_string();
    config.nickname = identity["nickname"]
        .as_str()
        .unwrap_or(&config.nickname)
        .to_string();
    config.identity_public_key = identity["identityPublicKey"]
        .as_str()
        .unwrap_or("")
        .to_string();
    config.identity_private_key = identity["identityPrivateKey"]
        .as_str()
        .unwrap_or("")
        .to_string();
    config.desktop_auto_initialized = false;
    config.imported_at = Some(now_iso());

    if persist {
        save_config(&config);
    }
    config
}

pub fn export_config(config: &AppConfig) -> serde_json::Value {
    let mut value = serde_json::to_value(config).unwrap_or_default();
    if let Some(obj) = value.as_object_mut() {
        obj.remove("syncStatus");
        obj.remove("apiConnection");
        obj.remove("lastSyncAt");
        obj.remove("lastSyncStatus");
        obj.remove("lastSyncApiBaseUrl");
        obj.remove("lastSyncError");
        obj.remove("updatedAt");
        obj.remove("createdAt");
        obj.remove("importedAt");
        obj.remove("autoRefreshEnabled");
        obj.remove("silentUpdateMode");
        obj.insert(
            "cursorDashboardUsage".to_string(),
            serde_json::to_value(CursorDashboardUsageConfig::default())
                .unwrap_or_else(|_| serde_json::json!({})),
        );
        if let Some(ignored) = obj
            .get_mut("providerIgnoredAutoSources")
            .and_then(|v| v.as_object_mut())
        {
            ignored.remove("cursor_dashboard_usage");
        }
        obj.insert("exportedAt".to_string(), serde_json::json!(now_iso()));
    }
    value
}

fn clear_join_import_local_state() -> Vec<String> {
    let files = [
        ("syncManifest", manifest_path()),
        ("syncState", sync_state_path()),
        ("uploadQueue", queue_path()),
        ("usageCache", usage_cache_path()),
    ];
    let mut removed = Vec::new();
    for (key, path) in files {
        if path.exists() && fs::remove_file(&path).is_ok() {
            removed.push(key.to_string());
        }
    }
    removed
}

pub fn import_config_with_summary(
    imported: serde_json::Value,
    mode: Option<&str>,
) -> Result<(AppConfig, serde_json::Value), String> {
    if imported["participantId"].is_null()
        || imported["identityPublicKey"].is_null()
        || imported["identityPrivateKey"].is_null()
    {
        return Err("Invalid config file: missing identity fields".to_string());
    }

    let is_join = match mode {
        Some("join_existing_participant") => true,
        Some("restore_device") | None => false,
        Some(other) => return Err(format!("Invalid config import mode: {}", other)),
    };

    let existing_config = load_config();
    let old_device_id = existing_config.as_ref().map(|c| c.device_id.clone());

    // Join mode preserves device-local state; restores identity + safe preferences only.
    let (device_id, provider_roots, workdir_aliases, provider_ignored_auto_sources, local_backup) =
        if is_join {
            let existing = existing_config.as_ref();
            (
                existing
                    .map(|c| c.device_id.clone())
                    .unwrap_or_else(|| new_id("d")),
                existing
                    .map(|c| c.provider_roots.clone())
                    .unwrap_or_default(),
                existing
                    .map(|c| c.workdir_aliases.clone())
                    .unwrap_or_default(),
                existing
                    .map(|c| c.provider_ignored_auto_sources.clone())
                    .unwrap_or_default(),
                existing.map(|c| c.local_backup.clone()).unwrap_or_default(),
            )
        } else {
            (
                imported["deviceId"]
                    .as_str()
                    .unwrap_or(&new_id("d"))
                    .to_string(),
                serde_json::from_value(imported["providerRoots"].clone()).unwrap_or_default(),
                serde_json::from_value(imported["workdirAliases"].clone()).unwrap_or_default(),
                serde_json::from_value(imported["providerIgnoredAutoSources"].clone())
                    .unwrap_or_default(),
                serde_json::from_value(imported["localBackup"].clone()).unwrap_or_default(),
            )
        };

    let config = AppConfig {
        participant_id: imported["participantId"].as_str().unwrap_or("").to_string(),
        nickname: imported["nickname"]
            .as_str()
            .unwrap_or("anonymous")
            .to_string(),
        nickname_auto_generated: imported["nicknameAutoGenerated"].as_bool().unwrap_or(false),
        identity_public_key: imported["identityPublicKey"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        identity_private_key: imported["identityPrivateKey"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        device_id,
        api_base_url: imported["apiBaseUrl"].as_str().unwrap_or("").to_string(),
        language: imported["language"].as_str().unwrap_or("").to_string(),
        show_estimated_cost: imported["showEstimatedCost"].as_bool().unwrap_or(false),
        show_raw_tokens: imported["showRawTokens"].as_bool().unwrap_or(false),
        auto_refresh_enabled: DEFAULT_AUTO_REFRESH_ENABLED,
        silent_update_mode: DEFAULT_SILENT_UPDATE_MODE.to_string(),
        refresh_interval_minutes: imported["refreshIntervalMinutes"]
            .as_u64()
            .unwrap_or(15)
            .max(1),
        launch_at_login: imported["launchAtLogin"].as_bool().unwrap_or(false),
        hide_dock_icon: imported["hideDockIcon"].as_bool().unwrap_or(false),
        desktop_auto_initialized: false,
        cursor_dashboard_usage: CursorDashboardUsageConfig::default(),
        local_backup,
        runtime_log_retention_days: imported["runtimeLogRetentionDays"]
            .as_u64()
            .unwrap_or(default_runtime_log_retention_days())
            .clamp(1, 30),
        api_connection: serde_json::json!({}),
        sync_status: SyncStatusRecord::default(),
        workdir_aliases,
        provider_roots,
        provider_enabled: serde_json::from_value(imported["providerEnabled"].clone())
            .unwrap_or_default(),
        provider_ignored_auto_sources,
        created_at: None,
        updated_at: None,
        imported_at: Some(now_iso()),
        last_sync_at: None,
        last_sync_status: None,
        last_sync_api_base_url: None,
        last_sync_error: None,
    };

    save_config(&config);
    let cleaned_local_state_files = if is_join {
        clear_join_import_local_state()
    } else {
        Vec::new()
    };
    let import_mode = if is_join {
        "join_existing_participant"
    } else {
        "restore_device"
    };
    let summary = serde_json::json!({
        "mode": import_mode,
        "participantId": config.participant_id,
        "oldDeviceId": old_device_id,
        "newDeviceId": config.device_id,
        "deviceIdChanged": old_device_id.as_ref().is_some_and(|old| old != &config.device_id),
        "cleanedLocalStateFiles": cleaned_local_state_files
    });
    Ok((config, summary))
}

pub fn import_config(imported: serde_json::Value, mode: Option<&str>) -> Result<AppConfig, String> {
    import_config_with_summary(imported, mode).map(|(config, _)| config)
}

pub fn add_provider_root(provider_id: &str, root_path: &str, current: &AppConfig) -> AppConfig {
    let normalized = std::path::Path::new(root_path)
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| root_path.to_string());

    let mut config = current.clone();
    let roots = config
        .provider_roots
        .entry(provider_id.to_string())
        .or_default();
    if !roots.contains(&normalized) {
        roots.push(normalized);
    }
    save_config(&config);
    config
}

pub fn remove_provider_root(provider_id: &str, root_path: &str, current: &AppConfig) -> AppConfig {
    let normalized = std::path::Path::new(root_path)
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| root_path.to_string());

    let mut config = current.clone();
    if let Some(roots) = config.provider_roots.get_mut(provider_id) {
        roots.retain(|r| r != &normalized);
    }
    save_config(&config);
    config
}

pub fn set_workdir_alias(workdir_hash: &str, alias: &str, current: &AppConfig) -> AppConfig {
    let mut config = current.clone();
    let clean_alias = alias.trim();
    if clean_alias.is_empty() {
        config.workdir_aliases.remove(workdir_hash);
    } else {
        config
            .workdir_aliases
            .insert(workdir_hash.to_string(), clean_alias.to_string());
    }
    save_config(&config);
    config
}

pub fn add_cursor_token(
    input: serde_json::Value,
    current: &AppConfig,
) -> Result<AppConfig, String> {
    let mut records = parse_cursor_token_input(input)?;
    if records.is_empty() {
        return Err("Cursor token is empty or invalid".to_string());
    }
    let mut config = current.clone();
    let existing = &mut config.cursor_dashboard_usage.workos_session_tokens;
    for record in records.drain(..) {
        if let Some(item) = existing.iter_mut().find(|item| item.token == record.token) {
            if !record.account_name.is_empty() {
                item.account_name = record.account_name;
            }
            if item.added_at.is_none() {
                item.added_at = Some(now_iso());
            }
        } else {
            existing.push(record);
        }
    }
    config.cursor_dashboard_usage.workos_session_token = String::new();
    config
        .provider_enabled
        .insert("cursor_dashboard_usage".to_string(), true);
    config.updated_at = Some(now_iso());
    save_config(&config);
    Ok(config)
}

pub fn remove_cursor_token(input: serde_json::Value, current: &AppConfig) -> AppConfig {
    let mut config = current.clone();
    if let Some(idx) = input.as_u64().map(|v| v as usize) {
        if idx < config.cursor_dashboard_usage.workos_session_tokens.len() {
            config
                .cursor_dashboard_usage
                .workos_session_tokens
                .remove(idx);
        }
    } else {
        let token = input.as_str().unwrap_or("").trim();
        config
            .cursor_dashboard_usage
            .workos_session_tokens
            .retain(|item| item.token != token);
    }
    config.updated_at = Some(now_iso());
    save_config(&config);
    config
}

pub fn upsert_cursor_account(account: CursorAccount, current: &AppConfig) -> AppConfig {
    let mut config = current.clone();
    let email_key = normalize_cursor_account_key(&account.email);
    let hash_key = account.account_hash.trim().to_string();
    let auth_key = account.auth_id.trim().to_string();

    config.cursor_dashboard_usage.accounts.retain(|existing| {
        let same_email =
            !email_key.is_empty() && normalize_cursor_account_key(&existing.email) == email_key;
        let same_hash = !hash_key.is_empty() && existing.account_hash.trim() == hash_key;
        let same_auth = !auth_key.is_empty() && existing.auth_id.trim() == auth_key;
        !(same_email || same_hash || same_auth)
    });
    config.cursor_dashboard_usage.accounts.push(account);

    cleanup_deprecated_cursor_sources(&mut config);

    config
        .provider_enabled
        .insert("cursor_dashboard_usage".to_string(), true);
    config.updated_at = Some(now_iso());
    save_config(&config);
    config
}

pub fn normalize_cursor_account_key(value: &str) -> String {
    value.trim().to_lowercase()
}

fn cleanup_deprecated_cursor_sources(config: &mut AppConfig) -> bool {
    let mut changed = false;
    if !config
        .cursor_dashboard_usage
        .workos_session_token
        .is_empty()
    {
        config.cursor_dashboard_usage.workos_session_token = String::new();
        changed = true;
    }
    if !config
        .cursor_dashboard_usage
        .workos_session_tokens
        .is_empty()
    {
        config.cursor_dashboard_usage.workos_session_tokens.clear();
        changed = true;
    }
    if config
        .provider_ignored_auto_sources
        .remove("cursor_dashboard_usage")
        .is_some()
    {
        changed = true;
    }
    changed
}

pub fn reset_local_data() {
    let _ = fs::remove_file(config_path());
    let _ = fs::remove_file(queue_path());
    let _ = fs::remove_file(manifest_path());
    let _ = fs::remove_file(usage_cache_path());
    let _ = fs::remove_file(local_usage_db_path());
    let _ = fs::remove_file(local_usage_db_path().with_extension("sqlite3-wal"));
    let _ = fs::remove_file(local_usage_db_path().with_extension("sqlite3-shm"));
    let _ = fs::remove_file(source_index_cache_path());
    let _ = fs::remove_dir_all(source_index_cache_dir());
    let _ = fs::remove_file(legacy_runtime_log_path());
    let _ = fs::remove_dir_all(runtime_log_dir());
}

fn parse_cursor_token_input(input: serde_json::Value) -> Result<Vec<CursorTokenRecord>, String> {
    if let Some(text) = input.as_str() {
        return parse_cursor_token_text(text);
    }
    if input.is_object() {
        let token = input["token"]
            .as_str()
            .or_else(|| input["value"].as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if token.is_empty() {
            return Ok(vec![]);
        }
        return Ok(vec![CursorTokenRecord {
            token,
            account_name: input["accountName"]
                .as_str()
                .unwrap_or("")
                .trim()
                .to_string(),
            added_at: Some(now_iso()),
        }]);
    }
    Ok(vec![])
}

fn parse_cursor_token_text(text: &str) -> Result<Vec<CursorTokenRecord>, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(vec![]);
    }
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        let parsed: serde_json::Value = serde_json::from_str(trimmed)
            .map_err(|e| format!("Invalid Cursor token JSON: {}", e))?;
        if let Some(items) = parsed.as_array() {
            let mut records = Vec::new();
            for item in items {
                records.extend(parse_cursor_token_input(item.clone())?);
            }
            return Ok(records);
        }
        return parse_cursor_token_input(parsed);
    }
    Ok(vec![CursorTokenRecord {
        token: trimmed.to_string(),
        account_name: String::new(),
        added_at: Some(now_iso()),
    }])
}

pub fn update_config(input: serde_json::Value, current: &AppConfig, persist: bool) -> AppConfig {
    let mut config = current.clone();

    if let Some(v) = input["nickname"].as_str() {
        config.nickname = v.to_string();
    }
    if let Some(v) = input["nicknameAutoGenerated"].as_bool() {
        config.nickname_auto_generated = v;
    }
    if let Some(v) = input["apiBaseUrl"].as_str() {
        let previous = normalize_api_base_url(&config.api_base_url);
        let next = normalize_api_base_url(v);
        config.api_base_url = next.clone();
        if previous != next {
            config.sync_status = SyncStatusRecord::default();
            config.last_sync_at = None;
            config.last_sync_status = None;
            config.last_sync_api_base_url = None;
            config.last_sync_error = None;
        }
    }
    if let Some(v) = input["language"].as_str() {
        config.language = v.to_string();
    }
    if let Some(v) = input["showEstimatedCost"].as_bool() {
        config.show_estimated_cost = v;
    }
    if let Some(v) = input["showRawTokens"].as_bool() {
        config.show_raw_tokens = v;
    }
    if let Some(v) = input["launchAtLogin"].as_bool() {
        config.launch_at_login = v;
    }
    if let Some(v) = input["hideDockIcon"].as_bool() {
        config.hide_dock_icon = v;
    }
    if let Some(v) = input["desktopAutoInitialized"].as_bool() {
        config.desktop_auto_initialized = v;
    }
    if let Some(v) = input["refreshIntervalMinutes"].as_u64() {
        config.refresh_interval_minutes = v.max(1);
    }
    if let Some(v) = input.get("apiConnection").cloned() {
        config.api_connection = v;
    }
    if let Some(v) = input.get("syncStatus").cloned() {
        config.sync_status = serde_json::from_value(v).unwrap_or_default();
    }
    if let Some(v) = input["lastSyncAt"].as_str() {
        config.last_sync_at = Some(v.to_string());
    }
    if let Some(v) = input["lastSyncStatus"].as_str() {
        config.last_sync_status = Some(v.to_string());
    }
    if let Some(v) = input["lastSyncApiBaseUrl"].as_str() {
        config.last_sync_api_base_url = Some(v.to_string());
    }
    if let Some(v) = input["lastSyncError"].as_str() {
        config.last_sync_error = Some(v.to_string());
    }
    if let Some(v) = input.get("providerIgnoredAutoSources").cloned() {
        config.provider_ignored_auto_sources = serde_json::from_value(v).unwrap_or_default();
    }

    if let Some(pe) = input.get("providerEnabled") {
        if let Ok(map) = serde_json::from_value::<HashMap<String, bool>>(pe.clone()) {
            for (k, v) in map {
                config.provider_enabled.insert(k, v);
            }
        }
    }

    if let Some(cdu) = input.get("cursorDashboardUsage") {
        let merged: CursorDashboardUsageConfig =
            serde_json::from_value(cdu.clone()).unwrap_or_default();
        config.cursor_dashboard_usage = merged;
    }

    if let Some(local_backup) = input.get("localBackup") {
        let mut merged = config.local_backup.clone();
        if let Some(v) = local_backup["enabled"].as_bool() {
            merged.enabled = v;
        }
        if let Some(v) = local_backup["directory"].as_str() {
            merged.directory = v.trim().to_string();
        }
        if let Some(v) = local_backup["retentionCount"].as_u64() {
            merged.retention_count = v.clamp(1, 30);
        }
        if let Some(v) = local_backup["lastBackupAt"].as_str() {
            merged.last_backup_at = Some(v.to_string());
        }
        config.local_backup = merged;
    }
    if let Some(v) = input["runtimeLogRetentionDays"].as_u64() {
        config.runtime_log_retention_days = v.clamp(1, 30);
    }

    config.updated_at = Some(now_iso());

    if persist {
        save_config(&config);
    }
    config
}

pub fn ignore_auto_source(provider_id: &str, source_id: &str, current: &AppConfig) -> AppConfig {
    let mut config = current.clone();
    if provider_id == "cursor_dashboard_usage" {
        set_cursor_account_ignored(&mut config, source_id, true);
        config.updated_at = Some(now_iso());
        save_config(&config);
        return config;
    }
    let list = config
        .provider_ignored_auto_sources
        .entry(provider_id.to_string())
        .or_default();
    if !list.contains(&source_id.to_string()) {
        list.push(source_id.to_string());
    }
    config.updated_at = Some(now_iso());
    save_config(&config);
    config
}

pub fn unignore_auto_source(provider_id: &str, source_id: &str, current: &AppConfig) -> AppConfig {
    let mut config = current.clone();
    if provider_id == "cursor_dashboard_usage" {
        set_cursor_account_ignored(&mut config, source_id, false);
        config.updated_at = Some(now_iso());
        save_config(&config);
        return config;
    }
    if let Some(list) = config.provider_ignored_auto_sources.get_mut(provider_id) {
        list.retain(|id| id != source_id);
        if list.is_empty() {
            config.provider_ignored_auto_sources.remove(provider_id);
        }
    }
    config.updated_at = Some(now_iso());
    save_config(&config);
    config
}

fn set_cursor_account_ignored(config: &mut AppConfig, source_id: &str, ignored: bool) {
    let source_key = normalize_cursor_account_key(source_id);
    for (index, account) in config
        .cursor_dashboard_usage
        .accounts
        .iter_mut()
        .enumerate()
    {
        let index_id = format!("account:{}", index);
        let same_index = source_id == index_id;
        let same_hash =
            !account.account_hash.trim().is_empty() && account.account_hash == source_id;
        let same_auth = !account.auth_id.trim().is_empty() && account.auth_id == source_id;
        let same_email = !source_key.is_empty()
            && !account.email.trim().is_empty()
            && normalize_cursor_account_key(&account.email) == source_key;
        if same_index || same_hash || same_auth || same_email {
            account.ignored = ignored;
        }
    }
}

// --- Sync Manifest (per-server sync state) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncManifest {
    pub version: u32,
    pub buckets: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SyncStateFile {
    version: u32,
    #[serde(default)]
    states: HashMap<String, SyncManifest>,
}

fn load_sync_state_file() -> SyncStateFile {
    let path = sync_state_path();
    // Migrate from legacy single-manifest file
    if !path.exists() {
        let legacy = manifest_path();
        if legacy.exists() {
            if let Ok(content) = fs::read_to_string(&legacy) {
                if let Ok(manifest) = serde_json::from_str::<SyncManifest>(&content) {
                    if manifest.version == 1 {
                        let state = SyncStateFile {
                            version: 1,
                            states: HashMap::new(),
                        };
                        // Can't determine URL here; caller must migrate
                        return state;
                    }
                }
            }
        }
        return SyncStateFile::default();
    }
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return SyncStateFile::default(),
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_sync_state_file(state: &SyncStateFile) {
    let path = sync_state_path();
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(state).unwrap_or_default();
    if fs::write(&tmp, format!("{}\n", json)).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
}

pub fn load_sync_manifest_for(api_base_url: &str) -> SyncManifest {
    let url = normalize_api_base_url(api_base_url);
    let state = load_sync_state_file();
    state.states.get(&url).cloned().unwrap_or(SyncManifest {
        version: 1,
        buckets: HashMap::new(),
    })
}

pub fn save_sync_manifest_for(api_base_url: &str, manifest: &SyncManifest) {
    let url = normalize_api_base_url(api_base_url);
    let mut state = load_sync_state_file();
    state.states.insert(url, manifest.clone());
    save_sync_state_file(&state);
}

// Legacy compat: kept for callers that don't have the URL handy
pub fn load_sync_manifest() -> Option<SyncManifest> {
    let state = load_sync_state_file();
    // Return any manifest (for backward compat); callers should migrate to load_sync_manifest_for
    state.states.values().next().cloned()
}

pub fn save_sync_manifest(manifest: &SyncManifest) {
    // Legacy: save to the first URL in state, or discard
    let mut state = load_sync_state_file();
    if let Some(url) = state.states.keys().next().cloned() {
        state.states.insert(url, manifest.clone());
        save_sync_state_file(&state);
    }
}

pub fn clear_sync_manifest() {
    let _ = fs::remove_file(manifest_path());
    let _ = fs::remove_file(sync_state_path());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_home() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("atl-config-test-{}", suffix))
    }

    fn sample_import() -> serde_json::Value {
        serde_json::json!({
            "participantId": "p-imported",
            "nickname": "imported-player",
            "identityPublicKey": "pub-key-imported",
            "identityPrivateKey": "priv-key-imported",
            "deviceId": "d-imported",
            "apiBaseUrl": "https://example.com",
            "language": "en",
            "cursorDashboardUsage": {
                "accounts": [{"accessToken": "secret-at", "refreshToken": "secret-rt", "authId": "auth1"}]
            },
            "providerRoots": {"claude": ["/old/path"]},
            "providerIgnoredAutoSources": {"claude_code_local": ["imported-source"]},
            "providerEnabled": {"claude": true},
            "localBackup": {"enabled": true, "directory": "/imported/backup", "retentionCount": 9}
        })
    }

    #[test]
    fn app_config_accepts_null_sync_status_as_default() {
        let input = serde_json::json!({
            "participantId": "p-test",
            "nickname": "tester",
            "nicknameAutoGenerated": false,
            "identityPublicKey": "pub",
            "identityPrivateKey": "priv",
            "deviceId": "d-test",
            "syncStatus": null
        });
        let config: AppConfig = serde_json::from_value(input).unwrap();
        assert!(config.sync_status.api_base_url.is_empty());
        assert!(config.sync_status.last_status.is_none());
    }

    #[test]
    fn import_config_restore_mode_uses_imported_device_id() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let previous_home = std::env::var("HOME").ok();
        let home = temp_home();
        std::env::set_var("HOME", &home);

        let local = init_config(serde_json::json!({}), true);
        let local_device = local.device_id.clone();
        assert!(!local_device.is_empty());

        let (result, summary) = import_config_with_summary(sample_import(), None).unwrap();
        assert_eq!(result.device_id, "d-imported");
        assert_eq!(result.participant_id, "p-imported");
        assert_eq!(summary["mode"].as_str(), Some("restore_device"));
        assert_eq!(summary["oldDeviceId"].as_str(), Some(local_device.as_str()));
        assert_eq!(summary["newDeviceId"].as_str(), Some("d-imported"));
        assert_eq!(summary["deviceIdChanged"].as_bool(), Some(true));
        assert!(
            result.cursor_dashboard_usage.accounts.is_empty(),
            "restore mode must not import Cursor credentials"
        );

        let _ = fs::remove_dir_all(&home);
        if let Some(v) = previous_home {
            std::env::set_var("HOME", v);
        } else {
            std::env::remove_var("HOME");
        }
    }

    #[test]
    fn import_config_join_mode_preserves_local_device_id() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let previous_home = std::env::var("HOME").ok();
        let home = temp_home();
        std::env::set_var("HOME", &home);

        let mut local = init_config(serde_json::json!({}), true);
        let local_device = local.device_id.clone();
        local.provider_roots.insert(
            "claude_code_local".to_string(),
            vec!["/local/claude".to_string()],
        );
        local.workdir_aliases.insert(
            "local-workdir-hash".to_string(),
            "Local Project".to_string(),
        );
        local
            .provider_ignored_auto_sources
            .insert("codex_local".to_string(), vec!["local-source".to_string()]);
        local.local_backup.directory = "/local/backup".to_string();
        save_config(&local);

        let result = import_config(sample_import(), Some("join_existing_participant")).unwrap();
        assert_eq!(result.participant_id, "p-imported");
        assert_eq!(
            result.device_id, local_device,
            "join mode must preserve local deviceId"
        );
        assert_ne!(
            result.device_id, "d-imported",
            "join mode must not use imported deviceId"
        );
        assert!(
            result.cursor_dashboard_usage.accounts.is_empty(),
            "join mode must not import Cursor accounts"
        );
        assert_eq!(
            result.provider_roots.get("claude_code_local"),
            Some(&vec!["/local/claude".to_string()]),
            "join mode must preserve local provider roots"
        );
        assert!(
            !result
                .provider_roots
                .get("claude")
                .is_some_and(|roots| { roots.contains(&"/old/path".to_string()) }),
            "join mode must not import provider roots from another device"
        );
        assert_eq!(
            result.workdir_aliases.get("local-workdir-hash"),
            Some(&"Local Project".to_string()),
            "join mode must preserve local aliases"
        );
        assert_eq!(
            result.provider_ignored_auto_sources.get("codex_local"),
            Some(&vec!["local-source".to_string()]),
            "join mode must preserve local ignored auto sources"
        );
        assert!(
            !result
                .provider_ignored_auto_sources
                .get("claude_code_local")
                .is_some_and(|sources| sources.contains(&"imported-source".to_string())),
            "join mode must not import ignored auto sources from another device"
        );
        assert_eq!(
            result.local_backup.directory, "/local/backup",
            "join mode must preserve local backup directory"
        );

        let _ = fs::remove_dir_all(&home);
        if let Some(v) = previous_home {
            std::env::set_var("HOME", v);
        } else {
            std::env::remove_var("HOME");
        }
    }

    #[test]
    fn import_config_join_mode_no_existing_config_generates_device_id() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let previous_home = std::env::var("HOME").ok();
        let home = temp_home();
        std::env::set_var("HOME", &home);

        let result = import_config(sample_import(), Some("join_existing_participant")).unwrap();
        assert_eq!(result.participant_id, "p-imported");
        assert!(
            result.device_id.starts_with("d_"),
            "join mode must generate fresh deviceId when no local config exists"
        );
        assert_ne!(result.device_id, "d-imported");

        let _ = fs::remove_dir_all(&home);
        if let Some(v) = previous_home {
            std::env::set_var("HOME", v);
        } else {
            std::env::remove_var("HOME");
        }
    }

    #[test]
    fn import_config_join_mode_clears_local_sync_and_cache_state() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let previous_home = std::env::var("HOME").ok();
        let home = temp_home();
        std::env::set_var("HOME", &home);

        init_config(serde_json::json!({}), true);
        fs::write(manifest_path(), "{}\n").unwrap();
        fs::write(sync_state_path(), "{}\n").unwrap();
        fs::write(queue_path(), "[]\n").unwrap();
        fs::write(usage_cache_path(), "{}\n").unwrap();

        let (_config, summary) =
            import_config_with_summary(sample_import(), Some("join_existing_participant")).unwrap();
        let cleaned = summary["cleanedLocalStateFiles"].as_array().unwrap();
        for key in ["syncManifest", "syncState", "uploadQueue", "usageCache"] {
            assert!(
                cleaned.iter().any(|item| item.as_str() == Some(key)),
                "join mode should report cleaned {}",
                key
            );
        }
        assert!(!manifest_path().exists());
        assert!(!sync_state_path().exists());
        assert!(!queue_path().exists());
        assert!(!usage_cache_path().exists());

        let _ = fs::remove_dir_all(&home);
        if let Some(v) = previous_home {
            std::env::set_var("HOME", v);
        } else {
            std::env::remove_var("HOME");
        }
    }

    #[test]
    fn import_config_rejects_unknown_mode() {
        let err = import_config(sample_import(), Some("unexpected_mode")).unwrap_err();
        assert!(err.contains("Invalid config import mode"));
    }

    #[test]
    fn export_config_omits_cursor_credentials() {
        let mut cfg = init_config(serde_json::json!({}), false);
        cfg.cursor_dashboard_usage.workos_session_token = "legacy-secret".to_string();
        cfg.cursor_dashboard_usage.accounts.push(CursorAccount {
            access_token: "secret-at".to_string(),
            refresh_token: "secret-rt".to_string(),
            auth_id: "auth1".to_string(),
            sub: "sub1".to_string(),
            email: "user@example.com".to_string(),
            account_hash: "hash1".to_string(),
            access_token_expires_at: None,
            last_refresh_at: None,
            auth_status: "active".to_string(),
            ignored: false,
            added_at: None,
        });
        cfg.provider_ignored_auto_sources.insert(
            "cursor_dashboard_usage".to_string(),
            vec!["legacy-source".to_string()],
        );

        let exported = export_config(&cfg);
        let content = serde_json::to_string(&exported).unwrap();
        assert!(!content.contains("secret-at"));
        assert!(!content.contains("secret-rt"));
        assert!(!content.contains("legacy-secret"));
        assert!(!content.contains("cursor_dashboard_usage"));
        assert_eq!(
            exported["cursorDashboardUsage"]["accounts"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }
}
