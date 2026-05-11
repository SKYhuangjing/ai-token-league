# Packaging

This document is the operational checklist for rebuilding desktop distribution artifacts.

## Prerequisites

- Node.js 22 or newer.
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
4. **Installers** — whether to build DMG / NSIS installers
5. **Upload** — whether to upload artifacts to OSS
6. **Confirmation** — review selections before executing

CLI flags for non-interactive use:

```bash
bash scripts/release.sh --version 0.6.0 --platform all --yes
bash scripts/release.sh --platform mac-arm64 --env env.local --installers --upload --yes
```

| Flag | Description |
|------|-------------|
| `--version VER` | Version to release (default: current from package.json) |
| `--platform PLAT` | `current` / `mac-arm64` / `mac-intel` / `mac-all` / `win` / `all` |
| `--env FILE` | Env file for presets and upload credentials |
| `--installers` | Build native installers (DMG / NSIS) |
| `--upload` | Upload artifacts to OSS |
| `--yes` | Skip confirmation prompt |

## Manual Build

For normal release builds, prefer `scripts/release.sh` because it also handles preset generation, platform selection, installer choice, and optional upload. Use the low-level npm commands below only when validating a specific packaging layer.

During local development, if a change touches packaged desktop behavior, bundled assets, `assets/preset.json`, update/release metadata, installer README content, or public download/install UX, produce exactly one zip for the current machine before closing the work. The script detects the platform; the user should only care about the final artifact:

```bash
scripts/release.sh --platform current --env env.local --yes
```

Expected quick-debug zip output is one of:

```text
dist/AI Token League-darwin-arm64.zip
dist/AI Token League-darwin-x64.zip
dist/AI Token League-win32-x64.zip
```

Use `--platform all` only for explicit cross-platform packaging or release-facing changes.

Use a clean `dist` rebuild when validating UI or desktop zip packaging changes:

```bash
rm -rf dist
npm run package:all
```

The script runs:

- `npm run package:mac:all`
  - `npm run package:mac:arm64`
  - `npm run package:mac:intel`
- `npm run package:win`
- `node scripts/zip-dist.js`

Expected artifacts:

```text
dist/AI Token League-darwin-arm64
dist/AI Token League-darwin-arm64.zip
dist/AI Token League-darwin-x64
dist/AI Token League-darwin-x64.zip
dist/AI Token League-win32-x64
dist/AI Token League-win32-x64.zip
dist/checksums.txt
```

Expected 0.3.0 zip size after packaging exclusions:

```text
darwin-arm64: about 130 MB
darwin-x64: about 140 MB
win32-x64: about 160 MB
```

If a zip grows back to several hundred MB, inspect `app.asar` first. Local env files, previous installers, temp folders, docs, tests, Docker assets, backend/Web server assets, and release scripts must not be packaged into the desktop client.

## Native Installers

Build native installers (DMG for macOS, NSIS exe for Windows). In normal release flow, prefer:

```bash
scripts/release.sh --platform all --installers --yes
```

Use the low-level command for installer-only verification:

```bash
rm -rf dist-installer
npm run package:installer:all
```

The script runs `electron-builder` with the config from `electron-builder.yml`:

- `npm run package:installer:mac:arm64` — macOS Apple silicon DMG
- `npm run package:installer:mac:intel` — macOS Intel DMG
- `npm run package:installer:win` — Windows x64 NSIS exe

Expected installer artifacts:

```text
dist-installer/AI Token League-<version>-mac-arm64-installer.dmg
dist-installer/AI Token League-<version>-mac-x64-installer.dmg
dist-installer/AI Token League-<version>-win-x64-installer.exe
```

Prerequisites for macOS: none (electron-builder handles DMG natively). Prerequisites for Windows NSIS cross-build on macOS: Wine must be installed (`brew install --cask wine-stable`). electron-builder downloads NSIS automatically.

Individual installer scripts:

```bash
npm run package:installer:mac:arm64
npm run package:installer:mac:intel
npm run package:installer:mac:all
npm run package:installer:win
```

## Release Manifest Dry Run

Release resource configuration is read from env. `scripts/publish-release.js` requires an explicit `--env` flag or `RELEASE_*` environment variables; it does not default to `env.local`.

