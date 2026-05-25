# MySQL Request-Local Writes And Scoped Lock Design

Date: 2026-05-25

## Problem Definition

The current MySQL data-loss guard uses one process-local queue plus one MySQL named lock for all MySQL write entrypoints. This is intentionally conservative: `MySqlStore` still uses store-level fields such as `this.db.usageDaily`, `this.db.usageHourly`, `this.db.usageSyncBuckets*`, and `this.db.uploadBatches` as request working state in several write paths.

The global lock prevents concurrent requests from overwriting that shared working state. It fixes the P0 data-loss class, but it also serializes writes that are logically independent, such as two different participants uploading different hourly buckets.

The long-term goal is to make MySQL writes request-local and SQL-first, then shrink the lock scope to the smallest data domain that can conflict.

## Success Criteria

- No write path uses `this.db.usageDaily`, `this.db.usageHourly`, `this.db.usageSyncBuckets*`, or `this.db.uploadBatches` as mutable request working state in MySQL mode.
- Snapshot hourly writes can run concurrently across different independent scopes. Local providers use day/hour scoped locks; cloud providers use a wider participant/provider lock because current duplicate cleanup can touch multiple devices.
- Snapshot daily writes can run concurrently across different participants. The first scoped implementation intentionally serializes writes within the same participant through `participant:{participantId}` so admin delete has a clear cross-process exclusion point.
- Different participants do not block each other for normal usage uploads.
- Legacy uploads remain safe during compatibility rollout and never trigger table-wide delete or table-wide mirror rewrite.
- Pricing, admin delete, and maintenance operations keep explicit wider locks because their data impact is wider than one usage bucket.
- Lock timeout still fails closed. A request that cannot acquire its required scoped lock must fail and rely on client retry, not continue unlocked.
- Participant parent lock acquired by uploads uses a shorter timeout (default 2s) than the main `MYSQL_WRITE_LOCK_TIMEOUT_SECONDS`, because admin delete is the only legitimate long holder of that lock. `MYSQL_WRITE_LOCK_TIMEOUT_SECONDS=0` keeps its existing fail-fast semantics in scoped mode; the participant parent lock timeout is a separate env (`MYSQL_PARTICIPANT_PARENT_LOCK_TIMEOUT_SECONDS`).
- The existing global write lock remains available as a rollout fallback until scoped locks have production evidence.
- A single request never holds an unbounded number of MySQL named locks. The scoped-lock implementation must define and enforce a small lock-count budget.

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

The lock-name formatter must enforce the 64-character limit after composing the full prefix and scope. If the composed name is too long, use a uniformly bounded fallback:

```text
atl:<sha256(fullScope).slice(0, 56)>
```

The full unhashed scope remains available only in structured logs and test diagnostics.

### Lock Hierarchy And Budget

Do not acquire scoped locks in pure lexical order. Use a hierarchy first, then lexical order only inside the same hierarchy level:

1. Maintenance/global lock, when used.
2. Participant parent lock: `participant:{participantId}`.
3. Cloud-provider participant lock: `participant-cloud:{participantId}:{providerId}`.
4. Usage parent lock: `usage-day:{participantId}:{deviceId}:{day}:{providerId}`.
5. Usage child lock: `usage-hour:{participantId}:{deviceId}:{day}:{hour}:{providerId}`.
6. Pricing/admin child locks.

Every request must acquire locks in hierarchy order and release them in reverse order. If any lock cannot be acquired before its timeout, the request must release already-held locks and fail closed. It must not retry with a partial lock set.

The first scoped implementation should cap normal usage-upload requests at:

```text
maxLocksPerRequest = 3
```

That budget covers:

- participant parent lock;
- one usage parent lock or one cloud-provider participant lock;
- one hourly child lock when needed.

Any operation that appears to need more locks must either use a wider parent lock or stay on the global fallback. It must not enumerate hundreds of bucket locks.

Because each MySQL named lock holds one pool connection and the SQL transaction needs one more connection, the effective minimum pool size for scoped mode is:

```text
MYSQL_CONNECTION_LIMIT >= maxLocksPerRequest + 1
```

With `maxLocksPerRequest = 3`, scoped mode requires an effective connection limit of at least `4`. The constructor should floor `MYSQL_CONNECTION_LIMIT` to this value when `MYSQL_WRITE_LOCK_MODE=scoped`.

Participant parent locks use a shorter timeout than child usage locks so admin delete has a deterministic insertion window:

```text
MYSQL_PARTICIPANT_PARENT_LOCK_TIMEOUT_SECONDS=2
```

