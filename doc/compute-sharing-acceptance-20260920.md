# 算力共享改造验收报告 · 2026-09-20

**结论：本轮验收不通过，退回研发修复。** 原有自动化回归通过，但追加的 9 项验收探针全部失败，确认 7 组缺陷，其中 5 组 P1 涉及控制提示、额度执行或认领记录一致性。首次接入流程及发布闭环也未满足设计要求。不能将 CS-01～CS-08 的 DONE 等同于产品验收通过。

验收依据：[改造设计与 V01～V16](compute-sharing-usability-design.md)。本报告不修改原设计的通过标准；研发自测、此次复验、静态结论和未验证项分别记录。

## 1. 验收输入与边界

| 项目 | 本次输入 |
| --- | --- |
| 初始提交 | `develop@47a3b2e` |
| 最终固定提交 | `eeb577399a920bf8d9f4da539f33d110a28aff98`，已纳入 `d6c6488` 的卡内确认条修复 |
| 工作区补丁 | 固定时复制了研发未提交的 `src/backend/sharing-cpa.js`、`tests/run-tests.js`、`tests/e2e/compute-sharing.spec.js`；补丁与文件 SHA-256 已存证 |
| 组件版本 | 客户端/sidecar `0.7.16`，JS 插件 `0.1.0`，CPA 插件 `0.5.0`；backend 按上述提交及补丁识别 |
| 隔离快照 | `/Users/sky/.codex/worktrees/compute-sharing-acceptance/token-mac-windows-ai-codex-claude` |
| 环境 | Apple M1 Pro，arm64，macOS 27.0，Playwright 1.60.0 / Chromium |
| 改动范围 | 验收文档与额外探针；未修补产品实现，未提交或推送，未发布插件、部署后端或修改日常 CPA / ATL 配置 |

验收中发现主工作区持续有研发提交与测试变更，因此后续改在隔离快照执行。**本结论适用于固定快照，不自动覆盖之后的修改。** 原有 Rust 回归在初始输入运行；对两版间 61 个相关 Rust 跟踪文件逐一核对，内容没有变化。独立存储探针在最终快照编译执行。

证据：[目录](../tests/output/compute-sharing-acceptance-20260920/) · [快照及文件散列](../tests/output/compute-sharing-acceptance-20260920/snapshot.json) · [研发补丁](../tests/output/compute-sharing-acceptance-20260920/final-working-tree.patch) · [Rust 输入一致性](../tests/output/compute-sharing-acceptance-20260920/rust-source-continuity.json)。`tests/output` 为本机验收输出，不默认随 Git 分发；交接可附[证据包](../tests/output/compute-sharing-acceptance-20260920.zip)。

## 2. 实际执行结果

