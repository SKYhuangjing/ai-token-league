# AGENTS.md

Project instructions for coding agents working on AI Token League.

## Project Mode

Use first-principles reasoning. Do not follow a requested path blindly when the project goal implies a shorter or safer route.

Before starting, decide the mode:

- Discussion mode: use when the goal, motivation, boundary, proposed approach, or verification method is unclear. Output only decision-relevant information: problem definition, success criteria, constraints, recommended approach, rejected alternatives, verification plan, and open questions.
- Engineering mode: use when the goal, scope, and acceptance criteria are clear, or when the user asks to implement, fix, package, verify, or deliver. Complete the change end to end: implementation, verification, result summary, assumptions, and remaining risks.

Default to engineering mode when the user asks for implementation, fixes, docs updates, packaging, or verification. Use discussion mode only when the goal, boundary, or acceptance criteria are unclear.

Before changing behavior, identify the real source of truth in code and docs. Do not patch symptoms without checking the call path, storage path, and verification path.

## Product Summary

AI Token League is a local-first AI coding token usage collector plus public leaderboard for Codex, Claude Code, and Cursor.

Current product baseline: `0.7`; client version: `0.6.4` (released 2026-05-18).
Frozen product baseline: `0.6`, tracked by `doc/0.6-baseline.md` and `doc/0.6-development-tasks.md`.
Active product baseline: `0.7`, tracked by `doc/0.7-baseline.md` and `doc/0.7-development-tasks.md`.

Core behavior:

- Desktop and CLI collectors scan supported local or remote usage sources.
- Backend stores signed aggregate daily usage facts.
- Public Web ranks participants by `totalTokens`.
- Estimated cost is optional display, not the ranking truth.
- The server must not receive prompts, assistant responses, source code, full transcripts, real absolute paths, Cursor session tokens, or identity private keys.

## Supported Providers

| Provider | Status | Notes |
| --- | --- | --- |
| `codex_local` | Supported | Scans local Codex session JSONL logs. |
| `claude_code_local` | Supported | Scans local Claude Code project logs. |
| `cursor_dashboard_usage` | Supported when enabled | Uses Cursor dashboard usage API; real project paths are not available. |

Token total rule:

```text
totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
```

Reasoning tokens are diagnostic and cost-related fields, not part of the main ranking total.

## Repository Layout

```text
src/backend/      Node.js backend, API, JSON/MySQL stores, OpenRouter pricing
collector-core/   Rust collector core: config, providers, scan/sync, diagnostics
atl-collector/    Rust CLI and Tauri sidecar binary
src/desktop/      Tauri desktop renderer and bridge
src/shared/       Shared schema, pricing, crypto, dates, display helpers
src/web/          Public and admin Web UI (index.html, admin.html, app.js, admin.js, styles.css)
tests/            Node-based test runner
doc/              Product, architecture, deployment, packaging, and smoke docs
migrations/       MySQL migrations
samples/          Sample usage data
assets/           App icons and source image
scripts/          Operational scripts for server startup, release, presets, packaging helpers, and diagnostics
```

## Commands

Prefer the project scripts for service and release workflows. They encode env loading, version checks, port handling, preset generation, platform selection, and upload options that raw npm commands do not cover.

Install:

```bash
npm install
```

Start backend and public Web:

```bash
scripts/start-server.sh --env env.local
```

Open:

```text
http://127.0.0.1:8787
```

Collector:

```bash
npm run collector:init -- --nickname sky --api http://127.0.0.1:8787
npm run collector -- scan
npm run collector -- sync
```

Run `npm run collector -- --help` for all subcommands (health, register, export-identity, import-identity, etc.).

Desktop:

```bash
npm run desktop
```

Desktop feature quick self-test:

When a desktop client feature is still in development and the immediate goal is to self-test the local behavior or confirm the UI direction, use the fast local dev loop:

```bash
node --check src/desktop/renderer.js
cargo test --workspace
npm run desktop
```

Manually exercise the feature entry, the core state, and any relevant empty or error state. Treat this as development-stage self-test evidence only; it does not replace merge, release, smoke, or packaged-runtime verification.

