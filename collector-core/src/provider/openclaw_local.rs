use crate::config::AppConfig;
use crate::provider::common::*;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

pub const PROVIDER_ID: &str = "openclaw_local";
pub const TOOL_CODE: &str = "openclaw";
pub const VERSION: &str = "0.1.0";

const DEFAULT_ROOTS: &[&str] = &[
    ".openclaw",
    ".clawdbot",
    ".moltbot",
    ".moldbot",
];

pub struct OpenClawLocalProvider;

impl OpenClawLocalProvider {
    pub fn id(&self) -> &str {
        PROVIDER_ID
    }
    pub fn tool_code(&self) -> &str {
        TOOL_CODE
    }
    pub fn version(&self) -> &str {
        VERSION
    }

    pub fn auto_roots(&self, _config: &AppConfig) -> Vec<String> {
        let home = dirs::home_dir().unwrap_or_default();
        let mut roots = Vec::new();

        if let Ok(openclaw_dir) = std::env::var("OPENCLAW_DIR") {
            for dir in openclaw_dir.split(',') {
                let dir = dir.trim();
                if !dir.is_empty() {
                    let path = std::path::PathBuf::from(dir);
                    if path.exists() {
                        roots.push(path.to_string_lossy().to_string());
                    }
                }
            }
        }

        for name in DEFAULT_ROOTS {
            let root = home.join(name);
            if root.exists() {
                let root_str = root.to_string_lossy().to_string();
                if !roots.contains(&root_str) {
                    roots.push(root_str);
                }
            }
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
            let found = walk_files(root, |f| is_openclaw_jsonl(f), 5000);
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

        let session_id = Path::new(file)
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let mut current_model = String::new();

        for row in &rows {
            if let Some(role) = row["role"].as_str() {
                if role != "assistant" {
                    continue;
                }
            } else {
                continue;
            }

            if let Some(event_type) = row["type"].as_str() {
                match event_type {
                    "model_change" | "model-snapshot" => {
                        if let Some(model) = row["model"].as_str() {
                            current_model = model.to_string();
                        }
                        continue;
                    }
                    "custom" => {
                        if let Some(model) = row.get("model").and_then(|m| m.as_str()) {
                            current_model = model.to_string();
                        }
                        continue;
                    }
                    _ => {}
                }
            }

            let usage = match row.get("usage") {
                Some(u) => u,
                None => continue,
            };

            let input_tokens = token_field_i64(usage, &["input_tokens", "inputTokens", "prompt_tokens"]);
            let output_tokens = token_field_i64(usage, &["output_tokens", "outputTokens", "completion_tokens"]);
            let cache_read_tokens = token_field_i64(
                usage,
                &["cache_read_tokens", "cacheReadTokens", "cached_input_tokens"],
            );
            let cache_write_tokens = token_field_i64(
                usage,
                &["cache_write_tokens", "cacheWriteTokens", "cache_creation_input_tokens"],
            );
            let reasoning_tokens = token_field_i64(
                usage,
                &["reasoning_tokens", "reasoningTokens", "reasoning_output_tokens"],
            );

            let total = input_tokens + output_tokens + cache_read_tokens + cache_write_tokens;
            if total == 0 {
                continue;
            }

            let model = if !current_model.is_empty() {
                current_model.clone()
            } else {
                deep_find_string(row, &["model", "model_name", "model_slug"])
            };
            let model = if model.is_empty() {
                "unknown".to_string()
            } else {
                model
            };

            let workdir_candidate = deep_find_string(
                row,
                &["cwd", "workdir", "working_directory", "project_path"],
            );
            let workdir_candidate = if workdir_candidate.is_empty() {
                std::env::current_dir()
                    .map(|d| d.to_string_lossy().to_string())
                    .unwrap_or_default()
            } else {
                workdir_candidate
            };

            let day = day_from_record(row, mtime_ms);
            let hour = hour_from_record(row, mtime_ms);

            events.push(json!({
                "providerId": PROVIDER_ID,
                "providerVersion": VERSION,
                "toolCode": TOOL_CODE,
                "sourceKind": "local_log",
                "sourceQuality": "exact",
                "sessionId": session_id,
                "day": day,
                "hour": hour,
                "workdirCandidate": workdir_candidate,
                "model": model,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "cacheReadTokens": cache_read_tokens,
                "cacheWriteTokens": cache_write_tokens,
                "reasoningTokens": reasoning_tokens,
                "totalTokens": total,
                "rawSourceRef": source.raw_source_ref,
                "sourceFingerprint": source.source_fingerprint,
                "parserVersion": source.parser_version,
            }));
        }

        events
    }
}

fn is_openclaw_jsonl(path: &str) -> bool {
    if path.ends_with(".jsonl") {
        return true;
    }
    if path.contains(".jsonl.deleted.") || path.contains(".jsonl.reset.") {
        return true;
    }
    false
}

fn token_field_i64(usage: &Value, aliases: &[&str]) -> i64 {
    for alias in aliases {
        if let Some(n) = usage.get(*alias).and_then(|v| v.as_f64()) {
            return n.round() as i64;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_constants() {
        assert_eq!(PROVIDER_ID, "openclaw_local");
        assert_eq!(TOOL_CODE, "openclaw");
    }

    #[test]
    fn test_is_openclaw_jsonl() {
        assert!(is_openclaw_jsonl("session.jsonl"));
        assert!(is_openclaw_jsonl("abc.jsonl.deleted.1234567890"));
        assert!(is_openclaw_jsonl("abc.jsonl.reset.1234567890"));
        assert!(!is_openclaw_jsonl("session.json"));
        assert!(!is_openclaw_jsonl("session.txt"));
    }

    fn sample_dir() -> Option<std::path::PathBuf> {
        std::env::current_dir().ok().and_then(|d| {
            let p = d.join("../samples/openclaw");
            if p.exists() { Some(p) } else { None }
        })
    }

    #[test]
    fn test_parse_usage_sample_files() {
        let sample_dir = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = OpenClawLocalProvider;
        let file1 = sample_dir.join("session-abc123.jsonl");
        if !file1.exists() { return; }
        let events = provider.parse_usage(&file1.to_string_lossy());
        assert!(events.len() >= 2, "abc123 should have at least 2 usage events");

        for event in &events {
            assert_eq!(event["providerId"], PROVIDER_ID);
            assert_eq!(event["toolCode"], TOOL_CODE);
            assert_eq!(event["sourceKind"], "local_log");
            assert_eq!(event["sourceQuality"], "exact");
            assert_eq!(event["sessionId"], "session-abc123");
            assert!(!event["day"].as_str().unwrap_or("").is_empty());
        }
    }

    #[test]
    fn test_parse_usage_model_tracking() {
        let sample_dir = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = OpenClawLocalProvider;
        let file1 = sample_dir.join("session-abc123.jsonl");
        if !file1.exists() { return; }
        let events = provider.parse_usage(&file1.to_string_lossy());

        for event in &events {
            assert_eq!(
                event["model"], "claude-sonnet-4-20250514",
                "model should be set from model_change event"
            );
        }
    }

    #[test]
    fn test_parse_usage_model_snapshot_and_custom() {
        let sample_dir = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = OpenClawLocalProvider;
        let file = sample_dir.join("session-ghi789.jsonl");
        if !file.exists() { return; }
        let events = provider.parse_usage(&file.to_string_lossy());

        // ghi789 has model-snapshot (deepseek-v3) then custom (gpt-4o-mini)
        let models: std::collections::HashSet<_> = events
            .iter()
            .filter_map(|e| e["model"].as_str().map(String::from))
            .collect();
        assert!(models.contains("deepseek-v3"), "should track model-snapshot, got {:?}", models);
        assert!(models.contains("gpt-4o-mini"), "should track custom model, got {:?}", models);
    }

    #[test]
    fn test_parse_usage_camel_case_aliases() {
        let sample_dir = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = OpenClawLocalProvider;
        let file = sample_dir.join("session-ghi789.jsonl");
        if !file.exists() { return; }
        let events = provider.parse_usage(&file.to_string_lossy());

        // ghi789 uses camelCase: inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens
        let first = events.first().unwrap();
        assert_eq!(first["inputTokens"], 2000);
        assert_eq!(first["outputTokens"], 600);
        assert_eq!(first["cacheReadTokens"], 300);
        assert_eq!(first["cacheWriteTokens"], 100);
        assert_eq!(first["totalTokens"], 3000);
    }

    #[test]
    fn test_parse_usage_snake_case_aliases() {
        let sample_dir = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = OpenClawLocalProvider;
        let file = sample_dir.join("session-ghi789.jsonl");
        if !file.exists() { return; }
        let events = provider.parse_usage(&file.to_string_lossy());

        // ghi789 line 6 uses prompt_tokens/completion_tokens/cached_input_tokens/cache_creation_input_tokens
        let mixed = events.iter().find(|e| e["model"] == "gpt-4o-mini");
        assert!(mixed.is_some(), "should parse prompt_tokens alias");
        let mixed = mixed.unwrap();
        assert_eq!(mixed["inputTokens"], 800);
        assert_eq!(mixed["outputTokens"], 200);
    }

    #[test]
    fn test_parse_usage_workdir_aliases() {
        let sample_dir = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = OpenClawLocalProvider;
        let file = sample_dir.join("session-ghi789.jsonl");
        if !file.exists() { return; }
        let events = provider.parse_usage(&file.to_string_lossy());

        // ghi789 uses "workdir" and "working_directory" field names
        let workdirs: std::collections::HashSet<_> = events
            .iter()
            .filter_map(|e| e["workdirCandidate"].as_str().map(String::from))
            .collect();
        assert!(workdirs.iter().any(|w| w.contains("deep-project")), "should find workdir from 'workdir' field");
        assert!(workdirs.iter().any(|w| w.contains("mixed-project")), "should find workdir from 'working_directory' field");
    }

    #[test]
    fn test_parse_usage_project_path_alias() {
        let sample_dir = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = OpenClawLocalProvider;
        let file = sample_dir.join("session-jkl012.jsonl");
        if !file.exists() { return; }
        let events = provider.parse_usage(&file.to_string_lossy());

        // jkl012 has a record with project_path instead of cwd
        let small_fix = events.iter().find(|e| {
            e["inputTokens"] == 200 && e["outputTokens"] == 50
        });
        assert!(small_fix.is_some(), "should parse project_path alias");
        assert!(small_fix.unwrap()["workdirCandidate"].as_str().unwrap().contains("small-fix"));
    }

    #[test]
    fn test_parse_usage_skip_non_assistant() {
        let sample_dir = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = OpenClawLocalProvider;
        let file1 = sample_dir.join("session-abc123.jsonl");
        if !file1.exists() { return; }
        let events = provider.parse_usage(&file1.to_string_lossy());

        let user_events: Vec<_> = events
            .iter()
            .filter(|e| {
                e["totalTokens"].as_i64().unwrap_or(0) > 0
                    && e["day"].as_str().unwrap_or("") == "2026-06-10"
            })
            .collect();
        assert_eq!(user_events.len(), 2, "should have 2 assistant events with tokens on 2026-06-10");
    }

    #[test]
    fn test_parse_usage_skip_zero_tokens() {
        let sample_dir = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = OpenClawLocalProvider;
        let file2 = sample_dir.join("session-def456.jsonl");
        if !file2.exists() { return; }
        let events = provider.parse_usage(&file2.to_string_lossy());

        let zero_events: Vec<_> = events
            .iter()
            .filter(|e| e["totalTokens"].as_i64().unwrap_or(0) == 0)
            .collect();
        assert!(zero_events.is_empty(), "should not have zero-token events");
    }

    #[test]
    fn test_parse_usage_skip_empty_usage() {
        let sample_dir = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = OpenClawLocalProvider;
        let file = sample_dir.join("session-jkl012.jsonl");
        if !file.exists() { return; }
        let events = provider.parse_usage(&file.to_string_lossy());

        // jkl012 has an empty usage object {} - should be skipped
        let empty_usage: Vec<_> = events.iter().filter(|e| e["totalTokens"] == 0).collect();
        assert!(empty_usage.is_empty(), "should skip empty usage objects");
    }

    #[test]
    fn test_parse_usage_multi_day() {
        let sample_dir = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = OpenClawLocalProvider;

        let mut all_events = Vec::new();
        for entry in std::fs::read_dir(&sample_dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.to_string_lossy().ends_with(".jsonl") {
                all_events.extend(provider.parse_usage(&path.to_string_lossy()));
            }
        }

        let days: std::collections::HashSet<_> = all_events
            .iter()
            .filter_map(|e| e["day"].as_str().map(String::from))
            .collect();
        assert!(days.len() >= 4, "should cover at least 4 days across all files, got {:?}", days);
    }

    #[test]
    fn test_parse_usage_multi_model() {
        let sample_dir = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = OpenClawLocalProvider;

        let mut all_events = Vec::new();
        for entry in std::fs::read_dir(&sample_dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.to_string_lossy().ends_with(".jsonl") {
                all_events.extend(provider.parse_usage(&path.to_string_lossy()));
            }
        }

        let models: std::collections::HashSet<_> = all_events
            .iter()
            .filter_map(|e| e["model"].as_str().map(String::from))
            .collect();
        assert!(models.len() >= 4, "should cover multiple models, got {:?}", models);
        assert!(models.contains("claude-sonnet-4-20250514"));
        assert!(models.contains("gpt-4o"));
        assert!(models.contains("deepseek-v3"));
        assert!(models.contains("gpt-4o-mini"));
    }

    #[test]
    fn test_parse_usage_nonexistent_file() {
        let provider = OpenClawLocalProvider;
        let events = provider.parse_usage("/nonexistent/path/session.jsonl");
        assert!(events.is_empty());
    }

    #[test]
    fn test_scan_sessions_manual_root() {
        let samples = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let mut cfg: AppConfig = serde_json::from_value(serde_json::json!({
            "participantId": "test",
            "nickname": "test",
            "identityPublicKey": "",
            "identityPrivateKey": "",
            "deviceId": "test"
        }))
        .unwrap();
        cfg.provider_roots
            .insert(PROVIDER_ID.into(), vec![samples.to_string_lossy().to_string()]);
        let provider = OpenClawLocalProvider;
        let sessions = provider.scan_sessions(&cfg);
        assert!(sessions.len() >= 4, "should find at least 4 JSONL files, got {}", sessions.len());
    }

    #[test]
    fn test_scan_sessions_disabled() {
        let mut cfg: AppConfig = serde_json::from_value(serde_json::json!({
            "participantId": "test",
            "nickname": "test",
            "identityPublicKey": "",
            "identityPrivateKey": "",
            "deviceId": "test"
        }))
        .unwrap();
        cfg.provider_enabled.insert(PROVIDER_ID.into(), false);
        let provider = OpenClawLocalProvider;
        let sessions = provider.scan_sessions(&cfg);
        assert!(sessions.is_empty());
    }
}
