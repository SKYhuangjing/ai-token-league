# 更新日志 [English](CHANGELOG.md) · 简体中文

本文件记录 AI Token League 的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)。

---

## [0.5.0] - 2026-05-07

### 新增

- 新增 Admin 路由 HTTP Basic Auth 保护（`/admin.html` 和 `/api/admin/*`），通过 `ADMIN_USERNAME` + `ADMIN_PASSWORD` 环境变量配置。
- 新增 `MIN_CLIENT_ENFORCE` 最低客户端版本强制升级，启用后阻止过旧版本上传。
- 新增 Admin 设备面板，展示每个参与者的注册设备。
- 新增多语言（i18n）支持，覆盖桌面端和 Web UI。
- 新增 Admin Usage 行级详情语义优化。
- 新增 Desktop 设置页信息架构重构：Profile、App、Sources、Cloud、About。
- 新增 Admin 模型价格页缓存读取价格展示。
- 新增 Missing Price 任务点击联动，可自动填充并聚焦模型价格输入框。
- 新增 `scripts/bump-version.js` 和 `npm run bump -- <version>`，用于发布版本号集中升级。
- 新增 `scripts/start-server.sh`，支持 env 选择、smoke、后台运行、log 和 pid 参数。

### 变更

- Desktop Settings > App 只承载语言、显示预估成本、显示原始令牌数和登录时启动。
- Desktop Settings > Sources 承载本地来源、Cursor token、workdir aliases 和本地来源扫描周期。
- Desktop Settings > Cloud 承载 API base URL、云端状态、手动同步入口和同步状态。
- Desktop Settings > About 承载版本状态、更新策略、诊断导出和重置本地数据。
- 来源扫描周期明确为本地数据源扫描频率；配置云端后，同一周期会在扫描后上传每日汇总。
- Public Web 头部和下载控件压缩高度，为排行榜表格释放更多首屏空间。
- Public Web 下载区保留平台选择和下载按钮，删除冗余的“下载客户端”标题文案。
- Admin 语言切换器移动到 masthead，并在桌面布局右对齐。
- Desktop 语言切换器移动到 Settings > App，与应用偏好同组。
- Admin 模型价格列表为 Custom prices 和 OpenRouter cache 展示 input、output 和 cache read 价格。
- 本版本新增和调整的 Desktop / Web 文案继续统一走 `src/shared/i18n.js`。

### 文档

- 更新 `doc/0.5-baseline.md`，记录完整 0.5.0 产品基线和临时功能入账。
- 更新 `doc/0.5-development-tasks.md`，记录 Epic 1 到 Epic 10 的任务状态和验收标准。
- 更新发布版本流程文档，记录 `npm run bump`。
- 更新本地开发启动说明，记录 `scripts/start-server.sh`。

### 验证覆盖

- Admin Basic Auth 的 401/200 行为和公开路由不受影响。
- `MIN_CLIENT_ENFORCE` 的强制阻断和默认不阻断行为。
- Admin devices 路由和面板展示。
- Public Web、Admin、Desktop 的中英文切换。
- Admin Usage 行点击绑定当前时间桶的语义。
- Desktop Settings tab 职责划分和来源扫描周期 tooltip 语义。
- Model Price 缓存读取价格展示和 Missing Price 填表交互。
- Public 下载控件和语言切换器位置。
- 版本 bump 脚本语法和版本真源规则。
- 本地服务启动脚本语法和参数面。

---

## [0.4.0] - 2026-05-06

### 新增

