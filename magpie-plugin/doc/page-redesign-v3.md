# AI Token League Magpie 插件页重设计稿(v3,推倒重做)

日期:2026-11-01。对象:`magpie-plugin/page/`(index.html / style.css / view.js / app.js)。
触发:用户实机评价——"整个头部的信息布局是有问题的。来源的内容其实和趋势里面是有重复的。产品能力不够强""这真的是产品可用吗?你自己看看 Magpie 产品是怎么设计的"。
v2 修订(doc/page-content-design.md §11)只挪了头部摆位、删了来源卡,没有触及"页面在讲什么故事"这一层,所以救不回来。本稿推倒重排,给出开发可直接照做的规格;v2 §11 的 DOM 细节以本稿为准作废。

数据边界(不可逾越,不造数据):页面无网络,全部数据来自 status.js(身份/同步结果/同步进度/数据通道/榜单快照 rank·participantCount·leaderDays·isLeaderToday·cloudTodayTokens)与 usage-data.js(今日+217 天逐日聚合:tokens 四分项/请求/失败/费用,按来源与按模型)。范围:今天/7天/30天/全部;指标:token/请求/费用;拆分:来源/模型。配置走 options,命令只有 立即同步/测试连接/导出配置/导入 ATL 配置。

---

## 0. 诊断:现在为什么"不可用"

(依据:源码通读 + Playwright 实机截图,见 `/tmp/product-teardown/01~06*.png` 与下述 DOM 实测)

1. **进页面 4 行之内没有任何一个数字。** 实测 DOM:标题行(61px 高,内含 h1 16px + 昵称 13.5px + 短 ID 11px + 排名 11.5px + 榜单胶囊)→ headbar(周期 segs + 同步注记)→ 口径注脚 → 才到 8 格 KPI。头部塞了 4 种字号、5 类信息,全是"元信息",没有一个是用户来这页要看的内容。
2. **8 格 KPI 是一面数字墙,没有主次。** 总量(本产品唯一的排名真值)与"失败数"平起平坐占同样一格;副行是"输入 2% / 输出 0%"这类永远凑成 100% 的噪声占比;命中率 97% 的口径(cacheRead÷total)和它的名字对不上。Magpie 是 4 格,每格副行给"推导"而不是装饰。
3. **来源/模型维度与趋势图例重复**(用户点名的第二条):图例(右侧 rank)已经是"色点+名称+总量+占比条+请求数+百分比"的完整排名,而"模型 Top 5"卡在 split=model 时是同一份信息的第二次渲染;split=source 时模型卡又和图例口径不一致。维度切换是"图的属性",不是另一张卡。
4. **产品的灵魂——联赛——不可见。** leaderDays、isLeaderToday、cloudTodayTokens 三个字段在 UI 里完全没用上;头部挤着一枚 11.5px 的"今日 #1 / 1",既没有情绪也没有上下文。这是"Token League",页面却长得像一块通用仪表盘。
5. **today×model 会画出"一根柱子的图表"**(view.js L474-484:把今日折叠成单柱)。交互没有被数据边界约束住,坏状态直接见人。
6. **反馈通道复用状态行**:toast() 直接改写 `#since`(app.js L249-253),"命令已发送""已保存"与"同步:无变化"挤同一行 11px 文本。
7. **加载态是 8 个"—"**,空态是"8 格 — + 3 张空卡 + 页底一行'暂无数据'"。Magpie 的做法分别是同构骨架屏和"一句主文案+一句指路"替换整块 KPI。
8. **费用格式 `$642.5`**(compact 记数法直接拼 $),小数位不稳定;Magpie fmtCost:≥100 取整、≥1 两位、再小三位,未知价显示空串而不是 $0,估算价带 ≈。

---

## 1. Magpie 用量页的产品规律(源码拆解结论,后文以 R1–R8 引用)

拆解对象:`/tmp/magpie-src/internal/gui/assets/`(app.js 24k 行、app.css、plugins/usage/page.js 4k 行、client.js、index.html)。它的用量页是全应用最成熟的一页,规律如下:

