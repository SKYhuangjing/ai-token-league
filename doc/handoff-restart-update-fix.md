# Handoff: 修复「重启更新」按钮有时无法点击的问题

## 问题描述

下载更新完成后，左侧导航栏的「重启更新」按钮有时不显示或无法点击。实际表现为：

- **按钮消失**：`loadBackgroundStatus()` 用后台 `{"status":"idle"}` 覆盖了前端下载态
- **按钮显示但不可点击**：点击安装失败后按钮卡在 `disabled`，缺少恢复路径
- **UI 卡在「下载中」**：下载已完成但卡片状态文字/badge 没刷新

## 根因分析

### Bug 1: `loadBackgroundStatus()` 覆盖下载状态（主因）

`latestUpdateState = status.updateCheck || latestUpdateState;` — Rust 后端 `background_status` 始终返回 `updateCheck: {"status": "idle"}`，覆盖前端下载态。

### Bug 2: `updateCheckProgress()` 用不完整事件数据替换整个状态

`latestUpdateState = data || latestUpdateState;` — 部分事件数据替换整个状态，丢失更新元数据。

### Bug 3: 点击安装失败后按钮 disabled 不恢复

点击处理直接设置 `disabled = true`，失败后无恢复路径。

### Bug 4: `downloadProgress` 残留

合并策略下旧的进度数据残留，`isUpdateDownloading()` 持续返回 true。

### Bug 5: download 失败路径 UI 状态不一致

`downloadUpdate()` catch 块只更新 message 和手动解禁两个按钮，未设置 `status: "failed"`，未调用 `renderUpdateActions()` / `renderRailStatus()`。

### Bug 6: `downloaded` 事件与命令 resolve 的 IPC 竞争

Rust 端先 `emit("downloaded")`（下载完成回调），再写临时文件、设 `PendingUpdate`，最后命令才 resolve。9MB 安装包下载极快，`downloaded` 事件和命令 resolve 几乎同时到达 JS 端。如果 IPC 投递顺序颠倒（命令先 resolve、事件后到），`updateCheckProgress()` 会无条件把 `status: "downloaded"` 压回 `"downloading"`，导致重启按钮重新 disabled。

### Bug 7: `downloadUpdate()` resolve 后未刷新 `renderSilentUpdateStatus()`

`#update-status-text` 显示的 raw status（如 "downloading"）和 `#update-badge` 显示的「下载中...」由 `renderSilentUpdateStatus()` 负责更新。但 `downloadUpdate()` resolve 后只调了 `renderUpdateActions()` 和 `renderRailStatus()`，漏调了 `renderSilentUpdateStatus()`，导致卡片区状态文字和 badge 停留在下载中状态。

## 修复方案（共 14 处改动）

### 改动 1: 新增状态变量

```js
let updateDownloadedPersisted = false;
let updateInstallRunning = false;
let downloadedEventReceived = false;
```

### 改动 2: `hasReadyUpdatePackage()` 检查持久标志

```js
return Boolean(state?.readyPackage || state?.status === "downloaded" || update?.status === "downloaded" || updateDownloadedPersisted);
```

### 改动 3: `updateCheckProgress()` — 合并 + 中间态 + IPC 竞争守卫

```js
const merged = { ...(latestUpdateState || {}), ...(data || {}) };
if (data.status === "downloaded" && !updateDownloadedPersisted) {
  merged.status = "downloading";
  delete merged.downloadProgress;
  delete merged.downloadRunning;
}
latestUpdateState = merged;
if (data.downloadProgress && !downloadedEventReceived) { ... }
if (data.status === "downloaded" && !updateDownloadedPersisted) {
  downloadedEventReceived = true;
  $("#update-message").textContent = t("desktop.renderer.downloadedPreparing");
}
renderSilentUpdateStatus(latestUpdateState, latestConfig);
```

- `downloaded` 事件到达时保持 `status: "downloading"`，显示「正在准备更新...」
- **IPC 竞争守卫**：`!updateDownloadedPersisted` 防止迟到的 downloaded 事件把已就绪状态压回 downloading
- `downloadedEventReceived` 阻止 downloaded 事件之后的进度消息覆盖

### 改动 4: `downloadUpdate()` resolve 后刷新全部 UI

```js
await api.downloadUpdate();
updateDownloadedPersisted = true;
latestUpdateState = { ...(latestUpdateState || {}), status: "downloaded" };
delete latestUpdateState.downloadProgress;
delete latestUpdateState.downloadRunning;
$("#update-message").textContent = t("desktop.renderer.downloadedReady");
renderSilentUpdateStatus(latestUpdateState, latestConfig);
renderUpdateActions(latestUpdateState);
renderRailStatus();
```

关键：resolve 后调用 `renderSilentUpdateStatus()` 刷新 `#update-status-text` 和 `#update-badge`，避免卡片区残留下载中状态。

### 改动 5: `downloadUpdate()` catch 设置 failed 状态并重新渲染

```js
} catch (error) {
  latestUpdateState = { ...(latestUpdateState || {}), status: "failed", lastError: error.message };
  delete latestUpdateState.downloadProgress;
  delete latestUpdateState.downloadRunning;
  $("#update-message").textContent = error.message;
  renderUpdateActions(latestUpdateState);
  renderRailStatus();
}
```

