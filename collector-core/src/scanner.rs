use crate::config::AppConfig;
use crate::crypto::sha256_hex;
use crate::provider::claude_code_local::ClaudeCodeLocalProvider;
use crate::provider::codex_local::CodexProvider;
use crate::provider::cursor_dashboard::{build_cursor_session_cookie, CursorDashboardProvider};
use crate::provider::dsh_local::DshLocalProvider;
use crate::provider::hermes_local::HermesLocalProvider;
use crate::provider::kimi_local::KimiLocalProvider;
use crate::provider::mimocode_local::MiMoCodeLocalProvider;
use crate::provider::openclaw_local::OpenClawLocalProvider;
use crate::provider::opencode_local::OpenCodeLocalProvider;
use crate::provider::workbuddy_local::WorkBuddyLocalProvider;
use crate::provider::zcode_local::ZCodeLocalProvider;
use crate::schema::{compute_bucket_fingerprint, public_usage_item};
use crate::workdir::workdir_from_candidate;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

pub struct ScanResult {
    pub items: Vec<Value>,
    pub health: Vec<Value>,
    pub source_index: HashMap<String, Vec<Value>>,
    pub provider_errors: HashMap<String, String>,
}

pub trait SourceCache {
    fn take_cached_source(&mut self, fingerprint: &str) -> Option<Vec<Value>>;
}

impl SourceCache for HashMap<String, Vec<Value>> {
    fn take_cached_source(&mut self, fingerprint: &str) -> Option<Vec<Value>> {
        self.remove(fingerprint)
    }
}

/// Async scan: local providers plus Cursor dashboard usage when enabled.
pub async fn scan_usage_async(
    config: &AppConfig,
    cache_items: HashMap<String, Vec<Value>>,
) -> ScanResult {
    let mut cache_items = cache_items;
    scan_usage_async_with_source_cache(config, &mut cache_items).await
}

pub async fn scan_usage_async_with_source_cache<C: SourceCache>(
    config: &AppConfig,
    source_cache: &mut C,
) -> ScanResult {
    let mut result = scan_usage_with_source_cache(config, source_cache);

    let cursor = CursorDashboardProvider;
    if cursor.is_enabled(config) {
        // Proactive refresh for authorized accounts
        let mut config = cursor.refresh_accounts_if_needed(config).await;

        let mut cursor_items = Vec::new();
        let mut cursor_errors = Vec::new();
        let mut latest_usage_day: Option<String> = None;
        let sources = cursor.discover_sources(&config);

        // Build a map from cookie to account index for reactive refresh
        let account_cookies: Vec<(String, usize)> = config
            .cursor_dashboard_usage
            .accounts
            .iter()
            .enumerate()
            .map(|(i, acc)| {
                let cookie = build_cursor_session_cookie(&acc.sub, &acc.access_token);
                (cookie, i)
            })
            .collect();

        for source in &sources {
            let fetch_result = if source.source_name == "authorized" {
                // Find account index for reactive refresh support
                let idx = account_cookies
                    .iter()
                    .find(|(c, _)| c == &source.cookie)
                    .map(|(_, i)| *i);
                match idx {
                    Some(idx) => {
                        cursor
                            .fetch_with_reactive_refresh(&source.cookie, idx, &mut config)
                            .await
                    }
                    None => cursor.fetch_usage(&source.cookie).await,
                }
            } else {
                cursor.fetch_usage(&source.cookie).await
            };

            match fetch_result {
                Ok(events) => {
                    if let Some(day) = cursor.latest_usage_day(&events) {
                        if latest_usage_day
                            .as_ref()
                            .is_none_or(|current| day > *current)
                        {
                            latest_usage_day = Some(day);
                        }
                    }
                    cursor_items.extend(
                        cursor
                            .parse_events(&events, &source.account_name)
                            .into_iter()
                            .map(|event| finalize_event(event, &config)),
                    );
                }
                Err(error) => cursor_errors.push(format!("{}: {}", source.source_name, error)),
            }
        }
        if cursor_errors.is_empty() && !cursor_items.is_empty() {
            let mut combined = result.items;
            combined.extend(cursor_items);
            result.items = aggregate_items(&combined);
        } else if !cursor_errors.is_empty() {
            result
                .provider_errors
                .insert(cursor.id().to_string(), cursor_errors.join("; "));
        }
        result.health.push(cursor_provider_health(
            cursor.id(),
            cursor.tool_code(),
            &config,
            &sources,
            latest_usage_day.as_deref(),
        ));
    } else {
        let sources = cursor.discover_sources(config);
        result.health.push(cursor_provider_health(
            cursor.id(),
            cursor.tool_code(),
            config,
            &sources,
            None,
        ));
    }

    result
}

/// Main scan: iterate all providers, collect usage items, aggregate.
pub fn scan_usage(config: &AppConfig, mut cache_items: HashMap<String, Vec<Value>>) -> ScanResult {
    scan_usage_with_source_cache(config, &mut cache_items)
}

