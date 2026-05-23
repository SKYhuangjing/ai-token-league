// E2E: Scan → view usage data
import { test, expect } from './mock-setup.js';
import { waitForScanComplete, getTokenValue } from './helpers.js';

test.describe('Scan and View Usage', () => {
  test('overview shows correct token totals after scan', async ({ page }) => {
    await waitForScanComplete(page);

    const total = await getTokenValue(page, '#today-total');
    expect(total).toBe(8500);

    const inputTokens = await getTokenValue(page, '#overview-input-tokens');
    expect(inputTokens).toBe(5000);

    const outputTokens = await getTokenValue(page, '#overview-output-tokens');
    expect(outputTokens).toBe(2000);
  });

  test('today range: provider breakdown shows only today providers', async ({ page }) => {
    await waitForScanComplete(page);

    const providerList = page.locator('#provider-list');
    await expect(providerList.locator('.mini-meter-row').first()).toBeVisible({ timeout: 5_000 });
    // Today has only claude_code (8500); codex data is from yesterday
    expect(await providerList.locator('.mini-meter-row').count()).toBe(1);
    await expect(providerList).toContainText('Claude Code');
    await expect(providerList).toContainText('8.5K');
  });

  test('today range: model breakdown shows only today models', async ({ page }) => {
    await waitForScanComplete(page);

    const modelList = page.locator('#model-list');
    await expect(modelList.locator('.mini-meter-row').first()).toBeVisible({ timeout: 5_000 });
    expect(await modelList.locator('.mini-meter-row').count()).toBe(1);
    await expect(modelList).toContainText('claude-sonnet-4-20250514');
  });

  test('today range: workdir breakdown shows only today workdirs', async ({ page }) => {
    await waitForScanComplete(page);

    const workdirList = page.locator('#workdir-list');
    await expect(workdirList.locator('.mini-meter-row').first()).toBeVisible({ timeout: 5_000 });
    expect(await workdirList.locator('.mini-meter-row').count()).toBe(1);
    await expect(workdirList).toContainText('/test-project');
  });

  test('all range: breakdown shows all providers, models, workdirs', async ({ page }) => {
    await waitForScanComplete(page);

    await page.click('#overview-range [data-range="all"]');
    // Wait for "all" data: total=13000, provider count=2
    await page.waitForFunction(() => {
      const providers = document.querySelectorAll('#provider-list .mini-meter-row');
      return providers.length === 2;
    }, { timeout: 5_000 });

    const providerList = page.locator('#provider-list');
    await expect(providerList.locator('.mini-meter-row').first()).toBeVisible({ timeout: 5_000 });
    expect(await providerList.locator('.mini-meter-row').count()).toBe(2);
    await expect(providerList).toContainText('Claude Code');
    await expect(providerList).toContainText('Codex');

    const modelList = page.locator('#model-list');
    expect(await modelList.locator('.mini-meter-row').count()).toBe(2);

    const workdirList = page.locator('#workdir-list');
    expect(await workdirList.locator('.mini-meter-row').count()).toBe(2);
  });

  test('trend chart renders at least one spark bar for today', async ({ page }) => {
    await waitForScanComplete(page);

    const trendContainer = page.locator('#overview-trend');
    await expect(trendContainer).toBeVisible();

    const bars = trendContainer.locator('.spark-bar');
    const count = await bars.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
