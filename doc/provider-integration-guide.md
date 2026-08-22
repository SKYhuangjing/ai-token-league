# 新 Provider 接入指南

本指南基于 0.7.9 版本 `zcode_local` provider 的实际接入过程整理，适用于为新的本地 AI 编码工具（或云 API）接入用量采集。按阶段顺序执行，最后附完整核对清单。

**参考实现**（按推荐度排序）：

- `collector-core/src/provider/zcode_local.rs` — SQLite 表驱动、请求粒度、重试去重、OpenAI token 口径拆分（最完整）
- `collector-core/src/provider/hermes_local.rs` — SQLite JSON 列
- `collector-core/src/provider/mimocode_local.rs` — SQLite + json_extract
- `collector-core/src/provider/openclaw_local.rs` — JSONL 日志

## 一、数据源调研（动工前必须完成）

先用真实环境回答以下问题，全部有答案再写代码：

1. **数据落在哪**：本地路径（macOS/Linux/Windows 三平台路径是否一致）、文件形态（SQLite / JSONL / JSON）。SQLite 注意是否 WAL 模式。
2. **token 字段是否齐全**：需要 input / output / cacheRead / cacheWrite / reasoning 五类；缺 cache 类可以置 0，缺 input/output 则不适合接入。
3. **token 口径是 OpenAI 还是 Anthropic 语义**：
   - OpenAI 语义：`input_tokens` **已包含** cache 命中部分（`computed_total = input + output`）。
   - Anthropic 语义：`input_tokens` 与 cache read/write 是**并列**的三项（total = input + output + cacheRead + cacheWrite）。
   - 验证方法：对同一行数据检查 `input >= cache_read + cache_write` 是否恒成立，并和工具自身记录的 total 对账。
4. **去重维度**：是否存在一次逻辑请求多条记录（重试 attempt、父子请求）？确定"一次逻辑用量只计一次"的规则。
5. **时间戳单位**：毫秒还是秒还是 RFC3339 字符串（实测 `datetime(ts/1000,'unixepoch')` 校验）。
6. **workdir 归属**：会话表有没有工作目录字段？孤儿记录（session 缺失）如何降级。
7. **隐私边界**：只读用量/会话元数据表，**绝不采集** message/转录/提示词类数据（如 ZCode 的 `message`、`part` 表和 `rollout/*.jsonl`）。真实绝对路径只允许作为 `workdirCandidate` 进入本地 hash 管线，不上传。

调研产出建议：一份简短的调研记录（表结构、口径结论、对账数字），作为后续验收依据。

## 二、实现 provider（collector-core）

新建 `collector-core/src/provider/<name>_local.rs`，`PROVIDER_ID = "<name>_local"`，`TOOL_CODE = "<name>"`，`VERSION = "0.1.0"`。

### 2.1 结构模板

所有 provider 采用同一套鸭子类型方法（无 trait），照抄 `zcode_local.rs`：

```rust
pub struct ZCodeLocalProvider;

impl ZCodeLocalProvider {
    pub fn id(&self) -> &str;            // PROVIDER_ID
    pub fn tool_code(&self) -> &str;     // TOOL_CODE
    pub fn version(&self) -> &str;       // VERSION
    pub fn auto_roots(&self, config) -> Vec<String>;    // 默认发现根目录（通常 ~/.<tool>）
    pub fn manual_roots(&self, config) -> Vec<String>;  // config.providerRoots[PROVIDER_ID]
    pub fn roots(&self, config) -> Vec<String>;         // auto + manual 去重合并
    pub fn scan_sessions(&self, config) -> Vec<String>; // 返回数据文件绝对路径列表
    pub fn parse_usage(&self, path) -> Vec<Value>;      // 失败返回空
    pub fn try_parse_usage(&self, path) -> Result<Vec<Value>, String>; // 真正实现
}
```

`scan_sessions` 固定逻辑：`provider_enabled[PROVIDER_ID] == Some(&false)` 时返回空；auto 根被 `provider_ignored_auto_sources` 命中时跳过；manual 根去重后追加。

### 2.2 SQLite 注意事项

- **只读打开**活库（尤其 WAL 模式）：`Connection::open_with_flags(path, SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX)`。读写句柄在关闭时可能触发 WAL checkpoint，污染他人数据库。
- WAL 库的缓存指纹 `common.rs::source_metadata` 已原生支持（含 `-wal` 边车 mtime/size），无需额外处理。
- 表不存在等结构错误必须走 `Err` 上报（进入 `provider_errors`），不要静默吞掉。

### 2.3 事件 JSON 契约

`try_parse_usage` 输出的每条事件字段（缺一不可，后端 `src/shared/schema.js::assertUsageItem` 校验）：