| 验证 | 结果 | 证据与限制 |
| --- | --- | --- |
| `npm test` | 通过 | [最终日志](../tests/output/compute-sharing-acceptance-20260920/npm-test-stable.log)，包含 `testSharingCpaUsabilityV2`；MySQL 往返明确 skipped |
| `npm run test:ui` | 581 / 581 通过 | [最终日志](../tests/output/compute-sharing-acceptance-20260920/ui-tests-stable.log)，20 个测试文件 |
| 原有 mock E2E | 127 / 127 通过 | [最终日志](../tests/output/compute-sharing-acceptance-20260920/e2e-stable.log)，真实浏览器 + mock sidecar，不是 Tauri / CPA 联调 |
| `cargo test --workspace` | 通过，1 项 ignored | [日志](../tests/output/compute-sharing-acceptance-20260920/cargo-workspace.log)，包含相关 Rust 插件 |
| `cargo test --manifest-path cpa-plugin/Cargo.toml` | 29 / 29 通过 | [独立 CPA 日志](../tests/output/compute-sharing-acceptance-20260920/cpa-tests.log)，不是 workspace 的一部分 |
| 计量追加探针 | **3 项失败** | [生产 core 复现](../tests/output/compute-sharing-acceptance-20260920/accounting-probe.rs)、[日志](../tests/output/compute-sharing-acceptance-20260920/accounting-probe.log)：直接导入冻结的生产 `core_state.rs`，不复制算法；不冒充真实网络集成 |
| 交互/生命周期追加探针 | **4 项失败** | [探针](../tests/output/compute-sharing-acceptance-20260920/ui-probes.spec.js)、[日志及 trace 入口](../tests/output/compute-sharing-acceptance-20260920/ui-probes.log)：生产 JS + 浏览器 + mock sidecar |
| 发布元数据追加探针 | **1 项失败** | [探针](../tests/output/compute-sharing-acceptance-20260920/metadata.spec.js)、[日志](../tests/output/compute-sharing-acceptance-20260920/metadata.log)：以发布脚本实际输出的字段集合构造目录；未访问 OSS |
| 认领存储追加探针 | **1 项失败** | [探针](../tests/output/compute-sharing-acceptance-20260920/acceptance_store.rs)、[日志](../tests/output/compute-sharing-acceptance-20260920/store-probe.log)：真实 Rust 插件命令和临时 `ATL_HOME`，确定性交错读写，无真实认领或凭证 |
| 目录 DOM 性能 | **达标** | [日志](../tests/output/compute-sharing-acceptance-20260920/benchmark.log)：100 节点 × 3 资源，30 次交替模型筛选，点击至两次 `requestAnimationFrame`；p50 30.4ms，p95 **48.1ms**，最大 55ms，目标 ≤200ms |
| 中文窄桌面展示 | 基础展示完成 | 860×900 [借用页](../tests/output/compute-sharing-acceptance-20260920/zh-borrow-860.png)、[分享页](../tests/output/compute-sharing-acceptance-20260920/zh-owner-860.png)，已目视检查；编辑体验见 QA-06，Web 390px 未验 |
| JS 语法 / 空白检查 | 通过 | 插件、renderer、Web sharing、共享 i18n 的 `node --check`；`git diff --check` |

初轮 E2E 为 126 通过 / 1 失败，原因是规模用例在卡片初次加载前注入数据，遇到读取时序竞争。研发随后把注入移到挂载完成后并主动刷新，固定快照复跑 127 通过。该失败归类为 **case 时序问题**，不计入下述产品缺陷；保留[初轮日志](../tests/output/compute-sharing-acceptance-20260920/e2e-tests.log)。

追加探针目前为本次验收资产，不属于默认回归入口。修复时应将相应断言纳入正式测试，不能删除失败探针或降低断言使其通过。

## 3. 返工清单

### QA-01 · P1 · 发布目录丢失外部服务标记，卸载警示实际失效

**触发与结果：** 按当前发布脚本生成在线目录并加载插件，卡片 `data-external-service` 为 `null`，显示普通启用开关。第一次点击卸载就清除了 `installedVersion`，没有“仅卸载面板 / CPA 继续运行”的确认步骤。浏览器探针已复现；中文截图也显示普通“已启用”。

**根因：** [publish-module.js](../scripts/publish-module.js) 的 `catalogEntry`（固定快照第 168 行）复制权限等字段但遗漏 `manifest.externalService`；[renderer.js](../src/desktop/renderer.js) 的 `listRemoteInstalledModules`（第 5205 行）优先取整个在线目录对象，只有完全没有对象时才回退 first-party 元数据，因此本地补的标记被在线对象遮蔽。`bindRemoteUninstall` 依据缺失标记走直接卸载分支。

**研发处理：** 打通 manifest → 发布目录 → 宿主归一化/安装元数据的完整契约；对缺字段的已有目录采用明确迁移或修复策略。验证应使用发布脚本真实生成的目录，不能只给 mock 手工补字段后宣布通过。

**复验：** 在线目录、离线缓存、升级安装均显示面板语义；第一次卸载点击只展示解释，确认前保留管理入口；确认仅卸载面板后，隔离 CPA 服务及 Key 行为与说明一致。对应 **CS-01、CS-08 / V01、V16**，负责人角色：插件平台 + 发布。

### QA-02 · P1 · 心跳回包覆盖飞行期间新增用量，额度闸门重新放行

**确定性复现：** Key 和资源累计 40 → 心跳取走这批增量 → HTTP 返回前又完成 70 → 本地正确累计 110 → 收到只包含 40 的后端快照。执行生产恢复函数后，Key 和资源都变成 **40**；上限 100 时 `gate_request` 返回 **Pass**。

