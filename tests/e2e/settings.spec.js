// E2E: Settings editing and saving
import { test, expect } from './mock-setup.js';
import { waitForScanComplete, navigateTo } from './helpers.js';

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await waitForScanComplete(page);
    await navigateTo(page, 'settings');
  });

  test('edit nickname → dirty state → save clears it', async ({ page }) => {
    const input = page.locator('#nickname');
    await expect(input).toBeVisible();
    expect(await input.inputValue()).toBe('Test User');

    await input.clear();
    await input.fill('updated-name');
    expect(await input.inputValue()).toBe('updated-name');

    // Dirty state appears
    const saveBtn = page.locator('#settings .primary-pill').first();
    await expect(saveBtn).toHaveClass(/has-unsaved/);

    // Click Save — mock updateConfig is no-op but renderer clears dirty state
    await saveBtn.click();
    await expect(saveBtn).not.toHaveClass(/has-unsaved/);
  });

  test('settings tabs show correct panels', async ({ page }) => {
    // Default: App tab is active
    await expect(page.locator('section[data-settings-panel="app"]')).toBeVisible();
    await expect(page.locator('section[data-settings-panel="cloud"]')).not.toBeVisible();

    // Switch to Cloud
    await page.click('#settings-tabs [data-settings-tab="cloud"]');
    await expect(page.locator('section[data-settings-panel="cloud"]')).toBeVisible();

    // Switch to About
    await page.click('#settings-tabs [data-settings-tab="about"]');
    await expect(page.locator('section[data-settings-panel="about"]')).toBeVisible();

    // Back to App
    await page.click('#settings-tabs [data-settings-tab="app"]');
    await expect(page.locator('section[data-settings-panel="app"]')).toBeVisible();
  });

  test('language switcher has multiple options', async ({ page }) => {
    const switcher = page.locator('#lang-switcher-container select');
    await expect(switcher).toBeVisible();

    // Should have at least 2 languages
    const options = switcher.locator('option');
    expect(await options.count()).toBeGreaterThanOrEqual(2);

    // Current value should match config
    expect(await switcher.inputValue()).toBe('en');
  });

  test('theme selector switches between light, dark, and system immediately', async ({ page }) => {
    const theme = page.locator('#theme');
    await expect(theme).toBeVisible();
    await expect(theme.locator('option')).toHaveCount(3);
    await expect(theme).toHaveValue('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'light');

    await theme.selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'dark');
    await expect(theme).toHaveValue('dark');

    await page.reload();
    await page.locator('[data-section="settings"]').click();
    await expect(page.locator('#theme')).toHaveValue('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.locator('#theme').selectOption('system');
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('checkbox toggles flip checked state', async ({ page }) => {
    const showCost = page.locator('#showEstimatedCost');
    await expect(showCost).toBeVisible();

    const wasChecked = await showCost.isChecked();
    await showCost.click();
    expect(await showCost.isChecked()).toBe(!wasChecked);
  });
});
