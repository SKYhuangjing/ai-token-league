use crate::config::AppConfig;
use crate::provider::common::{read_json_lines, source_metadata, walk_files, SourceMetadata};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub const PROVIDER_ID: &str = "workbuddy_local";
pub const TOOL_CODE: &str = "workbuddy";
pub const VERSION: &str = "0.3.0";

/// WorkBuddy (Electron, OpenClaw-lineage kernel) writes one trace per logical
/// request under `<config-dir>/traces/<pid>/`. Two generations of the format:
///
/// * Legacy (≤ 2026-10): `trace_<uuid>.json`, a single JSON document with
///   `trace` + `spans[]`. `spans[].toolOutput` of `type == "generation"`
///   spans carries an OpenAI-style usage object as a JSON string.
/// * Streaming (2026-10 migration, sqlite-migrations marker): `trace_<uuid>
///   .jsonl`, one record per line — `{"type":"trace_start"|"span_start"|
///   "span_end"|"trace_end", ...}`. Usage lives in `span_end` records of
///   generation spans (`trace_end.totalTokens` stays 0 — known trap).
///
/// In both formats `toolInput` contains full conversation plaintext and is
/// never read (privacy red line).
///
/// Workdir attribution stability: traces embed no cwd (verified against real
/// traces of both formats). Legacy attribution read `sessions/<pid>.json`,
/// but WorkBuddy reuses pid directories and rewrites that file for the
/// *current* session, so rescanning an old trace after pid reuse would
/// silently re-attribute it to a different cwd (cloud double count: same
/// tokens, two workdirHash values). The streaming format dropped both the
/// trace-level sessionId and `sessions/<pid>.json` entirely, so jsonl traces
/// attribute via a time-window match against the read-only `workbuddy.db`
/// `sessions` table (activity window containing the trace start). The first
/// non-empty attribution per trace file is pinned into a provider-private
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
            let found =
                walk_files(root, |f| is_workbuddy_trace(f) || is_project_file(f), 5000);
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
        if is_project_file(file) {
            self.try_parse_usage_project(file, store)
        } else if file.ends_with(".jsonl") {
            // Streaming traces handle session-level suppression internally
            // (window-matched id, not just the emitted sessionId — see
            // try_parse_usage_jsonl).
            self.try_parse_usage_jsonl(file, store)
        } else {
            let events = self.try_parse_usage_legacy_json(file, store)?;
            // Session-level source exclusivity for legacy traces: a
            // per-session project transcript (projects/<slug>/<sessionId>
            // .jsonl) is authoritative and covers the Claw/IM channel
            // traffic that never reaches traces — same-session trace files
            // emit nothing. Re-evaluated on every parse; the scanner's
            // combined fingerprint invalidates the cache whenever any
            // WorkBuddy file changes, so project-file cleanup automatically
            // re-admits the traces.
            if let Some(sid) = events
                .first()
                .and_then(|e| e.get("sessionId"))
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
            {
                if project_file_for_session(file, &sid).is_some() {
                    return Ok(vec![]);
                }
            }
            Ok(events)
        }
    }

    /// Per-session project transcript: `<root>/projects/<workdir-slug>/
    /// <sessionId>.jsonl`, one JSON record per line (session-meta / message /
    /// reasoning / function_call / ...). Model calls carry an OpenAI-style
    /// usage object at `providerData.rawUsage` — on assistant `message`
    /// records AND on `function_call` records (agent tool-loop steps; the
    /// Claw/IM channel traffic lives only here, never in `traces/`).
    /// Records without `timestamp` cannot be placed in a day/hour bucket and
    /// are skipped. Attribution: sessionId = file stem, workdir from the
    /// read-only `workbuddy.db` sessions table by exact id (no cwd exists in
    /// the file itself), pinned via the snapshot cache.
    fn try_parse_usage_project(
        &self,
        file: &str,
        store: &mut WorkdirSnapshotStore,
    ) -> Result<Vec<Value>, String> {
        let session_id = project_session_id(file).unwrap_or_default();
        let (session_id, workdir_candidate) = if session_id.is_empty() {
            (String::new(), String::new())
        } else {
            let sid = session_id.clone();
            resolve_pinned(file, store, || {
                resolve_project_session_and_workdir(file, &sid)
            })
        };

        let source = source_metadata(file, PROVIDER_ID, VERSION);
        let mut events = Vec::new();
        for rec in read_json_lines(file) {
            let started_ms = match rec.get("timestamp").and_then(|t| t.as_i64()) {
                Some(ms) if ms > 0 => ms,
                _ => continue,
            };
            let day = crate::date::local_day_from_timestamp_ms(started_ms);
            let hour = crate::date::local_hour_from_timestamp_ms(started_ms);
            let provider_data = match rec.get("providerData").filter(|p| p.is_object()) {
                Some(p) => p,
                None => continue,
            };
            let usage = match provider_data.get("rawUsage").filter(|u| u.is_object()) {
                Some(u) => u,
                None => continue,
            };
            let model = provider_data
                .get("model")
                .and_then(|m| m.as_str())
                .filter(|m| !m.trim().is_empty())
                .or_else(|| {
                    provider_data
                        .get("requestModelId")
                        .and_then(|m| m.as_str())
                        .filter(|m| !m.trim().is_empty())
                })
                .unwrap_or("unknown")
                .to_string();
            if let Some(event) = openai_usage_event(
                usage,
                &model,
                &session_id,
                &workdir_candidate,
                &day,
                hour,
                &source,
            ) {
                events.push(event);
            }
        }
        Ok(events)
    }

    /// Streaming JSONL format (2026-10 WorkBuddy migration): one record per
    /// line — `trace_start` / `span_start` / `span_end` / `trace_end`. Only
    /// `span_end` records of generation spans carry final usage. A trace with
    /// no `trace_end` yet is still being written: skip it (Ok, empty) — the
    /// file's size/mtime fingerprint changes when the record is appended, so
    /// the next scan reparses it. Records carry no sessionId and the legacy
    /// `sessions/<pid>.json` sidecar is gone, so attribution goes through
    /// `resolve_session_and_workdir_jsonl` (workbuddy.db time window).
    fn try_parse_usage_jsonl(
        &self,
        file: &str,
        store: &mut WorkdirSnapshotStore,
    ) -> Result<Vec<Value>, String> {
        let records = read_json_lines(file);
        let record_trace = |kind: &str| {
            records.iter().find(|r| r.get("type").and_then(|t| t.as_str()) == Some(kind))
        };
        let trace_start = record_trace("trace_start")
            .and_then(|r| r.get("trace"))
            .filter(|t| t.is_object());
        let trace_end = record_trace("trace_end")
            .and_then(|r| r.get("trace"))
            .filter(|t| t.is_object());

        let trace = match trace_end.or(trace_start) {
            Some(t) => t,
            // Empty/partial file is a normal transient while WorkBuddy
            // streams records line by line: skip (not an error — a provider
            // parse error would block the whole scan's persist) and let the
            // next scan reparse once the file grows.
            None => return Ok(vec![]),
        };
        if trace_end.is_none() {
            // Still running; no final status to trust yet.
            return Ok(vec![]);
        }

        // Error traces carry no usage worth counting; skip without an error.
        let status = trace.get("status").and_then(|s| s.as_str()).unwrap_or("");
        if status != "ok" {
            return Ok(vec![]);
        }

        // Day/hour come from the trace-level ISO 8601 startedAt; fall back to
        // the file mtime when the timestamp cannot be parsed.
        let mtime_ms = file_mtime_ms(file);
        let started_ms = trace_start
            .and_then(|t| t.get("startedAt").and_then(|s| s.as_str()))
            .or_else(|| trace.get("startedAt").and_then(|s| s.as_str()))
            .and_then(parse_iso8601_to_ms)
            .unwrap_or(mtime_ms);
        let day = crate::date::local_day_from_timestamp_ms(started_ms);
        let hour = crate::date::local_hour_from_timestamp_ms(started_ms);

        let source = source_metadata(file, PROVIDER_ID, VERSION);
        let (session_id, workdir_candidate) =
            resolve_pinned(file, store, || {
                resolve_session_and_workdir_jsonl(file, trace, started_ms)
            });

        let mut events = Vec::new();
        for rec in &records {
            if rec.get("type").and_then(|t| t.as_str()) != Some("span_end") {
                continue;
            }
            if let Some(span) = rec.get("span") {
                if let Some(event) = event_from_generation_span(
                    span,
                    &session_id,
                    &workdir_candidate,
                    &day,
                    hour,
                    &source,
                ) {
                    events.push(event);
                }
            }
        }

        // Session-level source exclusivity (see try_parse_usage_with_store).
        // The emitted sessionId may have degraded to workerPid (db row
        // soft-deleted, matched row with empty cwd, db unopenable), so also
        // probe with the raw time-window match ignoring deleted_at and cwd —
        // a soft-deleted session's transcript still suppresses its traces.
        if !events.is_empty() {
            let root = root_and_pid(file).0;
            let window_id = window_matched_session_id(root.as_deref(), started_ms);
            let suppress = [&Some(session_id.clone()), &window_id].into_iter().flatten().any(
                |sid| {
                    !sid.is_empty() && project_file_for_session(file, sid).is_some()
                },
            );
            if suppress {
                return Ok(vec![]);
            }
        }

        Ok(events)
    }

    /// Legacy single-document format: `{"trace": {...}, "spans": [...]}`.
    fn try_parse_usage_legacy_json(
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
                if let Some(event) = event_from_generation_span(
                    span,
                    &session_id,
                    &workdir_candidate,
                    &day,
                    hour,
                    &source,
                ) {
                    events.push(event);
                }
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

/// Trace files live under `<root>/traces/<pid>/`: legacy `trace_<uuid>.json`
/// single documents and streaming `trace_<uuid>.jsonl` event logs (2026-10
/// WorkBuddy migration).
fn is_workbuddy_trace(path: &str) -> bool {
    let p = Path::new(path);
    let name = match p.file_name().and_then(|n| n.to_str()) {
        Some(n) => n,
        None => return false,
    };
    if !name.starts_with("trace_") {
        return false;
    }
    if !name.ends_with(".json") && !name.ends_with(".jsonl") {
        return false;
    }
    p.ancestors()
        .skip(1)
        .any(|a| a.file_name().map(|n| n == "traces").unwrap_or(false))
}

/// Shared generation-span → event extraction for both trace formats. Skips
/// spans that carry no usable usage (returns None). Privacy: whole records
/// are JSON-parsed, but only `toolOutput`'s `usage` and `model` fields are
/// ever read — `toolInput` contains full conversation plaintext and must
/// never be accessed or emitted.
fn event_from_generation_span(
    span: &Value,
    session_id: &str,
    workdir_candidate: &str,
    day: &str,
    hour: u32,
    source: &SourceMetadata,
) -> Option<Value> {
    if span.get("type").and_then(|t| t.as_str()) != Some("generation") {
        return None;
    }
    let tool_output = span.get("toolOutput").and_then(|v| v.as_str())?;
    if tool_output.trim().is_empty() {
        return None;
    }

    let output: Value = serde_json::from_str(tool_output).ok()?;
    let response = if output.is_array() {
        output.as_array()?.first()?
    } else if output.is_object() {
        &output
    } else {
        return None;
    };

    let usage = response.get("usage").filter(|u| u.is_object())?;
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

    openai_usage_event(usage, &model, session_id, workdir_candidate, day, hour, source)
}

/// OpenAI-style usage object (prompt/completion + *_details.cached/reasoning)
/// → provider event. Shared by trace generation spans and project-file
/// `rawUsage` records — identical shapes, identical math.
fn openai_usage_event(
    usage: &Value,
    model: &str,
    session_id: &str,
    workdir_candidate: &str,
    day: &str,
    hour: u32,
    source: &SourceMetadata,
) -> Option<Value> {
    let prompt_tokens = usage_field_i64(usage, &["prompt_tokens", "input_tokens", "inputTokens"]);
    let completion_tokens =
        usage_field_i64(usage, &["completion_tokens", "output_tokens", "outputTokens"]);
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

    // OpenAI semantics: prompt_tokens already includes cached tokens, so
    // split before re-assembling the total.
    let cache_write = 0i64;
    let output_tokens = completion_tokens.max(0);
    let input = (prompt_tokens - cache_read).max(0);
    let total = input + output_tokens + cache_read + cache_write;
    if total == 0 {
        return None;
    }

    Some(json!({
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
    }))
}

/// Per-session project transcript under `<root>/projects/<workdir-slug>/
/// <sessionId>.jsonl` (2026-10 WorkBuddy sqlite migration; Claw/IM-channel
/// traffic lives only here). Must not match the `.file-rollback.ndjson`
/// sidecars or `trace_*` files.
fn is_project_file(path: &str) -> bool {
    let p = Path::new(path);
    let name = match p.file_name().and_then(|n| n.to_str()) {
        Some(n) => n,
        None => return false,
    };
    if !name.ends_with(".jsonl") || name.starts_with("trace_") {
        return false;
    }
    p.ancestors()
        .skip(1)
        .any(|a| a.file_name().map(|n| n == "projects").unwrap_or(false))
}

/// Session id = project file stem (WorkBuddy session uuid).
fn project_session_id(file: &str) -> Option<String> {
    let stem = Path::new(file)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())?;
    if stem.is_empty() {
        None
    } else {
        Some(stem)
    }
}

