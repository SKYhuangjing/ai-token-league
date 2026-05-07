# AI Token League [English](README.en.md) · 简体中文

[![GitHub release](https://img.shields.io/github/v/release/SKYhuangjing/ai-token-league?style=flat)](https://github.com/SKYhuangjing/ai-token-league/releases)
[![GitHub downloads](https://img.shields.io/github/downloads/SKYhuangjing/ai-token-league/total?style=flat&color=blue)](https://github.com/SKYhuangjing/ai-token-league/releases)
[![GitHub issues](https://img.shields.io/github/issues/SKYhuangjing/ai-token-league)](https://github.com/SKYhuangjing/ai-token-league/issues)

一款面向 **Codex**、**Claude Code** 和 **Cursor** 的本地优先 AI 编程 token 用量采集器与公开排行榜。

> AI Token League 用来回答一个直接的问题：团队或社区里，谁在使用 AI 编程工具、用了多少 token、分布在哪些模型、项目和日期上。它只上传聚合用量事实，不上传 prompt、回答内容、源码、完整会话、真实绝对路径、Cursor session token 或身份私钥。

**功能**：本地采集 · 公开排行榜 · Electron 桌面端 · CLI 采集器 · 签名上传 · token 组成分析 · OpenRouter 价格 · 估算成本 · Admin 管理台 · JSON/MySQL 存储 · 桌面安装包 · 静默更新

**官方支持平台**：macOS Apple silicon、macOS Intel、Windows x64。

当前版本：`0.5.1`

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
- **Settings**：Account、Sources、Cloud、Sync、App 分域配置。
- **首次启动向导**：新用户先确认身份、隐私、来源和云端连接，再开始采集。
- **诊断导出**：本地导出脱敏诊断包，用于排查客户端扫描、同步和云端数据差异。
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
| 本地 usage cache | Electron `userData/usage-cache.json` |
| upload queue | `~/.ai-token-league/upload-queue.json` |
| 后端 JSON 存储 | `data/db.json` |

实用建议：

1. 不要把 `~/.ai-token-league` 或 Electron userData 目录直接公开分享。
2. 导出诊断包前确认只包含脱敏聚合事实。
3. 公共机器使用后，清理本地配置和上传队列。

---

## 安装指南

### 选项 A：下载桌面安装包

前往 [GitHub Releases](https://github.com/SKYhuangjing/ai-token-league/releases) 下载对应系统的安装包：

- **macOS Apple silicon**：`AI Token League-0.5.1-mac-arm64-installer.dmg`
- **macOS Intel**：`AI Token League-0.5.1-mac-x64-installer.dmg`
- **Windows x64**：`AI Token League-0.5.1-win-x64-installer.exe`

### 选项 B：下载 zip 包

也可以下载 zip 包后直接运行：

- `AI Token League-darwin-arm64.zip`
- `AI Token League-darwin-x64.zip`
- `AI Token League-win32-x64.zip`

### macOS 提示无法打开或应用已损坏？

如果 macOS 提示应用来自未验证开发者、无法打开，或提示“应用已损坏”，可在“系统设置 > 隐私与安全性”中选择仍要打开。必要时可在终端移除 quarantine 标记：

```bash
sudo xattr -rd com.apple.quarantine "/Applications/AI Token League.app"
```

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
npm start
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

常用命令：

```bash
npm test
npm run smoke
npm run desktop:smoke
```

构建 zip 包：

```bash
rm -rf dist
npm run package:all
```

构建原生安装包：

```bash
rm -rf dist-installer
npm run package:installer:all
```

发布 dry run：

```bash
npm run release:dry-run
```

完整发布：

```bash
npm run release:publish
```

更多开发命令、API 细节、存储说明和验证边界见 [AGENTS.md](AGENTS.md)。

---

## 项目文档

- [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) - 中文更新日志。
- [CHANGELOG.md](CHANGELOG.md) - English changelog。
- [doc/0.5-baseline.md](doc/0.5-baseline.md) - 0.5 空白基线，尚未开启产品任务。
- [doc/0.5-development-tasks.md](doc/0.5-development-tasks.md) - 0.5 空白任务文档与版本迭代规则。
- [doc/0.4-baseline.md](doc/0.4-baseline.md) - 当前 0.4 产品基线。
- [doc/0.4-development-tasks.md](doc/0.4-development-tasks.md) - 0.4 开发任务与验证记录。
- [doc/0.3-baseline.md](doc/0.3-baseline.md) - 0.3 产品基线。
- [doc/0.3-development-tasks.md](doc/0.3-development-tasks.md) - 0.3 开发任务与验证记录。
- [doc/0.2-baseline.md](doc/0.2-baseline.md) - 0.2 产品基线。
- [doc/v0.1-baseline.md](doc/v0.1-baseline.md) - 冻结的 0.1 MVP 基线。
- [doc/usage-composition-design.md](doc/usage-composition-design.md) - token 和成本组成设计。
- [doc/openrouter-pricing-design.md](doc/openrouter-pricing-design.md) - OpenRouter 价格设计。
- [doc/packaging.md](doc/packaging.md) - 桌面打包和验证。
- [doc/test-deployment.md](doc/test-deployment.md) - Docker 和 MySQL 测试部署。

---

## 当前限制

- 暂不支持 hook-based live collection。
- 暂无账号系统、团队空间或私有房间。
- cost 是可选展示，不是主排行依据。
- Cursor dashboard usage 不提供本地工作目录归因。
- Windows 已完成初步可用性验证，但仍建议在每次 packaging/updater 变更后做真实 Windows 复测。

---
