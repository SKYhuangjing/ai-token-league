use crate::config::AppConfig;
use crate::provider::common::{source_metadata, walk_files};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

pub const PROVIDER_ID: &str = "antigravity_local";
pub const TOOL_CODE: &str = "antigravity";
pub const VERSION: &str = "0.2.0";

const DEFAULT_SCAN_FILE_LIMIT: usize = 5000;

/// Antigravity stores one SQLite database per conversation under
/// `~/.gemini/antigravity*/conversations/` and `~/.config/antigravity/conversations/`.
/// Token usage lives in protobuf blobs in `gen_metadata` and `steps`.
///
/// The blob field mapping, identity-key dedup, timestamp fallback chain, and
/// model alias tables are ported from ccusage (MIT, ryoppippi/ccusage,
/// rust/adapters/antigravity) and validated against `ccusage antigravity`
/// on real local data.
pub struct AntigravityLocalProvider;

// ── Protobuf wire-format decoding (no schema; field numbers are stable) ──

#[derive(Debug, Clone, Copy)]
enum ProtoValue<'a> {
    Varint(u64),
    Fixed64,
    Bytes(&'a [u8]),
    Fixed32,
}

#[derive(Debug, Clone, Copy)]
struct ProtoField<'a> {
    number: u32,
    value: ProtoValue<'a>,
}

type ProtoResult<T> = Result<T, &'static str>;

fn decode_fields(mut blob: &[u8]) -> ProtoResult<Vec<ProtoField<'_>>> {
    let mut fields = Vec::new();
    while !blob.is_empty() {
        let tag = read_varint(&mut blob)?;
        let number = u32::try_from(tag >> 3).map_err(|_| "protobuf field number overflow")?;
        if number == 0 {
            return Err("protobuf field number is zero");
        }
        let wire = tag & 7;
        let value = match wire {
            0 => ProtoValue::Varint(read_varint(&mut blob)?),
            1 => {
                take_bytes(&mut blob, 8)?;
                ProtoValue::Fixed64
            }
            2 => ProtoValue::Bytes(take_length_delimited(&mut blob)?),
            5 => {
                take_bytes(&mut blob, 4)?;
                ProtoValue::Fixed32
            }
            _ => return Err("unsupported protobuf wire type"),
        };
        fields.push(ProtoField { number, value });
    }
    Ok(fields)
}

fn read_varint(blob: &mut &[u8]) -> ProtoResult<u64> {
    let mut value = 0_u64;
    for shift in (0..10).map(|index| index * 7) {
        let byte = *blob.first().ok_or("truncated protobuf varint")?;
        *blob = &blob[1..];
        let payload = u64::from(byte & 0x7f);
        if shift == 63 && payload > 1 {
            return Err("protobuf varint overflow");
        }
        value |= payload << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
        if shift == 63 {
            return Err("protobuf varint overflow");
        }
    }
    Err("protobuf varint overflow")
}

fn take_bytes<'a>(blob: &mut &'a [u8], length: usize) -> ProtoResult<&'a [u8]> {
    if blob.len() < length {
        return Err("truncated protobuf fixed-width value");
    }
    let (value, rest) = blob.split_at(length);
    *blob = rest;
    Ok(value)
}

fn take_length_delimited<'a>(blob: &mut &'a [u8]) -> ProtoResult<&'a [u8]> {
    let length = usize::try_from(read_varint(blob)?).map_err(|_| "protobuf length overflow")?;
    take_bytes(blob, length)
}

