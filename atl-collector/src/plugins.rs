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
            Box::new(plugin_sharing::SharingPlugin),
            // next first-party plugin registers here
        ]
    })
}

/// Which installed plugins have a terminal command family, and what the
/// entry command is — pure presentation metadata for `atl plugin list`
/// hints. Kept beside the composition root so plugin ids stay in one place.
/// The command string follows the name the user invoked the binary as, so
/// hints are copy-pasteable both as `atl` and as `atl-collector`.
pub fn terminal_surfaces() -> Vec<(&'static str, String)> {
    let prog = crate::term::program_name();
    vec![
        ("zhipu-plan", format!("{} zhipu", prog)),
        ("compute-sharing", format!("{} share", prog)),
    ]
}
