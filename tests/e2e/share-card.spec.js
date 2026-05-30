import { test, expect } from './mock-setup.js';
import { test as base, expect as baseExpect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { waitForScanComplete } from './helpers.js';

// 1x1 transparent PNG as data URL
const LOGO_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Minimal 1x1 PNG bytes for route interception
const LOGO_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// Fixture with syncConfigured + mocked brand logo API
const mockScript = readFileSync(resolve('tests/e2e/mock-tauri.js'), 'utf-8');
const logoTest = base.extend({
  page: async ({ page }, use) => {
    const config = { desktopAutoInitialized: false, language: 'en', syncConfigured: true };
    await page.addInitScript({ content: `window.__ATL_E2E_CONFIG__ = ${JSON.stringify(config)};` });
    await page.addInitScript({ content: mockScript });

    // Mock brand logo API (must be registered before navigation)
    await page.route('https://test.example.com/api/brand/logo', (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith('/image')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ logoUrl: 'https://logo.example.com/logo.png' }) });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
    });
    await page.route('https://logo.example.com/logo.png', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: LOGO_PNG_BYTES })
    );

    await page.goto('/');
    await use(page);
  },
});

test.describe('Share card', () => {
  test('opens polaroid share card and exports image', async ({ page }) => {
    await waitForScanComplete(page);

    await page.click('#open-share-card');
    const stage = page.locator('.polaroid-stage');
    await expect(stage).toHaveClass(/visible/, { timeout: 3_000 });
    await expect(page.locator('#share-card-preview .sc-root')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#share-card-preview')).toContainText('Test User');
    await expect(page.locator('#share-card-preview')).toContainText('Source mix');
    await expect(page.locator('#share-card-preview')).toContainText('Model mix');
    await expect(page.locator('#share-card-preview')).toContainText('Top Workdirs', { ignoreCase: true });

    const actions = page.locator('.polaroid-actions');
    await expect(actions).toHaveClass(/visible/, { timeout: 5_000 });

    await page.click('#save-share-card');
    await expect(page.locator('#share-card-status')).toContainText(/saved|copied/i, { timeout: 5_000 });
    const saved = await page.evaluate(() => window.__ATL_E2E_STATE__.lastShareImageSave);
    expect(saved).toBeTruthy();
    expect(saved.fileName).toMatch(/^ai-token-league-share-today-\d{4}-\d{2}-\d{2}\.png$/);
    expect(saved.base64Png.length).toBeGreaterThan(1000);
    expect(saved.base64Png.startsWith('iVBORw0KGgo')).toBe(true);
  });

  test('copy and save auto-close modal', async ({ page }) => {
    await waitForScanComplete(page);
    await page.click('#open-share-card');
    await expect(page.locator('.polaroid-stage')).toHaveClass(/visible/, { timeout: 3_000 });
    await expect(page.locator('#share-card-preview .sc-root')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.polaroid-actions')).toHaveClass(/visible/, { timeout: 5_000 });

    await page.click('#save-share-card');
    await expect(page.locator('#share-card-modal')).toBeHidden({ timeout: 5_000 });
  });
});

test.describe('Brand logo in share card', () => {
  test('no logo in footer when apiBaseUrl is not set', async ({ page }) => {
    await waitForScanComplete(page);

    await page.click('#open-share-card');
    await expect(page.locator('.polaroid-stage')).toHaveClass(/visible/, { timeout: 3_000 });
    await expect(page.locator('#share-card-preview .sc-root')).toBeVisible({ timeout: 5_000 });

    const footerLogo = page.locator('#share-card-preview .sc-footer-logo');
    await expect(footerLogo).toHaveCount(0);
  });

  test('rail logo element exists', async ({ page }) => {
    await waitForScanComplete(page);
    const logo = page.locator('#rail-brand-logo');
    await expect(logo).toHaveCount(1);
    const src = await logo.getAttribute('src');
    expect(src).toBeNull();
  });
});

logoTest.describe('Brand logo real fetch chain', () => {
  logoTest('fetchBrandLogo fetches image and renders in share card footer', async ({ page }) => {
    await waitForScanComplete(page);

    // Wait for fetchBrandLogo to complete — rail logo should get a data URL src
    const railLogo = page.locator('#rail-brand-logo');
    await expect(railLogo).toHaveAttribute('src', /^data:image/, { timeout: 5_000 });

    // Open share card — logo should appear in footer via the real chain
    await page.click('#open-share-card');
    await expect(page.locator('.polaroid-stage')).toHaveClass(/visible/, { timeout: 3_000 });
    await expect(page.locator('#share-card-preview .sc-root')).toBeVisible({ timeout: 5_000 });

    const footerLogo = page.locator('#share-card-preview .sc-footer-logo');
    await expect(footerLogo).toBeVisible({ timeout: 3_000 });
    await expect(footerLogo).toHaveAttribute('src', /^data:image/);
  });

  logoTest('logo clears when image fetch fails', async ({ page }) => {
    // Override: logo image URL returns network error
    await page.route('https://logo.example.com/logo.png', (route) => route.abort());
    await page.goto('/');

    await waitForScanComplete(page);

    // Rail logo should have no src — fetch failure treated as no logo
    const railLogo = page.locator('#rail-brand-logo');
    const src = await railLogo.getAttribute('src');
    expect(src).toBeNull();
  });
});
