// E2E: Navigation between screens — verify target screen content
import { test, expect } from './mock-setup.js';
import { waitForScanComplete, navigateTo } from './helpers.js';

test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await waitForScanComplete(page);
  });

  test('navigate to Workdirs screen shows workdir cards', async ({ page }) => {
    await navigateTo(page, 'workdirs');

    await expect(page.locator('#workdirs')).toHaveClass(/active/);
    // Workdir analysis list should contain cards from mock data
    const cards = page.locator('[data-open-workdir]');
    await expect(cards.first()).toBeVisible({ timeout: 5_000 });
    expect(await cards.count()).toBeGreaterThan(0);
  });

  test('navigate to Sources screen shows provider tabs', async ({ page }) => {
    await navigateTo(page, 'sources');

    await expect(page.locator('#sources')).toHaveClass(/active/);
    // Sources tabs should list providers from mock health data
    const tabs = page.locator('#sources-tabs [data-provider-tab]');
    await expect(tabs.first()).toBeVisible({ timeout: 5_000 });
    // At least claude_code_local and codex_local
    expect(await tabs.count()).toBeGreaterThanOrEqual(2);
  });

  test('navigate to Settings screen shows nickname with config value', async ({ page }) => {
    await navigateTo(page, 'settings');

    await expect(page.locator('#settings')).toHaveClass(/active/);
    const nickname = page.locator('#nickname');
    await expect(nickname).toBeVisible();
    // Should be pre-populated from mock config
    expect(await nickname.inputValue()).toBe('Test User');
  });

  test('navigate away and back preserves overview data', async ({ page }) => {
    // Record overview total
    const totalBefore = await page.textContent('#today-total');

    await navigateTo(page, 'settings');
    await navigateTo(page, 'overview');

    await expect(page.locator('#overview')).toHaveClass(/active/);
    const totalAfter = await page.textContent('#today-total');
    expect(totalAfter).toBe(totalBefore);
  });
});
