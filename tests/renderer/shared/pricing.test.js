import { describe, it, expect } from 'vitest';
import { estimateUsageCost, addCostToUsageItem, aggregateCost, mergeCostQuality, createPriceMap, normalizeModelName, priceToPublic, openRouterModelToPrice } from '../../../src/shared/pricing.js';

function makeItem(overrides = {}) {
  return {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheWriteTokens: 100,
    reasoningTokens: 50,
    model: 'gpt-4o',
    totalTokens: 1850,
    ...overrides,
  };
}

function makePriceMap() {
  return {
    'gpt-4o': {
      input_cost_per_token: 0.0000025,
      output_cost_per_token: 0.00001,
      cache_read_input_token_cost: 0.00000025,
      cache_creation_input_token_cost: 0.0000025,
      source: 'openrouter',
      pricingVersion: 'openrouter-cache',
    },
  };
}

describe('estimateUsageCost', () => {
  it('returns null costs for unknown model when no priceMap', () => {
    const cost = estimateUsageCost(makeItem());
    expect(cost.estimatedCostUsd).toBeNull();
    expect(cost.costQuality).toBe('unknown_price');
  });

  it('computes cost from priceMap', () => {
    const priceMap = makePriceMap();
    const cost = estimateUsageCost(makeItem(), priceMap);
    expect(cost.inputCostUsd).toBeGreaterThan(0);
    expect(cost.outputCostUsd).toBeGreaterThan(0);
    expect(cost.cacheReadCostUsd).toBeGreaterThan(0);
    expect(cost.cacheWriteCostUsd).toBeGreaterThan(0);
    expect(cost.estimatedCostUsd).toBeGreaterThan(0);
    expect(cost.costQuality).toBe('exact_price');
  });

  it('handles zero tokens', () => {
    const cost = estimateUsageCost(makeItem({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }));
    expect(cost.estimatedCostUsd).toBeNull();
  });
});

