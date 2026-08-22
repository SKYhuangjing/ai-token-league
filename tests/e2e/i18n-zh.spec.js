// E2E: zh-CN locale — verify Chinese UI renders correctly
import { test, expect } from './mock-setup-zh.js';
import { waitForScanComplete, getTokenValue, navigateTo } from './helpers.js';

test.describe('i18n zh-CN', () => {
  test.beforeEach(async ({ page }) => {
    await waitForScanComplete(page);
  });

  test('page renders with Chinese locale', async ({ page }) => {
    const lang = await page.getAttribute('html', 'lang');
    expect(lang).toBe('zh-CN');
  });

  test('nav buttons show Chinese text, not raw keys', async ({ page }) => {
    const overviewBtn = page.locator('[data-section="overview"]');
    const text = await overviewBtn.textContent();
    // Must be a real translation, not a raw i18n key
    expect(text).not.toMatch(/^desktop\./);
    expect(text.trim().length).toBeGreaterThan(0);
  });

  test('overview data loads correctly under zh-CN', async ({ page }) => {
    const total = await getTokenValue(page, '#today-total');
    expect(total).toBe(8500);
  });

  test('range labels show Chinese text', async ({ page }) => {
    const todayBtn = page.locator('#overview-range [data-range="today"]');
    const text = await todayBtn.textContent();
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).not.toMatch(/^desktop\./);
  });

  test('sources provider overview shows Chinese copy', async ({ page }) => {
    await navigateTo(page, 'sources');

    // claude_code_local is the default selected healthy provider with usage
    const overview = page.locator('#settings-source-list .provider-overview').first();
    await expect(overview).toBeVisible({ timeout: 5_000 });
    await expect(overview.locator('.provider-overview-title')).toContainText('数据概览');
    await expect(overview.locator('.provider-overview-stats')).toContainText('累计用量');
    await expect(overview.locator('.provider-overview-stats')).toContainText('近 7 天');
    await expect(overview.locator('.provider-overview-stats')).toContainText('覆盖天数');
    await expect(overview.locator('.provider-overview-stats')).toContainText('1 天');
    await expect(overview.locator('.provider-overview-legend')).toContainText('输入');
    await expect(overview.locator('.provider-overview-models')).toContainText('模型用量');
    await expect(overview.locator('.provider-overview-models')).toContainText('最近使用');
  });
});
