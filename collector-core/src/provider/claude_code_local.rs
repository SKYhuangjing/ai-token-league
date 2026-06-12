use crate::config::AppConfig;
use crate::provider::common::*;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

pub const PROVIDER_ID: &str = "claude_code_local";
pub const TOOL_CODE: &str = "claude_code";
pub const VERSION: &str = "0.2.0";

pub struct ClaudeCodeLocalProvider;

impl ClaudeCodeLocalProvider {
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

        let config_root = home.join(".config/claude/projects");
        if config_root.exists() {
            roots.push(config_root.to_string_lossy().to_string());
        }

        let home_root = home.join(".claude/projects");
        if home_root.exists() {
            roots.push(home_root.to_string_lossy().to_string());
        }

        if roots.is_empty() {
            let fallback = std::env::current_dir()
                .unwrap_or_default()
                .join("samples/claude/projects");
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

        let mut last_model = String::new();
        let mut session_id = Path::new(file)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        // First pass: collect usage entries, deduplicate by message ID (keep last occurrence)
        let mut usage_entries: std::collections::HashMap<String, (Value, Value, String, String)> =
            std::collections::HashMap::new();
        let mut ordered_keys: Vec<String> = Vec::new();

        for row in &rows {
            // Model detection: sticky
            let row_model = row
                .get("message")
                .and_then(|m| m.get("model"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| deep_find_string(row, &["model"]));
            if !row_model.is_empty() {
                last_model = row_model;
            }

            // Session ID
            let sid = deep_find_string(row, &["session_id", "sessionId", "conversation_id"]);
            if !sid.is_empty() {
                session_id = sid;
            }

            // Usage extraction: message.usage || usage
            let usage = row
                .get("message")
                .and_then(|m| m.get("usage"))
                .or_else(|| row.get("usage"));

            let usage = match usage {
                Some(u) => u,
                None => continue,
            };

            // Deduplicate by message ID: keep last occurrence per ID
            let msg_id = row
                .get("message")
                .and_then(|m| m.get("id"))
                .and_then(|m| m.as_str())
                .or_else(|| row.get("uuid").and_then(|u| u.as_str()))
                .unwrap_or("")
                .to_string();

            let key = if msg_id.is_empty() {
                format!("{}:{}", session_id, ordered_keys.len())
            } else {
                msg_id
            };

            if !usage_entries.contains_key(&key) {
                ordered_keys.push(key.clone());
            }
            usage_entries.insert(
                key,
                (
                    row.clone(),
                    usage.clone(),
                    last_model.clone(),
                    session_id.clone(),
                ),
            );
        }

        // Second pass: build events from deduplicated entries
        let mut events = Vec::new();

        for key in &ordered_keys {
            let (row, usage, event_model, event_session_id) = match usage_entries.get(key) {
                Some(entry) => entry,
                None => continue,
            };

            // Extract message.id for cross-file global dedup (done in scanner)
            let dedup_key = row
                .get("message")
                .and_then(|m| m.get("id"))
                .and_then(|m| m.as_str())
                .or_else(|| row.get("uuid").and_then(|u| u.as_str()))
                .unwrap_or("")
                .to_string();

            let raw_input_tokens =
                token_field(usage, &["input_tokens", "inputTokens", "prompt_tokens"]);
            let output_tokens = token_field(
                usage,
                &["output_tokens", "outputTokens", "completion_tokens"],
            );
            let cache_read_tokens = token_field(
                usage,
                &[
                    "cache_read_input_tokens",
                    "cacheReadTokens",
                    "cache_read_tokens",
                ],
            );
            let cache_write_tokens = token_field(
                usage,
                &[
                    "cache_creation_input_tokens",
                    "cacheWriteTokens",
                    "cache_write_tokens",
                ],
            );
            let reasoning_tokens = token_field(usage, &["reasoning_tokens", "reasoningTokens"]);

            // Claude Code: input_tokens is separate from cache in the API; use as-is (ccusage semantics)
            let input_tokens = raw_input_tokens;

            let direct_total = token_field(usage, &["total_tokens", "totalTokens"]);
            let total = input_tokens + output_tokens + cache_read_tokens + cache_write_tokens;
            let total = if total > 0 { total } else { direct_total };

            if total == 0 {
                continue;
            }

            let model = if event_model.is_empty() {
                "unknown".to_string()
            } else {
                event_model.clone()
            };

            let quality = if raw_input_tokens > 0 || output_tokens > 0 {
                "exact"
            } else {
                "partial"
            };

            // Workdir candidate
            let mut workdir_candidate = deep_find_string(
                row,
                &["cwd", "workdir", "working_directory", "project_path"],
            );
            if workdir_candidate.is_empty() {
                workdir_candidate = decode_project_dir(file);
            }

            events.push(json!({
                "providerId": PROVIDER_ID,
                "providerVersion": VERSION,
                "toolCode": TOOL_CODE,
                "sourceKind": "local_log",
                "sourceQuality": quality,
                "sessionId": event_session_id,
                "day": day_from_record(row, mtime_ms),
                "hour": hour_from_record(row, mtime_ms),
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
                "_dedupKey": dedup_key,
            }));
        }

        events
    }
}

/// Decode Claude Code's project directory encoding.
/// Paths like `-Users-sky-foo` are decoded to `/Users/sky/foo`.
fn decode_project_dir(file: &str) -> String {
    let path = Path::new(file);
    let components: Vec<&std::ffi::OsStr> = path
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s),
            _ => None,
        })
        .collect();

    // Find last "projects" segment
    let projects_idx = components
        .iter()
        .rposition(|c| c == &std::ffi::OsStr::new("projects"));
    match projects_idx {
        Some(idx) if idx + 1 < components.len() => {
            let encoded = components[idx + 1].to_string_lossy();
            if encoded.starts_with('-') {
                // Decode: leading '-' -> '/', all '-' -> '/'
                let decoded: String = encoded[1..].replace('-', "/");
                format!("/{}", decoded)
            } else {
                encoded.to_string()
            }
        }
        _ => std::env::current_dir()
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_default(),
    }
}

