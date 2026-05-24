# 数据同步状态产品设计与技术实现方案

日期: 2026-05-24

## 问题定义

当前桌面端左侧 rail 展示的是云端连接可达性: 本地、检查中、在线、离线、不可用。它只能回答“API 能不能连上”，不能回答用户真正关心的问题: “本地数据是否已经同步到当前云端服务端”。

当用户看到云端排行榜或服务端数据与本地数据不一致时，尤其在切换服务端之后，rail 仍可能显示“在线”，用户会自然理解成“云端已经同步完成”。这会把正常的未同步状态误读成产品 bug。

本次要解决的是用户信任问题，不是单纯的类型重构问题:

- 用户必须知道当前云端数据是否可信。
- 如果不可信，用户必须知道下一步能做什么。
- 状态不能多到让用户学习内部同步实现。

## 初版方案评估

`doc/refatcor_sync_status.md` 的价值在于类型治理，但它不是完整解法。

它解决的是:

- Rust / JS 中同步状态字面量分散的问题。
- `success` / `failed`、`running` / `syncRunning` 的类型集中问题。
- JSON 线格式保持兼容的问题。

它没有解决的是:

- `needs_sync` 时用户如何触发同步。
- `queued` 时用户如何重试。
- `failed` 时用户如何判断是网络、兼容性、服务端错误还是本地问题。
- 服务端切换后 rail 仍把“连接在线”当成主状态。
- 用户看到过多内部状态后的认知负担。

结论: 类型治理要做，但必须包含在一次完整交付中。最终方案不能分成“先只定义类型、后续再产品化”。本方案要求一次落地产品语义、用户动作、状态派生、类型定义、UI、测试和文档。

## 产品原则

### 1. 用户只看结果状态，不看内部状态

同步内部有扫描、上传、队列、失败 bucket、manifest、fingerprint 等概念，但 rail 不能直接暴露这些实现细节。

用户只需要 5 个主状态:

| 用户状态 | 含义 | 用户动作 |
| --- | --- | --- |
| `local_only` | 当前未启用云端同步 | 配置云端 |
| `syncing` | 正在刷新本地并同步到当前云端 | 等待完成 |
| `needs_sync` | 当前云端还没有最新本地数据 | 立即同步 |
| `synced` | 当前云端已同步到最近一次本地扫描结果 | 无需处理，可手动刷新 |
| `attention` | 同步未完成，需要用户处理或重试 | 按原因重试、检查连接、更新客户端或打开设置 |

内部可以有更多 reason code，但只用于决定说明文案和按钮，不直接作为 rail 主状态。

### 2. 状态必须带动作

没有动作的状态没有产品意义。`needs_sync`、`queued`、`failed` 不能只展示名词，必须告诉用户下一步。

### 3. rail 保持低复杂度，详情放到设置页

左侧 rail 只展示:

- 主状态: 5 个用户状态之一。
- 次说明: 一句话解释当前状态。
- 主动作: 状态可行动时显示或通过点击进入。

具体错误、队列数量、API URL、最后尝试时间、最后成功时间放到云端设置页的同步详情区域。

### 4. 连接状态是原因，不是主状态

“在线 / 离线 / 不兼容”不再作为 rail 的主要状态。它们只解释为什么不能同步。

例如:

- API 可达但没有同步过当前服务端: rail 显示“待同步”，不是“在线”。
- API 不可达: rail 显示“需处理”，详情显示“云端不可达”。

## 成功标准

- 左侧 rail 主状态不超过 5 类: 仅本地、同步中、待同步、已同步、需处理。
- 每个非完成状态都有明确动作: 配置云端、立即同步、重试同步、检查连接、更新客户端、打开设置。
- 服务端切换后，在成功同步到新服务端之前，rail 必须显示“待同步”，不能显示“在线”作为主状态。
- `queued` 不作为用户主状态暴露，折叠到“需处理”，说明为“部分数据待重试”，动作是“重试同步”。
- `failed` 不作为用户主状态暴露，折叠到“需处理”，说明为“上次同步失败”，动作是“重试同步”或“检查连接”。
- 成功同步后显示最后同步时间，并且该时间必须属于当前 `apiBaseUrl`。
- 状态计算可单元测试；服务端切换、重试、失败、队列、成功同步可通过 mock E2E 覆盖。

