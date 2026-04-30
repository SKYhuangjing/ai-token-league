export const PRICING_VERSION = "openrouter-cache";
export const FALLBACK_PRICE_MAP = {};

export function estimateUsageCost(item, priceMap = {}) {
  const match = resolvePriceKey(item.model, priceMap);
  if (!match) {
    return {
      inputCostUsd: null,
      outputCostUsd: null,
      cacheReadCostUsd: null,
      cacheWriteCostUsd: null,
      reasoningCostUsd: null,
      estimatedCostUsd: null,
      costQuality: "unknown_price",
      pricingVersion: PRICING_VERSION,
      pricingModel: "",
      pricingSource: ""
    };
  }
  const price = priceMap[match.key];
  const cacheReadTokens = Number(item.cacheReadTokens || 0);
  const cacheWriteTokens = Number(item.cacheWriteTokens || 0);
  // inputTokens is the normalized non-cache input fact. Cache remains priced separately.
  const input = tokenCost(item.inputTokens, price.input_cost_per_token);
  const output = tokenCost(item.outputTokens, price.output_cost_per_token);
  const cacheRead = tokenCost(cacheReadTokens, price.cache_read_input_token_cost ?? price.input_cost_per_token);
  const cacheWrite = tokenCost(cacheWriteTokens, price.cache_creation_input_token_cost ?? price.input_cost_per_token);
  const reasoning = tokenCost(item.reasoningTokens, price.reasoning_cost_per_token);
  return {
    inputCostUsd: roundUsd(input),
    outputCostUsd: roundUsd(output),
    cacheReadCostUsd: roundUsd(cacheRead),
    cacheWriteCostUsd: roundUsd(cacheWrite),
    reasoningCostUsd: roundUsd(reasoning),
    estimatedCostUsd: roundUsd(input + output + cacheRead + cacheWrite + reasoning),
    costQuality: match.exact ? "exact_price" : "estimated_price",
    pricingVersion: price.pricingVersion || PRICING_VERSION,
    pricingModel: match.key,
    pricingSource: price.source || ""
  };
}

export function addCostToUsageItem(item, priceMap = {}) {
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
  target.inputCostUsd = roundUsd((target.inputCostUsd || 0) + Number(source.inputCostUsd || 0));
  target.outputCostUsd = roundUsd((target.outputCostUsd || 0) + Number(source.outputCostUsd || 0));
  target.cacheReadCostUsd = roundUsd((target.cacheReadCostUsd || 0) + Number(source.cacheReadCostUsd || 0));
  target.cacheWriteCostUsd = roundUsd((target.cacheWriteCostUsd || 0) + Number(source.cacheWriteCostUsd || 0));
  target.reasoningCostUsd = roundUsd((target.reasoningCostUsd || 0) + Number(source.reasoningCostUsd || 0));
  target.estimatedCostUsd = roundUsd((target.estimatedCostUsd || 0) + source.estimatedCostUsd);
  target.costQuality = mergeCostQuality(target.costQuality, source.costQuality || "unknown_price");
  target.pricingVersion ||= source.pricingVersion || PRICING_VERSION;
  target.pricingSource ||= source.pricingSource || "";
}

export function mergeCostQuality(left = "", right = "") {
  const rank = { exact_price: 0, estimated_price: 1, unknown_price: 2 };
  if (!left) return right || "";
  if (!right) return left;
  return rank[right] > rank[left] ? right : left;
}

export function createPriceMap(customPrices = {}, remotePrices = {}) {
  const remoteMap = {};
  for (const price of Object.values(remotePrices || {})) {
    const key = normalizeModelName(price.model || price.key || "");
    if (!key) continue;
    remoteMap[key] = normalizePriceRecord(price, {
      source: price.source || "openrouter",
      pricingVersion: price.pricingVersion || PRICING_VERSION
    });
  }
  const customMap = {};
  for (const price of Object.values(customPrices || {})) {
    const key = normalizeModelName(price.model || price.key || "");
    if (!key) continue;
    customMap[key] = normalizePriceRecord(price, {
      source: price.source || "custom",
      pricingVersion: "custom-overrides"
    });
  }
  return { ...remoteMap, ...customMap };
}

