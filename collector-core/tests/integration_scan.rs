//! Integration tests for the full scan → store → query pipeline.
//!
//! Simulates real user workflows:
//!   1. Initialize config → scan local usage → persist to SQLite → query
//!   2. Incremental scan with source cache
//!   3. Provider enable/disable
//!   4. Config import/export identity roundtrip
//!   5. Backup → clear → restore
//!   6. Multi-day range queries
//!   7. Sidecar protocol roundtrip
//!   8. Crypto cross-validation
//!   9. Workdir hash stability
//!  10. Runtime log lifecycle

use collector_core::config;
use collector_core::local_usage_store::LocalUsageStore;
use collector_core::scanner;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

struct TestEnv {
    home: PathBuf,
}

impl TestEnv {
    fn new() -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let home = std::env::temp_dir().join(format!("atl-integ-{}", suffix));
        fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        config::ensure_app_dir();
        Self { home }
    }

    fn init_config(&self) -> config::AppConfig {
        let samples = std::env::current_dir().unwrap().join("../samples");
        let cfg = config::init_config(
            serde_json::json!({
                "nickname": "integration-tester",
                "apiBaseUrl": ""
            }),
            true,
        );
        let codex_path = samples.join("codex").to_string_lossy().to_string();
        let claude_path = samples
            .join("claude/projects")
            .to_string_lossy()
            .to_string();
        let cfg = config::add_provider_root("codex_local", &codex_path, &cfg);
        config::add_provider_root("claude_code_local", &claude_path, &cfg)
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.home);
    }
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    use std::sync::Mutex;
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

// ── Scenario 1: Fresh install → init → first scan → verify data ──

#[test]
fn scenario_fresh_install_first_scan() {
    let _guard = lock();
    let _prev = SaveHome::new();
    let env = TestEnv::new();
    let cfg = env.init_config();

    assert!(!cfg.participant_id.is_empty());
    assert_eq!(cfg.nickname, "integration-tester");

    let result = run_async(scanner::scan_usage_async(&cfg, HashMap::new()));
    assert!(
        result.items.len() >= 2,
        "should find codex + claude items, got {}",
        result.items.len()
    );

    let codex: Vec<_> = result
        .items
        .iter()
        .filter(|i| i["toolCode"] == "codex")
        .collect();
    let claude: Vec<_> = result
        .items
        .iter()
        .filter(|i| i["toolCode"] == "claude_code")
        .collect();
    assert!(!codex.is_empty());
    assert!(!claude.is_empty());

    let codex_total: i64 = codex
        .iter()
        .map(|i| i["totalTokens"].as_i64().unwrap_or(0))
        .sum();
    assert!(
        codex_total > 0,
        "codex should have positive tokens, got {}",
        codex_total
    );

    let health = scanner::provider_health(&cfg);
    assert!(health.len() >= 2);
}

// ── Scenario 2: Scan → persist → query roundtrip ──

#[test]
fn scenario_scan_store_query_roundtrip() {
    let _guard = lock();
    let _prev = SaveHome::new();
    let env = TestEnv::new();
    let cfg = env.init_config();

    let result = run_async(scanner::scan_usage_async(&cfg, HashMap::new()));
    assert!(!result.items.is_empty());

    let db_path = config::local_usage_db_path();
    let mut store = LocalUsageStore::open(db_path).unwrap();
    store
        .replace_usage_facts(&result.items, "integration-test")
        .unwrap();

    let summary = store.summary("all").unwrap();
    assert!(summary["totals"]["totalTokens"].as_i64().unwrap_or(0) > 0);

    let trend = store.trend("all", "day").unwrap();
    assert!(!trend["items"].as_array().unwrap().is_empty());

    let workdirs = store.workdirs("all", 10).unwrap();
    assert!(!workdirs["items"].as_array().unwrap().is_empty());

    let detail = store.detail_window("all", 0, 50).unwrap();
    assert!(detail["totalRows"].as_i64().unwrap_or(0) >= 2);

    let all = store.all_usage_items().unwrap();
    assert_eq!(all.len(), result.items.len());
}

