# AI Token League MVP 开发任务追踪

## 0. v0.1 固化说明

本文档记录 v0.1 MVP 从启动到阶段结束的任务执行历史，已在 `2026-04-30` 阶段性冻结。

当前可作为 v0.1 验收依据的入口是 `v0.1-baseline.md`。后续 v0.2 不应继续复用 E0-E17 编号追加任务，应新建版本任务段或新任务文档，避免历史任务和下一阶段范围混在一起。

v0.1 状态：

- E0-E9、E11-E17 已完成。
- E10 发布验证仍保留 `REVIEW`，原因是 macOS 本机链路已验证、Windows x64 包已生成，但 Windows 主机 E2E 尚未执行。
- `dist/AI Token League-darwin-arm64.zip` 与 `dist/AI Token League-win32-x64.zip` 为当前阶段产物。
- E18 开始进入 v0.2 测试环境部署准备：Docker + MySQL，不改变 v0.1 已冻结基线。

## 1. 文档用途

本文档用于追踪 AI Token League 从开发启动到 MVP 发布完成的全部任务。

任务拆分基于 `product-design.md`，当前 MVP 边界为：

- 公开社区榜。
- 无登录，昵称 + 可导入导出的匿名身份包。
- macOS / Windows collector。
- provider 化采集架构。
- 第一版内置 `claude_code_local`、`codex_local` 与显式启用的 `cursor_dashboard_usage` provider。
- 工作目录 alias 维护；未设置 alias 时展示系统检测目录名。
- token 总量排名。
- token 展示默认使用短单位；原始整数保留在 tooltip/详情中。
- 成本字段预留，估算成本作为二级能力，不作为主榜排序。
- 不做 hook。
- Cursor 只做 Dashboard Usage token/model/date 采集，不做工作目录归因。

## 2. 状态定义

任务状态只使用以下值：

```text
TODO        未开始
DOING       开发中
BLOCKED     阻塞中
REVIEW      待评审或待验证
DONE        已完成
DEFERRED    延后，不进入当前 MVP
```

任务推进规则：

- 只有满足验收标准后，任务才能进入 `DONE`。
- 发现范围变化时，新增任务或调整任务说明，不直接覆盖历史判断。
- 涉及外部接口、数据结构、身份逻辑、隐私边界的变更，必须先更新本文档再编码。
- 每个 Epic 完成时，需要补充验证记录。

## 3. MVP 发布总验收

MVP 发布必须同时满足：

- macOS 可以完成本地采集、预览、上传、榜单展示。
- Windows 可以完成本地采集、预览、上传、榜单展示。
- `claude_code_local` provider 至少通过一个真实样本或构造样本验证。
- `codex_local` provider 至少通过一个真实样本或构造样本验证。
- 上传数据不包含 prompt、response、代码、真实绝对路径。
- 匿名身份包可以导出，并在另一台设备或模拟设备导入后继续使用同一个 `participantId`。
- 同一天、同设备、同工具、同 provider、同工作目录、同模型重复上传不会重复计数。
- 公开榜单支持日榜、周榜、月榜和上一周期榜；自定义时间只进入用户详情和管理员查询。
- 发布前有一份可执行 smoke checklist。

## 4. 任务总览

| Epic | 名称 | 状态 | 完成标准 |
| --- | --- | --- | --- |
| E0 | 项目基线与工程骨架 | DONE | Node.js monorepo、shared schema、测试入口已建立 |
| E1 | Collector Core | DONE | provider registry、扫描调度、标准化聚合可运行 |
| E2 | Claude Code Provider | DONE | 可解析 Claude Code token 并映射工作目录 |
| E3 | Codex Provider | DONE | 可解析 Codex token 并映射工作目录 |
| E3.5 | Cursor Dashboard Usage Provider | DONE | 可通过 Cursor dashboard event 采集 token/model/date，workdir 固定为 Cursor |
| E4 | 匿名身份与身份包 | DONE | 身份生成、导出、导入、签名上传可用 |
| E5 | 工作目录维护 | DONE | hash、系统目录名、alias、公开展示名规则可用 |
| E6 | Backend API 与存储 | DONE | 设备注册、usage upsert、榜单查询可用 |
| E7 | Web Leaderboard | DONE | 普通公开榜与管理员查看页可用 |
| E8 | Desktop UI | DONE | Electron 桌面壳已实现，覆盖 Today、Trend、设置、后台刷新、同步 |
| E9 | 跨平台打包 | DONE | macOS app 与 Windows x64 分发包已生成 |
| E10 | 发布验证 | REVIEW | 本机 smoke 通过，Windows 实机 E2E 待 Windows 主机验证 |
| E11 | Web/Trend 交互模型重构 | DONE | 榜单周期、用户趋势、管理员查询和客户端 Trend 已按新产品模型落地 |
| E12 | 存储模型与追溯能力硬化 | DONE | 本地/远端按可追溯每日明细模型落地，支持性能可控的刷新、合并、上传和分析 |
| E13 | 展示可读性与详情页去重 | DONE | token 短单位、图表/表格互斥、表格日期倒序、图表最新点突出 |
| E14 | 估算成本能力 | DONE | LiteLLM/ccusage 价格来源、成本二次计算、质量标记、可选展示 |
| E15 | Web/客户端产品语义重构 | DONE | 公开详情页默认解释榜单周期，客户端 Trend 改为有语义的 Daily/Weekly/Monthly 复盘 |
| E16 | Web/客户端详情与筛选交互优化 | DONE | 用户详情改为弹窗/抽屉，Web/客户端趋势压缩成固定高度图表，Admin 时间筛选改为 quick range + date picker 联动 |
| E17 | 设置归属、Admin Tab 语境与 Chart Tooltip 收口 | DONE | Settings 按 Profile/Display/Sync/Sources/Aliases/System 分组，Cursor 归入 Sources，Admin 筛选只在 Usage tab 内，图表 hover 展示日期/token/成本 |
| E18 | 测试环境部署与 MySQL 存储迁移 | REVIEW | MySQL Store 已用独立库完成本机服务端 E2E；Docker backend 到外部 MySQL 的网络链路待测试环境网络放通 |
| E19 | 同步目标可见化与环境配置收口 | DONE | 客户端持久展示 API/上次同步状态；Docker 通过 env.local/env.test 显式选择 dev/test 数据库 |
| E20 | Icon 资源与打包标识收口 | DONE | icon 资源已重新生成，macOS/Windows 分发包已重打，Web favicon 与包内资源已验证 |
| E21 | Sources 开关与 Cursor Token 配置收口 | DONE | 删除独立 Cursor dashboard 设置区，来源卡片承担 On/Off，Cursor token 通过弹窗校验保存 |
| E22 | Sources 开关性能优化与 0.2 基线 | DONE | On/Off 不触发全量扫描或 Cursor API；`doc/0.2-baseline.md` 固化当前现状 |
| E23 | P0 Admin 信息架构与详情面板重构 | DONE | Admin 首屏压缩为工作台；Usage 表格只保留主决策列；详情面板按当前上下文解释 |
| E24 | P1 运营动作闭环与质量诊断 | DONE | Pricing 缺价任务队列、Quality 分组诊断、成本语义统一已落地 |
| E25 | P2 桌面端交互安全与设置归属 | DONE | Trend 进入时回到顶部；Sync 上传前预览确认；高风险设置集中到 System 提示 |

## 5. Epic 任务拆分

### E0 项目基线与工程骨架

目标：建立可持续开发的项目结构，避免采集、后端、Web、桌面 UI 后续互相耦合。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E0-T1 | 确定仓库结构 | DONE | 无 | 明确 collector、backend、web、shared schema 的目录边界 |
| E0-T2 | 确定技术栈 | DONE | E0-T1 | 明确 Tauri/Electron、后端框架、Web 框架、数据库 |
| E0-T3 | 建立 shared schema | DONE | E0-T2 | `UsageDaily`、`Workdir`、`Identity`、`ProviderHealth` 有统一类型定义 |
| E0-T4 | 建立本地开发配置 | DONE | E0-T2 | 一条命令可启动本地 backend + web，collector 可连接本地 API |
| E0-T5 | 建立基础测试命令 | DONE | E0-T3 | 至少包含 schema 测试、provider parser 测试、API 测试入口 |

验证记录：

```text
2026-04-29:
- package.json 已建立 start/collector/test/smoke 脚本。
- shared schema 与 crypto 工具已建立。
- npm test 通过。
```

### E1 Collector Core

目标：实现 provider 化采集主流程，让新增 AI IDE 只需要新增 provider。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E1-T1 | 定义 Provider 接口 | DONE | E0-T3 | 接口包含 `detect`、`scanSessions`、`parseUsage`、`resolveWorkdir`、`reportHealth` |
| E1-T2 | 实现 provider registry | DONE | E1-T1 | 可注册多个 provider，并按启用状态执行 |
| E1-T3 | 实现扫描调度 | DONE | E1-T2 | 支持手动扫描和定时扫描，扫描失败不影响其他 provider |
| E1-T4 | 实现 usage normalizer | DONE | E1-T1 | provider 输出可统一转换为 `UsageDaily` |
| E1-T5 | 实现本地 upload queue | DONE | E1-T4 | 网络失败时本地缓存，后续可重试 |
| E1-T6 | 实现 provider health | DONE | E1-T2 | UI/API 可看到每个 provider 的检测状态、最近扫描时间、最近错误 |

验证记录：

```text
2026-04-29:
- src/collector/core.js 实现 provider registry、provider health、usage normalizer。
- 样本扫描返回 claude_code_local 与 codex_local 两个 provider。
- npm test 通过。
```

### E2 Claude Code Provider

目标：内置 `claude_code_local` provider，完成 Claude Code 本地 token 采集。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E2-T1 | 确认 Claude Code 数据目录 | DONE | E1-T1 | macOS / Windows 路径规则可配置、可检测 |
| E2-T2 | 准备 Claude Code 样本 | DONE | E2-T1 | 至少有一个可用于 parser 测试的样本，不包含敏感内容 |
| E2-T3 | 实现 session 扫描 | DONE | E2-T2 | 可枚举 Claude Code session 或 project 数据 |
| E2-T4 | 实现 token 解析 | DONE | E2-T3 | 可输出 input/output/cache/reasoning/total 中可得字段 |
| E2-T5 | 实现工作目录候选解析 | DONE | E2-T3 | 可输出 workdirCandidate；无法识别时明确标记 unknown |
| E2-T6 | 添加 parser 测试 | DONE | E2-T4 | 样本测试稳定通过 |

验证记录：

```text
2026-04-29:
- src/collector/providers/claude-code-local.js 已实现。
- samples/claude/projects/-Users-sky-demo-project/session.jsonl 可解析。
- smoke scan 输出 claude_code totalTokens=3400，workdirDisplayName=claude-project。
```

### E3 Codex Provider

目标：内置 `codex_local` provider，完成 Codex 本地 token 采集。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E3-T1 | 确认 Codex 数据目录 | DONE | E1-T1 | 支持默认 Codex home 与用户自定义路径 |
| E3-T2 | 准备 Codex JSONL 样本 | DONE | E3-T1 | 至少有一个可用于 parser 测试的样本，不包含敏感内容 |
| E3-T3 | 实现 session JSONL 扫描 | DONE | E3-T2 | 可枚举 Codex session 文件 |
| E3-T4 | 实现 token 增量计算 | DONE | E3-T3 | 可从累计 token 事件计算每日增量 |
| E3-T5 | 实现 cwd / project 解析 | DONE | E3-T3 | 可输出 workdirCandidate；无法识别时明确标记 unknown |
| E3-T6 | 添加 parser 测试 | DONE | E3-T4 | 样本测试稳定通过 |

验证记录：

