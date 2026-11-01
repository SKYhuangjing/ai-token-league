import { describe, expect, test } from "bun:test";
import {
  parseLedger,
  buildBuckets,
  integrityCheck,
  mapAgent,
  firstRouteId,
  MAGPIE_FALLBACK,
  AGENT_PROVIDER_MAP
} from "../lib/ledger.js";

const PARTICIPANT = "p_fixture0000000000000000";

// Synthetic rows modeled 1:1 on the real gateway ledger's field structure
// (values are fabricated; no real accounts/sessions).
const rows = [
  // zcode borrowing an antigravity model -> zcode_local, provider-prefixed model
  { route_id: 1, t: "2026-10-31T20:00:01+08:00", agent: "zcode", provider: "antigravity", model: "gemini-3.8-flash", req: "antigravity/gemini-3.8-flash", in: 28561, out: 101, cache_read: 0, cache_write: 0, reasoning: 81, ms: 4928, status: 200, response_id: "resp_a1", ep: "/v1/messages", session: "sess-1" },
  // same model, same hour -> must aggregate (sum)
  { route_id: 2, t: "2026-10-31T20:30:00+08:00", agent: "zcode", provider: "antigravity", model: "gemini-3.8-flash", req: "antigravity/gemini-3.8-flash", in: 2064, out: 1164, cache_read: 26522, cache_write: 0, reasoning: 659, ms: 18197, status: 200, response_id: "resp_a2", ep: "/v1/messages", session: "sess-1" },
  // zcode borrowing a codex model -> still zcode_local (client attribution)
  { route_id: 3, t: "2026-10-31T20:45:00+08:00", agent: "zcode", provider: "codex", model: "gpt-6-luna", req: "codex/gpt-6-luna", in: 0, out: 0, cache_read: 0, cache_write: 0, status: 499, err: "canceled", ep: "/v1/messages → /v1/responses", session: "sess-1" },
  // codex CLI with its own subscription -> codex_local
  { route_id: 4, t: "2026-10-31T23:58:38+08:00", agent: "codex", provider: "codex", model: "gpt-5.6-terra", req: "gpt-5.6-terra", in: 9184, out: 209, cache_read: 5376, cache_write: 0, reasoning: 43, status: 200, response_id: "resp_b1", ep: "/backend-api/codex/responses", session: "sess-2", kind: "memory_consolidation" },
  // failed hand-over retries with 0 tokens -> excluded even though route_id repeats
  { route_id: 5, t: "2026-10-31T23:59:07+08:00", agent: "codex", provider: "codex", model: "gpt-5.6-terra", req: "gpt-5.6-terra", in: 0, out: 0, cache_read: 0, cache_write: 0, status: 502, handed_on: true, session: "sess-2" },
  { route_id: 5, t: "2026-10-31T23:59:10+08:00", agent: "codex", provider: "codex", model: "gpt-5.6-terra", req: "gpt-5.6-terra", in: 0, out: 0, cache_read: 0, cache_write: 0, status: 502, handed_on: true, session: "sess-2" },
  // probe rows -> excluded
  { t: "2026-10-31T20:34:30+08:00", agent: "magpie", provider: "codex", host: "chatgpt.com", model: "", in: 0, out: 0, cache_read: 0, cache_write: 0, ms: 5049, status: 200, ep: "GET /backend-api/codex/models", kind: "model_list", source: "probe" },
  // magpie's own chat -> magpie_local
  { route_id: 6, t: "2026-10-31T21:00:00+08:00", agent: "magpie", provider: "zhipu", model: "glm-5.3", req: "zhipu/glm-5.3", in: 1200, out: 300, cache_read: 0, cache_write: 0, status: 200, response_id: "resp_c1" },
  // unknown script agent -> magpie_local fallback
  { route_id: 7, t: "2026-10-31T21:10:00+08:00", agent: "Go-http-client", provider: "zhipu", model: "glm-5.3", req: "zhipu/glm-5.3", in: 50, out: 5, cache_read: 0, cache_write: 0, status: 200, response_id: "resp_c2" },
  // different hour, same agent+model -> separate bucket
  { route_id: 8, t: "2026-10-31T22:05:00+08:00", agent: "codex", provider: "codex", model: "gpt-5.6-terra", req: "gpt-5.6-terra", in: 100, out: 10, cache_read: 20, cache_write: 0, status: 200, response_id: "resp_b2" },
  // model casing differs -> merges into the same lowercase model row
  { route_id: 9, t: "2026-10-31T22:06:00+08:00", agent: "codex", provider: "codex", model: "GPT-5.6-Terra", req: "GPT-5.6-Terra", in: 1, out: 2, cache_read: 3, cache_write: 0, status: 200, response_id: "resp_b3" }
];

