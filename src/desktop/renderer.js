import { dominantComposition, tokenCompositionSummary } from "../shared/composition.js";
import { addCostToUsageItem, aggregateCost, createPriceMap } from "../shared/pricing.js";
import { formatTokenCompact, formatTokenRaw, formatUsd } from "../shared/display.js";
import { dayToUtcDate, localDay, utcDateToDay } from "../shared/date.js";
import { initI18n, setLang, t, getCurrentLang, createLangSwitcher, bindLangSwitcher, updatePageTranslations } from "../shared/i18n.js";

import {
  escapeHtml as _escapeHtml, cssEscape as _cssEscape, clampHour as _clampHour,
  formatNumber as _formatNumber, formatHourLabel as _formatHourLabel,
  formatTime as _formatTime, formatDateTime as _formatDateTime,
  formatBytes as _formatBytes, formatDate as _formatDate,
  formatTrendPeriod as _formatTrendPeriod, formatAxisLabel as _formatAxisLabel,
  formatDetailBreakdownPeriod as _formatDetailBreakdownPeriod,
  hasPositiveUsage as _hasPositiveUsage, hasConfiguredApiBaseUrl as _hasConfiguredApiBaseUrl,
  normalizeApiBaseUrl as _normalizeApiBaseUrl, startOfUtcWeek as _startOfUtcWeek,
  trailingDays as _trailingDays, daysForLastWeeks as _daysForLastWeeks,
  daysForLastMonths as _daysForLastMonths, bucketForDay as _bucketForDay,
  renderCostValue as _renderCostValue, renderCostAmountValue as _renderCostAmountValue,
  renderCost as _renderCost, renderCostAmount as _renderCostAmount,
  costValueForField as _costValueForField, cacheTokens as _cacheTokens,
  sumKnownCosts as _sumKnownCosts, mergeCostQualityForDisplay as _mergeCostQualityForDisplay,
  costTitle as _costTitle, renderAccountingToken as _renderAccountingToken,
  sortedBreakdown as _sortedBreakdown, finalizeCostBreakdown as _finalizeCostBreakdown,
  addCostBreakdownItem as _addCostBreakdownItem, aggregateUsageCost as _aggregateUsageCost,
  aggregateTrendRowCost as _aggregateTrendRowCost, normalizeMissingPriceModels as _normalizeMissingPriceModels,
  trendBucketKey as _trendBucketKey, emptyTrendRow as _emptyTrendRow,
  summaryLabel as _summaryLabel, summaryTitle as _summaryTitle,
  positiveInteger as _positiveInteger, normalizeTokenAggregate as _normalizeTokenAggregate,
  normalizeBreakdownItems as _normalizeBreakdownItems,
  normalizeUsageSummary as _normalizeUsageSummary,
  normalizeUsageTrend as _normalizeUsageTrend,
  normalizeUsageWorkdirs as _normalizeUsageWorkdirs,
  normalizeUsageTotal as _normalizeUsageTotal,
  reconcileHealthWithConfig as _reconcileHealthWithConfig
} from "./renderer-helpers.js";

import {
  sourceName as _sourceName, sourceDescription as _sourceDescription,
  sourceSummary as _sourceSummary, daysForRange as _daysForRange,
  usageForRange as _usageForRange, rangeLabel as _rangeLabel,
  overviewTrendGrain as _overviewTrendGrain, railCloudStatus as _railCloudStatus,
  deriveRailSyncStatus as _deriveRailSyncStatus,
  groupBy as _groupBy, groupProviders as _groupProviders,
  groupByGrain as _groupByGrain, groupByHour as _groupByHour,
  groupTrend as _groupTrend, groupWorkdirs as _groupWorkdirs,
  groupWorkdirDetails as _groupWorkdirDetails, groupDailyRows as _groupDailyRows,
  aggregateComposition as _aggregateComposition,
  aggregatePeriodRow as _aggregatePeriodRow
} from "./renderer-data.js";

import {
  formatToken as _formatToken, localeTokenCompact as _localeTokenCompact,
  visibleCompositionFields as _visibleCompositionFields,
  visibleCompositionEntries as _visibleCompositionEntries,
  renderCompositionTiles as _renderCompositionTiles,
  renderMiniMeters as _renderMiniMeters, renderDetailMeters as _renderDetailMeters,
  renderWorkdirCards as _renderWorkdirCards, renderSparkBarValue as _renderSparkBarValue,
  renderCompactBreakdown as _renderCompactBreakdown,
  sourceSwitchButton as _sourceSwitchButton,
  updateSourceSwitchButton as _updateSourceSwitchButton,
  renderTrendDashboard as _renderTrendDashboard,
  renderTrendSelection as _renderTrendSelection,
  renderTrendDetailHero as _renderTrendDetailHero,
  renderTrendDetailBreakdown as _renderTrendDetailBreakdown
} from "./renderer-components.js";

import {
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  POLAROID_EXPORT_WIDTH,
  POLAROID_EXPORT_HEIGHT,
  normalizeCloudShareData,
  normalizeLocalShareData,
  polaroidExportCss,
  randomShareQuoteIndex,
  renderExportPolaroidHtml,
  renderShareCardHtml,
  shareCardCss,
  sharePeriodBounds,
  shareRangeForPeriod,
  shareTrendGrain,
  withCloudPending
} from "./share-card.js";

import html2canvas from "./vendor/html2canvas.js";

// 初始化多语言
const currentLang = initI18n();

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MODEL_DETAIL_VIRTUAL_THRESHOLD = 120;
const MODEL_DETAIL_ROW_HEIGHT = 44;
const MODEL_DETAIL_OVERSCAN = 8;
const FULL_USAGE_RENDER_CACHE_LIMIT = 5000;

function localeTokenCompact(value) {
  return formatTokenCompact(value, getCurrentLang());
}

const api = window.tokenLeague;
const $ = (selector) => document.querySelector(selector);
const AUTO_BACKUP_DAILY_START = { hour: 0, minute: 0 };

document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

function logRuntimeEvent(event, data = {}, level = "info") {
  if (!api?.logEvent) return;
  api.logEvent({ source: "renderer", event, level, data }).catch(() => {});
}

window.addEventListener("error", (event) => {
  logRuntimeEvent("renderer_error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno
  }, "error");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason || {};
  logRuntimeEvent("renderer_unhandled_rejection", {
    message: reason.message || String(reason),
    stack: reason.stack || ""
  }, "error");
});

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
let pricingSource = t("desktop.renderer.localFallbackPricing");
let latestScanAt = "";
let scanRunning = false;
let scanPollTimer = null;
let scanPollInFlight = false;
let backgroundStatusTimer = null;
let backgroundStatusInFlight = null;
let backgroundStatusQueuedArgs = null;
let latestUpdateState = null;
let updateDownloadedPersisted = false;
let updateInstallRunning = false;
let downloadedEventReceived = false;
let latestBackgroundStatus = null;
let latestBackupStatus = null;
let latestDiagnosticsStatus = null;
let latestIdentityBusinessDay = "";
let latestClientInfo = null;
let lastIdentityCheckLocalDay = localDay();
let identityRefreshTimer = null;
let updateCheckTimer = null;
let updateCheckInFlight = null;
let runtimeEventHandlersRegistered = false;
let overviewRange = "today";
let workdirsRange = "today";
let latestShareData = null;
let sourcesProviderTab = "claude_code_local";
let latestSyncInfo = "";
let pricingRefreshPromise = null;
let mandatoryUpdateActive = false;
let latestTrayCostKey = "";
let foregroundSyncRunning = false;
let latestLocalSnapshot = null;
let latestUsageScanStatus = null;
let latestBrandLogoUrl = null;
let nextVirtualModelDetailId = 1;
let usageQueryGeneration = 0;
let usageQueryRefreshRunning = false;
let usageQueryRefreshPending = false;
const virtualModelDetailTables = new Map();
const usageQueryState = {
  summaries: new Map(),
  trends: new Map(),
  workdirs: new Map(),
  lastRowCount: 0
};

function showToast(message) {
  const toast = document.querySelector("#toast");
  if (!toast || !message) return;
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 1800);
}

let appConfirmResolver = null;
let importModeResolver = null;

function chooseImportMode() {
  const modal = $("#import-mode-modal");
  if (!modal) return Promise.resolve(null);
  if (importModeResolver) importModeResolver(null);
  modal.hidden = false;
  return new Promise((resolve) => { importModeResolver = resolve; });
}

function closeImportModeModal(mode) {
  const modal = $("#import-mode-modal");
  if (modal) modal.hidden = true;
  if (!importModeResolver) return;
  const resolve = importModeResolver;
  importModeResolver = null;
  resolve(mode);
}

function confirmDialog(message, { alertOnly = false } = {}) {
  const modal = $("#app-confirm-modal");
  const messageEl = $("#app-confirm-message");
  const okButton = $("#app-confirm-ok");
  const cancelButton = $("#app-confirm-cancel");
  if (!modal || !messageEl || !okButton || !cancelButton) return Promise.resolve(false);
  if (appConfirmResolver) appConfirmResolver(false);
  messageEl.textContent = message || "";
  cancelButton.hidden = alertOnly;
  modal.hidden = false;
  okButton.focus();
  return new Promise((resolve) => {
    appConfirmResolver = resolve;
  });
}

function closeConfirmDialog(result) {
  const modal = $("#app-confirm-modal");
  if (modal) modal.hidden = true;
  if (!appConfirmResolver) return;
  const resolve = appConfirmResolver;
  appConfirmResolver = null;
  resolve(Boolean(result));
}

function setStatusMessage(message) {
  const el = document.querySelector("#sync-state");
  if (el) el.textContent = message;
}

document.querySelectorAll("nav button").forEach((button) => {
  button.addEventListener("click", () => {
    logRuntimeEvent("navigation_click", { section: button.dataset.section || "" });
    handlePrimaryNavigationClick(button.dataset.section);
  });
});

document.querySelectorAll('[data-section="settings"]').forEach((button) => {
  button.addEventListener("click", () => {
    selectSection("settings");
    run(loadBackgroundStatus);
  });
});

$("#brand-refresh").addEventListener("click", () => {
  if (scanRunning || $("#brand-refresh").disabled) return;
  logRuntimeEvent("refresh_click", { location: "brand" });
  run(() => loadToday(true));
});

$("#rail-restart-update").addEventListener("click", () => run(async () => {
  logRuntimeEvent("update_restart_click");
  await installAndRestartUpdate();
}));
$("#refresh-health").addEventListener("click", () => run(async () => {
  logRuntimeEvent("source_health_refresh_click");
  await loadHealth();
}));
document.querySelectorAll("[data-sync-now]").forEach((button) => button.addEventListener("click", () => {
  logRuntimeEvent("sync_now_click", { location: button.dataset.syncNow || "" });
  run(syncNow);
}));
const railCloudStatus = $("#rail-cloud-status");
if (railCloudStatus) railCloudStatus.addEventListener("click", () => {
  const syncStatus = currentRailSyncStatus();
  logRuntimeEvent("rail_sync_status_click", { state: syncStatus.state || "", reason: syncStatus.reason || "" });
  if (syncStatus.action === "sync_now" || syncStatus.action === "retry_sync") {
    run(() => loadToday(true));
    return;
  }
  selectSection("settings");
  const cloudTab = $("[data-settings-tab='cloud']");
  if (cloudTab) cloudTab.click();
});
const syncPrimaryAction = $("#cloud-sync-primary-action");
if (syncPrimaryAction) syncPrimaryAction.addEventListener("click", () => {
  const action = syncPrimaryAction.dataset.syncAction;
  if (action === "configure_cloud" || action === "open_settings") {
    selectSection("settings");
    const cloudTab = $("[data-settings-tab='cloud']");
    if (cloudTab) cloudTab.click();
  } else if (action === "sync_now" || action === "retry_sync") {
    run(syncNow);
  } else if (action === "check_connection") {
    run(async () => { await refreshApiConnection(); });
  } else if (action === "update_client") {
    run(async () => {
      selectSection("settings");
      selectSettingsTab("cloud");
      $("#check-update")?.scrollIntoView({ block: "center", behavior: "smooth" });
      await checkUpdate({ automatic: false });
    });
  }
});
$("#wizard-skip").addEventListener("click", (e) => { e.preventDefault(); run(skipWizard); });
$("#wizard-next-0").addEventListener("click", () => wizardGo(1));
$("#wizard-back-1").addEventListener("click", () => wizardGo(0));
$("#wizard-create-identity").addEventListener("click", () => setWizardIdentityMode("create"));
$("#wizard-import").addEventListener("click", () => setWizardIdentityMode("import"));
$("#wizard-import-join")?.addEventListener("click", () => run(() => wizardImportProfile("join_existing_participant")));
$("#wizard-import-restore")?.addEventListener("click", () => run(() => wizardImportProfile("restore_device")));
$("#wizard-next-1").addEventListener("click", () => wizardGo(2));
$("#wizard-back-2").addEventListener("click", () => wizardGo(1));
$("#wizard-start").addEventListener("click", () => run(finishWizard));
document.querySelectorAll("[data-wizard-sync-mode]").forEach((button) => {
  button.addEventListener("click", () => setWizardSyncMode(button.dataset.wizardSyncMode || "cloud"));
});
$("#wizard-api-base-url")?.addEventListener("input", renderWizardSummary);
$("#wizard-nickname")?.addEventListener("input", renderWizardSummary);
document.addEventListener("click", (event) => {
  const btn = event.target.closest("#add-codex-root");
  if (btn) run(() => addProviderRoot("codex_local"));
});
document.addEventListener("click", (event) => {
  const btn = event.target.closest("#add-claude-root");
  if (btn) run(() => addProviderRoot("claude_code_local"));
});
document.addEventListener("click", (event) => {
  const btn = event.target.closest("#connect-cursor");
  if (btn) run(connectCursor);
});
document.addEventListener("click", (event) => {
  const btn = event.target.closest("#add-cursor-token");
  if (btn) {
    event.preventDefault();
    if (event.altKey) openCursorTokenModal();
  }
});
$("#save-cursor-token").addEventListener("click", () => run(addCursorToken));
$("#import-mode-join").addEventListener("click", () => closeImportModeModal("join_existing_participant"));
$("#import-mode-restore").addEventListener("click", () => closeImportModeModal("restore_device"));
$("#import-mode-cancel").addEventListener("click", () => closeImportModeModal(null));
$("#import-mode-modal").addEventListener("click", (event) => {
  if (event.target.id === "import-mode-modal") closeImportModeModal(null);
});
$("#cursor-token-modal").addEventListener("click", (event) => {
  if (event.target.id === "cursor-token-modal" || event.target.closest("#cancel-cursor-token")) closeCursorTokenModal();
});
$("#cursor-connect-modal").addEventListener("click", (event) => {
  if (event.target.closest("#cancel-cursor-connect")) run(cancelCursorConnect);
});
$("#reset-confirm-modal").addEventListener("click", (event) => {
  if (event.target.id === "reset-confirm-modal" || event.target.closest("#reset-cancel")) closeResetConfirmModal();
});
$("#share-card-modal").addEventListener("click", (event) => {
  if (event.target.id === "share-card-modal" || event.target.closest("#close-share-card")) closeShareCardModal();
});
$("#app-confirm-modal").addEventListener("click", (event) => {
  if (event.target.id === "app-confirm-modal" || event.target.closest("#app-confirm-cancel")) closeConfirmDialog(false);
  if (event.target.closest("#app-confirm-ok")) closeConfirmDialog(true);
});
$("#reset-local-only").addEventListener("click", () => run(resetLocalOnly));
$("#reset-with-cloud").addEventListener("click", () => run(resetWithCloud));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#cursor-token-modal").hidden) closeCursorTokenModal();
  if (event.key === "Escape" && !$("#cursor-connect-modal").hidden) run(cancelCursorConnect);
  if (event.key === "Escape" && !$("#reset-confirm-modal").hidden) closeResetConfirmModal();
  if (event.key === "Escape" && !$("#share-card-modal").hidden) closeShareCardModal();
  if (event.key === "Escape" && !$("#app-confirm-modal").hidden) closeConfirmDialog(false);
  if (event.key === "Escape" && !$("#trend-drawer").hidden) closeTrendDrawer();
});
$("#close-trend-drawer").addEventListener("click", closeTrendDrawer);
$("#trend-drawer-backdrop").addEventListener("click", closeTrendDrawer);
$("#settings-source-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-toggle-source]");
  if (!button) return;
  run(() => toggleSource(button.dataset.toggleSource));
});
$("#sources-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-provider-tab]");
  if (!button) return;
  sourcesProviderTab = button.dataset.providerTab;
  $("#sources-tabs").querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
  renderHealth();
});
$("#overview-range").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-range]");
  if (!button) return;
  overviewRange = button.dataset.range;
  setSegmentActive($("#overview-range"), overviewRange);
  renderToday();
  refreshUsageQuerySurfaces().catch(console.error);
});
$("#open-share-card").addEventListener("click", () => {
  if (scanRunning) return showToast(t("desktop.renderer.scanningLocal"));
  const total = getOverviewTotalTokens();
  if (!total) return;
  run(openShareCardModal);
});
$("#copy-share-card").addEventListener("click", () => run(copyShareCardImage));
$("#save-share-card").addEventListener("click", () => run(() => saveShareCardImage()));
$("#workdirs-range").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-range]");
  if (!button) return;
  workdirsRange = button.dataset.range;
  setSegmentActive($("#workdirs-range"), workdirsRange);
  renderWorkdirs();
  refreshUsageQuerySurfaces().catch(console.error);
});
$("#settings-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  selectSettingsTab(button.dataset.settingsTab);
  if (button.dataset.settingsTab === "cloud") run(async () => {
    await loadCloudStatus();
    await loadBackgroundStatus();
    if (shouldCheckUpdateOnCloudOpen()) await checkUpdate({ automatic: true });
  });
  if (button.dataset.settingsTab === "about") run(loadSystemStatus);
});
document.addEventListener("focusout", (event) => {
  const input = event.target.closest("[data-alias-input]");
  if (!input) return;
  run(async () => saveAliasInput(input));
});
document.addEventListener("keydown", (event) => {
  const input = event.target.closest("[data-alias-input]");
  if (!input || event.key !== "Enter") return;
  event.preventDefault();
  input.blur();
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-workdir]");
  if (!button) return;
  openWorkdirDrawer(button.dataset.openWorkdir);
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-overview-trend]");
  if (!button) return;
  openTrendBreakdownDrawer(button.dataset.openOverviewTrend);
});

document.querySelectorAll(".save-settings").forEach((button) => button.addEventListener("click", async () => run(async () => {
  await saveSettings();
})));

// instant_autosave: display preferences
$("#showRawTokens").addEventListener("change", async () => {
  await saveInstantPreference("showRawTokens", $("#showRawTokens").checked);
});
$("#showEstimatedCost").addEventListener("change", async () => {
  await saveInstantPreference("showEstimatedCost", $("#showEstimatedCost").checked);
});

// Dirty state tracking for save_required + next_cycle fields
const DIRTY_TRACKED_FIELDS = ["nickname", "apiBaseUrl", "launchAtLogin", "hideDockIcon", "refreshIntervalMinutes"];

function readDomValue(field) {
  const el = document.getElementById(field);
  if (!el) return undefined;
  if (el.type === "checkbox") return el.checked;
  return el.value.trim ? el.value.trim() : el.value;
}

function readConfigValue(field) {
  return latestConfig?.[field];
}

function isFieldDirty(field) {
  const dom = readDomValue(field);
  const config = readConfigValue(field);
  if (typeof dom === "boolean") return dom !== !!config;
  return String(dom || "") !== String(config || "");
}

function getDirtyFields() {
  return DIRTY_TRACKED_FIELDS.filter(isFieldDirty);
}

function updateDirtyState() {
  const dirtyFields = getDirtyFields();
  const hasUnsaved = dirtyFields.length > 0;
  document.querySelectorAll(".save-settings").forEach((btn) => {
    btn.classList.toggle("has-unsaved", hasUnsaved);
    btn.title = hasUnsaved ? t("desktop.sync.unsavedChanges") : "";
    let note = btn.parentElement?.querySelector(".settings-dirty-note");
    if (hasUnsaved && !note) {
      note = document.createElement("span");
      note.className = "settings-dirty-note";
      btn.insertAdjacentElement("afterend", note);
    }
    if (note) {
      note.textContent = hasUnsaved ? t("desktop.sync.unsavedChanges") : "";
      note.hidden = !hasUnsaved;
    }
  });
}

function isApiBaseUrlDirty() {
  return isFieldDirty("apiBaseUrl");
}

async function saveInstantPreference(field, value) {
  const previousConfig = latestConfig || {};
  const previousValue = previousConfig[field] ?? false;
  latestConfig = { ...previousConfig, [field]: value };
  const input = document.getElementById(field);

  try {
    if (field === "showEstimatedCost" && value) await refreshPricing();
    if (field === "showEstimatedCost" && !value) await syncTrayCostState();
    renderInstantPreferenceViews();
    const config = await api.updateConfig({ [field]: value });
    latestConfig = config;
    renderInstantPreferenceViews();
    updateDirtyState();
  } catch (error) {
    latestConfig = { ...previousConfig, [field]: previousValue };
    if (input) input.checked = Boolean(previousValue);
    renderInstantPreferenceViews();
    setSaveMessage(error.message || t("desktop.renderer.actionFailed"), "error");
  }
}

