// Backend sync: the heartbeat loop that makes the ATL backend the single
// source of truth. First tick self-registers the share (owner config comes
// from CPA's `plugins.configs.atl-share` subtree) and persists the identity;
// later ticks drain accumulated usage deltas, POST them, and replace the
// local key/policy snapshot with the response. On failure the deltas are
// merged back so nothing is lost; auth goes fail-closed on its own via the
// BACKEND_STALE_MS rule in core_state.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::now_ms;
use crate::bootstrap::{self, OwnerConfig};
use crate::with_runtime;
use crate::{PLUGIN_VERSION, Runtime};
use crate::core_state::{merge_delta, restore_lane_settled, restore_settled, LaneEntry, SyncState, UsageDelta, WindowMark};

fn str_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").trim().to_string()
}

fn window_marks_of(v: &Value, key: &str) -> Vec<WindowMark> {
    v.get(key)
        .and_then(|x| x.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|w| {
                    let start = w.get("startM").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                    let end = w.get("endM").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                    if start == end || start > 1440 || end > 1440 {
                        return None;
                    }
                    Some(WindowMark { start_m: start, end_m: end })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Window spec parsing (R50): the wire sends window {unit, n}; the legacy
/// period strings ("hour5"/"week"/"day") normalize so mixed-version
/// heartbeats keep gating. Unknown specs degrade to heartbeat-marked day
/// windows (unit "day"), never a self-rolling hour grid.
fn window_unit_of(l: &Value) -> String {
    let spec = l.get("window").filter(|v| v.is_object());
    if let Some(unit) = spec.and_then(|s| s.get("unit")).and_then(|x| x.as_str()) {
        if unit == "hour" || unit == "day" || unit == "week" {
            return unit.to_string();
        }
    }
    match str_of(l, "period").as_str() {
        "hour5" => "hour".to_string(),
        _ => "day".to_string(),
    }
}

fn window_n_of(l: &Value) -> u32 {
    if let Some(n) = l.get("window").and_then(|s| s.get("n")).and_then(|x| x.as_u64()) {
        if (1..=48).contains(&n) {
            return n as u32;
        }
    }
    if str_of(l, "period") == "hour5" {
        return 5;
    }
    1
}

/// Heartbeat lane entries: unknown/missing fields degrade deny-safe (state
/// != "active" denies, budget 0 = no window gate, empty schedule = 24h).
fn lanes_of(resp: &Value) -> Vec<LaneEntry> {
    resp.get("lanes")
        .and_then(|x| x.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|l| {
                    let id = str_of(l, "id");
                    if id.is_empty() {
                        return None;
                    }
                    Some(LaneEntry {
                        id,
                        state: str_of(l, "state"),
                        models: l
                            .get("models")
                            .and_then(|x| x.as_array())
                            .map(|list| list.iter().filter_map(|m| m.as_str().map(String::from)).collect())
                            .unwrap_or_default(),
                        budget_tokens: l.get("budgetTokens").and_then(|x| x.as_u64()).unwrap_or(0),
                        window_unit: window_unit_of(l),
                        window_n: window_n_of(l),
                        window_key: str_of(l, "windowKey"),
                        window_end_ms: l.get("windowEndMs").and_then(|x| x.as_i64()).unwrap_or(0),
                        settled_tokens: l.get("settledTokens").and_then(|x| x.as_u64()).unwrap_or(0),
                        schedule_windows: window_marks_of(l, "scheduleWindows"),
                        peak_windows: window_marks_of(l, "peakWindows"),
                        peak_multiplier: l.get("peakMultiplier").and_then(|x| x.as_u64()).unwrap_or(1),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn http_client() -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .ok()
}

/// Heartbeat response -> SyncState. Unknown/missing fields degrade to
/// deny-safe defaults (empty state != "active", budget 0 = no window gate,
/// empty keys = nobody authenticates).
pub(crate) fn parse_sync_response(resp: &Value, now_ms: i64) -> SyncState {
    let policy = resp.get("policy").cloned().unwrap_or(Value::Null);
    let keys = resp
        .get("keys")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|k| {
                    let key_id = str_of(k, "keyId");
                    let token = str_of(k, "token");
                    if key_id.is_empty() || token.is_empty() {
                        return None;
                    }
                    Some(bootstrap::KeyEntry {
                        key_id,
                        token,
                        key_max_tokens: k.get("keyMaxTokens").and_then(|v| v.as_u64()).unwrap_or(0),
                        expires_at_ms: k.get("expiresAtMs").and_then(|v| v.as_i64()).unwrap_or(0),
                        lane_id: str_of(k, "laneId"),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    SyncState {
        state: str_of(resp, "state"),
        window_day: str_of(resp, "windowDay"),
        budget: policy.get("budget").and_then(|v| v.as_u64()).unwrap_or(0),
        key_concurrency: policy.get("keyConcurrency").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        keys,
        lanes: lanes_of(resp),
        last_sync_ms: now_ms,
        configured: true,
    }
}

fn settled_map_of(resp: &Value) -> HashMap<String, u64> {
    resp.get("settledByKey")
        .and_then(|v| v.as_object())
        .map(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_u64().map(|n| (k.clone(), n)))
                .collect()
        })
        .unwrap_or_default()
}

/// Reconciliation policy (R51-2): only a definitive rejection (401/404 —
/// this backend does not know our credentials) may trigger re-registration.
/// Transient failures (network, 5xx, malformed) must retry — or a backend
/// outage would recover into a register flood.
pub(crate) enum BeatOutcome {
    Success,
    Rejected,
    Transient,
}

pub(crate) fn beat_outcome(status: u16) -> BeatOutcome {
    match status {
        401 | 404 => BeatOutcome::Rejected,
        200..=299 => BeatOutcome::Success,
        _ => BeatOutcome::Transient,
    }
}

/// Minimum spacing between register attempts, persisted in status.json so a
/// plugin restart cannot reset the cooldown into a minting burst.
pub(crate) const REGISTER_COOLDOWN_MS: i64 = 5 * 60_000;

/// Register (or rebind — the backend is participant-idempotent, R51-3)
/// against the configured api and persist the credentials. Returns a
/// human-readable error string for status.json on failure.
fn register_share(
    client: &reqwest::blocking::Client,
    api: &str,
    config: &OwnerConfig,
) -> Result<bootstrap::ShareIdentity, String> {
    // A.1: registration is league-identity-bound — no signed ATL identity on
    // this machine means no share (fail-closed, the owner's keys unaffected).
    let (participant_id, private_key) =
        bootstrap::atl_identity(config).ok_or("no league identity on this machine")?;
    let credentials = bootstrap::register_identity(&private_key, &participant_id)
        .ok_or("signing the register payload failed")?;
    let mut body = bootstrap::register_body(config);
    for (key, value) in credentials.as_object().into_iter().flatten() {
        body[key.as_str()] = value.clone();
    }
    let response = client
        .post(format!("{}/api/shares/register", api))
        .json(&body)
        .send()
        .map_err(|error| format!("register transport: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("register rejected: HTTP {}", response.status()));
    }
    let body: Value = response
        .json()
        .map_err(|error| format!("register decode: {error}"))?;
    let share_id = str_of(&body, "shareId");
    let share_secret = str_of(&body, "shareSecret");
    if share_id.is_empty() || share_secret.is_empty() {
        return Err("register response missing credentials".to_string());
    }
    let identity = bootstrap::ShareIdentity { share_id, share_secret };
    bootstrap::save_identity(&identity.share_id, &identity.share_secret);
    Ok(identity)
}

/// One sync round. Panics are contained by the caller (catch_unwind).
/// Every exit path writes status.json (R51-4) — a failing tick must leave a
/// trace, never disappear silently.
pub(crate) fn tick() {
    let mut status = bootstrap::read_status();
    status.last_tick_at = now_ms();
    let config = bootstrap::read_owner_config();
    if config.api.is_empty() {
        // No owner onboarding yet: sharing off, owner's builtin keys untouched.
        with_runtime(|rt: &mut Runtime| rt.sync = SyncState::default());
        status.phase = "off".into();
        status.api = String::new();
        status.last_error = Some("no api configured in the CPA plugin config".into());
        bootstrap::write_status(&status);
        return;
    }
    let api = config.api.trim_end_matches('/').to_string();
    status.api = api.clone();
    // R53-1: advisory endpoint precheck — a LAN baseURL with a loopback-only
    // CPA bind is dead on arrival; surface it without blocking heartbeats
    status.endpoint_warning = bootstrap::endpoint_bind_warning(
        &bootstrap::current_base_url(&config),
        bootstrap::discover_cpa_bind().as_deref(),
    );

    let mut usage: Vec<UsageDelta> = with_runtime(|rt: &mut Runtime| std::mem::take(&mut rt.pending_usage))
        .unwrap_or_default();
    let owner_failures = with_runtime(|rt: &mut Runtime| std::mem::take(&mut rt.owner_failures))
        .unwrap_or(0);
    let usage_json: Vec<Value> = usage
        .iter()
        .map(|d| json!({ "keyId": d.key_id, "tokens": d.tokens, "requests": d.requests, "failed": d.failed }))
        .collect();

    let Some(client) = http_client() else {
        // same invariant as the Err branches below: the wall counter goes
        // back too, or a lost signal window would silently swallow failures
        with_runtime(|rt: &mut Runtime| rt.owner_failures += owner_failures);
        return_requeue(std::mem::take(&mut usage));
        status.phase = "error".into();
        status.last_error = Some("http client unavailable".into());
        bootstrap::write_status(&status);
        return;
    };

    // Credentials (R51-1) + configured api beat directly; reconciliation is
    // driven by the backend's response, never by a cached URL.
    let identity = bootstrap::load_identity();
    let mut need_register = identity.is_none();
    if identity.is_none() {
        // No credentials this tick: nothing can be acknowledged, so the
        // deltas must survive until a register + successful heartbeat clears
        // them (same invariant as the transport-failure paths).
        with_runtime(|rt: &mut Runtime| rt.owner_failures += owner_failures);
        return_requeue(std::mem::take(&mut usage));
    }
    if let Some(id) = &identity {
        let result = client
            .post(format!("{}/api/shares/heartbeat", api))
            .header("x-atl-share-secret", &id.share_secret)
            .json(&json!({
                "shareId": id.share_id,
                "pluginVersion": PLUGIN_VERSION,
                "baseURL": bootstrap::current_base_url(&config),
                "usage": usage_json,
                "wallSignals": { "ownerFailed": owner_failures },
                "tzOffsetMinutes": crate::tz_offset_minutes(),
            }))
            .send();
        match result {
            Ok(resp) if resp.status().is_success() => match resp.json::<Value>() {
                Ok(body) => {
                    let now = now_ms();
                    let settled = settled_map_of(&body);
                    with_runtime(move |rt: &mut Runtime| {
                        let window_day = str_of(&body, "windowDay");
                        rt.sync = parse_sync_response(&body, now);
                        restore_settled(&mut rt.ledger, &window_day, &settled);
                        restore_lane_settled(&mut rt.ledger, &rt.sync.lanes);
                    });
                    status.phase = "beating".into();
                    status.last_success_at = status.last_tick_at;
                    status.last_error = None;
                }
                Err(error) => {
                    with_runtime(|rt: &mut Runtime| rt.owner_failures += owner_failures);
                    return_requeue(std::mem::take(&mut usage));
                    status.phase = "error".into();
                    status.last_error = Some(format!("heartbeat decode: {error}"));
                }
            },
            Ok(resp) => {
                let rejected = matches!(beat_outcome(resp.status().as_u16()), BeatOutcome::Rejected);
                with_runtime(|rt: &mut Runtime| rt.owner_failures += owner_failures);
                return_requeue(std::mem::take(&mut usage));
                status.phase = "error".into();
                if rejected {
                    // definitive: this backend does not know the stored
                    // credentials — reconcile by re-registering (cooldown
                    // guarded; backend rebinds to the owner's active share)
                    if status.last_tick_at - status.last_register_attempt_at >= REGISTER_COOLDOWN_MS {
                        need_register = true;
                    } else {
                        status.last_error = Some("share rejected by backend; re-register cooling down".into());
                    }
                } else {
                    status.last_error = Some(format!("heartbeat status {}", resp.status()));
                }
            }
            Err(error) => {
                with_runtime(|rt: &mut Runtime| rt.owner_failures += owner_failures);
                return_requeue(std::mem::take(&mut usage));
                status.phase = "error".into();
                status.last_error = Some(format!("heartbeat transport: {error}"));
            }
        }
    }

    if need_register {
        if status.last_tick_at - status.last_register_attempt_at < REGISTER_COOLDOWN_MS {
            status.phase = "error".into();
            status.last_error = Some("register cooling down after a recent attempt".into());
        } else {
            status.phase = "registering".into();
            status.last_register_attempt_at = status.last_tick_at;
            bootstrap::write_status(&status);
            match register_share(&client, &api, &config) {
                Ok(_) => {
                    // credentials persisted; the next tick (8s) beats with them
                    status.phase = "registered".into();
                    status.last_error = None;
                }
                Err(error) => {
                    status.phase = "error".into();
                    status.last_error = Some(error);
                }
            }
        }
    }
    bootstrap::write_status(&status);
}

/// Heartbeat failed: nothing is acknowledged — merge the deltas back so the
/// next successful round reports the full backlog.
fn return_requeue(usage: Vec<UsageDelta>) {
    if usage.is_empty() {
        return;
    }
    with_runtime(|rt: &mut Runtime| {
        for delta in usage {
            merge_delta(&mut rt.pending_usage, delta);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beat_outcome_only_definitive_rejections_reregister() {
        assert!(matches!(beat_outcome(200), BeatOutcome::Success));
        assert!(matches!(beat_outcome(204), BeatOutcome::Success));
        assert!(matches!(beat_outcome(401), BeatOutcome::Rejected));
        assert!(matches!(beat_outcome(404), BeatOutcome::Rejected));
        // transient classes must NEVER trigger re-registration: a backend
        // outage recovering into a register flood is the failure R51-2 kills
        assert!(matches!(beat_outcome(500), BeatOutcome::Transient));
        assert!(matches!(beat_outcome(503), BeatOutcome::Transient));
        assert!(matches!(beat_outcome(400), BeatOutcome::Transient));
        assert!(matches!(beat_outcome(409), BeatOutcome::Transient));
    }

    #[test]
    fn parse_sync_response_extracts_contract_fields() {
        let resp = json!({
            "state": "active",
            "windowDay": "2026-09-13",
            "policy": { "budget": 1000000, "keyConcurrency": 3 },
            "keys": [
                { "keyId": "csk_1", "token": "atl_sk_a", "keyMaxTokens": 500, "expiresAtMs": 123 },
                { "keyId": "", "token": "broken" }
            ],
            "settledByKey": { "csk_1": 4321 }
        });
        let sync = parse_sync_response(&resp, 777);
        assert_eq!(sync.state, "active");
        assert_eq!(sync.window_day, "2026-09-13");
        assert_eq!(sync.budget, 1_000_000);
        assert_eq!(sync.key_concurrency, 3);
        assert_eq!(sync.keys.len(), 1);
        assert_eq!(sync.keys[0].key_id, "csk_1");
        assert_eq!(sync.keys[0].key_max_tokens, 500);
        assert_eq!(sync.last_sync_ms, 777);
        assert!(sync.configured);
        assert_eq!(settled_map_of(&resp).get("csk_1"), Some(&4321u64));
    }

    #[test]
    fn parse_sync_response_degrades_deny_safe() {
        let sync = parse_sync_response(&json!({}), 1);
        assert_ne!(sync.state, "active");
        assert_eq!(sync.budget, 0);
        assert!(sync.keys.is_empty());
    }

    #[test]
    fn requeue_merges_backlogs_instead_of_dropping() {
        let mut list = vec![UsageDelta { key_id: "a".into(), tokens: 5, requests: 1, failed: 0 }];
        merge_delta(&mut list, UsageDelta { key_id: "a".into(), tokens: 7, requests: 2, failed: 1 });
        merge_delta(&mut list, UsageDelta { key_id: "b".into(), tokens: 1, requests: 1, failed: 0 });
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].tokens, list[0].requests, list[0].failed), (12, 3, 1));
    }
}
