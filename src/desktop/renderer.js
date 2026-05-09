import { costQualityLabel, dominantComposition, tokenCompositionDetails, tokenCompositionSummary } from "../shared/composition.js";
import { addCostToUsageItem, aggregateCost, createPriceMap } from "../shared/pricing.js";
import { formatTokenCompact, formatTokenRaw, formatUsd } from "../shared/display.js";
import { dayToUtcDate, localDay, utcDateToDay } from "../shared/date.js";
import { initI18n, setLang, t, getCurrentLang, createLangSwitcher, bindLangSwitcher, updatePageTranslations } from "../shared/i18n.js";

// 初始化多语言
const currentLang = initI18n();

function localeTokenCompact(value) {
  return formatTokenCompact(value, getCurrentLang());
}

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
let latestUpdateState = null;

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
  await loadHealth();
}));
document.querySelectorAll("[data-sync-now]").forEach((button) => button.addEventListener("click", () => run(syncNow)));
$("#wizard-skip").addEventListener("click", (e) => { e.preventDefault(); run(skipWizard); });
$("#wizard-next-0").addEventListener("click", () => wizardGo(1));
$("#wizard-back-1").addEventListener("click", () => wizardGo(0));
$("#wizard-import").addEventListener("click", () => run(wizardImportProfile));
$("#wizard-next-1").addEventListener("click", () => wizardGo(2));
$("#wizard-back-2").addEventListener("click", () => wizardGo(1));
$("#wizard-next-2").addEventListener("click", () => wizardGo(3));
$("#wizard-back-3").addEventListener("click", () => wizardGo(2));
$("#wizard-skip-cloud").addEventListener("click", () => { $("#wizard-api-base-url").value = ""; wizardGo(4); });
$("#wizard-next-3").addEventListener("click", () => wizardGo(4));
$("#wizard-back-4").addEventListener("click", () => wizardGo(3));
$("#wizard-start").addEventListener("click", () => run(finishWizard));
$("#add-codex-root").addEventListener("click", () => run(() => addProviderRoot("codex_local")));
$("#add-claude-root").addEventListener("click", () => run(() => addProviderRoot("claude_code_local")));
$("#add-cursor-token").addEventListener("click", openCursorTokenModal);
$("#save-cursor-token").addEventListener("click", () => run(addCursorToken));
$("#cursor-token-modal").addEventListener("click", (event) => {
  if (event.target.id === "cursor-token-modal" || event.target.closest("#cancel-cursor-token")) closeCursorTokenModal();
});
$("#reset-confirm-modal").addEventListener("click", (event) => {
  if (event.target.id === "reset-confirm-modal" || event.target.closest("#reset-cancel")) closeResetConfirmModal();
});
$("#reset-local-only").addEventListener("click", () => run(resetLocalOnly));
$("#reset-with-cloud").addEventListener("click", () => run(resetWithCloud));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#cursor-token-modal").hidden) closeCursorTokenModal();
  if (event.key === "Escape" && !$("#reset-confirm-modal").hidden) closeResetConfirmModal();
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
  if (button.dataset.settingsTab === "cloud") run(async () => {
    await loadCloudStatus();
    await loadBackgroundStatus();
  });
  if (button.dataset.settingsTab === "about") run(loadSystemStatus);
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
const DIRTY_TRACKED_FIELDS = ["nickname", "apiBaseUrl", "launchAtLogin", "autoRefreshEnabled", "refreshIntervalMinutes", "silentUpdateMode"];

function readDomValue(field) {
  if (field === "silentUpdateMode") return document.querySelector("input[name='silentUpdateMode']:checked")?.value || "notify";
  const el = document.getElementById(field);
  if (!el) return undefined;
  if (el.type === "checkbox") return el.checked;
  return el.value.trim ? el.value.trim() : el.value;
}

function readConfigValue(field) {
  if (field === "silentUpdateMode") return latestConfig?.silentUpdateMode || "notify";
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
  renderTrend();
  renderAliases();
}

for (const field of DIRTY_TRACKED_FIELDS) {
  const el = field === "silentUpdateMode"
    ? document.querySelector("input[name='silentUpdateMode']")
    : document.getElementById(field);
  if (!el) continue;
  const eventType = el.type === "checkbox" || el.type === "radio" ? "change" : "input";
  // radio group needs all radios
  if (field === "silentUpdateMode") {
    document.querySelectorAll("input[name='silentUpdateMode']").forEach((radio) => {
      radio.addEventListener("change", updateDirtyState);
    });
  } else {
    el.addEventListener(eventType, updateDirtyState);
  }
}

