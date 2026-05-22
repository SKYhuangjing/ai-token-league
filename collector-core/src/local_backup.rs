use crate::config;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

const BACKUP_VERSION: u32 = 1;

struct BackupFile {
    key: &'static str,
    path: PathBuf,
    required_json: bool,
}

fn backup_files() -> Vec<BackupFile> {
    vec![
        BackupFile {
            key: "config",
            path: config::config_path(),
            required_json: true,
        },
        BackupFile {
            key: "usageCache",
            path: config::usage_cache_path(),
            required_json: true,
        },
        BackupFile {
            key: "uploadQueue",
            path: config::queue_path(),
            required_json: true,
        },
        BackupFile {
            key: "syncManifest",
            path: config::manifest_path(),
            required_json: true,
        },
        BackupFile {
            key: "runtimeLog",
            path: config::runtime_log_path(),
            required_json: false,
        },
    ]
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn timestamp_slug() -> String {
    chrono::Utc::now().format("%Y%m%d-%H%M%S-%3f").to_string()
}

fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn remove_cursor_credentials_from_config(mut value: Value) -> Value {
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "cursorDashboardUsage".to_string(),
            serde_json::to_value(config::CursorDashboardUsageConfig::default())
                .unwrap_or_else(|_| json!({})),
        );
        if let Some(ignored) = obj
            .get_mut("providerIgnoredAutoSources")
            .and_then(|v| v.as_object_mut())
        {
            ignored.remove("cursor_dashboard_usage");
        }
    }
    value
}

fn sanitize_backup_entry_content(key: &str, content: &str) -> Result<String, String> {
    if key != "config" {
        return Ok(content.to_string());
    }
    let value: Value = serde_json::from_str(content)
        .map_err(|e| format!("Cannot sanitize config backup: {}", e))?;
    let sanitized = remove_cursor_credentials_from_config(value);
    serde_json::to_string_pretty(&sanitized)
        .map(|content| format!("{}\n", content))
        .map_err(|e| e.to_string())
}

