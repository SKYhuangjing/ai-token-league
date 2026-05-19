import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const source = process.argv[2] || "assets/app-icon-source.png";
const assetsDir = path.resolve("assets");
const webDir = path.resolve("src/web");
const desktopDir = path.resolve("src/desktop");
const tauriIconsDir = path.resolve("src-tauri", "icons");
const iconsetDir = path.join(os.tmpdir(), `ai-token-league-iconset-${Date.now()}`, "app-icon.iconset");

fs.mkdirSync(assetsDir, { recursive: true });
fs.mkdirSync(webDir, { recursive: true });
fs.mkdirSync(desktopDir, { recursive: true });
fs.mkdirSync(tauriIconsDir, { recursive: true });
fs.mkdirSync(iconsetDir, { recursive: true });

const sourcePath = path.resolve(source);
if (!fs.existsSync(sourcePath)) throw new Error(`icon source not found: ${sourcePath}`);

resizePng(sourcePath, path.join(assetsDir, "app-icon.png"), 1024);
resizePng(sourcePath, path.join(webDir, "favicon.png"), 64);
resizePng(sourcePath, path.join(desktopDir, "favicon.png"), 64);

const iconsetEntries = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024]
];
for (const [name, size] of iconsetEntries) resizePng(sourcePath, path.join(iconsetDir, name), size);
execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", path.join(assetsDir, "app-icon.icns")], { stdio: "inherit" });

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoImages = icoSizes.map((size) => {
  const file = path.join(path.dirname(iconsetDir), `ico-${size}.png`);
  resizePng(sourcePath, file, size);
  return { size, bytes: fs.readFileSync(file) };
});
fs.writeFileSync(path.join(assetsDir, "app-icon.ico"), encodeIco(icoImages));

execFileSync("npx", ["tauri", "icon", sourcePath, "--output", tauriIconsDir], { stdio: "inherit" });

fs.rmSync(path.dirname(iconsetDir), { recursive: true, force: true });

function resizePng(input, output, size) {
  execFileSync("sips", ["-s", "format", "png", "-z", String(size), String(size), input, "--out", output], {
    stdio: "ignore"
  });
}

function encodeIco(images) {
  const headerSize = 6;
  const entrySize = 16;
  const directorySize = headerSize + images.length * entrySize;
  const totalSize = directorySize + images.reduce((sum, image) => sum + image.bytes.length, 0);
  const buffer = Buffer.alloc(totalSize);
  buffer.writeUInt16LE(0, 0);
  buffer.writeUInt16LE(1, 2);
  buffer.writeUInt16LE(images.length, 4);

  let imageOffset = directorySize;
  images.forEach((image, index) => {
    const entryOffset = headerSize + index * entrySize;
    buffer.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset);
    buffer.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset + 1);
    buffer.writeUInt8(0, entryOffset + 2);
    buffer.writeUInt8(0, entryOffset + 3);
    buffer.writeUInt16LE(1, entryOffset + 4);
    buffer.writeUInt16LE(32, entryOffset + 6);
    buffer.writeUInt32LE(image.bytes.length, entryOffset + 8);
    buffer.writeUInt32LE(imageOffset, entryOffset + 12);
    image.bytes.copy(buffer, imageOffset);
    imageOffset += image.bytes.length;
  });

  return buffer;
}
