# 算力共享 R3 发布与本机更新记录

日期：2026-09-21。源码基线：`5045ae7`，本轮仅推进发布版本、更新组件和验证，不扩展共享产品能力。后端由用户先行部署；本轮授权范围是在线卡片及本机 CPA、App 更新。

## 发布组件

| 组件 | 目标版本 | 当前证据 |
| --- | --- | --- |
| 后端 | 已部署服务 `0.7.16`，共享协议 2 | MySQL 健康检查通过；新增车道管理、单 Key 撤销接口的鉴权及业务校验生效。健康接口未提供 commit，不能仅凭版本号断言精确部署提交 |
| 在线卡片 | `compute-sharing@0.1.3` | OSS 发布完成；生产后端代理下载 SHA256 与 R3 源码一致；目录保留 `zhipu-plan@1.1.5`，只移除旧共享卡的目录条目，旧版本文件保留 |
| 本机 CPA | `0.5.3` | 停止核心后原子替换实际加载路径及默认安装路径，重启成功；线上心跳已报告 0.5.3；原三条车道、认领状态、策略确认版本与计量序号保留 |
| 本机 App / CLI | `0.7.17` | arm64 构建、包内版本与 JSON 错误契约校验通过；已替换 `/Applications/AI Token League.app` 并启动新 App/sidecar 进程；实际文件哈希与构建产物一致 |

卡片 SHA256：`d37a7086a164a54127a0231e838e2bd95c0bf3d33fa32c12b50f9717ea3e87ac`。

CPA SHA256：`b1c8c903b25d59a2f1ee7ff222b5f70fadf042db35b0c98c722872de2c8025a1`。

已安装 App 主程序 SHA256：`d480eeb8f5c76523f0cf9b643ce61925fa72e4fc0b3cc8db2a6e16d2ae2fda7a`；包内 CLI：`9acd25cae3888a0d77f543d1be1ea5f6551a0678a64039cad0cc2e5e96966d23`。

本机 App 安装副本采用 ad-hoc 签名，`codesign --verify --deep --strict` 通过；未做 Developer ID 签名或公证。当前机器 zip 为 `tests/output/compute-sharing-r3-rollout-20260921/artifacts/AI-Token-League-0.7.17-macos-arm64-local.zip`，未上传全局 App 下载渠道。

CPA 实际加载目录通过运行进程的 `lsof` 确认，属于 GUI 管理的 `cpa-core/plugins`，并非仅更新默认插件目录。安装前待上报 buckets/legacy 均为空，seq 有 1 个 Key；保留原 journal，未删除或重建身份、账本。

## 本轮验证

| 门禁 | 结果 |
| --- | --- |
| 发布版本一致性 | App、CLI、Tauri、Cargo 和 npm lock 均为 0.7.17；CPA Cargo/lock 为 0.5.3；卡片 manifest 为 0.1.3 |
| 后端/shared | `npm test` 通过；独立 MySQL round-trip 未配置而跳过；线上健康检查确认为 MySQL |
| Renderer | 20 文件、581 项通过；沿用的 vendor source map 提示不影响测试结果 |
| 交互 | 147 项 Playwright 全量通过，包含双语共享卡、异步取消、焦点、慢目录和升级入口 |
| Rust | workspace 全部已执行测试通过；CPA 47 passed、2 ignored，其中恢复子进程 helper 由父测试显式调用，人工性能探针本轮不重复运行 |
| 外部采集对账 | Claude 1 个完成日匹配，17 个已保留历史日按既有规则容忍；Codex 174、OpenCode 2、MiMo 55、WorkBuddy 6、Kimi 2 个完成日匹配；Hermes/OpenClaw 未配置而跳过 |
| 原生开发启动 | 隔离 HOME、ATL_HOME、CPA 数据路径下 `npm run desktop` 启动新版 App 和 sidecar 进程；验毕已停止该测试进程组 |
| 发布构建 | `scripts/release.sh --platform current --env env.local --yes`，本机 macOS arm64 |
| 实际安装与界面 | 已安装 App 显示本地 0.7.17；从卡头“升级 v0.1.3”完成真实下载和 repin，按钮消失、版本显示 0.1.3，缓存哈希与线上一致；owner 显示在线、三个车道及原认领 |
| 运行组合 | 包内 CLI doctor ready=true、CPA 0.5.3 心跳新鲜、协议 2、policyRev=policyAckedRev=1；App 云端 reachable、用量同步 success |

## 本机复验中的额外发现

1. App 首次启动健康检查出现暂时失败，`apiConnection` 保留旧 unreachable，但后续实际用量同步已成功。在设置中执行“检查连接”后，真实健康请求成功，界面恢复“已同步”；没有通过直接改写连接成功状态掩盖请求失败。
2. 复验跨越本机网络切换：节点已向后端上报新局域网地址，已有借用记录仍保留认领时的旧 `baseURL`，模型目录请求因此超时。确认旧地址失效、新地址属于同一 owner/share 后，在同一 `sharing-borrow` 跨进程锁内只修正一条本机记录的地址，其余字段、Key、有效期及额度不变；原始记录另作受限权限备份。包内真实 sidecar 随后成功读取 3 个 GLM 模型；重启 App 后，实际卡片模型下拉自动选择 `glm-5.3`，接入地址与 `ANTHROPIC_MODEL` 均正确显示。

第二项是仍待通用代码修复的 P2 缺陷（0.7-T87），本轮只恢复本机使用，不宣称已实现换网后的自动迁移。根因链：CPA 心跳更新 `share.baseURL` → `claimView` 未向已认证的 `/claims/mine` 回传地址 → sidecar `live()` 不更新本地接入元数据 → 卡片和 CLI 继续使用旧地址；卡片还会缓存首次模型目录失败，地址修正后需重新挂载卡片才能重新发现模型。后续应只在已认证的认领视图中提供最新地址，按 Key/身份在锁内合并元数据，地址变化时取消旧测试并使模型目录缓存失效，验证跨网络、并发撤销、失败恢复和 CLI/卡片一致性。

## 验证边界与回滚

- 本轮不修改真实车道或撤销现有 Key，不发起计费生成；线上检查验证服务可达、管理端点、版本心跳、策略确认及更新前后状态保留。生成扣账和重启恢复的逻辑证据来自 R3 自动化探针，不冒充本轮生产实流量验收。
- 本轮不发全平台 App 发行、不推 Git tag；在线分发变更为共享卡片，本机 App 与 CPA 的更新单独验证。
- 旧 App、两份 CPA dylib、旧卡片和目录，以及停止 CPA 后的身份/队列、App 配置和借用记录，已备份在本机受限权限目录。敏感文件未放入 Git 或公开产物。
- 回滚前先停止新的共享请求并检查 journal/ACK。保留最新 seq 和待确认队列；不要直接用备份覆盖持续变化的账本。旧卡片对象仍可下载，可重新固定旧版本。

日志与脱敏证据位于 `tests/output/compute-sharing-r3-rollout-20260921/`（Git 忽略）；发布前的线上复核位于 `tests/output/compute-sharing-live-20260921/`。

核心证据：`card-online.json`、`cpa-after.json`、`package-checks.json`、`final-runtime.json`、`local-endpoint-refresh.json`、`installed-model-discovery.json`。本轮工作集中为一次发布提交，不改写已经推送的 `5045ae7`。
