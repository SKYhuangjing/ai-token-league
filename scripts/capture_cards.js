import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { chromium } from "playwright";
import {
  normalizeLocalShareData,
  normalizeCloudShareData,
  renderShareCardHtml,
  renderPortraitShareCardHtml,
  shareCardCss,
  portraitShareCardCss
} from "../src/desktop/share-card.js";

const artifactDir = join(import.meta.dirname, "..", "artifacts", "share-cards");
mkdirSync(artifactDir, { recursive: true });

const t = (key, params = {}) => {
  let val = {
    "desktop.share.period.today": "Today",
    "desktop.share.period.this_week": "This week",
    "desktop.share.period.this_month": "This month",
    "desktop.share.iam": "我是 {name}",
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
    "desktop.share.activity": "Activity",
    "desktop.share.sources": "Source mix",
    "desktop.share.models": "Model mix",
    "desktop.share.composition": "Token mix",
    "desktop.share.periodRank": "Period rank",
    "desktop.share.noRank": "Unranked",
    "desktop.share.privacyNote": "No private prompt, code, transcript, or path data is included.",
    "desktop.share.noData": "No data",
    "desktop.share.leagueUnavailable": "League unavailable",
    "desktop.share.chart.trend": "Trend",
    "desktop.share.chart.heatmap": "Heatmap",
    "desktop.share.chart.sourceMeter": "Sources",
    "desktop.share.chart.modelShare": "Models",
    "desktop.share.chart.composition": "Composition",
    "desktop.share.chart.league": "League",
    "desktop.share.quote.0": "别只看峰值，看见节奏，才看见真正的生产力。",
    "desktop.share.quote.1": "今天的 Token 消耗，是一次认真思考留留下热量。",
    "desktop.share.quote.2": "技术不是思考的替代品，而是思考的放大器。",
    "desktop.share.quote.3": "代码是写给人看的，只是顺便让机器执行一下。",
    "desktop.share.quote.4": "让 AI 成为你的杠杆，而不是你的拐杖。",
    "desktop.share.quote.5": "伟大的代码源于对细节的偏执与对逻辑的坚持。",
    "desktop.share.quote.6": "在理性的世界里，每一行 Token 都是思考的痕迹。",
    "desktop.share.quote.7": "别只是构建，去创造那些能点亮未来的火花。",
    "desktop.share.other": "Other",
    "common.input": "Input",
    "common.output": "Output",
    "common.cache": "Cache",
    "common.reasoning": "Reasoning"
  }[key] || key;
  Object.entries(params).forEach(([k, v]) => {
    val = val.replace(new RegExp(`{${k}}`, "g"), String(v));
  });
  return val;
};

const formatToken = (value) => {
  const num = Number(value || 0);
  if (num >= 100000000) return `${(num / 100000000).toFixed(2)}亿`;
  if (num >= 10000) return `${(num / 10000).toFixed(0)}万`;
  return String(num);
};

const formatUsd = (val) => `$${Number(val).toFixed(2)}`;

// Scenario 1: Weekly with 6 days of activity
const weeklyData = normalizeCloudShareData({
  period: "this_week",
  businessDay: "2026-05-30",
  identity: { nickname: "Sky Huang", identityMode: "anonymous", publicId: "GDPS", displayName: "GDPS", anonymousName: "蚂蚁 2" },
  analytics: {
    from: "2026-05-25",
    to: "2026-05-30",
    summary: { totalTokens: 463000000, inputTokens: 21080000, outputTokens: 1690000, cacheReadTokens: 440000000, reasoningTokens: 249000, estimatedCostUsd: 237.36 },
    providers: [
      { name: "cursor_dashboard_usage", tokens: 287060000 },
      { name: "codex_local", tokens: 175940000 }
    ],
    models: [
      { name: "gpt-5.5", tokens: 287060000 },
      { name: "mimo-v2.5-pro", tokens: 101860000 },
      { name: "glm-5.1", tokens: 74080000 }
    ],
    timeSeries: [
      { day: "2026-05-25", totalTokens: 20000000 },
      { day: "2026-05-26", totalTokens: 40000000 },
      { day: "2026-05-27", totalTokens: 100000000 },
      { day: "2026-05-28", totalTokens: 3000000 },
      { day: "2026-05-29", totalTokens: 200000000 },
      { day: "2026-05-30", totalTokens: 100000000 }
    ],
    rankStats: { rank: 1, participantCount: 27, leaderDays: 6 }
  }
});

// Scenario 2: Today (Daily 24h Trend)
const dailyData = normalizeCloudShareData({
  period: "today",
  businessDay: "2026-05-30",
  identity: { nickname: "Sky Huang", identityMode: "anonymous", publicId: "GDPS", displayName: "GDPS", anonymousName: "第一代号 · 狮城 2" },
  analytics: {
    from: "2026-05-30",
    to: "2026-05-30",
    summary: { totalTokens: 66010000, inputTokens: 1805000, outputTokens: 179000, cacheReadTokens: 64020000, reasoningTokens: 42000, estimatedCostUsd: 46.42 },
    providers: [
      { name: "Codex", tokens: 66010000 }
    ],
    models: [
      { name: "gpt-5.5", tokens: 66010000 }
    ],
    timeSeries: Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      label: `${String(i).padStart(2, "0")}:00`,
      totalTokens: i === 9 ? 20000000 : i === 10 ? 30000000 : i === 11 ? 16010000 : 0
    })),
    rankStats: { rank: 1, participantCount: 1, leaderDays: 0 }
  }
});

const weeklyHtml = renderShareCardHtml(weeklyData, { t, formatToken, formatUsd });
const dailyHtml = renderShareCardHtml(dailyData, { t, formatToken, formatUsd });
const portraitWeeklyHtml = renderPortraitShareCardHtml(weeklyData, { t, formatToken, formatUsd, showAnonymousName: true });
const portraitDailyHtml = renderPortraitShareCardHtml(dailyData, { t, formatToken, formatUsd, showAnonymousName: true });

async function capture() {
  console.log("Launching headless browser via Playwright...");
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const scenarios = [
    { name: "weekly-card", html: weeklyHtml, css: shareCardCss(), width: 1200, height: 720 },
    { name: "daily-card", html: dailyHtml, css: shareCardCss(), width: 1200, height: 720 },
    { name: "portrait-weekly-card", html: portraitWeeklyHtml, css: `${shareCardCss()} ${portraitShareCardCss()}`, width: 720, height: 1200 },
    { name: "portrait-daily-card", html: portraitDailyHtml, css: `${shareCardCss()} ${portraitShareCardCss()}`, width: 720, height: 1200 }
  ];

  for (const s of scenarios) {
    console.log(`Capturing ${s.name}...`);
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.setContent(`
      <html>
        <head><style>body { margin: 0; padding: 0; background: #fff; overflow: hidden; } ${s.css}</style></head>
        <body>${s.html}</body>
      </html>
    `);
    await page.screenshot({ path: join(artifactDir, `${s.name}.png`), fullPage: true });
  }

  await browser.close();
  console.log(`Screenshots saved to ${artifactDir}`);
}

capture().catch((err) => {
  console.error("Error capturing screenshots:", err);
  process.exit(1);
});
