import { t } from "./i18n.js";
import { formatTokenCompact } from "./display.js";

const TREEMAP_MIN_PARTICIPANTS = 12;
const TREEMAP_MAX_PARTICIPANTS = 30;

const SOURCE_PALETTE = {
  claude_code_local: { base: "#1f6f66", alt: "#2a8a80", light: "#3d9e93" },
  codex_local: { base: "#b67810", alt: "#c9922e", light: "#d4a84a" },
  cursor_dashboard_usage: { base: "#6b5b95", alt: "#8574ad", light: "#9d8fc4" },
  other: { base: "#8a8478", alt: "#9a9488", light: "#b5aea0" }
};

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export function escapeAttribute(value) {
  return escapeHtml(value);
}

export function sourceName(providerId) {
  if (providerId === "codex_local") return t("source.codex") || "Codex";
  if (providerId === "claude_code_local") return t("source.claude") || "Claude Code";
  if (providerId === "mimocode_local") return t("source.mimocode") || "MiMoCode";
  if (providerId === "opencode_local") return t("source.opencode") || "OpenCode";
  if (providerId === "hermes_local") return t("source.hermes") || "Hermes";
  if (providerId === "openclaw_local") return t("source.openclaw") || "OpenClaw";
  if (providerId === "cursor_dashboard_usage") return t("source.cursor") || "Cursor";
  return providerId;
}

export function providerSourceKey(providerId = "") {
  if (providerId === "claude_code_local") return "claude_code_local";
  if (providerId === "codex_local") return "codex_local";
  if (providerId === "cursor_dashboard_usage") return "cursor_dashboard_usage";
  return "other";
}

export function providerSourceColor(providerId = "", variant = 0) {
  const key = providerSourceKey(providerId);
  const palette = SOURCE_PALETTE[key] || SOURCE_PALETTE.other;
  return [palette.base, palette.alt, palette.light][variant % 3];
}

export function formatCost(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  const n = Number(value);
  if (n > 0 && n < 0.01) return t("common.lessThanCost") || "<$0.01";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
}

export function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
}

export function formatTokenRaw(value) {
  return `${formatNumber(value)} ${t("unit.tokens")}`;
}

export function normalizeModelSegments(item) {
  const total = Number(item.totalTokens || 0);
  if (!total) return [];
  return (item.models || [])
    .filter((model) => Number(model.totalTokens || 0) > 0)
    .map((model) => ({
      name: model.name,
      totalTokens: Number(model.totalTokens || 0),
      ratio: Math.max(2, (Number(model.totalTokens || 0) / total) * 100)
    }));
}

export function modelUsageTitle(item, localeTokenCompact) {
  const models = normalizeModelSegments(item);
  if (!models.length) return t("web.detail.noUsageSlice");
  return models
    .map((model) => `${model.name}: ${localeTokenCompact(model.totalTokens)} (${Math.round((model.totalTokens / Number(item.totalTokens || 1)) * 100)}%)`)
    .join("\n");
}

export function renderModelSegmentItems(item) {
  const models = normalizeModelSegments(item);
  if (!models.length) return `<i class="model-segment model-segment-empty" style="width:100%"></i>`;
  return models
    .map((model, index) => `<i class="model-segment model-segment-${(index % 5) + 1}" style="width:${model.ratio}%"></i>`)
    .join("");
}

export function renderModelSegments(item, { className, title }) {
  return `<div class="${className}" title="${escapeHtml(title)}">${renderModelSegmentItems(item)}</div>`;
}

export function renderCost(item) {
  const value = formatCost(item.estimatedCostUsd);
  if (value === "-") return value;
  return `<span class="cost-amount">${escapeHtml(value)}</span>${item.missingPriceTokens ? `<sup title="${escapeHtml(t("web.cost.missingModelPrices"))}">*</sup>` : ""}`;
}

export function computeConcentrationMetrics(rankings = []) {
  const sorted = [...rankings].sort((a, b) => Number(b.totalTokens || 0) - Number(a.totalTokens || 0));
  const total = sorted.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);
  if (!total) return null;
  const share = (count) => Math.round(sorted.slice(0, count).reduce((sum, item) => sum + Number(item.totalTokens || 0), 0) / total * 100);
  return {
    top1: share(1),
    top5: share(5),
    top10: share(10),
    topItems: sorted.slice(0, 5).map((item, index) => ({
      rank: item.rank || index + 1,
      name: item.displayName || item.nickname || item.participantId || "",
      totalTokens: Number(item.totalTokens || 0),
      pct: Math.round(Number(item.totalTokens || 0) / total * 100)
    }))
  };
}

