# AI Token League

面向 Codex、Claude Code 和 Cursor 的本地优先 AI 编程 token 用量采集器与公开排行榜。

Local-first AI coding token usage tracker and public leaderboard for Codex, Claude Code, and Cursor.

AI Token League 用来回答一个很直接的问题：团队或社区里，谁在用 AI 编程工具，用了多少 token，分布在哪些模型、项目和日期上。同时，它不会上传 prompt、回答内容、源码、完整会话、真实绝对路径或身份私钥。

AI Token League helps a team or community answer a simple question: who is using AI coding tools the most, across which models, projects, and days, without uploading prompts, responses, source code, transcripts, real absolute paths, or private identity keys.

关键词 / Keywords: AI token tracker, AI coding leaderboard, Codex usage tracker, Claude Code usage tracker, Cursor usage dashboard, LLM token analytics, token cost analytics, OpenRouter pricing, Electron desktop collector, local-first usage collector, AI 编程用量统计, token 排行榜, AI 编程排行榜.

当前基线 / Current baseline: `0.2`, frozen on `2026-04-30`.

## 为什么需要它 / Why This Exists

AI 编程工具已经进入日常工程流程，但用量视图是分散的：

AI coding tools are now part of daily engineering work, but usage visibility is scattered:

- Codex 和 Claude Code 把会话用量留在本地日志中。 / Codex and Claude Code keep local session logs.
- Cursor 提供 dashboard 用量，但不提供本地项目路径。 / Cursor exposes dashboard usage, but not local project paths.
- 模型成本取决于模型价格、cache token 和 provider 字段。 / Model cost depends on model pricing, cache tokens, and provider-specific fields.
- 社区排行榜需要公开聚合数据，而不是私密对话。 / Community ranking needs public aggregates, not private conversations.

AI Token League 会把本地 usage fact 转成隐私友好的排行榜：

AI Token League turns local usage facts into a privacy-preserving leaderboard:

- 本地采集支持的 AI 编程工具用量。 / Collect usage locally from supported AI coding tools.
- 归一化 input、output、cache read、cache write、reasoning 和 total tokens。 / Normalize input, output, cache read, cache write, reasoning, and total tokens.
- 上传带签名的聚合 usage batch。 / Upload signed aggregate usage batches.
- 按今天、昨天、本周、上周、本月、上月等范围排行。 / Rank participants across today, yesterday, week, and month ranges.
- 可选展示基于自定义价格和 OpenRouter cache 的估算成本。 / Optionally show estimated cost using custom prices and OpenRouter pricing cache.

## 功能 / Features

- **公开排行榜 / Public leaderboard**：展示 AI 编程 token 用量排名。
- **桌面采集器 / Desktop collector UI**：Electron 桌面端。
- **命令行采集器 / CLI collector**：支持初始化、扫描、同步、身份导出和导入。
- **Provider 化采集 / Provider-based collection**：支持 Codex、Claude Code 和 Cursor。
- **隐私友好的工作目录展示 / Privacy-preserving workdir display**：使用 hash 和 alias，不上传真实绝对路径。
- **签名上传 / Signed uploads**：基于 `participantId + deviceId + identityKey`。
- **Token 组成分析 / Token composition**：input、output、cache read、cache write、reasoning、total tokens。
- **估算成本展示 / Estimated cost display**：支持自定义模型价格和 OpenRouter 价格 cache。
- **管理员视图 / Admin usage view**：支持排行、日期范围、participant 筛选和模型价格管理。
- **JSON 或 MySQL 存储 / JSON or MySQL backend storage**：适合本地演示和测试部署。
- **桌面打包 / Desktop bundles**：支持 macOS arm64 和 Windows x64 Electron 包。

## 支持的数据来源 / Supported Sources

| 来源 / Source | Provider ID | 状态 / Status | 说明 / Notes |
| --- | --- | --- | --- |
| Codex | `codex_local` | 支持 / Supported | 扫描本地 Codex session JSONL 日志。 / Scans local Codex session JSONL logs. |
| Claude Code | `claude_code_local` | 支持 / Supported | 扫描本地 Claude Code 项目日志。 / Scans local Claude Code project logs. |
| Cursor | `cursor_dashboard_usage` | 显式启用后支持 / Supported when enabled | 使用 Cursor dashboard usage API；Cursor 不提供真实项目路径。 / Uses Cursor dashboard usage API; Cursor does not expose real project paths. |

## 隐私模型 / Privacy Model

服务端只接收聚合 usage facts。它不应接收：

