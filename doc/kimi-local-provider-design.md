# kimi_local Provider 设计文档

- 版本: 0.7 迭代(2026-08-24)
- 状态: 设计定稿,待评审后实施
- 前置调研: 本文档第 1 节即调研记录,证据来自本机 Kimi 桌面客户端(com.moonshot.kimichat,Electron)登录后真实会话数据(2026-08-24 实测);官方 kimi-cli 文档(data-locations 页)交叉印证存储格式
- 实施清单依据: `doc/provider-integration-guide.md`(zcode 接入沉淀的权威核对清单)
- 同类参考: `doc/workbuddy-local-provider-design.md`(Electron 桌面端本地采集,结构最接近)

## 1. 调研结论(数据源事实)

### 1.1 数据落在哪

Kimi 桌面客户端内置本地 agent 运行时 daimon(内嵌 kimi-code 内核)。agent 会话(含 Kimi Work)逐 turn 落盘:

```
<userData>/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/
├── session_index.jsonl                        # sessionId → sessionDir/workDir 映射(追加式)
└── sessions/
    └── wd_workspace_<hash>/
        ├── conv-<id>/agents/main/wire.jsonl   # 用户会话
        └── ctitle-<id>/agents/main/wire.jsonl # 后台标题生成会话
```

| 平台 | userData 根 |
| --- | --- |
| macOS | `~/Library/Application Support/kimi-desktop/`(实测) |
| Windows | `%APPDATA%\kimi-desktop\`(**推测**,Electron 默认 userData;待 Windows 真机验证) |
| Linux | `~/.config/kimi-desktop/`(Electron XDG 默认;官方是否有 Linux 桌面版未验证) |

无官方环境变量可覆盖该路径(KIMI_SHARE_DIR 属于独立 kimi-cli,不作用于桌面 daimon)。内部结构 `daimon-share/daimon/runtime/kimi-code` 无兼容承诺(与 dsh 格式 v0 同性质风险),发现逻辑需带漂移兜底(见 §2.2)。

### 1.2 文件形态与 schema(实测)

`wire.jsonl` 为追加式 JSONL 事件日志。实测事件类型:`config.update`、`tools.register_user_tool`、`tools.set_active_tools`、`permission.set_mode`、`metadata`、`turn.prompt`、`context.append_message`、`context.append_loop_event`、`llm.tools_snapshot`、`llm.request`、**`usage.record`**。

`usage.record` 实测样例(2026-08-24 本机两轮真实对话):

```jsonc
{ "type": "usage.record", "model": "k2d6-agent",
  "usage": { "inputOther": 6157, "output": 50, "inputCacheRead": 19200, "inputCacheCreation": 0 },
  "usageScope": "turn", "time": 1787540635599 }
{ "type": "usage.record", "model": "k2d6-agent",
  "usage": { "inputOther": 94, "output": 586, "inputCacheRead": 25344, "inputCacheCreation": 0 },
  "usageScope": "turn", "time": 1787540817071 }
```

`session_index.jsonl` 实测样例:

```jsonc
{ "sessionId": "conv-4502e7633ffb1de46c7caf71",
  "sessionDir": "/Users/sky/Library/Application Support/kimi-desktop/.../conv-4502e7633ffb1de46c7caf71",
  "workDir": "/Users/sky/Documents/kimi/workspace" }