pub fn scan_usage_with_source_cache<C: SourceCache>(
    config: &AppConfig,
    source_cache: &mut C,
) -> ScanResult {
    let mut health = Vec::new();
    let mut source_index: HashMap<String, Vec<Value>> = HashMap::new();
    let mut provider_errors = HashMap::new();

    // Codex
    let codex = CodexProvider;
    let codex_files = codex.scan_sessions(config);
    let codex_replay_plan = crate::provider::codex_local::CodexReplayPlan::new(&codex_files);
    {
        let mut source_fingerprints = codex_files
            .iter()
            .map(|file| {
                crate::provider::common::source_metadata(file, codex.id(), codex.version())
                    .source_fingerprint
            })
            .collect::<Vec<_>>();
        source_fingerprints.sort();
        let combined_fp = sha256_hex(&source_fingerprints.join("|"));
        let items = if let Some(cached) = source_cache
            .take_cached_source(&combined_fp)
            .filter(|items| cached_items_have_hour(items))
        {
            cached
        } else {
            let events = codex_files
                .iter()
                .flat_map(|file| {
                    codex.parse_usage_with_replay(file, codex_replay_plan.replay_prefix(file))
                })
                .collect::<Vec<_>>();
            global_dedup_by_field(events, "_codexDedupKey")
                .into_iter()
                .map(|event| finalize_event(event, config))
                .collect()
        };
        source_index.insert(combined_fp, items);
    }
    health.push(local_provider_health(
        codex.id(),
        codex.tool_code(),
        codex.auto_roots(config),
        codex.manual_roots(config),
        config,
        codex_files.len(),
        true,
    ));

    // Claude Code — global dedup by message.id before public-field finalization.
    let claude = ClaudeCodeLocalProvider;
    let claude_files = claude.scan_sessions(config);
    {
        let mut source_fingerprints = claude_files
            .iter()
            .map(|file| {
                crate::provider::common::source_metadata(file, claude.id(), claude.version())
                    .source_fingerprint
            })
            .collect::<Vec<_>>();
        source_fingerprints.sort();
        let combined_fp = sha256_hex(&source_fingerprints.join("|"));

        let items = if let Some(cached) = source_cache
            .take_cached_source(&combined_fp)
            .filter(|items| cached_items_have_hour(items))
        {
            cached
        } else {
            let events = claude_files
                .iter()
                .flat_map(|file| claude.parse_usage(file))
                .collect::<Vec<_>>();
            global_dedup_by_message_id(events)
                .into_iter()
                .map(|event| finalize_event(event, config))
                .collect()
        };
        source_index.insert(combined_fp, items);
    }
    health.push(local_provider_health(
        claude.id(),
        claude.tool_code(),
        claude.auto_roots(config),
        claude.manual_roots(config),
        config,
        claude_files.len(),
        true,
    ));

    // MiMoCode
    let mimocode = MiMoCodeLocalProvider;
    let mimocode_dbs = mimocode.scan_sessions(config);
    let mut mimocode_sources = HashMap::new();
    let mut mimocode_error = None;
    for db_path in &mimocode_dbs {
        let source_meta =
            crate::provider::common::source_metadata(db_path, mimocode.id(), mimocode.version());
        let items = if let Some(cached) = source_cache
            .take_cached_source(&source_meta.source_fingerprint)
            .filter(|items| cached_items_have_hour(items))
        {
            cached
        } else {
            match mimocode.try_parse_usage(db_path) {
                Ok(events) => events
                    .into_iter()
                    .map(|event| finalize_event(event, config))
                    .collect::<Vec<_>>(),
                Err(error) => {
                    mimocode_error = Some(format!("{}: {}", db_path, error));
                    Vec::new()
                }
            }
        };
        mimocode_sources.insert(source_meta.source_fingerprint, items);
    }
    if let Some(error) = mimocode_error {
        provider_errors.insert(mimocode.id().to_string(), error);
    } else {
        source_index.extend(mimocode_sources);
    }
    health.push(local_provider_health(
        mimocode.id(),
        mimocode.tool_code(),
        mimocode.auto_roots(config),
        mimocode.manual_roots(config),
        config,
        mimocode_dbs.len(),
        true,
    ));

    // OpenCode
    let opencode = OpenCodeLocalProvider;
    let opencode_dbs = opencode.scan_sessions(config);
    let mut opencode_sources = HashMap::new();
    let mut opencode_error = None;
    for db_path in &opencode_dbs {
        let source_meta =
            crate::provider::common::source_metadata(db_path, opencode.id(), opencode.version());
        let items = if let Some(cached) = source_cache
            .take_cached_source(&source_meta.source_fingerprint)
            .filter(|items| cached_items_have_hour(items))
        {
            cached
        } else {
            match opencode.try_parse_usage(db_path) {
                Ok(events) => events
                    .into_iter()
                    .map(|event| finalize_event(event, config))
                    .collect::<Vec<_>>(),
                Err(error) => {
                    opencode_error = Some(format!("{}: {}", db_path, error));
                    Vec::new()
                }
            }
        };
        opencode_sources.insert(source_meta.source_fingerprint, items);
    }
    if let Some(error) = opencode_error {
        provider_errors.insert(opencode.id().to_string(), error);
    } else {
        source_index.extend(opencode_sources);
    }
    health.push(local_provider_health(
        opencode.id(),
        opencode.tool_code(),
        opencode.auto_roots(config),
        opencode.manual_roots(config),
        config,
        opencode_dbs.len(),
        true,
    ));

    // Hermes
    let hermes = HermesLocalProvider;
    let hermes_dbs = hermes.scan_sessions(config);
    let mut hermes_sources = HashMap::new();
    let mut hermes_error = None;
    for db_path in &hermes_dbs {
        let source_meta =
            crate::provider::common::source_metadata(db_path, hermes.id(), hermes.version());
        let items = if let Some(cached) = source_cache
            .take_cached_source(&source_meta.source_fingerprint)
            .filter(|items| cached_items_have_hour(items))
        {
            cached
        } else {
            match hermes.try_parse_usage(db_path) {
                Ok(events) => events
                    .into_iter()
                    .map(|event| finalize_event(event, config))
                    .collect::<Vec<_>>(),
                Err(error) => {
                    hermes_error = Some(format!("{}: {}", db_path, error));
                    Vec::new()
                }
            }
        };
        hermes_sources.insert(source_meta.source_fingerprint, items);
    }
    if let Some(error) = hermes_error {
        provider_errors.insert(hermes.id().to_string(), error);
    } else {
        source_index.extend(hermes_sources);
    }
    health.push(local_provider_health(
        hermes.id(),
        hermes.tool_code(),
        hermes.auto_roots(config),
        hermes.manual_roots(config),
        config,
        hermes_dbs.len(),
        true,
    ));

    // ZCode
    let zcode = ZCodeLocalProvider;
    let zcode_dbs = zcode.scan_sessions(config);
    let mut zcode_sources = HashMap::new();
    let mut zcode_error = None;
    for db_path in &zcode_dbs {
        let source_meta =
            crate::provider::common::source_metadata(db_path, zcode.id(), zcode.version());
        let items = if let Some(cached) = source_cache
            .take_cached_source(&source_meta.source_fingerprint)
            .filter(|items| cached_items_have_hour(items))
        {
            cached
        } else {
            match zcode.try_parse_usage(db_path) {
                Ok(events) => events
                    .into_iter()
                    .map(|event| finalize_event(event, config))
                    .collect::<Vec<_>>(),
                Err(error) => {
                    zcode_error = Some(format!("{}: {}", db_path, error));
                    Vec::new()
                }
            }
        };
        zcode_sources.insert(source_meta.source_fingerprint, items);
    }
    if let Some(error) = zcode_error {
        provider_errors.insert(zcode.id().to_string(), error);
    } else {
        source_index.extend(zcode_sources);
    }
    health.push(local_provider_health(
        zcode.id(),
        zcode.tool_code(),
        zcode.auto_roots(config),
        zcode.manual_roots(config),
        config,
        zcode_dbs.len(),
        true,
    ));

    // OpenClaw
    let openclaw = OpenClawLocalProvider;
    let openclaw_files = openclaw.scan_sessions(config);
    for file in &openclaw_files {
        let source_meta =
            crate::provider::common::source_metadata(file, openclaw.id(), openclaw.version());
        let items = if let Some(cached) = source_cache
            .take_cached_source(&source_meta.source_fingerprint)
            .filter(|items| cached_items_have_hour(items))
        {
            cached
        } else {
            let events = openclaw.parse_usage(file);
            events
                .into_iter()
                .map(|event| finalize_event(event, config))
                .collect::<Vec<_>>()
        };
        source_index.insert(source_meta.source_fingerprint, items);
    }
    health.push(local_provider_health(
        openclaw.id(),
        openclaw.tool_code(),
        openclaw.auto_roots(config),
        openclaw.manual_roots(config),
        config,
        openclaw_files.len(),
        true,
    ));

    // WorkBuddy
    let workbuddy = WorkBuddyLocalProvider;
    let workbuddy_files = workbuddy.scan_sessions(config);
    let mut workbuddy_errors: Vec<String> = Vec::new();
    for file in &workbuddy_files {
        let source_meta =
            crate::provider::common::source_metadata(file, workbuddy.id(), workbuddy.version());
        if let Some(cached) = source_cache
            .take_cached_source(&source_meta.source_fingerprint)
            .filter(|items| cached_items_have_hour(items))
        {
            source_index.insert(source_meta.source_fingerprint, cached);
            continue;
        }
        match workbuddy.try_parse_usage(file) {
            Ok(events) => {
                source_index.insert(
                    source_meta.source_fingerprint,
                    events
                        .into_iter()
                        .map(|event| finalize_event(event, config))
                        .collect::<Vec<_>>(),
                );
            }
            Err(error) => {
                workbuddy_errors.push(format!("{}: {}", file, error));
            }
        }
    }
    if !workbuddy_errors.is_empty() {
        provider_errors.insert(workbuddy.id().to_string(), workbuddy_errors.join("; "));
    }
    // Persist workdir attribution snapshots pinned during this scan so later
    // rescans (including after source-cache resets) reuse the original cwd
    // attribution instead of the drifted sessions/<pid>.json state.
    crate::provider::workbuddy_local::flush_workdir_snapshot_cache();
    health.push(local_provider_health(
        workbuddy.id(),
        workbuddy.tool_code(),
        workbuddy.auto_roots(config),
        workbuddy.manual_roots(config),
        config,
        workbuddy_files.len(),
        true,
    ));

    // DSH (DeepSeek Harness)
    let dsh = DshLocalProvider;
    let dsh_files = dsh.scan_sessions(config);
    let mut dsh_errors: Vec<String> = Vec::new();
    for file in &dsh_files {
        let source_meta =
            crate::provider::common::source_metadata(file, dsh.id(), dsh.version());
        if let Some(cached) = source_cache
            .take_cached_source(&source_meta.source_fingerprint)
            .filter(|items| cached_items_have_hour(items))
        {
            source_index.insert(source_meta.source_fingerprint, cached);
            continue;
        }
        match dsh.try_parse_usage(file) {
            Ok(events) => {
                source_index.insert(
                    source_meta.source_fingerprint,
                    events
                        .into_iter()
                        .map(|event| finalize_event(event, config))
                        .collect::<Vec<_>>(),
                );
            }
            Err(error) => {
                dsh_errors.push(format!("{}: {}", file, error));
            }
        }
    }
    if !dsh_errors.is_empty() {
        provider_errors.insert(dsh.id().to_string(), dsh_errors.join("; "));
    }
    health.push(local_provider_health(
        dsh.id(),
        dsh.tool_code(),
        dsh.auto_roots(config),
        dsh.manual_roots(config),
        config,
        dsh_files.len(),
        true,
    ));

    // Kimi desktop (embedded daimon / kimi-code kernel agent sessions)
    let kimi = KimiLocalProvider;
    let kimi_files = kimi.scan_sessions(config);
    let mut kimi_errors: Vec<String> = Vec::new();
    for file in &kimi_files {
        let source_meta =
            crate::provider::common::source_metadata(file, kimi.id(), kimi.version());
        if let Some(cached) = source_cache
            .take_cached_source(&source_meta.source_fingerprint)
            .filter(|items| cached_items_have_hour(items))
        {
            source_index.insert(source_meta.source_fingerprint, cached);
            continue;
        }
        match kimi.try_parse_usage(file) {
            Ok(events) => {
                source_index.insert(
                    source_meta.source_fingerprint,
                    events
                        .into_iter()
                        .map(|event| finalize_event(event, config))
                        .collect::<Vec<_>>(),
                );
            }
            Err(error) => {
                kimi_errors.push(format!("{}: {}", file, error));
            }
        }
    }
    if !kimi_errors.is_empty() {
        provider_errors.insert(kimi.id().to_string(), kimi_errors.join("; "));
    }
    health.push(local_provider_health(
        kimi.id(),
        kimi.tool_code(),
        kimi.auto_roots(config),
        kimi.manual_roots(config),
        config,
        kimi_files.len(),
        true,
    ));

    // Aggregate
    let aggregated = aggregate_item_refs(source_index.values().flat_map(|items| items.iter()));

    ScanResult {
        items: aggregated,
        health,
        source_index,
        provider_errors,
    }
}