The server receives aggregate usage facts only. It must not receive:

- prompts
- assistant responses
- source code
- full transcripts
- real absolute paths
- Cursor session tokens
- identity private keys

工作目录排行使用隐私友好的 hash 加公开展示名或 alias。Cursor usage 会显示为 `Cursor` 或 `Cursor · <account>`，因为 Cursor dashboard API 不提供项目路径。

Workdir ranking uses a privacy-preserving hash plus a public display name or alias. Cursor usage is shown as `Cursor` or `Cursor · <account>` because the Cursor dashboard API does not provide project paths.

## 界面 / Screens

当前包含：

AI Token League currently includes:

- Public Web leaderboard / 公开 Web 排行榜
- Participant detail and trend views / 参与者详情和趋势视图
- Admin usage ranking / 管理员用量排行
- Admin model price management / 管理员模型价格管理
- Desktop Today view / 桌面端今日视图
- Desktop Trend view / 桌面端趋势视图
- Desktop Settings for profile, sync, sources, aliases, display, and system options / 桌面端设置：身份、同步、来源、alias、展示和系统选项

## 快速开始 / Quick Start

要求 / Requirements:

```text
Node.js >= 22
```

安装依赖 / Install dependencies:

```bash
npm install
```

启动后端和公开 Web 排行榜 / Start the backend and public Web leaderboard:

```bash
npm start
```

打开 / Open:

```text
http://127.0.0.1:8787
```

初始化本地采集器 / Initialize the local collector:

```bash
npm run collector:init -- --nickname your-name --api http://127.0.0.1:8787
```

扫描本地用量 / Scan local usage:

```bash
npm run collector -- scan
```

上传用量 / Upload usage:

```bash
npm run collector -- sync
```

运行桌面采集器 / Run the desktop collector UI:

```bash
npm run desktop
```

## 桌面应用 / Desktop App

项目可以构建 macOS arm64 和 Windows x64 桌面包。macOS 已在本机完成 smoke test。Windows 已完成初步验证，可以使用，但还没有覆盖充分的 Windows 主机场景测试。

The project can build desktop bundles for macOS arm64 and Windows x64. macOS has been smoke-tested locally. Windows has passed initial verification and is usable, but has not yet been fully tested across Windows host scenarios.

开发命令、API 细节、存储说明和打包检查放在 [AGENTS.md](AGENTS.md)。

Developer commands, API details, storage notes, and packaging checks live in [AGENTS.md](AGENTS.md).

## 项目文档 / Project Docs

- [doc/0.2-baseline.md](doc/0.2-baseline.md) - 当前产品和发布基线。 / Current product and release baseline.
- [doc/v0.1-baseline.md](doc/v0.1-baseline.md) - 冻结的 v0.1 基线。 / Frozen v0.1 baseline.
- [doc/product-design.md](doc/product-design.md) - 产品设计历史。 / Product design history.
- [doc/mvp-development-tasks.md](doc/mvp-development-tasks.md) - MVP 任务执行历史。 / MVP task execution history.
- [doc/usage-composition-design.md](doc/usage-composition-design.md) - token 和成本组成设计。 / Token and cost composition design.
- [doc/openrouter-pricing-design.md](doc/openrouter-pricing-design.md) - OpenRouter 价格设计。 / OpenRouter pricing design.
- [doc/er-diagram.md](doc/er-diagram.md) - 本地和远程数据模型图。 / Local and remote data model diagrams.
- [doc/test-deployment.md](doc/test-deployment.md) - Docker 和 MySQL 测试部署。 / Docker and MySQL test deployment.
- [doc/packaging.md](doc/packaging.md) - 桌面打包和验证。 / Desktop packaging and verification.

## 当前限制 / Current Limits

- 暂不支持 hook-based live collection。 / No hook-based live collection yet.
- 暂无原生安装器。 / No native installer yet.
- token total 是主排行口径；cost 是可选展示，不是主排行依据。 / Token total is the primary ranking metric; cost is optional display, not the main ranking truth.
- Cursor dashboard usage 不提供本地工作目录归因。 / Cursor dashboard usage does not provide local workdir attribution.
- Windows 已初步验证可用，但尚未充分测试。 / Windows is initially verified and usable, but not yet fully tested.

## 推荐 GitHub Topics / Suggested GitHub Topics

```text
ai
llm
token-usage
token-tracker
coding-agent
codex
claude-code
cursor
leaderboard
electron
openrouter
analytics
local-first
privacy
```
