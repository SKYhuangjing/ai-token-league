#!/usr/bin/env node
// dsh (DeepSeek Harness) reconciliation gate: recomputes day+model token
// totals directly from the local dsh session store and compares them with an
// `atl-collector scan` run against an isolated HOME that symlinks the real
// sessions directory. dsh has no ccusage-style external tool, so the reference
// implementation here is an independent port of dsh's own frame scanner
// (packages/session/session-persistence-jsonl/src/zstd.ts::scanZstdFrames).
//
// Requires Node >= 22.19 / 24 for zlib.zstdDecompressSync. Usage:
//   node scripts/verify-dsh.mjs [--timezone=Asia/Singapore]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Namespace import: on Node < 22.19 the named export does not exist and a
// static named import would throw at module load, bypassing the guard below.
import * as zlibModule from "node:zlib";

const TIMEZONE = process.argv
  .filter((arg) => arg.startsWith("--timezone="))
  .map((arg) => arg.slice("--timezone=".length))[0] || "Asia/Singapore";

const zstdDecompressSync = zlibModule.zstdDecompressSync;

const home = process.env.HOME || "";
const dshHome = (process.env.DSH_HOME || "").trim();
const sessionsRoot = dshHome ? join(dshHome, "sessions") : join(home, ".dsh", "sessions");

const ZSTD_MAGIC = 0xFD2FB528;

// Direct port of dsh scanZstdFrames: pure byte-level structure scan, no
// decompression. Returns complete frame [start, end) ranges; a torn trailing
// frame (crash leftover) is reported and skipped.
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset); offset += 1;
    if ((descriptor & 0x18) !== 0) throw new Error("reserved frame-header bit");
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) throw new Error("reserved block type");
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

function decodeSessionFile(file) {
  const buf = readFileSync(file);
  const text = file.endsWith(".zstd")
    ? (() => {
        const { frames } = scanZstdFrames(buf);
        let out = "";
        for (const { start, end } of frames) {
          out += zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
        }
        return out;
      })()
    : buf.toString("utf8");
  return text.split("\n").filter((line) => line.trim());
}

function localDay(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(ms));
}

function collectSessionFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (files.length >= 5000) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "session.jsonl.zstd" || entry.name === "session.jsonl") files.push(full);
    }
  }
  return files;
}

// Same counting rules as collector-core/src/provider/dsh_local.rs:
// version gate, end-seed dedup, assistant/message + compaction/summary
// usage only, totalTokens = input + output + cacheRead + cacheWrite.
function expectedTotals() {
  const byDayModel = new Map();
  const warnings = [];
  let files = 0;
  for (const file of collectSessionFiles(sessionsRoot)) {
    let lines;
    try {
      lines = decodeSessionFile(file);
    } catch (error) {
      warnings.push(`${file}: ${error.message}`);
      continue;
    }
    files += 1;
    const header = lines.length > 0 ? JSON.parse(lines[0]) : null;
    if (!header || header.type !== "session" || header.version !== 0) {
      warnings.push(`${file}: unsupported or missing session header (collector reports it as provider error)`);
      continue;
    }
    const events = lines.slice(1).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    });
    const seedSeq = Math.max(
      -1,
      ...events
        .filter((e) => e && e.type === "session/end-seed" && Number.isFinite(e.seq))
        .map((e) => e.seq)
    );
    for (const event of events) {
      if (!event || event.seq <= seedSeq) continue;
      let usage;
      let model;
      if (event.type === "assistant/message" && event.data?.usage) {
        usage = event.data.usage;
        model = event.data.message?.source?.model || "";
      } else if (event.type === "compaction/summary" && event.data?.usage) {
        usage = event.data.usage;
        model = event.data.model || "";
      } else {
        continue;
      }
      const total = Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0)
        + Number(usage.cacheReadTokens || 0) + Number(usage.cacheWriteTokens || 0);
      if (total <= 0) continue;
      const key = `${localDay(event.time)}|${model || "unknown"}`;
      byDayModel.set(key, (byDayModel.get(key) || 0) + total);
    }
  }
  return { byDayModel, warnings, files };
}

function parseCollectorScan(stdout) {
  const byDayModel = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d{4}-\d{2}-\d{2})\s+(\S+)\s+(.+?)\s+tokens=(\d+)\s*$/);
    if (!match) continue;
    const [, day, providerId, model, totalRaw] = match;
    if (providerId !== "dsh_local") continue;
    const key = `${day}|${model}`;
    byDayModel.set(key, (byDayModel.get(key) || 0) + Number(totalRaw));
  }
  return byDayModel;
}

