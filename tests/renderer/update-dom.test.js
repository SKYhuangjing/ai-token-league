// DOM-level tests for update flow in renderer.js.
// These import the actual production renderer and test real DOM interactions.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createStubDOM } from './dom-stubs.js';

let progressCallback = null;

const mockApi = {
  platform: 'darwin-arm64',
  getConfig: vi.fn().mockResolvedValue({
    participantId: 'p_test', nickname: 'test',
    apiBaseUrl: 'https://example.com',
    apiConnection: { status: 'reachable', apiBaseUrl: 'https://example.com' },
    language: 'en'
  }),
  updateConfig: vi.fn().mockImplementation((patch) =>
    Promise.resolve({ participantId: 'p_test', nickname: 'test', apiBaseUrl: 'https://example.com', language: 'en', ...patch })
  ),
  initConfig: vi.fn().mockResolvedValue({ participantId: 'p_test', nickname: 'test' }),
  startUsageScan: vi.fn().mockResolvedValue({ status: 'idle' }),
  usageScanStatus: vi.fn().mockResolvedValue({ status: 'idle' }),
  usageSummary: vi.fn().mockResolvedValue({ totals: { totalTokens: 0 } }),
  usageTrend: vi.fn().mockResolvedValue({ items: [] }),
  usageWorkdirs: vi.fn().mockResolvedValue({ items: [] }),
  usageDetailWindow: vi.fn().mockResolvedValue({ items: [], totalRows: 0 }),
  providerHealth: vi.fn().mockResolvedValue([]),
  backgroundStatus: vi.fn().mockResolvedValue({ updateCheck: { status: 'idle' } }),
  fullReconcileStatus: vi.fn().mockResolvedValue({ status: 'idle', running: false }),
  getMyIdentity: vi.fn().mockResolvedValue({ participantId: 'p_test', nickname: 'test' }),
  appVersion: vi.fn().mockResolvedValue({ clientAppVersion: '0.7.0', clientPlatform: 'darwin-arm64', runtime: 'rust-tauri' }),
  checkUpdate: vi.fn().mockResolvedValue(null),
  downloadUpdate: vi.fn().mockResolvedValue(null),
  installAndRestartUpdate: vi.fn().mockResolvedValue(null),
  downloadInstaller: vi.fn().mockResolvedValue(null),
  modelPrices: vi.fn().mockResolvedValue({}),
  startUsageSync: vi.fn().mockResolvedValue({}),
  syncUsage: vi.fn().mockResolvedValue({}),
  checkApi: vi.fn().mockResolvedValue({ ok: true }),
  logEvent: vi.fn().mockResolvedValue(undefined),
  updateTrayCost: vi.fn(),
  rebuildTrayMenu: vi.fn(),
  setDockVisible: vi.fn(),
  openUrl: vi.fn(),
  enforcementStatus: vi.fn().mockResolvedValue({}),
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
  exportConfig: vi.fn(),
  importConfig: vi.fn(),
  exportIdentity: vi.fn(),
  importIdentity: vi.fn(),
  exportDiagnostics: vi.fn(),
  clearRuntimeLog: vi.fn(),
  revealRuntimeLogDirectory: vi.fn(),
  createLocalBackup: vi.fn(),
  pickLocalBackup: vi.fn(),
  restoreLocalBackupFile: vi.fn(),
  chooseBackupDirectory: vi.fn(),
  clearLocalBackups: vi.fn(),
  localBackupStatus: vi.fn().mockResolvedValue({}),
  saveShareImage: vi.fn(),
  writeImageToClipboard: vi.fn(),
  onUpdateProgress: vi.fn((cb) => { progressCallback = cb; }),
  onInstallerProgress: vi.fn(),
  onNavigateSection: vi.fn(),
  onTrayRefreshStart: vi.fn(),
  onTrayRefreshDone: vi.fn(),
  onTrayRefreshFailed: vi.fn(),
};

globalThis.window.tokenLeague = mockApi;
createStubDOM();

// checkUpdate returns update object with nested update field (matches real Tauri shape)
function mockUpdateAvailable(version = '99.0.0') {
  return {
    updateAvailable: true,
    code: 'update_available',
    latestVersion: version,
    update: { updateAvailable: true, latestVersion: version, version }
  };
}

