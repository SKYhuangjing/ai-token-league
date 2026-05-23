// E2E: Async scan — verify running → done transition and concurrent scan handling
import { test, expect } from './mock-setup-async-scan.js';

test.describe('Async Scan', () => {
  test('data appears after async scan completes', async ({ page }) => {
    // With scanDelay=500, data should appear within a few seconds
    await page.waitForFunction(() => {
      const el = document.querySelector('#today-total');
      return el && el.textContent.trim() !== '-' && el.textContent.trim() !== '0';
    }, { timeout: 10_000 });

    const text = await page.textContent('#today-total');
    expect(text.trim()).not.toBe('-');
  });

  test('rapid refresh during running scan returns running state, does not crash', async ({ page }) => {
    // Wait for initial scan to complete
    await page.waitForFunction(() => {
      const el = document.querySelector('#today-total');
      return el && el.textContent.trim() !== '-' && el.textContent.trim() !== '0';
    }, { timeout: 10_000 });

    // Override startUsageScan to introduce a long delay on next call,
    // so we can test the "already running" path
    await page.evaluate(() => {
      // Reset scan state to running via a long delay
      window.__ATL_FORCE_SCAN_RUNNING = true;
      const orig = window.tokenLeague.startUsageScan;
      window.tokenLeague.startUsageScan = () => {
        // First call after force: return running for 2 seconds
        if (window.__ATL_FORCE_SCAN_RUNNING) {
          window.__ATL_FORCE_SCAN_RUNNING = false;
          const result = { running: true, done: false, snapshot: null, taskId: 'mock-forced' };
          setTimeout(() => {
            window.__ATL_SCAN_DONE = true;
          }, 2000);
          return Promise.resolve(result);
        }
        return orig();
      };
    });

    // Click refresh — triggers running state
    await page.click('#brand-refresh');

    // Immediately click refresh again while "running" — should not crash
    await page.click('#brand-refresh');

    // App should still be responsive
    await page.waitForFunction(() => {
      return document.querySelector('#overview.screen.active') !== null;
    }, { timeout: 3_000 });

    // Clean up — let scan finish
    await page.evaluate(() => {
      window.__ATL_FORCE_SCAN_RUNNING = false;
      window.tokenLeague.startUsageScan = window.tokenLeague.startUsageScan;
    });

    // Click refresh one more time to get clean state
    await page.click('#brand-refresh');
    await page.waitForFunction(() => {
      const el = document.querySelector('#today-total');
      return el && el.textContent.trim() !== '-' && el.textContent.trim() !== '0';
    }, { timeout: 10_000 });

    const text = await page.textContent('#today-total');
    expect(text.trim()).not.toBe('-');
  });
});