| 字段 | 说明 |
| --- | --- |
| `providerId` / `providerVersion` / `toolCode` | 常量 |
| `sourceKind` / `sourceQuality` | 本地库用 `"local_db"` / `"exact"`；日志解析用 `"local_logs"` |
| `sessionId` | 来源会话标识；缺失时用 `<tool>-<ts>` 兜底 |
| `day` / `hour` | `crate::date::local_day_from_timestamp_ms` / `local_hour_from_timestamp_ms` |
| `workdirCandidate` | 真实路径或 cwd 兜底（管线会 hash，服务端只见 hash） |
| `model` | 模型名，空则 `"unknown"` |
| `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` | 拆分后的值 |
| `totalTokens` | = input + output + cacheRead + cacheWrite（见下） |
| `rawSourceRef` / `sourceFingerprint` / `parserVersion` | 来自 `source_metadata()` |

### 2.4 token 口径规则（正确性核心）

统一目标：`totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`，`reasoningTokens` 仅诊断不入 total。

- **Anthropic 语义**来源：字段直接映射。
- **OpenAI 语义**来源（input 已含 cache）：先拆分再拼装（`zcode_local.rs` 与 `codex_local.rs:741` 同款）：

```rust
let input = (raw_input - cache_read - cache_write).max(0);
let total = input + output + cache_read + cache_write;
// 不变量：拆分后 total == 工具自身记录的 computed_total（写成单测）
```

- `total == 0` 的行跳过；错误/取消行（实测 token 为 0）按 `status` 过滤。
- 重试去重：按逻辑请求 ID 分组，取最大 attempt 的成功记录，参考 `zcode_local.rs` 的 `latest_attempt` HashMap 写法。

## 三、注册（3 处 Rust）

1. `collector-core/src/provider/mod.rs` — 加 `pub mod <name>_local;`
2. `collector-core/src/scanner.rs` — 两处：
   - `scan_usage_with_source_cache`：仿 hermes/zcode 块（source_cache 命中 → `try_parse_usage` → `finalize_event` → 汇入 `source_index`；error 进 `provider_errors`；最后 `health.push(local_provider_health(...))`）
   - `provider_health`：构造 provider 并在 `vec![]` 末尾加 `local_provider_health` 项
3. `atl-collector/src/sidecar.rs` — `TRAY_PROVIDER_NAMES` 加 `("<name>_local", "Display Name")`

后端 `providerId` 是开放字符串，**无需改后端**。

## 四、前端触点（8 处，一处都不能漏）

> 教训：zcode 首轮接入漏了 index.html 的 tab 按钮，导致来源页永远看不到该 provider——调研时用 `grep --include="*.js"` 搜触点，没搜 html。**搜触点时不要限定文件类型**：`grep -rn "<参考provider>_local" src/ atl-collector/ collector-core/ tests/ --include="*"`，把参考 provider（如 `hermes_local`）的所有出现位置全部对齐。
>
> 0.7.11 起来源页改为"左侧 provider 列表 + 右侧详情"布局：**不再有硬编码的 index.html tab 按钮**，`renderHealth` 直接从 health JSON 动态生成左侧导航项（`data-provider-nav`）和右侧 provider 卡片，添加位置按钮也由 `providerAddRootButton` 按 `PROVIDER_ADD_ROOT_LABEL_KEYS` 数据生成，click 委托统一走 `[data-add-root-provider]`。新增 provider 只需保证 health 返回该条目，来源页即自动出现入口。

| # | 文件 | 改什么 |
| --- | --- | --- |
| 1 | `src/desktop/renderer.js`（3 处） | ① `PROVIDER_ADD_ROOT_LABEL_KEYS` 加 `<name>_local → desktop.sources.add<Name>` 映射（添加按钮文案+生成）；② `sourceIconPath`；③ 文件内局部 `sourceName`。（添加按钮 click 委托已通用化：`[data-add-root-provider]`，无需再加 handler） |
| 2 | `src/desktop/renderer-data.js` | 导出的 `sourceName` |
| 3 | `src/desktop/renderer-helpers.js` | `UI_PROVIDER_ORDER` 末尾追加（左侧列表同状态组内的排序依据） |
| 4 | `src/shared/chart-helpers.js` | `sourceName`（带 `\|\| "Fallback"` 兜底） |
| 5 | `src/shared/i18n.js` | **zh、en 两个语言块各 2 个 key**：`source.<name>`（显示名）+ `desktop.sources.add<Name>`（添加按钮文案） |
| 6 | `src/web/admin.js` | `providerDisplayNames` |
| 7 | `src/web/data-value-demo-live.js` | `sourceNames` |
| 8 | 桌面托盘 | 已由 sidecar.rs `TRAY_PROVIDER_NAMES` 覆盖 |

## 五、样例数据

- 放 `samples/<name>/`（SQLite 仿 `samples/zcode/db/db.sqlite` 的最小 schema + 6~8 行覆盖：正常行、cache 拆分行、重试组、零 token 行、孤儿会话行、真实数据镜像行）。
- 时间戳取 **UTC 正午**（如 `2026-06-08T12:00:00Z`），保证绝大多数时区下日期断言稳定；单测断言 day 时跟随 hermes 风格（精确日期）。
- **`.gitignore` 的 `*.db` / `*.sqlite` 会挡住样例库**（hermes/mimocode 等存量样例库都是本机 fixture、未入库）。两条路：本地 fixture（单测"缺库即跳过"，集成测试加存在性守卫）或 `git add -f` 入库。与存量保持一致时选前者。

