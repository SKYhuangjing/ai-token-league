# CLI 终端使用手册

`atl-collector` 的终端入口，面向无图形界面场景：在终端查看已采集的统计数据、设置 ATL、执行扫描与同步。所有命令输出仅英文（CLI 不走 i18n），人读格式紧凑、`--json` 输出机器可读。

设计原则：

- **与桌面 App 同一份数据和配置**：查询读 `~/.ai-token-league` 下的本地 usage 数据库，`config set` 走桌面设置页同一个 `update_config` 入口，两边随时互换，无第二真相源。
- **零新运行时**：采集、查询、设置都在既有 Rust 二进制内，不要求 Node/Python。
- **隐私边界不变**：终端命令只读本地统计与配置，不上传任何内容；身份私钥与 Cursor token 在读取时脱敏。

## 获取与运行

开发机（需要 Rust 工具链）：

```bash
npm run collector -- --help        # 等价 cargo run -p atl-collector --
cargo build -p atl-collector       # 产物 target/debug/atl-collector
```

桌面用户：本手册随安装包分发（macOS 在 `AI Token League.app/Contents/Resources/docs/cli.md`，Windows 在安装目录 `docs\cli.md`）。**推荐入口**：桌面 App 设置页 →「终端命令行（CLI）」→ 复制提示词发给你的 AI 助手，它会按当前系统的路径把命令装好。macOS/Linux 用软链接（App 升级后命令自动跟随），链接名约定为 `atl`——装好后 `atl` 与 `atl-collector` 等价，本文统一用 `atl-collector` 指代：

```bash
ln -sfn "/Applications/AI Token League.app/Contents/Resources/atl-collector" ~/.local/bin/atl
```

（`~/.local/bin` 需在 PATH 中、无需 sudo；写 `/usr/local/bin` 则需要 sudo，二选一。Windows 无需软链接：把安装目录加入用户 PATH 后命令名为 `atl-collector`。）装好后可用 `atl-collector --version` 确认版本。

## 快速开始（无界面机器）

```bash
atl-collector init --nickname sky --api http://your-server:8787
atl-collector scan                 # 扫描并写入本地 usage 数据库
atl-collector usage                # 查看今日统计
atl-collector sync                 # 同步到服务器
```

定时执行（cron 示例，工作日白天每 30 分钟一轮）：

```text
*/30 8-22 * * *  atl-collector scan && atl-collector sync >> ~/.ai-token-league/cron.log 2>&1
```

测试隔离：设 `ATL_HOME=/path/to/dir` 可把配置与数据重定向到沙箱目录，不影响真实数据。

## 命令参考

### status / scan / sync

```bash
atl-collector status [--json]
atl-collector scan [--full] [--json]
atl-collector sync [--full-resync] [--json]
```

- 所有命令的 `--json` 均可简写为 `-j`。
- `status`：身份、API 地址、最近同步状态、本地数据量。
- `scan`：扫描全部已启用来源并**写入本地 usage 数据库**；该库同时充当增量扫描缓存，重复执行只重读变化过的来源。`--full` 清空来源缓存全量重扫。**任一 provider 报错时拒绝落库**（避免抹掉失败来源的历史数据），并列出失败项与修复提示。
- `sync`：扫描（同上，成功时落库）后上传到服务器。来源有错误时拒绝同步；`--full-resync` 清空同步清单做全量对账上传。

### usage

```bash
atl-collector usage [today|7d|30d|all|A..B|summary|trend|workdirs|detail ...]
                    [--grain day|week|month|hour]
                    [--limit N] [--offset N]
                    [--provider P] [--model M] [--workdir W]
                    [--cost] [--json]
```

- 范围与视图可直接写在命令后面（最多两个词，顺序不限）：视图词（`summary`/`trend`/`workdirs`/`detail`）自动识别，其余按范围解析。常用组合：

  ```bash
  atl-collector usage              # 今日汇总（默认）
  atl-collector usage trend        # 今日按小时趋势
  atl-collector usage 7d           # 近 7 天汇总
  atl-collector usage 7d trend     # 近 7 天按日趋势
  ```

