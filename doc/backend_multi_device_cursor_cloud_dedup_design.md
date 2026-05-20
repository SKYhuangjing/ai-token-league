# 多设备 Cursor 云端数据去重设计

## Review Surface

### 目标

支持同一用户在多台电脑安装客户端后，服务端能正确聚合同一 `participantId` 的多设备数据：Codex / Claude Code 本地日志按设备累加；Cursor Dashboard Usage 来自 Cursor 云端，同一 Cursor 账号在多设备上报时只能计一次。

本方案以当前版本的 hourly snapshot 上传为权威写入面：`snapshot.mode = device_day_hour_provider`。历史重复数据不通过细粒度 repair 兜底，改由云端 reset + 本地 sync-state 核对 / 重传闭环修正。

### 成功标准

| 场景 | 成功标准 |
|---|---|
| 同一用户多设备 Cursor 同账号 | 同一 `participantId + day + hour + model + Cursor账号` 只保留一份用量 |
| 同一用户多设备本地 provider | Codex / Claude Code 不去重，按设备累加 |
| 第二台设备加入已有身份 | `participantId` / identity key 相同，`deviceId` 保持新设备自己的值 |
| 恢复原设备 | 用户明确选择恢复模式后，才允许恢复备份中的 `deviceId` 和本地同步状态 |
| 云端 reset 后本地仍标记已上传 | 客户端能发现服务端缺 bucket，并重新上传真实 hourly snapshot |

### 方案判断

| 结论 | 判断 |
|---|---|
| 用 Cursor 登录邮箱作为去重身份 | 合理，但只能作为 hash 输入，不能把 token/cookie 上传到服务端 |
| 用浏览器授权取代 Add Cursor Token | 合理；主入口改为 `Connect Cursor`，客户端生成 `uuid/challenge`，用户在 Cursor Web 确认后本地轮询拿 token |
| Cursor 账号自动刷新 | 必须补；当前 token 失效会静默漏采，Connect Cursor 落地时要同时保存 refresh token 并在扫描前刷新 |
| 不考虑 daily 合并 | 当前版本可接受，前提是版本边界明确为 hourly-only；legacy daily 只能作为兼容路径，不作为本次主链路 |
| 用云端 reset 替代历史 repair | 可接受，但必须同步解决本地 manifest 失真，否则 reset 后客户端会 no-op |
| 只在服务端写入时 dedup | 不完整；还需要客户端账号身份稳定化和 reset 后 sync-state 核对 |
| 用导入配置做多设备入口 | 只有在导入时按用户意图区分“加入已有身份”和“恢复原设备”才成立；默认整份恢复会覆盖 `deviceId`，会破坏多设备语义 |

### 本次做 / 不做

| 类型 | 内容 |
|---|---|
| 本次做 | `Connect Cursor` 浏览器授权、Cursor token refresh / reauth 状态、Cursor 账号身份稳定化、多设备身份引导与导入配置选择、hourly 写入跨设备去重、daily derived 只来自去重后的 hourly、云端 reset 后的 sync-state 核对 |
| 本次不做 | 不新增 daily snapshot 合并主链路；不再把手动 `Add Cursor Token` 作为主入口；不把 Cursor token、cookie、原始 auth 响应上传服务端 |
| 不放宽 | 排行榜仍按 `totalTokens`；服务端仍不得接收 prompt、response、源码、真实路径、Cursor session token、identity private key |
| 必须复用 | `POST /api/usage/daily-batch`、hourly snapshot、`usage_hourly`、`usage_daily` derived serving table、`sync-manifest.json` |
| 前置阻断 | 未实测 `auth/poll` 与 `oauth/token` 的 request/response 前，不进入正式实现 |

## 现状与边界

### 现状

- 当前客户端按 `day + hour + providerId` 分 bucket 上传 `device_day_hour_provider` snapshot。
- `usageKey` / `hourlyUsageKey` 包含 `deviceId`，这对本地 provider 是正确的。
- Cursor provider 当前用 `virtual:cursor-dashboard:Cursor · <account_name>` 生成虚拟 workdir，再由 `workdir_from_candidate()` 结合 `participantId` 生成 `workdirHash`。
- Cursor 配置当前以本地 token / cookie 输入为主，用户需要手工复制敏感材料，体验和安全边界都不理想。
- 当前 Cursor token 没有自动刷新：手动 token 只保存 token/accountName，扫描失败时会跳过 Cursor source，UI 不一定显示账号已失效。
- `sync-manifest.json` 只记录本地认为已成功上传的 bucket fingerprint；如果云端数据被 reset，本地 manifest 不会自动失效。
- 配置导入 / 本地备份恢复如果直接写入备份中的 `deviceId`，会把第二台电脑伪装成第一台电脑；这只适合设备迁移，不适合多设备加入。