## 当前事实依据

### UI 现状

- `src/desktop/index.html` 左侧 rail 使用 `#rail-cloud-status` 和 `#rail-cloud-status-text`。
- `src/desktop/renderer.js` 的 `renderRailStatus()` 调用 `renderRailCloudStatus()`。
- `railCloudStatus()` 只读取 `config.apiConnection` 和 `apiBaseUrl`，表达的是连接状态，不是数据同步状态。
- `renderSyncStatus()` 只在设置页云端状态里补充 `latestSyncInfo`，且只在 `syncStatus.apiBaseUrl` 匹配当前 `apiBaseUrl` 时显示最后同步时间。

### 同步状态来源

- `usage:scan-start` / `usage:scan-status` 返回 `running`、`syncRunning`、`startedAt`、`finishedAt`、`error`、`syncResult`、`syncError`、`snapshot`。
- `sync_snapshot()` 持久化 `syncStatus`，包含 `apiBaseUrl`、`lastAttemptAt`、`lastFinishedAt`、`lastSuccessAt`、`lastStatus`、`lastError`、`lastSuccessSourceFingerprint`、`lastResult`。
- `lastResult` 已包含 `accepted`、`rejected`、`bucketCount`、`uploadedBucketCount`、`noopBucketCount`、`queued`、`queuePending`、`queueUploaded`、`queueAttempted`、`queueFailed`、`newFailedBucketCount`、`rowCount`、`scannedAt`、`sourceFingerprint`。
- `collector-core/src/sync.rs` 每次 `sync_usage()` 开始都会先 `drain_upload_queue()`，所以“重试队列”的用户动作不需要单独的新概念，触发一次同步即可重试队列。
- API 地址变化时，`collector-core/src/config.rs` 会清空 `syncStatus`、`lastSyncAt`、`lastSyncStatus`、`lastSyncApiBaseUrl`、`lastSyncError`。

## 产品定义

### 用户状态与动作

| 主状态 | 触发条件 | rail 主文案 | rail 次说明 | 主动作 |
| --- | --- | --- | --- | --- |
| `local_only` | 没有配置 `apiBaseUrl` | 仅本地 | 云端未配置 | 配置云端 |
| `syncing` | 正在扫描、上传或重试队列 | 同步中 | 正在同步到当前云端 | 等待完成 |
| `needs_sync` | 当前云端没有成功同步记录，或本地扫描结果晚于最后成功同步 | 待同步 | 当前云端不是最新 | 立即同步 |
| `synced` | 当前云端已成功同步最近一次本地扫描结果，且无待重试队列 | 已同步 | 上次同步 {time} | 可手动刷新 |
| `attention` | 云端不可用、不兼容、上次失败、或有队列待重试 | 需处理 | 按 reason 展示一句话 | 重试同步 / 检查连接 / 更新客户端 / 打开设置 |

### 内部 reason code

reason code 不直接作为主状态显示，只用于文案、按钮和测试。

| reason | 所属主状态 | 说明 | 用户动作 |
| --- | --- | --- | --- |
| `no_api` | `local_only` | 未配置云端 | 配置云端 |
| `checking_connection` | `syncing` | 正在检查连接 | 等待完成 |
| `scanning` | `syncing` | 正在扫描本地使用量 | 等待完成 |
| `uploading` | `syncing` | 正在上传本地聚合数据 | 等待完成 |
| `retrying_queue` | `syncing` | 正在重试待上传数据 | 等待完成 |
| `never_synced_current_server` | `needs_sync` | 当前服务端还没有成功同步记录 | 立即同步 |
| `local_changed_after_sync` | `needs_sync` | 本地扫描结果已变化，云端不是最新 | 立即同步 |
| `queued_retry` | `attention` | 部分数据已进入上传队列 | 重试同步 |
| `last_failed` | `attention` | 上次同步失败 | 重试同步 |
| `cloud_unreachable` | `attention` | 当前 API 不可达 | 检查连接 / 打开设置 |
| `cloud_incompatible` | `attention` | 服务端与客户端不兼容 | 更新客户端或更换服务端 |

### 为什么不用 `queued / failed / needs_sync` 作为主状态

