use crate::config::AppConfig;
use crate::provider::common::{source_metadata, walk_files};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub const PROVIDER_ID: &str = "workbuddy_local";
pub const TOOL_CODE: &str = "workbuddy";
pub const VERSION: &str = "0.1.0";

/// WorkBuddy (Electron, OpenClaw-lineage kernel) writes one JSON trace per
/// logical request under `<config-dir>/traces/<pid>/trace_<uuid>.json`.
/// `spans[].toolOutput` of `type == "generation"` spans carries an OpenAI-style
/// usage object as a JSON string. `toolInput` contains full conversation
/// plaintext and is never read (privacy red line).
///
/// Workdir attribution stability: traces do not embed a cwd (verified against
/// real traces — `trace.metadata` is `{}` and the only cwd occurrences live in
/// `toolInput`, which is privacy-forbidden). Attribution therefore reads
/// `sessions/<pid>.json`, but WorkBuddy reuses pid directories and rewrites
/// that file for the *current* session, so rescanning an old trace after pid
/// reuse would silently re-attribute it to a different cwd (cloud double
/// count: same tokens, two workdirHash values). The first non-empty
/// attribution per trace file is therefore pinned into a provider-private
/// snapshot cache under the ATL home and replayed on every later parse.
pub struct WorkBuddyLocalProvider;

impl WorkBuddyLocalProvider {
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
        let mut roots = Vec::new();

        if let Ok(dir) = std::env::var("WORKBUDDY_CONFIG_DIR") {
            let dir = dir.trim();
            if !dir.is_empty() {
                let path = std::path::PathBuf::from(dir);
                if path.exists() {
                    roots.push(path.to_string_lossy().to_string());
                }
            }
        }

        if let Some(home) = dirs::home_dir() {
            let root = home.join(".workbuddy");
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
            let found = walk_files(root, |f| is_workbuddy_trace(f), 5000);
            files.extend(found);
        }
        files
    }

    pub fn parse_usage(&self, file: &str) -> Vec<Value> {
        self.try_parse_usage(file).unwrap_or_default()
    }

    pub fn try_parse_usage(&self, file: &str) -> Result<Vec<Value>, String> {
        let mut store = global_snapshot_store().lock().map_err(|e| e.to_string())?;
        self.try_parse_usage_with_store(file, &mut store)
    }

    /// Parse with an explicit snapshot store. Production callers go through
    /// `try_parse_usage` (process-global store, flushed by the scanner);
    /// tests inject isolated stores for deterministic drift scenarios.
    pub fn try_parse_usage_with_store(
        &self,
        file: &str,
        store: &mut WorkdirSnapshotStore,
    ) -> Result<Vec<Value>, String> {
        let content = fs::read_to_string(file).map_err(|e| format!("read failed: {}", e))?;
        let data: Value =
            serde_json::from_str(&content).map_err(|e| format!("invalid json: {}", e))?;
        let trace = data
            .get("trace")
            .filter(|t| t.is_object())
            .ok_or_else(|| "missing trace object".to_string())?;

        // Error traces carry no usage worth counting; skip without an error.
        let status = trace.get("status").and_then(|s| s.as_str()).unwrap_or("");
        if status != "ok" {
            return Ok(vec![]);
        }

        // Day/hour come from the trace-level ISO 8601 startedAt; fall back to
        // the file mtime when the timestamp cannot be parsed.
        let mtime_ms = file_mtime_ms(file);
        let started_ms = trace
            .get("startedAt")
            .and_then(|s| s.as_str())
            .and_then(parse_iso8601_to_ms)
            .unwrap_or(mtime_ms);
        let day = crate::date::local_day_from_timestamp_ms(started_ms);
        let hour = crate::date::local_hour_from_timestamp_ms(started_ms);

        let source = source_metadata(file, PROVIDER_ID, VERSION);
        let (session_id, workdir_candidate) =
            resolve_session_and_workdir_snapshot(file, trace, store);

        let mut events = Vec::new();
        if let Some(spans) = data.get("spans").and_then(|s| s.as_array()) {
            for span in spans {
                if span.get("type").and_then(|t| t.as_str()) != Some("generation") {
                    continue;
                }
                let tool_output = match span.get("toolOutput").and_then(|v| v.as_str()) {
                    Some(s) if !s.trim().is_empty() => s,
                    _ => continue,
                };

                // Privacy: only toolOutput is deserialized, and only the
                // `usage` and `model` fields are read. toolInput contains
                // full conversation plaintext and must never be accessed.
                let output: Value = match serde_json::from_str(tool_output) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let response = if output.is_array() {
                    match output.as_array().and_then(|arr| arr.first()) {
                        Some(v) => v,
                        None => continue,
                    }
                } else if output.is_object() {
                    &output
                } else {
                    continue;
                };

                let usage = match response.get("usage").filter(|u| u.is_object()) {
                    Some(u) => u,
                    None => continue,
                };

                let prompt_tokens =
                    usage_field_i64(usage, &["prompt_tokens", "input_tokens", "inputTokens"]);
                let completion_tokens = usage_field_i64(
                    usage,
                    &["completion_tokens", "output_tokens", "outputTokens"],
                );
                let cache_read = match usage.get("prompt_tokens_details") {
                    Some(details) if details.get("cached_tokens").is_some() => {
                        usage_field_i64(details, &["cached_tokens"])
                    }
                    _ => usage_field_i64(usage, &["cached_tokens"]),
                };
                let reasoning = match usage.get("completion_tokens_details") {
                    Some(details) if details.get("reasoning_tokens").is_some() => {
                        usage_field_i64(details, &["reasoning_tokens"])
                    }
                    _ => usage_field_i64(usage, &["reasoning_tokens"]),
                };

                // OpenAI semantics: prompt_tokens already includes cached
                // tokens, so split before re-assembling the total.
                let cache_write = 0i64;
                let output_tokens = completion_tokens.max(0);
                let input = (prompt_tokens - cache_read).max(0);
                let total = input + output_tokens + cache_read + cache_write;
                if total == 0 {
                    continue;
                }

                let model = response
                    .get("model")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let model = if model.is_empty() {
                    "unknown".to_string()
                } else {
                    model
                };

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
                    "inputTokens": input,
                    "outputTokens": output_tokens,
                    "cacheReadTokens": cache_read,
                    "cacheWriteTokens": cache_write,
                    "reasoningTokens": reasoning,
                    "totalTokens": total,
                    "rawSourceRef": source.raw_source_ref,
                    "sourceFingerprint": source.source_fingerprint,
                    "parserVersion": source.parser_version,
                }));
            }
        }

        // modelInfo fallback for version drift: when no generation span
        // produced usage but the legacy trace-level aggregate exists, emit a
        // single event from it (community-parser format).
        if events.is_empty() {
            if let Some(model_info) = trace.get("modelInfo").filter(|m| m.is_object()) {
                let input = usage_field_i64(model_info, &["totalInputTokens"]);
                let output_tokens = usage_field_i64(model_info, &["totalOutputTokens"]);
                let cache_read = usage_field_i64(model_info, &["totalCachedTokens"]);
                let cache_write = 0i64;
                let total = input + output_tokens + cache_read + cache_write;
                if total > 0 {
                    let model = model_info
                        .get("models")
                        .and_then(|m| m.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|m| m.as_str())
                                .collect::<Vec<_>>()
                                .join(",")
                        })
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "unknown".to_string());

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
                        "inputTokens": input,
                        "outputTokens": output_tokens,
                        "cacheReadTokens": cache_read,
                        "cacheWriteTokens": cache_write,
                        "reasoningTokens": 0,
                        "totalTokens": total,
                        "rawSourceRef": source.raw_source_ref,
                        "sourceFingerprint": source.source_fingerprint,
                        "parserVersion": source.parser_version,
                    }));
                }
            }
        }

        Ok(events)
    }
}

