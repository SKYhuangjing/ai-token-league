# Usage Composition 开发任务追踪

## 0. 阶段说明

本文档记录 Usage Composition 能力从产品设计到落地验证的任务拆分。

该能力基于当前 `0.2-baseline.md` 之后继续演进，不回写 v0.1 冻结基线。目标是把 AI Token League 从只看 `totalTokens` 的榜单，升级为可核对 token 组成和成本组成的 usage ledger。

当前状态：

- 已确认方向：Public Web、Desktop Today、Desktop Trend、Admin 都纳入同一套 token/cost composition 口径。
- 已确认边界：Public Web 第一轮只展示 period overall composition，不做 model-by-model composition。
- 已确认交互：Desktop Trend Table 支持行展开；Trend Chart 点击 bucket 后展示 composition panel。
- 已确认成本口径：开启成本展示时，需要细到每个 token 类型的美元值。
- Admin 页面同步升级，承担最高密度的核账和异常排查能力。

## 1. 文档用途

本文档用于追踪 Usage Composition 能力的设计、开发、验证和后续状态。

任务拆分基于以下产品目标：

- 展示 token 组成：input、output、cache read、cache write、reasoning、total。
- 展示成本组成：input/output/cache/reasoning 对应成本、总成本、价格质量和缺价影响。
- 保证 Public Web、Desktop、Admin 看到同一套账本口径。
- 保持 Public Web 和 Desktop 默认视图可扫读，将高密度核账信息放入详情、展开行、抽屉和 raw table。
- Admin 提供最高密度查账能力，用于解释异常周期、缺价影响和成本来源。

非目标：

- 不改变排行榜排序，排序仍基于 `totalTokens`。
- 不上传或展示 prompt、response、代码、真实绝对路径、凭据或本地私密信息。
- 不把 Public Web 详情页做成 Admin 报表。
- 不引入服务端用户偏好存储。

## 2. 状态定义

任务状态只使用以下值：

```text
TODO        未开始
DOING       开发中
BLOCKED     阻塞中
REVIEW      待评审或待验证
DONE        已完成
DEFERRED    延后，不进入当前阶段
```

任务推进规则：

- 只有满足验收标准后，任务才能进入 `DONE`。
- 涉及外部接口、数据契约、成本含义、隐私边界的变更，必须先更新本文档再编码。
- UI 任务必须同时说明 cost-off 和 cost-on 状态。
- 每个 Epic 完成时，需要补充验证记录。

## 3. 总验收

Usage Composition 能力完成时必须同时满足：

- 同一 participant、同一 day，在 Public Web detail、Desktop daily trend、Admin usage 中 token composition 合计一致。
- `totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens`。
- 价格完整时，`estimatedCostUsd = inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheWriteCostUsd + reasoningCostUsd`。
- cost-off 模式下所有美元数隐藏，但 token composition 仍可见。
- cost-on 模式下 full composition 视图显示 per-type cost、总成本、price quality 和 missing price 影响。
- Public Web 详情页只展示 period overall composition，不展示 model-by-model composition。
- Desktop Today 可解释今天 token 花在哪类、哪些 model/workdir。
- Desktop Trend 可发现异常 period，并在同页解释异常来自哪类 token。
- Admin 主表和详情抽屉可支持运营核账，能定位 input-heavy、output-heavy、cache-heavy、reasoning-heavy 周期。
- Admin Quality 能评估 composition anomaly 和 pricing coverage。

## 4. 统一数据契约

### 4.1 Token Composition 字段

所有代表 participant、period、model、workdir、source 或 raw row 的聚合对象都应尽量携带：

| 字段 | 含义 |
| --- | --- |
| `inputTokens` | 输入 token |
| `outputTokens` | 输出 token |
| `cacheReadTokens` | cache read token |
| `cacheWriteTokens` | cache write token |
| `reasoningTokens` | reasoning token |
| `totalTokens` | 展示和排序总 token |

约束：

```text
totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens
```

如果 provider 只能提供 `totalTokens`，该行可以保持 `sourceQuality=partial`，但 UI 不应伪造组成。当前阶段不新增 `unclassifiedTokens`，只展示已有组成字段和 total。

