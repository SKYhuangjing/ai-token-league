import { initI18n, t, getCurrentLang, createLangSwitcher, bindLangSwitcher, updatePageTranslations } from "/shared/i18n.js";
import { formatTokenCompact } from "/shared/display.js";

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

function formatCost(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  const n = Number(value);
  if (n > 0 && n < 0.01) return t("common.lessThanCost") || "<$0.01";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
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
  renderBarChart("#model-chart", state.data.models);
  renderBarChart("#provider-chart", state.data.providers.map(p => ({ ...p, name: sourceName(p.name) })));
}

function sourceName(providerId) {
  if (providerId === "codex_local") return t("source.codex") || "Codex";
  if (providerId === "claude_code_local") return t("source.claude") || "Claude Code";
  if (providerId === "cursor_dashboard_usage") return t("source.cursor") || "Cursor";
  return providerId;
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

// 2. Render Prompt Cache Speedometer Gauge SVG
function renderGauge() {
  const summary = state.data.summary || {};
  const fill = document.querySelector("#gauge-fill");
  const valEl = document.querySelector("#gauge-val");
  
  const hitRate = summary.cacheHitRate || 0;
  const pct = Math.round(hitRate * 100);
  
  // Circumference of 180deg arc with radius 80 is 251.2
  const strokeDash = `${Math.round(hitRate * 251.2)} 251.2`;
  fill.setAttribute("stroke-dasharray", strokeDash);
  valEl.textContent = `${pct}%`;
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

// 4. Render Dynamic SVG Trend Line Chart
function renderTrendChart() {
  const svg = document.querySelector("#trend-chart");
  svg.innerHTML = "";

  const series = state.data.timeSeries || [];
  const grain = state.data.timeGrain || "day";
  if (!series.length) {
    svg.innerHTML = `<text x="400" y="100" class="chart-axis-text" font-size="14" text-anchor="middle">${t("web.analytics.noData") || "No usage data"}</text>`;
    return;
  }

  const width = 800;
  const height = 200;
  const padding = { left: 60, right: 20, top: 20, bottom: 30 };

  const maxVal = Math.max(...series.map(pt => pt.totalTokens), 1);
  const N = series.length;

  // Draw Grid lines
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

  // Coordinates compiler
  const points = [];
  for (let i = 0; i < N; i++) {
    const x = padding.left + (N > 1 ? (i / (N - 1)) * (width - padding.left - padding.right) : (width - padding.left - padding.right) / 2);
    const y = height - padding.bottom - (series[i].totalTokens / maxVal) * (height - padding.top - padding.bottom);
    const label = grain === "hour" ? (series[i].label || `${String(series[i].hour ?? i).padStart(2, "0")}:00`) : series[i].day;
    points.push({ x, y, day: series[i].day, label, tokens: series[i].totalTokens });
  }

  // Render Area path
  if (points.length > 0) {
    const areaPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    let areaD = `M ${points[0].x} ${height - padding.bottom} `;
    for (const pt of points) {
      areaD += `L ${pt.x} ${pt.y} `;
    }
    areaD += `L ${points[points.length - 1].x} ${height - padding.bottom} Z`;
    areaPath.setAttribute("d", areaD);
    areaPath.setAttribute("class", "chart-area");
    svg.appendChild(areaPath);

    // Render Stroke line
    const linePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    let lineD = `M ${points[0].x} ${points[0].y} `;
    for (let i = 1; i < points.length; i++) {
      lineD += `L ${points[i].x} ${points[i].y} `;
    }
    linePath.setAttribute("d", lineD);
    linePath.setAttribute("class", "chart-line");
    svg.appendChild(linePath);
  }

  // Render X Axis labels
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
      } else {
        const parts = pt.day.split("-");
        text.textContent = parts.length >= 3 ? `${parts[1]}-${parts[2]}` : pt.day;
      }
      svg.appendChild(text);
    }
  }

  // Render Interactive Dots
  const tooltip = document.querySelector("#chart-tooltip");
  for (const pt of points) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", pt.x);
    circle.setAttribute("cy", pt.y);
    circle.setAttribute("r", grain === "hour" ? "3" : "4.5");
    circle.setAttribute("class", "chart-dot");

    circle.addEventListener("mouseenter", (e) => {
      const header = grain === "hour" ? `${pt.day} ${pt.label}` : pt.day;
      tooltip.innerHTML = `<strong>${header}</strong><br>${localeTokenCompact(pt.tokens)} ${t("unit.tokens") || "tokens"}`;
      tooltip.style.opacity = "1";

      const rect = circle.getBoundingClientRect();
      tooltip.style.left = `${rect.left + window.scrollX - tooltip.offsetWidth / 2 + rect.width / 2}px`;
      tooltip.style.top = `${rect.top + window.scrollY - tooltip.offsetHeight - 8}px`;
    });

    circle.addEventListener("mouseleave", () => {
      tooltip.style.opacity = "0";
    });

    svg.appendChild(circle);
  }
}

// 5. Render model/provider stacked bars
function renderBarChart(containerId, items = []) {
  const container = document.querySelector(containerId);
  container.innerHTML = "";
  
  if (!items.length) {
    container.innerHTML = `<div class="dl-placeholder" style="text-align: center; padding: 30px 0;">${t("web.analytics.noData") || "No usage data found"}</div>`;
    return;
  }
  
  let displayItems = items;
  if (containerId === "#model-chart" && items.length > 4) {
    const topItems = items.slice(0, 3);
    const otherItems = items.slice(3);
    const otherTokens = otherItems.reduce((sum, item) => sum + item.tokens, 0);
    const otherRatio = otherItems.reduce((sum, item) => sum + item.ratio, 0);
    displayItems = [
      ...topItems,
      {
        name: t("web.analytics.otherModels") || "Other Models",
        tokens: otherTokens,
        ratio: otherRatio
      }
    ];
  }
  
  const maxVal = Math.max(...displayItems.map(item => item.tokens), 1);
  
  for (const item of displayItems) {
    const pct = Math.max(2, (item.tokens / maxVal) * 100);
    const ratioPct = Math.round(item.ratio * 100);
    
    const row = document.createElement("div");
    row.className = "bar-chart-row";
    
    row.innerHTML = `
      <div class="bar-chart-info">
        <span>${escapeHtml(item.name)}</span>
        <strong>${localeTokenCompact(item.tokens)} (${ratioPct}%)</strong>
      </div>
      <div class="bar-chart-track">
        <div class="bar-chart-fill" style="width: ${pct}%"></div>
      </div>
    `;
    container.appendChild(row);
  }
}

// Boot up sequence
async function init() {
  await loadParticipantDropdown();
  await loadAnalytics();
}

init().catch(err => console.error("Init failed:", err));
