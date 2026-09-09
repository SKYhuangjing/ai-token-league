import { t } from "./i18n.js";
import { formatTokenCompact } from "./display.js";

const TREEMAP_MIN_PARTICIPANTS = 12;
const TREEMAP_MAX_PARTICIPANTS = 30;

const SOURCE_PALETTE = {
  claude_code_local: { base: "#1f6f66", alt: "#2a8a80", light: "#3d9e93" },
  codex_local: { base: "#b67810", alt: "#c9922e", light: "#d4a84a" },
  cursor_dashboard_usage: { base: "#6b5b95", alt: "#8574ad", light: "#9d8fc4" },
  opencode_local: { base: "#34558b", alt: "#4a6fa5", light: "#6b8dbd" },
  mimocode_local: { base: "#a63d40", alt: "#bd5a5d", light: "#d08083" },
  hermes_local: { base: "#6b7a3f", alt: "#83934f", light: "#a0af70" },
  openclaw_local: { base: "#c96a2b", alt: "#d6823f", light: "#e39b60" },
  zcode_local: { base: "#4a4e8f", alt: "#63679e", light: "#8286b8" },
  workbuddy_local: { base: "#a84a7c", alt: "#b96891", light: "#cb87a8" },
  dsh_local: { base: "#2a6f8f", alt: "#3d87a8", light: "#5b9dbd" },
  kimi_local: { base: "#1f6f5c", alt: "#358a74", light: "#5aa892" },
  other: { base: "#8a8478", alt: "#9a9488", light: "#b5aea0" }
};

// Single source of truth for the four token composition segment colors.
// Labels are i18n keys so callers resolve them with their own t().
export const COMPOSITION_PARTS = [
  { key: "inputTokens", labelKey: "common.input", color: "#0f4f4c" },
  { key: "outputTokens", labelKey: "common.output", color: "#1c7570" },
  { key: "cacheReadTokens", labelKey: "common.cacheRead", color: "#35aaa0" },
  { key: "cacheWriteTokens", labelKey: "common.cacheWrite", color: "#8fddd4" }
];

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
  if (providerId === "zcode_local") return t("source.zcode") || "ZCode";
  if (providerId === "workbuddy_local") return t("source.workbuddy") || "WorkBuddy";
  if (providerId === "dsh_local") return t("source.dsh") || "DeepSeek Harness";
  if (providerId === "kimi_local") return t("source.kimi") || "Kimi";
  if (providerId === "cursor_dashboard_usage") return t("source.cursor") || "Cursor";
  return providerId;
}

