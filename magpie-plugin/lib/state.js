// Plugin state persistence under ~/.config/magpie/atl-sync/ (the Magpie
// config dir is the only officially writable plugin location) plus the
// status bridge file the sandboxed page polls via <script src>.
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync, realpathSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_API_BASE_URL = "http://ai-token-league.dev.1datatm.info";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export function stateDir() {
  return process.env.MAGPIE_ATL_DIR || join(process.env.HOME || "~", ".config", "magpie", "atl-sync");
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, value, mode) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", mode ? { mode } : undefined);
  renameSync(tmp, path);
}

// --- config -------------------------------------------------------------

export const CONFIG_DEFAULTS = {
  // Intentionally empty: never silently ship a real ledger to a hard-coded
  // remote default. Sync refuses until the API base URL is configured
  // (plugin page, options, config.json, or --api). DEFAULT_API_BASE_URL is
  // only the suggested value the page pre-fills.
  apiBaseUrl: "",
  nickname: "",
  sinceDay: "",
  includeMagpieLocal: true,
  enabled: true,
  // usageSource: "auto" tries Magpie's unified gateway API first (gateway
  // ledger + local agent session scans, deduped upstream) and falls back to
  // the raw ledger file; "gateway"/"ledger" pin one. gatewayWindowDays is
  // how far back routine syncs look (1/7/30; 0 = full history backfill).
  usageSource: "auto",
  gatewayWindowDays: 7,
  // catch-up cadence for the resident interval trigger (minutes); gateway
  // activity still triggers immediate syncs (throttled to one a minute)
  syncIntervalMinutes: 15,
  // Same-identity adoption (read ~/.ai-token-league or import a migration
  // file) is implemented but OFF this phase: production validation runs on a
  // fresh shadow identity. Flip to true only after the phase-2 decision.
  allowAdopt: false
};

export function configPath() {
  return join(stateDir(), "config.json");
}

export function readConfig(overrides = {}) {
  const fromFile = readJson(configPath(), {});
  const fromOptions = readPluginOptions();
  // Page options win over config.json once the user has saved anything in the
  // plugin page (the page is the primary UI); config.json is the dev/CLI
  // seed before that. CLI flags always win.
  const merged = { ...CONFIG_DEFAULTS, ...fromFile, ...fromOptions, ...overrides };
  // Normalize once so uploads and the per-server manifest key share one spelling
  // (trailing slashes would otherwise split the manifest into two files).
  if (merged.apiBaseUrl) merged.apiBaseUrl = String(merged.apiBaseUrl).replace(/\/+$/, "");
  return merged;
}

export function writeConfig(config) {
  writeJsonAtomic(configPath(), config);
}

// --- identity (0600, contains the Ed25519 private key) -------------------

export function identityPath() {
  return join(stateDir(), "identity.json");
}

export function readIdentity() {
  const path = identityPath();
  // Distinguish "no identity yet" (null) from "identity file is corrupt"
  // (throw): silently treating corruption as absence would mint a fresh
  // participant and orphan this device's server-side data.
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `identity file ${path} is corrupt (${error.message}) — restore it from backup or remove it consciously; refusing to mint a replacement identity`
    );
  }
}

export function writeIdentity(identity) {
  writeJsonAtomic(identityPath(), identity, 0o600);
}

// --- sync manifest (bucket fingerprints, keyed per apiBaseUrl) ----------

export function manifestPath(apiBaseUrl) {
  const safe = String(apiBaseUrl || "").replace(/[^a-zA-Z0-9]+/g, "_");
  return join(stateDir(), `sync-state.${safe}.json`);
}

export function readManifest(apiBaseUrl) {
  return readJson(manifestPath(apiBaseUrl), { firstRouteId: null, firstSyncStart: null, buckets: {} });
}

export function writeManifest(apiBaseUrl, manifest) {
  writeJsonAtomic(manifestPath(apiBaseUrl), manifest);
}

