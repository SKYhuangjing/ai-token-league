import { initI18n, t, getCurrentLang, createLangSwitcher, bindLangSwitcher, updatePageTranslations } from "/shared/i18n.js";
import { formatTokenCompact } from "/shared/display.js";
import {
  escapeHtml, sourceName, formatCost, renderTrendChart as sharedRenderTrendChart,
  renderGauge as sharedRenderGauge, renderBarChart as sharedRenderBarChart,
  renderParticipantTreemap as sharedRenderParticipantTreemap,
  renderAnalyticsInsights, renderTokenComposition, renderParetoChart, renderWeekdayRhythm,
  renderActivityHeatmap, aggregateTimeSeriesByWeek
} from "/shared/chart-helpers.js";

const isEmbedded = window.self !== window.top;
if (isEmbedded) {
  document.addEventListener("DOMContentLoaded", () => {
    document.body.classList.add("is-embedded");
  });

  function notifyHeight() {
    const bodyHeight = document.body ? document.body.scrollHeight : 0;
    const height = Math.ceil(Math.max(document.documentElement.scrollHeight, bodyHeight));
    window.parent.postMessage({ type: "analytics-resize", height }, window.location.origin);
  }

  const resizeObserver = new ResizeObserver(() => notifyHeight());
  window.addEventListener("load", () => {
    notifyHeight();
    resizeObserver.observe(document.body);
  });
}

initI18n();

const state = {
  period: "this_month",
  participantId: "",
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
  const sel = document.querySelector("#participant-select");
  if (sel) sel.disabled = on;
  const trigger = document.querySelector("#participant-select-trigger");
  if (trigger) trigger.disabled = on;
  if (on) setParticipantSelectOpen(false);
  if (!on && shell) {
    if (analyticsSettleTimer) window.clearTimeout(analyticsSettleTimer);
    shell.classList.remove("is-settled");
    requestAnimationFrame(() => shell.classList.add("is-settled"));
    analyticsSettleTimer = window.setTimeout(() => {
      shell.classList.remove("is-settled");
      analyticsSettleTimer = null;
    }, 620);
  }
}

const langContainer = document.querySelector("#lang-switcher-container");
if (langContainer) {
  langContainer.innerHTML = createLangSwitcher();
  bindLangSwitcher("lang-switcher", () => {
    window.location.reload();
  });
}
updatePageTranslations();

function localeTokenCompact(value) {
  return formatTokenCompact(value, getCurrentLang());
}

function applyBoardIdentityEyebrow(mode) {
  const eyebrowKey = {
    anonymous: "web.publicBoardAnonymous",
    public: "web.publicBoardPublic",
    authenticated: "web.publicBoardAuthenticated"
  }[mode] || "web.publicBoard";
  const eyebrow = document.querySelector("#board-identity-eyebrow");
  if (!eyebrow) return;
  eyebrow.setAttribute("data-i18n", eyebrowKey);
  eyebrow.textContent = t(eyebrowKey);
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
      await loadParticipantDropdown();
      await loadAnalytics();
    } finally {
      setLoading(false);
    }
  });
});

document.querySelector("#participant-select").addEventListener("change", async (event) => {
  if (state.loading) return;
  state.participantId = event.target.value;
  syncParticipantSelectUi();

  setLoading(true);
  try {
    await loadAnalytics();
  } finally {
    setLoading(false);
  }
});

function syncParticipantSelectUi() {
  const select = document.querySelector("#participant-select");
  const trigger = document.querySelector("#participant-select-trigger");
  const menu = document.querySelector("#participant-select-menu");
  const valueEl = trigger?.querySelector(".atl-select-value");
  if (!select || !trigger || !menu || !valueEl) return;

  const selected = select.options[select.selectedIndex] || select.options[0];
  valueEl.textContent = selected?.textContent || "";
  valueEl.removeAttribute("data-i18n");

  menu.innerHTML = [...select.options].map((opt) => {
    const selectedClass = opt.value === select.value ? " is-selected" : "";
    return `<li class="atl-select-option${selectedClass}" role="option" data-value="${escapeHtml(opt.value)}" aria-selected="${opt.value === select.value ? "true" : "false"}">${escapeHtml(opt.textContent)}</li>`;
  }).join("");
}

function setParticipantSelectOpen(open) {
  const wrap = document.querySelector("[data-atl-select]");
  const trigger = document.querySelector("#participant-select-trigger");
  const menu = document.querySelector("#participant-select-menu");
  if (!wrap || !trigger || !menu) return;
  wrap.classList.toggle("is-open", open);
  trigger.setAttribute("aria-expanded", open ? "true" : "false");
  menu.hidden = !open;
}

function initParticipantSelectUi() {
  const wrap = document.querySelector("[data-atl-select]");
  const select = document.querySelector("#participant-select");
  const trigger = document.querySelector("#participant-select-trigger");
  const menu = document.querySelector("#participant-select-menu");
  if (!wrap || !select || !trigger || !menu) return;

  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    if (state.loading || trigger.disabled) return;
    setParticipantSelectOpen(menu.hidden);
  });

  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-value]");
    if (!option) return;
    const nextValue = option.getAttribute("data-value") || "";
    if (select.value !== nextValue) {
      select.value = nextValue;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      syncParticipantSelectUi();
    }
    setParticipantSelectOpen(false);
  });

  document.addEventListener("click", (event) => {
    if (!wrap.contains(event.target)) setParticipantSelectOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setParticipantSelectOpen(false);
  });

  syncParticipantSelectUi();
}

