import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateIdentity, newId } from "../shared/crypto.js";

export const APP_DIR = path.join(os.homedir(), ".ai-token-league");
export const CONFIG_PATH = path.join(APP_DIR, "config.json");
export const QUEUE_PATH = path.join(APP_DIR, "upload-queue.json");

export function ensureAppDir() {
  fs.mkdirSync(APP_DIR, { recursive: true });
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

export function saveConfig(config) {
  ensureAppDir();
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

export function initConfig({
  nickname = "anonymous",
  apiBaseUrl = "http://127.0.0.1:8787",
  autoRefreshEnabled = true,
  refreshIntervalMinutes = 15,
  showRawTokens = false,
  launchAtLogin = false
} = {}) {
  const identity = generateIdentity();
  const interval = Number(refreshIntervalMinutes);
  const config = {
    participantId: identity.participantId,
    nickname,
    identityPublicKey: identity.identityPublicKey,
    identityPrivateKey: identity.identityPrivateKey,
    deviceId: newId("d"),
    apiBaseUrl,
    publicUpload: true,
    showEstimatedCost: false,
    showRawTokens,
    autoRefreshEnabled,
    refreshIntervalMinutes: Number.isFinite(interval) ? Math.max(1, Math.round(interval)) : 15,
    launchAtLogin,
    cursorDashboardUsage: {
      enabled: false,
      workosSessionToken: ""
    },
    syncStatus: {},
    workdirAliases: {},
    providerRoots: {},
    createdAt: new Date().toISOString()
  };
  saveConfig(config);
  return config;
}

export function exportIdentity(config) {
  return {
    participantId: config.participantId,
    nickname: config.nickname,
    identityPublicKey: config.identityPublicKey,
    identityPrivateKey: config.identityPrivateKey
  };
}

export function importIdentity(identity, current = {}, { persist = true } = {}) {
  const config = {
    ...current,
    participantId: identity.participantId,
    nickname: identity.nickname || current.nickname || "anonymous",
    identityPublicKey: identity.identityPublicKey,
    identityPrivateKey: identity.identityPrivateKey,
    deviceId: current.deviceId || newId("d"),
    apiBaseUrl: current.apiBaseUrl || "http://127.0.0.1:8787",
    publicUpload: current.publicUpload ?? true,
    showEstimatedCost: current.showEstimatedCost ?? false,
    showRawTokens: current.showRawTokens ?? false,
    autoRefreshEnabled: current.autoRefreshEnabled ?? true,
    refreshIntervalMinutes: current.refreshIntervalMinutes || 15,
    launchAtLogin: current.launchAtLogin ?? false,
    cursorDashboardUsage: current.cursorDashboardUsage || { enabled: false, workosSessionToken: "" },
    syncStatus: current.syncStatus || {},
    workdirAliases: current.workdirAliases || {},
    providerRoots: current.providerRoots || {},
    importedAt: new Date().toISOString()
  };
  if (persist) saveConfig(config);
  return config;
}

export function addProviderRoot(providerId, rootPath, current = loadConfig()) {
  if (!current) throw new Error("Initialize identity first");
  const normalized = path.resolve(rootPath);
  const roots = current.providerRoots?.[providerId];
  const nextRoots = Array.isArray(roots) ? roots : roots ? [roots] : [];
  if (!nextRoots.includes(normalized)) nextRoots.push(normalized);
  const config = {
    ...current,
    providerRoots: {
      ...(current.providerRoots || {}),
      [providerId]: nextRoots
    }
  };
  saveConfig(config);
  return config;
}

export function setWorkdirAlias(workdirHash, alias, current = loadConfig()) {
  if (!current) throw new Error("Initialize identity first");
  const workdirAliases = { ...(current.workdirAliases || {}) };
  const cleanAlias = String(alias || "").trim();
  if (cleanAlias) {
    workdirAliases[workdirHash] = cleanAlias;
  } else {
    delete workdirAliases[workdirHash];
  }
  const config = { ...current, workdirAliases };
  saveConfig(config);
  return config;
}

export function updateConfig(input = {}, current = loadConfig(), { persist = true } = {}) {
  if (!current) return initConfig(input);
  const refreshIntervalMinutes = Number(input.refreshIntervalMinutes ?? current.refreshIntervalMinutes ?? 15);
  const cursorDashboardUsage = {
    ...(current.cursorDashboardUsage || {}),
    ...(input.cursorDashboardUsage || {})
  };
  if (input.cursorDashboardUsage && !Object.hasOwn(input.cursorDashboardUsage, "workosSessionToken")) {
    cursorDashboardUsage.workosSessionToken = current.cursorDashboardUsage?.workosSessionToken || "";
  }
  const config = {
    ...current,
    nickname: input.nickname ?? current.nickname,
    apiBaseUrl: input.apiBaseUrl ?? current.apiBaseUrl,
    publicUpload: input.publicUpload ?? current.publicUpload ?? true,
    showEstimatedCost: input.showEstimatedCost ?? current.showEstimatedCost ?? false,
    showRawTokens: input.showRawTokens ?? current.showRawTokens ?? false,
    autoRefreshEnabled: input.autoRefreshEnabled ?? current.autoRefreshEnabled ?? true,
    launchAtLogin: input.launchAtLogin ?? current.launchAtLogin ?? false,
    refreshIntervalMinutes: Number.isFinite(refreshIntervalMinutes)
      ? Math.max(1, Math.round(refreshIntervalMinutes))
      : 15,
    cursorDashboardUsage,
    updatedAt: new Date().toISOString()
  };
  if (persist) saveConfig(config);
  return config;
}