### 根因

Cursor Dashboard Usage 是云端账号级事实，不是设备级事实。多台设备用同一个 Cursor 账号拉到同一批云端事件，如果服务端按 `deviceId` 分行存储并聚合，就会重复计数。

### 边界确认

当前版本只要求 hourly 上传链路正确。因此本次去重的事实源是：

```text
participantId + day + hour + providerId + toolCode + cursorAccountHash + model
```

不是：

```text
participantId + deviceId + day + hour + providerId + workdirHash + model
```

## 主链路与规则视图

```mermaid
flowchart TD
  A["用户点击 Connect Cursor"] --> B["客户端生成 uuid + code_verifier + challenge"]
  B --> C["打开 cursor.com/loginDeepControl"]
  C --> D["用户在 Cursor Web 登录并确认"]
  D --> E["客户端 poll api2.cursor.sh/auth/poll"]
  E --> F["本地保存 Cursor token 与账号信息"]
  F --> G["调用 Cursor account/me 或 auth/me 提取邮箱"]
  G --> H["规范化邮箱并生成 cursorAccountHash"]
  H --> I["扫描 Cursor usage events"]
  I --> J["生成 hourly usage item"]
  J --> K["POST /api/usage/daily-batch"]
  K --> L["服务端识别 cloud provider"]
  L --> M["按 cloud natural key 删除其他设备重复 hourly rows"]
  M --> N["写入当前 hourly rows"]
  N --> O["derive usage_daily"]
  O --> P["Leaderboard 聚合"]
```

### 规则卡：Cursor Cloud Natural Key

| 项 | 规则 |
|---|---|
| 输入事实 | `providerId=cursor_dashboard_usage`、Cursor 登录邮箱、`participantId`、`day`、`hour`、`toolCode`、`model` |
| 派生值 | `cursorAccountHash = sha256("cursor-dashboard:" + normalizedEmail + ":" + participantId)` |
| 判定顺序 | 仅 cloud provider 进入该规则；本地 provider 直接跳过 |
| 不命中反例 | `providerId=codex_local` / `claude_code_local`；Cursor 未取到邮箱且无稳定 user id |
| 命中动作 | 删除同一 cloud natural key 下其他 `deviceId` 的 `usage_hourly` 行，再写入当前行 |
| 修复动作 | 云端 reset 后通过 sync-state 核对缺失 bucket 并重传 |
| 关联验证 | 多设备 Cursor 同账号只计一次；不同 Cursor 账号不互删；本地 provider 不受影响 |

### 去重矩阵

| Provider | 多设备同账号 / 同 workdir | 多设备不同账号 / 不同 workdir | 处理 |
|---|---:|---:|---|
| `cursor_dashboard_usage` | 去重 | 保留 | 云端账号事实，跨设备重复 |
| `codex_local` | 保留 | 保留 | 本地日志事实，设备之间应累加 |
| `claude_code_local` | 保留 | 保留 | 本地日志事实，设备之间应累加 |

## Detail Blocks

### Cursor 浏览器授权登录

用 `Connect Cursor` 取代现有 `Add Cursor Token` 主入口。流程参考 Cursor deep login：

```mermaid
sequenceDiagram
  participant D as Desktop
  participant B as Browser
  participant CW as cursor.com
  participant API as api2.cursor.sh

  D->>D: generate uuid + code_verifier
  D->>D: challenge = base64url(SHA256(code_verifier))
  D->>B: open loginDeepControl?uuid&challenge&mode=login
  B->>CW: user login / confirm
  CW->>CW: bind uuid + challenge to web account
  D->>API: GET /auth/poll?uuid&verifier=code_verifier
  API-->>D: 404 pending / 200 token payload (camelCase)
  D->>CW: GET /api/auth/me (Cookie: WorkosCursorSessionToken)
  CW-->>D: email, sub, name, ...
  D->>D: save accessToken + refreshToken + email locally
```

本地状态：

