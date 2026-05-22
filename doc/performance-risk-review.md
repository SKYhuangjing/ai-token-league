# Performance Risk Review

Date: 2026-05-22

## Problem Definition

The current product has a visible performance issue around local data reset and first tracking startup. The same first-principles scan found additional performance risks in paths that grow with local log count, usage row count, bucket count, device count, backup count, and runtime log size.

This document is for engineering review. It records observed risks, code evidence, expected impact, and recommended remediation order. It does not claim every item is currently user-visible; the focus is scalability risk before data volume grows further.

## Success Criteria

- Reset and first tracking should return control to the user quickly instead of blocking on full scan or full sync.
- Normal desktop navigation should not repeatedly regroup and rerender all usage rows when only one view is visible.
- Collector scans should avoid reparsing unchanged sources and avoid large whole-file cache serialization in the hot path.
- Sync should scale by changed bucket count without one HTTP request and one manifest write per bucket.
- Backend API paths should avoid full-table in-memory scans or full JSON database rewrites for routine writes.
- Admin pages should avoid hidden extra heavy requests and large unpaginated DOM rendering.

## Evidence Snapshot

Local machine evidence from the review:

- Codex local JSONL files: 501.
- Claude Code local JSONL files: 356.
- `~/.ai-token-league/source-index-cache.json`: 82 MB.
- `~/.ai-token-league/usage-cache.json`: 680 KB.
- `data/db.json`: 946 KB.
- CLI scan cold-ish path: about 9.81 seconds, including 0.36 seconds of dev build overhead.
- Desktop runtime log showed one foreground sync of 648 buckets taking 61.873 seconds.

## Priority Summary

| Priority | Area | Risk | Recommended Direction |
| --- | --- | --- | --- |
| P0 | Reset / first tracking | Full scan and full sync run in foreground | Decouple UX completion from scan/sync; make scan truly async |
| P0 | Sync | Serial bucket HTTP uploads and per-bucket manifest writes | Batch or bounded-concurrent upload; save manifest once per run |
| P0 | Collector cache | 82 MB whole-file source index read/write | Use per-source cache files or SQLite/kv store |
| P1 | JSON store | Every write rewrites full `db.json` | Move production writes to incremental store; limit JSON store scope |
| P1 | MySQL store | Full-table load into memory on startup and some failures | Query/aggregate in SQL; avoid full reload for error recovery |
| P1 | Admin page | Usage load always triggers quality load | Lazy-load quality only when quality tab is active |
| P1 | Usage upsert | Legacy `upsertUsageBatch` dedup loops are O(N×M) against full `usageDaily` | Deprecate legacy path or add secondary index |
| P1 | Aggregate cache | `cachedAggregate` triggers full `db.json` rewrite on every cache miss | Do not persist aggregate cache inside `db.json` |
| P2 | Desktop renderer | Repeated full grouping/rendering of `allUsage` | Memoize derived data by scan fingerprint and render active surfaces only |
| P2 | Pricing | Price changes recalculate all rows | Recalculate only affected models or do async background job |
| P2 | Aggregate cache key | SHA-256 hash per cache lookup | Use simple deterministic string key |
| P2 | Hourly derivation | `deriveDailyFromHourly` scans full hourly and daily tables per bucket | Secondary map by bucket scope |
| P2 | Delete operations | `deleteParticipantData` / `deleteDeviceData` scan 7-8 full tables | Secondary maps by participant and device |
| P2 | Board summary | `boardSummary` computes 6 full leaderboards on every call | Single-pass multi-range aggregate or staggered cache |
| P3 | Diagnostics / backups | Reads large logs/cache/backups fully | Export summaries by default; cap logs; use file metadata or manifest |
| P3 | Price map | `priceMap()` recreated on every call, never memoized | Memoize and invalidate on pricing mutations |
| P3 | API responses | `sendJson` pretty-prints all JSON responses | Use compact JSON; pretty-print only in dev mode |

## Detailed Findings

### P0. Reset And First Tracking Block On Full Scan

**Source of truth**

- `src/desktop/renderer.js`
  - `finishWizard()` calls `await loadToday(true)`.
  - `resetLocalOnly()` and `resetWithCloud()` call `await boot()`, and `boot()` starts `loadToday()`.
- `atl-collector/src/sidecar.rs`
  - `usage:scan-start` calls `usage_snapshot(&cfg, force).await` before returning.

**Why it is slow**

