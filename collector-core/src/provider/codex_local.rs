use crate::config::AppConfig;
use crate::provider::common::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

pub const PROVIDER_ID: &str = "codex_local";
pub const TOOL_CODE: &str = "codex";
pub const VERSION: &str = "0.3.0";

pub struct CodexProvider;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReplayUsage {
    raw_input_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    output_tokens: i64,
    reasoning_tokens: i64,
    raw_total_tokens: i64,
}

#[derive(Default)]
struct SessionMetadata {
    session_id: String,
    parent_id: Option<String>,
    timestamp_ms: Option<i64>,
}

/// Builds the parent usage prefix that a forked Codex session replays.
///
/// Codex rewrites the timestamps of copied token_count rows, so timestamp or
/// event-key deduplication cannot identify the replay reliably. The immutable
/// usage sequence in the parent log is the stable identity we can compare.
pub(crate) struct CodexReplayPlan {
    prefix_by_child: HashMap<String, Vec<ReplayUsage>>,
}

impl CodexReplayPlan {
    pub(crate) fn new(files: &[String]) -> Self {
        let metadata = files
            .iter()
            .map(|file| (file.clone(), read_session_metadata(file)))
            .collect::<HashMap<_, _>>();
        let mut file_by_session_id = HashMap::new();
        for (file, session) in &metadata {
            if !session.session_id.is_empty() {
                file_by_session_id
                    .entry(session.session_id.clone())
                    .or_insert_with(|| file.clone());
            }
        }

        let mut prefix_by_child = HashMap::new();
        let mut parent_usage_cache = HashMap::new();
        for (child_file, child) in &metadata {
            let Some(parent_id) = child.parent_id.as_deref() else {
                continue;
            };
            let parent_usage = file_by_session_id
                .get(parent_id)
                .map(|parent_file| {
                    parent_usage_cache
                        .entry(parent_file.clone())
                        .or_insert_with(|| replay_usage_events(parent_file))
                        .clone()
                })
                .unwrap_or_default();
            let prefix = parent_usage
                .into_iter()
                .take_while(|(timestamp_ms, _)| {
                    child.timestamp_ms.map_or(true, |forked_at| {
                        timestamp_ms.map_or(true, |timestamp| timestamp <= forked_at)
                    })
                })
                .map(|(_, usage)| usage)
                .collect();
            prefix_by_child.insert(child_file.clone(), prefix);
        }

        Self { prefix_by_child }
    }