- 新增桌面端首次启动向导，将静默初始化改为身份、隐私、数据来源、云端连接和启动确认的明确流程。
- 新增 CLI 交互式初始化：当本地没有配置且未传入 `--nickname` 时，引导用户完成昵称、来源检测和 API 地址配置。
- 新增桌面端完整配置导出/导入，同时继续兼容旧的 identity-only profile 文件。
- 新增本地运行日志和 Settings > App 中的脱敏诊断包导出。
- 新增 Admin 单用户服务端数据重置：`DELETE /api/admin/participants/:participantId` 会清理 participant、device、workdir、usage 和 upload batch dedupe，使修正后的客户端可以重新同步同一批聚合事实。
- 新增 Admin 模型价格显式映射：
  - `POST /api/admin/model-price-aliases`
  - `DELETE /api/admin/model-price-aliases/:model`
- 新增 MySQL `model_price_aliases` 持久化。
- 新增 macOS / Windows zip 包下载校验后的重启升级能力。
- 新增桌面端静默更新模式：
  - `notify`
  - `auto_download`
  - `auto_apply_on_idle`
- 新增原生安装包构建：
  - macOS Apple silicon DMG
  - macOS Intel DMG
  - Windows x64 NSIS installer
- 新增 release manifest 中的安装包元数据。
- 新增 Web 下载面板对安装包链接的优先展示。

### 变更

- Cursor dashboard 的 `default`、`auto` 和空模型名统一展示为 `Auto`。
- Cursor `Premium (...)` 模型名保持原始展示和上传，不再被隐式改写。
- 成本估算不再硬编码猜测 `Premium (...)` 或 `Codex x.y` 对应的计费模型；缺价模型必须由 Admin 显式配置 alias。
- Settings > App 统一承载诊断导出和更新控制。
- 支持 zip 升级包时，用户不再需要手动打开 Finder 或文件管理器替换应用文件。
- 发布脚本支持把原生安装包和 zip 包一起纳入 manifest 与上传计划。
- `release:publish` 会先构建发布产物，再执行上传。

### 修复

- Admin 单用户重置会同时清理 upload-batch dedupe，避免删除 usage 后同一客户端重传仍被判重。
- 删除自定义价格目标时，会同步移除指向该目标的 alias 并重算成本。
- 静默更新自动应用前会检查安全空闲窗口，避免在前台扫描、同步、诊断导出、配置导入导出、身份导入导出或其他更新操作期间替换应用。

### 文档

- 新增 `doc/0.4-baseline.md`。
- 新增 `doc/0.4-development-tasks.md`。
- 更新 `doc/packaging.md`，补充原生安装包构建、发布和验证步骤。
- 更新 `doc/roadmap.md` 中 0.4.0 的落地状态。
- 更新 MySQL 初始化迁移，加入 `model_price_aliases`。

### 验证覆盖

- 单用户重置后，同一客户端 payload 可以再次同步成功。
- Cursor `Auto` 展示规则。
- Cursor `Premium (...)` 展示保留规则。
- 未配置 alias 时不做隐式 Premium/Codex 成本映射。
- 配置 alias 后使用目标模型计费，并保留原始展示模型。
- 静默更新模式归一化和状态机行为。
- 原生安装包 manifest 兼容性。

---

## [0.3.0] - 2026-05-06

### 新增

- 新增 app version、client protocol version、server version 和 provider/parser version 的分层模型。
- 注册、健康检查和日用量批量上传新增客户端元数据：
  - `clientAppVersion`
  - `clientProtocolVersion`
  - `clientPlatform`
  - `clientBuild`
- 新增服务端兼容性响应，暴露当前版本、最新版本和 protocol 支持范围。
- 新增 Desktop 和 CLI 中的本地版本、服务端版本、最新版本和兼容状态展示。
- 新增 update manifest schema 和 checksum 校验工具。
- 新增基于 OSS 的发布脚本。
- 新增 `/api/release/latest` 和 `/api/release/config` 发布元数据接口。
- 新增 Public Web 客户端下载入口，覆盖 macOS Apple silicon、macOS Intel 和 Windows x64。
- 新增 macOS Intel x64 桌面包构建支持。
- 新增 release zip checksum 生成。

### 变更

