const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("node:path");
const fs = require("node:fs");
const nodeCrypto = require("node:crypto");
const os = require("node:os");
const { spawn } = require("node:child_process");

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

const updateCheck = {
  timer: null,
  running: false,
  downloadRunning: false,
  applyRunning: false,
  status: "idle",
  lastCheckedAt: null,
  lastResult: null,
  lastError: null,
  nextCheckAt: null,
  downloadProgress: null,
  readyPackage: null
};
let customMacUpdate = null;

const downloadedUpdate = {
  file: "",
  sha256: "",
  artifact: null
};

const activity = {
  diagnosticsExport: false,
  configTransfer: false,
  identityTransfer: false
};

function pathToFileUrl(file) {
  return `file://${file.replaceAll("\\", "/")}`;
}

function silentUpdateMode(config = {}) {
  const mode = config.silentUpdateMode || "notify";
  return ["notify", "auto_download", "auto_apply_on_idle"].includes(mode) ? mode : "notify";
}

function safeIdleForUpdateApply({ ignoreUpdateCheck = false } = {}) {
  return !foregroundScan.running
    && !background.running
    && (ignoreUpdateCheck || !updateCheck.running)
    && !updateCheck.downloadRunning
    && !updateCheck.applyRunning
    && !activity.diagnosticsExport
    && !activity.configTransfer
    && !activity.identityTransfer;
}

function canInstallDownloadedUpdate(file) {
  return process.platform === "darwin" && path.extname(file).toLowerCase() === ".zip";
}

function currentInstallTargetPath() {
  if (!app.isPackaged) return "";
  if (process.platform !== "darwin") return "";
  const bundle = path.resolve(process.execPath, "../../..");
  return path.basename(bundle) === "AI Token League.app" ? bundle : "";
}

function canApplyDownloadedUpdate(file) {
  return canInstallDownloadedUpdate(file) && Boolean(currentInstallTargetPath());
}

function writeUpdateScript() {
  if (process.platform === "darwin") return writeMacUpdateScript();
  throw new Error("Direct install is not supported on this platform");
}

function writeMacUpdateScript() {
  const dir = updateTempDir();
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "install-and-restart.sh");
  fs.writeFileSync(script, `#!/bin/sh
set -eu
APP_PID="$1"
ZIP_FILE="$2"
DEST_APP="$3"
LOG_FILE="$4"
while kill -0 "$APP_PID" 2>/dev/null; do
  sleep 0.2
done
WORK_DIR="$(mktemp -d "\${TMPDIR:-/tmp}/ai-token-league-apply.XXXXXX")"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT
{
  /usr/bin/ditto -x -k "$ZIP_FILE" "$WORK_DIR"
  SRC_APP="$(/usr/bin/find "$WORK_DIR" -maxdepth 4 -name 'AI Token League.app' -type d | /usr/bin/head -n 1)"
  if [ -z "$SRC_APP" ]; then
    echo "AI Token League.app not found in update package"
    exit 1
  fi
  DEST_DIR="$(/usr/bin/dirname "$DEST_APP")"
  STAGED_APP="$DEST_DIR/.AI Token League.app.update.$$"
  /bin/rm -rf "$STAGED_APP"
  /usr/bin/ditto "$SRC_APP" "$STAGED_APP"
  /bin/rm -rf "$DEST_APP"
  /bin/mv "$STAGED_APP" "$DEST_APP"
  /usr/bin/open "$DEST_APP"
} >"$LOG_FILE" 2>&1
`);
  fs.chmodSync(script, 0o755);
  return {
    command: "/bin/sh",
    args: [script]
  };
}

function updateTempDir() {
  return path.join(app.getPath("temp"), "ai-token-league-updates");
}

function updateStatusSnapshot() {
  return {
    running: updateCheck.running,
    downloadRunning: updateCheck.downloadRunning,
    applyRunning: updateCheck.applyRunning,
    status: updateCheck.status,
    lastCheckedAt: updateCheck.lastCheckedAt,
    lastResult: updateCheck.lastResult,
    lastError: updateCheck.lastError,
    nextCheckAt: updateCheck.nextCheckAt,
    downloadProgress: updateCheck.downloadProgress,
    readyPackage: updateCheck.readyPackage
      ? {
          fileName: updateCheck.readyPackage.artifact?.fileName || path.basename(updateCheck.readyPackage.file || ""),
          sha256: updateCheck.readyPackage.sha256 || "",
          verifiedAt: updateCheck.readyPackage.verifiedAt || "",
          latestVersion: updateCheck.readyPackage.latestVersion || "",
          platform: updateCheck.readyPackage.platform || "",
          source: updateCheck.readyPackage.source || ""
        }
      : null,
    safeIdle: safeIdleForUpdateApply()
  };
}

async function modules() {
  const root = app.getAppPath();
  return {
    config: await import(pathToFileUrl(path.join(root, "src/collector/config.js"))),
    core: await import(pathToFileUrl(path.join(root, "src/collector/core.js"))),
    crypto: await import(pathToFileUrl(path.join(root, "src/shared/crypto.js"))),
    schema: await import(pathToFileUrl(path.join(root, "src/shared/schema.js"))),
    update: await import(pathToFileUrl(path.join(root, "src/shared/update.js"))),
    version: await import(pathToFileUrl(path.join(root, "src/shared/version.js"))),
    preset: await import(pathToFileUrl(path.join(root, "src/shared/preset.js")))
  };
}

// electron-updater lifecycle: active on Windows (latest.yml + NSIS installer).
// macOS uses a custom zip hot-replace path (customMacUpdate) and does not reach these handlers.
// Keep this block intact for a future macOS migration to electron-updater.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.logger = {
  info: (msg) => appendRuntimeLog("updater_info", { msg: String(msg) }),
  warn: (msg) => appendRuntimeLog("updater_warn", { msg: String(msg) }),
  error: (msg) => appendRuntimeLog("updater_error", { msg: String(msg) })
};

// Fallback when app-update.yml is missing (not generated without a publish config).
// electron-updater reads this file during download to get updaterCacheDirName.
const originalLoadUpdateConfig = autoUpdater.loadUpdateConfig.bind(autoUpdater);
autoUpdater.loadUpdateConfig = async function () {
  try {
    return await originalLoadUpdateConfig();
  } catch (error) {
    if (error.code === "ENOENT") {
      return { provider: "generic", updaterCacheDirName: "ai-token-league-updater" };
    }
    throw error;
  }
};

let cachedConfig = null;
let cachedReleaseConfig = null;

