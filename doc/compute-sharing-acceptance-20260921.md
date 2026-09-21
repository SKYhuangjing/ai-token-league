# 算力共享改造第二轮验收 · 2026-09-21

**结论：不通过，退回研发继续修复。** 固定 `develop@58409fd` 复验后，确认若干首轮问题已修复，但仍有 **8 组缺陷：5 组 P1、3 组 P2**。主要阻塞在新 Key 的 v2 计量启动、未确认批次恢复、心跳账本合并和并发认领清理。原有自动化全部通过，不能据此认定产品闭环通过。

依据：[改造设计及 V01～V16](compute-sharing-usability-design.md)、[第一轮验收及研发回复](compute-sharing-acceptance-20260920.md)。本报告维持原验收标准，区分实测、源码判断及未完成验证，可直接按末尾任务表分派研发。

## 1. 固定输入与验证边界

| 项目 | 本轮输入 |
| --- | --- |
| 提交 | `58409fd6ea74681dc629bfea47c49b18b0bd8354`，`develop` |
| 纳入修复 | `750437e` 后端批次去重、`79bb34f` 计量与存储、`40325e9` 编辑/生命周期/接入、`64e1226` 交互用例、`716ee5f` 中文确认条、`58409fd` 发布元数据 |
| 版本 | desktop / sidecar `0.7.16`，JS 插件 `0.1.1`，CPA 插件 `0.5.1`；后端按提交识别 |
| 环境 | Apple M1 Pro / arm64 / macOS 27.0，Playwright 1.60.0 / Chromium |
| 执行日期 | 2026-09-20 晚执行；2026-09-21 整理第二轮报告，因此证据目录保留 `20260920-r2` |
| 隔离工作树 | `/Users/sky/.codex/worktrees/compute-sharing-acceptance-r2/token-mac-windows-ai-codex-claude` |
| 修改边界 | 主工作区只新增本报告、更新文档索引；原有 `.zcodeignore` 未动。探针仅在隔离树注入，未修改产品函数，未提交/推送 |

CPA 探针调用生产 `sync::tick`、计量与磁盘恢复函数，对接 localhost HTTP fixture；存储探针调用真实 sidecar 命令并使用两个进程。均使用临时 `ATL_HOME` 和合成凭证。浏览器使用生产插件/宿主 JS 与 mock sidecar。**这些是明确边界的集成证据，不是安装态 Tauri、真实 CPA 宿主或真实模型请求的证据。**

交接附件：[证据包](../tests/output/compute-sharing-acceptance-20260920-r2.zip) · [复现说明](../tests/output/compute-sharing-acceptance-20260920-r2/README.md) · [快照与源文件散列](../tests/output/compute-sharing-acceptance-20260920-r2/snapshot.json) · [仅测试注入的补丁](../tests/output/compute-sharing-acceptance-20260920-r2/probe-only.patch)。`tests/output` 被 Git 忽略，分派研发时须一并附证据包。

## 2. 第一轮问题的关闭情况

| 首轮项 | 本轮判定 | 本轮证据与剩余边界 |
| --- | --- | --- |
| QA-01 外部服务语义/卸载 | 本地链路已修复 | 发布脚本包含 `externalService`，宿主按字段补元数据；旧目录缺字段时，首次卸载点击保留安装并展示确认。真实 CPA 卸载行为仍待验 |
| QA-02 飞行期间新增用量 | 部分修复 | 已有 seq 的 v2 当前窗口，40 已发送 + 70 新增，回包后保留 110；新 Key、旧窗口响应和重启仍失败，见 R2-01/02/04 |
| QA-03 日/周窗口推进 | 计算层已修复 | JS/Rust 比对 216 组小时/日/周窗口，windowKey 与 endMs 全匹配；端到端计量仍受 R2-01/04 阻塞 |
| QA-04 旧后端基线/版本门控 | 未关闭 | 首次恢复不再为零，但相同基线被重复累加，见 R2-03；四组件门控仍未闭环 |
| QA-05 并发认领丢记录 | 部分修复 | 新增按 Key 的 `borrow-prune` 保留新认领；`borrow-get` 过期清理仍整表覆盖，见 R2-05 |
| QA-06 刷新打断编辑 | 部分修复 | 策略草稿 123456 和焦点保留；资源名称焦点仍丢失，另出现未编辑字段拒绝更新，见 R2-06 |
| QA-07 隐藏/销毁后轮询 | 本轮探针通过 | 隐藏后 16 秒 owner 调用保持 1→1；移除 20 个生产卡片后触发可见事件，新增调用为 0。不是原生 20 次切页证据 |

