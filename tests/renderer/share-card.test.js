import { describe, expect, it } from "vitest";
import {
  normalizeCloudShareData,
  normalizeLocalShareData,
  renderShareCardHtml,
  sharePeriodBounds,
  shareRangeForPeriod,
  withCloudPending
} from "../../src/desktop/share-card.js";

const t = (key, params = {}) => {
  let val = {
    "app.name": "AI Token League",
    "desktop.share.period.today": "Today",
    "desktop.share.period.this_week": "This week",
    "desktop.share.period.this_month": "This month",
    "desktop.share.iam": "I am {name}",
    "desktop.share.localStats": "Local",
    "desktop.share.localStatsDesc": "Stored locally",
    "desktop.share.cloudPublic": "Cloud",
    "desktop.share.cloudAnonymous": "Anonymous",
    "desktop.share.cloudPending": "Pending cloud",
    "desktop.share.rankAfterSync": "Rank after sync",
    "desktop.share.totalTokens": "Total tokens",
    "desktop.share.mode": "Mode",
    "desktop.share.rank": "Rank",
    "desktop.share.note": "Note",
    "desktop.share.leaderDays": "Leader days",
    "desktop.share.beaten": "Beaten",
    "desktop.share.participants": "Participants",
    "desktop.share.topSource": "Top source",
    "desktop.share.topModel": "Top model",
    "desktop.share.sources": "Source mix",
    "desktop.share.models": "Model mix",
    "desktop.share.composition": "Token mix",
    "desktop.share.periodRank": "Period rank",
    "desktop.share.noRank": "Unranked",
    "desktop.share.privacyNote": "No private data included.",
    "desktop.share.noData": "No data",
    "desktop.share.other": "Other",
    "desktop.share.cacheWrite": "Cache Write",
    "desktop.share.quote.0": "Quote 0",
    "desktop.share.quote.1": "Quote 1",
    "desktop.share.quote.2": "Quote 2",
    "desktop.share.quote.3": "Quote 3",
    "desktop.share.quote.4": "Quote 4",
    "desktop.share.quote.5": "Quote 5",
    "desktop.share.quote.6": "Quote 6",
    "desktop.share.quote.7": "Quote 7",
    "desktop.overview.usageTrend": "Usage Trend",
    "desktop.renderer.topWorkdirs": "Top Workdirs",
    "common.input": "Input",
    "common.output": "Output",
    "common.cache": "Cache",
    "common.reasoning": "Reasoning"
  }[key] || key;
  Object.entries(params).forEach(([k, v]) => {
    val = val.replace(new RegExp(`{${k}}`, "g"), String(v));
  });
  return val;
}

const formatToken = (value) => `${Number(value || 0)}`;
const formatUsd = (value) => `$${Number(value).toFixed(2)}`;
const sourceName = (value) => value;

describe("sharePeriodBounds", () => {
  it("uses Monday as week start and keeps today as the range end", () => {
    expect(sharePeriodBounds("this_week", "2026-05-30")).toEqual({ from: "2026-05-25", to: "2026-05-30" });
    expect(shareRangeForPeriod("this_week", "2026-05-30")).toBe("2026-05-25..2026-05-30");
  });

  it("uses the first day of the month for monthly cards", () => {
    expect(sharePeriodBounds("this_month", "2026-05-30")).toEqual({ from: "2026-05-01", to: "2026-05-30" });
  });
});

describe("normalizeLocalShareData", () => {
  it("normalizes desktop summary, trend, source, and model dimensions", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "Sky" },
      summary: {
        totals: { totalTokens: 1000, inputTokens: 400, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 100 },
        providers: [{ name: "codex_local", totalTokens: 700 }, { name: "claude_code_local", totalTokens: 300 }],
        models: [{ name: "gpt-5", totalTokens: 1000 }]
      },
      trend: { items: [{ hour: 9, totalTokens: 400 }, { hour: 10, totalTokens: 600 }] }
    });

    expect(data.mode).toBe("local");
    expect(data.totals.totalTokens).toBe(1000);
    expect(data.timeSeries).toHaveLength(24);
    expect(data.heatmap).toHaveLength(24);
    expect(data.providers[0]).toMatchObject({ name: "codex_local", tokens: 700, ratio: 0.7 });
    expect(data.models[0]).toMatchObject({ name: "gpt-5", tokens: 1000, ratio: 1 });
    expect(data.range).toBe("today");
    expect(data.from).toBe("2026-05-30");
    expect(data.trendGrain).toBe("hour");
  });
});

