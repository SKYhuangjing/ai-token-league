// E2E: Query-surface cache — pure range switches must not re-issue usage
// queries, and a fresh snapshot must invalidate every range entry (per-entry
// generation check; a global stamp used to pin pre-scan numbers on ranges
// visited before the scan — live-caught on the installed app).
import { test, expect } from './mock-setup.js';
import { waitForScanComplete } from './helpers.js';

test.describe('Usage query cache', () => {
  test.beforeEach(async ({ page }) => {
    await waitForScanComplete(page);
  });

  async function counts(page) {
    return page.evaluate(() => window.__ATL_E2E_STATE__.usageQueryCounts);
  }

  async function resetCounts(page) {
    await page.evaluate(() => window.__ATL_E2E_STATE__.resetUsageQueryCounts());
  }

  async function settleQueries(page) {
    // One macrotask round for the refresh burst to finish and re-render.
    await page.waitForTimeout(150);
  }

  test('pure range switch reuses cached surfaces (no refetch)', async ({ page }) => {
    // First visits fetch each range.
    await page.click('#overview-range [data-range="7d"]');
    await settleQueries(page);
    const afterFirst = await counts(page);
    expect(afterFirst.summary['7d'] || 0).toBeGreaterThanOrEqual(1);

    await page.click('#overview-range [data-range="30d"]');
    await settleQueries(page);
    expect((await counts(page)).summary['30d'] || 0).toBeGreaterThanOrEqual(1);

    // Pure switch back to an already-fetched range: zero new queries.
    await resetCounts(page);
    await page.click('#overview-range [data-range="7d"]');
    await settleQueries(page);
    await page.click('#overview-range [data-range="today"]');
    await settleQueries(page);
    const pure = await counts(page);
    expect(pure.summary['7d'] || 0).toBe(0);
    expect(pure.trend['7d|day'] || 0).toBe(0);
    expect(pure.workdirs['today'] || 0).toBe(0);
    expect(pure.workdirs['all'] || 0).toBe(0);
  });

  test('fresh snapshot invalidates every cached range entry', async ({ page }) => {
    await page.click('#overview-range [data-range="7d"]');
    await settleQueries(page);
    expect((await counts(page)).summary['7d'] || 0).toBeGreaterThanOrEqual(1);

    // New scan lands a fresh snapshot (bumps the data generation).
    await page.click('#overview-range [data-range="today"]');
    await settleQueries(page);
    await page.click('#brand-refresh');
    await waitForScanComplete(page);
    await settleQueries(page);

    // The 7d entry predates the new snapshot: switching to it must refetch.
    await resetCounts(page);
    await page.click('#overview-range [data-range="7d"]');
    await settleQueries(page);
    const afterScan = await counts(page);
    expect(afterScan.summary['7d'] || 0).toBeGreaterThanOrEqual(1);

    // And it stays quiet again while the generation is unchanged.
    await resetCounts(page);
    await page.click('#overview-range [data-range="today"]');
    await settleQueries(page);
    await page.click('#overview-range [data-range="7d"]');
    await settleQueries(page);
    const quiet = await counts(page);
    expect(quiet.summary['7d'] || 0).toBe(0);
  });
});