/// Trace files live under `<root>/traces/<pid>/trace_<uuid>.json`.
fn is_workbuddy_trace(path: &str) -> bool {
    let p = Path::new(path);
    let name = match p.file_name().and_then(|n| n.to_str()) {
        Some(n) => n,
        None => return false,
    };
    if !name.starts_with("trace_") || !name.ends_with(".json") {
        return false;
    }
    p.ancestors()
        .skip(1)
        .any(|a| a.file_name().map(|n| n == "traces").unwrap_or(false))
}

fn usage_field_i64(obj: &Value, aliases: &[&str]) -> i64 {
    for alias in aliases {
        if let Some(n) = obj.get(*alias).and_then(|v| v.as_f64()) {
            return n.round() as i64;
        }
    }
    0
}

fn file_mtime_ms(file: &str) -> i64 {
    fs::metadata(file)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// ISO 8601 UTC string ("2026-08-21T15:49:32.987Z") → epoch milliseconds.
fn parse_iso8601_to_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn worker_pid_string(trace: &Value) -> String {
    match trace.get("workerPid") {
        Some(v) => {
            if let Some(s) = v.as_str() {
                s.to_string()
            } else {
                v.as_i64().map(|n| n.to_string()).unwrap_or_default()
            }
        }
        None => String::new(),
    }
}

/// Resolve (sessionId, workdirCandidate) for a trace file:
/// 1. sessionId: trace-level `sessionId` → sibling `sessions/<pid>.json`
///    `sessionId` → `workerPid` as string.
/// 2. workdir: sibling `sessions/<pid>.json` `cwd` when its `sessionId`
///    matches → read-only `workbuddy.db` `SELECT cwd FROM sessions` → empty.
///    The db fallback degrades silently; no `current_dir()` noise fallback.
fn resolve_session_and_workdir(file: &str, trace: &Value) -> (String, String) {
    let file_path = Path::new(file);
    let pid_dir = file_path.parent();
    let pid = pid_dir
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    // Layout is `<root>/traces/<pid>/trace_*.json`: the provider root is the
    // parent of the `traces` directory (the nearest such ancestor).
    let root = pid_dir
        .and_then(|p| p.parent())
        .filter(|p| p.file_name().map(|n| n == "traces").unwrap_or(false))
        .and_then(|traces_dir| traces_dir.parent());

    let mut session_file_id = String::new();
    let mut session_file_cwd = String::new();
    if let (Some(root), true) = (root, !pid.is_empty()) {
        let sessions_path = root.join("sessions").join(format!("{}.json", pid));
        if let Ok(content) = fs::read_to_string(&sessions_path) {
            if let Ok(sess) = serde_json::from_str::<Value>(&content) {
                session_file_id = sess
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                session_file_cwd = sess
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
            }
        }
    }

    let worker_pid = worker_pid_string(trace);
    let session_id = trace
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            if !session_file_id.is_empty() {
                session_file_id.clone()
            } else {
                worker_pid
            }
        });

    if !session_file_cwd.is_empty() && session_file_id == session_id {
        return (session_id, session_file_cwd);
    }

    if let Some(root) = root {
        if !session_id.is_empty() {
            let db_path = root.join("workbuddy.db");
            if db_path.exists() {
                // Read-only: WAL-safe for the live WorkBuddy database.
                let conn = Connection::open_with_flags(
                    &db_path,
                    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                );
                if let Ok(conn) = conn {
                    if let Ok(cwd) = conn.query_row(
                        "SELECT cwd FROM sessions WHERE id = ?1",
                        [&session_id],
                        |row| row.get::<_, String>(0),
                    ) {
                        if !cwd.is_empty() {
                            return (session_id, cwd);
                        }
                    }
                }
            }
        }
    }

    (session_id, String::new())
}

