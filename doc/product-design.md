# AI Token League 产品定义与设计

## 0. v0.1 固化说明

本文档是 v0.1 产品设计的详细历史记录，已在 `2026-04-30` 阶段性冻结。

后续研发入口以 `v0.1-baseline.md` 为准；本文档保留用于追溯产品决策、数据模型、页面语义和历史取舍。新版本不要继续在本文档末尾追加零散需求，应先建立新的版本目标、成功标准和任务拆分。

v0.1 关联文档：

- `v0.1-baseline.md`：当前稳定基线和下一阶段入口。
- `mvp-development-tasks.md`：v0.1 任务执行与验证历史。
- `er-diagram.md`：v0.1 本地/远端数据模型图。

## 1. 模式与结论

当前处于工程模式：产品目标、核心边界和 MVP 取舍已经明确，需要输出一份可评审的产品设计文档。

产品定义：

> AI Token League 是一个面向开发者的公开社区 token 排行榜。用户无需登录，只需本地设置昵称，通过 mac/Windows 本地采集器统计 Codex 与 Claude Code 的每日 token 使用量，并按昵称、工具、工作目录维度进行公开排名。采集模块必须按 provider 横向扩展，未来可以接入更多 AI IDE。

第一版不做 hook 采集，支持 Codex、Claude Code，以及用户显式启用的 Cursor Dashboard Usage。成本可以基于 token 明细二次计算，但不作为 MVP 的主排序口径。

展示口径的产品决定：

- 主排序和主指标仍然是 `totalTokens`。
- UI 不直接展示长整数作为主要视觉锚点，默认使用中文短单位，如 `1.20亿`、`8045万`。
- 原始整数保留在 tooltip、详情展开或复制字段中，避免损失可核对性。
- 成本只作为 `estimated cost` 二级指标，不默认参与公开榜排名。

## 2. 问题定义

用户想知道自己和社区成员每天在 AI Coding 工具中消耗了多少 token，并希望看到公开排名。

这里的核心问题不是“谁更强”，而是：

- 谁在什么日期使用了多少 AI 编程 token。
- 这些 token 来自哪个工具。
- 这些 token 消耗在哪个工作目录或项目上。
- 数据是否可信、是否可重复计算、是否不暴露隐私。

因此，产品应定位为“AI Coding 使用量观测与公开排名”，而不是生产力评判系统。

## 3. 成功标准

MVP 成功标准：

- 用户无需注册登录，只设置昵称即可参与公开榜单。
- 支持 macOS 与 Windows。
- 支持 Codex 与 Claude Code 的本地 token 采集。
- 支持 Cursor Dashboard Usage provider：通过用户本地 Cursor Web session token 读取 dashboard usage event。
- 采集模块采用 provider 机制，不把 Claude Code / Codex 写死在主流程中。
- 支持按自然日生成 token 总量统计。
- 支持按工作目录维护 alias；没有 alias 时展示系统检测到的目录名。
- 服务端只接收聚合指标，不接收 prompt、response、代码、真实绝对路径。
- 排行榜默认按 token 总量排序。
- 成本字段可以预留和展示，但不作为第一版主榜排序依据。
- token 数值展示必须支持短单位，避免 `120,456,222` 这类长整数成为主阅读负担。

## 4. 明确非范围

第一版不做：

- 不做账号体系、密码登录、SSO、OAuth。
- Cursor 不做本地工作目录归因；只做 dashboard usage event 的 token/model/date 采集。
- 不做 hook 方案。
- 不上传原始对话、代码片段、prompt、assistant response。
- 不上传真实本地绝对路径。
- 不做“token 越多越优秀”的价值判断。
- 不做企业管理后台。
- 不做强防作弊，只做基础签名与异常检测。

这些能力不是永远不做，而是不应进入 MVP 主路径。

## 5. 用户与场景

### 5.1 个人开发者

目标：

- 查看今日、昨日、近 7 日 AI token 使用量。
- 对比 Codex 与 Claude Code 的使用分布。
- 看不同项目或工作目录的 token 消耗。

### 5.2 公开社区成员

目标：

- 通过昵称参与公开 token 排名。
- 查看社区当天谁使用最多。
- 点击用户后查看时间趋势、模型分布和公开目录消耗。

### 5.3 小团队或兴趣小组

目标：

- 先使用公开榜单能力。
- 后续可以扩展为房间榜、团队榜或邀请码榜。

第一版先做公开社区榜，不做私有团队空间。

## 6. 核心产品形态

系统由三部分组成：

```text
Desktop Collector
  - 运行在 macOS / Windows
  - 通过采集 provider 只读扫描本地 AI 工具使用记录
  - 维护昵称、设备身份、工作目录 alias
  - 本地聚合每日 token
  - 定时上传聚合结果

Backend API
  - 接收客户端签名后的 usage snapshot
  - 做去重、校验、聚合
  - 维护公开榜单数据

Web Leaderboard
  - 日榜
  - 周榜
  - 月榜
  - 用户详情页
  - 管理员查看页
```

## 7. 身份设计

产品要求无需登录，也永远不要求强实名。推荐采用可导入导出的本地匿名身份：

```text
participantId = 本地生成的随机 ID
nickname = 用户自定义昵称
identityKey = 本地生成并保存的身份签名密钥
deviceId = 每台设备单独生成的设备 ID
```

上传数据时使用 `identityKey` 对 payload 签名，服务端用注册过的 public key 校验来源。用户可以把 `participantId` 与 `identityKey` 导出为身份包，并在其他设备导入，从而继续使用同一个公开身份。

这样可以满足：

- 用户无需登录。
- 服务端可以识别同一个匿名身份。
- 同一身份可以导入到 mac/Windows 的其他设备。
- 昵称可以修改。
- 防止别人直接冒用同一个 participantId 上传。

第一版不解决这些问题：

- 昵称抢占。
- 强反作弊。

身份包边界：

- 导出内容包含 `participantId`、签名私钥、昵称等最小必要配置。
- 导入后，新设备使用同一个 `participantId`，但仍生成自己的 `deviceId`。
- 身份包等价于该匿名身份的所有权凭证，用户丢失后无法证明原身份归属。
- 不设计手机号、邮箱、实名信息或第三方账号绑定。

## 8. 数据采集设计

### 8.1 采集原则

只采集聚合指标，不采集内容。

采集模块必须支持横向扩展。Claude Code 与 Codex 只是第一版内置 provider，不能把工具差异散落在上传、聚合、榜单和 UI 主流程里。

本地允许读取：

- token 使用记录。
- session 元数据。
- 工具名。
- 模型名。
- 工作目录或 project 标识。

本地禁止上传：

- prompt。
- assistant response。
- 代码。
- 文件内容。
- 完整 transcript。
- 真实绝对路径。

### 8.2 采集 Provider 架构

collector 内部按 provider 接入不同 AI IDE：

```text
Collector Core
  - provider registry
  - scan scheduler
  - local identity
  - workdir resolver
  - usage normalizer
  - upload queue

Provider
  - detect()
  - scanSessions()
  - parseUsage()
  - resolveWorkdir()
  - reportHealth()
```

每个 AI IDE provider 只负责把自己的本地数据转换成统一的 `UsageEvent` 或 `UsageDaily`，主流程只依赖标准化结果。

Provider 输出标准：

