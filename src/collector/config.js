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
  apiBaseUrl = "",
  apiConnection = {},
  autoRefreshEnabled = false,
  refreshIntervalMinutes = 15,
  showRawTokens = false,
  launchAtLogin = false,
  desktopAutoInitialized = false
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
    desktopAutoInitialized,
    cursorDashboardUsage: {
      enabled: false,
      workosSessionToken: "",
      workosSessionTokens: []
    },
    apiConnection,
    syncStatus: {},
    workdirAliases: {},
    providerRoots: {},
    providerEnabled: {
      claude_code_local: true,
      codex_local: true
    },
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
    apiBaseUrl: current.apiBaseUrl || "",
    publicUpload: current.publicUpload ?? true,
    showEstimatedCost: current.showEstimatedCost ?? false,
    showRawTokens: current.showRawTokens ?? false,
    autoRefreshEnabled: current.autoRefreshEnabled ?? false,
    refreshIntervalMinutes: current.refreshIntervalMinutes || 15,
    launchAtLogin: current.launchAtLogin ?? false,
    desktopAutoInitialized: false,
    cursorDashboardUsage: current.cursorDashboardUsage || { enabled: false, workosSessionToken: "", workosSessionTokens: [] },
    syncStatus: current.syncStatus || {},
    workdirAliases: current.workdirAliases || {},
    providerRoots: current.providerRoots || {},
    providerEnabled: {
      claude_code_local: true,
      codex_local: true,
      ...(current.providerEnabled || {})
    },
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

export function removeProviderRoot(providerId, rootPath, current = loadConfig()) {
  if (!current) throw new Error("Initialize identity first");
  const normalized = path.resolve(rootPath);
  const roots = current.providerRoots?.[providerId];
  const nextRoots = Array.isArray(roots) ? roots.filter(r => r !== normalized) : [];
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
  if (input.cursorDashboardUsage && !Object.hasOwn(input.cursorDashboardUsage, "workosSessionTokens")) {
    cursorDashboardUsage.workosSessionTokens = current.cursorDashboardUsage?.workosSessionTokens || [];
  }
  const config = {
    ...current,
    nickname: input.nickname ?? current.nickname,
    apiBaseUrl: input.apiBaseUrl ?? current.apiBaseUrl,
    publicUpload: input.publicUpload ?? current.publicUpload ?? true,
    showEstimatedCost: input.showEstimatedCost ?? current.showEstimatedCost ?? false,
    showRawTokens: input.showRawTokens ?? current.showRawTokens ?? false,
    autoRefreshEnabled: input.autoRefreshEnabled ?? current.autoRefreshEnabled ?? false,
    launchAtLogin: input.launchAtLogin ?? current.launchAtLogin ?? false,
    desktopAutoInitialized: input.desktopAutoInitialized ?? current.desktopAutoInitialized ?? false,
    providerEnabled: {
      claude_code_local: true,
      codex_local: true,
      ...(current.providerEnabled || {}),
      ...(input.providerEnabled || {})
    },
    refreshIntervalMinutes: Number.isFinite(refreshIntervalMinutes)
      ? Math.max(1, Math.round(refreshIntervalMinutes))
      : 15,
    cursorDashboardUsage,
    apiConnection: input.apiConnection ?? current.apiConnection ?? {},
    syncStatus: input.syncStatus ?? current.syncStatus ?? {},
    lastSyncAt: input.lastSyncAt ?? current.lastSyncAt,
    lastSyncStatus: input.lastSyncStatus ?? current.lastSyncStatus,
    lastSyncApiBaseUrl: input.lastSyncApiBaseUrl ?? current.lastSyncApiBaseUrl,
    lastSyncError: input.lastSyncError ?? current.lastSyncError,
    updatedAt: new Date().toISOString()
  };
  if (persist) saveConfig(config);
  return config;
}