```text
2026-04-29:
- src/collector/providers/codex-local.js 已实现。
- samples/codex/session.jsonl 可解析。
- smoke scan 输出 codex totalTokens=2860，workdirDisplayName=codex-project。
- 真实数据流验证时发现 Codex parser 误读泛化 `total`/累计字段，已收紧为只读取明确 `token_count.last_token_usage`，样本兼容保留。
- 修复 Codex model 识别：真实日志的 model 在 `turn_context`，不是 `token_count`；parser 现在按时间顺序维护当前模型。
- 今日真实明细已验证 model 从 `unknown` 修正为 `gpt-5.5`。
```

### E3.5 Cursor Dashboard Usage Provider

目标：通过用户显式启用的 Cursor dashboard session 采集 Cursor token/model/date；不猜测工作目录。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E3.5-T1 | 确认 Cursor dashboard API 鉴权 | DONE | E1-T1 | 使用 `WorkosCursorSessionToken=<userId>::<accessToken>` 可访问 usage event |
| E3.5-T2 | 实现 Cursor provider | DONE | E3.5-T1 | `cursor_dashboard_usage` 可分页读取 dashboard usage events |
| E3.5-T3 | 实现 token 字段映射 | DONE | E3.5-T2 | 可输出 input/output/cacheRead/cacheWrite/total/model/day |
| E3.5-T4 | 明确 workdir 规则 | DONE | E3.5-T2 | Cursor workdir 展示为 `Cursor · <账号名>`，不上传真实路径，不做目录归因 |
| E3.5-T5 | 设置页启用配置 | DONE | E8 | 用户可启用 Cursor usage，可填写 Workos session token；token 不展示、不上传 |
| E3.5-T6 | 添加 provider 测试 | DONE | E3.5-T3 | 样本 event 映射测试通过 |
| E3.5-T7 | 自动检测 Cursor 本机 token | DONE | E3.5-T2 | macOS/Windows/Linux 读取 Cursor `state.vscdb` 的 `cursorAuth/accessToken`，解析 JWT userId 并构造 Workos cookie |
| E3.5-T8 | Sources 添加 Cursor token 入口 | DONE | E17 | `Add Cursor token` 按钮位于 `Add Claude Code location` 后，支持 token/account JSON 输入并自动启用 Cursor usage |
| E3.5-T9 | 多 Cursor token 与账号 workdir | DONE | E3.5-T8 | 支持多次追加 Cursor token；Cursor 虚拟 workdir 按账号名拆分为 `Cursor · <账号名>` |

验证记录：

```text
2026-04-29:
- 已验证 `Authorization` / `x-cursor-token` / `access_token` cookie 无法访问 dashboard API。
- 已验证 `WorkosCursorSessionToken=<userId>::<accessToken>` 可访问 `get-filtered-usage-events`。
- dashboard event 字段包含 timestamp/model/tokenUsage/chargedCents，不包含 workspace/repo/path/project。
- src/collector/providers/cursor-dashboard-usage.js 已实现。
- Cursor provider 默认关闭，Settings 中显式启用。
- 多个本地 Cursor account source 互相隔离，失效 token 不会阻断其他有效 token。
- 自动检测 Cursor 官方 `state.vscdb`，同时保留 `.antigravity_cockpit/cursor_accounts` 与手工 token。
- Cursor session token 只保存在本地配置，sanitize 后不回显真实 token。
- workdirCandidate 使用 `Cursor · <账号名>`；账号名优先 email，无法识别时退回 `user_xxx`。
- 本机临时启用验证返回 15 条 Cursor 聚合行，样例模型包含 `composer-2-fast`、`claude-opus-4-7-thinking-high`、`claude-4.6-sonnet-medium-thinking`。
- 2026-04-30 重新验证本机 Cursor provider：检测到 `manual_workos_cookie` 与本地 Cursor account source，扫描返回 15 条 Cursor 聚合行，共 175,619,470 tokens。
- 2026-04-30 多账号 workdir 验证：本机 Cursor 行拆分为 `Cursor · user_01JSX3Z74AZ2T1TA4HFXT7H36R` 与 `Cursor · 18838983358@163.com`。
- 验证聚合 usage JSON 不包含 `WorkosCursorSessionToken`。
```

### E4 匿名身份与身份包

目标：实现无需登录的匿名身份，并支持导出/导入到其他设备。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E4-T1 | 生成匿名身份 | DONE | E0-T3 | 本地生成 `participantId` 与 `identityKey` |
| E4-T2 | 生成设备 ID | DONE | E4-T1 | 每台设备生成独立 `deviceId` |
| E4-T3 | 实现 payload 签名 | DONE | E4-T1 | usage batch 可用 `identityKey` 签名 |
| E4-T4 | 实现身份包导出 | DONE | E4-T1 | 可导出包含 `participantId`、签名私钥、昵称的最小身份包 |
| E4-T5 | 实现身份包导入 | DONE | E4-T4 | 导入后沿用同一 `participantId`，新设备生成自己的 `deviceId` |
| E4-T6 | 添加签名校验测试 | DONE | E4-T3 | 篡改 payload 后服务端拒绝 |

验证记录：

```text
2026-04-29:
- collector init 可生成 participantId、identityKey、deviceId。
- export-identity/import-identity 已实现。
- tests/run-tests.js 覆盖身份导出导入与签名生成。
```

### E5 工作目录维护

目标：实现工作目录 hash、系统目录名和 alias 维护，保证公开展示不泄露真实路径。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E5-T1 | 实现路径标准化 | DONE | E1-T4 | macOS / Windows 路径标准化结果稳定 |
| E5-T2 | 实现 workdirHash | DONE | E5-T1 | `sha256(normalizedLocalPath + participantIdSalt)` 可稳定生成 |
| E5-T3 | 实现系统目录名检测 | DONE | E5-T1 | 未设置 alias 时展示路径最后一级或 Git repo name |
| E5-T4 | 实现 alias 维护 | DONE | E5-T3 | 用户可新增、修改、清空 alias |
| E5-T5 | 实现公开展示名预览 | DONE | E5-T4 | 上传前可看到将公开展示的目录名 |
| E5-T6 | 添加隐私校验 | DONE | E5-T2 | 上传 payload 中不包含真实绝对路径 |

验证记录：

```text
2026-04-29:
- workdirHash 使用 normalized path + participantId 生成。
- 未设置 alias 时展示系统检测目录名。
- upload payload 使用 workdirHash/workdirDisplayName，不上传真实绝对路径。
```

### E6 Backend API 与存储

目标：实现匿名设备注册、usage upsert 和公开榜单查询。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E6-T1 | 设计数据库表 | DONE | E0-T3 | 包含 Participant、Device、Workdir、UsageDaily、UploadBatch |
| E6-T2 | 实现设备注册 API | DONE | E6-T1 | `POST /api/devices/register` 可注册身份与设备 |
| E6-T3 | 实现签名校验 | DONE | E4-T3 | 非法签名请求被拒绝 |
| E6-T4 | 实现 usage daily batch API | DONE | E6-T3 | `POST /api/usage/daily-batch` 可 upsert usage |
| E6-T5 | 实现重复上传去重 | DONE | E6-T4 | 同 key 重复上传不重复计数 |
| E6-T6 | 实现榜单查询 API | DONE | E6-T4 | 支持 today、yesterday、7d、toolCode 过滤 |
| E6-T7 | 实现异常数据基础治理 | DONE | E6-T4 | 超阈值数据可标记待审核或隐藏 |

验证记录：

```text
2026-04-29:
- src/backend/server.js 提供 /api/devices/register、/api/usage/daily-batch、/api/leaderboard、/api/health。
- src/backend/store.js 使用 JSON 文件持久化。
- smoke sync 返回 accepted=2 rejected=0。
- 重复 sync 后 leaderboard totalTokens 仍为 6260，没有重复计数。
- 本机真实 collector 同步返回 accepted=117 rejected=0，今日榜单返回 sky 用户。
```

### E7 Web Leaderboard

目标：实现公开社区榜单和用户详情页。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E7-T1 | 实现今日榜页面 | DONE | E6-T6 | 默认展示今日公开排名 |
| E7-T2 | 实现时间范围切换 | DONE | E7-T1 | 支持今日、昨日、近 7 日 |
| E7-T3 | 实现工具筛选 | DONE | E7-T1 | 支持全部、Codex、Claude Code |
| E7-T4 | 实现工作目录榜 | DONE | E6-T6 | 展示公开目录名，不展示真实路径 |
| E7-T5 | 实现用户详情页 | DONE | E6-T6 | 展示每日趋势、工具分布、工作目录分布 |
| E7-T6 | 实现数据质量标记 | DONE | E7-T1 | 页面可区分 exact、partial、estimated 等状态 |

验证记录：

```text
2026-04-29:
- src/web/index.html、styles.css、app.js 已实现公开榜单。
- 支持 today/yesterday/7d 与 all/codex/claude_code 筛选。
- curl http://127.0.0.1:8787/ 返回 Web 页面。
2026-04-29:
- 根据产品反馈移除工具榜/工具筛选。
- 榜单行从 Top workdir 改为展示每个目录的消耗量。
- 新增用户详情接口与页面区域，点击昵称可查看目录消耗、日期趋势和明细行。
- 数据质量标记从 `exact/partial` 改为中文展示：完整字段/部分字段。
- 当前 Web 页迁移为管理员查看页 `/admin.html`，保留目录消耗、数据质量和用户详情。
- 根路径 `/` 改为普通用户公开榜，只展示用户名、总量、各模型量三列。
- 新增 `/api/public-leaderboard`，服务端聚合普通榜需要的 participant/model totals。
- Web 查询范围新增本月、上月、自定义开始/结束日期，普通榜和管理员页共用该查询能力。
```

### E8 Desktop UI

目标：实现本地 collector 的可操作界面。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E8-T1 | 首次设置页 | DONE | E4-T1 | 用户可设置昵称、生成身份、选择是否公开上传 |
| E8-T2 | 身份包导入导出页 | DONE | E4-T4 | 可导出身份包，可导入已有身份包 |
| E8-T3 | 数据源状态页 | DONE | E1-T6 | 展示 Codex / Claude Code provider 检测状态 |
| E8-T4 | 工作目录页 | DONE | E5-T5 | 展示检测目录、公开展示名、alias 编辑 |
| E8-T5 | 今日预览页 | DONE | E1-T4 | 上传前可预览今日 token 聚合 |
| E8-T6 | 同步状态页 | DONE | E1-T5 | 展示最近同步时间、失败原因、重试按钮 |

验证记录：

```text
2026-04-29:
- 已实现 Electron 桌面 UI。
- 覆盖首次设置、身份包导入导出、数据源状态、今日预览、同步。
- `npm run desktop:smoke` 通过，桌面主进程可加载 collector core 与 provider registry。
- 本机已启动打包后的 macOS 客户端，主进程 PID 8132。
- 修复 Preview 行数过多时左侧菜单随右侧内容滚动的问题，改为左侧固定、右侧独立滚动。
- 重新打包并启动 macOS 客户端，主进程 PID 11841。
- 按用户视角重构客户端信息架构：只保留「今日数据」和「设置」两个主视图。
- 今日数据展示本地每日总量、目录消耗、来源检测和同步入口。
- 设置页承载昵称/API、身份导入导出和来源检测刷新。
- 重新打包并启动 macOS 客户端，主进程 PID 13731。
- 按最新产品反馈调整 Today：移除 Source status 与 Data quality，只展示今日总量、Workdir 消耗、模型消耗。
- 设置页不展示 Identity 区域或身份详情；匿名身份迁移保留为 profile 导入/导出操作。
- Local sources 支持为 Codex / Claude Code 添加其他本地位置，并在设置页展示当前 source locations。
- 验证打包后窗口：Today 大数字不挤压 Refresh，Settings source 卡片与按钮间距正常。
- 设置页支持后台定时刷新开关与刷新间隔；配置 API base URL 时后台任务自动上报最新数据，未配置 API 时只刷新本地数据。
- 保存设置不再重新生成匿名身份，只更新昵称、API、后台刷新配置。
- 新增 Trend 页，位于 Today 与 Settings 之间，按日期展示用户每日 token 量、模型列表、input/output/reasoning/cache read/total。
- Trend 支持 chart/table 展示模式，默认 chart。
- 客户端增加本地 usage cache，Today/Trend 页面默认读缓存，后台刷新/同步负责更新缓存，减少每次页面查询都实时扫描日志。
- Settings 支持对 workdir 配置 alias，保存后刷新本地 cache 并更新展示名。
- Settings 支持启用 Cursor dashboard usage；Workos session token 仅本地保存，UI 不回显真实值。
- `npm test` 与 `npm run desktop:smoke` 通过。
```