pub fn export_local_backup() -> Result<Value, String> {
    let mut entries = Vec::new();
    let mut missing = Vec::new();

    for item in backup_files() {
        if !item.path.exists() {
            missing.push(item.key);
            continue;
        }
        let content = fs::read_to_string(&item.path)
            .map_err(|e| format!("Cannot read {}: {}", item.key, e))?;
        if item.required_json {
            let _: Value = serde_json::from_str(&content)
                .map_err(|e| format!("Cannot back up invalid JSON file {}: {}", item.key, e))?;
        }
        let content = sanitize_backup_entry_content(item.key, &content)?;
        entries.push(json!({
            "key": item.key,
            "content": content,
            "sha256": sha256_hex(&content),
            "bytes": content.as_bytes().len()
        }));
    }

    Ok(json!({
        "backupVersion": BACKUP_VERSION,
        "createdAt": now_iso(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "scope": "client-local-data",
        "warning": "Sensitive local backup. Contains identity private key and local data. Cursor credentials are not included and must be reconnected after restore.",
        "entries": entries,
        "missing": missing
    }))
}

pub fn default_backup_directory() -> String {
    let base = dirs::home_dir()
        .map(|home| home.join(".ai-token-league"))
        .or_else(dirs::document_dir)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("backup").to_string_lossy().to_string()
}

pub fn backup_status() -> Value {
    let cfg = config::load_config();
    let backup = cfg
        .as_ref()
        .map(|c| c.local_backup.clone())
        .unwrap_or_default();
    let directory = if backup.directory.trim().is_empty() {
        default_backup_directory()
    } else {
        backup.directory.clone()
    };
    json!({
        "enabled": backup.enabled,
        "directory": backup.directory,
        "effectiveDirectory": directory,
        "retentionCount": backup.retention_count,
        "retentionDays": backup.retention_count,
        "lastBackupAt": backup.last_backup_at,
        "backups": list_backups_in_dir(&directory)
    })
}

pub fn create_backup_in_configured_directory(reason: &str) -> Result<Value, String> {
    let mut cfg = config::load_config().ok_or("Not initialized")?;
    let directory = if cfg.local_backup.directory.trim().is_empty() {
        default_backup_directory()
    } else {
        cfg.local_backup.directory.clone()
    };
    create_backup_file(&directory, cfg.local_backup.retention_count, reason, true)?;
    cfg.local_backup.directory = directory.clone();
    cfg.local_backup.last_backup_at = Some(now_iso());
    config::save_config(&cfg);
    Ok(json!({
        "directory": directory,
        "retentionCount": cfg.local_backup.retention_count,
        "retentionDays": cfg.local_backup.retention_count,
        "lastBackupAt": cfg.local_backup.last_backup_at,
        "backups": list_backups_in_dir(&cfg.local_backup.directory)
    }))
}

pub fn run_due_auto_backup() -> Result<Value, String> {
    let cfg = match config::load_config() {
        Some(cfg) => cfg,
        None => return Ok(json!({"ran": false, "reason": "not_initialized"})),
    };
    if !cfg.local_backup.enabled {
        return Ok(json!({"ran": false, "reason": "disabled"}));
    }
    if backed_up_today(cfg.local_backup.last_backup_at.as_deref()) {
        return Ok(json!({"ran": false, "reason": "already_backed_up_today"}));
    }
    let result = create_backup_in_configured_directory("auto")?;
    Ok(json!({"ran": true, "result": result}))
}

pub fn clear_configured_backups() -> Result<Value, String> {
    let cfg = config::load_config().ok_or("Not initialized")?;
    let directory = if cfg.local_backup.directory.trim().is_empty() {
        default_backup_directory()
    } else {
        cfg.local_backup.directory.clone()
    };
    let removed = clear_backups_in_dir(&directory)?;
    Ok(json!({
        "directory": directory,
        "removed": removed,
        "backups": list_backups_in_dir(&directory)
    }))
}

pub fn inspect_backup(backup: &Value) -> Result<Value, String> {
    validate_backup(backup)?;
    let entries = backup["entries"]
        .as_array()
        .ok_or("Invalid backup: entries must be an array")?;
    let mut total_bytes = 0_u64;
    let mut files = Vec::new();
    for entry in entries {
        let key = entry["key"].as_str().unwrap_or("");
        let content = entry["content"].as_str().unwrap_or("");
        let expected_hash = entry["sha256"].as_str().unwrap_or("");
        if sha256_hex(content) != expected_hash {
            return Err(format!("Invalid backup entry {}: sha256 mismatch", key));
        }
        let bytes = entry["bytes"]
            .as_u64()
            .or_else(|| Some(content.as_bytes().len() as u64))
            .unwrap_or(0);
        total_bytes += bytes;
        files.push(json!({"key": key, "bytes": bytes}));
    }
    Ok(json!({
        "backupVersion": backup["backupVersion"],
        "scope": backup["scope"],
        "createdAt": backup["createdAt"],
        "appVersion": backup["appVersion"],
        "platform": backup["platform"],
        "fileCount": entries.len(),
        "totalBytes": total_bytes,
        "files": files
    }))
}

pub fn restore_local_backup(backup: Value) -> Result<Value, String> {
    validate_backup(&backup)?;
    config::ensure_app_dir();

    let restore_snapshot_dir = config::config_path()
        .parent()
        .ok_or("Cannot resolve app data directory")?
        .join(format!(".restore-backup-{}", timestamp_slug()));
    fs::create_dir_all(&restore_snapshot_dir)
        .map_err(|e| format!("Cannot create restore snapshot: {}", e))?;

    let files = backup_files();
    for item in &files {
        if item.path.exists() {
            let snapshot_path = restore_snapshot_dir.join(format!("{}.bak", item.key));
            fs::copy(&item.path, &snapshot_path)
                .map_err(|e| format!("Cannot snapshot current {}: {}", item.key, e))?;
        }
    }

    let mut restored = 0_u64;
    let entries = backup["entries"]
        .as_array()
        .ok_or("Invalid backup: entries must be an array")?;

    for item in &files {
        if let Some(entry) = entries
            .iter()
            .find(|entry| entry["key"].as_str() == Some(item.key))
        {
            let content = entry["content"]
                .as_str()
                .ok_or_else(|| format!("Invalid backup entry {}: missing content", item.key))?;
            let expected_hash = entry["sha256"]
                .as_str()
                .ok_or_else(|| format!("Invalid backup entry {}: missing sha256", item.key))?;
            if sha256_hex(content) != expected_hash {
                return Err(format!(
                    "Invalid backup entry {}: sha256 mismatch",
                    item.key
                ));
            }
            if item.required_json {
                let _: Value = serde_json::from_str(content)
                    .map_err(|e| format!("Invalid backup entry {} JSON: {}", item.key, e))?;
            }
            let content_to_write = sanitize_backup_entry_content(item.key, content)?;
            write_atomic(&item.path, &content_to_write)?;
            restored += 1;
        } else if item.path.exists() {
            fs::remove_file(&item.path)
                .map_err(|e| format!("Cannot remove current {} during restore: {}", item.key, e))?;
        }
    }

    let restored_device_id = backup["entries"]
        .as_array()
        .and_then(|entries| entries.iter().find(|e| e["key"] == "config"))
        .and_then(|entry| entry["content"].as_str())
        .and_then(|content| serde_json::from_str::<serde_json::Value>(content).ok())
        .and_then(|v| v["deviceId"].as_str().map(|s| s.to_string()));

    let mut result = json!({
        "restoreMode": "restore_device",
        "restored": restored,
        "snapshotPath": restore_snapshot_dir.to_string_lossy()
    });
    if let Some(device_id) = restored_device_id {
        result["restoredDeviceId"] = json!(device_id.clone());
        result["deviceId"] = json!(device_id);
    }

    Ok(result)
}

fn validate_backup(backup: &Value) -> Result<(), String> {
    if backup["backupVersion"].as_u64() != Some(BACKUP_VERSION as u64) {
        return Err("Unsupported local backup version".to_string());
    }
    if backup["scope"].as_str() != Some("client-local-data") {
        return Err("Invalid backup scope".to_string());
    }
    let entries = backup["entries"]
        .as_array()
        .ok_or("Invalid backup: entries must be an array")?;
    let allowed: Vec<&str> = backup_files().into_iter().map(|item| item.key).collect();
    for entry in entries {
        let key = entry["key"]
            .as_str()
            .ok_or("Invalid backup entry: missing key")?;
        if !allowed.contains(&key) {
            return Err(format!("Invalid backup entry: unsupported key {}", key));
        }
        if !entry["content"].is_string() || !entry["sha256"].is_string() {
            return Err(format!(
                "Invalid backup entry {}: missing content or sha256",
                key
            ));
        }
    }
    Ok(())
}

fn create_backup_file(
    directory: &str,
    retention_days: u64,
    reason: &str,
    update_retention: bool,
) -> Result<PathBuf, String> {
    let dir = PathBuf::from(directory);
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create backup directory: {}", e))?;
    let mut backup = export_local_backup()?;
    if let Some(obj) = backup.as_object_mut() {
        obj.insert("reason".to_string(), json!(reason));
    }
    let file_name = format!("ai-token-league-backup-{}.json", timestamp_slug());
    let path = dir.join(file_name);
    let content = serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())? + "\n";
    write_atomic(&path, &content)?;
    if update_retention {
        enforce_retention_by_days(&dir, retention_days.max(1))?;
    }
    Ok(path)
}

