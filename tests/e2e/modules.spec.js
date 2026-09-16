// E2E: Optional modules screen (feat/compute-sharing R9; R22 zhipu user-managed keys)
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { navigateTo } from './helpers.js';

const mockScript = readFileSync(resolve(import.meta.dirname, 'mock-tauri.js'), 'utf-8');
// The zhipu card is a fully remote plugin (R28c): the spec serves the REAL
// plugin entry through the distribution proxy route so the mounted code is
// the shipped code. Source serving must precede goto (the modules screen
// renders and mounts during boot).
const ZHIPU_VERSION = '1.1.5';
const zhipuSource = readFileSync(resolve(import.meta.dirname, '../../plugins/zhipu-plan/index.js'), 'utf-8');

function scenarioTest(config) {
  return base.extend({
    page: async ({ page }, use) => {
      await page.addInitScript(`window.__ATL_E2E_CONFIG__ = ${JSON.stringify(config)};`);
      await page.addInitScript(mockScript);
      await page.route(`**/api/modules/remote/file/zhipu-plan/${ZHIPU_VERSION}/index.js`, (route) =>
        route.fulfill({ status: 200, contentType: 'text/javascript', body: zhipuSource }));
      await page.goto('/');
      await use(page);
    },
  });
}

// compute-sharing exists only as a remote catalog plugin (online-modules.spec.js
// and compute-sharing.spec.js cover it) — the built-in registry carries the
// zhipu plan module only.
const enabled = scenarioTest({ desktopAutoInitialized: false, language: 'en', apiBaseUrl: 'http://backend.test' });
const disabled = scenarioTest({
  desktopAutoInitialized: false,
  language: 'en',
  apiBaseUrl: 'http://backend.test',
  modules: { 'zhipu-plan': { enabled: false, config: {}, installedVersion: ZHIPU_VERSION } },
});

async function openModulesScreen(page) {
  await navigateTo(page, 'modules');
  await page.waitForSelector('[data-module-card="zhipu-plan"]', { timeout: 5_000 });
}