- Settings 重组为 Account、Sources、Cloud、Sync 和 App，更清晰地区分本地配置、云端连接、同步和应用更新。
- Cloud Connection 成为 API target、服务端兼容性、release config、pricing 和 update check 的单一来源。
- Sync 不再拥有全局 API base URL。
- 桌面端 update check 不再读取本机 release env 兜底值。
- Public Web 下载链接只通过 app-server release API 获取，不在前端写死 OSS 信息。
- 桌面包排除本地 env、文档、测试、Docker 资产、backend/Web server 资产、历史发布产物和发布脚本。

### 修复

- 不兼容 client/server 的上传会被阻断，但不会删除本地 upload queue。
- 更新下载或 checksum 校验失败时，当前客户端仍可用，并保留 identity、config、tokens、aliases、cache 和 upload queue。
- Cursor 首装状态区分“本地检测到账号”“手动配置 token”和“未检测到账号”。
- Cursor 来源文案不再误导用户以为只有手动保存 token 才算检测到账号。

### 文档

- 新增 `doc/0.3-baseline.md`。
- 新增 `doc/0.3-development-tasks.md`。
- 更新 packaging、smoke、deployment、README 和 roadmap 文档，记录 0.3 发布/更新流程。
- `env.example` 新增 release 相关占位配置。

### 验证覆盖

- 当前、旧版、未来版、缺失和 malformed 客户端 metadata 的兼容性矩阵。
- 注册、上传和 health 的版本 metadata 行为。
- 不支持平台、缺失 checksum 和错误 checksum 的 manifest 校验。
- 发布顺序校验：先上传 versioned artifact，最后发布 manifest/latest。
- Desktop version/update UI 的 smoke 覆盖。
- macOS arm64、macOS x64 和 Windows x64 包版本与 checksum 覆盖。

---

## [0.2.0] - 2026-04-30

### 新增

- 新增桌面端同步状态和更安全的后台刷新控制。
- 新增基于 env 的 MySQL 测试部署支持，包括 Docker Compose 启动和部署配置文档。
- 新增 0.2 桌面基线，包含应用图标、桌面资源和打包文档。
- 新增 Cursor dashboard 多 token 处理：modal 输入、本地格式校验、去重和账号摘要展示。
- 新增 Codex、Claude Code 和 Cursor 的 Sources 卡片式启停管理。
- 新增 token 组成设计和 cache token 归一化规则。
- 新增 OpenRouter 模型价格刷新和 token 组成成本计算。
- 新增模型价格管理、缺价展示和成本重算能力。
- 新增 Web 和桌面端 token bucket、估算成本、模型/workdir 组成和价格质量展示。
- 新增 `AGENTS.md`，记录项目指令、命令、API、存储路径和验证规则。

### 变更

- 活跃上传 API 从 v0.1 的 `/api/usage/upload` 收敛为 `POST /api/usage/daily-batch`。
- 排行口径定义为 `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`，reasoning tokens 保留为诊断/成本字段。
- Codex 和 Claude Code 在采集阶段将 input tokens 归一化为 raw input 扣除 cache read/write 后的非 cache input。
- Cursor dashboard usage 保持 Cursor API 原始定义，不套用本地 input 归一化规则。
- Cursor 配置合并到 Sources 卡片，不再保留独立的 Cursor dashboard settings block。
- 来源 On/Off 只作为配置动作，不触发立即扫描，也不调用 Cursor dashboard API。
- README 更新为更适合 GitHub 展示的产品定位、隐私模型、支持来源和桌面打包状态。

### 修复

- 修复桌面端首次启动扫描流程，减少初始化时不必要的 scan/config 阻塞。
- 修复 Claude Code parser 在记录缺省模型字段时丢失前序模型名的问题。
- 本地 provider 文件解析改为 async I/O，降低大型 Codex/Claude Code 扫描导致 UI 卡顿的风险。
- 修复 token composition denominator，避免 cache-inclusive 总数下出现不可能的组成百分比。
- 重新生成桌面和 Web favicon/app icon 资产。

