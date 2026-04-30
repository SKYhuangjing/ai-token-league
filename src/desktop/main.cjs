const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const nodeCrypto = require("node:crypto");
const os = require("node:os");

const background = {
  timer: null,
  running: false,
  lastRunAt: null,
  lastMode: null,
  lastResult: null,
  lastError: null,
  nextRunAt: null
};

const usageCache = {
  data: null,
  loaded: false,
  cacheTtlMs: 5 * 60 * 1000
};

const foregroundScan = {
  running: false,
  taskId: 0,
  force: false,
  startedAt: null,
  finishedAt: null,
  error: null,
  snapshot: null
};

function pathToFileUrl(file) {
  return `file://${file.replaceAll("\\", "/")}`;
}

async function modules() {
  const root = app.getAppPath();
  return {
    config: await import(pathToFileUrl(path.join(root, "src/collector/config.js"))),
    core: await import(pathToFileUrl(path.join(root, "src/collector/core.js"))),
    crypto: await import(pathToFileUrl(path.join(root, "src/shared/crypto.js"))),
    schema: await import(pathToFileUrl(path.join(root, "src/shared/schema.js")))
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 920,
    minHeight: 680,
    title: "AI Token League",
    icon: path.join(app.getAppPath(), "assets", process.platform === "win32" ? "app-icon.ico" : "app-icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(async () => {
  if (process.argv.includes("--desktop-smoke")) {
    modules()
      .then(({ config, core }) => {
        console.log(JSON.stringify({
          ok: true,
          hasConfig: typeof config.loadConfig === "function",
          providers: core.providers.map((provider) => provider.id)
        }));
        app.quit();
      })
      .catch((error) => {
        console.error(error);
        app.exit(1);
      });
    return;
  }
  const { config } = await modules();
  const current = ensureDesktopConfig(config);
  applyLaunchAtLogin(current);
  await scheduleBackgroundRefresh(current);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("config:get", async () => {
  const { config } = await modules();
  return sanitizeConfig(ensureDesktopConfig(config));
});

ipcMain.handle("api:check", async (_event, apiBaseUrl) => {
  return checkApiConnection(apiBaseUrl);
});

ipcMain.handle("config:init", async (_event, input) => {
  const { config } = await modules();
  const current = config.loadConfig();
  const prepared = await prepareConfigInput(input, current);
  const next = current ? config.updateConfig(prepared, current) : config.initConfig(prepared);
  invalidateUsageCache();
  applyLaunchAtLogin(next);
  scheduleBackgroundRefresh(next);
  return sanitizeConfig(next);
});

ipcMain.handle("config:update", async (_event, input) => {
  const { config } = await modules();
  const current = config.loadConfig();
  const next = config.updateConfig(await prepareConfigInput(input, current), current);
  invalidateUsageCache();
  applyLaunchAtLogin(next);
  scheduleBackgroundRefresh(next);
  return sanitizeConfig(next);
});

ipcMain.handle("identity:export", async () => {
  const { config } = await modules();
  const current = config.loadConfig();
  if (!current) throw new Error("Open Settings first");
  const target = await dialog.showSaveDialog({
    title: "Export AI Token League Profile",
    defaultPath: "ai-token-league-profile.json",
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (target.canceled || !target.filePath) return { canceled: true };
  fs.writeFileSync(target.filePath, `${JSON.stringify(config.exportIdentity(current), null, 2)}\n`);
  return { canceled: false, filePath: target.filePath };
});

ipcMain.handle("identity:import", async () => {
  const { config } = await modules();
  const source = await dialog.showOpenDialog({
    title: "Import AI Token League Profile",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (source.canceled || !source.filePaths[0]) return { canceled: true };
  const identity = JSON.parse(fs.readFileSync(source.filePaths[0], "utf8"));
  const next = config.importIdentity(identity, config.loadConfig() || {});
  applyLaunchAtLogin(next);
  scheduleBackgroundRefresh(next);
  return sanitizeConfig(next);
});

ipcMain.handle("providers:add-root", async (_event, providerId) => {
  const { config } = await modules();
  const current = config.loadConfig();
  if (!current) throw new Error("Open Settings first");
  const source = await dialog.showOpenDialog({
    title: "Add local source location",
    properties: ["openDirectory"]
  });
  if (source.canceled || !source.filePaths[0]) return { canceled: true };
  const next = config.addProviderRoot(providerId, source.filePaths[0], current);
  invalidateUsageCache();
  return sanitizeConfig(next);
});

ipcMain.handle("cursor:add-token", async (_event, rawInput) => {
  const { config } = await modules();
  const current = config.loadConfig();
  if (!current) throw new Error("Open Settings first");
  const next = config.addCursorToken(rawInput, current);
  invalidateUsageCache();
  return sanitizeConfig(next);
});

ipcMain.handle("background:status", async () => {
  const { config } = await modules();
  const current = config.loadConfig();
  if (current && current.autoRefreshEnabled !== false && !background.timer) await scheduleBackgroundRefresh(current);
  return backgroundStatus();
});

ipcMain.handle("workdirs:set-alias", async (_event, input) => {
  const { config } = await modules();
  const current = config.loadConfig();
  if (!current) throw new Error("Open Settings first");
  const next = config.setWorkdirAlias(input.workdirHash, input.alias, current);
  invalidateUsageCache();
  return sanitizeConfig(next);
});

ipcMain.handle("providers:health", async () => {
  const { config, core } = await modules();
  const current = ensureDesktopConfig(config);
  return core.providerHealth(current);
});

ipcMain.handle("pricing:model-prices", async () => {
  const { config } = await modules();
  const current = config.loadConfig();
  if (!current || !hasApiBaseUrl(current)) return null;
  const response = await fetch(`${current.apiBaseUrl}/api/model-prices`);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
});

ipcMain.handle("usage:scan", async (_event, options = {}) => {
  const { config, core } = await modules();
  const current = ensureDesktopConfig(config);
  return getUsageSnapshot({ config, core, current, force: Boolean(options.force) });
});

ipcMain.handle("usage:scan-start", async (_event, options = {}) => {
  const { config, core } = await modules();
  const current = ensureDesktopConfig(config);
  startForegroundScan({ config, core, current, force: Boolean(options.force) });
  return foregroundScanStatus();
});

ipcMain.handle("usage:scan-status", async () => {
  return foregroundScanStatus();
});

ipcMain.handle("usage:sync", async () => {
  const { config, core, crypto } = await modules();
  const current = config.loadConfig();
  if (!current) throw new Error("Open Settings first");
  return syncCurrentUsage({ config, core, crypto, current });
});

ipcMain.handle("app:reset-local-data", async () => {
  const { config } = await modules();
  resetLocalData(config);
  app.relaunch();
  app.exit(0);
  return { ok: true };
});

async function scheduleBackgroundRefresh(configOverride = null) {
  if (background.timer) clearInterval(background.timer);
  background.timer = null;
  background.nextRunAt = null;
  try {
    const { config } = await modules();
    const current = configOverride || config.loadConfig();
    if (current?.autoRefreshEnabled === false) return;
    const minutes = Math.max(1, Number(current.refreshIntervalMinutes || 15));
    const intervalMs = minutes * 60 * 1000;
    background.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    background.timer = setInterval(() => {
      runBackgroundRefresh().catch(() => {});
      background.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    }, intervalMs);
  } catch (error) {
    background.lastError = error.message;
  }
}

async function runBackgroundRefresh() {
  if (background.running) return;
  background.running = true;
  background.lastRunAt = new Date().toISOString();
  background.lastError = null;
  try {
    const { config, core, crypto } = await modules();
    const current = config.loadConfig();
    if (!current) {
      background.lastMode = "disabled";
      background.lastResult = "No settings";
      return;
    }
    const scanned = await getUsageSnapshot({ config, core, current, force: true });
    if (hasApiBaseUrl(current)) {
      const result = await syncCurrentUsage({ config, core, crypto, current, scanned });
      background.lastMode = "sync";
      background.lastResult = result.queued ? `Queued ${result.scanned} rows` : `Uploaded ${result.scanned} rows`;
    } else {
      background.lastMode = "scan";
      background.lastResult = `Refreshed ${scanned.items.length} rows`;
    }
  } catch (error) {
    background.lastError = error.message;
    background.lastResult = "Failed";
  } finally {
    background.running = false;
  }
}

async function syncCurrentUsage({ config, core, crypto, current, scanned = null }) {
  if (!hasApiBaseUrl(current)) throw new Error("Configure API base URL first");
  const startedAt = new Date().toISOString();
  const apiBaseUrl = String(current.apiBaseUrl || "").trim();
  const usage = scanned || await getUsageSnapshot({ config, core, current, force: false });
  try {
    await postJson(`${apiBaseUrl}/api/devices/register`, {
      participantId: current.participantId,
      deviceId: current.deviceId,
      nickname: current.nickname,
      identityPublicKey: current.identityPublicKey,
      os: process.platform,
      appVersion: app.getVersion()
    });
    const payload = {
      participantId: current.participantId,
      deviceId: current.deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: usage.items
    };
    const drainBefore = await drainUploadQueue(current);
    const signed = signedQueueEntry(payload, crypto.signPayload(current.identityPrivateKey, payload));
    const result = await uploadQueueEntry(current, signed);
    const drainAfter = await drainUploadQueue(current);
    const syncResult = {
      ...result,
      scanned: usage.items.length,
      queued: false,
      queueUploaded: drainBefore.uploaded + drainAfter.uploaded,
      queuePending: drainAfter.pending
    };
    persistSyncStatus(config, current, {
      apiBaseUrl,
      status: "success",
      startedAt,
      finishedAt: new Date().toISOString(),
      result: syncResult
    });
    return syncResult;
  } catch (error) {
    const payload = {
      participantId: current.participantId,
      deviceId: current.deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: usage.items
    };
    const signed = signedQueueEntry(payload, crypto.signPayload(current.identityPrivateKey, payload));
    const queued = enqueueUpload(current, signed, error.message);
    const syncResult = {
      accepted: 0,
      rejected: 0,
      scanned: usage.items.length,
      queued: true,
      queueId: queued.id,
      queuePending: readUploadQueue(current).items.length,
      error: error.message
    };
    persistSyncStatus(config, current, {
      apiBaseUrl,
      status: "queued",
      startedAt,
      finishedAt: new Date().toISOString(),
      result: syncResult,
      error: error.message
    });
    return syncResult;
  }
}

function persistSyncStatus(configModule, current, { apiBaseUrl, status, startedAt, finishedAt, result, error = "" }) {
  const previous = current.syncStatus || {};
  const syncStatus = {
    apiBaseUrl,
    lastAttemptAt: startedAt,
    lastFinishedAt: finishedAt,
    lastSuccessAt: status === "success" ? finishedAt : previous.lastSuccessAt || "",
    status,
    scanned: result.scanned || 0,
    accepted: result.accepted || 0,
    rejected: result.rejected || 0,
    queueUploaded: result.queueUploaded || 0,
    queuePending: result.queuePending || 0,
    error
  };
  configModule.saveConfig({
    ...current,
    syncStatus,
    lastSyncAt: finishedAt,
    lastSyncStatus: status,
    lastSyncApiBaseUrl: apiBaseUrl,
    lastSyncError: error,
    updatedAt: finishedAt
  });
}

async function getUsageSnapshot({ core, current, force = false }) {
  const cached = readUsageCache();
  if (!force && cached && Date.now() - Date.parse(cached.scannedAt) < usageCache.cacheTtlMs) {
    return { ...cached, fromCache: true };
  }
  const scanned = await core.scanUsage({ ...current, __usageCacheIndex: cached?.sourceIndex || {} });
  const snapshot = {
    ...scanned,
    cacheVersion: 2,
    scannedAt: new Date().toISOString(),
    rowCount: scanned.items.length,
    sourceFingerprint: snapshotFingerprint(scanned.items),
    fromCache: false
  };
  writeUsageCache(snapshot);
  return snapshot;
}

function startForegroundScan({ config, core, current, force = false }) {
  const cached = readUsageCache();
  if (foregroundScan.running) return;
  if (!force && cached && Date.now() - Date.parse(cached.scannedAt) < usageCache.cacheTtlMs) {
    foregroundScan.snapshot = cached;
    foregroundScan.startedAt = cached.scannedAt;
    foregroundScan.finishedAt = cached.scannedAt;
    foregroundScan.error = null;
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
  foregroundScan.snapshot = cached || null;
  setTimeout(() => {
    getUsageSnapshot({ config, core, current, force })
      .then((snapshot) => {
        if (foregroundScan.taskId !== taskId) return;
        foregroundScan.snapshot = snapshot;
        foregroundScan.finishedAt = new Date().toISOString();
      })
      .catch((error) => {
        if (foregroundScan.taskId !== taskId) return;
        foregroundScan.error = error.message;
        foregroundScan.finishedAt = new Date().toISOString();
      })
      .finally(() => {
        if (foregroundScan.taskId !== taskId) return;
        foregroundScan.running = false;
      });
  }, 0);
}

function foregroundScanStatus() {
  const snapshot = foregroundScan.snapshot || readUsageCache();
  return {
    running: foregroundScan.running,
    taskId: foregroundScan.taskId,
    force: foregroundScan.force,
    startedAt: foregroundScan.startedAt,
    finishedAt: foregroundScan.finishedAt,
    error: foregroundScan.error,
    snapshot: snapshot ? publicUsageSnapshot(snapshot) : null
  };
}

function publicUsageSnapshot(snapshot) {
  return {
    items: snapshot.items || [],
    health: snapshot.health || [],
    cacheVersion: snapshot.cacheVersion,
    scannedAt: snapshot.scannedAt || null,
    rowCount: snapshot.rowCount || 0,
    sourceFingerprint: snapshot.sourceFingerprint || "",
    fromCache: Boolean(snapshot.fromCache)
  };
}

function usageCachePath() {
  return path.join(app.getPath("userData"), "usage-cache.json");
}

function readUsageCache() {
  if (usageCache.loaded) return usageCache.data;
  usageCache.loaded = true;
  try {
    const file = usageCachePath();
    usageCache.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  } catch {
    usageCache.data = null;
  }
  return usageCache.data;
}

function writeUsageCache(snapshot) {
  usageCache.loaded = true;
  usageCache.data = snapshot;
  fs.mkdirSync(path.dirname(usageCachePath()), { recursive: true });
  fs.writeFileSync(usageCachePath(), `${JSON.stringify(snapshot, null, 2)}\n`);
}

function invalidateUsageCache() {
  usageCache.loaded = true;
  usageCache.data = null;
  try {
    fs.rmSync(usageCachePath(), { force: true });
  } catch {}
}

function resetLocalData(configModule) {
  if (background.timer) clearInterval(background.timer);
  background.timer = null;
  background.running = false;
  background.nextRunAt = null;
  usageCache.loaded = true;
  usageCache.data = null;
  foregroundScan.running = false;
  foregroundScan.taskId += 1;
  foregroundScan.error = null;
  foregroundScan.snapshot = null;
  try {
    fs.rmSync(configModule.APP_DIR, { recursive: true, force: true });
  } catch {}
  try {
    fs.rmSync(usageCachePath(), { force: true });
  } catch {}
}

function hasApiBaseUrl(config) {
  return Boolean(String(config?.apiBaseUrl || "").trim());
}

async function prepareConfigInput(input = {}, current = null) {
  if (!Object.hasOwn(input, "apiBaseUrl")) return input;
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const previousApiBaseUrl = normalizeApiBaseUrl(current?.apiBaseUrl || "");
  const shouldCheckApi = !current || apiBaseUrl !== previousApiBaseUrl || (apiBaseUrl && !current.apiConnection?.checkedAt);
  if (!shouldCheckApi) return { ...input, apiBaseUrl };
  const apiConnection = await checkApiConnection(apiBaseUrl);
  const next = {
    ...input,
    apiBaseUrl,
    apiConnection
  };
  if (apiBaseUrl !== previousApiBaseUrl) {
    next.syncStatus = {};
    next.lastSyncAt = "";
    next.lastSyncStatus = "";
    next.lastSyncApiBaseUrl = "";
    next.lastSyncError = "";
  }
  return next;
}

async function checkApiConnection(apiBaseUrl) {
  const normalized = normalizeApiBaseUrl(apiBaseUrl);
  const checkedAt = new Date().toISOString();
  if (!normalized) {
    return {
      ok: true,
      status: "not_configured",
      apiBaseUrl: "",
      checkedAt,
      message: "API not configured"
    };
  }
  let healthUrl;
  try {
    const base = new URL(normalized);
    if (!["http:", "https:"].includes(base.protocol)) throw new Error("API base URL must use http or https");
    healthUrl = new URL("/api/health", base).toString();
  } catch (error) {
    throw new Error(`Invalid API base URL: ${error.message}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {}
    if (!response.ok || body.ok !== true) {
      const detail = body.error || text || response.statusText;
      throw new Error(`${response.status} ${detail}`.trim());
    }
    return {
      ok: true,
      status: "reachable",
      apiBaseUrl: normalized,
      checkedAt,
      dbType: body.dbType || "",
      serverTime: body.serverTime || "",
      message: "API reachable"
    };
  } catch (error) {
    const reason = error.name === "AbortError" ? "request timed out" : error.message;
    throw new Error(`API health check failed: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeApiBaseUrl(apiBaseUrl) {
  return String(apiBaseUrl || "").trim().replace(/\/+$/, "");
}

function backgroundStatus() {
  const { items: queuedItems } = readUploadQueue();
  return {
    enabled: Boolean(background.timer),
    running: background.running,
    lastRunAt: background.lastRunAt,
    lastMode: background.lastMode,
    lastResult: background.lastResult,
    lastError: background.lastError,
    nextRunAt: background.nextRunAt,
    cacheScannedAt: readUsageCache()?.scannedAt || null,
    cacheRowCount: readUsageCache()?.rowCount || 0,
    queuePending: queuedItems.length
  };
}

function snapshotFingerprint(items = []) {
  const text = items
    .map((item) => [item.day, item.toolCode, item.providerId, item.workdirHash, item.model, item.totalTokens, item.sourceFingerprint].join("|"))
    .sort()
    .join("\n");
  return nodeCrypto.createHash("sha256").update(text).digest("hex");
}

function ensureDesktopConfig(configModule) {
  const current = configModule.loadConfig();
  if (current) {
    if (!Object.hasOwn(current, "desktopAutoInitialized") && isUnconfirmedDesktopProfile(current)) {
      const next = configModule.updateConfig({ desktopAutoInitialized: true }, current);
      return next;
    }
    return current;
  }
  return configModule.initConfig({
    apiBaseUrl: "",
    desktopAutoInitialized: true,
    apiConnection: {
      ok: true,
      status: "not_configured",
      apiBaseUrl: "",
      checkedAt: new Date().toISOString(),
      message: "API not configured"
    }
  });
}

function isUnconfirmedDesktopProfile(current) {
  return (
    (current.nickname || "anonymous") === "anonymous" &&
    !String(current.apiBaseUrl || "").trim() &&
    !current.lastSyncAt &&
    !Object.keys(current.workdirAliases || {}).length &&
    !Object.keys(current.providerRoots || {}).length &&
    !current.cursorDashboardUsage?.workosSessionToken &&
    !(current.cursorDashboardUsage?.workosSessionTokens || []).length
  );
}

function uploadQueuePath(current = null) {
  if (current?.uploadQueuePath) return current.uploadQueuePath;
  return path.join(os.homedir(), ".ai-token-league", "upload-queue.json");
}

function readUploadQueue(current = null) {
  try {
    const file = uploadQueuePath(current);
    if (!fs.existsSync(file)) return { version: 1, items: [] };
    const queue = JSON.parse(fs.readFileSync(file, "utf8"));
    return { version: 1, items: Array.isArray(queue.items) ? queue.items : [] };
  } catch {
    return { version: 1, items: [] };
  }
}

function writeUploadQueue(current, queue) {
  const file = uploadQueuePath(current);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, items: queue.items }, null, 2)}\n`);
}

function signedQueueEntry(payload, signature) {
  const payloadHash = nodeCrypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return {
    id: `uq_${payloadHash.slice(0, 24)}`,
    payloadHash,
    participantId: payload.participantId,
    deviceId: payload.deviceId,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: "",
    payload,
    signature
  };
}

function enqueueUpload(current, entry, errorMessage = "") {
  const queue = readUploadQueue(current);
  const existing = queue.items.find((item) => item.payloadHash === entry.payloadHash);
  if (existing) {
    existing.lastError = errorMessage || existing.lastError;
    writeUploadQueue(current, queue);
    return existing;
  }
  const next = { ...entry, lastError: errorMessage };
  queue.items.push(next);
  writeUploadQueue(current, queue);
  return next;
}

async function drainUploadQueue(current) {
  const queue = readUploadQueue(current);
  if (!queue.items.length || !hasApiBaseUrl(current)) return { uploaded: 0, pending: queue.items.length };
  const pending = [];
  let uploaded = 0;
  for (const entry of queue.items) {
    try {
      await uploadQueueEntry(current, entry);
      uploaded += 1;
    } catch (error) {
      pending.push({
        ...entry,
        attempts: Number(entry.attempts || 0) + 1,
        lastError: error.message,
        lastAttemptAt: new Date().toISOString()
      });
    }
  }
  writeUploadQueue(current, { version: 1, items: pending });
  return { uploaded, pending: pending.length };
}

async function uploadQueueEntry(current, entry) {
  return postJson(`${current.apiBaseUrl}/api/usage/daily-batch`, {
    ...entry.payload,
    signature: entry.signature
  });
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

function sanitizeConfig(config) {
  if (!config) return null;
  const { identityPrivateKey, ...safe } = config;
  return {
    ...safe,
    cursorDashboardUsage: safe.cursorDashboardUsage
      ? {
          ...safe.cursorDashboardUsage,
          workosSessionToken: safe.cursorDashboardUsage.workosSessionToken ? "[configured]" : "",
          workosSessionTokens: (safe.cursorDashboardUsage.workosSessionTokens || []).map((item) => ({
            accountName: item.accountName || "Cursor",
            token: item.token ? "[configured]" : "",
            addedAt: item.addedAt || ""
          }))
        }
      : undefined
  };
}

function applyLaunchAtLogin(config) {
  if (!app.isPackaged && process.argv.includes("--desktop-smoke")) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(config?.launchAtLogin),
      openAsHidden: true
    });
  } catch {}
}
