# OpenRouter Pricing 开发任务追踪

## 0. 阶段说明

本文档记录模型价格解析从当前内置 fallback 方案升级为 `DB override -> OpenRouter remote cache -> missing price` 的任务拆分。

该能力基于当前 `0.2-baseline.md` 之后继续演进，不回写 v0.1 冻结基线。目标是让 AI Token League 的成本估算具备可追溯的价格来源、明确的人工覆盖优先级，以及缺价时可运营补齐的闭环。

当前状态：

- 已确认方向：管理员维护的 `model_prices` 永远优先于外部价格源。
- 已确认远程源：使用 OpenRouter `https://openrouter.ai/api/v1/models`，避开本机无法访问 GitHub 的问题。
- 已确认缺价行为：DB 与 OpenRouter 均未命中时保持 `unknown_price`，由 Admin Missing prices 引导用户补价。
- 已确认历史口径：人工价格变更继续触发历史 usage cost 重算。
- 待确认边界：OpenRouter 远程价格刷新是否自动触发历史重算，推荐第一阶段采用管理员显式刷新并重算。

## 1. 文档用途

本文档用于追踪 OpenRouter Pricing 能力的设计、开发、验证和后续状态。

任务拆分基于以下产品目标：

- 价格优先级明确：人工库表价格高于 OpenRouter 远程价格。
- 远程价格可追溯：展示来源、版本、拉取时间和缓存状态。
- 缺价可运营：无法定价的 model 继续进入 Missing prices，由用户手工录入。
- 历史成本可解释：价格变化导致历史成本重算时，应能说明使用了哪类价格来源。
- 成本计算不依赖硬编码 fallback 作为主路径。

非目标：

- 不把 OpenRouter 远程价格直接写入 `model_prices` 覆盖人工价格。
- 不改变排行榜排序，排序仍基于 `totalTokens`。
- 不上传 prompt、response、代码、真实绝对路径、凭据或本地私密信息。
- 不在第一阶段实现所有 provider 的区域价、fast mode 乘数和复杂 tiered pricing。
- 不要求客户端直接访问 OpenRouter 远程地址。

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
- 涉及外部接口、数据契约、成本含义、历史重算行为的变更，必须先更新本文档再编码。
- 价格来源、匹配规则、缓存状态必须可观测，不能只在内部静默生效。
- 每个 Epic 完成时，需要补充验证记录。

## 3. 总验收

OpenRouter Pricing 能力完成时必须同时满足：

- 同一 model 同时存在 `model_prices` 与 OpenRouter 价格时，成本计算使用 `model_prices`。
- `model_prices` 未命中但 OpenRouter 命中时，成本计算使用 OpenRouter cache。
- DB 与 OpenRouter 均未命中时，`estimatedCostUsd=null` 且 `costQuality=unknown_price`。
- Admin Missing prices 能继续展示缺价 model、受影响 token 和 provider 分布。
- `GET /api/model-prices` 能返回 custom prices、OpenRouter cache 状态和 missing models。
- OpenRouter 远程不可用时，已有 cache 可继续用于计算；无 cache 时不阻塞 usage 上传。
- 人工新增或调整价格后，历史 `usage_daily` 成本按当前规则重算。
- 远程价格刷新与历史重算行为有明确 API 和 UI 入口。
- 测试覆盖 DB 优先、OpenRouter 命中、缺价、远程失败、历史重算和 cache 状态。

## 4. 统一数据契约

### 4.1 价格来源优先级

所有服务端成本计算统一使用以下优先级：

```text
model_prices(custom/admin) -> openrouter_cache(remote) -> null
```

规则：

- `model_prices` 是人工确认价格，用于覆盖远程价格。
- OpenRouter cache 是远程价格快照，不作为人工价格表。
- 返回 `null` 时，不允许用旧的硬编码 fallback 静默估算。
- `pricingModel` 记录最终命中的价格 key。
- `pricingSource` 记录 `custom`、`admin`、`openrouter` 或空值。

### 4.2 价格字段