### 文档

- 新增 `doc/0.2-baseline.md`。
- 新增 `doc/usage-composition-design.md`。
- 新增 `doc/openrouter-pricing-design.md`。
- 更新 `doc/packaging.md`、`doc/test-deployment.md`、`doc/product-design.md` 和 `doc/mvp-development-tasks.md`。
- 新增 `doc/roadmap.md`。

### 验证覆盖

- Provider cache 归一化和 total-token 不变量。
- Cursor token 输入解析和账号摘要。
- Sources toggle 不触发强制扫描。
- OpenRouter 价格刷新、自定义价格和 missing-price quality。
- JSON 和 MySQL 的 usage/pricing 持久化路径。

---

## [0.1.0] - 2026-04-30

### 新增

- 建立 AI Token League MVP：本地优先的 AI 编程 token 用量采集器和公开排行榜。
- 新增本地采集来源：
  - Codex local session JSONL logs。
  - Claude Code local project logs。
  - 显式启用后的 Cursor dashboard usage。
- 新增匿名本地身份：`participantId`、`deviceId`、签名密钥、profile 导出和导入。
- 新增隐私友好的 workdir 处理：上传 `workdirHash`、展示名和 alias，不上传真实绝对路径。
- 新增签名 usage 上传和服务端 daily aggregate usage facts 存储。
- 新增 JSON backend storage 和初始 MySQL store/migration 路径。
- 新增 Public Web leaderboard、participant detail 和 trend API。
- 新增 Admin usage ranking 和 model price management 页面。
- 新增 Electron 桌面端 Today、Trend 和 Settings 页面。
- 新增 CLI init、scan、register、sync、profile export 和 profile import 命令。
- 新增 token、cost、date、display、schema 和 crypto shared helper。
- 新增 smoke、Node 测试、Docker deployment 示例和 sample usage data。
- 新增 macOS arm64 和 Windows x64 packaging 脚本与 zip 生成。

### 变更

- 明确核心隐私边界：服务端不得接收 prompts、assistant responses、source code、full transcripts、real absolute paths、Cursor session tokens 或 identity private keys。
- 定义 `totalTokens` 为公开排行指标，estimated cost 只是辅助展示。
- Cursor dashboard usage 不提供本地项目路径，因此 Cursor workdir attribution 保持虚拟。
- 文档结构覆盖 product design、ER model、MVP task history、smoke checklist 和 test deployment。

### 验证

- macOS collector-to-Web flow 已本地验证。
- Backend smoke 已本地验证。
- Desktop smoke 已本地验证。
- macOS arm64 和 Windows x64 package 已生成。
- 0.1.0 基线时 Windows host E2E 仍待验证。

---

## 构建与发布工具

- 新增 `scripts/publish-release.js`，用于 release artifact 规划、checksum 生成、manifest 生成和 OSS 上传。
- 新增 `scripts/zip-dist.js`，用于桌面包 zip 生成。
- 新增 `electron-builder.yml`，用于原生 DMG/NSIS installer 构建。
- 新增 `release:build`、`release:dry-run`、`release:upload` 和 `release:publish` 脚本。
- 新增 macOS Intel packaging 脚本。
- 新增 `dist-installer/` 发布产物流。

## 升级说明

- 活跃上传接口保持为 `POST /api/usage/daily-batch`。
- 排行事实保持为 `totalTokens`，cost 仍是可选展示数据。
- 桌面端更新依赖 Cloud Connection，因为 update metadata 由 app-server 提供。
- 原生安装包用于分发；zip 包仍是 updater flow 的一部分。
- Admin model price alias 只影响成本计算，不改变 usage 中上传和展示的原始模型名。
- Admin participant reset 只删除服务端聚合数据，不删除用户本机 identity、本地 usage cache、upload queue、source config、Cursor token 或其他本机数据。