| 字段 | 规则 |
|---|---|
| `uuid` | 每次连接生成，作为本次登录会话 id |
| `codeVerifier` | 本地随机值，只保存在内存 pending state |
| `challenge` | `base64url(SHA256(codeVerifier))`，放入浏览器 URL |
| `expiresAt` | 默认 5 分钟，过期后必须重新发起 |
| `poll interval` | 默认 2 秒；`404` 表示用户未完成确认，继续等待 |

成功响应只允许写入本地配置，不进入 `/api/usage/daily-batch`。手动粘贴 token / cookie 入口降级为故障 fallback，可隐藏到高级设置，不作为普通用户主路径。

实现前置实测：

| 接口 | 实测结果 | 状态 |
|---|---|---|
| `GET https://api2.cursor.sh/auth/poll?uuid=<uuid>&verifier=<codeVerifier>` | pending=404/plain, success=200/JSON, camelCase: `accessToken`, `refreshToken`, `authId`, `challenge`, `uuid`; **无 email** | ✅ 已确认 (T01) |
| `POST https://api2.cursor.sh/oauth/token` | snake_case payload/response: `access_token`, `id_token`, `shouldLogout`; **不返回新 `refresh_token`** | ✅ 已确认 (T01) |
| `GET https://cursor.com/api/auth/me` (Cookie: WorkosCursorSessionToken) | 返回 `email`, `email_verified`, `name`, `sub`, `id` 等 | ✅ 已确认 (T01) |

本地持久化字段：

| 字段 | 规则 |
|---|---|
| `accessToken` | Cursor API bearer token；只保存在本机 |
| `refreshToken` | 用于刷新 access token；只保存在本机 |
| `authId` | Cursor / WorkOS 用户标识；用于 fallback 身份 hash |
| `email` | 仅用于本地展示和生成 `cursorAccountHash` |
| `accessTokenExpiresAt` | 从 JWT `exp` 解析；缺失时按 `lastRefreshAt` + 默认 TTL 保守处理 |
| `lastRefreshAt` | 最近一次 refresh 成功时间 |
| `authStatus` | `active` / `refresh_failed` / `reauth_required` |
| `ignored` | 账号级采集开关；为 `true` 时继续 refresh / reauth 状态维护，但不扫描、不上传该账号用量 |

本地存储和清理边界：

| 对象 | 规则 |
|---|---|
| 配置结构 | `cursorDashboardUsage.accounts[]` 是本版本唯一 Cursor 账号来源；旧 `workosSessionToken(s)` 只在加载/保存时清理，不再作为扫描来源 |
| 诊断导出 | 只导出账号数、masked email、`authStatus`、`lastRefreshAt`；不得导出 token 字段 |
| runtime log | 不打印 token、完整邮箱、原始响应；只打印 account hash 和状态 |
| 本地 reset | 清理授权账号、旧 token、sync manifest、upload queue |
| backup / restore | backup 若包含账号配置，必须 redacted；restore 不恢复真实 token |

### 多设备身份引导与导入配置

多设备验收不能把“加入同一排行榜身份”和“恢复一台旧设备”混成同一个导入动作。前者要求共享 `participantId` / identity key，但保留每台机器独立的 `deviceId`；后者才允许恢复备份里的 `deviceId` 和本地同步状态。

用户意图选择：

| 入口 | 选项 | 默认 / 推荐 | 行为 |
|---|---|---|---|
| 初次引导 / onboarding | 创建新身份 | 新用户默认 | 生成新的 `participantId`、identity key 和 `deviceId` |
| 初次引导 / onboarding | 加入已有排行榜身份 | 已有导出 identity / 配置时推荐 | 导入 identity，保留或生成本机 `deviceId`，不恢复 Cursor token / sync manifest / upload queue |
| 导入配置 | 加入已有排行榜身份 | 默认 | 从配置文件中导入身份和低风险偏好，但保留当前 `deviceId`；清理本机 sync manifest / upload queue |
| 导入配置 | 恢复原设备 | 高级 / 需确认 | 恢复配置文件中的 `deviceId` 和本地状态；UI 必须提示这会替代原设备身份，不用于多设备加入 |
| 本地备份恢复 | 恢复原设备 | 固定语义 | 作为灾备 / 换机入口，保留完整本地状态；不得作为多设备推荐路径 |

字段策略：

