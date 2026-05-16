**目标**
将 AI Token League 客户端采集运行时完整迁移到 Rust 独立可执行文件，并移除桌面端和 CLI 对用户机器 Node.js / npm / npx 的运行依赖。迁移完成后，Tauri 桌面端内置并调用 Rust collector binary，CLI 入口也由同一个 binary 承接；现有 Node collector、Node sidecar、Node CLI 和用户侧 Node 环境要求全部退出主线。

本次是独立重构任务，不作为 0.7 UI baseline 的补充项处理。

**成功标准**
迁移完成后，客户端必须满足：

- 用户安装桌面 App 后即可本地采集、查看、同步，不需要预装 Node.js。
- CLI 用户可以直接运行发布的 `atl-collector` 或等价二进制，不需要 `npm install`、`npm run collector`、`node src/collector/cli.js`。
- Tauri 桌面端不再启动 `src/desktop/sidecar.cjs`，也不再通过系统 `node` 运行任何采集、同步、配置、诊断或托盘数据逻辑。
- Codex、Claude Code、Cursor 三类来源扫描结果与当前 Node collector 的真实统计口径一致。
- 本地采集事实粒度从 day 下沉到 day + hour，支持后续统计每日工作时间段。
- `totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens` 规则不变。
- reasoning tokens 继续只作为诊断或成本相关字段，不进入主排名 total。
- 本地配置、身份、usage cache、sync manifest、upload queue、diagnostics export 的隐私边界不放宽。
- 上传签名协议、snapshot sync 语义、服务端入库规则和排行榜 truth 不因运行时迁移改变。
- 服务端新增 hourly fact table，保留 daily serving table；老客户端 daily 上报继续可用，新 Rust 客户端 hourly 上报由服务端派生 daily。
- 桌面 Overview、Workdirs、Sources、Settings、tray/menu bar、background scan、manual sync、offline queue、diagnostics、import/export、reset 行为不降级。
- 打包产物内置目标平台 collector binary；macOS、Windows、Linux 分发包均不要求用户安装 Node。
- 文档、README、packaging、operations、smoke checklist 不再把 Node.js 描述为客户端运行前置条件。

**迁移边界**
本次重构只替换客户端采集运行时和客户端命令入口，不改变后端业务 API、数据库结构、公开 Web 排行榜、Admin 管理台、OpenRouter 价格刷新逻辑和服务端 Node.js 运行方式。

客户端主线不考虑旧 Node 运行路径回退兼容。迁移完成后，主线只保留 Rust collector 客户端路径；旧 Node collector 可以在迁移阶段作为对照 oracle 使用，但不能作为发布运行路径保留。

服务端需要兼容老版本 daily 上报。兼容边界只保留在服务端 ingestion 层：老客户端继续写 daily，新的 Rust 客户端写 hourly，服务端用 hourly 派生 daily。客户端侧不因此保留 Node collector。

服务端仍然可以继续使用 Node.js。这里要移除的是用户客户端侧 Node 依赖，不是重写 backend。

**最终架构**

```text
Tauri Desktop
  -> bundled atl-collector executable
      -> scan local providers
      -> produce hourly usage facts
      -> maintain config/cache/hourly manifest/queue
      -> sign usage payload
      -> sync to app server

CLI
  -> atl-collector
      -> init / health / status / scan / sync / export-identity / import-identity
```

Rust workspace 建议拆分为：

- `collector-core`: provider 扫描、路径发现、token 聚合、schema、签名 payload、sync manifest、queue、diagnostics 等核心库。
- `atl-collector`: CLI + desktop sidecar protocol executable。
- `src-tauri`: 只负责 UI、窗口、托盘、系统对话框、更新、调用 bundled collector，不承载采集业务真逻辑。

**服务端 hourly 方案**
采用方案 C：新增 hourly fact table，保留 daily serving table。

```text
legacy daily client
  -> daily snapshot / daily batch
  -> usage_daily

new Rust client
  -> hourly snapshot
  -> usage_hourly
  -> derive affected usage_daily buckets
```

服务端规则：

- `usage_daily` 继续作为 public leaderboard、participant detail、Admin daily/week/month 查询的 serving table。
- 新增 `usage_hourly` 存储小时事实，字段至少包含 `day`、`hour`、`participantId`、`deviceId`、`toolCode`、`providerId`、`workdirHash`、`workdirDisplayName`、`model`、token fields、quality fields、source fingerprint。
- snapshot 协议支持 legacy `device_day_provider` 和新 `device_day_hour_provider` 或等价 hourly mode。
- 新 hourly snapshot 写入后，服务端只重算受影响的 `participantId + deviceId + day + providerId` daily bucket。
- 同一 bucket 同时存在 legacy daily 和 hourly-derived daily 时，hourly-derived daily 优先；legacy daily 不得覆盖已经由 hourly 派生的 daily。
- bucket metadata 需要记录 granularity：`daily` 或 `hourly`，并能标识 daily row 是否由 hourly 派生。
- hourly replace 删除范围必须限定在 `participantId + deviceId + day + hour + providerId`，不得跨 hour、跨 provider、跨 device 删除。
- 服务端后续新增工作时间段统计 API 时读取 `usage_hourly`，现有排行榜不直接扫 hourly。

该方案的目标是让老客户端 daily 上报继续可用，同时为新客户端提供跨设备、云端、Admin 和未来公开详情所需的小时维度事实源。

