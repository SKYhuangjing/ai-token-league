// E2E: Product workflows — provider toggle, reset, update, backup
import { test, expect } from './mock-setup.js';
import { waitForScanComplete, navigateTo } from './helpers.js';

test.describe('Sources Workflows', () => {
  test.beforeEach(async ({ page }) => {
    await waitForScanComplete(page);
  });

  test('sources screen renders provider cards with toggle switches', async ({ page }) => {
    await navigateTo(page, 'sources');

    const tabs = page.locator('#sources-tabs [data-provider-tab]');
    await expect(tabs.first()).toBeVisible({ timeout: 5_000 });
    expect(await tabs.count()).toBeGreaterThanOrEqual(2);

    await tabs.first().click();

    // Toggle switch exists with correct role and initial state
    const toggle = page.locator('[data-toggle-source]').first();
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    expect(await toggle.getAttribute('role')).toBe('switch');
    const ariaChecked = await toggle.getAttribute('aria-checked');
    expect(['true', 'false']).toContain(ariaChecked);

    // Click toggle — should not crash
    await toggle.click();
    // App stays responsive
    await expect(page.locator('#sources')).toHaveClass(/active/);
  });

  test('sources screen shows source rows for each provider', async ({ page }) => {
    await navigateTo(page, 'sources');

    const tabs = page.locator('#sources-tabs [data-provider-tab]');
    await tabs.first().click();

    const rows = page.locator('[data-root-path], .source-row, .auto-source-row');
    await expect(rows.first()).toBeVisible({ timeout: 5_000 });
    expect(await rows.count()).toBeGreaterThan(0);
  });
});

test.describe('Settings Workflows', () => {
  test.beforeEach(async ({ page }) => {
    await waitForScanComplete(page);
    await navigateTo(page, 'settings');
  });

  async function switchTab(page, tab) {
    await page.click(`[data-settings-tab="${tab}"]`);
    await page.waitForFunction((t) => {
      const panel = document.querySelector(`[data-settings-panel="${t}"]`);
      return panel && panel.classList.contains('active');
    }, tab, { timeout: 5_000 });
  }

  test('cloud panel has update check button', async ({ page }) => {
    await switchTab(page, 'cloud');

    const checkBtn = page.locator('#check-update');
    await expect(checkBtn).toBeVisible({ timeout: 5_000 });

    // Click triggers checkUpdate — should not crash (mock returns null instantly)
    await checkBtn.click();
    // App stays responsive
    await expect(page.locator('#settings')).toHaveClass(/active/);
  });

  test('about panel has reset, backup, and diagnostics controls', async ({ page }) => {
    // #reset-local-data, #restore-local-backup, #clear-local-backups are in "about" panel
    await switchTab(page, 'about');

    // Reset
    const resetBtn = page.locator('#reset-local-data');
    await expect(resetBtn).toBeVisible({ timeout: 5_000 });
    await expect(resetBtn).toBeEnabled();

    // Backup
    const restoreBtn = page.locator('#restore-local-backup');
    const clearBtn = page.locator('#clear-local-backups');
    expect((await restoreBtn.count()) + (await clearBtn.count())).toBeGreaterThanOrEqual(1);
  });

  test('reset button opens confirm dialog', async ({ page }) => {
    await switchTab(page, 'about');

    await page.locator('#reset-local-data').click();
    const modal = page.locator('#reset-confirm-modal, [data-reset-modal], .modal');
    await expect(modal.first()).toBeVisible({ timeout: 3_000 });
  });
});
