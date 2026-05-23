// E2E: Workdir detail drawer interaction
import { test, expect } from './mock-setup.js';
import { waitForScanComplete, navigateTo } from './helpers.js';

test.describe('Workdir Alias', () => {
  test.beforeEach(async ({ page }) => {
    await waitForScanComplete(page);
  });

  test('workdir cards exist and open detail drawer', async ({ page }) => {
    await navigateTo(page, 'workdirs');

    const cards = page.locator('[data-open-workdir]');
    // Mock data has 2 workdirs — cards must exist
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);

    // Click first card → drawer opens
    await cards.first().click();
    const drawer = page.locator('#trend-drawer');
    await expect(drawer).toHaveClass(/is-open/, { timeout: 3_000 });

    // Drawer should contain workdir name
    const firstWorkdir = await cards.first().getAttribute('data-open-workdir');
    expect(firstWorkdir).toBeTruthy();

    // Close via button
    await page.click('#close-trend-drawer');
    await expect(drawer).not.toHaveClass(/is-open/, { timeout: 3_000 });
  });

  test('escape key closes drawer', async ({ page }) => {
    await navigateTo(page, 'workdirs');

    const cards = page.locator('[data-open-workdir]');
    expect(await cards.count()).toBeGreaterThan(0);

    await cards.first().click();
    await expect(page.locator('#trend-drawer')).toHaveClass(/is-open/, { timeout: 3_000 });

    await page.keyboard.press('Escape');
    await expect(page.locator('#trend-drawer')).not.toHaveClass(/is-open/, { timeout: 3_000 });
  });
});