function renderInstantPreferenceViews() {
  renderToday();
  renderWorkdirs();
  renderAliases();
}

for (const field of DIRTY_TRACKED_FIELDS) {
  const el = document.getElementById(field);
  if (!el) continue;
  const eventType = el.type === "checkbox" ? "change" : "input";
  el.addEventListener(eventType, updateDirtyState);
}

$("#reset-local-data").addEventListener("click", openResetConfirmModal);
$("#check-update").addEventListener("click", (event) => {
  if (event.target.closest(".row-inline-action")) return;
  if ($("#check-update").dataset.busy === "true") return;
  run(checkUpdate);
});
$("#check-update").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  if ($("#check-update").dataset.busy === "true") return;
  run(checkUpdate);
});
$("#download-update").addEventListener("click", (event) => {
  event.stopPropagation();
  if ($("#download-update").dataset.updateAction === "install") {
    run(installAndRestartUpdate);
    return;
  }
  run(downloadUpdate);
});
$("#download-installer").addEventListener("click", (event) => {
  event.stopPropagation();
  run(downloadInstaller);
});
$("#export-diagnostics").addEventListener("click", () => run(exportDiagnostics));
$("#clear-runtime-log").addEventListener("click", () => run(clearRuntimeLog));
$("#reveal-runtime-log-directory").addEventListener("click", () => run(revealRuntimeLogDirectory));
$("#backup-now").addEventListener("click", () => run(exportLocalBackup));
$("#restore-local-backup")?.addEventListener("click", () => run(restoreLocalBackup));
$("#clear-local-backups").addEventListener("click", () => run(clearLocalBackups));
$("#choose-backup-directory").addEventListener("click", () => run(chooseBackupDirectory));
$("#reveal-backup-directory").addEventListener("click", () => run(revealBackupDirectory));
$("#localBackupEnabled").addEventListener("change", () => run(saveBackupPreferences));
$("#localBackupRetention").addEventListener("change", () => run(saveBackupPreferences));
$("#runtimeLogRetentionDays").addEventListener("change", () => run(saveRuntimeLogPreferences));
$("#enforcement-download-update").addEventListener("click", (event) => {
  event.stopPropagation();
  if ($("#enforcement-download-update").dataset.updateAction === "install") {
    run(installAndRestartUpdate);
    return;
  }
  run(downloadUpdate);
});
$("#enforcement-download-installer").addEventListener("click", (event) => {
  event.stopPropagation();
  run(downloadInstaller);
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-remove-root]");
  if (!btn) return;
  const rootPath = btn.dataset.removeRoot;
  const providerId = btn.dataset.providerId;
  if (!rootPath || !providerId) return;
  if (!(await confirmDialog(t("desktop.sources.removeConfirm")))) return;
  try {
    latestConfig = await api.removeProviderRoot(providerId, rootPath);
    renderConfig(latestConfig);
    setSaveMessage(t("desktop.sources.sourceRemoved"), "ok");
    await loadHealth();
  } catch (err) {
    setSaveMessage(err.message || t("desktop.renderer.failedToRemove"), "error");
  }
});

document.addEventListener("click", async (e) => {
  const accountBtn = e.target.closest("[data-disconnect-cursor-account]");
  if (accountBtn) {
    const accountIndex = accountBtn.dataset.disconnectCursorAccount;
    if (accountIndex === undefined) return;
    if (!(await confirmDialog(t("desktop.sources.removeConfirm")))) return;
    try {
      latestConfig = await api.disconnectCursor(Number(accountIndex));
      renderConfig(latestConfig);
      setSaveMessage(t("desktop.sources.sourceRemoved"), "ok");
      await loadHealth();
      await loadToday(true);
    } catch (err) {
      setSaveMessage(err.message || t("desktop.renderer.failedToRemove"), "error");
    }
    return;
  }
  const btn = e.target.closest("[data-remove-cursor-token]");
  if (!btn) return;
  const tokenValue = btn.dataset.removeCursorToken;
  if (!tokenValue) return;
  if (!(await confirmDialog(t("desktop.sources.removeConfirm")))) return;
  try {
    latestConfig = await api.removeCursorToken(tokenValue);
    renderConfig(latestConfig);
    setSaveMessage(t("desktop.sources.sourceRemoved"), "ok");
    await loadHealth();
    await loadToday(true);
  } catch (err) {
    setSaveMessage(err.message || t("desktop.renderer.failedToRemove"), "error");
  }
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-ignore-source]");
  if (!btn) return;
  const sourceId = btn.dataset.ignoreSource;
  const providerId = btn.dataset.providerId;
  if (!sourceId || !providerId) return;
  if (!(await confirmDialog(t("desktop.sources.ignoreConfirm")))) return;
  try {
    latestConfig = await api.ignoreAutoSource(providerId, sourceId);
    renderConfig(latestConfig);
    setSaveMessage(t("desktop.sources.sourceIgnored"), "ok");
    await loadHealth();
  } catch (err) {
    setSaveMessage(err.message || t("desktop.renderer.failedToIgnore"), "error");
  }
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-unignore-source]");
  if (!btn) return;
  const sourceId = btn.dataset.unignoreSource;
  const providerId = btn.dataset.providerId;
  if (!sourceId || !providerId) return;
  try {
    latestConfig = await api.unignoreAutoSource(providerId, sourceId);
    renderConfig(latestConfig);
    setSaveMessage(t("desktop.sources.sourceRestored"), "ok");
    await loadHealth();
  } catch (err) {
    setSaveMessage(err.message || t("desktop.renderer.failedToRestore"), "error");
  }
});

function selectSection(section) {
  document.querySelectorAll("nav button, .rail-icon-btn[data-section]").forEach((item) => item.classList.toggle("active", item.dataset.section === section));
  document.querySelectorAll(".screen").forEach((item) => item.classList.toggle("active", item.id === section));
  renderRailPageMeta(section);
  $(".workspace")?.scrollTo({ top: 0, behavior: "auto" });
}

function handlePrimaryNavigationClick(section) {
  selectSection(section);
  if (section === "overview") {
    if (!scanRunning) run(() => loadToday(true));
  }
  if (section === "sources") run(loadHealth);
}

function renderRailPageMeta(section) {
  const title = document.querySelector(".brand h2");
  if (title) title.textContent = t(`desktop.nav.${section}`);
}

function selectSettingsTab(tab) {
  $("#settings-tabs").querySelectorAll("button").forEach((item) => item.classList.toggle("active", item.dataset.settingsTab === tab));
  document.querySelectorAll("[data-settings-panel]").forEach((item) => item.classList.toggle("active", item.dataset.settingsPanel === tab));
}

async function saveSettings() {
  const payload = settingsPayload();
  const previousConfig = latestConfig;
  const dirtyBeforeSave = getDirtyFields();
  const apiChanged = apiBaseUrlChanged(previousConfig, payload);
  const nextCycleDirty = dirtyBeforeSave.some((f) => f === "refreshIntervalMinutes");
  setSaveMessage(payload.apiBaseUrl ? t("desktop.renderer.checkingApi") : t("desktop.renderer.savingSettings"), "");
  if (apiChanged && payload.apiBaseUrl) renderRailSyncStatus({ state: "syncing", reason: "checking_connection", label: t("desktop.syncStatus.syncing"), detail: t("desktop.syncStatus.syncingDetail.checkingConnection"), title: payload.apiBaseUrl, action: null, actionLabel: "", apiBaseUrl: payload.apiBaseUrl, lastSuccessAt: "", lastAttemptAt: "", queuePending: 0, lastError: "" });
  const existing = await api.getConfig();
  const config = existing ? await api.updateConfig(payload) : await api.initConfig(payload);
  renderConfig(config);
  if (api.platform === "darwin" && api.setDockVisible) {
    api.setDockVisible(!config.hideDockIcon);
  }
  updateDirtyState();
  if (nextCycleDirty) {
    setSaveMessage(t("desktop.sync.settingsSavedNextCycle"), "ok");
  } else {
    setSaveMessage(t("desktop.sync.settingsSaved"), "ok");
  }
  setStatusMessage(t("desktop.sync.settingsSaved"));
  if (apiChanged) {
    await refreshCloudDependentState();
  } else {
    await loadBackgroundStatus();
  }
  return config;
}

function settingsPayload() {
  return {
    nickname: $("#nickname")?.value || "anonymous",
    apiBaseUrl: $("#apiBaseUrl")?.value?.trim() || "",
    refreshIntervalMinutes: Number($("#refreshIntervalMinutes")?.value) || 15,
    launchAtLogin: $("#launchAtLogin")?.checked ?? false,
    hideDockIcon: $("#hideDockIcon")?.checked ?? false,
    desktopAutoInitialized: false,
    providerEnabled: latestConfig?.providerEnabled || {}
  };
}

$("#export").addEventListener("click", async () => run(async () => {
  const result = await api.exportConfig();
  setStatusMessage(result.canceled ? t("desktop.renderer.exportCanceled") : t("desktop.renderer.configExported"));
}));

$("#import").addEventListener("click", async () => run(async () => {
  await importProfile();
}));

async function importProfile() {
  const mode = await chooseImportMode();
  if (!mode) return;
  const previousConfig = latestConfig;
  const config = await api.importConfig(mode);
  if (!config?.canceled) {
    renderConfig(config);
    setStatusMessage(mode === "restore_device"
      ? t("desktop.renderer.configRestoredDevice")
      : t("desktop.renderer.configJoinedParticipant"));
    await loadToday(true);
    if (apiBaseUrlChanged(previousConfig, config)) {
      await refreshCloudDependentState();
    } else {
      await loadBackgroundStatus();
    }
  }
}

let wizardStep = 0;
let wizardDetectedSources = [];
let wizardSyncMode = "cloud";

function setWizardIdentityMode(mode) {
  const importMode = mode === "import";
  $("#wizard-create-identity")?.classList.toggle("active", !importMode);
  $("#wizard-create-identity")?.setAttribute("aria-pressed", importMode ? "false" : "true");
  $("#wizard-import")?.classList.toggle("active", importMode);
  $("#wizard-import")?.setAttribute("aria-pressed", importMode ? "true" : "false");
  const importActions = $("#wizard-import-actions");
  if (importActions) importActions.hidden = !importMode;
}

function setWizardSyncMode(mode) {
  wizardSyncMode = mode === "local" ? "local" : "cloud";
  document.querySelectorAll("[data-wizard-sync-mode]").forEach((button) => {
    const active = button.dataset.wizardSyncMode === wizardSyncMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const apiBaseUrlContainer = $(".cloud-url-container");
  if (apiBaseUrlContainer) apiBaseUrlContainer.classList.toggle("open", wizardSyncMode === "cloud");
  renderWizardSummary();
}

function wizardGo(step) {
  wizardStep = step;
  document.querySelectorAll(".wizard-step").forEach((el) => el.classList.toggle("active", Number(el.dataset.wizardStep) === step));
  document.querySelectorAll(".wizard-actions").forEach((el) => el.classList.toggle("active", Number(el.dataset.wizardActions) === step));
  document.querySelectorAll(".wizard-step-dot").forEach((el) => {
    const dotStep = Number(el.dataset.wizardStepDot);
    el.classList.toggle("active", dotStep === step);
    el.classList.toggle("done", dotStep < step);
  });
  if (step === 1) renderWizardSources();
  if (step === 2) renderWizardSummary();
}

async function renderWizard() {
  const overlay = $("#wizard-overlay");
  if (!overlay) return;
  const show = latestConfig?.desktopAutoInitialized === true;
  overlay.hidden = !show;
  if (!show) {
    delete overlay.dataset.initialized;
    return;
  }
  if (!overlay.dataset.initialized) {
    overlay.dataset.initialized = "1";
    wizardStep = 0;
    wizardGo(0);
    setWizardIdentityMode("create");
    if (latestConfig?.participantId) {
      $("#wizard-participant-id").value = latestConfig.participantId;
    }
    if ((latestConfig?.nickname && latestConfig.nickname !== "anonymous") || latestConfig?.nicknameAutoGenerated === true) {
      $("#wizard-nickname").value = latestConfig.nickname;
    }
    $("#wizard-api-base-url").value = latestConfig?.apiBaseUrl || "";
    setWizardSyncMode("cloud");
    try {
      wizardDetectedSources = await api.providerHealth();
    } catch {
      wizardDetectedSources = [];
    }
  }
}

async function renderWizardSources() {
  const container = $("#wizard-source-list");
  if (!container) return;
  if (!wizardDetectedSources.length) {
    try { wizardDetectedSources = await api.providerHealth(); } catch { wizardDetectedSources = []; }
  }
  container.innerHTML = wizardDetectedSources.map((item) => {
    const detected = item.detected || (item.roots && item.roots.length > 0);
    const enabled = latestConfig ? sourceEnabledForConfig(latestConfig, item.providerId) : sourceEnabled(item);
    const summary = item.providerId === "cursor_dashboard_usage"
      ? (item.roots?.length ? t("desktop.renderer.accountSources", { count: item.roots.length }) : t("desktop.renderer.requiresToken"))
      : (detected ? (item.roots?.length === 1 ? t("desktop.renderer.foundOne") : t("desktop.renderer.found", { count: item.roots?.length || 0 })) : t("desktop.renderer.notFound"));
    return `<article class="wizard-source-card ${detected ? "detected" : ""}">
      <div class="wizard-source-icon" aria-hidden="true"><img src="${sourceIconPath(item.providerId)}" alt="" /></div>
      <div class="wizard-source-main">
        <div class="wizard-source-title-row">
          <strong>${escapeHtml(sourceName(item.providerId))}</strong>
          <span class="wizard-source-status">${escapeHtml(summary)}</span>
        </div>
        <p>${escapeHtml(sourceDescription(item.providerId))}</p>
      </div>
      ${sourceSwitchButton(enabled, `data-wizard-toggle-source="${escapeHtml(item.providerId)}"`)}
    </article>`;
  }).join("");
  container.querySelectorAll("[data-wizard-toggle-source]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.getAttribute("aria-pressed") !== "true";
      updateSourceSwitchButton(button, next);
    });
  });
}

function renderWizardSummary() {
  const nickname = $("#wizard-nickname").value.trim() || "anonymous";
  const apiBaseUrl = wizardSyncMode === "local" ? "" : $("#wizard-api-base-url").value.trim();
  const enabledSources = [];
  document.querySelectorAll("[data-wizard-toggle-source]").forEach((button) => {
    if (button.getAttribute("aria-pressed") === "true") enabledSources.push(sourceName(button.dataset.wizardToggleSource));
  });
  $("#wizard-summary-nickname").textContent = nickname;
  const sourcesEl = $("#wizard-summary-sources");
  if (sourcesEl) {
    sourcesEl.innerHTML = enabledSources.length
      ? enabledSources.map((source) => `<span class="ticket-tag">${escapeHtml(source)}</span>`).join("")
      : `<span class="ticket-tag">${escapeHtml(t("desktop.renderer.none"))}</span>`;
  }
  const syncModeEl = $("#wizard-summary-sync-mode");
  if (syncModeEl) syncModeEl.textContent = apiBaseUrl ? t("desktop.wizard.ticketCloud") : t("desktop.wizard.ticketLocal");
  $("#wizard-summary-cloud").textContent = apiBaseUrl || t("desktop.renderer.localOnly");
  const participantEl = $("#wizard-summary-participant-id");
  if (participantEl) participantEl.textContent = latestConfig?.participantId || $("#wizard-participant-id")?.value || "-";
}

async function wizardImportProfile(mode = "join_existing_participant") {
  setWizardIdentityMode("import");
  const previousConfig = latestConfig;
  const config = await api.importConfig(mode);
  if (!config?.canceled) {
    latestConfig = config;
    renderConfig(config);
    renderWizard();
    const joinStatus = $("#wizard-join-status");
    if (joinStatus) {
      joinStatus.hidden = false;
      joinStatus.textContent = mode === "restore_device"
        ? t("desktop.renderer.configRestoredDevice")
        : t("desktop.wizard.joinSuccess") + " " + t("desktop.wizard.joinConnectCursor");
    }
    await loadToday(true);
    if (apiBaseUrlChanged(previousConfig, config)) {
      await refreshCloudDependentState();
    } else {
      await loadBackgroundStatus();
    }
  }
}

function sourceIconPath(providerId) {
  if (providerId === "codex_local") return "./icons/file-text.svg";
  if (providerId === "claude_code_local") return "./icons/folder-code.svg";
  if (providerId === "cursor_dashboard_usage") return "./icons/database.svg";
  return "./icons/file-text.svg";
}

async function skipWizard() {
  const enabledSources = {};
  for (const [providerId, enabled] of Object.entries(latestConfig?.providerEnabled || {})) {
    enabledSources[providerId] = enabled;
  }
  latestConfig = await api.updateConfig({
    nickname: latestConfig?.nickname || "anonymous",
    desktopAutoInitialized: false,
    providerEnabled: enabledSources
  });
  renderConfig(latestConfig);
  await loadToday(true);
  await loadBackgroundStatus();
  setStatusMessage(t("desktop.sync.profileReady"));
}

async function finishWizard() {
  const nickname = $("#wizard-nickname").value.trim() || "anonymous";
  const apiBaseUrl = wizardSyncMode === "local" ? "" : $("#wizard-api-base-url").value.trim();
  const previousConfig = latestConfig;
  const providerEnabled = {};
  document.querySelectorAll("[data-wizard-toggle-source]").forEach((button) => {
    const pid = button.dataset.wizardToggleSource;
    const on = button.getAttribute("aria-pressed") === "true";
    providerEnabled[pid] = on;
  });
  $("#nickname").value = nickname;
  latestConfig = await api.updateConfig({
    nickname,
    apiBaseUrl,
    desktopAutoInitialized: false,
    providerEnabled
  });
  renderConfig(latestConfig);
  await loadToday(true);
  if (apiBaseUrlChanged(previousConfig, latestConfig)) {
    await refreshCloudDependentState();
  } else {
    await loadBackgroundStatus();
  }
  setStatusMessage(t("desktop.sync.profileReady"));
}

async function resetLocalData() {
  const ok = await confirmDialog(t("desktop.renderer.confirmReset"));
  if (!ok) return;
  $("#reset-local-data").disabled = true;
  setStatusMessage(t("desktop.renderer.resetting"));
  await api.resetLocalData();
}

function openResetConfirmModal() {
  $("#reset-confirm-error").textContent = "";
  $("#reset-with-cloud").hidden = !hasConfiguredApiBaseUrl(latestConfig);
  $("#reset-confirm-modal").hidden = false;
}

function closeResetConfirmModal() {
  $("#reset-confirm-modal").hidden = true;
}

const hasConfiguredApiBaseUrl = _hasConfiguredApiBaseUrl;

async function resetLocalOnly() {
  closeResetConfirmModal();
  $("#reset-local-data").disabled = true;
  setStatusMessage(t("desktop.renderer.resetting"));
  await api.resetLocalData();
  await boot();
  $("#reset-local-data").disabled = false;
  showToast(t("desktop.renderer.resetDone"));
}

async function resetWithCloud() {
  closeResetConfirmModal();
  const errorEl = $("#reset-confirm-error");
  errorEl.textContent = "";
  $("#reset-local-data").disabled = true;
  setStatusMessage(t("desktop.reset.cloudClearing"));
  try {
    await api.resetWithCloud();
    await boot();
    $("#reset-local-data").disabled = false;
    showToast(t("desktop.renderer.resetDone"));
  } catch (error) {
    $("#reset-local-data").disabled = false;
    setStatusMessage("");
    errorEl.textContent = t("desktop.reset.cloudFailed", { error: error.message });
    throw error;
  }
}

async function boot() {
  registerRuntimeEventHandlers();
  const config = await api.getConfig();
  if (config) {
    latestConfig = config;
    if (config.language) {
      setLang(config.language);
      updatePageTranslations();
      const langSwitcher = $("#lang-switcher");
      if (langSwitcher) langSwitcher.value = config.language;
    }
    renderConfig(config);
    renderWizard();
    if (api.platform !== "darwin") {
      const dockRow = document.getElementById("hideDockIcon-row");
      if (dockRow) dockRow.hidden = true;
    }
    if (api.platform === "darwin" && config.hideDockIcon && api.setDockVisible) {
      api.setDockVisible(false);
    }
    const bootApiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl || "");
    const connectionLoad = bootApiBaseUrl
      ? refreshApiConnectionOnBoot(bootApiBaseUrl)
      : Promise.resolve(null);
    const initialScan = loadToday();
    const identityLoad = loadMyIdentity();
    startIdentityRefreshTimer();
    const backgroundLoad = loadBackgroundStatus();
    startBackgroundStatusTimer();
    startUpdateCheckTimer();
    const systemLoad = loadSystemStatus();
    const backupLoad = loadBackupStatus();
    const diagnosticsLoad = loadDiagnosticsStatus();
    const logoLoad = fetchBrandLogo();
    startBrandLogoTimer();
    const bootResults = await Promise.allSettled([connectionLoad, initialScan, identityLoad, backgroundLoad, systemLoad, backupLoad, diagnosticsLoad, logoLoad]);
    const failed = bootResults.find((result) => result.status === "rejected");
    if (failed) setStatusMessage(failed.reason?.message || t("desktop.renderer.actionFailed"));
    checkMandatoryFromConfig();
  } else {
    showToast(t("desktop.renderer.openSettings"));
    document.querySelector('[data-section="settings"]').click();
  }
}

