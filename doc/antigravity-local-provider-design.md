# antigravity_local Provider 设计文档

状态:DONE(0.7 临时/机会性纳入,常驻 provider)
调研与实现证据:2026-10-12 本机真实数据实测 + ccusage 20.0.30 逐桶对账。

## 1. 调研结论(数据源事实)

### 1.1 数据落在哪

Antigravity(Google Gemini 系 agent 工具,含 IDE/CLI/ACP 形态)把每个会话(cascade)存为一个 SQLite 数据库:

```text
~/.gemini/antigravity/conversations/<cascade-uuid>.db
~/.gemini/antigravity-cli/conversations/<cascade-uuid>.db
~/.gemini/antigravity-ide/conversations/<cascade-uuid>.db
~/.gemini/antigravity-backup/conversations/<cascade-uuid>.db
~/.gemini/antigravity-acp/conversations/<cascade-uuid>.db
~/.config/antigravity/conversations/<cascade-uuid>.db
```

根目录 `~/.gemini/antigravity/` 下另有 `conversation_summaries.db`(摘要库,不含 token 用量)——只扫 `conversations/` 子目录,天然排除。六个默认根与 ccusage 口径一致;自定义位置走 `roots add`(manual root 既可以是包含 `conversations/` 的数据根,也可以直接是 conversations 目录本身)。

### 1.2 文件形态与 schema(实测)

每库核心表:

```sql
gen_metadata (idx integer, data blob, size integer, PRIMARY KEY(idx))  -- 必需表
steps (idx, step_type, status, ..., metadata blob, ...)                 -- 可选表
trajectory_metadata_blob (id text, data blob)                           -- 可选表,时间戳回退
```

`data`/`metadata` 是 **protobuf 二进制**(无官方 .proto,逆向字段)。字段映射(自 ccusage MIT 实现 `rust/adapters/antigravity`,并经本机裸解码 + Python 独立复现对账验证):

- `gen_metadata.data`:根字段 1 = chat model 消息;chat model 内:
  - 字段 3 = model_id(varint);字段 19/21 = 模型名文本(优先 19)
  - 字段 4 = ModelUsage;字段 17(重复)= RetryInfo(内字段 2 = ModelUsage)
  - 字段 9 = generation info(内字段 4 = Timestamp 消息)
- `steps.metadata`:字段 9 = ModelUsage;字段 28(重复)= retry;字段 24 = ModelInfo(字段 12/8 模型名、字段 1 model_id);字段 8 或 1 = Timestamp 消息
- `trajectory_metadata_blob.data`:字段 2 = Timestamp 消息、**字段 7 = 工作区根 URI(`file:///abs/path`,字段 1 的子消息 1/2 为其镜像)**(0.2.0 起用于 workdir 归属)
- ModelUsage:1=model_id、**2=input、3=total_output、4=cache写、5=cache读**、7=message_id、9=reasoning、10=visible_output、11=response_id、12=provider_assigned_message_id
- Timestamp 消息:1=秒(>0 才有效)、2=纳秒

### 1.3 token 口径

Gemini 语义,四桶并列互不重叠(无 OpenAI 式 cache 包含在 input 里的拆分):

```text
output = max(visible_output, total_output − reasoning)
totalTokens = input + output + cacheRead + cacheWrite   (ATL 口径,reasoning 仅诊断)
```

### 1.4 去重、时间戳、模型名

- **去重(文件内)**:同一条逻辑请求会以 success/retry/source 副本多行出现。身份键 = `response_id` / `provider_assigned_message_id` / `message_id`(共享任一键即合并),合并语义为逐桶取 max(等价于 ccusage 的顺序传递合并;本机实测单文件 276 条原始事件 → 92 组,与 ccusage 逐桶完全一致)。
- **跨根同名去重**:`antigravity-backup` 根存整库拷贝,文件名即 cascade UUID。`scan_sessions` 按文件茎去重:优先非 backup 根,再比 (size, mtime) 取最新。这是对 ccusage 全局消息级去重的务实近似——整库拷贝是现实场景,跨不同会话的消息 ID 撞车不是。
- **时间戳回退链**:行内时间戳(gen 9.4 / steps 8或1)→ 身份键已见时间戳 → `trajectory_metadata_blob` → 文件 mtime。
- **模型名**:usage.model_id 优先于上下文模型;生成行无模型时继承最近观测到的生成模型(continuation 语义);steps 回退到最后一个带模型的生成行。`model_placeholder_mXXX` 内部别名与 "gemini 3.8 flash (high)" 展示名经别名表归一(表移植自 ccusage,未知模型原样透传)。
- 0 页空库(Antigravity 预创建)返回空而非报错;缺 `gen_metadata` 表或 protobuf 损坏 = Err(refuse-to-persist,绝不静默产出空报表)。

### 1.5 覆盖边界

