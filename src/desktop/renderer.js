import { costQualityLabel, dominantComposition, tokenCompositionDetails, tokenCompositionSummary } from "../shared/composition.js";
import { addCostToUsageItem, aggregateCost, createPriceMap } from "../shared/pricing.js";
import { formatTokenCompact, formatTokenRaw, formatUsd } from "../shared/display.js";
import { dayToUtcDate, localDay, utcDateToDay } from "../shared/date.js";

const api = window.tokenLeague;
const $ = (selector) => document.querySelector(selector);

let latestUsage = [];
let latestHealth = [];
let allUsage = [];
let latestConfig = null;
let trendMode = "chart";
let trendView = "daily";
let selectedTrendBucketKey = "";
let trendDrawerBucketKey = "";
let trendDrawerCloseTimer = null;
let serverPriceMap = null;
let pricingSource = "local fallback pricing";
let latestScanAt = "";
let scanRunning = false;
let scanPollTimer = null;

document.querySelectorAll("nav button").forEach((button) => {
  button.addEventListener("click", () => {
    selectSection(button.dataset.section);
    if (button.dataset.section === "today") run(loadToday);
    if (button.dataset.section === "trend") run(loadTrend);
    if (button.dataset.section === "settings") run(loadBackgroundStatus);
  });
});

$("#refresh-today").addEventListener("click", () => run(() => loadToday(true)));
$("#refresh-trend").addEventListener("click", () => run(() => loadTrend(true)));
$("#refresh-health").addEventListener("click", () => run(async () => {
  await saveSettings({ reloadToday: false });
  await loadHealth();
}));
$("#sync-now").addEventListener("click", () => run(syncNow));
$("#onboarding-save").addEventListener("click", () => run(saveOnboardingNickname));
$("#onboarding-import").addEventListener("click", () => run(importProfile));
$("#onboarding-sources").addEventListener("click", () => {
  selectSection("settings");
  selectSettingsTab("sources");
  run(loadHealth);
});
$("#add-codex-root").addEventListener("click", () => run(() => addProviderRoot("codex_local")));
$("#add-claude-root").addEventListener("click", () => run(() => addProviderRoot("claude_code_local")));
$("#add-cursor-token").addEventListener("click", openCursorTokenModal);
$("#cancel-cursor-token").addEventListener("click", closeCursorTokenModal);
$("#save-cursor-token").addEventListener("click", () => run(addCursorToken));
$("#cursor-token-modal").addEventListener("click", (event) => {
  if (event.target.id === "cursor-token-modal") closeCursorTokenModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#cursor-token-modal").hidden) closeCursorTokenModal();
  if (event.key === "Escape" && !$("#trend-drawer").hidden) closeTrendDrawer();
});
$("#close-trend-drawer").addEventListener("click", closeTrendDrawer);
$("#trend-drawer-backdrop").addEventListener("click", closeTrendDrawer);
$("#settings-source-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-toggle-source]");
  if (!button) return;
  run(() => toggleSource(button.dataset.toggleSource));
});
$("#trend-mode").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  trendMode = button.dataset.mode;
  $("#trend-mode").querySelectorAll("button").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  renderTrend();
});
$("#trend-view").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  trendView = button.dataset.view;
  $("#trend-view").querySelectorAll("button").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  renderTrend();
});
$("#settings-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  selectSettingsTab(button.dataset.settingsTab);
  if (button.dataset.settingsTab === "sync") run(loadBackgroundStatus);
  if (button.dataset.settingsTab === "sources") run(loadHealth);
});
$("#workdir-alias-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-save-alias]");
  if (!button) return;
  run(async () => {
    const workdirHash = button.dataset.saveAlias;
    const alias = document.querySelector(`[data-alias-input="${cssEscape(workdirHash)}"]`).value;
    latestConfig = await api.setWorkdirAlias(workdirHash, alias);
    await loadToday(true);
  });
});

document.querySelectorAll(".save-settings").forEach((button) => button.addEventListener("click", async () => run(async () => {
  await saveSettings({ reloadToday: true });
})));

$("#reset-local-data").addEventListener("click", () => run(resetLocalData));

function selectSection(section) {
  document.querySelectorAll("nav button").forEach((item) => item.classList.toggle("active", item.dataset.section === section));
  document.querySelectorAll(".panel").forEach((item) => item.classList.toggle("active", item.id === section));
  $(".workspace")?.scrollTo({ top: 0, behavior: "auto" });
}

function selectSettingsTab(tab) {
  $("#settings-tabs").querySelectorAll("button").forEach((item) => item.classList.toggle("active", item.dataset.settingsTab === tab));
  document.querySelectorAll("[data-settings-panel]").forEach((item) => item.classList.toggle("active", item.dataset.settingsPanel === tab));
}

async function saveSettings({ reloadToday = true } = {}) {
  const payload = settingsPayload();
  setSaveMessage(payload.apiBaseUrl ? "Checking API..." : "Saving settings...", "");
  const existing = await api.getConfig();
  const config = existing ? await api.updateConfig(payload) : await api.initConfig(payload);
  renderConfig(config);
  setSaveMessage("Settings saved", "ok");
  $("#sync-state").textContent = "Settings saved";
  if (reloadToday) await loadToday(true);
  await loadBackgroundStatus();
  return config;
}

function settingsPayload() {
  return {
    nickname: $("#nickname").value || "anonymous",
    apiBaseUrl: $("#apiBaseUrl").value.trim(),
    showEstimatedCost: $("#showEstimatedCost").checked,
    showRawTokens: $("#showRawTokens").checked,
    autoRefreshEnabled: $("#autoRefreshEnabled").checked,
    refreshIntervalMinutes: $("#refreshIntervalMinutes").value || 15,
    launchAtLogin: $("#launchAtLogin").checked,
    desktopAutoInitialized: false,
    providerEnabled: latestConfig?.providerEnabled || {},
    cursorDashboardUsage: {
      enabled: latestConfig?.cursorDashboardUsage?.enabled ?? false
    }
  };
}

$("#export").addEventListener("click", async () => run(async () => {
  const result = await api.exportIdentity();
  $("#sync-state").textContent = result.canceled ? "Export canceled" : "Profile exported";
}));

$("#import").addEventListener("click", async () => run(async () => {
  await importProfile();
}));