function registerRuntimeEventHandlers() {
  if (runtimeEventHandlersRegistered) return;
  runtimeEventHandlersRegistered = true;
  api.onUpdateProgress((data) => {
    updateCheckProgress(data);
  });
  api.onNavigateSection((section) => {
    if (section === "overview") handlePrimaryNavigationClick("overview");
  });
  if (api.onTrayRefreshStart) {
    api.onTrayRefreshStart(() => {
      setScanState(true);
    });
  }
  if (api.onTrayRefreshDone) {
    api.onTrayRefreshDone(() => {
      run(async () => {
        const status = api.usageScanStatus ? await api.usageScanStatus() : null;
        if (status) {
          applyUsageScanStatus(status);
          await refreshForegroundSyncStatus(status);
        } else {
          setScanState(false);
        }
        showToast(t("desktop.rail.scanComplete"));
        await loadBackgroundStatus({ refreshConfig: true, skipScanRefresh: true });
      });
    });
  }
  if (api.onTrayRefreshFailed) {
    api.onTrayRefreshFailed((error) => {
      setScanState(false);
      showToast(t("desktop.renderer.refreshStatusFailed", { error: error || "Background refresh failed" }));
    });
  }
}

function hasReadyUpdatePackage(state = latestUpdateState) {
  const update = state?.update || state?.lastResult || null;
  return Boolean(state?.readyPackage || state?.status === "downloaded" || update?.status === "downloaded" || updateDownloadedPersisted);
}

function hasUpdateAvailable(state = latestUpdateState) {
  const update = state?.update || state?.lastResult || null;
  return Boolean(update?.updateAvailable);
}

function isUpdateDownloading(state = latestUpdateState) {
  return Boolean(state?.downloadProgress || state?.downloadRunning || state?.status === "downloading");
}

function renderUpdateActions(state = latestUpdateState) {
  const updateButton = $("#download-update");
  const installerButton = $("#download-installer");
  const enforcementButton = $("#enforcement-download-update");
  if (!updateButton || !installerButton) return;
  const ready = hasReadyUpdatePackage(state);
  const available = hasUpdateAvailable(state);
  const failed = state?.status === "failed" && state?.lastError;
  installerButton.hidden = !(failed && !ready);
  installerButton.disabled = installerButton.hidden;
  if (enforcementButton) {
    enforcementButton.disabled = isUpdateDownloading(state) || updateInstallRunning;
    enforcementButton.dataset.updateAction = ready ? "install" : "download";
    enforcementButton.textContent = ready
      ? t("desktop.rail.restartUpdate")
      : t("desktop.app.downloadRestart");
  }
  if (ready || isUpdateDownloading(state)) {
    updateButton.hidden = true;
    updateButton.disabled = true;
    updateButton.dataset.updateAction = "download";
  } else if (available) {
    updateButton.hidden = false;
    updateButton.disabled = Boolean(state?.downloadProgress || state?.downloadRunning);
    updateButton.textContent = t("desktop.app.downloadRestart");
    updateButton.dataset.updateAction = "download";
  } else {
    updateButton.hidden = true;
    updateButton.disabled = true;
    updateButton.dataset.updateAction = "download";
  }
}

function shouldCheckUpdateOnCloudOpen() {
  if ($("#check-update")?.dataset.busy === "true") return false;
  if (isApiBaseUrlDirty()) return false;
  if (hasReadyUpdatePackage(latestUpdateState)) return false;
  const apiBaseUrl = normalizeApiBaseUrl(latestConfig?.apiBaseUrl || latestConfig?.apiConnection?.apiBaseUrl || "");
  const compatibility = latestConfig?.apiConnection?.compatibility;
  return Boolean(apiBaseUrl && latestConfig?.apiConnection?.status === "reachable" && compatibility?.compatible !== false);
}

function checkMandatoryFromConfig(config = latestConfig) {
  const compatibility = config?.apiConnection?.compatibility;
  if (compatibility?.mandatory && !compatibility?.compatible) {
    mandatoryUpdateActive = true;
    const overlay = $("#mandatory-update-overlay");
    if (overlay) {
      $("#enforcement-current-version").textContent = latestClientInfo?.clientAppVersion || "";
      $("#enforcement-required-version").textContent = compatibility?.server?.latestClientVersion || "";
      overlay.hidden = false;
    }
  } else if (mandatoryUpdateActive) {
    mandatoryUpdateActive = false;
    const overlay = $("#mandatory-update-overlay");
    if (overlay) overlay.hidden = true;
  }
}

function updateCheckProgress(data) {
  const merged = { ...(latestUpdateState || {}), ...(data || {}) };
  if (data.status === "downloaded" && !updateDownloadedPersisted) {
    merged.status = "downloading";
    delete merged.downloadProgress;
    delete merged.downloadRunning;
  }
  latestUpdateState = merged;
  if (data.downloadProgress && !downloadedEventReceived) {
    const pct = data.downloadProgress.percent;
    const speed = data.downloadProgress.bytesPerSecond > 0
      ? `${Math.round(data.downloadProgress.bytesPerSecond / 1024)} KB/s`
      : "";
    const msg = speed
      ? `${t("desktop.renderer.downloading")} ${pct}% (${speed})`
      : `${t("desktop.renderer.downloading")} ${pct}%`;
    $("#update-message").textContent = msg;
  }
  if (data.status === "downloaded" && !updateDownloadedPersisted) {
    // Show "preparing" instead of "ready" — PendingUpdate may not exist yet.
    // "ready" is shown by downloadUpdate() after the promise resolves.
    downloadedEventReceived = true;
    $("#update-message").textContent = t("desktop.renderer.downloadedPreparing");
  }
  if (data.status === "failed" && data.lastError) {
    $("#update-message").textContent = data.lastError;
  }
  renderSilentUpdateStatus(latestUpdateState, latestConfig);
}

async function loadToday(force = false, { syncAfterRefresh = force } = {}) {
  setScanState(true, force);
  try {
    const status = await api.startUsageScan({ force, syncAfter: Boolean(syncAfterRefresh) && shouldSyncAfterRefresh() });
    applyUsageScanStatus(status, { force });
    schedulePricingRefresh();
    await finalizeUsageScanStatus(status, force);
  } catch (error) {
    setScanState(false);
    throw error;
  }
}

async function loadMyIdentity() {
  const block = $("#my-identity-block");
  const nameEl = $("#my-identity-name");
  if (!block || !nameEl) return;
  try {
    const data = await api.getMyIdentity();
    latestIdentityBusinessDay = data?.businessDay || latestIdentityBusinessDay;
    if (data?.identityMode === "anonymous" && data.displayName) {
      nameEl.textContent = data.displayName;
      block.hidden = false;
      block.classList.remove("identity-reveal");
      void block.offsetWidth;
      block.classList.add("identity-reveal");
    } else {
      block.hidden = true;
      nameEl.textContent = "";
    }
  } catch {
    block.hidden = true;
  }
}

async function refreshCloudDependentState() {
  serverPriceMap = null;
  latestUpdateState = null;
  updateDownloadedPersisted = false;
  updateInstallRunning = false;
  downloadedEventReceived = false;
  latestIdentityBusinessDay = "";
  latestBrandLogoUrl = null;
  await Promise.allSettled([
    loadMyIdentity(),
    refreshPricing({ renderOnComplete: true }),
    fetchBrandLogo()
  ]);
  renderInstantPreferenceViews();
  await Promise.allSettled([
    loadBackgroundStatus(),
    loadSystemStatus()
  ]);
}

function apiBaseUrlChanged(previousConfig = {}, nextConfig = {}) {
  return normalizeApiBaseUrl(previousConfig?.apiBaseUrl || "") !== normalizeApiBaseUrl(nextConfig?.apiBaseUrl || "");
}

function setScanState(running, force = false) {
  const wasRunning = scanRunning;
  scanRunning = running;
  const refreshButton = $("#brand-refresh");
  refreshButton.disabled = running;
  refreshButton.setAttribute("aria-disabled", running ? "true" : "false");
  if (running && !wasRunning) {
    showToast(t("desktop.renderer.scanningLocal"));
  }
  updateShareButtonState();
  renderWizard();
  renderRailStatus();
}

function updateShareButtonState() {
  const btn = $("#open-share-card");
  if (!btn) return;
  const disabled = scanRunning || !getOverviewTotalTokens();
  btn.disabled = disabled;
  btn.setAttribute("aria-disabled", disabled ? "true" : "false");
}

async function loadTrend(force = false, { syncAfterRefresh = force } = {}) {
  setScanState(true, force);
  try {
    const status = await api.startUsageScan({ force, syncAfter: Boolean(syncAfterRefresh) && shouldSyncAfterRefresh() });
    applyUsageScanStatus(status, { force });
    schedulePricingRefresh();
    await finalizeUsageScanStatus(status, force);
  } catch (error) {
    setScanState(false);
    throw error;
  }
}

async function finalizeUsageScanStatus(status, showCompletionToast = false) {
  loadMyIdentity().catch(() => {});
  if (status.running || status.syncRunning) {
    restartUsageScanPoll();
    return;
  }
  stopUsageScanPoll();
  setScanState(false);
  await refreshForegroundSyncStatus(status);
  if (usageScanTerminalError(status)) return;
  startForegroundSync(status);
  if (showCompletionToast) {
    showToast(t("desktop.rail.scanComplete"));
  }
}

function restartUsageScanPoll() {
  stopUsageScanPoll();
  pollUsageScan();
}

function stopUsageScanPoll() {
  if (scanPollTimer) clearInterval(scanPollTimer);
  scanPollTimer = null;
  scanPollInFlight = false;
}

function pollUsageScan() {
  if (scanPollTimer) return;
  scanPollTimer = setInterval(async () => {
    if (scanPollInFlight) return;
    scanPollInFlight = true;
    try {
      const status = await api.usageScanStatus();
      applyUsageScanStatus(status);
      if (!status.running && !status.syncRunning) {
        stopUsageScanPoll();
        setScanState(false);
        await refreshForegroundSyncStatus(status);
        if (usageScanTerminalError(status)) return;
        startForegroundSync(status);
        showToast(t("desktop.rail.scanComplete"));
        loadMyIdentity().catch((error) => console.error(error));
      }
    } catch (error) {
      stopUsageScanPoll();
      setScanState(false);
      $("#workdirs-summary").textContent = t("desktop.renderer.refreshStatusFailed", { error: error.message });
      showToast(t("desktop.renderer.refreshStatusFailed", { error: error.message }));
      console.error(error);
    } finally {
      scanPollInFlight = false;
    }
  }, 1000);
}

function startIdentityRefreshTimer() {
  if (identityRefreshTimer) return;
  lastIdentityCheckLocalDay = localDay();
  identityRefreshTimer = setInterval(() => {
    const currentLocalDay = localDay();
    if (currentLocalDay === lastIdentityCheckLocalDay) return;
    lastIdentityCheckLocalDay = currentLocalDay;
    run(async () => {
      await loadToday(false, { syncAfterRefresh: true });
      await loadMyIdentity();
    });
  }, 60 * 1000);
}

async function openShareCardModal() {
  const modal = $("#share-card-modal");
  const flash = $("#polaroid-flash");
  const stage = $(".polaroid-stage");
  const card = $("#polaroid-card");
  const actions = $("#polaroid-actions");
  const loading = $("#polaroid-loading");
  if (!modal || !flash || !stage || !card || !actions) return;

  // Reset state
  modal.hidden = false;
  card.classList.remove("ejecting", "settled", "developing", "shaking");
  actions.classList.remove("visible");
  if (loading) loading.classList.remove("hidden");
  setShareStatus("");

  // Build data and render preview
  try {
    const data = await buildOverviewShareData(overviewRange);
    latestShareData = data;
    await renderShareCardPreview();
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const min = String(now.getMinutes()).padStart(2, "0");
    const caption = `${yyyy}-${mm}-${dd} ${hh}:${min}`;
    const captionEl = $("#polaroid-caption");
    if (captionEl) captionEl.textContent = caption;
  } catch (error) {
    latestShareData = null;
    $("#share-card-preview").innerHTML = `<div class="empty-state">${escapeHtml(t("desktop.share.exportFailed"))}</div>`;
    setShareStatus(error.message || t("desktop.share.exportFailed"), "error");
  }

  // Hide loading spinner once data is ready
  if (loading) loading.classList.add("hidden");

  // Phase 1: Flash
  flash.classList.add("active");
  flash.addEventListener("animationend", () => flash.classList.remove("active"), { once: true });

  // Phase 2: Show stage + eject card (after flash peak ≈35ms)
  setTimeout(() => {
    stage.classList.add("visible");
    card.classList.add("ejecting");
  }, 35);

  // Phase 3: Start development after eject settles (≈400ms)
  setTimeout(() => {
    card.classList.remove("ejecting");
    card.classList.add("settled", "developing");
  }, 400);

  // Phase 4: Show action bar after development (≈700ms)
  setTimeout(() => {
    actions.classList.add("visible");
  }, 700);
}

function closeShareCardModal() {
  const stage = $(".polaroid-stage");
  const card = $("#polaroid-card");
  const actions = $("#polaroid-actions");
  const loading = $("#polaroid-loading");
  if (actions) actions.classList.remove("visible");
  if (card) {
    card.classList.remove("ejecting", "settled", "developing", "shaking");
    card.classList.add("dismissing");
  }
  setTimeout(() => {
    if (stage) stage.classList.remove("visible");
    if (card) card.classList.remove("dismissing");
    if (loading) loading.classList.remove("hidden");
    const modal = $("#share-card-modal");
    if (modal) modal.hidden = true;
    setShareStatus("");
  }, 400);
}

function setShareStatus(message = "", kind = "") {
  const el = $("#share-card-status");
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
}

function setShareChartActive() {}
function setSharePeriodActive() {}

async function refreshShareCardPreview() {
  setShareStatus(t("loading"));
  try {
    const data = await buildOverviewShareData(overviewRange);
    latestShareData = data;
    await renderShareCardPreview();
    setShareStatus(data.mode === "cloud_pending" ? t("desktop.share.cloudPending") : "");
  } catch (error) {
    latestShareData = null;
    $("#share-card-preview").innerHTML = `<div class="empty-state">${escapeHtml(t("desktop.share.exportFailed"))}</div>`;
    setShareStatus(error.message || t("desktop.share.exportFailed"), "error");
  }
}

async function buildOverviewShareData(range) {
  const businessDay = localDay();
  const grain = overviewTrendGrain();

  // Mirror renderToday() data pipeline
  const summary = usageQueryState.summaries.get(range);
  const localRangeItems = usageForRange(range);
  const hasLocalRangeItems = localRangeItems.length > 0;
  const rangeItems = summary ? [] : localRangeItems;
  const composition = summary?.totals || aggregateComposition(rangeItems);
  const breakdownItems = hasLocalRangeItems ? localRangeItems : rangeItems;
  const providers = breakdownItems.length
    ? groupProviders(breakdownItems)
    : summary?.providers?.map((row) => ({ ...row, name: sourceName(row.name) })) || [];
  const models = breakdownItems.length
    ? groupBy(breakdownItems, "model")
    : summary?.models || [];
  const workdirs = breakdownItems.length
    ? groupBy(breakdownItems, "workdirDisplayName")
    : summary?.workdirs || [];

  // Trend rows for spark bars
  const trendQuery = usageQueryState.trends.get(usageQueryKey(range, grain));
  const trendRows = trendQuery?.items || (range === "today"
    ? groupByHour(localRangeItems)
    : groupByGrain(localRangeItems.length ? localRangeItems : usageForRange(range), grain).filter(hasPositiveUsage));

  // Provider/model/workdir ratios
  const providerTotal = providers.reduce((s, p) => s + (p.totalTokens || 0), 0) || 1;
  const modelTotal = models.reduce((s, m) => s + (m.totalTokens || 0), 0) || 1;
  const workdirTotal = workdirs.reduce((s, w) => s + (w.totalTokens || 0), 0) || 1;

  // Compute local cost aggregates
  const localCost = breakdownItems.length
    ? aggregateUsageCost(breakdownItems)
    : (summary ? {} : aggregateUsageCost(rangeItems));

  const data = {
    range,
    from: sharePeriodBounds(range === "today" ? "today" : range === "7d" ? "this_week" : range === "30d" ? "this_month" : "today", businessDay).from,
    to: businessDay,
    businessDay,
    identity: {
      displayName: latestConfig?.nickname || t("app.name"),
      nickname: latestConfig?.nickname || ""
    },
    mode: "local",
    rankStats: null,
    totals: {
      totalTokens: composition.totalTokens || 0,
      inputTokens: composition.inputTokens || 0,
      outputTokens: composition.outputTokens || 0,
      cacheReadTokens: composition.cacheReadTokens || 0,
      cacheWriteTokens: composition.cacheWriteTokens || 0,
      estimatedCostUsd: composition.estimatedCostUsd ?? localCost.estimatedCostUsd ?? 0,
      inputCostUsd: composition.inputCostUsd ?? localCost.inputCostUsd ?? 0,
      outputCostUsd: composition.outputCostUsd ?? localCost.outputCostUsd ?? 0,
      cacheReadCostUsd: composition.cacheReadCostUsd ?? localCost.cacheReadCostUsd ?? 0,
      cacheWriteCostUsd: composition.cacheWriteCostUsd ?? localCost.cacheWriteCostUsd ?? 0,
      missingPriceTokens: composition.missingPriceTokens ?? localCost.missingPriceTokens ?? 0,
      costQuality: composition.costQuality ?? localCost.costQuality ?? ""
    },
    providers: providers.slice(0, 5).map((p) => ({
      name: p.name || "Unknown",
      tokens: p.totalTokens || 0,
      ratio: Math.round((p.totalTokens || 0) / providerTotal * 10000) / 10000,
      estimatedCostUsd: p.estimatedCostUsd ?? 0,
      missingPriceTokens: p.missingPriceTokens ?? 0
    })),
    models: models.slice(0, 5).map((m) => ({
      name: m.name || "Unknown",
      tokens: m.totalTokens || 0,
      ratio: Math.round((m.totalTokens || 0) / modelTotal * 10000) / 10000,
      estimatedCostUsd: m.estimatedCostUsd ?? 0,
      missingPriceTokens: m.missingPriceTokens ?? 0
    })),
    workdirs: workdirs.slice(0, 5).map((w) => ({
      name: w.name || "Unknown",
      tokens: w.totalTokens || 0,
      ratio: Math.round((w.totalTokens || 0) / workdirTotal * 10000) / 10000,
      estimatedCostUsd: w.estimatedCostUsd ?? 0,
      missingPriceTokens: w.missingPriceTokens ?? 0
    })),
    trendRows: trendRows.map((r) => ({
      ...r,
      label: r.label || (r.hour != null ? `${r.hour}:00` : (r.day || "").slice(5) || ""),
      totalTokens: r.totalTokens || 0,
      estimatedCostUsd: r.estimatedCostUsd ?? 0,
      missingPriceTokens: r.missingPriceTokens ?? 0
    })),
    trendGrain: grain,
    estimatedCostUsd: null,
    quoteIndex: randomShareQuoteIndex()
  };

  // Try cloud enrichment (skip for "all" — cloud API has no all-time period,
  // and mapping to "today" would show a misleading ranking for all-time totals)
  if (range !== "all" && hasConfiguredApiBaseUrl(latestConfig) && latestConfig?.participantId) {
    try {
      const cloudData = await fetchCloudShareData(range, latestConfig);
      if (cloudData) {
        return { ...data, mode: cloudData.mode, rankStats: cloudData.rankStats, identity: { ...data.identity, ...cloudData.identity }, estimatedCostUsd: cloudData.estimatedCostUsd };
      }
    } catch (error) {
      console.warn("Share cloud data unavailable", error);
      return withCloudPending(data);
    }
  }

  return data;
}

async function fetchCloudShareData(range, config) {
  if (!config?.participantId) return null;

  const periodMap = { today: "today", "7d": "this_week", "30d": "this_month" };
  const period = periodMap[range] || "today";

  const identity = await api.getMyIdentity();

  const queryId = identity.identityMode === "anonymous" && identity.publicId ? identity.publicId : config.participantId;
  const analytics = await api.boardAnalytics({ period, participantId: queryId });

  const isAnon = identity.identityMode === "anonymous";
  return {
    mode: isAnon ? "cloud_anonymous" : "cloud_public",
    rankStats: analytics.rankStats || null,
    identity: {
      displayName: isAnon ? identity.displayName : (config?.nickname || identity.displayName),
      anonymousName: isAnon ? identity.displayName : undefined,
      displayId: identity.publicId || identity.displayId
    },
    estimatedCostUsd: analytics.summary?.estimatedCostUsd ?? null
  };
}