$("#reset-local-data").addEventListener("click", openResetConfirmModal);
$("#check-update").addEventListener("click", () => run(checkUpdate));
$("#download-update").addEventListener("click", () => run(downloadUpdate));
$("#download-installer").addEventListener("click", () => run(downloadInstaller));
$("#export-diagnostics").addEventListener("click", () => run(exportDiagnostics));

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-remove-root]");
  if (!btn) return;
  const rootPath = btn.dataset.removeRoot;
  const providerId = btn.dataset.providerId;
  if (!rootPath || !providerId) return;
  if (!confirm(t("desktop.sources.removeConfirm"))) return;
  try {
    latestConfig = await api.removeProviderRoot(providerId, rootPath);
    renderConfig(latestConfig);
    setSaveMessage(t("desktop.sources.sourceRemoved"), "ok");
    await loadHealth();
  } catch (err) {
    setSaveMessage(err.message || "Failed to remove", "error");
  }
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-remove-cursor-token]");
  if (!btn) return;
  const tokenValue = btn.dataset.removeCursorToken;
  if (!tokenValue) return;
  if (!confirm(t("desktop.sources.removeConfirm"))) return;
  try {
    latestConfig = await api.removeCursorToken(tokenValue);
    renderConfig(latestConfig);
    setSaveMessage(t("desktop.sources.sourceRemoved"), "ok");
    await loadHealth();
    await loadToday(true);
  } catch (err) {
    setSaveMessage(err.message || "Failed to remove", "error");
  }
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-ignore-source]");
  if (!btn) return;
  const sourceId = btn.dataset.ignoreSource;
  const providerId = btn.dataset.providerId;
  if (!sourceId || !providerId) return;
  if (!confirm(t("desktop.sources.ignoreConfirm"))) return;
  try {
    latestConfig = await api.ignoreAutoSource(providerId, sourceId);
    renderConfig(latestConfig);
    setSaveMessage(t("desktop.sources.sourceIgnored"), "ok");
    await loadHealth();
  } catch (err) {
    setSaveMessage(err.message || "Failed to ignore", "error");
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
    setSaveMessage(err.message || "Failed to restore", "error");
  }
});

function selectSection(section) {
  document.querySelectorAll("nav button").forEach((item) => item.classList.toggle("active", item.dataset.section === section));
  document.querySelectorAll(".panel").forEach((item) => item.classList.toggle("active", item.id === section));
  $(".workspace")?.scrollTo({ top: 0, behavior: "auto" });
}

function selectSettingsTab(tab) {
  $("#settings-tabs").querySelectorAll("button").forEach((item) => item.classList.toggle("active", item.dataset.settingsTab === tab));
  document.querySelectorAll("[data-settings-panel]").forEach((item) => item.classList.toggle("active", item.dataset.settingsPanel === tab));
}

async function saveSettings() {
  const payload = settingsPayload();
  const dirtyBeforeSave = getDirtyFields();
  const nextCycleDirty = dirtyBeforeSave.some((f) => f === "autoRefreshEnabled" || f === "refreshIntervalMinutes" || f === "silentUpdateMode");
  setSaveMessage(payload.apiBaseUrl ? t("desktop.renderer.checkingApi") : t("desktop.renderer.savingSettings"), "");
  const existing = await api.getConfig();
  const config = existing ? await api.updateConfig(payload) : await api.initConfig(payload);
  renderConfig(config);
  updateDirtyState();
  if (nextCycleDirty) {
    setSaveMessage(t("desktop.sync.settingsSavedNextCycle"), "ok");
  } else {
    setSaveMessage(t("desktop.sync.settingsSaved"), "ok");
  }
  $("#sync-state").textContent = t("desktop.sync.settingsSaved");
  await loadBackgroundStatus();
  return config;
}

function settingsPayload() {
  return {
    nickname: $("#nickname").value || "anonymous",
    apiBaseUrl: $("#apiBaseUrl").value.trim(),
    autoRefreshEnabled: $("#autoRefreshEnabled").checked,
    silentUpdateMode: document.querySelector("input[name='silentUpdateMode']:checked")?.value || "notify",
    refreshIntervalMinutes: $("#refreshIntervalMinutes").value || 15,
    launchAtLogin: $("#launchAtLogin").checked,
    desktopAutoInitialized: false,
    providerEnabled: latestConfig?.providerEnabled || {}
  };
}

$("#export").addEventListener("click", async () => run(async () => {
  const result = await api.exportConfig();
  $("#sync-state").textContent = result.canceled ? t("desktop.renderer.exportCanceled") : t("desktop.renderer.configExported");
}));

$("#import").addEventListener("click", async () => run(async () => {
  await importProfile();
}));

async function importProfile() {
  const config = await api.importConfig();
  if (!config?.canceled) {
    renderConfig(config);
    await loadToday(true);
    await loadBackgroundStatus();
  }
}

let wizardStep = 0;
let wizardDetectedSources = [];

