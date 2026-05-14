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
  showCost: false,
  viewMode: "meter"
};
const storageKeys = {
  showCost: "ai-token-league.public.showCost",
  viewMode: "ai-token-league.public.viewMode"
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

document.querySelectorAll("[data-view-mode]").forEach((group) => {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    setActive(group, button);
    state.viewMode = button.dataset.value;
    persistPreference(storageKeys.viewMode, state.viewMode);
    applyViewMode();
  });
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
  const eyebrowKey = {
    anonymous: "web.publicBoardAnonymous",
    public: "web.publicBoardPublic",
    authenticated: "web.publicBoardAuthenticated"
  }[mode] || "web.publicBoard";
  const eyebrow = document.querySelector("#board-identity-eyebrow");
  if (eyebrow) {
    eyebrow.setAttribute("data-i18n", eyebrowKey);
    eyebrow.textContent = t(eyebrowKey);
  }
  const colName = document.querySelector("#col-name");
  colName.setAttribute("data-i18n", mode === "anonymous" ? "web.leaderboard.colAlias" : "web.leaderboard.colNickname");
  colName.textContent = t(colName.getAttribute("data-i18n"));
}

function render(items) {
  const top = orderPodium(items.slice(0, 3));
  const rest = items.slice(3);
  renderTopThree(top);
  renderMeterView(rest);
  renderListView(rest);
}

function orderPodium(items) {
  if (items.length < 3) return items;
  return [items[1], items[0], items[2]];
}

