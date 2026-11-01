# Magpie 插件页内容设计稿(page-content-design)

状态:内容层设计定稿(2026-11-01),面向 P0 实施。视觉体系(segs 滑块 / 单盒 KPI / 卡片 / 手绘 SVG)沿用 Magpie 自带 usage 页语言,**本文不改视觉,只定义内容**。

用户反馈原话:"整个插件页面里面展示的内容还是缺的,比如当前的用户名(昵称)都没展示"。

---

## 0. 现状盘点与三个事实约束

页面现状(page/index.html + app.js + view.js):

- 用量页:周期 segs(今日/近7/近30/全部)→ KPI 四格(总量/输入/输出/缓存,副行百分比)→ 按来源堆叠趋势图 + 右侧图例 → 53 周热力图 → 来源 / 模型 Top5 → 底部 `#since` 状态行(scopeLabel + 同步结果 + 绝对时间)。
- 设置页:身份卡(`#s-identity` = participantId + identitySource)、服务端卡、同步卡(说明文字 + 立即同步 + 打开榜单)、配置表单。

三个事实约束(设计必须绕着走):

1. **页面 iframe 无网络**。唯一数据通道是 `status.js` / `usage-data.js` 两个脚本注入桥(app.js `loadBridge`,4s 轮询)。任何"云端数据"都必须由 Bun 侧 sync.js GET 后写进 status.js。
2. **sync.js 失败路径不写 status**。当前 `writeStatus` 只在 noop / 成功上传两个分支调用;抛错进 catch 后只 `appendLog`,页面会一直显示**上一次成功**的状态(误导)。错误态是现状缺口,P0 必须补。
3. **昵称就在本机**。`resolveIdentity()` 返回的 `identity`(来自 `~/.config/magpie/atl-sync/identity.json`,0600)含 `nickname / deviceId / participantId`,sync.js 已经拿到,只是没写进 status.js——补昵称是零网络改动。

服务端可 GET 接口(已核对 src/backend/server.js 路由与 store.js 返回形状):

| 接口 | 关键参数 | 返回字段(摘) | 用途 |
| --- | --- | --- | --- |
| `GET /api/board/analytics` | `participantId`、`period=today\|this_week\|this_month\|all` | `rankStats: { rank, participantCount, leaderDays, isLeaderToday }`、`displayName`、`summary.totalTokens`(server.js L898;store.js `analyticsRankStats` L2052) | **主选**:一次拿排名四元组,不用拉全榜 |
| `GET /api/leaderboard` | `range=today\|last7\|last30\|all`、`tool=all` | `items: [{ rank, participantId, nickname, totalTokens, toolBreakdown, lastSyncedAt }]`(store.js L1202) | 备选/校验:可拿服务端侧昵称与周期总量 |
| `GET /api/health` | — | 健康体 | 已由 `checkHealth` 使用(测试连接) |

注意:`BOARD_SECURITY_LEVEL=authenticated` 的部署会对 `/api/board/*` 返回 401(server.js `checkBoardAuth` L297)——插件不带账密,必须降级(见 §2.3)。

---

## 1. 数据来源标注图例(全文适用)

- 【现有】= usage-data.js / status.js 已有字段,页面直接读。
- 【status 新增】= Bun 侧 sync.js 多写一个字段进 `page/status.js`,注明取自哪里。
- 【服务端 GET】= sync.js 在同步完成后额外发一次 GET,把结果写进 status.js;**页面自己永远不发请求**。降级策略随字段给出。

---

## 2. 核心决策:昵称与云端排名怎么放(回应用户反馈的专项评估)

**判断 1:昵称在用量页常驻,不在设置页藏着。**
用量页是默认页签,回答"这是谁的数据"。现 `#since` 状态行升级为**身份行**:行首昵称(与标题同视觉级别),后跟短 participantId、同步状态。设置页身份卡同步补全(昵称大字 + 完整 ID + deviceId)。昵称权威来源是本地 identity.json(注册时上报过,本地即云端)。

**判断 2:云端排名同时显示,但只是身份行内的一条摘要。**
排名回答"我传上去之后排第几",是同步类插件的核心反馈闭环。P0 只显示 `#3 / 12 · 今日` 一条(固定 today 口径,避免与本地"近7天=滚动窗口"口径混淆——服务端 `this_week` 是自然周,不等价)。P1 才做完整"榜单表现卡"(领先天数等)。

**判断 3:排名必须降级,且降级不惊扰。**
iframe 里页面无网络,一切云端数据天然是"最近一次同步时的快照"。规则:
- GET 失败 / 401 / 未配置服务端 → 身份行排名位显示 `—`,title 提示原因;
- 成功但数据过期(`fetchedAt` 距今 > 24h)→ 正常显示但灰显,后缀相对时间;
- **本地用量区块永远不因云端失败而变灰或报错**(本地与云端是两条独立链路)。

---

## 3. 用量页设计

### 3.1 线框