| 字段 / 文件 | 加入已有排行榜身份 | 恢复原设备 |
|---|---|---|
| `participantId` | 从导入文件覆盖 | 从导入文件覆盖 |
| `identityPublicKey` / `identityPrivateKey` | 从导入文件覆盖 | 从导入文件覆盖 |
| `nickname` | 可从导入文件覆盖，用户可改 | 从导入文件覆盖 |
| `deviceId` | 保留当前值；若当前没有配置则新生成 | 从导入文件恢复 |
| `apiBaseUrl` / language / display 偏好 / provider 开关 | 可导入 | 可导入 |
| `cursorDashboardUsage.accounts[]` | 不恢复真实 token；要求本机重新 `Connect Cursor` | 不恢复真实 token；要求本机重新 `Connect Cursor` |
| `sync-manifest.json` / `sync-state.json` | 不恢复；必要时清理，避免 no-op | 可恢复或由备份恢复 |
| `upload-queue.json` / `usage-cache.json` | 不恢复 | 可恢复 |
| 本地路径 / provider roots | 默认不导入跨机路径；用户手动选择 | 可恢复，但应提示路径可能失效 |

导入配置的最小 API 语义：

```text
importConfig(file, mode)

mode = "join_existing_participant" | "restore_device"
```

`join_existing_participant` 是普通多设备默认值；`restore_device` 是灾备 / 换机高级路径。UI 不直接问“是否覆盖 deviceId”，而是问“你想加入已有身份，还是恢复原设备”，避免用户选择底层字段时误判。

验收口径：

| 场景 | 必验结果 |
|---|---|
| 第二台设备选择加入已有排行榜身份 | 导入后 `participantId` 相同，`deviceId` 不同；register 后服务端出现两个 device |
| 第二台设备重新 Connect Cursor | Cursor 同账号 hourly 用量不翻倍，本地 Codex / Claude 仍按两台设备累加 |
| 第二台设备误选恢复原设备 | UI 有明确风险提示；确认后 `deviceId` 与备份一致，行为按设备迁移处理 |
| 导入配置包含 Cursor token | join 模式和 restore 模式都不写入真实 token；需要重新授权 |

废弃来源边界：

| 来源 | 规则 |
|---|---|
| `Connect Cursor` 授权账号 | 主配置来源，拥有 refresh / reauth 生命周期 |
| 被忽略的授权账号 | 继续保留并刷新 token；health 显示为已忽略；不生成扫描 source，不上报用量 |
| Cursor 本机 `state.vscdb` / JSON 自动检测 | 本版本废弃；不参与扫描、health source 展示、去重身份或 refresh 状态 |
| Antigravity cockpit / 历史 auto source | 本版本废弃；`providerIgnoredAutoSources.cursor_dashboard_usage` 在配置保存时清理 |
| legacy 手动 token | 不作为产品入口；旧 `workosSessionToken(s)` 在配置保存时清理，不参与扫描 |

### Cursor 账号身份

浏览器授权成功后，客户端用 poll 返回的 `accessToken` 构造 `WorkosCursorSessionToken` cookie，调用 `cursor.com/api/auth/me` 获取登录邮箱。`auth/poll` 响应和 JWT payload 中均不含 email，必须通过此接口获取。

处理规则：

| 字段 | 规则 |
|---|---|
| 登录邮箱 | 从 `cursor.com/api/auth/me` 响应的 `email` 字段提取，trim + lowercase；只作为 hash 输入 |
| `cursorAccountHash` | `sha256("cursor-dashboard:" + normalizedEmail + ":" + participantId)` |
| `workdirCandidate` | `virtual:cursor-dashboard:<cursorAccountHash>` 或等价稳定虚拟 key |
| `workdirDisplayName` | 可继续显示 `Cursor · <email>`；若后续收紧隐私，可改为 `Cursor · <masked email>` |
| fallback | 如果邮箱不可得，可退回稳定 `auth_id` / user id hash；不能退回设备相关字段 |

注意：Cursor access token、refresh token、Cookie、Workos token、原始 auth 响应都不得进入上传 payload、日志和诊断导出。

### Cursor token refresh

Connect Cursor 必须同时交付 refresh 闭环，否则 token 失效后会漏采 Cursor 云端数据。

刷新触发：

