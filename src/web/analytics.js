import { initI18n, t, getCurrentLang, mountLangSwitcher, updatePageTranslations } from "/shared/i18n.js";
import "/theme-switcher.js";
import { formatTokenCompact } from "/shared/display.js";
import {
  escapeHtml, sourceName, formatCost, renderTrendChart as sharedRenderTrendChart,
  renderGauge as sharedRenderGauge, renderBarChart as sharedRenderBarChart,
  renderParticipantTreemap as sharedRenderParticipantTreemap,
  renderAnalyticsInsights, renderTokenComposition, renderParetoChart, renderWeekdayRhythm,
  renderActivityHeatmap, aggregateTimeSeriesByWeek,
  renderConcentrationTrend, renderShareAreaStacked, renderCompareBars,
  renderHourClock, renderHourWeekdayMatrix, computeHourlyRhythmStats,
  renderSourceDonutCard,
  THEME_PALETTE
} from "/shared/chart-helpers.js";
import {
  formatPeriodCaption, updatePeriodPillCaptions
} from "/console-ui.js";
import { initPublicNavProfile } from "/public-nav-profile.js";

const isEmbedded = window.self !== window.top;
if (isEmbedded) {
  document.addEventListener("DOMContentLoaded", () => {
    document.body.classList.add("is-embedded");
  });

  let lastReportedHeight = 0;
  let resizeFramePending = false;

  function notifyHeight() {
    const bodyHeight = document.body ? document.body.scrollHeight : 0;
    const height = Math.ceil(Math.max(document.documentElement.scrollHeight, bodyHeight));
    if (height === lastReportedHeight) return;
    lastReportedHeight = height;
    window.parent.postMessage({ type: "analytics-resize", height }, window.location.origin);
  }

  const resizeObserver = new ResizeObserver(() => {
    if (resizeFramePending) return;
    resizeFramePending = true;
    requestAnimationFrame(() => {
      resizeFramePending = false;
      notifyHeight();
    });
  });
  window.addEventListener("load", () => {
    notifyHeight();
    resizeObserver.observe(document.body);
  });
}

initI18n();

const state = {
  period: "this_month",
  data: null,
  loading: false
};

const loadingEl = document.querySelector("#analytics-loading");
let analyticsSettleTimer = null;

function setLoading(on) {
  state.loading = on;
  loadingEl.hidden = !on;
  const shell = document.querySelector(".analytics-shell");
  shell?.classList.toggle("is-refreshing", on);
  shell?.setAttribute("aria-busy", on ? "true" : "false");
  document.querySelectorAll("[data-filter='period'] button").forEach(btn => {
    btn.disabled = on;
    btn.style.pointerEvents = on ? "none" : "";
  });
  if (!on && shell) {
    if (analyticsSettleTimer) window.clearTimeout(analyticsSettleTimer);
    shell.classList.add("is-settled");
  }
}

const langContainer = document.querySelector("#lang-switcher-container");
if (langContainer) {
  mountLangSwitcher(langContainer, () => {
    window.location.reload();
  });
}
updatePageTranslations();

function localeTokenCompact(value) {
  return formatTokenCompact(value, getCurrentLang());
}

document.querySelectorAll("[data-filter='period']").forEach((group) => {
  group.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || state.loading) return;

    group.querySelectorAll("button").forEach((btn) => btn.classList.remove("active"));
    button.classList.add("active");

    state.period = button.dataset.value;

    setLoading(true);
    try {
      await loadAnalytics();
    } finally {
      setLoading(false);
    }
  });
});

// Embedded (admin) framing: the board reads as company-wide statistics there.
// Cost KPIs default to visible for internal stats and only hide when the admin
// cost toggle is explicitly off (admin.js persists "true"/"false").
if (isEmbedded) {
  const showCost = localStorage.getItem("ai-token-league.admin.showCost") !== "false";
  document.querySelectorAll(".an-kpi-cost").forEach((card) => { card.hidden = !showCost; });
}

