# Development Handoff

## Current State

- Status: task-pack draft only.
- Source design: doc/backend_multi_device_cursor_cloud_dedup_design.md.
- Implementation: not started in this pack.
- Evidence: not collected.

## Evidence Index

| Task | Required Evidence | Status |
|---|---|---|
| T01_protocol_probe | sanitized Cursor deep login / refresh protocol probe | **done** — see evidence/protocol_probe.md |
| T02_cursor_account_model | config tests and sanitized local storage sample | **done** — CursorAccount struct, redaction in diagnostics+sidecar |
| T03_connect_cursor_auth | mocked connect flow tests | **done** — sidecar commands, PKCE + poll + /api/auth/me |
| T04_cursor_refresh_health | refresh and reauth tests plus health state evidence | **done** — refresh_token(), proactive/reactive refresh, health states |
| T05_server_hourly_dedup | Store / HTTP / MySQL reload test output | **done** — 5 new tests passing |
| T06_sync_state_reset | sync-state and reset behavior evidence | **done** — compareSyncState + 2 new tests passing |
| T07_ui_verification_release | UI screenshot or CLI output, privacy grep, release checklist | reopened — prior privacy/release evidence must be rerun after T08/T09/T10 |
| T08_multi_device_onboarding | onboarding create/join UI evidence and i18n check | **done** — join mode button, i18n zh-CN+en, post-join Connect Cursor prompt |
| T09_config_import_modes | join/restore import mode tests and before/after config samples | **done** — Rust mode param, join preserves local device state and clears sync/cache/queue, 5 import-mode tests passing, sidecar sanitized summary wired |
| T10_backup_restore_device_semantics | restore warning evidence and backup/restore redaction proof | **done** — restore warning with device semantics, restoreMode/restoredDeviceId in result, backup test passing |

## Failure Routing

| Failure Type | Owner | Required Proof |
|---|---|---|
| Design gap | backend-api-dev | source design missing anchor |
| Code bug | implementation owner | request/response + traceId + DB/log |
| Case bug | api-test-dev | YAML setup/reset mismatch |
| Runtime environment | runner/operator | listener/config/log evidence |
