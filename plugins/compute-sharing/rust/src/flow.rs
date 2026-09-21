// Borrower-side backend flows for compute-sharing.
//
// The remote card's JS kept five thin backend calls in the webview (directory,
// claim, renew, revoke, live usage). The terminal surface needs the same flows,
// so they live here — the crate — as the single implementation both frontends
// can call (the card migrates to these sidecar commands in a later plugin
// version). Wire protocol mirrors the card's JS exactly: same endpoints, same
// payloads, same local claim-store merges, same error codes.

use serde_json::{json, Value};

/// Backend base from the app config (R51-1 rule: the identity file carries
/// credentials only, the backend URL always follows the configured apiBase).
pub fn api_base() -> Result<String, String> {
    collector_core::config::load_config()
        .map(|config| collector_core::config::normalize_api_base_url(&config.api_base_url))
        .filter(|api| !api.is_empty())
        .ok_or_else(|| "no_api_base".to_string())
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        // the card's fetches run under AbortSignal.timeout(8000); direct
        // connections only — a system proxy black-holes LAN CPA endpoints
        .no_proxy()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())
}

/// POST JSON and map non-2xx to the server's error code (the card maps the
/// same codes to i18n text; callers decide presentation).
fn post_json(api: &str, path: &str, body: &Value) -> Result<Value, String> {
    let response = client()?
        .post(format!("{}{}", api, path))
        .header("content-type", "application/json")
        .json(body)
        .send()
        .map_err(|e| format!("backend_unreachable:{}", e))?;
    let status = response.status();
    let data: Value = response.json().unwrap_or_default();
    if !status.is_success() {
        let code = data.get("error").and_then(|v| v.as_str()).unwrap_or("");
        return Err(if code.is_empty() {
            format!("http_{}", status.as_u16())
        } else {
            code.to_string()
        });
    }
    Ok(data)
}

/// GET a backend endpoint with the same error mapping as `post_json`.
fn get_json(api: &str, path: &str) -> Result<Value, String> {
    let response = client()?
        .get(format!("{}{}", api, path))
        .send()
        .map_err(|e| format!("backend_unreachable:{}", e))?;
    let status = response.status();
    let data: Value = response.json().unwrap_or_default();
    if !status.is_success() {
        let code = data.get("error").and_then(|v| v.as_str()).unwrap_or("");
        return Err(if code.is_empty() {
            format!("http_{}", status.as_u16())
        } else {
            code.to_string()
        });
    }
    Ok(data)
}

/// Online share directory (lane view) — GET /api/shares.
pub fn directory(api: &str) -> Result<Value, String> {
    get_json(api, "/api/shares")
}

/// Claim a lane on a share: identity-sign, POST, then merge the record into
/// the local borrow store exactly like the card (newest first, dedup by
/// keyId). Returns the server response (token/baseURL/lane metadata).
pub fn claim(api: &str, share_id: &str, lane_id: Option<&str>) -> Result<Value, String> {
    let ts = now_millis();
    let signed = super::claim_sign(&json!({ "shareId": share_id, "ts": ts }))?;
    let mut body = json!({
        "shareId": share_id,
        "participantId": signed["participantId"],
        "ts": signed["ts"],
        "signature": signed["signature"],
    });
    if let Some(lane) = lane_id.filter(|s| !s.trim().is_empty()) {
        body["laneId"] = json!(lane.trim());
    }
    let data = post_json(api, "/api/shares/claim", &body)?;
    // Quota + lane identity ride into the local store (CS-02): the borrower
    // must see what the key can do without another round trip, and the card's
    // tool-config generator reads the lane window from here.
    let record = json!({
        "keyId": data.get("keyId").cloned().unwrap_or(Value::Null),
        "token": data.get("token").cloned().unwrap_or(Value::Null),
        "baseURL": data.get("baseURL").cloned().unwrap_or(Value::Null),
        "shareId": share_id,
        "shareTitle": data.get("shareTitle").cloned().unwrap_or(Value::Null),
        "laneId": data.get("laneId").cloned().unwrap_or(Value::Null),
        "laneTitle": data.get("laneTitle").cloned().unwrap_or(Value::Null),
        "tzLabel": data.get("tzLabel").cloned().unwrap_or(Value::Null),
        "models": data.get("models").cloned().unwrap_or(json!([])),
        "window": data.get("window").filter(|v| v.is_object()).cloned().unwrap_or(json!({ "unit": "day", "n": 1 })),
        "keyMaxTokens": data.get("keyMaxTokens").cloned().unwrap_or(Value::Null),
        "keyConcurrency": data.get("keyConcurrency").cloned().unwrap_or(Value::Null),
        "laneBudgetTokens": data.get("laneBudgetTokens").cloned().unwrap_or(Value::Null),
        "expiresAt": data.get("expiresAt").cloned().unwrap_or(Value::Null),
    });
    merge_claim_record(&record)?;
    Ok(data)
}

