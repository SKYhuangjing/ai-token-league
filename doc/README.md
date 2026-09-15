# AI Token League Docs

This directory keeps the project documents after the v0.1 phase freeze.

## Current Baseline

- `0.7-baseline.md` - 0.7 desktop client UI redesign baseline (active).
- `0.7-development-tasks.md` - 0.7 complete implementation task plan and verification record.
- `0.6-baseline.md` - frozen 0.6 product baseline.
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
- `full-reconcile-design.md` - product and technical design for automatic server/local usage reconciliation, resumable full-history repair, and protocol compatibility.
- `openrouter-pricing-design.md` - development task baseline for DB-first OpenRouter pricing resolution.
- `mysql-request-local-write-lock-design.md` - long-term design for replacing global MySQL write locking with request-local writes and scoped locks.
- `web-performance-optimization-design.md` - 公开 Web 加载性能与展现优化设计：P0 传输层（gzip/缓存头/字体自托管）、P1 服务端取数与聚合缓存、P3 主题零重载与进场动效；读写分离拓扑与写路径明确不做。
- `compute-sharing-lanes-design.md` - 算力共享车道设计：多订阅切片（Gemini 周窗/智谱 5h 避峰/codex 全天）、车道绑定认领 Key（CPA 拦截点无 model 的 ABI 约束）、时段门控与周期预算、智谱接入 CPA 已验证配置。
- `mvp-development-tasks.md` - task execution history through E18.
- `er-diagram.md` - local and remote storage model diagrams.

## Operations

- `../AGENTS.md` - agent-facing project background, preferred command entrypoints, and full `scripts/` usage table.
- `operations.md` - 运维手册：服务端部署、下载通道配置、客户端预置配置。
- `cli.md` - CLI 终端使用手册：无界面场景下 `usage`/`config`/`roots`/`scan`/`sync` 命令参考、设置键表、cron 配方与隐私边界。
- `windows-network-check-report.md` - Windows 客户端云端不可达的网络检查报告、命令和现场回传模板。
- `test-deployment.md` - Docker + external MySQL test deployment notes.
- `smoke-checklist.md` - local MVP smoke checklist.
- `packaging.md` - desktop distribution build, verification, and launch checklist.
- `provider-integration-guide.md` - 新 provider（数据源）接入指南：调研问题清单、collector 实现契约、前端触点清单、测试矩阵、真库对账与打包陷阱。
- `../env.example` - committed Docker env template; local `env.local` and `env.test` are ignored secrets.

## Rule

New product baseline work must add a paired `doc/<baseline>-baseline.md` and `doc/<baseline>-development-tasks.md` instead of appending unrelated requirements to old baselines.

When a temporary feature is added during a version, record it in both the baseline and the task document before treating it as part of the release scope.