### E9 跨平台打包

目标：让 macOS 与 Windows 都能安装或运行 MVP collector。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E9-T1 | macOS 打包 | DONE | E8 | macOS 可安装或直接运行 |
| E9-T2 | Windows 打包 | DONE | E8 | Windows 可安装或直接运行 |
| E9-T3 | macOS 路径验证 | DONE | E2/E3/E5 | macOS 真实路径可扫描、hash、展示 |
| E9-T4 | Windows 路径验证 | BLOCKED | E2/E3/E5 | Windows x64 包已生成；真实路径扫描需 Windows 主机执行 |
| E9-T5 | 打包产物 smoke | DONE | E9-T1/E9-T2 | 打包产物可完成首次设置、扫描、上传 |

验证记录：

```text
2026-04-29:
- `npm run package:all` 已生成 macOS arm64 app 与 Windows x64 可运行目录。
- 已生成 `dist/AI Token League-darwin-arm64.zip`。
- 已生成 `dist/AI Token League-win32-x64.zip`。
- macOS 打包产物执行 `--desktop-smoke` 通过。
- Windows exe 已确认为 PE32+ x86-64 GUI 可执行文件；当前 macOS 环境无 Windows 运行时，无法本机执行 Windows E2E。
- Codex parser 修复后已重新打包 macOS 与 Windows 分发包。
- 客户端 Today/Settings 调整后已重新生成 macOS / Windows 分发包。
- macOS 打包产物 `--desktop-smoke` 通过。
- Windows exe 已再次确认为 PE32+ x86-64 GUI 可执行文件。
```

### E10 发布验证

目标：完成 MVP 发布前的端到端验证。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E10-T1 | 编写 smoke checklist | DONE | E6/E7/E8/E9 | checklist 覆盖身份、采集、目录、上传、榜单 |
| E10-T2 | macOS E2E 验证 | DONE | E10-T1 | macOS 完成 collector 到 web 榜单闭环 |
| E10-T3 | Windows E2E 验证 | BLOCKED | E10-T1 | Windows x64 包已生成；端到端执行需 Windows 主机 |
| E10-T4 | 隐私 payload 检查 | DONE | E10-T2 | 上传 payload 不包含 prompt、response、代码、真实路径 |
| E10-T5 | 重复上传检查 | DONE | E6-T5 | 重复上传不会重复计数 |
| E10-T6 | 发布说明 | DONE | E10-T2 | 输出 MVP 范围、已知限制、后续计划 |

验证记录：

```text
2026-04-29:
- `npm test` 通过。
- `npm run desktop:smoke` 通过。
- macOS 打包产物 `--desktop-smoke` 通过。
- `npm run package:all` 通过。
- smoke server 启动于 http://127.0.0.1:8787。
- collector init/scan/sync 通过。
- leaderboard API 返回 smoke 用户 totalTokens=6260。
- `smoke-checklist.md` 已补充。
2026-04-29:
- 本机服务端已启动，监听 PID 6561。
- 打包后的 macOS 客户端已启动，PID 8132。
- 真实 collector 扫描命中 `~/.codex` 和 `~/.claude/projects`，上传 items 不包含 `/Users/sky` 真实路径。
- 真实同步 accepted=117 rejected=0。
- 今日榜单返回 sky，totalTokens=84002657，topWorkdirAlias=todo-list-app。
2026-04-29:
- 最新本地服务端已启动，监听 PID 20095，地址 http://127.0.0.1:8787。
- 最新打包后的 macOS 客户端已启动，PID 23554。
- `npm test`、`npm run desktop:smoke`、macOS 打包产物 `--desktop-smoke` 均通过。
- macOS / Windows 分发 zip 已重新生成。
```

### E11 Web/Trend 交互模型重构

目标：把公开榜单、用户详情、管理员查询和客户端 Trend 拆成清晰的产品层级，避免一个筛选器同时承担排名、明细和运营排查三种职责。

核心口径：

```text
period = 榜单排名周期，只用于公开榜单，保证所有用户同周期比较。
grain = 趋势聚合粒度，用于用户详情、管理员页、客户端 Trend。
from/to = 明细查询边界，只用于详情和管理员查询，不放在公开榜首页。
```

目标页面：

```text
/            普通公开榜，只展示用户名、总量、各模型量
/participant 用户详情，按 day/week/month + range 查询趋势
/admin.html  管理员查看页，支持更细筛选和运维字段
Desktop      Today / Trend / Settings
```

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E11-T1 | 统一 API 查询参数 | DONE | E6 | 服务端支持 `period`、`grain`、`from/to`，并保留清晰兼容边界 |
| E11-T2 | 重构普通公开榜筛选 | DONE | E11-T1 | `/` 只提供 today/yesterday/this_week/last_week/this_month/last_month 周期切换，不提供自定义日期 |
| E11-T3 | 实现用户详情趋势页 | DONE | E11-T1 | 点击用户后可按 day/week/month 与预设时间查看 chart/table |
| E11-T4 | 重构管理员查看页 | DONE | E11-T1 | `/admin.html` 支持用户、粒度、时间范围筛选，并展示目录/来源/质量等运维字段 |
| E11-T5 | 修复客户端 Trend 交互样式 | DONE | E8 | chart/table segmented control 稳定，默认 chart；表格大数据量不影响左侧导航和切换控件 |
| E11-T6 | 补充端到端验证 | DONE | E11-T2/E11-T3/E11-T4/E11-T5 | 覆盖公开榜周期、用户详情趋势、管理员自定义查询、客户端 Trend chart/table |

当前实现差距：

已完成：

- Store/API 支持 `period`、`grain`、`range + start/end` 查询模型。
- `/api/public-leaderboard?period=this_month` 返回公开榜三列所需数据，并包含 `participantId` 用于详情入口。
- `/api/participants/:id/trend?grain=week&range=last30` 返回用户趋势聚合。
- `/api/admin/usage?grain=day&range=month` 返回管理员聚合、用户选项、目录/模型/来源/质量字段。
- `/` 普通榜移除自定义日期，只保留统一排名周期。
- `/admin.html` 改为管理员聚合查询页，支持粒度、范围、用户和自定义日期。
- Desktop Trend 新增 day/week/month、7/30 天、本月/上月、chart/table 控制，并补齐 Cache Write 列。

验证记录：

```text
2026-04-29:
- npm test 通过，覆盖 period public leaderboard、participant trend、admin usage。
- npm run desktop:smoke 通过。
- node src/backend/server.js --smoke 通过。
- 本地服务已重启，http://127.0.0.1:8787 可访问。
- curl /api/public-leaderboard?period=this_month 返回 sky 与模型 breakdown。
- curl /api/participants/<sky>/trend?grain=week&range=last30 返回周聚合与 nickname=sky。
- curl /api/admin/usage?grain=day&range=month 返回 21 条真实聚合行。
- in-app browser 验证 `/` 普通公开榜无 console error。
- in-app browser 验证 `/admin.html` 管理员页无 console error。
- npm run package:all 通过，重新生成 macOS arm64 与 Windows x64 分发包。
- macOS 打包产物 `--desktop-smoke` 通过；Windows exe 确认为 PE32+ x86-64 GUI。
```

### E12 存储模型与追溯能力硬化

目标：按 `product-design.md` 第 12 章，把当前 MVP 的展示型数据流升级为可追溯、可分析、性能可控的本地/远端事实数据模型。

边界：

- 产品 UI 可以继续保持当前 Today / Trend / Public / Admin 形态。
- 存储层必须保留 `day + participant + device + tool + provider + workdirHash + model + token fields` 的每日标准化明细。
- 本地和远端都不能保存 prompt、response、代码、真实绝对路径、Cursor session token、identity private key 或 provider raw secret。
- 查询聚合、排行榜、趋势图、管理员视图都只能是从事实表派生，不能反过来替代事实表。

当前实现差距：

已完成：

- Shared schema 增加存储版本、缓存版本、上传隐私黑名单和 `publicUsageItem` 追溯字段标准化。
- 本地 `usage-cache.json` 写入 `cacheVersion`、`scannedAt`、`rowCount`、`sourceFingerprint`、`sourceIndex`。
- Desktop sync 增加 `upload-queue.json` 离线队列，网络失败入队，后续手动/后台 sync 自动重试并清理成功项。
- Codex、Claude Code、Cursor Dashboard Usage 均输出 `rawSourceRef`、`providerVersion`、`parserVersion`、`sourceFingerprint`。
- 本地 scan 支持基于 source mtime/size fingerprint 的增量复用，未变化本地 source 不重新 parse。
- Cursor 虚拟 workdir 改为稳定 `virtual:cursor-dashboard:Cursor`，避免不同运行目录产生不同 hash。
- 服务端 `UsageDaily` 保存追溯字段，并在启动时为历史 legacy 行补不可逆 legacy fingerprint。
- 新增 `/api/admin/quality`，输出 source quality、unknown model/workdir、异常日总量、多设备差异等分析数据。
- `aggregateCache` 用于公开榜和管理员聚合查询加速；上传或设备资料变更时失效，删除缓存不影响事实表正确性。
- 测试覆盖禁止上传字段、source fingerprint、增量复用、远端质量分析和聚合缓存可删除性。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E12-T1 | 固化 shared storage schema | DONE | E0/E11 | `LocalUsageRow`、`LocalUsageCache`、`UploadPayloadItem`、`UsageDaily`、`UploadBatch` 字段在 shared schema 中显式定义，测试覆盖禁止上传字段 |
| E12-T2 | 本地 cache 元数据升级 | DONE | E8 | `usage-cache.json` 包含 `cacheVersion`、`scannedAt`、`sourceFingerprint`、row count；Today/Trend 只读 cache 不触发 scan |
| E12-T3 | 本地 upload queue 完整化 | DONE | E1/E6 | 网络失败时写入 `upload-queue.json`；后台/手动 sync 会重试；成功后标记或清理；重复 batch 不重复上传 |
| E12-T4 | Provider source fingerprint | DONE | E1/E2/E3/E3.5 | Codex/Claude/Cursor provider 输出不可反推隐私的 `rawSourceRef`、`providerVersion`、`parserVersion`、`sourceFingerprint` |
| E12-T5 | 增量扫描能力 | DONE | E12-T4 | 本地 scan 可按文件 mtime/size 或 API 时间窗口跳过未变化 source；全量扫描只在 force refresh 时执行 |
| E12-T6 | 远端事实表字段补齐 | DONE | E6/E12-T1 | 服务端保存 `rawSourceRef`、`providerVersion`、`parserVersion`、`sourceFingerprint`；仍不保存真实路径和敏感内容 |
| E12-T7 | 远端分析接口补强 | DONE | E12-T6 | 管理员可查询 sourceQuality ratio、unknown model/workdir ratio、异常 daily total、多设备差异 |
| E12-T8 | 物化聚合缓存策略 | DONE | E12-T6 | 定义并实现可删除的查询加速缓存；删除缓存不影响 `UsageDaily` 事实表和查询正确性 |
| E12-T9 | 性能回归验证 | DONE | E12-T2/E12-T5 | 构造大样本验证：切换 Today/Trend 不扫描；默认 30 天趋势响应稳定；后台 refresh 不并发执行 |
| E12-T10 | 隐私与追溯验证 | DONE | E12-T3/E12-T6 | 测试证明本地 cache、upload queue、远端 DB 不含真实路径、prompt、response、Cursor token、identity private key |

