// Node.js sidecar for Tauri desktop app.
// Communicates via NDJSON over stdin/stdout.

const readline = require("readline");
const path = require("node:path");
const fs = require("node:fs");
const nodeCrypto = require("node:crypto");
const os = require("node:os");

// ── Paths ──────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..", "..");
const APP_DIR = path.join(os.homedir(), ".ai-token-league");
const USAGE_CACHE_FILE = path.join(APP_DIR, "usage-cache.json");
const RUNTIME_LOG_FILE = path.join(APP_DIR, "runtime-log.jsonl");

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const APP_VERSION = packageVersion();

// ── Module cache ───────────────────────────────────────────────────

let _modules = null;
async function modules() {
  if (_modules) return _modules;
  const root = ROOT;
  const imp = (p) => import(`file://${path.join(root, p).replaceAll("\\", "/")}`);
  _modules = {
    config: await imp("src/collector/config.js"),
    core: await imp("src/collector/core.js"),
    crypto: await imp("src/shared/crypto.js"),
    schema: await imp("src/shared/schema.js"),
    update: await imp("src/shared/update.js"),
    version: await imp("src/shared/version.js"),
    preset: await imp("src/shared/preset.js"),
    pricing: await imp("src/shared/pricing.js"),
    display: await imp("src/shared/display.js"),
    date: await imp("src/shared/date.js")
  };
  return _modules;
}

// ── State (mirrors main.cjs) ───────────────────────────────────────

const background = {
  timer: null, running: false, rescheduleAfterRun: false,
  lastRunAt: null, lastMode: null, lastResult: null, lastError: null, nextRunAt: null
};

const usageCache = { data: null, loaded: false, cacheTtlMs: 5 * 60 * 1000 };

const foregroundScan = {
  running: false, taskId: 0, force: false,
  startedAt: null, finishedAt: null, error: null,
  syncRunning: false, syncStartedAt: null, syncFinishedAt: null,
  syncResult: null, syncError: "", snapshot: null
};

const updateCheck = {
  timer: null, running: false, downloadRunning: false, applyRunning: false,
  status: "idle", lastCheckedAt: null, lastResult: null, lastError: null,
  nextCheckAt: null, downloadProgress: null, readyPackage: null
};

const activity = { diagnosticsExport: false, configTransfer: false, identityTransfer: false };

let cachedConfig = null;
let cachedPriceMap = null;
let cachedIdentity = null;
let cachedReleaseConfig = null;
let customMacUpdate = null;

// ── Tray i18n ──────────────────────────────────────────────────────

const TRAY_I18N = {
  "zh-CN": {
    "tray.open": "打开主页面", "tray.refresh": "立即刷新", "tray.quit": "退出",
    "tray.tokensToday": "📊 今日令牌: {count}", "tray.cost": "💰 预估费用: {cost}",
    "tray.noUsage": "暂无本地用量", "tray.refreshWithTime": "立即刷新 ({time})",
    "tray.user": "👤 {name}", "tray.anonymousUser": "{name}",
    "tray.visitCloud": "访问云端 ({name})", "tray.visitCloudNoName": "访问云端",
    "tray.cloudLocal": "仅本地", "tray.modelsTitle": "模型消耗", "tray.providersTitle": "来源"
  },
  en: {
    "tray.open": "Open Main Page", "tray.refresh": "Refresh Now", "tray.quit": "Quit",
    "tray.tokensToday": "📊 Today: {count} tokens", "tray.cost": "💰 Est. cost: {cost}",
    "tray.noUsage": "No local usage", "tray.refreshWithTime": "Refresh Now ({time})",
    "tray.user": "👤 {name}", "tray.anonymousUser": "{name}",
    "tray.visitCloud": "Visit Cloud ({name})", "tray.visitCloudNoName": "Visit Cloud",
    "tray.cloudLocal": "Local only", "tray.modelsTitle": "Models", "tray.providersTitle": "Sources"
  }
};
const TRAY_PROVIDER_NAMES = { claude_code_local: "Claude Code", codex_local: "Codex", cursor_dashboard_usage: "Cursor" };

function trayT(key, params = {}) {
  const lang = cachedConfig?.language || "zh-CN";
  const dict = TRAY_I18N[lang] || TRAY_I18N["zh-CN"];
  let text = dict[key] || TRAY_I18N["zh-CN"][key] || key;
  for (const [k, v] of Object.entries(params)) text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  return text;
}

// ── Helpers ────────────────────────────────────────────────────────

function normalizeApiBaseUrl(url) { return String(url || "").trim().replace(/\/+$/, ""); }
function hasApiBaseUrl(c) { return Boolean(normalizeApiBaseUrl(c?.apiBaseUrl)); }

function sanitizeConfig(c) {
  if (!c) return c;
  const { identityPrivateKey, ...rest } = c;
  return rest;
}

function configLogSummary(c) {
  return { participantId: c.participantId, deviceId: c.deviceId, apiConfigured: hasApiBaseUrl(c), nickname: c.nickname };
}

function clientQuery(version, appVersion) {
  const client = version.clientMetadata({ clientAppVersion: appVersion || APP_VERSION });
  return new URLSearchParams({ clientVersion: client.clientVersion, clientPlatform: client.clientPlatform }).toString();
}

function safeTimestamp(d) {
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function sanitizeLogValue(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > 200) out[k] = v.slice(0, 200) + "…";
    else out[k] = v;
  }
  return out;
}

function snapshotFingerprint(items) {
  if (!items?.length) return "";
  const fields = ["providerId", "sourceId", "day", "model", "totalTokens"];
  const lines = items.map((i) => fields.map((f) => String(i[f] ?? "")).join("|")).sort();
  return nodeCrypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

function scanHealthSummary(health) {
  if (!Array.isArray(health)) return "";
  return health.map((h) => `${h.providerId}:${h.ok ? "ok" : "fail"}`).join(", ");
}

function silentUpdateMode() { return "auto_download"; }

// ── HTTP helpers ───────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: options.signal || controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function getJson(url, { timeoutMs = 5000 } = {}) {
  const res = await fetchWithTimeout(url, {}, timeoutMs);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function postJson(url, body) {
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }, 10000);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

function signedQueueEntry(payload, signature) { return { ...payload, signature }; }

// ── Runtime log ────────────────────────────────────────────────────

function appendRuntimeLog(event, details = {}) {
  try {
    rotateRuntimeLog();
    fs.mkdirSync(path.dirname(RUNTIME_LOG_FILE), { recursive: true });
    fs.appendFileSync(RUNTIME_LOG_FILE, `${JSON.stringify({ ts: new Date().toISOString(), event, details: sanitizeLogValue(details) })}\n`);
  } catch {}
}

