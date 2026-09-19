// Zhipu menu-bar (tray) state machine (feat/compute-sharing R20, simplified R22).
//
// Backs the tray module section: a query cache with tiered refresh cadence
// and threshold alerts (80%/90% crossing with hysteresis). Pure state
// transitions — the sidecar owns the single instance and does all IO.
//
// Product semantics are the product×user-subagent consensus (handoff R20):
// - 🔴≥90 / 🟠≥70 row dots judge ALL windows of a key (a weekly 95% with 5h
//   at 30% must still scream, not read as a safe 30%);
// - alerts fire on upward crossings of 80/90, once per (key, window, tier);
//   re-arm after falling tier−5pt or a window rollover (reset changed);
//   the first observation after start is a baseline and never alerts;
// - ≥70% on any window bumps the refresh cadence 15min → 5min.
// R22 dropped the macOS title and the menu footer lines — the tray shows
// `{dot} {name} {pct}%` rows plus a compact reset countdown ("· 4h40m",
// user request 2026-09-19); details live in the app card.

use serde_json::Value;
use std::collections::HashMap;

pub const WARN_PCT: f64 = 80.0;
pub const CRIT_PCT: f64 = 90.0;
/// Display bands, shared with the plugin card. Same ladder as cc-switch
/// `utilizationColor`: green <70, orange 70–89, red ≥90. Alert crossings
/// stay on WARN_PCT/CRIT_PCT and are not this ladder.
pub const COLOR_WARN_PCT: f64 = 70.0;
pub const COLOR_CRIT_PCT: f64 = 90.0;

pub fn usage_dot(pct: f64) -> &'static str {
    if pct >= COLOR_CRIT_PCT {
        "🔴"
    } else if pct >= COLOR_WARN_PCT {
        "🟠"
    } else {
        "🟢"
    }
}
pub const REARM_DROP_PCT: f64 = 5.0;
pub const FAST_TTL_MS: i64 = 5 * 60_000;
pub const BASE_TTL_MS: i64 = 15 * 60_000;

#[derive(Clone, Debug, PartialEq)]
pub struct ThresholdAlert {
    pub key: String,
    pub window: String, // "five_hour" | "weekly"
    pub level: u16,     // 80 | 90
    pub pct: f64,
}

#[derive(Default)]
struct WindowAlertState {
    seen: bool,
    last_pct: Option<f64>,
    reset_ms: Option<i64>,
    alerted80: bool,
    alerted90: bool,
}

#[derive(Default)]
pub struct ZhipuTrayState {
    last_success_ms: Option<i64>,
    next_refresh_ms: i64,
    last_data: Option<Value>,
    windows: HashMap<(String, String), WindowAlertState>,
}

fn window_pct(window: &Value) -> f64 {
    window.get("pct").and_then(|v| v.as_f64()).unwrap_or(0.0)
}

fn window_reset(window: &Value) -> Option<i64> {
    window.get("resetMs").and_then(|v| v.as_i64())
}

