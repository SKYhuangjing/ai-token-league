import { describe, expect, it } from "vitest";
import {
  normalizeCloudShareData,
  normalizeLocalShareData,
  renderShareCardHtml,
  renderPortraitShareCardHtml,
  portraitShareCardCss,
  polaroidDimensions,
  PORTRAIT_CARD_WIDTH,
  PORTRAIT_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  SHARE_CARD_HEIGHT,
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
    "common.reasoning": "Reasoning",
    "desktop.share.activity": "Activity"
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

  it("hides cloud URL when showCloudUrl is false", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "Sky" },
      summary: { totals: { totalTokens: 100 } },
      trend: { items: [] }
    });
    const html = renderShareCardHtml(data, { t, formatToken, formatUsd, sourceName, cloudUrl: "https://example.com", showCloudUrl: false });
    expect(html).not.toContain("sc-brand-url");
    expect(html).not.toContain("https://example.com");
  });

  it("shows cloud URL when showCloudUrl is true", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "Sky" },
      summary: { totals: { totalTokens: 100 } },
      trend: { items: [] }
    });
    const html = renderShareCardHtml(data, { t, formatToken, formatUsd, sourceName, cloudUrl: "https://my-league.com", showCloudUrl: true });
    expect(html).toContain("sc-brand-url");
    expect(html).toContain("https://my-league.com");
  });

  it("shows cloud URL by default when showCloudUrl is not set", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "Sky" },
      summary: { totals: { totalTokens: 100 } },
      trend: { items: [] }
    });
    const html = renderShareCardHtml(data, { t, formatToken, formatUsd, sourceName, cloudUrl: "https://default.com" });
    expect(html).toContain("sc-brand-url");
    expect(html).toContain("https://default.com");
  });

  it("hides anonymous name badge when showAnonymousName is false", () => {
    const data = normalizeCloudShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { nickname: "Sky", identityMode: "anonymous", publicId: "GDPS", displayName: "GDPS" },
      analytics: {
        from: "2026-05-30",
        to: "2026-05-30",
        summary: { totalTokens: 1000 },
        providers: [{ name: "cursor_dashboard_usage", tokens: 1000 }]
      }
    });
    const html = renderShareCardHtml(data, { t, formatToken, formatUsd, sourceName, showAnonymousName: false });
    expect(html).not.toContain("sc-code-badge");
    expect(html).not.toContain("GDPS");
  });

  it("shows anonymous name badge when showAnonymousName is true", () => {
    const data = normalizeCloudShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { nickname: "Sky", identityMode: "anonymous", publicId: "GDPS", displayName: "GDPS" },
      analytics: {
        from: "2026-05-30",
        to: "2026-05-30",
        summary: { totalTokens: 1000 },
        providers: [{ name: "cursor_dashboard_usage", tokens: 1000 }]
      }
    });
    const html = renderShareCardHtml(data, { t, formatToken, formatUsd, sourceName, showAnonymousName: true });
    expect(html).toContain("sc-code-badge");
    expect(html).toContain("Today's Code · GDPS");
  });

  it("shows anonymous name badge by default when showAnonymousName is not set", () => {
    const data = normalizeCloudShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { nickname: "Sky", identityMode: "anonymous", publicId: "GDPS", displayName: "GDPS" },
      analytics: {
        from: "2026-05-30",
        to: "2026-05-30",
        summary: { totalTokens: 1000 },
        providers: [{ name: "cursor_dashboard_usage", tokens: 1000 }]
      }
    });
    const html = renderShareCardHtml(data, { t, formatToken, formatUsd, sourceName });
    expect(html).toContain("sc-code-badge");
    expect(html).toContain("Today's Code · GDPS");
  });
});

describe("PORTRAIT_CARD_WIDTH / PORTRAIT_CARD_HEIGHT", () => {
  it("exports portrait dimensions as 720x1200", () => {
    expect(PORTRAIT_CARD_WIDTH).toBe(720);
    expect(PORTRAIT_CARD_HEIGHT).toBe(1200);
  });

  it("is the swapped dimensions of landscape", () => {
    expect(PORTRAIT_CARD_WIDTH).toBe(SHARE_CARD_HEIGHT);
    expect(PORTRAIT_CARD_HEIGHT).toBe(SHARE_CARD_WIDTH);
  });
});

