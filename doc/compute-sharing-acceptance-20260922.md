# 同环境分享与认领验收 — 2026-09-22

## 判定

**核心使用链路通过；可靠性放行仍需部署本轮后端修复。** 真实生产后端、已安装 CLI 0.7.17、CPA 插件 0.5.3 下，独立分享者和两名借用者完成分享、认领、模型发现、真实模型请求、扣账、CPA 重启、暂停/恢复、单 Key 撤销和终止。隔离 Claude Code 使用认领 Key 直接返回 `OK`。

验收同时发现一个 P1：MySQL 认领表的写入列漏掉 `lastSeq` 和三项撤销审计字段。源码已修复，真实 MySQL 与后端进程重启后重放验证通过；**生产尚未部署这次修复，不能宣称全部问题已在线解决。**

范围是同一后端、同一可达网络、CPA 已配置有效模型凭据的用户。使用独立进程/联赛身份经本机实际 LAN 地址访问，**未取得第二台物理设备，因此不把本机 LAN 地址请求当作跨设备、防火墙或 Wi-Fi 客户端隔离验收**。不覆盖公网访问、Windows/Linux 原生包或大规模并发。

## 实链证据

| 项目 | 当前生产组合 | 修复后的本地 MySQL 组合 |
| --- | --- | --- |
| 联赛注册与插件安装 | 三个隔离身份；通过正式 CLI 安装在线共享插件 | 同样走正式安装入口，再连接隔离 MySQL 后端 |
| 分享节点 | 真实 CPA 7.3.10 / atl-share 0.5.3，自动注册和协议 2 心跳 | 真实 CPA 7.3.10 / atl-share 0.5.4 |
| 目录与认领 | 两名借用者拿到不同 Key；公共目录不泄露地址；节点同步后模型目录可读 | 通过 |
| Messages / Chat Completions | 均为真实 GLM 请求，HTTP 200 | 均为真实请求，HTTP 200 |
| Responses | 暂停→恢复后同一 Key 请求 HTTP 200 | 通过 |
| Claude Code | 独立 HOME / 无用户设置、无 MCP、无工具，退出 0，回复 `OK`；输入 1468、输出 20 tokens | 不重复冒充本地后端覆盖；见生产实测 |
| 用量 | 首两次请求 47 + 36 = 83 tokens；后台 raw=charged=83、requests=2 | 首两次 112 + 48 = 160；raw=charged=160、requests=2 |
| CPA 重启 | Key、TTL、raw、charged、requests 均保留 | 通过 |
| 后端重启及批次重放 | 未重启用户生产服务 | SQL 保存 lastSeq=1；重启后重放同序号（伪造更大增量 999）仍为 160 tokens / 2 requests |
| 暂停 / 恢复 | 暂停请求 429，新认领被拒；Key/TTL 不变；恢复可用 | 通过 |
| 单 Key 撤销 | 目标 Key 失效，另一借用者仍可读取模型目录 | 通过，后端再次重启后 revokedBy/revokedAt/revokeReason 保留 |
| 终止 | 剩余 Key 被撤销，恢复请求 409 | 通过 |
| 已有认领地址迁移 | 老生产契约未覆盖，不宣称已上线 | 同一节点更换地址/端口后，原 Key/TTL 不变；本地记录、CLI 导出及模型目录自动恢复 |
| 清理 | 测试分享停止并从目录隐藏 | 同上；只停止隔离测试节点 |

上游真实请求经隔离 CPA 转发至已有 CPA 的普通 owner 通道，再到 GLM。未修改用户日常车道、撤销日常 Key 或导出 OAuth 凭据。测试身份、令牌和 CPA 配置仅保存在受限权限临时目录；脱敏证据不含令牌。

第一次生产尝试期间，主机从 `10.10.127.129` 切换到 `192.168.153.140`，导致绑定旧地址的测试 CPA 重启失败。保留为环境中断记录 `production-network-change.json`，后续按实际网络重新完成全链，不能将中断算作通过。

## 本轮修复

### P1：MySQL 去重与撤销审计漏写

`claimToRow`/`rowToClaim` 已有字段，但 `CLAIM_COLUMNS` 缺少 `lastSeq`、`revokedBy`、`revokedAt`、`revokeReason`。建表和内存值正常，实际 INSERT/UPDATE 未包含这些列；后端重启后去重基线归零，已计量但未收到 ACK 的批次可能再计一次，撤销原因也丢失。

修复为把四列纳入既有 upsert。未新增表、列或变更计费口径。增强真正的 MySQL round-trip：初始序号/审计、仅序号/审计变化的更新，以及新适配器加载均验证。修复前稳定失败 `0 !== 7`，修复后通过。再以真实 CPA 用量、后端进程重启、旧批次重放证明去重有效。

### P2 / T87：已有认领地址及异步状态

