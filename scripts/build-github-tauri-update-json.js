#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildTauriUpdateJson, githubReleaseApiUrl, selectGithubAsset } from "../src/shared/update.js";

const repo = argValue("repo") || process.env.RELEASE_GITHUB_REPOSITORY || process.env.GITHUB_REPOSITORY || "SKYhuangjing/ai-token-league";
const tag = argValue("tag") || process.env.GITHUB_REF_NAME || "";
const apiBaseUrl = argValue("api-base-url") || process.env.RELEASE_GITHUB_API_BASE_URL || "https://api.github.com";
const output = path.resolve(argValue("output") || "latest.json");
const token = process.env.RELEASE_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";

if (!tag) throw new Error("missing release tag (use --tag vX.Y.Z)");

const release = await fetchJson(githubReleaseApiUrl({ repository: repo, tag, apiBaseUrl }), githubHeaders());
const version = String(release.tag_name || tag).replace(/^v/, "");
const artifacts = [];
for (const definition of updaterDefinitions()) {
  const asset = selectGithubAsset(release, definition.match);
  if (!asset) throw new Error(`missing updater asset for ${definition.platform}`);
  const signatureAsset = selectGithubAsset(release, (name) => name === `${asset.name}.sig`);
  if (!signatureAsset) throw new Error(`missing updater signature for ${asset.name}`);
  artifacts.push({
    platform: definition.platform,
    url: asset.browser_download_url,
    signature: (await fetchText(signatureAsset.browser_download_url, githubHeaders())).trim()
  });
}

const updateJson = buildTauriUpdateJson({
  version,
  publicBaseUrl: release.html_url || `https://github.com/${repo}`,
  artifacts,
  pubDate: release.published_at || release.created_at || new Date().toISOString(),
  notes: release.html_url || ""
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

function githubHeaders() {
  const headers = {
    accept: "application/vnd.github+json",
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
