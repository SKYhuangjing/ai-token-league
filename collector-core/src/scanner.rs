use crate::config::AppConfig;
use crate::crypto::sha256_hex;
use crate::provider::claude_code_local::ClaudeCodeLocalProvider;
use crate::provider::codex_local::CodexProvider;
use crate::provider::cursor_dashboard::CursorDashboardProvider;
use crate::schema::{compute_bucket_fingerprint, public_usage_item};
use crate::workdir::workdir_from_candidate;
use serde_json::{json, Value};
use std::collections::HashMap;

pub struct ScanResult {
    pub items: Vec<Value>,
    pub health: Vec<Value>,
    pub source_index: HashMap<String, Vec<Value>>,
}

/// Async scan: local providers plus Cursor dashboard usage when enabled.
pub async fn scan_usage_async(config: &AppConfig, cache_items: &HashMap<String, Vec<Value>>) -> ScanResult {
    let mut result = scan_usage(config, cache_items);

    let cursor = CursorDashboardProvider;
    if cursor.is_enabled(config) {
        let mut cursor_items = Vec::new();
        let sources = cursor.discover_sources(config);
        for source in &sources {
            if let Ok(events) = cursor.fetch_usage(&source.cookie).await {
                cursor_items.extend(
                    cursor
                        .parse_events(&events, &source.account_name)
                        .into_iter()
                        .map(|event| finalize_event(event, config)),
                );
            }
        }
        if !cursor_items.is_empty() {
            let mut combined = result.items;
            combined.extend(cursor_items);
            result.items = aggregate_items(&combined);
        }
        result.health.push(json!({
            "providerId": cursor.id(),
            "enabled": true,
            "detected": !sources.is_empty(),
            "ok": !sources.is_empty(),
            "roots": sources.iter().map(|s| s.account_name.clone()).collect::<Vec<_>>(),
            "scannedFiles": sources.len()
        }));
    } else {
        let sources = cursor.discover_sources(config);
        result.health.push(json!({
            "providerId": cursor.id(),
            "enabled": false,
            "detected": !sources.is_empty(),
            "ok": !sources.is_empty(),
            "roots": sources.iter().map(|s| s.account_name.clone()).collect::<Vec<_>>(),
            "scannedFiles": sources.len()
        }));
    }

    result
}

/// Main scan: iterate all providers, collect usage items, aggregate.
pub fn scan_usage(config: &AppConfig, cache_items: &HashMap<String, Vec<Value>>) -> ScanResult {
    let mut all_items: Vec<Value> = Vec::new();
    let mut health = Vec::new();
    let mut source_index: HashMap<String, Vec<Value>> = HashMap::new();

    // Codex
    let codex = CodexProvider;
    let codex_files = codex.scan_sessions(config);
    for file in &codex_files {
        let source_meta = crate::provider::common::source_metadata(file, codex.id(), codex.version());
        let items = if let Some(cached) = cache_items
            .get(&source_meta.source_fingerprint)
            .filter(|items| cached_items_have_hour(items))
        {
            cached.clone()
        } else {
            let events = codex.parse_usage(file);
            events
                .into_iter()
                .map(|event| finalize_event(event, config))
                .collect::<Vec<_>>()
        };
        source_index.insert(source_meta.source_fingerprint, items.clone());
        all_items.extend(items);
    }
    let codex_file_count = codex_files.len();
    health.push(json!({
        "providerId": codex.id(),
        "enabled": config.provider_enabled.get(codex.id()).copied().unwrap_or(true),
        "detected": codex_file_count > 0,
        "ok": codex_file_count > 0,
        "roots": codex_files,
        "scannedFiles": codex_file_count
    }));

    // Claude Code
    let claude = ClaudeCodeLocalProvider;
    let claude_files = claude.scan_sessions(config);
    for file in &claude_files {
        let source_meta = crate::provider::common::source_metadata(file, claude.id(), claude.version());
        let items = if let Some(cached) = cache_items
            .get(&source_meta.source_fingerprint)
            .filter(|items| cached_items_have_hour(items))
        {
            cached.clone()
        } else {
            let events = claude.parse_usage(file);
            events
                .into_iter()
                .map(|event| finalize_event(event, config))
                .collect::<Vec<_>>()
        };
        source_index.insert(source_meta.source_fingerprint, items.clone());
        all_items.extend(items);
    }
    let claude_file_count = claude_files.len();
    health.push(json!({
        "providerId": claude.id(),
        "enabled": config.provider_enabled.get(claude.id()).copied().unwrap_or(true),
        "detected": claude_file_count > 0,
        "ok": claude_file_count > 0,
        "roots": claude_files,
        "scannedFiles": claude_file_count
    }));

    // Aggregate
    let aggregated = aggregate_items(&all_items);

    ScanResult {
        items: aggregated,
        health,
        source_index,
    }
}

