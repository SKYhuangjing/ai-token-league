// Self-contained HTML component generators extracted from renderer.js.
// Each accepts config/options as parameters instead of reading globals.

import { formatTokenCompact, formatTokenRaw, formatUsd } from "../shared/display.js";
import { dominantComposition, tokenCompositionSummary } from "../shared/composition.js";
import { COMPOSITION_PARTS, providerSourceColor } from "../shared/chart-helpers.js";
import {
  escapeHtml, renderCostAmountValue, renderCostValue, renderCost, renderCostAmount,
  costTitle, cacheTokens, sumKnownCosts, sortedBreakdown, formatTrendPeriod,
  normalizeMissingPriceModels, summaryLabel, summaryTitle,
  mergeCostQualityForDisplay, aggregateTrendRowCost, trendBucketKey
} from "./renderer-helpers.js";

// ── Token formatting (config-aware) ──

export function localeTokenCompact(value, lang) {
  return formatTokenCompact(value, lang);
}

export function formatToken(value, { lang = "en" } = {}) {
  return formatTokenCompact(value, lang);
}

// ── Composition ──

export function visibleCompositionFields(composition) {
  return [
    ["input", composition.inputTokens, "inputTokens"],
    ["output", composition.outputTokens, "outputTokens"],
    ["cache", cacheTokens(composition), "cacheTokens"]
  ];
}

export function visibleCompositionEntries(item, t = (k) => k) {
  const total = Number(item.totalTokens || 0);
  return visibleCompositionFields(item).map(([key, tokens, field]) => ({
    key,
    field,
    label: key === "cache" ? t("common.cache") : t(key === "input" ? "common.input" : "common.output"),
    tokens: Number(tokens || 0),
    ratio: total > 0 ? Number(tokens || 0) / total : 0
  }));
}

// ── Composition Tiles ──

export function renderCompositionTiles(item, opts = {}) {
  const { lang = "en", t = (k) => k } = opts;
  return visibleCompositionEntries(item, t)
    .map((entry) => `<article class="summary-tile composition-tile">
      <span>${escapeHtml(entry.label)}</span>
      <strong title="${formatTokenRaw(entry.tokens)}">${formatToken(entry.tokens, { lang })}</strong>
      <small>${Math.round(entry.ratio * 100)}%</small>
    </article>`)
    .join("");
}

// ── Mini Meters ──

export function renderMiniMeters(items, opts = {}) {
  const { showCost = false, limit = Infinity, colorClasses = [], lang = "en", showEstimatedCost = false, pricingSource = "", showPct = false, t = (k) => k } = opts;
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  // Percentage basis is the sum over ALL items (not the sliced view), so a
  // limited list still reports each item's share of the whole breakdown.
  const pctTotal = items.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);
  return items
    .slice(0, limit)
    .map((item, index) => {
      const pct = Math.max(3, (item.totalTokens / max) * 100);
      const name = escapeHtml(item.name);
      const val = formatToken(item.totalTokens, { lang });
      const share = showPct && pctTotal > 0 ? Math.round((item.totalTokens / pctTotal) * 100) : null;
      const cost = showCost ? renderCost(item) : "";
      const colorClass = colorClasses[index % colorClasses.length] || "";
      return `<div class="mini-meter-row">
        <span class="meter-name" title="${name}">${name}</span>
        <span class="meter-val-top" title="${formatTokenRaw(item.totalTokens)}">${val}${share !== null ? ` <em class="meter-pct">${share}%</em>` : ""}</span>
        <div class="mini-meter ${colorClass}"><i style="width:${pct}%; transition: width 0.3s ease;"></i></div>
        <span class="meter-cost" title="${cost ? escapeHtml(costTitle(item, { pricingSource, t })) : ""}">${cost ? renderCostAmount(item) : ""}</span>
      </div>`;
    })
    .join("");
}

// ── Detail Meters ──