**根因：** [sync.rs](../cpa-plugin/src/sync.rs) 第 373～374 行直接恢复快照；[core_state.rs](../cpa-plugin/src/core_state.rs) 的 `restore_lane_settled`（496）与 `restore_key_charged`（321）直接覆盖，未叠加请求飞行期间仍在 `pending_buckets` 的增量。后续正常心跳可能追平后端账本，但这段时间的本地限额已经失真，不能视为满足“未确认增量不被覆盖”。

**研发处理：** 区分已确认基线与未确认增量，以明确的批次/窗口边界合并，既不覆盖也不重复加；不能用简单 `max(local, remote)` 代替协议，否则窗口切换和重试仍难以证明正确。

**复验：** 可控的 drain → 新请求完成 → 回包交错；Key/资源始终为 110，并拒绝后续请求。补充丢回包重试、重复 ack、窗口变化及未确认批次后的重启集成。当前 `pending_buckets` / `usage_seq` 仅在 Runtime 内存，静态检查未见待确认批次持久化；“恢复后端 seq”不能证明未送达增量可跨重启恢复。对应 **CS-06 / V04、V05**，负责人角色：CPA + 后端。

### QA-03 · P1 · 日/周边界后的事件被打入旧窗口，产生漏扣

**确定性复现：** 在 UTC 2026-09-21 00:00:00.001 结算事件，CPA 仍持有前一心跳。生产函数分别生成 `day:2026-09-20`、`week:2026-09-14` 的旧桶，而这些窗口均已结束。

**根因与影响：** [core_state.rs](../cpa-plugin/src/core_state.rs) `effective_lane_window`（208）只有小时窗口自行推进，日/周窗口直接沿用心跳值。[sharing-cpa.js](../src/backend/sharing-cpa.js) 第 835～849 行对已经关闭的桶仅累计 lifetime raw，不累计当前 charged。**事件其实发生在新窗口，却被错误当作迟到的旧窗口事件，形成新窗口漏扣**；旧窗口用尽时还可能继续拒绝本应恢复的请求。

**研发处理：** 日/周窗口计算与后端统一时区、n 倍周期及周起点；若当前协议数据不足以安全算出窗口，应阻止使用过期窗口并获取有效基线，不能继续错误记账。

**复验：** 日、周、5h 边界前后，UTC+8 等时区，高峰切换，以及心跳迟到时的 raw / charged / Key / 资源四方一致。对应 **CS-06 / V04、V05**，负责人角色：CPA + 后端。

### QA-04 · P1 · 旧后端“兼容运行”会丢失 Key 限额基线，缺少发布门控

**确定性复现：** 带 lanes 的旧后端提供 `settledByKey[key]=100`，Key 上限为 100，资源预算还有余量；CPA 重启恢复这份响应，但没有 v2 `keyLedger`。生产 `gate_request` 仍返回 **Pass**。

**根因：** [core_state.rs](../cpa-plugin/src/core_state.rs) 第 429 行在 lanes 模式只查询 `key_charged`，缺失时是 0；已恢复的旧账本不参与这个分支。CPA 的 `SyncState` 没有有效计量协议协商约束；[sync.rs](../cpa-plugin/src/sync.rs) 仍允许发送旧格式增量。能请求成功不代表降级后的额度规则正确。

**发布缺口：** manifest 没有最低宿主/sidecar 能力约束，[renderer.js](../src/desktop/renderer.js) `installRemoteModule`（5228）也没有安装前能力检查；卡片未根据控制面/节点能力门控新动作。研发记录同时说明远端后端尚未部署、JS 包已发布并移除旧目录版本。该远端状态来自研发记录，本轮未远程复核；本地代码中的无门控和基线丢失已确认。

**研发处理：** 按设计 §10 明确最低四组件组合和账本切换协议。不支持的组合停止新增借用并明确提示升级/修复；已有窗口从可证明的基线迁移。不要把缺账本当作零，也不要只用新端点报错代替门控。

**复验：** 旧宿主安装、旧后端 + 新 CPA、新后端 + 旧 CPA、窗口中升级、降级和回滚；上限已用尽的 Key 在重启/升级后不得多出额度。提供实际 backend / sidecar / JS / CPA 版本及迁移证据。对应 **CS-00、CS-06、CS-08 / V04、V05、V16**，负责人角色：集成负责人 + 后端 + CPA + 平台。

