// E2E: Sync status rail and settings page across different sync states
import { createSyncFixture, expect } from './mock-setup-sync.js';
import { navigateTo } from './helpers.js';

// 1. No cloud configured → local_only
const noCloudTest = createSyncFixture({
  desktopAutoInitialized: false,
  language: 'en',
});

noCloudTest.describe('Sync Status: no cloud configured', () => {
  noCloudTest('rail shows local_only when no API URL', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    const statusEl = page.locator('#rail-cloud-status');
    await expect(statusEl).toBeVisible();
    await expect(statusEl).toHaveAttribute('data-state', 'local_only');
  });

  noCloudTest('cloud settings focuses configuration instead of duplicating an action', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    await navigateTo(page, 'settings');
    await page.click('#settings-tabs [data-settings-tab="cloud"]');

    const details = page.locator('#cloud-sync-details');
    await expect(details).toBeVisible();
    await expect(page.locator('#cloud-sync-primary-action')).toBeHidden();
    await expect(page.locator('#apiBaseUrl')).toBeVisible();
  });

  noCloudTest('manual refresh stays local and does not request cloud sync', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    await page.click('#brand-refresh');

    await expect.poll(async () => page.evaluate(() => window.__ATL_E2E_STATE__.lastStartUsageScanArgs?.syncAfter)).toBe(false);
    await expect(page.locator('#rail-cloud-status')).toHaveAttribute('data-state', 'local_only');
    await expect.poll(async () => page.evaluate(() => window.__ATL_E2E_STATE__.startUsageSyncCount)).toBe(0);
  });
});

// 2. Cloud configured but never synced → needs_sync
const needsSyncTest = createSyncFixture({
  desktopAutoInitialized: false,
  language: 'en',
  syncConfigured: true,
});

needsSyncTest.describe('Sync Status: needs sync', () => {
  needsSyncTest('rail shows needs_sync when configured but not synced', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    const statusEl = page.locator('#rail-cloud-status');
    await expect(statusEl).toBeVisible();
    await expect(statusEl).toHaveAttribute('data-state', 'needs_sync');
  });

  needsSyncTest('cloud settings shows sync now action', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    await navigateTo(page, 'settings');
    await page.click('#settings-tabs [data-settings-tab="cloud"]');

    await expect(page.locator('#cloud-sync-primary-action')).toBeHidden();
    const syncBtn = page.locator('[data-sync-now]').first();
    await expect(syncBtn).toBeVisible();
    await expect(syncBtn).toContainText(/sync/i);
  });
});

// 2b. API configured but unchecked → checking_connection; sync action checks first
const uncheckedConnectionTest = createSyncFixture({
  desktopAutoInitialized: false,
  language: 'en',
  syncConfigured: true,
  syncConnectionUnchecked: true,
});

uncheckedConnectionTest.describe('Sync Status: unchecked connection', () => {
  uncheckedConnectionTest('boot checks unchecked connection before showing cloud update pending', async ({ page }) => {
    const statusEl = page.locator('#rail-cloud-status');
    await expect.poll(async () => page.evaluate(() => window.__ATL_E2E_STATE__.checkApiCount)).toBeGreaterThan(0);
    await expect(statusEl).toHaveAttribute('data-state', 'needs_sync');
    await expect(statusEl).toHaveAttribute('data-reason', 'never_synced_current_server');
  });

  uncheckedConnectionTest('sync now checks connection before starting scan and sync', async ({ page }) => {
    await navigateTo(page, 'settings');
    await page.click('#settings-tabs [data-settings-tab="cloud"]');
    await page.click('[data-sync-now]');
    await expect(page.locator('#app-confirm-modal')).toBeVisible();
    await page.click('#app-confirm-ok');
    await expect.poll(async () => page.evaluate(() => window.__ATL_E2E_STATE__.checkApiCount)).toBeGreaterThan(0);
    await expect.poll(async () => page.evaluate(() => window.__ATL_E2E_STATE__.startUsageScanCount)).toBeGreaterThan(1);
    await expect.poll(async () => page.evaluate(() => window.__ATL_E2E_STATE__.startUsageSyncCount)).toBeGreaterThan(0);
  });
});

