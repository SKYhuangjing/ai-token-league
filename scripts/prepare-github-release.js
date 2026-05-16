#!/usr/bin/env node
import fs from "node:fs";

const repo = argValue("repo") || process.env.GITHUB_REPOSITORY || process.env.RELEASE_GITHUB_REPOSITORY || "SKYhuangjing/ai-token-league";
const tag = argValue("tag") || process.env.GITHUB_REF_NAME || "";
const version = argValue("version") || tag.replace(/^v/, "");
const targetCommitish = argValue("target") || process.env.GITHUB_SHA || "";
const apiBaseUrl = trimSlash(argValue("api-base-url") || process.env.RELEASE_GITHUB_API_BASE_URL || "https://api.github.com");
const token = process.env.GITHUB_TOKEN || process.env.RELEASE_GITHUB_TOKEN || "";
const releaseName = argValue("name") || `AI Token League ${version}`;
const releaseBody = argValue("body") || `Automated release for AI Token League ${version}.`;
const allowPublishedOverwrite = process.env.ALLOW_PUBLISHED_RELEASE_OVERWRITE === "true";

if (!repo) throw new Error("missing GitHub repository");
if (!tag) throw new Error("missing release tag");
if (!version) throw new Error("missing release version");
if (!token) throw new Error("missing GITHUB_TOKEN");

const releases = await fetchJson(`${apiBaseUrl}/repos/${repo}/releases?per_page=100`);
const candidates = releases.filter((release) => matchesRelease(release));
const published = candidates.find((release) => !release.draft && release.tag_name === tag);
if (published && !allowPublishedOverwrite) {
  throw new Error(`published release already exists for ${tag}; set ALLOW_PUBLISHED_RELEASE_OVERWRITE=true to replace assets`);
}

const selected = selectRelease(candidates);
for (const stale of candidates) {
  if (selected && stale.id === selected.id) continue;
  if (!stale.draft) continue;
  console.log(`deleting stale draft release ${stale.id} (${stale.name || stale.tag_name || "unnamed"})`);
  await request(`${apiBaseUrl}/repos/${repo}/releases/${stale.id}`, { method: "DELETE" });
}

let release = selected;
if (release) {
  release = await fetchJson(`${apiBaseUrl}/repos/${repo}/releases/${release.id}`);
  console.log(`reusing release ${release.id} (${release.draft ? "draft" : "published"})`);
  for (const asset of release.assets || []) {
    if (!asset?.id) continue;
    console.log(`deleting stale asset ${asset.name}`);
    await request(`${apiBaseUrl}/repos/${repo}/releases/assets/${asset.id}`, { method: "DELETE" });
  }
  release = await fetchJson(`${apiBaseUrl}/repos/${repo}/releases/${release.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: targetCommitish || undefined,
      name: releaseName,
      body: releaseBody,
      draft: true,
      prerelease: false
    })
  });
} else {
  const payload = {
    tag_name: tag,
    target_commitish: targetCommitish || undefined,
    name: releaseName,
    body: releaseBody,
    draft: true,
    prerelease: false
  };
  release = await fetchJson(`${apiBaseUrl}/repos/${repo}/releases`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  console.log(`created draft release ${release.id}`);
}

if (!release?.id) throw new Error(`failed to resolve release id for ${tag}`);
writeOutput("release_id", String(release.id));
writeOutput("release_tag", tag);
console.log(`release_id=${release.id}`);

function matchesRelease(release) {
  if (!release || typeof release !== "object") return false;
  if (release.tag_name === tag) return true;
  return Boolean(release.draft && release.name === releaseName);
}

function selectRelease(candidates) {
  const publishedMatch = candidates.find((release) => !release.draft && release.tag_name === tag);
  if (publishedMatch) return publishedMatch;
  const drafts = candidates
    .filter((release) => release.draft)
    .sort((a, b) => Date.parse(b.created_at || b.updated_at || 0) - Date.parse(a.created_at || a.updated_at || 0));
  return drafts[0] || null;
}

async function fetchJson(url, options = {}) {
  const response = await request(url, options);
  return response.json();
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
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

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

function trimSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}
