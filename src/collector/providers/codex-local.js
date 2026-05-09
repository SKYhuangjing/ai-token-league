import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { dayFromRecord, deepFindString, readJsonLinesAsync, sourceMetadataAsync, walkFiles } from "./common.js";

export const codexLocalProvider = {
  id: "codex_local",
  toolCode: "codex",
  version: "0.1.2",

  roots(config = {}) {
    if (config.providerRootsOnly && config.providerRoots?.codex_local) return normalizeCustomRoots(config.providerRoots.codex_local);
    const auto = autoRoots(config);
    const customRoots = normalizeCustomRoots(config.providerRoots?.codex_local);
    return [...new Set([...auto, ...customRoots])];
  },

  autoRoots(config = {}) {
    if (config.providerRootsOnly) return [];
    const realRoots = [process.env.CODEX_HOME, path.join(os.homedir(), ".codex")].filter(Boolean);
    const existingRealRoots = realRoots.filter((root) => fs.existsSync(root));
    return existingRealRoots.length ? existingRealRoots : [path.resolve("samples/codex")];
  },

  manualRoots(config = {}) {
    return normalizeCustomRoots(config.providerRoots?.codex_local);
  },

  detect(config) {
    const roots = this.roots(config).filter((root) => fs.existsSync(root));
    return { providerId: this.id, detected: roots.length > 0, roots };
  },

  scanSessions(config) {
    if (config.providerEnabled?.codex_local === false) return [];
    const ignored = config.providerIgnoredAutoSources?.codex_local || [];
    const auto = this.autoRoots(config).filter(r => !ignored.includes(r));
    const manual = this.manualRoots(config);
    return [...auto, ...manual].flatMap((root) => walkFiles(root, (file) => file.endsWith(".jsonl")));
  },

  async parseUsage(file) {
    const stats = await fs.promises.stat(file);
    const source = await sourceMetadataAsync(file, this.id, this.version);
    const rows = await readJsonLinesAsync(file);
    const events = [];
    let sessionCwd = "";
    let sessionId = path.basename(file);
    let currentModel = "";
    let previousCumulativeTotal = 0;
    for (const row of rows) {
      if (row.type === "session_meta" && row.payload) {
        sessionCwd = row.payload.cwd || sessionCwd;
        sessionId = row.payload.id || sessionId;
        break;
      }
    }
    for (const row of rows) {
      currentModel = deepFindString(row, ["model", "model_slug", "model_name"]) || currentModel;
      const usage = extractUsage(row);
      if (!usage) continue;
      const normalizedModel = normalizeCodexModel(currentModel);
      if (!normalizedModel) continue;
      const totalTokens = usage.deltaTotal(previousCumulativeTotal);
      if (!totalTokens) continue;
      events.push({
        providerId: this.id,
        providerVersion: this.version,
        toolCode: this.toolCode,
        sourceKind: "local_log",
        sourceQuality: usage.quality,
        sessionId,
        day: dayFromRecord(row, stats.mtimeMs),
        workdirCandidate: sessionCwd || deepFindString(row, ["cwd", "workdir", "working_directory", "project_path"]) || process.cwd(),
        model: normalizedModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        reasoningTokens: usage.reasoningTokens,
        totalTokens,
        ...source
      });
      if (usage.cumulativeTotal) previousCumulativeTotal = usage.cumulativeTotal;
    }
    return events;
  },

  reportHealth(config) {
    const auto = this.autoRoots(config);
    const manual = this.manualRoots(config);
    const ignored = config.providerIgnoredAutoSources?.codex_local || [];
    const allRoots = [...auto, ...manual];
    const sources = [
      ...auto.map(r => ({ kind: "auto", id: r, label: shortenPath(r), path: r, ignored: ignored.includes(r) })),
      ...manual.map(r => ({ kind: "manual", id: r, label: shortenPath(r), path: r, ignored: false }))
    ];
    return {
      providerId: this.id,
      toolCode: this.toolCode,
      detected: allRoots.length > 0,
      enabled: config.providerEnabled?.codex_local !== false,
      roots: allRoots,
      sources,
      lastCheckedAt: new Date().toISOString()
    };
  }
};

function normalizeCodexModel(model) {
  const value = String(model || "").trim();
  if (!value || value === "codex-default") return "";
  return value;
}

function normalizeCustomRoots(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function shortenPath(p) {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function extractUsage(row) {
  const info = row?.payload?.type === "token_count" ? row.payload.info : null;
  const sampleUsage = row?.token_count || row?.usage || null;
  const usage = info?.last_token_usage || sampleUsage;
  if (!usage) return null;

  const rawInputTokens = Number(usage.input_tokens || usage.inputTokens || usage.prompt_tokens || 0);
  const outputTokens = Number(usage.output_tokens || usage.outputTokens || usage.completion_tokens || 0);
  const cacheReadTokens = Number(usage.cached_input_tokens || usage.cache_read_tokens || usage.cacheReadTokens || 0);
  const cacheWriteTokens = Number(
    usage.cache_creation_input_tokens || usage.cacheWriteTokens || usage.cache_write_tokens || usage.cached_input_write_tokens || 0
  );
  const reasoningTokens = Number(usage.reasoning_output_tokens || usage.reasoning_tokens || usage.reasoningTokens || 0);
  // Codex local logs can expose gross input plus cache counters. Normalize here so
  // inputTokens always carries non-cache input.
  const inputTokens = Math.max(0, rawInputTokens - cacheReadTokens - cacheWriteTokens);
  const directTotal = Number(usage.total_tokens || usage.totalTokens || 0);
  const total = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens || directTotal;
  if (!Number.isFinite(total) || total <= 0) return null;

  const isCumulative = Boolean(sampleUsage) && !info?.last_token_usage;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    cumulativeTotal: isCumulative ? total : 0,
    quality: rawInputTokens || outputTokens ? "exact" : "partial",
    deltaTotal(previousCumulativeTotal) {
      if (!isCumulative) return total;
      if (!previousCumulativeTotal) return total;
      return total >= previousCumulativeTotal ? total - previousCumulativeTotal : total;
    }
  };
}