export function renderDetailMeters(items = [], opts = {}) {
  const { lang = "en", showEstimatedCost = false, pricingSource = "", t = (k) => k } = opts;
  if (!items.length) return `<article class="empty-state">${t("desktop.renderer.noLocalUsageFound")}</article>`;
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  const colorClasses = ["", "meter-yellow", "meter-violet"];
  return `<div class="drawer-meter-list">${items
    .map((item, index) => {
      const pct = Math.max(3, (item.totalTokens / max) * 100);
      const name = escapeHtml(item.name);
      const cost = showEstimatedCost ? renderCost(item) : "";
      const colorClass = colorClasses[index % colorClasses.length] || "";
      return `<div class="mini-meter-row drawer-meter-row">
        <span title="${name}">${name}</span>
        <div class="mini-meter ${colorClass}"><i style="width:${pct}%; transition: width 0.3s ease;"></i></div>
        <span class="meter-value" title="${formatTokenRaw(item.totalTokens)}${cost ? ` · ${escapeHtml(costTitle(item, { pricingSource, t }))}` : ""}">
          <strong>${formatToken(item.totalTokens, { lang })}</strong>
          ${cost ? renderCostAmount(item) : ""}
        </span>
      </div>`;
    })
    .join("")}</div>`;
}

// ── Workdir Cards ──

export function renderWorkdirCards(items, opts = {}) {
  const { lang = "en", showEstimatedCost = false, pricingSource = "", t = (k) => k } = opts;
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  const colorClasses = ["", "meter-yellow", "meter-violet"];
  return items.map((item, index) => {
    const pct = Math.round(item.contributionRatio * 100);
    const badgeClass = pct > 50 ? "badge dark" : pct > 20 ? "badge" : "badge";
    const badgeText = pct > 50 ? t("desktop.workdirs.tierMain") : pct > 20 ? t("desktop.workdirs.tierMid") : t("desktop.workdirs.tierSmall");
    const costText = showEstimatedCost && item.estimatedCostUsd !== undefined ? ` · ${renderCostAmount(item)}` : "";
    const todayTokens = item.todayTokens || 0;
    const colorClass = colorClasses[index % colorClasses.length] || "";
    return `<article class="workdir-card" data-open-workdir="${escapeHtml(item.workdirHash)}" role="button" tabindex="0">
    <span class="workdir-rank">#${index + 1}</span>
    <div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;">
        <strong>${escapeHtml(item.name)}</strong>
        <span class="workdir-today">+${formatToken(todayTokens, { lang })} ${t("desktop.range.today").toLowerCase()}</span>
      </div>
      <span class="workdir-meta muted">${formatToken(item.totalTokens, { lang })} ${t("unit.tokens")}${costText} · ${pct}%</span>
      <div class="workdir-progress ${colorClass}"><i style="width:${Math.max(3, (item.totalTokens / max) * 100)}%; transition: width 0.3s ease;"></i></div>
    </div>
    <span class="${badgeClass}" style="align-self:flex-start;margin-top:4px;">${badgeText}</span>
  </article>`;
  }).join("");
}

// ── Spark Bar Value ──

export function renderSparkBarValue(row, opts = {}) {
  const { lang = "en", showEstimatedCost = false } = opts;
  return `<span class="spark-bar-value">
    <strong>${formatToken(row.totalTokens, { lang })}</strong>
    ${showEstimatedCost ? renderCostAmount(row) : ""}
  </span>`;
}

// ── Compact Breakdown ──

export function renderCompactBreakdown(items = [], opts = {}) {
  const { lang = "en" } = opts;
  if (!items.length) return "-";
  return items
    .slice(0, 3)
    .map((item) => `<div title="${formatTokenRaw(item.totalTokens)}">${escapeHtml(item.name)} ${formatToken(item.totalTokens, { lang })}</div>`)
    .join("");
}

// ── Source Switch Button ──

export function sourceSwitchButton(enabled, attributes, t = (k) => k) {
  const state = enabled ? "true" : "false";
  const title = enabled ? t("desktop.sources.disable") : t("desktop.sources.enable");
  return `<button class="source-switch ${enabled ? "is-on" : "is-off"}" type="button" ${attributes} role="switch" aria-checked="${state}" aria-pressed="${state}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"></button>`;
}

