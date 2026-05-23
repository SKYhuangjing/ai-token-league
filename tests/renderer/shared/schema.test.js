import { describe, it, expect } from 'vitest';
import { assertUsageItem, normalizeTokenNumber, primaryTokenTotal, displayTotalTokens, usageKey, publicUsageItem, SOURCE_QUALITY, FORBIDDEN_UPLOAD_FIELDS } from '../../../src/shared/schema.js';

function makeValidItem() {
  return {
    day: '2026-05-15',
    toolCode: 'codex',
    providerId: 'codex_local',
    workdirHash: 'h_abc',
    workdirDisplayName: '/project',
    model: 'gpt-5',
    totalTokens: 1000,
    inputTokens: 600,
    outputTokens: 400,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    sourceQuality: 'exact',
  };
}

describe('assertUsageItem', () => {
  it('accepts valid item', () => {
    expect(() => assertUsageItem(makeValidItem())).not.toThrow();
  });

  it('throws on missing day', () => {
    const item = makeValidItem();
    delete item.day;
    expect(() => assertUsageItem(item)).toThrow();
  });

  it('throws on missing toolCode', () => {
    const item = makeValidItem();
    delete item.toolCode;
    expect(() => assertUsageItem(item)).toThrow();
  });

  it('throws on forbidden upload field', () => {
    const item = makeValidItem();
    item.identityPrivateKey = 'secret';
    expect(() => assertUsageItem(item)).toThrow();
  });
});

describe('normalizeTokenNumber', () => {
  it('rounds to integer', () => {
    expect(normalizeTokenNumber(1.7)).toBe(2);
  });

  it('returns 0 for negative', () => {
    expect(normalizeTokenNumber(-5)).toBe(0);
  });

  it('returns 0 for NaN', () => {
    expect(normalizeTokenNumber(NaN)).toBe(0);
  });

  it('returns 0 for Infinity', () => {
    expect(normalizeTokenNumber(Infinity)).toBe(0);
  });

  it('returns 0 for null', () => {
    expect(normalizeTokenNumber(null)).toBe(0);
  });

  it('handles string numbers', () => {
    expect(normalizeTokenNumber('123')).toBe(123);
  });
});

describe('primaryTokenTotal', () => {
  it('sums input + output', () => {
    expect(primaryTokenTotal({ inputTokens: 100, outputTokens: 200 })).toBe(300);
  });

  it('returns 0 for undefined', () => {
    expect(primaryTokenTotal(undefined)).toBe(0);
  });

  it('throws for null (no default param)', () => {
    expect(() => primaryTokenTotal(null)).toThrow();
  });
});

describe('displayTotalTokens', () => {
  it('sums input + output + cache', () => {
    expect(displayTotalTokens({ inputTokens: 100, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 25 })).toBe(375);
  });

  it('returns 0 for missing item', () => {
    expect(displayTotalTokens(undefined)).toBe(0);
  });
});

describe('usageKey', () => {
  it('generates deterministic key', () => {
    const item = makeValidItem();
    const k1 = usageKey(item, 'p_user', 'd_dev');
    const k2 = usageKey(item, 'p_user', 'd_dev');
    expect(k1).toBe(k2);
    expect(k1).toContain('|');
  });

  it('differs for different participants', () => {
    const item = makeValidItem();
    expect(usageKey(item, 'p_a', 'd_dev')).not.toBe(usageKey(item, 'p_b', 'd_dev'));
  });
});

describe('publicUsageItem', () => {
  it('strips forbidden fields', () => {
    const item = makeValidItem();
    item.prompt = 'secret';
    item.identityPrivateKey = 'secret';
    const pub = publicUsageItem(item);
    expect(pub.prompt).toBeUndefined();
    expect(pub.identityPrivateKey).toBeUndefined();
  });

  it('preserves allowed fields', () => {
    const item = makeValidItem();
    const pub = publicUsageItem(item);
    expect(pub.day).toBe(item.day);
    expect(pub.toolCode).toBe(item.toolCode);
    expect(pub.totalTokens).toBeDefined();
  });
});

describe('SOURCE_QUALITY', () => {
  it('contains expected values', () => {
    expect(SOURCE_QUALITY.has('exact')).toBe(true);
    expect(SOURCE_QUALITY.has('partial')).toBe(true);
    expect(SOURCE_QUALITY.has('estimated')).toBe(true);
    expect(SOURCE_QUALITY.has('unknown_quality')).toBe(false);
  });
});

describe('FORBIDDEN_UPLOAD_FIELDS', () => {
  it('contains sensitive field names', () => {
    expect(FORBIDDEN_UPLOAD_FIELDS.has('identityPrivateKey')).toBe(true);
    expect(FORBIDDEN_UPLOAD_FIELDS.has('prompt')).toBe(true);
    expect(FORBIDDEN_UPLOAD_FIELDS.has('access_token')).toBe(true);
  });
});