function wizardGo(step) {
  wizardStep = step;
  document.querySelectorAll(".wizard-step").forEach((el) => el.classList.toggle("active", Number(el.dataset.wizardStep) === step));
  document.querySelectorAll(".wizard-step-dot").forEach((el) => {
    const dotStep = Number(el.dataset.wizardStepDot);
    el.classList.toggle("active", dotStep === step);
    el.classList.toggle("done", dotStep < step);
  });
  if (step === 2) renderWizardSources();
  if (step === 4) renderWizardSummary();
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
    if (latestConfig?.participantId) {
      $("#wizard-participant-id").value = latestConfig.participantId;
    }
    if ((latestConfig?.nickname && latestConfig.nickname !== "anonymous") || latestConfig?.nicknameAutoGenerated === true) {
      $("#wizard-nickname").value = latestConfig.nickname;
    }
    $("#wizard-api-base-url").value = latestConfig?.apiBaseUrl || "";
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
      <div>
        <strong>${sourceName(item.providerId)}</strong>
        <small>${summary}</small>
        <p>${sourceDescription(item.providerId)}</p>
      </div>
      <button class="source-toggle ${enabled ? "ok" : "miss"}" type="button" data-wizard-toggle-source="${escapeHtml(item.providerId)}" aria-pressed="${enabled ? "true" : "false"}">${enabled ? t("status.on") : t("status.off")}</button>
    </article>`;
  }).join("");
  container.querySelectorAll("[data-wizard-toggle-source]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(next));
      button.textContent = next ? t("status.on") : t("status.off");
      button.classList.toggle("ok", next);
      button.classList.toggle("miss", !next);
    });
  });
}

function renderWizardSummary() {
  const nickname = $("#wizard-nickname").value.trim() || "anonymous";
  const apiBaseUrl = $("#wizard-api-base-url").value.trim();
  const enabledSources = [];
  document.querySelectorAll("[data-wizard-toggle-source]").forEach((button) => {
    if (button.getAttribute("aria-pressed") === "true") enabledSources.push(sourceName(button.dataset.wizardToggleSource));
  });
  $("#wizard-summary-nickname").textContent = nickname;
  $("#wizard-summary-sources").textContent = enabledSources.length ? enabledSources.join(", ") : t("desktop.renderer.none");
  $("#wizard-summary-cloud").textContent = apiBaseUrl || t("desktop.renderer.localOnly");
}

async function wizardImportProfile() {
  const config = await api.importConfig();
  if (!config?.canceled) {
    latestConfig = config;
    renderConfig(config);
    renderWizard();
    await loadToday(true);
    await loadBackgroundStatus();
  }
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
  $("#sync-state").textContent = t("desktop.sync.profileReady");
}

async function finishWizard() {
  const nickname = $("#wizard-nickname").value.trim() || "anonymous";
  const apiBaseUrl = $("#wizard-api-base-url").value.trim();
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
  await loadBackgroundStatus();
  $("#sync-state").textContent = t("desktop.sync.profileReady");
}

async function resetLocalData() {
  const ok = window.confirm(t("desktop.renderer.confirmReset"));
  if (!ok) return;
  $("#reset-local-data").disabled = true;
  $("#sync-state").textContent = t("desktop.renderer.resetting");
  await api.resetLocalData();
}

function openResetConfirmModal() {
  $("#reset-confirm-error").textContent = "";
  $("#reset-confirm-modal").hidden = false;
}

function closeResetConfirmModal() {
  $("#reset-confirm-modal").hidden = true;
}

async function resetLocalOnly() {
  closeResetConfirmModal();
  $("#reset-local-data").disabled = true;
  $("#sync-state").textContent = t("desktop.renderer.resetting");
  await api.resetLocalData();
}

async function resetWithCloud() {
  const errorEl = $("#reset-confirm-error");
  errorEl.textContent = "";
  $("#reset-local-data").disabled = true;
  $("#sync-state").textContent = t("desktop.reset.cloudClearing");
  try {
    await api.resetWithCloud();
  } catch (error) {
    $("#reset-local-data").disabled = false;
    $("#sync-state").textContent = "";
    errorEl.textContent = t("desktop.reset.cloudFailed", { error: error.message });
    throw error;
  }
}

async function boot() {
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
    await loadToday();
    await loadBackgroundStatus();
    await loadSystemStatus();
  } else {
    $("#today-summary").textContent = t("desktop.renderer.openSettings");
    document.querySelector('[data-section="settings"]').click();
  }
  api.onUpdateProgress((data) => {
    updateCheckProgress(data);
  });
}

function updateCheckProgress(data) {
  if (data.downloadProgress) {
    const pct = data.downloadProgress.percent;
    const speed = data.downloadProgress.bytesPerSecond > 0
      ? `${Math.round(data.downloadProgress.bytesPerSecond / 1024)} KB/s`
      : "";
    $("#update-message").textContent = speed
      ? `${t("desktop.renderer.downloading")} ${pct}% (${speed})`
      : `${t("desktop.renderer.downloading")} ${pct}%`;
  }
  if (data.status === "downloaded") {
    $("#download-update").disabled = false;
    $("#download-installer").hidden = true;
    $("#download-update").textContent = t("desktop.app.installRestart");
    $("#download-update").onclick = async () => {
      $("#download-update").disabled = true;
      $("#update-message").textContent = t("desktop.renderer.downloadedInstalling");
      await api.installAndRestartUpdate();
    };
    $("#update-message").textContent = t("desktop.renderer.downloadedReady");
  }
  if (data.status === "failed" && data.lastError) {
    $("#update-message").textContent = data.lastError;
    $("#download-update").disabled = false;
    $("#download-installer").hidden = false;
  }
  renderSilentUpdateStatus(data, latestConfig);
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
    ? t("desktop.renderer.scanningLocal")
    : $("#today-summary").textContent;
  $("#today-scan-time").textContent = running ? t("desktop.renderer.refreshingBg") : t("desktop.renderer.lastScan", { time: latestScanAt ? formatDateTime(latestScanAt) : "-" });
  $("#trend-summary").textContent = running
    ? t("desktop.renderer.refreshingBg")
    : $("#trend-summary").textContent;
  renderWizard();
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
      $("#today-summary").textContent = t("desktop.renderer.refreshStatusFailed", { error: error.message });
      $("#trend-summary").textContent = t("desktop.renderer.refreshStatusFailed", { error: error.message });
      console.error(error);
    }
  }, 1000);
}

function applyUsageScanStatus(status, { force = false } = {}) {
  if (status.snapshot) applyUsageSnapshot(status.snapshot);
  setScanState(Boolean(status.running), status.force ?? force);
  if (status.error) {
    $("#today-summary").textContent = t("desktop.renderer.refreshFailed", { error: status.error });
    $("#trend-summary").textContent = t("desktop.renderer.refreshFailed", { error: status.error });
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
  renderCursorTokenSummary(latestConfig?.cursorDashboardUsage);
  renderHealth();
  await loadBackgroundStatus();
}

async function syncNow() {
  if (isApiBaseUrlDirty() && !window.confirm(t("desktop.sync.unsavedApiBaseUrl"))) return;
  const buttons = document.querySelectorAll("[data-sync-now]");
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    if (!confirmSyncUpload()) {
      $("#sync-state").textContent = t("desktop.renderer.syncCanceled");
      return;
    }
    $("#sync-state").textContent = t("desktop.renderer.syncing");
    const result = await api.syncUsage();
    latestConfig = await api.getConfig();
    renderSyncStatus(latestConfig, result);
    await loadToday();
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}

function confirmSyncUpload() {
  const config = latestConfig || {};
  const apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl || config.apiConnection?.apiBaseUrl || "");
  if (!apiBaseUrl) {
    window.alert(t("desktop.renderer.configureCloudFirst"));
    return false;
  }
  const rows = allUsage.length || latestUsage.length || 0;
  const scannedAt = latestScanAt ? formatDateTime(latestScanAt) : "-";
  return window.confirm(t("desktop.renderer.confirmUpload", { url: apiBaseUrl, rows, scannedAt }));
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
  $("#profile-state").textContent = config?.desktopAutoInitialized ? t("desktop.wizard.firstRun") : config ? t("desktop.sync.profileReady") : t("desktop.sync.apiNotConfigured");
  if (config?.nickname) $("#nickname").value = config.nickname;
  $("#apiBaseUrl").value = config?.apiBaseUrl ?? "";
  $("#showEstimatedCost").checked = config?.showEstimatedCost ?? false;
  $("#showRawTokens").checked = config?.showRawTokens ?? false;
  $("#autoRefreshEnabled").checked = config?.autoRefreshEnabled ?? false;
  document.querySelectorAll("input[name='silentUpdateMode']").forEach((item) => {
    item.checked = item.value === (config?.silentUpdateMode || "notify");
  });
  $("#refreshIntervalMinutes").value = config?.refreshIntervalMinutes ?? 15;
  $("#launchAtLogin").checked = config?.launchAtLogin ?? false;
  renderCursorTokenSummary(config?.cursorDashboardUsage);
  renderCloudStatus(config);
  renderSyncStatus(config);
  renderSystemStatus({ client: null, server: config?.apiConnection || null, update: latestUpdateState });
  renderSilentUpdateStatus(null, config);
  renderWizard();
  updateDirtyState();
}

async function loadCloudStatus() {
  latestConfig = await api.getConfig();
  renderCloudStatus(latestConfig);
}

async function loadSystemStatus() {
  const client = await api.appVersion();
  const server = latestConfig?.apiConnection || null;
  renderSystemStatus({ client, server, update: latestUpdateState });
}

async function checkUpdate() {
  if (isApiBaseUrlDirty() && !window.confirm(t("desktop.sync.unsavedApiBaseUrl"))) return;
  $("#check-update").disabled = true;
  $("#download-installer").hidden = true;
  $("#update-message").textContent = t("desktop.renderer.checking");
  try {
    latestUpdateState = await api.checkUpdate();
    renderSystemStatus(latestUpdateState);
    $("#update-message").textContent = updateMessage(latestUpdateState);
    $("#download-update").disabled = !latestUpdateState.update?.updateAvailable;
    $("#download-update").textContent = t("desktop.app.downloadRestart");
    $("#download-update").onclick = downloadUpdate;
    latestConfig = await api.getConfig();
    renderCloudStatus(latestConfig);
  } finally {
    $("#check-update").disabled = false;
  }
}

async function downloadUpdate() {
  $("#download-update").disabled = true;
  $("#update-message").textContent = t("desktop.renderer.downloading");
  try {
    await api.downloadUpdate();
    $("#download-update").textContent = t("desktop.app.installRestart");
    $("#download-update").disabled = false;
    $("#download-update").onclick = async () => {
      $("#download-update").disabled = true;
      $("#update-message").textContent = t("desktop.renderer.downloadedInstalling");
      await api.installAndRestartUpdate();
    };
  } catch (error) {
    $("#update-message").textContent = error.message || t("desktop.renderer.downloadFailed");
    $("#download-update").disabled = false;
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
  try {
    const result = await api.exportDiagnostics();
    if (result.canceled) {
      $("#diagnostics-message").textContent = t("desktop.renderer.diagCanceled");
      return;
    }
    $("#diagnostics-message").dataset.tone = "ok";
    $("#diagnostics-message").textContent = t("desktop.renderer.diagExported", { logs: result.logCount || 0, rows: result.usageRowCount || 0 });
    $("#diagnostics-message").title = result.filePath || "";
  } finally {
    button.disabled = false;
  }
}

function renderSystemStatus(state = {}) {
  const client = state.client || {};
  const server = state.server || {};
  const update = state.update || latestUpdateState?.update || null;
  $("#system-client-version").textContent = client.clientAppVersion
    ? t("desktop.renderer.client", { version: client.clientAppVersion, protocol: client.clientProtocolVersion, platform: client.clientPlatform })
    : t("desktop.renderer.clientDash");
  $("#system-latest-version").textContent = update?.latestVersion || server.latestClientVersion
    ? t("desktop.renderer.latest", { version: update?.latestVersion || server.latestClientVersion })
    : t("desktop.renderer.latestDash");
  $("#system-update-checked").textContent = state.checkedAt ? t("desktop.renderer.lastCheck", { time: formatDateTime(state.checkedAt) }) : t("desktop.renderer.lastCheckDash");
}

function renderCloudStatus(config = latestConfig) {
  const connection = config?.apiConnection || {};
  const apiBaseUrl = normalizeApiBaseUrl(config?.apiBaseUrl || connection.apiBaseUrl || "");
  const compatibility = connection.compatibility || {};
  const release = connection.release || {};
  $("#cloud-target").textContent = apiBaseUrl ? `API ${apiBaseUrl}` : t("desktop.renderer.cloudNotConfigured");
  $("#cloud-target").title = apiBaseUrl || "";
  $("#cloud-health").textContent = connection.status ? t("desktop.renderer.health", { status: connection.status }) : t("desktop.renderer.healthDash");
  $("#cloud-health").title = connection.message || "";
  $("#cloud-server-version").textContent = connection.serverVersion ? t("desktop.renderer.server", { version: connection.serverVersion }) : t("desktop.renderer.serverDash");
  $("#cloud-protocol").textContent = connection.supportedClientProtocol
    ? t("desktop.renderer.protocol", { version: connection.serverProtocolVersion || "-", min: connection.supportedClientProtocol.min, max: connection.supportedClientProtocol.max })
    : t("desktop.renderer.protocolDash");
  $("#cloud-compatibility").textContent = compatibility.status ? t("desktop.renderer.compatibility", { status: compatibility.status }) : t("desktop.renderer.compatibilityDash");
  $("#cloud-latest-version").textContent = connection.latestClientVersion ? t("desktop.renderer.latest", { version: connection.latestClientVersion }) : t("desktop.renderer.latestDash");
  $("#cloud-release-manifest").textContent = release.publicBaseUrl ? t("desktop.renderer.releaseManifest") : t("desktop.renderer.releaseManifestDash");
  $("#cloud-release-manifest").title = release.publicBaseUrl || "";
}

function updateMessage(state = {}) {
  if (state.code === "cloud_not_configured") return t("desktop.renderer.configureCloudUpdate");
  if (state.code === "release_not_configured") return t("desktop.renderer.releaseNotConfigured");
  return state.message || t("desktop.renderer.updateCheckFinished");
}


function renderCursorTokenSummary(cursorConfig = {}) {
  const tokens = cursorConfig?.workosSessionTokens || [];
  const legacy = cursorConfig?.workosSessionToken ? [{ accountName: "legacy token" }] : [];
  const accounts = [...tokens, ...legacy].map((item) => item.accountName || "Cursor").filter(Boolean);
  const summary = accounts.length
    ? `${accounts.length} Cursor token${accounts.length === 1 ? "" : "s"} configured`
    : "No Cursor token configured. Local Cursor state can still be detected automatically.";
  let html = `<p>${escapeHtml(summary)}</p>`;
  if (tokens.length) {
    html += `<ul class="root-list">${tokens.map((item, idx) => {
      const name = escapeHtml(item.accountName || "Cursor");
      return `<li><span class="root-path">${name}</span><button class="source-action-btn delete" type="button" data-remove-cursor-token="${idx}" title="${t("desktop.sources.removeTitle")}">${t("desktop.sources.deleteBtn")}</button></li>`;
    }).join("")}</ul>`;
  }
  $("#cursor-token-summary").innerHTML = html;
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
  const apiCheckedAt = connection.checkedAt ? t("desktop.renderer.apiChecked", { time: formatDateTime(connection.checkedAt) }) : "";
  $("#sync-state").textContent = stateLabel;
  $("#sync-target").textContent = apiBaseUrl ? `API ${apiBaseUrl}` : t("desktop.renderer.apiNotConfigured");
  $("#sync-target").title = apiBaseUrl || "";
  $("#sync-last").textContent = lastFinishedAt ? t("desktop.renderer.lastSync", { time: formatDateTime(lastFinishedAt) }) : apiCheckedAt || t("desktop.renderer.lastSyncDash");
  $("#settings-sync-target").textContent = apiBaseUrl ? `API ${apiBaseUrl}` : t("desktop.renderer.apiNotConfigured");
  $("#settings-sync-target").title = apiBaseUrl || "";
  $("#settings-sync-last").textContent = lastFinishedAt ? t("desktop.renderer.lastSync", { time: formatDateTime(lastFinishedAt) }) : apiCheckedAt || t("desktop.renderer.lastSyncDash");
  $("#settings-sync-result").textContent = stateLabel;
  $("#settings-sync-result").title = error || stateLabel;
}

function syncStateLabel(state, { scanned = 0, accepted = 0, rejected = 0, queuePending = 0, error = "" } = {}) {
  if (state === "success") {
    const rejectedText = rejected ? t("desktop.renderer.rejected", { count: rejected }) : "";
    const queueText = queuePending ? t("desktop.renderer.queued", { count: queuePending }) : "";
    return t("desktop.renderer.syncedRows", { scanned, accepted, rejected: rejectedText, queued: queueText });
  }
  if (state === "queued") {
    if (error.includes("unsupported_client")) return t("desktop.renderer.updateRequiredQueued", { count: queuePending || scanned });
    if (error.includes("unsupported_server")) return t("desktop.renderer.serverIncompatible", { count: queuePending || scanned });
    return t("desktop.renderer.queuedRows", { scanned, pending: queuePending ? t("desktop.renderer.pending", { count: queuePending }) : "" });
  }
  if (state === "failed") {
    return error ? t("desktop.renderer.syncFailed", { error }) : t("desktop.renderer.syncFailedSimple");
  }
  if (state === "reachable") {
    return t("desktop.renderer.apiReachable");
  }
  if (state === "not_configured") {
    return t("desktop.renderer.apiNotConfigured");
  }
  if (state === "unreachable") {
    return error ? t("desktop.renderer.apiUnreachable", { error }) : t("desktop.renderer.apiUnreachableSimple");
  }
  return t("desktop.renderer.notSynced");
}

function renderToday() {
  const total = latestUsage.reduce((sum, item) => sum + item.totalTokens, 0);
  const workdirs = groupBy(latestUsage, "workdirDisplayName");
  const models = groupBy(latestUsage, "model");
  const cost = aggregateUsageCost(latestUsage);
  const composition = aggregateComposition(latestUsage);

  $("#today-total").textContent = formatToken(total);
  $("#today-total").title = formatTokenRaw(total);
  $("#today-summary").textContent = latestUsage.length ? `${latestUsage.length} daily rows from local sources` : t("desktop.renderer.noLocalUsage");
  $("#today-scan-time").textContent = t("desktop.renderer.lastScan", { time: latestScanAt ? formatDateTime(latestScanAt) : "-" });
  $("#workdir-count").textContent = String(workdirs.length);
  $("#model-count").textContent = String(models.length);
  $("#today-dominant").textContent = humanDominant(dominantComposition(composition));
  $("#today-composition-summary").textContent = tokenCompositionSummary(composition) || t("desktop.renderer.noComposition");
  $("#today-composition").innerHTML = renderCompositionTiles(composition);
  $("#today-cost-card").hidden = !latestConfig?.showEstimatedCost;
  $("#today-cost").textContent = renderCostValue(cost);
  $("#today-cost").title = costTitle(cost);
  $("#today-cost-note").textContent = cost.missingPriceTokens ? `* ${pricingSource}` : pricingSource;
  $("#today-cost-note").title = costTitle(cost);

  $("#workdir-list").innerHTML = workdirs.length
    ? renderBars(workdirs, { showCost: latestConfig?.showEstimatedCost })
    : `<article class="empty-state">${t("desktop.renderer.noWorkdirUsage")}</article>`;
  $("#model-list").innerHTML = models.length
    ? renderBars(models, { showCost: latestConfig?.showEstimatedCost })
    : `<article class="empty-state">${t("desktop.renderer.noModelUsage")}</article>`;
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
    : `<article class="empty-state">${t("desktop.renderer.noLocalUsageFound")}</article>`;
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
    : `<tr><td colspan="${latestConfig?.showEstimatedCost ? 6 : 5}" class="empty-cell">${t("desktop.renderer.noLocalUsageFound")}</td></tr>`;
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
            <small title="${formatTokenRaw(item.totalTokens)}">${formatToken(item.totalTokens)} ${t("unit.tokens")}</small>
          </div>
          <input data-alias-input="${escapeHtml(item.workdirHash)}" value="${escapeHtml(latestConfig?.workdirAliases?.[item.workdirHash] || "")}" placeholder="${escapeHtml(t("desktop.workdir.aliasPlaceholder"))}" />
          <button data-save-alias="${escapeHtml(item.workdirHash)}">${t("desktop.workdir.saveAlias")}</button>
        </article>`)
        .join("")
    : `<article class="empty-state">${t("desktop.renderer.noWorkdirs")}</article>`;
}

