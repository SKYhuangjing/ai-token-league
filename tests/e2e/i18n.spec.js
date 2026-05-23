// E2E: Internationalization — translations are applied
import { test, expect } from './mock-setup.js';
import { waitForScanComplete } from './helpers.js';

test.describe('i18n', () => {
  test.beforeEach(async ({ page }) => {
    await waitForScanComplete(page);
  });

  test('page renders with English translations', async ({ page }) => {
    // html lang should match config
    const htmlLang = await page.getAttribute('html', 'lang');
    expect(htmlLang).toBe('en');

    // Navigation buttons should have English text (not i18n keys)
    const overviewBtn = page.locator('[data-section="overview"]');
    await expect(overviewBtn).toContainText('Overview');
  });

  test('data-i18n elements are populated with translations', async ({ page }) => {
    const elements = page.locator('[data-i18n]');
    const count = await elements.count();
    expect(count).toBeGreaterThan(0);

    // None should show raw i18n keys like "desktop.nav.overview"
    for (let i = 0; i < Math.min(10, count); i++) {
      const text = await elements.nth(i).textContent();
      const attr = await elements.nth(i).getAttribute('data-i18n');
      // Translated text should not equal the raw key
      if (attr && attr.includes('.')) {
        expect(text.trim()).not.toBe(attr);
      }
    }
  });
});