export function renderConcentrationSidepanel(container, rankings = [], { localeTokenCompact } = {}) {
  if (!container) return;
  const metrics = computeConcentrationMetrics(rankings);
  if (!metrics) {
    container.innerHTML = "";
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const formatTokens = localeTokenCompact || ((value) => formatTokenCompact(value));
  const topBar = metrics.topItems[0]?.pct || 1;
  container.innerHTML = `
    <div class="insight-chips">
      <span>${escapeHtml(t("web.analytics.insightChipTop1"))} <em>${metrics.top1}%</em></span>
      <span>${escapeHtml(t("web.analytics.insightChipTop5"))} <em>${metrics.top5}%</em></span>
      <span>${escapeHtml(t("web.analytics.insightChipTop5Combined"))} <em>${metrics.top5}%</em></span>
    </div>
    <div class="conc-box">
      <div class="c-title">${escapeHtml(t("web.analytics.concentrationTitle"))}</div>
      <div class="conc-metrics">
        <div><strong>${metrics.top1}%</strong><small>${escapeHtml(t("web.analytics.concentrationTop1"))}</small></div>
        <div><strong>${metrics.top5}%</strong><small>${escapeHtml(t("web.analytics.concentrationTop5"))}</small></div>
        <div><strong>${metrics.top10}%</strong><small>${escapeHtml(t("web.analytics.concentrationTop10"))}</small></div>
      </div>
    </div>
    <div class="rank-mini">
      ${metrics.topItems.map((item) => `
        <div class="rank-mini-row">
          <span class="n">${item.rank}</span>
          <span class="nm">${escapeHtml(item.name)}</span>
          <span class="pct">${item.pct}%</span>
          <div class="rank-mini-bar"><i style="width:${Math.max(8, Math.round((item.pct / topBar) * 100))}%"></i></div>
        </div>
      `).join("")}
    </div>
  `;
}

export function renderSourceLegend(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="src-legend">
      <span><i style="background:${SOURCE_PALETTE.claude_code_local.base}"></i>${escapeHtml(sourceName("claude_code_local"))}</span>
      <span><i style="background:${SOURCE_PALETTE.codex_local.base}"></i>${escapeHtml(sourceName("codex_local"))}</span>
      <span><i style="background:${SOURCE_PALETTE.cursor_dashboard_usage.base}"></i>${escapeHtml(sourceName("cursor_dashboard_usage"))}</span>
      <span><i style="background:${SOURCE_PALETTE.other.base}"></i>${escapeHtml(t("web.analytics.otherSources"))}</span>
    </div>
  `;
}

export function renderTokenComposition(container, summary = {}) {
  if (!container) return;
  const total = Number(summary.totalTokens || 0);
  if (!total) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(t("web.analytics.noData"))}</div>`;
    return;
  }
  const parts = [
    { key: "inputTokens", label: t("common.input"), color: "#0f4f4c" },
    { key: "outputTokens", label: t("common.output"), color: "#1c7570" },
    { key: "cacheReadTokens", label: t("common.cacheRead"), color: "#35aaa0" },
    { key: "cacheWriteTokens", label: t("common.cacheWrite"), color: "#8fddd4" }
  ].map((part) => {
    const tokens = Number(summary[part.key] || 0);
    const ratio = tokens / total;
    return {
      ...part,
      tokens,
      ratio,
      pct: Math.round(ratio * 100)
    };
  });

  const radius = 15.5;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const rings = parts
    .filter((part) => part.tokens > 0)
    .map((part) => {
      const dash = part.ratio * circumference;
      const segment = `<circle cx="21" cy="21" r="${radius}" fill="none" stroke="${part.color}" stroke-width="6.5"
        stroke-dasharray="${dash} ${circumference}" stroke-dashoffset="${offset}" stroke-linecap="butt"
        transform="rotate(-90 21 21)"/>`;
      offset -= dash;
      return segment;
    })
    .join("");

  const dominant = [...parts].sort((a, b) => b.tokens - a.tokens)[0];

  container.innerHTML = `
    <div class="token-composition comp-mix" tabindex="0">
      <div class="comp-mix-visual" aria-hidden="true">
        <svg class="comp-donut" viewBox="0 0 42 42">
          <circle cx="21" cy="21" r="${radius}" fill="none" stroke="var(--line-soft)" stroke-width="6.5"/>
          ${rings}
        </svg>
        <div class="comp-donut-center">
          <strong>${dominant.pct}%</strong>
          <span>${escapeHtml(dominant.label)}</span>
        </div>
      </div>
      <div class="comp-mix-list" role="list" aria-label="${escapeHtml(t("web.analytics.tokenComposition"))}">
        ${parts.map((part) => `
          <div class="comp-mix-row" role="listitem">
            <div class="comp-mix-head">
              <span class="swatch" style="background:${part.color}"></span>
              <span class="comp-label">${escapeHtml(part.label)}</span>
              <b>${part.pct}%</b>
            </div>
            <div class="comp-mix-track"><i style="width:${Math.max(part.pct, part.tokens > 0 ? 2 : 0)}%;background:${part.color}"></i></div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

export function renderParetoChart(container, rankings = []) {
  if (!container) return;
  const sorted = [...rankings].sort((a, b) => Number(b.totalTokens || 0) - Number(a.totalTokens || 0));
  const total = sorted.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);
  if (!total) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(t("web.analytics.noData"))}</div>`;
    return;
  }
  const thresholds = [1, 3, 5, 10, sorted.length];
  const labels = [
    t("web.analytics.paretoTop1"),
    t("web.analytics.paretoTop3"),
    t("web.analytics.paretoTop5"),
    t("web.analytics.paretoTop10"),
    t("web.analytics.paretoAll")
  ];
  container.innerHTML = thresholds.map((count, index) => {
    const pct = Math.round(sorted.slice(0, Math.min(count, sorted.length)).reduce((sum, item) => sum + Number(item.totalTokens || 0), 0) / total * 100);
    return `
      <div class="pareto-row">
        <span class="lab">${escapeHtml(labels[index])}</span>
        <div class="pareto-track">
          <div class="bar" style="width:${pct}%"></div>
          <div class="cum" style="left:${pct}%"></div>
        </div>
        <span class="pct">${pct}%</span>
      </div>
    `;
  }).join("");
}

export function renderWeekdayRhythm(container, timeSeries = []) {
  if (!container) return;
  const buckets = Array.from({ length: 7 }, () => 0);
  for (const point of timeSeries) {
    if (!point.day) continue;
    const day = new Date(`${point.day}T00:00:00Z`).getUTCDay();
    const index = day === 0 ? 6 : day - 1;
    buckets[index] += Number(point.totalTokens || 0);
  }
  const total = buckets.reduce((sum, value) => sum + value, 0);
  const max = Math.max(...buckets, 1);
  const peak = buckets.indexOf(Math.max(...buckets));
  const labels = [
    t("web.analytics.weekdayMon"),
    t("web.analytics.weekdayTue"),
    t("web.analytics.weekdayWed"),
    t("web.analytics.weekdayThu"),
    t("web.analytics.weekdayFri"),
    t("web.analytics.weekdaySat"),
    t("web.analytics.weekdaySun")
  ];
  if (!total) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(t("web.analytics.noData"))}</div>`;
    return;
  }
  container.innerHTML = labels.map((label, index) => {
    const height = Math.max(6, Math.round((buckets[index] / max) * 100));
    const share = Math.round((buckets[index] / total) * 100);
    return `
      <div class="d${index === peak ? " peak" : ""}" title="${escapeHtml(label)} · ${share}%">
        <div class="col-wrap">
          <div class="col" style="height:${height}%"></div>
        </div>
        <strong class="val">${share}%</strong>
        <span>${escapeHtml(label)}</span>
      </div>
    `;
  }).join("");
}

