# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Source of Truth

Read `AGENTS.md` before starting any work. It contains all project context: product summary, repository layout, commands, API surface, storage paths, verification baseline, and documentation rules.

## Quick Reference

- **Project**: AI Token League — local-first AI coding token usage collector + public leaderboard
- **Product baseline**: `0.5` | **Client version**: `0.5.3` (released 2026-05-09)
- **Next baseline**: `0.6` tracked in `doc/0.6-baseline.md` and `doc/0.6-development-tasks.md`
- **Default mode**: Engineering — implement, verify, deliver end to end

## Key Commands

```bash
npm install          # Install dependencies
npm start            # Start backend + public web (http://127.0.0.1:8787)
npm test             # Run tests
npm run smoke        # Backend smoke test
npm run desktop      # Launch Electron desktop app
npm run package:all  # Package desktop bundles
npm run release      # Interactive release builder (version/platform/env/installers/upload)
```

## Rules

- Do not send prompts, responses, source code, real paths, or private keys to the server.
- Cost is optional display — `totalTokens` is the ranking truth.
- If code and docs disagree, verify code first, then fix the docs.
- Keep `README.md` focused on GitHub discovery and quick start; put dev details in `AGENTS.md`.
