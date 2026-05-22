use crate::config::AppConfig;
use serde_json::{json, Value};
use std::fs;

const DIAGNOSTICS_RUNTIME_LOG_LIMIT: usize = 500;

pub fn export_diagnostics(config: &AppConfig) -> Value {
    let usage_cache = read_usage_cache_summary();
    let upload_queue = read_upload_queue_summary();
    let sync_manifest =
        read_json_file(crate::config::manifest_path()).unwrap_or_else(|| json!(null));
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