### QA-05 · P1 · 清理旧快照可删除另一进程刚认领的 Key

**确定性复现：** UI 读取 `[old]`，等待 live 结果期间 CLI 完成新认领并保存 `[new, old]`；live 判定 `old` 已撤销，UI 将最初快照过滤为空并调用 `borrow-set([])`。真实 Rust 命令落盘后结果为 **`[]`，new 丢失**。后端认领可能仍占名额，本机已失去对应凭证。

**根因：** [index.js](../plugins/compute-sharing/index.js) `refresh`（1660～1720）从旧快照生成整表覆盖写；[lib.rs](../plugins/compute-sharing/rust/src/lib.rs) `borrow_set`（139）只锁写入，没有锁住读—改—写完整操作。[flow.rs](../plugins/compute-sharing/rust/src/flow.rs) `merge_claim_record`（174）同样先读后单独调用写入，不能据此宣称跨进程不丢更新。

**研发处理：** sidecar 提供按 Key 合并/删除的原子操作，在同一把跨进程锁内重新读取最新状态并修改。UI 清理传确认失效的 Key ID，不回传旧完整数组；网络等待不必全程持有存储锁。认领、续期、撤销及过期清理使用同一原则。

**复验：** 上述交错后保留 `[new]`；再覆盖双认领、续期与清理、撤销与刷新等双进程场景。当前探针是对真实存储命令的确定性交错测试，不冒充真实后端双进程压测。对应 **CS-04 / V11、V12**，负责人角色：Rust sidecar + 桌面。

### QA-06 · P2 · 15 秒刷新还原策略草稿并打断编辑焦点

**浏览器复现：** 把单 Key 上限从 200000 输入为 123456，等待一次自动刷新：输入变回 **200000**，焦点离开输入框。资源名称草稿虽保留，但同样丢失焦点。

**根因：** [index.js](../plugins/compute-sharing/index.js) `renderOwner`（533）通过 `innerHTML` 整体重建 owner 区；只读取资源编辑器草稿，策略表单仍从服务端数据重新填值（623），且没有保留选区/焦点。

**研发处理与复验：** 将未保存草稿与服务端快照分离；刷新状态时保留编辑节点，或明确保存并恢复输入状态。连续输入跨过两次刷新，数值、焦点和选区都保持；保存后才用归一化结果回显，取消编辑才丢弃草稿。对应 **CS-02、CS-04 / V03、V14**，负责人角色：桌面插件。

### QA-07 · P2 · 页面隐藏仍轮询，销毁后监听器继续发请求

**浏览器复现：** 从插件页切到总览，16 秒后 owner-status 调用数从 **1 增至 2**。另外直接挂载并移除 20 个生产卡片实例，再派发一次恢复可见事件，已移除实例额外执行 **60 次 invoke**（每实例 owner-status、borrow-get、directory）。这是挂载/销毁生命周期测试，不是将直接移除 DOM 冒充 20 次原生切页。

**根因：** [index.js](../plugins/compute-sharing/index.js) 第 1802 行只检查整个 document 可见性，没有检查当前插件面板是否显示；第 1811 行的全局 visibility 监听不解绑，也不检查 `el.isConnected`；IntersectionObserver 同样没有统一销毁。宿主挂载流程未消费清理回调。

**研发处理与复验：** 建立卡片生命周期清理；取消 timer、解绑监听、disconnect observer，并使旧异步响应失效。面板隐藏时不轮询；真实切页/启停/重挂载 20 次后，回到当前面板仅有一个刷新来源。当前 DOM 性能达标不抵消这项生命周期失败。对应 **CS-04、CS-08 / V15**，负责人角色：桌面插件 + 平台。

## 4. 仍需补齐的设计流程

- **首次分享准备（V02）：** 当前 `renderEntryRow` 只显示静态安装/配置提示，没有设计要求的检查入口与未安装、未初始化、地址不一致、版本不支持等分项结果。源代码已核对，原生检测闭环未提供。CS-02 应补齐并用隔离的缺项环境逐项验证。
- **认领后的首次同步（V10）：** 当前 `claimShare` 保存后直接刷新；模型发现失败可进入错误态，连接测试只由用户点击发起。未见设计规定的节点同步等待、有限重试和明确最终状态。CS-03 应补充等待节点的状态契约；验证早于下一心跳使用新 Key 时不会重复认领、增加名额或直接误报永久不可用。
- **待确认批次的重启（V05）：** QA-02 已列出内存队列边界，应补真实进程重启验证；现有 seq 恢复单测和 29 项 CPA 单测不足以替代它。