- **R1 头部只是控制行。** `.usage-head`(app.css L909)一行 34px,只放:tab segs + 周期 segs + 刷新按钮 + 本期费用合计。没有任何身份、没有任何状态、没有标题(侧栏已命名了这一页)。要"切换"的进头部,要"知道"的进正文当内容。
- **R2 KPI 恰好 4 格,一格一个论点,副行永远给推导。** `.stats` 是一个网格容器、1px 缝显底色当分隔线(L1199-1207),不是 4 张卡;数字 20px tabular-nums,标签 11px 大写;副行是"X in · Y out""hit rate 43%""2 failed"这种口径拆解,每个 span 整体不折断(usageParts,page.js L486-490)。
- **R3 一页只有一张趋势图;拆分是图的属性,图例=排名=过滤器。** Requests 页 `led-trend`:指标 segs + grow + "Split by" + 拆分 segs,同一条数据画图、配右侧 rank 列表,rank 行可点、点了过滤下方请求列表(client.js L75-88、page.js L1599-1644)。全文不存在"第二张卡复述图例"的结构。
- **R4 密度靠折叠与收纳,不靠删信息也不靠硬铺。** 区块标题可折叠且 localStorage 记住(usageFolded,page.js L448-482);卡内过 3 个 key 折"Show N more keys"、过 8 个账号折"Show N more accounts";图表序列 top-7 + Other。噪声多的地方都有收纳,且收纳状态可持久。
- **R5 空态=跟周期走的一句主文案+一句指路,整块替换。** `noCallsIn(period)`:"No calls in the last 7 days."/"No calls yet."(page.js L193-197),下面接 "Point an agent at a catalog model and use it; every call through the gateway is counted here."——告诉你这里数什么、怎么让它有数。空态直接替换 KPI 网格(L541-548),不是附在页脚。
- **R6 加载态=与最终布局同构的骨架屏。** 2 张 subscription-card 骨架 + 4 格 sk-number/sk-label KPI 骨架 + cost 骨架,期间周期按钮 disabled(renderUsageLoading,page.js L306-328)。绝不出现"—"占位(会被读成 0)。
- **R7 每个数字带口径与新鲜度,未知≠零。** 页脚 usage-note 11px:"Counted from the providers' own usage reports…";费用 ≈ 前缀 + "N calls unpriced"提示(总价永不伪装成全价);每张卡"Updated 3 min ago";cost 读不到显示空串不是 $0(fmtCost,app.js L15672-15680)。
- **R8 文案写给正在出问题的人。** 每个可疑惑处都有整句 tooltip 解释"为什么/怎么算的";计数区分单复数("{n} call"/"{n} calls");空态文案跟周期变;状态行(footer `#status`)是全局唯一的瞬时反馈位。

另两条工程侧规律顺带继承:数字格式 fmtN 的阈值化(K/M/B 或 万/亿,app.js L15652-15665);同数据不重绘(signature 比较的思想,loadQuotas L15596"an answer the same as the last isn't drawn again")——本页已实现,保留。

---

## 2. 信息架构总览

```
┌ 控制行(R1)──────────────────────────────────────────────────────────────┐
│ [用量|设置]  [今日|近 7 天|近 30 天|全部]  ·········  ● 同步 2 分钟前      │
├ 用量视图 ────────────────────────────────────────────────────────────────┤
│ ┌ 榜单卡(身份+排名+云端对比+榜单入口,唯一身份位)────────────────────┐   │
│ │ ● magpie-dev  p_4df04e…   │  #1 / 5 人 · 领先中 │ 云端今日 300.3M     │   │
│ │                           │  榜首 3 天          │ 与本地一致          │   │
│ └───────────────────────────┴─────────────────────┴────────────────────┘   │
│ ┌ KPI 4 格(R2):总量 | 缓存读取 | 请求 | 费用 ─────────────────────────┐   │
│ ┌ 趋势卡(R3):[Token|请求|费用] ··· 按 [来源|模型] ──────────────────┐   │
│ │  堆叠柱状图(按小时或按日)          │ 图例=排名(可点高亮)          │   │
│ └──────────────────────────────────────┴─────────────────────────────┘   │
│ ┌ 活跃热力图(53 周,保留)───────────────────────────────────────────┐   │
│ 页脚注:口径 + 本地生成(R7)                                              │
├ 设置视图(单列三卡)──────────────────────────────────────────────────────┤
│ 身份卡 → 配置卡 → 同步卡(动作与反馈同卡)                               │
└──────────────────────────────────────────────────────────────────────────┘
```

页面顺序即叙事顺序:**谁在赢(榜单)→ 赢了多少(KPI 总量)→ 怎么来的(趋势+排名)→ 长期习惯(热力图)**。砍掉的是"元信息前置":标题、口径注脚、独立同步行全部降级或并入内容。

---

## 3. 头部(控制行)规格

**结构(唯一一行,替换现 header+headbar+scope-note 三行):**

```html
<div class="usage-head">
  <div class="segs" id="views">…用量|设置…</div>          <!-- 现有,保留 -->
  <div class="segs small" id="periods">…今日|近7天|近30天|全部…</div> <!-- 上移合并 -->
  <span class="grow"></span>
  <button class="sync-chip" id="sync-chip" type="button">…</button>  <!-- 新,见 §9 -->
</div>
```

