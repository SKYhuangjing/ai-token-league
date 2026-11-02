import { describe, expect, test } from "bun:test";
import { summarizeRows, rangeView, shiftDay, topEntries } from "../lib/usage-summary.js";

const rows = [
  { route_id: 1, t: "2026-10-31T10:00:00+08:00", agent: "zcode", provider: "antigravity", model: "m", req: "antigravity/m", in: 1000, out: 200, cache_read: 300, cache_write: 0, reasoning: 10, cost: 0.5 },
  { route_id: 2, t: "2026-10-31T11:00:00+08:00", agent: "codex", provider: "codex", model: "gpt", req: "gpt", in: 100, out: 50, cache_read: 0, cache_write: 50, reasoning: 5, cost: 0.1 },
  { route_id: 3, t: "2026-11-01T09:00:00+08:00", agent: "magpie", provider: "zhipu", model: "glm", req: "zhipu/glm", in: 400, out: 60, cache_read: 0, cache_write: 0, cost: 0.2 },
  // probe + 0-token -> excluded even in the display view
  { t: "2026-11-01T09:10:00+08:00", agent: "magpie", kind: "model_list", source: "probe", in: 0, out: 0, cache_read: 0, cache_write: 0 },
  // 0-token failure: no tokens, but it counts toward 请求/失败
  { route_id: 4, t: "2026-11-01T09:20:00+08:00", agent: "codex", provider: "codex", model: "gpt", in: 0, out: 0, cache_read: 0, cache_write: 0, status: 502 },
  // future clock-skew row -> dropped
  { route_id: 5, t: "2026-11-05T09:00:00+08:00", agent: "codex", provider: "codex", model: "gpt", req: "gpt", in: 999, out: 1, cache_read: 0, cache_write: 0 }
];

const NOW = new Date("2026-11-01T12:00:00+08:00");

describe("summarizeRows", () => {
  const summary = summarizeRows(rows, { timeZone: "Asia/Shanghai", now: NOW });

  test("per-day aggregation with exact four-part sums", () => {
    expect(summary.days.map((d) => d.day)).toEqual(["2026-10-31", "2026-11-01"]);
    const d31 = summary.days[0];
    expect(d31.total).toBe(1700); // 1500 + 200
    expect(d31.input).toBe(1100);
    expect(d31.output).toBe(250);
    expect(d31.cacheRead).toBe(300);
    expect(d31.cacheWrite).toBe(50);
    expect(d31.sources).toEqual({
      zcode_local: { t: 1500, c: 1, cost: 0.5, input: 1000, output: 200, cacheRead: 300, cacheWrite: 0, errors: 0 },
      codex_local: { t: 200, c: 1, cost: 0.1, input: 100, output: 50, cacheRead: 0, cacheWrite: 50, errors: 0 }
    });
    expect(d31.calls).toBe(2);
    expect(d31.errors).toBe(0);
    expect(d31.cost).toBeCloseTo(0.6);
    const d01 = summary.days[1];
    expect(d01.total).toBe(460);
    expect(d01.calls).toBe(2); // 1 token call + 1 token-less failure
    expect(d01.errors).toBe(1);
    expect(d01.cost).toBeCloseTo(0.2);
    expect(d01.sources).toEqual({
      codex_local: { t: 0, c: 1, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, errors: 1 },
      magpie_local: { t: 460, c: 1, cost: 0.2, input: 400, output: 60, cacheRead: 0, cacheWrite: 0, errors: 0 }
    });
    expect(d01.models["zhipu/glm"]).toEqual({
      t: 460, c: 1, cost: 0.2, input: 400, output: 60, cacheRead: 0, cacheWrite: 0, errors: 0
    });
  });

  test("excludes probes, 0-token failures and future rows", () => {
    expect(summary.days.some((d) => d.day === "2026-11-05")).toBe(false);
    expect(summary.days[1].total).toBe(460); // 999+1 future row not counted
  });

  test("models are provider-prefixed lowercase", () => {
    expect(Object.keys(summary.days[0].models)).toEqual(["antigravity/m", "gpt"]);
  });

  test("todayHoursBySource splits today by client source", () => {
    expect(summary.todayHoursBySource[9]).toEqual({ magpie_local: 460 });
    expect(summary.todayHoursBySource[0]).toEqual({});
  });

  test("todayHoursByModel splits today by model", () => {
    expect(summary.todayHoursByModel[9]).toEqual({ "zhipu/glm": 460 });
    expect(summary.todayHoursByModel[0]).toEqual({});
  });

  test("todayHours buckets today's rows by local hour", () => {
    expect(summary.todayHours.reduce((a, b) => a + b, 0)).toBe(460);
    expect(summary.todayHours[9]).toBe(460);
    expect(summary.todayHours[0]).toBe(0);
  });

  test("caps to maxDays newest", () => {
    expect(summarizeRows(rows, { timeZone: "Asia/Shanghai", now: NOW, maxDays: 1 }).days.map((d) => d.day)).toEqual(["2026-11-01"]);
  });
});

describe("rangeView", () => {
  const summary = summarizeRows(rows, { timeZone: "Asia/Shanghai", now: NOW });

  test("today view", () => {
    const view = rangeView(summary, 1);
    expect(view.totals.total).toBe(460);
    expect(view.sources).toEqual({
      codex_local: { t: 0, c: 1, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, errors: 1 },
      magpie_local: { t: 460, c: 1, cost: 0.2, input: 400, output: 60, cacheRead: 0, cacheWrite: 0, errors: 0 }
    });
  });

  test("7d view includes 10-31", () => {
    const view = rangeView(summary, 7);
    expect(view.totals.total).toBe(2160);
    expect(view.totals.input).toBe(1500);
    expect(view.totals.calls).toBe(4);
    expect(view.totals.errors).toBe(1);
    expect(view.totals.cost).toBeCloseTo(0.8);
    const tops = topEntries(view.sources, 2).map(([k, v]) => [k, v.t]);
    expect(tops).toEqual([["zcode_local", 1500], ["magpie_local", 460]]);
  });

  test("all view with count=0", () => {
    const view = rangeView(summary, 0);
    expect(view.totals.total).toBe(2160);
  });
});

describe("helpers", () => {
  test("shiftDay crosses month boundary", () => {
    expect(shiftDay("2026-11-01", -1)).toBe("2026-10-31");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  });

  test("topEntries sorts descending and limits", () => {
    expect(topEntries({ a: 1, b: 3, c: 2 }, 2)).toEqual([["b", 3], ["c", 2]]);
  });
});
