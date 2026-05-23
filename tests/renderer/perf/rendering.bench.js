// Performance benchmarks for renderer logic
import { bench, describe } from 'vitest';
import { formatTokenCompact, formatUsd } from '../../../src/shared/display.js';
import { compositionRatio, tokenCompositionSummary, dominantComposition, createEmptyComposition, mergeTokenComposition } from '../../../src/shared/composition.js';
import { estimateUsageCost, addCostToUsageItem, normalizeModelName, aggregateCost } from '../../../src/shared/pricing.js';
import { normalizeTokenNumber, primaryTokenTotal, displayTotalTokens } from '../../../src/shared/schema.js';

// Helper to generate mock usage items
function generateItems(count) {
  const models = ['gpt-4o', 'gpt-5', 'claude-3-opus', 'claude-3-sonnet', 'codex-mini'];
  return Array.from({ length: count }, (_, i) => ({
    day: `2026-05-${String(1 + (i % 28)).padStart(2, '0')}`,
    hour: i % 24,
    toolCode: i % 2 === 0 ? 'codex' : 'claude_code',
    providerId: i % 2 === 0 ? 'codex_local' : 'claude_code_local',
    workdirHash: `h_${i % 10}`,
    workdirDisplayName: `/project-${i % 10}`,
    model: models[i % models.length],
    inputTokens: Math.floor(Math.random() * 10000),
    outputTokens: Math.floor(Math.random() * 5000),
    cacheReadTokens: Math.floor(Math.random() * 2000),
    cacheWriteTokens: Math.floor(Math.random() * 1000),
    reasoningTokens: Math.floor(Math.random() * 500),
    totalTokens: Math.floor(Math.random() * 18500),
    sourceQuality: 'exact',
  }));
}

const priceMap = {
  'gpt-4o': { input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001, source: 'openrouter', pricingVersion: 'openrouter-cache' },
  'gpt-5': { input_cost_per_token: 0.000005, output_cost_per_token: 0.00002, source: 'openrouter', pricingVersion: 'openrouter-cache' },
  'claude-3-opus': { input_cost_per_token: 0.000015, output_cost_per_token: 0.000075, source: 'openrouter', pricingVersion: 'openrouter-cache' },
  'claude-3-sonnet': { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015, source: 'openrouter', pricingVersion: 'openrouter-cache' },
  'codex-mini': { input_cost_per_token: 0.000001, output_cost_per_token: 0.000005, source: 'openrouter', pricingVersion: 'openrouter-cache' },
};

describe('formatTokenCompact', () => {
  bench('format 10000 values', () => {
    for (let i = 0; i < 10000; i++) {
      formatTokenCompact(i * 1234, 'en');
    }
  });

  bench('format zero', () => {
    formatTokenCompact(0, 'en');
  });

  bench('format large number', () => {
    formatTokenCompact(123456789, 'en');
  });
});

describe('formatUsd', () => {
  bench('format 10000 values', () => {
    for (let i = 0; i < 10000; i++) {
      formatUsd(i * 0.001);
    }
  });

  bench('format null', () => {
    formatUsd(null);
  });

  bench('format tiny value', () => {
    formatUsd(0.001);
  });
});

describe('compositionRatio', () => {
  bench('compute 10000 ratios', () => {
    for (let i = 0; i < 10000; i++) {
      compositionRatio(i, 10000);
    }
  });
});

describe('tokenCompositionSummary', () => {
  const item = { inputTokens: 6000, outputTokens: 3000, cacheReadTokens: 1000, cacheWriteTokens: 500, reasoningTokens: 200, totalTokens: 10700 };

  bench('compute summary', () => {
    tokenCompositionSummary(item);
  });

  bench('compute summary for zero', () => {
    tokenCompositionSummary({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 });
  });
});

describe('dominantComposition', () => {
  bench('determine dominant', () => {
    dominantComposition({ inputTokens: 6000, outputTokens: 3000, cacheReadTokens: 1000, cacheWriteTokens: 500, reasoningTokens: 200 });
  });
});

describe('normalizeTokenNumber', () => {
  bench('normalize 10000 values', () => {
    for (let i = 0; i < 10000; i++) {
      normalizeTokenNumber(i);
    }
  });

  bench('normalize edge cases', () => {
    normalizeTokenNumber(NaN);
    normalizeTokenNumber(Infinity);
    normalizeTokenNumber(-1);
    normalizeTokenNumber(null);
  });
});

describe('primaryTokenTotal + displayTotalTokens', () => {
  const item = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100 };

  bench('primaryTokenTotal x10000', () => {
    for (let i = 0; i < 10000; i++) {
      primaryTokenTotal(item);
    }
  });

  bench('displayTotalTokens x10000', () => {
    for (let i = 0; i < 10000; i++) {
      displayTotalTokens(item);
    }
  });
});

describe('estimateUsageCost', () => {
  const item = generateItems(1)[0];

  bench('estimate with priceMap', () => {
    estimateUsageCost(item, priceMap);
  });

  bench('estimate without priceMap', () => {
    estimateUsageCost(item);
  });
});

describe('normalizeModelName', () => {
  bench('normalize 10000 names', () => {
    for (let i = 0; i < 10000; i++) {
      normalizeModelName('openrouter/GPT-4o');
    }
  });
});

describe('aggregateCost', () => {
  const items = generateItems(100).map(i => addCostToUsageItem(i, priceMap));

  bench('aggregate 100 items', () => {
    const target = { estimatedCostUsd: 0, inputCostUsd: 0, outputCostUsd: 0, missingPriceModels: {} };
    for (const item of items) {
      aggregateCost(target, item);
    }
  });
});

describe('mergeTokenComposition', () => {
  const items = generateItems(100);

  bench('merge 100 items', () => {
    const target = createEmptyComposition();
    for (const item of items) {
      mergeTokenComposition(target, item);
    }
  });
});
