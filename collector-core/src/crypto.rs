use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::fmt::Write;

type HmacSha256 = Hmac<Sha256>;

/// Deterministic JSON serialization: object keys sorted lexicographically,
/// arrays order-preserved, no whitespace. Must match Node.js `canonicalJson`.
pub fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Array(arr) => {
            let inner: Vec<String> = arr.iter().map(|v| canonical_json(v)).collect();
            format!("[{}]", inner.join(","))
        }
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let pairs: Vec<String> = keys
                .iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap(),
                        canonical_json(&map[*k])
                    )
                })
                .collect();
            format!("{{{}}}", pairs.join(","))
        }
        _ => serde_json::to_string(value).unwrap(),
    }
}

pub fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    encode_hex(hasher.finalize())
}

pub fn sha256_bytes_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    encode_hex(hasher.finalize())
}

pub fn hmac_sha256_hex(key: &[u8], data: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC key length is valid");
    mac.update(data);
    encode_hex(mac.finalize().into_bytes())
}

pub fn new_id(prefix: &str) -> String {
    let mut bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{}_{}", prefix, encode_hex(bytes))
}

pub struct Identity {
    pub participant_id: String,
    pub identity_public_key: String,
    pub identity_private_key: String,
}

pub fn generate_identity() -> Identity {
    let mut seed = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut seed);
    let signing_key = SigningKey::from_bytes(&seed);

    let public_pem = public_key_to_pem(&signing_key.verifying_key());
    let private_pem = private_key_to_pem(&signing_key);

    Identity {
        participant_id: new_id("p"),
        identity_public_key: public_pem,
        identity_private_key: private_pem,
    }
}

/// Node.js Ed25519 public key PEM: SPKI DER encoded.
/// DER structure for Ed25519 public key:
///   30 2a                         SEQUENCE (42 bytes)
///     30 05                       SEQUENCE (5 bytes)
///       06 03 2b 65 70            OID 1.3.101.112 (Ed25519)
///     03 21                       BIT STRING (33 bytes)
///       00                        no unused bits
///       <32 bytes raw public key>
const ED25519_SPKI_PREFIX: &[u8] = &[
    0x30, 0x2a, // SEQUENCE, 42 bytes
    0x30, 0x05, // SEQUENCE, 5 bytes
    0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112
    0x03, 0x21, // BIT STRING, 33 bytes
    0x00, // no unused bits
];

/// Node.js Ed25519 private key PEM: PKCS8 DER encoded.
/// DER structure:
///   30 2e                         SEQUENCE (46 bytes)
///     02 01 00                    INTEGER version 0
///     30 05                       SEQUENCE (5 bytes)
///       06 03 2b 65 70            OID 1.3.101.112 (Ed25519)
///     04 22                       OCTET STRING (34 bytes)
///       04 20                     OCTET STRING (32 bytes)
///         <32 bytes raw seed>
const ED25519_PKCS8_PREFIX: &[u8] = &[
    0x30, 0x2e, // SEQUENCE, 46 bytes
    0x02, 0x01, 0x00, // INTEGER version 0
    0x30, 0x05, // SEQUENCE, 5 bytes
    0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112
    0x04, 0x22, // OCTET STRING, 34 bytes
    0x04, 0x20, // OCTET STRING, 32 bytes
];

fn public_key_to_pem(vk: &VerifyingKey) -> String {
    let raw = vk.to_bytes();
    let mut der = Vec::with_capacity(ED25519_SPKI_PREFIX.len() + 32);
    der.extend_from_slice(ED25519_SPKI_PREFIX);
    der.extend_from_slice(&raw);
    der_to_pem(&der, "PUBLIC KEY")
}

fn private_key_to_pem(sk: &SigningKey) -> String {
    let raw = sk.to_bytes();
    let mut der = Vec::with_capacity(ED25519_PKCS8_PREFIX.len() + 32);
    der.extend_from_slice(ED25519_PKCS8_PREFIX);
    der.extend_from_slice(&raw);
    der_to_pem(&der, "PRIVATE KEY")
}