```

### 1.3 token 口径:四项并列(非 OpenAI 语义)

与 WorkBuddy 不同,**kimi 直接给出互斥拆分字段,无需做减法**:

```
inputTokens    = usage.inputOther            // 未命中缓存的输入
outputTokens   = usage.output
cacheReadTokens  = usage.inputCacheRead
cacheWriteTokens = usage.inputCacheCreation
reasoningTokens = 0                          // kimi 不单独落盘,仅诊断字段缺省
totalTokens = input + output + cacheRead + cacheWrite   // 与产品排名规则一致
```

实测验证:第 1 轮 25407、第 2 轮 26024(cacheRead 19200→25344 随上下文增长,语义真实);标题生成会话用 `k3-agent`,亦为真实消耗。

### 1.4 去重、时间戳、模型名、scope 语义

- **去重维度**:一个 wire.jsonl 文件 = 一个会话的追加日志,文件级 fingerprint 缓存(与 openclaw/codex 同型);文件变化时整文件重解析并整体替换该 fingerprint 的事件集,追加 turn 不会双计。
- **时间戳**:`usage.record.time` 为 epoch 毫秒(实测),走 collector 统一本地时区管线换算 day/hour;缺失时回退文件 mtime。
- **模型名**:record 级 `model`,实测值 `k2d6-agent`、`k3-agent`(config.toml 另有 `k2p6-agent`)。真实模型名,非调度别名(优于 workbuddy 的 `auto`)。空则 `"unknown"`。
- **scope 语义(源码级定论,2026-08-24)**:从桌面版捆绑的 `@moonshot-ai/agent-core` bundle(Kimi.app `resources/daimon-bundle/.../agent-core/dist/index.mjs`)提取的写入逻辑:
  - `UsageRecorder.record(model, usage, scope)` 是唯一写入点;`afterStep` 回调(每次 LLM 调用完成后)以 `record(model, usage, "turn")` 落一条 `usage.record`——**一条记录 = 一次真实 LLM 调用(step)**,多步 turn 产生多条 turn 记录,**不存在"turn 汇总 + step 明细"的双计结构**。
  - `"session"` scope 仅出现在 `restoreAgentRecord`(wire 重放/重启恢复)中,只读不写,不会产生新事件。
  - 实测旁证:单步 turn 中 `step.end` 循环事件的 `usage` 与其后的 `usage.record` 数值完全一致;未登录重试 10 次的 turn 零 usage.record。
  - **采集口径:采集全部 `usage.record`(任何 scope),每条都是真实消耗,直接求和即总量。** "只采 turn" 的原始设计作废——若未来内核改为 turn 汇总+step 明细双写,scope 值会出现分化,届时需按 scope 去重(留告警观测,不预先过滤)。
- **失败请求无幻影数据**(实测):未登录期间一轮 401 重试 10 次的会话,10 个 `llm.request`、0 个 `usage.record`——失败请求不落 usage,天然无需特殊处理。
- **子代理(subagent)**:daimon 内核支持子代理"own context and wire file",即 `agents/<subagentId>/wire.jsonl`。当前本机只有 `agents/main`,但 matcher 不得写死 main(见 §2.2)。
- **多工作区**:`sessions/` 下可有多个 `wd_workspace_<hash>` 目录,walk 全覆盖。

### 1.5 覆盖边界(重要)

- **可覆盖**:桌面客户端 agent 模式会话(含 Kimi Work、后台标题生成 ctitle 会话)。
- **不可覆盖**:普通网页式 chat(含桌面客户端内的网页聊天)。实测聊过之后 IndexedDB(`https_www.kimi.ai_0.indexeddb.leveldb`,824KB)只存草稿/导航状态(`input_message`、`chat_enter_method` 等),token 字段零匹配;消息与用量仅存服务端。云端 API 路线本期不做(未验证有无 token 明细,参考 antigravity 教训)。

### 1.6 隐私边界(红线)

- wire.jsonl 含**完整对话明文**(prompt、回复、工具调用全文)。解析器只读取 `type == "usage.record"` 行的 `model`/`usage`/`usageScope`/`time` 四个字段,其余行仅做 type 判断即跳过,内容不进入任何内存结构之外的处理,绝不上传。
- `session_index.jsonl` 的 `workDir` 与 `sessionDir` 为真实绝对路径,只作为 `workdirCandidate` 进入本地 hash 管线,服务端只见 hash。
- 同目录 `config.toml` 含**明文 API key**(实测确认),永不在采集范围;`daimon/logs/` 遥测库、`~/.kimi-webbridge/` 均无 token 数据(实测),不采。

## 2. Provider 设计

### 2.1 标识

```rust
pub const PROVIDER_ID: &str = "kimi_local";
pub const TOOL_CODE: &str = "kimi";
pub const VERSION: &str = "0.1.0";
```

显示名 `Kimi`。事件 `sourceKind = "local_log"`、`sourceQuality = "exact"`。

### 2.2 路径发现

```rust
auto_roots(按序探测,存在即收):
  1. env KIMI_DESKTOP_DIR(本采集器自定义测试口,非官方;指向 .../kimi-code/home)
  2. <userData>/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home
     userData: macOS ~/Library/Application Support,Windows %APPDATA%,Linux ~/.config
