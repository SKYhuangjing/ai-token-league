#!/usr/bin/env node
import fs from "node:fs";
import { parseChangelogVersion } from "../src/shared/changelog.js";

const version = argValue("version") || process.env.RELEASE_VERSION || "";
const changelogPath = argValue("changelog") || "CHANGELOG.md";

if (!version) throw new Error("missing release version");

const changelog = fs.readFileSync(changelogPath, "utf8");
const parsed = parseChangelogVersion(changelog, version);
if (!parsed) throw new Error(`missing changelog section for ${version}`);
if (!parsed.sections.length) throw new Error(`changelog section ${version} has no public Desktop/Web items`);

const lines = [
  `AI Token League ${parsed.version}`,
  "",
  `Release date: ${parsed.date}`,
  ""
];

for (const section of parsed.sections) {
  lines.push(`### ${section.heading}`, "");
  for (const item of section.items) {
    lines.push(`- [${item.tag}] ${item.text}`);
  }
  lines.push("");
}

lines.push("### Artifacts", "");
lines.push("- Desktop installers for macOS, Windows, and Linux.");
lines.push("- Signed Tauri updater packages and merged `latest.json` for in-app updates.");

process.stdout.write(`${lines.join("\n").trim()}\n`);

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}