function rotateRuntimeLog() {
  if (!fs.existsSync(RUNTIME_LOG_FILE)) return;
  const maxBytes = 2 * 1024 * 1024, keepBytes = 1024 * 1024;
  const stats = fs.statSync(RUNTIME_LOG_FILE);
  if (stats.size <= maxBytes) return;
  const content = fs.readFileSync(RUNTIME_LOG_FILE, "utf8").slice(-keepBytes);
  const nl = content.indexOf("\n");
  fs.writeFileSync(RUNTIME_LOG_FILE, nl >= 0 ? content.slice(nl + 1) : content);
}

function readRuntimeLog(limit = 1000) {
  try {
    if (!fs.existsSync(RUNTIME_LOG_FILE)) return [];
    return fs.readFileSync(RUNTIME_LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean).slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return { ts: "", event: "unparsed", details: { line: l.slice(0, 500) } }; }
    });
  } catch { return []; }
}

// ── Usage cache ────────────────────────────────────────────────────

function readUsageCache() {
  if (usageCache.loaded) return usageCache.data;
  usageCache.loaded = true;
  try {
    const cached = fs.existsSync(USAGE_CACHE_FILE) ? JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, "utf8")) : null;
    usageCache.data = cached?.cacheVersion === 3 ? cached : null;
  } catch { usageCache.data = null; }
  return usageCache.data;
}

function writeUsageCache(snapshot) {
  usageCache.loaded = true;
  usageCache.data = snapshot;
  fs.mkdirSync(path.dirname(USAGE_CACHE_FILE), { recursive: true });
  fs.writeFileSync(USAGE_CACHE_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
}

function invalidateUsageCache() {
  usageCache.loaded = true;
  usageCache.data = null;
  try { fs.rmSync(USAGE_CACHE_FILE, { force: true }); } catch {}
}

// ── Upload queue ───────────────────────────────────────────────────

function uploadQueuePath(configModule, current) {
  return current?.uploadQueuePath || path.join(configModule.APP_DIR || APP_DIR, "upload-queue.json");
}

function readUploadQueue(current) {
  const { config: configModule } = _modules || {};
  const file = uploadQueuePath(configModule || { APP_DIR }, current);
  try {
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    return data?.version === 1 ? data : { version: 1, items: [] };
  } catch { return { version: 1, items: [] }; }
}

function writeUploadQueue(current, queue) {
  const { config: configModule } = _modules || {};
  const file = uploadQueuePath(configModule || { APP_DIR }, current);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(queue, null, 2)}\n`);
}

function enqueueUpload(current, entry, error) {
  const queue = readUploadQueue(current);
  const bucketKey = `${entry.snapshot?.day}|${entry.snapshot?.providerId}`;
  const existing = queue.items.findIndex((i) => {
    const ek = `${i.snapshot?.day}|${i.snapshot?.providerId}`;
    return ek === bucketKey;
  });
  const item = { ...entry, enqueuedAt: new Date().toISOString(), attemptCount: 0, lastError: error || "" };
  if (existing >= 0) queue.items[existing] = item;
  else queue.items.push(item);
  writeUploadQueue(current, queue);
}

async function drainUploadQueue(current, manifest) {
  const queue = readUploadQueue(current);
  if (!queue.items.length) return { uploaded: 0, pending: 0, manifestChanged: false };
  let uploaded = 0;
  const remaining = [];
  for (const entry of queue.items) {
    try {
      await uploadQueueEntry(current, entry);
      const bucketKey = `${entry.snapshot?.day}|${entry.snapshot?.providerId}`;
      if (manifest && entry.snapshot) {
        manifest.buckets[bucketKey] = {
          day: entry.snapshot.day, providerId: entry.snapshot.providerId,
          fingerprint: entry.snapshot.bucketFingerprint,
          rowCount: entry.snapshot.rowCount, totalTokens: entry.snapshot.totalTokens,
          syncedAt: new Date().toISOString()
        };
      }
      uploaded += 1;
    } catch {
      entry.attemptCount = (entry.attemptCount || 0) + 1;
      if (entry.attemptCount < 10) remaining.push(entry);
    }
  }
  writeUploadQueue(current, { version: 1, items: remaining });
  return { uploaded, pending: remaining.length, manifestChanged: uploaded > 0 };
}

async function uploadQueueEntry(current, entry) {
  const apiBaseUrl = normalizeApiBaseUrl(current.apiBaseUrl);
  return postJson(`${apiBaseUrl}/api/usage/daily-batch`, entry);
}

// ── Config helpers ─────────────────────────────────────────────────

async function ensureDesktopConfig(config, preset) {
  let current = config.loadConfig();
  if (current) {
    cachedConfig = current;
    return current;
  }
  const { generateNickname } = await import(`file://${path.join(ROOT, "src/shared/nickname-generator.js").replaceAll("\\", "/")}`);
  const buildPreset = preset.loadBuildPreset();
  current = config.initConfig({
    ...buildPreset,
    nickname: generateNickname(),
    apiConnection: { status: "not_configured", checkedAt: "" }
  });
  cachedConfig = current;
  return current;
}

async function checkApiConnectionForConfig(apiBaseUrl) {
  const normalized = normalizeApiBaseUrl(apiBaseUrl);
  const checkedAt = new Date().toISOString();
  if (!normalized) return { ok: true, status: "not_configured", apiBaseUrl: "", checkedAt, message: "API not configured" };
  try {
    const { version } = await modules();
    const base = new URL(normalized);
    if (!["http:", "https:"].includes(base.protocol)) throw new Error("Must use http or https");
    const healthUrl = new URL(`/api/health?${clientQuery(version, APP_VERSION)}`, base).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(healthUrl, { signal: controller.signal });
      clearTimeout(timeout);
      const text = await response.text();
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch {}
      if (!response.ok) return { ok: false, status: "error", apiBaseUrl: normalized, checkedAt, message: `${response.status} ${body.message || text}` };
      return { ok: true, status: "connected", apiBaseUrl: normalized, checkedAt, serverVersion: body.version || "", message: "Connected" };
    } catch (err) {
      clearTimeout(timeout);
      return { ok: false, status: "unreachable", apiBaseUrl: normalized, checkedAt, message: err.name === "AbortError" ? "Timeout" : err.message };
    }
  } catch (err) {
    return { ok: false, status: "invalid_url", apiBaseUrl: normalized, checkedAt, message: err.message };
  }
}

async function checkApiConnection(apiBaseUrl) {
  return checkApiConnectionForConfig(apiBaseUrl);
}

