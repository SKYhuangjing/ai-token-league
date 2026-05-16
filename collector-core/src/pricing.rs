use serde_json::Value;
use std::collections::HashMap;

pub const PRICING_VERSION: &str = "openrouter-cache";

#[derive(Debug, Clone)]
pub struct CostResult {
    pub input_cost_usd: Option<f64>,
    pub output_cost_usd: Option<f64>,
    pub cache_read_cost_usd: Option<f64>,
    pub cache_write_cost_usd: Option<f64>,
    pub reasoning_cost_usd: Option<f64>,
    pub estimated_cost_usd: Option<f64>,
    pub cost_quality: String,
    pub pricing_version: String,
    pub pricing_model: String,
    pub pricing_source: String,
}

fn round_usd(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
}

fn token_cost(tokens: i64, cost_per_token: f64) -> f64 {
    tokens as f64 * cost_per_token
}

fn normalize_model_name(model: &str) -> String {
    let mut s = model.trim().to_lowercase();
    if s.starts_with('~') {
        s = s[1..].to_string();
    }
    if let Some(rest) = s.strip_prefix("openrouter/") {
        s = rest.to_string();
    }
    s
}

fn resolve_price_key<'a>(model: &str, price_map: &'a HashMap<String, Value>) -> Option<(String, bool, &'a Value)> {
    let normalized = normalize_model_name(model);
    if let Some(v) = price_map.get(&normalized) {
        return Some((normalized, true, v));
    }
    // Try fuzzy matching candidates
    let candidates = create_matching_candidates(&normalized);
    for candidate in candidates {
        if let Some(v) = price_map.get(&candidate) {
            return Some((candidate, false, v));
        }
    }
    None
}

fn create_matching_candidates(normalized: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    let providers = ["openai", "anthropic", "google", "meta-llama", "qwen", "deepseek", "mistralai"];

    // Strip provider prefix if present
    for &provider in &providers {
        if let Some(rest) = normalized.strip_prefix(&format!("{}/", provider)) {
            candidates.push(rest.to_string());
            candidates.push(format!("{}/{}", provider, rest));
        }
    }

    candidates
}

pub fn estimate_usage_cost(item: &Value, price_map: &HashMap<String, Value>) -> CostResult {
    let model = item["model"].as_str().unwrap_or("");

    match resolve_price_key(model, price_map) {
        Some((_key, exact, price)) => {
            let input_per = price["input_cost_per_token"].as_f64().unwrap_or(0.0);
            let output_per = price["output_cost_per_token"].as_f64().unwrap_or(0.0);
            let cache_read_per = price["cache_read_input_token_cost"]
                .as_f64()
                .unwrap_or(input_per);
            let cache_write_per = price["cache_creation_input_token_cost"]
                .as_f64()
                .unwrap_or(input_per);
            let reasoning_per = price["reasoning_cost_per_token"].as_f64().unwrap_or(0.0);

            let input_tokens = item["inputTokens"].as_i64().unwrap_or(0);
            let output_tokens = item["outputTokens"].as_i64().unwrap_or(0);
            let cache_read_tokens = item["cacheReadTokens"].as_i64().unwrap_or(0);
            let cache_write_tokens = item["cacheWriteTokens"].as_i64().unwrap_or(0);
            let reasoning_tokens = item["reasoningTokens"].as_i64().unwrap_or(0);

            let input = token_cost(input_tokens, input_per);
            let output = token_cost(output_tokens, output_per);
            let cache_read = token_cost(cache_read_tokens, cache_read_per);
            let cache_write = token_cost(cache_write_tokens, cache_write_per);
            let reasoning = token_cost(reasoning_tokens, reasoning_per);
            let total = input + output + cache_read + cache_write + reasoning;

            CostResult {
                input_cost_usd: Some(round_usd(input)),
                output_cost_usd: Some(round_usd(output)),
                cache_read_cost_usd: Some(round_usd(cache_read)),
                cache_write_cost_usd: Some(round_usd(cache_write)),
                reasoning_cost_usd: Some(round_usd(reasoning)),
                estimated_cost_usd: Some(round_usd(total)),
                cost_quality: if exact { "exact_price" } else { "estimated_price" }.to_string(),
                pricing_version: price["pricingVersion"].as_str().unwrap_or(PRICING_VERSION).to_string(),
                pricing_model: price["aliasTarget"].as_str().unwrap_or(model).to_string(),
                pricing_source: price["source"].as_str().unwrap_or("").to_string(),
            }
        }
        None => CostResult {
            input_cost_usd: None,
            output_cost_usd: None,
            cache_read_cost_usd: None,
            cache_write_cost_usd: None,
            reasoning_cost_usd: None,
            estimated_cost_usd: None,
            cost_quality: "unknown_price".to_string(),
            pricing_version: PRICING_VERSION.to_string(),
            pricing_model: String::new(),
            pricing_source: String::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_normalize_model_name() {
        assert_eq!(normalize_model_name("GPT-4o"), "gpt-4o");
        assert_eq!(normalize_model_name("~claude-3"), "claude-3");
        assert_eq!(normalize_model_name("openrouter/gpt-4"), "gpt-4");
    }

    #[test]
    fn test_estimate_unknown_price() {
        let item = json!({"model": "unknown-model"});
        let map = HashMap::new();
        let cost = estimate_usage_cost(&item, &map);
        assert_eq!(cost.cost_quality, "unknown_price");
        assert!(cost.estimated_cost_usd.is_none());
    }
}
