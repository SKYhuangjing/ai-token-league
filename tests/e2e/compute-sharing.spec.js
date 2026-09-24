// E2E: compute-sharing plugin (0.1.0 usability redesign) — borrow-first card
// with the unified sidecar flows (directory/live/claim/renew/revoke/models),
// tool-scoped access config generation, owner lane lifecycle
// (pause/resume/terminate + per-key revoke), policy backfill with node-sync
// tracking, and dead-claim receipts. The distribution proxy routes stay HTTP;
// every sharing data path rides the mocked sidecar channel (mock-tauri.js).
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { navigateTo } from './helpers.js';

const mockScript = readFileSync(resolve(import.meta.dirname, 'mock-tauri.js'), 'utf8');
const pluginSource = readFileSync(resolve(import.meta.dirname, '../../plugins/compute-sharing/index.js'), 'utf8');

const VERSION = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../plugins/compute-sharing/manifest.json'), 'utf8')).version;
const CATALOG = {
  version: 1,
  catalog: [
    { id: 'compute-sharing', version: VERSION, type: 'query', title: '算力共享', desc: 'merged card',
      entry: 'index.js', permissions: [
        'sidecar:compute-sharing:claim-sign', 'sidecar:compute-sharing:borrow-get', 'sidecar:compute-sharing:borrow-set',
        'sidecar:compute-sharing:borrow-test', 'sidecar:compute-sharing:directory', 'sidecar:compute-sharing:claim',
        'sidecar:compute-sharing:renew', 'sidecar:compute-sharing:revoke', 'sidecar:compute-sharing:live',
        'sidecar:compute-sharing:models', 'sidecar:compute-sharing:owner-status', 'sidecar:compute-sharing:owner-policy',
        'sidecar:compute-sharing:owner-resume', 'sidecar:compute-sharing:owner-suggest',
        'sidecar:compute-sharing:owner-unregister', 'sidecar:compute-sharing:owner-revoke-claim',
        'sidecar:compute-sharing:owner-lane-action', 'sidecar:compute-sharing:borrow-prune',
        'sidecar:compute-sharing:doctor',
      ] },
  ],
};

const SHARES = [
  {
    shareId: 'shr_e2e1', title: 'E2E CPA', models: ['*'], online: true, state: 'active',
    slotsLeft: 2, budgetTokens: 1000000, settledTokens: 1200, availableTokens: 998800,
    exhausted: false, updatedAt: Date.now(),
    lanes: [
      {
        id: 'gemini-week', title: 'Gemini weekly', models: ['gemini-*'], window: { unit: 'week', n: 1 },
        budgetTokens: 1000000, settledTokens: 1200, availableTokens: 998800, exhausted: false,
        state: 'active', open: true, retryAfterMs: 0, slotsLeft: 2, maxClaims: 3, tzLabel: 'UTC+8',
        schedule: [{ start: '22:00', end: '14:00' }], peak: { windows: [], multiplier: 1 },
      },
      {
        id: 'glm-offpeak', title: 'GLM off-peak', models: ['glm-5.3-flash'], window: { unit: 'hour', n: 5 },
        budgetTokens: 200000, settledTokens: 0, availableTokens: 200000, exhausted: false,
        state: 'active', open: false, retryAfterMs: 30 * 60_000, slotsLeft: 1, maxClaims: 2, tzLabel: 'UTC+8',
        schedule: [{ start: '22:00', end: '12:00' }], peak: { windows: [{ start: '14:00', end: '21:00' }], multiplier: 2 },
      },
    ],
  },
];

