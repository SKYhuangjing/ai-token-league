// Optional-module host state (feat/compute-sharing R9 / plugin-platform P0 slice).
//
// The desktop client ships capability modules (compute sharing, usage queries,
// ...) that users enable/disable in settings. State lives in
// ~/.ai-token-league/modules.json next to the collector config; the module
// REGISTRY (manifests, UI) is client-side (src/shared/modules.js) — this store
// only persists per-module enable flags and config, so adding a module needs no
// Rust change.
//
// Shape: { "version": 1, "modules": { "<id>": { "enabled": bool, "config": {} } } }

use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

pub fn modules_path() -> PathBuf {
    crate::config::app_dir().join("modules.json")
}

pub fn load_modules_state_at(path: &std::path::Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .filter(|v: &Value| v.get("version").and_then(|x| x.as_u64()) == Some(1))
        .unwrap_or_else(|| json!({ "version": 1, "modules": {} }))
}

pub fn set_module_state_at(path: &std::path::Path, id: &str, patch: &Value) -> Result<Value, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("invalid module id: {}", id));
    }
    let mut state = load_modules_state_at(path);
    let entry = state
        .get_mut("modules")
        .and_then(|m| m.as_object_mut())
        .ok_or_else(|| "corrupt modules state".to_string())?
        .entry(id.to_string())
        .or_insert_with(|| json!({ "enabled": true, "config": {} }));
    if let Some(enabled) = patch.get("enabled").and_then(|v| v.as_bool()) {
        entry["enabled"] = json!(enabled);
    }
    if let Some(config) = patch.get("config") {
        if config.is_object() {
            // shallow-merge config keys so partial updates don't wipe the rest
            let merged = entry
                .get("config")
                .and_then(|c| c.as_object())
                .cloned()
                .unwrap_or_default();
            let mut merged = serde_json::Map::from(merged);
            for (k, v) in config.as_object().unwrap() {
                merged.insert(k.clone(), v.clone());
            }
            entry["config"] = Value::Object(merged);
        }
    }
    if let Some(v) = patch.get("installedVersion") {
        if v.is_null() {
            if let Some(obj) = entry.as_object_mut() {
                obj.remove("installedVersion");
            }
        } else {
            entry["installedVersion"] = v.clone();
        }
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(&state).unwrap_or_default()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(state)
}

pub fn load_modules_state() -> Value {
    load_modules_state_at(&modules_path())
}

pub fn set_module_state(id: &str, patch: &Value) -> Result<Value, String> {
    set_module_state_at(&modules_path(), id, patch)
}

// Downloaded plugin entries live beside modules.json, not inside it.
// modules.json is returned to plugins and holds API keys; the script is
// version-immutable and only needed by the host at mount time.
pub const MAX_PLUGIN_PACKAGE_BYTES: usize = 2 * 1024 * 1024;

pub fn plugin_packages_root() -> PathBuf {
    crate::config::app_dir().join("plugin-packages")
}

fn package_segment(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.starts_with('.')
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("invalid module package path".into());
    }
    Ok(())
}

fn package_dir(root: &std::path::Path, id: &str, version: &str) -> Result<PathBuf, String> {
    package_segment(id)?;
    package_segment(version)?;
    Ok(root.join(id).join(version))
}

pub fn read_plugin_package_at(root: &std::path::Path, id: &str, version: &str) -> Result<String, String> {
    let path = package_dir(root, id, version)?.join("index.js");
    match std::fs::read(&path) {
        Ok(bytes) if bytes.is_empty() => Err("not_found".into()),
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| "module source is not valid utf-8".into()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err("not_found".into()),
        Err(err) => Err(err.to_string()),
    }
}

pub fn write_plugin_package_at(root: &std::path::Path, id: &str, version: &str, source: &str) -> Result<(), String> {
    if source.is_empty() {
        return Err("empty module package".into());
    }
    if source.len() > MAX_PLUGIN_PACKAGE_BYTES {
        return Err("module package too large".into());
    }
    let dir = package_dir(root, id, version)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("index.js");
    let tmp = dir.join("index.js.tmp");
    std::fs::write(&tmp, source).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    // A new version replaces the previous one. Keep only the version just
    // written so upgrades do not leave old package directories behind.
    prune_other_versions(root, id, version)?;
    Ok(())
}

fn prune_other_versions(root: &std::path::Path, id: &str, keep: &str) -> Result<(), String> {
    package_segment(id)?;
    let id_dir = root.join(id);
    let entries = match std::fs::read_dir(&id_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name == keep || package_segment(name).is_err() {
            continue;
        }
        match std::fs::remove_dir_all(entry.path()) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.to_string()),
        }
    }
    Ok(())
}