```text
providerId
providerVersion
toolCode
sourceKind: local_log | local_db | api | import
sourceQuality
sessionId
startedAt
endedAt
workdirCandidate
model
inputTokens
outputTokens
cacheReadTokens
cacheWriteTokens
reasoningTokens
totalTokens
rawSourceRef
```

约束：

- provider 可以读取本地原始数据，但不能把原始 prompt、response、代码或真实路径传给 uploader。
- provider 之间互不依赖。
- 新增 AI IDE 时，只新增 provider 和必要的 sourceQuality 规则，不修改排行榜主逻辑。
- provider 必须暴露健康状态，包括数据目录是否存在、最近一次扫描时间、最近错误。
- provider 必须声明 token 字段可信度，缺失字段不能伪造成精确值。

第一版内置 provider：

```text
claude_code_local
codex_local
cursor_dashboard_usage
```

后续 provider 示例：

```text
cursor_extension
windsurf_local
continue_local
jetbrains_ai
vscode_extension
```

### 8.3 Claude Code

Claude Code 第一版支持。

采集方式：

- 参考 ccusage 的本地日志扫描方式。
- 读取 Claude Code 本地 project/session 数据。
- 解析 token usage。
- 将 `inputTokens` 归一化为 `raw input - cacheReadTokens - cacheWriteTokens`，cache 继续保留在独立字段。
- 将 project 或 cwd 映射为本地 workdir。

工作目录维护：

- 优先从 Claude Code project 路径或 session 元数据识别。
- 客户端展示检测到的目录。
- 用户手动维护 alias。
- 上传时只上传 alias 与 hash，不上传原始路径。

### 8.4 Codex

Codex 第一版支持。

采集方式：

- 参考 ccusage/codex 的本地 session JSONL 扫描方式。
- 读取 Codex 本地数据目录，默认从用户的 Codex home 识别。
- 从 session 中的 token 事件计算 token 增量。
- 将 `inputTokens` 归一化为 `raw input - cacheReadTokens - cacheWriteTokens`，cache 继续保留在独立字段。
- 按日期、工具、模型、工作目录聚合。

工作目录维护：

- 优先读取 session 中的 cwd 或项目元数据。
- 若无法可靠识别，则归入 `unknown`，由用户在客户端手动归类。

### 8.5 Cursor Dashboard Usage

Cursor 第一版采用 `cursor_dashboard_usage` provider，走 Cursor dashboard usage event，不解析本地私有日志。

已验证的 Cursor dashboard event 字段：

```text
timestamp
model
kind
isTokenBasedCall
tokenUsage.inputTokens
tokenUsage.outputTokens
tokenUsage.cacheReadTokens
tokenUsage.cacheWriteTokens
tokenUsage.totalCents
chargedCents
```

口径说明：

- Cursor 保持 dashboard API 当前定义，不额外做 `input-cache` 的本地重写。

鉴权方式：

```text
Cookie: WorkosCursorSessionToken=<userId>::<accessToken>
```

token 来源：

- Sources 页提供 `Add Cursor token` 按钮，用户可多次添加 token；每个 token 单独保存、去重和脱敏展示。
- 用户可手动填入 `WorkosCursorSessionToken`、`user_xxx::accessToken`、纯 JWT access token，或 Cursor account JSON。
- 客户端自动检测本机 Cursor 官方存储：
  - macOS: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
  - Windows: `%APPDATA%\Cursor\User\globalStorage\state.vscdb`
  - Linux: `~/.config/Cursor/User/globalStorage/state.vscdb`
- 自动检测读取 SQLite `ItemTable` 中 `key = 'cursorAuth/accessToken'` 的值，并从 JWT `sub` 提取 `user_xxx` 后构造 `WorkosCursorSessionToken=<userId>::<accessToken>`。
- 兼容旧版 Cursor JSON 配置与已知 Cursor account cache，例如 `~/.antigravity_cockpit/cursor_accounts/*.json`。
- Sources 可以显示本机 Cursor token 是否可检测；真正扫描 Cursor Dashboard usage 受 Cursor 来源卡片 `On/Off` 控制，因为扫描会访问 cursor.com API。
- Sources 页不再保留独立 `Cursor dashboard` 设置区；Cursor 的启停与其他来源一致，由来源卡片承担唯一控制面。
- `Add Cursor token` 使用弹窗输入，先做本地格式校验和去重保存；远端 API 可用性进入 Refresh sources / 扫描结果，不阻塞本地保存。

安全边界：

- Cursor session token 只保存在本机配置中。
- Cursor session token 不上传到 AI Token League 服务端。
- 上传 payload 只包含聚合后的 date/model/token/workdir hash。
- UI 必须明确说明这是敏感凭据。

工作目录限制：

- Cursor dashboard usage event 当前不包含 workspace、repo、path、project 等字段。
- 因此 `cursor_dashboard_usage` 不做真实目录归因；虚拟 workdir 使用 `Cursor · <账号名>`。
- 账号名优先取 Cursor account JSON / 本机 Cursor cache 中的 email；没有 email 时退回 `user_xxx`。
- Cursor 的 token 总量、模型分布和账号维度可以准确统计；真实目录维度不做猜测归因。

数据质量：

- token 字段来自 dashboard event，`sourceKind=api`。
- token 字段齐全时 `sourceQuality=exact`。
- workdir 维度为固定占位，不表示真实项目目录。

## 9. 工作目录维护设计

工作目录是产品的关键差异点。它不只是统计维度，也是用户理解 token 消耗的主要入口。

### 9.1 本地目录标识

本地 collector 维护：

```text
localPath
workdirHash
detectedName
alias
toolSources
lastSeenAt
```

上传时不传 `localPath`。

推荐 hash 规则：

```text
workdirHash = sha256(normalizedLocalPath + participantIdSalt)
```

这样服务端可以识别同一用户同一目录的连续数据，但无法反推出真实路径。

### 9.2 alias 规则

用户可以把本地目录设置为公开展示名：

```text
/Users/sky/1data/source/control -> control-backend
C:\work\client-a -> client-a
```

服务端榜单优先展示 alias。若用户没有设置 alias，默认展示系统检测到的目录名：

```text
control
client-a
```

目录名取本地路径的最后一级名称或 Git repo name，不上传真实绝对路径。

### 9.3 工作目录榜

工作目录榜不是跨用户识别同一个真实目录，而是展示公开目录名下的消耗。公开目录名的取值顺序为：

```text
alias -> 系统检测目录名 -> Git repo name
```

- 用户个人详情页：按自己的公开目录名展示。
- 公开榜单：可以展示“某用户的某目录项目消耗”。
- 不做“不同用户相同 repo 自动合并”，避免隐私和误归因。

## 10. 排行榜设计

### 10.1 主榜口径

主榜按每日 token 总量排序：

```text
totalTokens = inputTokens
            + outputTokens
            + cacheReadTokens
            + cacheWriteTokens
```

reasoning token 保留为 composition/cost 明细，不进入主榜展示和排序 total。

如果某个工具无法拆分 input/output，只能提供旧总量，则该行不进入主榜 total：

```text
totalTokens = 0
sourceQuality = partial
```

### 10.2 榜单类型

MVP 榜单：

- 日榜。
- 周榜。
- 月榜。
- 上一周榜。
- 上一月榜。

详情页：

- 用户日/周/月趋势。
- 模型分布。
- 工作目录分布。
- 最近同步时间。

管理员页：

- 自定义时间查询。
- 用户筛选。
- 来源、同步时间和数据质量字段。

### 10.3 成本字段

成本不是 MVP 主榜排序依据。

