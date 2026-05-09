import { dominantComposition, tokenCompositionDetails } from "/shared/composition.js";
import { initI18n, t, getCurrentLang, createLangSwitcher, bindLangSwitcher, updatePageTranslations } from "/shared/i18n.js";
import { formatTokenCompact } from "/shared/display.js";

function localeTokenCompact(value) {
  return formatTokenCompact(value, getCurrentLang());
}

// 初始化多语言
const currentLang = initI18n();

const state = {
  period: "today",
  identityMode: "public",
  detailParticipantId: "",
  detailTab: "period",
  historyView: "daily",
  showCost: false
};
const storageKeys = {
  showCost: "ai-token-league.public.showCost"
};

const tbody = document.querySelector("#leaderboard");
const statusEl = document.querySelector("#status");
const detailEl = document.querySelector("#participant-detail");
const detailBackdrop = document.querySelector("#detail-backdrop");
let detailCloseTimer = null;

hydratePreferences();
applyToggleState();

document.querySelectorAll("[data-filter='period']").forEach((group) => {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    setActive(group, button);
    state.period = button.dataset.value;
    loadLeaderboard();
    if (state.detailParticipantId) loadDetail(state.detailParticipantId);
  });
});

document.querySelector("[data-detail-tab]").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || !state.detailParticipantId) return;
  setActive(event.currentTarget, button);
  state.detailTab = button.dataset.value;
  renderDetailPanels();
  if (state.detailTab === "history") loadHistory(state.detailParticipantId);
});

document.querySelector("[data-history-view]").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || !state.detailParticipantId) return;
  setActive(event.currentTarget, button);
  state.historyView = button.dataset.value;
  loadHistory(state.detailParticipantId);
});

document.querySelector("#close-detail").addEventListener("click", closeDetail);
detailBackdrop.addEventListener("click", closeDetail);

document.querySelector("#show-cost").addEventListener("change", (event) => {
  state.showCost = event.target.checked;
  persistPreference(storageKeys.showCost, state.showCost);
  applyToggleState();
  loadLeaderboard();
  if (state.detailParticipantId) loadDetail(state.detailParticipantId);
});

async function loadLeaderboard() {
  statusEl.textContent = t("loading");
  const params = new URLSearchParams({ period: state.period });
  if (state.showCost) params.set("includeCost", "1");
  const response = await fetch(`/api/board/leaderboard?${params.toString()}`);
  const data = await response.json();
  if (data.identityMode) {
    state.identityMode = data.identityMode;
    applyIdentityMode(data.identityMode);
  }
  render(data.items || []);
  statusEl.textContent = t("web.leaderboard.participantCount", { count: data.items.length, plural: data.items.length === 1 ? "" : "s" });
}

function applyIdentityMode(mode) {
  const banner = document.querySelector("#anonymous-banner");
  banner.hidden = mode !== "anonymous";
  const colName = document.querySelector("#col-name");
  colName.setAttribute("data-i18n", mode === "anonymous" ? "web.leaderboard.colAlias" : "web.leaderboard.colNickname");
  colName.textContent = t(colName.getAttribute("data-i18n"));
}

