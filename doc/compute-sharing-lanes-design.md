# 算力共享车道(Sharing Lanes)设计

状态:**P0/P1/P2 已实现并真机验证(2026-09-15)**;OSS compute-sharing@0.5.0。
**R46 架构还债(2026-09-15)**:全部特权命令(claim-sign / borrow-get/set / owner-status|policy|unregister|resume|suggest)从 sidecar 平台命令(protocol 枚举)迁入 first-party 插件 crate `plugins/compute-sharing/rust`(atl-plugin-sharing,组合根一行注册)——sidecar 与 collector-core 协议层回到零业务字面量(R26 标准还清);命令名与权限串整体改 `compute-sharing:` 命名空间(未大规模上线,无兼容层);owner-suggest 经 crate 依赖复用 atl-plugin-zhipu 的配额查询(同一 60s 缓存)。
上游架构与轮次记录见 `compute-sharing-handoff.md`(R23 起);本文只写车道扩展的设计基线。

> 实现期修正(重要):设计时假设 CPA intercept payload 无 model 字段——**实测 7.2.147 已带**
> (`Model` + `Metadata.requested_model`,经文件门控 payload 转储探针证实)。硬模型隔离已实现:
> 车道 key 请求族外模型 → 429 `model_not_in_lane`(真机双向验证:gemini 车道 key 打 gpt 429、
> codex 车道 key 打 gemini 429、codex 车道 key 打 gpt-5.6 完整 200 链路)。极老宿主无该字段时
> 优雅降级为引导性 scoping(时段/预算门仍硬执行)。

## 1. 背景与实地勘察(2026-09-14)

现有策略模型是一条平铺 policy:`budget`(本地日窗)+ `maxClaims` + `keyMaxTokens` + `keyConcurrency` + `ttlHours`,`models:["*"]` 仅作展示、无任何执行。它表达不了多订阅的异质额度语义。

本机实测画像(数据源:CPA `usage.db`(sqlite)、本地 MySQL `usage_hourly`、sidecar 配额直测):

| 订阅 | 接入方式 | 实测用量 | 额度特征 |
|---|---|---|---|
| Gemini(antigravity 凭据) | CPA 上游 | 11 天 20.7 亿 tokens(几乎全为 `gemini-3.8-flash-high`),周耗折算 ~13 亿;86% 集中在 15:00–21:59;最重日撞 6 次 429 | **周限制存在,天花板数值未知** |
| 智谱 GLM Coding Plan(lite+pro 两把 key) | 不经 CPA,插件自管,编码工具直连 | 近 14 天日均 3.3~12.7 亿,几乎全时段在用,最闲 02–06 时;当前 5h 窗 lite 17% / pro 40% | 无周限制;5h 滚动窗;下午高峰计费 |
| codex(OpenAI 凭据) | CPA 上游 | 零消耗 | 纯闲置 |

## 2. 目标

1. 一份分享内表达多个订阅切片,各自:预算周期(day / week / 5h 滚动)、开放时段、模型范围、名额。
2. 云端仍是唯一真相(策略、账本、目录状态);CPA 插件在心跳间隔内 fail-closed 执行门控。
3. 旧 share 平铺 policy 无损迁移,老借用方无感。

非目标:v1 不做硬模型隔离(见 §4 ABI 约束)、不做按借用方差异化定价、不改身份/签名/秘钥架构。

## 3. 模型:车道(lane)

```
share (Sky-Macbook CPA)
 ├─ 车道 gemini-week    模型 gemini-*        预算 {周期:week, 1.5亿}     时段 22:00–14:00
 ├─ 车道 glm-offpeak    模型 glm-5.3-flash   预算 {周期:5h滚动, 2000万}   时段 22:00–12:00
 └─ 车道 codex-free     模型 gpt-*           预算 {周期:day, 5000万}      时段 全天
```

### 3.1 lane 结构(policy 扩展)

