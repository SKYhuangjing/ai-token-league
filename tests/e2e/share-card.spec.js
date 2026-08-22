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
    const config = {
      desktopAutoInitialized: false,
      language: 'en',
      syncConfigured: true,
      brandLogoDataUrl: LOGO_DATA_URL,
      brandLogoUrl: 'https://logo.example.com/logo.png',
    };
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
    const previewBox = await page.locator('#share-card-preview').boundingBox();
    const rootHeight = await page.locator('#share-card-preview .sc-root').evaluate((el) => el.scrollHeight);
    expect(previewBox.height).toBeGreaterThan(0);
    expect(rootHeight).toBeGreaterThanOrEqual(500);

    const actions = page.locator('.polaroid-actions');
    await expect(actions).toHaveClass(/visible/, { timeout: 5_000 });

    await page.click('#save-share-card');
    // The "saved" status text is transient: the modal auto-closes on success
    // and clears the status ~400ms later, so polling the text races the close
    // under a full parallel suite. Waiting for the auto-close proves the
    // success branch (cancel/error paths keep the modal open); the persisted
    // save state is asserted right after.
    await expect(page.locator('#share-card-modal')).toBeHidden({ timeout: 15_000 });
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

  test('keeps share controls fully visible in a compact window', async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 620 });
    await waitForScanComplete(page);

    await page.click('#open-share-card');
    await expect(page.locator('.polaroid-stage')).toHaveClass(/visible/, { timeout: 3_000 });
    await expect(page.locator('#share-card-preview .sc-root')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.polaroid-actions')).toHaveClass(/visible/, { timeout: 5_000 });
    await expect(page.locator('#share-modal-settings')).toHaveClass(/visible/, { timeout: 5_000 });

    const viewport = page.viewportSize();
    const actionBox = await page.locator('.polaroid-actions').boundingBox();
    const settingsBox = await page.locator('#share-modal-settings').boundingBox();
    expect(actionBox).toBeTruthy();
    expect(settingsBox).toBeTruthy();
    expect(actionBox.y).toBeGreaterThanOrEqual(0);
    expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(viewport.height);
    expect(settingsBox.y).toBeGreaterThanOrEqual(0);
    expect(settingsBox.y + settingsBox.height).toBeLessThanOrEqual(viewport.height);

    const stageMetrics = await page.locator('.polaroid-stage').evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(stageMetrics.scrollHeight).toBeLessThanOrEqual(stageMetrics.clientHeight + 1);
    expect(stageMetrics.scrollWidth).toBeLessThanOrEqual(stageMetrics.clientWidth + 1);
  });

  test('keeps action buttons visible while switching orientation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await waitForScanComplete(page);

    await page.click('#open-share-card');
    await expect(page.locator('.polaroid-stage')).toHaveClass(/visible/, { timeout: 3_000 });
    await expect(page.locator('.polaroid-actions')).toHaveClass(/visible/, { timeout: 5_000 });

    await page.locator('#share-card-orientation button[data-range="portrait"]').click();
    await expect(page.locator('#polaroid-card')).toHaveClass(/orientation-flip-out/, { timeout: 120 });
    await expect(page.locator('.polaroid-actions')).toHaveClass(/moving-layout/, { timeout: 600 });
    await expect(page.locator('#polaroid-card')).not.toHaveClass(/orientation-flipping/, { timeout: 2_000 });
    await expect(page.locator('#share-card-preview .sc-root.sc-portrait')).toBeVisible({ timeout: 5_000 });

    const portraitBox = await page.locator('.polaroid-actions').boundingBox();
    const settingsBox = await page.locator('#share-modal-settings').boundingBox();
    const cardBox = await page.locator('#polaroid-card').boundingBox();
    const stageBox = await page.locator('.polaroid-stage').boundingBox();
    const viewport = page.viewportSize();
    expect(portraitBox).toBeTruthy();
    expect(settingsBox).toBeTruthy();
    expect(cardBox).toBeTruthy();
    expect(stageBox).toBeTruthy();
    expect(portraitBox.y).toBeGreaterThanOrEqual(0);
    expect(portraitBox.y + portraitBox.height).toBeLessThanOrEqual(viewport.height);
    expect(settingsBox.y).toBeGreaterThanOrEqual(portraitBox.y + portraitBox.height + 24);
    expect(settingsBox.y + settingsBox.height).toBeLessThanOrEqual(viewport.height);
    expect(cardBox.y).toBeGreaterThanOrEqual(stageBox.y + 8);
    expect(cardBox.x).toBeGreaterThanOrEqual(stageBox.x + 8);
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(stageBox.y + stageBox.height - 8);

    const portraitStageMetrics = await page.locator('.polaroid-stage').evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(portraitStageMetrics.scrollHeight).toBeLessThanOrEqual(portraitStageMetrics.clientHeight + 1);
    expect(portraitStageMetrics.scrollWidth).toBeLessThanOrEqual(portraitStageMetrics.clientWidth + 1);

    await page.locator('#share-card-orientation button[data-range="landscape"]').click();
    await expect(page.locator('#polaroid-card')).toHaveClass(/orientation-flip-out/, { timeout: 120 });
    await expect(page.locator('.polaroid-actions')).toHaveClass(/moving-layout/, { timeout: 600 });
    await expect(page.locator('#polaroid-card')).not.toHaveClass(/orientation-flipping/, { timeout: 2_000 });
    await expect(page.locator('#share-card-preview .sc-root:not(.sc-portrait)')).toBeVisible({ timeout: 5_000 });

    const heights = await page.evaluate(() => {
      const preview = document.querySelector('#share-card-preview').getBoundingClientRect();
      const root = document.querySelector('#share-card-preview .sc-root').getBoundingClientRect();
      const imageArea = document.querySelector('.polaroid-image-area').getBoundingClientRect();
      return {
        preview: preview.height,
        root: root.height,
        imageArea: imageArea.height,
      };
    });
    expect(Math.abs(heights.preview - heights.root)).toBeLessThanOrEqual(6);
    expect(Math.abs(heights.imageArea - heights.preview)).toBeLessThanOrEqual(8);

    const landscapeStageMetrics = await page.locator('.polaroid-stage').evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(landscapeStageMetrics.scrollHeight).toBeLessThanOrEqual(landscapeStageMetrics.clientHeight + 1);
    expect(landscapeStageMetrics.scrollWidth).toBeLessThanOrEqual(landscapeStageMetrics.clientWidth + 1);
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
  logoTest('fetchBrandLogo uses sidecar brand:logo and renders in share card footer', async ({ page }) => {
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

  logoTest('portrait share card renders logo in the top brand row', async ({ page }) => {
    await waitForScanComplete(page);

    await page.click('#open-share-card');
    await expect(page.locator('.polaroid-stage')).toHaveClass(/visible/, { timeout: 3_000 });
    await page.locator('#share-card-orientation button[data-range="portrait"]').click();
    await expect(page.locator('#share-card-preview .sc-root.sc-portrait')).toBeVisible({ timeout: 5_000 });

    const portraitLogo = page.locator('#share-card-preview .sc-portrait-brand-logo');
    await expect(portraitLogo).toBeVisible({ timeout: 3_000 });
    await expect(portraitLogo).toHaveAttribute('src', /^data:image/);
  });

  logoTest('logo clears when image fetch fails', async ({ page }) => {
    // Override: logo image URL returns network error
    await page.route('https://logo.example.com/logo.png', (route) => route.abort());
    // Use addInitScript so the flag survives the page.goto navigation
    await page.addInitScript({ content: 'window.__ATL_E2E_STATE__ = Object.assign(window.__ATL_E2E_STATE__ || {}, { brandLogoError: true });' });
    await page.goto('/');

    await waitForScanComplete(page);

    // Rail logo should have no src — fetch failure treated as no logo
    const railLogo = page.locator('#rail-brand-logo');
    const src = await railLogo.getAttribute('src');
    expect(src).toBeNull();
  });
});
