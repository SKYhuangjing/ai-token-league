import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { APP_VERSION, CLIENT_PROTOCOL_VERSION, SUPPORTED_CLIENT_PROTOCOL, clientPlatform, compareSemver } from "./version.js";

export const RELEASE_PLATFORMS = ["darwin-arm64", "darwin-x64", "win32-x64"];

export function releaseConfigFromEnv(env = process.env) {
  const publicBaseUrl = trimSlash(env.RELEASE_PUBLIC_BASE_URL || "");
  const manifestPath = trimStartSlash(env.RELEASE_MANIFEST_PATH || "releases/latest.json");
  return {
    endpoint: String(env.RELEASE_OSS_ENDPOINT || "").trim(),
    bucket: String(env.RELEASE_OSS_BUCKET || "").trim(),
    prefix: trimSlash(env.RELEASE_OSS_PREFIX || ""),
    publicBaseUrl,
    manifestPath,
    manifestUrl: publicBaseUrl ? `${publicBaseUrl}/${manifestPath}` : ""
  };
}

export function releasePublicConfig({ release = {}, latestClientVersion = APP_VERSION, compatibility = null } = {}) {
  return {
    latestClientVersion,
    manifestUrl: String(release.manifestUrl || "").trim(),
    manifestPath: String(release.manifestPath || "").trim(),
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
  if (release && !release.manifestUrl) {
    return {
      code: "release_not_configured",
      checkedAt,
      client,
      server,
      update: null,
      message: "Release manifest is not configured on the app server"
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
  for (const key of ["publicBaseUrl", "manifestPath"]) {
    if (!config[key]) missing.push(key);
  }
  if (requireOss) {
    for (const key of ["endpoint", "bucket", "prefix"]) {
      if (!config[key]) missing.push(key);
    }
  }
  if (missing.length) throw new Error(`missing release config: ${missing.join(", ")}`);
  return config;
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export async function verifyFileChecksum(file, expectedSha256) {
  const actual = sha256File(file);
  if (actual !== expectedSha256) {
    throw new Error(`checksum mismatch for ${path.basename(file)}: expected ${expectedSha256}, got ${actual}`);
  }
  return { ok: true, sha256: actual };
}

export function buildReleaseManifest({ version, publicBaseUrl, manifestPath, artifacts, channel = "stable", mandatory = false, releaseNotesUrl = "" }) {
  const normalizedArtifacts = {};
  for (const artifact of artifacts) {
    if (!RELEASE_PLATFORMS.includes(artifact.platform)) throw new Error(`unsupported platform: ${artifact.platform}`);
    if (!artifact.sha256) throw new Error(`missing checksum for ${artifact.platform}`);
    normalizedArtifacts[artifact.platform] = {
      platform: artifact.platform,
      fileName: artifact.fileName,
      url: artifact.url,
      sha256: artifact.sha256,
      size: artifact.size,
      mandatory: Boolean(artifact.mandatory ?? mandatory)
    };
  }
  return validateReleaseManifest({
    schemaVersion: 1,
    version,
    channel,
    generatedAt: new Date().toISOString(),
    protocol: {
      client: CLIENT_PROTOCOL_VERSION,
      supportedClient: SUPPORTED_CLIENT_PROTOCOL
    },
    manifestPath,
    releaseNotesUrl,
    platforms: normalizedArtifacts
  }, { publicBaseUrl });
}

export function validateReleaseManifest(manifest, { publicBaseUrl = "" } = {}) {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest must be an object");
  if (!manifest.version) throw new Error("manifest missing version");
  if (!manifest.channel) throw new Error("manifest missing channel");
  if (!manifest.protocol?.supportedClient) throw new Error("manifest missing protocol");
  if (!manifest.platforms || typeof manifest.platforms !== "object") throw new Error("manifest missing platforms");
  for (const [platform, artifact] of Object.entries(manifest.platforms)) {
    if (!RELEASE_PLATFORMS.includes(platform)) throw new Error(`unsupported platform: ${platform}`);
    if (!artifact.url) throw new Error(`artifact ${platform} missing url`);
    if (!artifact.sha256) throw new Error(`artifact ${platform} missing checksum`);
    if (publicBaseUrl && !String(artifact.url).startsWith(publicBaseUrl)) {
      throw new Error(`artifact ${platform} url is outside release public base url`);
    }
  }
  return manifest;
}

export function selectUpdateArtifact(manifest, platform = clientPlatform()) {
  validateReleaseManifest(manifest);
  const artifact = manifest.platforms?.[platform];
  if (!artifact) throw new Error(`release manifest does not support ${platform}`);
  return artifact;
}

export function updateStateFromManifest(manifest, { currentVersion = APP_VERSION, platform = clientPlatform() } = {}) {
  const artifact = selectUpdateArtifact(manifest, platform);
  const comparison = compareSemver(currentVersion, manifest.version);
  return {
    updateAvailable: comparison < 0,
    currentVersion,
    latestVersion: manifest.version,
    platform,
    mandatory: Boolean(artifact.mandatory),
    releaseNotesUrl: manifest.releaseNotesUrl || "",
    artifact
  };
}

function trimSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function trimStartSlash(value) {
  return String(value || "").trim().replace(/^\/+/, "");
}
