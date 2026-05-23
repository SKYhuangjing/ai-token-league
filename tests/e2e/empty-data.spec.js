// E2E: Empty data — verify app handles zero usage gracefully
import { test, expect } from './mock-setup-empty.js';

test.describe('Empty Data', () => {
  test('overview shows placeholder when no usage data', async ({ page }) => {
    // Wait for app to finish loading (scan completes with 0 items)
    await page.waitForFunction(() => {
      const el = document.querySelector('#today-total');
      return el !== null;
    }, { timeout: 10_000 });

    const text = await page.textContent('#today-total');
    // Should show placeholder, not crash
    expect(text.trim()).toMatch(/^-|0$/);
  });

  test('no providers, models, or workdirs listed', async ({ page }) => {
    await page.waitForFunction(() => {
      const el = document.querySelector('#today-total');
      return el !== null;
    }, { timeout: 10_000 });

    const providers = await page.locator('#provider-list .mini-meter-row').count();
    expect(providers).toBe(0);

    const models = await page.locator('#model-list .mini-meter-row').count();
    expect(models).toBe(0);

    const workdirs = await page.locator('#workdir-list .mini-meter-row').count();
    expect(workdirs).toBe(0);
  });

  test('app remains navigable with no data', async ({ page }) => {
    await page.waitForFunction(() => {
      const el = document.querySelector('#today-total');
      return el !== null;
    }, { timeout: 10_000 });

    // Navigate to each section without crash
    for (const section of ['workdirs', 'sources', 'settings']) {
      await page.click(`[data-section="${section}"]`);
      await page.waitForSelector(`#${section}.screen.active`, { timeout: 5_000 });
    }

    // Navigate back to overview
    await page.click('[data-section="overview"]');
    await page.waitForSelector('#overview.screen.active', { timeout: 5_000 });
  });
});
