use crate::config::{
    load_sync_manifest_for, queue_path, save_sync_manifest_for, AppConfig, SyncManifest,
};
use crate::crypto::sign_payload;
use crate::schema::compute_bucket_fingerprint;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::net::IpAddr;

const MAX_QUEUE_DRAIN_PER_RUN: usize = 50;
const MAX_RETRY_DELAY_MINUTES: i64 = 6 * 60;

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
    pub queue_attempted: usize,
    pub queue_failed: usize,
    pub new_failed_bucket_count: usize,
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
    next_attempt_at: String,
    #[serde(default)]
    last_error: String,
}

#[derive(Debug, Clone)]
struct FailedUpload {
    payload: Value,
    error: String,
}

#[derive(Debug, Default)]
struct QueueDrainStats {
    attempted: usize,
    uploaded: usize,
    failed: usize,
}

/// Sync dirty buckets to the server.
pub async fn sync_usage(
    config: &AppConfig,
    items: &[Value],
    api_base_url: &str,
) -> Result<SyncResult, String> {
    // Group by bucket (day|hour|providerId)
    let buckets = crate::scanner::group_by_bucket(items);

    // Load sync manifest for this server URL
    let mut manifest = load_sync_manifest_for(api_base_url);

    // Register device before uploading usage. If registration fails, uploading the signed
    // usage facts would fail or become hard to diagnose on the server side.
    let client = reqwest::Client::new();
    register_device(&client, config, api_base_url).await?;

    // Drain upload queue
    let queue_drain = drain_upload_queue(&client, &mut manifest, api_base_url).await;

    reconcile_sync_state(&client, config, api_base_url, &mut manifest, &buckets).await;

    // Upload dirty buckets
    let mut accepted = 0;
    let mut rejected = 0;
    let mut uploaded = 0;
    let mut noop = 0;
    let mut failed_buckets: Vec<FailedUpload> = Vec::new();

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
                    update_manifest_bucket(
                        &mut manifest,
                        &bucket_key,
                        day,
                        hour,
                        provider_id,
                        &fingerprint,
                        row_count,
                        total_tokens,
                    );
                    save_sync_manifest_for(api_base_url, &manifest);
                } else {
                    let status = resp.status();
                    rejected += 1;
                    append_upload_failure_event(
                        "usage_upload_failed",
                        &body,
                        format!("HTTP {}", status),
                        Some(status.as_u16()),
                        0,
                    );
                    failed_buckets.push(FailedUpload {
                        payload: body,
                        error: format!("HTTP {}", status),
                    });
                }
            }
            Err(error) => {
                let error_text = error.to_string();
                rejected += 1;
                append_upload_failure_event(
                    "usage_upload_failed",
                    &body,
                    error_text.clone(),
                    None,
                    0,
                );
                failed_buckets.push(FailedUpload {
                    payload: body,
                    error: error_text,
                });
            }
        }
    }

    // Save manifest
    save_sync_manifest_for(api_base_url, &manifest);

    // Enqueue failed buckets
    let queued = !failed_buckets.is_empty();
    if queued {
        enqueue_failed_buckets(&failed_buckets);
    }

    let queue_pending = count_pending_queue();
    crate::observability::append_runtime_event(
        "sync",
        "usage_sync_summary",
        if rejected > 0 || queue_drain.failed > 0 {
            "warn"
        } else {
            "info"
        },
        json!({
            "accepted": accepted,
            "rejected": rejected,
            "bucketCount": buckets.len(),
            "uploadedBucketCount": uploaded,
            "noopBucketCount": noop,
            "queued": queued,
            "queuePending": queue_pending,
            "queueAttempted": queue_drain.attempted,
            "queueUploaded": queue_drain.uploaded,
            "queueFailed": queue_drain.failed,
            "newFailedBucketCount": failed_buckets.len()
        }),
    );

    Ok(SyncResult {
        accepted,
        rejected,
        bucket_count: buckets.len(),
        uploaded_bucket_count: uploaded,
        noop_bucket_count: noop,
        queued,
        queue_pending,
        queue_uploaded: queue_drain.uploaded,
        queue_attempted: queue_drain.attempted,
        queue_failed: queue_drain.failed,
        new_failed_bucket_count: failed_buckets.len(),
    })
}

