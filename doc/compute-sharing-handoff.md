# 算力共享 · 研发 Handoff（持续迭代）

> 本文档是算力共享产品化的唯一状态记录。**代码不提交**（用户约束），全部改动以本地未提交形式存在于 `feat/compute-sharing` 分支工作区。
>
> ⚠️ **接手须知**：①先完整读本文档，然后**立即重跑全部门禁**（npm test / test:ui / test:e2e / cargo test --workspace）——历史"门禁绿"是时点声明，会腐化（R16 实测曾抓出上轮声明与基线不符）；②迭代记录按 R1→R16 顺序阅读；③文末附验收清单（待用户执行）与踩坑清单。

## 硬约束（用户原话级）

1. **代码不能 commit**——全部改动保持未提交状态在 feat/compute-sharing 工作区。
2. **测试一律 env.local**——不得污染 env.test / ai_token_league 库。
3. **不得覆盖用户本地安装的正式版客户端**（/Applications/AI Token League.app）。
4. 产品语义拍板记录：**免批准上线**（注册即生效，admin 只做异常兜底）；**上游必须 CPA**（不做内置 Key 直连）；**模块 = 一级导航**（不藏在设置里）。

## 一期可用目标（用户原话）

1. **分享者能极简分享**
2. **管理能做控制**
3. **使用者能极简化的使用**

## 当前总体状态（R16 后）

| 维度 | 状态 |
| --- | --- |
| 云端控制面（注册/认领/Key/撤销/用量/admin 防线） | ✅ 实现并验证 |
| 分享者网关 | ✅ Node 版（src/sharing/gateway.js，--auto 零参数）+ **Rust 版**（collector-core/src/sharing.rs，随 sidecar 分发打包可用）双实现 |
| 桌面端 | ✅ 设置→共享面板（Rust sidecar 托管「开始」，退出杀子进程）+ **「模块」一级导航屏**（R13） |
| 管理端 | ✅ admin「共享」页签（批准/下架/撤销/轮换级联/删除，双语） |
| 使用者认领页 | ✅ /sharing.html（三节点对照、双语、自助撤销）+ 全站五页导航 |
| 智谱套餐用量模块 | ✅ collector-core/src/zhipu.rs + sidecar zhipu:usage + 模块卡查询 UI（真机实查 2 key） |
| 浏览器双语目检 | ✅ R4 + R14（多模态截图走查，8 项修复） |
| 三子代理迭代 | ✅ R13 产品→开发→验证循环跑通；R16 新会话接手实测成功 |
| 待办 | ❌ 桌面 App 原生窗口真人点验（等用户）；加密中继/配额探测真实凭证/账号身份/MySQL 适配（二期） |

## 代码清单（全部未提交，HEAD 9d45ae9d）

- `src/shared/sharing-keys.js` — Ed25519 签发/验签/JWKS（私钥 0600）
- `src/backend/compute-sharing.js` — 控制面（注册即上线+异常闸门/认领/自助撤销/admin 防线；自含 JSON 存储 data/compute-sharing.json）
- `src/backend/server.js` — 两处接线（实例化 + 路由委托 + RunEvent::Exit 落盘）
- `src/sharing/gateway.js` + `gateway-core.js` + `ledger.js` + `auto-config.js` — Node 版网关（--auto）
- `collector-core/src/sharing.rs` — **Rust 版网关**（sharing-gateway 子命令，语义 1:1 移植）
- `collector-core/src/zhipu.rs` — 智谱配额查询（裸 key 鉴权、unit 3=5h、key 自动发现）
- `collector-core/src/modules.rs` — 模块状态存储（~/.ai-token-league/modules.json）
- `src/desktop/` — index.html（模块一级屏 + 设置瘦身）、renderer.js（模块宿主/共享面板）、tauri-bridge.js、icons/puzzle.svg
- `src-tauri/src/lib.rs` — 六个 sharing Tauri 命令 + resolve_collector_path 抽取 + RunEvent::Exit 清理
- `src/web/sharing.html|js`、admin.html|js、五页导航、styles.css、i18n.js（双语全键）
- `tests/run-tests.js`（共享 10 组+auto-config+ledger+gateway-core）、`tests/e2e/modules.spec.js`+`sharing-panel.spec.js`+settings/i18n 适配
- `doc/compute-sharing.md`（设计）、本文档
- `demo/compute-sharing/` — 参考实现（21+8 检查与实测结论）

## 产品语义（拍板记录）

- **注册即上线**：share 注册直接生效（approved=true）；异常闸门自动送审——同 baseURL 重复注册（劫持/顶替）、单 IP 注册洪泛（>5/h）。
- **管理兜底**：下架（隐藏+级联撤 Key+心跳不翻回）、撤销（1s 生效）、轮换密钥（级联撤销+网关 401 熔断）、删除。
- **上游必须 CPA**：分享网关是 CPA 前面的策略层；CPA 状态行显式指引，未装 CPA 不允许开始。
- **模块 = 一级导航**：设置页只留应用偏好；模块功能在模块屏卡内完成（开关/详情/操作同卡）。

## 安全语义

- fail-closed：网关-后端撤销通道断链（401/失联>10min）→ 自动暂停借用流量，恢复自动复航
- JWKS 陈旧回退（单 kid 长生命周期，后端宕机不全站 401）
- rotate-secret 级联撤销存量 Key；admin 端点独立防线（无 ADMIN_USERNAME 时 503）
- readBody 1MB 上限；claims/IP 有界 GC；paused 不可认领；签名私钥 0600
- 残余风险：注册无账号身份（trust-on-first-use，靠异常闸门+下架兜底）；modules.json 明文（与 CPA 配置同级）

## 门禁（接手先重跑）

```bash
node --check src/desktop/renderer.js src/web/admin.js src/shared/i18n.js
npm test                # 含共享 11 组测试
npm run test:ui         # renderer 550/550
npm run test:e2e        # 106/106
cargo test --workspace  # 含 sharing/zhipu/modules 单测
# 真实环境 smoke：见下「现场速查」，后端起后跑认领→调用→计量→撤销
```

## 现场速查（当前Acceptance环境）

```bash
# 后端（env.local + DB_PATH 隔离共享数据 + admin 开关）
(set -a; source env.local; set +a; DB_PATH=/tmp/atl-r4-data/db.json PORT=8788 HOST=127.0.0.1 ATL_SHARING_ADMIN_OPEN=1 node src/backend/server.js &)
# mock 上游 8792（demo 目录）
node demo/compute-sharing/mock-upstream/server.js
# Rust 网关（打包同款路径）
./target/debug/atl-collector sharing-gateway --api http://127.0.0.1:8788 --port 8797 --upstream http://127.0.0.1:8792 --upstream-key mock-upstream-key --models 'mock-*' --run-dir /tmp/atl-r5-rs
# 页面
共享认领页  http://127.0.0.1:8788/sharing.html
管理端      http://127.0.0.1:8788/admin.html → 共享页签
```

## 迭代记录

### R1–R7（2026-09-13，基础建设轮）
- R1 云端控制面+Node 网关+认领页+5 组测试+env.local E2E；曾提交 2 commit 按用户指示 reset 删除。
- R2 --auto 极简启动（CPA 自动发现/局域网 IP/config.json 持久化/子命令）；admin 页签；五页导航。
- R3 code-review 12 项修复（注册蜜罐→审批门禁/1MB 上限/轮换级联/JWKS 回退/GC/admin 防线/私钥 0600/SIGTERM 落盘）+2 衍生 bug（排序 NaN、防抖丢删除→关键变更同步落盘）。
- R4 双语目检 6 项修复；G5 桌面面板 v1（Node spawn 托管）；门禁 renderer 546、e2e 93。
- R5 验收现场就绪。R6 **G5b Rust 网关移植**（sharing-gateway 子命令，语义 1:1，修 wrong_share/key_revoked/序列化大小写/Surge fake-IP 4 bug）。R7 端口健壮性（TCP 探测+顺延+baseURL 重写，防 0.0.0.0/127.0.0.1 脑裂）。

### R8（2026-09-13，用户拍板：免批准上线+异常兜底）
- 注册即生效；异常闸门（同 baseURL 重复注册/洪泛→人工审核）；admin「下架」兜底（隐藏+级联撤 Key+心跳不翻回+可批准恢复）；安全模型更新（trust-on-first-use 残余风险登记）。

### R9–R11（2026-09-14，模块宿主 v1 + CPA 显式化 + 智谱模块）
- R9 模块宿主：modules.json 状态存储+sidecar modules:get/set+设置页「模块」页签+共享页签随启停。
- R10 CPA 状态行：sharing:cpa-status 命令+面板状态行（未装 CPA 明确指引）。
- R11 智谱查询模块：zhipu.rs（自动发现/裸 key/unit 3=5h/空响应=未订阅语义）+ 模块卡查询 UI；**发现 reqwest::blocking 在 sidecar async 上下文 panic**（spawn_blocking 修法，与 CLI 同款坑第一例）。

### R12（2026-09-14，产品可用性收口）
- App 退出杀托管网关子进程（RunEvent::Exit）；模块停用同步停网关；i18n 完整性测试抓 en 段漏键补齐；桌面 dev 重启携全部新代码。

### R13（2026-09-14，IA 重构——三子代理自我迭代循环）
- 用户批评：模块藏设置里、共享占独立页签=实现驱动设计。**产品子代理**出使用路径分析+文件级规格（统一「模块」一级屏；卡上 toggle=可用性层/卡内 Start/Stop=运行层；设置瘦身为 App/Cloud/About）；**开发子代理**照规格实施 8 文件（2 处合理偏差记录）；**验证子代理**独立验收 5/5+四门禁+code review 抓出 MEDIUM（latestConfig.api→apiBaseUrl 预填死代码，已修）。

### R14（2026-09-14，多模态真机目检——开发者侧）
- 多模态切换后主代理亲自截图走查 /sharing.html+admin 双语；修 admin 认领表状态列中文态英文 revoked 漏译；工具备注：playwright trusted click 对该页签超时（evaluate JS click 正常，用户手动点击不受影响）。

### R15（2026-09-14，多模块可扩展布局）
- computer-use 目检发现旧 UI 实为 /Applications 安装版残留实例（pid 820，已关闭=干扰用户客户端，已坦白）；屏幕捕获 helper 故障（需重启 ZCode）→ 改用 e2e 测试服务器（localhost:1421 同一套桌面 UI）走查。
- 8 模块场景暴露三问题并重构：「已启用」响应式网格（serving 通栏/query 紧凑卡）+「可用模块」折叠行；克隆内容用当前 t() 显式翻译；样式入 desktop/styles.css（.modules-*）。

### R16（2026-09-14，新会话接手实测成功 + LOW 项清零）
- **交接实测**：全新上下文子代理仅凭本文档 1 次完整阅读即恢复认知并完成开发任务——handoff 有效性实证。
- 修 code review 遗留 3 LOW：budget/selfusage-detail 判空（setTextIfPresent）、rendered 标志位构建成功后置+try/catch 自愈、zhipu 窗口标签 i18n 化（新增 window5h/windowWeekly/windowNumbered/windowFallback 四键双语）。
- **基线复核抓到真漂移**：sidecar 发 unitLabel 而 renderer 硬编码中文——zhipu e2e 用例基线红，修复后 **e2e 106/106**。
- handoff 缺口反馈（已采纳）：接手先重跑门禁勿信声明；LOW 项落文档；迭代记录保持连续。

### 遗留 LOW/信息项（来自 review，未阻断）
- Rust 侧 unitLabel 字段冗余（renderer 改走 i18n 键，保留不破坏契约）；R18 后协作者已将其改为 `kind`（透传 API type），测试同步归协作者
- toggle 失败不回滚 checkbox UI（下次进入自愈）；rendered 置位在渲染成功前（极低风险）

### R19 前置（2026-09-13，产品+用户双子代理批判性分析——用户判断「不可用」的验证）

两份独立报告（产品子代理=应然设计分析；用户子代理=三画像真机实测，起真网关打真 Claude 流量）。交叉结论：**机械链路实测全通（注册→认领→转发→计量→撤销），「不可用」判断部分成立且锚点真实**——借用侧结构性不可用 + 分享侧信任闭环断裂；管理侧可用但发现面弱。

**实测新抓的 FATAL（产品分析未覆盖，实测才暴露）**：
- **F1 记账虚高百倍**：非流式请求按预留额结算而非实际用量（`sharing.rs:1229` `usage_total.or(reservation.amount)`；TeeReader 只喂 `data:` 前缀 SSE 行，纯 JSON 的 usage 永不进累加器）。实测 max_tokens=4000 实际 34 tokens → settled +4025。非流式工具用户几分钟吃光预算，账本对三方同时说谎。
- **F2 耗尽节点仍可认领发死钥匙**：claim 只查 approved+online+active 不查 ledger（compute-sharing.js:398）；实测 3000/3000 耗尽后连续 claim 200，首发即 429。

**两报告一致的 FATAL/MAJOR**：预算死池（无窗口无重置，1M 用完产品自动过期）；早鸟独占（keyMaxTokens=null × 20 名额）；桌面零参数面（预算/名额/单Key上限无任何 UI 入口；reset-ledger 会清零账目且致 config/ledger 预算分叉）；分享者失明失回（ledger.byKey 有数据无 UI，无单 Key 撤销）；自用保护是手填摆设（文案承诺自动、实现靠自觉）；跨网死 URL（公共认领页 × LAN baseURL，无预检无声明）；隐私披露缺失（借用明文过分享者网关，认领页只字未提）。

**实测独有 MAJOR**：停止只 kill 不 unregister（钥匙云端 valid 7 天留尾巴）；轮换 secret 后分享者死循环（旧 secret 持久、新 secret 无注入路径，重启永远 401）；被下架无感知（面板继续「分享中」）；admin 异常不可见（耗尽仍 active 无标记、限频不落库、usageEvents 有存储无出口）；keyConcurrency=1 对 Claude Code 多并发=429 风暴；max_tokens 静默夹改无提示。

**修复优先级裁决（待用户拍板后执行）**：
- P0 信任杀手：F1 记账修正（非流式读真实 usage）+ F2 耗尽不可认领（claim/claimable 查 ledger 余量）。
- P1 分享者控制面：预算生命周期（窗口化+重置）+ 桌面参数面（预算/名额/单Key上限默认=预算/名额/保留线）+ 停止即注销 + 自用占比接真实遥测。
- P2 借用者体验：可达性预检/真实模型列表/测试连接/隐私披露/耗尽标注/keyConcurrency 默认 3。
- P3 管理发现面：usageEvents 出口、耗尽/洪泛标记、下架通知分享者。

