//! Local cost estimation. The formula and key-resolution rules mirror
//! `src/shared/pricing.js` (estimateUsageCost / resolvePriceKey /
//! normalizeModelName); the price data itself always comes from the server's
//! public `/api/model-prices` so there is a single data source of truth.

use std::collections::HashMap;

use serde_json::Value;

pub type PriceMap = HashMap<String, PriceRecord>;

#[derive(Debug, Clone)]
pub struct PriceRecord {
    pub input_per_token: f64,
    pub output_per_token: f64,
    pub cache_read_per_token: Option<f64>,
    pub cache_write_per_token: Option<f64>,
    pub reasoning_per_token: f64,
}

pub fn normalize_model_name(model: &str) -> String {
    let lowered = model.trim().to_lowercase();
    let without_tilde = lowered.strip_prefix('~').unwrap_or(&lowered);
    without_tilde
        .strip_prefix("openrouter/")
        .unwrap_or(without_tilde)
        .to_string()
}

fn matching_candidates(model: &str) -> Vec<String> {
    let without_provider = model
        .split('/')
        .next_back()
        .filter(|part| !part.is_empty())
        .unwrap_or(model);
    let providers = [
        "openai",
        "anthropic",
        "google",
        "meta-llama",
        "qwen",
        "deepseek",
        "mistralai",
    ];
    let mut candidates = vec![without_provider.to_string()];
    for provider in providers {
        candidates.push(format!("{}/{}", provider, model));
    }
    for provider in providers {
        candidates.push(format!("{}/{}", provider, without_provider));
    }
    candidates
}

/// Resolve a model to a price-map key: exact normalized match first, then the
/// same provider-prefix candidate list as pricing.js.
pub fn resolve_price_key<'a>(model: &str, map: &'a PriceMap) -> Option<(&'a str, bool)> {
    let normalized = normalize_model_name(model);
    if normalized.is_empty() {
        return None;
    }
    if map.contains_key(&normalized) {
        return Some((map.get_key_value(&normalized)?.0.as_str(), true));
    }
    for candidate in matching_candidates(&normalized) {
        if let Some((key, _)) = map.get_key_value(&candidate) {
            return Some((key.as_str(), false));
        }
    }
    None
}

/// Accepts the per-million fields used by the public price payloads and the
/// per-token field names kept in storage; whichever key is present decides
/// the unit, matching normalizePriceRecord in pricing.js.
fn per_token_value(price: &Value, per_mtok_key: &str, per_token_key: &str) -> f64 {
    if let Some(v) = price.get(per_mtok_key).and_then(Value::as_f64) {
        return (v / 1_000_000.0).max(0.0);
    }
    price
        .get(per_token_key)
        .and_then(Value::as_f64)
        .map(|v| v.max(0.0))
        .unwrap_or(0.0)
}

fn record_from_price(price: &Value) -> PriceRecord {
    PriceRecord {
        input_per_token: per_token_value(price, "inputCostPerMTok", "inputCostPerToken"),
        output_per_token: per_token_value(price, "outputCostPerMTok", "outputCostPerToken"),
        cache_read_per_token: price
            .get("cacheReadCostPerMTok")
            .and_then(Value::as_f64)
            .map(|v| (v / 1_000_000.0).max(0.0))
            .or_else(|| {
                price
                    .get("cacheReadCostPerToken")
                    .and_then(Value::as_f64)
                    .map(|v| v.max(0.0))
            }),
        cache_write_per_token: price
            .get("cacheWriteCostPerMTok")
            .and_then(Value::as_f64)
            .map(|v| (v / 1_000_000.0).max(0.0))
            .or_else(|| {
                price
                    .get("cacheWriteCostPerToken")
                    .and_then(Value::as_f64)
                    .map(|v| v.max(0.0))
            }),
        reasoning_per_token: price
            .get("reasoningCostPerMTok")
            .and_then(Value::as_f64)
            .map(|v| (v / 1_000_000.0).max(0.0))
            .unwrap_or(0.0),
    }
}

