// Remote module distribution (feat/compute-sharing R17): serves the module
// catalog and package files from OSS so desktop clients can install/uninstall
// optional modules without shipping them in the app bundle.
//
//   GET  /api/modules/remote/catalog                    → { catalog: [...] }   (60s cache, unlisted ids omitted)
//   GET  /api/modules/remote/file/:id/:version/:file    → proxied OSS object   (JS MIME + CORS)
//   GET  /api/admin/modules                             → full catalog + listed flag
//   POST /api/admin/modules/listing                     → { id, listed }
//
// Objects are uploaded public-read by scripts/publish-module.js. The backend
// proxies them so clients never need bucket credentials and CORS stays
// uniform. Read URLs prefer RELEASE_PUBLIC_BASE_URL (same base release
// artifacts already use); RELEASE_OSS_ENDPOINT/BUCKET/PREFIX remain a
// fallback for hosts that only set the raw OSS parts.
//
// 上架/下架 follows DB_TYPE via the listings adapter (MySQL table or the JSON
// store). Missing ids stay listed so a fresh publish remains visible until an
// admin takes it down. 下架 hides the plugin from the public catalog (no new
// installs) but keeps serving the package file so already-installed clients
// can still mount. Tests may pass listingsPath to use an isolated sidecar file.

import fs from "node:fs";
import path from "node:path";

const CATALOG_TTL_MS = 60_000;
const FILE_CACHE_MAX = 20;
const MODULE_ID_RE = /^[\w.-]+$/;

export function parseCatalogBody(text) {
  if (!text) return [];
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed.filter((entry) => entry && typeof entry.id === "string" && entry.id);
  if (parsed && Array.isArray(parsed.catalog)) return parsed.catalog.filter((entry) => entry && typeof entry.id === "string" && entry.id);
  return [];
}

export function isModuleListed(listings, id) {
  const record = listings && listings[id];
  return !record || record.listed !== false;
}

