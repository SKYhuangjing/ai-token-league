// Zhipu GLM Coding Plan usage query (optional module #2, query type).
//
// Contract verified against the zhipu-usage skill:
//   GET {base}/api/monitor/usage/quota/limit
//   Authorization: <bare key>            (no Bearer prefix)
//   optional team mode: ?type=2 + bigmodel-organization/bigmodel-project headers
//   response: { level, limits: [{ unit, type, percentage, nextResetTime(ms),
//                                 usageDetails: [{ modelCode, usage }] }] }
//   unit == 3 is the 5-hour window; the weekly window carries another unit.
//
// Keys are user-managed (module config: label + API key, R22) — no local tool
// config discovery. The endpoint base is resolved per key by trying the
// domestic open.bigmodel.cn first, then the international api.z.ai. A single
// key failing (e.g. no coding plan) never fails the whole query.

use serde_json::{json, Value};

pub const DOMESTIC_BASE: &str = "https://open.bigmodel.cn";
pub const INTERNATIONAL_BASE: &str = "https://api.z.ai";

pub struct ZhipuKey {
    pub label: String,
    pub key: String,
}

/// Normalize the raw quota response into the module UI shape. The live API
/// wraps the payload in `{code, msg, success, data}` — unwrap `data` when
/// present; the flat shape stays supported for tests and older fixtures.
///
/// Window parsing mirrors cc-switch's battle-tested semantics
/// (services/coding_plan.rs::parse_zhipu_token_tiers, live-verified through
/// 2026-09 + issue #3036):
/// - only `TOKENS_LIMIT`/`CREDIT_LIMIT` entries are token windows; other
///   types (e.g. TIME_LIMIT) are dropped — live TIME_LIMIT rows carried
///   weekly-horizon resets and mislabeled as 5h in earlier revisions;
/// - `unit` is the only classification anchor: 3 = 5h, 6 = weekly;
/// - unknown-unit entries fall back to a heuristic: no-reset entries fill
///   the 5h slot first, the rest fill by ascending reset. Never classify by
///   reset order alone — at period end the weekly window resets BEFORE the
///   5h window, so time sorting swaps the two buckets;
/// - old plans (pre-2026-02) return a single entry → 5h-only is valid.
pub fn parse_quota(raw: &Value) -> Result<Value, String> {
    if raw.get("success").and_then(|v| v.as_bool()) == Some(false) {
        let msg = raw.get("msg").and_then(|v| v.as_str()).unwrap_or("unknown");
        return Err(format!("api error: {}", msg));
    }
    let payload = raw.get("data").filter(|v| v.is_object()).unwrap_or(raw);
    let limits = payload.get("limits").and_then(|v| v.as_array());

    let window_json = |window: &str, item: &Value| -> Value {
        let unit = item.get("unit").and_then(|v| v.as_u64());
        let reset_ms = item.get("nextResetTime").and_then(|v| v.as_i64());
        let details: serde_json::Map<String, Value> = item
            .get("usageDetails")
            .and_then(|v| v.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|d| {
                        let code = d.get("modelCode").and_then(|v| v.as_str())?;
                        let usage = d.get("usage").cloned().unwrap_or(Value::Null);
                        Some((code.to_string(), usage))
                    })
                    .collect()
            })
            .unwrap_or_default();
        json!({
            "window": window,
            "unit": unit,
            "kind": item.get("type").cloned().unwrap_or(Value::Null),
            "pct": item.get("percentage"),
            "resetMs": reset_ms,
            "resetIso": reset_ms
                .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms))
                .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
            "details": details,
        })
    };

    type Entry<'a> = (Option<i64>, &'a Value);
    let mut five_hour: Option<Entry> = None;
    let mut weekly: Option<Entry> = None;
    let mut unclassified: Vec<Entry> = Vec::new();
    if let Some(limits) = limits {
        for item in limits {
            let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if !kind.eq_ignore_ascii_case("TOKENS_LIMIT") && !kind.eq_ignore_ascii_case("CREDIT_LIMIT") {
                continue;
            }
            let reset_ms = item.get("nextResetTime").and_then(|v| v.as_i64());
            match item.get("unit").and_then(|v| v.as_i64()) {
                Some(3) if five_hour.is_none() => five_hour = Some((reset_ms, item)),
                Some(6) if weekly.is_none() => weekly = Some((reset_ms, item)),
                _ => unclassified.push((reset_ms, item)),
            }
        }
    }
    unclassified.sort_by_key(|(reset, _)| (reset.is_some(), reset.unwrap_or(i64::MIN)));
    for entry in unclassified {
        if five_hour.is_none() {
            five_hour = Some(entry);
        } else if weekly.is_none() {
            weekly = Some(entry);
        }
    }

    let mut windows: Vec<Value> = Vec::new();
    if let Some((_, item)) = five_hour {
        windows.push(window_json("five_hour", item));
    }
    if let Some((_, item)) = weekly {
        windows.push(window_json("weekly", item));
    }
    Ok(json!({ "tier": payload.get("level").cloned().unwrap_or(Value::Null), "windows": windows }))
}

