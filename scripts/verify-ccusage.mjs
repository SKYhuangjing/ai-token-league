#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const TIMEZONE = "Asia/Singapore";
const includeToday = process.argv.includes("--include-today");
const providers = new Set(
  process.argv
    .filter((arg) => arg.startsWith("--provider="))
    .flatMap((arg) => arg.slice("--provider=".length).split(","))
    .map((arg) => arg.trim())
    .filter(Boolean)
);
const selectedProviders = providers.size > 0 ? providers : new Set(["claude", "codex"]);

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

function localDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
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
    codex: new Map()
  };
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d{4}-\d{2}-\d{2})\s+(\S+)\s+.+?\s+tokens=(\d+)\s*$/);
    if (!match) continue;
    const [, day, providerId, totalRaw] = match;
    const total = Number(totalRaw);
    if (providerId === "claude_code_local") addTotal(byProvider.claude, day, total);
    if (providerId === "codex_local") addTotal(byProvider.codex, day, total);
  }
  return byProvider;
}

function expectedClaude() {
  requireCommand("ccusage");
  const raw = run("ccusage", ["daily", "--json", "--timezone", TIMEZONE, "--offline"]);
  const parsed = JSON.parse(raw);
  const expected = new Map();
  for (const row of parsed.daily || []) {
    const total = Number(row.totalTokens || 0);
    if (total > 0) expected.set(normalizeDay(row.date), total);
  }
  return expected;
}

function expectedCodex() {
  requireCommand("ccusage-codex");
  const raw = run("ccusage-codex", ["daily", "--json", "--timezone", TIMEZONE, "--offline"]);
  const parsed = JSON.parse(raw);
  const expected = new Map();
  for (const row of parsed.daily || []) {
    const total = Number(row.totalTokens || 0);
    if (total > 0) expected.set(normalizeDay(row.date), total);
  }
  return expected;
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

function main() {
  if (![...selectedProviders].every((provider) => ["claude", "codex"].includes(provider))) {
    throw new Error("Unsupported --provider value. Use claude, codex, or claude,codex.");
  }

  const collectorOutput = run("cargo", ["run", "-p", "atl-collector", "--", "scan"]);
  const actual = parseCollectorScan(collectorOutput);
  let ok = true;

  if (selectedProviders.has("claude")) {
    ok = compareProvider("claude", actual.claude, expectedClaude()) && ok;
  }
  if (selectedProviders.has("codex")) {
    ok = compareProvider("codex", actual.codex, expectedCodex()) && ok;
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
