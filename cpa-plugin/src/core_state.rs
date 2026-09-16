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
    /// day/week follow the backend heartbeat marks.
    pub window_unit: String, // hour | day | week
    pub window_n: u32,
    pub window_key: String,
    pub window_end_ms: i64,
    /// Baseline settled tokens for window_key (backend-authoritative).
    pub settled_tokens: u64,
    pub schedule_windows: Vec<WindowMark>,
    pub peak_windows: Vec<WindowMark>,
    pub peak_multiplier: u64,
}

/// Local per-lane accumulation since the last heartbeat ack.
#[derive(Clone, Debug, Default)]
pub struct LaneLedger {
    pub window_key: String,
    pub settled: u64,
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
}

#[derive(Debug, PartialEq)]
pub enum AuthDecision {
    Allow { principal: String, key_id: String },
    NotHandled,
}

#[derive(Clone, Debug, Default, PartialEq)]
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

/// The lane's effective window at now_ms. n-hour windows self-roll on a
/// tz-free grid (any n, R50); day/week windows follow the backend heartbeat
/// (8s ticks, so boundary lag is bounded by the 600s staleness rule).
pub fn effective_lane_window(lane: &LaneEntry, now_ms: i64) -> (String, i64) {
    if lane.window_unit == "hour" && lane.window_n >= 1 {
        let (key, _, end) = hour_grid(now_ms, lane.window_n);
        (key, end)
    } else {
        (lane.window_key.clone(), lane.window_end_ms)
    }
}

/// Lane settled total the gate should compare against the budget: the local
/// ledger when it tracks the effective window, else a fresh window (0).
pub fn lane_settled_now(
    lane: &LaneEntry,
    local: &HashMap<String, LaneLedger>,
    now_ms: i64,
) -> u64 {
    let (key, _) = effective_lane_window(lane, now_ms);
    match local.get(&lane.id) {
        Some(entry) if entry.window_key == key => entry.settled,
        Some(_) => 0,
        None => {
            // No local accumulation yet: trust the backend baseline when it
            // still describes the effective window.
            let (lane_key, _) = effective_lane_window(lane, now_ms);
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
) -> u64 {
    let (key, _) = effective_lane_window(lane, now_ms);
    let entry = local.entry(lane.id.clone()).or_insert_with(|| LaneLedger {
        window_key: key.clone(),
        settled: 0,
    });
    if entry.window_key != key {
        entry.window_key = key;
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
    if let Some(entry) = sync.keys.iter().find(|k| k.key_id == key_id) {
        if !sync.lanes.is_empty() {
            let Some(lane) = sync.lanes.iter().find(|l| l.id == entry.lane_id) else {
                return Gate::TerminateLane { reason: "lane_removed".into(), retry_after_secs: 0 };
            };
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
                let settled = lane_settled_now(lane, &ledger.lane_settled, now_ms);
                if settled >= lane.budget_tokens {
                    let (_, end) = effective_lane_window(lane, now_ms);
                    let retry = ((end - now_ms).max(0) / 1000) as u64;
                    return Gate::TerminateLane { reason: "lane_exhausted".into(), retry_after_secs: retry };
                }
            }
        }
    }
    let settled = ledger.settled_by_key.get(key_id).copied().unwrap_or(0);
    let window_settled: u64 = ledger.settled_by_key.values().sum();
    if sync.budget > 0 && sync.lanes.is_empty() && window_settled >= sync.budget {
        return Gate::TerminateBudget(format!("{} >= {}", window_settled, sync.budget));
    }
    if key_max_tokens > 0 && settled >= key_max_tokens {
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
pub fn restore_lane_settled(ledger: &mut Ledger, lanes: &[LaneEntry]) {
    ledger.lane_settled.retain(|id, _| lanes.iter().any(|l| l.id == *id));
    for lane in lanes {
        ledger.lane_settled.insert(
            lane.id.clone(),
            LaneLedger { window_key: lane.window_key.clone(), settled: lane.settled_tokens },
        );
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
        let applied = settle_lane_usage(&lane("default"), &mut ledger.lane_settled, 900, 1_100_000, 0);
        assert_eq!(applied, 900);
        let applied2 = settle_lane_usage(&lane("default"), &mut ledger.lane_settled, 200, 1_100_000, 0);
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
        assert_eq!(settle_lane_usage(&peaky, &mut ledger.lane_settled, 100, 1_100_000, 16 * 60), 300);
        assert_eq!(settle_lane_usage(&peaky, &mut ledger.lane_settled, 100, 1_100_000, 22 * 60), 100);
        assert_eq!(ledger.lane_settled.get("default").unwrap().settled, 400);
        // restore from backend replaces wholesale (acks included everything)
        let mut from_backend = lane("default");
        from_backend.settled_tokens = 1_234;
        restore_lane_settled(&mut ledger, &[from_backend]);
        assert_eq!(ledger.lane_settled.get("default").unwrap().settled, 1_234);
        // lanes that disappear from the sync are dropped from the local map
        restore_lane_settled(&mut ledger, &[lane("other")]);
        assert!(ledger.lane_settled.get("default").is_none());
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
}