## 六、测试矩阵

1. **provider 单测**（`<name>_local.rs` 内）：常量、样例解析条数、token 拆分数学（含 OpenAI 口径不变量）、重试去重、零值/错误行跳过、孤儿会话兜底、不存在路径、表缺失报错、manual root 扫描、禁用开关。
   - 注意：开发机上可能存在真实 `~/.<tool>`，auto root 会被扫到——单测断言"包含样例路径"而非精确数量。
2. **集成测试**（`collector-core/tests/integration_scan.rs`）：`init_config` 注册样例根 + 新场景（条数、总额精确断言、`workdirHash` 不等于真实路径、无 provider_errors、health 含新 provider）。缺样例库时 return 跳过。
3. **前端单测**（`tests/renderer/chart-helpers.test.js`）：`sourceName` 映射加一行断言。
4. **E2E**：
   - `tests/e2e/mock-tauri.js` 的 `mockHealth` 加新 provider 条目（左侧导航项由 health 动态生成，无需改 index.html）；
   - `tests/e2e/workflows.spec.js` 加导航交互用例（`[data-provider-nav="<name>_local"]` 可见 → 点击 → 卡片渲染 → 来源行可见）。现有断言用 `>=` 计数，新增条目不会破坏。

## 七、验证与打包

验证顺序（对应 AGENTS.md 质量门）：

```bash
cargo test --workspace
npm test
npm run test:ui
npm run test:e2e
node --check src/desktop/renderer.js   # 及所有改动 JS
```

**真库对账**（最有说服力的验收，ZCode 先例）：隔离 HOME + 符号链接真实数据目录，用编译好的二进制实际扫描，与 SQL 直查（或等价原始查询）聚合对总：

```bash
mkdir -p .tmp-verify/home/.<tool> && ln -s ~/.<tool>/<dir> .tmp-verify/home/<...>
HOME=$PWD/.tmp-verify/home ./target/debug/atl-collector init --nickname verify
HOME=$PWD/.tmp-verify/home ./target/debug/atl-collector scan   # 汇总
# 与直查 SQL 的 SUM 对账，应分毫不差；结束后 rm -rf .tmp-verify
```

打包：

```bash
scripts/release.sh --platform current --env env.local --yes
```

**打包陷阱（都在 zcode 接入时实际发生过）**：

1. **绕过 release.sh 直接 `npx tauri build` 会产出缺 sidecar 的 app**——sidecar 由 release.sh 暂存到 `src-tauri/binaries/`（构建后清理），`tauri.conf.json` 的 resources 把整个 `binaries/` 打进 app。手动打包必须先 `cp target/<triple>/release/atl-collector src-tauri/binaries/` 并在结束后清掉。
2. **前端在编译时嵌入主二进制**（`frontendDist: "../src"`）：只改 HTML/JS 时若 cargo 判定 Fresh，嵌入资源不会更新——`touch src-tauri/src/main.rs` 强制重编译，或依赖 release.sh 的完整构建。
3. **DMG 的 Finder 布局 AppleScript 在无 GUI 权限的进程里会超时**（`-1712`），release.sh 会降级只出 `.app`。在交互终端跑 release.sh 不受影响；agent 环境需要 DMG 时用 `--skip-jenkins` 绕过布局再另行验证内容。临时改过的 `target/**/bundle_dmg.sh` 要删掉，防止污染下次正式打包。
4. 嵌入资源是压缩存储的，`strings | grep` 查不到前端字符串，**不能**用它验证前端新旧；用 e2e 或实际启动验证。

## 八、快速核对清单

```
调研   □ 数据路径/形态  □ token 口径(OpenAI/Anthropic)  □ 去重维度  □ 时间戳单位  □ workdir  □ 隐私表清单
实现   □ <name>_local.rs(只读打开/错误上报)  □ mod.rs  □ scanner.rs×2  □ sidecar.rs
前端   □ renderer.js×3(按钮映射/sourceIconPath/sourceName)  □ renderer-data.js  □ renderer-helpers.js
      □ chart-helpers.js  □ i18n.js(zh+en 各2key)  □ admin.js  □ data-value-demo-live.js
数据   □ samples/<name>/ 样例库(UTC正午时间戳)
测试   □ 单测(≥9项)  □ integration_scan 场景  □ chart-helpers 断言  □ e2e mock+导航用例
验证   □ cargo test --workspace  □ npm test  □ test:ui  □ test:e2e  □ node --check
      □ 真库扫描 vs SQL 对账  □ release.sh 打包  □ 桌面端启动目检(来源页导航/卡片/扫描数据)
```
