//! Server-side board queries: leaderboard top-N and "where am I" rank lookups.
//! These are thin HTTP passthroughs over the public board API; no ranking or
//! cost logic is computed locally.

use collector_core::config::AppConfig;
use serde_json::Value;

fn valid_day(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        match index {
            4 | 7 => {
                if *byte != b'-' {
                    return false;
                }
            }
            _ => {
                if !byte.is_ascii_digit() {
                    return false;
                }
            }
        }
    }
    let month: u32 = value[5..7].parse().unwrap_or(0);
    let day: u32 = value[8..10].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// Map a CLI range onto the board leaderboard query string. The board accepts
/// today/yesterday/7d/30d/all or an explicit A..B day pair.
pub(crate) fn board_query(range: &str) -> Result<String, String> {
    if matches!(range, "today" | "yesterday" | "7d" | "last7" | "30d" | "last30" | "all") {
        return Ok(format!("range={}", range));
    }
    if let Some((from, to)) = range.split_once("..") {
        if (from.is_empty() || valid_day(from)) && (to.is_empty() || valid_day(to)) {
            let mut query = String::from("range=custom");
            if !from.is_empty() {
                query.push_str(&format!("&start={}", from));
            }
            if !to.is_empty() {
                query.push_str(&format!("&end={}", to));
            }
            return Ok(query);
        }
    }
    Err(format!(
        "Invalid range '{}'. Use today, yesterday, 7d, 30d, all, or YYYY-MM-DD..YYYY-MM-DD.",
        range
    ))
}

pub(crate) async fn fetch_json(base: &str, path_and_query: &str) -> Result<Value, String> {
    let url = format!("{}{}", base.trim_end_matches('/'), path_and_query);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("request failed for {}: {}", url, e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{} responded {}", url, status.as_u16()));
    }
    response
        .json::<Value>()
        .await
        .map_err(|e| format!("invalid JSON from {}: {}", url, e))
}

fn item_i64(item: &Value, key: &str) -> i64 {
    item.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn item_str<'a>(item: &'a Value, key: &str) -> &'a str {
    item.get(key).and_then(Value::as_str).unwrap_or("")
}

fn compact_tokens(tokens: i64) -> String {
    crate::cli::format_tokens_compact(tokens)
}

pub async fn cmd_top(
    cfg: &AppConfig,
    range: &str,
    limit: usize,
    json_out: bool,
) -> Result<(), String> {
    let query = board_query(range)?;
    let board = fetch_json(&cfg.api_base_url, &format!("/api/board/leaderboard?{}", query)).await?;
    let items = board.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    let shown: Vec<Value> = items.iter().take(limit).cloned().collect();
    if json_out {
        crate::cli::print_json_out(
            serde_json::json!({
                "range": range,
                "identityMode": board.get("identityMode").cloned().unwrap_or(Value::Null),
                "totalParticipants": items.len(),
                "items": shown,
            }),
            false,
        );
        return Ok(());
    }
    println!(
        "Top {} ({}) — server {}",
        shown.len().min(limit),
        range,
        cfg.api_base_url
    );
    if shown.is_empty() {
        println!("  (no participants on this leaderboard)");
        return Ok(());
    }
    let name_width = shown
        .iter()
        .map(|item| item_str(item, "displayName").chars().count())
        .max()
        .unwrap_or(0)
        .max(4);
    for (index, item) in shown.iter().enumerate() {
        println!(
            "  {:>3}  {:<width$}  {:>12}",
            index + 1,
            item_str(item, "displayName"),
            compact_tokens(item_i64(item, "totalTokens")),
            width = name_width
        );
    }
    if items.len() > shown.len() {
        println!("  … {} more participants", items.len() - shown.len());
    }
    Ok(())
}

