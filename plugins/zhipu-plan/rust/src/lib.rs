// atl-plugin-zhipu — Zhipu GLM Coding Plan usage plugin (feat/compute-sharing R25).
//
// Everything Zhipu-specific lives in this crate, outside the platform code:
// - `quota`      — the quota API query + cc-switch-aligned window parsing;
// - `tray_state` — the menu-bar state machine (tiered refresh, threshold
//                  alerts with hysteresis, baseline rule);
// - `host`       — the sidecar-facing glue (query cache, modules.json gate,
//                  tray menu rows and their copy).
//
// The host crate (atl-collector sidecar) only wires these into the command
// loop and the tray:menu-data payload; platform storage (modules.json) is
// read by the host and passed in as JSON — the plugin never touches the
// filesystem itself.

pub mod host;
pub mod quota;
pub mod tray_state;

/// Standard sidecar-plugin registration (collector_core::plugin). The whole
/// zhipu surface hangs off this one type: the "{id}:usage" command and the
/// tray section (gates, refresh, rows, alerts).
pub struct ZhipuPlugin;

impl collector_core::plugin::SidecarPlugin for ZhipuPlugin {
    fn id(&self) -> &'static str {
        "zhipu-plan"
    }

    fn handle(
        &self,
        sub: &str,
        args: &serde_json::Value,
        ctx: collector_core::plugin::PluginCtx<'_>,
    ) -> Option<Result<serde_json::Value, String>> {
        match sub {
            // keys come from the plugin card (user-managed); the 60s cache
            // inside dedupes the auto-refresh triggers. Commands refuse when
            // the plugin is not installed (R27 review finding).
            "usage" => {
                if !host::installed(ctx.modules_state) {
                    return Some(Err("plugin zhipu-plan is not installed".into()));
                }
                let (_, alerts_on) = host::gate(ctx.modules_state);
                Some(Ok(host::usage_cached(args, alerts_on)))
            }
            _ => None,
        }
    }

    fn tray_gates(&self, ctx: collector_core::plugin::PluginCtx<'_>) -> (bool, bool) {
        host::gate(ctx.modules_state)
    }

    fn tray_due(&self, now_ms: i64) -> bool {
        host::due_refresh(now_ms)
    }

    fn tray_refresh(&self, ctx: collector_core::plugin::PluginCtx<'_>, now_ms: i64) {
        let args = host::query_args_from_modules(ctx.modules_state);
        let (_, alerts_on) = host::gate(ctx.modules_state);
        host::refresh_and_cache(&args, now_ms, alerts_on);
    }

    fn tray_items(&self, lang: &str) -> Vec<serde_json::Value> {
        host::menu_items(lang)
    }

    fn tray_alerts(&self, lang: &str) -> Vec<serde_json::Value> {
        host::drain_alerts(lang)
    }

    fn on_config_changed(&self) {
        host::invalidate_tray();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use collector_core::plugin::route_plugin_command;
    use serde_json::json;

    #[test]
    fn usage_command_refuses_when_not_installed() {
        let plugins: Vec<Box<dyn collector_core::plugin::SidecarPlugin>> = vec![Box::new(ZhipuPlugin)];
        let out = route_plugin_command(&plugins, "zhipu-plan:usage", &json!({ "keys": [] }), &json!({ "modules": {} }))
            .expect("plugin registered for the namespace");
        assert!(out.unwrap_err().contains("not installed"));
    }
}