/// Suppression-oriented time-window match: same window as
/// `resolve_session_and_workdir_jsonl` but ignores `deleted_at` and cwd —
/// used only to decide whether the session's project transcript replaces
/// this trace. A soft-deleted session row must not defeat exclusivity.
fn window_matched_session_id(root: Option<&Path>, started_ms: i64) -> Option<String> {
    let root = root?;
    let db_path = root.join("workbuddy.db");
    if !db_path.exists() {
        return None;
    }
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    conn.query_row(
        "SELECT id FROM sessions \
         WHERE created_at <= ?1 AND ?2 <= COALESCE(last_activity_at, updated_at) \
         ORDER BY created_at DESC LIMIT 1",
        rusqlite::params![started_ms + 5000, started_ms],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

/// Probe `<root>/projects/*/<sessionId>.jsonl` for the provider root of the
/// given trace file (`<root>/traces/<pid>/...`). Returns the project file
/// path when the session has a transcript.
fn project_file_for_session(trace_file: &str, session_id: &str) -> Option<PathBuf> {
    let root = root_and_pid(trace_file).0?;
    let projects = root.join("projects");
    let slug_dirs = fs::read_dir(&projects).ok()?;
    for entry in slug_dirs.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let candidate = entry.path().join(format!("{}.jsonl", session_id));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Attribution for project files: exact `workbuddy.db` sessions lookup by id
/// (the transcript itself carries no cwd and the dir slug is lossy-encoded).
/// Degrades silently to an empty workdir.
fn resolve_project_session_and_workdir(file: &str, session_id: &str) -> (String, String) {
    let root = Path::new(file)
        .ancestors()
        .skip(1)
        .find(|a| a.file_name().map(|n| n == "projects").unwrap_or(false))
        .and_then(|projects_dir| projects_dir.parent());
    if let Some(root) = root {
        let db_path = root.join("workbuddy.db");
        if db_path.exists() {
            let conn = Connection::open_with_flags(
                &db_path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            );
            if let Ok(conn) = conn {
                if let Ok(cwd) = conn.query_row(
                    "SELECT cwd FROM sessions WHERE id = ?1",
                    [session_id],
                    |row| row.get::<_, String>(0),
                ) {
                    if !cwd.is_empty() {
                        return (session_id.to_string(), cwd);
                    }
                }
            }
        }
    }
    (session_id.to_string(), String::new())
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

/// Layout is `<root>/traces/<pid>/trace_*.json[l]`: the provider root is the
/// parent of the `traces` directory (the nearest such ancestor).
fn root_and_pid(file: &str) -> (Option<PathBuf>, String) {
    let file_path = Path::new(file);
    let pid_dir = file_path.parent();
    let pid = pid_dir
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let root = pid_dir
        .and_then(|p| p.parent())
        .filter(|p| p.file_name().map(|n| n == "traces").unwrap_or(false))
        .and_then(|traces_dir| traces_dir.parent())
        .map(|p| p.to_path_buf());
    (root, pid)
}

/// Attribution for streaming jsonl traces: records carry no sessionId and the
/// legacy `sessions/<pid>.json` sidecar no longer exists, so match the trace
/// start against `workbuddy.db` session activity windows (created_at ≤ start
/// ≤ last activity; newest created session wins). A 5s slack on created_at
/// absorbs title-generation spans that start milliseconds before the session
/// row commits. sessionId falls back to `workerPid`. The db read degrades
/// silently; no `current_dir()` noise fallback.
fn resolve_session_and_workdir_jsonl(
    file: &str,
    trace: &Value,
    started_ms: i64,
) -> (String, String) {
    let (root, _pid) = root_and_pid(file);
    let worker_pid = worker_pid_string(trace);

    if let Some(root) = root {
        let db_path = root.join("workbuddy.db");
        if db_path.exists() {
            // Read-only: WAL-safe for the live WorkBuddy database.
            let conn = Connection::open_with_flags(
                &db_path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            );
            if let Ok(conn) = conn {
                let matched = conn.query_row(
                    "SELECT id, cwd FROM sessions \
                     WHERE (deleted_at IS NULL OR deleted_at <= 0) \
                       AND created_at <= ?1 \
                       AND ?2 <= COALESCE(last_activity_at, updated_at) \
                     ORDER BY created_at DESC LIMIT 1",
                    rusqlite::params![started_ms + 5000, started_ms],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                );
                if let Ok((id, cwd)) = matched {
                    if !id.is_empty() && !cwd.is_empty() {
                        return (id, cwd);
                    }
                }
            }
        }
    }

    (worker_pid, String::new())
}

/// Resolve (sessionId, workdirCandidate) for a legacy trace file:
/// 1. sessionId: trace-level `sessionId` → sibling `sessions/<pid>.json`
///    `sessionId` → `workerPid` as string.
/// 2. workdir: sibling `sessions/<pid>.json` `cwd` when its `sessionId`
///    matches → read-only `workbuddy.db` `SELECT cwd FROM sessions` → empty.
///    The db fallback degrades silently; no `current_dir()` noise fallback.
fn resolve_session_and_workdir(file: &str, trace: &Value) -> (String, String) {
    let (root, pid) = root_and_pid(file);

    let mut session_file_id = String::new();
    let mut session_file_cwd = String::new();
    if let (Some(root), true) = (root.as_deref(), !pid.is_empty()) {
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

    if let Some(root) = root.as_deref() {
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
fn resolve_pinned<F>(file: &str, store: &mut WorkdirSnapshotStore, resolve: F) -> (String, String)
where
    F: FnOnce() -> (String, String),
{
    if let Some(pinned) = store.lookup(file) {
        return pinned;
    }
    let resolved = resolve();
    if !resolved.1.is_empty() {
        store.record(file, &resolved.0, &resolved.1);
    }
    resolved
}

fn resolve_session_and_workdir_snapshot(
    file: &str,
    trace: &Value,
    store: &mut WorkdirSnapshotStore,
) -> (String, String) {
    resolve_pinned(file, store, || resolve_session_and_workdir(file, trace))
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
        assert_eq!(VERSION, "0.3.0");
    }

    #[test]
    fn test_is_workbuddy_trace() {
        assert!(is_workbuddy_trace("/tmp/root/traces/10001/trace_abc.json"));
        // Streaming format (2026-10 WorkBuddy migration).
        assert!(is_workbuddy_trace(
            "/tmp/root/traces/10001/trace_abc.jsonl"
        ));
        assert!(!is_workbuddy_trace("/tmp/root/traces/10001/session.json"));
        assert!(!is_workbuddy_trace("/tmp/root/traces/10001/trace_abc.jsonlz"));
        assert!(!is_workbuddy_trace("/tmp/root/logs/10001/trace_abc.json"));
    }

    /// Parse a legacy trace bypassing session-level project-transcript
    /// suppression (the sample root ships a transcript for sess-10001):
    /// these tests pin the parser math, not the exclusivity policy.
    fn legacy_parse(file: &str) -> Vec<Value> {
        let mut store = WorkdirSnapshotStore::load(PathBuf::from("/nonexistent-snap.json"));
        WorkBuddyLocalProvider
            .try_parse_usage_legacy_json(file, &mut store)
            .unwrap_or_default()
    }

    #[test]
    fn test_parse_usage_sample_counts() {
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
            let events = legacy_parse(&file);
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
        let events = legacy_parse(&file);
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
        let events = legacy_parse(&file);
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

    // -----------------------------------------------------------------
    // Streaming JSONL format (2026-10 WorkBuddy migration)
    // -----------------------------------------------------------------

    /// Minimal jsonl fixture writer. `trace_end_status: None` omits the
    /// trace_end record (still-running trace).
    fn write_fixture_trace_jsonl(
        root: &Path,
        pid: &str,
        name: &str,
        trace_end_status: Option<&str>,
    ) -> String {
        let dir = root.join("traces").join(pid);
        fs::create_dir_all(&dir).unwrap();
        let started = "2026-08-21T08:29:00Z";
        let mut lines = vec![json!({
            "type": "trace_start",
            "trace": {
                "traceId": name, "name": "Agent workflow",
                "workerPid": pid.parse::<i64>().unwrap(),
                "startedAt": started, "status": "running",
                "spanCount": 0, "totalTokens": 0, "metadata": {},
            }
        })
        .to_string()];
        if let Some(status) = trace_end_status {
            lines.push(
                json!({
                    "type": "trace_end",
                    "trace": {
                        "traceId": name, "name": "Agent workflow",
                        "workerPid": pid.parse::<i64>().unwrap(),
                        "startedAt": started, "endedAt": "2026-08-21T08:29:05Z",
                        "status": status, "spanCount": 1, "totalTokens": 0,
                        "metadata": {},
                    }
                })
                .to_string(),
            );
        }
        lines.push(
            json!({
                "type": "span_end",
                "span": {
                    "traceId": name, "spanId": "span_g1", "type": "generation",
                    "status": "ok",
                    "toolInput": "PRIVACY-PLAINTEXT-NEVER-READ",
                    "toolOutput": "[{\"model\":\"auto\",\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":200,\"total_tokens\":1200}}]",
                }
            })
            .to_string(),
        );
        let path = dir.join(format!("{}.jsonl", name));
        fs::write(&path, lines.join("\n")).unwrap();
        path.to_string_lossy().to_string()
    }

    /// Minimal `workbuddy.db` sessions table fixture:
    /// (id, cwd, created_at_ms, updated_at_ms, last_activity_ms, deleted_at_ms).
    fn write_workbuddy_db(root: &Path, rows: &[(&str, &str, i64, i64, Option<i64>, Option<i64>)]) {
        let conn = Connection::open(root.join("workbuddy.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (\
                 id TEXT PRIMARY KEY, cwd TEXT NOT NULL, \
                 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, \
                 last_activity_at INTEGER, deleted_at INTEGER);",
        )
        .unwrap();
        for (id, cwd, ca, ua, laa, dela) in rows {
            conn.execute(
                "INSERT INTO sessions (id, cwd, created_at, updated_at, last_activity_at, deleted_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![id, cwd, ca, ua, laa, dela],
            )
            .unwrap();
        }
    }

    #[test]
    fn test_parse_usage_jsonl_sample_counts_and_math() {
        let file = match sample_dir() {
            Some(d) => d
                .join("traces")
                .join("10004")
                .join("trace_ffff6666.jsonl")
                .to_string_lossy()
                .to_string(),
            _ => return,
        };
        if !Path::new(&file).exists() {
            return;
        }
        let mut store = WorkdirSnapshotStore::load(PathBuf::from("/nonexistent-snap.json"));
        let events = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&file, &mut store)
            .unwrap();
        assert_eq!(events.len(), 2, "two generation span_end records");

        let first = events
            .iter()
            .find(|e| e["model"] == "auto")
            .expect("span 1 uses model auto");
        assert_eq!(first["inputTokens"], 1000);
        assert_eq!(first["outputTokens"], 300);
        assert_eq!(first["cacheReadTokens"], 500);
        assert_eq!(first["reasoningTokens"], 50);
        assert_eq!(first["totalTokens"], 1800);
        // Samples carry no sessions/<pid>.json and no workbuddy.db → the
        // workerPid fallback identifies the session, workdir stays empty.
        assert_eq!(first["sessionId"], "10004");
        assert_eq!(first["workdirCandidate"], "");
        assert_eq!(first["parserVersion"], VERSION);

        let second = events
            .iter()
            .find(|e| e["model"] == "test-model-b")
            .expect("span 2 uses test-model-b");
        assert_eq!(second["inputTokens"], 500);
        assert_eq!(second["outputTokens"], 200);
        assert_eq!(second["cacheReadTokens"], 300);
        assert_eq!(second["totalTokens"], 1000);
    }

    #[test]
    fn test_parse_usage_jsonl_running_trace_skipped() {
        let root = temp_fixture_dir("jsonl-running");
        let file = write_fixture_trace_jsonl(&root, "10001", "trace_jrun0001", None);
        let mut store = WorkdirSnapshotStore::load(root.join("snap.json"));
        let result = WorkBuddyLocalProvider.try_parse_usage_with_store(&file, &mut store);
        assert!(result.is_ok(), "running trace must not be an Err");
        assert!(
            result.unwrap().is_empty(),
            "trace without trace_end must emit nothing yet"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_parse_usage_jsonl_error_status_skipped() {
        let root = temp_fixture_dir("jsonl-error");
        let file = write_fixture_trace_jsonl(&root, "10001", "trace_jerr0002", Some("error"));
        let mut store = WorkdirSnapshotStore::load(root.join("snap.json"));
        let result = WorkBuddyLocalProvider.try_parse_usage_with_store(&file, &mut store);
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_parse_usage_jsonl_partial_file_tolerated() {
        // WorkBuddy streams records line by line; a scan can race between
        // file creation and the first flush. Such files must be skipped
        // without an error (a provider error would block the whole scan's
        // persist), then reparsed once the file grows.
        let root = temp_fixture_dir("jsonl-partial");
        let dir = root.join("traces").join("10001");
        fs::create_dir_all(&dir).unwrap();
        let empty = dir.join("trace_jempty003.jsonl");
        fs::write(&empty, "").unwrap();
        let garbage = dir.join("trace_jgarbage4.jsonl");
        fs::write(&garbage, "not-json\nalso-not-json\n").unwrap();
        let spans_only = dir.join("trace_jspans005.jsonl");
        fs::write(
            &spans_only,
            "{\"type\":\"span_start\",\"span\":{\"type\":\"generation\"}}\n",
        )
        .unwrap();
        let mut store = WorkdirSnapshotStore::load(root.join("snap.json"));
        for f in [&empty, &garbage, &spans_only] {
            let result =
                WorkBuddyLocalProvider.try_parse_usage_with_store(&f.to_string_lossy(), &mut store);
            assert!(result.is_ok(), "{:?} must not be an Err", f);
            assert!(result.unwrap().is_empty(), "{:?} must emit nothing", f);
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_parse_usage_jsonl_workdir_time_window_db() {
        let root = temp_fixture_dir("jsonl-window");
        let file = write_fixture_trace_jsonl(&root, "10001", "trace_jwin0006", Some("ok"));
        let started_ms = parse_iso8601_to_ms("2026-08-21T08:29:00Z").unwrap();
        write_workbuddy_db(
            &root,
            &[
                // Window closed before the trace started → no match.
                ("sess-early", "/proj/early", started_ms - 3_600_000, started_ms - 3_000_000, Some(started_ms - 3_000_000), None),
                // Activity window contains the trace start → match.
                ("sess-window", "/proj/window", started_ms - 3_000, started_ms + 60_000, Some(started_ms + 60_000), None),
            ],
        );
        let mut store = WorkdirSnapshotStore::load(root.join("snap.json"));
        let events = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&file, &mut store)
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["sessionId"], "sess-window");
        assert_eq!(events[0]["workdirCandidate"], "/proj/window");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_parse_usage_jsonl_deleted_session_excluded() {
        let root = temp_fixture_dir("jsonl-deleted");
        let file = write_fixture_trace_jsonl(&root, "10001", "trace_jdel0007", Some("ok"));
        let started_ms = parse_iso8601_to_ms("2026-08-21T08:29:00Z").unwrap();
        // The only in-window session was deleted after the fact → attribution
        // falls back to workerPid with an empty workdir.
        write_workbuddy_db(
            &root,
            &[(
                "sess-gone",
                "/proj/gone",
                started_ms - 3_000,
                started_ms + 60_000,
                Some(started_ms + 60_000),
                Some(started_ms + 120_000),
            )],
        );
        let mut store = WorkdirSnapshotStore::load(root.join("snap.json"));
        let events = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&file, &mut store)
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["sessionId"], "10001");
        assert_eq!(events[0]["workdirCandidate"], "");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_parse_usage_jsonl_attribution_pinned_across_rescans() {
        // Same drift protection as the legacy format: once pinned, a later
        // changed db must not re-attribute an immutable trace file.
        let root = temp_fixture_dir("jsonl-pin");
        let file = write_fixture_trace_jsonl(&root, "10001", "trace_jpin0008", Some("ok"));
        let started_ms = parse_iso8601_to_ms("2026-08-21T08:29:00Z").unwrap();
        let cache_path = root.join("snap.json");

        write_workbuddy_db(
            &root,
            &[(
                "sess-A",
                "/proj/alpha",
                started_ms - 3_000,
                started_ms + 60_000,
                Some(started_ms + 60_000),
                None,
            )],
        );
        let mut store1 = WorkdirSnapshotStore::load(cache_path.clone());
        let events1 = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&file, &mut store1)
            .unwrap();
        store1.save_if_dirty();
        assert_eq!(events1[0]["workdirCandidate"], "/proj/alpha");

        // The db is rewritten to point elsewhere (session replaced).
        let _ = fs::remove_file(root.join("workbuddy.db"));
        write_workbuddy_db(
            &root,
            &[(
                "sess-B",
                "/proj/beta",
                started_ms - 3_000,
                started_ms + 60_000,
                Some(started_ms + 60_000),
                None,
            )],
        );
        let mut store2 = WorkdirSnapshotStore::load(cache_path);
        let events2 = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&file, &mut store2)
            .unwrap();
        assert_eq!(events2[0]["sessionId"], "sess-A");
        assert_eq!(events2[0]["workdirCandidate"], "/proj/alpha");
        let _ = fs::remove_dir_all(&root);
    }

    // -----------------------------------------------------------------
    // Per-session project transcripts (projects/<slug>/<sessionId>.jsonl)
    // -----------------------------------------------------------------

    #[test]
    fn test_is_workbuddy_project_file() {
        assert!(is_project_file(
            "/tmp/root/projects/Users-x-y/sess-abc.jsonl"
        ));
        // Rollback sidecars and trace files must not match.
        assert!(!is_project_file(
            "/tmp/root/projects/Users-x-y/sess-abc.file-rollback.ndjson"
        ));
        assert!(!is_project_file("/tmp/root/projects/Users-x-y/trace_abc.jsonl"));
        assert!(!is_project_file("/tmp/root/traces/10001/sess-abc.jsonl"));
        assert!(!is_project_file("/tmp/root/projects/Users-x-y/sess-abc.json"));
    }

    #[test]
    fn test_parse_usage_project_file_counts_and_math() {
        let file = match sample_dir() {
            Some(d) => d
                .join("projects")
                .join("Users-tmp-wb-sample-project-one")
                .join("sess-10001.jsonl")
                .to_string_lossy()
                .to_string(),
            _ => return,
        };
        if !Path::new(&file).exists() {
            return;
        }
        let mut store = WorkdirSnapshotStore::load(PathBuf::from("/nonexistent-snap.json"));
        let events = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&file, &mut store)
            .unwrap();
        // The rawUsage record without a timestamp must be skipped.
        assert_eq!(events.len(), 2, "two timestamped rawUsage records");

        let glm = events
            .iter()
            .find(|e| e["model"] == "glm-5.3-flash")
            .expect("assistant message record");
        assert_eq!(glm["inputTokens"], 1500);
        assert_eq!(glm["outputTokens"], 400);
        assert_eq!(glm["cacheReadTokens"], 500);
        assert_eq!(glm["reasoningTokens"], 80);
        assert_eq!(glm["totalTokens"], 2400);
        assert_eq!(glm["sessionId"], "sess-10001");
        // Samples carry no workbuddy.db → workdir stays empty, no decode of
        // the lossy dir slug.
        assert_eq!(glm["workdirCandidate"], "");

        let ds = events
            .iter()
            .find(|e| e["model"] == "deepseek-v4.1-flash")
            .expect("function_call record");
        assert_eq!(ds["inputTokens"], 900);
        assert_eq!(ds["outputTokens"], 100);
        assert_eq!(ds["totalTokens"], 1000);

        // The timestamp-less rawUsage (777+111=888) must not appear anywhere.
        assert!(events.iter().all(|e| e["totalTokens"] != 888));
    }

    #[test]
    fn test_parse_usage_project_db_attribution() {
        let root = temp_fixture_dir("proj-db");
        let dir = root.join("projects").join("Users-proj-db");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sess-proj1.jsonl");
        fs::write(
            &file,
            json!({
                "type": "message", "role": "assistant", "timestamp": 1780920000000i64,
                "providerData": {"model": "glm-5.3-flash",
                    "rawUsage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}}
            })
            .to_string(),
        )
        .unwrap();
        write_workbuddy_db(
            &root,
            &[(
                "sess-proj1",
                "/proj/from-db",
                1780910000000,
                1780930000000,
                Some(1780930000000i64),
                None,
            )],
        );
        let file = file.to_string_lossy().to_string();
        let mut store = WorkdirSnapshotStore::load(root.join("snap.json"));
        let events = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&file, &mut store)
            .unwrap();
        assert_eq!(events.len(), 1);
        // Exact id lookup (not a time window): workdir comes from sessions.cwd.
        assert_eq!(events[0]["sessionId"], "sess-proj1");
        assert_eq!(events[0]["workdirCandidate"], "/proj/from-db");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_parse_usage_project_unknown_session_empty_workdir() {
        let root = temp_fixture_dir("proj-nodb");
        let dir = root.join("projects").join("Users-proj-x");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sess-gone.jsonl");
        fs::write(
            &file,
            json!({
                "type": "function_call", "timestamp": 1780920000000i64,
                "providerData": {"model": "m", "rawUsage": {"prompt_tokens": 10, "completion_tokens": 5}}
            })
            .to_string(),
        )
        .unwrap();
        let file = file.to_string_lossy().to_string();
        let mut store = WorkdirSnapshotStore::load(root.join("snap.json"));
        let events = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&file, &mut store)
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["sessionId"], "sess-gone");
        assert_eq!(events[0]["workdirCandidate"], "");
        assert_eq!(events[0]["totalTokens"], 15);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_trace_suppressed_by_session_project_transcript() {
        // Same-session project transcript suppresses the trace files; the
        // check is per-parse, so deleting the transcript re-admits the trace.
        let root = temp_fixture_dir("proj-suppress");
        let file = write_fixture_trace_jsonl(&root, "10001", "trace_jsup0009", Some("ok"));
        let started_ms = parse_iso8601_to_ms("2026-08-21T08:29:00Z").unwrap();
        write_workbuddy_db(
            &root,
            &[(
                "sess-sup",
                "/proj/sup",
                started_ms - 3_000,
                started_ms + 60_000,
                Some(started_ms + 60_000),
                None,
            )],
        );

        let mut store = WorkdirSnapshotStore::load(root.join("snap.json"));
        let events = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&file, &mut store)
            .unwrap();
        assert_eq!(events.len(), 1, "trace counts while no transcript exists");

        // The session gains a project transcript → trace emits nothing.
        let proj_dir = root.join("projects").join("Users-proj-sup");
        fs::create_dir_all(&proj_dir).unwrap();
        let proj_file = proj_dir.join("sess-sup.jsonl");
        fs::write(
            &proj_file,
            json!({
                "type": "message", "role": "assistant", "timestamp": started_ms,
                "providerData": {"model": "m", "rawUsage": {"prompt_tokens": 5, "completion_tokens": 5}}
            })
            .to_string(),
        )
        .unwrap();
        let mut store2 = WorkdirSnapshotStore::load(root.join("snap.json"));
        let events2 = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&file, &mut store2)
            .unwrap();
        assert!(
            events2.is_empty(),
            "session with a project transcript must suppress the trace file"
        );

        // Transcript cleaned up → trace re-admitted.
        let _ = fs::remove_file(&proj_file);
        let mut store3 = WorkdirSnapshotStore::load(root.join("snap.json"));
        let events3 = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&file, &mut store3)
            .unwrap();
        assert_eq!(events3.len(), 1, "transcript cleanup re-admits the trace");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_trace_suppressed_via_window_match_despite_soft_deleted_row() {
        // Review-found regression guard: when the session row is soft-deleted
        // (or matched with an empty cwd) the emitted sessionId degrades to
        // workerPid, but the raw time-window match must still drive
        // suppression — otherwise transcript + trace double count the
        // session.
        let root = temp_fixture_dir("proj-del-sup");
        let file = write_fixture_trace_jsonl(&root, "10001", "trace_jdel0010", Some("ok"));
        let started_ms = parse_iso8601_to_ms("2026-08-21T08:29:00Z").unwrap();
        // Soft-deleted row with an EMPTY cwd: both attribution degradations
        // at once.
        write_workbuddy_db(
            &root,
            &[(
                "sess-del",
                "",
                started_ms - 3_000,
                started_ms + 60_000,
                Some(started_ms + 60_000),
                Some(started_ms + 120_000),
            )],
        );
        let proj_dir = root.join("projects").join("Users-proj-del");
        fs::create_dir_all(&proj_dir).unwrap();
        fs::write(
            proj_dir.join("sess-del.jsonl"),
            json!({
                "type": "message", "role": "assistant", "timestamp": started_ms,
                "providerData": {"model": "m", "rawUsage": {"prompt_tokens": 5, "completion_tokens": 5}}
            })
            .to_string(),
        )
        .unwrap();

        let mut store = WorkdirSnapshotStore::load(root.join("snap.json"));
        let events = WorkBuddyLocalProvider
            .try_parse_usage_with_store(&file, &mut store)
            .unwrap();
        assert!(
            events.is_empty(),
            "soft-deleted row with transcript must still suppress the trace"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_parse_usage_day_hour_and_session_from_sessions_file() {
        let file = match sample_trace("10001", "trace_aaaa1111") {
            Some(f) if Path::new(&f).exists() => f,
            _ => return,
        };
        let events = legacy_parse(&file);
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
        // Streaming jsonl traces (2026-10 WorkBuddy migration) must be
        // discovered too — missing this filter was a silent collection outage.
        assert!(sessions.iter().any(|s| s.contains("samples/workbuddy")
            && s.contains("trace_ffff6666")
            && s.ends_with(".jsonl")));
        // Path separators differ by OS: walk_files joins the traces/projects
        // components with `\` on Windows and `/` elsewhere.
        assert!(sessions
            .iter()
            .all(|s| s.contains("/traces/") || s.contains("\\traces\\")
                || s.contains("/projects/") || s.contains("\\projects\\")));
        // Per-session project transcripts must be discovered too — the
        // Claw/IM channel traffic lives only there.
        assert!(sessions.iter().any(|s| s.contains("samples/workbuddy")
            && s.contains("projects")
            && s.ends_with("sess-10001.jsonl")));
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