验证矩阵：

| 验证项 | 方式 | 完成标准 |
| --- | --- | --- |
| 本地 cache 性能 | 大样本 + UI 切换 | Today/Trend 切换不调用 provider scan |
| 本地增量扫描 | 修改/不修改样本源文件 | 未变化 source 被跳过，force refresh 可全量重扫 |
| 离线队列 | 关闭服务端后 sync | batch 写入 queue；服务恢复后上传成功且不重复计数 |
| 上云颗粒度 | inspect upload payload / DB | 保留 day/device/provider/workdir/model/token 字段 |
| 隐私边界 | grep cache/queue/db | 不出现真实绝对路径、prompt、response、Cursor token、identity private key |
| 管理员分析 | API test | sourceQuality、unknown 比率、异常总量、多设备差异可查询 |

验证记录：

```text
2026-04-29:
- npm test 通过，覆盖 shared schema 隐私黑名单、provider source fingerprint、增量复用、admin quality、aggregateCache 可删除性。
- npm run desktop:smoke 通过，Electron 主进程可加载 config/core/providers。
- 基于本机真实数据 scan：173 条日维度标准化明细，2063 个 source，Codex 12,677,357,889 tokens，Cursor 175,619,470 tokens，missing sourceFingerprint=0，unknown model=0。
- 基于首次 scan 的 sourceIndex 再次 scan：本地 Claude 1674/1674 个 source 复用，Codex 389/389 个 source 复用，二次耗时约 1016ms。
- npm run collector -- sync 上传本机真实数据：accepted=173，rejected=0。
- curl /api/admin/quality?range=month 返回 rows=106，missingSourceFingerprintRows=0，unknownModelRows=0，unknownWorkdirRows=0。
- inspect data/db.json：usageRows=174，missingSourceFingerprint=0，legacyRows=1，forbiddenHits=[]。
- curl /api/public-leaderboard?period=today 返回 sky 今日总量与模型 breakdown。
- 打包后的 macOS 客户端手动 Refresh 写入新 cache：cacheVersion=2，rowCount=173，sourceIndexCount=2063，sourceFingerprint=true。
- 第二次客户端 Refresh 命中增量复用：Claude 1674/1674 source 复用，Codex 388/389 source 复用，只有当前活跃 Codex source 重新解析。
- 修复客户端 Refresh 未传 `force=true` 的问题：导航切换继续读 cache，手动 Refresh 才强制刷新。
```

优先级建议：

```text
P0: E12-T1, E12-T2, E12-T3, E12-T10
P1: E12-T4, E12-T5, E12-T6, E12-T9
P2: E12-T7, E12-T8
```

### E13 展示可读性与详情页去重

目标：解决当前 Web/客户端 token 长整数不直观、详情页 chart/table 信息重复、时间顺序不符合阅读习惯的问题。

产品决定：

- 排名、聚合、去重仍使用原始 `totalTokens` 整数。
- UI 主读数默认使用短单位：`1.20亿`、`8045万`。
- 原始 token 放在 tooltip/title、展开详情或 Raw table 中。
- Chart 与 Table 默认互斥，不同时展开；详情页默认 Chart。
- Chart 时间轴保持时间正序，旧日期在左、最新日期在右。
- Table 日期倒序，最新 period 在最上方。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E13-T1 | Token 数值格式化工具 | DONE | E11 | 新增统一 `formatTokenCompact`，支持中文 `万/亿` 与 raw tooltip；排序仍用原始整数 |
| E13-T2 | Web 公开榜短单位展示 | DONE | E13-T1 | `/` 总量和模型量使用短单位，hover/title 可看到完整 token |
| E13-T3 | Web 用户详情去重 | DONE | E11/E13-T1 | 用户详情默认只展示 chart；table 进入 Raw data 折叠区或 segmented control，不与 chart 同屏重复 |
| E13-T4 | Web 日期顺序优化 | DONE | E13-T3 | chart old->new，table new->old；最新点或最新行有明确视觉提示 |
| E13-T5 | 客户端 Trend 顺序与单位 | DONE | E13-T1 | Desktop Trend chart old->new，table new->old，token 主读数使用短单位 |
| E13-T6 | 管理员页 Raw/Compact 切换 | DONE | E13-T1 | Admin 默认 compact，可切 raw；导出/排查仍能看到完整整数 |
| E13-T7 | 视觉回归验证 | DONE | E13-T2/E13-T5 | in-app browser 验证 `/`、用户详情、`/admin.html`；客户端验证 Today/Trend 无重叠、无重复展示 |

验证矩阵：

| 验证项 | 方式 | 完成标准 |
| --- | --- | --- |
| 排序正确性 | 构造不同 token 量 | UI 短单位不影响排序 |
| 可读性 | 截图检查 | 长整数不作为主视觉锚点 |
| 可核对性 | hover/title 或 Raw table | 能看到完整 token |
| 时间顺序 | Web + Desktop | chart 左旧右新，table 最新在上 |
| 信息去重 | 用户详情 | 默认不同时展示 chart 与 table |

优先级建议：

```text
P0: E13-T1, E13-T2, E13-T3, E13-T4, E13-T5
P1: E13-T6, E13-T7
```

验证记录：

```text
2026-04-29:
- npm test 通过，覆盖 `formatTokenCompact(120456222)=1.20亿`、raw tooltip 与价格格式化。
- Chrome 验证 `/`：公开榜总量与模型量展示短单位，title 保留完整 token。
- Chrome 验证用户详情：默认只展示 chart；Raw data 为折叠区；chart old->new。
- Chrome 验证 `/admin.html`：默认 compact，Raw tokens 可切换；列表日期倒序。
- 打包后 macOS 客户端验证 Today/Trend：Today 主读数为短单位；Trend chart old->new，Table new->old。
```

### E26 Total Token 主口径修正

目标：修复全局展示/排行 total token 口径，使 total 正确包含 cache，但不包含 reasoning。

产品决定：

- 所有展示、排行、趋势、Admin quality 和 pricing coverage 的 `totalTokens` 主口径统一为 `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`。
- `reasoningTokens` 保留在 composition 和 cost 明细里，不进入 total。
- provider 只提供 total、无法拆分 input/output/cache 的 partial 行不再贡献展示/排序 total，避免旧 provider total 污染主口径。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E26-T1 | 共享 schema 归一化 | DONE | E12/E14 | `publicUsageItem` 和上传入口把 total 归一为 input+output+cache |
| E26-T2 | Provider 采集口径修正 | DONE | E26-T1 | Claude/Codex/Cursor provider 把 cache 计入 total，但不把 reasoning 计入 total |
| E26-T3 | 历史数据与本地缓存修正 | DONE | E26-T1 | JSON/MySQL 历史行和 Desktop snapshot 读取时统一归一为 input+output+cache |
| E26-T4 | 文档与测试回归 | DONE | E26-T1 | 测试断言 total=input+output+cache；设计文档同步新 invariant |

### E14 估算成本能力

目标：基于标准化 token 明细二次计算估算成本，让成本成为可选辅助信息，而不是公开榜主排序口径。

产品决定：

- `totalTokens` 仍是公开榜默认排序和主指标。
- 成本默认隐藏；用户或管理员显式打开后展示。
- 成本由服务端或共享 pricing resolver 根据价格表计算，客户端不上报可信最终成本。
- 价格来源参考 ccusage 读取的 LiteLLM 价格表。
- 价格表版本必须可追溯，历史成本允许按新价格表重算，但原始 token 事实表不变。

成本质量：

```text
exact_price      model + token type 精确匹配价格表
estimated_price  model 通过 alias/fallback 匹配价格表
unknown_price    有模型缺少稳定价格；如果聚合内仍有可定价模型，则展示已知部分成本并标记 *
```

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E14-T1 | Pricing 数据源调研与固化 | DONE | E12 | 明确 LiteLLM/ccusage 价格表读取方式、缓存位置、版本字段和更新策略 |
| E14-T2 | Model alias 映射规则 | DONE | E14-T1 | Codex/Claude/Cursor model 名称可映射到 pricing key；无法映射时输出 `unknown_price` |
| E14-T3 | Cost resolver | DONE | E14-T1/E14-T2 | 按 `input/output/cacheRead/cacheWrite/reasoning` 计算 `estimatedCostUsd` 和 `costQuality` |
| E14-T4 | 服务端重算接口或任务 | DONE | E14-T3 | 可对已有 `UsageDaily` 重算成本，写入 `estimatedCostUsd/costQuality/pricingVersion` |
| E14-T5 | API 输出成本字段 | DONE | E14-T4 | public/detail/admin API 在显式参数下返回成本字段，默认不返回或不展示 |
| E14-T6 | UI 可选展示成本 | DONE | E14-T5/E13 | Settings/Admin 增加 Show estimated cost；成本旁展示 estimated/quality 标记 |
| E14-T7 | 成本验证样本 | DONE | E14-T3 | 构造价格表和多 token type 样本，验证金额、质量标记和未知模型处理 |
| E14-T8 | 成本隐私与误导防护 | DONE | E14-T6 | 成本为空展示 `-`，不展示 `$0.00`；UI 明确为 estimated，不影响排名 |
| E14-T9 | 自定义模型价格维护 | DONE | E14-T4 | Admin 可查看缺价模型、补充 `$ / 1M tokens` 价格、保存后自动重算历史成本 |
| E14-T10 | 部分成本展示 | DONE | E14-T5/E14-T9 | 聚合中部分模型缺价时展示已知成本并标记 `*`，同时返回缺价模型和 token 量 |
| E14-T11 | 客户端价格表 API | DONE | E14-T9 | 新增 `GET /api/model-prices`，客户端可只读服务端内置价格、自定义价格和缺价模型 |
| E14-T12 | 客户端 Today 成本 | DONE | E14-T11 | Desktop Settings 开启成本后，Today 总额、目录消耗、模型消耗按服务端价格体系展示成本 |
| E14-T13 | 客户端 Trend 成本 | DONE | E14-T11 | Desktop Trend chart/table 按服务端价格体系展示 period 成本，支持 `*` 缺价标记和 fallback 来源提示 |

验证矩阵：

| 验证项 | 方式 | 完成标准 |
| --- | --- | --- |
| 价格匹配 | 单元测试 | exact/alias/unknown 三类模型都覆盖 |
| token type 计算 | 构造样本 | input/output/cache/reasoning 分项正确计价 |
| 历史重算 | API/脚本 | 改 pricingVersion 后可重算，不改变 token 明细 |
| UI 默认状态 | Web + Desktop | 默认不显示成本，不影响排行榜；开启后 Today/Trend 使用服务端价格体系 |
| 防误导 | UI + 测试 | 全部缺价显示 `-`；部分缺价显示已知成本 + `*` + 缺价模型 |
| 价格 API | API smoke | `GET /api/model-prices` 返回 builtin/custom/missingModels |

优先级建议：

```text
P0: E14-T1, E14-T2, E14-T3, E14-T7
P1: E14-T4, E14-T5
P2: E14-T6, E14-T8, E14-T9, E14-T10, E14-T11, E14-T12, E14-T13
```

验证记录：

