// share-card.js — Overview-based share card renderer (portrait + landscape)

import { localDay } from "../shared/date.js";

// ── Constants ──

export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 720;
export const SHARE_QUOTE_COUNT = 12;

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
  return { from: day, to: day };
}

export function shareRangeForPeriod(period, businessDay) {
  const { from, to } = sharePeriodBounds(period, businessDay);
  return `${from}..${to}`;
}

export function shareTrendGrain(period) {
  if (period === "today") return "hour";
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

  const trophySvg = `<svg class="sc-medal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a1 1 0 0 1 0-5H6"/><path d="M18 9h1.5a1 1 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17a2 2 0 0 1-.976 1.696A5 5 0 0 0 7 22"/><path d="M14 14.66V17a2 2 0 0 0 .976 1.696A5 5 0 0 1 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`;
  const medalSvg = `<svg class="sc-medal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15"/><path d="M11 12 5.12 2.2"/><path d="m13 12 5.88-9.8"/><path d="M8 7h8"/><circle cx="12" cy="17" r="5"/><path d="M12 18v-2h-.5"/></svg>`;

  let rankHtml = "";
  if (data.rankStats) {
    const rs = data.rankStats;
    const rank = rs.rank || 0;
    const medalClass = rank >= 1 && rank <= 3 ? ` sc-medal sc-medal-${rank}` : "";
    const normalClass = rank > 3 ? " sc-rank-normal" : "";
    const rankNum = rank ? `No.${rank}` : t("desktop.share.noRank");
    const medalIcon = rank === 1 ? trophySvg : (rank === 2 || rank === 3) ? medalSvg : "";
    const leaderHtml = rs.leaderDays ? `<span class="sc-rank-stat"><span class="sc-rank-stat-val">${rs.leaderDays}</span><span class="sc-rank-stat-label">${escapeHtml(t("desktop.share.leaderDays"))}</span></span>` : "";
    const pCountHtml = rs.participantCount ? `<span class="sc-rank-stat sc-rank-stat--dark"><span class="sc-rank-stat-val">${rs.participantCount}</span><span class="sc-rank-stat-label">${escapeHtml(t("desktop.share.participants"))}</span></span>` : "";
    rankHtml = `<div class="sc-rank-strip"><span class="sc-rank-badge${medalClass}${normalClass}">${medalIcon}${rankNum}</span>${leaderHtml}${pCountHtml}</div>`;
  } else if (data.mode === "local") {
    rankHtml = `<div class="sc-rank-strip"><span class="sc-rank-badge sc-rank-local">${escapeHtml(t("desktop.share.localStats"))}</span></div>`;
  }

  const anonymousCode = data.identity.anonymousName;
  let badgeHtml = "";
  if (anonymousCode && String(anonymousCode).trim() !== "") {
    const badgeLabel = isZh ? "今日代号" : "Today's Code";
    badgeHtml = `<span class="sc-code-badge">${escapeHtml(badgeLabel)} · ${escapeHtml(anonymousCode)}</span>`;
  }

  const greeting = isZh ? "我是" : "I am";
  const nameRowHtml = `<div class="sc-header-name-row">
    <span class="sc-header-name">${greeting} ${name}</span>
    ${badgeHtml}
  </div>`;

  return `<div class="sc-header">
    <div class="sc-header-left">
      <span class="sc-brand">${escapeHtml(t("app.name"))}</span>
      ${nameRowHtml}
    </div>
    <div class="sc-header-right">
      <div class="sc-header-meta">
        <span class="sc-header-range">${escapeHtml(dateRange)}</span>
        ${rankHtml}
      </div>
    </div>
  </div>`;
}

