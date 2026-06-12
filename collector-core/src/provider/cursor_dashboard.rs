use crate::config::AppConfig;
use crate::crypto::sha256_hex;
use crate::provider::cursor_auth;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Datelike;
use serde_json::{json, Value};

pub const PROVIDER_ID: &str = "cursor_dashboard_usage";
pub const TOOL_CODE: &str = "cursor";
pub const VERSION: &str = "0.1.1";

pub struct CursorDashboardProvider;

impl CursorDashboardProvider {
    pub fn id(&self) -> &str {
        PROVIDER_ID
    }
    pub fn tool_code(&self) -> &str {
        TOOL_CODE
    }

    /// Proactively refresh authorized accounts whose tokens are near expiry.
    /// Returns updated config if any refresh occurred.
    pub async fn refresh_accounts_if_needed(&self, config: &AppConfig) -> AppConfig {
        let mut updated = config.clone();
        let mut changed = false;
        let now = chrono::Utc::now().to_rfc3339();

        for account in &mut updated.cursor_dashboard_usage.accounts {
            if !cursor_auth::token_needs_refresh(account) {
                continue;
            }
            if account.refresh_token.is_empty() {
                account.auth_status = "reauth_required".to_string();
                changed = true;
                continue;
            }
            match cursor_auth::refresh_token(&account.refresh_token).await {
                Ok(result) => {
                    account.access_token = result.access_token;
                    if let Some(rt) = result.refresh_token {
                        account.refresh_token = rt;
                    }
                    account.last_refresh_at = Some(now.clone());
                    account.auth_status = "active".to_string();
                    // Extract exp from new JWT
                    let (_, exp) = cursor_auth::extract_jwt_claims(&account.access_token);
                    account.access_token_expires_at = exp;
                    changed = true;
                }
                Err(cursor_auth::CursorRefreshError::ReauthRequired) => {
                    account.auth_status = "reauth_required".to_string();
                    changed = true;
                }
                Err(cursor_auth::CursorRefreshError::Transient(_)) => {
                    account.auth_status = "refresh_failed".to_string();
                    changed = true;
                }
            }
        }

        if changed {
            crate::config::save_config(&updated);
        }
        updated
    }

    /// Reactive refresh: called when a usage request returns 401/403.
    /// Refreshes once, retries the fetch, and updates config.
    pub async fn fetch_with_reactive_refresh(
        &self,
        cookie: &str,
        account_index: usize,
        config: &mut AppConfig,
    ) -> Result<Vec<Value>, String> {
        // First attempt
        match self.fetch_usage(cookie).await {
            Ok(events) => Ok(events),
            Err(e) if e.contains("401") || e.contains("403") => {
                // Try refresh once
                let refresh_token = {
                    let accounts = &config.cursor_dashboard_usage.accounts;
                    match accounts.get(account_index) {
                        Some(acc) if !acc.refresh_token.is_empty() => acc.refresh_token.clone(),
                        _ => {
                            if let Some(acc) = config
                                .cursor_dashboard_usage
                                .accounts
                                .get_mut(account_index)
                            {
                                acc.auth_status = "reauth_required".to_string();
                            }
                            crate::config::save_config(config);
                            return Err(e);
                        }
                    }
                };
                match cursor_auth::refresh_token(&refresh_token).await {
                    Ok(result) => {
                        let now = chrono::Utc::now().to_rfc3339();
                        let new_access_token;
                        let new_cookie;
                        {
                            let account =
                                &mut config.cursor_dashboard_usage.accounts[account_index];
                            account.access_token = result.access_token.clone();
                            if let Some(rt) = result.refresh_token {
                                account.refresh_token = rt;
                            }
                            new_access_token = result.access_token;
                            account.last_refresh_at = Some(now);
                            account.auth_status = "active".to_string();
                            let (_, exp) = cursor_auth::extract_jwt_claims(&new_access_token);
                            account.access_token_expires_at = exp;
                            new_cookie = build_cursor_session_cookie(
                                account.sub.as_str(),
                                &account.access_token,
                            );
                        }
                        let retry_result = self.fetch_usage(&new_cookie).await;
                        update_status_after_usage_retry(config, account_index, &retry_result);
                        crate::config::save_config(config);
                        retry_result
                    }
                    Err(refresh_err) => {
                        if let Some(account) = config
                            .cursor_dashboard_usage
                            .accounts
                            .get_mut(account_index)
                        {
                            account.auth_status = match &refresh_err {
                                cursor_auth::CursorRefreshError::ReauthRequired => {
                                    "reauth_required".to_string()
                                }
                                cursor_auth::CursorRefreshError::Transient(_) => {
                                    "refresh_failed".to_string()
                                }
                            };
                        }
                        crate::config::save_config(config);
                        Err(refresh_err.to_string())
                    }
                }
            }
            Err(e) => Err(e),
        }
    }
    pub fn version(&self) -> &str {
        VERSION
    }