autoUpdater.on("update-available", (info) => {
  updateCheck.status = "available";
  updateCheck.lastResult = {
    updateAvailable: true,
    latestVersion: info.version,
    releaseDate: info.releaseDate || ""
  };
  updateCheck.lastError = null;
  appendRuntimeLog("updater_update_available", { version: info.version });
  const mode = silentUpdateMode(cachedConfig);
  if (mode === "auto_download" || mode === "auto_apply_on_idle") {
    autoUpdater.downloadUpdate();
  }
  broadcastUpdateProgress();
});

autoUpdater.on("update-not-available", (info) => {
  updateCheck.status = "up_to_date";
  updateCheck.lastResult = { updateAvailable: false, latestVersion: info.version };
  appendRuntimeLog("updater_up_to_date", { version: info.version });
  broadcastUpdateProgress();
});

autoUpdater.on("download-progress", (progress) => {
  updateCheck.status = "downloading";
  updateCheck.downloadProgress = {
    percent: Math.round(progress.percent),
    bytesPerSecond: progress.bytesPerSecond,
    total: progress.total,
    transferred: progress.transferred
  };
  broadcastUpdateProgress();
});

autoUpdater.on("update-downloaded", (info) => {
  updateCheck.status = "downloaded";
  updateCheck.downloadRunning = false;
  updateCheck.downloadProgress = null;
  updateCheck.lastResult = updateCheck.lastResult || {};
  updateCheck.lastResult.latestVersion = info.version;
  appendRuntimeLog("updater_downloaded", { version: info.version });
  broadcastUpdateProgress();
  const mode = silentUpdateMode(cachedConfig);
  const mandatory = updateCheck.lastResult?.mandatory;
  if (mandatory || mode === "auto_apply_on_idle") {
    applyReadyUpdateIfIdle({ source: mandatory ? "mandatory" : "background" }).catch(() => {});
  }
});

autoUpdater.on("error", (error) => {
  updateCheck.lastError = error.message;
  updateCheck.status = "failed";
  updateCheck.running = false;
  updateCheck.downloadRunning = false;
  updateCheck.downloadProgress = null;
  appendRuntimeLog("updater_error", { error: error.message });
  broadcastUpdateProgress();
});

function configureFeedUrl(releaseConfig) {
  const base = releaseConfig?.release?.publicBaseUrl || "";
  const feedUrl = base ? `${base}/releases` : "";
  if (feedUrl) {
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
  }
  return feedUrl;
}

function broadcastUpdateProgress() {
  const snapshot = updateStatusSnapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("update:progress", snapshot);
    } catch {}
  }
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
  const { config, preset } = await modules();
  const current = await ensureDesktopConfig(config, preset);
  appendRuntimeLog("app_ready", {
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    participantId: current.participantId,
    deviceId: current.deviceId,
    apiConfigured: hasApiBaseUrl(current)
  });
  applyLaunchAtLogin(current);
  await scheduleBackgroundRefresh(current);
  await scheduleBackgroundUpdateCheck(current);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("config:get", async () => {
  const { config, preset } = await modules();
  return sanitizeConfig(await ensureDesktopConfig(config, preset));
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
  appendRuntimeLog("config_saved", configLogSummary(next));
  applyLaunchAtLogin(next);
  scheduleBackgroundRefresh(next);
  scheduleBackgroundUpdateCheck(next);
  return sanitizeConfig(next);
});

ipcMain.handle("config:update", async (_event, input) => {
  const { config } = await modules();
  const current = config.loadConfig();
  const next = config.updateConfig(await prepareConfigInput(input, current), current);
  invalidateUsageCache();
  appendRuntimeLog("config_saved", configLogSummary(next));
  applyLaunchAtLogin(next);
  scheduleBackgroundRefresh(next);
  scheduleBackgroundUpdateCheck(next);
  return sanitizeConfig(next);
});