pub fn delete_plugin_package_at(root: &std::path::Path, id: &str, version: Option<&str>) -> Result<(), String> {
    package_segment(id)?;
    let target = match version.filter(|value| !value.is_empty()) {
        Some(version) => package_dir(root, id, version)?,
        None => root.join(id),
    };
    match std::fs::remove_dir_all(&target) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

pub fn read_plugin_package(id: &str, version: &str) -> Result<String, String> {
    read_plugin_package_at(&plugin_packages_root(), id, version)
}

pub fn write_plugin_package(id: &str, version: &str, source: &str) -> Result<(), String> {
    write_plugin_package_at(&plugin_packages_root(), id, version, source)
}

pub fn delete_plugin_package(id: &str, version: Option<&str>) -> Result<(), String> {
    delete_plugin_package_at(&plugin_packages_root(), id, version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_missing_or_corrupt() {
        let dir = std::env::temp_dir().join(format!("atl-modules-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("modules.json");
        let state = load_modules_state_at(&path);
        assert_eq!(state["version"], 1);
        assert!(state["modules"].as_object().unwrap().is_empty());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "not json").unwrap();
        let state = load_modules_state_at(&path);
        assert!(state["modules"].as_object().unwrap().is_empty());
    }

    #[test]
    fn set_merges_and_persists() {
        let dir = std::env::temp_dir().join(format!("atl-modules-set-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("modules.json");
        let state = set_module_state_at(&path, "compute-sharing", &json!({ "enabled": false })).unwrap();
        assert_eq!(state["modules"]["compute-sharing"]["enabled"], false);
        // partial config merge does not wipe earlier keys
        set_module_state_at(&path, "compute-sharing", &json!({ "config": { "apiUrl": "http://x" } })).unwrap();
        set_module_state_at(&path, "compute-sharing", &json!({ "config": { "budget": 5 } })).unwrap();
        let reloaded = load_modules_state_at(&path);
        let cfg = &reloaded["modules"]["compute-sharing"]["config"];
        assert_eq!(cfg["apiUrl"], "http://x");
        assert_eq!(cfg["budget"], 5);
        assert_eq!(reloaded["modules"]["compute-sharing"]["enabled"], false);
        // invalid ids rejected
        assert!(set_module_state_at(&path, "../evil", &json!({})).is_err());
    }

    #[test]
    fn plugin_package_roundtrip_is_confined_to_id_and_version() {
        let dir = std::env::temp_dir().join(format!("atl-plugin-pkg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(read_plugin_package_at(&dir, "zhipu-plan", "1.1.0").unwrap_err(), "not_found");
        write_plugin_package_at(&dir, "zhipu-plan", "1.0.0", "old").unwrap();
        write_plugin_package_at(&dir, "zhipu-plan", "1.1.0", "export default { mount() {} }\n").unwrap();
        assert!(read_plugin_package_at(&dir, "zhipu-plan", "1.1.0")
            .unwrap()
            .contains("mount"));
        assert_eq!(read_plugin_package_at(&dir, "zhipu-plan", "1.0.0").unwrap_err(), "not_found");
        assert_eq!(read_plugin_package_at(&dir, "zhipu-plan", "9.9.9").unwrap_err(), "not_found");
        delete_plugin_package_at(&dir, "zhipu-plan", Some("1.1.0")).unwrap();
        assert_eq!(read_plugin_package_at(&dir, "zhipu-plan", "1.1.0").unwrap_err(), "not_found");
        // missing delete is a no-op so uninstall can retry
        delete_plugin_package_at(&dir, "zhipu-plan", None).unwrap();
        for (id, version) in [("..", "1.0.0"), ("zhipu-plan", ".."), ("../evil", "1"), ("zhipu-plan", "1/0")] {
            assert!(write_plugin_package_at(&dir, id, version, "x").is_err(), "{id} {version}");
        }
        assert!(write_plugin_package_at(&dir, "zhipu-plan", "1.0.0", "").is_err());
        let huge = "x".repeat(MAX_PLUGIN_PACKAGE_BYTES + 1);
        assert!(write_plugin_package_at(&dir, "zhipu-plan", "1.0.0", &huge).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ── remote module distribution (R17): OSS public-read objects ───────────────

#[derive(Clone)]
pub struct OssConfig {
    pub endpoint: String,
    pub bucket: String,
    pub prefix: String,
}

pub fn oss_config_from_env() -> OssConfig {
    OssConfig {
        endpoint: std::env::var("RELEASE_OSS_ENDPOINT").unwrap_or_default(),
        bucket: std::env::var("RELEASE_OSS_BUCKET").unwrap_or_default(),
        prefix: std::env::var("RELEASE_OSS_PREFIX").unwrap_or_default().trim_end_matches('/').to_string(),
    }
}

impl OssConfig {
    pub fn enabled(&self) -> bool {
        !self.endpoint.is_empty() && !self.bucket.is_empty()
    }
    pub fn object_url(&self, key: &str) -> String {
        format!("https://{}.{}/{}", self.bucket, self.endpoint.trim_start_matches("https://").trim_start_matches("http://"), key)
    }
}

/// Blocking fetch of a full object URL — call from a spawn_blocking context only.
fn oss_get(url: &str) -> Result<Vec<u8>, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .map_err(|e| e.to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("not_found".into());
    }
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    Ok(response.bytes().map(|b| b.to_vec()).map_err(|e| e.to_string())?)
}

pub fn fetch_remote_catalog(oss: &OssConfig) -> Result<Vec<Value>, String> {
    let body = oss_get(oss.object_url(&format!("{}/modules/catalog.json", oss.prefix)).as_str())?;
    let parsed: Value = serde_json::from_slice(&body).map_err(|e| format!("invalid catalog: {}", e))?;
    // 兼容两种历史格式：顶层数组 或 { catalog: [...] }
    let entries = if parsed.is_array() {
        parsed.clone()
    } else {
        parsed.get("catalog").cloned().unwrap_or(Value::Array(vec![]))
    };
    Ok(entries.as_array().cloned().unwrap_or_default())
}

pub fn fetch_remote_module_source(oss: &OssConfig, id: &str, version: &str) -> Result<String, String> {
    let key = format!("{}/modules/{}/{}/index.js", oss.prefix, id, version);
    let bytes = oss_get(oss.object_url(&key).as_str())?;
    String::from_utf8(bytes).map_err(|_| "module source is not valid utf-8".into())
}
