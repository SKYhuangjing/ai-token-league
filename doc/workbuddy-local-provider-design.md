# workbuddy_local Provider 设计文档

- 版本: 0.7 迭代(2026-08-21)
- 状态: 设计定稿,进入实施
- 前置调研: 本文档第 1 节即调研记录,证据来自本机 WorkBuddy 5.3.14(darwin-arm64)真实数据、`app.asar` 源码级路径逻辑、社区项目交叉验证(starry0214/wb_monitor、clancy-feng/workbuddy-usage-status)
- 实施清单依据: `doc/provider-integration-guide.md`(zcode 接入沉淀的权威核对清单)

## 1. 调研结论(数据源事实)

### 1.1 数据落在哪

WorkBuddy 桌面端(Electron,OpenClaw 系内核)数据目录解析逻辑(提取自 `app.asar`):

```js
getWorkbuddyConfigDir() {
  return process.env.WORKBUDDY_CONFIG_DIR?.trim()
      || path.join(os.homedir(), getDefaultConfigDirname()); // 默认 ".workbuddy"
}
```

| 平台 | 目录 |
| --- | --- |
| macOS / Linux | `~/.workbuddy/` |
| Windows | `C:\Users\<user>\.workbuddy\`(即 `%USERPROFILE%\.workbuddy`,不用 `%APPDATA%`、不写注册表) |

官方覆盖入口:环境变量 `WORKBUDDY_CONFIG_DIR`(次级 `WORKBUDDY_DATA_FOLDER_NAME`,默认值 `.workbuddy`)。

### 1.2 文件形态与 schema(实测)

**主数据源:traces(每请求一个 JSON 文件)**

```
~/.workbuddy/traces/<pid>/trace_<uuid>.json
```

结构(字段名为实测真实字段):

```jsonc
{
  "trace": {
    "traceId": "trace_xxx", "name": "Agent workflow", "workerPid": 98437,
    "startedAt": "2026-08-21T15:49:32.987Z",   // ISO 8601 UTC,毫秒精度
    "endedAt": "...", "duration": 12308,        // 毫秒
    "status": "ok", "spanCount": 5,
    "totalTokens": 0                            // ⚠️ 实测恒 0,不可用
    // modelInfo: 5.3.14 实测缺席;旧版本/部分 agent 存在(社区解析器依赖它)
  },
  "spans": [
    { "type": "agent"|"custom"|"generation"|..., "startedAt": "...", ... },
    {
      "type": "generation",                      // ← 权威 token 来源
      "toolOutput": "[{ \"model\":\"auto\", \"usage\": {
        \"prompt_tokens\": 32338,
        \"completion_tokens\": 710,
        \"total_tokens\": 33048,
        \"prompt_tokens_details\":  { \"cached_tokens\": 9984, ... },
        \"completion_tokens_details\": { \"reasoning_tokens\": 396, ... }
      } }]",                                    // JSON 字符串,数组,OpenAI 风格
      "toolInput": "..."                         // ⚠️ 完整 prompt 明文,禁止读取
    }
  ]
}
```

**辅助数据源 1:sessions/<pid>.json(进程心跳,JSON)**

```jsonc
{ "pid": 98437, "sessionId": "0569c71e-...", "cwd": "/Users/sky/WorkBuddy/...",
  "startedAt": 1787327371127, "kind": "interactive", "version": "2.115.0", ... }