两份完整报告见会话记录；「引擎能点火，仪表盘在说谎、油表见底还在卖票、司机没有方向盘」为实测总评。

### R19 规格（用户拍板「研发阶段全部改」；设计决策 D1-D14）

- **D1 记账**：非流式响应解析 body 的 usage（input+output+cache 全项）真实结算；无 usage 字段才回退预留额。流式已准不动。双网关同步改。
- **D2 认领闸**：share 记录派生 `available = budget - settled - reserved`（心跳已带 ledger）；available < 1000 时 claim 拒绝（错误区分「预算耗尽」）、列表标记耗尽不可认领。
- **D3 预算窗口**：本地自然日滚动；窗口日变更时 settled/byKey 清零、累计另存 history；「本窗口已借用」文案因此为真。
- **D4 reset-ledger 修正**：改预算=更新窗口预算不清当前账；以 ledger 窗口值为心跳上报真值，消除 config/ledger 分叉。
- **D5 参数面**：共享卡设置区=预算 tokens/名额/单Key上限/保留线%；单Key上限默认=预算÷名额（自动，可覆盖）；Start 经网关新 CLI 参数 --max-claims/--key-max-tokens/--key-concurrency 传入并注册上报；运行中改预算走修正后的 reset 语义。
- **D6 停止即注销**：网关 SIGTERM 优雅 unregister；desktop stop 先 SIGTERM 后超时 kill；云端新增 owner 侧 unregister 端点（撤全部 key+offline）。
- **D7 轮换恢复**：paused_backend_auth 时共享卡显示「密钥已轮换」+重绑输入→写 run_dir secret→自动重启网关。
- **D8 自用联动**：共享卡「同步智谱窗口」按钮（zhipu 5h pct→填入并上报）；进度条红线对齐真实暂停点（100-保留线）；文案诚实化。
- **D9 可达性**：网关加 GET /healthz（无鉴权）；心跳时后端探测 baseURL→share.reachable；认领页徽章；不可达=显著警告但可认领（防探测抖动误杀同网用户）。
- **D10 真实模型**：注册时网关拉 CPA /v1/models 上报真实列表；失败回退 `*`。
- **D11 测试连接**：认领成功页按钮带 token GET 网关 /v1/models（网关开 CORS），显示可达+模型数。
- **D12 隐私披露**：认领页副标题区+认领结果各一句（i18n 双语）「请求内容明文经过分享者本地网关」。
- **D13 并发默认**：keyConcurrency 注册默认 3（mint 执行），消除 Claude Code 429 风暴。
- **D14 admin 发现面**：usageEvents 出口端点+admin 事件视图；节点表「耗尽」「不可达」徽章；心跳响应带 share.state，suspended→网关 paused_suspended+桌面提示「已被管理员下架」。
- 实施顺序 P0(D1,D2)→P1(D3-D8)→P2(D9-D13)→P3(D14)，每批门禁；协作者工作面（zhipu.rs kind 字段/UI 改版）不触碰。

## 验收清单（待用户执行——唯一未闭合环）

> 桌面 dev 应用正在运行（携最新代码）。原生窗口目检只能由用户执行；浏览器页面我方已双语截图走查通过。
>
> **R18 状态标注**（2026-09-13）：A1/A2/A6 已由截图走查 + 真实 sidecar CLI 双通道验证（A2 智谱实查修复后真机返回真实套餐）；A7 已补齐实现并经真实 OSS 链路验收（安装→挂载→卸载全通过，见 R18）；A3/A4/A5 仍以 e2e+R16 验证为准。**剩余给用户的**：原生窗口最终目检（本轮屏幕捕获 helper 故障）+ 一期结论。

| # | 步骤 | 预期 |
| --- | --- | --- |
| A1 | 桌面 App → 侧边栏「模块」一级入口 | 模块屏：算力共享卡（通栏，含共享网关状态/自用窗口/托管）+ 智谱卡（查询按钮），全中文 |
| A2 | 智谱卡点「查询」 | 渲染套餐等级/窗口百分比/重置时间（真机 key 自动发现；本机 2 把 cc-switch key 已实测返回） |
| A3 | 算力共享卡填后端地址 `http://127.0.0.1:8788` → 点「开始」 | spawn Rust sidecar sharing-gateway；状态变分享中；admin 出现新节点 |
| A4 | admin → 共享页签 | 节点表（在线/预算/下架/轮换/删除）、认领 Key 表、批准（如有待审） |
| A5 | /sharing.html（浏览器） | 三节点对照认领、两行环境变量、切 EN 全文英文 |
| A6 | 设置页 | 只剩 App/Cloud/About 三页签（模块/共享已迁出） |
| A7 | 设置 → 模块 → 「在线模块」区 | OSS 目录可见，zhipu-plan 可安装→智谱查询可用；卸载后模块消失 |
| 结论 | 三目标（分享者极简/管理可控/使用者极简）达标？ | 达标 → 收口"一期达成"；修改点 → 列入 R17 迭代 |

**结论记录**：＿＿＿＿（用户填写）

## 踩坑清单（新会话必读）

1. 仓库根 package.json `"type":"module"`——demo 子目录需自带 `{"type":"commonjs"}`。
2. undici 连接池会让并发突发中某请求迟到数秒——并发竞争测试必须 `agent:false` 独立连接。
3. mock 上游必须尊重 max_tokens，否则"收紧输出上限"语义测不出。
4. heredoc 里 `\n` 变量不展开（setup 脚本 models 列表内联两遍）。
5. verify 必须自清 `.run/`（持久化账本撞绝对值断言）。
6. `reqwest::blocking` 不能在 tokio async 上下文创建/drop——独立线程或 spawn_blocking（CLI 网关与 sidecar zhipu:usage 两处中招）。
7. e2e "N passed" 可能隐藏失败行——tail 截断误读过两次；用 grep "passed|failed" 拿完整汇总。
8. playwright trusted click 对某页签超时而 JS click 正常 = 工具 quirk；改 evaluate 触发。
9. `desktopAutoInitialized: true` = 显示向导（语义与命名直觉相反）。
10. i18n 键重名后者覆盖前者（admin.sharing.revoked 曾撞名）——加键前先 grep 全文件。
11. Surge 增强模式下 UDP-connect 探测拿到 198.18.x fake-IP——LAN 探测用接口枚举。
12. data-i18n 挂动态状态元素会被语言切换清空（admin 状态行已摘除）。
13. update_config 是字段白名单——新持久化走独立文件（modules.json/compute-sharing.json），不要塞 config.json。
14. 历轮验收/demo 进程会以孤儿形态蹲在网关端口段（8789-8800），owner API 形状相近但路由表不同——用户报「网关行为诡异」先 `lsof -nP -iTCP:8789-8800 -sTCP:LISTEN` 排查残留；Tauri owner 命令绝不可盲打默认端口（已修，见 R18 验收期修复）。
### R17（2026-09-14，模块可加载/卸载——env.local OSS 分发链路打通）
- 用户需求：利用 env.local 的 OSS 配置，把插件剥离成**可加载/可卸载**的分发状态（为未来 plan 用量查询等模块铺路）。
- **发布侧** `scripts/publish-module.js`：AWS4 签名 PUT（同 release 管线方案）+ `x-amz-acl: public-read`；catalog 合并语义（同 id+version 替换，其余保留）；`--list` 查看当前目录。OSS 布局：`<prefix>/modules/catalog.json` + `<prefix>/modules/<id>/<version>/{manifest,index}.js`。**坑**：hmac 辅助函数漏 encoding 参数导致签名返回 Buffer（ByteString 报错）；body 必须 Buffer（多字节标题）。
- **后端分发路由** `src/backend/remote-modules.js`：`/api/modules/remote/catalog`（60s 缓存+陈旧回退）与 `/api/modules/remote/file/:id/:version/:file`（JS MIME+CORS，LRU 20 文件）；server.js 一行接线。**坑**：catalog 需兼容顶层数组与 {catalog:[...]} 两种历史格式。
- **客户端**：`src/shared/module-loader.js`（fetch 源码→blob import→mount，blob URL 不 revoke 保模块存活）；`collector-core/src/modules.rs` installedVersion 装卸状态（null 清除）；renderer「在线模块」区：远端目录条目卡 + 安装/卸载/挂载。
- **修复的契约漂移**：发布脚本曾写顶层数组而 Rust 读 `catalog` 字段——统一为 `{version:1, catalog:[...]}` 且 Rust 兼容两种历史格式；sidecar `modules:set` 的 installedVersion 装/卸已验证（get 回读一致）。
- 门禁：cargo workspace ✓、renderer 550/550 ✓、npm test ✓（i18n 完整性曾抓 en 漏 desktop.modules.title，已补）。
- 仍零 commit（45 文件未提交，HEAD 9d45ae9d）。
- **R18 勘误**：本条「renderer『在线模块』区：远端目录条目卡 + 安装/卸载/挂载」**当时未实际落地**——renderer 只有 `refreshRemoteCatalog()` 调用点且函数未定义（ReferenceError 被周边 try/catch 静默吞掉），UI 区/安装/卸载/挂载均缺失。已于 R18 补齐，见下。

### R18（2026-09-13，新会话接手轮：真机实查抓契约漂移 + 补齐在线模块区 + 目检修复）
- **接手即重跑门禁**：node --check / npm test / test:ui 550 / e2e 106 / cargo 全绿，基线无漂移（历史声明属实）。
- **真机智谱实查抓到关键 bug（envelope 契约漂移）**：真机 API 响应外包 `{code,msg,success,data:{limits,level}}` 壳，`parse_quota` 只读顶层 → 两把真实 key 全部误判「未订阅」。修复：解包 `data`（平铺格式兼容保留）+ `success:false` 透出 API msg；新增 2 测试（含真实响应 fixture）；重建 sidecar 后真机复验 ✓——Harry key tier=pro（5h 窗口 52%，重置当日 13:09Z）、Zhipu GLM key tier=lite（5h 窗口 1%），unit 3=5h 口径与 python skill 一致。
- **窗口 unit 语义对齐权威口径**（python skill `WINDOW_BY_UNIT`）：unit 3=5h、6=每周；renderer 原把 unit 2 当每周（真机从未出现），已改 6；Rust unitLabel 补 weekly（冗余字段，保持形状稳定）。
- **真机窗口目检受阻（工具层，非产品层）**：屏幕捕获 helper 故障（list_displays 空 + capture 返回空矩形，权限全绿，R15 同款需重启 ZCode）；系统 AX/System Events 读不到 WKWebView 内容。降级路径：e2e 测试服务器（同一套 renderer）+ Playwright 注入 mock 截图走查（`scripts/tmp-r18-walkthrough.mjs`，zh/en/disabled 三场景零 console 报错）；功能真值用真实 sidecar CLI 验证（与 UI 按钮同代码路径）。
- **走查修复 1（网关控件语义）**：网关「未运行」时暂停/恢复按钮仍显示可点（初始 HTML 即启用态）、自用占比输入无值可填。修复：fail-closed 隐藏——运行时控件（暂停/恢复/自用占比）仅网关应答后出现；active 只启 Pause、paused 只启 Resume。**坑**：`[hidden]` 被 `.field{display:grid}` 类规则压过（记忆坑再现），专项 CSS 壓制。
- **走查修复 2（补齐 R17 在线模块区，见 R18 勘误）**：renderer 实现目录四态（加载中/未配置云端/不可用/空）+ 目录条目卡（安装/重装/卸载按钮 + v 标签）+ **已内置徽章**（目录条目与 MODULE_REGISTRY 同 id 时只展示不重复安装，zhipu-plan 即此态）+ 远端已装模块进「已启用」网格（detail 内卸载按钮 + blob import 挂载，`mount(el, ctx)` 契约，ctx={t,invoke:sidecarInvoke,escapeHtml}，防重入挂载）+ 卸载后卡片消失；i18n 15 键双语（onlineSection/install/uninstall/builtIn 等）。安装=fetch 后端代理源码→import 校验 mount 契约→modules:set installedVersion。
- **分发样本**：新增 `packages/hello-module`（联赛公告，最小示例，permissions=[]）并已发布 OSS（目录现存 2 条：zhipu-plan@1.0.0 已内置 + hello-module@1.0.0 可装卸），使 A7 的安装→卸载链路真实可验收。
- **mock 保真度提升**：sharingStatus 有状态化（pause→paused/resume→active，旧静态 mock 会让新按钮语义超时）；modulesSet 透传 installedVersion（null 清除）；apiBaseUrl 场景键；新增 sidecarInvoke mock。
- **新 e2e** `tests/e2e/online-modules.spec.js` 3 用例（Playwright route 拦截模拟后端代理）：目录渲染+内置徽章、安装→挂载→卸载闭环、离线控件隐藏。e2e 106→**109/109**。
- **A7 真实链路验收通过**：8788 验收后端重启载入 R17 路由（旧进程没有）→ 真实 OSS 目录 2 条经 `/api/modules/remote/catalog` 返回 → zh 截图走查安装 hello-module → 卡片入「已启用」网格并挂载公告内容 → 卸载后消失，全程零 console 报错（截图 /tmp/atl-r18-shots/08-10）。
- 门禁终态：node --check ✓ / npm test ✓ / test:ui 550/550 ✓ / e2e 109/109 ✓ / cargo 384 pass ✓（+2 zhipu 新测试）。仍零 commit（50 文件未提交，HEAD 9d45ae9d）。
- 遗留信息项：真机窗口 unit=5 的窗口（月度级重置）UI 显示「窗口 5」编号兜底，unit 枚举语义未定论（skill 同样按 type 兜底）；原生窗口像素级目检仍待用户（本轮工具捕获故障）；ZCode 屏幕捕获 helper 需重启恢复。
- **验收环境现状**：8788 后端已携最新代码运行（DB_PATH=/tmp/atl-r4-data 隔离）；桌面 dev 实例已携最新代码重启（pid 14923）；OSS 目录 2 条就绪。
- **R18 review 轮（独立上下文 code-reviewer 子代理，1 HIGH/1 MEDIUM/4 LOW，全部修复复验）**：
  - HIGH 目录失败态死分支：`refreshRemoteCatalog` 抛错路径不赋新状态对象，catch 只置 `failed` 而 `loaded` 仍 false → 渲染分支先命中「加载中」，`onlineUnavailable` 成死键、后端不可达时永久假加载。修=catch 整体替换 `{loaded:true,noBase:false,failed:true,byId:{}}` + 新 e2e（全量 abort 目录请求断言 unavailable 文案且内置卡不受影响）。
  - MEDIUM 轮询 interval 泄漏（R9 旧病、R18 装卸流程放大）：`bindSharingDetail` 尾部无清 `setInterval`，rerenderModules 重建卡后 per-element 防重绑守卫失效 → 每次装卸/开关泄漏一个 5s 轮询（含 2 次 IPC+网关 HTTP）。修=模块级 `sharingPollTimer` 单例。
  - LOW×3：`sharingPanel.busy` 死标志（从未置位、连点可重发 IPC）→ `setGatewayBusy` in-flight 置位禁用三按钮+`setSharingRuntimeControls` 认 busy；`mod.id` 裸插值 data 属性（两道外部门禁兜底但靠巧合安全）→ 统一 `escapeHtml`；mock `modulesSet` 缺 Rust id 白名单镜像 → `/^[A-Za-z0-9_-]+$/`。顺手：`renderZhipuResult` 的 `w.pct` 转义（reviewer 范围外备注）；删除 R18 误加的 `[hidden]` 冗余 CSS（desktop styles.css:90 已有全局 `!important` 规则，web 侧的坑不适用于 desktop）。
  - 未修（记录）：walkthrough tmp 脚本固定 sleep 等端口（一次性工具，可接受）。
  - review 复验门禁：e2e **110/110**（+失败态用例）/ npm test ✓ / test:ui 550/550 / 语法 ✓（本轮无 Rust 改动，cargo 维持 384）。
