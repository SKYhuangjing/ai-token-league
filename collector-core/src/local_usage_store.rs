use crate::config;
use crate::scanner::SourceCache;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

const DB_SCHEMA_VERSION: i64 = 2;

pub struct LocalUsageStore {
    conn: Connection,
}

impl LocalUsageStore {
    pub fn open_default() -> Result<Self, String> {
        Self::open(config::local_usage_db_path())
    }

    pub fn open(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        let mut store = Self { conn };
        store.init()?;
        Ok(store)
    }

    /// Read-only handle for query-only callers (CLI usage/status): must not
    /// create the file or write schema/meta rows, so it never contends with
    /// sidecar writes and leaves the file bytes untouched.
    pub fn open_readonly_default() -> Result<Self, String> {
        let path = config::local_usage_db_path();
        if !path.exists() {
            return Err(format!("not found: {}", path.display()));
        }
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| e.to_string())?;
        Ok(Self { conn })
    }

    fn init(&mut self) -> Result<(), String> {
        self.conn
            .execute_batch(
                r#"
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;
                PRAGMA temp_store = MEMORY;

                CREATE TABLE IF NOT EXISTS meta (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS source_cache (
                  fingerprint TEXT PRIMARY KEY,
                  providerId TEXT NOT NULL DEFAULT '',
                  parserVersion TEXT NOT NULL DEFAULT '',
                  sourceSize INTEGER NOT NULL DEFAULT 0,
                  sourceMtimeMs INTEGER NOT NULL DEFAULT 0,
                  itemsJson TEXT NOT NULL,
                  scannedAt TEXT NOT NULL,
                  lastSeenAt TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS usage_fact (
                  usageKey TEXT PRIMARY KEY,
                  day TEXT NOT NULL,
                  hour INTEGER NOT NULL,
                  toolCode TEXT NOT NULL,
                  providerId TEXT NOT NULL,
                  workdirHash TEXT NOT NULL,
                  workdirDisplayName TEXT NOT NULL,
                  model TEXT NOT NULL,
                  inputTokens INTEGER NOT NULL DEFAULT 0,
                  outputTokens INTEGER NOT NULL DEFAULT 0,
                  cacheReadTokens INTEGER NOT NULL DEFAULT 0,
                  cacheWriteTokens INTEGER NOT NULL DEFAULT 0,
                  reasoningTokens INTEGER NOT NULL DEFAULT 0,
                  totalTokens INTEGER NOT NULL DEFAULT 0,
                  sourceQuality TEXT NOT NULL DEFAULT 'unknown',
                  rawSourceRef TEXT NOT NULL DEFAULT '',
                  providerVersion TEXT NOT NULL DEFAULT '',
                  parserVersion TEXT NOT NULL DEFAULT '',
                  sourceFingerprint TEXT NOT NULL DEFAULT '',
                  scannedAt TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_usage_fact_day ON usage_fact(day);
                CREATE INDEX IF NOT EXISTS idx_usage_fact_provider_day ON usage_fact(providerId, day);
                CREATE INDEX IF NOT EXISTS idx_usage_fact_workdir_day ON usage_fact(workdirHash, day);
                CREATE INDEX IF NOT EXISTS idx_usage_fact_model_day ON usage_fact(model, day);
                CREATE INDEX IF NOT EXISTS idx_usage_fact_day_hour ON usage_fact(day, hour);

                -- ZCode removes individual requests from its source database.
                -- These local-only facts survive that retention policy.
                -- day/hour/requestHash exist so scans can skip unchanged
                -- requests and recompute aggregates per (day, hour) scope
                -- instead of rebuilding the whole ledger.
                CREATE TABLE IF NOT EXISTS zcode_request_fact (
                  requestId TEXT PRIMARY KEY,
                  day TEXT,
                  hour INTEGER,
                  requestHash TEXT,
                  itemJson TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS zcode_legacy_residual (
                  usageKey TEXT PRIMARY KEY,
                  itemJson TEXT NOT NULL
                );
                "#,
            )
            .map_err(|e| e.to_string())?;
        self.migrate_zcode_request_columns()?;
        self.conn
            .execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('schemaVersion', ?)",
                params![DB_SCHEMA_VERSION.to_string()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// v1 → v2: add day/hour/requestHash to zcode_request_fact (existing
    /// installs) and backfill them once from the stored itemJson.
    fn migrate_zcode_request_columns(&mut self) -> Result<(), String> {
        let mut has_day = false;
        let mut has_hour = false;
        let mut has_hash = false;
        {
            let mut stmt = self
                .conn
                .prepare("PRAGMA table_info(zcode_request_fact)")
                .map_err(|e| e.to_string())?;
            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let name: String = row.get(1).map_err(|e| e.to_string())?;
                match name.as_str() {
                    "day" => has_day = true,
                    "hour" => has_hour = true,
                    "requestHash" => has_hash = true,
                    _ => {}
                }
            }
        }
        if !has_day {
            self.conn
                .execute("ALTER TABLE zcode_request_fact ADD COLUMN day TEXT", [])
                .map_err(|e| e.to_string())?;
        }
        if !has_hour {
            self.conn
                .execute("ALTER TABLE zcode_request_fact ADD COLUMN hour INTEGER", [])
                .map_err(|e| e.to_string())?;
        }
        if !has_hash {
            self.conn
                .execute(
                    "ALTER TABLE zcode_request_fact ADD COLUMN requestHash TEXT",
                    [],
                )
                .map_err(|e| e.to_string())?;
        }
        // Created here (not in the schema batch) so it also works on v1
        // databases where the columns only exist after the ALTERs above.
        self.conn
            .execute(
                "CREATE INDEX IF NOT EXISTS idx_zcode_request_scope
                 ON zcode_request_fact(day, hour)",
                [],
            )
            .map_err(|e| e.to_string())?;
        if has_day && has_hour && has_hash {
            return Ok(());
        }
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx
                .prepare(
                    "SELECT requestId, itemJson FROM zcode_request_fact
                     WHERE day IS NULL OR hour IS NULL OR requestHash IS NULL",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            let pending = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            drop(stmt);
            let mut update = tx
                .prepare(
                    "UPDATE zcode_request_fact SET day = ?1, hour = ?2, requestHash = ?3
                     WHERE requestId = ?4",
                )
                .map_err(|e| e.to_string())?;
            for (id, text) in pending {
                let Ok(item) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                let hash = crate::crypto::sha256_hex(&text);
                update
                    .execute(params![
                        str_field(&item, "day"),
                        i64_field(&item, "hour"),
                        hash,
                        id
                    ])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn replace_source_cache(
        &mut self,
        source_index: &HashMap<String, Vec<Value>>,
        scanned_at: &str,
    ) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let keep = source_index
            .keys()
            .filter(|fingerprint| !fingerprint.trim().is_empty())
            .cloned()
            .collect::<Vec<_>>();
        if keep.is_empty() {
            tx.execute("DELETE FROM source_cache", [])
                .map_err(|e| e.to_string())?;
        } else {
            tx.execute(
                &format!(
                    "DELETE FROM source_cache WHERE fingerprint NOT IN ({})",
                    keep.iter().map(|_| "?").collect::<Vec<_>>().join(",")
                ),
                rusqlite::params_from_iter(keep.iter()),
            )
            .map_err(|e| e.to_string())?;
        }
        // Skip fingerprints already stored: the scanner served those items
        // from this very row (identical content), and rewriting every
        // multi-KB blob on every scan dominated scan cost. scannedAt /
        // lastSeenAt on kept rows stay at first-write values — nothing reads
        // them for behavior.
        let existing: std::collections::HashSet<String> = {
            let mut stmt = tx
                .prepare("SELECT fingerprint FROM source_cache")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|row| row.ok()).collect()
        };
        {
            let mut stmt = tx
                .prepare(
                    r#"
                    INSERT INTO source_cache
                      (fingerprint, itemsJson, scannedAt, lastSeenAt)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(fingerprint) DO UPDATE SET
                      itemsJson = excluded.itemsJson,
                      scannedAt = excluded.scannedAt,
                      lastSeenAt = excluded.lastSeenAt
                    "#,
                )
                .map_err(|e| e.to_string())?;
            for (fingerprint, items) in source_index {
                if fingerprint.trim().is_empty() {
                    continue;
                }
                if existing.contains(fingerprint) {
                    continue;
                }
                let text = serde_json::to_string(items).map_err(|e| e.to_string())?;
                stmt.execute(params![fingerprint, text, scanned_at, scanned_at])
                    .map_err(|e| e.to_string())?;
            }
        }
        // Merge-completion stamp: its presence tells the next scan that the
        // fingerprints currently in source_cache were fully merged into
        // usage_fact, so unchanged scopes can be skipped safely. Set via
        // `mark_incremental_merge_ready` AFTER a completed merge + cache
        // write; a crash in between leaves it unset and the next scan falls
        // back to one full merge. Stores written by older builds start
        // unstamped for the same reason.
        tx.commit().map_err(|e| e.to_string())
    }

    /// Record that the current source_cache contents are fully merged (see
    /// `replace_source_cache`). Callers must merge BEFORE refreshing the
    /// cache and mark only after both succeeded.
    pub fn mark_incremental_merge_ready(&mut self) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('incrementalMergeReady', '1')",
                [],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn source_cache_fingerprints(&self) -> Result<std::collections::HashSet<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT fingerprint FROM source_cache")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|row| row.ok()).collect())
    }

    /// Whether a previous scan completed a stamped merge (see
    /// `replace_source_cache`). Until then, scans must treat every scope as
    /// dirty.
    pub fn incremental_merge_ready(&self) -> bool {
        self.conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'incrementalMergeReady'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map(|value| value.is_some())
            .unwrap_or(false)
    }

    /// (day, hour, providerId) scopes touched by sources whose fingerprint
    /// is new since the last merged scan. `None` means "not safe to
    /// incrementalize" — the caller must rewrite every scope.
    pub fn dirty_scopes_for_scan(
        &self,
        source_index: &HashMap<String, Vec<Value>>,
    ) -> Result<Option<std::collections::BTreeSet<UsageScope>>, String> {
        if !self.incremental_merge_ready() {
            return Ok(None);
        }
        let existing = self.source_cache_fingerprints()?;
        let mut dirty = std::collections::BTreeSet::new();
        for (fingerprint, items) in source_index {
            if fingerprint.trim().is_empty() || existing.contains(fingerprint) {
                continue;
            }
            for item in items {
                dirty.insert(item_scope(item));
            }
        }
        Ok(Some(dirty))
    }

    pub fn clear_source_cache(&mut self) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM source_cache", [])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Merge a fresh scan into the local usage ledger.
    ///
    /// Scopes (day, hour, providerId) present in the scan replace their local
    /// rows, so re-attribution inside active scopes still self-heals. Scopes
    /// absent from the scan are preserved: upstream sources may prune their own
    /// history (e.g. ZCode keeps only ~30 days of `model_usage`) and this store
    /// is the durable ledger, so vanished-from-source must never mean
    /// vanished-from-local.
    pub fn merge_usage_facts(&mut self, items: &[Value], scanned_at: &str) -> Result<(), String> {
        let scopes = item_scopes(items);
        self.merge_usage_facts_scoped(items, &scopes, scanned_at)
    }

    /// Incremental merge: rewrite only the (day, hour, providerId) scopes
    /// whose sources changed since the last merged scan. Scopes that only
    /// cache-hit sources contribute keep their existing rows — identical
    /// content by the fingerprint invariant stamped in
    /// `replace_source_cache`. Scopes absent from the scan stay preserved
    /// exactly as in the full merge.
    pub fn merge_usage_facts_scoped(
        &mut self,
        items: &[Value],
        dirty_scopes: &std::collections::BTreeSet<UsageScope>,
        scanned_at: &str,
    ) -> Result<(), String> {
        let scan_scopes = item_scopes(items);

        let preserved = self.preserved_scope_stats(&scan_scopes)?;

        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut delete_stmt = tx
                .prepare("DELETE FROM usage_fact WHERE day = ? AND hour = ? AND providerId = ?")
                .map_err(|e| e.to_string())?;
            for (day, hour, provider) in dirty_scopes {
                delete_stmt
                    .execute(params![day, hour, provider])
                    .map_err(|e| e.to_string())?;
            }
        }
        {
            let mut stmt = tx
                .prepare(
                    r#"
                    INSERT INTO usage_fact
                      (usageKey, day, hour, toolCode, providerId, workdirHash, workdirDisplayName,
                       model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                       reasoningTokens, totalTokens, sourceQuality, rawSourceRef, providerVersion,
                       parserVersion, sourceFingerprint, scannedAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    "#,
                )
                .map_err(|e| e.to_string())?;
            for item in items {
                if !dirty_scopes.contains(&item_scope(item)) {
                    continue;
                }
                stmt.execute(params![
                    usage_key(item),
                    str_field(item, "day"),
                    i64_field(item, "hour"),
                    str_field(item, "toolCode"),
                    str_field(item, "providerId"),
                    str_field(item, "workdirHash"),
                    str_field(item, "workdirDisplayName"),
                    str_field(item, "model"),
                    i64_field(item, "inputTokens"),
                    i64_field(item, "outputTokens"),
                    i64_field(item, "cacheReadTokens"),
                    i64_field(item, "cacheWriteTokens"),
                    i64_field(item, "reasoningTokens"),
                    i64_field(item, "totalTokens"),
                    str_field(item, "sourceQuality"),
                    str_field(item, "rawSourceRef"),
                    str_field(item, "providerVersion"),
                    str_field(item, "parserVersion"),
                    str_field(item, "sourceFingerprint"),
                    scanned_at,
                ])
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;

        self.note_preserved_scopes(preserved);
        Ok(())
    }

    /// Other providers still use the aggregate merge. ZCode is rebuilt from
    /// its request ledger, so a source-side deletion can never replace it.
    pub fn merge_non_zcode_facts(&mut self, items: &[Value], scanned_at: &str) -> Result<(), String> {
        let non_zcode = items.iter().filter(|item| str_field(item, "providerId") != "zcode_local")
            .cloned().collect::<Vec<_>>();
        self.merge_usage_facts(&non_zcode, scanned_at)
    }

    /// Scoped variant of `merge_non_zcode_facts` — see
    /// `merge_usage_facts_scoped`. ZCode scopes are filtered out of the
    /// dirty set: they are owned by the request-ledger rebuild, and the
    /// zcode source fingerprint is file-level (one changed day marks every
    /// day of that source dirty), so deleting them here would erase history
    /// that only a full ledger rebuild used to restore.
    pub fn merge_non_zcode_facts_scoped(
        &mut self,
        items: &[Value],
        dirty_scopes: &std::collections::BTreeSet<UsageScope>,
        scanned_at: &str,
    ) -> Result<(), String> {
        let non_zcode_dirty = dirty_scopes
            .iter()
            .filter(|(_, _, provider)| provider != "zcode_local")
            .cloned()
            .collect::<std::collections::BTreeSet<UsageScope>>();
        let non_zcode = items.iter().filter(|item| str_field(item, "providerId") != "zcode_local")
            .cloned().collect::<Vec<_>>();
        self.merge_usage_facts_scoped(&non_zcode, &non_zcode_dirty, scanned_at)
    }

    /// Upsert observed requests without deleting requests absent from a scan.
    /// On the first run, split existing aggregate rows into live requests and
    /// a residual for requests already pruned from ZCode's database.
    ///
    /// After initialization this is incremental: requests whose content hash
    /// is unchanged are skipped entirely, and only the (day, hour) scopes
    /// touched by changed requests are recomputed in usage_fact. The full
    /// ledger rebuild used to re-parse and re-insert every request row (tens
    /// of thousands on long-lived installs) on every scan.
    pub fn ingest_zcode_requests(&mut self, requests: &[Value], scanned_at: &str) -> Result<(), String> {
        let initialized = self.conn.query_row(
            "SELECT value FROM meta WHERE key = 'zcodeRequestLedgerInitialized'", [],
            |row| row.get::<_, String>(0),
        ).optional().map_err(|e| e.to_string())?.is_some();
        if !initialized {
            return self.ingest_zcode_requests_initial(requests, scanned_at);
        }
        let parsed = parse_zcode_requests(requests)?;
        let existing: HashMap<String, String> = {
            let mut stmt = self.conn
                .prepare("SELECT requestId, requestHash FROM zcode_request_fact")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .map_err(|e| e.to_string())?;
            rows.filter_map(|row| row.ok())
                .filter_map(|(id, hash)| hash.map(|hash| (id, hash)))
                .collect()
        };
        let changed: Vec<&ParsedZcodeRequest> = parsed
            .iter()
            .filter(|request| existing.get(&request.id) != Some(&request.hash))
            .collect();
        // Self-heal: request-ledger scopes that lost their usage_fact rows
        // (interrupted or buggy run) recompute even when no request content
        // changed. Computed before the early return so a quiet scan still
        // repairs a damaged ledger.
        let missing_scopes: std::collections::BTreeSet<(String, i64)> = {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT DISTINCT day, hour FROM zcode_request_fact
                     EXCEPT
                     SELECT day, hour FROM usage_fact WHERE providerId = 'zcode_local'",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|row| row.ok()).collect()
        };
        if changed.is_empty() && missing_scopes.is_empty() {
            return Ok(());
        }
        // A retry can move a request across (day, hour) scopes (its winning
        // attempt's started_at changed). Read each changed request's
        // PREVIOUS scope before the upsert overwrites it — the old scope
        // must recompute too, otherwise its tokens stay in the old hour
        // bucket forever and the request double-counts. (The pre-incremental
        // full rebuild recomputed every scope and never had this gap.)
        let mut affected: std::collections::BTreeSet<(String, i64)> = missing_scopes;
        if !changed.is_empty() {
            let ids = changed.iter().map(|request| request.id.as_str()).collect::<Vec<_>>();
            let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let mut stmt = self
                .conn
                .prepare(&format!(
                    "SELECT day, hour FROM zcode_request_fact
                     WHERE day IS NOT NULL AND hour IS NOT NULL AND requestId IN ({placeholders})"
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (day, hour) = row.map_err(|e| e.to_string())?;
                affected.insert((day, hour));
            }
        }
        for request in &changed {
            affected.insert((request.day.clone(), request.hour));
        }
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO zcode_request_fact (requestId, day, hour, requestHash, itemJson)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(requestId) DO UPDATE SET
                       day = excluded.day,
                       hour = excluded.hour,
                       requestHash = excluded.requestHash,
                       itemJson = excluded.itemJson",
                )
                .map_err(|e| e.to_string())?;
            for request in &changed {
                stmt.execute(params![request.id, request.day, request.hour, request.hash, request.json])
                    .map_err(|e| e.to_string())?;
            }
        }
        // Residual rows are frozen after initialization; parse them (small)
        // so affected scopes recompute with their contribution included.
        let residual: Vec<Value> = {
            let mut stmt = tx
                .prepare("SELECT itemJson FROM zcode_legacy_residual")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|row| row.ok())
                .filter_map(|text| serde_json::from_str(&text).ok())
                .collect()
        };
        let mut affected: std::collections::BTreeSet<(String, i64)> = affected;
        for (day, hour) in &affected {
            let mut values: Vec<Value> = {
                let mut stmt = tx
                    .prepare(
                        "SELECT itemJson FROM zcode_request_fact WHERE day = ?1 AND hour = ?2",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![day, hour], |row| row.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                rows.filter_map(|row| row.ok())
                    .filter_map(|text| serde_json::from_str(&text).ok())
                    .collect()
            };
            values.extend(
                residual
                    .iter()
                    .filter(|item| str_field(item, "day") == *day && i64_field(item, "hour") == *hour)
                    .cloned(),
            );
            let aggregate = aggregate_local_items(values.iter());
            tx.execute(
                "DELETE FROM usage_fact WHERE providerId = 'zcode_local' AND day = ?1 AND hour = ?2",
                params![day, hour],
            )
            .map_err(|e| e.to_string())?;
            insert_usage_fact_aggregates(&tx, aggregate, scanned_at)?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    fn ingest_zcode_requests_initial(
        &mut self,
        requests: &[Value],
        scanned_at: &str,
    ) -> Result<(), String> {
        let old_rows = self.all_usage_items()?.into_iter()
            .filter(|item| str_field(item, "providerId") == "zcode_local")
            .collect::<Vec<_>>();
        let live = aggregate_local_items(requests.iter());
        if !old_rows.is_empty() && !live.is_empty() {
            let old_scopes = old_rows.iter().map(|item| (str_field(item, "day"), i64_field(item, "hour")))
                .collect::<std::collections::HashSet<_>>();
            let overlap = requests.iter().filter(|item| old_scopes.contains(&(str_field(item, "day"), i64_field(item, "hour"))))
                .count();
            let matching_keys = old_rows.iter().filter(|item| live.contains_key(&usage_key(item))).count();
            if overlap >= 10 && matching_keys == 0 {
                return Err("ZCode ledger migration rejected: source attribution does not match existing local data".to_string());
            }
        }
        let parsed = parse_zcode_requests(requests)?;
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut residual_stmt = tx.prepare(
                "INSERT INTO zcode_legacy_residual (usageKey, itemJson) VALUES (?1, ?2)"
            ).map_err(|e| e.to_string())?;
            for mut old in old_rows {
                let key = usage_key(&old);
                if let Some(now) = live.get(&key) {
                    // A larger live component means this group has received a
                    // correction or new usage since the previous aggregate.
                    // Its old aggregate cannot be safely split into residual
                    // requests, so the current source is authoritative here.
                    let complete_overlap = TOKEN_FIELDS.iter()
                        .all(|field| i64_field(&old, field) >= i64_field(now, field));
                    for field in TOKEN_FIELDS {
                        old[field] = json!(if complete_overlap {
                            i64_field(&old, field) - i64_field(now, field)
                        } else { 0 });
                    }
                }
                if i64_field(&old, "totalTokens") > 0 {
                    residual_stmt.execute(params![key, old.to_string()]).map_err(|e| e.to_string())?;
                }
            }
            drop(residual_stmt);
            tx.execute("INSERT INTO meta (key, value) VALUES ('zcodeRequestLedgerInitialized', '1')", [])
                .map_err(|e| e.to_string())?;
        }
        {
            let mut stmt = tx.prepare(
                "INSERT INTO zcode_request_fact (requestId, day, hour, requestHash, itemJson)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(requestId) DO UPDATE SET
                   day = excluded.day,
                   hour = excluded.hour,
                   requestHash = excluded.requestHash,
                   itemJson = excluded.itemJson"
            ).map_err(|e| e.to_string())?;
            for request in &parsed {
                stmt.execute(params![request.id, request.day, request.hour, request.hash, request.json])
                    .map_err(|e| e.to_string())?;
            }
        }
        let mut values = Vec::new();
        for table in ["zcode_legacy_residual", "zcode_request_fact"] {
            let mut stmt = tx.prepare(&format!("SELECT itemJson FROM {}", table)).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
            for row in rows {
                let item: Value = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                values.push(item);
            }
        }
        let aggregate = aggregate_local_items(values.iter());
        tx.execute("DELETE FROM usage_fact WHERE providerId = 'zcode_local'", [])
            .map_err(|e| e.to_string())?;
        insert_usage_fact_aggregates(&tx, aggregate, scanned_at)?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Import a v1 backup snapshot as a new aggregate baseline. Its request
    /// ledger did not exist yet; the next ZCode scan derives a residual.
    pub fn restore_legacy_snapshot(&mut self, items: &[Value], scanned_at: &str) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM usage_fact", []).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM zcode_request_fact", []).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM zcode_legacy_residual", []).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM meta WHERE key = 'zcodeRequestLedgerInitialized'", [])
            .map_err(|e| e.to_string())?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO usage_fact (usageKey, day, hour, toolCode, providerId, workdirHash,
                 workdirDisplayName, model, inputTokens, outputTokens, cacheReadTokens,
                 cacheWriteTokens, reasoningTokens, totalTokens, sourceQuality, rawSourceRef,
                 providerVersion, parserVersion, sourceFingerprint, scannedAt)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)"
            ).map_err(|e| e.to_string())?;
            for item in items {
                stmt.execute(params![usage_key(item), str_field(item,"day"), i64_field(item,"hour"),
                    str_field(item,"toolCode"), str_field(item,"providerId"),
                    str_field(item,"workdirHash"), str_field(item,"workdirDisplayName"),
                    str_field(item,"model"), i64_field(item,"inputTokens"),
                    i64_field(item,"outputTokens"), i64_field(item,"cacheReadTokens"),
                    i64_field(item,"cacheWriteTokens"), i64_field(item,"reasoningTokens"),
                    i64_field(item,"totalTokens"), str_field(item,"sourceQuality"),
                    str_field(item,"rawSourceRef"), str_field(item,"providerVersion"),
                    str_field(item,"parserVersion"), str_field(item,"sourceFingerprint"), scanned_at])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// Per-provider aggregate of usage rows whose (day, hour, providerId)
    /// scope exists locally but is absent from the incoming scan — i.e. rows
    /// the source no longer reports and the ledger keeps.
    fn preserved_scope_stats(
        &self,
        scan_scopes: &std::collections::BTreeSet<(String, i64, String)>,
    ) -> Result<Vec<Value>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT day, hour, providerId, COUNT(*), SUM(totalTokens)
                 FROM usage_fact
                 GROUP BY day, hour, providerId",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        #[derive(Default)]
        struct ProviderStat {
            scopes: i64,
            rows: i64,
            total_tokens: i64,
            min_day: String,
            max_day: String,
        }
        let mut per_provider: std::collections::BTreeMap<String, ProviderStat> =
            std::collections::BTreeMap::new();
        let mut scope_keys: Vec<String> = Vec::new();
        for row in rows {
            let (day, hour, provider, row_count, tokens) =
                row.map_err(|e| e.to_string())?;
            if scan_scopes.contains(&(day.clone(), hour, provider.clone())) {
                continue;
            }
            scope_keys.push(format!("{}|{:02}|{}", day, hour, provider));
            let stat = per_provider.entry(provider).or_default();
            stat.scopes += 1;
            stat.rows += row_count;
            stat.total_tokens += tokens;
            if stat.min_day.is_empty() || day < stat.min_day {
                stat.min_day = day.clone();
            }
            if day > stat.max_day {
                stat.max_day = day;
            }
        }
        if per_provider.is_empty() {
            return Ok(Vec::new());
        }
        scope_keys.sort();
        Ok(vec![json!({
            "signature": scope_signature(&scope_keys),
            "providers": per_provider
                .into_iter()
                .map(|(provider, stat)| {
                    json!({
                        "providerId": provider,
                        "scopes": stat.scopes,
                        "rows": stat.rows,
                        "totalTokens": stat.total_tokens,
                        "minDay": stat.min_day,
                        "maxDay": stat.max_day,
                    })
                })
                .collect::<Vec<_>>(),
        })])
    }

    /// Emit a runtime event when the set of source-pruned scopes changes, so
    /// history-keeping never regresses silently. The signature lives in the
    /// meta table so repeated unchanged scans (auto refresh) stay quiet.
    fn note_preserved_scopes(&self, preserved: Vec<Value>) {
        if preserved.is_empty() {
            let _ = self.conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('preservedScopeSignature', '')",
                [],
            );
            return;
        }
        let signature = preserved[0]["signature"].as_str().unwrap_or("").to_string();
        let previous: String = self
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'preservedScopeSignature'",
                [],
                |row| row.get(0),
            )
            .unwrap_or_default();
        if previous == signature {
            return;
        }
        let _ = self.conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('preservedScopeSignature', ?1)",
            params![signature],
        );
        #[cfg(not(test))]
        crate::observability::append_runtime_event(
            "local_store",
            "source_pruned_scopes_preserved",
            "warn",
            json!({
                "providers": preserved[0]["providers"],
                "note": "scopes absent from scan are preserved locally (source-side retention/pruning)",
            }),
        );
    }

    /// Per-provider row counts — a cheap stand-in for reading the whole
    /// ledger when a scan only needs to know which providers previously had
    /// rows (missing-row preservation).
    pub fn provider_row_counts(&self) -> Result<HashMap<String, i64>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT providerId, COUNT(*) FROM usage_fact GROUP BY providerId")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|row| row.ok()).collect())
    }

    /// Full ledger rows filtered to the given providers — used to re-attach
    /// history for providers whose scan failed this round.
    pub fn usage_items_for_providers(
        &self,
        provider_ids: &std::collections::HashSet<String>,
    ) -> Result<Vec<Value>, String> {
        if provider_ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = provider_ids
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let ids: Vec<String> = provider_ids.iter().cloned().collect();
        let mut stmt = self
            .conn
            .prepare(&format!(
                r#"
                SELECT day, hour, toolCode, providerId, workdirHash, workdirDisplayName, model,
                       inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                       reasoningTokens, totalTokens, sourceQuality, rawSourceRef, providerVersion,
                       parserVersion, sourceFingerprint
                FROM usage_fact
                WHERE providerId IN ({placeholders})
                ORDER BY day DESC, totalTokens DESC
                "#,
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(ids.iter()), usage_row_to_value)
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|e| e.to_string())?);
        }
        Ok(items)
    }

    pub fn all_usage_items(&self) -> Result<Vec<Value>, String> {
        let mut stmt = self
            .conn
            .prepare(
                r#"
                SELECT day, hour, toolCode, providerId, workdirHash, workdirDisplayName, model,
                       inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                       reasoningTokens, totalTokens, sourceQuality, rawSourceRef, providerVersion,
                       parserVersion, sourceFingerprint
                FROM usage_fact
                ORDER BY day DESC, totalTokens DESC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], usage_row_to_value)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn has_usage_facts(&self) -> Result<bool, String> {
        Ok(self.row_count(None, None, &UsageFilters::default())? > 0)
    }

    pub fn summary(&self, range: &str, filters: &UsageFilters) -> Result<Value, String> {
        let (from, to) = range_bounds(range);
        let rows =
            self.group_breakdown("providerId", from.as_deref(), to.as_deref(), 5, filters)?;
        let workdirs =
            self.group_breakdown("workdirDisplayName", from.as_deref(), to.as_deref(), 10, filters)?;
        let models = self.group_breakdown("model", from.as_deref(), to.as_deref(), 10, filters)?;
        let totals = self.totals(from.as_deref(), to.as_deref(), filters)?;
        Ok(json!({
            "range": range,
            "from": from.unwrap_or_default(),
            "to": to.unwrap_or_default(),
            "totals": totals,
            "providers": rows,
            "workdirs": workdirs,
            "models": models
        }))
    }

    pub fn workdirs(
        &self,
        range: &str,
        limit: i64,
        filters: &UsageFilters,
    ) -> Result<Value, String> {
        let (from, to) = range_bounds(range);
        let mut params = Vec::new();
        let limit = limit.clamp(1, 500);
        let sql = format!(
            "SELECT workdirHash, workdirDisplayName,
                    COUNT(*),
                    COALESCE(SUM(inputTokens), 0),
                    COALESCE(SUM(outputTokens), 0),
                    COALESCE(SUM(cacheReadTokens), 0),
                    COALESCE(SUM(cacheWriteTokens), 0),
                    COALESCE(SUM(reasoningTokens), 0),
                    COALESCE(SUM(totalTokens), 0)
             FROM usage_fact {}
             GROUP BY workdirHash, workdirDisplayName
             ORDER BY COALESCE(SUM(totalTokens), 0) DESC
             LIMIT ?",
            {
                let (clause, mut where_params) =
                    combined_where(from.as_deref(), to.as_deref(), filters);
                params.append(&mut where_params);
                clause
            }
        );
        params.push(limit.to_string());
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                Ok(json!({
                    "workdirHash": row.get::<_, String>(0)?,
                    "name": row.get::<_, String>(1)?,
                    "rows": row.get::<_, i64>(2)?,
                    "inputTokens": row.get::<_, i64>(3)?,
                    "outputTokens": row.get::<_, i64>(4)?,
                    "cacheReadTokens": row.get::<_, i64>(5)?,
                    "cacheWriteTokens": row.get::<_, i64>(6)?,
                    "reasoningTokens": row.get::<_, i64>(7)?,
                    "totalTokens": row.get::<_, i64>(8)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        let items = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(json!({
            "range": range,
            "from": from.unwrap_or_default(),
            "to": to.unwrap_or_default(),
            "items": items
        }))
    }

    pub fn trend(
        &self,
        range: &str,
        grain: &str,
        filters: &UsageFilters,
    ) -> Result<Value, String> {
        let (from, to) = range_bounds(range);
        let sql = match grain {
            "hour" => {
                "SELECT day || 'T' || printf('%02d', hour) AS bucket, day AS periodStart, day AS periodEnd, hour, SUM(inputTokens), SUM(outputTokens), SUM(cacheReadTokens), SUM(cacheWriteTokens), SUM(reasoningTokens), SUM(totalTokens) FROM usage_fact"
            }
            "week" => {
                "SELECT date(day, '-' || ((strftime('%w', day) + 6) % 7) || ' days') AS bucket, date(day, '-' || ((strftime('%w', day) + 6) % 7) || ' days') AS periodStart, date(day, '-' || ((strftime('%w', day) + 6) % 7) || ' days', '+6 days') AS periodEnd, NULL AS hour, SUM(inputTokens), SUM(outputTokens), SUM(cacheReadTokens), SUM(cacheWriteTokens), SUM(reasoningTokens), SUM(totalTokens) FROM usage_fact"
            }
            "month" => {
                "SELECT substr(day, 1, 7) AS bucket, substr(day, 1, 7) || '-01' AS periodStart, substr(day, 1, 7) || '-01' AS periodEnd, NULL AS hour, SUM(inputTokens), SUM(outputTokens), SUM(cacheReadTokens), SUM(cacheWriteTokens), SUM(reasoningTokens), SUM(totalTokens) FROM usage_fact"
            }
            _ => {
                "SELECT day AS bucket, day AS periodStart, day AS periodEnd, NULL AS hour, SUM(inputTokens), SUM(outputTokens), SUM(cacheReadTokens), SUM(cacheWriteTokens), SUM(reasoningTokens), SUM(totalTokens) FROM usage_fact"
            }
        };
        let (clause, params) = combined_where(from.as_deref(), to.as_deref(), filters);
        let mut sql = format!("{} {}", sql, clause);
        sql.push_str(match grain {
            "hour" => " GROUP BY day, hour ORDER BY day, hour",
            "week" => " GROUP BY date(day, '-' || ((strftime('%w', day) + 6) % 7) || ' days') ORDER BY date(day, '-' || ((strftime('%w', day) + 6) % 7) || ' days')",
            "month" => " GROUP BY substr(day, 1, 7) ORDER BY substr(day, 1, 7)",
            _ => " GROUP BY day ORDER BY day",
        });
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                Ok(json!({
                    "bucket": row.get::<_, String>(0)?,
                    "periodStart": row.get::<_, String>(1)?,
                    "periodEnd": row.get::<_, String>(2)?,
                    "hour": row.get::<_, Option<i64>>(3)?,
                    "inputTokens": row.get::<_, i64>(4)?,
                    "outputTokens": row.get::<_, i64>(5)?,
                    "cacheReadTokens": row.get::<_, i64>(6)?,
                    "cacheWriteTokens": row.get::<_, i64>(7)?,
                    "reasoningTokens": row.get::<_, i64>(8)?,
                    "totalTokens": row.get::<_, i64>(9)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        let items = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(json!({
            "range": range,
            "grain": grain,
            "from": from.unwrap_or_default(),
            "to": to.unwrap_or_default(),
            "items": items
        }))
    }

    pub fn detail_window(
        &self,
        range: &str,
        offset: i64,
        limit: i64,
        filters: &UsageFilters,
    ) -> Result<Value, String> {
        let (from, to) = range_bounds(range);
        let (clause, mut params) = combined_where(from.as_deref(), to.as_deref(), filters);
        let mut sql = format!(
            "SELECT day, hour, toolCode, providerId, workdirHash, workdirDisplayName, model,
                    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                    reasoningTokens, totalTokens, sourceQuality, rawSourceRef, providerVersion,
                    parserVersion, sourceFingerprint
             FROM usage_fact {}",
            clause
        );
        sql.push_str(" ORDER BY day DESC, totalTokens DESC LIMIT ? OFFSET ?");
        let limit = limit.clamp(1, 500);
        let offset = offset.max(0);
        params.push(limit.to_string());
        params.push(offset.to_string());
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(params.iter()),
                usage_row_to_value,
            )
            .map_err(|e| e.to_string())?;
        let items = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let total_rows = self.row_count(from.as_deref(), to.as_deref(), filters)?;
        Ok(json!({
            "range": range,
            "from": from.unwrap_or_default(),
            "to": to.unwrap_or_default(),
            "offset": offset,
            "limit": limit,
            "totalRows": total_rows,
            "items": items
        }))
    }

    fn totals(
        &self,
        from: Option<&str>,
        to: Option<&str>,
        filters: &UsageFilters,
    ) -> Result<Value, String> {
        let (clause, params) = combined_where(from, to, filters);
        let sql = format!(
            "SELECT COUNT(*), COALESCE(SUM(inputTokens), 0), COALESCE(SUM(outputTokens), 0),
                    COALESCE(SUM(cacheReadTokens), 0), COALESCE(SUM(cacheWriteTokens), 0),
                    COALESCE(SUM(reasoningTokens), 0), COALESCE(SUM(totalTokens), 0)
             FROM usage_fact {}",
            clause
        );
        self.conn
            .query_row(
                &sql,
                rusqlite::params_from_iter(params.iter()),
                |row| {
                    Ok(json!({
                        "rows": row.get::<_, i64>(0)?,
                        "inputTokens": row.get::<_, i64>(1)?,
                        "outputTokens": row.get::<_, i64>(2)?,
                        "cacheReadTokens": row.get::<_, i64>(3)?,
                        "cacheWriteTokens": row.get::<_, i64>(4)?,
                        "reasoningTokens": row.get::<_, i64>(5)?,
                        "totalTokens": row.get::<_, i64>(6)?,
                    }))
                },
            )
            .map_err(|e| e.to_string())
    }

    fn row_count(
        &self,
        from: Option<&str>,
        to: Option<&str>,
        filters: &UsageFilters,
    ) -> Result<i64, String> {
        let (clause, params) = combined_where(from, to, filters);
        let sql = format!("SELECT COUNT(*) FROM usage_fact {}", clause);
        self.conn
            .query_row(
                &sql,
                rusqlite::params_from_iter(params.iter()),
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
    }

    /// Per-model token splits (all five token fields, not just totals) for
    /// cost estimation over a range.
    pub fn model_breakdown(
        &self,
        range: &str,
        filters: &UsageFilters,
    ) -> Result<Vec<Value>, String> {
        let (from, to) = range_bounds(range);
        let (clause, params) = combined_where(from.as_deref(), to.as_deref(), filters);
        let sql = format!(
            "SELECT model,
                    COUNT(*),
                    COALESCE(SUM(inputTokens), 0),
                    COALESCE(SUM(outputTokens), 0),
                    COALESCE(SUM(cacheReadTokens), 0),
                    COALESCE(SUM(cacheWriteTokens), 0),
                    COALESCE(SUM(reasoningTokens), 0),
                    COALESCE(SUM(totalTokens), 0)
             FROM usage_fact {}
             GROUP BY model
             ORDER BY COALESCE(SUM(totalTokens), 0) DESC",
            clause
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                Ok(json!({
                    "model": row.get::<_, String>(0)?,
                    "rows": row.get::<_, i64>(1)?,
                    "inputTokens": row.get::<_, i64>(2)?,
                    "outputTokens": row.get::<_, i64>(3)?,
                    "cacheReadTokens": row.get::<_, i64>(4)?,
                    "cacheWriteTokens": row.get::<_, i64>(5)?,
                    "reasoningTokens": row.get::<_, i64>(6)?,
                    "totalTokens": row.get::<_, i64>(7)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    fn group_breakdown(
        &self,
        field: &str,
        from: Option<&str>,
        to: Option<&str>,
        limit: i64,
        filters: &UsageFilters,
    ) -> Result<Vec<Value>, String> {
        let (clause, mut params) = combined_where(from, to, filters);
        let sql = format!(
            "SELECT {field}, COALESCE(SUM(totalTokens), 0), COUNT(*)
             FROM usage_fact {}
             GROUP BY {field}
             ORDER BY COALESCE(SUM(totalTokens), 0) DESC
             LIMIT ?",
            clause
        );
        params.push(limit.to_string());
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                Ok(json!({
                    "name": row.get::<_, String>(0)?,
                    "totalTokens": row.get::<_, i64>(1)?,
                    "rows": row.get::<_, i64>(2)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
}

impl SourceCache for LocalUsageStore {
    fn take_cached_source(&mut self, fingerprint: &str) -> Option<Vec<Value>> {
        let text = self
            .conn
            .query_row(
                "SELECT itemsJson FROM source_cache WHERE fingerprint = ?",
                params![fingerprint],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()?;
        let _ = self.conn.execute(
            "UPDATE source_cache SET lastSeenAt = ? WHERE fingerprint = ?",
            params![
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                fingerprint
            ],
        );
        serde_json::from_str::<Vec<Value>>(&text).ok()
    }
}

fn usage_key(item: &Value) -> String {
    [
        str_field(item, "day"),
        i64_field(item, "hour").to_string(),
        str_field(item, "toolCode"),
        str_field(item, "providerId"),
        str_field(item, "workdirHash"),
        str_field(item, "model"),
    ]
    .join("|")
}

/// A ledger replace unit: all rows of one provider within one (day, hour).
pub type UsageScope = (String, i64, String);

fn item_scope(item: &Value) -> UsageScope {
    (
        str_field(item, "day"),
        i64_field(item, "hour"),
        str_field(item, "providerId"),
    )
}

fn item_scopes(items: &[Value]) -> std::collections::BTreeSet<UsageScope> {
    items.iter().map(item_scope).collect()
}

struct ParsedZcodeRequest {
    id: String,
    day: String,
    hour: i64,
    hash: String,
    json: String,
}

fn parse_zcode_requests(requests: &[Value]) -> Result<Vec<ParsedZcodeRequest>, String> {
    requests
        .iter()
        .map(|request| {
            let id = request
                .get("_localRequestId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or("ZCode request missing stable ID")?
                .to_string();
            let mut item = request.clone();
            item.as_object_mut()
                .ok_or("Invalid ZCode request")?
                .remove("_localRequestId");
            let json = item.to_string();
            let hash = crate::crypto::sha256_hex(&json);
            Ok(ParsedZcodeRequest {
                id,
                day: str_field(&item, "day"),
                hour: i64_field(&item, "hour"),
                hash,
                json,
            })
        })
        .collect()
}

fn insert_usage_fact_aggregates(
    tx: &rusqlite::Transaction<'_>,
    aggregate: HashMap<String, Value>,
    scanned_at: &str,
) -> Result<(), String> {
    let mut stmt = tx
        .prepare(
            "INSERT INTO usage_fact (usageKey, day, hour, toolCode, providerId, workdirHash,
             workdirDisplayName, model, inputTokens, outputTokens, cacheReadTokens,
             cacheWriteTokens, reasoningTokens, totalTokens, sourceQuality, rawSourceRef,
             providerVersion, parserVersion, sourceFingerprint, scannedAt)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
        )
        .map_err(|e| e.to_string())?;
    for (key, item) in aggregate {
        stmt.execute(params![key, str_field(&item, "day"), i64_field(&item, "hour"),
            str_field(&item, "toolCode"), str_field(&item, "providerId"),
            str_field(&item, "workdirHash"), str_field(&item, "workdirDisplayName"),
            str_field(&item, "model"), i64_field(&item, "inputTokens"),
            i64_field(&item, "outputTokens"), i64_field(&item, "cacheReadTokens"),
            i64_field(&item, "cacheWriteTokens"), i64_field(&item, "reasoningTokens"),
            i64_field(&item, "totalTokens"), str_field(&item, "sourceQuality"),
            str_field(&item, "rawSourceRef"), str_field(&item, "providerVersion"),
            str_field(&item, "parserVersion"), str_field(&item, "sourceFingerprint"), scanned_at])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

const TOKEN_FIELDS: [&str; 6] = [
    "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
    "reasoningTokens", "totalTokens",
];

fn aggregate_local_items<'a>(items: impl IntoIterator<Item = &'a Value>) -> HashMap<String, Value> {
    let mut groups: HashMap<String, Value> = HashMap::new();
    for item in items {
        let key = usage_key(item);
        if let Some(existing) = groups.get_mut(&key) {
            for field in TOKEN_FIELDS {
                existing[field] = json!(i64_field(existing, field).saturating_add(i64_field(item, field)));
            }
            // A newly observed request carries current workdir display metadata.
            if !str_field(item, "workdirDisplayName").is_empty() {
                existing["workdirDisplayName"] = item["workdirDisplayName"].clone();
            }
            for field in ["sourceFingerprint", "rawSourceRef", "providerVersion", "parserVersion"] {
                if !str_field(item, field).is_empty() {
                    existing[field] = item[field].clone();
                }
            }
        } else {
            groups.insert(key, item.clone());
        }
    }
    groups
}

/// Deterministic digest of the sorted scope keys; DefaultHasher is seeded with
/// fixed keys, so the signature is stable across processes and runs.
fn scope_signature(sorted_scope_keys: &[String]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for key in sorted_scope_keys {
        key.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

fn str_field(item: &Value, key: &str) -> String {
    item.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn i64_field(item: &Value, key: &str) -> i64 {
    item.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

fn usage_row_to_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "day": row.get::<_, String>(0)?,
        "hour": row.get::<_, i64>(1)?,
        "toolCode": row.get::<_, String>(2)?,
        "providerId": row.get::<_, String>(3)?,
        "workdirHash": row.get::<_, String>(4)?,
        "workdirDisplayName": row.get::<_, String>(5)?,
        "model": row.get::<_, String>(6)?,
        "inputTokens": row.get::<_, i64>(7)?,
        "outputTokens": row.get::<_, i64>(8)?,
        "cacheReadTokens": row.get::<_, i64>(9)?,
        "cacheWriteTokens": row.get::<_, i64>(10)?,
        "reasoningTokens": row.get::<_, i64>(11)?,
        "totalTokens": row.get::<_, i64>(12)?,
        "sourceQuality": row.get::<_, String>(13)?,
        "rawSourceRef": row.get::<_, String>(14)?,
        "providerVersion": row.get::<_, String>(15)?,
        "parserVersion": row.get::<_, String>(16)?,
        "sourceFingerprint": row.get::<_, String>(17)?,
    }))
}

fn range_bounds(range: &str) -> (Option<String>, Option<String>) {
    let today = crate::date::local_day();
    match range {
        "today" | "" => (Some(today.clone()), Some(today)),
        "7d" | "last7" => (crate::date::add_days(&today, -6), Some(today)),
        "30d" | "last30" => (crate::date::add_days(&today, -29), Some(today)),
        "all" => (None, None),
        value if value.contains("..") => {
            let mut parts = value.splitn(2, "..");
            (
                parts
                    .next()
                    .filter(|v| !v.is_empty())
                    .map(|v| v.to_string()),
                parts
                    .next()
                    .filter(|v| !v.is_empty())
                    .map(|v| v.to_string()),
            )
        }
        _ => (Some(today.clone()), Some(today)),
    }
}

/// Column filters for usage queries. Values are case-insensitive substring
/// matches (SQLite LIKE is ASCII-case-insensitive), applied on top of the
/// day range.
#[derive(Debug, Clone, Default)]
pub struct UsageFilters {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub workdir: Option<String>,
}

impl UsageFilters {
    pub fn is_empty(&self) -> bool {
        self.provider.is_none() && self.model.is_none() && self.workdir.is_none()
    }

    fn conditions(&self) -> Vec<(&'static str, String)> {
        let mut conditions = Vec::new();
        if let Some(value) = self.provider.as_deref().filter(|v| !v.is_empty()) {
            conditions.push(("providerId", like_param(value)));
        }
        if let Some(value) = self.model.as_deref().filter(|v| !v.is_empty()) {
            conditions.push(("model", like_param(value)));
        }
        if let Some(value) = self.workdir.as_deref().filter(|v| !v.is_empty()) {
            conditions.push(("workdirDisplayName", like_param(value)));
        }
        conditions
    }
}

fn like_param(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{}%", escaped)
}

fn combined_where(
    from: Option<&str>,
    to: Option<&str>,
    filters: &UsageFilters,
) -> (String, Vec<String>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut params = bounds_params(from, to);
    match (from, to) {
        (Some(_), Some(_)) => conditions.push("day BETWEEN ? AND ?".to_string()),
        (Some(_), None) => conditions.push("day >= ?".to_string()),
        (None, Some(_)) => conditions.push("day <= ?".to_string()),
        (None, None) => {}
    }
    for (column, value) in filters.conditions() {
        conditions.push(format!("{} LIKE ? ESCAPE '\\'", column));
        params.push(value);
    }
    if conditions.is_empty() {
        (String::new(), params)
    } else {
        (format!("WHERE {}", conditions.join(" AND ")), params)
    }
}

fn bounds_params(from: Option<&str>, to: Option<&str>) -> Vec<String> {
    match (from, to) {
        (Some(from), Some(to)) => vec![from.to_string(), to.to_string()],
        (Some(from), None) => vec![from.to_string()],
        (None, Some(to)) => vec![to.to_string()],
        (None, None) => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> (LocalUsageStore, std::path::PathBuf) {
        // Unique across parallel test threads: nanos alone can collide when
        // two threads allocate in the same nanosecond, which surfaces as
        // "database is locked" on open.
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let unique = format!(
            "{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(format!("atl-lus-test-{unique}.sqlite3"));
        let store = LocalUsageStore::open(path.clone()).unwrap();
        (store, path)
    }

    fn make_item(
        day: &str,
        hour: i64,
        tool: &str,
        provider: &str,
        model: &str,
        tokens: i64,
    ) -> Value {
        json!({
            "day": day,
            "hour": hour,
            "toolCode": tool,
            "providerId": provider,
            "workdirHash": format!("h_{}", provider),
            "workdirDisplayName": format!("proj_{}", provider),
            "model": model,
            "inputTokens": tokens / 2,
            "outputTokens": tokens / 4,
            "cacheReadTokens": tokens / 8,
            "cacheWriteTokens": tokens / 8,
            "reasoningTokens": 0,
            "totalTokens": tokens,
            "sourceQuality": "exact",
            "rawSourceRef": "a.jsonl",
            "providerVersion": "1",
            "parserVersion": "1",
            "sourceFingerprint": format!("fp_{}_{}", provider, day)
        })
    }

    #[test]
    fn usage_filters_narrow_queries_and_escape_wildcards() {
        let (mut store, path) = temp_db();
        let day = crate::date::local_day();
        let items = vec![
            make_item(&day, 1, "codex", "codex_local", "gpt-5", 1000),
            make_item(&day, 2, "claude", "claude_code_local", "claude-opus", 2000),
            make_item(&day, 3, "zcode", "zcode_local", "glm-5.3", 4000),
        ];
        store.merge_usage_facts(&items, "now").unwrap();

        let by_provider = UsageFilters {
            provider: Some("codex".to_string()),
            ..Default::default()
        };
        let summary = store.summary("all", &by_provider).unwrap();
        assert_eq!(summary["totals"]["totalTokens"], json!(1000));

        // case-insensitive model filter narrows totals and detail rows
        let by_model = UsageFilters {
            model: Some("GLM".to_string()),
            ..Default::default()
        };
        let summary = store.summary("all", &by_model).unwrap();
        assert_eq!(summary["totals"]["totalTokens"], json!(4000));
        let detail = store.detail_window("all", 0, 10, &by_model).unwrap();
        assert_eq!(detail["totalRows"], json!(1));

        // workdir display-name filter
        let by_workdir = UsageFilters {
            workdir: Some("proj_claude".to_string()),
            ..Default::default()
        };
        let summary = store.summary("all", &by_workdir).unwrap();
        assert_eq!(summary["totals"]["totalTokens"], json!(2000));

        // a literal % in the filter must not act as a wildcard
        let percent = UsageFilters {
            provider: Some("%".to_string()),
            ..Default::default()
        };
        let summary = store.summary("all", &percent).unwrap();
        assert_eq!(summary["totals"]["rows"], json!(0));

        // model_breakdown returns full token splits per model
        let models = store.model_breakdown("all", &UsageFilters::default()).unwrap();
        assert_eq!(models.len(), 3);
        assert_eq!(models[0]["model"], json!("glm-5.3"));
        assert_eq!(models[0]["inputTokens"], json!(2000));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn local_usage_store_roundtrips_cache_and_facts() {
        let (mut store, path) = temp_db();
        let item = json!({
            "day": crate::date::local_day(),
            "hour": 10,
            "toolCode": "codex",
            "providerId": "codex_local",
            "workdirHash": "h1",
            "workdirDisplayName": "proj",
            "model": "gpt-5",
            "inputTokens": 100,
            "outputTokens": 50,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0,
            "totalTokens": 150,
            "sourceQuality": "exact",
            "rawSourceRef": "a.jsonl",
            "providerVersion": "1",
            "parserVersion": "1",
            "sourceFingerprint": "fp1"
        });
        store
            .replace_source_cache(
                &HashMap::from([
                    ("fp1".to_string(), vec![item.clone()]),
                    ("fp2".to_string(), vec![item.clone()]),
                ]),
                "now",
            )
            .unwrap();
        assert_eq!(store.take_cached_source("fp1").unwrap().len(), 1);
        store
            .replace_source_cache(
                &HashMap::from([("fp2".to_string(), vec![item.clone()])]),
                "now",
            )
            .unwrap();
        assert!(store.take_cached_source("fp1").is_none());
        assert_eq!(store.take_cached_source("fp2").unwrap().len(), 1);
        store.merge_usage_facts(&[item], "now").unwrap();
        assert_eq!(
            store.summary("today", &UsageFilters::default()).unwrap()["totals"]["totalTokens"],
            150
        );
        assert_eq!(store.detail_window("today", 0, 10, &UsageFilters::default()).unwrap()["totalRows"], 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn summary_aggregates_multiple_providers() {
        let (mut store, path) = temp_db();
        let today = crate::date::local_day();
        store
            .merge_usage_facts(
                &[
                    make_item(&today, 10, "codex", "codex_local", "codex-1", 100),
                    make_item(
                        &today,
                        10,
                        "claude_code",
                        "claude_code_local",
                        "claude-3",
                        200,
                    ),
                    make_item(&today, 11, "codex", "codex_local", "codex-1", 50),
                ],
                "now",
            )
            .unwrap();

        let summary = store.summary("today", &UsageFilters::default()).unwrap();
        assert_eq!(summary["totals"]["totalTokens"], 350);
        assert_eq!(summary["totals"]["rows"], 3);

        let providers = summary["providers"].as_array().unwrap();
        assert_eq!(providers.len(), 2);

        let models = summary["models"].as_array().unwrap();
        assert_eq!(models.len(), 2);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn trend_daily_grain() {
        let (mut store, path) = temp_db();
        store
            .merge_usage_facts(
                &[
                    make_item("2026-05-10", 10, "codex", "codex_local", "gpt-5", 100),
                    make_item("2026-05-10", 11, "codex", "codex_local", "gpt-5", 50),
                    make_item("2026-05-11", 9, "codex", "codex_local", "gpt-5", 200),
                ],
                "now",
            )
            .unwrap();

        let trend = store.trend("2026-05-10..2026-05-11", "day", &UsageFilters::default()).unwrap();
        let items = trend["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["totalTokens"], 150); // 2026-05-10
        assert_eq!(items[1]["totalTokens"], 200); // 2026-05-11
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn trend_hourly_grain() {
        let (mut store, path) = temp_db();
        store
            .merge_usage_facts(
                &[
                    make_item("2026-05-10", 10, "codex", "codex_local", "gpt-5", 100),
                    make_item("2026-05-10", 11, "codex", "codex_local", "gpt-5", 50),
                ],
                "now",
            )
            .unwrap();

        let trend = store.trend("2026-05-10..2026-05-10", "hour", &UsageFilters::default()).unwrap();
        let items = trend["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert!(items[0]["bucket"].as_str().unwrap().contains("T10"));
        assert!(items[1]["bucket"].as_str().unwrap().contains("T11"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn trend_monthly_grain() {
        let (mut store, path) = temp_db();
        store
            .merge_usage_facts(
                &[
                    make_item("2026-05-01", 10, "codex", "codex_local", "gpt-5", 100),
                    make_item("2026-05-15", 10, "codex", "codex_local", "gpt-5", 200),
                    make_item("2026-06-01", 10, "codex", "codex_local", "gpt-5", 300),
                ],
                "now",
            )
            .unwrap();

        let trend = store.trend("2026-05-01..2026-06-30", "month", &UsageFilters::default()).unwrap();
        let items = trend["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["totalTokens"], 300); // 2026-05
        assert_eq!(items[1]["totalTokens"], 300); // 2026-06
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn trend_weekly_grain() {
        let (mut store, path) = temp_db();
        // 2026-05-18 is Monday, 2026-05-19 is Tuesday (same week: May 18-24)
        // 2026-05-25 is Monday (next week: May 25-31)
        store
            .merge_usage_facts(
                &[
                    make_item("2026-05-18", 10, "codex", "codex_local", "gpt-5", 100),
                    make_item("2026-05-19", 11, "codex", "codex_local", "gpt-5", 200),
                    make_item("2026-05-25", 9, "codex", "codex_local", "gpt-5", 300),
                ],
                "now",
            )
            .unwrap();

        let trend = store.trend("2026-05-18..2026-05-31", "week", &UsageFilters::default()).unwrap();
        let items = trend["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        // First week bucket: 2026-05-18 (Monday) — aggregates May 18 + May 19
        assert_eq!(items[0]["periodStart"], "2026-05-18");
        assert_eq!(items[0]["periodEnd"], "2026-05-24");
        assert_eq!(items[0]["totalTokens"], 300);
        // Second week bucket: 2026-05-25 (Monday)
        assert_eq!(items[1]["periodStart"], "2026-05-25");
        assert_eq!(items[1]["periodEnd"], "2026-05-31");
        assert_eq!(items[1]["totalTokens"], 300);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn workdirs_groups_and_sorts() {
        let (mut store, path) = temp_db();
        let today = crate::date::local_day();
        store
            .merge_usage_facts(
                &[
                    make_item(&today, 10, "codex", "codex_local", "gpt-5", 100),
                    make_item(&today, 11, "codex", "codex_local", "gpt-5", 200),
                ],
                "now",
            )
            .unwrap();

        let w = store.workdirs("today", 10, &UsageFilters::default()).unwrap();
        let items = w["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["totalTokens"], 300);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn detail_window_pagination() {
        let (mut store, path) = temp_db();
        let today = crate::date::local_day();
        let items: Vec<Value> = (0..15)
            .map(|i| make_item(&today, i, "codex", "codex_local", "gpt-5", (i + 1) * 10))
            .collect();
        store.merge_usage_facts(&items, "now").unwrap();

        let page1 = store.detail_window("today", 0, 5, &UsageFilters::default()).unwrap();
        assert_eq!(page1["totalRows"], 15);
        assert_eq!(page1["items"].as_array().unwrap().len(), 5);
        assert_eq!(page1["offset"], 0);

        let page2 = store.detail_window("today", 5, 5, &UsageFilters::default()).unwrap();
        assert_eq!(page2["offset"], 5);
        assert_ne!(
            page1["items"].as_array().unwrap()[0],
            page2["items"].as_array().unwrap()[0]
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn detail_window_clamps_limit() {
        let (mut store, path) = temp_db();
        let today = crate::date::local_day();
        store
            .merge_usage_facts(
                &[make_item(&today, 10, "codex", "codex_local", "gpt-5", 100)],
                "now",
            )
            .unwrap();

        let result = store.detail_window("today", 0, 0, &UsageFilters::default()).unwrap();
        assert_eq!(result["limit"], 1, "limit 0 should be clamped to 1");

        let result = store.detail_window("today", 0, 999, &UsageFilters::default()).unwrap();
        assert_eq!(result["limit"], 500, "limit > 500 should be clamped to 500");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn empty_database_queries() {
        let (store, path) = temp_db();

        let summary = store.summary("today", &UsageFilters::default()).unwrap();
        assert_eq!(summary["totals"]["rows"], 0);
        assert_eq!(summary["totals"]["totalTokens"], 0);
        assert!(summary["providers"].as_array().unwrap().is_empty());

        assert!(!store.has_usage_facts().unwrap());

        let w = store.workdirs("today", 10, &UsageFilters::default()).unwrap();
        assert!(w["items"].as_array().unwrap().is_empty());

        let trend = store.trend("today", "day", &UsageFilters::default()).unwrap();
        assert!(trend["items"].as_array().unwrap().is_empty());

        let detail = store.detail_window("today", 0, 10, &UsageFilters::default()).unwrap();
        assert_eq!(detail["totalRows"], 0);

        let all = store.all_usage_items().unwrap();
        assert!(all.is_empty());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn range_bounds_parsing() {
        let (from, to) = range_bounds("today");
        assert!(from.is_some());
        assert_eq!(from, to);

        let (from, to) = range_bounds("all");
        assert!(from.is_none());
        assert!(to.is_none());

        let (from, to) = range_bounds("2026-05-10..2026-05-15");
        assert_eq!(from.as_deref(), Some("2026-05-10"));
        assert_eq!(to.as_deref(), Some("2026-05-15"));

        let (from, to) = range_bounds("2026-05-10..");
        assert_eq!(from.as_deref(), Some("2026-05-10"));
        assert!(to.is_none());

        let (from, to) = range_bounds("..2026-05-15");
        assert!(from.is_none());
        assert_eq!(to.as_deref(), Some("2026-05-15"));

        let (from, to) = range_bounds("7d");
        assert!(from.is_some());
        assert!(to.is_some());

        let (from, to) = range_bounds("30d");
        assert!(from.is_some());
        assert!(to.is_some());
    }

    #[test]
    fn merge_usage_facts_replaces_rows_within_present_scope() {
        let (mut store, path) = temp_db();
        let today = crate::date::local_day();
        store
            .merge_usage_facts(
                &[
                    make_item(&today, 10, "codex", "codex_local", "gpt-5", 100),
                    make_item(&today, 10, "codex", "codex_local", "gpt-4", 50),
                ],
                "now",
            )
            .unwrap();
        assert_eq!(store.has_usage_facts().unwrap(), true);

        // Same (day, hour, provider) scope rescanned with a different model
        // set — stale rows inside the active scope must be gone.
        store
            .merge_usage_facts(
                &[make_item(&today, 10, "codex", "codex_local", "gpt-5", 200)],
                "now",
            )
            .unwrap();

        let all = store.all_usage_items().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0]["totalTokens"], 200);
        assert_eq!(all[0]["model"], "gpt-5");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn merge_usage_facts_preserves_scopes_absent_from_scan() {
        let (mut store, path) = temp_db();
        let today = crate::date::local_day();
        store
            .merge_usage_facts(
                &[
                    make_item("2026-08-16", 12, "zcode", "zcode_local", "glm-5.3", 1000),
                    make_item("2026-08-17", 9, "zcode", "zcode_local", "glm-5.3", 2000),
                    make_item(&today, 10, "codex", "codex_local", "gpt-5", 100),
                ],
                "now",
            )
            .unwrap();

        // Source pruned August; the new scan only reports today's scope.
        store
            .merge_usage_facts(&[make_item(&today, 10, "codex", "codex_local", "gpt-5", 100)], "now")
            .unwrap();

        let summary = store.summary("all", &UsageFilters::default()).unwrap();
        assert_eq!(summary["totals"]["totalTokens"], json!(3100));

        let august = store
            .summary("2026-08-16..2026-08-17", &UsageFilters::default())
            .unwrap();
        assert_eq!(august["totals"]["totalTokens"], json!(3000));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn merge_usage_facts_preserves_provider_missing_from_scan() {
        let (mut store, path) = temp_db();
        let today = crate::date::local_day();
        store
            .merge_usage_facts(
                &[
                    make_item(&today, 10, "codex", "codex_local", "gpt-5", 100),
                    make_item(&today, 10, "kimi", "kimi_local", "kimi-k2", 700),
                ],
                "now",
            )
            .unwrap();

        // kimi provider disappeared from the scan entirely (disabled, or its
        // source errored with zero rows) — its collected history stays.
        store
            .merge_usage_facts(&[make_item(&today, 10, "codex", "codex_local", "gpt-5", 100)], "now")
            .unwrap();

        let by_provider = UsageFilters {
            provider: Some("kimi".to_string()),
            ..Default::default()
        };
        let summary = store.summary("all", &by_provider).unwrap();
        assert_eq!(summary["totals"]["totalTokens"], json!(700));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn zcode_ledger_preserves_requests_pruned_inside_an_active_hour() {
        let (mut store, path) = temp_db();
        let day = "2026-08-22";
        let old = make_item(day, 11, "zcode", "zcode_local", "glm", 1000);
        store.merge_usage_facts(&[old], "before").unwrap();
        let mut surviving = make_item(day, 11, "zcode", "zcode_local", "glm", 400);
        surviving["_localRequestId"] = json!("survivor");

        // 600 tokens were pruned before migration. The residual keeps them.
        store.ingest_zcode_requests(&[surviving.clone()], "first").unwrap();
        assert_eq!(store.summary("all", &UsageFilters::default()).unwrap()["totals"]["totalTokens"], 1000);
        store.ingest_zcode_requests(&[surviving.clone()], "second").unwrap();
        assert_eq!(store.summary("all", &UsageFilters::default()).unwrap()["totals"]["totalTokens"], 1000);

        surviving["totalTokens"] = json!(450);
        surviving["inputTokens"] = json!(250);
        surviving["outputTokens"] = json!(100);
        surviving["cacheReadTokens"] = json!(50);
        surviving["cacheWriteTokens"] = json!(50);
        store.ingest_zcode_requests(&[surviving], "corrected").unwrap();
        assert_eq!(store.summary("all", &UsageFilters::default()).unwrap()["totals"]["totalTokens"], 1050);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn zcode_ledger_reattributes_a_known_request_without_double_counting() {
        let (mut store, path) = temp_db();
        let mut request = make_item("2026-09-22", 12, "zcode", "zcode_local", "old", 300);
        request["_localRequestId"] = json!("request-1");
        store.ingest_zcode_requests(&[request.clone()], "first").unwrap();
        request["model"] = json!("new");
        store.ingest_zcode_requests(&[request], "second").unwrap();
        let all = store.all_usage_items().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0]["model"], "new");
        assert_eq!(all[0]["totalTokens"], 300);
        store.ingest_zcode_requests(&[], "third").unwrap();
        assert_eq!(store.all_usage_items().unwrap()[0]["totalTokens"], 300);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn zcode_migration_refuses_unrelated_workdir_identity() {
        let (mut store, path) = temp_db();
        let old = make_item("2026-08-22", 11, "zcode", "zcode_local", "glm", 1000);
        store.merge_usage_facts(&[old], "before").unwrap();
        let requests = (0..10).map(|index| {
            let mut item = make_item("2026-08-22", 11, "zcode", "zcode_local", "glm", 10);
            item["workdirHash"] = json!("different-identity");
            item["_localRequestId"] = json!(format!("r{}", index));
            item
        }).collect::<Vec<_>>();
        assert!(store.ingest_zcode_requests(&requests, "now").unwrap_err().contains("migration rejected"));
        assert_eq!(store.all_usage_items().unwrap()[0]["totalTokens"], 1000);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn source_cache_empty_fingerprint_skipped() {
        let (mut store, path) = temp_db();
        let item = make_item("2026-05-10", 10, "codex", "codex_local", "gpt-5", 100);
        let mut cache = HashMap::new();
        cache.insert("".to_string(), vec![item.clone()]);
        cache.insert("valid_fp".to_string(), vec![item]);

        store.replace_source_cache(&cache, "now").unwrap();
        assert!(store.take_cached_source("").is_none());
        assert!(store.take_cached_source("valid_fp").is_some());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn clear_source_cache_removes_cached_sources_only() {
        let (mut store, path) = temp_db();
        let item = make_item("2026-05-10", 10, "codex", "codex_local", "gpt-5", 100);

        store
            .replace_source_cache(
                &HashMap::from([("valid_fp".to_string(), vec![item.clone()])]),
                "now",
            )
            .unwrap();
        store.merge_usage_facts(&[item], "now").unwrap();

        store.clear_source_cache().unwrap();

        assert!(store.take_cached_source("valid_fp").is_none());
        assert!(store.has_usage_facts().unwrap());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn scoped_merge_skips_unchanged_scopes() {
        let (mut store, path) = temp_db();
        let day_a = make_item("2026-05-10", 10, "codex", "codex_local", "gpt-5", 100);
        let day_b = make_item("2026-05-11", 11, "codex", "codex_local", "gpt-5", 200);
        store
            .merge_usage_facts(&[day_a.clone(), day_b.clone()], "t1")
            .unwrap();

        // Scope B's source changed; scope A is untouched.
        let mut changed_b = day_b.clone();
        changed_b["totalTokens"] = json!(999);
        let dirty = std::collections::BTreeSet::from([item_scope(&day_b)]);
        store
            .merge_usage_facts_scoped(&[day_a, changed_b], &dirty, "t2")
            .unwrap();

        let items = store.all_usage_items().unwrap();
        let by_day: std::collections::HashMap<String, Value> = items
            .into_iter()
            .map(|item| (str_field(&item, "day"), item))
            .collect();
        assert_eq!(by_day["2026-05-11"]["totalTokens"], json!(999));
        // Untouched scope keeps its rows (and its original scannedAt).
        assert_eq!(by_day["2026-05-10"]["totalTokens"], json!(100));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn replace_source_cache_stamps_and_dirty_scopes_track_changes() {
        let (mut store, path) = temp_db();
        let item_a = make_item("2026-05-10", 10, "codex", "codex_local", "gpt-5", 100);
        let fp_a = "fp_a".to_string();
        store
            .replace_source_cache(&HashMap::from([(fp_a.clone(), vec![item_a.clone()])]), "t1")
            .unwrap();
        assert!(!store.incremental_merge_ready(), "stamp must wait for a merge");

        store.merge_usage_facts(&[item_a.clone()], "t1").unwrap();
        store
            .replace_source_cache(&HashMap::from([(fp_a.clone(), vec![item_a])]), "t2")
            .unwrap();
        store.mark_incremental_merge_ready().unwrap();
        assert!(store.incremental_merge_ready());

        // Same fingerprints => nothing dirty.
        let same = HashMap::from([(fp_a.clone(), vec![make_item("2026-05-10", 10, "codex", "codex_local", "gpt-5", 100)])]);
        assert!(store.dirty_scopes_for_scan(&same).unwrap().unwrap().is_empty());

        // A new fingerprint marks its scopes dirty; a dropped fingerprint
        // disappears from the cache.
        let item_b = make_item("2026-05-11", 9, "claude", "claude_code_local", "sonnet", 50);
        let next = HashMap::from([
            (fp_a, vec![make_item("2026-05-10", 10, "codex", "codex_local", "gpt-5", 100)]),
            ("fp_b".to_string(), vec![item_b]),
        ]);
        let dirty = store.dirty_scopes_for_scan(&next).unwrap().unwrap();
        assert_eq!(dirty.len(), 1);
        assert!(dirty.contains(&("2026-05-11".to_string(), 9, "claude_code_local".to_string())));
        let _ = std::fs::remove_file(path);
    }

    fn usage_fact_scanned_at(store: &LocalUsageStore, day: &str, hour: i64) -> String {
        store
            .conn
            .query_row(
                "SELECT scannedAt FROM usage_fact WHERE day = ?1 AND hour = ?2",
                params![day, hour],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
    }

    #[test]
    fn v1_zcode_table_migrates_day_hour_hash() {
        // A store written by schema v1 (no day/hour/requestHash columns, no
        // scope index) must migrate on open — the schema batch must not
        // reference the new columns before the ALTERs add them.
        let unique = format!(
            "{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            std::process::id()
        );
        let path = std::env::temp_dir().join(format!("atl-lus-mig-{unique}.sqlite3"));
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE zcode_request_fact (
                   requestId TEXT PRIMARY KEY,
                   itemJson TEXT NOT NULL
                 );",
            )
            .unwrap();
            let mut item = make_item("2026-08-01", 9, "zcode", "zcode_local", "glm", 42);
            item.as_object_mut().unwrap().remove("_localRequestId");
            conn.execute(
                "INSERT INTO zcode_request_fact (requestId, itemJson) VALUES (?1, ?2)",
                params!["r1", item.to_string()],
            )
            .unwrap();
        }
        let store = LocalUsageStore::open(path.clone()).unwrap();
        let (day, hour, hash): (String, i64, Option<String>) = store
            .conn
            .query_row(
                "SELECT day, hour, requestHash FROM zcode_request_fact WHERE requestId = 'r1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((day.as_str(), hour), ("2026-08-01", 9));
        assert!(hash.is_some());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn scoped_non_zcode_merge_never_touches_zcode_scopes() {
        // The zcode source fingerprint is file-level: one changed day marks
        // every zcode scope dirty. The non-zcode merge must ignore those
        // scopes — it has no zcode rows to reinsert, so deleting them would
        // erase history only a full ledger rebuild used to restore.
        let (mut store, path) = temp_db();
        let zcode_day = make_item("2026-10-20", 8, "zcode", "zcode_local", "glm", 500);
        let codex_day = make_item("2026-10-21", 9, "codex", "codex_local", "gpt-5", 100);
        store
            .merge_usage_facts(&[zcode_day.clone(), codex_day.clone()], "t1")
            .unwrap();

        let dirty = std::collections::BTreeSet::from([
            item_scope(&zcode_day),
            item_scope(&codex_day),
        ]);
        store
            .merge_non_zcode_facts_scoped(&[zcode_day, codex_day], &dirty, "t2")
            .unwrap();

        let items = store.all_usage_items().unwrap();
        let zcode_tokens: i64 = items
            .iter()
            .filter(|item| str_field(item, "providerId") == "zcode_local")
            .map(|item| i64_field(item, "totalTokens"))
            .sum();
        assert_eq!(zcode_tokens, 500, "zcode rows must survive a scoped non-zcode merge");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn zcode_incremental_rebuilds_scopes_missing_from_usage_fact() {
        let (mut store, path) = temp_db();
        let mut request = make_item("2026-09-22", 12, "zcode", "zcode_local", "glm", 300);
        request["_localRequestId"] = json!("request-1");
        store.ingest_zcode_requests(&[request.clone()], "t1").unwrap();
        // Simulate lost aggregate rows (buggy/interrupted run).
        store
            .conn
            .execute("DELETE FROM usage_fact WHERE providerId = 'zcode_local'", [])
            .unwrap();

        store.ingest_zcode_requests(&[request], "t2").unwrap();

        let tokens: i64 = store
            .all_usage_items()
            .unwrap()
            .iter()
            .filter(|item| str_field(item, "providerId") == "zcode_local")
            .map(|item| i64_field(item, "totalTokens"))
            .sum();
        assert_eq!(tokens, 300, "missing scopes must self-heal from the request ledger");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn zcode_request_moving_across_hours_recomputes_the_old_scope() {
        // A retry's winning attempt can carry a different started_at, moving
        // the request to another hour. The incremental ingest must recompute
        // the PREVIOUS hour's aggregate too, or the request double-counts.
        let (mut store, path) = temp_db();
        let mut request = make_item("2026-09-22", 10, "zcode", "zcode_local", "glm", 300);
        request["_localRequestId"] = json!("request-1");
        store.ingest_zcode_requests(&[request.clone()], "t1").unwrap();

        let mut moved = request.clone();
        moved["hour"] = json!(11);
        store.ingest_zcode_requests(&[moved], "t2").unwrap();

        let by_hour: std::collections::HashMap<i64, i64> = store
            .all_usage_items()
            .unwrap()
            .into_iter()
            .map(|item| (i64_field(&item, "hour"), i64_field(&item, "totalTokens")))
            .collect();
        assert!(by_hour.get(&10).is_none(), "old hour must be recomputed (empty aggregate -> no row)");
        assert_eq!(by_hour.get(&11), Some(&300), "new hour holds the request");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn zcode_incremental_reingest_of_identical_requests_is_a_no_op() {
        let (mut store, path) = temp_db();
        let mut request = make_item("2026-09-22", 12, "zcode", "zcode_local", "glm", 300);
        request["_localRequestId"] = json!("request-1");
        store.ingest_zcode_requests(&[request.clone()], "t1").unwrap();

        store.ingest_zcode_requests(&[request], "t2").unwrap();

        // Identical content hash: no upsert, no aggregate rebuild — the row
        // keeps its first scannedAt.
        assert_eq!(usage_fact_scanned_at(&store, "2026-09-22", 12), "t1");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn zcode_incremental_recomputes_only_the_changed_scope() {
        let (mut store, path) = temp_db();
        let mut r1 = make_item("2026-09-22", 12, "zcode", "zcode_local", "glm", 300);
        r1["_localRequestId"] = json!("request-1");
        let mut r2 = make_item("2026-09-23", 13, "zcode", "zcode_local", "glm", 500);
        r2["_localRequestId"] = json!("request-2");
        store.ingest_zcode_requests(&[r1.clone(), r2.clone()], "t1").unwrap();

        // Only day-23's request changed; day-22 keeps its aggregate row.
        let mut r2_changed = r2.clone();
        r2_changed["totalTokens"] = json!(800);
        r2_changed["inputTokens"] = json!(400);
        r2_changed["outputTokens"] = json!(200);
        r2_changed["cacheReadTokens"] = json!(100);
        r2_changed["cacheWriteTokens"] = json!(100);
        store.ingest_zcode_requests(&[r1, r2_changed], "t2").unwrap();

        let rows = store.all_usage_items().unwrap();
        let by_day: std::collections::HashMap<String, Value> = rows
            .into_iter()
            .map(|item| (str_field(&item, "day"), item))
            .collect();
        assert_eq!(by_day["2026-09-23"]["totalTokens"], json!(800));
        assert_eq!(usage_fact_scanned_at(&store, "2026-09-23", 13), "t2");
        assert_eq!(by_day["2026-09-22"]["totalTokens"], json!(300));
        assert_eq!(usage_fact_scanned_at(&store, "2026-09-22", 12), "t1");
        let _ = std::fs::remove_file(path);
    }
}
