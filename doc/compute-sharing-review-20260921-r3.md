# 算力共享第三轮 Review 与修复验收

日期：2026-09-21。Review 基线：`develop` / `878872d6d6686240840485f1ebbc3aabf2c9310c`。本轮按用户要求直接修复发现的问题，初次验收交付为该基线上的工作区补丁，未推送或发布。

提交整理：随后按用户要求，将远程基线 `6199b95508b8462fa7581f10fd4fa12bf2f7fb01` 之后的 27 个本地提交与全部未提交文件合并为一个提交，包含原有 `.zcodeignore`（内容未改动）。原 27 个提交保留于本地备份分支 `codex/backup-compute-sharing-before-squash-20260921`；报告中的旧 SHA 为验收时的历史定位，不代表合并后主分支仍保留那些独立提交。

## 1. 结论与验收范围

研发第二轮修复仍有缺口。本轮确认并修复 **14 组问题（5 P1、9 P2）**，覆盖计量恢复、持久化、存储互斥、诊断、卡片异步交互、CLI 和插件宿主。代码级回归、有限只读用户盲评及本机原生 smoke 通过。

本结论不等于生产全流程验收通过。本轮没有部署后端、替换真实 CPA 插件、发布在线卡、覆盖已安装 App，也没有用真实借用凭据发起计费生成。旧验收报告和研发发布说明作为历史记录保留，未当成本轮实测结果。

## 2. 确认问题、修复与证据

| 编号 / 级别 | 触发与修复前表现 | 本轮修复 | 验证 |
| --- | --- | --- | --- |
| R3-01 / P1 | 旧后端连续返回绝对累计 `30,50,50`，本地变成 `30,20,20`，Key 可用额度错误 | 绝对值直接作为对应窗口的 confirmed 基线，删除增长差分伪装 pending 的路径 | 真实 HTTP `tick` 探针稳定得到 `30,50,50` |
| R3-02 / P1 | 同 Key 前后两窗 pending 被合并到错误窗口，当前 Key 为 0、lane 为 30；新窗事件未清旧 confirmed 时，30 被回包恢复成 110 | 当前 Key 仅计入当前 lane/window 的 pending；事件侧换窗也清 confirmed | 多窗 HTTP 探针 + 旧基线 80 / 新事件 30 / 陈旧回包用例均为 30 |
| R3-03 / P1 | 新事件回调后未落盘；飞行中后到事件丢失；ACK 后旧队列仍在磁盘。v2 三阶段为 `0/40/40`，legacy 为 `0/0` | Runtime 持有 pending 与 inflight 两组队列；回调、发送前、重试和 ACK 后写同一原子快照，保留 seq；写失败阻止新的共享流量，恢复落盘后解除 | v2 三阶段 `40/110/70`；legacy `110/70`；独立子进程读取恢复、写失败拒绝认证和恢复探针通过 |
| R3-04 / P1 | StoreLock 将其它线程当成可重入调用；外层 guard 先释放也可能提前解锁，破坏共享 JSON 写入互斥 | 重入仅限同线程、同规范化锁路径；嵌套 guard 共持有文件句柄，最后一份释放后才解锁 | 不同线程排斥、外层先释放、独立目录；borrow-get 与另一真实进程写入竞争后新 claim 保留 |
| R3-05 / P2 | doctor 以可选旧配置文件判断地址，未检查 CPA 实际使用的 API；未来心跳或无时间戳也会给出误导信息 | 以 `status.api` 为实际地址，区分 missing/unknown/mismatch；60 秒新鲜度和未来时间校验；缺失年龄为 null | 注入路径/时钟的生产函数测试；真实 CLI JSON；中英卡片渲染 |
| R3-06 / P2 | 输入框历史焦点在用户已点击其它按钮或切换页签后被刷新夺回 | 每轮捕获当前焦点；仅原元素仍可用且浏览器因禁用按钮丢焦到 body 时恢复 | 显式确认 DOM 已重建的焦点测试，排除“没刷新所以通过” |
| R3-07 / P1 | 手动测试成功后旧自动重试继续发生成请求；刷新替换 claim 行后回包写入旧 DOM；旧失败可覆盖新成功 | 每 Key 独立可取消的测试链；新操作使旧链失效；对当前 DOM 更新结果；结束、移除或销毁时清重试与等待标记 | 手动成功后请求次数不再增加；旧响应隔离、行刷新、导航/移除取消及有限重试终态测试 |
| R3-08 / P2 | 英文卡片直接展示 sidecar 中文诊断提示 | sidecar 返回稳定 code/params，卡片通过自带双语字典呈现 | 英文缺配置与 stale 场景；zh-CN/en 的 unknown 与 mismatch 场景 |
| R3-09 / P2 | `share test --json` 等缺参或未知选项输出纯文本，脚本错误处理再次解析失败 | clap 解析失败前识别 JSON 标志，stdout 输出统一错误外壳，退出码 2；帮助和版本保留文本 | 真实 CLI 二进制集成测试；独立盲评 14 次 JSON 全可解析 |
| R3-10 / P2 | 未注册 owner 提示没有可继续的入口；suggest 空态暴露内部 `owner-suggest` 名称，用户误当成命令；只读 doctor 报 changed=true | owner 指向 doctor/CPA 配置启动；suggest 指向实际存在的命令；doctor changed=false | 独立盲评三轮收敛，最后定向复测无新困惑 |
| R3-11 / P2 | CLI 建议仍读 reservePct，与卡片 referencePct 语义及数值不一致 | 共用同一配置语义，当前字段优先，旧配置按卡片迁移规则解释；注明来源为自己近 7 天 CPA 用量 | 当前 20% 覆盖旧值；75% 得 750M、5% 得 50M 的回归 |
| R3-12 / P2 | 已缓存的第一方插件仍要等在线目录最长 8 秒，离线/弱网时本地入口迟迟不出现 | 先渲染已有本地卡；第一方用随 App 发布的权限声明挂载；第三方等目录权限元数据后才挂载；目录完成不重建已有卡片草稿 | 挂起目录时第一方 1 秒预算内可用，第三方零提前执行；目录恢复后只挂一次且草稿保留 |
| R3-13 / P2 | 升级按钮位于卡头，事件却从 detail 查找，点击无动作 | 卡头统一创建、更新与绑定升级按钮，目录晚返回也可操作 | 宿主 E2E 点击后 installedVersion 从 1.1.5 变为 1.1.6 |
| R3-14 / P2 | 原生离线实测中，目录请求已失败，却显示“控制面刚刚更新”；本地 not_registered 被当作联网成功 | 新鲜度仅由成功目录响应更新；失败即标记无法更新，节点/可认领数显示未知，旧刷新不得覆盖当前目录状态 | 双语 E2E：离线→恢复→再次失败；原生包离线状态复验 |

