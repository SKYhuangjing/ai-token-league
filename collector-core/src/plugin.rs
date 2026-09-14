// Platform sidecar plugin standard (plugin-platform P0, R26).
//
// The sidecar is a pure host: it owns the command loop, storage and the tray
// payload — never plugin logic. A plugin is one crate that implements
// `SidecarPlugin`; the composition root (atl-collector/src/plugins.rs)
// registers it. Contract:
//
// - commands route by namespace: "{plugin-id}:{sub-command}" — platform
//   commands resolve first in the protocol layer, this is the fallback;
// - plugins never touch the filesystem: the host reads modules.json and
//   hands it in as `PluginCtx::modules_state` (install/enable/config state);
// - tray sections are provider-based: each plugin gates itself, reports
//   whether its cache is due, and renders localized rows + notification
//   payloads. The host only orders them above "quit";
// - `handle`/`tray_refresh` run on blocking threads (they may do IO).

use serde_json::Value;

/// Host context for one plugin call: a snapshot of the persisted modules
/// state. Kept as a struct so future host capabilities (config, clock)
/// can be added without breaking implementations.
pub struct PluginCtx<'a> {
    pub modules_state: &'a Value,
}

pub trait SidecarPlugin: Send + Sync {
    /// Plugin id — the command namespace ("{id}:{sub}") and the modules.json key.
    fn id(&self) -> &'static str;

    /// Handle a namespaced command. `None` marks the sub-command unknown
    /// (the host answers with a standard error).
    fn handle(&self, sub: &str, args: &Value, ctx: PluginCtx<'_>) -> Option<Result<Value, String>>;

    /// Tray gates from the modules state: (menu_section_on, alerts_on).
    fn tray_gates(&self, ctx: PluginCtx<'_>) -> (bool, bool) {
        let _ = ctx;
        (false, false)
    }

    /// Whether the plugin's tray cache is due; the host runs `tray_refresh`
    /// on a blocking thread when this returns true.
    fn tray_due(&self, now_ms: i64) -> bool {
        let _ = now_ms;
        false
    }

    /// Blocking tray refresh (query + ingest into the plugin's own cache).
    fn tray_refresh(&self, ctx: PluginCtx<'_>, now_ms: i64) {
        let _ = (ctx, now_ms);
    }

    /// Localized tray menu rows for the section (host inserts above "quit").
    fn tray_items(&self, lang: &str) -> Vec<Value> {
        let _ = lang;
        Vec::new()
    }

    /// Drain threshold alerts as native-notification payloads.
    fn tray_alerts(&self, lang: &str) -> Vec<Value> {
        let _ = lang;
        Vec::new()
    }
}

/// Route "{id}:{sub}" to a registered plugin. Called as the fallback after
/// platform command resolution, so a namespace can never shadow a platform
/// command. `None` = no plugin registered for the namespace.
pub fn route_plugin_command(
    plugins: &[Box<dyn SidecarPlugin>],
    command: &str,
    args: &Value,
    modules_state: &Value,
) -> Option<Result<Value, String>> {
    let (ns, sub) = command.split_once(':')?;
    let plugin = plugins.iter().find(|p| p.id() == ns)?;
    plugin.handle(sub, args, PluginCtx { modules_state })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct EchoPlugin {
        id: &'static str,
    }

    impl SidecarPlugin for EchoPlugin {
        fn id(&self) -> &'static str {
            self.id
        }
        fn handle(&self, sub: &str, args: &Value, _ctx: PluginCtx<'_>) -> Option<Result<Value, String>> {
            match sub {
                "echo" => Some(Ok(json!({ "id": self.id, "args": args }))),
                "boom" => Some(Err("plugin error".into())),
                _ => None,
            }
        }
    }

    fn plugins() -> Vec<Box<dyn SidecarPlugin>> {
        vec![Box::new(EchoPlugin { id: "sample" })]
    }

    #[test]
    fn routes_namespaced_commands_to_the_registered_plugin() {
        let state = json!({});
        let out = route_plugin_command(&plugins(), "sample:echo", &json!({ "x": 1 }), &state).unwrap().unwrap();
        assert_eq!(out["id"], "sample");
        assert_eq!(out["args"]["x"], 1);
    }

    #[test]
    fn unknown_namespace_or_subcommand_is_none() {
        let state = json!({});
        assert!(route_plugin_command(&plugins(), "other:echo", &json!({}), &state).is_none());
        assert!(route_plugin_command(&plugins(), "sample:nope", &json!({}), &state).is_none());
        // no colon at all can never match a namespace
        assert!(route_plugin_command(&plugins(), "sample", &json!({}), &state).is_none());
    }

    #[test]
    fn plugin_errors_travel_as_err_results() {
        let state = json!({});
        let out = route_plugin_command(&plugins(), "sample:boom", &json!({}), &state).unwrap();
        assert!(out.is_err());
    }
}
