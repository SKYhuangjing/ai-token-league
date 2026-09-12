import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Store } from "./store.js";
import { MySqlStore } from "./mysql-store.js";
import { verifyPayload, sha256Hex, newId } from "../shared/crypto.js";
import { assertSnapshot } from "../shared/schema.js";
import { SERVER_PROTOCOL_VERSION, SERVER_VERSION, SUPPORTED_CLIENT_PROTOCOL, compatibilityResult } from "../shared/version.js";
import {
  buildInstallerMetadataFromGithubRelease,
  buildTauriUpdateJson,
  githubReleaseApiUrl,
  installerMetadataPlatforms,
  releaseConfigFromEnv,
  releaseDistributionFromEnv,
  releasePublicConfig,
  selectGithubAsset,
  validateInstallerMetadata,
  validateReleaseConfig,
  validateReleaseManifest
} from "../shared/update.js";
import { loadOrGenerateSalt, loadNames, BoardAnonymizer } from "./board-anonymizer.js";
import { currentBusinessDay } from "./day-context.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const SRC_DIR = path.resolve("src");
const WEB_DIR = path.resolve("src/web");
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const BOARD_AUTH_USERNAME = process.env.PUBLIC_BOARD_AUTH_USERNAME || "";
const BOARD_AUTH_PASSWORD = process.env.PUBLIC_BOARD_AUTH_PASSWORD || "";
const BOARD_SECURITY_LEVEL = (process.env.BOARD_SECURITY_LEVEL || "public").toLowerCase();
const BOARD_ANONYMIZATION_SALT = process.env.BOARD_ANONYMIZATION_SALT || "";
const BOARD_ANONYMIZATION_SALT_PATH = process.env.BOARD_ANONYMIZATION_SALT_PATH || "data/board-anonymization-salt.key";
const BOARD_ANONYMIZATION_NAMES_PATH = process.env.BOARD_ANONYMIZATION_NAMES_PATH || "assets/anonymizer-names.json";
const MIN_CLIENT_ENFORCE = String(process.env.MIN_CLIENT_ENFORCE || "").toLowerCase() === "true";
const USAGE_UPLOAD_SUCCESS_LOG = String(process.env.USAGE_UPLOAD_SUCCESS_LOG || "").toLowerCase() === "true";
const SLOW_USAGE_UPLOAD_LOG_MS = Number(process.env.SLOW_USAGE_UPLOAD_LOG_MS || 1000);
const API_PRETTY_JSON = String(process.env.API_PRETTY_JSON || "").toLowerCase() === "true";
const BRAND_LOGO_URL = process.env.BRAND_LOGO_URL || "";
const PROFILE_WORK_WINDOW = parseProfileWorkWindow(process.env.PROFILE_WORK_START, process.env.PROFILE_WORK_END);

// Work window for the profile hourly rhythm (上班/下班 split). Whole-hour
// buckets attribute boundary hours by overlap, so half-hour boundaries like
// 09:30–18:30 stay meaningful. Invalid values fall back to the defaults.
function parseProfileWorkWindow(start, end) {
  const time = /^([01]?\d|2[0-3]):[0-5]\d$/;
  const parsedStart = time.test(start || "") ? start : "09:30";
  const parsedEnd = time.test(end || "") ? end : "18:30";
  if ((start && !time.test(start)) || (end && !time.test(end))) {
    console.warn(`Invalid PROFILE_WORK_START/PROFILE_WORK_END (${start}–${end}), falling back to ${parsedStart}–${parsedEnd}`);
  }
  return { start: parsedStart, end: parsedEnd };
}

if (BOARD_SECURITY_LEVEL === "authenticated" && !BOARD_AUTH_USERNAME) {
  console.error("FATAL: BOARD_SECURITY_LEVEL=authenticated requires PUBLIC_BOARD_AUTH_USERNAME to be set");
  process.exit(1);
}

const store = await createConfiguredStore();

export { store, PROFILE_WORK_WINDOW };

let boardAnonymizer = null;
if (BOARD_SECURITY_LEVEL === "anonymous") {
  const salt = BOARD_ANONYMIZATION_SALT || loadOrGenerateSalt(BOARD_ANONYMIZATION_SALT_PATH);
  const names = loadNames(BOARD_ANONYMIZATION_NAMES_PATH);
  boardAnonymizer = new BoardAnonymizer(salt, names, currentBusinessDay);
  boardAnonymizer.buildReverseMap(Object.keys(store.db.participants));
}

function ensureAnonymizerFresh() {
  if (!boardAnonymizer) return;
  if (!boardAnonymizer.dirty && !boardAnonymizer.stale) return;
  boardAnonymizer.buildReverseMap(Object.keys(store.db.participants));
}

const AVATAR_COLORS = ["#1c7c54", "#ba3b46", "#006d77", "#8f5f00", "#3d5a80", "#7b2cbf"];

function colorFromId(id) {
  return AVATAR_COLORS[Number.parseInt(sha256Hex(id).slice(0, 2), 16) % AVATAR_COLORS.length];
}

function transformBoardItem(item) {
  const { participantId, nickname, ...rest } = item;
  if (BOARD_SECURITY_LEVEL !== "anonymous") {
    return { displayId: participantId, displayName: nickname, ...rest };
  }
  const displayId = boardAnonymizer.getPublicId(participantId);
  const displayName = boardAnonymizer.getDisplayName(displayId);
  return { displayId, displayName, avatarColor: colorFromId(displayId), ...rest };
}

function withBusinessDay(body = {}) {
  return { businessDay: currentBusinessDay(), ...body };
}

