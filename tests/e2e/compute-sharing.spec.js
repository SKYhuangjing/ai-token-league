// E2E: compute-sharing plugin (R29b merged) — one remote card with the owner
// console section (hidden when unregistered) and the borrowing directory.
// Routes mimic the distribution proxy + sharing control plane; the guarded
// sidecar channel is mocked in mock-tauri.js (sharing:* commands).
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { navigateTo } from './helpers.js';

const mockScript = readFileSync(resolve(import.meta.dirname, 'mock-tauri.js'), 'utf-8');
const pluginSource = readFileSync(resolve(import.meta.dirname, '../../plugins/compute-sharing/index.js'), 'utf-8');

const VERSION = '0.1.2';
const CATALOG = {
  version: 1,
  catalog: [
    { id: 'compute-sharing', version: VERSION, type: 'query', title: '算力共享', desc: 'merged card',
      entry: 'index.js', permissions: [
        'sidecar:sharing:claim-sign', 'sidecar:sharing:borrow-get', 'sidecar:sharing:borrow-set',
        'sidecar:sharing:owner-status', 'sidecar:sharing:owner-policy', 'sidecar:sharing:owner-unregister',
      ] },
  ],
};

const SHARES = {
  shares: [
    {
      shareId: 'shr_e2e1', title: 'E2E CPA', models: ['glm-*'], online: true, state: 'active',
      slotsLeft: 2, budgetTokens: 1000000, settledTokens: 1200, availableTokens: 998800,
      exhausted: false, updatedAt: Date.now(),
    },
  ],
};

function scenarioTest(config) {
  return base.extend({
    page: async ({ page }, use) => {
      await page.addInitScript(`window.__ATL_E2E_CONFIG__ = ${JSON.stringify(config)};`);
      await page.addInitScript(mockScript);
      // Routes precede goto: the modules screen renders during boot and the
      // guard reads permissions from the catalog entry.
      for (const [pattern, handler] of config.routes || []) {
        await page.route(pattern, handler);
      }
      await page.goto('/');
      await use(page);
    },
  });
}

const baseRoutes = [
  ['**/api/modules/remote/catalog', (route) => route.fulfill({ json: CATALOG })],
  [`**/api/modules/remote/file/compute-sharing/${VERSION}/index.js`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: pluginSource })],
  ['**/api/shares', (route) => route.fulfill({ json: SHARES })],
];

const installed = scenarioTest({
  desktopAutoInitialized: false,
  language: 'en',
  apiBaseUrl: 'http://backend.test',
  routes: baseRoutes,
  modules: { 'compute-sharing': { enabled: true, config: {}, installedVersion: VERSION } },
});

async function openCard(page) {
  await navigateTo(page, 'modules');
  await page.waitForSelector('[data-module-card="compute-sharing"]', { timeout: 5_000 });
  await page.waitForSelector('[data-cs="directory"]', { timeout: 5_000 });
}

