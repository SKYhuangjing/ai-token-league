#!/usr/bin/env node
// Publish an optional module package to OSS and refresh the remote catalog
// (feat/compute-sharing R17: modules become loadable/unloadable packages).
//
// Usage:
//   node scripts/publish-module.js --module-dir plugins/zhipu-plan --env env.local
//   node scripts/publish-module.js --list --env env.local
//
// OSS layout (under RELEASE_OSS_PREFIX):
//   modules/catalog.json                       — [{ id, version, type, title, desc, entry, sha256, size }]
//   modules/<id>/<version>/manifest.json       — package manifest
//   modules/<id>/<version>/index.js            — ESM entry: export default { mount(el, ctx) }
//
// Objects are uploaded with public-read ACL so clients fetch them unsigned.
// Uses the same RELEASE_OSS_* credentials as the release pipeline (AWS4 PUT).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function loadEnv(file) {
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      let v = m[2];
      if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith("--")) { flags[key] = true; } else { flags[key] = next; i++; }
    }
  }
  return flags;
}

function requireOssConfig() {
  const cfg = {
    endpoint: process.env.RELEASE_OSS_ENDPOINT,
    bucket: process.env.RELEASE_OSS_BUCKET,
    prefix: process.env.RELEASE_OSS_PREFIX,
    accessKeyId: process.env.RELEASE_OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.RELEASE_OSS_ACCESS_KEY_SECRET,
  };
  for (const [k, v] of Object.entries(cfg)) {
    if (!v) throw new Error(`missing OSS config: RELEASE_OSS_${k.toUpperCase()}`);
  }
  if (!cfg.endpoint.startsWith("http")) cfg.endpoint = `https://${cfg.endpoint}`;
  return cfg;
}

function hmac(key, data, encoding) {
  const mac = crypto.createHmac("sha256", key).update(data);
  return encoding ? mac.digest(encoding) : mac.digest();
}

