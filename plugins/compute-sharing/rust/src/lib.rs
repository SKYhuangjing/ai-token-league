// atl-plugin-sharing — compute-sharing privileged proxy (R46).
//
// Everything compute-sharing-specific lives in this crate, outside the
// platform code (R26 standard: sidecar/renderer carry zero plugin literals).
// The remote card renders in the webview and is NOT trusted with secrets, so
// every privileged operation rides this sidecar plugin instead:
//   claim-sign / borrow-get / borrow-set — league identity signing and the
//                                          local borrower claim store;
//   owner-status|policy|unregister|resume — backend proxy carrying the share
//                                          secret (identity.json → backend,
//                                          never into the webview);
//   owner-suggest — advisory lane budgets from the zhipu plugin's live
//                   windows + the owner's own CPA usage sqlite.
// The host dispatches "{id}:{sub}" on a blocking thread, so blocking HTTP and
// sqlite are fine here.

use collector_core::plugin::{PluginCtx, SidecarPlugin};
use serde_json::{json, Value};

pub mod flow;
pub struct SharingPlugin;

fn installed(ctx: &PluginCtx<'_>) -> bool {
    ctx.modules_state
        .pointer("/modules/compute-sharing")
        .is_some()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl SidecarPlugin for SharingPlugin {
    fn id(&self) -> &'static str {
        "compute-sharing"
    }

    fn handle(&self, sub: &str, args: &Value, ctx: PluginCtx<'_>) -> Option<Result<Value, String>> {
        if !installed(&ctx) {
            return Some(Err("plugin compute-sharing is not installed".into()));
        }
        match sub {
            "claim-sign" => Some(claim_sign(args)),
            "borrow-get" => Some(borrow_get()),
            "borrow-set" => Some(borrow_set(args)),
            // QA-05: the card passes only the CONFIRMED-dead key ids; the
            // mutation re-reads the store under the lock so a key another
            // process claimed in between always survives
            "borrow-prune" => Some(borrow_prune(args)),
            "borrow-test" => Some(borrow_test(args)),
            // borrower backend flows (crate = single implementation; the
            // terminal CLI routes here, the card rides the same commands)
            "directory" => Some(flow::run_directory()),
            "claim" => Some(flow::run_claim(args)),
            "renew" => Some(flow::run_renew(args)),
            "revoke" => Some(flow::run_revoke(args)),
            "live" => Some(flow::run_live()),
            "models" => Some(flow::run_models(args)),
            "owner-status" => Some(owner_call(OwnerCall::Status, args)),
            "owner-policy" => Some(owner_call(OwnerCall::Policy, args)),
            "owner-unregister" => Some(owner_call(OwnerCall::Unregister, args)),
            "owner-resume" => Some(owner_call(OwnerCall::Resume, args)),
            "owner-revoke-claim" => Some(owner_call(OwnerCall::RevokeClaim, args)),
            "owner-lane-action" => Some(owner_call(OwnerCall::LaneAction, args)),
            "owner-suggest" => Some(owner_suggest(ctx)),
            // V02: itemized first-share readiness — each gate reports its own
            // result instead of one generic "未注册"
            "doctor" => Some(doctor()),
            _ => None,
        }
    }
}

/// First-share readiness checks (V02). Distinguishes what the old flow
/// collapsed into "未注册": no league identity, no CPA-side share config,
/// no backend address, and a node that IS configured but failing.
fn doctor() -> Result<Value, String> {
    Ok(doctor_at(
        &collector_core::config::app_dir(),
        &flow::api_base().unwrap_or_default(),
        now_millis(),
    ))
}

// Explicit inputs keep diagnostics tests isolated from the user's config and
// make the freshness decision deterministic. status.api is the effective
// runtime address, including configuration delivered directly by the CPA host.
fn doctor_at(home: &std::path::Path, api_base: &str, now: i64) -> Value {
    let identity = home.join("cpa-plugin/identity.json").exists();
    let owner_config = home.join("cpa-plugin/config.json").exists();
    let status: Value = std::fs::read_to_string(home.join("cpa-plugin/status.json"))
        .ok()
        .and_then(|t| t.parse().ok())
        .unwrap_or(Value::Null);
    let phase = status["phase"].as_str().unwrap_or("");
    let last_success = status["lastSuccessAt"].as_i64().unwrap_or(0);
    let age = (last_success > 0).then(|| now.checked_sub(last_success)).flatten()
        .filter(|age| *age >= 0);
    let node_state = if phase != "beating" && phase != "registered" {
        "unknown"
    } else if last_success <= 0 || !matches!(age, Some(0..=60_000)) {
        "stale"
    } else {
        "online"
    };
    let cpa_api = status["api"].as_str().unwrap_or("").trim().trim_end_matches('/');
    let app_api = api_base.trim().trim_end_matches('/');
    let api_code = if app_api.is_empty() {
        Some("api_missing")
    } else if cpa_api.is_empty() {
        Some("api_unknown")
    } else if cpa_api != app_api {
        Some("api_mismatch")
    } else {
        None
    };
    let configured = owner_config || !cpa_api.is_empty();
    let api_hint = match api_code {
        Some("api_missing") => Some("App backend address is missing; set apiBaseUrl with the config command.".to_string()),
        Some("api_unknown") => Some("CPA has not reported its active backend address; start or restart CPA, then run share doctor again.".to_string()),
        Some("api_mismatch") => Some(format!("CPA backend {cpa_api} differs from App backend {app_api}; align the addresses and restart CPA.")),
        _ => None,
    };
    let node_code = match node_state {
        "online" => None,
        "stale" => Some("node_stale"),
        _ => Some("node_unknown"),
    };
    let node_hint = match node_state {
        "online" => None,
        "stale" => Some("No recent successful heartbeat; check that CPA is running, its clock is correct, and the backend is reachable."),
        _ => Some("No successful node status; start CPA with atl-share enabled and run share doctor again."),
    };
    let items = vec![
        json!({
            "id": "identity", "ok": identity,
            "code": if identity { None } else { Some("identity_missing") },
            "hint": if identity { None } else { Some("Share identity is missing; enable atl-share in CPA and start CPA to register this node.") },
        }),
        json!({
            "id": "ownerConfig", "ok": configured,
            "code": if configured { None } else { Some("config_missing") },
            "hint": if configured { None } else { Some("Configure atl-share's backend address in CPA and start CPA.") },
        }),
        json!({
            "id": "apiBase", "ok": api_code.is_none(), "value": app_api,
            "code": api_code, "params": { "cpaApi": cpa_api, "appApi": app_api }, "hint": api_hint,
        }),
        json!({
            "id": "node", "ok": node_state == "online", "value": node_state,
            "code": node_code, "params": { "ageSeconds": age.map(|age| age / 1000), "phase": phase }, "hint": node_hint,
        }),
    ];
    json!({ "ready": items.iter().all(|i| i["ok"] == true), "items": items })
}

