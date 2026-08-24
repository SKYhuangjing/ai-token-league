use crate::config::AppConfig;
use crate::provider::common::{source_metadata, walk_files};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const PROVIDER_ID: &str = "kimi_local";
pub const TOOL_CODE: &str = "kimi";
pub const VERSION: &str = "0.1.0";

/// Kimi desktop client (com.moonshot.kimichat, Electron) embeds a local agent
/// runtime (daimon, kimi-code kernel). Agent sessions append wire event logs:
///
/// `<userData>/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/
///    sessions/wd_workspace_<hash>/<sessionId>/agents/<agentId>/wire.jsonl`
///
/// `usage.record` events carry the authoritative per-LLM-call usage in four
/// disjoint fields (inputOther / output / inputCacheRead / inputCacheCreation)
/// plus `model` and epoch-ms `time`. One record == one real LLM call; the
/// kernel emits it from its afterStep hook, so a multi-step turn produces one
/// record per step and a plain sum is the true total (verified against the
/// bundled @moonshot-ai/agent-core UsageRecorder source).
///
/// Privacy: wire.jsonl contains full conversation plaintext. Only
/// `type == "usage.record"` lines are read, and only their model/usage/
/// usageScope/time fields. Everything else is skipped without deserialization
/// beyond the type check. `session_index.jsonl` workDir paths feed the local
/// hash pipeline only.
pub struct KimiLocalProvider;

impl KimiLocalProvider {
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

        // Testing hook (our own, not official): point directly at the
        // `<home>/sessions` root used by the embedded kimi-code kernel.
        if let Ok(dir) = std::env::var("KIMI_DESKTOP_DIR") {
            let dir = dir.trim();
            if !dir.is_empty() && Path::new(dir).exists() {
                roots.push(dir.to_string());
            }
        }

        if let Some(data_dir) = user_data_dir() {
            // Canonical layout up to the kernel home that owns session_index.jsonl.
            let canonical = data_dir
                .join("kimi-desktop")
                .join("daimon-share")
                .join("daimon")
                .join("runtime")
                .join("kimi-code")
                .join("home");
            if canonical.exists() {
                let path = canonical.to_string_lossy().to_string();
                if !roots.contains(&path) {
                    roots.push(path);
                }
            } else {
                // Drift fallback: the internal layout has no compatibility
                // promise. Walk the whole kimi-desktop dir with the same
                // wire.jsonl matcher; non-session wire.jsonl files simply
                // produce zero usage records.
                let loose = data_dir.join("kimi-desktop");
                if loose.exists() {
                    let path = loose.to_string_lossy().to_string();
                    if !roots.contains(&path) {
                        roots.push(path);
                    }
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
            // Manual/loose roots may be wider trees; keep the walk bounded.
            let limit = if is_kernel_home(root) { 5000 } else { 20000 };
            files.extend(walk_files(root, |f| is_kimi_wire_file(f), limit));
        }
        files
    }

    pub fn parse_usage(&self, file: &str) -> Vec<Value> {
        self.try_parse_usage(file).unwrap_or_default()
    }

    pub fn try_parse_usage(&self, file: &str) -> Result<Vec<Value>, String> {
        let rows = crate::provider::common::read_json_lines(file);

        let mtime_ms = file_mtime_ms(file);
        let source = source_metadata(file, PROVIDER_ID, VERSION);
        // Session id: `<sessions>/<wd_workspace_x>/<sessionId>/agents/<agentId>/wire.jsonl`
        let (session_id, workdir_candidate) = resolve_session_and_workdir(file);

        let mut events = Vec::new();
        for row in &rows {
            if row.get("type").and_then(|t| t.as_str()) != Some("usage.record") {
                continue;
            }

            let usage = match row.get("usage").filter(|u| u.is_object()) {
                Some(u) => u,
                None => continue,
            };
            let input_tokens = usage_field_i64(
                usage,
                &["inputOther", "input", "input_tokens", "inputTokens"],
            );
            let output_tokens =
                usage_field_i64(usage, &["output", "output_tokens", "outputTokens"]);
            let cache_read = usage_field_i64(
                usage,
                &["inputCacheRead", "cache_read_tokens", "cached_tokens"],
            );
            let cache_write =
                usage_field_i64(usage, &["inputCacheCreation", "cache_write_tokens"]);

            // Kimi fields are disjoint (no OpenAI inclusion), direct mapping.
            let total = input_tokens + output_tokens + cache_read + cache_write;
            if total == 0 {
                continue;
            }

            let model = row
                .get("model")
                .and_then(|m| m.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or("unknown")
                .to_string();

            let time_ms = row
                .get("time")
                .and_then(|t| t.as_i64())
                .filter(|t| *t > 1_000_000_000_000)
                .unwrap_or(mtime_ms);
            let day = crate::date::local_day_from_timestamp_ms(time_ms);
            let hour = crate::date::local_hour_from_timestamp_ms(time_ms);

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
                "cacheReadTokens": cache_read,
                "cacheWriteTokens": cache_write,
                "reasoningTokens": 0,
                "totalTokens": total,
                "rawSourceRef": source.raw_source_ref,
                "sourceFingerprint": source.source_fingerprint,
                "parserVersion": source.parser_version,
            }));
        }