const ledgerText = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

describe("parseLedger", () => {
  test("parses rows and skips a truncated trailing line", () => {
    const { rows: parsed, malformed, total } = parseLedger(ledgerText + `{"route_id":10,"t":"2026-10-31T23`);
    expect(total).toBe(rows.length + 1);
    expect(malformed).toBe(1);
    expect(parsed.length).toBe(rows.length);
  });

  test("refuses loudly on shape drift (>5% malformed)", () => {
    const drift = Array.from({ length: 30 }, (_, i) => (i < 10 ? "not json at all" : JSON.stringify(rows[0]))).join("\n");
    expect(() => parseLedger(drift)).toThrow(/shape drift/);
  });
});

describe("integrityCheck", () => {
  test("accepts the healthy ledger (0-token retries don't carry response_id)", () => {
    const counted = rows.filter((row) => row.in || row.out || row.cache_read || row.cache_write);
    const check = integrityCheck(counted);
    expect(check.ok).toBe(true);
  });

  test("rejects duplicate response_id among counted rows", () => {
    const dup = [
      { route_id: 1, t: "2026-10-31T20:00:00+08:00", in: 5, response_id: "resp_x" },
      { route_id: 2, t: "2026-10-31T20:01:00+08:00", in: 6, response_id: "resp_x" }
    ];
    const check = integrityCheck(dup);
    expect(check.ok).toBe(false);
    expect(check.issues[0]).toMatch(/duplicate response_id resp_x/);
  });

  test("rejects rows without route_id", () => {
    const check = integrityCheck([{ t: "2026-10-31T20:00:00+08:00", in: 5 }]);
    expect(check.ok).toBe(false);
    expect(check.issues[0]).toMatch(/without valid route_id/);
  });
});

