import { tokenCompositionDetails } from "/shared/composition.js";
import { initI18n, t, getCurrentLang, createLangSwitcher, bindLangSwitcher, updatePageTranslations } from "/shared/i18n.js";
import { formatTokenCompact } from "/shared/display.js";

initI18n();
const langContainer = document.querySelector("#lang-switcher-container");
if (langContainer) {
  langContainer.innerHTML = createLangSwitcher();
  bindLangSwitcher("lang-switcher", () => window.location.reload());
}
updatePageTranslations();

const state = {
  grainMode: "auto",
  grain: "day",
  usageView: "ranking",
  range: "month",
  start: "",
  end: "",
  participantId: "",
  rankingPage: 1,
  rankingPageSize: 25,
  rawTokens: false,
  showCost: false,
  expandedUsageKey: "",
  expandedRankingKey: "",
  customRangePending: false,
  missingPricesCollapsed: false
};
const storageKeys = {
  rawTokens: "ai-token-league.admin.rawTokens",
  showCost: "ai-token-league.admin.showCost",
  missingPricesCollapsed: "ai-token-league.admin.missingPricesCollapsed"
};
const tbody = document.querySelector("#leaderboard");
const rankingTbody = document.querySelector("#ranking-tbody");
const statusEl = document.querySelector("#status");
const rankingStatus = document.querySelector("#ranking-status");
const rankingPrev = document.querySelector("#ranking-prev");
const rankingNext = document.querySelector("#ranking-next");
const rankingPageLabel = document.querySelector("#ranking-page-label");
const detailBoard = document.querySelector("#detail-board");
const detailBackdrop = document.querySelector("#admin-detail-backdrop");
const participantFilter = document.querySelector("#participant-filter");
const pricingStatus = document.querySelector("#pricing-status");
let detailCloseTimer = null;
let detailTrigger = null;
let qualityCacheKey = "";
let qualityCacheData = null;
let priceTargetMenu = null;
let activePriceTargetInput = null;
let priceTargetOptions = [];
let filteredPriceTargetOptions = [];
let activePriceTargetIndex = -1;
let pricingLibraryData = { custom: [], aliases: [], openrouter: [] };
const adminPanelSettleTimers = new Map();

function setAdminPanelBusy(tabId, on) {
  const panel = document.querySelector(`[data-admin-panel="${tabId}"]`);
  if (!panel) return;
  panel.classList.toggle("is-refreshing", on);
  panel.setAttribute("aria-busy", on ? "true" : "false");
  if (on) return;
  const existingTimer = adminPanelSettleTimers.get(tabId);
  if (existingTimer) window.clearTimeout(existingTimer);
  panel.classList.remove("is-settled");
  requestAnimationFrame(() => panel.classList.add("is-settled"));
  adminPanelSettleTimers.set(tabId, window.setTimeout(() => {
    panel.classList.remove("is-settled");
    adminPanelSettleTimers.delete(tabId);
  }, 560));
}

async function fetchAdmin(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    showAuthRequired();
    throw new Error("Authentication required");
  }
  return response;
}

function showAuthRequired() {
  const message = t("admin.authRequired");
  statusEl.textContent = message;
  rankingStatus.textContent = message;
  pricingStatus.textContent = message;
  rankingTbody.innerHTML = `<tr><td class="empty" colspan="8">${message}</td></tr>`;
  tbody.innerHTML = `<tr><td class="empty" colspan="8">${message}</td></tr>`;
}

function applyUsageView() {
  document.querySelectorAll("[data-usage-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.usageView === state.usageView);
  });
  document.querySelectorAll("[data-usage-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.usagePanel === state.usageView);
  });
  const grainControls = document.querySelector("[data-grain-controls]");
  if (grainControls) grainControls.hidden = state.usageView !== "aggregate";
  syncRangeInputs();
}

hydratePreferences();
applyToggleState();
applyUsageView();
initMissingPricesToggle();
syncMissingPricesCollapse();

document.querySelector(".admin-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button?.dataset.adminTab) return;
  switchAdminTab(button.dataset.adminTab);
});

document.querySelector(".pricing-grid")?.addEventListener("input", (event) => {
  const type = event.target.dataset.pricingSearch;
  if (!type) return;
  renderPricingLibrary(type, event.target.value);
});

document.querySelector(".usage-view-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const nextView = button.dataset.usageView || "ranking";
  if (nextView === state.usageView) return;
  state.usageView = nextView;
  state.expandedUsageKey = "";
  state.expandedRankingKey = "";
  applyUsageView();
  loadUsage();
});

window.addEventListener("message", (event) => {
  const iframe = document.querySelector("#analytics-iframe");
  if (event.origin !== window.location.origin || event.source !== iframe?.contentWindow) return;
  if (event.data?.type === "analytics-resize") {
    const height = Number(event.data.height);
    if (iframe && Number.isFinite(height) && height > 0) {
      const nextHeight = Math.ceil(height);
      const currentHeight = Number.parseFloat(iframe.style.height) || 0;
      if (Math.abs(currentHeight - nextHeight) > 1) {
        iframe.style.height = `${nextHeight}px`;
      }
    }
  }
});

document.querySelector("[data-filter='quick-range']").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  setActive(event.currentTarget, button);
  state.range = button.dataset.value;
  state.start = "";
  state.end = "";
  resetUsagePaging();
  updateAutoGrain();
  syncRangeInputs();
  loadUsage();
});

document.querySelector("[data-filter='grain']").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  setActive(event.currentTarget, button);
  state.grainMode = button.dataset.value;
  updateAutoGrain();
  state.expandedUsageKey = "";
  state.expandedRankingKey = "";
  loadUsage();
});

participantFilter.addEventListener("change", () => {
  state.participantId = participantFilter.value;
  syncAdminParticipantSelect();
  resetUsagePaging();
  loadUsage();
});

function syncAdminParticipantSelect() {
  const trigger = document.querySelector("#participant-filter-trigger");
  const menu = document.querySelector("#participant-filter-menu");
  const valueEl = trigger?.querySelector(".atl-select-value");
  if (!trigger || !menu || !valueEl) return;

  const selected = participantFilter.options[participantFilter.selectedIndex] || participantFilter.options[0];
  valueEl.textContent = selected?.textContent || "";
  valueEl.removeAttribute("data-i18n");
  menu.innerHTML = [...participantFilter.options].map((option) => {
    const isSelected = option.value === participantFilter.value;
    return `<li class="atl-select-option${isSelected ? " is-selected" : ""}" role="option" data-value="${escapeHtml(option.value)}" aria-selected="${isSelected ? "true" : "false"}">${escapeHtml(option.textContent)}</li>`;
  }).join("");
}

function setAdminParticipantSelectOpen(open) {
  const wrap = document.querySelector("[data-admin-participant-select]");
  const trigger = document.querySelector("#participant-filter-trigger");
  const menu = document.querySelector("#participant-filter-menu");
  if (!wrap || !trigger || !menu) return;
  wrap.classList.toggle("is-open", open);
  trigger.setAttribute("aria-expanded", open ? "true" : "false");
  menu.hidden = !open;
}

function initAdminParticipantSelect() {
  const wrap = document.querySelector("[data-admin-participant-select]");
  const trigger = document.querySelector("#participant-filter-trigger");
  const menu = document.querySelector("#participant-filter-menu");
  if (!wrap || !trigger || !menu) return;

  trigger.addEventListener("click", () => setAdminParticipantSelectOpen(menu.hidden));
  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-value]");
    if (!option) return;
    const nextValue = option.getAttribute("data-value") || "";
    if (participantFilter.value !== nextValue) {
      participantFilter.value = nextValue;
      participantFilter.dispatchEvent(new Event("change", { bubbles: true }));
    }
    setAdminParticipantSelectOpen(false);
    trigger.focus();
  });
  document.addEventListener("click", (event) => {
    if (!wrap.contains(event.target)) setAdminParticipantSelectOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setAdminParticipantSelectOpen(false);
  });
  syncAdminParticipantSelect();
}

initAdminParticipantSelect();

