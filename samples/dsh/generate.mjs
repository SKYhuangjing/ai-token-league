#!/usr/bin/env node
// Regenerates the dsh sample session files:
//   raw/session.jsonl       — plain JSONL (persistenceCompression "none" layout)
//   zstd/session.jsonl.zstd — same content framed like a real dsh session
//                             (header in its own zstd frame, one frame per event)
//
// The sample file models a forked/resumed child session:
//   [copied parent history][session/end-seed][this session's own events]
// Everything at or before the end-seed was already counted in the parent
// file and must be skipped by the collector.
//
// Requires Node >= 22.19 / 24 for zlib.zstdCompressSync. Run from anywhere:
//   ~/.nvm/versions/node/v24.2.0/bin/node samples/dsh/generate.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

if (typeof zstdCompressSync !== "function") {
  console.error("zlib.zstdCompressSync is unavailable; use Node >= 22.19 or Node 24.");
  process.exit(1);
}

const root = dirname(fileURLToPath(import.meta.url));
const NOON = Date.parse("2026-06-10T12:00:00.000Z"); // UTC noon keeps day assertions stable
const CREATED = Date.parse("2026-06-10T11:59:00.000Z");

const usage = (inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0, reasoningTokens = 0) =>
  ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens });

const assistant = (seq, model, u, extra = {}) => ({
  type: "assistant/message",
  seq,
  time: NOON,
  data: {
    message: {
      source: { kind: "model", provider: "sample-provider", model },
      content: [{ type: "text", text: "sample assistant text (never read by the collector)" }],
    },
    usage: u,
    ...extra,
  },
});

// Scenario coverage (see samples/dsh/README.md):
//   seed region (skipped, parent history): seq 2 assistant 5000+500
//   counted:  seq 4,5,6 normal assistant (seq5 has cache), seq 7 compaction,
//             seq 9 interrupted-with-usage, seq 13,14 trailing pair
//   skipped:  seq 8 zero usage, seq 10 user message, seq 11/12 packed chunk rows
const lines = [
  JSON.stringify({
    type: "session",
    version: 0,
    id: "session-11111111-2222-3333-4444-555555555555",
    createdAt: CREATED,
    cwd: "/tmp/dsh-sample/project-one",
    delegationDepth: 0,
  }),
  JSON.stringify({ type: "text-chunks", seq: 1, time: NOON, data: { text: ["parent history chunk (never read)"] } }),
  JSON.stringify(assistant(2, "sample-model-a", usage(5000, 500))),
  JSON.stringify({ type: "session/end-seed", seq: 3, time: NOON, data: { reason: "fork" } }),
  JSON.stringify(assistant(4, "sample-model-a", usage(1000, 200))),
  JSON.stringify(assistant(5, "sample-model-a", usage(500, 100, 300, 50))),
  JSON.stringify(assistant(6, "sample-model-b", usage(800, 150, 0, 0, 60))),
  JSON.stringify({
    type: "compaction/summary",
    seq: 7,
    time: NOON,
    data: {
      provider: "sample-provider",
      model: "sample-model-c",
      usage: usage(2000, 300, 1000),
      summary: "sample compaction summary text (never read by the collector)",
    },
  }),
  JSON.stringify(assistant(8, "sample-model-b", usage(0, 0, 0, 0))),
  JSON.stringify(assistant(9, "sample-model-b", usage(700, 90), { interrupted: true })),
  JSON.stringify({
    type: "user/message",
    seq: 10,
    time: NOON,
    data: { message: { content: [{ type: "text", text: "sample user text (never read)" }] } },
  }),
  JSON.stringify({ type: "text-chunks", seq: 11, time: NOON, data: { text: ["packed stream chunk (never read)"] } }),
  JSON.stringify({ type: "reasoning-chunks", seq: 12, time: NOON, data: { text: ["packed reasoning chunk (never read)"] } }),
  JSON.stringify(assistant(13, "sample-model-a", usage(1200, 240, 600))),
  JSON.stringify(assistant(14, "sample-model-b", usage(900, 180))),
];

mkdirSync(join(root, "raw"), { recursive: true });
mkdirSync(join(root, "zstd"), { recursive: true });
writeFileSync(join(root, "raw", "session.jsonl"), lines.map((line) => `${line}\n`).join(""));

// Real dsh layout: the header line is persisted as its own zstd frame and
// every later flush batch appends another independent frame. Here each event
// becomes one frame, which exercises the multi-frame scan path.
const framed = Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(`${line}\n`), { level: 3 })));
writeFileSync(join(root, "zstd", "session.jsonl.zstd"), framed);

const counted = 10310; // 1200+950+950+3300+790+2040+1080
console.log(`raw/session.jsonl: ${lines.length} lines`);
console.log(`zstd/session.jsonl.zstd: ${lines.length} frames, ${framed.length} bytes`);
console.log(`expected counted events: 7, expected totalTokens: ${counted}`);
