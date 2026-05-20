# T10_backup_restore_device_semantics

## Task ID

- `T10_backup_restore_device_semantics`

## Owner Lens

- Disaster recovery semantics and multi-device guardrails.

## Goal

- 将 local backup restore 明确收口为“恢复原设备”，并在 UI / 文档 / evidence 中阻止它被误用为第二台设备加入路径。

## Primary Executor

- worker / desktop-core engineer.

## Scope

- Update local backup restore confirmation copy and command result summary.
- Make restore communicate that it can restore the original `deviceId` and local sync state.
- Point second-device users to join existing participant flow instead of backup restore.
- Keep Cursor credential restore redacted or disabled according to T02/T09 privacy boundaries.
- Add tests or smoke evidence proving restore preserves backup device semantics.

## Out of Scope

- No new backup storage backend.
- No server reset implementation.
- No onboarding import mode implementation beyond linking to T08/T09 flows.

## Owned Files / Modules

- `collector-core/src/local_backup.rs`
- `src-tauri/src/lib.rs`
- `src/desktop/renderer.js`
- `src/shared/i18n.js`
- `doc/task-pack/cursor-cloud-dedup/external_actions.md`
- Relevant tests in `collector-core`.

## Dependencies

- T02 for Cursor token redaction and local credential model.
- T09 for the join-vs-restore mode contract.

## Source Design Anchors

- `多设备身份引导与导入配置`
- `字段策略`
- `本地存储和清理边界`
- `验收口径`

## Independent Execution

- Read local backup export/restore code, restore dialog flow, and i18n keys.
- No need to inspect backend dedup or Cursor OAuth protocol internals.

## Implementation Requirements

- Restore confirmation must say this is for replacing/recovering the original device, not adding a second device.
- Restore result must surface restored `deviceId` in a safe summary.
- Restore must not restore real Cursor tokens; users must re-run `Connect Cursor` on the restored device.
- Backup restore must preserve existing hash validation and snapshot-before-restore behavior.
- Release/external actions must mention that support should direct multi-device users to join mode, not backup restore.

## Comment Requirements

- Add comments only if restore mode branching affects existing backup safety behavior.

## Subagent Verification

- A verifier should run backup/restore unit tests and inspect the confirmation text in zh-CN and en.

## Acceptance

- API: Restore command result identifies restore_device semantics and sanitized restored device summary.
- DB: No server DB change.
- Log: No Cursor tokens or identity private key leakage.
- State / Enum: backup restore remains restore_device, not join_existing_participant.
- Permission / Tenant: No.
- User-visible Output: Warning clearly distinguishes restore original device from add second device.
- Context / Evidence Fields: backup deviceId, restored deviceId, snapshot path, redaction proof.

## Verification

- Rust local backup tests.
- `node --check src/desktop/renderer.js` if UI text changes.
- Privacy grep on backup/restore outputs.

## Evidence

- Required evidence: backup/restore test output, restore confirmation text evidence, sanitized backup/restore result sample.
- Actual evidence belongs in handoff/evidence files, not by rewriting this task card.