// ── Provider Overview (Sources screen data summary) ──

export function renderProviderOverview(overview, providerId, opts = {}) {
  const { capped = false, lang = "en", t = (k) => k } = opts;
  if (capped) {
    return `<section class="provider-overview provider-overview-flat">
      <p class="provider-overview-note">${escapeHtml(t("desktop.sources.overviewCapped"))}</p>
    </section>`;
  }
  if (!overview || !overview.hasData) {
    return `<section class="provider-overview provider-overview-flat">
      <p class="provider-overview-note">${escapeHtml(t("desktop.sources.overviewEmpty"))}</p>
    </section>`;
  }

  const total = Number(overview.totalTokens || 0);
  const parts = COMPOSITION_PARTS.map((part) => {
    const tokens = Number(overview.composition?.[part.key] || 0);
    const ratio = total > 0 ? tokens / total : 0;
    return { ...part, label: t(part.labelKey), tokens, ratio, pct: Math.round(ratio * 100) };
  });
  const barSegments = parts
    .map((part) => {
      const width = part.tokens > 0 ? Math.max(part.ratio * 100, 2) : 0;
      if (!width) return "";
      return `<i style="width:${width}%;background:${part.color}" title="${escapeHtml(`${part.label} ${formatTokenRaw(part.tokens)} (${part.pct}%)`)}"></i>`;
    })
    .join("");
  const legend = parts
    .map((part) => {
      const isZero = part.pct === 0;
      return `<span class="provider-overview-key${isZero ? " is-zero" : ""}" title="${escapeHtml(`${part.label}: ${formatTokenRaw(part.tokens)} (${part.pct}%)`)}"><i style="background:${part.color}"></i><span class="key-label">${escapeHtml(part.label)}</span> <b class="key-pct">${part.pct}%</b></span>`;
    })
    .join("");

  const brandColor = providerSourceColor(providerId);
  // Same meter rows as the homepage Top Models card (mini-meter-row), so the
  // Sources overview and the overview screen read as one component family.
  const modelRows = renderMiniMeters(
    (overview.models || []).map((model) => ({ name: model.model, totalTokens: model.totalTokens })),
    { limit: Infinity, colorClasses: ["meter-violet", "", "meter-yellow"], showPct: true, lang, t }
  );

  function stat(label, value, title = "") {
    return `<div class="provider-overview-stat">
      <span class="stat-label">${escapeHtml(label)}</span>
      <strong${title ? ` title="${escapeHtml(title)}"` : ""}>${value}</strong>
    </div>`;
  }

  return `<section class="provider-overview">
    <div class="provider-overview-title">
      <i class="provider-overview-dot" style="background:${brandColor}" aria-hidden="true"></i>
      <span>${escapeHtml(t("desktop.sources.overviewTitle"))}</span>
    </div>
    <div class="provider-overview-stats">
      ${stat(t("desktop.sources.overviewTotal"), formatToken(total, { lang }), formatTokenRaw(total))}
      ${stat(t("desktop.sources.overviewToday"), formatToken(overview.todayTokens, { lang }), formatTokenRaw(overview.todayTokens))}
      ${stat(t("desktop.sources.overviewWeek"), formatToken(overview.weekTokens, { lang }), formatTokenRaw(overview.weekTokens))}
      ${stat(t("desktop.sources.overviewActiveDays"), `${overview.activeDays} ${escapeHtml(t("desktop.sources.overviewDaysUnit"))}`)}
    </div>
    <div class="provider-overview-comp">
      <div class="provider-overview-bar" role="img" aria-label="${escapeHtml(t("desktop.sources.overviewTitle"))}">${barSegments}</div>
      <div class="provider-overview-legend">${legend}</div>
    </div>
    <div class="provider-overview-models">
      <div class="provider-overview-models-head">
        <span class="provider-overview-models-label">${escapeHtml(t("desktop.sources.overviewModels"))}</span>
        ${overview.lastUsedDay ? `<div class="provider-overview-last"><span class="last-label">${escapeHtml(t("desktop.sources.overviewLastUsed"))}</span> <span class="last-date">${escapeHtml(overview.lastUsedDay)}</span></div>` : ""}
      </div>
      <div class="stack provider-overview-model-list">${modelRows}</div>
    </div>
  </section>`;
}

