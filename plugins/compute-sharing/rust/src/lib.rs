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
            "owner-status" => Some(owner_call(OwnerCall::Status, args)),
            "owner-policy" => Some(owner_call(OwnerCall::Policy, args)),
            "owner-unregister" => Some(owner_call(OwnerCall::Unregister, args)),
            "owner-resume" => Some(owner_call(OwnerCall::Resume, args)),
            "owner-suggest" => Some(owner_suggest(ctx)),
            _ => None,
        }
    }
}

// ── borrower flows ──────────────────────────────────────────────────────────

/// Sign {kind:"share-claim", participantId, shareId, ts} with the league
/// identity key — the backend verifies the same chain as usage uploads.
/// The private key never leaves this process.
fn claim_sign(args: &Value) -> Result<Value, String> {
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

fn borrow_get() -> Result<Value, String> {
    let claims: Value = std::fs::read_to_string(collector_core::config::app_dir().join("sharing-borrow.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(json!({ "claims": [] }));
    Ok(claims)
}

fn borrow_set(args: &Value) -> Result<Value, String> {
    let claims = args
        .get("claims")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "borrow-set requires claims array".to_string())?;
    let sanitized: Vec<Value> = claims
        .iter()
        .filter_map(|c| {
            let key_id = c.get("keyId").and_then(|v| v.as_str())?;
            let token = c.get("token").and_then(|v| v.as_str())?;
            if key_id.is_empty() || token.is_empty() {
                return None;
            }
            let cap = |value: &str, max: usize| -> String { value.chars().take(max).collect() };
            Some(json!({
                "keyId": cap(key_id, 64),
                "token": cap(token, 200),
                "baseURL": cap(c.get("baseURL").and_then(|v| v.as_str()).unwrap_or(""), 200),
                "shareId": cap(c.get("shareId").and_then(|v| v.as_str()).unwrap_or(""), 64),
                "shareTitle": cap(c.get("shareTitle").and_then(|v| v.as_str()).unwrap_or(""), 60),
                "models": c.get("models").and_then(|v| v.as_array()).map(|list| {
                    json!(list.iter().take(50).filter_map(|m| m.as_str().map(|s| cap(s, 20))).collect::<Vec<_>>())
                }).unwrap_or(json!([])),
                "expiresAt": c.get("expiresAt").and_then(|v| v.as_i64()).unwrap_or(0),
            }))
        })
        .take(50)
        .collect();
    let dir = collector_core::config::app_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // tmp + rename: a crash mid-write must not truncate the claim list
    let borrow_path = dir.join("sharing-borrow.json");
    let tmp_path = dir.join("sharing-borrow.json.tmp");
    std::fs::write(&tmp_path, serde_json::to_string_pretty(&json!({ "claims": sanitized })).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, &borrow_path).map_err(|e| e.to_string())?;
    Ok(json!({ "claims": sanitized }))
}

// ── owner console proxy ─────────────────────────────────────────────────────

enum OwnerCall {
    Status,
    Policy,
    Unregister,
    Resume,
}

fn owner_identity() -> Result<(String, String, String), String> {
    let value: Value = std::fs::read_to_string(collector_core::config::app_dir().join("cpa-plugin/identity.json"))
        .map_err(|_| "not_registered".to_string())?
        .parse()
        .map_err(|_| "not_registered".to_string())?;
    let api = value.get("api").and_then(|v| v.as_str()).unwrap_or("").trim_end_matches('/').to_string();
    let share_id = value.get("shareId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let secret = value.get("shareSecret").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if api.is_empty() || share_id.is_empty() || secret.is_empty() {
        return Err("not_registered".into());
    }
    Ok((api, share_id, secret))
}

fn owner_call(call: OwnerCall, args: &Value) -> Result<Value, String> {
    let (api, _share_id, secret) = owner_identity()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = match call {
        OwnerCall::Unregister => client.post(format!("{}/api/shares/unregister", api)),
        OwnerCall::Resume => client.post(format!("{}/api/shares/owner/resume", api)),
        OwnerCall::Policy => client.post(format!("{}/api/shares/owner/policy", api)).json(&json!({
            "policy": args.get("policy").cloned().unwrap_or(Value::Null),
        })),
        OwnerCall::Status => client.get(format!("{}/api/shares/owner/status", api)),
    };
    request = request.header("x-atl-share-secret", &secret);
    let response = request.send().map_err(|e| format!("backend_unreachable:{}", e))?;
    let status = response.status();
    let body: Value = response.json().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("owner_http_{}:{}", status.as_u16(), body.get("error").and_then(|v| v.as_str()).unwrap_or("")));
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
mod tests {
    use super::*;
    use collector_core::plugin::route_plugin_command;
    use std::sync::Mutex;

    fn state(installed: bool) -> Value {
        if installed {
            json!({ "modules": { "compute-sharing": { "enabled": true } } })
        } else {
            json!({ "modules": {} })
        }
    }

    // These commands touch the real app dir (identity.json, sharing-borrow
    // store) — tests MUST run against a throwaway ATL_HOME, never the user's
    // live data. The lock serializes the env swap inside this binary.
    static SANDBOX_LOCK: Mutex<()> = Mutex::new(());
    fn sandboxed<T>(f: impl FnOnce() -> T) -> T {
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
    fn borrow_store_roundtrip_sanitizes_fields() {
        sandboxed(|| {
        let stored = route_plugin_command(
            &[Box::new(SharingPlugin)],
            "compute-sharing:borrow-set",
            &json!({ "claims": [
                { "keyId": "csk_1", "token": "atl_sk_x", "shareId": "shr_1", "expiresAt": 5 },
                { "keyId": "", "token": "broken" },
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
}
