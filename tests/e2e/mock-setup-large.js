// Playwright test fixture for large dataset E2E tests.
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mockScript = readFileSync(resolve(import.meta.dirname, 'mock-tauri.js'), 'utf-8');
// Generate 1000 usage rows
const configScript = 'window.__ATL_E2E_CONFIG__ = { desktopAutoInitialized: false, language: "en", largeDataset: 1000 };';

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(configScript);
    await page.addInitScript(mockScript);
    await page.goto('/');
    await use(page);
  },
});

export { expect };
