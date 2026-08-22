use crate::config::AppConfig;
use crate::provider::common::{source_metadata, walk_files};
use ruzstd::decoding::StreamingDecoder;
use ruzstd::io::Read;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

pub const PROVIDER_ID: &str = "dsh_local";
pub const TOOL_CODE: &str = "dsh";
pub const VERSION: &str = "0.1.0";

/// dsh session format version this parser accepts. dsh is pre-release and
/// explicitly does not promise compatibility across versions, so any other
/// value must surface as a provider error instead of a guessed parse.
const SUPPORTED_SESSION_FORMAT_VERSION: i64 = 0;

const ZSTD_MAGIC: u32 = 0xFD2FB528;

/// DeepSeek Harness (`dsh`) persists each session under
/// `<root>/<project-dir>--/<session-id>/session.jsonl.zstd` (or plain
/// `session.jsonl` when persistence compression is turned off). The zstd
/// file is a concatenation of independent frames: the first frame holds the
/// session header line, each later frame one persisted event batch, and a
/// crash may leave a torn partial frame at the tail. Token accounting lives
/// on `assistant/message` (`data.usage` + `data.message.source`) and
/// `compaction/summary` (`data.usage` + `data.model`) events. Message
/// `content` blocks and packed chunk text are never read (privacy red line);
/// the header `cwd` only feeds the local workdir-hash pipeline.
pub struct DshLocalProvider;

impl DshLocalProvider {
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

        if let Ok(dir) = std::env::var("DSH_HOME") {
            let dir = dir.trim();
            if !dir.is_empty() {
                let path = std::path::PathBuf::from(dir).join("sessions");
                if path.exists() {
                    roots.push(path.to_string_lossy().to_string());
                }
            }
        }

