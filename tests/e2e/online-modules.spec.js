// E2E: online plugins tab (feat/compute-sharing R17/R18; R24 tabbed plugin
// screen + pluggable zhipu). Catalog + module files are served via Playwright
// route interception to mimic the backend proxy (/api/modules/remote/*).
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { navigateTo } from './helpers.js';

const mockScript = readFileSync(resolve(import.meta.dirname, 'mock-tauri.js'), 'utf-8');
const sharingSource = readFileSync(resolve(import.meta.dirname, '../../plugins/compute-sharing/index.js'), 'utf-8');

const catalog = {
  version: 1,
  catalog: [
    {
      id: 'zhipu-plan', version: '1.1.0', type: 'query',
      title: '智谱套餐用量', desc: '查询 GLM Coding Plan 用量。',
      permissions: ['sidecar:zhipu-plan:usage'],
    },
    {
      id: 'compute-sharing', version: '0.1.1', type: 'query',
      title: '算力共享', desc: '认领其他成员分享的闲置算力，或管理你自己的 CPA 分享节点。',
      permissions: [
        'sidecar:sharing:claim-sign', 'sidecar:sharing:borrow-get', 'sidecar:sharing:borrow-set',
        'sidecar:sharing:owner-status', 'sidecar:sharing:owner-policy', 'sidecar:sharing:owner-unregister',
      ],
    },
  ],
};

const online = scenarioTest({
  desktopAutoInitialized: false,
  language: 'en',
  apiBaseUrl: 'http://backend.test',
});

function scenarioTest(config) {
  return base.extend({
    page: async ({ page }, use) => {
      await page.route('**/api/modules/remote/catalog', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalog) }));
      await page.route('**/api/modules/remote/file/compute-sharing/0.1.1/index.js', (route) =>
        route.fulfill({ status: 200, contentType: 'text/javascript', body: sharingSource }));
      await page.route('**/api/shares', (route) => route.fulfill({ json: { shares: [] } }));
      await page.addInitScript(`window.__ATL_E2E_CONFIG__ = ${JSON.stringify(config)};`);
      await page.addInitScript(mockScript);
      await page.goto('/');
      await use(page);
    },
  });
}

async function openOnlineTab(page) {
  await navigateTo(page, 'modules');
  await page.click('[data-modules-tab="online"]');
  await page.waitForSelector('#modules-online-list', { timeout: 5_000 });
}