export function updateSourceSwitchButton(button, enabled, t = (k) => k) {
  const state = enabled ? "true" : "false";
  const title = enabled ? t("desktop.sources.disable") : t("desktop.sources.enable");
  button.setAttribute("aria-checked", state);
  button.setAttribute("aria-pressed", state);
  button.title = title;
  button.setAttribute("aria-label", title);
  button.classList.toggle("is-on", enabled);
  button.classList.toggle("is-off", !enabled);
}

// ── Trend Dashboard ──

export function renderTrendDashboard(rows, opts = {}) {
  const { lang = "en", showEstimatedCost = false, pricingSource = "", t = (k) => k } = opts;
  const chronological = [...rows].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const latest = rows[0];
  const peak = rows.reduce((current, row) => (row.totalTokens > current.totalTokens ? row : current), rows[0]);
  const total = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  const cost = aggregateTrendRowCost(rows);
  const recent = rows.slice(0, 5);

  function metricTitle(row) {
    const costText = showEstimatedCost ? ` · ${t("common.cost")} ${renderCost(row)}` : "";
    return `${formatTrendPeriod(row)} · ${formatToken(row.totalTokens, { lang })}${costText}`;
  }

  function renderMetric(label, value, note, title = "") {
    return `<article class="trend-metric"${title ? ` title="${escapeHtml(title)}"` : ""}>
      <span>${escapeHtml(label)}</span>
      <strong>${value}</strong>
      <small>${escapeHtml(note)}</small>
    </article>`;
  }

  return `<div class="trend-dashboard">
    <div class="trend-summary-grid">
      ${renderMetric(t("desktop.renderer.latestLabel"), formatToken(latest.totalTokens, { lang }), formatTrendPeriod(latest), metricTitle(latest))}
      ${renderMetric(t("desktop.renderer.peak"), formatToken(peak.totalTokens, { lang }), formatTrendPeriod(peak), metricTitle(peak))}
      ${renderMetric(t("desktop.renderer.viewTotal"), formatToken(total, { lang }), `${rows.length} ${t("desktop.renderer.dayBucket")}${rows.length === 1 ? "" : "s"}`, formatTokenRaw(total))}
      ${showEstimatedCost
        ? renderMetric(t("desktop.renderer.cost"), renderCostAmount(cost), pricingSource, costTitle(cost, { pricingSource, t }))
        : renderMetric(t("desktop.renderer.dominant"), dominantComposition(latest) || "-", tokenCompositionSummary(latest), metricTitle(latest))}
    </div>
    ${renderTrendTimeline(chronological, latest, peak, { lang, showEstimatedCost, pricingSource, t })}
    <section class="recent-contribution">
      <h3>${t("desktop.renderer.recentContribution")}</h3>
      <div class="recent-list">
        ${recent
          .map((row) => `<article>
            <header>
              <strong>${formatTrendPeriod(row)}</strong>
              <span title="${escapeHtml(metricTitle(row))}">${formatToken(row.totalTokens, { lang })}</span>
            </header>
            <p title="${escapeHtml(summaryTitle(row.modelBreakdown))}">${escapeHtml(summaryLabel(row.modelBreakdown))}</p>
            <p title="${escapeHtml(summaryTitle(row.workdirBreakdown))}">${escapeHtml(summaryLabel(row.workdirBreakdown))}</p>
            ${showEstimatedCost ? `<em title="${escapeHtml(costTitle(row, { pricingSource, t }))}">${renderCostAmount(row)}</em>` : ""}
          </article>`)
          .join("")}
      </div>
    </section>
  </div>`;
}

