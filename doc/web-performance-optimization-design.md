# Web 加载性能与展现优化设计（P0 传输 / P1 服务端缓存 / P3 动效）

Date: 2026-09-13
Status: **已实现，待用户验收**（未 commit）。实现记录见文末 §8。
Scope: 公开 Web + admin（`src/web/`、`src/backend/server.js`、`src/backend/mysql-store.js`、`src/backend/store.js`、`src/shared/chart-helpers.js`）

## 1. 背景与实测基线

2026-09-12 两个大 feature（主题系统 71b8db4e、团队看板 87513e3c/e49d3d5a）上线后，页面数据加载体验出现倒退。2026-09-13 用 env.test（连远程 dev MySQL `ai_token_league`，14,705 行 usage_daily × 27 列）实测首页 `/`、`/analytics.html`、`/teams.html` waterfall，基线如下：

| 测量项 | 实测值 | 根因定位 |
| --- | --- | --- |
| styles.css | 237KB → 323KB（一天 +36%） | 71b8db4e 净增 ~3,000 行，单文件全站加载 |
| 首页单次导航传输（本地+字体） | 772KB，未压缩 | `serveStatic` 无 gzip、无缓存头 |
| 同一批资源 gzip 后 | ~150KB（CSS 58K / i18n 40K / chart-helpers 21K） | — |
| `/api/board/analytics` 冷 / 热 | 2.6s / 3ms | 365 天热力图并集 `SELECT *`，12.5 倍过度取数（14,705 vs 1,174 行） |
| analytics.html 打开时同数据再冷算 | 2.3s | `range=this_month` vs `period=this_month` vs `/api/admin/analytics` 三种参数拼法 = 三个缓存键 |
| `/api/admin/teams/analysis` | 7 天 ~110ms、30 天 ~510ms，每次如此 | 未接 `cachedAggregate`，每次全量重算 |
| `/api/board/source-leaderboard` | ~300-400ms，每次如此 | MySQL 版直打两条全表 GROUP BY，无结果缓存 |
| Google Fonts CSS | 246-422ms（render-blocking） | 外链 fonts.googleapis.com，国内有秒级挂起风险（305ea48a 引入，非昨天） |
| 切主题 / 切语言 | `window.location.reload()` | theme-switcher.js:157；图表色板在加载时读死成 JS 常量 |

三层叠加的定性结论：

1. **传输层**：`serveStatic`（server.js:1183）只写 content-type 就 `pipe`——无压缩、无 `Cache-Control`/`ETag`/`Last-Modified`。浏览器对无验证器响应不复用，**每次导航、每次切主题/语言 reload 都重新下载全部 ~772KB**。
2. **服务端计算层**：analytics 冷算 2.6s 且缓存键碎片化；`invalidateAggregateCache` 被每次采集端上传触发（78 收集器 × 15 分钟同步），生产上聚合缓存常态失效；teams / source-leaderboard 完全无缓存。
3. **交互层**：主题/语言切换全量重载；首页每页还 `<link rel=prefetch>` 预取 4 个页面 HTML（~57KB）在关键路径抢带宽。

## 2. 决策记录（Out of Scope）

- **不做读写分离部署拓扑**（用户 2026-09-13 拍板）：不引入"只读 API 进程 + 反代"的多进程部署要求，保持当前无状态单进程形态。写路径（`withWriteLock` + `GET_LOCK` 全局单写者）本轮不动。
- 写路径并发的长期方向已有独立设计覆盖：`doc/mysql-request-local-write-lock-design.md`（请求级写 + 范围锁）。该文档诊断与本轮一致：共享 `this.db.*` 镜像作为请求工作状态是全局锁的根因。本轮不实施。
- CSS 物理拆分（按页拆文件）暂不做：P0 缓存 + gzip 生效后 323KB → 58KB 且重复导航 304 零字节，收益已够；拆分留作后续可选项。
- 语言切换不做无重载方案：文本节点遍布全站，改造面大；P0 后 reload 变成 304 快速重载，性价比可接受。

## 3. P0 传输层（预期半天，体感收益最大）

### P0-1 静态资源 gzip 压缩

`serveStatic` 内对文本类响应启用 Node 内置 `zlib.createGzip()` 流式压缩：

