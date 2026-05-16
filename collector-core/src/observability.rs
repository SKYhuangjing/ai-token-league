use crate::config;
use serde_json::{json, Map, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;

const MAX_RUNTIME_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RUNTIME_LOG_EVENTS: usize = 500;
const REDACTED: &str = "[redacted]";
const PATH_REDACTED: &str = "[path-redacted]";

pub fn append_runtime_event(source: &str, event: &str, level: &str, data: Value) {
    config::ensure_app_dir();
    rotate_runtime_log_if_needed();
    let entry = json!({
        "ts": now_iso(),
        "level": normalize_level(level),
        "source": sanitize_label(source),
        "event": sanitize_label(event),
        "data": sanitize_value(data),
    });
    let path = config::runtime_log_path();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        if let Ok(line) = serde_json::to_string(&entry) {
            let _ = writeln!(file, "{}", line);
        }
    }
}

pub fn read_recent_runtime_events(limit: usize) -> Vec<Value> {
    let path = config::runtime_log_path();
    let Ok(content) = fs::read_to_string(path) else {
        return vec![];
    };
    let mut rows = content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>();
    let max = limit.min(MAX_RUNTIME_LOG_EVENTS);
    if rows.len() > max {
        rows.drain(0..rows.len() - max);
    }
    rows
}

pub fn runtime_log_summary() -> Value {
    let path = config::runtime_log_path();
    let size_bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let events = read_recent_runtime_events(MAX_RUNTIME_LOG_EVENTS);
    let latest_event_at = events
        .last()
        .and_then(|event| event.get("ts"))
        .and_then(|ts| ts.as_str())
        .unwrap_or("");
    json!({
        "path": PATH_REDACTED,
        "exists": path.exists(),
        "sizeBytes": size_bytes,
        "retainedEvents": events.len(),
        "latestEventAt": latest_event_at,
        "maxBytes": MAX_RUNTIME_LOG_BYTES,
        "maxExportEvents": MAX_RUNTIME_LOG_EVENTS
    })
}

pub fn diagnostics_status() -> Value {
    json!({
        "runtimeLog": runtime_log_summary(),
        "retention": {
            "maxBytes": MAX_RUNTIME_LOG_BYTES,
            "maxEvents": MAX_RUNTIME_LOG_EVENTS,
            "exportEvents": MAX_RUNTIME_LOG_EVENTS,
            "strategy": "size_and_recent_events"
        }
    })
}

pub fn clear_runtime_log() -> Value {
    let path = config::runtime_log_path();
    let existed = path.exists();
    let removed = fs::remove_file(&path).is_ok();
    json!({
        "ok": true,
        "existed": existed,
        "removed": removed || !existed,
        "runtimeLog": runtime_log_summary()
    })
}

pub fn summarize_command_args(command: &str, args: &Value) -> Value {
    match command {
        "usage:scan" | "usage:scan-start" => json!({
            "force": args.get("force").and_then(|v| v.as_bool()).unwrap_or(false)
        }),
        "usage:sync" => json!({}),
        "api:check" => json!({
            "hasApiBaseUrl": args.get("apiBaseUrl").and_then(|v| v.as_str()).map(|v| !v.trim().is_empty()).unwrap_or(false)
        }),
        "config:update" => summarize_object_keys(args),
        "config:remove-provider-root" | "providers:add-root" => json!({
            "providerId": args.get("providerId").and_then(|v| v.as_str()).or_else(|| args.get(0).and_then(|v| v.as_str())).unwrap_or("")
        }),
        "cursor:add-token" | "cursor:remove-token" => json!({
            "accountName": args.get("accountName").and_then(|v| v.as_str()).unwrap_or("")
        }),
        "workdirs:set-alias" => json!({
            "hasWorkdirHash": args.get("workdirHash").and_then(|v| v.as_str()).map(|v| !v.is_empty()).unwrap_or(false),
            "hasAlias": args.get("alias").and_then(|v| v.as_str()).map(|v| !v.trim().is_empty()).unwrap_or(false)
        }),
        "runtime:log" => json!({}),
        _ => summarize_object_keys(args),
    }
}

