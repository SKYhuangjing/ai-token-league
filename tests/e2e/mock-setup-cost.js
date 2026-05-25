// Playwright test fixture with estimated-cost display enabled.
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mockScript = readFileSync(resolve(import.meta.dirname, 'mock-tauri.js'), 'utf-8');
const configScript = `window.__ATL_E2E_CONFIG__ = {
  desktopAutoInitialized: false,
  language: "en",
  showEstimatedCost: true,
  syncConfigured: true,
  modelPrices: {
    custom: [
      { model: "claude-sonnet-4-20250514", inputCostPerMTok: 3, outputCostPerMTok: 15, cacheReadCostPerMTok: 0.3, cacheWriteCostPerMTok: 3 },
      { model: "gpt-4o", inputCostPerMTok: 2.5, outputCostPerMTok: 10 }
    ],
    openrouter: [],
    aliases: []
  }
};`;

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(configScript);
    await page.addInitScript(mockScript);
    await page.goto('/');
    await use(page);
  },
});

export { expect };