```
┌────────────────────────────────────────────────────────────────┐
│ AI Token League                            [ 用量 | 设置 ]      │
├────────────────────────────────────────────────────────────────┤
│ ●magpie-dev  p_3f9c2a   云端 #3 / 12 · 今日   ↗ 打开榜单        │ ← 身份行(P0 新增,替代原 #since 位置)
│ Magpie 统一口径(网关 + 本地会话)· 同步: 成功 · 5 分钟前       │ ← 状态行(原 #since 降为一行,相对时间)
├────────────────────────────────────────────────────────────────┤
│ [ 今日 | 近 7 天 | 近 30 天 | 全部 ]                            │
│ ┌ 总量 ────┐ ┌ 输入 ────┐ ┌ 输出 ────┐ ┌ 缓存 ────┐           │
│ │ 2.62 亿   │ │ 1.1 亿   │ │ 8.3 千万 │ │ 6.9 千万 │           │
│ │           │ │ 42%      │ │ 32%     │ │ 26%      │           │
│ └───────────┘ └──────────┘ └──────────┘ └──────────┘           │
│ ┌ 趋势 · 按来源堆叠 ────────────────────────────────┐ ┌ 图例 ┐ │
│ │ ▂▃▅▆▇█ (现有 SVG 堆叠柱图,不改)                  │ │ ZCode│ │
│ └───────────────────────────────────────────────────┘ └──────┘ │
│ ┌ 活跃热力图 · 最近 53 周(现有,不改)────────────────────────┐ │
│ └──────────────────────────────────────────────────────────────┘ │
│ ┌ 来源 ────────────────┐ ┌ 模型 Top 5 ──────────────────┐      │
│ └──────────────────────┘ └──────────────────────────────┘      │
└────────────────────────────────────────────────────────────────┘
```

KPI / 趋势 / 热力图 / 来源 / 模型五个区块内容不变(【现有】),以下只定义新增/修改区块。

### 3.2 区块 A:身份行(新增,P0)

- **目的**:一眼回答"这是谁的量、传到哪了、我在榜上排第几"。
- **字段清单**:

| 元素 | 内容与格式 | 来源 | 空态 | 错误态 |
| --- | --- | --- | --- | --- |
| 昵称 | 明文,如 `magpie-dev`;超长省略号 + title 全名 | 【status 新增】`nickname`,取自 `resolveIdentity()` 返回的 `identity.nickname`(identity.json) | 老桥文件无此字段 → 显示短 ID `p_3f9c2a` | 同空态(昵称是本地数据,无网络错误态) |
| 短 ID | `p_` + participantId 末 6 位,灰字,title 悬停完整 ID | 【现有】`status.participantId` 截断 | 无 status → 整行显示"未初始化" | 同空态 |
| 云端排名 | `#3 / 12 · 今日`;`#` 后接名次,`/` 后接参与人总数;title = "更新于 5 分钟前" | 【服务端 GET】见 §3.3 | 未配置 apiBaseUrl / 尚未成功同步过 → `—`,title"未同步到云端" | GET 失败或 401 → `—` + title"云端暂不可达";fetchedAt > 24h → 灰显 + 相对时间 |
| 打开榜单 | `↗` 链接,复用现有 `b-open` 逻辑(`apiBaseUrl + "/"`,新窗口) | 【现有】`status.apiBaseUrl` | 无 apiBaseUrl → 隐藏 | 不可达不隐藏(用户可能要自己看) |

- **格式**:名次与人数为整数;相对时间("5 分钟前 / 2 小时前 / 昨天")用 `Intl.RelativeTimeFormat` 或手写分钟级分档(zh/en 两套文案见 §6)。

### 3.3 区块 A 的云端取数(Bun 侧实施说明,P0)

sync.js 在**每次成功或 noop 同步之后**(以及 `--test-connection` 成功时)追加:

```
GET {apiBaseUrl}/api/board/analytics?participantId=<identity.participantId>&period=today
```

- 取 `rankStats.rank / rankStats.participantCount / rankStats.leaderDays / rankStats.isLeaderToday`(P0 页面只用前两个,后两个字段先落盘,P1 直接消费)。
- 写入 status(增量,见 §7 schema):`serverRank: { period: "today", rank, participantCount, fetchedAt }`。
- **失败策略**:GET 抛错 / 非 200 / 401 → 保留上一次 `serverRank`(带旧 fetchedAt,页面按 24h 规则灰显),并写 `serverRank.error = <message>` 供 title 展示;**不得让排名失败影响同步主流程的退出码**——排名 GET 包在自己的 try/catch 里,超时 5s。
- 未配置 apiBaseUrl 或 `enabled=false` 跳过 GET。

### 3.4 区块 B:状态行(原 `#since` 行升级,P0)

- **目的**:回答"数据新鲜吗、同步健康吗"。
- **字段**:

| 元素 | 内容与格式 | 来源 | 空态 | 错误态 |
| --- | --- | --- | --- | --- |
| 口径标签 | `Magpie 统一口径(网关 + 本地会话)` | 【现有】i18n `scopeLabel` | — | — |
| 同步结果 | `同步: 成功 / 无变化 / 失败: <error 前 80 字>`;成功绿、失败红(复用现有 `.ok/.err` 样式) | 【现有】`ok / noop / error`(error 目前**从未被写入**——见 §3.5) | 从未同步 → 只显示口径标签 | 红字显示 error;error 消失(下次成功)自动恢复 |
| 时间 | 相对时间("5 分钟前"),title 绝对时间 | 【现有】`lastSyncAt`,格式从 `toLocaleString` 改相对时间 | 无 lastSyncAt(noop 首跑)→ 显示 updatedAt 相对时间 | 同左 |

### 3.5 区块 B 的前置修复:失败也写 status(P0,硬性)