```text
2026-04-29:
- Pricing resolver 使用 LiteLLM/ccusage 兼容字段名，内置 fallback 价格表和 `pricingVersion=litellm-compatible-2026-04-29-fallback`。
- npm test 覆盖 exact_price、estimated_price、unknown_price。
- `curl /api/public-leaderboard?period=today` 默认不返回成本字段。
- `curl /api/public-leaderboard?period=today&includeCost=1` 返回 `estimatedCostUsd/costQuality/pricingVersion`。
- `curl /api/admin/usage?grain=day&range=month&includeCost=1` 返回管理员成本聚合。
- `POST /api/admin/recalculate-costs` 返回 `updated=174`，可重算历史 UsageDaily。
- 聚合中只有部分模型缺价时返回已知部分 `estimatedCostUsd`、`costQuality=unknown_price`、`missingPriceModels/missingPriceTokens`，UI 展示 `*`。
- 聚合中全部模型缺价时返回 `estimatedCostUsd=null`，UI 展示 `-`。
- `GET /api/admin/model-prices` 可查看内置价格、用户自定义价格和当前缺价模型；本机缺价包含 `composer-2-fast`、`default`、`codex-default`。
- `POST /api/admin/model-prices` 支持补充模型 `$ / 1M tokens` 价格，保存后自动 `recalculateCosts`。
- `GET /api/model-prices` 返回服务端价格体系，供客户端 Today/Trend 本地成本计算使用。
- Desktop 通过 `pricing:model-prices` IPC 拉取服务端价格；API 不可用时回退本地 fallback，并在成本 tooltip 标记来源。
- Desktop Today 增加 Est. cost 卡片，Workdir/Model consumption 行展示对应成本。
- Desktop Trend chart/table 成本列使用服务端价格体系，支持 `*` 缺价标记和全部缺价 `-`。
- Chrome 验证公开榜和管理员页 Estimated cost 开关；默认隐藏，开启后展示估算成本/质量 tooltip。
- Desktop Settings 增加 Show estimated cost；本地 Trend 可选展示估算成本。
```

### E15 Web/客户端产品语义重构

目标：修正 E11 后遗留的“控件存在但产品意义不足”问题。公开详情页先解释用户在当前榜单周期中的排名构成；客户端 Trend 只提供有明确分析意义的使用复盘视图，不再暴露任意 `grain + range` 组合。

现状证据：

- Web 普通榜 `Yesterday` 点击用户后，详情仍默认展示最近 30 天 `day view · 2026-03-31 to 2026-04-29`，和昨日榜单语境不一致。
- Web 详情趋势只展示日期与总量，缺少当前榜单周期内的模型/目录构成，对解释排名帮助有限。
- 客户端 Trend 允许 `This month + Week`，页面标题仍是 `Daily token usage` / `Daily totals`，文案与所选视图冲突。
- 客户端 Trend Table 默认展示 Input/Output/Reasoning/Cache 等明细列，适合核对，不适合作为默认复盘主视图。

产品决定：

- 公开榜 `/` 继续只承担统一周期排名，不加自定义日期，不做工具榜。
- 用户详情页拆成 `Period detail` 和 `History trend`：
  - `Period detail` 默认打开，并绑定用户从公开榜点击时的 `period`。
  - 单日榜只展示当天模型/目录/来源构成，不展示趋势图。
  - 周/月榜展示周期内日分布或周分布，用于解释周期内贡献。
  - `History trend` 是主动切换后的二级分析。
- 客户端 Trend 拆成三种语义视图：
  - `Daily`：最近 30 天。
  - `Weekly`：最近 12 周。
  - `Monthly`：最近 12 个月。
- 客户端 Trend 默认 Chart；Table 是核对视图，默认列收敛为 Period、Total Tokens、Model Summary、Workdir Summary、Est. Cost，展开后再看 token 字段明细。
- 管理员页保持表格主视图，自定义时间查询只属于管理员和二级分析，不进入普通用户默认路径。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E15-T1 | 用户详情 API 支持榜单上下文 | DONE | E11/E12 | 详情接口能根据 `period` 返回 selected-period summary、period rows、model/workdir/source breakdown；History trend 仍走独立查询 |
| E15-T2 | Web 公开榜详情入口传递 period | DONE | E15-T1 | 从 Today/Yesterday/Week/Month 榜点击用户后，详情标题和数据范围与榜单周期一致 |
| E15-T3 | Web 用户详情改为 Period detail 默认页 | DONE | E15-T1 | 单日榜默认展示构成，不展示趋势；周/月榜展示周期内分布；History trend 需要用户主动切换 |
| E15-T4 | Web 详情构成卡片 | DONE | E15-T1 | 详情页展示模型、目录、来源构成；目录只展示公开名，不展示真实路径 |
| E15-T5 | 客户端 Trend 视图模型收敛 | DONE | E8/E12 | 移除任意 grain/range 组合，改为 Daily 30d、Weekly 12w、Monthly 12m 三个语义视图 |
| E15-T6 | 客户端 Trend 文案与表格收敛 | DONE | E15-T5 | 标题、摘要、图表和表格列与当前视图一致；Table 默认不展示过多 token 字段，明细进入展开行或 Raw mode |
| E15-T7 | 视觉与数据验证 | DONE | E15-T2/E15-T6 | 截图验证 Web Today/Yesterday 详情、Week/Month 详情、Desktop Daily/Weekly/Monthly；API 返回与页面范围一致 |

验证矩阵：

| 验证项 | 方式 | 完成标准 |
| --- | --- | --- |
| 榜单上下文一致 | Web 点击 Today/Yesterday 用户 | 详情默认周期与榜单周期一致，不出现默认 30 天趋势 |
| 单日详情意义 | Web Today/Yesterday | 只展示构成摘要，不展示趋势图 |
| 周/月详情意义 | Web this_week/this_month | 展示周期内分布和构成，支持切换 History trend |
| 客户端 Trend 语义 | Desktop 三个视图 | Daily/Weekly/Monthly 的范围和标题一致，无无意义组合 |
| 明细可核对 | Web Raw / Desktop Table | 可看到完整 token 字段和成本质量，但不作为默认视觉锚点 |

验证记录：

```text
2026-04-30:
- `GET /api/participants/:id?period=yesterday` 返回 selectedPeriod=yesterday、rank=1、from=to=2026-04-28、models/workdirs/providers breakdown 和 periodRows。
- `GET /api/participants/:id/trend?grain=week&range=last12_weeks` 返回自然周窗口，避免 84 天回推造成 13 个周桶。
- Web 验证 Today/Yesterday 点击用户后，默认标题为 `sky · Today` / `sky · Yesterday`，单日详情只展示构成和 “not a trend chart” 提示。
- Web 验证 History trend 需要主动切换；Daily/Weekly/Monthly 子筛选只在 History tab 可见。
- 第二轮自我迭代修复 `[hidden]` 被 segmented 样式覆盖导致 History 子筛选在 Period detail 下可见的问题。
- Desktop Trend 移除 grain/range 任意组合，改为 Daily/Weekly/Monthly；Table 列收敛为 Period、Total Tokens、Models、Workdirs、Est. Cost。
- `node --check`、`npm test`、`npm run desktop:smoke`、`node src/backend/server.js --smoke` 均通过。
```

### E16 Web/客户端详情与筛选交互优化

目标：解决 E15 后暴露出的承载形态和趋势可读性问题。详情页不再拉长公开榜首页，Web/客户端趋势不再用长列表承担图表职责，Admin 筛选从“多组独立控件”改为“时间窗口优先”的联动模型。

现状证据：

- This month 详情中 `period-chart` 按日一行展示，数据多后需要滚动才能看完整，无法一眼判断趋势。
- 公开榜点击 `sky` 后详情插入榜单下方，榜单数据和详情数据都变长时会形成无限下滚。
- Admin 当前同时暴露 `Day/Week/Month`、`This month/Last month/30 days`、开始日期、结束日期和 Apply，用户需要自己理解控件关系。
- 客户端 Trend 默认 Chart 是一行一个 period 的列表，默认窗口下只能完整看到日期和 token，模型、workdir、成本被截断；第一屏从最旧日期开始，不符合“先看最近价值”的复盘习惯。

产品决定：

- 公开榜用户详情改为 Drawer / Modal，不再 inline 展开。
  - 桌面宽屏优先右侧抽屉。
  - 小屏使用全屏 modal。
  - 弹窗内部独立滚动，关闭后保留榜单滚动位置。
- Period detail 中周/月趋势改为紧凑图表，不再一天一行作为主视图。
  - 固定高度展示 sparkline / compact bar chart。
  - 标记最大值、最新点、总量。
  - 展示 Top 5 日期贡献；完整明细进入 Raw data。
- Admin 筛选改为时间范围优先：
  - Date range picker 展示当前范围，例如 `Apr 01 - Apr 30`。
  - Quick ranges：`1d / 7d / 30d / MTD / Last month`。
  - Grain 默认为 Auto，按范围自动选择 day/week/month；高级模式可手动改。
  - 用户筛选、Raw tokens、Estimated cost 保留，但视觉层级低于时间范围。
- 客户端 Trend Chart 改为固定高度趋势图 + 摘要 + 最近贡献，不再用长列表充当图表。
  - Chart 时间轴旧到新，但最新点必须在首屏可见并高亮。
  - 最近贡献列表倒序，默认展示最近 5 个 period。
  - Table 模式倒序，最近数据第一行。
  - 模型、workdir、成本拆成摘要或 tooltip，默认窗口宽度下不能只剩省略号。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E16-T1 | Web 用户详情弹窗/抽屉设计落地 | DONE | E15 | 点击榜单用户后打开 drawer/modal，不改变页面主滚动；关闭后回到榜单 |
| E16-T2 | 详情内部滚动与响应式 | DONE | E16-T1 | 桌面抽屉、小屏全屏 modal；详情内容只在弹窗内部滚动 |
| E16-T3 | Period compact chart | DONE | E16-T1 | 周/月周期内趋势固定高度展示，标记最大值和最新点，不再一天一行撑开页面 |
| E16-T4 | Top 日期贡献模块 | DONE | E16-T3 | 周/月详情展示 Top 5 日期贡献；完整明细保留在 Raw data |
| E16-T5 | Admin quick range 筛选 | DONE | E15 | Admin 使用 `1d/7d/30d/MTD/Last month` + date range picker，替代独立 range 按钮 |
| E16-T6 | Admin grain auto 联动 | DONE | E16-T5 | 1d/7d/30d/MTD 默认 day；Last month 默认 week；自定义范围按天数自动 day/week/month |
| E16-T7 | 客户端 Trend compact chart | DONE | E15 | Chart 模式固定高度展示趋势，最新点和峰值点可见；不再一行一个 period 撑开页面 |
| E16-T8 | 客户端 Trend 最近贡献与倒序表格 | DONE | E16-T7 | Chart 下展示最近 5 个 period，newest first；Table 模式也 newest first |
| E16-T9 | 客户端 Trend 信息密度优化 | DONE | E16-T7 | 默认窗口宽度下能看到总量、Top model、Top workdir、成本状态，不只显示省略号 |
| E16-T10 | 交互验证 | DONE | E16-T1/E16-T9 | 验证详情弹窗无页面无限下滚；Admin quick range 与 API 查询参数一致；客户端 Trend 首屏可看到最近数据和趋势 |

验证矩阵：

| 验证项 | 方式 | 完成标准 |
| --- | --- | --- |
| 详情不拉长首页 | 点击公开榜用户 | body 主滚动不因详情内容继续增长，详情在 drawer/modal 内滚动 |
| 月榜趋势可读 | This month 详情 | 首屏可看到 summary、compact chart 和 Top 日期贡献 |
| Raw 可追溯 | 展开 Raw data | 能看到完整日明细，不丢失核对能力 |
| Admin 时间筛选 | 点击 1d/7d/30d/MTD/Last month | 日期范围、grain 和请求参数同步变化 |
| 自定义范围联动 | 选择开始/结束日期 | 小于等于 31 天 day，32-120 天 week，超过 120 天 month |
| 客户端 Trend 首屏价值 | 打开 Desktop Trend | 首屏可看到最新 period、峰值、总体趋势、Top model/workdir 和成本状态 |
| 客户端 Trend 顺序 | Chart + Table | Chart 趋势 old->new；Recent 和 Table newest first |