主要实现：[CPA 状态](../cpa-plugin/src/core_state.rs)、[CPA 队列落盘](../cpa-plugin/src/lib.rs)、[心跳同步](../cpa-plugin/src/sync.rs)、[共享存储锁](../collector-core/src/store_lock.rs)、[sidecar](../plugins/compute-sharing/rust/src/lib.rs)、[卡片](../plugins/compute-sharing/index.js)、[CLI](../atl-collector/src/share_cli.rs)、[参数错误](../atl-collector/src/main.rs)、[插件宿主](../src/desktop/renderer.js)。

新增与加强的长期回归：[CPA 真实 HTTP/进程探针](../cpa-plugin/src/sync_tests.rs)、[CLI 参数错误](../atl-collector/tests/json_usage_errors.rs)、[CLI doctor](../atl-collector/tests/share_doctor.rs)、[共享卡交互](../tests/e2e/compute-sharing.spec.js)、[宿主慢目录及升级](../tests/e2e/modules.spec.js)。

## 3. 验证结果与证据分层

证据目录：[`tests/output/compute-sharing-review-r3/`](../tests/output/compute-sharing-review-r3/)。该目录不进 Git；长期回归源码随补丁交付。各 `before` 日志保留缺陷复现，`final` / `after` 为修复后证据。

