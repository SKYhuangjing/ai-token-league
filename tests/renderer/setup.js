// Pre-check: no unexpected symlinks in src/ (test artifacts should not pollute source tree)
import { readdirSync, lstatSync } from 'fs';
import { join } from 'path';

const srcRoot = join(import.meta.dirname, '../../src');
const symlinks = [];
function findSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (lstatSync(full).isSymbolicLink()) symlinks.push(full);
    else if (entry.isDirectory() && entry.name !== 'node_modules') findSymlinks(full);
  }
}
findSymlinks(srcRoot);
if (symlinks.length > 0) {
  throw new Error(`Unexpected symlinks in src/ — remove before running tests:\n  ${symlinks.join('\n  ')}`);
}

// Mock window.tokenLeague (Tauri bridge) before any renderer code loads
const mockApi = {
  platform: 'darwin-arm64',
  getConfig: vi.fn().mockResolvedValue({}),
  updateConfig: vi.fn().mockResolvedValue({}),
  initConfig: vi.fn().mockResolvedValue({ participantId: 'p_test', nickname: 'test' }),
  startUsageScan: vi.fn().mockResolvedValue({ status: 'idle' }),
  usageScanStatus: vi.fn().mockResolvedValue({ status: 'idle' }),
  usageSummary: vi.fn().mockResolvedValue({ totals: { totalTokens: 0 } }),
  usageTrend: vi.fn().mockResolvedValue({ items: [] }),
  usageWorkdirs: vi.fn().mockResolvedValue({ items: [] }),
  usageDetailWindow: vi.fn().mockResolvedValue({ items: [], totalRows: 0 }),
  providerHealth: vi.fn().mockResolvedValue([]),
  backgroundStatus: vi.fn().mockResolvedValue({}),
  fullReconcileStatus: vi.fn().mockResolvedValue({ status: 'idle', running: false }),
  getMyIdentity: vi.fn().mockResolvedValue({ participantId: 'p_test', nickname: 'test' }),
  appVersion: vi.fn().mockResolvedValue({ clientAppVersion: '0.7.0', clientPlatform: 'darwin-arm64', runtime: 'rust-tauri' }),
  checkUpdate: vi.fn().mockResolvedValue(null),
  modelPrices: vi.fn().mockResolvedValue({}),
  startUsageSync: vi.fn().mockResolvedValue({}),
  syncUsage: vi.fn().mockResolvedValue({}),
  checkApi: vi.fn().mockResolvedValue({ ok: true }),
  logEvent: vi.fn(),
  updateTrayCost: vi.fn(),
  rebuildTrayMenu: vi.fn(),
  setDockVisible: vi.fn(),
  openUrl: vi.fn(),
  exportConfig: vi.fn(),
  importConfig: vi.fn(),
  exportIdentity: vi.fn(),
  importIdentity: vi.fn(),
  exportDiagnostics: vi.fn(),
  saveShareImage: vi.fn().mockResolvedValue({ canceled: false, filePath: '/tmp/share.png' }),
  clearRuntimeLog: vi.fn(),
  revealRuntimeLogDirectory: vi.fn(),
  createLocalBackup: vi.fn(),
  pickLocalBackup: vi.fn(),
  restoreLocalBackupFile: vi.fn(),
  chooseBackupDirectory: vi.fn(),
  clearLocalBackups: vi.fn(),
  localBackupStatus: vi.fn().mockResolvedValue({}),
  addProviderRoot: vi.fn(),
  removeProviderRoot: vi.fn(),
  addCursorToken: vi.fn(),
  removeCursorToken: vi.fn(),
  startCursorConnect: vi.fn(),
  pollCursorConnect: vi.fn(),
  cancelCursorConnect: vi.fn(),
  disconnectCursor: vi.fn(),
  ignoreAutoSource: vi.fn(),
  unignoreAutoSource: vi.fn(),
  setWorkdirAlias: vi.fn(),
  resetLocalData: vi.fn(),
  resetWithCloud: vi.fn(),
  downloadUpdate: vi.fn(),
  installAndRestartUpdate: vi.fn(),
  downloadInstaller: vi.fn(),
  enforcementStatus: vi.fn().mockResolvedValue({}),
  setWorkdirAlias: vi.fn(),
  onNavigateSection: vi.fn(),
  onTrayRefreshStart: vi.fn(),
  onTrayRefreshDone: vi.fn(),
  onTrayRefreshFailed: vi.fn(),
  onUpdateProgress: vi.fn(),
  onInstallerProgress: vi.fn(),
};

globalThis.window.tokenLeague = mockApi;

// Custom matchers for DOM testing
expect.extend({
  toHaveClass(element, className) {
    const pass = element?.classList?.contains(className) ?? false;
    return {
      pass,
      message: () =>
        pass
          ? `expected element not to have class "${className}"`
          : `expected element to have class "${className}", but it has [${element?.classList?.value ?? ''}]`,
    };
  },
});
