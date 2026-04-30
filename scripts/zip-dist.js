import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dist = path.resolve("dist");
if (!fs.existsSync(dist)) {
  console.error("dist directory does not exist");
  process.exit(1);
}

for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const zipName = `${entry.name}.zip`;
  const result = spawnSync("zip", ["-qry", zipName, entry.name], { cwd: dist, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status);
  console.log(`created dist/${zipName}`);
}
