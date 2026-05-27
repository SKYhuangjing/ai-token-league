import { initI18n, t, getCurrentLang, createLangSwitcher, bindLangSwitcher, updatePageTranslations } from "/shared/i18n.js";
import { formatTokenCompact } from "/shared/display.js";
import { escapeHtml, sourceName, formatCost, renderTrendChart as sharedRenderTrendChart, renderGauge as sharedRenderGauge, renderBarChart as sharedRenderBarChart } from "/shared/chart-helpers.js";

const isEmbedded = window.self !== window.top;
if (isEmbedded) {
  document.addEventListener("DOMContentLoaded", () => {
    document.body.classList.add("is-embedded");
    const masthead = document.querySelector(".masthead");
    if (masthead) masthead.style.display = "none";
  });

  function notifyHeight() {
    const height = document.documentElement.scrollHeight;
    window.parent.postMessage({ type: "analytics-resize", height }, "*");
  }

  const resizeObserver = new ResizeObserver(() => notifyHeight());
  window.addEventListener("load", () => {
    notifyHeight();
    resizeObserver.observe(document.body);
  });
}

// Initialize Multi-Language System
const currentLang = initI18n();

const state = {
  period: "this_month",
  participantId: "",
  data: null,
  loading: false
};

const loadingEl = document.querySelector("#analytics-loading");

function setLoading(on) {
  state.loading = on;
  loadingEl.hidden = !on;
  document.querySelectorAll("[data-filter='period'] button").forEach(btn => {
    btn.disabled = on;
    btn.style.pointerEvents = on ? "none" : "";
  });
  const sel = document.querySelector("#participant-select");
  if (sel) sel.disabled = on;
}

// Bind Language Switcher
const langContainer = document.querySelector("#lang-switcher-container");
if (langContainer) {
  langContainer.innerHTML = createLangSwitcher();
  bindLangSwitcher("lang-switcher", () => {
    window.location.reload();
  });
}
updatePageTranslations();

// Format helper functions
function localeTokenCompact(value) {
  return formatTokenCompact(value, getCurrentLang());
}

// Initial hydration and trigger bindings
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

  setLoading(true);
  try {
    await loadAnalytics();
  } finally {
    setLoading(false);
  }
});

// Load Active Participants into Select Box Dropdown
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
}

// Load Core Data and Render Panels
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
    dateRangeEl.textContent = `(${state.data.from} ~ ${state.data.to})`;
  }
  
  renderKPIs();
  renderGauge();
  renderHeatmap();
  renderTrendChart();
  renderBarCharts();
}

function renderGauge() {
  const summary = state.data.summary || {};
  sharedRenderGauge(
    document.querySelector("#gauge-fill"),
    document.querySelector("#gauge-val"),
    summary.cacheHitRate || 0
  );
}

function renderTrendChart() {
  const svg = document.querySelector("#trend-chart");
  if (!svg) return;
  const tooltip = document.querySelector("#chart-tooltip");
  sharedRenderTrendChart(svg, state.data.timeSeries || [], state.data.timeGrain || "day", tooltip, localeTokenCompact);
}

function renderBarCharts() {
  sharedRenderBarChart(document.querySelector("#model-chart"), state.data.models, { collapseAfter: 4, localeTokenCompact });
  sharedRenderBarChart(document.querySelector("#provider-chart"), state.data.providers.map(p => ({ ...p, name: sourceName(p.name) })), { localeTokenCompact });
}

// 1. Render KPI Stats Panel
function renderKPIs() {
  const summary = state.data.summary || {};
  document.querySelector("#kpi-total-tokens").textContent = localeTokenCompact(summary.totalTokens);
  document.querySelector("#kpi-cache-savings").textContent = formatCost(summary.cacheSavingsUsd);
  
  const totalCostBeforeSavings = (summary.estimatedCostUsd || 0) + (summary.cacheSavingsUsd || 0);
  const savingsRate = totalCostBeforeSavings > 0 ? (summary.cacheSavingsUsd || 0) / totalCostBeforeSavings : 0;
  document.querySelector("#kpi-savings-rate").textContent = `${Math.round(savingsRate * 100)}%`;
  
  document.querySelector("#kpi-estimated-cost").textContent = formatCost(summary.estimatedCostUsd);
}

// 3. Render GitHub-style Coding heatmap grid
function renderHeatmap() {
  const grid = document.querySelector("#heatmap-grid");
  grid.innerHTML = "";
  
  const totalsByDay = {};
  for (const pt of state.data.heatmap || []) {
    totalsByDay[pt.day] = pt.totalTokens || 0;
  }
  
  const maxVal = Math.max(...Object.values(totalsByDay), 0);
  
  const businessDay = state.data.to || new Date().toISOString().split("T")[0];
  const businessDate = new Date(businessDay + "T00:00:00Z");
  
  const currentDayOfWeek = businessDate.getUTCDay();
  const startOfWeek = new Date(businessDate);
  startOfWeek.setUTCDate(businessDate.getUTCDate() - currentDayOfWeek);
  
  const startDate = new Date(startOfWeek);
  startDate.setUTCDate(startOfWeek.getUTCDate() - 12 * 7);
  
  const totalDays = 13 * 7;
  const cells = [];
  const tooltip = document.querySelector("#chart-tooltip");
  
  for (let i = 0; i < totalDays; i++) {
    const cellDate = new Date(startDate);
    cellDate.setUTCDate(startDate.getUTCDate() + i);
    
    const dayStr = cellDate.toISOString().split("T")[0];
    const tokens = totalsByDay[dayStr] || 0;
    
    let level = 0;
    if (tokens > 0 && maxVal > 0) {
      const ratio = tokens / maxVal;
      if (ratio > 0.75) level = 4;
      else if (ratio > 0.50) level = 3;
      else if (ratio > 0.25) level = 2;
      else level = 1;
    }
    
    const cell = document.createElement("i");
    cell.className = `heatmap-cell level-${level}`;
    if (state.data.from && state.data.to) {
      const inPeriod = dayStr >= state.data.from && dayStr <= state.data.to;
      if (!inPeriod) {
        cell.classList.add("out-of-period");
      }
    }
    cell.dataset.date = dayStr;
    cell.dataset.tokens = tokens;
    
    cell.addEventListener("mouseenter", (e) => {
      const d = e.target.dataset.date;
      const tok = Number(e.target.dataset.tokens);
      tooltip.innerHTML = `<strong>${d}</strong><br>${localeTokenCompact(tok)} ${t("unit.tokens") || "tokens"}`;
      tooltip.style.opacity = "1";
      
      const rect = cell.getBoundingClientRect();
      tooltip.style.left = `${rect.left + window.scrollX - tooltip.offsetWidth / 2 + rect.width / 2}px`;
      tooltip.style.top = `${rect.top + window.scrollY - tooltip.offsetHeight - 8}px`;
    });
    
    cell.addEventListener("mouseleave", () => {
      tooltip.style.opacity = "0";
    });
    
    cells.push(cell);
  }
  
  // Chronological Column-First layout filled automatically by CSS Grid `grid-auto-flow: column`
  for (const cell of cells) {
    grid.appendChild(cell);
  }
}

// Boot up sequence
async function init() {
  await loadParticipantDropdown();
  await loadAnalytics();
}

init().catch(err => console.error("Init failed:", err));