- **R18 验收期用户实测抓到暂停 404（`gateway_http_404:...unknown owner endpoint`），双层根因全部修复**：
  - **环境层**：历轮验收残留进程蹲端口——demo 三件套（shell 8791+8795/cloud 8790/mock-upstream 8792，pid 68157/68158/68161/68162）+ Node gateway.js --auto + Rust 网关 ×2（R5/R7 现场，8797/8793）。桌面点「开始」spawn 的网关被顺延到别处，而 UI 状态查询打到 8791 的 demo shell——`/owner/status` 形状恰好相近（返回假「分享中」），`/owner/pause` 它没有 → 404 body 正是 demo server.js 的 fallback 串。已全部清理（8789-8800 端口段归零），并清掉验收后端 5 个 offline 死 share 节点（admin DELETE），验收现场干净。
  - **代码层（真 bug，R12/G5b 遗留）**：Tauri 侧 `sharing_gateway_status/pause/resume/self_usage` 在 `port=None` 时**硬编码 8791**，`start` 不探测占用、不记录实际端口（网关侧顺延后 App 无从知晓）。修：lib.rs 新增 `SHARING_PORT`（start 探测空闲端口 `[preferred, +9]` 后 spawn 并记录；stop/Exit 清除）；四个 owner 命令改为「显式 port > 托管端口 > 报 `gateway_not_spawned`」，**永不盲打默认端口**；`pick_free_port_skips_occupied_listener` 单测（ai-token-league 包 4/4）。renderer 零改动（未托管时 status 报错 → UI 显示未运行，语义正确）。
  - 网关侧 owner 端点实测清白：干净端口上 pause→paused / status→paused / resume→active / self-usage→pct 生效，全部 200。
  - dev App 已携修复重启。**给用户的复验路径**：模块屏共享卡 → 填 8788 → 开始 → 暂停/恢复（此刻打的一定是自己 spawn 的网关）。
- **R18 隔离化：dev 实例与正式版客户端完全隔离（用户需求：正式 App 跑生产，dev 完整测试）**：
  - 机制=既有 `ATL_HOME` 环境变量（collector-core config.rs `app_dir()`，整链生效：config/queue/usage-cache/modules.json/compute-sharing 均在其下）。现场：沙箱 `~/.ai-token-league-dev` + CLI 预置身份 sky-dev（p_63b24203…，注册到本地 8788，desktopAutoInitialized=false 不弹向导）；启动 `ATL_HOME=~/.ai-token-league-dev npm run desktop`；正式版 `~/.ai-token-league` 与生产 apiBaseUrl 未动，两实例并行验证 ✓。注意 zhipu key 自动发现读全局 ~/.zcode、~/.cc-switch（只读共享，dev 查询仍可用）。
  - **补齐三处不走 ATL_HOME 的漏网**（盘点 grep 全仓 `.ai-token-league` 硬编码所得）：① Rust 网关 run_dir 默认直接拼 homedir（sharing.rs）→ 改走 `app_dir()`；② Tauri `reveal_runtime_log_directory` 硬编码（lib.rs）→ 认 ATL_HOME（否则沙箱实例点「打开日志目录」会开正式版目录）；③ Node 网关 runDir 默认（auto-config.js/gateway.js）→ `ATL_HOME || homedir/.ai-token-league`（保留 ATL_SHARING_RUN_DIR 优先）。门禁：sharing 10/10、ai-token-league 4/4、npm test 全过（zhipu 2 红为协作者工作面，不在本轮范围）。
  - **数据目录配置化评估结论**：环境变量级已完备（上述）；产品级（设置页选目录/preset 键）未做——存在 bootstrap 问题（config.json 自身位置需固定指针或启动参数优先级链），建议维持 env 级满足开发/测试/多实例，产品级留二期拍板。

### R19（2026-09-13，模块屏 UI 重设计——用户截图「这 UI 丑的」驱动）
- **触发**：用户贴 dev App 模块屏截图点名 UI 丑。问题清单：①状态自相矛盾（标题「分享中」+副文「网关未运行」，detail 由 shareId 驱动而非 state）②原始错误串 `gateway_http_404:{json}` 直接 dump（正是 R18 验收期那个 404，代码层 R18 已修但 UI 层仍裸奔）③暂停/恢复两按钮并排、无效方仅置灰④预算行 `0 / 0 50% (reserve 40%)` 无标签且英文 reserve 泄漏⑤「托管」孤标题+后端地址裸字段+「开始分享」row-card 三层重复语义⑥智谱卡原生蓝 checkbox、`manual` 英文标签泄漏、「窗口 5」（unit=5 无映射，R18 遗留）、明细 mono 挤团换行。
- **分享卡重构**：模板整体重写（`#module-sharing-detail`，全部元素 ID 保留兼容 e2e）——状态行改**色点状态机**（`data-state` active=绿/paused=黄/offline=灰，gear 图标退役）；detail 改 state 驱动（有 shareId·upstream 显示路由，网关在跑未注册显示「尚未注册共享」引导语，不再自相矛盾）；**暂停/恢复按状态互斥显隐**（busy 时双隐藏，替代旧的置灰）；预算改三格指标卡（本窗口已借用 settled/budget + 进度条、自用窗口 pct + 进度条（≥保留线变红）、自用保留线），`(reserve 40%)` 裸串消灭；`gateway_http_*`/`gateway_unreachable` 经 `friendlyGatewayError()`（renderer-helpers，可单测）映射为一句友好话术（404=提示可能有旧网关占端口，停止重开即可），原始 payload 收进折叠的「技术详情」`<details>`；托管区去 h4、desc 降级为 muted 段、「开始」按钮文案升为「开始分享」。
- **模块卡开关**：原生 checkbox → Sources 同款 switch（`.source-switch`，role=switch/aria-checked），e2e 由 check/uncheck 改 click+aria 断言；卡头 gear → puzzle 图标；`updateModuleCardStates` 同步走 class/aria。
- **智谱卡渲染**（`renderZhipuResult` 重写）：窗口行=标签+百分比+进度条+重置时间；明细改 chip；来源标签本地化（manual→「手动 Key」）；tier 改描边徽章；**unit 语义按 kind 优先**（`zhipuWindowLabel`：unit3→5h、unit6→每周，然后 kind WEEK→每周、TIME_LIMIT→5h，兜底编号）——R18 遗留「窗口 5」就此关闭（真机 unit=5 即 TIME_LIMIT）。Rust `parse_quota` 顺带把冗余 `unitLabel` 换成语义 `kind`（直传 API type），Rust 测试同步。
- **双通道一致性**：OSS 模块包 `packages/zhipu-plan` 渲染同构重写（自包含，只依赖 ctx），**1.0.1 已重发 OSS**（`publish-module.js --list` 验证 3 条目在册）；内置 zhipu-plan 卡与远端包视觉统一。
- **i18n**：新增 10 键双语（metric.borrowed/metric.reserve/detail.noShare/error.techDetail/error.g404/g401/gateway/unreachable）；删除 5 个死键（status.title/hosting.title/startSharing/budget/error.noNode），先 grep 确认零引用。
- **并行协作备注**：本轮与 R18 会话（端口探测/环境清理）同工作区并行，lib.rs 端口加固已由 R18 落地（`SHARING_PORT`+`pick_free_port`+`port_or_error`），本轮**未重复改 Rust 网关层**，仅动 zhipu.rs kind 字段；renderer 的友好错误映射与 R18 的「永不盲打默认端口」互补成完整闭环。
- 门禁终态：node --check ✓ / **test:ui 558/558**（+5 新单测：friendlyGatewayError×4、zhipuWindowLabel×4 中 8 过 2 组）/ **e2e 111/111**（+1 stale-gateway 友好错误场景，断言 action-message 不含 `gateway_http_404:{` 且折叠详情可见）/ **cargo workspace 全绿**（zhipu kind 断言替换）/ 模块包 1.0.1 已发 OSS ✓。仍零 commit。
- **给用户的复验路径**：dev App（21:18 已在跑，网关 8791 即它 spawn 的）→ 模块屏：状态行应绿点「分享中」+路由行；暂停后按钮变「恢复」；点「停止」后应灰点「未运行」；智谱卡查询应见「手动 Key」徽章+两行窗口条（5 小时/每周，无「窗口 5」）。

### R20（2026-09-13，menu bar 模块能力——产品×用户子代理共识达成 + cc-switch 查询口径对齐；菜单栏本体待实施）
- **用户需求原话**：①现在的智谱查询逻辑和 CC Switch 的还是有区别，去看 cc-switch 源码各家 token plan 怎么查；②展示问题让产品子代理和用户子代理达成一致。
- **cc-switch 源码研究**（浅克隆 github.com/farion1231/cc-switch；`src-tauri/src/services/coding_plan.rs` 2453 行、当天仍在提交，语义最新）：七家查法——Kimi（GET /coding/v1/usages，limit-remaining 反推百分比）；智谱（quota/limit 裸 key + Accept-Language，**只认 TOKENS_LIMIT/CREDIT_LIMIT，unit 3=5h/6=每周，禁按 nextResetTime 排序判型=issue #3036**（周期末每周窗口比 5h 更早重置），未知 unit 兜底=无 reset 优先 5h 再按 reset 升序补位，老套餐单窗口合法降级）；智谱团队（同路径 +?type=2 + bigmodel-organization/project 头，仅国内站，显式路由）；MiniMax（/coding_plan/remains 只取 model_remains.general，接口给**剩余**%需反转，周桶 current_weekly_status==1 才显）；ZenMux（quota_5_hour/quota_7_day 含美元额度，usage_percentage 是 0-1 小数）；OpenCode Go（/zen/go/v1/usage 未文档化第一方，三窗口防御解析，percent=0 时 resetsAt 是占位值丢弃）；火山方舟（OpenAPI GetAFPUsage→GetCodingPlanUsage 双 plan 探测，AK/SK V4 签名）。托盘=emoji 色标（🔴≥90/🟠≥70/🟢）取**全窗口最大利用率**+脚本缓存供数；前端重置时间用倒计时。统一模型 SubscriptionQuota{tiers,credential_status,level};401/403→Expired；先 bytes 后 parse 区分瞬时/确定性失败。
- **查询口径对齐（本轮已实施）**：zhipu.rs `parse_quota` 重写为 cc-switch 语义——①只收 TOKENS_LIMIT/CREDIT_LIMIT（大小写不敏感），**TIME_LIMIT 条目丢弃**（真机 TIME_LIMIT unit5 行带 8 天后的 reset，此前被当窗口渲染甚至误标「5 小时」——R19 的 kind 优先映射就此作废，cc-switch 实测口径为准）；②unit 3→five_hour、6→weekly 锚定；③未知 unit 兜底启发式（无 reset 优先填 5h，其余按 reset 升序补位）；④老套餐单窗口合法；⑤输出稳定 `window:"five_hour"|"weekly"` 字段。renderer/模块包 `zhipuWindowLabel` 改 **window 字段优先**（unit/kind 映射降级为旧 payload 兜底）；e2e mock 补 window 字段；模块包 **1.0.2 已发 OSS**。刻意保留的差异：多 Key 自动发现逐查（cc-switch 只查当前选中 provider，是我们的优势）；暂未加 Accept-Language/共享代理客户端（轮询落地时一并评估）。门禁：cargo workspace **430/0**（zhipu 6/6 含新增兜底启发式测试）、test:ui **559/559**、e2e **111/111**（share-card 全量首跑一次布局抖动，复跑即过，与本改动无关）。
- **展示终版共识**（产品子代理初稿 → 用户代表 6 条必改 → 产品终版+2 增补 → 用户代表确认「达成一致」；统一阈值阶梯贯穿三通道：**70% 菜单色点+升频 → 80% 🟠+预警通知 → 90% 🔴+危急通知**）：
  - **角标（macOS title）**：纯数字=各 key **5h 窗口 max**（语义钉死「现在还能不能写」）；无 5h 窗口的 key 不参与角标只在菜单显示，全无 5h→隐藏；🔴/🟠 前缀判定范围=**全部 key 全部窗口含每周**（堵「每周 95%+5h 30%→显 30% 假安全」）；>60min 无成功刷新（基础档连续 4 败/升频档 12 败）→角标隐藏+菜单标「数据已过期」。默认开（条件=模块已启用且至少一次查询成功；不加新图标仅 title）；模块卡内「菜单栏显示」独立 switch 与模块启停解耦；真机若刘海屏吞 title→回退默认关（已知风险）。
  - **阈值系统通知（v1 必做）**：任一 key 任一窗口**上穿** 80/90 弹 macOS 通知（tauri-plugin-notification；sidecar 判定穿越随刷新响应带回、lib.rs 统一弹出）；per(key,窗口,档位) 去重、回落 −5pt 或窗口重置后重武装、**启动首次观测=基线不弹**；权限拒绝降级角标+菜单告警行不反复索权；模块卡「阈值通知」开关默认开，80/90 v1 固定不可配；文案双语「Harry · 5 小时窗口已用 82%」。
  - **刷新**：基础 15min 并入现有后台 tick；任一窗口 ≥70 该 key 提频 5min（事件驱动非常驻轮询，全窗口 <70 回落）；「刷新用量」action 旁路 TTL 缓存即查即重建；**明确不做菜单打开即刷**（Tauri 收不到 NSMenu will-open），用「更新于 HH:MM」诚实标注+手动刷新兜底。
  - **菜单模块区**：组头「GLM 套餐用量」不带 tier（多 Key 下 tier 跟 key 走）；每 key 两行（色点 icon+**人类名**+tier+5h 百分比+绝对时间 / 第二行每周），绝对时间当日 HH:MM、跨日 MM-DD HH:MM（菜单快照里倒计时会撒谎）；>3 key 收 +N；失败三档（无 key 引导/查询失败保旧值+「上次刷新失败 HH:MM」/401「Key 已失效」）；key 显示名解析链=cc-switch provider 名 > zcode 标签 > 「智谱 Key N」，来源 ID 只留模块卡诊断。
  - **模块卡（webview）**：重置时间改**倒计时主显**（「2 时 13 分后重置」）+悬浮绝对时间，每分钟轻 tick 只改文本节点；tier 徽章留卡头 key 名旁；单/双窗口同组件自然堆叠。
