pub const CLIENT_PROTOCOL_VERSION: u32 = 2;
pub const SERVER_PROTOCOL_VERSION: u32 = 2;
pub const SNAPSHOT_PROTOCOL_VERSION: u32 = 2;

pub fn client_platform() -> String {
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        std::env::consts::ARCH
    };
    format!("{}-{}", platform, arch)
}

pub fn package_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn client_metadata() -> serde_json::Value {
    serde_json::json!({
        "clientAppVersion": package_version(),
        "clientProtocolVersion": CLIENT_PROTOCOL_VERSION,
        "clientPlatform": client_platform(),
        "clientBuild": format!("{}-{}", client_platform(), package_version()),
        "runtime": format!("rust-{}", env!("CARGO_PKG_VERSION")),
        "os": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_metadata_has_required_fields() {
        let meta = client_metadata();
        assert!(meta["clientAppVersion"].is_string());
        assert!(meta["clientProtocolVersion"].is_number());
        assert!(meta["clientPlatform"].is_string());
        assert!(meta["clientBuild"].is_string());
        assert!(meta["runtime"].is_string());
        assert!(meta["os"].is_string());
    }

    #[test]
    fn test_client_metadata_platform_matches_build() {
        let meta = client_metadata();
        let platform = meta["clientPlatform"].as_str().unwrap();
        let build = meta["clientBuild"].as_str().unwrap();
        assert!(build.starts_with(platform));
    }

    #[test]
    fn test_client_metadata_runtime_is_rust() {
        let meta = client_metadata();
        assert!(meta["runtime"].as_str().unwrap().starts_with("rust-"));
    }

    #[test]
    fn test_package_version_not_empty() {
        let v = package_version();
        assert!(!v.is_empty());
        // Semantic version pattern
        let parts: Vec<&str> = v.split('.').collect();
        assert!(parts.len() >= 2, "version should have at least major.minor");
    }

    #[test]
    fn test_protocol_constants_positive() {
        assert!(CLIENT_PROTOCOL_VERSION > 0);
        assert!(SERVER_PROTOCOL_VERSION > 0);
        assert!(SNAPSHOT_PROTOCOL_VERSION > 0);
    }

    #[test]
    fn test_client_platform_format() {
        let p = client_platform();
        assert!(p.contains('-'), "platform should be os-arch format");
        assert!(
            p.starts_with("darwin") || p.starts_with("win32") || p.starts_with("linux"),
            "unexpected platform: {}",
            p
        );
    }
}