/// Renew one claim (same key, extended expiry reaches the owner plugin on its
/// next heartbeat).
pub fn renew(api: &str, key_id: &str) -> Result<Value, String> {
    let claim = find_claim(key_id)?;
    let data = post_json(api, "/api/shares/claims/renew", &json!({ "token": claim["token"] }))?;
    let expires_at = data.get("expiresAt").cloned().unwrap_or(Value::Null);
    super::borrow_mutate(|claims| {
        for entry in claims.iter_mut() {
            if entry.get("keyId").and_then(|v| v.as_str()) == Some(key_id) {
                entry["expiresAt"] = expires_at.clone();
            }
        }
    })?;
    Ok(json!({ "keyId": key_id, "expiresAt": expires_at }))
}

/// Revoke (release) one claim: backend first, then drop it from the store.
pub fn revoke(api: &str, key_id: &str) -> Result<Value, String> {
    let claim = find_claim(key_id)?;
    post_json(api, "/api/shares/claims/revoke", &json!({ "token": claim["token"] }))?;
    super::borrow_mutate(|claims| {
        claims.retain(|entry| entry.get("keyId").and_then(|v| v.as_str()) != Some(key_id));
    })?;
    Ok(json!({ "keyId": key_id, "revoked": true }))
}

/// Live backend view of local claims (state + used tokens) — POST
/// /api/shares/claims/mine with every stored token.
pub fn live(api: &str) -> Result<Value, String> {
    let tokens: Vec<Value> = store_claims()?
        .into_iter()
        .filter_map(|entry| entry.get("token").cloned())
        .collect();
    if tokens.is_empty() {
        return Ok(json!({ "claims": [] }));
    }
    let data = post_json(api, "/api/shares/claims/mine", &json!({ "tokens": tokens }))?;
    refresh_claim_endpoints(&data)?;
    Ok(data)
}

fn refresh_claim_endpoints(data: &Value) -> Result<(), String> {
    let Some(remote) = data.get("claims").and_then(Value::as_array) else { return Ok(()) };
    super::borrow_mutate(|claims| {
        // Re-read under the lock: an in-flight refresh must neither resurrect
        // a deleted key nor overwrite a replacement credential.
        for claim in claims {
            if let Some(entry) = remote.iter().find(|entry| {
                entry["keyId"] == claim["keyId"] && entry["token"] == claim["token"]
                    && entry["shareId"] == claim["shareId"]
            }) {
                if let Some(base) = entry.get("baseURL").and_then(Value::as_str).filter(|v| !v.is_empty()) {
                    claim["baseURL"] = json!(base);
                }
            }
        }
    })
}

/// Probe bridge (lib tests): the atomic merge path without a mock backend.
#[cfg(test)]
pub(crate) fn merge_claim_record_for_probe(record: &Value) -> Result<(), String> {
    merge_claim_record(record)
}