/// Query one key against one base. `org`/`project` enable the team-mode endpoint.
pub fn fetch_quota(base: &str, key: &str, org: Option<&str>, project: Option<&str>) -> Result<Value, String> {
    let mut url = format!("{}/api/monitor/usage/quota/limit", base);
    if org.is_some() || project.is_some() {
        url.push_str("?type=2");
    }
    let mut request = reqwest::blocking::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(15))
        .header("Authorization", key); // zhipu wants the bare key, no Bearer
    if let Some(org) = org {
        request = request.header("bigmodel-organization", org);
    }
    if let Some(project) = project {
        request = request.header("bigmodel-project", project);
    }
    let response = request.send().map_err(|e| format!("request failed: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let raw: Value = response.json().map_err(|e| format!("invalid response: {}", e))?;
    let parsed = parse_quota(&raw)?;
    // A 200 without tier/limits is the "key has no coding plan" shape — the
    // python skill treats it as a per-key failure, so mirror that semantics.
    if parsed["windows"].as_array().map(|w| w.is_empty()).unwrap_or(true) && parsed["tier"].is_null() {
        return Err("no plan data (key not subscribed to a coding plan?)".into());
    }
    Ok(parsed)
}

/// Query one user-managed key, resolving the endpoint base automatically:
/// domestic first, international as fallback. On total failure the domestic
/// error wins (it is the common case worth reporting).
pub fn fetch_quota_auto(key: &str, org: Option<&str>, project: Option<&str>) -> Result<(String, Value), String> {
    match fetch_quota(DOMESTIC_BASE, key, org, project) {
        Ok(quota) => Ok((DOMESTIC_BASE.to_string(), quota)),
        Err(domestic_err) => match fetch_quota(INTERNATIONAL_BASE, key, org, project) {
            Ok(quota) => Ok((INTERNATIONAL_BASE.to_string(), quota)),
            Err(_) => Err(domestic_err),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_quota_normalizes_windows() {
        let raw = json!({
            "level": "LitePro",
            "limits": [
                // TIME_LIMIT is not a token window — must be dropped even with
                // plausible unit numbers (live TIME_LIMIT rows carried weekly
                // resets and were mislabeled as 5h before the cc-switch align)
                { "unit": 5, "type": "TIME_LIMIT", "percentage": 16, "nextResetTime": 1795425600000i64 },
                { "unit": 3, "type": "TOKENS_LIMIT", "percentage": 42, "nextResetTime": 1789280000000i64,
                  "usageDetails": [{ "modelCode": "glm-4.6", "usage": 1234 }] },
                { "unit": 6, "type": "TOKENS_LIMIT", "percentage": 17, "nextResetTime": 1789700000000i64, "usageDetails": [] }
            ]
        });
        let parsed = parse_quota(&raw).unwrap();
        assert_eq!(parsed["tier"], "LitePro");
        let windows = parsed["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0]["window"], "five_hour");
        assert_eq!(windows[0]["kind"], "TOKENS_LIMIT");
        assert_eq!(windows[0]["pct"], 42);
        assert!(windows[0]["resetIso"].is_string());
        assert_eq!(windows[0]["details"]["glm-4.6"], 1234);
        assert_eq!(windows[1]["window"], "weekly");
        assert_eq!(windows[1]["pct"], 17);
    }

    #[test]
    fn parse_quota_unknown_unit_falls_back_to_heuristic() {
        // Unknown unit with a reset + a no-reset entry without a unit: the
        // no-reset entry takes the 5h slot first, the reset-bearing one fills
        // weekly (cc-switch heuristic — never classify by reset order alone).
        let raw = json!({
            "level": "LitePro",
            "limits": [
                { "type": "TOKENS_LIMIT", "unit": 9, "percentage": 61, "nextResetTime": 1789700000000i64 },
                { "type": "TOKENS_LIMIT", "percentage": 7 }
            ]
        });
        let parsed = parse_quota(&raw).unwrap();
        let windows = parsed["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0]["window"], "five_hour");
        assert_eq!(windows[0]["pct"], 7);
        assert_eq!(windows[1]["window"], "weekly");
        assert_eq!(windows[1]["unit"], 9);
        assert_eq!(windows[1]["pct"], 61);
    }

    #[test]
    fn parse_quota_unwraps_live_data_envelope() {
        // Fixture mirrors the live response of
        // GET /api/monitor/usage/quota/limit (2026-09): payload sits under
        // "data"; the flat shape from parse_quota_normalizes_windows must
        // keep working alongside it.
        let raw = json!({
            "code": 200, "msg": "操作成功", "success": true,
            "data": {
                "limits": [
                    { "type": "TIME_LIMIT", "unit": 5, "number": 1, "usage": 100, "currentValue": 0,
                      "remaining": 100, "percentage": 0, "nextResetTime": 1791517550999i64,
                      "usageDetails": [
                        { "modelCode": "search-prime", "usage": 0 },
                        { "modelCode": "web-reader", "usage": 0 },
                        { "modelCode": "zread", "usage": 0 }
                      ] },
                    { "type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 1,
                      "nextResetTime": 1789303845233i64 }
                ],
                "level": "lite"
            }
        });
        let parsed = parse_quota(&raw).unwrap();
        assert_eq!(parsed["tier"], "lite");
        // Old-plan shape: the only token window is TOKENS_LIMIT unit 3 — the
        // TIME_LIMIT row (with its usageDetails) is dropped, leaving a single
        // 5h window. Single-window degradation is valid for old plans.
        let windows = parsed["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0]["window"], "five_hour");
        assert_eq!(windows[0]["unit"], 3);
        assert_eq!(windows[0]["kind"], "TOKENS_LIMIT");
        assert_eq!(windows[0]["pct"], 1);
    }

    #[test]
    fn parse_quota_surfaces_api_error_message() {
        let parsed = parse_quota(&json!({ "code": 401, "msg": "令牌不存在", "success": false }));
        let err = parsed.unwrap_err();
        assert!(err.contains("令牌不存在"), "unexpected error: {}", err);
    }

    #[test]
    fn parse_quota_tolerates_empty() {
        let parsed = parse_quota(&json!({})).unwrap();
        assert!(parsed["windows"].as_array().unwrap().is_empty());
        assert!(parsed["tier"].is_null());
    }
}
