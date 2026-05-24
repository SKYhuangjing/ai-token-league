# Plan: 统一云端同步状态类型定义

## Context

当前同步状态以字符串字面量 (`"success"`, `"failed"`) 和无类型 `serde_json::Value` 分散在 Rust 侧边栏、配置和 Tauri 层中，JS 渲染器通过布尔值 OR (`running || syncRunning`) 推断阶段。没有集中的状态定义，容易出现拼写错误和不一致。

**目标**: 定义 Rust enum/struct + JS const 作为同步状态的唯一来源，不改变 JSON 线格式，不重构调用点（后续逐步迁移）。

## 变更概要

4 个文件新增类型定义，0 个既有调用点改动。

---

## Step 1: Rust — 新增 `SyncOutcome` + `SyncPhase` 枚举

**文件**: `collector-core/src/sync.rs`

在 `SyncResult` struct 之前新增:

```rust
/// 同步操作的终态结果，对应 persisted config 中的 lastStatus 字段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncOutcome {
    Success,
    Failed,
}

/// 扫描+同步生命周期的逻辑阶段（内存态，不持久化）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncPhase {
    /// 无扫描或同步进行中
    Idle,
    /// 正在扫描本地文件
    Scanning,
    /// 扫描完成，正在上传到云端
    Syncing,
}
```

向后兼容映射:
- `SyncOutcome::Success` → JSON `"success"` (与 `persist_sync_status` 现有输出一致)
- `SyncOutcome::Failed` → JSON `"failed"`
- `SyncPhase::Idle/Scanning/Syncing` → 供后续替换 `status.running || status.syncRunning` 判断

## Step 2: Rust — 新增 `SyncStatusRecord` 结构体

**文件**: `collector-core/src/config.rs`

在 `SyncManifest` 附近 (约 line 1053) 新增:

```rust
/// 替代 AppConfig.sync_status 的 serde_json::Value 的类型化结构。
/// camelCase 序列化，向后兼容已持久化的 config 文件。
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_result: Option<serde_json::Value>,
}
```

向后兼容: `lastStatus: Some(SyncOutcome::Success)` → `"lastStatus": "success"`，与现有 JSON 完全一致。

> 注意: 本次仅定义结构体，**不修改** `AppConfig.sync_status` 字段类型（后续逐步迁移）。

## Step 3: Rust — 新增 `ScanSyncStatus` 结构体

**文件**: `atl-collector/src/sidecar.rs`

在 `SidecarRuntime` struct 附近新增:

```rust
/// 替代 last_scan_status 中的无类型 serde_json::Value。
/// 即 usage:scan-status 和 usage:scan-start 返回的 JSON 结构。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanSyncStatus {
    pub running: bool,
    pub sync_running: bool,
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

向后兼容: `sync_running` 序列化为 `"syncRunning"`，与 JS 渲染器读取的 key 一致。

## Step 4: JavaScript — 新增 `SYNC_OUTCOME`, `SYNC_PHASE`, `syncPhase()`

**文件**: `src/shared/schema.js`

在文件末尾新增:

```javascript
/** 同步终态结果 — 对应 Rust SyncOutcome */
export const SYNC_OUTCOME = Object.freeze({
  SUCCESS: "success",
  FAILED: "failed",
});

/** 扫描+同步生命周期阶段 — 对应 Rust SyncPhase */
export const SYNC_PHASE = Object.freeze({
  IDLE: "idle",
  SCANNING: "scanning",
  SYNCING: "syncing",
});

/** 从 scan status 对象推导当前阶段 */
export function syncPhase(status) {
  if (!status) return SYNC_PHASE.IDLE;
  if (status.running) return SYNC_PHASE.SCANNING;
  if (status.syncRunning) return SYNC_PHASE.SYNCING;
  return SYNC_PHASE.IDLE;
}
```

后续 renderer.js 可 `import { SYNC_OUTCOME, syncPhase } from "../shared/schema.js"` 替换硬编码布尔判断。

---

## 后续迁移路径（不在本次范围内）

本次仅定义类型。后续可逐步替换的调用点:

| 文件 | 函数/字段 | 替换内容 |
|---|---|---|
| `atl-collector/src/sidecar.rs` | `SidecarRuntime.last_scan_status` | `Value` → `ScanSyncStatus` |
| `atl-collector/src/sidecar.rs` | `persist_sync_status()` | `&str` → `SyncOutcome` |
| `atl-collector/src/sidecar.rs` | `default_scan_status()` | `json!({...})` → `ScanSyncStatus::default()` |
| `atl-collector/src/sidecar.rs` | `UsageSyncStart` / `UsageScanStart` | `json!({...})` → `ScanSyncStatus` builder |
| `collector-core/src/config.rs` | `AppConfig.sync_status` | `Value` → `SyncStatusRecord` |
| `src/desktop/renderer.js` | `status.running \|\| status.syncRunning` | `syncPhase(status) !== SYNC_PHASE.IDLE` |
| `src/desktop/renderer.js` | `status.lastStatus === "success"` | `status.lastStatus === SYNC_OUTCOME.SUCCESS` |

## 验证

1. `cargo check` — 确认新增 Rust 类型编译通过，不破坏现有代码
2. `npm test` — 确认 JS 侧测试通过
3. `grep -rn '"success"\|"failed"' atl-collector/src/sidecar.rs` — 确认既有字符串字面量未被意外改动
4. `grep -rn 'serde_json::json' atl-collector/src/sidecar.rs | grep sync` — 确认既有 JSON 构建未被改动