async function importProfile() {
  const config = await api.importIdentity();
  if (!config?.canceled) {
    renderConfig(config);
    await loadToday(true);
    await loadBackgroundStatus();
  }
}

async function saveOnboardingNickname() {
  const nickname = $("#onboarding-nickname").value.trim() || "anonymous";
  $("#nickname").value = nickname;
  latestConfig = await api.updateConfig({
    ...settingsPayload(),
    nickname,
    desktopAutoInitialized: false
  });
  renderConfig(latestConfig);
  setSaveMessage("Nickname saved", "ok");
  $("#sync-state").textContent = "Profile ready";
}

async function resetLocalData() {
  const ok = window.confirm("Reset this desktop profile, cached usage, aliases, local Cursor tokens, sync queue, and settings? Source files in Codex, Claude Code, and Cursor are not deleted.");
  if (!ok) return;
  $("#reset-local-data").disabled = true;
  $("#sync-state").textContent = "Resetting local data...";
  await api.resetLocalData();
}

async function boot() {
  const config = await api.getConfig();
  if (config) {
    latestConfig = config;
    renderConfig(config);
    await loadToday();
    await loadBackgroundStatus();
  } else {
    $("#today-summary").textContent = "Open Settings to start tracking.";
    document.querySelector('[data-section="settings"]').click();
  }
}

async function loadToday(force = false) {
  await refreshPricing();
  const status = await api.startUsageScan({ force });
  applyUsageScanStatus(status, { force });
  pollUsageScan();
}

function setScanState(running, force = false) {
  scanRunning = running;
  $("#refresh-today").disabled = running;
  $("#refresh-trend").disabled = running;
  $("#today-summary").textContent = running
    ? `${force ? "Refreshing" : "Scanning"} local usage. First scan can take a while on large histories.`
    : $("#today-summary").textContent;
  $("#today-scan-time").textContent = running ? "Refreshing in background..." : `Last scan ${latestScanAt ? formatDateTime(latestScanAt) : "-"}`;
  $("#trend-summary").textContent = running
    ? "Refreshing in background. You can keep using the app."
    : $("#trend-summary").textContent;
  renderOnboarding();
}

async function loadTrend(force = false) {
  await refreshPricing();
  const status = await api.startUsageScan({ force });
  applyUsageScanStatus(status, { force });
  pollUsageScan();
}

function pollUsageScan() {
  if (scanPollTimer) return;
  scanPollTimer = setInterval(async () => {
    try {
      const status = await api.usageScanStatus();
      applyUsageScanStatus(status);
      if (!status.running) {
        clearInterval(scanPollTimer);
        scanPollTimer = null;
      }
    } catch (error) {
      clearInterval(scanPollTimer);
      scanPollTimer = null;
      setScanState(false);
      $("#today-summary").textContent = `Refresh status failed: ${error.message}`;
      $("#trend-summary").textContent = `Refresh status failed: ${error.message}`;
      console.error(error);
    }
  }, 1000);
}

function applyUsageScanStatus(status, { force = false } = {}) {
  if (status.snapshot) applyUsageSnapshot(status.snapshot);
  setScanState(Boolean(status.running), status.force ?? force);
  if (status.error) {
    $("#today-summary").textContent = `Refresh failed: ${status.error}`;
    $("#trend-summary").textContent = `Refresh failed: ${status.error}`;
  }
}

function applyUsageSnapshot(usage) {
  allUsage = (usage.items || []).map(normalizeUsageTotal);
  latestScanAt = usage.scannedAt || latestScanAt;
  latestUsage = allUsage.filter((item) => item.day === localDay());
  if (usage.health) latestHealth = usage.health;
  renderToday();
  renderTrend();
  renderHealth();
  renderAliases();
}

function normalizeUsageTotal(item) {
  const inputTokens = positiveInteger(item.inputTokens);
  const outputTokens = positiveInteger(item.outputTokens);
  return {
    ...item,
    inputTokens,
    outputTokens,
    cacheReadTokens: positiveInteger(item.cacheReadTokens),
    cacheWriteTokens: positiveInteger(item.cacheWriteTokens),
    reasoningTokens: positiveInteger(item.reasoningTokens),
    totalTokens: inputTokens + positiveInteger(item.cacheReadTokens) + positiveInteger(item.cacheWriteTokens) + outputTokens
  };
}

function positiveInteger(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

async function loadHealth() {
  latestHealth = await api.providerHealth();
  renderHealth();
  await loadBackgroundStatus();
}

async function syncNow() {
  const button = $("#sync-now");
  button.disabled = true;
  try {
    if (!confirmSyncUpload()) {
      $("#sync-state").textContent = "Sync canceled";
      return;
    }
    $("#sync-state").textContent = "Syncing...";
    const result = await api.syncUsage();
    latestConfig = await api.getConfig();
    renderSyncStatus(latestConfig, result);
    await loadToday();
  } finally {
    button.disabled = false;
  }
}

function confirmSyncUpload() {
  const config = latestConfig || {};
  const apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl || config.apiConnection?.apiBaseUrl || "");
  if (!apiBaseUrl) {
    window.alert("Configure an API base URL in Settings before syncing.");
    return false;
  }
  const rows = allUsage.length || latestUsage.length || 0;
  const scannedAt = latestScanAt ? formatDateTime(latestScanAt) : "-";
  return window.confirm([
    "Upload local aggregate usage to the configured API?",
    "",
    `Target: ${apiBaseUrl}`,
    `Rows: ${rows}`,
    `Last scan: ${scannedAt}`,
    "",
    "No prompts, responses, code, or real paths are uploaded."
  ].join("\n"));
}

async function addProviderRoot(providerId) {
  const config = await api.addProviderRoot(providerId);
  if (!config?.canceled) {
    latestConfig = config;
    renderConfig(config);
  }
  await loadToday();
  await loadBackgroundStatus();
}

async function addCursorToken() {
  const input = $("#cursor-token-input");
  const error = $("#cursor-token-error");
  const raw = input.value.trim();
  if (!raw) {
    error.textContent = "Cursor token is required";
    return;
  }
  let config;
  try {
    config = await api.addCursorToken(raw);
  } catch (err) {
    error.textContent = err.message || "Cursor token is invalid";
    return;
  }
  latestConfig = config;
  renderConfig(config);
  closeCursorTokenModal();
  setSaveMessage("Cursor token added", "ok");
  await loadHealth();
  await loadToday(true);
}