The UI command named `startUsageScan` is not actually starting a background scan. It blocks until the snapshot is complete. After reset, local cache files are deleted, so the next scan becomes a full parse path. If cloud sync is configured, the UI then starts foreground sync.

**Impact**

Reset and onboarding feel slow even if the reset itself is fast. The user sees one operation, but the implementation performs reset, config boot, local scan, cache write, render, and optional sync.

**Recommendation**

- Return from reset/onboarding immediately after config mutation.
- Show an empty or "scan pending" state.
- Start scan in background and expose real status through `usage:scan-status`.
- Do not auto-start foreground sync from first render; offer explicit sync or background queue.

### P0. Sync Upload Is Serial By Bucket

**Source of truth**

- `collector-core/src/sync.rs`
  - `sync_usage()` groups items by bucket.
  - It loops over every bucket and sends `POST /api/usage/daily-batch` sequentially.
  - It calls `save_sync_manifest_for()` after each accepted bucket.

**Why it is slow**

Total time is roughly the sum of all bucket request round trips plus server writes plus local manifest writes. A 648-bucket run took 61.873 seconds in observed runtime logs.

**Impact**

First sync, cloud reset recovery, and any large backlog are slow. Slow or flaky networks amplify the problem. The local sidecar also stays occupied by one long-running command.

**Recommendation**

- Add a batch upload endpoint that accepts multiple bucket snapshots in one signed request, or use bounded concurrency against the existing endpoint.
- Save sync manifest once at the end of a successful run or in coarse batches.
- Keep queue semantics, but drain queue with bounded concurrency and backoff.

### P0. Source Index Cache Is A Large Whole-File JSON Hot Path

**Source of truth**

- `atl-collector/src/sidecar.rs`
  - `read_source_index_cache()` reads and parses the whole source index cache.
  - `write_source_index_cache()` serializes and writes the whole source index cache.
- `collector-core/src/config.rs`
  - `reset_local_data()` deletes `source-index-cache.json`.

**Why it is slow**

The cache is already 82 MB on the reviewed machine. Even when source parsing is skipped, the cache itself has non-trivial read, parse, clone, stringify, and write cost. Reset removes this cache, forcing the next scan back to full source parsing.

**Impact**

Scan cost grows with historical source count and event density. Reset makes the worst path more likely.

**Recommendation**

- Replace monolithic JSON with per-source cache entries, SQLite, sled, or another small key-value store.
- Keep source metadata and parsed aggregate rows separately.
- On reset, distinguish "identity/data reset" from "scan cache reset"; do not delete source parse cache unless the user asks for a deep local cleanup.

### P1. JSON Store Rewrites The Full Database On Routine Writes

**Source of truth**

- `src/backend/store.js`
  - `save()` writes `JSON.stringify(this.db, null, 2)` to `db.json`.
  - `registerDevice()`, `upsertUsageBatch()`, delete operations, aggregate cache writes, pricing changes, and recalculation all call `save()`.

**Why it is slow**

The write cost is proportional to total database size, not the changed row count. The JSON store also blocks the Node.js event loop while stringifying and writing.

**Impact**

Works for small local/dev storage. Becomes a bottleneck for multi-user server use, especially with frequent bucket uploads or admin actions.

**Recommendation**

- Keep JSON store as dev/local mode only, or add append-only/incremental persistence.
- Avoid saving aggregate cache into the same full JSON file on read-path cache misses.
- For production, prefer MySQL paths that do not reload or mirror full tables in memory.

### P1. MySQL Store Mirrors Full Tables In Memory

**Source of truth**

- `src/backend/mysql-store.js`
  - `load()` runs `SELECT *` across all major tables.
  - Some write failure paths call `await this.load()`.
  - `upsertUsageBatch()` still mutates the inherited in-memory `Store` before syncing to MySQL.

**Why it is slow**

MySQL is used as durable storage, but the implementation still keeps a full JSON-store-shaped copy in memory. This makes startup and failure recovery proportional to total table size.

**Impact**

Startup latency and memory use grow with `usage_daily`, `usage_hourly`, upload batches, and sync metadata. Failure recovery can become more expensive than the failed operation.

**Recommendation**

- Move leaderboard, admin usage, detail, quality, and sync-state reads to SQL queries.
- Limit in-memory state to small config/pricing metadata or request-local data.
- Replace full `load()` rollback with transaction-local failure handling and targeted reloads.

### P1. Admin Usage Load Always Loads Quality Data

**Source of truth**