| 层级 | 结果 | 日志 |
| --- | --- | --- |
| Node 后端/shared | `npm test` 全通过；MySQL round-trip 明确跳过 | `backend-final.log` |
| Renderer | 20 文件、581/581 通过 | `renderer-host-final.log` |
| Playwright 全量 | 147/147 通过，含 33 个共享卡用例和 2 个新增宿主用例；使用等价测试服务配置的 1453 端口、4 workers | `e2e-complete-final.log`、`ui-playwright.config.mjs` |
| Rust workspace | 所有已执行测试通过；侧车子进程 helper 虽标 ignored，父用例显式运行；另一个人工诊断用例未运行 | `workspace-retest-final.log` |
| CPA 独立 crate | 47 passed；2 个 ignored 分别是父用例显式调用的恢复 helper 和单独执行的性能探针 | `cpa-final.log` |
| 原生构建 | 当前机器 arm64 App/sidecar 构建成功；独立 CPA cdylib release 构建通过 | `package-final.log`、`cpa-release-final.log` |
| 窗口契约 | 当前后端 `laneWindowOf` 与 Rust 216 个窗口样本的 key/endMs 一致 | `window-authority-final.log` + CPA fixture 测试 |
| 落盘性能 | 200 次真实回调：p50 5.477ms、p95 7.183ms、max 9.820ms；本机 p95 <20ms 预算通过 | `cpa-benchmark.log` |
| 外部口径对账 | ccusage 及可用本地数据库比较通过；只比较已完成日期 | `ccusage-final.log` |
| 静态检查 | renderer/card `node --check`、`git diff --check` 通过 | 最终工作区检查 |

边界与失败分流：

- 最初全量 E2E 为 140/143，三项失败都在普通 modules 夹具：没有隔离外部目录请求。补确定性路由，同时新增显式慢目录用例，确认并修复宿主阻塞；没有通过增加等待时间放宽验收。
- 最初 CPA 冷启动探针使用了缺少 `lastSeqByKey: 0` 的旧夹具，与当前后端不符。该次失败归为 case 问题并修正夹具，没有计入本轮产品缺陷。其余计量/持久化探针有独立红转绿证据。
- Rust 进程探针只在独立子进程中设置临时 ATL_HOME 和虚构 CPA 配置；注入路径的测试不修改全局环境。未通过真实 HOME 制造共享账本。
- Renderer 有既存 vendor source map 缺失提示；测试通过，但不能称所有工具输出“零警告”。CPA 早期测试的未用变量警告已修正，最终 CPA 测试通过且无该警告。
- ccusage：Claude 1 个完成日与外部工具匹配，另 17 个受保护历史日已不在外部来源中，按既有规则容忍；Codex 174、OpenCode 2、MiMo 55、WorkBuddy 6、Kimi 2 个完成日匹配。Hermes/OpenClaw 因来源未配置跳过，不宣称全 provider 覆盖。
- 本机落盘基准只覆盖 200 次回调及当前文件系统；长时间离线积压与高吞吐节点仍应做专门负载验证。

## 4. 原生运行与本机产物

`npm run desktop` 已在独立 HOME、ATL_HOME 和 CPA 数据源下编译并启动，使用本机离线 API，关闭采集源、后台刷新、备份和自动更新。隔离目录只预置本轮卡片源码作为离线缓存；未复制真实身份、认领或凭据。开发进程由测试 supervisor 自动停止。

本机构建命令 `scripts/release.sh --platform current --env env.local --yes` 已成功完成，不传 `--upload`。旧 `dist` 预先移入证据目录 `prior-dist/` 保留。

原始构建没有 Developer ID 签名，保留 linker ad-hoc 签名，严格资源签名检查失败（`package-checks.log`）。为本地交付另建 QA 副本并执行 ad-hoc 签名，`codesign --verify --deep --strict` 通过；没有改写原始 DMG/updater，没有公证或线上发布。这是本机 QA 产物，不能当作签名、公证完成的正式发行包。

使用该 QA App 的真实 WebView 和包内 sidecar，点击「插件」→「检查」：缓存卡可加载；无身份/配置/心跳显示四项准确诊断；目录断开后显示“控制面暂时无法更新 / 节点状态未知 / 可认领资源待更新”。包内 `atl-collector` 版本、doctor JSON、用法错误 JSON、随包 CLI 手册校验通过。运行后仅停止本任务进程组。详见 [原生观察记录](../tests/output/compute-sharing-review-r3/native-acceptance.md) 和 `qa-package-checks.log`。

