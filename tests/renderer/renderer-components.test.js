// Tests for HTML component generators extracted from renderer.js
import { describe, it, expect } from 'vitest';
import {
  formatToken, localeTokenCompact,
  visibleCompositionFields, visibleCompositionEntries,
  renderCompositionTiles, renderMiniMeters, renderDetailMeters,
  renderWorkdirCards, renderSparkBarValue, renderCompactBreakdown,
  sourceSwitchButton, updateSourceSwitchButton,
  renderProviderOverview,
  renderTrendDashboard, renderTrendSelection,
  renderTrendDetailHero, renderTrendDetailBreakdown
} from '../../src/desktop/renderer-components.js';

const t = (k) => ({
  'common.cache': 'Cache', 'common.input': 'Input', 'common.output': 'Output',
  'common.cacheRead': 'Cache read', 'common.cacheWrite': 'Cache write',
  'common.cost': 'Cost', 'common.estimated': 'Estimated',
  'desktop.overview.totalTokens': 'Total Tokens',
  'desktop.renderer.topModels': 'Top Models', 'desktop.renderer.topWorkdirs': 'Top Workdirs',
  'desktop.renderer.noLocalUsageFound': 'No data',
  'desktop.renderer.latestLabel': 'Latest', 'desktop.renderer.peak': 'Peak',
  'desktop.renderer.viewTotal': 'Total', 'desktop.renderer.cost': 'Cost',
  'desktop.renderer.dominant': 'Dominant', 'desktop.renderer.recentContribution': 'Recent',
  'desktop.renderer.dayBucket': 'day', 'desktop.renderer.modelDetail': 'Model Detail',
  'desktop.workdirs.tierMain': 'Main', 'desktop.workdirs.tierMid': 'Mid', 'desktop.workdirs.tierSmall': 'Small',
  'desktop.range.today': 'Today', 'unit.tokens': 'tokens',
  'desktop.trend.hourlyDetail': 'Hourly', 'desktop.renderer.missing': 'missing',
  'desktop.renderer.unknownPrice': 'unknown', 'desktop.renderer.noPricingVersion': 'no version',
  'desktop.sources.disable': 'Disable', 'desktop.sources.enable': 'Enable',
  'desktop.sources.overviewTitle': 'Data overview',
  'desktop.sources.overviewTotal': 'Total', 'desktop.sources.overviewToday': 'Today',
  'desktop.sources.overviewWeek': 'Last 7 days', 'desktop.sources.overviewActiveDays': 'Active days',
  'desktop.sources.overviewDaysUnit': 'days', 'desktop.sources.overviewModels': 'Model usage',
  'desktop.sources.overviewLastUsed': 'Last used',
  'desktop.sources.overviewEmpty': 'No usage data yet; run a scan to populate',
  'desktop.sources.overviewCapped': 'Dataset too large for this overview',
  'desktop.renderer.groupedBy': 'grouped by', 'desktop.renderer.workdir': 'Workdir',
  'desktop.renderer.model': 'Model', 'desktop.today.estCost': 'Est. Cost',
}[k] || k);

// ── formatToken ──

describe('formatToken', () => {
  it('formats compact by default', () => {
    const result = formatToken(12345, {});
    expect(result).toBeTruthy();
  });
  it('formats with default opts (no args)', () => {
    const result = formatToken(12345);
    expect(result).toBeTruthy();
  });
  it('formats with lang option', () => {
    const result = formatToken(12345, { lang: 'zh-CN' });
    expect(result).toBeTruthy();
  });
});

describe('localeTokenCompact', () => {
  it('formats with locale', () => {
    const result = localeTokenCompact(12345, 'en');
    expect(result).toBeTruthy();
  });
});

// ── Composition ──

describe('visibleCompositionFields', () => {
  it('returns input, output, cache fields', () => {
    const fields = visibleCompositionFields({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10 });
    expect(fields).toHaveLength(3);
    expect(fields[0][0]).toBe('input');
    expect(fields[1][0]).toBe('output');
    expect(fields[2][0]).toBe('cache');
    expect(fields[2][1]).toBe(30); // cacheRead + cacheWrite
  });
});

describe('visibleCompositionEntries', () => {
  it('returns entries with labels and ratios', () => {
    const entries = visibleCompositionEntries({ inputTokens: 60, outputTokens: 30, cacheReadTokens: 10, totalTokens: 100 }, t);
    expect(entries).toHaveLength(3);
    expect(entries[0].label).toBe('Input');
    expect(entries[0].ratio).toBeCloseTo(0.6);
  });
  it('returns zero ratio when totalTokens is 0', () => {
    const entries = visibleCompositionEntries({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 });
    expect(entries[0].ratio).toBe(0);
  });
  it('uses default translate when no t provided', () => {
    const entries = visibleCompositionEntries({ inputTokens: 60, outputTokens: 30, cacheReadTokens: 10, totalTokens: 100 });
    expect(entries[0].label).toBe('common.input');
    expect(entries[2].label).toBe('common.cache');
  });
});

