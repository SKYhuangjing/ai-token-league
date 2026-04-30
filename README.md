# AI Token League

公开社区 AI token 排行榜 MVP。

Current baseline: `v0.1`, frozen on `2026-04-30`.

Docs:

- `doc/v0.1-baseline.md` - stable product and development baseline for the next phase.
- `doc/product-design.md` - detailed v0.1 product design history.
- `doc/mvp-development-tasks.md` - v0.1 task execution and verification history.
- `doc/er-diagram.md` - v0.1 local and remote data model diagrams.
- `doc/test-deployment.md` - Docker + MySQL test deployment instructions.

当前实现：

- Node.js backend + 静态 Web leaderboard。
- Node.js collector CLI。
- Electron desktop collector UI。
- provider 化采集架构。
- 内置 `claude_code_local`、`codex_local` 与显式启用的 `cursor_dashboard_usage` provider。
- 匿名身份：`participantId + identityKey`，支持导出/导入。
- usage batch 签名上传。
- 工作目录 hash + 公开展示名，不上传真实绝对路径。
- 公开榜支持今日、昨日、本周、上周、本月、上月。
- 管理员页支持 usage ranking 与 model price management 分 Tab。
- 桌面端支持 Today、Trend、Settings、后台刷新、同步、来源配置、目录 alias、成本展示开关。
- 服务端价格体系支持缺价模型补充和估算成本展示。

当前不包含：

- hook 采集。
- 原生安装器。
- 成本榜主排序。
- Cursor 本地工作目录归因。
- Windows 主机端到端验证。

## Requirements

```text
Node.js >= 22
```

## Run

Start backend and Web:

```bash
npm start
```

Open:

```text
http://127.0.0.1:8787
```

Initialize collector:

```bash
npm run collector:init -- --nickname your-name --api http://127.0.0.1:8787
```

Scan local usage:

```bash
npm run collector -- scan
```

Upload usage:

```bash
npm run collector -- sync
```

Export identity:

```bash
npm run collector -- export-identity > identity.json
```

Import identity on another device:

```bash
npm run collector -- import-identity --file identity.json
```

Run desktop collector UI:

```bash
npm run desktop
```

Desktop smoke:

```bash
npm run desktop:smoke
```

## Package

Build macOS arm64 and Windows x64 app bundles:

```bash
npm run package:all
```

Artifacts:

```text
dist/AI Token League-darwin-arm64.zip
dist/AI Token League-win32-x64.zip
```

The macOS artifact is smoke-tested on this machine. The Windows artifact is generated as a Windows x64 Electron app bundle; final E2E execution requires a Windows host.

## Test

```bash
npm test
```

Smoke checklist:

```text
doc/smoke-checklist.md
```

## Data

Backend JSON storage defaults to:

```text
data/db.json
```

Collector local config defaults to:

```text
~/.ai-token-league/config.json
```

Use isolated paths during smoke runs:

```bash
HOME="$PWD/.tmp-smoke/home" DB_PATH="$PWD/.tmp-smoke/data/db.json" npm start
```

## Test Deployment

Run backend/Web with MySQL:

```bash
docker compose -f docker-compose.mysql.example.yml up --build -d
```

The compose file reads `env.local` by default. Use `ENV_FILE=env.test` for `ai_token_league`. Both env files set `TZ=Asia/Shanghai` so daily rankings use the business day instead of UTC.

See:

```text
doc/test-deployment.md
```
