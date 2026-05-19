# Development Handoff

## Current State

- Status: task-pack draft only.
- Source design: doc/backend_multi_device_cursor_cloud_dedup_design.md.
- Implementation: not started in this pack.
- Evidence: not collected.

## Evidence Index

| Task | Required Evidence | Status |
|---|---|---|
| T01_protocol_probe | sanitized Cursor deep login / refresh protocol probe | pending |
| T02_cursor_account_model | config tests and sanitized local storage sample | pending |
| T03_connect_cursor_auth | mocked connect flow tests | pending |
| T04_cursor_refresh_health | refresh and reauth tests plus health state evidence | pending |
| T05_server_hourly_dedup | Store / HTTP / MySQL reload test output | pending |
| T06_sync_state_reset | sync-state and reset behavior evidence | pending |
| T07_ui_verification_release | UI screenshot or CLI output, privacy grep, release checklist | pending |

## Failure Routing

| Failure Type | Owner | Required Proof |
|---|---|---|
| Design gap | backend-api-dev | source design missing anchor |
| Code bug | implementation owner | request/response + traceId + DB/log |
| Case bug | api-test-dev | YAML setup/reset mismatch |
| Runtime environment | runner/operator | listener/config/log evidence |
