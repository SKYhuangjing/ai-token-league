import { dominantComposition, tokenCompositionSummary } from "../shared/composition.js";
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
let pricingSource = t("desktop.renderer.localFallbackPricing");
let latestScanAt = "";
let scanRunning = false;
let scanPollTimer = null;
let latestUpdateState = null;
let latestBackgroundStatus = null;
let latestIdentityBusinessDay = "";
let lastIdentityCheckLocalDay = localDay();
let identityRefreshTimer = null;
let overviewRange = "today";
let workdirsRange = "today";
let sourcesProviderTab = "claude_code_local";
let latestSyncInfo = "";

function showToast(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 1800);
}

function setStatusMessage(message) {
  const el = document.querySelector("#sync-state");
  if (el) el.textContent = message;
}

document.querySelectorAll("nav button").forEach((button) => {
  button.addEventListener("click", () => {
    selectSection(button.dataset.section);
    if (button.dataset.section === "sources") run(loadHealth);
  });
});

document.querySelectorAll('[data-section="settings"]').forEach((button) => {
  button.addEventListener("click", () => {
    selectSection("settings");
    run(loadBackgroundStatus);
  });
});

$("#brand-refresh").addEventListener("click", () => run(() => loadToday(true)));

$("#rail-restart-update").addEventListener("click", () => run(async () => {
  $("#rail-restart-update").disabled = true;
  await api.installAndRestartUpdate();
}));
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
document.addEventListener("click", (event) => {
  const btn = event.target.closest("#add-codex-root");
  if (btn) run(() => addProviderRoot("codex_local"));
});
document.addEventListener("click", (event) => {
  const btn = event.target.closest("#add-claude-root");
  if (btn) run(() => addProviderRoot("claude_code_local"));
});
document.addEventListener("click", (event) => {
  const btn = event.target.closest("#add-cursor-token");
  if (btn) openCursorTokenModal();
});
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
});
$("#workdirs-range").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-range]");
  if (!button) return;
  workdirsRange = button.dataset.range;
  setSegmentActive($("#workdirs-range"), workdirsRange);
  renderWorkdirs();
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
const DIRTY_TRACKED_FIELDS = ["nickname", "apiBaseUrl", "launchAtLogin", "refreshIntervalMinutes"];

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
    setSaveMessage(err.message || t("desktop.renderer.failedToRemove"), "error");
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
    setSaveMessage(err.message || t("desktop.renderer.failedToRemove"), "error");
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
  setStatusMessage(t("desktop.sync.settingsSaved"));
  await loadBackgroundStatus();
  return config;
}