// 3. Successfully synced → synced
const syncedTest = createSyncFixture({
  desktopAutoInitialized: false,
  language: 'en',
  syncConfigured: true,
  syncLastStatus: 'success',
});

syncedTest.describe('Sync Status: synced', () => {
  syncedTest('rail shows synced when last sync was successful', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    const statusEl = page.locator('#rail-cloud-status');
    await expect(statusEl).toBeVisible();
    await expect(statusEl).toHaveAttribute('data-state', 'synced');
  });

  syncedTest('cloud settings shows last sync time', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    await navigateTo(page, 'settings');
    await page.click('#settings-tabs [data-settings-tab="cloud"]');

    const lastSuccess = page.locator('#diag-last-success');
    await expect(lastSuccess).toBeVisible();
    await expect(lastSuccess).not.toHaveText('-');
  });
});

// 3b. Local scan fingerprint changed → manual refresh should automatically sync
const localChangedTest = createSyncFixture({
  desktopAutoInitialized: false,
  language: 'en',
  syncConfigured: true,
  syncLastStatus: 'success',
  syncLastFingerprint: 'fp-old',
  syncLocalFingerprint: 'fp-new',
  syncDelay: 250,
});

localChangedTest.describe('Sync Status: local data changed', () => {
  localChangedTest('manual refresh automatically syncs changed local data', async ({ page }) => {
    const statusEl = page.locator('#rail-cloud-status');
    await expect(statusEl).toHaveAttribute('data-state', 'needs_sync');
    await expect(statusEl).toHaveAttribute('data-reason', 'local_changed_after_sync');

    await page.click('#brand-refresh');
    await expect(statusEl).toHaveAttribute('data-state', 'syncing');
    await expect.poll(async () => page.evaluate(() => window.__ATL_E2E_STATE__.lastStartUsageScanArgs?.syncAfter)).toBe(true);
    await expect.poll(async () => page.evaluate(() => window.__ATL_E2E_STATE__.startUsageSyncCount)).toBeGreaterThan(0);
    await expect(statusEl).not.toHaveAttribute('data-state', 'needs_sync');
    await expect(statusEl).toHaveAttribute('data-state', 'synced', { timeout: 5000 });
  });

  localChangedTest('clicking cloud update pending status refreshes and syncs', async ({ page }) => {
    const statusEl = page.locator('#rail-cloud-status');
    await expect(statusEl).toHaveAttribute('data-state', 'needs_sync');
    await expect(page.locator('#rail-last-scan')).toContainText('refresh to sync to cloud');

    await statusEl.click();
    await expect(statusEl).toHaveAttribute('data-state', 'syncing');
    await expect.poll(async () => page.evaluate(() => window.__ATL_E2E_STATE__.lastStartUsageScanArgs?.syncAfter)).toBe(true);
    await expect.poll(async () => page.evaluate(() => window.__ATL_E2E_STATE__.startUsageSyncCount)).toBeGreaterThan(0);
    await expect(statusEl).toHaveAttribute('data-state', 'synced', { timeout: 5000 });
  });
});

// 4. Last sync failed → attention
const failedTest = createSyncFixture({
  desktopAutoInitialized: false,
  language: 'en',
  syncConfigured: true,
  syncLastStatus: 'failed',
  syncLastError: 'connection refused',
});

failedTest.describe('Sync Status: last failed', () => {
  failedTest('rail shows attention when last sync failed', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    const statusEl = page.locator('#rail-cloud-status');
    await expect(statusEl).toBeVisible();
    await expect(statusEl).toHaveAttribute('data-state', 'attention');
  });

  failedTest('cloud settings shows retry sync action', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    await navigateTo(page, 'settings');
    await page.click('#settings-tabs [data-settings-tab="cloud"]');

    await expect(page.locator('#cloud-sync-primary-action')).toBeHidden();
    await expect(page.locator('[data-sync-now]').first()).toBeVisible();
  });
});

// 5. Queue pending → attention / queued_retry
const queueTest = createSyncFixture({
  desktopAutoInitialized: false,
  language: 'en',
  syncConfigured: true,
  syncLastStatus: 'success',
  syncQueuePending: 3,
});

