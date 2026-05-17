use crate::config::AppConfig;
use crate::crypto::sha256_hex;
use crate::provider::common::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Datelike;
use serde_json::{json, Value};
use std::collections::HashMap;

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
    pub fn version(&self) -> &str {
        VERSION
    }

    pub fn is_enabled(&self, config: &AppConfig) -> bool {
        config.provider_enabled.get(PROVIDER_ID) == Some(&true)
    }

    /// Discover Cursor auth sources from config, local installation, and cockpit accounts.
    pub fn discover_sources(&self, config: &AppConfig) -> Vec<CursorSource> {
        let mut sources = Vec::new();

        // Configured tokens
        for record in &config.cursor_dashboard_usage.workos_session_tokens {
            if !record.token.is_empty() {
                let cookie = cursor_token_to_cookie(&record.token);
                let account_name = if !record.account_name.is_empty() {
                    record.account_name.clone()
                } else {
                    cursor_account_name_from_token(&record.token)
                };
                sources.push(CursorSource {
                    cookie,
                    account_name: account_name.clone(),
                    source_name: "config".to_string(),
                    name_score: source_name_score(&account_name),
                });
            }
        }

        // Local Cursor installation
        if let Ok(local_sources) = discover_local_cursor_sources() {
            sources.extend(local_sources);
        }

        // Antigravity cockpit accounts
        if let Ok(cockpit_sources) = discover_cockpit_accounts() {
            sources.extend(cockpit_sources);
        }

        dedupe_sources(sources)
    }

    /// Fetch usage events from Cursor dashboard API.
    pub async fn fetch_usage(&self, cookie: &str) -> Result<Vec<Value>, String> {
        let client = reqwest::Client::new();
        let now = chrono::Utc::now();
        let start_of_month = {
            let naive = now.naive_utc();
            let y = naive.year();
            let m = naive.month();
            chrono::NaiveDate::from_ymd_opt(y, m, 1)
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .map(|dt| {
                    chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(dt, chrono::Utc)
                })
                .unwrap_or(now)
        };

        let mut all_events = Vec::new();
        let mut page = 1;
        let max_pages = 20;

        while page <= max_pages {
            let body = json!({
                "teamId": 0,
                "startDate": format!("{}", start_of_month.timestamp_millis()),
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
                .header("User-Agent", "AI Token League")
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

            let timestamp = event["timestamp"].as_i64().unwrap_or(0);
            let day = if timestamp > 0 {
                crate::date::local_day_from_timestamp_ms(timestamp)
            } else {
                crate::date::local_day()
            };
            let hour = if timestamp > 0 {
                crate::date::local_hour_from_timestamp_ms(timestamp)
            } else {
                0u32
            };

            let session_id = format!(
                "cursor-{}",
                if timestamp > 0 {
                    timestamp.to_string()
                } else {
                    "unknown".to_string()
                }
            );

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

fn cursor_token_to_cookie(value: &str) -> String {
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

fn cursor_account_name_from_token(token: &str) -> String {
    token.split("::").next().unwrap_or("Cursor").to_string()
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

fn source_name_score(name: &str) -> i32 {
    if name.contains('@') {
        3
    } else if !name.is_empty() && !name.starts_with("user_") && name != "Cursor" {
        2
    } else if !name.is_empty() {
        1
    } else {
        0
    }
}

#[derive(Debug, Clone)]
pub struct CursorSource {
    pub cookie: String,
    pub account_name: String,
    pub source_name: String,
    pub name_score: i32,
}

fn dedupe_sources(sources: Vec<CursorSource>) -> Vec<CursorSource> {
    // Dedupe by cookie, keep higher score
    let mut by_cookie: HashMap<String, CursorSource> = HashMap::new();
    for s in sources {
        match by_cookie.get_mut(&s.cookie) {
            Some(existing) => {
                if s.name_score > existing.name_score {
                    *existing = s;
                }
            }
            None => {
                by_cookie.insert(s.cookie.clone(), s);
            }
        }
    }

    // Dedupe by account name (lowercased), keep higher score
    let mut by_account: HashMap<String, CursorSource> = HashMap::new();
    for s in by_cookie.into_values() {
        let key = s.account_name.to_lowercase();
        match by_account.get_mut(&key) {
            Some(existing) => {
                if s.name_score > existing.name_score {
                    *existing = s;
                }
            }
            None => {
                by_account.insert(key, s);
            }
        }
    }

    by_account.into_values().collect()
}

/// Read Cursor auth token from local SQLite state DB.
fn read_token_from_cursor_sqlite() -> Option<(String, String)> {
    let home = dirs::home_dir()?;
    let db_path = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Cursor/User/globalStorage/state.vscdb")
    } else if cfg!(target_os = "windows") {
        home.join("AppData/Roaming/Cursor/User/globalStorage/state.vscdb")
    } else {
        home.join(".config/Cursor/User/globalStorage/state.vscdb")
    };

    if !db_path.exists() {
        return None;
    }

    let conn =
        rusqlite::Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;

    let token: String = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'",
            [],
            |row| row.get(0),
        )
        .ok()?;

    let email: String = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key IN ('cursorAuth/cachedEmail','cursorAuth/email') LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap_or_default();

    Some((token, email))
}

fn discover_local_cursor_sources() -> Result<Vec<CursorSource>, String> {
    let mut sources = Vec::new();

    // SQLite
    if let Some((token, email)) = read_token_from_cursor_sqlite() {
        let user_id = cursor_user_id_from_token(&token);
        let account_name = if !email.is_empty() {
            email
        } else {
            user_id.clone().unwrap_or_default()
        };
        let cookie_val = if let Some(uid) = user_id {
            format!("{}::{}", uid, token)
        } else {
            token
        };
        let cookie = cursor_token_to_cookie(&cookie_val);
        sources.push(CursorSource {
            cookie,
            account_name,
            source_name: "local_cursor_sqlite".to_string(),
            name_score: 2,
        });
    }

    // JSON config files
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Ok(sources),
    };

    let config_paths: Vec<std::path::PathBuf> = if cfg!(target_os = "macos") {
        vec![
            home.join("Library/Application Support/Cursor/User/globalStorage/storage.json"),
            home.join(".cursor/config.json"),
            home.join("Library/Application Support/Cursor/config.json"),
        ]
    } else if cfg!(target_os = "windows") {
        vec![
            home.join("AppData/Roaming/Cursor/User/globalStorage/storage.json"),
            home.join(".cursor/config.json"),
            home.join("AppData/Roaming/Cursor/config.json"),
        ]
    } else {
        vec![
            home.join(".config/Cursor/User/globalStorage/storage.json"),
            home.join(".cursor/config.json"),
            home.join(".config/Cursor/config.json"),
        ]
    };

    for path in config_paths {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(obj) = serde_json::from_str::<Value>(&content) {
                let token_keys = [
                    "cursorAuth/accessToken",
                    "accessToken",
                    "sessionToken",
                    "WorkosCursorSessionToken",
                ];
                for key in &token_keys {
                    let token = deep_find_string(&obj, &[*key]);
                    if !token.is_empty() {
                        {
                            let cookie = cursor_token_to_cookie(&token);
                            let account_name = cursor_account_name_from_token(&token);
                            sources.push(CursorSource {
                                cookie,
                                account_name,
                                source_name: "local_cursor_config".to_string(),
                                name_score: 1,
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(sources)
}

fn discover_cockpit_accounts() -> Result<Vec<CursorSource>, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let accounts_dir = home.join(".antigravity_cockpit/cursor_accounts");
    if !accounts_dir.exists() {
        return Ok(vec![]);
    }

    let mut sources = Vec::new();
    let entries = std::fs::read_dir(&accounts_dir).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e == "json").unwrap_or(false) {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(account) = serde_json::from_str::<Value>(&content) {
                    let access_token = account["access_token"].as_str().unwrap_or("").to_string();
                    if access_token.is_empty() {
                        continue;
                    }
                    let user_id = account["id"]
                        .as_str()
                        .or_else(|| account["auth_id"].as_str())
                        .unwrap_or("")
                        .to_string();
                    let email = account["email"]
                        .as_str()
                        .or_else(|| account["cachedEmail"].as_str())
                        .unwrap_or(&user_id)
                        .to_string();

                    let cookie_val = format!("{}::{}", user_id, access_token);
                    let cookie = cursor_token_to_cookie(&cookie_val);

                    sources.push(CursorSource {
                        cookie,
                        account_name: email,
                        source_name: "cockpit".to_string(),
                        name_score: 3,
                    });
                }
            }
        }
    }

    Ok(sources)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn test_cursor_account_name_from_token() {
        assert_eq!(
            cursor_account_name_from_token("user_123::token_value"),
            "user_123"
        );
    }

    #[test]
    fn test_source_name_score() {
        assert_eq!(source_name_score("user@example.com"), 3);
        assert_eq!(source_name_score("user_123"), 1);
        assert_eq!(source_name_score("Cursor"), 1);
        assert_eq!(source_name_score(""), 0);
        assert_eq!(source_name_score("myaccount"), 2);
    }

    #[test]
    fn test_parse_events() {
        let provider = CursorDashboardProvider;
        let events = vec![json!({
            "tokenUsage": {
                "inputTokens": 100,
                "outputTokens": 50,
                "cacheReadTokens": 10,
                "cacheWriteTokens": 5
            },
            "model": "claude-3-opus",
            "timestamp": 1704067200000_i64
        })];

        let items = provider.parse_events(&events, "test@example.com");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["inputTokens"], 100);
        assert_eq!(items[0]["totalTokens"], 165);
        assert_eq!(items[0]["model"], "claude-3-opus");
        assert!(items[0]["workdirCandidate"]
            .as_str()
            .unwrap()
            .contains("test@example.com"));
    }
}
