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

Current product baseline: `0.5`; client version: `0.5.3` (released 2026-05-09).
Next product baseline: `0.6`, tracked by `doc/0.6-baseline.md` and `doc/0.6-development-tasks.md`.

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
src/collector/    CLI collector, provider registry, local config, scan/sync logic
src/desktop/      Electron desktop app
src/shared/       Shared schema, pricing, crypto, dates, display helpers
src/web/          Public and admin Web UI (index.html, admin.html, app.js, admin.js, styles.css)
tests/            Node-based test runner
doc/              Product, architecture, deployment, packaging, and smoke docs
migrations/       MySQL migrations
samples/          Sample usage data
assets/           App icons and source image
```

## Commands

Install:

```bash
npm install
```

Start backend and public Web:

```bash
npm start
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
npm run desktop:smoke
```

Tests:

```bash
npm test
```

Backend smoke:

```bash
npm run smoke
```

Package desktop bundles:

```bash
rm -rf dist
npm run package:all
```

Package native installers:

```bash
rm -rf dist-installer
npm run package:installer:all
```

Release dry run and publish:

```bash
npm run release:dry-run
npm run release:publish
```

Generated artifacts:

```text
dist/AI Token League-darwin-arm64.zip
dist/AI Token League-darwin-x64.zip
dist/AI Token League-win32-x64.zip
dist-installer/AI Token League-<version>-mac-arm64-installer.dmg
dist-installer/AI Token League-<version>-mac-x64-installer.dmg
dist-installer/AI Token League-<version>-win-x64-installer.exe
```

Windows status: initial verification passed and the app is usable, but Windows host coverage is not yet full.

## Release Flow

Two version axes are intentionally separate:

- Client version: `package.json` `"version"`; controls desktop/CLI/server package version, installer filenames, release manifests, update checks, and changelog entries.
- Product baseline: `package.json` `"productBaseline"`; controls product iteration docs such as `doc/<baseline>-baseline.md`, `doc/<baseline>-development-tasks.md`, and roadmap sections.

### Step 1: Bump client version or product baseline

```bash
npm run bump -- <new-version>                         # client release only, e.g. 0.5.3
npm run bump -- --baseline <major.minor>              # product iteration only, e.g. 0.6
npm run bump -- <new-version> --baseline <major.minor> # release and move baseline together
npm run bump -- <new-version> --date 2026-06-01       # explicit release date
```

Client-only bumps must not create or rename product baseline documents. Baseline-only bumps must not change installer filenames or README current-version strings.

The script updates only the files that match the selected mode:

- Client version mode: `package.json`, `README.md`, `README.en.md`, `CLAUDE.md`, `AGENTS.md`.
- Product baseline mode: `package.json`, `CLAUDE.md`, `AGENTS.md`, `doc/roadmap.md`.

### Step 2: Manual steps (script output lists these)

1. For client releases, write `CHANGELOG.md` and `CHANGELOG.zh-CN.md` entries for the new client version.
2. For product baseline changes, create `doc/<baseline>-baseline.md` from current product state.
3. For product baseline changes, create `doc/<baseline>-development-tasks.md` with task plan.
4. Run `npm install --package-lock-only` if `package.json` version changed.
5. Run `npm test` to verify.

### Step 3: Build and publish

```bash
npm run release:build     # clean build: zip + installer artifacts
npm run release:dry-run   # verify manifest without uploading
npm run release:upload    # upload to OSS (requires credentials)
```

Or combined: `npm run release:publish` (build + upload).

### Design rules

- `--app-version` is NOT hardcoded in npm scripts; `electron-packager` reads `package.json` version automatically.
- Tests use `APP_VERSION` constant from `src/shared/version.js`, not hardcoded strings.
- Product baseline tests validate `PRODUCT_BASELINE` format only; they must not require it to match `APP_VERSION` major/minor.
- Installer filenames embed version via `electron-builder.yml` `${version}` template.
- Documentation filenames use product baseline, not client semver.

## API Surface

Source of truth: `src/backend/server.js`. Read the route definitions there; do not maintain a separate route list in this file.

The active upload route is `/api/usage/daily-batch`. Do not document `/api/usage/upload` as current unless the server route is restored.

## Admin Auth

Admin page (`/admin.html`) and `/api/admin/*` routes are protected by HTTP Basic Auth when `ADMIN_USERNAME` is set.

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=secret npm start
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
Electron userData/usage-cache.json
```

Desktop runtime log:

```text
Electron userData/runtime-log.jsonl
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
HOME="$PWD/.tmp-smoke/home" DB_PATH="$PWD/.tmp-smoke/data/db.json" npm start
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

`npm run preset` (and `npm run release:build`) automatically reads `env.local` to generate `assets/preset.json` — the build-time configuration baked into the desktop app. This means developers do **not** need to export `PRESET_*` variables manually; just keep them in `env.local`.

- If `env.local` is missing or contains no `PRESET_*` keys, the preset is empty and the app falls back to runtime defaults — no error.
- `env.local` is excluded from the Electron package (`electron-builder.yml` excludes `env.*`), so secrets never ship.
- Override with an explicit file: `node scripts/build-preset.js --env path/to/other.env`.

## Operations Manual

For server deployment, release channel configuration, and client preset setup, see `doc/operations.md`.

## Verification Baseline

Use the smallest verification that covers the touched surface:

- README or docs only: inspect rendered Markdown-sensitive links and run `git diff --check`.
- Backend API or store changes: run `npm test` and relevant smoke/API checks.
- Desktop UI changes: run `node --check src/desktop/main.cjs`, `node --check src/desktop/renderer.js`, `npm test`, and `npm run desktop:smoke`.
- Packaging changes: run `npm run package:all` after tests, then follow `doc/packaging.md`.
- MySQL storage changes: run JSON tests plus the Docker/MySQL path in `doc/test-deployment.md` when feasible.

Smoke checklist: `doc/smoke-checklist.md`.

## Multilingual (i18n) Rules

All user-facing UI text must support `zh-CN` and `en` via `src/shared/i18n.js`.

- **HTML elements**: use `data-i18n="key"`, `data-i18n-placeholder="key"`, `data-i18n-title="key"`.
- **Dynamic JS content**: use `t("key")` or `t("key", { param: value })`.
- **New features**: must add i18n keys for both `zh-CN` and `en` in `src/shared/i18n.js`, and use `t()` / `data-i18n` in all UI code.
- **No hardcoded user-facing strings**: do not hardcode Chinese or English text in HTML or JS that users see.
- **Number formatting**: use `src/shared/display.js` `formatTokenCompact()` for locale-aware number display; do not duplicate inline.
- **Exception**: CLI (`src/collector/cli.js`) is English-only and does not require i18n.
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
