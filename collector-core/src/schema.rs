use crate::crypto::{canonical_json, sha256_hex};
use crate::date::local_day;
use serde_json::Value;
use std::collections::HashSet;

pub const STORAGE_SCHEMA_VERSION: u32 = 2;
pub const USAGE_CACHE_VERSION: u32 = 3;

pub static FORBIDDEN_UPLOAD_FIELDS: &[&str] = &[
    "absolutePath",
    "access_token",
    "assistantResponse",
    "content",
    "cookie",
    "cursor_auth_raw",
    "cursor_usage_raw",
    "fullTranscript",
    "identityPrivateKey",
    "localPath",
    "prompt",
    "refresh_token",
    "sourceFileContent",
    "workosSessionToken",
];

pub static SOURCE_QUALITY: &[&str] = &["exact", "partial", "estimated", "imported", "unknown"];

pub static BUCKET_FINGERPRINT_FIELDS: &[&str] = &[
    "day",
    "hour",
    "toolCode",
    "providerId",
    "workdirHash",
    "workdirDisplayName",
    "model",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "totalTokens",
    "sourceQuality",
    "sourceFingerprint",
];

fn forbidden_set() -> HashSet<&'static str> {
    FORBIDDEN_UPLOAD_FIELDS.iter().copied().collect()
}

fn source_quality_set() -> HashSet<&'static str> {
    SOURCE_QUALITY.iter().copied().collect()
}

pub fn today_local() -> String {
    local_day()
}

/// Normalize a token number: round to integer, clamp non-finite/non-positive to 0.
pub fn normalize_token_number(value: &Value) -> i64 {
    match value {
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if f.is_finite() && f > 0.0 {
                    f.round() as i64
                } else {
                    0
                }
            } else {
                0
            }
        }
        Value::String(s) => {
            if let Ok(f) = s.parse::<f64>() {
                if f.is_finite() && f > 0.0 {
                    f.round() as i64
                } else {
                    0
                }
            } else {
                0
            }
        }
        _ => 0,
    }
}

/// Convenience: normalize a single optional i64.
pub fn normalize_token_i64(value: Option<i64>) -> i64 {
    value.filter(|&v| v > 0).unwrap_or(0)
}

pub fn primary_token_total(item: &serde_json::Value) -> i64 {
    let input = normalize_token_number(&item["inputTokens"]);
    let output = normalize_token_number(&item["outputTokens"]);
    input + output
}

pub fn display_total_tokens(item: &serde_json::Value) -> i64 {
    primary_token_total(item)
        + normalize_token_number(&item["cacheReadTokens"])
        + normalize_token_number(&item["cacheWriteTokens"])
}

pub fn usage_key(item: &serde_json::Value, participant_id: &str, device_id: &str) -> String {
    let hour = item
        .get("hour")
        .and_then(|v| v.as_i64())
        .map(|h| h.to_string())
        .unwrap_or_default();
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}",
        item["day"].as_str().unwrap_or(""),
        hour,
        participant_id,
        device_id,
        item["toolCode"].as_str().unwrap_or(""),
        item["providerId"].as_str().unwrap_or(""),
        item["workdirHash"].as_str().unwrap_or(""),
        item["model"].as_str().unwrap_or("")
    )
}

/// Strips a usage item to only safe public fields, normalizes tokens, asserts no forbidden fields.
pub fn public_usage_item(item: &Value) -> Value {
    let input_tokens = normalize_token_number(&item["inputTokens"]);
    let output_tokens = normalize_token_number(&item["outputTokens"]);
    let cache_read_tokens = normalize_token_number(&item["cacheReadTokens"]);
    let cache_write_tokens = normalize_token_number(&item["cacheWriteTokens"]);
    let reasoning_tokens = normalize_token_number(&item["reasoningTokens"]);
    let total_tokens = input_tokens + output_tokens + cache_read_tokens + cache_write_tokens;

    let public = serde_json::json!({
        "day": item["day"],
        "hour": item.get("hour").and_then(|v| v.as_i64()).unwrap_or(0),
        "toolCode": item["toolCode"],
        "providerId": item["providerId"],
        "workdirHash": item["workdirHash"],
        "workdirDisplayName": item["workdirDisplayName"],
        "model": item["model"],
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cacheReadTokens": cache_read_tokens,
        "cacheWriteTokens": cache_write_tokens,
        "reasoningTokens": reasoning_tokens,
        "totalTokens": total_tokens,
        "sourceQuality": item.get("sourceQuality").and_then(|v| v.as_str()).unwrap_or("unknown"),
        "rawSourceRef": safe_trace_text(&item["rawSourceRef"]),
        "providerVersion": safe_trace_text(&item["providerVersion"]),
        "parserVersion": safe_trace_text(item.get("parserVersion").unwrap_or(&item["providerVersion"])),
        "sourceFingerprint": safe_trace_text(&item["sourceFingerprint"])
    });

    assert_no_forbidden_upload_fields(&public, "");
    public
}

