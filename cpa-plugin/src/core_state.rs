// Pure decision + accounting core for the atl-share CPA plugin.
//
// Everything here is side-effect free (except the &mut Runtime state handed
// in by lib.rs) so the fail-closed semantics are unit-testable without CPA.

use std::collections::HashMap;

/// Deny-borrowing threshold: no successful backend heartbeat for this long =>
/// stop authenticating temp keys entirely (fail-closed; 10 minutes covers a
/// couple of missed 8s ticks plus backend restart headroom).
pub const BACKEND_STALE_MS: i64 = 600_000;

/// Contract constant: token format minted by the ATL backend (`atl_sk_*`).
#[allow(dead_code)]
pub const TOKEN_PREFIX: &str = "atl_sk_";

#[derive(Clone, Debug, PartialEq)]
pub struct KeyEntry {
    pub key_id: String,
    pub token: String,
    pub key_max_tokens: u64,
    pub expires_at_ms: i64,
    /// Lane binding (lanes design): the claim's lane — gates resolve
    /// key→lane because the intercept ABI carries no request model.
    pub lane_id: String,
}

/// Local-time window as minute-of-day marks; end may wrap past midnight.
#[derive(Clone, Debug, PartialEq)]
pub struct WindowMark {
    pub start_m: u32,
    pub end_m: u32,
}

/// One sharing lane: budget period + schedule + peak multiplier, synced from
/// the backend heartbeat. All fields degrade deny-safe (unknown/missing =>
/// closed or unbudgeted-but-scheduled).
#[derive(Clone, Debug, Default)]
pub struct LaneEntry {
    pub id: String,
    pub state: String,
    /// Model scope (exact ids + `*` wildcards); empty = every model.
    pub models: Vec<String>,
    pub budget_tokens: u64,
    /// Budget window spec (R50): hour windows self-roll on an n-hour grid;
    /// day/week self-roll on the owner-tz grid (QA-03); the heartbeat
    /// window_key remains the deny-safe fallback for restore comparisons.
    pub window_unit: String, // hour | day | week
    pub window_n: u32,
    pub window_key: String,
    #[allow(dead_code)]
    pub window_end_ms: i64,
    /// Baseline settled tokens for window_key (backend-authoritative).
    pub settled_tokens: u64,
    pub schedule_windows: Vec<WindowMark>,
    pub peak_windows: Vec<WindowMark>,
    pub peak_multiplier: u64,
}

/// Local per-lane accumulation — same confirmed+un_acked algebra as
/// KeyWindowCharge (R2-03/R2-04): `settled = confirmed + un_acked`.
#[derive(Clone, Debug, Default)]
pub struct LaneLedger {
    pub window_key: String,
    pub confirmed: u64,
    pub settled: u64,
}

/// Per-key charged total within the key's lane window (D1/CS-06): the key cap
/// follows the LANE window grid, not the legacy share day grid.
#[derive(Clone, Debug, Default)]
pub struct KeyWindowCharge {
    pub window_key: String,
    pub confirmed: u64,
    pub charged: u64,
}

/// One pending usage bucket (protocol 2): usage accumulates per
/// (key, lane window, peak multiplier) so the heartbeat can charge each
/// bucket into its own event-time window. `seq` is the batch number stamped
/// at drain time; 0 = never sent (still merging locally).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct UsageBucket {
    pub key_id: String,
    pub lane_id: String,
    pub window_key: String,
    pub multiplier: u64,
    pub raw_tokens: u64,
    pub charged_tokens: u64,
    pub requests: u64,
    pub failed: u64,
    pub seq: u64,
}

/// Snapshot of the authoritative backend state, replaced wholesale by each
/// successful heartbeat.
#[derive(Clone, Debug, Default)]
pub struct SyncState {
    /// "active" | anything else => borrowing paused.
    pub state: String,
    pub window_day: String,
    pub budget: u64,
    pub key_concurrency: u32,
    pub keys: Vec<KeyEntry>,
    /// Empty = pre-lanes backend: the legacy flat-budget gate applies.
    pub lanes: Vec<LaneEntry>,
    /// ms of the last successful heartbeat; 0 = never synced.
    pub last_sync_ms: i64,
    pub configured: bool,
    /// Policy revision of the last applied heartbeat response (CS-06): the
    /// plugin acks it on the next beat so the owner card can distinguish
    /// "backend accepted" from "node applied".
    pub policy_rev: u64,
    /// Owner-machine timezone (minutes east of UTC) the plugin itself
    /// reports — day/week grids must self-roll with the SAME anchor the
    /// backend uses (QA-03).
    pub tz_offset_minutes: i64,
    /// Usage protocol the backend speaks: 2 = seq'd buckets + keyLedger,
    /// 1 = legacy (no protocol field in the response). The restore path in
    /// sync.rs branches on the RESPONSE protocol; this mirror is kept for
    /// diagnostics and future gating (QA-04).
    #[allow(dead_code)]
    pub protocol: u8,
}

#[derive(Debug, PartialEq)]
pub enum AuthDecision {
    Allow { principal: String, key_id: String },
    NotHandled,
}

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct UsageDelta {
    pub key_id: String,
    pub tokens: u64,
    pub requests: u64,
    pub failed: u64,
}

/// Local mirror of backend accounting (settled comes back in heartbeat
/// responses, so a plugin/CPA restart restores it exactly).
#[derive(Clone, Debug, Default)]
pub struct Ledger {
    pub window_day: String,
    pub settled_by_key: HashMap<String, u64>,
    pub inflight_by_key: HashMap<String, u32>,
    /// Per-lane accumulation since the last heartbeat ack (lanes design).
    pub lane_settled: HashMap<String, LaneLedger>,
    /// Per-key charged totals inside the key's lane window (D1). Restored
    /// from the protocol-2 keyLedger heartbeat field.
    pub key_charged: HashMap<String, KeyWindowCharge>,
}

/// All reasons a temp key stops being authenticated. Every branch except the
/// happy path returns NotHandled — CPA's builtin chain then 401s the key
/// (temp keys are never in the builtin list), which is the constructive
/// fail-closed property validated in R22.
pub fn decide_auth(sync: &SyncState, token: &str, now_ms: i64) -> AuthDecision {
    if !sync.configured || sync.last_sync_ms == 0 {
        return AuthDecision::NotHandled;
    }
    if now_ms - sync.last_sync_ms > BACKEND_STALE_MS {
        return AuthDecision::NotHandled;
    }
    if sync.state != "active" {
        return AuthDecision::NotHandled;
    }
    let Some(entry) = sync.keys.iter().find(|k| k.token == token) else {
        return AuthDecision::NotHandled;
    };
    if entry.expires_at_ms > 0 && now_ms >= entry.expires_at_ms {
        return AuthDecision::NotHandled;
    }
    let principal = format!("atl:{}", entry.key_id);
    AuthDecision::Allow { principal, key_id: entry.key_id.clone() }
}

