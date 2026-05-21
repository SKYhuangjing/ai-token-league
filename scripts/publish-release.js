#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { Agent } from "undici";
import {
  buildTauriUpdateJson,
  buildReleaseManifest,
  releaseConfigFromEnv,
  releaseSecretsFromEnv,
  sha256File,
  validateReleaseConfig
} from "../src/shared/update.js";
import { APP_VERSION } from "../src/shared/version.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const publishPart = args.has("--part");
const finalize = args.has("--finalize");
const fullPublish = args.has("--full");
const allowMissingInstallers = args.has("--allow-missing-installers");
const allowMissingPlatforms = args.has("--allow-missing-platforms") || allowMissingInstallers;
const version = argValue("version") || APP_VERSION;
const distDir = path.resolve(argValue("dist") || "dist");
const uploadDispatcher = new Agent({
  headersTimeout: Number(process.env.RELEASE_UPLOAD_HEADERS_TIMEOUT_MS || 20 * 60 * 1000),
  bodyTimeout: Number(process.env.RELEASE_UPLOAD_BODY_TIMEOUT_MS || 20 * 60 * 1000)
});
const envPath = argValue("env");
if (envPath) loadEnvFile(path.resolve(envPath));
let config;
try {
  config = validateReleaseConfig(releaseConfigFromEnv(), { requireOss: true });
} catch (error) {
  if (!envPath) throw new Error(`${error.message} (use --env FILE or set RELEASE_* env vars)`);
  throw error;
}
const secrets = releaseSecretsFromEnv();
if (!dryRun && (!secrets.accessKeyId || !secrets.accessKeySecret || secrets.accessKeyId === "change-me")) {
  throw new Error("missing release OSS credentials (use --env FILE or set RELEASE_* env vars)");
}
const modes = [publishPart, finalize, fullPublish].filter(Boolean).length;
if (modes > 1) throw new Error("use only one publish mode: --part, --finalize, or --full");
if (!modes) {
  throw new Error("missing publish mode: use --part for a platform build, --finalize to merge uploaded parts, or --full when dist/ contains every required platform");
}

// Tauri updater platforms
const UPDATER_PLATFORMS = {
  "darwin-aarch64": { updaterExt: "app.tar.gz", installerExt: "dmg", label: "macOS arm64" },
  "darwin-x64":     { updaterExt: "app.tar.gz", installerExt: "dmg", label: "macOS Intel" },
  "windows-x86_64": { updaterExt: "exe",        installerExt: "exe", label: "Windows x64", updaterPattern: "setup" },
  "linux-x86_64":   { updaterExt: "appimage.tar.gz", installerExt: "AppImage", label: "Linux x64" }
};

// Map release platform names to Tauri updater platform names
const PLATFORM_TO_UPDATER = {
  "darwin-arm64": "darwin-aarch64",
  "darwin-x64": "darwin-x64",
  "win32-x64": "windows-x86_64",
  "linux-x64": "linux-x86_64"
};

const plan = finalize
  ? await buildFinalizePlan()
  : buildPublishPlan(scanDistArtifacts());

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, mode: finalize ? "finalize" : publishPart ? "part" : "full", version, releasePath: config.releasePath, requiredPlatforms: config.requiredPlatforms, uploads: plan.map(({ key, size, last }) => ({ key, size, last: Boolean(last) })) }, null, 2));
  process.exit(0);
}

const early = plan.filter((item) => !item.last);
const lastItems = plan.filter((item) => item.last);
const concurrency = Number(process.env.RELEASE_UPLOAD_CONCURRENCY || 3);
const totalBytes = plan.reduce((sum, item) => sum + (item.size || 0), 0);
const progress = {
  done: 0, completedBytes: 0, activeBytes: new Map(), totalBytes, total: plan.length,
  startTime: Date.now(), lastRenderAt: 0, lastLinePct: -10
};

renderProgress(progress, { force: true });
const results = await poolMap(early, concurrency, async (item) => {
  await putObjectWithRetry(item, progress);
  progress.done += 1;
  progress.completedBytes += item.size || 0;
  progress.activeBytes.delete(item.key);
  renderProgress(progress, { force: true });
});
const failures = results.filter((r) => r.status === "rejected");
if (failures.length) {
  process.stderr.write("\n");
  throw new Error(`${failures.length}/${early.length} uploads failed: ${failures.map((r) => r.reason.message).join("; ")}`);
}

