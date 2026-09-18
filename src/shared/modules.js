// Optional-plugin registry (plugin-platform P0 slice).
// The registry is client-side and ships with the app (v1 distribution decision:
// user-installed via the online catalog; Rust persists per-plugin enable/config
// state via the sidecar modules:get/set commands).
// R24: no plugin ships pre-installed — zhipu-plan became pluggable (install /
// uninstall through the online catalog, rich card rendered by the host).
// R23 sharing direction: execution lives in the owner's CPA (`atl-share`
// plugin, cpa-plugin/) and ATL keeps cloud management only — sharing has NO
// desktop card by design (owner on/off = enabling the plugin inside CPA).

export const MODULE_REGISTRY = [];

// First-party plugins ship with the app and are installed like any remote
// plugin, but their copy comes from i18n — not from the (possibly unreachable)
// online catalog.
export const FIRST_PARTY_PLUGINS = {
  "zhipu-plan": {
    type: "query",
    titleKey: "desktop.modules.zhipu.title",
    descKey: "desktop.modules.zhipu.desc",
    // Offline permissions fallback (A.3): mirrors the manifest declaration
    // so an unreachable catalog never degrades the guard to deny-by-default
    // for the shipped first-party plugin. modules:get/set are always allowed.
    permissions: ["sidecar:zhipu-plan:usage"],
  },
  "compute-sharing": {
    type: "query",
    titleKey: "desktop.sharing.plugin.title",
    descKey: "desktop.sharing.plugin.desc",
    permissions: [
      "sidecar:compute-sharing:claim-sign",
      "sidecar:compute-sharing:borrow-get",
      "sidecar:compute-sharing:borrow-set",
        "sidecar:compute-sharing:borrow-test",
      "sidecar:compute-sharing:owner-status",
      "sidecar:compute-sharing:owner-policy",
      "sidecar:compute-sharing:owner-resume",
      "sidecar:compute-sharing:owner-suggest",
      "sidecar:compute-sharing:owner-unregister",
    ],
  },
};

export function findModule(id) {
  return MODULE_REGISTRY.find((m) => m.id === id) || null;
}

// Applies registry defaults onto persisted state; unknown persisted ids are
// kept (a plugin removed from the build shouldn't lose its state).
export function normalizeModulesState(saved) {
  const modules = Object.assign({}, saved && typeof saved === "object" ? saved : {});
  for (const mod of MODULE_REGISTRY) {
    modules[mod.id] = Object.assign({ enabled: mod.defaultEnabled, config: {} }, modules[mod.id] || {});
  }
  return modules;
}

export function moduleEnabled(state, id) {
  const entry = state && state[id];
  return Boolean(entry && entry.enabled);
}

// Reserved modules.json id for the installed-tab order. Not a plugin: it has
// no installedVersion, so the catalog and card list never surface it.
export const INSTALLED_ORDER_ID = "__order";

export function installedOrderFromState(state) {
  const config = state && state[INSTALLED_ORDER_ID] && state[INSTALLED_ORDER_ID].config;
  const ids = config && config.ids;
  if (!Array.isArray(ids)) return [];
  const seen = new Set();
  const order = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id || id === INSTALLED_ORDER_ID || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  return order;
}

// Unknown ids keep their incoming relative order and sit after saved ones.
export function sortModulesByOrder(mods, order) {
  const rank = new Map();
  for (const id of order || []) {
    if (!rank.has(id)) rank.set(id, rank.size);
  }
  return mods
    .map((mod, index) => ({
      mod,
      index,
      rank: rank.has(mod.id) ? rank.get(mod.id) : Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((row) => row.mod);
}

// Move fromId to the before/after side of toId. Operates on the visible list
// so the first reorder also captures plugins that were never saved.
export function moveInstalledOrder(ids, fromId, toId, placeAfter) {
  if (!fromId || !toId || fromId === toId) return (ids || []).slice();
  const next = (ids || []).filter((id) => id !== fromId);
  const to = next.indexOf(toId);
  if (to < 0) return (ids || []).slice();
  next.splice(placeAfter ? to + 1 : to, 0, fromId);
  return next;
}
