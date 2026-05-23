#!/usr/bin/env node
// Lightweight HTTP server for E2E tests.
// Serves src/desktop/ as root, with /shared/ proxied to src/shared/.
// Eliminates the need for a symlink.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, extname } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../src/desktop");
const SHARED = resolve(import.meta.dirname, "../../src/shared");
const PORT = parseInt(process.env.PORT || "1421", 10);

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

async function serveFile(res, filePath) {
  try {
    const data = await readFile(filePath);
    const ct = MIME[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": ct });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // /shared/* → src/shared/*
  if (url.pathname.startsWith("/shared/")) {
    return serveFile(res, join(SHARED, url.pathname.slice("/shared/".length)));
  }

  // Everything else → src/desktop/*
  let filePath = join(ROOT, url.pathname);

  // Directory request → index.html
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    // may not exist, serveFile will 404
  }

  return serveFile(res, filePath);
}).listen(PORT, () => {
  console.log(`E2E test server listening on http://localhost:${PORT}`);
});
