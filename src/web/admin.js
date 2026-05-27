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
  range: "month",
  start: "",
  end: "",
  participantId: "",
  rawTokens: false,
  showCost: false,
  expandedUsageKey: ""
};
const storageKeys = {
  rawTokens: "ai-token-league.admin.rawTokens",
  showCost: "ai-token-league.admin.showCost"
};
const tbody = document.querySelector("#leaderboard");
const statusEl = document.querySelector("#status");
const detailBoard = document.querySelector("#detail-board");
const detailBackdrop = document.querySelector("#admin-detail-backdrop");
const participantFilter = document.querySelector("#participant-filter");
const pricingStatus = document.querySelector("#pricing-status");
let detailCloseTimer = null;
let qualityCacheKey = "";
let qualityCacheData = null;

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
  pricingStatus.textContent = message;
  tbody.innerHTML = `<tr><td class="empty" colspan="7">${message}</td></tr>`;
}

hydratePreferences();
applyToggleState();

document.querySelector(".admin-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  document.querySelectorAll("[data-admin-tab]").forEach((item) => item.classList.remove("active"));
  document.querySelectorAll("[data-admin-panel]").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  document.querySelector(`[data-admin-panel="${button.dataset.adminTab}"]`).classList.add("active");
  if (button.dataset.adminTab === "quality") loadQuality({ useCache: true }).catch((error) => {
    document.querySelector("#quality-status").textContent = error.message;
  });
  if (button.dataset.adminTab === "devices") loadDevices().catch((error) => {
    document.querySelector("#devices-status").textContent = error.message;
  });
  if (button.dataset.adminTab === "analytics") {
    const iframe = document.querySelector("#analytics-iframe");
    if (iframe) iframe.src = iframe.src;
  }
});

window.addEventListener("message", (event) => {
  if (event.data?.type === "analytics-resize") {
    const iframe = document.querySelector("#analytics-iframe");
    if (iframe) iframe.style.height = event.data.height + "px";
  }
});

document.querySelector("[data-filter='quick-range']").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  setActive(event.currentTarget, button);
  state.range = button.dataset.value;
  state.start = "";
  state.end = "";
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
  loadUsage();
});

participantFilter.addEventListener("change", () => {
  state.participantId = participantFilter.value;
  loadUsage();
});