/// Resolve which leaderboard entry is "me": in anonymous board mode the
/// displayId is a rotated public id resolved via /api/board/my-identity; in
/// public mode the board exposes participantId as displayId directly.
async fn my_display_id(cfg: &AppConfig, board: &Value) -> Result<String, String> {
    let identity_mode = board.get("identityMode").and_then(Value::as_str);
    if identity_mode == Some("anonymous") {
        let identity = fetch_json(
            &cfg.api_base_url,
            &format!(
                "/api/board/my-identity?participantId={}",
                urlencode(&cfg.participant_id)
            ),
        )
        .await?;
        let public_id = identity.get("publicId").and_then(Value::as_str).unwrap_or("");
        if public_id.is_empty() {
            return Err("server did not resolve a board identity for this participant".to_string());
        }
        Ok(public_id.to_string())
    } else {
        Ok(cfg.participant_id.clone())
    }
}

fn urlencode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

pub async fn cmd_rank(cfg: &AppConfig, range: &str, json_out: bool) -> Result<(), String> {
    let query = board_query(range)?;
    let board = fetch_json(&cfg.api_base_url, &format!("/api/board/leaderboard?{}", query)).await?;
    let items = board.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    let my_id = my_display_id(cfg, &board).await?;
    let position = items
        .iter()
        .position(|item| item_str(item, "displayId") == my_id);

    let Some(index) = position else {
        let message = format!(
            "You are not on this leaderboard ({}, {} participants returned). \
             Sync first, or the period has no usage for this device.",
            range,
            items.len()
        );
        if json_out {
            crate::cli::print_json_out(
                serde_json::json!({
                    "range": range,
                    "found": false,
                    "totalParticipants": items.len(),
                }),
                false,
            );
            return Ok(());
        }
        return Err(message);
    };

    let me = &items[index];
    let rank = index + 1;
    let ahead = items.get(index.wrapping_sub(1)).filter(|_| index > 0);
    let behind = items.get(index + 1);
    if json_out {
        crate::cli::print_json_out(
            serde_json::json!({
                "range": range,
                "found": true,
                "rank": rank,
                "totalParticipants": items.len(),
                "me": me,
                "ahead": ahead,
                "behind": behind,
            }),
            false,
        );
        return Ok(());
    }
    println!(
        "Rank {} of {} ({})",
        rank,
        items.len(),
        range
    );
    let name_width = [ahead, Some(me), behind]
        .iter()
        .flatten()
        .map(|item| item_str(item, "displayName").chars().count())
        .max()
        .unwrap_or(4);
    if let Some(ahead) = ahead {
        let gap = item_i64(ahead, "totalTokens") - item_i64(me, "totalTokens");
        println!(
            "  #{:<4}{:<width$}{:>12}  ({} ahead of you)",
            rank - 1,
            item_str(ahead, "displayName"),
            compact_tokens(item_i64(ahead, "totalTokens")),
            compact_tokens(gap),
            width = name_width + 2
        );
    }
    println!(
        "  #{:<4}{:<width$}{:>12}  (you)",
        rank,
        item_str(me, "displayName"),
        compact_tokens(item_i64(me, "totalTokens")),
        width = name_width + 2
    );
    if let Some(behind) = behind {
        let gap = item_i64(me, "totalTokens") - item_i64(behind, "totalTokens");
        println!(
            "  #{:<4}{:<width$}{:>12}  ({} behind you)",
            rank + 1,
            item_str(behind, "displayName"),
            compact_tokens(item_i64(behind, "totalTokens")),
            compact_tokens(gap),
            width = name_width + 2
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn board_query_maps_ranges() {
        assert_eq!(board_query("7d").unwrap(), "range=7d");
        assert_eq!(board_query("today").unwrap(), "range=today");
        assert_eq!(
            board_query("2026-09-01..2026-09-15").unwrap(),
            "range=custom&start=2026-09-01&end=2026-09-15"
        );
        assert_eq!(board_query("..2026-09-15").unwrap(), "range=custom&end=2026-09-15");
    }

    #[test]
    fn board_query_rejects_garbage() {
        assert!(board_query("bogus").is_err());
        assert!(board_query("2026-13-99..2026-99-99").is_err());
        assert!(board_query("7..30").is_err());
    }

    #[test]
    fn urlencode_escapes_reserved_bytes() {
        assert_eq!(urlencode("p_abc-1"), "p_abc-1");
        assert_eq!(urlencode("a b/c"), "a%20b%2Fc");
    }
}
