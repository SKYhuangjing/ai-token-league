# Magpie 同步插件设计(doc/magpie-plugin.md)

状态:0.1.0 已实现并完成本地验证(2026-11-01)。位于仓库 `magpie-plugin/`,零运行时依赖(Bun 宿主)。

## 1. 定位

在 Magpie(usemagpie.ai,Mac 网关型 AI 用量采集器)内以插件形式完成对 ATL 云端的签名上报,使"本地流量的采集+上报"可以脱离 ATL 客户端运行。数据源为 Magpie 统一口径(网关账本 + 全部本地 agent 会话扫描,与自带用量页 Requests 标签一致),因此**本地各来源(zcode/codex/claude/kimi/opencode/workbuddy/dsh/hermes)无论是否接入网关都完整覆盖**;网关外且无本地会话库的来源(cursor dashboard)仍归 ATL 客户端;workdir 项目维度、本地查询 CLI、full-reconcile 均不在其覆盖内。

## 2. 数据链路(全部实测确认)

```
工具(Codex/ZCode/任意兼容客户端,可用自家订阅登录)
  → Magpie 网关(逐请求记 ~/.config/magpie/usage.jsonl)
  → 上游(chatgpt.com / googleapis / bigmodel ...)
本地会话(ZCode/Claude Code/… 各自的会话库,Magpie 持续扫描)
  → Magpie 统一用量(网关+会话日志,request id 去重 = 自带用量页 Requests 口径)
```

- **主数据源 = Magpie 统一用量**(2026-11-01 起),降级链三级:
  1. `magpie usage --csv all`(官方 CLI 导出,用户级接口;全史 ~23.6 万行 2.5s;`rejected=true` 行剔除,PII 列在解析层丢弃;二进制发现顺序 MAGPIE_BIN → ~/.local/bin/magpie → /Applications/magpie.app/... )
  2. `GET /v1/magpie/usage/requests`(网关只读 JSON API,本机免 key,作者为本机第三方应用预留的接口;500 行/页,深分页慢,故仅承载 7 天窗口;`MAGPIE_GATEWAY_URL` 可覆盖)
  3. 账本文件 `~/.config/magpie/usage.jsonl`(仅网关口径,末位兜底)
- 首次同步(或 manifest 为空/`--full`)自动全史回灌,后续例行只看窗口(CSV 通道则恒为全史,靠桶指纹只传增量)
- agent 归因映射扩展:kimi/workbuddy/dsh/hermes 加入;ATL 无对应来源的 agent(如 minimax/qoder)明确跳过并写日志计数,不再折入 magpie_local
- 账本行(兜底路径):`route_id, t(带时区), agent(客户端), provider(上游), model/req/served, in/out/cache_read/cache_write(四分项), reasoning, ms, ttft_ms, status, kind(memory_consolidation|thread_title|model_list|...), response_id, session, providerAccount(PII), host(PII)`
- `onUsage` 钩子(moejs)无网络/文件能力且与 Bun 宿主无桥 → 弃用;插件 Bun 宿主直接拉取/读文件
- 触发:`.hooks.js` onRequest/onResponse(节流 60s)+ 常驻 interval(15min)+ 页面命令握手;均为 detached 拉起 `bun sync.js`,不占钩子预算
- 页面内容按 `magpie-plugin/doc/page-content-design.md` 实施(P0 已落地):status.js 携带 nickname/deviceId/sourceChannel/firstSyncStart/serverRank(同步后 GET `/api/board/analytics?period=today` 快照,失败保留旧值且不影响同步结果);同步失败/busy/拒传也写 status(ok:false + error,保留旧昵称与排名);用量页顶部身份行 = 昵称 + 短 participantId + 今日云端排名(24h 过期灰显,不可达降级为 —)

## 3. 协议契约(与官方 collector 逐字节一致,金样测试锁定)

- 注册:`POST /api/devices/register`(免签,Ed25519 公钥明文;participant 已存在且公钥不同则拒绝)
- 上传:`POST /api/usage/daily-batches`(≤25 桶/批;404/405/501 回退单桶 `/api/usage/daily-batch`)
- 签名:`Ed25519(canonicalJson({participantId, deviceId, clientGeneratedAt, client, batches}))`→base64
- 桶:`device_day_hour_provider` 整桶覆盖 + bucketFingerprint 幂等;`totalTokens` 服务端按四分项重算
- workdir:`sha256("virtual:magpie:"+participantId)` 虚拟桶,displayName "Magpie"(账本无 cwd)
- `client`: `{clientProtocolVersion: 2, clientPlatform: "magpie-plugin", clientBuild: "magpie-bun-<ver>"}`

## 4. 归因映射(按客户端,与 ATL 口径一致)

| 账本 agent | ATL providerId / toolCode |
| --- | --- |
| zcode | zcode_local / zcode |
| claude | claude_code_local / claude_code |
| codex | codex_local / codex |
| opencode | opencode_local / opencode |
| magpie 及未知 | **magpie_local / magpie(新来源)** |