describe('renderCompositionTiles', () => {
  it('returns HTML with tiles', () => {
    const html = renderCompositionTiles({ inputTokens: 60, outputTokens: 30, cacheReadTokens: 10, totalTokens: 100 }, { t });
    expect(html).toContain('composition-tile');
    expect(html).toContain('Input');
    expect(html).toContain('60%');
  });
});

// ── Mini Meters ──

describe('renderMiniMeters', () => {
  const items = [
    { name: 'gpt-4o', totalTokens: 1000 },
    { name: 'gpt-5', totalTokens: 500 }
  ];
  it('returns HTML with meter rows', () => {
    const html = renderMiniMeters(items, { t });
    expect(html).toContain('mini-meter-row');
    expect(html).toContain('gpt-4o');
    expect(html).toContain('gpt-5');
  });
  it('respects limit', () => {
    const html = renderMiniMeters(items, { limit: 1, t });
    expect(html).toContain('gpt-4o');
    expect(html).not.toContain('gpt-5');
  });
  it('adds color classes', () => {
    const html = renderMiniMeters(items, { colorClasses: ['meter-red', 'meter-blue'], t });
    expect(html).toContain('meter-red');
  });
  it('includes cost when showCost=true', () => {
    const itemsWithCost = [{ name: 'gpt-4o', totalTokens: 1000, hasKnownPrice: true, estimatedCostUsd: 0.05 }];
    const html = renderMiniMeters(itemsWithCost, { showCost: true, t });
    expect(html).toContain('cost-amount');
  });
  it('uses default opts', () => {
    const html = renderMiniMeters(items);
    expect(html).toContain('mini-meter-row');
  });
});

// ── Detail Meters ──

describe('renderDetailMeters', () => {
  it('returns empty state for no items', () => {
    const html = renderDetailMeters([], { t });
    expect(html).toContain('No data');
  });
  it('returns meter rows for items', () => {
    const html = renderDetailMeters([{ name: 'gpt-4o', totalTokens: 100 }], { t });
    expect(html).toContain('drawer-meter-row');
    expect(html).toContain('gpt-4o');
  });
  it('includes cost when showEstimatedCost=true', () => {
    const html = renderDetailMeters([{ name: 'gpt-4o', totalTokens: 100, hasKnownPrice: true, estimatedCostUsd: 0.05 }], { showEstimatedCost: true, t });
    expect(html).toContain('cost-amount');
  });
  it('handles default opts with no items', () => {
    const html = renderDetailMeters();
    expect(html).toContain('desktop.renderer.noLocalUsageFound');
  });
});

// ── Workdir Cards ──

describe('renderWorkdirCards', () => {
  const items = [
    { workdirHash: 'h1', name: '/project-a', totalTokens: 1000, contributionRatio: 0.6, todayTokens: 100 },
    { workdirHash: 'h2', name: '/project-b', totalTokens: 500, contributionRatio: 0.3, todayTokens: 50 }
  ];
  it('returns HTML with workdir cards', () => {
    const html = renderWorkdirCards(items, { t });
    expect(html).toContain('workdir-card');
    expect(html).toContain('/project-a');
    expect(html).toContain('#1');
    expect(html).toContain('#2');
  });
  it('assigns badge classes based on contribution', () => {
    const html = renderWorkdirCards(items, { t });
    expect(html).toContain('badge dark'); // 60% > 50%
    expect(html).toContain('badge'); // 30% > 20%
  });
  it('shows small tier for low contribution', () => {
    const smallItems = [
      { workdirHash: 'h1', name: '/tiny', totalTokens: 50, contributionRatio: 0.05, todayTokens: 5 }
    ];
    const html = renderWorkdirCards(smallItems, { t });
    expect(html).toContain('Small');
  });
  it('includes cost when showEstimatedCost=true', () => {
    const costItems = [{ workdirHash: 'h1', name: '/a', totalTokens: 1000, contributionRatio: 1, todayTokens: 100, estimatedCostUsd: 0.05 }];
    const html = renderWorkdirCards(costItems, { showEstimatedCost: true, t });
    expect(html).toContain('cost-amount');
  });
  it('handles default opts', () => {
    const html = renderWorkdirCards(items);
    expect(html).toContain('workdir-card');
  });
});