/// Recursively checks that no key matches FORBIDDEN_UPLOAD_FIELDS.
pub fn assert_no_forbidden_upload_fields(value: &Value, path: &str) {
    match value {
        Value::Array(arr) => {
            for (i, item) in arr.iter().enumerate() {
                assert_no_forbidden_upload_fields(item, &format!("{}[{}]", path, i));
            }
        }
        Value::Object(map) => {
            let forbidden = forbidden_set();
            for (key, child) in map {
                if forbidden.contains(key.as_str()) {
                    let prefix = if path.is_empty() {
                        String::new()
                    } else {
                        format!("{}.", path)
                    };
                    panic!("forbidden upload field: {}{}", prefix, key);
                }
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{}.{}", path, key)
                };
                assert_no_forbidden_upload_fields(child, &child_path);
            }
        }
        _ => {}
    }
}

/// Validates required fields on a usage item.
pub fn assert_usage_item(item: &Value) {
    let required = [
        "day",
        "toolCode",
        "providerId",
        "workdirHash",
        "workdirDisplayName",
        "model",
        "totalTokens",
        "sourceQuality",
    ];
    for key in &required {
        let v = &item[*key];
        if v.is_null() || (v.is_string() && v.as_str() == Some("")) {
            panic!("usage item missing {}", key);
        }
    }
    let sq = item["sourceQuality"].as_str().unwrap_or("");
    if !source_quality_set().contains(sq) {
        panic!("invalid sourceQuality: {}", sq);
    }
    let tt = item["totalTokens"].as_i64();
    if tt.is_none() || tt.unwrap() < 0 {
        panic!("invalid totalTokens: {:?}", item["totalTokens"]);
    }
    assert_no_forbidden_upload_fields(item, "");
}

/// Validates a snapshot structure.
pub fn assert_snapshot(snapshot: &Value, items: &[Value], _participant_id: &str, _device_id: &str) {
    let mode = snapshot["mode"].as_str().unwrap_or("");
    let is_hourly = mode == "device_day_hour_provider";
    if mode != "device_day_provider" && !is_hourly {
        panic!("snapshot mode must be device_day_provider or device_day_hour_provider");
    }
    let day = snapshot["day"].as_str().unwrap_or("");
    if day.len() != 10 || day.chars().nth(4) != Some('-') || day.chars().nth(7) != Some('-') {
        panic!("snapshot day must be YYYY-MM-DD");
    }
    if is_hourly {
        let hour = snapshot["hour"].as_i64();
        if hour.is_none() || !(0..=23).contains(&hour.unwrap()) {
            panic!("snapshot hour must be 0-23 for hourly mode");
        }
    }
    if snapshot["providerId"].is_null() {
        panic!("snapshot providerId is required");
    }
    if snapshot["bucketFingerprint"].is_null() {
        panic!("snapshot bucketFingerprint is required");
    }
    let row_count = snapshot["rowCount"].as_i64();
    if row_count.is_none() || row_count.unwrap() < 0 {
        panic!("snapshot rowCount must be a non-negative integer");
    }
    let rc = row_count.unwrap() as usize;
    if rc == 0 {
        panic!("empty-bucket snapshot is not supported in this protocol version");
    }
    if rc != items.len() {
        panic!(
            "snapshot rowCount {} does not match items length {}",
            rc,
            items.len()
        );
    }
    let total = snapshot["totalTokens"].as_i64();
    if total.is_none() || total.unwrap() < 0 {
        panic!("snapshot totalTokens must be non-negative");
    }
    for (i, item) in items.iter().enumerate() {
        if item["day"].as_str() != Some(day) {
            panic!(
                "item {} day {:?} does not match snapshot day {:?}",
                i, item["day"], day
            );
        }
        if item["providerId"].as_str() != snapshot["providerId"].as_str() {
            panic!(
                "item {} providerId {:?} does not match snapshot providerId {:?}",
                i, item["providerId"], snapshot["providerId"]
            );
        }
        if is_hourly {
            let item_hour = item.get("hour").and_then(|v| v.as_i64());
            let snap_hour = snapshot["hour"].as_i64();
            if item_hour != snap_hour {
                panic!(
                    "item {} hour {:?} does not match snapshot hour {:?}",
                    i, item_hour, snap_hour
                );
            }
        }
    }
}

