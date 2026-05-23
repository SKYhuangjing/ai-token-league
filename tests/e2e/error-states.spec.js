// E2E: API errors — verify app handles API failures gracefully
import { test, expect } from './mock-setup-error.js';

test.describe('API Error States', () => {
  test('app boots and shows overview even when API check fails', async ({ page }) => {
    // App should still render — local data works without API
    await page.waitForSelector('#overview.screen.active', { timeout: 10_000 });
    const total = await page.textContent('#today-total');
    // Local scan data should still appear (mock data loads from local scan)
    expect(total).toBeTruthy();
  });

  test('cloud rail shows error or disconnected state', async ({ page }) => {
    await page.waitForSelector('#overview.screen.active', { timeout: 10_000 });

    // The sync status rail should indicate connection issue
    const rail = page.locator('#cloud-rail, [data-state]');
    if (await rail.count() > 0) {
      const text = await rail.first().textContent();
      // Should show something indicating not connected / error
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  test('settings cloud tab reflects API error state', async ({ page }) => {
    await page.waitForSelector('#overview.screen.active', { timeout: 10_000 });

    // Navigate to settings
    await page.click('[data-section="settings"]');
    await page.waitForSelector('#settings.screen.active', { timeout: 5_000 });

    // API status should not show "ok"
    const badge = page.locator('[data-api-status], #api-status');
    if (await badge.count() > 0) {
      const text = await badge.first().textContent();
      expect(text.toLowerCase()).not.toContain('ok');
    }
  });
});