function scenarioTest(config) {
  return base.extend({
    page: async ({ page }, use) => {
      await page.addInitScript(`window.__ATL_E2E_CONFIG__ = ${JSON.stringify(config)};`);
      await page.addInitScript(mockScript);
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
];

const installed = scenarioTest({
  desktopAutoInitialized: false,
  language: 'en',
  apiBaseUrl: 'http://backend.test',
  routes: baseRoutes,
  shares: SHARES,
  modules: { 'compute-sharing': { enabled: true, config: {}, installedVersion: VERSION } },
});

const installedZh = scenarioTest({
  desktopAutoInitialized: false,
  language: 'zh-CN',
  apiBaseUrl: 'http://backend.test',
  routes: baseRoutes,
  shares: SHARES,
  modules: { 'compute-sharing': { enabled: true, config: {}, installedVersion: VERSION } },
});

for (const language of ['en', 'zh-CN']) {
  const offline = scenarioTest({
    desktopAutoInitialized: false, language, apiBaseUrl: 'http://backend.test',
    routes: baseRoutes, shares: SHARES, ownerNotRegistered: true, failDirectory: true,
    modules: { 'compute-sharing': { enabled: true, config: {}, installedVersion: VERSION } },
  });
  offline(`R3: ${language} control-plane freshness follows directory failure and recovery`, async ({ page }) => {
    await openCard(page);
    const strip = page.locator('[data-cs="dimstrip"]');
    const fresh = language === 'en' ? 'control plane just updated' : '控制面刚刚更新';
    const unknown = language === 'en' ? 'node status unknown' : '节点状态未知';
    await expect(strip).not.toContainText(fresh);
    await expect(strip).toContainText(unknown);
    await page.evaluate(() => { window.__ATL_E2E_STATE__.failDirectory = false; });
    await page.locator('[data-cs="refresh"]').click();
    await expect(strip).toContainText(fresh);
    await expect(strip).not.toContainText(unknown);
    await page.evaluate(() => { window.__ATL_E2E_STATE__.failDirectory = true; });
    await page.locator('[data-cs="refresh"]').click();
    await expect(strip).not.toContainText(fresh);
    await expect(strip).toContainText(unknown);
  });
}

async function openCard(page, tab = "borrow") {
  await navigateTo(page, 'modules');
  await page.waitForSelector('[data-module-card="compute-sharing"]', { timeout: 5_000 });
  await page.waitForSelector('[data-cs="directory"]', { state: 'attached', timeout: 5_000 });
  await page.waitForFunction(() => {
    const tabs = document.querySelector('[data-cs="tabs"]');
    return tabs && tabs.dataset.owner && tabs.dataset.owner !== "pending";
  }, { timeout: 5_000 });
  if (tab === "owner") {
    await page.locator('[data-cs-tab="owner"]').click({ timeout: 5_000 });
    await expect(page.locator('[data-cs="owner"]')).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(400);
  } else {
    // §4.1: borrow is the default surface — owners also land on it first
    await expect(page.locator('[data-cs="board"]')).toBeVisible({ timeout: 5_000 });
  }
}

installed.describe('Compute sharing (0.1.0 card, en)', () => {
  installed('borrow-first layout: trust note, dim strip, entry row hidden for owners, directory lanes', async ({ page }) => {
    await openCard(page, "borrow");
    const dir = page.locator('[data-cs="directory"]');
    await expect(dir).toContainText('E2E CPA', { timeout: 5_000 });
    // §7.2 trust note rides above the directory (content flow disclosure)
    await expect(page.locator('[data-cs="trust"]')).toContainText("sharer's CPA service");
    // §5.3 four-dimension strip renders fresh/claimable facts
    await expect(page.locator('[data-cs="dimstrip"]')).toContainText('control plane just updated', { timeout: 5_000 });
    await expect(page.locator('[data-cs="dimstrip"]')).toContainText('1/1 nodes online');
    await expect(page.locator('[data-cs="dimstrip"]')).toContainText('1 lanes claimable');
    // owners do not see the 我要分享 entry (they have the console)
    await expect(page.locator('[data-cs="entry"]')).toBeHidden();
    // lane rows: closed-until + peak rule + tz anchor
    await expect(dir).toContainText('Closed ·');
    await expect(dir).toContainText('Peak ×2 14:00–21:00');
    await expect(dir).toContainText('UTC+8');
    await expect(page.locator('[data-cs-claim-lane="gemini-week"]')).toBeEnabled();
    await expect(page.locator('[data-cs-claim-lane="glm-offpeak"]')).toBeDisabled(); // closed
  });

  installed('owner console: policy backfills real values; pending-sync badge when the node lags', async ({ page }) => {
    await openCard(page, "owner");
    const body = page.locator('[data-cs="owner-body"]');
    await expect(body).toContainText('Sky-Macbook CPA', { timeout: 5_000 });
    // F02: the advanced form shows the STORED values, not empty placeholders
    await expect(page.locator('[data-cs-policy="keyMaxTokens"]')).toHaveValue('200000');
    await expect(page.locator('[data-cs-policy="keyConcurrency"]')).toHaveValue('3');
    await expect(page.locator('[data-cs-policy="ttlHours"]')).toHaveValue('168');
    // the owner's exhausted lane surfaces its badge (GLM off-peak is drained)
    await expect(page.locator('[data-cs-lane="glm-offpeak"]')).toContainText('Window budget exhausted');
    // synced state (policyAckedRev == policyRev) shows no banner
    await expect(page.locator('.cs-pending')).toHaveCount(0);
    // simulate a policy change the node hasn't acked yet
    await page.evaluate(() => { window.__ATL_E2E_STATE__.ownerShare.share.policyRev = 5; window.__ATL_E2E_STATE__.ownerShare.share.policyAckedRev = 3; });
    await page.locator('[data-cs="refresh"]').click();
    await expect(page.locator('.cs-pending')).toContainText('not applied by the node yet', { timeout: 5_000 });
    await expect(page.locator('.cs-pending')).toContainText('(3/5)');
  });

  installed('owner lane lifecycle: pause keeps keys, terminate cascades (D2)', async ({ page }) => {
    await openCard(page, "owner");
    const body = page.locator('[data-cs="owner-body"]');
    await expect(body).toContainText('Sky-Macbook CPA', { timeout: 5_000 });
    // the valid gemini claim renders with a per-key revoke button (CS-07)
    await expect(page.locator('[data-cs-claim-revoke]')).toHaveCount(1);
    // pause: in-card confirm bar states keys are kept (wry renders no JS
    // dialogs — window.confirm was a silent no-op on the real app)
    await page.locator('[data-cs-lane-pause="0"]').click();
    const confirmBar = page.locator('.cs-confirm');
    await expect(confirmBar).toContainText('keys are kept', { timeout: 5_000 });
    await confirmBar.locator('[data-cs-confirm-yes]').click();
    await expect(page.locator('#toast')).toContainText('Lane paused', { timeout: 5_000 });
    const actions = await page.evaluate(() => window.__ATL_E2E_STATE__.ownerCalls.laneActions.at(-1));
    expect(actions).toMatchObject({ laneId: 'gemini-week', action: 'pause' });
    // D2: the paused lane's claim stays valid (no cascade)
    const claimsAfterPause = await page.evaluate(() => window.__ATL_E2E_STATE__.ownerShare.claims);
    expect(claimsAfterPause.filter((c) => c.laneId === 'gemini-week').some((c) => c.state === 'valid')).toBe(true);
    // paused lane renders its badge + a resume button
    await expect(page.locator('[data-cs-lane="gemini-week"]')).toContainText('Paused (keys kept)', { timeout: 5_000 });
    await page.locator('[data-cs-lane-resume2="0"]').click();
    await expect(page.locator('#toast')).toContainText('Lane resumed', { timeout: 5_000 });
    await expect(page.locator('[data-cs-lane="gemini-week"]')).toContainText('Online', { timeout: 5_000 });
    // terminate: confirm states the blast radius, cascade revokes
    await page.locator('[data-cs-lane-terminate="0"]').click();
    const terminateBar = page.locator('.cs-confirm');
    await expect(terminateBar).toContainText('cannot be undone', { timeout: 5_000 });
    await terminateBar.locator('[data-cs-confirm-yes]').click();
    await expect(page.locator('#toast')).toContainText('Lane terminated', { timeout: 5_000 });
    const claimsAfterTerminate = await page.evaluate(() => window.__ATL_E2E_STATE__.ownerShare.claims);
    expect(claimsAfterTerminate.filter((c) => c.laneId === 'gemini-week').every((c) => c.state !== 'valid')).toBe(true);
    // per-key revoke: only that key flips, with an audit reason (re-seed a
    // valid claim first — the terminate cascade above consumed the old one)
    await page.evaluate(() => {
      const claim = window.__ATL_E2E_STATE__.ownerShare.claims[0];
      claim.state = 'valid';
      claim.revokedBy = undefined;
      claim.revokeReason = undefined;
    });
    await page.locator('[data-cs="refresh"]').click();
    await expect(page.locator('[data-cs-claim-revoke]')).toHaveCount(1, { timeout: 5_000 });
    await page.locator('[data-cs-claim-revoke]').first().click();
    await page.locator('.cs-confirm [data-cs-confirm-yes]').click();
    await expect(page.locator('#toast')).toContainText('Key revoked', { timeout: 5_000 });
    const revokedClaim = await page.evaluate(() => window.__ATL_E2E_STATE__.ownerShare.claims.find((c) => c.revokedBy === 'owner'));
    expect(revokedClaim).toBeTruthy();
  });

  installed('claim rides the sidecar flow; same-resource guard replaces the CTA; quota renders', async ({ page }) => {
    await openCard(page, "borrow");
    // claim via the unified flow: one click mints into the store
    await page.locator('[data-cs-claim-lane="gemini-week"]').click();
    await expect(page.locator('[data-cs="mine"]')).toContainText('csk_e2e99', { timeout: 5_000 });
    await expect(page.locator('#toast')).toContainText('Claimed');
    // quota line (F02): per-key cap + charged/raw split + lane remaining
    const quota = page.locator('[data-cs="mine"] .cs-quota').first();
    await expect(quota).toContainText('Per-key cap');
    await expect(quota).toContainText('200K');
    // API access puts the masked key and protocol URLs ahead of tool commands.
    const access = page.locator('[data-cs-access="csk_e2e99"]');
    await expect(access).toContainText('API access');
    await expect(access).toContainText('Tool setup');
    await expect(access.locator('[data-cs-endpoint="openai"] code')).toHaveText('http://192.168.1.4:8317/v1');
    await expect(access.locator('[data-cs-endpoint="claude"] code')).toHaveText('http://192.168.1.4:8317');
    const toolSelect = page.locator('[data-cs-tool="csk_e2e99"]');
    await expect(toolSelect).toHaveValue('claude');
    await expect(page.locator('[data-cs="mine"]')).toContainText('ANTHROPIC_BASE_URL');
    // secrets stay masked in the DOM until revealed (C5)
    await expect(page.locator('[data-cs="mine"]')).not.toContainText('atl_sk_e2e_secret');
    await expect(access.locator('[data-cs-api-key]')).toHaveText('atl_sk_e…cret');
    // model discovery populates the picker with the lane-scoped catalog
    const modelSelect = page.locator('[data-cs-model="csk_e2e99"]');
    await expect(modelSelect).toBeVisible({ timeout: 5_000 });
    await expect(modelSelect.locator('option', { hasText: 'gemini-3.8-flash-high' })).toHaveCount(1);
    await modelSelect.selectOption('gemini-3.8-flash-high');
    // protocol test rides the tool's protocol (claude → anthropic)
    await expect(page.locator('[data-cs="mine"] .cs-test-row .cs-lane-tag').first()).toContainText('anthropic');
    await page.locator('[data-cs-test="csk_e2e99"]').click();
    await expect(page.locator('[data-cs-test-result="csk_e2e99"]')).toContainText('gemini-3.8-flash-high reachable', { timeout: 5_000 });
    // copy-all emits the tool-scoped block with the chosen model
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await access.locator('[data-cs-copy-key]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('atl_sk_e2e_secret');
    await access.locator('[data-cs-endpoint="openai"] [data-cs-copy-endpoint]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('http://192.168.1.4:8317/v1');
    await access.locator('[data-cs-endpoint="claude"] [data-cs-copy-endpoint]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('http://192.168.1.4:8317');
    await page.locator('[data-cs="mine"] button', { hasText: 'Copy all' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe([
        'export ANTHROPIC_BASE_URL=http://192.168.1.4:8317',
        'export ANTHROPIC_AUTH_TOKEN=atl_sk_e2e_secret',
        'export ANTHROPIC_MODEL=gemini-3.8-flash-high',
      ].join('\n'));
    // same-resource guard (§4.3): the directory now shows 查看配置 instead of claim
    await expect(page.locator('[data-cs-claim-lane="gemini-week"]')).toHaveCount(0);
    await expect(page.locator('[data-cs-view-config]')).toHaveCount(1);
    await expect(page.locator('[data-cs="directory"]')).toContainText('already hold a valid key');
    // renewal keeps the same key when under a day is left
    await page.evaluate(() => {
      const claim = window.__ATL_E2E_STATE__.borrowStore.claims[0];
      claim.expiresAt = Date.now() + 3_600_000;
    });
    await page.locator('[data-cs="refresh"]').click();
    const renewButton = page.locator('[data-cs="mine"] button', { hasText: 'Renew' });
    await expect(renewButton).toBeVisible({ timeout: 5_000 });
    await renewButton.click();
    await expect(page.locator('#toast')).toContainText('Renewed', { timeout: 5_000 });
    const stored = await page.evaluate(() => window.__ATL_E2E_STATE__.borrowStore.claims);
    expect(stored.find((c) => c.keyId === 'csk_e2e99').expiresAt).toBeGreaterThan(Date.now() + 6 * 86400000);
  });

  installed('codex tool preset: responses protocol + powershell dialect + toml snippet', async ({ page }) => {
    await openCard(page, "borrow");
    await page.locator('[data-cs-claim-lane="gemini-week"]').click();
    await expect(page.locator('[data-cs="mine"]')).toContainText('csk_e2e99', { timeout: 5_000 });
    const key = 'csk_e2e99';
    await page.locator(`[data-cs-tool="${key}"]`).selectOption('codex');
    await expect(page.locator('[data-cs="mine"]')).toContainText('OPENAI_BASE_URL');
    // responses protocol rides the test row
    await expect(page.locator('[data-cs="mine"] .cs-test-row .cs-lane-tag').first()).toContainText('responses');
    // powershell dialect quotes values with $env:
    await page.locator(`[data-cs-shell="${key}"]`).selectOption('powershell');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('[data-cs="mine"] button', { hasText: 'Copy all' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe([
        '$env:OPENAI_BASE_URL = "http://192.168.1.4:8317/v1"',
        '$env:OPENAI_API_KEY = "atl_sk_e2e_secret"',
        // the discovered catalog default-selects a concrete model
        '$env:OPENAI_MODEL = "gemini-3.8-flash-high"',
      ].join('\n'));
    // the persistent config snippet renders inline (env-only does not route Codex)
    await expect(page.locator('[data-cs-codex-config="csk_e2e99"]')).toContainText('[model_providers.atl-share]');
  });

  installed('manual model choice updates the copied tool command', async ({ page }) => {
    await openCard(page, 'borrow');
    await page.locator('[data-cs-claim-lane="gemini-week"]').click();
    const key = 'csk_e2e99';
    const picker = page.locator(`[data-cs-model="${key}"]`);
    await expect(picker).toBeVisible();
    await picker.selectOption('__manual');
    const input = page.locator(`[data-cs-model-input="${key}"]`);
    await expect(input).toBeVisible();
    await input.fill('gemini-3.7-pro');
    await input.press('Tab');
    await expect(page.locator(`[data-cs-access="${key}"] .cs-env-preview`).first())
      .toContainText('ANTHROPIC_MODEL=gemini-3.7-pro');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator(`[data-cs-access="${key}"] button`, { hasText: 'Copy all' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('export ANTHROPIC_MODEL=gemini-3.7-pro');
  });

  const seeded = scenarioTest({
    desktopAutoInitialized: false,
    language: 'en',
    apiBaseUrl: 'http://backend.test',
    routes: baseRoutes,
    shares: SHARES,
    modules: { 'compute-sharing': { enabled: true, config: {}, installedVersion: VERSION } },
    borrowClaims: [{
      keyId: 'csk_rev1', shareId: 'shr_e2e1', shareTitle: 'E2E CPA',
      laneId: 'gemini-week', laneTitle: 'Gemini weekly', models: ['gemini-*'], tzLabel: 'UTC+8',
      baseURL: 'http://192.168.1.4:8317', expiresAt: Date.now() + 3_600_000,
    }],
  });

  seeded('a claim revoked by the owner is deleted locally WITH a receipt', async ({ page }) => {
    await openCard(page, "borrow");
    // set the live view AFTER the card settles (the initial refresh may
    // already have consumed the pre-evaluate state), then force a refresh —
    // deterministic regardless of mount timing
    await page.evaluate(() => {
      window.__ATL_E2E_STATE__.liveClaims = [{ keyId: 'csk_rev1', state: 'revoked', usedTokens: 0, shareTitle: 'E2E CPA', laneTitle: 'Gemini weekly' }];
    });
    await page.locator('[data-cs="refresh"]').click();
    await expect(page.locator('[data-cs="mine"]')).toContainText('No claims yet.', { timeout: 5_000 });
    // §5.3: the disappearance is explained — a receipt names the share/lane/reason
    await expect(page.locator('[data-cs="mine"] .cs-receipt')).toContainText('Removed 1 dead claims');
    await expect(page.locator('[data-cs="mine"] .cs-receipt')).toContainText('E2E CPA/Gemini weekly(revoked)');
    const store = await page.evaluate(() => window.__ATL_E2E_STATE__.borrowStore.claims);
    expect(store).toHaveLength(0);
    // the cleanup rides the atomic borrow-prune command (QA-05)
    const prunes = await page.evaluate(() => (window.__ATL_E2E_STATE__.sidecarCalls || []).filter((c) => c.command === 'compute-sharing:borrow-prune').length);
    expect(prunes).toBeGreaterThan(0);
  });

  seeded('expired claims report through the borrow-get removal receipts', async ({ page }) => {
    await openCard(page, "borrow");
    await page.evaluate(() => {
      window.__ATL_E2E_STATE__.borrowStore = { claims: [], removed: [
        { keyId: 'csk_old1', shareTitle: 'E2E CPA', laneTitle: 'Gemini weekly', reason: 'expired' },
      ] };
    });
    await page.locator('[data-cs="refresh"]').click();
    await expect(page.locator('[data-cs="mine"] .cs-receipt')).toContainText('(expired)', { timeout: 5_000 });
  });

  installed('backend lane rejection surfaces a friendly error via the unified flow', async ({ page }) => {
    await page.evaluate(() => {
      window.__ATL_E2E_STATE__.claimError = 'lane_closed';
      // make the gemini lane claimable-looking so the button is clickable
      const lane = window.__ATL_E2E_STATE__.shares[0].lanes[0];
      lane.exhausted = false;
      lane.settledTokens = 0;
      lane.availableTokens = lane.budgetTokens;
    });
    await openCard(page, "borrow");
    await page.locator('[data-cs-claim-lane="gemini-week"]').click();
    await expect(page.locator('[data-cs="status"]')).toContainText('outside its open hours', { timeout: 5_000 });
    await expect(page.locator('[data-cs="mine"]')).toContainText('No claims yet.');
  });

  installed('lane editing saves the full lane set; editor survives refresh; window shapes preserved', async ({ page }) => {
    await openCard(page, "owner");
    await page.locator('[data-cs-lane-edit="0"]').click();
    await expect(page.locator('[data-cs="lane-form"]')).toBeVisible();
    await page.locator('[data-cs-f="budget"]').fill('200000000');
    // review-A1 regression: a card refresh mid-edit must not wipe the form
    const fetchesBefore = () => page.evaluate(() => window.__ATL_E2E_STATE__.directoryFetches);
    const before = await fetchesBefore();
    await page.locator('[data-cs="refresh"]').click();
    await expect(page.locator('[data-cs-f="budget"]')).toHaveValue('200000000', { timeout: 5_000 });
    await expect(page.locator('[data-cs="budgetHint"]')).toContainText('200M');
    await page.locator('[data-cs="laneSave"]').click();
    await expect(page.locator('#toast')).toContainText('Lane saved', { timeout: 5_000 });
    // a lane save forces the directory refetch through the unified flow
    await expect.poll(fetchesBefore, { timeout: 5_000 }).toBeGreaterThan(before);
    const lanes = await page.evaluate(() => window.__ATL_E2E_STATE__.ownerCalls.lanes.at(-1));
    expect(lanes).toHaveLength(2);
    const gemini = lanes.find((l) => l.id === 'gemini-week');
    expect(gemini.budget.tokens).toBe(200000000);
    expect(gemini.window).toEqual({ unit: 'week', n: 1 });
    const glmPassThrough = lanes.find((l) => l.id === 'glm-offpeak');
    expect(glmPassThrough.window).toEqual({ unit: 'hour', n: 5 });
    // a full save without explicit state keeps a paused lane paused (§8)
    await page.evaluate(() => { window.__ATL_E2E_STATE__.ownerShare.share.lanes[0].state = 'paused'; });
    await page.locator('[data-cs="refresh"]').click();
    await page.locator('[data-cs-lane-edit="0"]').click();
    await page.locator('[data-cs="laneSave"]').click();
    const afterPausedSave = await page.evaluate(() => window.__ATL_E2E_STATE__.ownerShare.share.lanes.find((l) => l.id === 'gemini-week').state);
    expect(afterPausedSave).toBe('paused');
  });

  installed('editing a GLM lane persists model scope and open hours', async ({ page }) => {
    await openCard(page, 'owner');
    // serde_json reorders object keys across the native sidecar boundary.
    await page.evaluate(() => { window.__ATL_E2E_STATE__.reorderOwnerLaneFields = true; });
    await page.locator('[data-cs-lane-edit="1"]').click();
    await page.locator('[data-cs-f="models"]').fill('glm-5.3');
    await page.locator('[data-cs-f="winStart"]').fill('08:00');
    await page.locator('[data-cs-f="winEnd"]').fill('20:00');
    await expect(page.locator('[data-cs-f="winStart"]')).toHaveAttribute('type', 'text');
    await page.evaluate(() => {
      window.__oldLaneForm = document.querySelector('[data-cs="lane-form"]');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => !window.__oldLaneForm.isConnected);
    await expect(page.locator('[data-cs-f="winStart"]')).toHaveValue('08:00');
    await expect(page.locator('[data-cs-f="winEnd"]')).toHaveValue('20:00');
    await page.locator('[data-cs="laneSave"]').click();
    await expect(page.locator('#toast')).toContainText('Lane saved', { timeout: 5_000 });
    const wire = await page.evaluate(() => window.__ATL_E2E_STATE__.ownerCalls.lanes.at(-1).find((lane) => lane.id === 'glm-offpeak'));
    expect(wire.models).toEqual(['glm-5.3']);
    expect(wire.schedule).toEqual({ windows: [{ start: '08:00', end: '20:00' }] });
    await expect(page.locator('[data-cs-lane="glm-offpeak"]')).toContainText('glm-5.3');
    await expect(page.locator('[data-cs-lane="glm-offpeak"]')).toContainText('08:00–20:00');
  });

  installed('invalid 24-hour time cannot silently become an all-day lane', async ({ page }) => {
    await openCard(page, 'owner');
    await page.locator('[data-cs-lane-edit="1"]').click();
    await page.locator('[data-cs-f="winStart"]').fill('8:00');
    await page.locator('[data-cs-f="winEnd"]').fill('20:00');
    await page.locator('[data-cs="laneSave"]').click();
    await expect(page.locator('[data-cs="status"]')).toContainText('24-hour HH:MM', { timeout: 5_000 });
    expect(await page.evaluate(() => window.__ATL_E2E_STATE__.ownerCalls.lanes)).toHaveLength(0);
    await expect(page.locator('[data-cs-f="winStart"]')).toHaveValue('8:00');
  });

  installed('a confirmed lane save says when CPA has not applied the new revision yet', async ({ page }) => {
    await openCard(page, 'owner');
    await page.locator('[data-cs-lane-edit="1"]').click();
    await page.locator('[data-cs-f="models"]').fill('glm-5.3');
    await page.evaluate(() => {
      const share = window.__ATL_E2E_STATE__.ownerShare.share;
      share.policyRev = 5;
      share.policyAckedRev = 3;
    });
    await page.locator('[data-cs="laneSave"]').click();
    await expect(page.locator('#toast')).toContainText('waiting for the node to apply it', { timeout: 5_000 });
  });

  installed('a successful owner-policy response cannot claim a lane was saved when writes were ignored', async ({ page }) => {
    await openCard(page, 'owner');
    await page.locator('[data-cs-lane-edit="1"]').click();
    await page.locator('[data-cs-f="models"]').fill('glm-5.3');
    await page.evaluate(() => { window.__ATL_E2E_STATE__.ignoreOwnerLaneWrites = true; });
    await page.locator('[data-cs="laneSave"]').click();
    await expect(page.locator('[data-cs="status"]')).toContainText('server did not confirm', { timeout: 5_000 });
    await expect(page.locator('[data-cs-f="models"]')).toHaveValue('glm-5.3');
    await expect(page.locator('[data-cs-lane="glm-offpeak"]')).toContainText('glm-5.3-flash');
    await page.evaluate(() => { window.__ATL_E2E_STATE__.ignoreOwnerLaneWrites = false; });
    await page.locator('[data-cs="laneSave"]').click();
    await expect(page.locator('[data-cs-lane="glm-offpeak"]')).toContainText('glm-5.3');
  });

  installed('the save receipt waits for owner-status readback', async ({ page }) => {
    await openCard(page, 'owner');
    await page.locator('[data-cs-lane-edit="1"]').click();
    await page.locator('[data-cs-f="models"]').fill('glm-5.3');
    await page.evaluate(() => {
      const state = window.__ATL_E2E_STATE__;
      state.ownerStatusLaneOverride = structuredClone(state.ownerShare.share.lanes);
    });
    await page.locator('[data-cs="laneSave"]').click();
    await expect(page.locator('[data-cs="status"]')).toContainText('server did not confirm', { timeout: 5_000 });
    await expect(page.locator('[data-cs-f="models"]')).toHaveValue('glm-5.3');
    await page.evaluate(() => { window.__ATL_E2E_STATE__.ownerStatusLaneOverride = null; });
    await page.locator('[data-cs="laneSave"]').click();
    await expect(page.locator('[data-cs-lane="glm-offpeak"]')).toContainText('glm-5.3');
  });

  installed('a later refresh cannot replace the confirmed lane with old values and still show success', async ({ page }) => {
    await openCard(page, 'owner');
    await page.locator('[data-cs-lane-edit="1"]').click();
    await page.locator('[data-cs-f="models"]').fill('glm-5.3');
    await page.evaluate(() => {
      const state = window.__ATL_E2E_STATE__;
      state.ownerStatusLaneOverride = structuredClone(state.ownerShare.share.lanes);
      state.ownerStatusLaneOverrideOnCall = state.ownerCalls.status + 2;
    });
    await page.locator('[data-cs="laneSave"]').click();
    await expect(page.locator('[data-cs="status"]')).toContainText('server did not confirm', { timeout: 5_000 });
    await expect(page.locator('[data-cs-f="models"]')).toHaveValue('glm-5.3');
  });

  installed('reference ratio: suggestions recalculate and persist the new field (F03)', async ({ page }) => {
    await openCard(page, "owner");
    const body = page.locator('[data-cs="owner-body"]');
    await expect(body).toContainText('Quota reference', { timeout: 5_000 });
    // default reference 75% → 1.3B own use suggests 975M
    await expect(body).toContainText('weekly budget ≤ 975M');
    await page.locator('[data-cs-family="0"]').click();
    await expect(page.locator('[data-cs-f="budget"]')).toHaveValue('975000000');
    await expect(page.locator('[data-cs-f="winStart"]')).toHaveValue('21:00');
    await page.locator('[data-cs="laneCancel"]').click();
    // reference 50% → 650M, persisted as referencePct (the old reservePct
    // key is gone)
    const reserve = page.locator('[data-cs="reserve"]');
    await reserve.fill('50');
    await reserve.dispatchEvent('change');
    await expect(body).toContainText('weekly budget ≤ 650M', { timeout: 5_000 });
    const saved = await page.evaluate(() => window.__ATL_E2E_STATE__.modulesSetCalls.at(-1));
    expect(saved).toMatchObject({ id: 'compute-sharing', config: { referencePct: 50 } });
    await reserve.fill('200');
    await reserve.dispatchEvent('change');
    await expect(page.locator('[data-cs="reserve"]')).toHaveValue('95');
  });

  installed('owner-status failure keeps the last view with a retry banner (F05)', async ({ page }) => {
    await openCard(page, "owner");
    await expect(page.locator('[data-cs="owner-body"]')).toContainText('Sky-Macbook CPA', { timeout: 5_000 });
    await page.evaluate(() => { window.__ATL_E2E_STATE__.failOwnerStatus = true; });
    await page.locator('[data-cs="refresh"]').click();
    // the view survives with the stale banner + retry (not a collapse)
    await expect(page.locator('[data-cs="owner-body"]')).toContainText('Sky-Macbook CPA', { timeout: 5_000 });
    await expect(page.locator('.cs-wall', { hasText: 'Temporarily unable to update' })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-cs="retryOwner"]')).toBeVisible();
    // retry with the backend back restores a clean view
    await page.evaluate(() => { window.__ATL_E2E_STATE__.failOwnerStatus = false; });
    await page.locator('[data-cs="retryOwner"]').click();
    await expect(page.locator('.cs-wall', { hasText: 'Temporarily unable to update' })).toHaveCount(0, { timeout: 5_000 });
  });

  installed('advanced policy save sends the delta; stop/resume cycle keeps the console', async ({ page }) => {
    await openCard(page, "owner");
    await page.locator('[data-cs-policy="keyMaxTokens"]').fill('300000');
    await page.locator('[data-cs-policy="ttlHours"]').fill('72');
    await page.locator('[data-cs="savePolicy"]').click();
    await expect(page.locator('#toast')).toContainText('Policy saved.', { timeout: 5_000 });
    const policy = await page.evaluate(() => window.__ATL_E2E_STATE__.ownerCalls.policy.at(-1));
    // F02: backfilled inputs ride along — the delta now carries every stored knob
    expect(policy).toEqual({ keyMaxTokens: 300000, keyConcurrency: 3, ttlHours: 72 });
    await page.locator('[data-cs="stop"]').click();
    await page.locator('.cs-confirm [data-cs-confirm-yes]').click();
    await expect(page.locator('#toast')).toContainText('Sharing stopped.', { timeout: 5_000 });
    await expect(page.locator('[data-cs="owner-body"]')).toContainText('Stopped', { timeout: 5_000 });
    await page.locator('[data-cs="resume"]').click();
    await expect(page.locator('#toast')).toContainText('Sharing resumed', { timeout: 5_000 });
    await expect(page.locator('[data-cs-lane-edit="0"]')).toBeVisible({ timeout: 5_000 });
  });

  installed('QA-06/R2-06: dirty drafts survive refresh; untouched fields follow the server', async ({ page }) => {
    await openCard(page, "owner");
    const input = page.locator('[data-cs-policy="keyMaxTokens"]');
    await expect(input).toHaveValue('200000', { timeout: 5_000 });
    await input.fill('123456');
    await expect(input).toHaveValue('123456'); // isolation guard
    // server updates ttlHours while the user's draft sits in keyMaxTokens
    await page.evaluate(() => { window.__ATL_E2E_STATE__.ownerShare.share.policy.ttlHours = 350; });
    await page.locator('[data-cs="refresh"]').click();
    // the DIRTY field keeps the user's value across the rebuild…
    await expect(input).toHaveValue('123456', { timeout: 5_000 });
    // …the UNTOUCHED field follows the fresh server snapshot (R2-06B)
    await expect(page.locator('[data-cs-policy="ttlHours"]')).toHaveValue('350', { timeout: 5_000 });
    // saving persists the dirty value and clears the draft
    await page.locator('[data-cs="savePolicy"]').click();
    await expect(page.locator('#toast')).toContainText('Policy saved.', { timeout: 5_000 });
    const policy = await page.evaluate(() => window.__ATL_E2E_STATE__.ownerCalls.policy.at(-1));
    expect(policy.keyMaxTokens).toBe(123456);
    // after the save the field shows the server-normalized value again
    await page.locator('[data-cs="refresh"]').click();
    await expect(input).toHaveValue('123456', { timeout: 5_000 });
  });

  installed('R2-06A: the lane editor keeps focus across the auto refresh', async ({ page }) => {
    await openCard(page, "owner");
    await page.locator('[data-cs-lane-edit="0"]').click();
    const title = page.locator('[data-cs-f="title"]');
    await title.click();
    await title.fill('焦点保持测试');
    // trigger a refresh WITHOUT a focus-stealing click: the visibility
    // handler runs the same merged refresh the 15s poll uses
    for (let round = 0; round < 2; round += 1) {
      await page.evaluate(() => {
        window.__r3OldLaneTitle = document.querySelector('[data-cs-f="title"]');
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForFunction(() => !window.__r3OldLaneTitle.isConnected);
      await expect(title).toHaveValue('焦点保持测试', { timeout: 5_000 });
      await expect(title).toBeFocused({ timeout: 5_000 });
    }
    await page.locator('[data-cs="laneCancel"]').click();
  });

  installed('V10/R2-07: a fresh claim shows the node-sync wait, retries, then a final verdict', async ({ page }) => {
    base.setTimeout(45_000);
    await openCard(page, "borrow");
    await page.evaluate(() => { window.__ATL_E2E_STATE__.borrowTestFirstFail = true; window.__ATL_E2E_STATE__.borrowTestCalls = 0; });
    await page.locator('[data-cs-claim-lane="gemini-week"]').click();
    await expect(page.locator('[data-cs="mine"]')).toContainText('csk_e2e99', { timeout: 5_000 });
    // the sync-wait hint rides the claim card until the next heartbeat lands
    await expect(page.locator('[data-cs="mine"]').locator('.cs-pending')).toContainText('Waiting for node sync', { timeout: 5_000 });
    // first probe fails inside the window → the card RETRIES (5s apart)
    // instead of dead-ending on the wait copy (R2-07); the node then syncs
    // and the final verdict reads success
    await page.locator('[data-cs-test="csk_e2e99"]').click();
    await expect(page.locator('[data-cs-test-result="csk_e2e99"]')).toContainText('reachable', { timeout: 25_000 });
    const calls = await page.evaluate(() => window.__ATL_E2E_STATE__.borrowTestCalls);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  installed('R3: an old policy focus never steals a later button or tab focus', async ({ page }) => {
    await openCard(page, "owner");
    const field = page.locator('[data-cs-policy="keyMaxTokens"]');
    await field.fill('123456');
    await page.evaluate(() => {
      window.__ATL_E2E_STATE__.ownerShare.share.policy.ttlHours = 350;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('[data-cs-policy="ttlHours"]')).toHaveValue('350');
    await expect(field).toBeFocused();
    await page.evaluate(() => { window.__ATL_E2E_STATE__.ownerShare.share.policy.ttlHours = 351; });
    const refreshButton = page.locator('[data-cs="refresh"]');
    await refreshButton.click();
    await expect(page.locator('[data-cs-policy="ttlHours"]')).toHaveValue('351');
    await expect(refreshButton).toBeFocused();
    await page.locator('[data-cs-tab="borrow"]').click();
    await page.evaluate(() => {
      window.__r3OldPolicy = document.querySelector('[data-cs-policy="keyMaxTokens"]');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => !window.__r3OldPolicy.isConnected);
    await expect(page.locator('[data-cs-tab="borrow"]')).toBeFocused();
  });

  installed('R3: manual success cancels the old sync retry and its waiting badge', async ({ page }) => {
    await openCard(page);
    await page.evaluate(() => { window.__ATL_E2E_STATE__.borrowTestFirstFail = true; });
    await page.locator('[data-cs-claim-lane="gemini-week"]').click();
    const button = page.locator('[data-cs-test="csk_e2e99"]');
    const result = page.locator('[data-cs-test-result="csk_e2e99"]');
    await button.click();
    await expect(result).toContainText('Waiting for node sync');
    await page.locator('[data-cs="refresh"]').click();
    await button.click();
    await expect(result).toContainText('reachable');
    await expect.soft(page.locator('[data-cs="mine"] .cs-pending')).toHaveCount(0);
    await page.waitForTimeout(5500);
    expect(await page.evaluate(() => window.__ATL_E2E_STATE__.borrowTestCalls)).toBe(2);
  });

  installed('R3: an in-flight probe updates the current claim row after a refresh', async ({ page }) => {
    await openCard(page);
    await page.locator('[data-cs-claim-lane="gemini-week"]').click();
    await page.evaluate(() => { window.__ATL_E2E_STATE__.borrowTestDelayMs = 800; });
    await page.locator('[data-cs-test="csk_e2e99"]').click();
    await page.evaluate(() => {
      window.__r3ProbeRow = document.querySelector('[data-cs-test-result="csk_e2e99"]');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => !window.__r3ProbeRow.isConnected);
    await expect(page.locator('[data-cs-test-result="csk_e2e99"]')).toContainText('reachable', { timeout: 3000 });
  });

  installed('R3: an older in-flight failure cannot replace a newer manual success', async ({ page }) => {
    await openCard(page);
    await page.locator('[data-cs-claim-lane="gemini-week"]').click();
    await page.evaluate(() => {
      window.__ATL_E2E_STATE__.borrowTestDelayMs = 900;
      window.__ATL_E2E_STATE__.borrowTestResult = { ok: false, status: 401, error: 'older failed probe' };
    });
    const button = page.locator('[data-cs-test="csk_e2e99"]');
    await button.click();
    await page.evaluate(() => {
      window.__ATL_E2E_STATE__.borrowTestDelayMs = 0;
      window.__ATL_E2E_STATE__.borrowTestResult = null;
    });
    await button.click();
    const result = page.locator('[data-cs-test-result="csk_e2e99"]');
    await expect(result).toContainText('reachable');
    await page.waitForTimeout(1200);
    await expect(result).toContainText('reachable');
    await page.waitForTimeout(5000);
    expect(await page.evaluate(() => window.__ATL_E2E_STATE__.borrowTestCalls)).toBe(2);
    await expect(page.locator('[data-cs="mine"] .cs-pending')).toHaveCount(0);
  });

  installed('R3: a permanently unsynced key reaches a final failure within four probes', async ({ page }) => {
    base.setTimeout(40000);
    await openCard(page);
    await page.evaluate(() => { window.__ATL_E2E_STATE__.borrowTestResult = { ok: false, status: 401, error: 'key not synced yet' }; });
    await page.locator('[data-cs-claim-lane="gemini-week"]').click();
    await page.locator('[data-cs-test="csk_e2e99"]').click();
    const result = page.locator('[data-cs-test-result="csk_e2e99"]');
    await expect(result).toContainText('401', { timeout: 22000 });
    await expect(result).not.toContainText('Waiting');
    await expect(page.locator('[data-cs="mine"] .cs-pending')).toHaveCount(0);
    expect(await page.evaluate(() => window.__ATL_E2E_STATE__.borrowTestCalls)).toBe(4);
    await page.waitForTimeout(5500);
    expect(await page.evaluate(() => window.__ATL_E2E_STATE__.borrowTestCalls)).toBe(4);
  });

  for (const lifecycle of ['hidden', 'removed']) {
    installed(`R3: a ${lifecycle} card cancels its pending sync probe`, async ({ page }) => {
      await openCard(page);
      await page.evaluate(() => { window.__ATL_E2E_STATE__.borrowTestFirstFail = true; });
      await page.locator('[data-cs-claim-lane="gemini-week"]').click();
      await page.locator('[data-cs-test="csk_e2e99"]').click();
      await expect(page.locator('[data-cs-test-result="csk_e2e99"]')).toContainText('Waiting for node sync');
      if (lifecycle === 'hidden') await navigateTo(page, 'overview');
      else await page.locator('[data-module-card="compute-sharing"]').evaluate((card) => card.remove());
      await page.waitForTimeout(5500);
      expect(await page.evaluate(() => window.__ATL_E2E_STATE__.borrowTestCalls)).toBe(1);
      if (lifecycle === 'hidden') {
        await navigateTo(page, 'modules');
        await expect(page.locator('[data-cs-test-result="csk_e2e99"]')).toContainText('Test paused');
        await expect(page.locator('[data-cs="mine"] .cs-pending')).toHaveCount(0);
      }
    });
  }

  installed('QA-07: navigating away stops the sharing poller', async ({ page }) => {
    await openCard(page, "borrow");
    const callsAtStart = () => page.evaluate(() => (window.__ATL_E2E_STATE__.sidecarCalls || []).filter((c) => c.command === 'compute-sharing:owner-status').length);
    await page.locator('button', { hasText: 'Overview' }).first().click();
    const before = await callsAtStart();
    await page.waitForTimeout(16_000);
    const after = await callsAtStart();
    expect(after).toBe(before); // hidden panel → no poll, no invoke growth
  });

  installed('F07: model-family filter tiers the FILTERED lane set, not all lanes', async ({ page }) => {
    // node with a claimable gemini lane + a suspended gpt lane: filter gpt-* +
    // only-available must NOT surface the node as claimable via the gemini lane
    await page.evaluate(() => {
      window.__ATL_E2E_STATE__.shares = [{
        shareId: 'shr_mix', title: 'Mixed node', models: ['*'], online: true, state: 'active',
        slotsLeft: 2, budgetTokens: 1000000, settledTokens: 0, availableTokens: 1000000, exhausted: false,
        updatedAt: Date.now(),
        lanes: [
          { id: 'gem', title: 'Gem lane', models: ['gemini-*'], window: { unit: 'day', n: 1 }, budgetTokens: 1000000, settledTokens: 0, availableTokens: 1000000, exhausted: false, state: 'active', open: true, retryAfterMs: 0, slotsLeft: 2, maxClaims: 3, tzLabel: 'UTC+8', schedule: [], peak: { windows: [], multiplier: 1 } },
          { id: 'gpt', title: 'GPT lane', models: ['gpt-*'], window: { unit: 'day', n: 1 }, budgetTokens: 1000000, settledTokens: 0, availableTokens: 1000000, exhausted: false, state: 'suspended', open: true, retryAfterMs: 0, slotsLeft: 2, maxClaims: 3, tzLabel: 'UTC+8', schedule: [], peak: { windows: [], multiplier: 1 } },
        ],
      }];
    });
    await openCard(page, "borrow");
    await page.locator('[data-cs-family="gpt-*"]').click();
    const dir = page.locator('[data-cs="directory"]');
    // the filtered gpt lane is suspended → not claimable → node hidden under
    // only-available (the gemini lane must not "carry" it — F07 regression)
    await expect(dir.locator('.cs-dir-card')).toHaveCount(0, { timeout: 5_000 });
    await expect(dir).toContainText('No claimable lanes match this filter');
    // clearing the filter brings the node back with BOTH lane rows (the
    // suspended gpt lane renders with its badge)
    await page.locator('[data-cs-family=""]').click();
    await expect(dir.locator('.cs-dir-card')).toHaveCount(1);
    await expect(dir.locator('.cs-lane')).toHaveCount(2);
    await expect(dir.locator('.cs-lane', { hasText: 'GPT lane' })).toContainText('Paused');
  });

  installed('directory scale: tiers, chips, collapse, hidden count', async ({ page }) => {
    const lane = (over) => ({ id: over.id, title: over.id, models: over.models ?? ['gemini-*'], window: { unit: 'day', n: 1 },
      budgetTokens: over.budget ?? 1000000, settledTokens: over.settled ?? 0, availableTokens: (over.budget ?? 1000000) - (over.settled ?? 0),
      exhausted: Boolean(over.exhausted), state: over.state ?? 'active', open: over.open ?? true, retryAfterMs: over.retry ?? 0,
      slotsLeft: over.slots ?? 2, maxClaims: 3, tzLabel: 'UTC+8', schedule: [], peak: { windows: [], multiplier: 1 } });
    const share = (over) => ({ shareId: over.id, title: over.title, models: ['*'], online: true, state: 'active',
      slotsLeft: 2, budgetTokens: 1000000, settledTokens: 0, availableTokens: 1000000, exhausted: false, updatedAt: Date.now(),
      plugin: { online: true, version: '0.5.0', lastHeartbeatAt: 1234567890000 },
      lanes: over.lanes });
    await openCard(page, "borrow");
    // inject AFTER the card settles, then force a refresh — the initial
    // refresh may already have consumed the pre-open default fixture
    await page.evaluate((payload) => { window.__ATL_E2E_STATE__.shares = payload; }, [
      share({ id: 'shr_t3', title: 'Drained node', lanes: [lane({ id: 'dry', exhausted: true, settled: 1000000 })] }),
      share({ id: 'shr_t1', title: 'Fresh node', lanes: [lane({ id: 'big', budget: 2000000 }), lane({ id: 'small', budget: 100000, models: ['gpt-*'], settled: 90000 })] }),
      share({ id: 'shr_t2', title: 'Night node', lanes: [lane({ id: 'night', open: false, retry: 3600000 })] }),
      share({ id: 'shr_many', title: 'Many lanes', lanes: ['a', 'b', 'c', 'd', 'e'].map((x) => lane({ id: `ln-${x}` })) }),
    ]);
    await page.locator('[data-cs="refresh"]').click();
    const dir = page.locator('[data-cs="directory"]');
    const cards = dir.locator('.cs-dir-card');
    // M1 + M2 defaults: claimable-only ON hides the waiting (Night) and
    // drained nodes; Fresh (most remaining) sorts first
    await expect(cards).toHaveCount(2, { timeout: 5_000 });
    await expect(cards.first()).toContainText('Fresh node');
    await expect(dir).toContainText('2 nodes not claimable');
    // T2 stays a normal card when the toggle is off; T3 stays in the group
    await page.locator('[data-cs="onlyAvailable"]').uncheck();
    await expect(cards).toHaveCount(3);
    await expect(dir).toContainText('Not claimable (1)');
    // M2: gpt-* chip leaves one node with only its gpt lane
    await page.locator('[data-cs-family="gpt-*"]').click();
    await expect(cards).toHaveCount(1);
    await expect(dir.locator('.cs-lane')).toHaveCount(1);
    await page.locator('[data-cs-family=""]').click();  // "All" chip clears the family filter
    await expect(cards).toHaveCount(3);
    // M3: 5-lane node collapses to 3 + expander with the remaining count
    const manyCard = dir.locator('.cs-dir-card', { hasText: 'Many lanes' });
    await expect(manyCard.locator('.cs-lane')).toHaveCount(3);
    await expect(manyCard.locator('[data-cs-lanes-more]')).toContainText('2 more lanes');
    await manyCard.locator('[data-cs-lanes-more]').click();
    await expect(manyCard.locator('.cs-lane')).toHaveCount(5);
  });
});

installedZh('zh-CN lane save does not report success when the server keeps old values', async ({ page }) => {
  await openCard(page, 'owner');
  await page.locator('[data-cs-lane-edit="1"]').click();
  await page.locator('[data-cs-f="models"]').fill('glm-5.3');
  await page.evaluate(() => { window.__ATL_E2E_STATE__.ignoreOwnerLaneWrites = true; });
  await page.locator('[data-cs="laneSave"]').click();
  await expect(page.locator('[data-cs="status"]')).toContainText('服务端未确认车道变更', { timeout: 5_000 });
  await expect(page.locator('[data-cs-f="models"]')).toHaveValue('glm-5.3');
});

const zhAccess = scenarioTest({
  desktopAutoInitialized: false,
  language: 'zh-CN',
  apiBaseUrl: 'http://backend.test',
  routes: baseRoutes,
  shares: SHARES,
  modules: { 'compute-sharing': { enabled: true, config: {}, installedVersion: VERSION } },
  borrowClaims: [{
    keyId: 'csk_zh_access', token: 'atl_sk_zh_secret',
    shareId: 'shr_e2e1', shareTitle: 'E2E CPA', laneId: 'gemini-week',
    laneTitle: 'Gemini weekly', models: ['gemini-*'], tzLabel: 'UTC+8',
    baseURL: 'http://192.168.1.4:8317', expiresAt: Date.now() + 3_600_000,
  }],
});

zhAccess('API access stays readable in Chinese and a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 850 });
  await openCard(page, 'borrow');
  const access = page.locator('[data-cs-access="csk_zh_access"]');
  await expect(access).toContainText('API 接入');
  await expect(access).toContainText('Key 有效');
  await expect(access).toContainText('OpenAI 兼容');
  await expect(access).toContainText('Claude / Anthropic');
  await expect(access).toContainText('工具配置');
  await expect(access.locator('[data-cs-api-key]')).not.toHaveText('atl_sk_zh_secret');
  const fit = await access.evaluate((el) => ({ width: el.clientWidth, content: el.scrollWidth }));
  expect(fit.content).toBeLessThanOrEqual(fit.width + 1);
});

const borrowerOnly = scenarioTest({
  desktopAutoInitialized: false,
  language: 'en',
  apiBaseUrl: 'http://backend.test',
  routes: baseRoutes,
  shares: SHARES,
  ownerNotRegistered: true,
  modules: { 'compute-sharing': { enabled: true, config: {}, installedVersion: VERSION } },
});

  borrowerOnly('R2-08: a stale heartbeat file is not a healthy node', async ({ page }) => {
  await openCard(page, "borrow");
  // phase says beating but the last success froze long ago (R2-08 probe shape)
  await page.evaluate(() => {
    window.__ATL_E2E_STATE__.doctorStatusFile = {
      ready: false,
      items: [
        { id: 'identity', ok: true },
        { id: 'ownerConfig', ok: true },
        { id: 'apiBase', ok: true, value: 'http://backend.test' },
        { id: 'node', ok: false, value: 'stale', hint: '节点心跳文件为 beating，但最近成功心跳已是 3600 秒前（判定陈旧）——检查 CPA 是否在运行、后端是否可达' },
      ],
    };
  });
  await page.locator('[data-cs-doctor]').click();
  const items = page.locator('.cs-entry-item');
  await expect(items).toHaveCount(4, { timeout: 5_000 });
  const node = items.nth(3);
  await expect(node).toContainText('Node heartbeat');
  await expect(node).toContainText('Stale heartbeat', { timeout: 5_000 });
  await expect(node).toContainText('Check that CPA is running');
  await expect(node).not.toContainText(/[\u3400-\u9fff]/);
});

borrowerOnly('R3: English doctor results localize stale and missing configuration guidance', async ({ page }) => {
  await openCard(page);
  await page.evaluate(() => { window.__ATL_E2E_STATE__.doctor = { ready: false, items: [
    { id: 'identity', ok: false, hint: '未找到共享节点身份（CPA 的 atl-share 插件尚未注册）' },
    { id: 'ownerConfig', ok: false, hint: '缺少 CPA 侧共享配置' },
    { id: 'apiBase', ok: false, value: 'http://backend.test', hint: 'CPA 插件与 App 后端不一致' },
    { id: 'node', ok: false, value: 'stale', hint: '节点心跳陈旧——检查 CPA 是否在运行' },
  ] }; });
  await page.locator('[data-cs-doctor]').click();
  const results = page.locator('.cs-entry-items');
  await expect(results).toContainText('atl-share');
  await expect(results).not.toContainText(/[\u3400-\u9fff]/);
});

borrowerOnly('V02: the share entry 检查 renders itemized readiness', async ({ page }) => {
    await openCard(page, "borrow");
    await page.evaluate(() => {
      window.__ATL_E2E_STATE__.doctor = {
        ready: false,
        items: [
          { id: 'identity', ok: false, hint: '未找到共享节点身份（CPA 的 atl-share 插件尚未注册）' },
          { id: 'ownerConfig', ok: true },
          { id: 'apiBase', ok: true, value: 'http://backend.test' },
          { id: 'node', ok: false, hint: '节点状态未知' },
        ],
      };
    });
    await page.locator('[data-cs-doctor]').click();
    const items = page.locator('.cs-entry-item');
    await expect(items).toHaveCount(4, { timeout: 5_000 });
    await expect(items.first()).toContainText('Share node identity');
    await expect(items.first()).toContainText('atl-share');
  });

borrowerOnly('pure borrowers: no owner console, but the 我要分享 entry row shows', async ({ page }) => {
  await openCard(page, "borrow");
  await expect(page.locator('[data-cs="tabs"]')).toBeHidden();
  await expect(page.locator('[data-cs="owner"]')).toBeHidden();
  await expect(page.locator('[data-cs="directory"]')).toContainText('E2E CPA');
  // §4.1: a one-line share entry replaces the whole owner console
  await expect(page.locator('[data-cs="entry"]')).toBeVisible();
  await expect(page.locator('[data-cs="entry"]')).toContainText('I want to share');
  await expect(page.locator('[data-cs="entry"]')).toContainText('CLIProxyAPI');
});

for (const language of ['en', 'zh-CN']) {
  const localizedBorrower = scenarioTest({
    desktopAutoInitialized: false, language, apiBaseUrl: 'http://backend.test', routes: baseRoutes,
    shares: SHARES, ownerNotRegistered: true,
    modules: { 'compute-sharing': { enabled: true, config: {}, installedVersion: VERSION } },
  });
  localizedBorrower(`R3: doctor ${language} distinguishes unknown backend from address mismatch`, async ({ page }) => {
    await openCard(page);
    await page.evaluate(() => { window.__ATL_E2E_STATE__.doctor = { ready: false, items: [
      { id: 'apiBase', ok: false, value: 'http://backend.test', code: 'api_unknown', hint: 'runtime backend unknown' },
      { id: 'node', ok: false, value: 'stale', code: 'node_stale', params: { ageSeconds: 3600 }, hint: 'old heartbeat' },
    ] }; });
    await page.locator('[data-cs-doctor]').click();
    const items = page.locator('.cs-entry-items');
    await expect(items).toContainText(language === 'en' ? 'running CPA backend address is unknown' : '无法确认运行中 CPA 的后端地址');
    await expect(items).toContainText('3600');
    await page.evaluate(() => { window.__ATL_E2E_STATE__.doctor.items[0] = {
      id: 'apiBase', ok: false, value: 'http://backend.test', code: 'api_mismatch',
      params: { cpaApi: 'http://cpa-backend.test', appApi: 'http://backend.test' },
    }; });
    await page.locator('[data-cs-doctor]').click();
    await expect(items).toContainText('http://cpa-backend.test');
    await expect(items).toContainText(language === 'en' ? 'Configure both to use the same backend' : '请将两者配置到同一后端');
    if (language === 'en') await expect(items).not.toContainText(/[\u3400-\u9fff]/);
  });
}

for (const language of ['en', 'zh-CN']) {
  const movedEndpoint = scenarioTest({
    desktopAutoInitialized: false, language, apiBaseUrl: 'http://backend.test',
    routes: baseRoutes, shares: SHARES, modelError: 'http_401',
    modules: { 'compute-sharing': { enabled: true, config: {}, installedVersion: VERSION } },
    borrowClaims: [{ keyId: 'csk_move', token: 'atl_sk_move', shareId: 'shr_e2e1',
      shareTitle: 'Moving node', laneId: 'gemini-week', models: ['gemini-*'],
      baseURL: 'http://192.168.1.4:8317', expiresAt: Date.now() + 3_600_000 }],
  });
  movedEndpoint(`T87: ${language} existing claim follows endpoint and retries catalog failures`, async ({ page }) => {
    await openCard(page, 'borrow');
    await expect(page.locator('[data-cs="mine"]')).toContainText('http_401');
    await page.evaluate(() => {
      const state = window.__ATL_E2E_STATE__;
      state.modelError = '';
      state.modelCatalog = ['gemini-new'];
    });
    await page.locator('[data-cs="refresh"]').click();
    await expect(page.locator('[data-cs-model="csk_move"]')).toHaveValue('gemini-new');
    await page.evaluate(() => {
      const state = window.__ATL_E2E_STATE__;
      state.liveClaims = [{ ...state.borrowStore.claims[0], baseURL: 'http://192.168.1.10:8317', state: 'valid' }];
    });
    await page.locator('[data-cs="refresh"]').click();
    await expect(page.locator('[data-cs="mine"]')).toContainText('http://192.168.1.10:8317');
    await expect(page.locator('[data-cs="mine"]')).not.toContainText('http_401');
    await expect(page.locator('[data-cs-model="csk_move"]')).toHaveValue('gemini-new');
    await expect(page.locator('[data-cs="mine"]')).not.toContainText('http://192.168.1.4:8317');
  });
  movedEndpoint(`T87: ${language} obsolete model response cannot overwrite moved endpoint`, async ({ page }) => {
    await openCard(page, 'borrow');
    await expect(page.locator('[data-cs="mine"]')).toContainText('http_401');
    const before = await page.evaluate(() => window.__ATL_E2E_STATE__.sidecarCalls.filter(c => c.command === 'compute-sharing:models').length);
    await page.evaluate(() => {
      window.__ATL_E2E_STATE__.modelError = '';
      window.__ATL_E2E_STATE__.modelDelay = 1800;
      window.__ATL_E2E_STATE__.modelCatalog = ['gemini-old'];
    });
    await page.locator('[data-cs="refresh"]').click();
    await expect.poll(() => page.evaluate(() => window.__ATL_E2E_STATE__.sidecarCalls.filter(c => c.command === 'compute-sharing:models').length)).toBeGreaterThan(before);
    await page.evaluate(() => {
      const state = window.__ATL_E2E_STATE__;
      state.modelDelay = 0;
      state.modelCatalog = ['gemini-new'];
      state.liveClaims = [{ ...state.borrowStore.claims[0], baseURL: 'http://192.168.1.10:8317', state: 'valid' }];
    });
    await page.locator('[data-cs="refresh"]').click();
    await expect(page.locator('[data-cs-model="csk_move"]')).toHaveValue('gemini-new');
    await page.waitForTimeout(2000);
    await expect(page.locator('[data-cs-model="csk_move"]')).toHaveValue('gemini-new');
    await expect(page.locator('[data-cs-model="csk_move"] option')).not.toContainText(['gemini-old']);
  });
  movedEndpoint(`T87: ${language} a moved endpoint cancels the old connection probe`, async ({ page }) => {
    await openCard(page, 'borrow');
    await page.evaluate(() => {
      window.__ATL_E2E_STATE__.borrowTestDelayMs = 1500;
      window.__ATL_E2E_STATE__.borrowTestResult = { ok: false, status: 401, error: 'old endpoint failed' };
    });
    await page.locator('[data-cs-model-input="csk_move"]').fill('gemini-new');
    await page.locator('[data-cs-test="csk_move"]').click();
    await page.evaluate(() => {
      const state = window.__ATL_E2E_STATE__;
      state.liveClaims = [{ ...state.borrowStore.claims[0], baseURL: 'http://192.168.1.10:8317', state: 'valid' }];
      state.modelError = '';
      state.modelCatalog = ['gemini-new'];
      state.borrowTestDelayMs = 0;
      state.borrowTestResult = null;
    });
    await page.locator('[data-cs="refresh"]').click();
    await expect(page.locator('[data-cs-model="csk_move"]')).toHaveValue('gemini-new');
    await page.locator('[data-cs-test="csk_move"]').click();
    const result = page.locator('[data-cs-test-result="csk_move"]');
    await expect(result).toContainText(language === 'en' ? 'reachable' : '连通');
    await page.waitForTimeout(1800);
    await expect(result).not.toContainText('old endpoint failed');
    const calls = await page.evaluate(() => window.__ATL_E2E_STATE__.sidecarCalls.filter(c => c.command === 'compute-sharing:borrow-test'));
    expect(calls.at(-1).args.baseURL).toBe('http://192.168.1.10:8317');
  });

}
