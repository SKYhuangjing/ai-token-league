# dsh_local Provider 设计文档

状态:已定稿(2026-08-22,基于源码调研 + 本机真实会话实测)。
遵循 `doc/provider-integration-guide.md`(0.7.11 版,含下载页触点)。本文只写 dsh 特有的事实与决策,通用流程照 guide 执行。

## 1. 调研结论(数据源事实)

DeepSeek Harness(产品名 `dsh`,github.com/deepseek-ai/deepseek-harness)是 DeepSeek 官方开源 Agent Harness,与本产品已支持的 Codex/Claude Code 同类。官方 app 默认把每次 LLM 调用的完整 token 记账落盘在本地会话日志,纯本地扫描即可采集,不碰任何云 API。

### 1.1 数据落在哪

- 默认 root:`$DSH_HOME/sessions`(`DSH_HOME` 环境变量优先),未设置时 `~/.dsh/sessions`。
- 布局:`<root>/<项目目录>--/<会话ID>/session.jsonl.zstd`(默认)或 `session.jsonl`(用户把 persistenceCompression 改为 `none` 时)。
- 项目目录名是 cwd 有损规范化,**不能**用来反推路径;原始 `cwd` 在文件第一行 header 里。
- 官方 app 的 SQLite 查询索引默认 `:memory:` 且不开启,不是 durable 源,忽略。

### 1.2 文件形态(实测)

`.jsonl.zstd` 是**多个独立 zstd 帧拼接**(第一帧只含 header 行,之后每个落盘批次一帧,均带 checksum)。逻辑行:

- 第 1 行 header:`{"type":"session","version":0,"id":"session-<uuid>","createdAt":<epoch-ms>,"cwd":"<绝对路径>","delegationDepth":0,...}`
- 之后每行一个事件:`{"type","seq","time":<epoch-ms>,"data",...}`,seq 在文件内连续。

采集相关的事件类型(其余类型全部忽略):

| 事件 | 采集价值 |
| --- | --- |
| `assistant/message` | **一次 LLM 调用**:`data.message.source={kind:"model",provider,model}` + `data.usage`。`interrupted:true` 的前缀 finalize 也可能带 usage,照常计入 |
| `compaction/summary` | 压缩摘要也是真实模型调用:`data.provider`、`data.model`、`data.usage`,计入 |
| `session/end-seed` | fork/resume 的 seed 边界(见 1.5 去重) |

实测量子(2026-08-22 本机会话,2 轮对话):2 条 `assistant/message`,provider=zai-coding-cn model=glm-5.3,input=9,543 output=274 cacheRead=21,568 → **totalTokens=31,385**。

`data.usage`(即 dsh 的 `TokenUsage`):

```json
{ "inputTokens": 9423, "outputTokens": 144, "cacheReadTokens": 6080, "cacheWriteTokens": 0, "reasoningTokens": 0 }
```

注意:解压后的行里混有无斜杠标签的 packed chunk 行(`text-chunks`/`reasoning-chunks`/`tool-call-chunks`),是流式 chunk 的合并存储;按 type 精确匹配事件名即天然忽略。

### 1.3 token 口径:Anthropic 语义(实测验证)

dsh 的字段是**互斥计数**:`inputTokens` 不含缓存命中,缓存单列 cacheRead/cacheWrite(DeepSeek adapter 已把 provider 折叠的 prompt_tokens 拆开)。因此**直接映射,无需拆分**:

```text
inputTokens→inputTokens, outputTokens→outputTokens,
cacheReadTokens→cacheReadTokens, cacheWriteTokens→cacheWriteTokens,
reasoningTokens→reasoningTokens(仅诊断),
totalTokens = input + output + cacheRead + cacheWrite
```

### 1.4 zstd 多帧解压(关键坑,实测踩过)

**Node 的流式 zstd 解压到第一帧就停,不自动跨拼接帧;Rust `zstd` crate 流式 API 的多帧行为同样不可依赖。** dsh 自己的读法(`packages/session/session-persistence-jsonl/src/zstd.ts::scanZstdFrames`):纯字节级结构扫描(magic `0xFD2FB528` LE → frame header descriptor → 逐 block 3 字节头 → 可选 4 字节 checksum)得到每帧的 `[start,end)` 区间,**再逐帧独立解压**。尾部可能有崩溃残留的撕裂帧:扫描器在字节不足时返回"不完整",直接跳过即可。