- `src/web/admin.js`
  - `loadUsage()` fetches `/api/admin/usage`, renders usage, then always calls `await loadQuality()`.
- `src/backend/server.js`
  - `/api/admin/usage` calls `store.adminUsage()`.
  - `/api/admin/quality` calls `store.adminQuality()`.
- `src/backend/store.js`
  - Both paths scan and aggregate usage rows for the selected range.

**Why it is slow**

Opening or changing usage filters performs two independent backend aggregations even when the quality panel is not the active decision surface.

**Impact**

Admin page interactions become slow as usage rows grow. Pricing and delete actions also chain reloads of usage, pricing, devices, and quality.

**Recommendation**

- Load quality only when the quality tab is active.
- Cache quality results by range and participant until usage data changes.
- Consider server-side pagination or summaries for admin usage rows.

### P2. Backend Aggregation Scans Full In-Memory Usage Rows

**Source of truth**

- `src/backend/store.js`
  - `computePublicLeaderboard()` filters `Object.values(this.db.usageDaily)`.
  - `participantDetail()` filters all rows for one participant and range.
  - `computeAdminUsage()` filters all rows.
  - `adminQuality()` filters all rows and then does additional per-row cost coverage computation.

**Why it is slow**

Every query starts by materializing all usage rows into an array and filtering in JavaScript. In MySQL mode, this still happens against the in-memory mirror rather than SQL indexes.

**Impact**

Leaderboard and admin APIs scale with total historical rows instead of the requested range. Custom ranges and detail views amplify this.

**Recommendation**

- Add indexes by day, participant, provider, and device in the storage layer.
- For MySQL, implement SQL aggregate queries for public board, admin board, participant detail, and quality.
- For JSON mode, maintain secondary maps keyed by day and participant.

### P2. Desktop Renderer Recomputes Multiple Full Aggregations Per Snapshot

**Source of truth**

- `src/desktop/renderer.js`
  - `applyUsageSnapshot()` sets `allUsage`, then calls `renderToday()`, `renderWorkdirs()`, `renderHealth()`, `renderAliases()`, and `renderRailStatus()`.
  - `renderToday()`, `renderWorkdirs()`, `renderTrend()`, `groupTrend()`, and `groupWorkdirDetails()` repeatedly filter/group/sort over `allUsage`.

**Why it is slow**

One scan result causes several independent full-pass aggregations and DOM rewrites, including surfaces that may not be visible.

**Impact**

Current row count is manageable, but tens of thousands of rows can make scan completion or tab changes feel frozen.

**Recommendation**

- Build derived indexes once per snapshot fingerprint.
- Render only the active section and cheap rail metadata immediately.
- Defer offscreen sections until selected.
- Add row limits or virtualization for detailed tables.

### P2. Pricing Changes Recalculate All Usage Rows

**Source of truth**

- `src/backend/store.js`
  - `recalculateCosts()` loops over all `usageDaily`.
  - `upsertModelPrice()`, `deleteModelPrice()`, `upsertModelPriceAlias()`, and `deleteModelPriceAlias()` call full recalculation.
- `src/backend/mysql-store.js`
  - MySQL variants may call `syncAllTables()` after pricing changes.

**Why it is slow**

Changing one model price can recalculate every usage row and then sync large tables.

**Impact**

Admin pricing work can block the server as usage rows grow.

**Recommendation**

- Recalculate only rows whose model or alias target changed.
- Run full recalculation as an explicit background maintenance job.
- In MySQL, update affected rows with SQL where possible.

### P3. Diagnostics Export Can Become Very Large

**Source of truth**

- `collector-core/src/diagnostics.rs`
  - `export_diagnostics()` reads full usage cache, full sync manifest, queue summary, and runtime log with `usize::MAX`.

**Why it is slow**

Diagnostics export is meant to help when the system is already unhealthy, but it can load and serialize large files in one command.

**Impact**

Export can hang or produce an unwieldy file when logs or cache are large.

**Recommendation**

- Cap runtime log entries by default.
- Export usage cache summary by default.
- Add an explicit "include full local cache" mode for deep debugging.

### P3. Backup Status Reads Every Backup File

**Source of truth**

- `collector-core/src/local_backup.rs`
  - `backup_status()` calls `list_backups_in_dir()`.
  - `list_backups_in_dir()` reads and parses every backup file to get `createdAt`.

**Why it is slow**

Settings page status can become proportional to backup count and backup file size.

**Impact**

Low risk today due to retention, but visible if a user points backup directory to a folder with many retained backups.