### 改动 6: `installAndRestartUpdate()` 引入安装态

```js
async function installAndRestartUpdate() {
  updateInstallRunning = true;
  renderRailStatus();
  renderUpdateActions(latestUpdateState);
  try {
    await api.installAndRestartUpdate();
  } catch (error) {
    updateInstallRunning = false;
    renderRailStatus();
    renderUpdateActions(latestUpdateState);
    throw error;
  }
}
```

### 改动 7: 点击处理复用 installAndRestartUpdate

```js
$("#rail-restart-update").addEventListener("click", () => run(async () => {
  await installAndRestartUpdate();
}));
```

### 改动 8: `renderRailStatus()` 基于安装态控制 disabled

```js
if (restartBtn) {
  const shouldShow = readyPackage || latestUpdateState?.status === "downloaded" || update?.status === "downloaded" || updateDownloadedPersisted;
  restartBtn.hidden = !shouldShow;
  restartBtn.disabled = updateInstallRunning;
}
```

### 改动 9: `renderUpdateActions()` 统一安装态禁用

```js
enforcementButton.disabled = isUpdateDownloading(state) || updateInstallRunning;
```

### 改动 10: `doLoadBackgroundStatus()` 真正合并

```js
if (status.updateCheck) {
  latestUpdateState = { ...(latestUpdateState || {}), ...status.updateCheck };
  if (updateDownloadedPersisted) latestUpdateState.status = "downloaded";
}
renderSilentUpdateStatus(latestUpdateState, config);
```

### 改动 11: `refreshCloudDependentState()` 重置所有标志

```js
latestUpdateState = null;
updateDownloadedPersisted = false;
updateInstallRunning = false;
downloadedEventReceived = false;
```

### 改动 12: 新增 i18n key `downloadedPreparing`

### 改动 13: `renderSilentUpdateStatus()` UI 冗余清理

`#update-status-text` 不再追加 raw status（"downloading"/"downloaded"）和进度百分比，只保留版本就绪提示、下次检查时间、错误信息。

`#update-badge` 下载中时隐藏（`#update-message` 已覆盖），只保留「有更新」和「准备重启」两个状态。

下载过程的唯一状态展示元素为 `#update-message`。

## UI 组件职责划分

| 元素 | 职责 | 下载中 | 下载完成 |
|------|------|--------|----------|
| `#update-message` | 主状态：进度/完成/错误 | 下载中 XX% (YY KB/s) | 已下载，准备就绪 |
| `#update-status-text` | 版本信息 | 本地 X.X.X · 最新 X.X.X · 每2小时 | 同左 |
| `#update-badge` | 快速视觉指示 | 隐藏 | 准备重启 |
| `#rail-restart-update` | 侧边栏操作入口 | 隐藏 | 重启更新 |
| `#download-update` | 重试下载 | 隐藏 | 隐藏 |
| `#download-installer` | 兜底下载 | 隐藏 | 隐藏 |

## 状态机

| 状态 | 重启按钮 | disabled | #update-message | badge |
|------|----------|----------|-----------------|-------|
| 无更新 | 隐藏 | - | | 隐藏 |
| 下载中 | 隐藏 | - | 下载中 XX% | 隐藏 |
| downloaded 事件到达 | 隐藏 | - | 正在准备更新... | 隐藏 |
| downloadUpdate() resolve | 显示 | false | 已下载，准备就绪 | 准备重启 |
| downloaded 事件迟到 | 显示 | false | 已下载，准备就绪（守卫跳过） | 准备重启 |
| 用户点击安装 | 显示 | true | 安装中... | 准备重启 |
| 安装失败 | 显示 | false | 错误信息 | 准备重启 |
| download 失败 | 隐藏 | - | 错误信息 | 隐藏 |
| loadBackgroundStatus idle | 显示 | - | | 准备重启 |
| 云端连接变更 | 隐藏 | - | | 隐藏 |

## 涉及文件

- `src/desktop/renderer.js` — UI 改动
- `src/shared/i18n.js` — 新增 `downloadedPreparing` key
- `tests/renderer/update-state.test.js` — 状态机隔离测试（20 用例）
- `tests/renderer/update-dom.test.js` — DOM 集成测试（5 用例，导入真实 renderer.js）
- `tests/renderer/dom-stubs.js` — DOM 存根辅助（checkbox/input/button 分类型创建）

## 验证

- `npm test` 全部通过
- `npm run test:ui` 463/463 通过（16 files）
- `npm run test:e2e` 74/74 通过
- `npx vitest run tests/renderer/update-state.test.js` 20/20 通过
- `npx vitest run tests/renderer/update-dom.test.js` 5/5 通过（真实导入 renderer.js）
- `cargo test --workspace` 通过

## 建议补充验证

- 真实 Tauri 手测：下载完成后确认卡片状态文字无 raw status、badge 显示「准备重启」
- 下载完成后点击「重启更新」，确认不返回 `No downloaded update to install`
- 模拟安装进行中点击强制更新浮层按钮，确认按钮被禁用
