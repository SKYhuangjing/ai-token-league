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
                        period: str_of(l, "period"),
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

/// First-run (or backend-switch) self-registration. The backend mints the
/// share identity under register-trust semantics; we persist it so CPA
/// restarts rebind to the same share instead of minting duplicates.
fn ensure_identity(api: &str, config: &OwnerConfig) -> Option<bootstrap::ShareIdentity> {
    if let Some(existing) = bootstrap::load_identity() {
        if existing.api == api {
            return Some(existing);
        }
    }
    // A.1: registration is league-identity-bound — no signed ATL identity on
    // this machine means no share (fail-closed, the owner's keys unaffected).
    let (participant_id, private_key) = bootstrap::atl_identity(config)?;
    let credentials = bootstrap::register_identity(&private_key, &participant_id)?;
    let mut body = bootstrap::register_body(config);
    for (key, value) in credentials.as_object().into_iter().flatten() {
        body[key.as_str()] = value.clone();
    }
    let client = http_client()?;
    let response = client
        .post(format!("{}/api/shares/register", api))
        .json(&body)
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().ok()?;
    let share_id = str_of(&body, "shareId");
    let share_secret = str_of(&body, "shareSecret");
    if share_id.is_empty() || share_secret.is_empty() {
        return None;
    }
    bootstrap::save_identity(api, &share_id, &share_secret);
    Some(bootstrap::ShareIdentity { api: api.to_string(), share_id, share_secret })
}

/// One sync round. Panics are contained by the caller (catch_unwind).
pub(crate) fn tick() {
    let config = bootstrap::read_owner_config();
    if config.api.is_empty() {
        // No owner onboarding yet: sharing off, owner's builtin keys untouched.
        with_runtime(|rt: &mut Runtime| rt.sync = SyncState::default());
        return;
    }
    let api = config.api.trim_end_matches('/').to_string();
    let Some(identity) = ensure_identity(&api, &config) else {
        // Registration failed (backend down / rejected): stay fail-closed and
        // retry next tick.
        return;
    };

    let usage: Vec<UsageDelta> = with_runtime(|rt: &mut Runtime| std::mem::take(&mut rt.pending_usage))
        .unwrap_or_default();
    let owner_failures = with_runtime(|rt: &mut Runtime| std::mem::take(&mut rt.owner_failures))
        .unwrap_or(0);
    let usage_json: Vec<Value> = usage
        .iter()
        .map(|d| json!({ "keyId": d.key_id, "tokens": d.tokens, "requests": d.requests, "failed": d.failed }))
        .collect();

    let Some(client) = http_client() else {
        // same invariant as the Err(_) branch below: the wall counter goes
        // back too, or a lost signal window would silently swallow failures
        with_runtime(|rt: &mut Runtime| rt.owner_failures += owner_failures);
        return return_requeue(usage);
    };
    let result = client
        .post(format!("{}/api/shares/heartbeat", identity.api))
        .header("x-atl-share-secret", &identity.share_secret)
        .json(&json!({
            "shareId": identity.share_id,
            "pluginVersion": PLUGIN_VERSION,
            "baseURL": bootstrap::current_base_url(&config),
            "usage": usage_json,
            "wallSignals": { "ownerFailed": owner_failures },
            "tzOffsetMinutes": crate::tz_offset_minutes(),
        }))
        .send();
    let response: Result<Value, ()> = match result {
        Ok(resp) if resp.status().is_success() => resp.json::<Value>().map_err(|_| ()),
        _ => Err(()),
    };
    match response {
        Ok(body) => {
            let now = now_ms();
            let settled = settled_map_of(&body);
            with_runtime(move |rt: &mut Runtime| {
                let window_day = str_of(&body, "windowDay");
                rt.sync = parse_sync_response(&body, now);
                restore_settled(&mut rt.ledger, &window_day, &settled);
                restore_lane_settled(&mut rt.ledger, &rt.sync.lanes);
            });
        }
        Err(_) => {
            // Heartbeat failed: the wall counter goes back too, or a lost
            // signal window would silently swallow owner failures.
            with_runtime(|rt: &mut Runtime| rt.owner_failures += owner_failures);
            return_requeue(usage)
        }
    }
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