本机产物：[macOS arm64 QA zip](../tests/output/compute-sharing-review-r3/artifacts/AI-Token-League-0.7.16-r3-qa-macos-arm64.zip)。[产物目录](../tests/output/compute-sharing-review-r3/artifacts/) 另含当前卡片源码和 CPA dylib；zip 中的 App 不会自动替换这两个独立分发组件。文件校验值见 `artifacts/SHA256SUMS`。补丁为 `fixes.patch`，源码身份为 `source-sha256.json`；它们均以本报告所列 HEAD 为基线，不包含 `.zcodeignore`。

## 5. 独立用户盲评

按 CLI 自描述与结构化输出契约，由独立子代理只看二进制帮助与输出，不读源码、项目文档、旧报告或 diff。任务为理解能力、空借用/未注册 owner、首次分享诊断、离线错误、无效 Key/参数、JSON 及版本。未执行共享写入或有效推理。

首次发现 JSON 解析失败和 owner 指引断点。第二轮 36 条命令、14 次 JSON 全部可解析，原问题解决；又发现 suggest 内部名和未知心跳年龄两处困惑，已修复。最终 7 条定向复查无新的不符预期。

最终判断：**本轮有限只读范围可用性通过**。不能推导为已注册 owner、真实认领、暂停/恢复/终止或真实生成全链路盲评通过。原始报告：[首次](../tests/output/compute-sharing-review-r3/blind-cli.md)、[第二次](../tests/output/compute-sharing-review-r3/blind-cli-retest.md)、[最终](../tests/output/compute-sharing-review-r3/blind-cli-final.md)。

首次隔离仅设置 ATL_HOME 时，`share suggest` 仍读到 CPA 独立数据库的聚合量。这不是 ATL 缓存账本不一致；CPA 来源另由 `ATL_CPA_USAGE_DB` 决定。后续显式重定向到不存在的测试库，避免读取真实来源；[CLI 手册](cli.md) 已说明隔离边界和建议来源。

## 6. 研发交付与发布前剩余工作

本轮没有后端 API、数据库 schema 或排位 token 定义变更。CPA 队列文件仍为 `buckets/seq/legacy`，修复写入时机与队列归属；应保留原 journal 和 seq，不得通过删文件“修复”同步。doctor 增补诊断 code/params，现有字段继续提供。

1. 研发审查并提交本轮补丁。版本仍沿用 App/CLI `0.7.16`、卡 `0.1.2`、CPA `0.5.2`，仅表示构建基线；正式发布必须分配新版本，不能覆盖已发布的不可变插件包。
2. 核实生产后端已提供当前协议与 owner 操作端点。用户此前说明生产部署待完成，本轮未连接生产核实，状态不可从本地门禁推断。
3. 在专用环境完成真实 CPA + 当前后端 + 新 sidecar/App + 新在线卡组合，使用测试身份验证认领→生成→扣账→重启恢复及暂停/恢复/终止；随后做最小生产 smoke。
4. MySQL round-trip、多实例后端、Windows/Linux/Intel Mac、插件线上下载/repin、真实升级与回滚未在本轮执行。必要发布门禁应在对应环境补齐。
5. 回滚前停止新的共享请求，保留 journal/seq 并确认 ACK 状态。旧无 seq 协议不能提供网络回包丢失情况下的去重保证；本轮没有把旧协议宣称为 exactly-once。

可复验命令：

```bash
npm test
npm run test:ui
npm run test:e2e
cargo test --workspace
cargo test --manifest-path cpa-plugin/Cargo.toml
cargo test --manifest-path cpa-plugin/Cargo.toml journal_callback_latency -- --ignored --nocapture
npm run verify:ccusage
node --check src/desktop/renderer.js
node --check plugins/compute-sharing/index.js
git diff --check
```

## 7. 后续发布状态（2026-09-21）

用户随后部署了后端，并授权更新本机组件。共享卡片 `0.1.3` 已在线发布并在 App 中升级，CPA `0.5.3` 已实际加载并确认线上心跳，App/CLI `0.7.17` 已完成本机 arm64 构建安装。原报告各节保留当次验收边界；本次重跑门禁、上线哈希、状态保留、额外网络切换缺陷和回滚记录统一见 [R3 发布记录](compute-sharing-rollout-20260921-r3.md)。