pub fn provider_health(config: &AppConfig) -> Vec<Value> {
    let codex = CodexProvider;
    let claude = ClaudeCodeLocalProvider;
    let cursor = CursorDashboardProvider;
    let mimocode = MiMoCodeLocalProvider;
    let opencode = OpenCodeLocalProvider;
    let hermes = HermesLocalProvider;
    let openclaw = OpenClawLocalProvider;
    let zcode = ZCodeLocalProvider;
    let workbuddy = WorkBuddyLocalProvider;
    let dsh = DshLocalProvider;
    let kimi = KimiLocalProvider;
    let codex_files = codex.scan_sessions(config);
    let claude_files = claude.scan_sessions(config);
    let cursor_sources = cursor.discover_sources(config);
    let mimocode_dbs = mimocode.scan_sessions(config);
    let opencode_dbs = opencode.scan_sessions(config);
    let hermes_dbs = hermes.scan_sessions(config);
    let openclaw_files = openclaw.scan_sessions(config);
    let zcode_dbs = zcode.scan_sessions(config);
    let workbuddy_files = workbuddy.scan_sessions(config);
    let dsh_files = dsh.scan_sessions(config);
    let kimi_files = kimi.scan_sessions(config);

    vec![
        local_provider_health(
            codex.id(),
            codex.tool_code(),
            codex.auto_roots(config),
            codex.manual_roots(config),
            config,
            codex_files.len(),
            true,
        ),
        local_provider_health(
            claude.id(),
            claude.tool_code(),
            claude.auto_roots(config),
            claude.manual_roots(config),
            config,
            claude_files.len(),
            true,
        ),
        local_provider_health(
            mimocode.id(),
            mimocode.tool_code(),
            mimocode.auto_roots(config),
            mimocode.manual_roots(config),
            config,
            mimocode_dbs.len(),
            true,
        ),
        local_provider_health(
            opencode.id(),
            opencode.tool_code(),
            opencode.auto_roots(config),
            opencode.manual_roots(config),
            config,
            opencode_dbs.len(),
            true,
        ),
        local_provider_health(
            hermes.id(),
            hermes.tool_code(),
            hermes.auto_roots(config),
            hermes.manual_roots(config),
            config,
            hermes_dbs.len(),
            true,
        ),
        local_provider_health(
            openclaw.id(),
            openclaw.tool_code(),
            openclaw.auto_roots(config),
            openclaw.manual_roots(config),
            config,
            openclaw_files.len(),
            true,
        ),
        local_provider_health(
            zcode.id(),
            zcode.tool_code(),
            zcode.auto_roots(config),
            zcode.manual_roots(config),
            config,
            zcode_dbs.len(),
            true,
        ),
        local_provider_health(
            workbuddy.id(),
            workbuddy.tool_code(),
            workbuddy.auto_roots(config),
            workbuddy.manual_roots(config),
            config,
            workbuddy_files.len(),
            true,
        ),
        local_provider_health(
            dsh.id(),
            dsh.tool_code(),
            dsh.auto_roots(config),
            dsh.manual_roots(config),
            config,
            dsh_files.len(),
            true,
        ),
        local_provider_health(
            kimi.id(),
            kimi.tool_code(),
            kimi.auto_roots(config),
            kimi.manual_roots(config),
            config,
            kimi_files.len(),
            true,
        ),
        cursor_provider_health(
            cursor.id(),
            cursor.tool_code(),
            config,
            &cursor_sources,
            None,
        ),
    ]
}

