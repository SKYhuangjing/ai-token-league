// Terminal frontend for the compute-sharing plugin — `atl share`.
//
// Presentation only: every capability rides the sidecar command channel
// (compute-sharing:*) the desktop card uses, including the crate-side backend
// flows (directory/claim/renew/revoke/live). The borrow store, identity
// signing and the share secret all stay out of this module.

use collector_core::modules;
use serde_json::{json, Value};

use crate::cli::format_tokens_compact;
use crate::plugin_cli::sidecar_call;
use crate::term;
use crate::cli::CliError;

const PLUGIN_ID: &str = "compute-sharing";

pub async fn cmd_share(action: crate::ShareAction) -> Result<(), CliError> {
    match action {
        crate::ShareAction::Dir { family, json } => cmd_dir(family.as_deref(), json).await,
        crate::ShareAction::Claims { json } => cmd_claims(json).await,
        crate::ShareAction::Claim { share_id, lane_id, json } => cmd_claim(&share_id, lane_id.as_deref(), json).await,
        crate::ShareAction::Renew { key_id, json } => cmd_renew(&key_id, json).await,
        crate::ShareAction::Revoke { key_id, json } => cmd_revoke(&key_id, json).await,
        crate::ShareAction::Test { key_id, model, json } => cmd_test(&key_id, model.as_deref(), json).await,
        crate::ShareAction::Owner { json } => cmd_owner(json).await,
        crate::ShareAction::Suggest { json } => cmd_suggest(json).await,
        crate::ShareAction::Stop { yes, json } => cmd_stop(yes, json).await,
        crate::ShareAction::Resume { json } => cmd_resume(json).await,
    }
}

/// Friendly English text for backend/sidecar error codes — the same map the
/// card renders through i18n. Unknown codes fall through verbatim so nothing
/// is swallowed.
fn share_error_text(code: &str) -> String {
    let prog = term::program_name();
    let bare = code.trim();
    let text = match bare {
        "share_offline" => "share node is offline",
        "budget_exhausted" => "share budget exhausted",
        "lane_exhausted" => "lane budget exhausted",
        "lane_closed" => "lane is outside its open hours",
        "lane_suspended" => "lane paused by the owner",
        "share_not_found" => {
            return format!("no share with that id — list online ids with '{} share dir'", prog)
        }
        "lane_required" | "lane_not_found" => {
            return format!("this share needs a lane — pick one from '{} share dir'", prog)
        }
        "no_claim_slots" => "no claim slots left on this share",
        "rate_limited" => "rate limited — try again shortly",
        "identity_required" | "participant_not_registered" | "invalid_signature" => {
            return format!("league identity missing or not accepted — run '{} init' and sync once", prog)
        }
        "share_not_active" => "share paused by the owner",
        "too_many_active_claims" => {
            return format!("too many active claims — release one first ('{} share claims')", prog)
        }
        "no_api_base" => {
            return format!("no API base configured — set it with '{} config set apiBaseUrl <url>'", prog)
        }
        "not_registered" => "no share identity on this machine (owner commands need a registered CPA share)",
        other => other,
    };
    if bare.starts_with("claim_not_found") {
        return format!("no local claim matches that keyId — run '{} share claims'", prog);
    }
    if let Some(detail) = bare.strip_prefix("backend_unreachable:") {
        return format!(
            "backend unreachable ({}) — check your network, or the API base with '{} config get apiBaseUrl'",
            detail, prog
        );
    }
    text.to_string()
}