## 3. 第二轮返工缺陷

### R2-01 · P1 · 新 Key 无法启动 v2 计量，持续发送旧格式

**复现：** 真实后端 API 测试中新认领 Key，心跳返回 `protocol: 2` 和 charged=0 的 `keyLedger`，但 `lastSeqByKey` 是 `{}`。以这个响应形状运行生产 CPA tick，产生 40 tokens 后的首个请求只有 `keyId / tokens / requests / failed`，没有 `seq / windowKey / rawTokens / chargedTokens`。见 [API 输出](../tests/output/compute-sharing-acceptance-20260920-r2/backend-first-key-probe.log)、[CPA 线协议输出](../tests/output/compute-sharing-acceptance-20260920-r2/first-bucket-probe.log)。

**根因及影响：** [sharing-cpa.js](../src/backend/sharing-cpa.js) 第 585 行仅在 `claim.lastSeq` 非零时返回序号；[sync.rs](../cpa-plugin/src/sync.rs) 第 293～303 行仅给已有本地计数器的 Key 分配 seq。新 Key 双方都等待对方先提供序号；旧格式结算又不推进 `lastSeq`。因此新 Key 不能自行进入 v2，失去重试去重与事件窗口/倍率语义。后端按到达时间走旧结算分支是源码确认的后果；本轮没有将真实 CPA 接入完整后端做模型流量验证。

**处理与复验：** 明确新 Key 的权威起始序号、首次握手和持久化协议。用真实后端响应驱动 CPA 首次用量，证明首批即有正 seq 和事件窗口；丢回包重试只结算一次，跨窗口/倍率边界仍以事件时刻结算。不可仅给 mock 手工补 `{key: 0}` 后宣告修复。对应 CS-06 / V04、V05。

### R2-02 · P1 · 重试发送前清空持久化队列，未确认用量无法恢复

**复现：** 40 tokens 首次心跳 HTTP 500，生产重排队已将 40 落盘；第二次 tick 重试已发出、HTTP 回包尚未释放时，另起进程调用生产 `load_pending_state`，恢复结果为 **0**。线上请求仍携带 40，说明丢失发生在“发送中但未确认”的区间。见 [运行日志](../tests/output/compute-sharing-acceptance-20260920-r2/runtime-probes.log)。

**根因：** [sync.rs](../cpa-plugin/src/sync.rs) 第 284～303 行先 `mem::take` 取走 pending，再保存 Runtime；[lib.rs](../cpa-plugin/src/lib.rs) 第 128 行的保存函数此时看不到已取走的飞行批次，磁盘被写为空。保存 seq 并不等于保存未确认的用量。

**处理与复验：** 未确认批次从待发送到发送中均须可恢复，只有被后端确认后才能清理；重启重发保持原批次身份。覆盖发送前、飞行中、后端已记账但丢回包三个故障点，raw/charged 均不丢不重。本轮是生产恢复函数的独立进程读取，不冒充完整 CPA 宿主重启。对应 CS-06 / V05。

### R2-03 · P1 · 旧后端相同已用基线每次心跳再次累加

**复现：** 后端始终返回 `settledByKey[key]=30`，没有任何新请求，连续四次生产 tick 后本地 Key charged 为 **30、60、90、120**，预期始终为 30。Key 上限 100 时会错误耗尽额度。见 [运行日志](../tests/output/compute-sharing-acceptance-20260920-r2/runtime-probes.log)。

**根因：** [sync.rs](../cpa-plugin/src/sync.rs) 第 396～405 行将旧后端的绝对基线塞入 `key_pending`；[core_state.rs](../cpa-plugin/src/core_state.rs) 第 404～416 行把它当新增量叠加到已有本地账本。第一次不再为零，但重复恢复不幂等。

**处理与复验：** 按设计明确支持的版本组合。若保留过渡组合，绝对基线与未确认增量须分别建模；若不支持，应在能力检查阶段明确阻止该组合，提供迁移步骤。连续空心跳、真实增量、重启与升级均不能凭空增加或减少用量。对应 CS-00、CS-06、CS-08 / V04、V05、V16。

### R2-04 · P1 · 旧窗口心跳响应让当前窗口 pending 被重复计入

**复现：** tick 飞行期间当前窗口产生 30，随后返回旧窗口快照；本地资源 charged 为 **30**，Key charged 却为 **60**。见 [运行日志](../tests/output/compute-sharing-acceptance-20260920-r2/runtime-probes.log)。

