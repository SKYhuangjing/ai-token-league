use crate::config::AppConfig;
use crate::provider::common::*;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

pub const PROVIDER_ID: &str = "codex_local";
pub const TOOL_CODE: &str = "codex";
pub const VERSION: &str = "0.1.2";

pub struct CodexProvider;

impl CodexProvider {
    pub fn id(&self) -> &str { PROVIDER_ID }
    pub fn tool_code(&self) -> &str { TOOL_CODE }
    pub fn version(&self) -> &str { VERSION }

    pub fn roots(&self, config: &AppConfig) -> Vec<String> {
        let auto = self.auto_roots(config);
        let manual = self.manual_roots(config);
        let mut combined = auto;
        for r in manual {
            if !combined.contains(&r) {
                combined.push(r);
            }
        }
        combined
    }

    pub fn auto_roots(&self, _config: &AppConfig) -> Vec<String> {
        let home = dirs::home_dir().unwrap_or_default();
        let mut roots = Vec::new();

        if let Ok(codex_home) = std::env::var("CODEX_HOME") {
            if Path::new(&codex_home).exists() {
                roots.push(codex_home);
            }
        }
        let default_root = home.join(".codex");
        if default_root.exists() {
            roots.push(default_root.to_string_lossy().to_string());
        }

        if roots.is_empty() {
            let fallback = std::env::current_dir()
                .unwrap_or_default()
                .join("samples/codex");
            roots.push(fallback.to_string_lossy().to_string());
        }
        roots
    }

    pub fn manual_roots(&self, config: &AppConfig) -> Vec<String> {
        config
            .provider_roots
            .get(PROVIDER_ID)
            .cloned()
            .unwrap_or_default()
    }

    pub fn scan_sessions(&self, config: &AppConfig) -> Vec<String> {
        if config.provider_enabled.get(PROVIDER_ID) == Some(&false) {
            return vec![];
        }
        let ignored = config
            .provider_ignored_auto_sources
            .get(PROVIDER_ID)
            .cloned()
            .unwrap_or_default();
        let auto: Vec<String> = self
            .auto_roots(config)
            .into_iter()
            .filter(|r| !ignored.contains(r))
            .collect();
        let manual = self.manual_roots(config);

        let mut files = Vec::new();
        for root in auto.iter().chain(manual.iter()) {
            let found = walk_files(root, |f| f.ends_with(".jsonl"), 1000);
            files.extend(found);
        }
        files
    }

    pub fn parse_usage(&self, file: &str) -> Vec<Value> {
        let stats = match fs::metadata(file) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let mtime_ms = stats
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);

        let source = source_metadata(file, PROVIDER_ID, VERSION);
        let rows = read_json_lines(file);
        let mut events = Vec::new();

        let mut session_cwd = String::new();
        let mut session_id = Path::new(file)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        // First pass: extract session metadata
        for row in &rows {
            if row["type"].as_str() == Some("session_meta") && row["payload"].is_object() {
                if let Some(cwd) = row["payload"]["cwd"].as_str() {
                    session_cwd = cwd.to_string();
                }
                if let Some(id) = row["payload"]["id"].as_str() {
                    session_id = id.to_string();
                }
                break;
            }
        }

        // Second pass: extract token usage events
        let mut current_model = String::new();
        let mut previous_cumulative_total: i64 = 0;

        for row in &rows {
            let model_found = deep_find_string(row, &["model", "model_slug", "model_name"]);
            if !model_found.is_empty() {
                current_model = model_found;
            }

            let usage = match extract_usage(row) {
                Some(u) => u,
                None => continue,
            };

            let normalized_model = normalize_codex_model(&current_model);
            if normalized_model.is_empty() {
                continue;
            }

            let total_tokens = usage.delta_total(previous_cumulative_total);
            if total_tokens == 0 {
                continue;
            }

            let workdir_candidate = if !session_cwd.is_empty() {
                session_cwd.clone()
            } else {
                let found = deep_find_string(row, &["cwd", "workdir", "working_directory", "project_path"]);
                if found.is_empty() {
                    std::env::current_dir()
                        .map(|d| d.to_string_lossy().to_string())
                        .unwrap_or_default()
                } else {
                    found
                }
            };

            events.push(json!({
                "providerId": PROVIDER_ID,
                "providerVersion": VERSION,
                "toolCode": TOOL_CODE,
                "sourceKind": "local_log",
                "sourceQuality": usage.quality,
                "sessionId": session_id,
                "day": day_from_record(row, mtime_ms),
                "hour": hour_from_record(row, mtime_ms),
                "workdirCandidate": workdir_candidate,
                "model": normalized_model,
                "inputTokens": usage.input_tokens,
                "outputTokens": usage.output_tokens,
                "cacheReadTokens": usage.cache_read_tokens,
                "cacheWriteTokens": usage.cache_write_tokens,
                "reasoningTokens": usage.reasoning_tokens,
                "totalTokens": total_tokens,
                "rawSourceRef": source.raw_source_ref,
                "sourceFingerprint": source.source_fingerprint,
                "parserVersion": source.parser_version,
            }));

            if usage.cumulative_total > 0 {
                previous_cumulative_total = usage.cumulative_total;
            }
        }