function render(items) {
  if (!items.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="${state.showCost ? 4 : 3}">${t("web.leaderboard.noUsage")}</td></tr>`;
    return;
  }
  const isAnon = state.identityMode === "anonymous";
  tbody.innerHTML = items
    .map(
      (item) => `<tr>
        <td>
          <span class="rank">#${item.rank}</span>
          <button class="link-button participant-link${isAnon ? " anonymous-name" : ""}" data-display-id="${escapeHtml(item.displayId)}">
            ${escapeHtml(item.displayName)}${isAnon ? ` <span class="alias-mark">${t("web.leaderboard.aliasMark")}</span>` : ""}
          </button>
        </td>
        <td class="tokens" title="${formatTokenRaw(item.totalTokens)}">${localeTokenCompact(item.totalTokens)}</td>
        ${state.showCost ? `<td class="tokens" title="${escapeHtml(costTitle(item))}">${renderCost(item)}</td>` : ""}
        <td>${renderModels(item.models)}</td>
      </tr>`
    )
    .join("");
  tbody.querySelectorAll("[data-display-id]").forEach((button) => {
    button.addEventListener("click", () => loadDetail(button.dataset.displayId));
  });
}

async function loadDetail(participantId) {
  if (detailCloseTimer) clearTimeout(detailCloseTimer);
  state.detailParticipantId = participantId;
  state.detailTab = "period";
  setActive(document.querySelector("[data-detail-tab]"), document.querySelector("[data-detail-tab] [data-value='period']"));
  detailEl.hidden = false;
  detailBackdrop.hidden = false;
  requestAnimationFrame(() => {
    detailEl.classList.add("is-open");
    detailBackdrop.classList.add("is-open");
    document.body.classList.add("detail-open");
  });
  document.querySelector("#detail-status").textContent = t("loading");
  const params = new URLSearchParams({ period: state.period });
  if (state.showCost) params.set("includeCost", "1");
  const response = await fetch(`/api/board/participants/${encodeURIComponent(participantId)}?${params.toString()}`);
  const detail = await response.json();
  document.querySelector("#detail-title").textContent = `${detail.displayName} · ${periodLabel(state.period)}`;
  const identityNote = document.querySelector("#detail-identity-note");
  identityNote.hidden = state.identityMode !== "anonymous";
  identityNote.textContent = state.identityMode === "anonymous" ? t("web.leaderboard.aliasRotatesDaily") : "";
  document.querySelector("#detail-status").textContent = `${formatPeriodRange(detail.from, detail.to)} · ${t("web.detail.periodDetailLabel")}`;
  renderDetail(detail);
}

async function loadHistory(participantId) {
  document.querySelector("#detail-status").textContent = t("web.detail.loadingHistory");
  const params = new URLSearchParams(historyParams(state.historyView));
  if (state.showCost) params.set("includeCost", "1");
  const response = await fetch(`/api/board/participants/${encodeURIComponent(participantId)}/trend?${params.toString()}`);
  const detail = await response.json();
  document.querySelector("#detail-title").textContent = `${detail.displayName || t("web.detail.participant")} · ${historyLabel(state.historyView)}`;
  document.querySelector("#detail-status").textContent = `${formatPeriodRange(detail.from, detail.to)} · ${t("web.detail.historyWindow")}`;
  renderHistory(detail.items || []);
}

function renderDetail(detail) {
  renderDetailPanels();
  document.querySelector("#detail-summary").innerHTML = renderSummary(detail);
  document.querySelector("#detail-composition").innerHTML = renderCompositionBlock(detail, { showCost: state.showCost });
  document.querySelector("#period-chart").innerHTML = detail.isSingleDay
    ? `<article class="empty-state">${t("web.detail.singleDayNote")}</article>`
    : detail.periodRows?.length
      ? renderCompactTrend([...detail.periodRows].reverse(), { topTitle: t("web.detail.topDate") })
      : `<article class="empty-state">${t("web.detail.noUsagePeriod")}</article>`;
  document.querySelector("#detail-models").innerHTML = renderBreakdownBars(detail.models);
  document.querySelector("#detail-sources").innerHTML = renderBreakdownBars(detail.providers?.map((item) => ({ ...item, name: sourceName(item.name) })));
  renderRawRows(detail.rows || [], { mode: "period" });
}

function renderHistory(items) {
  document.querySelector("#detail-summary").innerHTML = renderHistorySummary(items);
  document.querySelector("#history-chart").innerHTML = items.length
    ? renderCompactTrend([...items].reverse(), { topTitle: t("web.detail.topPeriod") })
    : `<article class="empty-state">${t("web.detail.noUsageHistory")}</article>`;
  renderRawRows(items, { mode: "history" });
}

function renderHistorySummary(items) {
  const total = items.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);
  const peak = items.reduce((current, item) => (!current || item.totalTokens > current.totalTokens ? item : current), null);
  const aggregate = items.reduce((current, item) => ({
    inputTokens: current.inputTokens + Number(item.inputTokens || 0),
    outputTokens: current.outputTokens + Number(item.outputTokens || 0),
    cacheReadTokens: current.cacheReadTokens + Number(item.cacheReadTokens || 0),
    cacheWriteTokens: current.cacheWriteTokens + Number(item.cacheWriteTokens || 0),
    reasoningTokens: current.reasoningTokens + Number(item.reasoningTokens || 0),
    totalTokens: current.totalTokens + Number(item.totalTokens || 0),
    estimatedCostUsd: current.estimatedCostUsd + Number(item.estimatedCostUsd || 0),
    missingPriceTokens: current.missingPriceTokens + Number(item.missingPriceTokens || 0),
    costQuality: mergeCostQuality(current.costQuality, item.costQuality)
  }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    missingPriceTokens: 0,
    costQuality: ""
  });
  const summary = [
    [t("web.detail.historyBuckets"), String(items.length)],
    [t("web.detail.windowTokens"), localeTokenCompact(total), formatTokenRaw(total)],
    [t("web.detail.peakPeriod"), peak ? `${formatPeriod(peak)} · ${localeTokenCompact(peak.totalTokens)}` : "-"],
    [t("web.detail.composition"), localizedCompositionSummary(aggregate)]
  ];
  if (state.showCost) summary.push([t("web.detail.windowCost"), renderCost(aggregate), localizedCostQualityLabel(aggregate.costQuality)]);
  return summary.map(([label, value, title]) => `<article class="summary-tile"${title ? ` title="${escapeHtml(title)}"` : ""}>
    <span>${escapeHtml(label)}</span>
    <strong class="${summaryValueClass(value)}">${value}</strong>
  </article>`).join("");
}

function mergeCostQuality(left = "", right = "") {
  const rank = { exact_price: 0, estimated_price: 1, unknown_price: 2 };
  if (!left) return right || "";
  if (!right) return left;
  return rank[right] > rank[left] ? right : left;
}

function closeDetail() {
  state.detailParticipantId = "";
  detailEl.classList.remove("is-open");
  detailBackdrop.classList.remove("is-open");
  document.body.classList.remove("detail-open");
  if (detailEl.hidden) return;
  detailCloseTimer = setTimeout(() => {
    detailEl.hidden = true;
    detailBackdrop.hidden = true;
  }, 180);
}

function renderDetailPanels() {
  const isHistory = state.detailTab === "history";
  document.querySelector("[data-history-view]").hidden = !isHistory;
  document.querySelector("#period-detail-panel").hidden = isHistory;
  document.querySelector("#history-trend-panel").hidden = !isHistory;
}

function renderSummary(detail) {
  const items = [
    [t("web.detail.rank"), detail.rank ? `#${detail.rank}` : "-"],
    [t("web.detail.periodTokens"), localeTokenCompact(detail.totalTokens), formatTokenRaw(detail.totalTokens)],
    [t("web.detail.composition"), localizedCompositionSummary(detail)],
    [t("web.detail.dominant"), humanDominant(detail.dominantComposition || dominantComposition(detail))],
    [t("web.detail.models"), String(detail.models?.length || 0)]
  ];
  if (state.showCost) items.push([t("web.cost.estimatedPrice"), renderCost(detail), costTitle(detail)]);
  return items
    .map(([label, value, title]) => `<article class="summary-tile"${title ? ` title="${escapeHtml(title)}"` : ""}>
      <span>${escapeHtml(label)}</span>
      <strong class="${summaryValueClass(value)}">${value}</strong>
    </article>`)
    .join("");
}

