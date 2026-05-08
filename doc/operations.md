# AI Token League 运维手册

面向 IT 运维人员的部署、发布和客户端配置指南。

---

## 1. 服务端部署

### 1.1 环境要求

- Node.js >= 22
- （可选）MySQL 8.0+（使用 MySQL 存储时）

### 1.2 Docker + JSON 存储

最简部署，无需外部依赖，数据存储在容器内 JSON 文件。

创建 `env.json`：

```bash
cat > env.json << 'EOF'
HOST=0.0.0.0
PORT=8787
DB_TYPE=json
DB_PATH=/app/data/db.json
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<your-password>
EOF
```

给 compose 增加数据挂载：

```yaml
services:
  backend:
    volumes:
      - ./data:/app/data
```

启动：

```bash
ENV_FILE=env.json docker compose -f docker-compose.mysql.example.yml up --build -d
```

验证：

```bash
curl -s http://127.0.0.1:8787/api/health | jq '.ok, .dbType'
test -f data/db.json
```

期望 `dbType` 为 `json`。`docker-compose.mysql.example.yml` 只是当前通用 backend compose 模板；存储类型由 env 文件里的 `DB_TYPE` 决定。

### 1.3 Docker + MySQL 存储

适用于需要持久化和多实例共享数据的场景。

创建 `env.local`：

```bash
cp env.example env.local
```

编辑 `env.local`，设置 MySQL 连接：

```text
DB_TYPE=mysql
MYSQL_HOST=<mysql-host>
MYSQL_PORT=3306
MYSQL_DATABASE=ai_token_league
MYSQL_USER=<user>
MYSQL_PASSWORD='<password>'
MYSQL_AUTO_MIGRATE=true
```

> 注意：密码包含 `>`、`<`、`|`、`&`、`!`、`$` 等 shell 特殊字符时，必须用单引号包裹。Docker Compose 的 `env_file` 不会解释 shell 元字符，但本地 `source` 命令会。

启动：

```bash
docker compose -f docker-compose.mysql.example.yml up --build -d
```

使用自定义 env 文件：

```bash
ENV_FILE=env.my-test docker compose -f docker-compose.mysql.example.yml up --build -d
```

数据库迁移：`MYSQL_AUTO_MIGRATE=true` 时，服务端启动自动执行 `migrations/001_init_mysql.sql`。设为 `false` 则需手动建表。

### 1.4 裸机部署

```bash
git clone <repo-url> && cd ai-token-league
npm install
cp env.example env.local
# 编辑 env.local
node src/backend/server.js
```

使用 systemd 管理服务：

```ini
# /etc/systemd/system/ai-token-league.service
[Unit]
Description=AI Token League Backend
After=network.target

[Service]
Type=simple
User=ai-token-league
WorkingDirectory=/opt/ai-token-league
EnvironmentFile=/opt/ai-token-league/env.local
ExecStart=/usr/bin/node src/backend/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable ai-token-league
sudo systemctl start ai-token-league
```

反向代理（nginx）配置要点：

