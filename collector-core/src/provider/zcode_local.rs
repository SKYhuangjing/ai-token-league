use crate::config::AppConfig;
use crate::provider::common::*;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::HashMap;

pub const PROVIDER_ID: &str = "zcode_local";
pub const TOOL_CODE: &str = "zcode";
pub const VERSION: &str = "0.1.0";

/// ZCode stores request-level usage in `~/.zcode/cli/db/db.sqlite`
/// (`model_usage` table, `session.directory` for workdir attribution).
pub struct ZCodeLocalProvider;

struct UsageRow {
    logical_request_id: String,
    attempt_index: i64,
    status: String,
    started_at_ms: i64,
    session_id: String,
    directory: Option<String>,
    model_id: String,
    input_tokens: i64,
    output_tokens: i64,
    reasoning_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
}

impl ZCodeLocalProvider {
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

        let default_root = home.join(".zcode").join("cli");
        if default_root.exists() {
            roots.push(default_root.to_string_lossy().to_string());
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

        let mut db_paths = Vec::new();

        // Auto roots
        for root in self.auto_roots(config) {
            if ignored.contains(&root) {
                continue;
            }
            let db_path = std::path::Path::new(&root).join("db").join("db.sqlite");
            if db_path.exists() {
                db_paths.push(db_path.to_string_lossy().to_string());
            }
        }

        // Manual roots
        for root in self.manual_roots(config) {
            let db_path = std::path::Path::new(&root).join("db").join("db.sqlite");
            if db_path.exists() && !db_paths.contains(&db_path.to_string_lossy().to_string()) {
                db_paths.push(db_path.to_string_lossy().to_string());
            }
        }

        db_paths
    }

    pub fn parse_usage(&self, db_path: &str) -> Vec<Value> {
        self.try_parse_usage(db_path).unwrap_or_default()
    }

    pub fn try_parse_usage(&self, db_path: &str) -> Result<Vec<Value>, String> {
        // Read-only: the live db runs in WAL mode and belongs to the ZCode
        // process; a read-write handle could checkpoint its WAL on close.
        let conn = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| e.to_string())?;