export function computeAnalyticsInsights(data = {}) {
  const rankings = data.participantRanking || [];
  const metrics = computeConcentrationMetrics(rankings);
  const buckets = Array.from({ length: 7 }, () => 0);
  for (const point of data.timeSeries || []) {
    if (!point.day) continue;
    const day = new Date(`${point.day}T00:00:00Z`).getUTCDay();
    const index = day === 0 ? 6 : day - 1;
    buckets[index] += Number(point.totalTokens || 0);
  }
  const peakWeekdayKeys = [
    "web.analytics.peakWeekdayMon",
    "web.analytics.peakWeekdayTue",
    "web.analytics.peakWeekdayWed",
    "web.analytics.peakWeekdayThu",
    "web.analytics.peakWeekdayFri",
    "web.analytics.peakWeekdaySat",
    "web.analytics.peakWeekdaySun"
  ];
  const peakIndex = buckets.indexOf(Math.max(...buckets, 0));
  const peakDay = peakIndex >= 0 ? t(peakWeekdayKeys[peakIndex]) : "-";
  const weekend = buckets[5] + buckets[6];
  const weekday = buckets.slice(0, 5).reduce((sum, value) => sum + value, 0);
  const weekendPct = weekday + weekend ? Math.round(weekend / (weekday + weekend) * 100) : 0;
  const activeCount = rankings.filter((item) => Number(item.totalTokens || 0) > 0).length;
  const participantCount = Number(data.participantCount) > 0
    ? Number(data.participantCount)
    : rankings.length;
  return {
    top5Pct: metrics?.top5 || 0,
    peakDay,
    activeCount,
    participantCount,
    weekendPct
  };
}

export function renderAnalyticsInsights(container, data = {}) {
  if (!container) return;
  const insights = computeAnalyticsInsights(data);
  const chips = [
    [t("web.analytics.insightTop5Label"), `${insights.top5Pct}%`],
    [t("web.analytics.insightPeakDayLabel"), insights.peakDay],
    [t("web.analytics.insightActiveLabel"), `${insights.activeCount} / ${insights.participantCount}`],
    [t("web.analytics.insightWeekendLabel"), `${insights.weekendPct}%`]
  ];
  container.innerHTML = chips.map(([label, value]) =>
    `<span>${escapeHtml(label)}<em>${escapeHtml(value)}</em></span>`
  ).join("");
}

export function aggregateTimeSeriesByWeek(series = []) {
  const buckets = new Map();
  for (const point of series) {
    if (!point?.day) continue;
    const weekStart = startOfUtcWeekDay(point.day);
    const weekEnd = addUtcDays(weekStart, 6);
    const current = buckets.get(weekStart) || {
      day: weekStart,
      periodStart: weekStart,
      periodEnd: weekEnd,
      label: `${formatMonthDay(weekStart)} ~ ${formatMonthDay(weekEnd)}`,
      totalTokens: 0,
      estimatedCostUsd: 0,
      activeCount: 0
    };
    current.totalTokens += Number(point.totalTokens) || 0;
    current.estimatedCostUsd += Number(point.estimatedCostUsd) || 0;
    current.activeCount = Math.max(current.activeCount, Number(point.activeCount) || 0);
    buckets.set(weekStart, current);
  }
  return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function startOfUtcWeekDay(day) {
  const date = new Date(`${day}T00:00:00Z`);
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - weekday + 1);
  return start.toISOString().slice(0, 10);
}

