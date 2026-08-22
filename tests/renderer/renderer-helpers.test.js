// Tests for pure helper functions extracted from renderer.js
import { describe, it, expect } from 'vitest';
import {
  escapeHtml, cssEscape, clampHour, formatNumber, formatHourLabel,
  formatTime, formatDateTime, formatBytes, formatDate, formatTrendPeriod,
  formatAxisLabel, formatDetailBreakdownPeriod,
  hasPositiveUsage, hasConfiguredApiBaseUrl, normalizeApiBaseUrl,
  startOfUtcWeek, trailingDays, daysForLastWeeks, daysForLastMonths, bucketForDay,
  renderCostValue, renderCostAmountValue, renderCost, renderCostAmount,
  costValueForField, cacheTokens, sumKnownCosts, mergeCostQualityForDisplay,
  costTitle, renderAccountingToken,
  sortedBreakdown, finalizeCostBreakdown, addCostBreakdownItem,
  aggregateUsageCost, aggregateTrendRowCost, normalizeMissingPriceModels,
  trendBucketKey, emptyTrendRow, summaryLabel, summaryTitle,
  positiveInteger, normalizeTokenAggregate, normalizeBreakdownItems,
  normalizeUsageSummary, normalizeUsageTrend, normalizeUsageWorkdirs,
  normalizeUsageTotal, reconcileHealthWithConfig,
  providerStatusGroup, sortProviderHealthByStatus
} from '../../src/desktop/renderer-helpers.js';

// ── String / Number Utilities ──

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });
  it('escapes angle brackets', () => {
    expect(escapeHtml('<div>')).toBe('&lt;div&gt;');
  });
  it('escapes quotes', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
  });
  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });
  it('handles non-string input', () => {
    expect(escapeHtml(123)).toBe('123');
  });
  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('cssEscape', () => {
  it('escapes backslashes', () => {
    expect(cssEscape('a\\b')).toBe('a\\\\b');
  });
  it('escapes double quotes', () => {
    expect(cssEscape('a"b')).toBe('a\\"b');
  });
  it('handles non-string input', () => {
    expect(cssEscape(123)).toBe('123');
  });
});

describe('clampHour', () => {
  it('returns 0 for valid hours', () => {
    expect(clampHour(0)).toBe(0);
    expect(clampHour(12)).toBe(12);
    expect(clampHour(23)).toBe(23);
  });
  it('returns 0 for out of range', () => {
    expect(clampHour(-1)).toBe(0);
    expect(clampHour(24)).toBe(0);
    expect(clampHour(100)).toBe(0);
  });
  it('returns 0 for NaN', () => {
    expect(clampHour(NaN)).toBe(0);
  });
  it('returns 0 for null/undefined', () => {
    expect(clampHour(null)).toBe(0);
    expect(clampHour(undefined)).toBe(0);
  });
  it('handles string numbers', () => {
    expect(clampHour('5')).toBe(5);
  });
});

describe('formatNumber', () => {
  it('formats number with locale separators', () => {
    const result = formatNumber(1234567);
    expect(result).toContain('1');
    expect(result).toContain('234');
  });
  it('formats zero', () => {
    expect(formatNumber(0)).toBe('0');
  });
  it('handles null/undefined', () => {
    expect(formatNumber(null)).toBe('0');
    expect(formatNumber(undefined)).toBe('0');
  });
});

