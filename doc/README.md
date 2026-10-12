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
- [compute-sharing-usability-design.md](compute-sharing-usability-design.md) - 算力共享改造设计与研发交接（2026-09-20）：控制语义、额度口径、首次接入、错误恢复、信任说明；含任务卡、16 项验收场景、发布回滚要求与研发实施记录。
- [compute-sharing-acceptance-20260920.md](compute-sharing-acceptance-20260920.md) - 第一轮独立验收：固定 eeb5773 及研发补丁，原有回归通过，追加探针确认 7 组缺陷；结论不通过，含证据、逐项判定与返工分派表。
- [compute-sharing-acceptance-20260921.md](compute-sharing-acceptance-20260921.md) - 第二轮独立验收：固定 58409fd，复核已修复项及剩余 8 组缺陷（5 P1 / 3 P2）；含真实 HTTP/进程恢复/并发存储探针、交互复验和返工任务。
- [compute-sharing-review-20260921-r3.md](compute-sharing-review-20260921-r3.md) - 第三轮 Review 与直接修复：基于 878872d，14 组问题修复、147 E2E、持久化/并发探针、有限只读盲评及原生验证；生产部署边界单列。
- [compute-sharing-acceptance-20260922.md](compute-sharing-acceptance-20260922.md) - 同环境分享认领实链验收、MySQL 去重基线漏写修复、候选产物与生产放行条件。
- [compute-sharing-rollout-20260921-r3.md](compute-sharing-rollout-20260921-r3.md) - R3 发布跟踪：在线卡片 0.1.3、CPA 0.5.3、App/CLI 0.7.17，实际加载路径、线上哈希、原生复验与回滚边界。
- `compute-sharing-lanes-design.md` - 算力共享车道设计与历史决策：多订阅切片、车道绑定认领 Key、模型范围校验、时段门控与周期预算；当前体验改造及计量升级以本轮 usability design 为准。
- `compute-sharing-directory-product.md` - 算力共享借用目录规模化产品方案：可用性分层排序、模型过滤 chips、借用方认领上限、节点折叠与验收标准（含开放决策点）。
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

## Designs

- [dsh-local-provider-design.md](dsh-local-provider-design.md) - `dsh_local` provider 设计：DeepSeek Harness 多帧 zstd JSONL 解析、token 口径与测试矩阵。
- [kimi-local-provider-design.md](kimi-local-provider-design.md) - `kimi_local` provider 设计：daimon kernel `wire.jsonl` usage 记录扫描与边界。
- [antigravity-local-provider-design.md](antigravity-local-provider-design.md) - `antigravity_local` provider 设计：Antigravity 会话 SQLite/protobuf 解析、去重与对账边界。
- [workbuddy-local-provider-design.md](workbuddy-local-provider-design.md) - `workbuddy_local` provider 设计：trace JSON generation span 的 per-request token 提取。
- [sync-status-product-technical-design.md](sync-status-product-technical-design.md) - 数据同步状态的产品语义与技术实现方案。
- [share-design-plan.md](share-design-plan.md) - 分享数据图（share card）设计方案。
- [theme-color-schemes.md](theme-color-schemes.md) - 主题色方案对照与选型。
- [backend_multi_device_cursor_cloud_dedup_design.md](backend_multi_device_cursor_cloud_dedup_design.md) - 多设备 Cursor 云端用量去重设计。
- [plugin-platform.md](plugin-platform.md) - 插件平台 P0–P3 目标规划。
- [web-ui-optimization-prompt.md](web-ui-optimization-prompt.md) - Web UI 优化提升 prompt（2026-09 版）。

## Handoffs and Historical Records

- [compute-sharing.md](compute-sharing.md) - 算力共享 `feat/compute-sharing` 分支总览（历史起点，当前设计以 usability design 为准）。
- [compute-sharing-handoff.md](compute-sharing-handoff.md) - 算力共享研发 Handoff（持续迭代记录）。
- [HANDOFF-cursor-dashboard-auth-hardening.md](HANDOFF-cursor-dashboard-auth-hardening.md) - Cursor 采集断流根因、修复与交接状态。
- [handoff-config-crash-recovery.md](handoff-config-crash-recovery.md) - 防止 Windows 重启后引导页重现的修复交接。
- [handoff-device-aware-cloud-delete.md](handoff-device-aware-cloud-delete.md) - 设备感知的云端数据删除设计交接。
- [handoff-restart-update-fix.md](handoff-restart-update-fix.md) - 「重启更新」按钮无法点击问题的修复交接。
- [mysql-data-loss-handoff-2026-05-25.md](mysql-data-loss-handoff-2026-05-25.md) - MySQL 数据丢失事故修复 handoff 与复盘。
- [test-coverage-handoff-2026-05-24.md](test-coverage-handoff-2026-05-24.md) - 测试覆盖提升交接记录。
- [test-infra-handoff.md](test-infra-handoff.md) - 测试基础设施独立评审交接。
- [node-free-runtime-refactor.md](node-free-runtime-refactor.md) - Node-free 运行时重构方案（历史方案记录）。
- [tauri-refactor.md](tauri-refactor.md) - Tauri 化重构方案（历史方案记录）。
- [performance-risk-review.md](performance-risk-review.md) - 性能风险评审记录。
- [refatcor_sync_status.md](refatcor_sync_status.md) - 统一云端同步状态类型定义的早期 plan（文件名拼写错误保留原样，避免链接失效）。
- [ui-test-plan.md](ui-test-plan.md) - UI 测试开发计划。
- [ui-ux-expert-guidelines.md](ui-ux-expert-guidelines.md) - UI/UX 专家评审 guidelines。
- [demos/data-value-real-experiment-HANDOFF.md](demos/data-value-real-experiment-HANDOFF.md) - 真实数据价值 UI 实验 handoff。

## Rule

New product baseline work must add a paired `doc/<baseline>-baseline.md` and `doc/<baseline>-development-tasks.md` instead of appending unrelated requirements to old baselines.

When a temporary feature is added during a version, record it in both the baseline and the task document before treating it as part of the release scope.
