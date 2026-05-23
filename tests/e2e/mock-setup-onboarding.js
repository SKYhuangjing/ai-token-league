// Playwright test fixture for onboarding (first-launch) tests.
// Sets desktopAutoInitialized: false so the wizard appears.
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mockScript = readFileSync(resolve(import.meta.dirname, 'mock-tauri.js'), 'utf-8');
const configScript = 'window.__ATL_E2E_CONFIG__ = { desktopAutoInitialized: true, language: "en" };';

export const test = base.extend({
  page: async ({ page }, use) => {
    // Inject scenario config before mock script reads it
    await page.addInitScript(configScript);
    await page.addInitScript(mockScript);
    await page.goto('/');
    await use(page);
  },
});

export { expect };