**Recommendation**

- Use filename or filesystem metadata for list view.
- Parse backup JSON only when restoring or inspecting one selected backup.
- Optionally maintain a small backup manifest.

### P1. Legacy Usage Upsert Dedup Loops Are O(N×M)

**Source of truth**

- `src/backend/store.js`
  - `upsertUsageBatch()` (non-snapshot path) contains two inner loops that scan all `usageDaily` entries per incoming item.
  - Lines 262-277: sourceFingerprint dedup iterates `Object.entries(this.db.usageDaily)` per item.
  - Lines 278-293: Cursor workdir dedup iterates `Object.entries(this.db.usageDaily)` per item.

**Why it is slow**

If a batch has N incoming items and `usageDaily` has M entries, the two dedup loops perform roughly 2×N×M comparisons. With 100 items and 10,000 stored rows, this is about 2 million comparisons per batch. The snapshot batch paths do not have this problem because they scope deletes by bucket.

**Impact**

Legacy (non-snapshot) uploads become progressively slower as the database grows. This path is still reachable by older clients or non-snapshot payloads.

**Recommendation**

- Deprecate the legacy path and migrate all clients to snapshot mode.
- If the legacy path must remain, build a secondary index keyed by `(day, participantId, deviceId, toolCode, providerId, workdirHash, model)` to avoid full-table scans.

### P1. Aggregate Cache Triggers Full db.json Rewrite On Miss

**Source of truth**

- `src/backend/store.js`
  - `cachedAggregate()` stores results in `this.db.aggregateCache` and calls `this.save()` on every cache miss.
  - `save()` writes the entire `this.db` object to disk with `JSON.stringify(this.db, null, 2)` and `fs.writeFileSync`.
  - `boardSummary()` calls `publicLeaderboard()` for 6 different ranges, each potentially a separate cache miss.

**Why it is slow**

The aggregate cache is stored inside `db.json` itself, so cached results inflate the file that must be rewritten. On a cold start or after any write that invalidates the cache, `boardSummary` can trigger 6 full `db.json` writes in sequence. Each write includes all usage rows, all pricing data, and all previously cached aggregates.

**Impact**

First page load after server restart or after any usage upload causes multiple expensive full-file rewrites. The aggregate cache data itself grows the file, creating a feedback loop.

**Recommendation**

- Do not persist aggregate cache to `db.json`. It is a pure computed cache that can be regenerated on demand.
- If persistence is desired, write it to a separate lightweight file.
- Remove the `this.save()` call from `cachedAggregate()`.

### P2. Aggregate Cache Key Uses SHA-256 Hash

**Source of truth**

- `src/backend/store.js`
  - `cachedAggregate()` computes `sha256Hex(JSON.stringify({ name, args: cacheArgs, schemaVersion }))` on every call, even cache hits.

**Why it is slow**

SHA-256 plus `JSON.stringify` for key computation is significantly more expensive than a simple string concatenation. This runs on every leaderboard, board summary, and admin usage API request.

**Impact**

Low per-call overhead but measurable under load, especially when `boardSummary` triggers 6 lookups.

**Recommendation**

- Use a deterministic string key like `${name}|${JSON.stringify(cacheArgs)}` instead of SHA-256.

### P2. deriveDailyFromHourly Scans Full Hourly And Daily Tables

**Source of truth**

- `src/backend/store.js`
  - `deriveDailyFromHourly()` calls `Object.entries(this.db.usageHourly).filter(...)` to collect hourly rows for a specific bucket.
  - It then calls `Object.entries(this.db.usageDaily).filter(...)` to clean up stale derived rows.

**Why it is slow**

Both scans iterate over the entire hourly and daily row collections even though only one participant+device+day+provider bucket is relevant. This method is called per hourly bucket upload.

**Impact**

As hourly rows grow, each bucket upload becomes proportional to total row count rather than bucket row count.

**Recommendation**

- Build a secondary map keyed by `(participantId, deviceId, day, providerId)` for O(1) bucket lookup in both hourly and daily collections.

### P2. Delete Operations Scan 7-8 Full Tables

**Source of truth**

- `src/backend/store.js`
  - `deleteParticipantData()` iterates `Object.entries()` over `devices`, `workdirs`, `usageDaily`, `uploadBatches`, `usageSyncBuckets`, `usageHourly`, and `usageSyncBucketsHourly`.
  - `deleteDeviceData()` iterates `Object.entries()` over `usageDaily`, `uploadBatches`, `usageSyncBuckets`, `usageHourly`, and `usageSyncBucketsHourly`.