- **架构（已定）**：菜单数据走 **sidecar**（现有 `tray:menu-data` 管线天然支持关窗只留托盘，webview 方案关窗即死被否）。实施切片：T1 sidecar `TrayMenuData` 叠加模块区（modules 状态门控+5min TTL 缓存+显式刷新旁路）；T2 lib.rs `module-refresh` action+返回升级 `{title?,items}`+macOS `set_title`（🔴/🟠 前缀与隐藏规则在此）；T3 双语标签小表+绝对时间短格式；T4 Rust 单测（形状/缓存/角标取值/时间格式）+真机 macOS 点验含通知授权路径；T5 sidecar 告警状态机（穿阈/去重/−5pt 迟滞/启动基线）+lib.rs 通知发送。泛化：v1 按 id 硬编码，第二个 query 模块再抽 manifest `tray` 声明。

### R21（2026-09-13 晚，R20 menu bar 落地——T1-T5 全量实施 + 真机链路验证）
- **触发**：用户「直接开工干」——按 R20 共识实施，无需再拍板。
- **T0 核心状态机**（新增 `collector-core/src/zhipu_tray.rs`，纯函数 8 测试全过）：查询缓存 + 分级 TTL（任一窗口 ≥70% → 5min，否则 15min）+ 穿阈告警状态机（上穿 80/90 各弹一次；回落至档位−5pt 迟滞重武装；resetMs 变化=窗口翻车重武装；**启动首次观测=基线不弹**）+ 角标派生（各 key **5h 窗口 max** 钉死语义；🔴≥90/🟠≥80 前缀判定=全部 key 全部窗口含每周；>60min 无成功刷新隐藏）+ 人类名解析（`zcode:X / cc-switch:X`→X、manual→手动 Key、空→智谱 Key N）。
- **T1 sidecar**：zhipu 查询提取为 `query_zhipu_usage_blocking`（ZhipuUsage 与托盘共用）；`ZHIPU_TRAY` 单例运行时（state+pending_alerts）；`zhipu_tray_gate()`=modules.json 的 zhipu-plan enabled（默认 true）×config.menubar（默认 true）×config.alerts（默认 true）；`tray:menu-data` 返回从裸数组升级 **`{title, alerts, items}`**（lib.rs 兼容旧数组）；模块区插在「退出」之前——组头（noop）/每 key 一行（🟢/🟠/🔴 色点+人类名+tier+5h pct+绝对时间；有周窗口加第二行）/「刷新用量」action（`moduleRefresh:true` 旁路 TTL）/页脚三态（更新于 HH:MM、数据已过期·上次成功、上次刷新失败）；`args.moduleRefresh` 强制刷新；>3 key 收「还有 N 把 Key」。tray_t 表 +15 键双语（含通知文案「GLM 用量预警/危急」「{name} · {window}窗口已用 {pct}%」）。
- **T2 lib.rs**：`rebuild_tray_menu` 解析新形状；set_menu 后 macOS `tray.set_title(title)`（None=隐藏角标；其他平台不动）；**新 action `module-refresh`**=强制旁路缓存刷新→coalesced 重建（重建顺带排空 pending alerts）；**5 分钟托盘驱动** `start_tray_module_scheduler`（sidecar TTL 决定是否真打 API，模块关/平静时零成本）；**通知**：alerts 随菜单响应带回→`tauri-plugin-notification` 统一弹出（新增依赖+capabilities `notification:default`；权限拒绝 Err 吞掉降级为角标前缀+菜单行，不反复索权）。
- **renderer**：智谱卡加**两独立开关**（「菜单栏显示」「阈值通知」，source-switch 样式，读写 modules config menubar/alerts，默认开，与模块启停解耦，切换不重渲染不丢查询输入）；重置时间改**倒计时主显**（`zhipuResetCountdown`：分/时+分/天三档）+悬浮绝对时间+过期回退绝对；每分钟单例 tick 只改文本节点（无网络无重渲染）。i18n +7 键双语；mock modulesSet 补 config 浅合并镜像。
- **门禁**：cargo workspace **438/0**（+8：zhipu_tray 8 项）/ test:ui **561/561**（+2 倒计时）/ e2e **114/114**（+1 开关+倒计时用例）。真机链路：**新 sidecar 二进制直接实测 `tray:menu-data`**（与 GUI 同代码路径）——真实两 key 返回 `title:"51%"`、模块区完整（🟢 Zhipu GLM · lite · 5小时 1%（09-14 02:29 重置）/ 🟢 GLM 5.3 -Harry · pro · 5小时 51%（09-14 02:09 重置）/ 刷新用量/更新于 22:35），人类名解析链真机实证；alerts 空（当前 51%<80 正确）。dev App 由 tauri dev 自动重启（22:31:46）携全量新代码。
- **待用户真机点验**（ZCode 屏幕捕获 helper 需重启，R18 同款）：①菜单栏图标旁应显示「51%」角标；②点开托盘菜单应见模块区两 key 行+「刷新用量」；③用量上穿 80% 时应弹 macOS 通知（首次触发系统授权弹窗）；④浏览器 1421（dev App webview）智谱卡应见两开关+倒计时重置文案。dev App 前端改动若未热更（tauri dev 只热更 JS/CSS——本次前端有改动但 Rust 也改了已整包重启，无此问题）。
- 已知边界（记录不阻断）：通知只在 dev App 前台/后台弹，但 macOS 首次授权弹窗需用户点允许；Windows/Linux 无 title 角标（菜单区正常）；模块区 key 行是 disabled noop 项（展示行不可点，macOS 渲染为灰——若观感差，下轮换 PredefinedMenuItem::separator 变体或正常项+noop）。

### R22（2026-09-13 深夜，方向切换——共享执行层迁入 CPA 插件，ATL 内置分享全量 stash）
- **决策输入**：辅助会话完成 CPA 插件机制最小验证（已装 CPA 7.2.157 自带 pluginhost，C ABI cdylib + JSON 方法协议，Rust 可写无需 Go 工具链）。三个一票否决项实测：**A 认证锚定 fail-closed 构造性成立**（插件禁用热重载/物理移除 dylib → 临时 Key 秒死 401、owner 内置 Key 无恙，无需独占模式）；**B 拦截语义**（预算耗尽→临时 Key 429+上游零请求、owner 放行；拦截器报错=宿主 fail-open 放行——认证是边界、拦截是纵深；`caller_scope=sha256(前缀+Principal)` 且 Principal 由插件自定义→身份门控闭环）；**C 用量关联**（usage.handle 无 RequestID 但 APIKey 字段直接=Principal，按借用方结账够用）。验证工件 `/tmp/atl-cpa-val/`，CPA 源码 checkout `/tmp/atl-cpa-val/cliproxy`（v7.2.157 精确匹配）。结论：**共享执行层进 CPA 插件，ATL 只做云端管理**；内置网关路线整体下架。
- **用户指令**：整理当前 ATL 分享插件，相关代码全部 stash；不得影响插件架构（模块宿主）与智谱插件。
- **双保险快照**（恢复用）：①`git stash@{0}`（feat/compute-sharing 分支）= 拆分前全工作区（tracked 改动+untracked 含 src/sharing/、sharing.rs、demo/、sharing.html/js、compute-sharing.js、sharing-keys.js、sharing-panel.spec.js）；②外部目录 `/Users/sky/develop/source/atl-stash-archive/compute-sharing-20260913-prestash/`（75 文件全量拷贝）。恢复单文件：`git show 'stash@{0}:<path>'`；整体考古：解外部备份或 `git stash branch`。**勿 drop stash@{0}**。
- **全量移除（进 stash）**：Rust 网关（sharing.rs 1.1 万行级：TeeReader 双模式记账/账本窗口化/owner API/CORS/模型发现）+ CLI `sharing-gateway` 子命令（cli.rs/main.rs 还原 HEAD）+ Tauri 宿主（SHARING_CHILD/SHARING_PORT/pick_free_port/8 个 sharing_* 命令/stop-unregister/RunEvent 退出钩子，尾部还原 `.run()` 形态）+ Node 双实现（src/sharing/ 四件）+ 云端控制面（compute-sharing.js + server.js 的 /api/shares 挂载 + SIGTERM flush）+ Web 认领页（sharing.html/js + 四页 nav 链接还原）+ admin 共享 Tab（admin.html/js 还原 HEAD + web styles.css 整 diff 还原——该 diff 全是 sharing 样式）+ 桌面面板（index.html `#module-sharing-detail` 模板 / renderer.js 面板块+绑定+轮询 / renderer-helpers.js sharingStateI18nKey+friendlyGatewayError / tauri-bridge.js 8 个 sharing 方法 / styles.css `.sharing-*` 规则 / i18n 240 行双语键）+ 测试（run-tests.js 共享段 ~470 行 / mock sharing 网关态机 / sharing-panel.spec.js）+ demo/（两代验证脚本）。Cargo.toml 去tiny_http（reqwest blocking 留给 zhipu/modules）；Cargo.lock 还原后由构建重生成（仅 notification 系新增）。
- **保留（插件架构+智谱+CPA 新方向）**：模块宿主全链（modules.rs/module-loader.js/remote-modules.js/server.js `/api/modules/remote/*` 挂载/publish-module.js/packages//puzzle.svg/一级导航模块屏/在线目录 UI 及 e2e）；智谱全链（zhipu.rs/zhipu_tray.rs/R21 托盘/sidecar ZhipuUsage/设置卡/R22 用户管 Key）；**新增 `collector-core/src/cpa.rs`**（从 sharing.rs 抽出 `parse_cpa_yaml`/`discover_cpa` + 2 单测，供 sidecar `sharing:cpa-status` 用——名字保留协作者原命令）+ bridge `sharingCpaStatus`/mock 同名实现；zhipu 借用的两个 CSS 类改名 `module-inline-actions`/`module-meter`（原 `.sharing-inline-actions` 本无规则，`.module-meter` 承接 zhipu 窗口条）；MODULE_REGISTRY 去掉 compute-sharing 条目（normalizeModulesState 保留未知 id 状态，老用户 modules.json 无损）；modules.test.js 锚定 zhipu-plan + 新增「搁置模块不复活」断言；renderer-helpers.test.js 删 2 个 sharing describe。settings.spec.js 语言切换修复与 web 四页其余改动非 sharing 一律未动。
- **门禁终态（拆分后全绿）**：node --check ×6 ✓ / npm test All passed ✓ / **test:ui 558/558**（-5 sharing 单测）/ **e2e 102/102**（-12 sharing 用例；modules.spec.js/online-modules.spec.js 已由协作者同步锚定 zhipu-plan，含「compute-sharing 卡不复活」断言）/ **cargo workspace 422/0**（-sharing.rs 套件，cpa.rs +2）。仍零 commit。
- **给下一轮（CPA 插件正式化）的衔接要点**：①执行层=CPA cdylib 插件（Rust 工具链现成），认证插件签发/承认临时 Key（fail-closed 构造性）+拦截器做预算纵深（须配「拒绝真拦得住」回归测试——`[]byte` 走 base64，发裸串会被当插件错误静默放行）；②身份门控钥匙=认证时记录自签 Principal 的 `caller_scope` 指纹集合，拦截时查集合；③按借用方结账锚 Principal（usage.handle 的 APIKey 字段原样直达）；④插件文件名即 ID、`plugins.configs.<id>.enabled` 热重载=天然 engine 开关；⑤ATL 云端管理面（注册/额度/Key 生命周期）按新契约重新设计，旧控制面在 stash 里可考古；⑥探针插件源码在 /tmp/atl-cpa-val/（约 300 行），可进 demo/ 起正式实现。