function applyCustomRangeFromInputs() {
  const start = document.querySelector("#start-date").value;
  const end = document.querySelector("#end-date").value;
  if (start && end && start > end) {
    rankingStatus.textContent = t("admin.usage.invalidRange");
    statusEl.textContent = t("admin.usage.invalidRange");
    return;
  }
  state.range = "custom";
  state.start = start;
  state.end = end;
  state.customRangePending = false;
  document.querySelectorAll("[data-filter='quick-range'] button").forEach((item) => item.classList.remove("active"));
  resetUsagePaging();
  updateAutoGrain();
  syncRangeInputs();
  loadUsage();
}

document.querySelector("#apply-custom-range").addEventListener("click", applyCustomRangeFromInputs);

document.querySelector("#start-date").addEventListener("change", applyCustomRangeFromInputs);
document.querySelector("#end-date").addEventListener("change", applyCustomRangeFromInputs);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !detailBoard.hidden) closeDetail();
});

document.querySelector("#raw-tokens").addEventListener("change", (event) => {
  state.rawTokens = event.target.checked;
  persistPreference(storageKeys.rawTokens, state.rawTokens);
  applyToggleState();
  loadUsage();
});

document.querySelector("#show-cost").addEventListener("change", (event) => {
  state.showCost = event.target.checked;
  persistPreference(storageKeys.showCost, state.showCost);
  applyToggleState();
  loadUsage();
});

rankingPrev.addEventListener("click", () => {
  if (state.rankingPage <= 1) return;
  state.rankingPage -= 1;
  loadUsage();
});

rankingNext.addEventListener("click", () => {
  state.rankingPage += 1;
  loadUsage();
});

document.querySelector("#close-admin-detail").addEventListener("click", closeDetail);
detailBackdrop.addEventListener("click", closeDetail);

document.querySelector("#export-csv").addEventListener("click", () => {
  exportCsv().catch((error) => {
    statusEl.textContent = error.message;
  });
});

document.querySelector("#pricing-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  pricingStatus.textContent = t("admin.saving");
  const body = {
    model: document.querySelector("#price-model").value,
    inputCostPerMTok: document.querySelector("#price-input").value,
    outputCostPerMTok: document.querySelector("#price-output").value,
    cacheReadCostPerMTok: document.querySelector("#price-cache-read").value,
    cacheWriteCostPerMTok: document.querySelector("#price-cache-write").value,
    source: "admin"
  };
  const response = await fetchAdmin("/api/admin/model-prices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error((await response.json()).error || t("admin.error.savePrice"));
  event.target.reset();
  await loadPricing();
  await loadUsage();
});

document.querySelector("#refresh-openrouter").addEventListener("click", () => refreshOpenRouter(false));
document.querySelector("#refresh-openrouter-recalculate").addEventListener("click", () => refreshOpenRouter(true));

async function refreshOpenRouter(recalculate) {
  pricingStatus.textContent = recalculate ? t("admin.refreshingRecalc") : t("admin.refreshing");
  const response = await fetchAdmin(`/api/admin/model-prices/refresh-openrouter?recalculate=${recalculate ? "1" : "0"}`, { method: "POST" });
  if (!response.ok) throw new Error((await response.json()).error || t("admin.error.refreshOpenRouter"));
  invalidateQualityCache();
  await loadPricing();
  if (recalculate) await loadUsage();
  else await refreshQualityIfActive();
}

async function exportCsv() {
  const btn = document.querySelector("#export-csv");
  btn.disabled = true;
  btn.textContent = t("admin.usage.exportingCsv");
  try {
    const response = await fetchAdmin(`/api/admin/export/csv?${queryString()}`);
    if (!response.ok) throw new Error(t("admin.error.exportCsv"));
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = buildExportFilename();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } finally {
    btn.disabled = false;
    btn.textContent = t("admin.usage.exportCsv");
  }
}

