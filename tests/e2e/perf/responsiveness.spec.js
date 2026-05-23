// E2E: Performance and stability — verify responsiveness under interaction
import { test, expect } from '../mock-setup.js';
import { waitForScanComplete } from '../helpers.js';

test.describe('Stability', () => {
  test('app renders overview without errors after boot', async ({ page }) => {
    await page.waitForSelector('#overview.screen.active', { timeout: 10_000 });
    await expect(page.locator('#today-total')).toBeVisible();
    // Should have actual data (not placeholder)
    const text = await page.textContent('#today-total');
    expect(text.trim()).not.toBe('-');
    expect(text.trim()).not.toBe('0');
  });

  test('repeated range switches do not crash the app', async ({ page }) => {
    await waitForScanComplete(page);

    for (let i = 0; i < 5; i++) {
      await page.click('#overview-range [data-range="7d"]');
      await page.click('#overview-range [data-range="today"]');
    }

    // App should still be functional
    await expect(page.locator('#overview')).toHaveClass(/active/);
    const text = await page.textContent('#today-total');
    expect(text.trim()).not.toBe('-');
  });

  test('manual refresh triggers re-scan and updates data', async ({ page }) => {
    await waitForScanComplete(page);

    const textBefore = await page.textContent('#today-total');

    // Click refresh
    await page.click('#brand-refresh');
    // Wait for scan to complete again
    await page.waitForFunction(() => {
      const el = document.querySelector('#today-total');
      return el && el.textContent.trim() !== '-';
    }, { timeout: 5_000 });

    const textAfter = await page.textContent('#today-total');
    // Data should still be present (same mock data)
    expect(textAfter.trim()).not.toBe('-');
    expect(textAfter).toBe(textBefore);
  });
});

test.describe('Performance Budgets', () => {
  test('overview renders within time budget after data load', async ({ page }) => {
    const start = Date.now();
    await waitForScanComplete(page);
    const elapsed = Date.now() - start;

    // Mock data is small — boot-to-data should be fast
    expect(elapsed).toBeLessThan(5_000);
  });

  test('range switch completes within time budget', async ({ page }) => {
    await waitForScanComplete(page);

    const timings = [];
    for (let i = 0; i < 3; i++) {
      // Switch to "all" — wait for total to become 13000 (today 8500 + yesterday 4500)
      const start = Date.now();
      await page.click('#overview-range [data-range="all"]');
      await page.waitForFunction(() => {
        const el = document.querySelector('#today-total');
        if (!el) return false;
        const text = el.textContent.trim();
        if (text.includes('K')) return Math.round(parseFloat(text) * 1000) === 13000;
        return parseInt(text, 10) === 13000;
      }, { timeout: 5_000 });
      timings.push(Date.now() - start);

      // Switch back to "today" — wait for total to become 8500
      const start2 = Date.now();
      await page.click('#overview-range [data-range="today"]');
      await page.waitForFunction(() => {
        const el = document.querySelector('#today-total');
        if (!el) return false;
        const text = el.textContent.trim();
        if (text.includes('K')) return Math.round(parseFloat(text) * 1000) === 8500;
        return parseInt(text, 10) === 8500;
      }, { timeout: 5_000 });
      timings.push(Date.now() - start2);
    }

    // Each range switch should complete within 2s
    const maxTime = Math.max(...timings);
    expect(maxTime).toBeLessThan(2_000);
  });
});