- 默认范围 `today`、默认视图 `summary`；`--range`/`--view` 长参数仍可用（便于脚本），但与位置参数指定同一项时报错。`A..B` 为 `YYYY-MM-DD..YYYY-MM-DD`，两端可留空（如 `..2026-09-01`）。**非法 range/视图词直接报错**，不会静默降级。
- 高频参数有一字母短写：`-r` range、`-v` view、`-g` grain、`-n` limit、`-o` offset、`-c` cost、`-j` json，可与位置参数混用（如 `atl-collector usage 30d trend -g week`）；过滤器 `--provider/--model/--workdir` 仅长写。
- `--grain` 默认跟随范围：`today` 时为 `hour`（单日看小时分布，与桌面一致），其余为 `day`；显式传入时始终生效。
- 查询以**只读方式**打开本地库：不会创建或改动任何文件，可与桌面 App 同时使用。
- `--provider/--model/--workdir` 为大小写不敏感的子串过滤器，作用于所有视图（如 `--provider codex`、`--model glm-5.3`、`--workdir control`），可组合。
- `--cost`（仅 summary 视图）：用服务器公开的 `/api/model-prices` 价格对本地数据估算费用，输出总价与每模型费用（`≈$xx.xx`）；价格缺失的模型计入 `unpricedModels`，`costQuality` 标记 exact/estimated/unknown。价格数据始终来自服务器，不在本地复制价格表。`--json` 输出中对应 `cost` 块（`estimatedCostUsd`/`costQuality`/`unpricedTokens`/`unpricedModels`/`pricingSource`）。`apiBaseUrl` 未配置时提示配置命令并退出（码 1）；服务器不可达时按网络错误退出（码 12），不影响不带 `--cost` 的本地查询。
- `summary`（默认视图）：总量、token 构成、按来源/模型/项目目录 Top 榜。
- `trend`：按 `--grain` 粒度的时间趋势（终端带 ASCII 条形）。
- `workdirs`：项目目录明细（`--limit` 默认 20，上限 500）。
- `detail`：原始行明细（按日聚合前的小时粒度事实行）。

token 口径与产品一致：`totalTokens = input + output + cacheRead + cacheWrite`（reasoning 仅诊断展示，不计入总量）。

### config

```bash
atl-collector config list            # 全量设置 JSON，私钥已脱敏
atl-collector config get <key>       # 单值；标量直接输出，便于脚本取值
atl-collector config set <key> <value>
```

`set` 按键的类型解析布尔/数字，非法值直接报错；写入口与桌面设置页相同，归一化规则一致（如 `theme DARK` 存为 `dark`、`refreshIntervalMinutes 0` 钳到 1），回显的是**生效后**的值；枚举值（如 `theme purple`）会报错并列出合法取值，不会静默落到默认。

可写键：

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `nickname` | 字符串 | 昵称 |
| `apiBaseUrl` | 字符串 | 服务器地址；变更会自动重置同步状态 |
| `language` | 字符串 | `zh-CN` / `en`（桌面 UI 语言） |
| `theme` | 字符串 | `light` / `dark` / `system` |
| `showEstimatedCost` | 布尔 | 界面是否显示估算成本 |
| `refreshIntervalMinutes` | 数字 | 桌面自动刷新间隔（最小 1） |
| `autoRefreshEnabled` | 布尔 | 桌面自动刷新开关 |
| `launchAtLogin` / `hideDockIcon` | 布尔 | 桌面启动行为（macOS） |
| `runtimeLogRetentionDays` | 数字 | 运行日志保留天数（1-30） |
| `providerEnabled.<providerId>` | 布尔 | 启用/停用某来源，如 `providerEnabled.cursor_dashboard_usage false` |
| `localBackup.enabled` / `.directory` / `.retentionCount` | 混合 | 本地备份（保留天数 1-30） |
| `shareCardOrientation`、`showShareCloudUrl`、`showSharePolaroidFrame`、`showShareAnonymousName` | 混合 | 分享卡样式 |

只读键（`get` 可查）：`participantId`、`deviceId`、`identityPublicKey`、`providerRoots`、`workdirAliases`、`providerIgnoredAutoSources` 等。`identityPrivateKey` 一律返回 `(hidden — use export-identity)`；导出身份请用 `export-identity`（输出含私钥，自行妥善保管）。

### top / rank（服务器侧榜单）

```bash
atl-collector top [today|yesterday|7d|30d|all|A..B] [--limit N] [--json]
atl-collector rank [today|yesterday|7d|30d|all|A..B] [--json]
```

- 范围可直接写在命令后（如 `atl-collector top today`），默认 `7d`；`--range`（短写 `-r`）仍可用，与位置参数同时给出时报错；`-n` 条数、`-j` JSON。
- `top`：拉取服务器排行榜前 N（默认 10），显示名次、昵称/匿名名、总 token。
- `rank`：定位"我"的名次并显示前后邻居与差距。匿名榜单模式下自动通过 `my-identity` 接口换算 publicId，公开模式下直接按 participantId 匹配。需要已配置 `apiBaseUrl` 且设备已向该服务器同步过数据。
- 两者均为对公开 board API 的只读透传，排名与统计逻辑全部在服务器侧。未初始化时退出码 10，服务器不可达时退出码 12。

### plugin / zhipu / share（插件终端面）

桌面插件的终端入口，与桌面 App 共享同一份 modules.json、认领存储与配置；
装卸不执行任何插件代码，config 值与 API key 永不落终端输出（密钥只出掩码）：