function buildExportFilename() {
  const { start, end } = selectedRange();
  const participant = participantFilter.value
    ? (participantFilter.selectedOptions[0]?.textContent || "participant").trim()
    : "all-users";
  const safeParticipant = participant.replace(/[^\w\u4e00-\u9fff-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "all-users";
  const rangePart = state.range === "custom" ? `${start || "start"}_${end || "end"}` : state.range;
  return `usage-${rangePart}-${safeParticipant}.csv`;
}

async function loadUsage() {
  setAdminPanelBusy("usage", true);
  try {
    invalidateQualityCache();
    updateAutoGrain();
    syncRangeInputs();
    if (state.usageView === "ranking") {
      rankingStatus.textContent = t("admin.loading");
      const rankingResponse = await fetchAdmin(`/api/admin/usage-ranking?${rankingQueryString()}`);
      const ranking = await rankingResponse.json();
      renderParticipantOptions(ranking.participants || []);
      renderRanking(ranking);
    } else {
      statusEl.textContent = t("admin.loading");
      const response = await fetchAdmin(`/api/admin/usage?${queryString()}`);
      const data = await response.json();
      renderParticipantOptions(data.participants || []);
      render(data.items || []);
      statusEl.textContent = t("admin.usage.rows", { count: data.items.length, plural: data.items.length === 1 ? "" : "s", from: data.from || "-", to: data.to || "-" });
    }
    await refreshQualityIfActive();
  } finally {
    setAdminPanelBusy("usage", false);
  }
}

async function loadDevices() {
  setAdminPanelBusy("devices", true);
  try {
    const response = await fetchAdmin("/api/admin/devices");
    const data = await response.json();
    renderDevices(data);
  } finally {
    setAdminPanelBusy("devices", false);
  }
}

function renderDevices(devices) {
  const statusEl = document.querySelector("#devices-status");
  const tbody = document.querySelector("#devices-tbody");
  statusEl.textContent = devices.length === 1 ? t("admin.devices.countOne") : t("admin.devices.count", { count: devices.length });
  if (!devices.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="7">${t("admin.devices.empty")}</td></tr>`;
    return;
  }
  tbody.innerHTML = devices.map((item) => `<tr>
    <td>${escapeHtml(item.nickname)}</td>
    <td><span class="pill device-id-chip" title="${escapeHtml(item.deviceId)}">${escapeHtml(String(item.deviceId || "").slice(-8))}</span></td>
    <td><span class="truncated-cell" title="${escapeHtml(item.lanIp || "-")}">${escapeHtml(item.lanIp || "-")}</span></td>
    <td>${escapeHtml(item.clientAppVersion || "-")}</td>
    <td>${escapeHtml(item.clientPlatform || item.os || "-")}</td>
    <td>${escapeHtml(item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleDateString() : "-")}</td>
    <td>
      <div class="row-actions danger-actions">
        <button type="button" class="danger-link" data-delete-device="${escapeHtml(item.deviceId)}" data-delete-device-label="${escapeHtml(item.nickname || item.deviceId)}">${t("admin.devices.resetDevice")}</button>
        <button type="button" class="danger-link" data-delete-participant="${escapeHtml(item.participantId)}" data-delete-nickname="${escapeHtml(item.nickname)}">${t("admin.usage.clearUserData")}</button>
      </div>
    </td>
  </tr>`).join("");
  tbody.querySelectorAll("[data-delete-device]").forEach((button) => {
    button.addEventListener("click", () => {
      deleteDeviceData(button.dataset.deleteDevice, button.dataset.deleteDeviceLabel).catch((error) => {
        statusEl.textContent = error.message;
      });
    });
  });
  tbody.querySelectorAll("[data-delete-participant]").forEach((button) => {
    button.addEventListener("click", () => {
      deleteParticipantData(button.dataset.deleteParticipant, button.dataset.deleteNickname, { statusElement: statusEl }).catch((error) => {
        statusEl.textContent = error.message;
      });
    });
  });
}

async function deleteDeviceData(deviceId, label) {
  const displayLabel = label || deviceId;
  const confirmed = window.confirm(t("admin.devices.deleteConfirm", { label: displayLabel, deviceId }));
  if (!confirmed) return;
  const statusEl = document.querySelector("#devices-status");
  statusEl.textContent = t("admin.devices.deletingDevice", { label: displayLabel });
  const response = await fetchAdmin(`/api/admin/devices/${encodeURIComponent(deviceId)}/data`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || t("admin.error.deleteDevice"));
  await loadDevices();
  await loadUsage();
  await loadPricing();
}

async function loadPricing() {
  setAdminPanelBusy("pricing", true);
  try {
    const response = await fetchAdmin("/api/admin/model-prices");
    const data = await response.json();
    renderPricing(data);
  } finally {
    setAdminPanelBusy("pricing", false);
  }
}

function renderPricing(data) {
  const missing = data.missingModels || [];
  const custom = data.custom || [];
  const openrouter = data.openrouter || [];
  const aliases = data.aliases || [];
  const priceTargets = [...custom, ...openrouter]
    .map((item) => item.model)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const missingTotal = missing.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);
  pricingStatus.textContent = t("admin.pricing.missingModels", { missing: missing.length, p1: missing.length === 1 ? "" : "s", aliases: aliases.length, p2: aliases.length === 1 ? "" : "es", custom: custom.length, p3: custom.length === 1 ? "" : "s", openrouter: openrouter.length, p4: openrouter.length === 1 ? "" : "s" });
  const costMissingCount = document.querySelector("#admin-cost-missing-count");
  if (costMissingCount) {
    costMissingCount.textContent = missing.length
      ? t("admin.cost.missingCountShort", { count: missing.length })
      : "";
  }
  const missingCountBadge = document.querySelector("#missing-prices-count");
  if (missingCountBadge) {
    missingCountBadge.hidden = !missing.length;
    missingCountBadge.textContent = missing.length ? t("admin.pricing.missingCount", { count: missing.length }) : "";
  }
  document.querySelector("#remote-pricing-status").innerHTML = renderRemotePricingStatus(data.remote || {});
  document.querySelector("#missing-prices").innerHTML = missing.length
    ? missing
        .map((item, index) => `<article class="price-suggestion price-task price-alias-task" data-fill-price-model="${escapeHtml(item.model)}" title="${escapeHtml(renderProviderTitle(item.providers))}">
          <span class="task-rank">#${index + 1}</span>
          <strong>${escapeHtml(item.model)}</strong>
          <span>${formatToken(item.totalTokens)} · ${formatPercent(ratio(item.totalTokens, missingTotal))}</span>
          <small>${escapeHtml(renderProviderTitle(item.providers) || t("admin.pricing.noSourceBreakdown"))}</small>
          <input data-alias-target="${escapeHtml(item.model)}" data-price-target-picker role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="price-target-menu" data-i18n-placeholder="admin.pricing.mapToExisting" placeholder="${escapeHtml(t("admin.pricing.mapToExisting"))}" autocomplete="off" />
          <button type="button" data-map-price-alias="${escapeHtml(item.model)}" ${priceTargets.length ? "" : "disabled"}>${t("admin.pricing.map")}</button>
        </article>`)
        .join("")
    : `<article class="empty-state">${t("admin.pricing.noMissing")}</article>`;
  syncMissingPricesCollapse();
  bindPriceTargetPickers(priceTargets);
  document.querySelectorAll("[data-fill-price-model]").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("input, button, select, textarea, a")) return;
      fillPriceModel(card.dataset.fillPriceModel);
    });
  });
  document.querySelectorAll("[data-map-price-alias]").forEach((button) => {
    button.addEventListener("click", async () => {
      const model = button.dataset.mapPriceAlias;
      const input = [...document.querySelectorAll("[data-alias-target]")]
        .find((item) => item.dataset.aliasTarget === model);
      const target = (input?.value || "").trim();
      if (!target) {
        flagPriceTargetInput(input, t("admin.pricing.targetRequired"));
        return;
      }
      button.disabled = true;
      const originalLabel = button.textContent;
      button.textContent = t("admin.mappingAlias");
      try {
        await mapModelPriceAlias(model, target);
      } catch (error) {
        pricingStatus.textContent = error.message;
        flagPriceTargetInput(input, error.message);
        button.disabled = false;
        button.textContent = originalLabel;
      }
    });
  });
  pricingLibraryData = { custom, aliases, openrouter };
  renderPricingLibraries();
}

function renderPricingLibraries() {
  for (const type of ["custom", "aliases", "openrouter"]) {
    const search = document.querySelector(`[data-pricing-search="${type}"]`);
    renderPricingLibrary(type, search?.value || "");
  }
}

function renderPricingLibrary(type, query = "") {
  const config = {
    custom: {
      container: "#custom-prices",
      count: "#custom-prices-count",
      empty: "admin.pricing.noCustom"
    },
    aliases: {
      container: "#price-aliases",
      count: "#price-aliases-count",
      empty: "admin.pricing.noAliases"
    },
    openrouter: {
      container: "#openrouter-prices",
      count: "#openrouter-prices-count",
      empty: "admin.pricing.noOpenRouter"
    }
  }[type];
  if (!config) return;
  const container = document.querySelector(config.container);
  const count = document.querySelector(config.count);
  if (!container) return;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const allItems = pricingLibraryData[type] || [];
  const filtered = allItems.filter((item) => {
    const searchable = type === "aliases" ? `${item.model} ${item.targetModel}` : item.model;
    return !normalizedQuery || searchable.toLocaleLowerCase().includes(normalizedQuery);
  });
  const visible = filtered.slice(0, 100);
  if (count) count.textContent = normalizedQuery ? `${filtered.length}/${allItems.length}` : String(allItems.length);
  if (!visible.length) {
    container.innerHTML = `<article class="empty-state">${t(normalizedQuery ? "admin.pricing.noSearchResults" : config.empty)}</article>`;
    return;
  }
  container.innerHTML = visible.map((item) => renderPricingLibraryRow(type, item)).join("");
  bindPricingLibraryActions(container);
}

function renderPricingLibraryRow(type, item) {
  if (type === "aliases") {
    return `<article class="price-row price-library-row">
      <div class="price-row-copy">
        <strong title="${escapeHtml(item.model)}">${escapeHtml(item.model)}</strong>
        <span class="price-alias-target">${t("admin.pricing.aliasUses", { target: escapeHtml(item.targetModel) })}</span>
      </div>
      <button type="button" data-delete-price-alias="${escapeHtml(item.model)}">${t("admin.pricing.delete")}</button>
    </article>`;
  }
  const action = type === "custom"
    ? `<button type="button" data-delete-price="${escapeHtml(item.model)}">${t("admin.pricing.delete")}</button>`
    : "";
  return `<article class="price-row price-library-row">
    <div class="price-row-copy">
      <strong title="${escapeHtml(item.model)}">${escapeHtml(item.model)}</strong>
      <span>${t("admin.pricing.priceLine", { input: formatUsdPerMillion(item.inputCostPerMTok), output: formatUsdPerMillion(item.outputCostPerMTok), cacheRead: formatUsdPerMillion(item.cacheReadCostPerMTok) })}</span>
    </div>
    ${action}
  </article>`;
}

function bindPricingLibraryActions(container) {
  container.querySelectorAll("[data-delete-price]").forEach((button) => {
    button.addEventListener("click", async () => {
      pricingStatus.textContent = t("admin.deleting");
      button.disabled = true;
      await fetchAdmin(`/api/admin/model-prices/${encodeURIComponent(button.dataset.deletePrice)}`, { method: "DELETE" });
      await loadPricing();
      await loadUsage();
    });
  });
  container.querySelectorAll("[data-delete-price-alias]").forEach((button) => {
    button.addEventListener("click", async () => {
      pricingStatus.textContent = t("admin.deletingAlias");
      button.disabled = true;
      await fetchAdmin(`/api/admin/model-price-aliases/${encodeURIComponent(button.dataset.deletePriceAlias)}`, { method: "DELETE" });
      await loadPricing();
      await loadUsage();
    });
  });
}

function flagPriceTargetInput(input, message) {
  if (!input) return;
  input.classList.add("is-invalid");
  if (message) input.setAttribute("title", message);
  input.focus();
  window.setTimeout(() => input.classList.remove("is-invalid"), 1600);
}

function ensurePriceTargetMenu() {
  if (priceTargetMenu) return priceTargetMenu;
  priceTargetMenu = document.createElement("ul");
  priceTargetMenu.id = "price-target-menu";
  priceTargetMenu.className = "atl-select-menu price-target-menu";
  priceTargetMenu.setAttribute("role", "listbox");
  priceTargetMenu.hidden = true;
  document.body.appendChild(priceTargetMenu);

  priceTargetMenu.addEventListener("mousedown", (event) => {
    const option = event.target.closest("[data-price-target]");
    if (!option || !activePriceTargetInput) return;
    event.preventDefault();
    activePriceTargetInput.value = option.dataset.priceTarget || "";
    activePriceTargetInput.dispatchEvent(new Event("input", { bubbles: true }));
    closePriceTargetMenu({ restoreFocus: true });
  });
  document.addEventListener("mousedown", (event) => {
    if (priceTargetMenu.hidden || priceTargetMenu.contains(event.target) || event.target === activePriceTargetInput) return;
    closePriceTargetMenu();
  });
  window.addEventListener("resize", () => closePriceTargetMenu());
  window.addEventListener("scroll", (event) => {
    if (event.target === priceTargetMenu || priceTargetMenu.contains(event.target)) return;
    closePriceTargetMenu();
  }, true);
  return priceTargetMenu;
}

function bindPriceTargetPickers(options) {
  priceTargetOptions = [...new Set(options)].sort((a, b) => a.localeCompare(b));
  ensurePriceTargetMenu();
  document.querySelectorAll("[data-price-target-picker]").forEach((input) => {
    input.addEventListener("focus", () => openPriceTargetMenu(input));
    input.addEventListener("input", () => openPriceTargetMenu(input));
    input.addEventListener("keydown", handlePriceTargetKeydown);
    input.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (document.activeElement !== activePriceTargetInput) closePriceTargetMenu();
      }, 0);
    });
  });
}

function openPriceTargetMenu(input) {
  const menu = ensurePriceTargetMenu();
  if (activePriceTargetInput && activePriceTargetInput !== input) {
    activePriceTargetInput.setAttribute("aria-expanded", "false");
  }
  activePriceTargetInput = input;
  const query = input.value.trim().toLocaleLowerCase();
  filteredPriceTargetOptions = priceTargetOptions
    .filter((model) => !query || model.toLocaleLowerCase().includes(query))
    .slice(0, 80);
  activePriceTargetIndex = -1;
  input.setAttribute("aria-expanded", filteredPriceTargetOptions.length ? "true" : "false");
  if (!filteredPriceTargetOptions.length) {
    menu.hidden = true;
    return;
  }
  menu.innerHTML = filteredPriceTargetOptions.map((model, index) =>
    `<li id="price-target-option-${index}" class="atl-select-option" role="option" data-price-target="${escapeHtml(model)}">${escapeHtml(model)}</li>`
  ).join("");
  menu.hidden = false;
  positionPriceTargetMenu(input);
}

function positionPriceTargetMenu(input) {
  if (!priceTargetMenu || priceTargetMenu.hidden) return;
  const rect = input.getBoundingClientRect();
  const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 16);
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  priceTargetMenu.style.width = `${width}px`;
  priceTargetMenu.style.left = `${left}px`;
  priceTargetMenu.style.top = `${rect.bottom + 6}px`;
  const menuHeight = priceTargetMenu.getBoundingClientRect().height;
  if (rect.bottom + 6 + menuHeight > window.innerHeight - 8 && rect.top > menuHeight + 14) {
    priceTargetMenu.style.top = `${rect.top - menuHeight - 6}px`;
  }
}

function handlePriceTargetKeydown(event) {
  if (!activePriceTargetInput || event.currentTarget !== activePriceTargetInput) return;
  if (event.key === "Escape") {
    closePriceTargetMenu();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
  if (priceTargetMenu.hidden) openPriceTargetMenu(event.currentTarget);
  if (!filteredPriceTargetOptions.length) return;
  event.preventDefault();
  if (event.key === "Enter" && activePriceTargetIndex >= 0) {
    event.currentTarget.value = filteredPriceTargetOptions[activePriceTargetIndex];
    event.currentTarget.dispatchEvent(new Event("input", { bubbles: true }));
    closePriceTargetMenu({ restoreFocus: true });
    return;
  }
  const step = event.key === "ArrowUp" ? -1 : 1;
  activePriceTargetIndex = (activePriceTargetIndex + step + filteredPriceTargetOptions.length) % filteredPriceTargetOptions.length;
  priceTargetMenu.querySelectorAll(".atl-select-option").forEach((option, index) => {
    option.classList.toggle("is-selected", index === activePriceTargetIndex);
  });
  const activeOption = priceTargetMenu.querySelector(`#price-target-option-${activePriceTargetIndex}`);
  event.currentTarget.setAttribute("aria-activedescendant", activeOption?.id || "");
  activeOption?.scrollIntoView({ block: "nearest" });
}

function closePriceTargetMenu({ restoreFocus = false } = {}) {
  if (!priceTargetMenu) return;
  const input = activePriceTargetInput;
  priceTargetMenu.hidden = true;
  priceTargetMenu.innerHTML = "";
  input?.setAttribute("aria-expanded", "false");
  input?.removeAttribute("aria-activedescendant");
  activePriceTargetInput = null;
  filteredPriceTargetOptions = [];
  activePriceTargetIndex = -1;
  if (restoreFocus) input?.focus();
}

function fillPriceModel(model) {
  const priceModel = document.querySelector("#price-model");
  const priceInput = document.querySelector("#price-input");
  priceModel.value = model || "";
  priceModel.dispatchEvent(new Event("input", { bubbles: true }));
  priceInput.focus({ preventScroll: true });
}

async function mapModelPriceAlias(model, targetModel) {
  if (!targetModel.trim()) throw new Error(t("admin.pricing.targetRequired"));
  pricingStatus.textContent = t("admin.mappingAlias");
  const response = await fetchAdmin("/api/admin/model-price-aliases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, targetModel })
  });
  if (!response.ok) throw new Error((await response.json()).error || t("admin.error.saveAlias"));
  await loadPricing();
  await loadUsage();
}

function renderRemotePricingStatus(remote) {
  const status = remote.status || "empty";
  const fetchedAt = remote.fetchedAt || "-";
  const expiresAt = remote.expiresAt || "-";
  const count = remote.modelCount || 0;
  const error = remote.lastError ? ` · ${escapeHtml(remote.lastError)}` : "";
  return `<strong>${t("admin.pricing.openrouterStatus", { status: escapeHtml(status) })}</strong><span>${t("admin.pricing.openrouterDetail", { count, fetched: escapeHtml(fetchedAt), expires: escapeHtml(expiresAt) })}${error}</span>`;
}

function renderParticipantOptions(participants) {
  const current = participantFilter.value;
  participantFilter.innerHTML = `<option value="">${t("admin.usage.allUsers")}</option>${participants
    .map((item) => `<option value="${escapeHtml(item.participantId)}">${escapeHtml(item.nickname)}</option>`)
    .join("")}`;
  participantFilter.value = current;
  syncAdminParticipantSelect();
}

function renderRanking(data) {
  const items = data.items || [];
  state.rankingPage = data.page || state.rankingPage;
  rankingPrev.disabled = !data.hasPrev;
  rankingNext.disabled = !data.hasNext;
  rankingPageLabel.textContent = t("admin.usage.pageLabel", { page: data.page || 1, totalPages: data.totalPages || 1 });
  rankingStatus.textContent = t("admin.usage.rankingRows", {
    count: data.total || 0,
    plural: data.total === 1 ? "" : "s",
    from: data.from || "-",
    to: data.to || "-"
  });
  if (!items.length) {
    rankingTbody.innerHTML = `<tr><td class="empty" colspan="8">${t("admin.usage.noUsage")}</td></tr>`;
    return;
  }
  rankingTbody.innerHTML = items
    .map((item) => {
      const key = rankingRowKey(item);
      const expanded = state.expandedRankingKey === key;
      return `<tr>
      <td><span class="rank">#${item.rank}</span></td>
      <td><button class="link-button" data-ranking-participant="${escapeHtml(item.participantId)}">${escapeHtml(item.nickname)}</button></td>
      <td class="tokens" title="${escapeHtml(deviceTokenTooltip(item))}">${formatToken(item.totalTokens)}</td>
      <td class="cost-col" ${state.showCost ? "" : "hidden"}>${renderCostQuality(item)}</td>
      <td>${renderPrimarySlice(item.workdirs)}</td>
      <td>${renderPrimarySlice(item.models)}</td>
      <td>${renderPrimarySource(item.providers)}</td>
      <td>
        <div class="row-actions">
          <button type="button" class="link-button" data-expand-ranking-row="${escapeHtml(key)}">${expanded ? t("admin.usage.collapseRow") : t("admin.usage.expandRow")}</button>
          <button type="button" class="link-button" data-ranking-detail="${escapeHtml(item.participantId)}">${t("admin.usage.viewDetail")}</button>
        </div>
      </td>
    </tr>
    ${expanded ? `<tr class="expanded-row"><td colspan="8">${renderExpandedUsage(item)}</td></tr>` : ""}`;
    })
    .join("");
  rankingTbody.querySelectorAll("[data-ranking-participant], [data-ranking-detail]").forEach((button) => {
    button.addEventListener("click", () => {
      loadDetail(button.dataset.rankingParticipant || button.dataset.rankingDetail);
    });
  });
  rankingTbody.querySelectorAll("[data-expand-ranking-row]").forEach((button) => {
    button.addEventListener("click", () => {
      state.expandedRankingKey = state.expandedRankingKey === button.dataset.expandRankingRow ? "" : button.dataset.expandRankingRow;
      renderRanking(data);
    });
  });
  bindCostQualityActions(rankingTbody);
}

function render(items) {
  if (!items.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="8">${t("admin.usage.noUsage")}</td></tr>`;
    return;
  }
  tbody.innerHTML = items
    .map((item) => {
      const key = usageRowKey(item);
      const expanded = state.expandedUsageKey === key;
      return `<tr>
        <td>${formatPeriod(item)}</td>
        <td><button class="link-button" data-participant="${escapeHtml(item.participantId)}" data-period-start="${escapeHtml(item.periodStart)}" data-period-end="${escapeHtml(item.periodEnd)}">${escapeHtml(item.nickname)}</button></td>
        <td class="tokens" title="${formatTokenRaw(item.totalTokens)}">${formatToken(item.totalTokens)}</td>
        <td class="cost-col" ${state.showCost ? "" : "hidden"}>${renderCostQuality(item)}</td>
        <td>${renderPrimarySlice(item.workdirs)}</td>
        <td>${renderPrimarySlice(item.models)}</td>
        <td>${renderPrimarySource(item.providers)}</td>
        <td>
          <div class="row-actions">
            <button type="button" class="link-button" data-expand-row="${escapeHtml(key)}">${expanded ? t("admin.usage.collapseRow") : t("admin.usage.expandRow")}</button>
          </div>
        </td>
      </tr>
      ${expanded ? `<tr class="expanded-row"><td colspan="8">
        ${renderExpandedUsage(item)}
      </td></tr>` : ""}`;
    })
    .join("");
  tbody.querySelectorAll("[data-participant]").forEach((button) => {
    button.addEventListener("click", () => {
      loadDetail(button.dataset.participant, {
        start: button.dataset.periodStart,
        end: button.dataset.periodEnd
      });
    });
  });
  tbody.querySelectorAll("[data-expand-row]").forEach((button) => {
    button.addEventListener("click", () => {
      state.expandedUsageKey = state.expandedUsageKey === button.dataset.expandRow ? "" : button.dataset.expandRow;
      render(items);
    });
  });
  bindCostQualityActions(tbody);
}

async function deleteParticipantData(participantId, nickname, { statusElement = statusEl } = {}) {
  const label = nickname || participantId;
  const typed = window.prompt(t("admin.usage.clearConfirmTyped", { label }));
  if (typed === null) return;
  if (typed.trim() !== label) {
    statusElement.textContent = t("admin.usage.clearConfirmMismatch");
    return;
  }
  statusElement.textContent = t("admin.usage.deletingUser", { label });
  const response = await fetchAdmin(`/api/admin/participants/${encodeURIComponent(participantId)}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || t("admin.error.deleteParticipant"));
  if (state.participantId === participantId) state.participantId = "";
  state.expandedUsageKey = "";
  state.expandedRankingKey = "";
  await loadDevices();
  await loadUsage();
  await loadPricing();
  statusElement.textContent = result.deleted
    ? t("admin.usage.deleted", { label, usage: result.removed.usageDaily || 0, batches: result.removed.uploadBatches || 0 })
    : t("admin.usage.noData", { label });
}

async function loadDetail(participantId, rowRange = null) {
  if (detailCloseTimer) clearTimeout(detailCloseTimer);
  detailTrigger = document.activeElement;
  detailBoard.hidden = false;
  detailBackdrop.hidden = false;
  requestAnimationFrame(() => {
    detailBoard.classList.add("is-open");
    detailBackdrop.classList.add("is-open");
    document.body.classList.add("detail-open");
    document.querySelector("#close-admin-detail")?.focus({ preventScroll: true });
  });
  document.querySelector("#detail-status").textContent = t("admin.loading");
  const detailRange = normalizeDetailRange(rowRange);
  const response = await fetchAdmin(`/api/admin/participants/${encodeURIComponent(participantId)}?${detailQueryString(detailRange)}`);
  const detail = await response.json();
  const detailLabel = detailRange ? formatPeriodRange(detailRange.start, detailRange.end) : selectedRange().label;
  document.querySelector("#detail-title").textContent = `${detail.nickname} · ${detailLabel}`;
  document.querySelector("#detail-status").textContent = `${formatPeriodRange(detail.from, detail.to)} · ${state.grain} ${t("admin.detail.grain")} · ${detail.rows?.length || 0} ${t("admin.detail.rawRows")}`;
  document.querySelector("#detail-summary").innerHTML = renderDetailSummary(detail);
  document.querySelector("#detail-composition").innerHTML = renderCompositionBlock(detail);
  document.querySelector("#detail-workdirs").innerHTML = renderBars(detail.workdirs);
  document.querySelector("#detail-days").innerHTML = renderBars((detail.periodRows || []).map((item) => ({ ...item, name: formatPeriod(item) })));
  document.querySelector("#detail-rows").innerHTML = detail.rows
    .map((row) => `<tr>
      <td>${escapeHtml(row.day)}</td>
      <td>${escapeHtml(row.workdirDisplayName)}</td>
      <td>${escapeHtml(row.model)}</td>
      <td class="tokens" title="${formatTokenRaw(row.totalTokens)}">${renderAccountingToken(row.totalTokens, row.estimatedCostUsd)}</td>
      <td class="tokens" title="${formatTokenRaw(row.inputTokens)}">${renderAccountingToken(row.inputTokens, row.inputCostUsd)}</td>
      <td class="tokens" title="${formatTokenRaw(row.outputTokens)}">${renderAccountingToken(row.outputTokens, row.outputCostUsd)}</td>
      <td class="tokens" title="${formatTokenRaw((row.cacheReadTokens || 0) + (row.cacheWriteTokens || 0))}">${renderAccountingToken((row.cacheReadTokens || 0) + (row.cacheWriteTokens || 0), sumKnownCosts(row.cacheReadCostUsd, row.cacheWriteCostUsd))}</td>
      <td class="tokens" title="${formatTokenRaw(row.reasoningTokens)}">${renderAccountingToken(row.reasoningTokens, row.reasoningCostUsd)}</td>
      ${state.showCost ? `<td>${escapeHtml(localizedCostQualityLabel(row.costQuality))}</td>` : ""}
      <td>${renderQuality(row.sourceQuality)}</td>
    </tr>`)
    .join("");
}

function activeAdminTab() {
  return document.querySelector("[data-admin-tab].active")?.dataset.adminTab || "usage";
}

function invalidateQualityCache() {
  qualityCacheKey = "";
  qualityCacheData = null;
}

async function refreshQualityIfActive() {
  if (activeAdminTab() !== "quality") return;
  invalidateQualityCache();
  await loadQuality();
}

async function loadQuality({ useCache = false } = {}) {
  setAdminPanelBusy("quality", true);
  try {
    const query = qualityQueryString();
    if (useCache && qualityCacheKey === query && qualityCacheData) {
      renderQualityBoard(qualityCacheData);
      return;
    }
    const response = await fetchAdmin(`/api/admin/quality?${query}`);
    const data = await response.json();
    qualityCacheKey = query;
    qualityCacheData = data;
    renderQualityBoard(data);
  } finally {
    setAdminPanelBusy("quality", false);
  }
}

function closeDetail() {
  detailBoard.classList.remove("is-open");
  detailBackdrop.classList.remove("is-open");
  document.body.classList.remove("detail-open");
  if (detailBoard.hidden) return;
  detailCloseTimer = setTimeout(() => {
    detailBoard.hidden = true;
    detailBackdrop.hidden = true;
    if (detailTrigger && typeof detailTrigger.focus === "function") {
      detailTrigger.focus({ preventScroll: true });
    }
    detailTrigger = null;
  }, 180);
}

function queryString() {
  const params = new URLSearchParams({
    grain: state.grain,
    range: state.range
  });
  if (state.participantId) params.set("participantId", state.participantId);
  if (state.showCost) params.set("includeCost", "1");
  if (state.range === "custom") {
    if (state.start) params.set("start", state.start);
    if (state.end) params.set("end", state.end);
  }
  return params.toString();
}

function rankingQueryString() {
  const params = new URLSearchParams({
    range: state.range,
    page: String(state.rankingPage),
    pageSize: String(state.rankingPageSize)
  });
  if (state.participantId) params.set("participantId", state.participantId);
  if (state.showCost) params.set("includeCost", "1");
  if (state.range === "custom") {
    if (state.start) params.set("start", state.start);
    if (state.end) params.set("end", state.end);
  }
  return params.toString();
}

function resetUsagePaging() {
  state.rankingPage = 1;
  state.expandedUsageKey = "";
  state.expandedRankingKey = "";
}

function switchAdminTab(tabId) {
  const button = document.querySelector(`[data-admin-tab="${tabId}"]`);
  const panel = document.querySelector(`[data-admin-panel="${tabId}"]`);
  if (!button || !panel) return;
  document.querySelectorAll("[data-admin-tab]").forEach((item) => item.classList.remove("active"));
  document.querySelectorAll("[data-admin-panel]").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  panel.classList.add("active");
  panel.classList.remove("is-entering");
  requestAnimationFrame(() => panel.classList.add("is-entering"));
  if (tabId === "quality") {
    loadQuality({ useCache: true }).catch((error) => {
      document.querySelector("#quality-status").textContent = error.message;
    });
  }
  if (tabId === "devices") {
    loadDevices().catch((error) => {
      document.querySelector("#devices-status").textContent = error.message;
    });
  }
  if (tabId === "analytics") {
    const iframe = document.querySelector("#analytics-iframe");
    if (iframe && !iframe.dataset.loaded) {
      setAdminPanelBusy("analytics", true);
      iframe.addEventListener("load", () => setAdminPanelBusy("analytics", false), { once: true });
      iframe.src = iframe.dataset.src;
      iframe.dataset.loaded = "true";
    }
  }
  if (tabId === "pricing") {
    loadPricing().catch((error) => {
      pricingStatus.textContent = error.message;
    });
  }
}

function openPricingMissingTasks() {
  switchAdminTab("pricing");
  state.missingPricesCollapsed = false;
  persistPreference(storageKeys.missingPricesCollapsed, false);
  syncMissingPricesCollapse();
  loadPricing()
    .then(() => {
      document.querySelector(".pricing-priority")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    })
    .catch((error) => {
      pricingStatus.textContent = error.message;
    });
}

function initMissingPricesToggle() {
  const toggle = document.querySelector("#missing-prices-toggle");
  if (!toggle || toggle.dataset.bound === "1") return;
  toggle.dataset.bound = "1";
  toggle.addEventListener("click", () => {
    state.missingPricesCollapsed = !state.missingPricesCollapsed;
    persistPreference(storageKeys.missingPricesCollapsed, state.missingPricesCollapsed);
    syncMissingPricesCollapse();
  });
}

function syncMissingPricesCollapse() {
  const section = document.querySelector(".pricing-priority");
  const toggle = document.querySelector("#missing-prices-toggle");
  if (!section || !toggle) return;
  const collapsed = Boolean(state.missingPricesCollapsed);
  section.classList.toggle("is-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  toggle.setAttribute("aria-label", t(collapsed ? "admin.pricing.expandTasks" : "admin.pricing.collapseTasks"));
}

function bindCostQualityActions(root) {
  if (!root) return;
  root.querySelectorAll("[data-goto-pricing]").forEach((element) => {
    element.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPricingMissingTasks();
    });
  });
}

document.querySelector("#admin-cost-status")?.addEventListener("click", openPricingMissingTasks);

function detailQueryString(rowRange = null) {
  const params = new URLSearchParams({
    grain: state.grain,
    range: rowRange ? "custom" : state.range
  });
  if (state.showCost) params.set("includeCost", "1");
  if (rowRange) {
    params.set("start", rowRange.start);
    params.set("end", rowRange.end);
  } else if (state.range === "custom") {
    if (state.start) params.set("start", state.start);
    if (state.end) params.set("end", state.end);
  }
  return params.toString();
}

function normalizeDetailRange(rowRange) {
  if (!rowRange?.start || !rowRange?.end) return null;
  return {
    start: rowRange.start,
    end: rowRange.end
  };
}

function qualityQueryString() {
  const params = new URLSearchParams({ range: state.range });
  if (state.participantId) params.set("participantId", state.participantId);
  if (state.range === "custom") {
    if (state.start) params.set("start", state.start);
    if (state.end) params.set("end", state.end);
  }
  return params.toString();
}

function setActive(group, button) {
  group.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
}

function updateAutoGrain() {
  state.grain = state.grainMode === "auto" ? autoGrain() : state.grainMode;
}

function autoGrain() {
  if (state.range === "all") return "month";
  if (state.range === "last_month") return "week";
  if (state.range === "custom") {
    const span = daySpan(state.start, state.end);
    if (span > 120) return "month";
    if (span > 31) return "week";
  }
  return "day";
}

function hydratePreferences() {
  state.rawTokens = readBooleanPreference(storageKeys.rawTokens, false);
  state.showCost = readBooleanPreference(storageKeys.showCost, false);
  state.missingPricesCollapsed = readBooleanPreference(storageKeys.missingPricesCollapsed, false);
}

function applyToggleState() {
  document.querySelector("#raw-tokens").checked = state.rawTokens;
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

function syncRangeInputs() {
  const startInput = document.querySelector("#start-date");
  const endInput = document.querySelector("#end-date");
  if (state.range === "custom") {
    startInput.value = state.start || "";
    endInput.value = state.end || "";
    state.customRangePending = false;
  } else if (!state.customRangePending) {
    const { start, end } = selectedRange();
    startInput.value = start;
    endInput.value = end;
  }
  const applyButton = document.querySelector("#apply-custom-range");
  if (applyButton) {
    applyButton.classList.toggle("is-pending", state.customRangePending);
    applyButton.setAttribute("aria-label", state.customRangePending ? t("admin.usage.pendingRange") : t("admin.usage.apply"));
  }
  const pendingHint = document.querySelector("#range-pending-hint");
  if (pendingHint) pendingHint.hidden = !state.customRangePending;
}

function selectedRange() {
  if (state.range === "custom") {
    return { start: state.start || "", end: state.end || "", label: `${state.start || "-"} - ${state.end || "-"}` };
  }
  if (state.range === "all") return { start: "", end: "", label: t("admin.usage.allTime") };
  const today = utcToday();
  if (state.range === "today") return { start: toDay(today), end: toDay(today), label: t("admin.usage.today") };
  if (state.range === "last7") return trailingRange(7, t("admin.usage.last7"));
  if (state.range === "last30") return trailingRange(30, t("admin.usage.last30"));
  if (state.range === "last_month") return monthRange(-1, t("admin.usage.lastMonth"));
  return monthRange(0, t("admin.usage.mtd"));
}

function grainLabel(value) {
  return {
    day: t("admin.usage.grainDay"),
    week: t("admin.usage.grainWeek"),
    month: t("admin.usage.grainMonth")
  }[value] || t("admin.usage.grainAuto");
}

function trailingRange(count, label) {
  const end = utcToday();
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - count + 1);
  return { start: toDay(start), end: toDay(end), label };
}

function monthRange(offset, label) {
  const today = utcToday();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + offset, 1));
  const end = offset === 0 ? today : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return { start: toDay(start), end: toDay(end), label };
}