// ── Spark Bar Value ──

describe('renderSparkBarValue', () => {
  it('returns HTML with token value', () => {
    const html = renderSparkBarValue({ totalTokens: 1000 }, { t });
    expect(html).toContain('spark-bar-value');
  });
  it('includes cost when showEstimatedCost', () => {
    const html = renderSparkBarValue({ totalTokens: 1000, hasKnownPrice: true, estimatedCostUsd: 0.05 }, { showEstimatedCost: true, t });
    expect(html).toContain('cost-amount');
  });
});

// ── Compact Breakdown ──

describe('renderCompactBreakdown', () => {
  it('returns dash for empty', () => {
    expect(renderCompactBreakdown([], {})).toBe('-');
  });
  it('returns up to 3 items', () => {
    const items = [{ name: 'alpha', totalTokens: 100 }, { name: 'beta', totalTokens: 200 }, { name: 'gamma', totalTokens: 300 }, { name: 'delta', totalTokens: 400 }];
    const html = renderCompactBreakdown(items, {});
    expect(html).toContain('alpha');
    expect(html).toContain('gamma');
    expect(html).not.toContain('delta');
  });
  it('handles default opts', () => {
    const html = renderCompactBreakdown([{ name: 'a', totalTokens: 100 }]);
    expect(html).toContain('a');
  });
  it('handles undefined items', () => {
    expect(renderCompactBreakdown(undefined)).toBe('-');
  });
});

// ── Source Switch Button ──

describe('sourceSwitchButton', () => {
  it('renders enabled switch', () => {
    const html = sourceSwitchButton(true, 'data-id="test"', t);
    expect(html).toContain('is-on');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('role="switch"');
  });
  it('renders disabled switch', () => {
    const html = sourceSwitchButton(false, 'data-id="test"', t);
    expect(html).toContain('is-off');
    expect(html).toContain('aria-checked="false"');
  });
});

describe('updateSourceSwitchButton', () => {
  it('updates button attributes', () => {
    const button = document.createElement('button');
    button.className = 'source-switch is-off';
    button.setAttribute('aria-checked', 'false');
    updateSourceSwitchButton(button, true, t);
    expect(button.getAttribute('aria-checked')).toBe('true');
    expect(button.classList.contains('is-on')).toBe(true);
    expect(button.classList.contains('is-off')).toBe(false);
  });
});

// ── Trend Dashboard ──

describe('renderTrendDashboard', () => {
  const rows = [
    { periodStart: '2026-05-23', periodEnd: '2026-05-23', totalTokens: 1000, inputTokens: 600, outputTokens: 400, modelBreakdown: [{ name: 'gpt-4o', totalTokens: 1000 }], workdirBreakdown: [{ name: '/a', totalTokens: 1000 }], missingPriceModels: [] },
    { periodStart: '2026-05-22', periodEnd: '2026-05-22', totalTokens: 500, inputTokens: 300, outputTokens: 200, modelBreakdown: [{ name: 'gpt-4o', totalTokens: 500 }], workdirBreakdown: [{ name: '/a', totalTokens: 500 }], missingPriceModels: [] }
  ];
  it('returns HTML with summary grid', () => {
    const html = renderTrendDashboard(rows, { t });
    expect(html).toContain('trend-dashboard');
    expect(html).toContain('trend-summary-grid');
    expect(html).toContain('trend-metric');
  });
  it('includes recent contribution section', () => {
    const html = renderTrendDashboard(rows, { t });
    expect(html).toContain('recent-contribution');
  });
  it('includes timeline', () => {
    const html = renderTrendDashboard(rows, { t });
    expect(html).toContain('trend-timeline');
  });
  it('shows cost when showEstimatedCost=true', () => {
    const costRows = rows.map(r => ({ ...r, hasKnownPrice: true, estimatedCostUsd: 0.05 }));
    const html = renderTrendDashboard(costRows, { showEstimatedCost: true, t });
    expect(html).toContain('cost-amount');
  });
  it('shows plural day buckets', () => {
    const html = renderTrendDashboard(rows, { t });
    expect(html).toContain('days');
  });
  it('shows singular day bucket', () => {
    const html = renderTrendDashboard([rows[0]], { t });
    expect(html).toContain('day');
  });
});

// ── Trend Selection ──