sync.js 的 `catch (error)` 分支(sync.js L407)当前只 `appendLog`;必须补:

```js
writeStatus({
  ok: false,
  error: String(error.message || error).slice(0, 200),
  identitySource: null,          // 尚未解析时不写
  participantId: <best-effort:读 identity.json,失败则省略>,
  apiBaseUrl: config.apiBaseUrl,
  lastSyncAt: <保留上次成功时间——从旧 status.js 读回或从 manifest firstSyncStart 旁路存>
});
```

退出码语义不变(1=错误 / 2=busy / 3=拒传,busy 与拒传也要写对应 error 文案:"另一同步进行中" / "账本完整性校验失败,已拒传")。

### 3.6 用量页其余区块(明确不动)

KPI 四格、趋势图、热力图、来源 / 模型列表:数据、格式、空态全部维持现状。唯一微调:空态文案 `noData` 从"暂无数据(尚未同步)"改为"暂无数据(等待 Magpie 记录用量)"——本地展示与"是否同步到云端"无关(usage-data.js 在 dry-run 也会写),原文案误导。

---

## 4. 设置页设计

### 4.1 线框

```
┌ 设置 ───────────────────────────────────────────────────────────┐
│ ┌ 身份 ─────────────────────────────┐ ┌ 云端排名 ─────────────┐ │
│ │ magpie-dev                         │ │ 今日  #3 / 12        │ │
│ │ 昵称                               │ │ 更新于 5 分钟前       │ │
│ │ participantId  p_1a2b3c…(全量,title可复制) │ │ [打开榜单]            │ │
│ │ deviceId       d_4d5e6f            │ └───────────────────────┘ │
│ │ 身份来源       本机存储(store)     │                           │
│ └────────────────────────────────────┘                           │
│ ┌ 同步 ────────────────────────────────────────────────────────┐ │
│ │ Ed25519 签名小时桶,服务端整桶覆盖幂等。(现有说明,保留)     │ │
│ │ 上次结果:成功 · 5 分钟前 · 上传 2 桶 / 3120 万 tokens         │ │
│ │ 数据源:网关 CSV(全史)· 累计 30 桶 · 首次同步 2026-10-31     │ │
│ │ [ 立即同步 ]  [ 打开榜单 ]                                    │ │
│ └──────────────────────────────────────────────────────────────┘ │
│ ┌ 配置(表单,现有,仅 2 处文案改动)──────────────────────────┐ │
│ │ 服务端地址 (API Base URL)  [________________]                 │ │
│ │ 昵称(已注册身份改名,下次同步生效)  [________]              │ │
│ │ 起始日期(留空 = 同步全部历史)  [______]                      │ │
│ │ ⊙ 包含 Magpie 自身 / 未识别客户端(magpie_local)             │ │
│ │ ⊙ 启用自动同步                                                │ │
│ │ [ 保存配置 ] [ 测试连接 ]                                     │ │
│ │ 隐私:仅上报 token 数与模型名…(现有,保留)                  │ │
│ └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 区块 C:身份卡(升级,P0)

- **目的**:回答"我是谁(榜单上的名字)、这台设备是什么身份、身份从哪来的"。
- **字段**:

| 字段 | 内容与格式 | 来源 | 空态 | 错误态 |
| --- | --- | --- | --- | --- |
| 昵称 | 大字,卡内主位 | 【status 新增】`nickname` | 无 → `p_` 短 ID 顶替 | 无(本地) |
| participantId | 全量显示(`p_` + 24 hex),等宽/小字号,title 提示可选中复制 | 【现有】`participantId` | `—` | 无 |
| deviceId | `d_` + 24 hex,同上 | 【status 新增】`deviceId` | `—` | 无 |
| 身份来源 | 枚举翻译:`本机存储 / 迁移文件导入 / 继承 ATL 客户端 / 全新创建 / 本机存储(已改名)` ← `store / migrate-file / adopt-atl / fresh / store-renamed` | 【现有】`identitySource`(需补 i18n 映射) | `—` | 身份文件损坏时 sync 拒跑,页面显示最后一次 status(见 §3.5 错误态) |

- 原"服务端"卡(`#s-server`)保留不动,与身份卡并列(现 tilerow 结构不变)。

### 4.3 区块 D:云端排名卡(新增,P0 骨架 / P1 补全)

- **目的**:回答"我在榜单上的位置、和多少人比"。
- **P0 字段**:`今日 #3 / 12`、`更新于 <相对时间>`、`[打开榜单]` 按钮(复用 b-open)。数据与用量页身份行同源(同一个 `serverRank`),不额外发 GET。
- **P1 追加字段**(数据 P0 已落盘):`领先 4 天`(`leaderDays`)、`今日第 1` 徽标(`isLeaderToday` 为 true 时)、`云端今日总量 9449 万`(取 `/api/board/analytics` 的 `summary.totalTokens`,与本地今日 KPI 并排对比,差异 > 5% 灰字提示"云端为已同步快照")。
- **空态 / 错误态**:同 §3.2 排名列(未配置 → 整卡显示"未启用云端排名,配置服务端地址后自动获取";失败 → 上次值 + 灰显)。

### 4.4 区块 E:同步卡(升级,P0)

- **目的**:回答"刚才那次同步干了什么、数据从哪读的、跑了多久了"。
- **字段**:

| 字段 | 内容与格式 | 来源 | 空态 | 错误态 |
| --- | --- | --- | --- | --- |
| 上次结果 | `成功 / 无变化 / 失败: <error>` · 相对时间 · `上传 2 桶 / 3120 万 tokens`(noop 时只显示桶数) | 【现有】`ok/noop/dirty/uploadedTokens/lastSyncAt`;tokens 用页面现有 compact 格式 | `尚未同步` | 红字(§3.5 修复后可用) |
| 数据源 | 枚举:`网关 CSV(全史)/ 网关 API(7 天窗口)/ 账本文件(仅网关口径)` | 【status 新增】`sourceChannel`(`csv / api / ledger`;sync.js loaded.sourceInfo.channel 已有,现只写 kind 没写 channel) | `—` | 数据源不可达导致的失败由"上次结果"红字承载 |
| 累计桶数 | `累计 30 桶` | 【现有】`buckets` | `—` | — |
| 首次同步 | `2026-10-31`(日期,不带时分) | 【status 新增】`firstSyncStart`,取自 manifest(sync-state.<api>.json 的 `firstSyncStart`) | `—` | — |

按钮区(立即同步 / 打开榜单)与说明文字不动。

### 4.5 区块 F:配置表单(文案微调,P0)

仅两处:

1. 昵称 label:`昵称(仅新身份首次注册时使用)` → `昵称(已注册身份改名,下次同步生效)`——与 identity.js 实际行为一致(改名会写回 identity.json 并在下次注册重报;noop 分支已处理 `store-renamed` 重注册)。
2. 保存成功 toast 后,若昵称变了,页面身份行/身份卡**立即**用表单值乐观更新,不等下次同步(status.js 的 nickname 下次同步才刷新)——避免"保存了但页面还显示旧名"的被截屏传播。

其余表单项、隐私提示、按钮不动。

---

## 5. 两页联动的刷新规则(P0)

- 身份行 / 状态行 / 设置页三卡全部由 `ATLView.renderStatus(status, t)` 渲染(现已有该函数,扩展即可);4s 桥轮询已覆盖,无需新定时器。
- `serverRank` 的 24h 灰显判断在渲染时做:`Date.now() - fetchedAt > 86400_000`。
- 相对时间统一一个帮助函数 `relTime(iso, lang)`(分钟/小时/天三档),两页共用,替换现 `toLocaleString`。

---

## 6. i18n 键清单(app.js T dict 增量,zh / en 全量文案)

沿用现风格(小驼峰键,`data-t` 或 `t.xxx`):

```js
// zh(新增 / 修改)
identityAs: "身份",                      // 身份行省略用(设置页 identity 已有,勿重复定义)
nicknameLabel: "昵称",
shortIdTip: "参与者 ID:{id}",             // title,插值
rankToday: "今日 #{rank} / {count}",
rankNone: "云端排名 —",
rankNeverSynced: "尚未同步到云端",
rankUnreachable: "云端暂不可达,显示 {time} 的结果",
rankUpdated: "更新于 {time}",
openBoard: "打开榜单",                    // 已有,身份行复用
lastResult: "上次结果",
uploadedSummary: "上传 {buckets} 桶 / {tokens} tokens",
noopSummary: "已最新({buckets} 桶)",
neverSynced: "尚未同步",
dataSource: "数据源",
sourceCsv: "网关 CSV(全史)",
sourceApi: "网关 API(7 天窗口)",
sourceLedger: "账本文件(仅网关口径)",
totalBuckets: "累计 {buckets} 桶",
firstSync: "首次同步",
idSourceStore: "本机存储", idSourceMigrate: "迁移文件导入", idSourceAdopt: "继承 ATL 客户端",
idSourceFresh: "全新创建", idSourceRenamed: "本机存储(已改名)",
deviceIdLabel: "设备 ID",
cfgNick: "昵称(已注册身份改名,下次同步生效)",   // 修改原键文案
noData: "暂无数据(等待 Magpie 记录用量)",        // 修改原键文案
busySync: "另一同步正在进行,稍后自动重试",
refuseIntegrity: "账本完整性校验失败,已拒传(详见 sync.log)",
relMin: "{n} 分钟前", relHour: "{n} 小时前", relDay: "{n} 天前",

// en(新增 / 修改)
nicknameLabel: "Nickname",
shortIdTip: "Participant ID: {id}",
rankToday: "#{rank} / {count} today",
rankNone: "Board rank —",
rankNeverSynced: "Not synced to the cloud yet",
rankUnreachable: "Board unreachable — showing result from {time}",
rankUpdated: "Updated {time}",
lastResult: "Last run",
uploadedSummary: "uploaded {buckets} buckets / {tokens} tokens",
noopSummary: "up to date ({buckets} buckets)",
neverSynced: "Never synced",
dataSource: "Data source",
sourceCsv: "Gateway CSV (full history)",
sourceApi: "Gateway API (7-day window)",
sourceLedger: "Ledger file (gateway only)",
totalBuckets: "{buckets} buckets total",
firstSync: "First sync",
idSourceStore: "local store", idSourceMigrate: "migration file", idSourceAdopt: "adopted from ATL client",
idSourceFresh: "freshly created", idSourceRenamed: "local store (renamed)",
deviceIdLabel: "Device ID",
cfgNick: "Nickname (renames apply on next sync)",  // 修改
noData: "No data yet (waiting for Magpie usage)",  // 修改
busySync: "Another sync is running — it will retry automatically",
refuseIntegrity: "Ledger integrity check failed; upload refused (see sync.log)",
relMin: "{n} min ago", relHour: "{n} h ago", relDay: "{n} d ago",
```

