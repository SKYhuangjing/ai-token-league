use crate::crypto::sha256_hex;
use crate::date::{local_day_from_timestamp_ms, local_hour_from_timestamp_ms};
use crate::schema::normalize_token_number;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

/// Walk directory tree collecting files matching a predicate. Stack-based DFS.
pub fn walk_files<F>(root: &str, matcher: F, limit: usize) -> Vec<String>
where
    F: Fn(&str) -> bool,
{
    let mut out = Vec::new();
    if root.is_empty() || !Path::new(root).exists() {
        return out;
    }
    let mut stack = vec![PathBuf::from(root)];
    while let Some(current) = stack.pop() {
        if out.len() >= limit {
            break;
        }
        let entries = match fs::read_dir(&current) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if out.len() >= limit {
                break;
            }
            let full = entry.path();
            let full_str = full.to_string_lossy().to_string();
            if full.is_dir() {
                stack.push(full);
            } else if matcher(&full_str) {
                out.push(full_str);
            }
        }
    }
    out
}

/// Read a JSONL file, parse each line, skip invalid JSON.
pub fn read_json_lines(file: &str) -> Vec<Value> {
    let content = match fs::read_to_string(file) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    content
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

pub struct SourceMetadata {
    pub raw_source_ref: String,
    pub source_fingerprint: String,
    pub parser_version: String,
}

/// Compute source fingerprint from the main file and a possible SQLite WAL sidecar.
pub fn source_metadata(file: &str, provider_id: &str, parser_version: &str) -> SourceMetadata {
    source_metadata_with_stable_key(file, file, provider_id, parser_version)
}

/// Same as [source_metadata], but the fingerprint hashes `stable_key` instead
/// of the full path. Use this for providers whose upstream tool relocates
/// files between directories (Codex moves `sessions/YYYY/MM/DD/x.jsonl` to
/// `archived_sessions/x.jsonl`): a path-derived fingerprint turns every move
/// into a cache miss, a full cold re-parse, and a mass history re-upload.
pub fn source_metadata_with_stable_key(
    file: &str,
    stable_key: &str,
    provider_id: &str,
    parser_version: &str,
) -> SourceMetadata {
    let path = Path::new(file);
    let raw_source_ref = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let file_state = |path: &Path| {
        let metadata = fs::metadata(path).ok();
        let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let mtime_ms = metadata
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        (size, mtime_ms)
    };
    let (size, mtime_ms) = file_state(path);
    let wal_path = PathBuf::from(format!("{}-wal", file));
    let (wal_size, wal_mtime_ms) = file_state(&wal_path);

    let fingerprint_input = format!(
        "{}|{}|{}|{}|{}|{}|{}",
        provider_id, parser_version, stable_key, size, mtime_ms, wal_size, wal_mtime_ms
    );

    SourceMetadata {
        raw_source_ref,
        source_fingerprint: sha256_hex(&fingerprint_input),
        parser_version: parser_version.to_string(),
    }
}

/// Recursively search an object for the first string value at any of the given key names.
pub fn deep_find_string(value: &Value, names: &[&str]) -> String {
    if value.is_null() || !value.is_object() && !value.is_array() {
        return String::new();
    }
    if let Some(map) = value.as_object() {
        for (key, child) in map {
            if names.contains(&key.as_str()) {
                if let Some(s) = child.as_str() {
                    return s.to_string();
                }
            }
            let found = deep_find_string(child, names);
            if !found.is_empty() {
                return found;
            }
        }
    }
    if let Some(arr) = value.as_array() {
        for child in arr {
            let found = deep_find_string(child, names);
            if !found.is_empty() {
                return found;
            }
        }
    }
    String::new()
}

/// Recursively search an object, summing all number values at any of the given key names.
pub fn deep_find_number(value: &Value, names: &[&str]) -> i64 {
    if value.is_null() || !value.is_object() && !value.is_array() {
        return 0;
    }
    let mut total = 0.0;
    if let Some(map) = value.as_object() {
        for (key, child) in map {
            if names.contains(&key.as_str()) {
                if let Some(n) = child.as_f64() {
                    total += n;
                }
            } else {
                total += deep_find_number(child, names) as f64;
            }
        }
    }
    if let Some(arr) = value.as_array() {
        for child in arr {
            total += deep_find_number(child, names) as f64;
        }
    }
    normalize_token_number(&Value::Number(
        serde_json::Number::from_f64(total).unwrap_or_else(|| serde_json::Number::from(0)),
    ))
}

/// Extract day (YYYY-MM-DD) from a JSON record, falling back to file mtime.
pub fn day_from_record(record: &Value, fallback_mtime_ms: f64) -> String {
    let timestamp_keys = ["timestamp", "created_at", "createdAt", "time", "date"];
    let raw = deep_find_string(record, &timestamp_keys);
    if !raw.is_empty() {
        if let Ok(ms) = date_string_to_ms(&raw) {
            return local_day_from_timestamp_ms(ms);
        }
    }
    local_day_from_timestamp_ms(fallback_mtime_ms as i64)
}

/// Extract hour (0-23) from a JSON record, falling back to file mtime.
pub fn hour_from_record(record: &Value, fallback_mtime_ms: f64) -> u32 {
    let timestamp_keys = ["timestamp", "created_at", "createdAt", "time", "date"];
    let raw = deep_find_string(record, &timestamp_keys);
    if !raw.is_empty() {
        if let Ok(ms) = date_string_to_ms(&raw) {
            return local_hour_from_timestamp_ms(ms);
        }
    }
    local_hour_from_timestamp_ms(fallback_mtime_ms as i64)
}

/// Try to parse a date string to milliseconds since epoch.
fn date_string_to_ms(s: &str) -> Result<i64, ()> {
    // Try ISO 8601 first
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Ok(dt.timestamp_millis());
    }
    // Try common date formats
    for fmt in &["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"] {
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            return Ok(dt.and_utc().timestamp_millis());
        }
        if let Ok(d) = chrono::NaiveDate::parse_from_str(s, fmt) {
            return Ok(d
                .and_hms_opt(0, 0, 0)
                .unwrap_or_default()
                .and_utc()
                .timestamp_millis());
        }
    }
    // Try as milliseconds directly
    if let Ok(ms) = s.parse::<i64>() {
        if ms > 1_000_000_000_000 {
            return Ok(ms);
        }
        // Could be seconds
        if ms > 1_000_000_000 {
            return Ok(ms * 1000);
        }
    }
    Err(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_json_lines() {
        // Test with samples if available
        let sample_dir = std::path::Path::new("samples/codex");
        if !sample_dir.exists() {
            return;
        }
        if let Some(entry) = sample_dir.read_dir().ok().and_then(|mut e| e.next()) {
            if let Ok(entry) = entry {
                let lines = read_json_lines(&entry.path().to_string_lossy());
                assert!(!lines.is_empty());
            }
        }
    }

    #[test]
    fn test_deep_find_string() {
        let v = serde_json::json!({"a": {"model": "gpt-4"}, "b": 2});
        assert_eq!(deep_find_string(&v, &["model"]), "gpt-4");
        assert_eq!(deep_find_string(&v, &["nonexistent"]), "");
    }

    #[test]
    fn test_deep_find_number() {
        let v = serde_json::json!({"input_tokens": 100, "nested": {"input_tokens": 50}});
        assert_eq!(deep_find_number(&v, &["input_tokens"]), 150);
    }

    #[test]
    fn source_metadata_changes_when_sqlite_wal_changes() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let db_path = std::env::temp_dir().join(format!("atl-source-{}.db", suffix));
        let wal_path = PathBuf::from(format!("{}-wal", db_path.to_string_lossy()));
        fs::write(&db_path, b"database").unwrap();
        fs::write(&wal_path, b"wal").unwrap();

        let first = source_metadata(&db_path.to_string_lossy(), "sqlite_test", "1");
        fs::write(&wal_path, b"wal-with-new-rows").unwrap();
        let second = source_metadata(&db_path.to_string_lossy(), "sqlite_test", "1");

        assert_ne!(first.source_fingerprint, second.source_fingerprint);
        let _ = fs::remove_file(db_path);
        let _ = fs::remove_file(wal_path);
    }
}