/// Group items by day|hour|toolCode|providerId|workdirHash|model, sum tokens.
fn aggregate_items(items: &[Value]) -> Vec<Value> {
    let mut groups: HashMap<String, Vec<&Value>> = HashMap::new();
    for item in items {
        let hour = item.get("hour").and_then(|v| v.as_i64()).map(|h| h.to_string()).unwrap_or_default();
        let key = format!(
            "{}|{}|{}|{}|{}|{}",
            item["day"].as_str().unwrap_or(""),
            hour,
            item["toolCode"].as_str().unwrap_or(""),
            item["providerId"].as_str().unwrap_or(""),
            item["workdirHash"].as_str().unwrap_or(""),
            item["model"].as_str().unwrap_or("")
        );
        groups.entry(key).or_default().push(item);
    }

    let mut result: Vec<Value> = groups
        .into_iter()
        .map(|(_, group)| {
            let first = &group[0];
            let input_tokens: i64 = group.iter().map(|i| i["inputTokens"].as_i64().unwrap_or(0)).sum();
            let output_tokens: i64 = group.iter().map(|i| i["outputTokens"].as_i64().unwrap_or(0)).sum();
            let cache_read_tokens: i64 = group.iter().map(|i| i["cacheReadTokens"].as_i64().unwrap_or(0)).sum();
            let cache_write_tokens: i64 = group.iter().map(|i| i["cacheWriteTokens"].as_i64().unwrap_or(0)).sum();
            let reasoning_tokens: i64 = group.iter().map(|i| i["reasoningTokens"].as_i64().unwrap_or(0)).sum();
            let total_tokens: i64 = group.iter().map(|i| i["totalTokens"].as_i64().unwrap_or(0)).sum();

            let all_exact = group.iter().all(|i| i["sourceQuality"].as_str() == Some("exact"));
            let source_quality = if all_exact { "exact" } else { "partial" };

            let raw_source_ref = merge_trace_value(
                group.iter().map(|i| i["rawSourceRef"].as_str().unwrap_or("")).collect(),
            );
            let source_fingerprint = merge_trace_value(
                group.iter().map(|i| i["sourceFingerprint"].as_str().unwrap_or("")).collect(),
            );
            let provider_version = merge_trace_value(
                group.iter().map(|i| i["providerVersion"].as_str().unwrap_or("")).collect(),
            );
            let parser_version = merge_trace_value(
                group.iter().map(|i| i["parserVersion"].as_str().unwrap_or("")).collect(),
            );

            json!({
                "day": first["day"],
                "hour": first.get("hour").and_then(|v| v.as_i64()).unwrap_or(0),
                "toolCode": first["toolCode"],
                "providerId": first["providerId"],
                "workdirHash": first["workdirHash"],
                "workdirDisplayName": first["workdirDisplayName"],
                "model": first["model"],
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "cacheReadTokens": cache_read_tokens,
                "cacheWriteTokens": cache_write_tokens,
                "reasoningTokens": reasoning_tokens,
                "totalTokens": total_tokens,
                "sourceQuality": source_quality,
                "rawSourceRef": raw_source_ref,
                "sourceFingerprint": source_fingerprint,
                "providerVersion": provider_version,
                "parserVersion": parser_version,
            })
        })
        .collect();

    result.sort_by(|a, b| {
        b["totalTokens"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&a["totalTokens"].as_i64().unwrap_or(0))
    });

    result
}

/// Merge trace values: collect unique non-empty values, sort.
/// If one value, return it. If multiple, hash them.
fn merge_trace_value(values: Vec<&str>) -> String {
    let mut unique: Vec<&str> = values
        .into_iter()
        .filter(|v| !v.is_empty())
        .collect();
    unique.sort();
    unique.dedup();
    match unique.len() {
        0 => String::new(),
        1 => unique[0].to_string(),
        _ => {
            let joined = unique.join("|");
            sha256_hex(&joined)
        }
    }
}

/// Group items by day|hour|providerId for sync buckets.
pub fn group_by_bucket(items: &[Value]) -> Vec<(String, Value)> {
    let mut groups: HashMap<String, Vec<&Value>> = HashMap::new();
    for item in items {
        let hour = item.get("hour").and_then(|v| v.as_i64()).map(|h| h.to_string()).unwrap_or_default();
        let key = format!(
            "{}|{}|{}",
            item["day"].as_str().unwrap_or(""),
            hour,
            item["providerId"].as_str().unwrap_or("")
        );
        groups.entry(key).or_default().push(item);
    }

    groups
        .into_iter()
        .map(|(key, items)| {
            let first = &items[0];
            let bucket = json!({
                "day": first["day"],
                "hour": first.get("hour").and_then(|v| v.as_i64()).unwrap_or(0),
                "providerId": first["providerId"],
                "mode": "device_day_hour_provider",
                "items": items,
                "fingerprint": compute_bucket_fingerprint(&items.iter().cloned().cloned().collect::<Vec<_>>())
            });
            (key, bucket)
        })
        .collect()
}

