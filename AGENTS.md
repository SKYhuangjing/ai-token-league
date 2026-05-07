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

Current implemented baseline: `0.4`, released as `0.4.0` on `2026-05-06`.
Current planning baseline: `0.5`, tracked by `doc/0.5-baseline.md` and `doc/0.5-development-tasks.md`.

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
src/web/          Public and admin Web UI
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
npm run collector -- health
npm run collector -- scan
npm run collector -- register
npm run collector -- sync
npm run collector -- export-identity
npm run collector -- import-identity --file identity.json
```

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

## API Surface

Source of truth: `src/backend/server.js`.

Current routes:

```text
POST /api/devices/register
POST /api/usage/daily-batch
POST /api/admin/recalculate-costs
POST /api/admin/model-prices/refresh-openrouter
GET  /api/model-prices
GET  /api/admin/model-prices
POST /api/admin/model-prices
POST /api/admin/model-price-aliases
DELETE /api/admin/model-price-aliases/:model
DELETE /api/admin/model-prices/:model
DELETE /api/admin/participants/:participantId
GET  /api/leaderboard
GET  /api/public-leaderboard
GET  /api/admin/usage
GET  /api/admin/quality
GET  /api/participants/:participantId
GET  /api/participants/:participantId/trend
GET  /api/health
GET  /api/release/config
GET  /api/release/latest
```

Do not document `/api/usage/upload` as current unless the server route is restored. The active upload route is `/api/usage/daily-batch`.

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

Run backend/Web with MySQL:

```bash
docker compose -f docker-compose.mysql.example.yml up --build -d
```

The compose file reads `env.local` by default. Use `ENV_FILE=env.test` for `ai_token_league`. Both env files set `TZ=Asia/Shanghai` so daily rankings use the business day instead of UTC.

See `doc/test-deployment.md`.

## Verification Baseline

Use the smallest verification that covers the touched surface:

- README or docs only: inspect rendered Markdown-sensitive links and run `git diff --check`.
- Backend API or store changes: run `npm test` and relevant smoke/API checks.
- Desktop UI changes: run `node --check src/desktop/main.cjs`, `node --check src/desktop/renderer.js`, `npm test`, and `npm run desktop:smoke`.
- Packaging changes: run `npm run package:all` after tests, then follow `doc/packaging.md`.
- MySQL storage changes: run JSON tests plus the Docker/MySQL path in `doc/test-deployment.md` when feasible.

Smoke checklist: `doc/smoke-checklist.md`.

## Documentation Rules

- Keep `README.md` optimized for GitHub discovery, product positioning, privacy model, and quick start.
- Put development commands, route details, storage details, and verification workflow in this file.
- Treat the highest implemented `doc/<version>-baseline.md` as the current product baseline. As of 2026-05-07, that is `doc/0.4-baseline.md`.
- Treat the highest planned `doc/<version>-baseline.md` plus `doc/<version>-development-tasks.md` pair as the active next-version plan. As of 2026-05-07, that is `0.5`.
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
- Windows is initially verified and usable, but not yet fully tested.
