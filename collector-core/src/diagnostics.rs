use crate::config::AppConfig;
use serde_json::{json, Value};
use std::fs;

const DIAGNOSTICS_RUNTIME_LOG_LIMIT: usize = 500;

pub fn export_diagnostics(config: &AppConfig) -> Value {
    let usage_cache = read_usage_cache_summary();
    let upload_queue = read_upload_queue_summary();
    let sync_manifest =
        read_json_file(crate::config::manifest_path()).unwrap_or_else(|| json!(null));
    let sync_state =
        read_json_file(crate::config::sync_state_path()).unwrap_or_else(|| json!(null));
    let runtime_log =
        crate::observability::read_recent_runtime_events(DIAGNOSTICS_RUNTIME_LOG_LIMIT);
    json!({
        "exportedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "config": sanitize_config(config),
        "usageCache": usage_cache,
        "uploadQueue": upload_queue,
        "syncManifest": sync_manifest,
        "syncState": sync_state,
        "runtimeLogSummary": crate::observability::runtime_log_summary(),
        "runtimeLog": runtime_log,
        "runtimeLogLimit": DIAGNOSTICS_RUNTIME_LOG_LIMIT
    })
}

fn sanitize_config(config: &AppConfig) -> Value {
    let mut value = serde_json::to_value(config).unwrap_or_default();
    if let Some(obj) = value.as_object_mut() {
        obj.remove("identityPrivateKey");
        obj.remove("workosSessionToken");
        if let Some(cursor) = obj
            .get_mut("cursorDashboardUsage")
            .and_then(|v| v.as_object_mut())
        {
            cursor.insert("workosSessionToken".to_string(), json!("[redacted]"));
            if let Some(tokens) = cursor
                .get_mut("workosSessionTokens")
                .and_then(|v| v.as_array_mut())
            {
                for token in tokens {
                    if let Some(token_obj) = token.as_object_mut() {
                        token_obj.insert("token".to_string(), json!("[redacted]"));
                    }
                }
            }
            if let Some(accounts) = cursor.get_mut("accounts").and_then(|v| v.as_array_mut()) {
                for account in accounts {
                    if let Some(acc) = account.as_object_mut() {
                        acc.insert("accessToken".to_string(), json!("[redacted]"));
                        acc.insert("refreshToken".to_string(), json!("[redacted]"));
                        if let Some(email) = acc.get("email").and_then(|v| v.as_str()) {
                            let at_idx = email.find('@').unwrap_or(email.len());
                            if at_idx > 0 {
                                let masked = format!("{}***{}", &email[..1], &email[at_idx..]);
                                acc.insert("email".to_string(), json!(masked));
                            }
                        }
                    }
                }
            }
        }
        if let Some(provider_roots) = obj.get_mut("providerRoots") {
            *provider_roots = json!("[path-redacted]");
        }
    }
    value
}

fn read_json_file(path: std::path::PathBuf) -> Option<Value> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn read_usage_cache_summary() -> Value {
    let path = crate::config::usage_cache_path();
    let size_bytes = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    let Some(raw) = read_json_file(path) else {
        return json!({
            "exists": false,
            "sizeBytes": size_bytes
        });
    };
    let row_count = raw
        .get("rowCount")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            raw.get("items")
                .and_then(|v| v.as_array())
                .map(|items| items.len() as u64)
        })
        .unwrap_or(0);
    json!({
        "exists": true,
        "sizeBytes": size_bytes,
        "cacheVersion": raw.get("cacheVersion").cloned().unwrap_or(Value::Null),
        "rowCount": row_count,
        "scannedAt": raw.get("scannedAt").cloned().unwrap_or(Value::Null),
        "sourceFingerprint": raw.get("sourceFingerprint").cloned().unwrap_or(Value::Null),
        "usageSourceConfigFingerprint": raw.get("usageSourceConfigFingerprint").cloned().unwrap_or(Value::Null)
    })
}