impl ZhipuTrayState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ingest a successful query response (the `zhipu-plan:usage` shape:
    /// `{keyCount, results:[{label, ok, quota:{tier, windows:[…]}}]}`).
    /// Returns the threshold alerts crossed by THIS observation.
    pub fn ingest_success(&mut self, data: &Value, now_ms: i64) -> Vec<ThresholdAlert> {
        self.last_success_ms = Some(now_ms);
        self.last_data = Some(data.clone());
        let mut alerts = Vec::new();
        let mut any_fast = false;
        let mut live: Vec<(String, String)> = Vec::new();

        for result in data.get("results").and_then(|v| v.as_array()).into_iter().flatten() {
            if result.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                continue;
            }
            let label = result.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let quota = result.get("quota").cloned().unwrap_or(Value::Null);
            for window in quota.get("windows").and_then(|v| v.as_array()).into_iter().flatten() {
                let name = window.get("window").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if name.is_empty() {
                    continue;
                }
                let pct = window_pct(window);
                let reset = window_reset(window);
                if pct >= 70.0 {
                    any_fast = true;
                }
                live.push((label.clone(), name.clone()));
                let st = self.windows.entry((label.clone(), name.clone())).or_default();
                if st.reset_ms != reset {
                    // window rollover — re-arm both tiers
                    st.alerted80 = false;
                    st.alerted90 = false;
                    st.reset_ms = reset;
                }
                if !st.seen {
                    // startup baseline: record, never alert
                    st.seen = true;
                    if pct >= CRIT_PCT {
                        st.alerted90 = true;
                    }
                    if pct >= WARN_PCT {
                        st.alerted80 = true;
                    }
                    st.last_pct = Some(pct);
                    continue;
                }
                let prev = st.last_pct.unwrap_or(pct);
                if pct >= CRIT_PCT && !st.alerted90 && prev < CRIT_PCT {
                    alerts.push(ThresholdAlert { key: label.clone(), window: name.clone(), level: 90, pct });
                    st.alerted90 = true;
                }
                if pct >= WARN_PCT && !st.alerted80 && prev < WARN_PCT {
                    alerts.push(ThresholdAlert { key: label.clone(), window: name.clone(), level: 80, pct });
                    st.alerted80 = true;
                }
                if pct < CRIT_PCT - REARM_DROP_PCT {
                    st.alerted90 = false;
                }
                if pct < WARN_PCT - REARM_DROP_PCT {
                    st.alerted80 = false;
                }
                st.last_pct = Some(pct);
            }
        }
        // GC states for keys/windows that disappeared (key removed, dedup change)
        self.windows.retain(|k, _| live.contains(k));
        self.next_refresh_ms = now_ms + if any_fast { FAST_TTL_MS } else { BASE_TTL_MS };
        alerts
    }

    pub fn last_success_ms(&self) -> Option<i64> {
        self.last_success_ms
    }

    /// Last successful query payload (the `zhipu-plan:usage` shape) for menu
    /// rendering; None before the first success.
    pub fn last_data(&self) -> Option<&Value> {
        self.last_data.as_ref()
    }

    pub fn due_refresh(&self, now_ms: i64) -> bool {
        self.last_success_ms.is_none() || now_ms >= self.next_refresh_ms
    }

    /// Force the next refresh: keep the last data snapshot and the armed
    /// alert states (menus keep rendering, no re-baselining), only drop the
    /// success stamp so `due_refresh` reads true. Used when the config
    /// changed under the cache (renamed labels, edited keys).
    pub fn expire(&mut self) {
        self.last_success_ms = None;
    }
}

/// Compact remaining-reset countdown for tray rows: "45m", "4h40m", "5h",
/// "2d". None when the reset already passed (the next refresh will bring the
/// new window). Matches the card's compactReset and the CLI's term::compact_reset.
pub fn compact_reset(reset_ms: i64, now_ms: i64) -> Option<String> {
    let diff = reset_ms - now_ms;
    if diff <= 0 {
        return None;
    }
    let mins = ((diff as f64) / 60000.0).ceil() as i64;
    if mins < 60 {
        return Some(format!("{}m", mins));
    }
    let hours = mins / 60;
    let rem = mins % 60;
    if hours < 48 {
        return Some(if rem > 0 {
            format!("{}h{:02}m", hours, rem)
        } else {
            format!("{}h", hours)
        });
    }
    Some(format!("{}d", (mins as f64 / 1440.0).round()))
}