/// Build the price map from a `/api/model-prices` payload. Later lists win
/// (openrouter < remote < custom) and aliases are expanded to point at their
/// target's record, mirroring createPriceMap precedence.
pub fn build_price_map(payload: &Value) -> PriceMap {
    let mut map: PriceMap = HashMap::new();
    for list_key in ["openrouter", "remote", "custom"] {
        if let Some(entries) = payload.get(list_key).and_then(Value::as_array) {
            for entry in entries {
                let model = entry
                    .get("model")
                    .or_else(|| entry.get("key"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let normalized = normalize_model_name(model);
                if normalized.is_empty() {
                    continue;
                }
                map.insert(normalized, record_from_price(entry));
            }
        }
    }
    if let Some(aliases) = payload.get("aliases").and_then(Value::as_array) {
        for alias in aliases {
            let (Some(source), Some(target)) = (
                alias.get("model").and_then(Value::as_str),
                alias.get("targetModel").and_then(Value::as_str),
            ) else {
                continue;
            };
            let target_key = normalize_model_name(target);
            if let Some(record) = map.get(&target_key).cloned() {
                map.entry(normalize_model_name(source)).or_insert(record);
            }
        }
    }
    map
}

#[derive(Debug, Clone, PartialEq)]
pub struct CostBreakdown {
    pub input_usd: f64,
    pub output_usd: f64,
    pub cache_read_usd: f64,
    pub cache_write_usd: f64,
    pub reasoning_usd: f64,
    pub total_usd: f64,
    pub exact: bool,
    pub pricing_model: String,
}

/// Cost of one aggregated model row ({model, inputTokens, outputTokens,
/// cacheReadTokens, cacheWriteTokens, reasoningTokens}); None when the model
/// has no price at all (mirrors costQuality "unknown_price").
pub fn estimate_model_cost(row: &Value, map: &PriceMap) -> Option<CostBreakdown> {
    let model = row.get("model").and_then(Value::as_str)?;
    let (key, exact) = resolve_price_key(model, map)?;
    let price = map.get(key)?;
    let tokens = |field: &str| row.get(field).and_then(Value::as_i64).unwrap_or(0) as f64;
    let input = tokens("inputTokens") * price.input_per_token;
    let output = tokens("outputTokens") * price.output_per_token;
    let cache_read =
        tokens("cacheReadTokens") * price.cache_read_per_token.unwrap_or(price.input_per_token);
    let cache_write =
        tokens("cacheWriteTokens") * price.cache_write_per_token.unwrap_or(price.input_per_token);
    let reasoning = tokens("reasoningTokens") * price.reasoning_per_token;
    Some(CostBreakdown {
        input_usd: input,
        output_usd: output,
        cache_read_usd: cache_read,
        cache_write_usd: cache_write,
        reasoning_usd: reasoning,
        total_usd: input + output + cache_read + cache_write + reasoning,
        exact,
        pricing_model: key.to_string(),
    })
}

/// USD display: two decimals at $1 and above, four below (small per-day costs
/// would all collapse to $0.00).
pub fn format_usd(value: f64) -> String {
    if value.abs() >= 1.0 {
        format!("${:.2}", value)
    } else {
        format!("${:.4}", value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map_with(entries: &[(&str, f64, f64)]) -> PriceMap {
        let mut map = PriceMap::new();
        for (model, input, output) in entries {
            map.insert(
                normalize_model_name(model),
                PriceRecord {
                    input_per_token: *input,
                    output_per_token: *output,
                    cache_read_per_token: None,
                    cache_write_per_token: None,
                    reasoning_per_token: 0.0,
                },
            );
        }
        map
    }

    #[test]
    fn normalize_matches_pricing_js() {
        assert_eq!(normalize_model_name(" GLM-5.3 "), "glm-5.3");
        assert_eq!(normalize_model_name("~openrouter/gpt-4"), "gpt-4");
        assert_eq!(normalize_model_name("openrouter/gpt-4"), "gpt-4");
    }

    #[test]
    fn resolve_exact_then_provider_prefix() {
        let map = map_with(&[("glm-5.3", 1e-6, 2e-6), ("openai/gpt-4o", 3e-6, 6e-6)]);
        assert_eq!(resolve_price_key("GLM-5.3", &map), Some(("glm-5.3", true)));
        // "gpt-4o" without provider resolves via the candidate list (not exact)
        let resolved = resolve_price_key("gpt-4o", &map).unwrap();
        assert_eq!(resolved.0, "openai/gpt-4o");
        assert!(!resolved.1);
        assert!(resolve_price_key("totally-unknown", &map).is_none());
    }

    #[test]
    fn cost_uses_cache_fallback_rates() {
        let map = map_with(&[("m", 2e-6, 4e-6)]);
        let row = json!({
            "model": "m",
            "inputTokens": 1_000_000,
            "outputTokens": 500_000,
            "cacheReadTokens": 10_000_000,
            "cacheWriteTokens": 1_000_000,
            "reasoningTokens": 100_000,
        });
        let cost = estimate_model_cost(&row, &map).unwrap();
        assert!((cost.input_usd - 2.0).abs() < 1e-9);
        assert!((cost.output_usd - 2.0).abs() < 1e-9);
        // cache falls back to the input rate when no dedicated rate exists
        assert!((cost.cache_read_usd - 20.0).abs() < 1e-9);
        assert!((cost.cache_write_usd - 2.0).abs() < 1e-9);
        assert!((cost.total_usd - 26.0).abs() < 1e-9);
    }

    #[test]
    fn unpriced_model_returns_none() {
        let map = map_with(&[]);
        let row = json!({ "model": "nope", "inputTokens": 1, "outputTokens": 1 });
        assert!(estimate_model_cost(&row, &map).is_none());
    }

    #[test]
    fn build_map_applies_precedence_and_aliases() {
        let payload = json!({
            "openrouter": [
                { "model": "glm-5.3", "inputCostPerMTok": 1.0, "outputCostPerMTok": 2.0 }
            ],
            "custom": [
                { "model": "glm-5.3", "inputCostPerMTok": 9.0, "outputCostPerMTok": 9.0 }
            ],
            "aliases": [ { "model": "GLM 5.3 Alias", "targetModel": "glm-5.3" } ]
        });
        let map = build_price_map(&payload);
        let row = json!({ "model": "glm-5.3", "inputTokens": 1_000_000 });
        let cost = estimate_model_cost(&row, &map).unwrap();
        // custom overrides openrouter
        assert!((cost.input_usd - 9.0).abs() < 1e-9);
        // alias resolves to the same record
        let aliased = estimate_model_cost(
            &json!({ "model": "GLM 5.3 Alias", "inputTokens": 1_000_000 }),
            &map,
        )
        .unwrap();
        assert!((aliased.input_usd - 9.0).abs() < 1e-9);
    }

    #[test]
    fn usd_format_scales_precision() {
        assert_eq!(format_usd(12.3456), "$12.35");
        assert_eq!(format_usd(0.004321), "$0.0043");
    }
}