Do not package by default for ordinary desktop UI or renderer changes. Package only when the changed surface can differ between Tauri dev mode and the installed/bundled runtime.

Tests:

```bash
npm test
```

Backend smoke:

```bash
npm run smoke
```

Package or release desktop artifacts:

```bash
scripts/release.sh
```

Common non-interactive release examples:

```bash
scripts/release.sh --platform all --yes
scripts/release.sh --platform all --env env.local --upload --yes
```

For local development changes that touch packaged desktop behavior, bundled assets, presets, updater/release metadata, package-resource wiring, or install/download UX, build exactly one current-machine zip before treating the work as done. The agent or script must identify the environment; the user should not have to choose a platform:

```bash
scripts/release.sh --platform current --env env.local --yes
```

Use `--platform all` only for explicit release-facing verification, not routine local debugging.

Formal full-platform releases should use the GitHub Actions matrix or real per-OS build hosts: macOS for macOS artifacts, Windows for Windows artifacts, and Ubuntu for Linux artifacts. macOS-hosted Windows/Linux cross-builds are developer diagnostics only, not the stable release path.

Low-level build commands:

```bash
npx tauri build                            # build for current platform
npx tauri build --target aarch64-apple-darwin  # macOS arm64
npx tauri build --target x86_64-apple-darwin   # macOS Intel
npx tauri build --target x86_64-pc-windows-msvc # Windows
```

Manual release dry run and publish:

```bash
node scripts/publish-release.js --env env.local --dry-run
node scripts/publish-release.js --env env.local
```

Generated artifacts:

```text
src-tauri/target/release/bundle/macos/AI Token League.app
src-tauri/target/release/bundle/dmg/AI Token League_<version>_aarch64.dmg
src-tauri/target/release/bundle/nsis/AI Token League_<version>_x64-setup.exe
src-tauri/target/release/bundle/AI Token League.app.tar.gz          (updater package)
src-tauri/target/release/bundle/AI Token League.app.tar.gz.sig      (signature)
```

Windows status: initial verification passed and the app is usable, but Windows host coverage is not yet full.

## Scripts Directory

All scripts are run from the project root unless noted. Reflect new scripts here when adding operational entrypoints.

| Script | Primary use | Preferred command |
| --- | --- | --- |
| `scripts/start-server.sh` | Start backend + public Web with env loading, Node >= 22 check, occupied-port fallback, optional smoke, detach/log/pid support. | `scripts/start-server.sh --env env.local` |
| `scripts/release.sh` | Interactive or non-interactive release builder: optional version bump, preset generation, Tauri build, and OSS upload. `--upload` automatically switches to all platforms because release metadata requires the complete artifact set. | `scripts/release.sh` or `npm run release` |
| `scripts/setup-build-env-macos.sh` | Idempotently initialize a macOS build host with Xcode Command Line Tools, Homebrew-managed Node, Rust stable, macOS Rust targets, and npm dependencies. | `scripts/setup-build-env-macos.sh` |
| `scripts/setup-build-env-windows.ps1` | Idempotently initialize a Windows build host with Node, Git Bash, Rust stable MSVC, Visual Studio C++ Build Tools, Windows Tauri CLI native package, and npm dependencies. | `powershell -ExecutionPolicy Bypass -File scripts/setup-build-env-windows.ps1` |
| `scripts/setup-build-env-linux.sh` | Idempotently initialize an Ubuntu build host with Node 22, Rust stable, Linux Tauri system dependencies, Linux Tauri CLI native package, and npm dependencies. | `scripts/setup-build-env-linux.sh` |
| `scripts/bump-version.js` | Client version and/or product baseline bump across package/docs metadata. | `npm run bump -- <version>` or `npm run bump -- --baseline <major.minor>` |
| `scripts/check-release-version.js` | Local and CI release gate for tag/version/changelog/lockfile consistency before a `v*` tag is created or published. | `npm run release:check -- --tag v<version>` |
| `scripts/build-preset.js` | Generate `assets/preset.json` from `PRESET_*` env values or an env file before packaging. | `npm run preset -- --env env.local` |
| `scripts/publish-release.js` | Build release manifests and upload updater/installer artifacts to OSS; supports dry run. | `node scripts/publish-release.js --env env.local --dry-run` |
| `scripts/prepare-github-release.js` | GitHub Actions helper: create or reuse one draft release, delete stale duplicate drafts, clear old assets, and output the canonical `release_id`. | Called by `.github/workflows/release.yml` |
| `scripts/upload-github-release-asset.js` | GitHub Actions helper: upload a generated release asset such as `latest.json` by `release_id`, with optional clobber. | Called by `.github/workflows/release.yml` |
| `scripts/patch-dmg-readme.js` | Add `assets/mac-install-readme.txt` into generated macOS DMGs; normally called by installer npm scripts. | `node scripts/patch-dmg-readme.js` |
| `scripts/generate-icons.js` | Regenerate desktop and web icon assets from `assets/app-icon-source.png`. | `npm run icons` |
| `scripts/network-probe.mjs` | Print local network interfaces for LAN/server access diagnostics. | `node scripts/network-probe.mjs` |

