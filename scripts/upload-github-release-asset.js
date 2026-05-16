#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repo = argValue("repo") || process.env.GITHUB_REPOSITORY || process.env.RELEASE_GITHUB_REPOSITORY || "SKYhuangjing/ai-token-league";
const releaseId = argValue("release-id") || process.env.RELEASE_GITHUB_RELEASE_ID || "";
const file = path.resolve(argValue("file") || "");
const assetName = argValue("name") || path.basename(file);
const apiBaseUrl = trimSlash(argValue("api-base-url") || process.env.RELEASE_GITHUB_API_BASE_URL || "https://api.github.com");
const token = process.env.GITHUB_TOKEN || process.env.RELEASE_GITHUB_TOKEN || "";
const clobber = process.argv.includes("--clobber");

if (!repo) throw new Error("missing GitHub repository");
if (!releaseId) throw new Error("missing release id");
if (!file || !fs.existsSync(file)) throw new Error(`asset file not found: ${file}`);
if (!assetName) throw new Error("missing asset name");
if (!token) throw new Error("missing GITHUB_TOKEN");

const release = await fetchJson(`${apiBaseUrl}/repos/${repo}/releases/${releaseId}`);
const existing = (release.assets || []).find((asset) => asset.name === assetName);
if (existing) {
  if (!clobber) throw new Error(`release asset already exists: ${assetName}`);
  console.log(`deleting existing asset ${assetName}`);
  await request(`${apiBaseUrl}/repos/${repo}/releases/assets/${existing.id}`, { method: "DELETE" });
}

const uploadBase = String(release.upload_url || "").replace(/\{.*$/, "");
if (!uploadBase) throw new Error(`release ${releaseId} missing upload_url`);
const data = fs.readFileSync(file);
const uploadUrl = `${uploadBase}?name=${encodeURIComponent(assetName)}`;
const uploaded = await fetchJson(uploadUrl, {
  method: "POST",
  headers: {
    "content-type": "application/octet-stream",
    "content-length": String(data.length)
  },
  body: data
});
console.log(`uploaded ${uploaded.name || assetName} to release ${releaseId}`);

async function fetchJson(url, options = {}) {
  const response = await request(url, options);
  return response.json();
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "ai-token-league-release-workflow",
      authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`request failed: ${response.status} ${url}${text ? `\n${text}` : ""}`);
  }
  return response;
}

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

function trimSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}
