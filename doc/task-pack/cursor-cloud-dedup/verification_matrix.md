# Verification Matrix

| Task ID | Source Anchor | Scenario | Check Type | Expected Result | Evidence | Owner |
|---|---|---|---|---|---|---|
| T01_protocol_probe | Cursor 浏览器授权登录 / Cursor token refresh | `auth/poll` pending and success | Manual sanitized probe | 404/pending and 200/JSON camelCase (`accessToken`, `refreshToken`, `authId`) documented without secrets | evidence/protocol_probe.md | **done** |
| T01_protocol_probe | Cursor token refresh | `oauth/token` refresh success and shouldLogout | Manual sanitized probe | snake_case response: `access_token`, `id_token`, `shouldLogout`; no `refresh_token` rotation | evidence/protocol_probe.md | **done** |
| T01_protocol_probe | Cursor 账号身份 | `cursor.com/api/auth/me` returns email | Manual sanitized probe | Cookie auth via `WorkosCursorSessionToken`; returns `email`, `sub`, `name`, `id` | evidence/protocol_probe.md | **done** |
| T02_cursor_account_model | Cursor 账号身份 / 本地存储和清理边界 | Authorized account stored locally | Unit / config test | account record stores token fields locally and sanitized config omits secrets | test output + sanitized config sample | implementation |
| T02_cursor_account_model | 废弃来源边界 | Deprecated local/legacy Cursor sources | Unit / mocked scan + health | only OAuth accounts generate Cursor sources; legacy tokens and ignored auto rows are cleared or hidden | test output | implementation |
| T03_connect_cursor_auth | Cursor 浏览器授权登录 | Connect Cursor pending/success/expired/cancel | Unit / mocked HTTP | pending polls continue, success stores account, expired/cancel clears pending state | test output | implementation |
| T04_cursor_refresh_health | Cursor token refresh | Proactive refresh before scan | Unit / mocked HTTP | expired token refreshes, usage request uses new access token | test output | implementation |
| T04_cursor_refresh_health | Cursor account ignore | Ignored OAuth account | Unit / mocked scan + health | account remains visible and refreshable, but no Cursor usage source is scanned or uploaded | test output | implementation |
| T04_cursor_refresh_health | Cursor token refresh | Usage 401 reactive refresh | Unit / mocked HTTP | refresh + one retry succeeds, account remains active | test output | implementation |
| T04_cursor_refresh_health | Cursor token refresh | Refresh shouldLogout / invalid token | Unit / mocked HTTP + UI state | account becomes reauth_required and health exposes reconnect state | test output + screenshot if UI touched | implementation |
| T05_server_hourly_dedup | 服务端 hourly 去重 | Same Cursor account from two devices | Store / HTTP API test | same natural key keeps one usage row and leaderboard is not doubled | test output | implementation |
| T05_server_hourly_dedup | 服务端 hourly 去重 | Local providers from two devices | Store / HTTP API test | Codex / Claude rows both remain and totals add | test output | implementation |
| T05_server_hourly_dedup | 服务端比对口径 | Cursor A overwritten by B | Store / HTTP API test | A usage row removed, A sync bucket remains matched | test output | implementation |
| T06_sync_state_reset | 云端 reset 与 sync-state 核对 | Cloud reset then sync-state | API / local manifest test | missing bucket returned and client invalidates manifest for reupload | test output | implementation |
| T06_sync_state_reset | 云端 reset 与 sync-state 核对 | Queue replay success | Unit / sync test | manifest updates only after successful upload | test output | implementation |
| T07_ui_verification_release | 验证与可观察性 | Privacy grep | grep / diagnostics export | no accessToken/refreshToken/Cookie/auth raw in upload payload, diagnostics, logs | grep output | QA |
| T07_ui_verification_release | 发布策略 | Release checklist readiness | doc review | external actions and release gates identify reset, sync-state, protocol drift, rollback | reviewed checklist | owner |
