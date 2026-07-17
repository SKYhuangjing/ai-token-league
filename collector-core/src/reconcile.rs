use crate::config::{
    load_sync_manifest_for, normalize_api_base_url, save_sync_manifest_for, sync_state_path,
    AppConfig, SyncManifest,
};
use crate::crypto::sign_payload;
use crate::schema::{compute_bucket_fingerprint, compute_daily_bucket_fingerprint};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;

const DEFAULT_COMPARE_BATCH_SIZE: usize = 250;
const DEFAULT_UPLOAD_BATCH_SIZE: usize = 25;
const INVENTORY_PAGE_SIZE: usize = 50;
const INVENTORY_ACTION_BATCH_SIZE: usize = 10;
// Recent data is continuously owned by ordinary sync. Full reconcile must never
// prune it from a snapshot that could have become stale while the job yielded.
const RECENT_SCOPE_PROTECTION_DAYS: i64 = 2;
const AUTO_RETRY_BASE_SECONDS: i64 = 30;
const AUTO_RETRY_MAX_SECONDS: i64 = 30 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FullReconcileStatus {
    Idle,
    Pending,
    Running,
    Failed,
    Unrecoverable,
    Completed,
}

impl Default for FullReconcileStatus {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FullReconcileTrigger {
    ApiBaseUrlChanged,
    FirstServerIdentity,
    MissingHistoryDetected,
    BackupRestore,
    PreviousFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FullReconcileCursor {
    pub last_bucket_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FullReconcileState {
    pub status: FullReconcileStatus,
    pub trigger: Option<FullReconcileTrigger>,
    pub cursor: FullReconcileCursor,
    pub started_at: String,
    pub updated_at: String,
    pub completed_at: String,
    pub checked_bucket_count: usize,
    pub total_bucket_count: usize,
    pub matched_bucket_count: usize,
    pub missing_bucket_count: usize,
    pub different_bucket_count: usize,
    pub repair_uploaded_bucket_count: usize,
    pub queued_bucket_count: usize,
    #[serde(default)]
    pub unknown_legacy_bucket_count: usize,
    #[serde(default)]
    pub inventory_cursor: String,
    #[serde(default)]
    pub inventory_phase: String,
    #[serde(default)]
    pub server_only_scope_count: usize,
    #[serde(default)]
    pub pruned_scope_count: usize,
    #[serde(default)]
    pub rebuilt_daily_scope_count: usize,
    #[serde(default)]
    pub conflicted_scope_count: usize,
    #[serde(default)]
    pub failure_count: u32,
    #[serde(default)]
    pub next_retry_at: String,
    pub last_error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FullReconcileOptions {
    pub batch_size: usize,
    pub upload_batch_size: usize,
    pub resume: bool,
    pub max_batches_per_run: usize,
}

impl Default for FullReconcileOptions {
    fn default() -> Self {
        Self {
            batch_size: DEFAULT_COMPARE_BATCH_SIZE,
            upload_batch_size: DEFAULT_UPLOAD_BATCH_SIZE,
            resume: false,
            max_batches_per_run: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FullReconcileResult {
    pub status: FullReconcileStatus,
    pub checked_bucket_count: usize,
    pub matched_bucket_count: usize,
    pub missing_bucket_count: usize,
    pub different_bucket_count: usize,
    pub repair_uploaded_bucket_count: usize,
    pub queued_bucket_count: usize,
    pub unknown_legacy_bucket_count: usize,
    pub server_only_scope_count: usize,
    pub pruned_scope_count: usize,
    pub rebuilt_daily_scope_count: usize,
    pub conflicted_scope_count: usize,
}

pub fn load_full_reconcile_state(api_base_url: &str) -> FullReconcileState {
    let url = normalize_api_base_url(api_base_url);
    let path = sync_state_path();
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return FullReconcileState::default(),
    };
    let state_file: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return FullReconcileState::default(),
    };
    let manifest = state_file
        .get("states")
        .and_then(|s| s.get(&url))
        .cloned()
        .unwrap_or_default();
    manifest
        .get("fullReconcile")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub fn save_full_reconcile_state(api_base_url: &str, reconcile_state: &FullReconcileState) {
    let url = normalize_api_base_url(api_base_url);
    let path = sync_state_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut state_file: Value = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or(json!({"version": 2, "states": {}}))
    } else {
        json!({"version": 2, "states": {}})
    };

    if state_file.get("states").is_none() {
        state_file["states"] = json!({});
    }
    if state_file["states"].get(&url).is_none() {
        state_file["states"][&url] = json!({"version": 2, "buckets": {}});
    }
    state_file["states"][&url]["fullReconcile"] =
        serde_json::to_value(reconcile_state).unwrap_or_default();

    let tmp = path.with_extension("json.tmp");
    if let Ok(json_str) = serde_json::to_string_pretty(&state_file) {
        if fs::write(&tmp, format!("{}\n", json_str)).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }
}

fn attach_full_reconcile_state(manifest: &mut SyncManifest, state: &FullReconcileState) {
    manifest.full_reconcile = serde_json::to_value(state).ok();
}

pub fn mark_full_reconcile_pending(
    api_base_url: &str,
    trigger: FullReconcileTrigger,
) -> FullReconcileState {
    let mut state = load_full_reconcile_state(api_base_url);
    if state.status == FullReconcileStatus::Running {
        return state;
    }
    if state.status == FullReconcileStatus::Failed
        && !matches!(
            trigger,
            FullReconcileTrigger::PreviousFailed
                | FullReconcileTrigger::ApiBaseUrlChanged
                | FullReconcileTrigger::BackupRestore
        )
    {
        return state;
    }
    if state.status == FullReconcileStatus::Unrecoverable && !can_reset_unrecoverable(&trigger) {
        return state;
    }
    let reset_progress = should_reset_pending_progress(state.status, &trigger);
    state.status = FullReconcileStatus::Pending;
    state.trigger = Some(trigger.clone());
    if reset_progress {
        state.last_error = String::new();
        state.cursor = FullReconcileCursor::default();
        state.started_at = String::new();
        state.updated_at = String::new();
        state.completed_at = String::new();
        state.checked_bucket_count = 0;
        state.total_bucket_count = 0;
        state.matched_bucket_count = 0;
        state.missing_bucket_count = 0;
        state.different_bucket_count = 0;
        state.repair_uploaded_bucket_count = 0;
        state.queued_bucket_count = 0;
        state.unknown_legacy_bucket_count = 0;
        state.inventory_cursor = String::new();
        state.inventory_phase = String::new();
        state.server_only_scope_count = 0;
        state.pruned_scope_count = 0;
        state.rebuilt_daily_scope_count = 0;
        state.conflicted_scope_count = 0;
        state.failure_count = 0;
        state.next_retry_at = String::new();
    } else {
        state.completed_at = String::new();
        state.updated_at = now_iso();
        if matches!(trigger, FullReconcileTrigger::PreviousFailed) {
            state.next_retry_at = String::new();
        }
    }
    save_full_reconcile_state(api_base_url, &state);
    state
}

fn can_reset_unrecoverable(trigger: &FullReconcileTrigger) -> bool {
    matches!(
        trigger,
        FullReconcileTrigger::ApiBaseUrlChanged | FullReconcileTrigger::BackupRestore
    )
}

fn should_reset_pending_progress(
    status: FullReconcileStatus,
    trigger: &FullReconcileTrigger,
) -> bool {
    if matches!(status, FullReconcileStatus::Unrecoverable) {
        return can_reset_unrecoverable(trigger);
    }
    if matches!(
        status,
        FullReconcileStatus::Pending | FullReconcileStatus::Failed
    ) {
        return matches!(
            trigger,
            FullReconcileTrigger::ApiBaseUrlChanged
                | FullReconcileTrigger::FirstServerIdentity
                | FullReconcileTrigger::BackupRestore
        );
    }
    true
}

pub fn full_reconcile_should_auto_run(status: FullReconcileStatus) -> bool {
    matches!(
        status,
        FullReconcileStatus::Pending | FullReconcileStatus::Failed | FullReconcileStatus::Running
    )
}

pub fn full_reconcile_auto_retry_due(state: &FullReconcileState) -> bool {
    if !full_reconcile_should_auto_run(state.status) {
        return false;
    }
    if state.status != FullReconcileStatus::Failed || state.next_retry_at.is_empty() {
        return true;
    }
    chrono::DateTime::parse_from_rfc3339(&state.next_retry_at)
        .map(|next_retry_at| chrono::Utc::now() >= next_retry_at.with_timezone(&chrono::Utc))
        .unwrap_or(true)
}

pub fn record_full_reconcile_failure(state: &mut FullReconcileState, error: String) {
    state.status = FullReconcileStatus::Failed;
    state.last_error = error;
    state.failure_count = state.failure_count.saturating_add(1);
    let exponent = state.failure_count.saturating_sub(1).min(16);
    let delay_seconds = AUTO_RETRY_BASE_SECONDS
        .saturating_mul(2_i64.saturating_pow(exponent))
        .min(AUTO_RETRY_MAX_SECONDS);
    state.next_retry_at = (chrono::Utc::now() + chrono::Duration::seconds(delay_seconds))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    state.updated_at = now_iso();
}

pub async fn full_reconcile_usage(
    config: &AppConfig,
    items: &[Value],
    api_base_url: &str,
    options: FullReconcileOptions,
) -> Result<FullReconcileResult, String> {
    if options.batch_size == 0 {
        return Err("full reconcile batch_size must be greater than 0".to_string());
    }
    if options.upload_batch_size == 0 {
        return Err("full reconcile upload_batch_size must be greater than 0".to_string());
    }
    let mut state = load_full_reconcile_state(api_base_url);
    if state.status == FullReconcileStatus::Unrecoverable {
        return Ok(FullReconcileResult {
            status: state.status,
            ..Default::default()
        });
    }
    if !options.resume && state.status != FullReconcileStatus::Pending {
        if state.status == FullReconcileStatus::Failed {
            state.status = FullReconcileStatus::Pending;
            state.trigger = Some(FullReconcileTrigger::PreviousFailed);
        } else {
            return Ok(FullReconcileResult {
                status: state.status,
                ..Default::default()
            });
        }
    }

    let mut manifest = load_sync_manifest_for(api_base_url);

    // Build sorted bucket manifest from current local facts plus legacy manifest metadata.
    let all_buckets = build_full_reconcile_manifest(items, &manifest);
    let total_bucket_count = all_buckets.len();
    let local_daily_scopes = local_daily_scope_keys(items);
    let local_hourly_scopes = local_hourly_scope_keys(items);
    let protected_recent_days = protected_recent_reconcile_days(&crate::date::local_day());

    // Find cursor position
    let start_index = resolve_start_index(&mut state, &all_buckets);

    state.status = FullReconcileStatus::Running;
    state.total_bucket_count = total_bucket_count;
    if state.started_at.is_empty() {
        state.started_at = now_iso();
    }
    state.updated_at = now_iso();
    save_full_reconcile_state(api_base_url, &state);
    attach_full_reconcile_state(&mut manifest, &state);

    let client = reqwest::Client::new();

    // Register device (required for compare/upload)
    if let Err(error) = crate::sync::register_device(&client, config, api_base_url).await {
        record_full_reconcile_failure(&mut state, error.clone());
        save_full_reconcile_state(api_base_url, &state);
        return Err(error);
    }

    let mut cumulative = FullReconcileResult {
        status: FullReconcileStatus::Running,
        checked_bucket_count: state.checked_bucket_count,
        matched_bucket_count: state.matched_bucket_count,
        missing_bucket_count: state.missing_bucket_count,
        different_bucket_count: state.different_bucket_count,
        repair_uploaded_bucket_count: state.repair_uploaded_bucket_count,
        queued_bucket_count: state.queued_bucket_count,
        unknown_legacy_bucket_count: state.unknown_legacy_bucket_count,
        server_only_scope_count: state.server_only_scope_count,
        pruned_scope_count: state.pruned_scope_count,
        rebuilt_daily_scope_count: state.rebuilt_daily_scope_count,
        conflicted_scope_count: state.conflicted_scope_count,
    };

    let buckets_to_process = &all_buckets[start_index..];
    let mut latest_server_fingerprint: Option<String> = None;
    for (batch_index, chunk) in buckets_to_process.chunks(options.batch_size).enumerate() {
        let compare_result = compare_batch(&client, config, api_base_url, chunk).await;

        match compare_result {
            Ok(response) => {
                if response.server_fingerprint.is_some() {
                    latest_server_fingerprint = response.server_fingerprint.clone();
                }
                if !response.unknown_legacy.is_empty() {
                    let unknown_legacy_count = response.unknown_legacy.len();
                    crate::observability::append_runtime_event(
                        "reconcile",
                        "full_reconcile_unknown_legacy",
                        "warn",
                        json!({
                            "bucketCount": unknown_legacy_count,
                            "buckets": response.unknown_legacy
                        }),
                    );
                    cumulative.unknown_legacy_bucket_count += unknown_legacy_count;
                }

                let missing_keys: Vec<String> = response
                    .missing
                    .iter()
                    .chain(response.different.iter())
                    .map(|b| bucket_key_from_manifest_entry(b))
                    .collect();

                let unrepairable_keys = missing_keys
                    .iter()
                    .filter(|key| !bucket_has_repair_items(&all_buckets, key))
                    .cloned()
                    .collect::<Vec<_>>();
                if !unrepairable_keys.is_empty() {
                    state.status = FullReconcileStatus::Unrecoverable;
                    state.last_error = format!(
                        "missing local usage rows for {} bucket(s): {}",
                        unrepairable_keys.len(),
                        unrepairable_keys.join(", ")
                    );
                    state.updated_at = now_iso();
                    save_full_reconcile_state(api_base_url, &state);
                    cumulative.status = FullReconcileStatus::Unrecoverable;
                    return Ok(cumulative);
                }

                // Remove missing/different from manifest so they become dirty
                for key in &missing_keys {
                    manifest.buckets.remove(key);
                }
                save_sync_manifest_for(api_base_url, &manifest);

                // Repair upload for missing/different buckets
                let mut repair_failed_count = 0usize;
                if !missing_keys.is_empty() {
                    let repair_items: Vec<Value> = missing_keys
                        .iter()
                        .filter_map(|key| {
                            all_buckets
                                .iter()
                                .find(|(k, _)| k == key)
                                .and_then(|(_, bucket)| bucket.get("items").cloned())
                        })
                        .flat_map(|items| items.as_array().cloned().unwrap_or_default())
                        .collect();

                    if !repair_items.is_empty() {
                        let repair_buckets = build_repair_buckets(&repair_items, &missing_keys);
                        let uploaded = upload_repair_buckets(
                            &client,
                            config,
                            api_base_url,
                            &repair_buckets,
                            &mut manifest,
                            options.upload_batch_size,
                        )
                        .await;

                        cumulative.repair_uploaded_bucket_count += uploaded.uploaded;
                        cumulative.queued_bucket_count += upload_repair_count_queued(&uploaded);
                        repair_failed_count += uploaded.failed;
                    }
                }

                if repair_failed_count > 0 {
                    state.repair_uploaded_bucket_count = cumulative.repair_uploaded_bucket_count;
                    state.queued_bucket_count = cumulative.queued_bucket_count;
                    record_full_reconcile_failure(
                        &mut state,
                        format!(
                            "repair upload queued {} bucket(s); full reconcile will retry",
                            repair_failed_count
                        ),
                    );
                    save_full_reconcile_state(api_base_url, &state);
                    cumulative.status = FullReconcileStatus::Failed;
                    return Ok(cumulative);
                }

                cumulative.checked_bucket_count += chunk.len();
                cumulative.matched_bucket_count += response.matched_count;
                cumulative.missing_bucket_count += response.missing.len();
                cumulative.different_bucket_count += response.different.len();

                // Update cursor
                if let Some((last_key, _)) = chunk.last() {
                    state.cursor.last_bucket_key = last_key.clone();
                }
                state.checked_bucket_count = cumulative.checked_bucket_count;
                state.matched_bucket_count = cumulative.matched_bucket_count;
                state.missing_bucket_count = cumulative.missing_bucket_count;
                state.different_bucket_count = cumulative.different_bucket_count;
                state.repair_uploaded_bucket_count = cumulative.repair_uploaded_bucket_count;
                state.queued_bucket_count = cumulative.queued_bucket_count;
                state.unknown_legacy_bucket_count = cumulative.unknown_legacy_bucket_count;
                state.updated_at = now_iso();
                save_full_reconcile_state(api_base_url, &state);

                let reached_batch_limit = options.max_batches_per_run > 0
                    && batch_index + 1 >= options.max_batches_per_run
                    && chunk
                        .last()
                        .map(|(key, _)| {
                            all_buckets
                                .last()
                                .map(|(last, _)| key != last)
                                .unwrap_or(false)
                        })
                        .unwrap_or(false);
                if reached_batch_limit {
                    state.status = FullReconcileStatus::Pending;
                    state.updated_at = now_iso();
                    save_full_reconcile_state(api_base_url, &state);
                    cumulative.status = FullReconcileStatus::Pending;
                    return Ok(cumulative);
                }
            }
            Err(error) => {
                record_full_reconcile_failure(&mut state, error.clone());
                save_full_reconcile_state(api_base_url, &state);
                return Err(error);
            }
        }
    }

    let hourly_inventory_outcome = match reconcile_device_hourly_inventory(
        &client,
        config,
        api_base_url,
        &local_hourly_scopes,
        &protected_recent_days,
        &mut state,
        options.max_batches_per_run > 0,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            record_full_reconcile_failure(&mut state, error.clone());
            save_full_reconcile_state(api_base_url, &state);
            return Err(error);
        }
    };
    if hourly_inventory_outcome.needs_resume {
        cumulative.server_only_scope_count += hourly_inventory_outcome.server_only;
        cumulative.pruned_scope_count += hourly_inventory_outcome.pruned;
        cumulative.conflicted_scope_count += hourly_inventory_outcome.conflicts;
        state.server_only_scope_count = cumulative.server_only_scope_count;
        state.pruned_scope_count = cumulative.pruned_scope_count;
        state.conflicted_scope_count = cumulative.conflicted_scope_count;
        state.status = FullReconcileStatus::Pending;
        state.updated_at = now_iso();
        save_full_reconcile_state(api_base_url, &state);
        cumulative.status = FullReconcileStatus::Pending;
        return Ok(cumulative);
    }
    let inventory_outcome = match reconcile_device_daily_inventory(
        &client,
        config,
        api_base_url,
        &local_daily_scopes,
        &protected_recent_days,
        &mut state,
        options.max_batches_per_run > 0,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            record_full_reconcile_failure(&mut state, error.clone());
            save_full_reconcile_state(api_base_url, &state);
            return Err(error);
        }
    };
    cumulative.server_only_scope_count +=
        hourly_inventory_outcome.server_only + inventory_outcome.server_only;
    cumulative.pruned_scope_count += hourly_inventory_outcome.pruned + inventory_outcome.pruned;
    cumulative.rebuilt_daily_scope_count += inventory_outcome.rebuilt;
    cumulative.conflicted_scope_count +=
        hourly_inventory_outcome.conflicts + inventory_outcome.conflicts;
    state.server_only_scope_count = cumulative.server_only_scope_count;
    state.pruned_scope_count = cumulative.pruned_scope_count;
    state.rebuilt_daily_scope_count = cumulative.rebuilt_daily_scope_count;
    state.conflicted_scope_count = cumulative.conflicted_scope_count;

    if inventory_outcome.needs_resume {
        state.status = FullReconcileStatus::Pending;
        state.updated_at = now_iso();
        save_full_reconcile_state(api_base_url, &state);
        cumulative.status = FullReconcileStatus::Pending;
        return Ok(cumulative);
    }

    // Completed
    if let Some(fingerprint) = latest_server_fingerprint {
        let mut completed_manifest = load_sync_manifest_for(api_base_url);
        completed_manifest.verified_server_fingerprint = Some(fingerprint);
        save_sync_manifest_for(api_base_url, &completed_manifest);
    }
    state.status = FullReconcileStatus::Completed;
    state.completed_at = now_iso();
    state.updated_at = now_iso();
    state.last_error = String::new();
    state.failure_count = 0;
    state.next_retry_at = String::new();
    save_full_reconcile_state(api_base_url, &state);

    cumulative.status = FullReconcileStatus::Completed;
    Ok(cumulative)
}

#[derive(Default)]
struct CompareResponse {
    matched_count: usize,
    missing: Vec<Value>,
    different: Vec<Value>,
    unknown_legacy: Vec<Value>,
    server_fingerprint: Option<String>,
}

async fn compare_batch(
    client: &reqwest::Client,
    config: &AppConfig,
    api_base_url: &str,
    chunk: &[(String, Value)],
) -> Result<CompareResponse, String> {
    let bucket_entries: Vec<Value> = chunk
        .iter()
        .map(|(_, bucket)| {
            let granularity = detect_granularity(bucket);
            json!({
                "day": bucket["day"],
                "hour": bucket.get("hour").and_then(|v| v.as_i64()).unwrap_or(0),
                "providerId": bucket["providerId"],
                "fingerprint": bucket["fingerprint"],
                "rowCount": bucket.get("rowCount").and_then(|v| v.as_i64()).unwrap_or(0),
                "totalTokens": bucket.get("totalTokens").and_then(|v| v.as_i64()).unwrap_or(0),
                "granularity": granularity
            })
        })
        .collect();

    let client_generated_at =
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let payload = json!({
        "participantId": config.participant_id,
        "deviceId": config.device_id,
        "clientGeneratedAt": client_generated_at,
        "mode": "full_reconcile",
        "buckets": bucket_entries,
    });
    let signature = sign_payload(&config.identity_private_key, &payload);
    let body = json!({
        "participantId": config.participant_id,
        "deviceId": config.device_id,
        "clientGeneratedAt": client_generated_at,
        "mode": "full_reconcile",
        "buckets": payload["buckets"],
        "signature": signature,
    });

    let resp = client
        .post(format!(
            "{}/api/usage/sync-state",
            api_base_url.trim_end_matches('/')
        ))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("compare request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("compare failed: {} {}", status, text));
    }

    let response_body: Value = resp
        .json()
        .await
        .map_err(|e| format!("invalid compare response: {}", e))?;

    Ok(parse_compare_response(&response_body))
}

fn parse_compare_response(response_body: &Value) -> CompareResponse {
    let missing = response_body
        .get("missing")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let different = response_body
        .get("different")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let matched_count = response_body
        .get("matched")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let unknown_legacy = response_body
        .get("unknownLegacy")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let server_fingerprint = response_body
        .get("serverFingerprint")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .map(|v| v.to_string());

    CompareResponse {
        matched_count,
        missing,
        different,
        unknown_legacy,
        server_fingerprint,
    }
}

#[derive(Default)]
struct InventoryReconcileOutcome {
    server_only: usize,
    pruned: usize,
    rebuilt: usize,
    conflicts: usize,
    needs_resume: bool,
}

fn protected_recent_reconcile_days(reference_day: &str) -> HashSet<String> {
    (0..RECENT_SCOPE_PROTECTION_DAYS)
        .filter_map(|offset| crate::date::add_days(reference_day, -offset))
        .collect()
}

fn local_daily_scope_keys(items: &[Value]) -> HashSet<String> {
    items
        .iter()
        .filter_map(|item| {
            let day = item.get("day").and_then(|v| v.as_str())?;
            let provider_id = item.get("providerId").and_then(|v| v.as_str())?;
            if day.is_empty() || provider_id.is_empty() {
                None
            } else {
                Some(daily_bucket_key(day, provider_id))
            }
        })
        .collect()
}

fn local_hourly_scope_keys(items: &[Value]) -> HashSet<String> {
    items
        .iter()
        .filter_map(|item| {
            let day = item.get("day").and_then(|v| v.as_str())?;
            let hour = item.get("hour").and_then(|v| v.as_i64())?;
            let provider_id = item.get("providerId").and_then(|v| v.as_str())?;
            if day.is_empty() || provider_id.is_empty() || !(0..=23).contains(&hour) {
                None
            } else {
                Some(format!("{}|{:02}|{}", day, hour, provider_id))
            }
        })
        .collect()
}

async fn reconcile_device_hourly_inventory(
    client: &reqwest::Client,
    config: &AppConfig,
    api_base_url: &str,
    local_hourly_scopes: &HashSet<String>,
    protected_recent_days: &HashSet<String>,
    state: &mut FullReconcileState,
    single_page: bool,
) -> Result<InventoryReconcileOutcome, String> {
    if state.inventory_phase == "daily" {
        return Ok(InventoryReconcileOutcome::default());
    }
    state.inventory_phase = "hourly".to_string();
    let mut total_outcome = InventoryReconcileOutcome::default();
    loop {
        let inventory = request_reconcile_inventory(
            client,
            config,
            api_base_url,
            &state.inventory_cursor,
            "hourly",
        )
        .await?;
        let items = inventory
            .get("items")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        if items.is_empty() {
            state.inventory_cursor.clear();
            state.inventory_phase = "daily".to_string();
            state.updated_at = now_iso();
            save_full_reconcile_state(api_base_url, state);
            total_outcome.needs_resume = single_page;
            break;
        }
        let mut page_outcome = InventoryReconcileOutcome::default();
        let mut actions = Vec::new();
        for item in items {
            let day = item.get("day").and_then(|v| v.as_str()).unwrap_or("");
            let hour = item.get("hour").and_then(|v| v.as_i64()).unwrap_or(-1);
            let provider_id = item
                .get("providerId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let fingerprint = item
                .get("fingerprint")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if day.is_empty()
                || provider_id.is_empty()
                || fingerprint.is_empty()
                || !(0..=23).contains(&hour)
            {
                return Err("invalid hourly reconcile inventory response".to_string());
            }
            let key = format!("{}|{:02}|{}", day, hour, provider_id);
            if !local_hourly_scopes.contains(&key) && !protected_recent_days.contains(day) {
                page_outcome.server_only += 1;
                actions.push(json!({"day": day, "hour": hour, "providerId": provider_id, "action": "prune_hourly", "expectedFingerprint": fingerprint}));
            }
        }
        for action_chunk in actions.chunks(INVENTORY_ACTION_BATCH_SIZE) {
            let response =
                apply_reconcile_scope_actions(client, config, api_base_url, action_chunk).await?;
            let response_items = response
                .get("items")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            if response_items.len() != action_chunk.len() {
                return Err("incomplete hourly reconcile scope response".to_string());
            }
            for item in response_items {
                match item
                    .get("status")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                {
                    "pruned" => page_outcome.pruned += 1,
                    "absent" => {}
                    "conflict" => page_outcome.conflicts += 1,
                    status => {
                        return Err(format!("invalid hourly reconcile scope status: {}", status))
                    }
                }
            }
            if page_outcome.conflicts > 0 {
                return Err(
                    "hourly reconcile scope changed while processing; retry full reconcile"
                        .to_string(),
                );
            }
        }
        let has_more = inventory
            .get("hasMore")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        state.inventory_cursor = if has_more {
            inventory
                .get("nextCursor")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string()
        } else {
            String::new()
        };
        if has_more && state.inventory_cursor.is_empty() {
            return Err("hourly reconcile inventory response missing next cursor".to_string());
        }
        state.server_only_scope_count += page_outcome.server_only;
        state.pruned_scope_count += page_outcome.pruned;
        state.conflicted_scope_count += page_outcome.conflicts;
        total_outcome.server_only += page_outcome.server_only;
        total_outcome.pruned += page_outcome.pruned;
        total_outcome.conflicts += page_outcome.conflicts;
        state.updated_at = now_iso();
        save_full_reconcile_state(api_base_url, state);
        if !has_more {
            state.inventory_phase = "daily".to_string();
            state.updated_at = now_iso();
            save_full_reconcile_state(api_base_url, state);
        }
        if single_page {
            total_outcome.needs_resume = true;
            break;
        }
        if !has_more {
            break;
        }
    }
    Ok(total_outcome)
}

async fn reconcile_device_daily_inventory(
    client: &reqwest::Client,
    config: &AppConfig,
    api_base_url: &str,
    local_daily_scopes: &HashSet<String>,
    protected_recent_days: &HashSet<String>,
    state: &mut FullReconcileState,
    single_page: bool,
) -> Result<InventoryReconcileOutcome, String> {
    state.inventory_phase = "daily".to_string();
    let mut outcome = InventoryReconcileOutcome::default();
    let mut total_outcome = InventoryReconcileOutcome::default();
    loop {
        let inventory = request_reconcile_inventory(
            client,
            config,
            api_base_url,
            &state.inventory_cursor,
            "daily",
        )
        .await?;
        let items = inventory
            .get("items")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        if items.is_empty() {
            state.inventory_cursor.clear();
            state.inventory_phase.clear();
            state.updated_at = now_iso();
            save_full_reconcile_state(api_base_url, state);
            break;
        }

        let mut actions = Vec::new();
        for item in items {
            let day = item.get("day").and_then(|v| v.as_str()).unwrap_or("");
            let provider_id = item
                .get("providerId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let fingerprint = item
                .get("fingerprint")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if day.is_empty() || provider_id.is_empty() || fingerprint.is_empty() {
                return Err("invalid reconcile inventory response".to_string());
            }
            let key = daily_bucket_key(day, provider_id);
            if !local_daily_scopes.contains(&key) && !protected_recent_days.contains(day) {
                // Local facts are reconciled by the hourly/daily bucket pass before this
                // inventory pass. Rebuilding every matching daily scope here would turn an
                // otherwise read-only inventory check into hundreds of needless writes.
                outcome.server_only += 1;
                actions.push(json!({
                    "day": day,
                    "providerId": provider_id,
                    "action": "prune",
                    "expectedFingerprint": fingerprint
                }));
            }
        }

        for action_chunk in actions.chunks(INVENTORY_ACTION_BATCH_SIZE) {
            let response =
                apply_reconcile_scope_actions(client, config, api_base_url, action_chunk).await?;
            let response_items = response
                .get("items")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            if response_items.len() != action_chunk.len() {
                return Err("incomplete reconcile scope response".to_string());
            }
            for item in response_items {
                match item
                    .get("status")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                {
                    "pruned" => outcome.pruned += 1,
                    "rebuilt" => outcome.rebuilt += 1,
                    "absent" => {}
                    "conflict" => outcome.conflicts += 1,
                    status => return Err(format!("invalid reconcile scope status: {}", status)),
                }
            }
            if outcome.conflicts > 0 {
                return Err(
                    "reconcile scope changed while processing; retry full reconcile".to_string(),
                );
            }
        }

        let has_more = inventory
            .get("hasMore")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        state.inventory_cursor = if has_more {
            inventory
                .get("nextCursor")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string()
        } else {
            String::new()
        };
        if has_more && state.inventory_cursor.is_empty() {
            return Err("reconcile inventory response missing next cursor".to_string());
        }
        state.server_only_scope_count += outcome.server_only;
        state.pruned_scope_count += outcome.pruned;
        state.rebuilt_daily_scope_count += outcome.rebuilt;
        state.conflicted_scope_count += outcome.conflicts;
        total_outcome.server_only += outcome.server_only;
        total_outcome.pruned += outcome.pruned;
        total_outcome.rebuilt += outcome.rebuilt;
        total_outcome.conflicts += outcome.conflicts;
        outcome = InventoryReconcileOutcome::default();
        state.updated_at = now_iso();
        save_full_reconcile_state(api_base_url, state);
        if !has_more {
            state.inventory_phase.clear();
            state.updated_at = now_iso();
            save_full_reconcile_state(api_base_url, state);
        }
        if single_page && has_more {
            total_outcome.needs_resume = true;
            break;
        }
        if !has_more {
            break;
        }
    }
    Ok(total_outcome)
}

async fn request_reconcile_inventory(
    client: &reqwest::Client,
    config: &AppConfig,
    api_base_url: &str,
    cursor: &str,
    granularity: &str,
) -> Result<Value, String> {
    let client_generated_at =
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let payload = json!({
        "participantId": config.participant_id,
        "deviceId": config.device_id,
        "clientGeneratedAt": client_generated_at,
        "cursor": cursor,
        "limit": INVENTORY_PAGE_SIZE,
        "granularity": granularity
    });
    let signature = sign_payload(&config.identity_private_key, &payload);
    let body = json!({
        "participantId": config.participant_id,
        "deviceId": config.device_id,
        "clientGeneratedAt": client_generated_at,
        "cursor": cursor,
        "limit": INVENTORY_PAGE_SIZE,
        "granularity": granularity,
        "signature": signature
    });
    let response = client
        .post(format!(
            "{}/api/usage/reconcile-inventory",
            api_base_url.trim_end_matches('/')
        ))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("reconcile inventory request failed: {}", error))?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!(
            "reconcile inventory failed: {} {}",
            status,
            response.text().await.unwrap_or_default()
        ));
    }
    response
        .json()
        .await
        .map_err(|error| format!("invalid reconcile inventory response: {}", error))
}

async fn apply_reconcile_scope_actions(
    client: &reqwest::Client,
    config: &AppConfig,
    api_base_url: &str,
    actions: &[Value],
) -> Result<Value, String> {
    let client_generated_at =
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let payload = json!({
        "participantId": config.participant_id,
        "deviceId": config.device_id,
        "clientGeneratedAt": client_generated_at,
        "actions": actions
    });
    let signature = sign_payload(&config.identity_private_key, &payload);
    let body = json!({
        "participantId": config.participant_id,
        "deviceId": config.device_id,
        "clientGeneratedAt": client_generated_at,
        "actions": actions,
        "signature": signature
    });
    let response = client
        .post(format!(
            "{}/api/usage/reconcile-scopes",
            api_base_url.trim_end_matches('/')
        ))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("reconcile scope request failed: {}", error))?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!(
            "reconcile scope request failed: {} {}",
            status,
            response.text().await.unwrap_or_default()
        ));
    }
    response
        .json()
        .await
        .map_err(|error| format!("invalid reconcile scope response: {}", error))
}