function settingsPayload() {
  return {
    nickname: $("#nickname")?.value || "anonymous",
    apiBaseUrl: $("#apiBaseUrl")?.value?.trim() || "",
    autoRefreshEnabled: true,
    silentUpdateMode: "auto_download",
    refreshIntervalMinutes: $("#refreshIntervalMinutes")?.value || 15,
    launchAtLogin: $("#launchAtLogin")?.checked ?? false,
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
  setStatusMessage(t("desktop.sync.profileReady"));
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
  setStatusMessage(t("desktop.sync.profileReady"));
}

async function resetLocalData() {
  const ok = window.confirm(t("desktop.renderer.confirmReset"));
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

function hasConfiguredApiBaseUrl(config) {
  return Boolean(String(config?.apiBaseUrl || "").trim());
}

async function resetLocalOnly() {
  closeResetConfirmModal();
  $("#reset-local-data").disabled = true;
  setStatusMessage(t("desktop.renderer.resetting"));
  await api.resetLocalData();
}

async function resetWithCloud() {
  const errorEl = $("#reset-confirm-error");
  errorEl.textContent = "";
  $("#reset-local-data").disabled = true;
  setStatusMessage(t("desktop.reset.cloudClearing"));
  try {
    await api.resetWithCloud();
  } catch (error) {
    $("#reset-local-data").disabled = false;
    setStatusMessage("");
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
    await loadMyIdentity();
    startIdentityRefreshTimer();
    await loadBackgroundStatus();
    await loadSystemStatus();
  } else {
    showToast(t("desktop.renderer.openSettings"));
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
    $("#download-update").hidden = false;
    $("#download-update").disabled = false;
    $("#download-installer").hidden = true;
    $("#download-update").textContent = t("desktop.app.installRestart");
    $("#download-update").dataset.updateAction = "install";
    $("#update-message").textContent = t("desktop.renderer.downloadedReady");
  }
  if (data.status === "failed" && data.lastError) {
    $("#update-message").textContent = data.lastError;
    $("#download-update").hidden = true;
    $("#download-update").disabled = true;
    $("#download-installer").hidden = false;
  }
  renderSilentUpdateStatus(data, latestConfig);
}

async function loadToday(force = false) {
  await refreshPricing();
  const status = await api.startUsageScan({ force });
  applyUsageScanStatus(status, { force });
  await loadMyIdentity();
  pollUsageScan();
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

function setScanState(running, force = false) {
  scanRunning = running;
  $("#brand-refresh").disabled = running;
  if (running) {
    showToast(t("desktop.renderer.scanningLocal"));
  }
  renderWizard();
  renderRailStatus();
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
        showToast(t("desktop.rail.scanComplete"));
        loadMyIdentity().catch((error) => console.error(error));
      }
    } catch (error) {
      clearInterval(scanPollTimer);
      scanPollTimer = null;
      setScanState(false);
      $("#workdirs-summary").textContent = t("desktop.renderer.refreshStatusFailed", { error: error.message });
      showToast(t("desktop.renderer.refreshStatusFailed", { error: error.message }));
      console.error(error);
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
      await loadToday();
      await loadMyIdentity();
    });
  }, 60 * 1000);
}

function applyUsageScanStatus(status, { force = false } = {}) {
  if (status.snapshot) applyUsageSnapshot(status.snapshot);
  setScanState(Boolean(status.running), status.force ?? force);
  if (status.error) {
    $("#workdirs-summary").textContent = t("desktop.renderer.refreshFailed", { error: status.error });
    showToast(t("desktop.renderer.refreshFailed", { error: status.error }));
  }
}

function applyUsageSnapshot(usage) {
  allUsage = (usage.items || []).map(normalizeUsageTotal);
  latestScanAt = usage.scannedAt || latestScanAt;
  latestUsage = allUsage.filter((item) => item.day === localDay());
  if (usage.health) latestHealth = usage.health;
  renderToday();
  renderWorkdirs();
  renderHealth();
  renderAliases();
  renderRailStatus();
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
      setStatusMessage(t("desktop.renderer.syncCanceled"));
      return;
    }
    setStatusMessage(t("desktop.renderer.syncing"));
    const result = await api.syncUsage();
    latestConfig = await api.getConfig();
    renderSyncStatus(latestConfig, result);
    await loadToday();
    await loadMyIdentity();
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
  if (config?.nickname && $("#nickname")) $("#nickname").value = config.nickname;
  if ($("#apiBaseUrl")) $("#apiBaseUrl").value = config?.apiBaseUrl ?? "";
  if ($("#showEstimatedCost")) $("#showEstimatedCost").checked = config?.showEstimatedCost ?? false;
  if ($("#showRawTokens")) $("#showRawTokens").checked = config?.showRawTokens ?? false;
  if ($("#refreshIntervalMinutes")) $("#refreshIntervalMinutes").value = config?.refreshIntervalMinutes ?? 15;
  if ($("#launchAtLogin")) $("#launchAtLogin").checked = config?.launchAtLogin ?? false;
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

function setUpdateCardBusy(isBusy) {
  const card = $("#check-update");
  card.dataset.busy = isBusy ? "true" : "false";
  card.setAttribute("aria-disabled", isBusy ? "true" : "false");
}

