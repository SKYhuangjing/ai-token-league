export const SOURCE_QUALITY = new Set(["exact", "partial", "estimated", "imported", "unknown"]);
export const STORAGE_SCHEMA_VERSION = 2;
export const USAGE_CACHE_VERSION = 2;

export const FORBIDDEN_UPLOAD_FIELDS = new Set([
  "absolutePath",
  "access_token",
  "assistantResponse",
  "content",
  "cookie",
  "cursor_auth_raw",
  "cursor_usage_raw",
  "fullTranscript",
  "identityPrivateKey",
  "localPath",
  "prompt",
  "refresh_token",
  "sourceFileContent",
  "workosSessionToken"
]);

export function todayLocal() {
  return localDay();
}

export function assertUsageItem(item) {
  const required = ["day", "toolCode", "providerId", "workdirHash", "workdirDisplayName", "model", "totalTokens", "sourceQuality"];
  for (const key of required) {
    if (item[key] === undefined || item[key] === null || item[key] === "") {
      throw new Error(`usage item missing ${key}`);
    }
  }
  if (!SOURCE_QUALITY.has(item.sourceQuality)) {
    throw new Error(`invalid sourceQuality: ${item.sourceQuality}`);
  }
  if (!Number.isFinite(item.totalTokens) || item.totalTokens < 0) {
    throw new Error(`invalid totalTokens: ${item.totalTokens}`);
  }
  assertNoForbiddenUploadFields(item);
}

export function normalizeTokenNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function usageKey(item, participantId, deviceId) {
  return [
    item.day,
    participantId,
    deviceId,
    item.toolCode,
    item.providerId,
    item.workdirHash,
    item.model
  ].join("|");
}

export function publicUsageItem(item) {
  const publicItem = {
    day: item.day,
    toolCode: item.toolCode,
    providerId: item.providerId,
    workdirHash: item.workdirHash,
    workdirDisplayName: item.workdirDisplayName,
    model: item.model,
    inputTokens: normalizeTokenNumber(item.inputTokens),
    outputTokens: normalizeTokenNumber(item.outputTokens),
    cacheReadTokens: normalizeTokenNumber(item.cacheReadTokens),
    cacheWriteTokens: normalizeTokenNumber(item.cacheWriteTokens),
    reasoningTokens: normalizeTokenNumber(item.reasoningTokens),
    totalTokens: normalizeTokenNumber(item.totalTokens),
    sourceQuality: item.sourceQuality || "unknown",
    rawSourceRef: safeTraceText(item.rawSourceRef),
    providerVersion: safeTraceText(item.providerVersion),
    parserVersion: safeTraceText(item.parserVersion || item.providerVersion),
    sourceFingerprint: safeTraceText(item.sourceFingerprint)
  };
  assertNoForbiddenUploadFields(publicItem);
  return publicItem;
}

export function assertNoForbiddenUploadFields(value, path = "") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenUploadFields(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_UPLOAD_FIELDS.has(key)) {
      throw new Error(`forbidden upload field: ${path ? `${path}.` : ""}${key}`);
    }
    assertNoForbiddenUploadFields(child, path ? `${path}.${key}` : key);
  }
}

function safeTraceText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.slice(0, 160);
}
import { localDay } from "./date.js";