function openCursorTokenModal() {
  $("#cursor-token-input").value = "";
  $("#cursor-token-error").textContent = "";
  $("#cursor-token-modal").hidden = false;
  $("#cursor-token-input").focus();
}

function closeCursorTokenModal() {
  $("#cursor-token-modal").hidden = true;
}

function renderConfig(config) {
  latestConfig = config;
  $("#profile-state").textContent = config?.desktopAutoInitialized ? "First run" : config ? "Ready" : "Not configured";
  if (config?.nickname) $("#nickname").value = config.nickname;
  if (config?.nickname) $("#onboarding-nickname").value = config.nickname;
  $("#apiBaseUrl").value = config?.apiBaseUrl ?? "";
  $("#showEstimatedCost").checked = config?.showEstimatedCost ?? false;
  $("#showRawTokens").checked = config?.showRawTokens ?? false;
  $("#autoRefreshEnabled").checked = config?.autoRefreshEnabled ?? false;
  $("#refreshIntervalMinutes").value = config?.refreshIntervalMinutes ?? 15;
  $("#launchAtLogin").checked = config?.launchAtLogin ?? false;
  renderCursorTokenSummary(config?.cursorDashboardUsage);
  renderSyncStatus(config);
  renderOnboarding();
}

function renderOnboarding() {
  const card = $("#onboarding-card");
  if (!card) return;
  card.hidden = !(latestConfig?.desktopAutoInitialized || scanRunning);
}

function renderCursorTokenSummary(cursorConfig = {}) {
  const tokens = cursorConfig?.workosSessionTokens || [];
  const legacy = cursorConfig?.workosSessionToken ? [{ accountName: "legacy token" }] : [];
  const accounts = [...tokens, ...legacy].map((item) => item.accountName || "Cursor").filter(Boolean);
  $("#cursor-token-summary").textContent = accounts.length
    ? `${accounts.length} Cursor token${accounts.length === 1 ? "" : "s"} configured · ${accounts.join(", ")}`
    : "No Cursor token configured. Local Cursor state can still be detected automatically.";
}

function renderSyncStatus(config, result = null) {
  const status = config?.syncStatus || {};
  const configuredApiBaseUrl = normalizeApiBaseUrl(config?.apiBaseUrl || "");
  const statusApiBaseUrl = normalizeApiBaseUrl(status.apiBaseUrl || config?.lastSyncApiBaseUrl || "");
  const statusMatchesApi = statusApiBaseUrl && statusApiBaseUrl === configuredApiBaseUrl;
  const connection = config?.apiConnection || {};
  const apiBaseUrl = configuredApiBaseUrl || connection.apiBaseUrl || "";
  const lastFinishedAt = statusMatchesApi ? status.lastFinishedAt || config?.lastSyncAt || "" : "";
  const queuePending = Number(status.queuePending || result?.queuePending || 0);
  const scanned = statusMatchesApi ? Number(status.scanned || result?.scanned || 0) : 0;
  const accepted = statusMatchesApi ? Number(status.accepted || result?.accepted || 0) : 0;
  const rejected = statusMatchesApi ? Number(status.rejected || result?.rejected || 0) : 0;
  const state = statusMatchesApi ? status.status || config?.lastSyncStatus || "" : connection.status || "";
  const error = statusMatchesApi ? status.error || config?.lastSyncError || result?.error || "" : connection.message || "";
  const stateLabel = syncStateLabel(state, { scanned, accepted, rejected, queuePending, error });
  const apiCheckedAt = connection.checkedAt ? `API checked ${formatDateTime(connection.checkedAt)}` : "";
  $("#sync-state").textContent = stateLabel;
  $("#sync-target").textContent = apiBaseUrl ? `API ${apiBaseUrl}` : "API not configured";
  $("#sync-target").title = apiBaseUrl || "";
  $("#sync-last").textContent = lastFinishedAt ? `Last sync ${formatDateTime(lastFinishedAt)}` : apiCheckedAt || "Last sync -";
  $("#settings-sync-target").textContent = apiBaseUrl ? `API ${apiBaseUrl}` : "API not configured";
  $("#settings-sync-target").title = apiBaseUrl || "";
  $("#settings-sync-last").textContent = lastFinishedAt ? `Last sync ${formatDateTime(lastFinishedAt)}` : apiCheckedAt || "Last sync -";
  $("#settings-sync-result").textContent = stateLabel;
  $("#settings-sync-result").title = error || stateLabel;
}

function syncStateLabel(state, { scanned = 0, accepted = 0, rejected = 0, queuePending = 0, error = "" } = {}) {
  if (state === "success") {
    const rejectedText = rejected ? `, ${rejected} rejected` : "";
    const queueText = queuePending ? `, ${queuePending} queued` : "";
    return `Synced ${scanned} rows (${accepted} accepted${rejectedText}${queueText})`;
  }
  if (state === "queued") {
    return `Queued ${scanned} rows${queuePending ? ` (${queuePending} pending)` : ""}`;
  }
  if (state === "failed") {
    return error ? `Sync failed: ${error}` : "Sync failed";
  }
  if (state === "reachable") {
    return "API reachable; not synced";
  }
  if (state === "not_configured") {
    return "API not configured";
  }
  if (state === "unreachable") {
    return error ? `API unreachable: ${error}` : "API unreachable";
  }
  return "Not synced";
}

