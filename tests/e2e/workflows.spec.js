// E2E: Product workflows — provider toggle, reset, update, backup
import { test, expect } from './mock-setup.js';
import { waitForScanComplete, navigateTo } from './helpers.js';

test.describe('Sources Workflows', () => {
  test.beforeEach(async ({ page }) => {
    await waitForScanComplete(page);
  });

  test('sources screen renders provider cards with toggle switches', async ({ page }) => {
    await navigateTo(page, 'sources');

    const navItems = page.locator('#provider-nav-list [data-provider-nav]');
    await expect(navItems.first()).toBeVisible({ timeout: 5_000 });
    expect(await navItems.count()).toBeGreaterThanOrEqual(2);

    await navItems.first().click();

    // Toggle switch exists with correct role and initial state
    const toggle = page.locator('[data-toggle-source]').first();
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    expect(await toggle.getAttribute('role')).toBe('switch');
    const ariaChecked = await toggle.getAttribute('aria-checked');
    expect(['true', 'false']).toContain(ariaChecked);

    // Click toggle — should not crash
    await toggle.click();
    // App stays responsive
    await expect(page.locator('#sources')).toHaveClass(/active/);
  });

  test('sources screen shows source rows for each provider', async ({ page }) => {
    await navigateTo(page, 'sources');

    const navItems = page.locator('#provider-nav-list [data-provider-nav]');
    await navItems.first().click();

    const rows = page.locator('[data-root-path], .source-row, .auto-source-row');
    await expect(rows.first()).toBeVisible({ timeout: 5_000 });
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test('sources screen renders zcode provider card from its nav item', async ({ page }) => {
    await navigateTo(page, 'sources');

    const zcodeNav = page.locator('#provider-nav-list [data-provider-nav="zcode_local"]');
    await expect(zcodeNav).toBeVisible({ timeout: 5_000 });
    await zcodeNav.click();
    await expect(zcodeNav).toHaveClass(/active/);
    await expect(zcodeNav).toHaveAttribute('aria-current', 'true');

    const card = page.locator('#settings-source-list .provider-card', { hasText: 'ZCode' });
    await expect(card.first()).toBeVisible({ timeout: 5_000 });
    await expect(card.locator('h4')).toHaveText('ZCode');

    // Auto-discovered source row for the ZCode data directory
    const row = card.locator('[data-root-path], .source-row, .auto-source-row');
    await expect(row.first()).toBeVisible({ timeout: 5_000 });
    await expect(row.first()).toContainText('.zcode/cli');
  });

  test('provider card shows a data overview with stats and composition bar for providers with usage', async ({ page }) => {
    await navigateTo(page, 'sources');

    // claude_code_local is the first healthy provider and has today's 8,500 tokens
    const claudeNav = page.locator('#provider-nav-list [data-provider-nav="claude_code_local"]');
    await claudeNav.click();

    const overview = page.locator('#settings-source-list .provider-overview').first();
    await expect(overview).toBeVisible({ timeout: 5_000 });
    await expect(overview.locator('.provider-overview-title')).toContainText('Data overview');
    // Four stat cells (total / today / last 7 days / active days) with compact numbers
    await expect(overview.locator('.provider-overview-stat')).toHaveCount(4);
    await expect(overview.locator('.provider-overview-stat strong').first()).toContainText('8.5K');
    // Four-segment composition bar and legend percentages
    await expect(overview.locator('.provider-overview-bar i')).toHaveCount(4);
    await expect(overview.locator('.provider-overview-legend')).toContainText('59%');
    // Full model usage list reusing homepage meter rows, plus the last used day
    await expect(overview.locator('.mini-meter-row').first()).toContainText('claude-sonnet-4-20250514');
    await expect(overview.locator('.mini-meter-row .mini-meter i').first()).toBeVisible();
    await expect(overview.locator('.provider-overview-last')).toContainText(/\d{4}-\d{2}-\d{2}/);
  });

  test('provider card shows the overview empty note for providers without usage', async ({ page }) => {
    await navigateTo(page, 'sources');

    // zcode_local is healthy but has no usage rows in the mock dataset
    const zcodeNav = page.locator('#provider-nav-list [data-provider-nav="zcode_local"]');
    await zcodeNav.click();

    const overview = page.locator('#settings-source-list .provider-overview').first();
    await expect(overview).toBeVisible({ timeout: 5_000 });
    await expect(overview.locator('.provider-overview-note')).toContainText('No usage data yet');
    await expect(overview.locator('.provider-overview-stats')).toHaveCount(0);
  });

  test('sources screen renders workbuddy provider card from its nav item', async ({ page }) => {
    await navigateTo(page, 'sources');

    const workbuddyNav = page.locator('#provider-nav-list [data-provider-nav="workbuddy_local"]');
    await expect(workbuddyNav).toBeVisible({ timeout: 5_000 });
    await workbuddyNav.click();
    await expect(workbuddyNav).toHaveClass(/active/);
    await expect(workbuddyNav).toHaveAttribute('aria-current', 'true');

    const card = page.locator('#settings-source-list .provider-card', { hasText: 'WorkBuddy' });
    await expect(card.first()).toBeVisible({ timeout: 5_000 });
    await expect(card.locator('h4')).toHaveText('WorkBuddy');

    // Auto-discovered source row for the WorkBuddy data directory
    const row = card.locator('[data-root-path], .source-row, .auto-source-row');
    await expect(row.first()).toBeVisible({ timeout: 5_000 });
    await expect(row.first()).toContainText('.workbuddy');
  });

  test('sources screen renders dsh provider card from its nav item', async ({ page }) => {
    await navigateTo(page, 'sources');

    const dshNav = page.locator('#provider-nav-list [data-provider-nav="dsh_local"]');
    await expect(dshNav).toBeVisible({ timeout: 5_000 });
    await dshNav.click();
    await expect(dshNav).toHaveClass(/active/);
    await expect(dshNav).toHaveAttribute('aria-current', 'true');

    const card = page.locator('#settings-source-list .provider-card', { hasText: 'DeepSeek Harness' });
    await expect(card.first()).toBeVisible({ timeout: 5_000 });
    await expect(card.locator('h4')).toHaveText('DeepSeek Harness');

    // Auto-discovered source row for the dsh sessions directory
    const row = card.locator('[data-root-path], .source-row, .auto-source-row');
    await expect(row.first()).toBeVisible({ timeout: 5_000 });
    await expect(row.first()).toContainText('.dsh/sessions');
  });

  test('provider nav auto-sorts by status: healthy first, attention next, disabled last', async ({ page }) => {
    await navigateTo(page, 'sources');

    const navItems = page.locator('#provider-nav-list [data-provider-nav]');
    await expect(navItems.first()).toBeVisible({ timeout: 5_000 });
    expect(await navItems.count()).toBeGreaterThanOrEqual(4);

    // Mock health: claude/codex/zcode/workbuddy enabled+detected+ok; mimocode disabled; opencode not detected.
    // Healthy providers must come before attention-state and disabled ones.
    const order = await navItems.evaluateAll((items) => items.map((item) => ({
      id: item.getAttribute('data-provider-nav'),
      status: item.getAttribute('data-nav-status')
    })));

    const rank = { ok: 0, warn: 1, off: 2 };
    const statusRanks = order.map((entry) => rank[entry.status]);
    const sortedRanks = [...statusRanks].sort((a, b) => a - b);
    expect(statusRanks).toEqual(sortedRanks);

    // Default selection is the first healthy provider
    expect(order[0].id).toBe('claude_code_local');
    expect(order[0].status).toBe('ok');
    // Disabled mimocode sorts after every healthy provider
    const mimocodeIndex = order.findIndex((entry) => entry.id === 'mimocode_local');
    expect(mimocodeIndex).toBeGreaterThan(order.findIndex((entry) => entry.id === 'zcode_local'));
  });
});

test.describe('Settings Workflows', () => {
  test.beforeEach(async ({ page }) => {
    await waitForScanComplete(page);
    await navigateTo(page, 'settings');
  });

  async function switchTab(page, tab) {
    await page.click(`[data-settings-tab="${tab}"]`);
    await page.waitForFunction((t) => {
      const panel = document.querySelector(`[data-settings-panel="${t}"]`);
      return panel && panel.classList.contains('active');
    }, tab, { timeout: 5_000 });
  }

  test('cloud panel has update check button', async ({ page }) => {
    await switchTab(page, 'cloud');

    const checkBtn = page.locator('#check-update');
    await expect(checkBtn).toBeVisible({ timeout: 5_000 });

    // Click triggers checkUpdate — should not crash (mock returns null instantly)
    await checkBtn.click();
    // App stays responsive
    await expect(page.locator('#settings')).toHaveClass(/active/);
  });

  test('about panel has reset, backup, and diagnostics controls', async ({ page }) => {
    // #reset-local-data, #restore-local-backup, #clear-local-backups are in "about" panel
    await switchTab(page, 'about');

    // Reset
    const resetBtn = page.locator('#reset-local-data');
    await expect(resetBtn).toBeVisible({ timeout: 5_000 });
    await expect(resetBtn).toBeEnabled();

    // Backup
    const restoreBtn = page.locator('#restore-local-backup');
    const clearBtn = page.locator('#clear-local-backups');
    expect((await restoreBtn.count()) + (await clearBtn.count())).toBeGreaterThanOrEqual(1);
  });

  test('reset button opens confirm dialog', async ({ page }) => {
    await switchTab(page, 'about');

    await page.locator('#reset-local-data').click();
    const modal = page.locator('#reset-confirm-modal, [data-reset-modal], .modal');
    await expect(modal.first()).toBeVisible({ timeout: 3_000 });
  });
});