installed.describe('Compute sharing (merged card, en)', () => {
  installed('owner section shows the ledger; borrow directory lists shares', async ({ page }) => {
    await openCard(page);
    // owner section visible with the mocked registered share
    await expect(page.locator('[data-cs="owner"]')).toBeVisible();
    await expect(page.locator('[data-cs="owner-body"]')).toContainText('Sky-Macbook CPA', { timeout: 5_000 });
    await expect(page.locator('[data-cs="owner-body"]')).toContainText('sky-dev');
    await expect(page.locator('[data-cs-policy="budget"]')).toBeVisible();
    // borrow directory + empty my-claims
    await expect(page.locator('[data-cs="directory"]')).toContainText('E2E CPA');
    await expect(page.locator('[data-cs="directory"]')).toContainText('1.2K / 1M');
    await expect(page.locator('[data-cs="mine"]')).toContainText('No claims yet.');
    // persisted install record + uninstall removes the card
    const state = await page.evaluate(() => window.__ATL_E2E_STATE__.modulesState.modules['compute-sharing']);
    expect(state.installedVersion).toBe(VERSION);
    await page.locator('[data-remote-uninstall="compute-sharing"]').click();
    await expect(page.locator('[data-module-card="compute-sharing"]')).toHaveCount(0);
  });

  installed('claim signs via the sidecar identity channel and renders integration env', async ({ page }) => {
    await page.route('**/api/shares/claim', async (route) => {
      const body = route.request().postDataJSON();
      if (!body.participantId || !body.signature || !body.ts) {
        await route.fulfill({ status: 401, json: { error: 'identity_required' } });
        return;
      }
      await route.fulfill({
        json: {
          keyId: 'csk_e2e99', token: 'atl_sk_e2e_secret', baseURL: 'http://192.168.1.4:8317',
          models: ['*'], expiresAt: Date.now() + 86400000, shareTitle: 'E2E CPA', keyMaxTokens: 200000,
        },
      });
    });
    await openCard(page);
    await page.locator('[data-cs-claim="shr_e2e1"]').click();
    await expect(page.locator('[data-cs="mine"]')).toContainText('atl_sk_e2e_secret', { timeout: 5_000 });
    await expect(page.locator('[data-cs="mine"]')).toContainText('OPENAI_BASE_URL=http://192.168.1.4:8317/v1');
    await expect(page.locator('[data-cs="mine"]')).toContainText('ANTHROPIC_BASE_URL=http://192.168.1.4:8317');
    const signs = await page.evaluate(() => window.__ATL_E2E_STATE__.borrowCalls.signs);
    expect(signs.at(-1)?.shareId).toBe('shr_e2e1');
    await expect(page.locator('#toast')).toContainText('Claimed');
  });

  installed('backend identity rejection surfaces a friendly error', async ({ page }) => {
    await page.route('**/api/shares/claim', (route) => route.fulfill({ status: 401, json: { error: 'invalid_signature' } }));
    await openCard(page);
    await page.locator('[data-cs-claim="shr_e2e1"]').click();
    await expect(page.locator('[data-cs="status"]')).toContainText('Identity verification failed', { timeout: 5_000 });
    await expect(page.locator('[data-cs="mine"]')).toContainText('No claims yet.');
  });

  installed('owner policy save sends the delta; stop confirms, unregisters, collapses the section', async ({ page }) => {
    await openCard(page);
    await page.locator('[data-cs-policy="budget"]').fill('2000000');
    await page.locator('[data-cs-policy="maxClaims"]').fill('8');
    await page.locator('[data-cs="savePolicy"]').click();
    await expect(page.locator('#toast')).toContainText('Policy saved.', { timeout: 5_000 });
    const policy = await page.evaluate(() => window.__ATL_E2E_STATE__.ownerCalls.policy.at(-1));
    expect(policy).toEqual({ budget: 2000000, maxClaims: 8 });
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-cs="stop"]').click();
    await expect(page.locator('#toast')).toContainText('Sharing stopped.', { timeout: 5_000 });
    // the owner section collapses entirely after unregister
    await expect(page.locator('[data-cs="owner"]')).toBeHidden({ timeout: 5_000 });
    expect(await page.evaluate(() => window.__ATL_E2E_STATE__.ownerCalls.unregistered)).toBe(true);
  });
});

const borrowerOnly = scenarioTest({
  desktopAutoInitialized: false,
  language: 'en',
  apiBaseUrl: 'http://backend.test',
  routes: baseRoutes,
  ownerNotRegistered: true,
  modules: { 'compute-sharing': { enabled: true, config: {}, installedVersion: VERSION } },
});

borrowerOnly('pure borrowers never see the owner section', async ({ page }) => {
  await openCard(page);
  await expect(page.locator('[data-cs="owner"]')).toBeHidden();
  await expect(page.locator('[data-cs="directory"]')).toContainText('E2E CPA');
});
