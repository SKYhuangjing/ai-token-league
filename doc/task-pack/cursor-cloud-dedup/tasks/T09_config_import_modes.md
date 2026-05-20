# T09_config_import_modes

## Task ID

- `T09_config_import_modes`

## Owner Lens

- Config import semantics, device identity, and local state safety.

## Goal

- 将配置导入拆成 `join_existing_participant` 和 `restore_device` 两种模式，避免普通多设备加入时覆盖本机 `deviceId`。

## Primary Executor

- worker / core engineer.

## Scope

- Add import mode support in config import core and Tauri/sidecar command boundary.
- `join_existing_participant` imports participant identity and low-risk preferences while preserving local `deviceId`.
- `restore_device` restores imported `deviceId` only after explicit user confirmation.
- Clear or avoid restoring sync manifest, sync state, upload queue, usage cache, and Cursor credentials in join mode.
- Add tests for both modes and secret redaction.

## Out of Scope

- No onboarding layout work beyond exposing command results for T08.
- No local backup file format migration unless required to keep existing restores working.
- No server API changes.

## Owned Files / Modules

- `collector-core/src/config.rs`
- `collector-core/src/local_backup.rs` if config import shares restore helpers.
- `src-tauri/src/lib.rs`
- `atl-collector/src/cli.rs` if CLI import config path exists or is added.
- `src/desktop/tauri-bridge.js`
- Relevant tests in `collector-core` and `tests/run-tests.js`.

## Dependencies

- T02 for Cursor account model and redaction boundaries.
- T06 for manifest / sync-state file semantics.

## Source Design Anchors

- `多设备身份引导与导入配置`
- `字段策略`
- `导入配置的最小 API 语义`
- `验收口径`

## Independent Execution

- Read `collector-core/src/config.rs` import/export functions, Tauri import dialog command, and local state file paths.
- No need to inspect Cursor OAuth implementation or backend Store.

## Implementation Requirements

- Add explicit mode values: `join_existing_participant` and `restore_device`.
- Make join mode the default for `Import Config` in product UI.
- Join mode must import `participantId`, identity keys, nickname, API base URL, language/display preferences, and provider enabled switches as allowed by the design.
- Join mode must preserve existing `deviceId`; if there is no current config, generate a new `deviceId`.
- Join mode must not restore `sync-manifest.json`, `sync-state.json`, `upload-queue.json`, `usage-cache.json`, real Cursor tokens, or cross-machine provider roots by default.
- Restore mode may restore imported `deviceId` and local state only through the explicit restore path.
- Both modes must keep Cursor access token, refresh token, Cookie, Workos token, and raw auth response out of logs, diagnostics, and renderer command output.
- Join mode must produce or allow a register payload where the imported `participantId` is reused but the local `deviceId` differs from the source device.

## Comment Requirements

- Add a short comment near import mode branching explaining why join preserves `deviceId`.

## Subagent Verification

- A verifier should inspect config before/after fixtures for both modes and run privacy grep.

## Acceptance

- API: Import command accepts mode and returns sanitized result with participantId/deviceId summary.
- DB: No server DB change.
- Log: No Cursor token or identity private key leakage.
- State / Enum: `join_existing_participant` preserves local device; `restore_device` restores imported device.
- Permission / Tenant: No.
- User-visible Output: Import result states whether this device joined an existing identity or restored an old device.
- Context / Evidence Fields: import mode, oldDeviceId, newDeviceId, participantId, cleaned local state files.

## Verification

- Rust unit tests for config import mode behavior.
- Node/sidecar command test for sanitized import result.
- Register payload or mocked register test proving same `participantId` and different `deviceId` after join mode.
- Privacy grep on exported/imported fixtures and diagnostics.

## Evidence

- Required evidence: focused test output, before/after config samples with secrets redacted, register payload or server device proof, local state cleanup proof for join mode.
- Actual evidence belongs in handoff/evidence files, not by rewriting this task card.