    pub(crate) fn replay_prefix(&self, child_file: &str) -> Option<&[ReplayUsage]> {
        self.prefix_by_child.get(child_file).map(Vec::as_slice)
    }
}

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
            let found = walk_files(root, |f| f.ends_with(".jsonl"), 10_000);
            files.extend(found);
        }
        dedupe_active_and_archived_files(files)
    }

    pub fn parse_usage(&self, file: &str) -> Vec<Value> {
        self.parse_usage_with_replay(file, None)
    }

    pub(crate) fn parse_usage_with_replay(
        &self,
        file: &str,
        replay_prefix: Option<&[ReplayUsage]>,
    ) -> Vec<Value> {
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

        let source = codex_source_metadata(file);
        let rows = read_json_lines(file);
        let mut events = Vec::new();
        let replay_fallback = replay_prefix.is_some() || is_codex_subagent_session(file);
        let replay_start_ms = detect_replay_burst_start_ms(&rows, replay_fallback);
        let mut replay_state = replay_prefix
            .map(|prefix| ReplayState::Matching { prefix, index: 0 })
            .unwrap_or(ReplayState::Done);

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
        let mut previous_cumulative_usage: Option<RawUsage> = None;

        for row in &rows {
            if let Some(model) = codex_model_from_row(row) {
                current_model = model;
            }

            let usage = match extract_usage_with_previous(row, &mut previous_cumulative_usage) {
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

            let replay_usage = ReplayUsage::from(&usage);
            if !accept_replay_event(
                &mut replay_state,
                replay_usage,
                timestamp_ms(row),
                replay_start_ms,
            ) {
                if usage.cumulative_total > 0 {
                    previous_cumulative_total = usage.cumulative_total;
                }
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

/// Codex rollout filenames embed a session UUID, so the basename alone is a
/// stable identity for a session file regardless of which directory holds it.
/// The fingerprint must survive Codex relocating files between `sessions/`
/// and `archived_sessions/`, otherwise every relocation invalidates the scan
/// cache and re-uploads history with a re-derived (order-sensitive) total.
fn codex_stable_key(file: &str) -> String {
    Path::new(file)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn codex_source_metadata(file: &str) -> crate::provider::common::SourceMetadata {
    crate::provider::common::source_metadata_with_stable_key(
        file,
        &codex_stable_key(file),
        PROVIDER_ID,
        VERSION,
    )
}

/// Collapse duplicate copies of the same session (same basename under one
/// codex home, e.g. present in both `sessions/` and `archived_sessions/`)
/// preferring the active `sessions/` copy, then order the result by basename
/// so parse order — and therefore replay-prefix matching and keep-first
/// global dedup — is a pure function of the file set, not of directory
/// layout or readdir order.
fn dedupe_active_and_archived_files(files: Vec<String>) -> Vec<String> {
    let mut sorted = files;
    sorted.sort_by_key(|file| (file.contains("/archived_sessions/"), codex_file_key(file)));
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = sorted
        .into_iter()
        .filter(|file| seen.insert(codex_file_key(file)))
        .collect();
    out.sort_by(|a, b| {
        codex_stable_key(a)
            .cmp(&codex_stable_key(b))
            .then_with(|| a.cmp(b))
    });
    out
}

fn codex_file_key(file: &str) -> String {
    for marker in ["/sessions/", "/archived_sessions/"] {
        if let Some((home, relative)) = file.split_once(marker) {
            let basename = relative.rsplit('/').next().unwrap_or(relative);
            return format!("{}|{}", home, basename);
        }
    }
    file.to_string()
}

enum ReplayState<'a> {
    Matching {
        prefix: &'a [ReplayUsage],
        index: usize,
    },
    SkippingBurst {
        last_timestamp_ms: i64,
    },
    Done,
}

fn accept_replay_event(
    state: &mut ReplayState<'_>,
    usage: ReplayUsage,
    timestamp_ms: Option<i64>,
    replay_start_ms: Option<i64>,
) -> bool {
    loop {
        match state {
            ReplayState::Matching { prefix, index } => {
                if prefix.get(*index) == Some(&usage) {
                    *index += 1;
                    return false;
                }

                if *index == 0 {
                    if let Some(start_ms) = replay_start_ms {
                        *state = ReplayState::SkippingBurst {
                            last_timestamp_ms: start_ms,
                        };
                        continue;
                    }
                }
                *state = ReplayState::Done;
            }
            ReplayState::SkippingBurst { last_timestamp_ms } => {
                let Some(timestamp_ms) = timestamp_ms else {
                    *state = ReplayState::Done;
                    continue;
                };
                if timestamp_ms >= *last_timestamp_ms && timestamp_ms - *last_timestamp_ms <= 1_000
                {
                    *last_timestamp_ms = timestamp_ms;
                    return false;
                }
                *state = ReplayState::Done;
            }
            ReplayState::Done => return true,
        }
    }
}

fn read_session_metadata(file: &str) -> SessionMetadata {
    let Ok(file) = fs::File::open(file) else {
        return SessionMetadata::default();
    };
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return SessionMetadata::default();
    }
    let Ok(row) = serde_json::from_str::<Value>(&line) else {
        return SessionMetadata::default();
    };
    let payload = (row["type"].as_str() == Some("session_meta")).then_some(&row["payload"]);
    let Some(payload) = payload else {
        return SessionMetadata::default();
    };
    let session_id = payload["id"]
        .as_str()
        .or_else(|| payload["session_id"].as_str())
        .unwrap_or_default()
        .to_string();
    let parent_id = payload["forked_from_id"]
        .as_str()
        .or_else(|| {
            payload
                .pointer("/source/subagent/thread_spawn/parent_thread_id")
                .and_then(Value::as_str)
        })
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    SessionMetadata {
        session_id,
        parent_id,
        timestamp_ms: timestamp_ms(&row)
            .or_else(|| payload["timestamp"].as_str().and_then(parse_timestamp_ms)),
    }
}

fn replay_usage_events(file: &str) -> Vec<(Option<i64>, ReplayUsage)> {
    let rows = read_json_lines(file);
    let mut previous_cumulative_usage = None;
    let mut events = Vec::new();
    for row in rows {
        if !is_token_count_row(&row) {
            continue;
        }
        let Some(usage) = extract_usage_with_previous(&row, &mut previous_cumulative_usage) else {
            continue;
        };
        if usage.delta_total(0) == 0 {
            continue;
        }
        events.push((timestamp_ms(&row), ReplayUsage::from(&usage)));
    }
    events
}

fn is_token_count_row(row: &Value) -> bool {
    row["type"].as_str() == Some("event_msg")
        && row["payload"]["type"].as_str() == Some("token_count")
}

fn timestamp_ms(row: &Value) -> Option<i64> {
    row.get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_timestamp_ms)
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

fn detect_replay_burst_start_ms(rows: &[Value], is_fork: bool) -> Option<i64> {
    if !is_fork {
        return None;
    }
    let mut timestamps = rows
        .iter()
        .filter(|row| is_token_count_row(row))
        .filter_map(timestamp_ms);
    let first = timestamps.next()?;
    let second = timestamps.next()?;
    (second >= first && second - first <= 1_000).then_some(first)
}

fn parse_timestamp_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
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

#[derive(Clone, Debug, Eq, PartialEq)]
struct RawUsage {
    raw_input_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    output_tokens: i64,
    reasoning_tokens: i64,
    raw_total_tokens: i64,
}

impl RawUsage {
    fn subtract(&self, previous: Option<&RawUsage>) -> Self {
        let previous = previous.cloned().unwrap_or_else(|| RawUsage {
            raw_input_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0,
            raw_total_tokens: 0,
        });
        Self {
            raw_input_tokens: (self.raw_input_tokens - previous.raw_input_tokens).max(0),
            cache_read_tokens: (self.cache_read_tokens - previous.cache_read_tokens).max(0),
            cache_write_tokens: (self.cache_write_tokens - previous.cache_write_tokens).max(0),
            output_tokens: (self.output_tokens - previous.output_tokens).max(0),
            reasoning_tokens: (self.reasoning_tokens - previous.reasoning_tokens).max(0),
            raw_total_tokens: (self.raw_total_tokens - previous.raw_total_tokens).max(0),
        }
    }
}

#[derive(Clone)]
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

#[cfg(test)]
fn extract_usage(row: &Value) -> Option<UsageResult> {
    let mut previous = None;
    extract_usage_with_previous(row, &mut previous)
}

fn extract_usage_with_previous(
    row: &Value,
    previous_cumulative_usage: &mut Option<RawUsage>,
) -> Option<UsageResult> {
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

    if let Some(info_val) = info {
        let last_usage = info_val
            .get("last_token_usage")
            .and_then(raw_usage_from_value);
        let total_usage = info_val
            .get("total_token_usage")
            .and_then(raw_usage_from_value);

        if let Some(total_usage) = total_usage {
            let previous = previous_cumulative_usage.clone();
            let advanced = previous.as_ref() != Some(&total_usage);
            *previous_cumulative_usage = Some(total_usage.clone());
            let raw = if advanced {
                last_usage.unwrap_or_else(|| total_usage.subtract(previous.as_ref()))
            } else {
                total_usage.subtract(previous.as_ref())
            };
            return usage_result(raw, false);
        }

        if let Some(last_usage) = last_usage {
            return usage_result(last_usage, false);
        }

        return sample_usage
            .and_then(raw_usage_from_value)
            .and_then(|raw| usage_result(raw, true));
    }

    sample_usage
        .and_then(raw_usage_from_value)
        .and_then(|raw| usage_result(raw, true))
}

fn raw_usage_from_value(usage: &Value) -> Option<RawUsage> {
    let raw_input_tokens = token_field(usage, &["input_tokens", "inputTokens", "prompt_tokens"]);
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
    let output_tokens = token_field(
        usage,
        &["output_tokens", "outputTokens", "completion_tokens"],
    );
    let reasoning_tokens = token_field(
        usage,
        &[
            "reasoning_output_tokens",
            "reasoning_tokens",
            "reasoningTokens",
        ],
    );
    let direct_total = token_field(usage, &["total_tokens", "totalTokens"]);
    let raw_total_tokens = if direct_total > 0 {
        direct_total
    } else {
        raw_input_tokens + output_tokens
    };

    if raw_input_tokens == 0
        && cache_read_tokens == 0
        && cache_write_tokens == 0
        && output_tokens == 0
        && reasoning_tokens == 0
        && raw_total_tokens == 0
    {
        return None;
    }

    Some(RawUsage {
        raw_input_tokens,
        cache_read_tokens,
        cache_write_tokens,
        output_tokens,
        reasoning_tokens,
        raw_total_tokens,
    })
}

fn usage_result(raw: RawUsage, is_cumulative: bool) -> Option<UsageResult> {
    // Codex input_tokens includes cached input; keep cache in its own fields.
    let input_tokens =
        0i64.max(raw.raw_input_tokens - raw.cache_read_tokens - raw.cache_write_tokens);
    let total = input_tokens + raw.output_tokens + raw.cache_read_tokens + raw.cache_write_tokens;
    if total <= 0 {
        return None;
    }

    let quality = if raw.raw_input_tokens > 0 || raw.output_tokens > 0 {
        "exact"
    } else {
        "partial"
    };
    Some(UsageResult {
        raw_input_tokens: raw.raw_input_tokens,
        input_tokens,
        output_tokens: raw.output_tokens,
        cache_read_tokens: raw.cache_read_tokens,
        cache_write_tokens: raw.cache_write_tokens,
        reasoning_tokens: raw.reasoning_tokens,
        cumulative_total: if is_cumulative { total } else { 0 },
        quality: quality.to_string(),
        is_cumulative,
        total,
        raw_total_tokens: raw.raw_total_tokens,
    })
}

impl From<&UsageResult> for ReplayUsage {
    fn from(usage: &UsageResult) -> Self {
        Self {
            raw_input_tokens: usage.raw_input_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cache_write_tokens: usage.cache_write_tokens,
            output_tokens: usage.output_tokens,
            reasoning_tokens: usage.reasoning_tokens,
            raw_total_tokens: usage.raw_total_tokens,
        }
    }
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
            detect_replay_burst_start_ms(&rows, true),
            parse_timestamp_ms("2026-05-12T08:01:00.100Z")
        );
    }

    #[test]
    fn test_replay_prefix_skips_only_matching_parent_usage() {
        let first = ReplayUsage {
            raw_input_tokens: 100,
            cache_read_tokens: 10,
            cache_write_tokens: 0,
            output_tokens: 5,
            reasoning_tokens: 2,
            raw_total_tokens: 105,
        };
        let second = ReplayUsage {
            raw_input_tokens: 40,
            cache_read_tokens: 4,
            cache_write_tokens: 0,
            output_tokens: 3,
            reasoning_tokens: 1,
            raw_total_tokens: 43,
        };
        let prefix = vec![first.clone(), second.clone()];
        let mut state = ReplayState::Matching {
            prefix: &prefix,
            index: 0,
        };

        assert!(!accept_replay_event(&mut state, first, Some(1), None));
        assert!(!accept_replay_event(&mut state, second, Some(2), None));
        assert!(accept_replay_event(
            &mut state,
            ReplayUsage {
                raw_input_tokens: 7,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                output_tokens: 3,
                reasoning_tokens: 0,
                raw_total_tokens: 10,
            },
            Some(10),
            None,
        ));
    }

    #[test]
    fn test_replay_burst_fallback_crosses_second_boundary() {
        let prefix: &[ReplayUsage] = &[];
        let mut state = ReplayState::Matching { prefix, index: 0 };
        let first = parse_timestamp_ms("2026-05-12T08:01:59.900Z").unwrap();
        let second = parse_timestamp_ms("2026-05-12T08:02:00.100Z").unwrap();
        let own = parse_timestamp_ms("2026-05-12T08:02:06.000Z").unwrap();
        let replay_start = Some(first);
        let usage = || ReplayUsage {
            raw_input_tokens: 10,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            output_tokens: 1,
            reasoning_tokens: 0,
            raw_total_tokens: 11,
        };

        assert!(!accept_replay_event(
            &mut state,
            usage(),
            Some(first),
            replay_start,
        ));
        assert!(!accept_replay_event(
            &mut state,
            usage(),
            Some(second),
            replay_start,
        ));
        assert!(accept_replay_event(
            &mut state,
            usage(),
            Some(own),
            replay_start,
        ));
    }

    #[test]
    fn test_duplicate_snapshot_without_cumulative_progress_is_ignored() {
        let row = |timestamp| {
            json!({
                "timestamp": timestamp,
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {
                            "input_tokens": 100,
                            "output_tokens": 5,
                            "total_tokens": 105
                        },
                        "total_token_usage": {
                            "input_tokens": 100,
                            "output_tokens": 5,
                            "total_tokens": 105
                        }
                    }
                }
            })
        };
        let mut previous = None;
        assert!(extract_usage_with_previous(&row("2026-05-12T08:00:00Z"), &mut previous).is_some());
        assert!(extract_usage_with_previous(&row("2026-05-12T08:00:01Z"), &mut previous).is_none());
    }

    #[test]
    fn test_replay_plan_removes_parent_prefix_from_child() {
        let root = std::env::temp_dir().join(format!(
            "atl-codex-replay-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let parent = root.join("parent.jsonl");
        let child = root.join("child.jsonl");
        let parent_rows = vec![
            json!({
                "timestamp": "2026-05-12T08:00:00Z",
                "type": "session_meta",
                "payload": {"id": "parent"}
            }),
            json!({"timestamp":"2026-05-12T08:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110}}}}),
            json!({"timestamp":"2026-05-12T08:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":50,"output_tokens":5,"total_tokens":55}}}}),
        ];
        let child_rows = vec![
            json!({
                "timestamp": "2026-05-12T08:00:02.500Z",
                "type": "session_meta",
                "payload": {"id": "child", "forked_from_id": "parent"}
            }),
            json!({"timestamp":"2026-05-12T08:00:02.600Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110}}}}),
            json!({"timestamp":"2026-05-12T08:00:02.700Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":50,"output_tokens":5,"total_tokens":55}}}}),
            json!({"timestamp":"2026-05-12T08:00:10Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}}),
        ];
        for (path, rows) in [(&parent, parent_rows), (&child, child_rows)] {
            let content = rows
                .iter()
                .map(|row| serde_json::to_string(row).unwrap())
                .collect::<Vec<_>>()
                .join("\n");
            std::fs::write(path, content).unwrap();
        }

        let files = vec![
            parent.to_string_lossy().to_string(),
            child.to_string_lossy().to_string(),
        ];
        let plan = CodexReplayPlan::new(&files);
        let events = CodexProvider.parse_usage_with_replay(
            &child.to_string_lossy(),
            plan.replay_prefix(&child.to_string_lossy()),
        );

        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["totalTokens"], 10);
        let _ = std::fs::remove_dir_all(root);
    }

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("atl-codex-{}-{}", label, suffix));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cumulative_row(ts: &str, total_tokens: i64) -> Value {
        json!({
            "timestamp": ts,
            "type": "event_msg",
            "payload": {"type": "token_count", "info": {"total_token_usage": {
                "input_tokens": total_tokens,
                "cached_input_tokens": 0,
                "cache_write_input_tokens": 0,
                "output_tokens": 0,
                "reasoning_output_tokens": 0,
                "total_tokens": total_tokens
            }}}
        })
    }

    fn write_rollout(path: &std::path::Path, rows: &[Value]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let content = rows
            .iter()
            .map(|row| serde_json::to_string(row).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(path, content).unwrap();
    }

    /// Regression for the 2026-09-05 incident: Codex moved 905 rollout files
    /// from `sessions/YYYY/MM/DD/` to a flat `archived_sessions/`, every file
    /// fingerprint changed (path was hashed), the codex cache cold-rebuilt,
    /// and the re-derived total silently moved history down by ~3.8e8 tokens.
    #[test]
    fn codex_source_fingerprint_survives_archive_move() {
        let root = unique_temp_dir("fp-move");
        let sessions_dir = root.join("sessions/2026/08/01");
        let archived_dir = root.join("archived_sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        std::fs::create_dir_all(&archived_dir).unwrap();

        let name = "rollout-2026-08-01T10-00-00-019d0a2b-721d-7ee0-87fa-3d841c771ed0.jsonl";
        let sessions_path = sessions_dir.join(name);
        let archived_path = archived_dir.join(name);
        write_rollout(
            &sessions_path,
            &[
                json!({"timestamp":"2026-08-01T10:00:00Z","type":"session_meta","payload":{"id":"s1","cwd":"/tmp/proj"}}),
                cumulative_row("2026-08-01T10:00:01Z", 1_000),
                cumulative_row("2026-08-01T10:00:02Z", 2_000),
            ],
        );

        let before = codex_source_metadata(&sessions_path.to_string_lossy());
        std::fs::rename(&sessions_path, &archived_path).unwrap();
        let after = codex_source_metadata(&archived_path.to_string_lossy());

        assert_eq!(
            before.source_fingerprint, after.source_fingerprint,
            "moving a rollout between sessions/ and archived_sessions/ must not change its fingerprint"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn dedupe_active_and_archived_is_order_independent() {
        let files = vec![
            "/tmp/codex/archived_sessions/b.jsonl".to_string(),
            "/tmp/codex/sessions/2026/08/01/a.jsonl".to_string(),
            "/tmp/codex/archived_sessions/a.jsonl".to_string(),
            "/tmp/codex/sessions/2026/08/01/c.jsonl".to_string(),
        ];
        let once = dedupe_active_and_archived_files(files.clone());
        let twice = dedupe_active_and_archived_files(files.into_iter().rev().collect());

        assert_eq!(once, twice, "scan order must be a function of the file set");
        assert_eq!(once.len(), 3);
        assert!(once.iter().any(|f| f.ends_with("/sessions/2026/08/01/a.jsonl")));
        assert!(!once.iter().any(|f| f.contains("/archived_sessions/a.jsonl")));
        // deterministic basename ordering
        let names: Vec<String> = once
            .iter()
            .map(|f| codex_stable_key(f))
            .collect();
        assert_eq!(names, vec!["a.jsonl", "b.jsonl", "c.jsonl"]);
    }

    /// Parse a synthetic codex family exactly like scanner.rs does: replay
    /// plan, per-file parse, keep-first global dedup on `_codexDedupKey`.
    fn scan_family_totals(files: &[String]) -> (i64, std::collections::HashMap<String, i64>) {
        let files = dedupe_active_and_archived_files(files.to_vec());
        let plan = CodexReplayPlan::new(&files);
        let mut seen = std::collections::HashSet::new();
        let mut per_file = std::collections::HashMap::new();
        let mut total = 0i64;
        for file in &files {
            for event in CodexProvider.parse_usage_with_replay(file, plan.replay_prefix(file)) {
                let key = event["_codexDedupKey"].as_str().unwrap_or_default().to_string();
                if !key.is_empty() && !seen.insert(key) {
                    continue;
                }
                let tokens = event["totalTokens"].as_i64().unwrap_or(0);
                *per_file
                    .entry(codex_stable_key(file))
                    .or_insert(0i64) += tokens;
                total += tokens;
            }
        }
        (total, per_file)
    }

    /// A parent session, a pure-snapshot fork (all replay rows share the fork
    /// timestamp and contribute nothing), and a fork with own post-burst
    /// turns must produce identical totals whether Codex keeps everything
    /// under `sessions/` or archives the parent to `archived_sessions/` —
    /// including when a stale duplicate copy is left behind in both dirs.
    #[test]
    fn codex_family_totals_invariant_across_archive_layout() {
        let root = unique_temp_dir("layout");
        let sessions_day = root.join("sessions/2026/08/01");
        let archived = root.join("archived_sessions");
        std::fs::create_dir_all(&sessions_day).unwrap();
        std::fs::create_dir_all(&archived).unwrap();

        let parent_rows = {
            let mut rows = vec![json!({
                "timestamp": "2026-08-01T10:00:00Z",
                "type": "session_meta",
                "payload": {"id": "parent-1", "cwd": "/tmp/family"}
            })];
            for (ts, cum) in [
                ("2026-08-01T10:00:10Z", 1_000i64),
                ("2026-08-01T10:01:10Z", 2_000),
                ("2026-08-01T10:02:10Z", 3_000),
                ("2026-08-01T10:03:10Z", 4_000),
                ("2026-08-01T10:04:10Z", 5_000),
            ] {
                rows.push(cumulative_row(ts, cum));
            }
            rows
        };
        // snapshot fork: re-emits mid-state cumulative, all rows stamped at
        // the fork instant -> pure replay, must contribute 0
        let snapshot_rows = {
            let mut rows = vec![json!({
                "timestamp": "2026-08-01T10:02:30Z",
                "type": "session_meta",
                "payload": {"id": "snap-1", "forked_from_id": "parent-1", "cwd": "/tmp/family"}
            })];
            for cum in [1_200i64, 2_200, 2_900] {
                rows.push(cumulative_row("2026-08-01T10:02:30.000Z", cum));
            }
            rows
        };
        // fork with own turns after the replay burst -> contributes its own delta
        let own_rows = {
            let mut rows = vec![json!({
                "timestamp": "2026-08-01T10:02:30Z",
                "type": "session_meta",
                "payload": {"id": "own-1", "forked_from_id": "parent-1", "cwd": "/tmp/family"}
            })];
            for cum in [1_200i64, 2_200, 2_900] {
                rows.push(cumulative_row("2026-08-01T10:02:30.000Z", cum));
            }
            rows.push(cumulative_row("2026-08-01T10:05:00Z", 3_900));
            rows.push(cumulative_row("2026-08-01T10:06:00Z", 4_900));
            rows
        };

        let parent_name = "rollout-2026-08-01T10-00-00-parent.jsonl";
        let snapshot_name = "rollout-2026-08-01T10-02-30-snapshot.jsonl";
        let own_name = "rollout-2026-08-01T10-02-30-own.jsonl";

        // Layout 1: everything active under sessions/
        let p1 = sessions_day.join(parent_name);
        let s1 = sessions_day.join(snapshot_name);
        let c1 = sessions_day.join(own_name);
        write_rollout(&p1, &parent_rows);
        write_rollout(&s1, &snapshot_rows);
        write_rollout(&c1, &own_rows);
        let (total1, per1) = scan_family_totals(&[
            p1.to_string_lossy().to_string(),
            s1.to_string_lossy().to_string(),
            c1.to_string_lossy().to_string(),
        ]);

        // Layout 2: parent + snapshot archived flat, own fork still active,
        // plus a stale duplicate of the parent left in sessions/.
        let p2 = archived.join(parent_name);
        let s2 = archived.join(snapshot_name);
        let c2 = sessions_day.join(own_name);
        std::fs::rename(&p1, &p2).unwrap();
        std::fs::rename(&s1, &s2).unwrap();
        write_rollout(&p1, &parent_rows); // stale duplicate copy
        let (total2, per2) = scan_family_totals(&[
            p2.to_string_lossy().to_string(),
            s2.to_string_lossy().to_string(),
            c2.to_string_lossy().to_string(),
            p1.to_string_lossy().to_string(),
        ]);

        assert_eq!(total1, total2, "archive layout must not change family totals");
        assert_eq!(total1, 7_000, "parent 5000 + own fork 2000 + snapshot 0");
        assert_eq!(per1.get(parent_name), Some(&5_000));
        assert_eq!(per1.get(own_name), Some(&2_000));
        assert_eq!(per1.get(snapshot_name).copied().unwrap_or(0), 0);
        assert_eq!(per2, per1);
        let _ = std::fs::remove_dir_all(root);
    }

    struct CodexHomeGuard {
        previous: Option<String>,
    }
    impl CodexHomeGuard {
        fn set(value: &str) -> Self {
            let previous = std::env::var("CODEX_HOME").ok();
            std::env::set_var("CODEX_HOME", value);
            Self { previous }
        }
    }
    impl Drop for CodexHomeGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var("CODEX_HOME", value),
                None => std::env::remove_var("CODEX_HOME"),
            }
        }
    }

    /// Real heavy users exceed 1000 codex rollout files; the old walk limit
    /// silently dropped the remainder, which both lost usage and made totals
    /// depend on arbitrary readdir order.
    #[test]
    fn scan_sessions_reads_beyond_thousand_files() {
        let _guard = crate::config::TEST_ENV_LOCK.lock().unwrap();
        let root = unique_temp_dir("thousand");
        let day = root.join("sessions/2026/08/01");
        std::fs::create_dir_all(&day).unwrap();
        for i in 0..1_001 {
            let path = day.join(format!("rollout-2026-08-01T10-00-{:04}-session.jsonl", i));
            write_rollout(
                &path,
                &[
                    json!({"timestamp":"2026-08-01T10:00:00Z","type":"session_meta","payload":{"id":format!("s-{}", i),"cwd":"/tmp/proj"}}),
                    cumulative_row("2026-08-01T10:00:01Z", 1_000),
                ],
            );
        }

        let _codex_home = CodexHomeGuard::set(&root.to_string_lossy());
        let config: AppConfig = serde_json::from_value(json!({
            "participantId": "p_test",
            "identityPublicKey": "pk",
            "identityPrivateKey": "sk",
            "deviceId": "d_test"
        }))
        .unwrap();
        let files = CodexProvider.scan_sessions(&config);

        assert_eq!(files.len(), 1_001, "no session file may be silently truncated");
        let _ = std::fs::remove_dir_all(root);
    }
}