// relPath is always under the modules/ tree, e.g. "modules/catalog.json".
// publicBaseUrl already includes the release prefix; OSS parts rebuild the
// virtual-hosted URL with that prefix applied once.
export function moduleObjectUrl(config, relPath) {
  const rel = String(relPath || "").replace(/^\/+/, "");
  if (!rel) return "";
  const publicBaseUrl = String(config?.publicBaseUrl || "").replace(/\/+$/, "");
  if (publicBaseUrl) return `${publicBaseUrl}/${rel}`;
  const endpoint = String(config?.endpoint || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const bucket = String(config?.bucket || "").trim();
  if (!endpoint || !bucket) return "";
  const prefix = String(config?.prefix || "").replace(/^\/+|\/+$/g, "");
  const key = prefix ? `${prefix}/${rel}` : rel;
  return `https://${bucket}.${endpoint}/${key}`;
}

export function formatModuleFetchError(error) {
  const message = error && error.message ? String(error.message) : String(error || "unknown error");
  const cause = error && error.cause;
  const detail = cause && (cause.code || cause.message) ? ` (${cause.code || cause.message})` : "";
  return `module object fetch failed: ${message}${detail}`;
}

function latestById(entries) {
  const map = new Map();
  for (const entry of entries) {
    const prev = map.get(entry.id);
    if (!prev) {
      map.set(entry.id, entry);
      continue;
    }
    const nextStamp = String(entry.publishedAt || "");
    const prevStamp = String(prev.publishedAt || "");
    if (nextStamp > prevStamp || (nextStamp === prevStamp && String(entry.version || "") >= String(prev.version || ""))) {
      map.set(entry.id, entry);
    }
  }
  return [...map.values()];
}

export function createRemoteModules(options = {}) {
  const distribution = {
    publicBaseUrl: options.publicBaseUrl ?? process.env.RELEASE_PUBLIC_BASE_URL ?? "",
    endpoint: options.endpoint ?? process.env.RELEASE_OSS_ENDPOINT ?? "",
    bucket: options.bucket ?? process.env.RELEASE_OSS_BUCKET ?? "",
    prefix: String(options.prefix ?? process.env.RELEASE_OSS_PREFIX ?? "").replace(/\/+$/, ""),
  };
  const localDir = options.localDir || process.env.ATL_LOCAL_MODULES_DIR || "";
  const listingsFile = options.listings ? "" : (options.listingsPath || path.join(process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : "data", "module-listings.json"));
  const catalogCache = { body: null, at: 0 };
  const fileCache = new Map(); // key → { body: Buffer, contentType, at }
  let listings = { version: 1, modules: {} };

  try {
    if (listingsFile) {
      const parsed = JSON.parse(fs.readFileSync(listingsFile, "utf8"));
      if (parsed && parsed.modules && typeof parsed.modules === "object") listings = { version: 1, modules: parsed.modules };
    }
  } catch { /* fresh start: every catalog id stays listed */ }

  function saveListings() {
    if (options.listings) return options.listings.save(listings.modules);
    fs.mkdirSync(path.dirname(listingsFile), { recursive: true });
    fs.writeFileSync(listingsFile, JSON.stringify(listings, null, 2));
    return Promise.resolve();
  }

  async function init() {
    if (!options.listings) return;
    const loaded = await options.listings.load();
    listings = { version: 1, modules: loaded?.modules && typeof loaded.modules === "object" ? loaded.modules : {} };
  }

  async function fetchDistributedObject(relPath) {
    const url = moduleObjectUrl(distribution, relPath);
    if (!url) throw new Error("module distribution not configured (set RELEASE_PUBLIC_BASE_URL or RELEASE_OSS_ENDPOINT/BUCKET)");
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      throw new Error(formatModuleFetchError(error));
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`module object HTTP ${response.status}: ${relPath}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async function readCatalogText(force = false) {
    if (typeof options.fetchCatalogText === "function") {
      return options.fetchCatalogText({ force });
    }
    if (!force && catalogCache.body && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
      return catalogCache.body;
    }
    let body;
    try {
      body = (await fetchDistributedObject("modules/catalog.json"))?.toString("utf8") ?? "[]";
    } catch (error) {
      if (catalogCache.body) return catalogCache.body; // stale fallback
      throw error;
    }
    catalogCache.body = body;
    catalogCache.at = Date.now();
    return body;
  }

  async function readCatalogEntries(force = false) {
    return parseCatalogBody(await readCatalogText(force));
  }

  function publicCatalog(entries) {
    return entries.filter((entry) => isModuleListed(listings.modules, entry.id));
  }

  function adminModules(entries) {
    return latestById(entries).map((entry) => ({
      id: entry.id,
      version: entry.version || "",
      title: entry.title || entry.id,
      desc: entry.desc || "",
      type: entry.type || "",
      publishedAt: entry.publishedAt || "",
      listed: isModuleListed(listings.modules, entry.id),
    }));
  }

  function setListing(id, listed) {
    listings.modules[id] = { listed, updatedAt: new Date().toISOString() };
  }

  // Local override for the running dev server (ATL_LOCAL_MODULES_DIR).
  // Installed versions still request /file/:id/:version/:file; when a matching
  // package sits on disk, that file wins over the OSS object so UI edits show
  // up without a catalog publish. Production leaves the env unset.
  function readLocalPackageFile(id, file) {
    if (!localDir) return null;
    const root = path.resolve(localDir);
    const candidate = path.resolve(root, id, file);
    if (candidate !== path.join(root, id, file)) return null;
    try {
      return fs.readFileSync(candidate);
    } catch {
      return null;
    }
  }

  async function getPackageFile(id, version, file) {
    if (!/^[\w.-]+$/.test(id) || !/^[\w.-]+$/.test(version) || !/^[\w.]+$/.test(file)) {
      throw new Error("invalid module package path");
    }
    const local = readLocalPackageFile(id, file);
    if (local) return local;
    const relPath = `modules/${id}/${version}/${file}`;
    const cacheKey = `${id}/${version}/${file}`;
    const hit = fileCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 300_000) return hit.body;
    const body = await fetchDistributedObject(relPath);
    if (body == null) throw new Error("package file not found");
    fileCache.set(cacheKey, { body, contentType: "application/javascript; charset=utf-8", at: Date.now() });
    if (fileCache.size > FILE_CACHE_MAX) {
      fileCache.delete(fileCache.keys().next().value);
    }
    return body;
  }

  async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text.trim()) return {};
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    try {
      if (req.method === "GET" && p === "/api/admin/modules") {
        const modules = adminModules(await readCatalogEntries(url.searchParams.get("refresh") === "1"));
        sendJson(res, 200, { modules });
        return true;
      }
      if (req.method === "POST" && p === "/api/admin/modules/listing") {
        const body = await readJsonBody(req);
        const id = body && typeof body.id === "string" ? body.id.trim() : "";
        if (!body || !MODULE_ID_RE.test(id) || typeof body.listed !== "boolean") {
          sendJson(res, 400, { error: "invalid_module_listing" });
          return true;
        }
        const entries = await readCatalogEntries(false);
        if (!entries.some((entry) => entry.id === id)) {
          sendJson(res, 404, { error: "module_not_in_catalog" });
          return true;
        }
        setListing(id, body.listed);
        await saveListings();
        sendJson(res, 200, { ok: true, id, listed: body.listed });
        return true;
      }
      if (req.method === "GET" && p === "/api/modules/remote/catalog") {
        const catalog = publicCatalog(await readCatalogEntries(false));
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "no-cache",
        });
        res.end(JSON.stringify({ catalog }));
        return true;
      }
      const fileMatch = /^\/api\/modules\/remote\/file\/([\w.-]+)\/([\w.-]+)\/([\w.]+)$/.exec(p);
      if (req.method === "GET" && fileMatch) {
        const [, id, version, file] = fileMatch;
        const body = await getPackageFile(id, version, file);
        res.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "no-cache",
        });
        res.end(body);
        return true;
      }
      sendJson(res, 404, { error: "not found: " + p });
      return true;
    } catch (error) {
      sendJson(res, 502, { error: error.message });
      return true;
    }
  }

  function sendJson(res, status, obj) {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify(obj));
  }

  return { handle, init, moduleObjectUrl: (relPath) => moduleObjectUrl(distribution, relPath) };
}