async function prepareConfigInput(input = {}, current = null) {
  if (!Object.hasOwn(input, "apiBaseUrl")) return input;
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const previousApiBaseUrl = normalizeApiBaseUrl(current?.apiBaseUrl || "");
  const shouldCheckApi = !current || apiBaseUrl !== previousApiBaseUrl || (apiBaseUrl && !current.apiConnection?.checkedAt);
  if (!shouldCheckApi) return { ...input, apiBaseUrl };
  const apiConnection = await checkApiConnectionForConfig(apiBaseUrl);
  const next = { ...input, apiBaseUrl, apiConnection };
  if (apiBaseUrl !== previousApiBaseUrl) {
    next.syncStatus = {};
    next.lastSyncAt = "";
    next.lastSyncStatus = "";
    next.lastSyncApiBaseUrl = "";
    next.lastSyncError = "";
  }
  return next;
}

function invalidateCloudStateForApiChange(previousApiBaseUrl, nextConfig = {}) {
  const nextApiBaseUrl = normalizeApiBaseUrl(nextConfig.apiBaseUrl);
  if (nextApiBaseUrl === previousApiBaseUrl) return;
  cachedConfig = nextConfig;
  cachedReleaseConfig = null;
  customMacUpdate = null;
  if (!updateCheck.downloadRunning && !updateCheck.applyRunning) {
    updateCheck.running = false;
    updateCheck.status = "idle";
    updateCheck.lastCheckedAt = null;
    updateCheck.lastResult = null;
    updateCheck.lastError = null;
    updateCheck.downloadProgress = null;
    updateCheck.readyPackage = null;
  }
  appendRuntimeLog("cloud_api_changed", { fromConfigured: Boolean(previousApiBaseUrl), toConfigured: Boolean(nextApiBaseUrl) });
}

// ── Sync status persistence ────────────────────────────────────────

function persistSyncStatus(configModule, current, { apiBaseUrl, status, startedAt, finishedAt, result, error = "" }) {
  const previous = current.syncStatus || {};
  const syncStatus = {
    apiBaseUrl, lastAttemptAt: startedAt, lastFinishedAt: finishedAt,
    lastSuccessAt: status === "success" ? finishedAt : previous.lastSuccessAt || "",
    status, scanned: result.scanned || 0, accepted: result.accepted || 0, rejected: result.rejected || 0,
    queueUploaded: result.queueUploaded || 0, queuePending: result.queuePending || 0,
    sourceFingerprint: result.sourceFingerprint || "",
    lastSuccessSourceFingerprint: status === "success" ? result.sourceFingerprint || previous.lastSuccessSourceFingerprint || "" : previous.lastSuccessSourceFingerprint || "",
    error
  };
  configModule.saveConfig({ ...current, syncStatus, lastSyncAt: finishedAt, lastSyncStatus: status, lastSyncApiBaseUrl: apiBaseUrl, lastSyncError: error, updatedAt: finishedAt });
}

// ── Usage scanning ─────────────────────────────────────────────────

async function getUsageSnapshot({ core, current, force = false }) {
  const cached = readUsageCache();
  if (!force && cached && Date.now() - Date.parse(cached.scannedAt) < usageCache.cacheTtlMs) {
    appendRuntimeLog("scan_cache_hit", { participantId: current.participantId, deviceId: current.deviceId, rowCount: cached.rowCount || cached.items?.length || 0 });
    return { ...cached, fromCache: true };
  }
  appendRuntimeLog("scan_start", { participantId: current.participantId, deviceId: current.deviceId, force });
  try {
    const scanned = await core.scanUsage({ ...current, __usageCacheIndex: cached?.sourceIndex || {} });
    const { schema } = await modules();
    const snapshot = {
      ...scanned, cacheVersion: schema.USAGE_CACHE_VERSION,
      scannedAt: new Date().toISOString(), rowCount: scanned.items.length,
      sourceFingerprint: snapshotFingerprint(scanned.items), fromCache: false
    };
    writeUsageCache(snapshot);
    appendRuntimeLog("scan_done", { participantId: current.participantId, deviceId: current.deviceId, rowCount: snapshot.rowCount, sourceFingerprint: snapshot.sourceFingerprint });
    return snapshot;
  } catch (error) {
    appendRuntimeLog("scan_failed", { participantId: current.participantId, deviceId: current.deviceId, error: error.message });
    throw error;
  }
}

function startForegroundScan({ config, core, crypto, current, force = false }) {
  const cached = readUsageCache();
  if (foregroundScan.running) return;
  if (!force && cached && Date.now() - Date.parse(cached.scannedAt) < usageCache.cacheTtlMs) {
    foregroundScan.snapshot = cached;
    foregroundScan.startedAt = cached.scannedAt;
    foregroundScan.finishedAt = cached.scannedAt;
    foregroundScan.error = null;
    foregroundScan.syncRunning = false;
    foregroundScan.syncStartedAt = null;
    foregroundScan.syncFinishedAt = null;
    foregroundScan.syncResult = null;
    foregroundScan.syncError = "";
    foregroundScan.force = false;
    return;
  }
  const taskId = foregroundScan.taskId + 1;
  foregroundScan.taskId = taskId;
  foregroundScan.running = true;
  foregroundScan.force = force;
  foregroundScan.startedAt = new Date().toISOString();
  foregroundScan.finishedAt = null;
  foregroundScan.error = null;
  foregroundScan.syncRunning = false;
  foregroundScan.syncStartedAt = null;
  foregroundScan.syncFinishedAt = null;
  foregroundScan.syncResult = null;
  foregroundScan.syncError = "";
  foregroundScan.snapshot = cached || null;
  setTimeout(() => {
    getUsageSnapshot({ core, current, force })
      .then(async (snapshot) => {
        if (foregroundScan.taskId !== taskId) return;
        foregroundScan.snapshot = snapshot;
        foregroundScan.finishedAt = new Date().toISOString();
        foregroundScan.running = false;
        emitEvent("tray:rebuild");
        if (await shouldAutoSyncScannedUsage(current, snapshot)) {
          foregroundScan.syncRunning = true;
          foregroundScan.syncStartedAt = new Date().toISOString();
          try {
            const syncResult = await syncCurrentUsage({ config, core, crypto, current, scanned: snapshot });
            if (foregroundScan.taskId === taskId) foregroundScan.syncResult = syncResult;
          } catch (error) {
            if (foregroundScan.taskId === taskId) foregroundScan.syncError = error.message;
          } finally {
            if (foregroundScan.taskId === taskId) {
              foregroundScan.syncRunning = false;
              foregroundScan.syncFinishedAt = new Date().toISOString();
              emitEvent("tray:rebuild");
            }
          }
        }
      })
      .catch((error) => {
        if (foregroundScan.taskId !== taskId) return;
        foregroundScan.error = error.message;
        foregroundScan.finishedAt = new Date().toISOString();
        foregroundScan.running = false;
        foregroundScan.syncRunning = false;
        emitEvent("tray:rebuild");
      });
  }, 0);
}