export function providerSourceKey(providerId = "") {
  if (SOURCE_PALETTE[providerId]) return providerId;
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

export function formatPricePer100M(item) {
  const cost = Number(item.estimatedCostUsd);
  const tokens = Number(item.totalTokens || 0);
  if (!Number.isFinite(cost) || cost <= 0 || tokens <= 0) return "-";
  const price = (cost / tokens) * 100_000_000;
  return t("web.cost.pricePer100M", { value: price.toFixed(price >= 100 ? 0 : price >= 10 ? 1 : 2) });
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
      displayId: item.displayId || item.participantId || "",
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
  // Stacked ownership bar: top1 / #2-5 / #6-10 / everyone else — one visual, no repeated stat chips.
  const seg = (from, to) => `${Math.max(0, to - from)}%`;
  const segments = [
    { cls: "seg-top1", width: seg(0, metrics.top1), label: t("web.analytics.concentrationTop1"), pct: metrics.top1 },
    { cls: "seg-top2to5", width: seg(metrics.top1, metrics.top5), label: t("web.analytics.concSeg2to5"), pct: metrics.top5 - metrics.top1 },
    { cls: "seg-top6to10", width: seg(metrics.top5, metrics.top10), label: t("web.analytics.concSeg6to10"), pct: metrics.top10 - metrics.top5 },
    { cls: "seg-rest", width: seg(metrics.top10, 100), label: t("web.analytics.otherParticipants"), pct: 100 - metrics.top10 }
  ];
  container.innerHTML = `
    <div class="conc-box">
      <div class="c-title">${escapeHtml(t("web.analytics.concentrationTitle"))}</div>
      <div class="conc-metrics">
        <div><strong>${metrics.top1}%</strong><small>${escapeHtml(t("web.analytics.concentrationTop1"))}</small></div>
        <div><strong>${metrics.top5}%</strong><small>${escapeHtml(t("web.analytics.concentrationTop5"))}</small></div>
        <div><strong>${metrics.top10}%</strong><small>${escapeHtml(t("web.analytics.concentrationTop10"))}</small></div>
      </div>
      <div class="conc-stack">
        ${segments.filter((s) => s.width !== "0%").map((s) =>
          `<i class="${s.cls}" style="width:${s.width}" title="${escapeHtml(`${s.label} ${s.pct}%`)}"></i>`
        ).join("")}
      </div>
    </div>
    <div class="rank-mini">
      <div class="c-title">${escapeHtml(t("web.analytics.concentrationRankTitle"))}</div>
      ${metrics.topItems.map((item) => `
        <a class="rank-mini-row" href="${item.displayId ? `/profile.html?id=${encodeURIComponent(item.displayId)}` : '#'}" title="${escapeHtml(item.name)} · ${formatTokens(item.totalTokens)}">
          <span class="n">#${item.rank}</span>
          <span class="nm">${escapeHtml(item.name)}</span>
          <span class="tv" title="${escapeHtml(formatTokenRaw(item.totalTokens))}">${formatTokens(item.totalTokens)}</span>
          <span class="pct">${item.pct}%</span>
          <div class="rank-mini-bar"><i style="width:${Math.max(8, Math.round((item.pct / topBar) * 100))}%"></i></div>
        </a>
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
  const parts = COMPOSITION_PARTS.map((part) => {
    const tokens = Number(summary[part.key] || 0);
    const ratio = tokens / total;
    let pctStr = "0%";
    if (tokens > 0) {
      const p = ratio * 100;
      if (p < 0.1) pctStr = "<0.1%";
      else if (p < 1) pctStr = `${p.toFixed(1)}%`;
      else pctStr = `${Math.round(p)}%`;
    }
    return {
      ...part,
      label: t(part.labelKey),
      tokens,
      ratio,
      pct: Math.round(ratio * 100),
      pctStr
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
          <strong>${dominant.pctStr || `${dominant.pct}%`}</strong>
          <span>${escapeHtml(dominant.label)}</span>
        </div>
      </div>
      <div class="comp-mix-list" role="list" aria-label="${escapeHtml(t("web.analytics.tokenComposition"))}">
        ${parts.map((part) => `
          <div class="comp-mix-row" role="listitem">
            <div class="comp-mix-head">
              <span class="swatch" style="background:${part.color}"></span>
              <span class="comp-label">${escapeHtml(part.label)}</span>
              <b>${part.pctStr}</b>
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

export function renderWeekdayRhythm(container, timeSeries = [], { tooltip = null, localeTokenCompact = (v) => v } = {}) {
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
    const nativeTitle = tooltip ? "" : ` title="${escapeHtml(label)} · ${share}%"`;
    return `
      <div class="d${index === peak ? " peak" : ""}"${nativeTitle}>
        <div class="col-wrap">
          <div class="col" style="height:${height}%"></div>
        </div>
        <strong class="val">${share}%</strong>
        <span>${escapeHtml(label)}</span>
      </div>
    `;
  }).join("");
  if (!tooltip) return;
  [...container.children].forEach((bar, index) => {
    const tokens = buckets[index];
    const share = Math.round((tokens / total) * 100);
    bar.addEventListener("mouseenter", () => {
      tooltip.innerHTML = `<strong>${escapeHtml(labels[index])}</strong><br>${localeTokenCompact(tokens)} ${escapeHtml(t("unit.tokens") || "tokens")} · ${share}%`;
      tooltip.style.opacity = "1";
      positionTooltip(tooltip, bar);
    });
    bar.addEventListener("mouseleave", () => { tooltip.style.opacity = "0"; });
  });
}

const SHARE_TREND_PALETTE = ["#087f79", "#b67810", "#466cae", "#76558f", "#6b5b95"];
const SHARE_TREND_OTHER_COLOR = "#b5aea0";

// Adaptive viewBox height for card charts: measure the chart frame's real box
// (grid rows stretch cards to the tallest sibling) so the drawing fills the
// card instead of leaving a blank strip under a width-scaled fixed aspect.
// Same measurement + ResizeObserver pattern as renderParticipantTreemap.
function adaptiveViewBoxHeight(svg, baseWidth, { min = 200, max = 470, fallback = 240 } = {}) {
  const host = svg.parentElement;
  let height = fallback;
  if (host) {
    const hostStyle = window.getComputedStyle(host);
    const availWidth = host.clientWidth - (parseFloat(hostStyle.paddingLeft) || 0) - (parseFloat(hostStyle.paddingRight) || 0);
    const availHeight = host.clientHeight - (parseFloat(hostStyle.paddingTop) || 0) - (parseFloat(hostStyle.paddingBottom) || 0);
    if (availWidth > 100 && availHeight > 80) {
      height = Math.round(baseWidth * availHeight / availWidth);
    }
  }
  return Math.max(min, Math.min(max, height));
}

function observeAdaptiveResize(svg, redraw) {
  if (typeof ResizeObserver === "undefined" || svg.__adaptiveResize) return;
  let raf = 0;
  svg.__adaptiveResize = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(redraw);
  });
  svg.__adaptiveResize.observe(svg.parentElement || svg);
  // First paint settles late (sibling cards grow, fonts land): re-measure on
  // the next frames AND after a short timer so the initial viewBox is not
  // stuck on the fallback measured before the row finished stretching.
  requestAnimationFrame(() => requestAnimationFrame(redraw));
  setTimeout(redraw, 150);
}

// Monthly 100% stacked AREA for composition evolution cards: one smooth band
// per name (top-N plus "other"), share of each month's total. Unlike stacked
// columns the continuous bands read as a mix that drifts over time.
export function renderShareAreaStacked(svg, months = [], series = [], { tooltip = null, localeTokenCompact = (v) => v } = {}) {
  if (!svg) return;
  svg.innerHTML = "";
  if (months.length < 2 || !series.length) {
    svg.setAttribute("viewBox", "0 0 800 240");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.innerHTML = `<text x="400" y="120" text-anchor="middle" class="st-empty">${escapeHtml(t("web.analytics.noData"))}</text>`;
    return;
  }
  const width = 800;
  const height = adaptiveViewBoxHeight(svg, 800, { min: 200, max: 470, fallback: 240 });
  const padLeft = 34;
  const padRight = 10;
  const padBottom = 22;
  const padTop = 10;
  const plotW = width - padLeft - padRight;
  const plotH = height - padBottom - padTop;
  const n = months.length;
  const xAt = (index) => padLeft + (plotW * index) / (n - 1);
  const yAt = (pct) => padTop + plotH * (1 - Math.max(0, Math.min(1, pct)));
  const totals = months.map((_, index) => series.reduce((sum, row) => sum + (row.series[index] || 0), 0));
  const shares = series.map((row) => row.series.map((value, index) => (totals[index] > 0 ? (value || 0) / totals[index] : 0)));
  const cumulative = shares.map((_, seriesIndex) => {
    const line = [];
    let acc = 0;
    for (let m = 0; m < n; m++) {
      acc = 0;
      for (let s = 0; s <= seriesIndex; s++) acc += shares[s][m];
      line.push(acc);
    }
    return line;
  });
  const lowerLine = (seriesIndex) => (seriesIndex === 0 ? months.map(() => 0) : cumulative[seriesIndex - 1]);

  const parts = [];
  parts.push(`<g class="st-grid">`);
  for (let pct = 0; pct <= 100; pct += 25) {
    const y = yAt(pct / 100);
    parts.push(`<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}"${pct === 0 ? ' class="st-baseline"' : ""}></line>`);
    parts.push(`<text x="${padLeft - 6}" y="${y + 3}" text-anchor="end" class="st-axis">${pct}%</text>`);
  }
  parts.push(`</g>`);
  series.forEach((row, seriesIndex) => {
    const upper = cumulative[seriesIndex];
    const lower = lowerLine(seriesIndex);
    const topPts = upper.map((pct, index) => `${xAt(index).toFixed(1)},${yAt(pct).toFixed(1)}`);
    const bottomPts = lower.map((pct, index) => `${xAt(index).toFixed(1)},${yAt(pct).toFixed(1)}`).reverse();
    const color = row.other ? SHARE_TREND_OTHER_COLOR : SHARE_TREND_PALETTE[seriesIndex % SHARE_TREND_PALETTE.length];
    parts.push(`<path class="sa-band" d="M ${topPts.join(" L ")} L ${bottomPts.join(" L ")} Z" fill="${color}" fill-opacity="${row.other ? 0.55 : 0.8}" stroke="${color}" stroke-opacity="0.5" stroke-width="0.6"></path>`);
  });
  months.forEach((month, index) => {
    if (n > 8 && index % 2 === 1 && index !== n - 1) return;
    parts.push(`<text x="${xAt(index)}" y="${height - 6}" text-anchor="middle" class="st-axis">${escapeHtml(String(month || "").slice(2).replace("-", "/"))}</text>`);
  });
  const guide = `<line class="st-guide" x1="0" y1="${padTop}" x2="0" y2="${padTop + plotH}"></line>`;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.innerHTML = parts.join("") + guide;
  const guideEl = svg.querySelector(".st-guide");

  if (!tooltip) return;
  const hit = document.createElementNS("http://www.w3.org/2000/svg", "g");
  months.forEach((month, index) => {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("class", "st-hit");
    rect.setAttribute("x", String(padLeft + (plotW * index) / n - plotW / (2 * n)));
    rect.setAttribute("y", String(padTop));
    rect.setAttribute("width", String(plotW / n));
    rect.setAttribute("height", String(plotH));
    rect.setAttribute("fill", "transparent");
    rect.addEventListener("mouseenter", () => {
      const lines = series
        .map((row) => ({ row, value: row.series[index] || 0 }))
        .filter((item) => item.value > 0)
        .sort((a, b) => b.value - a.value)
        .map(({ row, value }) => `${escapeHtml(row.other ? t("web.analytics.otherShare") : row.name)} · ${Math.round((value / (totals[index] || 1)) * 100)}% · ${localeTokenCompact(value)}`);
      tooltip.innerHTML = `<strong>${escapeHtml(month)}</strong><br>${lines.join("<br>")}`;
      tooltip.style.opacity = "1";
      positionTooltip(tooltip, rect);
      if (guideEl) {
        guideEl.setAttribute("x1", String(xAt(index)));
        guideEl.setAttribute("x2", String(xAt(index)));
        guideEl.style.opacity = "1";
      }
    });
    rect.addEventListener("mouseleave", () => {
      tooltip.style.opacity = "0";
      if (guideEl) guideEl.style.opacity = "0";
    });
    hit.appendChild(rect);
  });
  svg.appendChild(hit);
  observeAdaptiveResize(svg, () => renderShareAreaStacked(svg, months, series, { tooltip, localeTokenCompact }));
}

// Monthly concentration as cumulative bands: top-1 stays a gold line, ranks
// 2–5 and 6–10 become stacked bands under it. Nested cumulative shares read as
// bands (not three always-ordered lines), and the right edge annotates the
// latest values so the current state is stated, not just implied.
export function renderConcentrationTrend(svg, rows = [], { tooltip = null, localeTokenCompact = (v) => v } = {}) {
  if (!svg) return;
  svg.innerHTML = "";
  if (!rows.length) return;
  const width = 800;
  const height = adaptiveViewBoxHeight(svg, 800, { min: 200, max: 470, fallback: 240 });
  const padLeft = 34;
  const padRight = 44;
  const padBottom = 22;
  const padTop = 10;
  const plotW = width - padLeft - padRight;
  const plotH = height - padBottom - padTop;
  const n = rows.length;
  const xAt = (index) => padLeft + (n === 1 ? plotW / 2 : (plotW * index) / (n - 1));
  const yAt = (pct) => padTop + plotH * (1 - Math.max(0, Math.min(1, pct)));
  const metrics = [
    { key: "top1Pct", label: t("web.analytics.concentrationTop1"), color: "#b67810", band: false },
    { key: "top5Pct", label: t("web.analytics.concentrationTop5"), color: "#087f79", band: true, bandFrom: "top1Pct", bandOpacity: 0.22 },
    { key: "top10Pct", label: t("web.analytics.concentrationTop10"), color: "#087f79", band: true, bandFrom: "top5Pct", bandOpacity: 0.1 }
  ];

  const parts = [];
  parts.push(`<g class="st-grid">`);
  for (let pct = 0; pct <= 100; pct += 25) {
    const y = yAt(pct / 100);
    parts.push(`<line x1="${padLeft}" y1="${y}" x2="${padLeft + plotW}" y2="${y}"${pct === 0 ? ' class="st-baseline"' : ""}></line>`);
    parts.push(`<text x="${padLeft - 6}" y="${y + 3}" text-anchor="end" class="st-axis">${pct}%</text>`);
  }
  parts.push(`</g>`);
  // Bands first (drawn beneath), from the widest down.
  for (const metric of [...metrics].reverse()) {
    if (!metric.band) continue;
    const upper = rows.map((row) => row[metric.key] || 0);
    const lower = rows.map((row) => row[metric.bandFrom] || 0);
    const topPts = upper.map((pct, index) => `${xAt(index).toFixed(1)},${yAt(pct).toFixed(1)}`);
    const bottomPts = lower.map((pct, index) => `${xAt(index).toFixed(1)},${yAt(pct).toFixed(1)}`).reverse();
    parts.push(`<path d="M ${topPts.join(" L ")} L ${bottomPts.join(" L ")} Z" fill="${metric.color}" fill-opacity="${metric.bandOpacity}"></path>`);
  }
  const last = rows[n - 1];
  for (const metric of metrics) {
    const points = rows.map((row, index) => `${xAt(index).toFixed(1)},${yAt(row[metric.key] || 0).toFixed(1)}`);
    if (metric.band) {
      parts.push(`<polyline points="${points.join(" ")}" fill="none" stroke="${metric.color}" stroke-width="1.4" stroke-opacity="0.75" stroke-linejoin="round"></polyline>`);
    } else {
      parts.push(`<polyline class="ct-top1" points="${points.join(" ")}" fill="none" stroke="${metric.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"></polyline>`);
    }
    rows.forEach((row, index) => {
      parts.push(`<circle class="ct-point" cx="${xAt(index).toFixed(1)}" cy="${yAt(row[metric.key] || 0).toFixed(1)}" r="${metric.band ? 2.2 : 3}" fill="${metric.color}" fill-opacity="${metric.band ? 0.8 : 1}"></circle>`);
    });
    parts.push(`<text x="${padLeft + plotW + 6}" y="${yAt(last[metric.key] || 0) + 3}" class="st-axis" fill="${metric.color}" font-weight="600">${Math.round((last[metric.key] || 0) * 100)}%</text>`);
  }
  rows.forEach((row, index) => {
    if (n > 8 && index % 2 === 1 && index !== n - 1) return;
    parts.push(`<text x="${xAt(index)}" y="${height - 6}" text-anchor="middle" class="st-axis">${escapeHtml(String(row.month || "").slice(2).replace("-", "/"))}</text>`);
  });
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.innerHTML = parts.join("");
  const pointEls = [...svg.querySelectorAll(".ct-point")];

  if (!tooltip) return;
  rows.forEach((row, index) => {
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    hit.setAttribute("class", "st-hit");
    hit.setAttribute("x", String(xAt(index) - plotW / (2 * Math.max(n, 1))));
    hit.setAttribute("y", String(padTop));
    hit.setAttribute("width", String(plotW / Math.max(n, 1)));
    hit.setAttribute("height", String(plotH));
    hit.setAttribute("fill", "transparent");
    hit.addEventListener("mouseenter", () => {
      const lines = metrics.map((metric) => `${escapeHtml(metric.label)} ${Math.round((row[metric.key] || 0) * 100)}%`);
      tooltip.innerHTML = `<strong>${escapeHtml(row.month)}</strong><br>${lines.join("<br>")}<br>${localeTokenCompact(row.totalTokens)} · ${row.participants} ${escapeHtml(t("web.analytics.activeDevs") || "")}`;
      tooltip.style.opacity = "1";
      positionTooltip(tooltip, hit);
      pointEls.forEach((el) => { el.setAttribute("r", String(Number(el.getAttribute("r")) * 1.6)); });
    });
    hit.addEventListener("mouseleave", () => {
      tooltip.style.opacity = "0";
      pointEls.forEach((el) => { el.setAttribute("r", String(Number(el.getAttribute("r")) / 1.6)); });
    });
    svg.appendChild(hit);
  });
  observeAdaptiveResize(svg, () => renderConcentrationTrend(svg, rows, { tooltip, localeTokenCompact }));
}

// 24-hour activity clock: radial sectors around a clock face where 0h sits at
// the top and sector radius encodes that hour's tokens. Peak hour is gold,
// night hours (0–6) are stone — the day reads literally as a dial.
export function renderHourClock(svg, items = [], { tooltip = null, localeTokenCompact = (v) => v, peakHour = -1 } = {}) {
  if (!svg) return;
  svg.innerHTML = "";
  const total = items.reduce((sum, item) => sum + (item.totalTokens || 0), 0);
  if (!total) {
    svg.setAttribute("viewBox", "0 0 420 320");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.innerHTML = `<text x="210" y="160" text-anchor="middle" class="st-empty">${escapeHtml(t("web.analytics.noData"))}</text>`;
    return;
  }
  const width = 420;
  const height = 320;
  const cx = width / 2;
  const cy = height / 2;
  const rMin = 58;
  const rMax = 128;
  const maxTokens = Math.max(...items.map((item) => item.totalTokens || 0), 1);
  const buckets = Array.from({ length: 24 }, (_, hour) => items.find((item) => Number(item.hour) === hour) || { hour, totalTokens: 0 });
  const sectorGap = 1.6;
  const polar = (hour, radius) => {
    const angle = ((hour / 24) * 360 - 90 + sectorGap / 2) * (Math.PI / 180);
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  };
  const sectorPath = (hour, radius) => {
    const a0 = ((hour / 24) * 360 - 90 + sectorGap / 2) * (Math.PI / 180);
    const a1 = (((hour + 1) / 24) * 360 - 90 - sectorGap / 2) * (Math.PI / 180);
    const [x0, y0] = [cx + rMin * Math.cos(a0), cy + rMin * Math.sin(a0)];
    const [x1, y1] = [cx + radius * Math.cos(a0), cy + radius * Math.sin(a0)];
    const [x2, y2] = [cx + radius * Math.cos(a1), cy + radius * Math.sin(a1)];
    const [x3, y3] = [cx + rMin * Math.cos(a1), cy + rMin * Math.sin(a1)];
    return `M ${x0.toFixed(1)} ${y0.toFixed(1)} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${radius} ${radius} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)} L ${x3.toFixed(1)} ${y3.toFixed(1)} A ${rMin} ${rMin} 0 0 0 ${x0.toFixed(1)} ${y0.toFixed(1)} Z`;
  };

  const parts = [];
  for (const bucket of buckets) {
    const tokens = bucket.totalTokens || 0;
    const radius = tokens > 0 ? rMin + (rMax - rMin) * Math.sqrt(tokens / maxTokens) : rMin + 2;
    const isPeak = bucket.hour === peakHour;
    const color = isPeak ? "#b67810" : bucket.hour < 6 ? "#b5aea0" : "#087f79";
    const opacity = tokens > 0 ? (isPeak ? 0.95 : bucket.hour < 6 ? 0.55 : 0.8) : 0.12;
    parts.push(`<path class="hc-sector" data-opacity="${opacity}" d="${sectorPath(bucket.hour, radius)}" fill="${color}" fill-opacity="${opacity}"></path>`);
  }
  for (const hour of [0, 6, 12, 18]) {
    const [x, y] = polar(hour, rMax + 16);
    parts.push(`<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="middle" class="st-axis">${String(hour).padStart(2, "0")}</text>`);
  }
  if (peakHour >= 0) {
    parts.push(`<text x="${cx}" y="${cy - 4}" text-anchor="middle" class="hc-peak">${String(peakHour).padStart(2, "0")}:00</text>`);
    parts.push(`<text x="${cx}" y="${cy + 12}" text-anchor="middle" class="hc-peak-sub">${escapeHtml(t("web.analytics.goldenHour"))}</text>`);
  }
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.innerHTML = parts.join("");

  if (!tooltip) return;
  const sectors = [...svg.querySelectorAll(".hc-sector")];
  buckets.forEach((bucket, index) => {
    const el = sectors[index];
    if (!el) return;
    el.style.cursor = "pointer";
    el.addEventListener("mouseenter", () => {
      el.setAttribute("fill-opacity", "1");
      tooltip.innerHTML = `<strong>${String(bucket.hour).padStart(2, "0")}:00</strong><br>${localeTokenCompact(bucket.totalTokens || 0)} ${escapeHtml(t("unit.tokens") || "tokens")} · ${Math.round(((bucket.totalTokens || 0) / total) * 100)}%`;
      tooltip.style.opacity = "1";
      positionTooltip(tooltip, el);
    });
    el.addEventListener("mouseleave", () => {
      tooltip.style.opacity = "0";
      el.setAttribute("fill-opacity", String(el.dataset.opacity || "0.8"));
    });
  });
}

// Weekday × hour activity matrix: 7 rows (Mon-first) × 24 columns, cell ink
// density encodes tokens. Collapses weekday rhythm and hourly rhythm into a
// single "when does the company code" picture.
export function renderHourWeekdayMatrix(container, items = [], { tooltip = null, localeTokenCompact = (v) => v } = {}) {
  if (!container) return;
  const maxVal = Math.max(1, ...items.flat());
  const total = items.flat().reduce((sum, value) => sum + value, 0);
  if (!total) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(t("web.analytics.noData"))}</div>`;
    return;
  }
  const weekdayLabels = [
    t("web.analytics.weekdayMon"), t("web.analytics.weekdayTue"), t("web.analytics.weekdayWed"), t("web.analytics.weekdayThu"),
    t("web.analytics.weekdayFri"), t("web.analytics.weekdaySat"), t("web.analytics.weekdaySun")
  ];
  const alpha = (value) => (value > 0 ? (0.07 + 0.85 * Math.sqrt(value / maxVal)).toFixed(2) : "0");
  let html = `<div class="hw-cols">${Array.from({ length: 25 }, (_, i) => i === 0 ? "<span></span>" : `<span>${i - 1 === 0 || (i - 1) % 3 === 0 ? String(i - 1).padStart(2, "0") : ""}</span>`).join("")}</div>`;
  items.forEach((row, weekdayIndex) => {
    html += `<div class="hw-row"><span class="hw-day">${escapeHtml(weekdayLabels[weekdayIndex])}</span>${row
      .map((value, hour) => `<i class="hw-cell" data-w="${weekdayIndex}" data-h="${hour}" style="background:rgba(8,127,121,${alpha(value)})"></i>`)
      .join("")}</div>`;
  });
  container.innerHTML = html;
  if (!tooltip) return;
  container.querySelectorAll(".hw-cell").forEach((cell) => {
    cell.addEventListener("mouseenter", () => {
      const value = items[Number(cell.dataset.w)][Number(cell.dataset.h)];
      tooltip.innerHTML = `<strong>${escapeHtml(weekdayLabels[Number(cell.dataset.w)])} ${String(cell.dataset.h).padStart(2, "0")}:00</strong><br>${localeTokenCompact(value || 0)} ${escapeHtml(t("unit.tokens") || "tokens")}`;
      tooltip.style.opacity = "1";
      positionTooltip(tooltip, cell);
    });
    cell.addEventListener("mouseleave", () => { tooltip.style.opacity = "0"; });
  });
}

// Month-over-month grouped bar rows: one row per name with a muted "previous
// month" bar and a teal "current month" bar plus a delta badge. Reads instantly
// — no axis or slope interpretation needed.
export function renderCompareBars(container, rows = [], { localeTokenCompact = (v) => v, prevLabel = "", currLabel = "" } = {}) {
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(t("web.analytics.noData"))}</div>`;
    return;
  }
  const maxVal = Math.max(...rows.flatMap((row) => [row.from || 0, row.to || 0]), 1);
  container.innerHTML = rows.map((row) => {
    const from = row.from || 0;
    const to = row.to || 0;
    const delta = from > 0 ? Math.round((to / from - 1) * 100) : null;
    const deltaClass = delta === null || delta === 0 ? "flat" : delta > 0 ? "up" : "down";
    const deltaText = delta === null ? "新增" : `${delta > 0 ? "+" : ""}${delta}%`;
    const bar = (value, kind) => `<div class="cmp-bar cmp-${kind}"><i style="width:${Math.max(1, Math.round((value / maxVal) * 100))}%"></i><span>${escapeHtml(localeTokenCompact(value))}</span></div>`;
    return `<div class="cmp-row" title="${escapeHtml(String(row.name))} · ${escapeHtml(prevLabel)} ${escapeHtml(localeTokenCompact(from))} → ${escapeHtml(currLabel)} ${escapeHtml(localeTokenCompact(to))}">
      <div class="cmp-head">
        <span class="cmp-name" title="${escapeHtml(String(row.name))}">${escapeHtml(String(row.name))}</span>
        <span class="cmp-delta ${deltaClass}">${escapeHtml(deltaText)}</span>
      </div>
      ${bar(from, "prev")}
      ${bar(to, "curr")}
    </div>`;
  }).join("");
}

// Work-share attribution from whole-hour buckets: each boundary hour counts
// proportionally to its overlap with the [workStart, workEnd) window, so a
// 09:30 start attributes half of the 09:00 bucket. Windows may cross midnight.
function hourOverlapFraction(hour, startMin, endMin) {
  const segments = endMin <= startMin
    ? [[startMin, 1440], [0, endMin]]
    : [[startMin, endMin]];
  const hourStart = hour * 60;
  const hourEnd = hourStart + 60;
  let overlap = 0;
  for (const [segStart, segEnd] of segments) {
    overlap += Math.max(0, Math.min(segEnd, hourEnd) - Math.max(segStart, hourStart));
  }
  return Math.min(1, overlap / 60);
}

export function computeHourlyRhythmStats(items = [], { workStart = "09:30", workEnd = "18:30" } = {}) {
  const parseMinutes = (value) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const minutes = Number(match[1]) * 60 + Number(match[2]);
    return minutes >= 0 && minutes < 1440 ? minutes : null;
  };
  const startMin = parseMinutes(workStart) ?? parseMinutes("09:30");
  const endMin = parseMinutes(workEnd) ?? parseMinutes("18:30");
  // Echo the window actually used, not the raw params: an invalid input must
  // not surface in labels while computation silently fell back.
  const usedStart = `${String(Math.floor(startMin / 60)).padStart(2, "0")}:${String(startMin % 60).padStart(2, "0")}`;
  const usedEnd = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
  let total = 0;
  let night = 0;
  let evening = 0;
  let work = 0;
  let peakHour = -1;
  let peakTokens = 0;
  for (const item of items) {
    const tokens = Number(item.totalTokens || 0);
    const hour = Number(item.hour);
    total += tokens;
    if (hour >= 0 && hour < 6) night += tokens;
    if (hour >= 18 && hour < 24) evening += tokens;
    if (hour >= 0 && hour < 24) work += tokens * hourOverlapFraction(hour, startMin, endMin);
    if (tokens > peakTokens) {
      peakTokens = tokens;
      peakHour = hour;
    }
  }
  if (!total) return { total, peakHour: -1, peakShare: 0, nightShare: 0, eveningShare: 0, workTokens: 0, workShare: 0, workStart: usedStart, workEnd: usedEnd };
  return {
    total,
    peakHour,
    peakShare: peakTokens / total,
    nightShare: night / total,
    eveningShare: evening / total,
    workTokens: work,
    workShare: work / total,
    workStart: usedStart,
    workEnd: usedEnd
  };
}

export function renderHourlyRhythm(container, items = [], { localeTokenCompact = (v) => v, tooltip = null } = {}) {
  if (!container) return;
  const buckets = Array.from({ length: 24 }, (_, hour) => {
    const match = items.find((item) => Number(item.hour) === hour);
    return match ? Number(match.totalTokens || 0) : 0;
  });
  const total = buckets.reduce((sum, value) => sum + value, 0);
  if (!total) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(t("web.analytics.noData"))}</div>`;
    return;
  }
  const max = Math.max(...buckets, 1);
  const peak = buckets.indexOf(Math.max(...buckets));
  container.innerHTML = buckets.map((tokens, hour) => {
    const height = Math.max(4, Math.round((tokens / max) * 100));
    const share = (tokens / total) * 100;
    const shareText = share >= 10 ? `${Math.round(share)}%` : `${share.toFixed(1)}%`;
    const label = String(hour).padStart(2, "0");
    const nativeTitle = tooltip ? "" : ` title="${escapeHtml(`${label}:00 · ${localeTokenCompact(tokens)} · ${share.toFixed(1)}%`)}"`;
    return `
      <div class="d${hour === peak ? " peak" : ""}"${nativeTitle}>
        <div class="col-wrap">
          <div class="col" style="height:${height}%"></div>
        </div>
        <strong class="val">${shareText}</strong>
        <span class="h-label${hour % 3 === 0 ? "" : " minor"}">${label}</span>
      </div>
    `;
  }).join("");
  if (!tooltip) return;
  [...container.children].forEach((bar, hour) => {
    const tokens = buckets[hour];
    const share = ((tokens / total) * 100).toFixed(1);
    bar.addEventListener("mouseenter", () => {
      tooltip.innerHTML = `<strong>${String(hour).padStart(2, "0")}:00</strong><br>${localeTokenCompact(tokens)} ${escapeHtml(t("unit.tokens") || "tokens")} · ${share}%`;
      tooltip.style.opacity = "1";
      positionTooltip(tooltip, bar);
    });
    bar.addEventListener("mouseleave", () => { tooltip.style.opacity = "0"; });
  });
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

// Card-scale source donut: a larger ring with the community total in the
// center and legend rows carrying token values — denser than a plain bar list
// and visually balanced against tall sibling cards.
export function renderSourceDonutCard(container, items = [], { localeTokenCompact = (v) => v, tooltip = null } = {}) {
  if (!container) return;
  const tokensOf = (item) => Number(item.tokens || item.totalTokens || 0);
  const total = items.reduce((sum, item) => sum + tokensOf(item), 0);
  if (!total || !items.length) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(t("web.analytics.noData"))}</div>`;
    return;
  }
  const radius = 80;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const segments = items.map((item) => {
    const tokens = tokensOf(item);
    const ratio = tokens / total;
    const dash = ratio * circumference;
    const segment = { color: providerSourceColor(item.id || item.name || "other"), dash, offset, item, tokens, ratio };
    offset -= dash;
    return segment;
  });
  container.innerHTML = `<div class="asd-wrap">
    <svg class="asd-donut" viewBox="0 0 200 200" role="img">
      <circle cx="100" cy="100" r="${radius}" fill="none" stroke="var(--line-soft)" stroke-width="26"></circle>
      ${segments.map((segment, index) => `<circle class="asd-seg" data-i="${index}" cx="100" cy="100" r="${radius}" fill="none" stroke="${segment.color}" stroke-width="26" stroke-dasharray="${segment.dash} ${circumference}" stroke-dashoffset="${segment.offset}" transform="rotate(-90 100 100)"></circle>`).join("")}
      <text x="100" y="97" text-anchor="middle" class="asd-center-val">${escapeHtml(localeTokenCompact(total))}</text>
      <text x="100" y="116" text-anchor="middle" class="asd-center-lab">${escapeHtml(t("web.totalTokens"))}</text>
    </svg>
    <div class="asd-legend">
      ${segments.map((segment) => `<div class="asd-row" data-name="${escapeHtml(segment.item.label || segment.item.name)}">
        <span class="swatch" style="background:${segment.color}"></span>
        <span class="asd-name" title="${escapeHtml(segment.item.name)}">${escapeHtml(segment.item.label || segment.item.name)}</span>
        <strong class="asd-tokens">${escapeHtml(localeTokenCompact(segment.tokens))}</strong>
        <span class="asd-pct">${Math.round(segment.ratio * 100)}%</span>
      </div>`).join("")}
    </div>
  </div>`;
  if (!tooltip) return;
  [...container.querySelectorAll(".asd-seg")].forEach((el) => {
    const segment = segments[Number(el.dataset.i)];
    el.style.cursor = "pointer";
    el.addEventListener("mouseenter", () => {
      el.setAttribute("stroke-width", "30");
      tooltip.innerHTML = `<strong>${escapeHtml(segment.item.label || segment.item.name)}</strong><br>${escapeHtml(localeTokenCompact(segment.tokens))} · ${Math.round(segment.ratio * 100)}%`;
      tooltip.style.opacity = "1";
      positionTooltip(tooltip, el);
    });
    el.addEventListener("mouseleave", () => {
      el.setAttribute("stroke-width", "26");
      tooltip.style.opacity = "0";
    });
  });
}

