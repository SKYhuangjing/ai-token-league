// Shared terminal formatting helpers for the per-plugin command families.
// Pure functions; every renderer here is unit-tested.

use chrono::TimeZone;

/// The name the user invoked this binary as: "atl" through the documented
/// symlink, "atl-collector" as the raw binary (".exe" is stripped on Windows).
/// Hints echo it so copy-paste always works on the user's machine.
pub(crate) fn program_name() -> String {
    std::env::args()
        .next()
        .and_then(|arg| {
            std::path::Path::new(&arg)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "atl-collector".to_string())
}

/// Local "YYYY-MM-DD HH:MM" for an epoch-ms timestamp ("" when unfetchable).
pub(crate) fn format_local_datetime(ms: i64) -> String {
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|t: chrono::DateTime<chrono::Local>| t.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

/// Local "HH:MM" for an epoch-ms timestamp.
pub(crate) fn clock_text(ms: i64) -> String {
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|t: chrono::DateTime<chrono::Local>| t.format("%H:%M").to_string())
        .unwrap_or_else(|| "--:--".to_string())
}

/// Compact reset countdown matching the card's compactReset: "55m", "4h57m",
/// "2d". None when already past.
pub(crate) fn compact_reset(reset_ms: i64, now_ms: i64) -> Option<String> {
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

/// How long ago a fetch happened: "just now", "3 min ago", "2 h ago", "1 d ago".
pub(crate) fn refreshed_age(fetched_ms: i64, now_ms: i64) -> String {
    let diff = now_ms - fetched_ms;
    if fetched_ms <= 0 || diff < 0 {
        return "just now".to_string();
    }
    let mins = diff / 60000;
    if mins < 1 {
        "just now".to_string()
    } else if mins < 60 {
        format!("{} min ago", mins)
    } else if mins < 1440 {
        format!("{} h ago", mins / 60)
    } else {
        format!("{} d ago", mins / 1440)
    }
}

/// Claim-token mask matching the card's configBlock: first 8 + … + last 4.
pub(crate) fn mask_token(value: &str) -> String {
    if value.chars().count() > 12 {
        format!("{}…{}", first_n(value, 8), last_n(value, 4))
    } else {
        "…".to_string()
    }
}

/// API-key mask matching the zhipu card's maskApiKey.
pub(crate) fn mask_api_key(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.chars().count() <= 8 {
        return format!("{}••••", first_n(trimmed, 2));
    }
    format!("{}••••{}", first_n(trimmed, 4), last_n(trimmed, 4))
}

fn first_n(value: &str, n: usize) -> String {
    value.chars().take(n).collect()
}

fn last_n(value: &str, n: usize) -> String {
    let count = value.chars().count();
    value
        .chars()
        .skip(count.saturating_sub(n))
        .collect()
}

/// Export lines for a borrowed claim — the terminal equivalent of the card's
/// 接入配置 block. OpenAI-compatible clients want base + "/v1"; Anthropic
/// clients want the bare base.
pub(crate) fn export_lines(base_url: &str, token: &str) -> Vec<String> {
    let base = base_url.trim_end_matches('/');
    vec![
        format!("export OPENAI_BASE_URL={}/v1", base),
        format!("export OPENAI_API_KEY={}", token),
        format!("export ANTHROPIC_BASE_URL={}", base),
        format!("export ANTHROPIC_AUTH_TOKEN={}", token),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_reset_bands_match_the_card() {
        let now = 1_000_000_000i64;
        assert_eq!(compact_reset(now - 1, now), None);
        assert_eq!(compact_reset(now + 55 * 60_000, now).as_deref(), Some("55m"));
        assert_eq!(compact_reset(now + 4 * 3_600_000 + 57 * 60_000, now).as_deref(), Some("4h57m"));
        assert_eq!(compact_reset(now + 5 * 3_600_000, now).as_deref(), Some("5h"));
        assert_eq!(compact_reset(now + 50 * 3_600_000, now).as_deref(), Some("2d"));
    }

    #[test]
    fn refreshed_age_bands() {
        let now = 1_000_000_000i64;
        assert_eq!(refreshed_age(now - 30_000, now), "just now");
        assert_eq!(refreshed_age(now - 3 * 60_000, now), "3 min ago");
        assert_eq!(refreshed_age(now - 5 * 3_600_000, now), "5 h ago");
        assert_eq!(refreshed_age(now - 30 * 3_600_000, now), "1 d ago");
    }

    #[test]
    fn masks_cover_short_and_long_values() {
        assert_eq!(mask_api_key(""), "");
        assert_eq!(mask_api_key("abcd1234"), "ab••••");
        assert_eq!(mask_api_key("abcd1234efgh5678"), "abcd••••5678");
        assert_eq!(mask_token("atl_sk_1234567890abcd"), "atl_sk_1…abcd");
        assert_eq!(mask_token("short"), "…");
    }

    #[test]
    fn export_lines_shape_both_client_families() {
        let lines = export_lines("http://192.168.1.5:8317/", "atl_sk_x");
        assert_eq!(lines[0], "export OPENAI_BASE_URL=http://192.168.1.5:8317/v1");
        assert_eq!(lines[1], "export OPENAI_API_KEY=atl_sk_x");
        assert_eq!(lines[2], "export ANTHROPIC_BASE_URL=http://192.168.1.5:8317");
        assert_eq!(lines[3], "export ANTHROPIC_AUTH_TOKEN=atl_sk_x");
    }

    #[test]
    fn local_datetime_never_panics_on_extremes() {
        assert!(!format_local_datetime(0).is_empty());
        assert_eq!(clock_text(0), clock_text(0));
    }
}