| 时机 | 动作 |
|---|---|
| scan 前 | 如果 `accessTokenExpiresAt` 距当前小于 5 分钟，先 refresh 再请求 usage |
| usage API 返回 `401` / `403` | 立即 refresh 一次，并重试当前 Cursor usage 请求一次 |
| refresh 失败 | 标记账号 `reauth_required`，本轮不再继续请求 Cursor usage |
| 用户点击重新连接 | 重新走 `Connect Cursor`，成功后替换该账号 token 链 |

刷新接口（已确认）：

```http
POST https://api2.cursor.sh/oauth/token
Content-Type: application/json

{
  "grant_type": "refresh_token",
  "client_id": "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB",
  "refresh_token": "<local refreshToken from poll>"
}
```

成功响应（snake_case，与 poll 的 camelCase 不同）：

```json
{
  "access_token": "<new access token>",
  "id_token": "<id token>",
  "shouldLogout": false
}
```

注意：响应**不包含 `refresh_token`**，即没有 rotation，必须保留 poll 阶段获得的原始 `refreshToken`。

失效响应：

```json
{
  "access_token": "",
  "id_token": "",
  "shouldLogout": true
}
```

实现约束：

| 约束 | 说明 |
|---|---|
| 私有接口 | `api2.cursor.sh/oauth/token` 属于非公开协议，必须保留 `Connect Cursor` reauth fallback |
| refresh token rotation | 响应不返回新 `refresh_token`（已确认），保留 poll 阶段获得的原始 `refreshToken` 即可 |
| 并发控制 | 同一 Cursor account 同时只允许一个 refresh；其他 scan 等待结果 |
| 重试上限 | 同一请求最多 `refresh + retry usage` 一次，避免 401 循环 |
| 状态回写 | refresh 成功后更新 `accessToken`、`accessTokenExpiresAt`、`lastRefreshAt`、`authStatus=active` |
| 失败可见 | `shouldLogout=true`、401/403、网络连续失败都要进入 health 状态，不得静默吞掉 |

账号状态映射：

| 状态 | 含义 | UI / 行为 |
|---|---|---|
| `active` | token 可用 | 正常扫描和上传 |
| `refresh_failed` | 网络或临时错误导致 refresh 未完成 | 本轮跳过 Cursor，保留 token，下次重试 |
| `reauth_required` | refresh token 失效或 Cursor 要求 logout | Sources 显示 `Reconnect Cursor`，用户重新授权 |

### 服务端 hourly 去重

新增 cloud provider 集合：

```js
CLOUD_PROVIDER_IDS = new Set(["cursor_dashboard_usage"])
```

服务端处理 `upsertHourlySnapshotBatch()` 时：

1. 规范化 incoming items。
2. 对 cloud provider 构造 cloud natural key：
   ```text
   participantId | day | hour | toolCode | providerId | workdirHash | model
   ```
   其中 Cursor 的 `workdirHash` 必须来自账号 hash，而不是设备或本地路径。
3. 只删除同一 natural key 且 `deviceId != input.deviceId` 的 `usageHourly` 行。
4. 当前设备自身 stale rows 仍交给现有 bucket replace 逻辑处理，不能由 cloud dedup 扩大删除范围。
5. 写入当前设备 hourly rows。
6. 从去重后的 hourly rows derive daily rows。

删除边界：

| 条件 | 行为 |
|---|---|
| `participantId/day/hour/toolCode/providerId/workdirHash/model` 全相同且其他 `deviceId` | 删除旧 hourly row |
| 同一设备同 bucket 缺失 row | 由 `deleteHourlyBucketUsageRows()` 处理 |
| 不同 hour / model / Cursor account | 不删除 |
| 本地 provider | 不进入 cloud dedup |

当前 MySQL hourly 路径会走 `syncAllTables()`，可以先保证正确性。若后续优化成增量同步，必须把被 dedup 删除的 hourly/daily keys 带入 MySQL 事务显式删除。

### daily 边界

本次不把 daily snapshot 合并作为主链路，原因：

- 当前版本上传基线是 `device_day_hour_provider`。
- `usage_daily` 是 serving table，应由 hourly derive。
- 修 daily snapshot 不能解决云端 reset 后本地 manifest no-op 的根因。

兼容要求：

| 情况 | 处理 |
|---|---|
| 新版本 hourly 客户端 | 完整支持 Cursor 跨设备去重 |
| legacy daily 客户端 | 保持兼容，但不作为本次验收主链路 |
| 服务端仍允许 daily Cursor 上传 | 需要明确风险：旧客户端仍可能产生重复；正式发布前要么版本门禁，要么补最小 daily cloud dedup |