- 删除:`h1` 标题(R1:宿主侧栏已命名本页,pluginpages.js L88 `f.title = titled(p.entry)`;插件页内再放 16px 标题是重复)、`idchip`(昵称/短 ID/排名移入榜单卡)、头部"打开榜单"胶囊(移入榜单卡)、独立 `#since` 行(升级为 sync-chip)、`#scope-note` 顶部注脚(降为页脚注)。
- 周期 segs 只在用量视图显示(设置视图 `hidden`,沿用现逻辑)。
- **为什么**:现状头部 4 行、5 种字号、0 个数字,违反 R1;v2 只是把同样一堆东西重排,没有做减法。头部回归"控制行"后,正文第一屏第一个元素就是带身份的榜单卡,信息密度前移。
- CSS 关键值:`.usage-head { display:flex; align-items:center; gap:10px; min-height:34px; margin:0 0 10px; flex-wrap:wrap; }`(对齐 app.css L909 的形态)。

**sync-chip(右侧,两视图常驻,可点):**

- 内容 = 色点 + 短文案,11.5px,tabular-nums:`role="status" aria-live="polite"`。
- 状态:成功 `● 同步 2 分钟前`(绿点)/ `刚刚同步`;进行中 `● 同步中 3/10 批`(琥珀点,CSS 脉冲);失败 `● 同步失败`(红点,title=错误前 80 字);从未同步 `● 尚未同步`。
- 点击:切到设置视图并滚到同步卡。**为什么**:状态从"被看的正文"变成"可跳转的入口",失败时用户有下一跳;这是 R7(新鲜度常在)+ R8(状态行是全局反馈位)的合体。
- **明确禁止**:任何 toast 再写入这个 chip(见 §9 反馈规则)。

---

## 4. 榜单卡(新的第一内容块,也是全页唯一身份位)

**数据**:status.nickname / participantId / serverRank{rank, participantCount, leaderDays, isLeaderToday, cloudTodayTokens, fetchedAt, error} / apiBaseUrl / 本地今日总量(usage-data)。全部在既有边界内,只是把三个从未用过的字段(leaderDays/isLeaderToday/cloudTodayTokens)用起来——这是"产品能力不够强"最直接的补法:联赛产品的页面终于有联赛。

**结构(一张 card,桌面三栏,窄屏纵向堆叠):**

```
┌──────────────────────────────────────────────────────────────────────┐
│ ● magpie-dev  p_4df04e…   │  今日 #1 · 5 人中 · 领先中  │ 云端今日      │
│ (短 ID 仅 title)          │  榜首 3 天                │ 300.3M        │
│                           │                          │ 与本地一致     │
│                           │                          │ [打开榜单]    │
└──────────────────────────────────────────────────────────────────────┘
```

- 左栏:色点 + 昵称(16px/600,max-width 24ch 省略号,title 全名)。无昵称回退 `participantId.slice(0,8)` 粗体;短 ID 不再常显(title 里给全 ID)——v2 已经发现"短 ID 出现两次"的问题,这次直接不占版面。
- 中栏(主位,排名是英雄数字):`#1`(20px tabular-nums)+ ` · 5 人中`;`isLeaderToday` 时追加领先徽标(accent-soft 底、accent 字);`leaderDays ≥ 1` 时副行 `榜首 3 天`。**为什么放中间**:榜单卡的扫读动线是"名字 → 名次",名次是这张卡的最大数字,对齐 KPI 的 20px 数字级。
- 右栏:`云端今日` 标签(11px muted)+ `300.3M`(20px);对比行:`|本地今日−云端今日| < 1%本地` → `与本地一致`(muted),否则 `落后本地 2.1M · 待同步`(琥珀)。这一行把"云端 vs 本地"的同步健康度变成一句人话(R7:数字带口径),也是用户判断"榜是不是准"的依据。`[打开榜单]` 按钮放这栏底部(现 .btn 样式),整页唯一榜单入口。
- 卡头无标题(它不需要"云端排名"这种标签来自我解释),但 `role="group" aria-label="今日战况"`。

**降级矩阵(每格验收):**

| 场景 | 中栏 | 右栏 | 打开榜单 |
| --- | --- | --- | --- |
| 正常 | `#1 · 5 人中 · 领先中` / 副 `榜首 3 天` | `云端今日 300.3M` + 对比行 | 显示 |
| isLeaderToday=false | `#2 · 5 人中`(无徽标) | 同上 | 显示 |
| rank 从未取到 | `未上榜`(title:尚未同步到云端) | 隐藏整栏 | 显示(有 apiBaseUrl 即显示) |
| rank 曾成功后失败 | 上次名次 + title `云端暂不可达,显示 2 小时前的结果` | 上次值 + `· 2 小时前的结果` | 显示 |
| fetchedAt > 24h | 正常文字灰显(.stale) | 正常值灰显 | 显示 |
| 同步进行中 | 不变 | 对比行换 `同步中 3/10 批` | 不变 |
| apiBaseUrl 未配置 | **整卡隐藏**——用量视图直接以 KPI 开头;不摆空壳 | — | — |