function foregroundScanStatus() {
  const snapshot = foregroundScan.snapshot || readUsageCache();
  return {
    running: foregroundScan.running, taskId: foregroundScan.taskId, force: foregroundScan.force,
    startedAt: foregroundScan.startedAt, finishedAt: foregroundScan.finishedAt,
    error: foregroundScan.error,
    syncRunning: foregroundScan.syncRunning,
    syncStartedAt: foregroundScan.syncStartedAt,
    syncFinishedAt: foregroundScan.syncFinishedAt,
    syncResult: foregroundScan.syncResult,
    syncError: foregroundScan.syncError,
    snapshot: snapshot ? { items: snapshot.items || [], health: snapshot.health || [], cacheVersion: snapshot.cacheVersion, scannedAt: snapshot.scannedAt || null, rowCount: snapshot.rowCount || 0, sourceFingerprint: snapshot.sourceFingerprint || "", fromCache: Boolean(snapshot.fromCache) } : null
  };
}

async function shouldAutoSyncScannedUsage(current, snapshot = {}) {
  if (!hasApiBaseUrl(current) || snapshot.fromCache) return false;
  if (readUploadQueue(current).items.length > 0) return true;
  if (snapshot.items?.length > 0) {
    try {
      const { core, schema, config: configModule } = await modules();
      const buckets = core.groupByBucket(snapshot.items);
      const manifest = configModule.loadSyncManifest();
      if (!manifest) return true;
      for (const [bucketKey, bucket] of buckets) {
        const fingerprint = schema.computeBucketFingerprint(bucket.items);
        const existing = manifest.buckets[bucketKey];
        if (!existing || existing.fingerprint !== fingerprint) return true;
      }
    } catch { return true; }
  }
  const sourceFingerprint = snapshot.sourceFingerprint || "";
  const last = current?.syncStatus?.lastSuccessSourceFingerprint || "";
  if (sourceFingerprint && sourceFingerprint !== last) return true;
  return false;
}

// ── Sync ───────────────────────────────────────────────────────────

async function syncCurrentUsage({ config, core, crypto, current, scanned = null }) {
  if (!hasApiBaseUrl(current)) throw new Error("Configure API base URL first");
  const startedAt = new Date().toISOString();
  const apiBaseUrl = normalizeApiBaseUrl(current.apiBaseUrl);
  const usage = scanned || await getUsageSnapshot({ core, current, force: false });
  const { schema, version } = await modules();
  appendRuntimeLog("sync_start", { participantId: current.participantId, deviceId: current.deviceId, apiBaseUrl, rowCount: usage.items.length });

  const buckets = core.groupByBucket(usage.items);
  const client = version.clientMetadata({ clientAppVersion: APP_VERSION, clientBuild: `${version.clientPlatform()}-${APP_VERSION}` });

  let manifest = config.loadSyncManifest();
  const isNewManifest = !manifest;
  if (isNewManifest) manifest = { version: 1, buckets: {} };

  try {
    await postJson(`${apiBaseUrl}/api/devices/register`, {
      participantId: current.participantId, deviceId: current.deviceId, nickname: current.nickname,
      identityPublicKey: current.identityPublicKey, os: process.platform, appVersion: APP_VERSION, ...client,
      networkInfo: version.collectNetworkInfo()
    });

    const drainBefore = await drainUploadQueue(current, manifest);
    if (drainBefore.manifestChanged) config.saveSyncManifest(manifest);
    let totalAccepted = 0, totalRejected = 0, uploadedBucketCount = 0, noopBucketCount = 0;

    const dirty = [];
    for (const [bucketKey, bucket] of buckets) {
      if (!bucket.items.length) continue;
      const fingerprint = schema.computeBucketFingerprint(bucket.items);
      const totalTokens = bucket.items.reduce((s, i) => s + (i.totalTokens || 0), 0);
      const existing = manifest.buckets[bucketKey];
      if (existing && existing.fingerprint === fingerprint) { noopBucketCount += 1; continue; }
      dirty.push({ bucketKey, bucket, fingerprint, totalTokens });
    }

    const BUCKET_CONCURRENCY = 3;
    for (let i = 0; i < dirty.length; i += BUCKET_CONCURRENCY) {
      const batch = dirty.slice(i, i + BUCKET_CONCURRENCY);
      const results = await Promise.all(batch.map(async ({ bucketKey, bucket, fingerprint, totalTokens }) => {
        const snapshot = { mode: "device_day_provider", day: bucket.day, providerId: bucket.providerId, bucketFingerprint: fingerprint, rowCount: bucket.items.length, totalTokens };
        const payload = { participantId: current.participantId, deviceId: current.deviceId, clientGeneratedAt: new Date().toISOString(), client, snapshot, items: bucket.items };
        const signed = signedQueueEntry(payload, crypto.signPayload(current.identityPrivateKey, payload));
        const result = await uploadQueueEntry(current, signed);
        manifest.buckets[bucketKey] = { day: bucket.day, providerId: bucket.providerId, fingerprint, rowCount: bucket.items.length, totalTokens, syncedAt: new Date().toISOString() };
        return result;
      }));
      for (const r of results) { totalAccepted += r.accepted || 0; totalRejected += r.rejected || 0; uploadedBucketCount += 1; }
      config.saveSyncManifest(manifest);
    }

    if (!dirty.length) config.saveSyncManifest(manifest);
    const drainAfter = await drainUploadQueue(current, manifest);
    if (drainAfter.manifestChanged) config.saveSyncManifest(manifest);
    const syncResult = {
      accepted: totalAccepted, rejected: totalRejected, scanned: usage.items.length,
      sourceFingerprint: usage.sourceFingerprint || "", bucketCount: buckets.size,
      uploadedBucketCount, noopBucketCount, queued: false,
      queueUploaded: drainBefore.uploaded + drainAfter.uploaded, queuePending: drainAfter.pending
    };
    appendRuntimeLog("sync_success", { participantId: current.participantId, deviceId: current.deviceId, apiBaseUrl, accepted: syncResult.accepted, scanned: syncResult.scanned });
    persistSyncStatus(config, current, { apiBaseUrl, status: "success", startedAt, finishedAt: new Date().toISOString(), result: syncResult });
    return syncResult;
  } catch (error) {
    config.saveSyncManifest(manifest);
    let enqueuedCount = 0;
    for (const [bucketKey, bucket] of buckets) {
      if (!bucket.items.length) continue;
      const fingerprint = schema.computeBucketFingerprint(bucket.items);
      const totalTokens = bucket.items.reduce((s, i) => s + (i.totalTokens || 0), 0);
      const existing = manifest.buckets[bucketKey];
      if (existing && existing.fingerprint === fingerprint) continue;
      const snapshot = { mode: "device_day_provider", day: bucket.day, providerId: bucket.providerId, bucketFingerprint: fingerprint, rowCount: bucket.items.length, totalTokens };
      const payload = { participantId: current.participantId, deviceId: current.deviceId, clientGeneratedAt: new Date().toISOString(), client, snapshot, items: bucket.items };
      enqueueUpload(current, signedQueueEntry(payload, crypto.signPayload(current.identityPrivateKey, payload)), error.message);
      enqueuedCount += 1;
    }
    const syncResult = { accepted: 0, rejected: 0, scanned: usage.items.length, sourceFingerprint: usage.sourceFingerprint || "", queued: true, enqueuedBuckets: enqueuedCount, queuePending: readUploadQueue(current).items.length, error: error.message };
    appendRuntimeLog("sync_queued", { participantId: current.participantId, deviceId: current.deviceId, apiBaseUrl, scanned: syncResult.scanned, enqueuedBuckets: enqueuedCount, error: error.message });
    persistSyncStatus(config, current, { apiBaseUrl, status: "queued", startedAt, finishedAt: new Date().toISOString(), result: syncResult, error: error.message });
    return syncResult;
  }
}

