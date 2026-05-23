// Playwright test fixture for async scan tests (scanDelay > 0).
// Simulates the real sidecar's running → done transition.
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mockScript = readFileSync(resolve(import.meta.dirname, 'mock-tauri.js'), 'utf-8');
const configScript = 'window.__ATL_E2E_CONFIG__ = { desktopAutoInitialized: false, language: "en", scanDelay: 500 };';

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(configScript);
    await page.addInitScript(mockScript);
    await page.goto('/');
    await use(page);
  },
});

export { expect };
