import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const assetsDir = path.resolve("assets");
const tauriIconsDir = path.resolve("src-tauri", "icons");
fs.mkdirSync(assetsDir, { recursive: true });
fs.mkdirSync(tauriIconsDir, { recursive: true });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const templatePng = renderIcon({
  size: 32,
  scale: 4,
  template: true
});
const windowsImages = [16, 24, 32, 48, 64].map((size) => ({
  size,
  bytes: renderIcon({ size, scale: 4, template: false })
}));

fs.writeFileSync(path.join(assetsDir, "tray-iconTemplate.png"), templatePng);
fs.writeFileSync(path.join(tauriIconsDir, "tray-iconTemplate.png"), templatePng);
fs.writeFileSync(path.join(assetsDir, "tray-icon.ico"), encodeIco(windowsImages));

function renderIcon({ size, scale, template }) {
  const canvas = createCanvas(size * scale, size * scale);
  const s = scale * (size / 16);

  if (template) {
    drawTokenMark(canvas, s, [0, 0, 0, 255], true);
  } else {
    fillCircle(canvas, 8 * s, 8 * s, 7 * s, [38, 43, 47, 255]);
    strokeCircle(canvas, 8 * s, 8 * s, 6.1 * s, 1.2 * s, [15, 18, 20, 220]);
    drawTokenMark(canvas, s, [198, 230, 218, 255], false);
  }

  return encodePng(downsample(canvas, scale));
}

function drawTokenMark(canvas, s, color, template) {
  drawTrend(canvas, s, color);
  drawBars(canvas, s, color, template);
}

function drawTrend(canvas, s, color) {
  const points = [
    [2.3 * s, 11.1 * s],
    [5.9 * s, 8.0 * s],
    [8.2 * s, 9.2 * s],
    [12.8 * s, 4.0 * s]
  ];
  drawPolyline(canvas, points, 2.8 * s, color);
  fillPolygon(canvas, [
    [10.8 * s, 2.9 * s],
    [14.1 * s, 2.4 * s],
    [13.3 * s, 5.7 * s]
  ], color);
}

function drawBars(canvas, s, color, template) {
  const alpha = template ? color : [color[0], color[1], color[2], 245];
  fillRoundRect(canvas, 5.5 * s, 10.6 * s, 1.9 * s, 2.9 * s, 0.6 * s, alpha);
  fillRoundRect(canvas, 8.3 * s, 9.5 * s, 1.9 * s, 4.0 * s, 0.6 * s, alpha);
  fillRoundRect(canvas, 11.1 * s, 7.9 * s, 1.9 * s, 5.6 * s, 0.6 * s, alpha);
}

function createCanvas(width, height) {
  return {
    width,
    height,
    pixels: new Uint8ClampedArray(width * height * 4)
  };
}

function setPixel(canvas, x, y, rgba) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || px >= canvas.width || py < 0 || py >= canvas.height) return;
  const index = (py * canvas.width + px) * 4;
  const alpha = rgba[3] / 255;
  const inv = 1 - alpha;
  canvas.pixels[index] = Math.round(rgba[0] * alpha + canvas.pixels[index] * inv);
  canvas.pixels[index + 1] = Math.round(rgba[1] * alpha + canvas.pixels[index + 1] * inv);
  canvas.pixels[index + 2] = Math.round(rgba[2] * alpha + canvas.pixels[index + 2] * inv);
  canvas.pixels[index + 3] = Math.round(255 * (alpha + canvas.pixels[index + 3] / 255 * inv));
}

function fillCircle(canvas, cx, cy, radius, rgba) {
  const minX = Math.floor(cx - radius);
  const maxX = Math.ceil(cx + radius);
  const minY = Math.floor(cy - radius);
  const maxY = Math.ceil(cy + radius);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) setPixel(canvas, x, y, rgba);
    }
  }
}

function strokeCircle(canvas, cx, cy, radius, width, rgba) {
  const minX = Math.floor(cx - radius - width);
  const maxX = Math.ceil(cx + radius + width);
  const minY = Math.floor(cy - radius - width);
  const maxY = Math.ceil(cy + radius + width);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (Math.abs(distance - radius) <= width / 2) setPixel(canvas, x, y, rgba);
    }
  }
}

