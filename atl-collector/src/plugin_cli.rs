// Terminal plugin management — the CLI twin of the desktop modules screen.
//
// Generic surface only (R26 discipline: this module carries no plugin
// literals; per-plugin command families live in their own frontend modules,
// and the id → terminal-command mapping is declared next to the composition
// root in plugins.rs).
//
// Lifecycle mirrors the desktop exactly: install downloads the immutable
// version, writes it under plugin-packages/<id>/<version>/, then records the
// install pin in modules.json — no plugin code is ever executed by this path
// (R28c). Uninstall keeps config so a reinstall restores the card.

use collector_core::config;
use collector_core::modules;
use serde_json::{json, Value};

use crate::board;
use crate::cli::CliError;
use crate::term;

/// Route one "{plugin-id}:{sub}" command through the same registry the
/// desktop sidecar uses — installed/enable gating, permissions and error
/// semantics are identical by construction. Plugin handles may do blocking
/// IO, so they run on a blocking thread like the sidecar does.
pub(crate) async fn sidecar_call(command: &str, args: Value) -> Result<Value, String> {
    let command = command.to_string();
    tokio::task::spawn_blocking(move || {
        let state = modules::load_modules_state();
        match collector_core::plugin::route_plugin_command(
            crate::plugins::sidecar_plugins(),
            &command,
            &args,
            &state,
        ) {
            Some(result) => result,
            None => Err(format!("unknown command: {}", command)),
        }
    })
    .await
    .map_err(|e| format!("plugin command thread failed: {}", e))?
}

/// After a direct modules.json write, notify the matching plugin so derived
/// caches (e.g. the zhipu tray snapshot) refresh immediately instead of at
/// TTL expiry — the same follow-up the sidecar's modules:set performs.
pub(crate) fn notify_config_changed(id: &str) {
    for plugin in crate::plugins::sidecar_plugins() {
        if plugin.id() == id {
            plugin.on_config_changed();
        }
    }
}

fn api_base() -> Result<String, String> {
    let cfg = config::load_config().ok_or("not initialized")?;
    let api = config::normalize_api_base_url(&cfg.api_base_url);
    if api.is_empty() {
        return Err(format!(
            "API base URL not configured. Set it with:\n  {} config set apiBaseUrl <url>",
            term::program_name()
        )
        .into());
    }
    Ok(api)
}

pub async fn cmd_plugin(action: crate::PluginAction) -> Result<(), CliError> {
    match action {
        crate::PluginAction::List { json } => cmd_plugin_list(json)?,
        crate::PluginAction::Install { id, version, json } => {
            cmd_plugin_install(&id, version.as_deref(), json).await?
        }
        crate::PluginAction::Remove { id, json } => cmd_plugin_remove(&id, json)?,
    }
    Ok(())
}

/// Installed-plugin listing. Config values stay out of the output — module
/// config holds API keys, and terminal history/logs must not capture them.
fn cmd_plugin_list(json_out: bool) -> Result<(), CliError> {
    let state = modules::load_modules_state();
    let entries = state["modules"].as_object().cloned().unwrap_or_default();
    // "__*" keys are host bookkeeping (install order), not plugins
    let entries: Vec<(String, Value)> = entries
        .into_iter()
        .filter(|(id, _)| !id.starts_with("__"))
        .collect();
    let mut rows: Vec<(String, Value)> = entries
        .into_iter()
        .map(|(id, entry)| {
            let installed_version = entry.get("installedVersion").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let enabled = entry.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            let config_keys: Vec<String> = entry
                .get("config")
                .and_then(|v| v.as_object())
                .map(|config| config.keys().cloned().collect())
                .unwrap_or_default();
            let package_on_disk = !installed_version.is_empty()
                && modules::read_plugin_package(&id, &installed_version).is_ok();
            let installed = !installed_version.is_empty();
            let row = json!({
                "id": id,
                "installed": installed,
                "enabled": enabled,
                "installedVersion": installed_version,
                "packageOnDisk": package_on_disk,
                "configKeys": config_keys,
            });
            (id, row)
        })
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));

    if json_out {
        crate::cli::print_json_out(
            json!({ "plugins": rows.into_iter().map(|(_, row)| row).collect::<Vec<_>>() }),
            false,
        );
        return Ok(());
    }
    if rows.is_empty() {
        println!("No plugins installed. Browse the catalog: {} plugin install <id>", term::program_name());
        return Ok(());
    }
    println!("Installed plugins:");
    for (id, row) in &rows {
        let version = row["installedVersion"].as_str().unwrap_or("");
        let state_text = if row["installed"].as_bool().unwrap_or(false) {
            if row["enabled"].as_bool().unwrap_or(true) {
                "on"
            } else {
                "off"
            }
        } else {
            "config-only"
        };
        println!(
            "  {:<20} {:<10} {:<10} {}",
            id,
            if version.is_empty() { "-" } else { version },
            state_text,
            if row["packageOnDisk"].as_bool().unwrap_or(false) { "" } else { "(package missing — reinstall to re-download)" }
        );
        if let Some((_, command)) = crate::plugins::terminal_surfaces()
            .iter()
            .find(|(plugin_id, _)| *plugin_id == id)
        {
            println!("    terminal: {} --help", command);
        }
    }
    Ok(())
}

