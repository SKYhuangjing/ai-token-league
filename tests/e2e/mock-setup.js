// Playwright test fixture that injects mock Tauri bridge.
// Scenario config via window.__ATL_E2E_CONFIG__ (injected before mock script).
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mockScript = readFileSync(resolve(import.meta.dirname, 'mock-tauri.js'), 'utf-8');
const configScript = 'window.__ATL_E2E_CONFIG__ = { desktopAutoInitialized: false, language: "en" };';

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(configScript);
    await page.addInitScript(mockScript);
    await page.goto('/');
    await use(page);
  },
});

export { expect };