async function loadAnalytics() {
  const params = new URLSearchParams({ period: state.period });

  const apiPath = isEmbedded ? "/api/admin/analytics" : "/api/board/analytics";
  const response = await fetch(`${apiPath}?${params.toString()}`);
  if (!response.ok) {
    console.error("Failed to load analytics");
    return;
  }

  state.data = await response.json();

  const dateRangeEl = document.querySelector("#period-date-range");
  if (dateRangeEl && state.data.from && state.data.to) {
    dateRangeEl.textContent = `${state.data.from} - ${state.data.to}`;
  }

  const periodMeta = {
    from: state.data.from || "",
    to: state.data.to || "",
    businessDay: state.data.businessDay || ""
  };
  updatePeriodPillCaptions(document, periodMeta);
  const periodLabel = document.querySelector("#analytics-period-label");
  if (periodLabel) periodLabel.textContent = formatPeriodCaption(state.period, periodMeta);

  const trendMeta = document.querySelector("#trend-meta");
  if (trendMeta) {
    trendMeta.textContent = formatPeriodCaption(state.period, periodMeta);
  }

  renderKPIs();
  renderInsights();
  renderComposition();
  renderPareto();
  renderWeekday();
  renderGauge();
  renderHeatmap();
  renderTrendChart();
  renderBarCharts();
  renderParticipantTreemapPanel();
  renderConcentrationTrendCard();
  renderCommunityHourlyCard();
  renderHourWeekdayCard();
  renderWorkdirCards();
  renderCompositionTrendCards();
  if (isEmbedded) loadEcoSection().catch((err) => console.error("Eco section failed:", err));
}

function renderInsights() {
  renderAnalyticsInsights(document.querySelector("#analytics-insights"), state.data);
}

function renderComposition() {
  renderTokenComposition(document.querySelector("#token-composition"), state.data?.summary || {});
}

function renderPareto() {
  renderParetoChart(document.querySelector("#pareto-chart"), state.data?.participantRanking || []);
}

function renderWeekday() {
  renderWeekdayRhythm(document.querySelector("#weekday-chart"), state.data?.timeSeries || []);
}

function renderGauge() {
  const summary = state.data.summary || {};
  sharedRenderGauge(
    document.querySelector("#gauge-fill"),
    document.querySelector("#gauge-val"),
    summary.cacheHitRate || 0
  );
  const hitRateEl = document.querySelector("#kpi-hit-rate");
  if (hitRateEl) hitRateEl.textContent = `${Math.round((summary.cacheHitRate || 0) * 100)}%`;
}

function renderTrendChart() {
  const svg = document.querySelector("#trend-chart");
  if (!svg) return;
  const tooltip = document.querySelector("#chart-tooltip");
  const dailySeries = state.data.timeSeries || [];
  const isAllPeriod = state.period === "all";
  const series = isAllPeriod ? aggregateTimeSeriesByWeek(dailySeries) : dailySeries;
  const grain = isAllPeriod ? "week" : (state.data.timeGrain || "day");
  // Render at the frame's real box so the chart fills the stretched card
  // without preserveAspectRatio="none" distorting text and dots.
  const frame = svg.closest(".chart-frame") || svg.parentElement;
  const box = frame ? frame.getBoundingClientRect() : { width: 0, height: 0 };
  sharedRenderTrendChart(svg, series, grain, tooltip, localeTokenCompact, {
    showActiveSeries: true,
    width: Math.max(320, Math.round(box.width)),
    height: Math.max(180, Math.round(box.height))
  });
}

// The trend card is stretched by the an-main grid, so its frame box changes
// with the composition card and the viewport; re-render at the real size.
if ("ResizeObserver" in window) {
  const trendFrame = document.querySelector("#trend-chart")?.closest(".chart-frame");
  let lastTrendBox = "";
  new ResizeObserver(() => {
    if (!trendFrame) return;
    const box = trendFrame.getBoundingClientRect();
    const key = `${Math.round(box.width)}x${Math.round(box.height)}`;
    if (key === lastTrendBox) return;
    lastTrendBox = key;
    renderTrendChart();
  }).observe(trendFrame);
}

function renderBarCharts() {
  sharedRenderBarChart(document.querySelector("#model-chart"), state.data.models, { collapseAfter: 11, localeTokenCompact });
  renderSourceDonutCard(document.querySelector("#provider-donut"), (state.data.providers || []).map(p => ({ name: p.name, label: sourceName(p.name), tokens: p.tokens })), {
    localeTokenCompact,
    tooltip: document.querySelector("#chart-tooltip")
  });
}