function renderRawRows(items, { mode }) {
  document.querySelector("#detail-rows").innerHTML = items.length
    ? items
        .map((item) => `<tr>
          <td>${mode === "history" ? formatPeriod(item) : item.day}</td>
          <td class="tokens" title="${formatTokenRaw(item.totalTokens)}">${localeTokenCompact(item.totalTokens)}</td>
          <td>${escapeHtml(localizedCompositionSummary(item))}</td>
          <td class="tokens" title="${formatTokenRaw(item.inputTokens)}">${renderAccountingToken(item.inputTokens, item.inputCostUsd)}</td>
          <td class="tokens" title="${formatTokenRaw(item.outputTokens)}">${renderAccountingToken(item.outputTokens, item.outputCostUsd)}</td>
          <td class="tokens" title="${formatTokenRaw((item.cacheReadTokens || 0) + (item.cacheWriteTokens || 0))}">${renderAccountingToken((item.cacheReadTokens || 0) + (item.cacheWriteTokens || 0), sumKnownCosts(item.cacheReadCostUsd, item.cacheWriteCostUsd))}</td>
          <td class="tokens" title="${formatTokenRaw(item.reasoningTokens)}">${renderAccountingToken(item.reasoningTokens, item.reasoningCostUsd)}</td>
          ${state.showCost ? `<td class="tokens" title="${escapeHtml(costTitle(item))}">${renderCost(item)}</td>` : ""}
          ${state.showCost ? `<td>${escapeHtml(localizedCostQualityLabel(item.costQuality))}</td>` : ""}
          <td>${mode === "history" ? renderModels(item.models) : renderModels([{ name: item.model, totalTokens: item.totalTokens }])}</td>
        </tr>`)
        .join("")
    : `<tr><td class="empty" colspan="${state.showCost ? 10 : 8}">${t("web.detail.noUsagePeriod")}</td></tr>`;
}