- 适用 content-type：`text/css`、`text/javascript`、`text/html`、`application/json`、`image/svg+xml`。
- 仅在请求头含 `Accept-Encoding: gzip` 且响应体预估 ≥ 1KB 时压缩。
- 响应头补 `Content-Encoding: gzip` 与 `Vary: Accept-Encoding`。
- 不压缩已压缩格式（png 等）。

### P0-2 缓存头与条件请求

项目无构建步骤、资源文件名不带哈希，因此**不走长 `max-age`**，统一用 ETag 重验证策略，保证发版零陈旧风险：

| 资源 | 策略 |
| --- | --- |
| CSS / JS / HTML | `Cache-Control: no-cache` + `ETag`（弱 ETag，由 mtime+size 派生），支持 `If-None-Match` → 304 |
| 字体 woff2 | `Cache-Control: public, max-age=31536000, immutable`（更换字体时改文件名） |
| API GET JSON | 可选：对响应体做 ETag，重复访问 304（leaderboard 63KB 级载荷收益明显）；列为 P1 尾项，非本轮必须 |

预期效果：重复导航所有静态资源 304 零字节传输；首次访问传输量 772KB → ~150KB。

### P0-3 字体自托管

- 下载 Inter（400/500/600/700/800）与 IBM Plex Mono（500/600）latin 子集 woff2 至 `src/web/fonts/`（中文文本继续走系统字体栈，与现状一致）。
- `styles.css` 顶部写 `@font-face`（`font-display: swap`，`unicode-range` 限 latin）。
- HTML 中移除 `fonts.googleapis.com` / `fonts.gstatic.com` 的 preconnect 与 stylesheet 外链（6 个页面文件各 3 行）。
- 对首屏关键两个字重加 `<link rel="preload" as="font">`。
- 验收标准：页面加载零 `fonts.g*` 外链请求；DevTools 无字体 FOIT 阻塞。

### P0-4 prefetch 清理

移除 6 个页面尾部对 `/`、`/leaderboard.html`、`/analytics.html`、`/profile.html` 的 `<link rel="prefetch">`。P0-2 生效后导航本身是 304 快速加载，无需预取抢带宽。若后续需要，可在 `requestIdleCallback` 里做低优先级预取（本轮不做）。

## 4. P1 服务端计算与缓存

### P1-1 analytics 取数拆分（消灭 365 天过度取数）

现状 `mysql-store.js:977` `analytics()` 把热力图 365 天并进 `SELECT * FROM usage_daily WHERE day IN (...)`。拆成两条路径：

1. **周期数据**：只查 `periodDays`（this_month=1,174 行），列投影只取 computeAnalytics 实际消费的字段（participantId / day / toolCode / providerId / model / inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens / totalTokens / estimatedCostUsd / workdir 关联所需列），不再 `SELECT *` 27 列。
2. **热力图数据**：改为 SQL 聚合 `SELECT day, SUM(totalTokens) ... FROM usage_daily WHERE day IN (365 天) GROUP BY day`，结果 365 行，绕开 `withScopedUsageRows` 的行级镜像。热力图结果单独按 businessDay 缓存（写入只影响当天，历史天不可变，天然长寿）。

需同步核对 `computeAnalytics`（store.js）中热力图输入结构，保持返回 JSON 形状不变（纯性能改造，对外契约不动）。目标：`this_month` 冷算 2.6s → < 300ms。

### P1-2 缓存键规范化

新增 `canonicalAnalyticsArgs({period, range, start, end, participantId})`：`range` 缺省时由 `period` 归一填充，日期规范化成 `YYYY-MM-DD`，输出稳定 key。`/api/board/analytics` 与 `/api/admin/analytics`（server.js:831/880）在调 store 前统一过这个函数，使"同数据不同拼法"命中同一份 `aggregateCache`。前端不改（`range=`/`period=` 两种用法都合法）。

### P1-3 失效策略精细化

现状：任何写入 → `invalidateAggregateCache()` 全量核爆，收集器 15 分钟一传，缓存常态失效。改为**按受影响天失效**：

