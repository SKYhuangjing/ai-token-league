import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { APP_VERSION, CLIENT_PROTOCOL_VERSION, SUPPORTED_CLIENT_PROTOCOL, clientPlatform, compareSemver } from "./version.js";

export const DEFAULT_RELEASE_PATH = "tauri-releases";
export const RELEASE_PLATFORMS = ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"];

export function releaseConfigFromEnv(env = process.env) {
  const publicBaseUrl = trimSlash(env.RELEASE_PUBLIC_BASE_URL || "");
  const releasePath = releasePathFromEnv(env);
  const manifestPath = trimStartSlash(env.RELEASE_MANIFEST_PATH || `${releasePath}/latest.json`);
  return {
    endpoint: String(env.RELEASE_OSS_ENDPOINT || "").trim(),
    bucket: String(env.RELEASE_OSS_BUCKET || "").trim(),
    prefix: trimSlash(env.RELEASE_OSS_PREFIX || ""),
    publicBaseUrl,
    releasePath,
    manifestPath,
    manifestUrl: publicBaseUrl ? `${publicBaseUrl}/${manifestPath}` : "",
    requiredPlatforms: releasePlatformsFromEnv(env)
  };
}

export function releaseDistributionFromEnv(env = process.env) {
  const publicBaseUrl = trimSlash(env.RELEASE_PUBLIC_BASE_URL || "");
  const releasePath = releasePathFromEnv(env);
  const source = String(env.RELEASE_SOURCE || (env.RELEASE_GITHUB_REPOSITORY ? "github" : "static")).trim().toLowerCase();
  const githubRepository = String(env.RELEASE_GITHUB_REPOSITORY || env.GITHUB_RELEASE_REPOSITORY || "SKYhuangjing/ai-token-league").trim();
  const githubApiBaseUrl = trimSlash(env.RELEASE_GITHUB_API_BASE_URL || "https://api.github.com");
  const githubTag = String(env.RELEASE_GITHUB_TAG || "").trim();
  const tauriUpdatePath = trimStartSlash(env.RELEASE_TAURI_UPDATE_PATH || `${releasePath}/tauri-update.json`);
  const installerPath = trimStartSlash(env.RELEASE_INSTALLER_PATH || `${releasePath}/installer.json`);
  return {
    source,
    publicBaseUrl,
    releasePath,
    githubRepository,
    githubApiBaseUrl,
    githubTag,
    githubToken: String(env.RELEASE_GITHUB_TOKEN || env.GITHUB_TOKEN || "").trim(),
    requiredPlatforms: releasePlatformsFromEnv(env),
    tauriUpdatePath,
    installerPath,
    tauriUpdateUrl: env.RELEASE_TAURI_UPDATE_URL
      ? String(env.RELEASE_TAURI_UPDATE_URL).trim()
      : publicBaseUrl ? `${publicBaseUrl}/${tauriUpdatePath}` : "",
    installerUrl: env.RELEASE_INSTALLER_URL
      ? String(env.RELEASE_INSTALLER_URL).trim()
      : publicBaseUrl ? `${publicBaseUrl}/${installerPath}` : ""
  };
}

export function releasePathFromEnv(env = process.env) {
  return trimStartSlash(env.RELEASE_RELEASE_PATH || DEFAULT_RELEASE_PATH);
}

export function releasePlatformsFromEnv(env = process.env) {
  const raw = String(env.RELEASE_REQUIRED_PLATFORMS || "").trim();
  if (!raw) return [...RELEASE_PLATFORMS];
  const platforms = raw.split(",").map((value) => value.trim()).filter(Boolean);
  for (const platform of platforms) {
    if (!RELEASE_PLATFORMS.includes(platform)) throw new Error(`unsupported release platform: ${platform}`);
  }
  return [...new Set(platforms)];
}