function renderBreakdownBars(items = []) {
  if (!items.length) return `<article class="empty-state">${t("web.detail.noUsageSlice")}</article>`;
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  return items
    .map((item) => `<article class="bar-row">
      <span>${escapeHtml(item.name)}</span>
      <strong title="${formatTokenRaw(item.totalTokens)}">${localeTokenCompact(item.totalTokens)}</strong>
      <i style="width:${Math.max(3, (item.totalTokens / max) * 100)}%"></i>
    </article>`)
    .join("");
}

function renderCompactTrend(items, { topTitle }) {
  const sorted = [...items].sort((a, b) => formatPeriod(a).localeCompare(formatPeriod(b)));
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  const latest = sorted.at(-1);
  const peak = sorted.reduce((current, item) => (item.totalTokens > current.totalTokens ? item : current), sorted[0]);
  const top = [...items].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 5);
  return `<div class="compact-trend">
    <div class="compact-bars" aria-label="Usage trend">
      ${sorted
        .map((item) => {
          const title = escapeHtml(trendItemTitle(item));
          return `<span class="${item === latest ? "latest" : ""} ${item === peak ? "peak" : ""}" style="height:${Math.max(4, (item.totalTokens / max) * 100)}%" title="${title}" data-tooltip="${title}" tabindex="0"></span>`;
        })
        .join("")}
    </div>
    <div class="compact-axis">
      <span>${escapeHtml(formatPeriod(sorted[0]))}</span>
      <strong>${t("common.peak")} ${escapeHtml(formatPeriod(peak))} · ${localeTokenCompact(peak.totalTokens)}</strong>
      <span>${escapeHtml(formatPeriod(latest))}</span>
    </div>
    <div class="top-contributors">
      <h3>${escapeHtml(topTitle)}</h3>
      ${top
        .map((item, index) => `<article>
          <span>#${index + 1} ${escapeHtml(formatPeriod(item))}</span>
          <strong title="${escapeHtml(trendItemTitle(item))}">${localeTokenCompact(item.totalTokens)}${state.showCost ? ` · ${renderCost(item)}` : ""}</strong>
          <small>${escapeHtml(localizedCompositionSummary(item))}</small>
        </article>`)
        .join("")}
    </div>
  </div>`;
}