async function fetchBrandLogo() {
  const apiBaseUrl = normalizeApiBaseUrl(latestConfig?.apiBaseUrl || "");
  if (!apiBaseUrl) { latestBrandLogoUrl = null; updateWorkspaceLogo(); return; }
  if (api?.brandLogo) {
    try {
      const result = await api.brandLogo();
      latestBrandLogoUrl = result?.dataUrl || null;
      updateWorkspaceLogo();
      logRuntimeEvent("brand_logo_fetch", {
        ok: Boolean(latestBrandLogoUrl),
        source: "sidecar",
        hasLogoUrl: Boolean(result?.logoUrl),
        byteLength: result?.byteLength || 0,
        contentType: result?.contentType || ""
      }, latestBrandLogoUrl ? "info" : "warn");
      return;
    } catch (error) {
      latestBrandLogoUrl = null;
      updateWorkspaceLogo();
      logRuntimeEvent("brand_logo_fetch", {
        ok: false,
        source: "sidecar",
        error: error?.message || String(error)
      }, "warn");
      return;
    }
  }
  const LOGO_FETCH_TIMEOUT_MS = 5_000;
  const LOGO_MAX_BYTES = 512 * 1024;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LOGO_FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(new URL("/api/brand/logo", apiBaseUrl).toString(), { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) { latestBrandLogoUrl = null; updateWorkspaceLogo(); return; }
    const body = await res.json();
    const url = body.logoUrl || null;
    if (!url) { latestBrandLogoUrl = null; updateWorkspaceLogo(); return; }
    try {
      const imgCtrl = new AbortController();
      const imgTimer = setTimeout(() => imgCtrl.abort(), LOGO_FETCH_TIMEOUT_MS);
      let imgRes;
      try {
        imgRes = await fetch(url, { signal: imgCtrl.signal });
      } finally {
        clearTimeout(imgTimer);
      }
      if (!imgRes.ok) { latestBrandLogoUrl = null; updateWorkspaceLogo(); return; }
      const ct = imgRes.headers.get("content-type") || "";
      if (!ct.startsWith("image/")) { latestBrandLogoUrl = null; updateWorkspaceLogo(); return; }
      const blob = await imgRes.blob();
      if (blob.size > LOGO_MAX_BYTES) { latestBrandLogoUrl = null; updateWorkspaceLogo(); return; }
      latestBrandLogoUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
      updateWorkspaceLogo();
    } catch {
      // timeout, CORS, or network error — treat as no logo
      latestBrandLogoUrl = null;
      updateWorkspaceLogo();
    }
  } catch {
    // keep previous value on transient failure
  }
}

function updateWorkspaceLogo() {
  const el = $("#rail-brand-logo");
  if (!el) return;
  if (latestBrandLogoUrl) {
    el.src = latestBrandLogoUrl;
  } else {
    el.removeAttribute("src");
  }
}

async function renderShareCardPreview() {
  const preview = $("#share-card-preview");
  if (!preview || !latestShareData) return;

  try {
    const cardHtml = renderShareCardHtml(latestShareData, { ...shareCardRenderOptions(), cloudUrl: normalizeApiBaseUrl(latestConfig?.apiBaseUrl || "") });
    preview.innerHTML = `<style>${shareCardCss()}</style>${cardHtml}`;
    const root = preview.querySelector(".sc-root");
    if (root) {
      const containerWidth = preview.offsetWidth || 860;
      const scale = containerWidth / SHARE_CARD_WIDTH;
      root.style.zoom = String(scale);
      preview.style.height = `${Math.round(SHARE_CARD_HEIGHT * scale)}px`;
    }
  } catch (err) {
    console.error("Preview render failed:", err);
    preview.innerHTML = `<div class="empty-state">${escapeHtml(t("desktop.share.exportFailed"))}</div>`;
  }
}

function shareCardRenderOptions() {
  return {
    t,
    formatToken,
    formatUsd,
    sourceName,
    formatAxisLabel,
    logoUrl: latestBrandLogoUrl
  };
}

async function exportShareCardBlob() {
  if (!latestShareData) await refreshShareCardPreview();

  // Build timestamp caption
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const caption = `${yyyy}-${mm}-${dd} ${hh}:${min}`;

  // Render share card content
  const cardHtml = renderShareCardHtml(latestShareData, { ...shareCardRenderOptions(), cloudUrl: normalizeApiBaseUrl(latestConfig?.apiBaseUrl || "") });
  // Wrap in Polaroid frame
  const polaroidHtml = renderExportPolaroidHtml(cardHtml, caption);

  const w = POLAROID_EXPORT_WIDTH;
  const h = POLAROID_EXPORT_HEIGHT;

  const container = document.createElement("div");
  container.style.cssText = `position:fixed;left:-9999px;top:0;width:${w}px;height:${h}px;overflow:hidden;pointer-events:none;z-index:-1`;
  container.innerHTML = `<style>${shareCardCss()}${polaroidExportCss()}</style>${polaroidHtml}`;
  document.body.appendChild(container);

  const target = container.querySelector(".pe-frame");
  if (!target) {
    document.body.removeChild(container);
    throw new Error("Polaroid export frame not found");
  }

  try {
    const canvas = await html2canvas(target, {
      scale: 2,
      useCORS: true,
      logging: false
    });
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG export failed")), "image/png");
    });
  } finally {
    document.body.removeChild(container);
  }
}

function triggerPolaroidFlashSuccess() {
  const card = $("#polaroid-card");
  if (!card) return;
  card.classList.remove("flash-success");
  void card.offsetWidth;
  card.classList.add("flash-success");
  card.addEventListener("animationend", () => card.classList.remove("flash-success"), { once: true });
}