        let source = source_metadata(db_path, PROVIDER_ID, VERSION);
        let mut stmt = conn
            .prepare(
                "SELECT m.logical_request_id,
                    m.attempt_index,
                    m.status,
                    m.started_at,
                    m.session_id,
                    s.directory,
                    m.model_id,
                    m.input_tokens,
                    m.output_tokens,
                    m.reasoning_tokens,
                    m.cache_read_input_tokens,
                    m.cache_creation_input_tokens
             FROM model_usage m
             LEFT JOIN session s ON s.id = m.session_id
             ORDER BY m.logical_request_id, m.attempt_index, m.started_at",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok(UsageRow {
                    logical_request_id: row.get(0)?,
                    attempt_index: row.get(1)?,
                    status: row.get(2)?,
                    started_at_ms: row.get(3)?,
                    session_id: row.get(4)?,
                    directory: row.get(5)?,
                    model_id: row.get(6)?,
                    input_tokens: row.get(7)?,
                    output_tokens: row.get(8)?,
                    reasoning_tokens: row.get(9)?,
                    cache_read_tokens: row.get(10)?,
                    cache_write_tokens: row.get(11)?,
                })
            })
            .map_err(|e| e.to_string())?;

        // A logical request can have several attempts (retries); count each
        // logical request once, using its latest successful attempt. Failed
        // and cancelled attempts carry zero usage in practice.
        let mut latest_attempt: HashMap<String, UsageRow> = HashMap::new();
        for row in rows {
            let row = row.map_err(|e| e.to_string())?;
            if row.status != "completed" {
                continue;
            }
            match latest_attempt.get(&row.logical_request_id) {
                Some(existing) if existing.attempt_index >= row.attempt_index => {}
                _ => {
                    latest_attempt.insert(row.logical_request_id.clone(), row);
                }
            }
        }

        let mut usage_rows: Vec<UsageRow> = latest_attempt.into_values().collect();
        usage_rows.sort_by_key(|row| row.started_at_ms);

        let mut events = Vec::new();
        for row in usage_rows {
            if row.started_at_ms <= 0 {
                continue;
            }

            // ZCode input_tokens follows OpenAI semantics and already includes
            // cached input; keep cache in its own fields (same split as codex_local).
            let cache_read = row.cache_read_tokens.max(0);
            let cache_write = row.cache_write_tokens.max(0);
            let input = (row.input_tokens - cache_read - cache_write).max(0);
            let output = row.output_tokens.max(0);

            let total = input + output + cache_read + cache_write;
            if total == 0 {
                continue;
            }

            let model = if row.model_id.trim().is_empty() {
                "unknown".to_string()
            } else {
                row.model_id
            };
            let session = if row.session_id.trim().is_empty() {
                format!("zcode-{}", row.started_at_ms)
            } else {
                row.session_id
            };
            let workdir_candidate = row.directory.unwrap_or_else(|| {
                std::env::current_dir()
                    .map(|d| d.to_string_lossy().to_string())
                    .unwrap_or_default()
            });

            events.push(json!({
                "providerId": PROVIDER_ID,
                "providerVersion": VERSION,
                "toolCode": TOOL_CODE,
                "sourceKind": "local_db",
                "sourceQuality": "exact",
                "sessionId": session,
                "day": crate::date::local_day_from_timestamp_ms(row.started_at_ms),
                "hour": crate::date::local_hour_from_timestamp_ms(row.started_at_ms),
                "workdirCandidate": workdir_candidate,
                "model": model,
                "inputTokens": input,
                "outputTokens": output,
                "cacheReadTokens": cache_read,
                "cacheWriteTokens": cache_write,
                "reasoningTokens": row.reasoning_tokens.max(0),
                "totalTokens": total,
                "rawSourceRef": source.raw_source_ref,
                "sourceFingerprint": source.source_fingerprint,
                "parserVersion": source.parser_version,
            }));
        }

        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_constants() {
        assert_eq!(PROVIDER_ID, "zcode_local");
        assert_eq!(TOOL_CODE, "zcode");
    }

    fn sample_db_path() -> Option<std::path::PathBuf> {
        std::env::current_dir().ok().and_then(|d| {
            let p = d.join("../samples/zcode/db/db.sqlite");
            if p.exists() {
                Some(p)
            } else {
                None
            }
        })
    }

    fn parse_sample() -> Vec<Value> {
        let db_path = match sample_db_path() {
            Some(p) => p,
            None => return vec![],
        };
        ZCodeLocalProvider.parse_usage(&db_path.to_string_lossy())
    }

    #[test]
    fn test_parse_usage_sample_db() {
        let events = parse_sample();
        if events.is_empty() {
            assert!(sample_db_path().is_none(), "sample db exists but parsed no events");
            return;
        }

        // 8 usage rows: skip 1 zero-total, skip 1 error attempt superseded by
        // its retry, count the winning retry attempt => 6 events
        assert_eq!(events.len(), 6, "should have 6 valid events");

        for event in &events {
            assert_eq!(event["providerId"], PROVIDER_ID);
            assert_eq!(event["toolCode"], TOOL_CODE);
            assert_eq!(event["sourceKind"], "local_db");
            assert_eq!(event["sourceQuality"], "exact");
            assert!(!event["day"].as_str().unwrap_or("").is_empty());
            assert!(event["hour"].as_u64().unwrap_or(99) < 24);
        }
    }

    #[test]
    fn test_parse_usage_tokens_math() {
        let events = parse_sample();
        if events.is_empty() {
            assert!(sample_db_path().is_none());
            return;
        }

        // Row with raw input=2000 (includes cache_read=1500), output=400
        let first = events
            .iter()
            .find(|e| e["reasoningTokens"] == 47)
            .expect("should find the reasoning row");
        assert_eq!(first["inputTokens"], 500);
        assert_eq!(first["outputTokens"], 400);
        assert_eq!(first["cacheReadTokens"], 1500);
        assert_eq!(first["cacheWriteTokens"], 0);
        assert_eq!(first["totalTokens"], 2400);
        assert_eq!(first["model"], "GLM-5.3");
        assert_eq!(first["sessionId"], "sess-sample-alpha");
        assert_eq!(first["workdirCandidate"], "/Users/demo/projects/alpha");
    }

    #[test]
    fn test_parse_usage_cache_write_split() {
        let events = parse_sample();
        if events.is_empty() {
            assert!(sample_db_path().is_none());
            return;
        }

        // Row with raw input=1000 (includes cache_write=300), output=100
        let row = events
            .iter()
            .find(|e| e["cacheWriteTokens"] == 300)
            .expect("should find the cache-write row");
        assert_eq!(row["inputTokens"], 700);
        assert_eq!(row["outputTokens"], 100);
        assert_eq!(row["cacheReadTokens"], 0);
        assert_eq!(row["totalTokens"], 1100);
    }

    #[test]
    fn test_parse_usage_total_matches_computed_total() {
        let events = parse_sample();
        if events.is_empty() {
            assert!(sample_db_path().is_none());
            return;
        }

        // Mirror of live data: raw input=25277 (cache_read=24384), output=525;
        // ZCode's own computed_total_tokens is 25802 and must match ours after
        // the cache split.
        let row = events
            .iter()
            .find(|e| e["outputTokens"] == 525)
            .expect("should find the live-data mirror row");
        assert_eq!(row["inputTokens"], 893);
        assert_eq!(row["cacheReadTokens"], 24384);
        assert_eq!(row["totalTokens"], 25802);
    }

    #[test]
    fn test_parse_usage_retry_dedup() {
        let events = parse_sample();
        if events.is_empty() {
            assert!(sample_db_path().is_none());
            return;
        }

        // Logical request r-retry has attempt 0 (error, 0 tokens) and
        // attempt 1 (completed, 800+200): only the winning attempt counts.
        let retries: Vec<_> = events
            .iter()
            .filter(|e| e["inputTokens"] == 800 && e["outputTokens"] == 200)
            .collect();
        assert_eq!(retries.len(), 1, "retry attempts should collapse to one event");
    }

    #[test]
    fn test_parse_usage_multi_day_and_model() {
        let events = parse_sample();
        if events.is_empty() {
            assert!(sample_db_path().is_none());
            return;
        }

        let days: std::collections::HashSet<_> = events
            .iter()
            .filter_map(|e| e["day"].as_str().map(String::from))
            .collect();
        assert!(
            days.contains("2026-06-08"),
            "should cover 2026-06-08, got {:?}",
            days
        );
        assert!(
            days.contains("2026-06-12"),
            "should cover 2026-06-12, got {:?}",
            days
        );

        let models: std::collections::HashSet<_> = events
            .iter()
            .filter_map(|e| e["model"].as_str().map(String::from))
            .collect();
        assert!(models.contains("GLM-5.3"));
        assert!(models.contains("GLM-5.3-Air"));
    }

    #[test]
    fn test_parse_usage_orphan_session_falls_back_to_cwd() {
        let events = parse_sample();
        if events.is_empty() {
            assert!(sample_db_path().is_none());
            return;
        }

        // Row whose session is missing from the session table: directory is
        // NULL and the event falls back to the collector cwd (non-empty),
        // while the recorded session id is kept as-is.
        let orphan = events
            .iter()
            .find(|e| e["inputTokens"] == 300 && e["outputTokens"] == 50)
            .expect("should find the orphan-session row");
        assert!(!orphan["workdirCandidate"]
            .as_str()
            .unwrap_or("")
            .is_empty());
        assert_eq!(orphan["sessionId"], "sess-missing");
    }

    #[test]
    fn test_parse_usage_nonexistent_db() {
        let provider = ZCodeLocalProvider;
        let events = provider.parse_usage("/nonexistent/path/db.sqlite");
        assert!(events.is_empty());
    }

    #[test]
    fn test_parse_usage_missing_table_is_error() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("atl-zcode-no-table-{}.db", suffix));
        let conn = Connection::open(&path).unwrap();
        conn.execute("CREATE TABLE unrelated (id TEXT)", []).unwrap();
        drop(conn);

        let provider = ZCodeLocalProvider;
        assert!(provider.try_parse_usage(&path.to_string_lossy()).is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_scan_sessions_manual_root() {
        let samples = std::env::current_dir().ok().and_then(|d| {
            let p = d.join("../samples/zcode");
            if p.exists() {
                Some(p)
            } else {
                None
            }
        });
        let db_path = match samples {
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
        cfg.provider_roots.insert(
            PROVIDER_ID.into(),
            vec![db_path.to_string_lossy().to_string()],
        );
        let provider = ZCodeLocalProvider;
        let sessions = provider.scan_sessions(&cfg);
        // A real ~/.zcode/cli may exist on the dev machine and show up as an
        // auto root; the manual sample root must always be included.
        assert!(sessions
            .iter()
            .any(|s| s.contains("samples/zcode") && s.ends_with("db/db.sqlite")));
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
        let provider = ZCodeLocalProvider;
        let sessions = provider.scan_sessions(&cfg);
        assert!(sessions.is_empty());
    }
}
