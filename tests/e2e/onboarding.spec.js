// E2E: First install → wizard completion
import { test, expect } from './mock-setup-onboarding.js';
import { waitForWizard, waitForScanComplete } from './helpers.js';

test.describe('Onboarding Wizard', () => {
  test('wizard appears on first launch', async ({ page }) => {
    // On first launch with no config, wizard should appear
    const wizard = page.locator('#onboarding-wizard');
    await expect(wizard).toBeVisible({ timeout: 10_000 });
  });

  test('complete wizard flow: create identity → configure sources → finish', async ({ page }) => {
    await waitForWizard(page);

    // Step 0: Create identity
    await page.click('#wizard-create-identity');
    await page.fill('#wizard-nickname', 'e2e-test-user');
    await page.click('#wizard-next-0');

    // Step 1: Sources page should be visible
    await expect(page.locator('#wizard-source-list')).toBeVisible({ timeout: 5_000 });
    await page.click('#wizard-next-1');

    // Step 2: Summary page
    await expect(page.locator('#wizard-summary-nickname')).toContainText('e2e-test-user');
    await page.click('#wizard-start');

    // Wizard should close, main UI should appear
    await expect(page.locator('#wizard-overlay')).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('#overview')).toBeVisible();
  });

  test('wizard skip button works', async ({ page }) => {
    await waitForWizard(page);
    await page.click('#wizard-skip');
    await expect(page.locator('#wizard-overlay')).toBeHidden({ timeout: 10_000 });
  });
});
