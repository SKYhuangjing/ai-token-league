// share-card.js — Overview-based share card renderer (portrait + landscape)

import { localDay } from "../shared/date.js";

// ── Constants ──

export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 720;
export const PORTRAIT_CARD_WIDTH = 720;
export const PORTRAIT_CARD_HEIGHT = 1200;
export const SHARE_QUOTE_COUNT = 12;

export const TROPHY_SVG = `<svg class="sc-medal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a1 1 0 0 1 0-5H6"/><path d="M18 9h1.5a1 1 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17a2 2 0 0 1-.976 1.696A5 5 0 0 0 7 22"/><path d="M14 14.66V17a2 2 0 0 0 .976 1.696A5 5 0 0 1 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`;
export const MEDAL_SVG = `<svg class="sc-medal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15"/><path d="M11 12 5.12 2.2"/><path d="m13 12 5.88-9.8"/><path d="M8 7h8"/><circle cx="12" cy="17" r="5"/><path d="M12 18v-2h-.5"/></svg>`;

// ── Utilities ──

export function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncateText(s, max = 18) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function round(n, dp = 0) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function collapseTop(items, limit = 4, mergeLabel = "Other") {
  if (items.length <= limit) return items;
  const top = items.slice(0, limit - 1);
  const rest = items.slice(limit - 1);
  const restTokens = rest.reduce((sum, item) => sum + (item.tokens || item.totalTokens || 0), 0);
  const restRatio = rest.reduce((sum, item) => sum + (item.ratio || 0), 0);
  return [...top, { name: mergeLabel, tokens: restTokens, ratio: round(restRatio, 4) }];
}

function topName(items) {
  return items.length ? items[0].name : "-";
}

// ── Period helpers ──

export function sharePeriodBounds(period, businessDay) {
  const day = businessDay || localDay();
  if (period === "today") return { from: day, to: day };
  if (period === "this_week") {
    const d = new Date(day + "T00:00:00Z");
    const dow = d.getUTCDay();
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + mondayOffset);
    const from = monday.toISOString().slice(0, 10);
    return { from, to: day };
  }
  if (period === "this_month") return { from: day.slice(0, 8) + "01", to: day };
  if (period === "last_week") {
    const d = new Date(day + "T00:00:00Z");
    const dow = d.getUTCDay();
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + mondayOffset - 7);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
  }
  if (period === "last_month") {
    const d = new Date(day + "T00:00:00Z");
    const firstOfLastMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    const lastOfLastMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
    return { from: firstOfLastMonth.toISOString().slice(0, 10), to: lastOfLastMonth.toISOString().slice(0, 10) };
  }
  if (period === "7d") {
    const d = new Date(day + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 6);
    return { from: d.toISOString().slice(0, 10), to: day };
  }
  if (period === "30d") {
    const d = new Date(day + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 29);
    return { from: d.toISOString().slice(0, 10), to: day };
  }
  return { from: day, to: day };
}

export function shareRangeForPeriod(period, businessDay) {
  const { from, to } = sharePeriodBounds(period, businessDay);
  return `${from}..${to}`;
}

export function shareTrendGrain(period) {
  if (period === "today") return "hour";
  if (period === "30d" || period === "this_month" || period === "last_month") return "week";
  if (period === "last_week") return "day";
  if (period === "all") return "month";
  return "day";
}

// ── Quotes ──

const RANK_QUOTE_COUNT = { 1: 3, 2: 3, 3: 3, top10: 3, top30: 3, top50: 3 };

export function shareQuote(index, t) {
  return t(`desktop.share.quote.${index % SHARE_QUOTE_COUNT}`);
}

function rankQuoteTier(rank) {
  if (!rank || rank < 1) return null;
  if (rank === 1) return "1";
  if (rank === 2) return "2";
  if (rank === 3) return "3";
  if (rank <= 10) return "top10";
  if (rank <= 30) return "top30";
  if (rank <= 50) return "top50";
  return null;
}

function shareFooterQuote(data, t) {
  const rank = data.rankStats?.rank || 0;
  const tier = rankQuoteTier(rank);
  if (tier) {
    const count = RANK_QUOTE_COUNT[tier] || 3;
    const idx = data.quoteIndex % count;
    const text = t(`desktop.share.rankQuote.${tier}.${idx}`);
    if (text && !text.startsWith("desktop.share.rankQuote.")) return text;
  }
  return shareQuote(data.quoteIndex, t);
}

export function randomShareQuoteIndex() {
  return Math.floor(Math.random() * SHARE_QUOTE_COUNT);
}

export function formatTokenHtml(value, formatter) {
  return `<span class="sc-token-value">${escapeHtml(formatter(value))}</span>`;
}

// ── Data normalization ──

