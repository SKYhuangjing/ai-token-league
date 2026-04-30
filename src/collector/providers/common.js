import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { normalizeTokenNumber } from "../../shared/schema.js";
import { localDay } from "../../shared/date.js";

export function walkFiles(root, matcher, limit = 1000) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length && out.length < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (matcher(full)) out.push(full);
    }
  }
  return out;
}

export function readJsonLines(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function deepFindNumber(value, names) {
  if (!value || typeof value !== "object") return 0;
  let total = 0;
  for (const [key, child] of Object.entries(value)) {
    if (names.includes(key) && typeof child === "number") total += child;
    else if (child && typeof child === "object") total += deepFindNumber(child, names);
  }
  return normalizeTokenNumber(total);
}

export function deepFindString(value, names) {
  if (!value || typeof value !== "object") return "";
  for (const [key, child] of Object.entries(value)) {
    if (names.includes(key) && typeof child === "string") return child;
    if (child && typeof child === "object") {
      const found = deepFindString(child, names);
      if (found) return found;
    }
  }
  return "";
}

export function dayFromRecord(record, fallbackMtime) {
  const raw = deepFindString(record, ["timestamp", "created_at", "createdAt", "time", "date"]);
  const date = raw ? new Date(raw) : new Date(fallbackMtime);
  return localDay(Number.isNaN(date.getTime()) ? new Date() : date);
}

export function sourceMetadata(file, providerId, parserVersion) {
  const stats = fs.statSync(file);
  const rawSourceRef = path.basename(file);
  const sourceFingerprint = crypto
    .createHash("sha256")
    .update([providerId, parserVersion, file, stats.size, Math.round(stats.mtimeMs)].join("|"))
    .digest("hex");
  return {
    rawSourceRef,
    sourceFingerprint,
    parserVersion
  };
}