function fillRoundRect(canvas, x, y, width, height, radius, rgba) {
  const minX = Math.floor(x);
  const maxX = Math.ceil(x + width);
  const minY = Math.floor(y);
  const maxY = Math.ceil(y + height);
  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const dx = Math.max(x - px, 0, px - (x + width));
      const dy = Math.max(y - py, 0, py - (y + height));
      if (dx ** 2 + dy ** 2 <= radius ** 2) setPixel(canvas, px, py, rgba);
    }
  }
}

function drawPolyline(canvas, points, width, rgba) {
  for (let i = 0; i < points.length - 1; i += 1) {
    drawLine(canvas, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], width, rgba);
  }
}

function drawLine(canvas, x1, y1, x2, y2, width, rgba) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2);
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    fillCircle(canvas, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width / 2, rgba);
  }
}

function fillPolygon(canvas, points, rgba) {
  const minX = Math.floor(Math.min(...points.map(([x]) => x)));
  const maxX = Math.ceil(Math.max(...points.map(([x]) => x)));
  const minY = Math.floor(Math.min(...points.map(([, y]) => y)));
  const maxY = Math.ceil(Math.max(...points.map(([, y]) => y)));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (insidePolygon(x, y, points)) setPixel(canvas, x, y, rgba);
    }
  }
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersects = yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function downsample(canvas, scale) {
  const width = canvas.width / scale;
  const height = canvas.height / scale;
  const out = createCanvas(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const index = ((y * scale + sy) * canvas.width + (x * scale + sx)) * 4;
          sum[0] += canvas.pixels[index];
          sum[1] += canvas.pixels[index + 1];
          sum[2] += canvas.pixels[index + 2];
          sum[3] += canvas.pixels[index + 3];
        }
      }
      const count = scale * scale;
      const outIndex = (y * width + x) * 4;
      out.pixels[outIndex] = Math.round(sum[0] / count);
      out.pixels[outIndex + 1] = Math.round(sum[1] / count);
      out.pixels[outIndex + 2] = Math.round(sum[2] / count);
      out.pixels[outIndex + 3] = Math.round(sum[3] / count);
    }
  }
  return out;
}

function encodePng(canvas) {
  const raw = Buffer.alloc((canvas.width * 4 + 1) * canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    const rowStart = y * (canvas.width * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < canvas.width * 4; x += 1) {
      raw[rowStart + 1 + x] = canvas.pixels[y * canvas.width * 4 + x];
    }
  }
  return Buffer.concat([
    pngChunk("IHDR", ihdr(canvas.width, canvas.height)),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function ihdr(width, height) {
  const buffer = Buffer.alloc(13);
  buffer.writeUInt32BE(width, 0);
  buffer.writeUInt32BE(height, 4);
  buffer.writeUInt8(8, 8);
  buffer.writeUInt8(6, 9);
  buffer.writeUInt8(0, 10);
  buffer.writeUInt8(0, 11);
  buffer.writeUInt8(0, 12);
  return buffer;
}

function pngChunk(type, data) {
  const signature = type === "IHDR" ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) : Buffer.alloc(0);
  const typeBuffer = Buffer.from(type);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return Buffer.concat([signature, chunk]);
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
  let offset = directorySize;
  images.forEach((image, index) => {
    const entryOffset = headerSize + index * entrySize;
    buffer.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset);
    buffer.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset + 1);
    buffer.writeUInt8(0, entryOffset + 2);
    buffer.writeUInt8(0, entryOffset + 3);
    buffer.writeUInt16LE(1, entryOffset + 4);
    buffer.writeUInt16LE(32, entryOffset + 6);
    buffer.writeUInt32LE(image.bytes.length, entryOffset + 8);
    buffer.writeUInt32LE(offset, entryOffset + 12);
    image.bytes.copy(buffer, offset);
    offset += image.bytes.length;
  });
  return buffer;
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}