function normalizeShareSummary(raw) {
  if (!raw) return { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const totals = raw.totals || raw;
  return {
    totalTokens: totals.totalTokens || 0,
    inputTokens: totals.inputTokens || 0,
    outputTokens: totals.outputTokens || 0,
    cacheReadTokens: totals.cacheReadTokens || 0,
    cacheWriteTokens: totals.cacheWriteTokens || 0,
    reasoningTokens: totals.reasoningTokens || 0,
    estimatedCostUsd: totals.estimatedCostUsd ?? raw.estimatedCostUsd ?? null,
    inputCostUsd: totals.inputCostUsd ?? raw.inputCostUsd ?? null,
    outputCostUsd: totals.outputCostUsd ?? raw.outputCostUsd ?? null,
    cacheReadCostUsd: totals.cacheReadCostUsd ?? raw.cacheReadCostUsd ?? null,
    cacheWriteCostUsd: totals.cacheWriteCostUsd ?? raw.cacheWriteCostUsd ?? null,
    missingPriceTokens: totals.missingPriceTokens ?? raw.missingPriceTokens ?? null,
    costQuality: totals.costQuality ?? raw.costQuality ?? null
  };
}

function normalizeShareBreakdown(items) {
  if (!Array.isArray(items)) return [];
  const total = items.reduce((sum, item) => sum + (item.totalTokens || item.tokens || 0), 0) || 1;
  return items.map((item) => ({
    name: item.name || "Unknown",
    tokens: item.totalTokens || item.tokens || 0,
    ratio: round((item.totalTokens || item.tokens || 0) / total, 4),
    estimatedCostUsd: item.estimatedCostUsd ?? null,
    missingPriceTokens: item.missingPriceTokens ?? null
  }));
}

export function normalizeLocalShareData(input) {
  const { period, businessDay, identity, summary, trend, workdirs } = input;
  const bounds = sharePeriodBounds(period, businessDay || localDay());
  const totals = normalizeShareSummary(summary);
  const providers = normalizeShareBreakdown(summary?.providers || []);
  const models = normalizeShareBreakdown(summary?.models || []);
  const workdirItems = normalizeShareBreakdown(workdirs || summary?.workdirs || []);

  const items = trend?.items || [];
  const grain = shareTrendGrain(period);
  const trendRows = items.map((item) => ({
    ...item,
    label: item.label || (item.hour != null ? `${item.hour}:00` : (item.day || "").slice(5) || ""),
    totalTokens: item.totalTokens || 0
  }));

  const timeSeries = period === "today"
    ? Array.from({ length: 24 }, (_, h) => {
        const found = items.find((item) => item.hour === h);
        return { hour: h, totalTokens: found?.totalTokens || 0 };
      })
    : trendRows.map((r) => ({ day: r.day || r.label, totalTokens: r.totalTokens }));

  const heatmap = period === "today"
    ? timeSeries.map((item) => ({ hour: item.hour, totalTokens: item.totalTokens }))
    : trendRows.map((r) => ({ day: r.day || r.label, totalTokens: r.totalTokens }));

  return {
    range: period, from: bounds.from, to: bounds.to,
    businessDay: businessDay || localDay(),
    identity: { displayName: identity?.displayName || "Unknown", nickname: identity?.nickname || "", displayId: identity?.displayId },
    mode: "local", rankStats: null, totals, providers, models, workdirs: workdirItems,
    trendRows, trendGrain: grain, timeSeries, heatmap,
    estimatedCostUsd: totals.estimatedCostUsd,
    quoteIndex: randomShareQuoteIndex()
  };
}

export function normalizeCloudShareData(input) {
  const { period, businessDay, identity, analytics } = input;
  const bounds = sharePeriodBounds(period, businessDay || localDay());
  const totals = normalizeShareSummary(analytics?.summary);
  const providers = normalizeShareBreakdown(analytics?.providers || []);
  const models = normalizeShareBreakdown(analytics?.models || []);
  const workdirs = normalizeShareBreakdown(analytics?.workdirs || []);

  const isAnon = identity?.identityMode === "anonymous";
  const mode = isAnon ? "cloud_anonymous" : "cloud_public";

  const trendItems = (analytics?.trend?.items || []);
  const trendRows = trendItems.map((item) => ({
    ...item,
    label: item.label || (item.hour != null ? `${item.hour}:00` : (item.day || "").slice(5) || ""),
    totalTokens: item.totalTokens || 0
  }));

  return {
    range: period, from: analytics?.from || bounds.from, to: analytics?.to || bounds.to,
    businessDay: businessDay || localDay(),
    identity: {
      displayName: isAnon ? identity?.displayName : (identity?.nickname || identity?.displayName || "Unknown"),
      nickname: identity?.nickname || "",
      displayId: identity?.publicId || identity?.displayId,
      anonymousName: isAnon ? identity?.displayName : undefined
    },
    mode, rankStats: analytics?.rankStats || null, totals, providers, models, workdirs,
    trendRows, trendGrain: shareTrendGrain(period),
    timeSeries: [], heatmap: [],
    estimatedCostUsd: totals.estimatedCostUsd,
    quoteIndex: randomShareQuoteIndex()
  };
}

export function withCloudPending(data) {
  return { ...data, mode: "cloud_pending" };
}

// ── Render helpers ──

function compositionParts(totals, t) {
  const total = totals.totalTokens || 1;
  const fields = [
    { key: "inputTokens", label: t("common.input"), tokens: totals.inputTokens, cost: totals.inputCostUsd, color: "#058f7e" },
    { key: "outputTokens", label: t("common.output"), tokens: totals.outputTokens, cost: totals.outputCostUsd, color: "#f4b000" },
    { key: "cacheTokens", label: t("common.cache"), tokens: (totals.cacheReadTokens || 0) + (totals.cacheWriteTokens || 0), cost: (totals.cacheReadCostUsd || 0) + (totals.cacheWriteCostUsd || 0), color: "#9d78dc" }
  ];
  return fields.filter((f) => f.tokens > 0).map((f) => ({ ...f, pct: round((f.tokens / total) * 100, 1) }));
}

function renderShareHeader(data, opts) {
  const { t } = opts;
  const name = escapeHtml(data.identity.nickname || data.identity.displayName || t("app.name"));
  const fromVal = data.from || "";
  const toVal = data.to || "";
  let dateRange = "";

  const todayText = t("desktop.share.period.today") || "今日";
  const isZh = todayText.includes("日") || todayText.includes("今");

  if (data.range === "today") {
    dateRange = toVal;
  } else if (data.range === "7d") {
    dateRange = `${fromVal} ~ ${toVal}`;
  } else if (data.range === "30d") {
    dateRange = `${fromVal} ~ ${toVal}`;
  } else if (data.range === "all") {
    const prefix = isZh ? "截止 " : "Through ";
    dateRange = `${prefix}${toVal}`;
  } else {
    dateRange = fromVal && toVal ? `${fromVal} ~ ${toVal}` : data.range;
  }

  const trophySvg = TROPHY_SVG;
  const medalSvg = MEDAL_SVG;

  // 1. Generate headerStatsHtml (leaderDays & participantCount) to remain in header
  let headerStatsHtml = "";
  if (data.rankStats) {
    const rs = data.rankStats;
    const leaderHtml = rs.leaderDays ? `<span class="sc-rank-stat"><span class="sc-rank-stat-val">${rs.leaderDays}</span><span class="sc-rank-stat-label">${escapeHtml(t("desktop.share.leaderDays"))}</span></span>` : "";
    const pCountHtml = rs.participantCount ? `<span class="sc-rank-stat sc-rank-stat--dark"><span class="sc-rank-stat-val">${rs.participantCount}</span><span class="sc-rank-stat-label">${escapeHtml(t("desktop.share.participants"))}</span></span>` : "";
    if (leaderHtml || pCountHtml) {
      headerStatsHtml = `${leaderHtml}${pCountHtml}`;
    }
  }

  // 2. Generate rankHtml (only the badge) to be placed next to AI labels below
  let rankHtml = "";
  if (data.rankStats) {
    const rs = data.rankStats;
    const rank = rs.rank || 0;
    const medalClass = rank >= 1 && rank <= 3 ? ` sc-medal sc-medal-${rank}` : "";
    const normalClass = rank > 3 ? " sc-rank-normal" : "";
    const rankNum = rank ? `No.${rank}` : t("desktop.share.noRank");
    const medalIcon = rank === 1 ? trophySvg : (rank === 2 || rank === 3) ? medalSvg : "";
    rankHtml = `<span class="sc-rank-badge${medalClass}${normalClass}">${medalIcon}${rankNum}</span>`;
  } else if (data.mode === "local") {
    rankHtml = `<span class="sc-rank-badge sc-rank-local">${escapeHtml(t("desktop.share.localStats"))}</span>`;
  }

  const anonymousCode = data.identity.anonymousName;
  let badgeHtml = "";
  if (opts.showAnonymousName !== false && anonymousCode && String(anonymousCode).trim() !== "") {
    const badgeLabel = isZh ? "今日代号" : "Today's Code";
    badgeHtml = `<span class="sc-code-badge">${escapeHtml(badgeLabel)} · ${escapeHtml(anonymousCode)}</span>`;
  }

  const greeting = isZh ? "我是" : "I am";
  const nameRowHtml = `<div class="sc-header-name-row">
    <span class="sc-header-name">${greeting} ${name}</span>
    ${badgeHtml}
  </div>`;

  const headerHtml = `<div class="sc-header">
    <div class="sc-header-left">
      <span class="sc-brand">${escapeHtml(t("app.name"))}</span>
      ${nameRowHtml}
    </div>
    <div class="sc-header-right">
      <div class="sc-header-meta">
        <span class="sc-header-range">${escapeHtml(dateRange)}</span>
        ${headerStatsHtml}
      </div>
    </div>
  </div>`;

  return { headerHtml, rankHtml };
}

function renderShareHeroScore(data, opts) {
  const { t, formatToken, formatUsd } = opts;
  const total = data.totals.totalTokens;
  const cost = data.totals.estimatedCostUsd ?? data.estimatedCostUsd;

  let costHtml = "";
  if (cost !== null && cost !== undefined) {
    const formattedCost = formatUsd ? formatUsd(cost) : `$${round(cost, 2)}`;
    costHtml = `<span class="sc-hero-cost">${formattedCost}</span>`;
  }

  return `<div class="sc-hero-score">
    <div class="sc-metric-label">${escapeHtml(t("desktop.share.totalTokens"))}</div>
    <div class="sc-total-value">${formatToken(total)}</div>
    <div class="sc-hero-sub">${costHtml}</div>
  </div>`;
}

function renderShareStatCards(data, opts) {
  const { t, formatToken, formatUsd } = opts;
  const parts = compositionParts(data.totals, t);
  if (!parts.length) return "";

  return `<div class="sc-stat-grid">${parts.map((p) => {
    const costText = p.cost !== null && p.cost !== undefined
      ? ` · <span class="sc-stat-cost-val">${formatUsd ? formatUsd(p.cost) : `$${round(p.cost, 2)}`}</span>`
      : "";
    return `<div class="sc-stat-card">
      <span>${escapeHtml(p.label)}</span>
      <strong>${formatToken(p.tokens)}</strong>
      <small class="sc-stat-detail">${p.pct}%${costText}</small>
    </div>`;
  }).join("")}</div>`;
}

function renderShareSparkBars(data, opts) {
  const { t, formatToken, formatUsd, formatAxisLabel } = opts;
  const rows = data.trendRows;
  if (!rows || !rows.length) {
    return `<div class="sc-visual-card sc-spark-section">
      <div><h4 class="sc-card-title">${escapeHtml(t("desktop.overview.usageTrend"))}</h4></div>
      <div class="sc-empty">${escapeHtml(t("desktop.share.noData"))}</div>
    </div>`;
  }

  const max = Math.max(...rows.map((r) => r.totalTokens), 1);
  const peakIdx = rows.reduce((best, row, i) => row.totalTokens > rows[best].totalTokens ? i : best, 0);

  const barsHtml = rows.map((row, i) => {
    const isHot = i === peakIdx;
    const h = Math.max(6, (row.totalTokens / max) * 100);
    const tokensLabel = formatToken(row.totalTokens);

    let costLabel = "-";
    if (row.estimatedCostUsd !== null && row.estimatedCostUsd !== undefined) {
      if (row.estimatedCostUsd === 0 && row.totalTokens > 0 && row.missingPriceTokens > 0) {
        costLabel = "-";
      } else {
        costLabel = formatUsd ? formatUsd(row.estimatedCostUsd) : `$${round(row.estimatedCostUsd, 2)}`;
      }
    }
    return `<div class="sc-spark-bar-wrap">
      <div class="sc-spark-bar${isHot ? " hot" : ""}" style="height:${h}%">
        <div class="sc-spark-val-group">
          <span class="sc-spark-val-tokens">${tokensLabel}</span>
          <span class="sc-spark-val-cost">${costLabel}</span>
        </div>
      </div>
    </div>`;
  }).join("");

  const labelsHtml = rows.map((row) => {
    if (formatAxisLabel) {
      return formatAxisLabel(row, data.trendGrain);
    }
    const label = row.label || (row.hour != null ? `${row.hour}:00` : (row.day || "").slice(5) || "");
    return `<span>${escapeHtml(label)}</span>`;
  }).join("");

  // ── Spark stats (peak / streak / avg) ──
  const todayText = t("desktop.share.period.today") || "今日";
  const isZh = todayText.includes("日") || todayText.includes("今");
  const grain = data.trendGrain || "day";
  const peakRow = rows[peakIdx];
  const hasActive = peakRow.totalTokens > 0;

  const peakTimeStr = hasActive ? (() => {
    if (grain === "hour") {
      const dateStr = data.businessDay || "";
      const m = dateStr.slice(5, 7) || "01";
      const d = dateStr.slice(8, 10) || "01";
      const h = String(peakRow.hour != null ? peakRow.hour : peakRow.label || "00").padStart(2, "0").replace(/:.*$/, "");
      return isZh ? `${m}月${d}日 ${h}:00` : `${m}/${d} ${h}:00`;
    }
    const dateStr = peakRow.day || peakRow.label || "";
    if (dateStr.length >= 10) {
      const m = dateStr.slice(5, 7);
      const d = dateStr.slice(8, 10);
      return isZh ? `${m}月${d}日` : `${m}/${d}`;
    }
    return dateStr;
  })() : "-";

  let currentStreak = 0, maxStreak = 0;
  for (const row of rows) {
    if (row.totalTokens > 0) { currentStreak++; if (currentStreak > maxStreak) maxStreak = currentStreak; }
    else { currentStreak = 0; }
  }

  const streakUnit = grain === "hour" ? (t("desktop.share.hours") || "小时") : (t("desktop.share.days") || "天");
  const sum = rows.reduce((s, r) => s + r.totalTokens, 0);
  const avg = rows.length ? sum / rows.length : 0;

  const peakCardLabel = t("desktop.share.metric.peak") || "最高峰";
  const streakCardLabel = t("desktop.share.metric.streak") || "连续活跃";
  const avgCardLabel = t("desktop.share.metric.avg") || "平均消耗";

  const peakCardValue = hasActive ? `${peakTimeStr} / ${formatToken(peakRow.totalTokens)}` : "-";
  const streakCardValue = `${maxStreak} ${streakUnit}`;
  const avgCardValue = `${formatToken(avg)}${grain === "hour" ? " / 小时" : " / 天"}`;

  const statsHtml = `<div class="sc-spark-stats">
    <div class="sc-spark-stat-card">
      <span class="sc-spark-stat-label">${escapeHtml(peakCardLabel)}</span>
      <strong class="sc-spark-stat-val" title="${escapeHtml(peakCardValue)}">${escapeHtml(peakCardValue)}</strong>
    </div>
    <div class="sc-spark-stat-card">
      <span class="sc-spark-stat-label">${escapeHtml(streakCardLabel)}</span>
      <strong class="sc-spark-stat-val">${escapeHtml(streakCardValue)}</strong>
    </div>
    <div class="sc-spark-stat-card">
      <span class="sc-spark-stat-label">${escapeHtml(avgCardLabel)}</span>
      <strong class="sc-spark-stat-val">${escapeHtml(avgCardValue)}</strong>
    </div>
  </div>`;

  return `<div class="sc-visual-card sc-spark-section">
    <div><h4 class="sc-card-title">${escapeHtml(t("desktop.overview.usageTrend"))}</h4></div>
    <div class="sc-spark-wrap">
      <div class="sc-spark">${barsHtml}</div>
      <div class="sc-spark-axis">${labelsHtml}</div>
    </div>
    ${statsHtml}
  </div>`;
}

function renderShareMiniMeters(items, opts) {
  const { t, formatToken, formatUsd, title, colorClasses = [] } = opts;
  if (!items || !items.length) return `<div class="sc-visual-card"><h4 class="sc-card-title">${escapeHtml(title)}</h4><div class="sc-empty">${escapeHtml(t("desktop.share.noData"))}</div></div>`;

  const max = Math.max(...items.map((item) => item.tokens || item.totalTokens || 0), 1);
  const rowsHtml = items.map((item, i) => {
    const tokens = item.tokens || item.totalTokens || 0;
    const pct = Math.max(3, (tokens / max) * 100);
    const name = escapeHtml(truncateText(item.name, 20));
    const cc = colorClasses[i % colorClasses.length] || "";

    let costLabel = "-";
    if (item.estimatedCostUsd !== null && item.estimatedCostUsd !== undefined) {
      if (item.estimatedCostUsd === 0 && tokens > 0 && item.missingPriceTokens > 0) {
        costLabel = "-";
      } else {
        costLabel = formatUsd ? formatUsd(item.estimatedCostUsd) : `$${round(item.estimatedCostUsd, 2)}`;
      }
    }
    return `<div class="sc-mini-meter-row">
      <span class="sc-meter-name" title="${escapeHtml(item.name)}">${name}</span>
      <span class="sc-meter-val-top">${formatToken(tokens)}</span>
      <div class="sc-mini-meter ${cc}"><i style="width:${pct}%"></i></div>
      <span class="sc-meter-cost">${costLabel}</span>
    </div>`;
  }).join("");

  return `<div class="sc-visual-card">
    <h4 class="sc-card-title">${escapeHtml(title)}</h4>
    <div class="sc-stack">${rowsHtml}</div>
  </div>`;
}

function renderShareFooter(data, opts) {
  const { t, cloudUrl, showCloudUrl, logoUrl } = opts;
  const quote = shareFooterQuote(data, t);
  const url = cloudUrl || "https://ai-token-league.com";
  const logo = logoUrl
    ? `<img class="sc-footer-logo" src="${escapeHtml(logoUrl)}" alt="" />`
    : "";
  const urlHtml = showCloudUrl !== false
    ? `<div class="sc-brand-url">${escapeHtml(url)}</div>`
    : "";

  return `<div class="sc-footer">
    <div class="sc-footer-inner">
      <div class="sc-quote">${escapeHtml(quote)}</div>
      ${logo}
      ${urlHtml}
    </div>
  </div>`;
}

function renderPortraitBrandRow(opts) {
  const { t, logoUrl } = opts;
  const logoHtml = logoUrl
    ? `<img class="sc-portrait-brand-logo" src="${escapeHtml(logoUrl)}" alt="" />`
    : `<span class="sc-portrait-brand-text">${escapeHtml(t("app.name"))}</span>`;
  return `<div class="sc-portrait-brand-row">
    ${logoHtml}
    <span class="sc-portrait-brand-kicker">AI TOKEN LEAGUE</span>
  </div>`;
}

// ── Main render ──

export function renderShareCardHtml(data, opts = {}) {
  const otherLabel = opts.t ? opts.t("desktop.share.other") || "Other" : "Other";
  const sparkCols = data.trendRows?.length || 1;

  const { headerHtml, rankHtml } = renderShareHeader(data, opts);
  const hero = renderShareHeroScore(data, opts);
  const stats = renderShareStatCards(data, opts);
  const sparkBars = renderShareSparkBars(data, opts);
  const providers = renderShareMiniMeters(collapseTop(data.providers, 4, otherLabel), {
    ...opts, title: (opts.t ? opts.t("desktop.share.sources") : null) || "Source mix", colorClasses: ["sc-color-teal", "sc-color-yellow", ""]
  });
  const models = renderShareMiniMeters(collapseTop(data.models, 4, otherLabel), {
    ...opts, title: (opts.t ? opts.t("desktop.share.models") : null) || "Model mix", colorClasses: ["sc-color-violet", "sc-color-yellow", ""]
  });
  const workdirs = renderShareMiniMeters(collapseTop(data.workdirs || [], 4, otherLabel), {
    ...opts, title: (opts.t ? opts.t("desktop.renderer.topWorkdirs") : null) || "Top Workdirs", colorClasses: ["", "sc-color-teal", "sc-color-violet"]
  });
  const footer = renderShareFooter(data, opts);

  const todayText = opts.t ? opts.t("desktop.share.period.today") || "今日" : "今日";
  const isZh = todayText.includes("日") || todayText.includes("今");
  const personas = getAiPersonas(data, isZh, 3);
  const personaPillsHtml = personas.map(persona => `<div class="sc-hero-persona-pill" style="border-color:${persona.color}; box-shadow: 0 4px 12px ${persona.bgHex || "rgba(0,0,0,0.08)"};">
    <span class="sc-hero-persona-label" style="color: ${persona.color};">#</span>
    <span class="sc-hero-persona-divider"></span>
    <span class="sc-hero-persona-text">${escapeHtml(persona.title)}</span>
  </div>`).join("\n");

  return `<div class="sc-root" data-share-card-style="overview" style="--spark-cols:${sparkCols}">
    ${headerHtml}
    <div class="sc-dash-row">
      ${hero}
      <div class="sc-dash-right">
        <div class="sc-dash-top-row">
          ${rankHtml}
          <div class="sc-dash-pills">${personaPillsHtml}</div>
        </div>
        ${stats}
      </div>
    </div>
    <div class="sc-meter-cols">${providers}${models}${workdirs}</div>
    ${sparkBars}
    ${footer}
  </div>`;
}

// ── Portrait heatmap ──

function dayOfWeekShort(dayStr) {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const d = new Date(dayStr + "T00:00:00Z");
  return names[d.getUTCDay()];
}

function monthShort(dayStr) {
  const d = new Date(dayStr + "T00:00:00Z");
  return d.toLocaleString(undefined, { month: "short", timeZone: "UTC" });
}

function pulseAxisLabel(cell, grain) {
  if (grain === "hour") return `${cell.hour}`;
  if (grain === "week") return (cell.day || "").slice(5);
  if (grain === "month") return monthShort(cell.day || "");
  return (cell.day || "").slice(8);
}

function pulseTooltipLabel(cell, grain) {
  if (grain === "hour") return `${cell.hour}:00`;
  return (cell.day || "").slice(5);
}

function pulsePeakLabel(cell, grain) {
  if (grain === "hour") return `${cell.hour}:00`;
  if (grain === "week") return (cell.day || "").slice(5);
  if (grain === "month") return monthShort(cell.day || "");
  return (cell.day || "").slice(5);
}

function formatPeakTime(cell, grain, businessDay, isZh) {
  if (grain === "hour") {
    const dateStr = businessDay || "";
    const m = dateStr.slice(5, 7) || "01";
    const d = dateStr.slice(8, 10) || "01";
    const h = String(cell.hour != null ? cell.hour : "00").padStart(2, "0") + ":00";
    if (isZh) {
      return `${m}月${d}日 ${h}`;
    }
    return `${m}/${d} ${h}`;
  } else {
    const dateStr = cell.day || cell.periodStart || cell.label || "";
    if (dateStr.length >= 10) {
      const m = dateStr.slice(5, 7);
      const d = dateStr.slice(8, 10);
      if (isZh) {
        return `${m}月${d}日`;
      }
      return `${m}/${d}`;
    }
    return dateStr;
  }
}

function renderPortraitHeatmap(data, opts) {
  const { t, formatToken } = opts;
  const cells = data.heatmap;
  if (!cells || !cells.length) {
    return `<div class="sc-visual-card sc-pulse-section">
      <h4 class="sc-card-title">${escapeHtml(t("desktop.share.activity"))}</h4>
      <div class="sc-empty">${escapeHtml(t("desktop.share.noData"))}</div>
    </div>`;
  }

  const grain = data.trendGrain || "day";
  const max = Math.max(...cells.map((c) => c.totalTokens), 1);
  const peakIdx = cells.reduce((best, c, i) => c.totalTokens > cells[best].totalTokens ? i : best, 0);
  const peakCell = cells[peakIdx];
  const hasActive = peakCell.totalTokens > 0;

  // Calculate metrics
  const activeCells = cells.filter(c => c.totalTokens > 0);
  const sum = cells.reduce((s, c) => s + c.totalTokens, 0);
  const avg = cells.length ? sum / cells.length : 0;

  // Longest streak
  let currentStreak = 0;
  let maxStreak = 0;
  for (const cell of cells) {
    if (cell.totalTokens > 0) {
      currentStreak++;
      if (currentStreak > maxStreak) {
        maxStreak = currentStreak;
      }
    } else {
      currentStreak = 0;
    }
  }

  // Detect trough
  let troughIdx = -1;
  if (activeCells.length > 0) {
    const nonPeakActive = activeCells.filter(c => c.totalTokens !== max);
    if (nonPeakActive.length > 0) {
      const minActiveVal = Math.min(...nonPeakActive.map(c => c.totalTokens));
      troughIdx = cells.findIndex(c => c.totalTokens === minActiveVal);
    } else {
      troughIdx = cells.findIndex(c => c.totalTokens === max);
    }
  }

  // Detect spike
  const average = sum / cells.length;
  const spikeIndices = [];
  for (let i = 0; i < cells.length; i++) {
    const val = cells[i].totalTokens;
    if (val === max) continue;
    if (val < 0.15 * max) continue;
    if (val > 2.5 * average) {
      const prevVal = i > 0 ? cells[i-1].totalTokens : 0;
      const nextVal = i < cells.length - 1 ? cells[i+1].totalTokens : 0;
      if (val >= prevVal && val >= nextVal) {
        spikeIndices.push(i);
      }
    }
  }
  const spikeIdx = spikeIndices.length > 0 ? spikeIndices[0] : -1;

  // Coordinate mapping
  const chartW = 560;
  const chartH = 90;
  const padLeft = 20;
  const padTop = 25;

  const points = cells.map((cell, i) => {
    const x = padLeft + (cells.length > 1 ? (i / (cells.length - 1)) * chartW : chartW / 2);
    const ratio = max > 0 ? cell.totalTokens / max : 0;
    const y = padTop + chartH - ratio * chartH;
    return { x, y, val: cell.totalTokens, cell, index: i };
  });

  // SVG Bezier Curve (monotone cubic — smooth with no overshoot)
  const getBezierPath = (pts) => {
    if (pts.length === 0) return "";
    if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const curr = pts[i];
      const next = pts[i + 1];
      const prev = i > 0 ? pts[i - 1] : curr;
      const afterNext = i < pts.length - 2 ? pts[i + 2] : next;
      const dx = next.x - curr.x;
      const dy = next.y - curr.y;
      const slopeCurr = (next.y - prev.y) / ((next.x - prev.x) || 1);
      const slopeNext = (afterNext.y - curr.y) / ((afterNext.x - curr.x) || 1);
      const signCurr = Math.sign(dy) || Math.sign(slopeCurr);
      const signNext = Math.sign(dy) || Math.sign(slopeNext);
      const tanCurr = signCurr === Math.sign(slopeCurr) ? slopeCurr : 0;
      const tanNext = signNext === Math.sign(slopeNext) ? slopeNext : 0;
      const cpX1 = curr.x + dx / 3;
      const cpY1 = curr.y + tanCurr * dx / 3;
      const cpX2 = next.x - dx / 3;
      const cpY2 = next.y - tanNext * dx / 3;
      d += ` C ${cpX1} ${cpY1}, ${cpX2} ${cpY2}, ${next.x} ${next.y}`;
    }
    return d;
  };

  const linePath = getBezierPath(points);
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const areaPath = points.length > 1 ? `${linePath} L ${lastPoint.x} ${padTop + chartH} L ${firstPoint.x} ${padTop + chartH} Z` : "";

  // Render callouts
  let calloutsHtml = "";

  const addAnnotation = (idx, text, type) => {
    if (idx < 0 || idx >= points.length) return;
    const pt = points[idx];
    const pctX = (pt.x / 600) * 100;
    const pctY = (pt.y / 140) * 100;

    calloutsHtml += `<div class="sc-pulse-callout ${type}" style="left:${pctX}%;top:${pctY}%;">
      ${escapeHtml(text)}
    </div>`;
  };


  const labelInterval = cells.length <= 10 ? 1 : cells.length <= 16 ? 2 : cells.length <= 31 ? 5 : Math.ceil(cells.length / 8);
  const showLabel = (cell, idx) => {
    if (grain === "hour") {
      return idx === 0 || idx === 6 || idx === 12 || idx === 18 || idx === 23;
    }
    return idx === 0 || idx === cells.length - 1 || idx % labelInterval === 0;
  };

  const axisHtml = cells.map((cell, i) => {
    const show = showLabel(cell, i);
    return `<span class="sc-pulse-axis-label">${show ? escapeHtml(pulseAxisLabel(cell, grain)) : ""}</span>`;
  }).join("");

  const isZh = (t("desktop.share.period.today") || "今日").includes("日");
  const peakTimeStr = hasActive ? formatPeakTime(peakCell, grain, data.businessDay, isZh) : "-";
  const streakUnit = grain === "hour" ? (t("desktop.share.hours") || "小时") : (t("desktop.share.days") || "天");

  const peakCardLabel = t("desktop.share.metric.peak") || "最高峰";
  const streakCardLabel = t("desktop.share.metric.streak") || "连续活跃";
  const avgCardLabel = t("desktop.share.metric.avg") || "平均消耗";

  const peakCardValue = hasActive ? `${peakTimeStr} / ${formatToken(peakCell.totalTokens)}` : "-";
  const streakCardValue = `${maxStreak} ${streakUnit}`;
  const avgCardValue = `${formatToken(avg)}${grain === "hour" ? " / 小时" : " / 天"}`;

  return `<div class="sc-visual-card sc-pulse-section">
    <div class="sc-pulse-header">
      <h4 class="sc-card-title">${escapeHtml(t("desktop.share.activity"))}</h4>
    </div>
    <div class="sc-pulse-chart">
      <div class="sc-pulse-grid">
        <span></span><span></span><span></span>
      </div>
      <svg class="sc-pulse-svg" viewBox="0 0 600 140" width="100%" height="100%" preserveAspectRatio="none">
        <defs>
          <linearGradient id="line-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#0bb29d" />
            <stop offset="50%" stop-color="#00e676" />
            <stop offset="100%" stop-color="#0bb29d" />
          </linearGradient>
          <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(11, 178, 157, 0.32)" />
            <stop offset="100%" stop-color="rgba(11, 178, 157, 0.00)" />
          </linearGradient>
        </defs>
        ${areaPath ? `<path d="${areaPath}" fill="url(#area-grad)" stroke="none" />` : ""}
        ${linePath ? `<path d="${linePath}" fill="none" stroke="url(#line-grad)" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" />` : ""}
      </svg>
      ${calloutsHtml}
    </div>
    <div class="sc-pulse-axis">${axisHtml}</div>

    <!-- Premium Metrics Row -->
    <div class="sc-pulse-stats">
      <div class="sc-pulse-stat-card">
        <span class="sc-pulse-stat-label">${escapeHtml(peakCardLabel)}</span>
        <strong class="sc-pulse-stat-val" title="${escapeHtml(peakCardValue)}">${escapeHtml(peakCardValue)}</strong>
      </div>
      <div class="sc-pulse-stat-card">
        <span class="sc-pulse-stat-label">${escapeHtml(streakCardLabel)}</span>
        <strong class="sc-pulse-stat-val">${escapeHtml(streakCardValue)}</strong>
      </div>
      <div class="sc-pulse-stat-card">
        <span class="sc-pulse-stat-label">${escapeHtml(avgCardLabel)}</span>
        <strong class="sc-pulse-stat-val">${escapeHtml(avgCardValue)}</strong>
      </div>
    </div>
  </div>`;
}

// ── Portrait card renderer ──

// ── AI Persona Helper ──

const PERSONA_CATALOG = [
  {
    id: "cache_master",
    title: { zh: "缓存刺客", en: "Cache Assassin" },
    color: "#058f7e", bgHex: "rgba(5, 143, 126, 0.06)",
    score: (d) => {
      const total = d.totals.totalTokens || 1;
      const ratio = ((d.totals.cacheReadTokens || 0) + (d.totals.cacheWriteTokens || 0)) / total;
      return ratio > 0.5 ? ratio * 100 : 0;
    }
  },
  {
    id: "claude_geek",
    title: { zh: "Claude 脑残粉", en: "Claude Cultist" },
    color: "#b43b32", bgHex: "rgba(180, 59, 50, 0.06)",
    score: (d) => {
      const top = (d.providers[0]?.name || "").toLowerCase();
      return top.includes("claude") ? 80 + (d.providers[0]?.ratio || 0) * 20 : 0;
    }
  },
  {
    id: "frontier_pioneer",
    title: { zh: "烧钱尝鲜党", en: "Bleeding Edge" },
    color: "#daa520", bgHex: "rgba(218, 165, 32, 0.06)",
    score: (d) => {
      const top = (d.models[0]?.name || "").toLowerCase();
      return (top.includes("gpt-5") || top.includes("o1") || top.includes("o3") || top.includes("o4")) ? 85 : 0;
    }
  },
  {
    id: "token_shredder",
    title: { zh: "Token 碎钞机", en: "Token Incinerator" },
    color: "#9d78dc", bgHex: "rgba(157, 120, 220, 0.06)",
    score: (d) => {
      const t = d.totals.totalTokens || 0;
      if (t > 100000000) return 95;
      if (t > 50000000) return 80;
      if (t > 10000000) return 60;
      return 0;
    }
  },
  {
    id: "output_heavy",
    title: { zh: "话痨养成系", en: "Chatterbox" },
    color: "#e07828", bgHex: "rgba(224, 120, 40, 0.06)",
    score: (d) => {
      const total = d.totals.totalTokens || 1;
      const ratio = (d.totals.outputTokens || 0) / total;
      return ratio > 0.4 ? ratio * 90 : 0;
    }
  },
  {
    id: "reasoning_thinker",
    title: { zh: "沉思的哲学家", en: "Deep Philosopher" },
    color: "#6a8cda", bgHex: "rgba(106, 140, 218, 0.06)",
    score: (d) => {
      const total = d.totals.totalTokens || 1;
      const ratio = (d.totals.reasoningTokens || 0) / total;
      return ratio > 0.1 ? ratio * 120 : 0;
    }
  },
  {
    id: "multi_model",
    title: { zh: "海王型选手", en: "Model Surfer" },
    color: "#c05898", bgHex: "rgba(192, 88, 152, 0.06)",
    score: (d) => {
      const count = (d.models || []).filter(m => m.tokens > 0).length;
      return count >= 3 ? 50 + count * 8 : 0;
    }
  },
  {
    id: "codex_geek",
    title: { zh: "Codex 搭子", en: "Codex Buddy" },
    color: "#10a37f", bgHex: "rgba(16, 163, 127, 0.06)",
    score: (d) => {
      const top = (d.providers[0]?.name || "").toLowerCase();
      return top.includes("codex") ? 80 + (d.providers[0]?.ratio || 0) * 20 : 0;
    }
  },
  {
    id: "cursor_wizard",
    title: { zh: "Cursor 念咒人", en: "Cursor Sorcerer" },
    color: "#7c6aef", bgHex: "rgba(124, 106, 239, 0.06)",
    score: (d) => {
      const top = (d.providers[0]?.name || "").toLowerCase();
      return top.includes("cursor") ? 80 + (d.providers[0]?.ratio || 0) * 20 : 0;
    }
  },
  {
    id: "night_owl",
    title: { zh: "凌晨修仙党", en: "Midnight Alchemist" },
    color: "#4a6cf7", bgHex: "rgba(74, 108, 247, 0.06)",
    score: (d) => {
      const ts = d.timeSeries || [];
      if (ts.length === 0) return 0;
      const nightTokens = ts.filter(h => h.hour != null && (h.hour >= 22 || h.hour < 6))
        .reduce((s, h) => s + (h.totalTokens || 0), 0);
      const totalTokens = ts.reduce((s, h) => s + (h.totalTokens || 0), 0) || 1;
      const ratio = nightTokens / totalTokens;
      return ratio > 0.4 ? ratio * 100 : 0;
    }
  },
  {
    id: "steady_coder",
    title: { zh: "永动机", en: "Perpetual Engine" },
    color: "#2eaa6f", bgHex: "rgba(46, 170, 111, 0.06)",
    score: (d) => {
      const ts = d.timeSeries || [];
      const active = ts.filter(h => (h.totalTokens || 0) > 0);
      if (active.length < 3) return 0;
      const values = active.map(h => h.totalTokens);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
      const cv = Math.sqrt(variance) / (avg || 1);
      return cv < 0.4 ? (1 - cv) * 80 : 0;
    }
  },
  {
    id: "rising_star",
    title: { zh: "越卷越勇", en: "Momentum Rider" },
    color: "#e85d3a", bgHex: "rgba(232, 93, 58, 0.06)",
    score: (d) => {
      const ts = d.timeSeries || [];
      const active = ts.filter(h => (h.totalTokens || 0) > 0);
      if (active.length < 3) return 0;
      const mid = Math.floor(active.length / 2);
      const firstHalf = active.slice(0, mid).reduce((s, h) => s + h.totalTokens, 0);
      const secondHalf = active.slice(mid).reduce((s, h) => s + h.totalTokens, 0);
      if (firstHalf === 0) return 0;
      const growth = secondHalf / firstHalf;
      return growth > 1.5 ? Math.min(growth * 40, 95) : 0;
    }
  },
  {
    id: "winding_down",
    title: { zh: "佛系收工", en: "Zen Mode" },
    color: "#6c8cbe", bgHex: "rgba(108, 140, 190, 0.06)",
    score: (d) => {
      const ts = d.timeSeries || [];
      const active = ts.filter(h => (h.totalTokens || 0) > 0);
      if (active.length < 3) return 0;
      const mid = Math.floor(active.length / 2);
      const firstHalf = active.slice(0, mid).reduce((s, h) => s + h.totalTokens, 0);
      const secondHalf = active.slice(mid).reduce((s, h) => s + h.totalTokens, 0);
      if (secondHalf === 0 || firstHalf === 0) return 0;
      const decline = firstHalf / secondHalf;
      return decline > 1.5 ? Math.min(decline * 40, 95) : 0;
    }
  },
  {
    id: "copilot",
    title: { zh: "AI 最佳拍档", en: "AI Sidekick" },
    color: "#058f7e", bgHex: "rgba(5, 143, 126, 0.06)",
    score: () => 20 // always-present baseline
  }
];

export function getAiPersonas(data, isZh, count = 2) {
  const safeData = {
    totals: data.totals || {},
    providers: data.providers || [],
    models: data.models || [],
    timeSeries: data.timeSeries || []
  };
  const scored = PERSONA_CATALOG.map(p => ({ ...p, s: p.score(safeData) }))
    .filter(p => p.s > 0)
    .sort((a, b) => b.s - a.s);

  const picked = [];
  for (const p of scored) {
    if (picked.length >= count) break;
    if (picked.some(x => x.id === p.id)) continue;
    picked.push({
      id: p.id,
      title: isZh ? p.title.zh : p.title.en,
      color: p.color,
      bgHex: p.bgHex
    });
  }

  // Pad with baseline if we don't have enough
  while (picked.length < count) {
    const fallback = PERSONA_CATALOG[PERSONA_CATALOG.length - 1];
    picked.push({
      id: fallback.id + "_" + picked.length,
      title: isZh ? fallback.title.zh : fallback.title.en,
      color: fallback.color,
      bgHex: fallback.bgHex
    });
  }

  return picked;
}

/** @deprecated Use getAiPersonas instead — kept for backward compat */
export function getAiPersona(data, isZh) {
  const [first] = getAiPersonas(data, isZh, 1);
  return first;
}

export function renderPortraitShareCardHtml(data, opts = {}) {
  const { t, cloudUrl, showCloudUrl, showAnonymousName } = opts;
  const otherLabel = opts.t ? opts.t("desktop.share.other") || "Other" : "Other";

  const name = escapeHtml(data.identity.nickname || data.identity.displayName || t("app.name"));
  const fromVal = data.from || "";
  const toVal = data.to || "";
  const todayText = t("desktop.share.period.today") || "今日";
  const isZh = todayText.includes("日") || todayText.includes("今");
  const greeting = isZh ? "我是" : "I am";

  let dateRange = "";
  if (data.range === "today") {
    dateRange = toVal;
  } else if (data.range === "7d" || data.range === "30d") {
    dateRange = `${fromVal} ~ ${toVal}`;
  } else if (data.range === "all") {
    const prefix = isZh ? "截止 " : "Through ";
    dateRange = `${prefix}${toVal}`;
  } else {
    dateRange = fromVal && toVal ? `${fromVal} ~ ${toVal}` : data.range;
  }

  let heroRankBadge = "";
  if (data.rankStats) {
    const rank = data.rankStats.rank || 0;
    const rankText = rank ? `No.${rank}` : "";
    if (rankText) {
      const medalClass = rank >= 1 && rank <= 3 ? ` sc-medal sc-medal-${rank}` : "";
      const medalIcon = rank === 1 ? TROPHY_SVG : (rank === 2 || rank === 3) ? MEDAL_SVG : "";
      heroRankBadge = `<div class="sc-hero-rank-pill${medalClass}">${medalIcon}<span class="sc-hero-rank-text">${rankText}</span></div>`;
    }
  } else if (data.mode === "local") {
    heroRankBadge = `<div class="sc-hero-rank-pill sc-hero-rank-local"><span class="sc-hero-rank-text">${escapeHtml(t("desktop.share.localStats"))}</span></div>`;
  }

  let rankSubHtml = "";
  if (data.rankStats) {
    const rs = data.rankStats;
    const frags = [];
    if (rs.leaderDays) {
      const label = isZh ? "登顶" : "Led";
      frags.push(`<span class="sc-rank-stat"><span class="sc-rank-stat-val">${rs.leaderDays}</span><span class="sc-rank-stat-label">${label}</span></span>`);
    }
    if (rs.participantCount) {
      const label = isZh ? "人参与" : "players";
      frags.push(`<span class="sc-rank-stat sc-rank-stat--dark"><span class="sc-rank-stat-val">${rs.participantCount}</span><span class="sc-rank-stat-label">${label}</span></span>`);
    }
    if (frags.length) {
      rankSubHtml = `<div class="sc-portrait-header-sub-list">${frags.join("")}</div>`;
    }
  }

  const anonymousCode = data.identity.anonymousName;
  let badgeHtml = "";
  if (opts.showAnonymousName !== false && anonymousCode && String(anonymousCode).trim() !== "") {
    const badgeLabel = isZh ? "今日代号" : "Today's Code";
    badgeHtml = `<span class="sc-code-badge">${escapeHtml(badgeLabel)} · ${escapeHtml(anonymousCode)}</span>`;
  }

  const headerHtml = `<div class="sc-portrait-header">
    <div class="sc-portrait-header-left">
      <div class="sc-portrait-identity-col">
        <span class="sc-portrait-greeting">${greeting} ${name}</span>
        ${badgeHtml}
      </div>
    </div>
    <div class="sc-portrait-header-right">
      <span class="sc-portrait-date">${escapeHtml(dateRange)}</span>
      ${rankSubHtml}
    </div>
  </div>`;

  const heroHtml = renderShareHeroScore(data, opts);
  const modelsHtml = renderShareMiniMeters(collapseTop(data.models, 4, otherLabel), {
    ...opts, title: (opts.t ? opts.t("desktop.share.models") : null) || "Model mix", colorClasses: ["sc-color-violet", "sc-color-yellow", ""]
  });
  const providersHtml = renderShareMiniMeters(collapseTop(data.providers, 4, otherLabel), {
    ...opts, title: (opts.t ? opts.t("desktop.share.sources") : null) || "Source mix", colorClasses: ["sc-color-teal", "sc-color-yellow", ""]
  });
  const heatmapHtml = renderPortraitHeatmap(data, opts);

  const quote = shareFooterQuote(data, t);
  const cloudHtml = (showCloudUrl !== false && cloudUrl)
    ? `<div class="sc-portrait-cloud">${escapeHtml(cloudUrl)}</div>`
    : "";

  const portraitFooter = `<div class="sc-portrait-footer">
    <div class="sc-portrait-quote">${escapeHtml(quote)}</div>
    ${cloudHtml}
  </div>`;

  const personas = getAiPersonas(data, isZh, 2);
  const personaPillsHtml = personas.map(persona => `<div class="sc-hero-persona-pill" style="border-color:${persona.color}; box-shadow: 0 4px 12px ${persona.bgHex || "rgba(0,0,0,0.08)"};">
    <span class="sc-hero-persona-label" style="color: ${persona.color};">#</span>
    <span class="sc-hero-persona-divider"></span>
    <span class="sc-hero-persona-text">${escapeHtml(persona.title)}</span>
  </div>`).join("\n");

  const heroBlockHtml = `<div class="sc-portrait-hero-container">
    <div class="sc-portrait-hero-left">
      ${heroHtml}
    </div>
    <div class="sc-portrait-hero-right">
      ${heroRankBadge}
      ${personaPillsHtml}
    </div>
  </div>`;

  return `<div class="sc-root sc-portrait" data-share-card-style="portrait">
    ${renderPortraitBrandRow(opts)}
    ${headerHtml}
    <div class="sc-portrait-hero-block">
      ${heroBlockHtml}
    </div>
    ${modelsHtml}
    ${providersHtml}
    ${heatmapHtml}
    ${portraitFooter}
  </div>`;
}

export function shareCardCss() {
  return `
.sc-root {
  width: ${SHARE_CARD_WIDTH}px;
  height: auto;
  background:
    linear-gradient(rgba(16, 17, 15, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(16, 17, 15, 0.035) 1px, transparent 1px),
    radial-gradient(circle at 16% 10%, rgba(244, 176, 0, 0.18), transparent 24rem),
    radial-gradient(circle at 86% 18%, rgba(5, 143, 126, 0.15), transparent 25rem),
    #f5efe3;
  background-size: 24px 24px, 24px 24px, auto, auto, auto;
  font-family: ui-serif, Georgia, "Times New Roman", serif;
  color: #10110f;
  overflow: visible;
  display: flex; flex-direction: column;
  padding: 24px 32px 20px;
  box-sizing: border-box;
}

/* ── Header ── */
.sc-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0 18px;
  margin-bottom: 18px;
  border-bottom: 1.5px solid rgba(16, 17, 15, 0.08);
}
.sc-header-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sc-header-right {
  display: flex;
  align-items: center;
}
.sc-brand {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; font-weight: 900; letter-spacing: 0.12em;
  color: #b43b32; text-transform: uppercase;
  text-shadow: 0 1px 1px rgba(0,0,0,0.03);
}
.sc-header-name-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}
.sc-header-name {
  font-size: 22px; font-weight: 800;
  line-height: 1.1;
  color: #10110f;
  letter-spacing: -0.01em;
}
.sc-code-badge {
  background: rgba(5, 143, 126, 0.08);
  color: #058f7e;
  border: 1px solid rgba(5, 143, 126, 0.35);
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 11px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: 0.03em;
  white-space: nowrap;
  box-shadow: 0 2px 6px rgba(5, 143, 126, 0.06);
}
.sc-header-meta {
  display: flex; align-items: center; gap: 16px;
}
.sc-header-range {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px; color: #6f695e; letter-spacing: 0.02em;
  font-weight: 700;
  background: rgba(111, 105, 94, 0.06);
  padding: 5px 14px;
  border-radius: 99px;
  border: 1px solid rgba(111, 105, 94, 0.15);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.02);
}
.sc-rank-strip {
  display: flex; align-items: center; gap: 12px;
}
.sc-rank-badge {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 22px; font-weight: 900;
  color: #fff;
  background: #e8960a;
  padding: 6px 20px; border-radius: 99px;
  border: 2px solid #f5c040;
  box-shadow: 0 4px 14px rgba(244, 176, 0, 0.25);
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.25);
  letter-spacing: 0.04em;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  position: relative;
}
.sc-medal-icon {
  width: 18px; height: 18px;
  flex-shrink: 0;
}
.sc-rank-badge.sc-medal-1 {
  background: #daa520;
  border: 2px solid #f5d060;
  box-shadow: 0 6px 18px rgba(184, 134, 11, 0.3);
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  font-size: 24px;
}
.sc-rank-badge.sc-medal-1 .sc-medal-icon { width: 22px; height: 22px; }
.sc-rank-badge.sc-medal-2 {
  background: #a0a8b0;
  border: 2px solid #c0c8d0;
  box-shadow: 0 4px 14px rgba(140, 147, 157, 0.25);
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.25);
}
.sc-rank-badge.sc-medal-3 {
  background: #b46a2f;
  border: 2px solid #d49060;
  box-shadow: 0 4px 14px rgba(139, 69, 19, 0.25);
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.25);
}
.sc-rank-badge.sc-rank-normal {
  background: #3d8a7a;
  border: 2px solid rgba(5, 143, 126, 0.45);
  box-shadow: 0 4px 12px rgba(5, 143, 126, 0.18);
  font-size: 18px;
}
.sc-rank-badge.sc-rank-local {
  color: #fff;
  background: #3a3b34;
  border: 1px solid rgba(16, 17, 15, 0.4);
  box-shadow: 0 4px 12px rgba(16, 17, 15, 0.15);
  font-size: 13px;
  border-radius: 99px;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.2);
}
.sc-rank-stat {
  display: inline-flex; align-items: center; gap: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: rgba(16, 17, 15, 0.035);
  padding: 5px 12px;
  border-radius: 8px;
  border: none;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.025);
}
.sc-rank-stat--dark {
  background: rgba(16, 17, 15, 0.05);
}
.sc-rank-stat--dark .sc-rank-stat-val {
  color: #10110f;
}
.sc-rank-stat-val {
  font-size: 22px; font-weight: 900; color: #b43b32;
}
.sc-rank-stat-label {
  font-size: 11px; color: #6f695e; font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

/* ── Hero Score — mirrors .hero-score ── */
.sc-hero-score {
  position: relative; overflow: hidden;
  min-height: 100px;
  border: 1px solid rgba(17, 18, 15, 0.35);
  border-radius: 14px;
  background:
    radial-gradient(circle at 78% 18%, rgba(244, 176, 0, 0.28), transparent 12rem),
    linear-gradient(135deg, #171815, #2a2b25);
  color: #f5efe3;
  padding: 16px 20px;
  box-shadow: 0 8px 32px rgba(16, 17, 15, 0.12), 0 2px 6px rgba(16, 17, 15, 0.06);
}
.sc-hero-score::after {
  content: "";
  position: absolute;
  width: 280px; height: 280px;
  right: -76px; bottom: -86px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(5, 143, 126, 0.86), transparent 70%);
}
.sc-hero-score > * { position: relative; z-index: 1; }
.sc-metric-label {
  color: rgba(245, 239, 227, 0.74);
  font-size: 12px; font-weight: 900;
  letter-spacing: 0.04em; text-transform: uppercase;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.sc-total-value {
  margin: 6px 0 2px;
  font-size: 58px; font-weight: 900;
  line-height: 0.92;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.sc-hero-sub {
  display: flex; flex-wrap: wrap; gap: 8px;
  color: rgba(245, 239, 227, 0.8);
}
.sc-hero-sub span {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 19px; font-weight: 900;
  color: rgba(245, 239, 227, 0.92);
}
.sc-hero-cost {
  color: #f4b000 !important;
}

/* ── Stat Cards — mirrors .stat-card ── */
.sc-dash-row {
  display: grid;
  grid-template-columns: minmax(280px, 0.8fr) 1.2fr;
  align-items: stretch;
  gap: 12px;
  margin-bottom: 16px;
}
.sc-dash-right {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-self: stretch;
  min-height: 0;
}
.sc-dash-top-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}
.sc-dash-pills {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 0;
}
.sc-stat-grid {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.sc-stat-card {
  border: none;
  border-radius: 14px;
  background: rgba(255, 251, 243, 0.72);
  min-height: 70px; padding: 8px 14px;
  display: flex; flex-direction: column; justify-content: center;
  box-shadow: 0 4px 20px rgba(16, 17, 15, 0.05), 0 1px 3px rgba(16, 17, 15, 0.04);
}
.sc-stat-card span {
  color: #6f695e; font-size: 13px; font-weight: 900;
}
.sc-stat-card strong {
  font-size: 24px; font-weight: 900; margin-top: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.sc-stat-detail {
  color: #6f695e; font-size: 14px; margin-top: 4px;
}
.sc-stat-cost-val {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
  color: #f4b000 !important;
  font-weight: 900 !important;
}

/* ── Visual Cards — mirrors .visual-card ── */
.sc-visual-card {
  border: none;
  border-radius: 14px;
  background: rgba(255, 251, 243, 0.65);
  padding: 10px 17px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 20px rgba(16, 17, 15, 0.05), 0 1px 3px rgba(16, 17, 15, 0.04);
}
.sc-card-title {
  margin: 0 0 6px; font-size: 20px;
}

/* ── Spark Bars — mirrors .spark ── */
.sc-spark-section { margin-bottom: 12px; }
.sc-spark-wrap { overflow: visible; margin-top: 6px; }
.sc-spark {
  display: grid;
  grid-template-columns: repeat(var(--spark-cols), minmax(0, 1fr));
  align-items: end;
  gap: 6px;
  height: 100px;
  border-bottom: 1.5px solid rgba(16, 17, 15, 0.10);
  padding: 32px 0 0;
  box-sizing: border-box;
}
.sc-spark-bar-wrap {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: flex-end;
  position: relative;
}
.sc-spark-bar {
  width: 100%;
  border: 1px solid rgba(16, 17, 15, 0.10);
  border-bottom: 0;
  border-radius: 6px 6px 0 0;
  background: linear-gradient(180deg, rgba(5, 143, 126, 0.68), rgba(5, 143, 126, 0.18));
  position: relative;
}
.sc-spark-bar.hot {
  background: linear-gradient(180deg, rgba(244, 176, 0, 0.88), rgba(244, 176, 0, 0.24));
}
.sc-spark-val-group {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 4px);
  transform: translateX(-50%);
  display: grid;
  gap: 1px;
  width: max-content;
  text-align: center;
  line-height: 1.1;
  pointer-events: none;
}
.sc-spark-val-tokens {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px; font-weight: 900; color: #10110f;
}
.sc-spark-val-cost {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; font-weight: 700; color: #f4b000;
}
.sc-spark-axis {
  display: grid;
  grid-template-columns: repeat(var(--spark-cols), minmax(0, 1fr));
  gap: 6px;
  text-align: center; font-size: 11px; color: #6f695e;
  margin-top: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-weight: 900; white-space: nowrap;
}
.sc-spark-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-top: 11px;
  padding-top: 11px;
  border-top: 1.5px solid rgba(16, 17, 15, 0.12);
}
.sc-spark-stat-card {
  background: rgba(16, 17, 15, 0.025);
  border: none;
  border-radius: 10px;
  padding: 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-shadow: 0 2px 10px rgba(16, 17, 15, 0.03);
}
.sc-spark-stat-label {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 800;
  color: #6f695e;
  text-transform: uppercase;
}
.sc-spark-stat-val {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  font-weight: 900;
  color: #10110f;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Mini Meters — mirrors .mini-meter-row ── */
.sc-meter-cols {
  display: grid; grid-template-columns: repeat(3, 1fr);
  align-items: stretch;
  gap: 12px; margin-bottom: 16px;
}
.sc-stack { display: grid; gap: 7px; flex: 1 1 auto; align-content: start; }
.sc-mini-meter-row {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  gap: 2px 8px;
  min-height: 32px;
  font-size: 16px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-weight: 900;
  align-items: center;
}
.sc-mini-meter-row .sc-meter-name {
  min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sc-mini-meter-row .sc-meter-val-top { align-self: end; text-align: right; line-height: 1.15; }
.sc-mini-meter-row .sc-mini-meter { grid-column: 1; align-self: center; }
.sc-mini-meter-row .sc-meter-cost {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-height: 12px;
  align-self: center;
  text-align: right;
  font-size: 12px;
  line-height: 1;
}
.sc-mini-meter {
  height: 12px; overflow: hidden;
  border: none;
  border-radius: 999px;
  background: rgba(16, 17, 15, 0.06);
  box-shadow: inset 0 1px 3px rgba(16, 17, 15, 0.06);
}
.sc-mini-meter i {
  display: block; height: 100%; border-radius: 999px;
  background: #058f7e;
}
.sc-mini-meter.sc-color-teal i { background: #058f7e; }
.sc-mini-meter.sc-color-yellow i { background: #f4b000; }
.sc-mini-meter.sc-color-violet i { background: #9d78dc; }
.sc-meter-cost {
  font-size: 12px;
  font-weight: 700;
  color: #f4b000;
}

/* ── Footer ── */
.sc-footer {
  margin-top: auto;
  flex-shrink: 0;
  display: flex; flex-direction: column;
  justify-content: flex-end;
  padding-top: 12px;
}
.sc-footer-inner {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 14px;
  border-top: 1px solid rgba(16, 17, 15, 0.15);
  padding-top: 10px;
  padding-bottom: 3px;
}
.sc-quote {
  grid-column: 1;
  font-style: italic; font-size: 13px; line-height: 1.5;
  color: #6f695e; min-width: 0;
}
.sc-brand-url {
  grid-column: 3;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; color: #9e9890; text-align: right; white-space: nowrap;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sc-footer-logo {
  grid-column: 2;
  height: 16px; width: auto; object-fit: contain;
  opacity: 0.7;
  justify-self: center;
  max-width: 180px;
}

/* ── Empty state ── */
.sc-empty {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; color: #6f695e; padding: 16px 0;
}

/* ── Persona pills (shared) ── */
.sc-hero-persona-pill {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgba(16, 17, 15, 0.04);
  color: #111111;
  border: 1px solid rgba(16, 17, 15, 0.10);
  border-radius: 12px;
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  font-weight: 900;
  letter-spacing: 0.04em;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  text-align: center;
  box-sizing: border-box;
}
.sc-hero-persona-label {
  font-size: 10px;
  font-weight: 900;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  white-space: nowrap;
}
.sc-hero-persona-divider {
  width: 1px;
  height: 12px;
  background: rgba(16, 17, 15, 0.15);
  flex-shrink: 0;
}
.sc-hero-persona-text {
  display: flex;
  align-items: center;
  gap: 4px;
  font-weight: 900;
  letter-spacing: 0.02em;
  -webkit-text-stroke: 0.4px currentColor;
  white-space: nowrap;
}
.sc-hero-persona-pill .sc-persona-icon {
  width: 12px;
  height: 12px;
  color: #daa520;
  flex-shrink: 0;
}
.sc-hero-code-label {
  font-size: 10px;
  font-weight: 700;
  opacity: 0.8;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.sc-hero-code-val {
  font-size: 13px;
  font-weight: 900;
  margin-top: 2px;
  letter-spacing: 0.02em;
}
`;
}

export function portraitShareCardCss() {
  return `
.sc-root.sc-portrait {
  width: ${PORTRAIT_CARD_WIDTH}px;
  height: auto;
  padding: 28px 32px;
  gap: 17px;
}

.sc-portrait-brand-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 30px;
  padding-bottom: 2px;
}
.sc-portrait-brand-logo {
  max-width: 172px;
  max-height: 28px;
  object-fit: contain;
}
.sc-portrait-brand-text,
.sc-portrait-brand-kicker {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.12em;
  color: #b43b32;
  text-transform: uppercase;
}
.sc-portrait-brand-kicker {
  color: #6f695e;
  font-size: 10px;
}

/* ── Portrait header ── */
.sc-portrait-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 9px 0 18px;
  border-bottom: 1.5px solid rgba(16, 17, 15, 0.08);
}
.sc-portrait-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.sc-portrait-identity-col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.sc-portrait-header-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.sc-portrait-greeting {
  font-size: 26px; font-weight: 800;
  font-family: ui-serif, Georgia, "Times New Roman", serif;
  color: #10110f;
}
.sc-portrait-rank {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 19px; font-weight: 950;
  background: #3d8a7a; color: #fff;
  padding: 4px 14px; border-radius: 99px;
  display: inline-flex; align-items: center; gap: 6px;
  box-shadow: 0 4px 12px rgba(61, 138, 122, 0.2);
  letter-spacing: 0.02em;
}
.sc-portrait-rank.sc-medal {
  font-size: 22px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
}
.sc-portrait-rank.sc-medal-1 {
  background: #daa520;
  border: 2px solid #f5d060;
  box-shadow: 0 6px 18px rgba(218, 165, 32, 0.3);
}
.sc-portrait-rank.sc-medal-2 {
  background: #a0a8b0;
  border: 2px solid #c0c8d0;
  box-shadow: 0 4px 14px rgba(160, 168, 176, 0.25);
}
.sc-portrait-rank.sc-medal-3 {
  background: #b46a2f;
  border: 2px solid #d49060;
  box-shadow: 0 4px 14px rgba(180, 106, 47, 0.25);
}
.sc-portrait-rank-local {
  color: #fff;
  background: #3a3b34;
  border: 1px solid rgba(16, 17, 15, 0.4);
  box-shadow: 0 4px 12px rgba(16, 17, 15, 0.15);
  font-size: 13px;
  padding: 4px 14px;
}
.sc-portrait-rank .sc-medal-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}
.sc-portrait-rank.sc-medal-1 .sc-medal-icon {
  width: 22px;
  height: 22px;
}
.sc-portrait-badge-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.sc-persona-badge {
  display: inline-flex;
  align-items: center;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: 0.03em;
  white-space: nowrap;
  border: 1px solid currentColor;
  box-shadow: 0 2px 6px rgba(16, 17, 15, 0.04);
}
.sc-persona-icon {
  width: 12px;
  height: 12px;
  margin-right: 4px;
  flex-shrink: 0;
}
.sc-portrait-date {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 16px; color: #6f695e; font-weight: 700;
  background: rgba(111, 105, 94, 0.06);
  padding: 5px 14px;
  border-radius: 99px;
  border: 1px solid rgba(111, 105, 94, 0.15);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.02);
}
.sc-portrait-header-sub-list {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ── Portrait hero block ── */
.sc-portrait-hero-block {  }
.sc-portrait-hero-container {
  display: grid;
  grid-template-columns: 3fr 1fr;
  gap: 12px;
  width: 100%;
}
.sc-portrait-hero-left {
  display: flex;
  flex-direction: column;
}
.sc-portrait-hero-left .sc-hero-score {
  flex: 1;
  min-height: 100px;
  padding-bottom: 28px;
  box-sizing: border-box;
}
.sc-portrait-hero-block .sc-metric-label { font-size: 14px; }
.sc-portrait-hero-block .sc-total-value { font-size: 70px; }
.sc-portrait-hero-block .sc-hero-sub span { font-size: 23px; }

.sc-portrait-hero-right {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 8px;
}
.sc-hero-rank-pill {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: #3d8a7a;
  color: #fff;
  border-radius: 12px;
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 16px;
  font-weight: 950;
  box-shadow: 0 4px 12px rgba(61, 138, 122, 0.15);
  border: 1.5px solid rgba(61, 138, 122, 0.4);
  text-shadow: 0 1px 2px rgba(0,0,0,0.2);
  text-align: center;
  box-sizing: border-box;
}
.sc-hero-rank-pill.sc-medal-1 {
  background: linear-gradient(135deg, #daa520, #b8860b);
  border: 1.5px solid #f5d060;
  box-shadow: 0 6px 18px rgba(218, 165, 32, 0.25);
  font-size: 18px;
}
.sc-hero-rank-pill.sc-medal-2 {
  background: linear-gradient(135deg, #a0a8b0, #707880);
  border: 1.5px solid #c0c8d0;
  box-shadow: 0 4px 14px rgba(160, 168, 176, 0.2);
}
.sc-hero-rank-pill.sc-medal-3 {
  background: linear-gradient(135deg, #b46a2f, #8b4513);
  border: 1.5px solid #d49060;
  box-shadow: 0 4px 14px rgba(180, 106, 47, 0.2);
}
.sc-hero-rank-local {
  background: linear-gradient(135deg, #2b2c28, #1c1d1a);
  border: 1px solid rgba(16,17,15,0.4);
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
  font-size: 13px;
}
.sc-hero-rank-text {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}



/* ── Portrait stat cards ── */
.sc-portrait .sc-stat-card span { font-size: 19px; }
.sc-portrait .sc-stat-card strong { font-size: 29px; }
.sc-portrait .sc-stat-detail { font-size: 17px; }

/* ── Portrait mini meters ── */
.sc-portrait .sc-card-title { font-size: 24px; }
.sc-portrait .sc-mini-meter-row {
  font-size: 19px; min-height: 38px;
  grid-template-rows: auto auto;
  align-content: start;
}
.sc-portrait .sc-meter-val-top { font-size: 19px; }
.sc-portrait .sc-meter-cost { font-size: 14px; }

/* ── Portrait layout overrides ── */
.sc-portrait .sc-dash-row {
  grid-template-columns: 1fr;
  gap: 15px;
}
.sc-portrait .sc-stat-grid {
  grid-template-columns: repeat(3, 1fr);
}
.sc-portrait .sc-stat-card { min-height: 82px; padding: 10px 16px; border-radius: 14px; }
.sc-portrait .sc-meter-cols {
  grid-template-columns: 1fr;
  gap: 15px;
}
.sc-portrait .sc-visual-card {
  border: none !important;
  background: rgba(255, 251, 243, 0.68) !important;
  box-shadow: 0 6px 24px rgba(16, 17, 15, 0.04), 0 1px 4px rgba(16, 17, 15, 0.03) !important;
}

/* ── Portrait activity pulse ── */
/* ── Portrait activity pulse (SVG Line Chart Upgrade) ── */
.sc-pulse-section { padding: 12px 16px; position: relative; }
.sc-pulse-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.sc-pulse-chart {
  position: relative;
  height: 190px !important;
  margin-top: 10px;
  overflow: visible;
}
.sc-pulse-grid {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  pointer-events: none;
  z-index: 1;
}
.sc-pulse-grid span {
  border-bottom: 1px dashed rgba(16, 17, 15, 0.05);
}
.sc-pulse-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  z-index: 2;
}
.sc-pulse-marker .sc-pulse-halo {
  fill: none;
  stroke-width: 1.5;
  opacity: 0.45;
}
.sc-pulse-marker.peak .sc-pulse-halo {
  stroke: #f4b000;
  animation: pulse-ring 2.2s infinite ease-in-out;
}
.sc-pulse-marker.summit .sc-pulse-halo {
  stroke: #daa520;
  animation: pulse-ring 2.2s infinite ease-in-out;
}
.sc-pulse-marker.trough .sc-pulse-halo {
  stroke: #3d8a7a;
}
.sc-pulse-marker.spike .sc-pulse-halo {
  stroke: #b43b32;
  animation: pulse-ring 1.8s infinite ease-in-out;
}
.sc-pulse-marker .sc-pulse-dot {
  stroke: #fff;
  stroke-width: 1.5;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
}
.sc-pulse-marker.peak .sc-pulse-dot { fill: #f4b000; }
.sc-pulse-marker.summit .sc-pulse-dot { fill: #daa520; }
.sc-pulse-marker.trough .sc-pulse-dot { fill: #3d8a7a; }
.sc-pulse-marker.spike .sc-pulse-dot { fill: #b43b32; }

.sc-pulse-node {
  fill: #fff;
  stroke: #0bb29d;
  stroke-width: 1.5;
}

.sc-pulse-callout {
  position: absolute;
  transform: translate(-50%, -100%);
  margin-top: -10px;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 900;
  padding: 3px 8px;
  border-radius: 6px;
  z-index: 10;
  pointer-events: none;
  box-shadow: 0 4px 10px rgba(16, 17, 15, 0.15);
  transition: all 0.25s ease;
  letter-spacing: 0.02em;
}
.sc-pulse-callout.peak {
  background: #f4b000;
  color: #10110f;
  border: 1.5px solid #f5d060;
}
.sc-pulse-callout.summit {
  background: #daa520;
  color: #fff;
  border: 1.5px solid #f5d060;
}
.sc-pulse-callout.trough {
  background: #3d8a7a;
  color: #fff;
  border: 1.5px solid #5fb3a2;
}
.sc-pulse-callout.spike {
  background: #b43b32;
  color: #fff;
  border: 1.5px solid #e05a4f;
}

.sc-pulse-axis {
  display: flex;
  margin-top: 8px;
  border-top: 1.5px solid rgba(16, 17, 15, 0.08);
  padding-top: 6px;
}
.sc-pulse-axis-label {
  flex: 1;
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 900;
  color: #6f695e;
}

.sc-pulse-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1.5px solid rgba(16, 17, 15, 0.12);
}
.sc-pulse-stat-card {
  background: rgba(16, 17, 15, 0.025);
  border: none;
  border-radius: 10px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-shadow: 0 2px 10px rgba(16, 17, 15, 0.03);
}
.sc-pulse-stat-label {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 800;
  color: #6f695e;
  text-transform: uppercase;
}
.sc-pulse-stat-val {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  font-weight: 900;
  color: #10110f;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@keyframes pulse-ring {
  0% { transform: scale(0.9); opacity: 0.9; }
  50% { transform: scale(1.6); opacity: 0.15; }
  100% { transform: scale(0.9); opacity: 0.9; }
}

/* ── Portrait quote & cloud footer ── */
.sc-portrait-footer {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 19px;
  border-top: 1px solid rgba(16, 17, 15, 0.12);
}
.sc-portrait-quote {
  font-style: italic; font-size: 17px; line-height: 1.5;
  color: #6f695e;
  text-align: center;
}
.sc-portrait-cloud {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px; color: #9e9890;
  text-align: center;
  padding-bottom: 4px;
}
`;
}

// ── Polaroid export frame ──

const POLAROID_PAD_SIDE = 18;
const POLAROID_PAD_TOP = 18;
const POLAROID_PAD_BOTTOM = 44;

export const POLAROID_EXPORT_WIDTH = SHARE_CARD_WIDTH + POLAROID_PAD_SIDE * 2;
export const POLAROID_EXPORT_HEIGHT = SHARE_CARD_HEIGHT + POLAROID_PAD_TOP + POLAROID_PAD_BOTTOM;

export function polaroidDimensions(orientation = "landscape", contentHeight = null) {
  const cardW = orientation === "portrait" ? PORTRAIT_CARD_WIDTH : SHARE_CARD_WIDTH;
  const defaultCardH = orientation === "portrait" ? PORTRAIT_CARD_HEIGHT : SHARE_CARD_HEIGHT;
  const measuredCardH = Number.isFinite(contentHeight) && contentHeight > 0
    ? Math.ceil(contentHeight)
    : defaultCardH;
  return {
    cardWidth: cardW,
    cardHeight: measuredCardH,
    exportWidth: cardW + POLAROID_PAD_SIDE * 2,
    exportHeight: measuredCardH + POLAROID_PAD_TOP + POLAROID_PAD_BOTTOM
  };
}

export function polaroidExportCss(orientation = "landscape", contentHeight = null) {
  const dims = polaroidDimensions(orientation, contentHeight);
  return `
.pe-frame {
  width: ${dims.exportWidth}px;
  height: ${dims.exportHeight}px;
  background: #fff;
  border-radius: 6px;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.18),
    0 2px 8px rgba(0, 0, 0, 0.10);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
  padding: ${POLAROID_PAD_TOP}px ${POLAROID_PAD_SIDE}px 0 ${POLAROID_PAD_SIDE}px;
}
.pe-image-area {
  flex: 0 0 ${dims.cardHeight}px;
  overflow: hidden;
  border-radius: 4px;
  position: relative;
}
.pe-image-area::after {
  content: "";
  position: absolute;
  inset: 0;
  box-shadow: inset 0 0 14px rgba(0, 0, 0, 0.06);
  pointer-events: none;
  border-radius: 4px;
}
.pe-caption-area {
  flex: 0 0 ${POLAROID_PAD_BOTTOM}px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pe-caption {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 14px;
  color: #999;
  letter-spacing: 0.03em;
}
`;
}

export function renderExportPolaroidHtml(cardInnerHtml, caption) {
  return `<div class="pe-frame"><div class="pe-image-area">${cardInnerHtml}</div><div class="pe-caption-area"><span class="pe-caption">${escapeHtml(caption)}</span></div></div>`;
}
