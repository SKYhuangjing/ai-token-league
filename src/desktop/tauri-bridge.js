// Tauri bridge — loaded before renderer.js; defines window.tokenLeague
// with the same 40-member surface that renderer.js already consumes.

(function () {
  const { invoke, event } = window.__TAURI__.core
    ? { invoke: window.__TAURI__.core.invoke, event: window.__TAURI__.event }
    : { invoke: () => Promise.reject(new Error("Tauri not loaded")), event: {} };

  // Forward a command to the Node sidecar via the Rust relay.
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
    updateConfig:        fwd("config:update"),

    // ── Identity / Config / Diagnostics export (Rust handles dialogs) ──
    exportIdentity:      () => invoke("export_identity_dialog"),
    exportConfig:        () => invoke("export_config_dialog"),
    exportDiagnostics:   () => invoke("export_diagnostics_dialog"),
    importIdentity:      () => invoke("import_identity_dialog"),
    importConfig:        () => invoke("import_config_dialog"),

    // ── Background ──────────────────────────────────────────────
    backgroundStatus:    fwd("background:status"),

    // ── Provider roots ──────────────────────────────────────────
    addProviderRoot:     (providerId) => invoke("add_provider_root_dialog", { providerId }),
    removeProviderRoot:  (providerId, rootPath) => invoke("forward_to_sidecar", { command: "config:remove-provider-root", args: [providerId, rootPath] }),

    // ── Cursor tokens ───────────────────────────────────────────
    addCursorToken:      fwd("cursor:add-token"),
    removeCursorToken:   fwd("cursor:remove-token"),

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

    // ── Sync ────────────────────────────────────────────────────
    syncUsage:           fwd("usage:sync"),

    // ── Identity ────────────────────────────────────────────────
    getMyIdentity:       fwd("my-identity"),

    // ── App ─────────────────────────────────────────────────────
    appVersion:          fwd("app:version"),

    // ── Updates (native Tauri updater) ───────────────────────────
    checkUpdate:              () => invoke("check_update"),
    downloadUpdate:           () => invoke("download_update"),
    installAndRestartUpdate:  () => invoke("install_and_restart"),
    downloadInstaller:        fwd("update:download-installer"),
    enforcementStatus:        fwd("update:enforcement-status"),

    // ── Reset ───────────────────────────────────────────────────
    resetLocalData:      fwd("app:reset-local-data"),
    resetWithCloud:      fwd("app:reset-with-cloud"),

    // ── Tray ────────────────────────────────────────────────────
    rebuildTrayMenu:     fwd("tray:rebuild-menu"),

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
