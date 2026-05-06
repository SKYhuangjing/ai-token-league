# Packaging

This document is the operational checklist for rebuilding desktop distribution artifacts.

## Prerequisites

- Node.js 22 or newer.
- Dependencies installed with `npm install`.
- Run commands from the project root.

## Build

Use a clean `dist` rebuild when validating UI or desktop packaging changes:

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

Optional macOS Intel DMG installer:

```bash
npm run package:mac:intel:installer
```

Expected installer artifact:

```text
dist-installer/AI Token League-0.3.0-mac-intel-installer.dmg
```

## Release Manifest Dry Run

Release resource configuration is read from env. `scripts/publish-release.js` loads `env.local` by default for local runs; CI should inject the same keys through secrets.

```bash
npm run release:dry-run
```

Expected behavior:

- `darwin-arm64`, `darwin-x64`, and `win32-x64` zip artifacts are included.
- `checksums.txt` is generated from the zip files.
- `releases/<version>/...` artifacts are planned before `releases/latest.json`.
- `latest.json` is the final upload step.

Publish only from a trusted release environment:

```bash
npm run release:publish
```

The publish script reads `RELEASE_OSS_ACCESS_KEY_ID` and `RELEASE_OSS_ACCESS_KEY_SECRET` from env. These values must not be committed or exposed through app-server responses.

## Verify

Run these before treating the package as current:

```bash
node --check src/desktop/main.cjs
node --check src/desktop/renderer.js
npm test
npm run desktop:smoke
npm run release:dry-run
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

Windows UI/E2E has been validated by external users on real Windows machines; repeat this check after packaging or updater changes.
