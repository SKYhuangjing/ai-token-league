use crate::config::{AppConfig, SyncManifest, load_sync_manifest, queue_path, save_sync_manifest};
use crate::crypto::sign_payload;
use crate::schema::compute_bucket_fingerprint;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;

/// Result of a sync operation.
pub struct SyncResult {
    pub accepted: usize,
    pub rejected: usize,
    pub bucket_count: usize,
    pub uploaded_bucket_count: usize,
    pub noop_bucket_count: usize,
    pub queued: bool,
    pub queue_pending: usize,
    pub queue_uploaded: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct UploadQueue {
    version: u32,
    items: Vec<UploadQueueEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadQueueEntry {
    id: String,
    payload_hash: String,
    participant_id: String,
    device_id: String,
    #[serde(default)]
    queue_key: String,
    payload: Value,
    created_at: String,
    attempts: u32,
    #[serde(default)]
    last_attempt_at: String,
    #[serde(default)]
    last_error: String,
}

#[derive(Debug, Clone)]
struct FailedUpload {
    payload: Value,
    error: String,
}

/// Sync dirty buckets to the server.
pub async fn sync_usage(
    config: &AppConfig,
    items: &[Value],
    api_base_url: &str,
) -> Result<SyncResult, String> {
    // Group by bucket (day|hour|providerId)
    let buckets = crate::scanner::group_by_bucket(items);

    // Load sync manifest
    let mut manifest = load_sync_manifest().unwrap_or_else(|| SyncManifest {
        version: 1,
        buckets: HashMap::new(),
    });

    // Register device before uploading usage. If registration fails, uploading the signed
    // usage facts would fail or become hard to diagnose on the server side.
    let client = reqwest::Client::new();
    register_device(&client, config, api_base_url).await?;

    // Drain upload queue
    let queue_uploaded = drain_upload_queue(&client, config, api_base_url).await;

    // Upload dirty buckets
    let mut accepted = 0;
    let mut rejected = 0;
    let mut uploaded = 0;
    let mut noop = 0;
    let mut failed_buckets: Vec<FailedUpload> = Vec::new();
    let permanent_failed_keys = permanent_failed_queue_keys();

    for (_key, bucket) in &buckets {
        let bucket_items = bucket["items"].as_array().cloned().unwrap_or_default();
        let day = bucket["day"].as_str().unwrap_or("");
        let hour = bucket.get("hour").and_then(|v| v.as_i64()).unwrap_or(0);
        let provider_id = bucket["providerId"].as_str().unwrap_or("");
        let fingerprint = compute_bucket_fingerprint(&bucket_items);

        // Skip if fingerprint matches manifest
        let bucket_key = format!("{}|{}|{}", day, hour, provider_id);
        if let Some(existing) = manifest.buckets.get(&bucket_key) {
            if existing["fingerprint"].as_str() == Some(&fingerprint) {
                noop += 1;
                continue;
            }
        }

        // Build snapshot
        let row_count = bucket_items.len();
        let total_tokens: i64 = bucket_items
            .iter()
            .map(|i| i["totalTokens"].as_i64().unwrap_or(0))
            .sum();

        let snapshot = json!({
            "mode": "device_day_hour_provider",
            "day": day,
            "hour": hour,
            "providerId": provider_id,
            "bucketFingerprint": fingerprint,
            "rowCount": row_count,
            "totalTokens": total_tokens
        });

        // Build payload
        let client_generated_at =
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let client_metadata = crate::version::client_metadata();
        let payload = json!({
            "participantId": config.participant_id,
            "deviceId": config.device_id,
            "clientGeneratedAt": client_generated_at,
            "client": client_metadata,
            "snapshot": snapshot,
            "items": bucket_items
        });

        // Sign
        let signature = sign_payload(&config.identity_private_key, &payload);

        // Upload
        let body = json!({
            "participantId": config.participant_id,
            "deviceId": config.device_id,
            "clientGeneratedAt": client_generated_at,
            "client": client_metadata,
            "snapshot": snapshot,
            "items": bucket_items,
            "signature": signature,
            "identityPublicKey": config.identity_public_key
        });

        if permanent_failed_keys.contains_key(&queue_key_for_payload(&body)) {
            rejected += 1;
            failed_buckets.push(FailedUpload {
                payload: body,
                error: "HTTP 400 Bad Request".to_string(),
            });
            continue;
        }

        match client
            .post(format!("{}/api/usage/daily-batch", api_base_url))
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => {
                if resp.status().is_success() {
                    accepted += 1;
                    uploaded += 1;
                    // Update manifest
                    manifest.buckets.insert(
                        bucket_key,
                        json!({
                            "day": day,
                            "hour": hour,
                            "providerId": provider_id,
                            "fingerprint": fingerprint,
                            "rowCount": row_count,
                            "totalTokens": total_tokens,
                            "syncedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                        }),
                    );
                } else {
                    rejected += 1;
                    failed_buckets.push(FailedUpload {
                        payload: body,
                        error: format!("HTTP {}", resp.status()),
                    });
                }
            }
            Err(error) => {
                rejected += 1;
                failed_buckets.push(FailedUpload {
                    payload: body,
                    error: error.to_string(),
                });
            }
        }
    }

    // Save manifest
    save_sync_manifest(&manifest);

    // Enqueue failed buckets
    let queued = !failed_buckets.is_empty();
    if queued {
        enqueue_failed_buckets(&failed_buckets);
    }

    let queue_pending = count_pending_queue();

    Ok(SyncResult {
        accepted,
        rejected,
        bucket_count: buckets.len(),
        uploaded_bucket_count: uploaded,
        noop_bucket_count: noop,
        queued,
        queue_pending,
        queue_uploaded,
    })
}

pub async fn register_device(
    client: &reqwest::Client,
    config: &AppConfig,
    api_base_url: &str,
) -> Result<(), String> {
    let client_metadata = crate::version::client_metadata();
    let body = json!({
        "participantId": config.participant_id,
        "nickname": config.nickname,
        "deviceId": config.device_id,
        "identityPublicKey": config.identity_public_key,
        "os": client_metadata["os"],
        "appVersion": client_metadata["clientAppVersion"],
        "client": client_metadata,
    });

    let resp = client
        .post(format!("{}/api/devices/register", api_base_url))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("register failed: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("register failed: {} {}", status, text));
    }

    Ok(())
}

async fn drain_upload_queue(
    client: &reqwest::Client,
    _config: &AppConfig,
    api_base_url: &str,
) -> usize {
    let mut queue = read_upload_queue();
    if queue.items.is_empty() {
        return 0;
    }
    let mut uploaded = 0usize;
    let mut remaining = Vec::new();
    for mut entry in queue.items.drain(..) {
        if is_permanent_upload_error(&entry.last_error) {
            remaining.push(entry);
            continue;
        }
        entry.attempts += 1;
        entry.last_attempt_at = now_iso();
        match client
            .post(format!(
                "{}/api/usage/daily-batch",
                api_base_url.trim_end_matches('/')
            ))
            .json(&entry.payload)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                uploaded += 1;
            }
            Ok(resp) => {
                entry.last_error = format!("HTTP {}", resp.status());
                remaining.push(entry);
            }
            Err(error) => {
                entry.last_error = error.to_string();
                remaining.push(entry);
            }
        }
    }
    queue.items = remaining;
    write_upload_queue(&queue);
    uploaded
}

fn enqueue_failed_buckets(buckets: &[FailedUpload]) {
    let mut queue = read_upload_queue();
    for failed in buckets {
        let payload = &failed.payload;
        let queue_key = queue_key_for_payload(payload);
        if queue_key.is_empty() {
            continue;
        }
        let payload_hash =
            crate::crypto::sha256_hex(&serde_json::to_string(payload).unwrap_or_default());
        if let Some(existing) = queue
            .items
            .iter_mut()
            .find(|entry| entry.queue_key == queue_key)
        {
            existing.payload_hash = payload_hash;
            existing.payload = payload.clone();
            existing.last_error = failed.error.clone();
            continue;
        }
        queue.items.push(UploadQueueEntry {
            id: crate::crypto::new_id("q"),
            payload_hash,
            participant_id: payload["participantId"].as_str().unwrap_or("").to_string(),
            device_id: payload["deviceId"].as_str().unwrap_or("").to_string(),
            queue_key,
            payload: payload.clone(),
            created_at: now_iso(),
            attempts: 0,
            last_attempt_at: String::new(),
            last_error: failed.error.clone(),
        });
    }
    write_upload_queue(&queue);
}

fn is_permanent_upload_error(error: &str) -> bool {
    error.starts_with("HTTP 400")
}

fn permanent_failed_queue_keys() -> HashMap<String, bool> {
    read_upload_queue()
        .items
        .into_iter()
        .filter(|entry| is_permanent_upload_error(&entry.last_error))
        .map(|entry| (entry.queue_key, true))
        .collect()
}

fn queue_key_for_payload(payload: &Value) -> String {
    let snapshot = &payload["snapshot"];
    let participant_id = payload["participantId"].as_str().unwrap_or("");
    let device_id = payload["deviceId"].as_str().unwrap_or("");
    let mode = snapshot["mode"].as_str().unwrap_or("");
    let day = snapshot["day"].as_str().unwrap_or("");
    let hour = snapshot
        .get("hour")
        .and_then(|v| v.as_i64())
        .map(|v| v.to_string())
        .unwrap_or_default();
    let provider_id = snapshot["providerId"].as_str().unwrap_or("");
    if participant_id.is_empty()
        || device_id.is_empty()
        || mode.is_empty()
        || day.is_empty()
        || provider_id.is_empty()
    {
        return String::new();
    }
    format!(
        "{}|{}|{}|{}|{}|{}",
        participant_id, device_id, mode, day, hour, provider_id
    )
}

fn count_pending_queue() -> usize {
    read_upload_queue().items.len()
}

fn read_upload_queue() -> UploadQueue {
    let path = queue_path();
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(_) => {
            return UploadQueue {
                version: 1,
                items: vec![],
            };
        }
    };
    let mut queue: UploadQueue = serde_json::from_str(&content).unwrap_or_else(|_| UploadQueue {
        version: 1,
        items: vec![],
    });
    if queue.version == 0 {
        queue.version = 1;
    }
    normalize_upload_queue(queue)
}

