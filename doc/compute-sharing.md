# Compute Sharing（算力共享）— feat/compute-sharing

状态：**分支阶段，未并入任何产品基线**。本页描述已实现并验证的行为与边界。

## 产品流程

三方各只见自己需要的东西：

```text
分享者（桌面端/脚本）                 云端（src/backend）                借用方（Web 页面 + AI 工具）
─────────────────────               ─────────────────────             ─────────────────────
跑本地共享网关                       共享注册表                        打开 /sharing.html
  ├─ 真实凭证留在本机 CPA    ──注册──▶ baseURL/模型/预算                浏览在线节点与预算
  ├─ 预算账本/自用保留        ◀─JWKS──  Ed25519 签发 Key       ──认领──▶ 拿到 baseURL + Key
  └─ 心跳/用量上报            ◀─撤销流──                            两行环境变量接入：
                                    ▲                                ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN
                                    └──── 用量/状态展示（无内容、无凭证）
```

借用方的完整接入面 = **一个 URL + 一个 Key**，都从云端认领接口拿，不需要记住任何分享者的 IP 或临时信息。

## 组件

| 文件 | 角色 |
| --- | --- |
| `src/shared/sharing-keys.js` | Ed25519 临时 Key 签发/验签/JWKS（后端与网关共用） |
| `src/backend/compute-sharing.js` | 控制面：注册/心跳/用量/认领/撤销/JWKS + 管理端点。自含 JSON 存储（`data/compute-sharing.json`），不碰 usage store 与 MySQL |
| `src/sharing/gateway.js` | 分享者本地网关：验签、模型白名单、并发、原子预留-结算预算账本、自用保留（滞回）、心跳与用量上报。上游默认指向本机 CPA（8317） |
| `src/sharing/ledger.js` | 预算账本（预留→结算→释放；重启保守结算） |
| `src/web/sharing.html` + `sharing.js` | 借用方认领页（双语，localStorage 保存我的认领，自助撤销） |

server.js 仅两处接线：实例化 + `/api/shares`、`/api/admin/shares` 路由委托（admin 子路径继承 Basic Auth）。

## API

| 端点 | 谁用 | 说明 |
| --- | --- | --- |
| `POST /api/shares/register` | 网关 | 首次注册返回 shareId + shareSecret（仅一次）；更新需 `x-atl-share-secret`；**新 share 为 pending，批准前不可见不可认领**（防假 baseURL 收割 prompt 的蜜罐） |
| `POST /api/shares/heartbeat` / `usage` / `unregister` | 网关 | 在线状态（TTL 15s）、用量事件、注销 |
| `GET /api/shares` | 公开 | **已批准**在线共享列表（**不含 baseURL**） |
| `POST /api/shares/claim` | 借用方 | 按 shareId 或模型认领（仅已批准+在线+active 的节点）→ `baseURL + token + 有效期`；每 IP 限频、每份额限并发名额 |
| `GET /api/shares/claims/:keyId` | 借用方 | 认领状态与已用量 |
| `POST /api/shares/claims/:keyId/revoke` | 借用方 | 自助撤销（须出示 token 本身作凭证） |
| `GET /api/shares/jwks` / `revocations?since=` | 网关 | 本地验签 / 撤销轮询 |
| `GET/POST/DELETE /api/admin/shares*` | 管理员 | 全量视图、撤销、改策略、删除节点。与 `/admin.html` 同一道 Basic Auth：页面能打开就能管，没有单独的开放开关 |

## 网关运行（分享者侧）

极简形态——首次带 `--api`，之后零参数：

```bash
node src/sharing/gateway.js --auto --api http://<backend>:8788   # 首次
node src/sharing/gateway.js                                       # 之后（配置已持久化）
node src/sharing/gateway.js status | pause | resume | self-usage <pct>
```

`--auto` 自动发现本机 CPA（EasyCLIProxyAPI / `~/.cli-proxy-api` 的 config.yaml：端口+入站 key）、探测局域网 IP 生成借用方可达的 baseURL，并持久化到 `~/.ai-token-league/sharing/config.json`。优先级：CLI 参数 > 环境变量 > 持久化配置 > 自动发现默认值。显式环境变量（`ATL_SHARING_UPSTREAM/UPSTREAM_KEY/MODELS/...`）仍可覆盖一切用于测试。

身份（shareId/shareSecret）持久在 run dir，重启以同一 shareId 重注册，账本不重置。

**fail-closed 语义**：网关与后端的撤销通道断链（secret 被 401 拒绝、或超 10 分钟无成功同步）时自动暂停全部借用流量并告警，恢复后自动复航；JWKS 刷新失败时回退用缓存密钥验签（后端单 kid 长生命周期，不会因后端抖动全站 401）。

## 验证

- `npm test` 全量绿（新增 5 组：签发/验签轮转、注册与视图、认领生命周期/持久化、限频与名额、离线与管理端）
- env.local E2E（隔离端口 8799 + mock 上游 + 真网关）：认领→非流式/流式调用→按 Key 计量对账→错 Key 401→自助撤销后网关 1s 内拒绝→自用保护 503/恢复与云端联动→网关重启同 shareId+账本精确保持→下线 TTL 后 offline
- 早前 demo（`demo/compute-sharing/`，本分支一并收录作参考）：CPA 接入链路、多 owner 路由切换、`$Authorization` 透传、管理 API 热更 Key 等实测结论见其 README

## 安全模型与已知边界（分支阶段）

- **默认信任 + 异常兜底**（用户拍板）：share 注册即上线，无需批准；管理端不做事前干预，只做异常兜底。两个异常闸门会自动送人工审核：同 baseURL 重复注册（节点劫持/顶替模式）、单 IP 注册洪泛（默认 >5 个/小时）；admin 另有「下架」兜底原语（隐藏 + 级联撤销该节点全部 Key，心跳不能翻回，可再批准恢复）。残余风险：注册端点无账号身份，自动批准 = trust-on-first-use，蜜罐面靠异常闸门 + 下架兜底收敛，接联赛账号身份是后续硬化方向
- **fail-closed**：网关-后端撤销通道断链（401/失联>10min）即暂停借用流量；rotate-secret 级联撤销存量 Key；JWKS 陈旧回退只影响新 kid（安全方向）
- Owner 认证用 per-share 随机 secret（哈希存储）；升级方向是复用现有设备身份签名
- 认领端点公开（限频 + 名额 + TTL + 可撤销）；生产化前需要接联赛账号身份
- 公开端点 readBody 1MB 上限；claims 有界 GC；IP 限频表有界（反代部署需注意共享 IP 语义，见待办）
- 云端只见元数据（谁/多少 token/何时），不见请求正文与凭证——正文只经过分享者本地网关，这是"第一版面向熟人/组织圈"的原因
- 借用方请求内容对分享者原则上可见（网关本地终止 TLS）；跨网部署需要加密中继（后续）
- 共享 admin 端点不继承"无 ADMIN_USERNAME 即开放"的旧回退（rotate-secret 会发新 secret，属接管级凭证）
- 存储为 JSON 文件；MySQL 适配器待产品化时加（接口已隔离在 compute-sharing.js 内）
- 桌面端（Tauri）"算力共享"面板与网关托管是下一步：当前网关为 Node 进程，桌面集成需 spawn 或移植 Rust

## 未做（排队中）

配额探测接真实供应商（GLM/Codex 窗口余量）、collector 遥测驱动 self-usage、加密中继、贡献榜接入联赛体系。