P1 追加键(先列出,本轮不实施):`leaderDays: "领先 {days} 天" / "Led {days} days"`、`leaderToday: "今日第 1" / "#1 today"`、`cloudTodayTotal: "云端今日 {tokens}" / "Cloud today {tokens}"`、`cloudSnapshotNote: "云端为已同步快照,与本地实时数据可能有差异" / "Cloud figures are synced snapshots and may lag local data"`。

---

## 7. status.js 目标 schema(P0 实施后的完整形状)

```jsonc
{
  "updatedAt": "2026-11-01T09:00:00.000Z",     // 现有(state.js 自动)
  "ok": true,                                   // 现有;false = 失败(§3.5 新增写入)
  "noop": false,                                // 现有
  "error": null,                                // §3.5 新增(ok:false 时填,截 200 字)
  "identitySource": "store",                    // 现有
  "sourceKind": "gateway",                      // 现有
  "sourceChannel": "csv",                       // 【新增】loaded.sourceInfo.channel(csv|api|ledger)
  "participantId": "p_xxxxxxxxxxxxxxxxxxxxxxxx",// 现有
  "nickname": "magpie-dev",                     // 【新增】identity.nickname
  "deviceId": "d_yyyyyyyyyyyyyyyyyyyyyyyy",     // 【新增】identity.deviceId
  "apiBaseUrl": "http://…",                     // 现有
  "buckets": 30,                                // 现有
  "dirty": 2,                                   // 现有
  "uploadedTokens": 31200000,                   // 现有
  "lastSyncAt": "2026-11-01T08:55:00.000Z",     // 现有
  "firstSyncStart": "2026-10-31T00:00:00.000Z", // 【新增】manifest.firstSyncStart
  "serverRank": {                               // 【服务端 GET 新增】§3.3
    "period": "today",
    "rank": 3,
    "participantCount": 12,
    "leaderDays": 4,                            // P0 落盘,P1 展示
    "isLeaderToday": false,                     // P0 落盘,P1 展示
    "cloudTodayTokens": 94493700,               // P1 用;P0 可不取
    "fetchedAt": "2026-11-01T08:55:30.000Z",
    "error": null                               // 最近一次 GET 失败原因(成功时清空)
  }
}
```

实施注意:失败写 status 时(§3.5)`serverRank` / `nickname` 尽量保底回填(先读旧 status.js 再覆盖写),避免失败一次就把昵称/排名打回 `—`。

---

## 8. 分期

### P0(本轮实施)

1. sync.js:失败/busy/拒传路径写 `ok:false + error`(§3.5)。
2. sync.js:成功/noop 后写 `nickname / deviceId / sourceChannel / firstSyncStart`(§7)。
3. sync.js:同步后 GET `/api/board/analytics?participantId&period=today`,写 `serverRank`(§3.3,含 5s 超时与失败保留旧值)。
4. 页面:用量页身份行(昵称 + 短 ID + 排名摘要 + 打开榜单)+ 状态行相对时间与错误红字(§3.2/§3.4)。
5. 页面:设置页身份卡补昵称/deviceId/身份来源翻译,同步卡补数据源/累计桶/首次同步,云端排名卡 P0 骨架(§4.2–§4.4)。
6. 页面:配置表单 2 处文案 + 昵称乐观更新(§4.5);`noData` 文案修正(§3.6)。
7. i18n §6 P0 键全量(zh/en)。

**P0 验收标准**:在 dev 服务器的真实插件页,用量页第一行能看到昵称 `magpie-dev`、短 ID 与今日云端排名 `#N / M`;停掉服务端后页面不报错,排名位变 `—` 且本地用量五区块照常渲染;制造一次同步失败(改错 apiBaseUrl 点立即同步),状态行出现红字错误文案。

### P1(下轮)

- 云端排名卡补全:leaderDays / isLeaderToday / 云端今日总量 vs 本地对比(§4.3 P1 字段,数据 P0 已落盘)。
- `cloudTodayTokens` 取数(从 board/analytics `summary.totalTokens`)。
- KPI 副行环比(本期总量 vs 上一等长周期,+x%)。

**P1 验收标准**:设置页云端排名卡显示领先天数与云端/本地今日总量对比,数字与 web 榜单个人页(`/profile`)同口径一致。

### P2(远期,不承诺)

- 排名周期联动(身份行排名跟随页首周期 segs 切换 today/week/month,需在 Bun 侧一次 GET 多周期或页面缓存三份数据)。
- 匿名模式(BOARD_SECURITY_LEVEL=anonymous)下展示"榜单显示名"(`/api/board/my-identity` 返回的 displayName)。
- 今日上榜对手 Top3 摘要(`GET /api/leaderboard?range=today` 前三名 + 自己)。

**P2 验收标准**(按项):周期联动切换"近 7 天"后排名与 web 榜单周榜名次一致;匿名模式页面显示匿名显示名而非空。

---

## 9. 不做什么(防膨胀清单)