pub enum Gate {
    Pass,
    TerminateBudget(String),
    TerminateKeyCap,
    TerminateConcurrency,
    /// Lane-scope denial (schedule closed / budget exhausted / lane suspended
    /// or unknown) with a client-friendly retry hint in seconds.
    TerminateLane { reason: String, retry_after_secs: u64 },
}

const HOUR_MS: i64 = 3_600_000;

pub fn minute_in_windows(minute: u32, windows: &[WindowMark]) -> bool {
    windows.iter().any(|w| {
        if w.start_m == w.end_m {
            return false;
        }
        if w.start_m < w.end_m {
            minute >= w.start_m && minute < w.end_m
        } else {
            minute >= w.start_m || minute < w.end_m // wraps midnight
        }
    })
}

/// Minutes until the next open/close flip (≤1440); 0 when windows are empty.
pub fn minutes_until_flip(minute: u32, windows: &[WindowMark]) -> u32 {
    for step in 1..=1440u32 {
        let m = (minute + step) % 1440;
        if minute_in_windows(m, windows) != minute_in_windows(minute, windows) {
            return step;
        }
    }
    0
}

fn hour_grid(now_ms: i64, n: u32) -> (String, i64, i64) {
    let span = (n.max(1) as i64) * HOUR_MS;
    let start = now_ms.div_euclid(span) * span;
    (format!("h{}:{}", n, start), start, start + span)
}