function addUtcDays(day, delta) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function formatMonthDay(day) {
  const parts = String(day || "").split("-");
  return parts.length >= 3 ? `${parts[1]}-${parts[2]}` : day;
}

/** Monotone cubic path through points — smooth, no overshoot (demo-style). */
export function smoothLinePath(points = []) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const curr = points[i];
    const next = points[i + 1];
    const prev = i > 0 ? points[i - 1] : curr;
    const afterNext = i < points.length - 2 ? points[i + 2] : next;
    const dx = next.x - curr.x;
    const dy = next.y - curr.y;
    const slopeCurr = (next.y - prev.y) / ((next.x - prev.x) || 1);
    const slopeNext = (afterNext.y - curr.y) / ((afterNext.x - curr.x) || 1);
    const signCurr = Math.sign(dy) || Math.sign(slopeCurr);
    const signNext = Math.sign(dy) || Math.sign(slopeNext);
    const tanCurr = signCurr === Math.sign(slopeCurr) ? slopeCurr : 0;
    const tanNext = signNext === Math.sign(slopeNext) ? slopeNext : 0;
    d += ` C ${curr.x + dx / 3} ${curr.y + tanCurr * dx / 3}, ${next.x - dx / 3} ${next.y - tanNext * dx / 3}, ${next.x} ${next.y}`;
  }
  return d;
}

export function renderTrendChart(svg, series, grain, tooltip, localeTokenCompact, options = {}) {
  const { showActiveSeries = false, highlightPeak = false } = options;
  svg.innerHTML = "";
  if (!series.length) {
    svg.innerHTML = `<text x="400" y="100" class="chart-axis-text" font-size="14" text-anchor="middle">${t("web.analytics.noData") || "No usage data"}</text>`;
    return;
  }

  const width = Number(options.width) > 0 ? Number(options.width) : 800;
  const height = Number(options.height) > 0 ? Number(options.height) : 200;
  const padding = {
    left: 60,
    right: 20,
    top: 20,
    bottom: 30,
    ...(options.padding || {})
  };
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const maxVal = Math.max(...series.map(pt => pt.totalTokens), 1);
  const N = series.length;

  const gridCount = 4;
  for (let i = 0; i <= gridCount; i++) {
    const ratio = i / gridCount;
    const y = padding.top + ratio * (height - padding.top - padding.bottom);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", padding.left);
    line.setAttribute("y1", y);
    line.setAttribute("x2", width - padding.right);
    line.setAttribute("y2", y);
    line.setAttribute("class", "chart-grid-line");
    svg.appendChild(line);
    const val = Math.round(maxVal * (1 - ratio));
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", padding.left - 10);
    text.setAttribute("y", y + 3);
    text.setAttribute("class", "chart-axis-text y-axis");
    text.textContent = localeTokenCompact(val);
    svg.appendChild(text);
  }

  const points = [];
  for (let i = 0; i < N; i++) {
    const x = padding.left + (N > 1 ? (i / (N - 1)) * (width - padding.left - padding.right) : (width - padding.left - padding.right) / 2);
    const y = height - padding.bottom - (series[i].totalTokens / maxVal) * (height - padding.top - padding.bottom);
    const label = grain === "hour"
      ? (series[i].label || `${String(series[i].hour ?? i).padStart(2, "0")}:00`)
      : grain === "week"
        ? (series[i].label || formatMonthDay(series[i].day))
        : series[i].day;
    points.push({ x, y, day: series[i].day, label, tokens: series[i].totalTokens });
  }

  if (points.length > 0) {
    const lineD = smoothLinePath(points);
    const areaPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    areaPath.setAttribute(
      "d",
      `${lineD} L ${points[points.length - 1].x} ${height - padding.bottom} L ${points[0].x} ${height - padding.bottom} Z`
    );
    areaPath.setAttribute("class", "chart-area");
    svg.appendChild(areaPath);

    const linePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    linePath.setAttribute("d", lineD);
    linePath.setAttribute("class", "chart-line");
    linePath.setAttribute("pathLength", "1");
    linePath.setAttribute("fill", "none");
    linePath.setAttribute("stroke-linecap", "round");
    linePath.setAttribute("stroke-linejoin", "round");
    svg.appendChild(linePath);

    if (showActiveSeries && series.some((pt) => Number(pt.activeCount) > 0)) {
      const maxActive = Math.max(...series.map((pt) => Number(pt.activeCount) || 0), 1);
      const activePoints = [];
      for (let i = 0; i < N; i++) {
        const x = padding.left + (N > 1 ? (i / (N - 1)) * (width - padding.left - padding.right) : (width - padding.left - padding.right) / 2);
        const activeCount = Number(series[i].activeCount) || 0;
        // Keep the relative series in the lower ~55% so it stays a secondary signal.
        const y = height - padding.bottom - (activeCount / maxActive) * (height - padding.top - padding.bottom) * 0.55;
        activePoints.push({ x, y, day: series[i].day, activeCount });
      }
      const activePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      activePath.setAttribute("d", smoothLinePath(activePoints));
      activePath.setAttribute("class", "chart-line-active");
      activePath.setAttribute("fill", "none");
      activePath.setAttribute("stroke", "var(--gold, #b67810)");
      activePath.setAttribute("stroke-width", "2");
      activePath.setAttribute("stroke-dasharray", "5 4");
      activePath.setAttribute("stroke-linecap", "round");
      activePath.setAttribute("stroke-linejoin", "round");
      svg.appendChild(activePath);
    }
  }

  const xLabelsCount = grain === "hour" ? Math.min(N, 8) : Math.min(N, 6);
  for (let i = 0; i < xLabelsCount; i++) {
    const idx = xLabelsCount === 1 ? 0 : Math.round((i / (xLabelsCount - 1)) * (N - 1));
    if (points[idx]) {
      const pt = points[idx];
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", pt.x);
      text.setAttribute("y", height - 10);
      text.setAttribute("class", "chart-axis-text");
      if (grain === "hour") {
        text.textContent = pt.label;
      } else if (grain === "week") {
        text.textContent = formatMonthDay(pt.day);
      } else {
        const parts = pt.day.split("-");
        text.textContent = parts.length >= 3 ? `${parts[1]}-${parts[2]}` : pt.day;
      }
      svg.appendChild(text);
    }
  }

  const peakTokens = highlightPeak
    ? Math.max(...points.map((pt) => Number(pt.tokens) || 0), 0)
    : 0;
  let peakMarked = false;
  for (const pt of points) {
    const isPeak = highlightPeak && !peakMarked && peakTokens > 0 && Number(pt.tokens) === peakTokens;
    if (isPeak) peakMarked = true;
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", pt.x);
    circle.setAttribute("cy", pt.y);
    circle.setAttribute("r", isPeak ? "5.5" : grain === "hour" ? "3" : grain === "week" ? "3.5" : "4.5");
    circle.setAttribute("class", isPeak ? "chart-dot chart-dot-peak" : "chart-dot");
    circle.addEventListener("mouseenter", () => {
      const header = grain === "hour"
        ? `${pt.day} ${pt.label}`
        : grain === "week"
          ? (pt.label || pt.day)
          : pt.day;
      const seriesPoint = series.find((item) => item.day === pt.day && (grain !== "hour" || item.label === pt.label)) || {};
      const activeHint = showActiveSeries && seriesPoint.activeCount != null
        ? `<br>${t("web.home.trendLegendActive") || "Active users"}: ${seriesPoint.activeCount}`
        : "";
      const peakHint = isPeak ? `<br>${t("common.peak") || "Peak"}` : "";
      tooltip.innerHTML = `<strong>${header}</strong><br>${localeTokenCompact(pt.tokens)} ${t("unit.tokens") || "tokens"}${peakHint}${activeHint}`;
      tooltip.style.opacity = "1";
      positionTooltip(tooltip, circle);
    });
    circle.addEventListener("mouseleave", () => { tooltip.style.opacity = "0"; });
    svg.appendChild(circle);
  }
}