        if let Some(home) = dirs::home_dir() {
            let root = home.join(".dsh").join("sessions");
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
            let found = walk_files(root, |f| is_dsh_session_file(f), 5000);
            files.extend(found);
        }
        files
    }

    pub fn parse_usage(&self, file: &str) -> Vec<Value> {
        self.try_parse_usage(file).unwrap_or_default()
    }

    pub fn try_parse_usage(&self, file: &str) -> Result<Vec<Value>, String> {
        let bytes = fs::read(file).map_err(|e| format!("read failed: {}", e))?;
        let text = if file.ends_with(".zstd") {
            decompress_zstd_frames(&bytes)?
        } else {
            String::from_utf8(bytes).map_err(|e| format!("invalid utf-8: {}", e))?
        };

        let mut lines = text.lines().filter(|line| !line.trim().is_empty());
        let header_line = lines
            .next()
            .ok_or_else(|| "empty session file".to_string())?;
        let header: Value =
            serde_json::from_str(header_line).map_err(|e| format!("invalid header json: {}", e))?;
        if !header.is_object()
            || header.get("type").and_then(|t| t.as_str()) != Some("session")
        {
            return Err("missing session header".to_string());
        }

        // Version gate: dsh marks the format pre-release; never guess a parse.
        let format_version = header
            .get("version")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| "missing dsh session format version".to_string())?;
        if format_version != SUPPORTED_SESSION_FORMAT_VERSION {
            return Err(format!(
                "unsupported dsh session format version: {}",
                format_version
            ));
        }

        let created_at_ms = header
            .get("createdAt")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let session_id = header
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("dsh-{}", created_at_ms));
        let header_cwd = header
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_default();
        let workdir_candidate = if header_cwd.is_empty() {
            Path::new(file)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            header_cwd
        };

        let source = source_metadata(file, PROVIDER_ID, VERSION);

        // Parse all event lines first: the fork seed boundary is the LAST
        // `session/end-seed` in the file, which can appear after candidate
        // events in file order. Single bad event lines are skipped (dsh
        // "ignorable" semantics); packed chunk rows are simply not one of
        // the counted types.
        let mut parsed: Vec<Value> = Vec::new();
        for line in lines {
            match serde_json::from_str::<Value>(line) {
                Ok(event) if event.is_object() => parsed.push(event),
                _ => continue,
            }
        }

        let seed_seq = parsed
            .iter()
            .filter(|e| e.get("type").and_then(|t| t.as_str()) == Some("session/end-seed"))
            .filter_map(|e| e.get("seq").and_then(|v| v.as_i64()))
            .max()
            .unwrap_or(i64::MIN);

        let mut events = Vec::new();
        for event in &parsed {
            let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let (usage, model) = match event_type {
                "assistant/message" => {
                    let data = event.get("data").filter(|d| d.is_object());
                    let usage = data
                        .and_then(|d| d.get("usage"))
                        .filter(|u| u.is_object());
                    let model = data
                        .and_then(|d| d.get("message"))
                        .and_then(|m| m.get("source"))
                        .and_then(|s| s.get("model"))
                        .and_then(|m| m.as_str());
                    (usage, model)
                }
                "compaction/summary" => {
                    let data = event.get("data").filter(|d| d.is_object());
                    let usage = data
                        .and_then(|d| d.get("usage"))
                        .filter(|u| u.is_object());
                    let model = data.and_then(|d| d.get("model")).and_then(|m| m.as_str());
                    (usage, model)
                }
                _ => continue,
            };
            let Some(usage) = usage else {
                continue;
            };

            // Fork/resume children copy parent history before the seed
            // boundary; those events were already counted in the parent file.
            let seq = event
                .get("seq")
                .and_then(|v| v.as_i64())
                .unwrap_or(i64::MAX);
            if seq <= seed_seq {
                continue;
            }

            // Anthropic semantics: inputTokens excludes cache hits, so the
            // fields map directly with no split.
            let input = usage_i64(usage, "inputTokens");
            let output = usage_i64(usage, "outputTokens");
            let cache_read = usage_i64(usage, "cacheReadTokens");
            let cache_write = usage_i64(usage, "cacheWriteTokens");
            let reasoning = usage_i64(usage, "reasoningTokens");
            let total = input + output + cache_read + cache_write;
            if total == 0 {
                continue;
            }

            let model = model.unwrap_or("").trim();
            let model = if model.is_empty() {
                "unknown".to_string()
            } else {
                model.to_string()
            };

            let time_ms = event
                .get("time")
                .and_then(|v| v.as_i64())
                .unwrap_or(created_at_ms);
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

/// Session data files are exactly `session.jsonl.zstd` (default) or
/// `session.jsonl` (persistenceCompression "none").
fn is_dsh_session_file(path: &str) -> bool {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == "session.jsonl.zstd" || n == "session.jsonl")
        .unwrap_or(false)
}

fn usage_i64(usage: &Value, key: &str) -> i64 {
    usage
        .get(key)
        .and_then(|v| v.as_f64())
        .map(|n| n.round() as i64)
        .unwrap_or(0)
        .max(0)
}