内部价格对象统一使用 per-token 字段，避免在计算链路中反复转换：

| 字段 | 含义 |
| --- | --- |
| `model` | 价格 key |
| `input_cost_per_token` | input token 单价 |
| `output_cost_per_token` | output token 单价 |
| `cache_read_input_token_cost` | cache read input token 单价 |
| `cache_creation_input_token_cost` | cache write input token 单价 |
| `reasoning_cost_per_token` | 固定为 0；reasoning 作为 output 的组成，不单独计费 |
| `source` | `custom` / `admin` / `openrouter` |
| `pricingVersion` | 价格版本 |
| `updatedAt` | 人工价格更新时间或远程拉取时间 |

约束：

```text
estimatedCostUsd = inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheWriteCostUsd
```

### 4.3 OpenRouter Cache 字段

建议新增 `model_price_cache`，用于保存 OpenRouter 远程快照。

| 字段 | 含义 |
| --- | --- |
| `model` | OpenRouter 原始 model key |
| `normalizedModel` | 归一化 key |
| `inputCostPerToken` | input token 单价 |
| `outputCostPerToken` | output token 单价 |
| `cacheReadCostPerToken` | cache read 单价 |
| `cacheWriteCostPerToken` | cache write 单价 |
| `reasoningCostPerToken` | 固定为 0，不从 output 价派生 |
| `maxInputTokens` | OpenRouter max input tokens |
| `maxOutputTokens` | OpenRouter max output tokens |
| `source` | 固定 `openrouter` |
| `pricingVersion` | 远程版本，例如 `openrouter-main:<etag>` 或 `openrouter-main:<fetchedAt>` |
| `fetchedAt` | 拉取时间 |
| `expiresAt` | cache 过期时间 |
| `rawJson` | 可选，保留原始字段便于排查 |

JSON store 可使用等价结构：

```text
db.modelPriceCache = {
  remote: { status, url, fetchedAt, expiresAt, pricingVersion, lastError },
  prices: { [model]: price }
}
```

### 4.4 成本质量

沿用现有 `costQuality`：

| 值 | 含义 |
| --- | --- |
| `exact_price` | model 与价格 key 精确命中 |
| `estimated_price` | 通过 provider prefix、alias 或 contains 规则命中 |
| `unknown_price` | DB 与 OpenRouter 均未命中 |

补充规则：

- OpenRouter direct match 可标记 `exact_price`。
- OpenRouter prefix 或 contains match 标记 `estimated_price`。
- 第一阶段只使用 `pricing.prompt`、`pricing.completion`、`pricing.input_cache_read`、`pricing.input_cache_write`；`pricing.internal_reasoning` 不参与 token cost。
- 聚合对象按现有质量降级规则合并，任一缺价行会让聚合结果包含 missing price 信息。

### 4.5 远程源

OpenRouter 远程源：

```text
https://openrouter.ai/api/v1/models
```

本项目第一阶段能力边界：

- 支持远程 fetch。
- 支持内存 cache。
- 支持 provider prefix 候选匹配。
- 支持远程失败时 fallback 到已有 cache。

本项目直接实现最小必要 fetch、normalize 和 match 逻辑，不引入 ccusage 或 GitHub raw 数据源。

## 5. 任务总览

| Epic | 名称 | 状态 | 完成标准 |
| --- | --- | --- | --- |
| OP0 | 产品基线与数据契约冻结 | DONE | 本文档定义价格优先级、远程源、cache 字段、缺价行为和重算边界 |
| OP1 | Pricing Resolver 抽象升级 | DONE | 成本计算统一走 DB 优先、OpenRouter 次之、缺价为空的 resolver |
| OP2 | OpenRouter 远程价格缓存 | DONE | 服务端可拉取、校验、缓存和查询 OpenRouter 价格 |
| OP3 | 存储与迁移升级 | DONE | JSON store 与 MySQL store 均支持远程价格 cache |
| OP4 | 重算链路与 API 升级 | DONE | 人工改价、远程刷新、手动重算行为明确且可调用 |
| OP5 | Admin 价格管理升级 | DONE | UI 可展示远程 cache 状态、刷新入口、来源和缺价 |
| OP6 | 验证与回归 | DONE | 覆盖价格优先级、远程失败、缺价、历史重算和 UI smoke |

