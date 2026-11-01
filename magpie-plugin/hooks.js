// Magpie Bun-host hooks for atl-sync.
//
// The plugin body cannot hold long-lived state reliably (the host may cold
// start), so every trigger spawns a detached `bun sync.js` run guarded by a
// cross-process throttle file. Hooks must never throw and never block the
// gateway: spawning is the only thing we do here.
//
// Triggers:
//   - onResponse: best-effort notification after each gateway output
//   - interval: every 15 minutes while the host is resident (catch-up)
//   - options poll: every 5s, executes page commands (syncNow / testConnection)
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir, readConfig, readPendingCommand, markCommandExecuted } from "./lib/state.js";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)));
const SYNC_PATH = join(PLUGIN_DIR, "sync.js");
const THROTTLE_MS = 60 * 1000;
// the catch-up cadence is user-configurable (syncIntervalMinutes), so the
// resident timer ticks every minute and fires when the configured gap passed
const INTERVAL_TICK_MS = 60 * 1000;
const COMMAND_POLL_MS = 5000;

function throttlePath() {
  return join(stateDir(), ".last-spawn.json");
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

/** Detached sync spawn. `bypassThrottle` lets explicit user commands run immediately. */
function scheduleSync(reason, bypassThrottle = false) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    const stamp = readJson(throttlePath(), {});
    const now = Date.now();
    if (!bypassThrottle && stamp.at && now - stamp.at < THROTTLE_MS) return false;
    writeJsonAtomic(throttlePath(), { at: now, reason, pid: process.pid });
    const child = spawn(process.execPath, [SYNC_PATH], {
      cwd: PLUGIN_DIR,
      detached: true,
      stdio: "ignore",
      env: { ...process.env }
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function spawnDetached(args) {
  try {
    const child = spawn(process.execPath, [SYNC_PATH, ...args], {
      cwd: PLUGIN_DIR,
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch {
    // best effort
  }
}

// A plugin page cannot open links itself (its frame is sandboxed to
// allow-scripts, no popups), so the page hands the URL here and the host
// opens the user's browser. Only http(s) ever passes; the URL goes to the
// opener as an ARGUMENT, never through a shell.
function openExternal(url) {
  const target = String(url || "");
  if (!/^https?:\/\//i.test(target) || target.length > 2048) return false;
  const isWin = process.platform === "win32";
  const cmd = process.platform === "darwin" ? "open" : isWin ? "cmd" : "xdg-open";
  const args = isWin ? ["/c", "start", "", target] : [target];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// Page command handshake: the sandboxed page cannot call us, so it writes
// {pendingCommand: {command, nonce}} into its options; poll and execute each
// nonce exactly once (shared helpers with the CLI keep semantics in one place).
function pollCommands() {
  try {
    const pending = readPendingCommand({});
    if (!pending) return;
    markCommandExecuted(pending.nonce);
    if (pending.command === "syncNow") {
      scheduleSync("command", true);
    } else if (pending.command === "testConnection") {
      spawnDetached(["--test-connection"]);
    } else if (pending.command === "exportConfig") {
      spawnDetached(["--export-config"]);
    } else if (pending.command === "openBoard" && pending.url) {
      openExternal(pending.url);
    }
  } catch {
    // polling must never throw
  }
}

/** Gateway hook: required by the host; must not modify the request. */
export async function onRequest(_body, _ctx) {
  scheduleSync("gateway-request");
}

/** Gateway hook: called (best-effort) after each completed output. */
export async function onResponse(_reply, _ctx) {
  scheduleSync("gateway");
}

// The interval catch-up fires when the CONFIGURED gap has passed. The stamp
// lives in its own file (not the spawn throttle): the throttle says "a sync
// ran recently, skip", this says "the cadence elapsed, run one".
function intervalStampPath() {
  return join(stateDir(), ".last-interval.json");
}
function intervalDue(minutes, now = Date.now()) {
  const gap = Math.max(1, Number(minutes) || 15) * 60 * 1000;
  let stamp = {};
  try {
    stamp = JSON.parse(readFileSync(intervalStampPath(), "utf8"));
  } catch {
    // first boot / no stamp yet
  }
  if (!Number.isFinite(stamp.at) || now - stamp.at >= gap) {
    try {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(intervalStampPath(), JSON.stringify({ at: now }));
    } catch {
      // best effort
    }
    return true;
  }
  return false;
}

// Resident triggers (harmless if the host restarts us often).
setInterval(() => {
  try {
    if (intervalDue(readConfig().syncIntervalMinutes)) scheduleSync("interval");
  } catch {
    scheduleSync("interval"); // config unreadable: keep the old fixed cadence
  }
}, INTERVAL_TICK_MS);
setTimeout(() => scheduleSync("startup"), 5 * 1000);
// the host restarts on plugins.json changes, so a page command lands with a
// fresh host: poll once at once, then on the cadence
pollCommands();
setInterval(pollCommands, COMMAND_POLL_MS);

// Re-export for tests; keep the hook surface minimal otherwise.
export const _internal = { scheduleSync, pollCommands, intervalDue, intervalStampPath, openExternal };