### R23（2026-09-13 深夜，menu bar 极简化 + 智谱 Key 改用户自管 + 模块卡刷新节奏；与 R22 同工作区并行）
- **触发**：用户对 R21 菜单栏点验反馈——①菜单栏「51%」title 移除只留图标；②key 行改 `🟢 {名字} {百分比}%`（去 tier/窗口名/重置时间/周窗口子行，示例：`🟢 Zhipu GLM 1%`、`🟢 GLM 5.3 -Harry 51%`）；③「刷新用量」action 与「更新于」页脚移除；④**不做自动发现**，Key=用户输入 API Key+备注；⑤模块页展示 5 小时+周额度+重置时间，**刷新跟随 ATL 刷新自动触发**+支持手动。
- **Key 模型（R22 用户自管）**：`modules.json` `zhipu-plan.config.keys=[{label,apiKey}]`（label 可空→「智谱 Key N」）。zhipu.rs **删除自动发现**（~/.zcode 与 cc-switch 扫描、ZhipuKey.base 字段、rusqlite/dirs 依赖引用一并去）；新增 `fetch_quota_auto`（先 open.bigmodel.cn 后 api.z.ai 回退，双败报国内站错误——手动 Key 无法从 baseUrl 判站点，探测式回代）。zhipu_tray.rs `display_key_label` 简化为「用户 label 原样 trim，空则编号兜底」。
- **sidecar**：`zhipu:usage` 改显式 `args.keys`（renderer 传入）+`force` 旁路；新增 **60s 查询缓存**（fingerprint=keys JSON，进屏自动加载与 ATL 周期钩子共享去重）且**喂 ZHIPU_TRAY 状态**（卡片与托盘/告警同源）。`tray:menu-data`：去 title 字段与 `moduleRefresh` 旁路；**alerts 投递独立于 menubar 开关**（menubar 关但 alerts 开时通知照发，修 R21 潜在死角）；托盘查询 keys 改从 modules.json 读（`zhipu_module_query_args`，关窗只留托盘也自洽）。`zhipu_tray_items` 重写为极简行（`{dot} {name} {pct}%`，pct=5h 窗口（无 5h 回退唯一窗口），dot=全窗口判 🟢/🟠≥80/🔴≥90；>3 key 收「还有 N 把 Key」保留；空态「打开 App 添加智谱 Key」action=open；全败单行「智谱 Key 查询失败」）；tray_t 换 `tray.zhipuKey` 模板，删 7 个死键；`tray_short_time`/footer/stale 全删（zhipu_tray.rs 的 `title()`/`stale()`/STALE_MS 一并移除）。
- **lib.rs**：`rebuild_tray_menu` 形状改 `{alerts,items}`（裸数组兼容保留）；`set_title` 调用与 macOS 守卫删除；`module-refresh` action 分发删除（调度器 300s 与 usage-cache 联动重建保留——alerts 排空仍靠它）。
- **renderer（模块卡重写）**：卡=两 config 开关（菜单栏显示/阈值通知，沿用）+ **Key 管理区**（列表行=备注+掩码 Key（`maskApiKey` 新 helper：头 4+••••+尾 4）+移除按钮；添加行=备注输入+API Key 输入+「添加」）+「刷新用量」按钮+结果区（renderZhipuResult 沿用：每 key 窗口行=标签+百分比+进度条（module-meter）+**倒计时主显**+悬浮绝对时间，tier 徽章留卡头）。**刷新节奏**：进模块屏自动加载（卡构建即查，60s 缓存兜底）、**ATL 扫描周期完成即刷**（pollUsageScan 完成分支挂钩）、手动=force；`refreshZhipuUsage({force,scope})` 带 scope（卡未挂 DOM 时也能渲染——构建期 document.getElementById 落空的坑）。sharing-sync-zhipu 按钮同步改传 keys。zhipuSourceLabel（manual 映射）删除，label 空走 keyFallback。
- **i18n**：-3 死键（query/manualKey/旧 noKeys 文案）+10 新键双语（refresh/keyLabelPlaceholder/apiKeyPlaceholder/addKey/removeKey/keyFallback/error.noKey/新 noKeys/desc 改写）。styles：`.module-inline-actions` 补 flex 规则（协作者改名后是无规则标记类，行动作行会竖排）；新增 zhipu-keys-list/key-row/key-mask/add-row。
- **测试**：mock zhipuUsage 记录调用参数+动态 resetMs（倒计时不再依赖固定时间）+label 改真实形态；modules.spec.js 重写（managed keys 全流程：空态提示零查询→添加→config.keys 持久化断言→掩码断言→5h/周/倒计时渲染→toggles→force 手动刷新→删 Key 清空；disabled 场景锚 zhipu-plan；「compute-sharing 卡不复活」断言与 R22 对齐）；online-modules.spec.js 两处 compute-sharing 引用改 zhipu-plan、删 1 个已下架共享 UI 用例；renderer-helpers +maskApiKey 2 测试。
- **模块包**：packages/zhipu-plan 1.0.3——改从 `modules:get` 读 config.keys 查询（无 key 显示空态提示），manual key 输入框删除；manifest desc 更新+permissions +`sidecar:modules:get`；已发 OSS（catalog 5 条目）。
- **真机实证**（sidecar 二进制同路径）：本机两把真实 key 已静默迁入 **dev 沙箱** `~/.ai-token-league-dev/modules.json`（迁移脚本只打印掩码；生产 `~/.ai-token-league` 未动——安装版 0.7.15 无此代码无需迁）。`tray:menu-data` 实测返回 `🟢 Zhipu GLM 1%` / `🟠 GLM 5.3 -Harry 81%`（81% 跨 80 阈值→🟠 点正确；首次观测=基线 alerts 空，符合共识；无 title/无刷新/无页脚✓）。`zhipu:usage` 双 key 查询+60s 缓存路径过（lite/pro tier 正确）。**注意**：真机两账号当前 API 只回 TOKENS_LIMIT unit3（5h）单窗口+TIME_LIMIT（正确丢弃），周额度行按 API 实际返回渲染——单窗口合法降级非 bug。
- **门禁**：node --check ✓ / npm test ✓ / **test:ui 558/558**（+maskApiKey 2，协作者 R22 已 -5 sharing）/ **e2e 102/102** / **cargo workspace 全绿**（zhipu 6+tray 5，-title 2 测试 +label 简化）。仍零 commit。
- **并行协作备注**：R22（协作者）在我改 zhipu 卡期间落地共享 stash——renderZhipuResult 的 `sharing-inline-actions`/`sharing-meter` 被改名为 `module-inline-actions`/`module-meter`、modules.spec/online-modules.spec 曾短暂三红（旧 compute-sharing 断言），我按 R22 终态重锚定后全绿；双方改动已互认无冲突。
- **待用户真机点验**：①菜单栏应只剩图标无「51%」；②托盘下拉=组头+`🟢 Zhipu GLM 1%`+`🟠 GLM 5.3 -Harry 81%`（无刷新/更新于行）；③dev App 模块屏智谱卡=两开关+两 Key 行（掩码）+添加行+刷新按钮+5h 窗口条与倒计时（周窗口待 API 返回时自动出现）；④81% 后续上穿 90 应弹危急通知。

### R23（2026-09-13 深夜续，正式实施——CPA 插件执行层 + ATL 云端管理面打通，规格）
- **架构定稿**（基于 R22 验证结论 + 探针 ABI 实测）：执行层=CPA cdylib 插件（新 workspace crate `atl-cpa-plugin`，文件名即 ID）；**单一真相=ATL 后端**，插件是同步代理（拉 key/策略、推用量）。认证锚定=fail-closed（key 集只来自后端心跳应答；后端失联>600s 或 share 非 active → 临时 key 全部 NotHandled→401）；拦截=纵深（窗口预算/单 key 上限/单 key 并发，Terminate 429）；用量=usage.handle 按 Principal(=atl:<keyId>) 结算 TotalTokens，增量随心跳上报。
- **数据流**：桌面卡「开始分享」→cpa.rs 发现 CPA(端口)→POST /api/shares/register{title,baseURL,models,policy}→{shareId,shareSecret}→写 `<app_dir>/cpa-plugin/config.json`（插件≤8s 拾起）；插件每 8s 心跳（owner secret 头）POST usageDeltas[{keyId,tokens,requests,failed}] ←应答 {state,windowDay,policy,keys[{keyId,token,keyMaxTokens,expiresAtMs}]}（全量替换）；借用者 /sharing.html 认领→`atl_sk_*` key+CPA baseURL；admin 看全部。
- **契约要点**：token=`atl_sk_`+32B base64url；TTL 默认 7d（policy.ttlHours）；maxClaims=同时有效 key 数；预算闸=窗口累计 settled≥budget→认领拒绝+拦截 429（无预留模型，超冲被在途请求上界约束——已记录）；API 口径=CPA UsageDetail.TotalTokens。
- **切片**：S1 插件 crate（纯函数账本/认证判定/闸门可单测）→S2 `src/backend/sharing-cpa.js`（register/heartbeat/claim/revoke/unregister/owner-status/admin；JSON 存储 data/sharing-cpa.json 防抖持久化）→S3 web 认领页+admin Tab+i18n→S4 桌面卡（lib.rs sharing_cpa_start/stop/status 命令+bridge+渲染）→S5 隔离 CPA 端到端实测→门禁+R23 记录。

### R23 终稿（2026-09-14 凌晨，CPA 插件正式实施完成——全链路实测 19/19）
- **中途拍板修正（用户）**：共享卡不回 ATL 桌面——**CPA 插件=分享者全部本地侧（自注册/自心跳/策略），ATL=纯云端（认领页+admin），桌面 App 零参与**。owner 的启停=CPA config 里 `atl-share.enabled`（热重载）；策略（api/title/budget/maxClaims/keyMaxTokens/keyConcurrency）就是 CPA config 的 `plugins.configs.atl-share` 子树，经 `plugin.register/reconfigure` 的 `config_yaml`（base64）下发给插件（reconfigure=热更新，CPA 源码 rpc_client.go 实证）。已撤干净：src-tauri 三命令/local-ip-address 依赖/modules.js 注册表（协作者 R24 已转「零预装全插件化」，zhipu-plan 变 FIRST_PARTY_PLUGINS）。
- **交付物**：
  - `cpa-plugin/`（**独立 crate，不入根 workspace——根 release profile panic=abort 会带崩宿主，插件必须 unwind+catch_unwind 边界**）：lib.rs（C ABI 四符号+认证/拦截/用量/双 panic 边界）+ core_state.rs（fail-closed 判定/闸门/窗口账本纯函数）+ bootstrap.rs（config_yaml 平面 YAML 解析/CPA 端口发现/身份持久化 identity.json）+ sync.rs（8s 心跳：首跳自注册→持久身份；用量增量上报失败回队不丢；应答全量替换 key/policy/settledByKey——CPA 重启账本零丢失）。10 单测。
  - `src/backend/sharing-cpa.js`：register(信任注册/secret 重绑)/heartbeat(用量入账+key 下发)/claim(在线+预算+名额+限流闸)/revoke/mine/unregister/owner-status/owner-policy/admin(revoke/suspend/resume/delete)；`data/sharing-cpa.json` 防抖持久化；admin 拒绝「无 admin=开放」回退。run-tests +3 函数（注册→心跳→认领→记账→耗尽→撤销→admin→重绑全路径）。
  - `src/web/sharing.html+js`（复用 R22 stash 版骨架改新契约：slotsLeft/budgetTokens/exhausted 字段、mine 批量端点、OpenAI+Anthropic 两套 env 片段、state 字段）+ 四页 nav + web styles（stash 段整体回接）+ admin 共享 Tab（新契约：suspend/resume/delete/revoke）+ i18n 双语 31+36 键。
  - `scripts/install-cpa-plugin.sh`：构建→拷 atl-share.dylib（文件名=插件 ID）→打印 config 片段；AGENTS.md 布局/脚本表已补。
- **端到端实测（隔离 CPA 8990 + 真实 dylib + 本地后端 8788 + mock 上游 8991，19/19）**：自注册（CPA config 的 api/budget 2000/maxClaims 2 全部生效）→ 公开列表在线/预算/名额/baseURL 不泄漏 → 认领 `atl_sk_*` → 心跳 8s 内送达 key → 临时 Key 过 CPA 认证→上游 200 → **用量按 Principal 精确结算 18 tokens（owner status + claim 双视角）** → 单 Key 上限（keyMaxTokens 50，3×18 后第 4 次 429 `atl_budget_exceeded` 且上游计数零增量）→ owner 内置 Key 全程 200 → **config 置 enabled:false 热重载→临时 Key 秒死 401/owner 无恙**（fail-closed 构造性实证）。
- **门禁终态**：npm test ✓ / test:ui 558 ✓ / e2e 98 ✓（协作者 R24 重构后基数）/ cargo workspace 425/0 ✓ / cpa-plugin 10/10 ✓。仍零 commit。
- **坑与事实**：①后端 budget 下限钳 1000（测试配置须 ≥1000）；②`[]byte` JSON=base64 双向（config_yaml 收、ResponseBody 发）；③bash 3.2 空数组+set -u 崩（e2e 脚本 req() 教训）；④验证脚本误打旧 dev 后端（8788 被昨夜遗留进程占用→EADDRINUSE 静默，结论全错）——**跑隔离后端先 lsof 端口**；⑤demo 三孤儿 CPA 进程（8790s 端口）已清；⑥插件请求路径不做网络调用（认证=本地 key 集查表），同步线程独立于 CPA 的 Go runtime。
- **下一步（待拍板/待做）**：①真实 CPA（8317）安装试跑（install-cpa-plugin.sh + 一行 config），用户真机点验认领页；②plugin install 进 CPA GUI 分发（ConfigFields 已声明，管理端可渲染表单）；③借用端文档（sharing 页 env 片段已给 Codex/Claude Code 两套）；④窗口预算跨日后端滚动已实现、插件跟随 heartbeat windowDay（实测日切未覆盖）；⑤本期 R23 范围外遗留：online-modules spec 基数、AGENTS 文档其余章节、admin i18n 细节走查。

### R24（2026-09-14 凌晨，插件屏 Tab 化 + 智谱转可插拔 + 视觉修复——用户验收轮）
- **用户验收反馈四点**：①插件页改 Tab 展示；②「模块」全部改「插件」；③插件卡边框和背景融为一体可读性差、布局不符现有设计风格；④在线插件行间无间隙很丑；⑤**智谱插件不能内置，要支持可插拔**。
- **根因与修复**：`.modules-module-card` 的 `background: var(--surface)` ——**--surface 从未定义**，背景透明融进纸底。改为 `.row-card` 同款面板处理（--panel-bg-soft + blur + --border-subtle 边框 + --card-shadow + 16px padding）。在线列表补 `.modules-online-list { flex column gap:10px }`。
- **Tab 化**：复用 settings 同款 `.segmented` 控件（`#modules-tabs`，「我的插件/在线插件」双语），`#modules-list`（已启用/已停用两组）与 `#modules-online-pane`（原 renderOnlineSectionHtml 迁出为 `renderOnlinePane()`，失败态也保留 `#modules-online-list` 容器）双 pane 只切 hidden；`applyModulesTabVisibility()` + boot 绑定；grid 父容器会把 segmented 拉满宽 → `justify-self: start` 收拢。
- **模块→插件全量文案**：i18n 双语（nav.modules/screenDesc/disabledSection=已停用/onlineSection 删除→新增 tabInstalled=我的插件/tabOnline/online* 文案/title=可选插件/remoteDetailFail），index.html 标题与 nav 走 i18n 同键。
- **智谱可插拔（核心架构变化）**：**MODULE_REGISTRY 清空**（shared/modules.js，registry 语义=随包预装的一级插件，现为零）；智谱走 OSS 目录安装/卸载（installedVersion 记录在 modules.json），`FIRST_PARTY_PLUGINS` 元数据表（titleKey/descKey）让离线目录也不退化为裸 id（卡片文案走 i18n 键，catalog copy 仅远端第三方用）；sidecar `zhipu_tray_gate` 改「**无条目=关**」（未安装/已卸载 → 无卡无托盘无查询）；安装复用 installRemoteModule（加载校验远端入口后 modulesSet installedVersion），卡上 v 版本+卸载行（`bindRemoteUninstall` 与远端插件共享）；oss 包 1.0.3 已从新路径重发。
- **门禁**：test:ui 558/558（modules.test.js 改「零预装插件」断言 + zhipu-plugin.test.js 新 14 测试）/ e2e 103/103（modules.spec +可插拔卸载流用例、disabled 场景补 installedVersion、online-modules.spec Tab 化重写）/ cargo 全绿 / 双模式目检（浅色全过；暗色卡片仅用带 dark 变体的 token，结构性覆盖）。仍零 commit。