async fn reconcile_sync_state(
    client: &reqwest::Client,
    config: &AppConfig,
    api_base_url: &str,
    manifest: &mut SyncManifest,
    buckets: &[(String, Value)],
) {
    let local_buckets = build_sync_state_buckets(manifest, buckets);
    if local_buckets.is_empty() {
        return;
    }
    let client_generated_at =
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let payload = json!({
        "participantId": config.participant_id,
        "deviceId": config.device_id,
        "clientGeneratedAt": client_generated_at,
        "buckets": local_buckets,
    });
    let signature = sign_payload(&config.identity_private_key, &payload);
    let body = json!({
        "participantId": config.participant_id,
        "deviceId": config.device_id,
        "clientGeneratedAt": client_generated_at,
        "buckets": payload["buckets"],
        "signature": signature,
    });

    let Ok(resp) = client
        .post(format!(
            "{}/api/usage/sync-state",
            api_base_url.trim_end_matches('/')
        ))
        .json(&body)
        .send()
        .await
    else {
        return;
    };
    if !resp.status().is_success() {
        return;
    }
    let Ok(response_body) = resp.json::<Value>().await else {
        return;
    };
    if apply_sync_state_response(manifest, &response_body) {
        save_sync_manifest_for(api_base_url, manifest);
    }
}

fn build_sync_state_buckets(manifest: &SyncManifest, buckets: &[(String, Value)]) -> Vec<Value> {
    buckets
        .iter()
        .filter_map(|(bucket_key, bucket)| {
            let existing = manifest.buckets.get(bucket_key)?;
            let fingerprint = existing.get("fingerprint")?.as_str()?;
            Some(json!({
                "day": bucket["day"].as_str().unwrap_or(""),
                "hour": bucket.get("hour").and_then(|v| v.as_i64()).unwrap_or(0),
                "providerId": bucket["providerId"].as_str().unwrap_or(""),
                "fingerprint": fingerprint,
            }))
        })
        .collect()
}

fn apply_sync_state_response(manifest: &mut SyncManifest, response: &Value) -> bool {
    let mut changed = false;
    for key in ["missing", "different"] {
        let Some(items) = response.get(key).and_then(|v| v.as_array()) else {
            continue;
        };
        for item in items {
            let day = item["day"].as_str().unwrap_or("");
            let hour = item.get("hour").and_then(|v| v.as_i64()).unwrap_or(0);
            let provider_id = item["providerId"].as_str().unwrap_or("");
            if day.is_empty() || provider_id.is_empty() {
                continue;
            }
            let bucket_key = format!("{}|{}|{}", day, hour, provider_id);
            changed |= manifest.buckets.remove(&bucket_key).is_some();
        }
    }
    changed
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
        "networkInfo": collect_network_info(),
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

fn collect_network_info() -> Value {
    let lan_ips: Vec<String> = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(_name, ip)| match ip {
            IpAddr::V4(addr) if !addr.is_loopback() && !addr.is_unspecified() => {
                Some(addr.to_string())
            }
            _ => None,
        })
        .collect();
    json!({ "lanIps": lan_ips })
}

async fn drain_upload_queue(
    client: &reqwest::Client,
    manifest: &mut SyncManifest,
    api_base_url: &str,
) -> QueueDrainStats {
    let mut queue = read_upload_queue();
    if queue.items.is_empty() {
        return QueueDrainStats::default();
    }
    let initial_pending = queue.items.len();
    let mut uploaded = 0usize;
    let mut failed = 0usize;
    let mut remaining = Vec::new();
    let mut attempted = 0usize;
    for mut entry in queue.items.drain(..) {
        if attempted >= MAX_QUEUE_DRAIN_PER_RUN || !is_queue_entry_due(&entry) {
            remaining.push(entry);
            continue;
        }
        attempted += 1;
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
                update_manifest_from_payload(manifest, &entry.payload);
                save_sync_manifest_for(api_base_url, manifest);
            }
            Ok(resp) => {
                let status = resp.status();
                failed += 1;
                entry.last_error = format!("HTTP {}", status);
                entry.next_attempt_at = next_retry_at(entry.attempts);
                append_upload_failure_event(
                    "usage_queue_retry_failed",
                    &entry.payload,
                    entry.last_error.clone(),
                    Some(status.as_u16()),
                    entry.attempts,
                );
                remaining.push(entry);
            }
            Err(error) => {
                failed += 1;
                entry.last_error = error.to_string();
                entry.next_attempt_at = next_retry_at(entry.attempts);
                append_upload_failure_event(
                    "usage_queue_retry_failed",
                    &entry.payload,
                    entry.last_error.clone(),
                    None,
                    entry.attempts,
                );
                remaining.push(entry);
            }
        }
    }
    queue.items = remaining;
    let remaining_count = queue.items.len();
    write_upload_queue(&queue);
    crate::observability::append_runtime_event(
        "sync",
        "usage_queue_drain",
        if failed > 0 { "warn" } else { "info" },
        json!({
            "initialPending": initial_pending,
            "attempted": attempted,
            "uploaded": uploaded,
            "failed": failed,
            "remaining": remaining_count,
            "maxAttemptedPerRun": MAX_QUEUE_DRAIN_PER_RUN
        }),
    );
    QueueDrainStats {
        attempted,
        uploaded,
        failed,
    }
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
            existing.next_attempt_at = next_retry_at(existing.attempts);
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
            next_attempt_at: next_retry_at(0),
            last_error: failed.error.clone(),
        });
    }
    write_upload_queue(&queue);
}