        Ok(events)
    }
}

/// Electron userData base for the kimi-desktop app (macOS
/// `~/Library/Application Support`, Windows `%APPDATA%`, Linux `~/.config`).
fn user_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(PathBuf::from)
}

/// True when the root is the kernel `home` dir (has `sessions/` + `session_index.jsonl`).
fn is_kernel_home(root: &str) -> bool {
    let p = Path::new(root);
    p.join("sessions").is_dir() && p.join("session_index.jsonl").is_file()
}

/// Matcher: any `wire.jsonl` under a `sessions` directory segment. Covers
/// multiple workspaces (`wd_workspace_*`), user conversations (`conv-*`),
/// background title sessions (`ctitle-*`), and subagent files
/// (`agents/<id>/wire.jsonl`); excludes session_index.jsonl, config.toml, logs.
fn is_kimi_wire_file(path: &str) -> bool {
    let p = Path::new(path);
    if p.file_name().and_then(|n| n.to_str()) != Some("wire.jsonl") {
        return false;
    }
    p.ancestors()
        .skip(1)
        .any(|a| a.file_name().map(|n| n == "sessions").unwrap_or(false))
}

/// sessionId from path (`conv-*`/`ctitle-*` dir; `<sessionId>/<agentId>` when
/// the agent dir is not `main`), plus workdir from `session_index.jsonl`
/// (append-only: later rows win) when the index is findable. Missing index or
/// entry → empty workdir; the finalize pipeline degrades it. No current_dir()
/// noise fallback.
fn resolve_session_and_workdir(file: &str) -> (String, String) {
    let path = Path::new(file);
    // .../sessions/<workspace>/<sessionId>/agents/<agentId>/wire.jsonl
    let agent_dir = path.parent(); // .../agents/<agentId>
    let agents_dir = agent_dir.and_then(|a| a.parent()); // .../agents
    let session_dir = agents_dir.and_then(|a| a.parent()); // .../<sessionId>
    let (raw_session, agent_id) = match session_dir {
        Some(sd) => {
            let session = sd
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let agent = agent_dir
                .and_then(|a| a.file_name())
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            (session, agent)
        }
        None => (String::new(), String::new()),
    };

    let session_id = if raw_session.is_empty() {
        "kimi-unknown".to_string()
    } else if agent_id.is_empty() || agent_id == "main" {
        raw_session.clone()
    } else {
        format!("{}/{}", raw_session, agent_id)
    };

    let mut workdir = String::new();
    if let Some(kernel_home) = kernel_home_for(file) {
        let index_path = kernel_home.join("session_index.jsonl");
        if let Ok(content) = fs::read_to_string(&index_path) {
            // Append-only index: last row for a sessionId wins.
            for line in content.lines().filter(|l| !l.trim().is_empty()) {
                if let Ok(entry) = serde_json::from_str::<Value>(line) {
                    if entry.get("sessionId").and_then(|v| v.as_str()) == Some(raw_session.as_str())
                    {
                        if let Some(dir) = entry.get("workDir").and_then(|v| v.as_str()) {
                            workdir = dir.to_string();
                        }
                    }
                }
            }
        }
    }

    (session_id, workdir)
}