function renderParticipantTreemapPanel() {
  const card = document.querySelector("#participant-ranking-card");
  const svg = document.querySelector("#participant-treemap-svg");
  const labels = document.querySelector("#participant-treemap-labels");
  if (!card || !svg || !labels) return;

  card.hidden = false;
  sharedRenderParticipantTreemap(
    svg,
    labels,
    state.data?.participantRanking || [],
    {
      localeTokenCompact,
      tooltip: document.querySelector("#chart-tooltip"),
      sideContainer: document.querySelector("#treemap-side")
    }
  );
}

function renderShareTrendLegend(container, series = []) {
  if (!container) return;
  const palette = THEME_PALETTE.theme.trend;
  container.innerHTML = series
    .map((row, index) => {
      const color = row.other ? THEME_PALETTE.theme.rankOther : palette[index % palette.length];
      const swatch = row.other ? `background:${color};opacity:0.55` : `background:${color}`;
      const label = row.other ? t("web.analytics.otherShare") : row.name;
      return `<span><i style="${swatch}"></i><span title="${escapeHtml(label)}">${escapeHtml(String(label))}</span></span>`;
    })
    .join("");
}

function renderConcentrationTrendCard() {
  const svg = document.querySelector("#concentration-trend");
  if (!svg) return;
  renderConcentrationTrend(svg, state.data?.concentrationMonthly || [], {
    tooltip: document.querySelector("#chart-tooltip"),
    localeTokenCompact
  });
  const legend = document.querySelector("#concentration-legend");
  if (legend) {
    legend.innerHTML = [
      [THEME_PALETTE.theme.concentration[0], "web.analytics.concentrationTop1"],
      [THEME_PALETTE.theme.concentration[1], "web.analytics.concentrationTop5"],
      [THEME_PALETTE.theme.concentration[2], "web.analytics.concentrationTop10"]
    ].map(([color, key]) => `<span><i style="background:${color}"></i><span>${escapeHtml(t(key))}</span></span>`).join("");
  }
}

function renderCommunityHourlyCard() {
  const svg = document.querySelector("#community-hourly-clock");
  const metaEl = document.querySelector("#community-hourly-meta");
  if (!svg) return;
  const rhythm = state.data?.hourlyRhythm;
  const total = (rhythm?.items || []).reduce((sum, item) => sum + (item.totalTokens || 0), 0);
  if (!rhythm || !total) {
    svg.innerHTML = "";
    if (metaEl) metaEl.textContent = t("web.analytics.noHourly");
    return;
  }
  const stats = computeHourlyRhythmStats(rhythm.items, {
    workStart: rhythm.workWindow?.start || "09:30",
    workEnd: rhythm.workWindow?.end || "18:30"
  });
  renderHourClock(svg, rhythm.items, {
    tooltip: document.querySelector("#chart-tooltip"),
    localeTokenCompact,
    peakHour: stats.peakHour
  });
  if (metaEl) {
    metaEl.textContent = t("web.analytics.hourlyRhythmMeta", {
      days: rhythm.coverage?.days || 0,
      peak: String(stats.peakHour).padStart(2, "0"),
      night: Math.round(stats.nightShare * 100)
    });
  }
}

function renderHourWeekdayCard() {
  const container = document.querySelector("#hour-weekday-matrix");
  const metaEl = document.querySelector("#hw-matrix-meta");
  if (!container) return;
  const data = state.data?.hourlyByWeekday;
  renderHourWeekdayMatrix(container, data?.items || [], {
    tooltip: document.querySelector("#chart-tooltip"),
    localeTokenCompact
  });
  if (metaEl) {
    metaEl.textContent = data?.coverageDays
      ? t("web.analytics.matrixMeta", { days: data.coverageDays })
      : t("web.analytics.noHourly");
  }
}

