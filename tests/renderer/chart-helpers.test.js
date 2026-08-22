import { describe, expect, it } from "vitest";
import { aggregateTimeSeriesByWeek, renderBarChart, smoothLinePath, sourceName } from "../../src/shared/chart-helpers.js";

describe("shared sourceName", () => {
  it("maps all supported local providers", () => {
    expect(sourceName("mimocode_local")).toBe("MiMoCode");
    expect(sourceName("opencode_local")).toBe("OpenCode");
    expect(sourceName("hermes_local")).toBe("Hermes");
    expect(sourceName("openclaw_local")).toBe("OpenClaw");
    expect(sourceName("zcode_local")).toBe("ZCode");
    expect(sourceName("workbuddy_local")).toBe("WorkBuddy");
    expect(sourceName("dsh_local")).toBe("DeepSeek Harness");
  });
});

describe("aggregateTimeSeriesByWeek", () => {
  it("sums tokens and takes max activeCount per UTC week", () => {
    const weekly = aggregateTimeSeriesByWeek([
      { day: "2026-07-13", totalTokens: 100, activeCount: 3 }, // Mon
      { day: "2026-07-14", totalTokens: 50, activeCount: 5 },
      { day: "2026-07-15", totalTokens: 25, activeCount: 2 },
      { day: "2026-07-20", totalTokens: 40, activeCount: 4 } // next Mon
    ]);
    expect(weekly).toHaveLength(2);
    expect(weekly[0]).toMatchObject({
      day: "2026-07-13",
      periodStart: "2026-07-13",
      periodEnd: "2026-07-19",
      totalTokens: 175,
      activeCount: 5
    });
    expect(weekly[0].label).toBe("07-13 ~ 07-19");
    expect(weekly[1]).toMatchObject({
      day: "2026-07-20",
      totalTokens: 40,
      activeCount: 4
    });
  });
});

describe("smoothLinePath", () => {
  it("builds a cubic path through points", () => {
    const d = smoothLinePath([
      { x: 0, y: 10 },
      { x: 10, y: 20 },
      { x: 20, y: 5 }
    ]);
    expect(d.startsWith("M 0 10")).toBe(true);
    expect(d).toContain(" C ");
    expect(d).toContain("20 5");
  });
});

describe("renderBarChart", () => {
  it("renders percentage rows using actual widths", () => {
    const container = document.createElement("div");
    renderBarChart(container, [
      { name: "claude-opus", tokens: 380, ratio: 0.38 },
      { name: "gpt-5", tokens: 240, ratio: 0.24 }
    ], { localeTokenCompact: (value) => String(value) });

    const rows = container.querySelectorAll(".usage-share-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".lbl")?.textContent).toContain("38%");
    expect(rows[0].querySelector(".usage-share-value strong")?.textContent).toBe("380");
    expect(rows[0].querySelector(".usage-share-track > i")?.style.width).toBe("38%");
    expect(rows[1].querySelector(".usage-share-track > i")?.style.width).toBe("24%");
  });
});
