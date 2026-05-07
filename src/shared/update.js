import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { APP_VERSION, CLIENT_PROTOCOL_VERSION, SUPPORTED_CLIENT_PROTOCOL, clientPlatform, compareSemver } from "./version.js";

export const RELEASE_PLATFORMS = ["darwin-arm64", "darwin-x64", "win32-x64"];

export const INSTALLER_PLATFORMS = {
  "darwin-arm64": { ext: "dmg", label: "macOS Apple silicon" },
  "darwin-x64": { ext: "dmg", label: "macOS Intel" },
  "win32-x64": { ext: "exe", label: "Windows x64" }
};

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

export function buildReleaseManifest({ version, publicBaseUrl, manifestPath, artifacts, installerArtifacts = [], channel = "stable", mandatory = false, releaseNotesUrl = "" }) {
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
  for (const installer of installerArtifacts) {
    if (!RELEASE_PLATFORMS.includes(installer.platform)) throw new Error(`unsupported installer platform: ${installer.platform}`);
    if (!installer.sha256) throw new Error(`missing checksum for installer ${installer.platform}`);
    if (normalizedArtifacts[installer.platform]) {
      normalizedArtifacts[installer.platform].installer = {
        fileName: installer.fileName,
        url: installer.url,
        sha256: installer.sha256,
        size: installer.size,
        ext: installer.ext || INSTALLER_PLATFORMS[installer.platform]?.ext || ""
      };
    }
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
    if (artifact.installer) {
      if (!artifact.installer.url) throw new Error(`installer ${platform} missing url`);
      if (!artifact.installer.sha256) throw new Error(`installer ${platform} missing checksum`);
      if (publicBaseUrl && !String(artifact.installer.url).startsWith(publicBaseUrl)) {
        throw new Error(`installer ${platform} url is outside release public base url`);
      }
    }
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

export function selectInstallerArtifact(manifest, platform = clientPlatform()) {
  validateReleaseManifest(manifest);
  const platformEntry = manifest.platforms?.[platform];
  if (!platformEntry?.installer) return null;
  return { ...platformEntry.installer, platform };
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