queueTest.describe('Sync Status: queue pending', () => {
  queueTest('rail shows attention with queued_retry reason', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    const statusEl = page.locator('#rail-cloud-status');
    await expect(statusEl).toBeVisible();
    await expect(statusEl).toHaveAttribute('data-state', 'attention');
    await expect(statusEl).toHaveAttribute('data-reason', 'queued_retry');
  });

  queueTest('cloud settings shows retry sync action', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    await navigateTo(page, 'settings');
    await page.click('#settings-tabs [data-settings-tab="cloud"]');

    await expect(page.locator('#cloud-sync-primary-action')).toBeHidden();
    await expect(page.locator('[data-sync-now]').first()).toBeVisible();
  });
});

// 6. Cloud unreachable → attention / cloud_unreachable
const unreachableTest = createSyncFixture({
  desktopAutoInitialized: false,
  language: 'en',
  syncConfigured: true,
  syncCloudUnreachable: true,
});

unreachableTest.describe('Sync Status: cloud unreachable', () => {
  unreachableTest('rail shows attention when cloud unreachable', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    const statusEl = page.locator('#rail-cloud-status');
    await expect(statusEl).toBeVisible();
    await expect(statusEl).toHaveAttribute('data-state', 'attention');
    await expect(statusEl).toHaveAttribute('data-reason', 'cloud_unreachable');
  });

  unreachableTest('cloud settings shows check connection action', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    await navigateTo(page, 'settings');
    await page.click('#settings-tabs [data-settings-tab="cloud"]');

    const actionBtn = page.locator('#cloud-sync-primary-action');
    await expect(actionBtn).toBeVisible();
    await expect(actionBtn).toContainText(/check/i);
  });
});

// 7. Previously connected server is offline on app restart → attention, not cloud pending
const offlineRestartTest = createSyncFixture({
  desktopAutoInitialized: false,
  language: 'en',
  syncConfigured: true,
  syncLastStatus: 'success',
  syncLastFingerprint: 'fp-old',
  syncLocalFingerprint: 'fp-new',
  apiError: true,
});

offlineRestartTest.describe('Sync Status: offline restart', () => {
  offlineRestartTest('boot checks stale connection before showing cloud pending', async ({ page }) => {
    const statusEl = page.locator('#rail-cloud-status');
    await expect.poll(async () => page.evaluate(() => window.__ATL_E2E_STATE__.checkApiCount)).toBeGreaterThan(0);
    await expect(statusEl).toHaveAttribute('data-state', 'attention', { timeout: 10000 });
    await expect(statusEl).toHaveAttribute('data-reason', 'cloud_unreachable');
    await expect(statusEl).not.toHaveAttribute('data-state', 'needs_sync');
  });
});

// 8. Cloud incompatible → attention / cloud_incompatible
const incompatibleTest = createSyncFixture({
  desktopAutoInitialized: false,
  language: 'en',
  syncConfigured: true,
  syncCloudIncompatible: true,
});

incompatibleTest.describe('Sync Status: cloud incompatible', () => {
  incompatibleTest('rail shows attention when cloud incompatible', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    const statusEl = page.locator('#rail-cloud-status');
    await expect(statusEl).toBeVisible();
    await expect(statusEl).toHaveAttribute('data-state', 'attention');
    await expect(statusEl).toHaveAttribute('data-reason', 'cloud_incompatible');
  });

  incompatibleTest('cloud settings shows update client action', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    await navigateTo(page, 'settings');
    await page.click('#settings-tabs [data-settings-tab="cloud"]');

    const actionBtn = page.locator('#cloud-sync-primary-action');
    await expect(actionBtn).toBeVisible();
    await expect(actionBtn).toContainText(/update/i);
  });

  incompatibleTest('update client action starts the update flow', async ({ page }) => {
    await navigateTo(page, 'settings');
    await page.click('#settings-tabs [data-settings-tab="cloud"]');
    await page.click('#cloud-sync-primary-action');
    await expect.poll(async () => page.evaluate(() => window.__ATL_E2E_STATE__.checkUpdateCount)).toBeGreaterThan(0);
  });
});