## 6. Epic 任务拆分

### OP0 产品基线与数据契约冻结

目标：固定 OpenRouter Pricing 的产品语义、字段契约、远程源和非目标，避免实现时把人工价格表和远程价格快照混用。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| OP0-T1 | 固化价格优先级 | DONE | 无 | 文档明确 `model_prices -> OpenRouter cache -> null` |
| OP0-T2 | 固化价格来源字段 | DONE | OP0-T1 | 明确 `pricingSource`、`pricingVersion`、`pricingModel` 的含义 |
| OP0-T3 | 固化 OpenRouter cache 契约 | DONE | OP0-T1 | JSON store 与 MySQL store 的 cache 字段边界明确 |
| OP0-T4 | 固化缺价行为 | DONE | OP0-T1 | DB 与 OpenRouter 均未命中时保持 `unknown_price` 并进入 Missing prices |
| OP0-T5 | 固化远程刷新与历史重算边界 | DONE | OP0-T1 | 明确远程刷新不静默改写历史，重算由 API 或 Admin 操作触发 |

验证记录：

```text
2026-04-30: 已按 OpenRouter 远程价格源完成实现，并通过 `npm test` 与 `node src/backend/server.js --smoke` 验证。
```

### OP1 Pricing Resolver 抽象升级

目标：把当前基于 `FALLBACK_PRICE_MAP` 的同步 priceMap 计算，升级为可注入来源、可解释来源、可异步刷新的 resolver。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| OP1-T1 | 定义 `PricingResolver` 接口 | DONE | OP0 | 支持 `resolve(model)` 返回 price、quality、source、version、matchedKey |
| OP1-T2 | 拆分人工价格源 | DONE | OP1-T1 | `model_prices` 可作为第一优先级 source 独立查询 |
| OP1-T3 | 拆分 OpenRouter cache 价格源 | DONE | OP1-T1 | OpenRouter cache 可作为第二优先级 source 查询 |
| OP1-T4 | 改造 `estimateUsageCost` | DONE | OP1-T1-OP1-T3 | 不再直接依赖硬编码 fallback，缺价时返回 null 成本 |
| OP1-T5 | 保持聚合 cost 语义 | DONE | OP1-T4 | `aggregateCost`、missing model、quality merge 逻辑保持兼容 |
| OP1-T6 | 补充 resolver 单测 | DONE | OP1-T1-OP1-T5 | 覆盖 DB 优先、OpenRouter 命中、缺价、质量降级 |

验证记录：

```text
2026-04-30: 已按 OpenRouter 远程价格源完成实现，并通过 `npm test` 与 `node src/backend/server.js --smoke` 验证。
```

### OP2 OpenRouter 远程价格缓存

目标：服务端可从 OpenRouter 远程 JSON 拉取价格，规范化为本项目价格字段，并提供稳定 cache。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| OP2-T1 | 新增 OpenRouter fetcher | DONE | OP0 | 可从 OpenRouter URL 拉取 JSON，支持 timeout 和错误返回 |
| OP2-T2 | 新增 OpenRouter schema normalize | DONE | OP2-T1 | 只接收数字价格字段，异常模型跳过并计数 |
| OP2-T3 | 实现 provider prefix 匹配 | DONE | OP2-T2 | 支持 direct、`anthropic/`、`openai/`、`azure/` 等候选匹配 |
| OP2-T4 | 实现 contains fallback 匹配 | DONE | OP2-T3 | direct/prefix 未命中时可降级 contains，标记 `estimated_price` |
| OP2-T5 | 实现 TTL 与 stale cache 语义 | DONE | OP2-T1 | 返回 `fresh/stale/empty/failed` 状态和 `lastError` |
| OP2-T6 | 远程失败 fallback 到旧 cache | DONE | OP2-T5 | 拉取失败时旧 cache 仍可参与成本计算 |
| OP2-T7 | 补充 OpenRouter fetcher 单测 | DONE | OP2-T1-OP2-T6 | 覆盖成功、schema 跳过、匹配、超时、失败 fallback |