function daySpan(start, end) {
  if (!start || !end) return 0;
  return Math.max(1, Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000) + 1);
}

function utcToday() {
  return dayToUtcDate(localDay());
}

function toDay(date) {
  return utcDateToDay(date);
}

function localDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dayToUtcDate(day) {
  const [year, month, date] = String(day || "").split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date));
}

function utcDateToDay(date) {
  return date.toISOString().slice(0, 10);
}

function renderBars(items = []) {
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  return items
    .map((item) => `<div class="bar-row" title="${escapeHtml(chartItemTitle(item))}">
      <span>${escapeHtml(item.name)}</span>
      <strong title="${escapeHtml(chartItemTitle(item))}">${formatToken(item.totalTokens)}${state.showCost ? ` · ${renderCost(item)}` : ""}</strong>
      <i style="width:${Math.max(3, (item.totalTokens / max) * 100)}%"></i>
    </div>`)
    .join("");
}

function renderExpandedUsage(item) {
  return `<div class="detail-grid usage-expanded-grid">
    <section>
      <h3>${t("admin.detail.compositionDetail")}</h3>
      ${renderCompositionBlock(item)}
    </section>
    <section>
      <h3>${t("admin.detail.topSlices")}</h3>
      <p>${escapeHtml(localizedCompositionSummary(item))}</p>
      <p>${t("admin.detail.modelsLabel")} ${escapeHtml(renderBreakdownText(item.models))}</p>
      <p>${t("admin.detail.workdirsLabel")} ${escapeHtml(renderBreakdownText(item.workdirs))}</p>
      <p>${t("admin.detail.sourcesLabel")} ${escapeHtml(renderBreakdownText(item.providers))}</p>
      <p>${t("admin.detail.pricingLabel")} ${escapeHtml(localizedCostQualityLabel(item.costQuality))}${state.showCost ? ` · ${stripHtml(renderCost(item))}` : ""}</p>
      <p>${t("admin.detail.sourceQuality")} ${stripHtml(renderQuality(item.sourceQuality))}</p>
    </section>
  </div>`;
}