If a participant parent lock times out, the server should return HTTP 503 with `lockTimeout=true` and a `Retry-After` header. This tells clients to retry later instead of treating the response as a semantic upload error.

### Normal Usage Upload Locks

| Path | Lock Scope | Reason |
| --- | --- | --- |
| Hourly snapshot, local provider | `participant:{participantId}` + `usage-day:{participantId}:{deviceId}:{day}:{providerId}` + `usage-hour:{participantId}:{deviceId}:{day}:{hour}:{providerId}` | Hourly rows are bucket-scoped, but the write also refreshes the derived daily scope for the same participant/device/day/provider. The parent daily lock keeps hourly-vs-daily and same-day multi-hour writes deterministic. |
| Hourly snapshot, cloud provider | `participant:{participantId}` + `participant-cloud:{participantId}:{providerId}` | Current cloud duplicate cleanup can delete matching hourly rows from other devices and then refresh those devices' daily scopes. Device-scoped daily/hour locks do not cover that write surface. Use the cloud participant lock until the cleanup is redesigned to be strictly device-local. |
| Daily snapshot | `participant:{participantId}` + `usage-day:{participantId}:{deviceId}:{day}:{providerId}` | Only rows and metadata inside one daily bucket are replaced, but the participant parent lock gives admin delete a deterministic insertion point. |
| Legacy upload | `participant:{participantId}` + `legacy-device:{participantId}:{deviceId}` initially | Legacy has no explicit snapshot boundary; device-level is the safe first split after the participant parent lock. |
| Device register | `participant:{participantId}` | Participant/device identity rows can conflict with upload-time identity upserts. |

Legacy can later move to `legacy-day:{participantId}:{deviceId}:{day}:{providerId}` after the builder proves every accepted legacy row has a reliable day/provider scope and all cleanup rules are scope-local.

Cloud-provider hourly writes can later move back to `usage-day` + `usage-hour` only if one of these design changes lands first:

- the cloud duplicate cleanup becomes strictly device-local;
- cloud providers stop using hourly upload and move to daily snapshots only;
- the write context can cheaply precompute every affected device and acquire all affected daily locks within the lock-count budget.

### Wider Operation Locks

| Path | Lock Scope | Reason |
| --- | --- | --- |
| `deleteParticipantData` | `participant:{participantId}` | Deletes identity, devices, workdirs, usage rows, upload batches, and sync metadata. Uploads for the same participant must also acquire this parent lock with a short timeout, so delete does not need to enumerate child usage scopes. |
| `deleteDeviceData` | `participant:{participantId}` + `device-admin:{deviceId}` | Deletes device rows and can invalidate cloud duplicate scopes. Resolve participantId first, then acquire participant parent lock before the device admin lock. This assumes device-to-participant binding is immutable after registration; if that invariant changes, the lookup must move under a wider lock or SQL row lock. |
| `upsertModelPrice` / `deleteModelPrice` | `pricing-model:{model}` | Recalculates rows for affected model and aliases. |
| `refreshOpenRouterPrices({ recalculate: true })` | `pricing-global` | Can update price cache and recalculate many models. Pricing recalc does not acquire participant usage locks in the first scoped implementation; cost fields are display-only and may use last-writer-wins with concurrent uploads. |
| Schema migration / maintenance | `maintenance-global` | Cross-table or schema-wide operation. |

Admin delete operations are rare and correctness-critical. If a future delete flow cannot fit the hierarchy and lock-count budget, it should temporarily use `MYSQL_WRITE_LOCK_MODE=global` or `maintenance-global` rather than enumerating all bucket locks for the participant.

## Transaction Model

Every bucket write remains one database transaction:

1. Derive the full lock set from the request before acquiring any lock.
2. Reject the request if the lock set exceeds the configured lock-count budget.
3. Acquire scoped named locks in hierarchy order.
4. Start transaction.
5. Lock current sync metadata row with `SELECT ... FOR UPDATE` or insert a placeholder row then lock it.
6. Upsert participant/device/workdir rows relevant to this context.
7. Upsert accepted usage rows.
8. Delete stale rows only inside the locked scope.
9. Upsert sync metadata and upload audit rows.
10. Commit.
11. Release named locks in reverse order.

The named lock serializes work across backend instances. The transaction and row locks protect the actual SQL mutation. Both are needed until all write paths are fully SQL-local and row-level locking has enough production evidence.

## Legacy Compatibility Strategy

Legacy is the highest-risk path because it lacks an explicit snapshot boundary.

Initial long-term implementation:

- Keep legacy upsert-only from the API contract perspective.
- Do not derive deletes from "missing rows" in a legacy payload.
- The request envelope's `(participantId, deviceId)` is the legacy upload scope. The builder must reject any row that declares or implies a different deviceId; if old-client compatibility cannot satisfy this, legacy must use only the participant parent lock and skip the device child lock.
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
- Remove `await this.load()` rollback only on a path-by-path basis, in the same PR that replaces that path's `Store.prototype.upsertUsageBatch.call(this, ...)` or other inherited mutator with request-local SQL helpers. SQL transaction rollback owns database recovery; dropping the request context owns memory cleanup. Keeping full `load()` after a path is request-local would reintroduce table-wide reads into hot write paths, but removing it before the path stops mutating `this.db.*` would leak dirty request state.
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
- Implement multi-lock acquisition with hierarchy ordering, lock-count budget enforcement, and fail-closed timeout cleanup.
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
| Different hourly buckets over-serialize | Two backend instances upload different participants' daily parent scopes; both succeed concurrently and neither waits for unrelated participant or bucket locks. Same-participant writes intentionally serialize in the first scoped implementation because the participant parent lock is the admin-delete exclusion point. |
| Different participants block each other | Concurrent uploads for different participants complete without sharing a lock name. |
| Daily vs hourly same day conflict | Daily snapshot and hourly snapshot for same participant/device/day/provider share the `usage-day` parent lock and produce deterministic final daily rows. |
| Cloud duplicate cross-device cleanup | For a cloud provider, uploading device A hourly rows deletes duplicate matching device B hourly rows and refreshes device B daily rows under `participant-cloud:{participantId}:{providerId}`. Concurrent device B upload must not race or resurrect deleted rows. |
| Legacy vs snapshot conflict | Participant parent lock plus legacy device lock and snapshot bucket lock cannot reintroduce deleted stale rows or remove snapshot rows unexpectedly. |
| Admin delete vs upload | Uploads acquire `participant:{participantId}` before child usage locks; participant/device delete acquires the same participant parent lock before deleting. Concurrent delete/upload cannot leave orphan rows or resurrect deleted data. |
| Pricing recalc vs upload | Pricing recalc may run concurrently with participant uploads. Assert `totalTokens` and usage identity fields remain stable; cost display fields may be last-writer-wins unless pricing recalc is later promoted to a global write stop. |
| Lock timeout | Scoped lock timeout fails closed and does not enter SQL mutation. |
| Participant parent lock timeout | If `participant:{participantId}` cannot be acquired within `MYSQL_PARTICIPANT_PARENT_LOCK_TIMEOUT_SECONDS`, the server returns HTTP 503 with `lockTimeout=true` and `Retry-After`; the client retries instead of marking the bucket as a semantic failure. |
| Lock name length | Very long database names and scope strings are formatted into a final `GET_LOCK` name no longer than 64 characters; logs still include the original unhashed scope for diagnostics. |
| Multi-lock connection budget | With scoped mode and `maxLocksPerRequest = 3`, effective `MYSQL_CONNECTION_LIMIT` is floored to at least `4`; concurrent uploads above the pool's spare capacity do not self-deadlock or time out acquiring pool connections while holding partial locks. |
| Pool-limited throughput | With `MYSQL_CONNECTION_LIMIT=4` and scoped mode, 8 different-participant hourly uploads complete in no worse than `singleHourlyDuration * ceil(8 / 3) + epsilon`, proving the pool limits concurrency predictably rather than causing hidden serialization or connection starvation. |
| Request-local rollback | After every MySQL write path in `MYSQL_WRITE_LOCK_MODE=global`, `Object.keys(store.db.usageDaily).length === 0` and `Object.keys(store.db.usageHourly).length === 0`; request-local paths do not rely on `await this.load()` rollback. |
| Legacy envelope scope | A legacy upload whose row-level data conflicts with the envelope `(participantId, deviceId)` is rejected by the builder, or legacy falls back to participant-only locking with no device child lock. |
| Multi-lock long-tail wait | Two backend instances contending on overlapping parent/child locks acquire locks in hierarchy order; P99 lock wait stays below `MYSQL_WRITE_LOCK_TIMEOUT_SECONDS`, and timeout releases all held locks before returning an error. |

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

- Whether cloud-provider hourly uploads should stay on `participant-cloud` locks or move to a daily-only upload model after old behavior is retired.
- The production threshold for switching `MYSQL_WRITE_LOCK_MODE` from `global` to `scoped`.
- Whether legacy clients should be blocked after a minimum snapshot-capable version, instead of further optimizing legacy concurrency.
- Whether pricing recalc should become an asynchronous job with progress state rather than running under request/response admin APIs. Until then, cost display fields are allowed to be last-writer-wins with concurrent uploads; ranking token fields are not.