fn map_error(error: String) -> CliError {
    // busy must reach the boundary un-wrapped so classify_busy maps it to exit 3
    if collector_core::store_lock::is_busy_error(&error) {
        return CliError::Message(error);
    }
    if error == "not initialized" {
        return CliError::NotInitialized;
    }
    if error.contains("is not installed") {
        return CliError::Message(format!(
            "{}\nInstall it first:  {} plugin install {}",
            error,
            term::program_name(),
            PLUGIN_ID
        ));
    }
    // exit-code semantics (cli-dev-standard §4 / the CLI's documented table):
    // transport failures are retryable network errors (12), everything else
    // is a business failure (1)
    if error.starts_with("backend_unreachable") {
        return CliError::Network(share_error_text(&error));
    }
    let text = share_error_text(&error);
    // skip the code suffix when the rendered text already IS that code —
    // "share_not_found (code: share_not_found)" says the same thing twice
    if text == error {
        CliError::Message(text)
    } else {
        CliError::Message(format!("{} (code: {})", text, error))
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ── directory ───────────────────────────────────────────────────────────────

async fn cmd_dir(family: Option<&str>, json_out: bool) -> Result<(), CliError> {
    let data = sidecar_call(&format!("{}:directory", PLUGIN_ID), json!({})).await.map_err(map_error)?;
    let filtered = match family {
        Some(filter) if !filter.trim().is_empty() => {
            let mut data = data;
            let shares = data["shares"].as_array().cloned().unwrap_or_default();
            let kept: Vec<Value> = shares
                .into_iter()
                .filter(|share| (share["lanes"].as_array().cloned().unwrap_or_default())
                    .iter()
                    .any(|lane| lane_matches_family(lane, filter.trim())))
                .collect();
            data["shares"] = Value::Array(kept);
            data
        }
        _ => data,
    };
    if json_out {
        crate::cli::print_json_out(filtered, false);
        return Ok(());
    }
    print!("{}", render_directory(&filtered));
    Ok(())
}

// Tier/claimable semantics mirror the card's M1 ranking so both surfaces
// order nodes identically: T1 claimable / T2 waiting / T3 the rest.
fn lane_claimable(lane: &Value) -> bool {
    lane["state"].as_str() != Some("suspended")
        && lane["open"].as_bool().unwrap_or(false)
        && !lane["exhausted"].as_bool().unwrap_or(false)
        && lane["slotsLeft"].as_i64().unwrap_or(0) > 0
        && lane["availableTokens"]
            .as_i64()
            .or_else(|| lane["budgetTokens"].as_i64())
            .unwrap_or(1)
            > 0
}

fn lane_waiting(lane: &Value) -> bool {
    lane["state"].as_str() != Some("suspended")
        && !lane["open"].as_bool().unwrap_or(false)
        && lane["slotsLeft"].as_i64().unwrap_or(0) > 0
        && !lane["exhausted"].as_bool().unwrap_or(false)
}

fn share_tier(share: &Value) -> i8 {
    let lanes = share["lanes"].as_array().cloned().unwrap_or_default();
    if !lanes.is_empty() {
        if lanes.iter().any(|lane| lane_claimable(&lane)) {
            return 1;
        }
        if lanes.iter().any(|lane| lane_waiting(&lane)) {
            return 2;
        }
        return 3;
    }
    if share["state"].as_str() == Some("active")
        && share["slotsLeft"].as_i64().unwrap_or(0) > 0
        && !share["exhausted"].as_bool().unwrap_or(false)
    {
        return 1;
    }
    if share["state"].as_str() == Some("active") {
        return 2;
    }
    3
}

fn remaining_ratio(share: &Value) -> f64 {
    let ratio = |budget: i64, available: i64| {
        if budget > 0 {
            (available.max(0) as f64 / budget as f64).min(1.0)
        } else {
            0.0
        }
    };
    let lanes = share["lanes"].as_array().cloned().unwrap_or_default();
    if !lanes.is_empty() {
        lanes
            .iter()
            .map(|lane| {
                ratio(
                    lane["budgetTokens"].as_i64().unwrap_or(0),
                    lane["availableTokens"].as_i64().unwrap_or(lane["budgetTokens"].as_i64().unwrap_or(0)),
                )
            })
            .fold(0.0_f64, f64::max)
    } else {
        ratio(
            share["budgetTokens"].as_i64().unwrap_or(0),
            share["availableTokens"].as_i64().unwrap_or(share["budgetTokens"].as_i64().unwrap_or(0)),
        )
    }
}

fn heartbeat_age(share: &Value, now: i64) -> i64 {
    now - share["plugin"]["lastHeartbeatAt"].as_i64().unwrap_or(0)
}

fn lane_matches_family(lane: &Value, family: &str) -> bool {
    lane["models"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|m| m.as_str().map(|s| s.to_string()))
        .any(|model| {
            if model == family {
                return true;
            }
            let lane_prefix = model.strip_suffix('*');
            let family_prefix = family.strip_suffix('*');
            lane_prefix.map_or(false, |p| family.starts_with(p))
                || family_prefix.map_or(false, |p| model.starts_with(p))
        })
}

/// "daily" / "weekly" / "hourly" / "every N days" — window spec text.
fn window_text(window: &Value) -> String {
    let unit = window["unit"].as_str().unwrap_or("day");
    let n = window["n"].as_i64().unwrap_or(1).max(1);
    let plural = match unit {
        "hour" => "hours",
        "week" => "weeks",
        _ => "days",
    };
    match (unit, n) {
        ("day", 1) => "daily".to_string(),
        ("week", 1) => "weekly".to_string(),
        ("hour", 1) => "hourly".to_string(),
        (_, 1) => unit.to_string(),
        _ => format!("every {} {}", n, plural),
    }
}

fn schedule_text(lane: &Value) -> String {
    let windows = lane["schedule"].as_array().cloned().unwrap_or_default();
    if windows.is_empty() {
        "all day".to_string()
    } else {
        windows
            .iter()
            .map(|w| format!("{}-{}", w["start"].as_str().unwrap_or("?"), w["end"].as_str().unwrap_or("?")))
            .collect::<Vec<_>>()
            .join(",")
    }
}

fn lane_status_text(lane: &Value, now: i64) -> String {
    if lane["state"].as_str() == Some("suspended") {
        return "paused".to_string();
    }
    if !lane["open"].as_bool().unwrap_or(false) {
        let retry = now + lane["retryAfterMs"].as_i64().unwrap_or(0);
        return format!("closed until {}", term::clock_text(retry));
    }
    if lane["exhausted"].as_bool().unwrap_or(false) {
        let resets = term::clock_text(lane["windowEndsAtMs"].as_i64().unwrap_or(now));
        return format!("exhausted, resets {}", resets);
    }
    "open".to_string()
}

fn share_status_text(share: &Value) -> &'static str {
    if !share["online"].as_bool().unwrap_or(false) {
        "offline"
    } else if share["state"].as_str() != Some("active") {
        "paused"
    } else {
        "online"
    }
}

fn short_id(id: &str) -> String {
    if id.chars().count() > 10 {
        id.chars().take(8).collect()
    } else {
        id.to_string()
    }
}

fn render_directory(data: &Value) -> String {
    let now = now_ms();
    let all = data["shares"].as_array().cloned().unwrap_or_default();
    let online: Vec<&Value> = all.iter().filter(|s| s["online"].as_bool().unwrap_or(false)).collect();
    let mut out = if online.is_empty() {
        return "Share directory — no online nodes.\nStart one on a machine with CPA: scripts/install-cpa-plugin.sh\n".to_string();
    } else {
        format!("Share directory — {} online node(s)\n", online.len())
    };
    let mut ranked: Vec<&&Value> = online.iter().collect();
    ranked.sort_by(|a, b| {
        share_tier(a)
            .cmp(&share_tier(b))
            .then(remaining_ratio(b).partial_cmp(&remaining_ratio(a)).unwrap_or(std::cmp::Ordering::Equal))
            .then(heartbeat_age(a, now).cmp(&heartbeat_age(b, now)))
            .then(
                a["title"].as_str().unwrap_or("").cmp(b["title"].as_str().unwrap_or("")),
            )
    });
    for share in ranked {
        let tier = share_tier(share);
        let tier_label = match tier {
            1 => "claimable",
            2 => "waiting",
            _ => "full/paused",
        };
        out.push_str(&format!(
            "  {} [{}] {} ({})\n",
            share["title"].as_str().unwrap_or("(unnamed)"),
            short_id(share["shareId"].as_str().unwrap_or("")),
            share_status_text(share),
            tier_label
        ));
        let lanes = share["lanes"].as_array().cloned().unwrap_or_default();
        if lanes.is_empty() {
            let slots = share["slotsLeft"].as_i64().unwrap_or(0);
            out.push_str(&format!(
                "    · (single lane)  slots {}  {}\n",
                if slots > 0 { slots.to_string() } else { "full".to_string() },
                if share["exhausted"].as_bool().unwrap_or(false) { "exhausted".to_string() } else { "open".to_string() }
            ));
            continue;
        }
        for lane in &lanes {
            let used = lane["settledTokens"].as_i64().unwrap_or(0);
            let total = lane["budgetTokens"].as_i64().unwrap_or(0);
            out.push_str(&format!(
                "    · {:<18} {:<14} {:>9}/{:<9} slots {}/{}  {}\n",
                lane["title"].as_str().unwrap_or("(lane)"),
                lane["models"].as_array().cloned().unwrap_or_default()
                    .iter()
                    .filter_map(|m| m.as_str())
                    .collect::<Vec<_>>()
                    .join(","),
                format_tokens_compact(used),
                format_tokens_compact(total),
                lane["slotsLeft"].as_i64().unwrap_or(0),
                lane["maxClaims"].as_i64().unwrap_or(0),
                format!("{} · {}", lane_status_text(lane, now), schedule_text(lane))
            ));
        }
    }
    out.push_str(&format!(
        "Claim one:  {} share claim <shareId> [laneId]\n",
        term::program_name()
    ));
    out
}

// ── my claims ───────────────────────────────────────────────────────────────

async fn cmd_claims(json_out: bool) -> Result<(), CliError> {
    let store = sidecar_call(&format!("{}:borrow-get", PLUGIN_ID), json!({})).await.map_err(map_error)?;
    let claims = store["claims"].as_array().cloned().unwrap_or_default();
    let live = sidecar_call(&format!("{}:live", PLUGIN_ID), json!({}))
        .await
        .ok()
        .filter(|data| data.get("claims").and_then(|v| v.as_array()).is_some());
    let merged = merge_claims(&claims, live.as_ref(), now_ms());
    if json_out {
        crate::cli::print_json_out(json!({ "claims": merged }), false);
        return Ok(());
    }
    print!("{}", render_claims(&merged));
    Ok(())
}

/// Stored claims + live backend state, same merge rule as the card: live
/// state wins; without it expiry decides (expiresAt in the past → expired).
fn merge_claims(claims: &[Value], live: Option<&Value>, now: i64) -> Vec<Value> {
    let live_by_id: std::collections::HashMap<String, Value> = live
        .and_then(|data| data["claims"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            match entry.get("keyId").and_then(|v| v.as_str()).map(|id| id.to_string()) {
                Some(id) => Some((id, entry)),
                None => None,
            }
        })
        .collect();
    claims
        .iter()
        .map(|claim| {
            let mut merged = claim.clone();
            let key_id = claim["keyId"].as_str().unwrap_or("").to_string();
            match live_by_id.get(&key_id) {
                Some(entry) => {
                    if let Some(state) = entry.get("state").and_then(|v| v.as_str()) {
                        merged["state"] = json!(state);
                    }
                    merged["usedTokens"] = entry.get("usedTokens").cloned().unwrap_or(json!(0));
                }
                None => {
                    let expires_at = claim["expiresAt"].as_i64().unwrap_or(0);
                    let state = if expires_at > 0 && expires_at <= now { "expired" } else { "valid" };
                    merged["state"] = json!(state);
                    merged["usedTokens"] = json!(0);
                }
            }
            merged
        })
        .collect()
}

fn render_claims(claims: &[Value]) -> String {
    if claims.is_empty() {
        return format!("No claims yet. Browse the directory:  {} share dir\n", term::program_name());
    }
    let mut out = format!("My claims — {}\n", claims.len());
    for claim in claims {
        let state = claim["state"].as_str().unwrap_or("valid");
        out.push_str(&format!(
            "  {}  {}  {}  expires {}  used {}\n",
            claim["shareTitle"].as_str().unwrap_or(&claim["shareId"].as_str().unwrap_or("").to_string()),
            term::mask_token(claim["keyId"].as_str().unwrap_or("")),
            state,
            term::format_local_datetime(claim["expiresAt"].as_i64().unwrap_or(0)),
            format_tokens_compact(claim["usedTokens"].as_i64().unwrap_or(0))
        ));
        if state == "valid" {
            for line in term::export_lines(
                claim["baseURL"].as_str().unwrap_or(""),
                claim["token"].as_str().unwrap_or(""),
            ) {
                out.push_str(&format!("    {}\n", line));
            }
        }
    }
    let prog = term::program_name();
    out.push_str(&format!("Test one:    {} share test <keyId>\n", prog));
    out.push_str(&format!("Release it:  {} share revoke <keyId>\n", prog));
    out
}

// ── claim / renew / revoke / test ───────────────────────────────────────────

async fn cmd_claim(share_id: &str, lane_id: Option<&str>, json_out: bool) -> Result<(), CliError> {
    let mut args = json!({ "shareId": share_id });
    if let Some(lane) = lane_id.filter(|s| !s.trim().is_empty()) {
        args["laneId"] = json!(lane.trim());
    }
    let data = sidecar_call(&format!("{}:claim", PLUGIN_ID), args).await.map_err(map_error)?;
    if json_out {
        crate::cli::print_json_out(data, true);
        return Ok(());
    }
    let lane_title = data.get("laneTitle").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
    println!(
        "Claimed {}{} (keyId {})",
        data["shareTitle"].as_str().unwrap_or(share_id),
        lane_title.map(|t| format!(" / {}", t)).unwrap_or_default(),
        data["keyId"].as_str().unwrap_or("?")
    );
    println!(
        "  expires {}",
        term::format_local_datetime(data["expiresAt"].as_i64().unwrap_or(0))
    );
    for line in term::export_lines(
        data["baseURL"].as_str().unwrap_or(""),
        data["token"].as_str().unwrap_or(""),
    ) {
        println!("{}", line);
    }
    println!("Verify:  {} share test {}", term::program_name(), data["keyId"].as_str().unwrap_or("?"));
    Ok(())
}

async fn cmd_renew(key_id: &str, json_out: bool) -> Result<(), CliError> {
    let data = sidecar_call(&format!("{}:renew", PLUGIN_ID), json!({ "keyId": key_id }))
        .await
        .map_err(map_error)?;
    if json_out {
        crate::cli::print_json_out(data, true);
        return Ok(());
    }
    println!(
        "Renewed {} — expires {} (same key, reaches the owner on its next heartbeat)",
        data["keyId"].as_str().unwrap_or(key_id),
        term::format_local_datetime(data["expiresAt"].as_i64().unwrap_or(0))
    );
    Ok(())
}

async fn cmd_revoke(key_id: &str, json_out: bool) -> Result<(), CliError> {
    let data = sidecar_call(&format!("{}:revoke", PLUGIN_ID), json!({ "keyId": key_id }))
        .await
        .map_err(map_error)?;
    if json_out {
        crate::cli::print_json_out(data, true);
        return Ok(());
    }
    println!("Revoked claim {} — the slot is free for others", data["keyId"].as_str().unwrap_or(key_id));
    Ok(())
}

async fn cmd_test(key_id: &str, model: Option<&str>, json_out: bool) -> Result<(), CliError> {
    let store = sidecar_call(&format!("{}:borrow-get", PLUGIN_ID), json!({})).await.map_err(map_error)?;
    let claim = store["claims"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .find(|entry| entry["keyId"].as_str() == Some(key_id))
        .ok_or_else(|| CliError::Message(format!("no local claim matches that keyId — run '{} share claims'", term::program_name())))?;
    // model default mirrors the card: the lane's exact model; wildcards need
    // a real name
    let exact_model = claim["models"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|m| m.as_str().map(|s| s.to_string()))
        .find(|m| !m.contains('*'));
    let model = model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .or(exact_model)
        .ok_or_else(|| {
            let wildcards: Vec<String> = claim["models"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|m| m.as_str().map(|s| s.to_string()))
                .filter(|m| m.contains('*'))
                .collect();
            CliError::Message(format!(
                "this lane only lists wildcard models{} — pass a concrete name with --model <name>",
                if wildcards.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", wildcards.join(", "))
                }
            ))
        })?;
    let result = sidecar_call(
        &format!("{}:borrow-test", PLUGIN_ID),
        json!({ "token": claim["token"], "baseURL": claim["baseURL"], "model": model }),
    )
    .await
    .map_err(map_error)?;
    if json_out {
        crate::cli::print_json_out(result, false);
        return Ok(());
    }
    if result["ok"].as_bool().unwrap_or(false) {
        println!("OK — model {} answered through the shared endpoint ({})", model, result["status"]);
    } else {
        // ride the unified error path so --json mode gets the structured doc
        return Err(CliError::Message(format!(
            "endpoint test failed — HTTP {} {}",
            result["status"].as_i64().unwrap_or(0),
            result["error"].as_str().unwrap_or("")
        )));
    }
    Ok(())
}

// ── owner console ───────────────────────────────────────────────────────────

async fn cmd_owner(json_out: bool) -> Result<(), CliError> {
    let data = sidecar_call(&format!("{}:owner-status", PLUGIN_ID), json!({})).await.map_err(map_error)?;
    if json_out {
        crate::cli::print_json_out(data, false);
        return Ok(());
    }
    print!("{}", render_owner(&data));
    Ok(())
}

fn render_owner(data: &Value) -> String {
    let share = &data["share"];
    let share_id = share["shareId"].as_str().unwrap_or("");
    if share_id.is_empty() {
        return "No share registered on this machine.\nStart sharing: install the CPA plugin (scripts/install-cpa-plugin.sh)\n".to_string();
    }
    let now = now_ms();
    let mut out = format!(
        "Owner console — {} [{}]\n",
        share["title"].as_str().unwrap_or(share_id),
        short_id(share_id)
    );
    if share["state"].as_str() == Some("stopped") {
        out.push_str(&format!(
            "  state: stopped · lifetime settled {}\n",
            format_tokens_compact(share["lifetimeSettled"].as_i64().unwrap_or(0))
        ));
        out.push_str(&format!("  reopen with:  {} share resume\n", term::program_name()));
        return out;
    }
    let plugin = &share["plugin"];
    let plugin_online = plugin["online"].as_bool().unwrap_or(false);
    out.push_str(&format!(
        "  state: {} · plugin {}{}\n",
        share["state"].as_str().unwrap_or("active"),
        if plugin_online { "online" } else { "offline" },
        if plugin_online { String::new() } else { offline_reason(data) }
    ));
    out.push_str(&format!(
        "  lifetime settled: {}\n",
        format_tokens_compact(share["lifetimeSettled"].as_i64().unwrap_or(0))
    ));
    let lanes = share["lanes"].as_array().cloned().unwrap_or_default();
    out.push_str(&format!("  lanes ({}):\n", lanes.len()));
    for lane in &lanes {
        out.push_str(&format!(
            "    · {:<18} {:<14} {:>9}/{:<9} slots {}/{}  {} · {} ({})\n",
            lane["title"].as_str().unwrap_or("(lane)"),
            lane["models"].as_array().cloned().unwrap_or_default()
                .iter()
                .filter_map(|m| m.as_str())
                .collect::<Vec<_>>()
                .join(","),
            format_tokens_compact(lane["settledTokens"].as_i64().unwrap_or(0)),
            format_tokens_compact(lane["budgetTokens"].as_i64().unwrap_or(0)),
            lane["maxClaims"].as_i64().unwrap_or(0) - lane["slotsLeft"].as_i64().unwrap_or(0),
            lane["maxClaims"].as_i64().unwrap_or(0),
            lane_status_text(lane, now),
            schedule_text(lane),
            window_text(&lane["window"])
        ));
    }
    if let Some(warning) = data.pointer("/pluginStatus/endpointWarning").and_then(|v| v.as_str()) {
        out.push_str(&format!("  ⚠ endpoint: {}\n", warning));
    }
    if let Some(error) = data.pointer("/pluginStatus/lastError").and_then(|v| v.as_str()) {
        out.push_str(&format!("  ⚠ plugin last error: {}\n", error));
    }
    let claims = data["claims"].as_array().cloned().unwrap_or_default();
    if claims.is_empty() {
        out.push_str("  claims: none yet\n");
    } else {
        out.push_str(&format!("  claims ({}):\n", claims.len()));
        for claim in &claims {
            out.push_str(&format!(
                "    · {:<16} {}  {}  {}\n",
                claim["borrower"].as_str().or(claim["displayId"].as_str()).unwrap_or("(unknown)"),
                term::mask_token(claim["keyId"].as_str().unwrap_or("")),
                format_tokens_compact(claim["usedTokens"].as_i64().unwrap_or(0)),
                claim["state"].as_str().unwrap_or("?")
            ));
        }
    }
    out
}

fn offline_reason(data: &Value) -> String {
    data.pointer("/pluginStatus/lastError")
        .and_then(|v| v.as_str())
        .map(|reason| format!(" ({})", reason))
        .unwrap_or_default()
}

// ── suggestions / stop / resume ─────────────────────────────────────────────

async fn cmd_suggest(json_out: bool) -> Result<(), CliError> {
    let data = sidecar_call(&format!("{}:owner-suggest", PLUGIN_ID), json!({})).await.map_err(map_error)?;
    if json_out {
        crate::cli::print_json_out(data, false);
        return Ok(());
    }
    print!("{}", render_suggest(&data, reserve_pct()));
    Ok(())
}

/// Card-side reserve ratio knob, read from the same module config the card
/// persists (default 25, clamped like the card's editor).
fn reserve_pct() -> i64 {
    let state = modules::load_modules_state();
    let reserve = state
        .pointer(&format!("/modules/{}/config/reservePct", PLUGIN_ID))
        .and_then(|v| v.as_i64());
    reserve.unwrap_or(25).clamp(5, 95)
}

fn render_suggest(data: &Value, reserve_pct: i64) -> String {
    let families = data["families"].as_array().cloned().unwrap_or_default();
    let zhipu = data["zhipu"]["results"].as_array().cloned().unwrap_or_default();
    if families.is_empty() && zhipu.is_empty() {
        return "No lane suggestions yet — share usage data builds them (owner-suggest reads your own CPA usage).\n".to_string();
    }
    let mut out = format!("Lane suggestions (reserve {}%)\n", reserve_pct);
    for family in &families {
        let weekly = family["weeklyTokens"].as_i64().unwrap_or(0);
        let budget = ((weekly as f64) * (1.0 - reserve_pct as f64 / 100.0)).round() as i64;
        let schedule = family["busy"]
            .as_object()
            .map(|busy| format!(
                "busy {}-{} → share {}-{}",
                busy.get("start").and_then(|v| v.as_str()).unwrap_or("?"),
                busy.get("end").and_then(|v| v.as_str()).unwrap_or("?"),
                busy.get("end").and_then(|v| v.as_str()).unwrap_or("?"),
                busy.get("start").and_then(|v| v.as_str()).unwrap_or("?")
            ))
            .unwrap_or_else(|| "flat usage — share all day".to_string());
        out.push_str(&format!(
            "  · {:<14} weekly {:>9}  {}  budget ≤{}\n",
            family["family"].as_str().unwrap_or("?"),
            format_tokens_compact(weekly),
            schedule,
            format_tokens_compact(budget.max(1000))
        ));
    }
    if !zhipu.is_empty() {
        let parts: Vec<String> = zhipu
            .iter()
            .filter_map(|result| {
                let label = result.get("label").and_then(|v| v.as_str()).unwrap_or("?");
                let pct = result.pointer("/quota/windows/0/pct").cloned().unwrap_or(Value::Null);
                Some(format!("{} {}%", label, pct))
            })
            .collect();
        out.push_str(&format!("  · zhipu windows: {}\n", parts.join(" · ")));
    }
    out.push_str("Create lanes in the desktop app (lane editor) — suggestions are pre-fills, not auto-applied.\n");
    out
}

async fn cmd_stop(yes: bool, json_out: bool) -> Result<(), CliError> {
    if !yes {
        return Err(CliError::Message(
            "stopping sharing revokes every borrower key on this share — pass --yes to confirm".into(),
        ));
    }
    let data = sidecar_call(&format!("{}:owner-unregister", PLUGIN_ID), json!({}))
        .await
        .map_err(map_error)?;
    if json_out {
        crate::cli::print_json_out(data, true);
        return Ok(());
    }
    println!("Sharing stopped — all borrower keys revoked (record kept; resume with '{} share resume')", term::program_name());
    Ok(())
}

async fn cmd_resume(json_out: bool) -> Result<(), CliError> {
    let data = sidecar_call(&format!("{}:owner-resume", PLUGIN_ID), json!({}))
        .await
        .map_err(map_error)?;
    if json_out {
        crate::cli::print_json_out(data, true);
        return Ok(());
    }
    println!("Share {} active again — service resumes on the plugin's next heartbeat", data["shareId"].as_str().unwrap_or("?"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lane(id: &str, title: &str, models: &[&str], open: bool, exhausted: bool, slots: i64) -> Value {
        json!({
            "id": id, "title": title,
            "models": models,
            "open": open, "exhausted": exhausted,
            "slotsLeft": slots, "maxClaims": 2,
            "state": "active",
            "budgetTokens": 10_000_000, "settledTokens": 1_000_000, "availableTokens": 9_000_000,
            "window": { "unit": "week", "n": 1 },
            "schedule": [{ "start": "08:00", "end": "23:00" }],
        })
    }

    fn share(id: &str, title: &str, online: bool, lanes: Vec<Value>) -> Value {
        json!({
            "shareId": id, "title": title, "online": online, "state": "active",
            "lanes": lanes,
            "plugin": { "lastHeartbeatAt": now_ms() },
        })
    }

    #[test]
    fn tiers_match_card_semantics() {
        let claimable = lane("a", "open lane", &["gemini-*"], true, false, 1);
        let waiting = lane("b", "closed lane", &["glm-*"], false, false, 1);
        let full = lane("c", "full lane", &["gpt-*"], true, false, 0);
        assert!(lane_claimable(&claimable));
        assert!(!lane_claimable(&waiting) && lane_waiting(&waiting));
        assert!(!lane_claimable(&full) && !lane_waiting(&full));
        assert_eq!(share_tier(&share("s1", "one", true, vec![claimable])), 1);
        assert_eq!(share_tier(&share("s2", "two", true, vec![waiting.clone()])), 2);
        assert_eq!(share_tier(&share("s3", "three", true, vec![full])), 3);
        // card formula: lane-less shares bucket by state — active waits, paused is T3
        assert_eq!(share_tier(&share("s4", "four", true, vec![])), 2);
        let mut paused = share("s5", "five", true, vec![]);
        paused["state"] = json!("paused");
        assert_eq!(share_tier(&paused), 3);
    }

    #[test]
    fn family_matching_handles_prefixes_both_ways() {
        let wildcard_lane = lane("a", "l", &["gemini-*"], true, false, 1);
        assert!(lane_matches_family(&wildcard_lane, "gemini-*"));
        assert!(lane_matches_family(&wildcard_lane, "gemini-3.8-flash-high"));
        let exact = lane("b", "l", &["glm-5.3"], true, false, 1);
        assert!(lane_matches_family(&exact, "glm-*"));
        assert!(!lane_matches_family(&exact, "gemini-*"));
    }

    #[test]
    fn window_and_schedule_text() {
        assert_eq!(window_text(&json!({ "unit": "day", "n": 1 })), "daily");
        assert_eq!(window_text(&json!({ "unit": "week", "n": 1 })), "weekly");
        assert_eq!(window_text(&json!({ "unit": "hour", "n": 1 })), "hourly");
        assert_eq!(window_text(&json!({ "unit": "week", "n": 2 })), "every 2 weeks");
        let l = lane("a", "l", &["m"], true, false, 1);
        assert_eq!(schedule_text(&l), "08:00-23:00");
        assert_eq!(schedule_text(&json!({})), "all day");
    }

    #[test]
    fn directory_render_lists_tiers_and_lane_rows() {
        let claimable = lane("a", "gem lane", &["gemini-*"], true, false, 1);
        let data = json!({ "shares": [
            share("shr_full", "full-node", true, vec![lane("c", "full", &["gpt-*"], true, false, 0)]),
            share("shr_ok", "ok-node", true, vec![claimable]),
            share("shr_off", "off-node", false, vec![]),
        ]});
        let text = render_directory(&data);
        let ok_pos = text.find("ok-node").expect("claimable node present");
        let full_pos = text.find("full-node").expect("full node present");
        assert!(ok_pos < full_pos, "claimable sorts first:\n{}", text);
        assert!(text.contains("2 online node(s)"));
        assert!(!text.contains("off-node"));
        assert!(text.contains("gem lane"));
        assert!(text.contains("open · 08:00-23:00"));
        assert!(text.contains("1M/10M"));
    }

    #[test]
    fn claims_render_merges_live_state_and_exports_tokens() {
        let now = now_ms();
        let stored = vec![json!({
            "keyId": "csk_live", "token": "atl_sk_live", "baseURL": "http://cpa:8317",
            "shareId": "s1", "shareTitle": "ok-node", "models": ["gemini-3.8-flash-high"],
            "expiresAt": now + 3_600_000
        })];
        let live = json!({ "claims": [
            { "keyId": "csk_live", "state": "valid", "usedTokens": 123456 }
        ]});
        let merged = merge_claims(&stored, Some(&live), now);
        assert_eq!(merged[0]["state"], "valid");
        assert_eq!(merged[0]["usedTokens"], 123456);
        let text = render_claims(&merged);
        assert!(text.contains("My claims — 1"));
        assert!(text.contains("export OPENAI_BASE_URL=http://cpa:8317/v1"));
        assert!(text.contains("export ANTHROPIC_AUTH_TOKEN=atl_sk_live"));

        // no live view → expiry decides
        let expired = merge_claims(
            &[json!({
                "keyId": "csk_old", "token": "t", "baseURL": "http://x", "shareId": "s", "shareTitle": "old",
                "models": [], "expiresAt": now - 1
            })],
            None,
            now,
        );
        assert_eq!(expired[0]["state"], "expired");
        assert!(!render_claims(&expired).contains("export OPENAI"));
    }

    #[test]
    fn owner_render_covers_stopped_and_active() {
        let stopped = json!({ "share": { "shareId": "shr_1", "title": "n", "state": "stopped", "lifetimeSettled": 5 } });
        let text = render_owner(&stopped);
        assert!(text.contains("state: stopped"));
        assert!(text.contains("share resume"));

        let active = json!({
            "share": {
                "shareId": "shr_2", "title": "sky-cpa", "state": "active", "lifetimeSettled": 123_000_000,
                "plugin": { "online": false },
                "lanes": [lane("a", "gem lane", &["gemini-*"], true, false, 1)],
            },
            "pluginStatus": { "lastError": "dial tcp refused", "endpointWarning": "LAN base + loopback bind" },
            "claims": [ { "borrower": "alice", "keyId": "csk_x1234567890", "usedTokens": 100, "state": "valid" } ]
        });
        let text = render_owner(&active);
        assert!(text.contains("plugin offline (dial tcp refused)"));
        assert!(text.contains("⚠ endpoint: LAN base + loopback bind"));
        assert!(text.contains("alice"));
        assert!(text.contains("weekly"));
    }

    #[test]
    fn suggest_render_derives_budget_from_reserve() {
        let data = json!({
            "families": [
                { "family": "gemini-*", "weeklyTokens": 1_000_000_000, "busy": { "start": "15:00", "end": "21:00" } }
            ],
            "zhipu": { "results": [ { "label": "main", "quota": { "windows": [ { "pct": 55 } ] } } ] }
        });
        let text = render_suggest(&data, 25);
        assert!(text.contains("reserve 25%"));
        assert!(text.contains("gemini-*"));
        assert!(text.contains("busy 15:00-21:00 → share 21:00-15:00"));
        assert!(text.contains("budget ≤750M"));
        assert!(text.contains("main 55%"));
        // 95% reserve shrinks the budget accordingly
        assert!(render_suggest(&data, 95).contains("budget ≤50M"));
    }

    #[test]
    fn error_text_maps_codes_and_prefixes() {
        assert!(share_error_text("lane_closed").contains("open hours"));
        assert!(share_error_text("claim_not_found:csk_1").contains("share claims"));
        assert!(share_error_text("backend_unreachable:timeout").starts_with("backend unreachable"));
        assert_eq!(share_error_text("weird_new_code"), "weird_new_code");
    }
}