struct UploadRepairResult {
    uploaded: usize,
    failed: usize,
}

async fn upload_repair_buckets(
    client: &reqwest::Client,
    config: &AppConfig,
    api_base_url: &str,
    buckets: &[(String, Value)],
    manifest: &mut SyncManifest,
    upload_batch_size: usize,
) -> UploadRepairResult {
    let client_metadata = crate::version::client_metadata();
    let mut uploaded = 0;
    let mut failed = 0;

    let prepared: Vec<crate::sync::PreparedUpload> = buckets
        .iter()
        .map(|(key, bucket)| {
            let bucket_items = bucket["items"].as_array().cloned().unwrap_or_default();
            let day = bucket["day"].as_str().unwrap_or("");
            let hour = bucket.get("hour").and_then(|v| v.as_i64()).unwrap_or(0);
            let provider_id = bucket["providerId"].as_str().unwrap_or("");
            let fingerprint = bucket["fingerprint"].as_str().unwrap_or("");
            let mode = bucket
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("device_day_hour_provider");
            let row_count = bucket_items.len();
            let total_tokens: i64 = bucket_items
                .iter()
                .map(|i| i["totalTokens"].as_i64().unwrap_or(0))
                .sum();

            let snapshot = if mode == "device_day_provider" {
                json!({
                    "mode": "device_day_provider",
                    "day": day,
                    "providerId": provider_id,
                    "bucketFingerprint": fingerprint,
                    "rowCount": row_count,
                    "totalTokens": total_tokens
                })
            } else {
                json!({
                    "mode": "device_day_hour_provider",
                    "day": day,
                    "hour": hour,
                    "providerId": provider_id,
                    "bucketFingerprint": fingerprint,
                    "rowCount": row_count,
                    "totalTokens": total_tokens
                })
            };

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

            crate::sync::PreparedUpload {
                bucket_key: key.clone(),
                day: day.to_string(),
                hour,
                provider_id: provider_id.to_string(),
                fingerprint: fingerprint.to_string(),
                row_count,
                total_tokens,
                snapshot,
                items: bucket_items,
                body,
            }
        })
        .collect();

    for chunk in prepared.chunks(upload_batch_size) {
        let mut chunk_accepted = 0;
        let mut chunk_rejected = 0;
        let mut chunk_uploaded = 0;
        let mut chunk_failures: Vec<crate::sync::FailedUpload> = Vec::new();

        crate::sync::upload_prepared_chunk(
            client,
            config,
            api_base_url,
            chunk,
            manifest,
            &mut chunk_accepted,
            &mut chunk_rejected,
            &mut chunk_uploaded,
            &mut chunk_failures,
        )
        .await;

        uploaded += chunk_uploaded;
        failed += chunk_failures.len();

        if !chunk_failures.is_empty() {
            crate::sync::enqueue_failed_buckets(&chunk_failures);
        }
    }

    save_sync_manifest_for(api_base_url, manifest);
    UploadRepairResult { uploaded, failed }
}

