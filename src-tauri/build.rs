fn main() {
    ensure_preset_resource();
    tauri_build::build()
}

fn ensure_preset_resource() {
    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    let preset_path = manifest_dir.join("../assets/preset.json");

    if preset_path.exists() {
        return;
    }

    if let Some(parent) = preset_path.parent() {
        std::fs::create_dir_all(parent).expect("create assets directory for Tauri preset resource");
    }
    std::fs::write(preset_path, "{}\n").expect("write empty Tauri preset resource");
}