- 仅持有认领令牌的 `/claims/mine` 返回当前分享地址；公共目录不增加地址。
- sidecar 在跨进程锁内重读，以 keyId、token、shareId 三者匹配更新地址；不复活并发删除的 Key，不覆盖新凭据。
- CLI 配置导出和连通测试使用刷新后的地址。
- 卡片地址变化时取消旧探针并重建模型缓存；旧模型响应失效；手动/定时刷新可重试模型发现失败。
- 六个双语 E2E 覆盖失败恢复、旧模型响应、旧连通探针；Rust 覆盖锁内删除/凭据替换保护。

### P2：明确 LAN 绑定误报

CPA 绑定的具体 IP 等于所公布地址时，不再提示“地址不可达”。仍保留回环/其他地址与公布 LAN 地址不一致的警告。

## 自动化、安装包与原生边界

| 门禁 | 结果 |
| --- | --- |
| Node/shared/MySQL | 全部通过；本轮启用了独立 MySQL 26.7.0 实例，round-trip 未跳过；另有修复前失败证据 |
| Renderer | 581 项通过 |
| E2E | 最终全量 152 passed + 1 个既有动画时序断言失败；失败用例单独重跑通过。失败为分享海报的 120ms 动画瞬态，未改源码或放宽断言；本轮共享新增 6 项双语用例全部通过。此前 151 项全量通过（尚未加最后两个探针用例） |
| Rust workspace | 全部已执行测试通过 |
| CPA crate | 47 passed，2 ignored；恢复 helper 由父测试显式调用，人工性能探针本轮未重复 |
| 外部采集对账 | ccusage 通过；未配置的 Hermes/OpenClaw 跳过，已保留历史日按现有容忍规则处理；详见日志 |
| 版本与语法 | release:check v0.7.18、renderer/plugin JS 语法、git diff --check 通过 |
| 本机打包 | `scripts/release.sh --platform current --env env.local --yes` 成功，macOS arm64 |
| 包内 CLI / IPC | 0.7.18 的真实包内二进制通过本地 HTTP 契约服务器验证：地址落盘、Key/TTL 保留、模型发现、配置导出和 Chat Completions 探针；这项是包装边界验证，不冒充真实供应商流量 |
| 原生启动 | 隔离 HOME / ATL_HOME 下开发版及候选包均成功启动；原生卡显示 v0.1.4，目录失败→刷新→最新地址/模型自动恢复通过，见 native-observation.md |

候选产物：**App/CLI 0.7.18、共享卡 0.1.4、CPA 0.5.4**。尚未发布在线卡片或替换用户已安装组件，也未推分支/tag。当前已安装与在线组合仍是上一轮版本。

本地可交付 zip 位于 `tests/output/compute-sharing-same-env-20260922/artifacts/AI-Token-League-0.7.18-macos-arm64-local.zip`；CPA dylib、卡片 manifest/JS 和 SHA256SUMS 在同一目录。副本已完成 ad-hoc 签名及 `codesign --verify --deep --strict`；未做 Developer ID 签名或公证，不当作全平台公开发行包。

## 放行前的明确动作

1. 部署本轮后端代码。MySQL 字段已由现有 v2 迁移提供，本次仅补写入。发布窗口先暂停新共享请求，等待节点在途请求和待 ACK 队列清空，再重启服务；保留节点 journal，不能通过删除队列规避旧基线风险。
2. 更新借用者 App/CLI 0.7.18、卡片 0.1.4；分享者 CPA 0.5.4。先后端、再客户端，避免只更新卡片仍使用旧 sidecar 地址的情况。
3. 用第二台同网段设备完成一次目录→认领→模型请求；实际网络必须允许设备间访问 CPA 的公布地址。当前未提供可访问的第二台设备。
4. 上线后确认已认证认领视图有 baseURL、MySQL lastSeq 随请求增长、服务重启后仍保持，再扩大用户范围。

部署完成前，可以复核核心流程，但不作“可靠性问题全部在线解决”或“全面公开发布”的承诺。此次发现来自真实 SQL 写入边界，不能由 mock E2E、CPA 单测或健康接口替代。

## 证据索引

全部本机记录位于 `tests/output/compute-sharing-same-env-20260922/`（Git 忽略）：

- `production-chain.json`：已安装 0.7.17 / 0.5.3 对生产后端的全链通过、Claude Code 返回 OK。
- `local-chain.json`：修复后的 MySQL 后端、0.7.18 / 0.5.4 实链、重启重放及撤销审计。
- `mysql-v2-before-fix.log`、`backend-mysql.log`：漏写字段的修复前失败、修复后通过。
- `workspace.log`、`cpa-tests.log`、`renderer.log`、`e2e.log`、`e2e-orientation-retest.log`、`t87-e2e.log`、`ccusage.log`。
- `package.log`、`package-checks.json`、`packaged-ipc.json`、`native-observation.md`。
- `live-chain.mjs` 为本次环境专用验收驱动，使用受限临时身份及有限模型请求；长期回归已并入 Rust、Node/MySQL 和 E2E 测试，不把环境专用脚本当作通用运维入口。