export function releasePublicConfig({ release = {}, latestClientVersion = APP_VERSION, compatibility = null } = {}) {
  const result = {
    latestClientVersion,
    publicBaseUrl: String(release.publicBaseUrl || "").trim(),
    compatibility
  };
  const source = String(release.source || "").trim();
  if (source) result.source = source;
  if (source === "github") result.githubRepository = String(release.githubRepository || "").trim();
  return result;
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

export function validateInstallerMetadata(metadata, { publicBaseUrl = "", requiredPlatforms = RELEASE_PLATFORMS } = {}) {
  if (!metadata || typeof metadata !== "object") throw new Error("installer metadata must be an object");
  if (!metadata.platforms || typeof metadata.platforms !== "object") throw new Error("installer metadata missing platforms");
  const platformRequirements = {
    "darwin-arm64": "dmg",
    "darwin-x64": "dmg",
    "win32-x64": "exe",
    "linux-x64": "AppImage"
  };
  const normalized = {};
  for (const platform of requiredPlatforms) {
    const expectedExt = platformRequirements[platform];
    if (!expectedExt) throw new Error(`unsupported installer platform: ${platform}`);
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

const TAURI_PLATFORM_MAP = {
  "darwin-arm64": "darwin-aarch64",
  "darwin-x64": "darwin-x64",
  "win32-x64": "windows-x86_64",
  "linux-x64": "linux-x86_64"
};

export function buildTauriUpdateJson({ version, publicBaseUrl, artifacts, pubDate = new Date().toISOString(), notes = "" }) {
  if (!version) throw new Error("version required");
  if (!publicBaseUrl) throw new Error("publicBaseUrl required");
  if (!artifacts || !artifacts.length) throw new Error("no artifacts");
  const platforms = {};
  for (const artifact of artifacts) {
    const tauriPlatform = TAURI_PLATFORM_MAP[artifact.platform];
    if (!tauriPlatform) continue;
    if (!artifact.signature) throw new Error(`artifact ${artifact.platform} missing minisign signature`);
    platforms[tauriPlatform] = {
      signature: artifact.signature,
      url: artifact.url
    };
  }
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms
  };
}

export const INSTALLER_PLATFORMS = {
  "darwin-arm64": { ext: "dmg", label: "macOS Apple silicon" },
  "darwin-x64": { ext: "dmg", label: "macOS Intel" },
  "win32-x64": { ext: "exe", label: "Windows x64" },
  "linux-x64": { ext: "AppImage", label: "Linux x64" }
};

export function githubReleaseApiUrl({ repository, tag = "", releaseId = "", apiBaseUrl = "https://api.github.com" } = {}) {
  const repo = String(repository || "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error("github repository must be owner/name");
  const base = trimSlash(apiBaseUrl || "https://api.github.com");
  const id = String(releaseId || "").trim();
  const suffix = id ? encodeURIComponent(id) : tag ? `tags/${encodeURIComponent(tag)}` : "latest";
  return `${base}/repos/${repo}/releases/${suffix}`;
}

export function buildInstallerMetadataFromGithubRelease(release, { publicBaseUrl = "" } = {}) {
  if (!release || typeof release !== "object") throw new Error("github release metadata must be an object");
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const platforms = {};
  for (const platform of RELEASE_PLATFORMS) {
    const definition = INSTALLER_PLATFORMS[platform];
    const asset = findGithubInstallerAsset(assets, platform, definition.ext);
    if (!asset) continue;
    const url = githubAssetDownloadUrl(asset);
    if (publicBaseUrl && !url.startsWith(`${trimSlash(publicBaseUrl)}/`)) continue;
    const sha256 = githubAssetDigestSha256(asset);
    if (!sha256) throw new Error(`github release asset ${asset.name} missing sha256 digest`);
    platforms[platform] = {
      url,
      fileName: String(asset.name || ""),
      sha256,
      size: Number(asset.size || 0),
      ext: definition.ext
    };
  }
  return {
    version: String(release.tag_name || release.name || "").replace(/^v/, ""),
    generatedAt: release.published_at || release.created_at || new Date().toISOString(),
    platforms
  };
}

export function selectGithubAsset(release, predicate) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return assets.find((asset) => predicate(String(asset?.name || ""), asset));
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
      signature: artifact.signature || "",
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

function findGithubInstallerAsset(assets, platform, ext) {
  return assets.find((asset) => {
    const name = String(asset?.name || "");
    if (!name.endsWith(`.${ext}`)) return false;
    if (platform === "darwin-arm64") return /(aarch64|arm64)/i.test(name);
    if (platform === "darwin-x64") return /(x64|x86_64|intel)/i.test(name);
    if (platform === "win32-x64") return /(setup|installer)?\.exe$/i.test(name) && /(x64|x86_64|windows|win32)/i.test(name);
    if (platform === "linux-x64") return /(x64|x86_64|amd64|linux)/i.test(name);
    return false;
  });
}

function githubAssetDownloadUrl(asset) {
  return String(asset?.browser_download_url || asset?.url || "").trim();
}

function githubAssetDigestSha256(asset) {
  const digest = String(asset?.digest || "").trim();
  const match = digest.match(/^sha256:([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : "";
}