// ---------------------------------------------------------------------------
// Workdir attribution snapshot cache
// ---------------------------------------------------------------------------

/// Provider-private sidecar under the ATL home (not `usage-cache.json`, whose
/// lifecycle belongs to the generic source cache and which may be reset to
// force a full re-parse — exactly the moment when pinned attribution must
/// survive).
const SNAPSHOT_CACHE_FILE: &str = "workbuddy-workdir-cache.json";
const SNAPSHOT_MAX_ENTRIES: usize = 20_000;
const SNAPSHOT_PRUNE_TO: usize = 10_000;

/// Keyed by the trace file path. Filenames embed a per-request uuid, so path
/// reuse by a different trace is not a realistic collision.
#[derive(Serialize, Deserialize)]
struct WorkdirSnapshot {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "workdir")]
    workdir: String,
    #[serde(rename = "lastSeenMs")]
    last_seen_ms: i64,
}

#[derive(Serialize, Deserialize)]
struct WorkdirSnapshotFile {
    version: u32,
    entries: HashMap<String, WorkdirSnapshot>,
}

pub struct WorkdirSnapshotStore {
    path: PathBuf,
    entries: HashMap<String, WorkdirSnapshot>,
    dirty: bool,
}

impl WorkdirSnapshotStore {
    /// Missing or corrupt cache → empty store (first-scan behavior unchanged).
    pub fn load(path: PathBuf) -> Self {
        let entries = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<WorkdirSnapshotFile>(&text).ok())
            .map(|f| f.entries)
            .unwrap_or_default();
        WorkdirSnapshotStore {
            path,
            entries,
            dirty: false,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn lookup(&mut self, key: &str) -> Option<(String, String)> {
        let now = now_ms();
        let entry = self.entries.get_mut(key)?;
        entry.last_seen_ms = now;
        // Defensive: a snapshot without a workdir pins nothing; re-resolve.
        if entry.workdir.is_empty() {
            return None;
        }
        Some((entry.session_id.clone(), entry.workdir.clone()))
    }

    fn record(&mut self, key: &str, session_id: &str, workdir: &str) {
        self.entries.insert(
            key.to_string(),
            WorkdirSnapshot {
                session_id: session_id.to_string(),
                workdir: workdir.to_string(),
                last_seen_ms: now_ms(),
            },
        );
        self.dirty = true;
    }

    /// Atomic write (tmp + rename); prunes oldest-by-lastSeen when oversized.
    pub fn save_if_dirty(&mut self) {
        if !self.dirty {
            return;
        }
        if self.entries.len() > SNAPSHOT_MAX_ENTRIES {
            let mut kept: Vec<(String, i64)> = self
                .entries
                .iter()
                .map(|(k, v)| (k.clone(), v.last_seen_ms))
                .collect();
            kept.sort_by(|a, b| b.1.cmp(&a.1)); // newest first
            kept.truncate(SNAPSHOT_PRUNE_TO);
            let survivors: std::collections::HashSet<String> =
                kept.into_iter().map(|(k, _)| k).collect();
            self.entries.retain(|k, _| survivors.contains(k));
        }
        let file = WorkdirSnapshotFile {
            version: 1,
            entries: std::mem::take(&mut self.entries),
        };
        let text = serde_json::to_string(&file).unwrap_or_default();
        self.entries = file.entries;
        let tmp = PathBuf::from(format!("{}.tmp", self.path.display()));
        if fs::write(&tmp, text).is_ok() {
            let _ = fs::rename(&tmp, &self.path);
        }
        self.dirty = false;
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn snapshot_cache_path() -> PathBuf {
    if cfg!(test) {
        // Unit tests must never touch the developer's real ATL home. One
        // unique temp dir per test process keeps the global store shared
        // only within a single `cargo test` run (values there are stable).
        static TEST_DIR: OnceLock<PathBuf> = OnceLock::new();
        let dir = TEST_DIR.get_or_init(|| {
            let unique = format!(
                "atl-workbuddy-snapcache-test-{}-{}",
                std::process::id(),
                now_ms()
            );
            let dir = std::env::temp_dir().join(unique);
            let _ = fs::create_dir_all(&dir);
            dir
        });
        return dir.join(SNAPSHOT_CACHE_FILE);
    }
    crate::config::app_dir().join(SNAPSHOT_CACHE_FILE)
}

fn global_snapshot_store() -> &'static Mutex<WorkdirSnapshotStore> {
    static GLOBAL: OnceLock<Mutex<WorkdirSnapshotStore>> = OnceLock::new();
    GLOBAL.get_or_init(|| Mutex::new(WorkdirSnapshotStore::load(snapshot_cache_path())))
}

/// Persist attribution snapshots pinned since process start. Called by the
/// scanner after the WorkBuddy file loop so a first scan (many new pins) costs
/// one write instead of one write per file.
pub fn flush_workdir_snapshot_cache() {
    if let Ok(mut store) = global_snapshot_store().lock() {
        store.save_if_dirty();
    }
}

/// Snapshot-aware attribution: replay the first pinned result per trace file;
/// otherwise resolve from live state and pin any non-empty workdir. Empty
/// results are never pinned, so late-appearing session files can still fill
/// attribution in (one-time upgrade, not drift).
fn resolve_session_and_workdir_snapshot(
    file: &str,
    trace: &Value,
    store: &mut WorkdirSnapshotStore,
) -> (String, String) {
    if let Some(pinned) = store.lookup(file) {
        return pinned;
    }
    let resolved = resolve_session_and_workdir(file, trace);
    if !resolved.1.is_empty() {
        store.record(file, &resolved.0, &resolved.1);
    }
    resolved
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_dir() -> Option<std::path::PathBuf> {
        std::env::current_dir().ok().and_then(|d| {
            let p = d.join("../samples/workbuddy");
            if p.exists() {
                Some(p)
            } else {
                None
            }
        })
    }

    fn sample_trace(pid: &str, name: &str) -> Option<String> {
        sample_dir().map(|d| {
            d.join("traces")
                .join(pid)
                .join(format!("{}.json", name))
                .to_string_lossy()
                .to_string()
        })
    }

    fn base_config() -> AppConfig {
        serde_json::from_value(serde_json::json!({
            "participantId": "test",
            "nickname": "test",
            "identityPublicKey": "",
            "identityPrivateKey": "",
            "deviceId": "test"
        }))
        .unwrap()
    }

    #[test]
    fn test_provider_constants() {
        assert_eq!(PROVIDER_ID, "workbuddy_local");
        assert_eq!(TOOL_CODE, "workbuddy");
        assert_eq!(VERSION, "0.1.0");
    }

    #[test]
    fn test_is_workbuddy_trace() {
        assert!(is_workbuddy_trace("/tmp/root/traces/10001/trace_abc.json"));
        assert!(!is_workbuddy_trace("/tmp/root/traces/10001/session.json"));
        assert!(!is_workbuddy_trace(
            "/tmp/root/traces/10001/trace_abc.jsonl"
        ));
        assert!(!is_workbuddy_trace("/tmp/root/logs/10001/trace_abc.json"));
    }

    #[test]
    fn test_parse_usage_sample_counts() {
        let provider = WorkBuddyLocalProvider;
        for (pid, name, expected) in [
            ("10001", "trace_aaaa1111", 1),
            ("10001", "trace_bbbb2222", 2),
            ("10002", "trace_cccc3333", 1),
            ("10002", "trace_dddd4444", 0),
            ("10003", "trace_eeee5555", 0),
        ] {
            let file = match sample_trace(pid, name) {
                Some(f) if Path::new(&f).exists() => f,
                _ => return, // samples missing → skip silently
            };
            let events = provider.parse_usage(&file);
            assert_eq!(
                events.len(),
                expected,
                "{} should produce {} events",
                name,
                expected
            );
        }
    }

    #[test]
    fn test_parse_usage_openai_split_math() {
        let file = match sample_trace("10001", "trace_aaaa1111") {
            Some(f) if Path::new(&f).exists() => f,
            _ => return,
        };
        let events = WorkBuddyLocalProvider.parse_usage(&file);
        let event = events.first().expect("aaaa1111 should emit one event");

        // prompt=1500 (cached=500), completion=300 → input=1000, total=1800.
        // Invariant: total == prompt_tokens + completion_tokens when cached
        // tokens are a subset of prompt_tokens (OpenAI semantics).
        assert_eq!(event["inputTokens"], 1000);
        assert_eq!(event["outputTokens"], 300);
        assert_eq!(event["cacheReadTokens"], 500);
        assert_eq!(event["cacheWriteTokens"], 0);
        assert_eq!(event["reasoningTokens"], 50);
        assert_eq!(event["totalTokens"], 1800);
        assert_eq!(
            event["totalTokens"].as_i64().unwrap(),
            event["inputTokens"].as_i64().unwrap()
                + event["cacheReadTokens"].as_i64().unwrap()
                + event["outputTokens"].as_i64().unwrap()
        );

        for key in [
            "providerId",
            "providerVersion",
            "toolCode",
            "sourceKind",
            "sourceQuality",
            "sessionId",
            "day",
            "hour",
            "workdirCandidate",
            "model",
            "rawSourceRef",
            "sourceFingerprint",
            "parserVersion",
        ] {
            assert!(event.get(key).is_some(), "event must contain {}", key);
        }
        assert_eq!(event["providerId"], PROVIDER_ID);
        assert_eq!(event["toolCode"], TOOL_CODE);
        assert_eq!(event["sourceKind"], "local_log");
        assert_eq!(event["sourceQuality"], "exact");
        // "auto" is WorkBuddy's model-dispatch alias and is a valid value.
        assert_eq!(event["model"], "auto");
    }

    #[test]
    fn test_parse_usage_multiple_generation_spans() {
        let file = match sample_trace("10001", "trace_bbbb2222") {
            Some(f) if Path::new(&f).exists() => f,
            _ => return,
        };
        let events = WorkBuddyLocalProvider.parse_usage(&file);
        assert_eq!(events.len(), 2, "two generation spans → two events");

        // Span 1: prompt=1200, completion=400, no cache.
        let first = events
            .iter()
            .find(|e| e["model"] == "auto")
            .expect("span 1 uses model auto");
        assert_eq!(first["inputTokens"], 1200);
        assert_eq!(first["outputTokens"], 400);
        assert_eq!(first["cacheReadTokens"], 0);
        assert_eq!(first["totalTokens"], 1600);

        // Span 2: prompt=800 (cached=300), completion=200.
        let second = events
            .iter()
            .find(|e| e["model"] == "test-model-b")
            .expect("span 2 uses test-model-b");
        assert_eq!(second["inputTokens"], 500);
        assert_eq!(second["outputTokens"], 200);
        assert_eq!(second["cacheReadTokens"], 300);
        assert_eq!(second["reasoningTokens"], 40);
        assert_eq!(second["totalTokens"], 1000);
    }

    #[test]
    fn test_parse_usage_zero_token_skip_and_model_info_fallback() {
        let file = match sample_trace("10002", "trace_cccc3333") {
            Some(f) if Path::new(&f).exists() => f,
            _ => return,
        };
        let events = WorkBuddyLocalProvider.parse_usage(&file);

        // The generation span has an all-zero usage → skipped; only the
        // modelInfo fallback event remains.
        assert_eq!(events.len(), 1, "only the modelInfo fallback event");
        let event = &events[0];
        assert_eq!(event["inputTokens"], 800);
        assert_eq!(event["outputTokens"], 200);
        assert_eq!(event["cacheReadTokens"], 100);
        assert_eq!(event["cacheWriteTokens"], 0);
        assert_eq!(event["reasoningTokens"], 0);
        assert_eq!(event["totalTokens"], 1100);
        assert_eq!(event["model"], "test-model");
    }

    #[test]
    fn test_parse_usage_error_status_skip() {
        let file = match sample_trace("10002", "trace_dddd4444") {
            Some(f) if Path::new(&f).exists() => f,
            _ => return,
        };
        let result = WorkBuddyLocalProvider.try_parse_usage(&file);
        assert!(result.is_ok(), "error-status trace must not be an Err");
        assert!(
            result.unwrap().is_empty(),
            "error-status trace with valid usage must be skipped"
        );
    }

    #[test]
    fn test_parse_usage_invalid_tool_output_tolerated() {
        let file = match sample_trace("10003", "trace_eeee5555") {
            Some(f) if Path::new(&f).exists() => f,
            _ => return,
        };
        let result = WorkBuddyLocalProvider.try_parse_usage(&file);
        assert!(result.is_ok(), "invalid toolOutput must not be an Err");
        assert!(result.unwrap().is_empty());
    }

    #[test]
    fn test_parse_usage_day_hour_and_session_from_sessions_file() {
        let file = match sample_trace("10001", "trace_aaaa1111") {
            Some(f) if Path::new(&f).exists() => f,
            _ => return,
        };
        let events = WorkBuddyLocalProvider.parse_usage(&file);
        let event = events.first().unwrap();

        // UTC noon sample keeps the day stable in most timezones.
        assert!(
            ["2026-06-08", "2026-06-09"].contains(&event["day"].as_str().unwrap_or("")),
            "day should be near 2026-06-08, got {:?}",
            event["day"]
        );
        assert!(event["hour"].as_u64().unwrap_or(99) < 24);

        // sessionId is absent at trace level → derived from sessions/10001.json.
        assert_eq!(event["sessionId"], "sess-10001");
        assert_eq!(event["workdirCandidate"], "/tmp/wb-sample/project-one");
    }

    #[test]
    fn test_parse_usage_orphan_session_workdir_fallback() {
        let file = match sample_trace("10002", "trace_cccc3333") {
            Some(f) if Path::new(&f).exists() => f,
            _ => return,
        };
        let events = WorkBuddyLocalProvider.parse_usage(&file);
        let event = events.first().expect("modelInfo fallback event");

        // sessions/10002.json has sessionId "sess-other" which mismatches the
        // trace-level "sess-10002"; no workbuddy.db exists in samples → the
        // workdir candidate stays empty (no panic, no current_dir noise).
        assert_eq!(event["sessionId"], "sess-10002");
        assert_eq!(event["workdirCandidate"], "");
    }

    #[test]
    fn test_parse_usage_nonexistent_file() {
        let provider = WorkBuddyLocalProvider;
        let events = provider.parse_usage("/nonexistent/path/traces/1/trace_x.json");
        assert!(events.is_empty());
    }

    #[test]
    fn test_try_parse_usage_invalid_json_is_error() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("atl-workbuddy-bad-{}.json", suffix));
        fs::write(&path, "not-json{{{").unwrap();
        assert!(WorkBuddyLocalProvider
            .try_parse_usage(&path.to_string_lossy())
            .is_err());
        let _ = fs::remove_file(&path);

        let path2 = std::env::temp_dir().join(format!("atl-workbuddy-notrace-{}.json", suffix));
        fs::write(&path2, "{\"spans\": []}").unwrap();
        assert!(WorkBuddyLocalProvider
            .try_parse_usage(&path2.to_string_lossy())
            .is_err());
        let _ = fs::remove_file(&path2);
    }

