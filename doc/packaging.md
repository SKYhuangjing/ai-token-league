# Packaging

This document is the operational checklist for rebuilding desktop distribution artifacts.

## Prerequisites

- Node.js 22 or newer.
- Rust toolchain (install from https://rustup.rs).
- Dependencies installed with `npm install`.
- Run commands from the project root.

## Build Environment Matrix

Official full-platform release builds must run on matching operating systems. Do not treat macOS-hosted Windows or Linux cross-builds as the formal release path; those are only acceptable for developer diagnostics.

For local or self-hosted build machines, initialize the host with the matching idempotent setup script before running `scripts/release.sh`:

| Host | Setup command | Build command |
| --- | --- | --- |
| macOS | `scripts/setup-build-env-macos.sh` | `scripts/release.sh --platform current --env env.local --yes` |
| Windows | `powershell -ExecutionPolicy Bypass -File scripts/setup-build-env-windows.ps1` | `bash scripts/release.sh --platform win --env env.local --yes` |
| Ubuntu | `scripts/setup-build-env-linux.sh` | `scripts/release.sh --platform linux --env env.local --yes` |

The setup scripts can be rerun. They check existing Node, Rust, platform toolchain, and npm dependencies first, then install only missing pieces where possible.

| Target | Required build host | Required setup |
| --- | --- | --- |
| macOS arm64 | GitHub Actions `macos-latest` or local macOS | Node.js 22, Rust stable, Xcode Command Line Tools, `rustup target add aarch64-apple-darwin` |
| macOS Intel | GitHub Actions `macos-latest` or local macOS | Node.js 22, Rust stable, Xcode Command Line Tools, `rustup target add x86_64-apple-darwin` |
| Windows x64 | GitHub Actions `windows-latest` or Windows build host | Node.js 22, Git Bash, Rust stable MSVC toolchain, Visual Studio Build Tools, `@tauri-apps/cli-win32-x64-msvc` |
| Linux x64 | GitHub Actions `ubuntu-22.04` or Ubuntu build host | Node.js 22, Rust stable, `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`, `@tauri-apps/cli-linux-x64-gnu` |

Updater artifacts must be signed in the build environment:

```text
TAURI_SIGNING_PRIVATE_KEY=<tauri updater private key>
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<optional password>
```

## Interactive Release Script

The primary way to build and release is through the interactive script:

```bash
npm run release
# or directly:
bash scripts/release.sh
```

The script guides you through:

1. **Version** — keep current or bump to a new version
2. **Platform** — macOS arm64, macOS Intel, macOS All, Windows, Linux, or All
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
| `--platform PLAT` | `current` / `mac-arm64` / `mac-intel` / `mac-all` / `win` / `linux` / `all` |
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

Use a clean build when validating packaged UI behavior or packaging changes:

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
npx tauri build --target x86_64-unknown-linux-gnu # Linux x64
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

**Linux:**
- `appimage/AI Token League_<version>_amd64.AppImage` — AppImage
- `deb/ai-token-league_<version>_amd64.deb` — Debian package
- `appimage/AI Token League_<version>_amd64.AppImage.tar.gz` + `.sig` — updater package

## Distribution Release Flow

GitHub Release is the primary release path. The client does not read GitHub directly; it calls the app server at `/api/tauri/update.json`, and the server reads either GitHub Release assets or self-hosted metadata based on env.

### GitHub Release

GitHub Actions is the recommended official release builder because it provides the required macOS, Windows, and Ubuntu runners in one matrix. Local `scripts/release.sh --platform all` is for self-hosted build farms or focused release troubleshooting, not the default official release path.

Required GitHub Actions secrets:

```text
TAURI_SIGNING_PRIVATE_KEY=<tauri updater private key>
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<optional password>
```

Before tagging, verify the release line locally:

```bash
npm run release:check -- --tag v0.6.4
npm test
cargo test --workspace
npm run verify:ccusage
node --check scripts/prepare-github-release.js
node --check scripts/upload-github-release-asset.js
node --check scripts/build-github-tauri-update-json.js
```

Release by pushing a `v*` tag that matches `package.json`, `package-lock.json`, root `Cargo.toml`, `Cargo.lock`, `src-tauri/tauri.conf.json`, and both changelog files:

```bash
git tag v0.6.4
git push git@github.com:SKYhuangjing/ai-token-league.git <branch>
git push git@github.com:SKYhuangjing/ai-token-league.git v0.6.4
```

The workflow builds macOS arm64, macOS Intel, Windows x64, and Linux x64; uploads installers plus signed updater packages; generates a merged `latest.json`; verifies the expected release assets; then publishes the GitHub Release.

The canonical release object inside the workflow is `release_id`, not the tag lookup endpoint. GitHub draft releases can appear as `untagged-*` until published, so release steps must pass the `release_id` from `prepare-release` into build, upload, verify, and publish operations. Do not replace this with `/releases/tags/<tag>` in draft-time steps.

Reruns are expected to be idempotent:

- `scripts/prepare-github-release.js` reuses the latest matching draft release.
- Older duplicate drafts with the same release name are deleted.
- Existing assets on the selected draft are removed before the matrix build uploads fresh assets.
- Published releases are not overwritten unless `ALLOW_PUBLISHED_RELEASE_OVERWRITE=true` is explicitly set.

The expected GitHub Release assets are:

```text
latest.json
*.app.tar.gz
*.app.tar.gz.sig
*.dmg
*-setup.exe
*-setup.exe.sig
*.AppImage
*.AppImage.sig
```

Configure the app server to distribute from GitHub:

```text
RELEASE_SOURCE=github
RELEASE_GITHUB_REPOSITORY=SKYhuangjing/ai-token-league
RELEASE_GITHUB_TAG=          # optional pin; empty means latest release
RELEASE_GITHUB_TOKEN=        # optional for private repo or higher API rate limit
```

### Self-Hosted Distribution

Self-hosted distribution keeps the same client/server API shape, but does not use GitHub Release. Build every supported platform, publish static metadata to your download host, and point the app server at those metadata files.

There are two supported ways to produce self-hosted assets:

- Reuse the GitHub Actions release assets, then mirror them to OSS/CDN and publish the static metadata.
- Run separate trusted build hosts for macOS, Windows, and Ubuntu, upload per-platform release parts, then finalize the merged metadata.

Use `scripts/release.sh --platform all --env <env-file> --upload --yes` only when one host has all platform artifacts. For split self-hosted builders, run each platform with `--upload`; the script uploads only that platform's artifacts and part metadata. After all required build hosts finish, run `node scripts/publish-release.js --env <env-file> --finalize` once from a trusted release environment.

The static host must expose:

```text
<public-base>/tauri-releases/tauri-update.json
<public-base>/tauri-releases/latest.json
<public-base>/tauri-releases/installer.json
<public-base>/tauri-releases/<version>/installer.json
<public-base>/tauri-releases/<version>/checksums.txt
<public-base>/tauri-releases/<version>/parts/<platform>.json
<public-base>/tauri-releases/<version>/<installer-and-updater-assets>
```

Configure the app server to distribute from self-hosted metadata:

```text
RELEASE_SOURCE=static
RELEASE_RELEASE_PATH=tauri-releases
RELEASE_TAURI_UPDATE_URL=https://example.com/tauri-releases/tauri-update.json
RELEASE_INSTALLER_URL=https://example.com/tauri-releases/installer.json
RELEASE_PUBLIC_BASE_URL=https://example.com
# Optional when the self-hosted channel does not publish Linux:
RELEASE_REQUIRED_PLATFORMS=darwin-arm64,darwin-x64,win32-x64
```

The server runtime must not receive OSS write credentials. Keep `RELEASE_OSS_ACCESS_KEY_ID` and `RELEASE_OSS_ACCESS_KEY_SECRET` only in the trusted release environment that runs the upload.

### Static Manifest Dry Run

Release resource configuration is read from env. `scripts/publish-release.js` requires an explicit `--env` flag or `RELEASE_*` environment variables; it does not default to `env.local`.

```bash
node scripts/publish-release.js --env env.local --dry-run --full
```

Expected behavior:

- Updater artifacts (`.app.tar.gz` / `.nsis.zip` / `.AppImage.tar.gz`) are collected from `dist/`.
- Installer artifacts (`.dmg` / `.exe` / `.AppImage`) are collected from `dist/`.
- `checksums.txt` is generated.
- `tauri-update.json` is generated for the Tauri updater plugin.
- `installer.json` is generated for the download page.
- `latest.json` is generated for backward compatibility.

Publish a complete local `dist/` only from a trusted release environment:

```bash
node scripts/publish-release.js --env env.local --full
```

To rebuild and upload from split self-hosted builders:

```bash
scripts/release.sh --platform mac-all --env env.local --upload --yes
scripts/release.sh --platform win --env env.local --upload --yes
node scripts/publish-release.js --env env.local --finalize
```

The upload script reads `RELEASE_OSS_ACCESS_KEY_ID` and `RELEASE_OSS_ACCESS_KEY_SECRET` from env. These values must not be committed or exposed through app-server responses.

## Verify

Run these before treating a package-related change as current. Ordinary desktop UI and renderer changes should use the dev-mode verification in `AGENTS.md` instead of this package checklist.

```bash
node --check src/desktop/renderer.js
node --check scripts/publish-release.js
node --check scripts/prepare-github-release.js
node --check scripts/upload-github-release-asset.js
node --check scripts/build-github-tauri-update-json.js
cargo test --workspace
npm test
npm run verify:ccusage
npm run desktop
node scripts/publish-release.js --env env.local --dry-run --full
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

The Linux build produces:

```text
src-tauri/target/release/bundle/appimage/AI Token League_<version>_amd64.AppImage
src-tauri/target/release/bundle/deb/ai-token-league_<version>_amd64.deb
```

Windows UI/E2E has been validated by external users on real Windows machines; repeat this check after packaging or updater changes.

Linux builds must run natively on Linux (same constraint as Windows). Cross-compilation from macOS is not supported.