```jsonc
{
  "lanes": [
    {
      "id": "gemini-week",
      "title": "Gemini 周额度",
      "models": ["gemini-*"],            // v1 引导性:目录/认领回执明示,不硬拦截
      "budget": { "tokens": 150000000 },
      "period": "week",          // 顶层字段(实现形态);week|day|hour5
      "schedule": { "windows": [{ "start": "22:00", "end": "14:00" }] }, // 空=全天;owner 本地时区;支持跨午夜
      "maxClaims": 3,                     // 车道级名额(缺省继承 share 级)
      "peak": { "windows": [...], "multiplier": 2 }  // 预留:v1 只硬关闭,倍率 P1 实现
    }
  ]
}
```

- `week` 锚点 = 周一 00:00 本地时(留 `resetAnchor` 字段对齐真实账期)。
- `hour5` = 固定网格滚动窗 `floor(now/5h)`;真实 5h 窗由智谱 API 自身 429 兜底,我方账本保守近似即可。
- share 级旧五字段保留为「默认值/上限」语义:车道缺省继承;旧 share 无 `lanes` 时迁移为一个隐式默认车道(period=day、全天、原 budget)。

### 3.2 认领改为按车道(承重决策)

**laneId 绑定在认领 Key 上**:目录认领入参 `shareId + laneId`,签发的临时 Key(`atl:<keyId>`)携带车道归属,心跳下发的 keys 列表每项带 `laneId`。

理由(ABI 硬约束):CPA 插件 `intercept_before` 只收到 `RequestID + Metadata.caller_scope`,**没有请求 model**(7.2.157 实测定型)。因此:

- 请求时门控走 key→lane:**时段外 → 429 + retry-after(至下个开放时刻)**;车道周期预算尽 → 429;单 Key 上限/并发照旧。无需 model 即可硬执行。
- `models` 在 v1 是引导而非硬隔离:借用方是联赛实名成员,v1 信任模型 = 实名 + 可吊销 + 可追账。硬隔离列为上游 ABI 升级项(model 进拦截点后插件加一行判定收口)。
- 车道间预算天然隔离:借 glm 的人烧不穿 Gemini 周额度。
- 借用方要多个模型族就认领多条车道(各有名额与 Key)。

### 3.3 执行层分工(沿用 R23 架构)

- **后端(`sharing-cpa.js`)**:lane policy 存储/校验(clamp 各字段);按 lane×窗口记账(`settled` 键从 keyId 维度扩为 lane 维度);claim 校验车道状态(开放时段外/预算尽/名额满 → 409 带原因与 retryAfter);目录/owner status 输出车道实时状态(「⏸ 暂停至 22:00」「本周剩余 1.2 亿」);heartbeat 响应下发 `lanes` + keys(带 laneId)。
- **CPA 插件(`cpa-plugin/`)**:本地 fail-closed 车道门(时段/周期预算/429 retry-after);账本从 `settled_by_key` 扩展 lane 滚动窗算术(week/hour5);心跳间隔内无更新策略时按最后快照执行;未知 lane / 无 lanes 回退默认车道(deny-safe:非 active 一律拒)。
- **sidcar/插件卡**:owner 控制台车道编辑(预算/时段/启停);借用面车道 chips + 按车道认领。

## 4. 智谱接入 CPA(已验证,纯配置)

CPA 7.2.147 原生支持自定义上游,两条路径:

- **路径 A(推荐):`claude-api-key` + base-url** —— 智谱 Anthropic 兼容端点。已实测(2026-09-14,真实 key,flash 8 token):`POST https://open.bigmodel.cn/api/anthropic/v1/messages`,`x-api-key` 认证,`glm-5.3` / `glm-5.3-flash` 均 200。Claude Code 类借用客户端原生兼容,与 GLM Coding Plan 的设计用法一致。