- `needs_sync` 是可行动状态，但直接显示“待同步”即可，不需要暴露内部原因。用户动作统一是“立即同步”。
- `queued` 是实现状态。普通用户不应该理解 bucket、queue、drain。产品表达应是“需处理: 部分数据待重试”，动作是“重试同步”。
- `failed` 太泛。用户真正需要知道的是能否重试，还是要先检查连接或更新客户端。因此主状态统一为“需处理”，详情解释失败原因。

### 操作入口

左侧 rail 的状态区域改为可点击区域，点击后进入 `设置 -> 云端`，并聚焦同步详情。

设置页云端 tab 增加一个“同步详情”区域:

| 区域 | 内容 |
| --- | --- |
| 主状态 | 与 rail 一致 |
| 原因说明 | reason 对应的完整说明 |
| 主按钮 | 配置云端 / 立即同步 / 重试同步 / 检查连接 / 更新客户端 |
| 诊断信息 | 当前 API、连接状态、最后尝试、最后成功、队列待重试数量、最近错误 |

rail 不直接堆按钮，避免左侧过载。现有刷新按钮保留；在 `needs_sync` 和 `attention` 时，点击刷新按钮的行为应升级为“扫描并同步”，而不是只刷新本地。

## 状态判定规则

### 输入

| 输入 | 来源 | 用途 |
| --- | --- | --- |
| `config.apiBaseUrl` | config | 当前目标云端 |
| `config.apiConnection` | config | 连接可达性和兼容性 |
| `config.syncStatus` | config | 最后同步结果 |
| `config.lastSync*` | config | 兼容旧字段 |
| `usageScanStatus` | sidecar | 当前扫描 / 同步进行中状态 |
| `backgroundStatus` | Tauri background state | 后台自动同步状态 |
| `latestLocalSnapshot` | 最近 scan snapshot 或 usage cache | 本地扫描时间和 `sourceFingerprint` |
| `foregroundSyncRunning` | renderer 内存态 | 前台同步进行中状态 |

### 当前服务端匹配

同步记录只有属于当前 API 时才有效:

```text
normalize(syncStatus.apiBaseUrl || lastSyncApiBaseUrl) === normalize(config.apiBaseUrl)
```

不匹配时:

- 不显示旧服务端的最后同步时间。
- 不使用旧服务端的成功状态。
- 如果当前 API 可用，主状态为 `needs_sync`，reason 为 `never_synced_current_server`。

### 本地是否比云端新

一步到位需要支持“本地数据已变化但云端还不是最新”的判断。

规则:

```text
latestLocalFingerprint = latest scan snapshot sourceFingerprint
lastSuccessFingerprint = syncStatus.lastSuccessSourceFingerprint

if latestLocalFingerprint exists
  and lastSuccessFingerprint exists
  and latestLocalFingerprint != lastSuccessFingerprint:
    state = needs_sync
    reason = local_changed_after_sync
```

如果刚启动时还没有最新本地 fingerprint，不要猜测本地已变化。可以先显示上次成功同步状态，同时通过后台扫描刷新后再更新状态。

### 队列重试

现有同步流程会在每次同步开始时 drain upload queue，因此:

- `queuePending > 0` 时，主状态为 `attention`，reason 为 `queued_retry`。
- 用户动作是“重试同步”。
- 技术动作仍然是触发统一的 scan+sync pipeline，不需要单独的“重试队列”命令。

### 优先级

状态优先级:

1. `local_only / no_api`
2. `syncing / checking_connection | scanning | uploading | retrying_queue`
3. `attention / cloud_incompatible | cloud_unreachable`
4. `needs_sync / never_synced_current_server | local_changed_after_sync`
5. `attention / queued_retry | last_failed`
6. `synced`

原因:

- 没有云端时谈不上同步。
- 正在同步时应展示过程状态。
- 云端不可用时用户需要先处理连接或兼容性。
- 可达但没有同步记录时，用户可以立即同步。
- 队列和失败需要处理，但如果刚进入新服务端未同步，应优先告诉用户“当前云端还没同步过”。

## 文案定义

### rail 文案