实现记录：

```text
- 公开榜详情改为右侧 drawer，增加 Close；移动端使用全屏 modal，同一页面不再 inline 拉长。
- Period/History 主图改为固定高度 compact bars，标记 peak/latest，并展示 Top 5 日期贡献；Raw data 保留完整追溯明细。
- Admin 改为 `1d/7d/30d/MTD/Last month` quick range + 日期框；Auto grain 会按范围切 day/week/month。
- Desktop Trend Chart 改为 summary cards + compact timeline + Recent contribution；Recent 和 Table 均 newest first。
- `npm test` 中样例上传日期改为运行当天，避免固定样例日期跨日后导致 `range=today` 假失败。
- 验证：`node --check`、`npm test`、`npm run desktop:smoke`、`node src/backend/server.js --smoke` 通过；Chrome 手工验证公开榜 drawer 和 Admin 7d 联动通过。
```

### E17 设置归属、Admin Tab 语境与 Chart Tooltip 收口

目标：修正 E16 后暴露的“控件归属不清”和“图表 hover 不显式”的问题。设置页按用户意图组织，Admin 筛选只影响 Usage Ranking，Web/客户端图表 hover 必须直接说明日期、token 和成本。

产品决定：

- Profile 只承载身份轻配置：nickname、导出 profile、导入 profile。
- Display 承载展示偏好：Show estimated cost、Raw token numbers。
- Sync 承载同步与刷新：API base URL、background refresh、refresh interval。
- Sources 承载所有采集来源：Codex、Claude Code、Cursor dashboard usage。
- Aliases 承载 workdir 公开名。
- System 承载本机系统行为：Launch at login。
- Admin 的 Usage filters 收进 Usage ranking tab 内；Model prices tab 不显示时间/用户/raw/cost 筛选器。
- Chart hover/focus tooltip 必须展示 period/date、完整 token、成本；成本未开启时至少展示 period/date 和完整 token。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E17-T1 | Settings 信息架构重组 | DONE | E16 | Profile/Display/Sync/Sources/Aliases/System 分组清晰，Show cost/Raw token 不再在 Profile |
| E17-T2 | Cursor 归入 Sources | DONE | E3.5/E17-T1 | Cursor dashboard usage 与本地 provider 位置在同一 Sources 模块配置 |
| E17-T3 | Launch at login 迁入 System | DONE | E8/E17-T1 | 开机自启不再出现在 Sync 模块 |
| E17-T4 | Admin filters 归入 Usage tab | DONE | E16 | 切到 Model prices 时不再看到 Usage Ranking 的筛选器 |
| E17-T5 | Web chart tooltip | DONE | E16 | 公开榜详情 compact chart hover/focus 展示日期、完整 token、成本 |
| E17-T6 | Desktop chart tooltip | DONE | E16 | 客户端 Trend compact chart hover/focus 展示日期、完整 token、成本 |
| E17-T7 | 文档同步 | DONE | E17 | 产品设计文档和开发任务文档记录本轮交互决策 |

验证矩阵：

| 验证项 | 方式 | 完成标准 |
| --- | --- | --- |
| Settings 分组 | 打开桌面端 Settings | Cursor 在 Sources；Show cost/Raw token 在 Display；Launch at login 在 System |
| Admin Tab 语境 | `/admin.html` 切换两个 Tab | Usage filters 只在 Usage ranking 中出现，Model prices 只展示价格管理 |
| 图表 hover | Web/客户端 compact chart 鼠标悬浮或键盘 focus | tooltip 展示 period/date、完整 token、成本或缺价标记 |
| 回归 | node check + tests + smoke | 语法、单测、desktop smoke、backend smoke 全部通过 |

实现记录：

```text
- Desktop Settings 重组为 Profile / Display / Sync / Sources / Aliases / System。
- Cursor dashboard usage 并入 Sources；Launch at login 移入 System；Show estimated cost 与 Raw token numbers 移入 Display。
- Admin Usage filters 移入 Usage ranking 面板内部，Model prices tab 不再显示无关筛选器。
- Web compact chart 与 Desktop Trend timeline 增加 `data-tooltip` 和 hover/focus 样式，tooltip 展示 period/date、完整 token 和成本。
```

### E18 测试环境部署与 MySQL 存储迁移

目标：把 v0.1 的本地 JSON MVP 存储升级为测试环境可持续存储，支持 backend/web 以 Docker 容器连接现有 MySQL 服务。E18 不改变客户端上传协议和公开榜产品口径。

产品/工程边界：

- 继续保留 JSON Store 作为本地开发默认模式。
- 测试环境通过 `DB_TYPE=mysql` 启用 MySQL Store。
- MySQL 保存核心事实表，不只挂载 `data/db.json`。
- Admin 页面仍为测试管理入口，公网暴露前必须补访问保护。
- 本阶段 MySQL Store 复用现有内存聚合逻辑，目标是测试环境持久化，不是最终生产级查询优化。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E18-T1 | Store 选择器 | DONE | E6 | 服务端可按 `DB_TYPE=json/mysql` 选择存储后端，JSON 默认行为不变 |
| E18-T2 | MySQL schema migration | DONE | E12 | `participants/devices/workdirs/usage_daily/upload_batches/model_prices` 表结构可自动初始化 |
| E18-T3 | MySQL Store 适配 | DONE | E18-T2 | 注册设备、上传 usage、价格维护、成本重算可写入 MySQL 并从 MySQL 加载 |
| E18-T4 | Dockerfile | DONE | E18-T1 | backend/web 可构建为 Node.js container |
| E18-T5 | docker-compose.test.yml | REVIEW | E18-T2/E18-T4 | Compose 已改为只启动 backend 并连接外部 MySQL；本机 Docker bridge 到外部 MySQL 被远端关闭 |
| E18-T6 | 测试部署文档 | DONE | E18-T5 | `test-deployment.md` 说明启动、环境变量、MySQL 连接和 smoke |
| E18-T7 | JSON 回归验证 | DONE | E18-T1 | `npm test`、backend smoke 通过 |
| E18-T8 | MySQL E2E 验证 | DONE | E18-T5 | 本机 Node backend 连接外部独立库完成 health、注册、上传、榜单查询、价格维护验证 |
| E18-T9 | Docker 到外部 MySQL 网络验证 | BLOCKED | E18-T5 | 容器内连接外部 MySQL 返回 `PROTOCOL_CONNECTION_LOST`，需测试环境网络或 MySQL 访问策略放通 |

验证矩阵：

| 验证项 | 方式 | 完成标准 |
| --- | --- | --- |
| JSON 兼容 | `npm test` | 原有测试全部通过 |
| MySQL migration | backend 以 `DB_TYPE=mysql` 启动 | 表自动创建，无手工 SQL |
| MySQL 写入 | collector 或测试 payload 上传 | `usage_daily`、`upload_batches` 有事实数据 |
| 榜单查询 | `/api/public-leaderboard` 或 `/` | 返回 MySQL 中的上传结果 |
| 价格维护 | `/admin.html` 或 API | 写入 `model_prices` 后历史成本可重算 |
| Docker 测试环境 | `docker compose -f docker-compose.test.yml up --build` | 当前本机 Docker 到外部 MySQL 被远端关闭，待网络放通后复测 |

验证记录：

```text
2026-04-30:
- 已停止本机 MySQL docker compose 服务，改为使用现有外部 MySQL 服务。
- 未使用 cube-center-deploy；已在同一 MySQL 服务中新建独立库 ai_token_league。
- `MYSQL_AUTO_MIGRATE=true DB_TYPE=mysql node src/backend/server.js --smoke` 成功创建 6 张表。
- 本机 Node backend + 外部 MySQL E2E 成功：
  - collector sync accepted=2 rejected=0
  - public leaderboard 返回 e18-mysql totalTokens=6260
  - MySQL 计数 participants=1 devices=1 workdirs=2 usage_daily=2 upload_batches=1
  - model_prices 可写入 codex-default，成本重算 updated=2
- Docker backend 镜像可构建。
- Docker 容器内直连外部 MySQL 失败：`PROTOCOL_CONNECTION_LOST`，同样连接在宿主机 Node 中正常；判断为 Docker bridge/VPN/MySQL 访问策略问题。
- Dockerfile 已适配国内构建源：默认 base image 使用 DaoCloud Docker Hub 镜像，npm 使用 npmmirror。
- `docker-compose.mysql.example.yml` 作为提交模板，实际启动通过被忽略的 `env.local` / `env.test` 选择数据库。
```

### E19 同步目标可见化与环境配置收口

目标：解决“客户端点同步后到底上传到了哪个环境”和“本地调试/测试部署数据库选择不显性”的产品与工程问题。

产品判断：

- 客户端只知道 API base URL，不应该也不能直接知道服务端 MySQL database。
- 用户需要看到的是本机最后一次上传的目标 API、完成时间、成功/排队/失败状态和队列数量。
- 数据库选择属于服务端部署环境，必须通过 env 文件显式选择，而不是依赖当前容器残留配置。
- `Sync now` 不应隐式保存 Settings；同步动作只使用已保存配置，避免一次点击同时改变 API、清缓存、扫描和上传。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E19-T1 | 同步状态数据模型 | DONE | E12/E18 | 本地配置持久化 `syncStatus`，包含 API、last attempt/finish/success、status、row counts、queue pending、error |
| E19-T2 | 客户端状态展示 | DONE | E8 | Sidebar 与 Settings/Sync 展示目标 API 和上次同步结果 |
| E19-T3 | 同步性能收口 | DONE | E12 | 手动同步不再隐式保存设置，优先复用最近 usage cache，减少无意义全量扫描 |
| E19-T4 | Docker env 文件 | DONE | E18 | `env.example` 可提交；本机 `env.local` 指向 `ai_token_league_dev`，`env.test` 指向 `ai_token_league` 且被 git ignore |
| E19-T5 | 部署文档更新 | DONE | E18 | `test-deployment.md` 说明 `ENV_FILE=env.local/env.test` 的启动方式和数据库分工 |
| E19-T6 | 业务日期时区修复 | DONE | E18 | 采集、服务端周期查询、MySQL DATE 读回统一按 `TZ=Asia/Shanghai` 业务日，避免今日数据显示到前一天 |
| E19-T7 | 重新构建运行包 | DONE | E9/E19 | macOS / Windows 分发包重新生成，包含同步状态 UI |

验证矩阵：

| 验证项 | 方式 | 完成标准 |
| --- | --- | --- |
| 配置安全 | `git check-ignore env.local env.test` | 本机带密码 env 文件不会进入 git |
| 启动选择 | `docker compose -f docker-compose.mysql.example.yml config` | 默认读取 `env.local`，解析后数据库为 `ai_token_league_dev` |
| 测试部署选择 | `ENV_FILE=env.test docker compose -f docker-compose.mysql.example.yml config` | 解析后数据库为 `ai_token_league` |
| 时区选择 | compose config | 解析后包含 `TZ=Asia/Shanghai` |
| 客户端语法 | `node --check src/desktop/main.cjs` | Electron main process 语法通过 |
| Renderer 语法 | `node --check src/desktop/renderer.js` | renderer 语法通过 |
| 回归 | `npm test` | 原有测试通过 |

### E20 Icon 资源与打包标识收口

目标：把本地未提交的应用 icon 资源设计固化为可重复生成、可验证、跨 macOS / Windows / Web 一致的资源链路。

产品/工程边界：

