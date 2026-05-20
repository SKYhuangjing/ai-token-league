# T03_connect_cursor_auth

## Task ID

- `T03_connect_cursor_auth`

## Owner Lens

- Desktop authorization UX and pending login state.

## Goal

- 用 `Connect Cursor` 浏览器授权替代普通用户的 `Add Cursor Token`，实现 uuid/challenge 发起、poll、成功写入本地账号、过期/取消清理。

## Primary Executor

- worker / engineer.

## Scope

- Add sidecar commands for start/complete/cancel Cursor connect.
- Generate `uuid`, `codeVerifier`, `challenge`.
- Open `https://cursor.com/loginDeepControl?...`.
- Poll `api2.cursor.sh/auth/poll` using verified protocol from T01 (camelCase response: `accessToken`, `refreshToken`, `authId`).
- After poll success, call `cursor.com/api/auth/me` with `WorkosCursorSessionToken` cookie to get email. Cookie format: `encodeURIComponent(jwtSub + "::" + accessToken)` where `jwtSub` is the `sub` field from accessToken JWT.
- Store account via model from T02.
- Do not expose manual token as a product entry; Cursor collection proceeds through OAuth accounts only.

## Out of Scope

- No server-side OAuth handling.
- No leaderboard/dedup changes.

## Owned Files / Modules

- `collector-core/src/config.rs`
- `collector-core/src/provider/cursor_dashboard.rs` or new `collector-core/src/provider/cursor_oauth.rs`
- `atl-collector/src/sidecar.rs`
- `src/desktop/renderer.js`
- `src/desktop/index.html`
- `src/shared/i18n.js`
- `src/desktop/tauri-bridge.js`

## Dependencies

- T01 protocol evidence.
- T02 account model.

## Source Design Anchors

- `Cursor 浏览器授权登录`
- `Cursor 账号身份`
- `本地状态`
- `本地持久化字段`

## Independent Execution

- Read current `addCursorToken` UI path and sidecar command bridge.
- Do not touch backend Store.

## Implementation Requirements

- Rename primary UI action from `Add Cursor Token` to `Connect Cursor`.
- Hide manual token entry from the normal product surface.
- Pending login state expires after 5 minutes.
- Poll interval defaults to 2 seconds and handles pending/success/expired/cancel.
- No token appears in renderer-visible HTML, logs, or upload payload.

## Comment Requirements

- Add comments only for challenge derivation and pending-state expiry.

## Subagent Verification

- A verifier should run mocked command tests and inspect UI text/i18n.

## Acceptance

- API: Sidecar commands expose start/complete/cancel with sanitized result.
- DB: No.
- Log: No token/cookie/JWT in logs.
- State / Enum: pending, success, expired, canceled, failed.
- Permission / Tenant: User must confirm in browser.
- User-visible Output: Sources shows Connect Cursor and reconnect/error states.
- Context / Evidence Fields: loginId, expiresAt, masked account label.

## Verification

- Unit/mocked HTTP tests for pending/success/expired/cancel.
- `node --check src/desktop/renderer.js`.
- Desktop quick self-test after implementation.

## Evidence

- Required evidence: test output, screenshot or concise UI evidence, privacy grep.
- Actual evidence belongs in handoff/evidence files, not by rewriting this task card.
