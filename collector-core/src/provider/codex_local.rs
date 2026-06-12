use crate::config::AppConfig;
use crate::provider::common::*;
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::Path;

pub const PROVIDER_ID: &str = "codex_local";
pub const TOOL_CODE: &str = "codex";
pub const VERSION: &str = "0.2.0";

pub struct CodexProvider;

impl CodexProvider {
    pub fn id(&self) -> &str {
        PROVIDER_ID
    }
    pub fn tool_code(&self) -> &str {
        TOOL_CODE
    }
    pub fn version(&self) -> &str {
        VERSION
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

    pub fn auto_roots(&self, _config: &AppConfig) -> Vec<String> {
        let home = dirs::home_dir().unwrap_or_default();
        let mut roots = Vec::new();

        if let Ok(codex_home) = std::env::var("CODEX_HOME") {
            for value in codex_home
                .split(',')
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                add_codex_usage_roots(Path::new(value), &mut roots);
            }
        }
        if roots.is_empty() {
            add_codex_usage_roots(&home.join(".codex"), &mut roots);
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
        let mut manual = Vec::new();
        for root in self.manual_roots(config) {
            add_codex_usage_roots(Path::new(&root), &mut manual);
        }

        let mut files = Vec::new();
        for root in auto.iter().chain(manual.iter()) {
            let found = walk_files(root, |f| f.ends_with(".jsonl"), 1000);
            files.extend(found);
        }
        dedupe_active_and_archived_files(files)
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
        let replay_second = detect_subagent_replay_second(&rows, is_codex_subagent_session(file));
        let mut skip_replay = replay_second.is_some();

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
            if let Some(model) = codex_model_from_row(row) {
                current_model = model;
            }

            if let Some(replay_second) = replay_second.as_deref() {
                if skip_replay && is_token_count_row(row) {
                    let Some(second) = timestamp_second(row) else {
                        continue;
                    };
                    if second == replay_second {
                        continue;
                    }
                    skip_replay = false;
                }
            }

            let usage = match extract_usage(row) {
                Some(u) => u,
                None => continue,
            };

            let normalized_model = normalize_codex_model(&current_model);
            let normalized_model = if normalized_model.is_empty() {
                "gpt-5".to_string()
            } else {
                normalized_model
            };

            let total_tokens = usage.delta_total(previous_cumulative_total);
            if total_tokens == 0 {
                continue;
            }

            let workdir_candidate = if !session_cwd.is_empty() {
                session_cwd.clone()
            } else {
                let found = deep_find_string(
                    row,
                    &["cwd", "workdir", "working_directory", "project_path"],
                );
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
                "_codexDedupKey": codex_dedup_key(row, &normalized_model, &usage),
            }));

            if usage.cumulative_total > 0 {
                previous_cumulative_total = usage.cumulative_total;
            }
        }

        events
    }
}

fn add_codex_usage_roots(home_or_usage_dir: &Path, roots: &mut Vec<String>) {
    let sessions = home_or_usage_dir.join("sessions");
    let archived = home_or_usage_dir.join("archived_sessions");
    let mut found = false;
    for path in [&sessions, &archived] {
        if path.is_dir() {
            let value = path.to_string_lossy().to_string();
            if !roots.contains(&value) {
                roots.push(value);
            }
            found = true;
        }
    }
    if !found && home_or_usage_dir.is_dir() {
        let value = home_or_usage_dir.to_string_lossy().to_string();
        if !roots.contains(&value) {
            roots.push(value);
        }
    }
}

fn dedupe_active_and_archived_files(files: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut sorted = files;
    sorted.sort_by_key(|file| file.contains("/archived_sessions/"));
    sorted
        .into_iter()
        .filter(|file| seen.insert(codex_file_key(file)))
        .collect()
}

fn codex_file_key(file: &str) -> String {
    for marker in ["/sessions/", "/archived_sessions/"] {
        if let Some((home, relative)) = file.split_once(marker) {
            return format!("{}|{}", home, relative);
        }
    }
    file.to_string()
}

fn is_token_count_row(row: &Value) -> bool {
    row["type"].as_str() == Some("event_msg")
        && row["payload"]["type"].as_str() == Some("token_count")
}

fn timestamp_second(row: &Value) -> Option<String> {
    let timestamp = row.get("timestamp")?.as_str()?.trim();
    (timestamp.len() >= 19).then(|| timestamp[..19].to_string())
}

fn is_codex_subagent_session(file: &str) -> bool {
    let Ok(mut file) = fs::File::open(file) else {
        return false;
    };
    let mut buffer = [0u8; 16 * 1024];
    let Ok(bytes_read) = file.read(&mut buffer) else {
        return false;
    };
    buffer[..bytes_read]
        .windows(b"thread_spawn".len())
        .any(|window| window == b"thread_spawn")
}

fn detect_subagent_replay_second(rows: &[Value], is_subagent: bool) -> Option<String> {
    if !is_subagent {
        return None;
    }
    let mut seconds = rows
        .iter()
        .filter(|row| {
            is_token_count_row(row)
                && (row["payload"]["info"]["last_token_usage"].is_object()
                    || row["payload"]["info"]["total_token_usage"].is_object())
        })
        .filter_map(timestamp_second);
    let first = seconds.next()?;
    (seconds.next().as_deref() == Some(first.as_str())).then_some(first)
}