- 本轮只收口应用 icon 与 favicon，不扩展完整品牌视觉系统。
- 源图保留在 `assets/app-icon-source.png`，派生资源由脚本生成，避免手工多份资源漂移。
- Electron 窗口、macOS `.icns`、Windows `.ico`、Web favicon 和 Desktop HTML favicon 使用同一源图基线。
- 当前代码与资源仍处于本地未提交状态；进入 `DONE` 前必须随打包产物做一次验证。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E20-T1 | 源图与派生资源落库 | DONE | E9 | `assets/app-icon-source.png`、`app-icon.png`、`app-icon.icns`、`app-icon.ico`、Web/Desktop favicon 路径明确且进入提交范围 |
| E20-T2 | icon 生成脚本 | DONE | E20-T1 | `npm run icons` 可从源图重复生成 macOS/Windows/Web 所需资源 |
| E20-T3 | Electron 与 HTML 引用 | DONE | E20-T1 | Desktop window 使用应用 icon，Web `/`、`/admin.html` 和 Desktop HTML 加载 favicon |
| E20-T4 | 打包脚本接入 | DONE | E20-T1 | `package:mac` 使用 `assets/app-icon.icns`，`package:win` 使用 `assets/app-icon.ico` |
| E20-T5 | 资源验收 | DONE | E20-T2/E20-T4 | 重新生成 icon、执行打包或 smoke，确认 macOS/Windows/Web icon 显示正常 |

验证矩阵：

| 验证项 | 方式 | 完成标准 |
| --- | --- | --- |
| 资源生成 | `npm run icons` | `assets/app-icon.icns`、`assets/app-icon.ico`、`src/web/favicon.png`、`src/desktop/favicon.png` 重新生成成功 |
| macOS 标识 | macOS 打包产物或运行窗口 | Dock/窗口/应用包显示 AI Token League icon |
| Windows 标识 | Windows exe 或资源检查 | exe 使用 `assets/app-icon.ico` |
| Web favicon | 打开 `/` 与 `/admin.html` | 浏览器标签加载 `/favicon.png` |
| 提交范围 | `git status --short` | icon 资源、生成脚本、引用代码和文档同批进入 review |

实现记录：

```text
2026-04-30:
- 本地未提交代码已新增 `assets/` icon 资源、`scripts/generate-icons.js` 与 `npm run icons`。
- `package:mac` / `package:win` 已接入应用 icon，后续验证中收敛为平台显式路径。
- `src/desktop/main.cjs` 已为 BrowserWindow 设置平台 icon。
- `src/web/index.html`、`src/web/admin.html`、`src/desktop/index.html` 已引入 favicon。
- 当前记录说明本地未提交实现状态；后续验证记录已补齐资源生成、打包和显示验证结果。
2026-04-30:
- `npm run icons` 重新生成 `assets/app-icon.png`、`assets/app-icon.icns`、`assets/app-icon.ico`、`src/web/favicon.png`、`src/desktop/favicon.png` 成功。
- `node --check scripts/generate-icons.js`、`node --check src/backend/server.js`、`node --check src/desktop/main.cjs`、`node --check src/desktop/renderer.js` 通过。
- `npm test` 与 `npm run desktop:smoke` 通过。
- 首轮打包验证发现 macOS `CFBundleIconFile` 仍引用默认 `electron.icns`；已将 `package:mac` 改为 `--icon=assets/app-icon.icns`、`package:win` 改为 `--icon=assets/app-icon.ico`。
- `npm run package:all` 通过，重新生成 `dist/AI Token League-darwin-arm64.zip` 与 `dist/AI Token League-win32-x64.zip`。
- macOS 包内 `Contents/Resources/electron.icns` 与 `assets/app-icon.icns` SHA-256 一致，打包后 app `--desktop-smoke` 通过。
- Windows exe 确认为 `PE32+ executable (GUI) x86-64, for MS Windows`，Windows 实机显示仍需 Windows 主机最终目视确认。
- Web favicon HTTP 验证通过：`/favicon.png` 返回 `image/png`，内容 hash 与 `src/web/favicon.png` 一致；`/` 与 `/admin.html` 均声明 `/favicon.png`。
- in-app browser 已打开 `/` 与 `/admin.html` 截图验证，页面加载正常且各有一个 favicon link。
```

### E21 Sources 开关与 Cursor Token 配置收口

目标：把 Sources 页的来源卡片升级为唯一控制面，删除独立 Cursor dashboard 设置区，避免 `Cursor On` 与 `Enable Cursor usage` 双 truth source。

产品/工程边界：

- Claude Code、Codex、Cursor 都在来源卡片上完成 On/Off。
- Cursor 的 On/Off 等价于 `cursorDashboardUsage.enabled`；Off 时不访问 Cursor dashboard API。
- Claude Code、Codex 的 On/Off 只控制本机扫描，不删除已配置 location。
- `Add Cursor token` 使用弹窗输入和本地格式校验，不再使用浏览器 prompt。
- Cursor token 只保存在本机配置，UI 不展示真实 token，不上传服务端。
- 保存 token 成功后自动开启 Cursor source。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E21-T1 | 删除独立 Cursor dashboard 设置区 | DONE | E17/E3.5 | Sources 页不再出现 `Cursor dashboard`、`Enable Cursor usage`、`Workos session token` 常驻表单 |
| E21-T2 | 来源卡片 On/Off 交互 | DONE | E21-T1 | Claude Code、Codex、Cursor 卡片均可直接切换启停 |
| E21-T3 | 本地 provider 启停配置 | DONE | E21-T2 | Codex/Claude Code Off 后不扫描本地 session，但保留 location |
| E21-T4 | Cursor 启停合并 | DONE | E21-T2 | Cursor 卡片 Off 后 `cursor_dashboard_usage` 不返回扫描源；On 后按已配置 token / 本机 token 扫描 |
| E21-T5 | Cursor token 弹窗 | DONE | E3.5 | 弹窗支持输入 token / account JSON，空值和非法格式阻止保存 |
| E21-T6 | Token 保存与账号摘要 | DONE | E21-T5 | 合法 token 去重保存；保存后 Cursor 自动 On；账号摘要脱敏展示 |
| E21-T7 | 回归测试与文档同步 | DONE | E21-T1-E21-T6 | `node --check`、`npm test` 通过，产品设计和任务文档同步 |

验证矩阵：

| 验证项 | 方式 | 完成标准 |
| --- | --- | --- |
| Cursor 设置区删除 | 打开 Settings / Sources | 页面只保留来源卡片和 Add Cursor token，不再有独立 dashboard 表单 |
| Codex/Claude 开关 | 点击来源卡片 On/Off 后刷新 | Off 时不扫描对应本地 provider，On 时恢复扫描 |
| Cursor 开关 | 点击 Cursor 来源卡片 On/Off 后刷新 | Off 时不访问 Cursor API，On 时按 token source 扫描 |
| Token 弹窗 | 点击 Add Cursor token | 空值、非法格式提示错误；合法 token 保存并自动开启 Cursor |
| 安全边界 | 查看 UI 与上传 payload | 不展示真实 token，不上传 Cursor session token |
| 回归 | `node --check src/desktop/renderer.js`、`node --check src/desktop/main.cjs`、`npm test` | 全部通过 |

实现记录：

```text
2026-04-30:
- Sources 页已删除独立 Cursor dashboard 设置区。
- 来源卡片新增 On/Off 按钮；Cursor 绑定 `cursorDashboardUsage.enabled`，Codex/Claude Code 绑定 `providerEnabled`。
- Codex/Claude Code provider 在 Off 时不扫描 session，health 仍保留检测到的 location。
- `Add Cursor token` 已从 `window.prompt` 改为弹窗，空值和非法格式在弹窗内提示。
- 合法 Cursor token 继续复用 `addCursorToken` 去重保存，保存成功后自动开启 Cursor。
- `node --check src/desktop/renderer.js`、`node --check src/desktop/main.cjs`、`npm test`、`npm run desktop:smoke` 均通过。
- `npm run package:all` 已重新生成 `dist/AI Token League-darwin-arm64.zip` 与 `dist/AI Token League-win32-x64.zip`；解包 `app.asar` 验证桌面 UI 不再包含旧 Cursor dashboard 表单。
```

### E22 Sources 开关性能优化与 0.2 基线

目标：修复 Sources 卡片 On/Off 点击后 UI 卡顿的问题，并把当前产品、工程和验证状态固化为 `0.2` 基线。

根因：

- E21 的 On/Off 逻辑保存配置后调用 `loadHealth()`，随后又调用 `loadToday(true)`。
- `loadToday(true)` 会强制重扫全部 provider；Cursor 打开时还会访问 Cursor dashboard API。
- 来源开关是配置动作，不是 usage 刷新动作；把两者串联会让单次点击承担本地文件扫描、SQLite 读取、网络请求和图表重渲染。

设计原则：

- On/Off 点击只做轻量配置变更。
- UI 先乐观更新卡片状态，再异步保存配置。
- 保存后只刷新 source health 和 background status。
- usage totals 不在 On/Off 点击链路里刷新；用户点击 Today Refresh、后台 refresh 或 sync 时再扫描。
- 配置变更仍会让 usage cache 失效，保证下一次显式刷新拿到正确 provider 集合。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E22-T1 | 定位 On/Off 卡顿根因 | DONE | E21 | 明确卡顿来自 `toggleSource -> loadToday(true)` 强制扫描 |
| E22-T2 | 切断 On/Off 全量扫描链路 | DONE | E22-T1 | 点击 On/Off 不调用 `loadToday(true)`，不访问 Cursor usage API |
| E22-T3 | 来源卡片乐观更新 | DONE | E22-T2 | 点击后卡片状态立即切换，保存失败可回滚 |
| E22-T4 | 保留正确刷新语义 | DONE | E22-T2 | 配置保存后只刷新 health；usage totals 通过 Refresh / 后台任务更新 |
| E22-T5 | 0.2 baseline 文档 | DONE | E22-T4 | 新增 `doc/0.2-baseline.md`，记录当前产品、性能和发布状态 |

验证矩阵：

| 验证项 | 方式 | 完成标准 |
| --- | --- | --- |
| 切换链路 | 代码检查 `toggleSource` | 不再调用 `loadToday(true)` |
| Cursor API 边界 | 代码检查 | On/Off 只保存配置和刷新 health，不触发 `parseUsage` |
| 回归 | `node --check src/desktop/renderer.js`、`node --check src/desktop/main.cjs`、`npm test`、`npm run desktop:smoke` | 全部通过 |
| 打包 | `npm run package:all` | dist 内包含新 renderer 和 baseline 文档 |

### E23 P0 Admin 信息架构与详情面板重构

目标：把 Admin 从展示型大页收口成运营工作台，优先暴露真实决策面，降低首屏噪音。

产品判断：

- Admin 用户的第一任务不是理解品牌，而是快速判断数据范围、成本质量、缺价风险和异常入口。
- Usage 表格不应把全部明细压进首行；首行只保留决策列，其余进入展开行。
- 详情面板必须说明当前查询上下文，避免把全周期详情误读为单日或当前榜单详情。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E23-T1 | Admin 首屏压缩 | DONE | E17 | Admin masthead 改为紧凑工作台，首屏可直接看到 tabs、filters 和 Usage 表头 |
| E23-T2 | Usage 表格列优先级重排 | DONE | E16 | 默认列只保留 Period、User、Total、Cost quality、Top workdir、Top model、Action |
| E23-T3 | 展开行承载长明细 | DONE | E23-T2 | Composition、Sources、Pricing note、Top slices 进入展开行 |
| E23-T4 | Admin 详情上下文面板 | DONE | E23-T1 | 详情标题和状态展示查询范围、粒度与用户，不再只写泛化 detail |

验证矩阵：