describe('aggregateCost', () => {
  it('accumulates costs from multiple items', () => {
    const priceMap = makePriceMap();
    const target = { estimatedCostUsd: 0, inputCostUsd: 0, outputCostUsd: 0 };
    const item1 = addCostToUsageItem(makeItem(), priceMap);
    const item2 = addCostToUsageItem(makeItem({ inputTokens: 2000, totalTokens: 2850 }), priceMap);

    aggregateCost(target, item1);
    aggregateCost(target, item2);

    expect(target.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('tracks missing price models as object', () => {
    const target = { estimatedCostUsd: 0, missingPriceModels: {} };
    const item = makeItem({ model: 'unknown-model' });
    aggregateCost(target, item);
    expect(target.missingPriceModels['unknown-model']).toBeDefined();
  });
});

describe('mergeCostQuality', () => {
  it('returns exact when both exact', () => {
    expect(mergeCostQuality('exact_price', 'exact_price')).toBe('exact_price');
  });

  it('returns worse quality', () => {
    expect(mergeCostQuality('exact_price', 'unknown_price')).toBe('unknown_price');
    expect(mergeCostQuality('estimated_price', 'exact_price')).toBe('estimated_price');
  });

  it('handles empty strings', () => {
    expect(mergeCostQuality('', 'exact_price')).toBe('exact_price');
    expect(mergeCostQuality('', '')).toBe('');
  });
});

describe('createPriceMap', () => {
  it('returns empty map with no inputs', () => {
    const map = createPriceMap();
    expect(Object.keys(map)).toHaveLength(0);
  });

  it('builds map from remote prices array', () => {
    const remote = [
      { model: 'gpt-4o', input_cost_per_token: 0.001, output_cost_per_token: 0.002 },
      { model: 'claude-3', input_cost_per_token: 0.003, output_cost_per_token: 0.004 },
    ];
    const map = createPriceMap({}, remote);
    expect(map['gpt-4o']).toBeDefined();
    expect(map['claude-3']).toBeDefined();
  });
});

describe('normalizeModelName', () => {
  it('lowercases and trims', () => {
    expect(normalizeModelName('  GPT-4o  ')).toBe('gpt-4o');
  });

  it('strips openrouter prefix', () => {
    expect(normalizeModelName('openrouter/gpt-4o')).toBe('gpt-4o');
  });

  it('strips tilde prefix', () => {
    expect(normalizeModelName('~gpt-4o')).toBe('gpt-4o');
  });
});

describe('priceToPublic', () => {
  it('converts internal price to public format', () => {
    const price = {
      input_cost_per_token: 0.0000025,
      output_cost_per_token: 0.00001,
      cache_read_input_token_cost: 0.00000025,
      cache_creation_input_token_cost: 0.0000025,
      source: 'openrouter',
      pricingVersion: 'v1',
      updatedAt: '2026-05-23'
    };
    const result = priceToPublic('gpt-4o', price);
    expect(result.model).toBe('gpt-4o');
    expect(result.inputCostPerMTok).toBeGreaterThan(0);
    expect(result.outputCostPerMTok).toBeGreaterThan(0);
    expect(result.source).toBe('openrouter');
    expect(result.reasoningCostPerMTok).toBe(0);
  });
});

describe('openRouterModelToPrice', () => {
  it('converts OpenRouter model to price record', () => {
    const model = {
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      canonical_slug: 'gpt-4o',
      pricing: { prompt: 0.0000025, completion: 0.00001, input_cache_read: 0.00000025, input_cache_write: 0.0000025 },
      context_length: 128000,
      top_provider: { max_completion_tokens: 4096 }
    };
    const result = openRouterModelToPrice(model, '2026-05-23');
    expect(result.model).toBe('openai/gpt-4o');
    expect(result.displayName).toBe('GPT-4o');
    expect(result.input_cost_per_token).toBe(0.0000025);
    expect(result.output_cost_per_token).toBe(0.00001);
    expect(result.max_input_tokens).toBe(128000);
    expect(result.source).toBe('openrouter');
  });
  it('returns null for model with no pricing', () => {
    const model = { id: 'test', pricing: {} };
    expect(openRouterModelToPrice(model)).toBeNull();
  });
  it('handles missing fields gracefully', () => {
    const model = { pricing: { prompt: 0.001, completion: 0.002 } };
    const result = openRouterModelToPrice(model);
    expect(result).toBeDefined();
    expect(result.max_input_tokens).toBe(0);
  });
});

describe('estimateUsageCost with fuzzy matching', () => {
  it('matches model with fuzzy lookup', () => {
    const priceMap = {
      'openai/gpt-4o': {
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.00001,
        source: 'openrouter',
        pricingVersion: 'test'
      }
    };
    const cost = estimateUsageCost({ model: 'gpt-4o', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 150 }, priceMap);
    expect(cost.estimatedCostUsd).toBeGreaterThan(0);
    expect(cost.costQuality).toBe('estimated_price');
  });
});

describe('createPriceMap with aliases', () => {
  it('creates aliases from model map', () => {
    const remote = [
      { model: 'gpt-4o', input_cost_per_token: 0.001, output_cost_per_token: 0.002, source: 'test' }
    ];
    const aliases = { 'gpt4': 'gpt-4o' };
    const map = createPriceMap({}, remote, aliases);
    expect(map['gpt4']).toBeDefined();
    expect(map['gpt4'].aliasTarget).toBe('gpt-4o');
  });
  it('ignores self-referencing aliases', () => {
    const remote = [
      { model: 'gpt-4o', input_cost_per_token: 0.001, output_cost_per_token: 0.002, source: 'test' }
    ];
    const aliases = { 'gpt-4o': 'gpt-4o' };
    const map = createPriceMap({}, remote, aliases);
    expect(map['gpt-4o']).toBeDefined();
    expect(map['gpt-4o'].aliasTarget).toBeUndefined();
  });
});

describe('createPriceMap with custom prices', () => {
  it('merges custom prices over remote', () => {
    const remote = [
      { model: 'gpt-4o', input_cost_per_token: 0.001, output_cost_per_token: 0.002, source: 'remote' }
    ];
    const custom = [
      { model: 'gpt-4o', input_cost_per_token: 0.005, output_cost_per_token: 0.01, source: 'custom' }
    ];
    const map = createPriceMap(custom, remote);
    expect(map['gpt-4o']).toBeDefined();
    expect(map['gpt-4o'].input_cost_per_token).toBe(0.005);
  });
});
