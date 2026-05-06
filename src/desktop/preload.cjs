const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tokenLeague", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  checkApi: (apiBaseUrl) => ipcRenderer.invoke("api:check", apiBaseUrl),
  initConfig: (input) => ipcRenderer.invoke("config:init", input),
  updateConfig: (input) => ipcRenderer.invoke("config:update", input),
  exportIdentity: () => ipcRenderer.invoke("identity:export"),
  exportConfig: () => ipcRenderer.invoke("config:export"),
  exportDiagnostics: () => ipcRenderer.invoke("diagnostics:export"),
  importIdentity: () => ipcRenderer.invoke("identity:import"),
  importConfig: () => ipcRenderer.invoke("config:import"),
  backgroundStatus: () => ipcRenderer.invoke("background:status"),
  addProviderRoot: (providerId) => ipcRenderer.invoke("providers:add-root", providerId),
  addCursorToken: (rawInput) => ipcRenderer.invoke("cursor:add-token", rawInput),
  setWorkdirAlias: (workdirHash, alias) => ipcRenderer.invoke("workdirs:set-alias", { workdirHash, alias }),
  providerHealth: () => ipcRenderer.invoke("providers:health"),
  modelPrices: () => ipcRenderer.invoke("pricing:model-prices"),
  scanUsage: (options) => ipcRenderer.invoke("usage:scan", options),
  startUsageScan: (options) => ipcRenderer.invoke("usage:scan-start", options),
  usageScanStatus: () => ipcRenderer.invoke("usage:scan-status"),
  syncUsage: () => ipcRenderer.invoke("usage:sync"),
  appVersion: () => ipcRenderer.invoke("app:version"),
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: (input) => ipcRenderer.invoke("update:download", input),
  resetLocalData: () => ipcRenderer.invoke("app:reset-local-data")
});
