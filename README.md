# AI Token League [English](README.en.md) · 简体中文

[![GitHub release](https://img.shields.io/github/v/release/SKYhuangjing/ai-token-league?style=flat)](https://github.com/SKYhuangjing/ai-token-league/releases)
[![GitHub downloads](https://img.shields.io/github/downloads/SKYhuangjing/ai-token-league/total?style=flat&color=blue)](https://github.com/SKYhuangjing/ai-token-league/releases)
[![GitHub issues](https://img.shields.io/github/issues/SKYhuangjing/ai-token-league)](https://github.com/SKYhuangjing/ai-token-league/issues)

一款面向 **Codex**、**Claude Code** 和 **Cursor** 的本地优先 AI 编程 token 用量采集器与公开排行榜。

> AI Token League 用来回答一个直接的问题：团队或社区里，谁在使用 AI 编程工具、用了多少 token、分布在哪些模型、项目和日期上。它只上传聚合用量事实，不上传 prompt、回答内容、源码、完整会话、真实绝对路径、Cursor session token 或身份私钥。

**功能**：本地采集 · 公开排行榜 · Tauri 桌面端 · CLI 采集器 · 签名上传 · token 组成分析 · OpenRouter 价格 · 估算成本 · Admin 管理台 · JSON/MySQL 存储 · 桌面安装包 · 静默更新

**官方支持平台**：macOS Apple silicon、macOS Intel、Windows x64。

当前版本：`0.7.14`

---

## 效果截图

![AI Token League 桌面客户端趋势页](assets/screenshots/desktop-client.png)

| 工作目录 | 来源 |
| --- | --- |
| ![AI Token League 桌面客户端工作目录页](assets/screenshots/desktop-workdirs.png) | ![AI Token League 桌面客户端来源页](assets/screenshots/desktop-sources.png) |

| 公开首页 | 社区排行榜 |
| --- | --- |
| ![AI Token League 公开首页](assets/screenshots/web-home.png) | ![AI Token League 社区排行榜](assets/screenshots/web-leaderboard.png) |

| Admin 使用量运营 | Admin 客户端设备 |
| --- | --- |
| ![AI Token League Admin 使用量运营](assets/screenshots/admin-usage.png) | ![AI Token League Admin 客户端设备](assets/screenshots/admin-devices.png) |

---

## 功能概览

### 1. 公开排行榜

- **公开排名**：按今天、昨天、本周、上周、本月、上月等时间范围展示 token 用量排名。
- **排行事实**：主排行只看 `totalTokens`，成本只是辅助展示。
- **参与者详情**：查看参与者在模型、来源、workdir 和日期上的用量分布。
- **隐私展示**：workdir 使用 hash 与展示名，不上传真实绝对路径。

### 2. 本地采集器

- **Codex 本地日志**：扫描本机 Codex session JSONL 日志。
- **Claude Code 本地日志**：扫描本机 Claude Code project logs。
- **Cursor Dashboard Usage**：显式启用后读取 Cursor dashboard usage API；Cursor 不提供本地项目路径。
- **来源开关**：Sources 中按来源启停；开关只保存配置，不触发立即扫描。
- **Cursor 多 token**：支持添加多个 Cursor token，并以账号摘要展示。

### 3. 桌面应用

- **Today**：查看本地当天用量、模型分布、workdir 分布和最近扫描状态。
- **Trend**：查看个人 Daily 30d、Weekly 12w、Monthly 12m 趋势。
- **Settings**：Profile、App、Sources、Cloud、About 分域配置。
- **首次启动向导**：新用户先确认身份、隐私、来源和云端连接，再开始采集。
- **诊断导出**：本地导出脱敏诊断包，包含运行日志、扫描/同步摘要和队列状态，用于排查客户端扫描、同步和云端数据差异。
- **应用更新**：支持手动检查、下载校验、重启升级和可配置静默更新。

### 4. CLI 采集器

- `init`：创建本地身份和配置；无参数首次运行时支持交互式初始化。
- `health`：查看本地来源、版本和服务端兼容状态。
- `scan`：扫描本地 usage facts。
- `register`：向服务端注册匿名设备。
- `sync`：上传签名后的聚合 usage batch。
- `export-identity` / `import-identity`：迁移本地身份。

### 5. Admin 管理台

- **Usage ranking**：按日期、参与者、粒度查询服务端聚合用量。
- **Model prices**：维护自定义模型价格，刷新 OpenRouter 价格缓存。
- **Missing price**：定位缺价模型并映射到已有计费模型。
- **Reset user**：在早期数据修正场景下，删除单个 participant 的服务端聚合数据并允许客户端重新同步。

### 6. 发布与更新

- **zip 包**：macOS arm64、macOS x64、Windows x64。
- **原生安装包**：macOS DMG、Windows NSIS exe。
- **release manifest**：记录平台产物、checksum、安装包链接和协议兼容信息。
- **Cloud Connection**：桌面端 update check 只从 app-server 读取 release config，不内置 OSS 地址。

---

## 支持的数据来源

| 来源 | Provider ID | 状态 | 说明 |
| --- | --- | --- | --- |
| Codex | `codex_local` | 支持 | 扫描本地 Codex session JSONL 日志。 |
| Claude Code | `claude_code_local` | 支持 | 扫描本地 Claude Code 项目日志。 |
| Cursor | `cursor_dashboard_usage` | 显式启用后支持 | 使用 Cursor dashboard usage API；不提供真实项目路径。 |

token 总量规则：

```text
totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
```

reasoning tokens 是诊断和成本相关字段，不进入主排行总量。

---

## 安全性与隐私

服务端只接收按天聚合后的 usage facts。以下内容不得上传：

- prompt
- assistant response
- source code
- full transcript
- real absolute path
- Cursor session token
- identity private key

本地数据默认位置：

| 数据 | 默认位置 |
| --- | --- |
| 本地身份、来源、alias、provider 配置 | `~/.ai-token-league/config.json` |
| 本地 usage cache | `~/.ai-token-league/usage-cache.json` |
| upload queue | `~/.ai-token-league/upload-queue.json` |
| sync manifest | `~/.ai-token-league/sync-manifest.json` |
| runtime log | `~/.ai-token-league/log/runtime.YYYY-MM-DD.log`，默认保留最近 3 天，诊断导出时脱敏 |
| 后端 JSON 存储 | `data/db.json` |

实用建议：

1. 不要把 `~/.ai-token-league` 目录直接公开分享。
2. `Settings > About > 数据保护` 默认开启自动备份，可以做立即备份、从备份恢复、选择备份文件夹、打开备份目录、清空备份，并设置保留天数；默认位置是 `~/.ai-token-league/backup/`。
3. 本机备份文件包含恢复所需的敏感配置，可能包含身份私钥和本机 token；只用于个人迁移或恢复，不要公开分享。
4. 导出诊断包前确认只包含脱敏聚合事实。
5. 公共机器使用后，清理本地配置和上传队列。

---

## 安装指南

### 选项 A：下载桌面安装包

前往 [GitHub Releases](https://github.com/SKYhuangjing/ai-token-league/releases) 下载对应系统的安装包：

- **macOS Apple silicon**：`AI Token League-0.7.14-mac-arm64-installer.dmg`
- **macOS Intel**：`AI Token League-0.7.14-mac-x64-installer.dmg`
- **Windows x64**：`AI Token League-0.7.14-win-x64-installer.exe`

### 选项 B：下载 zip 包

也可以下载 zip 包后直接运行：

- `AI Token League-darwin-arm64.zip`
- `AI Token League-darwin-x64.zip`
- `AI Token League-win32-x64.zip`

### macOS 提示无法打开或应用已损坏？

如果 macOS 提示应用来自未验证开发者、无法打开，或提示“应用已损坏”，请先把应用拖入“应用程序”，再运行 DMG 内的“已损坏修复”工具。也可以在“系统设置 > 隐私与安全性”中选择仍要打开。

---

## 快速开始

要求：

```text
Node.js >= 22
```

安装依赖：

```bash
npm install
```

启动后端和公开 Web 排行榜：

```bash
[ -f env.local ] || cp env.example env.local
scripts/start-server.sh --env env.local
```

打开：

```text
http://127.0.0.1:8787
```

初始化本地采集器：

```bash
npm run collector:init -- --nickname your-name --api http://127.0.0.1:8787
```

扫描并同步：

```bash
npm run collector -- scan
npm run collector -- sync
```

运行桌面端：

```bash
npm run desktop
```

---

## 开发与构建

项目脚本是服务和发布流程的首选入口：

- 启动服务：`scripts/start-server.sh --env env.local`
- 打包/发布：`scripts/release.sh`
- 版本或产品基线更新：`npm run bump -- <version>` 或 `npm run bump -- --baseline <major.minor>`
- 预置配置生成：`npm run preset -- --env env.local`
- 发布 manifest dry run：`node scripts/publish-release.js --env env.local --dry-run --full`

`npm start`、`npm run package:*`、`npm run release:*` 是底层命令，适合定向验证或排障；日常服务启动和完整发布优先使用上面的脚本入口。

常用命令：

```bash
npm test
npm run smoke
npm run desktop
```

普通桌面 UI 或 renderer 改动默认用 `npm run desktop` 验证，不需要重新打包。本地开发只有改到打包后才会变化的面，才构建当前电脑可用的一个 zip 包：桌面打包资源、bundled assets、预置配置、更新/发布元数据、安装或下载体验。平台由脚本自动识别：

```bash
scripts/release.sh --platform current --env env.local --yes
```

构建：

```bash
scripts/release.sh --platform current --yes
scripts/release.sh --platform all --yes
```

发布 dry run：

```bash
node scripts/publish-release.js --env env.local --dry-run --full
```

完整发布：

```bash
scripts/release.sh --env env.local --upload --yes
```

更多开发命令、API 细节、存储说明和验证边界见 [AGENTS.md](AGENTS.md)。

---

## 项目文档

- [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) - 中文更新日志。
- [CHANGELOG.md](CHANGELOG.md) - English changelog。
- [doc/0.7-baseline.md](doc/0.7-baseline.md) - 0.7 桌面客户端 UI 重构基线（进行中）。
- [doc/0.7-development-tasks.md](doc/0.7-development-tasks.md) - 0.7 完整落地任务与验证记录。
- [doc/0.6-baseline.md](doc/0.6-baseline.md) - 0.6 产品基线（已冻结）。
- [doc/0.6-development-tasks.md](doc/0.6-development-tasks.md) - 0.6 开发任务与验证记录。
- [doc/0.5-baseline.md](doc/0.5-baseline.md) - 0.5 产品基线（已冻结）。
- [doc/0.5-development-tasks.md](doc/0.5-development-tasks.md) - 0.5 开发任务与验证记录。
- [doc/0.4-baseline.md](doc/0.4-baseline.md) - 0.4 产品基线。
- [doc/0.4-development-tasks.md](doc/0.4-development-tasks.md) - 0.4 开发任务与验证记录。
- [doc/0.3-baseline.md](doc/0.3-baseline.md) - 0.3 产品基线。
- [doc/0.3-development-tasks.md](doc/0.3-development-tasks.md) - 0.3 开发任务与验证记录。
- [doc/0.2-baseline.md](doc/0.2-baseline.md) - 0.2 产品基线。
- [doc/v0.1-baseline.md](doc/v0.1-baseline.md) - 冻结的 0.1 MVP 基线。
- [doc/er-diagram.md](doc/er-diagram.md) - 本地与远程存储模型图。
- [doc/usage-composition-design.md](doc/usage-composition-design.md) - token 和成本组成设计。
- [doc/openrouter-pricing-design.md](doc/openrouter-pricing-design.md) - OpenRouter 价格设计。
- [doc/packaging.md](doc/packaging.md) - 桌面打包和验证。
- [doc/operations.md](doc/operations.md) - 运维手册：服务端部署、下载通道配置、客户端预置配置。
- [doc/test-deployment.md](doc/test-deployment.md) - Docker 和 MySQL 测试部署。

---

## 当前限制

- 暂不支持 hook-based live collection。
- 暂无账号系统、团队空间或私有房间。
- cost 是可选展示，不是主排行依据。
- Cursor dashboard usage 不提供本地工作目录归因。
- Windows 已完成初步可用性验证，但仍建议在每次 packaging/updater 变更后做真实 Windows 复测。

---