async function checkUpdate() {
  if (isApiBaseUrlDirty() && !window.confirm(t("desktop.sync.unsavedApiBaseUrl"))) return;
  const apiBaseUrl = normalizeApiBaseUrl(latestConfig?.apiBaseUrl || "");
  if (!apiBaseUrl) {
    showToast(t("desktop.renderer.configureCloudUpdate"));
    return;
  }
  setUpdateCardBusy(true);
  $("#download-update").hidden = true;
  $("#download-update").disabled = true;
  $("#download-installer").hidden = true;
  $("#update-message").textContent = t("desktop.renderer.checking");
  try {
    latestUpdateState = await api.checkUpdate();
    renderSystemStatus(latestUpdateState);
    $("#update-message").textContent = updateMessage(latestUpdateState);
    $("#download-update").hidden = !latestUpdateState.update?.updateAvailable;
    $("#download-update").disabled = !latestUpdateState.update?.updateAvailable;
    $("#download-update").textContent = t("desktop.app.downloadRestart");
    $("#download-update").dataset.updateAction = "download";
    latestConfig = await api.getConfig();
    renderCloudStatus(latestConfig);
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

async function downloadUpdate() {
  $("#download-update").hidden = false;
  $("#download-update").disabled = true;
  $("#update-message").textContent = t("desktop.renderer.downloading");
  try {
    await api.downloadUpdate();
    $("#download-update").textContent = t("desktop.app.installRestart");
    $("#download-update").disabled = false;
    $("#download-update").dataset.updateAction = "install";
  } catch (error) {
    $("#update-message").textContent = error.message || t("desktop.renderer.downloadFailed");
    $("#download-update").disabled = false;
  }
}

async function installAndRestartUpdate() {
  $("#download-update").disabled = true;
  $("#update-message").textContent = t("desktop.renderer.downloadedInstalling");
  await api.installAndRestartUpdate();
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
  const version = client.clientAppVersion || "";
  const latest = update?.latestVersion || server.latestClientVersion || "";
  setTextIfPresent("#update-status-text", latest
    ? t("desktop.renderer.latest", { version: latest })
    : version ? `v${version}` : t("desktop.renderer.latestDash"));
  renderRailStatus();
}

function renderCloudStatus(config = latestConfig) {
  const connection = config?.apiConnection || {};
  const apiBaseUrl = normalizeApiBaseUrl(config?.apiBaseUrl || connection.apiBaseUrl || "");
  const badge = $("#cloud-status-badge");
  const text = $("#cloud-status-text");
  if (!badge || !text) return;
  if (!apiBaseUrl) {
    badge.textContent = t("desktop.renderer.localOnly");
    badge.className = "badge";
    text.textContent = t("desktop.renderer.cloudNotConfigured");
    text.title = "";
  } else {
    const healthy = connection.status === "reachable";
    badge.textContent = healthy ? "OK" : connection.status || "-";
    badge.className = healthy ? "badge ok" : "badge warn";
    const parts = [];
    if (connection.serverVersion) parts.push(`v${connection.serverVersion}`);
    if (connection.latestClientVersion) parts.push(t("desktop.renderer.latest", { version: connection.latestClientVersion }));
    if (latestSyncInfo) parts.push(latestSyncInfo);
    text.textContent = parts.length ? parts.join(" · ") : apiBaseUrl;
    text.title = connection.message || apiBaseUrl;
  }
  renderRailStatus();
}

function updateMessage(state = {}) {
  if (state.code === "cloud_not_configured") return t("desktop.renderer.configureCloudUpdate");
  if (state.code === "release_not_configured") return t("desktop.renderer.releaseNotConfigured");
  return state.message || t("desktop.renderer.updateCheckFinished");
}


function renderCursorTokenSummary(cursorConfig = {}) {
  const tokens = cursorConfig?.workosSessionTokens || [];
  const legacy = cursorConfig?.workosSessionToken ? [{ accountName: t("common.legacyToken") }] : [];
  const accounts = [...tokens, ...legacy].map((item) => item.accountName || "Cursor").filter(Boolean);
  const summary = accounts.length
    ? (accounts.length === 1 ? t("desktop.renderer.cursorTokensConfiguredOne") : t("desktop.renderer.cursorTokensConfiguredPlural", { count: accounts.length }))
    : t("desktop.renderer.noCursorTokenAuto");
  let html = `<p class="cursor-token-note">${escapeHtml(summary)}</p>`;
  if (tokens.length) {
    html += `<ul class="root-list">${tokens.map((item, idx) => {
      const name = escapeHtml(item.accountName || "Cursor");
      return `<li><span class="root-path">${name}</span><button class="source-action-btn delete" type="button" data-remove-cursor-token="${idx}" title="${t("desktop.sources.removeTitle")}">${t("desktop.sources.deleteBtn")}</button></li>`;
    }).join("")}</ul>`;
  }
  const target = $("#cursor-token-summary");
  if (target) {
    target.hidden = true;
    target.innerHTML = html;
  }
  return html;
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

function renderToday() {
  const rangeItems = usageForRange(overviewRange);
  const total = rangeItems.reduce((sum, item) => sum + item.totalTokens, 0);
  const workdirs = groupBy(rangeItems, "workdirDisplayName");
  const models = groupBy(rangeItems, "model");
  const providers = groupProviders(rangeItems);
  const cost = aggregateUsageCost(rangeItems);
  const composition = aggregateComposition(rangeItems);

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
    const costPart = latestConfig?.showEstimatedCost ? ` · ${renderCostAmountValue(costValueForField(cost, field) || 0)}` : "";
    detailEl.innerHTML = escapeHtml(pct) + costPart;
  });

  const costEl = document.querySelector("#today-cost");
  if (costEl) {
    if (latestConfig?.showEstimatedCost) {
      costEl.innerHTML = `${renderCostAmount(cost)} <span class="cost-note">${escapeHtml(t("common.estimated").toLowerCase())}</span>`;
      costEl.title = costTitle(cost);
    } else {
      costEl.textContent = rangeItems.length
        ? t("desktop.overview.rangeRows", { range: rangeLabel(overviewRange), count: rangeItems.length })
        : t("desktop.renderer.noLocalUsageFound");
    }
  }

  $("#provider-list").innerHTML = providers.length
    ? renderMiniMeters(providers, { showCost: latestConfig?.showEstimatedCost, limit: 3 })
    : `<div class="empty-state">${t("desktop.overview.noProviderUsage")}</div>`;
  $("#workdir-list").innerHTML = workdirs.length
    ? renderMiniMeters(workdirs, { showCost: latestConfig?.showEstimatedCost, limit: 3 })
    : `<div class="empty-state">${t("desktop.renderer.noWorkdirUsage")}</div>`;
  $("#model-list").innerHTML = models.length
    ? renderMiniMeters(models, { showCost: latestConfig?.showEstimatedCost, limit: 3 })
    : `<div class="empty-state">${t("desktop.renderer.noModelUsage")}</div>`;
  renderOverviewTrend(rangeItems);
  renderRailStatus();
}

function renderWorkdirs() {
  const rangeItems = usageForRange(workdirsRange);
  const total = rangeItems.reduce((sum, item) => sum + item.totalTokens, 0);
  const workdirs = groupWorkdirDetails(rangeItems);
  const models = groupBy(rangeItems, "model");
  const cost = aggregateUsageCost(rangeItems);
  $("#workdirs-summary").textContent = workdirs.length
    ? t("desktop.workdirs.summary", { count: workdirs.length })
    : t("desktop.renderer.noWorkdirUsage");
  $("#workdirs-analysis-list").innerHTML = workdirs.length
    ? renderWorkdirCards(workdirs)
    : `<article class="empty-state">${t("desktop.renderer.noWorkdirs")}</article>`;
}

function renderOverviewTrend(items) {
  const grain = overviewRange === "30d" ? "week" : overviewRange === "all" ? "month" : "day";
  const trendRange = overviewRange === "today" ? "7d" : overviewRange;
  const trendItems = usageForRange(trendRange);
  const rows = groupByGrain(trendItems, grain);
  const max = Math.max(...rows.map((row) => row.totalTokens), 1);
  const peakIdx = rows.reduce((best, row, i) => row.totalTokens > rows[best].totalTokens ? i : best, 0);

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
      return `<div class="spark-bar${isHot ? " hot" : ""}" data-open-overview-trend="${escapeHtml(row.periodStart)}|${escapeHtml(row.periodEnd)}" style="height:${Math.max(12, (row.totalTokens / max) * 100)}%; transition: height 0.3s ease; cursor: pointer;" data-tooltip="${escapeHtml(metricTitle(row))}"></div>`;
    }).join("");

    axisEl.style.gridTemplateColumns = gridCols;
    axisEl.innerHTML = rows.map((row) => formatAxisLabel(row, grain)).join("");
  } else {
    sparkEl.style.gridTemplateColumns = "";
    sparkEl.innerHTML = `<div class="empty-state">${t("desktop.renderer.noLocalUsageFound")}</div>`;
    axisEl.innerHTML = "";
  }
}

