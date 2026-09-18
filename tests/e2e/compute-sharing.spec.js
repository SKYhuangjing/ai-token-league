// E2E: compute-sharing plugin (0.2.0 lanes) — one remote card with the owner
// console (lane table + editor + advanced policy + stop/resume) and the
// lane-scoped borrowing directory. Routes mimic the distribution proxy +
// sharing control plane; the guarded sidecar channel is mocked in
// mock-tauri.js (sharing:* commands).
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { navigateTo } from './helpers.js';

const mockScript = readFileSync(resolve(import.meta.dirname, 'mock-tauri.js'), 'utf8');
const pluginSource = readFileSync(resolve(import.meta.dirname, '../../plugins/compute-sharing/index.js'), 'utf8');

const VERSION = '0.9.0';
const CATALOG = {
  version: 1,
  catalog: [
    { id: 'compute-sharing', version: VERSION, type: 'query', title: '算力共享', desc: 'merged card',
      entry: 'index.js', permissions: [
        'sidecar:compute-sharing:claim-sign', 'sidecar:compute-sharing:borrow-get', 'sidecar:compute-sharing:borrow-set', 'sidecar:compute-sharing:borrow-test',
        'sidecar:compute-sharing:owner-status', 'sidecar:compute-sharing:owner-policy', 'sidecar:compute-sharing:owner-resume',
        'sidecar:compute-sharing:owner-suggest', 'sidecar:compute-sharing:owner-unregister',
      ] },
  ],
};