describe("normalizeCloudShareData", () => {
  it("preserves anonymous display ids and cloud rank stats", () => {
    const data = normalizeCloudShareData({
      period: "this_week",
      businessDay: "2026-05-30",
      identity: { identityMode: "anonymous", publicId: "anon_123", displayName: "匿名工程师" },
      analytics: {
        from: "2026-05-25",
        to: "2026-05-30",
        summary: { totalTokens: 5000, inputTokens: 3000, outputTokens: 2000 },
        providers: [{ name: "cursor_dashboard_usage", tokens: 5000 }],
        rankStats: { rank: 2, participantCount: 10, leaderDays: 1 }
      }
    });

    expect(data.mode).toBe("cloud_anonymous");
    expect(data.identity.displayId).toBe("anon_123");
    expect(data.rankStats.rank).toBe(2);
    expect(data.providers[0].ratio).toBe(1);
  });
});

describe("withCloudPending", () => {
  it("marks data as cloud_pending", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "Sky" },
      summary: { totals: { totalTokens: 100 } },
      trend: { items: [] }
    });
    const pending = withCloudPending(data);
    expect(pending.mode).toBe("cloud_pending");
    expect(data.mode).toBe("local"); // original unchanged
  });
});

describe("renderShareCardHtml", () => {
  it("renders overview-based layout with 3-column meters", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "<script>bad</script>" },
      summary: { totals: { totalTokens: 100, inputTokens: 100 }, providers: [{ name: "codex_local", totalTokens: 100 }] },
      trend: { items: [{ hour: 9, totalTokens: 100 }] },
      workdirs: [{ name: "my-project", totalTokens: 100 }]
    });
    const html = renderShareCardHtml(data, { t, formatToken, formatUsd, sourceName });
    expect(html).toContain('data-share-card-style="overview"');
    expect(html).toContain("Source mix");
    expect(html).toContain("Model mix");
    expect(html).toContain("Top Workdirs");
    expect(html).toContain("sc-dash-row");
    expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(html).not.toContain("<script>bad</script>");
    expect(html).toContain("Total tokens");
    expect(html).toContain("Usage Trend");
    expect(html).not.toContain("sc-comp-bar");
    expect(html).not.toContain("sc-landscape");
    expect(html).toContain("--spark-cols:");
  });

  it("displays estimated cost when available", () => {
    const data = normalizeCloudShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { nickname: "Sky Huang", identityMode: "anonymous", publicId: "GDPS", displayName: "GDPS" },
      analytics: {
        from: "2026-05-30",
        to: "2026-05-30",
        summary: { totalTokens: 5000, inputTokens: 3000, outputTokens: 2000, estimatedCostUsd: 1.25 },
        providers: [{ name: "cursor_dashboard_usage", tokens: 5000 }]
      }
    });

    expect(data.identity.nickname).toBe("Sky Huang");
    expect(data.identity.anonymousName).toBe("GDPS");

    const html = renderShareCardHtml(data, { t, formatToken, formatUsd, sourceName });
    expect(html).toContain("$1.25");
  });

  it("shows rank stats for cloud data", () => {
    const data = normalizeCloudShareData({
      period: "this_week",
      businessDay: "2026-05-30",
      identity: { nickname: "Sky", identityMode: "public" },
      analytics: {
        from: "2026-05-25",
        to: "2026-05-30",
        summary: { totalTokens: 5000, inputTokens: 3000, outputTokens: 2000 },
        providers: [{ name: "codex_local", tokens: 5000 }],
        rankStats: { rank: 1, participantCount: 27, leaderDays: 3 }
      }
    });

    const html = renderShareCardHtml(data, { t, formatToken, formatUsd, sourceName });
    expect(html).toContain("No.1");
    expect(html).toContain("27");
  });

  it("shows local stats badge when mode is local", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "Sky" },
      summary: { totals: { totalTokens: 100 } },
      trend: { items: [] }
    });

    const html = renderShareCardHtml(data, { t, formatToken, formatUsd, sourceName });
    expect(html).toContain("Local");
  });

  it("renders footer logo when logoUrl is provided", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "Sky" },
      summary: { totals: { totalTokens: 100 } },
      trend: { items: [] }
    });
    const logoUrl = "https://example.com/logo.png";
    const html = renderShareCardHtml(data, { t, formatToken, formatUsd, sourceName, logoUrl });
    expect(html).toContain("sc-footer-logo");
    expect(html).toContain(logoUrl);
  });

  it("omits footer logo when logoUrl is not provided", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "Sky" },
      summary: { totals: { totalTokens: 100 } },
      trend: { items: [] }
    });
    const html = renderShareCardHtml(data, { t, formatToken, formatUsd, sourceName });
    expect(html).not.toContain("sc-footer-logo");
  });

  it("escapes logoUrl to prevent XSS", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "Sky" },
      summary: { totals: { totalTokens: 100 } },
      trend: { items: [] }
    });
    const html = renderShareCardHtml(data, { t, formatToken, formatUsd, sourceName, logoUrl: '"><img src=x onerror=alert(1)>' });
    // The " is escaped to &quot; preventing attribute breakout
    expect(html).toContain("&quot;");
    expect(html).not.toContain('"><img');
  });
});
