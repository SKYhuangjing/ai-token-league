#!/usr/bin/env node

/**
 * bump-version.js — one-command version bump across all project files.
 *
 * Usage:
 *   node scripts/bump-version.js <new-version> [--date YYYY-MM-DD]
 *   node scripts/bump-version.js --baseline <major.minor> [--date YYYY-MM-DD]
 *   node scripts/bump-version.js <new-version> --baseline <major.minor> [--date YYYY-MM-DD]
 *
 * Modes:
 *   - Version only: bumps client version and installer filenames
 *   - Baseline only: bumps product baseline, does not touch client version or installer filenames
 *   - Both: bumps client version and sets explicit baseline
 *
 * What it updates:
 *   - package.json "version" and/or "productBaseline"
 *   - src-tauri/Cargo.toml: version (version mode only)
 *   - src-tauri/tauri.conf.json: version (version mode only)
 *   - README.md + README.en.md: version number + installer filenames (version mode only)
 *   - CLAUDE.md: product baseline + client version + release date
 *   - AGENTS.md: product baseline + client version + release date
 *   - doc/roadmap.md: add new baseline header (baseline mode only)
 *
 * What it does NOT touch (manual / content-dependent):
 *   - CHANGELOG.md / CHANGELOG.zh-CN.md (content and public-display tags require human judgment)
 *   - tests/ (now uses APP_VERSION constant)
 *   - npm scripts (now auto-read from package.json)
 *   - doc/<baseline>-baseline.md / doc/<baseline>-development-tasks.md (create fresh)
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
  let baseline = null;
  let date = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && args[i + 1]) {
      date = args[++i];
    } else if (args[i] === "--baseline" && args[i + 1]) {
      baseline = args[++i];
    } else if (!args[i].startsWith("--")) {
      version = args[i];
    }
  }

  if (!version && !baseline) {
    console.error("Usage: node scripts/bump-version.js <new-version> [--date YYYY-MM-DD]");
    console.error("       node scripts/bump-version.js --baseline <major.minor> [--date YYYY-MM-DD]");
    console.error("       node scripts/bump-version.js <new-version> --baseline <major.minor> [--date YYYY-MM-DD]");
    console.error("");
    console.error("  e.g. node scripts/bump-version.js 0.6.0");
    console.error("       node scripts/bump-version.js 0.6.1");
    console.error("       node scripts/bump-version.js --baseline 0.7");
    console.error("       node scripts/bump-version.js 0.7.0 --baseline 0.7");
    process.exit(1);
  }

  if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`Invalid version: ${version} (expected semver, e.g. 0.6.0)`);
    process.exit(1);
  }

  if (baseline && !/^\d+\.\d+$/.test(baseline)) {
    console.error(`Invalid baseline: ${baseline} (expected major.minor, e.g. 0.6)`);
    process.exit(1);
  }

  if (!date) {
    date = new Date().toISOString().slice(0, 10);
  }

  return { version, baseline, date };
}

function getOldVersion() {
  const pkg = JSON.parse(read("package.json"));
  return pkg.version;
}

function getOldBaseline() {
  const pkg = JSON.parse(read("package.json"));
  return pkg.productBaseline || pkg.version?.replace(/\.\d+$/, "") || "0.0";
}

function replaceInFile(rel, replacements) {
  let content = read(rel);
  for (const [old, rep] of replacements) {
    content = content.replaceAll(old, rep);
  }
  write(rel, content);
}

function bump({ version, baseline, date }) {
  const oldVersion = getOldVersion();
  const oldBaseline = getOldBaseline();
  const versionChanged = version && version !== oldVersion;
  const baselineChanged = baseline && baseline !== oldBaseline;
  const changes = [];

  // 1. package.json — update version and/or productBaseline
  const pkgContent = read("package.json");
  let pkgUpdated = pkgContent;
  if (versionChanged) {
    pkgUpdated = pkgUpdated.replace(`"version": "${oldVersion}"`, `"version": "${version}"`);
  }
  if (baselineChanged) {
    if (pkgUpdated.includes('"productBaseline"')) {
      pkgUpdated = pkgUpdated.replace(`"productBaseline": "${oldBaseline}"`, `"productBaseline": "${baseline}"`);
    } else {
      pkgUpdated = pkgUpdated.replace(`"version": "${version || oldVersion}",`, `"version": "${version || oldVersion}",\n  "productBaseline": "${baseline}",`);
    }
  }
  if (pkgUpdated !== pkgContent) {
    write("package.json", pkgUpdated);
    changes.push("package.json");
  }

  // 1b. Cargo.toml — update version (Tauri build reads this)
  if (versionChanged) {
    const cargoContent = read("src-tauri/Cargo.toml");
    const cargoUpdated = cargoContent.replace(`version = "${oldVersion}"`, `version = "${version}"`);
    if (cargoUpdated !== cargoContent) {
      write("src-tauri/Cargo.toml", cargoUpdated);
      changes.push("src-tauri/Cargo.toml");
    }
  }

  // 1c. tauri.conf.json — update version (Tauri updater reads this)
  if (versionChanged) {
    const tauriContent = read("src-tauri/tauri.conf.json");
    const tauriUpdated = tauriContent.replace(`"version": "${oldVersion}"`, `"version": "${version}"`);
    if (tauriUpdated !== tauriContent) {
      write("src-tauri/tauri.conf.json", tauriUpdated);
      changes.push("src-tauri/tauri.conf.json");
    }
  }

  // 2. README.md + README.en.md — only if version changed
  if (versionChanged) {
    for (const readme of ["README.md", "README.en.md"]) {
      replaceInFile(readme, [
        [`\`${oldVersion}\``, `\`${version}\``],
        [`${oldVersion}-mac-arm64-installer.dmg`, `${version}-mac-arm64-installer.dmg`],
        [`${oldVersion}-mac-x64-installer.dmg`, `${version}-mac-x64-installer.dmg`],
        [`${oldVersion}-win-x64-installer.exe`, `${version}-win-x64-installer.exe`],
      ]);
      changes.push(readme);
    }
  }

  // 3. CLAUDE.md — update product baseline + client version
  const newBaseline = baseline || oldBaseline;
  const newVersion = version || oldVersion;
  const claudeContent = read("CLAUDE.md");
  const claudeUpdated = claudeContent.replace(
    /- \*\*Product baseline\*\*: `\d+\.\d+` \| \*\*Client version\*\*: `\d+\.\d+\.\d+` \(released (\d{4}-\d{2}-\d{2})\)/,
    (_match, oldDate) => `- **Product baseline**: \`${newBaseline}\` | **Client version**: \`${newVersion}\` (released ${versionChanged ? date : oldDate})`
  );
  if (claudeUpdated !== claudeContent) {
    write("CLAUDE.md", claudeUpdated);
    changes.push("CLAUDE.md");
  }

  // 4. AGENTS.md — update product baseline + client version
  const agentsContent = read("AGENTS.md");
  const agentsUpdated = agentsContent.replace(
    /Current product baseline: `\d+\.\d+`; client version: `\d+\.\d+\.\d+` \(released (\d{4}-\d{2}-\d{2})\)\./,
    (_match, oldDate) => `Current product baseline: \`${newBaseline}\`; client version: \`${newVersion}\` (released ${versionChanged ? date : oldDate}).`
  );
  if (agentsUpdated !== agentsContent) {
    write("AGENTS.md", agentsUpdated);
    changes.push("AGENTS.md");
  }

  // 5. doc/roadmap.md — add new baseline section if baseline changed
  if (baselineChanged) {
    const roadmapContent = read("doc/roadmap.md");
    let roadmapUpdated = roadmapContent;
    if (!roadmapUpdated.includes(`## ${baseline}`)) {
      const firstShippedMatch = roadmapUpdated.match(/^## \d+\.\d+ 已落地/m);
      if (firstShippedMatch) {
        roadmapUpdated = roadmapUpdated.replace(
          firstShippedMatch[0],
          `## ${baseline} 进行中\n\n（待补充）\n\n${firstShippedMatch[0]}`
        );
      }
    }
    if (roadmapUpdated !== roadmapContent) {
      write("doc/roadmap.md", roadmapUpdated);
      changes.push("doc/roadmap.md");
    }
  }

  // Summary
  const mode = versionChanged && baselineChanged ? "version + baseline"
    : versionChanged ? "version"
    : "baseline";
  console.log(`\nBump (${mode}): ${oldVersion} → ${version || oldVersion} | baseline ${oldBaseline} → ${newBaseline} (${date})\n`);
  console.log("Updated files:");
  for (const f of changes) {
    console.log(`  ✓ ${f}`);
  }
  console.log("\nManual steps remaining:");
  if (versionChanged) {
    console.log(`  1. CHANGELOG.md / CHANGELOG.zh-CN.md — add [${version}] section`);
    console.log("     Tag public-download-page items with [Desktop], [Web], or [Desktop, Web]");
  }
  if (baselineChanged) {
    console.log(`  2. doc/${newBaseline}-baseline.md — create from current product state`);
    console.log(`  3. doc/${newBaseline}-development-tasks.md — create task plan`);
  }
  console.log(`  4. npm install --package-lock-only — sync package-lock.json`);
  console.log(`  5. npm test — verify`);
}

const opts = parseArgs();
bump(opts);