### 4.2 Cost Composition 字段

当 `includeCost=true` 或桌面端 `showEstimatedCost=true` 时，对象应携带：

| 字段 | 含义 |
| --- | --- |
| `inputCostUsd` | input token 成本 |
| `outputCostUsd` | output token 成本 |
| `cacheReadCostUsd` | cache read token 成本 |
| `cacheWriteCostUsd` | cache write token 成本 |
| `reasoningCostUsd` | reasoning token 成本 |
| `estimatedCostUsd` | 总估算成本 |
| `costQuality` | `exact_price` / `estimated_price` / `unknown_price` |
| `missingPriceModels` | 缺价 model 及受影响 token |
| `missingPriceTokens` | 缺价影响 token 总量 |
| `pricingVersion` | 价格来源版本 |

价格完整时约束：

```text
estimatedCostUsd = inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheWriteCostUsd + reasoningCostUsd
```

### 4.3 展示规则

统一 summary 格式：

```text
In 62% · Out 28% · Cache 8% · Reasoning 2%
```

规则：

- `Cache` 在 summary 中合并 cache read 与 cache write。
- full breakdown 中 cache read 与 cache write 分开展示。
- `exact_price` 展示为 `Exact`。
- `estimated_price` 展示为 `Estimated`。
- `unknown_price` 展示为 `Missing price`。

## 5. 任务总览

| Epic | 名称 | 状态 | 完成标准 |
| --- | --- | --- | --- |
| UC0 | 产品基线与数据契约冻结 | TODO | 本文档定义的字段、展示规则、阶段边界被后续任务共同复用 |
| UC1 | 数据契约与聚合能力升级 | TODO | backend、desktop local aggregation、admin usage 均能输出 token/cost composition |
| UC2 | Public Web Detail 升级 | TODO | 用户详情页可核对 period overall composition 和成本组成 |
| UC3 | Desktop Today 升级 | TODO | Today 页可解释当日 token 组成、model/workdir 组成摘要和成本组成 |
| UC4 | Desktop Trend 升级 | TODO | Trend table 行展开、chart bucket panel 和 summary card 支持 composition |
| UC5 | Admin Usage 升级 | TODO | Admin 主表、行展开和详情抽屉支持高密度核账 |
| UC6 | Admin Quality 升级 | TODO | 支持 composition anomaly、pricing coverage 和 cost explainability 分析 |

## 6. Epic 任务拆分

### UC0 产品基线与数据契约冻结

目标：把 Usage Composition 的产品语义、字段契约、展示规则和非目标固定下来，避免各端实现时口径漂移。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| UC0-T1 | 固化产品目标与非目标 | TODO | 无 | 文档明确 ranking 不变、Public Web 不做 admin 报表、不新增服务端偏好 |
| UC0-T2 | 固化 token composition 字段 | TODO | UC0-T1 | 字段表包含 input/output/cache read/cache write/reasoning/total |
| UC0-T3 | 固化 cost composition 字段 | TODO | UC0-T1 | 字段表包含 per-type cost、总成本、price quality、missing price 影响 |
| UC0-T4 | 固化统一展示规则 | TODO | UC0-T2, UC0-T3 | summary 格式、cost quality 文案和 cost-off/cost-on 行为明确 |
| UC0-T5 | 固化阶段边界 | TODO | UC0-T4 | 明确 UC6 不阻塞主链路，Public Web 第一轮只做 period overall composition |

验证记录：

```text
待补充。
```

### UC1 数据契约与聚合能力升级

