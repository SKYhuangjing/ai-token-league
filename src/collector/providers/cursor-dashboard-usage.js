import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const cursorDashboardUsageProvider = {
  id: "cursor_dashboard_usage",
  toolCode: "cursor",
  version: "0.1.0",

  scanSessions(config = {}) {
    const cursorConfig = config.cursorDashboardUsage || {};
    if (!cursorConfig.enabled) return [];
    const sources = [];
    if (cursorConfig.workosSessionToken) {
      sources.push({
        sourceKind: "manual_workos_cookie",
        cookie: normalizeWorkosCookie(cursorConfig.workosSessionToken)
      });
    }
    for (const source of discoverAccountSources()) sources.push(source);
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
    const sources = this.scanSessions(config);
    return {
      providerId: this.id,
      toolCode: this.toolCode,
      detected: sources.length > 0,
      roots: sources.map((source) => source.sourceKind),
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
        workdirCandidate: "virtual:cursor-dashboard:Cursor",
        model: event.model || "cursor-model",
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

function cursorSourceFingerprint(event, source) {
  return crypto
    .createHash("sha256")
    .update([
      cursorDashboardUsageProvider.id,
      source.sourceKind || "cursor-dashboard",
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
          cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${account.access_token}`)}`
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function userIdFromAccessToken(token = "") {
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

function normalizeWorkosCookie(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("WorkosCursorSessionToken=")) return text;
  return `WorkosCursorSessionToken=${encodeURIComponent(text)}`;
}

function dedupeSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    if (!source.cookie || seen.has(source.cookie)) return false;
    seen.add(source.cookie);
    return true;
  });
}

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function dayFromCursorTimestamp(value) {
  const timestamp = Number(value || 0);
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}