enabled.describe('Modules screen (enabled, en)', () => {
  enabled('lists the zhipu plan module as enabled', async ({ page }) => {
    await openModulesScreen(page);
    await expect(page.locator('#modules-list')).toContainText('Zhipu plan usage');
    // module enable control is the Sources-style switch button, not a checkbox
    const toggle = page.locator('[data-module-toggle="zhipu-plan"]');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // no built-in compute-sharing card — it installs from the online catalog only
    await expect(page.locator('[data-module-card="compute-sharing"]')).toHaveCount(0);
    // pluggable lifecycle (R24): version + uninstall ride on the card
    const card = page.locator('[data-module-card="zhipu-plan"]');
    await expect(card.locator('.module-inline-actions .mono').first()).toContainText(`v${ZHIPU_VERSION}`);
    await expect(card.locator('[data-remote-uninstall="zhipu-plan"]')).toBeVisible();
  });

  enabled('zhipu plugin is uninstallable and leaves no trace', async ({ page }) => {
    await openModulesScreen(page);
    await page.locator('[data-remote-uninstall="zhipu-plan"]').click();
    await expect(page.locator('[data-module-card="zhipu-plan"]')).toHaveCount(0);
    await expect.poll(() =>
      page.evaluate(() => window.__ATL_E2E_STATE__.modulesSetCalls.filter((c) => c.id === 'zhipu-plan' && c.installedVersion === null && c.enabled === false).length)
    ).toBe(1);
    const state = await page.evaluate(() => window.__ATL_E2E_STATE__.modulesState.modules['zhipu-plan']);
    expect(state.installedVersion).toBeUndefined();
    expect(state.enabled).toBe(false);
  });

  enabled('zhipu plan card: managed keys, window usage, reset countdowns', async ({ page }) => {
    await openModulesScreen(page);
    await expect(page.locator('#modules-list')).toContainText('Zhipu plan usage');
    const card = page.locator('[data-module-card="zhipu-plan"]');
    // before any key: the empty hint renders, no auto query happened
    await expect(page.locator('#zhipu-result')).toContainText('No Zhipu API key yet');
    expect(await page.evaluate(() => window.__ATL_E2E_STATE__.zhipuUsageCalls.length)).toBe(0);
    // add a key (label + key) — persisted via module config, usage auto-loads
    await card.locator('#zhipu-key-label').fill('GLM 5.3 -Harry');
    await card.locator('#zhipu-key-input').fill('e2e-fake-zhipu-key-0001');
    await card.locator('#zhipu-key-add').click();
    await expect(card.locator('.zhipu-key-row')).toContainText('GLM 5.3 -Harry');
    // key masked in the list — the raw key never renders
    await expect(card.locator('.zhipu-key-row .zhipu-key-mask')).toContainText('••••');
    await expect(card.locator('.zhipu-key-row .zhipu-key-mask')).not.toContainText('e2e-fake-zhipu-key-0001');
    await expect.poll(() =>
      page.evaluate(() => window.__ATL_E2E_STATE__.modulesSetCalls.filter((c) => c.id === 'zhipu-plan' && Array.isArray(c.config?.keys)).length)
    ).toBe(1);
    const addCall = await page.evaluate(() =>
      window.__ATL_E2E_STATE__.modulesSetCalls.find((c) => Array.isArray(c.config?.keys))
    );
    expect(addCall.config.keys).toEqual([{ label: 'GLM 5.3 -Harry', apiKey: 'e2e-fake-zhipu-key-0001' }]);
    // 5h + weekly windows with reset countdowns render automatically
    await expect(page.locator('#zhipu-result .zhipu-account').first()).toContainText('GLM 5.3 -Harry', { timeout: 5_000 });
    await expect(page.locator('#zhipu-result')).toContainText('51%');
    await expect(page.locator('#zhipu-result')).toContainText('33%');
    await expect(page.locator('#zhipu-result .zhipu-reset').first()).toBeVisible();
    // refresh age rides next to the refresh button, same clock family
    await expect(page.locator('#zhipu-refreshed')).toBeVisible();
    await expect(page.locator('#zhipu-refreshed')).toContainText('just now');
  });

  enabled('zhipu key rows support inline edit (rename + rekey) and cancel', async ({ page }) => {
    await openModulesScreen(page);
    const card = page.locator('[data-module-card="zhipu-plan"]');
    await card.locator('#zhipu-key-label').fill('Old Name');
    await card.locator('#zhipu-key-input').fill('e2e-edit-key-0001');
    await card.locator('#zhipu-key-add').click();
    await expect(card.locator('.zhipu-key-row')).toContainText('Old Name');
    // edit opens prefilled with the exact label and the full key
    await card.locator('[data-zhipu-key-edit="0"]').click();
    await expect(card.locator('[data-zhipu-edit-label]')).toHaveValue('Old Name');
    await expect(card.locator('[data-zhipu-edit-key]')).toHaveValue('e2e-edit-key-0001');
    // save writes the updated entry (label changed, key intact)
    await card.locator('[data-zhipu-edit-label]').fill('New Name');
    await card.locator('[data-zhipu-edit-key]').fill('e2e-edit-key-0002');
    await card.locator('[data-zhipu-key-save="0"]').click();
    await expect(card.locator('.zhipu-key-row')).toContainText('New Name');
    const calls = await page.evaluate(() =>
      window.__ATL_E2E_STATE__.modulesSetCalls.filter((c) => Array.isArray(c.config?.keys)));
    expect(calls.at(-1).config.keys).toEqual([{ label: 'New Name', apiKey: 'e2e-edit-key-0002' }]);
    await expect.poll(() =>
      page.evaluate(() => window.__ATL_E2E_STATE__.zhipuUsageCalls.filter((c) => c.force === true).length)
    ).toBeGreaterThan(0);
    // cancel discards edits without persisting
    await card.locator('[data-zhipu-key-edit="0"]').click();
    await card.locator('[data-zhipu-edit-label]').fill('Discarded');
    await card.locator('[data-zhipu-key-cancel="0"]').click();
    await expect(card.locator('.zhipu-key-row')).toContainText('New Name');
    await expect(card.locator('[data-zhipu-edit-label]')).toHaveCount(0);
    const afterCancel = await page.evaluate(() =>
      window.__ATL_E2E_STATE__.modulesSetCalls.filter((c) => Array.isArray(c.config?.keys)));
    expect(afterCancel.length).toBe(calls.length);
  });

  enabled('zhipu card: manual refresh forces, menu-bar/alerts toggles persist, key removal', async ({ page }) => {
    await openModulesScreen(page);
    const card = page.locator('[data-module-card="zhipu-plan"]');
    // R20 consensus toggles default on, independent of the module switch
    const menubar = page.locator('[data-zp-config="menubar"]');
    await expect(menubar).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('[data-zp-config="alerts"]')).toHaveAttribute('aria-checked', 'true');
    await menubar.click();
    await expect.poll(() =>
      page.evaluate(() => window.__ATL_E2E_STATE__.modulesSetCalls.filter((c) => c.config && c.config.menubar === false).length)
    ).toBe(1);
    await expect(menubar).toHaveAttribute('aria-checked', 'false');
    // manual refresh passes force + the configured keys
    await card.locator('#zhipu-key-input').fill('e2e-fake-zhipu-key-0002');
    await card.locator('#zhipu-key-add').click();
    await expect(page.locator('#zhipu-result .zhipu-account').first()).toContainText('51%', { timeout: 5_000 });
    await card.locator('#zhipu-refresh-btn').click();
    await expect.poll(() =>
      page.evaluate(() => window.__ATL_E2E_STATE__.zhipuUsageCalls.filter((c) => c.force === true).length)
    ).toBeGreaterThan(0);
    const lastCall = await page.evaluate(() => window.__ATL_E2E_STATE__.zhipuUsageCalls.at(-1));
    expect(Array.isArray(lastCall.keys)).toBe(true);
    expect(lastCall.keys[0].apiKey).toBe('e2e-fake-zhipu-key-0002');
    // removing the key clears usage and persists the empty list
    await card.locator('[data-zhipu-key-del="0"]').click();
    await expect(page.locator('#zhipu-result')).toContainText('No Zhipu API key yet');
    await expect.poll(() =>
      page.evaluate(() => window.__ATL_E2E_STATE__.modulesSetCalls.filter((c) => Array.isArray(c.config?.keys) && c.config.keys.length === 0).length)
    ).toBe(1);
  });
});