| 不做 | 理由 |
| --- | --- |
| 不做成本/金额换算 | 插件隐私白名单只传 token 数与模型名;成本是 ATL"可选展示、非排名真相",引入价格表是第二个数据源与第二套对账口径,收益低 |
| 不做多身份/身份切换 | 身份模型是单身份 + 0600 私钥文件;影子验证阶段引入切换 UI 会放大" split identity 数据孤儿"风险(identity.js 明确拒绝静默重铸) |
| 不做页内完整云端排行榜列表 | iframe 无网络,列表只能随同步快照整段搬运;榜单有 web 页且"打开榜单"一键可达,页内复刻必然过期且维护两套 |
| 不做实时排名轮询/推送 | 排名新鲜度跟随同步节奏(hook 节流 60s + 15min interval)已够;页面 4s 轮询桥只刷本地文件,不会增加服务端压力,也不该增加 |
| 不做 workdir/项目维度展示 | 网关账本无 cwd,上传侧已是 `virtual:magpie:` 虚拟桶,本地展示 workdir 等于展示假维度 |
| 不做趋势图/热力图改版 | 视觉体系沿用 Magpie 自带页,内容层无新增字段需求 |
| 不做"测试连接"结果回显升级 | 现有命令握手 + toast 已够;连接问题由状态行错误态(§3.5)统一承载 |
| 不做 reasoning tokens 展示 | usage-summary 已聚合但 reasoning 是诊断字段、不进排名总量,展示会引起"为什么不加起来等于总量"的困惑 |

---

## 10. 实施涉及文件清单(开发索引)

| 文件 | 改动 |
| --- | --- |
| `magpie-plugin/sync.js` | 失败路径 writeStatus(§3.5);成功/noop 补 nickname/deviceId/sourceChannel/firstSyncStart;同步后 serverRank GET(§3.3) |
| `magpie-plugin/lib/uploader.js` 或新 `lib/board-query.js` | `fetchBoardRank(apiBaseUrl, participantId)` 封装(5s 超时、401/网络错误归一) |
| `magpie-plugin/page/view.js` | `renderStatus` 扩展:身份行、排名降级、相对时间、设置页三卡 |
| `magpie-plugin/page/index.html` | 用量页身份行节点;设置页云端排名卡、身份卡/同步卡字段节点 |
| `magpie-plugin/page/app.js` | T dict 新键(§6);昵称乐观更新(§4.5) |
| `magpie-plugin/test/` | status 新字段断言、失败写 status 断言、排名降级渲染断言(bun test) |
| `doc/magpie-plugin.md` §6 | 页面区块描述随实施同步更新 |

---

## 11. v2 修订:头部信息架构与去重(2026-11-01 实机反馈)

触发:实机截图后用户两点不满——①"整个头部的信息布局是有问题的";②"来源的内容其实和趋势里面是有重复的"。本节只修 §3.1 线框与 §3.2/§3.4 的**摆放与信息架构**;所有字段、来源、格式、降级语义(§3.2/§3.3/§3.4 的字段表、§7 schema)全部沿用;设置页(§4)不动。§3.1 旧线框自此作废,以本节为准。

### 11.1 问题诊断

1. **头部 4 行无层级、右列参差**:标题(16px)、身份行、状态行、周期 segs 四行全左对齐、字号相近(16/13.5/11.5/11px),视觉重量相同,没有扫读入口;右列更乱——行1 右是视图 segs,行2 右孤悬一个"打开榜单"胶囊(`margin-left:auto` 推到页边,与行内文字基线脱节),行3/4 右侧全空。
2. **来源卡与趋势图例纯重复**:图例行(`.rk`)已含"色点 + 来源名 + 总量 + 占比条 + 百分比"且按总量降序排列;下方来源卡(`ol#sources`)是同一组字段去掉色点的复读。且两处口径还不一致:来源卡取 Top 8,图例取 7 + 其他(跟随图表)。

### 11.2 推荐案(唯一案,不给备选)

头部收敛为**两行强层级 + 一条弱注脚**;趋势图例升格为唯一的来源排名面,来源卡删除、模型卡拉通全宽。

```
┌──────────────────────────────────────────────────────────────────────────┐
│ AI Token League   ● magpie-dev  p_4df04e…  今日 #1 / 1  [打开榜单]        │
│                                              [ 用量 | 设置 ] ←───────────┘ 行1:标题+身份 chip+榜单入口 ··· 视图 segs
│ [今日|近 7 天|近 30 天|全部] ························· 同步: 无变化 · 1 分钟前 │ 行2:周期 segs ················ 同步注记
│ Magpie 统一口径(网关 + 本地会话)                                          │ 注脚:口径(静态,11px 弱化)
├──────────────────────────────────────────────────────────────────────────┤
│ ┌ 总量 ────┬ 输入 ────┬ 输出 ────┬ 缓存 ────┐        (KPI 四格,不改)     │
│ ┌ 趋势 · 按来源堆叠 ──────────────────────────┐ ┌ 图例 = 来源排名 ───────┐ │
│ │  ▂▃▅▆▇(SVG 堆叠柱,不改)                    │ │ ● ZCode  1.2亿 ▓▓▓▓ 62%│ │
│ └─────────────────────────────────────────────┘ └────────────────────────┘ │
│ ┌ 活跃热力图 · 最近 53 周(不改)─────────────────────────────────────────┐ │
│ ┌ 模型 Top 5(全宽,原 duo 右卡拉通)────────────────────────────────────┐ │
│ └────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

设置视图:行1 照常(身份是全局上下文);行2 周期 segs `hidden`,只剩右侧同步注记;口径注脚随 `#view-usage` 隐藏。

