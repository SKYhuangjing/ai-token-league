// Sidecar-facing glue for the zhipu plugin: the query runtime (60s cache +
// shared tray state), the modules.json gate, and the tray menu rows.
// Moved verbatim from the sidecar in R25 so the platform keeps no zhipu
// logic; the sidecar only orchestrates (async spawn, payload shape).

use crate::quota;
use crate::tray_state;
use serde_json::{json, Value};
use std::sync::Mutex;

/// 60s dedupe window: the card auto-queries on plugin-screen entry and on
/// every ATL scan cycle, so back-to-back triggers must not hit the quota API.
const QUERY_CACHE_MS: i64 = 60_000;

pub struct QueryCache {
    pub fingerprint: String,
    pub at_ms: i64,
    pub data: Value,
}

struct Runtime {
    state: tray_state::ZhipuTrayState,
    pending_alerts: Vec<tray_state::ThresholdAlert>,
    cache: Option<QueryCache>,
}

static RUNTIME: std::sync::OnceLock<Mutex<Runtime>> = std::sync::OnceLock::new();

fn runtime() -> &'static Mutex<Runtime> {
    RUNTIME.get_or_init(|| {
        Mutex::new(Runtime {
            state: tray_state::ZhipuTrayState::new(),
            pending_alerts: Vec::new(),
            cache: None,
        })
    })
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Zhipu usage query over user-managed keys (module config: label + key,
/// R22 — no local tool config discovery). Runs on a blocking thread —
/// reqwest::blocking must not live in async context.
pub fn query_blocking(args: &Value) -> Value {
    let org = args.get("orgId").and_then(|v| v.as_str()).map(|s| s.to_string());
    let project = args.get("projectId").and_then(|v| v.as_str()).map(|s| s.to_string());
    let keys: Vec<quota::ZhipuKey> = args
        .get("keys")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|k| {
                    let key = k.get("apiKey").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                    if key.is_empty() {
                        return None;
                    }
                    Some(quota::ZhipuKey {
                        label: k.get("label").and_then(|v| v.as_str()).unwrap_or("").trim().to_string(),
                        key,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let results: Vec<Value> = keys
        .iter()
        .map(|k| match quota::fetch_quota_auto(&k.key, org.as_deref(), project.as_deref()) {
            Ok((base, parsed)) => json!({ "label": k.label, "base": base, "ok": true, "quota": parsed }),
            Err(e) => json!({ "label": k.label, "ok": false, "error": e }),
        })
        .collect();
    json!({ "keyCount": keys.len(), "results": results })
}

/// Build query args from the modules state (user-managed keys) for the
/// tray-side refresh, which runs without a renderer to pass them in.
/// Indexing a missing path yields Value::Null — exactly the "no keys" shape.
pub fn query_args_from_modules(modules_state: &Value) -> Value {
    let keys = modules_state["modules"]["zhipu-plan"]["config"]["keys"].clone();
    json!({ "keys": keys })
}

/// Installed = a modules.json entry exists and is enabled. Never-installed
/// (no entry) and uninstalled (enabled:false) both count as NOT installed —
/// commands refuse and the tray section stays dark (R27 review finding).
pub fn installed(modules_state: &Value) -> bool {
    let entry = &modules_state["modules"]["zhipu-plan"];
    entry.is_object() && entry.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true)
}

/// (section_on, alerts_on): installed plus the per-plugin "menubar"/"alerts"
/// config toggles (default on).
pub fn gate(modules_state: &Value) -> (bool, bool) {
    let entry = &modules_state["modules"]["zhipu-plan"];
    let enabled = installed(modules_state);
    let cfg = entry.get("config");
    let menubar = cfg.and_then(|c| c.get("menubar")).and_then(|v| v.as_bool()).unwrap_or(true);
    let alerts = cfg.and_then(|c| c.get("alerts")).and_then(|v| v.as_bool()).unwrap_or(true);
    (enabled && menubar, enabled && alerts)
}

/// Cached zhipu-plan:usage — `force` (manual refresh / key-list change) bypasses.
/// Feeds the shared tray state so menu rows and threshold alerts stay in sync
/// with whatever the card last saw; runs on a blocking thread.
pub fn usage_cached(args: &Value, alerts_on: bool) -> Value {
    let now = now_millis();
    let force = args.get("force").and_then(|v| v.as_bool()) == Some(true);
    let fingerprint = args.get("keys").cloned().unwrap_or(Value::Null).to_string();
    if !force {
        if let Ok(guard) = runtime().lock() {
            if let Some(cache) = &guard.cache {
                if cache.fingerprint == fingerprint && now - cache.at_ms < QUERY_CACHE_MS {
                    return cache.data.clone();
                }
            }
        }
    }
    // Stamp the fetch time once; the cached clone keeps it, so a later cache
    // hit reports when the quota API was actually hit (data freshness for the
    // card's "refreshed N min ago" display).
    let mut data = query_blocking(args);
    data["fetchedAt"] = serde_json::json!(now);
    ingest_query(&data, now, alerts_on, Some((fingerprint, data.clone())));
    data
}

/// Ingest a query result: a keyCount==0 (no keys configured) result only
/// refreshes the cache — it must not count as a tray observation, or wiping
/// keys would silently reset the alert baseline (R27 review finding).
fn ingest_query(data: &Value, now_ms: i64, alerts_on: bool, cache: Option<(String, Value)>) {
    let empty = data.get("keyCount").and_then(|v| v.as_u64()).unwrap_or(0) == 0;
    if empty {
        if let Some((fingerprint, payload)) = cache {
            if let Ok(mut guard) = runtime().lock() {
                guard.cache = Some(QueryCache { fingerprint, at_ms: now_ms, data: payload });
            }
        }
        return;
    }
    note_success(data, now_ms, alerts_on, cache);
}

/// Ingest a fresh query: update the shared tray state, queue threshold
/// alerts (when enabled), and refresh the 60s cache.
pub fn note_success(data: &Value, now_ms: i64, alerts_on: bool, cache: Option<(String, Value)>) {
    if let Ok(mut guard) = runtime().lock() {
        let crossed = guard.state.ingest_success(data, now_ms);
        if alerts_on {
            guard.pending_alerts.extend(crossed);
        }
        if let Some((fingerprint, payload)) = cache {
            guard.cache = Some(QueryCache { fingerprint, at_ms: now_ms, data: payload });
        }
    }
}

pub fn due_refresh(now_ms: i64) -> bool {
    runtime().lock().map(|g| g.state.due_refresh(now_ms)).unwrap_or(false)
}

/// Query + ingest for the tray-side refresh (no renderer involved).
pub fn refresh_and_cache(args: &Value, now_ms: i64, alerts_on: bool) -> Value {
    let mut data = query_blocking(args);
    data["fetchedAt"] = serde_json::json!(now_ms);
    let fingerprint = args.get("keys").cloned().unwrap_or(Value::Null).to_string();
    ingest_query(&data, now_ms, alerts_on, Some((fingerprint, data.clone())));
    data
}

fn tray_item_action(id: &str, label: String, action: &str) -> Value {
    json!({ "id": id, "label": label, "action": action })
}

fn tray_item_disabled(id: &str, label: String) -> Value {
    json!({ "id": id, "label": label, "disabled": true, "action": "noop" })
}

fn tray_t(lang: &str, key: &str, params: &[(&str, String)]) -> String {
    let mut text = match (lang, key) {
        ("en", "tray.zhipuHeader") => "GLM plan usage",
        ("en", "tray.zhipuKey") => "{dot} {name} {pct}%",
        ("en", "tray.zhipuFail") => "Zhipu key query failed",
        ("en", "tray.zhipuNoKeys") => "Add a Zhipu key in the app",
        ("en", "tray.zhipuMore") => "+{n} more",
        ("en", "tray.zhipuAlertWarnTitle") => "GLM plan warning",
        ("en", "tray.zhipuAlertCritTitle") => "GLM plan critical",
        ("en", "tray.zhipuAlertBody") => "{name} · {window} window {pct}% used",
        (_, "tray.zhipuHeader") => "GLM 套餐用量",
        (_, "tray.zhipuKey") => "{dot} {name} {pct}%",
        (_, "tray.zhipuFail") => "智谱 Key 查询失败",
        (_, "tray.zhipuNoKeys") => "打开 App 添加智谱 Key",
        (_, "tray.zhipuMore") => "还有 {n} 把 Key",
        (_, "tray.zhipuAlertWarnTitle") => "GLM 用量预警",
        (_, "tray.zhipuAlertCritTitle") => "GLM 用量危急",
        (_, "tray.zhipuAlertBody") => "{name} · {window}窗口已用 {pct}%",
        (_, _) => key,
    }
    .to_string();
    for (name, value) in params {
        text = text.replace(&format!("{{{}}}", name), value);
    }
    text
}

fn tray_dot(pct: f64) -> &'static str {
    tray_state::usage_dot(pct)
}

/// Module section items for the tray menu (inserted before "quit" by the
/// host). Minimal by design (R22): `{dot} {name} {pct}%` per key — tier,
/// window label, reset times, refresh action and the updated/footer chrome
/// live in the app card instead. The number is the 5h window (consensus
/// badge semantics; keys without one fall back to their only window); the
/// dot follows the card ladder 🟢<70/🟠≥70/🔴≥90 judged across ALL windows of the key.
/// Usage rows stay enabled so macOS does not paint the reading gray.
pub fn menu_items(lang: &str) -> Vec<Value> {
    let mut items = vec![
        json!({ "type": "separator" }),
        tray_item_disabled("zhipu-header", tray_t(lang, "tray.zhipuHeader", &[])),
    ];
    let guard = match runtime().lock() {
        Ok(g) => g,
        Err(_) => return items,
    };
    let data = guard.state.last_data();
    let has_any_key = data.map(|d| d.get("keyCount").and_then(|v| v.as_u64()).unwrap_or(0) > 0).unwrap_or(false);
    if !has_any_key {
        items.push(tray_item_action("zhipu-nokeys", tray_t(lang, "tray.zhipuNoKeys", &[]), "open"));
        return items;
    }

    let mut ok_results: Vec<&Value> = data
        .and_then(|d| d.get("results").and_then(|v| v.as_array()))
        .map(|list| list.iter().filter(|r| r.get("ok").and_then(|v| v.as_bool()) == Some(true)).collect())
        .unwrap_or_default();
    if ok_results.is_empty() {
        items.push(tray_item_disabled("zhipu-failed", tray_t(lang, "tray.zhipuFail", &[])));
        return items;
    }

    let shown = ok_results.split_off(ok_results.len().min(3));
    for (index, result) in ok_results.iter().enumerate() {
        let raw_label = result.get("label").and_then(|v| v.as_str()).unwrap_or("");
        let name = tray_state::display_key_label(raw_label, index, lang);
        let quota = result.get("quota").cloned().unwrap_or(Value::Null);
        let mut key_max = f64::NEG_INFINITY;
        let mut pct_shown: Option<f64> = None;
        for window in quota.get("windows").and_then(|v| v.as_array()).into_iter().flatten() {
            let pct = window.get("pct").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if pct > key_max {
                key_max = pct;
            }
            match window.get("window").and_then(|v| v.as_str()) {
                Some("five_hour") if pct_shown.is_none() => pct_shown = Some(pct),
                Some("weekly") if pct_shown.is_none() => pct_shown = Some(pct),
                _ => {}
            }
        }
        let pct = pct_shown.unwrap_or(key_max.max(0.0));
        items.push(tray_item_action(&format!("zhipu-key-{}", index), tray_t(lang, "tray.zhipuKey", &[
            ("dot", tray_dot(key_max).to_string()),
            ("name", name),
            ("pct", format!("{}", pct.round() as i64)),
        ]), "noop"));
    }
    if !shown.is_empty() {
        items.push(tray_item_disabled("zhipu-more", tray_t(lang, "tray.zhipuMore", &[("n", shown.len().to_string())])));
    }
    items
}

/// Drain queued threshold crossings into localizable notification payloads
/// for the host to deliver via the native notification plugin.
pub fn drain_alerts(lang: &str) -> Vec<Value> {
    let mut guard = match runtime().lock() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    guard
        .pending_alerts
        .drain(..)
        .map(|a| {
            let window_label = if a.window == "weekly" {
                if lang == "en" { "weekly" } else { "每周" }
            } else if lang == "en" {
                "5-hour"
            } else {
                "5 小时"
            };
            let name = tray_state::display_key_label(&a.key, 0, lang);
            json!({
                "level": a.level,
                "pct": a.pct,
                "title": if a.level >= 90 {
                    tray_t(lang, "tray.zhipuAlertCritTitle", &[])
                } else {
                    tray_t(lang, "tray.zhipuAlertWarnTitle", &[])
                },
                "body": tray_t(lang, "tray.zhipuAlertBody", &[
                    ("name", name),
                    ("window", window_label.to_string()),
                    ("pct", format!("{}", a.pct.round() as i64)),
                ]),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_requires_installed_entry() {
        // never-installed: no entry at all → off
        assert_eq!(gate(&json!({ "modules": {} })), (false, false));
        // uninstalled: entry exists but disabled → off
        assert_eq!(gate(&json!({ "modules": { "zhipu-plan": { "enabled": false, "config": {} } } })), (false, false));
        // installed + enabled → both on
        let on_state = json!({ "modules": { "zhipu-plan": { "enabled": true, "config": {} } } });
        assert!(installed(&on_state));
        assert_eq!(gate(&on_state), (true, true));
        // per-plugin toggles win over the defaults
        assert_eq!(gate(&json!({ "modules": { "zhipu-plan": { "enabled": true, "config": { "menubar": false, "alerts": true } } } })), (false, true));
    }

    #[test]
    fn query_args_read_keys_from_modules_state() {
        let args = query_args_from_modules(&json!({
            "modules": { "zhipu-plan": { "config": { "keys": [ { "label": "a", "apiKey": "k" } ] } } }
        }));
        assert_eq!(args["keys"].as_array().unwrap().len(), 1);
        // missing path → Null, the "no keys" shape
        let empty = query_args_from_modules(&json!({ "modules": {} }));
        assert!(empty["keys"].is_null());
    }

    #[test]
    fn query_blocking_skips_blank_keys() {
        // blank-only key lists never hit the network
        let data = query_blocking(&json!({ "keys": [ { "label": "blank", "apiKey": "   " } ] }));
        assert_eq!(data["keyCount"], 0);
        assert!(data["results"].as_array().unwrap().is_empty());
    }

    #[test]
    fn empty_keys_refresh_never_counts_as_a_tray_observation() {
        let real = json!({
            "keyCount": 1,
            "results": [{ "label": "k", "ok": true, "quota": { "tier": "pro", "windows": [
                { "window": "five_hour", "pct": 42.0, "resetMs": 100 }
            ] } }],
        });
        note_success(&real, 1_000, false, None);
        let out = refresh_and_cache(&json!({ "keys": [] }), 2_000, false);
        assert_eq!(out["keyCount"], 0);
        // the menu still renders the last real observation — a key wipe must
        // not flip the tray to "add a key" or reset the alert baseline
        let items = menu_items("zh-CN");
        let row = items.iter().find(|i| i["label"].as_str().unwrap_or("").contains("42%")).expect("usage row");
        assert!(row["label"].as_str().unwrap().contains("🟢"));
        assert_ne!(row.get("disabled").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn usage_dot_matches_card_bands() {
        assert_eq!(tray_state::usage_dot(2.0), "🟢");
        assert_eq!(tray_state::usage_dot(69.9), "🟢");
        assert_eq!(tray_state::usage_dot(70.0), "🟠");
        assert_eq!(tray_state::usage_dot(89.0), "🟠");
        assert_eq!(tray_state::usage_dot(90.0), "🔴");
    }
}
