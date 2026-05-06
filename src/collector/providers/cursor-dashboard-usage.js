import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { localDay } from "../../shared/date.js";

const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js/dist/sql-asm.js");
const SQL = await initSqlJs();

export const cursorDashboardUsageProvider = {
  id: "cursor_dashboard_usage",
  toolCode: "cursor",
  version: "0.1.1",

  scanSessions(config = {}) {
    const cursorConfig = config.cursorDashboardUsage || {};
    if (cursorConfig.enabled !== true) return [];
    const sources = configuredSources(cursorConfig);
    if (cursorConfig.autoDetectLocal !== false) {
      for (const source of discoverAccountSources()) sources.push(source);
      for (const source of discoverLocalCursorSources()) sources.push(source);
    }
    return dedupeSources(sources);
  },

  async parseUsage(source, config = {}) {
    if (source.events) return eventsToUsageEvents(source.events, source);
    const cursorConfig = config.cursorDashboardUsage || {};
    const now = new Date();
    const startDate = cursorConfig.startDateMs || String(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const endDate = cursorConfig.endDateMs || String(now.getTime());
    const events = await fetchAllUsageEvents({
      cookie: source.cookie,
      startDate,
      endDate,
      pageSize: cursorConfig.pageSize || 100
    });
    return eventsToUsageEvents(events, source);
  },

  reportHealth(config = {}) {
    const cursorConfig = config.cursorDashboardUsage || {};
    const sources = [
      ...configuredSources(cursorConfig),
      ...(cursorConfig.autoDetectLocal === false ? [] : discoverAccountSources()),
      ...(cursorConfig.autoDetectLocal === false ? [] : discoverLocalCursorSources())
    ];
    const deduped = dedupeSources(sources);
    return {
      providerId: this.id,
      toolCode: this.toolCode,
      detected: deduped.length > 0,
      enabled: cursorConfig.enabled === true,
      roots: deduped.map((source) => source.accountName || "Cursor"),
      lastCheckedAt: new Date().toISOString()
    };
  }
};

export function eventsToUsageEvents(events = [], source = {}) {
  return events
    .map((event) => {
      const usage = event.tokenUsage || {};
      const inputTokens = numberValue(usage.inputTokens);
      const outputTokens = numberValue(usage.outputTokens);
      const cacheReadTokens = numberValue(usage.cacheReadTokens);
      const cacheWriteTokens = numberValue(usage.cacheWriteTokens);
      const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
      if (!totalTokens) return null;
      return {
        providerId: cursorDashboardUsageProvider.id,
        providerVersion: cursorDashboardUsageProvider.version,
        toolCode: cursorDashboardUsageProvider.toolCode,
        sourceKind: "api",
        sourceQuality: "exact",
        sessionId: `cursor-${event.timestamp || "unknown"}`,
        day: dayFromCursorTimestamp(event.timestamp),
        workdirCandidate: `virtual:cursor-dashboard:${cursorWorkdirName(source)}`,
        model: normalizeCursorModel(event.model),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens: 0,
        totalTokens,
        rawSourceRef: source.sourceKind || "cursor-dashboard",
        parserVersion: cursorDashboardUsageProvider.version,
        sourceFingerprint: cursorSourceFingerprint(event, source)
      };
    })
    .filter(Boolean);
}

function normalizeCursorModel(model) {
  const value = String(model || "").trim().toLowerCase();
  if (!value || value === "default" || value === "auto") return "Auto";
  return String(model).trim();
}

function cursorSourceFingerprint(event, source) {
  return crypto
    .createHash("sha256")
    .update([
      cursorDashboardUsageProvider.id,
      source.sourceKind || "cursor-dashboard",
      source.accountName || "",
      event.timestamp || "",
      event.model || "",
      JSON.stringify(event.tokenUsage || {})
    ].join("|"))
    .digest("hex");
}

async function fetchAllUsageEvents({ cookie, startDate, endDate, pageSize }) {
  const all = [];
  for (let page = 1; page <= 20; page += 1) {
    const body = await fetchUsagePage({ cookie, startDate, endDate, page, pageSize });
    const events = body.usageEventsDisplay || [];
    all.push(...events);
    if (!events.length || all.length >= Number(body.totalUsageEventsCount || 0)) break;
  }
  return all;
}

async function fetchUsagePage({ cookie, startDate, endDate, page, pageSize }) {
  const response = await fetch("https://cursor.com/api/dashboard/get-filtered-usage-events", {
    method: "POST",
    headers: {
      Origin: "https://cursor.com",
      Referer: "https://cursor.com/dashboard/usage",
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: cookie,
      "User-Agent": "AI Token League"
    },
    body: JSON.stringify({
      teamId: 0,
      startDate: String(startDate),
      endDate: String(endDate),
      page,
      pageSize
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Cursor dashboard API ${response.status}: ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : {};
}

function discoverAccountSources() {
  const dir = path.join(os.homedir(), ".antigravity_cockpit", "cursor_accounts");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      try {
        const account = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        const userId = userIdFromAccessToken(account.access_token) || account.id || account.auth_id;
        if (!userId || !account.access_token) return null;
        return {
          sourceKind: "local_cursor_account",
          accountName: account.email || account.cachedEmail || account.cursor_auth_raw?.cachedEmail || userId,
          cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${account.access_token}`)}`
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function discoverLocalCursorSources() {
  const sources = [];
  const sqliteAuth = readTokenFromCursorSqlite();
  if (sqliteAuth.token) {
    const cookie = cursorTokenToCookie(sqliteAuth.token);
    if (cookie) {
      sources.push({
        sourceKind: "local_cursor_state",
        accountName: sqliteAuth.accountName || cursorAccountNameFromToken(sqliteAuth.token),
        cookie
      });
    }
  }
  for (const configPath of cursorConfigPaths()) {
    const configAuth = readTokenFromCursorConfig(configPath);
    if (!configAuth.token) continue;
    const cookie = cursorTokenToCookie(configAuth.token);
    if (cookie) {
      sources.push({
        sourceKind: "local_cursor_config",
        accountName: configAuth.accountName || cursorAccountNameFromToken(configAuth.token),
        cookie
      });
    }
  }
  return sources;
}

function configuredSources(cursorConfig = {}) {
  const sources = [];
  if (cursorConfig.workosSessionToken) {
    const cookie = cursorTokenToCookie(cursorConfig.workosSessionToken);
    if (cookie) {
      sources.push({
        sourceKind: "manual_workos_cookie",
        accountName: cursorAccountNameFromToken(cursorConfig.workosSessionToken),
        cookie
      });
    }
  }
  for (const item of cursorConfig.workosSessionTokens || []) {
    const token = typeof item === "string" ? item : item?.token;
    const cookie = cursorTokenToCookie(token);
    if (cookie) {
      sources.push({
        sourceKind: "manual_workos_cookie",
        accountName: typeof item === "object" ? item.accountName || cursorAccountNameFromToken(token) : cursorAccountNameFromToken(token),
        cookie
      });
    }
  }
  if (cursorConfig.autoDetectLocal !== false) {
    for (const source of discoverLocalCursorSources()) sources.push(source);
  }
  return sources;
}

function readTokenFromCursorSqlite() {
  const dbPath = cursorDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) return {};
  return readTokenUsingSqlJs(dbPath) || readTokenUsingSqliteCommand(dbPath);
}

function readTokenUsingSqlJs(dbPath) {
  try {
    const db = new SQL.Database(fs.readFileSync(dbPath));
    try {
      const token = querySqlJsValue(db, "cursorAuth/accessToken");
      if (!token) return {};
      return {
        token,
        accountName: querySqlJsValue(db, "cursorAuth/cachedEmail") || querySqlJsValue(db, "cursorAuth/email") || cursorAccountNameFromToken(token)
      };
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
}

function readTokenUsingSqliteCommand(dbPath) {
  try {
    const token = execFileSync("sqlite3", [dbPath, "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken';"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (!token) return {};
    const accountName = execFileSync("sqlite3", [dbPath, "SELECT value FROM ItemTable WHERE key IN ('cursorAuth/cachedEmail','cursorAuth/email') LIMIT 1;"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return { token, accountName: accountName || cursorAccountNameFromToken(token) };
  } catch {
    return {};
  }
}

function querySqlJsValue(db, key) {
  const result = db.exec(`SELECT value FROM ItemTable WHERE key = '${key.replaceAll("'", "''")}'`);
  return String(result?.[0]?.values?.[0]?.[0] || "");
}

function cursorDbPath() {
  if (process.env.CURSOR_STATE_DB_PATH) return process.env.CURSOR_STATE_DB_PATH;
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(home, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

function cursorConfigPaths() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return [
      path.join(home, "AppData", "Roaming", "Cursor", "User", "globalStorage", "storage.json"),
      path.join(home, ".cursor", "config.json"),
      path.join(home, "AppData", "Roaming", "Cursor", "config.json")
    ];
  }
  if (process.platform === "darwin") {
    return [
      path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "storage.json"),
      path.join(home, ".cursor", "config.json"),
      path.join(home, "Library", "Application Support", "Cursor", "config.json")
    ];
  }
  return [
    path.join(home, ".config", "Cursor", "User", "globalStorage", "storage.json"),
    path.join(home, ".cursor", "config.json"),
    path.join(home, ".config", "Cursor", "config.json")
  ];
}

function readTokenFromCursorConfig(configPath) {
  try {
    if (!fs.existsSync(configPath)) return {};
    const content = fs.readFileSync(configPath, "utf8");
    try {
      return authFromObject(JSON.parse(content));
    } catch {
      return { token: content.match(/WorkosCursorSessionToken[=:]["']?([^"'\s;]+)/)?.[1] || "" };
    }
  } catch {
    return {};
  }
}

function authFromObject(value) {
  if (!value || typeof value !== "object") return {};
  for (const key of ["cursorAuth/accessToken", "accessToken", "sessionToken", "WorkosCursorSessionToken"]) {
    if (typeof value[key] === "string" && value[key]) {
      return {
        token: value[key],
        accountName: value.accountName || value.email || value.cachedEmail || value["cursorAuth/cachedEmail"] || ""
      };
    }
  }
  for (const child of Object.values(value)) {
    const found = authFromObject(child);
    if (found.token) return found;
  }
  return {};
}

function userIdFromAccessToken(token = "") {
  try {
    const decoded = safeDecodeURIComponent(token);
    if (decoded.includes("::")) return decoded.split("::")[0];
    const parts = decoded.split(".");
    if (parts.length !== 3) return "";
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";
    const sub = JSON.parse(Buffer.from(payload, "base64").toString("utf8")).sub || "";
    return String(sub).match(/user_[A-Za-z0-9]+/)?.[0] || "";
  } catch {
    return "";
  }
}

function cursorTokenToCookie(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("WorkosCursorSessionToken=")) return text;
  const decoded = safeDecodeURIComponent(text);
  if (decoded.includes("::")) return `WorkosCursorSessionToken=${encodeURIComponent(decoded)}`;
  const userId = userIdFromAccessToken(decoded);
  return userId ? `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${decoded}`)}` : "";
}

function cursorAccountNameFromToken(token) {
  const decoded = safeDecodeURIComponent(String(token || "").trim());
  if (decoded.startsWith("WorkosCursorSessionToken=")) {
    return cursorAccountNameFromToken(decoded.replace(/^WorkosCursorSessionToken=/, ""));
  }
  if (decoded.includes("::")) return decoded.split("::")[0] || "Cursor";
  return userIdFromAccessToken(decoded) || "Cursor";
}

function cursorWorkdirName(source = {}) {
  const account = String(source.accountName || "").trim();
  return account ? `Cursor · ${account}` : "Cursor";
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function dedupeSources(sources) {
  const byCookie = new Map();
  for (const source of sources) {
    if (!source.cookie) continue;
    const current = byCookie.get(source.cookie);
    if (!current || sourceNameScore(source) > sourceNameScore(current)) {
      byCookie.set(source.cookie, source);
    }
  }
  const byAccount = new Map();
  for (const source of byCookie.values()) {
    const key = sourceAccountKey(source);
    const current = byAccount.get(key);
    if (!current || sourceNameScore(source) > sourceNameScore(current)) {
      byAccount.set(key, source);
    }
  }
  return [...byAccount.values()];
}

function sourceAccountKey(source = {}) {
  const account = String(source.accountName || "").trim().toLowerCase();
  if (account && account !== "cursor") return account;
  const token = safeDecodeURIComponent(String(source.cookie || "").replace(/^WorkosCursorSessionToken=/, ""));
  const userId = token.includes("::") ? token.split("::")[0] : userIdFromAccessToken(token);
  return userId || source.cookie || source.sourceKind || "cursor";
}

function sourceNameScore(source = {}) {
  const name = String(source.accountName || "");
  if (name.includes("@")) return 3;
  if (name && !name.startsWith("user_") && name !== "Cursor") return 2;
  if (name) return 1;
  return 0;
}

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function dayFromCursorTimestamp(value) {
  const timestamp = Number(value || 0);
  const date = new Date(timestamp);
  return localDay(Number.isNaN(date.getTime()) ? new Date() : date);
}
