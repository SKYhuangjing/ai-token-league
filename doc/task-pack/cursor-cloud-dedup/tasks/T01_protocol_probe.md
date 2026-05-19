# T01_protocol_probe

## Task ID

- `T01_protocol_probe`

## Owner Lens

- Private protocol truth source.

## Goal

- 用真实但脱敏的 Cursor deep login / refresh 交互确认 `auth/poll`、`oauth/token`、账号信息接口的 request/response 形状，阻止后续实现基于猜测字段开发。

## Primary Executor

- main-agent or engineer with local browser access.

## Scope

- 发起一次 `Connect Cursor` 风格登录探测。
- 记录 pending、success、expired/cancel、refresh success、refresh invalid/shouldLogout 的 sanitized evidence。
- 确认 `access_token`、`refresh_token`、`auth_id`、`email`、`shouldLogout`、`refresh_token` rotation 行为。

## Out of Scope

- 不提交真实 token、Cookie、JWT、邮箱全文。
- 不实现生产逻辑。

## Owned Files / Modules

- `doc/task-pack/cursor-cloud-dedup/evidence/protocol_probe.md`
- 可选临时脚本只能放 `.tmp-*` 或 evidence 中的脱敏记录；不得进入生产源码。

## Dependencies

- Source design: `doc/backend_multi_device_cursor_cloud_dedup_design.md`

## Source Design Anchors

- `前置阻断`
- `Cursor 浏览器授权登录`
- `Cursor token refresh`
- `待确认项`

## Independent Execution

- 先读源设计的 `Cursor 浏览器授权登录` 和 `Cursor token refresh`。
- 不需要理解服务端 dedup 实现。

## Implementation Requirements

- 实测 `GET https://api2.cursor.sh/auth/poll?uuid=<uuid>&verifier=<codeVerifier>`。
- 实测 `POST https://api2.cursor.sh/oauth/token`。
- 确认账号邮箱来源：poll 响应是否含 email；如不含，确认可用账号接口。
- 所有 evidence 必须脱敏：token 只允许写 `<redacted>`，邮箱只允许 masked 或 hash。

## Comment Requirements

- 无源码改动时无需代码注释。

## Subagent Verification

- 可由第二执行者复核 evidence 是否足以解除前置阻断。

## Acceptance

- API: 确认 private API endpoint、method、payload、response 字段。
- DB: 无。
- Log: evidence 不含 secrets。
- State / Enum: 明确 pending/success/expired/shouldLogout 状态。
- Permission / Tenant: 使用当前 Cursor Web 登录态，仅限本机授权。
- User-visible Output: 无。
- Context / Evidence Fields: `statusCode`、field names、sanitized body shape、timestamp。

## Verification

- 人工 review `evidence/protocol_probe.md`。
- `rg -n "eyJ|WorkosCursorSessionToken=|access_token.: .+|refresh_token.: .+" doc/task-pack/cursor-cloud-dedup/evidence/protocol_probe.md` 不应命中真实 secret。

## Evidence

- Required evidence: `evidence/protocol_probe.md`
- Actual evidence belongs in handoff/evidence files, not by rewriting this task card.