但数据模型预留：

```text
estimatedCostUsd
costQuality
pricingVersion
pricingModel
missingPriceTokens
missingPriceModels
```

成本应由服务端按模型价格表二次计算，不能让客户端直接上报最终成本作为可信值。

第一版可以展示为辅助字段：

```text
估算成本，仅供参考
```

成本能力的产品决定：

- 排名、趋势和用户详情的默认主口径始终是 `totalTokens`。
- 成本只做二级估算，不做默认排序，不作为“谁用得更多”的主判断。
- 成本由服务端或共享 pricing resolver 计算，客户端只上传标准化 token 明细。
- 成本来源可以参考 ccusage 读取的 LiteLLM 价格表，但必须记录 `pricingVersion`。
- 服务端维护自己的模型价格表，内置价格来自 LiteLLM/ccusage 兼容字段，用户可以为缺失模型补充价格。
- 价格表更新后允许重新计算历史估算成本，但不能改变原始 token 事实表。

成本计算需要区分 token 类型：

```text
inputTokens
outputTokens
cacheReadTokens
cacheWriteTokens
reasoningTokens
```

成本质量枚举：

```text
exact_price      model + token type 能精确匹配价格表
estimated_price  model 通过 alias 或 fallback 匹配价格表
unknown_price    找不到稳定价格，不展示金额
```

UI 展示规则：

- 默认隐藏成本。
- 设置或管理员页可以打开 “Show estimated cost”。
- 成本旁必须展示 `estimated` 或质量标记。
- 公开榜可以在后续版本增加成本列，但不能替代 token 总量列。
- 成本为空时展示 `-`，不要展示 `$0.00`，避免误导。
- 聚合中只有部分模型缺价时，展示“已知模型成本”的部分金额，并用 `*` 标记缺价，不在主数值里写 `partial`。
- 聚合中全部模型都缺价时，成本展示 `-`。
- tooltip 或详情必须展示缺价模型列表和缺价 token 量，例如 `codex-default 1,104 tokens`。

模型价格维护规则：

```text
ModelPrice
  model PK
  inputCostPerMTok
  outputCostPerMTok
  cacheReadCostPerMTok
  cacheWriteCostPerMTok
  reasoningCostPerMTok
  source: litellm | ccusage | admin | custom
  notes
  updatedAt
```

缺价来源：

- `codex-default` 表示 Codex 本地日志片段没有解析到具体模型，是采集兜底模型，不应自动假定价格。
- Cursor dashboard 的 `composer-2-fast`、`default` 也可能没有公开稳定价格，需要进入缺价列表。
- 管理员补充价格后，服务端立即按新价格重算历史 `UsageDaily` 的估算成本。

### 10.4 Token 展示单位

产品要解决的问题是“读数困难”，不是把 token 立即换算成钱。

默认展示采用短单位：

```text
>= 100,000,000  展示为 1.20亿
>= 10,000       展示为 1,204.6万 或 8045万
< 10,000        展示完整数字
```

展示约束：

- 排序、聚合、去重永远使用原始整数。
- 卡片、榜单、图表轴、图例默认展示短单位。
- 表格可以展示短单位，hover/title 或展开详情展示完整 token。
- 管理员页可以提供 Raw/Compact 切换，普通用户页默认 Compact。
- 英文界面后续可以支持 `120.5M`、`8.0B`，但中文界面默认 `万/亿`。

## 11. 数据质量

所有 usage 数据都必须带 `sourceQuality`。

建议枚举：

```text
exact      本地日志字段完整，可精确计算
partial    部分字段缺失，但总量可信
estimated  通过时间窗口或推断得出
imported   用户导入
unknown    无法判断
```

MVP 中：

- Claude Code 目标为 `exact` 或 `partial`。
- Codex 目标为 `exact` 或 `partial`。
- Cursor Dashboard Usage 的 token/model/date 目标为 `exact`；workdir 固定为 `Cursor`。

排行榜默认可以纳入 `exact` 与 `partial`。若后续引入 `estimated`，需要在 UI 上明显标记。

## 12. 存储数据模型

设计目标：

- 产品展示可以是榜单、趋势、管理员聚合，但存储不能只保存展示结果。
- 本地与远端都以“可追溯的每日标准化明细”为最小上云颗粒度。
- 不上传 prompt、response、代码、文件内容、真实绝对路径。
- 不上传本地原始日志全文；本地只保留必要引用、缓存和聚合结果。
- 所有展示层的日/周/月榜、模型分布、目录分布、用户趋势，都从标准化明细二次聚合。

### 12.1 总体数据流

```text
Local AI Tool Data
  Codex session JSONL
  Claude Code project/session log
  Cursor dashboard usage API
        |
        v
Provider Scanner
  detect source
  parse raw usage
  resolve local workdir
  normalize token fields
        |
        v
Local Standard Usage Row
  day + provider + tool + model + workdirHash + token fields
        |
        +--> Local Usage Cache
        |      fast Today / Trend rendering
        |      TTL + manual refresh + background refresh
        |
        +--> Upload Payload
               signed by identityKey
               no prompt/code/path/token credential
               same daily row granularity
                    |
                    v
Remote UsageDaily
  upsert by day + participant + device + tool + provider + workdir + model
        |
        v
Query Aggregates
  public period leaderboard
  participant trend by day/week/month
  admin usage by grain/range/user
```

### 12.2 本地存储 ER 图

```text
LocalIdentityConfig
  participantId PK
  identityPublicKey
  identityPrivateKey
  deviceId
  nickname
  apiBaseUrl
  autoRefreshEnabled
  refreshIntervalMinutes
  createdAt
  updatedAt
        |
        | 1 owns many
        v
LocalProviderRoot
  providerId PK part
  rootPath PK part
  addedAt

LocalIdentityConfig
        |
        | 1 owns many
        v
LocalWorkdirAlias
  workdirHash PK
  alias
  updatedAt

LocalProviderConfig
  providerId PK
  enabled
  secretRef
  localOnlySecret
  updatedAt

LocalUsageCache
  scannedAt PK
  cacheVersion
  sourceFingerprint
  rows[]
        |
        | contains many
        v
LocalUsageRow
  day PK part
  toolCode PK part
  providerId PK part
  workdirHash PK part
  model PK part
  workdirDisplayName
  inputTokens
  outputTokens
  cacheReadTokens
  cacheWriteTokens
  reasoningTokens
  totalTokens
  sourceQuality
  rawSourceRef
  collectedAt

LocalUploadQueue
  batchId PK
  payloadHash
  clientGeneratedAt
  status
  retryCount
  lastError
        |
        | contains many signed
        v
UploadPayloadItem
  same fields as LocalUsageRow
```

当前实现对应关系：

- `~/.ai-token-league/config.json` 保存 `LocalIdentityConfig`、`LocalProviderRoot`、`LocalWorkdirAlias` 和 Cursor provider 配置。
- Electron `userData/usage-cache.json` 保存 `LocalUsageCache`，用于 Today / Trend 快速展示。
- `~/.ai-token-league/upload-queue.json` 是后续离线上传队列的目标位置；当前 MVP 已预留概念，网络失败重试需要继续补强。
- Cursor 的 `WorkosCursorSessionToken` 只允许保存在本地 provider 配置，不进入上传 payload。

### 12.3 远端存储 ER 图