ipcMain.handle("identity:export", async () => {
  activity.identityTransfer = true;
  const { config } = await modules();
  try {
    const current = config.loadConfig();
    if (!current) throw new Error("Open Settings first");
    const target = await dialog.showSaveDialog({
      title: "Export AI Token League Profile",
      defaultPath: "ai-token-league-profile.json",
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (target.canceled || !target.filePath) return { canceled: true };
    fs.writeFileSync(target.filePath, `${JSON.stringify(config.exportIdentity(current), null, 2)}\n`);
    appendRuntimeLog("identity_exported", { participantId: current.participantId, deviceId: current.deviceId });
    return { canceled: false, filePath: target.filePath };
  } finally {
    activity.identityTransfer = false;
  }
});

ipcMain.handle("diagnostics:export", async () => {
  activity.diagnosticsExport = true;
  const { config } = await modules();
  try {
    const current = config.loadConfig();
    if (!current) throw new Error("Open Settings first");
    const target = await dialog.showSaveDialog({
      title: "Export AI Token League Diagnostics",
      defaultPath: `ai-token-league-diagnostics-${safeTimestamp(new Date())}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (target.canceled || !target.filePath) return { canceled: true };
    const bundle = await diagnosticsBundle(config, current);
    fs.writeFileSync(target.filePath, `${JSON.stringify(bundle, null, 2)}\n`);
    appendRuntimeLog("diagnostics_exported", {
      participantId: current.participantId,
      deviceId: current.deviceId,
      usageRowCount: bundle.usageCache.rowCount,
      queuePending: bundle.uploadQueue.pending,
      logCount: bundle.runtimeLog.length
    });
    return {
      canceled: false,
      filePath: target.filePath,
      usageRowCount: bundle.usageCache.rowCount,
      queuePending: bundle.uploadQueue.pending,
      logCount: bundle.runtimeLog.length
    };
  } finally {
    activity.diagnosticsExport = false;
  }
});

ipcMain.handle("identity:import", async () => {
  activity.identityTransfer = true;
  const { config } = await modules();
  try {
    const source = await dialog.showOpenDialog({
      title: "Import AI Token League Profile",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (source.canceled || !source.filePaths[0]) return { canceled: true };
    const identity = JSON.parse(fs.readFileSync(source.filePaths[0], "utf8"));
    const next = config.importIdentity(identity, config.loadConfig() || {});
    appendRuntimeLog("identity_imported", { participantId: next.participantId, deviceId: next.deviceId });
    applyLaunchAtLogin(next);
    scheduleBackgroundRefresh(next);
    scheduleBackgroundUpdateCheck(next);
    return sanitizeConfig(next);
  } finally {
    activity.identityTransfer = false;
  }
});

ipcMain.handle("config:export", async () => {
  activity.configTransfer = true;
  const { config } = await modules();
  try {
    const current = config.loadConfig();
    if (!current) throw new Error("Open Settings first");
    const target = await dialog.showSaveDialog({
      title: "Export AI Token League Config",
      defaultPath: "ai-token-league-config.json",
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (target.canceled || !target.filePath) return { canceled: true };
    fs.writeFileSync(target.filePath, `${JSON.stringify(config.exportConfig(current), null, 2)}\n`);
    appendRuntimeLog("config_exported", { participantId: current.participantId, deviceId: current.deviceId });
    return { canceled: false, filePath: target.filePath };
  } finally {
    activity.configTransfer = false;
  }
});

ipcMain.handle("config:import", async () => {
  activity.configTransfer = true;
  const { config } = await modules();
  try {
    const source = await dialog.showOpenDialog({
      title: "Import AI Token League Config",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (source.canceled || !source.filePaths[0]) return { canceled: true };
    const imported = JSON.parse(fs.readFileSync(source.filePaths[0], "utf8"));
    const next = config.importConfig(imported);
    appendRuntimeLog("config_imported", { participantId: next.participantId, deviceId: next.deviceId });
    applyLaunchAtLogin(next);
    scheduleBackgroundRefresh(next);
    scheduleBackgroundUpdateCheck(next);
    return sanitizeConfig(next);
  } finally {
    activity.configTransfer = false;
  }
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
  appendRuntimeLog("provider_root_added", { providerId, participantId: next.participantId, deviceId: next.deviceId });
  return sanitizeConfig(next);
});

ipcMain.handle("config:remove-provider-root", async (_event, providerId, rootPath) => {
  const { config } = await modules();
  const current = config.loadConfig();
  if (!current) throw new Error("Open Settings first");
  const next = config.removeProviderRoot(providerId, rootPath, current);
  invalidateUsageCache();
  return sanitizeConfig(next);
});

ipcMain.handle("cursor:add-token", async (_event, rawInput) => {
  const { config } = await modules();
  const current = config.loadConfig();
  if (!current) throw new Error("Open Settings first");
  const next = config.addCursorToken(rawInput, current);
  invalidateUsageCache();
  appendRuntimeLog("cursor_token_added", {
    participantId: next.participantId,
    deviceId: next.deviceId,
    accountCount: next.cursorDashboardUsage?.workosSessionTokens?.length || 0
  });
  return sanitizeConfig(next);
});

ipcMain.handle("cursor:remove-token", async (_event, tokenValue) => {
  const { config } = await modules();
  const current = config.loadConfig();
  if (!current) throw new Error("Open Settings first");
  const next = config.removeCursorToken(tokenValue, current);
  invalidateUsageCache();
  return sanitizeConfig(next);
});

ipcMain.handle("config:ignore-auto-source", async (_event, providerId, sourceId) => {
  const { config } = await modules();
  const current = config.loadConfig();
  if (!current) throw new Error("Open Settings first");
  const next = config.ignoreAutoSource(providerId, sourceId, current);
  invalidateUsageCache();
  return sanitizeConfig(next);
});

ipcMain.handle("config:unignore-auto-source", async (_event, providerId, sourceId) => {
  const { config } = await modules();
  const current = config.loadConfig();
  if (!current) throw new Error("Open Settings first");
  const next = config.unignoreAutoSource(providerId, sourceId, current);
  invalidateUsageCache();
  return sanitizeConfig(next);
});

ipcMain.handle("background:status", async () => {
  const { config } = await modules();
  const current = config.loadConfig();
  if (current && current.autoRefreshEnabled !== false && !background.timer) await scheduleBackgroundRefresh(current);
  if (current && hasApiBaseUrl(current) && !updateCheck.timer) await scheduleBackgroundUpdateCheck(current);
  return backgroundStatus();
});

ipcMain.handle("workdirs:set-alias", async (_event, input) => {
  const { config } = await modules();
  const current = config.loadConfig();
  if (!current) throw new Error("Open Settings first");
  const next = config.setWorkdirAlias(input.workdirHash, input.alias, current);
  invalidateUsageCache();
  appendRuntimeLog("workdir_alias_saved", {
    participantId: next.participantId,
    deviceId: next.deviceId,
    workdirHash: input.workdirHash,
    hasAlias: Boolean(String(input.alias || "").trim())
  });
  return sanitizeConfig(next);
});

ipcMain.handle("providers:health", async () => {
  const { config, core, preset } = await modules();
  const current = await ensureDesktopConfig(config, preset);
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
  const { config, core, preset } = await modules();
  const current = await ensureDesktopConfig(config, preset);
  return getUsageSnapshot({ config, core, current, force: Boolean(options.force) });
});

ipcMain.handle("usage:scan-start", async (_event, options = {}) => {
  const { config, core, preset } = await modules();
  const current = await ensureDesktopConfig(config, preset);
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

ipcMain.handle("app:version", async () => {
  const { version } = await modules();
  return version.clientMetadata({
    clientAppVersion: app.getVersion(),
    clientBuild: `${version.clientPlatform()}-${app.getVersion()}`
  });
});

ipcMain.handle("update:check", async () => {
  if (updateCheck.running) return updateStatusSnapshot();
  const { config, update, version } = await modules();
  const current = config.loadConfig();
  cachedConfig = current;
  const apiBaseUrl = normalizeApiBaseUrl(current?.apiBaseUrl || "");
  const checkedAt = new Date().toISOString();
  const client = version.clientMetadata({ clientAppVersion: app.getVersion() });
  if (!apiBaseUrl) {
    return {
      code: "cloud_not_configured",
      checkedAt,
      client,
      update: null,
      message: "Configure Cloud Connection before checking updates"
    };
  }
  updateCheck.running = true;
  updateCheck.status = "checking";
  updateCheck.lastCheckedAt = checkedAt;
  updateCheck.lastError = null;
  try {
    const releaseConfig = await getJson(`${apiBaseUrl}/api/release/config?${clientQuery(version, app.getVersion())}`);
    cachedReleaseConfig = releaseConfig;
    if (process.platform === "darwin") {
      const latest = await getJson(`${apiBaseUrl}/api/release/latest?${clientQuery(version, app.getVersion())}`);
      const state = prepareCustomMacUpdateState({ latest, update, version });
      customMacUpdate = state.updateAvailable ? { manifest: latest.manifest, artifact: state.artifact, filePath: "" } : null;
      updateCheck.status = state.updateAvailable ? "available" : "up_to_date";
      updateCheck.lastResult = state;
      updateCheck.lastError = null;
      broadcastUpdateProgress();
      return {
        code: state.updateAvailable ? "update_available" : "up_to_date",
        checkedAt,
        client,
        server: releaseConfig,
        update: state,
        message: state.updateAvailable ? `Version ${state.latestVersion} is available` : "Current version is up to date"
      };
    }
    const feedUrl = configureFeedUrl(releaseConfig);
    if (!feedUrl) {
      return {
        code: "release_not_configured",
        checkedAt,
        client,
        server: releaseConfig,
        update: null,
        message: "Release feed URL is not configured on the app server"
      };
    }
    const result = await autoUpdater.checkForUpdates();
    const state = updateCheck.lastResult || {};
    return {
      code: state.updateAvailable ? "update_available" : "up_to_date",
      checkedAt,
      client,
      server: releaseConfig,
      update: state,
      message: state.updateAvailable ? `Version ${state.latestVersion} is available` : "Current version is up to date"
    };
  } catch (error) {
    updateCheck.lastError = error.message;
    updateCheck.status = "failed";
    throw error;
  } finally {
    updateCheck.running = false;
  }
});

ipcMain.handle("update:download", async () => {
  if (updateCheck.downloadRunning) return { ok: false, message: "Download already in progress" };
  if (process.platform === "darwin" && updateCheck.lastResult?.installMode === "custom_mac") {
    return downloadCustomMacUpdate();
  }
  updateCheck.downloadRunning = true;
  updateCheck.status = "downloading";
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true, message: "Update downloaded and verified" };
  } catch (error) {
    updateCheck.lastError = error.message;
    updateCheck.status = "failed";
    throw error;
  } finally {
    updateCheck.downloadRunning = false;
  }
});

ipcMain.handle("update:install-and-restart", async () => {
  if (process.platform === "darwin" && updateCheck.lastResult?.installMode === "custom_mac") {
    await installCustomMacUpdate({ source: "manual" });
    return { ok: true };
  }
  appendRuntimeLog("updater_quit_and_install", { source: "manual" });
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
});

ipcMain.handle("update:download-installer", async () => {
  const { version } = await modules();
  const platform = version.clientPlatform();
  const { shell, session } = require("electron");
  if (!cachedReleaseConfig) {
    const { config: configModule } = await modules();
    const current = configModule.loadConfig();
    const apiBaseUrl = normalizeApiBaseUrl(current?.apiBaseUrl || "");
    if (!apiBaseUrl) return { ok: false, error: "cloud not configured" };
    cachedReleaseConfig = await getJson(`${apiBaseUrl}/api/release/config?${clientQuery(version, app.getVersion())}`);
  }
  const installerInfo = cachedReleaseConfig?.release?.installers?.[platform];
  if (!installerInfo?.url) return { ok: false, error: `no installer available for ${platform}` };
  const tmpDir = path.join(os.tmpdir(), "ai-token-league-installer");
  fs.mkdirSync(tmpDir, { recursive: true });
  const fileName = installerInfo.fileName || path.basename(new URL(installerInfo.url).pathname);
  const filePath = path.join(tmpDir, fileName);
  appendRuntimeLog("installer_download_start", { platform, url: installerInfo.url });
  return new Promise((resolve) => {
    try {
      session.defaultSession.once("will-download", (_event, item) => {
        item.setSavePath(filePath);
        item.on("updated", (_e, state) => {
          if (state === "progressing" && item.getTotalBytes() > 0) {
            const progress = {
              percent: Math.round((item.getReceivedBytes() / item.getTotalBytes()) * 100),
              bytesPerSecond: item.getCurrentBytesPerSecond(),
              total: item.getTotalBytes(),
              transferred: item.getReceivedBytes()
            };
            for (const win of BrowserWindow.getAllWindows()) {
              try { win.webContents.send("update:installer-progress", progress); } catch {}
            }
          }
        });
        item.once("done", async (_e, state) => {
          if (state !== "completed") {
            appendRuntimeLog("installer_download_failed", { state });
            resolve({ ok: false, error: `installer download ${state}` });
            return;
          }
          try {
            if (installerInfo.sha256 && installerInfo.sha256 !== "placeholder") {
              const actual = nodeCrypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
              if (actual !== installerInfo.sha256) {
                fs.unlinkSync(filePath);
                resolve({ ok: false, error: `checksum mismatch: expected ${installerInfo.sha256}, got ${actual}` });
                return;
              }
            }
            appendRuntimeLog("installer_download_completed", { filePath });
            const openError = await shell.openPath(filePath);
            if (openError) {
              appendRuntimeLog("installer_open_failed", { error: openError });
              resolve({ ok: false, error: openError });
              return;
            }
            resolve({ ok: true, filePath });
          } catch (err) {
            appendRuntimeLog("installer_open_failed", { error: err.message });
            resolve({ ok: false, error: err.message });
          }
        });
      });
      session.defaultSession.downloadURL(installerInfo.url);
    } catch (err) {
      appendRuntimeLog("installer_download_init_failed", { error: err.message });
      resolve({ ok: false, error: err.message });
    }
  });
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

async function scheduleBackgroundUpdateCheck(configOverride = null) {
  if (updateCheck.timer) clearInterval(updateCheck.timer);
  updateCheck.timer = null;
  updateCheck.nextCheckAt = null;
  const current = configOverride || (await modules()).config.loadConfig();
  if (!current || !hasApiBaseUrl(current)) return;
  cachedConfig = current;
  const intervalMs = 6 * 60 * 60 * 1000;
  updateCheck.nextCheckAt = new Date(Date.now() + intervalMs).toISOString();
  updateCheck.timer = setInterval(() => {
    modules()
      .then(({ config }) => runUpdateCheck(config.loadConfig(), { allowSilent: true }))
      .catch(() => {});
    updateCheck.nextCheckAt = new Date(Date.now() + intervalMs).toISOString();
  }, intervalMs);
}

async function runUpdateCheck(current, { allowSilent = false } = {}) {
  if (updateCheck.running) return updateCheck.lastResult;
  const { update, version } = await modules();
  const apiBaseUrl = normalizeApiBaseUrl(current?.apiBaseUrl || "");
  if (!apiBaseUrl) return null;
  cachedConfig = current;
  updateCheck.running = true;
  updateCheck.status = "checking";
  updateCheck.lastCheckedAt = new Date().toISOString();
  updateCheck.lastError = null;
  appendRuntimeLog("silent_update_check_start", { mode: silentUpdateMode(current), allowSilent });
  try {
    const releaseConfig = await getJson(`${apiBaseUrl}/api/release/config?${clientQuery(version, app.getVersion())}`);
    cachedReleaseConfig = releaseConfig;
    if (process.platform === "darwin") {
      const latest = await getJson(`${apiBaseUrl}/api/release/latest?${clientQuery(version, app.getVersion())}`);
      const state = prepareCustomMacUpdateState({ latest, update, version });
      customMacUpdate = state.updateAvailable ? { manifest: latest.manifest, artifact: state.artifact, filePath: "" } : null;
      updateCheck.status = state.updateAvailable ? "available" : "up_to_date";
      updateCheck.lastResult = state;
      updateCheck.lastError = null;
      appendRuntimeLog("silent_update_check_done", {
        mode: silentUpdateMode(current),
        updateAvailable: state.updateAvailable,
        latestVersion: state.latestVersion,
        installMode: state.installMode
      });
      if (allowSilent && state.updateAvailable && ["auto_download", "auto_apply_on_idle"].includes(silentUpdateMode(current))) {
        await downloadCustomMacUpdate();
        if (silentUpdateMode(current) === "auto_apply_on_idle") {
          await applyReadyUpdateIfIdle({ source: "background", ignoreUpdateCheck: true });
        }
      }
      broadcastUpdateProgress();
      return updateCheck.lastResult;
    }
    const feedUrl = configureFeedUrl(releaseConfig);
    if (!feedUrl) throw new Error("Release feed URL is not configured");
    const mode = silentUpdateMode(current);
    autoUpdater.autoDownload = allowSilent && (mode === "auto_download" || mode === "auto_apply_on_idle");
    await autoUpdater.checkForUpdates();
    appendRuntimeLog("silent_update_check_done", {
      mode,
      updateAvailable: updateCheck.lastResult?.updateAvailable,
      latestVersion: updateCheck.lastResult?.latestVersion
    });
    return updateCheck.lastResult;
  } catch (error) {
    updateCheck.lastError = error.message;
    updateCheck.status = "failed";
    appendRuntimeLog("silent_update_check_failed", { error: error.message });
    throw error;
  } finally {
    updateCheck.running = false;
  }
}

async function applyReadyUpdateIfIdle({ source = "background", ignoreUpdateCheck = false } = {}) {
  if (updateCheck.status !== "downloaded") return false;
  if (!safeIdleForUpdateApply({ ignoreUpdateCheck })) {
    updateCheck.status = "ready";
    appendRuntimeLog("updater_apply_deferred", { source, reason: "not_idle" });
    return false;
  }
  if (process.platform === "darwin" && updateCheck.lastResult?.installMode === "custom_mac") {
    await installCustomMacUpdate({ source });
    return true;
  }
  appendRuntimeLog("updater_quit_and_install", { source });
  autoUpdater.quitAndInstall(false, true);
  return true;
}

async function maybeApplyReadyUpdateOnIdle(current = null) {
  if (updateCheck.status !== "downloaded") return false;
  const nextConfig = current || cachedConfig || (await modules()).config.loadConfig();
  if (!nextConfig || !hasApiBaseUrl(nextConfig)) return false;
  const mode = silentUpdateMode(nextConfig);
  const mandatory = Boolean(updateCheck.lastResult?.mandatory);
  if (!mandatory && mode !== "auto_apply_on_idle") return false;
  return applyReadyUpdateIfIdle({ source: mandatory ? "mandatory" : "background" });
}

async function runBackgroundRefresh() {
  if (background.running) return;
  background.running = true;
  background.lastRunAt = new Date().toISOString();
  background.lastError = null;
  appendRuntimeLog("background_refresh_start", { startedAt: background.lastRunAt });
  try {
    const { config, core, crypto } = await modules();
    const current = config.loadConfig();
    if (!current) {
      background.lastMode = "disabled";
      background.lastResult = "No settings";
      appendRuntimeLog("background_refresh_skipped", { reason: "no_settings" });
      return;
    }
    const scanned = await getUsageSnapshot({ config, core, current, force: true });
    if (hasApiBaseUrl(current)) {
      const result = await syncCurrentUsage({ config, core, crypto, current, scanned });
      background.lastMode = "sync";
      background.lastResult = result.queued ? `Queued ${result.scanned} rows` : `Uploaded ${result.scanned} rows`;
      appendRuntimeLog("background_refresh_done", { mode: background.lastMode, result: background.lastResult });
    } else {
      background.lastMode = "scan";
      background.lastResult = `Refreshed ${scanned.items.length} rows`;
      appendRuntimeLog("background_refresh_done", { mode: background.lastMode, result: background.lastResult });
    }
  } catch (error) {
    background.lastError = error.message;
    background.lastResult = "Failed";
    appendRuntimeLog("background_refresh_failed", { error: error.message });
  } finally {
    background.running = false;
    maybeApplyReadyUpdateOnIdle().catch(() => {});
  }
}

async function syncCurrentUsage({ config, core, crypto, current, scanned = null }) {
  if (!hasApiBaseUrl(current)) throw new Error("Configure API base URL first");
  const startedAt = new Date().toISOString();
  const apiBaseUrl = String(current.apiBaseUrl || "").trim();
  const usage = scanned || await getUsageSnapshot({ config, core, current, force: false });
  appendRuntimeLog("sync_start", {
    participantId: current.participantId,
    deviceId: current.deviceId,
    apiBaseUrl,
    rowCount: usage.items.length,
    sourceFingerprint: usage.sourceFingerprint || "",
    fromCache: Boolean(usage.fromCache)
  });
  try {
    const { version } = await modules();
    const client = version.clientMetadata({ clientAppVersion: app.getVersion(), clientBuild: `${version.clientPlatform()}-${app.getVersion()}` });
    await postJson(`${apiBaseUrl}/api/devices/register`, {
      participantId: current.participantId,
      deviceId: current.deviceId,
      nickname: current.nickname,
      identityPublicKey: current.identityPublicKey,
      os: process.platform,
      appVersion: app.getVersion(),
      ...client
    });
    const payload = {
      participantId: current.participantId,
      deviceId: current.deviceId,
      clientGeneratedAt: new Date().toISOString(),
      client,
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
    appendRuntimeLog("sync_success", {
      participantId: current.participantId,
      deviceId: current.deviceId,
      apiBaseUrl,
      accepted: syncResult.accepted || 0,
      rejected: syncResult.rejected || 0,
      scanned: syncResult.scanned || 0,
      queueUploaded: syncResult.queueUploaded || 0,
      queuePending: syncResult.queuePending || 0,
      batchId: syncResult.batchId || ""
    });
    persistSyncStatus(config, current, {
      apiBaseUrl,
      status: "success",
      startedAt,
      finishedAt: new Date().toISOString(),
      result: syncResult
    });
    return syncResult;
  } catch (error) {
    const { version } = await modules();
    const client = version.clientMetadata({ clientAppVersion: app.getVersion(), clientBuild: `${version.clientPlatform()}-${app.getVersion()}` });
    const payload = {
      participantId: current.participantId,
      deviceId: current.deviceId,
      clientGeneratedAt: new Date().toISOString(),
      client,
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
    appendRuntimeLog("sync_queued", {
      participantId: current.participantId,
      deviceId: current.deviceId,
      apiBaseUrl,
      scanned: syncResult.scanned,
      queueId: queued.id,
      queuePending: syncResult.queuePending,
      error: error.message
    });
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
    appendRuntimeLog("scan_cache_hit", {
      participantId: current.participantId,
      deviceId: current.deviceId,
      rowCount: cached.rowCount || cached.items?.length || 0,
      scannedAt: cached.scannedAt || "",
      sourceFingerprint: cached.sourceFingerprint || ""
    });
    return { ...cached, fromCache: true };
  }
  appendRuntimeLog("scan_start", { participantId: current.participantId, deviceId: current.deviceId, force });
  try {
    const scanned = await core.scanUsage({ ...current, __usageCacheIndex: cached?.sourceIndex || {} });
    const { schema } = await modules();
    const snapshot = {
      ...scanned,
      cacheVersion: schema.USAGE_CACHE_VERSION,
      scannedAt: new Date().toISOString(),
      rowCount: scanned.items.length,
      sourceFingerprint: snapshotFingerprint(scanned.items),
      fromCache: false
    };
    writeUsageCache(snapshot);
    appendRuntimeLog("scan_done", {
      participantId: current.participantId,
      deviceId: current.deviceId,
      rowCount: snapshot.rowCount,
      sourceFingerprint: snapshot.sourceFingerprint,
      providers: scanHealthSummary(snapshot.health)
    });
    return snapshot;
  } catch (error) {
    appendRuntimeLog("scan_failed", { participantId: current.participantId, deviceId: current.deviceId, error: error.message });
    throw error;
  }
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

function runtimeLogPath() {
  return path.join(app.getPath("userData"), "runtime-log.jsonl");
}

function appendRuntimeLog(event, details = {}) {
  try {
    rotateRuntimeLog();
    fs.mkdirSync(path.dirname(runtimeLogPath()), { recursive: true });
    fs.appendFileSync(runtimeLogPath(), `${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      details: sanitizeLogValue(details)
    })}\n`);
  } catch {}
}

function rotateRuntimeLog() {
  const file = runtimeLogPath();
  if (!fs.existsSync(file)) return;
  const maxBytes = 2 * 1024 * 1024;
  const keepBytes = 1024 * 1024;
  const stats = fs.statSync(file);
  if (stats.size <= maxBytes) return;
  const content = fs.readFileSync(file, "utf8").slice(-keepBytes);
  const firstNewline = content.indexOf("\n");
  fs.writeFileSync(file, firstNewline >= 0 ? content.slice(firstNewline + 1) : content);
}

function readRuntimeLog(limit = 1000) {
  try {
    const file = runtimeLogPath();
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { ts: "", event: "unparsed_log_line", details: { line: line.slice(0, 500) } };
        }
      });
  } catch {
    return [];
  }
}

function readUsageCache() {
  if (usageCache.loaded) return usageCache.data;
  usageCache.loaded = true;
  try {
    const file = usageCachePath();
    const cached = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    usageCache.data = cached?.cacheVersion === 3 ? cached : null;
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
  if (updateCheck.timer) clearInterval(updateCheck.timer);
  background.timer = null;
  background.running = false;
  background.nextRunAt = null;
  updateCheck.timer = null;
  updateCheck.running = false;
  updateCheck.downloadRunning = false;
  updateCheck.applyRunning = false;
  updateCheck.status = "idle";
  updateCheck.nextCheckAt = null;
  updateCheck.downloadProgress = null;
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
  try {
    fs.rmSync(runtimeLogPath(), { force: true });
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
  const apiConnection = await checkApiConnectionForConfig(apiBaseUrl);
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
    const { version } = await modules();
    healthUrl = new URL(`/api/health?${clientQuery(version, app.getVersion())}`, base).toString();
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
    appendRuntimeLog("api_health_ok", {
      apiBaseUrl: normalized,
      dbType: body.dbType || "",
      serverVersion: body.serverVersion || "",
      compatibility: body.compatibility?.status || ""
    });
    return {
      ok: true,
      status: "reachable",
      apiBaseUrl: normalized,
      checkedAt,
      dbType: body.dbType || "",
      serverTime: body.serverTime || "",
      serverVersion: body.serverVersion || "",
      serverProtocolVersion: body.serverProtocolVersion || "",
      supportedClientProtocol: body.supportedClientProtocol || null,
      latestClientVersion: body.latestClientVersion || "",
      compatibility: body.compatibility || null,
      release: body.release || null,
      message: "API reachable"
    };
  } catch (error) {
    const reason = error.name === "AbortError" ? "request timed out" : error.message;
    appendRuntimeLog("api_health_failed", { apiBaseUrl: normalized, error: reason });
    throw new Error(`API health check failed: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function checkApiConnectionForConfig(apiBaseUrl) {
  try {
    return await checkApiConnection(apiBaseUrl);
  } catch (error) {
    if (error.message.startsWith("Invalid API base URL:")) throw error;
    return {
      ok: false,
      status: "unreachable",
      apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl),
      checkedAt: new Date().toISOString(),
      message: error.message
    };
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
	    queuePending: queuedItems.length,
	    updateCheck: updateStatusSnapshot()
	  };
	}

async function diagnosticsBundle(configModule, current) {
  const cached = readUsageCache();
  const queue = readUploadQueue(current);
  const runtimeLog = readRuntimeLog();
  const { version } = await modules();
  const client = version.clientMetadata({
    clientAppVersion: app.getVersion(),
    clientBuild: `${version.clientPlatform()}-${app.getVersion()}`
  });
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    app: {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron,
      client
    },
    config: diagnosticsConfig(current),
    storage: {
      hasConfig: Boolean(configModule.loadConfig()),
      hasUsageCache: Boolean(cached),
      hasUploadQueue: queue.items.length > 0,
      hasRuntimeLog: runtimeLog.length > 0
    },
    background: backgroundStatus(),
    usageCache: diagnosticsUsageCache(cached),
    uploadQueue: diagnosticsUploadQueue(queue),
    runtimeLog
  };
}

function diagnosticsConfig(config = {}) {
  const cursorTokens = config.cursorDashboardUsage?.workosSessionTokens || [];
  return {
    participantId: config.participantId || "",
    deviceId: config.deviceId || "",
    nickname: config.nickname || "",
    apiBaseUrl: config.apiBaseUrl || "",
    language: config.language || "",
	    autoRefreshEnabled: config.autoRefreshEnabled ?? false,
	    silentUpdateMode: silentUpdateMode(config),
	    refreshIntervalMinutes: config.refreshIntervalMinutes || 15,
    showEstimatedCost: config.showEstimatedCost ?? false,
    showRawTokens: config.showRawTokens ?? false,
    launchAtLogin: config.launchAtLogin ?? false,
    desktopAutoInitialized: config.desktopAutoInitialized ?? false,
    providerEnabled: config.providerEnabled || {},
    providerRootCounts: Object.fromEntries(Object.entries(config.providerRoots || {}).map(([providerId, roots]) => [
      providerId,
      Array.isArray(roots) ? roots.length : roots ? 1 : 0
    ])),
    workdirAliasCount: Object.keys(config.workdirAliases || {}).length,
    cursorDashboardUsage: {
      enabled: config.providerEnabled?.cursor_dashboard_usage === true,
      tokenCount: cursorTokens.length + (config.cursorDashboardUsage?.workosSessionToken ? 1 : 0),
      accounts: cursorTokens.map((item) => item.accountName || "").filter(Boolean)
    },
    apiConnection: config.apiConnection || {},
    syncStatus: config.syncStatus || {},
    lastSyncAt: config.lastSyncAt || "",
    lastSyncStatus: config.lastSyncStatus || "",
    lastSyncApiBaseUrl: config.lastSyncApiBaseUrl || "",
    lastSyncError: config.lastSyncError || "",
    hasIdentityPublicKey: Boolean(config.identityPublicKey),
    hasIdentityPrivateKey: Boolean(config.identityPrivateKey),
    identityPublicKeyFingerprint: config.identityPublicKey
      ? nodeCrypto.createHash("sha256").update(config.identityPublicKey).digest("hex")
      : ""
  };
}

function diagnosticsUsageCache(cached) {
  if (!cached) return { present: false, rowCount: 0, items: [], health: [], sourceIndex: { sourceCount: 0 } };
  const sources = cached.sourceIndex?.sources || {};
  return {
    present: true,
    cacheVersion: cached.cacheVersion || null,
    scannedAt: cached.scannedAt || "",
    rowCount: cached.rowCount || cached.items?.length || 0,
    sourceFingerprint: cached.sourceFingerprint || "",
    fromCache: Boolean(cached.fromCache),
    health: cached.health || [],
    items: cached.items || [],
    sourceIndex: {
      sourceCount: Object.keys(sources).length,
      sources: Object.values(sources).map((source) => ({
        rawSourceRef: source.rawSourceRef || "",
        sourceFingerprint: source.sourceFingerprint || "",
        parserVersion: source.parserVersion || "",
        rowCount: source.rowCount || source.items?.length || 0
      }))
    }
  };
}

function diagnosticsUploadQueue(queue) {
  const items = queue.items || [];
  return {
    version: queue.version || 1,
    pending: items.length,
    items: items.map((entry) => ({
      id: entry.id,
      payloadHash: entry.payloadHash,
      participantId: entry.participantId,
      deviceId: entry.deviceId,
      createdAt: entry.createdAt,
      attempts: Number(entry.attempts || 0),
      lastAttemptAt: entry.lastAttemptAt || "",
      lastError: entry.lastError || "",
      payload: {
        participantId: entry.payload?.participantId || "",
        deviceId: entry.payload?.deviceId || "",
        clientGeneratedAt: entry.payload?.clientGeneratedAt || "",
        client: entry.payload?.client || null,
        itemCount: entry.payload?.items?.length || 0,
        items: entry.payload?.items || []
      }
    }))
  };
}

function configLogSummary(config = {}) {
  return {
    participantId: config.participantId || "",
    deviceId: config.deviceId || "",
    apiConfigured: hasApiBaseUrl(config),
	    autoRefreshEnabled: config.autoRefreshEnabled ?? false,
    silentUpdateMode: silentUpdateMode(config),
    refreshIntervalMinutes: config.refreshIntervalMinutes || 15,
    providerEnabled: config.providerEnabled || {},
    cursorEnabled: config.providerEnabled?.cursor_dashboard_usage === true,
    cursorTokenCount: config.cursorDashboardUsage?.workosSessionTokens?.length || 0
  };
}

function scanHealthSummary(health = []) {
  return health.map((item) => ({
    providerId: item.providerId,
    toolCode: item.toolCode,
    detected: Boolean(item.detected),
    enabled: item.enabled ?? true,
    scannedFiles: item.scannedFiles || 0,
    parsedFiles: item.parsedFiles || 0,
    reusedFiles: item.reusedFiles || 0,
    error: item.error || ""
  }));
}

function sanitizeLogValue(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeLogValue);
  const blocked = new Set(["identityPrivateKey", "workosSessionToken", "workosSessionTokens", "token", "cookie", "providerRoots"]);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    blocked.has(key) ? "[redacted]" : sanitizeLogValue(child)
  ]));
}

function safeTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function snapshotFingerprint(items = []) {
  const text = items
    .map((item) => [item.day, item.toolCode, item.providerId, item.workdirHash, item.model, item.totalTokens, item.sourceFingerprint].join("|"))
    .sort()
    .join("\n");
  return nodeCrypto.createHash("sha256").update(text).digest("hex");
}

async function ensureDesktopConfig(configModule, presetModule = null) {
  let current = configModule.loadConfig();
  if (current) {
    current = configModule.migrateLegacyCursorProviderEnabled(current);
    if (!Object.hasOwn(current, "desktopAutoInitialized") && isUnconfirmedDesktopProfile(current)) {
      const next = configModule.updateConfig({ desktopAutoInitialized: true }, current);
      return next;
    }
    return current;
  }
  const preset = presetModule ? presetModule.loadBuildPreset(app.getAppPath()) : {};
  let nickname = preset.nickname;
  let nicknameAutoGenerated = false;
  if (!nickname) {
    try {
      const { generateNickname } = await import("../shared/nickname-generator.js");
      nickname = generateNickname();
      nicknameAutoGenerated = true;
    } catch {}
  }
  return configModule.initConfig({
    ...preset,
    nickname,
    nicknameAutoGenerated,
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
    (current.nicknameAutoGenerated === true || (current.nickname || "anonymous") === "anonymous") &&
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

function prepareCustomMacUpdateState({ latest, update, version }) {
  if (!latest?.manifest) throw new Error(latest?.error || "release manifest is not available");
  const state = update.updateStateFromManifest(latest.manifest, {
    currentVersion: app.getVersion(),
    platform: version.clientPlatform()
  });
  return {
    ...state,
    installMode: "custom_mac",
    artifact: {
      ...state.artifact,
      platform: state.platform
    }
  };
}

async function downloadCustomMacUpdate() {
  if (!customMacUpdate?.artifact?.url) throw new Error("No macOS update artifact is ready. Check for updates first.");
  updateCheck.downloadRunning = true;
  updateCheck.status = "downloading";
  updateCheck.downloadProgress = { percent: 0, bytesPerSecond: 0, total: customMacUpdate.artifact.size || 0, transferred: 0 };
  updateCheck.lastError = null;
  broadcastUpdateProgress();
  const tmpDir = path.join(os.tmpdir(), "ai-token-league-updater");
  fs.mkdirSync(tmpDir, { recursive: true });
  const fileName = customMacUpdate.artifact.fileName || path.basename(new URL(customMacUpdate.artifact.url).pathname);
  const filePath = path.join(tmpDir, `${Date.now()}-${fileName}`);
  try {
    appendRuntimeLog("custom_mac_update_download_start", { url: customMacUpdate.artifact.url, fileName });
    await downloadUrlToFile(customMacUpdate.artifact.url, filePath);
    const { update } = await modules();
    await update.verifyFileChecksum(filePath, customMacUpdate.artifact.sha256);
    customMacUpdate.filePath = filePath;
    downloadedUpdate.file = filePath;
    downloadedUpdate.sha256 = customMacUpdate.artifact.sha256;
    downloadedUpdate.artifact = customMacUpdate.artifact;
    updateCheck.readyPackage = {
      file: filePath,
      sha256: customMacUpdate.artifact.sha256,
      artifact: customMacUpdate.artifact,
      verifiedAt: new Date().toISOString(),
      latestVersion: customMacUpdate.manifest.version,
      platform: customMacUpdate.artifact.platform || updateCheck.lastResult?.platform || "",
      source: "custom_mac"
    };
    updateCheck.status = "downloaded";
    updateCheck.downloadProgress = null;
    updateCheck.lastResult = {
      ...(updateCheck.lastResult || {}),
      updateAvailable: true,
      latestVersion: customMacUpdate.manifest.version,
      installMode: "custom_mac",
      artifact: customMacUpdate.artifact
    };
    appendRuntimeLog("custom_mac_update_download_done", { filePath, version: customMacUpdate.manifest.version });
    broadcastUpdateProgress();
    return { ok: true, message: "Update downloaded and verified" };
  } catch (error) {
    try { fs.rmSync(filePath, { force: true }); } catch {}
    updateCheck.lastError = error.message;
    updateCheck.status = "failed";
    appendRuntimeLog("custom_mac_update_download_failed", { error: error.message });
    broadcastUpdateProgress();
    throw error;
  } finally {
    updateCheck.downloadRunning = false;
  }
}

async function downloadUrlToFile(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`update download failed: ${response.status}`);
  if (!response.body) throw new Error("update download response has no body");
  const total = Number(response.headers.get("content-length") || 0);
  const startedAt = Date.now();
  let transferred = 0;
  const out = fs.createWriteStream(filePath, { flags: "wx" });
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      transferred += buffer.length;
      if (!out.write(buffer)) await new Promise((resolve) => out.once("drain", resolve));
      const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
      updateCheck.downloadProgress = {
        percent: total > 0 ? Math.round((transferred / total) * 100) : 0,
        bytesPerSecond: Math.round(transferred / elapsed),
        total,
        transferred
      };
      broadcastUpdateProgress();
    }
  } finally {
    await new Promise((resolve, reject) => out.end((error) => error ? reject(error) : resolve()));
  }
}