fn append_upload_failure_event(
    event: &str,
    payload: &Value,
    error: String,
    http_status: Option<u16>,
    retry_attempt: u32,
) {
    let snapshot = &payload["snapshot"];
    crate::observability::append_runtime_event(
        "sync",
        event,
        "warn",
        json!({
            "participantId": payload["participantId"].as_str().unwrap_or(""),
            "deviceId": payload["deviceId"].as_str().unwrap_or(""),
            "clientGeneratedAt": payload["clientGeneratedAt"].as_str().unwrap_or(""),
            "snapshot": {
                "mode": snapshot["mode"].as_str().unwrap_or(""),
                "day": snapshot["day"].as_str().unwrap_or(""),
                "hour": snapshot.get("hour").and_then(|v| v.as_i64()),
                "providerId": snapshot["providerId"].as_str().unwrap_or(""),
                "bucketFingerprint": snapshot["bucketFingerprint"].as_str().unwrap_or(""),
                "rowCount": snapshot["rowCount"].as_i64().unwrap_or(0),
                "totalTokens": snapshot["totalTokens"].as_i64().unwrap_or(0)
            },
            "queueKey": queue_key_for_payload(payload),
            "httpStatus": http_status,
            "retryAttempt": retry_attempt,
            "errorKind": upload_error_kind(&error, http_status),
            "error": truncate_error(&error)
        }),
    );
}

fn upload_error_kind(error: &str, http_status: Option<u16>) -> String {
    if let Some(status) = http_status {
        return format!("http_{}", status);
    }
    if error.to_lowercase().contains("timeout") {
        return "timeout".to_string();
    }
    "transport_error".to_string()
}