验证记录：

```text
2026-04-30: 已按 OpenRouter 远程价格源完成实现，并通过 `npm test` 与 `node src/backend/server.js --smoke` 验证。
```

### OP3 存储与迁移升级

目标：JSON store 与 MySQL store 都能保存 OpenRouter cache，并在服务重启后继续使用最近一次有效快照。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| OP3-T1 | JSON store 增加 `modelPriceCache` | DONE | OP2 | `data/db.json` 可保存 remote metadata 和 price map |
| OP3-T2 | MySQL migration 增加 `model_price_cache` | DONE | OP2 | 新表可保存 OpenRouter 快照价格和 cache metadata |
| OP3-T3 | MySQL load/sync 支持 cache | DONE | OP3-T2 | 启动时可加载 cache，刷新后可持久化 |
| OP3-T4 | 保持 `model_prices` 人工表不变 | DONE | OP3-T1-OP3-T3 | OpenRouter 刷新不会覆盖人工价格记录 |
| OP3-T5 | 补充 store 兼容测试 | DONE | OP3-T1-OP3-T4 | JSON 与 MySQL store 均能在 cache 存在时参与重算 |

验证记录：

```text
2026-04-30: 已按 OpenRouter 远程价格源完成实现，并通过 `npm test` 与 `node src/backend/server.js --smoke` 验证。
```

### OP4 重算链路与 API 升级

目标：人工价格、远程价格和历史成本重算之间的行为可控、可解释、可验证。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| OP4-T1 | 改造 `recalculateCosts` 为 resolver 驱动 | DONE | OP1, OP3 | 全量重算使用当前 DB + OpenRouter cache |
| OP4-T2 | 人工改价继续自动重算 | DONE | OP4-T1 | `POST /api/admin/model-prices` 保存后历史 usage cost 更新 |
| OP4-T3 | 新增 OpenRouter refresh API | DONE | OP2, OP3 | `POST /api/admin/model-prices/refresh-openrouter` 可刷新 cache |
| OP4-T4 | 支持 refresh 后可选重算 | DONE | OP4-T3 | `recalculate=true` 时刷新后触发历史成本重算 |
| OP4-T5 | 扩展 `GET /api/model-prices` | DONE | OP3 | 返回 custom、openrouter cache status、missing models |
| OP4-T6 | API 错误语义固定 | DONE | OP4-T3-OP4-T5 | 远程失败返回 cache 状态，不影响已有价格查询 |
| OP4-T7 | 补充 API smoke 测试 | DONE | OP4-T1-OP4-T6 | 覆盖 refresh、recalculate、missing prices 和 source 展示 |

验证记录：

```text
2026-04-30: 已按 OpenRouter 远程价格源完成实现，并通过 `npm test` 与 `node src/backend/server.js --smoke` 验证。
```

### OP5 Admin 价格管理升级

目标：Admin Model prices 页能解释当前价格体系，并提供远程刷新和人工补价入口。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| OP5-T1 | 展示 OpenRouter cache 状态 | DONE | OP4-T5 | 页面显示 status、fetchedAt、expiresAt、lastError |
| OP5-T2 | 新增 Refresh OpenRouter 按钮 | DONE | OP4-T3 | 点击后调用 refresh API 并刷新列表 |
| OP5-T3 | 新增 Refresh + Recalculate 行为 | DONE | OP4-T4 | 管理员可明确选择刷新后重算历史成本 |
| OP5-T4 | 价格列表展示 source | DONE | OP4-T5 | custom 与 openrouter 价格来源可区分 |
| OP5-T5 | Missing prices 保持人工补价闭环 | DONE | OP4-T5 | OpenRouter 仍未命中的 model 继续可一键填入表单 |
| OP5-T6 | Admin UI 可读性验证 | DONE | OP5-T1-OP5-T5 | 默认宽度下 Pricing tab 不拥挤、不遮挡、不误导来源 |

