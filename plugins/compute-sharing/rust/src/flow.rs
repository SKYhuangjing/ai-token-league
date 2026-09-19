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
        // the card's fetches run under AbortSignal.timeout(8000)
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
    let record = json!({
        "keyId": data.get("keyId").cloned().unwrap_or(Value::Null),
        "token": data.get("token").cloned().unwrap_or(Value::Null),
        "baseURL": data.get("baseURL").cloned().unwrap_or(Value::Null),
        "shareId": share_id,
        "shareTitle": data.get("shareTitle").cloned().unwrap_or(Value::Null),
        "models": data.get("models").cloned().unwrap_or(json!([])),
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
    let mut claims = store_claims()?;
    for entry in claims.iter_mut() {
        if entry.get("keyId").and_then(|v| v.as_str()) == Some(key_id) {
            entry["expiresAt"] = expires_at.clone();
        }
    }
    super::borrow_set(&json!({ "claims": claims }))?;
    Ok(json!({ "keyId": key_id, "expiresAt": expires_at }))
}

/// Revoke (release) one claim: backend first, then drop it from the store.
pub fn revoke(api: &str, key_id: &str) -> Result<Value, String> {
    let claim = find_claim(key_id)?;
    post_json(api, "/api/shares/claims/revoke", &json!({ "token": claim["token"] }))?;
    let claims = store_claims()?
        .into_iter()
        .filter(|entry| entry.get("keyId").and_then(|v| v.as_str()) != Some(key_id))
        .collect::<Vec<_>>();
    super::borrow_set(&json!({ "claims": claims }))?;
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
    post_json(api, "/api/shares/claims/mine", &json!({ "tokens": tokens }))
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
    let claims = store_claims()?;
    let merged: Vec<Value> = std::iter::once(record.clone())
        .chain(claims.into_iter().filter(|entry| {
            entry.get("keyId").and_then(|v| v.as_str())
                != record.get("keyId").and_then(|v| v.as_str())
        }))
        .collect();
    super::borrow_set(&json!({ "claims": merged }))?;
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
                r#"{ "keyId": "csk_new", "token": "atl_sk_t", "baseURL": "http://cpa:8317", "shareTitle": "sky-cpa", "models": ["gemini-*"], "expiresAt": 1789700000000, "laneId": "gem", "laneTitle": "gem lane" }"#,
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
                { "keyId": "csk_a", "token": "tok_a", "baseURL": "http://x", "shareId": "s1", "shareTitle": "A", "models": [], "expiresAt": 1 },
                { "keyId": "csk_b", "token": "tok_b", "baseURL": "http://x", "shareId": "s2", "shareTitle": "B", "models": [], "expiresAt": 2 },
            ]}))
            .unwrap();
            let backend = MockBackend::spawn(vec![
                ("x", 200, r#"{ "expiresAt": 999 }"#),
                ("x", 200, r#"{ "ok": true }"#),
            ]);
            let api = format!("http://{}", backend.addr);

            let renewed = renew(&api, "csk_a").unwrap();
            assert_eq!(renewed["expiresAt"], 999);
            let stored = super::super::borrow_get().unwrap();
            let claims = stored["claims"].as_array().unwrap();
            assert_eq!(claims.len(), 2);
            let a = claims.iter().find(|c| c["keyId"] == "csk_a").unwrap();
            assert_eq!(a["expiresAt"], 999);

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
                { "keyId": "csk_a", "token": "tok_a", "baseURL": "http://x", "shareId": "s1", "shareTitle": "A", "models": [], "expiresAt": 1 },
            ]}))
            .unwrap();
            let backend = MockBackend::spawn(vec![(
                "x",
                200,
                r#"{ "claims": [{ "keyId": "csk_a", "state": "valid", "usedTokens": 123 }] }"#,
            )]);
            let data = live(&format!("http://{}", backend.addr)).unwrap();
            assert_eq!(data["claims"][0]["keyId"], "csk_a");
            let (request_line, body) = &backend.requests.lock().unwrap()[0];
            assert!(request_line.contains("POST /api/shares/claims/mine"), "{request_line}");
            let sent: Value = serde_json::from_str(body).unwrap();
            assert_eq!(sent["tokens"][0], "tok_a");
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
}
