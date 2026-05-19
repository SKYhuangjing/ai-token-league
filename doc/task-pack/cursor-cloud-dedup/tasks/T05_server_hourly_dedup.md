# T05_server_hourly_dedup

## Task ID

- `T05_server_hourly_dedup`

## Owner Lens

- Server write-time cloud dedup.

## Goal

- 在服务端 hourly snapshot 写入路径实现 Cursor cloud provider 跨设备去重，同时保持 Codex / Claude Code 多设备累加。

## Primary Executor

- worker / engineer.

## Scope

- Add cloud provider set and natural key helper.
- Dedup `usageHourly` rows with same `participantId/day/hour/toolCode/providerId/workdirHash/model` and different `deviceId`.
- Ensure derived `usageDaily` reflects deduped hourly rows.
- Keep sync bucket semantics stable.

## Out of Scope

- No daily snapshot primary-path repair.
- No client auth work.

## Owned Files / Modules

- `src/shared/schema.js`
- `src/backend/store.js`
- `src/backend/mysql-store.js`
- `tests/run-tests.js`
- `migrations/*` only if a schema gap is discovered; no DDL expected.

## Dependencies

- T02 must stabilize Cursor `workdirHash` / account hash.

## Source Design Anchors

- `规则卡：Cursor Cloud Natural Key`
- `服务端 hourly 去重`
- `删除边界`
- `daily 边界`

## Independent Execution

- Read `upsertHourlySnapshotBatch`, `deriveDailyFromHourly`, `usageHourly` persistence, and tests around hourly snapshots.
- No need to implement desktop UI.

## Implementation Requirements

- Dedup only for `CLOUD_PROVIDER_IDS`.
- Delete only rows with same natural key and `deviceId != input.deviceId`.
- Do not delete different hour/model/account rows.
- Current device stale rows remain handled by `deleteHourlyBucketUsageRows`.
- MySQL full sync path must persist deleted hourly/daily rows; if incremental path is introduced, include explicit deleted keys.

## Comment Requirements

- Short comment around cloud natural key helper.

## Subagent Verification

- A verifier should run server tests and inspect local provider unaffected cases.

## Acceptance

- API: `/api/usage/daily-batch` hourly snapshot accepts same Cursor account from two devices.
- DB: `usage_hourly` has one row per cloud natural key; local providers have both rows.
- Log: Optional deleted count is sanitized.
- State / Enum: No new public enum.
- Permission / Tenant: Only same participant dedups; no cross-participant deletion.
- User-visible Output: Leaderboard totals not doubled.
- Context / Evidence Fields: deletedHourlyKeys count, incomingKeys.

## Verification

- Node tests for Cursor same-account dedup, Cursor different-account keep, Codex/Claude keep, leaderboard total.
- MySQL reload test when feasible.

## Evidence

- Required evidence: `npm test` or focused test output; MySQL evidence if touched.
- Actual evidence belongs in handoff/evidence files, not by rewriting this task card.