describe("polaroidDimensions", () => {
  it("returns landscape dimensions by default", () => {
    const dims = polaroidDimensions();
    expect(dims.cardWidth).toBe(1200);
    expect(dims.cardHeight).toBe(720);
    expect(dims.exportWidth).toBe(1236);
    expect(dims.exportHeight).toBe(782);
  });

  it("returns portrait dimensions when orientation is portrait", () => {
    const dims = polaroidDimensions("portrait");
    expect(dims.cardWidth).toBe(720);
    expect(dims.cardHeight).toBe(1200);
    expect(dims.exportWidth).toBe(756);
    expect(dims.exportHeight).toBe(1262);
  });

  it("falls back to landscape for unknown orientation", () => {
    const dims = polaroidDimensions("foo");
    expect(dims.cardWidth).toBe(1200);
    expect(dims.cardHeight).toBe(720);
  });
});

describe("portraitShareCardCss", () => {
  it("returns CSS containing portrait dimensions", () => {
    const css = portraitShareCardCss();
    expect(css).toContain("720px");
    expect(css).toContain("1200px");
    expect(css).toContain("sc-portrait");
    expect(css).toContain("sc-pulse-grid");
    expect(css).toContain("sc-pulse-svg");
  });
});

describe("renderPortraitShareCardHtml", () => {
  it("renders portrait layout with data-share-card-style portrait", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "Sky" },
      summary: { totals: { totalTokens: 500, inputTokens: 200, outputTokens: 200, cacheReadTokens: 100 }, providers: [{ name: "codex_local", totalTokens: 500 }], models: [{ name: "gpt-5", totalTokens: 500 }] },
      trend: { items: [{ hour: 9, totalTokens: 300 }, { hour: 14, totalTokens: 200 }] }
    });
    const html = renderPortraitShareCardHtml(data, { t, formatToken, formatUsd, sourceName, cloudUrl: "https://example.com", showCloudUrl: true });
    expect(html).toContain('data-share-card-style="portrait"');
    expect(html).toContain("sc-portrait-header");
    expect(html).toContain("sc-portrait-identity-col");
    expect(html).toContain("sc-portrait-hero-block");
    expect(html).toContain("sc-portrait-hero-container");
    expect(html).toContain("sc-hero-persona-pill");
    expect(html).toContain("sc-pulse-grid");
    expect(html).toContain("Source mix");
    expect(html).toContain("Model mix");
    expect(html).toContain("https://example.com");
  });

  it("renders Today's Code badge inside identity column when anonymousName is provided", () => {
    const data = normalizeCloudShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { nickname: "Sky", identityMode: "anonymous", publicId: "GDPS", displayName: "GDPS" },
      analytics: {
        from: "2026-05-30",
        to: "2026-05-30",
        summary: { totalTokens: 1000 },
        providers: [{ name: "cursor_dashboard_usage", tokens: 1000 }]
      }
    });
    const html = renderPortraitShareCardHtml(data, { t, formatToken, formatUsd, sourceName });
    expect(html).toContain("sc-portrait-identity-col");
    expect(html).toContain("sc-code-badge");
    expect(html).toContain("Today's Code · GDPS");
  });

  it("hides anonymous name badge when showAnonymousName is false", () => {
    const data = normalizeCloudShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { nickname: "Sky", identityMode: "anonymous", publicId: "GDPS", displayName: "GDPS" },
      analytics: {
        from: "2026-05-30",
        to: "2026-05-30",
        summary: { totalTokens: 1000 },
        providers: [{ name: "cursor_dashboard_usage", tokens: 1000 }]
      }
    });
    const html = renderPortraitShareCardHtml(data, { t, formatToken, formatUsd, sourceName, showAnonymousName: false });
    expect(html).not.toContain("sc-code-badge");
    expect(html).not.toContain("GDPS");
  });

  it("shows anonymous name badge when showAnonymousName is true", () => {
    const data = normalizeCloudShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { nickname: "Sky", identityMode: "anonymous", publicId: "GDPS", displayName: "GDPS" },
      analytics: {
        from: "2026-05-30",
        to: "2026-05-30",
        summary: { totalTokens: 1000 },
        providers: [{ name: "cursor_dashboard_usage", tokens: 1000 }]
      }
    });
    const html = renderPortraitShareCardHtml(data, { t, formatToken, formatUsd, sourceName, showAnonymousName: true });
    expect(html).toContain("sc-code-badge");
    expect(html).toContain("Today's Code · GDPS");
  });

  it("shows anonymous name badge by default when showAnonymousName is not set", () => {
    const data = normalizeCloudShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { nickname: "Sky", identityMode: "anonymous", publicId: "GDPS", displayName: "GDPS" },
      analytics: {
        from: "2026-05-30",
        to: "2026-05-30",
        summary: { totalTokens: 1000 },
        providers: [{ name: "cursor_dashboard_usage", tokens: 1000 }]
      }
    });
    const html = renderPortraitShareCardHtml(data, { t, formatToken, formatUsd, sourceName });
    expect(html).toContain("sc-code-badge");
    expect(html).toContain("Today's Code · GDPS");
  });

  it("escapes HTML in identity name to prevent XSS", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "<script>alert(1)</script>" },
      summary: { totals: { totalTokens: 100 } },
      trend: { items: [] }
    });
    const html = renderPortraitShareCardHtml(data, { t, formatToken, formatUsd, sourceName });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("hides cloud URL when showCloudUrl is false", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "Sky" },
      summary: { totals: { totalTokens: 100 } },
      trend: { items: [] }
    });
    const html = renderPortraitShareCardHtml(data, { t, formatToken, formatUsd, sourceName, cloudUrl: "https://example.com", showCloudUrl: false });
    expect(html).not.toContain("sc-portrait-cloud");
    expect(html).not.toContain("https://example.com");
  });

  it("shows cloud URL when showCloudUrl is true", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "Sky" },
      summary: { totals: { totalTokens: 100 } },
      trend: { items: [] }
    });
    const html = renderPortraitShareCardHtml(data, { t, formatToken, formatUsd, sourceName, cloudUrl: "https://my-league.com", showCloudUrl: true });
    expect(html).toContain("sc-portrait-cloud");
    expect(html).toContain("https://my-league.com");
  });

  it("shows cloud URL by default when showCloudUrl is not set", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "Sky" },
      summary: { totals: { totalTokens: 100 } },
      trend: { items: [] }
    });
    const html = renderPortraitShareCardHtml(data, { t, formatToken, formatUsd, sourceName, cloudUrl: "https://default.com" });
    expect(html).toContain("sc-portrait-cloud");
    expect(html).toContain("https://default.com");
  });

  it("shows rank stats for cloud data with rank", () => {
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
    const html = renderPortraitShareCardHtml(data, { t, formatToken, formatUsd, sourceName });
    expect(html).toContain("No.1");
    expect(html).toContain("sc-portrait-header-sub-list");
    expect(html).toContain("27");
    expect(html).toContain("3");
  });

  it("renders heatmap bars for hourly data", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "Sky" },
      summary: { totals: { totalTokens: 1000 } },
      trend: { items: [{ hour: 9, totalTokens: 400 }, { hour: 14, totalTokens: 600 }] }
    });
    const html = renderPortraitShareCardHtml(data, { t, formatToken, formatUsd, sourceName });
    expect(html).toContain("sc-pulse-grid");
    expect(html).toContain("sc-pulse-svg");
    expect(html).toContain("sc-pulse-stats");
  });

  it("shows locale-aware date range for 'all' range", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "Sky" },
      summary: { totals: { totalTokens: 100 } },
      trend: { items: [] }
    });
    data.range = "all";
    data.from = "2026-01-01";
    const html = renderPortraitShareCardHtml(data, { t, formatToken, formatUsd, sourceName });
    // English locale: "Through 2026-05-30"
    expect(html).toContain("Through 2026-05-30");
  });

  it("shows date span for '7d' range", () => {
    const data = normalizeLocalShareData({
      period: "today",
      businessDay: "2026-05-30",
      identity: { displayName: "Sky" },
      summary: { totals: { totalTokens: 100 } },
      trend: { items: [] }
    });
    data.range = "7d";
    data.from = "2026-05-24";
    const html = renderPortraitShareCardHtml(data, { t, formatToken, formatUsd, sourceName });
    expect(html).toContain("2026-05-24 ~ 2026-05-30");
  });
});
