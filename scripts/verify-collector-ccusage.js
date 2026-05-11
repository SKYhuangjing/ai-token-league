#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanUsage } from "../src/collector/core.js";

const execFileAsync = promisify(execFile);

export async function runVerification(options = {}) {
  const day = options.day || localDay();
  const codexRoot = options.codexRoot || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const claudeConfigDir = options.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const claudeRoot = options.claudeRoot || path.join(claudeConfigDir, "projects");
  if (!options.skipCodex && !fs.existsSync(codexRoot)) throw new Error(`Codex root not found: ${codexRoot}`);
  if (!options.skipClaude && !fs.existsSync(claudeRoot)) throw new Error(`Claude projects root not found: ${claudeRoot}`);
  const local = await collectLocalUsage({ day, codexRoot, claudeRoot });
  const [codexCcusage, claudeCcusage] = await Promise.all([
    options.skipCodex ? null : loadCodexCcusage({ day, codexRoot, jsonFile: options.codexCcusageJson }),
    options.skipClaude ? null : loadClaudeCcusage({ day, claudeConfigDir, jsonFile: options.claudeCcusageJson })
  ]);
  const checks = [];
  if (!options.skipCodex) checks.push(compareCodex(local.codex, codexCcusage));
  if (!options.skipClaude) checks.push(compareClaude(local.claude, claudeCcusage));
  return {
    day,
    success: checks.every((check) => check.matches),
    checks,
    local,
    ccusage: {
      codex: codexCcusage,
      claude: claudeCcusage
    }
  };
}

export function compareCodex(local, ccusage) {
  const fieldChecks = [
    fieldCheck("totalTokens", local.totalTokens, ccusage.totalTokens),
    fieldCheck("inputTokens", local.inputTokens, ccusage.inputTokens),
    fieldCheck("outputTokens", local.outputTokens, ccusage.outputTokens),
    fieldCheck("cacheReadTokens", local.cacheReadTokens, ccusage.cacheReadTokens),
    fieldCheck("cacheWriteTokens", local.cacheWriteTokens, ccusage.cacheWriteTokens),
    fieldCheck("reasoningTokens", local.reasoningTokens, ccusage.reasoningTokens)
  ];
  return {
    providerId: "codex_local",
    matches: fieldChecks.every((item) => item.matches),
    fieldChecks,
    note: "For @ccusage/codex --json, raw inputTokens is normalized to table Input by subtracting cachedInputTokens."
  };
}

export function compareClaude(local, ccusage) {
  const fieldChecks = [
    fieldCheck("totalTokens", local.totalTokens, ccusage.totalTokens),
    fieldCheck("inputTokens", local.inputTokens, ccusage.inputTokens),
    fieldCheck("outputTokens", local.outputTokens, ccusage.outputTokens),
    fieldCheck("cacheReadTokens", local.cacheReadTokens, ccusage.cacheReadTokens),
    fieldCheck("cacheWriteTokens", local.cacheWriteTokens, ccusage.cacheWriteTokens)
  ];
  return {
    providerId: "claude_code_local",
    matches: fieldChecks.every((item) => item.matches),
    fieldChecks
  };
}

async function collectLocalUsage({ day, codexRoot, claudeRoot }) {
  const result = await scanUsage({
    participantId: "ccusage-verify",
    providerRootsOnly: true,
    providerRoots: {
      codex_local: codexRoot,
      claude_code_local: claudeRoot
    },
    providerEnabled: {
      codex_local: true,
      claude_code_local: true,
      cursor_dashboard_usage: false
    },
    workdirAliases: {}
  });
  const rows = result.items.filter((item) => item.day === day);
  return {
    codex: summarizeProvider(rows, "codex_local"),
    claude: summarizeProvider(rows, "claude_code_local")
  };
}

function summarizeProvider(rows, providerId) {
  const summary = {
    providerId,
    rows: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    models: {}
  };
  for (const item of rows.filter((row) => row.providerId === providerId)) {
    summary.rows += 1;
    addTokenFields(summary, item);
    const model = item.model || "unknown";
    summary.models[model] ||= emptyModelSummary();
    summary.models[model].rows += 1;
    addTokenFields(summary.models[model], item);
  }
  return summary;
}

function emptyModelSummary() {
  return {
    rows: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };
}

function addTokenFields(target, item) {
  for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens"]) {
    target[field] += Number(item[field] || 0);
  }
}

async function loadCodexCcusage({ day, codexRoot, jsonFile }) {
  const data = jsonFile
    ? JSON.parse(fs.readFileSync(jsonFile, "utf8"))
    : await runJsonCommand("npx", ["--yes", "@ccusage/codex@latest", "daily", "--json", "--since", day, "--until", day], {
        CODEX_HOME: codexRoot
      });
  return normalizeCodexDaily(data);
}