manual_roots:
  config.provider_roots["kimi_local"]
```

`scan_sessions`:`walk_files(root, matcher, 5000)`,matcher 规则——文件名 == `wire.jsonl` 且路径含 `sessions` 段。不写死 `wd_workspace_*`/`agents/main`,覆盖多工作区与子代理文件;同时天然把 `session_index.jsonl`、config.toml、logs 排除在外。

**漂移兜底**:若 canonical 路径(§2.2.2)不存在而 `<userData>/kimi-desktop` 存在,退化为以 `<userData>/kimi-desktop` 为根做同 matcher walk(limit 20000),容忍内部目录改名(dsh v0 同类风险策略)。遵循 guide §2.1 固定逻辑(enabled=false → 空;ignored auto root 跳过;manual 去重追加)。

### 2.3 解析(try_parse_usage)

对单个 wire.jsonl 文件:

1. `read_json_lines` 读全部行(追加式文件,容忍尾部撕裂行);遍历仅处理 `type == "usage.record"` 的行。
2. scope 处理(源码定论,§1.4):采集全部 `usage.record`(当前唯一写入值是 `"turn"`,一条 = 一次 LLM 调用;`"session"` 只在重放路径出现,理论不落盘,遇到也直接采集——它语义是恢复的历史消耗,不构成双计)。观测口径:解析时统计 scope 值分布,出现 `"turn"`/`"session"` 之外的值时计入 provider 警告(内核升级信号)。
3. 字段读取(数字统一 `as_f64().round() as i64`,别名容错):
   - input:`inputOther` / `input` / `input_tokens`
   - output:`output` / `output_tokens`
   - cacheRead:`inputCacheRead` / `cache_read_tokens` / `cached_tokens`
   - cacheWrite:`inputCacheCreation` / `cache_write_tokens`
   - `total == 0` 跳过。
4. `model` 取 record 级,空则 `"unknown"`;`time` 为 epoch ms,解析 day/hour 走 `crate::date` 本地时区管线,缺失回退文件 mtime。
5. `sessionId`:从路径取会话目录名(`conv-*`/`ctitle-*`);若 `agents/<id>` 的 `id != main`,拼为 `<sessionId>/<agentId>` 区分子代理。
6. workdir 归属(provider 内、finalize 前填充 `workdirCandidate`):解析根下 `session_index.jsonl`(追加式,后行覆盖同行旧值),按 sessionId 取 `workDir`;索引缺失或无该条 → 留空(由 finalize_event 管线降级,不用 `current_dir()` 噪声兜底)。ctitle 会话同属触发它的工作区,自然归入。
7. 事件 JSON 按 guide §2.3 契约输出全部字段。

### 2.4 注册(3 处 Rust)

1. `collector-core/src/provider/mod.rs`: `pub mod kimi_local;`
2. `collector-core/src/scanner.rs`:
   - `scan_usage_with_source_cache` 加 kimi 块(OpenClaw 文件循环模式:fingerprint 缓存命中或 `try_parse_usage` → `finalize_event` → `source_index`;`Err` 进 `provider_errors`;`health.push(local_provider_health(...))`)。
   - `provider_health` 的 `vec![]` 追加 `local_provider_health` 项。
3. `atl-collector/src/sidecar.rs`: `TRAY_PROVIDER_NAMES` 加 `("kimi_local", "Kimi")`。

后端 `providerId` 开放字符串,**无后端改动**。

### 2.5 前端触点(9 处,照 guide §四)

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `src/desktop/index.html` | `#sources-tabs` 加 `<button data-provider-tab="kimi_local" data-i18n="source.kimi">` |
| 2 | `src/desktop/renderer.js` ×4 | `#add-kimi-root` click handler;`sourceIconPath`;`renderHealth` addBtn 分支;局部 `sourceName` |
| 3 | `src/desktop/renderer-data.js` | `sourceName` 加 `kimi_local` 分支 |
| 4 | `src/desktop/renderer-helpers.js` | `UI_PROVIDER_ORDER` 追加 `"kimi_local"` |
| 5 | `src/shared/chart-helpers.js` | `sourceName` 加映射 |
| 6 | `src/shared/i18n.js` | zh、en 各 2 key:`source.kimi` = `Kimi`;`desktop.sources.addKimi` = `添加 Kimi 位置` / `Add Kimi location` |
| 7 | `src/web/admin.js` | `providerDisplayNames` 加 `kimi_local: "Kimi"` |
| 8 | `src/web/data-value-demo-live.js` | `sourceNames` 加映射 |
| 9 | 桌面托盘 | sidecar.rs 已覆盖 |