```yaml
claude-api-key:
  - api-key: "<智谱 key A>"
    base-url: "https://open.bigmodel.cn/api/anthropic"
  - api-key: "<智谱 key B>"
    base-url: "https://open.bigmodel.cn/api/anthropic"
```

- 路径 B(备选):`openai-compatibility` 对接 GLM Coding Plan OpenAI 兼容端点(官方示例本身就有 glm 写法)。

注意:接入后 CPA 模型列表新增 glm 系列;借用方 Key 按 lane 引导使用 `glm-5.3-flash`;自用工具可继续直连,不必切到 CPA。**修改生产 CPA config 前先备份**(惯例 `.bak-atl-<date>`),改后热重载或重启 core 验证 `/v1/models`。

## 5. 已拍板决策(2026-09-14)

1. **Gemini 周额度天花板未知** → 不依赖已知额度:初值保守(建议 1.5 亿/周 ≈ 自用周耗 12%),配 **撞墙信号**(as-built:插件在 usage.handle 摄取 owner 侧失败计数 → 心跳 `wallSignals` 上报 → 后端记录 → 卡上 ⚠️ 横幅,明示"仅提示不自动动作"+ 一键暂停车道;**不做自动暂停**——owner 自用流量不绑车道,信号无法归属到具体车道,自动暂停只会整卡误伤);卡片展示自用周耗趋势辅助调领(sharing:owner-suggest 从 CPA usage.db 读取)。逆向 antigravity 用量面板 API 见 §9 研究记录。
2. **智谱接入 CPA**:路径 A,配置片段见 §4,已实测链路通。
3. **codex 可出借**:codex-free 车道,全天,日预算初值 5000 万(零自用纯闲置)。
4. **高峰时段**:v1 硬关闭(简单、可预期),schema 预留 `peak.multiplier`,P1 实现倍率计费(高峰时段不禁,用量按倍率折算车道预算)。

## 6. UX(文字原型)

owner 控制台新增「分享资源」区:

```
分享资源
┌──────────────────────────────────────────────┐
│ 🟢 gemini-week   gemini-*     每周 [1.5亿]   │
│    22:00–14:00   本周剩余 1.2亿 ▓▓▓▓░░ 80%  │
│                                   [编辑] [停]│
├──────────────────────────────────────────────┤
│ 🟡 glm-offpeak   glm-5.3-flash  5h [2000万]  │
│    22:00–12:00   暂停至 22:00                │
└──────────────────────────────────────────────┘
[+ 按模板添加: ○ Gemini 周限版 ○ 智谱避峰版 ○ 全天小流量]
```

借用面目录卡片:车道 chips(模型 × 周期 × 时段 × 余量),按车道认领;认领回执的 env 配置带该车道建议 model。

## 7. 兼容与迁移

- 旧 share(平铺 policy)→ 读时惰性迁移为一个隐式默认车道(day、全天、原 budget、原 maxClaims),不重写存储。
- 心跳响应新增 `lanes`;旧插件忽略新字段(超集兼容),新插件见不到 `lanes` 时回退默认车道。
- claim API:`shareId` 不带 `laneId` 时,后端只在「仅存在一个车道」的 share 上接受(老借用客户端平滑期);多车道 share 必须带 laneId,409 响应列出道次。

## 8. 切片与验证矩阵

- **P0**:policy schema + 按车道认领 + 后端车道账本/目录状态 + 心跳下发 lanes + CPA 插件车道门(时段/周期预算/429 retry-after)+ 卡片车道编辑 + 惰性迁移。
- **P1**:车道模板;目录车道徽标;额度建议(智谱吃 zhipu-plan:usage 5h 余量、Gemini 吃 CPA usage.db 周耗);撞墙自愈(wallSignal);高峰倍率。
- **P2**:model 进拦截点后的硬模型隔离;按车道吊销;429 原因/retryAfter 透传借用方;antigravity 用量面板 API 逆向。

验证矩阵(对应 AGENTS 新特性质量门):

