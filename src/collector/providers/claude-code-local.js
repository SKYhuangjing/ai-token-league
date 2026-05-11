import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { dayFromRecord, deepFindString, readJsonLinesAsync, sourceMetadataAsync, walkFiles } from "./common.js";

function decodeProjectDir(file) {
  const parts = file.split(path.sep);
  const projectsIndex = parts.lastIndexOf("projects");
  if (projectsIndex >= 0 && parts[projectsIndex + 1]) {
    const encoded = parts[projectsIndex + 1];
    if (encoded.startsWith("-")) {
      return encoded.replace(/^-/, path.sep).replaceAll("-", path.sep);
    }
    return encoded;
  }
  return process.cwd();
}

export const claudeCodeLocalProvider = {
  id: "claude_code_local",
  toolCode: "claude_code",
  version: "0.1.1",

  roots(config = {}) {
    if (config.providerRootsOnly && config.providerRoots?.claude_code_local) return normalizeCustomRoots(config.providerRoots.claude_code_local);
    const auto = autoRoots(config);
    const customRoots = normalizeCustomRoots(config.providerRoots?.claude_code_local);
    return [...new Set([...auto, ...customRoots])];
  },

  autoRoots(config = {}) {
    if (config.providerRootsOnly) return [];
    const realRoots = [path.join(os.homedir(), ".config", "claude", "projects"), path.join(os.homedir(), ".claude", "projects")];
    const existingRealRoots = realRoots.filter((root) => fs.existsSync(root));
    return existingRealRoots.length ? existingRealRoots : [path.resolve("samples/claude/projects")];
  },

  manualRoots(config = {}) {
    return normalizeCustomRoots(config.providerRoots?.claude_code_local);
  },

  detect(config) {
    const roots = this.roots(config).filter((root) => fs.existsSync(root));
    return { providerId: this.id, detected: roots.length > 0, roots };
  },

  scanSessions(config) {
    if (config.providerEnabled?.claude_code_local === false) return [];
    const ignored = config.providerIgnoredAutoSources?.claude_code_local || [];
    const auto = this.autoRoots(config).filter(r => !ignored.includes(r));
    const manual = this.manualRoots(config);
    return [...auto, ...manual].flatMap((root) => walkFiles(root, (file) => file.endsWith(".jsonl")));
  },

  async parseUsage(file) {
    const stats = await fs.promises.stat(file);
    const source = await sourceMetadataAsync(file, this.id, this.version);
    const rows = await readJsonLinesAsync(file);
    let lastModel = "";
    return rows
      .map((row) => {
        const usage = extractUsage(row);
        if (!usage) return null;
        const detectedModel = row?.message?.model || deepFindString(row, ["model"]);
        if (detectedModel) lastModel = detectedModel;
        const rawInputTokens = tokenNumber(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens);
        const outputTokens = tokenNumber(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens);
        const cacheReadTokens = tokenNumber(usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? usage.cache_read_tokens);
        const cacheWriteTokens = tokenNumber(usage.cache_creation_input_tokens ?? usage.cacheWriteTokens ?? usage.cache_write_tokens);
        const reasoningTokens = tokenNumber(usage.reasoning_tokens ?? usage.reasoningTokens);
        // Claude Code usage follows ccusage semantics: input_tokens is counted
        // alongside cache read/write tokens instead of being reduced by them.
        const inputTokens = rawInputTokens;
        const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens || tokenNumber(usage.total_tokens ?? usage.totalTokens);
        if (!totalTokens) return null;
        return {
          providerId: this.id,
          providerVersion: this.version,
          toolCode: this.toolCode,
          sourceKind: "local_log",
          sourceQuality: rawInputTokens || outputTokens ? "exact" : "partial",
          sessionId: deepFindString(row, ["session_id", "sessionId", "conversation_id"]) || path.basename(file),
          day: dayFromRecord(row, stats.mtimeMs),
          workdirCandidate: deepFindString(row, ["cwd", "workdir", "working_directory", "project_path"]) || decodeProjectDir(file),
          model: detectedModel || lastModel || "unknown",
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          reasoningTokens,
          totalTokens,
          ...source
        };
      })
      .filter(Boolean);
  },

  reportHealth(config) {
    const auto = this.autoRoots(config);
    const manual = this.manualRoots(config);
    const ignored = config.providerIgnoredAutoSources?.claude_code_local || [];
    const allRoots = [...auto, ...manual];
    const sources = [
      ...auto.map(r => ({ kind: "auto", id: r, label: shortenPath(r), path: r, ignored: ignored.includes(r) })),
      ...manual.map(r => ({ kind: "manual", id: r, label: shortenPath(r), path: r, ignored: false }))
    ];
    return {
      providerId: this.id,
      toolCode: this.toolCode,
      detected: allRoots.length > 0,
      enabled: config.providerEnabled?.claude_code_local !== false,
      roots: allRoots,
      sources,
      lastCheckedAt: new Date().toISOString()
    };
  }
};

function extractUsage(row) {
  return row?.message?.usage || row?.usage || null;
}

function tokenNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function normalizeCustomRoots(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function shortenPath(p) {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
