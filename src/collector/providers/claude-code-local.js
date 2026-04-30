import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { dayFromRecord, deepFindNumber, deepFindString, readJsonLines, sourceMetadata, walkFiles } from "./common.js";

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
  version: "0.1.0",

  roots(config = {}) {
    if (config.providerRootsOnly && config.providerRoots?.claude_code_local) return normalizeCustomRoots(config.providerRoots.claude_code_local);
    const realRoots = [path.join(os.homedir(), ".config", "claude", "projects"), path.join(os.homedir(), ".claude", "projects")];
    const existingRealRoots = realRoots.filter((root) => fs.existsSync(root));
    const customRoots = normalizeCustomRoots(config.providerRoots?.claude_code_local);
    return [...new Set([...(existingRealRoots.length ? existingRealRoots : [path.resolve("samples/claude/projects")]), ...customRoots])];
  },

  detect(config) {
    const roots = this.roots(config).filter((root) => fs.existsSync(root));
    return { providerId: this.id, detected: roots.length > 0, roots };
  },

  scanSessions(config) {
    if (config.providerEnabled?.claude_code_local === false) return [];
    return this.roots(config).flatMap((root) => walkFiles(root, (file) => file.endsWith(".jsonl")));
  },

  parseUsage(file) {
    const stats = fs.statSync(file);
    const source = sourceMetadata(file, this.id, this.version);
    const rows = readJsonLines(file);
    return rows
      .map((row) => {
        const inputTokens = deepFindNumber(row, ["input_tokens", "inputTokens", "prompt_tokens"]);
        const outputTokens = deepFindNumber(row, ["output_tokens", "outputTokens", "completion_tokens"]);
        const cacheReadTokens = deepFindNumber(row, ["cache_read_input_tokens", "cacheReadTokens", "cache_read_tokens"]);
        const cacheWriteTokens = deepFindNumber(row, ["cache_creation_input_tokens", "cacheWriteTokens", "cache_write_tokens"]);
        const reasoningTokens = deepFindNumber(row, ["reasoning_tokens", "reasoningTokens"]);
        const totalTokens =
          deepFindNumber(row, ["total_tokens", "totalTokens"]) ||
          inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens;
        if (!totalTokens) return null;
        return {
          providerId: this.id,
          providerVersion: this.version,
          toolCode: this.toolCode,
          sourceKind: "local_log",
          sourceQuality: inputTokens || outputTokens ? "exact" : "partial",
          sessionId: deepFindString(row, ["session_id", "sessionId", "conversation_id"]) || path.basename(file),
          day: dayFromRecord(row, stats.mtimeMs),
          workdirCandidate: deepFindString(row, ["cwd", "workdir", "working_directory", "project_path"]) || decodeProjectDir(file),
          model: deepFindString(row, ["model"]) || "unknown",
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
    const detection = this.detect(config);
    return {
      providerId: this.id,
      toolCode: this.toolCode,
      detected: detection.detected,
      enabled: config.providerEnabled?.claude_code_local !== false,
      roots: detection.roots,
      lastCheckedAt: new Date().toISOString()
    };
  }
};

function normalizeCustomRoots(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
