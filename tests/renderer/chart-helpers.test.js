import { describe, expect, it } from "vitest";
import {
  aggregateTimeSeriesByWeek, renderBarChart, smoothLinePath, sourceName,
  providerSourceColor, COMPOSITION_PARTS
} from "../../src/shared/chart-helpers.js";

describe("shared sourceName", () => {
  it("maps all supported local providers", () => {
    expect(sourceName("mimocode_local")).toBe("MiMoCode");
    expect(sourceName("opencode_local")).toBe("OpenCode");
    expect(sourceName("hermes_local")).toBe("Hermes");
    expect(sourceName("openclaw_local")).toBe("OpenClaw");
    expect(sourceName("zcode_local")).toBe("ZCode");
    expect(sourceName("workbuddy_local")).toBe("WorkBuddy");
    expect(sourceName("dsh_local")).toBe("DeepSeek Harness");
    expect(sourceName("kimi_local")).toBe("Kimi");
  });
});

describe("providerSourceColor", () => {
  it("gives the seven supplementary providers dedicated palette colors", () => {
    expect(providerSourceColor("opencode_local")).toBe("#c2a05a");
    expect(providerSourceColor("mimocode_local")).toBe("#a14d3d");
    expect(providerSourceColor("hermes_local")).toBe("#6d6a5e");
    expect(providerSourceColor("openclaw_local")).toBe("#7a6a55");
    expect(providerSourceColor("zcode_local")).toBe("#8f7a45");
    expect(providerSourceColor("workbuddy_local")).toBe("#a67a5b");
    expect(providerSourceColor("dsh_local")).toBe("#b08968");
    expect(providerSourceColor("kimi_local")).toBe("#8b7355");
  });
  it("keeps the original three providers and falls back to other", () => {
    expect(providerSourceColor("claude_code_local")).toBe("#b4552f");
    expect(providerSourceColor("codex_local")).toBe("#cf6a42");
    expect(providerSourceColor("cursor_dashboard_usage")).toBe("#9a8f7d");
    expect(providerSourceColor("mystery_provider")).toBe("#b5aea0");
    expect(providerSourceColor("zcode_local", 1)).toBe("#a3905c");
    expect(providerSourceColor("zcode_local", 2)).toBe("#b6a878");
  });
});

describe("COMPOSITION_PARTS", () => {
  it("keeps the four composition colors unchanged", () => {
    expect(COMPOSITION_PARTS.map((part) => part.color)).toEqual(["#b4552f", "#cf6a42", "#e0956b", "#f2ddcd"]);
  });
  it("exposes keys and i18n label keys for reuse", () => {
    expect(COMPOSITION_PARTS.map((part) => part.key)).toEqual([
      "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"
    ]);
    expect(COMPOSITION_PARTS.map((part) => part.labelKey)).toEqual([
      "common.input", "common.output", "common.cacheRead", "common.cacheWrite"
    ]);
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
  it("builds a straight polyline through points", () => {
    const d = smoothLinePath([
      { x: 0, y: 10 },
      { x: 10, y: 20 },
      { x: 20, y: 5 }
    ]);
    expect(d).toBe("M 0 10 L 10 20 L 20 5");
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