for (const item of lastItems) {
  await putObjectWithRetry(item, progress);
  progress.done += 1;
  progress.completedBytes += item.size || 0;
  progress.activeBytes.delete(item.key);
  renderProgress(progress, { force: true });
}
process.stderr.write("\n");
console.log(`published ${progress.done} artifacts (${formatBytes(totalBytes)}) in ${((Date.now() - progress.startTime) / 1000).toFixed(1)}s`);

function scanDistArtifacts() {
  if (!fs.existsSync(distDir)) throw new Error(`dist directory not found: ${distDir}`);
  const updaterArtifacts = [];
  const installerArtifacts = [];
  const missing = [];

  for (const [releasePlatform, tauriPlatform] of Object.entries(PLATFORM_TO_UPDATER)) {
    const info = UPDATER_PLATFORMS[tauriPlatform];
    const updaterFileName = findArtifactFile(info.updaterExt, releasePlatform, tauriPlatform, info.updaterPattern);
    if (updaterFileName) {
      const file = path.join(distDir, updaterFileName);
      const sigFile = `${file}.sig`;
      updaterArtifacts.push({
        platform: releasePlatform,
        tauriPlatform,
        file,
        fileName: updaterFileName,
        ext: info.updaterExt,
        size: fs.statSync(file).size,
        sha256: sha256File(file),
        signature: fs.existsSync(sigFile) ? fs.readFileSync(sigFile, "utf8").trim() : "",
        key: releaseKey(version, updaterFileName),
        url: releaseUrl(version, updaterFileName)
      });
    } else if (config.requiredPlatforms.includes(releasePlatform)) {
      missing.push(`${distDir}/*.${info.updaterExt} (${info.label})`);
    }

    // On Windows the updater artifact IS the installer — skip duplicate scan
    if (info.updaterExt === info.installerExt && updaterFileName) {
      installerArtifacts.push({
        platform: releasePlatform,
        tauriPlatform,
        file: path.join(distDir, updaterFileName),
        fileName: updaterFileName,
        ext: info.installerExt,
        size: fs.statSync(path.join(distDir, updaterFileName)).size,
        sha256: sha256File(path.join(distDir, updaterFileName)),
        key: releaseKey(version, updaterFileName),
        url: releaseUrl(version, updaterFileName)
      });
    } else {
      const installerFileName = findArtifactFile(info.installerExt, releasePlatform, tauriPlatform);
      if (installerFileName) {
        const file = path.join(distDir, installerFileName);
        installerArtifacts.push({
          platform: releasePlatform,
          tauriPlatform,
          file,
          fileName: installerFileName,
          ext: info.installerExt,
          size: fs.statSync(file).size,
          sha256: sha256File(file),
          key: releaseKey(version, installerFileName),
          url: releaseUrl(version, installerFileName)
        });
      } else if (config.requiredPlatforms.includes(releasePlatform)) {
        missing.push(`${distDir}/*.${info.installerExt} (${info.label})`);
      }
    }
  }

  if (!publishPart && missing.length && !allowMissingPlatforms) {
    throw new Error(`missing release artifacts:\n${missing.map((f) => `- ${f}`).join("\n")}`);
  }
  for (const item of missing) console.warn(`release artifact not found (skipping): ${item}`);
  return { updaterArtifacts, installerArtifacts };
}

function findArtifactFile(ext, releasePlatform, tauriPlatform, pattern) {
  let files = fs.readdirSync(distDir).filter((f) => f.endsWith(`.${ext}`));
  if (pattern) files = files.filter((f) => f.includes(pattern));
  return files.find((fileName) => matchesPlatformFile(fileName, ext, releasePlatform, tauriPlatform));
}

function matchesPlatformFile(fileName, ext, releasePlatform, tauriPlatform) {
  if (ext === "dmg" || ext === "app.tar.gz") {
    return tauriPlatform === "darwin-aarch64"
      ? /(?:arm64|aarch64)/i.test(fileName)
      : /(?:x64|x86_64|intel)/i.test(fileName);
  }
  if (ext === "AppImage" || ext === "appimage.tar.gz") return /(?:amd64|x86_64|linux)/i.test(fileName);
  if (releasePlatform === "win32-x64") return /(?:x64|x86_64|windows|win32|setup|nsis)/i.test(fileName);
  return true;
}