document.querySelector("#apply-custom-range").addEventListener("click", () => {
  state.range = "custom";
  state.start = document.querySelector("#start-date").value;
  state.end = document.querySelector("#end-date").value;
  document.querySelectorAll("[data-filter='quick-range'] button").forEach((item) => item.classList.remove("active"));
  updateAutoGrain();
  syncRangeInputs();
  loadUsage();
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

document.querySelector("#close-admin-detail").addEventListener("click", closeDetail);
detailBackdrop.addEventListener("click", closeDetail);

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

async function loadUsage() {
  invalidateQualityCache();
  updateAutoGrain();
  syncRangeInputs();
  statusEl.textContent = t("admin.loading");
  const response = await fetchAdmin(`/api/admin/usage?${queryString()}`);
  const data = await response.json();
  renderParticipantOptions(data.participants || []);
  render(data.items || []);
  statusEl.textContent = t("admin.usage.rows", { count: data.items.length, plural: data.items.length === 1 ? "" : "s", from: data.from || "-", to: data.to || "-" });
  await refreshQualityIfActive();
}

async function loadDevices() {
  const response = await fetchAdmin("/api/admin/devices");
  const data = await response.json();
  renderDevices(data);
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
    <td><span class="pill" title="${escapeHtml(item.deviceId)}">${escapeHtml(String(item.deviceId || "").slice(-8))}</span></td>
    <td>${escapeHtml(item.lanIp || "-")}</td>
    <td>${escapeHtml(item.clientAppVersion || "-")}</td>
    <td>${escapeHtml(item.clientPlatform || item.os || "-")}</td>
    <td>${escapeHtml(item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleDateString() : "-")}</td>
    <td>
      <div class="row-actions">
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
  const response = await fetchAdmin("/api/admin/model-prices");
  const data = await response.json();
  renderPricing(data);
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
  document.querySelector("#remote-pricing-status").innerHTML = renderRemotePricingStatus(data.remote || {});
  document.querySelector("#missing-prices").innerHTML = missing.length
    ? missing
        .map((item, index) => `<article class="price-suggestion price-task price-alias-task" data-fill-price-model="${escapeHtml(item.model)}" title="${escapeHtml(renderProviderTitle(item.providers))}">
          <span class="task-rank">#${index + 1}</span>
          <strong>${escapeHtml(item.model)}</strong>
          <span>${formatToken(item.totalTokens)} · ${formatPercent(ratio(item.totalTokens, missingTotal))}</span>
          <small>${escapeHtml(renderProviderTitle(item.providers) || t("admin.pricing.noSourceBreakdown"))}</small>
          <input data-alias-target="${escapeHtml(item.model)}" list="price-model-targets" data-i18n-placeholder="admin.pricing.mapToExisting" placeholder="${escapeHtml(t("admin.pricing.mapToExisting"))}" autocomplete="off" />
          <button type="button" data-map-price-alias="${escapeHtml(item.model)}" ${priceTargets.length ? "" : "disabled"}>${t("admin.pricing.map")}</button>
        </article>`)
        .join("")
        + `<datalist id="price-model-targets">${priceTargets.map((model) => `<option value="${escapeHtml(model)}"></option>`).join("")}</datalist>`
    : `<article class="empty-state">${t("admin.pricing.noMissing")}</article>`;
  document.querySelectorAll("[data-fill-price-model]").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("input, button, select, textarea, a")) return;
      fillPriceModel(card.dataset.fillPriceModel);
    });
  });
  document.querySelectorAll("[data-map-price-alias]").forEach((button) => {
    button.addEventListener("click", () => {
      const model = button.dataset.mapPriceAlias;
      const input = [...document.querySelectorAll("[data-alias-target]")]
        .find((item) => item.dataset.aliasTarget === model);
      mapModelPriceAlias(model, input?.value || "").catch((error) => {
        pricingStatus.textContent = error.message;
      });
    });
  });
  document.querySelector("#custom-prices").innerHTML = custom.length
    ? custom
        .map((item) => `<article class="price-row">
          <strong>${escapeHtml(item.model)}</strong>
          <span>${t("admin.pricing.priceLine", { input: formatUsdPerMillion(item.inputCostPerMTok), output: formatUsdPerMillion(item.outputCostPerMTok), cacheRead: formatUsdPerMillion(item.cacheReadCostPerMTok) })}</span>
          <button type="button" data-delete-price="${escapeHtml(item.model)}">${t("admin.pricing.delete")}</button>
        </article>`)
        .join("")
    : `<article class="empty-state">${t("admin.pricing.noCustom")}</article>`;
  document.querySelector("#price-aliases").innerHTML = aliases.length
    ? aliases
        .map((item) => `<article class="price-row">
          <strong>${escapeHtml(item.model)}</strong>
          <span>${t("admin.pricing.aliasUses", { target: escapeHtml(item.targetModel) })}</span>
          <button type="button" data-delete-price-alias="${escapeHtml(item.model)}">${t("admin.pricing.delete")}</button>
        </article>`)
        .join("")
    : `<article class="empty-state">${t("admin.pricing.noAliases")}</article>`;
  document.querySelector("#openrouter-prices").innerHTML = openrouter.length
    ? openrouter
        .slice(0, 20)
        .map((item) => `<article class="price-row">
          <strong>${escapeHtml(item.model)}</strong>
          <span>${t("admin.pricing.priceLine", { input: formatUsdPerMillion(item.inputCostPerMTok), output: formatUsdPerMillion(item.outputCostPerMTok), cacheRead: formatUsdPerMillion(item.cacheReadCostPerMTok) })}</span>
        </article>`)
        .join("")
    : `<article class="empty-state">${t("admin.pricing.noOpenRouter")}</article>`;
  document.querySelectorAll("[data-delete-price]").forEach((button) => {
    button.addEventListener("click", async () => {
      pricingStatus.textContent = t("admin.deleting");
      await fetchAdmin(`/api/admin/model-prices/${encodeURIComponent(button.dataset.deletePrice)}`, { method: "DELETE" });
      await loadPricing();
      await loadUsage();
    });
  });
  document.querySelectorAll("[data-delete-price-alias]").forEach((button) => {
    button.addEventListener("click", async () => {
      pricingStatus.textContent = t("admin.deletingAlias");
      await fetchAdmin(`/api/admin/model-price-aliases/${encodeURIComponent(button.dataset.deletePriceAlias)}`, { method: "DELETE" });
      await loadPricing();
      await loadUsage();
    });
  });
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
}

