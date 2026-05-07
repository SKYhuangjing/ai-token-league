import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { APP_VERSION } from "./version.js";

export function releaseConfigFromEnv(env = process.env) {
  return {
    endpoint: String(env.RELEASE_OSS_ENDPOINT || "").trim(),
    bucket: String(env.RELEASE_OSS_BUCKET || "").trim(),
    prefix: trimSlash(env.RELEASE_OSS_PREFIX || ""),
    publicBaseUrl: trimSlash(env.RELEASE_PUBLIC_BASE_URL || "")
  };
}

export function releasePublicConfig({ release = {}, latestClientVersion = APP_VERSION, compatibility = null } = {}) {
  return {
    latestClientVersion,
    publicBaseUrl: String(release.publicBaseUrl || "").trim(),
    compatibility
  };
}

export function updatePreflightState({ apiBaseUrl = "", release = null, checkedAt = new Date().toISOString(), client = {}, server = null } = {}) {
  if (!String(apiBaseUrl || "").trim()) {
    return {
      code: "cloud_not_configured",
      checkedAt,
      client,
      server,
      update: null,
      message: "Configure Cloud Connection before checking updates"
    };
  }
  if (release && !release.publicBaseUrl) {
    return {
      code: "release_not_configured",
      checkedAt,
      client,
      server,
      update: null,
      message: "Release is not configured on the app server"
    };
  }
  return null;
}

export function releaseSecretsFromEnv(env = process.env) {
  return {
    accessKeyId: String(env.RELEASE_OSS_ACCESS_KEY_ID || "").trim(),
    accessKeySecret: String(env.RELEASE_OSS_ACCESS_KEY_SECRET || "").trim()
  };
}

export function validateReleaseConfig(config, { requireOss = false } = {}) {
  const missing = [];
  if (!config.publicBaseUrl) missing.push("publicBaseUrl");
  if (requireOss) {
    for (const key of ["endpoint", "bucket", "prefix"]) {
      if (!config[key]) missing.push(key);
    }
  }
  if (missing.length) throw new Error(`missing release config: ${missing.join(", ")}`);
  return config;
}

export function validateInstallerMetadata(metadata, { publicBaseUrl = "" } = {}) {
  if (!metadata || typeof metadata !== "object") throw new Error("installer metadata must be an object");
  if (!metadata.platforms || typeof metadata.platforms !== "object") throw new Error("installer metadata missing platforms");
  const platformRequirements = {
    "darwin-arm64": "dmg",
    "darwin-x64": "dmg",
    "win32-x64": "exe"
  };
  const normalized = {};
  for (const [platform, expectedExt] of Object.entries(platformRequirements)) {
    const artifact = metadata.platforms[platform];
    if (!artifact || typeof artifact !== "object") throw new Error(`installer ${platform} missing`);
    const url = String(artifact.url || "").trim();
    const fileName = String(artifact.fileName || "").trim();
    const sha256 = String(artifact.sha256 || "").trim();
    const ext = String(artifact.ext || "").trim();
    const size = Number(artifact.size);
    if (!url) throw new Error(`installer ${platform} missing url`);
    if (!fileName) throw new Error(`installer ${platform} missing fileName`);
    if (fileName !== path.basename(fileName)) throw new Error(`installer ${platform} fileName must be basename`);
    if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error(`installer ${platform} missing checksum`);
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`installer ${platform} missing size`);
    if (ext !== expectedExt) throw new Error(`installer ${platform} invalid ext`);
    if (publicBaseUrl && !url.startsWith(`${trimSlash(publicBaseUrl)}/`)) {
      throw new Error(`installer ${platform} url is outside release public base url`);
    }
    normalized[platform] = { url, fileName, sha256: sha256.toLowerCase(), size, ext };
  }
  for (const platform of Object.keys(metadata.platforms)) {
    if (!Object.hasOwn(platformRequirements, platform)) throw new Error(`unsupported installer platform: ${platform}`);
  }
  return normalized;
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function sha512Base64(file) {
  return crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
}

export function buildLatestYml(version, artifacts) {
  if (!artifacts.length) throw new Error("no artifacts for latest.yml");
  const lines = [
    `version: ${version}`,
    `files:`
  ];
  for (const a of artifacts) {
    lines.push(`  - url: ${a.fileName}`);
    lines.push(`    sha512: ${a.sha512}`);
    lines.push(`    size: ${a.size}`);
  }
  lines.push(`path: ${artifacts[0].fileName}`);
  lines.push(`sha512: ${artifacts[0].sha512}`);
  lines.push(`releaseDate: '${new Date().toISOString()}'`);
  return lines.join("\n") + "\n";
}

export async function verifyFileChecksum(file, expectedSha256) {
  const actual = sha256File(file);
  if (actual !== expectedSha256) {
    throw new Error(`checksum mismatch for ${path.basename(file)}: expected ${expectedSha256}, got ${actual}`);
  }
  return { ok: true, sha256: actual };
}

function trimSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}