Raw `npm start` runs `src/backend/server.js` directly. Use it only when intentionally bypassing `scripts/start-server.sh`, for example inside focused test commands or when a wrapper would hide the behavior being debugged.

## Release Flow

Two version axes are intentionally separate:

- Client version: `package.json` `"version"`; controls desktop/CLI/server package version, installer filenames, release manifests, update checks, and changelog entries.
- Product baseline: `package.json` `"productBaseline"`; controls product iteration docs such as `doc/<baseline>-baseline.md`, `doc/<baseline>-development-tasks.md`, and roadmap sections.

### GitHub Remote Auth

This local machine has working SSH credentials for GitHub. Prefer SSH for GitHub push and release-flow checks instead of the HTTPS `github` remote, which may fail non-interactively when it tries to read a password.

```bash
git push git@github.com:SKYhuangjing/ai-token-league.git <branch-or-tag>
```

### Step 1: Bump client version or product baseline

```bash
npm run bump -- <new-version>                         # client release only, e.g. 0.5.3
npm run bump -- --baseline <major.minor>              # product iteration only, e.g. 0.6
npm run bump -- <new-version> --baseline <major.minor> # release and move baseline together
npm run bump -- <new-version> --date 2026-06-01       # explicit release date
```

Client-only bumps must not create or rename product baseline documents. Baseline-only bumps must not change installer filenames or README current-version strings.

The script updates only the files that match the selected mode:

- Client version mode: `package.json`, root `Cargo.toml`, `src-tauri/tauri.conf.json`, `README.md`, `README.en.md`, `CLAUDE.md`, `AGENTS.md`.
- Product baseline mode: `package.json`, `CLAUDE.md`, `AGENTS.md`, `doc/roadmap.md`.

### Step 2: Manual steps and local release gate

1. For client releases, write `CHANGELOG.md` and `CHANGELOG.zh-CN.md` entries for the new client version. Tag public-download-page items with `[Desktop]`, `[Web]`, or `[Desktop, Web]` (e.g. `- [Desktop] Source toggle controls now use a switch-style UI`). The public download page latest-updates block renders only tagged items; untagged items (internal API, scripts, migrations, tooling, documentation) remain in the changelog but are not shown in that block.
2. For product baseline changes, create `doc/<baseline>-baseline.md` from current product state.
3. For product baseline changes, create `doc/<baseline>-development-tasks.md` with task plan.
4. Run `npm install --package-lock-only` if `package.json` version changed.
5. Run `cargo update -p ai-token-league --precise <new-version>` if root `Cargo.toml` version changed.
6. Run `npm run release:check -- --tag v<new-version>`, `npm test`, and `cargo test --workspace`.

### Step 3: Tag protocol for agents

When the user asks to "打 tag", "推 tag", "发版 tag", or "push a release tag", do not create the tag directly. Run this checklist first:

1. Confirm the target tag is `v<package.version>` or run `npm run bump -- <new-version>` to make it so.
2. Ensure `package-lock.json`, root `Cargo.toml`, `Cargo.lock`, `src-tauri/tauri.conf.json`, `CHANGELOG.md`, and `CHANGELOG.zh-CN.md` are updated for that exact version.
3. Run:

```bash
npm run release:check -- --tag v<new-version>
npm test
cargo test --workspace
git diff --check
```

4. Commit the release-prep changes before creating the tag.
5. Create the tag on the verified commit, then push the branch and tag through SSH:

```bash
git tag v<new-version>
git push git@github.com:SKYhuangjing/ai-token-league.git <branch>
git push git@github.com:SKYhuangjing/ai-token-league.git v<new-version>
```

If any gate fails, fix the release metadata first. Do not move or force-push an existing release tag unless the user explicitly asks for a retag.

### Step 4: Build and publish

```bash
scripts/release.sh        # interactive: guides through platform, env, upload
```

Or manually:

```bash
scripts/release.sh --platform all --env env.local --yes     # clean build: zip + installer artifacts
node scripts/publish-release.js --env env.local --dry-run   # verify manifest
node scripts/publish-release.js --env env.local             # upload to OSS
```

### Design rules

- Version is managed in `package.json`, root `Cargo.toml`, and `src-tauri/tauri.conf.json`; `cargo tauri build` reads the workspace package version from root `Cargo.toml`.
- Tests use `APP_VERSION` constant from `src/shared/version.js`, not hardcoded strings.
- Product baseline tests validate `PRODUCT_BASELINE` format only; they must not require it to match `APP_VERSION` major/minor.
- Documentation filenames use product baseline, not client semver.

## API Surface

Source of truth: `src/backend/server.js`. Read the route definitions there; do not maintain a separate route list in this file.

The active upload route is `/api/usage/daily-batch`. Do not document `/api/usage/upload` as current unless the server route is restored.

## Admin Auth

Admin page (`/admin.html`) and `/api/admin/*` routes are protected by HTTP Basic Auth when `ADMIN_USERNAME` is set.

Set auth in the env file used by `scripts/start-server.sh`:

```text
ADMIN_USERNAME=admin
ADMIN_PASSWORD=secret
```

Then start the service:

```bash
scripts/start-server.sh --env env.local
```

When `ADMIN_USERNAME` is empty or unset, admin routes remain open (backward compatible for local dev).

## Storage

Backend JSON storage defaults to:

```text
data/db.json
```

Collector local config defaults to:

```text
~/.ai-token-league/config.json
```

Local usage cache:

```text
~/.ai-token-league/usage-cache.json
```

Desktop runtime log:

```text
~/.ai-token-league/runtime-log.jsonl
```

Upload queue:

```text
~/.ai-token-league/upload-queue.json
```

Diagnostics export:

```text
User-selected local JSON file named ai-token-league-diagnostics-<timestamp>.json
```

Use isolated paths during smoke runs:

```bash
mkdir -p .tmp-smoke/home .tmp-smoke/data
cat > .tmp-smoke/env.smoke << EOF
HOME=$PWD/.tmp-smoke/home
DB_PATH=$PWD/.tmp-smoke/data/db.json
PORT=8787
EOF
scripts/start-server.sh --env .tmp-smoke/env.smoke
```

## MySQL Test Deployment

See `doc/test-deployment.md` for Docker-based MySQL setup, env files, and timezone config.

### Env File Special Characters

`env.local` and `env.test` are sourced by shell when running locally (not via Docker). Values containing shell metacharacters (`>`, `<`, `|`, `&`, `!`, `$`, etc.) **must be single-quoted**:

```text
# WRONG — > is interpreted as redirect, password truncated
MYSQL_PASSWORD=h0uBPTVtmzF>1xuW

# RIGHT — single quotes protect special characters
MYSQL_PASSWORD='h0uBPTVtmzF>1xuW'
```

Docker Compose `env_file` does NOT interpret shell metacharacters, so quoting is only needed for local `source` / `. ./env.test` usage. Always quote env values with special characters to avoid silent credential truncation.

### `env.local` as Build Preset Source

`scripts/release.sh` prompts for an env file and passes it to `build-preset.js` and `publish-release.js`. When running manually, pass `--env` explicitly:

```bash
node scripts/build-preset.js --env env.local
```

