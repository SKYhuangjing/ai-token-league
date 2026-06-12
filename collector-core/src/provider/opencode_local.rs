use crate::config::AppConfig;
use crate::provider::common::*;
use rusqlite::Connection;
use serde_json::{json, Value};

pub const PROVIDER_ID: &str = "opencode_local";
pub const TOOL_CODE: &str = "opencode";
pub const VERSION: &str = "0.1.0";

pub struct OpenCodeLocalProvider;

impl OpenCodeLocalProvider {
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

        let db_dir = home.join(".local/share/opencode");
        if db_dir.exists() {
            roots.push(db_dir.to_string_lossy().to_string());
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
            let db_path = std::path::Path::new(&root).join("opencode.db");
            if db_path.exists() {
                db_paths.push(db_path.to_string_lossy().to_string());
            }
        }

        // Manual roots
        for root in self.manual_roots(config) {
            let db_path = std::path::Path::new(&root).join("opencode.db");
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
                "SELECT json_extract(m.data, '$.tokens') as tokens,
                    json_extract(m.data, '$.modelID') as modelID,
                    json_extract(m.data, '$.time.created') as created,
                    json_extract(m.data, '$.time.completed') as completed,
                    json_extract(m.data, '$.path.cwd') as cwd,
                    json_extract(m.data, '$.role') as role,
                    json_extract(m.data, '$.agent') as agent
             FROM message m
             WHERE json_extract(m.data, '$.tokens') IS NOT NULL
               AND json_extract(m.data, '$.role') = 'assistant'",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                let tokens_str: String = row.get(0)?;
                let model_id: Option<String> = row.get(1)?;
                let created: Option<i64> = row.get(2)?;
                let completed: Option<i64> = row.get(3)?;
                let cwd: Option<String> = row.get(4)?;
                let agent: Option<String> = row.get(6)?;
                Ok((tokens_str, model_id, created, completed, cwd, agent))
            })
            .map_err(|e| e.to_string())?;

        let mut events = Vec::new();

        for row in rows {
            let row = row.map_err(|e| e.to_string())?;
            let (tokens_str, model_id, created, _completed, cwd, agent) = row;

            let tokens: Value = match serde_json::from_str(&tokens_str) {
                Ok(t) => t,
                Err(_) => continue,
            };

            let input_tokens = tokens["input"].as_i64().unwrap_or(0);
            let output_tokens = tokens["output"].as_i64().unwrap_or(0);
            let cache_read = tokens["cache"]["read"].as_i64().unwrap_or(0);
            let cache_write = tokens["cache"]["write"].as_i64().unwrap_or(0);
            let reasoning_tokens = tokens["reasoning"].as_i64().unwrap_or(0);

            let total = input_tokens + output_tokens + cache_read + cache_write;
            if total == 0 {
                continue;
            }

            let model = model_id.unwrap_or_else(|| "unknown".to_string());
            let created_ms = created.unwrap_or(0);

            let workdir_candidate = cwd.unwrap_or_else(|| {
                std::env::current_dir()
                    .map(|d| d.to_string_lossy().to_string())
                    .unwrap_or_default()
            });

            let agent_label = agent.unwrap_or_else(|| "build".to_string());
            let session_id = format!("opencode-{}-{}", agent_label, created_ms);

            events.push(json!({
                "providerId": PROVIDER_ID,
                "providerVersion": VERSION,
                "toolCode": TOOL_CODE,
                "sourceKind": "local_db",
                "sourceQuality": "exact",
                "sessionId": session_id,
                "day": crate::date::local_day_from_timestamp_ms(created_ms),
                "hour": crate::date::local_hour_from_timestamp_ms(created_ms),
                "workdirCandidate": workdir_candidate,
                "model": model,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "cacheReadTokens": cache_read,
                "cacheWriteTokens": cache_write,
                "reasoningTokens": reasoning_tokens,
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
        assert_eq!(PROVIDER_ID, "opencode_local");
        assert_eq!(TOOL_CODE, "opencode");
    }

    fn sample_db_path() -> Option<std::path::PathBuf> {
        std::env::current_dir().ok().and_then(|d| {
            let p = d.join("../samples/opencode/opencode.db");
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
        let provider = OpenCodeLocalProvider;
        let events = provider.parse_usage(&db_path.to_string_lossy());

        // 6 messages total: skip 1 zero-token (omsg-3), skip 1 user role (omsg-4) => 4 valid
        assert_eq!(
            events.len(),
            4,
            "should have 4 valid events, got {}",
            events.len()
        );

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
        let provider = OpenCodeLocalProvider;
        let events = provider.parse_usage(&db_path.to_string_lossy());

        // omsg-1: input=11852, output=180, cache_read=1856, cache_write=0, reasoning=60
        // totalTokens = 11852+180+1856+0 = 13888 (reasoning excluded)
        let first = events
            .iter()
            .find(|e| e["inputTokens"] == 11852)
            .expect("should find omsg-1");
        assert_eq!(first["inputTokens"], 11852);
        assert_eq!(first["outputTokens"], 180);
        assert_eq!(first["cacheReadTokens"], 1856);
        assert_eq!(first["cacheWriteTokens"], 0);
        assert_eq!(first["reasoningTokens"], 60);
        assert_eq!(first["totalTokens"], 13888);
        assert_eq!(first["model"], "mimo-v2-pro-free");
    }

    #[test]
    fn test_parse_usage_agent_in_session_id() {
        let db_path = match sample_db_path() {
            Some(p) => p,
            None => return,
        };
        let provider = OpenCodeLocalProvider;
        let events = provider.parse_usage(&db_path.to_string_lossy());

        // omsg-1 has agent="build", omsg-2 has agent="code"
        let build_event = events.iter().find(|e| e["inputTokens"] == 11852).unwrap();
        assert!(
            build_event["sessionId"].as_str().unwrap().contains("build"),
            "session ID should contain agent label"
        );

        let code_event = events.iter().find(|e| e["inputTokens"] == 362).unwrap();
        assert!(
            code_event["sessionId"].as_str().unwrap().contains("code"),
            "session ID should contain agent label"
        );
    }

    #[test]
    fn test_parse_usage_no_agent_defaults_to_build() {
        let db_path = match sample_db_path() {
            Some(p) => p,
            None => return,
        };
        let provider = OpenCodeLocalProvider;
        let events = provider.parse_usage(&db_path.to_string_lossy());

        // omsg-5 has no agent field => defaults to "build"
        let no_agent = events.iter().find(|e| e["model"] == "gpt-4o").unwrap();
        assert!(
            no_agent["sessionId"].as_str().unwrap().contains("build"),
            "missing agent should default to 'build'"
        );
    }

    #[test]
    fn test_parse_usage_skip_zero_tokens() {
        let db_path = match sample_db_path() {
            Some(p) => p,
            None => return,
        };
        let provider = OpenCodeLocalProvider;
        let events = provider.parse_usage(&db_path.to_string_lossy());

        let zero_events: Vec<_> = events
            .iter()
            .filter(|e| e["totalTokens"].as_i64().unwrap_or(0) == 0)
            .collect();
        assert!(zero_events.is_empty(), "should not have zero-total events");
    }

    #[test]
    fn test_parse_usage_multi_model() {
        let db_path = match sample_db_path() {
            Some(p) => p,
            None => return,
        };
        let provider = OpenCodeLocalProvider;
        let events = provider.parse_usage(&db_path.to_string_lossy());

        let models: std::collections::HashSet<_> = events
            .iter()
            .filter_map(|e| e["model"].as_str().map(String::from))
            .collect();
        assert!(models.contains("mimo-v2-pro-free"));
        assert!(models.contains("gpt-4o"));
    }

    #[test]
    fn test_parse_usage_nonexistent_db() {
        let provider = OpenCodeLocalProvider;
        let events = provider.parse_usage("/nonexistent/path/opencode.db");
        assert!(events.is_empty());
    }

    #[test]
    fn test_try_parse_usage_surfaces_database_error() {
        let provider = OpenCodeLocalProvider;
        assert!(provider
            .try_parse_usage("/nonexistent/path/opencode.db")
            .is_err());
    }

    #[test]
    fn test_scan_sessions_manual_root() {
        let samples = std::env::current_dir().ok().and_then(|d| {
            let p = d.join("../samples/opencode");
            if p.exists() {
                Some(p)
            } else {
                None
            }
        });
        let db_dir = match samples {
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
            vec![db_dir.to_string_lossy().to_string()],
        );
        let provider = OpenCodeLocalProvider;
        let sessions = provider.scan_sessions(&cfg);
        assert!(!sessions.is_empty(), "should find at least the sample db");
        assert!(
            sessions.iter().any(|s| s.ends_with("opencode.db")),
            "should include opencode.db"
        );
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
        let provider = OpenCodeLocalProvider;
        let sessions = provider.scan_sessions(&cfg);
        assert!(sessions.is_empty());
    }
}