验证记录：

```text
2026-04-30: 已按 OpenRouter 远程价格源完成实现，并通过 `npm test` 与 `node src/backend/server.js --smoke` 验证。
```

### OP6 验证与回归

目标：用测试和 smoke 证明价格链路行为符合设计，尤其是历史成本变化和缺价行为。

| ID | 任务 | 状态 | 依赖 | 验收标准 |
| --- | --- | --- | --- | --- |
| OP6-T1 | 单测覆盖价格优先级 | DONE | OP1 | 同 model 同时存在 DB 与 OpenRouter 时使用 DB |
| OP6-T2 | 单测覆盖 OpenRouter 命中 | DONE | OP2 | DB 缺失但 OpenRouter 命中时输出成本和 source |
| OP6-T3 | 单测覆盖缺价 | DONE | OP1, OP2 | 双源缺失时保持 `unknown_price` 和 missing models |
| OP6-T4 | 单测覆盖远程失败 | DONE | OP2, OP3 | 有旧 cache 时可继续计算，无 cache 时保持缺价 |
| OP6-T5 | 回归历史重算 | DONE | OP4 | 人工改价和 refresh+recalculate 后历史成本按预期变化 |
| OP6-T6 | API smoke | DONE | OP4 | `/api/model-prices`、refresh、recalculate 均返回可解释状态 |
| OP6-T7 | Admin smoke | DONE | OP5 | Pricing tab 可完成 refresh、补价、查看 missing prices |

验证记录：

```text
2026-04-30: 已按 OpenRouter 远程价格源完成实现，并通过 `npm test` 与 `node src/backend/server.js --smoke` 验证。
```

## 7. 验证矩阵

| ID | 验证项 | 覆盖任务 | 验收标准 |
| --- | --- | --- | --- |
| V1 | DB 优先 | OP1, OP6 | 同 model 同时存在 DB 与 OpenRouter 时使用 DB 价格 |
| V2 | OpenRouter fallback | OP1, OP2, OP6 | DB 缺失但 OpenRouter 命中时可计算成本 |
| V3 | 双源缺价 | OP1, OP2, OP6 | DB 与 OpenRouter 均缺失时返回 `unknown_price` |
| V4 | Missing prices | OP4, OP5 | 缺价 model 在 Admin 中可见并可补价 |
| V5 | 人工改价历史重算 | OP4, OP6 | `model_prices` 保存后历史 usage cost 被重算 |
| V6 | 远程刷新不静默改写 | OP4, OP5 | 仅 refresh cache 不改变历史成本，显式 recalculate 才改写 |
| V7 | 远程失败 fallback | OP2, OP3, OP6 | 拉取失败时旧 cache 可用，无 cache 时缺价 |
| V8 | Cache 持久化 | OP3 | 服务重启后仍可加载最近一次 OpenRouter cache |
| V9 | API 来源可解释 | OP4 | `/api/model-prices` 返回 source、version、cache status |
| V10 | Admin 来源可读 | OP5 | Pricing tab 能区分 custom 与 OpenRouter 价格 |
| V11 | Cost invariant | OP1, OP6 | 价格完整时 per-type cost 之和等于 `estimatedCostUsd` |
| V12 | 非文本价格忽略 | OP2, OP6 | OpenRouter 非 token 价格字段不参与 token cost |

## 8. 推荐实施顺序

1. OP0 产品基线与数据契约冻结。
2. OP1 Pricing Resolver 抽象升级。
3. OP2 OpenRouter 远程价格缓存。
4. OP3 存储与迁移升级。
5. OP4 重算链路与 API 升级。
6. OP5 Admin 价格管理升级。
7. OP6 验证与回归。

OP1 和 OP2 可以先用内存 fake cache 并行推进。OP3 完成后再接入真实持久化。OP5 必须在 OP4 API 稳定后推进，避免 UI 先绑定临时契约。
