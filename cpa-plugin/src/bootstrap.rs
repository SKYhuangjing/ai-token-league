// Owner-side bootstrap for the atl-share plugin.
//
// The plugin is a first-class CPA citizen: its owner configuration lives in
// CPA's own config under `plugins.configs.atl-share` and is delivered by the
// host as `config_yaml` on plugin.register / plugin.reconfigure (hot reload).
// A state file (<data dir>/cpa-plugin/config.json) is a fallback bootstrap for
// hosts that predate config delivery. The share identity minted at first
// self-registration is persisted so CPA restarts rebind to the same share.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::data_dir;

pub(crate) use crate::core_state::KeyEntry;

/// Latest `config_yaml` subtree pushed by the CPA host. The host contract is
/// normalized YAML bytes (base64 inside the JSON RPC), not a JSON object.
pub(crate) static HOST_CONFIG: Mutex<String> = Mutex::new(String::new());

/// CPA delivers `plugins.configs.<id>` as a YAML mapping of scalar ConfigFields
/// (`yaml.Marshal` of the host node). Nested values are not part of the contract.
pub(crate) fn parse_config_yaml(text: &str) -> HashMap<String, String> {
    let value: serde_yaml::Value = match serde_yaml::from_str(text) {
        Ok(value) => value,
        Err(_) => return HashMap::new(),
    };
    let Some(mapping) = value.as_mapping() else { return HashMap::new() };
    let mut map = HashMap::new();
    for (key, value) in mapping {
        let Some(key) = key.as_str().map(str::trim).filter(|k| !k.is_empty()) else { continue };
        let Some(scalar) = yaml_scalar(value) else { continue };
        map.insert(key.to_string(), scalar);
    }
    map
}

fn yaml_scalar(value: &serde_yaml::Value) -> Option<String> {
    match value {
        serde_yaml::Value::String(text) => Some(text.trim().to_string()),
        serde_yaml::Value::Number(number) => Some(number.to_string()),
        serde_yaml::Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn state_config_path() -> std::path::PathBuf {
    data_dir().join("config.json")
}

fn identity_path() -> std::path::PathBuf {
    data_dir().join("identity.json")
}

/// Merged owner config: CPA `config_yaml` wins over the state file.
pub(crate) struct OwnerConfig {
    pub api: String,
    pub title: Option<String>,
    pub budget: Option<u64>,
    pub max_claims: Option<u32>,
    pub key_max_tokens: Option<u64>,
    pub key_concurrency: Option<u32>,
    pub base_url: Option<String>,
    /// Manual ATL data dir override ("identityDir" in the CPA config). The
    /// league identity (participant_id + Ed25519 private key) is read from
    /// <dir>/config.json; default ~/.ai-token-league, env ATL_HOME honored.
    pub identity_dir: Option<String>,
}
pub(crate) fn read_owner_config() -> OwnerConfig {
    let mut merged: HashMap<String, String> = std::fs::read_to_string(state_config_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| {
            v.as_object().map(|obj| {
                obj.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
        })
        .unwrap_or_default();
    let host = HOST_CONFIG.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if !host.is_empty() {
        merged.extend(parse_config_yaml(&host));
    }
    let num = |key: &str| -> Option<u64> { merged.get(key).and_then(|v| v.parse().ok()) };
    OwnerConfig {
        api: merged.get("api").cloned().unwrap_or_default().trim().to_string(),
        title: merged.get("title").cloned().filter(|s| !s.is_empty()),
        budget: num("budget"),
        max_claims: num("maxClaims").map(|v| v as u32),
        key_max_tokens: num("keyMaxTokens"),
        key_concurrency: num("keyConcurrency").map(|v| v as u32),
        base_url: merged.get("baseURL").cloned().map(|v| v.trim().trim_end_matches('/').to_string()).filter(|v| !v.is_empty()),
        identity_dir: merged.get("identityDir").cloned().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
    }
}

pub(crate) struct ShareIdentity {
    pub api: String,
    pub share_id: String,
    pub share_secret: String,
}

pub(crate) fn load_identity() -> Option<ShareIdentity> {
    let value: Value = serde_json::from_str(
        &std::fs::read_to_string(identity_path()).ok()?,
    )
    .ok()?;
    let api = value.get("api")?.as_str()?.trim().trim_end_matches('/').to_string();
    let share_id = value.get("shareId")?.as_str()?.to_string();
    let share_secret = value.get("shareSecret")?.as_str()?.to_string();
    if api.is_empty() || share_id.is_empty() || share_secret.is_empty() {
        return None;
    }
    Some(ShareIdentity { api, share_id, share_secret })
}

pub(crate) fn save_identity(api: &str, share_id: &str, share_secret: &str) {
    let _ = std::fs::create_dir_all(data_dir());
    let body = serde_json::to_string_pretty(&json!({
        "api": api.trim_end_matches('/'),
        "shareId": share_id,
        "shareSecret": share_secret,
    }))
    .unwrap_or_default();
    let _ = std::fs::write(identity_path(), &body);
    // Owner secret: only the current user may read it (shared machines).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(identity_path(), std::fs::Permissions::from_mode(0o600));
    }
}

/// CPA's own listen port, read from the same config paths cpa.rs probes.
/// ATL_CPA_CONFIG overrides (isolated-instance testing).
pub(crate) fn discover_cpa_port() -> Option<u16> {
    let parse_port = |text: &str| {
        parse_config_yaml(text).get("port").and_then(|p| p.parse::<u16>().ok())
    };
    if let Ok(path) = std::env::var("ATL_CPA_CONFIG") {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Some(port) = parse_port(&text) {
                return Some(port);
            }
        }
    }
    let home = std::env::var("HOME").ok()?;
    let candidates = [
        std::path::PathBuf::from(home.clone()).join("Library/Application Support/com.cpa.gui/cpa-core/config.yaml"),
        std::path::PathBuf::from(home).join(".cli-proxy-api/config.yaml"),
    ];
    candidates.iter().find_map(|path| {
        std::fs::read_to_string(path).ok().as_deref().and_then(parse_port)
    })
}

/// LAN address via interface enumeration — NOT the UDP-connect trick (proxy
/// "enhanced mode" fake-IP DNS resolves the route to a bogus 198.18.x.x).
pub(crate) fn detect_lan_ip() -> Option<String> {
    if let Ok(ip) = local_ip_address::local_ip() {
        let text = ip.to_string();
        if !text.starts_with("198.18.") {
            return Some(text);
        }
    }
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip().to_string();
    (ip.starts_with("192.168.") || ip.starts_with("10.") || ip.starts_with("172.")).then_some(ip)
}

fn hostname_default() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .map(|h| h.trim().to_string())
        .ok()
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "CPA".to_string())
}