**根因：** [core_state.rs](../cpa-plugin/src/core_state.rs) 第 376～416 行跳过旧窗口快照并保留已经含 30 的当前账本，随后又无条件加上同一 pending 30。当前窗口 40+70 测试通过，未覆盖这条分支。

**处理与复验：** 按 Key + 窗口明确已确认基线和未确认增量；同一事件在响应合并中只能计一次。覆盖旧窗口迟到响应、跨窗 pending、同窗口重复响应，Key/资源同窗一致。对应 CS-06 / V04、V05。

### R2-05 · P1 · 过期记录的读取清理仍删除另一进程刚写入的认领

**复现：** 文件起初只有 expired；读取进程先读到旧文件，再等待跨进程写锁；另一个进程通过生产 `borrow-set` 写入 `[new]` 后释放锁。读取进程继续清理，最终文件变为 **`[]`**，新认领丢失。使用真实 flock、两个进程和真实命令；见 [存储日志](../tests/output/compute-sharing-acceptance-20260920-r2/sidecar-probes.log)。

**根因：** [Rust lib.rs](../plugins/compute-sharing/rust/src/lib.rs) 第 155～180 行 `borrow_get` 无锁读取，发现过期记录后把旧快照过滤结果交给 `borrow_set` 整表覆盖。新的原子 `borrow-prune` 已通过，但这条清理路径未迁移。

**处理与复验：** 所有清理入口都在同一锁内读取最新值并按 Key 删除；读取携带的清理副作用也必须遵循此规则。覆盖过期清理与认领/续期、撤销与刷新、双进程认领交错，保留不相干的新记录。对应 CS-04 / V11、V12。

### R2-06 · P2 · 刷新仍打断资源编辑，并将未编辑字段锁成旧值

**复现 A：** 资源名称草稿保留，15 秒刷新后焦点仍为 false；[旧交互探针](../tests/output/compute-sharing-acceptance-20260920-r2/old-ui-probes.log) 仍失败。**复现 B：** 用户未编辑单 Key 上限，后端从 200000 改为 350000，刷新后表单仍显示 **200000**；见 [新交互探针](../tests/output/compute-sharing-acceptance-20260920-r2/new-ui-probes.log)。

**根因：** [index.js](../plugins/compute-sharing/index.js) 的 `renderOwner` 继续重建资源编辑节点；第 955～969 行 `capturePolicyEdits` 把所有输入值都保存为草稿，没有区分用户修改，`applyPolicyEdits` 随后覆盖新服务端值。保留策略焦点的修复有效，但草稿判定产生新的陈旧显示问题。

**处理与复验：** 仅用户修改的字段保留草稿；未编辑字段跟随权威快照。资源和策略输入的焦点/选区跨两次刷新保持；保存后显示服务端归一化值并清除 dirty，取消后回到最新值。对应 CS-02、CS-04 / V03、V14。

### R2-07 · P2 · 首次同步只有等待文案，没有重试或最终结果

**复现：** 新认领 Key 首次连接测试返回 401，随后 mock 节点已可返回 200；等待 **17 秒**，`borrow-test` 仍只调用 **1 次**，结果区继续显示“等待节点同步（约 8 秒）”。见 [新交互探针](../tests/output/compute-sharing-acceptance-20260920-r2/new-ui-probes.log)。

**根因：** [index.js](../plugins/compute-sharing/index.js) 第 1623～1627 行的 timer 仅延长 `syncWait`，没有重发测试、探测就绪或设置超时结果。

**处理与复验：** 实现有次数/总时长上限的同步等待与重试，最终进入成功或可解释失败；卡片销毁取消待办，不重复认领或增加名额。分别验证下一心跳成功、持续失败、切页和销毁。对应 CS-03 / V10。

### R2-08 · P2 · 接入检查把陈旧心跳文件当作当前健康节点

**复现：** 临时环境中节点状态 `phase=beating`，但 `lastSuccessAt=1`、`lastTickAt=1`，生产 doctor 仍返回 **`ready=true`、node.ok=true**。见 [存储/诊断日志](../tests/output/compute-sharing-acceptance-20260920-r2/sidecar-probes.log)。

**根因：** [Rust lib.rs](../plugins/compute-sharing/rust/src/lib.rs) 第 80～117 行只按 phase 字符串判断运行状态，没有新鲜度检查。身份/配置只验证文件存在，当前检查项也未覆盖设计要求的地址一致性和版本支持。后两项为源码确认的流程缺口，未冒充运行态探针结果。