fn local_provider_health(
    provider_id: &str,
    tool_code: &str,
    auto_roots: Vec<String>,
    manual_roots: Vec<String>,
    config: &AppConfig,
    scanned_files: usize,
    default_enabled: bool,
) -> Value {
    let ignored = config
        .provider_ignored_auto_sources
        .get(provider_id)
        .cloned()
        .unwrap_or_default();
    let mut roots = auto_roots.clone();
    for root in &manual_roots {
        if !roots.contains(root) {
            roots.push(root.clone());
        }
    }
    let sources = source_rows(&auto_roots, &manual_roots, &ignored);
    let detected = !roots.is_empty();
    json!({
        "providerId": provider_id,
        "toolCode": tool_code,
        "enabled": config.provider_enabled.get(provider_id).copied().unwrap_or(default_enabled),
        "detected": detected,
        "ok": detected,
        "roots": roots,
        "sources": sources,
        "scannedFiles": scanned_files
    })
}

fn cursor_provider_health(
    provider_id: &str,
    tool_code: &str,
    config: &AppConfig,
    detected_sources: &[crate::provider::cursor_dashboard::CursorSource],
    latest_usage_day: Option<&str>,
) -> Value {
    let mut sources = Vec::new();

    for (index, account) in config.cursor_dashboard_usage.accounts.iter().enumerate() {
        let label = if !account.email.trim().is_empty() {
            account.email.clone()
        } else {
            format!("Cursor #{}", index + 1)
        };
        let id = if !account.account_hash.trim().is_empty() {
            account.account_hash.clone()
        } else if !account.auth_id.trim().is_empty() {
            account.auth_id.clone()
        } else {
            format!("account:{}", index)
        };
        sources.push(json!({
            "kind": "manual",
            "id": id,
            "label": label,
            "accountIndex": index,
            "authStatus": account.auth_status,
            "lastRefreshAt": account.last_refresh_at,
            "ignored": account.ignored
        }));
    }

    let roots = detected_sources
        .iter()
        .map(|source| source.account_name.clone())
        .collect::<Vec<_>>();
    let detected = !detected_sources.is_empty();
    json!({
        "providerId": provider_id,
        "toolCode": tool_code,
        "enabled": config.provider_enabled.get(provider_id).copied().unwrap_or(false),
        "detected": detected,
        "ok": detected,
        "roots": roots,
        "sources": sources,
        "scannedFiles": detected_sources.len(),
        "latestUsageDay": latest_usage_day
    })
}