function renderWorkdirCards() {
  const section = document.querySelector("#workdir-section");
  if (!section) return;
  // Workdir data is admin-only: the public board route strips these fields.
  const workdirs = state.data?.workdirs;
  if (!Array.isArray(workdirs) || !workdirs.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  // Wide (side-by-side) layout shows twice the rows; the stacked single
  // column keeps the compact top-5. Re-renders when the breakpoint flips.
  const wideLayout = !window.matchMedia("(max-width: 960px)").matches;
  sharedRenderBarChart(document.querySelector("#workdir-chart"), workdirs, {
    collapseAfter: wideLayout ? 11 : 6,
    collapseLabel: t("web.analytics.otherShare"),
    localeTokenCompact
  });

  const monthly = state.data?.workdirMonthly || [];
  const months = state.data?.monthlyComposition?.months || [];
  const compareEl = document.querySelector("#workdir-trend");
  const slopeMeta = document.querySelector("#workdir-slope-meta");
  if (!compareEl) return;
  // Compare the last two COMPLETE months: an in-progress month next to a full
  // one reads as a mass decline that is really just a partial month.
  const businessDay = state.data?.businessDay || "";
  const inProgressMonth = businessDay ? businessDay.slice(0, 7) : "";
  const completeMonths = months.filter((month) => month !== inProgressMonth);
  if (completeMonths.length < 2 || !monthly.length) {
    renderCompareBars(compareEl, [], {});
    if (slopeMeta) slopeMeta.textContent = t("web.analytics.noData");
    return;
  }
  const toMonth = completeMonths[completeMonths.length - 1];
  const fromMonth = completeMonths[completeMonths.length - 2];
  const fromIndex = months.indexOf(fromMonth);
  const toIndex = months.indexOf(toMonth);
  const label = (month) => month.slice(2).replace("-", "/");
  if (slopeMeta) slopeMeta.textContent = `${label(fromMonth)} → ${label(toMonth)}`;
  const rows = monthly
    .filter((row) => !row.other)
    .map((row) => ({
      name: row.name,
      from: row.series[fromIndex] || 0,
      to: row.series[toIndex] || 0
    }))
    .filter((row) => row.from > 0 || row.to > 0)
    .sort((a, b) => b.to - a.to)
    .slice(0, 8);
  renderCompareBars(compareEl, rows, {
    localeTokenCompact,
    prevLabel: label(fromMonth),
    currLabel: label(toMonth)
  });
}

// The workdir chart's row count tracks the 960px side-by-side/stacked
// breakpoint; re-render when the viewport crosses it.
if ("matchMedia" in window) {
  const wideQuery = window.matchMedia("(max-width: 960px)");
  const onLayoutFlip = () => renderWorkdirCards();
  if (wideQuery.addEventListener) wideQuery.addEventListener("change", onLayoutFlip);
  else if (wideQuery.addListener) wideQuery.addListener(onLayoutFlip);
}

function renderCompositionTrendCards() {
  const composition = state.data?.monthlyComposition;
  if (!composition) return;
  const months = composition.months || [];
  renderShareAreaStacked(document.querySelector("#model-trend"), months, composition.models || [], {
    tooltip: document.querySelector("#chart-tooltip"),
    localeTokenCompact
  });
  renderShareTrendLegend(document.querySelector("#model-trend-legend"), composition.models || []);
  const providerSeries = (composition.providers || []).map((row) => ({ ...row, name: sourceName(row.name) }));
  renderShareAreaStacked(document.querySelector("#provider-trend"), months, providerSeries, {
    tooltip: document.querySelector("#chart-tooltip"),
    localeTokenCompact
  });
  renderShareTrendLegend(document.querySelector("#provider-trend-legend"), providerSeries);
}

// ---- Client ecosystem cards (admin embed only) ----
// Mirrors admin.js device normalization; kept local because admin.js is not
// an importable module.

function ecoPlatformLabel(platform) {
  const raw = platform || "";
  const os = /^win/.test(raw) ? "Windows" : /^(darwin|macos)/.test(raw) ? "macOS" : /^linux/.test(raw) ? "Linux" : "";
  const arch = /aarch64|arm64/.test(raw) ? "arm64" : /x86_64|\bx64\b/.test(raw) ? "x64" : "";
  return [os, arch].filter(Boolean).join(" · ") || raw || "-";
}

function ecoStaleDays(lastSeenAt) {
  if (!lastSeenAt) return null;
  const days = Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / 86400000);
  return days > 14 ? days : null;
}