```text
Participant
  id PK
  nickname
  avatarColor
  identityPublicKey
  createdAt
  updatedAt
  lastSeenAt
        |
        | 1 has many
        v
Device
  id PK
  participantId FK
  os
  appVersion
  createdAt
  lastSeenAt
  revokedAt

Participant
        |
        | 1 has many
        v
Workdir
  id PK
  participantId FK
  workdirHash
  alias
  detectedName
  displayName
  sourceProvider
  createdAt
  updatedAt
  lastSeenAt

Participant + Device + Workdir
        |
        | 1 has many
        v
UsageDaily
  day PK part
  participantId PK part
  deviceId PK part
  toolCode PK part
  providerId PK part
  workdirId PK part
  model PK part
  inputTokens
  outputTokens
  cacheReadTokens
  cacheWriteTokens
  reasoningTokens
  totalTokens
  estimatedCostUsd
  costQuality
  pricingVersion
  pricingModel
  sourceQuality
  collectedAt
  uploadedAt

ModelPrice
  model PK
  inputCostPerMTok
  outputCostPerMTok
  cacheReadCostPerMTok
  cacheWriteCostPerMTok
  reasoningCostPerMTok
  source
  notes
  updatedAt
        |
        | recalculates estimate for
        v
UsageDaily.estimatedCostUsd

UploadBatch
  id PK
  participantId FK
  deviceId FK
  payloadHash unique
  signature
  clientGeneratedAt
  receivedAt
  accepted
  rejected
  status
  errorReason
        |
        | audits writes into
        v
UsageDaily
```

当前 MVP 用 `data/db.json` 存这些表的 JSON 形态；生产化时应迁移到 PostgreSQL，并保持同样的逻辑主键。

### 12.4 上云最小颗粒度

上云 payload 的最小颗粒度固定为：

```text
day
participantId
deviceId
toolCode
providerId
workdirHash
workdirDisplayName
model
inputTokens
outputTokens
cacheReadTokens
cacheWriteTokens
reasoningTokens
totalTokens
sourceQuality
```

服务端不应只保存排行榜聚合结果。原因：

- 日榜、周榜、月榜只是查询视角，可以从 `UsageDaily` 聚合。
- 模型分布、目录分布、来源分布、用户趋势都依赖这组明细。
- 成本二次计算需要 `model + token field`，不能只靠 `totalTokens`。
- 追溯异常需要定位到 `deviceId + providerId + workdirHash + model`。
- 后续新增 provider 时，只要能落到同一行模型，就不需要重做榜单主逻辑。

不进入云端的字段：

```text
localPath
absolutePath
prompt
assistantResponse
sourceFileContent
fullTranscript
Cursor session token
identityPrivateKey
provider raw secret
```

可选进入云端的追溯字段：

```text
rawSourceRef
providerVersion
parserVersion
sourceFingerprint
```

这些字段必须是不可反推出真实路径或内容的引用。推荐只保存 hash、文件 mtime/size 摘要、provider 内部 source id，不保存本地路径。

### 12.5 可支持的分析程度

基于当前上云颗粒度，可以支持：

```text
公开榜：
  participant total by day/week/month/last period

用户趋势：
  participant total by day/week/month
  participant model breakdown by period
  participant workdir breakdown by period

模型分析：
  model total by period
  model input/output/cache/reasoning distribution
  model cost estimation after pricing table is available

目录分析：
  workdir display name total by period
  workdir model distribution
  workdir provider distribution

来源分析：
  provider/tool total by period
  sourceQuality ratio
  last uploaded time by device/provider

异常分析：
  duplicate batch detection
  unusually high daily total
  same participant multi-device divergence
  unknown model / unknown workdir ratio
```

不能可靠支持：

```text
跨用户真实 repo 合并
真实文件级 token 消耗
prompt 主题分析
代码语言分析
Cursor 工作目录归因
精确成本回算到历史 provider 私有事件
```

这些不是 UI 限制，而是隐私边界和 source data 缺失决定的。

### 12.6 本地刷新、合并与性能策略

本地采集的性能目标：

- UI 切换 Today / Trend 不能触发全量日志扫描。
- 手动 Refresh、后台刷新、Sync 才允许触发 provider scan。
- scan 结果写入 `LocalUsageCache`，Today / Trend 只读 cache 并做内存聚合。
- 后台刷新默认 15 分钟，最小 1 分钟，但不建议低于 5 分钟用于真实分发。

本地合并策略：

```text
Provider raw events
  -> normalize UsageEvent
  -> group by day + toolCode + providerId + workdirHash + model
  -> sum token fields
  -> write LocalUsageCache rows
  -> upload same rows
```

同一个 key 的最新结果覆盖旧结果。这样可以处理：

- provider parser 修复后的重新扫描。
- 同一天日志继续增长。
- workdir alias 修改后的展示名刷新。
- Cursor dashboard usage 后续分页补齐。

性能边界：

- provider scan 应尽量按文件 mtime、size、cursor 或 API page 时间窗口做增量；MVP 可以全量扫描，但必须通过 cache 避免每次切页都扫描。
- 本地 cache 只保存标准化聚合行，不保存原始日志，避免 cache 变成隐私副本。
- Trend 查询默认最近 30 天，客户端再按 day/week/month 聚合；更长历史应分页或限定范围。
- 大表格必须虚拟化或分页；MVP 阶段先限制默认时间范围，管理员页才开放自定义范围。
- 后台刷新如果正在运行，下一次 refresh 应跳过，不能并发扫描同一批 provider。

远端合并策略：

- `UploadBatch.payloadHash` 去重，完全相同 batch 不重复写入。
- `UsageDaily` 用逻辑主键 upsert，同一个 day/device/tool/provider/workdir/model 覆盖为最新聚合值。
- 不在上传时预聚合掉 `deviceId`、`providerId`、`model` 或 `workdirHash`。
- 查询接口按需聚合成公开榜、用户趋势、管理员视图。

### 12.7 存储保留策略

本地建议：

- `config.json` 长期保存，除非用户重置。
- `usage-cache.json` 保存最近扫描结果，可安全删除；删除后重新扫描可恢复。
- `upload-queue.json` 保存未成功上传 batch，成功后可清理或保留最近 N 条状态。
- 原始工具日志不复制、不迁移、不归档。

远端建议：

- `Participant`、`Device`、`Workdir` 长期保存。
- `UsageDaily` 长期保存，作为核心事实表。
- `UploadBatch` 至少保留 30-90 天用于排查；payloadHash 可长期保留用于去重。
- 查询聚合结果可以做物化缓存，但只能作为加速层，不能替代 `UsageDaily`。

## 13. 核心远端数据表

### 13.1 Participant

```text
id
nickname
avatarColor
identityPublicKey
createdAt
updatedAt
lastSeenAt
```

### 13.2 Device

```text
id
participantId
os: macos | windows
appVersion
createdAt
lastSeenAt
revokedAt
```

### 13.3 Workdir

```text
id
participantId
workdirHash
alias
detectedName
sourcePathType
sourceProvider
createdAt
updatedAt
lastSeenAt
```

### 13.4 UsageDaily

```text
day
participantId
deviceId
toolCode
providerId
workdirId
model
inputTokens
outputTokens
cacheReadTokens
cacheWriteTokens
reasoningTokens
totalTokens
estimatedCostUsd
costQuality
sourceQuality
collectedAt
uploadedAt
```

唯一键建议：

```text
day + participantId + deviceId + toolCode + providerId + workdirId + model
```

客户端每次上传同一个 key 的最新聚合值，服务端做 upsert。