const zh = scenarioTest({ desktopAutoInitialized: false, language: 'zh-CN', apiBaseUrl: 'http://backend.test' });

zh.describe('Modules screen (zh-CN)', () => {
  zh('zhipu window labels localize (unit=6 renders 每周)', async ({ page }) => {
    await openModulesScreen(page);
    const card = page.locator('[data-module-card="zhipu-plan"]');
    await card.locator('#zhipu-key-input').fill('e2e-fake-zhipu-key-zh');
    await card.locator('#zhipu-key-add').click();
    await expect(page.locator('#zhipu-result')).toContainText('5 小时', { timeout: 5_000 });
    await expect(page.locator('#zhipu-result')).toContainText('每周');
    await expect(page.locator('#zhipu-result')).toContainText('33%');
    await expect(page.locator('#zhipu-refreshed')).toContainText('刚刚');
  });
});

const reorder = scenarioTest({
  desktopAutoInitialized: false,
  language: 'en',
  apiBaseUrl: 'http://backend.test',
  modules: {
    'zhipu-plan': { enabled: true, config: {}, installedVersion: ZHIPU_VERSION },
    'compute-sharing': { enabled: true, config: {}, installedVersion: '0.1.0' },
  },
});

reorder.describe('Installed plugin order', () => {
  reorder('drags a tab to a new saved order', async ({ page }) => {
    await navigateTo(page, 'modules');
    const tabs = page.locator('#modules-plugin-tabs button[data-plugin-tab]');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toHaveAttribute('data-plugin-tab', 'zhipu-plan');
    const target = page.locator('[data-plugin-tab="zhipu-plan"]');
    const box = await target.boundingBox();
    await page.locator('[data-plugin-tab="compute-sharing"]').dragTo(target, {
      targetPosition: { x: 8, y: Math.max(8, (box?.height || 24) / 2) },
    });
    await expect(tabs.nth(0)).toHaveAttribute('data-plugin-tab', 'compute-sharing');
    await expect.poll(() => page.evaluate(() => window.__ATL_E2E_STATE__.modulesState.modules.__order?.config?.ids))
      .toEqual(['compute-sharing', 'zhipu-plan']);
  });
});

disabled.describe('Modules screen (disabled, en)', () => {
  disabled('shows the module off without a detail and no legacy settings tabs', async ({ page }) => {
    await openModulesScreen(page);
    await expect(page.locator('[data-module-toggle="zhipu-plan"]').first()).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('[data-module-detail="zhipu-plan"]')).toHaveCount(0);
    await expect(page.locator('[data-settings-tab="modules"]')).toHaveCount(0);
    await expect(page.locator('[data-settings-tab="sharing"]')).toHaveCount(0);
  });
});
