export const PRICING_VERSION = "litellm-compatible-2026-04-29-fallback";

export const FALLBACK_PRICE_MAP = {
  "gpt-5": {
    input_cost_per_token: 0.000001375,
    output_cost_per_token: 0.000011,
    cache_read_input_token_cost: 0.0000001375,
    cache_creation_input_token_cost: 0,
    reasoning_cost_per_token: 0.000011
  },
  "gpt-5-mini": {
    input_cost_per_token: 0.000000275,
    output_cost_per_token: 0.0000022,
    cache_read_input_token_cost: 0.0000000275,
    cache_creation_input_token_cost: 0,
    reasoning_cost_per_token: 0.0000022
  },
  "claude-sonnet": {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000003,
    cache_creation_input_token_cost: 0.00000375,
    reasoning_cost_per_token: 0.000015
  },
  "claude-opus": {
    input_cost_per_token: 0.000015,
    output_cost_per_token: 0.000075,
    cache_read_input_token_cost: 0.0000015,
    cache_creation_input_token_cost: 0.00001875,
    reasoning_cost_per_token: 0.000075
  }
};

export function estimateUsageCost(item, priceMap = FALLBACK_PRICE_MAP) {
  const match = resolvePriceKey(item.model, priceMap);
  if (!match) {
    return {
      estimatedCostUsd: null,
      costQuality: "unknown_price",
      pricingVersion: PRICING_VERSION,
      pricingModel: ""
    };
  }
  const price = priceMap[match.key];
  const input = tokenCost(item.inputTokens, price.input_cost_per_token);
  const output = tokenCost(item.outputTokens, price.output_cost_per_token);
  const cacheRead = tokenCost(item.cacheReadTokens, price.cache_read_input_token_cost ?? price.input_cost_per_token);
  const cacheWrite = tokenCost(item.cacheWriteTokens, price.cache_creation_input_token_cost ?? price.input_cost_per_token);
  const reasoning = tokenCost(item.reasoningTokens, price.reasoning_cost_per_token ?? price.output_cost_per_token);
  return {
    estimatedCostUsd: roundUsd(input + output + cacheRead + cacheWrite + reasoning),
    costQuality: match.exact ? "exact_price" : "estimated_price",
    pricingVersion: PRICING_VERSION,
    pricingModel: match.key
  };
}

export function addCostToUsageItem(item, priceMap = FALLBACK_PRICE_MAP) {
  return { ...item, ...estimateUsageCost(item, priceMap) };
}

export function aggregateCost(target, source) {
  if (source.estimatedCostUsd === null || source.estimatedCostUsd === undefined) {
    target.missingPriceModels ||= {};
    const model = source.model || "unknown";
    target.missingPriceModels[model] = (target.missingPriceModels[model] || 0) + (source.totalTokens || 0);
    target.missingPriceTokens = (target.missingPriceTokens || 0) + (source.totalTokens || 0);
    target.costQuality = mergeCostQuality(target.costQuality, "unknown_price");
    return;
  }
  target.hasKnownPrice = true;
  target.estimatedCostUsd = roundUsd((target.estimatedCostUsd || 0) + source.estimatedCostUsd);
  target.costQuality = mergeCostQuality(target.costQuality, source.costQuality || "unknown_price");
  target.pricingVersion ||= source.pricingVersion || PRICING_VERSION;
}

export function mergeCostQuality(left = "", right = "") {
  const rank = { exact_price: 0, estimated_price: 1, unknown_price: 2 };
  if (!left) return right || "";
  if (!right) return left;
  return rank[right] > rank[left] ? right : left;
}

export function createPriceMap(customPrices = {}) {
  const customMap = {};
  for (const price of Object.values(customPrices || {})) {
    const key = normalizeModelName(price.model || price.key || "");
    if (!key) continue;
    customMap[key] = {
      input_cost_per_token: toPerToken(price.inputCostPerMTok ?? price.input_cost_per_token, "inputCostPerMTok" in price),
      output_cost_per_token: toPerToken(price.outputCostPerMTok ?? price.output_cost_per_token, "outputCostPerMTok" in price),
      cache_read_input_token_cost: toPerToken(price.cacheReadCostPerMTok ?? price.cache_read_input_token_cost, "cacheReadCostPerMTok" in price),
      cache_creation_input_token_cost: toPerToken(price.cacheWriteCostPerMTok ?? price.cache_creation_input_token_cost, "cacheWriteCostPerMTok" in price),
      reasoning_cost_per_token: toPerToken(price.reasoningCostPerMTok ?? price.reasoning_cost_per_token, "reasoningCostPerMTok" in price),
      source: price.source || "custom",
      updatedAt: price.updatedAt || ""
    };
  }
  return { ...FALLBACK_PRICE_MAP, ...customMap };
}

export function normalizeModelName(model) {
  return String(model || "")
    .trim()
    .toLowerCase()
    .replace(/^openai\//, "")
    .replace(/^anthropic\//, "");
}

export function priceToPublic(model, price) {
  return {
    model,
    inputCostPerMTok: toPerMillion(price.input_cost_per_token),
    outputCostPerMTok: toPerMillion(price.output_cost_per_token),
    cacheReadCostPerMTok: toPerMillion(price.cache_read_input_token_cost),
    cacheWriteCostPerMTok: toPerMillion(price.cache_creation_input_token_cost),
    reasoningCostPerMTok: toPerMillion(price.reasoning_cost_per_token),
    source: price.source || "builtin",
    updatedAt: price.updatedAt || ""
  };
}

function resolvePriceKey(model = "", priceMap = FALLBACK_PRICE_MAP) {
  const normalized = normalizeModelName(model);
  if (!normalized) return null;
  if (priceMap[normalized]) return { key: normalized, exact: true };
  if (normalized.includes("gpt-5.4-mini") || normalized.includes("gpt-5-mini")) return priceMap["gpt-5-mini"] ? { key: "gpt-5-mini", exact: false } : null;
  if (normalized.includes("gpt-5")) return priceMap["gpt-5"] ? { key: "gpt-5", exact: false } : null;
  if (normalized.includes("sonnet")) return priceMap["claude-sonnet"] ? { key: "claude-sonnet", exact: false } : null;
  if (normalized.includes("opus")) return priceMap["claude-opus"] ? { key: "claude-opus", exact: false } : null;
  return null;
}

function tokenCost(tokens, costPerToken = 0) {
  const n = Number(tokens || 0);
  const price = Number(costPerToken || 0);
  return Number.isFinite(n) && Number.isFinite(price) ? n * price : 0;
}

function roundUsd(value) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

function toPerToken(value, isPerMillion = false) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return isPerMillion ? n / 1_000_000 : n;
}

function toPerMillion(value) {
  return Math.round(Number(value || 0) * 1_000_000 * 1_000_000) / 1_000_000;
}