export function renderActivityHeatmap(grid, heatmap = [], {
  from = "",
  to = "",
  businessDay = "",
  tooltip,
  localeTokenCompact,
  layout = "calendar",
  levels = 4
} = {}) {
  if (!grid) return;
  grid.innerHTML = "";

  const totalsByDay = {};
  for (const pt of heatmap) totalsByDay[pt.day] = pt.totalTokens || 0;
  const maxVal = Math.max(...Object.values(totalsByDay), 0);

  if (layout === "heatfull") {
    renderHeatFullStrip(grid, {
      totalsByDay,
      maxVal,
      to,
      businessDay,
      tooltip,
      localeTokenCompact,
      levels
    });
    return;
  }

  if (layout === "heat90") {
    renderHeat90Strip(grid, {
      totalsByDay,
      maxVal,
      to,
      businessDay,
      tooltip,
      localeTokenCompact,
      levels
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
      level: heatLevel(tokens, maxVal, levels),
      tooltip,
      localeTokenCompact
    });
  }
}

// levels <= 4 keeps the legacy linear buckets so existing 5-shade layouts
// (analytics, download) render unchanged. Higher level counts use a sqrt
// scale: daily usage is heavy-tailed (median day often <10% of the peak),
// so linear buckets pile most days into the lowest shade.
function heatLevel(tokens, maxVal, levels = 4) {
  if (!(tokens > 0 && maxVal > 0)) return 0;
  const ratio = tokens / maxVal;
  if (levels <= 4) {
    if (ratio > 0.75) return 4;
    if (ratio > 0.50) return 3;
    if (ratio > 0.25) return 2;
    return 1;
  }
  const scaled = Math.sqrt(ratio) * levels;
  return Math.max(1, Math.min(levels, Math.ceil(scaled)));
}