function renderEcoCountRows(container, rows, { unit }) {
  if (!container) return;
  const total = rows.reduce((sum, row) => sum + row.count, 0) || 1;
  container.innerHTML = rows.map((row) => {
    const pct = Math.round((row.count / total) * 100);
    return `<div class="usage-share-row" title="${escapeHtml(String(row.name))}: ${row.count}">
      <div class="lbl">
        <span class="usage-share-name" title="${escapeHtml(String(row.name))}">${escapeHtml(String(row.name))}</span>
        <span class="usage-share-value"><strong>${row.count} ${escapeHtml(unit)}</strong><span>${pct}%</span></span>
      </div>
      <div class="usage-share-track"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join("");
}

function compareVersions(a, b) {
  const parse = (v) => String(v || "0").split(".").map(Number);
  const [aParts, bParts] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const diff = (aParts[i] || 0) - (bParts[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

async function loadEcoSection() {
  const section = document.querySelector("#admin-eco-section");
  if (!section) return;
  const response = await fetch("/api/admin/devices");
  if (!response.ok) throw new Error("devices request failed");
  const devices = await response.json();

  const versionCounts = new Map();
  for (const device of devices) {
    const version = device.clientAppVersion || "-";
    versionCounts.set(version, (versionCounts.get(version) || 0) + 1);
  }
  const versionRows = [...versionCounts.entries()]
    .sort((a, b) => compareVersions(b[0], a[0]))
    .map(([name, count]) => ({ name, count }));
  renderEcoCountRows(document.querySelector("#eco-version-chart"), versionRows, { unit: t("web.analytics.ecoDeviceUnit") });
  // The fleet's newest observed client is the practical upgrade baseline:
  // shared/version.js is a Node module and cannot be imported in the browser.
  const latestVersion = versionRows[0]?.name || "";
  const outdated = latestVersion
    ? devices.filter((device) => device.clientAppVersion && compareVersions(device.clientAppVersion, latestVersion) < 0).length
    : 0;
  const versionMeta = document.querySelector("#eco-version-meta");
  if (versionMeta) versionMeta.textContent = t("web.analytics.ecoOutdated", { count: outdated, version: latestVersion });

  const platformCounts = new Map();
  for (const device of devices) {
    const label = ecoPlatformLabel(device.clientPlatform || device.os);
    platformCounts.set(label, (platformCounts.get(label) || 0) + 1);
  }
  const platformRows = [...platformCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
  renderEcoCountRows(document.querySelector("#eco-platform-chart"), platformRows, { unit: t("web.analytics.ecoDeviceUnit") });

  const stale = devices.filter((device) => ecoStaleDays(device.lastSeenAt)).length;
  const active = devices.length - stale;
  const split = document.querySelector("#eco-activity-split");
  if (split) {
    const activePct = devices.length ? Math.round((active / devices.length) * 100) : 0;
    split.innerHTML = `
      <div class="eco-activity-bar"><i class="eco-active" style="width:${activePct}%"></i><i class="eco-stale" style="width:${100 - activePct}%"></i></div>
      <div class="eco-activity-legend">
        <span><i class="eco-active"></i>${escapeHtml(t("web.analytics.ecoActiveDevices", { count: active }))}</span>
        <span><i class="eco-stale"></i>${escapeHtml(t("web.analytics.ecoStaleDevices", { count: stale }))}</span>
      </div>`;
  }
  const activityMeta = document.querySelector("#eco-activity-meta");
  if (activityMeta) activityMeta.textContent = t("web.analytics.ecoTotalDevices", { count: devices.length });

  section.hidden = false;
}

function renderKPIs() {
  const summary = state.data.summary || {};
  const totalTokens = Number(summary.totalTokens || 0);

  // 1. Total Tokens
  const totalTokensEl = document.querySelector("#kpi-total-tokens");
  if (totalTokensEl) totalTokensEl.textContent = localeTokenCompact(totalTokens);

  // 2. Active Contributors
  const activeCountEl = document.querySelector("#kpi-active-count");
  const activeSubEl = document.querySelector("#kpi-active-sub");
  const participants = state.data.participantRanking || [];
  const totalParticipants = state.data.participantCount || participants.length || 0;
  const activeDevs = participants.filter((p) => (p.totalTokens || 0) > 0).length || participants.length;
  if (activeCountEl) activeCountEl.textContent = String(activeDevs);
  if (activeSubEl) {
    activeSubEl.textContent = totalParticipants > 0
      ? t("web.analytics.activeOfTotal", { pct: Math.round((activeDevs / totalParticipants) * 100), count: totalParticipants })
      : t("web.analytics.activeCount", { count: activeDevs });
  }

  // 3. Cache savings & hit rate
  const cacheSavingsEl = document.querySelector("#kpi-cache-savings");
  if (cacheSavingsEl) cacheSavingsEl.textContent = formatCost(summary.cacheSavingsUsd);
  const hitRateEl = document.querySelector("#kpi-hit-rate");
  if (hitRateEl) hitRateEl.textContent = `${Math.round((summary.cacheHitRate || 0) * 100)}%`;

  // 4. Estimated cost & Unit cost & Savings rate
  const totalCostBeforeSavings = (summary.estimatedCostUsd || 0) + (summary.cacheSavingsUsd || 0);
  const savingsRate = totalCostBeforeSavings > 0 ? (summary.cacheSavingsUsd || 0) / totalCostBeforeSavings : 0;
  const savingsRateEl = document.querySelector("#kpi-savings-rate");
  if (savingsRateEl) savingsRateEl.textContent = t("web.analytics.savingsRateSub", { pct: Math.round(savingsRate * 100) });

  const unitCost = totalTokens > 0 ? (summary.estimatedCostUsd || 0) / (totalTokens / 100_000_000) : null;
  const unitCostEl = document.querySelector("#kpi-unit-cost");
  if (unitCostEl) unitCostEl.textContent = formatCost(unitCost);
  const estCostEl = document.querySelector("#kpi-estimated-cost");
  if (estCostEl) estCostEl.textContent = formatCost(summary.estimatedCostUsd);

  // 5. Leading Source / Top Provider
  const topProviderEl = document.querySelector("#kpi-top-provider");
  const topProviderSubEl = document.querySelector("#kpi-top-provider-sub");
  const topProvider = (state.data.providers || [])[0];
  if (topProviderEl) {
    topProviderEl.textContent = topProvider ? sourceName(topProvider.name) : "-";
  }
  if (topProviderSubEl) {
    const pct = topProvider ? Math.round((topProvider.ratio || 0) * 100) : 0;
    topProviderSubEl.textContent = topProvider ? t("web.analytics.sourceShare", { pct }) : "-";
  }

  // 6. Peak Burn Day in period
  const peakDayEl = document.querySelector("#kpi-peak-day");
  const peakDateEl = document.querySelector("#kpi-peak-day-date");
  const timeSeries = state.data.timeSeries || [];
  let maxDay = null;
  for (const item of timeSeries) {
    if (!maxDay || (item.totalTokens || 0) > (maxDay.totalTokens || 0)) {
      maxDay = item;
    }
  }
  if (peakDayEl) peakDayEl.textContent = maxDay ? localeTokenCompact(maxDay.totalTokens) : "-";
  if (peakDateEl) peakDateEl.textContent = maxDay ? (maxDay.day || maxDay.label || "-") : "-";
}

function renderHeatmap() {
  const series = state.data?.heatmap || [];
  const anchorDay = state.data?.businessDay || series[series.length - 1]?.day || "";
  renderActivityHeatmap(document.querySelector("#heatmap-grid"), series, {
    businessDay: anchorDay,
    to: anchorDay,
    tooltip: document.querySelector("#chart-tooltip"),
    localeTokenCompact,
    layout: "heatfull"
  });
  const metaEl = document.querySelector("#analytics-heatmap-meta");
  if (metaEl) {
    if (series.length) {
      const first = series[0].day;
      const last = series[series.length - 1].day;
      metaEl.textContent = `${t("web.analytics.heatmapSubtitle")} · ${first} → ${last}`;
      metaEl.removeAttribute("data-i18n");
    } else {
      metaEl.setAttribute("data-i18n", "web.analytics.heatmapSubtitle");
      metaEl.textContent = t("web.analytics.heatmapSubtitle");
    }
  }
}

async function init() {
  setLoading(true);
  try {
    await loadAnalytics();
  } finally {
    setLoading(false);
  }
}

initPublicNavProfile().catch(() => {});
init().catch(err => console.error("Init failed:", err));