fn store_claims() -> Result<Vec<Value>, String> {
    let store = super::borrow_get()?;
    Ok(store.get("claims").and_then(|v| v.as_array()).cloned().unwrap_or_default())
}

fn find_claim(key_id: &str) -> Result<Value, String> {
    store_claims()?
        .into_iter()
        .find(|entry| entry.get("keyId").and_then(|v| v.as_str()) == Some(key_id))
        .ok_or_else(|| format!("claim_not_found:{}", key_id))
}

fn merge_claim_record(record: &Value) -> Result<(), String> {
    // QA-05: merge inside one lock hold — a concurrent CLI claim between the
    // read and the write used to be overwritten by the stale merge
    super::borrow_mutate(|claims| {
        claims.retain(|entry| {
            entry.get("keyId").and_then(|v| v.as_str())
                != record.get("keyId").and_then(|v| v.as_str())
        });
        claims.insert(0, record.clone());
    })?;
    Ok(())
}

// ── sidecar command wrappers ────────────────────────────────────────────────
// Resolve the api base once, then run the flow. The handle() arms in lib.rs
// call these, so the terminal CLI and any future card code share one path.

pub fn run_directory() -> Result<Value, String> {
    directory(&api_base()?)
}

pub fn run_claim(args: &Value) -> Result<Value, String> {
    let share_id = args
        .get("shareId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "claim requires shareId".to_string())?;
    let lane_id = args.get("laneId").and_then(|v| v.as_str());
    claim(&api_base()?, share_id, lane_id)
}

pub fn run_renew(args: &Value) -> Result<Value, String> {
    let key_id = required_key_id(args, "renew")?;
    renew(&api_base()?, &key_id)
}

pub fn run_revoke(args: &Value) -> Result<Value, String> {
    let key_id = required_key_id(args, "revoke")?;
    revoke(&api_base()?, &key_id)
}

pub fn run_live() -> Result<Value, String> {
    live(&api_base()?)
}

/// Model discovery (CS-03): list the CPA catalog through the claim's own key
/// and intersect it with the lane's model scope. The request rides the
/// sidecar because the webview cannot reach the owner's CPA directly (no
/// CORS); wildcards from the lane never leak through as usable model ids —
/// only concrete catalog entries the lane actually admits.
pub fn models(key_id: &str) -> Result<Value, String> {
    let claim = find_claim(key_id)?;
    let token = claim.get("token").and_then(|v| v.as_str()).ok_or("claim_missing_token")?;
    let base = claim
        .get("baseURL")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();
    if token.is_empty() || base.is_empty() {
        return Err("claim_missing_endpoint".into());
    }
    let response = client()?
        .get(format!("{}/v1/models", base))
        .header("authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("model_catalog_unreachable:{}", e))?;
    let status = response.status();
    let data: Value = response.json().unwrap_or_default();
    if !status.is_success() {
        let code = data.get("error").and_then(|v| v.as_str()).unwrap_or("");
        return Err(if code.is_empty() {
            format!("http_{}", status.as_u16())
        } else {
            code.to_string()
        });
    }
    let scope = claim.get("models").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let scoped: Vec<String> = data
        .get("data")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|m| m.get("id").and_then(|v| v.as_str()))
                .filter(|id| lane_admits(&scope, id))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({ "keyId": key_id, "models": scoped }))
}