        events
    }
}

fn normalize_codex_model(model: &str) -> String {
    let value = model.trim();
    if value.is_empty() || value == "codex-default" {
        return String::new();
    }
    value.to_string()
}

struct UsageResult {
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    reasoning_tokens: i64,
    cumulative_total: i64,
    quality: String,
    is_cumulative: bool,
    total: i64,
}

impl UsageResult {
    fn delta_total(&self, previous: i64) -> i64 {
        if !self.is_cumulative {
            return self.total;
        }
        if previous == 0 {
            return self.total;
        }
        if self.total >= previous {
            self.total - previous
        } else {
            self.total
        }
    }
}

fn token_field(usage: &Value, aliases: &[&str]) -> i64 {
    for alias in aliases {
        if let Some(n) = usage.get(*alias).and_then(|v| v.as_f64()) {
            return n.round() as i64;
        }
    }
    0
}

fn extract_usage(row: &Value) -> Option<UsageResult> {
    let info = if row["payload"]["type"].as_str() == Some("token_count") {
        Some(&row["payload"]["info"])
    } else {
        None
    };

    let sample_usage = if row.get("token_count").is_some() {
        row.get("token_count")
    } else {
        row.get("usage")
    };

    let usage = if let Some(info_val) = info {
        info_val.get("last_token_usage").or(sample_usage)?
    } else {
        sample_usage?
    };

    let raw_input_tokens = token_field(usage, &["input_tokens", "inputTokens", "prompt_tokens"]);
    let output_tokens = token_field(usage, &["output_tokens", "outputTokens", "completion_tokens"]);
    let cache_read_tokens = token_field(usage, &["cached_input_tokens", "cache_read_tokens", "cacheReadTokens"]);
    let cache_write_tokens = token_field(usage, &[
        "cache_creation_input_tokens", "cacheWriteTokens", "cache_write_tokens", "cached_input_write_tokens",
    ]);
    let reasoning_tokens = token_field(usage, &["reasoning_output_tokens", "reasoning_tokens", "reasoningTokens"]);

    // Codex: subtract cache tokens from input
    let input_tokens = 0i64.max(raw_input_tokens - cache_read_tokens - cache_write_tokens);

    let direct_total = token_field(usage, &["total_tokens", "totalTokens"]);
    let total = input_tokens + output_tokens + cache_read_tokens + cache_write_tokens;
    let total = if total > 0 { total } else { direct_total };

    if total <= 0 {
        return None;
    }

    let is_cumulative = sample_usage.is_some() && info.and_then(|i| i.get("last_token_usage")).is_none();
    let quality = if raw_input_tokens > 0 || output_tokens > 0 {
        "exact"
    } else {
        "partial"
    };

    Some(UsageResult {
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        reasoning_tokens,
        cumulative_total: if is_cumulative { total } else { 0 },
        quality: quality.to_string(),
        is_cumulative,
        total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_codex_model() {
        assert_eq!(normalize_codex_model("gpt-4"), "gpt-4");
        assert_eq!(normalize_codex_model("codex-default"), "");
        assert_eq!(normalize_codex_model(""), "");
        assert_eq!(normalize_codex_model("  gpt-4o  "), "gpt-4o");
    }

    #[test]
    fn test_extract_usage_subtracts_cache() {
        let row = json!({
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": 100,
                        "output_tokens": 50,
                        "cached_input_tokens": 30,
                        "cache_creation_input_tokens": 20
                    }
                }
            }
        });
        let usage = extract_usage(&row).unwrap();
        // inputTokens = max(0, 100 - 30 - 20) = 50
        assert_eq!(usage.input_tokens, 50);
        assert_eq!(usage.output_tokens, 50);
        assert_eq!(usage.cache_read_tokens, 30);
        assert_eq!(usage.cache_write_tokens, 20);
    }

    #[test]
    fn test_cumulative_delta() {
        let row1 = json!({"usage": {"input_tokens": 100, "output_tokens": 50}});
        let row2 = json!({"usage": {"input_tokens": 200, "output_tokens": 100}});

        let u1 = extract_usage(&row1).unwrap();
        assert!(u1.is_cumulative);
        let delta1 = u1.delta_total(0);
        assert_eq!(delta1, 150); // first = total

        let u2 = extract_usage(&row2).unwrap();
        let delta2 = u2.delta_total(150); // 300 - 150 = 150
        assert_eq!(delta2, 150);
    }
}