function renderCompositionBlock(item, { showCost = false } = {}) {
  const rows = tokenCompositionDetails(item)
    .map((entry) => {
      const cost = showCost ? renderCostPart(item, entry.field) : "";
      return `<article class="summary-tile composition-tile">
        <span>${escapeHtml(compositionFieldLabel(entry.field))}</span>
        <strong title="${formatTokenRaw(entry.tokens)}">${localeTokenCompact(entry.tokens)}</strong>
        <small>${Math.round(entry.ratio * 100)}%${cost ? ` · ${cost}` : ""}</small>
      </article>`;
    })
    .join("");
  const footer = showCost
    ? `<p class="composition-note">${t("common.total")} ${renderCost(item)} · ${escapeHtml(localizedCostQualityLabel(item.costQuality))}</p>`
    : `<p class="composition-note">${escapeHtml(localizedCompositionSummary(item))}</p>`;
  return `<div class="detail-summary composition-grid">${rows}</div>${footer}`;
}

function renderAccountingToken(tokens, cost) {
  const costLine = state.showCost ? `<small>${formatCost(cost)}</small>` : "";
  return `<span class="token-accounting">${localeTokenCompact(tokens || 0)}${costLine}</span>`;
}

function sumKnownCosts(...values) {
  const known = values.filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
  if (!known.length) return null;
  return known.reduce((sum, value) => sum + Number(value), 0);
}

function renderCostPart(item, tokenField) {
  const mapping = {
    inputTokens: item.inputCostUsd,
    outputTokens: item.outputCostUsd,
    cacheReadTokens: item.cacheReadCostUsd,
    cacheWriteTokens: item.cacheWriteCostUsd,
    reasoningTokens: item.reasoningCostUsd
  };
  return formatCost(mapping[tokenField]);
}

function summaryValueClass(value) {
  const text = String(value || "").replace(/<[^>]+>/g, "");
  return text.length > 14 || text.includes("·") ? "compact-value" : "";
}

function renderModels(items = []) {
  return items
    .map((item) => `<span class="pill" title="${formatTokenRaw(item.totalTokens)}">${escapeHtml(item.name)} ${localeTokenCompact(item.totalTokens)}</span>`)
    .join("");
}

function setActive(group, button) {
  group.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
}

function formatPeriod(item) {
  return item.periodStart === item.periodEnd ? item.periodStart : `${item.periodStart} - ${item.periodEnd}`;
}

function formatPeriodRange(from, to) {
  if (!from && !to) return "-";
  return from === to ? from : t("common.dateRange", { from, to });
}

function periodLabel(period) {
  const labels = {
    today: t("web.period.today"),
    yesterday: t("web.period.yesterday"),
    this_week: t("web.period.thisWeek"),
    last_week: t("web.period.lastWeek"),
    this_month: t("web.period.thisMonth"),
    last_month: t("web.period.lastMonth")
  };
  return labels[period] || period;
}

function historyParams(view) {
  if (view === "weekly") return { grain: "week", range: "last12_weeks" };
  if (view === "monthly") return { grain: "month", range: "last12_months" };
  return { grain: "day", range: "last30" };
}

function historyLabel(view) {
  if (view === "weekly") return t("web.detail.weeklyHistory");
  if (view === "monthly") return t("web.detail.monthlyHistory");
  return t("web.detail.dailyHistory");
}

function sourceName(providerId) {
  if (providerId === "codex_local") return t("source.codex");
  if (providerId === "claude_code_local") return t("source.claude");
  if (providerId === "cursor_dashboard_usage") return t("source.cursor");
  return providerId;
}

function hydratePreferences() {
  state.showCost = readBooleanPreference(storageKeys.showCost, false);
}

