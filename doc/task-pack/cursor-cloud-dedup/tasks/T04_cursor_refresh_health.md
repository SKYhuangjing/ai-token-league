# T04_cursor_refresh_health

## Task ID

- `T04_cursor_refresh_health`

## Owner Lens

- Token lifecycle and failure visibility.

## Goal

- 实现 Cursor token proactive refresh、401/403 reactive refresh、single-flight 并发控制和 health/UI reauth 状态。

## Primary Executor

- worker / engineer.

## Scope

- Use verified `oauth/token` refresh protocol.
- Refresh before scan when token is near expiry.
- On usage 401/403, refresh once and retry usage once.
- Mark `refresh_failed` vs `reauth_required` correctly.
- Surface health state to desktop.

## Out of Scope

- No changes to cloud dedup.
- No manual repair of old token records beyond fallback behavior.

## Owned Files / Modules

- `collector-core/src/provider/cursor_dashboard.rs`
- Optional new `collector-core/src/provider/cursor_auth.rs`
- `collector-core/src/scanner.rs`
- `collector-core/src/config.rs`
- `collector-core/src/observability.rs`
- `src/desktop/renderer.js`
- `src/shared/i18n.js`

## Dependencies

- T01 refresh protocol.
- T02 account model.

## Source Design Anchors

- `Cursor token refresh`
- `账号状态映射`
- `验证与可观察性`

## Independent Execution

- Focus on provider fetch path and health rendering.
- No need to change upload signing.

## Implementation Requirements

- Parse JWT `exp` for `accessTokenExpiresAt`; fallback TTL 55 minutes.
- If refresh response omits new refresh token, retain old refresh token.
- If response includes new refresh token, atomically replace.
- Implement per-account single-flight refresh.
- Never retry usage more than once after refresh.
- Emit sanitized health: account hash/masked email, authStatus, lastError code.

## Comment Requirements

- Comment single-flight and retry-limit logic if non-obvious.

## Subagent Verification

- A verifier should inspect mocked tests for 401 loops and token redaction.

## Acceptance

- API: Cursor usage request succeeds after refresh when token expired.
- DB: No.
- Log: Logs include status, not token.
- State / Enum: `active`, `refresh_failed`, `reauth_required`.
- Permission / Tenant: No server upload of secrets.
- User-visible Output: Reconnect state is visible.
- Context / Evidence Fields: authStatus, lastRefreshAt, lastError code.

## Verification

- Mocked HTTP tests for proactive refresh, reactive refresh, shouldLogout, network failure.
- Privacy grep.

## Evidence

- Required evidence: test output, sanitized health sample.
- Actual evidence belongs in handoff/evidence files, not by rewriting this task card.