**Why it is slow**

All scans are sequential full-table iterations. Total work is proportional to the sum of all rows across all participants, not just the target participant.

**Impact**

Admin delete actions become slow as total data volume grows. Multiple sequential full scans compound the cost.

**Recommendation**

- Maintain secondary maps indexed by `participantId` and `deviceId` for O(1) scope lookup.
- For MySQL mode, the targeted SQL DELETEs already exist and are efficient; the bottleneck is the in-memory mirror scan.

### P2. Board Summary Computes 6 Full Leaderboards

**Source of truth**

- `src/backend/store.js`
  - `computeBoardSummary()` calls `this.publicLeaderboard()` six times with ranges: today, yesterday, this_week, last_week, this_month, last_month.
  - Each `publicLeaderboard` call filters all `usageDaily` rows.

**Why it is slow**

On cache invalidation (which happens on every write), all six leaderboards must recompute. The aggregate cache mitigates repeat calls, but after any usage upload the cache is invalidated and the next board summary request triggers 6 full scans plus 6 `db.json` writes (see aggregate cache finding).

**Impact**

Board summary API response time scales with 6× the cost of a single leaderboard query. Combined with the aggregate cache save issue, this creates a burst of heavy I/O after every data change.

**Recommendation**

- Compute all 6 ranges in a single pass over `usageDaily`.
- Or stagger cache invalidation so that board summary is refreshed lazily rather than on every write.

### P3. priceMap Is Recreated On Every Call

**Source of truth**

- `src/backend/store.js`
  - `priceMap()` calls `createPriceMap(this.db.modelPrices, this.db.modelPriceCache?.prices, this.db.modelPriceAliases)` on every invocation.
  - Called once per usage row during `upsertUsageBatch` and once per row during `recalculateCosts`.

**Why it is slow**

The price map merges custom prices, cached OpenRouter prices, and aliases into a new object on every call. The result does not change between calls within a single batch or recalculation.

**Impact**

Small per-call overhead but multiplied by row count. A 1000-row recalculation creates 1000 identical price maps.

**Recommendation**

- Memoize the price map and invalidate only when pricing data changes (model price upsert, delete, alias change, or OpenRouter refresh).

### P3. API Responses Are Pretty-Printed

**Source of truth**

- `src/backend/server.js`
  - `sendJson()` uses `JSON.stringify(body, null, 2)` for every API response.

**Why it is slow**

Pretty-printing adds whitespace characters that increase serialization time and response payload size. For leaderboard and admin usage responses with many rows, the overhead is measurable.

**Impact**

Low priority for most endpoints but noticeable on large admin usage or quality responses.

**Recommendation**

- Use compact `JSON.stringify(body)` for API responses.
- Pretty-print only in dev mode or for debug endpoints.

## Recommended Review Order

1. Confirm UX contract for reset and first tracking: should completion mean "config reset" or "all scan/sync finished".
2. Decide sync optimization shape: batch endpoint vs bounded concurrency on existing endpoint.
3. Decide collector cache backend: per-source JSON, SQLite, or kv.
4. Decide whether JSON store remains dev/local only or receives incremental persistence.
5. Split admin quality loading from usage loading.
6. Plan SQL-backed aggregation for MySQL mode.
7. Remove aggregate cache persistence from `db.json` and eliminate per-miss full saves.
8. Deprecate legacy upsert path or add secondary indexes for dedup loops.
9. Memoize `priceMap()` and simplify aggregate cache key computation.

## Confirmed Decisions And Implementation Notes

Confirmed on 2026-05-22:

- Local data reset means local config/cache reset and a fresh local reparse. It must not preserve parsed source cache.
- Cloud sync may continue in the background after reset/onboarding; foreground completion should not mean "all cloud buckets uploaded".
- JSON storage is a development and validation path only. Protocol and optimization choices should target the long-term production shape.
- Sync protocol changes are acceptable when they reduce chronic latency and preserve privacy boundaries.

Implemented in this pass:

- `usage:scan-start` now returns a running task status and performs the scan asynchronously.
- Desktop reset/onboarding returns after config mutation and starts scan/sync work in the background path.
- `usage:sync-start` starts cloud sync in the sidecar without blocking the renderer.
- Collector sync uploads dirty buckets through `/api/usage/daily-batches` in chunks, with fallback to the existing `/api/usage/daily-batch` endpoint.
- Sync manifest writes are deferred to the end of the run instead of after every accepted bucket.
- Source index cache is split by source fingerprint under `source-index-cache/`; reset deletes both the legacy monolithic file and the split cache directory.
- Aggregate cache is process-local only and no longer writes `db.json` on read-path cache misses.
- `boardSummary()` computes all public summary ranges in one pass.
- Legacy upload dedup uses transient secondary indexes instead of scanning all usage rows per incoming item.
- `priceMap()` is memoized and invalidated on pricing mutations; admin pricing recalculation targets affected models where possible.
- Admin quality data is lazy-loaded only when the quality tab is active.
- Diagnostics export summarizes usage cache and caps runtime log entries; backup status uses filename/metadata instead of parsing every backup JSON file.
- API JSON responses are compact by default; `API_PRETTY_JSON=true` restores pretty output for debugging.

Implemented in the follow-up pass on 2026-05-23:

- Local scan cache and local facts now have a SQLite backend at `~/.ai-token-league/usage-local.sqlite3`.
- Normal sidecar scan uses SQLite `source_cache` by fingerprint instead of preloading a monolithic source-index JSON file.
- Normal sidecar scan writes `usage_fact` rows into SQLite and exposes query commands: `usage:summary`, `usage:trend`, `usage:workdirs`, `usage:detail-page`, and `usage:detail-window`.
- Local reset deletes the SQLite DB plus WAL/SHM files, so reset cannot preserve parsed source cache and the next scan must reparse.
- SQLite `source_cache` now prunes fingerprints that disappeared from the latest source index and refreshes `lastSeenAt` on cache hits, preventing stale source-cache growth across repeated scans.
- JSON source-index files are retained only as a fallback when SQLite cannot open; successful SQLite scans remove the JSON source-index cache.
- MySQL startup no longer loads `usage_daily`, `usage_hourly`, upload batches, or sync bucket metadata into the in-memory `Store` mirror.
- MySQL bucket writes load only the current participant/day/provider scope before mutating inherited bucket logic, preserving idempotency without a production full-table mirror.
- Server read endpoints now await store reads, allowing MySQL to serve board, participant, admin, quality, and sync-state paths from request-scoped data instead of startup-resident usage tables.
- MySQL participant and device deletion now use SQL-first delete paths and SQL affected-row counts instead of depending on a resident full usage mirror.
- MySQL device deletion clears same-scope cloud hourly sync buckets so remaining cloud devices can reupload after one device is removed.
- MySQL custom model-price and alias mutations now load and upsert only affected model usage rows instead of wiping and rewriting the full usage table.
- Server price warmup now awaits the async MySQL missing-price lookup, so the warmup decision does not accidentally treat a pending Promise as an empty model list.
- Desktop model detail tables now virtualize large row sets with fixed-height visible windows, keeping DOM row count bounded while scrolling.
- MySQL public leaderboard, legacy leaderboard, board summary, participant trend, admin usage, and missing-price model reads now aggregate in SQL and return only grouped result sets to JS.
- MySQL full price recalculation now processes `usage_daily` in bounded batches and upserts recalculated rows, so OpenRouter full refresh no longer requires a full resident usage mirror.
- Production MySQL indexes are ensured for device/day, daily bucket scope, and hourly bucket scope query paths.
- Desktop overview, trend, workdir, and alias surfaces now prefer local SQLite query commands and retain the compatibility `allUsage` renderer cache only below a bounded row threshold.

Still architectural follow-up:

- MySQL participant detail and admin quality still use inherited JS aggregation over request-scoped row windows because those responses include bounded diagnostic/detail payloads; the next production hardening step is SQL detail pagination plus dedicated quality summary queries.
- `deriveDailyFromHourly()` remains intentionally JSON-store scoped; JSON is a local/dev validation backend, while production MySQL uses SQL-backed hourly-to-daily scope sync.
- Desktop drill-down drawers still use the compatibility row cache when available; large datasets keep top-level surfaces bounded, and the next step is lazy SQLite detail queries per drawer.

## Long-Term Server And Client Optimization Design

### Design Goal

The final architecture should make routine memory and latency proportional to the active query surface, not to all historical local sources, all uploaded usage rows, or all rendered table rows.

Target invariants:

- Local reset deletes local config/cache/facts and forces reparse on the next scan.
- The server never receives prompts, responses, transcripts, real absolute paths, Cursor raw credentials, or private keys.
- Cloud sync may be automatic, but it must not block local readiness.
- JSON store remains a development/smoke validation backend only.
- Production server behavior must be SQL-first.
- Desktop UI must query summaries and windows of detail rows, not hold every historical usage row in renderer memory.

### Server-Side Final Design

Production MySQL should become the source of query truth instead of a persistence mirror for an in-memory `Store`.

Core changes:

- Split storage into repositories instead of inheriting the JSON-store-shaped full object:
  - `ParticipantRepository`
  - `DeviceRepository`
  - `UsageBucketRepository`
  - `UsageAggregateRepository`
  - `PricingRepository`
  - `SyncStateRepository`
- Keep snapshot/hourly bucket writes transactional and idempotent:
  - lock by bucket scope
  - upsert accepted rows
  - delete stale rows for that bucket scope
  - update sync bucket fingerprint
  - update materialized summaries for affected participant/day/provider/model scopes
- Replace startup full-table `load()` with targeted boot:
  - load small config/pricing metadata only
  - do not load `usage_daily`, `usage_hourly`, upload batches, or sync buckets into memory
  - do not reload all tables after write failure; rely on transaction rollback and targeted readback
- Move read APIs to SQL:
  - `/api/board/summary`: single SQL aggregate over relevant day ranges or materialized summary table
  - `/api/board/*`: SQL aggregate/detail queries by range
  - `/api/admin/usage`: SQL aggregate by grain and participant filter
  - `/api/admin/quality`: SQL aggregate plus bounded anomaly/detail queries
  - `/api/usage/sync-state`: indexed lookup by participant/device/day/hour/provider
- Use production indexes:
  - `usage_daily(day, participantId)`
  - `usage_daily(participantId, day)`
  - `usage_daily(deviceId, day)`
  - `usage_daily(providerId, day)`
  - `usage_daily(model, day)`
  - `usage_hourly(participantId, deviceId, day, hour, providerId)`
  - `usage_sync_buckets_hourly(participantId, deviceId, day, hour, providerId)`
- Add summary tables when raw aggregation becomes expensive:
  - `usage_daily_participant_summary`
  - `usage_daily_model_summary`
  - `usage_daily_provider_summary`
  - optional `usage_period_cache` for public board windows

Expected server-side result:

- Startup memory no longer grows with historical usage row count.
- Board/admin read latency grows with requested range and indexed result size, not full table size.
- Write recovery does not trigger full in-memory reload.
- JSON compatibility remains available for tests and local smoke only.

### Client-Side Final Design

The desktop client should move from a full-snapshot renderer model to a local fact/query model.

Core changes:

- Introduce a local SQLite database under `~/.ai-token-league/` for local facts and cache:
  - `source_cache(fingerprint, providerId, parserVersion, sourceSize, sourceMtimeMs, itemsJson, scannedAt, lastSeenAt)`
  - `usage_fact(day, hour, providerId, toolCode, workdirHash, model, token fields, sourceQuality, sourceFingerprint)`
  - `workdir_summary(...)`
  - optional `scan_manifest(...)`
- Change scan flow:
  - enumerate source metadata first
  - delete local facts/cache only on reset or source disappearance
  - lazily load cached source rows by fingerprint
  - parse only changed sources
  - upsert changed facts into SQLite
  - return scan status and summary, not all historical rows
- Replace renderer full snapshot with query commands:
  - `usage:summary`
  - `usage:trend`
  - `usage:workdirs`
  - `usage:detail-page`
  - `usage:detail-window`
  - `usage:scan-status`
  - `usage:sync-start`
- Keep `usage:scan-start` as a background mutation command.
- Keep cloud sync source as the local SQLite facts, grouped into signed bucket snapshots.

Expected client-side result:

- Source cache peak memory drops because scans no longer read and parse one monolithic cache file.
- Renderer memory drops because `allUsage` is no longer the long-term data boundary.
- UI latency depends on the active view query and rendered rows.

### Desktop Rendering Final Design

Virtualization should be the last layer, not the only layer.

Rendering pipeline:

1. Query only the active surface.
2. Build derived indexes only for returned rows, keyed by scan/query fingerprint.
3. Store indexes as row ids or array indexes, not copied row objects.
4. Render only the visible section.
5. Use virtualized fixed-height rows for large detail tables.
6. Release derived indexes and row windows when scan fingerprint or query range changes.

Recommended table behavior:

- Overview: summary query only.
- Workdirs: aggregate query plus top N rows by default.
- Trend: bucketed aggregate query.
- Detail: paged or windowed query aligned with virtual scroll.
- Expanded rows: fetch detail lazily when expanded.
- Offscreen tabs: no DOM creation and no heavy query until activated.

Memory rules:

- Keep one canonical copy of currently visible row data.
- Store derived maps as keys/indexes.
- Do not clone full row arrays for every tab or sort mode.
- Do not keep detached DOM rows after tab/range changes.
- Measure JS heap after repeated scan, tab switching, detail scroll, and reset cycles to catch leaks.

### Expected Memory Targets

These are planning targets and must be validated with synthetic and real local logs.

- Current monolithic source cache path: observed cache file is 82 MB; peak scan memory can plausibly reach 200-500 MB due to file string, parsed object graph, serialization, and intermediate arrays.
- Split/lazy source cache or SQLite source cache: target scan-cache peak 20-80 MB.
- SQLite local facts plus renderer query APIs: target normal desktop usage data heap 5-30 MB for overview/workdir/trend surfaces.
- Virtualized detail tables: target DOM-related memory 5-20 MB, independent of total historical row count.
- Full desktop stress target: normal views under 100 MB JS heap; extreme detail scrolling under 150 MB; no monotonic growth after repeated scan/reset/tab cycles.

### Rollout Plan

Phase 1: Stabilize Current 0.7.x Path

- Keep current split source-cache files.
- Keep `/api/usage/daily-batches` and single-bucket fallback.
- Keep aggregate cache process-local.
- Add performance telemetry around scan duration, source cache read/write, sync bucket counts, renderer row counts, and heap snapshots where available.

Phase 2: Add Client SQLite Cache Backend

- Add a local cache abstraction behind the collector.
- Implement SQLite `source_cache` first.
- Preserve reset semantics by deleting the SQLite database or clearing all local cache/fact tables.
- Keep renderer API compatible during migration.
- Verify cache hit rate, cold scan, warm scan, and reset reparse behavior.

Phase 3: Move Desktop To Local Query APIs

- Add local SQLite `usage_fact` writes after scan.
- Add summary/trend/workdir/detail query commands.
- Stop returning all rows from routine `usage:scan-start`.
- Convert renderer surfaces one by one from `allUsage` to query results.
- Add virtualized detail table after detail queries are windowed.

Phase 4: Make Server MySQL SQL-First

- Introduce repository classes and SQL-backed read APIs.
- Remove production dependence on full `Store.load()` usage mirrors.
- Add summary tables if raw SQL aggregation is not enough at target scale.
- Keep JSON Store tests as protocol/behavior fixtures, not production performance proof.

Phase 5: Scale Verification Gate

- Generate 100k, 500k, and 1M local fact rows.
- Measure cold scan, warm scan, reset reparse, overview load, workdir load, trend load, detail scroll, cloud sync backlog, and admin usage/quality.
- Fail the gate on unbounded memory growth, long main-thread stalls, or server startup memory proportional to total usage rows.

### Verification Matrix

| Surface | Verification |
| --- | --- |
| Local reset | Reset removes SQLite cache/fact DB or all local cache/fact tables; next scan reparses sources. |
| Warm scan | Unchanged sources are loaded by fingerprint without full-cache preloading. |
| Cloud sync | Dirty buckets are signed and uploaded from local facts; foreground UI remains responsive. |
| Desktop overview | Loads from summary query without materializing all facts. |
| Desktop detail | Virtual scroll keeps DOM row count bounded while scrolling through large result sets. |
| Server startup | MySQL mode starts without loading `usage_daily` / `usage_hourly` into memory. |
| Server board/admin reads | SQL query plans use day/participant/provider/model indexes. |
| Leak check | Repeated scan/reset/tab/detail cycles do not show monotonic JS heap or RSS growth. |

## Closed Questions

- Should "reset local data" preserve local source parse cache by default? No. Reset must delete source parse cache and force reparse.
- Should first tracking auto-sync to cloud immediately, or should it only prepare local data and let background sync proceed? It may start sync automatically, but the work must run in the background and must not block local readiness.
- Is JSON store expected to support production data volume, or only local/dev smoke usage? JSON is only for local development and early validation.
- What target scale should the product optimize for in 0.7.x? Optimize protocol and production paths for long-term stable operation; do not constrain design to the temporary JSON path.
- Is a protocol change acceptable for sync batching, or should optimization stay client-only with bounded concurrency? Protocol change is acceptable; batch upload is the preferred shape.
