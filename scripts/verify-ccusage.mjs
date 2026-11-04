#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TIMEZONE = process.argv
  .filter((arg) => arg.startsWith("--timezone="))
  .map((arg) => arg.slice("--timezone=".length))[0] || "Asia/Singapore";

const includeToday = process.argv.includes("--include-today");
const providers = new Set(
  process.argv
    .filter((arg) => arg.startsWith("--provider="))
    .flatMap((arg) => arg.slice("--provider=".length).split(","))
    .map((arg) => arg.trim())
    .filter(Boolean)
);
const selectedProviders = providers.size > 0 ? providers : new Set(["claude", "codex", "opencode", "hermes", "openclaw", "mimocode", "workbuddy", "kimi", "antigravity"]);
const explicitlySelected = providers.size > 0;
const home = process.env.HOME || "";
const configPath = join(home, ".ai-token-league", "config.json");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
    ...options
  });
  if (result.error) {
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}\n${result.stderr || result.stdout}`
    );
  }
  return result.stdout;
}

function runCcusage(args) {
  // The globally installed ccusage is an npm shim (ccusage.cmd); Windows cannot
  // spawn it without a shell (Node rejects .cmd without shell since CVE-2024-27980).
  if (process.platform !== "win32") return run("ccusage", args);
  return run(`ccusage ${args.join(" ")}`, [], { shell: true });
}

function requireCommand(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Missing required command: ${command}`);
  }
}

function parseSemver(value) {
  const match = String(value).match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function requireCcusageVersion(minimum, feature = "Codex rollout/subagent deduplication") {
  requireCommand("ccusage");
  const actualText = runCcusage(["--version"]).trim();
  const actual = parseSemver(actualText);
  const required = parseSemver(minimum);
  if (!actual || !required) {
    throw new Error(`Cannot parse ccusage version: ${actualText}`);
  }
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > required[index]) return;
    if (actual[index] < required[index]) {
      throw new Error(
        `ccusage ${minimum}+ is required for ${feature}; found ${actualText} (upgrade: npm i -g ccusage@latest)`
      );
    }
  }
}

function localDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function providerEnabled(providerId) {
  return config.providerEnabled?.[providerId] !== false;
}