describe("buildBuckets", () => {
  const parsed = parseLedger(ledgerText);
  const buckets = buildBuckets(parsed.rows, { participantId: PARTICIPANT, timeZone: "Asia/Shanghai", now: new Date("2026-11-01T10:00:00+08:00") });

  test("buckets by day|hour|providerId", () => {
    expect([...buckets.keys()].sort()).toEqual([
      "2026-10-31|20|zcode_local",
      "2026-10-31|21|magpie_local",
      "2026-10-31|22|codex_local",
      "2026-10-31|23|codex_local"
    ]);
  });

  test("aggregates same-model rows by summation", () => {
    const bucket = buckets.get("2026-10-31|20|zcode_local");
    expect(bucket.items.length).toBe(1);
    const item = bucket.items[0];
    expect(item.model).toBe("antigravity/gemini-3.8-flash");
    expect(item.inputTokens).toBe(28561 + 2064);
    expect(item.outputTokens).toBe(101 + 1164);
    expect(item.cacheReadTokens).toBe(26522);
    expect(item.totalTokens).toBe(28561 + 101 + 2064 + 1164 + 26522);
    expect(item.reasoningTokens).toBe(81 + 659); // diagnostic, not in total
  });

  test("client attribution: zcode borrowing codex stays zcode_local, canceled 0-token row gone", () => {
    const bucket = buckets.get("2026-10-31|20|zcode_local");
    expect(bucket.items.every((item) => item.providerId === "zcode_local" && item.toolCode === "zcode")).toBe(true);
    expect(bucket.items.find((item) => item.model === "codex/gpt-6-luna")).toBeUndefined();
  });

  test("memory_consolidation tokens count, failed retries/probes excluded", () => {
    const bucket = buckets.get("2026-10-31|23|codex_local");
    expect(bucket.items[0].inputTokens).toBe(9184);
    expect(bucket.items.length).toBe(1);
  });

  test("merges model casing into one lowercase row", () => {
    const bucket = buckets.get("2026-10-31|22|codex_local");
    expect(bucket.items.length).toBe(1);
    expect(bucket.items[0].model).toBe("gpt-5.6-terra");
    expect(bucket.items[0].inputTokens).toBe(101);
  });

  test("magpie + unknown agents land in magpie_local", () => {
    const bucket = buckets.get("2026-10-31|21|magpie_local");
    expect(bucket.items.length).toBe(1); // both glm-5.3 rows merged
    expect(bucket.items[0].inputTokens).toBe(1200 + 50);
    expect(bucket.items[0].toolCode).toBe("magpie");
  });

  test("PII fields physically absent from items", () => {
    const serialized = JSON.stringify([...buckets.values()]);
    expect(serialized).not.toContain("providerAccount");
    expect(serialized).not.toContain("chatgpt.com");
    expect(serialized).not.toContain("sess-");
    expect(serialized).not.toContain("resp_");
    expect(serialized).not.toContain("ep");
  });

  test("workdir is the participant-salted virtual bucket", () => {
    const item = buckets.get("2026-10-31|23|codex_local").items[0];
    expect(item.workdirDisplayName).toBe("Magpie");
    expect(item.workdirHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("includeMagpieLocal=false drops only the fallback source", () => {
    const filtered = buildBuckets(parsed.rows, { participantId: PARTICIPANT, timeZone: "Asia/Shanghai", includeMagpieLocal: false, now: new Date("2026-11-01T10:00:00+08:00") });
    expect(filtered.has("2026-10-31|21|magpie_local")).toBe(false);
    expect(filtered.has("2026-10-31|20|zcode_local")).toBe(true);
  });

  test("sinceDay cuts earlier days", () => {
    const filtered = buildBuckets(parsed.rows, { participantId: PARTICIPANT, timeZone: "Asia/Shanghai", sinceDay: "2026-10-31", now: new Date("2026-11-01T10:00:00+08:00") });
    expect(filtered.size).toBe(4);
    const stricter = buildBuckets(parsed.rows, { participantId: PARTICIPANT, timeZone: "Asia/Shanghai", sinceDay: "2026-11-01", now: new Date("2026-11-01T10:00:00+08:00") });
    expect(stricter.size).toBe(0);
  });

  test("future-dated rows (clock skew) are dropped", () => {
    const future = [...parsed.rows, { route_id: 99, t: "2026-11-02T09:00:00+08:00", agent: "codex", provider: "codex", model: "gpt-5.6-terra", req: "gpt-5.6-terra", in: 10, out: 1, status: 200, response_id: "resp_future" }];
    const buckets2 = buildBuckets(future, { participantId: PARTICIPANT, timeZone: "Asia/Shanghai", now: new Date("2026-11-01T10:00:00+08:00") });
    expect([...buckets2.keys()].some((key) => key.startsWith("2026-11-02"))).toBe(false);
  });
});

describe("mapAgent", () => {
  test("known agents map to ATL providers, everything else to the fallback", () => {
    expect(mapAgent("zcode")).toBe(AGENT_PROVIDER_MAP.zcode);
    expect(mapAgent("claude")).toBe(AGENT_PROVIDER_MAP.claude);
    expect(mapAgent("codex")).toBe(AGENT_PROVIDER_MAP.codex);
    expect(mapAgent("opencode")).toBe(AGENT_PROVIDER_MAP.opencode);
    expect(mapAgent("magpie")).toBe(MAGPIE_FALLBACK);
    expect(mapAgent("")).toBe(MAGPIE_FALLBACK);
    expect(mapAgent(undefined)).toBe(MAGPIE_FALLBACK);
  });
});

describe("firstRouteId", () => {
  test("returns the first numeric route id", () => {
    expect(firstRouteId(parseLedger(ledgerText).rows)).toBe(1);
    expect(firstRouteId([])).toBe(null);
  });
});