fn field_varint(fields: &[ProtoField<'_>], number: u32) -> Option<u64> {
    fields.iter().rev().find_map(|field| match field {
        ProtoField {
            number: field_number,
            value: ProtoValue::Varint(value),
        } if *field_number == number => Some(*value),
        _ => None,
    })
}

fn field_bytes<'a>(fields: &'a [ProtoField<'a>], number: u32) -> Option<&'a [u8]> {
    fields.iter().find_map(|field| match field {
        ProtoField {
            number: field_number,
            value: ProtoValue::Bytes(value),
        } if *field_number == number => Some(*value),
        _ => None,
    })
}

fn field_bytes_all<'a>(fields: &'a [ProtoField<'a>], number: u32) -> Vec<&'a [u8]> {
    fields
        .iter()
        .filter_map(|field| match field {
            ProtoField {
                number: field_number,
                value: ProtoValue::Bytes(value),
            } if *field_number == number => Some(*value),
            _ => None,
        })
        .collect()
}

fn field_text(fields: &[ProtoField<'_>], number: u32) -> Option<String> {
    fields
        .iter()
        .rev()
        .find_map(|field| match field {
            ProtoField {
                number: field_number,
                value: ProtoValue::Bytes(value),
            } if *field_number == number => Some(*value),
            _ => None,
        })
        .and_then(|value| std::str::from_utf8(value).ok())
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
}

/// Timestamp message: field 1 seconds (> 0), field 2 nanos.
fn parse_timestamp_message(blob: &[u8]) -> ProtoResult<Option<i64>> {
    let fields = decode_fields(blob)?;
    let seconds = match field_varint(&fields, 1).and_then(|value| i64::try_from(value).ok()) {
        Some(seconds) if seconds > 0 => seconds,
        _ => return Ok(None),
    };
    let nanos = field_varint(&fields, 2).unwrap_or(0).min(999_999_999);
    Ok(Some(
        seconds
            .saturating_mul(1000)
            .saturating_add((nanos / 1_000_000) as i64),
    ))
}

// ── Model alias tables (ported from ccusage rust/adapters/antigravity) ──

fn model_name_from_id(model_id: u64) -> String {
    match model_id {
        246 => "gemini-2.5-pro".to_string(),
        312 => "gemini-2.5-flash".to_string(),
        313 | 329 => "gemini-2.5-flash-thinking".to_string(),
        330 => "gemini-2.5-flash-lite".to_string(),
        281 | 282 => "claude-4-sonnet".to_string(),
        290 | 291 => "claude-4-opus".to_string(),
        333 | 334 => "claude-4.5-sonnet".to_string(),
        340 | 341 => "claude-4.5-haiku".to_string(),
        342 => "model_openai_gpt_oss_120b_medium".to_string(),
        1318 => "gemini-3.8-flash-high".to_string(),
        1319 => "gemini-3.8-flash-medium".to_string(),
        1320 => "gemini-3.8-flash-low".to_string(),
        1298 => "gemini-3.7-flash-high".to_string(),
        1299 => "gemini-3.7-flash-medium".to_string(),
        1300 => "gemini-3.7-flash-low".to_string(),
        1071 => "gemini-3.6-flash-high".to_string(),
        1072 => "gemini-3.6-flash-medium".to_string(),
        1073 => "gemini-3.6-flash-low".to_string(),
        1_000.. => format!("model_placeholder_m{}", model_id - 1_000),
        _ => format!("antigravity-model-{model_id}"),
    }
}

fn normalize_antigravity_model(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    let effort_variant = match lower.as_str() {
        "gemini 3.8 flash (high)" => Some("gemini-3.8-flash-high"),
        "gemini 3.8 flash (medium)" => Some("gemini-3.8-flash-medium"),
        "gemini 3.8 flash (low)" => Some("gemini-3.8-flash-low"),
        "gemini 3.7 flash (high)" => Some("gemini-3.7-flash-high"),
        "gemini 3.7 flash (medium)" => Some("gemini-3.7-flash-medium"),
        "gemini 3.7 flash (low)" => Some("gemini-3.7-flash-low"),
        "gemini 3.6 flash (high)" => Some("gemini-3.6-flash-high"),
        "gemini 3.6 flash (medium)" => Some("gemini-3.6-flash-medium"),
        "gemini 3.6 flash (low)" => Some("gemini-3.6-flash-low"),
        _ => None,
    };
    if let Some(model) = effort_variant {
        return Some(model.to_string());
    }
    let base = lower
        .find('(')
        .map_or(lower.as_str(), |index| lower[..index].trim());
    let normalized = match base {
        "gemini 3.8 flash" | "gemini 3.8 flash thinking" => "gemini-3.8-flash",
        "gemini 3.7 flash" | "gemini 3.7 flash thinking" => "gemini-3.7-flash",
        "gemini 3.7 pro" | "gemini 3.7 pro thinking" => "gemini-3.7-pro",
        "gemini 3.6 flash" | "gemini 3 flash" => "gemini-3.6-flash",
        "gemini 3.6 pro" => "gemini-3.6-pro",
        "gemini 3 pro" | "gemini 3 pro thinking" => "gemini-3-pro",
        "gemini 2.5 flash" => "gemini-2.5-flash",
        "gemini 2.5 pro" => "gemini-2.5-pro",
        "gemini 2.0 flash" | "gemini 2 flash" => "gemini-2.0-flash",
        "gemini 2.0 pro" => "gemini-2.0-pro",
        "gemini 1.5 flash" => "gemini-1.5-flash",
        "gemini 1.5 pro" => "gemini-1.5-pro",
        "model_placeholder_m318" => "gemini-3.8-flash-high",
        "model_placeholder_m319" => "gemini-3.8-flash-medium",
        "model_placeholder_m320" => "gemini-3.8-flash-low",
        "model_placeholder_m298" => "gemini-3.7-flash-high",
        "model_placeholder_m299" => "gemini-3.7-flash-medium",
        "model_placeholder_m300" => "gemini-3.7-flash-low",
        "model_placeholder_m71" => "gemini-3.6-flash-high",
        "model_placeholder_m72" => "gemini-3.6-flash-medium",
        "model_placeholder_m73" => "gemini-3.6-flash-low",
        "model_placeholder_m26" => "claude-opus-4-6",
        "model_placeholder_m35" => "claude-sonnet-4-6",
        "model_placeholder_m36" | "model_placeholder_m37" | "model_placeholder_m16" => {
            "gemini-3.1-pro"
        }
        "model_placeholder_m18" | "model_placeholder_m84" | "model_placeholder_m47" => {
            "gemini-3-flash-preview"
        }
        "model_placeholder_m132" | "model_placeholder_m133" => "gemini-3.5-flash-high",
        "model_placeholder_m187" => "gemini-3.5-flash-extra-low",
        "model_placeholder_m20" => "gemini-3.5-flash-medium",
        "model_openai_gpt_oss_120b_medium" => "gpt-oss-120b-medium",
        "gemini-pro-default" | "gemini-pro-agent" => "gemini-3.1-pro",
        "gemini-3-flash-agent"
        | "gemini-3-flash-agent-a"
        | "gemini-3-flash-agent-b"
        | "gemini-3-flash-a"
        | "gemini-3-flash-b" => "gemini-3.5-flash-high",
        "gemini-3-flash-c" | "gemini-3-flash" => "gemini-3-flash-preview",
        "gemini-3.5-flash-low" => "gemini-3.5-flash-medium",
        "gemini-3.1-pro-high" | "gemini-3.1-pro-low" => "gemini-3.1-pro",
        "gemini-3-pro-high" | "gemini-3-pro-low" => "gemini-3-pro",
        "claude 3.7 sonnet" | "claude 3.7 sonnet thinking" => "claude-3-7-sonnet",
        "claude 3.5 sonnet" => "claude-3-5-sonnet",
        "claude 3.5 haiku" => "claude-3-5-haiku",
        "claude 3 opus" => "claude-3-opus",
        _ => {
            let converted = base.replace(' ', "-");
            if converted.starts_with("gemini-")
                || converted.starts_with("claude-")
                || converted.starts_with("gpt-")
            {
                return Some(converted);
            }
            return Some(trimmed.to_string());
        }
    };
    Some(normalized.to_string())
}

// ── Parsed metadata shapes ──

#[derive(Debug, Default, Clone)]
struct ModelUsage {
    model_id: Option<u64>,
    input_tokens: u64,
    total_output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    reasoning_tokens: u64,
    visible_output_tokens: u64,
    message_id: Option<String>,
    response_id: Option<String>,
    provider_assigned_message_id: Option<String>,
}

impl ModelUsage {
    fn is_token_bearing(&self) -> bool {
        self.input_tokens > 0
            || self.total_output_tokens > 0
            || self.cache_creation_tokens > 0
            || self.cache_read_tokens > 0
            || self.reasoning_tokens > 0
            || self.visible_output_tokens > 0
    }

    fn identity_keys(&self) -> Vec<String> {
        let mut keys = Vec::new();
        if let Some(value) = self
            .response_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            keys.push(format!("response:{value}"));
        }
        if let Some(value) = self
            .provider_assigned_message_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            keys.push(format!("provider:{value}"));
        }
        if let Some(value) = self.message_id.as_deref().filter(|value| !value.is_empty()) {
            keys.push(format!("message:{value}"));
        }
        keys
    }
}

#[derive(Debug, Default)]
struct GeneratorMetadata {
    model: Option<String>,
    model_id: Option<u64>,
    usage: Option<ModelUsage>,
    retry_usages: Vec<ModelUsage>,
    timestamp: Option<i64>,
}

#[derive(Debug, Default)]
struct StepMetadata {
    model: Option<String>,
    model_id: Option<u64>,
    usage: Option<ModelUsage>,
    retry_usages: Vec<ModelUsage>,
    timestamp: Option<i64>,
}

/// A usage event after the output/reasoning split, before identity dedup.
#[derive(Debug, Clone)]
struct ParsedEvent {
    timestamp_ms: i64,
    model: String,
    session_id: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    reasoning_tokens: u64,
    total_output_tokens: u64,
    identities: Vec<String>,
}

fn parse_model_usage(blob: &[u8]) -> ProtoResult<ModelUsage> {
    let fields = decode_fields(blob)?;
    Ok(ModelUsage {
        model_id: field_varint(&fields, 1).filter(|value| *value != 0),
        input_tokens: field_varint(&fields, 2).unwrap_or(0),
        total_output_tokens: field_varint(&fields, 3).unwrap_or(0),
        cache_creation_tokens: field_varint(&fields, 4).unwrap_or(0),
        cache_read_tokens: field_varint(&fields, 5).unwrap_or(0),
        reasoning_tokens: field_varint(&fields, 9).unwrap_or(0),
        visible_output_tokens: field_varint(&fields, 10).unwrap_or(0),
        message_id: field_text(&fields, 7),
        response_id: field_text(&fields, 11),
        provider_assigned_message_id: field_text(&fields, 12),
    })
}

fn parse_retry_usages(fields: &[ProtoField<'_>], number: u32) -> ProtoResult<Vec<ModelUsage>> {
    let mut usages = Vec::new();
    for blob in field_bytes_all(fields, number) {
        let retry_fields = decode_fields(blob)?;
        if let Some(usage) = field_bytes(&retry_fields, 2) {
            usages.push(parse_model_usage(usage)?);
        }
    }
    Ok(usages)
}

fn parse_generator_metadata(blob: &[u8]) -> ProtoResult<GeneratorMetadata> {
    let root = decode_fields(blob)?;
    let chat_model = field_bytes(&root, 1).ok_or("missing chat model field 1")?;
    let fields = decode_fields(chat_model)?;
    let timestamp = match field_bytes(&fields, 9) {
        Some(generation_info) => {
            let info_fields = decode_fields(generation_info)?;
            match field_bytes(&info_fields, 4) {
                Some(timestamp_message) => parse_timestamp_message(timestamp_message)?,
                None => None,
            }
        }
        None => None,
    };
    Ok(GeneratorMetadata {
        model: [19, 21].into_iter().find_map(|field| field_text(&fields, field)),
        model_id: field_varint(&fields, 3).filter(|value| *value != 0),
        usage: match field_bytes(&fields, 4) {
            Some(usage) => Some(parse_model_usage(usage)?),
            None => None,
        },
        retry_usages: parse_retry_usages(&fields, 17)?,
        timestamp,
    })
}

fn parse_model_info(blob: &[u8]) -> ProtoResult<(Option<String>, Option<u64>)> {
    let fields = decode_fields(blob)?;
    Ok((
        field_text(&fields, 12).or_else(|| field_text(&fields, 8)),
        field_varint(&fields, 1).filter(|value| *value != 0),
    ))
}

fn parse_step_metadata(blob: &[u8]) -> ProtoResult<StepMetadata> {
    let fields = decode_fields(blob)?;
    let (model, model_id) = match field_bytes(&fields, 24) {
        Some(model_info) => parse_model_info(model_info)?,
        None => (None, None),
    };
    let timestamp_blob = field_bytes(&fields, 8).or_else(|| field_bytes(&fields, 1));
    let timestamp = match timestamp_blob {
        Some(blob) => parse_timestamp_message(blob)?,
        None => None,
    };
    Ok(StepMetadata {
        model,
        model_id,
        usage: match field_bytes(&fields, 9) {
            Some(usage) => Some(parse_model_usage(usage)?),
            None => None,
        },
        retry_usages: parse_retry_usages(&fields, 28)?,
        timestamp,
    })
}

fn parse_trajectory_metadata(blob: &[u8]) -> ProtoResult<(Option<i64>, Option<String>)> {
    let fields = decode_fields(blob)?;
    let timestamp = match field_bytes(&fields, 2) {
        Some(timestamp_message) => parse_timestamp_message(timestamp_message)?,
        None => None,
    };
    // Field 7 carries the workspace root as a `file://` URI. The rest of the
    // blob is conversation content and must not be read.
    let workspace = field_bytes(&fields, 7)
        .and_then(|uri| std::str::from_utf8(uri).ok())
        .and_then(workspace_path_from_uri);
    Ok((timestamp, workspace))
}

/// Turn a `file:///abs/path` workspace URI into a plain absolute path,
/// percent-decoding escaped characters. Non-file URIs yield None.
fn workspace_path_from_uri(uri: &str) -> Option<String> {
    let path = uri.strip_prefix("file://")?;
    if !path.starts_with('/') {
        return None;
    }
    let decoded = percent_decode(path);
    if decoded.is_empty() {
        return None;
    }
    Some(decoded)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let hex_digit = |byte: u8| -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    };
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex_digit(bytes[index + 1]), hex_digit(bytes[index + 2])) {
                out.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn resolve_model(model_id: Option<u64>, context_model: Option<&str>) -> String {
    let from_usage = model_id
        .map(model_name_from_id)
        .and_then(|model| normalize_antigravity_model(&model));
    from_usage
        .or_else(|| context_model.and_then(normalize_antigravity_model))
        .unwrap_or_else(|| "unknown".to_string())
}

fn file_mtime_ms(path: &str) -> i64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

struct EventContext<'a> {
    model: Option<&'a str>,
    timestamp: Option<(i64, u8)>,
    trajectory_timestamp: Option<i64>,
    fallback_timestamp: i64,
    session_id: &'a str,
}

#[allow(clippy::too_many_arguments)]
fn append_usage_event(
    events: &mut Vec<ParsedEvent>,
    identity_timestamps: &mut HashMap<String, (i64, u8)>,
    usage: ModelUsage,
    context: &EventContext<'_>,
) {
    if !usage.is_token_bearing() {
        return;
    }
    let (timestamp, timestamp_rank) = context
        .timestamp
        .or_else(|| {
            usage
                .identity_keys()
                .into_iter()
                .find_map(|identity| identity_timestamps.get(&identity).copied())
        })
        .or_else(|| context.trajectory_timestamp.map(|timestamp| (timestamp, 1)))
        .unwrap_or((context.fallback_timestamp, 0));
    let total_output_tokens = usage.total_output_tokens.max(
        usage
            .visible_output_tokens
            .saturating_add(usage.reasoning_tokens),
    );
    let output_tokens = usage
        .visible_output_tokens
        .max(total_output_tokens.saturating_sub(usage.reasoning_tokens));
    let reasoning_tokens = usage
        .reasoning_tokens
        .max(total_output_tokens.saturating_sub(output_tokens));
    let model = resolve_model(usage.model_id, context.model);
    let identities = usage.identity_keys();
    for identity in &identities {
        let should_update = identity_timestamps
            .get(identity)
            .map_or(true, |(old_timestamp, old_rank)| {
                timestamp_rank > *old_rank
                    || (timestamp_rank == *old_rank && timestamp < *old_timestamp)
            });
        if should_update {
            identity_timestamps.insert(identity.clone(), (timestamp, timestamp_rank));
        }
    }
    events.push(ParsedEvent {
        timestamp_ms: timestamp,
        model,
        session_id: context.session_id.to_string(),
        input_tokens: usage.input_tokens,
        output_tokens,
        cache_creation_tokens: usage.cache_creation_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        reasoning_tokens,
        total_output_tokens,
        identities,
    });
}

/// Union-find over shared identity keys; merge duplicates with per-bucket max,
/// mirroring ccusage's sequential dedup semantics (first event keeps its
/// timestamp/model, duplicates only raise token maxima).
fn deduplicate_events(events: Vec<ParsedEvent>) -> Vec<ParsedEvent> {
    let mut parent: Vec<usize> = (0..events.len()).collect();
    fn find(parent: &mut Vec<usize>, mut x: usize) -> usize {
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    let mut key_to_event: HashMap<&str, usize> = HashMap::new();
    for (index, event) in events.iter().enumerate() {
        let mut roots: Vec<usize> = event
            .identities
            .iter()
            .filter_map(|identity| key_to_event.get(identity.as_str()).map(|e| find(&mut parent, *e)))
            .collect();
        roots.sort_unstable();
        roots.dedup();
        if let Some(&root) = roots.first() {
            for other in roots.iter().skip(1) {
                parent[*other] = root;
            }
            parent[index] = root;
        }
        for identity in &event.identities {
            key_to_event.insert(identity.as_str(), index);
        }
    }

    let mut merged: HashMap<usize, ParsedEvent> = HashMap::new();
    for (index, event) in events.into_iter().enumerate() {
        let root = find(&mut parent, index);
        match merged.get_mut(&root) {
            Some(target) => {
                target.input_tokens = target.input_tokens.max(event.input_tokens);
                target.output_tokens = target.output_tokens.max(event.output_tokens);
                target.cache_creation_tokens = target
                    .cache_creation_tokens
                    .max(event.cache_creation_tokens);
                target.cache_read_tokens = target.cache_read_tokens.max(event.cache_read_tokens);
                target.reasoning_tokens = target.reasoning_tokens.max(event.reasoning_tokens);
                target.total_output_tokens = target
                    .total_output_tokens
                    .max(event.total_output_tokens)
                    .max(target.output_tokens.saturating_add(target.reasoning_tokens));
                for identity in event.identities {
                    if !target.identities.contains(&identity) {
                        target.identities.push(identity);
                    }
                }
            }
            None => {
                merged.insert(root, event);
            }
        }
    }

    let mut out: Vec<ParsedEvent> = merged.into_values().collect();
    out.sort_by(|a, b| {
        a.timestamp_ms
            .cmp(&b.timestamp_ms)
            .then_with(|| a.model.cmp(&b.model))
    });
    out
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
            [table],
            |_| Ok(()),
        )
        .map(|_| true)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(false),
            other => Err(other.to_string()),
        })
}