function logServerEvent(event, level, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    source: "backend",
    event,
    ...data
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function snapshotLogSummary(snapshot = {}, items = []) {
  const safeSnapshot = snapshot && typeof snapshot === "object" ? snapshot : {};
  const safeItems = Array.isArray(items) ? items : [];
  return {
    mode: safeSnapshot.mode || "legacy",
    day: safeSnapshot.day || "",
    hour: safeSnapshot.hour ?? null,
    providerId: safeSnapshot.providerId || "",
    bucketFingerprint: safeSnapshot.bucketFingerprint || "",
    rowCount: Number.isInteger(safeSnapshot.rowCount) ? safeSnapshot.rowCount : safeItems.length,
    totalTokens: Number.isFinite(safeSnapshot.totalTokens) ? safeSnapshot.totalTokens : null
  };
}

function mysqlWriteMode(snapshot, result) {
  if (result?.noOp) return "noop";
  if (store.dbType !== "mysql") return "json";
  if (snapshot?.mode === "device_day_hour_provider") return "incrementalHourly";
  if (snapshot?.mode === "device_day_provider") return "incrementalDaily";
  // Legacy upload (no snapshot). Goes through loadUsageMirrorForMaintenance() +
  // syncLegacyUsageMirror(); this is NOT a full-table flush — only the rows
  // present in the upload payload are reconciled against the per-day mirror.
  // The previous label "fullSync" was a holdover from the old global-DELETE
  // path and is misleading for ops/triage.
  return "legacyMirrorSync";
}

function shouldLogUsageUploadSuccess(result, writeMode, durationMs) {
  return USAGE_UPLOAD_SUCCESS_LOG || writeMode === "legacyMirrorSync" || (result?.rejected || 0) > 0 || durationMs >= SLOW_USAGE_UPLOAD_LOG_MS;
}

function isFreshReconcileRequest(timestamp) {
  const ageMs = Date.now() - new Date(timestamp || "").getTime();
  return Number.isFinite(ageMs) && Math.abs(ageMs) <= 5 * 60 * 1000;
}

function transformBoardDetail(detail) {
  if (!detail) return detail;
  const { participantId, nickname, ...rest } = detail;
  if (BOARD_SECURITY_LEVEL !== "anonymous") {
    return { displayId: participantId, displayName: nickname, ...rest };
  }
  const displayId = boardAnonymizer.getPublicId(participantId);
  const displayName = boardAnonymizer.getDisplayName(displayId);
  const result = { displayId, displayName, avatarColor: colorFromId(displayId), ...rest };
  if (result.rows) {
    result.rows = result.rows.map((row, i) => {
      const { workdirDisplayName, ...rowRest } = row;
      return { ...rowRest, workdirDisplayName: `Workdir ${i + 1}` };
    });
  }
  if (result.workdirs) {
    result.workdirs = result.workdirs.map((w, i) => ({ name: `Workdir ${i + 1}`, totalTokens: w.totalTokens }));
  }
  if (result.periodRows) {
    result.periodRows = result.periodRows.map((row) => {
      const { workdirDisplayName, ...rowRest } = row;
      return rowRest;
    });
  }
  return result;
}

function transformTrendResult(trend) {
  if (!trend) return trend;
  const { participantId, nickname, ...rest } = trend;
  if (BOARD_SECURITY_LEVEL !== "anonymous") {
    return { displayId: participantId, displayName: nickname, ...rest };
  }
  const displayId = boardAnonymizer.getPublicId(participantId);
  const displayName = boardAnonymizer.getDisplayName(displayId);
  const result = { displayId, displayName, ...rest };
  if (result.items) {
    result.items = result.items.map((item) => {
      const { participantId: pid, nickname: nn, workdirs, ...itemRest } = item;
      return itemRest;
    });
  }
  return result;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    ...corsHeaders(),
    "content-type": "application/json; charset=utf-8"
  });
  res.end(API_PRETTY_JSON ? JSON.stringify(body, null, 2) : JSON.stringify(body));
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization"
  };
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.startsWith("=") || str.startsWith("+") || str.startsWith("-") || str.startsWith("@")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function checkBasicAuth(req, res, { username = ADMIN_USERNAME, password = ADMIN_PASSWORD, realm = "Admin" } = {}) {
  if (!username) return true;
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
    const pass = sep >= 0 ? decoded.slice(sep + 1) : "";
    if (user === username && pass === password) return true;
  }
  res.writeHead(401, { "www-authenticate": `Basic realm="${realm}"`, "content-type": "text/plain; charset=utf-8" });
  res.end("401 Unauthorized");
  return false;
}