// --- log (append, rotate at ~512KB) --------------------------------------

export function logPath() {
  return join(stateDir(), "sync.log");
}

export function appendLog(message) {
  try {
    ensureDir(stateDir());
    const line = `${new Date().toISOString()} ${message}\n`;
    const path = logPath();
    if (existsSync(path)) {
      const stat = readFileSync(path);
      if (stat.length > 512 * 1024) {
        renameSync(path, `${path}.old`);
      }
    }
    writeFileSync(path, line, { flag: "a" });
  } catch {
    // logging must never break syncing
  }
}

// --- cross-process lock (stale takeover after 5 minutes) -----------------

export async function withLock(fn) {
  const dir = stateDir();
  ensureDir(dir);
  const lockPath = join(dir, ".lock");
  // Owner metadata lives INSIDE the lock directory — reading the directory
  // itself as JSON would always fail and make every lock look stale.
  const ownerFile = () => join(lockPath, "owner.json");
  const readOwner = () => readJson(ownerFile(), null);
  const born = Date.now();
  let acquired = false;
  for (let attempt = 0; attempt < 50 && !acquired; attempt += 1) {
    try {
      mkdirSync(lockPath, { recursive: false });
      writeJsonAtomic(ownerFile(), { pid: process.pid, born });
      // re-read to confirm we still own it (guards a takeover race window)
      const owner = readOwner();
      if (owner && owner.pid === process.pid) {
        acquired = true;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } catch {
      const owner = readOwner();
      const stale = !owner || !owner.pid || Date.now() - (owner.born || 0) > 5 * 60 * 1000;
      if (stale) {
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // someone else is taking over right now; keep waiting
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (!acquired) throw new Error("atl-sync: another sync is holding the lock");
  try {
    return await fn();
  } finally {
    try {
      const owner = readOwner();
      // only release our own lock; a stale-takeover successor must survive
      if (owner && owner.pid === process.pid) {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
  }
}

// --- status bridge for the sandboxed page --------------------------------
// The page iframe has no network and no file access; the only data channel
// into it is same-origin <script src>. We write page/status.js and the page
// re-injects it with a cache-buster.

export function statusPath() {
  // Sandbox runs never touch the real served page; their status still needs
  // to round-trip (failures must reach the page), so it lands in the sandbox.
  return process.env.MAGPIE_ATL_DIR ? join(stateDir(), "status.js") : join(PLUGIN_DIR, "page", "status.js");
}

// The OTHER bridge file (usage-data.js) is display-only: sandboxed runs
// keep skipping it so test fixtures never stomp the real page's numbers.
function pageBridgeEnabled() {
  return !process.env.MAGPIE_ATL_DIR;
}

export function writeStatus(status) {
  try {
    const payload = { updatedAt: new Date().toISOString(), ...status };
    writeFileSync(statusPath(), `window.__ATL_SYNC_STATUS__ = ${JSON.stringify(payload, null, 2)};\n`);
  } catch {
    // page may not be installed; status is best-effort
  }
}

/** The status as last written, for preserving nickname/rank across failures. */
export function readStatus() {
  try {
    const text = readFileSync(statusPath(), "utf8");
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeUsageData(summary) {
  if (!pageBridgeEnabled()) return;
  try {
    writeFileSync(join(PLUGIN_DIR, "page", "usage-data.js"), `window.__ATL_USAGE_DATA__ = ${JSON.stringify(summary)};\n`);
  } catch {
    // best-effort display bridge
  }
}

// --- plugins.json options bridge ------------------------------------------
// The page persists form values into our plugin options via
// magpie.options.set(); the Bun side reads them from ~/.config/magpie/plugins.json.

function pluginsJsonPath() {
  return process.env.MAGPIE_PLUGINS_JSON || join(process.env.HOME || "~", ".config", "magpie", "plugins.json");
}

function pluginName() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")).name;
  } catch {
    return "magpie-atl-sync";
  }
}

// Magpie's own entry shape (internal/plugin/store.go Entry) is
// {spec, off, options}: spec is how the plugin was added — an npm name
// ("name" / "name@version"), a git remote, or a local file/folder path.
// Older/other hosts were seen with {name|id, options} and plain maps;
// match all of them, or page-submitted options silently vanish.
function pluginRealDir() {
  try {
    return realpathSync(PLUGIN_DIR);
  } catch {
    return PLUGIN_DIR;
  }
}

function specIsOurs(spec) {
  const name = pluginName();
  const raw = String(spec || "");
  if (!raw) return false;
  if (raw === name || raw.startsWith(`${name}@`)) return true; // npm spec
  if (raw.includes("://") || raw.startsWith("github:") || raw.startsWith("git+")) return false; // git remote
  // a path: resolve (~ and file: tolerated) and compare against our own dir
  let path = raw.replace(/^file:/, "");
  if (path.startsWith("~/")) path = join(process.env.HOME || "~", path.slice(2));
  try {
    const resolved = realpathSync(path);
    const ours = pluginRealDir();
    return resolved === ours || resolved.startsWith(ours + sep);
  } catch {
    return false;
  }
}

function findPluginEntry(doc) {
  if (!doc || typeof doc !== "object") return null;
  const name = pluginName();
  if (doc[name] && typeof doc[name] === "object") return doc[name]; // plain map shape
  const list = Array.isArray(doc.plugins)
    ? doc.plugins
    : Array.isArray(doc)
      ? doc
      : Object.values(doc).filter((value) => value && typeof value === "object");
  return (
    list.find((item) => item && typeof item === "object" && (item.name === name || item.id === name)) ||
    list.find((item) => item && typeof item === "object" && specIsOurs(item.spec)) ||
    null
  );
}

export function readPluginOptions() {
  const entry = findPluginEntry(readJson(pluginsJsonPath(), null));
  const options = entry && typeof entry === "object" ? entry.options || entry.config || {} : {};
  const out = {};
  // nickname is NOT whitelisted on purpose: a standing option nickname would
  // rename an adopted identity back on every run. The page renames through
  // the one-shot nicknameSet (consumed and scrubbed in sync.js).
  for (const key of ["apiBaseUrl", "sinceDay", "includeMagpieLocal", "enabled", "allowAdopt", "pendingCommand", "identityImport", "syncIntervalMinutes", "nicknameSet"]) {
    if (options[key] !== undefined) out[key] = options[key];
  }
  return out;
}

// pendingCommand handshake: the page writes {command, nonce}; we execute each
// nonce once and remember the last one handled.
export function readPendingCommand(config) {
  const raw = config.pendingCommand || readPluginOptions().pendingCommand;
  if (!raw || typeof raw !== "object") return null;
  const { command, nonce, url } = raw;
  if (!command || !nonce) return null;
  const state = readJson(join(stateDir(), "command-state.json"), {});
  if (state.lastNonce === nonce) return null; // already executed
  // openBoard carries the URL to open; validated again on the host side
  const out = { command, nonce };
  if (typeof url === "string") out.url = url;
  return out;
}

export function markCommandExecuted(nonce) {
  writeJsonAtomic(join(stateDir(), "command-state.json"), { lastNonce: nonce });
}

// clearPluginOption removes one of OUR keys from plugins.json (atomic,
// preserving the file's shape): the page-submitted import carries the
// identity private key, and it must not linger there after adoption.
export function clearPluginOption(key) {
  const path = pluginsJsonPath();
  const doc = readJson(path, null);
  if (!doc || typeof doc !== "object") return;
  const entry = findPluginEntry(doc);
  const options = entry && typeof entry === "object" ? entry.options || entry.config : null;
  if (!options || typeof options !== "object" || !(key in options)) return;
  delete options[key];
  writeJsonAtomic(path, doc);
}