**处理与复验：** 用最近成功心跳及明确过期阈值区分在线、陈旧和未知，检测配置/地址/能力并返回可本地化的结构化诊断。过期文件不能显示准备就绪；缺失、错误地址、网络失败、版本不支持应给出各自处理步骤，借用入口仍可用。对应 CS-02 / V02。

## 4. 实际执行结果

| 验证入口 | 本轮结果 | 证据/范围 |
| --- | --- | --- |
| `npm test` | 通过 | [backend.log](../tests/output/compute-sharing-acceptance-20260920-r2/backend.log)；MySQL 往返 skipped |
| `npm run test:ui` | 581 / 581 通过，20 文件 | [ui.log](../tests/output/compute-sharing-acceptance-20260920-r2/ui.log) |
| 原有 mock E2E | 131 / 131 通过 | [e2e.log](../tests/output/compute-sharing-acceptance-20260920-r2/e2e.log)；完整原 testDir，仅另配 localhost:1441 隔离服务 |
| `cargo test --workspace` | 通过，1 项手动诊断 ignored | [workspace.log](../tests/output/compute-sharing-acceptance-20260920-r2/workspace.log) |
| 独立 CPA 原有测试 | 32 / 32 通过 | [cpa.log](../tests/output/compute-sharing-acceptance-20260920-r2/cpa.log)；CPA crate 不属于 workspace |
| 首轮浏览器探针复验 | 4 通过 / 1 失败 | [old-ui-probes.log](../tests/output/compute-sharing-acceptance-20260920-r2/old-ui-probes.log)；更新版本/权限 fixture，保留原断言 |
| CPA HTTP/恢复探针 | 1 通过 / 3 失败 | [runtime-probes.log](../tests/output/compute-sharing-acceptance-20260920-r2/runtime-probes.log)；R2-02/03/04 |
| JS/Rust 窗口交叉比对 | 216 组通过 | [window-probe.log](../tests/output/compute-sharing-acceptance-20260920-r2/window-probe.log)；hour/day/week，n=1/2/5，时区 -300/0/330/480，边界 ±1ms；同时比对 key/endMs |
| 新 Key v2 首批探针 | 失败 | [first-bucket-probe.log](../tests/output/compute-sharing-acceptance-20260920-r2/first-bucket-probe.log)；R2-01；另有真实 API 响应取证 |
| sidecar 存储/诊断探针 | 1 通过 / 2 失败 | [sidecar-probes.log](../tests/output/compute-sharing-acceptance-20260920-r2/sidecar-probes.log)；R2-05/08 |
| 新增浏览器探针 | 2 失败 | [new-ui-probes.log](../tests/output/compute-sharing-acceptance-20260920-r2/new-ui-probes.log)；R2-06/07，含截图和 trace |
| 目录 DOM 性能 | 达标 | [benchmark.log](../tests/output/compute-sharing-acceptance-20260920-r2/benchmark.log)：100 节点 / 300 资源，30 样本，点击至两次 rAF；p50 30.5ms、p95 **46.8ms**、最大 50.1ms，预算 200ms |
| 语法/文档检查 | 通过 | [checks.log](../tests/output/compute-sharing-acceptance-20260920-r2/checks.log)：插件、renderer、发布脚本 `node --check`；报告本地链接、证据包完整性、`git diff --check` |

追加 Rust 日志中的 `restart_reader` / `expired_reader` 是默认 ignored 的子进程入口，已由对应父用例用 `--ignored` 显式启动，不应计为另一个未验证场景。新增浏览器探针最初误用 `expect.soft.poll`，修正测试 API 后保留原业务断言重跑；最初的 case 错误日志保留，不计入产品缺陷。追加探针是可复现的验收资产，尚未进入默认回归套件。

## 5. V01～V16 本轮判定与发布边界

