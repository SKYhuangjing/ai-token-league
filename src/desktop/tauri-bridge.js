// Tauri bridge — loaded before renderer.js; defines window.tokenLeague
// with the same 40-member surface that renderer.js already consumes.

(function () {
  const { invoke, event } = window.__TAURI__.core
    ? { invoke: window.__TAURI__.core.invoke, event: window.__TAURI__.event }
    : { invoke: () => Promise.reject(new Error("Tauri not loaded")), event: {} };

  // Forward a command to the bundled Rust collector sidecar.
  // Arguments are normalised into an array so the sidecar can spread them.
  function fwd(command) {
    return (...args) => invoke("forward_to_sidecar", { command, args: args.length <= 1 ? (args[0] ?? null) : args });
  }

  // Listen to a Tauri event, translating to the renderer-expected callback signature.
  function listenEvent(eventName, callback) {
    event.listen(eventName, (e) => callback(e.payload));
  }

  // One-shot unlisten helper (tracks the unlisten function per event name).
  const unlisteners = {};

  function listenAndTrack(eventName, callback) {
    event.listen(eventName, (e) => {
      callback(e.payload);
    }).then((unlisten) => {
      unlisteners[eventName] = unlisten;
    });
  }

  window.tokenLeague = {
    // ── Synchronous property ────────────────────────────────────
    platform: navigator.platform.startsWith("Mac") ? "darwin"
            : navigator.platform.startsWith("Win") ? "windows"
            : "linux",

    // ── Config ──────────────────────────────────────────────────
    getConfig:           fwd("config:get"),
    checkApi:            fwd("api:check"),
    initConfig:          fwd("config:init"),
    updateConfig:        (input) => invoke("update_config", { input }),

    // ── Identity / Config / Diagnostics export (Rust handles dialogs) ──
    exportIdentity:      () => invoke("export_identity_dialog"),
    exportConfig:        () => invoke("export_config_dialog"),
    exportDiagnostics:   () => invoke("export_diagnostics_dialog"),
    diagnosticsStatus:   fwd("diagnostics:status"),
    clearRuntimeLog:     fwd("diagnostics:clear-runtime-log"),
    revealRuntimeLogDirectory: () => invoke("reveal_runtime_log_directory"),
    exportLocalBackup:   () => invoke("export_local_backup_dialog"),
    importIdentity:      () => invoke("import_identity_dialog"),
    importConfig:        (mode) => invoke("import_config_dialog", { mode: mode || null }),
    restoreLocalBackup:  () => invoke("restore_local_backup_dialog"),
    localBackupStatus:   fwd("local-backup:status"),
    createLocalBackup:   fwd("local-backup:create"),
    clearLocalBackups:   () => invoke("clear_local_backups"),
    runDueAutoBackup:    fwd("local-backup:run-due-auto"),
    chooseBackupDirectory: () => invoke("choose_local_backup_directory_dialog"),
    pickLocalBackup:     () => invoke("pick_local_backup_dialog"),
    restoreLocalBackupFile: (filePath) => invoke("restore_local_backup_file", { filePath }),
    revealBackupDirectory: (path) => invoke("reveal_local_backup_directory", { path }),

    // ── Background ──────────────────────────────────────────────
    backgroundStatus:    () => invoke("background_status"),

    // ── Provider roots ──────────────────────────────────────────
    addProviderRoot:     (providerId) => invoke("add_provider_root_dialog", { providerId }),
    removeProviderRoot:  (providerId, rootPath) => invoke("forward_to_sidecar", { command: "config:remove-provider-root", args: [providerId, rootPath] }),

    // ── Cursor tokens ───────────────────────────────────────────
    addCursorToken:      fwd("cursor:add-token"),
    removeCursorToken:   fwd("cursor:remove-token"),
    startCursorConnect:  fwd("cursor:connect:start"),
    pollCursorConnect:   fwd("cursor:connect:poll"),
    cancelCursorConnect: fwd("cursor:connect:cancel"),
    disconnectCursor:    (index) => invoke("forward_to_sidecar", { command: "cursor:disconnect", args: { index } }),

    // ── Auto-source ignore ──────────────────────────────────────
    ignoreAutoSource:    fwd("config:ignore-auto-source"),
    unignoreAutoSource:  fwd("config:unignore-auto-source"),

    // ── Workdirs ────────────────────────────────────────────────
    setWorkdirAlias:     fwd("workdirs:set-alias"),

    // ── Provider health / pricing ───────────────────────────────
    providerHealth:      fwd("providers:health"),
    modelPrices:         fwd("pricing:model-prices"),

    // ── Usage scanning ──────────────────────────────────────────
    scanUsage:           fwd("usage:scan"),
    startUsageScan:      fwd("usage:scan-start"),
    usageScanStatus:     fwd("usage:scan-status"),
    usageSummary:        fwd("usage:summary"),
    usageTrend:          fwd("usage:trend"),
    usageWorkdirs:       fwd("usage:workdirs"),
    usageDetailPage:     fwd("usage:detail-page"),
    usageDetailWindow:   fwd("usage:detail-window"),

    // ── Sync ────────────────────────────────────────────────────
    syncUsage:           fwd("usage:sync"),
    startUsageSync:      fwd("usage:sync-start"),
    startFullReconcile:  fwd("usage:full-reconcile-start"),
    fullReconcileStatus: fwd("usage:full-reconcile-status"),

    // ── Identity ────────────────────────────────────────────────
    getMyIdentity:       fwd("my-identity"),

    // ── App ─────────────────────────────────────────────────────
    appVersion:          fwd("app:version"),
    logEvent:            fwd("runtime:log"),

    // ── Updates (native Tauri updater) ───────────────────────────
    checkUpdate:              () => invoke("check_update"),
    downloadUpdate:           () => invoke("download_update"),
    installAndRestartUpdate:  () => invoke("install_and_restart"),
    downloadInstaller:        fwd("update:download-installer"),
    enforcementStatus:        fwd("update:enforcement-status"),

    // ── Reset ───────────────────────────────────────────────────
    resetLocalData:      fwd("app:reset-local-data"),
    resetWithCloud:      fwd("app:reset-with-cloud"),
    openUrl:             (url) => invoke("open_url", { url }),

    // ── Tray ────────────────────────────────────────────────────
    rebuildTrayMenu:     () => invoke("rebuild_tray_menu_command"),
    updateTrayCost:      fwd("tray:cost-state"),

    // ── Dock (macOS) ───────────────────────────────────────────
    setDockVisible:      (visible) => invoke("set_dock_visible", { visible }),

    // ── Event listeners (main → renderer push) ──────────────────
    onUpdateProgress(callback) {
      listenAndTrack("update:progress", callback);
    },
    removeUpdateProgressListener() {
      if (unlisteners["update:progress"]) {
        unlisteners["update:progress"]();
        delete unlisteners["update:progress"];
      }
    },
    onInstallerProgress(callback) {
      listenAndTrack("update:installer-progress", callback);
    },
    onNavigateSection(callback) {
      listenAndTrack("navigate:section", callback);
    },
    onTrayRefreshStart(callback) {
      listenAndTrack("tray:refresh-start", callback);
    },
    onTrayRefreshDone(callback) {
      listenAndTrack("tray:refresh-done", callback);
    },
    onTrayRefreshFailed(callback) {
      listenAndTrack("tray:refresh-failed", callback);
    },
  };

  // Set platform from Tauri command (supplements the synchronous navigator-based default)
  invoke("platform").then((p) => {
    window.tokenLeague.platform = p;
  });
})();