function applyToggleState() {
  document.querySelector("#show-cost").checked = state.showCost;
  document.querySelectorAll(".cost-col").forEach((item) => {
    item.hidden = !state.showCost;
  });
}

function persistPreference(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(Boolean(value)));
  } catch {}
}

function readBooleanPreference(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) === true;
  } catch {
    return fallback;
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
}

function formatTokenRaw(value) {
  return `${formatNumber(value)} ${t("unit.tokens")}`;
}

function formatCost(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  const n = Number(value);
  if (n > 0 && n < 0.01) return "<$0.01";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
}

function costTitle(item) {
  const missing = normalizeMissingPriceModels(item.missingPriceModels).map((model) => `${model.name} ${formatTokenRaw(model.totalTokens)}`).join(", ");
  return `${localizedCostQualityLabel(item.costQuality)} · ${item.pricingVersion || t("web.cost.noPricingVersion")}${missing ? ` · ${t("web.cost.missingModels")}: ${missing}` : ""}`;
}

function normalizeMissingPriceModels(value) {
  if (Array.isArray(value)) return value;
  return Object.entries(value || {})
    .sort((a, b) => b[1] - a[1])
    .map(([name, totalTokens]) => ({ name, totalTokens }));
}

function renderCost(item) {
  const value = formatCost(item.estimatedCostUsd);
  if (value === "-") return value;
  return `${value}${item.missingPriceTokens ? `<sup title="${escapeHtml(t("web.cost.missingModelPrices"))}">*</sup>` : ""}`;
}

function localizedCostQualityLabel(value = "") {
  if (value === "exact_price") return t("web.cost.exactPrice");
  if (value === "estimated_price") return t("web.cost.estimatedPrice");
  return t("web.cost.unknownPrice");
}

function localizedCompositionSummary(item = {}) {
  const total = Number(item.totalTokens || 0);
  if (!total) return t("web.composition.noUsage");
  const parts = [
    [t("web.detail.input"), item.inputTokens],
    [t("web.detail.output"), item.outputTokens],
    [t("web.detail.cache"), Number(item.cacheReadTokens || 0) + Number(item.cacheWriteTokens || 0)],
    [t("web.detail.reasoning"), item.reasoningTokens]
  ];
  return parts
    .filter(([, value]) => Number(value || 0) > 0)
    .map(([label, value]) => `${label} ${Math.round((Number(value || 0) / total) * 100)}%`)
    .join(" · ");
}

function compositionFieldLabel(field) {
  return {
    inputTokens: t("web.detail.input"),
    outputTokens: t("web.detail.output"),
    cacheReadTokens: t("web.detail.cacheRead"),
    cacheWriteTokens: t("web.detail.cacheWrite"),
    reasoningTokens: t("web.detail.reasoning")
  }[field] || field;
}

function humanDominant(value = "") {
  const labels = {
    "input-heavy": t("web.composition.inputHeavy"),
    "output-heavy": t("web.composition.outputHeavy"),
    "cache-heavy": t("web.composition.cacheHeavy"),
    "reasoning-heavy": t("web.composition.reasoningHeavy"),
    "no-usage": t("web.composition.noUsage")
  };
  return labels[value] || value || "-";
}

function trendItemTitle(item) {
  const cost = state.showCost ? ` · ${t("common.cost")} ${renderCost(item).replace(/<[^>]+>/g, "")}` : "";
  return `${formatPeriod(item)} · ${formatTokenRaw(item.totalTokens)}${cost}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

// 初始化语言切换器
const langContainer = document.querySelector("#lang-switcher-container");
if (langContainer) {
  langContainer.innerHTML = createLangSwitcher();
  bindLangSwitcher("lang-switcher", () => {
    // 语言切换后重新加载页面以应用新语言
    window.location.reload();
  });
}

// 应用当前语言翻译
updatePageTranslations();

loadLeaderboard().catch((error) => {
  statusEl.textContent = error.message;
});