fn der_to_pem(der: &[u8], label: &str) -> String {
    let b64 = BASE64.encode(der);
    let mut pem = String::new();
    let _ = writeln!(pem, "-----BEGIN {}-----", label);
    for chunk in b64.as_bytes().chunks(64) {
        let _ = writeln!(pem, "{}", std::str::from_utf8(chunk).unwrap());
    }
    let _ = writeln!(pem, "-----END {}-----", label);
    pem
}

fn pem_to_der(pem: &str) -> Option<Vec<u8>> {
    let b64: String = pem
        .lines()
        .filter(|line| !line.starts_with('-') && !line.trim().is_empty())
        .collect();
    BASE64.decode(b64).ok()
}

fn parse_private_key(pem: &str) -> Option<SigningKey> {
    let der = pem_to_der(pem)?;
    // PKCS8 DER: skip 16-byte prefix, read 32-byte seed
    let prefix_len = ED25519_PKCS8_PREFIX.len();
    if der.len() < prefix_len + 32 {
        return None;
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&der[prefix_len..prefix_len + 32]);
    Some(SigningKey::from_bytes(&seed))
}

fn parse_public_key(pem: &str) -> Option<VerifyingKey> {
    let der = pem_to_der(pem)?;
    // SPKI DER: skip 12-byte prefix, read 32-byte public key
    let prefix_len = ED25519_SPKI_PREFIX.len();
    if der.len() < prefix_len + 32 {
        return None;
    }
    let mut key_bytes = [0u8; 32];
    key_bytes.copy_from_slice(&der[prefix_len..prefix_len + 32]);
    VerifyingKey::from_bytes(&key_bytes).ok()
}

pub fn sign_payload(private_key_pem: &str, payload: &serde_json::Value) -> String {
    let signing_key = parse_private_key(private_key_pem).expect("Invalid private key PEM");
    let message = canonical_json(payload);
    let signature = signing_key.sign(message.as_bytes());
    BASE64.encode(signature.to_bytes())
}

pub fn verify_payload(
    public_key_pem: &str,
    payload: &serde_json::Value,
    signature_b64: &str,
) -> bool {
    let verifying_key = match parse_public_key(public_key_pem) {
        Some(k) => k,
        None => return false,
    };
    let sig_bytes = match BASE64.decode(signature_b64) {
        Ok(b) => b,
        Err(_) => return false,
    };
    let signature = match Signature::from_slice(&sig_bytes) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let message = canonical_json(payload);
    verifying_key.verify(message.as_bytes(), &signature).is_ok()
}