async function copyShareCardImage() {
  triggerPolaroidFlashSuccess();
  const blob = await exportShareCardBlob();

  // Try Tauri Native Clipboard Manager first as it is 100% reliable and bypasses WebView sandbox constraints!
  if (window.tokenLeague?.writeImageToClipboard) {
    try {
      const base64Png = await blobToBase64(blob);
      await window.tokenLeague.writeImageToClipboard(base64Png);
      setShareStatus(t("desktop.share.copySuccess"), "success");
      showToast(t("desktop.share.copySuccess"));
      closeShareCardModal();
      return;
    } catch (error) {
      console.warn("Tauri native clipboard write failed, trying webview clipboard fallback", error);
    }
  }

  // Fallback 1: Webview browser clipboard API
  if (navigator.clipboard?.write && window.ClipboardItem) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setShareStatus(t("desktop.share.copySuccess"), "success");
      showToast(t("desktop.share.copySuccess"));
      closeShareCardModal();
      return;
    } catch (error) {
      console.warn("WebView clipboard write failed", error);
    }
  }

  // Fallback 2: Disk saving dialog
  await saveShareCardImage(blob);
  setShareStatus(t("desktop.share.copyFallback"), "success");
  showToast(t("desktop.share.copyFallback"));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const split = reader.result.split(",");
      resolve(split.length > 1 ? split[1] : "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function saveShareCardImage(blob = null) {
  triggerPolaroidFlashSuccess();
  const imageBlob = blob || await exportShareCardBlob();
  const fileName = `ai-token-league-share-${overviewRange}-${localDay()}.png`;
  if (api.saveShareImage) {
    const base64 = await blobToBase64(imageBlob);
    const result = await api.saveShareImage({ fileName, base64Png: base64 });
    if (result?.canceled) {
      setShareStatus(t("desktop.share.exportCanceled"));
      return;
    }
    setShareStatus(t("desktop.share.saveSuccess"), "success");
    showToast(t("desktop.share.saveSuccess"));
    closeShareCardModal();
    return;
  }
  const url = URL.createObjectURL(imageBlob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    setShareStatus(t("desktop.share.saveSuccess"), "success");
    showToast(t("desktop.share.saveSuccess"));
    closeShareCardModal();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function startBackgroundStatusTimer() {
  if (backgroundStatusTimer) return;
  backgroundStatusTimer = setInterval(() => {
    loadBackgroundStatus().catch((error) => console.error(error));
  }, 60 * 1000);
}

function startUpdateCheckTimer() {
  if (updateCheckTimer) return;
  updateCheckTimer = setInterval(() => {
    if (shouldCheckUpdateOnCloudOpen()) checkUpdate({ automatic: true }).catch(() => {});
  }, UPDATE_CHECK_INTERVAL_MS);
}

let brandLogoTimer = null;
function startBrandLogoTimer() {
  if (brandLogoTimer) return;
  brandLogoTimer = setInterval(() => { fetchBrandLogo().catch(() => {}); }, 30 * 60 * 1000);
}

function applyUsageScanStatus(status, { force = false } = {}) {
  if (status.snapshot) applyUsageSnapshot(status.snapshot);
  latestUsageScanStatus = status;
  setScanState(Boolean(status.running || status.syncRunning), status.force ?? force);
  if (status.error) {
    $("#workdirs-summary").textContent = t("desktop.renderer.refreshFailed", { error: status.error });
    showToast(t("desktop.renderer.refreshFailed", { error: status.error }));
  }
}

function usageScanTerminalError(status) {
  return status?.error || status?.syncError || "";
}

async function refreshForegroundSyncStatus(status) {
  if (!status.syncResult && !status.syncError) return;
  if (status.syncResult) renderSyncStatus(latestConfig, status.syncResult);
  if (status.syncError) {
    setStatusMessage(t("desktop.renderer.refreshFailed", { error: status.syncError }));
    showToast(t("desktop.renderer.refreshFailed", { error: status.syncError }));
  }
  await loadBackgroundStatus({ config: latestConfig, refreshConfig: true });
}

function startForegroundSync(status) {
  if (foregroundSyncRunning) return;
  if (status?.syncResult || status?.syncError) return;
  if (status?.snapshot?.fromCache) return;
  if (!status?.force) return;
  if (!latestConfig?.apiBaseUrl || !latestConfig?.participantId) return;
  if (!canStartForegroundSync(latestConfig)) return;
  const syncStart = api.startUsageSync || api.syncUsage;
  foregroundSyncRunning = true;
  renderRailStatus();
  renderCloudStatus(latestConfig);
  syncStart()
    .then((result) => {
      if (result?.running || result?.syncRunning || result?.started) {
        applyUsageScanStatus({ ...result, syncRunning: true, running: false, phase: result?.phase || "uploading" });
        restartUsageScanPoll();
        return null;
      }
      if (usageScanTerminalError(result)) {
        const error = usageScanTerminalError(result);
        setStatusMessage(t("desktop.renderer.refreshFailed", { error }));
        showToast(t("desktop.renderer.refreshFailed", { error }));
        return loadBackgroundStatus({ config: latestConfig, refreshConfig: true });
      }
      renderSyncStatus(latestConfig, result);
      return loadBackgroundStatus({ config: latestConfig, refreshConfig: true });
    })
    .catch((error) => {
      setStatusMessage(t("desktop.renderer.refreshFailed", { error: error.message }));
      console.error(error);
    })
    .finally(() => {
      foregroundSyncRunning = false;
      renderSyncStatus(latestConfig);
    });
}

function canStartForegroundSync(config = latestConfig) {
  const connection = config?.apiConnection || {};
  if (!connection.checkedAt) return false;
  if (connection.status !== "reachable") return false;
  if (connection.compatibility?.compatible === false) return false;
  return true;
}

function shouldSyncAfterRefresh(config = latestConfig) {
  return Boolean(config?.apiBaseUrl && config?.participantId && canStartForegroundSync(config));
}

function applyUsageSnapshot(usage) {
  const items = (usage.items || []).map(normalizeUsageTotal);
  usageQueryState.lastRowCount = Number(usage.rowCount || items.length || 0);
  allUsage = items.length <= FULL_USAGE_RENDER_CACHE_LIMIT ? items : [];
  latestScanAt = usage.scannedAt || latestScanAt;
  if (usage.sourceFingerprint) {
    latestLocalSnapshot = { scannedAt: usage.scannedAt || "", sourceFingerprint: usage.sourceFingerprint, rowCount: usage.rowCount || 0 };
  }
  latestUsage = allUsage.filter((item) => item.day === localDay());
  if (usage.health) latestHealth = reconcileHealthWithConfig(usage.health, latestConfig);
  renderToday();
  renderWorkdirs();
  renderHealth();
  renderAliases();
  renderRailStatus();
  refreshUsageQuerySurfaces().catch(console.error);
}

async function refreshUsageQuerySurfaces() {
  if (!api.usageSummary || !api.usageTrend || !api.usageWorkdirs) return;
  if (usageQueryRefreshRunning) {
    usageQueryRefreshPending = true;
    return;
  }
  usageQueryRefreshRunning = true;
  const generation = ++usageQueryGeneration;
  try {
    const trendGrain = overviewTrendGrain();
    const trendKey = usageQueryKey(overviewRange, trendGrain);
    const results = await Promise.allSettled([
      api.usageSummary({ range: overviewRange }),
      api.usageTrend({ range: overviewRange, grain: trendGrain }),
      api.usageWorkdirs({ range: workdirsRange, limit: 100 }),
      workdirsRange === "today" ? Promise.resolve(null) : api.usageWorkdirs({ range: "today", limit: 100 }),
      api.usageWorkdirs({ range: "all", limit: 500 })
    ]);
    if (generation !== usageQueryGeneration) return;
    const [summary, trend, workdirs, todayWorkdirs, allWorkdirs] = results.map((result) => result.status === "fulfilled" ? result.value : null);
    if (summary) usageQueryState.summaries.set(overviewRange, normalizeUsageSummary(summary));
    if (trend) usageQueryState.trends.set(trendKey, normalizeUsageTrend(trend));
    if (workdirs) usageQueryState.workdirs.set(workdirsRange, normalizeUsageWorkdirs(workdirs));
    if (todayWorkdirs) usageQueryState.workdirs.set("today", normalizeUsageWorkdirs(todayWorkdirs));
    else if (workdirsRange === "today" && workdirs) usageQueryState.workdirs.set("today", normalizeUsageWorkdirs(workdirs));
    if (allWorkdirs) usageQueryState.workdirs.set("all", normalizeUsageWorkdirs(allWorkdirs));
    renderToday();
    renderWorkdirs();
    renderAliases();
    renderRailStatus();
  } finally {
    usageQueryRefreshRunning = false;
    if (usageQueryRefreshPending) {
      usageQueryRefreshPending = false;
      refreshUsageQuerySurfaces().catch(console.error);
    }
  }
}

function usageQueryKey(range, grain = "") {
  return `${range}|${grain}`;
}

const normalizeUsageSummary = _normalizeUsageSummary;
const normalizeUsageTrend = _normalizeUsageTrend;
const normalizeUsageWorkdirs = _normalizeUsageWorkdirs;
const normalizeBreakdownItems = _normalizeBreakdownItems;
const normalizeTokenAggregate = _normalizeTokenAggregate;
const normalizeUsageTotal = _normalizeUsageTotal;
const positiveInteger = _positiveInteger;

function reconcileHealthWithConfig(health = [], config = latestConfig) {
  return _reconcileHealthWithConfig(health, config);
}

async function loadHealth() {
  latestHealth = await api.providerHealth();
  renderCursorTokenSummary(latestConfig?.cursorDashboardUsage);
  renderHealth();
  await loadBackgroundStatus();
}

async function syncNow() {
  if (isApiBaseUrlDirty() && !(await confirmDialog(t("desktop.sync.unsavedApiBaseUrl")))) return;
  const buttons = document.querySelectorAll("[data-sync-now]");
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    if (!(await ensureApiConnectionReadyForSync())) return;
    if (!(await confirmSyncUpload())) {
      setStatusMessage(t("desktop.renderer.syncCanceled"));
      return;
    }
    setStatusMessage(t("desktop.renderer.syncing"));
    await loadToday(true);
    await loadMyIdentity();
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}

async function ensureApiConnectionReadyForSync() {
  const connection = latestConfig?.apiConnection || {};
  if (!connection.checkedAt || connection.status !== "reachable") {
    const checked = await refreshApiConnection();
    if (!checked || checked.status !== "reachable") return false;
  }
  latestConfig = await api.getConfig();
  const compatibility = latestConfig?.apiConnection?.compatibility || {};
  if (latestConfig?.apiConnection?.status !== "reachable" || compatibility.compatible === false) {
    renderSyncStatus(latestConfig);
    return false;
  }
  return true;
}

async function confirmSyncUpload() {
  const config = latestConfig || {};
  const apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl || config.apiConnection?.apiBaseUrl || "");
  if (!apiBaseUrl) {
    await confirmDialog(t("desktop.renderer.configureCloudFirst"), { alertOnly: true });
    return false;
  }
  const rows = usageQueryState.lastRowCount || allUsage.length || latestUsage.length || 0;
  const scannedAt = latestScanAt ? formatDateTime(latestScanAt) : "-";
  return confirmDialog(t("desktop.renderer.confirmUpload", { url: apiBaseUrl, rows, scannedAt }));
}

async function addProviderRoot(providerId) {
  const config = await api.addProviderRoot(providerId);
  if (config?.canceled) {
    await loadToday(false);
    await loadBackgroundStatus();
    return;
  }
  latestConfig = config;
  renderConfig(config);
  await loadHealth();
  await loadToday(true);
  await loadBackgroundStatus();
}

async function addCursorToken() {
  const input = $("#cursor-token-input");
  const error = $("#cursor-token-error");
  const raw = input.value.trim();
  if (!raw) {
    error.textContent = t("desktop.renderer.cursorTokenRequired");
    return;
  }
  let config;
  try {
    config = await api.addCursorToken(raw);
  } catch (err) {
    error.textContent = err.message || t("desktop.renderer.cursorTokenInvalid");
    return;
  }
  latestConfig = config;
  renderConfig(config);
  closeCursorTokenModal();
  setSaveMessage(t("desktop.renderer.cursorTokenAdded"), "ok");
  await loadHealth();
  await loadToday(true);
}

async function connectCursor() {
  if (!api.startCursorConnect || !api.pollCursorConnect) {
    setSaveMessage(t("desktop.cursorConnect.unavailable"), "error");
    return;
  }
  const modal = $("#cursor-connect-modal");
  const status = $("#cursor-connect-status");
  status.textContent = t("desktop.cursorConnect.opening");
  modal.hidden = false;
  let result;
  try {
    result = await api.startCursorConnect();
  } catch (err) {
    modal.hidden = true;
    setSaveMessage(err.message || t("desktop.cursorConnect.failed"), "error");
    return;
  }
  if (result?.loginUrl) {
    if (api.openUrl) {
      await api.openUrl(result.loginUrl);
    } else {
      window.open(result.loginUrl, "_blank", "noopener,noreferrer");
    }
  }
  status.textContent = t("desktop.cursorConnect.waiting");
  const expiresAt = Date.now() + Number(result?.expiresIn || 300) * 1000;
  while (!modal.hidden && Date.now() < expiresAt) {
    await delay(2000);
    try {
      const config = await api.pollCursorConnect();
      latestConfig = config;
      renderConfig(config);
      modal.hidden = true;
      setSaveMessage(t("desktop.cursorConnect.connected"), "ok");
      await loadHealth();
      await loadToday(true);
      return;
    } catch (err) {
      const message = err?.message || String(err || "");
      if (message.includes("pending")) {
        status.textContent = t("desktop.cursorConnect.waiting");
        continue;
      }
      modal.hidden = true;
      setSaveMessage(message.includes("expired") ? t("desktop.cursorConnect.expired") : message, "error");
      return;
    }
  }
  await cancelCursorConnect();
  setSaveMessage(t("desktop.cursorConnect.expired"), "error");
}

async function cancelCursorConnect() {
  $("#cursor-connect-modal").hidden = true;
  if (api.cancelCursorConnect) {
    try {
      await api.cancelCursorConnect();
    } catch {
      // Cancel is best-effort; the pending login expires server-side in five minutes.
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  if (config?.nickname && $("#nickname")) $("#nickname").value = config.nickname;
  if ($("#apiBaseUrl")) $("#apiBaseUrl").value = config?.apiBaseUrl ?? "";
  if ($("#showEstimatedCost")) $("#showEstimatedCost").checked = config?.showEstimatedCost ?? false;
  if ($("#showRawTokens")) $("#showRawTokens").checked = config?.showRawTokens ?? false;
  if ($("#refreshIntervalMinutes")) $("#refreshIntervalMinutes").value = config?.refreshIntervalMinutes ?? 15;
  if ($("#runtimeLogRetentionDays")) $("#runtimeLogRetentionDays").value = config?.runtimeLogRetentionDays ?? 3;
  if ($("#launchAtLogin")) $("#launchAtLogin").checked = config?.launchAtLogin ?? false;
  if ($("#hideDockIcon")) $("#hideDockIcon").checked = config?.hideDockIcon ?? false;
  renderCursorTokenSummary(config?.cursorDashboardUsage);
  renderCloudStatus(config);
  renderSyncStatus(config);
  renderBackupStatus(latestBackupStatus);
  renderSystemStatus({ client: null, server: config?.apiConnection || null, update: latestUpdateState });
  renderSilentUpdateStatus(null, config);
  renderWizard();
  updateDirtyState();
}

async function loadCloudStatus() {
  latestConfig = await api.getConfig();
  renderCloudStatus(latestConfig);
}

async function refreshApiConnection(apiBaseUrl = normalizeApiBaseUrl(latestConfig?.apiBaseUrl || "")) {
  if (!apiBaseUrl) return null;
  const apiConnection = await api.checkApi({ apiBaseUrl });
  latestConfig = await api.updateConfig({ apiBaseUrl, apiConnection });
  renderCloudStatus(latestConfig);
  renderSystemStatus({ client: latestClientInfo, server: latestConfig?.apiConnection || apiConnection || null, update: latestUpdateState });
  return apiConnection;
}

async function refreshApiConnectionOnBoot(apiBaseUrl) {
  latestConfig = {
    ...(latestConfig || {}),
    apiBaseUrl,
    apiConnection: { apiBaseUrl }
  };
  renderCloudStatus(latestConfig);
  return refreshApiConnection(apiBaseUrl);
}

async function loadSystemStatus() {
  const client = await api.appVersion();
  latestClientInfo = client;
  const server = latestConfig?.apiConnection || null;
  renderSystemStatus({ client, server, update: latestUpdateState });
}

function setUpdateCardBusy(isBusy) {
  const card = $("#check-update");
  card.dataset.busy = isBusy ? "true" : "false";
  card.setAttribute("aria-disabled", isBusy ? "true" : "false");
}

async function checkUpdate({ automatic = false } = {}) {
  if (updateCheckInFlight) return updateCheckInFlight;
  updateCheckInFlight = doCheckUpdate({ automatic }).finally(() => {
    updateCheckInFlight = null;
  });
  return updateCheckInFlight;
}

async function doCheckUpdate({ automatic = false } = {}) {
  if (isApiBaseUrlDirty()) {
    if (automatic || !(await confirmDialog(t("desktop.sync.unsavedApiBaseUrl")))) return;
  }
  const apiBaseUrl = normalizeApiBaseUrl(latestConfig?.apiBaseUrl || "");
  if (!apiBaseUrl) {
    if (!automatic) showToast(t("desktop.renderer.configureCloudUpdate"));
    return;
  }
  if (automatic && hasReadyUpdatePackage(latestUpdateState)) return;
  setUpdateCardBusy(true);
  $("#download-update").hidden = true;
  $("#download-update").disabled = true;
  $("#download-installer").hidden = true;
  $("#update-message").textContent = t("desktop.renderer.checking");
  try {
    const apiConnection = await refreshApiConnection(apiBaseUrl);
    latestUpdateState = await api.checkUpdate();
    renderSystemStatus({ ...latestUpdateState, server: latestConfig?.apiConnection || apiConnection || null });
    $("#update-message").textContent = updateMessage(latestUpdateState);
    renderSilentUpdateStatus(latestUpdateState, latestConfig);
    if (hasUpdateAvailable(latestUpdateState)) {
      await downloadUpdate({ restart: false });
    }
  } catch (error) {
    const msg = error.message?.includes("fetch failed")
      ? t("desktop.renderer.apiUnreachable", { error: error.message })
      : error.message;
    showToast(msg);
    $("#update-message").textContent = msg;
  } finally {
    setUpdateCardBusy(false);
  }
}

async function downloadUpdate({ restart = false } = {}) {
  $("#download-update").hidden = false;
  $("#download-update").disabled = true;
  $("#enforcement-download-update").disabled = true;
  downloadedEventReceived = false;
  latestUpdateState = { ...(latestUpdateState || {}), downloadRunning: true };
  renderSilentUpdateStatus(latestUpdateState, latestConfig);
  $("#update-message").textContent = t("desktop.renderer.downloading");
  try {
    await api.downloadUpdate();
    updateDownloadedPersisted = true;
    latestUpdateState = { ...(latestUpdateState || {}), status: "downloaded" };
    delete latestUpdateState.downloadProgress;
    delete latestUpdateState.downloadRunning;
    $("#update-message").textContent = t("desktop.renderer.downloadedReady");
    renderSilentUpdateStatus(latestUpdateState, latestConfig);
    renderUpdateActions(latestUpdateState);
    renderRailStatus();
    if (restart) await installAndRestartUpdate();
  } catch (error) {
    latestUpdateState = {
      ...(latestUpdateState || {}),
      status: "failed",
      lastError: error.message || t("desktop.renderer.downloadFailed")
    };
    delete latestUpdateState.downloadProgress;
    delete latestUpdateState.downloadRunning;
    $("#update-message").textContent = error.message || t("desktop.renderer.downloadFailed");
    renderUpdateActions(latestUpdateState);
    renderRailStatus();
  }
}

async function installAndRestartUpdate() {
  updateInstallRunning = true;
  renderRailStatus();
  renderUpdateActions(latestUpdateState);
  $("#update-message").textContent = t("desktop.renderer.downloadedInstalling");
  try {
    await api.installAndRestartUpdate();
  } catch (error) {
    updateInstallRunning = false;
    renderRailStatus();
    renderUpdateActions(latestUpdateState);
    throw error;
  }
}

async function downloadInstaller() {
  $("#download-installer").disabled = true;
  $("#update-message").textContent = t("desktop.renderer.downloading");
  api.onInstallerProgress((progress) => {
    const pct = progress.percent;
    const speed = progress.bytesPerSecond > 0
      ? `${Math.round(progress.bytesPerSecond / 1024)} KB/s`
      : "";
    $("#update-message").textContent = speed
      ? `${t("desktop.renderer.downloading")} ${pct}% (${speed})`
      : `${t("desktop.renderer.downloading")} ${pct}%`;
  });
  try {
    const result = await api.downloadInstaller();
    if (result && !result.ok) {
      $("#update-message").textContent = result.error || t("desktop.renderer.downloadFailed");
      $("#download-installer").disabled = false;
      return;
    }
    $("#update-message").textContent = t("desktop.renderer.downloadedReady");
  } catch (error) {
    $("#update-message").textContent = error.message || t("desktop.renderer.downloadFailed");
    $("#download-installer").disabled = false;
  }
}

async function exportDiagnostics() {
  const button = $("#export-diagnostics");
  button.disabled = true;
  $("#diagnostics-message").dataset.tone = "";
  $("#diagnostics-message").textContent = t("desktop.renderer.preparingDiag");
  logRuntimeEvent("diagnostics_export_start");
  try {
    const result = await api.exportDiagnostics();
    if (result.canceled) {
      $("#diagnostics-message").textContent = t("desktop.renderer.diagCanceled");
      logRuntimeEvent("diagnostics_export_canceled");
      return;
    }
    $("#diagnostics-message").dataset.tone = "ok";
    $("#diagnostics-message").textContent = t("desktop.renderer.diagExported", { logs: result.logCount || 0, rows: result.usageRowCount || 0 });
    $("#diagnostics-message").title = result.filePath || "";
    logRuntimeEvent("diagnostics_export_done", {
      logCount: result.logCount || 0,
      usageRowCount: result.usageRowCount || 0
    });
    await loadDiagnosticsStatus();
  } finally {
    button.disabled = false;
  }
}

async function loadDiagnosticsStatus() {
  if (!api.diagnosticsStatus) return;
  latestDiagnosticsStatus = await api.diagnosticsStatus();
  renderDiagnosticsStatus(latestDiagnosticsStatus);
}

async function clearRuntimeLog() {
  const button = $("#clear-runtime-log");
  button.disabled = true;
  $("#diagnostics-message").dataset.tone = "";
  $("#diagnostics-message").textContent = t("desktop.renderer.clearingRuntimeLog");
  try {
    await api.clearRuntimeLog();
    await loadDiagnosticsStatus();
    $("#diagnostics-message").dataset.tone = "ok";
    $("#diagnostics-message").textContent = t("desktop.renderer.runtimeLogCleared");
  } finally {
    button.disabled = false;
  }
}

async function revealRuntimeLogDirectory() {
  if (api.revealRuntimeLogDirectory) {
    await api.revealRuntimeLogDirectory();
  }
}

async function saveRuntimeLogPreferences() {
  const days = Number($("#runtimeLogRetentionDays")?.value || latestConfig?.runtimeLogRetentionDays || 3);
  latestConfig = await api.updateConfig({ runtimeLogRetentionDays: days });
  renderConfig(latestConfig);
  await loadDiagnosticsStatus();
}

function renderDiagnosticsStatus(status = latestDiagnosticsStatus) {
  latestDiagnosticsStatus = status || {};
  const retention = latestDiagnosticsStatus.retention || {};
  if ($("#runtimeLogRetentionDays")) {
    $("#runtimeLogRetentionDays").value = String(latestConfig?.runtimeLogRetentionDays || retention.days || 3);
  }
}

async function exportLocalBackup() {
  const button = $("#backup-now");
  button.disabled = true;
  setBackupMessage(t("desktop.renderer.preparingBackup"), "");
  try {
    await ensureBackupDirectory();
    const result = await api.createLocalBackup({ reason: "manual" });
    renderBackupStatus({ ...(latestBackupStatus || {}), ...result });
    setBackupMessage(t("desktop.renderer.backupExported", { count: result.backups?.length || 0 }), "ok");
  } finally {
    button.disabled = false;
  }
}

async function restoreLocalBackup() {
  const button = $("#restore-local-backup");
  button.disabled = true;
  setBackupMessage("", "");
  try {
    const picked = await api.pickLocalBackup();
    if (picked.canceled) {
      setBackupMessage(t("desktop.renderer.backupCanceled"), "");
      return;
    }
    const summary = picked.summary || {};
    const confirmText = t("desktop.renderer.confirmRestoreBackup", {
      date: summary.createdAt ? formatDateTime(summary.createdAt) : "-",
      files: summary.fileCount || 0,
      size: formatBytes(summary.totalBytes || 0)
    }) + "\n\n" + t("desktop.wizard.restoreDeviceWarning");
    const ok = await confirmDialog(confirmText);
    if (!ok) {
      setBackupMessage(t("desktop.renderer.backupCanceled"), "");
      return;
    }
    setBackupMessage(t("desktop.renderer.restoringBackup"), "");
    const result = await api.restoreLocalBackupFile(picked.filePath);
    latestConfig = await api.getConfig();
    const restoredDeviceId = result.restoredDeviceId || result.deviceId || latestConfig?.deviceId || "";
    const deviceIdLabel = restoredDeviceId
      ? ` (${t("desktop.renderer.restoredDeviceLabel", { deviceId: `${restoredDeviceId.slice(0, 12)}...` })})`
      : "";
    setBackupMessage(t("desktop.renderer.backupRestored", { count: result.restored || 0 }) + deviceIdLabel, "ok");
    $("#backup-message").title = result.snapshotPath || "";
    renderConfig(latestConfig);
    await loadToday(true);
    await loadBackgroundStatus();
    await loadBackupStatus();
  } finally {
    button.disabled = false;
  }
}

async function ensureBackupDirectory() {
  const current = latestConfig?.localBackup || {};
  if (String(current.directory || "").trim()) return current.directory;
  const chosen = await api.chooseBackupDirectory();
  if (chosen.canceled) throw new Error(t("desktop.renderer.backupCanceled"));
  const localBackup = {
    ...current,
    directory: chosen.directory,
    retentionCount: Number(current.retentionCount || 7)
  };
  latestConfig = await api.updateConfig({ localBackup });
  renderConfig(latestConfig);
  return chosen.directory;
}

async function chooseBackupDirectory() {
  const chosen = await api.chooseBackupDirectory();
  if (chosen.canceled) {
    setBackupMessage(t("desktop.renderer.backupCanceled"), "");
    return;
  }
  const localBackup = {
    ...(latestConfig?.localBackup || {}),
    directory: chosen.directory,
    retentionCount: Number($("#localBackupRetention")?.value || latestConfig?.localBackup?.retentionCount || 7)
  };
  latestConfig = await api.updateConfig({ localBackup });
  renderConfig(latestConfig);
  await loadBackupStatus();
  setBackupMessage(t("desktop.renderer.backupFolderSaved"), "ok");
}

async function clearLocalBackups() {
  const button = $("#clear-local-backups");
  button.disabled = true;
  setBackupMessage("", "");
  try {
    const result = await api.clearLocalBackups();
    renderBackupStatus({ ...(latestBackupStatus || {}), ...result });
    setBackupMessage(t("desktop.renderer.backupsCleared", { count: result.removed || 0 }), "ok");
  } finally {
    button.disabled = false;
  }
}

async function saveBackupPreferences() {
  const current = latestConfig?.localBackup || {};
  let directory = current.directory || "";
  const enabled = $("#localBackupEnabled")?.checked ?? false;
  if (enabled && !directory.trim()) {
    const chosen = await api.chooseBackupDirectory();
    if (chosen.canceled) {
      $("#localBackupEnabled").checked = false;
      setBackupMessage(t("desktop.renderer.backupCanceled"), "");
      return;
    }
    directory = chosen.directory;
  }
  const localBackup = {
    ...current,
    enabled,
    directory,
    retentionCount: Number($("#localBackupRetention")?.value || current.retentionCount || 7)
  };
  latestConfig = await api.updateConfig({ localBackup });
  renderConfig(latestConfig);
  await loadBackupStatus();
  setBackupMessage(t("desktop.renderer.backupSettingsSaved"), "ok");
}

async function revealBackupDirectory() {
  const directory = latestBackupStatus?.effectiveDirectory || latestConfig?.localBackup?.directory || "";
  if (!directory) {
    setBackupMessage(t("desktop.renderer.backupFolderMissing"), "error");
    return;
  }
  await api.revealBackupDirectory(directory);
}

async function loadBackupStatus() {
  latestBackupStatus = await api.localBackupStatus();
  renderBackupStatus(latestBackupStatus);
}

function renderBackupStatus(status = latestBackupStatus) {
  latestBackupStatus = status || {};
  const backupConfig = latestConfig?.localBackup || {};
  if ($("#localBackupEnabled")) $("#localBackupEnabled").checked = Boolean(backupConfig.enabled);
  if ($("#localBackupRetention")) $("#localBackupRetention").value = String(backupConfig.retentionCount || status?.retentionDays || 7);
  if ($("#localBackupDirectory")) $("#localBackupDirectory").value = backupConfig.directory || status?.effectiveDirectory || "";
  if ($("#backup-schedule-copy")) {
    $("#backup-schedule-copy").textContent = t("desktop.backup.schedule", {
      time: formatBackupScheduleTime(AUTO_BACKUP_DAILY_START)
    });
  }
}

function formatBackupScheduleTime({ hour, minute }) {
  if (getCurrentLang() === "zh-CN") {
    return `${hour} 点 ${String(minute).padStart(2, "0")} 分`;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function setBackupMessage(message, tone = "") {
  const el = $("#backup-message");
  if (!el) return;
  el.dataset.tone = tone;
  el.textContent = message;
}

function renderSystemStatus(state = {}) {
  if (state.client) latestClientInfo = state.client;
  const client = state.client || latestClientInfo || {};
  const server = state.server || {};
  const update = state.update || latestUpdateState?.update || null;
  renderUpdateStatusText({ client, server, update, allowServerLatest: Boolean(state.checkedAt || state.code) });
  renderRailStatus();
}

function renderUpdateStatusText({ client = latestClientInfo || {}, server = {}, update = latestUpdateState?.update || latestUpdateState?.lastResult || null, statusText = "", allowServerLatest = false } = {}) {
  const localVersion = client.clientAppVersion || "";
  const latestVersion = update?.latestVersion
    || latestUpdateState?.readyPackage?.latestVersion
    || server.latestClientVersion
    || (allowServerLatest ? server.latestClientVersion : "")
    || "";
  const intervalHours = UPDATE_CHECK_INTERVAL_MS / (60 * 60 * 1000);
  const parts = [
    localVersion ? t("desktop.renderer.localVersion", { version: localVersion }) : t("desktop.renderer.localVersionDash"),
    latestVersion ? t("desktop.renderer.latest", { version: latestVersion }) : t("desktop.renderer.latestDash"),
    t("desktop.renderer.autoCheckInterval", { hours: intervalHours })
  ];
  if (statusText) parts.push(statusText);
  setTextIfPresent("#update-status-text", parts.join(" · "));
}

function renderCloudStatus(config = latestConfig) {
  const apiBaseUrl = normalizeApiBaseUrl(config?.apiBaseUrl || "");
  const badge = $("#cloud-status-badge");
  const text = $("#cloud-status-text");
  if (!badge || !text) return;
  const syncStatus = _deriveRailSyncStatus({
    config,
    usageScanStatus: latestUsageScanStatus,
    backgroundStatus: latestBackgroundStatus,
    latestLocalSnapshot,
    foregroundSyncRunning,
    t,
    formatDateTime,
  });
  badge.textContent = syncStatus.label;
  badge.className = `badge ${syncStatus.state === "synced" ? "ok" : syncStatus.state === "attention" ? "warn" : ""}`.trim();
  text.textContent = syncStatus.detail || apiBaseUrl;
  text.title = syncStatus.title || "";
  renderCloudSyncDetails(syncStatus, config);
  renderRailStatus();
}

function updateMessage(state = {}) {
  if (state.code === "cloud_not_configured") return t("desktop.renderer.configureCloudUpdate");
  if (state.code === "release_not_configured") return t("desktop.renderer.releaseNotConfigured");
  if (state.code === "update_downloaded" || state.status === "downloaded" || state.readyPackage) return t("desktop.renderer.downloadedReady");
  return state.message || t("desktop.renderer.updateCheckFinished");
}


function renderCursorTokenSummary(cursorConfig = {}) {
  const connected = cursorConfig?.accounts || [];
  const accounts = connected.map((item) => item.email || item.accountHash || "Cursor").filter(Boolean);
  const summary = accounts.length
    ? (accounts.length === 1 ? t("desktop.renderer.cursorTokensConfiguredOne") : t("desktop.renderer.cursorTokensConfiguredPlural", { count: accounts.length }))
    : t("desktop.renderer.noCursorTokenAuto");
  const html = `<p class="cursor-token-note">${escapeHtml(summary)}</p>`;
  const target = $("#cursor-token-summary");
  if (target) {
    target.hidden = true;
    target.innerHTML = html;
  }
  return html;
}

function cursorAuthStatusLabel(status) {
  if (status === "refresh_failed") return t("desktop.cursorAuth.refreshFailed");
  if (status === "reauth_required") return t("desktop.cursorAuth.reauthRequired");
  return t("desktop.cursorAuth.active");
}

function cursorDetectedAccounts() {
  const cursorHealth = latestHealth.find((item) => item.providerId === "cursor_dashboard_usage");
  return [...new Set((cursorHealth?.roots || []).map((root) => String(root || "").trim()).filter(Boolean))];
}

function renderSyncStatus(config, result = null) {
  const status = config?.syncStatus || {};
  const configuredApiBaseUrl = normalizeApiBaseUrl(config?.apiBaseUrl || "");
  const statusApiBaseUrl = normalizeApiBaseUrl(status.apiBaseUrl || config?.lastSyncApiBaseUrl || "");
  const statusMatchesApi = statusApiBaseUrl && statusApiBaseUrl === configuredApiBaseUrl;
  const lastFinishedAt = statusMatchesApi ? status.lastFinishedAt || config?.lastSyncAt || "" : "";
  latestSyncInfo = lastFinishedAt ? t("desktop.renderer.lastSync", { time: formatDateTime(lastFinishedAt) }) : "";
  renderCloudStatus(config);
}

function renderCloudSyncDetails(syncStatus, config = latestConfig) {
  const details = $("#cloud-sync-details");
  if (!details) return;
  const badge = $("#cloud-sync-status-badge");
  const detailText = $("#cloud-sync-status-detail");
  const actionBtn = $("#cloud-sync-primary-action");
  const diag = $("#cloud-sync-diagnostics");

  details.hidden = false;

  if (badge) {
    badge.textContent = syncStatus.label;
    badge.className = `badge ${syncStatus.state === "synced" ? "ok" : syncStatus.state === "attention" ? "warn" : ""}`.trim();
  }
  if (detailText) detailText.textContent = t("desktop.syncStatus.diagnostics.title");

  if (actionBtn) {
    const showContextAction = syncStatus.action === "check_connection" || syncStatus.action === "update_client";
    if (showContextAction) {
      actionBtn.hidden = false;
      actionBtn.textContent = syncStatus.actionLabel;
      actionBtn.dataset.syncAction = syncStatus.action;
    } else {
      actionBtn.hidden = true;
      delete actionBtn.dataset.syncAction;
    }
  }

  const apiBaseUrl = normalizeApiBaseUrl(config?.apiBaseUrl || "");
  if (diag) {
    diag.hidden = !apiBaseUrl;
    const diagUrl = $("#diag-api-url");
    const diagConn = $("#diag-connection");
    const diagAttempt = $("#diag-last-attempt");
    const diagSuccess = $("#diag-last-success");
    const diagQueue = $("#diag-queue-pending");
    const diagBackgroundSync = $("#diag-background-sync");
    const diagError = $("#diag-last-error");
    if (diagUrl) diagUrl.textContent = apiBaseUrl || "-";
    if (diagConn) diagConn.textContent = config?.apiConnection?.status || "-";
    if (diagAttempt) diagAttempt.textContent = syncStatus.lastAttemptAt ? formatDateTime(syncStatus.lastAttemptAt) : "-";
    if (diagSuccess) diagSuccess.textContent = syncStatus.lastSuccessAt ? formatDateTime(syncStatus.lastSuccessAt) : "-";
    if (diagQueue) diagQueue.textContent = syncStatus.queuePending > 0 ? String(syncStatus.queuePending) : "0";
    if (diagBackgroundSync) diagBackgroundSync.textContent = fullReconcileStatusLabel(latestBackgroundStatus?.fullReconcile);
    if (diagError) diagError.textContent = syncStatus.lastError || "-";
  }
}

function fullReconcileStatusLabel(status) {
  if (!status) return "-";
  const value = String(status.status || "").toLowerCase();
  if (status.running || value === "running") return t("desktop.syncStatus.diagnostics.backgroundSync.running");
  if (value === "pending") return t("desktop.syncStatus.diagnostics.backgroundSync.pending");
  if (value === "failed") return t("desktop.syncStatus.diagnostics.backgroundSync.failed");
  if (value === "unrecoverable") return t("desktop.syncStatus.diagnostics.backgroundSync.unrecoverable");
  if (value === "completed") return t("desktop.syncStatus.diagnostics.backgroundSync.completed");
  return "-";
}

function getOverviewTotalTokens() {
  const summary = usageQueryState.summaries.get(overviewRange);
  const localRangeItems = usageForRange(overviewRange);
  const rangeItems = summary ? [] : localRangeItems;
  const composition = summary?.totals || aggregateComposition(rangeItems);
  return summary ? composition.totalTokens : rangeItems.reduce((sum, item) => sum + item.totalTokens, 0);
}

function renderToday() {
  const summary = usageQueryState.summaries.get(overviewRange);
  const localRangeItems = usageForRange(overviewRange);
  const hasLocalRangeItems = localRangeItems.length > 0;
  const rangeItems = summary ? [] : localRangeItems;
  const composition = summary?.totals || aggregateComposition(rangeItems);
  const total = summary ? composition.totalTokens : rangeItems.reduce((sum, item) => sum + item.totalTokens, 0);
  const showOverviewCost = Boolean(latestConfig?.showEstimatedCost && (hasLocalRangeItems || !summary));
  const breakdownItems = showOverviewCost && hasLocalRangeItems ? localRangeItems : rangeItems;
  const workdirs = breakdownItems.length ? groupBy(breakdownItems, "workdirDisplayName") : summary?.workdirs || [];
  const models = breakdownItems.length ? groupBy(breakdownItems, "model") : summary?.models || [];
  const providers = breakdownItems.length
    ? groupProviders(breakdownItems)
    : summary?.providers?.map((row) => ({ ...row, name: sourceName(row.name) })) || [];
  const cost = showOverviewCost && hasLocalRangeItems
    ? aggregateUsageCost(localRangeItems)
    : summary && !rangeItems.length ? {} : aggregateUsageCost(rangeItems);

  $("#today-total").textContent = formatToken(total);
  $("#today-total").title = formatTokenRaw(total);
  setTextIfPresent("#overview-input-tokens", formatToken(composition.inputTokens));
  setTextIfPresent("#overview-output-tokens", formatToken(composition.outputTokens));
  setTextIfPresent("#overview-cache-tokens", formatToken(cacheTokens(composition)));

  const compTotal = composition.totalTokens || 1;
  visibleCompositionFields(composition).forEach(([key, tokens, field]) => {
    const detailEl = document.querySelector(`#overview-${key}-detail`);
    if (!detailEl) return;
    const pct = Math.round(tokens / compTotal * 100) + "%";
    const costPart = showOverviewCost ? ` · ${renderCostAmountValue(costValueForField(cost, field) || 0)}` : "";
    detailEl.innerHTML = escapeHtml(pct) + costPart;
  });

  const costEl = document.querySelector("#today-cost");
  if (costEl) {
    if (showOverviewCost) {
      costEl.innerHTML = `${renderCostAmount(cost)} <span class="cost-note">${escapeHtml(t("common.estimated").toLowerCase())}</span>`;
      costEl.title = costTitle(cost);
    } else {
      costEl.textContent = "";
      costEl.title = "";
    }
  }

  $("#provider-list").innerHTML = providers.length
    ? renderMiniMeters(providers, { showCost: showOverviewCost, limit: 3, colorClasses: ["meter-yellow", "", ""] })
    : `<div class="empty-state">${t("desktop.overview.noProviderUsage")}</div>`;
  $("#workdir-list").innerHTML = workdirs.length
    ? renderMiniMeters(workdirs, { showCost: showOverviewCost, limit: 3, colorClasses: ["", "meter-yellow", "meter-violet"] })
    : `<div class="empty-state">${t("desktop.renderer.noWorkdirUsage")}</div>`;
  $("#model-list").innerHTML = models.length
    ? renderMiniMeters(models, { showCost: showOverviewCost, limit: 3, colorClasses: ["meter-violet", "", "meter-yellow"] })
    : `<div class="empty-state">${t("desktop.renderer.noModelUsage")}</div>`;
  renderOverviewTrend(localRangeItems);
  renderRailStatus();
  syncTrayCostState();
  updateShareButtonState();
}

function renderWorkdirs() {
  const query = usageQueryState.workdirs.get(workdirsRange);
  const todayQuery = usageQueryState.workdirs.get("today");
  const rangeItems = query ? [] : usageForRange(workdirsRange);
  const todayWorkdirs = todayQuery?.items || groupWorkdirDetails(usageForRange("today"));
  const total = query ? (query.items || []).reduce((sum, item) => sum + item.totalTokens, 0) : rangeItems.reduce((sum, item) => sum + item.totalTokens, 0);
  const todayTokenByWorkdir = new Map(todayWorkdirs.map((item) => [item.workdirHash, item.totalTokens]));
  const rawWorkdirs = query?.items || groupWorkdirDetails(rangeItems);
  const denominator = total || 1;
  const workdirs = rawWorkdirs.map((item) => ({
    ...item,
    contributionRatio: item.contributionRatio ?? (item.totalTokens || 0) / denominator,
    todayTokens: todayTokenByWorkdir.get(item.workdirHash) || 0
  }));
  $("#workdirs-summary").textContent = workdirs.length
    ? t("desktop.workdirs.summary", { count: workdirs.length })
    : t("desktop.renderer.noWorkdirUsage");
  $("#workdirs-analysis-list").innerHTML = workdirs.length
    ? renderWorkdirCards(workdirs)
    : `<article class="empty-state">${t("desktop.renderer.noWorkdirs")}</article>`;
}

function renderOverviewTrend(items) {
  const grain = overviewTrendGrain();
  const queryTrend = usageQueryState.trends.get(usageQueryKey(overviewRange, grain));
  const localRows = () => overviewRange === "today"
    ? groupByHour(items)
    : groupByGrain(items.length ? items : usageForRange(overviewRange), grain).filter(hasPositiveUsage);
  const rows = latestConfig?.showEstimatedCost && items.length ? localRows() : queryTrend?.items || localRows();
  const max = Math.max(...rows.map((row) => row.totalTokens), 1);
  const peakIdx = rows.length ? rows.reduce((best, row, i) => row.totalTokens > rows[best].totalTokens ? i : best, 0) : -1;

  $("#overview-trend-summary").textContent = rows.length
    ? t(`desktop.overview.trend.${overviewRange}`)
    : t("desktop.renderer.noLocalUsageFound");

  const sparkEl = $("#overview-trend");
  const axisEl = $("#overview-trend-axis");
  const wrapEl = sparkEl.parentElement;

  if (rows.length) {
    const cols = rows.length;
    const gridCols = `repeat(${cols}, minmax(0, 1fr))`;

    sparkEl.style.gridTemplateColumns = gridCols;
    sparkEl.innerHTML = rows.map((row, i) => {
      const isHot = i === peakIdx;
      return `<div class="spark-bar${isHot ? " hot" : ""}" data-open-overview-trend="${escapeHtml(trendBucketKey(row))}" style="height:${Math.max(12, (row.totalTokens / max) * 100)}%; transition: height 0.3s ease; cursor: pointer;">
        ${renderSparkBarValue(row)}
      </div>`;
    }).join("");

    axisEl.style.gridTemplateColumns = gridCols;
    axisEl.innerHTML = rows.map((row) => formatAxisLabel(row, grain)).join("");
  } else {
    sparkEl.style.gridTemplateColumns = "";
    sparkEl.innerHTML = `<div class="empty-state">${t("desktop.renderer.noLocalUsageFound")}</div>`;
    axisEl.innerHTML = "";
  }
}

function overviewTrendGrain() {
  if (overviewRange === "today") return "hour";
  if (overviewRange === "30d") return "week";
  if (overviewRange === "all") return "month";
  return "day";
}

function renderSparkBarValue(row) {
  return `<span class="spark-bar-value">
    <strong>${formatToken(row.totalTokens)}</strong>
    ${latestConfig?.showEstimatedCost ? renderCostAmount(row) : ""}
  </span>`;
}

function groupByGrain(items, grain) {
  const map = new Map();
  for (const item of items) {
    const bucket = bucketForDay(item.day, grain);
    const row = map.get(bucket.key) || {
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0,
      costQuality: "",
      pricingVersion: "",
      totalTokens: 0
    };
    const withCost = addDisplayCostToUsageItem(item);
    row.inputTokens += item.inputTokens || 0;
    row.outputTokens += item.outputTokens || 0;
    row.reasoningTokens += item.reasoningTokens || 0;
    row.cacheReadTokens += item.cacheReadTokens || 0;
    row.cacheWriteTokens += item.cacheWriteTokens || 0;
    row.totalTokens += item.totalTokens || 0;
    aggregateCost(row, withCost);
    map.set(bucket.key, row);
  }
  return [...map.values()]
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart))
    .map((row) => ({ ...row, missingPriceModels: sortedBreakdown(row.missingPriceModels || {}) }));
}

function groupByHour(items) {
  const map = new Map();
  for (const item of items) {
    const hour = clampHour(item.hour);
    const key = `${item.day}|${hour}`;
    const row = map.get(key) || emptyTrendRow({
      periodStart: item.day,
      periodEnd: item.day,
      hour,
      bucketLabel: formatHourLabel(hour)
    });
    const withCost = addDisplayCostToUsageItem(item);
    addUsageToTrendRow(row, item, withCost);
    addCostBreakdownItem(row.modelBreakdownMap, item.model || "unknown", item, withCost);
    addCostBreakdownItem(row.workdirBreakdownMap, item.workdirDisplayName || "unknown", item, withCost);
    map.set(key, row);
  }
  return [...map.values()]
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart) || (a.hour ?? 0) - (b.hour ?? 0))
    .map(finalizeTrendRow)
    .filter(hasPositiveUsage);
}

function emptyTrendRow(extra = {}) {
  return {
    periodStart: "",
    periodEnd: "",
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
    costQuality: "",
    pricingVersion: "",
    totalTokens: 0,
    modelBreakdownMap: {},
    workdirBreakdownMap: {},
    ...extra
  };
}

function addUsageToTrendRow(row, item, withCost = addDisplayCostToUsageItem(item)) {
  row.inputTokens += item.inputTokens || 0;
  row.outputTokens += item.outputTokens || 0;
  row.reasoningTokens += item.reasoningTokens || 0;
  row.cacheReadTokens += item.cacheReadTokens || 0;
  row.cacheWriteTokens += item.cacheWriteTokens || 0;
  row.totalTokens += item.totalTokens || 0;
  aggregateCost(row, withCost);
  return row;
}

function finalizeTrendRow(row) {
  return {
    ...row,
    compositionSummary: tokenCompositionSummary(row),
    missingPriceModels: sortedBreakdown(row.missingPriceModels || {}),
    modelBreakdown: finalizeCostBreakdown(row.modelBreakdownMap || {}),
    workdirBreakdown: finalizeCostBreakdown(row.workdirBreakdownMap || {})
  };
}

const hasPositiveUsage = _hasPositiveUsage;

function formatAxisLabel(row, grain) {
  if (grain === "hour") {
    const hour = clampHour(row.hour);
    return `<span>${String(hour).padStart(2, "0")}:00</span>`;
  }
  const start = new Date(row.periodStart + "T00:00:00Z");
  if (grain === "month") {
    return `<span>${start.getUTCFullYear()}/${String(start.getUTCMonth() + 1).padStart(2, "0")}</span>`;
  }
  if (grain === "week") {
    const end = new Date(row.periodEnd + "T00:00:00Z");
    const sLabel = `${String(start.getUTCMonth() + 1).padStart(2, "0")}/${String(start.getUTCDate()).padStart(2, "0")}`;
    const eLabel = `${String(end.getUTCMonth() + 1).padStart(2, "0")}/${String(end.getUTCDate()).padStart(2, "0")}`;
    return `<span>${sLabel}-${eLabel}</span>`;
  }
  return `<span>${String(start.getUTCMonth() + 1).padStart(2, "0")}/${String(start.getUTCDate()).padStart(2, "0")}</span>`;
}


function renderRailStatus() {
  const update = latestUpdateState?.update || latestUpdateState?.lastResult || null;
  const readyPackage = latestUpdateState?.readyPackage || null;
  renderRailSyncStatus();
  const nextScanAt = latestBackgroundStatus?.nextRunAt || "";
  setTextIfPresent("#rail-next-scan", t("desktop.renderer.nextScan", { time: nextScanAt ? formatDateTime(nextScanAt) : "-" }));
  const restartBtn = $("#rail-restart-update");
  if (restartBtn) {
    const shouldShow = readyPackage || latestUpdateState?.status === "downloaded" || update?.status === "downloaded" || updateDownloadedPersisted;
    restartBtn.hidden = !shouldShow;
    restartBtn.disabled = updateInstallRunning;
  }
}

function latestTimestamp(values = []) {
  return values
    .filter(Boolean)
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.time))
    .sort((a, b) => b.time - a.time)[0]?.value || "";
}