### 13.5 UploadBatch

```text
id
participantId
deviceId
payloadHash
signature
clientGeneratedAt
receivedAt
status
errorReason
```

用于去重、审计和问题排查。

## 14. API 草案

### 14.1 注册匿名设备

```text
POST /api/devices/register
```

请求：

```json
{
  "participantId": "p_123",
  "nickname": "sky",
  "identityPublicKey": "base64...",
  "os": "macos",
  "appVersion": "0.1.0"
}
```

响应：

```json
{
  "deviceId": "d_123",
  "serverTime": "2026-04-29T10:00:00Z"
}
```

### 14.2 上传每日聚合

```text
POST /api/usage/daily-batch
```

请求：

```json
{
  "participantId": "p_123",
  "deviceId": "d_123",
  "clientGeneratedAt": "2026-04-29T10:00:00Z",
  "items": [
    {
      "day": "2026-04-29",
      "toolCode": "codex",
      "providerId": "codex_local",
      "workdirHash": "sha256...",
      "workdirAlias": "control-backend",
      "model": "gpt-5",
      "inputTokens": 120000,
      "outputTokens": 45000,
      "cacheReadTokens": 0,
      "cacheWriteTokens": 0,
      "reasoningTokens": 18000,
      "totalTokens": 183000,
      "sourceQuality": "exact"
    }
  ],
  "signature": "base64..."
}
```

响应：

```json
{
  "accepted": 1,
  "rejected": 0,
  "batchId": "ub_123"
}
```

### 14.3 查询公开榜单

```text
GET /api/leaderboard?period=today
```

响应：

```json
{
  "period": "today",
  "items": [
    {
      "rank": 1,
      "participantId": "p_123",
      "nickname": "sky",
      "totalTokens": 183000,
      "modelBreakdown": {
        "gpt-5.5": 183000
      }
    }
  ]
}
```

公开榜单只接受统一排名周期，不接受任意 `from/to`。这是为了保证所有用户在同一个自然周期下比较。

`period` 可选值：

```text
today
yesterday
this_week
last_week
this_month
last_month
```

### 14.4 查询用户趋势

```text
GET /api/participants/:participantId/trend?grain=day&from=2026-04-01&to=2026-04-29
```

`grain` 表示趋势聚合粒度，可选值：

```text
day
week
month
```

`from/to` 只用于详情页、管理员页和客户端趋势页，不作为公开榜单首页的默认交互。

响应：

```json
{
  "participantId": "p_123",
  "grain": "day",
  "from": "2026-04-01",
  "to": "2026-04-29",
  "items": [
    {
      "periodStart": "2026-04-29",
      "periodEnd": "2026-04-29",
      "totalTokens": 183000,
      "inputTokens": 120000,
      "outputTokens": 45000,
      "reasoningTokens": 18000,
      "cacheReadTokens": 0,
      "cacheWriteTokens": 0,
      "models": {
        "gpt-5.5": 183000
      }
    }
  ]
}
```

### 14.5 管理员聚合查询

```text
GET /api/admin/usage?grain=day&from=2026-04-01&to=2026-04-29&participantId=p_123
```

管理员查询可以组合用户、时间范围、聚合粒度和展示视角，用于排查数据、看明细、看来源质量。它不是普通用户首页。

### 14.6 模型价格查询

```text
GET /api/model-prices
```

目标：给客户端和 Web 使用同一套服务内价格体系，避免客户端本地 Today/Trend 用内置 fallback，而服务端榜单用自定义价格。

响应：

```json
{
  "pricingVersion": "custom-overrides",
  "builtin": [
    {
      "model": "gpt-5",
      "inputCostPerMTok": 1.375,
      "outputCostPerMTok": 11,
      "cacheReadCostPerMTok": 0.1375,
      "cacheWriteCostPerMTok": 0,
      "reasoningCostPerMTok": 11,
      "source": "builtin"
    }
  ],
  "custom": [
    {
      "model": "codex-default",
      "inputCostPerMTok": 1,
      "outputCostPerMTok": 2,
      "cacheReadCostPerMTok": 0.1,
      "cacheWriteCostPerMTok": 1,
      "reasoningCostPerMTok": 2,
      "source": "admin",
      "updatedAt": "2026-04-29T10:00:00Z"
    }
  ],
  "missingModels": [
    {
      "model": "composer-2-fast",
      "totalTokens": 45433372,
      "providers": [
        { "name": "cursor_dashboard_usage", "totalTokens": 45433372 }
      ]
    }
  ]
}
```

约束：

- 该接口只返回价格表和缺价模型，不返回用户 prompt、response、真实路径或身份私钥。
- 客户端 Settings 中开启 `Show estimated cost` 且配置 API 后，Today 与 Trend 优先使用该接口返回的服务端价格体系。
- 如果接口不可用，客户端可以回退内置 fallback 价格表，但 UI title 需要标记来源为 local fallback。
- 管理员维护入口仍使用 `/api/admin/model-prices`，普通客户端只读 `/api/model-prices`。

## 15. 客户端页面

MVP 客户端信息架构：

- Today：本地今日 token 总量、目录消耗、模型消耗、手动刷新/同步入口。
- Trend：个人使用复盘，不是任意报表查询器；默认帮助用户回答“最近用量是否异常、主要消耗在哪些天、是否需要控制成本”。
- Settings：按模块分组为 Profile、Display、Sync、Sources、Aliases、System。
  - Profile 只放昵称和身份包导入/导出。
  - Display 放 `Show estimated cost` 与 `Raw token numbers`，因为它们只影响展示，不改变采集和上传。
  - Sync 放 API base URL、后台刷新、刷新间隔和同步状态，因为它们共同回答“上传到哪里、多久刷新、最近一次是否成功”。
  - Sources 放本地 Codex/Claude Code 位置和 Cursor dashboard usage，因为 Cursor 是一种采集来源，不是独立账户设置页。
  - Aliases 放工作目录公开名维护。
  - System 放开机自启等系统级行为。

客户端默认行为：

- 本地扫描。
- 本地聚合。
- 用户确认公开目录展示名后上传；未设置 alias 时使用系统检测目录名。
- 每 15 分钟同步一次。
- 网络失败时本地缓存，后续重试。
- Today / Trend 默认读取本地 usage cache，只有手动刷新、后台刷新或同步动作才触发 provider 扫描。
- 手动同步不隐式保存 Settings；用户修改 API base URL 后必须先保存，避免一次同步同时改变配置、清缓存、全量扫描和上传目标。
- 手动同步优先复用最近 usage cache；缓存过期或用户显式刷新后才重新扫描，减少本地大目录扫描带来的 UI 等待。
- 同步状态必须本地持久化，至少包含 API base URL、last attempt、last finish、last success、status、scanned、accepted、rejected、queue pending、last error。
- Sidebar 只展示最小状态：目标 API、上次同步时间、成功/排队/失败摘要。
- Settings / Sync 展示完整状态，用于排查“当前客户端到底上传到哪个服务、服务再写哪个数据库”。
- 开启 `Show estimated cost` 时，客户端先从服务端 `GET /api/model-prices` 拉取价格体系，再对本地 Today/Trend 明细二次计算成本。
- 未配置 API 或 API 不可用时，客户端使用本地 fallback 价格表，并在 tooltip 中标记价格来源。
- Today 展示当日估算成本总额；目录消耗和模型消耗行同步展示各自成本。
- Trend chart/table 展示每个 period 的估算成本；部分模型缺价时展示 `*`，全部缺价时展示 `-`。