// ── Scenario 3: Incremental scan uses source cache ──

#[test]
fn scenario_incremental_scan_with_cache() {
    let _guard = lock();
    let _prev = SaveHome::new();
    let env = TestEnv::new();
    let cfg = env.init_config();

    let result = run_async(scanner::scan_usage_async(&cfg, HashMap::new()));
    let source_index = result.source_index.clone();

    let mut cache = source_index;
    let result2 = run_async(scanner::scan_usage_async_with_source_cache(
        &cfg, &mut cache,
    ));
    assert_eq!(result2.items.len(), result.items.len());

    // Source cache should preserve all fingerprints from the first scan
    assert!(
        !result.source_index.is_empty(),
        "first scan should produce source fingerprints"
    );
}

// ── Scenario 4: Provider disabled skips scan ──

#[test]
fn scenario_provider_disabled() {
    let _guard = lock();
    let _prev = SaveHome::new();
    let env = TestEnv::new();
    let mut cfg = env.init_config();
    cfg.provider_enabled.insert("codex_local".into(), false);

    let result = run_async(scanner::scan_usage_async(&cfg, HashMap::new()));
    assert!(result
        .items
        .iter()
        .all(|i| i["providerId"] != "codex_local"));
    assert!(result
        .items
        .iter()
        .any(|i| i["providerId"] == "claude_code_local"));
}

// ── Scenario 5: Config export is safe ──

#[test]
fn scenario_config_export_safe() {
    let _guard = lock();
    let _prev = SaveHome::new();
    let env = TestEnv::new();
    let cfg = env.init_config();

    let exported = config::export_config(&cfg);
    // export_config strips runtime state fields
    assert!(exported.get("syncStatus").is_none());
    assert!(exported.get("lastSyncAt").is_none());
    assert!(exported.get("exportedAt").is_some());
}

// ── Scenario 6: Identity export → config reload ──

#[test]
fn scenario_identity_persistence() {
    let _guard = lock();
    let _prev = SaveHome::new();
    let env = TestEnv::new();
    let cfg = env.init_config();

    let identity = config::export_identity(&cfg);
    assert_eq!(identity["participantId"], cfg.participant_id);

    let cfg2 = config::load_config().unwrap();
    assert_eq!(cfg2.participant_id, cfg.participant_id);
    assert_eq!(cfg2.device_id, cfg.device_id);
}

// ── Scenario 7: Backup → reset → restore ──

#[test]
fn scenario_backup_restore() {
    let _guard = lock();
    let _prev = SaveHome::new();
    let env = TestEnv::new();
    let cfg = env.init_config();
    let original_pid = cfg.participant_id.clone();

    // Create backup
    let backup = collector_core::local_backup::export_local_backup();
    assert!(backup.is_ok(), "backup should succeed: {:?}", backup);
    let backup = backup.unwrap();
    assert!(
        backup["entries"].is_array(),
        "backup should have entries, got: {:?}",
        backup
    );
    assert!(
        backup["backupVersion"].is_number(),
        "backup should have version"
    );

    // Reset
    config::reset_local_data();

    // Restore
    let result = collector_core::local_backup::restore_local_backup(backup);
    assert!(result.is_ok(), "restore should succeed: {:?}", result);

    let cfg2 = config::load_config().unwrap();
    assert_eq!(cfg2.participant_id, original_pid);
}

// ── Scenario 8: Multi-day range queries ──