export function renderDonutChart(container, items = [], { collapseAfter, collapseLabel, labelFn } = {}) {
  container.innerHTML = "";
  if (!items.length) {
    container.innerHTML = `<div class="meter-empty">${t("web.analytics.noData") || "No usage data"}</div>`;
    return;
  }

  let displayItems = items;
  if (collapseAfter && items.length > collapseAfter) {
    const topItems = items.slice(0, collapseAfter - 1);
    const otherItems = items.slice(collapseAfter - 1);
    displayItems = [
      ...topItems,
      {
        id: "other",
        label: collapseLabel || t("web.analytics.otherSources") || "Other sources",
        ratio: otherItems.reduce((sum, item) => sum + (item.ratio || 0), 0)
      }
    ];
  }

  const radius = 15.5;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const segments = displayItems.map((item) => {
    const ratio = Math.max(0, Number(item.ratio) || 0);
    const dash = ratio * circumference;
    const color = providerSourceColor(item.id || item.name || "other");
    const segment = { color, dash, offset, label: labelFn ? labelFn(item) : (item.label || item.name), ratio };
    offset -= dash;
    return segment;
  });

  const legend = segments.map((segment) => {
    const pct = Math.round(segment.ratio * 100);
    return `<div><span class="swatch" style="background:${segment.color}"></span>${escapeHtml(segment.label)} <b>${pct}%</b></div>`;
  }).join("");

  const rings = segments.map((segment) =>
    `<circle cx="21" cy="21" r="${radius}" fill="none" stroke="${segment.color}" stroke-width="6"
      stroke-dasharray="${segment.dash} ${circumference}" stroke-dashoffset="${segment.offset}" transform="rotate(-90 21 21)"/>`
  ).join("");

  container.innerHTML = `<div class="donut-wrap">
    <svg class="donut" viewBox="0 0 42 42" aria-hidden="true">
      <circle cx="21" cy="21" r="${radius}" fill="none" stroke="var(--line)" stroke-width="6"/>
      ${rings}
    </svg>
    <div class="donut-legend">${legend}</div>
  </div>`;
}