fn codex_dedup_key(row: &Value, model: &str, usage: &UsageResult) -> String {
    let timestamp = row
        .get("timestamp")
        .and_then(Value::as_str)
        .unwrap_or_default();
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        timestamp,
        model,
        usage.raw_input_tokens,
        usage.cache_read_tokens,
        usage.output_tokens,
        usage.reasoning_tokens,
        usage.raw_total_tokens
    )
}

fn normalize_codex_model(model: &str) -> String {
    let value = model.trim();
    if value.is_empty() || value == "codex-default" {
        return String::new();
    }
    value.to_string()
}

fn codex_model_from_row(row: &Value) -> Option<String> {
    let value = if row["type"].as_str() == Some("turn_context") {
        explicit_model(row.get("payload"))
    } else if is_token_count_row(row) {
        explicit_model(row.get("payload")).or_else(|| explicit_model(row.pointer("/payload/info")))
    } else {
        explicit_model(Some(row))
            .or_else(|| explicit_model(row.get("data")))
            .or_else(|| explicit_model(row.get("result")))
            .or_else(|| explicit_model(row.get("response")))
    };
    value.and_then(|model| {
        let trimmed = model.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn explicit_model(value: Option<&Value>) -> Option<&str> {
    let value = value?;
    value
        .get("model")
        .and_then(Value::as_str)
        .or_else(|| value.get("model_name").and_then(Value::as_str))
        .or_else(|| value.get("model_slug").and_then(Value::as_str))
        .or_else(|| value.pointer("/metadata/model").and_then(Value::as_str))
}

struct UsageResult {
    raw_input_tokens: i64,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    reasoning_tokens: i64,
    cumulative_total: i64,
    quality: String,
    is_cumulative: bool,
    total: i64,
    raw_total_tokens: i64,
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
    let output_tokens = token_field(
        usage,
        &["output_tokens", "outputTokens", "completion_tokens"],
    );
    let cache_read_tokens = token_field(
        usage,
        &[
            "cached_input_tokens",
            "cache_read_tokens",
            "cacheReadTokens",
        ],
    );
    let cache_write_tokens = token_field(
        usage,
        &[
            "cache_creation_input_tokens",
            "cacheWriteTokens",
            "cache_write_tokens",
            "cached_input_write_tokens",
        ],
    );
    let reasoning_tokens = token_field(
        usage,
        &[
            "reasoning_output_tokens",
            "reasoning_tokens",
            "reasoningTokens",
        ],
    );

    // Codex: subtract cache tokens from input
    let input_tokens = 0i64.max(raw_input_tokens - cache_read_tokens - cache_write_tokens);

    let direct_total = token_field(usage, &["total_tokens", "totalTokens"]);
    let total = input_tokens + output_tokens + cache_read_tokens + cache_write_tokens;
    let total = if total > 0 { total } else { direct_total };

    if total <= 0 {
        return None;
    }

    let is_cumulative =
        sample_usage.is_some() && info.and_then(|i| i.get("last_token_usage")).is_none();
    let quality = if raw_input_tokens > 0 || output_tokens > 0 {
        "exact"
    } else {
        "partial"
    };

    Some(UsageResult {
        raw_input_tokens,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        reasoning_tokens,
        cumulative_total: if is_cumulative { total } else { 0 },
        quality: quality.to_string(),
        is_cumulative,
        total,
        raw_total_tokens: if direct_total > 0 {
            direct_total
        } else {
            total
        },
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

    #[test]
    fn test_manual_codex_home_uses_sessions_and_archived_subdirs() {
        let root = std::env::temp_dir().join(format!(
            "atl-codex-root-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let sessions = root.join("sessions");
        let archived = root.join("archived_sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::create_dir_all(&archived).unwrap();

        let mut roots = Vec::new();
        add_codex_usage_roots(&root, &mut roots);
        assert_eq!(
            roots,
            vec![
                sessions.to_string_lossy().to_string(),
                archived.to_string_lossy().to_string()
            ]
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn test_dedupes_active_and_archived_relative_copy() {
        let files = vec![
            "/tmp/codex/archived_sessions/a/session.jsonl".to_string(),
            "/tmp/codex/sessions/a/session.jsonl".to_string(),
            "/tmp/codex/archived_sessions/a/other.jsonl".to_string(),
        ];
        let result = dedupe_active_and_archived_files(files);
        assert_eq!(result.len(), 2);
        assert!(result
            .iter()
            .any(|file| file.contains("/sessions/a/session.jsonl")));
        assert!(!result
            .iter()
            .any(|file| file.contains("/archived_sessions/a/session.jsonl")));
    }

    #[test]
    fn test_detects_thread_spawn_replay_second() {
        let rows = vec![
            json!({"type":"session_meta","payload":{"source":{"subagent":{"thread_spawn":{}}}}}),
            json!({"timestamp":"2026-05-12T08:01:00.100Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":1}}}}),
            json!({"timestamp":"2026-05-12T08:01:00.900Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":20,"output_tokens":2}}}}),
            json!({"timestamp":"2026-05-12T08:02:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":30,"output_tokens":3}}}}),
        ];
        assert_eq!(
            detect_subagent_replay_second(&rows, true).as_deref(),
            Some("2026-05-12T08:01:00")
        );
    }
}
