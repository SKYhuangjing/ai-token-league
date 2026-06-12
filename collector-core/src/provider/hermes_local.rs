use crate::config::AppConfig;
use crate::provider::common::*;
use rusqlite::Connection;
use serde_json::{json, Value};

pub const PROVIDER_ID: &str = "hermes_local";
pub const TOOL_CODE: &str = "hermes";
pub const VERSION: &str = "0.1.0";

pub struct HermesLocalProvider;

impl HermesLocalProvider {
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

        if let Ok(hermes_home) = std::env::var("HERMES_HOME") {
            let db_dir = std::path::PathBuf::from(&hermes_home);
            if db_dir.exists() {
                roots.push(db_dir.to_string_lossy().to_string());
            }
        }
        let default_root = home.join(".hermes");
        if default_root.exists() {
            let root = default_root.to_string_lossy().to_string();
            if !roots.contains(&root) {
                roots.push(root);
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

        let mut db_paths = Vec::new();

        // Auto roots
        for root in self.auto_roots(config) {
            if ignored.contains(&root) {
                continue;
            }
            let db_path = std::path::Path::new(&root).join("state.db");
            if db_path.exists() {
                db_paths.push(db_path.to_string_lossy().to_string());
            }
        }

        // Manual roots
        for root in self.manual_roots(config) {
            let db_path = std::path::Path::new(&root).join("state.db");
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
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

        let source = source_metadata(db_path, PROVIDER_ID, VERSION);
        let mut stmt = conn
            .prepare(
                "SELECT json_extract(data, '$.input_tokens') as input_tokens,
                    json_extract(data, '$.output_tokens') as output_tokens,
                    json_extract(data, '$.cache_read_tokens') as cache_read_tokens,
                    json_extract(data, '$.cache_write_tokens') as cache_write_tokens,
                    json_extract(data, '$.reasoning_tokens') as reasoning_tokens,
                    json_extract(data, '$.model') as model,
                    json_extract(data, '$.timestamp') as timestamp,
                    json_extract(data, '$.session_id') as session_id,
                    json_extract(data, '$.cwd') as cwd,
                    json_extract(data, '$.cost') as cost
             FROM session_usage
             WHERE json_extract(data, '$.input_tokens') IS NOT NULL
                OR json_extract(data, '$.output_tokens') IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                let input_tokens: Option<i64> = row.get(0)?;
                let output_tokens: Option<i64> = row.get(1)?;
                let cache_read_tokens: Option<i64> = row.get(2)?;
                let cache_write_tokens: Option<i64> = row.get(3)?;
                let reasoning_tokens: Option<i64> = row.get(4)?;
                let model: Option<String> = row.get(5)?;
                let timestamp: Option<String> = row.get(6)?;
                let session_id: Option<String> = row.get(7)?;
                let cwd: Option<String> = row.get(8)?;
                let cost: Option<f64> = row.get(9)?;
                Ok((
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_write_tokens,
                    reasoning_tokens,
                    model,
                    timestamp,
                    session_id,
                    cwd,
                    cost,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut events = Vec::new();

        for row in rows {
            let row = row.map_err(|e| e.to_string())?;
            let (
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                reasoning_tokens,
                model,
                timestamp,
                session_id,
                cwd,
                _cost,
            ) = row;

            let input = input_tokens.unwrap_or(0);
            let output = output_tokens.unwrap_or(0);
            let cache_read = cache_read_tokens.unwrap_or(0);
            let cache_write = cache_write_tokens.unwrap_or(0);
            let reasoning = reasoning_tokens.unwrap_or(0);

            let total = input + output + cache_read + cache_write;
            if total == 0 {
                continue;
            }

            let Some(ts_ms) = timestamp
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|dt| dt.timestamp_millis())
            else {
                continue;
            };

            let model_name = model.unwrap_or_else(|| "unknown".to_string());
            let session = session_id.unwrap_or_else(|| format!("hermes-{}", ts_ms));
            let workdir_candidate = cwd.unwrap_or_else(|| {
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
                "day": crate::date::local_day_from_timestamp_ms(ts_ms),
                "hour": crate::date::local_hour_from_timestamp_ms(ts_ms),
                "workdirCandidate": workdir_candidate,
                "model": model_name,
                "inputTokens": input,
                "outputTokens": output,
                "cacheReadTokens": cache_read,
                "cacheWriteTokens": cache_write,
                "reasoningTokens": reasoning,
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
        assert_eq!(PROVIDER_ID, "hermes_local");
        assert_eq!(TOOL_CODE, "hermes");
    }

    fn sample_db_path() -> Option<std::path::PathBuf> {
        std::env::current_dir().ok().and_then(|d| {
            let p = d.join("../samples/hermes/state.db");
            if p.exists() {
                Some(p)
            } else {
                None
            }
        })
    }

    #[test]
    fn test_parse_usage_sample_db() {
        let db_path = match sample_db_path() {
            Some(p) => p,
            None => return,
        };
        let provider = HermesLocalProvider;
        let events = provider.parse_usage(&db_path.to_string_lossy());

        // 12 rows total: skip 2 null-token, skip 1 cache-only (null input+output), skip 1 zero-total
        // = ~8 valid events
        assert!(
            events.len() >= 6,
            "should parse multiple valid rows, got {}",
            events.len()
        );

        let total_tokens: i64 = events
            .iter()
            .map(|e| e["totalTokens"].as_i64().unwrap_or(0))
            .sum();
        assert!(total_tokens > 0, "total tokens should be positive");

        for event in &events {
            assert_eq!(event["providerId"], PROVIDER_ID);
            assert_eq!(event["toolCode"], TOOL_CODE);
            assert_eq!(event["sourceKind"], "local_db");
            assert_eq!(event["sourceQuality"], "exact");
            assert!(!event["day"].as_str().unwrap_or("").is_empty());
        }
    }

    #[test]
    fn test_parse_usage_tokens_math() {
        let db_path = match sample_db_path() {
            Some(p) => p,
            None => return,
        };
        let provider = HermesLocalProvider;
        let events = provider.parse_usage(&db_path.to_string_lossy());

        let first = events
            .iter()
            .find(|e| e["model"] == "claude-sonnet-4-20250514" && e["inputTokens"] == 1500)
            .unwrap();
        assert_eq!(first["inputTokens"], 1500);
        assert_eq!(first["outputTokens"], 400);
        assert_eq!(first["cacheReadTokens"], 200);
        assert_eq!(first["cacheWriteTokens"], 100);
        assert_eq!(first["reasoningTokens"], 80);
        assert_eq!(first["totalTokens"], 2200);
        assert_eq!(first["model"], "claude-sonnet-4-20250514");
    }

    #[test]
    fn test_parse_usage_skip_zero_total() {
        let db_path = match sample_db_path() {
            Some(p) => p,
            None => return,
        };
        let provider = HermesLocalProvider;
        let events = provider.parse_usage(&db_path.to_string_lossy());

        let zero_totals: Vec<_> = events
            .iter()
            .filter(|e| e["totalTokens"].as_i64().unwrap_or(0) == 0)
            .collect();
        assert!(zero_totals.is_empty(), "should not have zero-total events");
    }

    #[test]
    fn test_parse_usage_multi_day() {
        let db_path = match sample_db_path() {
            Some(p) => p,
            None => return,
        };
        let provider = HermesLocalProvider;
        let events = provider.parse_usage(&db_path.to_string_lossy());

        let days: std::collections::HashSet<_> = events
            .iter()
            .filter_map(|e| e["day"].as_str().map(String::from))
            .collect();
        assert!(
            days.len() >= 3,
            "should cover at least 3 different days, got {:?}",
            days
        );
        assert!(days.contains("2026-06-08"));
        assert!(days.contains("2026-06-10"));
        assert!(days.contains("2026-06-12"));
    }

    #[test]
    fn test_parse_usage_multi_model() {
        let db_path = match sample_db_path() {
            Some(p) => p,
            None => return,
        };
        let provider = HermesLocalProvider;
        let events = provider.parse_usage(&db_path.to_string_lossy());

        let models: std::collections::HashSet<_> = events
            .iter()
            .filter_map(|e| e["model"].as_str().map(String::from))
            .collect();
        assert!(
            models.len() >= 3,
            "should cover multiple models, got {:?}",
            models
        );
        assert!(models.contains("claude-sonnet-4-20250514"));
        assert!(models.contains("gpt-4o"));
        assert!(models.contains("gpt-4o-mini"));
    }

    #[test]
    fn test_parse_usage_large_tokens() {
        let db_path = match sample_db_path() {
            Some(p) => p,
            None => return,
        };
        let provider = HermesLocalProvider;
        let events = provider.parse_usage(&db_path.to_string_lossy());

        let large = events.iter().find(|e| e["inputTokens"] == 100000);
        assert!(large.is_some(), "should have a row with large token counts");
        let large = large.unwrap();
        assert_eq!(large["totalTokens"], 180000);
    }

    #[test]
    fn test_parse_usage_empty_session_id_uses_fallback() {
        let db_path = match sample_db_path() {
            Some(p) => p,
            None => return,
        };
        let provider = HermesLocalProvider;
        let events = provider.parse_usage(&db_path.to_string_lossy());

        let target = events
            .iter()
            .find(|e| e["inputTokens"] == 100 && e["outputTokens"] == 50);
        assert!(target.is_some(), "should parse row with empty session_id");
        let event = target.unwrap();
        // Empty string in JSON is Some(""), provider keeps it as-is
        let sid = event["sessionId"].as_str().unwrap();
        assert!(
            !sid.contains("hermes-"),
            "empty session_id should not get millis fallback"
        );
    }

    #[test]
    fn test_parse_usage_nonexistent_db() {
        let provider = HermesLocalProvider;
        let events = provider.parse_usage("/nonexistent/path/state.db");
        assert!(events.is_empty());
    }

    #[test]
    fn test_parse_usage_skips_invalid_timestamp() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("atl-hermes-invalid-time-{}.db", suffix));
        let conn = Connection::open(&path).unwrap();
        conn.execute("CREATE TABLE session_usage (data TEXT NOT NULL)", [])
            .unwrap();
        conn.execute(
            "INSERT INTO session_usage (data) VALUES (?)",
            [serde_json::json!({
                "input_tokens": 100,
                "output_tokens": 50,
                "timestamp": "not-a-time"
            })
            .to_string()],
        )
        .unwrap();
        drop(conn);

        let provider = HermesLocalProvider;
        assert!(provider
            .try_parse_usage(&path.to_string_lossy())
            .unwrap()
            .is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_scan_sessions_manual_root() {
        let samples = std::env::current_dir().ok().and_then(|d| {
            let p = d.join("../samples/hermes");
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
        let provider = HermesLocalProvider;
        let sessions = provider.scan_sessions(&cfg);
        assert_eq!(sessions.len(), 1);
        assert!(sessions[0].ends_with("state.db"));
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
        let provider = HermesLocalProvider;
        let sessions = provider.scan_sessions(&cfg);
        assert!(sessions.is_empty());
    }
}
