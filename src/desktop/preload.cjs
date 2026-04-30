const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tokenLeague", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  initConfig: (input) => ipcRenderer.invoke("config:init", input),
  updateConfig: (input) => ipcRenderer.invoke("config:update", input),
  exportIdentity: () => ipcRenderer.invoke("identity:export"),
  importIdentity: () => ipcRenderer.invoke("identity:import"),
  backgroundStatus: () => ipcRenderer.invoke("background:status"),
  addProviderRoot: (providerId) => ipcRenderer.invoke("providers:add-root", providerId),
  setWorkdirAlias: (workdirHash, alias) => ipcRenderer.invoke("workdirs:set-alias", { workdirHash, alias }),
  providerHealth: () => ipcRenderer.invoke("providers:health"),
  modelPrices: () => ipcRenderer.invoke("pricing:model-prices"),
  scanUsage: (options) => ipcRenderer.invoke("usage:scan", options),
  syncUsage: () => ipcRenderer.invoke("usage:sync")
});
