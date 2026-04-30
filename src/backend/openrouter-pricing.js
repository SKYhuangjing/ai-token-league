import { openRouterModelToPrice } from "../shared/pricing.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const OPENROUTER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function fetchOpenRouterModelPrices({
  url = process.env.OPENROUTER_MODELS_URL || OPENROUTER_MODELS_URL,
  timeoutMs = Number(process.env.OPENROUTER_PRICING_TIMEOUT_MS || 10000),
  now = new Date()
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`OpenRouter pricing fetch failed: ${response.status} ${response.statusText}`);
    const body = await response.json();
    const fetchedAt = now.toISOString();
    const pricingVersion = `openrouter:${fetchedAt}`;
    const prices = {};
    let skipped = 0;
    for (const model of body.data || []) {
      const price = openRouterModelToPrice(model, fetchedAt, pricingVersion);
      if (!price?.model) {
        skipped += 1;
        continue;
      }
      prices[price.model] = price;
    }
    return {
      remote: {
        source: "openrouter",
        url,
        status: "fresh",
        fetchedAt,
        expiresAt: new Date(now.getTime() + OPENROUTER_CACHE_TTL_MS).toISOString(),
        pricingVersion,
        modelCount: Object.keys(prices).length,
        skipped,
        lastError: ""
      },
      prices
    };
  } finally {
    clearTimeout(timeout);
  }
}
