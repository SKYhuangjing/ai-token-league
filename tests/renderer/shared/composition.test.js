import { describe, it, expect } from 'vitest';
import { createEmptyComposition, mergeTokenComposition, compositionRatio, tokenCompositionSummary, dominantComposition, tokenCompositionDetails, costQualityLabel } from '../../../src/shared/composition.js';

describe('createEmptyComposition', () => {
  it('returns zeroed object', () => {
    const c = createEmptyComposition();
    expect(c.inputTokens).toBe(0);
    expect(c.outputTokens).toBe(0);
    expect(c.cacheReadTokens).toBe(0);
    expect(c.cacheWriteTokens).toBe(0);
    expect(c.reasoningTokens).toBe(0);
  });
});

describe('mergeTokenComposition', () => {
  it('accumulates values', () => {
    const target = createEmptyComposition();
    target.inputTokens = 100;
    const source = { inputTokens: 200, outputTokens: 50 };
    const result = mergeTokenComposition(target, source);
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(50);
  });

  it('handles undefined source', () => {
    const target = createEmptyComposition();
    target.inputTokens = 100;
    const result = mergeTokenComposition(target, undefined);
    expect(result.inputTokens).toBe(100);
  });
});

describe('compositionRatio', () => {
  it('returns ratio', () => {
    expect(compositionRatio(50, 100)).toBeCloseTo(0.5);
  });

  it('returns 0 for zero total', () => {
    expect(compositionRatio(50, 0)).toBe(0);
  });

  it('returns 0 for zero value', () => {
    expect(compositionRatio(0, 100)).toBe(0);
  });
});

describe('tokenCompositionSummary', () => {
  it('returns no-composition text for zero total', () => {
    const summary = tokenCompositionSummary({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 });
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });

  it('returns percentage breakdown for valid usage', () => {
    const item = { inputTokens: 600, outputTokens: 300, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 1000 };
    const summary = tokenCompositionSummary(item);
    expect(summary).toContain('%');
  });
});

describe('dominantComposition', () => {
  it('returns no-usage for zero tokens', () => {
    expect(dominantComposition({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })).toBe('no-usage');
  });

  it('returns input-heavy when input dominates', () => {
    expect(dominantComposition({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 50, reasoningTokens: 0 })).toBe('input-heavy');
  });

  it('returns output-heavy when output dominates', () => {
    expect(dominantComposition({ inputTokens: 100, outputTokens: 1000, cacheReadTokens: 50, cacheWriteTokens: 50, reasoningTokens: 0 })).toBe('output-heavy');
  });

  it('returns cache-heavy when cache dominates', () => {
    expect(dominantComposition({ inputTokens: 100, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 500, reasoningTokens: 0 })).toBe('cache-heavy');
  });
});

describe('tokenCompositionDetails', () => {
  it('returns details for each field', () => {
    const details = tokenCompositionDetails({ inputTokens: 60, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 100 });
    expect(details).toHaveLength(5);
    expect(details[0].field).toBe('inputTokens');
    expect(details[0].tokens).toBe(60);
    expect(details[0].ratio).toBeCloseTo(0.6);
  });
  it('returns zero ratio for zero total', () => {
    const details = tokenCompositionDetails({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(details[0].ratio).toBe(0);
  });
});

describe('costQualityLabel', () => {
  it('returns exact for exact_price', () => {
    expect(costQualityLabel('exact_price')).toBeTruthy();
  });
  it('returns estimated for estimated_price', () => {
    expect(costQualityLabel('estimated_price')).toBeTruthy();
  });
  it('returns missing for unknown', () => {
    expect(costQualityLabel('unknown')).toBeTruthy();
  });
  it('handles empty string', () => {
    expect(costQualityLabel('')).toBeTruthy();
  });
});