**取材依据(全部是参考页已有语言,零新控件)**:参考页 `.usage-head`(app.css L909)就是"tab segs + 周期 segs + `.grow` + 右侧文字(`usage-cost`)同行"的控制行语言;参考页的口径说明(`usageScope` note)也是放在 stats 上方的一条 muted 注脚,不进头部。本页因标题+身份必须占行1,周期 segs 退一行就近左对齐;右侧同步注记正对 `usage-cost` 的位置语言。

### 11.3 DOM 结构(逐节点)

```html
<header id="head">
  <h1 data-t="title">AI Token League</h1>
  <span class="idchip">
    <i class="dot"></i>
    <b id="i-nick">—</b>
    <span class="pid" id="i-pid"></span>
    <span class="rank" id="i-rank"></span>
  </span>
  <button class="linklike" type="button" id="i-board" data-open-board
          data-t="openBoard" hidden>打开榜单</button>
  <span class="grow"></span>
  <div class="segs" id="views">…(现有,不动)</div>
</header>
<div class="headbar" id="headbar">
  <div class="segs small" id="periods">…(现有四键,不动)</div>
  <span class="grow"></span>
  <span class="since" id="since" data-t="neverSynced"></span>
</div>

<section id="view-usage">
  <p class="muted-note" id="scope-note" data-t="scopeLabel">Magpie 统一口径(网关 + 本地会话)</p>
  <section class="stats" id="stats">…</section>
  <section class="card">趋势 + 图例(#chart + #chart-legend,不动)</section>
  <section class="card">活跃热力图(不动)</section>
  <section class="card">
    <div class="c-head"><b data-t="models">模型 Top 5</b></div>
    <ol id="models"></ol>
  </section>
  <p class="empty" id="usage-empty" hidden data-t="noData">…</p>
</section>
```

| # | 节点 | id / class | 内容来源字段 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | 标题 | `h1[data-t=title]` | 静态 i18n | 原 header 里的 `flex:1` 占位 span 换成 `span.grow` |
| 2 | 身份 chip | `span.idchip` | — | 原伊 `.idrow` 整块删除,成员并入标题行 |
| 3 | 状态点 | `i.dot` | 静态(绿) | 装饰,不变 |
| 4 | 昵称 | `b#i-nick` | `status.nickname`,fallback `participantId.slice(0,8)`,再 fallback `"—"` | `max-width` + 省略号 + title 全名(沿用现实现) |
| 5 | 短 ID | `span.pid#i-pid` | `status.participantId.slice(0,8) + "…"` | **无 nickname 时 `hidden`**(防短 ID 出现两次) |
| 6 | 云端排名 | `span.rank#i-rank` | `serverRank` → `rankText()` | `—` / 灰显 24h / title 全部沿用 §3.2 |
| 7 | 打开榜单 | `button.linklike#i-board` | `status.apiBaseUrl` 存在才显示 | 紧贴 rank(gap 10px),不再 `margin-left:auto`;`hidden` 初值,`renderStatus` 按 apiBaseUrl 显隐;**只作用于这一颗**,设置页两颗按钮不受影响 |
| 8 | 视图 segs | `div.segs#views` | — | 不动 |
| 9 | 周期 segs | `div.segs.small#periods` | — | 从 `#view-usage > .c-bar` 上移到 headbar;app.js 视图切换时 `hidden = view !== "usage"`;`.c-bar` 包装删除 |
| 10 | 同步注记 | `span.since#since` | `status.ok/noop/error` + `relTime(lastSyncAt‖updatedAt)` | 由 `p.since` 改行内 `span`;`toast()` 继续复用它;HTML 初始 `data-t="neverSynced"` 作未初始化占位 |
| 11 | 口径注脚 | `p.muted-note#scope-note` | 静态 i18n `scopeLabel` | 复用现有 `.muted-note` 类;置于 `#view-usage` 顶部、stats 之前;**从动态状态行中拆出**(静态元数据不与同步结果混排) |
| 12 | 来源卡 | (删除) | — | `duo` 内左卡连 `ol#sources` 整块删除 |
| 13 | 模型卡 | `section.card > ol#models` | 【现有】 | 移出 `duo`,全宽;`.duo` 包装与其 CSS 一并删除 |

### 11.4 CSS 关键值

```css
header  { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin:0 0 6px; }
.grow   { flex:1; }                                    /* header 与 headbar 共用 */
.idchip { display:inline-flex; align-items:center; gap:8px; min-width:0; }  /* 原子单元:折行只在 chip 边界发生 */
.idchip .dot  { width:8px; height:8px; border-radius:50%; background:var(--magpie-green); flex:none; }
.idchip b     { font-size:13.5px; font-weight:600; max-width:24ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.idchip .pid  { font-size:11px; color:var(--magpie-muted); font-family:var(--magpie-code, ui-monospace, Menlo, monospace); }
.idchip .rank { font-size:11.5px; color:var(--magpie-fg-2, var(--magpie-fg)); font-variant-numeric:tabular-nums; white-space:nowrap; }
.idchip .rank.stale { color:var(--magpie-muted); }
#i-board { height:20px; padding:0 9px; border:0; border-radius:10px; background:var(--pill); color:var(--magpie-muted); font-size:11px; flex:none; }
#i-board:hover { color:var(--magpie-fg); }
.headbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; min-height:26px; margin:2px 0 8px; }
.since { color:var(--magpie-muted); font-size:11.5px; font-variant-numeric:tabular-nums; }  /* p→span:去 margin/min-height */
.since .ok { color:var(--magpie-green); }
.since .err { color:var(--magpie-red); }
/* 删除:.idrow 全部规则、.c-bar、.duo 系(仅 usage 页使用);其余全部不动 */
```