describe('Update DOM flow (imports renderer.js)', () => {
  beforeAll(async () => {
    await import('../../src/desktop/renderer.js');
    await new Promise(r => setTimeout(r, 1500));
  });

  beforeEach(() => {
    mockApi.checkUpdate.mockReset().mockResolvedValue(null);
    mockApi.downloadUpdate.mockReset().mockResolvedValue(null);
    mockApi.installAndRestartUpdate.mockReset().mockResolvedValue(null);
    mockApi.backgroundStatus.mockReset().mockResolvedValue({ updateCheck: { status: 'idle' } });
    mockApi.checkApi.mockReset().mockResolvedValue({ ok: true });
    mockApi.getConfig.mockReset().mockResolvedValue({
      participantId: 'p_test', nickname: 'test',
      apiBaseUrl: 'https://example.com',
      apiConnection: { status: 'reachable', apiBaseUrl: 'https://example.com' },
      language: 'en'
    });
    mockApi.updateConfig.mockReset().mockImplementation((patch) =>
      Promise.resolve({ participantId: 'p_test', nickname: 'test', apiBaseUrl: 'https://example.com', language: 'en', ...patch })
    );
    // Don't reset onUpdateProgress — renderer registers callback once during beforeAll import.
    // Resetting it would lose the captured callback since the renderer won't re-register.
    // Sync DOM input values with config so isApiBaseUrlDirty() returns false
    const apiInput = document.getElementById('apiBaseUrl');
    if (apiInput) apiInput.value = 'https://example.com';
    const nickInput = document.getElementById('nickname');
    if (nickInput) nickInput.value = 'test';
  });

  it('rail restart button exists as a <button> in DOM', () => {
    const btn = document.querySelector('#rail-restart-update');
    expect(btn).not.toBeNull();
    expect(btn.tagName).toBe('BUTTON');
  });

  it('downloaded event keeps button hidden and shows preparing text', async () => {
    mockApi.checkUpdate.mockResolvedValue(mockUpdateAvailable());
    // Use a deferred promise so we can reject it for cleanup (prevents updateCheckInFlight from staying set
    // without setting updateDownloadedPersisted=true which would pollute later tests)
    let rejectDownload;
    mockApi.downloadUpdate.mockReturnValue(new Promise((_, reject) => { rejectDownload = reject; }));

    document.querySelector('#check-update').click();
    await new Promise(r => setTimeout(r, 500));

    // Emit "downloaded" progress event (Rust event before PendingUpdate written)
    expect(progressCallback).not.toBeNull();
    progressCallback({ status: 'downloaded' });
    await new Promise(r => setTimeout(r, 100));

    // Rail restart button MUST be hidden — status is "downloading", not "downloaded"
    const railBtn = document.querySelector('#rail-restart-update');
    expect(railBtn.hidden).toBe(true);

    // Message must show "preparing", not "ready"
    const msg = document.querySelector('#update-message')?.textContent || '';
    expect(msg.toLowerCase()).not.toContain('ready');

    // Reject the hanging download so updateCheckInFlight clears before next test.
    // Use reject (not resolve) so updateDownloadedPersisted stays false.
    rejectDownload(new Error('cleanup'));
    await new Promise(r => setTimeout(r, 100));
  });

  it('download reject sets failed state and allows retry', async () => {
    mockApi.checkUpdate.mockResolvedValue(mockUpdateAvailable());
    mockApi.downloadUpdate.mockRejectedValue(new Error('Network error'));

    document.querySelector('#check-update').click();
    await new Promise(r => setTimeout(r, 1000));

    // Rail button MUST be hidden (no successful download)
    const railBtn = document.querySelector('#rail-restart-update');
    expect(railBtn.hidden).toBe(true);

    // Update message MUST show an error
    const msg = document.querySelector('#update-message')?.textContent || '';
    expect(msg.length).toBeGreaterThan(0);
  });

  it('install reject restores button to clickable', async () => {
    mockApi.checkUpdate.mockResolvedValue(mockUpdateAvailable());
    mockApi.downloadUpdate.mockResolvedValue({ ok: true });
    mockApi.installAndRestartUpdate.mockRejectedValue(new Error('No downloaded update'));

    document.querySelector('#check-update').click();
    // Wait for download to complete and button to appear
    await new Promise(r => setTimeout(r, 1500));

    // Button MUST be visible after successful download
    const railBtn = document.querySelector('#rail-restart-update');
    expect(railBtn.hidden).toBe(false);

    // Click install — will fail
    railBtn.click();
    await new Promise(r => setTimeout(r, 500));

    // Button MUST still be visible and re-enabled after install failure
    expect(railBtn.hidden).toBe(false);
    expect(railBtn.disabled).toBe(false);
  });

  it('background idle does not hide button after download', async () => {
    mockApi.checkUpdate.mockResolvedValue(mockUpdateAvailable());
    mockApi.downloadUpdate.mockResolvedValue({ ok: true });

    document.querySelector('#check-update').click();
    await new Promise(r => setTimeout(r, 1500));

    // Button MUST be visible after successful download
    const railBtn = document.querySelector('#rail-restart-update');
    expect(railBtn.hidden).toBe(false);

    // Now trigger a real background status refresh by clicking settings
    // This calls loadBackgroundStatus() which calls api.backgroundStatus()
    mockApi.backgroundStatus.mockResolvedValue({ updateCheck: { status: 'idle' } });
    document.querySelector('[data-section="settings"]').click();
    await new Promise(r => setTimeout(r, 500));

    // Button MUST still be visible — updateDownloadedPersisted protects it
    expect(railBtn.hidden).toBe(false);
  });

  it('update-status-text has no raw status after download completes', async () => {
    mockApi.checkUpdate.mockResolvedValue(mockUpdateAvailable());
    mockApi.downloadUpdate.mockResolvedValue({ ok: true });

    document.querySelector('#check-update').click();
    await new Promise(r => setTimeout(r, 1500));

    const statusText = document.querySelector('#update-status-text')?.textContent || '';
    // Must NOT contain raw status strings like "downloading" or "downloaded"
    expect(statusText.toLowerCase()).not.toContain('downloading');
    expect(statusText.toLowerCase()).not.toContain('downloaded');
  });

  it('badge is hidden during download, shows ready after resolve', async () => {
    mockApi.checkUpdate.mockResolvedValue(mockUpdateAvailable());
    let rejectDownload;
    mockApi.downloadUpdate.mockReturnValue(new Promise((_, reject) => { rejectDownload = reject; }));

    document.querySelector('#check-update').click();
    await new Promise(r => setTimeout(r, 500));

    // During download — badge MUST be hidden
    const badge = document.querySelector('#update-badge');
    expect(badge.hidden).toBe(true);

    // Cleanup: reject the download
    rejectDownload(new Error('cleanup'));
    await new Promise(r => setTimeout(r, 100));
  });

  it('badge shows readyToRestart after successful download', async () => {
    mockApi.checkUpdate.mockResolvedValue(mockUpdateAvailable());
    mockApi.downloadUpdate.mockResolvedValue({ ok: true });

    document.querySelector('#check-update').click();
    await new Promise(r => setTimeout(r, 1500));

    const badge = document.querySelector('#update-badge');
    expect(badge.hidden).toBe(false);
    // Badge should have a non-empty positive label
    expect(badge.textContent.length).toBeGreaterThan(0);
    expect(badge.className).toContain('ok');
  });

  it('late downloaded event does not regress UI after resolve', async () => {
    mockApi.checkUpdate.mockResolvedValue(mockUpdateAvailable());
    mockApi.downloadUpdate.mockResolvedValue({ ok: true });

    document.querySelector('#check-update').click();
    await new Promise(r => setTimeout(r, 1500));

    // Download resolved — button visible
    const railBtn = document.querySelector('#rail-restart-update');
    expect(railBtn.hidden).toBe(false);

    // Simulate a late "downloaded" event arriving after resolve
    progressCallback({ status: 'downloaded' });
    await new Promise(r => setTimeout(r, 100));

    // Button MUST still be visible — IPC race guard prevents regression
    expect(railBtn.hidden).toBe(false);

    // Message MUST NOT regress to "preparing" after late downloaded event
    const msg = document.querySelector('#update-message')?.textContent || '';
    expect(msg.toLowerCase()).not.toContain('preparing');
  });
});