function groupByGrain(items, grain) {
  const map = new Map();
  for (const item of items) {
    const bucket = bucketForDay(item.day, grain);
    const row = map.get(bucket.key) || {
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
      totalTokens: 0
    };
    row.totalTokens += item.totalTokens || 0;
    map.set(bucket.key, row);
  }
  return [...map.values()].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
}

function formatAxisLabel(row, grain) {
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
  const lastScanAt = latestScanAt || latestBackgroundStatus?.cacheScannedAt || latestBackgroundStatus?.lastRunAt || "";
  const nextScanAt = latestBackgroundStatus?.nextRunAt || "";
  setTextIfPresent("#rail-last-scan", t("desktop.renderer.currentScan", { time: lastScanAt ? formatDateTime(lastScanAt) : "-" }));
  setTextIfPresent("#rail-next-scan", t("desktop.renderer.nextScan", { time: nextScanAt ? formatDateTime(nextScanAt) : "-" }));
  const restartBtn = $("#rail-restart-update");
  if (restartBtn) restartBtn.hidden = !(readyPackage || latestUpdateState?.status === "downloaded" || update?.status === "downloaded");
}

function renderTrend() {
  if (!$("#trend-chart-panel")) return;
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
  const workdirs = groupWorkdirs(allUsage);
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
      const manualSources = sources.filter(s => s.kind === "manual");
      const ignoredSources = sources.filter(s => s.ignored);
      const addBtn = item.providerId === "cursor_dashboard_usage"
        ? `<button class="outline-button" id="add-cursor-token" style="padding:4px 10px;font-size:12px;" type="button">+ ${t("desktop.sources.addCursor")}</button>`
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

async function loadBackgroundStatus() {
  const status = await api.backgroundStatus();
  const config = await api.getConfig();
  latestBackgroundStatus = status;
  latestUpdateState = status.updateCheck || latestUpdateState;
  if (config) {
    latestConfig = config;
    renderSyncStatus(config);
  }
  renderSilentUpdateStatus(status.updateCheck, config);
  renderRailStatus();
}

function renderSilentUpdateStatus(updateCheck = {}, config = latestConfig) {
  const mode = config?.silentUpdateMode || "auto_download";
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
  const statusText = parts.join(" · ");
  setTextIfPresent("#update-status-text", statusText);
  const badge = $("#update-badge");
  const updateButton = $("#download-update");
  if (badge) {
    const hasUpdate = updateCheck?.update?.updateAvailable || updateCheck?.status === "downloaded";
    badge.hidden = !hasUpdate;
    badge.textContent = hasUpdate ? t("desktop.about.readyToRestart") : labels[mode] || "";
    badge.className = hasUpdate ? "badge ok" : "badge";
  }
  if (updateButton && updateCheck?.status === "downloaded") {
    updateButton.hidden = false;
    updateButton.disabled = false;
    updateButton.textContent = t("desktop.app.installRestart");
    updateButton.dataset.updateAction = "install";
  } else if (updateButton && updateCheck?.update?.updateAvailable) {
    updateButton.hidden = false;
    updateButton.disabled = Boolean(updateCheck?.downloadProgress);
    updateButton.textContent = t("desktop.app.downloadRestart");
    updateButton.dataset.updateAction = "download";
  } else if (updateButton && !updateCheck?.downloadProgress) {
    updateButton.hidden = true;
    updateButton.disabled = true;
    updateButton.dataset.updateAction = "download";
  }
}

function renderSourceRows(autoSources, manualSources, ignoredSources, providerId) {
  const allVisible = [...manualSources, ...autoSources];
  if (!allVisible.length && !ignoredSources.length) return "";
  let html = '<div class="source-rows">';
  for (const source of manualSources) {
    const label = escapeHtml(source.label);
    const id = escapeHtml(source.id);
    if (providerId === "cursor_dashboard_usage" && source.tokenIndex !== undefined) {
      html += `<div class="source-row"><span class="badge">${t("desktop.sources.kindManual")}</span><span class="path" title="${label}">${label}</span><button class="outline-button" style="padding:2px 8px;font-size:11px;" type="button" data-remove-cursor-token="${source.tokenIndex}">${t("desktop.sources.removeBtn")}</button></div>`;
    } else {
      html += `<div class="source-row"><span class="badge">${t("desktop.sources.kindManual")}</span><span class="path" title="${label}">${label}</span><button class="outline-button" style="padding:2px 8px;font-size:11px;" type="button" data-remove-root="${id}" data-provider-id="${escapeHtml(providerId)}">${t("desktop.sources.removeBtn")}</button></div>`;
    }
  }
  for (const source of autoSources) {
    const label = escapeHtml(source.label);
    const id = escapeHtml(source.id);
    html += `<div class="source-row"><span class="badge ok">${t("desktop.sources.kindAuto")}</span><span class="path" title="${label}">${label}</span><button class="outline-button" style="padding:2px 8px;font-size:11px;" type="button" data-ignore-source="${id}" data-provider-id="${escapeHtml(providerId)}">${t("desktop.sources.ignore")}</button></div>`;
  }
  if (ignoredSources.length) {
    for (const source of ignoredSources) {
      html += `<div class="source-row" style="opacity:0.6;"><span class="badge">${t("desktop.sources.kindIgnored")}</span><span class="path" title="${escapeHtml(source.label || "")}">${source.label ? escapeHtml(source.label) : ""}</span><button class="outline-button" style="padding:2px 8px;font-size:11px;" type="button" data-unignore-source="${escapeHtml(source.id)}" data-provider-id="${escapeHtml(providerId)}">${t("desktop.sources.unignore")}</button></div>`;
    }
  }
  html += '</div>';
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
    const withCost = addDisplayCostToUsageItem(item);
    current.totalTokens += item.totalTokens || 0;
    aggregateCost(current, withCost);
    map.set(name, current);
  }
  return [...map.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((item) => ({ ...item, missingPriceModels: sortedBreakdown(item.missingPriceModels || {}) }));
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
        modelMap: {},
        workdirMap: {},
        modelDetailMap: {}
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
      modelBreakdown: Object.values(item.modelCostMap || {}).sort((a, b) => b.totalTokens - a.totalTokens),
      dailyBreakdown: Object.values(item.dailyCostMap || {}).sort((a, b) => a.name.localeCompare(b.name)),
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
      modelMap: {},
      workdirMap: {}
    };
    const withCost = addDisplayCostToUsageItem(item);
    row.inputTokens += item.inputTokens || 0;
    row.outputTokens += item.outputTokens || 0;
    row.reasoningTokens += item.reasoningTokens || 0;
    row.cacheReadTokens += item.cacheReadTokens || 0;
    row.cacheWriteTokens += item.cacheWriteTokens || 0;
    row.totalTokens += item.totalTokens || 0;
    row.modelMap[item.model || "unknown"] = (row.modelMap[item.model || "unknown"] || 0) + (item.totalTokens || 0);
    row.workdirMap[item.workdirDisplayName || "unknown"] = (row.workdirMap[item.workdirDisplayName || "unknown"] || 0) + (item.totalTokens || 0);
    aggregateCost(row, withCost);
    map.set(item.day, row);
  }
  return [...map.values()]
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart))
    .map((row) => ({
      ...row,
      modelBreakdown: sortedBreakdown(row.modelMap || {}),
      workdirBreakdown: sortedBreakdown(row.workdirMap || {}),
      compositionSummary: tokenCompositionSummary(row),
      missingPriceModels: sortedBreakdown(row.missingPriceModels || {})
    }));
}