async function installCustomMacUpdate({ source = "manual" } = {}) {
  const ready = updateCheck.readyPackage || {
    file: customMacUpdate?.filePath || downloadedUpdate.file,
    sha256: customMacUpdate?.artifact?.sha256 || downloadedUpdate.sha256,
    artifact: customMacUpdate?.artifact || downloadedUpdate.artifact
  };
  if (!ready.file || !fs.existsSync(ready.file)) {
    throw new Error("Downloaded macOS update package is missing");
  }
  updateCheck.applyRunning = true;
  updateCheck.status = "applying";
  updateCheck.lastError = null;
  broadcastUpdateProgress();
  appendRuntimeLog("custom_mac_update_install_start", { source, fileName: path.basename(ready.file) });
  try {
    const { update } = await modules();
    await update.verifyFileChecksum(ready.file, ready.sha256);
    const installTarget = currentInstallTargetPath();
    if (!installTarget) throw new Error("Could not locate a packaged AI Token League install path");
    const script = writeUpdateScript();
    const logFile = path.join(updateTempDir(), "install.log");
    const child = spawn(script.command, [...script.args, String(process.pid), ready.file, installTarget, logFile], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    appendRuntimeLog("custom_mac_update_apply_launched", { source, installTarget, logFile });
    app.exit(0);
    return { ok: true };
  } catch (error) {
    updateCheck.lastError = error.message;
    updateCheck.status = "failed";
    updateCheck.applyRunning = false;
    appendRuntimeLog("custom_mac_update_apply_failed", { source, error: error.message });
    broadcastUpdateProgress();
    throw error;
  }
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

function clientQuery(versionModule, appVersion) {
  const client = versionModule.clientMetadata({
    clientAppVersion: appVersion,
    clientBuild: `${versionModule.clientPlatform()}-${appVersion}`
  });
  return new URLSearchParams({
    clientAppVersion: client.clientAppVersion,
    clientProtocolVersion: String(client.clientProtocolVersion),
    clientPlatform: client.clientPlatform,
    clientBuild: client.clientBuild
  }).toString();
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
