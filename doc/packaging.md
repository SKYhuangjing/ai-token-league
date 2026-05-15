# Packaging

This document is the operational checklist for rebuilding desktop distribution artifacts.

## Prerequisites

- Node.js 22 or newer.
- Rust toolchain (install from https://rustup.rs).
- Dependencies installed with `npm install`.
- Run commands from the project root.

## Interactive Release Script

The primary way to build and release is through the interactive script:

```bash
npm run release
# or directly:
bash scripts/release.sh
```

The script guides you through:

1. **Version** — keep current or bump to a new version
2. **Platform** — macOS arm64, macOS Intel, macOS All, Windows, or All
3. **Env file** — skip presets or load from an env file (for `PRESET_*` vars and OSS credentials)
4. **Upload** — whether to upload artifacts to OSS
5. **Confirmation** — review selections before executing

CLI flags for non-interactive use:

```bash
bash scripts/release.sh --version 0.6.0 --platform all --yes
bash scripts/release.sh --platform mac-arm64 --env env.local --upload --yes
```

| Flag | Description |
|------|-------------|
| `--version VER` | Version to release (default: current from package.json) |
| `--platform PLAT` | `current` / `mac-arm64` / `mac-intel` / `mac-all` / `win` / `all` |
| `--env FILE` | Env file for presets and upload credentials |
| `--upload` | Upload artifacts to OSS; automatically builds all platforms |
| `--yes` | Skip confirmation prompt |

## Manual Build

For normal release builds, prefer `scripts/release.sh` because it also handles preset generation, platform selection, and optional upload. Use the low-level commands below only when validating a specific build layer.

During local development, if a change touches packaged desktop behavior, bundled assets, `assets/preset.json`, update/release metadata, or public download/install UX, produce exactly one build for the current machine before closing the work:

```bash
scripts/release.sh --platform current --env env.local --yes
```

Use `--platform all` only for explicit cross-platform packaging or release-facing changes.

Use a clean build when validating UI or packaging changes:

```bash
rm -rf src-tauri/target/release/bundle
npx tauri build
```

### Build targets

```bash
npx tauri build                            # current platform
npx tauri build --target aarch64-apple-darwin  # macOS arm64
npx tauri build --target x86_64-apple-darwin   # macOS Intel
npx tauri build --target x86_64-pc-windows-msvc # Windows x64
```

### Expected build artifacts

Tauri produces these artifacts in `src-tauri/target/release/bundle/`:

**macOS:**
- `macos/AI Token League.app` — application bundle
- `dmg/AI Token League_<version>_aarch64.dmg` — DMG installer
- `macos/AI Token League.app.tar.gz` + `.sig` — updater package (minisign signed)

**Windows:**
- `nsis/AI Token League_<version>_x64-setup.exe` — NSIS installer
- `msi/AI Token League_<version>_x64_en-US.msi` — MSI installer
- `nsis/AI Token League_<version>_x64-setup.nsis.zip` + `.sig` — updater package

## Release Manifest Dry Run

Release resource configuration is read from env. `scripts/publish-release.js` requires an explicit `--env` flag or `RELEASE_*` environment variables; it does not default to `env.local`.

```bash
node scripts/publish-release.js --env env.local --dry-run
```

Expected behavior:

- Updater artifacts (`.app.tar.gz` / `.nsis.zip`) are collected from `dist/`.
- Installer artifacts (`.dmg` / `.exe`) are collected from `dist/`.
- `checksums.txt` is generated.
- `tauri-update.json` is generated for the Tauri updater plugin.
- `installer.json` is generated for the download page.
- `latest.json` is generated for backward compatibility.

Publish only from a trusted release environment:

```bash
node scripts/publish-release.js --env env.local
```

To rebuild and upload separately:

```bash
scripts/release.sh --platform all --yes          # clean build
node scripts/publish-release.js --env env.local  # upload with progress bar
```

The upload script reads `RELEASE_OSS_ACCESS_KEY_ID` and `RELEASE_OSS_ACCESS_KEY_SECRET` from env. These values must not be committed or exposed through app-server responses.

## Verify

Run these before treating the package as current:

```bash
node --check src/desktop/sidecar.cjs
node --check src/desktop/renderer.js
node --check scripts/publish-release.js
npm test
npm run desktop
node scripts/publish-release.js --env env.local --dry-run
```

After building, verify the packaged macOS app launches:

```bash
open "src-tauri/target/release/bundle/macos/AI Token League.app"
```

## Launch Packaged macOS App

Close any already running `AI Token League` app before opening a rebuilt package; otherwise macOS may keep showing an older running instance.

Launch the rebuilt app from Finder or from the terminal:

```bash
open "src-tauri/target/release/bundle/macos/AI Token League.app"
```

## Platform Artifacts

The macOS build produces:

```text
src-tauri/target/release/bundle/macos/AI Token League.app
src-tauri/target/release/bundle/dmg/AI Token League_<version>_aarch64.dmg
```

The Windows build produces:

```text
src-tauri/target/release/bundle/nsis/AI Token League_<version>_x64-setup.exe
src-tauri/target/release/bundle/msi/AI Token League_<version>_x64_en-US.msi
```

Windows UI/E2E has been validated by external users on real Windows machines; repeat this check after packaging or updater changes.