// ── borrower flows ──────────────────────────────────────────────────────────

/// Sign {kind:"share-claim", participantId, shareId, ts} with the league
/// identity key — the backend verifies the same chain as usage uploads.
/// The private key never leaves this process.
pub(crate) fn claim_sign(args: &Value) -> Result<Value, String> {
    let share_id = args
        .get("shareId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "claim-sign requires shareId".to_string())?
        .to_string();
    let ts = args.get("ts").and_then(|v| v.as_i64()).unwrap_or_else(now_millis);
    let cfg = collector_core::config::load_config().ok_or("not initialized")?;
    if cfg.participant_id.is_empty() || cfg.identity_private_key.is_empty() {
        return Err("not initialized".into());
    }
    let payload = json!({
        "kind": "share-claim",
        "participantId": cfg.participant_id,
        "shareId": share_id,
        "ts": ts,
    });
    let signature = collector_core::crypto::sign_payload(&cfg.identity_private_key, &payload);
    Ok(json!({ "participantId": cfg.participant_id, "ts": ts, "signature": signature }))
}

/// Dead claims carry no value (user decision): expired ones drop on every
/// read and write so the store and every consumer (card, CLI) stay clean.
/// Revocation is only knowable from the backend live view — the card prunes
/// those after the claims/mine merge.
fn claim_alive(claim: &Value) -> bool {
    claim_alive_at(claim, now_millis())
}

fn claim_alive_at(claim: &Value, now: i64) -> bool {
    match claim.get("expiresAt").and_then(|v| v.as_i64()) {
        Some(at) if at > 0 => at > now,
        _ => true,
    }
}

pub(crate) fn borrow_get() -> Result<Value, String> {
    // R2-05: the read-side cleanup used to read WITHOUT the lock, filter the
    // stale snapshot, and hand the whole list to borrow_set — deleting a
    // claim another process had written in between. The cleanup now runs as
    // one locked read-modify-write over the freshest on-disk state.
    let (alive, receipts) = borrow_mutate(|claims| {
        let now = now_millis();
        let receipts: Vec<Value> = claims
            .iter()
            .filter(|c| !claim_alive_at(c, now))
            .map(|c| {
                json!({
                    "keyId": c.get("keyId").cloned().unwrap_or(Value::Null),
                    "shareTitle": c.get("shareTitle").cloned().unwrap_or(Value::Null),
                    "laneTitle": c.get("laneTitle").cloned().unwrap_or(Value::Null),
                    "reason": "expired",
                })
            })
            .collect();
        claims.retain(|c| claim_alive_at(c, now));
        (claims.clone(), receipts)
    })?;
    Ok(json!({ "claims": alive, "removed": receipts }))
}

/// Atomic cleanup: drop expired claims plus the explicitly revoked ids the
/// caller confirmed against the live view. Returns the surviving claims so
/// the caller renders authoritative data instead of its stale snapshot.
pub(crate) fn borrow_prune(args: &Value) -> Result<Value, String> {
    let revoke: Vec<String> = args
        .get("revoke")
        .and_then(|v| v.as_array())
        .map(|list| list.iter().filter_map(|k| k.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let surviving = borrow_mutate(|claims| {
        let now = now_millis();
        claims.retain(|c| {
            let expired = match c.get("expiresAt").and_then(|v| v.as_i64()) {
                Some(at) if at > 0 => at <= now,
                _ => false,
            };
            let revoked = c
                .get("keyId")
                .and_then(|v| v.as_str())
                .map(|k| revoke.iter().any(|r| r == k))
                .unwrap_or(false);
            !(expired || revoked)
        });
        claims.clone()
    })?;
    Ok(json!({ "claims": surviving }))
}

pub(crate) fn borrow_set(args: &Value) -> Result<Value, String> {
    // cross-process store lock: a CLI claim and a desktop card save must not
    // lose each other's update to sharing-borrow.json (re-entrant, so flow
    // cycles that already hold it are unaffected)
    let _guard = collector_core::store_lock::acquire("sharing-borrow", collector_core::store_lock::WRITE_WAIT)?;
    let claims = args
        .get("claims")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "borrow-set requires claims array".to_string())?;
    let sanitized = sanitize_claims(claims);
    write_claims(&sanitized)?;
    Ok(json!({ "claims": sanitized }))
}

/// QA-05: read-modify-write under ONE lock hold. The card's dead-claim
/// cleanup used to read a stale snapshot, filter, and overwrite the whole
/// array — deleting a key another process had claimed in between. Mutating
/// commands (prune / merge / renew / revoke) go through here: the closure
/// sees the freshest on-disk state inside the lock.
pub(crate) fn borrow_mutate<T>(f: impl FnOnce(&mut Vec<Value>) -> T) -> Result<T, String> {
    let _guard = collector_core::store_lock::acquire("sharing-borrow", collector_core::store_lock::WRITE_WAIT)?;
    let mut claims = read_claims_raw();
    let result = f(&mut claims);
    let sanitized = sanitize_claims(&claims);
    write_claims(&sanitized)?;
    Ok(result)
}

fn borrow_path() -> std::path::PathBuf {
    collector_core::config::app_dir().join("sharing-borrow.json")
}

fn read_claims_raw() -> Vec<Value> {
    std::fs::read_to_string(borrow_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("claims").and_then(|v| v.as_array()).cloned())
        .unwrap_or_default()
}

fn sanitize_claims(claims: &[Value]) -> Vec<Value> {
    claims
        .iter()
        .filter(|c| claim_alive(c))
        .filter_map(|c| {
            let key_id = c.get("keyId").and_then(|v| v.as_str())?;
            let token = c.get("token").and_then(|v| v.as_str())?;
            if key_id.is_empty() || token.is_empty() {
                return None;
            }
            let cap = |value: &str, max: usize| -> String { value.chars().take(max).collect() };
            let i64_of = |key: &str| c.get(key).and_then(|v| v.as_i64()).unwrap_or(0);
            Some(json!({
                "keyId": cap(key_id, 64),
                "token": cap(token, 200),
                "baseURL": cap(c.get("baseURL").and_then(|v| v.as_str()).unwrap_or(""), 200),
                "shareId": cap(c.get("shareId").and_then(|v| v.as_str()).unwrap_or(""), 64),
                "shareTitle": cap(c.get("shareTitle").and_then(|v| v.as_str()).unwrap_or(""), 60),
                // lane identity rides along or "my claims" can't tell which
                // lane of which owner a key belongs to (the claim response
                // carries all three)
                "laneId": cap(c.get("laneId").and_then(|v| v.as_str()).unwrap_or(""), 64),
                "laneTitle": cap(c.get("laneTitle").and_then(|v| v.as_str()).unwrap_or(""), 60),
                "tzLabel": cap(c.get("tzLabel").and_then(|v| v.as_str()).unwrap_or(""), 16),
                // quota fields (F02/CS-02): the borrower's "how much can I
                // use" survives the store roundtrip; 0 = unknown/legacy record
                "keyMaxTokens": i64_of("keyMaxTokens"),
                "keyConcurrency": i64_of("keyConcurrency"),
                "laneBudgetTokens": i64_of("laneBudgetTokens"),
                "window": c.get("window").filter(|v| v.is_object()).cloned().unwrap_or(json!({ "unit": "day", "n": 1 })),
                // model IDs ride FULL (CS-02): the old 20-char cap silently
                // truncated real ids ("gemini-3.8-flash-high" is 21) and the
                // generated tool config then shipped a broken model name
                "models": c.get("models").and_then(|v| v.as_array()).map(|list| {
                    json!(list.iter().take(50).filter_map(|m| m.as_str().map(|s| cap(s, 120))).collect::<Vec<_>>())
                }).unwrap_or(json!([])),
                "expiresAt": c.get("expiresAt").and_then(|v| v.as_i64()).unwrap_or(0),
            }))
        })
        .take(50)
        .collect()
}

fn write_claims(sanitized: &[Value]) -> Result<(), String> {
    let dir = collector_core::config::app_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // tmp + rename: a crash mid-write must not truncate the claim list
    let tmp_path = dir.join("sharing-borrow.json.tmp");
    std::fs::write(&tmp_path, serde_json::to_string_pretty(&json!({ "claims": sanitized })).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, borrow_path()).map_err(|e| e.to_string())?;
    Ok(())
}

// ── borrower connectivity test (G3) ──────────────────────────────────────────

/// One minimal generation through the owner's CPA with the claim token: the
/// borrower learns immediately whether their model choice rides the lane
/// (200) or hits a gate (429 lane closed / exhausted / model_not_in_lane).
/// The webview cannot make this call itself (no CORS on CPA), so the
/// privileged sidecar relays it. Cost: ~a few tokens.
fn borrow_test(args: &Value) -> Result<Value, String> {
    let token = args.get("token").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let base = args.get("baseURL").and_then(|v| v.as_str()).unwrap_or("").trim().trim_end_matches('/').to_string();
    let model = args.get("model").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if token.is_empty() || base.is_empty() || model.is_empty() {
        return Err("borrow-test requires token, baseURL and model".into());
    }
    // relay guard (review P2-2): the privileged sidecar must not become an
    // arbitrary-destination POST oracle — the target has to be exactly one of
    // this machine's own claims (token + baseURL pair from the local store)
    let stored: Value = std::fs::read_to_string(collector_core::config::app_dir().join("sharing-borrow.json"))
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(Value::Null);
    let owned = stored
        .get("claims")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter().any(|c| {
                c.get("token").and_then(|v| v.as_str()) == Some(token.as_str())
                    && c.get("baseURL").and_then(|v| v.as_str()).map(|b| b.trim_end_matches('/')) == Some(base.as_str())
            })
        })
        .unwrap_or(false);
    if !owned {
        return Err("borrow-test target is not one of your claims".into());
    }
    // CS-03: the probe must ride the protocol the target tool will use —
    // one protocol answering does not certify another. "chat" keeps the
    // legacy default so existing callers stay compatible.
    let protocol = args.get("protocol").and_then(|v| v.as_str()).unwrap_or("chat").trim().to_string();
    let client = reqwest::blocking::Client::builder()
        // direct connections only: these are deliberate calls to the owner's
        // CPA / the league backend — a system HTTP proxy (common on dev
        // machines) black-holes LAN endpoints like 10.x.x.x
        .no_proxy()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();
    let (url, body) = match protocol.as_str() {
        "chat" => (
            format!("{}/v1/chat/completions", base),
            json!({ "model": model, "max_tokens": 4, "messages": [{ "role": "user", "content": "ping" }] }),
        ),
        "responses" => (
            format!("{}/v1/responses", base),
            json!({ "model": model, "max_output_tokens": 16, "input": "ping" }),
        ),
        "anthropic" => (
            // CPA fronts Anthropic shape under /v1/messages with the bearer
            // token (the claim token is the only credential in play)
            format!("{}/v1/messages", base),
            json!({ "model": model, "max_tokens": 4, "messages": [{ "role": "user", "content": "ping" }] }),
        ),
        other => return Err(format!("borrow-test unknown protocol: {}", other)),
    };
    let response = client
        .post(url)
        .header("authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .map_err(|e| {
            // R53-2: a LAN endpoint that cannot even connect, on a machine
            // where CPA commonly binds loopback only, deserves the fix, not
            // a bare transport error
            let host = base.split_once("://").map(|(_, r)| r).unwrap_or(base.as_str());
            let host = host.split(['/']).next().unwrap_or("");
            let host = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
            let loopback = host == "localhost" || host == "::1" || host.split('.').next() == Some("127");
            if loopback {
                format!("transport:{}", e)
            } else {
                format!("transport:{} — endpoint {} unreachable; if CPA listens on 127.0.0.1 only, set host: 0.0.0.0 in the CPA config", e, host)
            }
        })?;
    let latency_ms = started.elapsed().as_millis() as u64;
    let status = response.status().as_u16();
    let body: Value = response.json().unwrap_or(Value::Null);
    let error = body
        .pointer("/error/message")
        .or_else(|| body.pointer("/error"))
        .and_then(|v| v.as_str())
        .map(|s| s.chars().take(200).collect::<String>());
    Ok(json!({ "ok": (200..=299).contains(&status), "status": status, "protocol": protocol, "model": model, "latencyMs": latency_ms, "error": error }))
}

