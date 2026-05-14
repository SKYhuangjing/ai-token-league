import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Store } from "./store.js";
import { MySqlStore } from "./mysql-store.js";
import { verifyPayload, sha256Hex } from "../shared/crypto.js";
import { assertSnapshot } from "../shared/schema.js";
import { SERVER_PROTOCOL_VERSION, SERVER_VERSION, SUPPORTED_CLIENT_PROTOCOL, compatibilityResult } from "../shared/version.js";
import { releaseConfigFromEnv, releasePublicConfig, validateInstallerMetadata, validateReleaseConfig, validateReleaseManifest } from "../shared/update.js";
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

if (BOARD_SECURITY_LEVEL === "authenticated" && !BOARD_AUTH_USERNAME) {
  console.error("FATAL: BOARD_SECURITY_LEVEL=authenticated requires PUBLIC_BOARD_AUTH_USERNAME to be set");
  process.exit(1);
}

const store = await createConfiguredStore();

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
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
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
      ...store.boardSummary(),
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
  if (req.method === "POST" && req.url === "/api/usage/daily-batch") {
    const body = await readBody(req);
    const compatibility = serverCompatibility(body.client || body);
    if (!compatibility.compatible) return sendJson(res, 426, { error: compatibility.status, compatibility });
    const participant = store.getParticipant(body.participantId);
    if (!participant) return sendJson(res, 404, { error: "participant is not registered" });
    const payload = {
      participantId: body.participantId,
      deviceId: body.deviceId,
      clientGeneratedAt: body.clientGeneratedAt,
      ...(Object.hasOwn(body, "client") ? { client: body.client } : {}),
      ...(Object.hasOwn(body, "snapshot") ? { snapshot: body.snapshot } : {}),
      items: body.items
    };
    if (!verifyPayload(participant.identityPublicKey, payload, body.signature)) {
      return sendJson(res, 401, { error: "invalid signature" });
    }
    if (body.snapshot) {
      try {
        assertSnapshot(body.snapshot, body.items, body.participantId, body.deviceId);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    return sendJson(res, 200, { ...(await store.upsertUsageBatch(payload)), compatibility });
  }
  if (req.method === "POST" && req.url === "/api/admin/recalculate-costs") {
    return sendJson(res, 200, await store.recalculateCosts());
  }
  if (req.method === "POST" && req.url.startsWith("/api/admin/model-prices/refresh-openrouter")) {
    const url = new URL(req.url, "http://localhost");
    return sendJson(res, 200, await store.refreshOpenRouterPrices({ recalculate: includeFlag(url, "recalculate") }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/model-prices")) {
    return sendJson(res, 200, store.listModelPrices());
  }
  if (req.method === "GET" && req.url.startsWith("/api/admin/model-prices")) {
    return sendJson(res, 200, store.listModelPrices());
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
  if (req.method === "GET" && req.url.startsWith("/api/admin/participants/") && !req.url.includes("/trend")) {
    const url = new URL(req.url, "http://localhost");
    const participantId = decodeURIComponent(url.pathname.replace("/api/admin/participants/", ""));
    const detail = store.participantDetail(participantId, {
      period: url.searchParams.get("grain") || "",
      range: url.searchParams.get("range") || "today",
      startDay: url.searchParams.get("start") || "",
      endDay: url.searchParams.get("end") || "",
      includeCost: includeCost(url)
    });
    if (!detail) return sendJson(res, 404, { error: "participant not found" });
    return sendJson(res, 200, detail);
  }
  if (req.method === "DELETE" && req.url.startsWith("/api/admin/participants/")) {
    const participantId = decodeURIComponent(new URL(req.url, "http://localhost").pathname.replace("/api/admin/participants/", ""));
    const result = await store.deleteParticipantData(participantId);
    if (boardAnonymizer) boardAnonymizer.markDirty();
    return sendJson(res, 200, result);
  }
  if (req.method === "DELETE" && req.url === "/api/participant/data") {
    const body = await readBody(req);
    if (!body.participantId || !body.timestamp || !body.signature) {
      return sendJson(res, 400, { error: "participantId, timestamp, and signature are required" });
    }
    const ageMs = Date.now() - new Date(body.timestamp).getTime();
    if (!Number.isFinite(ageMs) || Math.abs(ageMs) > 5 * 60 * 1000) {
      return sendJson(res, 401, { error: "timestamp is too old or invalid" });
    }
    const participant = store.getParticipant(body.participantId);
    if (!participant) return sendJson(res, 200, store.deleteParticipantData(body.participantId));
    const payload = { participantId: body.participantId, timestamp: body.timestamp };
    if (!verifyPayload(participant.identityPublicKey, payload, body.signature)) {
      return sendJson(res, 401, { error: "invalid signature" });
    }
    const result = await store.deleteParticipantData(body.participantId);
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
      items: store.leaderboard({
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
      items: store.publicLeaderboard({
        period,
        range,
        startDay: url.searchParams.get("start") || "",
        endDay: url.searchParams.get("end") || "",
        includeCost: includeCost(url)
      }).map((item) => transformBoardItem(item))
    }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/admin/usage")) {
    const url = new URL(req.url, "http://localhost");
    return sendJson(res, 200, store.adminUsage({
      grain: url.searchParams.get("grain") || "day",
      range: url.searchParams.get("range") || "month",
      startDay: url.searchParams.get("start") || "",
      endDay: url.searchParams.get("end") || "",
      participantId: url.searchParams.get("participantId") || "",
      includeCost: includeCost(url)
    }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/admin/quality")) {
    const url = new URL(req.url, "http://localhost");
    return sendJson(res, 200, store.adminQuality({
      range: url.searchParams.get("range") || "month",
      startDay: url.searchParams.get("start") || "",
      endDay: url.searchParams.get("end") || "",
      participantId: url.searchParams.get("participantId") || ""
    }));
  }
  if (req.method === "GET" && req.url.startsWith("/api/admin/devices")) {
    return sendJson(res, 200, store.adminDevices());
  }
  if (req.method === "GET" && req.url.startsWith("/api/board/participants/") && req.url.includes("/trend")) {
    const url = new URL(req.url, "http://localhost");
    const displayId = decodeURIComponent(url.pathname.replace("/api/board/participants/", "").replace("/trend", ""));
    ensureAnonymizerFresh();
    const realId = BOARD_SECURITY_LEVEL === "anonymous" ? boardAnonymizer?.resolveParticipantId(displayId) || displayId : displayId;
    const detail = store.participantTrend(realId, {
      grain: url.searchParams.get("grain") || "day",
      range: url.searchParams.get("range") || "last30",
      startDay: url.searchParams.get("start") || "",
      endDay: url.searchParams.get("end") || "",
      includeCost: includeCost(url)
    });
    if (!detail) return sendJson(res, 404, { error: "participant not found" });
    return sendJson(res, 200, withBusinessDay(transformTrendResult(detail)));
  }
  if (req.method === "GET" && req.url.startsWith("/api/board/participants/")) {
    const url = new URL(req.url, "http://localhost");
    const displayId = decodeURIComponent(url.pathname.replace("/api/board/participants/", ""));
    ensureAnonymizerFresh();
    const realId = BOARD_SECURITY_LEVEL === "anonymous" ? boardAnonymizer?.resolveParticipantId(displayId) || displayId : displayId;
    const period = url.searchParams.get("period") || "";
    const detail = store.participantDetail(realId, {
      period,
      range: url.searchParams.get("range") || "today",
      startDay: url.searchParams.get("start") || "",
      endDay: url.searchParams.get("end") || "",
      includeCost: includeCost(url)
    });
    if (!detail) return sendJson(res, 404, { error: "participant not found" });
    return sendJson(res, 200, withBusinessDay(transformBoardDetail(detail)));
  }
  if (req.method === "GET" && req.url.startsWith("/api/health")) {
    const url = new URL(req.url, "http://localhost");
    return sendJson(res, 200, healthBody(Object.fromEntries(url.searchParams.entries())));
  }
  if (req.method === "GET" && req.url.startsWith("/api/release/config")) {
    const url = new URL(req.url, "http://localhost");
    return sendJson(res, 200, await releaseConfigBody(Object.fromEntries(url.searchParams.entries())));
  }
  // macOS custom zip updater fetches the signed manifest via this endpoint.
  // Windows uses electron-updater with latest.yml and does not call this.
  if (req.method === "GET" && req.url.startsWith("/api/release/latest")) {
    return sendJson(res, 200, await releaseLatestBody());
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

function healthBody(client = {}) {
  const latestClientVersion = process.env.LATEST_CLIENT_VERSION || SERVER_VERSION;
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
      release: releaseConfigFromEnv(),
      latestClientVersion,
      compatibility: serverCompatibility(client)
    })
  };
}

async function releaseConfigBody(client = {}) {
  const latestClientVersion = process.env.LATEST_CLIENT_VERSION || SERVER_VERSION;
  const config = releaseConfigFromEnv();
  let installers = null;
  try {
    validateReleaseConfig(config);
    const installerUrl = `${config.publicBaseUrl}/releases/installer.json`;
    const response = await fetch(installerUrl, { cache: "no-store" });
    if (response.ok) {
      const meta = await response.json();
      installers = validateInstallerMetadata(meta, { publicBaseUrl: config.publicBaseUrl });
    }
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
        release: config,
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

function serveStatic(req, res) {
  const requested = req.url === "/" ? "/web/download.html" : new URL(req.url, "http://localhost").pathname;
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
    if (targetStore.missingPriceModels().length) await targetStore.recalculateCosts();
    return;
  }
  await targetStore.refreshOpenRouterPrices({ recalculate: true });
}

async function handle(req, res) {
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