function renderToday() {
  const total = latestUsage.reduce((sum, item) => sum + item.totalTokens, 0);
  const workdirs = groupBy(latestUsage, "workdirDisplayName");
  const models = groupBy(latestUsage, "model");
  const cost = aggregateUsageCost(latestUsage);
  const composition = aggregateComposition(latestUsage);

  $("#today-total").textContent = formatToken(total);
  $("#today-total").title = formatTokenRaw(total);
  $("#today-summary").textContent = latestUsage.length ? `${latestUsage.length} daily rows from local sources` : "No local usage found for today.";
  $("#today-scan-time").textContent = `Last scan ${latestScanAt ? formatDateTime(latestScanAt) : "-"}`;
  $("#workdir-count").textContent = String(workdirs.length);
  $("#model-count").textContent = String(models.length);
  $("#today-dominant").textContent = humanDominant(dominantComposition(composition));
  $("#today-composition-summary").textContent = tokenCompositionSummary(composition) || "No composition";
  $("#today-composition").innerHTML = renderCompositionTiles(composition);
  $("#today-cost-card").hidden = !latestConfig?.showEstimatedCost;
  $("#today-cost").textContent = renderCostValue(cost);
  $("#today-cost").title = costTitle(cost);
  $("#today-cost-note").textContent = cost.missingPriceTokens ? `* ${pricingSource}` : pricingSource;
  $("#today-cost-note").title = costTitle(cost);

  $("#workdir-list").innerHTML = workdirs.length
    ? renderBars(workdirs, { showCost: latestConfig?.showEstimatedCost })
    : `<article class="empty-state">No workdir usage today.</article>`;
  $("#model-list").innerHTML = models.length
    ? renderBars(models, { showCost: latestConfig?.showEstimatedCost })
    : `<article class="empty-state">No model usage today.</article>`;
}

function renderTrend() {
  const rows = groupTrend(allUsage);
  if (rows.length && !selectedTrendBucketKey) selectedTrendBucketKey = trendBucketKey(rows[0]);
  if (!rows.some((row) => trendBucketKey(row) === selectedTrendBucketKey)) selectedTrendBucketKey = rows[0] ? trendBucketKey(rows[0]) : "";
  if (!rows.some((row) => trendBucketKey(row) === trendDrawerBucketKey)) trendDrawerBucketKey = "";
  $("#trend-chart-panel").hidden = trendMode !== "chart";
  $("#trend-table-panel").hidden = trendMode !== "table";
  $("#trend-heading").textContent = trendViewMeta().heading;
  $("#trend-summary").textContent = `${rows.length} ${trendViewMeta().bucketLabel}${rows.length === 1 ? "" : "s"} · ${trendViewMeta().summary}.`;
  $("#trend-chart-panel").innerHTML = rows.length
    ? renderTrendDashboard(rows)
    : `<article class="empty-state">No local usage found.</article>`;
  document.querySelector("#trend-cost-header").hidden = !latestConfig?.showEstimatedCost;
  $("#trend-rows").innerHTML = rows.length
    ? rows
        .map((row) => `<tr>
          <td><button type="button" data-expand-trend="${escapeHtml(trendBucketKey(row))}">${trendDrawerBucketKey === trendBucketKey(row) ? "Hide" : "Show"}</button> ${formatTrendPeriod(row)}</td>
          <td class="numeric" title="${formatTokenRaw(row.totalTokens)}">${formatToken(row.totalTokens)}</td>
          <td>${escapeHtml(row.compositionSummary || tokenCompositionSummary(row))}</td>
          <td>${renderCompactBreakdown(row.modelBreakdown)}</td>
          <td>${renderCompactBreakdown(row.workdirBreakdown)}</td>
          ${latestConfig?.showEstimatedCost ? `<td class="numeric" title="${escapeHtml(costTitle(row))}">${renderCost(row)}</td>` : ""}
        </tr>`)
        .join("")
    : `<tr><td colspan="${latestConfig?.showEstimatedCost ? 6 : 5}" class="empty-cell">No local usage found.</td></tr>`;
  $("#trend-selection-panel").hidden = trendMode === "table";
  $("#trend-selection-panel").innerHTML = trendMode === "chart" && rows.length && selectedTrendBucketKey
    ? renderTrendSelection(rows.find((row) => trendBucketKey(row) === selectedTrendBucketKey))
    : "";
  renderTrendDrawer(rows);
  document.querySelectorAll("[data-expand-trend]").forEach((button) => {
    button.addEventListener("click", () => {
      trendDrawerBucketKey = trendDrawerBucketKey === button.dataset.expandTrend ? "" : button.dataset.expandTrend;
      renderTrend();
    });
  });
  document.querySelectorAll("[data-select-trend]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedTrendBucketKey = button.dataset.selectTrend;
      renderTrend();
    });
  });
}

function renderAliases() {
  const workdirs = groupWorkdirs(allUsage);
  $("#workdir-alias-list").innerHTML = workdirs.length
    ? workdirs
        .map((item) => `<article class="alias-row">
          <div>
            <strong>${escapeHtml(item.name)}</strong>
            <small title="${formatTokenRaw(item.totalTokens)}">${formatToken(item.totalTokens)} tokens</small>
          </div>
          <input data-alias-input="${escapeHtml(item.workdirHash)}" value="${escapeHtml(latestConfig?.workdirAliases?.[item.workdirHash] || "")}" placeholder="Alias" />
          <button data-save-alias="${escapeHtml(item.workdirHash)}">Save</button>
        </article>`)
        .join("")
    : `<article class="empty-state">No workdirs found in local usage.</article>`;
}

function renderHealth() {
  const html = latestHealth
    .map((item) => {
      const enabled = sourceEnabled(item);
      return `<article class="source-card">
      <div>
        <strong>${sourceName(item.providerId)}</strong>
        <small>${sourceSummary(item)}</small>
        <p>${sourceDescription(item.providerId)}</p>
        ${renderRoots(item.roots)}
      </div>
      <button class="source-toggle ${enabled ? "ok" : "miss"}" type="button" data-toggle-source="${escapeHtml(item.providerId)}" aria-pressed="${enabled ? "true" : "false"}">${enabled ? "On" : "Off"}</button>
    </article>`;
    })
    .join("");
  $("#settings-source-list").innerHTML = html;
}

async function toggleSource(providerId) {
  const current = latestConfig || await api.getConfig();
  if (!current) throw new Error("Open Settings first");
  const nextEnabled = !sourceEnabledForConfig(current, providerId);
  const previousConfig = current;
  const previousHealth = latestHealth;
  latestConfig = applySourceEnabled(current, providerId, nextEnabled);
  latestHealth = latestHealth.map((item) => item.providerId === providerId ? { ...item, enabled: nextEnabled } : item);
  renderConfig(latestConfig);
  renderHealth();
  setSaveMessage(`${sourceName(providerId)} ${nextEnabled ? "enabling" : "disabling"}...`, "");
  try {
    latestConfig = await api.updateConfig(sourceTogglePayload(providerId, nextEnabled, current));
    renderConfig(latestConfig);
    setSaveMessage(`${sourceName(providerId)} ${nextEnabled ? "enabled" : "disabled"}; refresh usage to update totals`, "ok");
    await loadHealth();
  } catch (error) {
    latestConfig = previousConfig;
    latestHealth = previousHealth;
    renderConfig(previousConfig);
    renderHealth();
    throw error;
  }
}

