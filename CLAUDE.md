# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Source of Truth

Read `AGENTS.md` before starting any work. It contains all project context: product summary, repository layout, commands, API surface, storage paths, verification baseline, and documentation rules.

## Quick Reference

- **Project**: AI Token League — local-first AI coding token usage collector + public leaderboard
- **Product baseline**: `0.7` | **Client version**: `0.7.1` (released 2026-05-24)
- **Frozen baseline**: `0.6` tracked in `doc/0.6-baseline.md` and `doc/0.6-development-tasks.md`
- **Active baseline**: `0.7` tracked in `doc/0.7-baseline.md` and `doc/0.7-development-tasks.md`
- **Default mode**: Engineering — implement, verify, deliver end to end

## Key Commands

```bash
npm install                         # Install dependencies
scripts/start-server.sh --env env.local  # Start backend + public web with env/port handling
npm test                            # Run tests
npm run smoke                       # Backend smoke test
npm run desktop                     # Launch Tauri desktop app (dev mode)
scripts/release.sh                  # Interactive release builder (version/platform/env/upload)
```

Use project scripts as the first-line operational interface: service startup goes through `scripts/start-server.sh`; packaging and release go through `scripts/release.sh`. Raw `npm start`, `npx tauri build`, and `npm run release:*` are low-level commands for focused verification or debugging.

Ordinary desktop UI and renderer changes use the dev loop (`node --check`, relevant tests, `npm run desktop`). Use `scripts/release.sh --platform current --env env.local --yes` only when validating packaged runtime behavior, bundled assets, presets, updater/release metadata, package-resource wiring, or install/download UX.

## Rules

- Do not send prompts, responses, source code, real paths, or private keys to the server.
- Cost is optional display — `totalTokens` is the ranking truth.
- If code and docs disagree, verify code first, then fix the docs.
- Keep `README.md` focused on GitHub discovery and quick start; put dev details in `AGENTS.md`.