function renderRailSyncStatus(override = null) {
  const root = $("#rail-cloud-status");
  const text = $("#rail-cloud-status-text");
  if (!root || !text) return;
  const status = override || currentRailSyncStatus();
  root.dataset.state = status.state;
  if (status.reason) root.dataset.reason = status.reason;
  else delete root.dataset.reason;
  text.textContent = status.label;
  root.title = status.title || status.label;
  setTextIfPresent("#rail-last-scan", status.detail || "");
}

function currentRailSyncStatus() {
  return _deriveRailSyncStatus({
    config: latestConfig,
    usageScanStatus: latestUsageScanStatus,
    backgroundStatus: latestBackgroundStatus,
    latestLocalSnapshot,
    foregroundSyncRunning,
    t,
    formatDateTime,
  });
}

function renderTrend() {
  if (!$("#trend-chart-panel")) return;
  virtualModelDetailTables.clear();
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
    : `<article class="empty-state">${t("desktop.renderer.noLocalUsageFound")}</article>`;
  $("#trend-rows").innerHTML = rows.length
    ? rows
        .map((row) => `<tr>
          <td><button type="button" data-expand-trend="${escapeHtml(trendBucketKey(row))}">${trendDrawerBucketKey === trendBucketKey(row) ? t("common.hide") : t("common.show")}</button> ${formatTrendPeriod(row)}</td>
          <td class="numeric" title="${formatTokenRaw(row.totalTokens)}">${formatToken(row.totalTokens)}</td>
          <td>${escapeHtml(row.compositionSummary || tokenCompositionSummary(row))}</td>
          <td>${renderCompactBreakdown(row.modelBreakdown)}</td>
          <td>${renderCompactBreakdown(row.workdirBreakdown)}</td>
          ${latestConfig?.showEstimatedCost ? `<td class="numeric" title="${escapeHtml(costTitle(row))}">${renderCostAmount(row)}</td>` : ""}
        </tr>`)
        .join("")
    : `<tr><td colspan="${latestConfig?.showEstimatedCost ? 6 : 5}" class="empty-cell">${t("desktop.renderer.noLocalUsageFound")}</td></tr>`;
  $("#trend-selection-panel").hidden = trendMode === "table";
  $("#trend-selection-panel").innerHTML = trendMode === "chart" && rows.length && selectedTrendBucketKey
    ? renderTrendSelection(rows.find((row) => trendBucketKey(row) === selectedTrendBucketKey))
    : "";
  renderTrendDrawer(rows);
  hydrateVirtualModelDetailTables();
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
  if (!$("#workdir-alias-list")) return;
  const workdirs = usageQueryState.workdirs.get("all")?.items || groupWorkdirs(allUsage);
  $("#workdir-alias-list").innerHTML = workdirs.length
    ? workdirs
        .map((item) => `<article class="alias-row">
          <div>
            <strong>${escapeHtml(item.name)}</strong>
            <small title="${formatTokenRaw(item.totalTokens)}">${formatToken(item.totalTokens)} ${t("unit.tokens")}</small>
          </div>
          <input data-alias-input="${escapeHtml(item.workdirHash)}" data-current-alias="${escapeHtml(latestConfig?.workdirAliases?.[item.workdirHash] || "")}" value="${escapeHtml(latestConfig?.workdirAliases?.[item.workdirHash] || "")}" placeholder="${escapeHtml(t("desktop.workdir.aliasPlaceholder"))}" />
        </article>`)
        .join("")
    : `<article class="empty-state">${t("desktop.renderer.noWorkdirs")}</article>`;
}

function renderHealth() {
  const selectedHealth = latestHealth.filter((item) => item.providerId === sourcesProviderTab);
  const renderItems = selectedHealth.length ? selectedHealth : latestHealth;
  const html = renderItems
    .map((item) => {
      const enabled = sourceEnabled(item);
      const sources = item.sources || [];
      const autoSources = sources.filter(s => s.kind === "auto" && !s.ignored);
      const manualSources = sources.filter(s => s.kind === "manual" && !s.ignored);
      const ignoredSources = sources.filter(s => s.ignored);
      const addBtn = item.providerId === "cursor_dashboard_usage"
        ? `<button class="outline-button" id="connect-cursor" style="padding:4px 10px;font-size:12px;" type="button">+ ${t("desktop.sources.addCursor")}</button>`
        : item.providerId === "codex_local"
          ? `<button class="outline-button" id="add-codex-root" style="padding:4px 10px;font-size:12px;" type="button">+ ${t("desktop.sources.addCodex")}</button>`
          : `<button class="outline-button" id="add-claude-root" style="padding:4px 10px;font-size:12px;" type="button">+ ${t("desktop.sources.addClaude")}</button>`;
      return `<article class="provider-card">
      <div class="provider-card-head">
        <div>
          <h4>${sourceName(item.providerId)}</h4>
          <div class="muted">${sourceSummary(item)}</div>
        </div>
        ${sourceSwitchButton(enabled, `data-toggle-source="${escapeHtml(item.providerId)}" data-source-state="${enabled ? "enabled" : "disabled"}"`)}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin:0 0 8px;">
        <p class="muted" style="font-size:12px;margin:0;">${sourceDescription(item.providerId)}</p>
        ${addBtn}
      </div>
      ${item.providerId === "cursor_dashboard_usage" ? renderCursorTokenSummary(latestConfig?.cursorDashboardUsage) : ""}
      ${renderSourceRows(autoSources, manualSources, ignoredSources, item.providerId)}
    </article>`;
    })
    .join("");
  $("#settings-source-list").innerHTML = html;
  renderRailStatus();
}