// ── owner console proxy ─────────────────────────────────────────────────────

enum OwnerCall {
    Status,
    Policy,
    Unregister,
    Resume,
    RevokeClaim,
    LaneAction,
}

fn owner_identity() -> Result<(String, String, String), String> {
    // R51-1: the backend URL follows the app's configured apiBase (same
    // truth the leaderboard and every other card use). The identity file
    // carries credentials only — its legacy cached api caused owner-status
    // to hit a dead local backend while the app itself pointed at the cloud.
    let api = flow::api_base()?;
    let value: Value = std::fs::read_to_string(collector_core::config::app_dir().join("cpa-plugin/identity.json"))
        .map_err(|_| "not_registered".to_string())?
        .parse()
        .map_err(|_| "not_registered".to_string())?;
    let share_id = value.get("shareId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let secret = value.get("shareSecret").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if share_id.is_empty() || secret.is_empty() {
        return Err("not_registered".into());
    }
    Ok((api, share_id, secret))
}

/// Plugin runtime status (R51-4): merged into owner-status so the card can
/// show WHY the share is offline instead of a bare "plugin offline" badge.
/// Missing file degrades silently — the backend view stays authoritative.
fn plugin_status_value() -> Option<Value> {
    let text = std::fs::read_to_string(collector_core::config::app_dir().join("cpa-plugin/status.json")).ok()?;
    let value: Value = text.parse().ok()?;
    let cap = |v: &Value, max: usize| -> String { v.as_str().unwrap_or("").chars().take(max).collect() };
    Some(json!({
        "phase": cap(value.get("phase").unwrap_or(&Value::Null), 24),
        "lastError": value.get("lastError").and_then(|v| v.as_str()).map(|s| cap(&Value::from(s), 160)),
        "endpointWarning": value.get("endpointWarning").and_then(|v| v.as_str()).map(|s| cap(&Value::from(s), 220)),
        "lastTickAt": value.get("lastTickAt").and_then(|v| v.as_i64()).unwrap_or(0),
        "lastSuccessAt": value.get("lastSuccessAt").and_then(|v| v.as_i64()).unwrap_or(0),
        "api": cap(value.get("api").unwrap_or(&Value::Null), 120),
    }))
}

