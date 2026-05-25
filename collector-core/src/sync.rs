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
const MAX_BATCH_UPLOAD_BUCKETS: usize = 25;
const SYNC_STATE_BUCKET_LIMIT: usize = 250;
const RECENT_SYNC_STATE_WINDOW_DAYS: i64 = 35;

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
    pub full_reconcile_pending: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncRunPhase {
    Idle,
    Scanning,
    Uploading,
    RetryingQueue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncOutcome {
    Success,
    Failed,
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
pub struct FailedUpload {
    pub payload: Value,
    pub error: String,
}

#[derive(Debug, Clone)]
pub struct PreparedUpload {
    pub bucket_key: String,
    pub day: String,
    pub hour: i64,
    pub provider_id: String,
    pub fingerprint: String,
    pub row_count: usize,
    pub total_tokens: i64,
    pub snapshot: Value,
    pub items: Vec<Value>,
    pub body: Value,
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
    let should_mark_first_server_reconcile = manifest.full_reconcile.is_none() && !items.is_empty();

    // Register device before uploading usage. If registration fails, uploading the signed
    // usage facts would fail or become hard to diagnose on the server side.
    let client = reqwest::Client::new();
    register_device(&client, config, api_base_url).await?;

    // Drain upload queue
    let queue_drain = drain_upload_queue(&client, &mut manifest, api_base_url).await;

    let recent_reconcile =
        reconcile_sync_state(&client, config, api_base_url, &mut manifest, &buckets).await;

    // Upload dirty buckets
    let mut accepted = 0;
    let mut rejected = 0;
    let mut uploaded = 0;
    let mut noop = 0;
    let mut failed_buckets: Vec<FailedUpload> = Vec::new();

    let mut dirty_uploads: Vec<PreparedUpload> = Vec::new();
    let client_metadata = crate::version::client_metadata();

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

        let client_generated_at =
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let payload = json!({
            "participantId": config.participant_id,
            "deviceId": config.device_id,
            "clientGeneratedAt": client_generated_at,
            "client": client_metadata,
            "snapshot": snapshot,
            "items": bucket_items
        });

        let signature = sign_payload(&config.identity_private_key, &payload);
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

        dirty_uploads.push(PreparedUpload {
            bucket_key,
            day: day.to_string(),
            hour,
            provider_id: provider_id.to_string(),
            fingerprint,
            row_count,
            total_tokens,
            snapshot,
            items: bucket_items,
            body,
        });
    }

    for chunk in dirty_uploads.chunks(MAX_BATCH_UPLOAD_BUCKETS) {
        upload_prepared_chunk(
            &client,
            config,
            api_base_url,
            chunk,
            &mut manifest,
            &mut accepted,
            &mut rejected,
            &mut uploaded,
            &mut failed_buckets,
        )
        .await;
    }

    // Save manifest
    save_sync_manifest_for(api_base_url, &manifest);

    if recent_reconcile.server_fingerprint_changed {
        crate::reconcile::mark_full_reconcile_pending(
            api_base_url,
            crate::reconcile::FullReconcileTrigger::FirstServerIdentity,
        );
    } else if should_mark_first_server_reconcile {
        crate::reconcile::mark_full_reconcile_pending(
            api_base_url,
            crate::reconcile::FullReconcileTrigger::FirstServerIdentity,
        );
    } else if recent_reconcile.detected_gap {
        crate::reconcile::mark_full_reconcile_pending(
            api_base_url,
            crate::reconcile::FullReconcileTrigger::MissingHistoryDetected,
        );
    }

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

    let reconcile_state = crate::reconcile::load_full_reconcile_state(api_base_url);
    let full_reconcile_pending =
        crate::reconcile::full_reconcile_should_auto_run(reconcile_state.status);

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
        full_reconcile_pending,
    })
}

#[derive(Debug, Default)]
struct SyncStateReconcileOutcome {
    detected_gap: bool,
    server_fingerprint_changed: bool,
}

