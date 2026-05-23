// E2E: Cloud sync status and configuration
import { test, expect } from './mock-setup.js';
import { waitForScanComplete, navigateTo } from './helpers.js';

test.describe('Sync Flow', () => {
  test.beforeEach(async ({ page }) => {
    await waitForScanComplete(page);
  });

  test('rail shows local status when no API URL configured', async ({ page }) => {
    const statusEl = page.locator('#rail-cloud-status');
    await expect(statusEl).toBeVisible();
    // Mock has empty apiBaseUrl → state should be "local"
    await expect(statusEl).toHaveAttribute('data-state', 'local');

    const statusText = page.locator('#rail-cloud-status-text');
    await expect(statusText).toContainText(/local/i);
  });

  test('Cloud settings tab shows status badge with content', async ({ page }) => {
    await navigateTo(page, 'settings');
    await page.click('#settings-tabs [data-settings-tab="cloud"]');

    const badge = page.locator('#cloud-status-badge');
    await expect(badge).toBeVisible();
    // Badge should show "Local only" since apiBaseUrl is empty
    await expect(badge).toContainText(/local/i);

    const text = page.locator('#cloud-status-text');
    await expect(text).toBeVisible();
  });

  test('API base URL input accepts a value and shows dirty state', async ({ page }) => {
    await navigateTo(page, 'settings');
    await page.click('#settings-tabs [data-settings-tab="cloud"]');

    const input = page.locator('#apiBaseUrl');
    await expect(input).toBeVisible();
    // Should start empty
    expect(await input.inputValue()).toBe('');

    await input.fill('https://test.example.com');
    expect(await input.inputValue()).toBe('https://test.example.com');

    // Save button should show dirty state
    const saveBtn = page.locator('#settings .primary-pill').first();
    await expect(saveBtn).toHaveClass(/has-unsaved/);
  });
});