function renderHeat90Strip(grid, {
  totalsByDay,
  maxVal,
  businessDay = "",
  to = "",
  tooltip,
  localeTokenCompact,
  levels = 4
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
      level: heatLevel(tokens, maxVal, levels),
      tooltip,
      localeTokenCompact
    });
  }
}

// Full-history strip: spans from the participant's earliest usage day to the
// anchor day, aligned to real weekly columns (7 rows, Monday to Sunday).
function renderHeatFullStrip(grid, {
  totalsByDay,
  maxVal,
  businessDay = "",
  to = "",
  tooltip,
  localeTokenCompact,
  levels = 4
}) {
  grid.classList.remove("heat90");
  grid.classList.add("heat-calendar-weeks");
  const dayKeys = Object.keys(totalsByDay).sort();
  if (!dayKeys.length) return;
  const anchorDay = to || businessDay || new Date().toISOString().split("T")[0];
  const firstDay = dayKeys[0] < anchorDay ? dayKeys[0] : anchorDay;

  // Align start to the Monday of that week
  const startDate = new Date(`${firstDay}T00:00:00Z`);
  const startDayOfWeek = startDate.getUTCDay(); // 0 = Sun, 1 = Mon ...
  const startOffset = (startDayOfWeek + 6) % 7;
  const alignedStart = new Date(startDate);
  alignedStart.setUTCDate(startDate.getUTCDate() - startOffset);

  // Align end to the Sunday of that week
  const endDate = new Date(`${anchorDay}T00:00:00Z`);
  const endDayOfWeek = endDate.getUTCDay();
  const endOffset = (6 - ((endDayOfWeek + 6) % 7));
  const alignedEnd = new Date(endDate);
  alignedEnd.setUTCDate(endDate.getUTCDate() + endOffset);

  const totalDays = Math.max(7, Math.round((alignedEnd - alignedStart) / 86400000) + 1);
  const weekCount = Math.max(1, Math.ceil(totalDays / 7));
  grid.style.setProperty("--heat-weeks", String(weekCount));
  const frame = grid.closest(".heatmap-scroll-frame");
  if (frame) frame.style.setProperty("--heat-weeks", String(weekCount));

  for (let i = 0; i < totalDays; i++) {
    const cellDate = new Date(alignedStart);
    cellDate.setUTCDate(alignedStart.getUTCDate() + i);
    const dayStr = cellDate.toISOString().split("T")[0];
    const isOutOfRange = dayStr < firstDay || dayStr > anchorDay;
    const tokens = isOutOfRange ? 0 : (totalsByDay[dayStr] || 0);
    appendHeatmapCell(grid, {
      dayStr,
      tokens,
      level: isOutOfRange ? -1 : heatLevel(tokens, maxVal, levels),
      tooltip: isOutOfRange ? null : tooltip,
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
  if (level === -1) {
    cell.className = "heatmap-cell level-empty";
    grid.appendChild(cell);
    return;
  }
  cell.className = `heatmap-cell level-${level}`;
  cell.dataset.date = dayStr;
  cell.dataset.tokens = tokens;

  if (tooltip) {
    cell.addEventListener("mouseenter", () => {
      const unit = t("unit.tokens") || "tokens";
      tooltip.innerHTML = `<strong>${dayStr}</strong><div class="tooltip-val">${localeTokenCompact(tokens)} <span class="tooltip-unit">${unit}</span></div>`;
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

export function renderBarChart(container, items = [], { collapseAfter, collapseLabel, localeTokenCompact, showCost = false, renderCost: customRenderCost = null } = {}) {
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
      ratio: otherItems.reduce((sum, item) => sum + item.ratio, 0),
      estimatedCostUsd: otherItems.reduce((sum, item) => sum + (Number(item.estimatedCostUsd) || 0), 0),
      missingPriceTokens: otherItems.reduce((sum, item) => sum + (Number(item.missingPriceTokens) || 0), 0)
    }];
  }
  const totalTokens = displayItems.reduce((sum, item) => sum + Number(item.tokens || 0), 0);
  const costRenderer = customRenderCost || renderCost;
  for (const item of displayItems) {
    const ratio = Number.isFinite(Number(item.ratio))
      ? Number(item.ratio)
      : totalTokens > 0
        ? Number(item.tokens || 0) / totalTokens
        : 0;
    const rawPct = ratio * 100;
    let ratioPctStr = "0%";
    if (item.tokens > 0) {
      if (rawPct < 0.1) ratioPctStr = "<0.1%";
      else if (rawPct < 1) ratioPctStr = `${rawPct.toFixed(1)}%`;
      else ratioPctStr = `${Math.round(rawPct)}%`;
    }
    const barWidth = Math.max(0, Math.min(100, rawPct));
    const tokenLabel = localeTokenCompact(item.tokens);
    const hasCost = showCost && (item.estimatedCostUsd !== undefined && item.estimatedCostUsd !== null);
    const costHtml = hasCost ? `<span class="usage-share-cost">${costRenderer(item)}</span>` : "";
    const row = document.createElement("div");
    row.className = "usage-share-row";
    row.title = `${item.name}: ${tokenLabel} (${ratioPctStr})`;
    row.innerHTML = `
      <div class="lbl">
        <span class="usage-share-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
        <span class="usage-share-value">
          <strong>${tokenLabel}</strong>
          ${costHtml}
          <span>${ratioPctStr}</span>
        </span>
      </div>
      <div class="usage-share-track">
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
  const fallbackHeight = Math.max(360, Math.ceil((displayCount + 1) / 6) * 115);
  // Adaptive: relayout at the host board's real box so the mosaic fills the
  // grid-stretched height instead of leaving a blank strip under the chart.
  const host = svg.parentElement;
  let renderHeight = fallbackHeight;
  if (host) {
    const hostStyle = window.getComputedStyle(host);
    const availWidth = host.clientWidth
      - (parseFloat(hostStyle.paddingLeft) || 0)
      - (parseFloat(hostStyle.paddingRight) || 0);
    const availHeight = host.clientHeight
      - (parseFloat(hostStyle.paddingTop) || 0)
      - (parseFloat(hostStyle.paddingBottom) || 0);
    if (availWidth >= 240 && availHeight >= 160) {
      renderHeight = Math.min(900, Math.max(160, Math.round(width * availHeight / availWidth)));
    }
  }
  svg.setAttribute("viewBox", `0 0 ${width} ${renderHeight}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.style.aspectRatio = `${width} / ${renderHeight}`;
  if (host && typeof ResizeObserver !== "undefined" && !svg.__treemapResizeObserver) {
    let resizeRaf = 0;
    const rerender = () => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        renderParticipantTreemap(svg, labels, rankings, {
          localeTokenCompact,
          tooltip,
          sideContainer,
          legendContainer
        });
      });
    };
    svg.__treemapResizeObserver = new ResizeObserver(rerender);
    svg.__treemapResizeObserver.observe(host);
  }
  const sourceVariantCount = {};
  const entries = rankings.slice(0, displayCount).map((item) => ({
    name: item.displayName || item.nickname || item.participantId || "",
    displayId: item.displayId || item.participantId || "",
    totalTokens: Number(item.totalTokens || 0),
    primaryProvider: item.primaryProvider || item.primaryProviderId || "other"
  }));
  const otherTokens = rankings.slice(displayCount).reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);
  if (otherTokens > 0) {
    entries.push({ name: t("web.analytics.otherParticipants"), totalTokens: otherTokens, primaryProvider: "other" });
  }

  const totalTokens = entries.reduce((sum, item) => sum + item.totalTokens, 0);
  if (totalTokens <= 0) {
    const empty = svgEl("text", { x: width / 2, y: renderHeight / 2, class: "participant-treemap-empty" });
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

  const rectangles = layoutTreemap(entries, 0, 0, width, renderHeight, true);
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
    if (item.displayId) {
      rect.style.cursor = "pointer";
      rect.addEventListener("click", () => {
        window.location.assign(`/profile.html?id=${encodeURIComponent(item.displayId)}`);
      });
    }
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
    if (item.displayId) {
      group.style.cursor = "pointer";
      group.addEventListener("click", () => {
        window.location.assign(`/profile.html?id=${encodeURIComponent(item.displayId)}`);
      });
    }
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