export function addCursorToken(rawInput, current = loadConfig(), { persist = true } = {}) {
  if (!current) throw new Error("Initialize identity first");
  const records = parseCursorTokenInput(rawInput);
  if (!records.length) throw new Error("Cursor token is empty or invalid");
  const existing = normalizeCursorTokenRecords(current.cursorDashboardUsage);
  const byToken = new Map(existing.map((item) => [item.token, item]));
  for (const record of records) {
    byToken.set(record.token, {
      ...byToken.get(record.token),
      ...record,
      addedAt: byToken.get(record.token)?.addedAt || new Date().toISOString()
    });
  }
  const config = {
    ...current,
    cursorDashboardUsage: {
      ...(current.cursorDashboardUsage || {}),
      enabled: true,
      workosSessionToken: "",
      workosSessionTokens: [...byToken.values()]
    },
    updatedAt: new Date().toISOString()
  };
  if (persist) saveConfig(config);
  return config;
}

export function removeCursorToken(tokenValue, current = loadConfig()) {
  if (!current) throw new Error("Initialize identity first");
  const tokens = current.cursorDashboardUsage?.workosSessionTokens || [];
  const idx = Number(tokenValue);
  const nextTokens = Number.isInteger(idx) && idx >= 0 && idx < tokens.length
    ? tokens.filter((_, i) => i !== idx)
    : tokens.filter(t => t.token !== tokenValue);
  const config = {
    ...current,
    cursorDashboardUsage: {
      ...(current.cursorDashboardUsage || {}),
      workosSessionTokens: nextTokens
    },
    updatedAt: new Date().toISOString()
  };
  saveConfig(config);
  return config;
}

function normalizeCursorTokenRecords(cursorDashboardUsage = {}) {
  const records = [];
  if (cursorDashboardUsage.workosSessionToken) {
    records.push(...parseCursorTokenInput(cursorDashboardUsage.workosSessionToken));
  }
  for (const item of cursorDashboardUsage.workosSessionTokens || []) {
    if (typeof item === "string") {
      records.push(...parseCursorTokenInput(item));
    } else if (item?.token) {
      records.push(...parseCursorTokenInput(JSON.stringify(item)));
    }
  }
  const byToken = new Map();
  for (const record of records) byToken.set(record.token, { ...byToken.get(record.token), ...record });
  return [...byToken.values()];
}

function parseCursorTokenInput(rawInput) {
  const text = String(rawInput || "").trim();
  if (!text || text === "[configured]") return [];
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const records = list.flatMap((item) => parseCursorTokenObject(item));
    if (records.length) return records;
  } catch {}
  const stripped = text.startsWith("WorkosCursorSessionToken=")
    ? text.replace(/^WorkosCursorSessionToken=/, "")
    : text;
  const decoded = safeDecodeURIComponent(stripped);
  const token = normalizeCursorTokenValue(decoded);
  if (!token) return [];
  return [{ token, accountName: cursorAccountNameFromToken(token) }];
}

function parseCursorTokenObject(input) {
  if (!input || typeof input !== "object") return [];
  const token = input.token || input.workosSessionToken || input.access_token || input.accessToken || input.cursor_auth_raw?.accessToken;
  const workosId = input.workosId || input.cursor_auth_raw?.workosId || String(input.auth_id || "").match(/user_[A-Za-z0-9]+/)?.[0];
  const normalized = normalizeCursorTokenValue(workosId && token && !String(token).includes("::") ? `${workosId}::${token}` : token);
  if (!normalized) return [];
  return [{
    token: normalized,
    accountName: input.accountName || input.email || input.cachedEmail || input.cursor_auth_raw?.cachedEmail || cursorAccountNameFromToken(normalized)
  }];
}

function normalizeCursorTokenValue(value) {
  const decoded = safeDecodeURIComponent(String(value || "").trim());
  if (!decoded) return "";
  if (decoded.includes("::")) return decoded;
  const userId = cursorUserIdFromToken(decoded);
  return userId ? `${userId}::${decoded}` : "";
}

function cursorAccountNameFromToken(token) {
  return String(token || "").split("::")[0] || "Cursor";
}

function cursorUserIdFromToken(token = "") {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return "";
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";
    const sub = JSON.parse(Buffer.from(payload, "base64").toString("utf8")).sub || "";
    return String(sub).match(/user_[A-Za-z0-9]+/)?.[0] || "";
  } catch {
    return "";
  }
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