function configuredRoots(providerId, autoRoots) {
  const ignored = new Set(config.providerIgnoredAutoSources?.[providerId] || []);
  const roots = autoRoots.filter((root) => existsSync(root) && !ignored.has(root));
  for (const root of config.providerRoots?.[providerId] || []) {
    if (existsSync(root) && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

function skipped(provider, reason) {
  return { provider, expected: new Map(), verified: false, reason };
}

function verified(provider, expected) {
  return { provider, expected, verified: true };
}

function externalProviderCanMatch(providerId, provider) {
  if (!providerEnabled(providerId)) return skipped(provider, "provider disabled");
  if ((config.providerRoots?.[providerId] || []).length > 0) {
    return skipped(provider, "manual roots are not supported by the external reference tool");
  }
  if ((config.providerIgnoredAutoSources?.[providerId] || []).length > 0) {
    return skipped(provider, "ignored auto sources are not supported by the external reference tool");
  }
  return null;
}

function normalizeDay(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Cannot parse date from ccusage output: ${value}`);
  }
  return localDay(parsed);
}

function addTotal(map, day, total) {
  map.set(day, (map.get(day) || 0) + total);
}

function collectorDailyTotals(providerId) {
  const raw = run(
    "cargo",
    ["run", "-q", "-p", "atl-collector", "--", "usage", "--range", "all", "--view", "trend", "--grain", "day", "--json", "--provider", providerId],
    { env: { ...process.env, TZ: TIMEZONE } }
  );
  const envelope = JSON.parse(raw);
  if (!envelope.ok) {
    throw new Error(`atl-collector usage failed for ${providerId}: ${envelope.error || "unknown error"}`);
  }
  const totals = new Map();
  for (const row of envelope.data?.items || []) {
    const total = Number(row.totalTokens || 0);
    if (total > 0 && row.bucket) addTotal(totals, row.bucket, total);
  }
  return totals;
}

function expectedClaude() {
  const incompatible = externalProviderCanMatch("claude_code_local", "claude");
  if (incompatible) return incompatible;
  requireCommand("ccusage");
  const raw = runCcusage(["claude", "daily", "--json", "--timezone", TIMEZONE, "--offline"]);
  const parsed = JSON.parse(raw);
  const expected = new Map();
  for (const row of parsed.daily || []) {
    const total = Number(row.totalTokens || 0);
    const dateValue = row.period || row.date;
    if (total > 0 && dateValue) expected.set(normalizeDay(dateValue), total);
  }
  return verified("claude", expected);
}

function expectedCodex() {
  const incompatible = externalProviderCanMatch("codex_local", "codex");
  if (incompatible) return incompatible;
  requireCcusageVersion("20.0.19");
  const raw = runCcusage(["codex", "daily", "--json", "--timezone", TIMEZONE, "--offline"]);
  const parsed = JSON.parse(raw);
  const expected = new Map();
  for (const row of parsed.daily || []) {
    const total = Number(row.totalTokens || 0);
    const dateValue = row.period || row.date;
    if (total > 0 && dateValue) expected.set(normalizeDay(dateValue), total);
  }
  const result = verified("codex", expected);
  try {
    result.plainPerDay = codexPlainSubsetPerDay();
  } catch (error) {
    console.error(`codex: plain-subset oracle unavailable (${error.message}); falling back to direct ccusage comparison`);
  }
  return result;
}

// ccusage cannot read Codex's compressed session archives (`.jsonl.zst`,
// found both under `sessions/YYYY/MM/DD/` and in `archived_sessions/`), so
// exact parity is judged on the plain `.jsonl` subset it can see: link those
// files into a temporary codex home and run the repo's codex layout harness
// (`codex_repro_layout_dump`) over it for the collector's own per-day totals.
function codexPlainSubsetPerDay() {
  const subdirs = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      return [];
    }
  };
  const files = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile());
    } catch {
      return [];
    }
  };
  const homes = (process.env.CODEX_HOME || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (homes.length === 0 && home) homes.push(join(home, ".codex"));

  const tempHome = join(tmpdir(), `atl-verify-codex-plain-${Date.now()}`);
  let linked = 0;
  try {
    for (const codexHome of homes) {
      const sessions = join(codexHome, "sessions");
      for (const year of subdirs(sessions)) {
        for (const month of subdirs(join(sessions, year.name))) {
          for (const day of subdirs(join(sessions, year.name, month.name))) {
            for (const entry of files(join(sessions, year.name, month.name, day.name))) {
              if (!entry.name.endsWith(".jsonl")) continue;
              const relative = join(year.name, month.name, day.name, entry.name);
              const target = join(tempHome, "sessions", relative);
              mkdirSync(dirname(target), { recursive: true });
              symlinkSync(join(sessions, relative), target);
              linked += 1;
            }
          }
        }
      }
      const archived = join(codexHome, "archived_sessions");
      for (const entry of files(archived)) {
        if (!entry.name.endsWith(".jsonl")) continue;
        const target = join(tempHome, "archived_sessions", entry.name);
        mkdirSync(dirname(target), { recursive: true });
        symlinkSync(join(archived, entry.name), target);
        linked += 1;
      }
    }
    if (linked === 0) return new Map();

    const outPath = join(tmpdir(), `atl-verify-codex-plain-out-${Date.now()}.json`);
    try {
      run(
        "cargo",
        ["test", "--release", "-q", "-p", "collector-core", "codex_repro_layout_dump", "--", "--ignored", "--nocapture"],
        {
          // CODEX_HOME must point at the plain subset too: the harness's
          // scan_sessions walks its auto roots (real ~/.codex) in addition
          // to the provided root, which would smuggle the archives back in.
          env: {
            ...process.env,
            CODEX_HOME: tempHome,
            ATL_CODEX_REPRO_ROOTS: tempHome,
            ATL_CODEX_REPRO_OUT: outPath
          }
        }
      );
      const report = JSON.parse(readFileSync(outPath, "utf8"));
      const perDay = new Map();
      for (const root of Object.keys(report)) {
        for (const [day, total] of Object.entries(report[root].perDay || {})) {
          addTotal(perDay, day, Number(total) || 0);
        }
      }
      return perDay;
    } finally {
      rmSync(outPath, { force: true });
    }
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
}

function expectedOpenCode() {
  if (!providerEnabled("opencode_local")) return skipped("opencode", "provider disabled");
  const roots = configuredRoots("opencode_local", [`${home}/.local/share/opencode`]);
  const dbPaths = roots.map((root) => join(root, "opencode.db")).filter(existsSync);
  if (dbPaths.length === 0) return skipped("opencode", "no configured database found");
  requireCommand("sqlite3");
  const expected = new Map();
  for (const dbPath of dbPaths) {
    const raw = run("sqlite3", [dbPath, "-json",
      `SELECT json_extract(data, '$.time.created') AS created, ` +
      `COALESCE(json_extract(data, '$.tokens.input'), 0) + COALESCE(json_extract(data, '$.tokens.output'), 0) + ` +
      `COALESCE(json_extract(data, '$.tokens.cache.read'), 0) + COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS total ` +
      `FROM message WHERE json_extract(data, '$.tokens') IS NOT NULL AND json_extract(data, '$.role') = 'assistant'`
    ]);
    for (const row of JSON.parse(raw || "[]")) {
      const total = Number(row.total || 0);
      const created = Number(row.created);
      if (Number.isFinite(created) && total > 0) addTotal(expected, localDay(new Date(created)), total);
    }
  }
  return verified("opencode", expected);
}

function expectedHermes() {
  if (!providerEnabled("hermes_local")) return skipped("hermes", "provider disabled");
  const autoRoots = [];
  if (process.env.HERMES_HOME) autoRoots.push(process.env.HERMES_HOME);
  autoRoots.push(`${home}/.hermes`);
  const roots = configuredRoots("hermes_local", autoRoots);
  const dbPaths = roots.map((root) => join(root, "state.db")).filter(existsSync);
  if (dbPaths.length === 0) return skipped("hermes", "no configured database found");
  requireCommand("sqlite3");
  const expected = new Map();
  for (const dbPath of dbPaths) {
    const raw = run("sqlite3", [dbPath, "-json",
      `SELECT json_extract(data, '$.timestamp') AS timestamp, ` +
      `COALESCE(json_extract(data, '$.input_tokens'), 0) + COALESCE(json_extract(data, '$.output_tokens'), 0) + ` +
      `COALESCE(json_extract(data, '$.cache_read_tokens'), 0) + COALESCE(json_extract(data, '$.cache_write_tokens'), 0) AS total ` +
      `FROM session_usage WHERE json_extract(data, '$.input_tokens') IS NOT NULL OR json_extract(data, '$.output_tokens') IS NOT NULL`
    ]);
    for (const row of JSON.parse(raw || "[]")) {
      const parsed = new Date(row.timestamp);
      const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
      const total = Number(row.total || 0);
      if (total > 0) addTotal(expected, localDay(date), total);
    }
  }
  return verified("hermes", expected);
}

function expectedOpenClaw() {
  if (!providerEnabled("openclaw_local")) return skipped("openclaw", "provider disabled");
  const openclawDir = process.env.OPENCLAW_DIR || "";
  const autoRoots = [];
  if (openclawDir) {
    for (const d of openclawDir.split(",")) {
      const trimmed = d.trim();
      if (trimmed) autoRoots.push(trimmed);
    }
  }
  for (const name of [".openclaw", ".clawdbot", ".moltbot", ".moldbot"]) {
    autoRoots.push(`${home}/${name}`);
  }
  const roots = configuredRoots("openclaw_local", autoRoots);
  if (roots.length === 0) return skipped("openclaw", "no configured directory found");
  const expected = new Map();
  for (const root of roots) {
    const files = [];
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (files.length >= 5000) break;
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (
          entry.name.endsWith(".jsonl") ||
          entry.name.includes(".jsonl.deleted.") ||
          entry.name.includes(".jsonl.reset.")
        ) {
          files.push(full);
        }
      }
    }
    for (const file of files) {
      let content;
      try { content = readFileSync(file, "utf8"); } catch { continue; }
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record.role !== "assistant") continue;
        const usage = record.usage;
        if (!usage) continue;
        const input = Number(usage.input_tokens || usage.inputTokens || usage.prompt_tokens || 0);
        const output = Number(usage.output_tokens || usage.outputTokens || usage.completion_tokens || 0);
        const cacheRead = Number(usage.cache_read_tokens || usage.cacheReadTokens || usage.cached_input_tokens || 0);
        const cacheWrite = Number(usage.cache_write_tokens || usage.cacheWriteTokens || usage.cache_creation_input_tokens || 0);
        const total = input + output + cacheRead + cacheWrite;
        if (total <= 0) continue;
        let day = "";
        const ts = record.timestamp || record.created_at || record.createdAt || record.time || record.date;
        if (typeof ts === "string") {
          const ms = Date.parse(ts);
          if (!Number.isNaN(ms)) day = localDay(new Date(ms));
        }
        if (!day) day = localDay(statSync(file).mtime);
        addTotal(expected, day, total);
      }
    }
  }
  return verified("openclaw", expected);
}

function expectedMiMo() {
  if (!providerEnabled("mimocode_local")) return skipped("mimocode", "provider disabled");
  const roots = configuredRoots("mimocode_local", [`${home}/.local/share/mimocode`]);
  const dbPaths = roots.map((root) => join(root, "mimocode.db")).filter(existsSync);
  if (dbPaths.length === 0) return skipped("mimocode", "no configured database found");
  requireCommand("sqlite3");
  const expected = new Map();
  for (const dbPath of dbPaths) {
    const raw = run("sqlite3", [dbPath, "-json",
      `SELECT json_extract(data, '$.time.created') AS created, ` +
      `COALESCE(json_extract(data, '$.tokens.input'), 0) + COALESCE(json_extract(data, '$.tokens.output'), 0) + ` +
      `COALESCE(json_extract(data, '$.tokens.cache.read'), 0) + COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS total ` +
      `FROM message WHERE json_extract(data, '$.tokens') IS NOT NULL ` +
      `AND json_extract(data, '$.role') = 'assistant' ` +
      `AND session_id NOT IN (SELECT session_id FROM claude_import)`
    ]);
    for (const row of JSON.parse(raw || "[]")) {
      const total = Number(row.total || 0);
      const created = Number(row.created);
      if (Number.isFinite(created) && total > 0) addTotal(expected, localDay(new Date(created)), total);
    }
  }
  return verified("mimocode", expected);
}

function workbuddySessionRows(root) {
  // Sessions table for suppression window matching. Mirrors the collector's
  // suppression probe: time window only — deleted_at and cwd are irrelevant.
  const dbPath = join(root, "workbuddy.db");
  if (!existsSync(dbPath)) return [];
  requireCommand("sqlite3");
  const raw = run("sqlite3", [dbPath, "-json",
    "SELECT id, created_at, updated_at, last_activity_at FROM sessions"
  ]);
  return JSON.parse(raw || "[]").map((row) => ({
    id: String(row.id || ""),
    createdAt: Number(row.created_at || 0),
    activityEnd: Number(row.last_activity_at || row.updated_at || 0),
  })).filter((s) => s.id && s.createdAt > 0);
}

function workbuddyWindowMatchedSession(sessions, startedMs) {
  let best = null;
  for (const s of sessions) {
    if (s.createdAt <= startedMs + 5000 && startedMs <= s.activityEnd) {
      if (!best || s.createdAt > best.createdAt) best = s;
    }
  }
  return best ? best.id : null;
}

function expectedWorkbuddy() {
  if (!providerEnabled("workbuddy_local")) return skipped("workbuddy", "provider disabled");
  const autoRoots = [];
  const configDir = (process.env.WORKBUDDY_CONFIG_DIR || "").trim();
  if (configDir) autoRoots.push(configDir);
  autoRoots.push(`${home}/.workbuddy`);
  const roots = configuredRoots("workbuddy_local", autoRoots);
  if (roots.length === 0) return skipped("workbuddy", "no configured directory found");
  const expected = new Map();
  const usageTotalFromOpenAi = (usage) => {
    if (!usage || typeof usage !== "object") return 0;
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? 0);
    const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? 0);
    const cacheRead = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0);
    const input = Math.max(prompt - cacheRead, 0);
    const outputTokens = Math.max(completion, 0);
    return input + outputTokens + cacheRead;
  };
  const spanTotal = (span) => {
    if (span.type !== "generation" || typeof span.toolOutput !== "string" || !span.toolOutput.trim()) return 0;
    let output;
    try { output = JSON.parse(span.toolOutput); } catch { return 0; }
    const response = Array.isArray(output) ? output[0] : (output && typeof output === "object" ? output : null);
    return usageTotalFromOpenAi(response && response.usage);
  };
  for (const root of roots) {
    const sessions = workbuddySessionRows(root);

    // 1) Per-session project transcripts (projects/<slug>/<sessionId>.jsonl):
    //    authoritative — rawUsage on message AND function_call records,
    //    timestamp-less records skipped. Their session ids suppress traces.
    const transcriptSessions = new Set();
    const projectsDir = join(root, "projects");
    if (existsSync(projectsDir)) {
      for (const slug of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!slug.isDirectory()) continue;
        for (const name of readdirSync(join(projectsDir, slug.name))) {
          if (!name.endsWith(".jsonl") || name.startsWith("trace_")) continue;
          const sid = name.replace(/\.jsonl$/, "");
          transcriptSessions.add(sid);
          for (const line of readFileSync(join(projectsDir, slug.name, name), "utf8").split("\n")) {
            if (!line.trim()) continue;
            let rec;
            try { rec = JSON.parse(line); } catch { continue; }
            const ts = Number(rec.timestamp);
            if (!Number.isFinite(ts) || ts <= 0) continue;
            const total = usageTotalFromOpenAi(rec.providerData && rec.providerData.rawUsage);
            if (total > 0) addTotal(expected, localDay(new Date(ts)), total);
          }
        }
      }
    }

    // 2) Traces: legacy .json single documents + streaming .jsonl. A trace
    //    whose session has a transcript emits nothing.
    const tracesDir = join(root, "traces");
    if (!existsSync(tracesDir)) continue;
    for (const pid of readdirSync(tracesDir, { withFileTypes: true })) {
      if (!pid.isDirectory()) continue;
      const pidDir = join(tracesDir, pid.name);
      for (const name of readdirSync(pidDir)) {
        if (!name.startsWith("trace_")) continue;
        if (!name.endsWith(".json") && !name.endsWith(".jsonl")) continue;
        const file = join(pidDir, name);
        if (name.endsWith(".jsonl")) {
          // Streaming format (2026-10 WorkBuddy migration).
          let traceStart = null, traceEnd = null;
          const spans = [];
          for (const line of readFileSync(file, "utf8").split("\n")) {
            if (!line.trim()) continue;
            let rec;
            try { rec = JSON.parse(line); } catch { continue; }
            if (rec.type === "trace_start" && rec.trace) traceStart = rec.trace;
            else if (rec.type === "trace_end" && rec.trace) traceEnd = rec.trace;
            else if (rec.type === "span_end" && rec.span && rec.span.type === "generation") spans.push(rec.span);
          }
          if (!traceStart && !traceEnd) continue;   // empty/partial: skip
          if (!traceEnd) continue;                  // still running
          if (traceEnd.status !== "ok") continue;
          const startedMs = Date.parse((traceStart && traceStart.startedAt) || traceEnd.startedAt || "");
          if (!Number.isFinite(startedMs)) continue;
          // Suppression mirrors the collector: window-matched id (deleted_at
          // and cwd ignored) — the emitted id may have degraded to workerPid.
          const windowId = workbuddyWindowMatchedSession(sessions, startedMs);
          if (windowId && transcriptSessions.has(windowId)) continue;
          const day = localDay(new Date(startedMs));
          for (const span of spans) {
            const total = spanTotal(span);
            if (total > 0) addTotal(expected, day, total);
          }
        } else {
          // Legacy single document.
          let data;
          try { data = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
          const trace = data.trace;
          if (!trace || typeof trace !== "object") continue;
          if (trace.status !== "ok") continue;
          const startedMs = Date.parse(trace.startedAt || "");
          const day = Number.isFinite(startedMs)
            ? localDay(new Date(startedMs))
            : localDay(statSync(file).mtime);
          // Suppression mirrors the collector's legacy path: emitted
          // sessionId (trace-level → sessions/<pid>.json → workerPid).
          let sessionId = typeof trace.sessionId === "string" && trace.sessionId.trim() ? trace.sessionId : "";
          if (!sessionId) {
            const sessionsFile = join(root, "sessions", `${pid.name}.json`);
            if (existsSync(sessionsFile)) {
              try { sessionId = JSON.parse(readFileSync(sessionsFile, "utf8")).sessionId || ""; } catch { /* degrade */ }
            }
          }
          if (sessionId && transcriptSessions.has(sessionId)) continue;
          let emitted = false;
          for (const span of Array.isArray(data.spans) ? data.spans : []) {
            const total = spanTotal(span);
            if (total <= 0) continue;
            addTotal(expected, day, total);
            emitted = true;
          }
          if (!emitted && trace.modelInfo && typeof trace.modelInfo === "object") {
            const input = Number(trace.modelInfo.totalInputTokens || 0);
            const outputTokens = Number(trace.modelInfo.totalOutputTokens || 0);
            const cacheRead = Number(trace.modelInfo.totalCachedTokens || 0);
            const total = input + outputTokens + cacheRead;
            if (total > 0) addTotal(expected, day, total);
          }
        }
      }
    }
  }
  return verified("workbuddy", expected);
}

function expectedKimi() {
  if (!providerEnabled("kimi_local")) return skipped("kimi", "provider disabled");
  // Mirror the collector hook: KIMI_DESKTOP_DIR, when set and existing,
  // fully overrides canonical auto discovery (kimi_local::auto_roots).
  const desktopDir = (process.env.KIMI_DESKTOP_DIR || "").trim();
  const autoRoots = [];
  if (desktopDir && existsSync(desktopDir)) {
    autoRoots.push(desktopDir);
  } else {
    const dataDir = process.env.APPDATA
      ? process.env.APPDATA
      : `${home}/Library/Application Support`;
    autoRoots.push(join(dataDir, "kimi-desktop", "daimon-share", "daimon", "runtime", "kimi-code", "home"));
  }
  const roots = configuredRoots("kimi_local", autoRoots);
  if (roots.length === 0) return skipped("kimi", "no configured directory found");
  const expected = new Map();
  const walkWire = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkWire(full);
      } else if (entry.isFile() && entry.name === "wire.jsonl") {
        // Only usage.record lines are counted; conversation plaintext is never read.
        let content;
        try { content = readFileSync(full, "utf8"); } catch { continue; }
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          let row;
          try { row = JSON.parse(trimmed); } catch { continue; }
          if (row.type !== "usage.record" || !row.usage || typeof row.usage !== "object") continue;
          const input = Number(row.usage.inputOther ?? row.usage.input ?? row.usage.input_tokens ?? 0);
          const output = Number(row.usage.output ?? row.usage.output_tokens ?? 0);
          const cacheRead = Number(row.usage.inputCacheRead ?? row.usage.cache_read_tokens ?? 0);
          const cacheWrite = Number(row.usage.inputCacheCreation ?? row.usage.cache_write_tokens ?? 0);
          const total = input + output + cacheRead + cacheWrite;
          if (total <= 0) continue;
          const time = Number(row.time);
          const day = Number.isFinite(time) && time > 1_000_000_000_000
            ? localDay(new Date(time))
            : localDay(statSync(full).mtime);
          addTotal(expected, day, total);
        }
      }
    }
  };
  for (const root of roots) walkWire(root);
  return verified("kimi", expected);
}

function expectedAntigravity() {
  const incompatible = externalProviderCanMatch("antigravity_local", "antigravity");
  if (incompatible) return incompatible;
  // The antigravity subcommand shipped in ccusage 20.0.30.
  requireCcusageVersion("20.0.30", "the Antigravity report");
  const raw = runCcusage(["antigravity", "daily", "--json", "--timezone", TIMEZONE, "--offline"]);
  const parsed = JSON.parse(raw);
  const expected = new Map();
  for (const row of parsed.daily || []) {
    // ccusage's totalTokens includes reasoning tokens; rebuild the ATL total
    // (reasoning is diagnostic-only and excluded from the ranking total).
    const total = Number(row.inputTokens || 0)
      + Number(row.outputTokens || 0)
      + Number(row.cacheReadTokens || 0)
      + Number(row.cacheCreationTokens || 0);
    const dateValue = row.period || row.date;
    if (total > 0 && dateValue) expected.set(normalizeDay(dateValue), total);
  }
  return verified("antigravity", expected);
}

function comparableDays(actual, expected) {
  const today = localDay();
  return [...new Set([...actual.keys(), ...expected.keys()])]
    .filter((day) => includeToday || day < today)
    .sort();
}

function compareProvider(name, actual, expected) {
  const mismatches = [];
  let matchedDays = 0;
  let preservedDays = 0;
  let preservedTokens = 0;
  for (const day of comparableDays(actual, expected)) {
    const actualTotal = actual.get(day) || 0;
    const expectedTotal = expected.get(day) || 0;
    if (expectedTotal === 0 && actualTotal > 0) {
      // Day exists only in the collector's preserved history: the source no
      // longer reports it (rotated/deleted local logs, retention pruning), so
      // the external reference tool cannot see it. Tolerated by design, but
      // never silently.
      preservedDays += 1;
      preservedTokens += actualTotal;
      continue;
    }
    if (actualTotal === expectedTotal && expectedTotal > 0) {
      matchedDays += 1;
      continue;
    }
    mismatches.push({ day, actual: actualTotal, expected: expectedTotal, delta: actualTotal - expectedTotal });
  }

  if (mismatches.length > 0) {
    console.error(`\n${name} mismatch:`);
    for (const row of mismatches.slice(0, 20)) {
      console.error(
        `  ${row.day} collector=${row.actual} ccusage=${row.expected} delta=${row.delta}`
      );
    }
    if (mismatches.length > 20) {
      console.error(`  ... ${mismatches.length - 20} more mismatches`);
    }
    return false;
  }

  const preservedNote = preservedDays > 0
    ? ` (+${preservedDays} preserved day(s), ${preservedTokens} tokens, no longer visible to the external reference — tolerated)`
    : "";
  console.log(`${name}: matched ${matchedDays} completed day(s)${preservedNote}`);
  return true;
}

/// Codex oracle split: ccusage cannot read Codex's compressed session
/// archives (`.jsonl.zst`, the bulk of a long-lived machine's corpus), so its
/// daily totals only cover the surviving plain files. Exact parity is
/// therefore checked against the collector's own accounting of that plain
/// subset (via the repo's codex layout harness), while the stored totals are
/// required to be a per-day superset of ccusage — the compressed archives'
/// contribution shows up as a reported surplus, never silently.
function compareCodexSubset(name, actual, expected, plainPerDay) {
  const mismatches = [];
  let matchedDays = 0;
  let preservedDays = 0;
  let preservedTokens = 0;
  let archiveDays = 0;
  let archiveTokens = 0;
  const today = localDay();
  const days = [...new Set([...actual.keys(), ...expected.keys(), ...plainPerDay.keys()])]
    .filter((day) => includeToday || day < today)
    .sort();
  for (const day of days) {
    const storeTotal = actual.get(day) || 0;
    const ccusageTotal = expected.get(day) || 0;
    const plainTotal = plainPerDay.get(day) || 0;
    if (ccusageTotal === 0 && plainTotal === 0) {
      if (storeTotal > 0) {
        preservedDays += 1;
        preservedTokens += storeTotal;
      }
      continue;
    }
    if (plainTotal !== ccusageTotal) {
      mismatches.push({
        day,
        actual: plainTotal,
        expected: ccusageTotal,
        delta: plainTotal - ccusageTotal,
        kind: "plain-subset parity"
      });
      continue;
    }
    if (storeTotal < ccusageTotal) {
      mismatches.push({
        day,
        actual: storeTotal,
        expected: ccusageTotal,
        delta: storeTotal - ccusageTotal,
        kind: "store below ccusage"
      });
      continue;
    }
    if (storeTotal === ccusageTotal) {
      matchedDays += 1;
    } else {
      archiveDays += 1;
      archiveTokens += storeTotal - ccusageTotal;
    }
  }

  if (mismatches.length > 0) {
    console.error(`\n${name} mismatch:`);
    for (const row of mismatches.slice(0, 20)) {
      console.error(
        `  ${row.day} [${row.kind}] collector=${row.actual} ccusage=${row.expected} delta=${row.delta}`
      );
    }
    if (mismatches.length > 20) {
      console.error(`  ... ${mismatches.length - 20} more mismatches`);
    }
    return false;
  }

  const preservedNote = preservedDays > 0
    ? ` (+${preservedDays} preserved day(s), ${preservedTokens} tokens, no longer visible to the external reference — tolerated)`
    : "";
  const archiveNote = archiveDays > 0
    ? ` (+${archiveDays} compressed-archive day(s), ${archiveTokens} tokens invisible to ccusage — tolerated)`
    : "";
  console.log(`${name}: matched ${matchedDays} completed day(s) on the plain-file subset${preservedNote}${archiveNote}`);
  return true;
}

function compareExpected(name, actual, result) {
  if (!result.verified) {
    const message = `${name}: SKIPPED (${result.reason})`;
    if (explicitlySelected) {
      console.error(message);
      return false;
    }
    console.log(message);
    return true;
  }
  if (result.plainPerDay) {
    return compareCodexSubset(name, actual, result.expected, result.plainPerDay);
  }
  return compareProvider(name, actual, result.expected);
}

function main() {
  if (![...selectedProviders].every((provider) => ["claude", "codex", "opencode", "hermes", "openclaw", "mimocode", "workbuddy", "kimi", "antigravity"].includes(provider))) {
    throw new Error("Unsupported --provider value. Use claude, codex, opencode, hermes, openclaw, mimocode, workbuddy, kimi, antigravity, or combinations.");
  }

  // scan persists into the local usage database (refusing on provider errors),
  // and the per-day totals are then read back through the CLI's JSON contract.
  run("cargo", ["run", "-q", "-p", "atl-collector", "--", "scan"], {
    env: { ...process.env, TZ: TIMEZONE }
  });
  const providerLocalIds = {
    claude: "claude_code_local",
    codex: "codex_local",
    opencode: "opencode_local",
    hermes: "hermes_local",
    openclaw: "openclaw_local",
    mimocode: "mimocode_local",
    workbuddy: "workbuddy_local",
    kimi: "kimi_local",
    antigravity: "antigravity_local"
  };
  const actual = {};
  for (const provider of selectedProviders) {
    actual[provider] = collectorDailyTotals(providerLocalIds[provider]);
  }
  let ok = true;

  if (selectedProviders.has("claude")) {
    ok = compareExpected("claude", actual.claude, expectedClaude()) && ok;
  }
  if (selectedProviders.has("codex")) {
    ok = compareExpected("codex", actual.codex, expectedCodex()) && ok;
  }
  if (selectedProviders.has("opencode")) {
    ok = compareExpected("opencode", actual.opencode, expectedOpenCode()) && ok;
  }
  if (selectedProviders.has("hermes")) {
    ok = compareExpected("hermes", actual.hermes, expectedHermes()) && ok;
  }
  if (selectedProviders.has("openclaw")) {
    ok = compareExpected("openclaw", actual.openclaw, expectedOpenClaw()) && ok;
  }
  if (selectedProviders.has("mimocode")) {
    ok = compareExpected("mimocode", actual.mimocode, expectedMiMo()) && ok;
  }
  if (selectedProviders.has("workbuddy")) {
    ok = compareExpected("workbuddy", actual.workbuddy, expectedWorkbuddy()) && ok;
  }
  if (selectedProviders.has("kimi")) {
    ok = compareExpected("kimi", actual.kimi, expectedKimi()) && ok;
  }
  if (selectedProviders.has("antigravity")) {
    ok = compareExpected("antigravity", actual.antigravity, expectedAntigravity()) && ok;
  }

  if (!ok) process.exit(1);
  console.log(includeToday ? "Compared including today." : "Compared completed days only. Use --include-today to include active logs.");
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