function sourceEnabled(item) {
  if (item.providerId === "cursor_dashboard_usage") return item.enabled === true;
  return item.enabled !== false;
}

function sourceEnabledForConfig(config, providerId) {
  if (providerId === "cursor_dashboard_usage") return config.cursorDashboardUsage?.enabled === true;
  return config.providerEnabled?.[providerId] !== false;
}

function sourceTogglePayload(providerId, enabled, config) {
  if (providerId === "cursor_dashboard_usage") {
    return {
      cursorDashboardUsage: {
        enabled
      }
    };
  }
  return {
    providerEnabled: {
      ...(config.providerEnabled || {}),
      [providerId]: enabled
    }
  };
}

function applySourceEnabled(config, providerId, enabled) {
  if (providerId === "cursor_dashboard_usage") {
    return {
      ...config,
      cursorDashboardUsage: {
        ...(config.cursorDashboardUsage || {}),
        enabled
      }
    };
  }
  return {
    ...config,
    ...sourceTogglePayload(providerId, enabled, config)
  };
}

function sourceSummary(item) {
  const count = (item.roots || []).length;
  if (item.providerId === "cursor_dashboard_usage") {
    if (!count) return "No Cursor token configured";
    return `${count} account source${count === 1 ? "" : "s"}`;
  }
  if (!item.detected) return "Not found";
  return `${count} location${count === 1 ? "" : "s"}`;
}

function sourceDescription(providerId) {
  if (providerId === "cursor_dashboard_usage") return "Uses Cursor dashboard usage events. Project paths are not available from the Cursor API.";
  return "Scans local usage files from configured and detected locations.";
}

async function loadBackgroundStatus() {
  const status = await api.backgroundStatus();
  const config = await api.getConfig();
  if (config) {
    latestConfig = config;
    renderSyncStatus(config);
  }
  const parts = [];
  parts.push(status.enabled ? "Background refresh on" : "Background refresh off");
  if (status.lastResult) parts.push(status.lastResult);
  if (status.lastMode === "sync") parts.push("auto upload enabled");
  if (status.lastMode === "scan") parts.push("local only");
  if (status.nextRunAt) parts.push(`next ${formatTime(status.nextRunAt)}`);
  if (status.lastError) parts.push(`error: ${status.lastError}`);
  $("#background-state").textContent = parts.join(" · ");
}

function renderRoots(roots = []) {
  if (!roots.length) return "";
  return `<ul class="root-list">${roots.map((root) => `<li>${escapeHtml(root)}</li>`).join("")}</ul>`;
}

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const name = item[key] || "unknown";
    const current = map.get(name) || {
      name,
      totalTokens: 0,
      estimatedCostUsd: 0,
      costQuality: "",
      pricingVersion: ""
    };
    const withCost = addCostToUsageItem(item, activePriceMap());
    current.totalTokens += item.totalTokens || 0;
    aggregateCost(current, withCost);
    map.set(name, current);
  }
  return [...map.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((item) => ({ ...item, missingPriceModels: sortedBreakdown(item.missingPriceModels || {}) }));
}

function groupTrend(items) {
  const meta = trendViewMeta();
  const allowedDays = new Set(daysForTrendView(trendView));
  const map = new Map();
  for (const item of items) {
    if (!allowedDays.has(item.day)) continue;
    const bucket = bucketForDay(item.day, meta.grain);
    const row =
      map.get(bucket.key) ||
      {
        periodStart: bucket.periodStart,
        periodEnd: bucket.periodEnd,
        models: new Set(),
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        costQuality: "",
        modelMap: {},
        workdirMap: {},
        modelDetailMap: {}
      };
    const withCost = addCostToUsageItem(item, activePriceMap());
    const modelDetailKey = `${item.workdirDisplayName || "unknown"}|${item.model || "unknown"}`;
    const modelDetail = row.modelDetailMap[modelDetailKey] || {
      workdirDisplayName: item.workdirDisplayName || "unknown",
      model: item.model || "unknown",
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      costQuality: "",
      pricingVersion: ""
    };
    row.models.add(item.model || "unknown");
    row.modelMap[item.model || "unknown"] = (row.modelMap[item.model || "unknown"] || 0) + (item.totalTokens || 0);
    row.workdirMap[item.workdirDisplayName || "unknown"] = (row.workdirMap[item.workdirDisplayName || "unknown"] || 0) + (item.totalTokens || 0);
    row.inputTokens += item.inputTokens || 0;
    row.outputTokens += item.outputTokens || 0;
    row.reasoningTokens += item.reasoningTokens || 0;
    row.cacheReadTokens += item.cacheReadTokens || 0;
    row.cacheWriteTokens += item.cacheWriteTokens || 0;
    row.totalTokens += item.totalTokens || 0;
    aggregateCost(row, withCost);
    modelDetail.inputTokens += item.inputTokens || 0;
    modelDetail.outputTokens += item.outputTokens || 0;
    modelDetail.reasoningTokens += item.reasoningTokens || 0;
    modelDetail.cacheReadTokens += item.cacheReadTokens || 0;
    modelDetail.cacheWriteTokens += item.cacheWriteTokens || 0;
    modelDetail.totalTokens += item.totalTokens || 0;
    aggregateCost(modelDetail, withCost);
    row.modelDetailMap[modelDetailKey] = modelDetail;
    map.set(bucket.key, row);
  }
  return [...map.values()]
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart))
    .map((row) => ({
      ...row,
      compositionSummary: tokenCompositionSummary(row),
      missingPriceModels: sortedBreakdown(row.missingPriceModels || {}),
      modelBreakdown: sortedBreakdown(row.modelMap || {}),
      workdirBreakdown: sortedBreakdown(row.workdirMap || {}),
      modelDetails: Object.values(row.modelDetailMap || {}).sort((a, b) => b.totalTokens - a.totalTokens),
      models: [...row.models].sort()
    }));
}

