use crate::config::CursorAccount;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};

const OAUTH_TOKEN_URL: &str = "https://api2.cursor.sh/oauth/token";
const AUTH_POLL_URL: &str = "https://api2.cursor.sh/auth/poll";
const OAUTH_CLIENT_ID: &str = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const ACCOUNT_ME_URL: &str = "https://cursor.com/api/auth/me";

/// Generate a PKCE code verifier (43 chars, base64url-encoded random bytes).
pub fn generate_code_verifier() -> String {
    let mut buf = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// Generate a random UUID v4.
pub fn generate_uuid() -> String {
    let mut buf = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut buf);
    buf[6] = (buf[6] & 0x0f) | 0x40; // version 4
    buf[8] = (buf[8] & 0x3f) | 0x80; // variant 1
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        buf[0], buf[1], buf[2], buf[3],
        buf[4], buf[5],
        buf[6], buf[7],
        buf[8], buf[9],
        buf[10], buf[11], buf[12], buf[13], buf[14], buf[15]
    )
}

/// Compute PKCE code challenge from verifier: base64url(SHA256(verifier)).
pub fn compute_challenge(verifier: &str) -> String {
    let hash = crate::crypto::sha256_hex(verifier);
    // Re-encode the hex hash as raw bytes then base64url
    let hash_bytes: Vec<u8> = (0..hash.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hash[i..i + 2], 16).unwrap_or(0))
        .collect();
    URL_SAFE_NO_PAD.encode(&hash_bytes)
}

pub struct AuthPollResult {
    pub access_token: String,
    pub refresh_token: String,
    pub auth_id: String,
}

/// Poll the Cursor auth/poll endpoint.
/// Returns Ok with tokens on success, Err with "pending" on 404.
pub async fn poll_auth(uuid: &str, code_verifier: &str) -> Result<AuthPollResult, String> {
    let url = format!("{}?uuid={}&verifier={}", AUTH_POLL_URL, uuid, code_verifier);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("poll request failed: {}", e))?;

    let status = resp.status();
    if status.as_u16() == 404 {
        return Err("pending".to_string());
    }
    if !status.is_success() {
        return Err(format!("poll failed with status {}", status));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("poll response parse error: {}", e))?;

    let access_token = body
        .get("accessToken")
        .and_then(|v| v.as_str())
        .ok_or("missing accessToken in poll response")?
        .to_string();
    let refresh_token = body
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .ok_or("missing refreshToken in poll response")?
        .to_string();
    let auth_id = body
        .get("authId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(AuthPollResult {
        access_token,
        refresh_token,
        auth_id,
    })
}

pub struct CursorAuthResult {
    pub access_token: String,
    pub id_token: Option<String>,
    pub should_logout: bool,
}

/// Refresh a Cursor access token using the stored refresh token.
/// POST https://api2.cursor.sh/oauth/token (snake_case payload/response).
/// Does NOT return a new refresh_token (confirmed by T01 protocol probe).
pub async fn refresh_token(refresh_token: &str) -> Result<CursorAuthResult, String> {
    let client = reqwest::Client::new();
    let body = json!({
        "grant_type": "refresh_token",
        "client_id": OAUTH_CLIENT_ID,
        "refresh_token": refresh_token,
    });

    let resp = client
        .post(OAUTH_TOKEN_URL)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("refresh request failed: {}", e))?;

    let status = resp.status();
    let response_body: Value = resp
        .json()
        .await
        .map_err(|e| format!("refresh response parse error: {}", e))?;

    if !status.is_success() {
        return Err(format!("refresh failed with status {}", status));
    }

    let should_logout = response_body
        .get("shouldLogout")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if should_logout {
        return Err("shouldLogout".to_string());
    }

    let access_token = response_body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("missing access_token in refresh response")?
        .to_string();

    let id_token = response_body
        .get("id_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(CursorAuthResult {
        access_token,
        id_token,
        should_logout,
    })
}