    pub fn is_enabled(&self, config: &AppConfig) -> bool {
        config.provider_enabled.get(PROVIDER_ID) == Some(&true)
    }

    /// Discover Cursor auth sources from authorized accounts only.
    ///
    /// Legacy local token detection is intentionally not part of the 0.7 Cursor
    /// source model. OAuth accounts are the only supported refreshable source.
    pub fn discover_sources(&self, config: &AppConfig) -> Vec<CursorSource> {
        let mut sources = Vec::new();

        for account in &config.cursor_dashboard_usage.accounts {
            if account.ignored {
                continue;
            }
            if account.auth_status != "active" {
                continue;
            }
            if account.access_token.is_empty() {
                continue;
            }
            let cookie = build_cursor_session_cookie(account.sub.as_str(), &account.access_token);
            let account_name = if !account.email.is_empty() {
                account.email.clone()
            } else if !account.account_hash.is_empty() {
                account.account_hash.clone()
            } else {
                account.auth_id.clone()
            };
            sources.push(CursorSource {
                cookie,
                account_name: account_name.clone(),
                source_name: "authorized".to_string(),
            });
        }

        sources
    }

    /// Fetch usage events from Cursor dashboard API.
    pub async fn fetch_usage(&self, cookie: &str) -> Result<Vec<Value>, String> {
        let client = reqwest::Client::new();
        let now = chrono::Utc::now();
        let scan_start = cursor_scan_start(now);

        let mut all_events = Vec::new();
        let mut page = 1;
        let max_pages = 20;

        while page <= max_pages {
            let body = json!({
                "teamId": 0,
                "startDate": format!("{}", scan_start.timestamp_millis()),
                "endDate": format!("{}", now.timestamp_millis()),
                "page": page,
                "pageSize": 100
            });

            let resp = client
                .post("https://cursor.com/api/dashboard/get-filtered-usage-events")
                .header("Origin", "https://cursor.com")
                .header("Referer", "https://cursor.com/dashboard/usage")
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .header("Cookie", cookie)
                .header("User-Agent", "ai-token-league/0.7.6")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("HTTP error: {}", e))?;

            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status()));
            }

            let data: Value = resp
                .json()
                .await
                .map_err(|e| format!("JSON parse error: {}", e))?;

            let events = data["usageEventsDisplay"]
                .as_array()
                .cloned()
                .unwrap_or_default();

            let total_count = data["totalUsageEventsCount"].as_u64().unwrap_or(0);
            all_events.extend(events);

            if all_events.len() as u64 >= total_count || total_count == 0 {
                break;
            }
            page += 1;
        }

        Ok(all_events)
    }

    /// Parse Cursor API events into usage items.
    pub fn parse_events(&self, events: &[Value], account_name: &str) -> Vec<Value> {
        let mut items = Vec::new();

        for event in events {
            let token_usage = match event.get("tokenUsage") {
                Some(tu) => tu,
                None => continue,
            };

            let input_tokens = token_field(token_usage, &["inputTokens"]);
            let output_tokens = token_field(token_usage, &["outputTokens"]);
            let cache_read_tokens = token_field(token_usage, &["cacheReadTokens"]);
            let cache_write_tokens = token_field(token_usage, &["cacheWriteTokens"]);
            let reasoning_tokens: i64 = 0;
            let total_tokens =
                input_tokens + output_tokens + cache_read_tokens + cache_write_tokens;

            if total_tokens == 0 {
                continue;
            }

            let model = normalize_cursor_model(event["model"].as_str().unwrap_or(""));

            let timestamp = parse_event_timestamp(&event["timestamp"]);
            if timestamp == 0 {
                continue;
            }
            let day = crate::date::local_day_from_timestamp_ms(timestamp);
            let hour = crate::date::local_hour_from_timestamp_ms(timestamp);

            let session_id = format!("cursor-{}", timestamp);

            let workdir_candidate = format!("virtual:cursor-dashboard:Cursor · {}", account_name);

            let token_usage_json = serde_json::to_string(&token_usage).unwrap_or_default();
            let source_fingerprint = sha256_hex(&format!(
                "{}|{}|{}|{}|{}|{}",
                PROVIDER_ID, "dashboard_api", account_name, timestamp, model, token_usage_json
            ));

            items.push(json!({
                "providerId": PROVIDER_ID,
                "providerVersion": VERSION,
                "toolCode": TOOL_CODE,
                "sourceKind": "dashboard_api",
                "sourceQuality": "exact",
                "sessionId": session_id,
                "day": day,
                "hour": hour,
                "workdirCandidate": workdir_candidate,
                "model": model,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "cacheReadTokens": cache_read_tokens,
                "cacheWriteTokens": cache_write_tokens,
                "reasoningTokens": reasoning_tokens,
                "totalTokens": total_tokens,
                "rawSourceRef": account_name,
                "sourceFingerprint": source_fingerprint,
                "parserVersion": VERSION,
            }));
        }

        items
    }
}