function renderDetailSummary(detail) {
  const items = [
    [t("admin.detail.total"), formatToken(detail.totalTokens), formatTokenRaw(detail.totalTokens)],
    [t("admin.detail.workdirs"), String(detail.workdirs?.length || 0)],
    [t("admin.detail.models"), String(detail.models?.length || 0)]
  ];
  if (state.showCost) items.push([t("admin.detail.estCost"), renderCost(detail), costTitle(detail)]);
  return items.map(([label, value, title]) => `<article class="summary-tile"${title ? ` title="${escapeHtml(title)}"` : ""}>
    <span>${escapeHtml(label)}</span>
    <strong class="${summaryValueClass(value)}">${value}</strong>
  </article>`).join("");
}

function renderCompositionBlock(item) {
  const rows = tokenCompositionDetails(item)
    .map((entry) => `<article class="summary-tile composition-tile">
      <span>${escapeHtml(compositionFieldLabel(entry.field))}</span>
      <strong title="${formatTokenRaw(entry.tokens)}">${formatToken(entry.tokens)}</strong>
      <small>${Math.round(entry.ratio * 100)}%</small>
      ${state.showCost ? `<small><span class="cost-amount">${escapeHtml(formatCost(costValueForField(item, entry.field)))}</span></small>` : ""}
    </article>`)
    .join("");
  return `<div class="detail-summary composition-grid">${rows}</div>`;
}