| 验证项 | 方式 | 完成标准 |
| --- | --- | --- |
| 首屏效率 | in-app browser 打开 `/admin.html` | 不需要滚动即可看到主要筛选和 Usage 表头 |
| 表格可读性 | Admin Usage 默认视图 | 首行不再挤入完整 composition/workdir/model/source 列 |
| 展开行 | 点击 Show | 能看到 composition、sources、pricing note 和 top slices |
| 详情语义 | 点击用户 | 面板显示当前查询范围和 grain |

实现记录：

```text
2026-04-30:
- Admin masthead 已改为紧凑 workbench header，移除首屏超大标题和悬浮 metric card。
- Usage 表格默认列收敛为 Period/User/Total/Cost quality/Top workdir/Top model/Action。
- 展开行保留 composition detail、top workdirs/models/sources 和 pricing note。
- Admin 用户详情状态改为 `range · grain · row count`，避免泛化 detail 语义。
```

### E24 P1 运营动作闭环与质量诊断

目标：把 Pricing 和 Quality 从只展示数据升级为能指导下一步动作的运营面板。

产品判断：

- Missing price 是待办队列，不是普通列表；每个模型需要展示影响、来源和下一步。
- Quality anomaly 当前重复输出 `input-heavy/cache-heavy`，应按类型聚合并只展示高影响项。
- `*`、Estimated、Missing price、Exact 必须使用同一套语义，减少跨页面解释成本。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E24-T1 | Pricing 缺价任务队列 | DONE | E14 | Missing models 展示影响 token、占比、来源，点击后带入表单 |
| E24-T2 | Pricing 保存后闭环刷新 | DONE | E24-T1 | 保存或删除 custom price 后刷新 pricing、usage 和 quality 状态 |
| E24-T3 | Quality 分组诊断 | DONE | E12/E14 | Anomalies 按类型分组，默认只显示每组 Top 5 |
| E24-T4 | 成本语义统一 | DONE | E14 | Web/Admin 使用 Exact、Estimated、Missing price 统一标记 |

验证矩阵：

| 验证项 | 方式 | 完成标准 |
| --- | --- | --- |
| 缺价任务 | 打开 Model prices | 每个 missing model 显示影响和来源，点击后填充 model |
| 质量诊断 | 打开 Quality | anomaly 不再是未分组长列表，按类型展示 Top 5 |
| 成本语义 | Usage/Public/Detail/Pricing | 缺价/估算/精确成本标记一致 |

实现记录：

```text
2026-04-30:
- Missing prices 改为 task queue 样式，显示 token impact、share 和 source impact。
- Quality anomalies 已按 anomaly type 分组，每组最多展示 Top 5，并保留 coverage 与 explainability。
- Cost quality label 在 Admin 和 Public 页面统一走 `costQualityLabel`，`*` 只表示存在缺价模型。
```

### E25 P2 桌面端交互安全与设置归属

目标：降低桌面端误操作和深层状态困扰，把上传、凭据、重置等风险动作显性化。

产品判断：

- Desktop 启动和切换主 section 时应回到该 section 顶部，避免打开后停在 Trend 深层展开态。
- `Sync now` 会向配置的 API 上传 usage 聚合数据，必须在动作前给出目标、最近扫描时间和本次待上传规模。
- Settings 中涉及上传、凭据、重置的动作需要在 System 中有集中说明；具体配置入口仍保留在原工作流位置。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| E25-T1 | Desktop section 顶部复位 | DONE | E16 | 启动和点击 Today/Trend/Settings 时 workspace 滚动回顶部 |
| E25-T2 | Sync 上传预览确认 | DONE | E19 | 点击 Sync now 前显示目标 API、最近扫描、待上传 rows，用户确认后才上传 |
| E25-T3 | System 风险动作说明 | DONE | E21 | System 页集中说明 Sync、Cursor token、Profile import/export、Reset 的风险边界 |
| E25-T4 | 设置归属微调 | DONE | E25-T3 | Sources 保持来源管理，System 保留风险动作说明和 reset |

验证矩阵：

| 验证项 | 方式 | 完成标准 |
| --- | --- | --- |
| 顶部复位 | Desktop 切换 Today/Trend/Settings | 进入新 section 后显示顶部内容 |
| 上传确认 | 点击 Sync now | 出现包含 API、rows、scan time 的确认文案，取消不会上传 |
| 风险归属 | Settings/System | 能看到上传、凭据、身份包、重置的集中说明 |

实现记录：

```text
2026-04-30:
- Desktop `selectSection` 已在切换后将 workspace 滚动到顶部。
- `syncNow` 新增上传预览确认，取消时状态显示 Sync canceled。
- Settings/System 新增 Risk controls 说明，明确 Sync、Cursor token、profile import/export 与 reset 的边界。
```

## 6. 发布阻塞项

当前阻塞项：

```text
Windows x64 分发包已生成；Windows 实机 E2E 需要在 Windows 主机执行。
```

## 7. 已确认不进入 MVP

| 项目 | 原因 | 后续处理 |
| --- | --- | --- |
| hook 采集 | 当前阶段不采用 hook 方案 | 后续如工具能力稳定，可作为 provider 内部增强，不改变主流程 |
| 成本榜 | token 总量是第一优先级，成本可二次计算 | 保留 `estimatedCostUsd`、`costQuality`、`pricingVersion` |
| 强实名 | 产品永远不需要强实名 | 不设计手机号、邮箱、实名或第三方账号绑定 |
| 私有团队榜 | MVP 目标是公开社区榜 | 后续可扩展房间榜或团队榜 |

## 8. 变更记录

| 日期 | 变更 | 说明 |
| --- | --- | --- |
| 2026-04-29 | 初始化任务追踪文档 | 基于产品设计文档拆分 MVP 开发任务 |
| 2026-04-29 | 完成 Node.js MVP | 实现 provider collector、backend API、Web 榜单、测试样本和 smoke checklist |
| 2026-04-29 | 补齐桌面端与打包 | 实现 Electron 桌面 UI，生成 macOS arm64 与 Windows x64 分发包 |
| 2026-04-29 | 真实数据流验证 | 启动本地服务端与 macOS 客户端，修复 Codex parser 误读累计字段，完成真实同步 |
| 2026-04-29 | 调整榜单与详情页 | 移除工具榜，展示目录消耗，新增用户详情页和数据质量中文说明 |
| 2026-04-29 | 客户端产品化调整 | 将开发调试式客户端改为今日数据与设置双视图 |
| 2026-04-29 | 客户端 Today/Settings 收口 | Today 移除 source status/quality，新增模型消耗；Settings 隐藏 Identity 详情并支持添加本地 source 位置 |
| 2026-04-29 | 客户端后台刷新 | Settings 新增后台刷新开关和间隔；有 API 时自动 sync，无 API 时只做本地刷新 |
| 2026-04-29 | Trend 与 Web 分层 | 客户端新增 Trend；Web 拆分普通公开榜 `/` 与管理员页 `/admin.html` |
| 2026-04-29 | 查询与本地缓存优化 | Web 增加本月/上月/自定义查询；客户端增加 usage cache、workdir alias、Trend chart/table |
| 2026-04-29 | Cursor Dashboard Usage 接入 | 新增 `cursor_dashboard_usage` provider，使用 Workos session token 采集 Cursor dashboard usage event |
| 2026-04-29 | Web/Trend 交互模型重构设计 | 明确公开榜使用 `period`，用户详情/管理员/客户端 Trend 使用 `grain + from/to` |
| 2026-04-29 | 完成 Web/Trend 交互模型重构 | 实现 E11 全部任务，公开榜、用户趋势、管理员查询和客户端 Trend 已按新模型落地 |
| 2026-04-29 | 追加存储模型硬化任务 | 基于设计文档第 12 章，拆分本地 cache、上传队列、追溯字段、增量扫描、远端分析和隐私验证任务 |
| 2026-04-29 | 完成存储模型硬化 E12 | 落地 shared schema、source fingerprint、cache 元数据、upload queue、远端事实字段、admin quality、aggregateCache 和真实数据验证 |
| 2026-04-29 | 追加展示优化与成本任务 | 基于产品决策拆分 E13 token 短单位/详情去重，以及 E14 LiteLLM/ccusage 估算成本能力 |
| 2026-04-29 | 完成展示优化与成本能力 E13/E14 | 落地 token 短单位、详情页去重、成本 resolver/API/UI、历史重算和完整验证 |
| 2026-04-29 | 优化成本价格设计 | 成本聚合改为已知部分可展示、缺价模型可追溯，并新增 Admin 自定义模型价格维护 |
| 2026-04-29 | 扩展客户端成本展示 | 新增价格表 API，Desktop Today/Trend 基于服务端价格体系计算并展示本地成本 |
| 2026-04-30 | 新一轮产品语义重构设计 | 基于页面截图和代码现状，新增 E15：详情页绑定榜单周期，客户端 Trend 收敛为 Daily/Weekly/Monthly |
| 2026-04-30 | 完成 E15 产品语义重构 | 落地榜单周期详情、History trend 二级页、客户端 Daily/Weekly/Monthly Trend，并完成两轮自我迭代 |
| 2026-04-30 | 追加 E16 交互优化方案 | 针对详情无限下滚、Web/客户端趋势长列表和 Admin 筛选复杂度，拆分 drawer/modal、compact chart、quick range 联动任务 |
| 2026-04-30 | 补充客户端 Trend 优化任务 | 将客户端 Trend 首屏信息密度、最近数据顺序、compact timeline 纳入 E16 |
| 2026-04-30 | 完成 E16 交互优化 | 公开榜详情 drawer、Web/客户端 compact trend、Admin quick range + Auto grain 已落地并验证 |
| 2026-04-30 | 完成 E17 交互归属收口 | Settings 重组、Cursor 归 Sources、Admin filters 归 Usage tab、Chart hover tooltip 和文档同步完成 |
| 2026-04-30 | 启动 E18 测试环境部署 | 新增 MySQL Store、migration、Dockerfile、外部 MySQL compose 配置；独立库 `ai_token_league` 本机 E2E 通过，Docker 到外部 MySQL 网络待放通 |
| 2026-04-30 | 完成 E19 同步目标可见化 | 客户端持久化并展示 API/上次同步状态；Docker env.local/env.test 显式区分 dev/test 数据库 |
| 2026-04-30 | 修复业务日偏移并重打包 | `TZ=Asia/Shanghai` 统一每日归属，MySQL DATE 读回不再 UTC 截断；重新生成桌面分发包 |
| 2026-04-30 | 增强 Cursor Dashboard 来源 | 自动检测 Cursor `state.vscdb` token，Sources 增加 `Add Cursor token` 按钮，支持多 token 与账号 workdir |
| 2026-04-30 | 记录 Icon 资源设计 | 本地未提交代码已补齐应用 icon、macOS/Windows 打包 icon、Web/Desktop favicon 与生成脚本；作为 E20 待验证项跟踪 |
| 2026-04-30 | 完成 Icon 资源验证 | 重新生成 icon、修正平台打包 icon 参数和 Web PNG MIME，重打 macOS/Windows 包并完成包内资源、desktop smoke、Web favicon 和浏览器截图验证 |
| 2026-04-30 | 启动 Sources 开关收口 | 新增 E21：删除独立 Cursor dashboard 设置区，来源卡片统一承担 On/Off，Add Cursor token 改为弹窗校验保存 |
| 2026-04-30 | 完成 Sources 开关收口 | E21 已落地并重新打包：来源卡片统一启停，Cursor token 弹窗校验保存，本地 provider Off 后不扫描，回归、desktop smoke 和 dist 包内验证通过 |
| 2026-04-30 | 完成 Sources 开关性能优化 | E22 已落地：On/Off 不再触发全量 usage scan，卡片乐观更新，0.2 baseline 文档新增 |
| 2026-04-30 | 完成 P0/P1/P2 产品迭代 | 新增 E23-E25 并落地 Admin 信息架构、Pricing/Quality 运营闭环、Desktop 同步确认与设置风险归属 |