fn is_auth_http_error(error: &str) -> bool {
    error == "HTTP 401 Unauthorized" || error == "HTTP 403 Forbidden"
}

fn update_status_after_usage_retry(
    config: &mut AppConfig,
    account_index: usize,
    retry_result: &Result<Vec<Value>, String>,
) {
    if let Err(error) = retry_result {
        if is_auth_http_error(error) {
            if let Some(account) = config
                .cursor_dashboard_usage
                .accounts
                .get_mut(account_index)
            {
                account.auth_status = "reauth_required".to_string();
            }
        }
    }
}

fn parse_event_timestamp(raw: &Value) -> i64 {
    if let Some(value) = raw.as_i64() {
        return timestamp_number_to_millis(value);
    }
    if let Some(value) = raw.as_str() {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(value) {
            return dt.timestamp_millis();
        }
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f") {
            return dt.and_utc().timestamp_millis();
        }
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S") {
            return dt.and_utc().timestamp_millis();
        }
        if let Ok(number) = value.parse::<i64>() {
            return timestamp_number_to_millis(number);
        }
    }
    0
}

fn timestamp_number_to_millis(value: i64) -> i64 {
    if value > 1_000_000_000_000 {
        value
    } else if value > 1_000_000_000 {
        value * 1000
    } else {
        0
    }
}

fn cursor_scan_start(now: chrono::DateTime<chrono::Utc>) -> chrono::DateTime<chrono::Utc> {
    let naive = now.naive_utc();
    let y = naive.year();
    let m = naive.month();
    let (start_y, start_m) = if m == 1 { (y - 1, 12) } else { (y, m - 1) };
    chrono::NaiveDate::from_ymd_opt(start_y, start_m, 1)
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|dt| chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(dt, chrono::Utc))
        .unwrap_or(now)
}

fn normalize_cursor_model(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty() || trimmed == "default" || trimmed == "auto" {
        return "Auto".to_string();
    }
    trimmed.to_string()
}

fn token_field(usage: &Value, aliases: &[&str]) -> i64 {
    for alias in aliases {
        if let Some(n) = usage.get(*alias).and_then(|v| v.as_f64()) {
            if n.is_finite() && n > 0.0 {
                return n.round() as i64;
            }
            return 0;
        }
    }
    0
}

