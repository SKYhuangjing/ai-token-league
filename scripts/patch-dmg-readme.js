#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const distInstaller = path.resolve("dist-installer");
const readmeSrc = path.resolve("assets/mac-install-readme.txt");

if (!fs.existsSync(readmeSrc)) {
  console.warn("mac-install-readme.txt not found, skipping DMG patch");
  process.exit(0);
}

const dmgs = fs.readdirSync(distInstaller).filter((f) => f.endsWith(".dmg") && !f.includes("blockmap"));
if (!dmgs.length) {
  console.warn("No DMG files found in dist-installer/, skipping");
  process.exit(0);
}

for (const dmg of dmgs) {
  const dmgPath = path.join(distInstaller, dmg);
  const tmpRw = dmgPath.replace(".dmg", "-rw.dmg");
  const mountPoint = `/tmp/dmg-mount-${process.pid}-${dmg}`;

  try {
    console.log(`Patching ${dmg}...`);

    // Convert to read-write
    execSync(`hdiutil convert "${dmgPath}" -format UDRW -o "${tmpRw}" -quiet`);

    // Mount read-write
    execSync(`hdiutil attach "${tmpRw}" -mountpoint "${mountPoint}" -nobrowse -quiet`);

    // Copy readme
    fs.copyFileSync(readmeSrc, path.join(mountPoint, "mac-install-readme.txt"));

    // Detach
    execSync(`hdiutil detach "${mountPoint}" -quiet`);

    // Convert back to compressed read-only (UDZO), replacing original
    fs.unlinkSync(dmgPath);
    execSync(`hdiutil convert "${tmpRw}" -format UDZO -o "${dmgPath}" -quiet`);
    fs.unlinkSync(tmpRw);

    console.log(`  Added mac-install-readme.txt`);
  } catch (error) {
    console.error(`  Failed to patch ${dmg}: ${error.message}`);
    try { execSync(`hdiutil detach "${mountPoint}" -quiet`); } catch {}
    // Clean up temp file
    if (fs.existsSync(tmpRw)) fs.unlinkSync(tmpRw);
  }
}
