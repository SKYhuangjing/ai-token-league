// E2E: Cloud sync status and configuration
import { test, expect } from './mock-setup.js';

test.describe('Sync Flow', () => {
  test('rail shows local_only status when no API URL configured', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    const statusEl = page.locator('#rail-cloud-status');
    await expect(statusEl).toBeVisible();
    await expect(statusEl).toHaveAttribute('data-state', 'local_only');

    const statusText = page.locator('#rail-cloud-status-text');
    await expect(statusText).toContainText(/local/i);
  });

  test('Cloud settings tab shows status badge with content', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    await page.click('[data-section="settings"]');
    await page.waitForSelector('#settings.screen.active', { timeout: 10000 });
    await page.click('#settings-tabs [data-settings-tab="cloud"]');

    const badge = page.locator('#cloud-status-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(/local/i);

    const text = page.locator('#cloud-status-text');
    await expect(text).toBeVisible();
  });

  test('API base URL input accepts a value and shows dirty state', async ({ page }) => {
    await page.waitForSelector('#rail-cloud-status', { timeout: 10000 });
    await page.click('[data-section="settings"]');
    await page.waitForSelector('#settings.screen.active', { timeout: 10000 });
    await page.click('#settings-tabs [data-settings-tab="cloud"]');

    const input = page.locator('#apiBaseUrl');
    await expect(input).toBeVisible();
    expect(await input.inputValue()).toBe('');

    await input.fill('https://test.example.com');
    expect(await input.inputValue()).toBe('https://test.example.com');

    const saveBtn = page.locator('#settings .primary-pill').first();
    await expect(saveBtn).toHaveClass(/has-unsaved/);
  });
});