| 编号 | 判定 | 本轮依据/剩余条件 |
| --- | --- | --- |
| V01 | 部分通过 | 本地发布字段、宿主回退、卸载确认通过；隔离 CPA 退出/卸载仍待验 |
| V02 | **不通过** | R2-08；入口已增加，但诊断不能证明当前就绪 |
| V03 | **不通过** | R2-06；未编辑字段不跟随后端刷新 |
| V04 | **不通过** | R2-01/03/04；窗口计算层通过不等于账本链路通过 |
| V05 | **不通过** | R2-01/02/03/04；去重启动和恢复仍有缺口 |
| V06 | 部分通过 | 原有 API/CPA 决策/mock 回归通过；真实传播及 TTL/下架组合待验 |
| V07 | 部分通过 | 原有单 Key 撤销及确认交互通过；真实节点应用确认待验 |
| V08 | 通过（mock 范围） | 混合节点、模型过滤和规模目录回归通过 |
| V09 | 部分通过 | 配置/协议原有回归通过；本轮未执行真工具 smoke |
| V10 | **不通过** | R2-07；等待无有限重试和最终结果 |
| V11 | **不通过** | 清理回执已有覆盖，但 R2-05 可误删有效记录 |
| V12 | **不通过** | 原子 prune 通过，过期读取清理双进程复现失败 |
| V13 | 部分通过 | 原有信任/遮罩用例通过；未扩展真实节点日志与隐私审计 |
| V14 | **不通过** | R2-06 焦点失败；本轮未补 Web 390px 与完整 zh/en 视觉矩阵 |
| V15 | 部分通过 | DOM p95、隐藏轮询、销毁监听通过；原生 20 次切页和独立派生 p95 未补验 |
| V16 | **不通过** | 缺四组件门控、MySQL/迁移/发布包/回滚证据，计量本身也未通过 |

静态复核：当前 manifest 只有权限与 `externalService` 等元数据，未声明最低宿主/sidecar 能力；宿主安装路径也未见相应前置检查。研发文档称远端后端尚未部署、新动作端点返回 404；**本轮未远程复核该状态，不将其记为新实测结果或可用证据。**

未运行安装态 Tauri、`npm run desktop`、真实 CPA/模型请求、MySQL 往返与迁移、四组件升级/回滚矩阵、`verify:ccusage` 或打包。本轮已复现产品阻塞项，未进入发布阶段；不能将未执行项标记为通过，也不能沿用上一轮研发的真实调用记录作为本轮独立证据。

## 6. 可直接分派的返工任务

| 任务 | 负责人角色 | 范围 | 重新提验必须提供 |
| --- | --- | --- | --- |
| R2-A 计量协议与恢复 | CPA + 后端 | R2-01～04，V04/05 | 首次握手→用量→丢回包→重启的完整链路；新 Key 首批 v2；重复心跳幂等；旧窗口响应不重计；原探针全部转绿并纳入正式回归 |
| R2-B 本地认领一致性 | Rust sidecar | R2-05，V11/12 | 所有清理路径使用原子修改；双进程认领/续期/过期清理交错，新增记录不丢 |
| R2-C 编辑与首次借用 | 桌面插件 | R2-06/07，V03/10/14 | 未编辑值更新、dirty 草稿/焦点保存、服务端归一化回显；首次同步有限重试/超时/销毁取消，zh/en |
| R2-D 首次分享诊断 | Rust sidecar + 桌面 | R2-08，V02 | 陈旧心跳不能 ready；安装/初始化/地址/版本/网络分项诊断与可操作指引 |
| R2-E 集成发布收口 | 集成负责人 + QA + 发布 | V01/06/07/09/13～16 剩余边界 | 实际四组件版本及门控、真工具各协议、隔离 CPA、MySQL 迁移、当前机器包、回滚记录 |

建议先完成 R2-A/B，防止计量和凭证继续失真，再关闭交互与接入问题，最后执行发布验证。修复不应通过删除失败用例、降低断言或只替换 mock 数据来达标。每项交付须给出修复提交、对应探针的新日志，以及仍未覆盖的真实运行边界。

本次只形成可分派交接文档，未向外部人员发送消息或指派具体成员；未修改原设计或第一轮报告中的历史结论。

## 7. 研发响应记录（2026-09-21，R2-A～R2-D 返工 + 盲评迭代完成）

对应 §6 任务表，全部在 develop 完成（提交 `df1fea1` `23e56e5` `11fea1e`）；验收探针断言全部转入正式回归，未删除或放宽任何断言。

### 7.1 缺陷修复对照

