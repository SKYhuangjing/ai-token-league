use crate::config;
use crate::scanner::SourceCache;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

const DB_SCHEMA_VERSION: i64 = 1;

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
        let store = Self { conn };
        store.init()?;
        Ok(store)
    }

    fn init(&self) -> Result<(), String> {
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
                "#,
            )
            .map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('schemaVersion', ?)",
                params![DB_SCHEMA_VERSION.to_string()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
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
                let text = serde_json::to_string(items).map_err(|e| e.to_string())?;
                stmt.execute(params![fingerprint, text, scanned_at, scanned_at])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn replace_usage_facts(&mut self, items: &[Value], scanned_at: &str) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM usage_fact", [])
            .map_err(|e| e.to_string())?;
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
        tx.commit().map_err(|e| e.to_string())
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
        Ok(self.row_count(None, None)? > 0)
    }

    pub fn summary(&self, range: &str) -> Result<Value, String> {
        let (from, to) = range_bounds(range);
        let rows = self.group_breakdown("providerId", from.as_deref(), to.as_deref(), 5)?;
        let workdirs =
            self.group_breakdown("workdirDisplayName", from.as_deref(), to.as_deref(), 10)?;
        let models = self.group_breakdown("model", from.as_deref(), to.as_deref(), 10)?;
        let totals = self.totals(from.as_deref(), to.as_deref())?;
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

    pub fn workdirs(&self, range: &str, limit: i64) -> Result<Value, String> {
        let (from, to) = range_bounds(range);
        let mut params = bounds_params(from.as_deref(), to.as_deref());
        let limit = limit.clamp(1, 500);
        params.push(limit.to_string());
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
            where_clause(from.as_deref(), to.as_deref())
        );
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

    pub fn trend(&self, range: &str, grain: &str) -> Result<Value, String> {
        let (from, to) = range_bounds(range);
        let sql = match grain {
            "hour" => {
                "SELECT day || 'T' || printf('%02d', hour) AS bucket, day AS periodStart, day AS periodEnd, hour, SUM(inputTokens), SUM(outputTokens), SUM(cacheReadTokens), SUM(cacheWriteTokens), SUM(reasoningTokens), SUM(totalTokens) FROM usage_fact"
            }
            "month" => {
                "SELECT substr(day, 1, 7) AS bucket, substr(day, 1, 7) || '-01' AS periodStart, substr(day, 1, 7) || '-01' AS periodEnd, NULL AS hour, SUM(inputTokens), SUM(outputTokens), SUM(cacheReadTokens), SUM(cacheWriteTokens), SUM(reasoningTokens), SUM(totalTokens) FROM usage_fact"
            }
            _ => {
                "SELECT day AS bucket, day AS periodStart, day AS periodEnd, NULL AS hour, SUM(inputTokens), SUM(outputTokens), SUM(cacheReadTokens), SUM(cacheWriteTokens), SUM(reasoningTokens), SUM(totalTokens) FROM usage_fact"
            }
        };
        let mut sql = format!("{} {}", sql, where_clause(from.as_deref(), to.as_deref()));
        sql.push_str(match grain {
            "hour" => " GROUP BY day, hour ORDER BY day, hour",
            "month" => " GROUP BY substr(day, 1, 7) ORDER BY substr(day, 1, 7)",
            _ => " GROUP BY day ORDER BY day",
        });
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let params = bounds_params(from.as_deref(), to.as_deref());
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

    pub fn detail_window(&self, range: &str, offset: i64, limit: i64) -> Result<Value, String> {
        let (from, to) = range_bounds(range);
        let mut sql = format!(
            "SELECT day, hour, toolCode, providerId, workdirHash, workdirDisplayName, model,
                    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                    reasoningTokens, totalTokens, sourceQuality, rawSourceRef, providerVersion,
                    parserVersion, sourceFingerprint
             FROM usage_fact {}",
            where_clause(from.as_deref(), to.as_deref())
        );
        sql.push_str(" ORDER BY day DESC, totalTokens DESC LIMIT ? OFFSET ?");
        let mut params = bounds_params(from.as_deref(), to.as_deref());
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
        let total_rows = self.row_count(from.as_deref(), to.as_deref())?;
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

    fn totals(&self, from: Option<&str>, to: Option<&str>) -> Result<Value, String> {
        let sql = format!(
            "SELECT COUNT(*), COALESCE(SUM(inputTokens), 0), COALESCE(SUM(outputTokens), 0),
                    COALESCE(SUM(cacheReadTokens), 0), COALESCE(SUM(cacheWriteTokens), 0),
                    COALESCE(SUM(reasoningTokens), 0), COALESCE(SUM(totalTokens), 0)
             FROM usage_fact {}",
            where_clause(from, to)
        );
        self.conn
            .query_row(
                &sql,
                rusqlite::params_from_iter(bounds_params(from, to).iter()),
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

    fn row_count(&self, from: Option<&str>, to: Option<&str>) -> Result<i64, String> {
        let sql = format!("SELECT COUNT(*) FROM usage_fact {}", where_clause(from, to));
        self.conn
            .query_row(
                &sql,
                rusqlite::params_from_iter(bounds_params(from, to).iter()),
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
    }

    fn group_breakdown(
        &self,
        field: &str,
        from: Option<&str>,
        to: Option<&str>,
        limit: i64,
    ) -> Result<Vec<Value>, String> {
        let sql = format!(
            "SELECT {field}, COALESCE(SUM(totalTokens), 0), COUNT(*)
             FROM usage_fact {}
             GROUP BY {field}
             ORDER BY COALESCE(SUM(totalTokens), 0) DESC
             LIMIT ?",
            where_clause(from, to)
        );
        let mut params = bounds_params(from, to);
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

fn where_clause(from: Option<&str>, to: Option<&str>) -> &'static str {
    match (from, to) {
        (Some(_), Some(_)) => "WHERE day BETWEEN ? AND ?",
        (Some(_), None) => "WHERE day >= ?",
        (None, Some(_)) => "WHERE day <= ?",
        (None, None) => "",
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

    #[test]
    fn local_usage_store_roundtrips_cache_and_facts() {
        let path = std::env::temp_dir().join(format!(
            "atl-local-usage-{}.sqlite3",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut store = LocalUsageStore::open(path.clone()).unwrap();
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
        store.replace_usage_facts(&[item], "now").unwrap();
        assert_eq!(
            store.summary("today").unwrap()["totals"]["totalTokens"],
            150
        );
        assert_eq!(store.detail_window("today", 0, 10).unwrap()["totalRows"], 1);
        let _ = std::fs::remove_file(path);
    }
}