fn token_field(usage: &Value, aliases: &[&str]) -> i64 {
    for alias in aliases {
        if let Some(n) = usage.get(*alias).and_then(|v| v.as_f64()) {
            if n.is_finite() && n > 0.0 {
                return n.round() as i64;
            }
            return 0;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_project_dir_dashed() {
        let result =
            decode_project_dir("/home/.claude/projects/-Users-sky-my-project/session.jsonl");
        assert_eq!(result, "/Users/sky/my/project");
    }

    #[test]
    fn test_decode_project_dir_normal() {
        let result = decode_project_dir("/home/.claude/projects/myproject/session.jsonl");
        assert_eq!(result, "myproject");
    }

    #[test]
    fn test_claude_code_input_tokens_includes_no_cache_subtraction() {
        let usage = json!({
            "input_tokens": 100,
            "output_tokens": 50,
            "cache_read_input_tokens": 30,
            "cache_creation_input_tokens": 20
        });
        // Claude Code: input_tokens is kept as-is; total = sum of all four fields
        let raw_input = token_field(&usage, &["input_tokens", "inputTokens", "prompt_tokens"]);
        let cache_read = token_field(
            &usage,
            &[
                "cache_read_input_tokens",
                "cacheReadTokens",
                "cache_read_tokens",
            ],
        );
        let cache_write = token_field(
            &usage,
            &[
                "cache_creation_input_tokens",
                "cacheWriteTokens",
                "cache_write_tokens",
            ],
        );
        let output = token_field(
            &usage,
            &["output_tokens", "outputTokens", "completion_tokens"],
        );
        assert_eq!(raw_input, 100);
        assert_eq!(cache_read, 30);
        assert_eq!(cache_write, 20);
        let total = raw_input + output + cache_read + cache_write;
        assert_eq!(total, 200); // 100 + 50 + 30 + 20
    }

    #[test]
    fn test_parse_usage_preserves_model_at_each_message() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("atl-claude-models-{}.jsonl", suffix));
        let rows = [
            json!({
                "timestamp": "2026-06-01T10:00:00Z",
                "sessionId": "session-a",
                "message": {
                    "id": "message-a",
                    "model": "model-a",
                    "usage": {"input_tokens": 10, "output_tokens": 1}
                }
            }),
            json!({
                "timestamp": "2026-06-01T11:00:00Z",
                "sessionId": "session-b",
                "message": {
                    "id": "message-b",
                    "model": "model-b",
                    "usage": {"input_tokens": 20, "output_tokens": 2}
                }
            }),
        ];
        let content = rows
            .iter()
            .map(|row| serde_json::to_string(row).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&path, content).unwrap();

        let events = ClaudeCodeLocalProvider.parse_usage(&path.to_string_lossy());

        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["model"], "model-a");
        assert_eq!(events[0]["sessionId"], "session-a");
        assert_eq!(events[1]["model"], "model-b");
        assert_eq!(events[1]["sessionId"], "session-b");
        let _ = fs::remove_file(path);
    }
}