/// Walk up from a wire.jsonl file to the enclosing kernel home (the dir whose
/// child chain contains a `sessions` segment directly below it).
fn kernel_home_for(file: &str) -> Option<PathBuf> {
    let mut current = Path::new(file).parent()?.to_path_buf();
    while let Some(name) = current.file_name() {
        if name == "sessions" {
            return current.parent().map(|p| p.to_path_buf());
        }
        current = current.parent()?.to_path_buf();
    }
    None
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_dir() -> Option<std::path::PathBuf> {
        std::env::current_dir().ok().and_then(|d| {
            let p = d.join("../samples/kimi/home");
            if p.exists() {
                Some(p)
            } else {
                None
            }
        })
    }

    #[test]
    fn test_provider_constants() {
        assert_eq!(PROVIDER_ID, "kimi_local");
        assert_eq!(TOOL_CODE, "kimi");
    }

    #[test]
    fn test_is_kimi_wire_file() {
        assert!(is_kimi_wire_file(
            "/h/sessions/wd_x/conv-1/agents/main/wire.jsonl"
        ));
        assert!(is_kimi_wire_file(
            "/h/sessions/wd_x/conv-1/agents/sub1/wire.jsonl"
        ));
        assert!(!is_kimi_wire_file("/h/session_index.jsonl"));
        assert!(!is_kimi_wire_file("/h/sessions/wd_x/conv-1/agents/main/state.json"));
        assert!(!is_kimi_wire_file("/h/logs/wire.jsonl"));
    }

    #[test]
    fn test_parse_usage_sample_events_and_totals() {
        let samples = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = KimiLocalProvider;
        let file = samples
            .join("sessions/wd_workspace_demo/conv-aaa111/agents/main/wire.jsonl");
        if !file.exists() {
            return;
        }
        let events = provider.parse_usage(&file.to_string_lossy());

        // 2 real usage records; zero-token record and all non-usage events skipped.
        assert_eq!(events.len(), 2, "conv-aaa111 should yield 2 events");
        assert_eq!(events[0]["inputTokens"], 6157);
        assert_eq!(events[0]["outputTokens"], 50);
        assert_eq!(events[0]["cacheReadTokens"], 19200);
        assert_eq!(events[0]["cacheWriteTokens"], 0);
        assert_eq!(events[0]["totalTokens"], 25407);
        assert_eq!(events[1]["totalTokens"], 26024);
        assert_eq!(events[0]["model"], "k2d6-agent");
        assert_eq!(events[0]["sessionId"], "conv-aaa111");

        for event in &events {
            assert_eq!(event["providerId"], PROVIDER_ID);
            assert_eq!(event["toolCode"], TOOL_CODE);
            assert_eq!(event["sourceKind"], "local_log");
            assert_eq!(event["sourceQuality"], "exact");
            assert!(!event["day"].as_str().unwrap_or("").is_empty());
        }
    }

    #[test]
    fn test_parse_usage_math_invariant() {
        let samples = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = KimiLocalProvider;
        for entry in fs::read_dir(samples.join("sessions/wd_workspace_demo")).unwrap() {
            let path = entry.unwrap().path();
            let wire = path.join("agents").join("main").join("wire.jsonl");
            let wire = match wire.exists() {
                true => wire,
                false => path.join("agents").join("sub1").join("wire.jsonl"),
            };
            if !wire.exists() {
                continue;
            }
            for event in provider.parse_usage(&wire.to_string_lossy()) {
                let sum = event["inputTokens"].as_i64().unwrap_or(0)
                    + event["outputTokens"].as_i64().unwrap_or(0)
                    + event["cacheReadTokens"].as_i64().unwrap_or(0)
                    + event["cacheWriteTokens"].as_i64().unwrap_or(0);
                assert_eq!(
                    event["totalTokens"].as_i64().unwrap_or(-1),
                    sum,
                    "total must equal the four disjoint parts"
                );
            }
        }
    }

    #[test]
    fn test_parse_usage_session_scope_collected() {
        let samples = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = KimiLocalProvider;
        let file = samples
            .join("sessions/wd_workspace_demo/conv-eee555/agents/main/wire.jsonl");
        if !file.exists() {
            return;
        }
        // session-scope (replay semantics) record is still collected; the torn
        // trailing line is dropped by read_json_lines without failing the file.
        let events = provider.parse_usage(&file.to_string_lossy());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["totalTokens"], 350);
    }

    #[test]
    fn test_parse_usage_missing_time_falls_back_to_mtime() {
        let samples = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = KimiLocalProvider;
        let file = samples
            .join("sessions/wd_workspace_demo/conv-bbb222/agents/main/wire.jsonl");
        if !file.exists() {
            return;
        }
        let events = provider.parse_usage(&file.to_string_lossy());
        assert_eq!(events.len(), 2);
        // First record has explicit time (2026-06-09 UTC noon); the second
        // lacks it and inherits the file mtime → same day bucket in practice.
        assert_eq!(events[0]["inputTokens"], 1000);
        assert_eq!(events[0]["cacheWriteTokens"], 100);
        assert_eq!(events[1]["totalTokens"], 120);
    }

    #[test]
    fn test_parse_usage_subagent_session_suffix() {
        let samples = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = KimiLocalProvider;
        let file = samples
            .join("sessions/wd_workspace_demo/conv-ddd444/agents/sub1/wire.jsonl");
        if !file.exists() {
            return;
        }
        let events = provider.parse_usage(&file.to_string_lossy());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["sessionId"], "conv-ddd444/sub1");
    }

    #[test]
    fn test_workdir_resolution_last_index_row_wins() {
        let samples = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = KimiLocalProvider;
        let file = samples
            .join("sessions/wd_workspace_demo/conv-aaa111/agents/main/wire.jsonl");
        if !file.exists() {
            return;
        }
        let events = provider.parse_usage(&file.to_string_lossy());
        // Index has two rows for conv-aaa111; the later one wins.
        assert_eq!(
            events[0]["workdirCandidate"],
            "/tmp/kimi-sample/project-one-renamed"
        );

        // Orphan session (ddd444 not in index): empty workdir, no noise fallback.
        let orphan = samples
            .join("sessions/wd_workspace_demo/conv-ddd444/agents/sub1/wire.jsonl");
        if orphan.exists() {
            let orphan_events = provider.parse_usage(&orphan.to_string_lossy());
            assert_eq!(orphan_events[0]["workdirCandidate"], "");
        }
    }

    #[test]
    fn test_parse_usage_ctitle_collected() {
        let samples = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let provider = KimiLocalProvider;
        let file = samples
            .join("sessions/wd_workspace_demo/ctitle-ccc333/agents/main/wire.jsonl");
        if !file.exists() {
            return;
        }
        let events = provider.parse_usage(&file.to_string_lossy());
        assert_eq!(events.len(), 1, "background title usage is real usage");
        assert_eq!(events[0]["model"], "k3-agent");
        assert_eq!(events[0]["sessionId"], "ctitle-ccc333");
        assert_eq!(
            events[0]["workdirCandidate"],
            "/tmp/kimi-sample/project-one"
        );
    }

    #[test]
    fn test_parse_usage_nonexistent_file() {
        let provider = KimiLocalProvider;
        assert!(provider
            .parse_usage("/nonexistent/path/wire.jsonl")
            .is_empty());
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
        let provider = KimiLocalProvider;
        let sessions = provider.scan_sessions(&cfg);
        // Manual root is a kernel home → 5 wire files; assert containment to
        // tolerate a real kimi-desktop install on the dev machine.
        assert!(sessions
            .iter()
            .any(|s| s.contains("conv-aaa111")), "sample wire.jsonl must be found");
        assert!(sessions
            .iter()
            .any(|s| s.contains("conv-ddd444/agents/sub1")), "subagent wire must be found");
        assert!(!sessions.iter().any(|s| s.contains("session_index.jsonl")));
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
        let provider = KimiLocalProvider;
        assert!(provider.scan_sessions(&cfg).is_empty());
    }

    #[test]
    fn test_scan_sessions_env_override() {
        let samples = match sample_dir() {
            Some(p) => p,
            None => return,
        };
        let cfg: AppConfig = serde_json::from_value(serde_json::json!({
            "participantId": "test",
            "nickname": "test",
            "identityPublicKey": "",
            "identityPrivateKey": "",
            "deviceId": "test"
        }))
        .unwrap();
        std::env::set_var("KIMI_DESKTOP_DIR", samples.to_string_lossy().to_string());
        let provider = KimiLocalProvider;
        let sessions = provider.scan_sessions(&cfg);
        std::env::remove_var("KIMI_DESKTOP_DIR");
        assert!(sessions.iter().any(|s| s.contains("conv-bbb222")));
    }
}