function buildPublishPlan({ updaterArtifacts, installerArtifacts }) {
  if (publishPart) return buildPartPlan({ updaterArtifacts, installerArtifacts });
  const global = buildGlobalMetadata({ updaterArtifacts, installerArtifacts });
  return [
    ...artifactUploadItems(updaterArtifacts, installerArtifacts),
    ...global
  ];
}

function buildPartPlan({ updaterArtifacts, installerArtifacts }) {
  const platforms = new Set([...updaterArtifacts, ...installerArtifacts].map((artifact) => artifact.platform));
  if (!platforms.size) throw new Error(`no release artifacts found in ${distDir}`);
  const items = artifactUploadItems(updaterArtifacts, installerArtifacts);
  let partCount = 0;
  for (const platform of platforms) {
    const updaterArtifact = publicArtifact(updaterArtifacts.find((artifact) => artifact.platform === platform));
    const installerArtifact = publicArtifact(installerArtifacts.find((artifact) => artifact.platform === platform));
    if (!updaterArtifact?.signature || !installerArtifact) {
      const missing = [
        !updaterArtifact ? "updater artifact" : "",
        updaterArtifact && !updaterArtifact.signature ? "updater signature" : "",
        !installerArtifact ? "installer artifact" : ""
      ].filter(Boolean).join(", ");
      console.warn(`release part not written for ${platform}: missing ${missing}`);
      continue;
    }
    const part = {
      schemaVersion: 1,
      version,
      releasePath: config.releasePath,
      generatedAt: new Date().toISOString(),
      platform,
      updaterArtifact,
      installerArtifact
    };
    const body = `${JSON.stringify(part, null, 2)}\n`;
    items.push({
      key: joinKey(config.prefix, config.releasePath, version, "parts", `${platform}.json`),
      body,
      size: Buffer.byteLength(body),
      contentType: "application/json; charset=utf-8"
    });
    partCount += 1;
  }
  if (!partCount) throw new Error(`no complete release parts found in ${distDir}`);
  return items;
}

async function buildFinalizePlan() {
  const parts = [];
  for (const platform of config.requiredPlatforms) {
    const partUrl = `${config.publicBaseUrl}/${config.releasePath}/${version}/parts/${platform}.json`;
    const response = await fetch(partUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`release part missing for ${platform}: ${response.status} ${partUrl}`);
    const part = await response.json();
    validatePart(part, platform);
    parts.push(part);
  }
  const updaterArtifacts = parts.map((part) => part.updaterArtifact);
  const installerArtifacts = parts.map((part) => part.installerArtifact);
  return buildGlobalMetadata({ updaterArtifacts, installerArtifacts });
}

function validatePart(part, platform) {
  if (!part || typeof part !== "object") throw new Error(`release part ${platform} must be an object`);
  if (part.version !== version) throw new Error(`release part ${platform} version mismatch: ${part.version}`);
  if (part.platform !== platform) throw new Error(`release part ${platform} platform mismatch: ${part.platform}`);
  if (part.releasePath && part.releasePath !== config.releasePath) throw new Error(`release part ${platform} path mismatch: ${part.releasePath}`);
  for (const key of ["updaterArtifact", "installerArtifact"]) {
    const artifact = part[key];
    if (!artifact || typeof artifact !== "object") throw new Error(`release part ${platform} missing ${key}`);
    if (artifact.platform !== platform) throw new Error(`release part ${platform} ${key} platform mismatch`);
    if (!artifact.url || !artifact.url.startsWith(`${config.publicBaseUrl}/${config.releasePath}/`)) throw new Error(`release part ${platform} ${key} url is outside release path`);
    if (!/^[a-f0-9]{64}$/i.test(String(artifact.sha256 || ""))) throw new Error(`release part ${platform} ${key} missing checksum`);
  }
  if (!part.updaterArtifact.signature) throw new Error(`release part ${platform} updaterArtifact missing signature`);
}