function localizedCompositionSummary(item = {}) {
  const total = Number(item.totalTokens || 0);
  if (!total) return t("web.composition.noUsage");
  const parts = [
    [t("admin.detail.input"), item.inputTokens],
    [t("admin.detail.output"), item.outputTokens],
    [t("admin.detail.cache"), Number(item.cacheReadTokens || 0) + Number(item.cacheWriteTokens || 0)],
    [t("admin.detail.reasoning"), item.reasoningTokens]
  ];
  return parts
    .filter(([, value]) => Number(value || 0) > 0)
    .map(([label, value]) => `${label} ${Math.round((Number(value || 0) / total) * 100)}%`)
    .join(" · ");
}

function compositionFieldLabel(field) {
  return {
    inputTokens: t("admin.detail.input"),
    outputTokens: t("admin.detail.output"),
    cacheReadTokens: t("admin.detail.cacheRead"),
    cacheWriteTokens: t("admin.detail.cacheWrite"),
    reasoningTokens: t("admin.detail.reasoning")
  }[field] || field;
}

function localizedCostQualityLabel(value = "") {
  if (value === "exact_price") return t("admin.cost.exactPrice");
  if (value === "estimated_price") return t("admin.cost.estimatedPrice");
  return t("admin.cost.unknownPrice");
}

