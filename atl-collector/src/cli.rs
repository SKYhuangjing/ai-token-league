use collector_core::config;
use collector_core::scanner;

pub async fn run(cmd: crate::Commands) -> Result<(), String> {
    match cmd {
        crate::Commands::Init { nickname, api } => {
            let input = serde_json::json!({
                "nickname": nickname.unwrap_or_else(|| "anonymous".to_string()),
                "apiBaseUrl": api.unwrap_or_default()
            });
            let cfg = config::init_config(input, true);
            println!("Initialized: {} ({})", cfg.nickname, cfg.participant_id);
        }
        crate::Commands::Health => {
            let cfg = config::load_config();
            match cfg {
                Some(c) => {
                    println!(
                        "OK  participant={} device={}",
                        c.participant_id, c.device_id
                    );
                }
                None => {
                    println!("NOT INITIALIZED  run 'atl-collector init' first");
                }
            }
        }
        crate::Commands::Status => {
            let cfg = config::load_config();
            match cfg {
                Some(c) => {
                    println!("participantId: {}", c.participant_id);
                    println!("deviceId: {}", c.device_id);
                    println!("nickname: {}", c.nickname);
                    println!("apiBaseUrl: {}", c.api_base_url);
                }
                None => {
                    println!("Not initialized");
                }
            }
        }
        crate::Commands::Scan { .. } => {
            let cfg = config::load_config().ok_or("Not initialized")?;
            let cache = std::collections::HashMap::new();
            let result = scanner::scan_usage_async(&cfg, cache).await;
            println!("Scanned {} items", result.items.len());
            for item in &result.items {
                println!(
                    "  {} {} {} tokens={}",
                    item["day"].as_str().unwrap_or("?"),
                    item["providerId"].as_str().unwrap_or("?"),
                    item["model"].as_str().unwrap_or("?"),
                    item["totalTokens"].as_i64().unwrap_or(0)
                );
            }
        }
        crate::Commands::Sync { full_resync } => {
            let cfg = config::load_config().ok_or("Not initialized")?;
            if cfg.api_base_url.is_empty() {
                return Err("API base URL not configured".to_string());
            }
            if full_resync {
                config::clear_sync_manifest();
            }
            let cache = std::collections::HashMap::new();
            let result = scanner::scan_usage_async(&cfg, cache).await;
            let sync_result =
                collector_core::sync::sync_usage(&cfg, &result.items, &cfg.api_base_url).await?;
            println!(
                "Synced: accepted={}, rejected={}, noop={}, queued={}",
                sync_result.accepted,
                sync_result.rejected,
                sync_result.noop_bucket_count,
                sync_result.queued
            );
        }
        crate::Commands::Register => {
            let cfg = config::load_config().ok_or("Not initialized")?;
            if cfg.api_base_url.is_empty() {
                return Err("API base URL not configured".to_string());
            }
            let client = reqwest::Client::new();
            collector_core::sync::register_device(&client, &cfg, &cfg.api_base_url).await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "registered": true,
                    "participantId": cfg.participant_id,
                    "deviceId": cfg.device_id
                }))
                .unwrap()
            );
        }
        crate::Commands::Reconcile { full } => {
            let cfg = config::load_config().ok_or("Not initialized")?;
            if cfg.api_base_url.is_empty() {
                return Err("API base URL not configured".to_string());
            }
            if !full {
                return Err("reconcile requires --full".to_string());
            }
            collector_core::reconcile::mark_full_reconcile_pending(
                &cfg.api_base_url,
                collector_core::reconcile::FullReconcileTrigger::ApiBaseUrlChanged,
            );
            let cache = std::collections::HashMap::new();
            let result = scanner::scan_usage_async(&cfg, cache).await;
            let options = collector_core::reconcile::FullReconcileOptions {
                resume: true,
                ..Default::default()
            };
            let reconcile_result = collector_core::reconcile::full_reconcile_usage(
                &cfg,
                &result.items,
                &cfg.api_base_url,
                options,
            )
            .await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "status": serde_json::to_value(&reconcile_result.status).unwrap(),
                    "checked": reconcile_result.checked_bucket_count,
                    "matched": reconcile_result.matched_bucket_count,
                    "missing": reconcile_result.missing_bucket_count,
                    "different": reconcile_result.different_bucket_count,
                    "repaired": reconcile_result.repair_uploaded_bucket_count,
                    "queued": reconcile_result.queued_bucket_count
                }))
                .unwrap()
            );
        }
        crate::Commands::ExportIdentity => {
            let cfg = config::load_config().ok_or("Not initialized")?;
            let identity = config::export_identity(&cfg);
            println!("{}", serde_json::to_string_pretty(&identity).unwrap());
        }
        crate::Commands::ImportIdentity { file } => {
            let content = std::fs::read_to_string(&file)
                .map_err(|e| format!("Cannot read {}: {}", file, e))?;
            let identity: serde_json::Value =
                serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?;
            let cfg = config::load_config().ok_or("Not initialized")?;
            let _ = config::import_identity(identity, &cfg, true);
            println!("Identity imported");
        }
    }
    Ok(())
}