// ── Background refresh ─────────────────────────────────────────────

async function scheduleBackgroundRefresh(configOverride = null) {
  if (background.timer) clearTimeout(background.timer);
  background.timer = null;
  background.nextRunAt = null;
  try {
    const { config } = await modules();
    const current = configOverride || config.loadConfig();
    const minutes = Math.max(1, Number(current?.refreshIntervalMinutes || 15));
    armBackgroundRefreshTimer(minutes * 60 * 1000);
  } catch (error) { background.lastError = error.message; }
}

function armBackgroundRefreshTimer(delayMs) {
  if (background.timer) clearTimeout(background.timer);
  background.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  background.timer = setTimeout(() => {
    background.timer = null;
    background.nextRunAt = null;
    runBackgroundRefresh({ reschedule: true }).catch(() => {});
  }, delayMs);
}

async function ensureBackgroundRefreshScheduled(current) {
  if (!background.timer) { await scheduleBackgroundRefresh(current); return; }
  const nextRunAt = Date.parse(background.nextRunAt || "");
  if (Number.isFinite(nextRunAt) && nextRunAt <= Date.now()) {
    clearTimeout(background.timer);
    background.timer = null;
    background.nextRunAt = null;
    runBackgroundRefresh({ reschedule: true }).catch(() => {});
  }
}

async function runBackgroundRefresh({ reschedule = false } = {}) {
  if (background.running) { if (reschedule) background.rescheduleAfterRun = true; return; }
  background.running = true;
  background.lastRunAt = new Date().toISOString();
  background.lastError = null;
  emitEvent("tray:refresh-start");
  appendRuntimeLog("background_refresh_start", { startedAt: background.lastRunAt });
  try {
    const { config, core, crypto } = await modules();
    const current = config.loadConfig();
    if (!current) { background.lastMode = "disabled"; background.lastResult = "No settings"; return; }
    const scanned = await getUsageSnapshot({ core, current, force: true });
    if (hasApiBaseUrl(current)) {
      const result = await syncCurrentUsage({ config, core, crypto, current, scanned });
      background.lastMode = "sync";
      background.lastResult = result.queued ? `Queued ${result.scanned} rows` : `Uploaded ${result.scanned} rows`;
      try {
        const priceRes = await fetchWithTimeout(`${current.apiBaseUrl}/api/model-prices`, {}, 3000);
        if (priceRes.ok) { const t = await priceRes.text(); refreshTrayPriceMap(t ? JSON.parse(t) : null); }
      } catch {}
      try {
        if (current.participantId) cachedIdentity = await getJson(`${current.apiBaseUrl}/api/board/my-identity?participantId=${encodeURIComponent(current.participantId)}`);
      } catch {}
    } else {
      background.lastMode = "scan";
      background.lastResult = `Refreshed ${scanned.items.length} rows`;
    }
    emitEvent("tray:refresh-done");
  } catch (error) {
    background.lastError = error.message;
    background.lastResult = "Failed";
    emitEvent("tray:refresh-failed");
    appendRuntimeLog("background_refresh_failed", { error: error.message });
  } finally {
    background.running = false;
    emitEvent("tray:rebuild");
    if (reschedule || background.rescheduleAfterRun) {
      background.rescheduleAfterRun = false;
      scheduleBackgroundRefresh().catch(() => {});
    }
  }
}

function backgroundStatus() {
  return {
    running: background.running, lastRunAt: background.lastRunAt, lastMode: background.lastMode,
    lastResult: background.lastResult, lastError: background.lastError, nextRunAt: background.nextRunAt,
    updateCheck: {
      status: updateCheck.status, lastCheckedAt: updateCheck.lastCheckedAt,
      lastResult: updateCheck.lastResult, lastError: updateCheck.lastError,
      nextCheckAt: updateCheck.nextCheckAt, downloadProgress: updateCheck.downloadProgress,
      readyPackage: updateCheck.readyPackage, update: updateCheck.lastResult
    }
  };
}

// ── Auto-update scheduling ─────────────────────────────────────────

async function scheduleUpdateCheck(configOverride = null) {
  if (updateCheck.timer) clearTimeout(updateCheck.timer);
  updateCheck.timer = null;
  updateCheck.nextCheckAt = null;
  try {
    const { config } = await modules();
    const current = configOverride || config.loadConfig();
    const minutes = Math.max(5, Number(current?.updateCheckIntervalMinutes || 360));
    armUpdateCheckTimer(minutes * 60 * 1000);
  } catch (error) { updateCheck.lastError = error.message; }
}

function armUpdateCheckTimer(delayMs) {
  if (updateCheck.timer) clearTimeout(updateCheck.timer);
  updateCheck.nextCheckAt = new Date(Date.now() + delayMs).toISOString();
  updateCheck.timer = setTimeout(() => {
    updateCheck.timer = null;
    updateCheck.nextCheckAt = null;
    runUpdateCheck({ reschedule: true }).catch(() => {});
  }, delayMs);
}

