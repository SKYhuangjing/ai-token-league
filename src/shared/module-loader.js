// Optional-module loader (feat/compute-sharing R17): fetch a module's JS entry,
// import it as an ES module from a blob URL, and mount it with a host context.
//
// Trust model (v1): the entry is downloaded from the backend proxy
// (/api/modules/remote/file/...) at install (or first mount if that version
// was recorded before local packages existed). The host stores the bytes
// next to modules.json; installedVersion is only the pin. Later mounts use
// that local copy, so a plugin that does not itself call the cloud works
// offline. Production hardening = catalog signature verification.
// Blob-URL import keeps a reference alive for the module's lifetime (v1 keeps
// the URL forever — uninstall swaps the record, the module scope is abandoned).

export async function fetchModuleSource(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`module source fetch failed: HTTP ${response.status}`);
  return response.text();
}

// Prefer the version already downloaded to this machine. Fetch only on a
// cache miss, then ask the host to keep that copy for the next offline mount.
// `fetchSource` may be omitted when there is no cloud base; a miss then
// rejects with code `not_cached` so the host can show the no-cloud state.
export async function loadInstalledModuleSource({ readCache, fetchSource, writeCache } = {}) {
  if (typeof readCache === "function") {
    try {
      const cached = await readCache();
      if (typeof cached === "string" && cached) return { source: cached, origin: "cache" };
    } catch { /* treat a broken cache as a miss and try the network */ }
  }
  if (typeof fetchSource !== "function") {
    const error = new Error("module package not cached");
    error.code = "not_cached";
    throw error;
  }
  let source;
  try {
    source = await fetchSource();
  } catch (error) {
    if (isUnreachableModuleFetch(error)) {
      const wrapped = new Error("module package unreachable");
      wrapped.code = "offline";
      throw wrapped;
    }
    throw error;
  }
  if (typeof source !== "string" || !source) throw new Error("module source fetch failed: empty");
  if (typeof writeCache === "function") {
    try { await writeCache(source); } catch { /* downloaded source still mounts this time */ }
  }
  return { source, origin: "network" };
}

// A cloud base is configured, but this version was never downloaded and the
// fetch never got an HTTP status. HTTP errors stay ordinary fetch failures.
export function isUnreachableModuleFetch(error) {
  if (!error) return false;
  const name = error.name || "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  const message = String(error.message || error);
  if (message.startsWith("module source fetch failed: HTTP ")) return false;
  if (message === "module source fetch failed: empty") return false;
  return name === "TypeError" || /failed to fetch|load failed|networkerror|network request failed/i.test(message);
}

export async function importModuleFromSource(source) {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  // NOTE: intentionally not revoking — the imported module must stay alive.
  return import(url);
}

export function buildModuleContext({ t, invoke, escapeHtml, apiBase } = {}) {
  // apiBase: () => string — live backend API root getter for plugins that
  // talk to cloud HTTP endpoints; absent in stripped hosts.
  return { t, invoke, escapeHtml, apiBase };
}

// Platform commands every plugin may call without declaring them, scoped to
// the calling plugin's OWN install/config record (self-state, not a
// capability): modules:get is filtered to that record and modules:set is
// forced onto it, so a plugin can never read another plugin's config (e.g.
// its API keys) or tamper with its state.
export const PLATFORM_INVOKE_COMMANDS = new Set(["modules:get", "modules:set"]);

// Host-only package cache. A plugin must not write or read another plugin's
// downloaded entry, even if its catalog lists these commands.
const HOST_ONLY_COMMANDS = new Set([
  "modules:package-get",
  "modules:package-put",
  "modules:package-delete",
]);

// True when `permissions` (manifest declarations, "sidecar:<command>" or
// "sidecar:<namespace>:*") authorizes `command`.
export function invokeAllowed(command, permissions) {
  if (HOST_ONLY_COMMANDS.has(command)) return false;
  if (PLATFORM_INVOKE_COMMANDS.has(command)) return true;
  const list = Array.isArray(permissions) ? permissions : [];
  for (const entry of list) {
    if (!entry.startsWith("sidecar:")) continue;
    const grant = entry.slice("sidecar:".length);
    if (grant === command) return true;
    if (grant.endsWith(":*") && command.startsWith(grant.slice(0, -1))) return true;
  }
  return false;
}

// Wrap the raw sidecar channel with the plugin's declared permissions (A.3):
// calls beyond the declaration reject before reaching the sidecar. This is
// the enforcement point — the webview's shared channel cannot otherwise tell
// which plugin is calling. `selfId` is the calling plugin's id; when given,
// platform commands are scoped to that plugin's own record. Hosts that don't
// know the caller keep the historical unscoped behavior.
export function createGuardedInvoke(permissions, baseInvoke, selfId = "") {
  return (command, args) => {
    if (!invokeAllowed(command, permissions)) {
      return Promise.reject(new Error(`permission_denied:${command}`));
    }
    if (selfId && command === "modules:get") {
      return Promise.resolve(baseInvoke(command, args)).then((state) => {
        const own = ((state || {}).modules || {})[selfId];
        return { modules: own ? { [selfId]: own } : {} };
      });
    }
    if (selfId && command === "modules:set") {
      return baseInvoke(command, { ...(args || {}), id: selfId });
    }
    return baseInvoke(command, args);
  };
}