function buildGlobalMetadata({ updaterArtifacts, installerArtifacts }) {
  const required = new Set(config.requiredPlatforms);
  for (const platform of required) {
    if (!updaterArtifacts.find((artifact) => artifact.platform === platform)) throw new Error(`missing updater artifact for ${platform}`);
    if (!installerArtifacts.find((artifact) => artifact.platform === platform)) throw new Error(`missing installer artifact for ${platform}`);
  }
  const checksumLines = [
    ...dedupeArtifactsByKey([...updaterArtifacts, ...installerArtifacts]).map((a) => `${a.sha256}  ${a.fileName}`)
  ];
  const checksums = `${checksumLines.join("\n")}\n`;
  const installerMeta = { version, generatedAt: new Date().toISOString(), platforms: {} };
  for (const ia of installerArtifacts) {
    installerMeta.platforms[ia.platform] = {
      url: ia.url, fileName: ia.fileName, sha256: ia.sha256, size: ia.size, ext: ia.ext
    };
  }
  const tauriUpdate = buildTauriUpdateJson({
    version,
    publicBaseUrl: config.publicBaseUrl,
    artifacts: updaterArtifacts
  });
  const manifest = buildReleaseManifest({
    version,
    publicBaseUrl: config.publicBaseUrl,
    manifestPath: config.manifestPath,
    artifacts: updaterArtifacts,
    installerArtifacts
  });
  return jsonUploadItems({ checksums, installerMeta, tauriUpdate, manifest });
}

function artifactUploadItems(updaterArtifacts, installerArtifacts) {
  return dedupeUploadItems([
    ...updaterArtifacts.map((a) => ({ key: a.key, file: a.file, size: a.size, contentType: a.ext === "exe" ? "application/octet-stream" : "application/gzip" })),
    ...installerArtifacts.map((a) => ({
      key: a.key, file: a.file, size: a.size,
      contentType: a.ext === "dmg" ? "application/x-apple-diskimage" : "application/octet-stream"
    }))
  ]);
}

function dedupeArtifactsByKey(artifacts) {
  const byKey = new Map();
  for (const artifact of artifacts) {
    const key = artifact.key || artifact.url || `${artifact.platform}:${artifact.fileName}`;
    if (!byKey.has(key)) byKey.set(key, artifact);
  }
  return [...byKey.values()];
}

function dedupeUploadItems(items) {
  const byKey = new Map();
  for (const item of items) {
    if (!byKey.has(item.key)) byKey.set(item.key, item);
  }
  return [...byKey.values()];
}

function jsonUploadItems({ checksums, installerMeta, tauriUpdate, manifest }) {
  const installerJsonText = `${JSON.stringify(installerMeta, null, 2)}\n`;
  const tauriUpdateText = `${JSON.stringify(tauriUpdate, null, 2)}\n`;
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  return [
    { key: joinKey(config.prefix, config.releasePath, version, "checksums.txt"), body: checksums, size: Buffer.byteLength(checksums), contentType: "text/plain; charset=utf-8" },
    { key: joinKey(config.prefix, config.manifestPath), body: manifestText, size: Buffer.byteLength(manifestText), contentType: "application/json; charset=utf-8" },
    { key: joinKey(config.prefix, config.releasePath, version, "latest.json"), body: manifestText, size: Buffer.byteLength(manifestText), contentType: "application/json; charset=utf-8" },
    { key: joinKey(config.prefix, config.releasePath, "installer.json"), body: installerJsonText, size: Buffer.byteLength(installerJsonText), contentType: "application/json; charset=utf-8" },
    { key: joinKey(config.prefix, config.releasePath, version, "installer.json"), body: installerJsonText, size: Buffer.byteLength(installerJsonText), contentType: "application/json; charset=utf-8" },
    { key: joinKey(config.prefix, config.releasePath, "tauri-update.json"), body: tauriUpdateText, size: Buffer.byteLength(tauriUpdateText), contentType: "application/json; charset=utf-8" },
    { key: joinKey(config.prefix, config.releasePath, version, "tauri-update.json"), body: tauriUpdateText, size: Buffer.byteLength(tauriUpdateText), contentType: "application/json; charset=utf-8", last: true }
  ];
}