```nginx
server {
    listen 443 ssl;
    server_name league.example.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 1.5 健康检查

```bash
curl -s http://127.0.0.1:8787/api/health | jq .
```

返回字段：

| 字段 | 说明 |
| --- | --- |
| `ok` | 服务是否正常 |
| `dbType` | 存储类型（`json` 或 `mysql`） |
| `serverVersion` | 服务端版本（来自 package.json） |
| `serverProtocolVersion` | 协议版本（整数） |
| `latestClientVersion` | 声明的最新客户端版本 |
| `minClientEnforce` | 是否强制客户端最低版本 |
| `compatibility` | 客户端兼容性详情 |

### 1.6 Admin 访问控制

通过环境变量启用 HTTP Basic Auth 保护 `/admin.html` 和 `/api/admin/*`：

```text
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<your-password>
```

未设置 `ADMIN_USERNAME` 时，admin 路由保持开放（向后兼容本地开发）。

---

## 2. 下载通道配置

### 2.1 OSS 存储配置

发布产物上传到阿里云 OSS。需要以下环境变量：

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `RELEASE_OSS_ENDPOINT` | OSS endpoint | `oss-cn-shanghai.aliyuncs.com` |
| `RELEASE_OSS_BUCKET` | Bucket 名称 | `my-release-bucket` |
| `RELEASE_OSS_PREFIX` | Key 前缀 | `ai-token-league` |
| `RELEASE_PUBLIC_BASE_URL` | 公开访问 URL 基址 | `https://my-bucket.oss-cn-shanghai.aliyuncs.com/ai-token-league` |
| `RELEASE_OSS_ACCESS_KEY_ID` | AK（写入权限） | - |
| `RELEASE_OSS_ACCESS_KEY_SECRET` | SK（写入权限） | - |

OSS 权限要求：
- AK/SK：写入权限，仅用于发布环境执行 `release:upload` / `release:publish`
- 服务端运行环境：只需要 `RELEASE_PUBLIC_BASE_URL` 等公开 release 配置，不需要 OSS AK/SK
- Bucket 公开读：客户端和 Web 前端直接从 OSS 下载

设置 `env.local`（不提交到 git）：

```bash
cp env.example env.local
# 编辑 env.local，填入 OSS 凭据
```

服务端部署环境至少配置公开下载基址：

```text
RELEASE_PUBLIC_BASE_URL=https://my-bucket.oss-cn-shanghai.aliyuncs.com/ai-token-league
```

### 2.2 发布流程

构建和发布分四步：

```bash
# 1. 构建所有产物（zip + 安装包 + preset）
npm run release:build

# 2. 验证 manifest（不上传）
npm run release:dry-run

# 3. 上传到 OSS
npm run release:upload

# 4. 或者一步完成（构建 + 上传）
npm run release:publish
```

构建产物：

```text
dist/AI Token League-darwin-arm64.zip
dist/AI Token League-darwin-x64.zip
dist/AI Token League-win32-x64.zip
dist-installer/AI Token League-<version>-mac-arm64-installer.dmg
dist-installer/AI Token League-<version>-mac-x64-installer.dmg
dist-installer/AI Token League-<version>-win-x64-installer.exe
```

上传到 OSS 的文件：

```text
<prefix>/releases/<version>/AI Token League-darwin-arm64.zip
<prefix>/releases/<version>/AI Token League-darwin-x64.zip
<prefix>/releases/<version>/AI Token League-win32-x64.zip
<prefix>/releases/<version>/AI Token League-<version>-mac-arm64-installer.dmg
<prefix>/releases/<version>/AI Token League-<version>-mac-x64-installer.dmg
<prefix>/releases/<version>/AI Token League-<version>-win-x64-installer.exe
<prefix>/releases/checksums.txt
<prefix>/releases/latest.yml              (Windows electron-updater)
<prefix>/releases/latest-mac.yml          (macOS electron-updater)
<prefix>/releases/installer.json          (安装包元数据)
<prefix>/releases/<version>/installer.json
<prefix>/releases/latest.json             (macOS zip updater manifest)
```

可调参数（env 变量）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RELEASE_UPLOAD_CONCURRENCY` | `3` | 并发上传数 |
| `RELEASE_UPLOAD_ATTEMPTS` | `3` | 每文件重试次数 |
| `RELEASE_UPLOAD_HEADERS_TIMEOUT_MS` | `1200000` | HTTP headers 超时（20 分钟） |
| `RELEASE_UPLOAD_BODY_TIMEOUT_MS` | `1200000` | HTTP body 超时（20 分钟） |

### 2.3 版本兼容控制

控制客户端最低版本的两个环境变量：

```text
LATEST_CLIENT_VERSION=0.6.0     # 声明的最新客户端版本（留空则用服务端 package.json 版本）
MIN_CLIENT_ENFORCE=true         # 开启后，低于 LATEST_CLIENT_VERSION 的客户端被 HTTP 426 拒绝
```

行为：

| MIN_CLIENT_ENFORCE | 客户端版本 < latest | 结果 |
| --- | --- | --- |
| `false`（默认） | 是 | 返回 `upgrade_available`，不阻断 |
| `false` | 否 | 正常通过 |
| `true` | 是 | HTTP 426 拒绝 |
| `true` | 否 | 正常通过 |

服务端 release 端点：

| 端点 | 说明 |
| --- | --- |
| `GET /api/release/config` | 返回 release 配置、兼容信息和安装包元数据 |
| `GET /api/release/latest` | 返回 macOS zip updater 的 release manifest |
| `GET /api/health` | 返回完整健康信息（含版本和兼容状态） |

### 2.4 下载通道验证

发布后在服务端机器或 CI 中验证：

```bash
curl -s http://127.0.0.1:8787/api/release/config | jq '.ok, .latestClientVersion, .release.publicBaseUrl, .release.installers'
curl -s http://127.0.0.1:8787/api/release/latest | jq '.ok, .manifest.version'
```

期望：
- `/api/release/config` 返回 `release.installers`，且包含 `darwin-arm64`、`darwin-x64`、`win32-x64` 三个平台。
- 每个平台都有 `url`、`fileName`、`sha256`、`size`、`ext`。
- `/api/release/latest` 仅供 macOS zip updater 使用；不要删除，直到所有活跃客户端迁移到新的更新路径。
- Web 首页下载面板能展示最新版本、平台选择和下载按钮。

---

## 3. 客户端预置配置

### 3.1 系统概述

预置配置允许在打包时注入默认值，桌面客户端首次启动时使用这些值替代硬编码默认值。

流程：

```text
PRESET_* 环境变量 → scripts/build-preset.js → assets/preset.json → 打包进应用 → 首次启动注入 config.json
```

关键特性：
- 仅首次启动生效（用户已有配置时不覆盖）
- 用户修改后以用户配置为准
- 无环境变量时生成空对象 `{}`，不影响默认行为

### 3.2 可配置项

| 环境变量 | 配置键 | 类型 | 说明 |
| --- | --- | --- | --- |
| `PRESET_API_BASE_URL` | `apiBaseUrl` | string | 服务端地址 |
| `PRESET_NICKNAME` | `nickname` | string | 默认昵称 |
| `PRESET_LANGUAGE` | `language` | string | 语言（`zh-CN` / `en`） |
| `PRESET_AUTO_REFRESH` | `autoRefreshEnabled` | boolean | 自动刷新 |
| `PRESET_REFRESH_INTERVAL` | `refreshIntervalMinutes` | number | 刷新间隔（分钟） |
| `PRESET_SILENT_UPDATE` | `silentUpdateMode` | string | 静默更新模式（`notify` / `auto_download` / `auto_apply_on_idle`） |
| `PRESET_LAUNCH_AT_LOGIN` | `launchAtLogin` | boolean | 开机启动 |
| `PRESET_SHOW_ESTIMATED_COST` | `showEstimatedCost` | boolean | 显示估算成本 |
| `PRESET_SHOW_RAW_TOKENS` | `showRawTokens` | boolean | 显示原始 token 数 |
| `PRESET_PROVIDER_<ID>` | `providerEnabled.<id>` | boolean | 数据来源开关 |

可用的 Provider ID：
- `claude_code_local` — Claude Code 本地日志
- `codex_local` — Codex 本地日志
- `cursor_dashboard_usage` — Cursor Dashboard API

### 3.3 构建流程

方式一：通过 `npm run preset` 单独生成：

```bash
# 使用环境变量
PRESET_API_BASE_URL=https://league.example.com PRESET_LANGUAGE=zh-CN npm run preset

# 使用 env 文件
npm run preset -- --env env.local
```

方式二：通过 `npm run release:build` 自动执行（preset 在 package 之前）：

```bash
# 设置环境变量后构建
PRESET_API_BASE_URL=https://league.example.com npm run release:build
```

验证生成结果：

```bash
cat assets/preset.json
```

验证打包结果：

```bash
npm run release:build
npx asar list "dist/AI Token League-darwin-arm64/AI Token League.app/Contents/Resources/app.asar" | rg "^/assets/preset.json$"
```

### 3.4 渠道分发示例

**内部团队渠道**（预配服务端地址和自动同步）：

```bash
cat > env.preset-team << 'EOF'
PRESET_API_BASE_URL=https://league.internal.example.com
PRESET_LANGUAGE=zh-CN
PRESET_AUTO_REFRESH=true
PRESET_REFRESH_INTERVAL=15
PRESET_SILENT_UPDATE=auto_download
PRESET_LAUNCH_AT_LOGIN=true
PRESET_PROVIDER_CLAUDE_CODE_LOCAL=true
PRESET_PROVIDER_CODEX_LOCAL=true
PRESET_PROVIDER_CURSOR_DASHBOARD_USAGE=false
EOF

npm run preset -- --env env.preset-team
npm run release:build
```

**公开测试渠道**（禁用静默更新，保留手动控制）：

```bash
cat > env.preset-beta << 'EOF'
PRESET_API_BASE_URL=https://beta.league.example.com
PRESET_LANGUAGE=en
PRESET_SILENT_UPDATE=notify
PRESET_AUTO_REFRESH=false
EOF

npm run preset -- --env env.preset-beta
npm run release:build
```

**只读监控渠道**（仅开启 Cursor 来源，适合监控仪表盘）：

```bash
cat > env.preset-monitor << 'EOF'
PRESET_API_BASE_URL=https://league.internal.example.com
PRESET_PROVIDER_CLAUDE_CODE_LOCAL=false
PRESET_PROVIDER_CODEX_LOCAL=false
PRESET_PROVIDER_CURSOR_DASHBOARD_USAGE=true
PRESET_SHOW_ESTIMATED_COST=true
PRESET_SHOW_RAW_TOKENS=true
EOF

npm run preset -- --env env.preset-monitor
npm run release:build
```

### 3.5 禁止预置的字段

以下字段必须运行时生成，不可通过预置注入：

- `participantId`
- `identityPublicKey`
- `identityPrivateKey`
- `deviceId`
- `createdAt`
- `desktopAutoInitialized`

### 3.6 首次启动验证

使用独立 HOME 验证 preset 只在首次启动生效：

```bash
rm -rf .tmp-preset-home
HOME="$PWD/.tmp-preset-home" "dist/AI Token League-darwin-arm64/AI Token League.app/Contents/MacOS/AI Token League" --desktop-smoke
cat .tmp-preset-home/.ai-token-league/config.json | jq '.apiBaseUrl, .language, .providerEnabled'
```

再次启动同一 HOME 后，用户配置不应被新的 `assets/preset.json` 覆盖。