### 云端 reset 与 sync-state 核对

云端 reset 可以替代历史 repair，但不能单独成立。原因是本地 `sync-manifest.json` 仍记录旧 bucket fingerprint，下一次同步会认为 bucket 已上传并跳过。

必须新增一个核对机制：

```mermaid
sequenceDiagram
  participant C as Client
  participant S as Server

  C->>S: signed sync-state request with local bucket fingerprints
  S-->>C: missing / different bucket list
  C->>C: invalidate local manifest entries
  C->>S: re-upload hourly snapshots
  S-->>C: accepted / noOp
  C->>C: update sync-manifest.json
```

推荐接口：

```text
POST /api/usage/sync-state
```

请求必须签名，签名范围与 `/api/usage/daily-batch` 一致，最小字段：

| 字段 | 说明 |
|---|---|
| `participantId` | 当前用户 |
| `deviceId` | 当前设备 |
| `clientGeneratedAt` | 请求生成时间 |
| `buckets[]` | 本地 manifest 中的 `day/hour/providerId/fingerprint` |
| `signature` | identity private key 签名 |

响应：

| 字段 | 说明 |
|---|---|
| `missing[]` | 服务端不存在，需要本地重传 |
| `different[]` | 服务端 fingerprint 不一致，需要本地重传 |
| `matched[]` | 服务端已存在，可继续 no-op |

服务端比对口径：

| 项 | 规则 |
|---|---|
| 比对表 | 当前版本只比 `usage_sync_buckets_hourly` |
| key | `participantId + deviceId + day + hour + providerId` |
| 语义 | 判断“该设备的 bucket 是否已被服务端确认接收”，不是判断最终 leaderboard 是否仍保留该设备的 usage row |
| Cursor dedup 后其他设备 usage 被删 | 不删除其 sync bucket；避免被删设备反复重传同一云端事实 |
| 云端 reset | reset 必须删除 usage rows 和 sync bucket；客户端下一次 sync-state 才能得到 `missing` 并重传 |

触发时机：

| 时机 | 规则 |
|---|---|
| 云端 reset 成功后 | 立即清空对应 server URL 的本地 manifest，下一次全量重传 |
| 普通同步前 | 每天或每 N 次 sync 对最近 35 天 hourly bucket 做一次 sync-state 核对 |
| 队列重放后 | 上传成功才更新 manifest；失败继续留在 queue |

## 验证与可观察性

| 覆盖组 | 验证入口 | 必验证据 |
|---|---|---|
| 多设备引导加入已有身份 | Desktop / CLI import case | `participantId` 相同、`deviceId` 不同；服务端 register 后有两个 device |
| 导入配置 join 模式 | Config import unit / desktop command case | 不覆盖当前 `deviceId`，不恢复 sync manifest / queue / Cursor token |
| 导入配置 restore 模式 | Config import unit / desktop command case | 用户确认后恢复备份 `deviceId`；风险提示可见 |
| Cursor 同账号多设备 | Store / HTTP API case | `usage_hourly` 同 natural key 只剩 1 行，leaderboard 不翻倍 |
| Cursor 不同账号 | Store / HTTP API case | 不同 `cursorAccountHash` 都保留 |
| 本地 provider 多设备 | Store / HTTP API case | Codex / Claude 同 day/hour/model 均累加 |
| Cursor dedup 与 sync bucket | HTTP API case | A 设备 usage 被 B 设备同账号覆盖后，A 的 hourly sync bucket 保留，不触发反复重传 |
| 废弃 Cursor 本机检测 | mocked scan / health case | 旧 token、历史 ignored auto source、本机检测数据不再生成 Cursor 扫描 source 或 health 行 |
| 云端 reset 后重传 | API + 本地 sync manifest case | reset 后 sync-state 返回 missing，本地清 manifest 并重新上传 |
| 浏览器授权登录 | Desktop command / mocked HTTP case | 生成 `uuid/challenge`，轮询 pending/成功/过期/取消分支正确 |
| token refresh 成功 | mocked HTTP case | scan 前过期 token 调用 `/oauth/token`，更新本地 token 后继续 usage 请求；未返回新 refresh token 时保留旧值 |
| 忽略 Cursor 授权账号 | mocked scan / health case | 账号继续显示和 refresh，但不生成 usage item / upload payload |
| reactive refresh 成功 | mocked HTTP case | usage 401 后 refresh 成功并重试一次，最终不进入失败态 |
| token refresh 失败 | mocked HTTP case | `shouldLogout=true` 或 401/403 后账号进入 `reauth_required`，UI 显示重新连接 |
| 隐私边界 | payload / diagnostics grep | 不出现 access token、refresh token、Cookie、Workos token、原始 auth 响应、真实路径 |
| MySQL 持久化 | MySQL reload case | 服务重启 / `load()` 后重复 Cursor 行不反弹 |