function groupWorkdirs(items) {
  const map = new Map();
  for (const item of items) {
    const row = map.get(item.workdirHash) || {
      workdirHash: item.workdirHash,
      name: item.workdirDisplayName,
      totalTokens: 0
    };
    row.totalTokens += item.totalTokens || 0;
    map.set(item.workdirHash, row);
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function renderBars(items, { showCost = false } = {}) {
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  return items
    .map((item) => `<article class="bar-row">
      <div>
        <strong>${escapeHtml(item.name)}</strong>
        <small title="${formatTokenRaw(item.totalTokens)}">${formatToken(item.totalTokens)} tokens</small>
        ${showCost ? `<em title="${escapeHtml(costTitle(item))}">${renderCost(item)}</em>` : ""}
      </div>
      <i style="width:${Math.max(3, (item.totalTokens / max) * 100)}%"></i>
    </article>`)
    .join("");
}

function renderCompositionTiles(item) {
  return tokenCompositionDetails(item)
    .map((entry) => `<article class="summary-tile composition-tile">
      <span>${escapeHtml(entry.label)}</span>
      <strong title="${formatTokenRaw(entry.tokens)}">${formatToken(entry.tokens)}</strong>
      <small>${Math.round(entry.ratio * 100)}%${latestConfig?.showEstimatedCost ? ` · ${formatUsd(costValueForField(item, entry.field))}` : ""}</small>
    </article>`)
    .join("");
}

function renderTrendSelection(row) {
  if (!row) return "";
  return `<section class="section-block">
    <div class="section-title">
      <h3>${formatTrendPeriod(row)}</h3>
      <p>${escapeHtml(row.compositionSummary || tokenCompositionSummary(row))}</p>
    </div>
    <div class="detail-summary composition-grid">
      ${renderCompositionTiles(row)}
    </div>
    <div class="detail-grid">
      <section>
        <h3>Top models</h3>
        <div class="breakdown">${renderCompactBreakdown(row.modelBreakdown)}</div>
      </section>
      <section>
        <h3>Top workdirs</h3>
        <div class="breakdown">${renderCompactBreakdown(row.workdirBreakdown)}</div>
      </section>
    </div>
    ${renderTrendModelDetails(row)}
    ${latestConfig?.showEstimatedCost ? `<p class="subtle">${escapeHtml(costQualityLabel(row.costQuality))} · ${renderCost(row).replace(/<[^>]+>/g, "")}</p>` : ""}
  </section>`;
}

function renderTrendDrawer(rows) {
  const row = rows.find((item) => trendBucketKey(item) === trendDrawerBucketKey);
  const open = trendMode === "table" && Boolean(row);
  if (trendDrawerCloseTimer) clearTimeout(trendDrawerCloseTimer);
  if (!open) {
    animateTrendDrawerClosed();
    return;
  }
  $("#trend-drawer").hidden = false;
  $("#trend-drawer-backdrop").hidden = false;
  $("#trend-drawer-title").textContent = formatTrendPeriod(row);
  $("#trend-drawer-body").innerHTML = renderTrendSelection(row);
  requestAnimationFrame(() => {
    $("#trend-drawer").classList.add("is-open");
    $("#trend-drawer-backdrop").classList.add("is-open");
    document.body.classList.add("trend-drawer-open");
  });
}

function closeTrendDrawer() {
  trendDrawerBucketKey = "";
  animateTrendDrawerClosed();
}

function animateTrendDrawerClosed() {
  $("#trend-drawer").classList.remove("is-open");
  $("#trend-drawer-backdrop").classList.remove("is-open");
  document.body.classList.remove("trend-drawer-open");
  if ($("#trend-drawer").hidden) return;
  trendDrawerCloseTimer = setTimeout(() => {
    $("#trend-drawer").hidden = true;
    $("#trend-drawer-backdrop").hidden = true;
    $("#trend-drawer-body").innerHTML = "";
  }, 180);
}

function renderTrendModelDetails(row) {
  const details = row.modelDetails || [];
  if (!details.length) return "";
  return `<section class="trend-model-details">
    <div class="section-title">
      <h3>Model detail</h3>
      <p>Grouped by workdir and model for this period.</p>
    </div>
    <div class="table-wrap">
      <table class="trend-table model-detail-table">
        <thead>
          <tr>
            <th>Workdir</th>
            <th>Model</th>
            <th>Tokens</th>
            <th>Input</th>
            <th>Output</th>
            <th>Cache</th>
            <th>Reasoning</th>
            ${latestConfig?.showEstimatedCost ? "<th>Est. Cost</th>" : ""}
          </tr>
        </thead>
        <tbody>
          ${details.map((item) => `<tr>
            <td>${escapeHtml(item.workdirDisplayName)}</td>
            <td>${escapeHtml(item.model)}</td>
            <td class="numeric" title="${formatTokenRaw(item.totalTokens)}">${formatToken(item.totalTokens)}</td>
            <td class="numeric" title="${formatTokenRaw(item.inputTokens)}">${renderAccountingToken(item.inputTokens, item.inputCostUsd)}</td>
            <td class="numeric" title="${formatTokenRaw(item.outputTokens)}">${renderAccountingToken(item.outputTokens, item.outputCostUsd)}</td>
            <td class="numeric" title="${formatTokenRaw((item.cacheReadTokens || 0) + (item.cacheWriteTokens || 0))}">${renderAccountingToken((item.cacheReadTokens || 0) + (item.cacheWriteTokens || 0), sumKnownCosts(item.cacheReadCostUsd, item.cacheWriteCostUsd))}</td>
            <td class="numeric" title="${formatTokenRaw(item.reasoningTokens)}">${renderAccountingToken(item.reasoningTokens, item.reasoningCostUsd)}</td>
            ${latestConfig?.showEstimatedCost ? `<td class="numeric" title="${escapeHtml(costTitle(item))}">${renderCost(item)}</td>` : ""}
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
  </section>`;
}

function aggregateComposition(items) {
  return items.reduce((current, item) => ({
    inputTokens: current.inputTokens + Number(item.inputTokens || 0),
    outputTokens: current.outputTokens + Number(item.outputTokens || 0),
    cacheReadTokens: current.cacheReadTokens + Number(item.cacheReadTokens || 0),
    cacheWriteTokens: current.cacheWriteTokens + Number(item.cacheWriteTokens || 0),
    reasoningTokens: current.reasoningTokens + Number(item.reasoningTokens || 0),
    totalTokens: current.totalTokens + Number(item.totalTokens || 0)
  }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  });
}

function trendBucketKey(row) {
  return `${row.periodStart}|${row.periodEnd}`;
}

function humanDominant(value = "") {
  return {
    "input-heavy": "Input-heavy",
    "output-heavy": "Output-heavy",
    "cache-heavy": "Cache-heavy",
    "reasoning-heavy": "Reasoning-heavy",
    "no-usage": "No usage"
  }[value] || value || "-";
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

function renderAccountingToken(tokens, cost) {
  const costLine = latestConfig?.showEstimatedCost ? `<small>${formatUsd(cost)}</small>` : "";
  return `<span class="token-accounting">${formatToken(tokens || 0)}${costLine}</span>`;
}

function sumKnownCosts(...values) {
  const known = values.filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
  if (!known.length) return null;
  return known.reduce((sum, value) => sum + Number(value), 0);
}

function renderTrendDashboard(rows) {
  const chronological = [...rows].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const latest = rows[0];
  const peak = rows.reduce((current, row) => (row.totalTokens > current.totalTokens ? row : current), rows[0]);
  const total = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  const cost = aggregateTrendRowCost(rows);
  const recent = rows.slice(0, 5);
  return `<div class="trend-dashboard">
    <div class="trend-summary-grid">
      ${renderTrendMetric("Latest", formatToken(latest.totalTokens), formatTrendPeriod(latest), metricTitle(latest))}
      ${renderTrendMetric("Peak", formatToken(peak.totalTokens), formatTrendPeriod(peak), metricTitle(peak))}
      ${renderTrendMetric("View total", formatToken(total), `${rows.length} ${trendViewMeta().bucketLabel}${rows.length === 1 ? "" : "s"}`, formatTokenRaw(total))}
      ${latestConfig?.showEstimatedCost ? renderTrendMetric("Cost", renderCost(cost), pricingSource, costTitle(cost)) : renderTrendMetric("Dominant", humanDominant(dominantComposition(latest)), tokenCompositionSummary(latest), metricTitle(latest))}
    </div>
    ${renderTrendTimeline(chronological, latest, peak)}
    <section class="recent-contribution">
      <h3>Recent contribution</h3>
      <div class="recent-list">
        ${recent
          .map((row) => `<article>
            <header>
              <strong>${formatTrendPeriod(row)}</strong>
              <span title="${escapeHtml(metricTitle(row))}">${formatToken(row.totalTokens)}</span>
            </header>
            <p title="${escapeHtml(summaryTitle(row.modelBreakdown))}">${escapeHtml(summaryLabel(row.modelBreakdown))}</p>
            <p title="${escapeHtml(summaryTitle(row.workdirBreakdown))}">${escapeHtml(summaryLabel(row.workdirBreakdown))}</p>
            ${latestConfig?.showEstimatedCost ? `<em title="${escapeHtml(costTitle(row))}">${renderCost(row)}</em>` : ""}
          </article>`)
          .join("")}
      </div>
    </section>
  </div>`;
}

function aggregateTrendRowCost(rows) {
  const current = {
    estimatedCostUsd: 0,
    costQuality: "",
    pricingVersion: "",
    missingPriceTokens: 0,
    missingPriceModels: {}
  };
  for (const row of rows) {
    if (row.hasKnownPrice) {
      current.hasKnownPrice = true;
      current.estimatedCostUsd += row.estimatedCostUsd || 0;
      current.costQuality = mergeCostQualityForDisplay(current.costQuality, row.costQuality);
      current.pricingVersion ||= row.pricingVersion || "";
    }
    for (const item of row.missingPriceModels || []) {
      current.missingPriceModels[item.name] = (current.missingPriceModels[item.name] || 0) + (item.totalTokens || 0);
      current.missingPriceTokens += item.totalTokens || 0;
      current.costQuality = mergeCostQualityForDisplay(current.costQuality, "unknown_price");
    }
  }
  current.missingPriceModels = sortedBreakdown(current.missingPriceModels);
  return current;
}

function mergeCostQualityForDisplay(left = "", right = "") {
  const rank = { exact_price: 0, estimated_price: 1, unknown_price: 2 };
  if (!left) return right || "";
  if (!right) return left;
  return rank[right] > rank[left] ? right : left;
}

function renderTrendMetric(label, value, note, title = "") {
  return `<article class="trend-metric"${title ? ` title="${escapeHtml(title)}"` : ""}>
    <span>${escapeHtml(label)}</span>
    <strong>${value}</strong>
    <small>${escapeHtml(note)}</small>
  </article>`;
}

function renderTrendTimeline(rows, latest, peak) {
  const max = Math.max(...rows.map((item) => item.totalTokens), 1);
  return `<div class="trend-timeline">
    ${rows
        .map((row) => {
          const title = escapeHtml(metricTitle(row));
          return `<button type="button" data-select-trend="${escapeHtml(trendBucketKey(row))}" class="${row === latest ? "latest" : ""} ${row === peak ? "peak" : ""} ${selectedTrendBucketKey === trendBucketKey(row) ? "selected" : ""}" style="height:${Math.max(4, (row.totalTokens / max) * 100)}%" title="${title}" data-tooltip="${title}"></button>`;
        })
      .join("")}
  </div>
  <div class="timeline-axis">
    <span>${formatTrendPeriod(rows[0])}</span>
    <strong>Peak ${formatTrendPeriod(peak)}</strong>
    <span>${formatTrendPeriod(rows.at(-1))}</span>
  </div>`;
}

function sourceName(providerId) {
  if (providerId === "codex_local") return "Codex";
  if (providerId === "claude_code_local") return "Claude Code";
  if (providerId === "cursor_dashboard_usage") return "Cursor";
  return providerId;
}

async function run(fn) {
  try {
    await fn();
  } catch (error) {
    $("#sync-state").textContent = "Action failed";
    setSaveMessage(error.message, "error");
    console.error(error);
  }
}

function setSaveMessage(message, tone = "") {
  const target = $("#settings-save-message");
  if (!target) return;
  target.textContent = message || "";
  target.dataset.tone = tone;
  target.title = message || "";
}

function normalizeApiBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
}

function costTitle(item) {
  const missing = normalizeMissingPriceModels(item.missingPriceModels).map((model) => `${model.name} ${formatTokenRaw(model.totalTokens)}`).join(", ");
  return `${item.costQuality || "unknown_price"} · ${item.pricingVersion || "no pricing version"} · ${pricingSource}${missing ? ` · missing: ${missing}` : ""}`;
}

function normalizeMissingPriceModels(value) {
  if (Array.isArray(value)) return value;
  return sortedBreakdown(value || {});
}

function renderCost(item) {
  const value = renderCostValue(item);
  if (value === "-") return value;
  return `${value}${item.missingPriceTokens ? " *" : ""}`;
}

function renderCostValue(item) {
  if (!item.hasKnownPrice && item.missingPriceTokens > 0) return "-";
  return formatUsd(item.estimatedCostUsd);
}

function aggregateUsageCost(items) {
  const current = {
    estimatedCostUsd: 0,
    costQuality: "",
    pricingVersion: "",
    missingPriceTokens: 0,
    missingPriceModels: {}
  };
  for (const item of items) aggregateCost(current, addCostToUsageItem(item, activePriceMap()));
  return { ...current, missingPriceModels: sortedBreakdown(current.missingPriceModels || {}) };
}

function activePriceMap() {
  return serverPriceMap || createPriceMap();
}

async function refreshPricing() {
  if (!latestConfig?.showEstimatedCost) return;
  if (!latestConfig?.apiBaseUrl) {
    serverPriceMap = null;
    pricingSource = "server pricing unavailable";
    return;
  }
  try {
    const data = await api.modelPrices();
    serverPriceMap = createPriceMap(
      Object.fromEntries((data?.custom || []).map((item) => [item.model, item])),
      Object.fromEntries((data?.openrouter || []).map((item) => [item.model, item]))
    );
    pricingSource = data?.remote?.status ? `server pricing · OpenRouter ${data.remote.status}` : "server pricing";
  } catch (error) {
    serverPriceMap = null;
    pricingSource = `server pricing unavailable: ${error.message}`;
  }
}

function sortedBreakdown(obj) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([name, totalTokens]) => ({ name, totalTokens }));
}

function formatToken(value) {
  return latestConfig?.showRawTokens ? formatNumber(value) : formatTokenCompact(value);
}

function metricTitle(row) {
  const cost = latestConfig?.showEstimatedCost ? ` · cost ${renderCost(row)}` : "";
  return `${formatTrendPeriod(row)} · ${formatTokenRaw(row.totalTokens)}${cost}`;
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(value) {
  const date = new Date(value);
  return `${date.toLocaleDateString([], { month: "short", day: "2-digit" })} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function formatDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit", year: "numeric", timeZone: "UTC" }).format(date);
}

function formatTrendPeriod(row) {
  if (row.periodStart === row.periodEnd) return formatDate(row.periodStart);
  return `${formatDate(row.periodStart)} - ${formatDate(row.periodEnd)}`;
}

function trendViewMeta() {
  if (trendView === "weekly") {
    return { grain: "week", heading: "Weekly review", bucketLabel: "week bucket", summary: "last 12 weeks" };
  }
  if (trendView === "monthly") {
    return { grain: "month", heading: "Monthly review", bucketLabel: "month bucket", summary: "last 12 months" };
  }
  return { grain: "day", heading: "Daily review", bucketLabel: "day bucket", summary: "last 30 days" };
}

function daysForTrendView(view) {
  if (view === "weekly") return daysForLastWeeks(12);
  if (view === "monthly") return daysForLastMonths(12);
  return trailingDays(30);
}

function trailingDays(count) {
  const today = utcToday();
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(today);
    day.setUTCDate(today.getUTCDate() - count + index + 1);
    return toDay(day);
  });
}

