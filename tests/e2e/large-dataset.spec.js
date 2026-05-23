// E2E: Large dataset — verify app handles 1000+ usage rows
import { test, expect } from './mock-setup-large.js';

test.describe('Large Dataset', () => {
  test('overview renders within time budget with 1000 rows', async ({ page }) => {
    const start = Date.now();
    await page.waitForFunction(() => {
      const el = document.querySelector('#today-total');
      return el && el.textContent.trim() !== '-' && el.textContent.trim() !== '0';
    }, { timeout: 30_000 });
    const elapsed = Date.now() - start;

    // 1000 rows should still render within 10s
    expect(elapsed).toBeLessThan(10_000);

    const text = await page.textContent('#today-total');
    expect(text.trim()).not.toBe('-');
    expect(text.trim()).not.toBe('0');
  });

  test('range switch to all completes within budget', async ({ page }) => {
    await page.waitForFunction(() => {
      const el = document.querySelector('#today-total');
      return el && el.textContent.trim() !== '-' && el.textContent.trim() !== '0';
    }, { timeout: 30_000 });

    const start = Date.now();
    await page.click('#overview-range [data-range="all"]');
    await page.waitForFunction(() => {
      const el = document.querySelector('#today-total');
      return el && el.textContent.trim() !== '-' && el.textContent.trim() !== '0';
    }, { timeout: 10_000 });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5_000);
  });

  test('workdir list shows entries without crash', async ({ page }) => {
    await page.waitForFunction(() => {
      const el = document.querySelector('#today-total');
      return el && el.textContent.trim() !== '-' && el.textContent.trim() !== '0';
    }, { timeout: 30_000 });

    // Navigate to workdirs
    await page.click('[data-section="workdirs"]');
    await page.waitForSelector('#workdirs.screen.active', { timeout: 5_000 });

    const cards = page.locator('[data-open-workdir]');
    const count = await cards.count();
    // Multiple workdirs from the generated data
    expect(count).toBeGreaterThan(0);
  });
});