async function loadClaudeCcusage({ day, claudeConfigDir, jsonFile }) {
  const ccusageDay = day.replaceAll("-", "");
  const data = jsonFile
    ? JSON.parse(fs.readFileSync(jsonFile, "utf8"))
    : await runJsonCommand("npx", ["--yes", "ccusage@latest", "daily", "--json", "--since", ccusageDay, "--until", ccusageDay], {
        CLAUDE_CONFIG_DIR: claudeConfigDir
      });
  return normalizeClaudeDaily(data);
}

async function runJsonCommand(command, args, env) {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(command, args, {
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024 * 16
    }));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Missing npx. Install Node.js/npm before collector ccusage verification.");
    }
    if (command === "npx") throw new Error(`Failed to run ${args.join(" ")}. Check npm network access or cached package availability. ${error.message}`);
    throw error;
  }
  return JSON.parse(stdout);
}

function normalizeCodexDaily(data) {
  const row = firstDailyRow(data);
  const rawInputTokens = tokenNumber(row.inputTokens);
  const cacheReadTokens = tokenNumber(row.cachedInputTokens ?? row.cacheReadTokens);
  const cacheWriteTokens = tokenNumber(row.cacheCreationTokens ?? row.cacheWriteTokens);
  return {
    inputTokens: Math.max(0, rawInputTokens - cacheReadTokens - cacheWriteTokens),
    rawInputTokens,
    outputTokens: tokenNumber(row.outputTokens),
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: tokenNumber(row.reasoningOutputTokens ?? row.reasoningTokens),
    totalTokens: tokenNumber(row.totalTokens),
    models: row.models || row.modelBreakdowns || {}
  };
}

function normalizeClaudeDaily(data) {
  const row = firstDailyRow(data);
  return {
    inputTokens: tokenNumber(row.inputTokens),
    outputTokens: tokenNumber(row.outputTokens),
    cacheReadTokens: tokenNumber(row.cacheReadTokens),
    cacheWriteTokens: tokenNumber(row.cacheCreationTokens ?? row.cacheWriteTokens),
    reasoningTokens: tokenNumber(row.reasoningOutputTokens ?? row.reasoningTokens),
    totalTokens: tokenNumber(row.totalTokens),
    models: row.modelBreakdowns || row.models || {}
  };
}

function firstDailyRow(data) {
  return Array.isArray(data?.daily) && data.daily.length ? data.daily[0] : {};
}

function fieldCheck(field, localValue, ccusageValue) {
  const local = tokenNumber(localValue);
  const ccusage = tokenNumber(ccusageValue);
  return {
    field,
    local,
    ccusage,
    diff: local - ccusage,
    matches: local === ccusage
  };
}

function tokenNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function localDay(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--skip-codex") options.skipCodex = true;
    else if (arg === "--skip-claude") options.skipClaude = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      options[key] = argv[i + 1];
      i += 1;
    }
  }
  return options;
}

function printHuman(result) {
  console.log(`ccusage verification for ${result.day}: ${result.success ? "PASS" : "FAIL"}`);
  for (const check of result.checks) {
    console.log(`\n${check.providerId}: ${check.matches ? "PASS" : "FAIL"}`);
    console.log(formatTable(
      ["Date", "Metric", "Local", "ccusage", "Diff", "Status"],
      check.fieldChecks.map((field) => [
        result.day,
        field.field,
        formatInteger(field.local),
        formatInteger(field.ccusage),
        formatSignedInteger(field.diff),
        field.matches ? "OK" : "DIFF"
      ])
    ));
    if (check.note) console.log(`  ${check.note}`);
  }
}

function formatTable(headers, rows) {
  const allRows = [headers, ...rows];
  const widths = headers.map((_, index) => Math.max(...allRows.map((row) => String(row[index] ?? "").length)));
  const border = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  const line = (row) => `|${row.map((cell, index) => {
    const value = String(cell ?? "");
    const alignRight = ["Local", "ccusage", "Diff"].includes(headers[index]);
    const padded = alignRight ? value.padStart(widths[index]) : value.padEnd(widths[index]);
    return ` ${padded} `;
  }).join("|")}|`;
  return [border, line(headers), border, ...rows.map(line), border].join("\n");
}

function formatInteger(value) {
  return tokenNumber(value).toLocaleString("en-US");
}

function formatSignedInteger(value) {
  const n = tokenNumber(value);
  if (n === 0) return "0";
  return `${n > 0 ? "+" : "-"}${Math.abs(n).toLocaleString("en-US")}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runVerification(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  if (!result.success) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