describe('renderTrendSelection', () => {
  it('returns empty for null row', () => {
    expect(renderTrendSelection(null, {})).toBe('');
  });
  it('returns HTML with hero and meters', () => {
    const row = {
      totalTokens: 1000, inputTokens: 600, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0,
      modelBreakdown: [{ name: 'gpt-4o', totalTokens: 1000 }],
      workdirBreakdown: [{ name: '/a', totalTokens: 1000 }],
      detailBreakdown: []
    };
    const html = renderTrendSelection(row, { t });
    expect(html).toContain('section-block');
    expect(html).toContain('drawer-score-card');
    expect(html).toContain('composition-tile');
  });
});

describe('renderTrendDetailHero', () => {
  it('renders score card', () => {
    const html = renderTrendDetailHero({ totalTokens: 1000 }, { t });
    expect(html).toContain('drawer-score-card');
    expect(html).toContain('Total Tokens');
  });
  it('shows cost when showEstimatedCost=true', () => {
    const html = renderTrendDetailHero({ totalTokens: 1000, hasKnownPrice: true, estimatedCostUsd: 0.05 }, { showEstimatedCost: true, t });
    expect(html).toContain('cost-amount');
    expect(html).toContain('small');
  });
});

describe('renderTrendDetailBreakdown', () => {
  it('returns empty for no details', () => {
    expect(renderTrendDetailBreakdown({ detailBreakdown: [] }, {})).toBe('');
  });
  it('renders detail grid', () => {
    const row = {
      detailBreakdownTitle: 'Hourly',
      detailBreakdown: [
        { periodStart: '2026-05-23', periodEnd: '2026-05-23', totalTokens: 500, hour: 10, bucketLabel: '10:00' },
        { periodStart: '2026-05-23', periodEnd: '2026-05-23', totalTokens: 300, hour: 14, bucketLabel: '14:00' }
      ]
    };
    const html = renderTrendDetailBreakdown(row, { t });
    expect(html).toContain('hour-detail-grid');
    expect(html).toContain('10:00');
    expect(html).toContain('14:00');
  });
});

// ── Provider Overview ──

describe('renderProviderOverview', () => {
  const overview = {
    totalTokens: 8500,
    todayTokens: 8500,
    weekTokens: 8500,
    activeDays: 2,
    lastUsedDay: '2026-08-22',
    composition: { inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 1000, cacheWriteTokens: 500 },
    models: [
      { model: 'claude-sonnet-4', totalTokens: 7500 },
      { model: 'claude-opus-4', totalTokens: 800 },
      { model: 'claude-haiku', totalTokens: 200 }
    ],
    hasData: true
  };

  it('renders title, four stat cells and compact numbers', () => {
    const html = renderProviderOverview(overview, 'claude_code_local', { t });
    expect(html).toContain('provider-overview-title');
    expect(html).toContain('Data overview');
    expect(html).toContain('provider-overview-stats');
    expect((html.match(/class="provider-overview-stat"/g) || []).length).toBe(4);
    expect(html).toContain('8.5K');
    expect(html).toContain('2 days');
  });
  it('renders the four-segment composition bar and legend', () => {
    const html = renderProviderOverview(overview, 'claude_code_local', { t });
    expect(html).toContain('provider-overview-bar');
    expect(html).toContain('background:#b4552f');
    expect(html).toContain('background:#cf6a42');
    expect(html).toContain('background:#e0956b');
    expect(html).toContain('background:#f2ddcd');
    expect(html).toContain('provider-overview-legend');
    expect(html).toContain('Cache read');
    expect(html).toContain('59%');
  });
  it('renders the full model usage list with homepage meter rows and the last used day', () => {
    const html = renderProviderOverview(overview, 'claude_code_local', { t });
    expect(html).toContain('Model usage');
    expect(html).toContain('claude-sonnet-4');
    expect(html).toContain('claude-opus-4');
    expect(html).toContain('claude-haiku');
    expect(html).not.toContain('+1');
    const rows = html.match(/class="mini-meter-row"/g) || [];
    expect(rows.length).toBe((overview.models || []).length);
    expect(html).toContain('meter-val-top');
    expect(html).toContain('meter-pct');
    expect(html).toContain('88%');
    expect(html).toContain('Last used');
    expect(html).toContain('2026-08-22');
  });
  it('renders the empty note when there is no data', () => {
    const html = renderProviderOverview(undefined, 'zcode_local', { t });
    expect(html).toContain('provider-overview-note');
    expect(html).toContain('No usage data yet; run a scan to populate');
    expect(html).not.toContain('provider-overview-stats');
  });
  it('renders the capped note instead of misleading zeros', () => {
    const html = renderProviderOverview(undefined, 'zcode_local', { capped: true, t });
    expect(html).toContain('Dataset too large for this overview');
    expect(html).not.toContain('No usage data yet');
    expect(html).not.toContain('provider-overview-stats');
  });
});