export function normalizeModelName(model) {
  return String(model || "")
    .trim()
    .toLowerCase()
    .replace(/^~/, "")
    .replace(/^openrouter\//, "");
}

export function priceToPublic(model, price) {
  return {
    model,
    inputCostPerMTok: toPerMillion(price.input_cost_per_token),
    outputCostPerMTok: toPerMillion(price.output_cost_per_token),
    cacheReadCostPerMTok: toPerMillion(price.cache_read_input_token_cost),
    cacheWriteCostPerMTok: toPerMillion(price.cache_creation_input_token_cost),
    reasoningCostPerMTok: 0,
    source: price.source || "builtin",
    pricingVersion: price.pricingVersion || "",
    updatedAt: price.updatedAt || ""
  };
}

export function openRouterModelToPrice(model, fetchedAt = "", pricingVersion = PRICING_VERSION) {
  const pricing = model?.pricing || {};
  const prompt = numberOrNull(pricing.prompt);
  const completion = numberOrNull(pricing.completion);
  if (prompt === null && completion === null) return null;
  return {
    model: normalizeModelName(model.id || model.canonical_slug || ""),
    displayName: model.name || "",
    canonicalSlug: model.canonical_slug || "",
    input_cost_per_token: prompt || 0,
    output_cost_per_token: completion || 0,
    cache_read_input_token_cost: numberOrNull(pricing.input_cache_read) ?? prompt ?? 0,
    cache_creation_input_token_cost: numberOrNull(pricing.input_cache_write) ?? prompt ?? 0,
    reasoning_cost_per_token: 0,
    max_input_tokens: Number(model.context_length || model.top_provider?.context_length || 0),
    max_output_tokens: Number(model.top_provider?.max_completion_tokens || 0),
    source: "openrouter",
    pricingVersion,
    updatedAt: fetchedAt
  };
}

function resolvePriceKey(model = "", priceMap = {}) {
  const normalized = normalizeModelName(model);
  if (!normalized) return null;
  if (priceMap[normalized]) return { key: normalized, exact: true };
  for (const candidate of createMatchingCandidates(normalized)) {
    if (priceMap[candidate]) return { key: candidate, exact: false };
  }
  for (const key of Object.keys(priceMap)) {
    if (key.includes(normalized) || normalized.includes(key)) return { key, exact: false };
  }
  return null;
}

function createMatchingCandidates(model) {
  const withoutProvider = model.includes("/") ? model.split("/").at(-1) : model;
  return [
    withoutProvider,
    `openai/${model}`,
    `anthropic/${model}`,
    `google/${model}`,
    `meta-llama/${model}`,
    `qwen/${model}`,
    `deepseek/${model}`,
    `mistralai/${model}`,
    `openai/${withoutProvider}`,
    `anthropic/${withoutProvider}`,
    `google/${withoutProvider}`,
    `meta-llama/${withoutProvider}`,
    `qwen/${withoutProvider}`,
    `deepseek/${withoutProvider}`,
    `mistralai/${withoutProvider}`
  ];
}

function normalizePriceRecord(price, defaults = {}) {
  return {
    input_cost_per_token: toPerToken(price.inputCostPerMTok ?? price.inputCostPerToken ?? price.input_cost_per_token, "inputCostPerMTok" in price),
    output_cost_per_token: toPerToken(price.outputCostPerMTok ?? price.outputCostPerToken ?? price.output_cost_per_token, "outputCostPerMTok" in price),
    cache_read_input_token_cost: toPerToken(price.cacheReadCostPerMTok ?? price.cacheReadCostPerToken ?? price.cache_read_input_token_cost, "cacheReadCostPerMTok" in price),
    cache_creation_input_token_cost: toPerToken(price.cacheWriteCostPerMTok ?? price.cacheWriteCostPerToken ?? price.cache_creation_input_token_cost, "cacheWriteCostPerMTok" in price),
    reasoning_cost_per_token: 0,
    source: price.source || defaults.source || "custom",
    pricingVersion: price.pricingVersion || defaults.pricingVersion || "",
    updatedAt: price.updatedAt || ""
  };
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

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