同步目标解释：

```text
Desktop Client
  stores apiBaseUrl only
  uploads to http://127.0.0.1:8787

Backend at 127.0.0.1:8787
  chooses storage by environment
  DB_TYPE=mysql
  MYSQL_DATABASE=ai_token_league_dev or ai_token_league
  TZ=Asia/Shanghai

MySQL
  ai_token_league_dev = local debugging
  ai_token_league = test deployment
```

因此客户端不会直接选择数据库。若同一个 API 地址背后的服务被重启到不同 env，后续同步就会写入新的库；产品上必须把 API 地址和最后同步时间展示出来，部署上必须用 env 文件显式选择数据库。

每日归属规则：

- 产品里的 `Today`、`Yesterday`、周榜、月榜按业务本地日计算，不按 UTC 日计算。
- 部署默认使用 `TZ=Asia/Shanghai`；如后续支持国际社区，可把 timezone 变成社区/榜单维度配置。
- 采集端把工具事件时间转换成本地 day 后上传；服务端读取 MySQL `DATE` 时也必须按同一 timezone 保持日期，不允许用 UTC ISO 截断。

Trend 页交互重新定义：

- 默认展示最近 30 天、按日聚合、chart 模式，因为这是最容易发现个人使用峰值和变化的视角。
- 顶层不再暴露“粒度 + 范围”的任意组合，而是暴露有产品含义的视图：
  - `Daily`：最近 30 天日趋势，用来定位异常日期。
  - `Weekly`：最近 12 周周趋势，用来看节奏变化。
  - `Monthly`：最近 12 个月月趋势，用来看长期消耗。
- `This month`、`Last month` 不再作为 Trend 的主筛选。它们是账期/排名周期，不是趋势分析目标；若需要看某月明细，放在 Table 的日期筛选或导出能力里。
- Chart 是默认主视图，只展示总 token、可选成本和峰值标记；模型/目录拆分进入侧栏摘要或 hover，不把所有模型名称挤进图表行。
- Table 是核对视图，不和 Chart 同屏重复；列为 Period、Total Tokens、Model Summary、Workdir Summary；展开行后才显示 Input/Output/Reasoning/Cache Read/Cache Write 和成本质量。
- Chart 时间轴保持时间正序，旧日期在左、最新日期在右，并突出最新点和最大值。
- Table 日期倒序，最新 period 在最上方。
- 所有 token 主读数默认使用短单位；完整 token 放在 tooltip/title 或明细展开中。
- 当服务端价格体系不可用时，成本区域降级为“本地估算”，不应在主图中制造过强视觉权重。

## 16. Web 页面

Web 分成三层，不再把所有查询能力放在一个页面里。

### 16.1 普通用户公开榜

入口：`/`

目标：给社区成员看统一排名。

交互：

- 默认展示 `today`。
- 支持切换日榜、周榜、月榜，以及上一周、上一月。
- 不提供自定义起止日期。
- 不提供工具榜。
- 点击用户进入用户详情。

公开榜单字段：

```text
rank
nickname
totalTokens
modelBreakdown
```

页面表格只展示三类信息：用户名、token 总量、各模型量。排名依据始终是 `totalTokens`。

token 总量默认使用短单位展示，完整 token 放在 hover/title 或详情里。公开榜不展示成本列，除非用户显式切换到估算成本视图。

### 16.2 用户详情页

入口：从公开榜点击用户。

目标：解释某个用户在当前榜单中的构成，而不是默认打开一个独立的 30 天趋势报表。

当前现状问题：

- 从 `Today` 或 `Yesterday` 榜点击用户后，页面默认展示最近 30 天趋势。用户的点击动机是理解榜单里这一行为什么排在这里，而不是跳到另一个时间范围。
- 对单日榜而言，展示 30 天趋势会削弱榜单语境；对昨日榜尤其明显，榜单数字是 2026-04-28，详情却展示 2026-03-31 到 2026-04-29。
- 趋势图目前只展示日期和总量，缺少“这个榜单周期内的模型/目录构成”，对解释排名帮助有限。

产品决定：

- 用户详情页采用“榜单上下文优先”的设计。
- 从公开榜进入详情时，详情默认绑定当前榜单周期：
  - `today` / `yesterday`：默认展示该日的构成详情，不默认展示趋势图。
  - `this_week` / `last_week`：默认展示该周的日分布和构成。
  - `this_month` / `last_month`：默认展示该月的日/周分布和构成。
- 趋势能力保留，但作为二级 tab：`Period detail` 与 `History trend`。
- `History trend` 默认最近 30 天日趋势，只有用户主动切换时出现。

交互：

- 标题必须带上来源上下文，例如 `sky · Yesterday` 或 `sky · This month`。
- 顶部 Summary 展示当前榜单周期的 totalTokens、rank、模型数、目录数、估算成本。
- `Period detail` 展示榜单周期内的模型构成、目录构成和来源构成。
- 只有当周期跨度大于 1 天时，`Period detail` 才展示周期内趋势；单日只展示构成，不展示“趋势”。
- `History trend` 支持 `daily / weekly / monthly` 三种有语义的视图，不暴露任意无意义组合。
- 默认展示 chart，不默认同时展示 table，避免信息重复。
- Table 进入 `Raw data` 折叠区或通过 segmented control 切换展示。
- Chart 时间轴保持时间正序，旧日期在左、最新日期在右。
- Table 日期倒序，最新 period 在最上方。
- 展示总 token 趋势与模型消耗分布，token 主读数使用短单位。
- 可展示目录消耗，但不展示真实路径。

推荐布局：

```text
User Detail
  Context Summary: nickname, rank, selected period, totalTokens compact, cost if enabled
  Tabs:
    Period detail
      Composition: model / workdir / source
      In-period chart: only for week/month periods
      Raw period rows: collapsed
    History trend
      Daily 30d / Weekly 12w / Monthly 12m
      Raw trend table: table mode
```

### 16.3 管理员查看页

入口：`/admin.html`

目标：排查数据、验证采集质量、查看更细聚合，不作为普通用户入口。

交互：

- 支持 `day/week/month` 粒度。
- 支持本月、上月、自定义时间范围。
- 支持按用户筛选。
- 可以查看目录消耗、来源、模型、最近同步时间、数据质量等运维字段。

不要展示：

```text
真实路径
设备 ID
原始 session ID
原始 transcript path
```

管理员页的图表原则：

- 管理员页默认是事实核对和异常排查，不需要和公开详情页复用同一套视觉。
- 表格是主视图；图表只在用户筛选后作为辅助，不默认在全量用户表格上展示。
- 时间筛选允许自定义，因为管理员的目标是定位问题，不是社区排名公平比较。

### 16.4 页面目的矩阵

```text
Public leaderboard (/)
  Purpose: compare participants in one shared ranking period
  Primary question: who used the most tokens in this period?
  Default content: rank, nickname, total tokens, model summary
  Not for: custom analysis, source debugging, arbitrary date slicing

Participant detail
  Purpose: explain the selected leaderboard row first, then allow history review
  Primary question: what made this user rank here in the selected period?
  Default content: selected-period summary + model/workdir/source composition
  Secondary content: history trend when explicitly selected
  Not for: admin data quality audit

Admin (/admin.html)
  Purpose: inspect uploaded facts and derived aggregates
  Primary question: is the collected data correct and traceable?
  Default content: table-first aggregates with workdir/source/quality fields
  Not for: public user storytelling

Desktop Today
  Purpose: answer what happened locally today
  Primary question: how much did I use today, and where did it go?
  Default content: today total, cost if enabled, workdir/model composition
  Not for: long-range comparison

Desktop Trend
  Purpose: personal usage review over meaningful time horizons
  Primary question: is my usage rising, peaking, or changing by period?
  Default content: Daily 30d chart; Weekly 12w and Monthly 12m as alternate views
  Not for: arbitrary admin-style filtering
```

