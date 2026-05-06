import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Store } from "./store.js";
import { MySqlStore } from "./mysql-store.js";
import { verifyPayload } from "../shared/crypto.js";
import { SERVER_PROTOCOL_VERSION, SERVER_VERSION, SUPPORTED_CLIENT_PROTOCOL, compatibilityResult } from "../shared/version.js";
import { releaseConfigFromEnv, releasePublicConfig, validateReleaseConfig, validateReleaseManifest } from "../shared/update.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const SRC_DIR = path.resolve("src");
const WEB_DIR = path.resolve("src/web");
const store = await createConfiguredStore();

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function handleApi(req, res) {
  if (req.method === "POST" && req.url === "/api/devices/register") {
    const body = await readBody(req);
    const compatibility = serverCompatibility(body.client || body);
    if (!compatibility.compatible) return sendJson(res, 426, { error: compatibility.status, compatibility });
    return sendJson(res, 200, { ...(await store.registerDevice(body)), compatibility });
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
      items: body.items
    };
    if (!verifyPayload(participant.identityPublicKey, payload, body.signature)) {
      return sendJson(res, 401, { error: "invalid signature" });
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
  if (req.method === "DELETE" && req.url.startsWith("/api/admin/model-prices/")) {
    const model = decodeURIComponent(new URL(req.url, "http://localhost").pathname.replace("/api/admin/model-prices/", ""));
    return sendJson(res, 200, await store.deleteModelPrice(model));
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
  if (req.method === "GET" && req.url.startsWith("/api/public-leaderboard")) {
    const url = new URL(req.url, "http://localhost");
    const period = url.searchParams.get("period") || "";
    const range = url.searchParams.get("range") || "today";
    return sendJson(res, 200, {
      period: period || range,
      items: store.publicLeaderboard({
        period,
        range,
        startDay: url.searchParams.get("start") || "",
        endDay: url.searchParams.get("end") || "",
        includeCost: includeCost(url)
      })
    });
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
  if (req.method === "GET" && req.url.startsWith("/api/participants/") && req.url.includes("/trend")) {
    const url = new URL(req.url, "http://localhost");
    const participantId = decodeURIComponent(url.pathname.replace("/api/participants/", "").replace("/trend", ""));
    const detail = store.participantTrend(participantId, {
      grain: url.searchParams.get("grain") || "day",
      range: url.searchParams.get("range") || "last30",
      startDay: url.searchParams.get("start") || "",
      endDay: url.searchParams.get("end") || "",
      includeCost: includeCost(url)
    });
    if (!detail) return sendJson(res, 404, { error: "participant not found" });
    return sendJson(res, 200, detail);
  }
  if (req.method === "GET" && req.url.startsWith("/api/participants/")) {
    const url = new URL(req.url, "http://localhost");
    const participantId = decodeURIComponent(url.pathname.replace("/api/participants/", ""));
    const period = url.searchParams.get("period") || "";
    const detail = store.participantDetail(participantId, {
      period,
      range: url.searchParams.get("range") || "today",
      startDay: url.searchParams.get("start") || "",
      endDay: url.searchParams.get("end") || "",
      includeCost: includeCost(url)
    });
    if (!detail) return sendJson(res, 404, { error: "participant not found" });
    return sendJson(res, 200, detail);
  }
  if (req.method === "GET" && req.url.startsWith("/api/health")) {
    const url = new URL(req.url, "http://localhost");
    return sendJson(res, 200, healthBody(Object.fromEntries(url.searchParams.entries())));
  }
  if (req.method === "GET" && req.url.startsWith("/api/release/config")) {
    const url = new URL(req.url, "http://localhost");
    return sendJson(res, 200, releaseConfigBody(Object.fromEntries(url.searchParams.entries())));
  }
  if (req.method === "GET" && req.url.startsWith("/api/release/latest")) {
    const url = new URL(req.url, "http://localhost");
    return sendJson(res, 200, await releaseLatestBody(Object.fromEntries(url.searchParams.entries())));
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
    compatibility: serverCompatibility(client),
    release: releasePublicConfig({
      release: releaseConfigFromEnv(),
      latestClientVersion,
      compatibility: serverCompatibility(client)
    })
  };
}

function releaseConfigBody(client = {}) {
  const latestClientVersion = process.env.LATEST_CLIENT_VERSION || SERVER_VERSION;
  return {
    ok: true,
    serverTime: new Date().toISOString(),
    serverVersion: SERVER_VERSION,
    serverProtocolVersion: SERVER_PROTOCOL_VERSION,
    supportedClientProtocol: SUPPORTED_CLIENT_PROTOCOL,
    latestClientVersion,
    compatibility: serverCompatibility(client),
    release: releasePublicConfig({
      release: releaseConfigFromEnv(),
      latestClientVersion,
      compatibility: serverCompatibility(client)
    })
  };
}

async function releaseLatestBody(client = {}) {
  const body = releaseConfigBody(client);
  const config = releaseConfigFromEnv();
  try {
    validateReleaseConfig(config);
  } catch (error) {
    return {
      ...body,
      ok: false,
      code: "release_not_configured",
      error: error.message,
      manifest: null
    };
  }
  let response;
  try {
    response = await fetch(config.manifestUrl, { cache: "no-store" });
  } catch (error) {
    return {
      ...body,
      ok: false,
      code: "release_manifest_unavailable",
      error: error.message,
      manifest: null
    };
  }
  if (!response.ok) {
    return {
      ...body,
      ok: false,
      code: "release_manifest_unavailable",
      error: `release manifest request failed: ${response.status}`,
      manifest: null
    };
  }
  let manifest;
  try {
    manifest = validateReleaseManifest(await response.json(), { publicBaseUrl: config.publicBaseUrl });
  } catch (error) {
    return {
      ...body,
      ok: false,
      code: "release_manifest_invalid",
      error: error.message,
      manifest: null
    };
  }
  return {
    ...body,
    ok: true,
    manifest
  };
}

function serveStatic(req, res) {
  const requested = req.url === "/" ? "/web/index.html" : new URL(req.url, "http://localhost").pathname;
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
  if (remote.status === "fresh" && remote.expiresAt && Date.parse(remote.expiresAt) > Date.now()) return;
  await targetStore.refreshOpenRouterPrices({ recalculate: false });
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
