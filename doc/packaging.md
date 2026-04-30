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

- `npm run package:mac`
- `npm run package:win`
- `node scripts/zip-dist.js`

Expected artifacts:

```text
dist/AI Token League-darwin-arm64
dist/AI Token League-darwin-arm64.zip
dist/AI Token League-win32-x64
dist/AI Token League-win32-x64.zip
```

## Verify

Run these before treating the package as current:

```bash
node --check src/desktop/main.cjs
node --check src/desktop/renderer.js
npm test
npm run desktop:smoke
```

After `npm run package:all`, verify the packaged macOS main process:

```bash
"dist/AI Token League-darwin-arm64/AI Token League.app/Contents/MacOS/AI Token League" --desktop-smoke
```

Verify packaged desktop resources when UI changes are involved:

```bash
npx asar list "dist/AI Token League-darwin-arm64/AI Token League.app/Contents/Resources/app.asar" | rg "src/desktop/(index.html|styles.css|renderer.js|favicon.png)$"
```

## Launch Packaged macOS App

Close any already running `AI Token League` app before opening a rebuilt package; otherwise macOS may keep showing an older running instance.

Launch the rebuilt app from Finder or from the terminal:

```bash
open "dist/AI Token League-darwin-arm64/AI Token League.app"
```

For terminal logs:

```bash
"dist/AI Token League-darwin-arm64/AI Token League.app/Contents/MacOS/AI Token League"
```

Do not open `app.asar` directly. The app must be launched through the `.app` bundle or the platform executable so Electron resolves `src/desktop/index.html`, `styles.css`, `renderer.js`, and preload paths correctly.

## Windows Artifact

The Windows package is generated on this machine as an x64 Electron app bundle:

```text
dist/AI Token League-win32-x64/AI Token League.exe
```

Final Windows UI/E2E verification still requires a Windows host.