/// The share's public endpoint: an explicit CPA-config `baseURL` override
/// wins; otherwise the freshly detected LAN address + CPA port. Recomputed
/// per heartbeat so IP/port changes propagate to the backend (B2).
pub(crate) fn current_base_url(config: &OwnerConfig) -> String {
    if let Some(base) = &config.base_url {
        return base.clone();
    }
    let port = discover_cpa_port().unwrap_or(8317);
    let host = detect_lan_ip().unwrap_or_else(|| "127.0.0.1".to_string());
    format!("http://{}:{}", host, port)
}

/// The register body for first-time self-registration.
pub(crate) fn register_body(config: &OwnerConfig) -> Value {
    let base = current_base_url(config);
    let mut policy = json!({});
    if let Some(budget) = config.budget {
        policy["budget"] = json!(budget);
    }
    if let Some(max_claims) = config.max_claims {
        policy["maxClaims"] = json!(max_claims);
    }
    if let Some(key_max) = config.key_max_tokens {
        policy["keyMaxTokens"] = json!(key_max);
    }
    if let Some(concurrency) = config.key_concurrency {
        policy["keyConcurrency"] = json!(concurrency);
    }
    json!({
        "title": config.title.clone().unwrap_or_else(|| format!("{} CPA", hostname_default())),
        "baseURL": base,
        "models": ["*"],
        "policy": policy,
    })
}

/// The league identity this machine's CPA shares AS: participant_id + Ed25519
/// PKCS8 private key from the ATL client's config.json. Directory precedence:
/// CPA-config identityDir > env ATL_HOME > ~/.ai-token-league.
pub(crate) fn atl_identity(config: &OwnerConfig) -> Option<(String, String)> {
    let dir = config
        .identity_dir
        .clone()
        .or_else(|| std::env::var("ATL_HOME").ok().filter(|v| !v.trim().is_empty()))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var("HOME").ok().filter(|v| !v.trim().is_empty()).unwrap_or_default();
            std::path::PathBuf::from(home).join(".ai-token-league")
        });
    let value: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("config.json")).ok()?,
    ).ok()?;
    let participant_id = value.get("participantId")?.as_str()?.trim().to_string();
    let private_key = value.get("identityPrivateKey")?.as_str()?.trim().to_string();
    if participant_id.is_empty() || private_key.is_empty() {
        return None;
    }
    Some((participant_id, private_key))
}

/// Canonical JSON matching src/shared/crypto.js canonicalJson (sorted keys,
/// serde_json primitive encoding) — required for cross-language signatures.
pub(crate) fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .into_iter()
                .map(|k| format!("{}:{}", Value::String(k.clone()), canonical_json(&map[k])))
                .collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(list) => {
            let body: Vec<String> = list.iter().map(canonical_json).collect();
            format!("[{}]", body.join(","))
        }
        primitive => primitive.to_string(),
    }
}