function renderAccountingToken(tokens, cost) {
  const costLine = state.showCost ? `<small><span class="cost-amount">${escapeHtml(formatCost(cost))}</span></small>` : "";
  return `<span class="token-accounting">${formatToken(tokens || 0)}${costLine}</span>`;
}

function sumKnownCosts(...values) {
  const known = values.filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
  if (!known.length) return null;
  return known.reduce((sum, value) => sum + Number(value), 0);
}

function renderQualityBoard(data) {
  document.querySelector("#quality-status").textContent = t("admin.quality.status", { from: data.from || "-", to: data.to || "-", rows: data.rows || 0 });
  document.querySelector("#quality-summary").innerHTML = [
    [t("admin.quality.rows"), String(data.rows || 0)],
    [t("admin.quality.tokens"), formatToken(data.totalTokens || 0), formatTokenRaw(data.totalTokens || 0)],
    [t("admin.quality.composition"), ratioSummary(data.compositionRatios || {})],
    [t("admin.quality.missingPrice"), formatPercent(data.pricingCoverage?.missingTokenRatio || 0)]
  ].map(([label, value, title]) => `<article class="summary-tile"${title ? ` title="${escapeHtml(title)}"` : ""}><span>${escapeHtml(label)}</span><strong class="${summaryValueClass(value)}">${value}</strong></article>`).join("");
  document.querySelector("#quality-anomalies").innerHTML = (data.anomalies || []).length
    ? renderAnomalyGroups(data.anomalies, data.totalTokens || 1)
    : `<article class="empty-state">${t("admin.quality.noAnomaly")}</article>`;
  document.querySelector("#quality-pricing").innerHTML = renderBars([
    { name: t("admin.quality.knownPrice"), totalTokens: data.pricingCoverage?.knownTokens || 0 },
    { name: t("admin.quality.missingPriceLabel"), totalTokens: data.pricingCoverage?.missingTokens || 0 }
  ]);
  document.querySelector("#quality-participants").innerHTML = (data.pricingCoverage?.participants || []).length
    ? data.pricingCoverage.participants.slice(0, 8).map((item) => `<article class="bar-row" title="${escapeHtml(formatPercent(item.missingPriceRatio))}">
      <span>${escapeHtml(item.nickname)}</span>
      <strong>${formatPercent(item.missingPriceRatio)} · ${formatToken(item.missingPriceTokens)}</strong>
      <i style="width:${Math.max(3, item.missingPriceRatio * 100)}%"></i>
    </article>`).join("")
    : `<article class="empty-state">${t("admin.quality.noParticipant")}</article>`;
  document.querySelector("#quality-explainability").innerHTML = (data.pricingCoverage?.costExplainability || []).length
    ? data.pricingCoverage.costExplainability.map((item) => `<article class="price-row">
      <strong>${escapeHtml(item.label)}</strong>
      <span>${t("admin.quality.explainabilityRows", { count: item.count })}</span>
    </article>`).join("")
    : `<article class="empty-state">${t("admin.quality.noExplainability")}</article>`;
}