fn list_backups_in_dir(directory: &str) -> Vec<Value> {
    let dir = PathBuf::from(directory);
    let Ok(read_dir) = fs::read_dir(dir) else {
        return vec![];
    };
    let mut rows = Vec::new();
    for item in read_dir.flatten() {
        let path = item.path();
        if !is_backup_file(&path) {
            continue;
        }
        let Ok(metadata) = item.metadata() else {
            continue;
        };
        let created_at = backup_created_at_from_metadata(&path, &metadata);
        rows.push(json!({
            "fileName": path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string(),
            "filePath": path.to_string_lossy().to_string(),
            "bytes": metadata.len(),
            "createdAt": created_at
        }));
    }
    rows.sort_by(|a, b| {
        b["fileName"]
            .as_str()
            .unwrap_or("")
            .cmp(a["fileName"].as_str().unwrap_or(""))
    });
    rows
}

fn backup_created_at_from_metadata(path: &Path, metadata: &fs::Metadata) -> String {
    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
        return metadata_modified_at(metadata);
    };
    let Some(slug) = name
        .strip_prefix("ai-token-league-backup-")
        .and_then(|value| value.strip_suffix(".json"))
    else {
        return metadata_modified_at(metadata);
    };
    chrono::NaiveDateTime::parse_from_str(slug, "%Y%m%d-%H%M%S-%3f")
        .map(|dt| {
            chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(dt, chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .unwrap_or_else(|_| metadata_modified_at(metadata))
}

fn metadata_modified_at(metadata: &fs::Metadata) -> String {
    metadata
        .modified()
        .ok()
        .map(chrono::DateTime::<chrono::Utc>::from)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn enforce_retention_by_days(directory: &Path, retention_days: u64) -> Result<(), String> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days as i64);
    let backups: Vec<PathBuf> = fs::read_dir(directory)
        .map_err(|e| format!("Cannot list backup directory: {}", e))?
        .flatten()
        .map(|item| item.path())
        .filter(|path| is_backup_file(path))
        .collect();
    for path in backups {
        if backup_is_older_than(&path, cutoff) {
            fs::remove_file(path).map_err(|e| format!("Cannot remove old backup: {}", e))?;
        }
    }
    Ok(())
}

fn clear_backups_in_dir(directory: &str) -> Result<u64, String> {
    let dir = PathBuf::from(directory);
    let Ok(read_dir) = fs::read_dir(&dir) else {
        return Ok(0);
    };
    let mut removed = 0_u64;
    for item in read_dir.flatten() {
        let path = item.path();
        if !is_backup_file(&path) {
            continue;
        }
        fs::remove_file(&path).map_err(|e| format!("Cannot remove backup: {}", e))?;
        removed += 1;
    }
    Ok(removed)
}

fn backup_is_older_than(path: &Path, cutoff: chrono::DateTime<chrono::Utc>) -> bool {
    let created_at = fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .and_then(|backup| backup["createdAt"].as_str().map(|s| s.to_string()));
    let Some(created_at) = created_at else {
        return false;
    };
    chrono::DateTime::parse_from_rfc3339(&created_at)
        .map(|dt| dt.with_timezone(&chrono::Utc) < cutoff)
        .unwrap_or(false)
}

fn is_backup_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    name.starts_with("ai-token-league-backup-") && name.ends_with(".json")
}