```

提供 pid → (sessionId, cwd) 映射,用于 workdir 归属。

**辅助数据源 2:workbuddy.db(SQLite,WAL 模式)**

- `sessions` 表:`id, cwd, title, custom_title, status, created_at, updated_at, model, project_id, ...`
- `session_usage` 表:`session_id, used, size, updated_at, credit_json`(积分汇总,如 `{"60aed...":4.69}`)

用途:sessionId → cwd 兜底查询。`credit_json` 积分**本期不上报**(见 3.3)。

### 1.3 token 口径:OpenAI 语义(实测验证)

对真实数据验证:`prompt_tokens=32338` **已包含** `cached_tokens=9984`(OpenAI 语义,非 Anthropic 并列)。拆分不变量:

```
input     = max(prompt_tokens - cached_tokens, 0)   = 22354
output    = completion_tokens                       = 710
cacheRead = prompt_tokens_details.cached_tokens     = 9984
cacheWrite = 0                                       (WorkBuddy 无 cache 写通道)
reasoning = completion_tokens_details.reasoning_tokens = 396 (仅诊断)
total = input + output + cacheRead + cacheWrite     = 33048 == total_tokens ✓
```

本机对账(2026-08-21 真实数据):

| 维度 | 值 |
| --- | --- |
| trace 聚合(两条 generation) | input=22380, output=725, cacheRead=10496, **total=33601** |
| workbuddy.db `session_usage.used` 累计 | 32338(仅主会话 prompt 侧,不含后台标题生成请求、不含 output → 证明 trace 更完整,以 trace 为准) |
| `credit_json` 积分 | 4.69 |

### 1.4 去重、时间戳、模型名

- **去重维度**:一个 trace 文件 = 一次逻辑请求,天然幂等(文件级 fingerprint 缓存);一个 trace 内多个 `generation` span 各自计一次(实测后台标题生成是独立 trace/独立 span,属真实用量,计入)。
- **时间戳**:trace 顶层 `startedAt` 为 RFC3339/ISO 8601 UTC 字符串(秒级以下毫秒)。day/hour 用 collector 统一本地时区管线换算。
- **模型名**:取 `toolOutput[0].model`(实测值 `auto`,WorkBuddy 的模型调度别名;真实模型名本地不落盘)。空则 `"unknown"`。模型维度先聚为 `auto` 是已知局限,官方若落真实模型名则自然生效。
- **错误行**:`trace.status != "ok"` 或 usage 缺失的 generation span 跳过;`total == 0` 跳过。

### 1.6 已知问题:模型维度聚合为 `auto`(已决策:维持现状)

2026-08-22 全量排查结论——本地不存在逐请求真实模型名:

- `workbuddy.db` 的 `sessions.model` = `'auto'`;
- trace 的 `toolOutput[0].model` = `'auto'`;
- 会话日志(`~/.workbuddy/logs/<date>/`)中 `AgentManager.getModel: resolved to first-available='auto'`,流式事件 `_meta.model` 同为 `auto`;日志里的 glm/kimi/deepseek 字符串全部来自云端产品目录(`CloudProductManager fetch cloud product ... models(45)`),非路由记录;
- 根因:`auto` 是服务端调度别名,真实路由只在腾讯服务端发生。WorkBuddy 界面展示真实模型走云端计量 API(`get-user-request-usage` 每条带 `model`);该 API 的 `requestId` 与本地 `traceId` 不相等,日志 `rootRequestId` 只与 credit 事件成对,没有可用的本地关联键。

备选修复(未采纳,留档):云端"保守校准"——仅当某日全部 WorkBuddy 请求解析到同一真实模型时重写该日 `auto`,混合日保持 `auto`;需要新增"本地 provider 发云端调用"边界及默认关闭的配置开关。若未来要做,以此为准。

### 1.5 隐私边界(红线)

- trace 的 `toolInput`/`toolOutput` 含**完整对话明文**——解析器只反序列化 `toolOutput` 并读取 `usage` 与 `model` 两个数字/字符串字段,其余内容不进入任何内存结构之外的处理,绝不上传。
- `sessions/<pid>.json` 与 `workbuddy.db.sessions` 的 `cwd` 真实路径只作为 `workdirCandidate` 进入本地 hash 管线,服务端只见 hash。
- `workbuddy.db` 的 `session_usage.credit_json`、本机 OAuth token 文件(`CodeBuddyExtension/.../workbuddy-desktop.info`)不在采集范围。

## 2. Provider 设计

### 2.1 标识

```rust
pub const PROVIDER_ID: &str = "workbuddy_local";
pub const TOOL_CODE: &str = "workbuddy";
pub const VERSION: &str = "0.1.0";
```

显示名 `WorkBuddy`。事件 `sourceKind = "local_log"`(主源是 JSON 日志文件)、`sourceQuality = "exact"`。

### 2.2 路径发现

```rust
auto_roots:
  1. env WORKBUDDY_CONFIG_DIR(非空即用,存在性检查)
  2. home_dir().join(".workbuddy")
manual_roots:
  config.provider_roots["workbuddy_local"]