async function toggleSource(providerId) {
  const current = latestConfig || await api.getConfig();
  if (!current) throw new Error(t("desktop.renderer.openSettingsFirst"));
  const nextEnabled = !sourceEnabledForConfig(current, providerId);
  const previousConfig = current;
  const previousHealth = latestHealth;
  latestConfig = applySourceEnabled(current, providerId, nextEnabled);
  latestHealth = latestHealth.map((item) => item.providerId === providerId ? { ...item, enabled: nextEnabled } : item);
  renderConfig(latestConfig);
  renderHealth();
  setSaveMessage(`${sourceName(providerId)} ${nextEnabled ? t("desktop.renderer.enabling") : t("desktop.renderer.disabling")}`, "");
  try {
    latestConfig = await api.updateConfig(sourceTogglePayload(providerId, nextEnabled, current));
    renderConfig(latestConfig);
    setSaveMessage(`${sourceName(providerId)} ${nextEnabled ? t("desktop.renderer.enabled") : t("desktop.renderer.disabled")}`, "ok");
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
  return item.enabled !== false;
}

function sourceEnabledForConfig(config, providerId) {
  if (providerId === "cursor_dashboard_usage") return config.providerEnabled?.cursor_dashboard_usage === true;
  return config.providerEnabled?.[providerId] !== false;
}

function sourceToggleTitle(enabled) {
  return enabled ? t("desktop.sources.toggleEnabledTitle") : t("desktop.sources.toggleDisabledTitle");
}

function sourceSwitchButton(enabled, attributes) {
  const state = enabled ? "true" : "false";
  return `<button class="source-switch ${enabled ? "is-on" : "is-off"}" type="button" ${attributes} role="switch" aria-checked="${state}" aria-pressed="${state}" title="${escapeHtml(sourceToggleTitle(enabled))}" aria-label="${escapeHtml(sourceToggleTitle(enabled))}"></button>`;
}

function updateSourceSwitchButton(button, enabled) {
  const state = enabled ? "true" : "false";
  button.setAttribute("aria-checked", state);
  button.setAttribute("aria-pressed", state);
  button.title = sourceToggleTitle(enabled);
  button.setAttribute("aria-label", sourceToggleTitle(enabled));
  button.classList.toggle("is-on", enabled);
  button.classList.toggle("is-off", !enabled);
}

function sourceTogglePayload(providerId, enabled, config) {
  return {
    providerEnabled: {
      ...(config.providerEnabled || {}),
      [providerId]: enabled
    }
  };
}

function applySourceEnabled(config, providerId, enabled) {
  return {
    ...config,
    providerEnabled: {
      ...(config.providerEnabled || {}),
      [providerId]: enabled
    }
  };
}

function sourceSummary(item) {
  const sources = item.sources || [];
  const autoCount = sources.filter(s => s.kind === "auto" && !s.ignored).length;
  const manualCount = sources.filter(s => s.kind === "manual").length;
  const totalCount = autoCount + manualCount;
  if (item.providerId === "cursor_dashboard_usage") {
    if (!totalCount) return t("desktop.sources.noCursorAccountDetected");
    return totalCount === 1 ? t("desktop.sources.accountSourceOne") : t("desktop.sources.accountSources", { count: totalCount });
  }
  if (!item.detected) return t("desktop.renderer.notFound");
  return totalCount === 1 ? t("desktop.sources.locationOne") : t("desktop.sources.locations", { count: totalCount });
}

function sourceDescription(providerId) {
  if (providerId === "cursor_dashboard_usage") return t("desktop.sources.cursorDesc");
  return t("desktop.sources.localDesc");
}

async function loadBackgroundStatus(args = {}) {
  if (backgroundStatusInFlight) {
    backgroundStatusQueuedArgs = mergeBackgroundStatusArgs(backgroundStatusQueuedArgs, args);
    return backgroundStatusInFlight;
  }
  backgroundStatusInFlight = doLoadBackgroundStatus(args)
    .finally(() => {
      backgroundStatusInFlight = null;
      if (backgroundStatusQueuedArgs) {
        const queued = backgroundStatusQueuedArgs;
        backgroundStatusQueuedArgs = null;
        loadBackgroundStatus(queued).catch((error) => console.error(error));
      }
    });
  return backgroundStatusInFlight;
}

function mergeBackgroundStatusArgs(left = null, right = {}) {
  return {
    ...(left || {}),
    ...right,
    refreshConfig: Boolean(left?.refreshConfig || right.refreshConfig),
    skipScanRefresh: Boolean(left?.skipScanRefresh || right.skipScanRefresh)
  };
}

async function doLoadBackgroundStatus({ config = latestConfig, refreshConfig = false, skipScanRefresh = false } = {}) {
  const previousCacheScannedAt = latestBackgroundStatus?.cacheScannedAt || "";
  const fullReconcileLoad = typeof api.fullReconcileStatus === "function"
    ? api.fullReconcileStatus().catch(() => null)
    : Promise.resolve(null);
  const [status, freshConfig, fullReconcileStatus] = await Promise.all([
    api.backgroundStatus(),
    refreshConfig ? api.getConfig() : Promise.resolve(config),
    fullReconcileLoad
  ]);
  config = refreshConfig ? (freshConfig || config) : (latestConfig || config);
  latestBackgroundStatus = fullReconcileStatus ? { ...status, fullReconcile: fullReconcileStatus } : status;
  if (status.updateCheck) {
    latestUpdateState = {
      ...(latestUpdateState || {}),
      ...status.updateCheck
    };
    if (updateDownloadedPersisted) latestUpdateState.status = "downloaded";
  }
  if (status.sourceFingerprint && !latestLocalSnapshot) {
    latestLocalSnapshot = { scannedAt: status.cacheScannedAt || "", sourceFingerprint: status.sourceFingerprint, rowCount: 0, fromCache: true };
  }
  if (refreshConfig && config) {
    latestConfig = config;
    renderSyncStatus(config);
  } else if (config) {
    renderSyncStatus(config);
  }
  renderSilentUpdateStatus(latestUpdateState, config);
  renderRailStatus();
  checkMandatoryFromConfig(config);
  if (!skipScanRefresh && previousCacheScannedAt && status.cacheScannedAt && status.cacheScannedAt !== previousCacheScannedAt && !status.running && !scanRunning && !scanPollTimer) {
    const scanStatus = await api.startUsageScan({ force: false, syncAfter: shouldSyncAfterRefresh() });
    applyUsageScanStatus(scanStatus);
    if (scanStatus.running || scanStatus.syncRunning) {
      restartUsageScanPoll();
    } else {
      await finalizeUsageScanStatus(scanStatus);
    }
  }
}

function renderSilentUpdateStatus(updateCheck = {}, config = latestConfig) {
  const statusParts = [];
  if (updateCheck?.lastResult?.latestVersion && updateCheck?.status === "downloaded") {
    statusParts.push(t("desktop.renderer.ready", { version: updateCheck.lastResult.latestVersion }));
  }
  if (updateCheck?.nextCheckAt) statusParts.push(t("desktop.renderer.next", { time: formatTime(updateCheck.nextCheckAt) }));
  if (updateCheck?.lastError) statusParts.push(t("desktop.renderer.error", { error: updateCheck.lastError }));
  renderUpdateStatusText({ server: config?.apiConnection || latestConfig?.apiConnection || {}, update: updateCheck?.update || updateCheck?.lastResult || null, statusText: statusParts.join(" · ") });
  const badge = $("#update-badge");
  if (badge) {
    const ready = hasReadyUpdatePackage(updateCheck);
    const downloading = isUpdateDownloading(updateCheck);
    const available = hasUpdateAvailable(updateCheck);
    badge.hidden = downloading || (!available && !ready);
    badge.textContent = ready
      ? t("desktop.about.readyToRestart")
      : available ? t("desktop.renderer.updateAvailable") : "";
    badge.className = ready ? "badge ok" : available ? "badge" : "badge";
  }
  renderUpdateActions(updateCheck);
}

function renderSourceRows(autoSources, manualSources, ignoredSources, providerId) {
  const allVisible = [...manualSources, ...autoSources];
  if (!allVisible.length && !ignoredSources.length) return "";
  let html = '<div class="source-rows">';
  for (const source of manualSources) {
    const label = escapeHtml(source.label);
    const id = escapeHtml(source.id);
    if (providerId === "cursor_dashboard_usage" && source.tokenIndex !== undefined) {
      html += sourceRowHtml({
        badge: t("desktop.sources.kindManual"),
        label,
        actions: `<button class="outline-button" type="button" data-remove-cursor-token="${source.tokenIndex}">${t("desktop.sources.removeBtn")}</button>`
      });
    } else if (providerId === "cursor_dashboard_usage" && source.accountIndex !== undefined) {
      const status = escapeHtml(cursorAuthStatusLabel(source.authStatus || "active"));
      html += sourceRowHtml({
        badge: status,
        label,
        actions: `<button class="outline-button" type="button" data-ignore-source="${id}" data-provider-id="${escapeHtml(providerId)}">${t("desktop.sources.ignore")}</button><button class="outline-button" type="button" data-disconnect-cursor-account="${source.accountIndex}">${t("desktop.sources.removeBtn")}</button>`
      });
    } else {
      html += sourceRowHtml({
        badge: t("desktop.sources.kindManual"),
        label,
        actions: `<button class="outline-button" type="button" data-remove-root="${id}" data-provider-id="${escapeHtml(providerId)}">${t("desktop.sources.removeBtn")}</button>`
      });
    }
  }
  for (const source of autoSources) {
    const label = escapeHtml(source.label);
    const id = escapeHtml(source.id);
    html += sourceRowHtml({
      badge: t("desktop.sources.kindAuto"),
      badgeClass: "ok",
      label,
      actions: `<button class="outline-button" type="button" data-ignore-source="${id}" data-provider-id="${escapeHtml(providerId)}">${t("desktop.sources.ignore")}</button>`
    });
  }
  if (ignoredSources.length) {
    for (const source of ignoredSources) {
      const accountRemove = providerId === "cursor_dashboard_usage" && source.accountIndex !== undefined
        ? `<button class="outline-button" type="button" data-disconnect-cursor-account="${source.accountIndex}">${t("desktop.sources.removeBtn")}</button>`
        : "";
      html += sourceRowHtml({
        badge: t("desktop.sources.kindIgnored"),
        label: escapeHtml(source.label || ""),
        muted: true,
        actions: `<button class="outline-button" type="button" data-unignore-source="${escapeHtml(source.id)}" data-provider-id="${escapeHtml(providerId)}">${t("desktop.sources.unignore")}</button>${accountRemove}`
      });
    }
  }
  html += '</div>';
  return html;
}

function sourceRowHtml({ badge, badgeClass = "", label, actions, muted = false }) {
  const mutedClass = muted ? " source-row-muted" : "";
  const badgeClasses = ["badge", badgeClass].filter(Boolean).join(" ");
  return `<div class="source-row${mutedClass}"><div class="source-row-main"><span class="${badgeClasses}">${badge}</span><span class="path" title="${label}">${label}</span></div><div class="source-row-actions">${actions}</div></div>`;
}

function groupBy(items, key) {
  const map = {};
  for (const item of items) {
    const name = item[key] || "unknown";
    addCostBreakdownItem(map, name, item, addDisplayCostToUsageItem(item));
  }
  return finalizeCostBreakdown(map);
}

function groupProviders(items) {
  const rows = groupBy(items, "providerId");
  return rows.map((row) => ({ ...row, name: sourceName(row.name) }));
}

function usageForRange(range) {
  const allowed = daysForRange(range);
  if (!allowed) return [...allUsage];
  return allUsage.filter((item) => allowed.has(item.day));
}

function daysForRange(range) {
  if (range === "all") return null;
  if (range === "7d") return new Set(trailingDays(7));
  if (range === "30d") return new Set(trailingDays(30));
  return new Set([localDay()]);
}

function rangeLabel(range) {
  if (range === "7d") return t("desktop.range.7d");
  if (range === "30d") return t("desktop.range.30d");
  if (range === "all") return t("desktop.range.all");
  return t("desktop.range.today");
}

function setSegmentActive(container, value) {
  container.querySelectorAll("button[data-range]").forEach((item) => item.classList.toggle("active", item.dataset.range === value));
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
        modelBreakdownMap: {},
        workdirBreakdownMap: {},
        modelDetailMap: {},
        detailItems: []
      };
    const withCost = addDisplayCostToUsageItem(item);
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
    row.inputTokens += item.inputTokens || 0;
    row.outputTokens += item.outputTokens || 0;
    row.reasoningTokens += item.reasoningTokens || 0;
    row.cacheReadTokens += item.cacheReadTokens || 0;
    row.cacheWriteTokens += item.cacheWriteTokens || 0;
    row.totalTokens += item.totalTokens || 0;
    aggregateCost(row, withCost);
    addCostBreakdownItem(row.modelBreakdownMap, item.model || "unknown", item, withCost);
    addCostBreakdownItem(row.workdirBreakdownMap, item.workdirDisplayName || "unknown", item, withCost);
    row.detailItems.push(item);
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
      modelBreakdown: finalizeCostBreakdown(row.modelBreakdownMap || {}),
      workdirBreakdown: finalizeCostBreakdown(row.workdirBreakdownMap || {}),
      detailBreakdown: groupOverviewDetailBreakdown(row.detailItems || [], meta.grain),
      detailBreakdownTitle: detailBreakdownTitleForParentGrain(meta.grain),
      modelDetails: Object.values(row.modelDetailMap || {}).sort((a, b) => b.totalTokens - a.totalTokens),
      models: [...row.models].sort()
    }))
    .filter(hasPositiveUsage);
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

function groupWorkdirDetails(items) {
  const map = new Map();
  for (const item of items) {
    const key = item.workdirHash || item.workdirDisplayName || "unknown";
    const current = map.get(key) || {
      workdirHash: item.workdirHash || key,
      name: item.workdirDisplayName || "unknown",
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      modelMap: {},
      modelCostMap: {},
      dailyMap: {},
      dailyCostMap: {},
      estimatedCostUsd: 0,
      costQuality: "",
      pricingVersion: ""
    };
    const withCost = addDisplayCostToUsageItem(item);
    current.totalTokens += item.totalTokens || 0;
    current.inputTokens += item.inputTokens || 0;
    current.outputTokens += item.outputTokens || 0;
    current.cacheReadTokens += item.cacheReadTokens || 0;
    current.cacheWriteTokens += item.cacheWriteTokens || 0;
    current.reasoningTokens += item.reasoningTokens || 0;
    current.modelMap[item.model || "unknown"] = (current.modelMap[item.model || "unknown"] || 0) + (item.totalTokens || 0);
    const modelCost = current.modelCostMap[item.model || "unknown"] || { name: item.model || "unknown", totalTokens: 0, estimatedCostUsd: 0, costQuality: "", pricingVersion: "" };
    modelCost.totalTokens += item.totalTokens || 0;
    aggregateCost(modelCost, withCost);
    current.modelCostMap[item.model || "unknown"] = modelCost;
    current.dailyMap[item.day] = (current.dailyMap[item.day] || 0) + (item.totalTokens || 0);
    const dailyCost = current.dailyCostMap[item.day] || { name: item.day, totalTokens: 0, estimatedCostUsd: 0, costQuality: "", pricingVersion: "" };
    dailyCost.totalTokens += item.totalTokens || 0;
    aggregateCost(dailyCost, withCost);
    current.dailyCostMap[item.day] = dailyCost;
    aggregateCost(current, withCost);
    map.set(key, current);
  }
  const total = items.reduce((sum, item) => sum + (item.totalTokens || 0), 0) || 1;
  return [...map.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((item) => ({
      ...item,
      contributionRatio: item.totalTokens / total,
      modelBreakdown: finalizeCostBreakdown(item.modelCostMap || {}),
      dailyBreakdown: finalizeCostBreakdown(item.dailyCostMap || {}).sort((a, b) => a.name.localeCompare(b.name)),
      missingPriceModels: sortedBreakdown(item.missingPriceModels || {})
    }));
}

function groupDailyRows(items) {
  const map = new Map();
  for (const item of items) {
    const row = map.get(item.day) || {
      periodStart: item.day,
      periodEnd: item.day,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      costQuality: "",
      pricingVersion: "",
      modelBreakdownMap: {},
      workdirBreakdownMap: {}
    };
    const withCost = addDisplayCostToUsageItem(item);
    row.inputTokens += item.inputTokens || 0;
    row.outputTokens += item.outputTokens || 0;
    row.reasoningTokens += item.reasoningTokens || 0;
    row.cacheReadTokens += item.cacheReadTokens || 0;
    row.cacheWriteTokens += item.cacheWriteTokens || 0;
    row.totalTokens += item.totalTokens || 0;
    aggregateCost(row, withCost);
    addCostBreakdownItem(row.modelBreakdownMap, item.model || "unknown", item, withCost);
    addCostBreakdownItem(row.workdirBreakdownMap, item.workdirDisplayName || "unknown", item, withCost);
    map.set(item.day, row);
  }
  return [...map.values()]
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart))
    .map((row) => ({
      ...row,
      modelBreakdown: finalizeCostBreakdown(row.modelBreakdownMap || {}),
      workdirBreakdown: finalizeCostBreakdown(row.workdirBreakdownMap || {}),
      compositionSummary: tokenCompositionSummary(row),
      missingPriceModels: sortedBreakdown(row.missingPriceModels || {})
    }));
}

function renderMiniMeters(items, { showCost = false, limit = Infinity, colorClasses = [] } = {}) {
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  return items
    .slice(0, limit)
    .map((item, index) => {
      const pct = Math.max(3, (item.totalTokens / max) * 100);
      const name = escapeHtml(item.name);
      const val = formatToken(item.totalTokens);
      const cost = showCost ? renderCost(item) : "";
      const colorClass = colorClasses[index % colorClasses.length] || "";
      return `<div class="mini-meter-row">
        <span title="${name}">${name}</span>
        <div class="mini-meter ${colorClass}"><i style="width:${pct}%; transition: width 0.3s ease;"></i></div>
        <span class="meter-value" title="${formatTokenRaw(item.totalTokens)}${cost ? ` · ${escapeHtml(costTitle(item))}` : ""}">
          <strong>${val}</strong>
          ${cost ? renderCostAmount(item) : ""}
        </span>
      </div>`;
    })
    .join("");
}

function renderDetailMeters(items = []) {
  if (!items.length) return `<article class="empty-state">${t("desktop.renderer.noLocalUsageFound")}</article>`;
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  const colorClasses = ["", "meter-yellow", "meter-violet"];
  return `<div class="drawer-meter-list">${items
    .map((item, index) => {
      const pct = Math.max(3, (item.totalTokens / max) * 100);
      const name = escapeHtml(item.name);
      const cost = latestConfig?.showEstimatedCost ? renderCost(item) : "";
      const colorClass = colorClasses[index % colorClasses.length] || "";
      return `<div class="mini-meter-row drawer-meter-row">
        <span title="${name}">${name}</span>
        <div class="mini-meter ${colorClass}"><i style="width:${pct}%; transition: width 0.3s ease;"></i></div>
        <span class="meter-value" title="${formatTokenRaw(item.totalTokens)}${cost ? ` · ${escapeHtml(costTitle(item))}` : ""}">
          <strong>${formatToken(item.totalTokens)}</strong>
          ${cost ? renderCostAmount(item) : ""}
        </span>
      </div>`;
    })
    .join("")}</div>`;
}

function renderWorkdirCards(items) {
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  const colorClasses = ["", "meter-yellow", "meter-violet"];
  return items.map((item, index) => {
    const pct = Math.round(item.contributionRatio * 100);
    const badgeClass = pct > 50 ? "badge dark" : pct > 20 ? "badge" : "badge";
    const badgeText = pct > 50 ? t("desktop.workdirs.tierMain") : pct > 20 ? t("desktop.workdirs.tierMid") : t("desktop.workdirs.tierSmall");
    const costText = latestConfig?.showEstimatedCost && item.estimatedCostUsd !== undefined ? ` · ${renderCostAmount(item)}` : "";
    const todayTokens = item.todayTokens || 0;
    const colorClass = colorClasses[index % colorClasses.length] || "";
    return `<article class="workdir-card" data-open-workdir="${escapeHtml(item.workdirHash)}" role="button" tabindex="0">
    <span class="workdir-rank">#${index + 1}</span>
    <div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;">
        <strong>${escapeHtml(item.name)}</strong>
        <span class="workdir-today">+${formatToken(todayTokens)} ${t("desktop.range.today").toLowerCase()}</span>
      </div>
      <span class="workdir-meta muted">${formatToken(item.totalTokens)} ${t("unit.tokens")}${costText} · ${pct}%</span>
      <div class="workdir-progress ${colorClass}"><i style="width:${Math.max(3, (item.totalTokens / max) * 100)}%; transition: width 0.3s ease;"></i></div>
    </div>
    <span class="${badgeClass}" style="align-self:flex-start;margin-top:4px;">${badgeText}</span>
  </article>`;
  }).join("");
}

function renderCompositionTiles(item) {
  return visibleCompositionEntries(item)
    .map((entry) => `<article class="summary-tile composition-tile">
      <span>${escapeHtml(entry.label)}</span>
      <strong title="${formatTokenRaw(entry.tokens)}">${formatToken(entry.tokens)}</strong>
      <small>${Math.round(entry.ratio * 100)}%${latestConfig?.showEstimatedCost ? ` · ${renderCostAmountValue(costValueForField(item, entry.field))}` : ""}</small>
    </article>`)
    .join("");
}

function visibleCompositionFields(composition) {
  return [
    ["input", composition.inputTokens, "inputTokens"],
    ["output", composition.outputTokens, "outputTokens"],
    ["cache", cacheTokens(composition), "cacheTokens"]
  ];
}

function visibleCompositionEntries(item) {
  const total = Number(item.totalTokens || 0);
  return visibleCompositionFields(item).map(([key, tokens, field]) => ({
    key,
    field,
    label: key === "cache" ? t("common.cache") : t(key === "input" ? "common.input" : "common.output"),
    tokens: Number(tokens || 0),
    ratio: total > 0 ? Number(tokens || 0) / total : 0
  }));
}

function renderTrendSelection(row) {
  if (!row) return "";
  return `<section class="section-block">
    ${renderTrendDetailHero(row)}
    <div class="detail-summary composition-grid">
      ${renderCompositionTiles(row)}
    </div>
    <div class="detail-meter-sections">
      <section class="visual-card drawer-meter-card">
        <h3>${t("desktop.renderer.topModels")}</h3>
        ${renderDetailMeters(row.modelBreakdown)}
      </section>
      <section class="visual-card drawer-meter-card">
        <h3>${t("desktop.renderer.topWorkdirs")}</h3>
        ${renderDetailMeters(row.workdirBreakdown)}
      </section>
    </div>
    ${renderTrendDetailBreakdown(row)}
    ${renderTrendModelDetails(row)}
  </section>`;
}

function renderTrendDetailBreakdown(row) {
  const details = (row.detailBreakdown || []).filter(hasPositiveUsage);
  if (!details.length) return "";
  const max = Math.max(...details.map((item) => item.totalTokens), 1);
  return `<section class="visual-card drawer-meter-card">
    <h3>${escapeHtml(row.detailBreakdownTitle || "")}</h3>
    <div class="hour-detail-grid">
      ${details.map((item) => {
        const pct = Math.max(3, (item.totalTokens / max) * 100);
        return `<article class="hour-detail-row">
          <span>${escapeHtml(formatDetailBreakdownPeriod(item))}</span>
          <i style="--bar:${pct}%"></i>
          <strong title="${formatTokenRaw(item.totalTokens)}">${formatToken(item.totalTokens)}</strong>
        </article>`;
      }).join("")}
    </div>
  </section>`;
}

function formatDetailBreakdownPeriod(row) {
  if (row.hour !== undefined) return row.bucketLabel || formatHourLabel(row.hour);
  return formatTrendPeriod(row);
}