fn read_upload_queue_summary() -> Value {
    let raw = read_json_file(crate::config::queue_path()).unwrap_or_else(|| json!({"items": []}));
    let items = raw
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_else(|| raw.as_array().cloned().unwrap_or_default());
    let summarized = items
        .iter()
        .map(|item| {
            json!({
                "id": item.get("id").cloned().unwrap_or(Value::Null),
                "payloadHash": item.get("payloadHash").cloned().unwrap_or(Value::Null),
                "createdAt": item.get("createdAt").cloned().unwrap_or(Value::Null),
                "attempts": item.get("attempts").cloned().unwrap_or(Value::Null),
                "lastAttemptAt": item.get("lastAttemptAt").cloned().unwrap_or(Value::Null),
                "lastError": item.get("lastError").cloned().unwrap_or(Value::Null),
                "payloadSummary": summarize_payload(item.get("payload").unwrap_or(&Value::Null))
            })
        })
        .collect::<Vec<_>>();
    json!({
        "pending": summarized.len(),
        "items": summarized
    })
}

fn summarize_payload(payload: &Value) -> Value {
    let items = payload
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let total_tokens: i64 = items
        .iter()
        .map(|item| {
            item.get("totalTokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
        })
        .sum();
    json!({
        "clientGeneratedAt": payload.get("clientGeneratedAt").cloned().unwrap_or(Value::Null),
        "snapshot": payload.get("snapshot").cloned().unwrap_or(Value::Null),
        "itemCount": items.len(),
        "totalTokens": total_tokens
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{self, CursorAccount};
    use std::collections::HashMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_home() -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("atl-diagnostics-test-{}", suffix))
    }

    fn make_config() -> AppConfig {
        AppConfig {
            participant_id: "p_diag_test".into(),
            nickname: "test".into(),
            nickname_auto_generated: false,
            identity_public_key: "pk_test".into(),
            identity_private_key: "sk_test".into(),
            device_id: "d_diag_test".into(),
            api_base_url: String::new(),
            language: String::new(),
            theme: "light".into(),
            show_estimated_cost: false,
            show_raw_tokens: false,
            auto_refresh_enabled: true,
            silent_update_mode: "download".into(),
            refresh_interval_minutes: 15,
            launch_at_login: false,
            hide_dock_icon: false,
            desktop_auto_initialized: false,
            cursor_dashboard_usage: Default::default(),
            local_backup: Default::default(),
            runtime_log_retention_days: 3,
            share_card_orientation: "landscape".into(),
            show_share_cloud_url: true,
            show_share_polaroid_frame: true,
            show_share_anonymous_name: true,
            api_connection: Value::Null,
            sync_status: crate::config::SyncStatusRecord::default(),
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

    #[test]
    fn test_sanitize_config_removes_private_key() {
        let mut cfg = make_config();
        cfg.identity_private_key = "super-secret-key".into();
        let sanitized = sanitize_config(&cfg);
        assert!(
            sanitized.get("identityPrivateKey").is_none(),
            "private key must be removed"
        );
    }

    #[test]
    fn test_sanitize_config_removes_legacy_session_token() {
        let mut cfg = make_config();
        cfg.cursor_dashboard_usage.workos_session_token = "legacy-token".into();
        let sanitized = sanitize_config(&cfg);
        let cursor = sanitized.get("cursorDashboardUsage").unwrap();
        assert_eq!(cursor["workosSessionToken"], "[redacted]");
    }

    #[test]
    fn test_sanitize_config_redacts_cursor_tokens() {
        let mut cfg = make_config();
        cfg.cursor_dashboard_usage.workos_session_tokens = vec![config::CursorTokenRecord {
            account_name: "test".into(),
            token: "secret-token-value".into(),
            added_at: None,
        }];
        let sanitized = sanitize_config(&cfg);
        let tokens = sanitized["cursorDashboardUsage"]["workosSessionTokens"]
            .as_array()
            .unwrap();
        assert_eq!(tokens[0]["token"], "[redacted]");
    }

    #[test]
    fn test_sanitize_config_redacts_cursor_account_credentials() {
        let mut cfg = make_config();
        cfg.cursor_dashboard_usage.accounts = vec![CursorAccount {
            access_token: "at-secret".into(),
            refresh_token: "rt-secret".into(),
            auth_id: "auth1".into(),
            sub: "user123".into(),
            email: "user@example.com".into(),
            account_hash: "hash1".into(),
            access_token_expires_at: None,
            last_refresh_at: None,
            auth_status: "active".into(),
            ignored: false,
            added_at: None,
        }];
        let sanitized = sanitize_config(&cfg);
        let accounts = sanitized["cursorDashboardUsage"]["accounts"]
            .as_array()
            .unwrap();
        assert_eq!(accounts[0]["accessToken"], "[redacted]");
        assert_eq!(accounts[0]["refreshToken"], "[redacted]");
        let email = accounts[0]["email"].as_str().unwrap();
        assert!(email.contains("***"));
        assert!(email.contains("@example.com"));
    }

    #[test]
    fn test_sanitize_config_masks_email_preserves_domain() {
        let mut cfg = make_config();
        cfg.cursor_dashboard_usage.accounts = vec![CursorAccount {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            auth_id: "a".into(),
            sub: String::new(),
            email: "alice@corp.io".into(),
            account_hash: String::new(),
            access_token_expires_at: None,
            last_refresh_at: None,
            auth_status: "active".into(),
            ignored: false,
            added_at: None,
        }];
        let sanitized = sanitize_config(&cfg);
        let email = sanitized["cursorDashboardUsage"]["accounts"][0]["email"]
            .as_str()
            .unwrap();
        assert_eq!(email, "a***@corp.io");
    }

    #[test]
    fn test_sanitize_config_redacts_provider_roots() {
        let mut cfg = make_config();
        let mut roots = HashMap::new();
        roots.insert("codex_local".into(), vec!["/home/user/codex".into()]);
        roots.insert(
            "claude_code_local".into(),
            vec!["/Users/dev/projects".into()],
        );
        cfg.provider_roots = roots;
        let sanitized = sanitize_config(&cfg);
        assert_eq!(sanitized["providerRoots"], "[path-redacted]");
    }

    #[test]
    fn test_summarize_payload_with_items() {
        let payload = json!({
            "clientGeneratedAt": "2026-05-22T00:00:00Z",
            "snapshot": {"mode": "hourly"},
            "items": [
                {"totalTokens": 100},
                {"totalTokens": 200},
            ]
        });
        let summary = summarize_payload(&payload);
        assert_eq!(summary["itemCount"], 2);
        assert_eq!(summary["totalTokens"], 300);
        assert_eq!(summary["clientGeneratedAt"], "2026-05-22T00:00:00Z");
    }

    #[test]
    fn test_summarize_payload_empty() {
        let summary = summarize_payload(&json!({}));
        assert_eq!(summary["itemCount"], 0);
        assert_eq!(summary["totalTokens"], 0);
    }

    #[test]
    fn test_export_diagnostics_structure() {
        let _guard = config::TEST_ENV_LOCK.lock().unwrap();
        let previous_home = std::env::var("HOME").ok();
        let home = temp_home();
        std::env::set_var("HOME", &home);
        config::ensure_app_dir();
        fs::write(
            config::sync_state_path(),
            r#"{"version":1,"states":{"https://example.test":{"version":1,"buckets":{}}}}"#,
        )
        .unwrap();

        let cfg = make_config();
        let diag = export_diagnostics(&cfg);

        assert!(diag["exportedAt"].is_string());
        assert!(diag["appVersion"].is_string());
        assert!(diag["platform"].is_string());
        assert!(diag["arch"].is_string());
        assert!(diag["config"].is_object());
        assert!(diag["usageCache"].is_object());
        assert!(diag["uploadQueue"].is_object());
        assert!(diag["syncState"].is_object());
        assert!(diag["syncState"]["states"]["https://example.test"].is_object());
        assert!(diag["runtimeLogSummary"].is_object());

        let _ = fs::remove_dir_all(&home);
        if let Some(value) = previous_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
    }
}