| 面 | 验证 |
|---|---|
| 逻辑 | 窗口算术(week 锚点/hour5 网格/跨午夜/时区与 DST)单测;时段真值表;clamp 边界;惰性迁移回归;claim 409 原因分类 |
| 插件 | Rust 单测:车道门(时段外拒/retry-after 值/预算尽/未知 lane deny-safe/无 lanes 回退)——一并补 R30 遗留的 sidecar Rust 单测 |
| 交互 | e2e:车道编辑/按车道认领/车道状态徽标/停止与恢复(含 R41 流程)/双语 |
| 边界 | 真 CPA 冒烟:配置 §4 片段后 glm 车道端到端(认领→请求 200→5h 窗尽 429→时段外 429 retry-after);gemini 车道周窗滚动 |
| 性能 | 心跳包尺寸与车道数上限(clamp ≤8 车道);目录聚合不新增 N+1 |

## 9. 开放项

- ~~CPA 上游 model 字段~~ **已证实并实现硬隔离**(见文首修正)。
- ~~智谱两把 key「一把自用一把出借」~~:车道模板已可表达;key 级隔离待智谱接入 CPA 后按需加模板。
- 倍率计费已实现(结算侧双端一致);借用方侧的"高峰提示文案"可再打磨。
- **antigravity 用量面板 API 逆向(P2 有界研究记录,2026-09-15)**:CPA 二进制 strings 证实
  API 基址 `cloudcode-pa.googleapis.com` / `daily-cloudcode-pa.googleapis.com`,路径前缀
  `/v1internal:`(generateContent 即 `daily-cloudcode-pa.googleapis.com/v1internal:generateContent`);
  OAuth access_token 探针时已过期(需 CPA 刷新后取新 token),端点形状未定。**实用需求已由
  撞墙信号覆盖**(usage.handle 摄取 owner 侧失败 → 心跳 wallSignals → 卡上 ⚠️ 横幅),逆向
  列为后续可选增强(拿到精确剩余额度用于自动调预算)。
- 存储注意:车道字段(`lanes/laneSettled/wallSignal`/claims.`laneId`)需要 MySQL 列
  (`lanesJson`/`laneSettledJson`/`wallSignalJson`/`laneId`),ensureMysqlSchema 已带守卫 ALTER,
  老部署自动升级;往返测试钉住(npm test opt-in MySQL 用例)。
- **UX 迭代遗留处理(0.3.0,2026-09-15 第二轮迭代)**:①B10 时区语义**已修**——owner 时区
  为权威锚(CPA 插件心跳上报 `tzOffsetMinutes`,DST 随心跳刷新;后端 schedule/day/week 窗口
  与目录状态全部按该锚计算,缺省回退服务器本地;MySQL 列白名单不落库,JSON 存储会随 share
  对象持久化上次心跳值——重启保留、下个心跳刷新,已知且可接受),借用面/认领回执带 `tzLabel`
  (如 UTC+8)。已知窗口:owner 跨时区移动/DST 切换时,后端判定与插件本地门控在下一次心跳前
  可能短暂不一致(≤心跳间隔);峰值倍率在结算侧按心跳到达时刻采样(增量未携带逐请求时间
  戳),与插件本地逐请求判定存在有界小差,已知近似;②B11 **已修**——复制按钮复制整行 `export NAME=value`;③B8 **已修**——计划内
  关闭统一为「未开放 · HH:MM」/「Closed ·」,手动暂停独占「已暂停」;④B12 **已修**——车道行
  显示「高峰×N HH:MM–HH:MM」chip;⑤C1 空白模板/C2 重名拦截/C3 建议依据(≈自用 25%)/C5 Key
  遮罩+显示切换均已落;C6(placeholder 语义)与 C7(认领后连通性自测,需 CPA CORS)记录不做。
  仍未做:智谱接入 CPA 的实机配置(§4 配方已验证待用户执行)。