fn resolve_conversations_dir(root: &str) -> String {
    let nested = Path::new(root).join("conversations");
    if nested.is_dir() {
        nested.to_string_lossy().to_string()
    } else {
        root.to_string()
    }
}

fn is_antigravity_db(path: &str) -> bool {
    path.ends_with(".db")
}

impl AntigravityLocalProvider {
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
        let candidates = [
            ".gemini/antigravity",
            ".gemini/antigravity-cli",
            ".gemini/antigravity-ide",
            ".gemini/antigravity-backup",
            ".gemini/antigravity-acp",
            ".config/antigravity",
        ];
        let mut roots = Vec::new();
        for candidate in candidates {
            let root = home.join(candidate);
            if root.is_dir() {
                roots.push(root.to_string_lossy().to_string());
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

        struct Discovered {
            path: String,
            stem: String,
            prefers: bool, // non-backup root wins for the same stem
            size: u64,
            mtime_ms: i64,
        }

        let mut discovered: Vec<Discovered> = Vec::new();
        let mut collect = |root: &str| {
            let dir = resolve_conversations_dir(root);
            for path in walk_files(&dir, is_antigravity_db, DEFAULT_SCAN_FILE_LIMIT) {
                let stem = Path::new(&path)
                    .file_stem()
                    .map(|stem| stem.to_string_lossy().to_string())
                    .unwrap_or_default();
                if stem.is_empty() {
                    continue;
                }
                let metadata = std::fs::metadata(&path).ok();
                let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                let mtime_ms = metadata
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                discovered.push(Discovered {
                    prefers: !path.contains("antigravity-backup"),
                    stem,
                    path,
                    size,
                    mtime_ms,
                });
            }
        };

        for root in self.auto_roots(config) {
            if ignored.contains(&root) {
                continue;
            }
            collect(&root);
        }
        for root in self.manual_roots(config) {
            collect(&root);
        }

        // Antigravity keeps whole-conversation copies in the backup root with
        // the same file name (cascade UUID); count each conversation once,
        // preferring the non-backup copy and the freshest file otherwise.
        let mut by_stem: HashMap<String, usize> = HashMap::new();
        let mut kept: Vec<Discovered> = Vec::new();
        for entry in discovered {
            match by_stem.get(&entry.stem) {
                Some(&index) => {
                    let existing = &mut kept[index];
                    let replace = if entry.prefers != existing.prefers {
                        entry.prefers
                    } else {
                        (entry.size, entry.mtime_ms) > (existing.size, existing.mtime_ms)
                    };
                    if replace {
                        *existing = entry;
                    }
                }
                None => {
                    by_stem.insert(entry.stem.clone(), kept.len());
                    kept.push(entry);
                }
            }
        }

        let mut paths: Vec<String> = kept.into_iter().map(|entry| entry.path).collect();
        paths.sort();
        paths.dedup();
        paths
    }

    pub fn parse_usage(&self, db_path: &str) -> Vec<Value> {
        self.try_parse_usage(db_path).unwrap_or_default()
    }

    pub fn try_parse_usage(&self, db_path: &str) -> Result<Vec<Value>, String> {
        // Read-only: the live db belongs to the Antigravity process.
        let conn = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| e.to_string())?;

        // Antigravity pre-creates empty (0-page) conversation databases; they
        // carry no usage and must not fail the scan.
        let page_count: i64 = conn
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if page_count == 0 {
            return Ok(Vec::new());
        }

        let source = source_metadata(db_path, PROVIDER_ID, VERSION);
        let fallback_timestamp = file_mtime_ms(db_path);
        let session_id = Path::new(db_path)
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .filter(|stem| !stem.is_empty())
            .unwrap_or_else(|| format!("antigravity-{}", fallback_timestamp));

        let (trajectory_timestamp, workspace) = if table_exists(&conn, "trajectory_metadata_blob")? {
            conn.query_row(
                "SELECT data FROM trajectory_metadata_blob ORDER BY rowid ASC LIMIT 1",
                [],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .ok()
            .map(|blob| parse_trajectory_metadata(&blob))
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or((None, None))
        } else {
            (None, None)
        };

        // gen_metadata is the required table; a conversations db without it
        // is not an Antigravity database (or is unreadable) — surface as error.
        let mut generation_stmt = conn
            .prepare("SELECT idx, data FROM gen_metadata ORDER BY idx ASC")
            .map_err(|e| e.to_string())?;
        let generation_rows = generation_stmt
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut generations: Vec<(i64, GeneratorMetadata)> = Vec::new();
        for row in generation_rows {
            let (idx, blob) = row.map_err(|e| e.to_string())?;
            let metadata = parse_generator_metadata(&blob)
                .map_err(|error| format!("gen_metadata row {idx}: {error}"))?;
            generations.push((idx, metadata));
        }
        drop(generation_stmt);

        let mut steps: Vec<(i64, StepMetadata)> = Vec::new();
        if table_exists(&conn, "steps")? {
            let mut step_stmt = conn
                .prepare("SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx ASC")
                .map_err(|e| e.to_string())?;
            let step_rows = step_stmt
                .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)))
                .map_err(|e| e.to_string())?;
            for row in step_rows {
                let (idx, blob) = row.map_err(|e| e.to_string())?;
                let metadata = parse_step_metadata(&blob)
                    .map_err(|error| format!("steps row {idx}: {error}"))?;
                steps.push((idx, metadata));
            }
        }

        // Steps fall back to the most recently observed generation model.
        let generation_model = generations.iter().rev().find_map(|(_, metadata)| {
            metadata
                .model
                .as_deref()
                .and_then(normalize_antigravity_model)
                .or_else(|| {
                    metadata
                        .model_id
                        .map(model_name_from_id)
                        .and_then(|model| normalize_antigravity_model(&model))
                })
        });

        let mut events: Vec<ParsedEvent> = Vec::new();
        let mut identity_timestamps: HashMap<String, (i64, u8)> = HashMap::new();

        for (_, metadata) in &steps {
            let model = metadata
                .model
                .as_deref()
                .and_then(normalize_antigravity_model)
                .or_else(|| {
                    metadata
                        .model_id
                        .map(model_name_from_id)
                        .and_then(|model| normalize_antigravity_model(&model))
                })
                .or_else(|| generation_model.clone())
                .or_else(|| metadata.model.clone());
            let timestamp = metadata.timestamp.map(|timestamp| (timestamp, 3));
            let mut usages: Vec<ModelUsage> = Vec::new();
            if let Some(usage) = metadata.usage.clone() {
                usages.push(usage);
            }
            usages.extend(metadata.retry_usages.iter().cloned());
            for usage in usages {
                append_usage_event(
                    &mut events,
                    &mut identity_timestamps,
                    usage,
                    &EventContext {
                        model: model.as_deref(),
                        timestamp,
                        trajectory_timestamp,
                        fallback_timestamp,
                        session_id: &session_id,
                    },
                );
            }
        }

        let mut current_model: Option<String> = None;
        for (_, metadata) in &generations {
            let row_model = metadata
                .model
                .as_deref()
                .and_then(normalize_antigravity_model)
                .or_else(|| {
                    metadata
                        .model_id
                        .map(model_name_from_id)
                        .and_then(|model| normalize_antigravity_model(&model))
                })
                .or_else(|| {
                    metadata
                        .usage
                        .as_ref()
                        .and_then(|usage| usage.model_id)
                        .map(model_name_from_id)
                        .and_then(|model| normalize_antigravity_model(&model))
                });
            if let Some(model) = row_model {
                current_model = Some(model);
            }
            // Continuation rows without their own model inherit the most
            // recently observed generation model.
            let model = current_model.clone().or_else(|| metadata.model.clone());
            let timestamp = metadata.timestamp.map(|timestamp| (timestamp, 3));
            let mut usages: Vec<ModelUsage> = Vec::new();
            if let Some(usage) = metadata.usage.clone() {
                usages.push(usage);
            }
            usages.extend(metadata.retry_usages.iter().cloned());
            for usage in usages {
                append_usage_event(
                    &mut events,
                    &mut identity_timestamps,
                    usage,
                    &EventContext {
                        model: model.as_deref(),
                        timestamp,
                        trajectory_timestamp,
                        fallback_timestamp,
                        session_id: &session_id,
                    },
                );
            }
        }

        let merged = deduplicate_events(events);
        let mut out = Vec::with_capacity(merged.len());
        for event in merged {
            let total = event
                .input_tokens
                .saturating_add(event.output_tokens)
                .saturating_add(event.cache_read_tokens)
                .saturating_add(event.cache_creation_tokens);
            if total == 0 {
                continue;
            }
            // A timestamp that never resolved (metadata failure / pre-epoch
            // mtime) must not attribute tokens to 1970-01-01.
            if event.timestamp_ms <= 0 {
                continue;
            }
            out.push(json!({
                "providerId": PROVIDER_ID,
                "providerVersion": VERSION,
                "toolCode": TOOL_CODE,
                "sourceKind": "local_db",
                "sourceQuality": "exact",
                "sessionId": event.session_id,
                "day": crate::date::local_day_from_timestamp_ms(event.timestamp_ms),
                "hour": crate::date::local_hour_from_timestamp_ms(event.timestamp_ms),
                // Real workspace root when the trajectory blob carries one;
                // otherwise a virtual bucket keeps the source attributable.
                "workdirCandidate": workspace
                    .as_deref()
                    .unwrap_or("virtual:antigravity:Antigravity"),
                "model": event.model,
                "inputTokens": event.input_tokens,
                "outputTokens": event.output_tokens,
                "cacheReadTokens": event.cache_read_tokens,
                "cacheWriteTokens": event.cache_creation_tokens,
                "reasoningTokens": event.reasoning_tokens,
                "totalTokens": total,
                "rawSourceRef": source.raw_source_ref,
                "sourceFingerprint": source.source_fingerprint,
                "parserVersion": source.parser_version,
            }));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Minimal protobuf encoder for synthetic fixtures ──

    fn enc_varint(mut value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                break;
            }
            out.push(byte | 0x80);
        }
        out
    }

    fn concat(parts: &[Vec<u8>]) -> Vec<u8> {
        let mut out = Vec::new();
        for part in parts {
            out.extend_from_slice(part);
        }
        out
    }

    fn enc_varint_field(field: u32, value: u64) -> Vec<u8> {
        concat(&[enc_varint((u64::from(field) << 3) | 0), enc_varint(value)])
    }

    fn enc_bytes_field(field: u32, data: &[u8]) -> Vec<u8> {
        concat(&[
            enc_varint((u64::from(field) << 3) | 2),
            enc_varint(data.len() as u64),
            data.to_vec(),
        ])
    }

    fn enc_str_field(field: u32, value: &str) -> Vec<u8> {
        enc_bytes_field(field, value.as_bytes())
    }

    struct UsageSpec {
        model_id: Option<u64>,
        input: u64,
        total_out: u64,
        cache_write: u64,
        cache_read: u64,
        reasoning: u64,
        visible: u64,
        message_id: Option<&'static str>,
        response_id: Option<&'static str>,
        provider_message_id: Option<&'static str>,
    }

    impl Default for UsageSpec {
        fn default() -> Self {
            UsageSpec {
                model_id: None,
                input: 100,
                total_out: 20,
                cache_write: 0,
                cache_read: 0,
                reasoning: 0,
                visible: 20,
                message_id: None,
                response_id: None,
                provider_message_id: None,
            }
        }
    }

    fn usage_blob(spec: &UsageSpec) -> Vec<u8> {
        let mut parts = Vec::new();
        if let Some(model_id) = spec.model_id {
            parts.push(enc_varint_field(1, model_id));
        }
        parts.push(enc_varint_field(2, spec.input));
        parts.push(enc_varint_field(3, spec.total_out));
        parts.push(enc_varint_field(4, spec.cache_write));
        parts.push(enc_varint_field(5, spec.cache_read));
        parts.push(enc_varint_field(9, spec.reasoning));
        parts.push(enc_varint_field(10, spec.visible));
        if let Some(id) = spec.message_id {
            parts.push(enc_str_field(7, id));
        }
        if let Some(id) = spec.response_id {
            parts.push(enc_str_field(11, id));
        }
        if let Some(id) = spec.provider_message_id {
            parts.push(enc_str_field(12, id));
        }
        concat(&parts)
    }

    fn timestamp_message(seconds: u64) -> Vec<u8> {
        concat(&[enc_varint_field(1, seconds), enc_varint_field(2, 0)])
    }

    /// gen_metadata row: root field 1 = chat model; chat model fields:
    /// 3 model_id, 4 usage, 9 generation info (field 4 = timestamp),
    /// 17 retries, 19 model name.
    fn gen_row(model_name: Option<&str>, model_id: Option<u64>, usage: &UsageSpec, ts: Option<u64>) -> Vec<u8> {
        let mut chat = Vec::new();
        if let Some(id) = model_id {
            chat.extend(enc_varint_field(3, id));
        }
        chat.extend(enc_bytes_field(4, &usage_blob(usage)));
        if let Some(seconds) = ts {
            let generation_info = enc_bytes_field(4, &timestamp_message(seconds));
            chat.extend(enc_bytes_field(9, &generation_info));
        }
        if let Some(name) = model_name {
            chat.extend(enc_str_field(19, name));
        }
        enc_bytes_field(1, &chat)
    }

    fn gen_retry_row(retry_usage: &UsageSpec) -> Vec<u8> {
        let retry = enc_bytes_field(2, &usage_blob(retry_usage));
        let chat = enc_bytes_field(17, &retry);
        enc_bytes_field(1, &chat)
    }

    /// steps.metadata row: 9 usage, 24 model info, 8 timestamp.
    fn step_row(usage: &UsageSpec, model_name: Option<&str>, ts: Option<u64>) -> Vec<u8> {
        // Each helper returns one complete field encoding; extending a byte
        // buffer with them yields the concatenated message.
        let mut blob = Vec::new();
        blob.extend(enc_bytes_field(9, &usage_blob(usage)));
        if let Some(name) = model_name {
            let model_info = enc_str_field(12, name);
            blob.extend(enc_bytes_field(24, &model_info));
        }
        if let Some(seconds) = ts {
            blob.extend(enc_bytes_field(8, &timestamp_message(seconds)));
        }
        blob
    }

    struct FixtureDb {
        path: std::path::PathBuf,
    }

    fn create_db(
        name: &str,
        gen_rows: &[(i64, Vec<u8>)],
        step_rows: &[(i64, Vec<u8>)],
        trajectory: Option<Vec<u8>>,
    ) -> FixtureDb {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("atl-antigravity-{}-{}.db", name, suffix));
        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "CREATE TABLE gen_metadata (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))",
            [],
        )
        .unwrap();
        for (idx, blob) in gen_rows {
            conn.execute(
                "INSERT INTO gen_metadata (idx, data, size) VALUES (?1, ?2, ?3)",
                rusqlite::params![idx, blob, blob.len() as i64],
            )
            .unwrap();
        }
        if !step_rows.is_empty() {
            conn.execute(
                "CREATE TABLE steps (`idx` integer,`metadata` blob,PRIMARY KEY (`idx`))",
                [],
            )
            .unwrap();
            for (idx, blob) in step_rows {
                conn.execute(
                    "INSERT INTO steps (idx, metadata) VALUES (?1, ?2)",
                    rusqlite::params![idx, blob],
                )
                .unwrap();
            }
        }
        if let Some(blob) = trajectory {
            conn.execute(
                "CREATE TABLE trajectory_metadata_blob (`id` text DEFAULT \"main\",`data` blob,PRIMARY KEY (`id`))",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?1)",
                rusqlite::params![blob],
            )
            .unwrap();
        }
        drop(conn);
        FixtureDb { path }
    }

    impl Drop for FixtureDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    fn test_config() -> AppConfig {
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
        assert_eq!(PROVIDER_ID, "antigravity_local");
        assert_eq!(TOOL_CODE, "antigravity");
    }

    #[test]
    fn test_parse_tokens_math_and_model_normalization() {
        // 2026-06-08 00:00:00 UTC in Asia/Singapore local day terms; use a
        // fixed epoch: 1780867200 = 2026-06-08T00:00:00Z.
        let usage = UsageSpec {
            input: 17674,
            total_out: 89,
            reasoning: 15,
            visible: 74,
            cache_read: 1200,
            message_id: Some("bot-alpha"),
            ..Default::default()
        };
        let fixture = create_db(
            "math",
            &[(0, gen_row(Some("gemini 3.8 flash (high)"), None, &usage, Some(1780867200)))],
            &[],
            None,
        );
        let events = AntigravityLocalProvider
            .try_parse_usage(&fixture.path.to_string_lossy())
            .unwrap();
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event["inputTokens"], 17674);
        assert_eq!(event["outputTokens"], 74);
        assert_eq!(event["reasoningTokens"], 15);
        assert_eq!(event["cacheReadTokens"], 1200);
        assert_eq!(event["cacheWriteTokens"], 0);
        // ATL rule: reasoning is diagnostic, not part of the ranking total.
        assert_eq!(event["totalTokens"], 17674 + 74 + 1200);
        assert_eq!(event["model"], "gemini-3.8-flash-high");
        assert_eq!(event["sourceKind"], "local_db");
        assert_eq!(event["sourceQuality"], "exact");
        assert!(event["day"].as_str().unwrap().starts_with("2026-06-0"));
    }

    #[test]
    fn test_total_output_split_when_visible_missing() {
        // total_out=300, reasoning=80, visible=0 => output=220, reasoning=80.
        let usage = UsageSpec {
            input: 50,
            total_out: 300,
            reasoning: 80,
            visible: 0,
            ..Default::default()
        };
        let fixture = create_db("split", &[(0, gen_row(None, Some(1318), &usage, Some(1780867200)))], &[], None);
        let events = AntigravityLocalProvider
            .try_parse_usage(&fixture.path.to_string_lossy())
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["outputTokens"], 220);
        assert_eq!(events[0]["reasoningTokens"], 80);
        // model_id 1318 maps through the alias table.
        assert_eq!(events[0]["model"], "gemini-3.8-flash-high");
    }

    #[test]
    fn test_retry_and_identity_dedup() {
        // A generation usage plus a retry copy sharing the message id must
        // collapse into one event carrying the max of each bucket.
        let usage = UsageSpec {
            input: 100,
            total_out: 20,
            visible: 20,
            message_id: Some("bot-dup"),
            ..Default::default()
        };
        let retry = UsageSpec {
            input: 150,
            total_out: 30,
            visible: 30,
            message_id: Some("bot-dup"),
            ..Default::default()
        };
        let fixture = create_db(
            "dedup",
            &[
                (0, gen_row(Some("gemini-3.7-flash"), None, &usage, Some(1780867200))),
                (1, gen_retry_row(&retry)),
            ],
            &[],
            None,
        );
        let events = AntigravityLocalProvider
            .try_parse_usage(&fixture.path.to_string_lossy())
            .unwrap();
        assert_eq!(events.len(), 1, "retry copy must merge into the original");
        assert_eq!(events[0]["inputTokens"], 150);
        assert_eq!(events[0]["outputTokens"], 30);
        assert_eq!(events[0]["totalTokens"], 180);
    }

    #[test]
    fn test_cross_container_identity_merge() {
        // steps usage and generation usage sharing a response id merge with
        // per-bucket max even though they arrive from different tables.
        let step_usage = UsageSpec {
            input: 10,
            total_out: 5,
            visible: 5,
            response_id: Some("resp-1"),
            ..Default::default()
        };
        let gen_usage = UsageSpec {
            input: 400,
            total_out: 60,
            visible: 60,
            response_id: Some("resp-1"),
            ..Default::default()
        };
        let fixture = create_db(
            "cross",
            &[(0, gen_row(None, None, &gen_usage, Some(1780867200)))],
            &[(0, step_row(&step_usage, None, Some(1780867200)))],
            None,
        );
        let events = AntigravityLocalProvider
            .try_parse_usage(&fixture.path.to_string_lossy())
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["inputTokens"], 400);
        assert_eq!(events[0]["outputTokens"], 60);
    }

    #[test]
    fn test_steps_model_and_timestamp() {
        let usage = UsageSpec {
            input: 700,
            total_out: 90,
            visible: 90,
            ..Default::default()
        };
        let zero = UsageSpec {
            input: 0,
            total_out: 0,
            visible: 0,
            ..Default::default()
        };
        let fixture = create_db(
            "steps",
            &[(0, gen_row(Some("gemini 3.7 flash"), None, &zero, Some(1780867200)))],
            &[(0, step_row(&usage, Some("claude 3.7 sonnet"), Some(1780953600)))],
            None,
        );
        let events = AntigravityLocalProvider
            .try_parse_usage(&fixture.path.to_string_lossy())
            .unwrap();
        // Zero-token generation is skipped; only the step remains.
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["model"], "claude-3-7-sonnet");
        assert!(events[0]["sessionId"]
            .as_str()
            .unwrap()
            .contains("atl-antigravity-steps"));
    }

    #[test]
    fn test_continuation_row_inherits_model() {
        let first = UsageSpec {
            model_id: Some(1298),
            input: 100,
            ..Default::default()
        };
        let second = UsageSpec {
            input: 200,
            ..Default::default()
        };
        let fixture = create_db(
            "inherit",
            &[
                (0, gen_row(None, None, &first, Some(1780867200))),
                (1, gen_row(None, None, &second, Some(1780867200))),
            ],
            &[],
            None,
        );
        let events = AntigravityLocalProvider
            .try_parse_usage(&fixture.path.to_string_lossy())
            .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["model"], "gemini-3.7-flash-high");
        assert_eq!(events[1]["model"], "gemini-3.7-flash-high");
    }

    #[test]
    fn test_timestamp_fallback_to_trajectory_then_mtime() {
        // No row timestamps: trajectory blob supplies the day.
        let usage = UsageSpec::default();
        let trajectory = enc_bytes_field(2, &timestamp_message(1780867200));
        let fixture = create_db("traj", &[(0, gen_row(None, None, &usage, None))], &[], Some(trajectory));
        let events = AntigravityLocalProvider
            .try_parse_usage(&fixture.path.to_string_lossy())
            .unwrap();
        assert_eq!(events.len(), 1);
        assert!(events[0]["day"].as_str().unwrap().starts_with("2026-06-0"));

        // No trajectory either: file mtime (just now) must yield today's day.
        let fixture2 = create_db("mtime", &[(0, gen_row(None, None, &usage, None))], &[], None);
        let events2 = AntigravityLocalProvider
            .try_parse_usage(&fixture2.path.to_string_lossy())
            .unwrap();
        assert_eq!(events2.len(), 1);
        assert!(!events2[0]["day"].as_str().unwrap().is_empty());
    }

    #[test]
    fn test_workspace_uri_from_trajectory() {
        let usage = UsageSpec::default();
        let trajectory = concat(&[
            enc_bytes_field(2, &timestamp_message(1780867200)),
            enc_str_field(7, "file:///Users/sky/1data/source/control"),
        ]);
        let fixture = create_db("ws", &[(0, gen_row(None, None, &usage, Some(1780867200)))], &[], Some(trajectory));
        let events = AntigravityLocalProvider
            .try_parse_usage(&fixture.path.to_string_lossy())
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["workdirCandidate"], "/Users/sky/1data/source/control");
    }

    #[test]
    fn test_workspace_uri_percent_decoded() {
        let usage = UsageSpec::default();
        let trajectory = enc_str_field(7, "file:///Users/sky/My%20Proj");
        let fixture = create_db("wspct", &[(0, gen_row(None, None, &usage, Some(1780867200)))], &[], Some(trajectory));
        let events = AntigravityLocalProvider
            .try_parse_usage(&fixture.path.to_string_lossy())
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["workdirCandidate"], "/Users/sky/My Proj");

        // An escape ending at the last byte still decodes; malformed hex
        // passes through literally instead of being dropped.
        let cases = [
            ("file:///a%20", "/a "),
            ("file:///a%G1", "/a%G1"),
            ("file:///a%", "/a%"),
        ];
        for (uri, expected) in cases {
            let trajectory = enc_str_field(7, uri);
            let fixture = create_db("wspctb", &[(0, gen_row(None, None, &usage, Some(1780867200)))], &[], Some(trajectory));
            let events = AntigravityLocalProvider
                .try_parse_usage(&fixture.path.to_string_lossy())
                .unwrap();
            assert_eq!(events.len(), 1, "uri: {uri}");
            assert_eq!(events[0]["workdirCandidate"], expected, "uri: {uri}");
        }
    }

    #[test]
    fn test_workspace_missing_or_non_file_uri_falls_back_to_virtual() {
        let usage = UsageSpec::default();

        // Trajectory blob without field 7.
        let trajectory = enc_bytes_field(2, &timestamp_message(1780867200));
        let fixture = create_db("wsnone", &[(0, gen_row(None, None, &usage, Some(1780867200)))], &[], Some(trajectory));
        let events = AntigravityLocalProvider
            .try_parse_usage(&fixture.path.to_string_lossy())
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["workdirCandidate"], "virtual:antigravity:Antigravity");

        // Non-file URI must not leak into workdir attribution.
        let trajectory = enc_str_field(7, "https://example.com/workspace");
        let fixture = create_db("wshttp", &[(0, gen_row(None, None, &usage, Some(1780867200)))], &[], Some(trajectory));
        let events = AntigravityLocalProvider
            .try_parse_usage(&fixture.path.to_string_lossy())
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["workdirCandidate"], "virtual:antigravity:Antigravity");

        // URI with a non-empty authority is not a local path.
        let trajectory = enc_str_field(7, "file://localhost/tmp/x");
        let fixture = create_db("wsauth", &[(0, gen_row(None, None, &usage, Some(1780867200)))], &[], Some(trajectory));
        let events = AntigravityLocalProvider
            .try_parse_usage(&fixture.path.to_string_lossy())
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["workdirCandidate"], "virtual:antigravity:Antigravity");

        // No trajectory table at all.
        let fixture = create_db("wsnotable", &[(0, gen_row(None, None, &usage, Some(1780867200)))], &[], None);
        let events = AntigravityLocalProvider
            .try_parse_usage(&fixture.path.to_string_lossy())
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["workdirCandidate"], "virtual:antigravity:Antigravity");
    }

    #[test]
    fn test_zero_token_rows_skipped() {
        let usage = UsageSpec {
            input: 0,
            total_out: 0,
            visible: 0,
            ..Default::default()
        };
        let fixture = create_db("zero", &[(0, gen_row(None, None, &usage, Some(1780867200)))], &[], None);
        let events = AntigravityLocalProvider
            .try_parse_usage(&fixture.path.to_string_lossy())
            .unwrap();
        assert!(events.is_empty());
    }

    #[test]
    fn test_missing_gen_metadata_table_is_error() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("atl-antigravity-no-table-{}.db", suffix));
        let conn = Connection::open(&path).unwrap();
        conn.execute("CREATE TABLE unrelated (id TEXT)", []).unwrap();
        drop(conn);

        assert!(AntigravityLocalProvider
            .try_parse_usage(&path.to_string_lossy())
            .is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_corrupt_protobuf_is_error() {
        let garbage = vec![0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
        let fixture = create_db("corrupt", &[(0, garbage)], &[], None);
        assert!(AntigravityLocalProvider
            .try_parse_usage(&fixture.path.to_string_lossy())
            .is_err());
    }

    #[test]
    fn test_empty_page_count_db_returns_ok_empty() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("atl-antigravity-empty-{}.db", suffix));
        std::fs::write(&path, b"").unwrap();
        let events = AntigravityLocalProvider
            .try_parse_usage(&path.to_string_lossy())
            .unwrap();
        assert!(events.is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_scan_sessions_backup_stem_dedup_and_manual_root() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("atl-antigravity-roots-{}", suffix));
        let main_dir = base.join("main/conversations");
        let backup_dir = base.join("antigravity-backup/conversations");
        std::fs::create_dir_all(&main_dir).unwrap();
        std::fs::create_dir_all(&backup_dir).unwrap();
        let stem = format!("conv-{}", suffix);
        let main_db = main_dir.join(format!("{}.db", stem));
        let backup_db = backup_dir.join(format!("{}.db", stem));
        std::fs::write(&main_db, b"main").unwrap();
        std::fs::write(&backup_db, b"backup-copy").unwrap();
        // Make the backup strictly fresher to prove preference, not recency,
        // picks the non-backup file.
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(3600);
        let _ = std::fs::File::options()
            .append(true)
            .open(&backup_db)
            .unwrap()
            .set_modified(later);

        let mut cfg = test_config();
        cfg.provider_roots.insert(
            PROVIDER_ID.into(),
            vec![
                base.join("main").to_string_lossy().to_string(),
                base.join("antigravity-backup")
                    .to_string_lossy()
                    .to_string(),
            ],
        );
        let sessions = AntigravityLocalProvider.scan_sessions(&cfg);
        // A real ~/.gemini/antigravity* install may exist on the dev machine
        // and contribute auto-root sessions; restrict the assertion to the
        // fixture stem.
        let fixture_sessions: Vec<&String> =
            sessions.iter().filter(|s| s.contains(&stem)).collect();
        assert_eq!(
            fixture_sessions.len(),
            1,
            "same-stem backup copy must collapse: {fixture_sessions:?}"
        );
        assert!(
            fixture_sessions[0].replace('\\', "/").contains("main/conversations"),
            "{}",
            fixture_sessions[0]
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_scan_sessions_disabled() {
        let mut cfg = test_config();
        cfg.provider_enabled.insert(PROVIDER_ID.into(), false);
        assert!(AntigravityLocalProvider.scan_sessions(&cfg).is_empty());
    }

    #[test]
    fn test_parse_usage_nonexistent_db_is_empty() {
        let events = AntigravityLocalProvider.parse_usage("/nonexistent/antigravity.db");
        assert!(events.is_empty());
    }
}