/// YYYY-MM-DD of an epoch-ms instant in the anchor timezone (UTC getters on
/// the shifted instant) — mirrors the backend's anchorDayString.
fn anchor_day_string(ts: i64, tz_offset_minutes: i64) -> String {
    let days = (ts + tz_offset_minutes * 60_000).div_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Days-since-epoch → civil date (Howard Hinnant's civil_from_days).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// The lane's effective window at now_ms. Every unit self-rolls locally
/// (QA-03): n-hour windows on the tz-free epoch grid, day/week windows on
/// the owner-tz grid with EXACTLY the backend's formula (laneWindowOf) — an
/// event past a day/week boundary is charged into the NEW window even when
/// the heartbeat that carried the old marks has not been replaced yet.
pub fn effective_lane_window(lane: &LaneEntry, now_ms: i64, tz_offset_minutes: i64) -> (String, i64) {
    let n = lane.window_n.max(1) as i64;
    match lane.window_unit.as_str() {
        "hour" if lane.window_n >= 1 => {
            let (key, _, end) = hour_grid(now_ms, lane.window_n);
            (key, end)
        }
        "week" => {
            let day = (now_ms + tz_offset_minutes * 60_000).div_euclid(86_400_000);
            let week_idx = (day + 3).div_euclid(7);
            let start_idx = week_idx.div_euclid(n) * n;
            let start = (start_idx * 7 - 3) * 86_400_000 - tz_offset_minutes * 60_000;
            (format!("week:{}", anchor_day_string(start, tz_offset_minutes)), start + n * 7 * 86_400_000)
        }
        _ => {
            let day = (now_ms + tz_offset_minutes * 60_000).div_euclid(86_400_000);
            let start_idx = day.div_euclid(n) * n;
            let start = start_idx * 86_400_000 - tz_offset_minutes * 60_000;
            (format!("day:{}", anchor_day_string(start, tz_offset_minutes)), start + n * 86_400_000)
        }
    }
}

/// Lane settled total the gate should compare against the budget: the local
/// ledger when it tracks the effective window, else a fresh window (0).
pub fn lane_settled_now(
    lane: &LaneEntry,
    local: &HashMap<String, LaneLedger>,
    now_ms: i64,
    tz_offset_minutes: i64,
) -> u64 {
    let (key, _) = effective_lane_window(lane, now_ms, tz_offset_minutes);
    match local.get(&lane.id) {
        Some(entry) if entry.window_key == key => entry.settled,
        Some(_) => 0,
        None => {
            // No local accumulation yet: trust the backend baseline when it
            // still describes the effective window.
            let (lane_key, _) = effective_lane_window(lane, now_ms, tz_offset_minutes);
            if lane.window_key == lane_key {
                lane.settled_tokens
            } else {
                0
            }
        }
    }
}

/// Settle one usage event into its lane ledger (peak multiplier applies when
/// the event minute falls inside a peak window). Returns the applied delta.
pub fn settle_lane_usage(
    lane: &LaneEntry,
    local: &mut HashMap<String, LaneLedger>,
    tokens: u64,
    now_ms: i64,
    minute: u32,
    tz_offset_minutes: i64,
) -> u64 {
    let (key, _) = effective_lane_window(lane, now_ms, tz_offset_minutes);
    let entry = local.entry(lane.id.clone()).or_insert_with(|| LaneLedger {
        window_key: key.clone(),
        confirmed: 0,
        settled: 0,
    });
    if entry.window_key != key {
        entry.window_key = key;
        entry.confirmed = 0;
        entry.settled = 0;
    }
    let multiplier = if lane.peak_multiplier > 1 && minute_in_windows(minute, &lane.peak_windows) {
        lane.peak_multiplier
    } else {
        1
    };
    let applied = tokens.saturating_mul(multiplier);
    entry.settled = entry.settled.saturating_add(applied);
    applied
}

/// Event-time multiplier for a lane at a minute-of-day (peak windows).
pub fn lane_multiplier_at(lane: &LaneEntry, minute: u32) -> u64 {
    if lane.peak_multiplier > 1 && minute_in_windows(minute, &lane.peak_windows) {
        lane.peak_multiplier
    } else {
        1
    }
}

/// Per-key charged total inside the key's lane effective window (D1): rolls
/// implicitly — a stale entry reads as a fresh window (0).
pub fn key_charged_now(
    ledger: &Ledger,
    lane: &LaneEntry,
    key_id: &str,
    now_ms: i64,
    tz_offset_minutes: i64,
) -> u64 {
    let (key, _) = effective_lane_window(lane, now_ms, tz_offset_minutes);
    match ledger.key_charged.get(key_id) {
        Some(entry) if entry.window_key == key => entry.charged,
        _ => 0,
    }
}

/// Settle one usage event into the per-key window charge (D1). Returns the
/// (windowKey, multiplier, charged) triple so the caller can accumulate the
/// matching protocol-2 bucket.
pub fn settle_key_usage(
    ledger: &mut Ledger,
    lane: &LaneEntry,
    key_id: &str,
    tokens: u64,
    now_ms: i64,
    minute: u32,
    tz_offset_minutes: i64,
) -> (String, u64, u64) {
    let (key, _) = effective_lane_window(lane, now_ms, tz_offset_minutes);
    let multiplier = lane_multiplier_at(lane, minute);
    let charged = tokens.saturating_mul(multiplier);
    let entry = ledger.key_charged.entry(key_id.to_string()).or_default();
    if entry.window_key != key {
        entry.window_key = key.clone();
        entry.confirmed = 0;
        entry.charged = 0;
    }
    entry.charged = entry.charged.saturating_add(charged);
    (key, multiplier, charged)
}

/// Heartbeat restore (protocol 2): backend keyLedger entries are
/// backend-authoritative while they describe the window the plugin is
/// currently in (the backend computes the same fixed grids); a backend entry
/// for an older window (response raced a grid roll) never clobbers the local
/// fresh-window charge. Keys the backend no longer reports keep local state.
#[allow(clippy::too_many_arguments)]
pub fn restore_key_charged(
    ledger: &mut Ledger,
    lanes: &[LaneEntry],
    keys: &[KeyEntry],
    from_backend: &HashMap<String, (String, u64)>,
    now_ms: i64,
    tz_offset_minutes: i64,
    // un-acked increments per key: (window_key, charged). Recomputed from
    // the confirmed base on every restore — applying them twice (the R2-04
    // failure) or re-adding an unchanged baseline (R2-03) is impossible by
    // construction.
    pending_by_key: &HashMap<String, (String, u64)>,
) {
    ledger.key_charged.retain(|id, _| keys.iter().any(|key| key.key_id == *id));
    for key in keys {
        let key_id = &key.key_id;
        let Some(lane) = key_lane_of(keys, lanes, key_id) else { continue };
        let current = effective_lane_window(lane, now_ms, tz_offset_minutes).0;
        let entry = ledger.key_charged.entry(key_id.clone()).or_default();
        if entry.window_key != current {
            entry.window_key = current.clone();
            entry.confirmed = 0;
        }
        if let Some((window, charged)) = from_backend.get(key_id) {
            if *window == current { entry.confirmed = *charged; }
        }
        let pending = pending_by_key.get(key_id)
            .filter(|(window, _)| *window == current)
            .map(|(_, charged)| *charged).unwrap_or(0);
        entry.charged = entry.confirmed.saturating_add(pending);
    }
}

fn key_lane_of<'a>(keys: &'a [KeyEntry], lanes: &'a [LaneEntry], key_id: &str) -> Option<&'a LaneEntry> {
    keys.iter()
        .find(|k| k.key_id == key_id)
        .and_then(|k| lanes.iter().find(|l| l.id == k.lane_id))
}

/// Lane model scoping: patterns support exact ids and `*` wildcards
/// (prefix / suffix / infix), mirroring CPA's excluded-models semantics.
/// A lane with ["*"] (or an empty list) serves every model.
pub fn model_matches_lane(models: &[String], model: &str) -> bool {
    if models.is_empty() || models.iter().any(|m| m == "*") {
        return true;
    }
    models.iter().any(|pattern| {
        let stars = pattern.matches('*').count();
        if stars == 0 {
            pattern == model
        } else if stars == 1 {
            let (head, tail) = pattern.split_once('*').unwrap();
            model.starts_with(head) && model.ends_with(tail) && model.len() >= head.len() + tail.len()
        } else {
            // multi-star: match head/tail and every middle chunk in order
            let mut rest = model;
            let mut parts = pattern.split('*').collect::<Vec<_>>();
            let tail = parts.pop().unwrap_or("");
            let head = parts.remove(0);
            if !rest.starts_with(head) || !rest.ends_with(tail) {
                return false;
            }
            rest = &rest[head.len()..rest.len() - tail.len()];
            for chunk in parts {
                match rest.find(chunk) {
                    Some(at) => rest = &rest[at + chunk.len()..],
                    None => return false,
                }
            }
            true
        }
    })
}

/// Interceptor gate for a temp-key request. This is defense in depth: the
/// authoritative exhaustion denial lives in `decide_auth` (fail-closed); this
/// layer stops in-flight budget burn early with a clean 429.
///
/// Lane resolution: the key's lane binding selects the lane gate (model
/// scope + schedule + lane window budget). An empty sync.lanes list keeps the
/// legacy flat gate. `requested_model` = None (older CPA hosts without the
/// field) degrades to advisory scoping — schedule/budget gates still apply.
pub fn gate_request(
    ledger: &Ledger,
    sync: &SyncState,
    key_id: &str,
    key_max_tokens: u64,
    now_ms: i64,
    minute: u32,
    requested_model: Option<&str>,
) -> Gate {
    let mut lanes_mode = false;
    if let Some(entry) = sync.keys.iter().find(|k| k.key_id == key_id) {
        if !sync.lanes.is_empty() {
            lanes_mode = true;
            let Some(lane) = sync.lanes.iter().find(|l| l.id == entry.lane_id) else {
                return Gate::TerminateLane { reason: "lane_removed".into(), retry_after_secs: 0 };
            };
            if lane.state == "paused" {
                // D2: paused rejects traffic but keeps the key — distinct from
                // the terminal suspension so the owner card can say which.
                return Gate::TerminateLane { reason: "lane_paused".into(), retry_after_secs: 0 };
            }
            if lane.state != "active" {
                return Gate::TerminateLane { reason: "lane_suspended".into(), retry_after_secs: 0 };
            }
            if let Some(model) = requested_model {
                if !lane.models.is_empty()
                    && !lane.models.iter().any(|m| m == "*")
                    && !model_matches_lane(&lane.models, model)
                {
                    return Gate::TerminateLane { reason: "model_not_in_lane".into(), retry_after_secs: 0 };
                }
            }
            if !lane.schedule_windows.is_empty() && !minute_in_windows(minute, &lane.schedule_windows) {
                let retry = minutes_until_flip(minute, &lane.schedule_windows) as u64;
                return Gate::TerminateLane { reason: "lane_closed".into(), retry_after_secs: retry * 60 };
            }
            if lane.budget_tokens > 0 {
                let settled = lane_settled_now(lane, &ledger.lane_settled, now_ms, sync.tz_offset_minutes);
                if settled >= lane.budget_tokens {
                    let (_, end) = effective_lane_window(lane, now_ms, sync.tz_offset_minutes);
                    let retry = ((end - now_ms).max(0) / 1000) as u64;
                    return Gate::TerminateLane { reason: "lane_exhausted".into(), retry_after_secs: retry };
                }
            }
            // D1: the per-key cap charges inside the key's LANE window (same
            // grid, same peak multipliers as the lane budget) — not the
            // legacy share day grid.
            if key_max_tokens > 0 && key_charged_now(ledger, lane, key_id, now_ms, sync.tz_offset_minutes) >= key_max_tokens {
                return Gate::TerminateKeyCap;
            }
        }
    }
    let settled = ledger.settled_by_key.get(key_id).copied().unwrap_or(0);
    let window_settled: u64 = ledger.settled_by_key.values().sum();
    if sync.budget > 0 && sync.lanes.is_empty() && window_settled >= sync.budget {
        return Gate::TerminateBudget(format!("{} >= {}", window_settled, sync.budget));
    }
    if !lanes_mode && key_max_tokens > 0 && settled >= key_max_tokens {
        return Gate::TerminateKeyCap;
    }
    let inflight = ledger.inflight_by_key.get(key_id).copied().unwrap_or(0);
    if sync.key_concurrency > 0 && inflight >= sync.key_concurrency {
        return Gate::TerminateConcurrency;
    }
    Gate::Pass
}

/// Settle one usage event. `tokens` is CPA's UsageDetail.TotalTokens.
pub fn apply_usage(
    settled_by_key: &mut HashMap<String, u64>,
    key_id: &str,
    tokens: u64,
) -> UsageDelta {
    let entry = settled_by_key.entry(key_id.to_string()).or_insert(0);
    *entry += tokens;
    UsageDelta {
        key_id: key_id.to_string(),
        tokens,
        requests: 1,
        failed: 0,
    }
}

/// Window roll: when the backend's windowDay moves on, settled accounting
/// resets (the backend already rolled — it sends the new day + zeroed totals).
pub fn roll_window(ledger: &mut Ledger, window_day: &str) -> bool {
    if !window_day.is_empty() && ledger.window_day != window_day {
        ledger.window_day = window_day.to_string();
        ledger.settled_by_key.clear();
        return true;
    }
    false
}

/// Merge heartbeat-response accounting back into the mirror.
pub fn restore_settled(ledger: &mut Ledger, window_day: &str, settled_by_key: &HashMap<String, u64>) {
    if roll_window(ledger, window_day) {
        ledger.settled_by_key = settled_by_key.clone();
    } else {
        // Backend wins on every key it reports; keys it no longer mentions
        // (expired/revoked) keep their last known settle for gate accuracy.
        for (key, value) in settled_by_key {
            ledger.settled_by_key.insert(key.clone(), *value);
        }
    }
}

/// Heartbeat restore: backend lanes reinitialize the local ledgers. The
/// backend settled value already includes everything acked (pending deltas
/// were drained into the just-sent heartbeat), so replace wholesale.
/// Known bounded window: usage settled between drain and the response
/// arriving is absent from both sides for one RTT (≤4s timeout) — the local
/// gate may admit up to that much past the budget until the next restore
/// converges. Same model as the legacy settled_by_key mirror.
pub fn restore_lane_settled(
    ledger: &mut Ledger,
    lanes: &[LaneEntry],
    now_ms: i64,
    tz_offset_minutes: i64,
    // (lane_id, window_key) → un-acked charged; settled recomposes from the
    // confirmed base so restores are idempotent (R2-03) and a stale-window
    // snapshot cannot double-count (R2-04)
    pending: &HashMap<(String, String), u64>,
) {
    ledger.lane_settled.retain(|id, _| lanes.iter().any(|l| l.id == *id));
    for lane in lanes {
        let current = effective_lane_window(lane, now_ms, tz_offset_minutes).0;
        let entry = ledger.lane_settled.entry(lane.id.clone()).or_default();
        if entry.window_key != current {
            entry.window_key = current;
            entry.confirmed = 0;
            entry.settled = 0;
        }
        if lane.window_key == entry.window_key.clone() {
            entry.confirmed = lane.settled_tokens;
        }
        let inflight = pending.get(&(lane.id.clone(), entry.window_key.clone())).copied().unwrap_or(0);
        entry.settled = entry.confirmed.saturating_add(inflight);
    }
}

/// Merge a delta into an ack-backlog list (keyed merge, no duplicates).
pub fn merge_delta(list: &mut Vec<UsageDelta>, delta: UsageDelta) {
    if let Some(existing) = list.iter_mut().find(|d| d.key_id == delta.key_id) {
        existing.tokens += delta.tokens;
        existing.requests += delta.requests;
        existing.failed += delta.failed;
    } else {
        list.push(delta);
    }
}

/// Merge a usage event into the pending bucket list (protocol 2). Buckets
/// merge only when key, lane window, multiplier AND batch seq all match: a
/// bucket that was already sent (seq > 0, unknown fate after a failed
/// heartbeat) must never absorb new content — the retry must stay
/// byte-stable or at-most-once settlement double-counts the merged part.
pub fn merge_bucket(list: &mut Vec<UsageBucket>, event: UsageBucket) {
    if let Some(existing) = list.iter_mut().find(|b| {
        b.key_id == event.key_id
            && b.window_key == event.window_key
            && b.multiplier == event.multiplier
            && b.seq == event.seq
    }) {
        existing.raw_tokens += event.raw_tokens;
        existing.charged_tokens += event.charged_tokens;
        existing.requests += event.requests;
        existing.failed += event.failed;
    } else {
        list.push(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sync_with(key: KeyEntry) -> SyncState {
        SyncState {
            state: "active".into(),
            window_day: "2026-09-13".into(),
            budget: 1_000_000,
            key_concurrency: 2,
            keys: vec![key],
            lanes: Vec::new(),
            last_sync_ms: 1_000_000,
            configured: true,
            policy_rev: 0,
            tz_offset_minutes: 480,
            protocol: 2,
        }
    }

    fn key() -> KeyEntry {
        KeyEntry {
            key_id: "csk_1".into(),
            token: format!("{}abc", TOKEN_PREFIX),
            key_max_tokens: 500,
            expires_at_ms: 2_000_000,
            lane_id: "default".into(),
        }
    }

    fn gate(ledger: &Ledger, sync: &SyncState, key_id: &str, cap: u64) -> Gate {
        gate_request(ledger, sync, key_id, cap, 1_100_000, 12 * 60, None)
    }

    #[test]
    fn auth_happy_path_yields_principal() {
        let d = decide_auth(&sync_with(key()), &format!("{}abc", TOKEN_PREFIX), 1_100_000);
        assert_eq!(d, AuthDecision::Allow { principal: "atl:csk_1".into(), key_id: "csk_1".into() });
    }

    #[test]
    fn auth_is_fail_closed_on_every_degraded_state() {
        let token = format!("{}abc", TOKEN_PREFIX);
        let cases = [
            ("unconfigured", SyncState::default()),
            ("never synced", SyncState { configured: true, ..Default::default() }),
            ("stale backend", SyncState { last_sync_ms: 1_000_000 - BACKEND_STALE_MS - 1, ..sync_with(key()) }),
            ("share stopped", SyncState { state: "stopped".into(), ..sync_with(key()) }),
            ("expired key", sync_with(KeyEntry { expires_at_ms: 900_000, ..key() })),
            ("unknown token", SyncState { keys: vec![KeyEntry { token: format!("{}other", TOKEN_PREFIX), ..key() }], ..sync_with(key()) }),
        ];
        for (name, state) in cases {
            assert_eq!(decide_auth(&state, &token, 1_100_000), AuthDecision::NotHandled, "{}", name);
        }
    }

    #[test]
    fn gate_enforces_budget_cap_and_concurrency() {
        let sync = sync_with(key());
        let mut ledger = Ledger { window_day: "2026-09-13".into(), ..Default::default() };

        assert!(matches!(gate(&ledger, &sync, "csk_1", 500), Gate::Pass));

        // per-key cap
        ledger.settled_by_key.insert("csk_1".into(), 500);
        assert!(matches!(gate(&ledger, &sync, "csk_1", 500), Gate::TerminateKeyCap));

        // window budget (other keys burn the pool) — legacy flat mode only
        ledger.settled_by_key.insert("csk_other".into(), 1_000_000);
        assert!(matches!(gate(&ledger, &sync, "csk_1", 9_999_999), Gate::TerminateBudget(_)));

        // concurrency
        let mut ledger = Ledger { window_day: "2026-09-13".into(), ..Default::default() };
        ledger.inflight_by_key.insert("csk_1".into(), 2);
        assert!(matches!(gate(&ledger, &sync, "csk_1", 9_999_999), Gate::TerminateConcurrency));
    }

    fn lane(id: &str) -> LaneEntry {
        LaneEntry {
            id: id.into(),
            state: "active".into(),
            budget_tokens: 1_000,
            window_unit: "hour".into(),
            window_n: 5,
            window_key: format!("h5:{}", 1_000_000),
            window_end_ms: 1_000_000 + 5 * HOUR_MS,
            models: Vec::new(),
            settled_tokens: 0,
            schedule_windows: vec![],
            peak_windows: vec![],
            peak_multiplier: 1,
        }
    }

    fn sync_lanes(lanes: Vec<LaneEntry>) -> SyncState {
        SyncState { lanes, ..sync_with(key()) }
    }

    #[test]
    fn lane_gate_enforces_model_scope_and_degrades_without_model() {
        let mut gemini_lane = lane("default");
        gemini_lane.models = vec!["gemini-*".into()];
        let sync = sync_lanes(vec![gemini_lane]);
        let pass = |model: Option<&str>| {
            gate_request(&Ledger::default(), &sync, "csk_1", 9_999_999, 1_100_000, 12 * 60, model)
        };
        // exact family match passes; other families denied (hard isolation)
        assert!(matches!(pass(Some("gemini-3.8-flash-high")), Gate::Pass));
        assert!(matches!(
            pass(Some("glm-5.3-flash")),
            Gate::TerminateLane { reason, .. } if reason == "model_not_in_lane"
        ));
        // older CPA hosts without the model field degrade to advisory scoping
        assert!(matches!(pass(None), Gate::Pass));
        // wildcard semantics: multi-star, suffix, exact
        assert!(model_matches_lane(&["gemini-*".to_string()], "gemini-3.8-flash-high"));
        assert!(!model_matches_lane(&["gemini-*".to_string()], "gpt-5.6"));
        assert!(model_matches_lane(&["*-flash".to_string()], "glm-5.3-flash"));
        assert!(model_matches_lane(&["glm-5.3".to_string()], "glm-5.3"));
        assert!(model_matches_lane(&["g*high".to_string()], "gemini-3.8-flash-high"));
        assert!(!model_matches_lane(&["g*high".to_string()], "gemini-3.8-flash-low"));
        assert!(model_matches_lane(&["*".to_string()], "anything"));
        assert!(model_matches_lane(&[], "anything"));
    }

    #[test]
    fn lane_gate_denies_safe_on_removed_and_suspended_lanes() {
        // key's lane not in the synced lane list -> deny (backend withdrew it)
        let unknown = sync_lanes(vec![lane("other")]);
        assert!(matches!(
            gate(&Ledger::default(), &unknown, "csk_1", 100),
            Gate::TerminateLane { reason, retry_after_secs: 0 } if reason == "lane_removed"
        ));
        // suspended lane -> deny without retry hint
        let mut suspended = lane("default");
        suspended.state = "suspended".into();
        assert!(matches!(
            gate(&Ledger::default(), &sync_lanes(vec![suspended]), "csk_1", 100),
            Gate::TerminateLane { reason, .. } if reason == "lane_suspended"
        ));
    }

    #[test]
    fn lane_gate_enforces_schedule_with_retry_hint() {
        let mut offpeak = lane("default");
        offpeak.schedule_windows = vec![WindowMark { start_m: 22 * 60, end_m: 14 * 60 }];
        let sync = sync_lanes(vec![offpeak]);
        // 22:00-14:00 wraps midnight: noon sits inside the 00:00-14:00 half
        assert!(matches!(
            gate_request(&Ledger::default(), &sync, "csk_1", 9_999_999, 1_100_000, 12 * 60, None),
            Gate::Pass
        ));
        assert!(matches!(
            gate_request(&Ledger::default(), &sync, "csk_1", 9_999_999, 1_100_000, 23 * 60, None),
            Gate::Pass
        ));
        // 15:00 is outside; the lane reopens at 22:00 => 420 minutes
        assert!(matches!(
            gate_request(&Ledger::default(), &sync, "csk_1", 9_999_999, 1_100_000, 15 * 60, None),
            Gate::TerminateLane { reason, retry_after_secs } if reason == "lane_closed" && retry_after_secs == 420 * 60
        ));
    }

    #[test]
    fn lane_gate_enforces_lane_budget_and_hour_window_self_roll() {
        let sync = sync_lanes(vec![lane("default")]);
        let mut ledger = Ledger::default();
        // no local accumulation -> backend baseline 0 -> pass
        assert!(matches!(gate(&ledger, &sync, "csk_1", 9_999_999), Gate::Pass));
        // local burn past the lane budget -> terminate with retry until the
        // grid window end (now 1_100_000 sits in the [0, HOUR5_MS) grid cell)
        let applied = settle_lane_usage(&lane("default"), &mut ledger.lane_settled, 900, 1_100_000, 0, 480);
        assert_eq!(applied, 900);
        let applied2 = settle_lane_usage(&lane("default"), &mut ledger.lane_settled, 200, 1_100_000, 0, 480);
        assert_eq!(applied2, 200);
        let grid_end = 5 * HOUR_MS;
        assert!(matches!(
            gate(&ledger, &sync, "csk_1", 9_999_999),
            Gate::TerminateLane { reason, retry_after_secs } if reason == "lane_exhausted"
                && retry_after_secs == ((grid_end - 1_100_000) / 1000) as u64
        ));
        // past the grid window the lane self-rolls: settled resets, gate reopens
        let after = 5 * HOUR_MS + 1;
        assert!(matches!(
            gate_request(&ledger, &sync, "csk_1", 9_999_999, after, 0, None),
            Gate::Pass
        ));
    }

    #[test]
    fn lane_peak_multiplier_settles_at_rate() {
        let mut peaky = lane("default");
        peaky.peak_multiplier = 3;
        peaky.peak_windows = vec![WindowMark { start_m: 15 * 60, end_m: 21 * 60 }];
        let mut ledger = Ledger::default();
        // 16:00 inside peak: x3; 22:00 outside: x1
        assert_eq!(settle_lane_usage(&peaky, &mut ledger.lane_settled, 100, 1_100_000, 16 * 60, 480), 300);
        assert_eq!(settle_lane_usage(&peaky, &mut ledger.lane_settled, 100, 1_100_000, 22 * 60, 480), 100);
        assert_eq!(ledger.lane_settled.get("default").unwrap().settled, 400);
        // restore: the backend baseline counts only while it describes the
        // CURRENT window (acks included everything up to the snapshot)
        let mut from_backend = lane("default");
        from_backend.window_key = effective_lane_window(&from_backend, 1_100_000, 480).0;
        from_backend.settled_tokens = 1_234;
        restore_lane_settled(&mut ledger, &[from_backend.clone()], 1_100_000, 480, &HashMap::new());
        assert_eq!(ledger.lane_settled.get("default").unwrap().settled, 1_234);
        // QA-02: usage completed while the response was in flight ADDS on
        // top of the confirmed base instead of being overwritten
        let current = effective_lane_window(&from_backend, 1_100_000, 480).0;
        let mut pending = HashMap::new();
        pending.insert(("default".to_string(), current.clone()), 70u64);
        let mut base = from_backend.clone();
        base.settled_tokens = 40;
        restore_lane_settled(&mut ledger, &[base], 1_100_000, 480, &pending);
        assert_eq!(ledger.lane_settled.get("default").unwrap().settled, 110);
        // QA-03: a STALE backend window (response raced a boundary) must not
        // seed the fresh window — the lane reads 0, not the old total
        let mut stale = lane("default");
        stale.window_key = "h5:0".into();
        stale.settled_tokens = 9_999;
        let after = 5 * HOUR_MS + 1;
        restore_lane_settled(&mut ledger, &[stale], after, 480, &HashMap::new());
        assert_eq!(ledger.lane_settled.get("default").unwrap().settled, 0);
        // lanes that disappear from the sync are dropped from the local map
        restore_lane_settled(&mut ledger, &[lane("other")], 1_100_000, 480, &HashMap::new());
        assert!(ledger.lane_settled.get("default").is_none());
    }

    #[test]
    fn day_and_week_windows_self_roll_matching_the_backend_grid() {
        // QA-03 truth table: keys generated by the BACKEND formula
        // (sharing-cpa.js laneWindowOf) for boundary-crossing instants and
        // three owner timezones — the plugin must reproduce them exactly.
        let cases: Vec<(&str, u32, i64, i64, &str, i64, i64)> = vec![
            ("day", 1, 1789905600000, 480, "day:2026-09-20", 1789920000000, 0),
            ("day", 1, 1789905599999, 480, "day:2026-09-20", 1789920000000, 0),
            ("day", 1, 1789992000000, 480, "day:2026-09-21", 1790006400000, 0),
            ("day", 2, 1789905600000, 480, "day:2026-09-20", 1790006400000, 0),
            ("day", 2, 1789992000000, 480, "day:2026-09-20", 1790006400000, 0),
            ("day", 2, 1789819200000, 480, "day:2026-09-18", 1789833600000, 0),
            ("week", 1, 1789905600000, 480, "week:2026-09-14", 1789920000000, 0),
            ("week", 1, 1789992000000, 480, "week:2026-09-21", 1790524800000, 0),
            ("week", 2, 1789905600000, 480, "week:2026-09-07", 1789920000000, 0),
            ("week", 2, 1789992000000, 480, "week:2026-09-21", 1791129600000, 0),
            ("day", 1, 1789905600000, 0, "day:2026-09-20", 1789948800000, 0),
            ("day", 1, 1789992000000, 0, "day:2026-09-21", 1790035200000, 0),
            ("week", 1, 1789905600000, 0, "week:2026-09-14", 1789948800000, 0),
            ("week", 1, 1789992000000, 0, "week:2026-09-21", 1790553600000, 0),
            ("day", 1, 1789905600000, -300, "day:2026-09-20", 1789966800000, 0),
            ("day", 1, 1789992000000, -300, "day:2026-09-21", 1790053200000, 0),
            ("week", 1, 1789905600000, -300, "week:2026-09-14", 1789966800000, 0),
            ("week", 2, 1789992000000, -300, "week:2026-09-21", 1791176400000, 0),
        ];
        for (unit, n, ts, tz, key, _, end) in cases {
            let mut spec = lane("default");
            spec.window_unit = unit.into();
            spec.window_n = n;
            let (got_key, got_end) = effective_lane_window(&spec, ts, tz);
            assert_eq!(got_key, key, "window key {unit}/{n} ts={ts} tz={tz}");
            if end != 0 {
                assert_eq!(got_end, end, "window end {unit}/{n} ts={ts} tz={tz}");
            }
        }
        // a day/week event PAST the boundary no longer reports the stale
        // heartbeat window (the QA-03 failure mode)
        let mut day_lane = lane("default");
        day_lane.window_unit = "day".into();
        day_lane.window_n = 1;
        day_lane.window_key = "day:2026-09-20".into();
        let (rolled, _) = effective_lane_window(&day_lane, 1789992000000, 480);
        assert_eq!(rolled, "day:2026-09-21");
    }

    #[test]
    fn heartbeat_inflight_usage_is_not_overwritten_by_the_response() {
        // QA-02 acceptance probe: drain 40 into a heartbeat, complete 70
        // while the response is in flight, restore the snapshot — the key
        // and lane must read 110 and the cap gate must stay shut.
        let mut peaky = lane("default");
        peaky.budget_tokens = 1_000; // lane stays open; only the KEY cap binds
        peaky.peak_multiplier = 1;
        let mut key = key();
        key.key_max_tokens = 100;
        let sync = sync_lanes(vec![peaky.clone()]);
        let mut ledger = Ledger::default();
        // confirmed: 40 settled before the drain
        let (window_key, _, charged) = settle_key_usage(&mut ledger, &peaky, "csk_1", 40, 1_100_000, 12 * 60, 480);
        assert_eq!(charged, 40);
        let window_key_base = window_key.clone();
        settle_lane_usage(&peaky, &mut ledger.lane_settled, 40, 1_100_000, 12 * 60, 480);
        // in flight: 70 completes AFTER the drain (sits in pending_buckets)
        let (pending_window, _, pending_charged) = settle_key_usage(&mut ledger, &peaky, "csk_1", 70, 1_100_000, 12 * 60, 480);
        settle_lane_usage(&peaky, &mut ledger.lane_settled, 70, 1_100_000, 12 * 60, 480);
        let pending_key: HashMap<String, (String, u64)> =
            [("csk_1".to_string(), (pending_window.clone(), pending_charged))].into_iter().collect();
        let mut lane_pending: HashMap<(String, String), u64> = HashMap::new();
        lane_pending.insert(("default".to_string(), pending_window.clone()), pending_charged);
        // backend snapshot only knows the drained 40
        let mut from_backend = HashMap::new();
        from_backend.insert("csk_1".to_string(), (window_key_base, 40u64));
        restore_key_charged(&mut ledger, &sync.lanes, &sync.keys, &from_backend, 1_100_000, 480, &pending_key);
        let mut backend_lane = peaky.clone();
        backend_lane.window_key = window_key.clone();
        backend_lane.settled_tokens = 40;
        restore_lane_settled(&mut ledger, &[backend_lane], 1_100_000, 480, &lane_pending);
        assert_eq!(key_charged_now(&ledger, &peaky, "csk_1", 1_100_000, 480), 110);
        assert!(matches!(
            gate_request(&ledger, &sync, "csk_1", 100, 1_100_000, 12 * 60, None),
            Gate::TerminateKeyCap
        ));
    }


    #[test]
    fn repeated_same_snapshot_restores_are_idempotent() {
        // R2-03 acceptance probe: the legacy backend returns the SAME
        // absolute baseline every heartbeat — charged must stay at 30, not
        // compound to 60/90/120. Legacy absolute totals become confirmed
        // baselines in sync.rs, exactly like protocol-2 keyLedger entries.
        let peaky = lane("default");
        let sync = sync_lanes(vec![peaky.clone()]);
        let mut ledger = Ledger::default();
        let current = effective_lane_window(&peaky, 1_100_000, 480).0;
        for _ in 0..4 {
            let baseline = HashMap::from([("csk_1".to_string(), (current.clone(), 30))]);
            restore_key_charged(&mut ledger, &sync.lanes, &sync.keys, &baseline, 1_100_000, 480, &HashMap::new());
        }
        assert_eq!(key_charged_now(&ledger, &peaky, "csk_1", 1_100_000, 480), 30);
    }

    #[test]
    fn stale_window_response_does_not_double_count_current_pending() {
        // R2-04 acceptance probe: 30 pending in the current window; the
        // response describes the PREVIOUS window — charged must read 30
        // (base 0 + pending), never 60.
        let peaky = lane("default");
        let sync = sync_lanes(vec![peaky.clone()]);
        let mut ledger = Ledger::default();
        let (window, _, charged) = settle_key_usage(&mut ledger, &peaky, "csk_1", 30, 1_100_000, 12 * 60, 480);
        assert_eq!(charged, 30);
        // stale backend snapshot for a DIFFERENT (already closed) window
        let mut stale: HashMap<String, (String, u64)> = HashMap::new();
        stale.insert("csk_1".to_string(), ("h5:-18000000".to_string(), 999u64));
        let mut key_pending: HashMap<String, (String, u64)> = HashMap::new();
        key_pending.insert("csk_1".to_string(), (window.clone(), 30u64));
        restore_key_charged(&mut ledger, &sync.lanes, &sync.keys, &stale, 1_100_000, 480, &key_pending);
        assert_eq!(key_charged_now(&ledger, &peaky, "csk_1", 1_100_000, 480), 30);
        // and the lane ledger keeps base+pending consistent under the same shape
        let mut lane_pending: HashMap<(String, String), u64> = HashMap::new();
        lane_pending.insert(("default".to_string(), window.clone()), 30u64);
        let mut backend_lane = peaky.clone();
        backend_lane.window_key = "h5:-18000000".into(); // stale mark
        backend_lane.settled_tokens = 999;
        restore_lane_settled(&mut ledger, &[backend_lane], 1_100_000, 480, &lane_pending);
        assert_eq!(lane_settled_now(&peaky, &ledger.lane_settled, 1_100_000, 480), 30);
    }

    #[test]
    fn legacy_backend_baseline_seeds_the_per_key_window() {
        // QA-04 acceptance probe: a pre-v2 backend restores settledByKey=100
        // with a 100 cap — the gate must NOT treat the key as fresh.
        let peaky = lane("default");
        let sync = sync_lanes(vec![peaky.clone()]);
        let mut ledger = Ledger::default();
        // legacy restore path (sync.rs): settledByKey → key_pending with the
        // CURRENT window, then restore_key_charged
        let current = effective_lane_window(&peaky, 1_100_000, 480).0;
        let mut key_pending: HashMap<String, (String, u64)> = HashMap::new();
        key_pending.insert("csk_1".to_string(), (current.clone(), 100));
        restore_key_charged(&mut ledger, &sync.lanes, &sync.keys, &HashMap::new(), 1_100_000, 480, &key_pending);
        assert_eq!(key_charged_now(&ledger, &peaky, "csk_1", 1_100_000, 480), 100);
        assert!(matches!(
            gate_request(&ledger, &sync, "csk_1", 100, 1_100_000, 12 * 60, None),
            Gate::TerminateKeyCap
        ));
    }

    #[test]
    fn window_roll_resets_and_backend_restore_wins() {
        let mut ledger = Ledger { window_day: "2026-09-12".into(), ..Default::default() };
        ledger.settled_by_key.insert("csk_1".into(), 100);
        assert!(roll_window(&mut ledger, "2026-09-13"));
        assert!(ledger.settled_by_key.is_empty());

        let mut from_backend = HashMap::new();
        from_backend.insert("csk_1".to_string(), 4321u64);
        restore_settled(&mut ledger, "2026-09-13", &from_backend);
        assert_eq!(ledger.settled_by_key.get("csk_1"), Some(&4321));
    }

    #[test]
    fn usage_settles_accumulatively() {
        let mut settled = HashMap::new();
        apply_usage(&mut settled, "csk_1", 100);
        apply_usage(&mut settled, "csk_1", 23);
        assert_eq!(settled.get("csk_1"), Some(&123));
    }

    #[test]
    fn paused_lane_denies_with_distinct_reason() {
        // D2: paused terminates traffic with lane_paused (the owner card and
        // the CLI can tell "coming back" from "terminated"); keys remain.
        let mut paused = lane("default");
        paused.state = "paused".into();
        assert!(matches!(
            gate(&Ledger::default(), &sync_lanes(vec![paused]), "csk_1", 100),
            Gate::TerminateLane { reason, .. } if reason == "lane_paused"
        ));
    }

    #[test]
    fn key_cap_charges_inside_the_lane_window_d1() {
        // D1/CS-06: the per-key cap follows the lane's hour grid — charging
        // 400 raw in one grid cell caps a 400-limit key, and the SAME key in
        // the next grid cell reads a fresh window (not the legacy day grid,
        // which would keep it capped until the backend day rolls).
        let mut peaky = lane("default");
        peaky.peak_multiplier = 2;
        peaky.peak_windows = vec![WindowMark { start_m: 0, end_m: 1440 }];
        let sync = sync_lanes(vec![peaky.clone()]);
        let mut ledger = Ledger::default();

        // event-time multiplier: 200 raw -> 400 charged inside the window
        let (window_key, multiplier, charged) =
            settle_key_usage(&mut ledger, &peaky, "csk_1", 200, 1_100_000, 12 * 60, 480);
        assert_eq!((multiplier, charged), (2, 400));
        assert_eq!(key_charged_now(&ledger, &peaky, "csk_1", 1_100_000, 480), 400);
        assert!(matches!(
            gate_request(&ledger, &sync, "csk_1", 400, 1_100_000, 12 * 60, None),
            Gate::TerminateKeyCap
        ));
        // a lower cap is enforced by the lane-window charge, not settled_by_key
        assert!(matches!(
            gate_request(&ledger, &sync, "csk_1", 350, 1_100_000, 12 * 60, None),
            Gate::TerminateKeyCap
        ));
        // the settled_by_key day map is NOT what the lanes gate reads: leave
        // it at zero and the cap still trips (charged drives it)
        assert_eq!(ledger.settled_by_key.get("csk_1"), None);

        // past the 5h grid the key window self-rolls: fresh charge, gate opens
        let after = 5 * HOUR_MS + 1;
        assert_eq!(key_charged_now(&ledger, &peaky, "csk_1", after, 480), 0);
        assert!(matches!(
            gate_request(&ledger, &sync, "csk_1", 400, after, 0, None),
            Gate::Pass
        ));
        // settle in the new window under a new key of the same lane (the
        // all-day peak window applies the x2 event-time multiplier here too)
        let (window_key2, _, charged2) = settle_key_usage(&mut ledger, &peaky, "csk_2", 10, after, 0, 480);
        assert_ne!(window_key, window_key2);
        assert_eq!(charged2, 20);
        assert_eq!(key_charged_now(&ledger, &peaky, "csk_2", after, 480), 20);
    }

    #[test]
    fn restore_key_charged_respects_window_and_skips_foreign() {
        let l = lane("default");
        let sync = sync_lanes(vec![l.clone()]);
        let mut ledger = Ledger::default();
        settle_key_usage(&mut ledger, &l, "csk_1", 100, 1_100_000, 0, 480);

        let mut from_backend = HashMap::new();
        let current_key = effective_lane_window(&l, 1_100_000, 480).0;
        from_backend.insert("csk_1".to_string(), (current_key.clone(), 4321u64));
        // a stale backend entry (response raced a grid roll) must not clobber
        from_backend.insert("csk_2".to_string(), ("h5:0".to_string(), 999u64));
        restore_key_charged(&mut ledger, &sync.lanes, &sync.keys, &from_backend, 1_100_000, 480, &HashMap::new());
        assert_eq!(ledger.key_charged.get("csk_1").unwrap().charged, 4321);
        assert!(ledger.key_charged.get("csk_2").is_none());
    }

    #[test]
    fn merge_bucket_never_absorbs_new_content_into_a_sent_batch() {
        // CS-06 at-most-once: a failed send leaves the batch tainted (seq>0).
        // New usage must open a FRESH bucket — merging into the tainted one
        // would re-send old content under a new fate and double-settle.
        let mut list = vec![UsageBucket {
            key_id: "k".into(),
            lane_id: "default".into(),
            window_key: "w".into(),
            multiplier: 1,
            raw_tokens: 10,
            charged_tokens: 10,
            requests: 1,
            failed: 0,
            seq: 5,
        }];
        merge_bucket(&mut list, UsageBucket {
            key_id: "k".into(),
            lane_id: "default".into(),
            window_key: "w".into(),
            multiplier: 1,
            raw_tokens: 7,
            charged_tokens: 7,
            requests: 1,
            failed: 0,
            seq: 0,
        });
        assert_eq!(list.len(), 2, "fresh content must not merge into a sent batch");
        assert_eq!(list[0].raw_tokens, 10);
        assert_eq!(list[1].raw_tokens, 7);
        // same batch seq + same window: merges normally
        merge_bucket(&mut list, UsageBucket {
            key_id: "k".into(),
            lane_id: "default".into(),
            window_key: "w".into(),
            multiplier: 1,
            raw_tokens: 3,
            charged_tokens: 3,
            requests: 0,
            failed: 1,
            seq: 0,
        });
        assert_eq!(list.len(), 2);
        assert_eq!((list[1].raw_tokens, list[1].failed), (10, 1));
        // a different multiplier opens its own bucket (peak boundary split)
        merge_bucket(&mut list, UsageBucket {
            key_id: "k".into(),
            lane_id: "default".into(),
            window_key: "w".into(),
            multiplier: 2,
            raw_tokens: 4,
            charged_tokens: 8,
            requests: 1,
            failed: 0,
            seq: 0,
        });
        assert_eq!(list.len(), 3);
    }
    #[test]
    fn new_window_events_do_not_inherit_the_previous_confirmed_base() {
        let peaky = lane("default");
        let sync = sync_lanes(vec![peaky.clone()]);
        let mut ledger = Ledger::default();
        ledger.key_charged.insert("csk_1".into(), KeyWindowCharge {
            window_key: "h5:-18000000".into(), confirmed: 80, charged: 80,
        });
        let (current, _, _) = settle_key_usage(&mut ledger, &peaky, "csk_1", 30, 1_100_000, 12 * 60, 480);
        let stale = HashMap::from([("csk_1".into(), ("h5:-18000000".into(), 80))]);
        let pending = HashMap::from([("csk_1".into(), (current, 30))]);
        restore_key_charged(&mut ledger, &sync.lanes, &sync.keys, &stale, 1_100_000, 480, &pending);
        assert_eq!(key_charged_now(&ledger, &peaky, "csk_1", 1_100_000, 480), 30);
    }

}