initParticipantSelectUi();

async function loadParticipantDropdown() {
  const select = document.querySelector("#participant-select");

  const prevVal = select.value;
  select.innerHTML = `<option value="" data-i18n="web.analytics.allCommunity">${t("web.analytics.allCommunity") || "All Community (Combined)"}</option>`;

  let items = [];
  if (isEmbedded) {
    const response = await fetch(`/api/admin/usage?range=month`);
    if (response.ok) {
      const data = await response.json();
      items = (data.participants || []).map(p => ({
        displayId: p.participantId,
        displayName: p.nickname
      }));
    }
  } else {
    const response = await fetch(`/api/board/leaderboard?period=${state.period}`);
    if (response.ok) {
      const data = await response.json();
      if (data.identityMode) applyBoardIdentityEyebrow(data.identityMode);
      items = (data.items || []).map(item => ({
        displayId: item.displayId,
        displayName: item.displayName
      }));
    }
  }

  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.displayId;
    option.textContent = item.displayName;
    select.appendChild(option);
  }

  if ([...select.options].some(opt => opt.value === prevVal)) {
    select.value = prevVal;
    state.participantId = prevVal;
  } else {
    select.value = "";
    state.participantId = "";
  }
  syncParticipantSelectUi();
  setParticipantSelectOpen(false);
}

async function loadAnalytics() {
  const params = new URLSearchParams({
    period: state.period,
    participantId: state.participantId
  });

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

  const trendMeta = document.querySelector("#trend-meta");
  if (trendMeta) {
    const periodLabels = {
      today: "web.period.today",
      yesterday: "web.period.yesterday",
      this_week: "web.period.thisWeek",
      last_week: "web.period.lastWeek",
      this_month: "web.period.thisMonth",
      last_month: "web.period.lastMonth",
      all: "web.period.all"
    };
    trendMeta.textContent = t(periodLabels[state.period] || "web.analytics.burnTrend");
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
  sharedRenderTrendChart(svg, series, grain, tooltip, localeTokenCompact, {
    showActiveSeries: true
  });
}

function renderBarCharts() {
  sharedRenderBarChart(document.querySelector("#model-chart"), state.data.models, { collapseAfter: 4, localeTokenCompact });
  sharedRenderBarChart(document.querySelector("#provider-chart"), state.data.providers.map(p => ({ ...p, name: sourceName(p.name) })), { localeTokenCompact });
}

function renderParticipantTreemapPanel() {
  const card = document.querySelector("#participant-ranking-card");
  const svg = document.querySelector("#participant-treemap-svg");
  const labels = document.querySelector("#participant-treemap-labels");
  if (!card || !svg || !labels) return;

  const isCommunityScope = !state.participantId;
  card.hidden = !isCommunityScope;
  sharedRenderParticipantTreemap(
    svg,
    labels,
    isCommunityScope ? state.data?.participantRanking || [] : [],
    {
      localeTokenCompact,
      tooltip: document.querySelector("#chart-tooltip"),
      sideContainer: document.querySelector("#treemap-side"),
      legendContainer: document.querySelector("#treemap-legend")
    }
  );
}

function renderKPIs() {
  const summary = state.data.summary || {};
  document.querySelector("#kpi-total-tokens").textContent = localeTokenCompact(summary.totalTokens);
  document.querySelector("#kpi-cache-savings").textContent = formatCost(summary.cacheSavingsUsd);

  const totalCostBeforeSavings = (summary.estimatedCostUsd || 0) + (summary.cacheSavingsUsd || 0);
  const savingsRate = totalCostBeforeSavings > 0 ? (summary.cacheSavingsUsd || 0) / totalCostBeforeSavings : 0;
  document.querySelector("#kpi-savings-rate").textContent = `${t("web.analytics.savingsRate")}: ${Math.round(savingsRate * 100)}%`;

  const totalTokens = Number(summary.totalTokens || 0);
  const unitCost = totalTokens > 0 ? (summary.estimatedCostUsd || 0) / (totalTokens / 100_000_000) : null;
  document.querySelector("#kpi-unit-cost").textContent = formatCost(unitCost);
  document.querySelector("#kpi-estimated-cost").textContent = formatCost(summary.estimatedCostUsd);
}

function renderHeatmap() {
  renderActivityHeatmap(document.querySelector("#heatmap-grid"), state.data?.heatmap || [], {
    from: state.data?.from,
    to: state.data?.to,
    businessDay: state.data?.businessDay,
    tooltip: document.querySelector("#chart-tooltip"),
    localeTokenCompact,
    layout: "heat90"
  });
}

async function init() {
  setLoading(true);
  try {
    await loadParticipantDropdown();
    await loadAnalytics();
  } finally {
    setLoading(false);
  }
}

init().catch(err => console.error("Init failed:", err));
