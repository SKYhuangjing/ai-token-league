#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildTauriUpdateJson, githubReleaseApiUrl, selectGithubAsset } from "../src/shared/update.js";

const repo = argValue("repo") || process.env.RELEASE_GITHUB_REPOSITORY || process.env.GITHUB_REPOSITORY || "SKYhuangjing/ai-token-league";
const tag = argValue("tag") || process.env.GITHUB_REF_NAME || "";
const releaseId = argValue("release-id") || process.env.RELEASE_GITHUB_RELEASE_ID || "";
const apiBaseUrl = argValue("api-base-url") || process.env.RELEASE_GITHUB_API_BASE_URL || "https://api.github.com";
const output = path.resolve(argValue("output") || "latest.json");
const token = process.env.RELEASE_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";

if (!tag && !releaseId) throw new Error("missing release identity (use --release-id <id> or --tag vX.Y.Z)");

const release = await fetchJson(githubReleaseApiUrl({ repository: repo, tag, releaseId, apiBaseUrl }), githubHeaders());
const releaseTag = tag || release.tag_name || "";
const version = releaseVersion({ release, tag: releaseTag });
const downloadTag = stableReleaseTag({ tag: releaseTag, release });
const releasePageUrl = githubReleasePageUrl({ repo, tag: downloadTag, release });
const assetNames = Array.isArray(release.assets) ? release.assets.map((asset) => asset.name).filter(Boolean) : [];
console.log(`release ${release.id || releaseId || releaseTag} assets (${assetNames.length}):`);
for (const name of assetNames) console.log(`  - ${name}`);

const artifacts = [];
for (const definition of updaterDefinitions()) {
  const asset = selectGithubAsset(release, definition.match);
  if (!asset) {
    console.warn(`warning: missing updater asset for ${definition.platform}; skipping updater platform`);
    continue;
  }
  const signatureAsset = selectGithubAsset(release, (name) => name === `${asset.name}.sig`);
  if (!signatureAsset) {
    console.warn(`warning: missing updater signature for ${asset.name}; skipping updater platform`);
    continue;
  }
  let signature = "";
  try {
    signature = (await fetchText(githubAssetApiUrl(signatureAsset), githubHeaders({ assetDownload: true }))).trim();
  } catch (error) {
    console.warn(`warning: failed to fetch updater signature for ${asset.name}: ${error.message}; skipping updater platform`);
    continue;
  }
  artifacts.push({
    platform: definition.platform,
    url: githubAssetStableDownloadUrl({ repo, tag: downloadTag, asset }),
    signature
  });
}
if (!artifacts.length) {
  throw new Error("no signed updater artifacts found");
}

const updateJson = buildTauriUpdateJson({
  version,
  publicBaseUrl: releasePageUrl,
  artifacts,
  pubDate: release.published_at || release.created_at || new Date().toISOString(),
  notes: releasePageUrl
});

fs.writeFileSync(output, `${JSON.stringify(updateJson, null, 2)}\n`);
console.log(`wrote ${output}`);

function updaterDefinitions() {
  return [
    {
      platform: "darwin-arm64",
      match: (name) => name.endsWith(".app.tar.gz") && /(aarch64|arm64)/i.test(name)
    },
    {
      platform: "darwin-x64",
      match: (name) => name.endsWith(".app.tar.gz") && /(x64|x86_64|intel)/i.test(name)
    },
    {
      platform: "win32-x64",
      match: (name) => name.endsWith("-setup.exe") && /(x64|x86_64|windows|win32)/i.test(name)
    },
    {
      platform: "linux-x64",
      match: (name) => name.endsWith(".AppImage") && /(x64|x86_64|amd64|linux)/i.test(name)
    }
  ];
}

function releaseVersion({ release, tag }) {
  const fromTag = String(tag || release?.tag_name || "").trim().replace(/^v/, "");
  if (fromTag && !fromTag.startsWith("untagged-")) return fromTag;
  const fromName = String(release?.name || "").match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  if (fromName) return fromName[0];
  throw new Error("release version could not be resolved from tag or release name");
}

function stableReleaseTag({ tag, release }) {
  const candidates = [tag, release?.tag_name].map((value) => String(value || "").trim());
  const stable = candidates.find((value) => value && !value.startsWith("untagged-"));
  if (stable) return stable;
  console.warn("warning: release has no stable tag; updater artifact urls may be draft-only");
  return candidates.find(Boolean) || "";
}

function githubAssetStableDownloadUrl({ repo, tag, asset }) {
  if (!tag) return String(asset?.browser_download_url || "").trim();
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`;
}

function githubReleasePageUrl({ repo, tag, release }) {
  if (tag) return `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`;
  return String(release?.html_url || `https://github.com/${repo}`).trim();
}

function githubAssetApiUrl(asset) {
  return String(asset?.url || asset?.browser_download_url || "").trim();
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`request failed: ${response.status} ${url}`);
  return response.json();
}

async function fetchText(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`request failed: ${response.status} ${url}`);
  return response.text();
}

function githubHeaders({ assetDownload = false } = {}) {
  const headers = {
    accept: assetDownload ? "application/octet-stream" : "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "ai-token-league-release-workflow"
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}