async function runUpdateCheck({ reschedule = false } = {}) {
  if (updateCheck.running) return;
  updateCheck.running = true;
  updateCheck.status = "checking";
  updateCheck.lastError = null;
  try {
    const { config, version } = await modules();
    const current = config.loadConfig();
    const apiBaseUrl = normalizeApiBaseUrl(current?.apiBaseUrl);
    if (!apiBaseUrl) {
      updateCheck.status = "idle";
      updateCheck.lastResult = { code: "cloud_not_configured", updateAvailable: false };
      return;
    }
    const url = `${apiBaseUrl}/api/tauri/update.json`;
    const data = await getJson(url, { timeoutMs: 10000 });
    const comparison = data?.version ? version.compareSemver(APP_VERSION, data.version) : 0;
    const updateAvailable = comparison < 0;
    updateCheck.lastResult = {
      code: updateAvailable ? "update_available" : "up_to_date",
      updateAvailable,
      latestVersion: data?.version || APP_VERSION
    };
    updateCheck.status = updateAvailable ? "available" : "idle";
    updateCheck.lastCheckedAt = new Date().toISOString();
    appendRuntimeLog("update_check_done", { updateAvailable, latestVersion: data?.version });
  } catch (error) {
    updateCheck.status = "failed";
    updateCheck.lastError = error.message;
    appendRuntimeLog("update_check_failed", { error: error.message });
  } finally {
    updateCheck.running = false;
    if (reschedule) scheduleUpdateCheck().catch(() => {});
  }
}

// ── Price map ──────────────────────────────────────────────────────

function refreshTrayPriceMap(data) {
  try {
    if (!data || !_modules?.pricing) { cachedPriceMap = null; return; }
    cachedPriceMap = _modules.pricing.createPriceMap(
      Object.fromEntries((data.custom || []).map((i) => [i.model, i])),
      Object.fromEntries((data.openrouter || []).map((i) => [i.model, i])),
      Object.fromEntries((data.aliases || []).map((i) => [i.model, i.targetModel]))
    );
    if (!Object.keys(cachedPriceMap).length) cachedPriceMap = null;
  } catch { cachedPriceMap = null; }
}

// ── Tray menu data ────────────────────────────────────────────────

