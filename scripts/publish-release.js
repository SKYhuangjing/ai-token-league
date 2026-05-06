#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Agent } from "undici";
import {
  RELEASE_PLATFORMS,
  INSTALLER_PLATFORMS,
  buildReleaseManifest,
  releaseConfigFromEnv,
  releaseSecretsFromEnv,
  sha256File,
  validateReleaseConfig
} from "../src/shared/update.js";
import { APP_VERSION } from "../src/shared/version.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const version = argValue("version") || APP_VERSION;
const distDir = path.resolve(argValue("dist") || "dist");
const uploadDispatcher = new Agent({
  headersTimeout: Number(process.env.RELEASE_UPLOAD_HEADERS_TIMEOUT_MS || 20 * 60 * 1000),
  bodyTimeout: Number(process.env.RELEASE_UPLOAD_BODY_TIMEOUT_MS || 20 * 60 * 1000)
});
loadEnvFile(path.resolve(argValue("env") || "env.local"));
const config = validateReleaseConfig(releaseConfigFromEnv(), { requireOss: true });
const secrets = releaseSecretsFromEnv();
if (!dryRun && (!secrets.accessKeyId || !secrets.accessKeySecret || secrets.accessKeyId === "change-me")) {
  throw new Error("missing release OSS credentials");
}

const artifacts = RELEASE_PLATFORMS.map((platform) => {
  const fileName = `AI Token League-${platform}.zip`;
  const file = path.join(distDir, fileName);
  if (!fs.existsSync(file)) throw new Error(`missing artifact: ${file}`);
  return {
    platform,
    file,
    fileName,
    size: fs.statSync(file).size,
    sha256: sha256File(file),
    key: joinKey(config.prefix, "releases", version, fileName),
    url: `${config.publicBaseUrl}/releases/${version}/${encodeURIComponent(fileName).replaceAll("%20", "%20")}`
  };
});

const installerDir = path.resolve(argValue("installer-dist") || "dist-installer");
const installerArtifacts = [];
for (const platform of RELEASE_PLATFORMS) {
  const installerInfo = INSTALLER_PLATFORMS[platform];
  if (!installerInfo) continue;
  const fileName = buildInstallerFileName(platform, version, installerInfo.ext);
  const file = path.join(installerDir, fileName);
  if (!fs.existsSync(file)) {
    console.warn(`installer artifact not found (skipping): ${file}`);
    continue;
  }
  installerArtifacts.push({
    platform,
    file,
    fileName,
    ext: installerInfo.ext,
    size: fs.statSync(file).size,
    sha256: sha256File(file),
    key: joinKey(config.prefix, "releases", version, fileName),
    url: `${config.publicBaseUrl}/releases/${version}/${encodeURIComponent(fileName).replaceAll("%20", "%20")}`
  });
}

const checksums = artifacts.map((artifact) => `${artifact.sha256}  ${artifact.fileName}`).join("\n") + "\n";
const checksumsKey = joinKey(config.prefix, "releases", version, "checksums.txt");
const manifest = buildReleaseManifest({
  version,
  publicBaseUrl: config.publicBaseUrl,
  manifestPath: config.manifestPath,
  artifacts,
  installerArtifacts,
  releaseNotesUrl: process.env.RELEASE_NOTES_URL || ""
});
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestKey = joinKey(config.prefix, config.manifestPath);

const plan = [
  ...artifacts.map((artifact) => ({ key: artifact.key, file: artifact.file, contentType: "application/zip" })),
  ...installerArtifacts.map((artifact) => ({
    key: artifact.key,
    file: artifact.file,
    contentType: artifact.ext === "dmg" ? "application/x-apple-diskimage" : "application/octet-stream"
  })),
  { key: checksumsKey, body: checksums, contentType: "text/plain; charset=utf-8" },
  { key: manifestKey, body: manifestText, contentType: "application/json; charset=utf-8", last: true }
];

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, version, manifestUrl: config.manifestUrl, uploads: plan.map(({ key, last }) => ({ key, last: Boolean(last) })), manifest }, null, 2));
  process.exit(0);
}

const early = plan.filter((item) => !item.last);
const lastItems = plan.filter((item) => item.last);
const concurrency = Number(process.env.RELEASE_UPLOAD_CONCURRENCY || 3);

const results = await poolMap(early, concurrency, async (item) => {
  await putObjectWithRetry(item);
  console.log(`uploaded oss://${config.bucket}/${item.key}`);
});
const failures = results.filter((r) => r.status === "rejected");
if (failures.length) {
  throw new Error(`${failures.length}/${early.length} uploads failed: ${failures.map((r) => r.reason.message).join("; ")}`);
}

for (const item of lastItems) {
  await putObjectWithRetry(item);
  console.log(`uploaded oss://${config.bucket}/${item.key} (latest manifest)`);
}

async function putObjectWithRetry(item) {
  const attempts = Number(process.env.RELEASE_UPLOAD_ATTEMPTS || 3);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await putObject(item);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      console.warn(`upload retry ${attempt}/${attempts - 1} for ${item.key}: ${error.message}`);
    }
  }
  throw lastError;
}

async function putObject(item) {
  const body = item.file ? fs.readFileSync(item.file) : Buffer.from(item.body);
  const url = new URL(`https://${config.bucket}.${config.endpoint}/${item.key}`);
  const date = new Date();
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash("sha256").update(body).digest("hex");
  const headers = {
    host: url.host,
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
  const response = await fetch(url, { method: "PUT", headers: { ...headers, authorization }, body, dispatcher: uploadDispatcher });
  if (!response.ok) throw new Error(`OSS upload failed for ${item.key}: ${response.status} ${await response.text()}`);
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

function buildInstallerFileName(platform, ver, ext) {
  const names = {
    "darwin-arm64": `AI Token League-${ver}-mac-arm64-installer.${ext}`,
    "darwin-x64": `AI Token League-${ver}-mac-x64-installer.${ext}`,
    "win32-x64": `AI Token League-${ver}-win-x64-installer.${ext}`
  };
  return names[platform] || `AI Token League-${ver}-${platform}-installer.${ext}`;
}
