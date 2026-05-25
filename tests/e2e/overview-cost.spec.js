import { test, expect } from './mock-setup-cost.js';
import { waitForScanComplete } from './helpers.js';

test.describe('Overview estimated cost', () => {
  test('keeps showing cost after summary query refreshes overview data', async ({ page }) => {
    await waitForScanComplete(page);

    await expect(page.locator('#today-cost .cost-amount')).toContainText('$');
    await expect(page.locator('#overview-input-detail .cost-amount')).toContainText('$');
    await expect(page.locator('#provider-list .meter-value .cost-amount').first()).toContainText('$');
    await expect(page.locator('#overview-trend .spark-bar-value .cost-amount').first()).toContainText('$');
  });
});