fn source_rows(auto_roots: &[String], manual_roots: &[String], ignored: &[String]) -> Vec<Value> {
    let mut rows = Vec::new();
    for root in auto_roots {
        rows.push(json!({
            "kind": "auto",
            "id": root,
            "label": shorten_path(root),
            "path": root,
            "ignored": ignored.contains(root)
        }));
    }
    for root in manual_roots {
        rows.push(json!({
            "kind": "manual",
            "id": root,
            "label": shorten_path(root),
            "path": root,
            "ignored": false
        }));
    }
    for root in ignored {
        if rows
            .iter()
            .any(|source| source.get("id").and_then(|v| v.as_str()) == Some(root.as_str()))
        {
            continue;
        }
        rows.push(json!({
            "kind": "auto",
            "id": root,
            "label": shorten_path(root),
            "path": root,
            "ignored": true
        }));
    }
    rows
}

fn shorten_path(value: &str) -> String {
    let Some(home) = dirs::home_dir() else {
        return value.to_string();
    };
    let home = home.to_string_lossy().to_string();
    if value == home {
        "~".to_string()
    } else if value.starts_with(&format!("{}/", home)) {
        format!("~{}", &value[home.len()..])
    } else {
        Path::new(value).to_str().unwrap_or(value).to_string()
    }
}

/// Group items by day|hour|toolCode|providerId|workdirHash|model, sum tokens.
fn aggregate_items(items: &[Value]) -> Vec<Value> {
    aggregate_item_refs(items.iter())
}

fn aggregate_item_refs<'a>(items: impl IntoIterator<Item = &'a Value>) -> Vec<Value> {
    let mut groups: HashMap<String, Vec<&Value>> = HashMap::new();
    for item in items {
        let hour = item
            .get("hour")
            .and_then(|v| v.as_i64())
            .map(|h| h.to_string())
            .unwrap_or_default();
        let key = format!(
            "{}|{}|{}|{}|{}|{}",
            item["day"].as_str().unwrap_or(""),
            hour,
            item["toolCode"].as_str().unwrap_or(""),
            item["providerId"].as_str().unwrap_or(""),
            item["workdirHash"].as_str().unwrap_or(""),
            item["model"].as_str().unwrap_or("")
        );
        groups.entry(key).or_default().push(item);
    }

    let mut result: Vec<Value> = groups
        .into_iter()
        .map(|(_, group)| {
            let first = &group[0];
            let input_tokens: i64 = group
                .iter()
                .map(|i| i["inputTokens"].as_i64().unwrap_or(0))
                .sum();
            let output_tokens: i64 = group
                .iter()
                .map(|i| i["outputTokens"].as_i64().unwrap_or(0))
                .sum();
            let cache_read_tokens: i64 = group
                .iter()
                .map(|i| i["cacheReadTokens"].as_i64().unwrap_or(0))
                .sum();
            let cache_write_tokens: i64 = group
                .iter()
                .map(|i| i["cacheWriteTokens"].as_i64().unwrap_or(0))
                .sum();
            let reasoning_tokens: i64 = group
                .iter()
                .map(|i| i["reasoningTokens"].as_i64().unwrap_or(0))
                .sum();
            let total_tokens: i64 = group
                .iter()
                .map(|i| i["totalTokens"].as_i64().unwrap_or(0))
                .sum();

            let all_exact = group
                .iter()
                .all(|i| i["sourceQuality"].as_str() == Some("exact"));
            let source_quality = if all_exact { "exact" } else { "partial" };

            let raw_source_ref = merge_trace_value(
                group
                    .iter()
                    .map(|i| i["rawSourceRef"].as_str().unwrap_or(""))
                    .collect(),
            );
            let source_fingerprint = merge_trace_value(
                group
                    .iter()
                    .map(|i| i["sourceFingerprint"].as_str().unwrap_or(""))
                    .collect(),
            );
            let provider_version = merge_trace_value(
                group
                    .iter()
                    .map(|i| i["providerVersion"].as_str().unwrap_or(""))
                    .collect(),
            );
            let parser_version = merge_trace_value(
                group
                    .iter()
                    .map(|i| i["parserVersion"].as_str().unwrap_or(""))
                    .collect(),
            );

            json!({
                "day": first["day"],
                "hour": first.get("hour").and_then(|v| v.as_i64()).unwrap_or(0),
                "toolCode": first["toolCode"],
                "providerId": first["providerId"],
                "workdirHash": first["workdirHash"],
                "workdirDisplayName": first["workdirDisplayName"],
                "model": first["model"],
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "cacheReadTokens": cache_read_tokens,
                "cacheWriteTokens": cache_write_tokens,
                "reasoningTokens": reasoning_tokens,
                "totalTokens": total_tokens,
                "sourceQuality": source_quality,
                "rawSourceRef": raw_source_ref,
                "sourceFingerprint": source_fingerprint,
                "providerVersion": provider_version,
                "parserVersion": parser_version,
            })
        })
        .collect();

    result.sort_by(|a, b| {
        b["totalTokens"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&a["totalTokens"].as_i64().unwrap_or(0))
    });

    result
}