function renderTrendTimeline(rows, latest, peak, opts = {}) {
  const { lang = "en", showEstimatedCost = false, pricingSource = "", t = (k) => k } = opts;
  const max = Math.max(...rows.map((item) => item.totalTokens), 1);

  function metricTitle(row) {
    const costText = showEstimatedCost ? ` · ${t("common.cost")} ${renderCost(row)}` : "";
    return `${formatTrendPeriod(row)} · ${formatToken(row.totalTokens, { lang })}${costText}`;
  }

  return `<div class="trend-timeline">
    ${rows
        .map((row) => {
          const title = escapeHtml(metricTitle(row));
          return `<button type="button" data-select-trend="${escapeHtml(trendBucketKey(row))}" class="${row === latest ? "latest" : ""} ${row === peak ? "peak" : ""}" style="height:${Math.max(4, (row.totalTokens / max) * 100)}%" data-tooltip="${title}"></button>`;
        })
      .join("")}
  </div>`;
}

// ── Trend Selection ──

export function renderTrendSelection(row, opts = {}) {
  if (!row) return "";
  const { lang = "en", showEstimatedCost = false, pricingSource = "", t = (k) => k } = opts;
  return `<section class="section-block">
    ${renderTrendDetailHero(row, { lang, showEstimatedCost, pricingSource, t })}
    <div class="detail-summary composition-grid">
      ${renderCompositionTiles(row, { lang, t })}
    </div>
    <div class="detail-meter-sections">
      <section class="visual-card drawer-meter-card">
        <h3>${t("desktop.renderer.topModels")}</h3>
        ${renderDetailMeters(row.modelBreakdown, { lang, showEstimatedCost, pricingSource, t })}
      </section>
      <section class="visual-card drawer-meter-card">
        <h3>${t("desktop.renderer.topWorkdirs")}</h3>
        ${renderDetailMeters(row.workdirBreakdown, { lang, showEstimatedCost, pricingSource, t })}
      </section>
    </div>
    ${renderTrendDetailBreakdown(row, { lang, showEstimatedCost, pricingSource, t })}
  </section>`;
}

export function renderTrendDetailHero(row, opts = {}) {
  const { lang = "en", showEstimatedCost = false, pricingSource = "", t = (k) => k } = opts;
  const cost = showEstimatedCost ? renderCost(row).replace(/<[^>]+>/g, "") : "";
  return `<article class="drawer-score-card"${showEstimatedCost ? ` title="${escapeHtml(costTitle(row, { pricingSource, t }))}"` : ""}>
    <span class="metric-label">${escapeHtml(t("desktop.overview.totalTokens"))}</span>
    <strong title="${formatTokenRaw(row.totalTokens)}">${formatToken(row.totalTokens, { lang })}</strong>
    ${cost ? `<small>${renderCostAmount(row)}</small>` : ""}
  </article>`;
}

export function renderTrendDetailBreakdown(row, opts = {}) {
  const { lang = "en", t = (k) => k } = opts;
  const details = (row.detailBreakdown || []).filter((r) => Number(r?.totalTokens || 0) > 0);
  if (!details.length) return "";
  const max = Math.max(...details.map((item) => item.totalTokens), 1);
  return `<section class="visual-card drawer-meter-card">
    <h3>${escapeHtml(row.detailBreakdownTitle || "")}</h3>
    <div class="hour-detail-grid">
      ${details.map((item) => {
        const pct = Math.max(3, (item.totalTokens / max) * 100);
        const label = item.bucketLabel || formatTrendPeriod(item);
        return `<div class="hour-detail-item">
          <span class="hour-detail-label">${escapeHtml(label)}</span>
          <div class="mini-meter"><i style="width:${pct}%; transition: width 0.3s ease;"></i></div>
          <span class="hour-detail-value">${formatToken(item.totalTokens, { lang })}</span>
        </div>`;
      }).join("")}
    </div>
  </section>`;
}