- model 取 `req || model` 并小写(ZCode 借用 codex 模型记 `codex/gpt-6-luna` 且归 zcode_local,与 ATL 客户端本地库归因一致)
- 过滤:`kind=model_list|provider_test`、`source=probe`、四分项全 0(失败重试/probe);`memory_consolidation`/`thread_title` 带 token 计入
- 按需写入:账本无某 agent 行则不写该源

## 5. 身份策略与分阶段上线(用户拍板)

1. **开发期**:一切联调走本地(`.tmp-smoke` JSON 库 / `env.local` 的 `ai_token_league_dev` MySQL 库);生产只读。
2. **生产影子验证**(须用户确认后执行):全新 participantId+deviceId 影子身份指向生产,零桶冲突,可整体删除还原。
3. **平替切换(二期)**:ATL 设置页通用「导出配置」(含身份字段)即可作为迁移载荷——插件页面「导入」直接采纳(旧身份自动备份为 `identity.json.<旧pid>.bak`);插件自身「导出」产出同格式 `atl-magpie-migrate` JSON 供反向迁移。同 participant+device 与 ATL 客户端共存的语义见 §13 写者优先级仲裁(2026-11-01 起,服务端保障,双开/单开均安全)。

## 6. 用量总览页(page 双页签)

「用量」为默认页签,对齐 ATL 桌面总览:范围切换(今日/近 7/近 30/全部)、总量+四分项 KPI、构成条、逐时(今日)/逐日趋势 SVG 柱图、来源占比、模型 Top5、同步状态页脚。数据链路:`summarizeRows`(lib/usage-summary.js,全量账本日级+今日逐小时聚合,不受 magpie_local 上传开关影响——展示即全部网关用量)→ `page/usage-data.js` 脚本注入桥(与 status.js 同机制,绕开页面 CSP 无网络限制);每次同步运行时刷新。页面桥文件仅真实安装写入(`MAGPIE_ATL_DIR` 沙箱运行不写,防测试数据污染真实页面——实测踩过并已修复)。零图表依赖(手绘 SVG)。

## 7. 隐私边界

上传 items 白名单 18 字段显式构造;`providerAccount`/`host`/`session`/`native_session`/`response_id`/`err`/`ep` 物理不上传(bun test 断言序列化载荷无 email/session/response_id)。FORBIDDEN_UPLOAD_FIELDS 防线随协议栈移植。

## 8. 完整性保险丝(响亮拒传)

- `parseLedger`:坏行 >5% 判格式漂移抛错;截断尾行跳过(网关并发追加的正常现象)
- `integrityCheck`:counted 行必须有数值 route_id、可解析时间戳;response_id 重复(同上游响应记两次)即拒
- 轮换检测:首行 route_id 变化 → manifest 重置重传
- 时钟偏移:未来日期行丢弃

## 9. 与 ATL 桌面/CLI 的关系

- 新来源 `magpie_local` 前端触点:chart-helpers.js(配色+标签)、i18n(source.magpie)、renderer-data.js、renderer-helpers.js(UI_PROVIDER_ORDER)、admin.js
- 迁移载荷来源:ATL 设置页通用「导出配置」(插件导入时仅取身份字段;专用导出通道已按最小变更移除);插件 `--export-config` 反向产出 `atl-magpie-migrate` 格式(0600,含私钥警示)
- 后端零改动(providerId 无枚举校验,协议本就通用)

## 10. 已验证矩阵(2026-11-01,本机实测)

| 验证项 | 结果 |
| --- | --- |
| 签名/指纹/canonicalJson 金样(官方 Node 实现生成) | 逐字节一致,bun test 32/32 |
| 真实账本 dry-run | 30 桶 2.62 亿;codex 手工逐行求和分毫不差 |
| 隔离 JSON 库端到端 | 注册/上传/重跑 noOp/改账本整桶替换(4850 覆盖非 7000 叠加) |
| env.local dev(MySQL)端到端 | 30 桶全接收 0 拒绝;榜单当日 944,937 与 dry-run 一致 |
| 插件安装与自动触发 | `magpie plugin add` 成功;startup 与 15min interval 均实证拉起同步;status.js 回显正常 |
| 迁移导出闭环 | CLI 导出 0600 → 插件 migrate.json 导入,participant/device/密钥逐字段一致 |
| 用量总览页 | 42/42 插件测试;真实数据渲染:近7天 2.62 亿(261,977,524 精确)、四分项/来源/模型/逐日柱图/状态页脚全对;修复页面桥沙箱污染 bug(MAGPIE_ATL_DIR 沙箱运行不写 page 桥文件) |
| 门禁 | cargo workspace 全绿;test:ui 583/583;e2e 165/165;npm test 仅 1 个月初边界既有用例失败(testAdminParticipantDetailUsesRangeAndGrainSeparately,本月 1 号必失败,与本改动无关已证明) |

## 11. 口径对账结论(回应"Magpie 数据与 ATL 对不上")

三个独立原因,均已量化:

1. **分组维度不同**:Magpie 界面按上游供应商分(且为"网关+本地会话扫描"合成口径);ATL 按客户端工具分。同名"Antigravity"在两边是两笔不同的账。
2. **测量点与覆盖不同(最重要)**:网关只见"经过它的流量"。实测:ZCode 在 10-26~10-30 仅有部分上游经网关(日均占 ATL 本地口径 10-40%),且 **10-30 22:52 后完全未走网关**(10-31 ATL 记 7.8 亿、网关 0)。codex 双向残差:网关记到 ATL 未扫到的后台 memory_consolidation 批次(10-31 23:58),ATL 亦有 9.6 万 tokens 网关外直连流量(11-01)。
3. **客户端日志漏记**:此前已证 ZCode 客户端日志日均漏 ~11M(网关更准)——该结论仅对"确实经过网关的那部分流量"成立。

运维口径:2026-11-01 起服务端按 §13 写者优先级仲裁,双开安全(客户端为主、插件补盲区小时);单写者交接某来源 = 客户端禁该源扫描后插件自动接管,重启用客户端自动夺回,无需停写配合。

**对账口径补充(独立数据核实代理 2026-11-01 实证)**:
1. 全部插件聚合数字可从原始账本逐行复现(独立 awk 重算 = dry-run = 页面载荷 = 小时桶手算,7 天×3 源×30 桶逐位全等);P0/P1 均为零。
2. codex 单日残差可远超 50%——仅当**两侧均有交互流量**时"<50% 双向残差"口径才适用;一侧只有后台流量(memory_consolidation/thread_title)或边界请求时,倍数无上限(实测 10-31 网关/ATL=22.5,11-01 残差 95,797 已字段级分解:跨午夜边界请求 200,295 + 网关外直连 20,740 − 网关侧后台 125,238)。
3. `thread_title`/`memory_consolidation` 等后台流量**计入排名总量**(真实上游用量,与 ATL 客户端口径一致)——显式声明,属产品决策。
4. 跨午夜请求两侧归日不同(网关按完成时刻、本地采集按会话日志时刻),天然存在单请求级边界残差。
5. 本机网关 codex 覆盖起点为 2026-10-31 23:58(账本首条 codex 行),此前 ATL codex 历史在网关侧恒为 0;接入日切换时应以账本实际起点为 sinceDay 参考。

## 12. 后续项

- 生产影子验证(等用户确认)→ 二期平替切换
- sync-state 差异对账 / full-reconcile 修剪(协议已支持,插件侧未实现)
- npm 发布(外发动作,须用户确认)
- 上游风险:账本为 Magpie 内部格式,无兼容承诺;形状检测+完整性保险丝兜底,升级破坏时拒传报警

## 13. 双写者共存:服务端写者优先级仲裁(2026-11-01)

ATL 客户端与插件共用同一身份(participant+device)、同时在线为**受支持的一等场景**(用户拍板)。两个写者都读持久化日志(客户端扫本地会话库、插件扫 Magpie 统一口径),进程在线与否不影响数据完整性,因此不做任何在线协调,由服务端在写入时仲裁:

- **规则**:同一 `(participant, device, day, hour, provider)` 小时桶,客户端版本永远优先。插件类上传(`client.clientPlatform === "magpie-plugin"`)落在已存在客户端行(含 legacy 空戳行)的小时桶上时,服务端直接返回 noOp(带插件自身 rowCount,manifest 可落定);客户端桶照常整桶替换,顺带清掉该小时的插件行。
- **三态语义**:双开 = 客户端口径为主 + 插件仅补客户端看不见的小时(网关后台批次等)+ `magpie_local` 全归插件 → 云端共享来源总量 ≥ 客户端本地,差值即盲区流量(特性);仅插件 = 无客户端行,全量生效;仅客户端 = 行为不变。
- **实现**:`src/backend/store.js` `upsertHourlySnapshotBatch` 仲裁早退 + 行级写者戳 `usage_hourly.clientPlatform`;`usage_daily.hourlyDerived` 落列修复派生行清理(此前该标志只在内存,MySQL 部署每请求 `loadWriteScope` 重载即丢失,陈旧派生行永不清理 → 榜单双计;单写者桶缩减同样受益)。
- **设计内残差**:跨午夜请求两测量点归属小时不同(§11.4),小时级仲裁下同请求可能在相邻两小时各计一次(~十万 tokens 级);改天级仲裁会消灭插件补充价值,不取。
- **跨机边界**:同一份配置导入两台机器同时跑插件仍会互写(同 device 桶命名空间),跨机部署应各自注册设备,不在本机制覆盖内。
- **重置/重建流程**(运维):停插件 → 部署新版服务端(启动时自动 ALTER 加列)→ 按 deviceId 删 `usage_hourly`/`usage_daily`/`usage_sync_buckets(_hourly)`/`upload_batches` → 客户端 `atl reconcile --full` → 插件清 sync-state(或 `--full`)重新首同步 → 验收:共享来源逐日云端==本地、`magpie_local` 仅插件、插件桶在客户端在线小时被 noOp。