```

`scan_sessions` 返回 `<root>/traces/*/trace_*.json` 全部文件(`walk_files`,matcher:文件名以 `trace_` 开头且 `.json` 结尾)。遵循 guide §2.1 固定逻辑(enabled=false → 空;ignored auto root 跳过;manual 去重追加)。

### 2.3 解析(try_parse_usage)

对单个 trace 文件:

1. 读 JSON;`data.trace` 缺失 → `Err`(进 provider_errors,不静默)。
2. 计算 day/hour:把 trace `startedAt` 解析为毫秒时间戳(ISO 8601 → ms;解析失败回退文件 mtime),走 `crate::date::local_day_from_timestamp_ms` / `local_hour_from_timestamp_ms`。
3. 遍历 `spans`,`type == "generation"` 且 `toolOutput` 非空:
   - `serde_json::from_str(toolOutput)`,取 `[0]`(数组)或对象本体;
   - 读取 `usage`(数字字段用 `as_f64().round() as i64` 风格,同 common::token_field_i64 别名表思路):
     - `prompt_tokens` / `input_tokens` / `inputTokens`
     - `completion_tokens` / `output_tokens` / `outputTokens`
     - `prompt_tokens_details.cached_tokens` / `cached_tokens`(顶层兼容)
     - `completion_tokens_details.reasoning_tokens` / `reasoning_tokens`
   - OpenAI 语义拆分:`input = max(prompt - cacheRead, 0)`;`total = input + output + cacheRead + cacheWrite`;`total == 0` 跳过;
   - `model` 取响应对象 `model`,空则 `"unknown"`;
   - `sessionId` 取 trace 级 `sessionId`(实测 trace 顶层无 sessionId 时回退 `workerPid` 字符串)。
4. **modelInfo 兜底**(版本漂移容错):若无任何 generation span 产出 usage,且 trace 顶层 `modelInfo` 存在且 `totalInput+totalOutput+totalCached > 0`(社区解析器的旧格式),按 `input=totalInput, output=totalOutput, cacheRead=totalCached, cacheWrite=0` 出一条事件。
5. workdir 归属(在 provider 内、事件 finalize 前填充 `workdirCandidate`):
   - 首选:同根目录 `sessions/<pid>.json`(pid = trace 文件父目录名)的 `cwd`,且其 `sessionId` 与 trace 匹配;
   - 兜底:`workbuddy.db` 只读打开(`SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`,guide §2.2,WAL 安全),`SELECT cwd FROM sessions WHERE id = ?`;
   - 都失败:留空(由 finalize_event 管线降级),不用 `current_dir()` 噪声兜底。
6. 事件 JSON 按 guide §2.3 契约输出全部字段。

### 2.4 注册(3 处 Rust)

1. `collector-core/src/provider/mod.rs`: `pub mod workbuddy_local;`
2. `collector-core/src/scanner.rs`:
   - `scan_usage_with_source_cache` 加 workbuddy 块(OpenClaw 文件循环模式:逐 trace 文件 `source_metadata` fingerprint → 缓存命中或 `try_parse_usage` → `finalize_event` → `source_index`;`Err` 进 `provider_errors`;`health.push(local_provider_health(...))`)。
   - `provider_health` 的 `vec![]` 追加 `local_provider_health` 项。
3. `atl-collector/src/sidecar.rs`: `TRAY_PROVIDER_NAMES` 加 `("workbuddy_local", "WorkBuddy")`。

后端 `providerId` 开放字符串,**无后端改动**。

### 2.5 前端触点(9 处,照 guide §四)

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `src/desktop/index.html` | `#sources-tabs` 加 `<button data-provider-tab="workbuddy_local" data-i18n="source.workbuddy">` |
| 2 | `src/desktop/renderer.js` ×4 | `#add-workbuddy-root` click handler;`sourceIconPath`;`renderHealth` addBtn 分支;局部 `sourceName` |
| 3 | `src/desktop/renderer-data.js` | `sourceName` 加 `workbuddy_local` 分支 |
| 4 | `src/desktop/renderer-helpers.js` | `UI_PROVIDER_ORDER` 追加 `"workbuddy_local"` |
| 5 | `src/shared/chart-helpers.js` | `sourceName` 加映射 |
| 6 | `src/shared/i18n.js` | zh、en 各 2 key:`source.workbuddy` = `WorkBuddy`;`desktop.sources.addWorkbuddy` = `添加 WorkBuddy 位置` / `Add WorkBuddy location` |
| 7 | `src/web/admin.js` | `providerDisplayNames` 加 `workbuddy_local: "WorkBuddy"` |
| 8 | `src/web/data-value-demo-live.js` | `sourceNames` 加映射 |
| 9 | 桌面托盘 | sidecar.rs 已覆盖 |

### 2.6 样例数据(samples/workbuddy/)

**合成数据,绝不使用真实 trace(含真实对话明文)**:

```
samples/workbuddy/
├── traces/10001/trace_aaaa1111.json   # 正常行:1 generation,cache 拆分,UTC 正午
├── traces/10001/trace_bbbb2222.json   # 多 generation span(2 条 usage)
├── traces/10002/trace_cccc3333.json   # 零 token generation(跳过)+ modelInfo 兜底行(旧格式)
├── traces/10002/trace_dddd4444.json   # status=error + usage 缺失
├── traces/10003/trace_eeee5555.json   # toolOutput 非法 JSON(容错)
└── sessions/10001.json, 10002.json, 10003.json  # cwd 映射(含一个 sessionId 不匹配的孤儿用例)
```

时间戳取 UTC 正午(如 `2026-06-08T12:00:00Z`)保证时区稳定断言。纯 JSON 样例,**不受 `*.db` gitignore 影响,直接入库**;`workbuddy.db` 兜底路径不在样例内覆盖(真实库对账覆盖)。

### 2.7 验证器(scripts/verify-ccusage.mjs)

新增 `expectedWorkbuddy()`:纯 Node 重算 `~/.workbuddy/traces/*/trace_*.json`(与 Rust 解析同口径:generation span → usage → OpenAI 拆分 → 按日聚合),与 collector scan 输出逐日对总。注册 5 处:`byProvider` map、parse 过滤、whitelist、dispatch、默认 provider 集合(与 openclaw 同性质,加默认)。本机已有真实数据(33601 tokens),立即有对账效力。

## 3. 明确不做的事(本期边界)

1. **积分(credits)不上报**:`assertUsageItem` schema 无 credits 字段;积分与 token 异构,产品规则"成本是可选展示、不是排名真值"。云端计量 API(`/billing/meter/*`,已实测调通)与 `credit_json` 的积分维度留作后续可选展示特性,需产品层先决策 schema 扩展。
2. **云端 API 不作为数据源**:本地 trace 是请求级、token 级、离线可用,严格优于云端积分聚合;云端接口仅在调研记录中留档。
3. **MITM 抓包不做**:需要用户装 CA 证书,侵入性强,且 trace 已含所需数据。
4. **不做跨 pid 会话合并、不做 credits 归日近似**(社区项目的近似策略不需要,我们有逐请求时间戳)。

## 4. 测试矩阵

1. **Rust 单测**(provider 文件内,guide §六.1):常量;样例解析条数;OpenAI 拆分数学不变量(total == prompt+completion);多 generation span;零 token 跳过;error 行跳过;非法 toolOutput 容错;modelInfo 兜底;孤儿 sessionId(workdir 兜底);不存在路径;manual root 扫描;禁用开关;`WORKBUDDY_CONFIG_DIR` 覆盖。断言"包含样例路径"而非精确数量(防真实 `~/.workbuddy` 污染)。
2. **集成测试**(`collector-core/tests/integration_scan.rs`):`init_config` 注册样例根 + `scenario_workbuddy_scan`(总额精确断言、`workdirHash` 非真实路径、无 provider_errors、health 含 workbuddy_local)。
3. **前端单测**:`tests/renderer/chart-helpers.test.js` 与 `renderer-data.test.js` 的 `sourceName` 断言各加一行。
4. **E2E**:`tests/e2e/mock-tauri.js` mockHealth 加条目;`tests/e2e/workflows.spec.js` 加 tab 用例(tab 可见 → 点击 → 卡片渲染 → 来源行可见)。
5. **真库对账**(guide §七):隔离 HOME + 符号链接真实 `~/.workbuddy/traces`,编译产物实际扫描 vs Node 重算,逐日分毫不差;本机已知总量 33601(2026-08-21 两条,此后随真实使用增长,以对账时点为准)。

## 5. 验证门禁(完成定义)

```bash
cargo test --workspace        # 含新 provider 单测 + 集成场景
npm test
npm run test:ui
npm run test:e2e
node --check src/desktop/renderer.js
npm run verify:ccusage        # 含 workbuddy 真库对账
git diff --check
```

桌面端 `npm run desktop` 目检:来源页 WorkBuddy tab/卡片/开关/扫描数据。不打安装包(纯 provider + 前端触点,无打包面变更;如需发版走正常 release 流程)。

## 6. 任务分解

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| 0.7-T68 | Rust provider + 注册 + 样例 + 单测/集成测试 | — | §2.1–2.4、§2.6、§4.1–4.2;`cargo test --workspace` 通过 |
| 0.7-T69 | 前端 9 触点 + i18n + 前端单测 + E2E | —(与 T68 并行) | §2.5、§4.3–4.4;`test:ui`、`test:e2e`、`node --check` 通过 |
| 0.7-T70 | 验证器 + 文档(AGENTS.md 表、README 决策、baseline/tasks 补账)+ 全量门禁 | T68, T69 | §2.7、§5 全部通过;文档同步 |