/// Owner-policy wire body: forwards both knobs the card sends. `lanes` must
/// ride along or the backend (which replaces lanes only when the array is
/// present) silently ignores every lane add/edit/delete.
fn owner_policy_body(args: &Value) -> Value {
    json!({
        "policy": args.get("policy").cloned().unwrap_or(Value::Null),
        "lanes": args.get("lanes").cloned().unwrap_or(Value::Null),
    })
}

fn owner_call(call: OwnerCall, args: &Value) -> Result<Value, String> {
    let (api, _share_id, secret) = owner_identity()?;
    let client = reqwest::blocking::Client::builder()
        // direct connections only: these are deliberate calls to the owner's
        // CPA / the league backend — a system HTTP proxy (common on dev
        // machines) black-holes LAN endpoints like 10.x.x.x
        .no_proxy()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = match call {
        OwnerCall::Unregister => client.post(format!("{}/api/shares/unregister", api)),
        OwnerCall::Resume => client.post(format!("{}/api/shares/owner/resume", api)),
        OwnerCall::Policy => client.post(format!("{}/api/shares/owner/policy", api)).json(&owner_policy_body(args)),
        OwnerCall::Status => client.get(format!("{}/api/shares/owner/status", api)),
        // CS-07: single-key revoke and per-lane pause/resume/terminate ride
        // the same owner-secret channel; bodies are forwarded verbatim so
        // the backend's validation stays the single authority.
        OwnerCall::RevokeClaim => client.post(format!("{}/api/shares/owner/claims/revoke", api)).json(&json!({
            "keyId": args.get("keyId").cloned().unwrap_or(Value::Null),
            "reason": args.get("reason").cloned().unwrap_or(Value::Null),
        })),
        OwnerCall::LaneAction => client.post(format!("{}/api/shares/owner/lane-action", api)).json(&json!({
            "laneId": args.get("laneId").cloned().unwrap_or(Value::Null),
            "action": args.get("action").cloned().unwrap_or(Value::Null),
        })),
    };
    request = request.header("x-atl-share-secret", &secret);
    let response = request.send().map_err(|e| format!("backend_unreachable:{}", e))?;
    let status = response.status();
    let mut body: Value = response.json().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("owner_http_{}:{}", status.as_u16(), body.get("error").and_then(|v| v.as_str()).unwrap_or("")));
    }
    if matches!(call, OwnerCall::Status) {
        if let Some(plugin_status) = plugin_status_value() {
            if let Some(object) = body.as_object_mut() {
                object.insert("pluginStatus".into(), plugin_status);
            }
        }
    }
    Ok(body)
}

// ── lane suggestions derived from the owner's own CPA usage ─────────────────
//
// Productized (R49): no vendor facts live in code. Families are derived from
// the model names the owner actually used; the busy window is computed from
// their own hour-of-day histogram; the card turns both into editable
// pre-fills (reserve ratio is a card-side knob, not a constant here).

