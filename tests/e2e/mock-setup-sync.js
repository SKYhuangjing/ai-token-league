// Mock setup for sync status E2E scenarios
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mockScript = readFileSync(resolve('tests/e2e/mock-tauri.js'), 'utf-8');

export function createSyncFixture(config) {
  const configScript = `window.__ATL_E2E_CONFIG__ = ${JSON.stringify(config)};`;
  return base.extend({
    page: async ({ page }, use) => {
      await page.addInitScript({ content: configScript });
      await page.addInitScript({ content: mockScript });
      await page.goto('/');
      await use(page);
    },
  });
}

// Default sync test: no cloud configured
export const test = createSyncFixture({
  desktopAutoInitialized: false,
  language: 'en',
});
export { expect };