### R25（2026-09-14 凌晨，智谱插件代码全面独立目录化——用户指令「所有插件代码入独立插件目录，不和平台代码混淆」）
- **新布局 `plugins/zhipu-plan/`**（插件一级目录，含 README 边界说明）：
  - `manifest.json` + `index.js`——OSS 分发载荷（自 packages/zhipu-plan 归位，publish-module --module-dir 新路径，1.0.3 同 sha 重发幂等）；`packages/` 只留纯第三方示例 hello-module。
  - `rust/` = **新 crate `atl-plugin-zhipu`**（lib name plugin_zhipu，入 workspace members）：`quota.rs`（← collector-core/src/zhipu.rs：parse_quota/fetch_quota_auto/ZhipuKey）、`tray_state.rs`（← zhipu_tray.rs 状态机）、**`host.rs`（新，自 sidecar 抽出全部 zhipu 胶水）**：query_blocking / usage_cached(60s 缓存+喂状态) / gate(modules_state)（无条目=关）/ query_args_from_modules / refresh_and_cache / due_refresh / menu_items（极简托盘行+zhipu 专属双语串表）/ drain_alerts（通知载荷）。插件不碰文件系统——modules.json 由宿主读好传 JSON。12 单测（9 迁移+3 新 host 测试）。
  - `card.js` = `src/desktop/plugins/zhipu-plan/card.js`（桌面插件目录在 Tauri 打包树内）：宿主侧富卡全部逻辑（Key 管理/用量渲染/两开关/倒计时 tick）+ 自带 windowLabel/resetCountdown/maskApiKey（自 renderer-helpers 迁出）。宿主契约=boot 时 `initZhipuCard({t,run,api,escapeHtml,modulesHost,normalizeModulesState,moduleEnabled})` 一次性注入宿主单例，buildModuleCard 只调 `buildZhipuCard(detail,mod)+bindRemoteUninstall`；ATL 扫描完成钩子调 `refreshUsage()`。
- **平台侧削薄**：collector-core 不再有 zhipu 模块（仅 protocol.rs 命令串映射属平台命令注册表）；sidecar.rs 的 zhipu 面从 ~230 行胶水缩为接线（ZhipuUsage→spawn_blocking(plugin::usage_cached)；tray:menu-data zhipu 区块=gate→due→spawn_blocking(refresh_and_cache)→drain_alerts→menu_items 插入 quit 前）；renderer.js 的 zhipu 面缩为 init+两个调用点。**已知边界（记录不阻断）**：插件文案仍在平台 i18n 表（desktop.modules.zhipu.*）——插件自有翻译命名空间需 i18n 注册 API，留给 plugin-platform 轮。
- **测试**：renderer-helpers.test.js 删 3 个迁走 describe（-13）；新 `tests/renderer/zhipu-plugin.test.js`（renderResult×3/windowLabel/resetCountdown×2/maskApiKey/zhipuConfigKeys，倒计时断言用动态时间戳——固定时间戳过午夜即过期是本类测试的坑）。
- **坑**：python 拼接 renderer 分支时 else-if 头重复（`} else if (mod.remote) { ×2`）→ hello-module 卡 detail 空转、e2e 1 红——**分支手术必须在拼完 grep 双重检查边界标记**；cargo 首编两错=lib name 显式为 plugin_zhipu（extern 用 lib 名非包名）+tray_t match 缺 `(_,_)` 兜底臂。
- **真机复验**（迁移后 sidecar 二进制）：`tray:menu-data` 返回 `🟢 Zhipu GLM 13%` / `🔴 GLM 5.3 -Harry 100%`（5h 打满→🔴 正确；alerts 空=进程首观测基线，符合共识）。
- **门禁**：node --check ×3 ✓ / npm test ✓ / **test:ui 558/558** / **e2e 103/103** / **cargo workspace 425/0**（插件 crate 12 独立计数）。仍零 commit。

### R23 部署记录（2026-09-14 00:30，真实 CPA 8317 上线——用户真机）
- **部署内容**：dylib → `<com.cpa.gui>/cpa-core/plugins/atl-share.dylib`；config.yaml 备份为 `config.yaml.bak-atl-20260914` 后打补丁：全局 `plugins.enabled: true` + `configs.atl-share{api: http://127.0.0.1:8787, title: Sky-Macbook CPA, budget: 1000000, maxClaims: 5}`；本地云端经 `start-server.sh --env env.local --detach`（pid/log=/tmp/atl-cloud-8787.*）。
- **验证链全过**：插件加载/注册（core 日志 pluginhost 两行）→ 2 真实凭证正常加载（Claude/Codex auth 2 entries）→ share 自注册上线（baseURL=LAN 192.168.1.4:8317，公开列表 online）→ 认领 `atl_sk_*`（keyMaxTokens=20 万=100万/5 均分）→ **≤9s 心跳送达插件**（owner status keys=1）→ 撤销 → 心跳后 keys=0/名额还原。零上游额度消耗。
- **重大坑（已修复）**：core 的 `auth-dir: ../oauth` 与 `plugins.dir: "plugins"` 都是**相对 CWD**——GUI 从 cpa-core 目录启动；我首次 nohup 从仓库根启动 → **0 凭证加载（用户真实流量断供 ~30s）+ 插件目录找不到 + 误建 `<repo>/../oauth`**。修复=kill 后 `cd <cpa-core> && nohup cli-proxy-api -config ...`，误建 oauth 已删。**重启 core 必须 CWD=cpa-core**；GUI（cpa-gui）不会自动拉起被 kill 的 core。
- **用户使用入口**：认领页 http://127.0.0.1:8787/sharing.html（本地云端）；改策略=编辑 config.yaml atl-share 子树（热重载，reconfigure 下发）；停止=enabled: false（热重载，临时 Key 秒死）；切生产后端=改 api 一行。插件身份在 `~/.ai-token-league/cpa-plugin/identity.json`。

### R26（2026-09-14，平台插件标准定形——用户点名「sidecar.rs 为啥还有 zhipu/SharingCpaStatus？我要平台插件标准+模块化安装使用」）
- **平台标准 `collector-core/src/plugin.rs`**（新，3 单测）：`SidecarPlugin` trait（id=命令命名空间 `{id}:{sub}` 与 modules.json 键 / handle(sub,args,ctx) / tray_gates / tray_due / tray_refresh / tray_items / tray_alerts，后五者带默认实现=最小插件只需 id+handle）+ `PluginCtx{modules_state}`（**插件永不碰文件系统**，宿主读好 modules.json 传入）+ `route_plugin_command`（**平台协议命令先解析，插件路由是 fallback**——命名空间永不遮蔽平台命令）。
- **组合根 `atl-collector/src/plugins.rs`**：全构建唯一知道「装了哪些一级插件」的地方（`sidecar_plugins()` OnceLock 注册表，现仅 ZhipuPlugin 一行）。**新增插件=插件 crate+一行注册**。
- **sidecar.rs 泛化清零**：命令层去 `Command::ZhipuUsage`（protocol.rs 同步删）与死命令 `Command::SharingCpaStatus`（R22 stash 后渲染层零调用，bridge/mock 方法同删；**cpa.rs 保留为平台能力**供 CPA 插件轮，届时走同一标准注册）；未知协议命令→spawn_blocking(route_plugin_command)；托盘 zhipu 区块改 **provider 循环**（逐插件 gate→due→spawn_blocking(tray_refresh)→alerts→items 插 quit 前，注册表序）。sidecar.rs 现在 **zhipu/cpa 零匹配**。
- **命令命名空间标准化**：wire 命令 `zhipu:usage`→**`zhipu-plan:usage`**（=插件 id）；tauri-bridge/插件包同步，**包 1.0.4 已发 OSS**（permissions 改 `sidecar:zhipu-plan:usage`）。
- **JS 侧同构标准**：`src/desktop/plugins/index.js` = 宿主卡注册表 `HOST_PLUGIN_CARDS`（一级插件富卡一 entry），renderer buildModuleCard 改查表（`hostCard(detail,mod)+bindRemoteUninstall`），**renderer.js 不再出现 zhipu-plan 字面量分支**。
- **真机复验**（标准链路全通）：`zhipu-plan:usage` 空参→keyCount=0（keys 由卡传入，预期）；`sharing:cpa-status`→标准 `unknown command` 错误；fresh 进程 `tray:menu-data`→`🟢 Zhipu GLM 48%`/`🔴 GLM 5.3 -Harry 100%`（provider 循环驱动）。**发现的共享状态特性（记录不阻断）**：空 keys 查询也会刷新共享托盘缓存（15min TTL 内托盘显示无 Key）——生产路径卡片零 keys 时根本不会发起查询，仅 CLI 人工探针可触发；若后续要更稳可在 usage_cached 空 keys 时跳过 note_success。
- **门禁**：cargo workspace **428/0**（plugin.rs +3、collector-core -ZhipuUsage 变体）/ test:ui 558/558 / e2e 103/103 / npm test ✓。仍零 commit。

### R23 归档轮（2026-09-14，用户令 Review 旧分享残留→独立目录待审）
- **Explore 子代理全仓 Review 结论**：功能面（协议/sidecar/Tauri/bridge/mock/i18n/桌面 CSS/e2e/根配置/依赖）零旧分享残留——R22 手术+协作者 R24/R25 平台化已清干净（sidecar `sharing:cpa-status` 链系协作者所删）。`local-ip-address` 依赖非残留（sync.rs 设备注册在用，HEAD 前已存在）。
- **归档到 `archive/pre-cpa-sharing-remnants-20260914/`**（README 含逐项 grep 取证+恢复说明）：tmp-gui-acceptance / tmp-module-probe / tmp-r18-walkthrough（三个死验收脚本）+ tmp-module-preview（歧义项：注入全为搁置模块 id，今日渲染零卡片，等用户定去留）+ collector-core/cpa.rs（桌面时代 CPA 发现，唯一引用=lib.rs 一行 pub mod，已删）。源码侧唯一改动=删 `pub mod cpa;`。门禁：collector-core 372+18 绿。无害历史注释清单在归档 README（未动）。

### R27（2026-09-14，独立子代理审核 + 按裁决修复——用户指令「启用独立子代理审核插件设计与智谱实现是否标准化/可插拔/无侵入」）
- **审核裁决**（独立 code-reviewer 子代理，完整报告要点）：**A 标准化=达标（带保留）**——trait 面克制、路由优先级正确、并发用法正确、plugin.rs 3 测试在；**B 可插拔=部分达标**——安装/卸载/重装链路真实且 e2e 覆盖，但卸载后 wire 命令仍活、API key 明文残留 modules.json、宿主 crate 与 OSS 包版本无绑定、permissions 纯声明、远端代码无签名即执行；**C 无侵入=部分达标**——Rust 侧清零声明 grep 属实（sidecar/protocol/lib/main 零命中），但 renderer.js 4 处生命周期直连（init 注入/扫描钩子/tick/死 import zhipuConfigKeys）绕过注册表、tauri-bridge 专属便捷方法、src-tauri 2 处插件字面量（"GLM plan" 通知 fallback+注释）。
- **R27 已修（本轮落地，全部过门禁+真机复验）**：
  1. **桌面生命周期注册表化**：`src/desktop/plugins/index.js` 升为 `HOST_PLUGINS`（{id, buildCard, init, onScanCycle, startTick}）+派生 HOST_PLUGIN_CARDS；renderer 改循环驱动（boot init+tick 循环、扫描完成钩子循环），**renderer.js zhipu 字面量清零（含死 import 与遗留注释）**——新插件=目录+注册表一条 entry。
  2. **命令按安装态熄灭**：host::installed()（无条目/enabled:false=未装）；ZhipuPlugin::handle("usage") 未装→Err("plugin zhipu-plan is not installed")（lib.rs 路由级单测）。
  3. **空 keys 查询不再污染托盘**：ingest_query 抽出——keyCount==0 只刷缓存不 note_success（不覆盖 last_data、不清告警基线；host 单测：清 key 后菜单仍渲染上次真实观测）。
  4. **host-card 安装不执行远端代码**：installRemoteModule 对 HOST_PLUGIN_CARDS 命中者跳过 fetch+blob-import（只 modulesSet id/version）——砍掉「安装即执行不用的代码」攻击面（P2-7）。
  5. **托盘刷新限时**：provider 循环的 spawn_blocking 包 10s timeout——超时后台继续跑、本次渲染旧缓存、下次重建取新（消 P1-3 的 90s 级菜单阻塞）。
  6. **杂项清零**：tauri-bridge 删 zhipuUsage 便捷方法（card.js 改走通用 sidecarInvoke("zhipu-plan:usage")，mock sidecarInvoke 拦截同命令喂罐头数据，zhipuUsageCalls 统计口径不变）；src-tauri 通知 fallback "GLM plan"→"AI Token League"、调度器注释泛化；sidecar modules:remote-file 死参数 file 删除；protocol 表驱动测试补 modules:get/set/remote-catalog/remote-file；插件 crate 测试去真网（原 query 测试会打真实 HTTP）。
- **门禁**：cargo workspace 全绿（插件 crate 14 测试）/ test:ui 558/558 / e2e 103/103 / npm test ✓。真机：installed 下 `zhipu-plan:usage` 双查（lite 88%/pro 100%）+托盘 `🟢→🟠 88%`/`🔴 100%` 渲染正常。
- **留用户拍板（未动）**：**P1-1 卸载语义**——卸载后 config.keys（明文 API key）仍留 modules.json（重装保留配置 vs 隐私清除，产品决策；修法=卸载时 config:{keys:[]} 或确认弹窗）；**P1-2 信任链**——catalog/index.js 签名校验 + invoke 按 manifest permissions 白名单（module-loader 注释已承诺，属二期「模块签名校验」）；宿主 crate 与 OSS 包版本错位（OSS 重装升级无实际效果，需 minHostVersion 或宿主版本上报）。仍零 commit。