fn normalize_upload_queue(mut queue: UploadQueue) -> UploadQueue {
    let mut items: Vec<UploadQueueEntry> = Vec::new();
    let mut indexes: HashMap<String, usize> = HashMap::new();
    for mut entry in queue.items.drain(..) {
        if entry.queue_key.is_empty() {
            entry.queue_key = queue_key_for_payload(&entry.payload);
        }
        if entry.queue_key.is_empty() {
            continue;
        }
        if let Some(existing_idx) = indexes.get(&entry.queue_key).copied() {
            let existing = &mut items[existing_idx];
            existing.attempts = existing.attempts.max(entry.attempts);
            if existing.last_attempt_at < entry.last_attempt_at {
                existing.last_attempt_at = entry.last_attempt_at;
            }
            if !entry.last_error.is_empty() {
                existing.last_error = entry.last_error;
            }
            existing.payload_hash = entry.payload_hash;
            existing.payload = entry.payload;
        } else {
            indexes.insert(entry.queue_key.clone(), items.len());
            items.push(entry);
        }
    }
    queue.items = items;
    queue
}

fn write_upload_queue(queue: &UploadQueue) {
    let path = queue_path();
    if queue.items.is_empty() {
        let _ = fs::remove_file(&path);
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    if let Ok(json) = serde_json::to_string_pretty(queue) {
        if fs::write(&tmp, format!("{}\n", json)).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hourly_payload(generated_at: &str) -> Value {
        json!({
            "participantId": "p1",
            "deviceId": "d1",
            "clientGeneratedAt": generated_at,
            "snapshot": {
                "mode": "device_day_hour_provider",
                "day": "2026-05-16",
                "hour": 8,
                "providerId": "codex_local"
            }
        })
    }

    #[test]
    fn queue_key_is_stable_across_payload_generation_time() {
        assert_eq!(
            queue_key_for_payload(&hourly_payload("2026-05-16T00:00:00.000Z")),
            queue_key_for_payload(&hourly_payload("2026-05-16T00:01:00.000Z"))
        );
    }

    #[test]
    fn normalize_upload_queue_dedupes_by_business_key() {
        let queue = UploadQueue {
            version: 1,
            items: vec![
                UploadQueueEntry {
                    id: "q1".to_string(),
                    payload_hash: "h1".to_string(),
                    participant_id: "p1".to_string(),
                    device_id: "d1".to_string(),
                    queue_key: String::new(),
                    payload: hourly_payload("2026-05-16T00:00:00.000Z"),
                    created_at: "t1".to_string(),
                    attempts: 1,
                    last_attempt_at: "2026-05-16T00:00:00.000Z".to_string(),
                    last_error: "HTTP 400 Bad Request".to_string(),
                },
                UploadQueueEntry {
                    id: "q2".to_string(),
                    payload_hash: "h2".to_string(),
                    participant_id: "p1".to_string(),
                    device_id: "d1".to_string(),
                    queue_key: String::new(),
                    payload: hourly_payload("2026-05-16T00:01:00.000Z"),
                    created_at: "t2".to_string(),
                    attempts: 3,
                    last_attempt_at: "2026-05-16T00:01:00.000Z".to_string(),
                    last_error: "HTTP 400 Bad Request".to_string(),
                },
            ],
        };
        let normalized = normalize_upload_queue(queue);
        assert_eq!(normalized.items.len(), 1);
        assert_eq!(normalized.items[0].attempts, 3);
        assert_eq!(normalized.items[0].payload_hash, "h2");
    }

    #[test]
    fn http_400_is_permanent_upload_error() {
        assert!(is_permanent_upload_error("HTTP 400 Bad Request"));
        assert!(!is_permanent_upload_error("HTTP 500 Internal Server Error"));
    }
}