- 对齐方式:整行 **center 对齐**(与参考页 `.usage-head` 同款;16px 标题与 13.5px 昵称在 center 下视觉基线差约 1px,不可感知;参考页同行的 12px segs 与 15px cost 也是 center 混排)。
- 间距节奏:`header`(mb 6px)→ `headbar`(mt 2 / mb 8px)→ 口径注脚(`.muted-note`,stats 自身 mb 10px)→ KPI。行1/行2 右缘同贴 24px 页边,右列成一条线:视图 segs(行1)/ 同步注记(行2)。
- 窄宽:`header`、`headbar` 均 `flex-wrap:wrap` 兜底;chip 原子不拆;en 长文案折行后 segs 换行到下一行右侧,不横向滚动。

### 11.5 降级矩阵(每行逐格验收)

| 场景 | 行1 身份 chip | 行1 打开榜单 | 行2 同步注记 |
| --- | --- | --- | --- |
| 正常(昵称+排名齐全) | `● magpie-dev p_4df04e… 今日 #1 / 1` | 显示 | `同步: 无变化 · 1 分钟前` |
| 旧 status.js 无 nickname | `● p_4df04e…`(短 ID 粗体顶替);`.pid` 隐藏防重复 | 显示 | 不变 |
| 无 status.js(未初始化) | `● —`;pid 空;rank `—`(title 空) | 隐藏(hidden 初值) | HTML 初始文案 `neverSynced` |
| 未配置 apiBaseUrl | rank `—`,title"尚未同步到云端" | **隐藏**(本地链路独立,其余不灰) | 照常显示本地同步结果 |
| rank GET 失败(曾成功过) | `—`,title"云端暂不可达,显示 X 前的结果" | 显示 | 不变 |
| rank 数据 > 24h | 正常文字但灰显 `.stale`,title"更新于 X 前" | 显示 | 不变 |
| 同步失败 | 不变(排名与本地链路互不影响) | 不变 | `同步: 失败: <error 前 80 字>` 红字(`.err`) |
| 超长昵称 | 24ch 省略号,title 悬停全名 | — | — |

### 11.6 i18n 键增量

**无新键。**头部与注脚全部复用现有键:`title / scopeLabel / openBoard / rankToday / rankNone / rankNeverSynced / rankUnreachable / rankUpdated / neverSynced / ok / noop / err / shortIdTip / relMin / relHour / relDay / justNow`。唯一清理:`sources` 键(zh/en)随来源卡删除而不再被引用,**建议一并删除**(zh `"来源"` / en `"Sources"`)。

### 11.7 view.js / app.js 行为增量(实施清单)

- `view.js renderStatus`:①无 nickname 时 `#i-pid.hidden = true`;②`#i-board.hidden = !status.apiBaseUrl`;③删除 `paintList("sources", …)` 调用;④`!hasData` 分支补清空 `#models`(现分支只清 chart/legend/heat,切周期会残留陈旧行——顺手修复);⑤`#i-pid` 补 `hidden = !status.nickname` 逻辑入现有渲染流。
- `app.js`:`segInit($("views"))` 回调补 `$("periods").hidden = currentView !== "usage"`;`toast()` 目标仍是 `#since`(行内 span 照常承载)。
- `index.html`:按 §11.3 重排;删 `.idrow` 块、`.c-bar` 包装、`duo` 左卡与包装。

### 11.8 验收标准

1. 实机截图:头部呈"行1 身份 / 行2 控制 / 注脚 口径"三级;行1 右缘 = 视图 segs、行2 右缘 = 同步注记,同贴 24px 页边成一条线;"打开榜单"紧贴排名 chip(间距 10px),不再悬浮行尾。
2. 来源卡不存在于 DOM;趋势图例仍列全 7 + 其他来源、按总量降序;模型卡全宽,占比条随容器伸缩;≤860px 时图例折到图下、页面单列无横向滚动。
3. 切到设置视图:周期 segs 与口径注脚隐藏;行1 与同步注记保持;点"立即同步"后 4s 内行2 注记刷新。
4. §11.5 降级矩阵 8 行逐一人工触发并截图(改错 apiBaseUrl、停服务端、删 status.nickname、伪造过期 fetchedAt)。
5. zh/en 各截图一轮:en 下行1 允许折行,chip 内部不拆散;`noData`/错误文案两种语言都成立。
6. 回归:`node --check page/app.js page/view.js` 通过;现有桥轮询与 render 签名跳过机制不受影响(静止 1.5s 重绘 hover 不丢);设置页全部卡片内容不变。

> **v3 注记 (2026-11-01)**: 本文档 §11 的 v2 修订已被 `doc/page-redesign-v3.md` 整体取代——头部信息架构/8 格 KPI/模型卡/setgrid 双列均已废弃,以 v3 稿为准。
