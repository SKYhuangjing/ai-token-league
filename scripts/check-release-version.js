#!/usr/bin/env node
import fs from "node:fs";
import { parseChangelogVersion } from "../src/shared/changelog.js";

const tag = argValue("tag") || process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME || "";
const expectedVersion = argValue("version") || stripTag(tag) || readPackageJson().version;

if (!expectedVersion) throw new Error("missing release version");
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(expectedVersion)) {
  throw new Error(`invalid release version: ${expectedVersion}`);
}
if (tag && tag !== `v${expectedVersion}`) {
  throw new Error(`tag/version mismatch: tag=${tag} version=${expectedVersion}`);
}

const versions = {
  package: readPackageJson().version,
  packageLock: readPackageLockVersion(),
  tauri: readTauriVersion(),
  cargo: readRootCargoVersion()
};

const mismatches = Object.entries(versions)
  .filter(([, version]) => version !== expectedVersion)
  .map(([name, version]) => `${name}=${version}`);

if (mismatches.length) {
  throw new Error(`Version mismatch: tag=${tag || `v${expectedVersion}`} version=${expectedVersion} ${mismatches.join(" ")}`);
}

for (const file of ["CHANGELOG.md", "CHANGELOG.zh-CN.md"]) {
  const parsed = parseChangelogVersion(fs.readFileSync(file, "utf8"), expectedVersion);
  if (!parsed?.sections?.length) {
    throw new Error(`${file} missing public changelog section for ${expectedVersion}`);
  }
}

console.log(`release version ok: tag=${tag || `v${expectedVersion}`} version=${expectedVersion}`);
for (const [name, version] of Object.entries(versions)) {
  console.log(`  ${name}=${version}`);
}

function readPackageJson() {
  return JSON.parse(fs.readFileSync("package.json", "utf8"));
}

function readPackageLockVersion() {
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  return lock.packages?.[""]?.version || lock.version || "";
}

function readTauriVersion() {
  return JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
}

function readRootCargoVersion() {
  const match = fs.readFileSync("Cargo.toml", "utf8").match(/^\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m);
  return match?.[1] || "";
}

function stripTag(value) {
  return String(value || "").trim().replace(/^refs\/tags\//, "").replace(/^v/, "");
}

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}
