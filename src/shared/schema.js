import { canonicalJson, sha256Hex } from "./crypto.js";
import { localDay } from "./date.js";

export const SOURCE_QUALITY = new Set(["exact", "partial", "estimated", "imported", "unknown"]);
export const STORAGE_SCHEMA_VERSION = 2;
export const USAGE_CACHE_VERSION = 3;

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

export function primaryTokenTotal(item = {}) {
  return normalizeTokenNumber(item.inputTokens) + normalizeTokenNumber(item.outputTokens);
}

export function displayTotalTokens(item = {}) {
  return primaryTokenTotal(item) + normalizeTokenNumber(item.cacheReadTokens) + normalizeTokenNumber(item.cacheWriteTokens);
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
  const inputTokens = normalizeTokenNumber(item.inputTokens);
  const outputTokens = normalizeTokenNumber(item.outputTokens);
  const cacheReadTokens = normalizeTokenNumber(item.cacheReadTokens);
  const cacheWriteTokens = normalizeTokenNumber(item.cacheWriteTokens);
  const reasoningTokens = normalizeTokenNumber(item.reasoningTokens);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const publicItem = {
    day: item.day,
    toolCode: item.toolCode,
    providerId: item.providerId,
    workdirHash: item.workdirHash,
    workdirDisplayName: item.workdirDisplayName,
    model: item.model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
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

export const BUCKET_FINGERPRINT_FIELDS = [
  "day", "toolCode", "providerId", "workdirHash", "workdirDisplayName", "model",
  "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
  "reasoningTokens", "totalTokens", "sourceQuality", "sourceFingerprint"
];

export function assertSnapshot(snapshot, items, participantId, deviceId) {
  const snapshotItems = Array.isArray(items) ? items : [];
  if (!snapshot || snapshot.mode !== "device_day_provider") {
    throw new Error("snapshot mode must be device_day_provider");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.day)) {
    throw new Error("snapshot day must be YYYY-MM-DD");
  }
  if (!snapshot.providerId) {
    throw new Error("snapshot providerId is required");
  }
  if (!snapshot.bucketFingerprint) {
    throw new Error("snapshot bucketFingerprint is required");
  }
  if (!Number.isInteger(snapshot.rowCount) || snapshot.rowCount < 0) {
    throw new Error("snapshot rowCount must be a non-negative integer");
  }
  if (snapshot.rowCount === 0) {
    throw new Error("empty-bucket snapshot is not supported in this protocol version");
  }
  if (snapshot.rowCount !== snapshotItems.length) {
    throw new Error(`snapshot rowCount ${snapshot.rowCount} does not match items length ${snapshotItems.length}`);
  }
  if (!Number.isFinite(snapshot.totalTokens) || snapshot.totalTokens < 0) {
    throw new Error("snapshot totalTokens must be non-negative");
  }
  for (let i = 0; i < snapshotItems.length; i++) {
    if (snapshotItems[i].day !== snapshot.day) {
      throw new Error(`item ${i} day "${snapshotItems[i].day}" does not match snapshot day "${snapshot.day}"`);
    }
    if (snapshotItems[i].providerId !== snapshot.providerId) {
      throw new Error(`item ${i} providerId "${snapshotItems[i].providerId}" does not match snapshot providerId "${snapshot.providerId}"`);
    }
  }
}

export function computeBucketFingerprint(items) {
  if (!items.length) return sha256Hex("");
  const rows = items.map((item) => {
    const row = {};
    for (const field of BUCKET_FINGERPRINT_FIELDS) {
      row[field] = item[field];
    }
    return row;
  }).sort((a, b) => {
    const left = canonicalJson(a);
    const right = canonicalJson(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return sha256Hex(canonicalJson(rows));
}