Rust 侧照搬:移植 `scanZstdFrames`(~60 行,纯字节解析,附参考实现见 `/tmp/dsh-scan.mjs` 与 dsh 源码),解压用 **`ruzstd`**(纯 Rust、只解压、无 C 工具链负担,当前依赖树无任何 zstd crate,ruzstd 是最小增量)。帧级 API:`FrameDecoder` 逐帧 `decode_all`,不依赖 decoder 的多帧流行为。

### 1.5 去重:fork seed 边界(必做,否则双计)

fork/resume 子会话会把父会话历史事件**物理复制**进子文件,并用 `session/end-seed` 事件标记边界(seed 部分已在父文件统计过)。规则:**统计时跳过该文件内最后一个 `session/end-seed`(按 seq 最大)及之前的所有事件**;无该事件则全量统计。文件内 `seq` 唯一,同文件天然无重复;跨文件靠 seed 边界去重。

### 1.6 其他事实

- 格式版本 `SESSION_FORMAT_VERSION = 0`,官方明示 pre-release 不承诺兼容:**按 header.version 门控**,非 0 的文件返回 Err(进 provider_errors),绝不猜格式。
- 标题生成 LLM 调用(`session/title-llm-request`)不带 usage,统计不到(≤64 output token,量级可忽略,接受)。
- dsh 要求 Node ≥22.19/24(与采集端无关,采集端是 Rust)。
- 多 provider 路由:per-message 记录 provider/model(实测自定义 provider zai-coding-cn 正确归属)。

### 1.7 隐私边界(红线)

只读 header 元数据 + `assistant/message`/`compaction/summary` 的 usage 与 source 字段。**绝不采集** `content` blocks、chunk 文本、`user/message`、工具调用参数、转录内容。header `cwd` 只作为 `workdirCandidate` 进入本地 hash 管线,不上传。

## 2. Provider 设计

### 2.1 标识

```rust
PROVIDER_ID = "dsh_local";
TOOL_CODE   = "dsh";
VERSION     = "0.1.0";
```

显示名:DeepSeek Harness(zh/en 同名)。下载页 chip 文案:`DeepSeek Harness`。

### 2.2 路径发现

- auto root:`std::env::var("DSH_HOME")` 非空时 `$DSH_HOME/sessions`,否则 `~/.dsh/sessions`(照 `dirs::home_dir()`,与其余 provider 的 auto_roots 写法一致)。
- manual root:`config.providerRoots["dsh_local"]`(guide 通用逻辑)。
- `scan_sessions`:walkdir 各 root,收集文件名恰好为 `session.jsonl.zstd` 或 `session.jsonl` 的文件绝对路径。禁用开关、ignored_auto_sources、去重照 guide §2.1 固定逻辑。

### 2.3 解析(try_parse_usage)

```
读文件字节
 ├─ 后缀 .zstd → scan_zstd_frames(移植) → 逐帧 ruzstd 解压 → 拼接为行缓冲(撕裂尾帧跳过)
 └─ 后缀 .jsonl → 直接按行读
第 1 行必须是 type=="session" 的 header:
   version != 0 → Err("unsupported dsh session format version: N")
   记 id / cwd / createdAt;无 cwd 时 workdirCandidate 用文件路径兜底
扫描全部事件行,记录 max(seq of "session/end-seed") = seed_seq(无则 -1)
对 seq > seed_seq 的事件:
   assistant/message 且 data.usage 存在 → 计
   compaction/summary 且 data.usage 存在 → 计
   每条映射为一个 usage 事件(字段见下),total==0 的跳过
```

事件 JSON 契约(guide §2.3 全字段),dsh 取值:

| 字段 | 取值 |
| --- | --- |
| `providerId` / `providerVersion` / `toolCode` | `dsh_local` / `0.1.0` / `dsh` |
| `sourceKind` / `sourceQuality` | `local_logs` / `exact` |
| `sessionId` | header.id(如 `session-183dbf1d-…`) |
| `day` / `hour` | `local_day/hour_from_timestamp_ms(event.time)`(epoch 毫秒) |
| `workdirCandidate` | header.cwd;缺失用文件父目录 |
| `model` | `data.message.source.model`(assistant)或 `data.model`(compaction);空则 `"unknown"` |
| 五个 token 字段 | 1.3 直接映射,缺省 0 |
| `totalTokens` | 四项之和 |
| `rawSourceRef` / `sourceFingerprint` / `parserVersion` | `common.rs::source_metadata()`(zstd 追加写会变 size/mtime,指纹失效机制天然成立) |

错误处理:帧 magic 损坏、解压失败、header 缺失/非法 JSON → 该文件 `Err`(进 provider_errors,不静默);单个事件行 JSON 解析失败 → 跳过该行(dsh 官方 `ignorable` 语义,chunk 行非 JSON 对象的情况安全跳过)。

model 去重维度:同一文件的 assistant/compaction 事件 model 各自独立,无需跨事件合并。

### 2.4 依赖与注册(3 处 Rust)

1. `collector-core/Cargo.toml` 加 `ruzstd = "0.7"`(workspace 外直依赖,与 `local-ip-address` 同款写法)。
2. `provider/mod.rs` — `pub mod dsh_local;`
3. `scanner.rs` — `scan_usage_with_source_cache` 仿 workbuddy/zcode 块 + `provider_health` 加条目。
4. `atl-collector/src/sidecar.rs` — `TRAY_PROVIDER_NAMES` 加 `("dsh_local", "DeepSeek Harness")`。

### 2.5 前端触点(照 guide §四,9 处)

| 触点 | dsh 取值 |
| --- | --- |
| renderer.js `PROVIDER_ADD_ROOT_LABEL_KEYS` | `dsh_local → desktop.sources.addDsh` |
| renderer.js `sourceIconPath` / 局部 `sourceName` | 照现有模式(无专属 icon 时用既有占位) |
| renderer-data.js / chart-helpers.js `sourceName` | `dsh_local → "DeepSeek Harness"` |
| renderer-helpers.js `UI_PROVIDER_ORDER` | 末尾追加 `"dsh_local"` |
| i18n.js(zh/en 各 3 key) | `source.dsh`="DeepSeek Harness";`desktop.sources.addDsh`(zh:"添加 DeepSeek Harness 位置" / en:"Add DeepSeek Harness location");`web.home.sourceDshNote`(zh:"本地 DeepSeek Harness 会话日志(zstd JSONL)" / en:"Local DeepSeek Harness session logs (zstd JSONL)") |
| admin.js `providerDisplayNames` | `"dsh_local": "DeepSeek Harness"` |
| data-value-demo-live.js `sourceNames` | 同上 |
| download.html `#supported-sources` | `<li data-i18n-title="web.home.sourceDshNote">DeepSeek Harness</li>` |

### 2.6 样例数据(samples/dsh/)

`.gitignore` 不挡 `.jsonl`/`.zstd`,两份都入库:

- `samples/dsh/raw/session.jsonl` — 未压缩,覆盖:header(version 0)、正常 assistant/message×3(含 cache 非零行)、compaction/summary×1、零 usage 行、`interrupted:true` 带 usage 行、`session/end-seed` fork 场景(seed 内 1 条 + seed 外 2 条,断言只计 seed 外)、packed chunk 行(`text-chunks` 标签)、time 为 **UTC 正午**。
- `samples/dsh/zstd/session.jsonl.zstd` — 同样内容按 dsh 真实格式分帧压缩(header 独立帧 + 每事件一帧)。生成方式:用 Node ≥22.19/24 `zlib.zstdCompressSync` 逐帧压缩后拼接(参考 `/tmp/dsh-scan.mjs` 的逆向),生成脚本落 `samples/dsh/generate.mjs` 并在 `samples/dsh/README.md` 说明。
- `samples/dsh/bad/version-1.jsonl`(手写,header version:1)→ 断言 Err。

### 2.7 验证器(scripts/verify-dsh.mjs)

dsh 无 ccusage 类外部对账工具,仿 `verify-ccusage.mjs` 新增 `npm run verify:dsh`:

- 扫 `$DSH_HOME/sessions`(缺省 `~/.dsh/sessions`),用与采集端相同的帧扫描+逐帧解压逻辑(直接移植 `/tmp/dsh-scan.mjs`,要求 Node ≥22.19/24,启动时检查 `zlib.zstdDecompressSync` 存在,否则提示切 Node)。
- 按 day+model 聚合,与 `atl-collector scan`(隔离 HOME + symlink 真实 sessions 目录)的 dsh_local 汇总对总,分毫不差才通过。
- 本机已知基准(2026-08-22):≥31,385 tokens、含 glm-5.3 模型行(会话仍在增长,对账比总数不比快照)。

## 3. 明确不做的事(本期边界)

- 不采集标题生成调用的 usage(数据不可得,量级可忽略)。
- 不接 dsh 云端/平台任何 API;不解析 profile patch 里自定义 persistence root(用户自定义 root 走 manual roots 手动添加)。
- 不做 credits、成本估算扩展。
- 不修改 dsh 本体或其配置。

## 4. 测试矩阵

1. **provider 单测**(dsh_local.rs 内 ≥12 项):常量;raw 样例解析条数与总额;zstd 样例与 raw 解析结果一致;token 四项直接映射数学;end-seed 去重(seed 外才计);compaction/summary 计入;零 usage 行跳过;interrupted 行计入;packed chunk 行忽略;version!=0 报 Err;header 缺失报 Err;坏 magic 报 Err;撕裂尾帧跳过(截断 zstd 样例后半段);manual root 扫描;禁用开关返回空。
2. **集成测试**(collector-core/tests/integration_scan.rs):注册 `samples/dsh/zstd` 为 manual root → 条数、总额精确断言;`workdirHash != 真实路径`;无 provider_errors;health 含 dsh_local。
3. **前端单测**:chart-helpers `sourceName` 加断言;renderer-helpers `UI_PROVIDER_ORDER` 含 dsh_local;renderer-data `sourceName` 断言。
4. **E2E**:mock-tauri.js `mockHealth` 加 dsh_local 条目;workflows.spec.js 加 `[data-provider-nav="dsh_local"]` 导航用例;现有 `>=` 计数断言不破坏。
5. **真库对账**:`npm run verify:dsh`(本机真实 `~/.dsh/sessions`)。

## 5. 验证门禁(完成定义)

```bash
cargo test --workspace
npm test
npm run test:ui     # 已知 groupTrend weekly 日期敏感失败为存量问题,不追
npm run test:e2e
node --check src/desktop/renderer.js
npm run verify:dsh  # 本机真实库对账
```

全部通过 + 桌面端 `npm run desktop` 目检来源页出现 DeepSeek Harness 导航/卡片/扫描数据 + download 页 chip 中英 tooltip 目检。

## 6. 任务分解

| 任务 | 内容 | 验证 |
| --- | --- | --- |
| T71 Rust provider | ruzstd 依赖、dsh_local.rs(帧扫描/解析/去重/门控)、mod.rs、scanner.rs×2、sidecar.rs、samples/dsh、单测+集成测试 | cargo test --workspace |
| T72 对账验证器 | scripts/verify-dsh.mjs + package.json `verify:dsh` + 隔离 HOME 真库对账 | npm run verify:dsh |
| T73 前端+E2E+文档 | guide §四 9 触点、chart/renderer 单测、e2e mock+导航用例、download chip;AGENTS.md provider 表加行;README/README.en 来源清单(对照 workbuddy 的触点 grep 结果对齐);doc/0.7-baseline.md 加 Temporary/Opportunistic 条目;doc/0.7-development-tasks.md 加 T71–T73 任务行 | 全门禁 + 目检 |

发布:全部完成后按 0.7.12 走 release 流程(另行执行,不在本设计范围)。

## 附录:scanZstdFrames 参考实现(实测验证过的 JS 版,Rust 照此移植)

```js
// 直接移植自 dsh zstd.ts scanZstdFrames(纯字节结构扫描,不解压)
const ZSTD_MAGIC = 0xFD2FB528
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset); offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error('reserved frame-header bit')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('reserved block type')
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}
// 用法:对每个 frame 区间独立解压(zstd crate/ruzstd 均为单帧 API 语义),
// 拼接解压结果后按行 JSON.parse。tornStart 存在时其后的字节直接丢弃。
```