fn encode_hex(bytes: impl AsRef<[u8]>) -> String {
    let bytes = bytes.as_ref();
    let mut s = String::with_capacity(bytes.len() * 2);
    const HEX_CHARS: &[u8; 16] = b"0123456789abcdef";
    for &b in bytes {
        s.push(HEX_CHARS[(b >> 4) as usize] as char);
        s.push(HEX_CHARS[(b & 0x0f) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_canonical_json_primitives() {
        assert_eq!(canonical_json(&json!(null)), "null");
        assert_eq!(canonical_json(&json!(true)), "true");
        assert_eq!(canonical_json(&json!(false)), "false");
        assert_eq!(canonical_json(&json!(42)), "42");
        assert_eq!(canonical_json(&json!("hello")), "\"hello\"");
        assert_eq!(canonical_json(&json!("")), "\"\"");
    }

    #[test]
    fn test_canonical_json_sorted_keys() {
        let input = json!({"z": 1, "a": 2, "m": 3});
        assert_eq!(canonical_json(&input), "{\"a\":2,\"m\":3,\"z\":1}");
    }

    #[test]
    fn test_canonical_json_nested() {
        let input = json!({"b": {"d": 4, "c": 3}, "a": [2, 1]});
        assert_eq!(
            canonical_json(&input),
            "{\"a\":[2,1],\"b\":{\"c\":3,\"d\":4}}"
        );
    }

    #[test]
    fn test_canonical_json_empty() {
        assert_eq!(canonical_json(&json!({})), "{}");
        assert_eq!(canonical_json(&json!([])), "[]");
    }

    #[test]
    fn test_sha256_hex() {
        assert_eq!(
            sha256_hex("hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn test_sha256_hex_empty() {
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn test_new_id_format() {
        let id = new_id("p");
        assert!(id.starts_with("p_"));
        assert_eq!(id.len(), 26);
    }

    #[test]
    fn test_sign_verify_roundtrip() {
        let identity = generate_identity();
        let payload = json!({"day": "2024-01-01", "totalTokens": 1000});
        let sig = sign_payload(&identity.identity_private_key, &payload);
        assert!(verify_payload(
            &identity.identity_public_key,
            &payload,
            &sig
        ));
    }

    #[test]
    fn test_verify_rejects_tampered() {
        let identity = generate_identity();
        let payload = json!({"day": "2024-01-01", "totalTokens": 1000});
        let sig = sign_payload(&identity.identity_private_key, &payload);
        let tampered = json!({"day": "2024-01-01", "totalTokens": 999});
        assert!(!verify_payload(
            &identity.identity_public_key,
            &tampered,
            &sig
        ));
    }

    #[test]
    fn test_pem_format_matches_node() {
        let identity = generate_identity();
        let pub_der = pem_to_der(&identity.identity_public_key).unwrap();
        assert_eq!(pub_der.len(), 44);
        assert_eq!(&pub_der[0..12], ED25519_SPKI_PREFIX);
        let priv_der = pem_to_der(&identity.identity_private_key).unwrap();
        assert_eq!(priv_der.len(), 48);
        assert_eq!(&priv_der[0..16], ED25519_PKCS8_PREFIX);
    }

    /// Cross-verification: Node.js generates identity and signs, Rust verifies.
    #[test]
    fn test_node_sign_rust_verify() {
        let node_pub = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAyA4mt5HpNCcgQPRJJU1J6VSW8gs4yb9nEbRk1WfNiJw=\n-----END PUBLIC KEY-----\n";
        let node_priv = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIN5rwiwptZzWEt0KjcJqrmsJK1eufYHJIBIvEWzGdBp/\n-----END PRIVATE KEY-----\n";
        let payload = json!({"day":"2024-01-01","providerId":"test","totalTokens":100});
        let node_sig = "7GK6wVpo292A2rFCFrlUUJd2HptDtj0779hhrzWPfuTpN1wM2kVAQW+Jqd5/HolDrWK1xg3/WxPrVAtn+whuBw==";

        // Verify Node.js signature with Rust
        assert!(verify_payload(node_pub, &payload, node_sig));

        // Sign the same payload with Rust using the Node-generated private key
        let rust_sig = sign_payload(node_priv, &payload);
        // Verify Rust signature with Rust
        assert!(verify_payload(node_pub, &payload, &rust_sig));
        // The signatures may differ due to randomness, but both must verify
    }

    /// Cross-verification: canonicalJson output matches Node.js for all golden cases.
    #[test]
    fn test_canonical_json_golden_cases() {
        let cases = vec![
            (json!(null), "null"),
            (json!(true), "true"),
            (json!(false), "false"),
            (json!(42), "42"),
            (json!(0), "0"),
            (json!(-1), "-1"),
            (json!(0.5), "0.5"),
            (json!(""), "\"\""),
            (json!("hello"), "\"hello\""),
            (json!("世界"), "\"世界\""),
            (json!([]), "[]"),
            (json!([1, 2, 3]), "[1,2,3]"),
            (json!([{}, {"a": 1}]), "[{},{\"a\":1}]"),
            (json!({}), "{}"),
            (json!({"z": 1, "a": 2, "m": 3}), "{\"a\":2,\"m\":3,\"z\":1}"),
            (
                json!({"b": {"d": 4, "c": 3}, "a": [2, 1]}),
                "{\"a\":[2,1],\"b\":{\"c\":3,\"d\":4}}",
            ),
            (
                json!({"名前": "テスト", "key": "value"}),
                "{\"key\":\"value\",\"名前\":\"テスト\"}",
            ),
            (
                json!({"a": {"b": {"c": {"d": 1}}}}),
                "{\"a\":{\"b\":{\"c\":{\"d\":1}}}}",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(canonical_json(&input), expected, "mismatch for {:?}", input);
        }
    }

    /// SHA-256 golden cases from Node.js.
    #[test]
    fn test_sha256_golden_cases() {
        assert_eq!(
            sha256_hex("hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex("world"),
            "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7"
        );
        assert_eq!(
            sha256_hex("test123"),
            "ecd71870d1963316a97e3ac3408c9835ad8cf0f3c1bc703527c30265534f75ae"
        );
    }
}