function render(items) {
  if (!items.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="7">${t("admin.usage.noUsage")}</td></tr>`;
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
        <td>${renderCostQuality(item)}</td>
        <td>${renderPrimarySlice(item.workdirs)}</td>
        <td>${renderPrimarySlice(item.models)}</td>
        <td>
          <div class="row-actions">
            <button type="button" class="link-button" data-expand-row="${escapeHtml(key)}">${expanded ? t("admin.usage.collapseRow") : t("admin.usage.expandRow")}</button>
          </div>
        </td>
      </tr>
      ${expanded ? `<tr class="expanded-row"><td colspan="7">
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
}

async function deleteParticipantData(participantId, nickname, { statusElement = statusEl } = {}) {
  const label = nickname || participantId;
  const confirmed = window.confirm(t("admin.usage.deleteConfirm", { label }));
  if (!confirmed) return;
  statusElement.textContent = t("admin.usage.deletingUser", { label });
  const response = await fetchAdmin(`/api/admin/participants/${encodeURIComponent(participantId)}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || t("admin.error.deleteParticipant"));
  if (state.participantId === participantId) state.participantId = "";
  state.expandedUsageKey = "";
  await loadDevices();
  await loadUsage();
  await loadPricing();
  statusElement.textContent = result.deleted
    ? t("admin.usage.deleted", { label, usage: result.removed.usageDaily || 0, batches: result.removed.uploadBatches || 0 })
    : t("admin.usage.noData", { label });
}

async function loadDetail(participantId, rowRange = null) {
  if (detailCloseTimer) clearTimeout(detailCloseTimer);
  detailBoard.hidden = false;
  detailBackdrop.hidden = false;
  requestAnimationFrame(() => {
    detailBoard.classList.add("is-open");
    detailBackdrop.classList.add("is-open");
    document.body.classList.add("detail-open");
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
}

function closeDetail() {
  detailBoard.classList.remove("is-open");
  detailBackdrop.classList.remove("is-open");
  document.body.classList.remove("detail-open");
  if (detailBoard.hidden) return;
  detailCloseTimer = setTimeout(() => {
    detailBoard.hidden = true;
    detailBackdrop.hidden = true;
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
  const { start, end, label } = selectedRange();
  if (state.range !== "custom") {
    document.querySelector("#start-date").value = start;
    document.querySelector("#end-date").value = end;
  }
  document.querySelector("#date-range-display").textContent = t("admin.usage.grainLabel", { label, grain: grainLabel(state.grain) });
}

function selectedRange() {
  if (state.range === "custom") {
    return { start: state.start || "", end: state.end || "", label: `${state.start || "-"} - ${state.end || "-"}` };
  }
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
  const label = localizedCostQualityLabel(item.costQuality);
  const cost = state.showCost ? renderCost(item) : "";
  return `<span class="cost-quality ${escapeHtml(item.costQuality || "unknown_price")}" title="${escapeHtml(costTitle(item))}">
    <small class="cq-label">${escapeHtml(label)}</small>
    ${cost ? cost : ""}
  </span>`;
}

function renderPrimarySlice(items = []) {
  const [first, ...rest] = items;
  if (!first) return `<span class="muted-cell">-</span>`;
  return `<span class="primary-slice" title="${escapeHtml(renderBreakdownText(items))}">
    <strong>${escapeHtml(first.name)}</strong>
    <small>${formatToken(first.totalTokens)}${rest.length ? ` · +${rest.length}` : ""}</small>
  </span>`;
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
