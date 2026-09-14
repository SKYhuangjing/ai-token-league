// Platform plugin host — the composition root (R26).
//
// This is the ONLY place that knows which first-party plugins ship with the
// build. Adding a plugin = its crate + one line in the list below; the
// sidecar stays a generic host (command routing + tray provider loop).

use collector_core::plugin::SidecarPlugin;
use std::sync::OnceLock;

pub fn sidecar_plugins() -> &'static [Box<dyn SidecarPlugin>] {
    static PLUGINS: OnceLock<Vec<Box<dyn SidecarPlugin>>> = OnceLock::new();
    PLUGINS.get_or_init(|| {
        vec![
            Box::new(plugin_zhipu::ZhipuPlugin),
            // next first-party plugin registers here
        ]
    })
}