```bash
node scripts/publish-release.js --env env.local --dry-run
```

Expected behavior:

- `darwin-arm64`, `darwin-x64`, and `win32-x64` zip artifacts are included.
- If installer artifacts exist in `dist-installer/`, they are included alongside zip artifacts.
- `checksums.txt` is generated from the zip files.
- `releases/<version>/...` artifacts are planned before `releases/latest.json`.
- `latest.json` is the final upload step.
- The manifest `platforms` entries include an optional `installer` sub-object when installer artifacts are present.

Publish only from a trusted release environment:

```bash
node scripts/publish-release.js --env env.local
```

To rebuild and upload separately:

```bash
scripts/release.sh --platform all --installers --yes   # clean build zip + installer artifacts
node scripts/publish-release.js --env env.local   # upload with progress bar
```

The upload script reads `RELEASE_OSS_ACCESS_KEY_ID` and `RELEASE_OSS_ACCESS_KEY_SECRET` from env. These values must not be committed or exposed through app-server responses.

## Verify

Run these before treating the package as current:

```bash
node --check src/desktop/main.cjs
node --check src/desktop/renderer.js
node --check scripts/publish-release.js
npm test
npm run desktop:smoke
node scripts/publish-release.js --env env.local --dry-run
```

After `npm run package:all`, verify the packaged macOS main process:

```bash
"dist/AI Token League-darwin-arm64/AI Token League.app/Contents/MacOS/AI Token League" --desktop-smoke
"dist/AI Token League-darwin-x64/AI Token League.app/Contents/MacOS/AI Token League" --desktop-smoke
```

Verify packaged desktop resources when UI changes are involved:

```bash
npx asar list "dist/AI Token League-darwin-arm64/AI Token League.app/Contents/Resources/app.asar" | rg "src/desktop/(index.html|styles.css|renderer.js|favicon.png)$"
npx asar list "dist/AI Token League-darwin-x64/AI Token League.app/Contents/Resources/app.asar" | rg "src/desktop/(index.html|styles.css|renderer.js|favicon.png)$"
npx asar list "dist/AI Token League-darwin-arm64/AI Token League.app/Contents/Resources/app.asar" | rg "^/(dist-installer|env\\.local|env\\.test|\\.tmp|data|doc|tests|scripts|migrations|src/backend|src/web)" && exit 1 || true
```

After `npm run package:installer:all`, verify installer asar exclusion:

```bash
npx asar list "dist-installer/mac-arm64/AI Token League.app/Contents/Resources/app.asar" | rg "^/(src/backend|src/web|scripts|migrations|doc|tests)" && exit 1 || true
npx asar list "dist-installer/mac-arm64/AI Token League.app/Contents/Resources/app.asar" | rg "src/desktop/(index.html|renderer.js|preload.cjs)$"
```

## Launch Packaged macOS App

Close any already running `AI Token League` app before opening a rebuilt package; otherwise macOS may keep showing an older running instance.

Launch the rebuilt app from Finder or from the terminal:

```bash
open "dist/AI Token League-darwin-arm64/AI Token League.app"
open "dist/AI Token League-darwin-x64/AI Token League.app"
```

For terminal logs:

```bash
"dist/AI Token League-darwin-arm64/AI Token League.app/Contents/MacOS/AI Token League"
"dist/AI Token League-darwin-x64/AI Token League.app/Contents/MacOS/AI Token League"
```

Do not open `app.asar` directly. The app must be launched through the `.app` bundle or the platform executable so Electron resolves `src/desktop/index.html`, `styles.css`, `renderer.js`, and preload paths correctly.

## Platform Artifacts

The macOS Intel package is generated on this machine as an x64 Electron app bundle:

```text
dist/AI Token League-darwin-x64/AI Token League.app
```

The Windows package is generated on this machine as an x64 Electron app bundle:

```text
dist/AI Token League-win32-x64/AI Token League.exe
```

Native installers (built via `npm run package:installer:all`):

```text
dist-installer/AI Token League-<version>-mac-arm64-installer.dmg
dist-installer/AI Token League-<version>-mac-x64-installer.dmg
dist-installer/AI Token League-<version>-win-x64-installer.exe
```

Windows UI/E2E has been validated by external users on real Windows machines; repeat this check after packaging or updater changes.