#[test]
fn scenario_multi_day_range_queries() {
    let db_path = std::env::temp_dir().join(format!(
        "atl-range-{}.sqlite3",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut store = LocalUsageStore::open(db_path.clone()).unwrap();

    let items = vec![
        make_item("2026-05-10", 9, "codex", "codex_local", "gpt-5", 100),
        make_item("2026-05-10", 10, "codex", "codex_local", "gpt-5", 200),
        make_item("2026-05-11", 9, "codex", "codex_local", "gpt-5", 300),
        make_item("2026-05-12", 9, "codex", "codex_local", "gpt-5", 400),
    ];
    store.replace_usage_facts(&items, "test").unwrap();

    // Single day
    assert_eq!(
        store.summary("2026-05-10..2026-05-10").unwrap()["totals"]["totalTokens"],
        300
    );

    // All 3 days
    assert_eq!(
        store.summary("2026-05-10..2026-05-12").unwrap()["totals"]["totalTokens"],
        1000
    );

    // Trend by day
    let trend = store.trend("2026-05-10..2026-05-12", "day").unwrap();
    let day_items = trend["items"].as_array().unwrap();
    assert_eq!(day_items.len(), 3);
    assert_eq!(day_items[0]["totalTokens"], 300); // 2026-05-10: 100+200
    assert_eq!(day_items[1]["totalTokens"], 300); // 2026-05-11
    assert_eq!(day_items[2]["totalTokens"], 400); // 2026-05-12

    // Trend by hour (2026-05-10 has hours 9 and 10)
    let hourly = store.trend("2026-05-10..2026-05-10", "hour").unwrap();
    let hour_items = hourly["items"].as_array().unwrap();
    assert_eq!(hour_items.len(), 2);
    assert_eq!(hour_items[0]["totalTokens"], 100); // hour 9
    assert_eq!(hour_items[0]["hour"], 9);
    assert_eq!(hour_items[1]["totalTokens"], 200); // hour 10
    assert_eq!(hour_items[1]["hour"], 10);

    // Trend by week: 2026-05-10 (Sunday → week of May 4), 05-11/05-12 (Mon/Tue → week of May 11)
    let weekly = store.trend("2026-05-10..2026-05-12", "week").unwrap();
    let week_items = weekly["items"].as_array().unwrap();
    assert_eq!(week_items.len(), 2);
    // Week 1: 2026-05-04..2026-05-10 — contains 05-10 (300 tokens)
    assert_eq!(week_items[0]["periodStart"], "2026-05-04");
    assert_eq!(week_items[0]["periodEnd"], "2026-05-10");
    assert_eq!(week_items[0]["totalTokens"], 300);
    // Week 2: 2026-05-11..2026-05-17 — contains 05-11 (300) + 05-12 (400) = 700
    assert_eq!(week_items[1]["periodStart"], "2026-05-11");
    assert_eq!(week_items[1]["periodEnd"], "2026-05-17");
    assert_eq!(week_items[1]["totalTokens"], 700);

    // "all" range
    assert_eq!(store.summary("all").unwrap()["totals"]["totalTokens"], 1000);

    let _ = fs::remove_file(db_path);
}

// ── Scenario 9: Crypto identity cross-validation ──

#[test]
fn scenario_crypto_identity_cross_validation() {
    use collector_core::crypto;

    let identity = crypto::generate_identity();
    assert!(identity.participant_id.starts_with("p_"));

    let payload = serde_json::json!({"pid": identity.participant_id, "items": [{"tokens": 1000}]});
    let sig = crypto::sign_payload(&identity.identity_private_key, &payload);

    assert!(crypto::verify_payload(
        &identity.identity_public_key,
        &payload,
        &sig
    ));

    let mut tampered = payload.clone();
    tampered["items"][0]["tokens"] = serde_json::json!(9999);
    assert!(!crypto::verify_payload(
        &identity.identity_public_key,
        &tampered,
        &sig
    ));

    // Canonical JSON determinism
    assert_eq!(
        crypto::canonical_json(&payload),
        crypto::canonical_json(&payload)
    );
}

// ── Scenario 10: Workdir hash stability ──

#[test]
fn scenario_workdir_hash_stability() {
    use collector_core::workdir;

    let dir = std::env::temp_dir().join("atl-wd-stable");
    let _ = fs::create_dir_all(&dir);

    let r1 = workdir::workdir_from_candidate(&dir.to_string_lossy(), "p_user");
    let r2 = workdir::workdir_from_candidate(&dir.to_string_lossy(), "p_user");
    assert_eq!(r1.workdir_hash, r2.workdir_hash);
    assert_eq!(r1.display_name, r2.display_name);

    let r3 = workdir::workdir_from_candidate(&dir.to_string_lossy(), "p_other");
    assert_ne!(r1.workdir_hash, r3.workdir_hash);

    // Virtual path
    let vr = workdir::workdir_from_candidate("virtual:cursor-dashboard:user@x.com", "p_user");
    assert!(vr.local_path.is_empty());
    assert_eq!(vr.display_name, "user@x.com");

    let _ = fs::remove_dir_all(&dir);
}

// ── Scenario 11: Runtime log lifecycle ──

#[test]
fn scenario_runtime_log_lifecycle() {
    let _guard = lock();
    let _prev = SaveHome::new();
    let _env = TestEnv::new();

    collector_core::observability::append_runtime_event(
        "sidecar",
        "command_start",
        "info",
        serde_json::json!({"command": "usage:scan"}),
    );
    collector_core::observability::append_runtime_event(
        "sidecar",
        "command_error",
        "error",
        serde_json::json!({"command": "usage:sync", "error": "timeout"}),
    );

    let events = collector_core::observability::read_recent_runtime_events(100);
    assert!(events.len() >= 2);

    let summary = collector_core::observability::runtime_log_summary();
    assert_eq!(summary["exists"], true);
    assert!(summary["retainedEvents"].as_u64().unwrap() >= 2);

    let clear = collector_core::observability::clear_runtime_log();
    assert_eq!(clear["ok"], true);

    assert!(collector_core::observability::read_recent_runtime_events(100).is_empty());
}

// ── Scenario 12: Sidecar protocol serialization ──

#[test]
fn scenario_sidecar_protocol_serialization() {
    use collector_core::protocol::{Command, SidecarEvent, SidecarRequest, SidecarResponse};

    let request = SidecarRequest {
        id: "req-1".into(),
        command: "usage:scan".into(),
        args: serde_json::json!({"force": true}),
    };
    let json = serde_json::to_string(&request).unwrap();
    let parsed: SidecarRequest = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.id, "req-1");
    assert_eq!(Command::from_str(&parsed.command), Some(Command::UsageScan));

    let response = SidecarResponse::ok("req-1".into(), serde_json::json!({"rowCount": 5}));
    assert!(response.ok);
    assert_eq!(response.data.unwrap()["rowCount"], 5);

    let error_resp = SidecarResponse::error("req-2".into(), "network error");
    assert!(!error_resp.ok);
    assert_eq!(error_resp.error.unwrap(), "network error");

    let event = SidecarEvent::new("scan-complete", serde_json::json!({"rows": 3}));
    assert_eq!(event.event, "scan-complete");
    assert_eq!(event.data.unwrap()["rows"], 3);
}

// ── Helpers ──

struct SaveHome {
    prev: Option<String>,
}

impl SaveHome {
    fn new() -> Self {
        let prev = std::env::var("HOME").ok();
        Self { prev }
    }
}

impl Drop for SaveHome {
    fn drop(&mut self) {
        if let Some(prev) = &self.prev {
            std::env::set_var("HOME", prev);
        } else {
            std::env::remove_var("HOME");
        }
    }
}

fn make_item(
    day: &str,
    hour: i64,
    tool: &str,
    provider: &str,
    model: &str,
    tokens: i64,
) -> serde_json::Value {
    serde_json::json!({
        "day": day, "hour": hour, "toolCode": tool, "providerId": provider,
        "workdirHash": format!("h_{}", provider), "workdirDisplayName": format!("proj_{}", provider),
        "model": model,
        "inputTokens": tokens / 2, "outputTokens": tokens / 4,
        "cacheReadTokens": tokens / 8, "cacheWriteTokens": tokens / 8,
        "reasoningTokens": 0, "totalTokens": tokens,
        "sourceQuality": "exact", "rawSourceRef": "test.jsonl",
        "providerVersion": "1", "parserVersion": "1",
        "sourceFingerprint": format!("fp_{}_{}", provider, day)
    })
}

fn run_async<F>(fut: F) -> F::Output
where
    F: std::future::Future,
{
    tokio::runtime::Runtime::new().unwrap().block_on(fut)
}