/// Human-readable key display name (R22): labels are user-typed in the
/// module card; an empty label falls back to a numbered default.
pub fn display_key_label(label: &str, index: usize, lang: &str) -> String {
    let name = label.trim();
    if !name.is_empty() {
        return name.to_string();
    }
    if lang == "en" {
        format!("Zhipu key {}", index + 1)
    } else {
        format!("智谱 Key {}", index + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn results(windows_by_key: Vec<(&str, Value)>) -> Value {
        json!({
            "keyCount": windows_by_key.len(),
            "results": windows_by_key
                .into_iter()
                .map(|(label, windows)| json!({ "label": label, "ok": true, "quota": { "tier": "pro", "windows": windows } }))
                .collect::<Vec<_>>(),
        })
    }

    fn windows(pcts: &[(&str, f64, i64)]) -> Value {
        json!(pcts
            .iter()
            .map(|(w, pct, reset)| json!({ "window": w, "pct": pct, "resetMs": reset }))
            .collect::<Vec<_>>())
    }

    #[test]
    fn baseline_never_alerts_then_crossing_alerts_once() {
        let mut st = ZhipuTrayState::new();
        let data = results(vec![("zcode:Harry", windows(&[("five_hour", 60.0, 100), ("weekly", 20.0, 200)]))]);
        assert!(st.ingest_success(&data, 1_000).is_empty(), "startup baseline must not alert");
        // 60 → 85 crosses 80: one warning alert
        let up = results(vec![("zcode:Harry", windows(&[("five_hour", 85.0, 100), ("weekly", 20.0, 200)]))]);
        let alerts = st.ingest_success(&up, 2_000);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].level, 80);
        assert_eq!(alerts[0].key, "zcode:Harry");
        assert_eq!(alerts[0].window, "five_hour");
        // same tier again: no repeat
        let again = results(vec![("zcode:Harry", windows(&[("five_hour", 88.0, 100), ("weekly", 20.0, 200)]))]);
        assert!(st.ingest_success(&again, 3_000).is_empty());
        // 88 → 92 crosses 90: critical alert
        let crit = results(vec![("zcode:Harry", windows(&[("five_hour", 92.0, 100), ("weekly", 20.0, 200)]))]);
        let alerts = st.ingest_success(&crit, 4_000);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].level, 90);
    }

    #[test]
    fn rearm_after_hysteresis_drop_and_rollover() {
        let mut st = ZhipuTrayState::new();
        let base = results(vec![("zcode:Harry", windows(&[("five_hour", 85.0, 100)]))]);
        st.ingest_success(&base, 1_000); // baseline ≥80 marks alerted80 silently
        // fall below 75 re-arms the 80 tier
        let down = results(vec![("zcode:Harry", windows(&[("five_hour", 74.0, 100)]))]);
        assert!(st.ingest_success(&down, 2_000).is_empty());
        let up = results(vec![("zcode:Harry", windows(&[("five_hour", 82.0, 100)]))]);
        assert_eq!(st.ingest_success(&up, 3_000).len(), 1);
        // window rollover (reset changed) re-arms both tiers
        st.ingest_success(&results(vec![("zcode:Harry", windows(&[("five_hour", 95.0, 999)]))]), 4_000);
        let after_roll = results(vec![("zcode:Harry", windows(&[("five_hour", 96.0, 999)]))]);
        assert!(st.ingest_success(&after_roll, 5_000).is_empty(), "rollover re-arms, 95→96 is not a fresh crossing");
    }

    #[test]
    fn tiered_refresh_cadence() {
        let mut st = ZhipuTrayState::new();
        let calm = results(vec![("zcode:Harry", windows(&[("five_hour", 42.0, 100)]))]);
        st.ingest_success(&calm, 0);
        assert!(!st.due_refresh(BASE_TTL_MS - 1));
        assert!(st.due_refresh(BASE_TTL_MS));
        let hot = results(vec![("zcode:Harry", windows(&[("five_hour", 72.0, 100)]))]);
        st.ingest_success(&hot, BASE_TTL_MS);
        assert!(!st.due_refresh(BASE_TTL_MS + FAST_TTL_MS - 1));
        assert!(st.due_refresh(BASE_TTL_MS + FAST_TTL_MS));
    }

    #[test]
    fn key_display_names() {
        // R22: labels are user-typed — used verbatim (trimmed); only an empty
        // label falls back to the numbered default.
        assert_eq!(display_key_label("GLM 5.3 -Harry", 0, "zh-CN"), "GLM 5.3 -Harry");
        assert_eq!(display_key_label("  Zhipu GLM  ", 1, "en"), "Zhipu GLM");
        assert_eq!(display_key_label("", 2, "zh-CN"), "智谱 Key 3");
        assert_eq!(display_key_label("", 2, "en"), "Zhipu key 3");
    }

    #[test]
    fn compact_reset_bands() {
        let now = 1_000_000_000i64;
        // already past → nothing to show
        assert_eq!(compact_reset(now - 1, now), None);
        assert_eq!(compact_reset(now, now), None);
        assert_eq!(compact_reset(now + 44 * 60_000, now).as_deref(), Some("44m"));
        assert_eq!(compact_reset(now + 45 * 60_000, now).as_deref(), Some("45m"));
        assert_eq!(compact_reset(now + 4 * 3_600_000 + 40 * 60_000, now).as_deref(), Some("4h40m"));
        assert_eq!(compact_reset(now + 5 * 3_600_000, now).as_deref(), Some("5h"));
        assert_eq!(compact_reset(now + 50 * 3_600_000, now).as_deref(), Some("2d"));
    }
}