pub async fn upload_prepared_chunk(
    client: &reqwest::Client,
    config: &AppConfig,
    api_base_url: &str,
    chunk: &[PreparedUpload],
    manifest: &mut SyncManifest,
    accepted: &mut usize,
    rejected: &mut usize,
    uploaded: &mut usize,
    failed_buckets: &mut Vec<FailedUpload>,
) {
    if chunk.is_empty() {
        return;
    }
    if chunk.len() == 1 {
        upload_prepared_single(
            client,
            api_base_url,
            &chunk[0],
            manifest,
            accepted,
            rejected,
            uploaded,
            failed_buckets,
        )
        .await;
        return;
    }

    let client_generated_at =
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let client_metadata = crate::version::client_metadata();
    let batches = chunk
        .iter()
        .map(|upload| {
            json!({
                "snapshot": upload.snapshot.clone(),
                "items": upload.items.clone()
            })
        })
        .collect::<Vec<_>>();
    let payload = json!({
        "participantId": config.participant_id,
        "deviceId": config.device_id,
        "clientGeneratedAt": client_generated_at,
        "client": client_metadata,
        "batches": batches
    });
    let signature = sign_payload(&config.identity_private_key, &payload);
    let body = json!({
        "participantId": config.participant_id,
        "deviceId": config.device_id,
        "clientGeneratedAt": client_generated_at,
        "client": client_metadata,
        "batches": payload["batches"],
        "signature": signature,
        "identityPublicKey": config.identity_public_key
    });

    match client
        .post(format!(
            "{}/api/usage/daily-batches",
            api_base_url.trim_end_matches('/')
        ))
        .json(&body)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => match resp.json::<Value>().await {
            Ok(body) => apply_batch_upload_response(
                chunk,
                manifest,
                &body,
                accepted,
                rejected,
                uploaded,
                failed_buckets,
            ),
            Err(error) => {
                let error_text = format!("invalid batch upload response: {}", error);
                for upload in chunk {
                    mark_upload_failure(upload, error_text.clone(), None, failed_buckets);
                    *rejected += 1;
                }
            }
        },
        Ok(resp) if matches!(resp.status().as_u16(), 404 | 405 | 501) => {
            for upload in chunk {
                upload_prepared_single(
                    client,
                    api_base_url,
                    upload,
                    manifest,
                    accepted,
                    rejected,
                    uploaded,
                    failed_buckets,
                )
                .await;
            }
        }
        Ok(resp) => {
            let status = resp.status();
            for upload in chunk {
                mark_upload_failure(
                    upload,
                    format!("HTTP {}", status),
                    Some(status.as_u16()),
                    failed_buckets,
                );
                *rejected += 1;
            }
        }
        Err(error) => {
            let error_text = error.to_string();
            for upload in chunk {
                mark_upload_failure(upload, error_text.clone(), None, failed_buckets);
                *rejected += 1;
            }
        }
    }
}

fn apply_batch_upload_response(
    chunk: &[PreparedUpload],
    manifest: &mut SyncManifest,
    body: &Value,
    accepted: &mut usize,
    rejected: &mut usize,
    uploaded: &mut usize,
    failed_buckets: &mut Vec<FailedUpload>,
) {
    let Some(results) = body.get("results").and_then(|value| value.as_array()) else {
        for upload in chunk {
            mark_upload_failure(
                upload,
                "batch upload response missing results".to_string(),
                None,
                failed_buckets,
            );
            *rejected += 1;
        }
        return;
    };

    for (index, upload) in chunk.iter().enumerate() {
        let result = results
            .iter()
            .find(|item| item.get("index").and_then(|value| value.as_u64()) == Some(index as u64));
        if is_bucket_upload_confirmed(upload, result) {
            mark_upload_success(manifest, upload);
            *accepted += 1;
            *uploaded += 1;
            continue;
        }

        let error = result
            .map(|item| {
                let accepted_rows = item
                    .get("accepted")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let rejected_rows = item
                    .get("rejected")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                format!(
                    "batch bucket not fully accepted: accepted={}, rejected={}",
                    accepted_rows, rejected_rows
                )
            })
            .unwrap_or_else(|| "batch upload response missing bucket result".to_string());
        mark_upload_failure(upload, error, None, failed_buckets);
        *rejected += 1;
    }
}