function daysForMonth(offset) {
  const today = utcToday();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + offset, 1));
  const end = offset === 0 ? today : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  const days = [];
  for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    days.push(toDay(day));
  }
  return days;
}

function daysForLastWeeks(count) {
  const today = utcToday();
  const start = startOfUtcWeek(today);
  start.setUTCDate(start.getUTCDate() - ((count - 1) * 7));
  const days = [];
  for (const day = new Date(start); day <= today; day.setUTCDate(day.getUTCDate() + 1)) {
    days.push(toDay(day));
  }
  return days;
}

function daysForLastMonths(count) {
  const today = utcToday();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - count + 1, 1));
  const days = [];
  for (const day = new Date(start); day <= today; day.setUTCDate(day.getUTCDate() + 1)) {
    days.push(toDay(day));
  }
  return days;
}

function renderCompactBreakdown(items = []) {
  if (!items.length) return "-";
  return items
    .slice(0, 3)
    .map((item) => `<div title="${formatTokenRaw(item.totalTokens)}">${escapeHtml(item.name)} ${formatToken(item.totalTokens)}</div>`)
    .join("");
}

function summaryLabel(items = []) {
  if (!items.length) return "-";
  const top = items.slice(0, 2).map((item) => item.name).join(", ");
  return items.length > 2 ? `${top} +${items.length - 2}` : top;
}

function summaryTitle(items = []) {
  return items.map((item) => `${item.name} ${formatTokenRaw(item.totalTokens)}`).join(", ");
}

function bucketForDay(day, grain) {
  const date = new Date(`${day}T00:00:00Z`);
  if (grain === "month") {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    return { key: toDay(start), periodStart: toDay(start), periodEnd: toDay(end) };
  }
  if (grain === "week") {
    const start = startOfUtcWeek(date);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    return { key: toDay(start), periodStart: toDay(start), periodEnd: toDay(end) };
  }
  return { key: day, periodStart: day, periodEnd: day };
}

function startOfUtcWeek(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - weekday + 1);
  return start;
}

function utcToday() {
  return dayToUtcDate(localDay());
}

function toDay(date) {
  return utcDateToDay(date);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function cssEscape(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

boot().catch((error) => {
  $("#sync-state").textContent = error.message;
});