/// Merge trace values: collect unique non-empty values, sort.
/// If one value, return it. If multiple, hash them.
fn merge_trace_value(values: Vec<&str>) -> String {
    let mut unique: Vec<&str> = values.into_iter().filter(|v| !v.is_empty()).collect();
    unique.sort();
    unique.dedup();
    match unique.len() {
        0 => String::new(),
        1 => unique[0].to_string(),
        _ => {
            let joined = unique.join("|");
            sha256_hex(&joined)
        }
    }
}

/// Group items by day|hour|providerId for sync buckets.
pub fn group_by_bucket(items: &[Value]) -> Vec<(String, Value)> {
    let mut groups: HashMap<String, Vec<&Value>> = HashMap::new();
    for item in items {
        let hour = item
            .get("hour")
            .and_then(|v| v.as_i64())
            .map(|h| h.to_string())
            .unwrap_or_default();
        let key = format!(
            "{}|{}|{}",
            item["day"].as_str().unwrap_or(""),
            hour,
            item["providerId"].as_str().unwrap_or("")
        );
        groups.entry(key).or_default().push(item);
    }

    groups
        .into_iter()
        .map(|(key, items)| {
            let first = &items[0];
            let bucket = json!({
                "day": first["day"],
                "hour": first.get("hour").and_then(|v| v.as_i64()).unwrap_or(0),
                "providerId": first["providerId"],
                "mode": "device_day_hour_provider",
                "items": items,
                "fingerprint": compute_bucket_fingerprint(&items.iter().cloned().cloned().collect::<Vec<_>>())
            });
            (key, bucket)
        })
        .collect()
}

fn cached_items_have_hour(items: &[Value]) -> bool {
    items.iter().all(|item| {
        item.get("hour")
            .and_then(|v| v.as_i64())
            .is_some_and(|hour| (0..=23).contains(&hour))
    })
}

/// Global deduplication by message.id across all Claude Code files.
/// Same message.id can appear in multiple project directories (e.g. ~/.config/claude/projects
/// and ~/.claude/projects). Keep the entry with the highest totalTokens per message.id,
/// matching ccusage's dedup semantics.
///
fn global_dedup_by_message_id(events: Vec<Value>) -> Vec<Value> {
    let mut best: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut result: Vec<Value> = Vec::new();

    for event in events {
        let dedup_key = event
            .get("_dedupKey")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_default();
        let total = event["totalTokens"].as_i64().unwrap_or(0);
        if !dedup_key.is_empty() {
            if let Some(idx) = best.get(&dedup_key).copied() {
                let existing_total = result[idx]["totalTokens"].as_i64().unwrap_or(0);
                if total > existing_total {
                    result[idx] = event;
                }
                continue;
            }
        }

        let idx = result.len();
        if !dedup_key.is_empty() {
            best.insert(dedup_key, idx);
        }
        result.push(event);
    }

    result
}

fn global_dedup_by_field(events: Vec<Value>, field: &str) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    events
        .into_iter()
        .filter(|event| {
            event
                .get(field)
                .and_then(Value::as_str)
                .filter(|key| !key.is_empty())
                .map(|key| seen.insert(key.to_string()))
                .unwrap_or(true)
        })
        .collect()
}

