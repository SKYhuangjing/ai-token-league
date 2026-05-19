# T06_sync_state_reset

## Task ID

- `T06_sync_state_reset`

## Owner Lens

- Reset, manifest, and upload correctness.

## Goal

- 实现云端 reset 后本地不会因旧 `sync-manifest.json` no-op 的修正链路，并固定 sync-state 只比对 hourly sync bucket 接收状态。

## Primary Executor

- worker / engineer.

## Scope

- Add signed `POST /api/usage/sync-state` or equivalent client/server handshake.
- Server compares `usage_sync_buckets_hourly` by `participantId/deviceId/day/hour/providerId`.
- Client invalidates missing/different manifest entries and reuploads hourly snapshots.
- Reset clears server usage rows and sync buckets; local cloud reset clears local manifest for that server URL.

## Out of Scope

- No daily snapshot sync-state primary path.
- No Cursor auth implementation.

## Owned Files / Modules

- `src/backend/server.js`
- `src/backend/store.js`
- `src/backend/mysql-store.js`
- `collector-core/src/sync.rs`
- `collector-core/src/config.rs`
- `tests/run-tests.js`

## Dependencies

- T05 for dedup and sync bucket semantics.

## Source Design Anchors

- `云端 reset 与 sync-state 核对`
- `服务端比对口径`
- `触发时机`

## Independent Execution

- Read current `sync_usage`, queue handling, `deleteParticipantData`, bucket sync methods.
- No need to modify Cursor provider.

## Implementation Requirements

- Verify sync-state payload signature using same identity model as daily-batch.
- Return `missing`, `different`, `matched`.
- Do not treat dedup-deleted Cursor usage rows as missing if the device sync bucket still exists.
- Cloud reset must delete usage rows and sync buckets so sync-state returns missing.
- Queue replay updates manifest only on successful upload.

## Comment Requirements

- Comment sync-state semantics because it intentionally differs from leaderboard row presence.

## Subagent Verification

- A verifier should inspect reset and sync-state tests for reupload loop risks.

## Acceptance

- API: signed sync-state endpoint rejects invalid signature and returns correct bucket states.
- DB: reset deletes usage rows and hourly sync buckets.
- Log: sync-state logs counts only.
- State / Enum: manifest entries invalidated locally for missing/different.
- Permission / Tenant: Participant can only query own bucket state.
- User-visible Output: Sync can recover after cloud reset.
- Context / Evidence Fields: bucket key, fingerprint, state.

## Verification

- Unit/API tests for matched/missing/different.
- Reset then sync-state test.
- Queue replay manifest test.

## Evidence

- Required evidence: focused test output and sample sanitized sync-state response.
- Actual evidence belongs in handoff/evidence files, not by rewriting this task card.