export function renderActivityHeatmap(grid, heatmap = [], {
  from = "",
  to = "",
  businessDay = "",
  tooltip,
  localeTokenCompact,
  layout = "calendar"
} = {}) {
  if (!grid) return;
  grid.innerHTML = "";

  const totalsByDay = {};
  for (const pt of heatmap) totalsByDay[pt.day] = pt.totalTokens || 0;
  const maxVal = Math.max(...Object.values(totalsByDay), 0);

  if (layout === "heat90") {
    renderHeat90Strip(grid, {
      totalsByDay,
      maxVal,
      to,
      businessDay,
      tooltip,
      localeTokenCompact
    });
    return;
  }

  const anchorDay = businessDay || to || new Date().toISOString().split("T")[0];
  const businessDate = new Date(`${anchorDay}T00:00:00Z`);
  const currentDayOfWeek = businessDate.getUTCDay();
  const startOfWeek = new Date(businessDate);
  startOfWeek.setUTCDate(businessDate.getUTCDate() - currentDayOfWeek);
  const startDate = new Date(startOfWeek);
  startDate.setUTCDate(startOfWeek.getUTCDate() - 12 * 7);
  const totalDays = 13 * 7;

  for (let i = 0; i < totalDays; i++) {
    const cellDate = new Date(startDate);
    cellDate.setUTCDate(startDate.getUTCDate() + i);
    const dayStr = cellDate.toISOString().split("T")[0];
    const tokens = totalsByDay[dayStr] || 0;
    appendHeatmapCell(grid, {
      dayStr,
      tokens,
      level: heatLevel(tokens, maxVal),
      tooltip,
      localeTokenCompact
    });
  }
}

