// Terminal frontend for the zhipu-plan plugin — `atl zhipu`.
//
// The whole capability rides the sidecar command channel (zhipu-plan:usage
// with its 60s cache + tray-state ingest, modules.json key storage), so this
// module is presentation only: the same query, the same keys, the same cache
// the desktop card and the menu-bar tray see.

use collector_core::modules;
use serde_json::{json, Value};

use crate::plugin_cli::{notify_config_changed, sidecar_call};
use crate::term;
use crate::cli::CliError;

const PLUGIN_ID: &str = "zhipu-plan";

pub async fn cmd_zhipu(action: crate::ZhipuAction) -> Result<(), CliError> {
    match action {
        crate::ZhipuAction::Usage { force, json } => cmd_usage(force, json).await,
        crate::ZhipuAction::Key { action } => match action {
            crate::ZhipuKeyAction::List { json } => cmd_key_list(json),
            crate::ZhipuKeyAction::Add { api_key, label, json } => cmd_key_add(&api_key, label.as_deref(), json),
            crate::ZhipuKeyAction::Remove { key, json } => cmd_key_remove(&key, json),
        },
    }
}

fn map_error(error: String) -> CliError {
    // busy must reach the boundary un-wrapped so classify_busy maps it to exit 3
    if collector_core::store_lock::is_busy_error(&error) {
        return CliError::Message(error);
    }
    if error.contains("is not installed") {
        return CliError::Message(format!(
            "{}\nInstall it first:  {} plugin install {}",
            error,
            term::program_name(),
            PLUGIN_ID
        ));
    }
    // exit-code semantics (cli-dev-standard §4): transport failure → 12
    if error.starts_with("backend_unreachable") {
        return CliError::Network(error);
    }
    CliError::Message(error)
}

async fn cmd_usage(force: bool, json_out: bool) -> Result<(), CliError> {
    let state = modules::load_modules_state();
    let mut args = plugin_zhipu::host::query_args_from_modules(&state);
    if force {
        args["force"] = json!(true);
    }
    let data = sidecar_call(&format!("{}:usage", PLUGIN_ID), args)
        .await
        .map_err(map_error)?;
    if json_out {
        crate::cli::print_json_out(data, false);
        return Ok(());
    }
    print!("{}", render_usage(&data));
    Ok(())
}

/// Window label — the Rust parser stamps a stable `window` name; unit mapping
/// only serves older payloads (same fallback order as the card's windowLabel).
fn window_label(window: &Value) -> String {
    match window.get("window").and_then(|v| v.as_str()) {
        Some("five_hour") => "5h".to_string(),
        Some("weekly") => "weekly".to_string(),
        _ => match window.get("unit").and_then(|v| v.as_i64()) {
            Some(3) => "5h".to_string(),
            Some(6) => "weekly".to_string(),
            Some(unit) => format!("window {}", unit),
            None => "window".to_string(),
        },
    }
}

fn render_usage(data: &Value) -> String {
    let key_count = data.get("keyCount").and_then(|v| v.as_u64()).unwrap_or(0);
    if key_count == 0 {
        return format!(
            "No Zhipu keys configured.\nAdd one:  {} zhipu key add <apiKey> --label main\n(or use the desktop plugin card)\n",
            term::program_name()
        );
    }
    let now_ms = chrono::Utc::now().timestamp_millis();
    let fetched = data.get("fetchedAt").and_then(|v| v.as_i64()).unwrap_or(now_ms);
    let mut out = format!(
        "Zhipu usage — {} key(s), {}\n",
        key_count,
        term::refreshed_age(fetched, now_ms)
    );
    for (index, result) in data["results"].as_array().cloned().unwrap_or_default().iter().enumerate() {
        let label = result.get("label").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
        let heading = label
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("key {}", index + 1));
        if result.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            out.push_str(&format!("  {}\n    failed: {}\n", heading, result.get("error").and_then(|v| v.as_str()).unwrap_or("unknown error")));
            continue;
        }
        let quota = &result["quota"];
        let tier = quota.get("tier").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty());
        out.push_str(&format!(
            "  {}{}\n",
            heading,
            tier.map(|t| format!(" ({})", t)).unwrap_or_default()
        ));
        let windows = quota["windows"].as_array().cloned().unwrap_or_default();
        if windows.is_empty() {
            out.push_str("    (no token windows reported)\n");
        }
        for window in &windows {
            let pct = window.get("pct").and_then(|v| v.as_f64());
            let pct_text = match pct {
                Some(value) => format!("{:>3}%", value.round()),
                None => "  —".to_string(),
            };
            let reset = window
                .get("resetMs")
                .and_then(|v| v.as_i64())
                .and_then(|ms| term::compact_reset(ms, now_ms))
                .map(|text| format!("resets in {}", text))
                .unwrap_or_default();
            out.push_str(&format!(
                "    {:<8} {}   {}\n",
                window_label(window),
                pct_text,
                reset
            ));
        }
    }
    out
}