/// Finalize a raw provider event: resolve workdir, apply publicUsageItem.
fn finalize_event(event: Value, config: &AppConfig) -> Value {
    let candidate = event["workdirCandidate"].as_str().unwrap_or("");
    let wd = workdir_from_candidate(candidate, &config.participant_id);

    let display_name = config
        .workdir_aliases
        .get(&wd.workdir_hash)
        .cloned()
        .unwrap_or(wd.display_name);

    let mut item = event.clone();
    if let Some(obj) = item.as_object_mut() {
        obj.insert("workdirHash".to_string(), json!(wd.workdir_hash));
        obj.insert("workdirDisplayName".to_string(), json!(display_name));
        obj.remove("workdirCandidate");
        obj.remove("localPath");
    }

    public_usage_item(&item)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{self, AppConfig};
    use std::collections::HashMap;

    fn test_config() -> AppConfig {
        AppConfig {
            participant_id: "p_test".to_string(),
            nickname: "sky".to_string(),
            nickname_auto_generated: false,
            identity_public_key: "pk".to_string(),
            identity_private_key: "sk".to_string(),
            device_id: "d_test".to_string(),
            api_base_url: String::new(),
            language: "zh-CN".to_string(),
            theme: "light".to_string(),
            show_estimated_cost: false,
            auto_refresh_enabled: true,
            silent_update_mode: config::DEFAULT_SILENT_UPDATE_MODE.to_string(),
            refresh_interval_minutes: 15,
            launch_at_login: false,
            hide_dock_icon: false,
            desktop_auto_initialized: false,
            cursor_dashboard_usage: config::CursorDashboardUsageConfig::default(),
            local_backup: config::LocalBackupConfig::default(),
            runtime_log_retention_days: 3,
            share_card_orientation: "landscape".to_string(),
            show_share_cloud_url: true,
            show_share_polaroid_frame: true,
            show_share_anonymous_name: true,
            api_connection: json!({}),
            sync_status: crate::config::SyncStatusRecord::default(),
            workdir_aliases: HashMap::new(),
            provider_roots: HashMap::new(),
            provider_enabled: HashMap::new(),
            provider_ignored_auto_sources: HashMap::new(),
            created_at: None,
            updated_at: None,
            imported_at: None,
            last_sync_at: None,
            last_sync_status: None,
            last_sync_api_base_url: None,
            last_sync_error: None,
        }
    }

    #[test]
    fn test_merge_trace_value_empty() {
        assert_eq!(merge_trace_value(vec![]), "");
    }

    #[test]
    fn test_merge_trace_value_single() {
        assert_eq!(merge_trace_value(vec!["abc"]), "abc");
    }

    #[test]
    fn test_merge_trace_value_multiple() {
        let result = merge_trace_value(vec!["abc", "def"]);
        assert_eq!(result.len(), 64); // SHA-256 hex
    }

    #[test]
    fn test_aggregate_items() {
        let items = vec![
            json!({
                "day": "2024-01-01", "hour": 10, "toolCode": "codex", "providerId": "codex_local",
                "workdirHash": "abc", "workdirDisplayName": "proj", "model": "gpt-4",
                "inputTokens": 100, "outputTokens": 50, "cacheReadTokens": 0,
                "cacheWriteTokens": 0, "reasoningTokens": 0, "totalTokens": 150,
                "sourceQuality": "exact", "rawSourceRef": "a.jsonl",
                "sourceFingerprint": "fp1", "providerVersion": "0.1", "parserVersion": "0.1"
            }),
            json!({
                "day": "2024-01-01", "hour": 10, "toolCode": "codex", "providerId": "codex_local",
                "workdirHash": "abc", "workdirDisplayName": "proj", "model": "gpt-4",
                "inputTokens": 200, "outputTokens": 100, "cacheReadTokens": 0,
                "cacheWriteTokens": 0, "reasoningTokens": 0, "totalTokens": 300,
                "sourceQuality": "exact", "rawSourceRef": "b.jsonl",
                "sourceFingerprint": "fp2", "providerVersion": "0.1", "parserVersion": "0.1"
            }),
        ];
        let result = aggregate_items(&items);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["totalTokens"], 450);
        assert_eq!(result[0]["inputTokens"], 300);
        assert_eq!(result[0]["hour"], 10);
    }

    #[test]
    fn test_group_by_bucket() {
        let items = vec![
            json!({"day": "2024-01-01", "hour": 10, "providerId": "codex_local", "toolCode": "codex",
                   "workdirHash": "a", "workdirDisplayName": "p", "model": "gpt-4",
                   "inputTokens": 100, "outputTokens": 50, "cacheReadTokens": 0,
                   "cacheWriteTokens": 0, "reasoningTokens": 0, "totalTokens": 150,
                   "sourceQuality": "exact", "rawSourceRef": "", "sourceFingerprint": "",
                   "providerVersion": "", "parserVersion": ""}),
            json!({"day": "2024-01-01", "hour": 10, "providerId": "claude_code_local", "toolCode": "claude_code",
                   "workdirHash": "b", "workdirDisplayName": "q", "model": "claude",
                   "inputTokens": 200, "outputTokens": 100, "cacheReadTokens": 0,
                   "cacheWriteTokens": 0, "reasoningTokens": 0, "totalTokens": 300,
                   "sourceQuality": "exact", "rawSourceRef": "", "sourceFingerprint": "",
                   "providerVersion": "", "parserVersion": ""}),
        ];
        let buckets = group_by_bucket(&items);
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].1["mode"], "device_day_hour_provider");
    }

    #[test]
    fn test_cached_items_have_hour_rejects_legacy_rows() {
        assert!(cached_items_have_hour(&[json!({ "hour": 10 })]));
        assert!(!cached_items_have_hour(&[json!({ "day": "2026-05-16" })]));
        assert!(!cached_items_have_hour(&[json!({ "hour": 24 })]));
    }

    #[test]
    fn test_global_dedup_by_message_id_basic() {
        let events = vec![
            json!({"_dedupKey": "msg_1", "day": "2026-06-01", "hour": 10,
                   "providerId": "claude_code_local", "workdirHash": "h1", "model": "m1",
                   "totalTokens": 100}),
            json!({"_dedupKey": "msg_1", "day": "2026-06-01", "hour": 10,
                   "providerId": "claude_code_local", "workdirHash": "h1", "model": "m1",
                   "totalTokens": 150}),
            json!({"_dedupKey": "msg_2", "day": "2026-06-01", "hour": 11,
                   "providerId": "claude_code_local", "workdirHash": "h1", "model": "m1",
                   "totalTokens": 200}),
        ];
        let result = global_dedup_by_message_id(events);
        assert_eq!(result.len(), 2, "should dedupe by message id");
        let msg1 = result.iter().find(|e| e["_dedupKey"] == "msg_1").unwrap();
        assert_eq!(msg1["totalTokens"], 150);
        assert_eq!(msg1["day"], "2026-06-01");
    }

    #[test]
    fn test_global_dedup_keeps_distinct_events_with_same_public_fields() {
        let first = json!({"_dedupKey": "msg_1", "day": "2026-06-01", "hour": 10,
            "providerId": "claude_code_local", "workdirHash": "h1", "model": "m1",
            "totalTokens": 100});
        let second = json!({"_dedupKey": "msg_2", "day": "2026-06-01", "hour": 10,
            "providerId": "claude_code_local", "workdirHash": "h1", "model": "m1",
            "totalTokens": 100});
        let result = global_dedup_by_message_id(vec![first, second]);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_global_dedup_keeps_unkeyed_events() {
        let events = vec![
            json!({"day": "2026-06-01", "totalTokens": 100}),
            json!({"day": "2026-06-01", "totalTokens": 100}),
        ];
        assert_eq!(global_dedup_by_message_id(events).len(), 2);
    }

    #[test]
    fn test_codex_global_dedup_ignores_session_id() {
        let events = vec![
            json!({"_codexDedupKey":"same","sessionId":"root","totalTokens":100}),
            json!({"_codexDedupKey":"same","sessionId":"goal","totalTokens":100}),
            json!({"_codexDedupKey":"different","sessionId":"goal","totalTokens":50}),
        ];
        let result = global_dedup_by_field(events, "_codexDedupKey");
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn provider_health_includes_source_rows_for_ui() {
        let mut cfg = test_config();
        cfg.provider_roots.insert(
            "codex_local".to_string(),
            vec!["/tmp/atl-manual-codex".to_string()],
        );
        cfg.provider_ignored_auto_sources.insert(
            "codex_local".to_string(),
            vec!["/tmp/atl-ignored-codex".to_string()],
        );

        let health = provider_health(&cfg);
        let codex = health
            .iter()
            .find(|item| item["providerId"].as_str() == Some("codex_local"))
            .unwrap();
        let sources = codex["sources"].as_array().unwrap();

        assert!(sources.iter().any(|source| {
            source["kind"].as_str() == Some("manual")
                && source["id"].as_str() == Some("/tmp/atl-manual-codex")
        }));
        assert!(sources.iter().any(|source| {
            source["ignored"].as_bool() == Some(true)
                && source["id"].as_str() == Some("/tmp/atl-ignored-codex")
        }));
    }

    #[test]
    fn cursor_provider_health_includes_connected_account_status() {
        let mut cfg = test_config();
        cfg.provider_enabled
            .insert("cursor_dashboard_usage".to_string(), true);
        cfg.cursor_dashboard_usage
            .accounts
            .push(config::CursorAccount {
                access_token: "access".to_string(),
                refresh_token: "refresh".to_string(),
                auth_id: "auth_id".to_string(),
                sub: "auth0|user".to_string(),
                email: "user@example.com".to_string(),
                account_hash: "hash123456".to_string(),
                access_token_expires_at: None,
                last_refresh_at: Some("2026-05-20T00:00:00Z".to_string()),
                auth_status: "reauth_required".to_string(),
                ignored: false,
                added_at: None,
            });
        cfg.cursor_dashboard_usage
            .workos_session_tokens
            .push(config::CursorTokenRecord {
                token: "legacy-token".to_string(),
                account_name: "USER@example.com".to_string(),
                added_at: None,
            });
        cfg.provider_ignored_auto_sources.insert(
            "cursor_dashboard_usage".to_string(),
            vec!["user@example.com".to_string()],
        );

        let health = provider_health(&cfg);
        let cursor = health
            .iter()
            .find(|item| item["providerId"].as_str() == Some("cursor_dashboard_usage"))
            .unwrap();
        let sources = cursor["sources"].as_array().unwrap();

        assert!(sources.iter().any(|source| {
            source["accountIndex"].as_u64() == Some(0)
                && source["authStatus"].as_str() == Some("reauth_required")
                && source["label"].as_str() == Some("user@example.com")
        }));
        assert!(!sources
            .iter()
            .any(|source| source.get("tokenIndex").and_then(|v| v.as_u64()).is_some()));
        assert!(!sources
            .iter()
            .any(|source| source["ignored"].as_bool() == Some(true)
                && source["id"].as_str() == Some("user@example.com")));
    }

    #[test]
    fn cursor_provider_health_never_exposes_account_hash_as_label() {
        let mut cfg = test_config();
        cfg.provider_enabled
            .insert("cursor_dashboard_usage".to_string(), true);
        cfg.cursor_dashboard_usage
            .accounts
            .push(config::CursorAccount {
                access_token: "access".to_string(),
                refresh_token: "refresh".to_string(),
                auth_id: "auth_id".to_string(),
                sub: "auth0|user".to_string(),
                email: String::new(),
                account_hash: "0123456789abcdef".to_string(),
                access_token_expires_at: None,
                last_refresh_at: None,
                auth_status: "active".to_string(),
                ignored: false,
                added_at: None,
            });

        let health = provider_health(&cfg);
        let cursor = health
            .iter()
            .find(|item| item["providerId"].as_str() == Some("cursor_dashboard_usage"))
            .unwrap();
        let source = &cursor["sources"][0];

        assert_eq!(source["label"], "Cursor #1");
        assert_eq!(source["id"], "0123456789abcdef");
    }

    #[test]
    fn cursor_provider_health_ignores_legacy_only_sources() {
        let mut cfg = test_config();
        cfg.provider_enabled
            .insert("cursor_dashboard_usage".to_string(), true);
        cfg.cursor_dashboard_usage
            .workos_session_tokens
            .push(config::CursorTokenRecord {
                token: "legacy-token".to_string(),
                account_name: "legacy@example.com".to_string(),
                added_at: None,
            });
        cfg.provider_ignored_auto_sources.insert(
            "cursor_dashboard_usage".to_string(),
            vec!["legacy@example.com".to_string()],
        );

        let health = provider_health(&cfg);
        let cursor = health
            .iter()
            .find(|item| item["providerId"].as_str() == Some("cursor_dashboard_usage"))
            .unwrap();

        assert_eq!(cursor["detected"].as_bool(), Some(false));
        assert_eq!(cursor["scannedFiles"].as_u64(), Some(0));
        assert!(cursor["sources"].as_array().unwrap().is_empty());
    }

    #[test]
    fn cursor_provider_health_marks_ignored_oauth_account_without_detecting_it() {
        let mut cfg = test_config();
        cfg.provider_enabled
            .insert("cursor_dashboard_usage".to_string(), true);
        cfg.cursor_dashboard_usage
            .accounts
            .push(config::CursorAccount {
                access_token: "access".to_string(),
                refresh_token: "refresh".to_string(),
                auth_id: "auth_id".to_string(),
                sub: "auth0|user".to_string(),
                email: "ignored@example.com".to_string(),
                account_hash: "hash_ignored".to_string(),
                access_token_expires_at: None,
                last_refresh_at: Some("2026-05-20T00:00:00Z".to_string()),
                auth_status: "active".to_string(),
                ignored: true,
                added_at: None,
            });

        let health = provider_health(&cfg);
        let cursor = health
            .iter()
            .find(|item| item["providerId"].as_str() == Some("cursor_dashboard_usage"))
            .unwrap();
        let sources = cursor["sources"].as_array().unwrap();

        assert_eq!(cursor["detected"].as_bool(), Some(false));
        assert!(sources.iter().any(|source| {
            source["accountIndex"].as_u64() == Some(0)
                && source["ignored"].as_bool() == Some(true)
                && source["label"].as_str() == Some("ignored@example.com")
        }));
    }
}