function heatLevel(tokens, maxVal) {
  if (!(tokens > 0 && maxVal > 0)) return 0;
  const ratio = tokens / maxVal;
  if (ratio > 0.75) return 4;
  if (ratio > 0.50) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

function renderHeat90Strip(grid, {
  totalsByDay,
  maxVal,
  businessDay = "",
  to = "",
  tooltip,
  localeTokenCompact
}) {
  grid.classList.add("heat90");
  const anchorDay = to || businessDay || new Date().toISOString().split("T")[0];
  const endDate = new Date(`${anchorDay}T00:00:00Z`);
  const startDate = new Date(endDate);
  startDate.setUTCDate(endDate.getUTCDate() - 89);

  for (let i = 0; i < 90; i++) {
    const cellDate = new Date(startDate);
    cellDate.setUTCDate(startDate.getUTCDate() + i);
    const dayStr = cellDate.toISOString().split("T")[0];
    const tokens = totalsByDay[dayStr] || 0;
    appendHeatmapCell(grid, {
      dayStr,
      tokens,
      level: heatLevel(tokens, maxVal),
      tooltip,
      localeTokenCompact
    });
  }
}

function appendHeatmapCell(grid, {
  dayStr,
  tokens,
  level,
  tooltip,
  localeTokenCompact
}) {
  const cell = document.createElement("i");
  cell.className = `heatmap-cell level-${level}`;
  cell.dataset.date = dayStr;
  cell.dataset.tokens = tokens;

  if (tooltip) {
    cell.addEventListener("mouseenter", () => {
      tooltip.innerHTML = `<strong>${dayStr}</strong><br>${localeTokenCompact(tokens)} ${t("unit.tokens") || "tokens"}`;
      tooltip.style.opacity = "1";
      const rect = cell.getBoundingClientRect();
      tooltip.style.left = `${rect.left + window.scrollX - tooltip.offsetWidth / 2 + rect.width / 2}px`;
      tooltip.style.top = `${rect.top + window.scrollY - tooltip.offsetHeight - 8}px`;
    });
    cell.addEventListener("mouseleave", () => { tooltip.style.opacity = "0"; });
  }

  grid.appendChild(cell);
}

export function renderGauge(fillEl, valEl, cacheHitRate) {
  if (!fillEl || !valEl) return;
  const pct = Math.round(cacheHitRate * 100);
  fillEl.setAttribute("stroke-dasharray", `${Math.round(cacheHitRate * 251.2)} 251.2`);
  valEl.textContent = `${pct}%`;
}

export function renderBarChart(container, items = [], { collapseAfter, collapseLabel, localeTokenCompact }) {
  container.innerHTML = "";
  if (!items.length) {
    container.innerHTML = `<div style="text-align: center; padding: 30px 0; color: var(--muted);">${t("web.analytics.noData") || "No usage data found"}</div>`;
    return;
  }
  let displayItems = items;
  if (collapseAfter && items.length > collapseAfter) {
    const topItems = items.slice(0, collapseAfter - 1);
    const otherItems = items.slice(collapseAfter - 1);
    displayItems = [...topItems, {
      name: collapseLabel || t("web.analytics.otherModels") || "Other Models",
      tokens: otherItems.reduce((sum, item) => sum + item.tokens, 0),
      ratio: otherItems.reduce((sum, item) => sum + item.ratio, 0)
    }];
  }
  const totalTokens = displayItems.reduce((sum, item) => sum + Number(item.tokens || 0), 0);
  for (const item of displayItems) {
    const ratio = Number.isFinite(Number(item.ratio))
      ? Number(item.ratio)
      : totalTokens > 0
        ? Number(item.tokens || 0) / totalTokens
        : 0;
    const ratioPct = Math.round(ratio * 100);
    const barWidth = Math.max(0, Math.min(100, ratio * 100));
    const tokenLabel = localeTokenCompact(item.tokens);
    const row = document.createElement("div");
    row.className = "share-row";
    row.title = `${item.name}: ${tokenLabel} (${ratioPct}%)`;
    row.innerHTML = `
      <div class="lbl">
        <span>${escapeHtml(item.name)}</span>
        <span class="share-value"><strong>${tokenLabel}</strong><span>${ratioPct}%</span></span>
      </div>
      <div class="share-track">
        <i style="width:${barWidth}%"></i>
      </div>
    `;
    container.appendChild(row);
  }
}

function treemapTextTone(fill) {
  const darkSources = new Set(["#c9922e", "#d4a84a", "#9a9488", "#b5aea0"]);
  return darkSources.has(fill) ? " tm-dark" : "";
}

export function renderParticipantTreemap(svg, labels, rankings = [], {
  localeTokenCompact,
  tooltip = null,
  sideContainer = null,
  legendContainer = null
} = {}) {
  if (!svg || !labels) return;
  const formatTokens = localeTokenCompact || ((value) => formatTokenCompact(value));
  const svgEl = (tag, attrs = {}) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  };

  svg.innerHTML = "";
  labels.innerHTML = "";
  labels.hidden = true;
  if (legendContainer) renderSourceLegend(legendContainer);
  if (sideContainer) renderConcentrationSidepanel(sideContainer, rankings, { localeTokenCompact: formatTokens });

  if (!rankings.length) {
    const empty = svgEl("text", { x: 450, y: 190, class: "participant-treemap-empty" });
    empty.textContent = t("web.analytics.noData");
    svg.appendChild(empty);
    return;
  }

  const displayCount = Math.min(
    rankings.length,
    TREEMAP_MAX_PARTICIPANTS,
    Math.max(TREEMAP_MIN_PARTICIPANTS, Math.ceil(rankings.length / 2))
  );
  const width = 900;
  const height = Math.max(360, Math.ceil((displayCount + 1) / 6) * 115);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.style.aspectRatio = `${width} / ${height}`;
  const sourceVariantCount = {};
  const entries = rankings.slice(0, displayCount).map((item) => ({
    name: item.displayName || item.nickname || item.participantId || "",
    totalTokens: Number(item.totalTokens || 0),
    primaryProvider: item.primaryProvider || item.primaryProviderId || "other"
  }));
  const otherTokens = rankings.slice(displayCount).reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);
  if (otherTokens > 0) {
    entries.push({ name: t("web.analytics.otherParticipants"), totalTokens: otherTokens, primaryProvider: "other" });
  }

  const totalTokens = entries.reduce((sum, item) => sum + item.totalTokens, 0);
  if (totalTokens <= 0) {
    const empty = svgEl("text", { x: width / 2, y: height / 2, class: "participant-treemap-empty" });
    empty.textContent = t("web.analytics.noData");
    svg.appendChild(empty);
    return;
  }

  const layoutTreemap = (items, x, y, boxWidth, boxHeight, splitByWidth) => {
    if (items.length === 1) return [{ ...items[0], x, y, width: boxWidth, height: boxHeight }];
    const sum = items.reduce((total, item) => total + item.totalTokens, 0) || 1;
    const target = sum / 2;
    let running = 0;
    let splitIndex = 1;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < items.length - 1; index += 1) {
      running += items[index].totalTokens;
      const distance = Math.abs(target - running);
      if (distance < closestDistance) {
        closestDistance = distance;
        splitIndex = index + 1;
      }
    }
    const first = items.slice(0, splitIndex);
    const second = items.slice(splitIndex);
    const firstRatio = first.reduce((total, item) => total + item.totalTokens, 0) / sum;
    if (splitByWidth) {
      const firstWidth = boxWidth * firstRatio;
      return [
        ...layoutTreemap(first, x, y, firstWidth, boxHeight, !splitByWidth),
        ...layoutTreemap(second, x + firstWidth, y, boxWidth - firstWidth, boxHeight, !splitByWidth)
      ];
    }
    const firstHeight = boxHeight * firstRatio;
    return [
      ...layoutTreemap(first, x, y, boxWidth, firstHeight, !splitByWidth),
      ...layoutTreemap(second, x, y + firstHeight, boxWidth, boxHeight - firstHeight, !splitByWidth)
    ];
  };

  const baseId = svg.id || "participant-treemap";
  const titleId = `${baseId}-title`;
  const descId = `${baseId}-desc`;
  svg.setAttribute("aria-labelledby", `${titleId} ${descId}`);
  const title = svgEl("title", { id: titleId });
  title.textContent = t("web.analytics.participantTreemap");
  const desc = svgEl("desc", { id: descId });
  desc.textContent = t("web.analytics.participantTreemapSubtitle");
  svg.append(title, desc);

  const rectangles = layoutTreemap(entries, 0, 0, width, height, true);
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = svgEl("defs");
    svg.insertBefore(defs, svg.firstChild);
  }

  rectangles.forEach((item, index) => {
    const sourceKey = providerSourceKey(item.primaryProvider);
    const variant = sourceVariantCount[sourceKey] || 0;
    sourceVariantCount[sourceKey] = variant + 1;
    const fill = providerSourceColor(item.primaryProvider, variant);
    const gap = Math.min(8, item.width / 10, item.height / 10);
    const x = item.x + gap / 2;
    const y = item.y + gap / 2;
    const boxWidth = Math.max(1, item.width - gap);
    const boxHeight = Math.max(1, item.height - gap);
    const pct = Math.round(item.totalTokens / totalTokens * 100);
    const radius = Math.min(8, gap + 2);
    const rect = svgEl("rect", {
      x, y, width: boxWidth, height: boxHeight,
      rx: String(radius),
      class: `participant-treemap-node tm-cell${treemapTextTone(fill)}`,
      fill,
      "aria-label": `${item.name}: ${formatTokens(item.totalTokens)}`
    });
    rect.addEventListener("mouseenter", () => {
      if (!tooltip) return;
      tooltip.innerHTML = `<strong>${escapeHtml(item.name)}</strong><br>${formatTokens(item.totalTokens)} · ${pct}%`;
      tooltip.style.opacity = "1";
      positionTooltip(tooltip, rect);
    });
    rect.addEventListener("mouseleave", () => {
      if (tooltip) tooltip.style.opacity = "0";
    });
    svg.appendChild(rect);

    // Word-cloud style: centered label stack, ellipsis when too wide, larger type by cell size.
    const size = boxWidth >= 150 && boxHeight >= 86
      ? "md"
      : boxWidth >= 84 && boxHeight >= 48
        ? "sm"
        : "xs";
    const metrics = size === "md"
      ? { name: 22, val: 14, char: 14, pad: 10, gap: 5 }
      : size === "sm"
        ? { name: 17, val: 12, char: 11, pad: 8, gap: 4 }
        : { name: 13, val: 11, char: 8.5, pad: 5, gap: 3 };
    const canShowName = boxWidth >= 30 && boxHeight >= metrics.name + metrics.pad * 2;
    if (!canShowName) return;

    const canShowValue = boxWidth >= (size === "xs" ? 54 : 70)
      && boxHeight >= metrics.name + metrics.val + metrics.gap + metrics.pad * 2;
    const stackH = canShowValue
      ? metrics.name + metrics.gap + metrics.val
      : metrics.name;
    const cx = x + boxWidth / 2;
    const stackTop = y + (boxHeight - stackH) / 2;
    const maxChars = Math.max(1, Math.floor((boxWidth - metrics.pad * 2) / metrics.char));
    const labelText = item.name.length > maxChars
      ? `${item.name.slice(0, Math.max(1, maxChars - 1))}…`
      : item.name;

    const clipId = `${baseId}-clip-${index}`;
    const clipPath = svgEl("clipPath", { id: clipId });
    clipPath.appendChild(svgEl("rect", {
      x, y, width: boxWidth, height: boxHeight, rx: String(radius), ry: String(radius)
    }));
    defs.appendChild(clipPath);

    const sizeClass = size === "md" ? "" : size === "sm" ? " tm-name-sm" : " tm-name-xs";
    const valueClass = size === "md" ? "" : size === "sm" ? " tm-val-sm" : " tm-val-xs";
    const group = svgEl("g", {
      class: treemapTextTone(fill).trim() || undefined,
      "clip-path": `url(#${clipId})`
    });
    const name = svgEl("text", {
      x: cx,
      y: stackTop,
      "text-anchor": "middle",
      "dominant-baseline": "hanging",
      class: `participant-treemap-name tm-name${sizeClass}`
    });
    name.textContent = labelText;
    group.appendChild(name);
    if (canShowValue) {
      const value = svgEl("text", {
        x: cx,
        y: stackTop + metrics.name + metrics.gap,
        "text-anchor": "middle",
        "dominant-baseline": "hanging",
        class: `participant-treemap-value tm-val${valueClass}`
      });
      const valueText = boxWidth >= 108
        ? `${formatTokens(item.totalTokens)} · ${pct}%`
        : formatTokens(item.totalTokens);
      const valueMax = Math.max(1, Math.floor((boxWidth - metrics.pad * 2) / (metrics.char * 0.72)));
      value.textContent = valueText.length > valueMax
        ? `${valueText.slice(0, Math.max(1, valueMax - 1))}…`
        : valueText;
      group.appendChild(value);
    }
    svg.appendChild(group);
  });
}

function positionTooltip(tooltip, anchor) {
  const rect = anchor.getBoundingClientRect();
  const ttW = tooltip.offsetWidth;
  const ttH = tooltip.offsetHeight;
  const vpW = window.innerWidth;
  let left = rect.left + window.scrollX - ttW / 2 + rect.width / 2;
  let top = rect.top + window.scrollY - ttH - 8;
  if (left < 8) left = 8;
  if (left + ttW > vpW - 8) left = vpW - ttW - 8;
  if (top < window.scrollY + 4) top = rect.bottom + window.scrollY + 8;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}
