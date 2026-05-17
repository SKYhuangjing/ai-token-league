#!/usr/bin/env node
import fs from "node:fs";
import { parseChangelogVersion } from "../src/shared/changelog.js";

const version = argValue("version") || process.env.RELEASE_VERSION || "";
const changelogPath = argValue("changelog") || "CHANGELOG.md";
const changelogZhPath = argValue("changelog-zh") || "CHANGELOG.zh-CN.md";

if (!version) throw new Error("missing release version");

const changelog = fs.readFileSync(changelogPath, "utf8");
const parsed = parseChangelogVersion(changelog, version);
if (!parsed) throw new Error(`missing changelog section for ${version}`);
if (!parsed.sections.length) throw new Error(`changelog section ${version} has no public Desktop/Web items`);
const parsedZh = fs.existsSync(changelogZhPath)
  ? parseChangelogVersion(fs.readFileSync(changelogZhPath, "utf8"), version)
  : null;

const lines = [
  `AI Token League ${parsed.version}`,
  "",
  `Release date: ${parsed.date}`,
  ""
];

appendChangelog(lines, "English", parsed);
if (parsedZh?.sections?.length) {
  lines.push("---", "");
  appendChangelog(lines, "简体中文", parsedZh);
}

lines.push("---", "");
lines.push("### Artifacts / 发布产物", "");
lines.push("- Desktop installers for macOS, Windows, and Linux.");
lines.push("- Signed Tauri updater packages and merged `latest.json` for in-app updates.");
lines.push("- macOS、Windows 和 Linux 桌面安装包。");
lines.push("- 已签名的 Tauri 更新包，以及用于应用内更新的合并版 `latest.json`。");

process.stdout.write(`${lines.join("\n").trim()}\n`);

function appendChangelog(lines, title, parsed) {
  lines.push(`## ${title}`, "");
  for (const section of parsed.sections) {
    lines.push(`### ${section.heading}`, "");
    for (const item of section.items) {
      lines.push(`- [${item.tag}] ${item.text}`);
    }
    lines.push("");
  }
}

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}