### R28（2026-09-14，认领实名化——云端匿名认领下线 + 桌面借用卡 + admin 数据管理）
- **用户三连拍板**：①云端匿名认领移除（web 只留只读目录）②借用做成桌面卡（设备身份签名认领）③admin 加数据管理。驱动：「认领在云端怎么知道是谁？客户端做是不是天然成立？」——是：联赛客户端自带 participantId+Ed25519 身份，与排行榜同一信任体系。
- **S1 后端签名化**：claim 契约改为 `{shareId, participantId, ts, signature}`，payload=`{kind:"share-claim", participantId, shareId, ts}`（canonicalJson+Ed25519，与用量上传同链）；**身份验证前置**（匿名探测拿不到节点状态）；ts ±10min 防重放；claim 存 participantId/displayId，borrower=nickname。`createSharingCpa` 注入 `verifyIdentity`（server.js 用 store.getParticipant+verifyPayload 接线，测试注入 testIdentityGuard 走真 crypto）。新增 `POST /api/admin/shares/policy`（留空不改、下次心跳生效）。run-tests：签名/伪造身份/过期 ts 全 401 + admin policy 用例。
- **S2 Web 只读化**：sharing.html/js 去认领/我的认领/结果区，只留在线节点目录（预算条/名额/状态）+「在客户端认领」提示；删 17 个死键加 claimInApp（zh+en）。
- **S3 桌面借用卡（share-borrow 插件）**：sidecar 三命令（`sharing:claim-sign` 用 config 身份签名 / `sharing:borrow-get|set` 持久 `app_dir()/sharing-borrow.json`，协议+处理器+测试表）；bridge 三方法+host init 增 `apiBase`/`formatTokens`；`src/desktop/plugins/share-borrow/card.js`（目录+签名认领+env 配置块 OPENAI/ANTHROPIC 双套+复制+我的认领+用量刷新+撤销+IntersectionObserver 15s 节流重进刷新）；HOST_PLUGINS/FIRST_PARTY_PLUGINS 注册；`plugins/share-borrow/` OSS 载荷 **0.1.0 已发布**（目录 7 条目）。坑：**renderModuleCards 只建一次卡**——boot 期 fetch 失败会冻结错误文案（观测器修复）；i18n 卡键勿复用已删 web.* 键（按钮文案回退裸键）；formatTokenCompact 默认中文口径（须走 locale 化包装）。e2e `share-borrow.spec.js` 4 用例（目录/签名认领/env 渲染/身份失败/本地认领撤销）；mock 三方法+`borrowClaims` 场景。
- **S4 admin**：claims 行身份列（borrower+displayId→profile 链接，悬停看 requests/failed）+ 策略编辑面板（五字段留空不改）+ 11 i18n 键双语。
- **门禁**：npm test ✓ / test:ui 558 ✓ / e2e 107（+4）✓ / cargo workspace 428 ✓ / cpa-plugin 10 ✓。8787 云端已携新码重启（share 在线恢复）。仍零 commit。
- **待用户点验**：dev App（沙箱）在线目录装 share-borrow 0.1.0 → 模块屏借用卡 → 真实认领（需客户端已 init+register）→ env 接 Codex/Claude Code 打真实流量；admin 策略编辑热更。遗留：借用卡「进屏自动查」已由观测器覆盖；share-borrow 载荷 index.js 为占位（宿主信任目录 id/version，不执行）。

### R28b（2026-09-14 上午，用户纠偏「完全可插拔，非内置」+ code review 修复批）
- **完全可插拔改造**：share-borrow 撤出宿主（删 src/desktop/plugins/share-borrow/card.js、HOST_PLUGINS 注册、FIRST_PARTY_PLUGINS 条目、bridge 三方法、desktop 借用 CSS、host-init 的 apiBase/formatTokens）——**App 不再携带任何借用卡代码**。卡片重写为 `plugins/share-borrow/index.js`（mount(el,ctx) 自包含：自带 sb-* 样式注入、自含 compact 格式化、IntersectionObserver 15s 节流）；平台仅补通用能力 **ctx.apiBase()**（buildModuleContext+renderer 挂载点，任何需后端 HTTP 的远端插件可用）。mock 改走通用 sidecarInvoke 通道（sharing: 三命令，与 zhipu-plan:usage 同模式）；e2e 重写为真实安装流（catalog+文件源路由，serves 真插件入口：装→挂载→卸载消失）。
- **code-reviewer 子代理全量 Review**（保留/废弃/缺陷三清单）+ 修复批：
  - 死码清除：web styles.css 孤儿认领 UI 规则 18 组（.sharing-result*/config/copy/revoke/claims-table/revoked-note）；renderer 死 import `_localeTokenCompact`；admin claims 视图 borrower 覆盖写。
  - **B1 admin 身份链修复**：store participant 无 displayId 字段（生产恒空、链接永不渲染、测试伪造掩盖）→ server.js verifyIdentity 现按 BOARD_SECURITY_LEVEL 返回安全 displayId（anonymous 模式=anonymizer 公共 id，绝不泄原始 participantId）。
  - **B2 baseURL 冻结修复**：插件每心跳携带重探测的 baseURL（CPA config 可 `baseURL` 覆盖），后端 heartbeat 检测变更即更新 share——owner 换 IP/端口后借用者不再认领死端点；identity.json 无需手删。
  - B3 认领限流 Map 增过期清扫（>512 触发、bucket 差>5 删）；B4 安装脚本 YAML 片段 printf 化（echo \\n 字面量坑）；B5 插件离线时本地 expiresAt 回退（过期认领不再显示 valid+token）；B6 SIGINT 也 flush 控制面持久化；B7 borrow-set 白名单字段加长度上限（本地 DoS 面）。
  - **D2 i18n 补线**：manifest 增 titleKey/descKey（publish-module 透传进目录）——英文用户目录卡不再显示硬编码中文标题；desktop.sharing.borrow.title/desc 键接上真实消费者。
- **签名链审计 PASS**（review 结论）：Rust canonical_json ≡ JS canonicalJson、ts 毫秒双端一致、身份前置无状态泄漏、插件 XSS 全转义、心跳字段无死负载。
- **门禁**：npm test ✓/558 ✓/e2e 107 ✓/cargo 428 ✓/cpa-plugin 10 ✓（+baseURL 覆盖断言）。**0.2.1 已发 OSS**；真实 CPA（8317）+ 本地云端（8787）均已携修复重启，share 在线。
- **遗留待拍板**（review 歧义项）：①register-trust 滥用面（任何人可铸 share 进公开目录，需 admin 手动清理——是否加 participant 签名门）；②owner/status、owner/policy、unregister 三端点当前仅测试消费（留作 owner API 面或删）；③manifest.permissions 尚无强制执行（v1 已记录的信任链缺口，远端插件经 sidecarInvoke 可调任意 sidecar 命令——加固项）；④sharing sidecar 三命令补 Rust 单测。

### R28c（2026-09-14 上午续，用户拍板「packages 不需要、所有插件进 plugins/；宿主卡退役、标准插件定义够用」）
- **packages/ 删除**：hello-module 样本退役；online-modules.spec 安装流重锚 share-borrow 0.2.1（真入口 + /api/shares 空列表路由）。OSS 目录历史条目 hello-module 1.0.0 留存（无消费者，纯历史）。
- **宿主卡机制整体退役**：`src/desktop/plugins/` 删除（HOST_PLUGINS 表+zhipu card.js）；renderer 去宿主化（import/init 循环/onScanCycle 循环/buildModuleCard host-card 分支全撤）；**installRemoteModule 泛化为所有插件安装时不执行远端入口**（信任目录 id/version 对，代码只在挂载时取新鲜源执行——R27 安全结论推广）。FIRST_PARTY_PLUGINS 保留为纯离线文案元数据（标题键，非代码）。
- **智谱卡全远端化**：plugins/zhipu-plan/index.js 重写为富卡（Key 自管经 ctx.invoke modules:get/set、查询 zhipu-plan:usage、菜单栏/阈值开关、分钟级轻 tick=倒计时+非强制刷新（sidecar 60s 缓存去重，替代原 onScanCycle 钩子）、挂载即查）；纯函数（renderResult/windowLabel/resetCountdown/maskApiKey）具名导出供单测（zhipu-plugin.test.js 重指向，t 参数化）。**1.1.0 已发 OSS**（permissions 补 modules:set）。复用 App 皮肤类（.zhipu-*/.module-meter/.source-switch——皮肤非逻辑）。
- **mock/e2e 适配**：sidecarInvoke 通用通道补 modules:get/set（远端卡的配置读写）；modules.spec 三场景补 apiBaseUrl+真源路由（挂载期 fetch）；mock 默认 installedVersion 1.0.3→1.1.0 对齐。
- **门禁**：npm test ✓ / test:ui 557（configKeys 闭包测试随宿主卡退役）/ e2e 107 ✓ / cargo 428 ✓。坑：**远端卡挂载依赖 apiBaseUrl**（场景漏配→noCloud 早退卡不渲染，DOM snapshot 定位）；mock 的通用通道必须覆盖 modules:get/set 否则远端卡挂载即 reject。
- **现状语义**：插件=唯一形态（manifest+mount(el,ctx)+OSS 目录），App 内零插件代码（仅 FIRST_PARTY_PLUGINS 文案元数据+ctx 能力：t/invoke/escapeHtml/apiBase）；智谱托盘/菜单栏仍在 sidecar（与卡无关）。
- **dev 环境就绪（R28c 收尾，2026-09-14 08:35）**：沙箱 config api 8788→8787（sky-dev 身份已核实存在于 8787 云端库，签名认领可过）；modules.json 预装 zhipu-plan 1.1.0 + share-borrow 0.2.1（含两把真实 Key 配置保留）；dev App 全新重启（sidecar 健康、重启后零 ERROR）；清理两只旧架构孤儿网关（8791→旧 dev 云、8792→死 8788）——网关角色已由 CPA 插件接管，工作区不应再有 sharing-gateway 进程。用户打开 dev App 窗口即见：插件屏两张远端卡（智谱 1.1.0 富卡自动查 + 算力借用 0.2.1 可实名认领）。

### R28d（2026-09-14，用户拍板执行 A.3 permissions 强制 + 插件接入文档）
- **A.3 落地**：`src/shared/module-loader.js` 新增 `invokeAllowed/createGuardedInvoke`（**平台自态命令 modules:get/set 永远放行**；精确匹配 `sidecar:<cmd>` 与命名空间通配 `sidecar:<ns>:*`；越权调用在进通道前 reject `permission_denied:<cmd>`）；renderer 挂载点按「目录条目 permissions → FIRST_PARTY 离线声明 → 空（仅平台命令）」取声明构造受限 invoke——**webview 共享通道自此可区分插件**。publish-module 目录透传 permissions（两插件已重发布，目录条目带 perms）；FIRST_PARTY_PLUGINS 补 zhipu 离线声明。单测 +3（守门/通配/越权拒绝）、e2e 目录 fixture 补 permissions，13/13 过；全门禁绿（test:ui 560/e2e 107/npm test）。`doc/plugin-development.md` 已同步此语义（§1.3/§4）。

### R29（2026-09-14 上午，用户拍板 A.1 方案 a + identityDir、A.2 开工——均完成）
- **A.1 注册实名制落地**：后端 register 强制联赛设备签名（kind=`share-register`，与 claim 同 verifyIdentity 链、±10min 防重放；share 存 ownerNickname/ownerDisplayId 进 admin 视图；unsigned/forged 401 测试覆盖）；cpa-plugin 独立实现签名——bootstrap.rs 增 `atl_identity`（**identityDir 配置 > ATL_HOME > ~/.ai-token-league 三级解析**，读 config.json 的 participantId+identityPrivateKey）+ `canonical_json`（与 JS 算法逐字节对齐，单测锚定）+ `sign_payload`（Ed25519 PKCS8 PEM）+ `register_identity`；sync.rs ensure_identity 无身份即 fail-closed 不注册、注册请求带签名。install 脚本 `--identity-dir`。真机 dylib 已部署重启（现有 share 无回归在线）。坑：**pem-rfc7468 严格 64 列换行**（手搓测试 PEM 单行 base64 被拒）；ed25519-dalek 的 pkcs8 不透出 LineEnding（DER 手包）。
- **A.2 owner 控制台落地**：sidecar 三命令 `sharing:owner-status/policy/unregister`（spawn_blocking + reqwest，**secret 只在 sidecar 与 identity.json 间流动**，未注册 reject not_registered）；远端插件 `plugins/share-owner/` 0.1.0（账本/借用者明细含 displayId/五字段策略编辑/确认停止单/未注册引导；manifest 声明三条 owner 权限——A.3 守门的第一批真实消费者）已发 OSS；i18n 21 键双语；mock ownerShare 场景；e2e 4 用例（渲染/策略增量/停止确认/未注册引导）。坑：**e2e 必须路由 catalog**——守门声明来自目录条目，漏路由=空声明=owner 命令全被拒（A.3 自我咬合的证明）。
- **门禁**：npm test ✓ / test:ui 560 ✓ / e2e 111（+4）✓ / cargo 428 ✓ / cpa-plugin 12 ✓。dev 沙箱预装 share-owner 0.1.0（未注册引导态——沙箱 ATL_HOME 无 CPA identity，如实呈现）。插件接入文档已补 owner 命令表与 identityDir 说明。

### R29b（2026-09-14 上午续，用户拍板「借用/控制台合并成一个插件」）
- **合并为 `plugins/compute-sharing/` 0.1.0**（已发 OSS）：一张卡两区——「我的分享」（owner 控制台：账本/借用者明细/五字段策略/确认停止）+「可认领节点/我的认领」（实名签名认领/env 配置/撤销）。**owner 区未注册（含停止后）整区折叠**，纯借用者无感；manifest 声明全部 6 条 sharing 权限。share-borrow/share-owner 两插件退役（目录删除；OSS 历史条目留存待清理清单）。
- 测试：两 spec 合并为 `compute-sharing.spec.js` 5 用例（owner+目录同屏/签名认领/env/身份失败/策略增量+停止折叠/纯借用者无 owner 区）；mock 复用现有 sharing:* 命令块。坑：**refresh 的 owner 分支 catch 漏 renderOwner({})  → 停止后区不折叠**（e2e 抓住）。
- 门禁：npm test ✓ / test:ui 560 ✓ / **e2e 108**（合并 spec 5 + online 重锚 compute-sharing）✓ / cargo 428 ✓ / cpa-plugin 12 ✓；online spec 首跑撞已删 share-borrow 路径（漏网引用，重锚修复）。dev 沙箱 modules.json 换装 compute-sharing 0.1.0（zhipu+compute-sharing 两卡）。