// ── key management (modules.json config, same store the card edits) ─────────

fn stored_keys(state: &Value) -> Vec<Value> {
    state
        .pointer(&format!("/modules/{}/config/keys", PLUGIN_ID))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

fn valid_key_entries(keys: &[Value]) -> Vec<Value> {
    keys.iter()
        .filter(|k| {
            k.get("apiKey")
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}

fn save_keys(keys: &[Value]) -> Result<(), CliError> {
    modules::set_module_state(PLUGIN_ID, &json!({ "config": { "keys": keys } }))?;
    notify_config_changed(PLUGIN_ID);
    Ok(())
}

fn cmd_key_list(json_out: bool) -> Result<(), CliError> {
    let state = modules::load_modules_state();
    let keys = valid_key_entries(&stored_keys(&state));
    if keys.is_empty() {
        println!("No keys configured. Add one:  {} zhipu key add <apiKey> --label main", term::program_name());
        return Ok(());
    }
    let rows: Vec<Value> = keys
        .iter()
        .enumerate()
        .map(|(index, key)| {
            json!({
                "index": index + 1,
                "label": key.get("label").and_then(|v| v.as_str()).unwrap_or(""),
                "maskedKey": term::mask_api_key(key.get("apiKey").and_then(|v| v.as_str()).unwrap_or("")),
            })
        })
        .collect();
    if json_out {
        // masked only — full keys never reach terminal output
        crate::cli::print_json_out(json!({ "keys": rows }), false);
        return Ok(());
    }
    println!("Zhipu keys ({}):", rows.len());
    for row in &rows {
        println!(
            "  {:>2}  {:<16} {}",
            row["index"].as_i64().unwrap_or(0),
            row["label"].as_str().unwrap_or(""),
            row["maskedKey"].as_str().unwrap_or("")
        );
    }
    Ok(())
}

/// Idempotent add plan (cli-dev-standard §5): re-adding a stored key never
/// stacks a duplicate — it only relabels, and a no-op relabel writes nothing.
enum KeyAddOutcome {
    Added,
    Relabeled { previous: String },
    Unchanged,
}

fn plan_key_add(keys: &[Value], api_key: &str, label: &str) -> (Vec<Value>, KeyAddOutcome) {
    if let Some(index) = keys
        .iter()
        .position(|key| key.get("apiKey").and_then(|v| v.as_str()) == Some(api_key))
    {
        let previous = keys[index]
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if previous == label {
            return (keys.to_vec(), KeyAddOutcome::Unchanged);
        }
        let mut next = keys.to_vec();
        next[index]["label"] = json!(label);
        return (next, KeyAddOutcome::Relabeled { previous });
    }
    let mut next = keys.to_vec();
    next.push(json!({ "label": label, "apiKey": api_key }));
    (next, KeyAddOutcome::Added)
}

/// Zhipu API keys are "<id>.<secret>" with both halves alphanumeric-ish.
/// Entry-shape check only — it rejects obvious garbage, not typos.
fn key_shape_ok(key: &str) -> bool {
    let allowed = |part: &str| {
        !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    match key.split_once('.') {
        Some((id, secret)) => allowed(id) && allowed(secret),
        None => false,
    }
}

fn cmd_key_add(api_key: &str, label: Option<&str>, json_out: bool) -> Result<(), CliError> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("api key must not be empty".into());
    }
    // entry validation (user input is untrusted): fail loud at the door
    // instead of storing garbage that only fails later at query time
    if !key_shape_ok(api_key) {
        return Err(
            "this does not look like a Zhipu API key (expected the '<id>.<secret>' shape) — \
             check the key in the Zhipu console and paste it exactly"
                .into(),
        );
    }
    // read→plan→write under one guard: a concurrent desktop key edit must not
    // be lost to this command's full-list replace (set_module_state re-enters)
    let _guard = collector_core::store_lock::acquire("modules", collector_core::store_lock::WRITE_WAIT)?;
    let state = modules::load_modules_state();
    let keys = valid_key_entries(&stored_keys(&state));
    let label = label
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("key {}", keys.len() + 1));
    let masked = term::mask_api_key(api_key);
    let (next, outcome) = plan_key_add(&keys, api_key, &label);
    match outcome {
        KeyAddOutcome::Unchanged => {
            if json_out {
                crate::cli::print_json_out(
                    json!({ "added": false, "label": label, "maskedKey": masked, "keyCount": next.len() }),
                    false,
                );
            } else {
                println!("Key '{}' ({}) already configured — unchanged", label, masked);
            }
            return Ok(());
        }
        KeyAddOutcome::Relabeled { previous } => {
            save_keys(&next)?;
            if json_out {
                crate::cli::print_json_out(
                    json!({ "added": false, "label": label, "previousLabel": previous, "keyCount": next.len() }),
                    true,
                );
            } else {
                println!("Relabeled key '{}' → '{}' ({})", previous, label, masked);
            }
            return Ok(());
        }
        KeyAddOutcome::Added => {}
    }
    save_keys(&next)?;
    if json_out {
        crate::cli::print_json_out(
            json!({ "added": true, "label": label, "maskedKey": masked, "keyCount": next.len() }),
            true,
        );
    } else {
        println!("Added key '{}' ({}) — {} total", label, masked, next.len());
        println!("Check it:  {} zhipu usage --force", term::program_name());
    }
    Ok(())
}

fn cmd_key_remove(selector: &str, json_out: bool) -> Result<(), CliError> {
    let _guard = collector_core::store_lock::acquire("modules", collector_core::store_lock::WRITE_WAIT)?;
    let state = modules::load_modules_state();
    let keys = valid_key_entries(&stored_keys(&state));
    let selector = selector.trim();
    // remove by 1-based index or exact label (index wins — it is what key list prints)
    let position = selector
        .parse::<usize>()
        .ok()
        .filter(|index| *index >= 1 && *index <= keys.len())
        .map(|index| index - 1)
        .or_else(|| {
            keys.iter().position(|key| {
                key.get("label").and_then(|v| v.as_str()).map(|s| s == selector).unwrap_or(false)
            })
        })
        .ok_or_else(|| format!("no key matches '{}' — run '{} zhipu key list'", selector, term::program_name()))?;
    let removed = keys[position].clone();
    let next: Vec<Value> = keys
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != position)
        .map(|(_, key)| key.clone())
        .collect();
    save_keys(&next)?;
    if json_out {
        crate::cli::print_json_out(
            json!({ "removed": true, "label": removed.get("label").cloned().unwrap_or(Value::Null), "keyCount": next.len() }),
            true,
        );
    } else {
        println!(
            "Removed key '{}' — {} left",
            removed.get("label").and_then(|v| v.as_str()).unwrap_or(""),
            next.len()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_render_covers_ok_error_and_empty_keys() {
        let empty = json!({ "keyCount": 0, "results": [] });
        assert!(render_usage(&empty).contains("No Zhipu keys configured"));

        let now = chrono::Utc::now().timestamp_millis();
        let data = json!({
            "keyCount": 2,
            "fetchedAt": now - 90_000,
            "results": [
                { "label": "main", "ok": true, "quota": { "tier": "max", "windows": [
                    { "window": "five_hour", "pct": 55, "resetMs": now + 4 * 3_600_000 },
                    { "window": "weekly", "pct": 12, "resetMs": now + 50 * 3_600_000 }
                ] } },
                { "label": "backup", "ok": false, "error": "no plan data" }
            ]
        });
        let text = render_usage(&data);
        assert!(text.contains("2 key(s), 1 min ago"), "{}", text);
        assert!(text.contains("main (max)"));
        assert!(text.contains("\n    5h"), "{}", text);
        assert!(text.contains("55%"));
        assert!(text.contains("resets in 4h"));
        assert!(text.contains("weekly"));
        assert!(text.contains("12%"));
        assert!(text.contains("resets in 2d"));
        assert!(text.contains("backup"));
        assert!(text.contains("failed: no plan data"));
    }

    #[test]
    fn window_label_falls_back_by_unit() {
        assert_eq!(window_label(&json!({ "window": "five_hour" })), "5h");
        assert_eq!(window_label(&json!({ "window": "weekly" })), "weekly");
        assert_eq!(window_label(&json!({ "unit": 3 })), "5h");
        assert_eq!(window_label(&json!({ "unit": 6 })), "weekly");
        assert_eq!(window_label(&json!({ "unit": 9 })), "window 9");
        assert_eq!(window_label(&json!({})), "window");
    }

    #[test]
    fn key_entries_drop_blank_api_keys() {
        let keys = vec![
            json!({ "label": "main", "apiKey": "sk-1" }),
            json!({ "label": "bad", "apiKey": "  " }),
            json!({ "label": "none" }),
        ];
        assert_eq!(valid_key_entries(&keys).len(), 1);
    }

    #[test]
    fn key_add_plan_is_idempotent_and_relabels() {
        let keys = vec![json!({ "label": "main", "apiKey": "sk-1" })];
        let (next, outcome) = plan_key_add(&keys, "sk-2", "new");
        assert!(matches!(outcome, KeyAddOutcome::Added));
        assert_eq!(next.len(), 2);

        // re-add same key + same label: unchanged, zero data drift
        let (again, outcome) = plan_key_add(&next, "sk-2", "new");
        assert!(matches!(outcome, KeyAddOutcome::Unchanged));
        assert_eq!(
            serde_json::to_string(&next).unwrap(),
            serde_json::to_string(&again).unwrap()
        );

        // re-add same key + new label: relabel in place, never a duplicate
        let (relabeled, outcome) = plan_key_add(&next, "sk-1", "renamed");
        assert!(matches!(outcome, KeyAddOutcome::Relabeled { .. }));
        assert_eq!(relabeled.len(), 2);
        assert_eq!(relabeled[0]["label"], "renamed");
        assert_eq!(relabeled[0]["apiKey"], "sk-1");
    }

    #[test]
    fn key_shape_rejects_garbage_and_accepts_real_shapes() {
        // real shapes: domestic and international keys are "<id>.<secret>",
        // both halves alphanumeric (underscores/dashes tolerated)
        assert!(key_shape_ok("aaaa1111bbbb2222cccc3333.ddddd666"));
        assert!(key_shape_ok("54e0c9f3a2b74d6e8f0a1b2c3d4e5f67.O8Avqm7x"));
        assert!(key_shape_ok("id-with-dash.secret_with_under_score"));
        // garbage the entry must refuse instead of storing for later failure
        assert!(!key_shape_ok("not-a-valid-key"));
        assert!(!key_shape_ok("no-dot-at-all123"));
        assert!(!key_shape_ok(".leadingdot"));
        assert!(!key_shape_ok("trailing.dot."));
        assert!(!key_shape_ok("two.dots.here"));
        assert!(!key_shape_ok("spaces in.key"));
        assert!(!key_shape_ok(""));
    }
}
