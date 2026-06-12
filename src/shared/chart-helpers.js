import { t } from "./i18n.js";
import { formatTokenCompact } from "./display.js";

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

export function renderTrendChart(svg, series, grain, tooltip, localeTokenCompact) {
  svg.innerHTML = "";
  if (!series.length) {
    svg.innerHTML = `<text x="400" y="100" class="chart-axis-text" font-size="14" text-anchor="middle">${t("web.analytics.noData") || "No usage data"}</text>`;
    return;
  }

  const width = 800;
  const height = 200;
  const padding = { left: 60, right: 20, top: 20, bottom: 30 };
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
    const label = grain === "hour" ? (series[i].label || `${String(series[i].hour ?? i).padStart(2, "0")}:00`) : series[i].day;
    points.push({ x, y, day: series[i].day, label, tokens: series[i].totalTokens });
  }

  if (points.length > 0) {
    const areaPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    let areaD = `M ${points[0].x} ${height - padding.bottom} `;
    for (const pt of points) areaD += `L ${pt.x} ${pt.y} `;
    areaD += `L ${points[points.length - 1].x} ${height - padding.bottom} Z`;
    areaPath.setAttribute("d", areaD);
    areaPath.setAttribute("class", "chart-area");
    svg.appendChild(areaPath);

    const linePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    let lineD = `M ${points[0].x} ${points[0].y} `;
    for (let i = 1; i < points.length; i++) lineD += `L ${points[i].x} ${points[i].y} `;
    linePath.setAttribute("d", lineD);
    linePath.setAttribute("class", "chart-line");
    svg.appendChild(linePath);
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
      } else {
        const parts = pt.day.split("-");
        text.textContent = parts.length >= 3 ? `${parts[1]}-${parts[2]}` : pt.day;
      }
      svg.appendChild(text);
    }
  }

  for (const pt of points) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", pt.x);
    circle.setAttribute("cy", pt.y);
    circle.setAttribute("r", grain === "hour" ? "3" : "4.5");
    circle.setAttribute("class", "chart-dot");
    circle.addEventListener("mouseenter", () => {
      const header = grain === "hour" ? `${pt.day} ${pt.label}` : pt.day;
      tooltip.innerHTML = `<strong>${header}</strong><br>${localeTokenCompact(pt.tokens)} ${t("unit.tokens") || "tokens"}`;
      tooltip.style.opacity = "1";
      positionTooltip(tooltip, circle);
    });
    circle.addEventListener("mouseleave", () => { tooltip.style.opacity = "0"; });
    svg.appendChild(circle);
  }
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