图标:若无现成 `kimi` 图标资源,复用现有 provider 图标占位,不新增品牌素材(避免商标问题,与 workbuddy 同策略)。

### 2.6 样例数据(samples/kimi/)

**合成数据,绝不使用真实 wire.jsonl(含真实对话明文)**,目录结构镜像真实形态:

```
samples/kimi/home/
├── session_index.jsonl            # 3 条映射(含 1 条孤儿会话无映射)
└── sessions/wd_workspace_demo/
    ├── conv-aaa111/agents/main/wire.jsonl   # 2 个 turn 记录:cacheRead 增长、k2d6-agent
    ├── conv-bbb222/agents/main/wire.jsonl   # k3-agent 记录 + 1 条 total=0(跳过)+ 1 条缺 time(走 mtime)
    ├── ctitle-ccc333/agents/main/wire.jsonl # 标题生成开销(采集)+ 孤儿(索引无映射)
    └── conv-ddd444/agents/sub1/wire.jsonl   # 子代理 wire 文件(sessionId 拼后缀)
    └── conv-eee555/agents/main/wire.jsonl   # 1 条 usageScope="session"(重放语义,仍采集)+ 尾部撕裂行(容错)
```

时间戳取 UTC 正午毫秒(如 `1787540400000` 对应 2026-08-20T12:00:00Z 前后,按生成时换算)保证时区稳定断言。纯 JSONL,**不受 `*.db` gitignore 影响,直接入库**。

### 2.7 验证器(scripts/verify-ccusage.mjs)

新增 `expectedKimi()`:纯 Node 重算 `<userData>/kimi-desktop/.../sessions/**/wire.jsonl`(与 Rust 解析同口径:usage.record → scope 过滤 → 四项并列 → 按日聚合),与 collector scan 输出逐日对总。注册 5 处:`byProvider` map、parse 过滤、whitelist、dispatch、默认 provider 集合(与 openclaw/workbuddy 同性质,加默认)。本机已有真实数据(2026-08-24 起累计,首轮 51431 tokens),立即有对账效力;后续随真实使用自然增长。

## 3. 明确不做的事(本期边界)