### 16.5 下一轮交互优化

基于当前页面截图，E15 解决了“详情语义”问题，但还没有解决“详情承载方式”和“大数据量可读性”问题。

问题 1：公开榜详情在页面内展开，会造成无限下滚。

- 现状：点击用户后，详情插入在榜单下方；当月榜模型多、目录多、趋势行多时，用户需要在同一个页面里不断滚动。
- 产品判断：公开榜首页的主任务是排名比较，详情是临时解释，不应该改变首页的信息高度。
- 推荐方案：用户详情改为右侧抽屉或居中弹窗。
  - 桌面宽屏优先右侧抽屉，保留榜单上下文。
  - 小屏使用全屏 modal。
  - 关闭后回到榜单原滚动位置。
  - 弹窗内部拥有独立滚动，不影响页面主滚动。
- 不推荐继续页面内展开，因为榜单行越多，详情越容易把排名上下文冲掉。

问题 2：周期内趋势行数过多时，条形列表不适合作为主图。

- 现状：`This month` 下按日展示 20 多行条形数据，屏幕只能看到一部分。
- 产品判断：用户在月榜详情里首先需要识别峰值、走势和构成，不是逐行读每一天。
- 推荐方案：Period detail 的周期内趋势改为紧凑图表。
  - 周/月周期默认用 sparkline / compact bar chart，占用固定高度。
  - 标记最大值、当前周期末值和总量。
  - 下方只展示 Top 5 日期贡献；完整日明细进入 `Raw data`。
  - 对单日榜继续不展示趋势。
- 不推荐保留“一天一行”的主图，因为它本质是表格，不是趋势图。

问题 3：Admin 筛选复杂度过高。

- 现状：Admin 同时有 `Day/Week/Month` 粒度、`This month/Last month/30 days` 范围、开始日期、结束日期、Apply，用户需要理解多组控件之间的关系。
- 产品判断：管理员的主要动作是快速切换时间窗口，再决定聚合粒度；时间窗口应该是主控件，粒度应跟随窗口给出合理默认值。
- 推荐方案：Admin 筛选改成“时间范围 pill + 日期范围 picker + 自动粒度”。

```text
Admin Filter Bar
  Date range picker: Apr 01 - Apr 30
  Quick ranges: 1d / 7d / 30d / MTD / Last month
  Grain: Auto by default, optional Day / Week / Month in advanced
  User: All users
  Toggles: Raw tokens / Estimated cost
```

联动规则：

- `1d`：自动 grain=`day`，日期为今天。
- `7d`：自动 grain=`day`，展示最近 7 天。
- `30d`：自动 grain=`day`，展示最近 30 天。
- `MTD`：自动 grain=`day`，展示本月截至今天。
- `Last month`：自动 grain=`week` 或 `day`，默认按周聚合；用户可在 advanced 中切 day。
- 自定义日期范围：
  - 小于等于 31 天默认 `day`。
  - 32 到 120 天默认 `week`。
  - 超过 120 天默认 `month`。

这种设计把“我要看哪段时间”放在第一优先级，把“按什么粒度聚合”变成系统默认判断，降低交互成本。

问题 4：客户端 Trend 默认视图信息密度失衡。

- 现状：客户端默认窗口宽度下，Chart 行只能完整看到日期和 token 数量，模型、workdir、成本都被截断；同时第一屏从最久的日期开始，用户需要滚动到后面才看到最近数据。
- 产品判断：客户端 Trend 的主任务是个人复盘。打开页面时，用户应立即看到“最近是否异常”和“整体走势”，而不是从最旧日期逐行读列表。
- 推荐方案：客户端 Trend 改为“固定高度趋势图 + 最近贡献摘要 + 明细列表”的结构。
  - Chart 模式不再用一行一个 period 的长列表，而是使用固定高度 compact timeline。
  - 时间轴仍按旧到新绘制，符合趋势认知；但最新点必须出现在可视区域右侧，并有明确高亮。
  - 首屏同时展示最新 period、峰值 period、总量、成本状态和 Top 模型/Top workdir。
  - 最近明细列表按倒序展示，默认只展示最近 5 条。
  - 完整 period 表格进入 Table 模式，Table 默认倒序，最近数据在第一行。
  - 模型、workdir、成本不能挤在同一行省略；应拆成摘要卡或 tooltip，保证默认宽度下可读。
- 不推荐继续把 Chart 做成“条形行列表”，因为它既不能一眼看趋势，也无法完整承载维度信息。

### 16.6 详情弹窗信息架构

```text
Participant Detail Drawer / Modal
  Header
    nickname
    selected leaderboard period
    close

  Summary
    rank
    total tokens
    estimated cost if enabled
    model count
    workdir count

  Tabs
    Period detail
      Compact period chart
      Top dates, only when period is week/month
      Model breakdown
      Workdir breakdown
      Source breakdown
      Raw data collapsed

    History trend
      Daily 30d / Weekly 12w / Monthly 12m
      Compact chart
      Raw data collapsed
```

弹窗内图表高度必须固定，默认不超过首屏 40% 高度。长列表只允许出现在弹窗内部滚动或折叠 Raw data 中。

### 16.7 客户端 Trend 信息架构

```text
Desktop Trend
  Header
    Daily / Weekly / Monthly
    Chart / Table
    Refresh

  Chart mode
    Summary strip
      current period total
      peak period total
      estimated cost status
      active models / workdirs

    Compact timeline
      fixed height
      old -> new axis
      latest point highlighted
      peak point highlighted

    Recent contribution
      latest 5 periods, newest first
      each row: period, total tokens, top model, top workdir, cost if enabled

  Table mode
    newest first
    columns: Period, Total Tokens, Top Models, Top Workdirs, Est. Cost
    expandable raw token fields
```

客户端 Trend 默认打开 Chart mode。Chart mode 服务于趋势判断，Table mode 服务于核对；二者不能混成同一种长列表。

### 16.8 设置与筛选的二次收口

本轮迭代后暴露的问题不是控件缺失，而是控件归属不清：

- Cursor 配置被放成独立 Settings tab，会让用户误以为它是账户或同步能力；实际它是一个 usage provider，应放入 Sources。
- `Show estimated cost`、`Raw token numbers` 放在 Profile 中，会让用户误以为它们影响身份；实际它们只是本机展示偏好，应放入 Display。
- `Launch at login` 放在 Sync 中，会让用户误以为它影响上传；实际它是系统启动行为，应放入 System。
- Admin 筛选器如果放在页面全局，会污染 Model prices 的任务语境；筛选器只服务 Usage Ranking，应放入 Usage tab 内。

推荐信息架构：

```text
Desktop Settings
  Profile
    nickname
    export profile
    import profile

  Display
    show estimated cost
    raw token numbers

  Sync
    API base URL
    background refresh
    refresh interval
    last sync target/status/time

  Sources
    Codex locations
    Claude Code locations
    Cursor dashboard usage source card
    Add Cursor token dialog

  Aliases
    workdir public aliases

  System
    launch at login
```