| state / reason | zh-CN 主文案 | zh-CN 次说明 | en label | en detail |
| --- | --- | --- | --- | --- |
| `local_only / no_api` | 仅本地 | 云端未配置 | Local only | Cloud not configured |
| `syncing / scanning` | 同步中 | 正在刷新本地使用量 | Syncing | Refreshing local usage |
| `syncing / uploading` | 同步中 | 正在同步到当前云端 | Syncing | Uploading to current cloud |
| `syncing / retrying_queue` | 同步中 | 正在重试待上传数据 | Syncing | Retrying pending uploads |
| `needs_sync / never_synced_current_server` | 待同步 | 当前云端还没有同步数据 | Sync needed | Current cloud has not been synced |
| `needs_sync / local_changed_after_sync` | 待同步 | 本地数据已更新，云端不是最新 | Sync needed | Local data changed after last sync |
| `synced` | 已同步 | 上次同步 {time} | Synced | Last sync {time} |
| `attention / queued_retry` | 需处理 | 部分数据待重试 | Needs attention | Some data is pending retry |
| `attention / last_failed` | 需处理 | 上次同步失败 | Needs attention | Last sync failed |
| `attention / cloud_unreachable` | 需处理 | 云端不可达 | Needs attention | Cloud is unreachable |
| `attention / cloud_incompatible` | 需处理 | 客户端或服务端版本不兼容 | Needs attention | Client or server version is incompatible |

### 按钮文案

| action | zh-CN | en | 技术行为 |
| --- | --- | --- | --- |
| `configure_cloud` | 配置云端 | Configure cloud | 打开设置页云端 tab |
| `sync_now` | 立即同步 | Sync now | 触发 scan+sync pipeline |
| `retry_sync` | 重试同步 | Retry sync | 触发 scan+sync pipeline，自动 drain queue |
| `check_connection` | 检查连接 | Check connection | 重新执行 API connection check |
| `update_client` | 更新客户端 | Update client | 进入更新流程或打开更新区域 |
| `open_settings` | 打开设置 | Open settings | 打开设置页云端 tab |

## 技术实现方案

### 一步到位范围

本次技术方案不分“先类型、后产品”的阶段。一次交付包括:

1. Rust 同步状态类型定义与序列化兼容。
2. JS 状态常量和纯函数。
3. rail 同步状态替换。
4. 云端设置页同步详情与动作按钮。
5. 统一的“立即同步 / 重试同步” pipeline。
6. 本地 fingerprint 与最后成功 fingerprint 对比。
7. renderer 单测、Rust 测试、mock E2E。

### Rust 类型