function renderListView(items) {
  if (!items.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="${state.showCost ? 5 : 4}">${t("web.leaderboard.noMoreUsage")}</td></tr>`;
    return;
  }
  tbody.innerHTML = items
    .map(
      (item) => `<tr>
        <td><span class="rank">#${item.rank}</span></td>
        <td>
          <button class="link-button participant-link" data-display-id="${escapeHtml(item.displayId)}">
            ${renderDisplayName(item.displayName)}
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

function renderTopThree(items) {
  const topThree = document.querySelector("#top-three");
  if (!items.length) {
    topThree.innerHTML = `<div class="meter-empty">${t("web.leaderboard.noUsage")}</div>`;
    return;
  }
  topThree.innerHTML = items
    .map((item) => `<article class="medal-card medal-rank-${item.rank}" data-display-id="${escapeHtml(item.displayId)}" data-tooltip="${escapeHtml(modelUsageTitle(item))}">
      <span class="medal-icon" aria-hidden="true">${rankIcon(item.rank)}</span>
      <div class="medal-card-head">
        <span class="medal-rank">#${item.rank}</span>
        <button class="link-button participant-link">${renderDisplayName(item.displayName)}</button>
      </div>
      <strong class="medal-total" title="${formatTokenRaw(item.totalTokens)}">${localeTokenCompact(item.totalTokens)}</strong>
      ${state.showCost ? `<span class="medal-cost">${renderCost(item)}</span>` : ""}
      ${renderModelSegments(item, { className: "composition-strip", title: modelUsageTitle(item) })}
    </article>`)
    .join("");
  topThree.querySelectorAll(".medal-card[data-display-id]").forEach((el) => {
    el.addEventListener("click", () => loadDetail(el.dataset.displayId));
  });
}

function renderMeterView(items) {
  const meterView = document.querySelector("#meter-view");
  if (!items.length) {
    meterView.innerHTML = `<div class="meter-empty">${t("web.leaderboard.noMoreUsage")}</div>`;
    return;
  }
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  const colorCycle = ["", "meter-yellow", "meter-violet"];
  meterView.innerHTML = items
    .map((item) => {
      const pct = Math.max(3, (item.totalTokens / max) * 100);
      const colorClass = colorCycle[(item.rank - 1) % colorCycle.length];
      return `<div class="meter-row" data-display-id="${escapeHtml(item.displayId)}" data-tooltip="${escapeHtml(modelUsageTitle(item))}">
        <span class="meter-name">
          <span class="rank">#${item.rank}</span>
          <button class="link-button participant-link" type="button">${renderDisplayName(item.displayName)}</button>
        </span>
        <div class="meter-bar ${colorClass}">
          <div class="meter-fill" style="width:${pct}%">
            ${renderModelSegmentItems(item)}
          </div>
        </div>
        <span class="meter-value">
          <strong title="${formatTokenRaw(item.totalTokens)}">${localeTokenCompact(item.totalTokens)}</strong>
          ${state.showCost ? `<span class="cost-amount">${renderCost(item)}</span>` : ""}
        </span>
      </div>`;
    })
    .join("");
  meterView.querySelectorAll(".meter-row[data-display-id]").forEach((el) => {
    el.addEventListener("click", () => loadDetail(el.dataset.displayId));
  });
}

function rankIcon(rank) {
  const trophy = `<svg class="lucide lucide-trophy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14.66v1.626a2 2 0 0 1-.976 1.696A5 5 0 0 0 7 21.978"/><path d="M14 14.66v1.626a2 2 0 0 0 .976 1.696A5 5 0 0 1 17 21.978"/><path d="M18 9h1.5a1 1 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"/><path d="M6 9H4.5a1 1 0 0 1 0-5H6"/></svg>`;
  const medal = `<svg class="lucide lucide-medal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15"/><path d="M11 12 5.12 2.2"/><path d="m13 12 5.88-9.8"/><path d="M8 7h8"/><circle cx="12" cy="17" r="5"/><path d="M12 18v-2h-.5"/></svg>`;
  return rank === 1 ? trophy : medal;
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
  renderDetailTitle(detail.displayName, periodLabel(state.period));
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
  renderDetailTitle(detail.displayName || t("web.detail.participant"), historyLabel(state.historyView));
  const identityNote = document.querySelector("#detail-identity-note");
  identityNote.hidden = state.identityMode !== "anonymous";
  identityNote.textContent = state.identityMode === "anonymous" ? t("web.leaderboard.aliasRotatesDaily") : "";
  document.querySelector("#detail-status").textContent = `${formatPeriodRange(detail.from, detail.to)} · ${t("web.detail.historyWindow")}`;
  renderHistory(detail.items || []);
}

function renderDisplayName(displayName) {
  return escapeHtml(displayName);
}

function renderDetailTitle(displayName, contextLabel) {
  const nameHtml = state.identityMode === "anonymous"
    ? `<span class="anonymous-name detail-alias-name">${renderDisplayName(displayName)}</span>`
    : escapeHtml(displayName);
  document.querySelector("#detail-title").innerHTML = `${nameHtml}<span class="detail-title-separator">·</span><span class="detail-title-context">${escapeHtml(contextLabel)}</span>`;
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
        .map((item) => {
          const total = Number(item.totalTokens || 0);
          const pct = (v) => total ? Math.round((Number(v || 0) / total) * 100) : 0;
          const totalCell = state.showCost
            ? `<span class="token-accounting">${localeTokenCompact(total)}<small><span class="cost-amount">${escapeHtml(formatCost(item.estimatedCostUsd))}</span></small></span>`
            : localeTokenCompact(total);
          const modelName = mode === "history"
            ? (item.models || []).map((m) => m.name).join(", ") || item.model || ""
            : item.model || "";
          return `<tr>
          <td>${mode === "history" ? formatPeriod(item) : item.day}</td>
          <td class="tokens" title="${formatTokenRaw(item.totalTokens)}${state.showCost ? ` · ${escapeHtml(costTitle(item))}` : ""}">${totalCell}</td>
          <td class="tokens" title="${formatTokenRaw(item.inputTokens)}">${renderAccountingToken(item.inputTokens, item.inputCostUsd)} <small class="pct">${pct(item.inputTokens)}%</small></td>
          <td class="tokens" title="${formatTokenRaw(item.outputTokens)}">${renderAccountingToken(item.outputTokens, item.outputCostUsd)} <small class="pct">${pct(item.outputTokens)}%</small></td>
          <td class="tokens" title="${formatTokenRaw((item.cacheReadTokens || 0) + (item.cacheWriteTokens || 0))}">${renderAccountingToken((item.cacheReadTokens || 0) + (item.cacheWriteTokens || 0), sumKnownCosts(item.cacheReadCostUsd, item.cacheWriteCostUsd))} <small class="pct">${pct((item.cacheReadTokens || 0) + (item.cacheWriteTokens || 0))}%</small></td>
          <td class="tokens" title="${formatTokenRaw(item.reasoningTokens)}">${renderAccountingToken(item.reasoningTokens, item.reasoningCostUsd)} <small class="pct">${pct(item.reasoningTokens)}%</small></td>
          ${state.showCost ? `<td>${escapeHtml(localizedCostQualityLabel(item.costQuality))}</td>` : ""}
          <td>${escapeHtml(modelName)}</td>
        </tr>`;
        })
        .join("")
    : `<tr><td class="empty" colspan="${state.showCost ? 8 : 7}">${t("web.detail.noUsagePeriod")}</td></tr>`;
}

function renderBreakdownBars(items = []) {
  if (!items.length) return `<article class="empty-state">${t("web.detail.noUsageSlice")}</article>`;
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  return items
    .map((item) => `<article class="bar-row">
      <span>${escapeHtml(item.name)}</span>
      <strong title="${formatTokenRaw(item.totalTokens)}${state.showCost ? ` · ${escapeHtml(costTitle(item))}` : ""}">${localeTokenCompact(item.totalTokens)}${state.showCost ? ` · ${renderCost(item)}` : ""}</strong>
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
      return `<article class="summary-tile composition-tile">
        <span>${escapeHtml(compositionFieldLabel(entry.field))}</span>
        <strong title="${formatTokenRaw(entry.tokens)}">${localeTokenCompact(entry.tokens)}</strong>
        <small>${Math.round(entry.ratio * 100)}%</small>
        ${showCost ? `<small>${renderCostPart(item, entry.field)}</small>` : ""}
      </article>`;
    })
    .join("");
  const footer = showCost
    ? `<p class="composition-note">${t("common.total")} ${renderCost(item)} · ${escapeHtml(localizedCostQualityLabel(item.costQuality))}</p>`
    : `<p class="composition-note">${escapeHtml(localizedCompositionSummary(item))}</p>`;
  return `<div class="detail-summary composition-grid">${rows}</div>${footer}`;
}

function renderModelSegments(item, { className, title }) {
  return `<div class="${className}" title="${escapeHtml(title)}">
    ${renderModelSegmentItems(item)}
  </div>`;
}

function renderModelSegmentItems(item) {
  const models = normalizeModelSegments(item);
  if (!models.length) return `<i class="model-segment model-segment-empty" style="width:100%"></i>`;
  return models
    .map((model, index) => `<i class="model-segment model-segment-${(index % 5) + 1}" style="width:${model.ratio}%"></i>`)
    .join("");
}

function normalizeModelSegments(item) {
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

function modelUsageTitle(item) {
  const models = normalizeModelSegments(item);
  if (!models.length) return t("web.detail.noUsageSlice");
  return models
    .map((model) => `${model.name}: ${localeTokenCompact(model.totalTokens)} (${Math.round((model.totalTokens / Number(item.totalTokens || 1)) * 100)}%)`)
    .join("\n");
}

function renderAccountingToken(tokens, cost) {
  const costLine = state.showCost ? `<small><span class="cost-amount">${escapeHtml(formatCost(cost))}</span></small>` : "";
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
  return `<span class="cost-amount">${escapeHtml(formatCost(mapping[tokenField]))}</span>`;
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
  const savedViewMode = readStringPreference(storageKeys.viewMode, "meter");
  state.viewMode = savedViewMode === "list" ? "list" : "meter";
}

function applyToggleState() {
  document.querySelector("#show-cost").checked = state.showCost;
  document.querySelectorAll(".cost-col").forEach((item) => {
    item.hidden = !state.showCost;
  });
  applyViewMode();
}

function applyViewMode() {
  const meterView = document.querySelector("#meter-view");
  const listView = document.querySelector("#list-view");
  const isMeter = state.viewMode === "meter";
  meterView.hidden = !isMeter;
  listView.hidden = isMeter;
  // sync segmented button state
  document.querySelectorAll("[data-view-mode]").forEach((group) => {
    group.querySelectorAll("button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.value === state.viewMode);
    });
  });
}

function persistPreference(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
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

function readStringPreference(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
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
  if (n > 0 && n < 0.01) return t("common.lessThanCost");
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
  return `<span class="cost-amount">${escapeHtml(value)}</span>${item.missingPriceTokens ? `<sup title="${escapeHtml(t("web.cost.missingModelPrices"))}">*</sup>` : ""}`;
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