| 任务 | 状态 | 修复内容与证据 |
| --- | --- | --- |
| R2-A 计量协议与恢复 | **已修复（CPA 0.5.2）** | R2-01：后端 lastSeqByKey 恒含每个有效 Key（0 计），插件把「后端报告过（含 0）」的 Key 首批即编号 seq=1——探针 `first_bucket_of_a_seq_known_key…`（首批即 v2 线格式）+ 后端 seq=0 断言。R2-02：落盘快照含飞行中批次（`save_pending_with_inflight`/路径注入核心），独立读取探针验证 40 在发送后、回包前仍可恢复且批次身份（seq）不丢。R2-03：账本引入 confirmed 基线，恢复改为「重算 charged = confirmed + pending」而非叠加本地现值；旧后端 settledByKey 以「对上次基线的增量」播种——探针：同一快照连续恢复 4 次恒为 30（非 60/90/120）。R2-04：重算式构造性消除双计分支——探针：陈旧窗口回包下当前窗 pending 恒 30（非 60）。 |
| R2-B 本地认领一致性 | **已修复** | `borrow_get` 读侧清理改为同一把跨进程锁内读改写（锁内重读最新态再按 Key 删除）；探针 `borrow_get_cleanup_never_drops_cross_process_writes`（跨进程写入在读取与清理之间存活）。 |
| R2-C 编辑与首次借用 | **已修复（卡 0.1.2）** | R2-06：草稿仅保留用户实际输入过的字段（dirty 集），未编辑字段跟随服务端快照；车道编辑器焦点+选区跨重建保留（e2e 用 visibility 事件驱动合并刷新，避免点击夺焦的假通过）。R2-07：同步窗口内失败自动重试（≤3 次/5s 间隔），窗口耗尽后出最终结论，卡片销毁取消待办；e2e：首测 401→重试→reachable，borrow-test 调用 ≥2。 |
| R2-D 首次分享诊断 | **已修复** | doctor 节点健康区分 online/stale/unknown（lastSuccessAt 60s 新鲜度界），冻结的 beating 文件判 stale 不判 ready；新增 CPA api 与 App apiBase 一致性检查；「节点在线证明配置可用」避免活分享误报 NOT READY。e2e：stale 形状渲染 value+hint。 |

### 7.2 盲评迭代（用户子代理，3 轮）

三轮零实现上下文盲评（第 1 轮生产环境借用+分享全流程；第 2 轮复验抱怨修复 + owner 管控演练；第 3 轮预发布环境 owner 管控）：

- **第 1 轮**：借用 3.5/5、分享 3/5，5 条抱怨（默认模型必失败、keyId 截断断路、编译噪音、口径无图例、owner 无车道级管控）。
- **全部修复**（`23e56e5`/`11fea1e`）：export 行带经 live 目录发现的模型（最短具体 ID=基础档）；keyId 截断前缀可直接用作参数（歧义时报错指路）；构建零警告；claims 带 quota 行+图例，owner/dir 头部标注口径并解释全车道 vs 个人；新增 `share lane-pause/lane-resume/lane-terminate/owner-revoke/doctor` 命令；车道状态三态区分（TERMINATED/paused/closed）+ 友好 lane_not_found 提示；sidecar HTTP 客户端 no_proxy（系统代理黑洞 LAN 端点的盲评「unreachable」根因）。
- **第 2 轮**：借用 5/5「合理可用：是」（claims 输出直跑 claude 一次成功）；分享 2/5「否」——唯一核心阻塞为 lane 管控端点在生产后端 404（后端未部署新代码，SSH 无凭据无法由研发部署）。
- **第 3 轮**（本地预发布环境=待部署代码）：lane pause→resume→terminate→错误路径全链通过、不可逆性由后端 409 强制；上轮两个小项（slots 图例相反、laneId 不可见）确认已解决；**分享（代码层面）4/5「合理可用：是」**；两个状态显示小项当场修复并复验（TERMINATED/paused/closed 三态文案）。

### 7.3 回归与边界

门禁全绿：npm test（含 seq=0、round-seq、v2 契约）· test:ui 581 · e2e **133**（21 条 sharing 用例含全部验收转正）· workspace 13 crate · CPA 35 · sidecar 22 · verify:ccusage matched · 构建零警告。版本：卡 `compute-sharing@0.1.2`（OSS 已发+prune+本机 repin）、CPA dylib 0.5.2（已装入真实 CPA，心跳 beating）、App 0.7.16 重编重装（真机 owner 复验通过）。

**保留未完成（依赖生产后端部署，用户待办）**：lane-action/owner-revoke/计量协议 v2 的生产端到端（预发布环境已全链验证；部署后建议按第 3 轮清单在生产复跑一遍）；MySQL 005 真库迁移；四组件组合矩阵与打包回滚记录（V16 剩余）；暂停车道跨 5h 窗边界的自动行为（第 3 轮盲评如实申报未测，文案已明示手动 resume）。