pub fn cursor_token_to_cookie(value: &str) -> String {
    let decoded = urlencoding::decode(value)
        .map(|s| s.to_string())
        .unwrap_or_else(|_| value.to_string());

    if decoded.starts_with("WorkosCursorSessionToken=") {
        return decoded;
    }

    if decoded.contains("::") {
        return format!("WorkosCursorSessionToken={}", urlencoding::encode(&decoded));
    }

    // Try to extract userId from JWT
    if let Some(user_id) = cursor_user_id_from_token(&decoded) {
        let formatted = format!("{}::{}", user_id, decoded);
        return format!(
            "WorkosCursorSessionToken={}",
            urlencoding::encode(&formatted)
        );
    }

    format!("WorkosCursorSessionToken={}", urlencoding::encode(&decoded))
}

/// Build a WorkosCursorSessionToken cookie from sub and access_token.
/// Cursor expects encodeURIComponent(sub + "::" + accessToken).
pub fn build_cursor_session_cookie(sub: &str, access_token: &str) -> String {
    if !sub.is_empty() {
        let raw = format!("{}::{}", sub, access_token);
        format!("WorkosCursorSessionToken={}", urlencoding::encode(&raw))
    } else {
        cursor_token_to_cookie(access_token)
    }
}

fn cursor_user_id_from_token(token: &str) -> Option<String> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload = parts[1].replace('-', "+").replace('_', "/");
    let decoded = BASE64.decode(payload).ok()?;
    let obj: Value = serde_json::from_slice(&decoded).ok()?;
    let sub = obj["sub"].as_str()?;
    let re = regex::Regex::new(r"user_[A-Za-z0-9]+").ok()?;
    re.find(sub).map(|m| m.as_str().to_string())
}

#[derive(Debug, Clone)]
pub struct CursorSource {
    pub cookie: String,
    pub account_name: String,
    pub source_name: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_normalize_cursor_model() {
        assert_eq!(normalize_cursor_model(""), "Auto");
        assert_eq!(normalize_cursor_model("default"), "Auto");
        assert_eq!(normalize_cursor_model("auto"), "Auto");
        assert_eq!(normalize_cursor_model("claude-3-opus"), "claude-3-opus");
        assert_eq!(normalize_cursor_model("  gpt-4  "), "gpt-4");
    }

    #[test]
    fn test_cursor_token_to_cookie() {
        // Already has WorkosCursorSessionToken prefix
        let result = cursor_token_to_cookie("WorkosCursorSessionToken=abc123");
        assert_eq!(result, "WorkosCursorSessionToken=abc123");
    }

