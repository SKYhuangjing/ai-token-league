# Task Plan

## Feature

- cursor-cloud-dedup

## Source Design

- doc/backend_multi_device_cursor_cloud_dedup_design.md

## Execution Order

1. T01_protocol_probe
2. T02_cursor_account_model
3. T03_connect_cursor_auth
4. T04_cursor_refresh_health
5. T05_server_hourly_dedup
6. T06_sync_state_reset
7. T07_ui_verification_release

## Dependency Notes

- T01 is a blocker for T03/T04. Do not implement private protocol fields before sanitized live evidence exists.
- T02 can start after T01 identifies token/account response shape; T03/T04 depend on T02 storage shape.
- T05 can start in parallel after T02 fixes the cloud identity/workdirHash contract.
- T06 depends on T05's sync bucket semantics and reset behavior.
- T07 depends on T03/T04/T05/T06 for user-visible states and end-to-end verification.

## Risks

- Cursor deep login and refresh endpoints are private and may drift.
- Token lifecycle bugs can silently drop Cursor usage; health must surface failure states.
- Cloud dedup and sync-state can conflict if sync bucket semantics are not fixed.
- Privacy regressions are high-risk because credentials are introduced into local config.