目标：所有目标页面都能使用同一套 composition 数据，不在 UI 层各自重新推导账本口径。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| UC1-T1 | 实现 token composition 聚合 helper | TODO | UC0 | 可对 rows 聚合 input/output/cache/reasoning/total |
| UC1-T2 | 实现 per-type cost 计算 helper | TODO | UC1-T1 | 可输出 input/output/cache/reasoning 对应成本和 total cost |
| UC1-T3 | 升级 Public Web detail API | TODO | UC1-T1, UC1-T2 | `/api/participants/:id` 返回 detail、periodRows、rows 的 composition 字段 |
| UC1-T4 | 升级 participant trend API | TODO | UC1-T1, UC1-T2 | `/api/participants/:id/trend` 返回 daily/weekly/monthly composition |
| UC1-T5 | 升级 admin usage 聚合 | TODO | UC1-T1, UC1-T2 | `/api/admin/usage` aggregate rows 支持 composition 和 cost composition |
| UC1-T6 | 升级 desktop local aggregation | TODO | UC1-T1, UC1-T2 | Today、Trend、model/workdir groupBy 对象可输出 composition |
| UC1-T7 | 补充契约测试 | TODO | UC1-T3-UC1-T6 | 覆盖 token invariant、cost invariant、同 day 多端一致性 |

验证记录：

```text
待补充。
```

### UC2 Public Web Detail 升级

目标：公开用户详情页能解释当前榜单周期的 token 和成本组成，但不暴露高密度 admin 信息。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| UC2-T1 | Summary 区增加 Composition summary | TODO | UC1-T3 | Detail summary 显示 total、composition summary、models、cost |
| UC2-T2 | 新增 Usage composition 区块 | TODO | UC2-T1 | period chart 下方展示五类 token、占比和可选成本 |
| UC2-T3 | Top period contribution 增强 | TODO | UC1-T4 | top period 行显示 total、cost 和 composition summary |
| UC2-T4 | Raw data 升级为核账表 | TODO | UC1-T3, UC1-T4 | raw table 展示 period/total/input/output/cache/reasoning/models/cost/price quality |
| UC2-T5 | cost-off / cost-on 状态验证 | TODO | UC2-T1-UC2-T4 | cost-off 无美元数，cost-on 显示 per-type cost 与 price quality |

验证记录：

```text
待补充。
```

### UC3 Desktop Today 升级

目标：Today 页回答“今天 token 花在哪类、花在哪些 model/workdir、对应成本是多少”。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| UC3-T1 | 新增 Token composition 区块 | TODO | UC1-T6 | Today 页展示五类 token、占比和可选成本 |
| UC3-T2 | Today 顶部增加 composition summary | TODO | UC3-T1 | 顶部可快速判断当日 dominant composition |
| UC3-T3 | Workdir consumption 行增强 | TODO | UC1-T6 | 每个 workdir 行展示 total、composition 摘要和可选成本 |
| UC3-T4 | Model consumption 行增强 | TODO | UC1-T6 | 每个 model 行展示 total、composition 摘要和可选成本 |
| UC3-T5 | 默认窗口宽度视觉验证 | TODO | UC3-T1-UC3-T4 | 文本不溢出、不遮挡，默认窗口可读 |

验证记录：

```text
待补充。
```

### UC4 Desktop Trend 升级

目标：Trend 先帮助用户发现异常 period，再在同页解释异常来自哪类 token 和哪部分成本。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| UC4-T1 | Trend summary card 增加 Dominant composition | TODO | UC1-T6 | Latest/Peak/View total 之外展示 input-heavy/cache-heavy 等摘要 |
| UC4-T2 | Trend table 增加 Composition 列 | TODO | UC1-T6 | daily/weekly/monthly 表格行显示 composition summary |
| UC4-T3 | Trend table 支持行展开 | TODO | UC4-T2 | 展开区展示 full composition、per-type cost、price quality、top model/workdir |
| UC4-T4 | Trend chart 支持 bucket selection | TODO | UC1-T6 | 点击柱状 bucket 后记录选中周期 |
| UC4-T5 | Trend chart 增加 composition panel | TODO | UC4-T4 | panel 数据与同 period table 展开数据一致 |
| UC4-T6 | 三种粒度验证 | TODO | UC4-T1-UC4-T5 | daily、weekly、monthly 均支持 composition |

验证记录：

```text
待补充。
```

### UC5 Admin Usage 升级