- 写路径上报"本次写入触碰的天集合"（上传基本都是当天；full-reconcile 等历史写会报多天）。
- 聚合缓存条目记录自己的窗口；仅当写入天 ∩ 窗口 ≠ ∅ 时逐出该条目。
- 全史类（`range=all`）条目：触碰任何历史天则逐出；只碰当天时改为短 TTL（30-60s）容忍，避免 15 分钟一炸。

实现落点：`cachedAggregate`（store.js:2163）条目结构加 `windowDays`；`invalidateAggregateCache` 升级为 `invalidateAggregateCacheForDays(days)`，原全量函数保留给历史写与管理端操作。

### P1-4 teamsAnalysis 缓存 + 单遍索引

- MySQL 版（mysql-store.js:307）与 JSON 版（store.js:2680）都包进 `cachedAggregate`，key = `(businessDay, days)`，按 P1-3 的天窗口失效（窗口=当期+往期天集合）。
- JSON 版 `computeTeamsAnalysis` 内部先按 participantId 建一次索引（单遍 `for` 径组建 Map），替换现在每成员 3+ 次 `usage.filter(...)` 全表扫 + `daily` 里逐天再 filter 的 O(成员×全表) 写法。

### P1-5 sourceLeaderboard 结果缓存

MySQL 版（mysql-store.js:671）两条全表 GROUP BY 的结果包 `cachedAggregate`（JSON 版已有此包裹，见 store.js:1336，对齐即可），key 含 args + businessDay，天窗口失效同 P1-3。

## 5. P3 前端展现与动效

### P3-1 主题切换零重载（去 `location.reload()`）

根因：图表色板在页面加载时读成 JS 常量，运行中改 CSS 变量不生效。改造：

- `src/shared/chart-helpers.js` 色板获取改为**渲染时** `getComputedStyle(document.documentElement).getPropertyValue(varName)` 读取（每图渲染一次并短缓存，事件后失效）。
- `theme-switcher.js` `applyThemeScheme()` 后派发 `CustomEvent("atl:themechange")`；各页面监听后用已有 `state.data` 重跑渲染函数（不发 API）。
- 删除 `window.location.reload()`（theme-switcher.js:157）。
- 注意：chart-helpers 是共享模块，改造需过 `npm run test:ui`（desktop renderer 单测）确认无桌面侧回归。

### P3-2 页面切换 View Transitions（渐进增强）

- 各 HTML `<head>` 加 `<meta name="view-transition" content="same-origin">`，启用同源跨文档视图过渡。
- `styles.css` 加 `::view-transition-old(root)` / `::view-transition-new(root)` 的淡入淡出 + 微位移（~180ms，缓动 ease-out）。
- 不支持的浏览器（Safari/Firefox 当前）自动退化为普通导航，无兜底代码。

### P3-3 数据进场动效

借鉴 linear.app / vercel dashboard 的克制风格，全部包 `@media (prefers-reduced-motion: reduce)` 关闭：

- **卡片 stagger**：看板/榜单卡片首次渲染按序 fade + translateY(8px)，级联间隔 40-60ms，CSS `animation-delay` 驱动。
- **KPI count-up**：数值从 0 或前值滚动到目标（requestAnimationFrame，~600ms，ease-out；已有 `formatTokenCompact` 保持最终值格式）。
- **图表 draw-in**：趋势/面积图首绘用 clip-path 或 scaleX 展开（复用现有 `is-settled`/`is-refreshing` 状态钩子，不新增状态机）。
- **刷新反馈**：周期切换时保留现有 `is-refreshing`，叠加轻微透明度过渡，避免硬闪。

### P3-4（可选）i18n 按语言拆分

`src/shared/i18n.js` 152KB（双语字典全量下发）。按语言拆两个模块、只加载当前语言可省 ~110KB raw / ~20KB gzip。P0 后优先级降低，列为可选项。

## 6. 验证方案