## 5. V01～V16 逐项判定

| 编号 | 本轮判定 | 依据/剩余条件 |
| --- | --- | --- |
| V01 | **不通过** | QA-01；隔离 CPA 退出/卸载行为尚未实测 |
| V02 | **不通过** | 首次分享只有静态说明，缺检测流程 |
| V03 | **不通过** | 已有 API 回显用例通过；QA-06 的未保存草稿会丢失 |
| V04 | **不通过** | QA-02/03/04；普通 raw/charged 契约通过不能覆盖边界 |
| V05 | **不通过** | QA-02/03/04；重启未确认队列未通过验证 |
| V06 | 部分通过 | API 与 CPA 决策/浏览器 mock 用例通过；真实节点应用、TTL/管理员下架组合仍需集成 |
| V07 | 部分通过 | API 单 Key 撤销及 mock 卡内确认条通过；真实 CPA 传播及应用确认待验证 |
| V08 | 通过（mock 交互范围） | 混合节点模型前置筛选及规模目录用例通过 |
| V09 | 部分通过 | 工具/协议配置与模型发现的现有自动化通过；研发声称的真工具请求本轮未重复执行 |
| V10 | **不通过** | 未实现节点首次同步等待/有限重试闭环 |
| V11 | **不通过** | 陈旧 owner/清理回执已有覆盖；QA-05 仍可丢新认领，旧异步响应需随修复补测 |
| V12 | **不通过** | QA-05 真实存储命令交错失败；不是“有 flock 即原子” |
| V13 | 部分通过 | 信任说明、配置遮罩等已有 mock 覆盖；未扩展为真实节点日志/隐私审计 |
| V14 | **不通过** | en 自动化与 zh-CN 860px 基础展示已验；QA-06 焦点失败，Web 390px 待验证 |
| V15 | **不通过** | DOM p95 48.1ms 达标；QA-07 生命周期失败。派生算法独立 p95 仅有研发旧记录，本轮不重复认定 |
| V16 | **不通过** | QA-01/04；MySQL 迁移、四组件实际组合、旧宿主门控及回滚未闭环 |

没有运行 `npm run desktop`、真实 CPA/模型生成、`npm run verify:ccusage`、打包、真实 MySQL 迁移、远程部署或回滚。这些不记作通过，也不把研发上一轮“已调用模型”的记录当作本轮证据。本轮已发现确定性阻塞项，未进入发布打包阶段；最终交付仍须按设计与 AGENTS.md 完成相应门禁。

## 6. 研发复验交接

| 建议任务 | 负责人角色 | 交付范围 | 必须附的证据 |
| --- | --- | --- | --- |
| R1 控制语义发布修复 | 平台 + 发布 | QA-01 | 实际目录产物、在线/离线/升级三条宿主路径及隔离卸载行为 |
| R2 计量与版本契约修复 | CPA + 后端 + 集成人 | QA-02/03/04 | 3 个失败 core 探针转绿，心跳/窗口/重启集成，四版本与迁移/回滚记录 |
| R3 本地认领原子修改 | Rust + 桌面 | QA-05 | 存储探针转绿，双进程完整读写交错覆盖 |
| R4 编辑与生命周期修复 | 桌面 + 平台 | QA-06/07 | 4 个失败浏览器探针转绿，真实切页重挂载与原生手动复核 |
| R5 接入闭环及发布验收 | 桌面 + Rust + QA | V02/V10 与剩余矩阵 | 缺项诊断、首次同步等待、zh/en、Web 窄屏、MySQL、真工具及当前机器包证据 |

以上按角色可直接分派，尚未指派具体成员或发送外部消息。修复前先核对固定快照与研发当前分支的差异；认定已修复的项须给出修复提交和新证据，不以本文引用行号是否移动作判断。