目标：Admin Usage 成为高密度查账台，可直接解释异常周期和成本来源。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| UC5-T1 | Admin 主表增加 Composition 列 | TODO | UC1-T5 | 聚合行无需打开详情即可看到 composition summary |
| UC5-T2 | Admin 主表支持行展开 | TODO | UC5-T1 | 展开区展示 composition detail、cost detail、top models、top workdirs |
| UC5-T3 | 详情抽屉增加 summary cards | TODO | UC1-T5 | 抽屉展示 total、composition summary、models、workdirs、cost、price quality |
| UC5-T4 | 详情抽屉新增 Token composition 区块 | TODO | UC5-T3 | Workdir Consumption 前展示五类 token、占比和可选成本 |
| UC5-T5 | 详情 raw table 升级为 accounting table | TODO | UC1-T5 | 表格包含 day/total/input/output/cache/reasoning/workdir/model/cost/quality |
| UC5-T6 | Admin 高密度可读性验证 | TODO | UC5-T1-UC5-T5 | 主表和抽屉在默认宽度下可扫描，无字段错位 |

验证记录：

```text
待补充。
```

### UC6 Admin Quality 升级

目标：Admin 能判断账单解释能力是否可靠，并定位 composition anomaly 和缺价影响。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| UC6-T1 | `/api/admin/quality` 增加 composition ratios | TODO | UC1-T5 | 输出 reasoning/cache/output 等占比统计 |
| UC6-T2 | 增加 composition anomaly 检测 | TODO | UC6-T1 | 可识别 reasoning/cache/output 异常高 period |
| UC6-T3 | 增加 pricing coverage 统计 | TODO | UC1-T2 | 输出 model/participant/period 维度缺价 token 占比 |
| UC6-T4 | 增加 cost explainability 统计 | TODO | UC6-T3 | 输出 exact/estimated/unknown price 覆盖分布 |
| UC6-T5 | 增加 Admin Quality UI | TODO | UC6-T1-UC6-T4 | 页面可展示 anomaly、pricing coverage 和 missing price impact |

验证记录：

```text
待补充。
```

## 7. 验证矩阵

| ID | 验证项 | 覆盖任务 | 验收标准 |
| --- | --- | --- | --- |
| V1 | Token 合计一致性 | UC1 | 同一 participant/day 多端 composition 合计一致 |
| V2 | Token invariant | UC1 | `totalTokens` 等于五类 token 之和 |
| V3 | Cost invariant | UC1 | 价格完整时 per-type cost 之和等于 `estimatedCostUsd` |
| V4 | cost-off 展示 | UC2-UC5 | 页面不展示美元数，但 composition 仍可见 |
| V5 | cost-on exact | UC2-UC5 | 展示 per-type cost、总成本和 `Exact` |
| V6 | cost-on estimated | UC2-UC5 | 有估算价格时展示 `Estimated` |
| V7 | missing price | UC2-UC6 | 缺价时展示 `Missing price` 和受影响 model/token |
| V8 | Public Web detail | UC2 | 只展示 period overall composition，不要求 model-by-model |
| V9 | Desktop Today | UC3 | 默认窗口宽度下 composition block 和 item summary 可读 |
| V10 | Desktop Trend table | UC4 | 行展开展示 full composition 和 cost composition |
| V11 | Desktop Trend chart | UC4 | bucket panel 与同 period table 展开数据一致 |
| V12 | Admin Usage main table | UC5 | 聚合行直接展示 composition summary |
| V13 | Admin detail drawer | UC5 | summary、composition block、workdir trend、accounting table 可用 |
| V14 | Admin Quality | UC6 | 可展示 anomaly、pricing coverage、cost explainability |

## 8. 推荐实施顺序

1. UC0 产品基线与数据契约冻结。
2. UC1 数据契约与聚合能力升级。
3. UC2 Public Web Detail 升级。
4. UC3 Desktop Today 升级。
5. UC4 Desktop Trend 升级。
6. UC5 Admin Usage 升级。
7. UC6 Admin Quality 升级。

UC2 和 UC3 可以在 UC1 helper 稳定后并行推进。UC4 和 UC5 应复用同一套 composition rendering helper。UC6 属于分析层，跟随主链路稳定后推进。