// AWS4-signed PUT (same scheme as scripts/publish-release.js), + public-read ACL.
async function ossPut(oss, key, body, contentType) {
  body = Buffer.from(body, "utf8"); // multibyte-safe body; length header must match bytes
  const url = new URL(`https://${oss.bucket}.${oss.endpoint.replace(/^https?:\/\//, "")}/${key}`);
  const date = new Date();
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash("sha256").update(body).digest("hex");
  const headers = {
    host: url.host,
    "content-length": String(Buffer.byteLength(body)),
    "content-type": contentType,
    "x-amz-acl": "public-read",
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((k) => `${k}:${headers[k]}\n`).join("");
  const canonicalRequest = ["PUT", url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/cn-shanghai/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${oss.accessKeySecret}`, dateStamp), "cn-shanghai"), "s3"), "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${oss.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  for (const [hk, hv] of Object.entries(headers)) {
    for (let i = 0; i < hv.length; i++) {
      if (hv.charCodeAt(i) > 255) throw new Error(`non-byte char in header ${hk} at ${i}: ${JSON.stringify(hv.slice(Math.max(0, i - 10), i + 5))}`);
    }
  }
  const cps = [...url.href].map((c) => (c.codePointAt(0) > 255 ? `U+${c.codePointAt(0).toString(16)}` : null)).filter(Boolean);
  if (cps.length) throw new Error(`URL has non-ASCII at: ${url.href} → ${cps.join(",")}`);
  for (let i = 0; i < authorization.length; i++) {
    if (authorization.charCodeAt(i) > 255) throw new Error(`non-byte in authorization at ${i}: ${JSON.stringify(authorization.slice(Math.max(0, i - 12), i + 6))}`);
  }
  const response = await fetch(url, { method: "PUT", headers: { ...headers, authorization }, body });
  if (!response.ok) throw new Error(`OSS upload failed for ${key}: ${response.status} ${await response.text()}`);
}

async function ossGetText(oss, key) {
  const url = `https://${oss.bucket}.${oss.endpoint.replace(/^https?:\/\//, "")}/${key}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`OSS GET ${key}: ${response.status}`);
  return response.text();
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function main() {
  const argv = process.argv.slice(2);
  for (const arg of argv) {
    if (arg.startsWith("--env=")) loadEnv(arg.slice("--env=".length));
    else if (arg === "--env") loadEnv(argv[argv.indexOf(arg) + 1]);
  }
  const flags = parseArgs(argv.filter((a, i) => !(argv[i - 1] === "--env")));
  const oss = requireOssConfig();
  const catalogKey = `${oss.prefix}/modules/catalog.json`.replace(/\/\+/g, "/");

  if (flags.list) {
    const current = await ossGetText(oss, catalogKey);
    console.log(current || "(catalog 为空)");
    return;
  }

  // --prune-keep id@version,id@version — rewrite catalog.json keeping only
  // the listed entries (cleanup of retired plugin ids / stale versions). The
  // versioned module objects stay on OSS; only the catalog listing changes.
  if (flags["prune-keep"] !== undefined && flags["prune-keep"] !== true) {
    const keep = new Set(String(flags["prune-keep"]).split(",").map((x) => x.trim()).filter(Boolean));
    const current = await ossGetText(oss, catalogKey);
    const parsed = current ? JSON.parse(current) : null;
    const catalog = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.catalog) ? parsed.catalog : []);
    const kept = catalog.filter((e) => keep.has(`${e.id}@${e.version}`));
    const dropped = catalog.filter((e) => !keep.has(`${e.id}@${e.version}`));
    await ossPut(oss, catalogKey, JSON.stringify({ version: 1, catalog: kept }, null, 2), "application/json");
    console.log(`[publish-module] catalog pruned: kept ${kept.length}, dropped ${dropped.length}`);
    for (const e of dropped) console.log(`  dropped ${e.id}@${e.version}`);
    return;
  }
  if (flags["prune-keep"] === true) throw new Error("--prune-keep requires id@version,... list");

  const moduleDir = flags["module-dir"];
  if (!moduleDir) throw new Error("usage: --module-dir <dir> (含 manifest.json + index.js) 或 --list");
  const manifestPath = path.join(moduleDir, "manifest.json");
  const entryPath = path.join(moduleDir, "index.js");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entry = fs.readFileSync(entryPath, "utf8");
  for (const field of ["id", "version", "type", "title", "desc"]) {
    if (!manifest[field]) throw new Error(`manifest missing field: ${field}`);
  }
  if (manifest.entry !== "index.js") throw new Error("entry must be index.js (v1)");

  const entrySha = sha256Hex(entry);
  const baseKey = `${oss.prefix}/modules/${manifest.id}/${manifest.version}`.replace(/\/\+/g, "/");
  await ossPut(oss, `${baseKey}/manifest.json`, JSON.stringify(manifest, null, 2), "application/json; charset=utf-8");
  await ossPut(oss, `${baseKey}/index.js`, entry, "application/javascript; charset=utf-8");

  // merge into catalog (replace same id+version, keep others)
  const catalogRaw = await ossGetText(oss, catalogKey);
  const parsed = catalogRaw ? JSON.parse(catalogRaw) : null;
  const catalog = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.catalog) ? parsed.catalog : []);
  const catalogEntry = {
    id: manifest.id,
    version: manifest.version,
    type: manifest.type,
    title: manifest.title,
    desc: manifest.desc,
    ...(manifest.titleKey ? { titleKey: manifest.titleKey } : {}),
    ...(manifest.descKey ? { descKey: manifest.descKey } : {}),
    ...(Array.isArray(manifest.permissions) ? { permissions: manifest.permissions } : {}),
    entry: `${baseKey}/index.js`,
    sha256: entrySha,
    publishedAt: new Date().toISOString(),
  };
  const idx = catalog.findIndex((c) => c.id === manifest.id && c.version === manifest.version);
  if (idx >= 0) catalog[idx] = catalogEntry; else catalog.push(catalogEntry);
  await ossPut(oss, catalogKey, JSON.stringify({ version: 1, catalog }, null, 2), "application/json; charset=utf-8");

  console.log(`[publish-module] ${manifest.id}@${manifest.version} published`);
  console.log(`  entry : ${baseKey}/index.js (sha256 ${entrySha.slice(0, 16)}…)`);
  console.log(`  catalog: ${catalogKey} (${catalog.length} entries)`);
}

main().catch((error) => {
  console.error(`[publish-module] ${error.message}`);
  process.exit(1);
});
