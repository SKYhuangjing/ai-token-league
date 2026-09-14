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
}

/// Interceptor gate for a temp-key request. This is defense in depth: the
/// authoritative exhaustion denial lives in `decide_auth` (fail-closed); this
/// layer stops in-flight budget burn early with a clean 429.
pub fn gate_request(ledger: &Ledger, sync: &SyncState, key_id: &str, key_max_tokens: u64) -> Gate {
    let settled = ledger.settled_by_key.get(key_id).copied().unwrap_or(0);
    let window_settled: u64 = ledger.settled_by_key.values().sum();
    if sync.budget > 0 && window_settled >= sync.budget {
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
        }
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

        assert!(matches!(gate_request(&ledger, &sync, "csk_1", 500), Gate::Pass));

        // per-key cap
        ledger.settled_by_key.insert("csk_1".into(), 500);
        assert!(matches!(gate_request(&ledger, &sync, "csk_1", 500), Gate::TerminateKeyCap));

        // window budget (other keys burn the pool)
        ledger.settled_by_key.insert("csk_other".into(), 1_000_000);
        assert!(matches!(gate_request(&ledger, &sync, "csk_1", 9_999_999), Gate::TerminateBudget(_)));

        // concurrency
        let mut ledger = Ledger { window_day: "2026-09-13".into(), ..Default::default() };
        ledger.inflight_by_key.insert("csk_1".into(), 2);
        assert!(matches!(gate_request(&ledger, &sync, "csk_1", 9_999_999), Gate::TerminateConcurrency));
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