online.describe('Online plugins tab', () => {
  online('defaults to uninstalled plugins; installed filter shows the rest', async ({ page }) => {
    await openOnlineTab(page);
    const onlineList = page.locator('#modules-online-list');
    const filter = page.locator('#modules-online-filter');
    await expect(filter).toBeVisible();
    await expect(page.locator('[data-online-filter="uninstalled"]')).toHaveClass(/active/);
    // zhipu is pre-installed, so the default catalog hides it
    await expect(onlineList).not.toContainText('智谱套餐用量');
    await expect(page.locator('[data-online-install="compute-sharing"]')).toBeVisible();
    await expect(page.locator('[data-online-install="zhipu-plan"]')).toHaveCount(0);

    await page.click('[data-online-filter="installed"]');
    await expect(page.locator('[data-online-filter="installed"]')).toHaveClass(/active/);
    await expect(onlineList).toContainText('智谱套餐用量');
    await expect(page.locator('[data-online-install="zhipu-plan"]')).toHaveText('Reinstall');
    await expect(onlineList).not.toContainText('Built-in');
    await expect(page.locator('[data-online-install="compute-sharing"]')).toHaveCount(0);
  });

  online('catalog fetch failure degrades to unavailable, not endless loading', async ({ page }) => {
    // abort every catalog fetch (boot + navigation refresh) — the region must
    // land in the explicit unavailable state, never a stuck "loading" line
    await page.route('**/api/modules/remote/catalog', (route) => route.abort());
    await page.reload();
    await navigateTo(page, 'modules');
    await page.click('[data-modules-tab="online"]');
    const onlineList = page.locator('#modules-online-list');
    await expect(onlineList).toContainText('The online catalog is temporarily unavailable.', { timeout: 5_000 });
    // installed plugins still render in the installed tab — catalog failure
    // never blocks them
    await page.click('[data-modules-tab="installed"]');
    await expect(page.locator('[data-module-card="zhipu-plan"]')).toBeVisible();
  });

  online('install mounts the plugin card and uninstall removes it', async ({ page }) => {
    await openOnlineTab(page);
    const install = page.locator('[data-online-install="compute-sharing"]');
    await install.click();
    // installed plugin appears in the installed tab and mounts its entry
    await page.click('[data-modules-tab="installed"]');
    const card = page.locator('[data-module-card="compute-sharing"]');
    await expect(card).toBeVisible({ timeout: 5_000 });
    // the real remote entry mounts: my-claims empty state renders (the
    // directory route serves an empty share list)
    await expect(card).toContainText('No claims yet.', { timeout: 5_000 });
    // persisted state records the installed version
    const state = await page.evaluate(() => window.__ATL_E2E_STATE__.modulesState.modules['compute-sharing']);
    expect(state.installedVersion).toBe('0.1.1');
    expect(state.enabled).toBe(true);
    // uninstall clears the card and the persisted record
    await page.locator('[data-remote-uninstall="compute-sharing"]').click();
    await expect(page.locator('[data-module-card="compute-sharing"]')).toHaveCount(0);
    const after = await page.evaluate(() => window.__ATL_E2E_STATE__.modulesState.modules['compute-sharing']);
    expect(after.installedVersion).toBeUndefined();
    const leftover = await page.evaluate(() => window.__ATL_E2E_STATE__.pluginPackages['compute-sharing/0.1.1']);
    expect(leftover).toBeUndefined();
  });

  online('installing a new version drops the previous local package', async ({ page }) => {
    await page.evaluate(() => {
      window.__ATL_E2E_STATE__.pluginPackages['compute-sharing/0.1.0'] = 'old';
    });
    await openOnlineTab(page);
    await page.locator('[data-online-install="compute-sharing"]').click();
    await expect(page.locator('[data-module-card="compute-sharing"]')).toBeVisible({ timeout: 5_000 });
    const packages = await page.evaluate(() => Object.keys(window.__ATL_E2E_STATE__.pluginPackages));
    expect(packages).toEqual(['compute-sharing/0.1.1']);
  });

  online('a plugin that was never downloaded says the cloud is unreachable', async ({ page }) => {
    await page.route('**/api/modules/remote/file/**', (route) => route.abort());
    await page.reload();
    await navigateTo(page, 'modules');
    const card = page.locator('[data-module-card="zhipu-plan"]');
    await expect(card).toContainText('This plugin is not on this device yet, and the cloud is unreachable.', { timeout: 5_000 });
    await expect(card).not.toContainText('Plugin failed to load');
  });

  online('uninstall still removes the card when the local copy cannot be deleted', async ({ page }) => {
    await openOnlineTab(page);
    await page.locator('[data-online-install="compute-sharing"]').click();
    await page.click('[data-modules-tab="installed"]');
    await expect(page.locator('[data-module-card="compute-sharing"]')).toBeVisible({ timeout: 5_000 });
    await page.evaluate(() => {
      window.tokenLeague.modulesPackageDelete = () => Promise.reject(new Error('eperm'));
    });
    await page.locator('[data-remote-uninstall="compute-sharing"]').click();
    await expect(page.locator('[data-module-card="compute-sharing"]')).toHaveCount(0);
    await expect(page.locator('#modules-status')).toContainText('local plugin copy could not be removed');
  });

  online('a downloaded plugin remounts after the package URL is gone', async ({ page }) => {
    await openOnlineTab(page);
    await page.locator('[data-online-install="compute-sharing"]').click();
    await page.click('[data-modules-tab="installed"]');
    const card = page.locator('[data-module-card="compute-sharing"]');
    await expect(card).toContainText('No claims yet.', { timeout: 5_000 });
    await page.route('**/api/modules/remote/file/compute-sharing/0.1.1/index.js', (route) => route.abort());
    await page.locator('[data-module-toggle="compute-sharing"]').click();
    await expect(card).not.toContainText('No claims yet.');
    await page.locator('[data-module-toggle="compute-sharing"]').click();
    await expect(card).toContainText('No claims yet.', { timeout: 5_000 });
    await expect(card).not.toContainText('Plugin failed to load');
  });
});

const onlineZh = scenarioTest({
  desktopAutoInitialized: false,
  language: 'zh-CN',
  apiBaseUrl: 'http://backend.test',
});

onlineZh.describe('Online plugins tab (zh-CN)', () => {
  onlineZh('defaults to the uninstalled filter', async ({ page }) => {
    await openOnlineTab(page);
    await expect(page.locator('[data-online-filter="uninstalled"]')).toHaveText('未安装');
    await expect(page.locator('[data-online-filter="installed"]')).toHaveText('已安装');
    await expect(page.locator('[data-online-filter="uninstalled"]')).toHaveClass(/active/);
    await expect(page.locator('#modules-online-list')).not.toContainText('智谱套餐用量');
    await page.click('[data-online-filter="installed"]');
    await expect(page.locator('#modules-online-list')).toContainText('智谱套餐用量');
  });
});