    #[test]
    fn test_parse_events() {
        let provider = CursorDashboardProvider;
        let events = vec![
            json!({
                "tokenUsage": {
                    "inputTokens": 100,
                    "outputTokens": 50,
                    "cacheReadTokens": 10,
                    "cacheWriteTokens": 5
                },
                "model": "claude-3-opus",
                "timestamp": 1704067200000_i64
            }),
            json!({
                "tokenUsage": {
                    "inputTokens": 200,
                    "outputTokens": 100,
                    "cacheReadTokens": 20,
                    "cacheWriteTokens": 10
                },
                "model": "grok-4.3",
                "timestamp": "1704067200"
            }),
            json!({
                "tokenUsage": {
                    "inputTokens": 300,
                    "outputTokens": 150,
                    "cacheReadTokens": 30,
                    "cacheWriteTokens": 15
                },
                "model": "gpt-4",
                "timestamp": "2026-05-26T03:22:15.000Z"
            }),
        ];

        let items = provider.parse_events(&events, "test@example.com");
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["inputTokens"], 100);
        assert_eq!(items[0]["totalTokens"], 165);
        assert_eq!(items[0]["model"], "claude-3-opus");
        assert!(items[0]["workdirCandidate"]
            .as_str()
            .unwrap()
            .contains("test@example.com"));
        assert_eq!(
            items[1]["day"].as_str().unwrap(),
            crate::date::local_day_from_timestamp_ms(1704067200000)
        );
        assert_eq!(
            items[2]["hour"].as_u64().unwrap(),
            crate::date::local_hour_from_timestamp_ms(parse_event_timestamp(&json!(
                "2026-05-26T03:22:15.000Z"
            ))) as u64
        );
    }

    #[test]
    fn test_parse_events_skips_unparseable_timestamp() {
        let provider = CursorDashboardProvider;
        let events = vec![
            json!({
                "tokenUsage": { "inputTokens": 100, "outputTokens": 50 },
                "model": "gpt-4",
                "timestamp": "not-a-timestamp"
            }),
            json!({
                "tokenUsage": { "inputTokens": 200, "outputTokens": 100 },
                "model": "claude-3-opus",
                "timestamp": 1704067200000_i64
            }),
        ];

        let items = provider.parse_events(&events, "test@example.com");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["model"], "claude-3-opus");
    }

    #[test]
    fn test_parse_event_timestamp() {
        assert_eq!(
            parse_event_timestamp(&json!(1704067200000_i64)),
            1704067200000
        );
        assert_eq!(parse_event_timestamp(&json!(1704067200_i64)), 1704067200000);
        assert_eq!(
            parse_event_timestamp(&json!("1704067200000")),
            1704067200000
        );
        assert_eq!(parse_event_timestamp(&json!("1704067200")), 1704067200000);
        assert_eq!(
            parse_event_timestamp(&json!("2024-01-01T00:00:00Z")),
            1704067200000
        );
        assert_eq!(parse_event_timestamp(&json!("garbage")), 0);
        assert_eq!(parse_event_timestamp(&json!(null)), 0);
        assert_eq!(parse_event_timestamp(&json!(999)), 0);
    }

    #[test]
    fn test_cursor_scan_start_covers_current_and_previous_calendar_month() {
        let now = chrono::Utc
            .with_ymd_and_hms(2026, 5, 26, 12, 30, 0)
            .single()
            .unwrap();
        let scan_start = cursor_scan_start(now);

        assert_eq!(scan_start.to_rfc3339(), "2026-04-01T00:00:00+00:00");
    }

    #[test]
    fn test_cursor_scan_start_handles_year_boundary() {
        let now = chrono::Utc
            .with_ymd_and_hms(2026, 1, 15, 1, 0, 0)
            .single()
            .unwrap();
        let scan_start = cursor_scan_start(now);

        assert_eq!(scan_start.to_rfc3339(), "2025-12-01T00:00:00+00:00");
    }

    #[test]
    fn test_build_cookie_encodes_complete_auth0_session_value() {
        let sub = "auth0|user_01HPX9ABCDEF";
        let access_token = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzAxSFBYOUFCQ0RFRiJ9.sig";

        let cookie = build_cursor_session_cookie(sub, access_token);
        let expected = format!(
            "WorkosCursorSessionToken={}",
            urlencoding::encode(&format!("{}::{}", sub, access_token))
        );

        assert_eq!(cookie, expected);
        assert!(cookie.contains("auth0%7Cuser_"));
        assert!(cookie.contains("%3A%3A"));
    }

    /// Simulate the full scanner cookie-matching flow with an Auth0 sub.
    /// discover_sources builds cookies via build_cursor_session_cookie (new style).
    /// The scanner's account_cookies map should also use build_cursor_session_cookie.
    /// They must match for reactive refresh to work.
    #[test]
    fn test_cookie_matching_for_auth0_account() {
        use crate::config::{
            AppConfig, CursorAccount, CursorDashboardUsageConfig, LocalBackupConfig,
            SyncStatusRecord,
        };
        use std::collections::HashMap;

        let account = CursorAccount {
            access_token: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhdXRoMHx1c2VyXzAxSFBYOUFCQ0RFRiJ9.sig"
                .into(),
            refresh_token: "rt_mock_jasper".into(),
            auth_id: "auth_abc".into(),
            sub: "auth0|user_01HPX9ABCDEF".into(),
            email: "jasper.cui@example.com".into(),
            account_hash: "hash_jasper".into(),
            access_token_expires_at: Some(
                (chrono::Utc::now() + chrono::Duration::hours(1))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            ),
            last_refresh_at: None,
            auth_status: "active".into(),
            ignored: false,
            added_at: None,
        };

        let mut cfg = AppConfig {
            participant_id: "p_test".into(),
            nickname: "test".into(),
            nickname_auto_generated: false,
            identity_public_key: "pk".into(),
            identity_private_key: "sk".into(),
            device_id: "d_test".into(),
            api_base_url: String::new(),
            language: "zh-CN".into(),
            theme: "light".into(),
            show_estimated_cost: false,
            show_raw_tokens: false,
            auto_refresh_enabled: true,
            silent_update_mode: "auto_download".into(),
            refresh_interval_minutes: 15,
            launch_at_login: false,
            hide_dock_icon: false,
            desktop_auto_initialized: false,
            cursor_dashboard_usage: CursorDashboardUsageConfig {
                workos_session_token: String::new(),
                workos_session_tokens: vec![],
                accounts: vec![account],
            },
            local_backup: LocalBackupConfig::default(),
            runtime_log_retention_days: 3,
            share_card_orientation: "landscape".into(),
            show_share_cloud_url: true,
            show_share_polaroid_frame: true,
            show_share_anonymous_name: true,
            api_connection: json!({}),
            sync_status: SyncStatusRecord::default(),
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
        };
        cfg.provider_enabled.insert(PROVIDER_ID.to_string(), true);

        let provider = CursorDashboardProvider;

        // discover_sources uses build_cursor_session_cookie
        let sources = provider.discover_sources(&cfg);
        assert_eq!(sources.len(), 1, "one active account → one source");
        let source_cookie = &sources[0].cookie;

        // Scanner's account_cookies map (now also uses build_cursor_session_cookie)
        let account_cookies: Vec<(String, usize)> = cfg
            .cursor_dashboard_usage
            .accounts
            .iter()
            .enumerate()
            .map(|(i, acc)| (build_cursor_session_cookie(&acc.sub, &acc.access_token), i))
            .collect();

        // The lookup must succeed
        let idx = account_cookies
            .iter()
            .find(|(c, _)| c == source_cookie)
            .map(|(_, i)| *i);
        assert_eq!(
            idx,
            Some(0),
            "cookie lookup must match for reactive refresh"
        );
    }

    #[test]
    fn discover_sources_skips_accounts_requiring_reauth() {
        let mut cfg = crate::config::init_config(json!({}), false);
        cfg.cursor_dashboard_usage
            .accounts
            .push(crate::config::CursorAccount {
                access_token: "at".into(),
                refresh_token: "rt".into(),
                auth_id: "auth".into(),
                sub: "auth0|user".into(),
                email: "user@example.com".into(),
                account_hash: "hash".into(),
                access_token_expires_at: None,
                last_refresh_at: None,
                auth_status: "reauth_required".into(),
                ignored: false,
                added_at: None,
            });

        assert!(CursorDashboardProvider.discover_sources(&cfg).is_empty());
    }

    #[test]
    fn retry_unauthorized_marks_account_for_reauth() {
        let mut cfg = crate::config::init_config(json!({}), false);
        cfg.cursor_dashboard_usage
            .accounts
            .push(crate::config::CursorAccount {
                access_token: "new-at".into(),
                refresh_token: "rt".into(),
                auth_id: "auth".into(),
                sub: "auth0|user".into(),
                email: "user@example.com".into(),
                account_hash: "hash".into(),
                access_token_expires_at: None,
                last_refresh_at: None,
                auth_status: "active".into(),
                ignored: false,
                added_at: None,
            });

        let retry_result = Err("HTTP 401 Unauthorized".to_string());
        update_status_after_usage_retry(&mut cfg, 0, &retry_result);

        assert_eq!(
            cfg.cursor_dashboard_usage.accounts[0].auth_status,
            "reauth_required"
        );
    }
}