- **为什么整卡隐藏而不是摆"未接入"**:R5 的空态哲学是"没有数据的位置不渲染壳"。未配置榜单时这页仍是完整的本地用量页,身份信息去设置页看。

---

## 5. KPI 规格(8 格 → 4 格)

**删除**:输入、输出、缓存(合计)、失败、缓存命中率 五个独立格。**保留/新建**:

| # | 格 | 主数字 | 副行(parts,span 整体不折断,R2/usageParts) | title |
| --- | --- | --- | --- | --- |
| 1 | 总量 tokens | `fmtN(total)` | `输入 54.2M · 输出 6.6M · 缓存 2.3B` | 排名口径:totalTokens = 输入+输出+缓存读+缓存写 |
| 2 | 缓存读取 | `fmtN(cacheRead)` | `命中 97%`(命中率=cacheRead÷(cacheRead+input+cacheWrite),提示词口径) | title 给公式整句 + `写 X` |
| 3 | 请求 | `fmtN(calls)` | 失败>0 → `失败 74`(红,`.err` 色);否则 `全部成功` | 失败含义:本口径下请求未成功返回 |
| 4 | 费用 | `fmtCost`:≥100→`$642`,≥1→`$12.50`,<1→`$0.376`;空数据→空串 | `按牌价估算` | 费用是展示项,不参与排名 |

- 顺序理由:格 1 是联赛真值(也是榜单卡"云端今日"的本地对账数);格 2、3 解释"账单为什么这么大/服务健不健康";格 4 明示是估算展示(产品红线:cost 不参与排名)。
- 数字规则:沿用 fmtN 阈值化 compact;**费用换掉 `$ + compact` 的拼接**(现状 `$642.5`),改 fmtCost 三段规则;命中率从"cacheRead÷total"改为提示词口径并写进 title(R7:口径可查)。
- 容器:现有 `.stats` 单容器 1px 缝形态已对齐 Magpie(L95-101),保留,只是从 8 格变 4 格、一行放下(≤640px 折 2×2,现有媒体查询保留)。
- 副行百分比全部删除:输入 2%/输出 0%/缓存 97% 这类"对总量的占比"要么恒凑 100% 要么与命中率语义打架,是纯噪声。

---

## 6. 趋势卡(图 + 排名,一个 widget)

**卡头**(替换现 c-head 的三件套+文字标签):

```html
<div class="c-head">
  <b data-t="trend">趋势</b>
  <div class="segs small" id="metric">Token|请求|费用</div>
  <span class="grow"></span>
  <span class="led-by" data-t="splitBy">按</span>
  <div class="segs small" id="splitby">来源|模型</div>
  <span class="grain" id="grain">按日</span>   <!-- 11px muted,跟 range 走 -->
</div>
```

- **删除"拆分维度"文字标签**,改 Magpie 原样式的 `Split by`(中文一个"按"字)+ segs(page.js L1616 的 `led-by` 语言)。卡头里不再出现第三个控制件。
- **粒度标注 `#grain`**:今日 → `按小时 · 来源`(此时 split segs `hidden`,见下);7d/30d/all → `按日`。这是把 R7(口径常在)用在这张卡上,也顺带修掉"今日×模型画单柱"的坏状态。
- **维度与去重(用户点名的重复问题,方案就一条:R3)**:拆分是这张图的属性。右侧 rank 面板随 split 切换显示 来源排名 或 模型排名——它就是全页唯一的拆分维度呈现。**"模型 Top 5"卡删除**(见 §11)。现状"split=model 时图例显示模型、下方模型卡再显示一次 Top5"的双份渲染不存在了。
- **rank 行规格(现 .rk 保留,增强一点)**:色点 + 名称 + 当前指标值 + 4px 占比条 + `3.0K 次 · 93%`。点击行为:toggle 高亮该序列(图中其它序列降不透明度 0.25,再点恢复)。**为什么**:Magpie 的 rank 行可点并过滤列表;我们没有请求列表,最小同构映射就是"点行=聚焦图中序列",让 rank 从只读图例变成过滤器(R3 的精神)。
- 图表本体(现 renderChart)保留:测量先行的 SVG、y 轴友好步长、hover 高亮带 + tooltip、top-7+Other 折叠(R4)。指标为费用时 y 轴与 tooltip 走 fmtCost。
- 空数据天不计入序列;`全部`(217 天)横轴标签按现有 every 抽稀逻辑,保留。

