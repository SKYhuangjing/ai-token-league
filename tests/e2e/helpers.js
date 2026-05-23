// E2E test helpers for AI Token League desktop app

/**
 * Wait for the initial scan to complete and data to appear.
 * @param {import('@playwright/test').Page} page
 * @param {number} timeout
 */
export async function waitForScanComplete(page, timeout = 30_000) {
  await page.waitForFunction(() => {
    const total = document.querySelector('#today-total');
    return total && total.textContent.trim() !== '0' && total.textContent.trim() !== '-';
  }, { timeout });
}

/**
 * Wait for the onboarding wizard to appear.
 * @param {import('@playwright/test').Page} page
 */
export async function waitForWizard(page) {
  await page.waitForSelector('#wizard-overlay:not([hidden])', { timeout: 10_000 });
}

/**
 * Navigate to a section by clicking the sidebar nav button.
 * @param {import('@playwright/test').Page} page
 * @param {string} section - overview, workdirs, sources, settings
 */
export async function navigateTo(page, section) {
  await page.click(`[data-section="${section}"]`);
  await page.waitForSelector(`#${section}.screen.active`, { timeout: 5_000 });
}

/**
 * Read a token value from the DOM, handling compact notation (K/M suffixes).
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 * @returns {Promise<number>}
 */
export async function getTokenValue(page, selector) {
  const text = (await page.textContent(selector)).trim();
  if (text === '-' || text === '0') return 0;
  const num = parseFloat(text.replace(/[^0-9.]/g, ''));
  if (text.includes('M')) return Math.round(num * 1_000_000);
  if (text.includes('K')) return Math.round(num * 1_000);
  return Math.round(num) || 0;
}

/**
 * Wait for a toast notification to appear.
 * @param {import('@playwright/test').Page} page
 * @param {number} timeout
 */
export async function waitForToast(page, timeout = 5_000) {
  await page.waitForFunction(() => {
    const toast = document.querySelector('#toast');
    return toast && toast.classList.contains('visible');
  }, { timeout });
}