```bash
atl-collector plugin list [-j]                      # 已装插件（__order 等宿主记账键不显示）
atl-collector plugin install <id> [--version v]     # 经后端代理下载并落盘，幂等（同版本已装则 unchanged）
atl-collector plugin remove <id>                    # 摘安装记录+删本机包；config 保留可复原

atl-collector zhipu usage [--force] [-j]            # 5h/每周窗口用量（60s 缓存，与托盘同源）
atl-collector zhipu key list|add <apiKey> [--label l]|remove <序号|标签>   # 幂等：重复 add 不叠加

atl-collector share dir [--family gemini-*] [-j]    # 在线车道目录（分层排序与卡片一致）
atl-collector share claims [-j]                     # 我的认领 + 实时用量 + export 环境变量行
atl-collector share claim <shareId> [laneId] [-j]   # 认领并打印可直接管道的接入配置
atl-collector share renew|revoke <keyId> [-j]       # 续期（同 key）/ 释放
atl-collector share test <keyId> [--model m] [-j]   # 经认领端点发一次最小生成验证连通
atl-collector share owner|suggest [-j]              # 我的分享控制台 / 车道预算建议
atl-collector share stop --yes | resume [-j]        # 停止分享（撤销全部认领 Key，需确认）/ 重开
```

`share claims` / `share claim` 会打印 `export OPENAI_BASE_URL=… / OPENAI_API_KEY=… /
ANTHROPIC_BASE_URL=… / ANTHROPIC_AUTH_TOKEN=…` 四行（借用凭据仅经此显式导出动词输出，
与 `export-identity` 同类）。设计与命令全表见 `doc/plugin-development.md` §4。

行为细节（2026-09-19 盲测加固轮）：

- 提示行/Usage/版本行跟随实际调用名（经 `atl` 软链调用即显示 `atl`，裸二进制即
  `atl-collector`），提示中的命令可直接复制执行。
- `zhipu key add` 入口校验 key 形状（`<id>.<secret>`，两段字母数字）：明显非法的输入
  退出码 1 拒绝入库，而不是入库后在查询时才失败。
- `plugin install <id> --version <不存在版本>` 是业务失败（退出码 1，提示不带 --version
  重试）；仅传输层失败（连不上后端）才是网络错误 12。
- JSON 模式下 stdout 只含一个 JSON 文档；`plugin install` 成功后的 `Try:` 提示行走
  stderr，不破坏机器解析。

### roots

```bash
atl-collector roots list
atl-collector roots add <providerId> <path>
atl-collector roots remove <providerId> <path>
```

为指定来源追加/移除额外扫描根目录（自动发现的目录之外的手动补充）。

### 身份与对账（既有命令）

`init`、`health`、`register`、`export-identity`、`import-identity`、`reconcile --full` 用法不变，见 `--help`。

## 数据与文件位置

| 文件 | 用途 |
| --- | --- |
| `~/.ai-token-league/config.json` | 配置与身份 |
| `~/.ai-token-league/config.json.bak` | 配置写入时的自动备份 |
| `~/.ai-token-league/usage-local.sqlite3` | 本地 usage 数据库（`usage` 命令只读、`scan` 写入，与桌面 UI 共用） |
| `~/.ai-token-league/usage-cache.json` | 最近一次扫描快照（sidecar 新鲜度判断用） |
| `~/.ai-token-league/upload-queue.json` | 上传重试队列 |

## 退出码表

脚本可按退出码区分错误类别，无需解析 stderr 文本：

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功（含"无变化"） |
| 1 | 一般运行错误（扫描不完整、参数**取值**非法如 `--range bogus`、`theme purple` 等） |
| 2 | 命令行**格式**错误：未知选项/子命令、缺失参数（clap 约定） |
| 3 | busy：另一进程持有本地存储写锁（modules.json / sharing-borrow.json / config.json）。不算失败，稍后重试即可；定时任务识别 3 跳过不告警 |
| 10 | 未初始化（先运行 `init`） |
| 11 | 本地 usage 数据库为空（先运行 `scan`） |
| 12 | 网络/服务器错误（top/rank/sync/价格拉取/插件目录下载失败） |

## JSON 输出契约

所有支持 `-j` / `--json` 的命令遵循统一外壳，一条解析规则通吃全部动词：

```json
// 成功（changed 标识是否改动了本地状态；只读动词恒为 false）
{"ok": true, "changed": false, "data": { ...各动词自己的字段... }}

// 失败（--json 模式下错误也是 stdout 上的一个完整 JSON 文档；退出码照常生效）
{"ok": false, "error": "backend unreachable (...) ", "hint": "check your network, or ..."}
```

例外：`export-identity` 输出的是身份交换格式（供 `import-identity` 消费），保持裸 JSON 不套外壳。

## 已知边界

- 服务器侧数据目前覆盖榜单 top 与我的名次；个人主页趋势等更完整的远端视图暂无终端命令（后续同样走公开 API 透传）。
- 插件管理暂无终端命令（插件安装/升级仍在桌面端）。
- 未提供 MCP 接口（产品决策：先做好 CLI 本身；`claude mcp add` 等注册方式未来可基于同一二进制扩展 `mcp` 子命令）。