function renderAnomalyGroups(anomalies, totalTokens) {
  const groups = new Map();
  for (const item of anomalies) {
    const types = item.anomalyTypes?.length ? item.anomalyTypes : ["unclassified"];
    for (const type of types) {
      const rows = groups.get(type) || [];
      rows.push(item);
      groups.set(type, rows);
    }
  }
  return [...groups.entries()]
    .sort((a, b) => groupTokens(b[1]) - groupTokens(a[1]))
    .map(([type, rows]) => {
      const topRows = [...rows].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 5);
      return `<section class="quality-group">
        <header>
          <strong>${escapeHtml(anomalyLabel(type))}</strong>
          <span>${t("admin.quality.ofRows", { shown: topRows.length, total: rows.length, tokens: formatToken(groupTokens(rows)) })}</span>
        </header>
        <div class="breakdown">
          ${topRows.map((item) => `<article class="bar-row" title="${escapeHtml(item.compositionSummary)}">
            <span>${escapeHtml(item.day)} · ${escapeHtml(item.compositionSummary || "")}</span>
            <strong>${formatToken(item.totalTokens)}</strong>
            <i style="width:${Math.max(3, Math.min(100, (item.totalTokens / Math.max(totalTokens, 1)) * 100))}%"></i>
          </article>`).join("")}
        </div>
      </section>`;
    })
    .join("");
}

function anomalyLabel(type) {
  return {
    "input-heavy": t("admin.quality.inputHeavy"),
    "output-heavy": t("admin.quality.outputHeavy"),
    "cache-heavy": t("admin.quality.cacheHeavy"),
    "reasoning-heavy": t("admin.quality.reasoningHeavy"),
    unclassified: t("admin.quality.unclassified")
  }[type] || type;
}

function groupTokens(items) {
  return items.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);
}

function usageRowKey(item) {
  return `${item.periodStart}|${item.participantId}`;
}

function rankingRowKey(item) {
  return `ranking|${item.participantId}`;
}

function ratioSummary(ratios = {}) {
  return [
    `${t("admin.detail.input")} ${formatPercent(ratios.inputRatio || 0)}`,
    `${t("admin.detail.output")} ${formatPercent(ratios.outputRatio || 0)}`,
    `${t("admin.detail.cache")} ${formatPercent(ratios.cacheRatio || 0)}`,
    `${t("admin.detail.reasoning")} ${formatPercent(ratios.reasoningRatio || 0)}`
  ].join(" · ");
}

function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function ratio(value, total) {
  return total ? Number(value || 0) / total : 0;
}

function renderBreakdownText(items = []) {
  return items.slice(0, 3).map((item) => `${item.name} ${formatToken(item.totalTokens)}`).join(" · ") || "-";
}

function costValueForField(item, field) {
  return {
    inputTokens: item.inputCostUsd,
    outputTokens: item.outputCostUsd,
    cacheReadTokens: item.cacheReadCostUsd,
    cacheWriteTokens: item.cacheWriteCostUsd,
    reasoningTokens: item.reasoningCostUsd
  }[field];
}

function summaryValueClass(value) {
  const text = String(value || "").replace(/<[^>]+>/g, "");
  return text.length > 14 || text.includes("·") ? "compact-value" : "";
}

function renderQuality(value) {
  const label = value === "exact" ? t("admin.quality.exactField") : t("admin.quality.partialField");
  const title = value === "exact" ? t("admin.quality.exactDesc") : t("admin.quality.partialDesc");
  return `<span class="pill" title="${escapeHtml(title)}">${label}</span>`;
}

function renderCostQuality(item) {
  if (!state.showCost) return "";
  const quality = item.costQuality || "unknown_price";
  const cost = renderCost(item);
  const price = formatPricePer100M(item);
  const priceLine = price !== "-" ? `<small class="price-sub">${escapeHtml(price)}</small>` : "";
  return `<span class="cost-quality ${escapeHtml(quality)}" title="${escapeHtml(costTitle(item))}">${cost}${priceLine}</span>`;
}

function renderPrimarySlice(items = []) {
  const [first, ...rest] = items;
  if (!first) return `<span class="muted-cell">-</span>`;
  return `<span class="primary-slice" title="${escapeHtml(renderBreakdownText(items))}">
    <strong>${escapeHtml(first.name)}</strong>
    <small>${formatToken(first.totalTokens)}${rest.length ? ` · +${rest.length}` : ""}</small>
  </span>`;
}

const providerDisplayNames = {
  codex_local: "Codex",
  claude_code_local: "Claude Code",
  cursor_dashboard_usage: "Cursor",
  mimocode_local: "MiMoCode",
  opencode_local: "OpenCode",
  hermes_local: "Hermes",
  openclaw_local: "OpenClaw",
  zcode_local: "ZCode",
  workbuddy_local: "WorkBuddy",
  dsh_local: "DeepSeek Harness",
  kimi_local: "Kimi"
};

function renderPrimarySource(items = []) {
  return renderPrimarySlice(items.map((item) => ({
    ...item,
    name: providerDisplayNames[item.name] || item.name
  })));
}

function formatPeriod(item) {
  return item.periodStart === item.periodEnd ? item.periodStart : `${item.periodStart} - ${item.periodEnd}`;
}

function formatPeriodRange(from, to) {
  if (!from && !to) return "-";
  return from === to ? from : t("common.dateRange", { from, to });
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
}

function formatToken(value) {
  return state.rawTokens ? formatNumber(value) : formatTokenCompact(value, getCurrentLang());
}

function formatTokenRaw(value) {
  return `${formatNumber(value)} ${t("unit.tokens")}`;
}

function deviceTokenTooltip(item) {
  const devices = Array.isArray(item.devices) ? item.devices : [];
  if (devices.length <= 1) return formatTokenRaw(item.totalTokens);
  return [
    formatTokenRaw(item.totalTokens),
    ...devices.map((device) => t("admin.usage.deviceTokenTotal", {
      device: deviceLabel(device),
      tokens: formatTokenRaw(device.totalTokens)
    }))
  ].join("\n");
}

function deviceLabel(device) {
  const suffix = String(device?.deviceId || "").slice(-8) || "-";
  const platform = String(device?.clientPlatform || "").trim();
  return platform ? `${platform} · ${suffix}` : suffix;
}


function formatCost(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  const n = Number(value);
  if (n > 0 && n < 0.01) return t("common.lessThanCost");
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
}

function costTitle(item) {
  const missing = normalizeMissingPriceModels(item.missingPriceModels).map((model) => `${model.name} ${formatTokenRaw(model.totalTokens)}`).join(", ");
  return `${localizedCostQualityLabel(item.costQuality)} · ${item.pricingVersion || t("admin.cost.noPricingVersion")}${missing ? ` · ${t("admin.cost.missingModels")}: ${missing}` : ""}`;
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
  return `<span class="cost-amount">${escapeHtml(value)}</span>${item.missingPriceTokens ? `<sup title="${escapeHtml(t("admin.cost.missingModelPrices"))}">*</sup>` : ""}`;
}

function formatPricePer100M(item) {
  const cost = Number(item.estimatedCostUsd);
  const tokens = Number(item.totalTokens || 0);
  if (!Number.isFinite(cost) || cost <= 0 || tokens <= 0) return "-";
  const price = (cost / tokens) * 100_000_000;
  return t("web.cost.pricePer100M", { value: price.toFixed(price >= 100 ? 0 : price >= 10 ? 1 : 2) });
}

function chartItemTitle(item) {
  const cost = state.showCost ? ` · ${t("common.cost")} ${renderCost(item).replace(/<[^>]+>/g, "")}` : "";
  return `${item.name || item.day || ""} · ${formatTokenRaw(item.totalTokens)}${cost}`;
}

function formatUsdPerMillion(value) {
  return `$${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}/1M`;
}

function renderProviderTitle(items = []) {
  return items.map((item) => `${item.name}: ${formatTokenRaw(item.totalTokens)}`).join(", ");
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, "");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

loadUsage().catch((error) => {
  if (error.message !== "Authentication required") statusEl.textContent = error.message;
});
loadPricing().catch((error) => {
  if (error.message !== "Authentication required") pricingStatus.textContent = error.message;
});