| 项 | 验收口径 |
| --- | --- |
| P0-1/2 | `curl -sI -H 'Accept-Encoding: gzip' /styles.css` 见 `Content-Encoding: gzip` + `Vary` + `ETag`；二次请求带 `If-None-Match` 返回 304；`npm test` 过 |
| P0-3 | Playwright 加载首页：资源列表零 `fonts.g*` 请求；`npm run test:ui`、`npm run test:e2e` 过（桌面不受影响） |
| P1-1 | 冷启动（重启服务）后 `curl /api/board/analytics?range=this_month` 首次 < 300ms（本地 MySQL 部署复测；远程 dev DB 以行数与 SQL 计划为准） |
| P1-2 | 先请求 `range=this_month` 再请求 `period=this_month`，第二次命中缓存（耗时 ms 级） |
| P1-3 | 模拟一次"今天"写入后，`range=all` 缓存存活（或 60s 内重建一次）；写入历史天后全史缓存逐出 |
| P1-4/5 | `teams/analysis` 与 `source-leaderboard` 连续两次请求第二次 < 10ms |
| P3-1 | 切主题后图表配色即时变化、无 reload、Network 无新请求；`npm run test:ui` 过 |
| P3-2/3 | 目检 + `prefers-reduced-motion` 下动效关闭；无布局抖动（CLS=0） |
| 全局回归 | `npm test` + `npm run test:ui` + `npm run test:e2e`；刷新后数据与改造前逐字段一致（API 返回 JSON 形状不变） |

## 7. 实施顺序与风险

顺序：P0-1 → P0-2 → P0-3 → P0-4（一个 PR，传输层一把收）→ P1-2（缓存键，纯服务端低风险）→ P1-1（取数拆分，需核对 computeAnalytics 消费面）→ P1-4/5 → P1-3（失效精细化，最 delicate，单独 PR 加测试）→ P3-1 → P3-2/3 → P3-4（可选）。

主要风险与对策：

- **ETag 计算开销**：mtime+size 派生弱 ETag，零哈希成本；`statSync` 已在现有路径发生。
- **P1-1 漏列**：列投影漏字段会导致 analytics 局部 NaN——验收里加"改造前后 `/api/board/analytics` 全 range 响应 deep-equal"对比测试。
- **P1-3 失效漏逐出**：会看到陈旧数据。对策：full-reconcile、管理端删除、定价重算保留全量失效；P1-3 只放宽"当天常规上传"这一条路径。
- **P3-3 动效抖动**：所有 transform/opacity 动画，不碰布局属性；`prefers-reduced-motion` 全量关闭。

## 8. 实现记录（2026-09-13，未 commit）

### 已落地项与实测结果（env.test 远程 dev MySQL，14,705 行 usage_daily）

| 项 | 实测结果 |
| --- | --- |
| P0-1/2 静态 gzip + ETag 304 | styles.css 323KB→58.5KB；重复导航 11 项资源 304 重验证，**首页重复访问总传输 7KB**（基线 772KB+ 每次全量） |
| P0-2b API gzip + ETag（实现时追加，超出原设计） | `sendJson` 基于 `res.req` 内容协商：leaderboard 63KB→11.8KB；重复请求 304 零字节。ETag 取自当次响应体哈希，不会服务陈旧数据；不声明 Accept-Encoding 的客户端（Rust reqwest 无 gzip feature）自动拿 identity |
| P0-3 字体自托管 | 7 个 latin woff2 共 ~230KB 入 `src/web/fonts/`；6 页零 fonts.googleapis 请求；preload Inter-400 + IBMPlexMono-600 |
| P1-1 取数拆分 | `this_month` 冷算 2.6s→**0.67s**（列投影 16/27 列 + 热力图/月度改 SQL GROUP BY，`analyticsHeatAggregate` 按 businessDay 缓存） |
| P1-2 缓存键规范化 | `canonicalAnalyticsArgs`：`period=this_month` 紧随 `range=this_month` 后 **3ms** 命中（基线再冷算 2.3s）；admin 路由复用同一份缓存 1.7ms |
| P1-3 天窗口失效 | 上传只失效与其窗口相交的聚合项；热力图聚合对"仅今天"写入有 60s 容忍（`todayToleranceMs`）；其余写路径保持全量失效 |
| P1-4 teams 缓存+单遍索引 | 二次请求 110ms→**1.7ms**；JSON 版改单遍建 participantId/day 索引 |
| P1-5 source-leaderboard 缓存 | 二次请求 ~400ms→**2.7ms** |
| P3-1 主题零重载 | 切换无导航、无 API 请求、accent 与图表填充即时换色（207,106,66→254,16,15）；`COMPOSITION_PARTS`/`SHARE_TREND_PALETTE` 改 getter 惰性取值 |
| P3-2 View Transitions | 6 页 meta + root 淡切（Chromium，其余引擎平滑降级） |
| P3-3 动效 | an-kpis/an-main/teams-stack 卡片 45ms 级联进场（fill backwards 不压 hover）；chart-svg wipe-in 兼作刷新反馈；KPI count-up 600ms ease-out；全部受 prefers-reduced-motion 关闭 |