图表 hover 规则：

- Web 和客户端所有 compact chart 的柱形点必须提供显式 hover/focus tooltip。
- Tooltip 至少包含 period/date、完整 token、估算成本。
- 成本未开启时 tooltip 仍展示 period/date + 完整 token。
- 部分模型缺价时成本值后用 `*`，tooltip 或 title 中展示缺价模型和价格来源。

同步状态规则：

- `success`：最近一次已上传到服务端，展示 scanned / accepted / rejected。
- `queued`：服务端不可达或上传失败，payload 已进入本地 queue，展示 pending 数量和错误摘要。
- `failed`：配置错误或本地不可恢复错误，不应伪装成已同步。
- `lastSuccessAt` 与 `lastFinishedAt` 分开保存；失败或排队不能覆盖最后成功时间。
- `apiBaseUrl` 与状态一起保存，避免用户只看到“Synced”但不知道同步到了哪个 backend。

Admin 布局规则：

```text
Admin
  Tabs
    Usage ranking
      filters
      aggregate table
      participant detail modal

    Model prices
      missing prices
      custom prices
      price editor
```

这样可以保证每个控件只出现在能改变其结果的页面中，避免用户在价格管理页看到无效时间筛选。

## 17. 反作弊与异常处理

第一版只做基础治理：

- 上传 payload 签名。
- batch hash 去重。
- 同一设备同一 day/tool/workdir/model upsert。
- 单日 token 异常阈值提示。
- 明显异常数据进入待审核或隐藏。

不做强防作弊，因为无登录公开社区榜天然无法完全防作弊。第一版应把目标定为“轻量可信”，不是“竞赛级可信”。

## 18. 技术选型建议

### 18.1 Desktop Collector

优先考虑：

- Tauri：适合 mac/Windows，小体积，Rust 适合本地文件扫描。
- Electron：生态成熟，但包体大。

如果目标是快速 MVP：

```text
Tauri + TypeScript UI + Rust scanner
```

原因：

- 跨平台。
- 本地文件权限控制更清晰。
- 后续打包自动更新方便。

### 18.2 Backend

推荐：

```text
PostgreSQL + REST API
```

不需要一开始引入复杂 OLAP。榜单数据量初期不会大，按 day 聚合后查询压力可控。

### 18.3 Web

推荐：

```text
Next.js / Vite + React / Vue
```

第一版重点是表格、筛选和详情页，不需要复杂前端架构。

### 18.4 Icon 资源设计

本地未提交实现已补齐应用 icon 与 favicon 资源。设计目标不是新增品牌系统，而是解决 macOS / Windows 安装包、桌面窗口、Web 页面和 Admin 页缺少统一图标的问题。

资源边界：

- `assets/app-icon-source.png` 作为源图。
- `assets/app-icon.png` 作为 Electron 窗口和通用应用 icon。
- `assets/app-icon.icns` 用于 macOS 打包。
- `assets/app-icon.ico` 用于 Windows 打包。
- `src/web/favicon.png` 用于 Web 与 Admin favicon。
- `src/desktop/favicon.png` 用于桌面 HTML favicon。

生成规则：

- 通过 `npm run icons` 执行 `scripts/generate-icons.js`，从源图生成平台资源。
- macOS 依赖系统 `sips` 与 `iconutil`。
- Windows `.ico` 由脚本写入多尺寸 PNG icon entry，覆盖 16/24/32/48/64/128/256。
- macOS 打包脚本通过 `--icon=assets/app-icon.icns` 接入 `.icns`。
- Windows 打包脚本通过 `--icon=assets/app-icon.ico` 接入 `.ico`。
- Web 静态服务必须为 `.png` 返回 `image/png`，避免 favicon 在严格浏览器中被错误 MIME 影响。

验收口径：

- macOS 窗口、Dock、打包产物显示应用 icon。
- Windows exe 显示 `.ico` 资源。
- Web `/` 与 `/admin.html` 均加载 favicon。
- icon 生成脚本可重复执行，输出文件路径稳定。

## 19. MVP 里程碑

### M1: 本地采集原型

- collector core 与 provider registry。
- `claude_code_local` provider。
- `codex_local` provider。
- 本地生成 UsageDaily。
- 本地工作目录 alias 维护。

验收：

- 能在 mac 上生成今日 usage JSON。
- 至少覆盖一个 Claude Code 或 Codex 真实样本。

### M2: 匿名身份与上传

- participantId / identityKey 生成。
- 身份包导出与导入。
- 设备注册。
- usage batch 签名上传。
- 服务端 upsert。

验收：

- 重复上传不会重复计数。
- 篡改 payload 会被拒绝。

### M3: 公开榜单

- 日榜。
- 周榜。
- 月榜。
- 用户详情页。

验收：

- 多个本地用户或测试设备可产生稳定排名。
- 普通榜只展示用户名、总量、各模型量。
- 用户详情和管理员页只展示公开目录名，不展示真实路径。

### M4: Windows 适配

- Windows 路径识别。
- Windows 本地数据目录识别。
- Windows 打包。

验收：

- Windows 可以完成采集、预览、上传。
- 路径 hash 和公开目录名逻辑与 mac 一致。

## 20. 后续扩展

可在 MVP 稳定后再做：

- 成本榜。
- 房间榜或团队榜。
- Git repo 维度识别。
- 私有榜单。
- 数据导出。
- 本地趋势图。
- 异常数据申诉或隐藏机制。

## 21. 关键风险

### 21.1 工具日志格式变化

风险：

- Codex 或 Claude Code 本地数据格式可能变化。

应对：

- scanner 版本化。
- usage parser 增加样本测试。
- 数据质量字段保留 `partial` 和 `unknown`。

### 21.2 工作目录隐私

风险：

- alias 或系统检测目录名可能泄露客户名、项目名。

应对：

- 默认不公开真实路径。
- 客户端在首次上传前展示公开目录名预览。
- 用户可以用 alias 覆盖系统检测目录名。

### 21.3 无登录导致身份不可恢复

风险：

- 用户换机器或删除本地配置后，无法恢复原 participantId。

应对：

- 第一版接受该限制。
- 后续可提供 recovery code。

### 21.4 排名被刷

风险：

- 用户可伪造本地数据。

应对：

- 第一版做签名、去重、异常阈值。
- 明确公开榜单是轻量社区榜，不是奖金竞赛。

## 22. 推荐最终 MVP 范围

最终建议第一版只做：

- 公开社区榜。
- 无登录昵称参与。
- mac/Windows collector。
- provider 化采集架构。
- 第一版内置 Claude Code、Codex 本地采集 provider，以及用户显式启用的 Cursor Dashboard Usage provider。
- 工作目录 alias 维护；未设置 alias 时展示系统检测目录名。
- token 总量排名。
- 成本字段预留，不做主榜。
- 不做 hook。
- Cursor 只做 dashboard token/model/date 采集，不做工作目录归因。

这个范围能最快验证产品是否成立：用户是否愿意安装 collector、是否愿意公开昵称和 token 总量、工作目录维度是否真的有价值。

## 23. 参考

- ccusage Guide: https://ccusage.com/guide/
- ccusage Directory Detection: https://ccusage.com/guide/directory-detection
- ccusage Codex Overview: https://ccusage.com/guide/codex/
- ccusage JSON Output: https://ccusage.com/guide/json-output