function runCollectorScan() {
  const repoRoot = process.cwd();
  const build = spawnSync("cargo", ["build", "-p", "atl-collector"], {
    encoding: "utf8",
    cwd: repoRoot,
    maxBuffer: 1024 * 1024 * 64
  });
  if (build.status !== 0) {
    throw new Error(`cargo build -p atl-collector failed:\n${build.stderr || build.stdout}`);
  }

  const isolateHome = mkdtempSync(join(tmpdir(), "atl-verify-dsh-"));
  try {
    mkdirSync(join(isolateHome, ".dsh"), { recursive: true });
    symlinkSync(sessionsRoot, join(isolateHome, ".dsh", "sessions"));

    const binary = join(repoRoot, "target", "debug", "atl-collector");
    const env = { ...process.env, HOME: isolateHome, TZ: TIMEZONE };
    delete env.DSH_HOME; // force discovery through the isolated ~/.dsh/sessions symlink
    const init = spawnSync(binary, ["init", "--nickname", "verify-dsh"], { encoding: "utf8", env });
    if (init.status !== 0) {
      throw new Error(`atl-collector init failed:\n${init.stderr || init.stdout}`);
    }
    const scan = spawnSync(binary, ["scan"], { encoding: "utf8", env, maxBuffer: 1024 * 1024 * 64 });
    if (scan.status !== 0) {
      throw new Error(`atl-collector scan failed:\n${scan.stderr || scan.stdout}`);
    }
    return parseCollectorScan(scan.stdout);
  } finally {
    rmSync(isolateHome, { recursive: true, force: true });
  }
}

function compare(expected, actual) {
  const keys = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  const mismatches = [];
  for (const key of keys) {
    const expectedTotal = expected.get(key) || 0;
    const actualTotal = actual.get(key) || 0;
    if (expectedTotal !== actualTotal) {
      mismatches.push({ key, actual: actualTotal, expected: expectedTotal, delta: actualTotal - expectedTotal });
    }
  }
  return mismatches;
}

function reportSide(label, map) {
  let total = 0;
  const byModel = new Map();
  for (const [key, value] of map) {
    total += value;
    const model = key.slice(11);
    byModel.set(model, (byModel.get(model) || 0) + value);
  }
  console.log(`${label}: total=${total.toLocaleString("en-US")} across ${map.size} day+model row(s)`);
  for (const [model, value] of [...byModel.entries()].sort()) {
    console.log(`  ${model}: ${value.toLocaleString("en-US")}`);
  }
  return total;
}

function main() {
  if (!existsSync(sessionsRoot)) {
    console.log(`dsh: SKIPPED (no session directory found at ${sessionsRoot})`);
    return;
  }
  if (typeof zstdDecompressSync !== "function") {
    throw new Error(
      `zlib.zstdDecompressSync is unavailable on Node ${process.version}; use Node >= 22.19 or Node 24 (e.g. ~/.nvm/versions/node/v24.2.0/bin/node)`
    );
  }

  const expected = expectedTotals();
  for (const warning of expected.warnings) console.log(`warning: ${warning}`);
  const expectedTotal = reportSide("script scan ", expected.byDayModel);
  if (expected.byDayModel.size === 0) {
    throw new Error(`dsh sessions found (${expected.files} file(s)) but no usage events were counted under timezone ${TIMEZONE}`);
  }

  // One retry absorbs a live-session append that lands between the two reads.
  let actual;
  let mismatches;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    actual = runCollectorScan();
    mismatches = compare(expected.byDayModel, actual);
    if (mismatches.length === 0) break;
    if (attempt === 1) {
      console.log("mismatch on first pass (live session may have grown between reads); retrying once…");
    }
  }

  reportSide("collector scan", actual);
  if (mismatches.length > 0) {
    console.error(`\ndsh mismatch (day|model):`);
    for (const row of mismatches.slice(0, 20)) {
      console.error(`  ${row.key} collector=${row.actual} script=${row.expected} delta=${row.delta}`);
    }
    process.exit(1);
  }
  console.log(`dsh: matched ${expected.byDayModel.size} day+model row(s), total ${expectedTotal.toLocaleString("en-US")} tokens`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
