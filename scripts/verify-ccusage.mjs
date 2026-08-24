#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
const selectedProviders = providers.size > 0 ? providers : new Set(["claude", "codex", "opencode", "hermes", "openclaw", "mimocode", "workbuddy", "kimi"]);
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

function requireCcusageVersion(minimum) {
  requireCommand("ccusage");
  const actualText = run("ccusage", ["--version"]).trim();
  const actual = parseSemver(actualText);
  const required = parseSemver(minimum);
  if (!actual || !required) {
    throw new Error(`Cannot parse ccusage version: ${actualText}`);
  }
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > required[index]) return;
    if (actual[index] < required[index]) {
      throw new Error(
        `ccusage ${minimum}+ is required for Codex rollout/subagent deduplication; found ${actualText}`
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

function parseCollectorScan(stdout) {
  const byProvider = {
    claude: new Map(),
    codex: new Map(),
    opencode: new Map(),
    hermes: new Map(),
    openclaw: new Map(),
    mimocode: new Map(),
    workbuddy: new Map(),
    kimi: new Map()
  };
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d{4}-\d{2}-\d{2})\s+(\S+)\s+.+?\s+tokens=(\d+)\s*$/);
    if (!match) continue;
    const [, day, providerId, totalRaw] = match;
    const total = Number(totalRaw);
    if (providerId === "claude_code_local") addTotal(byProvider.claude, day, total);
    if (providerId === "codex_local") addTotal(byProvider.codex, day, total);
    if (providerId === "opencode_local") addTotal(byProvider.opencode, day, total);
    if (providerId === "hermes_local") addTotal(byProvider.hermes, day, total);
    if (providerId === "openclaw_local") addTotal(byProvider.openclaw, day, total);
    if (providerId === "mimocode_local") addTotal(byProvider.mimocode, day, total);
    if (providerId === "workbuddy_local") addTotal(byProvider.workbuddy, day, total);
    if (providerId === "kimi_local") addTotal(byProvider.kimi, day, total);
  }
  return byProvider;
}

function expectedClaude() {
  const incompatible = externalProviderCanMatch("claude_code_local", "claude");
  if (incompatible) return incompatible;
  requireCommand("ccusage");
  const raw = run("ccusage", ["claude", "daily", "--json", "--timezone", TIMEZONE, "--offline"]);
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
  const raw = run("ccusage", ["codex", "daily", "--json", "--timezone", TIMEZONE, "--offline"]);
  const parsed = JSON.parse(raw);
  const expected = new Map();
  for (const row of parsed.daily || []) {
    const total = Number(row.totalTokens || 0);
    const dateValue = row.period || row.date;
    if (total > 0 && dateValue) expected.set(normalizeDay(dateValue), total);
  }
  return verified("codex", expected);
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

function expectedWorkbuddy() {
  if (!providerEnabled("workbuddy_local")) return skipped("workbuddy", "provider disabled");
  const autoRoots = [];
  const configDir = (process.env.WORKBUDDY_CONFIG_DIR || "").trim();
  if (configDir) autoRoots.push(configDir);
  autoRoots.push(`${home}/.workbuddy`);
  const roots = configuredRoots("workbuddy_local", autoRoots);
  if (roots.length === 0) return skipped("workbuddy", "no configured directory found");
  const expected = new Map();
  for (const root of roots) {
    const tracesDir = join(root, "traces");
    if (!existsSync(tracesDir)) continue;
    for (const pid of readdirSync(tracesDir, { withFileTypes: true })) {
      if (!pid.isDirectory()) continue;
      const pidDir = join(tracesDir, pid.name);
      for (const name of readdirSync(pidDir)) {
        if (!name.startsWith("trace_") || !name.endsWith(".json")) continue;
        const file = join(pidDir, name);
        let data;
        try { data = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
        const trace = data.trace;
        if (!trace || typeof trace !== "object") continue;
        if (trace.status !== "ok") continue;
        const startedMs = Date.parse(trace.startedAt || "");
        const day = Number.isFinite(startedMs)
          ? localDay(new Date(startedMs))
          : localDay(statSync(file).mtime);
        let emitted = false;
        for (const span of Array.isArray(data.spans) ? data.spans : []) {
          if (span.type !== "generation" || typeof span.toolOutput !== "string" || !span.toolOutput.trim()) continue;
          let output;
          try { output = JSON.parse(span.toolOutput); } catch { continue; }
          const response = Array.isArray(output) ? output[0] : (output && typeof output === "object" ? output : null);
          const usage = response && response.usage;
          if (!usage || typeof usage !== "object") continue;
          const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? 0);
          const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? 0);
          const cacheRead = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0);
          const input = Math.max(prompt - cacheRead, 0);
          const outputTokens = Math.max(completion, 0);
          const total = input + outputTokens + cacheRead;
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
  return verified("workbuddy", expected);
}

function expectedKimi() {
  if (!providerEnabled("kimi_local")) return skipped("kimi", "provider disabled");
  const autoRoots = [];
  const desktopDir = (process.env.KIMI_DESKTOP_DIR || "").trim();
  if (desktopDir) autoRoots.push(desktopDir);
  const dataDir = process.env.APPDATA
    ? process.env.APPDATA
    : `${home}/Library/Application Support`;
  autoRoots.push(join(dataDir, "kimi-desktop", "daimon-share", "daimon", "runtime", "kimi-code", "home"));
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

function comparableDays(actual, expected) {
  const today = localDay();
  return [...new Set([...actual.keys(), ...expected.keys()])]
    .filter((day) => includeToday || day < today)
    .sort();
}

function compareProvider(name, actual, expected) {
  const mismatches = [];
  for (const day of comparableDays(actual, expected)) {
    const actualTotal = actual.get(day) || 0;
    const expectedTotal = expected.get(day) || 0;
    if (actualTotal !== expectedTotal) {
      mismatches.push({ day, actual: actualTotal, expected: expectedTotal, delta: actualTotal - expectedTotal });
    }
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

  console.log(`${name}: matched ${comparableDays(actual, expected).length} completed day(s)`);
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
  return compareProvider(name, actual, result.expected);
}

function main() {
  if (![...selectedProviders].every((provider) => ["claude", "codex", "opencode", "hermes", "openclaw", "mimocode", "workbuddy", "kimi"].includes(provider))) {
    throw new Error("Unsupported --provider value. Use claude, codex, opencode, hermes, openclaw, mimocode, workbuddy, kimi, or combinations.");
  }

  const collectorOutput = run("cargo", ["run", "-p", "atl-collector", "--", "scan"], {
    env: { ...process.env, TZ: TIMEZONE }
  });
  const actual = parseCollectorScan(collectorOutput);
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

  if (!ok) process.exit(1);
  console.log(includeToday ? "Compared including today." : "Compared completed days only. Use --include-today to include active logs.");
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