function renderShareHeroScore(data, opts) {
  const { t, formatToken, formatUsd } = opts;
  const total = data.totals.totalTokens;
  const cost = data.totals.estimatedCostUsd ?? data.estimatedCostUsd;

  let costHtml = "";
  if (cost !== null && cost !== undefined) {
    const formattedCost = formatUsd ? formatUsd(cost) : `$${round(cost, 2)}`;
    const hasAsterisk = data.totals.missingPriceTokens > 0 ? " *" : "";
    const isEstimated = data.totals.costQuality === "estimated_price" || data.totals.costQuality === "unknown_price"
      ? ` <span class="sc-cost-estimate">${escapeHtml(t("common.estimated").toLowerCase())}</span>`
      : "";
    costHtml = `<span class="sc-hero-cost">${formattedCost}${hasAsterisk}</span>${isEstimated}`;
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
    const hasAsterisk = row.missingPriceTokens > 0 ? " *" : "";

    return `<div class="sc-spark-bar-wrap">
      <div class="sc-spark-bar${isHot ? " hot" : ""}" style="height:${h}%">
        <div class="sc-spark-val-group">
          <span class="sc-spark-val-tokens">${tokensLabel}</span>
          <span class="sc-spark-val-cost">${costLabel}${hasAsterisk}</span>
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

  return `<div class="sc-visual-card sc-spark-section">
    <div><h4 class="sc-card-title">${escapeHtml(t("desktop.overview.usageTrend"))}</h4></div>
    <div class="sc-spark-wrap">
      <div class="sc-spark">${barsHtml}</div>
      <div class="sc-spark-axis">${labelsHtml}</div>
    </div>
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
    const hasAsterisk = item.missingPriceTokens > 0 ? " *" : "";

    return `<div class="sc-mini-meter-row">
      <span class="sc-meter-name" title="${escapeHtml(item.name)}">${name}</span>
      <div class="sc-mini-meter ${cc}"><i style="width:${pct}%"></i></div>
      <span class="sc-meter-value">
        <strong>${formatToken(tokens)}</strong>
        <small class="sc-meter-cost">${costLabel}${hasAsterisk}</small>
      </span>
    </div>`;
  }).join("");

  return `<div class="sc-visual-card">
    <h4 class="sc-card-title">${escapeHtml(title)}</h4>
    <div class="sc-stack">${rowsHtml}</div>
  </div>`;
}

function renderShareFooter(data, opts) {
  const { t, cloudUrl, logoUrl } = opts;
  const quote = shareFooterQuote(data, t);
  const url = cloudUrl || "https://ai-token-league.com";
  const logo = logoUrl
    ? `<img class="sc-footer-logo" src="${escapeHtml(logoUrl)}" alt="" />`
    : "";

  return `<div class="sc-footer">
    <div class="sc-footer-inner">
      <div class="sc-quote">${escapeHtml(quote)}</div>
      ${logo}
      <div class="sc-brand-url">${escapeHtml(url)}</div>
    </div>
  </div>`;
}

// ── Main render ──

export function renderShareCardHtml(data, opts = {}) {
  const otherLabel = opts.t ? opts.t("desktop.share.other") || "Other" : "Other";
  const sparkCols = data.trendRows?.length || 1;

  const header = renderShareHeader(data, opts);
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

  return `<div class="sc-root" data-share-card-style="overview" style="--spark-cols:${sparkCols}">
    ${header}
    <div class="sc-dash-row">
      ${hero}
      ${stats}
    </div>
    <div class="sc-meter-cols">${providers}${models}${workdirs}</div>
    ${sparkBars}
    ${footer}
  </div>`;
}