fn backed_up_today(last_backup_at: Option<&str>) -> bool {
    let Some(value) = last_backup_at else {
        return false;
    };
    let today = chrono::Local::now().date_naive();
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&chrono::Local).date_naive() == today)
        .unwrap_or(false)
}

fn write_atomic(path: &PathBuf, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Cannot create directory {}: {}",
                parent.to_string_lossy(),
                e
            )
        })?;
    }
    let tmp = path.with_extension("restore.tmp");
    fs::write(&tmp, content).map_err(|e| format!("Cannot write temp file: {}", e))?;
    fs::rename(&tmp, path).map_err(|e| format!("Cannot replace restored file: {}", e))
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
        std::env::temp_dir().join(format!("atl-backup-test-{}", suffix))
    }

    #[test]
    fn backup_and_restore_client_files() {
        let _guard = config::TEST_ENV_LOCK.lock().unwrap();
        let previous_home = std::env::var("HOME").ok();
        let home = temp_home();
        std::env::set_var("HOME", &home);

        config::ensure_app_dir();
        fs::write(
            config::config_path(),
            "{\"participantId\":\"p1\",\"identityPrivateKey\":\"secret\"}\n",
        )
        .unwrap();
        fs::write(config::usage_cache_path(), "{\"rowCount\":1}\n").unwrap();
        fs::write(config::queue_path(), "[]\n").unwrap();
        fs::write(config::manifest_path(), "{\"version\":1,\"buckets\":{}}\n").unwrap();
        fs::create_dir_all(config::runtime_log_dir()).unwrap();
        fs::write(config::runtime_log_path(), "{\"event\":\"scan\"}\n").unwrap();

        let backup = export_local_backup().unwrap();
        assert_eq!(backup["scope"].as_str(), Some("client-local-data"));
        assert_eq!(backup["entries"].as_array().unwrap().len(), 5);

        fs::write(config::config_path(), "{\"participantId\":\"changed\"}\n").unwrap();
        fs::remove_file(config::queue_path()).unwrap();

        let restored = restore_local_backup(backup).unwrap();
        assert_eq!(restored["restored"].as_u64(), Some(5));
        let config_content = fs::read_to_string(config::config_path()).unwrap();
        let queue_content = fs::read_to_string(config::queue_path()).unwrap();
        assert!(config_content.contains("\"p1\""));
        assert_eq!(queue_content, "[]\n");

        let _ = fs::remove_dir_all(&home);
        if let Some(value) = previous_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
    }

    #[test]
    fn backup_and_restore_strip_cursor_credentials() {
        let _guard = config::TEST_ENV_LOCK.lock().unwrap();
        let previous_home = std::env::var("HOME").ok();
        let home = temp_home();
        std::env::set_var("HOME", &home);

        config::ensure_app_dir();
        fs::write(
            config::config_path(),
            serde_json::to_string_pretty(&json!({
                "participantId": "p1",
                "identityPublicKey": "pub",
                "identityPrivateKey": "secret",
                "deviceId": "d-backup",
                "cursorDashboardUsage": {
                    "workosSessionToken": "legacy-secret",
                    "accounts": [{
                        "accessToken": "secret-at",
                        "refreshToken": "secret-rt",
                        "authId": "auth1",
                        "email": "user@example.com"
                    }]
                },
                "providerIgnoredAutoSources": {
                    "cursor_dashboard_usage": ["legacy-source"]
                }
            }))
            .unwrap()
                + "\n",
        )
        .unwrap();

        let backup = export_local_backup().unwrap();
        let config_entry = backup["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["key"] == "config")
            .unwrap();
        let backup_config = config_entry["content"].as_str().unwrap();
        assert!(!backup_config.contains("secret-at"));
        assert!(!backup_config.contains("secret-rt"));
        assert!(!backup_config.contains("legacy-secret"));
        assert!(!backup_config.contains("cursor_dashboard_usage"));

        fs::write(config::config_path(), "{}\n").unwrap();
        let restored = restore_local_backup(backup).unwrap();
        assert_eq!(restored["restoreMode"].as_str(), Some("restore_device"));
        assert_eq!(restored["deviceId"].as_str(), Some("d-backup"));
        assert_eq!(restored["restoredDeviceId"].as_str(), Some("d-backup"));
        let restored_config = fs::read_to_string(config::config_path()).unwrap();
        assert!(!restored_config.contains("secret-at"));
        assert!(!restored_config.contains("secret-rt"));
        assert!(!restored_config.contains("legacy-secret"));
        assert!(restored_config.contains("\"accounts\": []"));

        let _ = fs::remove_dir_all(&home);
        if let Some(value) = previous_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
    }

    #[test]
    fn restore_rejects_hash_mismatch() {
        let _guard = config::TEST_ENV_LOCK.lock().unwrap();
        let previous_home = std::env::var("HOME").ok();
        let home = temp_home();
        std::env::set_var("HOME", &home);
        let backup = json!({
            "backupVersion": BACKUP_VERSION,
            "scope": "client-local-data",
            "entries": [{
                "key": "config",
                "content": "{}\n",
                "sha256": "bad"
            }]
        });
        let err = restore_local_backup(backup).unwrap_err();
        assert!(err.contains("sha256 mismatch"));
        let _ = fs::remove_dir_all(&home);
        if let Some(value) = previous_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
    }

    #[test]
    fn backup_defaults_to_app_backup_dir_and_clears_files() {
        let _guard = config::TEST_ENV_LOCK.lock().unwrap();
        let previous_home = std::env::var("HOME").ok();
        let home = temp_home();
        std::env::set_var("HOME", &home);

        assert_eq!(
            default_backup_directory(),
            home.join(".ai-token-league")
                .join("backup")
                .to_string_lossy()
                .to_string()
        );
        let cfg = config::init_config(json!({}), true);
        assert_eq!(cfg.local_backup.enabled, true);
        let created = create_backup_in_configured_directory("manual").unwrap();
        assert_eq!(created["backups"].as_array().unwrap().len(), 1);
        let cleared = clear_configured_backups().unwrap();
        assert_eq!(cleared["removed"].as_u64(), Some(1));
        assert_eq!(cleared["backups"].as_array().unwrap().len(), 0);

        let _ = fs::remove_dir_all(&home);
        if let Some(value) = previous_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
    }

    #[test]
    fn backup_retention_removes_files_older_than_days() {
        let _guard = config::TEST_ENV_LOCK.lock().unwrap();
        let previous_home = std::env::var("HOME").ok();
        let home = temp_home();
        std::env::set_var("HOME", &home);
        let dir = home.join("backups");
        fs::create_dir_all(&dir).unwrap();
        let old_path = dir.join("ai-token-league-backup-20260501-000000-000.json");
        let recent_path = dir.join("ai-token-league-backup-20260517-000000-000.json");
        fs::write(
            &old_path,
            json!({
                "backupVersion": BACKUP_VERSION,
                "scope": "client-local-data",
                "createdAt": (chrono::Utc::now() - chrono::Duration::days(10)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "entries": []
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            &recent_path,
            json!({
                "backupVersion": BACKUP_VERSION,
                "scope": "client-local-data",
                "createdAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "entries": []
            })
            .to_string(),
        )
        .unwrap();

        enforce_retention_by_days(&dir, 7).unwrap();
        assert!(!old_path.exists());
        assert!(recent_path.exists());

        let _ = fs::remove_dir_all(&home);
        if let Some(value) = previous_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
    }
}