/// zhipu windows come from the zhipu plugin's own cached query (crate-level
/// reuse, no duplicated fetcher). Any failure degrades to an empty section —
/// the card renders hints only.
fn owner_suggest(ctx: PluginCtx<'_>) -> Result<Value, String> {
    let (zhipu_enabled, alerts_on) = plugin_zhipu::host::gate(ctx.modules_state);
    let _ = zhipu_enabled;
    let keys = ctx
        .modules_state
        .pointer("/modules/zhipu-plan/config/keys")
        .cloned()
        .unwrap_or(Value::Null);
    let zhipu = plugin_zhipu::host::usage_cached(&json!({ "keys": keys }), alerts_on);

    let mut rows: Vec<(String, u8, i64)> = Vec::new();
    if let Some(db) = cpa_usage_db_path() {
        if let Ok(connection) = rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) {
            let week_ago = now_millis() - 7 * 86_400_000;
            // schema drift / locked db degrade to an empty list: a broken
            // CPA usage.db must not kill the zhipu suggestions
            if let Ok(mut statement) = connection.prepare(
                "SELECT model, substr(local_hour, -2), SUM(input_tokens + output_tokens + cached_tokens + IFNULL(cache_creation_tokens, 0))
                 FROM usage_events WHERE timestamp_ms >= ?1 AND model != ''
                 GROUP BY model, substr(local_hour, -2)",
            ) {
                if let Ok(mapped) = statement.query_map([week_ago], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
                }) {
                    for row in mapped.flatten() {
                        if let Ok(hour) = row.1.parse::<u8>() {
                            if hour < 24 {
                                rows.push((row.0, hour, row.2));
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(json!({ "zhipu": zhipu, "families": families_json(&fold_family_hours(&rows)) }))
}

/// Model family wildcard: the segment before the first '-' plus "-*"
/// ("gemini-3.8-flash-high" → "gemini-*"). Empty names fold to None.
fn family_of(model: &str) -> Option<String> {
    let name = model.trim();
    if name.is_empty() {
        return None;
    }
    let prefix = name.split('-').next().unwrap_or("");
    if prefix.is_empty() {
        return None;
    }
    Some(format!("{}-*", prefix.to_lowercase()))
}

/// Fold (model, hour-of-day, tokens) rows into one 24-hour histogram per family.
fn fold_family_hours(rows: &[(String, u8, i64)]) -> Vec<(String, [i64; 24])> {
    let mut folded: Vec<(String, [i64; 24])> = Vec::new();
    for (model, hour, tokens) in rows {
        let Some(family) = family_of(model) else { continue };
        let hour = *hour as usize;
        match folded.iter_mut().find(|(f, _)| f == &family) {
            Some((_, hist)) => hist[hour] += *tokens,
            None => {
                let mut hist = [0i64; 24];
                hist[hour] = *tokens;
                folded.push((family, hist));
            }
        }
    }
    folded
}

/// The owner's busy window for one family: the contiguous circular block of
/// 2..=12 hours holding the most usage. None when no block reaches 50% — a
/// flat profile gets an all-day suggestion instead of an arbitrary cut.
fn busy_window(hours: &[i64; 24]) -> Option<(String, String)> {
    let total: i64 = hours.iter().sum();
    if total <= 0 {
        return None;
    }
    let mut best: Option<(i64, usize, usize)> = None; // (sum, len, start)
    for len in 2..=12usize {
        for start in 0..24usize {
            let mut sum = 0i64;
            for i in 0..len {
                sum += hours[(start + i) % 24];
            }
            let better = match best {
                None => true,
                Some((best_sum, best_len, _)) => sum > best_sum || (sum == best_sum && len < best_len),
            };
            if better {
                best = Some((sum, len, start));
            }
        }
    }
    let (sum, len, start) = best?;
    // strictly above half: a flat profile's longest block sits at exactly 50%
    // and must not read as a peak
    if sum * 2 <= total {
        return None;
    }
    let fmt = |hour: usize| format!("{:02}:00", hour);
    Some((fmt(start), fmt((start + len) % 24)))
}

/// Families as wire data: drop noise (< 1M weekly tokens), sort by weight,
/// cap at 4, each with its derived busy window (null when flat).
fn families_json(families: &[(String, [i64; 24])]) -> Value {
    let mut list: Vec<(i64, &[i64; 24], &String)> = families
        .iter()
        .map(|(family, hist)| (hist.iter().sum(), hist, family))
        .filter(|(total, _, _)| *total >= 1_000_000)
        .collect();
    list.sort_by(|a, b| b.0.cmp(&a.0));
    list.truncate(4);
    Value::Array(
        list.into_iter()
            .map(|(total, hist, family)| {
                let busy = busy_window(hist)
                    .map(|(start, end)| json!({ "start": start, "end": end }))
                    .unwrap_or(Value::Null);
                json!({ "family": family, "weeklyTokens": total, "busy": busy })
            })
            .collect(),
    )
}

/// The CPA GUI usage db: env override first, then the macOS GUI default.
fn cpa_usage_db_path() -> Option<std::path::PathBuf> {
    if let Ok(path) = std::env::var("ATL_CPA_USAGE_DB") {
        if !path.trim().is_empty() {
            return Some(std::path::PathBuf::from(path));
        }
    }
    let home = std::env::var("HOME").ok()?;
    let candidate = std::path::PathBuf::from(home)
        .join("Library/Application Support/com.cpa.gui/usage-records/usage.db");
    candidate.exists().then_some(candidate)
}

#[cfg(test)]
pub(crate) mod test_sandbox {
    use std::sync::Mutex;

    // These commands touch the real app dir (identity.json, sharing-borrow
    // store) — tests MUST run against a throwaway ATL_HOME, never the user's
    // live data. One lock shared by every test module in this crate: the env
    // swap is process-global, so separate locks would let tests clobber each
    // other's ATL_HOME.
    static SANDBOX_LOCK: Mutex<()> = Mutex::new(());

    pub fn sandboxed<T>(f: impl FnOnce() -> T) -> T {
        let _guard = SANDBOX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("atl-sharing-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let previous = std::env::var("ATL_HOME").ok();
        std::env::set_var("ATL_HOME", &dir);
        let out = f();
        match previous {
            Some(value) => std::env::set_var("ATL_HOME", value),
            None => std::env::remove_var("ATL_HOME"),
        }
        let _ = std::fs::remove_dir_all(&dir);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use collector_core::plugin::route_plugin_command;
    use serde_json::json;

    fn state(installed: bool) -> Value {
        if installed {
            json!({ "modules": { "compute-sharing": { "enabled": true } } })
        } else {
            json!({ "modules": {} })
        }
    }

    use crate::test_sandbox::sandboxed;

    #[test]
    fn commands_refuse_when_not_installed() {
        let out = route_plugin_command(
            &[Box::new(SharingPlugin)],
            "compute-sharing:owner-status",
            &json!({}),
            &state(false),
        );
        assert_eq!(out, Some(Err("plugin compute-sharing is not installed".into())));
    }

    #[test]
    fn claim_sign_requires_share_id() {
        // shareId validation fires before any config read — safe unsandboxed
        let out = route_plugin_command(
            &[Box::new(SharingPlugin)],
            "compute-sharing:claim-sign",
            &json!({}),
            &state(true),
        )
        .unwrap();
        assert!(out.unwrap_err().contains("shareId"));
    }

    #[test]
    fn owner_status_maps_to_not_registered_without_identity() {
        sandboxed(|| {
            // production sequence: the app has an api base configured, but
            // no share identity exists yet (R51: api comes from app config)
            let home = std::env::var("ATL_HOME").unwrap_or_default();
            std::fs::write(
                std::path::PathBuf::from(&home).join("config.json"),
                r#"{ "participantId": "p_t", "identityPublicKey": "k", "identityPrivateKey": "s", "deviceId": "d_t", "apiBaseUrl": "http://backend.test", "nickname": "t" }"#,
            )
            .unwrap();
            let out = route_plugin_command(
                &[Box::new(SharingPlugin)],
                "compute-sharing:owner-status",
                &json!({}),
                &state(true),
            )
            .unwrap();
            assert_eq!(out.unwrap_err(), "not_registered");
        });
    }

    #[test]
    fn borrow_test_rejects_targets_outside_own_claims() {
        sandboxed(|| {
            let err = borrow_test(&json!({ "token": "atl_sk_x", "baseURL": "http://evil:1", "model": "m" }))
                .unwrap_err();
            assert!(err.contains("not one of your claims"), "{err}");
        });
    }

    #[test]
    fn owner_status_reports_no_api_base_without_app_config() {
        sandboxed(|| {
            let out = route_plugin_command(
                &[Box::new(SharingPlugin)],
                "compute-sharing:owner-status",
                &json!({}),
                &state(true),
            )
            .unwrap();
            assert_eq!(out.unwrap_err(), "no_api_base");
        });
    }

    #[test]
    fn borrow_store_roundtrip_sanitizes_fields() {
        sandboxed(|| {
        let stored = route_plugin_command(
            &[Box::new(SharingPlugin)],
            "compute-sharing:borrow-set",
            &json!({ "claims": [
                { "keyId": "csk_1", "token": "atl_sk_x", "shareId": "shr_1", "expiresAt": 9_000_000_000_000i64,
                  "laneId": "glm-5h", "laneTitle": "智谱 5h 窗", "tzLabel": "UTC+8",
                  "keyMaxTokens": 30000000i64, "keyConcurrency": 4, "laneBudgetTokens": 90000000i64,
                  "window": { "unit": "hour", "n": 5 },
                  "models": ["glm-*", "gemini-3.8-flash-high"] },
                { "keyId": "", "token": "broken" },
                // expired claims drop on write — dead keys never persist
                { "keyId": "csk_dead", "token": "atl_sk_old", "expiresAt": 1 },
            ]}),
            &state(true),
        )
        .unwrap()
        .unwrap();
        assert_eq!(stored["claims"].as_array().unwrap().len(), 1);
        let read_back = route_plugin_command(
            &[Box::new(SharingPlugin)],
            "compute-sharing:borrow-get",
            &json!({}),
            &state(true),
        )
        .unwrap()
        .unwrap();
        assert_eq!(read_back["claims"][0]["keyId"], "csk_1");
        // lane identity must survive the store roundtrip or "my claims"
        // cannot tell which lane of which owner a key belongs to
        assert_eq!(read_back["claims"][0]["laneId"], "glm-5h");
        assert_eq!(read_back["claims"][0]["laneTitle"], "智谱 5h 窗");
        assert_eq!(read_back["claims"][0]["tzLabel"], "UTC+8");
        // quota fields survive too (CS-02), and model ids keep their full
        // length — the old 20-char cap truncated "gemini-3.8-flash-high"
        assert_eq!(read_back["claims"][0]["keyMaxTokens"], 30000000i64);
        assert_eq!(read_back["claims"][0]["keyConcurrency"], 4);
        assert_eq!(read_back["claims"][0]["laneBudgetTokens"], 90000000i64);
        assert_eq!(read_back["claims"][0]["window"]["unit"], "hour");
        assert_eq!(read_back["claims"][0]["window"]["n"], 5);
        assert_eq!(read_back["claims"][0]["models"][1], "gemini-3.8-flash-high");
        });
    }

#[test]
    fn borrow_prune_keeps_claims_added_by_another_process() {
        // QA-05 acceptance probe: the UI computed its cleanup list from a
        // stale snapshot while a CLI claim landed in between. The atomic
        // prune (key-id list + lock-held re-read) must keep the new claim.
        sandboxed(|| {
            route_plugin_command(
                &[Box::new(SharingPlugin)],
                "compute-sharing:borrow-set",
                &json!({ "claims": [
                    { "keyId": "old", "token": "atl_sk_old", "expiresAt": 9_000_000_000_000i64 },
                ]}),
                &state(true),
            )
            .unwrap()
            .unwrap();
            // interleave: another process claims "new" (the flow merge rides
            // borrow_mutate under the same lock)
            flow::merge_claim_record_for_probe(&json!({
                "keyId": "new", "token": "atl_sk_new", "expiresAt": 9_000_000_000_000i64,
            }))
            .unwrap();
            // the UI's prune names only the key it CONFIRMED dead
            let out = route_plugin_command(
                &[Box::new(SharingPlugin)],
                "compute-sharing:borrow-prune",
                &json!({ "revoke": ["old"] }),
                &state(true),
            )
            .unwrap()
            .unwrap();
            let ids: Vec<&str> = out["claims"].as_array().unwrap()
                .iter().map(|c| c["keyId"].as_str().unwrap()).collect();
            assert_eq!(ids, vec!["new"], "the interloper claim must survive");
            // and expired-only pruning works without any revoke list
            std::fs::write(
                std::path::PathBuf::from(std::env::var("ATL_HOME").unwrap_or_default()).join("sharing-borrow.json"),
                r#"{ "claims": [
                    { "keyId": "fresh", "token": "atl_sk_f", "expiresAt": 9000000000000 },
                    { "keyId": "stale", "token": "atl_sk_s", "expiresAt": 1 }
                ] }"#,
            )
            .unwrap();
            let out2 = route_plugin_command(
                &[Box::new(SharingPlugin)],
                "compute-sharing:borrow-prune",
                &json!({}),
                &state(true),
            )
            .unwrap()
            .unwrap();
            let ids2: Vec<&str> = out2["claims"].as_array().unwrap()
                .iter().map(|c| c["keyId"].as_str().unwrap()).collect();
            assert_eq!(ids2, vec!["fresh"]);
        });
    }


    fn unique_test_home(label: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let home = std::env::temp_dir().join(format!("atl-sharing-{label}-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(home.join("cpa-plugin")).unwrap();
        home
    }

    fn wait_for_marker(path: &std::path::Path) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !path.exists() {
            assert!(std::time::Instant::now() < deadline, "missing marker {}", path.display());
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    #[ignore = "child entry point invoked by borrow_get_cleanup_never_drops_cross_process_writes"]
    fn borrow_get_cross_process_child() {
        let home = std::path::PathBuf::from(std::env::var("ATL_HOME").expect("isolated child home"));
        match std::env::var("ATL_SHARING_TEST_ROLE").unwrap().as_str() {
            "writer" => {
                let _lock = collector_core::store_lock::acquire("sharing-borrow", collector_core::store_lock::WRITE_WAIT).unwrap();
                std::fs::write(home.join("writer-held"), "").unwrap();
                wait_for_marker(&home.join("release-writer"));
                borrow_set(&json!({ "claims": [{ "keyId": "new", "token": "fixture-token", "expiresAt": 9_000_000_000_000i64 }] })).unwrap();
            }
            "reader" => {
                std::fs::write(home.join("reader-started"), "").unwrap();
                let result = borrow_get().unwrap();
                assert_eq!(result["claims"][0]["keyId"], "new");
                assert!(result["removed"].as_array().unwrap().is_empty());
                std::fs::write(home.join("reader-done"), "").unwrap();
            }
            _ => panic!("invalid child role"),
        }
    }

    #[test]
    fn borrow_get_cleanup_never_drops_cross_process_writes() {
        // Two real child processes share one isolated store. The writer
        // holds the production flock while the reader enters borrow_get;
        // cleanup must read only AFTER the writer publishes the new claim.
        let home = unique_test_home("cleanup");
        std::fs::write(home.join("sharing-borrow.json"), r#"{"claims":[{"keyId":"expired","token":"fixture-expired","expiresAt":1}]}"#).unwrap();
        let spawn = |role: &str| std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "tests::borrow_get_cross_process_child", "--nocapture"])
            .env("ATL_HOME", &home)
            .env("ATL_SHARING_TEST_ROLE", role)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn().unwrap();
        let writer = spawn("writer");
        wait_for_marker(&home.join("writer-held"));
        let mut reader = spawn("reader");
        wait_for_marker(&home.join("reader-started"));
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(reader.try_wait().unwrap().is_none(), "reader must wait for the writer's flock");
        assert!(!home.join("reader-done").exists());
        std::fs::write(home.join("release-writer"), "").unwrap();
        for child in [writer, reader] {
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success(), "child failed: {} {}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        }
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(home.join("sharing-borrow.json")).unwrap()).unwrap();
        assert_eq!(saved["claims"].as_array().unwrap().len(), 1);
        assert_eq!(saved["claims"][0]["keyId"], "new");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn doctor_uses_host_runtime_api_without_config_file() {
        let home = unique_test_home("doctor");
        std::fs::write(home.join("cpa-plugin/identity.json"), "{}").unwrap();
        let now = 120_000;
        let missing = doctor_at(&home, "https://app.example", now);
        assert_eq!(missing["items"][3]["code"], "node_unknown");
        assert!(missing["items"][3]["params"]["ageSeconds"].is_null());
        let write_status = |api: &str| std::fs::write(home.join("cpa-plugin/status.json"), json!({ "phase": "beating", "api": api, "lastSuccessAt": now }).to_string()).unwrap();
        write_status("https://host.example");
        let out = doctor_at(&home, "https://app.example", now);
        assert_eq!(out["ready"], false);
        assert_eq!(out["items"][1]["ok"], true, "host-delivered config is supported");
        assert_eq!(out["items"][2]["code"], "api_mismatch");
        assert_eq!(out["items"][2]["params"]["cpaApi"], "https://host.example");
        assert_eq!(out["items"][3]["value"], "online");
        // A stale fallback file must not override the active runtime address.
        std::fs::write(home.join("cpa-plugin/config.json"), r#"{"api":"https://old.example"}"#).unwrap();
        write_status("https://app.example/");
        assert_eq!(doctor_at(&home, "https://app.example", now)["ready"], true);
        write_status("");
        assert_eq!(doctor_at(&home, "https://app.example", now)["items"][2]["code"], "api_unknown");
        assert_eq!(doctor_at(&home, "https://app.example", now)["ready"], false);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn doctor_rejects_stale_and_future_heartbeats() {
        let home = unique_test_home("freshness");
        std::fs::write(home.join("cpa-plugin/identity.json"), "{}").unwrap();
        let now = 120_000;
        for (last_success, expected) in [(now, "online"), (now - 60_000, "online"), (now - 60_001, "stale"), (now + 1, "stale"), (0, "stale")] {
            std::fs::write(home.join("cpa-plugin/status.json"), json!({ "phase": "beating", "api": "https://app.example", "lastSuccessAt": last_success }).to_string()).unwrap();
            let out = doctor_at(&home, "https://app.example", now);
            assert_eq!(out["items"][3]["value"], expected);
            assert_eq!(out["ready"], expected == "online");
            if last_success <= 0 || last_success > now {
                assert!(out["items"][3]["params"]["ageSeconds"].is_null());
            }
        }
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn borrow_get_drops_expired_from_store_file() {
        sandboxed(|| {
            // a store file written before the filter (or by an older build)
            // still yields only alive claims to every consumer
            let home = std::env::var("ATL_HOME").unwrap_or_default();
            std::fs::create_dir_all(std::path::PathBuf::from(&home)).unwrap();
            std::fs::write(
                std::path::PathBuf::from(&home).join("sharing-borrow.json"),
                r#"{ "claims": [
                    { "keyId": "csk_old", "token": "atl_sk_old", "expiresAt": 1 },
                    { "keyId": "csk_live", "token": "atl_sk_live", "expiresAt": 9000000000000 }
                ] }"#,
            )
            .unwrap();
            let out = route_plugin_command(
                &[Box::new(SharingPlugin)],
                "compute-sharing:borrow-get",
                &json!({}),
                &state(true),
            )
            .unwrap()
            .unwrap();
            let list = out["claims"].as_array().unwrap();
            assert_eq!(list.len(), 1);
            assert_eq!(list[0]["keyId"], "csk_live");
            // cleanup receipt (CS-04): the dropped claim is explained, not silent
            let removed = out["removed"].as_array().unwrap();
            assert_eq!(removed.len(), 1);
            assert_eq!(removed[0]["keyId"], "csk_old");
            assert_eq!(removed[0]["reason"], "expired");
            // the store on disk no longer carries the dead claim
            let stored: Value = std::fs::read_to_string(
                std::path::PathBuf::from(&home).join("sharing-borrow.json"),
            )
            .unwrap()
            .parse()
            .unwrap();
            assert_eq!(stored["claims"].as_array().unwrap().len(), 1);
            // a clean read reports no removals
            let again = route_plugin_command(
                &[Box::new(SharingPlugin)],
                "compute-sharing:borrow-get",
                &json!({}),
                &state(true),
            )
            .unwrap()
            .unwrap();
            assert_eq!(again["removed"].as_array().unwrap().len(), 0);
        });
    }

    #[test]
    fn family_of_derives_wildcard_prefix() {
        assert_eq!(family_of("gemini-3.8-flash-high").as_deref(), Some("gemini-*"));
        assert_eq!(family_of("GLM-5.3").as_deref(), Some("glm-*"));
        assert_eq!(family_of("opus").as_deref(), Some("opus-*"));
        assert_eq!(family_of("  "), None);
        assert_eq!(family_of(""), None);
    }

    #[test]
    fn fold_family_hours_merges_models_and_hours() {
        let folded = fold_family_hours(&[
            ("gemini-3.8-flash-high".into(), 15, 100),
            ("gemini-2.5-pro".into(), 16, 50),
            ("gpt-5.6-terra".into(), 9, 10),
            ("gpt-5.6-terra".into(), 9, 5),
            ("".into(), 3, 999),
        ]);
        assert_eq!(folded.len(), 2);
        let (gemini, gemini_hist) = &folded[0];
        assert_eq!(gemini, "gemini-*");
        assert_eq!(gemini_hist[15], 100);
        assert_eq!(gemini_hist[16], 50);
        let (_, gpt_hist) = &folded[1];
        assert_eq!(gpt_hist[9], 15);
    }

    #[test]
    fn busy_window_finds_peak_and_none_for_flat() {
        let mut peak = [0i64; 24];
        for hour in 15..21 {
            peak[hour] = 10;
        }
        peak[3] = 2;
        let (start, end) = busy_window(&peak).expect("clear peak expected");
        assert_eq!((start.as_str(), end.as_str()), ("15:00", "21:00"));

        let flat = [7i64; 24];
        assert!(busy_window(&flat).is_none());

        // wrap-midnight peak: busy 23:00–02:00
        let mut wrap = [0i64; 24];
        for hour in [23, 0, 1] {
            wrap[hour] = 10;
        }
        let (start, end) = busy_window(&wrap).expect("wrap peak expected");
        assert_eq!((start.as_str(), end.as_str()), ("23:00", "02:00"));
    }

    #[test]
    fn families_json_filters_sorts_and_caps() {
        let mut big = [0i64; 24];
        big[10] = 9_000_000;
        let mut small = [0i64; 24];
        small[10] = 500_000; // below the 1M noise floor
        let mut mid = [0i64; 24];
        mid[12] = 2_000_000;
        let value = families_json(&[
            ("small-*".into(), small),
            ("big-*".into(), big),
            ("mid-*".into(), mid),
        ]);
        let list = value.as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["family"], "big-*");
        assert_eq!(list[0]["weeklyTokens"], json!(9_000_000));
        // a single-hour spike is a peak: min window length widens it to 2h
        assert_eq!(list[1]["busy"]["start"], "11:00");
        assert_eq!(list[1]["busy"]["end"], "13:00");
    }

    #[test]
    fn owner_policy_body_forwards_lanes() {
        // regression: the sidecar used to forward policy only, so every card
        // lane save silently no-oped (backend updates lanes only when the
        // array is present on the wire)
        let lanes = json!([{ "id": "glm", "title": "GLM", "models": ["glm-*"], "budget": { "tokens": 1000 } }]);
        let body = owner_policy_body(&json!({ "lanes": lanes, "policy": { "keyMaxTokens": 5 } }));
        assert_eq!(body["lanes"], lanes);
        assert_eq!(body["policy"]["keyMaxTokens"], 5);
        // policy-only saves keep working: lanes rides as null, which the
        // backend skips (not an array)
        let policy_only = owner_policy_body(&json!({ "policy": { "ttlHours": 24 } }));
        assert!(policy_only.get("lanes").unwrap().is_null());
        assert_eq!(policy_only["policy"]["ttlHours"], 24);
    }
}