可观察性最小要求：

- 客户端日志只记录 `providerId`、bucket key、rowCount、fingerprint 前缀、sync-state 结果数量。
- refresh 日志只记录 account hash、状态码、`shouldLogout`、是否重试；不记录 access / refresh token。
- 服务端日志只记录 `participantId`、`deviceId`、`providerId`、deleted count、accepted count。
- 不记录 Cursor 邮箱明文到日志；若 UI 继续展示邮箱，日志仍使用 hash 或 masked 值。

## 兼容性 / 发布 / 待确认

### 发布策略

| 阶段 | 动作 |
|---|---|
| 代码发布 | 先发客户端账号 hash + 服务端 hourly dedup + sync-state |
| 数据修正 | 对受影响用户执行云端 reset，或由用户触发 local+cloud reset |
| 客户端恢复 | reset 后清空对应 server URL 的 `sync-manifest.json` bucket，重新上传 hourly snapshot |
| 观察 | 对 leaderboard、usage quality、sync-state missing count 做发布后核对 |

### 待确认项

| 问题 | 默认建议 | 状态 |
|---|---|---|
| Cursor deep login 私有接口稳定性 | 保留手动 token / cookie 作为高级 fallback，但 UI 主入口改为 `Connect Cursor` | 开放 |
| `api2.cursor.sh/auth/poll` 响应字段名 | camelCase: `accessToken`, `refreshToken`, `authId`, `challenge`, `uuid`；**无 email** | ✅ T01 已确认 |
| `api2.cursor.sh/oauth/token` refresh 协议 | snake_case payload/response: `access_token`, `id_token`, `shouldLogout`; **不返回新 `refresh_token`** | ✅ T01 已确认 |
| access token 过期时间 | JWT `exp` 距 issuance ~60 天；仍应依赖 401/403 reactive refresh 作为主要失效检测 | ✅ T01 已确认 |
| `/api/auth/me` 响应字段名 | `GET cursor.com/api/auth/me`，Cookie: `WorkosCursorSessionToken=<url_encoded(jwtSub::accessToken)>`；返回 `email`, `email_verified`, `name`, `sub`, `id` | ✅ T01 已确认 |
| 邮箱是否允许展示 | 当前沿用 `Cursor · <email>`；如果要收紧隐私，displayName 改 masked email，hash 不变 | 开放 |
| legacy daily 客户端是否仍活跃 | 如果仍允许同步 Cursor daily，需要补最小 daily cloud dedup 或版本门禁 | 开放 |
| sync-state 核对窗口 | 默认最近 35 天，覆盖 Cursor 当前月 usage 拉取范围和跨月边界 | 开放 |

## 输出检查清单

- [x] 目标、边界、主链路、核心规则可在 Review Surface 核对。
- [x] 明确本版本 hourly-only，不把 daily repair 当主路径。
- [x] 明确云端 reset 后本地 manifest 必须失效或核对。
- [x] 明确 Cursor 主入口改为浏览器授权，不再要求普通用户手动 Add Cursor Token。
- [x] 明确 Cursor token refresh 和 reauth 状态闭环。
- [x] 明确本地凭据存储、诊断导出、reset、backup 边界。
- [x] 明确多设备 onboarding / 导入配置必须区分加入已有身份与恢复原设备。
- [x] 明确加入已有身份保留本机 `deviceId`，恢复原设备才覆盖 `deviceId`。
- [x] 明确本版本废弃 Cursor 本机检测、历史 auto source 和 legacy 手动 token 扫描链路。
- [x] 明确 cloud dedup 删除范围和 sync-state 比对口径。
- [x] 明确 Cursor 邮箱只作为 hash 输入，不上传 token/cookie/auth raw。
- [x] 明确本地 provider 多设备累加不变。
