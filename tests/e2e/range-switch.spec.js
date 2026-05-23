// E2E: Range switch — verify different ranges show different data
import { test, expect } from './mock-setup.js';
import { waitForScanComplete, getTokenValue } from './helpers.js';

test.describe('Range Switch', () => {
  test.beforeEach(async ({ page }) => {
    await waitForScanComplete(page);
  });

  async function waitForTotalUpdate(page) {
    await page.waitForFunction(() => {
      const el = document.querySelector('#today-total');
      return el && el.textContent.trim() !== '-' && el.textContent.trim() !== '0';
    }, { timeout: 5_000 });
  }

  test('Today shows only today tokens', async ({ page }) => {
    await page.click('#overview-range [data-range="today"]');
    await expect(page.locator('#overview-range [data-range="today"]')).toHaveClass(/active/);
    await waitForTotalUpdate(page);

    const total = await getTokenValue(page, '#today-total');
    expect(total).toBe(8500);
  });

  test('7d includes today + yesterday', async ({ page }) => {
    await page.click('#overview-range [data-range="7d"]');
    await expect(page.locator('#overview-range [data-range="7d"]')).toHaveClass(/active/);
    await waitForTotalUpdate(page);

    const total = await getTokenValue(page, '#today-total');
    expect(total).toBe(13000);
  });

  test('ALL shows 13000 and is strictly greater than Today 8500', async ({ page }) => {
    await page.click('#overview-range [data-range="all"]');
    await waitForTotalUpdate(page);
    const allVal = await getTokenValue(page, '#today-total');
    expect(allVal).toBe(13000);

    await page.click('#overview-range [data-range="today"]');
    await waitForTotalUpdate(page);
    const todayVal = await getTokenValue(page, '#today-total');
    expect(todayVal).toBe(8500);
    expect(allVal).toBeGreaterThan(todayVal);
  });
});
