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

// ── lane budget suggestions (advisory) ──────────────────────────────────────

/// zhipu windows come from the zhipu plugin's own cached query (crate-level
/// reuse, no duplicated fetcher); cpaWeekly reads the CPA GUI usage sqlite.
/// Any failure degrades to an empty section — the card renders hints only.
fn owner_suggest(ctx: PluginCtx<'_>) -> Result<Value, String> {
    let (zhipu_enabled, alerts_on) = plugin_zhipu::host::gate(ctx.modules_state);
    let _ = zhipu_enabled;
    let keys = ctx
        .modules_state
        .pointer("/modules/zhipu-plan/config/keys")
        .cloned()
        .unwrap_or(Value::Null);
    let zhipu = plugin_zhipu::host::usage_cached(&json!({ "keys": keys }), alerts_on);

    let mut cpa_weekly = json!({});
    if let Some(db) = cpa_usage_db_path() {
        if let Ok(connection) = rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) {
            let week_ago = now_millis() - 7 * 86_400_000;
            // schema drift / locked db degrade to an empty weekly map: a
            // broken CPA usage.db must not kill the zhipu suggestions
            if let Ok(mut statement) = connection.prepare(
                "SELECT provider, SUM(input_tokens + output_tokens + cached_tokens + IFNULL(cache_creation_tokens, 0))
                 FROM usage_events WHERE timestamp_ms >= ?1 GROUP BY provider",
            ) {
                if let Ok(rows) = statement.query_map([week_ago], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                }) {
                    for row in rows.flatten() {
                        cpa_weekly[row.0] = json!(row.1);
                    }
                }
            }
        }
    }
    Ok(json!({ "zhipu": zhipu, "cpaWeekly": cpa_weekly }))
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
}