fn truncate_error(error: &str) -> String {
    error.chars().take(500).collect()
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

fn manifest_bucket_key_for_payload(payload: &Value) -> String {
    let snapshot = &payload["snapshot"];
    let day = snapshot["day"].as_str().unwrap_or("");
    let hour = snapshot
        .get("hour")
        .and_then(|v| v.as_i64())
        .map(|v| v.to_string())
        .unwrap_or_else(|| "0".to_string());
    let provider_id = snapshot["providerId"].as_str().unwrap_or("");
    if day.is_empty() || provider_id.is_empty() {
        return String::new();
    }
    format!("{}|{}|{}", day, hour, provider_id)
}

fn update_manifest_from_payload(manifest: &mut SyncManifest, payload: &Value) {
    let snapshot = &payload["snapshot"];
    let bucket_key = manifest_bucket_key_for_payload(payload);
    if bucket_key.is_empty() {
        return;
    }
    let items = payload["items"].as_array().cloned().unwrap_or_default();
    let fingerprint = snapshot["bucketFingerprint"]
        .as_str()
        .map(|value| value.to_string())
        .unwrap_or_else(|| compute_bucket_fingerprint(&items));
    let day = snapshot["day"].as_str().unwrap_or("");
    let hour = snapshot.get("hour").and_then(|v| v.as_i64()).unwrap_or(0);
    let provider_id = snapshot["providerId"].as_str().unwrap_or("");
    let row_count = snapshot["rowCount"]
        .as_i64()
        .unwrap_or(items.len() as i64)
        .max(0) as usize;
    let total_tokens = snapshot["totalTokens"].as_i64().unwrap_or_else(|| {
        items
            .iter()
            .map(|item| item["totalTokens"].as_i64().unwrap_or(0))
            .sum()
    });
    update_manifest_bucket(
        manifest,
        &bucket_key,
        day,
        hour,
        provider_id,
        &fingerprint,
        row_count,
        total_tokens,
    );
}

fn update_manifest_bucket(
    manifest: &mut SyncManifest,
    bucket_key: &str,
    day: &str,
    hour: i64,
    provider_id: &str,
    fingerprint: &str,
    row_count: usize,
    total_tokens: i64,
) {
    manifest.buckets.insert(
        bucket_key.to_string(),
        json!({
            "day": day,
            "hour": hour,
            "providerId": provider_id,
            "fingerprint": fingerprint,
            "rowCount": row_count,
            "totalTokens": total_tokens,
            "syncedAt": now_iso()
        }),
    );
}

fn is_queue_entry_due(entry: &UploadQueueEntry) -> bool {
    if entry.next_attempt_at.trim().is_empty() {
        return true;
    }
    let Ok(next_attempt_at) = chrono::DateTime::parse_from_rfc3339(&entry.next_attempt_at) else {
        return true;
    };
    chrono::Utc::now() >= next_attempt_at.with_timezone(&chrono::Utc)
}

fn next_retry_at(attempts: u32) -> String {
    let exponent = attempts.saturating_sub(1).min(8);
    let delay_minutes = (1_i64 << exponent).min(MAX_RETRY_DELAY_MINUTES);
    (chrono::Utc::now() + chrono::Duration::minutes(delay_minutes))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
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
            if !entry.next_attempt_at.is_empty() {
                existing.next_attempt_at = entry.next_attempt_at;
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
                "providerId": "codex_local",
                "bucketFingerprint": "fp1",
                "rowCount": 1,
                "totalTokens": 42
            },
            "items": [{"day": "2026-05-16", "hour": 8, "providerId": "codex_local", "totalTokens": 42}]
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
                    next_attempt_at: "2026-05-16T00:02:00.000Z".to_string(),
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
                    next_attempt_at: "2026-05-16T00:04:00.000Z".to_string(),
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
    fn manifest_updates_from_queued_snapshot_payload() {
        let mut manifest = SyncManifest {
            version: 1,
            buckets: HashMap::new(),
        };
        update_manifest_from_payload(&mut manifest, &hourly_payload("2026-05-16T00:00:00.000Z"));
        let row = manifest.buckets.get("2026-05-16|8|codex_local").unwrap();
        assert_eq!(row["fingerprint"], "fp1");
        assert_eq!(row["rowCount"], 1);
        assert_eq!(row["totalTokens"], 42);
    }

    #[test]
    fn network_info_serializes_lan_ips_array() {
        let info = collect_network_info();
        assert!(info["lanIps"].is_array());
        for ip in info["lanIps"].as_array().unwrap() {
            let parsed = ip.as_str().unwrap().parse::<std::net::Ipv4Addr>().unwrap();
            assert!(!parsed.is_loopback());
            assert!(!parsed.is_unspecified());
        }
    }

    #[test]
    fn sync_state_response_invalidates_missing_and_different_buckets() {
        let mut manifest = SyncManifest {
            version: 1,
            buckets: HashMap::from([
                (
                    "2026-05-16|8|codex_local".to_string(),
                    json!({"fingerprint": "fp1"}),
                ),
                (
                    "2026-05-16|9|cursor_dashboard_usage".to_string(),
                    json!({"fingerprint": "fp2"}),
                ),
                (
                    "2026-05-16|10|claude_code_local".to_string(),
                    json!({"fingerprint": "fp3"}),
                ),
            ]),
        };
        let changed = apply_sync_state_response(
            &mut manifest,
            &json!({
                "missing": [{"day": "2026-05-16", "hour": 8, "providerId": "codex_local"}],
                "different": [{"day": "2026-05-16", "hour": 9, "providerId": "cursor_dashboard_usage"}],
                "matched": [{"day": "2026-05-16", "hour": 10, "providerId": "claude_code_local"}],
            }),
        );
        assert!(changed);
        assert!(!manifest.buckets.contains_key("2026-05-16|8|codex_local"));
        assert!(!manifest
            .buckets
            .contains_key("2026-05-16|9|cursor_dashboard_usage"));
        assert!(manifest
            .buckets
            .contains_key("2026-05-16|10|claude_code_local"));
    }

    #[test]
    fn queue_retry_respects_next_attempt_at() {
        let due = UploadQueueEntry {
            id: "q1".to_string(),
            payload_hash: "h1".to_string(),
            participant_id: "p1".to_string(),
            device_id: "d1".to_string(),
            queue_key: String::new(),
            payload: hourly_payload("2026-05-16T00:00:00.000Z"),
            created_at: "t1".to_string(),
            attempts: 1,
            last_attempt_at: String::new(),
            next_attempt_at: (chrono::Utc::now() - chrono::Duration::minutes(1))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            last_error: "HTTP 400 Bad Request".to_string(),
        };
        let not_due = UploadQueueEntry {
            next_attempt_at: (chrono::Utc::now() + chrono::Duration::minutes(10))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            ..due.clone()
        };
        assert!(is_queue_entry_due(&due));
        assert!(!is_queue_entry_due(&not_due));
    }
}