- **workdir 归属(0.2.0)**:`trajectory_metadata_blob` 字段 7 的 `file://` URI 剥前缀 + 百分号解码后作为 `workdirCandidate`(真实路径,走与 codex/claude 相同的本地哈希/公开名管线;非 `file://` 或缺字段 → `virtual:antigravity:Antigravity` 兜底)。本机实测 18 个有量的库中 14 个带该字段;注意 blob 里还混有工具日志路径(read_file/SearchPath/step_payload 内容),不可用"扫到路径就用"的启发式,只认结构化字段 7。sessionId = 文件茎(cascade UUID)。
- protobuf 为逆向格式,无 schema 承诺;上游改字段号会以解析错误显式暴露。
- Windows/Linux 路径行为文档级确认(`~/.config` 于 Windows 的展开),本机仅 macOS 实测。

### 1.6 隐私边界(红线)

库内含对话内容 blob;只读 `gen_metadata`/`steps` 的 token 与模型字段,trajectory blob 只取时间戳与工作区 URI,内容一律不触碰。上传侧走既有 `public_usage_item` 剥离(`workdirCandidate` 在 `finalize_event` 即转为哈希/公开名并删除),无新增字段。

## 2. Provider 设计

### 2.1 标识

`PROVIDER_ID = "antigravity_local"`,`TOOL_CODE = "antigravity"`,`VERSION = "0.2.0"`(0.2.0 = 增 trajectory 字段 7 工作区归属),默认启用(`*_local` 惯例 opt-out)。

### 2.2 路径发现

`auto_roots` = 六个默认根(存在才返回);`scan_sessions` 对每个根解析 `conversations/` 子目录,`walk_files` 收 `.db`(上限 5000/根),按文件茎跨根去重(§1.4)。

### 2.3 解析(try_parse_usage)

只读打开(`SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`,照 zcode 惯例避免干扰在写 WAL 的活跃库)→ 0 页跳过 → 读 gen_metadata(必需)+ steps + trajectory(可选)→ 手写 protobuf wire-format 解码(varint/length-delimited,解析失败即 Err)→ 先 steps 后 generations 产事件(模型继承链与 ccusage 一致)→ 身份键并查集 max 合并 → 输出事件(providerId/toolCode/sourceKind="local_db"/sourceQuality="exact"/sessionId/day/hour/model/五桶/rawSourceRef/sourceFingerprint/parserVersion)。

### 2.4 注册(4 处 Rust)

`provider/mod.rs`、`scanner.rs` 扫描块 + `provider_health()`×2、`sidecar.rs` `TRAY_PROVIDER_NAMES`。

### 2.5 前端触点(9 处,照 guide §四)

i18n 3 key × zh/en、chart-helpers(专属色 #5f7a8c 系 + sourceName)、renderer ×3(加根按钮 label、图标 folder-code.svg、本地 sourceName)、renderer-data、renderer-helpers(UI_PROVIDER_ORDER 末尾)、admin.js、data-value-demo-live.js、download.html chip。

### 2.6 样例数据(合成 fixture)

仓库 gitignore `*.db`;单测/集成测试用测试内 protobuf 编码器现场构造 blob + rusqlite 建临时库(真实形状正确性由验证门对真实数据对账兜底)。

### 2.7 验证器(scripts/verify-ccusage.mjs)

`expectedAntigravity()`:ccusage 版本门 ≥20.0.30(`ccusage antigravity` 子命令引入版本),`ccusage antigravity daily --json --timezone <tz> --offline`;期望侧按 ATL 口径重组(input+output+cacheRead+cacheCreation,**不用** ccusage 的 totalTokens——它含 reasoning)。已加入默认 provider 集合。

## 3. 明确不做的事(本期边界)

- 不做跨会话消息级全局去重(整库同名去重已覆盖 backup 拷贝场景)。
- 不做 cost/pricing(provider 字段仅解析层保留语义,已裁剪)。
- 不读 `conversation_summaries.db`、battle_mode_infos、executor_metadata 等无关表。
- 不支持 `ANTIGRAVITY_DATA_DIR` 环境变量(ccusage 侧概念;自定义位置走 `roots add`)。

## 4. 测试矩阵

- Provider 单测 15 项:常量、token 数学(visible/reasoning 拆分 + 模型名归一)、总输出拆分、retry/身份键去重、跨表身份合并、steps 模型与时间戳、模型继承、时间戳回退(trajectory/mtime)、零 token 跳过、缺表 Err、损坏 blob Err、0 页空库 Ok、backup 同名去重 + 手工根、禁用、不存在库。
- Integration:`scenario_antigravity_scan`(合成库精确总数 2030、双模型、无 provider_errors、health 含 id)。
- 真实数据对账:`verify:ccusage -- --provider=antigravity` 完成日逐日精确匹配。

## 5. 验证门禁(完成定义)

`cargo test --workspace`、`npm test`、`npm run test:ui`、`npm run test:e2e`、`node --check src/desktop/renderer.js`、`npm run verify:ccusage`(含 antigravity,需全局 ccusage ≥20.0.30)。