/// Compute bucket fingerprint: extract BUCKET_FINGERPRINT_FIELDS from each item,
/// sort by canonical JSON, hash the result.
pub fn compute_bucket_fingerprint(items: &[Value]) -> String {
    compute_bucket_fingerprint_with_fields(items, BUCKET_FINGERPRINT_FIELDS)
}

pub fn compute_daily_bucket_fingerprint(items: &[Value]) -> String {
    let fields = BUCKET_FINGERPRINT_FIELDS
        .iter()
        .copied()
        .filter(|field| *field != "hour")
        .collect::<Vec<_>>();
    compute_bucket_fingerprint_with_fields(items, &fields)
}

fn compute_bucket_fingerprint_with_fields(items: &[Value], fields: &[&str]) -> String {
    if items.is_empty() {
        return sha256_hex("");
    }
    let mut rows: Vec<Value> = items
        .iter()
        .map(|item| {
            let mut row = serde_json::Map::new();
            for &field in fields {
                if let Some(v) = item.get(field) {
                    row.insert(field.to_string(), v.clone());
                }
            }
            Value::Object(row)
        })
        .collect();

    rows.sort_by(|a, b| {
        let left = canonical_json(a);
        let right = canonical_json(b);
        left.cmp(&right)
    });

    sha256_hex(&canonical_json(&Value::Array(rows)))
}

fn safe_trace_text(value: &Value) -> String {
    let text = match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed.chars().take(160).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_normalize_token_number() {
        assert_eq!(normalize_token_number(&json!(42)), 42);
        assert_eq!(normalize_token_number(&json!(0)), 0);
        assert_eq!(normalize_token_number(&json!(-5)), 0);
        assert_eq!(normalize_token_number(&json!(3.7)), 4);
        assert_eq!(normalize_token_number(&json!(null)), 0);
        assert_eq!(normalize_token_number(&json!("100")), 100);
        assert_eq!(normalize_token_number(&json!("abc")), 0);
    }

    #[test]
    fn test_display_total_tokens() {
        let item = json!({
            "inputTokens": 100,
            "outputTokens": 50,
            "cacheReadTokens": 30,
            "cacheWriteTokens": 20
        });
        assert_eq!(display_total_tokens(&item), 200);
    }

    #[test]
    fn test_usage_key() {
        let item = json!({
            "day": "2024-01-01",
            "hour": 14,
            "toolCode": "codex",
            "providerId": "codex_local",
            "workdirHash": "abc123",
            "model": "gpt-4"
        });
        let key = usage_key(&item, "p_1", "d_1");
        assert_eq!(key, "2024-01-01|14|p_1|d_1|codex|codex_local|abc123|gpt-4");
    }

    #[test]
    fn test_forbidden_fields_detected() {
        let bad = json!({"day": "2024-01-01", "prompt": "secret"});
        let result = std::panic::catch_unwind(|| {
            assert_no_forbidden_upload_fields(&bad, "");
        });
        assert!(result.is_err());
    }

    #[test]
    fn test_compute_bucket_fingerprint_empty() {
        let fp = compute_bucket_fingerprint(&[]);
        assert_eq!(fp, sha256_hex(""));
    }

    #[test]
    fn test_compute_bucket_fingerprint_consistent() {
        let items = vec![json!({
            "day": "2024-01-01",
            "toolCode": "codex",
            "providerId": "codex_local",
            "workdirHash": "abc",
            "workdirDisplayName": "my-project",
            "model": "gpt-4",
            "inputTokens": 100,
            "outputTokens": 50,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0,
            "totalTokens": 150,
            "sourceQuality": "exact",
            "sourceFingerprint": "fp1"
        })];
        let fp1 = compute_bucket_fingerprint(&items);
        let fp2 = compute_bucket_fingerprint(&items);
        assert_eq!(fp1, fp2);
        assert_eq!(fp1.len(), 64);
    }

    #[test]
    fn test_public_usage_item() {
        let item = json!({
            "day": "2024-01-01",
            "toolCode": "codex",
            "providerId": "codex_local",
            "workdirHash": "abc",
            "workdirDisplayName": "my-project",
            "model": "gpt-4",
            "inputTokens": 100.6,
            "outputTokens": 50,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0,
            "sourceQuality": "exact",
            "rawSourceRef": "session.jsonl",
            "providerVersion": "0.1.2",
            "sourceFingerprint": "fp1"
        });
        let public = public_usage_item(&item);
        assert_eq!(public["inputTokens"], 101);
        assert_eq!(public["totalTokens"], 151);
        assert!(public.get("identityPrivateKey").is_none());
    }
}
