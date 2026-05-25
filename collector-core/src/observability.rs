use crate::config;
use serde_json::{json, Map, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

const DEFAULT_RUNTIME_LOG_RETENTION_DAYS: u64 = 3;
const REDACTED: &str = "[redacted]";
const PATH_REDACTED: &str = "[path-redacted]";

pub fn append_runtime_event(source: &str, event: &str, level: &str, data: Value) {
    config::ensure_app_dir();
    migrate_legacy_runtime_log();
    prune_runtime_log_by_days(runtime_log_retention_days());
    let entry = json!({
        "ts": now_iso(),
        "level": normalize_level(level),
        "source": sanitize_label(source),
        "event": sanitize_label(event),
        "data": sanitize_value(data),
    });
    let _ = fs::create_dir_all(config::runtime_log_dir());
    let path = config::runtime_log_path();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", format_log_line(&entry));
    }
}

pub fn read_recent_runtime_events(limit: usize) -> Vec<Value> {
    migrate_legacy_runtime_log();
    prune_runtime_log_by_days(runtime_log_retention_days());
    let mut rows = runtime_log_files()
        .into_iter()
        .filter_map(|path| fs::read_to_string(path).ok())
        .flat_map(|content| {
            content
                .lines()
                .filter_map(parse_log_line)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        a.get("ts")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(b.get("ts").and_then(|v| v.as_str()).unwrap_or(""))
    });
    if rows.len() > limit {
        rows.drain(0..rows.len() - limit);
    }
    rows
}

pub fn runtime_log_summary() -> Value {
    let retention_days = runtime_log_retention_days();
    migrate_legacy_runtime_log();
    prune_runtime_log_by_days(retention_days);
    let files = runtime_log_files();
    let size_bytes = files
        .iter()
        .filter_map(|path| fs::metadata(path).ok())
        .map(|m| m.len())
        .sum::<u64>();
    let mut retained_events = 0usize;
    let mut latest_event_at = String::new();
    for path in &files {
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        for line in content.lines() {
            retained_events += 1;
            if let Some(ts) = parse_log_line(line).and_then(|event| {
                event
                    .get("ts")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string())
            }) {
                if ts > latest_event_at {
                    latest_event_at = ts;
                }
            }
        }
    }
    json!({
        "path": PATH_REDACTED,
        "exists": !files.is_empty(),
        "sizeBytes": size_bytes,
        "retainedEvents": retained_events,
        "latestEventAt": latest_event_at,
        "retentionDays": retention_days
    })
}

pub fn diagnostics_status() -> Value {
    let retention_days = runtime_log_retention_days();
    json!({
        "runtimeLog": runtime_log_summary(),
        "retention": {
            "days": retention_days,
            "strategy": "days"
        }
    })
}

pub fn clear_runtime_log() -> Value {
    let files = runtime_log_files();
    let existed = !files.is_empty();
    let mut removed_all = true;
    for path in files {
        if fs::remove_file(&path).is_err() {
            removed_all = false;
        }
    }
    json!({
        "ok": true,
        "existed": existed,
        "removed": removed_all || !existed,
        "runtimeLog": runtime_log_summary()
    })
}