function renderHealth() {
  const html = latestHealth
    .map((item) => {
      const enabled = sourceEnabled(item);
      const sources = item.sources || [];
      const autoSources = sources.filter(s => s.kind === "auto" && !s.ignored);
      const manualSources = sources.filter(s => s.kind === "manual");
      const ignoredSources = sources.filter(s => s.ignored);
      return `<article class="source-card${enabled ? "" : " source-disabled"}">
      <div>
        <strong>${sourceName(item.providerId)}</strong>
        <small>${sourceSummary(item)}</small>
        <p>${sourceDescription(item.providerId)}</p>
        ${renderSourceList(autoSources, manualSources, ignoredSources, item.providerId)}
      </div>
      <button class="source-toggle ${enabled ? "ok" : "miss"}" type="button" data-toggle-source="${escapeHtml(item.providerId)}" aria-pressed="${enabled ? "true" : "false"}" data-source-state="${enabled ? "enabled" : "disabled"}" title="${escapeHtml(sourceToggleTitle(enabled))}" aria-label="${escapeHtml(sourceToggleTitle(enabled))}">${sourceToggleIcon()}</button>
    </article>`;
    })
    .join("");
  $("#settings-source-list").innerHTML = html;
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

function sourceToggleIcon() {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M12 3v9"></path>
    <path d="M7.05 7.05a7 7 0 1 0 9.9 0"></path>
  </svg>`;
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

async function loadBackgroundStatus() {
  const status = await api.backgroundStatus();
  const config = await api.getConfig();
  if (config) {
    latestConfig = config;
    renderSyncStatus(config);
  }
  const parts = [];
  parts.push(status.enabled ? t("desktop.renderer.bgRefreshOn") : t("desktop.renderer.bgRefreshOff"));
  if (status.lastResult) parts.push(status.lastResult);
  if (status.lastMode === "sync") parts.push(t("desktop.renderer.autoUpload"));
  if (status.lastMode === "scan") parts.push(t("desktop.renderer.localOnlyMode"));
  if (status.nextRunAt) parts.push(t("desktop.renderer.next", { time: formatTime(status.nextRunAt) }));
  if (status.lastError) parts.push(t("desktop.renderer.error", { error: status.lastError }));
  $("#background-state").textContent = parts.join(" · ");
  renderSilentUpdateStatus(status.updateCheck, config);
}

function renderSilentUpdateStatus(updateCheck = {}, config = latestConfig) {
  const mode = config?.silentUpdateMode || "notify";
  const labels = {
    notify: t("desktop.renderer.notifyOnly"),
    auto_download: t("desktop.renderer.autoDownload"),
    auto_apply_on_idle: t("desktop.renderer.autoApplyIdle")
  };
  const parts = [labels[mode] || t("desktop.renderer.notifyOnly")];
  if (updateCheck?.status) parts.push(updateCheck.status.replaceAll("_", " "));
  if (updateCheck?.downloadProgress) parts.push(`${updateCheck.downloadProgress.percent}%`);
  if (updateCheck?.lastResult?.latestVersion && updateCheck?.status === "downloaded") {
    parts.push(t("desktop.renderer.ready", { version: updateCheck.lastResult.latestVersion }));
  }
  if (updateCheck?.nextCheckAt) parts.push(t("desktop.renderer.next", { time: formatTime(updateCheck.nextCheckAt) }));
  if (updateCheck?.lastError) parts.push(t("desktop.renderer.error", { error: updateCheck.lastError }));
  $("#system-silent-update").textContent = t("desktop.renderer.silentUpdate", { parts: parts.join(" · ") });
}

function renderSourceList(autoSources, manualSources, ignoredSources, providerId) {
  const allVisible = [...manualSources, ...autoSources];
  if (!allVisible.length && !ignoredSources.length) return "";
  let html = '<ul class="root-list">';
  for (const source of manualSources) {
    const label = escapeHtml(source.label);
    const id = escapeHtml(source.id);
    if (providerId === "cursor_dashboard_usage" && source.tokenIndex !== undefined) {
      html += `<li><span class="source-kind-badge manual">${t("desktop.sources.kindManual")}</span><span class="root-path" title="${label}">${label}</span><button class="source-action-btn delete" type="button" data-remove-cursor-token="${source.tokenIndex}" title="${t("desktop.sources.removeTitle")}">${t("desktop.sources.deleteBtn")}</button></li>`;
    } else {
      html += `<li><span class="source-kind-badge manual">${t("desktop.sources.kindManual")}</span><span class="root-path" title="${label}">${label}</span><button class="source-action-btn delete" type="button" data-remove-root="${id}" data-provider-id="${escapeHtml(providerId)}" title="${t("desktop.sources.removeTitle")}">${t("desktop.sources.deleteBtn")}</button></li>`;
    }
  }
  for (const source of autoSources) {
    const label = escapeHtml(source.label);
    const id = escapeHtml(source.id);
    html += `<li><span class="source-kind-badge auto">${t("desktop.sources.kindAuto")}</span><span class="root-path" title="${label}">${label}</span><button class="source-action-btn ignore" type="button" data-ignore-source="${id}" data-provider-id="${escapeHtml(providerId)}" title="${t("desktop.sources.ignoreTitle")}">${t("desktop.sources.ignore")}</button></li>`;
  }
  if (ignoredSources.length) {
    html += `<li class="ignored-section"><span class="source-kind-badge ignored">${t("desktop.sources.kindIgnored")} (${ignoredSources.length})</span>`;
    for (const source of ignoredSources) {
      html += `<button class="source-action-btn unignore" type="button" data-unignore-source="${escapeHtml(source.id)}" data-provider-id="${escapeHtml(providerId)}">${source.label ? escapeHtml(source.label) : t("desktop.sources.unignore")}</button>`;
    }
    html += '</li>';
  }
  html += '</ul>';
  return html;
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
        <h3>${t("desktop.renderer.topModels")}</h3>
        <div class="breakdown">${renderCompactBreakdown(row.modelBreakdown)}</div>
      </section>
      <section>
        <h3>${t("desktop.renderer.topWorkdirs")}</h3>
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
      <h3>${t("desktop.renderer.modelDetail")}</h3>
      <p>${t("desktop.renderer.groupedBy")}</p>
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
  const labels = {
    "input-heavy": t("web.composition.inputHeavy"),
    "output-heavy": t("web.composition.outputHeavy"),
    "cache-heavy": t("web.composition.cacheHeavy"),
    "reasoning-heavy": t("web.composition.reasoningHeavy"),
    "no-usage": t("web.composition.noUsage")
  };
  return labels[value] || value || "-";
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
      ${renderTrendMetric(t("desktop.renderer.latestLabel"), formatToken(latest.totalTokens), formatTrendPeriod(latest), metricTitle(latest))}
      ${renderTrendMetric(t("desktop.renderer.peak"), formatToken(peak.totalTokens), formatTrendPeriod(peak), metricTitle(peak))}
      ${renderTrendMetric(t("desktop.renderer.viewTotal"), formatToken(total), `${rows.length} ${trendViewMeta().bucketLabel}${rows.length === 1 ? "" : "s"}`, formatTokenRaw(total))}
      ${latestConfig?.showEstimatedCost ? renderTrendMetric(t("desktop.renderer.cost"), renderCost(cost), pricingSource, costTitle(cost)) : renderTrendMetric(t("desktop.renderer.dominant"), humanDominant(dominantComposition(latest)), tokenCompositionSummary(latest), metricTitle(latest))}
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
    $("#sync-state").textContent = t("desktop.renderer.actionFailed");
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
  return latestConfig?.showRawTokens ? formatNumber(value) : localeTokenCompact(value);
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

function trailingDays(count) {
  const today = utcToday();
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(today);
    day.setUTCDate(today.getUTCDate() - count + index + 1);
    return toDay(day);
  });
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
  $("#sync-state").textContent = error.message;
});
