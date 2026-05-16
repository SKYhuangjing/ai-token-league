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