function publicArtifact(artifact) {
  if (!artifact) return null;
  const { platform, tauriPlatform, fileName, ext, size, sha256, signature, url } = artifact;
  return { platform, tauriPlatform, fileName, ext, size, sha256, signature, url };
}

function releaseKey(releaseVersion, fileName) {
  return joinKey(config.prefix, config.releasePath, releaseVersion, fileName);
}

function releaseUrl(releaseVersion, fileName) {
  return `${config.publicBaseUrl}/${config.releasePath}/${releaseVersion}/${encodeURIComponent(fileName)}`;
}

async function putObjectWithRetry(item, progress) {
  const attempts = Number(process.env.RELEASE_UPLOAD_ATTEMPTS || 3);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      progress?.activeBytes?.set(item.key, 0);
      await putObject(item, progress);
      return;
    } catch (error) {
      progress?.activeBytes?.delete(item.key);
      renderProgress(progress, { force: true });
      lastError = error;
      if (attempt >= attempts) break;
      console.warn(`upload retry ${attempt}/${attempts - 1} for ${item.key}: ${error.message}`);
    }
  }
  throw lastError;
}

async function putObject(item, progress = null) {
  const body = item.file ? uploadStream(item, progress) : Buffer.from(item.body);
  const url = new URL(`https://${config.bucket}.${config.endpoint}/${item.key}`);
  const date = new Date();
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = item.file ? sha256File(item.file) : crypto.createHash("sha256").update(body).digest("hex");
  const headers = {
    host: url.host,
    "content-length": String(item.size || (item.file ? fs.statSync(item.file).size : body.length)),
    "content-type": item.contentType,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${headers[key]}\n`).join("");
  const canonicalRequest = ["PUT", url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/cn-shanghai/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secrets.accessKeySecret}`, dateStamp), "cn-shanghai"), "s3"), "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${secrets.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(url, { method: "PUT", headers: { ...headers, authorization }, body, dispatcher: uploadDispatcher, duplex: item.file ? "half" : undefined });
  if (!response.ok) throw new Error(`OSS upload failed for ${item.key}: ${response.status} ${await response.text()}`);
}

function uploadStream(item, progress) {
  let uploaded = 0;
  return fs.createReadStream(item.file).pipe(new Transform({
    transform(chunk, _encoding, callback) {
      uploaded += chunk.length;
      progress?.activeBytes?.set(item.key, uploaded);
      renderProgress(progress);
      callback(null, chunk);
    }
  }));
}

function hmac(key, text, encoding) {
  return crypto.createHmac("sha256", key).update(text).digest(encoding);
}

function joinKey(...parts) {
  return parts.map((part) => String(part || "").replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!key || Object.hasOwn(process.env, key)) continue;
    process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

async function poolMap(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { status: "rejected", reason: error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function renderProgress(progress, { force = false } = {}) {
  if (!progress) return;
  const { done, completedBytes, activeBytes, totalBytes, startTime, total } = progress;
  const activeTotal = activeBytes ? Array.from(activeBytes.values()).reduce((sum, value) => sum + value, 0) : 0;
  const uploadedBytes = Math.min(totalBytes, completedBytes + activeTotal);
  const pct = totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 0;
  const now = Date.now();
  if (process.stderr.isTTY) {
    if (!force && now - progress.lastRenderAt < 100) return;
    progress.lastRenderAt = now;
  } else {
    const milestonePct = Math.floor(pct / 10) * 10;
    if (!force && milestonePct <= progress.lastLinePct) return;
    progress.lastLinePct = milestonePct;
  }
  const elapsed = (Date.now() - startTime) / 1000;
  const speed = uploadedBytes > 0 && elapsed > 0 ? uploadedBytes / elapsed : 0;
  const eta = speed > 0 ? (totalBytes - uploadedBytes) / speed : 0;
  const barLen = 30;
  const filled = Math.round((pct / 100) * barLen);
  const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
  const line = `\r  ${bar} ${pct.toString().padStart(3)}%  ${formatBytes(uploadedBytes)}/${formatBytes(totalBytes)}  ${done}/${total || "?"} files  ${eta > 0 ? `${Math.ceil(eta)}s left` : "done"}`;
  process.stderr.write(process.stderr.isTTY ? line + " ".repeat(10) : `${line.trim()}\n`);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