1. **普通 chat 不采集**:本地无数据(§1.5 实测),云端 API 路线未验证 token 明细,不做。
2. **独立 kimi-cli(`~/.kimi`)不采集**:用户明确叫停该路线;且桌面版内嵌内核数据已覆盖同一产品的桌面使用。
3. **Windows/Linux 路径不阻塞**:按 Electron userData 推测实现 + 编译期无平台分支,真机验证留待 Windows 主机可用时(与 0.7 Windows coverage 现状一致)。
4. **模型价格不做**:k2d6-agent/k3-agent 不在 OpenRouter 价格表,`costQuality = "unknown_price"`,成本是可选展示不影响排名;未来价格表扩展另行任务。
5. **config.toml / 遥测 sqlite / webbridge 不读**(隐私红线,§1.6)。
6. **MITM 抓包不做**(同 workbuddy 决策)。

## 4. 测试矩阵

1. **Rust 单测**(provider 文件内,guide §六.1):常量;样例解析条数;四项并列数学不变量(total == 四项和);`usageScope="session"` 仍采集;多 step turn(多条 turn 记录)直接求和;total=0 跳过;ctitle 采集;子代理 sessionId 后缀;workdir 映射 + 孤儿留空;缺 time 走 mtime;尾部撕裂行容错;不存在路径;manual root 扫描;禁用开关;`KIMI_DESKTOP_DIR` 覆盖;canonical 缺失时的漂移兜底 walk。断言"包含样例路径"而非精确数量(防真实 `~/Library/Application Support/kimi-desktop` 污染)。
2. **集成测试**(`collector-core/tests/integration_scan.rs`):`init_config` 注册样例根 + `scenario_kimi_scan`(总额精确断言、`workdirHash` 非真实路径、无 provider_errors、health 含 kimi_local)。
3. **前端单测**:`tests/renderer/` 的 `chart-helpers` 与 `renderer-data` 的 `sourceName` 断言各加一行。
4. **E2E**:`tests/e2e/mock-tauri.js` mockHealth 加条目;`tests/e2e/workflows.spec.js` 加 tab 用例(tab 可见 → 点击 → 卡片渲染 → 来源行可见,含 zh-CN/en)。
5. **真库对账**(guide §七):隔离 HOME + 符号链接真实 kimi-desktop 会话目录,编译产物实际扫描 vs Node 重算,逐日分毫不差;以对账时点数据为准。

## 5. 验证门禁(完成定义)

```bash
cargo test --workspace        # 含新 provider 单测 + 集成场景
npm test
npm run test:ui
npm run test:e2e
node --check src/desktop/renderer.js
npm run verify:ccusage        # 含 kimi 真库对账
git diff --check
```

桌面端 `npm run desktop` 目检:来源页 Kimi tab/卡片/开关/扫描数据。不打安装包(纯 provider + 前端触点,无打包面变更;如需发版走正常 release 流程)。

## 6. 任务分解

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| 0.7-T76 | Rust provider + 注册 + 样例 + 单测/集成测试 | — | §2.1–2.4、§2.6、§4.1–4.2;`cargo test --workspace` 通过 |
| 0.7-T77 | 前端 9 触点 + i18n + 前端单测 + E2E | —(与 T76 并行) | §2.5、§4.3–4.4;`test:ui`、`test:e2e`、`node --check` 通过 |
| 0.7-T78 | 验证器 + 文档(AGENTS.md 表、baseline/tasks 补账)+ 全量门禁 | T76, T77 | §2.7、§5 全部通过;文档同步 |

## 7. 遗留风险

- **格式无兼容承诺**:daimon 内嵌内核版本随客户端升级变化(字段别名容错 + 漂移兜底 walk 已缓解,升级后首轮 scan 需人工核对对账)。
- **Windows 路径未实测**:%APPDATA% 推测,Windows 真机验证后如有出入仅改 §2.2 一个常量。
- **多步 turn 语义已由源码定论**(§1.4):`usage.record` 每次真实 LLM 调用一条,无双计结构;"step scope 未验证"的原风险项撤销。残余观测点:内核升级后 scope 值若分化(汇总+明细双写),按 scope 去重的逻辑需跟上——通过 scope 分布告警发现。