async function buildTrayMenuData() {
  const { config, core, display, pricing } = await modules();
  const current = config.loadConfig();
  const lang = current?.language || "zh-CN";
  const items = [];

  items.push({ id: "open", label: trayT("tray.open"), action: "open" });

  const cached = readUsageCache();
  if (cached?.scannedAt) {
    const time = new Date(cached.scannedAt).toLocaleTimeString(lang === "zh-CN" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" });
    items.push({ id: "refresh", label: trayT("tray.refreshWithTime", { time }), action: "refresh" });
  } else {
    items.push({ id: "refresh", label: trayT("tray.refresh"), action: "refresh" });
  }

  if (hasApiBaseUrl(current)) {
    let cloudLabel = trayT("tray.visitCloudNoName");
    if (cachedIdentity?.displayName && cachedIdentity.identityMode === "anonymous") {
      cloudLabel = trayT("tray.visitCloud", { name: trayT("tray.anonymousUser", { name: cachedIdentity.displayName }) });
    } else if (current?.nickname) {
      cloudLabel = trayT("tray.visitCloud", { name: trayT("tray.user", { name: current.nickname }) });
    }
    items.push({ id: "cloud", label: cloudLabel, action: "visit-cloud", url: current.apiBaseUrl });
  } else {
    items.push({ id: "cloud-local", label: trayT("tray.cloudLocal"), disabled: true });
  }
  items.push({ type: "separator" });

  if (cached?.items?.length) {
    const today = (await modules()).date.localDay();
    const todayItems = cached.items.filter((i) => i.day === today);
    if (todayItems.length) {
      const todayTotal = todayItems.reduce((s, i) => s + (i.totalTokens || 0), 0);
      items.push({ id: "today", label: trayT("tray.tokensToday", { count: display.formatTokenCompact(todayTotal) }), disabled: true });

      if (cachedPriceMap && todayItems.length) {
        const cost = pricing.aggregateCost(todayItems, cachedPriceMap);
        if (cost > 0) items.push({ id: "cost", label: trayT("tray.cost", { cost: display.formatUsd(cost) }), disabled: true });
      }

      items.push({ type: "separator" });
      const modelTotals = {};
      for (const item of todayItems) { modelTotals[item.model] = (modelTotals[item.model] || 0) + (item.totalTokens || 0); }
      const topModels = Object.entries(modelTotals).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (topModels.length) {
        items.push({ id: "models-title", label: trayT("tray.modelsTitle"), disabled: true });
        for (const [model, total] of topModels) {
          const shortModel = model.includes("/") ? model.split("/").pop() : model;
          items.push({ id: `model:${model}`, label: `  ${shortModel}  ${display.formatTokenCompact(total)}`, disabled: true });
        }
      }

      const providerTotals = {};
      for (const item of todayItems) { providerTotals[item.providerId] = (providerTotals[item.providerId] || 0) + (item.totalTokens || 0); }
      const providers = Object.entries(providerTotals).sort((a, b) => b[1] - a[1]);
      if (providers.length) {
        items.push({ type: "separator" });
        items.push({ id: "providers-title", label: trayT("tray.providersTitle"), disabled: true });
        for (const [pid, total] of providers) {
          items.push({ id: `provider:${pid}`, label: `  ${TRAY_PROVIDER_NAMES[pid] || pid}  ${display.formatTokenCompact(total)}`, disabled: true });
        }
      }
    } else {
      items.push({ id: "no-usage", label: trayT("tray.noUsage"), disabled: true });
    }
  } else {
    items.push({ id: "no-usage", label: trayT("tray.noUsage"), disabled: true });
  }

  items.push({ type: "separator" });
  items.push({ id: "quit", label: trayT("tray.quit"), action: "quit" });
  return items;
}

// ── Reset ──────────────────────────────────────────────────────────

function resetLocalData(configModule) {
  if (background.timer) clearTimeout(background.timer);
  if (updateCheck.timer) clearInterval(updateCheck.timer);
  background.timer = null; background.running = false; background.nextRunAt = null;
  updateCheck.timer = null; updateCheck.running = false; updateCheck.downloadRunning = false;
  updateCheck.applyRunning = false; updateCheck.status = "idle"; updateCheck.nextCheckAt = null;
  updateCheck.downloadProgress = null;
  usageCache.loaded = true; usageCache.data = null;
  foregroundScan.running = false; foregroundScan.taskId += 1; foregroundScan.error = null;
  foregroundScan.syncResult = null; foregroundScan.syncError = ""; foregroundScan.snapshot = null;
  try { fs.rmSync(configModule.APP_DIR || APP_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(USAGE_CACHE_FILE, { force: true }); } catch {}
  try { fs.rmSync(RUNTIME_LOG_FILE, { force: true }); } catch {}
}

// ── Diagnostics ────────────────────────────────────────────────────

async function diagnosticsBundle(configModule, current) {
  const usage = readUsageCache();
  const queue = readUploadQueue(current);
  const logs = readRuntimeLog(500);
  return {
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    platform: process.platform,
    arch: process.arch,
    config: sanitizeConfig(current),
    usageCache: { rowCount: usage?.items?.length || 0, scannedAt: usage?.scannedAt || "", sourceFingerprint: usage?.sourceFingerprint || "" },
    uploadQueue: { pending: queue.items.length, items: queue.items.map((i) => ({ day: i.snapshot?.day, providerId: i.snapshot?.providerId, attemptCount: i.attemptCount, enqueuedAt: i.enqueuedAt })) },
    runtimeLog: logs
  };
}

// ── Event emission ─────────────────────────────────────────────────

function emitEvent(event, data = null) {
  const line = JSON.stringify({ event, data });
  process.stdout.write(line + "\n");
}

function writeResponse(id, ok, data, error = "") {
  const line = JSON.stringify({ id, ok, data, error });
  process.stdout.write(line + "\n");
}

// ── Command handlers ───────────────────────────────────────────────

const handlers = {
  "config:get": async () => {
    const { config, preset } = await modules();
    return sanitizeConfig(await ensureDesktopConfig(config, preset));
  },

  "api:check": async (args) => checkApiConnection(args),

  "config:init": async (args) => {
    const { config } = await modules();
    const current = config.loadConfig();
    const previousApiBaseUrl = normalizeApiBaseUrl(current?.apiBaseUrl || "");
    const prepared = await prepareConfigInput(args, current);
    const next = current ? config.updateConfig(prepared, current) : config.initConfig(prepared);
    invalidateCloudStateForApiChange(previousApiBaseUrl, next);
    if (previousApiBaseUrl !== normalizeApiBaseUrl(next.apiBaseUrl)) config.clearSyncManifest();
    invalidateUsageCache();
    appendRuntimeLog("config_saved", configLogSummary(next));
    cachedConfig = next;
    scheduleBackgroundRefresh(next);
    scheduleUpdateCheck(next);
    return sanitizeConfig(next);
  },

  "config:update": async (args) => {
    const { config } = await modules();
    const current = config.loadConfig();
    const previousApiBaseUrl = normalizeApiBaseUrl(current?.apiBaseUrl || "");
    const next = config.updateConfig(await prepareConfigInput(args, current), current);
    invalidateCloudStateForApiChange(previousApiBaseUrl, next);
    if (previousApiBaseUrl !== normalizeApiBaseUrl(next.apiBaseUrl)) config.clearSyncManifest();
    invalidateUsageCache();
    appendRuntimeLog("config_saved", configLogSummary(next));
    cachedConfig = next;
    scheduleBackgroundRefresh(next);
    scheduleUpdateCheck(next);
    return sanitizeConfig(next);
  },

  // Export/import — sidecar prepares/applies data; Rust handles file dialogs
  "identity:export:prepare": async () => {
    const { config } = await modules();
    const current = config.loadConfig();
    if (!current) throw new Error("Open Settings first");
    return config.exportIdentity(current);
  },

  "identity:import:apply": async (args) => {
    const { config } = await modules();
    const identity = typeof args === "string" ? JSON.parse(args) : args;
    const next = config.importIdentity(identity, config.loadConfig() || {});
    appendRuntimeLog("identity_imported", { participantId: next.participantId, deviceId: next.deviceId });
    cachedConfig = next;
    scheduleBackgroundRefresh(next);
    scheduleUpdateCheck(next);
    return sanitizeConfig(next);
  },

  "config:export:prepare": async () => {
    const { config } = await modules();
    const current = config.loadConfig();
    if (!current) throw new Error("Open Settings first");
    return config.exportConfig(current);
  },

  "config:import:apply": async (args) => {
    const { config } = await modules();
    const imported = typeof args === "string" ? JSON.parse(args) : args;
    let next = config.importConfig(imported);
    next = await ensureDesktopConfig(config, _modules.preset); // ensure apiConnection
    next = { ...next, ...(await prepareConfigInput({ apiBaseUrl: next.apiBaseUrl }, next)) };
    appendRuntimeLog("config_imported", { participantId: next.participantId, deviceId: next.deviceId });
    cachedConfig = next;
    scheduleBackgroundRefresh(next);
    scheduleUpdateCheck(next);
    return sanitizeConfig(next);
  },

  "diagnostics:export:prepare": async () => {
    const { config } = await modules();
    const current = config.loadConfig();
    if (!current) throw new Error("Open Settings first");
    return diagnosticsBundle(config, current);
  },

  "providers:add-root": async (args) => {
    const { config } = await modules();
    const current = config.loadConfig();
    if (!current) throw new Error("Open Settings first");
    // args is { providerId, path } when coming from Rust dialog
    const providerId = args?.providerId || args;
    const rootPath = args?.path;
    if (!rootPath) throw new Error("No path provided");
    const next = config.addProviderRoot(providerId, rootPath, current);
    invalidateUsageCache();
    appendRuntimeLog("provider_root_added", { providerId, participantId: next.participantId });
    return sanitizeConfig(next);
  },

  "config:remove-provider-root": async (args) => {
    const { config } = await modules();
    const current = config.loadConfig();
    if (!current) throw new Error("Open Settings first");
    const next = config.removeProviderRoot(args[0] || args.providerId, args[1] || args.rootPath, current);
    invalidateUsageCache();
    return sanitizeConfig(next);
  },

  "cursor:add-token": async (args) => {
    const { config } = await modules();
    const current = config.loadConfig();
    if (!current) throw new Error("Open Settings first");
    const next = config.addCursorToken(args, current);
    invalidateUsageCache();
    appendRuntimeLog("cursor_token_added", { participantId: next.participantId, accountCount: next.cursorDashboardUsage?.workosSessionTokens?.length || 0 });
    return sanitizeConfig(next);
  },

  "cursor:remove-token": async (args) => {
    const { config } = await modules();
    const current = config.loadConfig();
    if (!current) throw new Error("Open Settings first");
    const next = config.removeCursorToken(args, current);
    invalidateUsageCache();
    return sanitizeConfig(next);
  },

  "config:ignore-auto-source": async (args) => {
    const { config } = await modules();
    const current = config.loadConfig();
    if (!current) throw new Error("Open Settings first");
    const next = config.ignoreAutoSource(args[0] || args.providerId, args[1] || args.sourceId, current);
    invalidateUsageCache();
    return sanitizeConfig(next);
  },

  "config:unignore-auto-source": async (args) => {
    const { config } = await modules();
    const current = config.loadConfig();
    if (!current) throw new Error("Open Settings first");
    const next = config.unignoreAutoSource(args[0] || args.providerId, args[1] || args.sourceId, current);
    invalidateUsageCache();
    return sanitizeConfig(next);
  },

  "background:status": async () => {
    const { config } = await modules();
    const current = config.loadConfig();
    if (current) await ensureBackgroundRefreshScheduled(current);
    return backgroundStatus();
  },

  "workdirs:set-alias": async (args) => {
    const { config } = await modules();
    const current = config.loadConfig();
    if (!current) throw new Error("Open Settings first");
    const next = config.setWorkdirAlias(args.workdirHash, args.alias, current);
    invalidateUsageCache();
    appendRuntimeLog("workdir_alias_saved", { participantId: next.participantId, workdirHash: args.workdirHash });
    return sanitizeConfig(next);
  },

  "providers:health": async () => {
    const { config, core, preset } = await modules();
    const current = await ensureDesktopConfig(config, preset);
    return core.providerHealth(current);
  },

  "pricing:model-prices": async () => {
    const { config } = await modules();
    const current = config.loadConfig();
    if (!current || !hasApiBaseUrl(current)) return null;
    const data = await getJson(`${current.apiBaseUrl}/api/model-prices`, { timeoutMs: 3000 });
    refreshTrayPriceMap(data);
    return data;
  },

  "usage:scan": async (args) => {
    const { config, core, preset } = await modules();
    const current = await ensureDesktopConfig(config, preset);
    return getUsageSnapshot({ core, current, force: Boolean(args?.force) });
  },

  "usage:scan-start": async (args) => {
    const { config, core, crypto, preset } = await modules();
    const current = await ensureDesktopConfig(config, preset);
    startForegroundScan({ config, core, crypto, current, force: Boolean(args?.force) });
    return foregroundScanStatus();
  },

  "usage:scan-status": async () => foregroundScanStatus(),

  "usage:sync": async () => {
    const { config, core, crypto } = await modules();
    const current = config.loadConfig();
    if (!current) throw new Error("Open Settings first");
    return syncCurrentUsage({ config, core, crypto, current });
  },

  "my-identity": async () => {
    const { config } = await modules();
    const current = config.loadConfig();
    const apiBaseUrl = normalizeApiBaseUrl(current?.apiBaseUrl);
    if (!apiBaseUrl || !current?.participantId) return { identityMode: "public", displayName: "" };
    try {
      return await getJson(`${apiBaseUrl}/api/board/my-identity?participantId=${encodeURIComponent(current.participantId)}`);
    } catch { return { identityMode: "public", displayName: "" }; }
  },

  "app:version": async () => {
    const { version } = await modules();
    return version.clientMetadata({ clientAppVersion: APP_VERSION, clientBuild: `${version.clientPlatform()}-${APP_VERSION}` });
  },

  // update:check, update:download, update:install-and-restart are handled
  // natively by Tauri's updater plugin via Rust commands (see tauri-bridge.js).

  "update:download-installer": async () => {
    // Opens the download page in the browser for manual installer download
    const { config } = await modules();
    const current = config.loadConfig();
    const base = current?.release?.publicBaseUrl || "";
    if (!base) throw new Error("Release not configured");
    return { ok: true, url: `${base}/releases/` };
  },

  "update:enforcement-status": async () => {
    const { config, version } = await modules();
    const current = config.loadConfig();
    const apiBaseUrl = normalizeApiBaseUrl(current?.apiBaseUrl);
    if (!apiBaseUrl) return { mandatory: false, compatible: true, status: "cloud_not_configured" };
    try {
      const query = clientQuery(version, APP_VERSION);
      const health = await getJson(`${apiBaseUrl}/api/health?${query}`, { timeoutMs: 8000 });
      return {
        mandatory: health?.compatibility?.mandatory || false,
        compatible: health?.compatibility?.compatible !== false,
        status: health?.compatibility?.status || "compatible",
        latestVersion: health?.latestClientVersion || "",
        reason: health?.compatibility?.reason || ""
      };
    } catch (error) {
      return { mandatory: false, compatible: true, status: "check_failed", error: error.message };
    }
  },

  "app:reset-local-data": async () => {
    const { config } = await modules();
    resetLocalData(config);
    // Signal Rust to restart the app
    emitEvent("app:restart");
    return { ok: true };
  },

  "app:reset-with-cloud": async () => {
    const { config, crypto } = await modules();
    const current = config.loadConfig();
    if (!current?.participantId) throw new Error("No participant identity found");
    if (!hasApiBaseUrl(current)) throw new Error("Configure API base URL first");
    const apiBaseUrl = normalizeApiBaseUrl(current.apiBaseUrl);
    const timestamp = new Date().toISOString();
    const payload = { participantId: current.participantId, timestamp };
    const signature = crypto.signPayload(current.identityPrivateKey, payload);
    const response = await fetch(`${apiBaseUrl}/api/participant/data`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, signature })
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Cloud delete failed: ${response.status} ${text}`);
    resetLocalData(config);
    emitEvent("app:restart");
    return { ok: true };
  },

  "tray:rebuild-menu": async () => {
    emitEvent("tray:rebuild");
    return { ok: true };
  },

  "tray:menu-data": async () => buildTrayMenuData(),

  "tray:refresh-now": async () => {
    runBackgroundRefresh({ reschedule: false }).catch(() => {});
    return { ok: true };
  },

  "ping": async () => ({ ok: true, ts: Date.now() })
};

// ── Main loop ──────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }

  const { id, command, args } = request;
  if (!command) return;

  const handler = handlers[command];
  if (!handler) {
    if (id) writeResponse(id, false, null, `Unknown command: ${command}`);
    return;
  }

  try {
    const data = await handler(args ?? null);
    if (id) writeResponse(id, true, data ?? null);
  } catch (error) {
    if (id) writeResponse(id, false, null, error.message || String(error));
  }
});

rl.on("close", () => {
  if (background.timer) clearTimeout(background.timer);
  if (updateCheck.timer) clearInterval(updateCheck.timer);
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  appendRuntimeLog("sidecar_uncaught", { error: error.message, stack: error.stack?.slice(0, 500) });
});

process.on("unhandledRejection", (reason) => {
  appendRuntimeLog("sidecar_unhandled_rejection", { error: String(reason).slice(0, 500) });
});

// Preload modules on startup for faster first response
modules().catch(() => {});

// Schedule first update check 30s after launch (don't block startup)
setTimeout(() => { scheduleUpdateCheck().catch(() => {}); }, 30_000);

process.stderr.write(`[sidecar] ready (v${APP_VERSION}, ${process.platform}-${process.arch})\n`);
