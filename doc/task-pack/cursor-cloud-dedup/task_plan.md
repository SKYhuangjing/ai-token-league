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
7. T09_config_import_modes
8. T08_multi_device_onboarding
9. T10_backup_restore_device_semantics
10. T07_ui_verification_release

## Dependency Notes

- T01 is a blocker for T03/T04. Do not implement private protocol fields before sanitized live evidence exists.
- T02 can start after T01 identifies token/account response shape; T03/T04 depend on T02 storage shape.
- T05 can start in parallel after T02 fixes the cloud identity/workdirHash contract.
- T06 depends on T05's sync bucket semantics and reset behavior.
- T09 can start after T02/T06 clarify credential redaction and local sync-state file semantics.
- T08 depends on T09 for the `join_existing_participant` command semantics and T03/T04 for post-join `Connect Cursor` guidance.
- T10 depends on T09 because backup restore must be framed as `restore_device`, not as the multi-device join path.
- T07 is the final closure task and depends on T03/T04/T05/T06/T08/T09/T10 for user-visible states, privacy, release notes, and end-to-end verification.

## Risks

- Cursor deep login and refresh endpoints are private and may drift.
- Token lifecycle bugs can silently drop Cursor usage; health must surface failure states.
- Cloud dedup and sync-state can conflict if sync bucket semantics are not fixed.
- Privacy regressions are high-risk because credentials are introduced into local config.
- Importing full config can collapse two physical devices into one server `deviceId`; onboarding and import UI must use intent-based choices.
- Backup restore is easy to misuse as a second-device setup path; release/support docs must route multi-device users to join mode.
