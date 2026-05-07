#!/usr/bin/env node

/**
 * bump-version.js — one-command version bump across all project files.
 *
 * Usage: node scripts/bump-version.js <new-version> [--date YYYY-MM-DD]
 *
 * What it updates:
 *   - package.json "version"
 *   - README.md + README.en.md: version number + installer filenames
 *   - CLAUDE.md: baseline version + release date
 *   - AGENTS.md: baseline version + release date
 *   - doc/roadmap.md: mark old version as shipped, add new version header
 *
 * What it does NOT touch (manual / content-dependent):
 *   - CHANGELOG.md / CHANGELOG.zh-CN.md (content requires human judgment)
 *   - tests/ (now uses APP_VERSION constant)
 *   - npm scripts (now auto-read from package.json)
 *   - doc/<version>-baseline.md / doc/<version>-development-tasks.md (create fresh)
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function write(rel, content) {
  fs.writeFileSync(path.join(ROOT, rel), content);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let version = null;
  let date = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && args[i + 1]) {
      date = args[++i];
    } else if (!args[i].startsWith("--")) {
      version = args[i];
    }
  }

  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error("Usage: node scripts/bump-version.js <new-version> [--date YYYY-MM-DD]");
    console.error("  e.g. node scripts/bump-version.js 0.6.0");
    console.error("       node scripts/bump-version.js 0.6.0 --date 2026-06-01");
    process.exit(1);
  }

  if (!date) {
    date = new Date().toISOString().slice(0, 10);
  }

  return { version, date, majorMinor: version.replace(/\.\d+$/, "") };
}

function getOldVersion() {
  const pkg = JSON.parse(read("package.json"));
  return pkg.version;
}

function replaceInFile(rel, replacements) {
  let content = read(rel);
  for (const [old, rep] of replacements) {
    content = content.replaceAll(old, rep);
  }
  write(rel, content);
}

function bump({ version, date, majorMinor }) {
  const oldVersion = getOldVersion();
  const oldMajorMinor = oldVersion.replace(/\.\d+$/, "");
  const changes = [];

  // 1. package.json
  replaceInFile("package.json", [[`"version": "${oldVersion}"`, `"version": "${version}"`]]);
  changes.push("package.json");

  // 2. README.md
  replaceInFile("README.md", [
    [`\`${oldVersion}\``, `\`${version}\``],
    [`${oldVersion}-mac-arm64-installer.dmg`, `${version}-mac-arm64-installer.dmg`],
    [`${oldVersion}-mac-x64-installer.dmg`, `${version}-mac-x64-installer.dmg`],
    [`${oldVersion}-win-x64-installer.exe`, `${version}-win-x64-installer.exe`],
  ]);
  changes.push("README.md");

  // 3. README.en.md
  replaceInFile("README.en.md", [
    [`\`${oldVersion}\``, `\`${version}\``],
    [`${oldVersion}-mac-arm64-installer.dmg`, `${version}-mac-arm64-installer.dmg`],
    [`${oldVersion}-mac-x64-installer.dmg`, `${version}-mac-x64-installer.dmg`],
    [`${oldVersion}-win-x64-installer.exe`, `${version}-win-x64-installer.exe`],
  ]);
  changes.push("README.en.md");

  // 4. CLAUDE.md
  replaceInFile("CLAUDE.md", [
    [`\`${oldMajorMinor}\` (released `, `\`${majorMinor}\` (released `],
  ]);
  // Update the release date in CLAUDE.md
  const claudeContent = read("CLAUDE.md");
  const claudeUpdated = claudeContent.replace(
    /\(released \d{4}-\d{2}-\d{2}\)/,
    `(released ${date})`
  );
  write("CLAUDE.md", claudeUpdated);
  changes.push("CLAUDE.md");

  // 5. AGENTS.md
  replaceInFile("AGENTS.md", [
    [
      `Current implemented baseline: \`${oldMajorMinor}\`, released as \`${oldVersion}\` on \`${oldVersion.replace(/\.\d+$/, "").replace(/^\d+\.\d+/, date.replace(/-\d+$/, "").replace(/-/, "—"))}\``,
      `Current implemented baseline: \`${majorMinor}\`, released as \`${version}\` on \`${date}\``
    ],
  ]);
  // More robust: regex replace the line
  const agentsContent = read("AGENTS.md");
  const agentsUpdated = agentsContent.replace(
    /Current implemented baseline: `\d+\.\d+`, released as `\d+\.\d+\.\d+` on `\d{4}-\d{2}-\d{2}`/,
    `Current implemented baseline: \`${majorMinor}\`, released as \`${version}\` on \`${date}\``
  );
  write("AGENTS.md", agentsUpdated);
  changes.push("AGENTS.md");

  // 6. doc/roadmap.md — add new version "进行中" section if missing
  const roadmapContent = read("doc/roadmap.md");
  let roadmapUpdated = roadmapContent;
  if (!roadmapUpdated.includes(`## ${version}`)) {
    // Insert new "进行中" section before the most recent "已落地" section
    const firstShippedMatch = roadmapUpdated.match(/^## \d+\.\d+\.\d+ 已落地/m);
    if (firstShippedMatch) {
      roadmapUpdated = roadmapUpdated.replace(
        firstShippedMatch[0],
        `## ${version} 进行中\n\n（待补充）\n\n${firstShippedMatch[0]}`
      );
    }
  }
  write("doc/roadmap.md", roadmapUpdated);
  changes.push("doc/roadmap.md");

  // Summary
  console.log(`\nVersion bumped: ${oldVersion} → ${version} (${date})\n`);
  console.log("Updated files:");
  for (const f of changes) {
    console.log(`  ✓ ${f}`);
  }
  console.log("\nManual steps remaining:");
  console.log(`  1. CHANGELOG.md / CHANGELOG.zh-CN.md — add [${version}] section`);
  console.log(`  2. doc/${majorMinor}-baseline.md — create from current product state`);
  console.log(`  3. doc/${majorMinor}-development-tasks.md — create task plan`);
  console.log(`  4. npm install --package-lock-only — sync package-lock.json`);
  console.log(`  5. npm test — verify`);
}

const opts = parseArgs();
bump(opts);
