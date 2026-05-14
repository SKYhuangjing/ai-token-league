import { publicUsageItem } from "../shared/schema.js";
import { sha256Hex } from "../shared/crypto.js";
import { sourceMetadata } from "./providers/common.js";
import { workdirFromCandidate } from "./workdir.js";
import { codexLocalProvider } from "./providers/codex-local.js";
import { claudeCodeLocalProvider } from "./providers/claude-code-local.js";
import { cursorDashboardUsageProvider } from "./providers/cursor-dashboard-usage.js";

export const providers = [claudeCodeLocalProvider, codexLocalProvider, cursorDashboardUsageProvider];

export function providerHealth(config) {
  return providers.map((provider) => provider.reportHealth(config));
}

export async function scanUsage(config) {
  const items = [];
  const health = [];
  const sourceIndex = {};
  const previousSources = config.__usageCacheIndex?.sources || {};
  for (const provider of providers) {
    try {
      const files = provider.scanSessions(config);
      let parsedFiles = 0;
      let reusedFiles = 0;
      for (const file of files) {
        const source = sourceForProviderFile(provider, file);
        if (source && previousSources[source.sourceFingerprint]) {
          const cachedItems = (previousSources[source.sourceFingerprint].items || []).map((item) => publicUsageItem(item));
          items.push(...cachedItems);
          sourceIndex[source.sourceFingerprint] = {
            ...source,
            items: cachedItems
          };
          reusedFiles += 1;
          continue;
        }
        let events = [];
        try {
          events = await provider.parseUsage(file, config);
        } catch {
          continue;
        }
        const sourceItems = [];
        for (const event of events) {
          const workdir = workdirFromCandidate(event.workdirCandidate, config.participantId);
          const alias = config.workdirAliases?.[workdir.workdirHash];
          const usageItem = publicUsageItem({
              day: event.day,
              toolCode: event.toolCode,
              providerId: event.providerId,
              workdirHash: workdir.workdirHash,
              workdirDisplayName: alias || workdir.displayName,
              model: event.model,
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              cacheReadTokens: event.cacheReadTokens,
              cacheWriteTokens: event.cacheWriteTokens,
              reasoningTokens: event.reasoningTokens,
              totalTokens: event.totalTokens,
              sourceQuality: event.sourceQuality,
              rawSourceRef: event.rawSourceRef,
              providerVersion: event.providerVersion,
              parserVersion: event.parserVersion,
              sourceFingerprint: event.sourceFingerprint
            });
          sourceItems.push(usageItem);
        }
        const aggregatedSourceItems = aggregateItems(sourceItems);
        items.push(...aggregatedSourceItems);
        if (source) {
          sourceIndex[source.sourceFingerprint] = {
            ...source,
            rowCount: aggregatedSourceItems.length,
            items: aggregatedSourceItems
          };
        }
        parsedFiles += 1;
      }
      health.push({ ...provider.reportHealth(config), scannedFiles: files.length, parsedFiles, reusedFiles });
    } catch (error) {
      health.push({
        providerId: provider.id,
        toolCode: provider.toolCode,
        detected: false,
        error: error.message,
        lastCheckedAt: new Date().toISOString()
      });
    }
  }
  return { items: aggregateItems(items), health, sourceIndex: { sources: sourceIndex } };
}

function aggregateItems(items) {
  const map = new Map();
  for (const item of items) {
    const key = [item.day, item.toolCode, item.providerId, item.workdirHash, item.model].join("|");
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...item });
      continue;
    }
    for (const tokenKey of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens"]) {
      existing[tokenKey] += item[tokenKey] || 0;
    }
    existing.sourceQuality = existing.sourceQuality === "exact" && item.sourceQuality === "exact" ? "exact" : "partial";
    existing.sourceFingerprint = mergeTraceValue(existing.sourceFingerprint, item.sourceFingerprint);
    existing.rawSourceRef = mergeTraceValue(existing.rawSourceRef, item.rawSourceRef);
    existing.providerVersion = mergeTraceValue(existing.providerVersion, item.providerVersion);
    existing.parserVersion = mergeTraceValue(existing.parserVersion, item.parserVersion);
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

export function groupByBucket(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${item.day}|${item.providerId}`;
    if (!map.has(key)) {
      map.set(key, { day: item.day, providerId: item.providerId, items: [] });
    }
    map.get(key).items.push(item);
  }
  return map;
}

function mergeTraceValue(left = "", right = "") {
  const values = [...new Set([left, right].filter(Boolean))].sort();
  if (!values.length) return "";
  if (values.length === 1) return values[0];
  return sha256Hex(values.join("|"));
}

function sourceForProviderFile(provider, file) {
  if (typeof file !== "string") return null;
  try {
    return sourceMetadata(file, provider.id, provider.version);
  } catch {
    return null;
  }
}