/// Backend module file URL. The server route (src/backend/remote-modules.js)
/// requires the :file segment, exactly like the desktop's fetch — a regression
/// test pins this shape against that route.
fn module_file_url(api: &str, id: &str, version: &str) -> String {
    format!(
        "{}/api/modules/remote/file/{}/{}/index.js",
        api,
        urlencoding::encode(id),
        urlencoding::encode(version)
    )
}

async fn fetch_text(url: &str) -> Result<String, String> {
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("backend_unreachable:{}", e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    response.text().await.map_err(|e| e.to_string())
}

async fn cmd_plugin_install(id: &str, version: Option<&str>, json_out: bool) -> Result<(), CliError> {
    // idempotent short-circuit (cli-dev-standard §5): an explicit --version
    // that is already installed with its package on disk needs no network and
    // no state write
    if let Some(requested) = version.filter(|v| !v.trim().is_empty()) {
        let state = modules::load_modules_state();
        let installed = state
            .pointer(&format!("/modules/{}/installedVersion", id))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let enabled = state
            .pointer(&format!("/modules/{}/enabled", id))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if installed == requested && enabled && modules::read_plugin_package(id, requested).is_ok() {
            if json_out {
                crate::cli::print_json_out(
                    json!({ "id": id, "version": requested, "installed": true }),
                    false,
                );
            } else {
                println!("Plugin {} {} already installed and enabled — unchanged", id, requested);
            }
            return Ok(());
        }
    }
    let api = api_base().map_err(|e| {
        // exit 10 with the standard self-healing message, like status/sync
        if e.contains("not initialized") {
            CliError::NotInitialized
        } else {
            CliError::Message(e)
        }
    })?;
    let catalog_payload = board::fetch_json(&api, "/api/modules/remote/catalog")
        .await
        .map_err(|e| {
            CliError::Network(format!(
                "{} — check your network, or the API base with '{} config get apiBaseUrl'",
                e,
                term::program_name()
            ))
        })?;
    let catalog = catalog_payload
        .as_array()
        .cloned()
        .or_else(|| catalog_payload.get("catalog").and_then(|v| v.as_array().cloned()))
        .unwrap_or_default();
    let entry = catalog
        .iter()
        .find(|entry| entry.get("id").and_then(|v| v.as_str()) == Some(id))
        .ok_or_else(|| {
            format!(
                "plugin '{}' not found in the online catalog. Available: {}",
                id,
                catalog
                    .iter()
                    .filter_map(|entry| entry.get("id").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?;
    let resolved = version
        .map(|v| v.to_string())
        .or_else(|| entry.get("version").and_then(|v| v.as_str()).map(|v| v.to_string()))
        .ok_or_else(|| format!("catalog entry for '{}' carries no version", id))?;
    let title = entry.get("title").and_then(|v| v.as_str()).unwrap_or(id).to_string();

    // download the immutable version BEFORE recording the install pin; the
    // entry is not executed here (R28c) — the desktop mounts it, the terminal
    // never runs plugin JS at all.
    let source_url = module_file_url(&api, id, &resolved);
    let source = fetch_text(&source_url).await.map_err(|e| {
        // the catalog fetch above already proved reachability, so an HTTP
        // status here means the version itself is unavailable, not the network
        if e.starts_with("HTTP ") {
            CliError::Message(format!(
                "version {} of '{}' is not available ({}) — retry without --version to install the latest",
                resolved, id, e
            ))
        } else {
            CliError::Network(format!(
                "{} — check your network, or the API base with '{} config get apiBaseUrl'",
                e,
                term::program_name()
            ))
        }
    })?;
    // the local-write section runs under the modules store lock (pure fs, no
    // awaits while held)
    let out = {
        let _guard = collector_core::store_lock::acquire("modules", collector_core::store_lock::WRITE_WAIT)?;
        modules::write_plugin_package(id, &resolved, &source)?;
        modules::set_module_state(id, &json!({ "enabled": true, "installedVersion": resolved }))?;
        notify_config_changed(id);
        json!({
            "id": id,
            "title": title,
            "version": resolved,
            "enabled": true,
            "bytes": source.len(),
        })
    };
    if json_out {
        crate::cli::print_json_out(out, true);
    } else {
        println!("Installed {} {} ({} bytes) — enabled", id, resolved, source.len());
    }
    if let Some((_, command)) = crate::plugins::terminal_surfaces()
        .iter()
        .find(|(plugin_id, _)| *plugin_id == id)
    {
        // stdout carries exactly one JSON document in --json mode; the hint
        // rides stderr there so `jq`-style consumers never see extra data
        if json_out {
            eprintln!("Try: {} --help", command);
        } else {
            println!("Try: {} --help", command);
        }
    }
    Ok(())
}

fn cmd_plugin_remove(id: &str, json_out: bool) -> Result<(), CliError> {
    // no-drift guard (cli-dev-standard §7): removing a never-installed id must
    // not materialize a junk entry (set_module_state creates on demand), and
    // a second remove reports unchanged instead of rewriting state
    let _guard = collector_core::store_lock::acquire("modules", collector_core::store_lock::WRITE_WAIT)?;
    let state = modules::load_modules_state();
    let entry = state.pointer(&format!("/modules/{}", id));
    let installed_version = entry
        .and_then(|value| value.get("installedVersion"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let package_present = !installed_version.is_empty() && modules::read_plugin_package(id, &installed_version).is_ok();
    if entry.is_none() || (installed_version.is_empty() && !package_present) {
        if json_out {
            crate::cli::print_json_out(json!({ "id": id, "removed": false, "configKept": true }), false);
        } else {
            println!("Plugin '{}' is not installed — nothing to remove", id);
        }
        return Ok(());
    }
    // desktop uninstall semantics: drop the install pin and the local package,
    // keep config so a reinstall restores the card as it was
    modules::set_module_state(id, &json!({ "installedVersion": Value::Null, "enabled": false }))?;
    modules::delete_plugin_package(id, None)?;
    notify_config_changed(id);
    if json_out {
        crate::cli::print_json_out(json!({ "id": id, "removed": true, "configKept": true }), true);
    } else {
        println!("Removed {} (config kept; reinstall restores it)", id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_projection_reveals_no_config_values() {
        // the listing view projects config KEY NAMES only — module config
        // holds API keys and terminal output must never capture them
        let entry = json!({
            "enabled": true,
            "installedVersion": "1.1.5",
            "config": { "keys": [ { "label": "main", "apiKey": "sk-secret-value" } ] }
        });
        let config_keys: Vec<String> = entry
            .get("config")
            .and_then(|v| v.as_object())
            .map(|config| config.keys().cloned().collect())
            .unwrap_or_default();
        assert_eq!(config_keys, vec!["keys".to_string()]);
        let projected = serde_json::to_string(&config_keys).unwrap();
        assert!(!projected.contains("sk-secret-value"));
    }

    #[test]
    fn module_file_url_matches_the_backend_route() {
        // mirror of the server regex in src/backend/remote-modules.js:
        // ^/api/modules/remote/file/([\w.-]+)/([\w.-]+)/([\w.]+)$
        let url = module_file_url("https://atl.example.com", "zhipu-plan", "1.1.5");
        assert_eq!(url, "https://atl.example.com/api/modules/remote/file/zhipu-plan/1.1.5/index.js");
        let path = url.trim_start_matches("https://atl.example.com");
        let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        assert_eq!(segments.len(), 7);
        assert!(segments[6].chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-'));
    }
}
