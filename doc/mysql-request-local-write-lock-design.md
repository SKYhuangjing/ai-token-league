# MySQL Request-Local Writes And Scoped Lock Design

Date: 2026-05-25

## Problem Definition

The current MySQL data-loss guard uses one process-local queue plus one MySQL named lock for all MySQL write entrypoints. This is intentionally conservative: `MySqlStore` still uses store-level fields such as `this.db.usageDaily`, `this.db.usageHourly`, `this.db.usageSyncBuckets*`, and `this.db.uploadBatches` as request working state in several write paths.

The global lock prevents concurrent requests from overwriting that shared working state. It fixes the P0 data-loss class, but it also serializes writes that are logically independent, such as two different participants uploading different hourly buckets.

The long-term goal is to make MySQL writes request-local and SQL-first, then shrink the lock scope to the smallest data domain that can conflict.

## Success Criteria

- No write path uses `this.db.usageDaily`, `this.db.usageHourly`, `this.db.usageSyncBuckets*`, or `this.db.uploadBatches` as mutable request working state in MySQL mode.
- Snapshot hourly writes can run concurrently across different `(participantId, deviceId, day, hour, providerId)` buckets.
- Snapshot daily writes can run concurrently across different `(participantId, deviceId, day, providerId)` buckets.
- Different participants do not block each other for normal usage uploads.
- Legacy uploads remain safe during compatibility rollout and never trigger table-wide delete or table-wide mirror rewrite.
- Pricing, admin delete, and maintenance operations keep explicit wider locks because their data impact is wider than one usage bucket.
- Lock timeout still fails closed. A request that cannot acquire its required scoped lock must fail and rely on client retry, not continue unlocked.
- The existing global write lock remains available as a rollout fallback until scoped locks have production evidence.

## Key Constraint

Lock granularity must match the real shared state.

It is unsafe to replace the current global lock with participant or bucket locks while MySQL writes still mutate store-level request mirrors. Two requests for different users would take different lock names, then still race through the same `this.db.usageDaily` object inside one backend process.

Therefore the implementation order is mandatory:

1. Remove store-level mutable usage mirrors from MySQL write paths.
2. Pass request-local state into SQL helper functions.
3. Add scoped lock names.
4. Roll out scoped locks behind a fallback switch.

## Recommended Architecture

### Request-Local Usage Context

Introduce a request-local context object for MySQL write operations:

```js
{
  participant,
  device,
  workdirs,
  usageDaily,
  usageHourly,
  dailySyncBuckets,
  hourlySyncBuckets,
  uploadBatches,
  incomingKeys,
  affectedScopes
}
```

This object is created inside one request and is never stored on `this.db`. It can reuse shared schema normalization and pricing helpers, but it must not call inherited JSON-store methods that mutate the global store object unless those methods are refactored to accept an explicit context.

### SQL-First Write Helpers

MySQL writes should move from "mutate inherited in-memory Store, then sync rows" to "derive normalized rows, then write exactly those rows in SQL".

Required helper boundaries:

| Helper | Responsibility |
| --- | --- |
| `buildSnapshotDailyWriteContext(input)` | Validate daily snapshot, normalize accepted rows, compute incoming usage keys and bucket fingerprint. |
| `buildSnapshotHourlyWriteContext(input)` | Validate hourly snapshot, normalize accepted hourly rows, derive affected daily scope rows. |
| `buildLegacyWriteContext(input)` | Validate legacy upload, normalize accepted rows, identify affected participant/device/day/provider scopes. |
| `writeDailyBucketTx(conn, context)` | Upsert identity/workdir rows, upsert accepted daily usage rows, delete stale rows only inside the daily bucket, write bucket metadata. |
| `writeHourlyBucketTx(conn, context)` | Upsert identity/workdir rows, upsert hourly rows, delete stale hourly rows only inside the hourly bucket, refresh derived daily scope, write hourly metadata. |
| `writeLegacyScopesTx(conn, context)` | Upsert accepted legacy rows and upload audit rows; delete only explicitly superseded legacy rows detected by source fingerprint or unknown-model replacement. |

The JSON store can keep its current inherited behavior as a protocol fixture. MySQL production paths should not depend on JSON-store-shaped resident mirrors.

## Scoped Lock Model

Use MySQL named locks only for scopes that can conflict. Lock names must include the environment/database prefix so different deployments do not block each other.

Recommended lock name format:

```text
atl:<database>:<scope-type>:<scope-key>
```

MySQL lock names are limited to 64 characters. Long scope keys should be hashed:

```text
atl:<database>:usage-hour:<sha256(scope).slice(0, 24)>
```

Store the unhashed scope string in logs for observability, but send only the bounded lock name to `GET_LOCK`.

### Normal Usage Upload Locks

| Path | Lock Scope | Reason |
| --- | --- | --- |
| Hourly snapshot | `usage-day:{participantId}:{deviceId}:{day}:{providerId}` plus `usage-hour:{participantId}:{deviceId}:{day}:{hour}:{providerId}` | Hourly rows are bucket-scoped, but the write also refreshes the derived daily scope for the same participant/device/day/provider. The parent daily lock keeps hourly-vs-daily and same-day multi-hour writes deterministic. |
| Daily snapshot | `usage-day:{participantId}:{deviceId}:{day}:{providerId}` | Only rows and metadata inside one daily bucket are replaced. |
| Legacy upload | `legacy-device:{participantId}:{deviceId}` initially | Legacy has no explicit snapshot boundary; device-level is the safe first split. |
| Device register | `identity:{participantId}` | Participant/device identity rows can conflict with upload-time identity upserts. |

Legacy can later move to `legacy-day:{participantId}:{deviceId}:{day}:{providerId}` after the builder proves every accepted legacy row has a reliable day/provider scope and all cleanup rules are scope-local.

### Wider Operation Locks

| Path | Lock Scope | Reason |
| --- | --- | --- |
| `deleteParticipantData` | `participant-admin:{participantId}` plus blocks usage scopes for that participant | Deletes identity, devices, workdirs, usage rows, upload batches, and sync metadata. |
| `deleteDeviceData` | `device-admin:{deviceId}` plus blocks usage scopes for that device | Deletes device rows and can invalidate cloud duplicate scopes. |
| `upsertModelPrice` / `deleteModelPrice` | `pricing-model:{model}` | Recalculates rows for affected model and aliases. |
| `refreshOpenRouterPrices({ recalculate: true })` | `pricing-global` | Can update price cache and recalculate many models. |
| Schema migration / maintenance | `maintenance-global` | Cross-table or schema-wide operation. |

If an operation needs multiple locks, acquire them in deterministic lexical order and release in reverse order. This avoids deadlocks between, for example, device deletion and concurrent usage uploads.

## Transaction Model

Every bucket write remains one database transaction:

1. Acquire scoped named lock.
2. Start transaction.
3. Lock current sync metadata row with `SELECT ... FOR UPDATE` or insert a placeholder row then lock it.
4. Upsert participant/device/workdir rows relevant to this context.
5. Upsert accepted usage rows.
6. Delete stale rows only inside the locked scope.
7. Upsert sync metadata and upload audit rows.
8. Commit.
9. Release named lock.

The named lock serializes work across backend instances. The transaction and row locks protect the actual SQL mutation. Both are needed until all write paths are fully SQL-local and row-level locking has enough production evidence.

## Legacy Compatibility Strategy

Legacy is the highest-risk path because it lacks an explicit snapshot boundary.

Initial long-term implementation:

- Keep legacy upsert-only from the API contract perspective.
- Do not derive deletes from "missing rows" in a legacy payload.
- Allow only narrow cleanup rules already implied by the accepted rows:
  - exact `sourceFingerprint` replacement for the same participant/device/provider/day where the new row supersedes an old duplicate;
  - unknown-model replacement when a known model row for the same natural key arrives.
- Use `legacy-device:{participantId}:{deviceId}` lock at first.
- Keep legacy success logs visible so ops can measure old-client traffic before tightening compatibility gates.

After old clients are below an agreed threshold, prefer enforcing snapshot-capable clients over investing in more complex legacy delete semantics.

## Rollout Plan

### Phase 1: Request-Local Builders

- Add context builders for hourly snapshot, daily snapshot, and legacy upload.
- Builders return normalized rows and affected scopes without mutating `this.db.usage*`.
- Keep current global `withWriteLock` while builders are introduced.
- Verification: existing `npm test`, plus tests that assert MySQL builders leave store-level usage mirrors unchanged.

### Phase 2: SQL Helper Replacement

- Replace inherited `Store.prototype.upsertUsageBatch.call(this, input)` usage in MySQL snapshot paths.
- Replace `loadWriteScope()` dependency with targeted SQL reads inside builders.
- Replace legacy `loadUsageMirrorForMaintenance()` with affected-scope SQL reads.
- Keep global named lock as a safety guard.
- Verification: dual-backend real MySQL case, legacy/snapshot coexistence, repeated replay, and failure rollback tests.

### Phase 3: Scoped Lock Infrastructure