pub fn summarize_command_args(command: &str, args: &Value) -> Value {
    match command {
        "usage:scan" | "usage:scan-start" => json!({
            "force": args.get("force").and_then(|v| v.as_bool()).unwrap_or(false)
        }),
        "usage:summary"
        | "usage:trend"
        | "usage:workdirs"
        | "usage:detail-page"
        | "usage:detail-window" => json!({
            "range": args.get("range").and_then(|v| v.as_str()).unwrap_or("today"),
            "grain": args.get("grain").and_then(|v| v.as_str()).unwrap_or(""),
            "limit": args.get("limit").and_then(|v| v.as_i64()).unwrap_or(0)
        }),
        "usage:sync" | "usage:sync-start" => json!({}),
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
            "usage:summary" => json!({
                "rows": value.get("totals").and_then(|v| v.get("rows")).and_then(|v| v.as_u64()).unwrap_or(0),
                "totalTokens": value.get("totals").and_then(|v| v.get("totalTokens")).and_then(|v| v.as_u64()).unwrap_or(0)
            }),
            "usage:trend" | "usage:workdirs" | "usage:detail-page" | "usage:detail-window" => {
                json!({
                    "rowCount": value.get("items").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0),
                    "totalRows": value.get("totalRows").and_then(|v| v.as_u64()).unwrap_or(0)
                })
            }
            "usage:sync" => json!({
                "accepted": value.get("accepted").and_then(|v| v.as_u64()).unwrap_or(0),
                "rejected": value.get("rejected").and_then(|v| v.as_u64()).unwrap_or(0),
                "bucketCount": value.get("bucketCount").and_then(|v| v.as_u64()).unwrap_or(0),
                "queuePending": value.get("queuePending").and_then(|v| v.as_u64()).unwrap_or(0),
                "queueAttempted": value.get("queueAttempted").and_then(|v| v.as_u64()).unwrap_or(0),
                "queueUploaded": value.get("queueUploaded").and_then(|v| v.as_u64()).unwrap_or(0),
                "queueFailed": value.get("queueFailed").and_then(|v| v.as_u64()).unwrap_or(0),
                "newFailedBucketCount": value.get("newFailedBucketCount").and_then(|v| v.as_u64()).unwrap_or(0)
            }),
            "usage:sync-start" => json!({
                "running": value.get("running").and_then(|v| v.as_bool()).unwrap_or(false),
                "started": value.get("started").and_then(|v| v.as_bool()).unwrap_or(false)
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

fn runtime_log_retention_days() -> u64 {
    config::load_config()
        .map(|cfg| cfg.runtime_log_retention_days.clamp(1, 30))
        .unwrap_or(DEFAULT_RUNTIME_LOG_RETENTION_DAYS)
}

fn prune_runtime_log_by_days(retention_days: u64) {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days as i64);
    for path in runtime_log_files() {
        let Some(file_day) = runtime_log_file_day(&path) else {
            prune_runtime_log_file_content(&path, cutoff);
            continue;
        };
        if file_day < cutoff.date_naive() {
            let _ = fs::remove_file(path);
        } else {
            prune_runtime_log_file_content(&path, cutoff);
        }
    }
}

fn prune_runtime_log_file_content(path: &PathBuf, cutoff: chrono::DateTime<chrono::Utc>) {
    let Ok(content) = fs::read_to_string(path) else {
        let _ = fs::remove_file(path);
        return;
    };
    let retained = content
        .lines()
        .filter(|line| runtime_event_is_recent(line, cutoff))
        .collect::<Vec<_>>();
    if retained.len() != content.lines().count() {
        let next = if retained.is_empty() {
            String::new()
        } else {
            format!("{}\n", retained.join("\n"))
        };
        let _ = fs::write(path, next);
    }
}

fn runtime_event_is_recent(line: &str, cutoff: chrono::DateTime<chrono::Utc>) -> bool {
    let Some(value) = parse_log_line(line) else {
        return false;
    };
    let Some(ts) = value.get("ts").and_then(|v| v.as_str()) else {
        return true;
    };
    chrono::DateTime::parse_from_rfc3339(ts)
        .map(|dt| dt.with_timezone(&chrono::Utc) >= cutoff)
        .unwrap_or(true)
}

fn runtime_log_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Ok(read_dir) = fs::read_dir(config::runtime_log_dir()) {
        for item in read_dir.flatten() {
            let path = item.path();
            if is_runtime_log_file(&path) {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

fn migrate_legacy_runtime_log() {
    let legacy = config::legacy_runtime_log_path();
    if !legacy.exists() {
        return;
    }
    let Ok(content) = fs::read_to_string(&legacy) else {
        let _ = fs::remove_file(&legacy);
        return;
    };
    let _ = fs::create_dir_all(config::runtime_log_dir());
    for line in content.lines() {
        let Some(entry) = parse_log_line(line) else {
            continue;
        };
        let path = runtime_log_path_for_entry(&entry);
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{}", format_log_line(&entry));
        }
    }
    let _ = fs::remove_file(legacy);
}

fn runtime_log_path_for_entry(entry: &Value) -> PathBuf {
    let day = entry
        .get("ts")
        .and_then(|v| v.as_str())
        .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
        .map(|dt| {
            dt.with_timezone(&chrono::Utc)
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%d").to_string());
    config::runtime_log_dir().join(format!("runtime.{}.log", day))
}

fn is_runtime_log_file(path: &PathBuf) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(|name| {
            name.starts_with("runtime.")
                && name.ends_with(".log")
                && name.len() == "runtime.2026-05-17.log".len()
        })
        .unwrap_or(false)
}

fn runtime_log_file_day(path: &PathBuf) -> Option<chrono::NaiveDate> {
    let name = path.file_name()?.to_str()?;
    if !name.starts_with("runtime.") || !name.ends_with(".log") {
        return None;
    }
    let day = name.trim_start_matches("runtime.").trim_end_matches(".log");
    chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()
}

fn format_log_line(entry: &Value) -> String {
    let ts = entry.get("ts").and_then(|v| v.as_str()).unwrap_or("");
    let level = entry
        .get("level")
        .and_then(|v| v.as_str())
        .unwrap_or("info");
    let source = entry.get("source").and_then(|v| v.as_str()).unwrap_or("");
    let event = entry.get("event").and_then(|v| v.as_str()).unwrap_or("");
    let data = entry.get("data").cloned().unwrap_or_else(|| json!({}));
    let data_text = serde_json::to_string(&data).unwrap_or_else(|_| "{}".to_string());
    format!(
        "{} {} [{}] {} {}",
        ts,
        level.to_ascii_uppercase(),
        source,
        event,
        data_text
    )
}

fn parse_log_line(line: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(line) {
        return Some(value);
    }
    let mut parts = line.splitn(5, ' ');
    let ts = parts.next()?.trim();
    let level = parts.next()?.trim().to_ascii_lowercase();
    let source_wrapped = parts.next()?.trim();
    let event = parts.next()?.trim();
    let data_text = parts.next().unwrap_or("{}").trim();
    let source = source_wrapped
        .strip_prefix('[')
        .and_then(|v| v.strip_suffix(']'))
        .unwrap_or(source_wrapped);
    let data =
        serde_json::from_str::<Value>(data_text).unwrap_or_else(|_| json!({"message": data_text}));
    Some(json!({
        "ts": ts,
        "level": level,
        "source": source,
        "event": event,
        "data": data
    }))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_home() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("atl-runtime-log-test-{}", suffix))
    }

    #[test]
    fn runtime_log_retention_prunes_by_days_only() {
        let _guard = config::TEST_ENV_LOCK.lock().unwrap();
        let previous_home = std::env::var("HOME").ok();
        let home = temp_home();
        std::env::set_var("HOME", &home);
        config::ensure_app_dir();
        fs::create_dir_all(config::runtime_log_dir()).unwrap();

        let old_ts = (chrono::Utc::now() - chrono::Duration::days(5))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let recent_ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        fs::write(
            config::runtime_log_path(),
            format!(
                "{{\"ts\":\"{}\",\"event\":\"old\"}}\n{{\"ts\":\"{}\",\"event\":\"recent\"}}\n",
                old_ts, recent_ts
            ),
        )
        .unwrap();

        let events = read_recent_runtime_events(usize::MAX);
        assert!(events
            .iter()
            .any(|event| event["event"].as_str() == Some("recent")));
        assert!(!events
            .iter()
            .any(|event| event["event"].as_str() == Some("old")));
        let summary = runtime_log_summary();
        assert_eq!(summary["retentionDays"].as_u64(), Some(3));
        assert!(config::runtime_log_path()
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .ends_with(".log"));
        assert!(summary["maxBytes"].is_null());
        assert!(summary["maxExportEvents"].is_null());

        let _ = fs::remove_dir_all(&home);
        if let Some(value) = previous_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
    }

    // ── sanitize_value tests ──

    #[test]
    fn sanitize_value_redacts_secret_keys() {
        let input = json!({
            "accessToken": "secret-at",
            "refreshToken": "secret-rt",
            "password": "hunter2",
            "identityPrivateKey": "pk-xyz",
            "normalField": "hello"
        });
        let output = sanitize_value(input);
        assert_eq!(output["accessToken"], REDACTED);
        assert_eq!(output["refreshToken"], REDACTED);
        assert_eq!(output["password"], REDACTED);
        assert_eq!(output["identityPrivateKey"], REDACTED);
        assert_eq!(output["normalField"], "hello");
    }

    #[test]
    fn sanitize_value_redacts_path_keys() {
        let input = json!({
            "path": "/Users/sky/secret-project",
            "configPath": "/home/user/.config",
            "root": "/opt/data",
            "directory": "/tmp/work",
            "name": "normal"
        });
        let output = sanitize_value(input);
        assert_eq!(output["path"], PATH_REDACTED);
        assert_eq!(output["configPath"], PATH_REDACTED);
        assert_eq!(output["root"], PATH_REDACTED);
        assert_eq!(output["directory"], PATH_REDACTED);
        assert_eq!(output["name"], "normal");
    }

    #[test]
    fn sanitize_value_truncates_long_strings() {
        let long = "x".repeat(2000);
        let input = json!({ "message": long });
        let output = sanitize_value(input);
        let result = output["message"].as_str().unwrap();
        assert!(result.len() < 2000);
        assert!(result.ends_with("..."));
    }

    #[test]
    fn sanitize_value_handles_nested_structures() {
        let input = json!({
            "outer": {
                "innerToken": "secret",
                "data": [1, 2, 3]
            }
        });
        let output = sanitize_value(input);
        assert_eq!(output["outer"]["innerToken"], REDACTED);
        assert_eq!(output["outer"]["data"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn sanitize_value_limits_array_to_200() {
        let items: Vec<Value> = (0..300).map(|i| json!(i)).collect();
        let input = json!({ "items": items });
        let output = sanitize_value(input);
        assert_eq!(output["items"].as_array().unwrap().len(), 200);
    }

    #[test]
    fn sanitize_value_primitives_unchanged() {
        assert_eq!(sanitize_value(json!(42)), json!(42));
        assert_eq!(sanitize_value(json!(true)), json!(true));
        assert_eq!(sanitize_value(json!(null)), json!(null));
    }

    // ── summarize_command_args tests ──

    #[test]
    fn summarize_args_usage_scan() {
        let result = summarize_command_args("usage:scan", &json!({"force": true}));
        assert_eq!(result["force"], true);
    }

    #[test]
    fn summarize_args_usage_summary() {
        let result = summarize_command_args("usage:summary", &json!({"range": "7d"}));
        assert_eq!(result["range"], "7d");
    }

    #[test]
    fn summarize_args_api_check() {
        let result =
            summarize_command_args("api:check", &json!({"apiBaseUrl": "https://example.com"}));
        assert_eq!(result["hasApiBaseUrl"], true);

        let result = summarize_command_args("api:check", &json!({"apiBaseUrl": ""}));
        assert_eq!(result["hasApiBaseUrl"], false);
    }

    #[test]
    fn summarize_args_config_update() {
        let result = summarize_command_args(
            "config:update",
            &json!({"nickname": "test", "scanInterval": 30}),
        );
        let keys = result["keys"].as_array().unwrap();
        assert!(keys.iter().any(|k| k.as_str() == Some("nickname")));
        assert!(keys.iter().any(|k| k.as_str() == Some("scanInterval")));
    }

    #[test]
    fn summarize_args_cursor_token() {
        let result = summarize_command_args("cursor:add-token", &json!({"accountName": "work"}));
        assert_eq!(result["accountName"], "work");
    }

    #[test]
    fn summarize_args_workdirs_alias() {
        let result = summarize_command_args(
            "workdirs:set-alias",
            &json!({"workdirHash": "h1", "alias": "my-project"}),
        );
        assert_eq!(result["hasWorkdirHash"], true);
        assert_eq!(result["hasAlias"], true);

        let result = summarize_command_args(
            "workdirs:set-alias",
            &json!({"workdirHash": "", "alias": "  "}),
        );
        assert_eq!(result["hasWorkdirHash"], false);
        assert_eq!(result["hasAlias"], false);
    }

    // ── summarize_command_result tests ──

    #[test]
    fn summarize_result_usage_scan() {
        let result = summarize_command_result(
            "usage:scan",
            &Ok(json!({
                "rowCount": 5, "health": [{}], "fromCache": false
            })),
        );
        assert_eq!(result["rowCount"], 5);
        assert_eq!(result["healthCount"], 1);
        assert_eq!(result["fromCache"], false);
    }

    #[test]
    fn summarize_result_usage_sync() {
        let result = summarize_command_result(
            "usage:sync",
            &Ok(json!({
                "accepted": 10, "rejected": 2, "bucketCount": 3,
                "queuePending": 1, "queueAttempted": 5, "queueUploaded": 4, "queueFailed": 1,
                "newFailedBucketCount": 0
            })),
        );
        assert_eq!(result["accepted"], 10);
        assert_eq!(result["rejected"], 2);
    }

    #[test]
    fn summarize_result_error() {
        let result = summarize_command_result("usage:scan", &Err("something broke".to_string()));
        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("something broke"));
    }

    #[test]
    fn summarize_result_error_truncates() {
        let long_error = "x".repeat(600);
        let result = summarize_command_result("usage:scan", &Err(long_error));
        let error = result["error"].as_str().unwrap();
        assert!(error.len() < 600);
        assert!(error.ends_with("..."));
    }

    #[test]
    fn summarize_result_usage_summary() {
        let result = summarize_command_result(
            "usage:summary",
            &Ok(json!({
                "totals": {"rows": 42, "totalTokens": 5000}
            })),
        );
        assert_eq!(result["rows"], 42);
        assert_eq!(result["totalTokens"], 5000);
    }

    // ── format/parse log line tests ──

    #[test]
    fn format_and_parse_roundtrip() {
        let entry = json!({
            "ts": "2026-05-22T12:00:00.000Z",
            "level": "warn",
            "source": "backend",
            "event": "upload_failed",
            "data": {"error": "timeout"}
        });
        let line = format_log_line(&entry);
        let parsed = parse_log_line(&line).unwrap();
        assert_eq!(parsed["ts"], "2026-05-22T12:00:00.000Z");
        assert_eq!(parsed["level"], "warn");
        assert_eq!(parsed["source"], "backend");
        assert_eq!(parsed["event"], "upload_failed");
    }

    #[test]
    fn parse_log_line_json_format() {
        let line = r#"{"ts":"2026-05-22T00:00:00Z","level":"info","source":"test","event":"ping","data":{}}"#;
        let parsed = parse_log_line(line).unwrap();
        assert_eq!(parsed["event"], "ping");
    }

    #[test]
    fn parse_log_line_text_format() {
        let line = "2026-05-22T00:00:00Z INFO [backend] scan_complete {\"rows\":5}";
        let parsed = parse_log_line(line).unwrap();
        assert_eq!(parsed["ts"], "2026-05-22T00:00:00Z");
        assert_eq!(parsed["level"], "info");
        assert_eq!(parsed["source"], "backend");
        assert_eq!(parsed["event"], "scan_complete");
        assert_eq!(parsed["data"]["rows"], 5);
    }

    #[test]
    fn parse_log_line_text_with_bad_json() {
        let line = "2026-05-22T00:00:00Z ERROR [backend] crash not-json-here";
        let parsed = parse_log_line(line).unwrap();
        assert_eq!(parsed["data"]["message"], "not-json-here");
    }

    #[test]
    fn parse_log_line_empty() {
        assert!(parse_log_line("").is_none());
    }

    // ── sanitize_label test ──

    #[test]
    fn sanitize_label_filters_special_chars() {
        let result = sanitize_label("hello<script>alert('xss')</script>world");
        assert!(!result.contains('<'));
        assert!(!result.contains('>'));
        assert!(result.contains("hello"));
        assert!(result.len() <= 80);
    }

    // ── normalize_level test ──

    #[test]
    fn normalize_level_known_and_unknown() {
        assert_eq!(normalize_level("debug"), "debug");
        assert_eq!(normalize_level("info"), "info");
        assert_eq!(normalize_level("warn"), "warn");
        assert_eq!(normalize_level("error"), "error");
        assert_eq!(normalize_level("trace"), "info");
        assert_eq!(normalize_level("FATAL"), "info");
    }

    // ── truncate test ──

    #[test]
    fn truncate_short_unchanged() {
        assert_eq!(truncate("hello", 10), "hello");
    }

    #[test]
    fn truncate_long_with_ellipsis() {
        let result = truncate("abcdefghij", 5);
        assert_eq!(result, "abcde...");
    }

    // ── looks_like_path test ──

    #[test]
    fn looks_like_path_various() {
        assert!(looks_like_path("/Users/sky/project"));
        assert!(looks_like_path("~/code"));
        assert!(looks_like_path("C:\\Users\\dev"));
        assert!(looks_like_path("\\Users\\admin\\data"));
        assert!(!looks_like_path("just-a-string"));
        assert!(!looks_like_path("relative/path")); // no leading slash or ~
    }

    // ── diagnostics_status test ──

    #[test]
    fn diagnostics_status_structure() {
        let _guard = config::TEST_ENV_LOCK.lock().unwrap();
        let previous_home = std::env::var("HOME").ok();
        let home = temp_home();
        std::env::set_var("HOME", &home);
        config::ensure_app_dir();

        let status = diagnostics_status();
        assert!(status["runtimeLog"].is_object());
        assert_eq!(status["retention"]["strategy"], "days");
        assert!(status["retention"]["days"].as_u64().unwrap() >= 1);

        let _ = fs::remove_dir_all(&home);
        if let Some(value) = previous_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
    }

    // ── clear_runtime_log test ──

    #[test]
    fn clear_runtime_log_removes_files() {
        let _guard = config::TEST_ENV_LOCK.lock().unwrap();
        let previous_home = std::env::var("HOME").ok();
        let home = temp_home();
        std::env::set_var("HOME", &home);
        config::ensure_app_dir();
        fs::create_dir_all(config::runtime_log_dir()).unwrap();

        // Write a log file
        let ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        fs::write(
            config::runtime_log_path(),
            format!("{{\"ts\":\"{}\",\"event\":\"test\"}}\n", ts),
        )
        .unwrap();

        let result = clear_runtime_log();
        assert_eq!(result["ok"], true);
        assert_eq!(result["existed"], true);
        assert_eq!(result["removed"], true);

        let _ = fs::remove_dir_all(&home);
        if let Some(value) = previous_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
    }
}