在 `collector-core/src/sync.rs` 增加:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncRunPhase {
    Idle,
    Scanning,
    Uploading,
    RetryingQueue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncOutcome {
    Success,
    Failed,
}
```

在 `collector-core/src/config.rs` 增加 `SyncStatusRecord`，保持 camelCase，与旧 JSON 兼容:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusRecord {
    #[serde(default)]
    pub api_base_url: String,
    #[serde(default)]
    pub last_attempt_at: String,
    #[serde(default)]
    pub last_finished_at: String,
    #[serde(default)]
    pub last_success_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<crate::sync::SyncOutcome>,
    #[serde(default)]
    pub last_error: String,
    #[serde(default)]
    pub last_success_source_fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_result: Option<serde_json::Value>,
}
```

在 `atl-collector/src/sidecar.rs` 增加 `ScanSyncStatus`，保持 `syncRunning` 兼容:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanSyncStatus {
    pub running: bool,
    pub sync_running: bool,
    pub phase: Option<collector_core::sync::SyncRunPhase>,
    pub started: Option<bool>,
    pub task_id: Option<u64>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub force: Option<bool>,
    pub error: Option<String>,
    pub sync_result: Option<serde_json::Value>,
    pub sync_error: Option<String>,
    pub snapshot: Option<serde_json::Value>,
}
```

旧字段不删除:

- `running` 保留。
- `syncRunning` 保留。
- `syncResult` 保留。
- `syncError` 保留。
- 新增 `phase` 只做增强，不破坏旧 renderer 或测试 mock。

### JS 状态模型

在 `src/shared/schema.js` 或 `src/desktop/renderer-data.js` 增加:

```javascript
export const RAIL_SYNC_STATE = Object.freeze({
  LOCAL_ONLY: "local_only",
  SYNCING: "syncing",
  NEEDS_SYNC: "needs_sync",
  SYNCED: "synced",
  ATTENTION: "attention",
});

export const RAIL_SYNC_REASON = Object.freeze({
  NO_API: "no_api",
  CHECKING_CONNECTION: "checking_connection",
  SCANNING: "scanning",
  UPLOADING: "uploading",
  RETRYING_QUEUE: "retrying_queue",
  NEVER_SYNCED_CURRENT_SERVER: "never_synced_current_server",
  LOCAL_CHANGED_AFTER_SYNC: "local_changed_after_sync",
  QUEUED_RETRY: "queued_retry",
  LAST_FAILED: "last_failed",
  CLOUD_UNREACHABLE: "cloud_unreachable",
  CLOUD_INCOMPATIBLE: "cloud_incompatible",
});
```

新增纯函数:

```javascript
export function deriveRailSyncStatus({
  config,
  usageScanStatus = null,
  backgroundStatus = null,
  latestLocalSnapshot = null,
  foregroundSyncRunning = false,
  t = (key) => key,
  formatDateTime = (value) => value
} = {}) {
  // returns:
  // {
  //   state,
  //   reason,
  //   label,
  //   detail,
  //   title,
  //   action,
  //   actionLabel,
  //   apiBaseUrl,
  //   lastSuccessAt,
  //   lastAttemptAt,
  //   queuePending,
  //   lastError
  // }
}
```

### 统一同步动作

新增 renderer 层动作 `runSyncNow({ forceScan = true })`:

```text
runSyncNow
  -> 如果未配置 apiBaseUrl: 打开云端设置
  -> 如果连接不可达或未检查: 先 check connection
  -> startUsageScan({ force: true })
  -> scan 完成后 startUsageSync()
  -> 轮询 usage:scan-status
  -> 更新 latestLocalSnapshot、latestUsageScanStatus、latestConfig.syncStatus
  -> renderRailStatus()
```

实现原则:

- `needs_sync` 的“立即同步”和 `queued_retry` / `last_failed` 的“重试同步”走同一个 pipeline。
- 队列重试不新增独立命令，因为现有 `sync_usage()` 每次同步开始都会 drain upload queue。
- 如果 `usage:sync-start` 已经在跑，按钮进入 disabled/loading，rail 显示 `syncing`。

### 本地 fingerprint 来源

renderer 增加:

```javascript
let latestLocalSnapshot = null;
```

更新来源:

- `applyUsageSnapshot(usage)` 写入 `latestLocalSnapshot = { scannedAt, sourceFingerprint, rowCount, fromCache }`。
- `loadBackgroundStatus()` 使用 `backgroundStatus.sourceFingerprint` 和 `cacheScannedAt` 补充。
- `syncResult.sourceFingerprint` 成功后写入 `syncStatus.lastSuccessSourceFingerprint`，作为云端已同步证据。

### rail 接入

替换逻辑:

- `renderRailCloudStatus()` 改为 `renderRailSyncStatus()`。
- `renderRailStatus()` 调用 `deriveRailSyncStatus()`。
- `#rail-cloud-status` 第一阶段可以保留 id，避免 E2E 和 CSS 大面积改动，但语义改为 sync status。
- `#rail-last-scan` 改为展示同步 detail。
- `#rail-next-scan` 保持展示下次自动刷新时间。

样式:

| state | 颜色 |
| --- | --- |
| `local_only` | muted |
| `syncing` | yellow |
| `needs_sync` | yellow |
| `synced` | green |
| `attention` | red 或 yellow，取决于 reason |

`attention / queued_retry` 用 yellow；`attention / last_failed`、`cloud_unreachable`、`cloud_incompatible` 用 red。

### 设置页同步详情

在云端设置 tab 增加:

- `#cloud-sync-status-badge`
- `#cloud-sync-status-detail`
- `#cloud-sync-primary-action`
- `#cloud-sync-diagnostics`

诊断信息只展示安全字段:

- API URL
- 连接状态
- 最后尝试时间
- 最后成功时间
- 待重试数量
- 最近错误摘要

不得展示:

- prompt
- assistant response
- code
- real path
- Cursor token
- private key
- full transcript

## 文件级改动

| 文件 | 改动 |
| --- | --- |
| `collector-core/src/sync.rs` | 增加 `SyncOutcome`、`SyncRunPhase`；必要时让 sync summary 暴露 queue drain 过程 phase |
| `collector-core/src/config.rs` | 增加 `SyncStatusRecord`；保留旧 `serde_json::Value` 读写兼容或提供转换函数 |
| `atl-collector/src/sidecar.rs` | 增加 `ScanSyncStatus`；`usage:scan-start` / `usage:sync-start` 写入 `phase`；`persist_sync_status()` 使用 `SyncOutcome` |
| `src/shared/schema.js` | 增加 rail sync state / reason const |
| `src/desktop/renderer-data.js` | 增加 `deriveRailSyncStatus()` 及辅助函数 |
| `src/desktop/renderer.js` | 接入 rail 同步状态、latestLocalSnapshot、runSyncNow、设置页动作 |
| `src/desktop/index.html` | 设置页云端 tab 增加同步详情区域；rail id 第一阶段可保留 |
| `src/desktop/styles.css` | 增加 5 个主状态样式和 attention reason 颜色 |
| `src/shared/i18n.js` | 增加 zh-CN / en 文案 |
| `tests/renderer/renderer-data.test.js` | 覆盖状态派生矩阵 |
| `tests/e2e/sync.spec.js` | 覆盖用户路径 |
| `tests/e2e/mock-tauri.js` | 增强 syncStatus、usageScanStatus、backgroundStatus mock |

## 测试矩阵

### 单元测试

`deriveRailSyncStatus()` 必须覆盖:

| 场景 | 期望 |
| --- | --- |
| 无 API | `local_only / no_api / configure_cloud` |
| API 未检查 | `syncing / checking_connection` |
| 扫描中 | `syncing / scanning` |
| 上传中 | `syncing / uploading` |
| 当前 API 无同步记录 | `needs_sync / never_synced_current_server / sync_now` |
| 旧 API 有成功记录，新 API 无记录 | `needs_sync / never_synced_current_server / sync_now` |
| 本地 fingerprint 与最后成功 fingerprint 不同 | `needs_sync / local_changed_after_sync / sync_now` |
| 当前 API 成功且 fingerprint 匹配 | `synced` |
| `queuePending > 0` | `attention / queued_retry / retry_sync` |
| `lastStatus === failed` | `attention / last_failed / retry_sync` |
| API 不可达 | `attention / cloud_unreachable / check_connection` |
| 服务端不兼容 | `attention / cloud_incompatible / update_client` |

### E2E

必须覆盖:

1. 无云端: rail 显示“仅本地”，设置页主动作是“配置云端”。
2. 新服务端: API 可达但没有当前服务端同步记录，rail 显示“待同步”，点击主动作触发同步。
3. 同步中: 点击立即同步后 rail 显示“同步中”。
4. 同步成功: rail 显示“已同步 / 上次同步”。
5. 本地变化: mock 新 `sourceFingerprint` 后 rail 显示“待同步”。
6. 队列待重试: mock `queuePending > 0` 后 rail 显示“需处理”，设置页动作是“重试同步”。
7. 上次失败: mock `lastStatus=failed` 后 rail 显示“需处理”，设置页动作是“重试同步”。
8. API 不可达: rail 显示“需处理”，设置页动作是“检查连接”。

### 必跑命令

```bash
node --check src/desktop/renderer.js
npm run test:ui
npm run test:e2e
cargo test --workspace
```

## 验收口径

这次交付完成后，用户看到云端和本地数据不一致时，产品能解释为以下几类之一:

- 没有配置云端，所以云端不会有数据。
- 正在同步，等同步完成。
- 当前云端还没同步过，点击立即同步。
- 本地数据更新了，点击立即同步。
- 部分数据待重试，点击重试同步。
- 上次同步失败，点击重试或检查连接。
- 云端不可达或不兼容，先处理连接或版本。
- 已同步，云端应该反映最近一次本地扫描结果。

如果无法落到上述任一解释，才应视为产品状态模型缺口。

## 最终建议

采用 5 个用户主状态 + 内部 reason code 的设计。

不要把 `queued`、`failed`、`needs_sync` 都平铺给用户。`needs_sync` 是“待同步”，动作是“立即同步”；`queued` 和 `failed` 统一归入“需处理”，再用原因说明和按钮告诉用户是“重试同步”“检查连接”还是“更新客户端”。

技术上一步到位: 类型定义、状态派生、rail 替换、设置页动作、本地 fingerprint 对比、队列重试语义和测试一次完成。这样既解决用户误解，也避免后续再补一轮产品语义。