- Add lock scope derivation:
  - `lockScopesForUsageUpload(input)`
  - `lockScopesForAdminDelete(input)`
  - `lockScopesForPricing(input)`
- Implement multi-lock acquisition with deterministic ordering.
- Add env rollout mode:

```text
MYSQL_WRITE_LOCK_MODE=global|scoped
```

Default remains `global` until scoped mode passes real MySQL soak.

### Phase 4: Scoped Lock Rollout

- Enable scoped mode in dev MySQL first.
- Run high-concurrency dual-backend tests with mixed participants, mixed devices, mixed days, mixed hours, daily snapshots, hourly snapshots, and legacy uploads.
- Compare throughput and lock wait durations against global mode.
- Enable scoped mode in production only after no data-loss or lock-timeout regression appears.

### Phase 5: Remove Global Fallback From Hot Path

- Keep `maintenance-global` for schema and cross-table jobs.
- Remove global lock from normal usage uploads after scoped mode has production evidence.
- Keep emergency rollback by allowing `MYSQL_WRITE_LOCK_MODE=global`.

## Verification Matrix

| Risk | Required Case |
| --- | --- |
| Store-level mirror race returns | Unit test that two different scoped writes do not mutate shared `this.db.usageDaily` / `usageHourly`. |
| Same hourly bucket conflict | Two backend instances upload different payloads for the same hourly bucket; final DB equals last committed bucket and metadata fingerprint. |
| Different hourly buckets over-serialize | Two backend instances upload different daily parent scopes, such as different participant/device/day/provider combinations; both succeed concurrently and neither waits for unrelated bucket lock. Same participant/device/day/provider intentionally serializes because daily derivation is shared. |
| Different participants block each other | Concurrent uploads for different participants complete without sharing a lock name. |
| Daily vs hourly same day conflict | Daily snapshot and hourly snapshot for same participant/device/day/provider share the `usage-day` parent lock and produce deterministic final daily rows. |
| Legacy vs snapshot conflict | Legacy device lock plus snapshot bucket lock cannot reintroduce deleted stale rows or remove snapshot rows unexpectedly. |
| Admin delete vs upload | Participant/device delete and concurrent upload cannot leave orphan rows or resurrect deleted data. |
| Pricing recalc vs upload | Pricing recalc cannot write stale cost fields over a concurrent upload. |
| Lock timeout | Scoped lock timeout fails closed and does not enter SQL mutation. |
| Multi-lock deadlock | Admin/pricing operations acquire multiple locks in deterministic order; stress test shows no circular wait. |

## Metrics And Observability

Add structured fields to write logs:

| Field | Purpose |
| --- | --- |
| `mysqlWriteLockMode` | `global` or `scoped`. |
| `mysqlLockScopes` | Human-readable scope strings, redacted or hashed where needed. |
| `mysqlLockWaitMs` | Time spent waiting for named locks. |
| `mysqlTxMs` | Time spent inside SQL transaction. |
| `mysqlWriteMode` | Existing mode such as `incrementalHourly`, `incrementalDaily`, `legacyMirrorSync`, `noop`. |
| `lockTimeout` | Boolean marker for fail-closed timeout. |

Success is not just lower latency. Success means lower lock wait for unrelated users while preserving exact row-set convergence under replay and concurrency.

## Rejected Alternatives

### Only Change Lock Names

Rejected because store-level request mirrors would still be shared. This would reduce waiting while restoring the original race at the in-memory layer.

### Use Only SQL Row Locks

Rejected for the next step because the current code still performs non-SQL request preparation through shared JS objects. Row locks cannot protect JavaScript object mutation before the transaction.

### Keep Global Lock Permanently

Rejected as the final state because it serializes unrelated participants and buckets. It is acceptable as a temporary data-loss guard, not as a production scaling architecture.

### Make Legacy Fully Deletion-Capable

Rejected unless old-client support must continue indefinitely. Snapshot-capable clients provide an explicit bucket truth. Making legacy deletion-capable requires reconstructing missing-row intent from incomplete payloads and carries higher data-loss risk.

## Open Decisions

- Whether daily snapshot and hourly snapshot for the same participant/device/day/provider should share a parent `usage-day` lock, or whether SQL transaction rules can make their final state deterministic without it.
- The production threshold for switching `MYSQL_WRITE_LOCK_MODE` from `global` to `scoped`.
- Whether legacy clients should be blocked after a minimum snapshot-capable version, instead of further optimizing legacy concurrency.
- Whether pricing recalc should become an asynchronous job with progress state rather than running under request/response admin APIs.