pub fn summarize_command_result(command: &str, result: &Result<Value, String>) -> Value {
    match result {
        Ok(value) => match command {
            "usage:scan" => json!({
                "rowCount": value.get("rowCount").and_then(|v| v.as_u64()).unwrap_or(0),
                "healthCount": value.get("health").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0),
                "fromCache": value.get("fromCache").and_then(|v| v.as_bool()).unwrap_or(false)
            }),
            "usage:scan-start" | "usage:scan-status" => {
                let snapshot = value.get("snapshot").unwrap_or(&Value::Null);
                json!({
                    "running": value.get("running").and_then(|v| v.as_bool()).unwrap_or(false),
                    "syncRunning": value.get("syncRunning").and_then(|v| v.as_bool()).unwrap_or(false),
                    "rowCount": snapshot.get("rowCount").and_then(|v| v.as_u64()).unwrap_or(0),
                    "hasError": value.get("error").map(|v| !v.is_null()).unwrap_or(false),
                    "hasSyncError": value.get("syncError").map(|v| !v.is_null()).unwrap_or(false)
                })
            }
            "usage:sync" => json!({
                "accepted": value.get("accepted").and_then(|v| v.as_u64()).unwrap_or(0),
                "rejected": value.get("rejected").and_then(|v| v.as_u64()).unwrap_or(0),
                "bucketCount": value.get("bucketCount").and_then(|v| v.as_u64()).unwrap_or(0),
                "queuePending": value.get("queuePending").and_then(|v| v.as_u64()).unwrap_or(0)
            }),
            "providers:health" => json!({
                "providerCount": value.as_array().map(|v| v.len()).unwrap_or(0)
            }),
            _ => summarize_object_keys(value),
        },
        Err(error) => json!({
            "error": truncate(error, 500)
        }),
    }
}

pub fn sanitize_value(value: Value) -> Value {
    sanitize_value_with_key("", value)
}

fn sanitize_value_with_key(key: &str, value: Value) -> Value {
    if is_secret_key(key) {
        return json!(REDACTED);
    }
    if is_path_key(key) {
        return sanitize_path_value(value);
    }
    match value {
        Value::Object(obj) => {
            let mut next = Map::new();
            for (k, v) in obj {
                next.insert(k.clone(), sanitize_value_with_key(&k, v));
            }
            Value::Object(next)
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .take(200)
                .map(|item| sanitize_value_with_key(key, item))
                .collect(),
        ),
        Value::String(text) => json!(truncate(&text, 1000)),
        other => other,
    }
}

fn sanitize_path_value(value: Value) -> Value {
    match value {
        Value::String(text) if looks_like_path(&text) => json!(PATH_REDACTED),
        Value::Array(items) => Value::Array(items.into_iter().map(sanitize_path_value).collect()),
        Value::Object(obj) => {
            let mut next = Map::new();
            for (k, v) in obj {
                next.insert(k, sanitize_path_value(v));
            }
            Value::Object(next)
        }
        other => other,
    }
}

fn summarize_object_keys(value: &Value) -> Value {
    if let Some(obj) = value.as_object() {
        let mut keys = obj.keys().cloned().collect::<Vec<_>>();
        keys.sort();
        return json!({ "keys": keys });
    }
    if let Some(items) = value.as_array() {
        return json!({ "arrayLength": items.len() });
    }
    json!({ "type": value_type(value) })
}

fn value_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn rotate_runtime_log_if_needed() {
    let path = config::runtime_log_path();
    let Ok(meta) = fs::metadata(&path) else {
        return;
    };
    if meta.len() <= MAX_RUNTIME_LOG_BYTES {
        return;
    }
    let Ok(content) = fs::read_to_string(&path) else {
        let _ = fs::remove_file(&path);
        return;
    };
    let mut lines = content.lines().collect::<Vec<_>>();
    if lines.len() > MAX_RUNTIME_LOG_EVENTS {
        lines.drain(0..lines.len() - MAX_RUNTIME_LOG_EVENTS);
    }
    let _ = fs::write(path, format!("{}\n", lines.join("\n")));
}

fn is_secret_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("privatekey")
        || normalized.contains("signature")
        || normalized == "identityprivatekey"
        || normalized == "workossessiontoken"
}

fn is_path_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    normalized == "path"
        || normalized.ends_with("path")
        || normalized.contains("filepath")
        || normalized.contains("root")
        || normalized.contains("directory")
}

fn looks_like_path(text: &str) -> bool {
    text.starts_with('/')
        || text.starts_with("~/")
        || text.contains(":\\")
        || text.contains("\\Users\\")
        || text.contains("/Users/")
}

fn sanitize_label(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-' | '.'))
        .take(80)
        .collect()
}

fn normalize_level(level: &str) -> &str {
    match level {
        "debug" | "info" | "warn" | "error" => level,
        _ => "info",
    }
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_string()
    } else {
        format!("{}...", value.chars().take(max).collect::<String>())
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