fn is_bucket_upload_confirmed(upload: &PreparedUpload, result: Option<&Value>) -> bool {
    let Some(result) = result else {
        return false;
    };
    if result.get("duplicate").and_then(|value| value.as_bool()) == Some(true)
        || result.get("noOp").and_then(|value| value.as_bool()) == Some(true)
    {
        return true;
    }
    let accepted_rows = result
        .get("accepted")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let rejected_rows = result
        .get("rejected")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    rejected_rows == 0 && accepted_rows == upload.row_count as u64
}

async fn upload_prepared_single(
    client: &reqwest::Client,
    api_base_url: &str,
    upload: &PreparedUpload,
    manifest: &mut SyncManifest,
    accepted: &mut usize,
    rejected: &mut usize,
    uploaded: &mut usize,
    failed_buckets: &mut Vec<FailedUpload>,
) {
    match client
        .post(format!(
            "{}/api/usage/daily-batch",
            api_base_url.trim_end_matches('/')
        ))
        .json(&upload.body)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            *accepted += 1;
            *uploaded += 1;
            mark_upload_success(manifest, upload);
        }
        Ok(resp) => {
            let status = resp.status();
            *rejected += 1;
            mark_upload_failure(
                upload,
                format!("HTTP {}", status),
                Some(status.as_u16()),
                failed_buckets,
            );
        }
        Err(error) => {
            *rejected += 1;
            mark_upload_failure(upload, error.to_string(), None, failed_buckets);
        }
    }
}

fn mark_upload_success(manifest: &mut SyncManifest, upload: &PreparedUpload) {
    let mode = upload
        .snapshot
        .get("mode")
        .and_then(|value| value.as_str())
        .unwrap_or("device_day_hour_provider");
    update_manifest_bucket(
        manifest,
        &upload.bucket_key,
        &upload.day,
        upload.hour,
        &upload.provider_id,
        &upload.fingerprint,
        upload.row_count,
        upload.total_tokens,
        mode,
    );
}

fn mark_upload_failure(
    upload: &PreparedUpload,
    error: String,
    status_code: Option<u16>,
    failed_buckets: &mut Vec<FailedUpload>,
) {
    append_upload_failure_event(
        "usage_upload_failed",
        &upload.body,
        error.clone(),
        status_code,
        0,
    );
    failed_buckets.push(FailedUpload {
        payload: upload.body.clone(),
        error,
    });
}

async fn reconcile_sync_state(
    client: &reqwest::Client,
    config: &AppConfig,
    api_base_url: &str,
    manifest: &mut SyncManifest,
    buckets: &[(String, Value)],
) -> SyncStateReconcileOutcome {
    let local_buckets = build_sync_state_buckets(manifest, buckets);
    let should_probe_server = !manifest.buckets.is_empty();
    if local_buckets.is_empty() && !should_probe_server {
        return SyncStateReconcileOutcome::default();
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
        return SyncStateReconcileOutcome::default();
    };
    if !resp.status().is_success() {
        return SyncStateReconcileOutcome::default();
    }
    let Ok(response_body) = resp.json::<Value>().await else {
        return SyncStateReconcileOutcome::default();
    };
    let detected_gap = sync_state_response_has_gap(&response_body);
    let server_fingerprint = response_body
        .get("serverFingerprint")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .map(|v| v.to_string());
    let server_fingerprint_changed =
        reconcile_server_fingerprint_changed(manifest, server_fingerprint.as_deref());
    if let Some(fingerprint) = server_fingerprint.as_deref() {
        manifest.verified_server_fingerprint = Some(fingerprint.to_string());
    }
    if apply_sync_state_response(manifest, &response_body) {
        save_sync_manifest_for(api_base_url, manifest);
    } else if server_fingerprint.is_some() {
        save_sync_manifest_for(api_base_url, manifest);
    }
    SyncStateReconcileOutcome {
        detected_gap,
        server_fingerprint_changed,
    }
}

fn reconcile_server_fingerprint_changed(
    manifest: &SyncManifest,
    server_fingerprint: Option<&str>,
) -> bool {
    let Some(server_fingerprint) = server_fingerprint.filter(|v| !v.trim().is_empty()) else {
        return false;
    };
    let Some(verified) = manifest
        .verified_server_fingerprint
        .as_deref()
        .filter(|v| !v.trim().is_empty())
    else {
        return false;
    };
    verified != server_fingerprint
}

