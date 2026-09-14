# plugins/zhipu-plan — 智谱 GLM Coding Plan 用量插件

First-party, pluggable: nothing about zhipu lives in the platform code. One
directory owns the whole plugin stack:

| Path | Role |
| --- | --- |
| `manifest.json` / `index.js` | OSS-distributed remote payload (`publish-module.js --module-dir plugins/zhipu-plan`); also the install-time load-validation entry |
| `card.js` (imported as `src/desktop/plugins/zhipu-plan/card.js`) | Host-side rich card: user-managed keys, 5h/weekly windows, reset countdowns, menu-bar/alert toggles |
| `rust/` | `atl-plugin-zhipu` crate: quota query (`quota.rs`), tray state machine (`tray_state.rs`), sidecar glue — 60s cache, modules.json gate, tray rows (`host.rs`) |

Lifecycle (R24): installed via 插件屏 → 在线插件; never-installed or uninstalled
means no card, no tray section, no quota queries (sidecar gate requires a
modules.json entry).

Host contract for `card.js`: the platform renderer calls `initZhipuCard(...)`
once with the host singletons (`t`, `run`, `api`, `escapeHtml`, `modulesHost`,
`normalizeModulesState`, `moduleEnabled`), then `buildZhipuCard(detail, mod)`,
`refreshUsage()` on scan cycles, and `startCountdownTick()` at boot.

Known boundary (deferred): the plugin's user-facing copy currently rides the
platform i18n table (`desktop.modules.zhipu.*` in `src/shared/i18n.js`). A
plugin-owned translation namespace needs a small i18n registration API —
tracked for the plugin-platform round.