export function shareCardCss() {
  return `
.sc-root {
  width: ${SHARE_CARD_WIDTH}px; height: ${SHARE_CARD_HEIGHT}px;
  background:
    linear-gradient(rgba(16, 17, 15, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(16, 17, 15, 0.035) 1px, transparent 1px),
    radial-gradient(circle at 16% 10%, rgba(244, 176, 0, 0.18), transparent 24rem),
    radial-gradient(circle at 86% 18%, rgba(5, 143, 126, 0.15), transparent 25rem),
    #f5efe3;
  background-size: 24px 24px, 24px 24px, auto, auto, auto;
  font-family: ui-serif, Georgia, "Times New Roman", serif;
  color: #10110f;
  overflow: hidden;
  display: flex; flex-direction: column;
  padding: 24px 32px;
  box-sizing: border-box;
}

/* ── Header ── */
.sc-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0 24px;
  margin-bottom: 16px;
  border-bottom: 1.5px solid rgba(16, 17, 15, 0.12);
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
  background: rgba(16, 17, 15, 0.04);
  padding: 5px 12px;
  border-radius: 8px;
  border: 1px solid rgba(16, 17, 15, 0.08);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.02);
}
.sc-rank-stat--dark {
  background: rgba(16, 17, 15, 0.06);
  border: 1px solid rgba(16, 17, 15, 0.12);
}
.sc-rank-stat--dark .sc-rank-stat-val {
  color: #10110f;
}
.sc-rank-stat-val {
  font-size: 18px; font-weight: 900; color: #b43b32;
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
  border: 1px solid #11120f;
  border-radius: 12px;
  background:
    radial-gradient(circle at 78% 18%, rgba(244, 176, 0, 0.28), transparent 12rem),
    linear-gradient(135deg, #171815, #2a2b25);
  color: #f5efe3;
  padding: 16px 20px;
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
  font-size: 48px; font-weight: 900;
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
  font-size: 16px; font-weight: 900;
  color: rgba(245, 239, 227, 0.92);
}
.sc-hero-cost {
  color: #f4b000 !important;
}
.sc-cost-estimate {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 14px;
  font-weight: 700;
  color: #f4b000;
  margin-left: 6px;
}

/* ── Stat Cards — mirrors .stat-card ── */
.sc-dash-row {
  display: grid;
  grid-template-columns: minmax(280px, 0.8fr) 1.2fr;
  align-items: start;
  gap: 12px;
  margin-bottom: 10px;
}
.sc-stat-grid {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.sc-stat-card {
  border: 1px solid #11120f;
  border-radius: 12px;
  background: rgba(255, 249, 237, 0.78);
  min-height: 70px; padding: 8px 14px;
  display: flex; flex-direction: column; justify-content: center;
}
.sc-stat-card span {
  color: #6f695e; font-size: 13px; font-weight: 900;
}
.sc-stat-card strong {
  font-size: 20px; font-weight: 900; margin-top: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.sc-stat-detail {
  color: #6f695e; font-size: 12px; margin-top: 4px;
}
.sc-stat-cost-val {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
  color: #f4b000 !important;
  font-weight: 900 !important;
}

/* ── Visual Cards — mirrors .visual-card ── */
.sc-visual-card {
  border: 1px solid #11120f;
  border-radius: 12px;
  background: rgba(255, 249, 237, 0.78);
  padding: 10px 16px;
}
.sc-card-title {
  margin: 0 0 6px; font-size: 20px;
}

/* ── Spark Bars — mirrors .spark ── */
.sc-spark-section { margin-bottom: 0; }
.sc-spark-wrap { overflow: visible; margin-top: 6px; }
.sc-spark {
  display: grid;
  grid-template-columns: repeat(var(--spark-cols), minmax(0, 1fr));
  align-items: end;
  gap: 6px;
  height: 140px;
  border-bottom: 1px solid #11120f;
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
  border: 1px solid rgba(16, 17, 15, 0.25);
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
  font-size: 11px; font-weight: 900; color: #10110f;
}
.sc-spark-val-cost {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px; font-weight: 700; color: #f4b000;
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

/* ── Mini Meters — mirrors .mini-meter-row ── */
.sc-meter-cols {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 12px; margin-bottom: 10px;
}
.sc-stack { display: grid; gap: 6px; }
.sc-mini-meter-row {
  display: grid;
  grid-template-columns: minmax(70px, 1fr) minmax(40px, 0.72fr) minmax(60px, auto);
  align-items: center; gap: 10px;
  min-height: 32px;
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-weight: 900;
}
.sc-mini-meter-row span:first-child {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sc-mini-meter-row span:last-child { text-align: right; }
.sc-meter-value {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  line-height: 1.1;
}
.sc-meter-value strong { font-size: 13px; color: #10110f; }
.sc-mini-meter {
  height: 12px; overflow: hidden;
  border: 1px solid rgba(16, 17, 15, 0.22);
  border-radius: 999px;
  background: rgba(16, 17, 15, 0.08);
}
.sc-mini-meter i {
  display: block; height: 100%; border-radius: 999px;
  background: #058f7e;
}
.sc-mini-meter.sc-color-teal i { background: #058f7e; }
.sc-mini-meter.sc-color-yellow i { background: #f4b000; }
.sc-mini-meter.sc-color-violet i { background: #9d78dc; }
.sc-meter-cost {
  font-size: 10px;
  font-weight: 700;
  color: #f4b000;
  margin-top: 1px;
}

/* ── Footer ── */
.sc-footer {
  flex: 1;
  display: flex; flex-direction: column;
  justify-content: flex-end;
  padding-top: 6px;
}
.sc-footer-inner {
  display: flex; justify-content: space-between; align-items: center;
  border-top: 1px solid rgba(16, 17, 15, 0.15);
  padding-top: 6px;
  padding-bottom: 2px;
}
.sc-quote {
  font-style: italic; font-size: 13px; line-height: 1.5;
  color: #6f695e; max-width: 70%;
}
.sc-brand-url {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; color: #9e9890; text-align: right; white-space: nowrap;
}
.sc-footer-inner { position: relative; }
.sc-footer-logo {
  position: absolute; left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  height: 16px; width: auto; object-fit: contain;
  opacity: 0.7;
}

/* ── Empty state ── */
.sc-empty {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; color: #6f695e; padding: 16px 0;
}
`;
}

// ── Polaroid export frame ──

const POLAROID_PAD_SIDE = 18;
const POLAROID_PAD_TOP = 18;
const POLAROID_PAD_BOTTOM = 44;

export const POLAROID_EXPORT_WIDTH = SHARE_CARD_WIDTH + POLAROID_PAD_SIDE * 2;
export const POLAROID_EXPORT_HEIGHT = SHARE_CARD_HEIGHT + POLAROID_PAD_TOP + POLAROID_PAD_BOTTOM;

export function polaroidExportCss() {
  return `
.pe-frame {
  width: ${POLAROID_EXPORT_WIDTH}px;
  height: ${POLAROID_EXPORT_HEIGHT}px;
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
  flex: 0 0 ${SHARE_CARD_HEIGHT}px;
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