fn upload_repair_count_queued(result: &UploadRepairResult) -> usize {
    result.failed
}

fn build_full_reconcile_manifest(items: &[Value], manifest: &SyncManifest) -> Vec<(String, Value)> {
    let mut buckets = build_bucket_manifest(items);
    let mut legacy_daily_scopes = std::collections::HashSet::new();

    for (key, entry) in &manifest.buckets {
        if !is_legacy_daily_manifest_entry(key, entry) {
            continue;
        }
        let day = entry
            .get("day")
            .and_then(|v| v.as_str())
            .or_else(|| key.split('|').next())
            .unwrap_or("");
        let provider_id = entry
            .get("providerId")
            .and_then(|v| v.as_str())
            .or_else(|| key.split('|').last())
            .unwrap_or("");
        if day.is_empty() || provider_id.is_empty() {
            continue;
        }
        let daily_items = items
            .iter()
            .filter(|item| {
                item.get("day").and_then(|v| v.as_str()) == Some(day)
                    && item.get("providerId").and_then(|v| v.as_str()) == Some(provider_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        let fallback_fingerprint = entry
            .get("fingerprint")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let fingerprint = if daily_items.is_empty() {
            fallback_fingerprint.to_string()
        } else {
            compute_daily_bucket_fingerprint(&daily_items)
        };
        if fingerprint.is_empty() {
            continue;
        }
        legacy_daily_scopes.insert(daily_bucket_key(day, provider_id));
        let row_count = if daily_items.is_empty() {
            entry.get("rowCount").and_then(|v| v.as_i64()).unwrap_or(0) as usize
        } else {
            daily_items.len()
        };
        let total_tokens = if daily_items.is_empty() {
            entry
                .get("totalTokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
        } else {
            daily_items
                .iter()
                .map(|i| i["totalTokens"].as_i64().unwrap_or(0))
                .sum::<i64>()
        };
        let daily_key = daily_bucket_key(day, provider_id);
        let daily_bucket = json!({
            "day": day,
            "providerId": provider_id,
            "mode": "device_day_provider",
            "granularity": "daily",
            "fingerprint": fingerprint,
            "rowCount": row_count,
            "totalTokens": total_tokens,
            "items": daily_items
        });
        if let Some((_, existing)) = buckets
            .iter_mut()
            .find(|(bucket_key, _)| bucket_key == &daily_key)
        {
            *existing = daily_bucket;
        } else {
            buckets.push((daily_bucket_key(day, provider_id), daily_bucket));
        }
    }

    if !legacy_daily_scopes.is_empty() {
        buckets.retain(|(key, bucket)| {
            if key.split('|').count() != 3 {
                return true;
            }
            let day = bucket.get("day").and_then(|v| v.as_str()).unwrap_or("");
            let provider_id = bucket
                .get("providerId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            !legacy_daily_scopes.contains(&daily_bucket_key(day, provider_id))
        });
    }

    buckets.sort_by(|a, b| a.0.cmp(&b.0));
    buckets
}

fn resolve_start_index(state: &mut FullReconcileState, all_buckets: &[(String, Value)]) -> usize {
    if state.cursor.last_bucket_key.is_empty() {
        return 0;
    }
    if let Some(idx) = all_buckets
        .iter()
        .position(|(key, _)| *key == state.cursor.last_bucket_key)
    {
        return idx + 1;
    }

    state.cursor = FullReconcileCursor::default();
    state.checked_bucket_count = 0;
    state.matched_bucket_count = 0;
    state.missing_bucket_count = 0;
    state.different_bucket_count = 0;
    state.repair_uploaded_bucket_count = 0;
    state.queued_bucket_count = 0;
    state.unknown_legacy_bucket_count = 0;
    state.inventory_cursor = String::new();
    state.inventory_phase = String::new();
    state.server_only_scope_count = 0;
    state.pruned_scope_count = 0;
    state.rebuilt_daily_scope_count = 0;
    state.conflicted_scope_count = 0;
    0
}

fn bucket_has_repair_items(buckets: &[(String, Value)], key: &str) -> bool {
    buckets
        .iter()
        .find(|(bucket_key, _)| bucket_key == key)
        .and_then(|(_, bucket)| bucket.get("items"))
        .and_then(|items| items.as_array())
        .map(|items| !items.is_empty())
        .unwrap_or(false)
}

fn is_legacy_daily_manifest_entry(key: &str, entry: &Value) -> bool {
    let granularity = entry
        .get("granularity")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mode = entry.get("mode").and_then(|v| v.as_str()).unwrap_or("");
    if granularity == "daily" || mode == "device_day_provider" {
        return true;
    }
    if granularity == "hourly" || mode == "device_day_hour_provider" {
        return false;
    }
    key.split('|').count() == 2 || entry.get("hour").is_none()
}

fn build_bucket_manifest(items: &[Value]) -> Vec<(String, Value)> {
    let mut buckets: Vec<(String, Value)> = Vec::new();

    let mut groups: HashMap<String, Vec<&Value>> = HashMap::new();
    for item in items {
        let key = if let Some(hour) = item.get("hour").and_then(|v| v.as_i64()) {
            format!(
                "{}|{}|{}",
                item["day"].as_str().unwrap_or(""),
                hour,
                item["providerId"].as_str().unwrap_or("")
            )
        } else {
            daily_bucket_key(
                item["day"].as_str().unwrap_or(""),
                item["providerId"].as_str().unwrap_or(""),
            )
        };
        groups.entry(key).or_default().push(item);
    }

    for (key, group_items) in groups {
        let first = &group_items[0];
        let owned_items: Vec<Value> = group_items.iter().cloned().cloned().collect();
        let fingerprint = compute_bucket_fingerprint(&owned_items);
        let row_count = owned_items.len();
        let total_tokens: i64 = owned_items
            .iter()
            .map(|i| i["totalTokens"].as_i64().unwrap_or(0))
            .sum();
        let bucket = if let Some(hour) = first.get("hour").and_then(|v| v.as_i64()) {
            json!({
                "day": first["day"],
                "hour": hour,
                "providerId": first["providerId"],
                "mode": "device_day_hour_provider",
                "granularity": "hourly",
                "fingerprint": fingerprint,
                "rowCount": row_count,
                "totalTokens": total_tokens,
                "items": owned_items,
            })
        } else {
            json!({
                "day": first["day"],
                "providerId": first["providerId"],
                "granularity": "unknown_legacy",
                "fingerprint": fingerprint,
                "rowCount": row_count,
                "totalTokens": total_tokens,
                "items": owned_items,
            })
        };
        buckets.push((key, bucket));
    }

    buckets.sort_by(|a, b| a.0.cmp(&b.0));
    buckets
}

fn build_repair_buckets(items: &[Value], repair_keys: &[String]) -> Vec<(String, Value)> {
    let hourly_keys = repair_keys
        .iter()
        .filter(|key| key.split('|').count() == 3)
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let hourly_items = items
        .iter()
        .filter(|item| {
            let key = format!(
                "{}|{}|{}",
                item["day"].as_str().unwrap_or(""),
                item.get("hour")
                    .and_then(|v| v.as_i64())
                    .map(|h| h.to_string())
                    .unwrap_or_default(),
                item["providerId"].as_str().unwrap_or("")
            );
            hourly_keys.contains(&key)
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut hourly = crate::scanner::group_by_bucket(&hourly_items);
    let needs_daily = repair_keys
        .iter()
        .filter_map(|key| parse_daily_bucket_key(key))
        .collect::<Vec<_>>();
    if needs_daily.is_empty() {
        return hourly;
    }

    for (day, provider_id) in needs_daily {
        let daily_items = items
            .iter()
            .filter(|item| {
                item.get("day").and_then(|v| v.as_str()) == Some(day.as_str())
                    && item.get("providerId").and_then(|v| v.as_str()) == Some(provider_id.as_str())
            })
            .cloned()
            .collect::<Vec<_>>();
        if daily_items.is_empty() {
            continue;
        }
        let fingerprint = compute_daily_bucket_fingerprint(&daily_items);
        let total_tokens = daily_items
            .iter()
            .map(|i| i["totalTokens"].as_i64().unwrap_or(0))
            .sum::<i64>();
        hourly.push((
            daily_bucket_key(&day, &provider_id),
            json!({
                "day": day,
                "providerId": provider_id,
                "mode": "device_day_provider",
                "granularity": "daily",
                "fingerprint": fingerprint,
                "rowCount": daily_items.len(),
                "totalTokens": total_tokens,
                "items": daily_items
            }),
        ));
    }
    hourly
}

fn detect_granularity(bucket: &Value) -> &'static str {
    let mode = bucket.get("mode").and_then(|v| v.as_str()).unwrap_or("");
    let has_hour = bucket.get("hour").and_then(|v| v.as_i64()).is_some();

    match mode {
        "device_day_hour_provider" => "hourly",
        "device_day_provider" => "daily",
        _ => {
            if has_hour {
                "hourly"
            } else {
                "unknown_legacy"
            }
        }
    }
}

fn bucket_key_from_manifest_entry(bucket: &Value) -> String {
    let day = bucket["day"].as_str().unwrap_or("");
    let granularity = bucket
        .get("granularity")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if granularity == "daily" {
        return daily_bucket_key(day, bucket["providerId"].as_str().unwrap_or(""));
    }
    let hour = bucket.get("hour").and_then(|v| v.as_i64()).unwrap_or(0);
    let provider_id = bucket["providerId"].as_str().unwrap_or("");
    format!("{}|{}|{}", day, hour, provider_id)
}

fn daily_bucket_key(day: &str, provider_id: &str) -> String {
    format!("{}|{}", day, provider_id)
}

fn parse_daily_bucket_key(key: &str) -> Option<(String, String)> {
    let parts = key.split('|').collect::<Vec<_>>();
    if parts.len() == 2 {
        Some((parts[0].to_string(), parts[1].to_string()))
    } else {
        None
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_granularity_returns_hourly_for_current_protocol() {
        let bucket = json!({
            "mode": "device_day_hour_provider",
            "day": "2026-05-25",
            "hour": 10,
            "providerId": "codex_local"
        });
        assert_eq!(detect_granularity(&bucket), "hourly");
    }

    #[test]
    fn detect_granularity_returns_daily_for_legacy_protocol() {
        let bucket = json!({
            "mode": "device_day_provider",
            "day": "2026-05-25",
            "providerId": "codex_local"
        });
        assert_eq!(detect_granularity(&bucket), "daily");
    }

    #[test]
    fn detect_granularity_returns_unknown_for_ambiguous() {
        let bucket = json!({
            "day": "2026-05-25",
            "providerId": "codex_local"
        });
        assert_eq!(detect_granularity(&bucket), "unknown_legacy");
    }

    #[test]
    fn detect_granularity_infers_hourly_from_hour_field() {
        let bucket = json!({
            "day": "2026-05-25",
            "hour": 14,
            "providerId": "codex_local"
        });
        assert_eq!(detect_granularity(&bucket), "hourly");
    }

    #[test]
    fn bucket_key_from_manifest_entry_formats_correctly() {
        let bucket = json!({
            "day": "2026-05-25",
            "hour": 10,
            "providerId": "codex_local"
        });
        assert_eq!(
            bucket_key_from_manifest_entry(&bucket),
            "2026-05-25|10|codex_local"
        );
    }

    #[test]
    fn build_bucket_manifest_groups_and_sorts() {
        let items = vec![
            json!({"day": "2026-05-25", "hour": 10, "providerId": "codex_local",
                   "totalTokens": 100, "sourceFingerprint": "s1", "toolCode": "codex",
                   "workdirHash": "h1", "model": "gpt-5", "inputTokens": 50, "outputTokens": 50,
                   "cacheReadTokens": 0, "cacheWriteTokens": 0}),
            json!({"day": "2026-05-25", "hour": 10, "providerId": "codex_local",
                   "totalTokens": 200, "sourceFingerprint": "s2", "toolCode": "codex",
                   "workdirHash": "h2", "model": "gpt-5", "inputTokens": 100, "outputTokens": 100,
                   "cacheReadTokens": 0, "cacheWriteTokens": 0}),
            json!({"day": "2026-05-25", "hour": 2, "providerId": "codex_local",
                   "totalTokens": 50, "sourceFingerprint": "s3", "toolCode": "codex",
                   "workdirHash": "h1", "model": "gpt-5", "inputTokens": 25, "outputTokens": 25,
                   "cacheReadTokens": 0, "cacheWriteTokens": 0}),
        ];
        let manifest = build_bucket_manifest(&items);
        assert_eq!(manifest.len(), 2);
        // Sorted lexicographically: "10" < "2" because '1' < '2'
        assert_eq!(manifest[0].0, "2026-05-25|10|codex_local");
        assert_eq!(manifest[1].0, "2026-05-25|2|codex_local");
        assert_eq!(manifest[0].1["totalTokens"], 300);
        assert_eq!(manifest[1].1["totalTokens"], 50);
    }

    #[test]
    fn full_reconcile_state_roundtrip() {
        let mut state = FullReconcileState::default();
        state.status = FullReconcileStatus::Running;
        state.trigger = Some(FullReconcileTrigger::ApiBaseUrlChanged);
        state.cursor.last_bucket_key = "2026-05-25|10|codex_local".to_string();
        state.checked_bucket_count = 100;
        state.total_bucket_count = 500;

        let json = serde_json::to_value(&state).unwrap();
        let restored: FullReconcileState = serde_json::from_value(json).unwrap();
        assert_eq!(restored.status, FullReconcileStatus::Running);
        assert_eq!(
            restored.trigger,
            Some(FullReconcileTrigger::ApiBaseUrlChanged)
        );
        assert_eq!(restored.cursor.last_bucket_key, "2026-05-25|10|codex_local");
        assert_eq!(restored.checked_bucket_count, 100);
    }

    #[test]
    fn full_reconcile_result_serializes_to_camel_case() {
        let result = FullReconcileResult {
            status: FullReconcileStatus::Completed,
            checked_bucket_count: 100,
            matched_bucket_count: 80,
            missing_bucket_count: 15,
            different_bucket_count: 5,
            repair_uploaded_bucket_count: 18,
            queued_bucket_count: 2,
            unknown_legacy_bucket_count: 0,
            server_only_scope_count: 3,
            pruned_scope_count: 2,
            rebuilt_daily_scope_count: 4,
            conflicted_scope_count: 0,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["checkedBucketCount"], 100);
        assert_eq!(json["matchedBucketCount"], 80);
        assert_eq!(json["repairUploadedBucketCount"], 18);
        assert_eq!(json["unknownLegacyBucketCount"], 0);
        assert_eq!(json["prunedScopeCount"], 2);
        assert_eq!(json["status"], "completed");
    }

    #[test]
    fn unrecoverable_status_serializes_to_snake_case() {
        let result = FullReconcileResult {
            status: FullReconcileStatus::Unrecoverable,
            ..Default::default()
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["status"], "unrecoverable");
    }

    #[test]
    fn detect_granularity_treats_hour_zero_as_hourly() {
        let bucket = json!({
            "day": "2026-05-25",
            "hour": 0,
            "providerId": "codex_local"
        });
        assert_eq!(detect_granularity(&bucket), "hourly");
    }

    #[test]
    fn detect_granularity_with_explicit_mode_and_hour_zero() {
        let bucket = json!({
            "mode": "device_day_hour_provider",
            "day": "2026-05-25",
            "hour": 0,
            "providerId": "codex_local"
        });
        assert_eq!(detect_granularity(&bucket), "hourly");
    }

    #[test]
    fn build_bucket_manifest_includes_mode() {
        let items = vec![
            json!({"day": "2026-05-25", "hour": 0, "providerId": "codex_local",
                   "totalTokens": 50, "sourceFingerprint": "s1", "toolCode": "codex",
                   "workdirHash": "h1", "model": "gpt-5", "inputTokens": 25, "outputTokens": 25,
                   "cacheReadTokens": 0, "cacheWriteTokens": 0}),
        ];
        let manifest = build_bucket_manifest(&items);
        assert_eq!(manifest.len(), 1);
        assert_eq!(manifest[0].1["mode"], "device_day_hour_provider");
    }

    #[test]
    fn build_bucket_manifest_keeps_missing_hour_as_unknown_legacy() {
        let items = vec![json!({"day": "2026-05-25", "providerId": "codex_local",
                   "totalTokens": 50, "sourceFingerprint": "s1", "toolCode": "codex",
                   "workdirHash": "h1", "model": "gpt-5", "inputTokens": 25, "outputTokens": 25,
                   "cacheReadTokens": 0, "cacheWriteTokens": 0})];
        let manifest = build_bucket_manifest(&items);
        assert_eq!(manifest.len(), 1);
        assert_eq!(manifest[0].0, "2026-05-25|codex_local");
        assert_eq!(manifest[0].1["granularity"], "unknown_legacy");
        assert!(manifest[0].1.get("hour").is_none());
        assert_eq!(detect_granularity(&manifest[0].1), "unknown_legacy");
    }

    #[test]
    fn full_manifest_includes_legacy_daily_sync_bucket() {
        let sync_manifest = SyncManifest {
            version: 2,
            buckets: HashMap::from([(
                "2026-05-20|codex_local".to_string(),
                json!({
                    "day": "2026-05-20",
                    "providerId": "codex_local",
                    "mode": "device_day_provider",
                    "granularity": "daily",
                    "fingerprint": "daily-fp",
                    "rowCount": 3,
                    "totalTokens": 300
                }),
            )]),
            full_reconcile: None,
            verified_server_fingerprint: None,
            extra: HashMap::new(),
        };
        let manifest = build_full_reconcile_manifest(&[], &sync_manifest);
        assert_eq!(manifest.len(), 1);
        assert_eq!(manifest[0].0, "2026-05-20|codex_local");
        assert_eq!(manifest[0].1["granularity"], "daily");
        assert_eq!(manifest[0].1["fingerprint"], "daily-fp");
    }

    #[test]
    fn full_manifest_uses_daily_manifest_to_classify_no_hour_items() {
        let items = vec![json!({"day": "2026-05-20", "providerId": "codex_local",
                   "totalTokens": 50, "sourceFingerprint": "s1", "toolCode": "codex",
                   "workdirHash": "h1", "model": "gpt-5", "inputTokens": 25, "outputTokens": 25,
                   "cacheReadTokens": 0, "cacheWriteTokens": 0})];
        let expected_fingerprint = compute_daily_bucket_fingerprint(&items);
        let sync_manifest = SyncManifest {
            version: 2,
            buckets: HashMap::from([(
                "2026-05-20|codex_local".to_string(),
                json!({
                    "day": "2026-05-20",
                    "providerId": "codex_local",
                    "mode": "device_day_provider",
                    "granularity": "daily",
                    "fingerprint": "stale-manifest-fp",
                    "rowCount": 999,
                    "totalTokens": 999
                }),
            )]),
            full_reconcile: None,
            verified_server_fingerprint: None,
            extra: HashMap::new(),
        };

        let manifest = build_full_reconcile_manifest(&items, &sync_manifest);

        assert_eq!(manifest.len(), 1);
        assert_eq!(manifest[0].0, "2026-05-20|codex_local");
        assert_eq!(manifest[0].1["granularity"], "daily");
        assert_eq!(manifest[0].1["mode"], "device_day_provider");
        assert_eq!(manifest[0].1["fingerprint"], expected_fingerprint);
        assert_eq!(manifest[0].1["rowCount"], 1);
        assert_eq!(manifest[0].1["totalTokens"], 50);
        assert_eq!(manifest[0].1["items"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn full_manifest_excludes_hourly_buckets_covered_by_legacy_daily_manifest() {
        let items = vec![
            json!({"day": "2026-05-20", "hour": 10, "providerId": "codex_local",
                   "totalTokens": 60, "sourceFingerprint": "s1", "toolCode": "codex",
                   "workdirHash": "h1", "model": "gpt-5", "inputTokens": 30, "outputTokens": 30,
                   "cacheReadTokens": 0, "cacheWriteTokens": 0}),
            json!({"day": "2026-05-20", "hour": 11, "providerId": "codex_local",
                   "totalTokens": 40, "sourceFingerprint": "s2", "toolCode": "codex",
                   "workdirHash": "h1", "model": "gpt-5", "inputTokens": 20, "outputTokens": 20,
                   "cacheReadTokens": 0, "cacheWriteTokens": 0}),
        ];
        let sync_manifest = SyncManifest {
            version: 2,
            buckets: HashMap::from([(
                "2026-05-20|codex_local".to_string(),
                json!({
                    "day": "2026-05-20",
                    "providerId": "codex_local",
                    "mode": "device_day_provider",
                    "granularity": "daily",
                    "fingerprint": "legacy-daily-fp",
                    "rowCount": 2,
                    "totalTokens": 100
                }),
            )]),
            full_reconcile: None,
            verified_server_fingerprint: None,
            extra: HashMap::new(),
        };

        let manifest = build_full_reconcile_manifest(&items, &sync_manifest);

        assert_eq!(manifest.len(), 1);
        assert_eq!(manifest[0].0, "2026-05-20|codex_local");
        assert_eq!(manifest[0].1["granularity"], "daily");
        assert_eq!(manifest[0].1["totalTokens"], 100);
        assert_eq!(manifest[0].1["items"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn full_manifest_daily_fingerprint_ignores_hour() {
        let with_hour = vec![
            json!({"day": "2026-05-20", "hour": 10, "providerId": "codex_local",
                   "totalTokens": 60, "sourceFingerprint": "s1", "toolCode": "codex",
                   "workdirHash": "h1", "model": "gpt-5", "inputTokens": 30, "outputTokens": 30,
                   "cacheReadTokens": 0, "cacheWriteTokens": 0}),
        ];
        let without_hour = vec![json!({"day": "2026-05-20", "providerId": "codex_local",
                   "totalTokens": 60, "sourceFingerprint": "s1", "toolCode": "codex",
                   "workdirHash": "h1", "model": "gpt-5", "inputTokens": 30, "outputTokens": 30,
                   "cacheReadTokens": 0, "cacheWriteTokens": 0})];

        assert_ne!(
            compute_bucket_fingerprint(&with_hour),
            compute_bucket_fingerprint(&without_hour)
        );
        assert_eq!(
            compute_daily_bucket_fingerprint(&with_hour),
            compute_daily_bucket_fingerprint(&without_hour)
        );
    }

    #[test]
    fn recent_reconcile_protection_covers_today_and_previous_day() {
        let protected = protected_recent_reconcile_days("2026-07-17");
        assert!(protected.contains("2026-07-17"));
        assert!(protected.contains("2026-07-16"));
        assert!(!protected.contains("2026-07-15"));
    }

    #[test]
    fn failed_reconcile_waits_for_persisted_retry_deadline() {
        let mut state = FullReconcileState::default();
        record_full_reconcile_failure(&mut state, "temporary server error".to_string());

        assert_eq!(state.status, FullReconcileStatus::Failed);
        assert_eq!(state.failure_count, 1);
        assert!(!state.next_retry_at.is_empty());
        assert!(!full_reconcile_auto_retry_due(&state));

        state.next_retry_at = "invalid".to_string();
        assert!(full_reconcile_auto_retry_due(&state));
    }

    #[test]
    fn compare_response_parses_unknown_legacy_buckets() {
        let parsed = parse_compare_response(&json!({
            "matched": [],
            "missing": [],
            "different": [],
            "serverFingerprint": "srv_test",
            "unknownLegacy": [{
                "day": "2026-05-20",
                "providerId": "codex_local",
                "fingerprint": "ambiguous"
            }]
        }));

        assert_eq!(parsed.unknown_legacy.len(), 1);
        assert_eq!(parsed.unknown_legacy[0]["providerId"], "codex_local");
        assert_eq!(parsed.server_fingerprint.as_deref(), Some("srv_test"));
    }

    #[test]
    fn daily_manifest_response_uses_daily_key() {
        let bucket = json!({
            "day": "2026-05-20",
            "providerId": "codex_local",
            "granularity": "daily"
        });
        assert_eq!(
            bucket_key_from_manifest_entry(&bucket),
            "2026-05-20|codex_local"
        );
    }

    #[test]
    fn mark_pending_resets_cursor_and_counters() {
        let mut state = FullReconcileState::default();
        state.status = FullReconcileStatus::Completed;
        state.cursor.last_bucket_key = "2026-05-24|10|codex_local".to_string();
        state.checked_bucket_count = 500;
        state.total_bucket_count = 600;

        // Simulate what mark_full_reconcile_pending does
        state.status = FullReconcileStatus::Pending;
        state.trigger = Some(FullReconcileTrigger::ApiBaseUrlChanged);
        state.cursor = FullReconcileCursor::default();
        state.checked_bucket_count = 0;
        state.total_bucket_count = 0;

        assert_eq!(state.status, FullReconcileStatus::Pending);
        assert!(state.cursor.last_bucket_key.is_empty());
        assert_eq!(state.checked_bucket_count, 0);
    }

    #[test]
    fn pending_missing_history_preserves_failed_cursor() {
        assert!(!should_reset_pending_progress(
            FullReconcileStatus::Failed,
            &FullReconcileTrigger::MissingHistoryDetected
        ));
        assert!(!should_reset_pending_progress(
            FullReconcileStatus::Pending,
            &FullReconcileTrigger::PreviousFailed
        ));
    }

    #[test]
    fn api_change_pending_resets_failed_cursor() {
        assert!(should_reset_pending_progress(
            FullReconcileStatus::Failed,
            &FullReconcileTrigger::ApiBaseUrlChanged
        ));
    }

    #[test]
    fn unrecoverable_status_does_not_auto_retry_or_reset_for_missing_history() {
        assert!(!full_reconcile_should_auto_run(
            FullReconcileStatus::Unrecoverable
        ));
        assert!(!should_reset_pending_progress(
            FullReconcileStatus::Unrecoverable,
            &FullReconcileTrigger::MissingHistoryDetected
        ));
        assert!(!should_reset_pending_progress(
            FullReconcileStatus::Unrecoverable,
            &FullReconcileTrigger::PreviousFailed
        ));
    }

    #[test]
    fn api_change_or_backup_restore_can_reset_unrecoverable_status() {
        assert!(should_reset_pending_progress(
            FullReconcileStatus::Unrecoverable,
            &FullReconcileTrigger::ApiBaseUrlChanged
        ));
        assert!(should_reset_pending_progress(
            FullReconcileStatus::Unrecoverable,
            &FullReconcileTrigger::BackupRestore
        ));
    }

    #[test]
    fn stale_cursor_restarts_from_zero_and_resets_counters() {
        let mut state = FullReconcileState::default();
        state.cursor.last_bucket_key = "2026-05-19|10|codex_local".to_string();
        state.checked_bucket_count = 250;
        state.matched_bucket_count = 240;
        state.missing_bucket_count = 9;
        state.different_bucket_count = 1;
        state.repair_uploaded_bucket_count = 10;
        state.queued_bucket_count = 2;
        state.unknown_legacy_bucket_count = 3;
        let buckets = vec![(
            "2026-05-20|10|codex_local".to_string(),
            json!({"day": "2026-05-20", "hour": 10, "providerId": "codex_local"}),
        )];

        let start = resolve_start_index(&mut state, &buckets);

        assert_eq!(start, 0);
        assert!(state.cursor.last_bucket_key.is_empty());
        assert_eq!(state.checked_bucket_count, 0);
        assert_eq!(state.matched_bucket_count, 0);
        assert_eq!(state.missing_bucket_count, 0);
        assert_eq!(state.different_bucket_count, 0);
        assert_eq!(state.repair_uploaded_bucket_count, 0);
        assert_eq!(state.queued_bucket_count, 0);
        assert_eq!(state.unknown_legacy_bucket_count, 0);
    }

    #[test]
    fn bucket_without_items_is_not_repairable() {
        let buckets = vec![(
            "2026-05-20|codex_local".to_string(),
            json!({
                "day": "2026-05-20",
                "providerId": "codex_local",
                "granularity": "daily",
                "items": []
            }),
        )];
        assert!(!bucket_has_repair_items(&buckets, "2026-05-20|codex_local"));
    }

    #[test]
    fn bucket_with_items_is_repairable() {
        let buckets = vec![(
            "2026-05-20|codex_local".to_string(),
            json!({
                "day": "2026-05-20",
                "providerId": "codex_local",
                "granularity": "daily",
                "items": [{"totalTokens": 10}]
            }),
        )];
        assert!(bucket_has_repair_items(&buckets, "2026-05-20|codex_local"));
    }
}