- If no `--env` is provided and no `PRESET_*` keys are in the environment, the preset is empty and the app falls back to runtime defaults — no error.
- `env.local` is not included in the Tauri bundle (only `src/desktop/` and `src/shared/` are bundled), so secrets never ship.

## Operations Manual

For server deployment, release channel configuration, and client preset setup, see `doc/operations.md`.

## Verification Baseline

Use the smallest verification that covers the touched surface:

- README or docs only: inspect rendered Markdown-sensitive links and run `git diff --check`.
- Claude Code or Codex collector changes: run `npm test` and `cargo test --workspace`; when checking real local totals against ccusage, use a temporary external/manual comparison, not a legacy in-repo collector path.
- Backend API or store changes: run `npm test` and relevant smoke/API checks.
- Desktop feature quick self-test: if the goal is local behavior or UI-direction confirmation during development, run the desktop feature quick self-test loop above. This is enough for development-stage self-test, not for final delivery.
- Desktop UI changes before merge or handoff: run `node --check src/desktop/renderer.js`, `npm test`, `cargo test --workspace`, and `npm run desktop` to verify the Tauri app launches. This is the default path for renderer/UI behavior.
- Packaging, updater, preset, bundled-asset, install/download UX, or package-resource changes: run tests, then build with `scripts/release.sh --platform current --env <env-file> --yes`, and follow `doc/packaging.md`.
- MySQL storage changes: run JSON tests plus the Docker/MySQL path in `doc/test-deployment.md` when feasible.

Smoke checklist: `doc/smoke-checklist.md`.

## Multilingual (i18n) Rules

All user-facing UI text must support `zh-CN` and `en` via `src/shared/i18n.js`.

- **HTML elements**: use `data-i18n="key"`, `data-i18n-placeholder="key"`, `data-i18n-title="key"`.
- **Dynamic JS content**: use `t("key")` or `t("key", { param: value })`.
- **New features**: must add i18n keys for both `zh-CN` and `en` in `src/shared/i18n.js`, and use `t()` / `data-i18n` in all UI code.
- **No hardcoded user-facing strings**: do not hardcode Chinese or English text in HTML or JS that users see.
- **Number formatting**: use `src/shared/display.js` `formatTokenCompact()` for locale-aware number display; do not duplicate inline.
- **Exception**: Rust CLI (`atl-collector`) is English-only and does not require i18n.
- **Verification**: new UI features must be tested with both `zh-CN` and `en` language settings.

## Documentation Rules

- Keep `README.md` optimized for GitHub discovery, product positioning, privacy model, and quick start.
- Put development commands, route details, storage details, and verification workflow in this file.
- Treat the highest implemented `doc/<baseline>-baseline.md` as the current product baseline.
- Treat the highest planned `doc/<baseline>-baseline.md` plus `doc/<baseline>-development-tasks.md` pair as the active next-version plan.
- Keep `doc/v0.1-baseline.md` frozen as history.
- If code and docs disagree, verify code first, then update the docs that are wrong.

## Version Baseline and Task Iteration

When the user says "开 x.x 版本" or asks to start a new version, do this before coding:

1. Read the latest implemented baseline and development task document.
2. Create `doc/x.x-baseline.md` from the latest real product state, not from wishful roadmap text.
3. Create `doc/x.x-development-tasks.md` with status values, epics, task cards, verification matrix, key files, and confirmed decisions.
4. Update `doc/roadmap.md`, `doc/README.md`, and README project-doc links so the new version pair is discoverable.
5. Keep older baselines immutable except for explicit correction of factual mistakes.

During a version, every temporary or opportunistic code feature must be recorded in both documents:

- In the baseline: add a "Temporary / Opportunistic Changes" entry describing the behavior, user value, boundaries, privacy/storage/API impact, and whether it is permanent, experimental, or deferred.
- In the task document: add a task row with owner surface, status, verification, and the reason it was admitted mid-version.
- If a temporary feature changes API, storage, privacy boundary, compatibility, release artifacts, or data meaning, pause for confirmation before implementation.

## Current Limits

- No hook-based live collection yet.
- Cost is optional display, not primary ranking.
- Cursor dashboard usage does not provide local workdir attribution.
