import { initI18n, t, getCurrentLang, createLangSwitcher, bindLangSwitcher, updatePageTranslations } from "/shared/i18n.js";
import { formatContributionPercent, formatTokenCompact } from "/shared/display.js";
import {
  escapeHtml, sourceName, formatTokenRaw,
  normalizeModelSegments, modelUsageTitle, renderModelSegmentItems,
  renderModelSegments, renderCost, formatPricePer100M
} from "/shared/chart-helpers.js";

function localeTokenCompact(value) {
  return formatTokenCompact(value, getCurrentLang());
}

// 初始化多语言
const currentLang = initI18n();

const state = {
  period: "today",
  source: "",
  identityMode: "public",
  showCost: false,
  viewMode: "meter",
  loading: false
};
const storageKeys = {
  showCost: "ai-token-league.public.showCost",
  viewMode: "ai-token-league.public.viewMode"
};

const tbody = document.querySelector("#leaderboard");
const statusEl = document.querySelector("#status");
const sourceFilter = document.querySelector("#source-filter");
let leaderboardSettleTimer = null;

function profileUrl(displayId) {
  return `/profile.html?id=${encodeURIComponent(displayId)}`;
}

hydratePreferences();
applyToggleState();

document.querySelectorAll("[data-filter='period']").forEach((group) => {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || state.loading) return;
    setActive(group, button);
    state.period = button.dataset.value;
    loadLeaderboard();
  });
});

document.querySelector("#show-cost").addEventListener("change", (event) => {
  state.showCost = event.target.checked;
  persistPreference(storageKeys.showCost, state.showCost);
  applyToggleState();
  loadLeaderboard();
});