fn cached_items_have_hour(items: &[Value]) -> bool {
    items
        .iter()
        .all(|item| item.get("hour").and_then(|v| v.as_i64()).is_some_and(|hour| (0..=23).contains(&hour)))
}

/// Finalize a raw provider event: resolve workdir, apply publicUsageItem.
fn finalize_event(event: Value, config: &AppConfig) -> Value {
    let candidate = event["workdirCandidate"].as_str().unwrap_or("");
    let wd = workdir_from_candidate(candidate, &config.participant_id);

    let display_name = config
        .workdir_aliases
        .get(&wd.workdir_hash)
        .cloned()
        .unwrap_or(wd.display_name);

    let mut item = event.clone();
    if let Some(obj) = item.as_object_mut() {
        obj.insert("workdirHash".to_string(), json!(wd.workdir_hash));
        obj.insert("workdirDisplayName".to_string(), json!(display_name));
        obj.remove("workdirCandidate");
        obj.remove("localPath");
    }

    public_usage_item(&item)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_trace_value_empty() {
        assert_eq!(merge_trace_value(vec![]), "");
    }

    #[test]
    fn test_merge_trace_value_single() {
        assert_eq!(merge_trace_value(vec!["abc"]), "abc");
    }

    #[test]
    fn test_merge_trace_value_multiple() {
        let result = merge_trace_value(vec!["abc", "def"]);
        assert_eq!(result.len(), 64); // SHA-256 hex
    }

    #[test]
    fn test_aggregate_items() {
        let items = vec![
            json!({
                "day": "2024-01-01", "hour": 10, "toolCode": "codex", "providerId": "codex_local",
                "workdirHash": "abc", "workdirDisplayName": "proj", "model": "gpt-4",
                "inputTokens": 100, "outputTokens": 50, "cacheReadTokens": 0,
                "cacheWriteTokens": 0, "reasoningTokens": 0, "totalTokens": 150,
                "sourceQuality": "exact", "rawSourceRef": "a.jsonl",
                "sourceFingerprint": "fp1", "providerVersion": "0.1", "parserVersion": "0.1"
            }),
            json!({
                "day": "2024-01-01", "hour": 10, "toolCode": "codex", "providerId": "codex_local",
                "workdirHash": "abc", "workdirDisplayName": "proj", "model": "gpt-4",
                "inputTokens": 200, "outputTokens": 100, "cacheReadTokens": 0,
                "cacheWriteTokens": 0, "reasoningTokens": 0, "totalTokens": 300,
                "sourceQuality": "exact", "rawSourceRef": "b.jsonl",
                "sourceFingerprint": "fp2", "providerVersion": "0.1", "parserVersion": "0.1"
            }),
        ];
        let result = aggregate_items(&items);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["totalTokens"], 450);
        assert_eq!(result[0]["inputTokens"], 300);
        assert_eq!(result[0]["hour"], 10);
    }

    #[test]
    fn test_group_by_bucket() {
        let items = vec![
            json!({"day": "2024-01-01", "hour": 10, "providerId": "codex_local", "toolCode": "codex",
                   "workdirHash": "a", "workdirDisplayName": "p", "model": "gpt-4",
                   "inputTokens": 100, "outputTokens": 50, "cacheReadTokens": 0,
                   "cacheWriteTokens": 0, "reasoningTokens": 0, "totalTokens": 150,
                   "sourceQuality": "exact", "rawSourceRef": "", "sourceFingerprint": "",
                   "providerVersion": "", "parserVersion": ""}),
            json!({"day": "2024-01-01", "hour": 10, "providerId": "claude_code_local", "toolCode": "claude_code",
                   "workdirHash": "b", "workdirDisplayName": "q", "model": "claude",
                   "inputTokens": 200, "outputTokens": 100, "cacheReadTokens": 0,
                   "cacheWriteTokens": 0, "reasoningTokens": 0, "totalTokens": 300,
                   "sourceQuality": "exact", "rawSourceRef": "", "sourceFingerprint": "",
                   "providerVersion": "", "parserVersion": ""}),
        ];
        let buckets = group_by_bucket(&items);
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].1["mode"], "device_day_hour_provider");
    }

    #[test]
    fn test_cached_items_have_hour_rejects_legacy_rows() {
        assert!(cached_items_have_hour(&[json!({ "hour": 10 })]));
        assert!(!cached_items_have_hour(&[json!({ "day": "2026-05-16" })]));
        assert!(!cached_items_have_hour(&[json!({ "hour": 24 })]));
    }
}
