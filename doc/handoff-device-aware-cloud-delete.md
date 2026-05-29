# Handoff: Device-Aware Cloud Data Deletion

**分支**: `improve/reset`
**日期**: 2026-05-29
**状态**: 代码完成，测试全量通过（`All tests passed`），Rust 编译与 workspace 测试通过

---

## 问题

客户端 "Reset Local + Cloud" 功能发送 `DELETE /api/participant/data` 时只携带 `participantId`，服务端收到后删除该用户的**全部云端数据**（所有设备）。

多设备场景（用户有桌面电脑 + 笔记本）的问题：
1. 设备 A 点击 "Reset Local + Cloud" → 云端删除设备 A + B 的全部数据
2. 设备 B 不知情，本地状态未清，下次同步自动重新上传
3. 数据"删了又回来"，用户体验混乱

## 修复方案

客户端请求新增 `deviceId` 字段。服务端收到请求后：
- 使用 `participantId` 对应的 identity public key 验证包含 `deviceId` 的签名 payload
- 查询 `deviceId` 并校验它必须属于该 `participantId`
- 统计该 `participantId` 下有多少台设备
- **≤ 1 台设备** → 调用 `deleteParticipantData()`，删除用户全部数据（原行为，适用于注销场景）
- **> 1 台设备** → 调用 `deleteDeviceData(deviceId)`，仅删除当前设备的云端数据

授权边界：`deviceId` 纳入签名 payload，防止请求体被中间人篡改；服务端额外做 `deviceId -> participantId` 归属校验，防止合法用户签名删除其他用户设备。

## 改动文件

| 文件 | 改动说明 |
|------|----------|
| `atl-collector/src/sidecar.rs` | `Command::AppResetWithCloud` 处理器：payload 和 body 加入 `deviceId: cfg.device_id` |
| `src/backend/server.js` | `DELETE /api/participant/data` 路由：校验 `deviceId`、签名验证含 `deviceId`、校验设备归属、按设备数分支 |
| `src/backend/store.js` | 新增 `countDevicesByParticipant(participantId)` 和 `getDeviceById(deviceId)` |
| `src/backend/mysql-store.js` | 新增 MySQL 版 `countDevicesByParticipant(participantId)` 和 `getDeviceById(deviceId)` |
| `tests/run-tests.js` | 更新已有 delete 测试加入 `deviceId`；新增多设备、单设备、跨用户设备拒绝、无效签名拒绝测试 |

## 新增测试

| 测试名 | 验证点 |
|--------|--------|
| `testSelfServiceDeletionMultiDevice` | 2 台设备 → 删除设备 A → 设备 A 数据清除，设备 B 数据保留，leaderboard 显示设备 B 的 tokens |
| `testSelfServiceDeletionSingleDeviceWipesAll` | 1 台设备 → 删除 → 整个 participant 记录被清除（与原行为一致） |
| `testSelfServiceDeletionRejectsCrossParticipantDevice` | 用户 A 使用自己私钥签名但指定用户 B 的 `deviceId` → 返回 `403`，A/B 数据都不变 |
| `testSelfServiceDeletionRejectsInvalidSignature` | 合法 `participantId + deviceId` 但伪造签名 → 返回 `401`，数据不变 |

已有的 `testSelfServiceDeletionReplayProtection` 和 `testParticipantDataDeleteMissingIsNoop` 也已更新，payload 加入 `deviceId`。

## 兼容性

| 场景 | 结果 |
|------|------|
| 旧客户端 → 新服务端 | 缺少 `deviceId`，返回 `400`，**不删除任何数据**（安全失败） |
| 新客户端 → 旧服务端 | 签名验证失败（payload 多了 `deviceId`），返回 `401`，**不删除任何数据** |
| 新客户端 → 新服务端 | 正常工作 |

**结论**：需要客户端和服务端同步更新部署。不会出现静默数据丢失。

## 未改动

- **UI 无变化**：按钮文案、弹窗交互不变，用户无感知
- **本地重置不变**：`config::reset_local_data()` 在云端删除成功后照常执行（用户选择了 reset local）
- **Admin API 不受影响**：`DELETE /api/admin/participants/:id` 和 `DELETE /api/admin/devices/:id/data` 路径未改动

## 已知无关问题

本轮验证未复现阻断性无关失败。

## 验证步骤

```bash
# 1. 编译检查
cargo check --manifest-path atl-collector/Cargo.toml

# 2. 后端与共享测试
node tests/run-tests.js

# 3. Rust workspace 测试
cargo test --workspace

# 4. diff 空白检查
git diff --check

# 5. 手动验证（可选）
#    单设备用户：桌面端 Settings → Reset → "Local + Cloud" → 确认用户数据全部清除
#    多设备用户：设备 A 执行 "Local + Cloud" → 确认仅设备 A 的云端数据被删除
```