/// Lane model scoping for concrete ids: exact match, `*` wildcard patterns
/// (prefix/suffix/infix), empty scope or a lone `*` admits everything.
fn lane_admits(scope: &[Value], model: &str) -> bool {
    let patterns: Vec<&str> = scope.iter().filter_map(|v| v.as_str()).collect();
    if patterns.is_empty() || patterns.iter().any(|p| *p == "*") {
        return true;
    }
    patterns.iter().any(|pattern| {
        let stars = pattern.matches('*').count();
        if stars == 0 {
            pattern == &model
        } else if stars == 1 {
            let (head, tail) = pattern.split_once('*').unwrap();
            model.starts_with(head) && model.ends_with(tail) && model.len() >= head.len() + tail.len()
        } else {
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

pub fn run_models(args: &Value) -> Result<Value, String> {
    let key_id = required_key_id(args, "models")?;
    models(&key_id)
}

fn required_key_id(args: &Value, command: &str) -> Result<String, String> {
    args.get("keyId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .ok_or_else(|| format!("{} requires keyId", command))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_sandbox::sandboxed;
    use std::io::{Read, Write};

    /// Minimal one-shot HTTP server: serves canned JSON per path prefix,
    /// records the last request body so tests can assert the wire format.
    struct MockBackend {
        addr: String,
        requests: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>,
    }

    impl MockBackend {
        fn spawn(responses: Vec<(&'static str, u16, &'static str)>) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap().to_string();
            let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let recorded = requests.clone();
            std::thread::spawn(move || {
                for (_path, status, body) in responses {
                    let (mut stream, _) = match listener.accept() {
                        Ok(pair) => pair,
                        Err(_) => return,
                    };
                    let mut raw = [0u8; 8192];
                    let mut read = stream.read(&mut raw).unwrap_or(0);
                    let mut request = String::from_utf8_lossy(&raw[..read]).to_string();
                    // keep reading until the body is complete
                    while let Some(header_end) = request.find("\r\n\r\n") {
                        let length = request[header_end + 4..]
                            .len();
                        let declared = request
                            .split("\r\n")
                            .find(|line| line.to_ascii_lowercase().starts_with("content-length:"))
                            .and_then(|line| line.split(':').nth(1))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if length >= declared {
                            break;
                        }
                        read = match stream.read(&mut raw) {
                            Ok(n) if n > 0 => n,
                            _ => break,
                        };
                        request.push_str(&String::from_utf8_lossy(&raw[..read]));
                    }
                    let (head, body_text) = request.split_once("\r\n\r\n").unwrap_or((&request, ""));
                    let request_line = head.lines().next().unwrap_or("").to_string();
                    recorded
                        .lock()
                        .unwrap()
                        .push((request_line, body_text.to_string()));
                    let reason = if status == 200 { "OK" } else { "Error" };
                    let response = format!(
                        "HTTP/1.1 {} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        status,
                        reason,
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes());
                }
            });
            MockBackend { addr, requests }
        }
    }

    fn init_identity_sandbox() {
        let home = std::env::var("ATL_HOME").unwrap_or_default();
        let dir = std::path::PathBuf::from(&home);
        // remove_dir_all on a file fails silently — each test must start from
        // an empty claim store
        let _ = std::fs::remove_file(dir.join("sharing-borrow.json"));
        // a real generated identity: claim-sign must produce a valid signature
        collector_core::config::init_config(json!({}), true);
    }

    #[test]
    fn claim_posts_signed_payload_and_stores_record() {
        sandboxed(|| {
            init_identity_sandbox();
            let backend = MockBackend::spawn(vec![(
                "x",
                200,
                r#"{ "keyId": "csk_new", "token": "atl_sk_t", "baseURL": "http://cpa:8317", "shareTitle": "sky-cpa", "models": ["gemini-*"], "expiresAt": 9000000000000, "laneId": "gem", "laneTitle": "gem lane" }"#,
            )]);
            let api = format!("http://{}", backend.addr);
            let data = claim(&api, "shr_1", Some("gem")).unwrap();
            assert_eq!(data["keyId"], "csk_new");

            // wire format: path + signed body shape the backend verifies
            let (request_line, body) = &backend.requests.lock().unwrap()[0];
            assert!(request_line.contains("POST /api/shares/claim"), "{request_line}");
            let sent: Value = serde_json::from_str(body).unwrap();
            assert_eq!(sent["shareId"], "shr_1");
            assert_eq!(sent["laneId"], "gem");
            assert!(sent["signature"].as_str().unwrap_or("").len() > 30);
            assert!(sent["participantId"].as_str().unwrap_or("").len() > 0);

            // store merged newest-first
            let stored = super::super::borrow_get().unwrap();
            let claims = stored["claims"].as_array().unwrap();
            assert_eq!(claims[0]["keyId"], "csk_new");
            assert_eq!(claims[0]["token"], "atl_sk_t");
        });
    }

    #[test]
    fn claim_maps_server_error_codes() {
        sandboxed(|| {
            init_identity_sandbox();
            let backend = MockBackend::spawn(vec![("x", 409, r#"{ "error": "lane_closed" }"#)]);
            let err = claim(&format!("http://{}", backend.addr), "shr_1", None).unwrap_err();
            assert_eq!(err, "lane_closed");
            // a rejected claim must not touch the store
            assert!(super::super::borrow_get().unwrap()["claims"].as_array().unwrap().is_empty());
        });
    }

    #[test]
    fn renew_updates_expiry_and_revoke_removes() {
        sandboxed(|| {
            init_identity_sandbox();
            super::super::borrow_set(&json!({ "claims": [
                { "keyId": "csk_a", "token": "tok_a", "baseURL": "http://x", "shareId": "s1", "shareTitle": "A", "models": [], "expiresAt": 9_000_000_000_000i64 },
                { "keyId": "csk_b", "token": "tok_b", "baseURL": "http://x", "shareId": "s2", "shareTitle": "B", "models": [], "expiresAt": 9_000_000_000_001i64 },
            ]}))
            .unwrap();
            let backend = MockBackend::spawn(vec![
                ("x", 200, r#"{ "expiresAt": 9000000000000 }"#),
                ("x", 200, r#"{ "ok": true }"#),
            ]);
            let api = format!("http://{}", backend.addr);

            let renewed = renew(&api, "csk_a").unwrap();
            assert_eq!(renewed["expiresAt"], 9_000_000_000_000i64);
            let stored = super::super::borrow_get().unwrap();
            let claims = stored["claims"].as_array().unwrap();
            assert_eq!(claims.len(), 2);
            let a = claims.iter().find(|c| c["keyId"] == "csk_a").unwrap();
            assert_eq!(a["expiresAt"], 9_000_000_000_000i64);

            revoke(&api, "csk_a").unwrap();
            let stored = super::super::borrow_get().unwrap();
            let claims = stored["claims"].as_array().unwrap();
            assert_eq!(claims.len(), 1);
            assert_eq!(claims[0]["keyId"], "csk_b");
            // revoke hit the right endpoint with the right token
            let (_, body) = &backend.requests.lock().unwrap()[1];
            let sent: Value = serde_json::from_str(body).unwrap();
            assert_eq!(sent["token"], "tok_a");
        });
    }

    #[test]
    fn renew_rejects_unknown_key_without_http() {
        sandboxed(|| {
            init_identity_sandbox();
            let err = renew("http://127.0.0.1:1", "csk_missing").unwrap_err();
            assert!(err.starts_with("claim_not_found"), "{err}");
        });
    }

    #[test]
    fn live_posts_stored_tokens() {
        sandboxed(|| {
            init_identity_sandbox();
            super::super::borrow_set(&json!({ "claims": [
                { "keyId": "csk_a", "token": "tok_a", "baseURL": "http://x", "shareId": "s1", "shareTitle": "A", "models": [], "expiresAt": 9_000_000_000_000i64 },
            ]}))
            .unwrap();
            let backend = MockBackend::spawn(vec![(
                "x",
                200,
                r#"{ "claims": [{ "keyId": "csk_a", "shareId": "s1", "token": "tok_a", "baseURL": "http://new:8317", "state": "valid", "usedTokens": 123 }] }"#,
            )]);
            let data = live(&format!("http://{}", backend.addr)).unwrap();
            assert_eq!(data["claims"][0]["keyId"], "csk_a");
            let (request_line, body) = &backend.requests.lock().unwrap()[0];
            assert!(request_line.contains("POST /api/shares/claims/mine"), "{request_line}");
            let sent: Value = serde_json::from_str(body).unwrap();
            assert_eq!(sent["tokens"][0], "tok_a");
            let stored = store_claims().unwrap();
            assert_eq!(stored[0]["baseURL"], "http://new:8317");
            assert_eq!(stored[0]["token"], "tok_a");
            assert_eq!(stored[0]["expiresAt"], 9_000_000_000_000i64);
        });
    }

    #[test]
    fn endpoint_refresh_preserves_concurrent_deletion_and_new_credentials() {
        sandboxed(|| {
            init_identity_sandbox();
            // State written by another process while the live HTTP request
            // was in flight: A removed, B replaced, C newly claimed.
            super::super::borrow_set(&json!({ "claims": [
                {"keyId":"b", "shareId":"s", "token":"new-b", "baseURL":"http://b", "expiresAt":9_000_000_000_000i64},
                {"keyId":"c", "shareId":"s", "token":"c", "baseURL":"http://c", "expiresAt":9_000_000_000_000i64}
            ]})).unwrap();
            refresh_claim_endpoints(&json!({"claims":[
                {"keyId":"a", "shareId":"s", "token":"a", "baseURL":"http://new"},
                {"keyId":"b", "shareId":"s", "token":"old-b", "baseURL":"http://new"},
                {"keyId":"c", "shareId":"different", "token":"c", "baseURL":"http://new"}
            ]})).unwrap();
            let stored = store_claims().unwrap();
            assert_eq!(stored.len(), 2);
            assert_eq!(stored[0]["baseURL"], "http://b");
            assert_eq!(stored[1]["baseURL"], "http://c");
        });
    }

    #[test]
    fn directory_gets_share_list() {
        let backend = MockBackend::spawn(vec![(
            "x",
            200,
            r#"{ "shares": [{ "shareId": "s1", "title": "sky-cpa", "online": true }] }"#,
        )]);
        let data = directory(&format!("http://{}", backend.addr)).unwrap();
        assert_eq!(data["shares"][0]["title"], "sky-cpa");
    }

    #[test]
    fn error_mapping_falls_back_to_http_status() {
        let backend = MockBackend::spawn(vec![("x", 500, r#"{ "oops": 1 }"#)]);
        let err = directory(&format!("http://{}", backend.addr)).unwrap_err();
        assert_eq!(err, "http_500");
    }

    #[test]
    fn lane_admits_implements_wildcard_scope() {
        let scope = |patterns: &[&str]| patterns.iter().map(|p| json!(p)).collect::<Vec<_>>();
        // empty / lone-* scopes admit everything
        assert!(lane_admits(&scope(&[]), "anything"));
        assert!(lane_admits(&scope(&["*"]), "anything"));
        // prefix / suffix / exact / multi-star
        assert!(lane_admits(&scope(&["gemini-*"]), "gemini-3.8-flash-high"));
        assert!(!lane_admits(&scope(&["gemini-*"]), "gpt-5.6"));
        assert!(lane_admits(&scope(&["*-flash"]), "glm-5.3-flash"));
        assert!(lane_admits(&scope(&["glm-5.3"]), "glm-5.3"));
        assert!(!lane_admits(&scope(&["glm-5.3"]), "glm-5.3-flash"));
        assert!(lane_admits(&scope(&["g*high"]), "gemini-3.8-flash-high"));
        assert!(!lane_admits(&scope(&["g*high"]), "gemini-3.8-flash-low"));
        // a concrete id outside every pattern is rejected
        assert!(!lane_admits(&scope(&["glm-*", "gpt-5*"]), "claude-opus-4-6"));
    }

}