function renderMiniMeters(items, { showCost = false, limit = Infinity } = {}) {
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  return items
    .slice(0, limit)
    .map((item) => {
      const pct = Math.max(3, (item.totalTokens / max) * 100);
      const name = escapeHtml(item.name);
      const val = formatToken(item.totalTokens);
      const cost = showCost ? renderCost(item) : "";
      return `<div class="mini-meter-row">
        <span title="${name}">${name}</span>
        <div class="mini-meter"><i style="width:${pct}%; transition: width 0.3s ease;"></i></div>
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
  return `<div class="drawer-meter-list">${items
    .map((item) => {
      const pct = Math.max(3, (item.totalTokens / max) * 100);
      const name = escapeHtml(item.name);
      const cost = latestConfig?.showEstimatedCost ? renderCost(item) : "";
      return `<div class="mini-meter-row drawer-meter-row">
        <span title="${name}">${name}</span>
        <div class="mini-meter"><i style="width:${pct}%; transition: width 0.3s ease;"></i></div>
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
  return items.map((item, index) => {
    const pct = Math.round(item.contributionRatio * 100);
    const badgeClass = pct > 50 ? "badge dark" : pct > 20 ? "badge" : "badge";
    const badgeText = pct > 50 ? t("desktop.workdirs.tierMain") : pct > 20 ? t("desktop.workdirs.tierMid") : t("desktop.workdirs.tierSmall");
    const costText = latestConfig?.showEstimatedCost ? ` · ${renderCostAmount(item)}` : "";
    return `<article class="workdir-card" data-open-workdir="${escapeHtml(item.workdirHash)}" role="button" tabindex="0">
    <span class="workdir-rank">#${index + 1}</span>
    <div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;">
        <strong>${escapeHtml(item.name)}</strong>
        <span class="muted" style="font-size:11px;">+${formatToken(item.totalTokens)} ${t("unit.tokens")}</span>
      </div>
      <span class="workdir-meta muted">${formatToken(item.totalTokens)} ${t("unit.tokens")}${costText} · ${pct}%</span>
      <div class="workdir-progress"><i style="width:${Math.max(3, (item.totalTokens / max) * 100)}%; transition: width 0.3s ease;"></i></div>
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
    ${renderTrendModelDetails(row)}
  </section>`;
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
  requestAnimationFrame(() => {
    $("#trend-drawer").classList.add("is-open");
    $("#trend-drawer-backdrop").classList.add("is-open");
  });
}

function openTrendBreakdownDrawer(periodKey) {
  const [start, end] = periodKey.split("|");
  const trendRange = overviewRange === "today" ? "7d" : overviewRange;
  const allItems = usageForRange(trendRange).filter((item) => item.day >= start && item.day <= end);
  if (!allItems.length) return;

  const row = aggregatePeriodRow(allItems, start, end);
  openDetailDrawer({
    eyebrow: t("desktop.trend.detailEyebrow"),
    title: formatTrendPeriod(row),
    body: renderTrendSelection({ ...row, modelDetails: [] })
  });
}

function aggregatePeriodRow(items, periodStart, periodEnd) {
  const row = {
    periodStart,
    periodEnd,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    costQuality: "",
    pricingVersion: "",
    modelMap: {},
    workdirMap: {}
  };
  for (const item of items) {
    const withCost = addDisplayCostToUsageItem(item);
    row.inputTokens += item.inputTokens || 0;
    row.outputTokens += item.outputTokens || 0;
    row.reasoningTokens += item.reasoningTokens || 0;
    row.cacheReadTokens += item.cacheReadTokens || 0;
    row.cacheWriteTokens += item.cacheWriteTokens || 0;
    row.totalTokens += item.totalTokens || 0;
    row.modelMap[item.model || "unknown"] = (row.modelMap[item.model || "unknown"] || 0) + (item.totalTokens || 0);
    row.workdirMap[item.workdirDisplayName || "unknown"] = (row.workdirMap[item.workdirDisplayName || "unknown"] || 0) + (item.totalTokens || 0);
    aggregateCost(row, withCost);
  }
  return {
    ...row,
    compositionSummary: tokenCompositionSummary(row),
    missingPriceModels: sortedBreakdown(row.missingPriceModels || {}),
    modelBreakdown: sortedBreakdown(row.modelMap || {}),
    workdirBreakdown: sortedBreakdown(row.workdirMap || {})
  };
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
  return `<section class="trend-model-details">
    <div class="section-title">
      <h3>${t("desktop.renderer.modelDetail")}</h3>
      <p>${t("desktop.renderer.groupedBy")}</p>
    </div>
    <div class="table-wrap">
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
        <tbody>
          ${details.map((item) => `<tr>
            <td>${escapeHtml(item.workdirDisplayName)}</td>
            <td>${escapeHtml(item.model)}</td>
            <td class="numeric" title="${formatTokenRaw(item.totalTokens)}">${formatToken(item.totalTokens)}</td>
            <td class="numeric" title="${formatTokenRaw(item.inputTokens)}">${renderAccountingToken(item.inputTokens, item.inputCostUsd)}</td>
            <td class="numeric" title="${formatTokenRaw(item.outputTokens)}">${renderAccountingToken(item.outputTokens, item.outputCostUsd)}</td>
            <td class="numeric" title="${formatTokenRaw(cacheTokens(item))}">${renderAccountingToken(cacheTokens(item), sumKnownCosts(item.cacheReadCostUsd, item.cacheWriteCostUsd))}</td>
            ${latestConfig?.showEstimatedCost ? `<td class="numeric" title="${escapeHtml(costTitle(item))}">${renderCostAmount(item)}</td>` : ""}
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
    cacheTokens: sumKnownCosts(item.cacheReadCostUsd, item.cacheWriteCostUsd),
    cacheReadTokens: item.cacheReadCostUsd,
    cacheWriteTokens: item.cacheWriteCostUsd,
    reasoningTokens: item.reasoningCostUsd
  }[field];
}

function renderAccountingToken(tokens, cost) {
  const costLine = latestConfig?.showEstimatedCost ? `<small>${renderCostAmountValue(cost)}</small>` : "";
  return `<span class="token-accounting">${formatToken(tokens || 0)}${costLine}</span>`;
}

function cacheTokens(item = {}) {
  return Number(item.cacheReadTokens || 0) + Number(item.cacheWriteTokens || 0);
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

function normalizeApiBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
}

function costTitle(item) {
  const missing = normalizeMissingPriceModels(item.missingPriceModels).map((model) => `${model.name} ${formatTokenRaw(model.totalTokens)}`).join(", ");
  return `${item.costQuality || t("desktop.renderer.unknownPrice")} · ${item.pricingVersion || t("desktop.renderer.noPricingVersion")} · ${pricingSource}${missing ? ` · ${t("desktop.renderer.missing")}: ${missing}` : ""}`;
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

function renderCostAmount(item) {
  return renderCostAmountValue(renderCost(item));
}

function renderCostAmountValue(value) {
  const text = typeof value === "string" ? value : formatUsd(value);
  return `<span class="cost-amount">${escapeHtml(text)}</span>`;
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

async function refreshPricing() {
  if (!latestConfig?.showEstimatedCost) return;
  if (!latestConfig?.apiBaseUrl) {
    serverPriceMap = null;
    pricingSource = t("desktop.renderer.serverPricingUnavailable");
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
  const cost = latestConfig?.showEstimatedCost ? ` · ${t("common.cost")} ${renderCost(row)}` : "";
  return `${formatTrendPeriod(row)} · ${formatToken(row.totalTokens)}${cost}`;
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
  setStatusMessage(error.message);
});