---

## 7. 热力图与页脚注

- 热力图卡整体保留(53 周、5 级、月/周标注、tooltip 都是 Magpie 同构实现,已是本页最成熟的部件)。卡头副文案保留 `最近 53 周 · 按日 tokens`。
- **页脚注(新,替代顶部 #scope-note)**:`口径:Magpie 统一读数(网关 + 本地会话)· 本页数据本地生成`。11px faint,页面最末(R7:口径是脚注不是头条;Magpie 的 usageScope/usageNote 都是 note 级)。

---

## 8. 设置视图规格(单列三卡)

删除 `setgrid` 2fr/3fr 双列(面板常态 480–900px 宽,双列把表单挤成窄条)。单列顺序 = **身份 → 配置 → 同步**:两张"写"卡在前,状态卡最后——"立即同步"点了以后,反馈行就在按钮旁边更新,不需要滚动找状态。

**① 身份卡**

- 卡头:`身份` + 来源 chip(`本机存储/迁移文件导入/继承 ATL/全新创建/已改名`,现 fromMap 保留)。
- 主值:昵称 16px(现 .vv.big)。行:participantId(mono,可点复制)、设备 ID(mono)。
- 动作:`导入 ATL 配置`、`导出配置`(等权两颗)。导入是 ATL 真实身份(如 Sky Huang)进来的唯一通道,保持现有文件选择 + 形状校验逻辑不动。
- hint:`导入 atl export-magpie-config 导出的 JSON;导出同格式,可导入其他 Magpie 或 ATL。`(现文案保留)。

**② 配置卡(表单值=生效值)**

- 字段与现有一致:服务端地址、昵称、起始日期、两个开关(包含 magpie_local / 启用自动同步)。
- **硬规则(已实现,写死不许回退)**:表单初值 = `options.get()` 合并 `status.apiBaseUrl` 的**生效值**,绝不预填营销默认值;用户开始输入后(dirty latch)轮询不再覆盖。理由 app.js L216-225 注释已写透:一次"保存"不能静默把同步指到另一台服务器。
- 动作:`保存配置`(primary)、`测试连接`(测试的是服务端地址,按钮跟着字段走)。
- hint:隐私句保留(`仅上报 token 数与模型名…`)。

**③ 同步卡(状态+动作同卡)**

- 行:`上次结果`(ok 绿/err 红+完整错误,同步中显示 `3/10 批`)、`数据源`(csv/api/ledger 现映射保留)、`同步统计`(`累计 2217 桶 · 首次同步 2026-11-01`)、`服务端`(mono)。
- 动作:`立即同步`(primary;进行中 → disabled + 文案 `同步中…`)。
- **删除本卡的"云端排名"行与"打开榜单"按钮**:榜单归用量页的榜单卡管,设置页不二次转述(R3 的跨页版本:同一信息只有一个家)。
- **Ed25519 hint 从可见 UI 删除**,移作 `立即同步` 按钮 title(`Ed25519 签名小时桶,服务端整桶覆盖幂等`)——它是给懂数字签名的人的安心话,不是给扫读的。

---

## 9. 四种状态 + 反馈规则

**空态(usage-data 无任何数据)**

- KPI 网格位置替换为单块居中文案(R5,`.stats.empty` 形态):
  - 主:`还没有用量数据`(跟周期变的变体:今日 → `今天还没有用量`;全部 → `还没有用量数据`)
  - 副:`在 Magpie 里用任意模型对话,统计会自动出现在这里;数据每几秒自动刷新。`
  - 动作:`[去设置]`(切到设置视图——确认自动同步已开)。
- 趋势卡、热力图卡整卡 `hidden`;榜单卡按 §4 矩阵独立判断(可能有榜无用量)。
- **禁止**:8 格"—"、空图表壳、页底孤零零一行"暂无数据"。

**加载态(首个 usage-data.js 落地前)**

- 榜单卡:sk-title + sk-line 骨架;KPI:4 格 sk-number+sk-label;趋势卡:sk-line 高 236px。周期 segs disabled(R6)。
- 首数据到达后骨架一次性替换;之后的轮询刷新走现有 signature-skip(不动已渲染内容,hover 状态存活)。
- **禁止**:"—"占位数字(会被读成 0)。

**同步中**

- sync-chip 琥珀点 + `同步中 3/10 批`(4s 轮询自然推进);`立即同步` disabled + `同步中…`;榜单卡对比行换 `同步中…`。页面其余内容照常可读可切,不全页遮罩。

**失败态**

- sync-chip 红点 + `同步失败`(title=错误前 80 字,点击跳同步卡);同步卡"上次结果"红字完整错误;用量页保留**最后一次成功数据**不清空,页脚注追加 `· 显示上次成功数据`。榜单 rank 按 §4 的"曾成功后失败"行降级,不影响本地展示(R7:本地链路与云端链路互不拖累)。

**反馈通道(toast,新增,替换 since 行复用)**

- 新增右下角临时 toast(`.toast`,`position:fixed; right:16px; bottom:16px`,4s 自动消失,同一时刻只保留一条):`已保存`/`命令已发送,稍后更新`/`配置已提交,下次同步采用该身份`/`这不是有效的 ATL 导出文件`/`文件读取失败`/`导出命令已发送,稍后在 Downloads 查看`。
- `#since` 行物理删除,其语义已由 sync-chip + 同步卡承接。

---

## 10. 文案表(zh / en,全量;`{x}` 为运行时替换)

**头部**

| key | zh | en |
| --- | --- | --- |
| usage | 用量 | Usage |
| settings | 设置 | Settings |
| today / d7 / d30 / all | 今日 / 近 7 天 / 近 30 天 / 全部 | Today / 7 days / 30 days / All |
| chipSynced | 同步 {time} | Synced {time} |
| chipJustNow | 刚刚同步 | Synced just now |
| chipSyncing | 同步中 {done}/{total} 批 | Syncing {done}/{total} |
| chipFailed | 同步失败 | Sync failed |
| chipNever | 尚未同步 | Never synced |

**榜单卡**

| key | zh | en |
| --- | --- | --- |
| boardLabel(aria) | 今日战况 | Today on the board |
| rankToday | #{rank} · {count} 人中 | #{rank} of {count} |
| leading | 领先中 | in the lead |
| leaderDays | 榜首 {n} 天 | {n} {n days at #1 → "1 day at #1"/"{n} days at #1"} |
| cloudToday | 云端今日 | Cloud today |
| cloudMatch | 与本地一致 | matches local |
| cloudBehind | 落后本地 {tokens} · 待同步 | {tokens} behind local · pending |
| syncingShort | 同步中… | syncing… |
| rankNone | 未上榜 | not ranked yet |
| rankNeverTip | 尚未同步到云端 | not synced to the board yet |
| rankStaleTip | 云端暂不可达,显示 {time} 的结果 | board unreachable — showing result from {time} |
| openBoard | 打开榜单 | Open board |

**KPI**

| key | zh | en |
| --- | --- | --- |
| kTotal | 总量 | Total tokens |
| kTotalSub | 输入 {a} · 输出 {b} · 缓存 {c} | {a} in · {b} out · {c} cache |
| kTotalTip | 排名口径:总量 = 输入 + 输出 + 缓存读 + 缓存写 | Board metric: input + output + cache read + cache write |
| kCache | 缓存读取 | Cache read |
| kCacheSub | 命中 {p} | hit rate {p} |
| kCacheTip | 命中率 = 缓存读取 ÷(缓存读取 + 输入 + 缓存写入),即提示词中来自缓存的部分。缓存写入 {n} | Hit rate = cache read ÷ (cache read + input + cache write): the share of the prompt served from cache. Cache written {n} |
| kRequests | 请求 | Requests |
| kReqOk | 全部成功 | none failed |
| kReqFail | 失败 {n} | {n} failed |
| kCost | 费用 | Cost |
| kCostSub | 按牌价估算 | at list prices |
| kCostTip | 费用为展示估算,不参与排名 | Cost is an estimate for display; it does not affect ranking |

**趋势卡**

| key | zh | en |
| --- | --- | --- |
| trend | 趋势 | Trend |
| mTokens / mCalls / mCost | Token / 请求 / 费用 | Tokens / Requests / Cost |
| splitBy | 按 | by |
| splitSource / splitModel | 来源 / 模型 | Source / Model |
| grainHour | 按小时 · 来源 | hourly · by source |
| grainDay | 按日 | daily |
| other | 其他 | Other |
| legendSub | {calls} 次 · {pct} | {calls} calls · {pct} |

**热力图/页脚/空态**

| key | zh | en |
| --- | --- | --- |
| heatTitle | 活跃热力图 | Activity heatmap |
| heatSub | 最近 53 周 · 按日 tokens | last 53 weeks · daily tokens |
| less / more | 少 / 多 | Less / More |
| scopeNote | 口径:Magpie 统一读数(网关 + 本地会话)· 本页数据本地生成 | Scope: Magpie's unified readings (gateway + local sessions) · computed locally |
| scopeStale | · 显示上次成功数据 | · showing last successful data |
| emptyToday | 今天还没有用量 | No usage today yet |
| emptyAll | 还没有用量数据 | No usage yet |
| emptyBody | 在 Magpie 里用任意模型对话,统计会自动出现在这里 | Use any model through Magpie and your usage appears here |
| emptyCta | 去设置 | Open settings |

**设置**

| key | zh | en |
| --- | --- | --- |
| identity | 身份 | Identity |
| cfgTitle | 配置 | Configuration |
| syncTitle | 同步 | Sync |
| cfgApi | 服务端地址 | API base URL |
| cfgNick | 昵称 | Nickname |
| cfgNickHint | 已注册身份改名,下次同步生效 | renames apply on the next sync |
| cfgSince | 起始日期 | Start date |
| cfgSinceHint | 留空 = 同步全部历史 | empty = full history |
| cfgMagpieLocal | 包含 Magpie 自身 / 未识别客户端 | Include Magpie's own & unknown clients |
| cfgEnabled | 启用自动同步 | Enable auto sync |
| save / saved | 保存配置 / 已保存 | Save / Saved |
| test | 测试连接 | Test connection |
| importBtn / exportBtn | 导入 ATL 配置 / 导出配置 | Import ATL config / Export config |
| importHint | 导入 atl export-magpie-config 导出的 JSON;导出同格式,可导入其他 Magpie 或 ATL。 | Import the JSON from atl export-magpie-config; the export uses the same shape. |
| privacyHint | 隐私:仅上报 token 数与模型名,账号、会话、响应 ID 不离开本机。 | Privacy: only token counts and model names leave this machine. |
| syncNow / syncNowBusy | 立即同步 / 同步中… | Sync now / Syncing… |
| syncNowTip | Ed25519 签名小时桶,服务端整桶覆盖幂等 | Ed25519-signed hourly buckets, idempotent replace on the server |
| lastResult / dataSource / syncStats / server | 上次结果 / 数据源 / 同步统计 / 服务端 | Last run / Data source / Sync stats / Server |
| uploadedSummary | 上传 {buckets} 桶 / {tokens} tokens | uploaded {buckets} buckets / {tokens} tokens |
| noopSummary | 已最新({buckets} 桶) | up to date ({buckets} buckets) |
| firstSync | 首次同步 {date} | first sync {date} |
| idSourceStore/… | 本机存储 / 迁移文件导入 / 继承 ATL 客户端 / 全新创建 / 本机存储(已改名) | local store / migration file / adopted from ATL client / freshly created / local store (renamed) |
| sourceCsv/Api/Ledger | 网关 CSV(全史)/ 网关 API(7 天窗口)/ 账本文件(仅网关口径) | Gateway CSV (full history) / Gateway API (7-day window) / Ledger file (gateway only) |
| justNow/relMin/relHour/relDay | 刚刚 / {n} 分钟前 / {n} 小时前 / {n} 天前 | just now / {n} min ago / {n} h ago / {n} d ago |

**toast**

| key | zh | en |
| --- | --- | --- |
| toastCmdSent | 命令已发送,稍后状态更新 | Command sent — status updates shortly |
| toastImportQueued | 配置已提交,下次同步采用该身份 | Config submitted — the next sync adopts this identity |
| toastImportBadFile | 这不是有效的 ATL 导出文件 | Not a valid ATL export file |
| toastImportReadFail | 文件读取失败 | Could not read the file |
| toastExportQueued | 导出命令已发送,稍后在 Downloads 查看 | Export command sent — check Downloads shortly |
| noMagpie | 此页面需在 Magpie 插件面板中打开 | Open this page inside the Magpie plugin panel |

单复数规则(R8):en 的 calls/days 按 1/{n} 分形;zh 不变。

---

## 11. 砍掉什么(直接删,不给去处)

| # | 砍 | 理由 |
| --- | --- | --- |
| 1 | 8 格 KPI 中的 5 格(输入/输出/缓存/失败/命中率独立格) | R2:4 格各一个论点;副行给推导。数字墙无主次,总量被稀释。 |
| 2 | 头部 `h1` 标题 | R1:宿主侧栏已命名本页;面板内 16px 标题是纯重复。 |
| 3 | 头部 idchip(昵称+短 ID+排名)与"打开榜单"胶囊 | 身份与排名是内容不是 chrome;唯一身份位=榜单卡。 |
| 4 | `#since` 同步行 + toast 复用它 | 升级为 sync-chip;命令反馈走右下 toast,两个语义不共 channel。 |
| 5 | 顶部口径注脚 `#scope-note` | R7:口径是页脚注,不是头条。 |
| 6 | "模型 Top 5"卡 | 用户点名的重复:split=model 时与趋势图例完全同数据;rank 面板即排名(R3)。 |
| 7 | 趋势卡头"拆分维度"文字标签 | segs 自说明 + Magpie 的 `按/by` 微标形态。 |
| 8 | today×model 的单柱图路径(view.js L474-484) | 数据边界内没有"按模型的小时序列";今日固定 按小时·按来源,split segs 隐藏,`#grain` 说明粒度。 |
| 9 | 设置页"云端排名"行、"打开榜单"按钮 | 榜单卡唯一所有;设置页不转述。 |
| 10 | 同步卡可见的 Ed25519 hint | 开发者语言;降为 syncNow 的 title。 |
| 11 | KPI 副行的占比百分比(输入 2%/输出 0%/缓存 97%) | 恒凑 100% 或语义打架,纯噪声。 |
| 12 | 设置页 2fr/3fr 双列布局 | 面板窄宽下表单被挤;单列三卡,动作与反馈同卡。 |

---

## 12. 实施与验收清单

**涉及文件**:`page/index.html`(头部/榜单卡/KPI/趋势卡头/设置三卡/toast 容器)、`page/style.css`(usage-head/sync-chip/board card/skeleton/toast;删 idrow、duo、setgrid、#i-board、.since)、`page/view.js`(fmtCost、命中率口径、榜单卡渲染、rank 行点击高亮、骨架渲染、grain、空态整块)、`page/app.js`(T dict 按本文案表重写、sync-chip 状态机、toast、设置卡动作、split segs 随 range 显隐)。bridge 轮询、signature-skip、options 读写、导入校验逻辑全部不动。

**验收(逐条过)**

1. 1080px 宽:控制行 1 行;首屏包含 榜单卡 + KPI 4 格 + 趋势卡顶部(截图比对)。
2. 榜单卡 7 个降级场景逐格对照 §4 矩阵(用 status.js 手工改值注入验证)。
3. KPI:总量副行 parts 换行时每个 span 完整;费用 $642 / $12.50 / $0.376 三档;无费用数据时费用格主数字为空串。
4. 趋势:split 切换后 rank 面板与图表同源同序;rank 行点击后图中其它序列降不透明度;今日视图无 split segs 且 `#grain`=按小时 · 来源。
5. 空态/加载态/同步中/失败态四态截图;空态无"—"、无空卡壳。
6. toast:保存/测试/导入坏文件各触发一次,4s 消失,sync-chip 不被改写。
7. zh/en 全量文案过一遍(data-t 全命中);窄宽 480px:控制行可换行不横滚,榜单卡纵向堆叠。
8. `node --check page/app.js page/view.js`;现有 test/ 目录中涉及页面的用例同步更新后全绿。

---

### 附:证据与未验证项

- 依据:Magpie 源码通读(app.js / app.css / plugins/usage/*,文内行号可查);插件页四文件通读;实机 Playwright 截图 8 张 + DOM 实测(`/tmp/product-teardown/01-usage-7d-full.png` … `06-usage-narrow.png`)。
- 本稿为设计规格,未实施、未改任何仓库文件(严格只读);实施后的四态截图与降级矩阵验收属于下一步。

---

## v3.1 变更（用户拍板，2026-11-01 下午）

- **删除设置项**：`包含 Magpie 自身 / 未识别客户端`、`启用自动同步`——插件的存在目的就是同步，不做开关（Bun 侧选项保留，页面不再暴露）。
- **新增 `同步频率`**：5/15/30/60 分钟 segs，**即时生效**（不走保存按钮）；写入 `syncIntervalMinutes`，hooks 侧 60 秒粒度检查、到间隔才触发补同步；网关请求触发的即时同步（≥1 分钟节流）不变。文案与说明全部走 tooltip。
- **UI copy strict 规则**落地：页面零说明文（导入格式/隐私/口径/空态指引全部迁 tooltip）、按钮最短化（导入/导出/保存）、去括号注、费用 `≈$650` 带估算前缀。

---

## v3.2 变更（用户拍板，2026-11-01 傍晚）

- **榜单卡 → 单行状态条**：`● Sky Huang · #1 of 5 [领先] 榜首 3 天 · 云端今日 300.3M 与本地一致 · [打开榜单]`——不再是三栏仪式感大卡（20px 大数字在 1 人榜上尤其空洞）；完整 ID 进 title。
- **设置页去空旷**：身份卡压缩为一行（名字+来源 chip+截断 ID+导入/导出）；配置卡与同步卡**双列并排**（≤760px 回落单列），整页高度约减半。

- **v3.3 注记（2026-11-01 晚）**：ATL 侧专用导出通道（CLI+按钮）已整体移除——插件直接消费 ATL 通用「导出配置」；`importHint` 等文案已同步改口，规格表中旧命令名仅作历史记录。
