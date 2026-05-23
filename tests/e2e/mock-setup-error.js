// Playwright test fixture for API error E2E tests.
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mockScript = readFileSync(resolve(import.meta.dirname, 'mock-tauri.js'), 'utf-8');
const configScript = 'window.__ATL_E2E_CONFIG__ = { desktopAutoInitialized: false, language: "en", apiError: true };';

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(configScript);
    await page.addInitScript(mockScript);
    await page.goto('/');
    await use(page);
  },
});

export { expect };