**必须删除或替换的 Node 客户端资产**
迁移完成后，以下内容不能继续作为主线客户端能力存在：

- `src/collector/cli.js`
- `src/collector/core.js`
- `src/collector/config.js`
- `src/collector/providers/*.js`
- `src/desktop/sidecar.cjs`
- Tauri 中的 `resolve_node_path()`
- Tauri 中的 Node.js pre-check 和 “Please install Node.js” 弹窗
- Tauri 打包资源中的 `src/desktop/sidecar.cjs`
- Tauri 打包资源中的 Node collector/shared JS 运行时依赖
- `npm run collector`
- `npm run collector:init`
- `npm run collector:scan`
- `npm run collector:sync`
- 客户端文档中的 Node.js 安装前置条件
- 客户端发布验证中的 `node --check src/desktop/sidecar.cjs`

允许保留的 Node 范围：

- backend server。
- Web/admin 构建或测试脚本。
- 发布脚本内部工具链，只要不要求最终用户安装 Node。
- 迁移阶段用于 golden comparison 的 Node collector 测试夹具；完成后应删除或降级为历史样本，不进入运行路径。

**推荐实现路径**
1. 新建 Rust collector workspace，先建立 `collector-core` 和 `atl-collector` 空骨架。
2. 定义 desktop 与 collector 的 JSON command protocol，覆盖 config、health、scan、sync、queue、diagnostics、identity import/export、tray menu data。
3. 迁移 shared token/schema/date/display 中影响采集 truth 的规则到 Rust，先锁定 `totalTokens`、provider id、hourly usage key、snapshot fingerprint、签名 payload。
4. 迁移本地存储路径和文件模型：`config.json`、hourly `usage-cache.json`、hourly `sync-manifest.json`、`upload-queue.json`、`runtime-log.jsonl`。
5. 迁移 Codex local provider，并用同一份真实样本做 Node/Rust 对照。
6. 迁移 Claude Code local provider，并用 `ccusage` / `@ccusage/codex` 验证器继续校验关键 token 字段。
7. 迁移 Cursor dashboard usage provider，保持 token 不落日志、不进 diagnostics、不上传。
8. 将本地聚合事实下沉为 day + hour；没有可靠时间戳的来源必须标记 `hourQuality` 或等价质量字段，不得伪造精确小时。
9. 迁移 signed hourly snapshot sync、dirty hourly bucket、full-resync、offline queue drain。
10. 新增服务端 `usage_hourly`、hourly bucket metadata、hourly snapshot 校验和 hourly -> daily 派生逻辑；保留 legacy daily ingestion。
11. 将 Tauri `forward_to_sidecar` 改为调用 bundled `atl-collector`，移除系统 Node 查找和 Node sidecar 启动。
12. 将 desktop tray/menu bar、background scan、manual sync、diagnostics export、config import/export 全部接到 Rust collector protocol。
13. 将 CLI 文档和命令入口切到 `atl-collector`，删除 Node CLI scripts。
14. 更新 Tauri bundle 配置，把目标平台 `atl-collector` 作为 external binary/resource 打进安装包。
15. 更新 release、packaging、README、operations、smoke checklist，移除客户端 Node 前置条件。
16. 完成 Node collector 删除，确保主线没有客户端运行路径再依赖 `node`。

**验收验证**
必须至少完成：

- Rust collector 单元测试覆盖 token total、hourly usage key、snapshot fingerprint、签名 payload、queue、manifest。
- 本地 usage cache 的事实粒度包含 day + hour；桌面 today / 7d / 30d 视图能从 hourly rows 聚合回现有 daily 展示。
- 同一份 Codex、Claude Code、Cursor 样本下，Rust collector 输出与当前 Node collector golden output 一致。
- 服务端 legacy daily payload 仍能写入 `usage_daily`。
- 服务端 hourly payload 能写入 `usage_hourly`，并派生同 bucket 的 `usage_daily`。
- 同一 `participantId + deviceId + day + providerId` 同时存在 legacy daily 和 hourly-derived daily 时，hourly-derived daily 优先，legacy daily 不覆盖新事实。
- hourly snapshot replace 不跨 hour、provider、device 删除。
- 24 小时 hourly rows 聚合后的 daily total 与排行榜读取的 daily total 一致。
- `atl-collector init / health / status / scan / sync / export-identity / import-identity` 可直接运行，不依赖 npm。
- 桌面端在没有系统 Node 的环境中可以启动、扫描、同步、导出诊断、导入导出身份和配置。
- Tauri dev 启动验证通过。
- Tauri 当前平台 build 验证通过。
- 当前平台安装包启动验证通过，并确认安装包内包含 `atl-collector`。
- macOS、Windows 至少各完成一次真实安装或等价 smoke，确认不安装 Node 也能完成扫描和同步。
- diagnostics export 不包含 prompt、assistant response、source code、真实绝对路径、Cursor session token、identity private key。
- 文档检索不再出现“客户端需要 Node.js 才能运行”的说明。

**一句话版本**
将 AI Token League 客户端采集能力从 Node sidecar / Node CLI 完整迁移为 Rust 独立 collector binary，将本地采集事实粒度下沉到 day + hour，并通过服务端 `usage_hourly` + `usage_daily` 双表兼容 legacy daily 上报、支撑后续工作时间段统计，同时删除所有用户客户端侧 Node 运行依赖。