/// Fetch account info from cursor.com/api/auth/me using cookie auth.
/// Cookie format: WorkosCursorSessionToken=<url_encoded(sub::accessToken)>
pub async fn fetch_account_info(access_token: &str, sub: &str) -> Result<AccountInfo, String> {
    let cookie_val = format!("{}::{}", sub, access_token);
    let cookie = format!(
        "WorkosCursorSessionToken={}",
        urlencoding::encode(&cookie_val)
    );

    let client = reqwest::Client::new();
    let resp = client
        .get(ACCOUNT_ME_URL)
        .header("Cookie", &cookie)
        .header("User-Agent", "ai-token-league/0.6.4")
        .send()
        .await
        .map_err(|e| format!("account info request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("account info failed with status {}", status));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("account info parse error: {}", e))?;

    let email = body
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();

    let user_sub = body
        .get("sub")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(AccountInfo {
        email,
        sub: user_sub,
    })
}

pub struct AccountInfo {
    pub email: String,
    pub sub: String,
}

/// Check if a token needs refresh (expired or near expiry).
/// We use a conservative check: if we have no expiry info, treat as needing refresh.
pub fn token_needs_refresh(account: &CursorAccount) -> bool {
    if account.auth_status != "active" {
        return false;
    }
    match &account.access_token_expires_at {
        Some(exp_str) => {
            let exp = chrono::DateTime::parse_from_rfc3339(exp_str)
                .map(|dt| dt.to_utc())
                .or_else(|_| {
                    chrono::NaiveDateTime::parse_from_str(exp_str, "%Y-%m-%dT%H:%M:%S%.fZ")
                        .map(|dt| chrono::DateTime::from_naive_utc_and_offset(dt, chrono::Utc))
                })
                .ok();
            match exp {
                Some(exp_time) => {
                    let now = chrono::Utc::now();
                    let threshold = chrono::Duration::minutes(5);
                    exp_time - now < threshold
                }
                None => true,
            }
        }
        None => true,
    }
}

/// Derive a stable account hash from email and participantId.
pub fn compute_account_hash(email: &str, participant_id: &str) -> String {
    let normalized = email.trim().to_lowercase();
    crate::crypto::sha256_hex(&format!(
        "cursor-dashboard:{}:{}",
        normalized, participant_id
    ))
}

/// Extract JWT payload without verification (for sub/exp fields only).
pub fn decode_jwt_payload(token: &str) -> Option<Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD.decode(parts[1]).ok()?;
    serde_json::from_slice(&decoded).ok()
}

/// Extract sub and exp from a JWT access token.
pub fn extract_jwt_claims(token: &str) -> (Option<String>, Option<String>) {
    let payload = decode_jwt_payload(token);
    match payload {
        Some(p) => {
            let sub = p.get("sub").and_then(|v| v.as_str()).map(|s| s.to_string());
            let exp = p.get("exp").and_then(|v| v.as_i64()).map(|ts| {
                chrono::DateTime::from_timestamp(ts, 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default()
            });
            (sub, exp)
        }
        None => (None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    #[test]
    fn test_generate_code_verifier_format() {
        let v = generate_code_verifier();
        assert_eq!(v.len(), 43, "base64url(32 bytes) = 43 chars");
        assert!(v
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn test_generate_code_verifier_uniqueness() {
        let a = generate_code_verifier();
        let b = generate_code_verifier();
        assert_ne!(a, b);
    }

    #[test]
    fn test_generate_uuid_format() {
        let u = generate_uuid();
        assert_eq!(u.len(), 36, "UUID v4 = 8-4-4-4-12 = 36 chars");
        let parts: Vec<&str> = u.split('-').collect();
        assert_eq!(parts.len(), 5);
        assert_eq!(parts[0].len(), 8);
        assert_eq!(parts[1].len(), 4);
        assert_eq!(parts[2].len(), 4);
        assert_eq!(parts[3].len(), 4);
        assert_eq!(parts[4].len(), 12);
        // Version nibble
        assert_eq!(&parts[2][0..1], "4");
        // Variant nibble
        let byte8 = u8::from_str_radix(&parts[3][0..2], 16).unwrap();
        assert_eq!(byte8 & 0xc0, 0x80);
    }

    #[test]
    fn test_generate_uuid_uniqueness() {
        assert_ne!(generate_uuid(), generate_uuid());
    }

    #[test]
    fn test_compute_challenge_deterministic() {
        let verifier = "test-verifier-abc123";
        let c1 = compute_challenge(verifier);
        let c2 = compute_challenge(verifier);
        assert_eq!(c1, c2);
        // Must be valid base64url
        assert!(URL_SAFE_NO_PAD.decode(&c1).is_ok());
    }

    #[test]
    fn test_compute_challenge_different_verifiers() {
        assert_ne!(
            compute_challenge("verifier-a"),
            compute_challenge("verifier-b")
        );
    }

    #[test]
    fn test_compute_account_hash_deterministic() {
        let h1 = compute_account_hash("user@example.com", "p_123");
        let h2 = compute_account_hash("user@example.com", "p_123");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn test_compute_account_hash_normalizes_email() {
        let h1 = compute_account_hash("User@Example.COM", "p_123");
        let h2 = compute_account_hash("  user@example.com  ", "p_123");
        assert_eq!(h1, h2, "should normalize case and trim whitespace");
    }

    #[test]
    fn test_compute_account_hash_different_participants() {
        let h1 = compute_account_hash("user@example.com", "p_123");
        let h2 = compute_account_hash("user@example.com", "p_456");
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_decode_jwt_payload_valid() {
        let header = URL_SAFE_NO_PAD.encode(b"{}");
        let payload = URL_SAFE_NO_PAD.encode(r#"{"sub":"user123","exp":1700000000}"#);
        let sig = URL_SAFE_NO_PAD.encode(b"sig");
        let token = format!("{}.{}.{}", header, payload, sig);
        let decoded = decode_jwt_payload(&token).unwrap();
        assert_eq!(decoded["sub"].as_str(), Some("user123"));
        assert_eq!(decoded["exp"].as_i64(), Some(1700000000));
    }

    #[test]
    fn test_decode_jwt_payload_invalid_parts() {
        assert!(decode_jwt_payload("").is_none());
        assert!(decode_jwt_payload("a.b").is_none());
        assert!(decode_jwt_payload("a.b.c.d").is_none());
    }

    #[test]
    fn test_decode_jwt_payload_invalid_base64() {
        assert!(decode_jwt_payload("a.!!!.c").is_none());
    }

    #[test]
    fn test_extract_jwt_claims_valid() {
        let payload = URL_SAFE_NO_PAD.encode(r#"{"sub":"user42","exp":1700000000}"#);
        let token = format!("{}.{}.sig", URL_SAFE_NO_PAD.encode(b"{}"), payload);
        let (sub, exp) = extract_jwt_claims(&token);
        assert_eq!(sub, Some("user42".to_string()));
        assert!(exp.is_some());
        assert!(exp.unwrap().contains("2023"));
    }

    #[test]
    fn test_extract_jwt_claims_missing_fields() {
        let payload = URL_SAFE_NO_PAD.encode(r#"{"iat":1700000000}"#);
        let token = format!("{}.{}.sig", URL_SAFE_NO_PAD.encode(b"{}"), payload);
        let (sub, exp) = extract_jwt_claims(&token);
        assert_eq!(sub, None);
        assert_eq!(exp, None);
    }

    #[test]
    fn test_extract_jwt_claims_invalid_token() {
        let (sub, exp) = extract_jwt_claims("not-a-jwt");
        assert_eq!(sub, None);
        assert_eq!(exp, None);
    }

    #[test]
    fn test_token_needs_refresh_no_expiry() {
        let account = CursorAccount {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            auth_id: "a".into(),
            sub: String::new(),
            email: String::new(),
            account_hash: String::new(),
            access_token_expires_at: None,
            last_refresh_at: None,
            auth_status: "active".into(),
            ignored: false,
            added_at: None,
        };
        assert!(token_needs_refresh(&account), "no expiry → needs refresh");
    }

    #[test]
    fn test_token_needs_refresh_not_active() {
        let account = CursorAccount {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            auth_id: "a".into(),
            sub: String::new(),
            email: String::new(),
            account_hash: String::new(),
            access_token_expires_at: None,
            last_refresh_at: None,
            auth_status: "disconnected".into(),
            ignored: false,
            added_at: None,
        };
        assert!(!token_needs_refresh(&account), "non-active → no refresh");
    }

    #[test]
    fn test_token_needs_refresh_expired() {
        let past = (chrono::Utc::now() - chrono::Duration::hours(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let account = CursorAccount {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            auth_id: "a".into(),
            sub: String::new(),
            email: String::new(),
            account_hash: String::new(),
            access_token_expires_at: Some(past),
            last_refresh_at: None,
            auth_status: "active".into(),
            ignored: false,
            added_at: None,
        };
        assert!(token_needs_refresh(&account), "expired → needs refresh");
    }

    #[test]
    fn test_token_needs_refresh_far_future() {
        let future = (chrono::Utc::now() + chrono::Duration::hours(24))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let account = CursorAccount {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            auth_id: "a".into(),
            sub: String::new(),
            email: String::new(),
            account_hash: String::new(),
            access_token_expires_at: Some(future),
            last_refresh_at: None,
            auth_status: "active".into(),
            ignored: false,
            added_at: None,
        };
        assert!(!token_needs_refresh(&account), "far future → no refresh");
    }

    #[test]
    fn test_token_needs_refresh_unparseable_expiry() {
        let account = CursorAccount {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            auth_id: "a".into(),
            sub: String::new(),
            email: String::new(),
            account_hash: String::new(),
            access_token_expires_at: Some("not-a-date".into()),
            last_refresh_at: None,
            auth_status: "active".into(),
            ignored: false,
            added_at: None,
        };
        assert!(
            token_needs_refresh(&account),
            "bad expiry string → needs refresh"
        );
    }

    #[test]
    fn test_token_needs_refresh_near_expiry_within_5min() {
        let near = (chrono::Utc::now() + chrono::Duration::minutes(3))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let account = CursorAccount {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            auth_id: "a".into(),
            sub: String::new(),
            email: String::new(),
            account_hash: String::new(),
            access_token_expires_at: Some(near),
            last_refresh_at: None,
            auth_status: "active".into(),
            ignored: false,
            added_at: None,
        };
        assert!(
            token_needs_refresh(&account),
            "within 5 min threshold → needs refresh"
        );
    }
}
