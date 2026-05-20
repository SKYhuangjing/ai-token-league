# Review Summary

## 目标

- 将 Cursor 云端用量从“手动 Add Cursor Token + 设备级计数”升级为“Connect Cursor 浏览器授权 + 本地 token refresh + 服务端 cloud hourly 去重”。
- 同一 `participantId` 多设备安装时，Codex / Claude Code 本地日志继续按设备累加；Cursor Dashboard Usage 同一账号跨设备只计一次。
- 多设备加入时，客户端必须共享 `participantId` / identity key，但保留每台机器独立的 `deviceId`；只有恢复原设备时才允许恢复备份中的 `deviceId`。
- 云端 reset 后，本地 `sync-manifest.json` 不能继续导致 no-op，必须通过 sync-state 或清 manifest 触发重传。

## 不改什么

- 不改变排行榜 `totalTokens` 口径。
- 不上传 Cursor access token、refresh token、Cookie、原始 auth 响应、真实路径、prompt、response、源码或 identity private key。
- 不把 daily snapshot 合并作为当前主链路；本版本以 `device_day_hour_provider` hourly snapshot 为权威。

## 需要确认的关键决策

### D1: 私有 Cursor deep login 协议

- 决策：实测已确认。`auth/poll` 返回 camelCase (`accessToken`, `refreshToken`, `authId`)，不含 email；`oauth/token` 返回 snake_case (`access_token`, `id_token`, `shouldLogout`)，不返回新 `refresh_token`；邮箱通过 `cursor.com/api/auth/me` (Cookie auth) 获取。
- 影响：实现时需处理两套命名约定；poll 成功后需额外调 `/api/auth/me` 获取 email。
- 验收口径：✅ T01 evidence 已产出 sanitized 实测记录。

### D2: Cursor 账号身份

- 决策：以 normalized email hash 为首选 cloud identity；email 不可得时退回稳定 `authId` / user id hash。
- 影响：同一 Cursor 账号跨设备得到同一 `workdirHash`，不同账号不能误合并。
- 验收口径：同账号多设备只生成一个 Cursor account/workdirHash；不同账号保留。

### D3: sync-state 语义

- 决策：sync-state 只判断“该设备 bucket 是否被服务端接收”，比对 `usage_sync_buckets_hourly`，不判断最终 leaderboard 是否仍保留该设备 usage row。
- 影响：Cursor dedup 删除其他设备 usage row 后，不导致被删设备反复重传。
- 验收口径：A 设备 usage 被 B 设备覆盖后，A 的 sync bucket 仍 matched。

### D4: 多设备导入语义

- 决策：引导和导入配置按用户意图区分 `join_existing_participant` 与 `restore_device`，不让普通用户直接判断是否覆盖 `deviceId`。
- 影响：第二台设备通过 join 模式加入同一排行榜身份；灾备/换机才走 restore 模式。
- 验收口径：join 后 `participantId` 相同且 `deviceId` 不同；restore 后 `deviceId` 与备份一致且风险提示可见。

## 通过标准

- 设计文档锚点完整，task-pack 无模板占位内容。
- 所有任务卡均有独立 scope、owned files、验收与证据要求。
- 验证矩阵覆盖 Connect Cursor、refresh、cloud dedup、sync-state、reset、多设备导入语义、backup restore guardrail、privacy、MySQL reload。
