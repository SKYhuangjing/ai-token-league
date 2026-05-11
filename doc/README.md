# AI Token League Docs

This directory keeps the project documents after the v0.1 phase freeze.

## Current Baseline

- `0.6-baseline.md` - 0.6 product baseline (in progress).
- `0.6-development-tasks.md` - 0.6 development tasks and verification record.
- `0.5-baseline.md` - frozen 0.5 product baseline with 11 features.
- `0.5-development-tasks.md` - 0.5 development tasks and verification record.
- `0.4-baseline.md` - implemented 0.4 product baseline.
- `0.4-development-tasks.md` - 0.4 development tasks and verification record.
- `0.3-baseline.md` - implemented 0.3 client/server compatibility and update baseline.
- `0.3-development-tasks.md` - 0.3 development tasks and verification record.
- `0.2-baseline.md` - implemented 0.2 desktop/source baseline.
- `v0.1-baseline.md` - stable v0.1 product and engineering baseline.
- `product-design.md` - detailed product design history and decisions.
- `usage-composition-design.md` - product design and implementation task baseline for token/cost composition accounting.
- `openrouter-pricing-design.md` - development task baseline for DB-first OpenRouter pricing resolution.
- `mvp-development-tasks.md` - task execution history through E18.
- `er-diagram.md` - local and remote storage model diagrams.

## Operations

- `../AGENTS.md` - agent-facing project background, preferred command entrypoints, and full `scripts/` usage table.
- `operations.md` - 运维手册：服务端部署、下载通道配置、客户端预置配置。
- `test-deployment.md` - Docker + external MySQL test deployment notes.
- `smoke-checklist.md` - local MVP smoke checklist.
- `packaging.md` - desktop distribution build, verification, and launch checklist.
- `../env.example` - committed Docker env template; local `env.local` and `env.test` are ignored secrets.

## Rule

New product baseline work must add a paired `doc/<baseline>-baseline.md` and `doc/<baseline>-development-tasks.md` instead of appending unrelated requirements to old baselines.

When a temporary feature is added during a version, record it in both the baseline and the task document before treating it as part of the release scope.