function checkBoardAuth(req, res) {
  if (BOARD_SECURITY_LEVEL !== "authenticated") return true;
  return checkBasicAuth(req, res, { username: BOARD_AUTH_USERNAME, password: BOARD_AUTH_PASSWORD, realm: "Board" });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function handleApi(req, res) {
  if (req.url.startsWith("/api/admin/") && !checkBasicAuth(req, res)) return;
  if (req.method === "GET" && req.url.startsWith("/api/board/summary")) {
    return sendJson(res, 200, withBusinessDay({
      ...(await store.boardSummary()),
      identityMode: BOARD_SECURITY_LEVEL,
      identityLabel: BOARD_SECURITY_LEVEL === "anonymous" ? "anonymousDisplayName" : "nickname"
    }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/board/my-identity")) {
    const url = new URL(req.url, "http://localhost");
    const participantId = url.searchParams.get("participantId") || "";
    if (!boardAnonymizer) return sendJson(res, 200, withBusinessDay({ identityMode: "public", displayName: "" }));
    if (!participantId) return sendJson(res, 400, { error: "participantId required" });
    ensureAnonymizerFresh();
    const publicId = boardAnonymizer.getPublicId(participantId);
    const displayName = boardAnonymizer.getDisplayName(publicId);
    return sendJson(res, 200, withBusinessDay({ identityMode: "anonymous", publicId, displayName }));
  }
  if (req.url.startsWith("/api/board/") && !checkBoardAuth(req, res)) return;
  if (req.method === "POST" && req.url === "/api/devices/register") {
    const body = await readBody(req);
    const compatibility = serverCompatibility(body.client || body);
    if (!compatibility.compatible) return sendJson(res, 426, { error: compatibility.status, compatibility });
    const result = await store.registerDevice(body);
    if (boardAnonymizer) boardAnonymizer.markDirty();
    return sendJson(res, 200, { ...result, compatibility });
  }
  if (req.method === "POST" && req.url === "/api/usage/daily-batches") {
    const requestId = newId("req");
    const started = Date.now();
    const body = await readBody(req);
    const batches = Array.isArray(body.batches) ? body.batches : [];
    const baseLog = {
      requestId,
      participantId: body.participantId || "",
      deviceId: body.deviceId || "",
      clientGeneratedAt: body.clientGeneratedAt || "",
      dbType: store.dbType || "json",
      batchCount: batches.length
    };
    const compatibility = serverCompatibility(body.client || body);
    if (!compatibility.compatible) {
      logServerEvent("usage_batch_upload_rejected", "warn", {
        ...baseLog,
        status: 426,
        errorKind: "incompatible_client",
        error: compatibility.status,
        durationMs: Date.now() - started
      });
      return sendJson(res, 426, { error: compatibility.status, compatibility });
    }
    if (!batches.length) {
      return sendJson(res, 400, { error: "batches required" });
    }
    const participant = store.getParticipant(body.participantId);
    if (!participant) {
      logServerEvent("usage_batch_upload_rejected", "warn", {
        ...baseLog,
        status: 404,
        errorKind: "participant_not_registered",
        durationMs: Date.now() - started
      });
      return sendJson(res, 404, { error: "participant is not registered" });
    }
    const payload = {
      participantId: body.participantId,
      deviceId: body.deviceId,
      clientGeneratedAt: body.clientGeneratedAt,
      ...(Object.hasOwn(body, "client") ? { client: body.client } : {}),
      batches: body.batches
    };
    if (!verifyPayload(participant.identityPublicKey, payload, body.signature)) {
      logServerEvent("usage_batch_upload_rejected", "warn", {
        ...baseLog,
        status: 401,
        errorKind: "invalid_signature",
        durationMs: Date.now() - started
      });
      return sendJson(res, 401, { error: "invalid signature" });
    }
    for (const [index, batch] of batches.entries()) {
      try {
        assertSnapshot(batch.snapshot, batch.items, body.participantId, body.deviceId);
      } catch (e) {
        logServerEvent("usage_batch_upload_rejected", "warn", {
          ...baseLog,
          status: 400,
          errorKind: "invalid_snapshot",
          batchIndex: index,
          error: e.message,
          durationMs: Date.now() - started
        });
        return sendJson(res, 400, { error: e.message, batchIndex: index });
      }
    }
    try {
      const result = await store.upsertUsageBatchSet(payload);
      const durationMs = Date.now() - started;
      if (shouldLogUsageUploadSuccess(result, store.dbType === "mysql" ? "batch" : "json", durationMs)) {
        logServerEvent("usage_batch_upload_processed", "info", {
          ...baseLog,
          status: 200,
          accepted: result.accepted || 0,
          rejected: result.rejected || 0,
          duplicateBucketCount: result.duplicateBucketCount || 0,
          noOpBucketCount: result.noOpBucketCount || 0,
          durationMs
        });
      }
      return sendJson(res, 200, { ...result, compatibility });
    } catch (error) {
      logServerEvent("usage_batch_upload_error", "error", {
        ...baseLog,
        status: 500,
        errorKind: "store_write_failed",
        error: error.message,
        durationMs: Date.now() - started
      });
      throw error;
    }
  }
  if (req.method === "POST" && req.url === "/api/usage/daily-batch") {
    const requestId = newId("req");
    const started = Date.now();
    const body = await readBody(req);
    const baseLog = {
      requestId,
      participantId: body.participantId || "",
      deviceId: body.deviceId || "",
      clientGeneratedAt: body.clientGeneratedAt || "",
      dbType: store.dbType || "json",
      snapshot: snapshotLogSummary(body.snapshot, body.items || [])
    };
    const compatibility = serverCompatibility(body.client || body);
    if (!compatibility.compatible) {
      logServerEvent("usage_upload_rejected", "warn", {
        ...baseLog,
        status: 426,
        errorKind: "incompatible_client",
        error: compatibility.status,
        durationMs: Date.now() - started
      });
      return sendJson(res, 426, { error: compatibility.status, compatibility });
    }
    const participant = store.getParticipant(body.participantId);
    if (!participant) {
      logServerEvent("usage_upload_rejected", "warn", {
        ...baseLog,
        status: 404,
        errorKind: "participant_not_registered",
        durationMs: Date.now() - started
      });
      return sendJson(res, 404, { error: "participant is not registered" });
    }
    const payload = {
      participantId: body.participantId,
      deviceId: body.deviceId,
      clientGeneratedAt: body.clientGeneratedAt,
      ...(Object.hasOwn(body, "client") ? { client: body.client } : {}),
      ...(Object.hasOwn(body, "snapshot") ? { snapshot: body.snapshot } : {}),
      items: body.items
    };
    if (!verifyPayload(participant.identityPublicKey, payload, body.signature)) {
      logServerEvent("usage_upload_rejected", "warn", {
        ...baseLog,
        status: 401,
        errorKind: "invalid_signature",
        durationMs: Date.now() - started
      });
      return sendJson(res, 401, { error: "invalid signature" });
    }
    if (body.snapshot) {
      try {
        assertSnapshot(body.snapshot, body.items, body.participantId, body.deviceId);
      } catch (e) {
        logServerEvent("usage_upload_rejected", "warn", {
          ...baseLog,
          status: 400,
          errorKind: "invalid_snapshot",
          error: e.message,
          durationMs: Date.now() - started
        });
        return sendJson(res, 400, { error: e.message });
      }
    }
    try {
      const result = await store.upsertUsageBatch(payload);
      const durationMs = Date.now() - started;
      const writeMode = mysqlWriteMode(body.snapshot, result);
      if (shouldLogUsageUploadSuccess(result, writeMode, durationMs)) {
        // Legacy mirror sync is the normal fallback path for old clients; it is
        // no longer the dangerous full-table flush, so log at info. Reserve
        // higher levels for actual error paths below.
        logServerEvent("usage_upload_processed", "info", {
          ...baseLog,
          status: 200,
          accepted: result.accepted || 0,
          rejected: result.rejected || 0,
          duplicate: Boolean(result.duplicate),
          noOp: Boolean(result.noOp),
          mysqlWriteMode: writeMode,
          durationMs
        });
      }
      return sendJson(res, 200, { ...result, compatibility });
    } catch (error) {
      logServerEvent("usage_upload_error", "error", {
        ...baseLog,
        status: 500,
        errorKind: "store_write_failed",
        error: error.message,
        mysqlWriteMode: mysqlWriteMode(body.snapshot, null),
        durationMs: Date.now() - started
      });
      throw error;
    }
  }
  if (req.method === "POST" && req.url === "/api/usage/reconcile-inventory") {
    const body = await readBody(req);
    const participant = store.getParticipant(body.participantId);
    const device = await store.getDeviceById(body.deviceId);
    if (!participant || !device || device.participantId !== body.participantId) {
      return sendJson(res, 404, { error: "participant or device not found" });
    }
    const limit = Math.max(1, Math.min(Number(body.limit) || 250, 250));
    const granularity = body.granularity === "hourly" ? "hourly" : body.granularity === "daily" || !body.granularity ? "daily" : "";
    if (!granularity) return sendJson(res, 400, { error: "granularity must be hourly or daily" });
    const payload = {
      participantId: body.participantId,
      deviceId: body.deviceId,
      clientGeneratedAt: body.clientGeneratedAt,
      cursor: body.cursor || "",
      limit,
      granularity
    };
    if (!isFreshReconcileRequest(body.clientGeneratedAt) || !verifyPayload(participant.identityPublicKey, payload, body.signature)) {
      return sendJson(res, 401, { error: "invalid reconcile inventory request" });
    }
    const method = granularity === "hourly" ? "listReconcileHourlyScopes" : "listReconcileDailyScopes";
    return sendJson(res, 200, await store[method](body.participantId, body.deviceId, { cursor: payload.cursor, limit }));
  }
  if (req.method === "POST" && req.url === "/api/usage/reconcile-scopes") {
    const body = await readBody(req);
    const participant = store.getParticipant(body.participantId);
    const device = await store.getDeviceById(body.deviceId);
    if (!participant || !device || device.participantId !== body.participantId) {
      return sendJson(res, 404, { error: "participant or device not found" });
    }
    if (!Array.isArray(body.actions) || body.actions.length > 25) {
      return sendJson(res, 400, { error: "actions must contain at most 25 scope actions" });
    }
    const hourlyActions = body.actions.filter((action) => action?.action === "prune_hourly").length;
    if (hourlyActions && hourlyActions !== body.actions.length) {
      return sendJson(res, 400, { error: "hourly and daily reconcile actions must not be mixed" });
    }
    const payload = {
      participantId: body.participantId,
      deviceId: body.deviceId,
      clientGeneratedAt: body.clientGeneratedAt,
      actions: body.actions
    };
    if (!isFreshReconcileRequest(body.clientGeneratedAt) || !verifyPayload(participant.identityPublicKey, payload, body.signature)) {
      return sendJson(res, 401, { error: "invalid reconcile scope request" });
    }
    const method = hourlyActions ? "reconcileHourlyScopes" : "reconcileDailyScopes";
    return sendJson(res, 200, await store[method](body.participantId, body.deviceId, body.actions));
  }
  if (req.method === "POST" && req.url === "/api/usage/sync-state") {
    const body = await readBody(req);
    const participant = store.getParticipant(body.participantId);
    if (!participant) return sendJson(res, 404, { error: "participant is not registered" });
    const mode = body.mode || "recent";
    const MAX_SYNC_STATE_BUCKETS = 250;
    if (!Array.isArray(body.buckets)) {
      return sendJson(res, 400, { error: "buckets must be an array" });
    }
    const bucketCount = body.buckets.length;
    if (bucketCount > MAX_SYNC_STATE_BUCKETS) {
      return sendJson(res, 400, {
        error: `too many buckets: ${bucketCount} exceeds limit ${MAX_SYNC_STATE_BUCKETS}`
      });
    }
    const payload = {
      participantId: body.participantId,
      deviceId: body.deviceId,
      clientGeneratedAt: body.clientGeneratedAt,
      buckets: body.buckets
    };
    if (Object.hasOwn(body, "mode")) {
      payload.mode = mode;
    }
    if (!verifyPayload(participant.identityPublicKey, payload, body.signature)) {
      return sendJson(res, 401, { error: "invalid signature" });
    }
    return sendJson(res, 200, await store.compareSyncState(payload));
  }
  if (req.method === "POST" && req.url === "/api/admin/recalculate-costs") {
    return sendJson(res, 200, await store.recalculateCosts());
  }
  if (req.method === "POST" && req.url.startsWith("/api/admin/model-prices/refresh-openrouter")) {
    const url = new URL(req.url, "http://localhost");
    return sendJson(res, 200, await store.refreshOpenRouterPrices({ recalculate: includeFlag(url, "recalculate") }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/model-prices")) {
    return sendJson(res, 200, await store.listModelPrices());
  }
  if (req.method === "GET" && req.url.startsWith("/api/admin/model-prices")) {
    return sendJson(res, 200, await store.listModelPrices());
  }
  if (req.method === "POST" && req.url === "/api/admin/model-prices") {
    const body = await readBody(req);
    return sendJson(res, 200, await store.upsertModelPrice(body));
  }
  if (req.method === "POST" && req.url === "/api/admin/model-price-aliases") {
    const body = await readBody(req);
    return sendJson(res, 200, await store.upsertModelPriceAlias(body));
  }
  if (req.method === "DELETE" && req.url.startsWith("/api/admin/model-price-aliases/")) {
    const model = decodeURIComponent(new URL(req.url, "http://localhost").pathname.replace("/api/admin/model-price-aliases/", ""));
    return sendJson(res, 200, await store.deleteModelPriceAlias(model));
  }
  if (req.method === "DELETE" && req.url.startsWith("/api/admin/model-prices/")) {
    const model = decodeURIComponent(new URL(req.url, "http://localhost").pathname.replace("/api/admin/model-prices/", ""));
    return sendJson(res, 200, await store.deleteModelPrice(model));
  }
  if (req.method === "GET" && req.url.startsWith("/api/admin/profile/")) {
    const url = new URL(req.url, "http://localhost");
    const participantId = decodeURIComponent(url.pathname.replace("/api/admin/profile/", ""));
    const profile = await store.participantProfile(participantId, { includeCost: includeCost(url) });
    if (!profile) return sendJson(res, 404, { error: "participant not found" });
    return sendJson(res, 200, withBusinessDay({
      identityMode: "admin",
      displayId: participantId,
      displayName: profile.nickname || participantId,
      ...profile
    }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/admin/participants/") && req.url.includes("/trend")) {
    const url = new URL(req.url, "http://localhost");
    const participantId = decodeURIComponent(url.pathname.replace("/api/admin/participants/", "").replace("/trend", ""));
    const trend = await store.participantTrend(participantId, {
      grain: url.searchParams.get("grain") || "day",
      range: url.searchParams.get("range") || "last30",
      startDay: url.searchParams.get("start") || "",
      endDay: url.searchParams.get("end") || "",
      includeCost: includeCost(url),
      fields: url.searchParams.get("fields") === "totals" ? "totals" : ""
    });
    if (!trend) return sendJson(res, 404, { error: "participant not found" });
    if (trend.grain === "hour-of-day") trend.workWindow = PROFILE_WORK_WINDOW;
    return sendJson(res, 200, withBusinessDay({
      displayId: participantId,
      displayName: trend.nickname || participantId,
      ...trend
    }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/admin/participants/") && !req.url.includes("/trend")) {
    const url = new URL(req.url, "http://localhost");
    const participantId = decodeURIComponent(url.pathname.replace("/api/admin/participants/", ""));
    const detail = await store.participantDetail(participantId, {
      period: url.searchParams.get("period") || "",
      grain: url.searchParams.get("grain") || "day",
      range: url.searchParams.get("range") || "today",
      startDay: url.searchParams.get("start") || "",
      endDay: url.searchParams.get("end") || "",
      includeCost: includeCost(url)
    });
    if (!detail) return sendJson(res, 404, { error: "participant not found" });
    return sendJson(res, 200, withBusinessDay({
      displayId: participantId,
      displayName: detail.nickname || participantId,
      ...detail
    }));
  }
  if (req.method === "DELETE" && req.url.startsWith("/api/admin/participants/")) {
    const participantId = decodeURIComponent(new URL(req.url, "http://localhost").pathname.replace("/api/admin/participants/", ""));
    const result = await store.deleteParticipantData(participantId);
    if (boardAnonymizer) boardAnonymizer.markDirty();
    return sendJson(res, 200, result);
  }
  if (req.method === "DELETE" && req.url.startsWith("/api/admin/devices/") && req.url.endsWith("/data")) {
    const deviceId = decodeURIComponent(new URL(req.url, "http://localhost").pathname.replace("/api/admin/devices/", "").replace("/data", ""));
    const result = await store.deleteDeviceData(deviceId);
    if (boardAnonymizer) boardAnonymizer.markDirty();
    return sendJson(res, 200, result);
  }
  if (req.method === "DELETE" && req.url === "/api/participant/data") {
    const body = await readBody(req);
    if (!body.participantId || !body.deviceId || !body.timestamp || !body.signature) {
      return sendJson(res, 400, { error: "participantId, deviceId, timestamp, and signature are required" });
    }
    const ageMs = Date.now() - new Date(body.timestamp).getTime();
    if (!Number.isFinite(ageMs) || Math.abs(ageMs) > 5 * 60 * 1000) {
      return sendJson(res, 401, { error: "timestamp is too old or invalid" });
    }
    const participant = store.getParticipant(body.participantId);
    if (!participant) return sendJson(res, 200, await store.deleteParticipantData(body.participantId));
    const payload = { participantId: body.participantId, deviceId: body.deviceId, timestamp: body.timestamp };
    if (!verifyPayload(participant.identityPublicKey, payload, body.signature)) {
      return sendJson(res, 401, { error: "invalid signature" });
    }
    const device = await store.getDeviceById(body.deviceId);
    if (!device || device.participantId !== body.participantId) {
      return sendJson(res, 403, { error: "deviceId does not belong to this participant" });
    }
    const deviceCount = await store.countDevicesByParticipant(body.participantId);
    let result;
    if (deviceCount <= 1) {
      result = await store.deleteParticipantData(body.participantId);
    } else {
      result = await store.deleteDeviceData(body.deviceId);
    }
    if (boardAnonymizer) boardAnonymizer.markDirty();
    return sendJson(res, 200, result);
  }
  if (req.method === "GET" && req.url.startsWith("/api/leaderboard")) {
    const url = new URL(req.url, "http://localhost");
    const period = url.searchParams.get("period") || "";
    const range = url.searchParams.get("range") || "today";
    return sendJson(res, 200, {
      period: period || range,
      tool: url.searchParams.get("tool") || "all",
      items: await store.leaderboard({
        period,
        range,
        tool: url.searchParams.get("tool") || "all",
        startDay: url.searchParams.get("start") || "",
        endDay: url.searchParams.get("end") || ""
      })
    });
  }
  if (req.method === "GET" && req.url.startsWith("/api/board/leaderboard")) {
    const url = new URL(req.url, "http://localhost");
    const period = url.searchParams.get("period") || "";
    const range = url.searchParams.get("range") || "today";
    ensureAnonymizerFresh();
    return sendJson(res, 200, withBusinessDay({
      period: period || range,
      identityMode: BOARD_SECURITY_LEVEL,
      identityLabel: BOARD_SECURITY_LEVEL === "anonymous" ? "anonymousDisplayName" : "nickname",
      items: (await store.publicLeaderboard({
        period,
        range,
        startDay: url.searchParams.get("start") || "",
        endDay: url.searchParams.get("end") || "",
        source: url.searchParams.get("source") || "",
        includeCost: includeCost(url)
      })).map((item) => transformBoardItem(item))
    }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/board/source-leaderboard")) {
    const url = new URL(req.url, "http://localhost");
    const period = url.searchParams.get("period") || "";
    const range = url.searchParams.get("range") || "this_month";
    ensureAnonymizerFresh();
    const result = await store.sourceLeaderboard({
      period,
      range,
      startDay: url.searchParams.get("start") || "",
      endDay: url.searchParams.get("end") || "",
      top: url.searchParams.get("top") || "3",
      includeCost: includeCost(url)
    });
    return sendJson(res, 200, withBusinessDay({
      period: period || range,
      identityMode: BOARD_SECURITY_LEVEL,
      identityLabel: BOARD_SECURITY_LEVEL === "anonymous" ? "anonymousDisplayName" : "nickname",
      totalTokens: result.totalTokens,
      sources: result.sources.map((source) => ({
        ...source,
        items: source.items.map((item) => transformBoardItem(item))
      }))
    }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/admin/usage-ranking")) {
    const url = new URL(req.url, "http://localhost");
    return sendJson(res, 200, await store.adminUsageRanking({
      range: url.searchParams.get("range") || "month",
      startDay: url.searchParams.get("start") || "",
      endDay: url.searchParams.get("end") || "",
      participantId: url.searchParams.get("participantId") || "",
      source: url.searchParams.get("source") || "",
      includeCost: includeCost(url),
      page: url.searchParams.get("page") || "1",
      pageSize: url.searchParams.get("pageSize") || "25"
    }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/admin/usage")) {
    const url = new URL(req.url, "http://localhost");
    return sendJson(res, 200, await store.adminUsage({
      grain: url.searchParams.get("grain") || "day",
      range: url.searchParams.get("range") || "month",
      startDay: url.searchParams.get("start") || "",
      endDay: url.searchParams.get("end") || "",
      participantId: url.searchParams.get("participantId") || "",
      includeCost: includeCost(url)
    }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/admin/source-stats")) {
    const url = new URL(req.url, "http://localhost");
    return sendJson(res, 200, await store.adminSourceStats({
      range: url.searchParams.get("range") || "month",
      startDay: url.searchParams.get("start") || "",
      endDay: url.searchParams.get("end") || "",
      trendDays: url.searchParams.get("trendDays") || "30"
    }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/admin/quality")) {
    const url = new URL(req.url, "http://localhost");
    return sendJson(res, 200, await store.adminQuality({
      range: url.searchParams.get("range") || "month",
      startDay: url.searchParams.get("start") || "",
      endDay: url.searchParams.get("end") || "",
      participantId: url.searchParams.get("participantId") || ""
    }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/admin/export/csv")) {
    const url = new URL(req.url, "http://localhost");
    const range = url.searchParams.get("range") || "month";
    const startDay = url.searchParams.get("start") || "";
    const endDay = url.searchParams.get("end") || "";
    if (range === "custom" && startDay && endDay) {
      const start = new Date(startDay);
      const end = new Date(endDay);
      if (!isNaN(start) && !isNaN(end) && (end - start) / 86400000 > 90) {
        return sendJson(res, 400, { error: "CSV export range cannot exceed 90 days" });
      }
    }
    const rows = await store.exportDailyCsv({
      range,
      startDay,
      endDay,
      participantId: url.searchParams.get("participantId") || ""
    });
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="usage-daily-${new Date().toISOString().slice(0, 10)}.csv"`
    });
    res.write("﻿");
    res.write("Date,User,Workdir,Tool,Provider,Model,Input Tokens,Output Tokens,Cache Read Tokens,Cache Write Tokens,Reasoning Tokens,Total Tokens,Estimated Cost USD,Cost Quality,Source Quality\n");
    for (const row of rows) {
      res.write([
        csvEscape(row.day),
        csvEscape(row.nickname),
        csvEscape(row.workdirDisplayName),
        csvEscape(row.toolCode),
        csvEscape(row.providerId),
        csvEscape(row.model),
        row.inputTokens,
        row.outputTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens,
        row.reasoningTokens,
        row.totalTokens,
        row.estimatedCostUsd,
        csvEscape(row.costQuality),
        csvEscape(row.sourceQuality)
      ].join(",") + "\n");
    }
    res.end();
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/admin/devices")) {
    return sendJson(res, 200, store.adminDevices());
  }
  if (req.method === "GET" && req.url.startsWith("/api/board/participants/") && req.url.includes("/trend")) {
    const url = new URL(req.url, "http://localhost");
    const displayId = decodeURIComponent(url.pathname.replace("/api/board/participants/", "").replace("/trend", ""));
    ensureAnonymizerFresh();
    const realId = BOARD_SECURITY_LEVEL === "anonymous" ? boardAnonymizer?.resolveParticipantId(displayId) || displayId : displayId;
    const detail = await store.participantTrend(realId, {
      grain: url.searchParams.get("grain") || "day",
      range: url.searchParams.get("range") || "last30",
      startDay: url.searchParams.get("start") || "",
      endDay: url.searchParams.get("end") || "",
      includeCost: includeCost(url),
      fields: url.searchParams.get("fields") === "totals" ? "totals" : ""
    });
    if (!detail) return sendJson(res, 404, { error: "participant not found" });
    if (detail.grain === "hour-of-day") detail.workWindow = PROFILE_WORK_WINDOW;
    return sendJson(res, 200, withBusinessDay(transformTrendResult(detail)));
  }
  if (req.method === "GET" && req.url.startsWith("/api/board/analytics")) {
    const url = new URL(req.url, "http://localhost");
    const displayId = url.searchParams.get("participantId") || "";
    ensureAnonymizerFresh();
    
    let realId = "";
    if (displayId) {
      realId = BOARD_SECURITY_LEVEL === "anonymous" 
        ? boardAnonymizer?.resolveParticipantId(displayId) || displayId 
        : displayId;
      if (!store.getParticipant(realId)) {
        return sendJson(res, 404, { error: "participant not found" });
      }
    }
    
    const period = url.searchParams.get("period") || "";
    const range = url.searchParams.get("range") || "this_month";
    const startDay = url.searchParams.get("start") || "";
    const endDay = url.searchParams.get("end") || "";

    const data = await store.analytics({
      period,
      range,
      startDay,
      endDay,
      participantId: realId
    });
    if (data.hourlyRhythm) data.hourlyRhythm.workWindow = PROFILE_WORK_WINDOW;

    let identity;
    if (realId && BOARD_SECURITY_LEVEL === "anonymous") {
      identity = { displayName: boardAnonymizer.getDisplayName(displayId), displayId };
    } else if (realId) {
      const p = store.getParticipant(realId);
      identity = { displayName: p ? p.nickname : realId, displayId: realId };
    } else {
      identity = { displayName: "Community", displayId: "" };
    }

    // Workdir names are real project paths — they stay admin-only.
    const safeData = data.participantRanking
      ? {
          ...data,
          participantRanking: data.participantRanking.map((item) => transformBoardItem(item))
        }
      : data;
    const { workdirs, workdirMonthly, ...publicData } = safeData;
    return sendJson(res, 200, withBusinessDay({ ...publicData, ...identity }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/admin/analytics")) {
    const url = new URL(req.url, "http://localhost");
    const realId = url.searchParams.get("participantId") || "";
    if (realId && !store.getParticipant(realId)) {
      return sendJson(res, 404, { error: "participant not found" });
    }
    
    const period = url.searchParams.get("period") || "";
    const range = url.searchParams.get("range") || "this_month";
    const startDay = url.searchParams.get("start") || "";
    const endDay = url.searchParams.get("end") || "";

    const data = await store.analytics({
      period,
      range,
      startDay,
      endDay,
      participantId: realId
    });
    if (data.hourlyRhythm) data.hourlyRhythm.workWindow = PROFILE_WORK_WINDOW;

    let identity;
    if (realId) {
      const p = store.getParticipant(realId);
      identity = { displayName: p ? p.nickname : realId, displayId: realId };
    } else {
      identity = { displayName: "Community", displayId: "" };
    }

    return sendJson(res, 200, withBusinessDay({ ...data, ...identity }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/board/participants/")) {
    const url = new URL(req.url, "http://localhost");
    const displayId = decodeURIComponent(url.pathname.replace("/api/board/participants/", ""));
    ensureAnonymizerFresh();
    const realId = BOARD_SECURITY_LEVEL === "anonymous" ? boardAnonymizer?.resolveParticipantId(displayId) || displayId : displayId;
    const period = url.searchParams.get("period") || "";
    const detail = await store.participantDetail(realId, {
      period,
      range: url.searchParams.get("range") || "today",
      startDay: url.searchParams.get("start") || "",
      endDay: url.searchParams.get("end") || "",
      includeCost: includeCost(url)
    });
    if (!detail) return sendJson(res, 404, { error: "participant not found" });
    return sendJson(res, 200, withBusinessDay(transformBoardDetail(detail)));
  }
  if (req.method === "GET" && req.url.startsWith("/api/board/profile/")) {
    const url = new URL(req.url, "http://localhost");
    const displayId = decodeURIComponent(url.pathname.replace("/api/board/profile/", ""));
    ensureAnonymizerFresh();
    const realId = BOARD_SECURITY_LEVEL === "anonymous" ? boardAnonymizer?.resolveParticipantId(displayId) || displayId : displayId;
    const profile = await store.participantProfile(realId, { includeCost: includeCost(url) });
    if (!profile) return sendJson(res, 404, { error: "participant not found" });
    return sendJson(res, 200, withBusinessDay({ identityMode: BOARD_SECURITY_LEVEL, ...transformBoardDetail(profile) }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/health")) {
    const url = new URL(req.url, "http://localhost");
    return sendJson(res, 200, healthBody(Object.fromEntries(url.searchParams.entries())));
  }
  if (req.method === "GET" && req.url.startsWith("/api/release/config")) {
    const url = new URL(req.url, "http://localhost");
    return sendJson(res, 200, await releaseConfigBody(Object.fromEntries(url.searchParams.entries())));
  }
  // Legacy release manifest endpoint (backward-compatible).
  if (req.method === "GET" && req.url.startsWith("/api/release/latest")) {
    return sendJson(res, 200, await releaseLatestBody());
  }
  // Tauri updater endpoint — returns Tauri-format update JSON.
  if (req.method === "GET" && req.url.startsWith("/api/tauri/update.json")) {
    return sendJson(res, 200, await tauriUpdateBody());
  }
  if (req.method === "GET" && req.url === "/api/brand/logo") {
    return sendJson(res, 200, { logoUrl: BRAND_LOGO_URL || null });
  }
  return sendJson(res, 404, { error: "not found" });
}

function includeCost(url) {
  return includeFlag(url, "includeCost");
}

function includeFlag(url, name) {
  return ["1", "true", "yes"].includes(String(url.searchParams.get(name) || "").toLowerCase());
}

function serverCompatibility(client = {}) {
  return compatibilityResult(client, {
    latestClientVersion: process.env.LATEST_CLIENT_VERSION || SERVER_VERSION,
    minClientEnforce: MIN_CLIENT_ENFORCE,
    serverVersion: SERVER_VERSION
  });
}

async function latestClientVersionFromReleaseSource(fallback = SERVER_VERSION) {
  if (process.env.LATEST_CLIENT_VERSION) return process.env.LATEST_CLIENT_VERSION;
  const release = releaseDistributionFromEnv();
  if (release.source !== "github") return fallback;
  try {
    const meta = await fetchGithubRelease(release);
    return String(meta.tag_name || "").replace(/^v/, "") || fallback;
  } catch {
    return fallback;
  }
}

function healthBody(client = {}) {
  const latestClientVersion = process.env.LATEST_CLIENT_VERSION || SERVER_VERSION;
  const release = releaseDistributionFromEnv();
  return {
    ok: true,
    dbType: store.dbType || "json",
    serverTime: new Date().toISOString(),
    serverVersion: SERVER_VERSION,
    serverProtocolVersion: SERVER_PROTOCOL_VERSION,
    supportedClientProtocol: SUPPORTED_CLIENT_PROTOCOL,
    latestClientVersion,
    minClientEnforce: MIN_CLIENT_ENFORCE,
    compatibility: serverCompatibility(client),
    release: releasePublicConfig({
      release,
      latestClientVersion,
      compatibility: serverCompatibility(client)
    })
  };
}

async function releaseConfigBody(client = {}) {
  const latestClientVersion = await latestClientVersionFromReleaseSource();
  const release = releaseDistributionFromEnv();
  let installers = null;
  try {
    installers = await installerMetadataFromReleaseSource(release);
  } catch {}
  return {
    ok: true,
    serverTime: new Date().toISOString(),
    serverVersion: SERVER_VERSION,
    serverProtocolVersion: SERVER_PROTOCOL_VERSION,
    supportedClientProtocol: SUPPORTED_CLIENT_PROTOCOL,
    latestClientVersion,
    compatibility: serverCompatibility(client),
    release: {
      ...releasePublicConfig({
        release,
        latestClientVersion,
        compatibility: serverCompatibility(client)
      }),
      installers
    }
  };
}

async function releaseLatestBody() {
  const config = releaseConfigFromEnv();
  try {
    validateReleaseConfig(config);
  } catch (error) {
    return { ok: false, code: "release_not_configured", error: error.message, manifest: null };
  }
  let response;
  try {
    response = await fetch(config.manifestUrl, { cache: "no-store" });
  } catch (error) {
    return { ok: false, code: "release_manifest_unavailable", error: error.message, manifest: null };
  }
  if (!response.ok) {
    return { ok: false, code: "release_manifest_unavailable", error: `release manifest request failed: ${response.status}`, manifest: null };
  }
  let manifest;
  try {
    manifest = validateReleaseManifest(await response.json(), { publicBaseUrl: config.publicBaseUrl });
  } catch (error) {
    return { ok: false, code: "release_manifest_invalid", error: error.message, manifest: null };
  }
  return { ok: true, manifest };
}

async function tauriUpdateBody() {
  const release = releaseDistributionFromEnv();
  if (release.source === "github") {
    const meta = await fetchGithubRelease(release);
    const latestJson = selectGithubAsset(meta, (name) => name === "latest.json");
    if (!latestJson) return { error: "github release latest.json asset missing" };
    return await fetchReleaseJson(githubAssetTextUrl(latestJson, release), githubHeaders(release, true));
  }
  if (release.source === "static" || release.source === "self-hosted" || release.source === "self_hosted") {
    if (!release.tauriUpdateUrl) return { error: "release update url is not configured" };
    return await fetchReleaseJson(release.tauriUpdateUrl);
  }
  const latestResult = await releaseLatestBody();
  if (!latestResult.ok || !latestResult.manifest) return { error: latestResult.error || "manifest unavailable" };
  const manifest = latestResult.manifest;
  const artifacts = [];
  for (const [platform, artifact] of Object.entries(manifest.platforms)) {
    artifacts.push({
      platform,
      signature: artifact.signature || "",
      url: artifact.url
    });
  }
  return buildTauriUpdateJson({
    version: manifest.version,
    publicBaseUrl: releaseConfigFromEnv().publicBaseUrl,
    artifacts,
    pubDate: manifest.generatedAt || new Date().toISOString(),
    notes: manifest.releaseNotesUrl || ""
  });
}

async function installerMetadataFromReleaseSource(release) {
  if (release.source === "github") {
    const meta = await fetchGithubRelease(release);
    const installerMeta = buildInstallerMetadataFromGithubRelease(meta);
    return validateInstallerMetadata(installerMeta, { requiredPlatforms: publishedInstallerPlatforms(installerMeta, release.requiredPlatforms) });
  }
  if (release.source === "static" || release.source === "self-hosted" || release.source === "self_hosted") {
    if (!release.installerUrl) return null;
    const meta = await fetchReleaseJson(release.installerUrl);
    return validateInstallerMetadata(meta, { publicBaseUrl: release.publicBaseUrl, requiredPlatforms: publishedInstallerPlatforms(meta, release.requiredPlatforms) });
  }
  const config = releaseConfigFromEnv();
  validateReleaseConfig(config);
  const installerUrl = `${config.publicBaseUrl}/${config.releasePath}/installer.json`;
  const meta = await fetchReleaseJson(installerUrl);
  return validateInstallerMetadata(meta, { publicBaseUrl: config.publicBaseUrl, requiredPlatforms: publishedInstallerPlatforms(meta, config.requiredPlatforms) });
}

function publishedInstallerPlatforms(metadata, fallbackPlatforms) {
  const platforms = installerMetadataPlatforms(metadata);
  return platforms.length ? platforms : fallbackPlatforms;
}

async function fetchGithubRelease(release) {
  const url = githubReleaseApiUrl({
    repository: release.githubRepository,
    tag: release.githubTag,
    apiBaseUrl: release.githubApiBaseUrl
  });
  return fetchReleaseJson(url, githubHeaders(release));
}

function githubHeaders(release, octetStream = false) {
  const headers = {
    accept: octetStream ? "application/octet-stream" : "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "ai-token-league-release-service"
  };
  if (release.githubToken) headers.authorization = `Bearer ${release.githubToken}`;
  return headers;
}

function githubAssetTextUrl(asset, release) {
  return release.githubToken && asset.url ? asset.url : asset.browser_download_url;
}

async function fetchReleaseJson(url, headers = {}) {
  const response = await fetch(url, { cache: "no-store", headers });
  if (!response.ok) throw new Error(`release request failed: ${response.status}`);
  return response.json();
}

function serveStatic(req, res) {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const requested = pathname === "/" ? "/web/download.html" : pathname;
  if (requested === "/admin.html" && !checkBasicAuth(req, res)) return;
  if (requested === "/leaderboard.html" && !checkBoardAuth(req, res)) return;
  if (requested === "/CHANGELOG.md" || requested === "/CHANGELOG.zh-CN.md") {
    const rootDir = path.dirname(SRC_DIR);
    const file = path.resolve(rootDir, requested.slice(1));
    if (!file.startsWith(rootDir) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const normalized = requested.startsWith("/web/") || requested.startsWith("/shared/")
    ? requested
    : `/web${requested}`;
  const file = path.resolve(SRC_DIR, `.${normalized}`);
  if (!file.startsWith(SRC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const ext = path.extname(file);
  const type = {
    ".css": "text/css",
    ".html": "text/html",
    ".ico": "image/x-icon",
    ".js": "text/javascript",
    ".png": "image/png"
  }[ext] || "application/octet-stream";
  res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
  fs.createReadStream(file).pipe(res);
}

export function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((error) => sendJson(res, 500, { error: error.message }));
  });
}

export async function createConfiguredStore() {
  const dbType = String(process.env.DB_TYPE || "json").toLowerCase();
  if (dbType === "mysql") {
    const store = await MySqlStore.create();
    await warmOpenRouterPrices(store);
    return store;
  }
  const jsonStore = new Store(process.env.DB_PATH || path.resolve("data/db.json"));
  jsonStore.dbType = "json";
  await warmOpenRouterPrices(jsonStore);
  return jsonStore;
}

async function warmOpenRouterPrices(targetStore) {
  if (String(process.env.OPENROUTER_PRICING_AUTO_REFRESH || "true").toLowerCase() === "false") return;
  const remote = targetStore.db.modelPriceCache?.remote || {};
  if (remote.status === "fresh" && remote.expiresAt && Date.parse(remote.expiresAt) > Date.now()) {
    if ((await targetStore.missingPriceModels()).length) await targetStore.recalculateCosts();
    return;
  }
  await targetStore.refreshOpenRouterPrices({ recalculate: true });
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (req.url.startsWith("/api/")) return handleApi(req, res);
  return serveStatic(req, res);
}

if (process.argv.includes("--smoke")) {
  console.log(JSON.stringify({ ok: true, dbType: store.dbType || "json", dbPath: store.dbPath, webDir: WEB_DIR }, null, 2));
  await store.close?.();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(PORT, HOST, () => {
    console.log(`AI Token League listening on http://${HOST}:${PORT}`);
  });
}
