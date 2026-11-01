// ATL cloud upload protocol stack, ported from the AI Token League repo
// (src/shared/crypto.js, src/shared/schema.js, src/shared/date.js) so the
// plugin produces byte-identical signatures, bucket fingerprints and usage
// items without depending on the ATL repo at runtime. Bun implements the
// node:crypto APIs used here (Ed25519 sign/verify, sha256, PEM export).
import crypto from "node:crypto";

const ED25519_OID = Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]);
const LEGACY_ED25519_OID = Buffer.from([0x06, 0x03, 0x55, 0x3d, 0x65]);

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

export function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    participantId: newId("p"),
    identityPublicKey: publicKey.export({ type: "spki", format: "pem" }),
    identityPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" })
  };
}

export function signPayload(privateKeyPem, payload) {
  return crypto.sign(null, Buffer.from(canonicalJson(payload)), normalizeLegacyEd25519Pem(privateKeyPem)).toString("base64");
}

export function verifyPayload(publicKeyPem, payload, signature) {
  try {
    return crypto.verify(null, Buffer.from(canonicalJson(payload)), normalizeLegacyEd25519Pem(publicKeyPem), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function normalizeLegacyEd25519Pem(pem) {
  if (typeof pem !== "string") return pem;
  const match = pem.match(/^-----BEGIN ([A-Z ]+)-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END \1-----\s*$/s);
  if (!match) return pem;
  const [, label, body] = match;
  if (label !== "PUBLIC KEY" && label !== "PRIVATE KEY") return pem;
  const der = Buffer.from(body.replace(/\s+/g, ""), "base64");
  const oidOffset = der.indexOf(LEGACY_ED25519_OID);
  if (oidOffset < 0) return pem;
  ED25519_OID.copy(der, oidOffset);
  const normalized = der.toString("base64").match(/.{1,64}/g)?.join("\n") || "";
  return `-----BEGIN ${label}-----\n${normalized}\n-----END ${label}-----\n`;
}

// --- date helpers (local-timezone day/hour, matching collector-core/src/date.rs) ---

export function appTimeZone() {
  const envTimeZone = typeof process !== "undefined" ? process.env.APP_TIME_ZONE : "";
  const tz = typeof process !== "undefined" ? process.env.TZ : "";
  return envTimeZone || tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// Intl.DateTimeFormat CONSTRUCTION is ~0.1ms — one per row over a 236k-row
// history was half a minute of CPU per sync. The formatter is cached per
// timezone, and results memoize per minute (a minute's day/hour is constant;
// bursts of requests share minutes heavily). This took the full pipeline
// from ~54s to ~4s on the same data.
const dtfCache = new Map();
function formatterFor(timeZone) {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}
const partsMemo = new Map();
function dateParts(date, timeZone) {
  const key = Math.floor(date.getTime() / 60000) + "|" + timeZone;
  const memo = partsMemo.get(key);
  if (memo) return memo;
  const parts = formatterFor(timeZone).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  const hour = Number(part("hour"));
  const out = {
    day: `${part("year")}-${part("month")}-${part("day")}`,
    // Intl with hour12:false can yield "24" at midnight in some runtimes; normalize.
    hour: hour === 24 ? 0 : hour
  };
  if (partsMemo.size > 300_000) partsMemo.clear(); // years of minutes, bounded
  partsMemo.set(key, out);
  return out;
}

export function localDayAndHour(value = new Date(), timeZone = appTimeZone()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return localDayAndHour(new Date(), timeZone);
  return dateParts(date, timeZone);
}

// --- usage item whitelist + forbidden fields (matching src/shared/schema.js) ---

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

export const SOURCE_QUALITY = new Set(["exact", "partial", "estimated", "imported", "unknown"]);

export const BUCKET_FINGERPRINT_FIELDS = [
  "day", "hour", "toolCode", "providerId", "workdirHash", "workdirDisplayName", "model",
  "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
  "reasoningTokens", "totalTokens", "sourceQuality", "sourceFingerprint"
];

function normalizeTokenNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function safeTraceText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.slice(0, 160);
}

export function normalizeUsageModel(model) {
  const value = String(model ?? "").trim();
  if (!value) return "";
  return value.toLowerCase();
}

/** Builds the 18-field whitelisted usage item. Anything else physically cannot appear. */
export function buildPublicUsageItem(item) {
  const inputTokens = normalizeTokenNumber(item.inputTokens);
  const outputTokens = normalizeTokenNumber(item.outputTokens);
  const cacheReadTokens = normalizeTokenNumber(item.cacheReadTokens);
  const cacheWriteTokens = normalizeTokenNumber(item.cacheWriteTokens);
  const reasoningTokens = normalizeTokenNumber(item.reasoningTokens);
  const publicItem = {
    day: item.day,
    hour: item.hour != null ? item.hour : 0,
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
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    sourceQuality: item.sourceQuality || "unknown",
    rawSourceRef: safeTraceText(item.rawSourceRef),
    providerVersion: safeTraceText(item.providerVersion),
    parserVersion: safeTraceText(item.parserVersion || item.providerVersion),
    sourceFingerprint: safeTraceText(item.sourceFingerprint)
  };
  assertNoForbiddenUploadFields(publicItem);
  assertUsageItem(publicItem);
  return publicItem;
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

// --- bucket fingerprint (matching computeBucketFingerprint in src/shared/schema.js) ---

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

/** Virtual workdir hash for gateway-measured usage without a cwd (mirrors collector-core workdir.rs virtual buckets). */
export function virtualWorkdirHash(name, participantId) {
  return sha256Hex(`virtual:${name}:${participantId}`);
}