    #[test]
    fn test_scan_sessions_manual_root() {
        let samples = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let mut cfg = base_config();
        cfg.provider_roots.insert(
            PROVIDER_ID.into(),
            vec![samples.to_string_lossy().to_string()],
        );
        let provider = WorkBuddyLocalProvider;
        let sessions = provider.scan_sessions(&cfg);
        // A real ~/.workbuddy may exist on the dev machine and show up as an
        // auto root; the manual sample root must always be included.
        assert!(sessions
            .iter()
            .any(|s| s.contains("samples/workbuddy") && s.contains("trace_aaaa1111")));
        // Path separators differ by OS: walk_files joins the traces component
        // with `\` on Windows and `/` elsewhere.
        assert!(sessions
            .iter()
            .all(|s| s.contains("/traces/") || s.contains("\\traces\\")));
    }

    #[test]
    fn test_scan_sessions_disabled() {
        let mut cfg = base_config();
        cfg.provider_enabled.insert(PROVIDER_ID.into(), false);
        let provider = WorkBuddyLocalProvider;
        let sessions = provider.scan_sessions(&cfg);
        assert!(sessions.is_empty());
    }

    #[test]
    fn test_auto_roots_env_override() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("atl-workbuddy-env-{}", suffix));
        let traces = root.join("traces").join("24680");
        fs::create_dir_all(&traces).unwrap();
        fs::write(
            traces.join("trace_envtest.json"),
            "{\"trace\": {\"traceId\": \"trace_envtest\", \"status\": \"ok\"}, \"spans\": []}",
        )
        .unwrap();

        std::env::set_var("WORKBUDDY_CONFIG_DIR", &root);
        let cfg = base_config();
        let sessions = WorkBuddyLocalProvider.scan_sessions(&cfg);
        std::env::remove_var("WORKBUDDY_CONFIG_DIR");
        let _ = fs::remove_dir_all(&root);

        assert!(
            sessions
                .iter()
                .any(|s| s.contains("atl-workbuddy-env") && s.ends_with("trace_envtest.json")),
            "WORKBUDDY_CONFIG_DIR override should be scanned, got {:?}",
            sessions
        );
    }

    // -----------------------------------------------------------------
    // Workdir attribution drift (pid reuse rewrites sessions/<pid>.json)
    // -----------------------------------------------------------------

    fn temp_fixture_dir(tag: &str) -> PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("atl-workbuddy-{}-{}", tag, suffix));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Real-world shape: no trace-level `sessionId` (real traces carry only
    /// traceId/workerPid), status ok, one generation span with usage.
    fn write_fixture_trace(root: &Path, pid: &str, name: &str) -> String {
        let dir = root.join("traces").join(pid);
        fs::create_dir_all(&dir).unwrap();
        let trace = json!({
            "trace": {
                "traceId": name,
                "name": "Agent workflow",
                "workerPid": pid,
                "startedAt": "2026-08-21T08:29:00Z",
                "status": "ok",
            },
            "spans": [
                {
                    "type": "generation",
                    "toolOutput": "[{\"model\":\"auto\",\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":200,\"total_tokens\":1200}}]"
                }
            ]
        });
        let path = dir.join(format!("{}.json", name));
        fs::write(&path, serde_json::to_string(&trace).unwrap()).unwrap();
        path.to_string_lossy().to_string()
    }

    fn write_sessions_file(root: &Path, pid: &str, session_id: &str, cwd: &str) {
        let dir = root.join("sessions");
        fs::create_dir_all(&dir).unwrap();
        let body = json!({ "pid": pid, "sessionId": session_id, "cwd": cwd });
        fs::write(
            dir.join(format!("{}.json", pid)),
            serde_json::to_string(&body).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn test_workdir_attribution_stable_across_sessions_cwd_drift() {
        let root = temp_fixture_dir("drift");
        let trace_file = write_fixture_trace(&root, "10001", "trace_stable0001");
        let cache_path = root.join("snap-cache.json");

        // Scan 1: sessions/<pid>.json belongs to session A in /proj/alpha.
        write_sessions_file(&root, "10001", "sess-A", "/proj/alpha");
        let mut store1 = WorkdirSnapshotStore::load(cache_path.clone());
        let events1 = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&trace_file, &mut store1)
            .unwrap();
        store1.save_if_dirty();

        assert_eq!(events1.len(), 1);
        assert_eq!(events1[0]["sessionId"], "sess-A");
        assert_eq!(events1[0]["workdirCandidate"], "/proj/alpha");

        // Between scans WorkBuddy reuses the pid dir for session B in
        // /proj/beta: sessions/<pid>.json is rewritten with the new cwd.
        write_sessions_file(&root, "10001", "sess-B", "/proj/beta");

        // Scan 2: fresh store instance loaded from the persisted cache file,
        // i.e. a different process rescanning the same immutable traces.
        let mut store2 = WorkdirSnapshotStore::load(cache_path);
        let events2 = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&trace_file, &mut store2)
            .unwrap();

        assert_eq!(
            events1, events2,
            "same trace set scanned twice must produce identical events"
        );
        assert_eq!(
            events2[0]["sessionId"], "sess-A",
            "sessionId must stay pinned"
        );
        assert_eq!(
            events2[0]["workdirCandidate"], "/proj/alpha",
            "workdir must stay pinned to the first-attribution cwd"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_workdir_attribution_drifts_without_snapshot_cache() {
        // Documents the bug being fixed: with no pinned snapshot (fresh empty
        // cache per scan), the rewritten sessions/<pid>.json re-attributes the
        // same immutable trace to the new pid-reuse cwd.
        let root = temp_fixture_dir("no-cache");
        let trace_file = write_fixture_trace(&root, "10001", "trace_drift0002");

        write_sessions_file(&root, "10001", "sess-A", "/proj/alpha");
        let mut store1 = WorkdirSnapshotStore::load(root.join("unused1.json"));
        let events1 = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&trace_file, &mut store1)
            .unwrap();
        assert_eq!(events1[0]["workdirCandidate"], "/proj/alpha");

        write_sessions_file(&root, "10001", "sess-B", "/proj/beta");
        let mut store2 = WorkdirSnapshotStore::load(root.join("unused2.json"));
        let events2 = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&trace_file, &mut store2)
            .unwrap();
        assert_eq!(
            events2[0]["workdirCandidate"], "/proj/beta",
            "without the snapshot pin the live sessions file wins (old behavior)"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_snapshot_cache_missing_or_corrupt_falls_back_to_live_resolution() {
        let root = temp_fixture_dir("corrupt");
        let trace_file = write_fixture_trace(&root, "10001", "trace_corrupt003");
        write_sessions_file(&root, "10001", "sess-A", "/proj/alpha");

        let cache_path = root.join("snap-cache.json");
        fs::write(&cache_path, "not-json{{{").unwrap();
        let mut store = WorkdirSnapshotStore::load(cache_path);
        assert!(store.is_empty(), "corrupt cache must load as empty");

        let events = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&trace_file, &mut store)
            .unwrap();
        assert_eq!(events[0]["workdirCandidate"], "/proj/alpha");
        assert_eq!(events[0]["sessionId"], "sess-A");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_empty_workdir_resolution_is_not_pinned() {
        // sessionId mismatch → no resolvable workdir on first scan; nothing is
        // pinned, so a later matching sessions file may still fill it in.
        let root = temp_fixture_dir("unpinned");
        let dir = root.join("traces").join("10001");
        fs::create_dir_all(&dir).unwrap();
        let trace = json!({
            "trace": {
                "traceId": "trace_orphan0004",
                "sessionId": "sess-real",
                "workerPid": "10001",
                "startedAt": "2026-08-21T08:29:00Z",
                "status": "ok",
            },
            "spans": [
                {
                    "type": "generation",
                    "toolOutput": "[{\"model\":\"auto\",\"usage\":{\"prompt_tokens\":500,\"completion_tokens\":100,\"total_tokens\":600}}]"
                }
            ]
        });
        let trace_file = dir.join("trace_orphan0004.json");
        fs::write(&trace_file, serde_json::to_string(&trace).unwrap()).unwrap();
        let trace_file = trace_file.to_string_lossy().to_string();

        write_sessions_file(&root, "10001", "sess-other", "/proj/wrong");
        let cache_path = root.join("snap-cache.json");
        let mut store = WorkdirSnapshotStore::load(cache_path.clone());
        let events = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&trace_file, &mut store)
            .unwrap();
        assert_eq!(
            events[0]["workdirCandidate"], "",
            "mismatch leaves workdir empty"
        );
        assert!(store.is_empty(), "empty attribution must not be pinned");
        store.save_if_dirty();

        // The matching session record appears later: attribution fills in.
        write_sessions_file(&root, "10001", "sess-real", "/proj/late");
        let mut store2 = WorkdirSnapshotStore::load(cache_path);
        let events2 = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&trace_file, &mut store2)
            .unwrap();
        assert_eq!(events2[0]["workdirCandidate"], "/proj/late");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_snapshot_store_roundtrip_and_prune() {
        let root = temp_fixture_dir("prune");
        let cache_path = root.join("snap-cache.json");

        let mut store = WorkdirSnapshotStore::load(cache_path.clone());
        // Distinct last_seen_ms so prune order is deterministic: /old/* are
        // the oldest and must be dropped first. Exactly SNAPSHOT_PRUNE_TO
        // recent entries → all recent survive, all old are pruned.
        let old_count = SNAPSHOT_MAX_ENTRIES + 5 - SNAPSHOT_PRUNE_TO;
        let mut expected_kept = std::collections::HashSet::new();
        for i in 0..old_count {
            store.entries.insert(
                format!("/old/traces/{}/trace_old{}.json", i, i),
                WorkdirSnapshot {
                    session_id: format!("sess-old-{}", i),
                    workdir: format!("/proj/old-{}", i),
                    last_seen_ms: 1_000_000 + i as i64,
                },
            );
        }
        for i in 0..SNAPSHOT_PRUNE_TO {
            let key = format!("/new/traces/{}/trace_new{}.json", i, i);
            expected_kept.insert(key.clone());
            store.entries.insert(
                key,
                WorkdirSnapshot {
                    session_id: format!("sess-{}", i),
                    workdir: format!("/proj/{}", i),
                    last_seen_ms: 2_000_000 + i as i64,
                },
            );
        }
        assert!(store.len() > SNAPSHOT_MAX_ENTRIES);
        store.dirty = true;
        store.save_if_dirty();

        let mut reloaded = WorkdirSnapshotStore::load(cache_path);
        assert_eq!(
            reloaded.len(),
            SNAPSHOT_PRUNE_TO,
            "oversized cache must prune to SNAPSHOT_PRUNE_TO"
        );
        for i in 0..old_count {
            assert!(
                reloaded
                    .lookup(&format!("/old/traces/{}/trace_old{}.json", i, i))
                    .is_none(),
                "oldest entries must be pruned first (i={})",
                i
            );
        }
        // Survivors round-trip with their pinned attribution intact.
        let any_key = expected_kept.iter().next().unwrap().clone();
        let (session, workdir) = reloaded.lookup(&any_key).expect("recent entry survives");
        assert_eq!(
            session,
            format!("sess-{}", any_key.split('/').nth(3).unwrap())
        );
        assert!(workdir.starts_with("/proj/"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_snapshot_replay_across_distinct_store_instances() {
        // Second parse goes through the pinned snapshot even when the live
        // sessions file (and the workbuddy.db fallback) has disappeared.
        let root = temp_fixture_dir("replay");
        let trace_file = write_fixture_trace(&root, "10001", "trace_replay0005");
        write_sessions_file(&root, "10001", "sess-A", "/proj/alpha");
        let cache_path = root.join("snap-cache.json");

        let mut store1 = WorkdirSnapshotStore::load(cache_path.clone());
        let _ = WorkBuddyLocalProvider.try_parse_usage_with_store(&trace_file, &mut store1);
        store1.save_if_dirty();

        // Live state fully gone (pid dir reused and cleaned).
        let _ = fs::remove_dir_all(root.join("sessions"));

        let mut store2 = WorkdirSnapshotStore::load(cache_path);
        let events = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&trace_file, &mut store2)
            .unwrap();
        assert_eq!(events[0]["sessionId"], "sess-A");
        assert_eq!(events[0]["workdirCandidate"], "/proj/alpha");
        assert_eq!(
            events[0]["totalTokens"], 1200,
            "token math unaffected by pin"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