/// Ported from dsh `session-persistence-jsonl/src/zstd.ts::scanZstdFrames`:
/// pure byte-level structure scan (magic → frame header → 3-byte block
/// headers → optional checksum) yielding exact `[start, end)` ranges of the
/// complete frames. A torn trailing frame (crash leftover) is reported and
/// skipped; corrupt magic or reserved bits surface as errors.
fn scan_zstd_frames(buffer: &[u8]) -> Result<(Vec<(usize, usize)>, bool), String> {
    let mut frames: Vec<(usize, usize)> = Vec::new();
    let mut torn = false;
    let mut offset = 0usize;

    'frames: while offset < buffer.len() {
        let start = offset;
        if buffer.len() - offset < 4 {
            torn = true;
            break;
        }
        let magic = u32::from_le_bytes([
            buffer[offset],
            buffer[offset + 1],
            buffer[offset + 2],
            buffer[offset + 3],
        ]);
        if magic != ZSTD_MAGIC {
            return Err(format!("invalid frame magic at {}", offset));
        }
        offset += 4;
        if offset == buffer.len() {
            torn = true;
            break;
        }
        let descriptor = buffer[offset];
        offset += 1;
        if (descriptor & 0x18) != 0 {
            return Err("reserved frame-header bit".to_string());
        }
        let content_size_flag = (descriptor >> 6) as usize;
        let single_segment = (descriptor & 0x20) != 0;
        let checksum = (descriptor & 0x04) != 0;
        let dictionary_flag = (descriptor & 0x03) as usize;
        let dictionary_bytes = if dictionary_flag == 3 {
            4
        } else {
            dictionary_flag
        };
        let content_size_bytes = if content_size_flag == 0 {
            usize::from(single_segment)
        } else {
            1usize << content_size_flag
        };
        let remaining_header_bytes = (if single_segment { 0 } else { 1 }) + dictionary_bytes + content_size_bytes;
        if buffer.len() - offset < remaining_header_bytes {
            torn = true;
            break;
        }
        offset += remaining_header_bytes;
        loop {
            if buffer.len() - offset < 3 {
                torn = true;
                break 'frames;
            }
            let block_header = (buffer[offset] as u32)
                | ((buffer[offset + 1] as u32) << 8)
                | ((buffer[offset + 2] as u32) << 16);
            offset += 3;
            let last_block = (block_header & 1) != 0;
            let block_type = (block_header >> 1) & 0x03;
            let block_size = (block_header >> 3) as usize;
            if block_type == 0x03 {
                return Err("reserved block type".to_string());
            }
            let payload_bytes = if block_type == 0x01 { 1 } else { block_size };
            if buffer.len() - offset < payload_bytes {
                torn = true;
                break 'frames;
            }
            offset += payload_bytes;
            if last_block {
                break;
            }
        }
        if checksum {
            if buffer.len() - offset < 4 {
                torn = true;
                break;
            }
            offset += 4;
        }
        frames.push((start, offset));
    }

    Ok((frames, torn))
}