fn build_sync_state_buckets(manifest: &SyncManifest, buckets: &[(String, Value)]) -> Vec<Value> {
    let cutoff_day = (chrono::Utc::now() - chrono::Duration::days(RECENT_SYNC_STATE_WINDOW_DAYS))
        .format("%Y-%m-%d")
        .to_string();
    let mut local_buckets = buckets
        .iter()
        .filter_map(|(bucket_key, bucket)| {
            let day = bucket["day"].as_str().unwrap_or("");
            if day < cutoff_day.as_str() {
                return None;
            }
            let existing = manifest.buckets.get(bucket_key)?;
            let fingerprint = existing.get("fingerprint")?.as_str()?;
            Some((
                bucket_key.clone(),
                json!({
                    "day": day,
                    "hour": bucket.get("hour").and_then(|v| v.as_i64()).unwrap_or(0),
                    "providerId": bucket["providerId"].as_str().unwrap_or(""),
                    "fingerprint": fingerprint,
                }),
            ))
        })
        .collect::<Vec<_>>();
    local_buckets.sort_by(|a, b| b.0.cmp(&a.0));
    local_buckets
        .into_iter()
        .take(SYNC_STATE_BUCKET_LIMIT)
        .map(|(_, bucket)| bucket)
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

fn sync_state_response_has_gap(response: &Value) -> bool {
    ["missing", "different"].iter().any(|key| {
        response
            .get(key)
            .and_then(|v| v.as_array())
            .map(|items| !items.is_empty())
            .unwrap_or(false)
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

pub fn enqueue_failed_buckets(buckets: &[FailedUpload]) {
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
        snapshot
            .get("mode")
            .and_then(|value| value.as_str())
            .unwrap_or("device_day_hour_provider"),
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
    mode: &str,
) {
    let granularity = if mode == "device_day_provider" {
        "daily"
    } else {
        "hourly"
    };
    manifest.buckets.insert(
        bucket_key.to_string(),
        json!({
            "day": day,
            "hour": hour,
            "providerId": provider_id,
            "mode": mode,
            "granularity": granularity,
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

    fn prepared_upload(bucket_key: &str, row_count: usize) -> PreparedUpload {
        let payload = hourly_payload("2026-05-16T00:00:00.000Z");
        PreparedUpload {
            bucket_key: bucket_key.to_string(),
            day: "2026-05-16".to_string(),
            hour: 8,
            provider_id: "codex_local".to_string(),
            fingerprint: format!("fp-{}", bucket_key),
            row_count,
            total_tokens: 42,
            snapshot: payload["snapshot"].clone(),
            items: payload["items"].as_array().cloned().unwrap_or_default(),
            body: payload,
        }
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
            full_reconcile: None,
            verified_server_fingerprint: None,
            extra: HashMap::new(),
        };
        update_manifest_from_payload(&mut manifest, &hourly_payload("2026-05-16T00:00:00.000Z"));
        let row = manifest.buckets.get("2026-05-16|8|codex_local").unwrap();
        assert_eq!(row["fingerprint"], "fp1");
        assert_eq!(row["rowCount"], 1);
        assert_eq!(row["totalTokens"], 42);
    }

    #[test]
    fn batch_upload_response_marks_only_confirmed_buckets() {
        let mut manifest = SyncManifest {
            version: 1,
            buckets: HashMap::new(),
            full_reconcile: None,
            verified_server_fingerprint: None,
            extra: HashMap::new(),
        };
        let chunk = vec![
            prepared_upload("2026-05-16|8|codex_local", 1),
            prepared_upload("2026-05-16|9|codex_local", 2),
            prepared_upload("2026-05-16|10|codex_local", 1),
            prepared_upload("2026-05-16|11|codex_local", 1),
        ];
        let mut accepted = 0;
        let mut rejected = 0;
        let mut uploaded = 0;
        let mut failed = Vec::new();

        apply_batch_upload_response(
            &chunk,
            &mut manifest,
            &json!({
                "results": [
                    {"index": 0, "accepted": 1, "rejected": 0},
                    {"index": 1, "accepted": 1, "rejected": 1},
                    {"index": 2, "accepted": 0, "rejected": 0, "noOp": true}
                ]
            }),
            &mut accepted,
            &mut rejected,
            &mut uploaded,
            &mut failed,
        );

        assert_eq!(accepted, 2);
        assert_eq!(uploaded, 2);
        assert_eq!(rejected, 2);
        assert_eq!(failed.len(), 2);
        assert!(manifest.buckets.contains_key("2026-05-16|8|codex_local"));
        assert!(!manifest.buckets.contains_key("2026-05-16|9|codex_local"));
        assert!(manifest.buckets.contains_key("2026-05-16|10|codex_local"));
        assert!(!manifest.buckets.contains_key("2026-05-16|11|codex_local"));
    }

    #[test]
    fn batch_upload_response_without_results_does_not_mark_success() {
        let mut manifest = SyncManifest {
            version: 1,
            buckets: HashMap::new(),
            full_reconcile: None,
            verified_server_fingerprint: None,
            extra: HashMap::new(),
        };
        let chunk = vec![prepared_upload("2026-05-16|8|codex_local", 1)];
        let mut accepted = 0;
        let mut rejected = 0;
        let mut uploaded = 0;
        let mut failed = Vec::new();

        apply_batch_upload_response(
            &chunk,
            &mut manifest,
            &json!({"accepted": 1}),
            &mut accepted,
            &mut rejected,
            &mut uploaded,
            &mut failed,
        );

        assert_eq!(accepted, 0);
        assert_eq!(uploaded, 0);
        assert_eq!(rejected, 1);
        assert_eq!(failed.len(), 1);
        assert!(manifest.buckets.is_empty());
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
            full_reconcile: None,
            verified_server_fingerprint: None,
            extra: HashMap::new(),
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
    fn build_sync_state_buckets_caps_recent_request_size() {
        let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let mut manifest = SyncManifest {
            version: 1,
            buckets: HashMap::new(),
            full_reconcile: None,
            verified_server_fingerprint: None,
            extra: HashMap::new(),
        };
        let mut buckets = Vec::new();
        for index in 0..300 {
            let key = format!("{}|{}|codex_local_{}", day, index % 24, index);
            manifest
                .buckets
                .insert(key.clone(), json!({"fingerprint": format!("fp_{}", index)}));
            buckets.push((
                key,
                json!({
                    "day": day,
                    "hour": index % 24,
                    "providerId": format!("codex_local_{}", index),
                }),
            ));
        }

        let local_buckets = build_sync_state_buckets(&manifest, &buckets);
        assert_eq!(local_buckets.len(), SYNC_STATE_BUCKET_LIMIT);
    }

    #[test]
    fn build_sync_state_buckets_skips_old_recent_window_entries() {
        let old_day = (chrono::Utc::now()
            - chrono::Duration::days(RECENT_SYNC_STATE_WINDOW_DAYS + 1))
        .format("%Y-%m-%d")
        .to_string();
        let key = format!("{}|8|codex_local", old_day);
        let manifest = SyncManifest {
            version: 1,
            buckets: HashMap::from([(key.clone(), json!({"fingerprint": "fp_old"}))]),
            full_reconcile: None,
            verified_server_fingerprint: None,
            extra: HashMap::new(),
        };
        let buckets = vec![(
            key,
            json!({"day": old_day, "hour": 8, "providerId": "codex_local"}),
        )];

        let local_buckets = build_sync_state_buckets(&manifest, &buckets);
        assert!(local_buckets.is_empty());
    }

    #[test]
    fn server_fingerprint_change_detects_rebuilt_same_url_server() {
        let manifest = SyncManifest {
            version: 1,
            buckets: HashMap::new(),
            full_reconcile: None,
            verified_server_fingerprint: Some("srv_old".to_string()),
            extra: HashMap::new(),
        };

        assert!(reconcile_server_fingerprint_changed(
            &manifest,
            Some("srv_new")
        ));
        assert!(!reconcile_server_fingerprint_changed(
            &manifest,
            Some("srv_old")
        ));
        assert!(!reconcile_server_fingerprint_changed(&manifest, None));
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