重新提交验收的条件：明确列出本轮缺陷的处理结果；补充探针与原有回归通过；V01～V16 各自给出适合其边界的证据。未完成的发布/原生/MySQL 项保留未完成状态，不继续沿用“CS-08 DONE、全链路验收完成”的表述。

## 7. 研发响应记录（2026-09-20 晚，R1–R5 返工完成）

对应 §6 交接表，全部在 develop 分支完成；探针断言已转入正式测试，未删除或放宽任何验收探针。

| 任务 | 状态 | 修复提交 | 修复内容与证据 |
| --- | --- | --- | --- |
| R1 控制语义发布修复（QA-01） | **已修复** | `79bb34f` 之前的热修 + 本次 `40325e9` 系列 | `publish-module.js` catalogEntry 现在复制 `manifest.externalService`；renderer 改为字段级合并（first-party 逐字段兜底，不再被在线对象整体遮蔽）。已重发目录并经远程代理实测：catalog 中 `externalService:{kind:cpa,stopPolicy:independent}` 在位；真机卡片渲染「管理面板已显示」+「开关只控制本面板」说明；两步卸载确认链路 e2e 断言（online-modules 用例已适配）。 |
| R2 计量与版本契约（QA-02/03/04） | **已修复（CPA 0.5.1）** | `79bb34f` | QA-02：restore 叠加飞行增量（lane 与 per-key 均为 base+pending），探针转正为 `heartbeat_inflight_usage_is_not_overwritten_by_the_response`（40+70=110 且 gate 关闭）。QA-03：日/周窗口在插件内按后端同公式自滚（owner-tz anchor + civil_from_days），18 行跨语言真值表（后端 JS 公式生成）锚定；陈旧后端窗口不再落新窗。QA-04：无 protocol 字段的响应按旧后端处理，per-key 基线从 settledByKey 播种进当前车道窗（不再读零），探针转正 `legacy_backend_baseline_seeds_the_per_key_window`；pending 批次与 seq 持久化到 pending-usage.json 跨重启。 |
| R3 本地认领原子修改（QA-05） | **已修复** | `79bb34f` | sidecar `borrow_mutate`（同一把跨进程锁内读改写）；`borrow-prune` 命令只收确认失效的 Key ID，锁内重读最新状态；flow 的 claim 合并/renew/revoke 全部原子化；卡清理改传 dead ids。探针转正 `borrow_prune_keeps_claims_added_by_another_process`。 |
| R4 编辑与生命周期（QA-06/07） | **已修复** | `40325e9` | QA-06：策略草稿独立 Map，刷新重建保留已输入值+焦点+选区（连跨两次刷新），保存成功才清草稿；e2e 断言两次刷新后值仍为 123456 且保存值正确。QA-07：轮询仅在卡片已连接且可见（offsetParent 门控）时运行；visibilitychange 与 IntersectionObserver 在卡片脱离 DOM 时自清（解绑/disconnect）；e2e 断言离开面板 16 秒 owner-status 调用数不增长。 |
| R5 接入闭环（V02/V10） | **已修复（代码面）** | `40325e9` | V02：sidecar `doctor` 命令分项返回 身份/CPA 配置/后端地址/节点心跳 四项及各自提示，准备页「检查」按钮渲染分项结果（e2e 断言 4 项+失败 hint）。V10：新 Key 进入 ~14s「等待节点同步」窗口，窗口内测试失败自动重试一次、不判永久不可用（e2e 断言提示渲染）。 |

真机复核（本机 App 0.7.16 + 插件 0.1.1 + CPA 0.5.1，均为本返工后构建）：暂停点击出现卡内确认条（中文文案，修复生效——不再直接执行）；确认后因远端后端未部署而按预期 404，车道状态无变化（无副作用链路验证）。发布目录 `externalService` 经远程代理实测在位。

回归快照：npm test 全绿（含 round-seq 多桶用例）· test:ui 581 · mock e2e **131**（127+4 验收转正）· workspace 13 crate · CPA 32（3 个验收探针在内）· sidecar 21（交错探针在内）· verify:ccusage matched · node --check/git diff --check 通过。pending 跨重启持久化的真实进程重启验证仍列为待补集成项；四组件组合矩阵与 MySQL 真库迁移依赖后端部署，保留未完成状态。