describe('formatHourLabel', () => {
  it('formats hour with leading zero', () => {
    expect(formatHourLabel(0)).toBe('00:00');
    expect(formatHourLabel(9)).toBe('09:00');
    expect(formatHourLabel(13)).toBe('13:00');
  });
  it('clamps invalid hours', () => {
    expect(formatHourLabel(25)).toBe('00:00');
  });
});

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
  });
  it('formats kilobytes', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
  it('formats megabytes', () => {
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
  it('handles zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });
  it('handles null', () => {
    expect(formatBytes(null)).toBe('0 B');
  });
});

describe('formatTime', () => {
  it('formats a date value as time string', () => {
    const result = formatTime('2026-05-23T14:30:00');
    expect(result).toContain('30');
    expect(result).toMatch(/\d/);
  });
  it('handles ISO string', () => {
    const result = formatTime('2026-05-23T09:05:00Z');
    expect(result).toBeTruthy();
  });
});

describe('formatDateTime', () => {
  it('formats date and time together', () => {
    const result = formatDateTime('2026-05-23T14:30:00');
    expect(result).toContain('May');
    expect(result).toContain('23');
    expect(result).toMatch(/\d.*30/);
  });
  it('formats short date with time', () => {
    const result = formatDateTime('2026-01-05T09:00:00');
    expect(result).toContain('Jan');
  });
});

describe('formatDate', () => {
  it('formats date string', () => {
    const result = formatDate('2026-05-23');
    expect(result).toContain('May');
    expect(result).toContain('23');
    expect(result).toContain('2026');
  });
});

describe('formatTrendPeriod', () => {
  it('formats single day', () => {
    const result = formatTrendPeriod({ periodStart: '2026-05-23', periodEnd: '2026-05-23' });
    expect(result).toContain('May');
    expect(result).toContain('23');
  });
  it('formats range', () => {
    const result = formatTrendPeriod({ periodStart: '2026-05-20', periodEnd: '2026-05-23' });
    expect(result).toContain('-');
  });
  it('formats with hour', () => {
    const result = formatTrendPeriod({ periodStart: '2026-05-23', periodEnd: '2026-05-23', hour: 14 });
    expect(result).toContain('14:00');
  });
});

describe('formatAxisLabel', () => {
  it('formats hour grain', () => {
    const result = formatAxisLabel({ hour: 9 }, 'hour');
    expect(result).toContain('09:00');
  });
  it('formats day grain', () => {
    const result = formatAxisLabel({ periodStart: '2026-05-23', periodEnd: '2026-05-23' }, 'day');
    expect(result).toContain('May');
  });
  it('formats week grain', () => {
    const result = formatAxisLabel({ periodStart: '2026-05-18', periodEnd: '2026-05-24' }, 'week');
    expect(result).toContain('–'); // em dash
  });
  it('formats month grain', () => {
    const result = formatAxisLabel({ periodStart: '2026-05-01', periodEnd: '2026-05-31' }, 'month');
    expect(result).toContain('May');
  });
});

describe('formatDetailBreakdownPeriod', () => {
  it('formats hour when hour is present', () => {
    const result = formatDetailBreakdownPeriod({ hour: 14 });
    expect(result).toBe('14:00');
  });
  it('formats period when no hour', () => {
    const result = formatDetailBreakdownPeriod({ periodStart: '2026-05-23', periodEnd: '2026-05-23' });
    expect(result).toContain('May');
    expect(result).toContain('23');
  });
  it('formats range period', () => {
    const result = formatDetailBreakdownPeriod({ periodStart: '2026-05-20', periodEnd: '2026-05-23' });
    expect(result).toContain('-');
  });
});

// ── Predicates ──

describe('hasPositiveUsage', () => {
  it('returns true for positive tokens', () => {
    expect(hasPositiveUsage({ totalTokens: 100 })).toBe(true);
  });
  it('returns false for zero tokens', () => {
    expect(hasPositiveUsage({ totalTokens: 0 })).toBe(false);
  });
  it('returns false for null/undefined', () => {
    expect(hasPositiveUsage(null)).toBe(false);
    expect(hasPositiveUsage(undefined)).toBe(false);
  });
});

describe('hasConfiguredApiBaseUrl', () => {
  it('returns true for valid URL', () => {
    expect(hasConfiguredApiBaseUrl({ apiBaseUrl: 'https://example.com' })).toBe(true);
  });
  it('returns false for empty string', () => {
    expect(hasConfiguredApiBaseUrl({ apiBaseUrl: '' })).toBe(false);
  });
  it('returns false for null config', () => {
    expect(hasConfiguredApiBaseUrl(null)).toBe(false);
  });
  it('returns false for whitespace only', () => {
    expect(hasConfiguredApiBaseUrl({ apiBaseUrl: '   ' })).toBe(false);
  });
});

describe('normalizeApiBaseUrl', () => {
  it('trims whitespace', () => {
    expect(normalizeApiBaseUrl('  https://example.com  ')).toBe('https://example.com');
  });
  it('removes trailing slashes', () => {
    expect(normalizeApiBaseUrl('https://example.com/')).toBe('https://example.com');
    expect(normalizeApiBaseUrl('https://example.com///')).toBe('https://example.com');
  });
  it('handles null', () => {
    expect(normalizeApiBaseUrl(null)).toBe('');
  });
  it('handles empty string', () => {
    expect(normalizeApiBaseUrl('')).toBe('');
  });
});

// ── Date Math ──

describe('startOfUtcWeek', () => {
  it('returns Monday for a given date', () => {
    // 2026-05-23 is a Saturday
    const date = new Date('2026-05-23T00:00:00Z');
    const monday = startOfUtcWeek(date);
    expect(monday.getUTCDay()).toBe(1); // Monday
    expect(monday.getUTCDate()).toBe(18); // May 18
  });
});

describe('bucketForDay', () => {
  it('returns same day for day grain', () => {
    const result = bucketForDay('2026-05-23', 'day');
    expect(result).toEqual({ key: '2026-05-23', periodStart: '2026-05-23', periodEnd: '2026-05-23' });
  });
  it('returns week boundaries for week grain', () => {
    const result = bucketForDay('2026-05-23', 'week');
    expect(result.key).toBe('2026-05-18'); // Monday
    expect(result.periodEnd).toBe('2026-05-24'); // Sunday
  });
  it('returns month boundaries for month grain', () => {
    const result = bucketForDay('2026-05-23', 'month');
    expect(result.key).toBe('2026-05-01');
    expect(result.periodStart).toBe('2026-05-01');
    expect(result.periodEnd).toBe('2026-05-31');
  });
});

describe('trailingDays', () => {
  it('returns correct count', () => {
    const days = trailingDays(7);
    expect(days).toHaveLength(7);
  });
  it('returns YYYY-MM-DD format', () => {
    const days = trailingDays(3);
    for (const day of days) {
      expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('daysForLastWeeks', () => {
  it('returns days spanning multiple weeks', () => {
    const days = daysForLastWeeks(2);
    expect(days.length).toBeGreaterThanOrEqual(7);
    expect(days.length).toBeLessThanOrEqual(14);
  });
});

describe('daysForLastMonths', () => {
  it('returns days spanning multiple months', () => {
    const days = daysForLastMonths(2);
    expect(days.length).toBeGreaterThanOrEqual(28);
  });
});

// ── Cost Functions ──

describe('renderCostValue', () => {
  it('returns formatted cost for known price', () => {
    const result = renderCostValue({ hasKnownPrice: true, estimatedCostUsd: 0.05 });
    expect(result).toContain('0.05');
  });
  it('returns dash for missing price', () => {
    expect(renderCostValue({ hasKnownPrice: false, missingPriceTokens: 100 })).toBe('-');
  });
});

describe('renderCostAmountValue', () => {
  it('wraps value in span', () => {
    const result = renderCostAmountValue('$0.05');
    expect(result).toContain('<span class="cost-amount">');
    expect(result).toContain('$0.05');
  });
  it('formats numeric value', () => {
    const result = renderCostAmountValue(0.05);
    expect(result).toContain('cost-amount');
  });
});

describe('renderCost', () => {
  it('returns formatted cost', () => {
    const result = renderCost({ hasKnownPrice: true, estimatedCostUsd: 0.05 });
    expect(result).toContain('0.05');
  });
  it('returns dash for missing price', () => {
    expect(renderCost({ hasKnownPrice: false, missingPriceTokens: 100 })).toBe('-');
  });
  it('appends asterisk for missing price tokens', () => {
    const result = renderCost({ hasKnownPrice: true, estimatedCostUsd: 0.05, missingPriceTokens: 50 });
    expect(result).toContain('*');
  });
});

describe('renderCostAmount', () => {
  it('returns span-wrapped cost', () => {
    const result = renderCostAmount({ hasKnownPrice: true, estimatedCostUsd: 0.05 });
    expect(result).toContain('cost-amount');
  });
});

describe('costValueForField', () => {
  const item = { inputCostUsd: 0.01, outputCostUsd: 0.02, cacheReadCostUsd: 0.005, cacheWriteCostUsd: 0.003 };
  it('returns input cost', () => {
    expect(costValueForField(item, 'inputTokens')).toBe(0.01);
  });
  it('returns output cost', () => {
    expect(costValueForField(item, 'outputTokens')).toBe(0.02);
  });
  it('returns cache cost (sum of read+write)', () => {
    expect(costValueForField(item, 'cacheTokens')).toBeCloseTo(0.008);
  });
});

describe('cacheTokens', () => {
  it('sums cache read and write', () => {
    expect(cacheTokens({ cacheReadTokens: 100, cacheWriteTokens: 50 })).toBe(150);
  });
  it('handles missing fields', () => {
    expect(cacheTokens({})).toBe(0);
  });
  it('handles missing fields', () => {
    expect(cacheTokens({})).toBe(0);
  });
});

describe('sumKnownCosts', () => {
  it('sums valid values', () => {
    expect(sumKnownCosts(0.01, 0.02, 0.03)).toBeCloseTo(0.06);
  });
  it('ignores null/undefined', () => {
    expect(sumKnownCosts(0.01, null, 0.03)).toBeCloseTo(0.04);
  });
  it('returns null for all null', () => {
    expect(sumKnownCosts(null, undefined)).toBeNull();
  });
});

describe('mergeCostQualityForDisplay', () => {
  it('returns empty for both empty', () => {
    expect(mergeCostQualityForDisplay('', '')).toBe('');
  });
  it('returns worse quality', () => {
    expect(mergeCostQualityForDisplay('exact_price', 'unknown_price')).toBe('unknown_price');
  });
  it('returns worse quality (higher rank)', () => {
    expect(mergeCostQualityForDisplay('exact_price', 'unknown_price')).toBe('unknown_price');
  });
  it('handles empty left', () => {
    expect(mergeCostQualityForDisplay('', 'estimated_price')).toBe('estimated_price');
  });
  it('handles empty right', () => {
    expect(mergeCostQualityForDisplay('exact_price', '')).toBe('exact_price');
  });
  it('returns right when right has higher rank', () => {
    expect(mergeCostQualityForDisplay('estimated_price', 'unknown_price')).toBe('unknown_price');
  });
  it('returns left when left has higher rank', () => {
    expect(mergeCostQualityForDisplay('unknown_price', 'exact_price')).toBe('unknown_price');
  });
});

describe('costTitle', () => {
  it('includes quality and version', () => {
    const result = costTitle({ costQuality: 'exact_price', pricingVersion: 'v1', missingPriceModels: [] }, { pricingSource: 'server' });
    expect(result).toContain('exact_price');
    expect(result).toContain('v1');
    expect(result).toContain('server');
  });
  it('shows missing models with token count', () => {
    const result = costTitle({ costQuality: 'exact_price', pricingVersion: 'v1', missingPriceModels: [{ name: 'gpt-5', totalTokens: 5000 }] }, { t: (k) => k });
    expect(result).toContain('gpt-5');
    expect(result).toContain('missing');
  });
  it('shows defaults when no quality or version', () => {
    const t = (k) => k;
    const result = costTitle({ costQuality: '', pricingVersion: '', missingPriceModels: [] }, { t });
    expect(result).toContain('unknownPrice');
    expect(result).toContain('noPricingVersion');
  });
  it('handles no opts argument', () => {
    const result = costTitle({ costQuality: 'exact_price', pricingVersion: 'v1', missingPriceModels: [] });
    expect(result).toContain('exact_price');
    expect(result).toContain('v1');
  });
});

describe('renderAccountingToken', () => {
  it('renders token count', () => {
    const result = renderAccountingToken(1234, 0.05);
    expect(result).toContain('token-accounting');
  });
  it('includes cost when showEstimatedCost', () => {
    const result = renderAccountingToken(1234, 0.05, { showEstimatedCost: true });
    expect(result).toContain('cost-amount');
  });
  it('omits cost when showEstimatedCost is false', () => {
    const result = renderAccountingToken(1234, 0.05, { showEstimatedCost: false });
    expect(result).not.toContain('cost-amount');
  });
});

// ── Data Transforms ──

describe('sortedBreakdown', () => {
  it('sorts by value descending', () => {
    const result = sortedBreakdown({ a: 10, b: 30, c: 20 });
    expect(result).toEqual([
      { name: 'b', totalTokens: 30 },
      { name: 'c', totalTokens: 20 },
      { name: 'a', totalTokens: 10 }
    ]);
  });
  it('handles null', () => {
    expect(sortedBreakdown(null)).toEqual([]);
  });
  it('handles empty object', () => {
    expect(sortedBreakdown({})).toEqual([]);
  });
});

describe('finalizeCostBreakdown', () => {
  it('sorts by totalTokens descending', () => {
    const map = {
      low: { name: 'low', totalTokens: 10, missingPriceModels: {} },
      high: { name: 'high', totalTokens: 100, missingPriceModels: {} }
    };
    const result = finalizeCostBreakdown(map);
    expect(result[0].name).toBe('high');
    expect(result[1].name).toBe('low');
  });
  it('handles null', () => {
    expect(finalizeCostBreakdown(null)).toEqual([]);
  });
});

describe('addCostBreakdownItem', () => {
  const noCost = { estimatedCostUsd: 0, costQuality: '', pricingVersion: '', missingPriceTokens: 0, missingPriceModels: {} };
  it('adds item to map', () => {
    const map = {};
    addCostBreakdownItem(map, 'gpt-4o', { totalTokens: 100 }, noCost);
    expect(map['gpt-4o']).toBeDefined();
    expect(map['gpt-4o'].totalTokens).toBe(100);
  });
  it('accumulates existing item', () => {
    const map = {};
    addCostBreakdownItem(map, 'gpt-4o', { totalTokens: 100 }, noCost);
    addCostBreakdownItem(map, 'gpt-4o', { totalTokens: 50 }, noCost);
    expect(map['gpt-4o'].totalTokens).toBe(150);
  });
  it('uses unknown for empty name', () => {
    const map = {};
    addCostBreakdownItem(map, '', { totalTokens: 100 }, noCost);
    expect(map['unknown']).toBeDefined();
  });
});

describe('aggregateUsageCost', () => {
  it('aggregates cost without priceMap', () => {
    const items = [
      { hasKnownPrice: true, estimatedCostUsd: 0.05, costQuality: 'exact_price', pricingVersion: 'v1', missingPriceModels: {} },
      { hasKnownPrice: true, estimatedCostUsd: 0.03, costQuality: 'estimated_price', pricingVersion: 'v1', missingPriceModels: {} }
    ];
    const result = aggregateUsageCost(items, null);
    expect(result.estimatedCostUsd).toBeCloseTo(0.08);
    expect(result.costQuality).toBe('estimated_price');
    expect(result.missingPriceModels).toEqual([]);
  });
  it('handles empty items', () => {
    const result = aggregateUsageCost([], null);
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.missingPriceModels).toEqual([]);
  });
  it('uses priceMap when provided', () => {
    const items = [
      { model: 'gpt-4o', inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' }
    ];
    const priceMap = { 'gpt-4o': { inputPrice: 0.01, outputPrice: 0.03 } };
    const result = aggregateUsageCost(items, priceMap);
    expect(result).toBeDefined();
    expect(typeof result.estimatedCostUsd).toBe('number');
  });
});

describe('aggregateTrendRowCost', () => {
  it('aggregates costs from rows', () => {
    const rows = [
      { hasKnownPrice: true, estimatedCostUsd: 0.05, costQuality: 'exact_price', pricingVersion: 'v1', missingPriceModels: [] },
      { hasKnownPrice: true, estimatedCostUsd: 0.03, costQuality: 'estimated_price', pricingVersion: 'v1', missingPriceModels: [] }
    ];
    const result = aggregateTrendRowCost(rows);
    expect(result.estimatedCostUsd).toBeCloseTo(0.08);
    expect(result.costQuality).toBe('estimated_price'); // estimated > exact
  });
  it('handles missing prices', () => {
    const rows = [
      { hasKnownPrice: false, missingPriceModels: [{ name: 'gpt-5', totalTokens: 1000 }] }
    ];
    const result = aggregateTrendRowCost(rows);
    expect(result.missingPriceTokens).toBe(1000);
  });
});

describe('normalizeMissingPriceModels', () => {
  it('passes through array', () => {
    const arr = [{ name: 'gpt-5', totalTokens: 100 }];
    expect(normalizeMissingPriceModels(arr)).toBe(arr);
  });
  it('converts object to sorted breakdown', () => {
    const result = normalizeMissingPriceModels({ 'gpt-5': 100, 'gpt-4o': 50 });
    expect(result[0].name).toBe('gpt-5');
  });
  it('handles null', () => {
    expect(normalizeMissingPriceModels(null)).toEqual([]);
  });
});

describe('trendBucketKey', () => {
  it('concatenates periodStart and periodEnd', () => {
    expect(trendBucketKey({ periodStart: '2026-05-23', periodEnd: '2026-05-23' })).toBe('2026-05-23|2026-05-23');
  });
});

describe('emptyTrendRow', () => {
  it('returns zeroed row', () => {
    const row = emptyTrendRow();
    expect(row.totalTokens).toBe(0);
    expect(row.periodStart).toBe('');
  });
  it('merges extra fields', () => {
    const row = emptyTrendRow({ periodStart: '2026-05-23', hour: 10 });
    expect(row.periodStart).toBe('2026-05-23');
    expect(row.hour).toBe(10);
  });
});

describe('summaryLabel', () => {
  it('returns dash for empty', () => {
    expect(summaryLabel([])).toBe('-');
  });
  it('returns single name', () => {
    expect(summaryLabel([{ name: 'gpt-4o' }])).toBe('gpt-4o');
  });
  it('returns top 2 with count', () => {
    const result = summaryLabel([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    expect(result).toBe('a, b +1');
  });
});

describe('summaryTitle', () => {
  it('joins names with tokens', () => {
    const result = summaryTitle([{ name: 'a', totalTokens: 100 }, { name: 'b', totalTokens: 200 }]);
    expect(result).toContain('a');
    expect(result).toContain('b');
  });
  it('returns empty for empty array', () => {
    expect(summaryTitle([])).toBe('');
  });
});

// ── Normalization ──

describe('positiveInteger', () => {
  it('returns positive integer', () => {
    expect(positiveInteger(5)).toBe(5);
  });
  it('rounds floats', () => {
    expect(positiveInteger(5.7)).toBe(6);
  });
  it('returns 0 for negative', () => {
    expect(positiveInteger(-1)).toBe(0);
  });
  it('returns 0 for NaN', () => {
    expect(positiveInteger(NaN)).toBe(0);
  });
  it('returns 0 for null', () => {
    expect(positiveInteger(null)).toBe(0);
  });
  it('handles string numbers', () => {
    expect(positiveInteger('10')).toBe(10);
  });
});

describe('normalizeTokenAggregate', () => {
  it('normalizes token fields', () => {
    const result = normalizeTokenAggregate({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 });
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.cacheReadTokens).toBe(20);
    expect(result.totalTokens).toBe(170); // computed sum
  });
  it('prefers explicit total', () => {
    const result = normalizeTokenAggregate({ inputTokens: 100, outputTokens: 50, totalTokens: 999 });
    expect(result.totalTokens).toBe(999);
  });
  it('handles empty input', () => {
    const result = normalizeTokenAggregate({});
    expect(result.totalTokens).toBe(0);
  });
  it('handles missing fields gracefully', () => {
    const result = normalizeTokenAggregate({ inputTokens: null, outputTokens: undefined });
    expect(result.totalTokens).toBe(0);
  });
});

describe('normalizeBreakdownItems', () => {
  it('normalizes and sorts by totalTokens', () => {
    const items = [
      { name: 'a', totalTokens: 100 },
      { name: 'b', totalTokens: 300 },
      { name: 'c', totalTokens: 200 }
    ];
    const result = normalizeBreakdownItems(items);
    expect(result[0].name).toBe('b');
    expect(result[1].name).toBe('c');
    expect(result[2].name).toBe('a');
  });
  it('filters zero-token items', () => {
    const items = [{ name: 'a', totalTokens: 0 }, { name: 'b', totalTokens: 100 }];
    const result = normalizeBreakdownItems(items);
    expect(result).toHaveLength(1);
  });
  it('handles empty array', () => {
    expect(normalizeBreakdownItems([])).toEqual([]);
  });
});

describe('normalizeUsageSummary', () => {
  it('normalizes totals and breakdowns', () => {
    const summary = {
      totals: { inputTokens: 100, outputTokens: 50 },
      providers: [{ name: 'a', totalTokens: 100 }],
      workdirs: [{ name: 'w', totalTokens: 50 }],
      models: [{ name: 'm', totalTokens: 150 }]
    };
    const result = normalizeUsageSummary(summary);
    expect(result.totals.totalTokens).toBe(150);
    expect(result.providers).toHaveLength(1);
  });
  it('handles empty input', () => {
    const result = normalizeUsageSummary({});
    expect(result.totals.totalTokens).toBe(0);
  });
});

describe('normalizeUsageTrend', () => {
  it('normalizes trend items', () => {
    const trend = {
      items: [
        { day: '2026-05-23', inputTokens: 100, outputTokens: 50 }
      ]
    };
    const result = normalizeUsageTrend(trend);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].totalTokens).toBe(150);
    expect(result.items[0].periodStart).toBe('2026-05-23');
  });
  it('filters zero-token items', () => {
    const trend = { items: [{ day: '2026-05-23', totalTokens: 0 }] };
    const result = normalizeUsageTrend(trend);
    expect(result.items).toHaveLength(0);
  });
});

describe('normalizeUsageWorkdirs', () => {
  it('normalizes workdir items', () => {
    const workdirs = {
      items: [{ workdirHash: 'h1', name: '/project', totalTokens: 100 }]
    };
    const result = normalizeUsageWorkdirs(workdirs);
    expect(result.items[0].workdirHash).toBe('h1');
  });
  it('uses fallback names', () => {
    const workdirs = { items: [{ totalTokens: 100 }] };
    const result = normalizeUsageWorkdirs(workdirs);
    expect(result.items[0].name).toBe('unknown');
  });
});

describe('normalizeUsageTotal', () => {
  it('computes total from fields', () => {
    const result = normalizeUsageTotal({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 });
    expect(result.totalTokens).toBe(170);
  });
  it('handles empty', () => {
    const result = normalizeUsageTotal({});
    expect(result.totalTokens).toBe(0);
  });
});

describe('reconcileHealthWithConfig', () => {
  it('returns health unchanged when no providerRoots', () => {
    const health = [{ providerId: 'codex_local', sources: [] }];
    expect(reconcileHealthWithConfig(health, {})).toBe(health);
  });
  it('merges manual roots into codex provider', () => {
    const health = [{ providerId: 'codex_local', sources: [], roots: [] }];
    const config = { providerRoots: { codex_local: ['/Users/me/project'] } };
    const result = reconcileHealthWithConfig(health, config);
    expect(result[0].sources.some(s => s.kind === 'manual')).toBe(true);
    expect(result[0].roots).toContain('/Users/me/project');
  });
  it('merges manual roots into claude_code_local provider', () => {
    const health = [{ providerId: 'claude_code_local', sources: [], roots: [] }];
    const config = { providerRoots: { claude_code_local: ['/home/dev/app'] } };
    const result = reconcileHealthWithConfig(health, config);
    expect(result[0].roots).toContain('/home/dev/app');
    expect(result[0].detected).toBe(true);
  });
  it('preserves existing manual source labels', () => {
    const health = [{ providerId: 'codex_local', sources: [{ kind: 'manual', path: '/p1', label: 'My Project' }], roots: ['/p1'] }];
    const config = { providerRoots: { codex_local: ['/p1'] } };
    const result = reconcileHealthWithConfig(health, config);
    expect(result[0].sources.find(s => s.path === '/p1').label).toBe('My Project');
  });
  it('preserves non-manual sources', () => {
    const health = [{ providerId: 'codex_local', sources: [{ kind: 'auto', path: '/detected' }], roots: ['/detected'] }];
    const config = { providerRoots: { codex_local: ['/manual'] } };
    const result = reconcileHealthWithConfig(health, config);
    expect(result[0].sources.some(s => s.kind === 'auto')).toBe(true);
    expect(result[0].sources.some(s => s.kind === 'manual')).toBe(true);
  });
  it('does not modify non-codex providers', () => {
    const health = [{ providerId: 'other', sources: [], roots: [] }];
    const config = { providerRoots: { codex_local: ['/path'] } };
    const result = reconcileHealthWithConfig(health, config);
    expect(result[0].sources).toHaveLength(0);
  });
  it('handles null config', () => {
    const health = [{ providerId: 'codex_local', sources: [] }];
    expect(reconcileHealthWithConfig(health, null)).toBe(health);
  });
  it('sets ok=false when no roots', () => {
    const health = [{ providerId: 'codex_local', sources: [], roots: [] }];
    const config = { providerRoots: { codex_local: [] } };
    const result = reconcileHealthWithConfig(health, config);
    expect(result[0].ok).toBe(false);
    expect(result[0].detected).toBe(false);
  });
});

describe('providerStatusGroup', () => {
  it('groups enabled+detected+ok as healthy (1)', () => {
    expect(providerStatusGroup({ providerId: 'codex_local', enabled: true, detected: true, ok: true })).toBe(1);
  });
  it('treats enabled+detected with ok undefined as healthy (1)', () => {
    expect(providerStatusGroup({ providerId: 'codex_local', enabled: true, detected: true })).toBe(1);
  });
  it('groups enabled but not detected as attention (2)', () => {
    expect(providerStatusGroup({ providerId: 'codex_local', enabled: true, detected: false, ok: false })).toBe(2);
  });
  it('groups enabled+detected but not ok as attention (2)', () => {
    expect(providerStatusGroup({ providerId: 'codex_local', enabled: true, detected: true, ok: false })).toBe(2);
  });
  it('groups disabled as off (3) even when detected', () => {
    expect(providerStatusGroup({ providerId: 'codex_local', enabled: false, detected: true, ok: true })).toBe(3);
  });
  it('treats missing enabled as enabled', () => {
    expect(providerStatusGroup({ providerId: 'codex_local', detected: true, ok: true })).toBe(1);
  });
});

describe('sortProviderHealthByStatus', () => {
  it('sorts healthy before attention before disabled', () => {
    const health = [
      { providerId: 'mimocode_local', enabled: false, detected: true, ok: true },
      { providerId: 'opencode_local', enabled: true, detected: false, ok: false },
      { providerId: 'claude_code_local', enabled: true, detected: true, ok: true },
    ];
    const sorted = sortProviderHealthByStatus(health);
    expect(sorted.map((item) => item.providerId)).toEqual([
      'claude_code_local', 'opencode_local', 'mimocode_local',
    ]);
  });
  it('keeps UI_PROVIDER_ORDER within the same group', () => {
    const health = [
      { providerId: 'zcode_local', enabled: true, detected: true, ok: true },
      { providerId: 'claude_code_local', enabled: true, detected: true, ok: true },
      { providerId: 'codex_local', enabled: true, detected: true, ok: true },
    ];
    const sorted = sortProviderHealthByStatus(health);
    expect(sorted.map((item) => item.providerId)).toEqual([
      'claude_code_local', 'codex_local', 'zcode_local',
    ]);
  });
  it('appends unknown providers after known ones within the same group, sorted by providerId', () => {
    const health = [
      { providerId: 'zzz_tool_local', enabled: true, detected: true, ok: true },
      { providerId: 'workbuddy_local', enabled: true, detected: true, ok: true },
      { providerId: 'aaa_tool_local', enabled: true, detected: true, ok: true },
    ];
    const sorted = sortProviderHealthByStatus(health);
    expect(sorted.map((item) => item.providerId)).toEqual([
      'workbuddy_local', 'aaa_tool_local', 'zzz_tool_local',
    ]);
  });
  it('does not mutate the input array', () => {
    const health = [
      { providerId: 'mimocode_local', enabled: false, detected: true, ok: true },
      { providerId: 'claude_code_local', enabled: true, detected: true, ok: true },
    ];
    const idsBefore = health.map((item) => item.providerId).join(',');
    sortProviderHealthByStatus(health);
    expect(health.map((item) => item.providerId).join(',')).toBe(idsBefore);
  });
  it('handles empty input', () => {
    expect(sortProviderHealthByStatus([])).toEqual([]);
  });
});
