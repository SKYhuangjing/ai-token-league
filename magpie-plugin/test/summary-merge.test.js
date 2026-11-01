// The rolling-window read model: history is immutable, so a windowed
// summary overlays onto the cached full view — old days survive, window
// days refresh, today's hourly fields come from the fresh read.
import { describe, expect, test } from "bun:test";
import { mergeSummaries } from "../lib/usage-summary.js";

const day = (d, total) => ({ day: d, total, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 1, errors: 0, cost: 0, sources: {}, models: {} });

describe("mergeSummaries", () => {
  test("window days replace, out-of-window days survive, sorted", () => {
    const cached = { today: "2026-11-01", days: [day("2026-05-01", 10), day("2026-10-30", 20), day("2026-10-31", 30)] };
    const recent = { today: "2026-11-01", days: [day("2026-10-31", 99), day("2026-11-01", 40)] };
    const merged = mergeSummaries(cached, recent);
    expect(merged.days.map((d) => d.day)).toEqual(["2026-05-01", "2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(merged.days.find((d) => d.day === "2026-10-31").total).toBe(99); // refreshed by the window
    expect(merged.days.find((d) => d.day === "2026-05-01").total).toBe(10); // history untouched
    expect(merged.today).toBe("2026-11-01"); // fresh read owns the present
  });

  test("trims to maxDays from the tail and tolerates one-sided inputs", () => {
    const many = { today: "2026-11-01", days: Array.from({ length: 500 }, (_, i) => day(`2025-${String(i % 12 + 1).padStart(2, "0")}-01`, i)) };
    const merged = mergeSummaries(many, { today: "2026-11-01", days: [] }, { maxDays: 380 });
    expect(merged.days.length).toBeLessThanOrEqual(380);
    expect(mergeSummaries(null, { days: [] })).toEqual({ days: [] });
    expect(mergeSummaries({ days: [day("2026-01-01", 1)] }, null).days.length).toBe(1);
  });
});