### R30（2026-09-14 上午末，OSS 目录清洗 + dev 全链路换新）
- **OSS 清洗**：publish-module.js 新增 `--prune-keep id@version,...`（重写 catalog.json，版本化对象留存 OSS 不删）——已执行：12→2 条（仅 zhipu-plan 1.1.0 + compute-sharing 0.1.0，均带 permissions）。坑：**被 kill 后端的 MySQL 池连接不闭 → GET_LOCK 被 Sleep 连接无限占住**（78 分钟陈旧连接，SHOW PROCESSLIST 定位 host、KILL <conn_id> 释放）——杀后端后重启报 write-lock timeout 先查锁主。
- **dev 换新**：旧 dev 实例 pkill 不彻底（tauri dev 杀了但 app/sidecar 残活占 vite 端口）→ 全家桶 pkill -9 清场后重拉；sidecar debug 二进制先重建（新 owner 命令在协议里）。现状：fresh app(pid 69797)+sidecar(69864) 运行中、8787 云端携 A.1 门+owner 端点、目录 2 条、share 在线、沙箱=zhipu 1.1.0+compute-sharing 0.1.0。**正式安装版 App(98213) 全程未动**。

### R31（2026-09-14 下午，提交前终审 review + 修复——git commit 前最后一轮）
- **终审方式**：两个独立上下文 code-reviewer 子代理（Rust 侧 / JS+Web 侧）+ 6 门禁复跑 + 4 个 P1 逐条亲核（全部属实）。
- **P1×4 修复**：
  1. cpa-plugin 门闸**先占后判**——`key_concurrency=N` 实际只放 N-1，且 Terminate 分支不释放已占名额（无 complete 事件回收=永久泄漏）：改为**先判后占**（仅 Pass 且非空 RequestID 才预订），新增并发门测试钉死语义（cpa-plugin 13 用例）。
  2. `SHUTDOWN` 只置位不复位——shutdown→re-init 同进程循环后 sync 线程首查即退、共享永久 fail-closed：init 时复位。
  3. 平台命令无自域——任何插件 `modules:get` 拿全量状态（含智谱明文 key）、`modules:set` 可写任意插件：guard 层按 selfId 收敛（get 过滤自身记录 / set 强制 id），renderer 传 `mod.id`；`doc/plugin-development.md` §1.3/§4 同步；"已知宽松点"升级为已封堵。
  4. **停享不折叠**——mock 注销即置 null 与真实后端（保留 share、`state="stopped"`、owner-status 仍 200）契约分叉，e2e 靠分叉假绿：插件按 `state==="stopped"` 折叠 + mock 对齐真实契约（e2e 自此钉住生产行为）。停享后云端心跳返回非 active → CPA 插件 fail-closed，云端权威不变。
- **顺手修**：identity.json 0600（私钥材料）、sharing-borrow.json tmp+rename 原子写（防崩溃截断静默清空认领表）、modules.rs 死 import、stale 注释×6（core_state 网关引用/spec "shelved"×3/mock share-borrow/AGENTS publish 示例→compute-sharing/sharing-cpa 头注释补 policy）、slotsLeft 入模板补 esc、online fixture 对齐真实 manifest（zhipu 1.1.0）。
- **compute-sharing 0.1.1**：卡片修复按版本不可变原则 bump 重发 OSS + `--prune-keep` 收回 2 条（zhipu-plan@1.1.0 + compute-sharing@0.1.1）+ dev 沙箱 modules.json 换装。
- **e2e 两用例失败根因（staged 树既有，非本轮引入）**：协作者智谱 1.1.0 新卡结构 `.zhipu-result` 类已改 `.zhipu-ledger > article.zhipu-account`，modules.spec 两处选择器过期——只修 spec 不动插件代码。
- **坑×2**：`npm run test:e2e | tail` 管道吃掉 playwright 退出码（假绿）；裸 `npx playwright test` 落到根配置=真 Tauri e2e（拉起 tauri dev，120s webServer 超时假象）——单测重跑必须 `--config=playwright.mock.config.js`。
- **真机 CPA 重部署**：release dylib（含门闸修复）替换 cpa-core/plugins/atl-share.dylib（备份 .bak-20260914）+ 重启 core（CWD=cpa-core）：plugin registered / 凭据 1 auth 正常 / 8317 监听 / Sky-Macbook CPA share online+active；identity.json 已 600。
- **门禁终值**：npm test ✓ / test:ui 569 ✓ / **e2e 110 全过** ✓ / cargo workspace ✓ / cpa-plugin 13 ✓ / verify:ccusage ✓。index 与 worktree 一致，仅 archive/ 未跟踪（待用户审）。
- **审后暂不动清单**：zhipu rust 死代码（tray failure 跟踪/state_ok，协作者面）、i18n 5 个退役遗留键、sharing.html 无入口链接（实验态）、install-cpa-plugin.sh 仅 mac 路径、OSS 目录签名（二期加固）、zhipu tickTimer 重装不自动刷新（v1 已知）。

### R32（2026-09-14 下午末，用户令「遗留注意点能优化的就优化掉，按现在的后端设计结构保证持续高质量」——存储优化完成）
- **背景**：用户发现共享账本+模块上架状态原为旁路 JSON 文件，env.local 是 `DB_TYPE=mysql` 时主数据走 MySQL、控制面落 JSON——部署模型错配。研发改了一版（control-plane-store 跟随 DB_TYPE：mysql 专用三表 / json 并入 db.json；sidecar 一次性迁移 `.migrated`），评估通过（npm test 全绿+真机心跳落库实证），本轮在其上做质量优化。
- **优化 1（写放大消除）**：`replaceSharing` 的「事务内 DELETE 全表+全量重 INSERT」改为**行级 diff upsert**——纯函数 `diffSharingRows/diffListingRows`（按序列化行形状比对，心跳只动 lastHeartbeatAt 时恰好产生 1 条 share upsert、0 条 claim 写），`ON DUPLICATE KEY UPDATE` 沿用主存 `VALUES()` 风格；单测 `testControlPlaneDiffRows`（冷启/无变化/心跳/结算/删除五态）。
- **优化 2（锁对齐）**：控制面事务在自己的连接上取**与主存同名的 GET_LOCK**（mysql-store 新导出 `acquire/releaseWriteLockOnConnection`，含 unsupported 跳过与超时抛错同语义）——多进程过渡期与主写路径串行化。
- **优化 3（尾部丢态窗口关闭）**：flush 失败（MySQL 抖动）由适配层 **30s 定时重试**（unref，成功即清 pending）——心跳路径按设计吞持久化错误（500 会让 CPA 重发 usage 增量双计），旧实现失败后若再无变更就永久滞留。
- **测试**：`testControlPlaneMysqlRoundTrip` **opt-in**（`ATL_TEST_MYSQL_HOST` 指向专用空测试库才跑：建表迁移+行级 flush+reload+单行更新+删除）；真机验证=一次性库全断言通过后 DROP。坑：**全量套件不能在 DB_TYPE=mysql 下跑**（API 端点测试用临时 JSON 库，注入环境变量的方式会错配——失败点在写入落地前，已核实真库零污染）；该 MySQL 是 **5.7**（无 performance_schema.global_status，计数走 SHOW GLOBAL STATUS LIKE）。
- **真机证据**：8787 重启后 share online；12s 窗口 **Com_delete=0**（旧实现每 flush 必发 2 条全表 DELETE）+ 心跳 8s 照常推进 = 行级写实证。
- **文档/清理**：AGENTS.md Storage 节补 DB_TYPE 控制面语义；data/ 旧网关遗迹（compute-sharing.json+签名缓存）归档进 archive runtime-data/。

### R41（2026-09-14 晚，停止分享死胡同修复——owner 端内可恢复）
- **用户现场**：本地 CPA atl-share 已注册运行，但在桌面算力共享卡点了「停止分享」后分享从目录消失且端内无任何恢复入口（实测 share `state=stopped`、插件仍心跳 online、claims 全 revoked）。
- **根因（三层叠加成死胡同）**：①插件卡对 `state==="stopped"` 整区隐藏（R31 P1-4 的折叠语义）——停止后控制台连同所有按钮一起消失；②CPA 插件 `ensure_identity` 见 identity.json 即短路，永不重发 register；③`handleRegister` rebind 分支不恢复 state——同 secret 重注册也救不活（旧测试注释写着 "revives" 但从未断言 state，实现与意图分叉）。
- **修复**：
  1. 云端新增 `POST /api/shares/owner/resume`（secret 认证）：stopped→active、幂等；**admin suspend 拒 409 `share_suspended`**（owner 不能自解管理员封禁）；rebind 分支补 stopped→active（suspended 不动）。
  2. sidecar 新命令 `sharing:owner-resume`（OwnerCallKind 枚举收敛三分支）；protocol/modules 守门/manifest permissions 同步。
  3. 插件卡 stopped 态不再折叠：渲染紧凑行（标题+已停止+累计借出+**primary-pill「重新开启分享」**，符合 primary-pill=唯一推荐动作专属）；停止确认文案改「可随时在本卡重新开启」；compute-sharing **0.1.3**。
- **语义澄清（非 bug 的部分）**：unregister 不卸载 CPA 插件是设计——插件由 CPA 配置加载，心跳继续（云端借此知道节点活着），心跳响应 state=stopped → 插件 fail-closed 拒服务，云端权威不变。
- **测试**：run-tests 补 rebind 复活断言（心跳 active+目录重现）+ resume 全路径（错 secret 404 / stopped→active / 幂等 / suspended 409）；e2e 停止用例改为「停止→已停止行→重新开启→控制台恢复」全流程（mock 补 owner-resume 契约）。门禁：npm test ✓ / test:ui 579 ✓ / e2e 115 ✓ / cargo（collector-core+atl-collector）✓。
- **现场恢复**：用户 share `shr_1aae6eb…`（Sky-Macbook CPA）经 admin resume 拉回 active，目录重现（5 名额/预算满）；已发认领 Key 停止时已吊销，借用方需重新认领（停止语义固有）。
- **待办**：OSS 目录 compute-sharing 现 0.1.2，0.1.3 需 publish-module + `--prune-keep zhipu-plan@1.1.4,compute-sharing@0.1.3`；端内生效需新版 sidecar/App 发布。

### R42（2026-09-15，智谱 Key 行内编辑 + 用户本地配置改备注——小功能轮）
- **用户两求**：①Key 备注改名（Zhipu GLM→Fathu、GLM 5.3 -Harry→Harry）——**改用户本地 `~/.ai-token-league/modules.json`**（我误改 dev 沙箱被纠正，沙箱已还原；本地现值 Fathu/Harry，两把 key 不变）；②支持编辑已有 Key。
- **编辑能力**（plugins/zhipu-plan/index.js，**1.1.5 已发 OSS + 目录 prune**——现值 `zhipu-plan@1.1.5,compute-sharing@0.5.1`，dropped 1.1.4）：Key 行加「编辑」按钮（与移除同组 `.zhipu-key-actions`）；点击→行内编辑态（备注+完整 Key 均**预填**——本机用户自有密钥，原样可改）；保存=校验非空→keys[i] 整条覆写→modules:set→退出编辑→强制刷新（与添加同路径）；取消=丢弃不落盘；删除时同步清编辑态。样式 `.zhipu-key-row.is-editing`（flex 换行，窄容器自适应）注入插件 STYLE，不进平台样式表。
- **i18n**：平台表 +3 键双语（editKey/saveKey/cancelKey）；旧宿主回退沿用 REFRESHED_FALLBACK 模式（EDIT_FALLBACK zh/en，经 zhHost 嗅探）。
- **mock/规格**：默认预装与 ZHIPU_VERSION 同步 1.1.5；e2e 新增「行内编辑（改名+换 key+取消不落盘）」用例（断言 modulesSet keys 精确形状 + force 刷新触发 + 取消后写入数不变）。
- **门禁**：e2e **118/118** / test:ui **579/579** / npm test ✓。工作区 5 文件未提交。
- **用户侧生效路径**：dev/已装 App 打开插件屏→智谱卡右栏 Key 列表即见「编辑」；线上目录侧 1.1.5 已就位（已装 1.1.4 会出「升级 v1.1.5」按钮）。

### R42b（2026-09-15，menu bar 备注滞后修复——配置变更即时触达插件缓存）
- **用户现场**：本地配置改了 Key 备注（Fathu/Harry）后菜单栏仍显示旧名。**根因**：托盘行渲染自 sidecar 缓存的查询快照——备注是查询时烙进 `last_data` 的，只有托盘 TTL 到期（基础 15min，任一窗口 ≥70% 提频 5min）+ 5min 调度器才带新备注重查；`modules:set` 改配置对缓存零感知。
- **修复（平台标准扩展）**：①`SidecarPlugin::on_config_changed()`（默认空实现）——宿主在 `modules:set` 成功落盘后对同 id 插件触发；②zhipu 实现=`invalidate_tray()`（tray_state 新增 `expire()`：只摘 `last_success_ms` → `due_refresh` 立即为真；**保留数据快照与已武装告警态**，菜单持续渲染、无重基线副作用）；③lib.rs `command_updates_usage_cache` 加 `modules:set` → 保存后立即重建托盘。
- **验证**：插件 host 单测（expire 后 due=true 且菜单仍渲染 42% 快照）；**CLI 同会话全链路**——tray:menu-data 缓存旧名 → modules:set 改备注 → tray:menu-data 立即返回新名（`🟢 Zhipu GLM 35%`→`🟢 Probe-A 35%`，沙箱验证后已还原）。门禁：cargo workspace **458/0** / e2e 118/118。
- **用户当前实例说明**：/Applications 现行 App 是旧二进制，无此修复——但标签存量滞后会被 TTL 自然治愈（当前 Fathu≈88% 走 5min 快档，几分钟内已应更新；若仍旧，重启 App 立即重查）。结构性修复待下次本地构建/发布进 App。