/// Decompress every complete frame independently (streaming zstd decoders do
/// not reliably cross concatenated frames) and concatenate the payloads. The
/// torn tail, if any, is discarded.
fn decompress_zstd_frames(buffer: &[u8]) -> Result<String, String> {
    let (frames, _torn) = scan_zstd_frames(buffer)?;
    let mut out = Vec::new();
    for (start, end) in frames {
        let mut decoder = StreamingDecoder::new(&buffer[start..end])
            .map_err(|e| format!("zstd frame init failed: {}", e))?;
        decoder
            .read_to_end(&mut out)
            .map_err(|e| format!("zstd frame decode failed: {}", e))?;
    }
    String::from_utf8(out).map_err(|e| format!("invalid utf-8: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_dir() -> Option<std::path::PathBuf> {
        std::env::current_dir().ok().and_then(|d| {
            let p = d.join("../samples/dsh");
            if p.exists() {
                Some(p)
            } else {
                None
            }
        })
    }

    fn sample_file(kind: &str, name: &str) -> Option<String> {
        sample_dir().map(|d| d.join(kind).join(name).to_string_lossy().to_string())
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

    const EXPECTED_COUNT: usize = 7;
    const EXPECTED_TOTAL: i64 = 10310;

    #[test]
    fn test_provider_constants() {
        assert_eq!(PROVIDER_ID, "dsh_local");
        assert_eq!(TOOL_CODE, "dsh");
        assert_eq!(VERSION, "0.1.0");
        assert_eq!(SUPPORTED_SESSION_FORMAT_VERSION, 0);
    }

    #[test]
    fn test_is_dsh_session_file() {
        assert!(is_dsh_session_file(
            "/root/--Users-demo-project--/session-abc/session.jsonl.zstd"
        ));
        assert!(is_dsh_session_file(
            "/root/--Users-demo-project--/session-abc/session.jsonl"
        ));
        assert!(!is_dsh_session_file(
            "/root/--Users-demo-project--/session-abc/session-other.jsonl"
        ));
        assert!(!is_dsh_session_file(
            "/root/--Users-demo-project--/session-abc/session.jsonl.zstd.bak"
        ));
        assert!(!is_dsh_session_file("/root/readme.md"));
    }

    #[test]
    fn test_parse_usage_raw_sample_counts_and_total() {
        let Some(file) = sample_file("raw", "session.jsonl") else {
            return; // samples missing → skip silently
        };
        let events = DshLocalProvider.parse_usage(&file);
        assert_eq!(events.len(), EXPECTED_COUNT);
        let total: i64 = events.iter().map(|e| e["totalTokens"].as_i64().unwrap_or(0)).sum();
        assert_eq!(total, EXPECTED_TOTAL);
    }

    #[test]
    fn test_parse_usage_zstd_sample_matches_raw() {
        let (Some(raw), Some(zstd)) = (
            sample_file("raw", "session.jsonl"),
            sample_file("zstd", "session.jsonl.zstd"),
        ) else {
            return;
        };
        let raw_events = DshLocalProvider.parse_usage(&raw);
        let zstd_events = DshLocalProvider.parse_usage(&zstd);
        assert_eq!(zstd_events.len(), EXPECTED_COUNT);
        assert_eq!(raw_events.len(), zstd_events.len());
        for (raw_event, zstd_event) in raw_events.iter().zip(zstd_events.iter()) {
            assert_eq!(raw_event["model"], zstd_event["model"]);
            assert_eq!(raw_event["inputTokens"], zstd_event["inputTokens"]);
            assert_eq!(raw_event["outputTokens"], zstd_event["outputTokens"]);
            assert_eq!(raw_event["cacheReadTokens"], zstd_event["cacheReadTokens"]);
            assert_eq!(raw_event["cacheWriteTokens"], zstd_event["cacheWriteTokens"]);
            assert_eq!(raw_event["totalTokens"], zstd_event["totalTokens"]);
        }
    }

    #[test]
    fn test_parse_usage_direct_token_mapping_math() {
        let Some(file) = sample_file("raw", "session.jsonl") else {
            return;
        };
        let events = DshLocalProvider.parse_usage(&file);

        // seq2: 500+100+300+50 → cache fields map straight through
        // (Anthropic semantics, no split).
        let seq2 = events
            .iter()
            .find(|e| e["inputTokens"] == 500 && e["cacheReadTokens"] == 300)
            .expect("cache-nonzero assistant row");
        assert_eq!(seq2["outputTokens"], 100);
        assert_eq!(seq2["cacheWriteTokens"], 50);
        assert_eq!(seq2["totalTokens"], 950);

        // Invariant: total == input + output + cacheRead + cacheWrite.
        for event in &events {
            assert_eq!(
                event["totalTokens"].as_i64().unwrap(),
                event["inputTokens"].as_i64().unwrap()
                    + event["outputTokens"].as_i64().unwrap()
                    + event["cacheReadTokens"].as_i64().unwrap()
                    + event["cacheWriteTokens"].as_i64().unwrap()
            );
        }

        let first = &events[0];
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
            assert!(first.get(key).is_some(), "event must contain {}", key);
        }
        assert_eq!(first["providerId"], PROVIDER_ID);
        assert_eq!(first["toolCode"], TOOL_CODE);
        assert_eq!(first["sourceKind"], "local_log");
        assert_eq!(first["sourceQuality"], "exact");
    }

    #[test]
    fn test_parse_usage_end_seed_dedup() {
        let Some(file) = sample_file("raw", "session.jsonl") else {
            return;
        };
        let events = DshLocalProvider.parse_usage(&file);

        // seq10 (5000+500 = 5500) sits inside the copied parent history and
        // must not be counted; only seq12/seq13 after the boundary remain.
        assert!(
            !events.iter().any(|e| e["totalTokens"] == 5500),
            "pre-seed assistant event must be dropped"
        );
        assert!(events.iter().any(|e| e["totalTokens"] == 2040));
        assert!(events.iter().any(|e| e["totalTokens"] == 1080));
    }

    #[test]
    fn test_parse_usage_compaction_summary_counted() {
        let Some(file) = sample_file("raw", "session.jsonl") else {
            return;
        };
        let events = DshLocalProvider.parse_usage(&file);
        let compaction = events
            .iter()
            .find(|e| e["model"] == "sample-model-c")
            .expect("compaction/summary must be counted");
        assert_eq!(compaction["inputTokens"], 2000);
        assert_eq!(compaction["outputTokens"], 300);
        assert_eq!(compaction["cacheReadTokens"], 1000);
        assert_eq!(compaction["totalTokens"], 3300);
    }

    #[test]
    fn test_parse_usage_zero_usage_row_skipped() {
        let Some(file) = sample_file("raw", "session.jsonl") else {
            return;
        };
        let events = DshLocalProvider.parse_usage(&file);
        assert!(
            events.iter().all(|e| e["totalTokens"].as_i64().unwrap_or(0) > 0),
            "all-zero usage row must not emit an event"
        );
    }

    #[test]
    fn test_parse_usage_interrupted_row_counted() {
        let Some(file) = sample_file("raw", "session.jsonl") else {
            return;
        };
        let events = DshLocalProvider.parse_usage(&file);
        assert!(
            events.iter().any(|e| e["totalTokens"] == 790),
            "interrupted assistant message with usage must be counted"
        );
    }

    #[test]
    fn test_parse_usage_packed_chunk_rows_ignored() {
        let Some(file) = sample_file("raw", "session.jsonl") else {
            return;
        };
        let events = DshLocalProvider.parse_usage(&file);
        // 8 assistant/message rows exist but only 7 counted rows survive the
        // seed filter; packed text-chunks / reasoning-chunks / user rows must
        // never appear (they would inflate the count past EXPECTED_COUNT).
        assert_eq!(events.len(), EXPECTED_COUNT);
        assert!(
            events
                .iter()
                .all(|e| e["model"].as_str().unwrap_or("").starts_with("sample-model-")),
            "chunk rows carry no model and must not emit events"
        );
    }

    #[test]
    fn test_parse_usage_day_hour_and_workdir() {
        let Some(file) = sample_file("raw", "session.jsonl") else {
            return;
        };
        let events = DshLocalProvider.parse_usage(&file);
        let event = events.first().unwrap();

        // UTC noon sample: exact day, valid hour, header cwd as candidate.
        assert_eq!(event["day"], "2026-06-10");
        assert!(event["hour"].as_u64().unwrap_or(99) < 24);
        assert_eq!(event["workdirCandidate"], "/tmp/dsh-sample/project-one");
        assert_eq!(
            event["sessionId"],
            "session-11111111-2222-3333-4444-555555555555"
        );
    }

    #[test]
    fn test_parse_usage_unsupported_version_is_error() {
        let Some(file) = sample_file("bad", "version-1.jsonl") else {
            return;
        };
        let error = DshLocalProvider
            .try_parse_usage(&file)
            .expect_err("version 1 header must be rejected");
        assert!(
            error.contains("unsupported dsh session format version: 1"),
            "unexpected error: {}",
            error
        );
    }

    #[test]
    fn test_parse_usage_missing_or_invalid_header_is_error() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();

        let no_header = std::env::temp_dir().join(format!("atl-dsh-noheader-{}.jsonl", suffix));
        fs::write(&no_header, "{\"type\":\"assistant/message\",\"seq\":1,\"time\":1781092800000,\"data\":{\"usage\":{\"inputTokens\":1,\"outputTokens\":1}}}").unwrap();
        let error = DshLocalProvider
            .try_parse_usage(&no_header.to_string_lossy())
            .expect_err("non-session first line must be rejected");
        assert!(error.contains("missing session header"), "got: {}", error);
        let _ = fs::remove_file(&no_header);

        let bad_json = std::env::temp_dir().join(format!("atl-dsh-badjson-{}.jsonl", suffix));
        fs::write(&bad_json, "not-json{{{").unwrap();
        assert!(DshLocalProvider.try_parse_usage(&bad_json.to_string_lossy()).is_err());
        let _ = fs::remove_file(&bad_json);

        let empty = std::env::temp_dir().join(format!("atl-dsh-empty-{}.jsonl", suffix));
        fs::write(&empty, "").unwrap();
        assert!(DshLocalProvider.try_parse_usage(&empty.to_string_lossy()).is_err());
        let _ = fs::remove_file(&empty);
    }

    #[test]
    fn test_parse_usage_bad_magic_is_error() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("atl-dsh-badmagic-{}.zstd", suffix));
        fs::write(&path, b"this is definitely not a zstd stream").unwrap();
        let error = DshLocalProvider
            .try_parse_usage(&path.to_string_lossy())
            .expect_err("garbage zstd bytes must be rejected");
        assert!(error.contains("invalid frame magic"), "got: {}", error);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn test_parse_usage_torn_tail_frame_skipped() {
        let Some(file) = sample_file("zstd", "session.jsonl.zstd") else {
            return;
        };
        let bytes = fs::read(&file).unwrap();
        let (frames, torn) = scan_zstd_frames(&bytes).unwrap();
        assert!(!torn, "committed sample must be fully framed");
        assert!(frames.len() >= 4);

        // Truncate mid-way through the last frame: all complete frames must
        // still parse and the torn tail must be discarded without an error.
        let (last_start, _) = frames[frames.len() - 1];
        let cut = last_start + (bytes.len() - last_start) / 2;
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let torn_path = std::env::temp_dir().join(format!("atl-dsh-torn-{}.zstd", suffix));
        fs::write(&torn_path, &bytes[..cut]).unwrap();

        let result = DshLocalProvider.try_parse_usage(&torn_path.to_string_lossy());
        let _ = fs::remove_file(&torn_path);
        let events = result.expect("torn tail must be skipped, not an error");
        // One event line is lost with the torn frame; the header + earlier
        // events still parse.
        assert_eq!(events.len(), EXPECTED_COUNT - 1);
        let total: i64 = events.iter().map(|e| e["totalTokens"].as_i64().unwrap_or(0)).sum();
        assert_eq!(total, EXPECTED_TOTAL - 1080);
    }

    #[test]
    fn test_parse_usage_nonexistent_file() {
        let events = DshLocalProvider.parse_usage("/nonexistent/path/session.jsonl.zstd");
        assert!(events.is_empty());
    }

    #[test]
    fn test_scan_sessions_manual_root() {
        let Some(samples) = sample_dir() else {
            return;
        };
        let mut cfg = base_config();
        cfg.provider_roots.insert(
            PROVIDER_ID.into(),
            vec![samples.join("zstd").to_string_lossy().to_string()],
        );
        let provider = DshLocalProvider;
        let sessions = provider.scan_sessions(&cfg);
        // A real ~/.dsh/sessions may exist on the dev machine and show up as
        // an auto root; the manual sample root must always be included.
        assert!(sessions
            .iter()
            .any(|s| s.contains("samples/dsh") && s.ends_with("session.jsonl.zstd")));
        assert!(sessions
            .iter()
            .all(|s| s.ends_with("session.jsonl") || s.ends_with("session.jsonl.zstd")));
    }

    #[test]
    fn test_scan_sessions_disabled() {
        let mut cfg = base_config();
        cfg.provider_enabled.insert(PROVIDER_ID.into(), false);
        let provider = DshLocalProvider;
        let sessions = provider.scan_sessions(&cfg);
        assert!(sessions.is_empty());
    }

    #[test]
    fn test_auto_roots_env_override() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("atl-dsh-env-{}", suffix));
        let session = root
            .join("sessions")
            .join("--tmp-dsh-sample-project-one--")
            .join("session-11111111-2222-3333-4444-555555555555");
        fs::create_dir_all(&session).unwrap();
        fs::copy(sample_dir().unwrap().join("zstd/session.jsonl.zstd"), session.join("session.jsonl.zstd"))
            .unwrap();

        std::env::set_var("DSH_HOME", &root);
        let cfg = base_config();
        let sessions = DshLocalProvider.scan_sessions(&cfg);
        std::env::remove_var("DSH_HOME");
        let _ = fs::remove_dir_all(&root);

        assert!(
            sessions
                .iter()
                .any(|s| s.contains("atl-dsh-env") && s.ends_with("session.jsonl.zstd")),
            "DSH_HOME/sessions override should be scanned, got {:?}",
            sessions
        );
    }
}
