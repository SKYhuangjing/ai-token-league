import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sha256File } from "../src/shared/update.js";

const dist = path.resolve("dist");
if (!fs.existsSync(dist)) {
  console.error("dist directory does not exist");
  process.exit(1);
}

for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const zipName = `${entry.name}.zip`;
  const isMac = entry.name.includes("darwin");
  // macOS: zip contents directly so .app is at root (required by Squirrel.Mac)
  // Others: zip the directory itself
  const result = isMac
    ? spawnSync("zip", ["-qry", path.join(dist, zipName), "."], { cwd: path.join(dist, entry.name), stdio: "inherit" })
    : spawnSync("zip", ["-qry", zipName, entry.name], { cwd: dist, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status);
  console.log(`created dist/${zipName}`);
}

const checksums = fs.readdirSync(dist)
  .filter((name) => name.endsWith(".zip"))
  .sort()
  .map((name) => `${sha256File(path.join(dist, name))}  ${name}`)
  .join("\n");
fs.writeFileSync(path.join(dist, "checksums.txt"), `${checksums}\n`);
console.log("created dist/checksums.txt");