function renderTrendDetailHero(row) {
  const cost = latestConfig?.showEstimatedCost ? renderCost(row).replace(/<[^>]+>/g, "") : "";
  return `<article class="drawer-score-card"${latestConfig?.showEstimatedCost ? ` title="${escapeHtml(costTitle(row))}"` : ""}>
    <span class="metric-label">${escapeHtml(t("desktop.overview.totalTokens"))}</span>
    <strong title="${formatTokenRaw(row.totalTokens)}">${formatToken(row.totalTokens)}</strong>
    ${cost ? `<small>${renderCostAmount(row)} <span class="cost-note">${escapeHtml(t("common.estimated").toLowerCase())}</span></small>` : ""}
  </article>`;
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
  hydrateVirtualModelDetailTables($("#trend-drawer-body"));
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

function openDetailDrawer({ eyebrow, title, body }) {
  if (trendDrawerCloseTimer) clearTimeout(trendDrawerCloseTimer);
  $("#trend-drawer").hidden = false;
  $("#trend-drawer-backdrop").hidden = false;
  $("#trend-drawer-title").textContent = title;
  const copyEl = $("#trend-drawer-copy");
  if (copyEl) copyEl.textContent = eyebrow || "";
  $("#trend-drawer-body").innerHTML = body;
  hydrateVirtualModelDetailTables($("#trend-drawer-body"));
  requestAnimationFrame(() => {
    $("#trend-drawer").classList.add("is-open");
    $("#trend-drawer-backdrop").classList.add("is-open");
  });
}

function openTrendBreakdownDrawer(periodKey) {
  const [start, end, hourValue] = periodKey.split("|");
  const hour = hourValue === undefined ? null : clampHour(Number(hourValue));
  const allItems = usageForRange(overviewRange).filter((item) => (
    item.day >= start &&
    item.day <= end &&
    (hour === null || clampHour(item.hour) === hour)
  ));
  if (!allItems.length) return;

  const row = aggregatePeriodRow(allItems, start, end, hour, overviewTrendGrain());
  openDetailDrawer({
    eyebrow: t("desktop.trend.detailEyebrow"),
    title: formatTrendPeriod(row),
    body: renderTrendSelection({ ...row, modelDetails: [] })
  });
}

function aggregatePeriodRow(items, periodStart, periodEnd, hour = null, parentGrain = "day") {
  const row = {
    periodStart,
    periodEnd,
    ...(hour === null ? {} : { hour, bucketLabel: formatHourLabel(hour) }),
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    costQuality: "",
    pricingVersion: "",
    modelBreakdownMap: {},
    workdirBreakdownMap: {}
  };
  for (const item of items) {
    const withCost = addDisplayCostToUsageItem(item);
    row.inputTokens += item.inputTokens || 0;
    row.outputTokens += item.outputTokens || 0;
    row.reasoningTokens += item.reasoningTokens || 0;
    row.cacheReadTokens += item.cacheReadTokens || 0;
    row.cacheWriteTokens += item.cacheWriteTokens || 0;
    row.totalTokens += item.totalTokens || 0;
    aggregateCost(row, withCost);
    addCostBreakdownItem(row.modelBreakdownMap, item.model || "unknown", item, withCost);
    addCostBreakdownItem(row.workdirBreakdownMap, item.workdirDisplayName || "unknown", item, withCost);
  }
  return {
    ...row,
    compositionSummary: tokenCompositionSummary(row),
    missingPriceModels: sortedBreakdown(row.missingPriceModels || {}),
    modelBreakdown: finalizeCostBreakdown(row.modelBreakdownMap || {}),
    workdirBreakdown: finalizeCostBreakdown(row.workdirBreakdownMap || {}),
    detailBreakdown: groupOverviewDetailBreakdown(items, parentGrain, hour),
    detailBreakdownTitle: detailBreakdownTitleForParentGrain(parentGrain)
  };
}

function groupOverviewDetailBreakdown(items, parentGrain, hour = null) {
  if (hour !== null || parentGrain === "hour") return [];
  if (parentGrain === "day") return groupByHour(items);
  if (parentGrain === "week") return groupByGrain(items, "day").filter(hasPositiveUsage);
  if (parentGrain === "month") return groupByGrain(items, "week").filter(hasPositiveUsage);
  if (parentGrain === "year") return groupByGrain(items, "month").filter(hasPositiveUsage);
  return [];
}

function detailBreakdownTitleForParentGrain(parentGrain) {
  if (parentGrain === "day") return t("desktop.trend.hourlyDetail");
  if (parentGrain === "week") return t("desktop.trend.dailyDetail");
  if (parentGrain === "month") return t("desktop.trend.weeklyDetail");
  if (parentGrain === "year") return t("desktop.trend.monthlyDetail");
  return "";
}

function openWorkdirDrawer(workdirHash) {
  const row = groupWorkdirDetails(usageForRange(workdirsRange)).find((item) => item.workdirHash === workdirHash);
  if (!row) return;
  const aliasValue = latestConfig?.workdirAliases?.[row.workdirHash] || "";
  const dailyRows = Object.entries(row.dailyMap || {})
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, totalTokens]) => ({ periodStart: day, periodEnd: day, totalTokens }));
  openDetailDrawer({
    eyebrow: `${t("desktop.nav.workdirs")} · ${formatWorkdirRange(dailyRows)}`,
    title: row.name,
    body: `<div class="drawer-copy">
      ${renderTrendDetailHero(row)}
      <div class="alias-row drawer-alias-row">
        <small>${t("desktop.workdir.publicNames")}</small>
        <input data-alias-input="${escapeHtml(row.workdirHash)}" data-current-alias="${escapeHtml(aliasValue)}" value="${escapeHtml(aliasValue)}" placeholder="${escapeHtml(t("desktop.workdir.aliasPlaceholder"))}" />
      </div>
      <div class="detail-summary composition-grid">${renderCompositionTiles(row)}</div>
      <div class="detail-meter-sections">
        <section class="visual-card drawer-meter-card">
          <h3>${t("desktop.renderer.topModels")}</h3>
          ${renderDetailMeters(row.modelBreakdown)}
        </section>
        <section class="visual-card drawer-meter-card">
          <h3>${t("desktop.overview.trend")}</h3>
          ${renderDetailMeters(row.dailyBreakdown)}
        </section>
      </div>
    </div>`
  });
}

async function saveAliasInput(input) {
  const workdirHash = input.dataset.aliasInput;
  const alias = input.value.trim();
  if (!workdirHash || alias === (input.dataset.currentAlias || "")) return;
  latestConfig = await api.setWorkdirAlias(workdirHash, alias);
  input.dataset.currentAlias = alias;
  await loadToday(true);
}

function formatWorkdirRange(rows = []) {
  if (!rows.length) return rangeLabel(workdirsRange);
  const first = rows[0];
  const last = rows.at(-1);
  const period = formatTrendPeriod({ periodStart: first.periodStart, periodEnd: last.periodEnd });
  return `${rangeLabel(workdirsRange)} · ${period}`;
}

function animateTrendDrawerClosed() {
  $("#trend-drawer").classList.remove("is-open");
  $("#trend-drawer-backdrop").classList.remove("is-open");
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
  const tableId = `model-detail-${nextVirtualModelDetailId++}`;
  const virtual = details.length > MODEL_DETAIL_VIRTUAL_THRESHOLD;
  if (virtual) virtualModelDetailTables.set(tableId, details);
  const wrapAttrs = virtual
    ? ` class="table-wrap model-detail-virtual-wrap" data-model-detail-scroll="${tableId}"`
    : ` class="table-wrap"`;
  return `<section class="trend-model-details">
    <div class="section-title">
      <h3>${t("desktop.renderer.modelDetail")}</h3>
      <p>${t("desktop.renderer.groupedBy")}</p>
    </div>
    <div${wrapAttrs}>
      <table class="trend-table model-detail-table">
        <thead>
          <tr>
            <th>${t("desktop.renderer.workdir")}</th>
            <th>${t("desktop.renderer.model")}</th>
            <th>${t("unit.tokens")}</th>
            <th>${t("common.input")}</th>
            <th>${t("common.output")}</th>
            <th>${t("common.cache")}</th>
            ${latestConfig?.showEstimatedCost ? `<th>${t("desktop.today.estCost")}</th>` : ""}
          </tr>
        </thead>
        <tbody data-model-detail-rows="${tableId}">
          ${virtual ? renderVirtualModelDetailRows(details, 0) : renderModelDetailRows(details)}
        </tbody>
      </table>
    </div>
  </section>`;
}

function renderModelDetailRows(details, start = 0, end = details.length) {
  return details.slice(start, end).map((item) => `<tr>
    <td>${escapeHtml(item.workdirDisplayName)}</td>
    <td>${escapeHtml(item.model)}</td>
    <td class="numeric" title="${formatTokenRaw(item.totalTokens)}">${formatToken(item.totalTokens)}</td>
    <td class="numeric" title="${formatTokenRaw(item.inputTokens)}">${renderAccountingToken(item.inputTokens, item.inputCostUsd)}</td>
    <td class="numeric" title="${formatTokenRaw(item.outputTokens)}">${renderAccountingToken(item.outputTokens, item.outputCostUsd)}</td>
    <td class="numeric" title="${formatTokenRaw(cacheTokens(item))}">${renderAccountingToken(cacheTokens(item), sumKnownCosts(item.cacheReadCostUsd, item.cacheWriteCostUsd))}</td>
    ${latestConfig?.showEstimatedCost ? `<td class="numeric" title="${escapeHtml(costTitle(item))}">${renderCostAmount(item)}</td>` : ""}
  </tr>`).join("");
}

function renderVirtualModelDetailRows(details, scrollTop = 0, viewportHeight = 420) {
  const visibleCount = Math.ceil(viewportHeight / MODEL_DETAIL_ROW_HEIGHT) + MODEL_DETAIL_OVERSCAN * 2;
  const start = Math.max(0, Math.floor(scrollTop / MODEL_DETAIL_ROW_HEIGHT) - MODEL_DETAIL_OVERSCAN);
  const end = Math.min(details.length, start + visibleCount);
  const topHeight = start * MODEL_DETAIL_ROW_HEIGHT;
  const bottomHeight = Math.max(0, (details.length - end) * MODEL_DETAIL_ROW_HEIGHT);
  const colSpan = latestConfig?.showEstimatedCost ? 7 : 6;
  return `
    ${topHeight ? `<tr class="model-detail-spacer" style="height:${topHeight}px"><td colspan="${colSpan}"></td></tr>` : ""}
    ${renderModelDetailRows(details, start, end)}
    ${bottomHeight ? `<tr class="model-detail-spacer" style="height:${bottomHeight}px"><td colspan="${colSpan}"></td></tr>` : ""}
  `;
}

function hydrateVirtualModelDetailTables(root = document) {
  root.querySelectorAll("[data-model-detail-scroll]").forEach((wrap) => {
    const tableId = wrap.dataset.modelDetailScroll;
    const details = virtualModelDetailTables.get(tableId);
    const body = wrap.querySelector(`[data-model-detail-rows="${CSS.escape(tableId)}"]`);
    if (!details || !body) return;
    const render = () => {
      body.innerHTML = renderVirtualModelDetailRows(details, wrap.scrollTop, wrap.clientHeight || 420);
    };
    render();
    if (wrap.dataset.virtualBound === "true") return;
    wrap.dataset.virtualBound = "true";
    wrap.addEventListener("scroll", () => {
      if (wrap.dataset.virtualFrame === "true") return;
      wrap.dataset.virtualFrame = "true";
      requestAnimationFrame(() => {
        wrap.dataset.virtualFrame = "false";
        render();
      });
    }, { passive: true });
  });
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

const trendBucketKey = _trendBucketKey;
const costValueForField = _costValueForField;
const cacheTokens = _cacheTokens;
const sumKnownCosts = _sumKnownCosts;

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

function renderAccountingToken(tokens, cost) {
  const costLine = latestConfig?.showEstimatedCost ? `<small>${renderCostAmountValue(cost)}</small>` : "";
  return `<span class="token-accounting">${formatToken(tokens || 0)}${costLine}</span>`;
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
      ${renderTrendMetric(t("desktop.renderer.latestLabel"), formatToken(latest.totalTokens), formatTrendPeriod(latest), metricTitle(latest))}
      ${renderTrendMetric(t("desktop.renderer.peak"), formatToken(peak.totalTokens), formatTrendPeriod(peak), metricTitle(peak))}
      ${renderTrendMetric(t("desktop.renderer.viewTotal"), formatToken(total), `${rows.length} ${trendViewMeta().bucketLabel}${rows.length === 1 ? "" : "s"}`, formatTokenRaw(total))}
      ${latestConfig?.showEstimatedCost ? renderTrendMetric(t("desktop.renderer.cost"), renderCostAmount(cost), pricingSource, costTitle(cost)) : renderTrendMetric(t("desktop.renderer.dominant"), humanDominant(dominantComposition(latest)), tokenCompositionSummary(latest), metricTitle(latest))}
    </div>
    ${renderTrendTimeline(chronological, latest, peak)}
    <section class="recent-contribution">
      <h3>${t("desktop.renderer.recentContribution")}</h3>
      <div class="recent-list">
        ${recent
          .map((row) => `<article>
            <header>
              <strong>${formatTrendPeriod(row)}</strong>
              <span title="${escapeHtml(metricTitle(row))}">${formatToken(row.totalTokens)}</span>
            </header>
            <p title="${escapeHtml(summaryTitle(row.modelBreakdown))}">${escapeHtml(summaryLabel(row.modelBreakdown))}</p>
            <p title="${escapeHtml(summaryTitle(row.workdirBreakdown))}">${escapeHtml(summaryLabel(row.workdirBreakdown))}</p>
            ${latestConfig?.showEstimatedCost ? `<em title="${escapeHtml(costTitle(row))}">${renderCostAmount(row)}</em>` : ""}
          </article>`)
          .join("")}
      </div>
    </section>
  </div>`;
}

const aggregateTrendRowCost = _aggregateTrendRowCost;
const mergeCostQualityForDisplay = _mergeCostQualityForDisplay;

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
          return `<button type="button" data-select-trend="${escapeHtml(trendBucketKey(row))}" class="${row === latest ? "latest" : ""} ${row === peak ? "peak" : ""} ${selectedTrendBucketKey === trendBucketKey(row) ? "selected" : ""}" style="height:${Math.max(4, (row.totalTokens / max) * 100)}%" data-tooltip="${title}"></button>`;
        })
      .join("")}
  </div>
  <div class="timeline-axis">
    <span>${formatTrendPeriod(rows[0])}</span>
    <strong>${t("desktop.renderer.peak")} ${formatTrendPeriod(peak)}</strong>
    <span>${formatTrendPeriod(rows.at(-1))}</span>
  </div>`;
}

function sourceName(providerId) {
  if (providerId === "codex_local") return t("source.codex");
  if (providerId === "claude_code_local") return t("source.claude");
  if (providerId === "cursor_dashboard_usage") return t("source.cursor");
  return providerId;
}

async function run(fn) {
  try {
    await fn();
  } catch (error) {
    setStatusMessage(t("desktop.renderer.actionFailed"));
    setSaveMessage(error.message, "error");
    logRuntimeEvent("action_failed", {
      message: error.message || String(error),
      stack: error.stack || ""
    }, "error");
    console.error(error);
  }
}

function setTextIfPresent(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.textContent = value;
}

function setSaveMessage(message, tone = "") {
  const target = $("#settings-save-message");
  if (target) {
    target.textContent = message || "";
    target.dataset.tone = tone;
    target.title = message || "";
  }
  if (message && tone === "ok") showToast(message);
  if (message && tone === "error") showToast(message);
}

const normalizeApiBaseUrl = _normalizeApiBaseUrl;
const formatNumber = _formatNumber;
const normalizeMissingPriceModels = _normalizeMissingPriceModels;
const renderCost = _renderCost;
const renderCostAmount = _renderCostAmount;
const renderCostAmountValue = _renderCostAmountValue;
const renderCostValue = _renderCostValue;

function costTitle(item) {
  return _costTitle(item, { pricingSource, t });
}

function aggregateUsageCost(items) {
  const current = {
    estimatedCostUsd: 0,
    costQuality: "",
    pricingVersion: "",
    missingPriceTokens: 0,
    missingPriceModels: {}
  };
  for (const item of items) aggregateCost(current, addDisplayCostToUsageItem(item));
  return { ...current, missingPriceModels: sortedBreakdown(current.missingPriceModels || {}) };
}

function activePriceMap() {
  return serverPriceMap || createPriceMap();
}

function addDisplayCostToUsageItem(item) {
  const priceMap = activePriceMap();
  if (Object.keys(priceMap || {}).length) return addCostToUsageItem(item, priceMap);
  if (item.estimatedCostUsd !== null && item.estimatedCostUsd !== undefined) {
    return {
      ...item,
      hasKnownPrice: true,
      costQuality: item.costQuality || "estimated_price",
      pricingVersion: item.pricingVersion || "",
      missingPriceTokens: item.missingPriceTokens || 0
    };
  }
  return addCostToUsageItem(item, priceMap);
}

function schedulePricingRefresh() {
  if (pricingRefreshPromise) return pricingRefreshPromise;
  pricingRefreshPromise = refreshPricing({ renderOnComplete: true })
    .catch((error) => console.error(error))
    .finally(() => {
      pricingRefreshPromise = null;
    });
  return pricingRefreshPromise;
}

async function refreshPricing({ renderOnComplete = false } = {}) {
  if (!latestConfig?.apiBaseUrl) {
    serverPriceMap = null;
    pricingSource = t("desktop.renderer.serverPricingUnavailable");
    await syncTrayCostState();
    if (renderOnComplete) renderInstantPreferenceViews();
    return;
  }
  try {
    const data = await api.modelPrices();
    serverPriceMap = createPriceMap(
      Object.fromEntries((data?.custom || []).map((item) => [item.model, item])),
      Object.fromEntries((data?.openrouter || []).map((item) => [item.model, item])),
      Object.fromEntries((data?.aliases || []).map((item) => [item.model, item.targetModel]))
    );
    pricingSource = data?.remote?.status ? t("desktop.renderer.serverPricingDetail", { status: data.remote.status }) : t("desktop.renderer.serverPricing");
  } catch (error) {
    serverPriceMap = null;
    pricingSource = t("desktop.renderer.serverPricingError", { error: error.message });
  } finally {
    await syncTrayCostState();
    if (renderOnComplete) renderInstantPreferenceViews();
  }
}

async function syncTrayCostState() {
  if (!api.updateTrayCost) return;
  const cost = aggregateUsageCost(usageForRange("today"));
  const estimatedCostUsd = latestConfig?.showEstimatedCost && cost.hasKnownPrice
    ? Number(cost.estimatedCostUsd || 0)
    : null;
  const key = JSON.stringify({
    estimatedCostUsd,
    missingPriceTokens: cost.missingPriceTokens || 0,
    rows: usageForRange("today").length
  });
  if (key === latestTrayCostKey) return;
  latestTrayCostKey = key;
  try {
    await api.updateTrayCost({ estimatedCostUsd });
    await api.rebuildTrayMenu?.();
  } catch (error) {
    latestTrayCostKey = "";
    console.error(error);
  }
}

const sortedBreakdown = _sortedBreakdown;

function addCostBreakdownItem(map, name, item, withCost = addDisplayCostToUsageItem(item)) {
  return _addCostBreakdownItem(map, name, item, withCost);
}

const finalizeCostBreakdown = _finalizeCostBreakdown;
const formatTime = _formatTime;
const formatDateTime = _formatDateTime;
const formatBytes = _formatBytes;
const formatDate = _formatDate;
const formatTrendPeriod = _formatTrendPeriod;
const clampHour = _clampHour;
const formatHourLabel = _formatHourLabel;
const trailingDays = _trailingDays;
const daysForLastWeeks = _daysForLastWeeks;
const daysForLastMonths = _daysForLastMonths;

function formatToken(value) {
  return latestConfig?.showRawTokens ? _formatNumber(value) : localeTokenCompact(value);
}

function metricTitle(row) {
  const cost = latestConfig?.showEstimatedCost ? ` · ${t("common.cost")} ${renderCost(row)}` : "";
  return `${formatTrendPeriod(row)} · ${formatToken(row.totalTokens)}${cost}`;
}

function trendViewMeta() {
  if (trendView === "weekly") {
    return { grain: "week", heading: t("desktop.trend.weeklyReview"), bucketLabel: t("desktop.renderer.weekBucket"), summary: t("desktop.renderer.last12Weeks") };
  }
  if (trendView === "monthly") {
    return { grain: "month", heading: t("desktop.trend.monthlyReview"), bucketLabel: t("desktop.renderer.monthBucket"), summary: t("desktop.renderer.last12Months") };
  }
  return { grain: "day", heading: t("desktop.trend.dailyReview"), bucketLabel: t("desktop.renderer.dayBucket"), summary: t("desktop.renderer.last30Days") };
}

function daysForTrendView(view) {
  if (view === "weekly") return daysForLastWeeks(12);
  if (view === "monthly") return daysForLastMonths(12);
  return trailingDays(30);
}

function renderCompactBreakdown(items = []) {
  if (!items.length) return "-";
  return items
    .slice(0, 3)
    .map((item) => `<div title="${formatTokenRaw(item.totalTokens)}">${escapeHtml(item.name)} ${formatToken(item.totalTokens)}</div>`)
    .join("");
}

const summaryLabel = _summaryLabel;
const summaryTitle = _summaryTitle;
const bucketForDay = _bucketForDay;
const startOfUtcWeek = _startOfUtcWeek;

function utcToday() {
  return dayToUtcDate(localDay());
}

function toDay(date) {
  return utcDateToDay(date);
}

const escapeHtml = _escapeHtml;
const cssEscape = _cssEscape;

// 初始化语言切换器
const langContainer = document.querySelector("#lang-switcher-container");
if (langContainer) {
  langContainer.innerHTML = createLangSwitcher();
  bindLangSwitcher("lang-switcher", async (newLang) => {
    // 保存语言到 config.json
    await api.updateConfig({ language: newLang });
    // 语言切换后重新加载页面以应用新语言
    window.location.reload();
  });
}

// 应用当前语言翻译
updatePageTranslations();

boot().catch((error) => {
  setStatusMessage(error.message);
});