const SHARES = {
  shares: [
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

async function openCard(page, tab = "owner") {
  await navigateTo(page, 'modules');
  await page.waitForSelector('[data-module-card="compute-sharing"]', { timeout: 5_000 });
  await page.waitForSelector('[data-cs="directory"]', { state: 'attached', timeout: 5_000 });
  // the card settles its owner state first (data-owner=pending→yes|no):
  // waiting on that removes the board-temporarily-visible race for pure
  // borrowers (no tab bar at all in that case)
  await page.waitForFunction(() => {
    const tabs = document.querySelector('[data-cs="tabs"]');
    return tabs && tabs.dataset.owner && tabs.dataset.owner !== "pending";
  }, { timeout: 5_000 });
  if (tab !== "owner") {
    // owners: the tab appears once owner state settles (click retries until
    // then); pure borrowers never get a tab bar — the board is the card
    const tabButton = page.locator(`[data-cs-tab="${tab}"]`);
    try {
      await tabButton.click({ timeout: 5_000 });
      await expect(page.locator('[data-cs="board"]')).toBeVisible({ timeout: 5_000 });
      await page.waitForTimeout(800);
      await expect(page.locator('[data-cs="board"]')).toBeVisible();
    } catch {
      await expect(page.locator('[data-cs="board"]')).toBeVisible({ timeout: 5_000 });
    }
  }
}

installed.describe('Compute sharing (lanes card, en)', () => {
  installed('owner console renders the lane table with per-lane state', async ({ page }) => {
    await openCard(page, "owner");
    await expect(page.locator('[data-cs="owner"]')).toBeVisible();
    const body = page.locator('[data-cs="owner-body"]');
    await expect(body).toContainText('Sky-Macbook CPA', { timeout: 5_000 });
    await expect(body).toContainText('Gemini weekly');
    await expect(body).toContainText('GLM off-peak');
    // exhausted lane surfaces its badge; claims carry the lane tag
    await expect(body).toContainText('Window budget exhausted');
    await expect(body).toContainText('Gemini weekly', { useInnerText: false });
    await expect(page.locator('[data-cs-lane="gemini-week"]')).toBeVisible();
    // derived suggestions render (owner can create lanes from own usage)
    await expect(page.locator('[data-cs-family="0"]')).toBeVisible();
    await expect(page.locator('[data-cs-tpl="blank"]')).toBeVisible();
    // claims history collapses: valid row + 4 ended rows shown, 6 total ended
    const claimRows = page.locator('[data-cs="owner-body"] .cs-kv', { hasText: 'csk_' });
    await expect(claimRows).toHaveCount(5, { timeout: 5_000 });            // 1 valid + 4 ended
    await expect(page.locator('[data-cs="claimsToggle"]')).toHaveText('Show all 6 past claims');
    await page.locator('[data-cs="claimsToggle"]').click();
    await expect(claimRows).toHaveCount(7, { timeout: 5_000 });            // 1 valid + 6 ended
    await page.locator('[data-cs="claimsToggle"]').click();
    await expect(claimRows).toHaveCount(5, { timeout: 5_000 });

    // advisory surfaces: wall-signal banner + budget suggestions
    await expect(page.locator('.cs-wall')).toContainText('failed 3 times');
    await expect(body).toContainText('Quota reference', { timeout: 5_000 });   // block heading anchors the lines
    await expect(body).toContainText('own use (7d): 1.3B');
    await expect(body).toContainText('Zhipu 5h windows:');
    // derived busy window + its complement are visible (productized suggestions)
    await expect(body).toContainText('your peak 15:00–21:00');
    await expect(body).toContainText('weekly budget ≤ 975M');
    // switch to the borrow tab: directory renders lane rows there
    await page.locator('[data-cs-tab="borrow"]').click();
    const dir = page.locator('[data-cs="directory"]');
    await expect(dir).toContainText('E2E CPA');
    await expect(page.locator('[data-cs-claim-lane="gemini-week"]')).toBeEnabled();
    await expect(page.locator('[data-cs-claim-lane="glm-offpeak"]')).toBeDisabled();
    await expect(dir).toContainText('Closed ·');                       // B8 wording
    await expect(dir).toContainText('Peak ×2 14:00–21:00');            // B12 peak rule visible
    await expect(dir).toContainText('UTC+8');                          // B10 anchor label
    // persisted install record + uninstall removes the card
    const state = await page.evaluate(() => window.__ATL_E2E_STATE__.modulesState.modules['compute-sharing']);
    expect(state.installedVersion).toBe(VERSION);
    await page.locator('[data-remote-uninstall="compute-sharing"]').click();
    await expect(page.locator('[data-module-card="compute-sharing"]')).toHaveCount(0);
  });

  installed('derived suggestions prefill the editor; the reserve ratio recalculates live and persists', async ({ page }) => {
    await openCard(page, "owner");
    const body = page.locator('[data-cs="owner-body"]');
    await expect(body).toContainText('Quota reference', { timeout: 5_000 });
    // default reserve 25% → 1.3B own use suggests 975M
    await page.locator('[data-cs-family="0"]').click();
    await expect(page.locator('[data-cs-f="title"]')).toHaveValue('gemini-*');
    await expect(page.locator('[data-cs-f="models"]')).toHaveValue('gemini-*');
    await expect(page.locator('[data-cs-f="budget"]')).toHaveValue('975000000');
    // busy 15:00–21:00 → lane opens the complement 21:00–15:00
    await expect(page.locator('[data-cs-f="winStart"]')).toHaveValue('21:00');
    await expect(page.locator('[data-cs-f="winEnd"]')).toHaveValue('15:00');
    await page.locator('[data-cs="laneCancel"]').click();
    // reserve 50% → suggestion line recomputes to 650M and persists via modules:set
    const reserve = page.locator('[data-cs="reserve"]');
    await reserve.fill('50');
    await reserve.dispatchEvent('change');
    await expect(body).toContainText('weekly budget ≤ 650M', { timeout: 5_000 });
    const saved = await page.evaluate(() => window.__ATL_E2E_STATE__.modulesSetCalls.at(-1));
    expect(saved).toMatchObject({ id: 'compute-sharing', config: { reservePct: 50 } });
    // clamped back into 5–95: garbage input falls back to the clamp, not NaN
    await reserve.fill('200');
    await reserve.dispatchEvent('change');
    await expect(page.locator('[data-cs="reserve"]')).toHaveValue('95');
  });

  installed('offline share surfaces the plugin failure reason from status.json (R51)', async ({ page }) => {
    await openCard(page, "owner");
    const body = page.locator('[data-cs="owner-body"]');
    await expect(body).toContainText('Sky-Macbook CPA', { timeout: 5_000 });
    // flip the plugin offline with a concrete error, refresh, and the header
    // must carry the reason — a silent failure can never hide again
    await page.evaluate(() => {
      window.__ATL_E2E_STATE__.ownerShare.share.plugin.online = false;
      window.__ATL_E2E_STATE__.pluginStatus = { phase: 'error', lastError: 'heartbeat transport: connection refused' };
    });
    await page.locator('[data-cs="refresh"]').click();
    await expect(body).toContainText('plugin offline', { timeout: 5_000 });
    await expect(body).toContainText('heartbeat transport: connection refused');
    await expect(page.locator('[data-cs="owner"]')).toBeVisible();
  });

  installed('personal templates: save from the editor, refill from the chip, delete with ×', async ({ page }) => {
    await openCard(page, "owner");
    const body = page.locator('[data-cs="owner-body"]');
    await expect(body).toContainText('Quota reference', { timeout: 5_000 });
    await page.locator('[data-cs-tpl="blank"]').click();
    await page.locator('[data-cs-f="title"]').fill('夜班车道');
    await page.locator('[data-cs-f="models"]').fill('glm-*,gemini-*');
    await page.locator('[data-cs-f="budget"]').fill('25000000');
    await page.locator('[data-cs-f="winStart"]').fill('22:00');
    await page.locator('[data-cs-f="winEnd"]').fill('08:00');
    await page.locator('[data-cs="laneSaveTpl"]').click();
    await expect(page.locator('#toast')).toContainText('Saved as template', { timeout: 5_000 });
    // persisted in module config
    const stored = await page.evaluate(() => window.__ATL_E2E_STATE__.modulesState.modules['compute-sharing'].config.laneTemplates);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ title: '夜班车道', models: 'glm-*,gemini-*', budget: 25000000, winStart: '22:00', winEnd: '08:00' });
    await page.locator('[data-cs="laneCancel"]').click();
    // chip appears and refills the editor as a fresh draft
    const chip = page.locator('[data-cs-tpl="0"]');
    await expect(chip).toHaveText('夜班车道');
    await chip.click();
    await expect(page.locator('[data-cs-f="title"]')).toHaveValue('夜班车道');
    await expect(page.locator('[data-cs-f="winStart"]')).toHaveValue('22:00');
    await page.locator('[data-cs="laneCancel"]').click();
    // × removes the template and persists the shorter list
    await page.locator('[data-cs-tpl-del="0"]').click();
    await expect(page.locator('[data-cs-tpl="0"]')).toHaveCount(0);
    const after = await page.evaluate(() => window.__ATL_E2E_STATE__.modulesState.modules['compute-sharing'].config.laneTemplates);
    expect(after).toHaveLength(0);
  });

  installed('lane claim signs via the sidecar channel and tags my-claims', async ({ page }) => {
    await page.route('**/api/shares/claim', async (route) => {
      const body = route.request().postDataJSON();
      if (!body.participantId || !body.signature || !body.ts) {
        await route.fulfill({ status: 401, json: { error: 'identity_required' } });
        return;
      }
      if (body.laneId !== 'gemini-week') {
        await route.fulfill({ status: 404, json: { error: 'lane_not_found' } });
        return;
      }
      await route.fulfill({
        json: {
          keyId: 'csk_e2e99', token: 'atl_sk_e2e_secret', baseURL: 'http://192.168.1.4:8317',
          laneId: 'gemini-week', laneTitle: 'Gemini weekly', models: ['gemini-*'], window: { unit: 'week', n: 1 }, tzLabel: 'UTC+8',
          expiresAt: Date.now() + 3600000, shareTitle: 'E2E CPA', keyMaxTokens: 200000,
        },
      });
    });
    await openCard(page, "borrow");
    await page.locator('[data-cs-claim-lane="gemini-week"]').click();
    // secrets are masked in the DOM from the start (C5): prefix + ellipsis;
    // values render as single-line labels (grid), copy keeps the full line (B11)
    await expect(page.locator('[data-cs="mine"]')).toContainText('atl_sk_e…cret', { timeout: 5_000 });
    const openaiUrl = page.locator('[data-cs-config="openai-url"]');
    await expect(openaiUrl).toHaveText('http://192.168.1.4:8317/v1');
    await expect(openaiUrl).toHaveAttribute('title', 'export OPENAI_BASE_URL=http://192.168.1.4:8317/v1');
    // my-claims shows the lane tag (+ model scope chip + anchor tz) so
    // borrowers know which slice they hold and which models it serves
    await expect(page.locator('[data-cs="mine"] .cs-lane-tag').first()).toHaveText('Gemini weekly');
    await expect(page.locator('[data-cs="mine"] .cs-lane-tag').nth(1)).toHaveText('gemini-*');
    await expect(page.locator('[data-cs="mine"] .cs-lane-tag').nth(2)).toHaveText('UTC+8');
    // secrets render masked by default and reveal on toggle (C5)
    const keyRow = page.locator('[data-cs="mine"] [data-cs-config="openai-key"]');
    await expect(keyRow).toContainText('…');
    await expect(keyRow).not.toContainText('atl_sk_e2e_secret');
    const keyRowEl = page.locator('[data-cs="mine"] .cs-claim-row', { hasText: 'OpenAI Key' });
    await keyRowEl.locator('button', { hasText: 'Reveal' }).click();
    await expect(keyRow).toContainText('atl_sk_e2e_secret');
    // copy yields the full executable export line, not the bare value (B11)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await keyRowEl.locator('button', { hasText: 'Copy' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('export OPENAI_API_KEY=atl_sk_e2e_secret');
    const signs = await page.evaluate(() => window.__ATL_E2E_STATE__.borrowCalls.signs);
    expect(signs.at(-1)?.shareId).toBe('shr_e2e1');
    await expect(page.locator('#toast')).toContainText('Claimed');

    // G3 connectivity test: a wildcard lane has no default model, so testing
    // without one asks for it; with a model the sidecar relay reports the verdict
    const testResult = page.locator('[data-cs-test-result="csk_e2e99"]');
    await page.locator('[data-cs-test="csk_e2e99"]').click();
    await expect(testResult).toContainText('Enter a model name', { timeout: 5_000 });
    await page.locator('[data-cs-test-model="csk_e2e99"]').fill('gemini-3.8-flash-high');
    await page.locator('[data-cs-test="csk_e2e99"]').click();
    await expect(testResult).toContainText('gemini-3.8-flash-high reachable');
    // a gate rejection surfaces status + reason verbatim (lane exhausted etc.)
    await page.evaluate(() => {
      window.__ATL_E2E_STATE__.borrowTestResult = { ok: false, status: 429, error: 'compute-sharing limit reached: lane_exhausted' };
    });
    await page.locator('[data-cs-test="csk_e2e99"]').click();
    await expect(testResult).toContainText('HTTP 429');
    await expect(testResult).toContainText('lane_exhausted');
    await page.evaluate(() => { window.__ATL_E2E_STATE__.borrowTestResult = null; });

    // G3 renewal: offered under a day of life left, keeps the same key
    await page.route('**/api/shares/claims/renew', (route) =>
      route.fulfill({ json: { renewed: 'csk_e2e99', expiresAt: Date.now() + 7 * 86400000 } }));
    const renewButton = page.locator('[data-cs="mine"] button', { hasText: 'Renew' });
    await expect(renewButton).toBeVisible();
    await renewButton.click();
    await expect(page.locator('#toast')).toContainText('Renewed', { timeout: 5_000 });
    const stored = await page.evaluate(() => window.__ATL_E2E_STATE__.borrowStore.claims);
    expect(stored.find((c) => c.keyId === 'csk_e2e99').expiresAt).toBeGreaterThan(Date.now() + 6 * 86400000);
  });

  installed('backend lane rejection surfaces a friendly error with the reopen time', async ({ page }) => {
    await page.route('**/api/shares/claim', (route) =>
      route.fulfill({ status: 409, json: { error: 'lane_closed', laneId: 'gemini-week', retryAfterMs: 45 * 60_000 } }));
    await openCard(page, "borrow");
    await page.locator('[data-cs-claim-lane="gemini-week"]').click();
    await expect(page.locator('[data-cs="status"]')).toContainText('outside its open hours', { timeout: 5_000 });
    await expect(page.locator('[data-cs="status"]')).toContainText('opens at');
    await expect(page.locator('[data-cs="mine"]')).toContainText('No claims yet.');
  });

  installed('lane editing saves the full lane set; editor survives refresh; pause confirms', async ({ page }) => {
    await openCard(page, "owner");
    // edit the gemini lane's budget
    await page.locator('[data-cs-lane-edit="0"]').click();
    await expect(page.locator('[data-cs="lane-form"]')).toBeVisible();
    await page.locator('[data-cs-f="budget"]').fill('200000000');
    // review-A1 regression: a card refresh mid-edit must not wipe the form —
    // the live DOM values ride along into the re-rendered editor
    await page.locator('[data-cs="refresh"]').click();
    await expect(page.locator('[data-cs-f="budget"]')).toHaveValue('200000000', { timeout: 5_000 });
    // live conversion hint tracks the input
    await expect(page.locator('[data-cs="budgetHint"]')).toContainText('200M');
    await page.locator('[data-cs="laneSave"]').click();
    await expect(page.locator('#toast')).toContainText('Lane saved', { timeout: 5_000 });
    const lanes = await page.evaluate(() => window.__ATL_E2E_STATE__.ownerCalls.lanes.at(-1));
    expect(lanes).toHaveLength(2);
    const gemini = lanes.find((l) => l.id === 'gemini-week');
    expect(gemini.budget.tokens).toBe(200000000);
    expect(gemini.schedule.windows).toEqual([{ start: '22:00', end: '14:00' }]);
    // half-filled schedule window is rejected instead of silently all-day (B4)
    await page.locator('[data-cs-lane-edit="0"]').click();
    await page.locator('[data-cs-f="winEnd"]').fill('');
    await page.locator('[data-cs="laneSave"]').click();
    await expect(page.locator('[data-cs="status"]')).toContainText('both start and end', { timeout: 5_000 });
    // equal bounds are rejected instead of collapsing to all-day (B2)
    await page.locator('[data-cs-f="winEnd"]').fill('22:00');
    await page.locator('[data-cs="laneSave"]').click();
    await expect(page.locator('[data-cs="status"]')).toContainText('must differ', { timeout: 5_000 });
    // switching edit targets must not bleed unsaved values across drafts (B1)
    await page.locator('[data-cs-f="title"]').fill('Polluted Draft');
    await page.locator('[data-cs-lane-edit="1"]').click();
    await expect(page.locator('[data-cs-f="title"]')).toHaveValue('GLM off-peak', { timeout: 5_000 });
    await page.locator('[data-cs="laneCancel"]').click();
    // duplicate lane title is rejected (C2)
    await page.locator('[data-cs-lane-edit="0"]').click();
    await page.locator('[data-cs-f="title"]').fill('GLM off-peak');
    await page.locator('[data-cs="laneSave"]').click();
    await expect(page.locator('[data-cs="status"]')).toContainText('already exists', { timeout: 5_000 });
    await page.locator('[data-cs="laneCancel"]').click();
    // blank entry: an empty draft the owner fills by hand (C1)
    await page.locator('[data-cs-tpl="blank"]').click();
    await expect(page.locator('[data-cs-f="title"]')).toHaveValue('');
    await page.locator('[data-cs-f="title"]').fill('Spare lane');
    await page.locator('[data-cs="laneSave"]').click();
    const afterAdd = await page.evaluate(() => window.__ATL_E2E_STATE__.ownerCalls.lanes.at(-1));
    expect(afterAdd).toHaveLength(3);
    // pause button carries a real label, not the bare i18n key (round-2 A-1)
    await expect(page.locator('[data-cs-lane-toggle="0"]')).toHaveText('Pause');
    // pause asks first and states the blast radius (B5): 1 valid gemini claim
    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain('revoke its 1 borrower key');
      dialog.accept();
    });
    await page.locator('[data-cs-lane-toggle="0"]').click();
    await expect(page.locator('#toast')).toContainText('Lane paused', { timeout: 5_000 });
    const afterPause = await page.evaluate(() => window.__ATL_E2E_STATE__.ownerCalls.lanes.at(-1));
    expect(afterPause.find((l) => l.id === 'gemini-week').state).toBe('suspended');
    // suspended lane's claims were revoked by the mock contract
    const claims = await page.evaluate(() => window.__ATL_E2E_STATE__.ownerShare.claims);
    expect(claims.filter((c) => c.laneId === 'gemini-week').every((c) => c.state !== 'valid')).toBe(true);
  });

  installed('advanced policy save sends the delta; stop shows the stopped row, resume restores the console', async ({ page }) => {
    await openCard(page, "owner");
    await page.locator('[data-cs-policy="keyMaxTokens"]').fill('300000');
    await page.locator('[data-cs-policy="ttlHours"]').fill('72');
    await page.locator('[data-cs="savePolicy"]').click();
    await expect(page.locator('#toast')).toContainText('Policy saved.', { timeout: 5_000 });
    const policy = await page.evaluate(() => window.__ATL_E2E_STATE__.ownerCalls.policy.at(-1));
    expect(policy).toEqual({ keyMaxTokens: 300000, ttlHours: 72 });
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-cs="stop"]').click();
    await expect(page.locator('#toast')).toContainText('Sharing stopped.', { timeout: 5_000 });
    expect(await page.evaluate(() => window.__ATL_E2E_STATE__.ownerCalls.unregistered)).toBe(true);
    // stopped keeps a compact row (backend keeps answering owner-status with
    // state "stopped") — the console never collapses into a dead end anymore
    await expect(page.locator('[data-cs="owner"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-cs="owner-body"]')).toContainText('Stopped');
    await expect(page.locator('[data-cs="resume"]')).toBeVisible();
    // resume: back through the sidecar channel, console returns to active
    await page.locator('[data-cs="resume"]').click();
    await expect(page.locator('#toast')).toContainText('Sharing resumed', { timeout: 5_000 });
    expect(await page.evaluate(() => window.__ATL_E2E_STATE__.ownerCalls.resumed)).toBe(true);
    await expect(page.locator('[data-cs-lane-edit="0"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-cs="resume"]')).toHaveCount(0);
  });

  installed('backend identity rejection surfaces a friendly error', async ({ page }) => {
    await page.route('**/api/shares/claim', (route) => route.fulfill({ status: 401, json: { error: 'invalid_signature' } }));
    await openCard(page, "borrow");
    await page.locator('[data-cs-claim-lane="gemini-week"]').click();
    await expect(page.locator('[data-cs="status"]')).toContainText('Identity verification failed', { timeout: 5_000 });
    await expect(page.locator('[data-cs="mine"]')).toContainText('No claims yet.');
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

  installed('borrower directory scale (M1-M3): tiers, chips, collapse, cap message', async ({ page }) => {
    const lane = (over) => ({ id: over.id, title: over.id, models: over.models ?? ['gemini-*'], window: { unit: 'day', n: 1 },
      budgetTokens: over.budget ?? 1000000, settledTokens: over.settled ?? 0, availableTokens: (over.budget ?? 1000000) - (over.settled ?? 0),
      exhausted: Boolean(over.exhausted), state: over.state ?? 'active', open: over.open ?? true, retryAfterMs: over.retry ?? 0,
      slotsLeft: over.slots ?? 2, maxClaims: 3, tzLabel: 'UTC+8', schedule: [], peak: { windows: [], multiplier: 1 } });
    const share = (over) => ({ shareId: over.id, title: over.title, models: ['*'], online: true, state: 'active',
      slotsLeft: 2, budgetTokens: 1000000, settledTokens: 0, availableTokens: 1000000, exhausted: false, updatedAt: Date.now(),
      plugin: { online: true, version: '0.3.1', lastHeartbeatAt: 1234567890000 },  // fixed: heartbeat ties fall through to title
      lanes: over.lanes });
    await page.route('**/api/shares', (route) => route.fulfill({ json: { shares: [
      share({ id: 'shr_t3', title: 'Drained node', lanes: [lane({ id: 'dry', exhausted: true, settled: 1000000 })] }),
      share({ id: 'shr_t1', title: 'Fresh node', lanes: [lane({ id: 'big', budget: 2000000 }), lane({ id: 'small', budget: 100000, models: ['gpt-*'], settled: 90000 })] }),
      share({ id: 'shr_t2', title: 'Night node', lanes: [lane({ id: 'night', open: false, retry: 3600000 })] }),
      share({ id: 'shr_many', title: 'Many lanes', lanes: ['a', 'b', 'c', 'd', 'e'].map((x) => lane({ id: `ln-${x}` })) }),
    ] } }));
    await page.route('**/api/shares/claim', (route) =>
      route.fulfill({ status: 409, json: { error: 'too_many_active_claims', active: 5, max: 5 } }));
    await openCard(page, "borrow");
    const dir = page.locator('[data-cs="directory"]');
    const cards = dir.locator('.cs-dir-card');
    // M1 + M2 defaults: claimable-only ON hides both the waiting (Night) and
    // drained nodes, with a count note; Fresh (most remaining) sorts first
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
    // M4: the mapped cap message carries live counts
    await page.locator('[data-cs-claim-lane="big"]').click();
    await expect(page.locator('[data-cs="status"]')).toContainText('You hold 5 active keys (limit 5)');
  });

borrowerOnly('pure borrowers never see the owner section or the tab bar', async ({ page }) => {
  await openCard(page, "borrow");
  await expect(page.locator('[data-cs="tabs"]')).toBeHidden();
  await expect(page.locator('[data-cs="owner"]')).toBeHidden();
  await expect(page.locator('[data-cs="directory"]')).toContainText('E2E CPA');
  await expect(page.locator('[data-cs-claim-lane="gemini-week"]')).toBeVisible();
});