/// Sign a payload with the league identity key (Ed25519, PKCS8 PEM) — mirrors
/// collector-core crypto::sign_payload / JS signPayload; base64 signature.
pub(crate) fn sign_payload(private_key_pem: &str, payload: &Value) -> Option<String> {
    use base64::Engine;
    use ed25519_dalek::pkcs8::DecodePrivateKey;
    use ed25519_dalek::Signer;
    let secret = ed25519_dalek::SigningKey::from_pkcs8_pem(private_key_pem).ok()?;
    let message = canonical_json(payload);
    let signature = secret.sign(message.as_bytes());
    Some(base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()))
}

/// Signed register credentials for the backend's A.1 identity gate.
pub(crate) fn register_identity(private_key_pem: &str, participant_id: &str) -> Option<Value> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let payload = json!({ "kind": "share-register", "participantId": participant_id, "ts": ts });
    let signature = sign_payload(private_key_pem, &payload)?;
    Some(json!({ "participantId": participant_id, "ts": ts, "signature": signature }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_config_yaml_reads_host_normalized_mapping() {
        let yaml = "# comment\napi: http://127.0.0.1:8787\ntitle: Harry share\nbudget: 1000000\nenabled: true\npriority: 0\n";
        let map = parse_config_yaml(yaml);
        assert_eq!(map.get("api").unwrap(), "http://127.0.0.1:8787");
        assert_eq!(map.get("title").unwrap(), "Harry share");
        assert_eq!(map.get("budget").unwrap(), "1000000");
        assert_eq!(map.get("enabled").unwrap(), "true");
        assert!(parse_config_yaml("{").is_empty());
        assert!(parse_config_yaml("").is_empty());
    }

    #[test]
    fn register_body_carries_policy_and_endpoint() {
        let config = OwnerConfig {
            api: "http://x".into(),
            title: Some("T".into()),
            budget: Some(5_000),
            max_claims: Some(2),
            key_max_tokens: None,
            key_concurrency: Some(4),
            base_url: None,
            identity_dir: None,
        };
        let body = register_body(&config);
        assert_eq!(body["title"], "T");
        assert!(body["baseURL"].as_str().unwrap().starts_with("http://"));
        assert_eq!(body["policy"]["budget"], 5_000);
        assert_eq!(body["policy"]["maxClaims"], 2);
        assert_eq!(body["policy"]["keyConcurrency"], 4);
        assert!(body["policy"].get("keyMaxTokens").is_none());

        // explicit baseURL override wins over detection
        let overridden = register_body(&OwnerConfig { base_url: Some("http://10.9.8.7:9000".into()), ..config });
        assert_eq!(overridden["baseURL"], "http://10.9.8.7:9000");
    }

    #[test]
    fn canonical_json_matches_the_js_algorithm() {
        // must equal JS: {"a":1,"b":{"y":true,"z":"s"},"c":[1,2]}
        assert_eq!(canonical_json(&json!({"c":[1,2],"b":{"z":"s","y":true},"a":1})),
                   r#"{"a":1,"b":{"y":true,"z":"s"},"c":[1,2]}"#);
    }

    #[test]
    fn sign_payload_roundtrips_an_ed25519_pem() {
        use base64::Engine;
        use ed25519_dalek::pkcs8::EncodePrivateKey;
        use ed25519_dalek::{Signature, SigningKey, Verifier};
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let der = sk.to_pkcs8_der().map_err(|e| format!("{e}")).unwrap();
        let raw = base64::engine::general_purpose::STANDARD.encode(der.as_bytes());
        let wrapped = raw
            .as_bytes()
            .chunks(64)
            .map(|line| String::from_utf8_lossy(line))
            .collect::<Vec<_>>()
            .join("\n");
        let pem = format!("-----BEGIN PRIVATE KEY-----\n{wrapped}\n-----END PRIVATE KEY-----\n");
        let payload = json!({"kind":"share-register","participantId":"p_1","ts":42});
        let sig_b64 = sign_payload(&pem, &payload).unwrap_or_else(|| panic!("pem parse failed:
{pem}"));
        // verify with the public key over the same canonical bytes (mirrors JS verifyPayload)
        let vk = ed25519_dalek::VerifyingKey::from(&sk);
        let sig_bytes = base64::engine::general_purpose::STANDARD.decode(sig_b64).unwrap();
        let sig = Signature::from_bytes(&sig_bytes.try_into().unwrap());
        assert!(vk.verify(canonical_json(&payload).as_bytes(), &sig).is_ok());
        // tampered payload must fail
        assert!(vk.verify(canonical_json(&json!({"kind":"share-register","participantId":"p_2","ts":42})).as_bytes(), &sig).is_err());
    }
}