### 一致性验证（旧 HEAD worktree 对照服务 vs 新服务，同一 DB）

- `/api/board/analytics`（this_month/last30/all/today/yesterday/this_week/last_month/last12_months）、`/api/admin/analytics`、teams/analysis（7/14/30 天）、source-leaderboard、board/summary、leaderboard：**token 整数与结构全部一致**；`all` 区间全字段精确一致；周期区间仅 `estimatedCostUsd` 浮点末位差异（行累加顺序变化，~1e-10 相对误差）。
- 实现中修复：SQL 月度聚合按 `LOWER(TRIM(model))` 分组，对齐 JS `normalizeUsageModel`（否则 GLM 大小写变体分裂进月度构成，实测差 8.5%）。

### 门禁

`npm test` 全过；`npm run test:ui` 544/544；`npm run smoke` 过；`npm run test:e2e` 93/94——唯一失败 `settings.spec.js:47 语言切换器` 在干净 HEAD worktree 上同样失败（存量问题，与本轮无关）；`mysql-dual-backend-e2e.js` 退出码 0（结尾 Pool is closed 为 teardown 噪音）。已知存量页面错误：analytics 页 `reading 'timeSeries'`（新旧均在，未修，超本轮范围）。

### 遗留建议（未实施）

- 首页画廊 `desktop-workdirs.png` 882KB 是首访最大单项；建议转 WebP/压缩（视觉资产变更需用户拍板质量）。已从"每次访问重下"变为"仅首访"。
- i18n 按语言拆分（P3-4 可选项）未做。

## 9. 子代理评审轮（2026-09-13，已修复）

两个独立子代理评审（timeSeries 存量错误定位 + 本轮变更全量 review）结论与处置：

| 发现 | 级别 | 处置 |
| --- | --- | --- |
| F1 团队四 mutation（create/rename/delete/setParticipantTeam）不失效 teamsAnalysis 缓存，管理端编辑后看板回显旧数据 | P1（本轮缓存引入的真 bug） | **已修**：store.js 四方法补 `invalidateAggregateCache()`；补单测（rename 即时反映）；dev 库现场验证建队/删队即时可见 |
| analytics 页 `reading 'timeSeries'` pageerror：ResizeObserver 初始回调早于数据到达 | 存量 | **已修**：observer 回调加 `if (!state.data) return` + 221/224 行 `state.data?.`；浏览器复验 pageerror=0，图表照常 |
| JSON store custom 区间 analytics 缓存跨天陈旧（dayScoped=false） | P2 | **已修**：非 all 一律 dayScoped（窗口含 trailing-365 本就随天滑动）；补单测 |
| styles.css 旧 `@view-transition` + 80ms 时长块被新动画简写覆盖成死代码 | P2 | **已修**：删除旧块，View Transitions 统一由 meta 启用、由文末动画块驱动 |
| 字体缺 OFL 许可文本（公开仓库再分发要求） | P2 | **已修**：补 Inter-OFL.txt / IBMPlexMono-OFL.txt |
| canonical 键 / 天窗口失效 / tolerance 零直接单测 | P2 | **已修**：新增 `testAggregateCacheDayWindowInvalidation`（canonical 合并、today 写逐出与重算、容忍宽限与过期、历史写直删、团队编辑逐出、custom 跨天重算） |
| teams-stack / admin sources-summary 每次重渲重放级联动画 | P2（机制确凿，意图存疑） | **保留**：重放兼作数据刷新反馈，观感偏好留给用户验收拍板；如不要可后续加"仅首帧"门控 |
| `Accept-Encoding: gzip;q=0` 理论误判 | 忽略 | 无现实客户端 |

复验门禁：`npm test`（含新单测）、`test:ui` 544/544 全绿；analytics 页 pageerror=0；F1 现场（缓存热时建队/删队即时可见，临时队已清理）。