sourceFilter?.addEventListener("change", () => {
  state.source = sourceFilter.value;
  loadLeaderboard();
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
  setLeaderboardLoading(true);
  try {
    statusEl.textContent = t("loading");
    const params = new URLSearchParams({ period: state.period });
    if (state.source) params.set("source", state.source);
    if (state.showCost) params.set("includeCost", "1");
    const response = await fetch(`/api/board/leaderboard?${params.toString()}`);
    if (!response.ok) throw new Error(t("web.analytics.noData"));
    const data = await response.json();
    if (data.identityMode) {
      state.identityMode = data.identityMode;
      applyIdentityMode(data.identityMode);
    }
    render(data.items || []);
    statusEl.textContent = t("web.leaderboard.participantCount", { count: data.items.length, plural: data.items.length === 1 ? "" : "s" });
  } finally {
    setLeaderboardLoading(false);
  }
}

function setLeaderboardLoading(on) {
  state.loading = on;
  const surface = document.querySelector("#leaderboard-surface");
  surface?.classList.toggle("is-refreshing", on);
  surface?.setAttribute("aria-busy", on ? "true" : "false");
  document.querySelectorAll("[data-filter='period'] button, #show-cost, #source-filter").forEach((control) => {
    control.disabled = on;
  });
  if (on || !surface) return;
  if (leaderboardSettleTimer) window.clearTimeout(leaderboardSettleTimer);
  surface.classList.remove("is-settled");
  requestAnimationFrame(() => surface.classList.add("is-settled"));
  leaderboardSettleTimer = window.setTimeout(() => surface.classList.remove("is-settled"), 560);
}

function applyIdentityMode(mode) {
  applyBoardIdentityEyebrow(mode);
  const colName = document.querySelector("#col-name");
  colName.setAttribute("data-i18n", mode === "anonymous" ? "web.leaderboard.colAlias" : "web.leaderboard.colNickname");
  colName.textContent = t(colName.getAttribute("data-i18n"));
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

function render(items) {
  const communityTotal = items.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);
  const top = orderPodium(items.slice(0, 3));
  const rest = items.slice(3);
  renderTopThree(top, communityTotal);
  renderMeterView(rest, communityTotal);
  renderListView(rest, communityTotal);
}

function orderPodium(items) {
  if (items.length < 3) return items;
  return [items[1], items[0], items[2]];
}

function renderListView(items, communityTotal) {
  if (!items.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="${state.showCost ? 6 : 5}">${t("web.leaderboard.noMoreUsage")}</td></tr>`;
    return;
  }
  tbody.innerHTML = items
    .map(
      (item) => `<tr>
        <td><span class="rank">#${item.rank}</span></td>
        <td>
          <a class="link-button participant-link" href="${profileUrl(item.displayId)}" data-display-id="${escapeHtml(item.displayId)}">
            ${renderDisplayName(item.displayName)}
          </a>
        </td>
        <td class="tokens" title="${formatTokenRaw(item.totalTokens)}">${localeTokenCompact(item.totalTokens)}</td>
        <td class="contribution-cell">${formatContributionPercent(item.totalTokens, communityTotal)}</td>
        ${state.showCost ? `<td class="tokens" title="${escapeHtml(costTitle(item))}">${renderCost(item)}<small class="price-sub">${formatPricePer100M(item)}</small></td>` : ""}
        <td>${renderModels(item.models)}</td>
      </tr>`
    )
    .join("");
}

function renderTopThree(items, communityTotal) {
  const topThree = document.querySelector("#top-three");
  if (!items.length) {
    topThree.innerHTML = `<div class="meter-empty">${t("web.leaderboard.noUsage")}</div>`;
    return;
  }
  topThree.innerHTML = items
    .map((item) => `<article class="medal-card medal-rank-${item.rank}" data-display-id="${escapeHtml(item.displayId)}" data-tooltip="${escapeHtml(modelUsageTitle(item, localeTokenCompact))}" tabindex="0" role="link" aria-label="${escapeHtml(item.displayName)}">
      <span class="medal-icon" aria-hidden="true">${rankIcon(item.rank)}</span>
      <div class="medal-card-head">
        <span class="medal-rank">#${item.rank}</span>
        <a class="link-button participant-link" href="${profileUrl(item.displayId)}">${renderDisplayName(item.displayName)}</a>
      </div>
      <strong class="medal-total" title="${formatTokenRaw(item.totalTokens)}">${localeTokenCompact(item.totalTokens)}</strong>
      ${renderLeaderboardValueMeta(item, communityTotal, "medal-meta")}
      ${renderModelSegments(item, { className: "composition-strip", title: modelUsageTitle(item, localeTokenCompact) })}
    </article>`)
    .join("");
  topThree.querySelectorAll(".medal-card[data-display-id]").forEach((el) => {
    el.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      window.location.assign(profileUrl(el.dataset.displayId));
    });
    el.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      window.location.assign(profileUrl(el.dataset.displayId));
    });
  });
}

function renderMeterView(items, communityTotal) {
  const meterView = document.querySelector("#meter-view");
  if (!items.length) {
    meterView.innerHTML = `<div class="meter-empty">${t("web.leaderboard.noMoreUsage")}</div>`;
    return;
  }
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  meterView.innerHTML = items
    .map((item) => {
      const pct = Math.max(3, (item.totalTokens / max) * 100);
      const rankClass = item.rank <= 10 ? `meter-rank-${Math.min(item.rank, 10)}` : "";
      return `<div class="meter-row ${rankClass}" data-display-id="${escapeHtml(item.displayId)}" data-tooltip="${escapeHtml(modelUsageTitle(item, localeTokenCompact))}" tabindex="0" role="link" aria-label="${escapeHtml(item.displayName)}">
        <span class="meter-name">
          <span class="rank">#${item.rank}</span>
          <a class="link-button participant-link" href="${profileUrl(item.displayId)}">${renderDisplayName(item.displayName)}</a>
        </span>
        <div class="meter-bar">
          <div class="meter-fill" style="width:${pct}%">
            ${renderModelSegmentItems(item)}
          </div>
        </div>
        <span class="meter-value${state.showCost ? " has-cost" : ""}">
          <strong class="meter-total" title="${formatTokenRaw(item.totalTokens)}">${localeTokenCompact(item.totalTokens)}</strong>
          <span class="meter-share"><span>${t("web.leaderboard.contribution")}</span><b>${formatContributionPercent(item.totalTokens, communityTotal)}</b></span>
          ${state.showCost ? `<span class="meter-cost">${renderCost(item)}<small class="price-sub">${formatPricePer100M(item)}</small></span>` : ""}
        </span>
      </div>`;
    })
    .join("");
  meterView.querySelectorAll(".meter-row[data-display-id]").forEach((el) => {
    el.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      window.location.assign(profileUrl(el.dataset.displayId));
    });
    el.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      window.location.assign(profileUrl(el.dataset.displayId));
    });
  });
}

function renderLeaderboardValueMeta(item, communityTotal, className) {
  return `<span class="leaderboard-value-meta ${className}">
    <span class="contribution-stat">${t("web.leaderboard.contribution")} <strong>${formatContributionPercent(item.totalTokens, communityTotal)}</strong></span>
    ${state.showCost ? `<span class="value-meta-divider" aria-hidden="true">·</span><span class="value-meta-cost">${renderCost(item)}${formatPricePer100M(item) !== "-" ? `<small class="price-sub">${formatPricePer100M(item)}</small>` : ""}</span>` : ""}
  </span>`;
}

function rankIcon(rank) {
  const trophy = `<svg class="lucide lucide-trophy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14.66v1.626a2 2 0 0 1-.976 1.696A5 5 0 0 0 7 21.978"/><path d="M14 14.66v1.626a2 2 0 0 0 .976 1.696A5 5 0 0 1 17 21.978"/><path d="M18 9h1.5a1 1 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"/><path d="M6 9H4.5a1 1 0 0 1 0-5H6"/></svg>`;
  const medal = `<svg class="lucide lucide-medal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15"/><path d="M11 12 5.12 2.2"/><path d="m13 12 5.88-9.8"/><path d="M8 7h8"/><circle cx="12" cy="17" r="5"/><path d="M12 18v-2h-.5"/></svg>`;
  return rank === 1 ? trophy : medal;
}

function renderDisplayName(displayName) {
  return escapeHtml(displayName);
}

function renderSourceOptions(sourceNames) {
  if (!sourceFilter) return;
  const current = sourceFilter.value;
  const options = new Set(sourceNames.filter(Boolean));
  if (current && !options.has(current)) state.source = "";
  sourceFilter.innerHTML = `<option value="">${escapeHtml(t("web.leaderboard.allSources"))}</option>${[...options]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(sourceName(name))}</option>`)
    .join("")}`;
  sourceFilter.value = options.has(current) ? current : "";
}

async function loadSourceFilterOptions() {
  try {
    const response = await fetch("/api/board/source-leaderboard?range=all&top=1");
    if (!response.ok) return;
    const data = await response.json();
    renderSourceOptions((data.sources || []).map((source) => source.name));
  } catch (error) {
    // Silent fallback: keep only the "All sources" option when options fail to load.
    console.warn("Failed to load source filter options:", error.message);
  }
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
  const activeView = isMeter ? meterView : listView;
  activeView.classList.remove("view-enter");
  requestAnimationFrame(() => activeView.classList.add("view-enter"));
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

function localizedCostQualityLabel(value = "") {
  if (value === "exact_price") return t("web.cost.exactPrice");
  if (value === "estimated_price") return t("web.cost.estimatedPrice");
  return t("web.cost.unknownPrice");
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

loadSourceFilterOptions();
