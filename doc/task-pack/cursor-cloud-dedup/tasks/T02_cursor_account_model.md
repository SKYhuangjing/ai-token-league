# T02_cursor_account_model

## Task ID

- `T02_cursor_account_model`

## Owner Lens

- Local credential model and privacy boundary.

## Goal

- 定义并实现本地 `cursorDashboardUsage.accounts[]` 授权账号模型，兼容 legacy `workosSessionTokens`，并固定 auto-detect 与 Connect Cursor 的优先级。

## Primary Executor

- worker / engineer.

## Scope

- 扩展 `collector-core/src/config.rs` Cursor account config。
- 让 diagnostics、backup/reset、import/export、runtime log 对 token 字段 redacted。
- 统一 Cursor cloud identity：email hash 优先，`authId` / user id hash fallback。
- auto-detect 同账号与授权账号合并，授权 token 优先。

## Out of Scope

- 不实现浏览器登录流程。
- 不实现服务端 dedup。

## Owned Files / Modules

- `collector-core/src/config.rs`
- `collector-core/src/provider/cursor_dashboard.rs`
- `collector-core/src/diagnostics.rs`
- `collector-core/src/local_backup.rs`
- `collector-core/src/observability.rs`
- `atl-collector/src/sidecar.rs`
- Relevant tests in `collector-core` / `tests/run-tests.js`

## Dependencies

- T01 should confirm actual token/account fields before final names are frozen.

## Source Design Anchors

- `本地持久化字段`
- `本地存储和清理边界`
- `auto-detect 关系`
- `Cursor 账号身份`

## Independent Execution

- Read only config, diagnostics, backup, cursor provider, sidecar config bridge.
- No need to modify backend Store.

## Implementation Requirements

- Add account record fields: `accessToken`, `refreshToken`, `authId`, `email`, `accountHash`, `accessTokenExpiresAt`, `lastRefreshAt`, `authStatus`, `addedAt`.
- Keep legacy `workosSessionTokens` readable as fallback.
- Ensure all serialization surfaces used by diagnostics/export/log redact token fields.
- Ensure local reset clears authorized accounts and legacy token material.
- Deduplicate account sources by stable account hash, not display name.

## Comment Requirements

- Add short comments only around redaction and legacy fallback rules if needed.

## Subagent Verification

- A verifier should inspect diagnostics/export output for secrets.

## Acceptance

- API: Sidecar config commands return sanitized account metadata only.
- DB: No server DB changes.
- Log: Runtime logs never include access/refresh token.
- State / Enum: `active`, `refresh_failed`, `reauth_required` supported.
- Permission / Tenant: Local-only credentials; no server upload.
- User-visible Output: Accounts can be listed by safe display name / masked email.
- Context / Evidence Fields: account hash, authStatus, lastRefreshAt.

## Verification

- Unit tests for config migration, account dedupe, redaction.
- Privacy grep against diagnostics/export fixtures.

## Evidence

- Required evidence: test output, sanitized config sample, diagnostics grep.
- Actual evidence belongs in handoff/evidence files, not by rewriting this task card.
