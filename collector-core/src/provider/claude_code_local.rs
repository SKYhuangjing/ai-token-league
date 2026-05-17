use crate::config::AppConfig;
use crate::provider::common::*;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

pub const PROVIDER_ID: &str = "claude_code_local";
pub const TOOL_CODE: &str = "claude_code";
pub const VERSION: &str = "0.1.1";

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
        let mut events = Vec::new();

        let mut last_model = String::new();
        let mut session_id = Path::new(file)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

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

            // Claude Code does NOT subtract cache from input (ccusage semantics)
            let input_tokens = raw_input_tokens;

            let direct_total = token_field(usage, &["total_tokens", "totalTokens"]);
            let total = input_tokens + output_tokens + cache_read_tokens + cache_write_tokens;
            let total = if total > 0 { total } else { direct_total };

            if total == 0 {
                continue;
            }

            let model = if last_model.is_empty() {
                "unknown".to_string()
            } else {
                last_model.clone()
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
                "sessionId": session_id,
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
    fn test_claude_code_no_cache_subtraction() {
        let usage = json!({
            "input_tokens": 100,
            "output_tokens": 50,
            "cache_read_input_tokens": 30,
            "cache_creation_input_tokens": 20
        });
        // Claude Code: inputTokens = rawInputTokens (no subtraction)
        let input = token_field(&usage, &["input_tokens", "inputTokens", "prompt_tokens"]);
        assert_eq!(input, 100); // NOT 50
    }
}
