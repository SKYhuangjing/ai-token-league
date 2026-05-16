use crate::config::AppConfig;
use serde_json::{json, Value};

pub fn export_diagnostics(config: &AppConfig, cache_items: &serde_json::Value, queue_items: &[Value], runtime_log: &[Value]) -> Value {
    json!({
        "exportedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "config": sanitize_config(config),
        "usageCache": cache_items,
        "uploadQueue": {
            "pending": queue_items.len(),
            "items": queue_items
        },
        "runtimeLog": runtime_log
    })
}

fn sanitize_config(config: &AppConfig) -> Value {
    let mut value = serde_json::to_value(config).unwrap_or_default();
    if let Some(obj) = value.as_object_mut() {
        obj.remove("identityPrivateKey");
        obj.remove("workosSessionToken");
    }
    value
}
