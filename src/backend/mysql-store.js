import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { Store } from "./store.js";
import { newId } from "../shared/crypto.js";
import { dominantComposition, tokenCompositionSummary } from "../shared/composition.js";
import { normalizeModelName } from "../shared/pricing.js";
import { addDays, dayToUtcDate, daysBetween, localDay, utcDateToDay } from "../shared/date.js";
import { CLOUD_PROVIDER_IDS, computeBucketFingerprint, computeDailyBucketFingerprint, displayTotalTokens } from "../shared/schema.js";
import { fetchOpenRouterModelPrices } from "./openrouter-pricing.js";

const MIGRATION_PATH = path.resolve("migrations/001_init_mysql.sql");
const MIGRATION_002_PATH = path.resolve("migrations/002_usage_hourly.sql");

export class MySqlStore extends Store {
  static async create(config = {}) {
    const store = new MySqlStore(config);
    await store.connect();
    await store.migrate();
    await store.load();
    return store;
  }

  constructor(config = {}) {
    super("mysql", { persist: false });
    this.dbType = "mysql";
    const requestedLimit = Number(config.connectionLimit ?? process.env.MYSQL_CONNECTION_LIMIT ?? 8) || 8;
    const rawLockName = config.writeLockName ?? process.env.MYSQL_WRITE_LOCK_NAME ?? "";
    const database = config.database || process.env.MYSQL_DATABASE || "ai_token_league";
    const effectiveLockName = normalizeMysqlLockName(
      rawLockName || `ai-token-league:${database}:write`
    );
    const lockEnabled = effectiveLockName.length > 0;
    const timeoutSource = config.writeLockTimeoutSeconds ?? process.env.MYSQL_WRITE_LOCK_TIMEOUT_SECONDS;
    const writeLockTimeoutSeconds = timeoutSource === undefined || timeoutSource === ""
      ? 30
      : Math.max(0, Number(timeoutSource) || 0);
    this.config = {
      uri: config.uri || process.env.MYSQL_URL || "",
      host: config.host || process.env.MYSQL_HOST || "127.0.0.1",
      port: Number(config.port || process.env.MYSQL_PORT || 3306),
      user: config.user || process.env.MYSQL_USER || "ai_token",
      password: config.password || process.env.MYSQL_PASSWORD || "ai_token",
      database,
      // The named lock pins one pool connection for the entire write critical section.
      // The actual write transaction then asks the same pool for ANOTHER connection.
      // With connectionLimit=1 that second getConnection() would deadlock against the
      // lock holder, so we floor at 2 whenever the named lock is effectively enabled
      // (including the auto-derived default — runtime always uses the normalized name).
      connectionLimit: lockEnabled
        ? Math.max(2, requestedLimit)
        : Math.max(1, requestedLimit),
      writeLockName: effectiveLockName,
      writeLockTimeoutSeconds
    };
    this.writeLock = Promise.resolve();
  }

  async connect() {
    const base = this.config.uri
      ? { uri: this.config.uri }
      : {
          host: this.config.host,
          port: this.config.port,
          user: this.config.user,
          password: this.config.password,
          database: this.config.database
        };
    this.pool = mysql.createPool({
      ...base,
      waitForConnections: true,
      connectionLimit: this.config.connectionLimit,
      namedPlaceholders: true,
      multipleStatements: true,
      charset: "utf8mb4"
    });
  }

  async migrate() {
    if (String(process.env.MYSQL_AUTO_MIGRATE || "true").toLowerCase() === "false") return;
    const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
    await this.pool.query(sql);
    if (fs.existsSync(MIGRATION_002_PATH)) {
      const sql2 = fs.readFileSync(MIGRATION_002_PATH, "utf8");
      for (const stmt of sql2.split(";").map(s => s.trim()).filter(s => s.length > 0)) {
        await this.pool.query(stmt);
      }
    }
    await this.ensureMysqlSchema();
  }

  async ensureMysqlSchema() {
    const [columns] = await this.pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usage_daily' AND COLUMN_NAME = 'pricingSource'`
    );
    if (!columns.length) {
      await this.pool.query("ALTER TABLE usage_daily ADD COLUMN pricingSource VARCHAR(64) NOT NULL DEFAULT '' AFTER pricingModel");
    }
    const [lanIpColumns] = await this.pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'lanIp'`
    );
    if (!lanIpColumns.length) {
      await this.pool.query("ALTER TABLE devices ADD COLUMN lanIp VARCHAR(256) NOT NULL DEFAULT '' AFTER appVersion");
    }
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS model_price_aliases (
        model VARCHAR(190) PRIMARY KEY,
        targetModel VARCHAR(190) NOT NULL,
        updatedAt VARCHAR(40) NOT NULL,
        INDEX idx_model_price_alias_target (targetModel)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS app_meta (
        metaKey VARCHAR(96) PRIMARY KEY,
        metaValue VARCHAR(512) NOT NULL,
        updatedAt VARCHAR(40) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    const now = new Date().toISOString();
    await this.pool.query(
      "INSERT IGNORE INTO app_meta (metaKey, metaValue, updatedAt) VALUES (?, ?, ?)",
      ["serverInstanceId", newId("srv"), now]
    );
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS usage_sync_buckets (
        bucketKey VARCHAR(512) PRIMARY KEY,
        participantId VARCHAR(96) NOT NULL,
        deviceId VARCHAR(96) NOT NULL,
        day DATE NOT NULL,
        providerId VARCHAR(96) NOT NULL,
        granularity VARCHAR(16) NOT NULL DEFAULT 'daily',
        bucketFingerprint VARCHAR(128) NOT NULL,
        rowCount INT NOT NULL,
        totalTokens BIGINT NOT NULL,
        clientGeneratedAt VARCHAR(40) NOT NULL,
        syncedAt VARCHAR(40) NOT NULL,
        updatedAt VARCHAR(40) NOT NULL,
        UNIQUE INDEX idx_sync_bucket_scope (participantId, deviceId, day, providerId),
        INDEX idx_sync_bucket_participant_day (participantId, day)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    const [bucketGranularityColumns] = await this.pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usage_sync_buckets' AND COLUMN_NAME = 'granularity'`
    );
    if (!bucketGranularityColumns.length) {
      await this.pool.query("ALTER TABLE usage_sync_buckets ADD COLUMN granularity VARCHAR(16) NOT NULL DEFAULT 'daily' AFTER providerId");
    }
    await ensureIndex(this.pool, "usage_daily", "idx_usage_device_day", "CREATE INDEX idx_usage_device_day ON usage_daily (deviceId, day)");
    await ensureIndex(this.pool, "usage_daily", "idx_usage_daily_scope", "CREATE INDEX idx_usage_daily_scope ON usage_daily (participantId, deviceId, day, providerId)");
    await ensureIndex(this.pool, "usage_hourly", "idx_hourly_scope", "CREATE INDEX idx_hourly_scope ON usage_hourly (participantId, deviceId, day, hour, providerId)");
  }

  async load() {
    const [participants] = await this.pool.query("SELECT * FROM participants");
    const [devices] = await this.pool.query("SELECT * FROM devices");
    const [workdirs] = await this.pool.query("SELECT * FROM workdirs");
    const [modelPrices] = await this.pool.query("SELECT * FROM model_prices");
    const [modelPriceAliases] = await this.pool.query("SELECT * FROM model_price_aliases");
    const [modelPriceCache] = await this.pool.query("SELECT * FROM model_price_cache");
    const [modelPriceCacheMeta] = await this.pool.query("SELECT * FROM model_price_cache_meta WHERE source = 'openrouter'");
    this.db.participants = Object.fromEntries(participants.map((row) => [row.id, normalizeRow(row)]));
    this.db.devices = Object.fromEntries(devices.map((row) => [row.id, normalizeRow(row)]));
    this.db.workdirs = Object.fromEntries(workdirs.map((row) => [row.id, normalizeRow(row)]));
    this.db.usageDaily = {};
    this.db.uploadBatches = {};
    this.db.modelPrices = Object.fromEntries(modelPrices.map((row) => [row.model, priceFromRow(row)]));
    this.db.modelPriceAliases = Object.fromEntries(modelPriceAliases.map((row) => [row.model, row.targetModel]));
    this.db.modelPriceCache = {
      remote: modelPriceCacheMeta[0] ? normalizeRow(modelPriceCacheMeta[0]) : this.db.modelPriceCache.remote,
      prices: Object.fromEntries(modelPriceCache.map((row) => [row.model, cachedPriceFromRow(row)]))
    };
    this.db.aggregateCache = {};
    this.db.usageSyncBuckets = {};
    this.db.usageHourly = {};
    this.db.usageSyncBucketsHourly = {};
  }

  async registerDevice(input) {
    return this.withWriteLock(async () => {
      const result = super.registerDevice(input);
      await this.syncIdentityTables();
      return result;
    });
  }

  async upsertUsageBatch(input) {
    return this.withWriteLock(async () => {
      if (input.snapshot?.mode === "device_day_hour_provider") {
        if (this.pool) await this.loadWriteScope(input.participantId, input.deviceId, input.snapshot);
        const result = Store.prototype.upsertUsageBatch.call(this, input);
        if (result.noOp) return result;
        try {
          await this.incrementalHourlyBucketSync(input, result);
        } catch (error) {
          await this.load();
          throw error;
        }
        return result;
      }
      if (input.snapshot) {
        if (this.pool) await this.loadWriteScope(input.participantId, input.deviceId, input.snapshot);
        return this.upsertSnapshotBatch(input);
      }
      if (this.pool) await this.loadUsageMirrorForMaintenance();
      const previousUsageKeys = new Set(Object.keys(this.db.usageDaily || {}));
      const result = super.upsertUsageBatch(input);
      if (!result.duplicate) await this.syncLegacyUsageMirror(previousUsageKeys);
      return result;
    });
  }

  async withWriteLock(fn) {
    const previous = this.writeLock;
    let release;
    this.writeLock = new Promise((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    let mysqlLock = null;
    try {
      mysqlLock = await this.acquireMysqlWriteLock();
      return await fn();
    } finally {
      try {
        this.resetUsageWorkingState();
      } catch (resetError) {
        console.error("[mysql-store] failed to reset usage working state", resetError);
      }
      try {
        await mysqlLock?.release();
      } finally {
        release();
      }
    }
  }

  resetUsageWorkingState() {
    this.db.usageDaily = {};
    this.db.usageHourly = {};
    this.db.usageSyncBuckets = {};
    this.db.usageSyncBucketsHourly = {};
    this.db.uploadBatches = {};
    this.invalidateAggregateCache();
  }

  async acquireMysqlWriteLock() {
    if (!this.pool?.getConnection || !this.config.writeLockName) return null;
    const conn = await this.pool.getConnection();
    let acquired = false;
    try {
      const [rows] = await conn.query(
        "SELECT GET_LOCK(?, ?) AS acquired",
        [this.config.writeLockName, this.config.writeLockTimeoutSeconds]
      );
      if (mysqlLockUnsupported(rows)) {
        conn.release();
        return null;
      }
      acquired = mysqlLockAcquired(rows);
      if (!acquired) {
        throw new Error(`Timed out acquiring MySQL write lock: ${this.config.writeLockName}`);
      }
      return {
        release: async () => {
          let releaseFailed = false;
          try {
            await conn.query("SELECT RELEASE_LOCK(?) AS released", [this.config.writeLockName]);
          } catch (error) {
            releaseFailed = true;
            conn.destroy?.();
            throw error;
          } finally {
            if (!releaseFailed) conn.release();
          }
        }
      };
    } catch (error) {
      if (!acquired) conn.release();
      throw error;
    }
  }

  async loadWriteScope(participantId, deviceId, snapshot = {}) {
    const day = toDayString(snapshot.day);
    const providerId = snapshot.providerId || "";
    if (!this.pool || !participantId || !deviceId || !day || !providerId) return;
    const [dailyRows] = await this.pool.query(
      "SELECT * FROM usage_daily WHERE participantId = ? AND day = ? AND providerId = ?",
      [participantId, day, providerId]
    );
    const [hourlyRows] = await this.pool.query(
      "SELECT * FROM usage_hourly WHERE participantId = ? AND day = ? AND providerId = ?",
      [participantId, day, providerId]
    ).catch(() => [[]]);
    const [dailyBuckets] = await this.pool.query(
      "SELECT * FROM usage_sync_buckets WHERE participantId = ? AND day = ? AND providerId = ?",
      [participantId, day, providerId]
    ).catch(() => [[]]);
    const [hourlyBuckets] = await this.pool.query(
      "SELECT * FROM usage_sync_buckets_hourly WHERE participantId = ? AND day = ? AND providerId = ?",
      [participantId, day, providerId]
    ).catch(() => [[]]);
    this.db.usageDaily = Object.fromEntries(dailyRows.map((row) => [row.usageKey, usageFromRow(row)]));
    this.db.usageHourly = Object.fromEntries(hourlyRows.map((row) => [row.usageKey, usageFromRow(row)]));
    this.db.usageSyncBuckets = Object.fromEntries(dailyBuckets.map((row) => [row.bucketKey, normalizeRow(row)]));
    this.db.usageSyncBucketsHourly = Object.fromEntries(hourlyBuckets.map((row) => [row.bucketKey, normalizeRow(row)]));
    this.invalidateAggregateCache();
  }

  async loadUsageMirrorForMaintenance() {
    if (!this.pool) return;
    const [usageRows] = await this.pool.query("SELECT * FROM usage_daily");
    const [usageHourlyRows] = await this.pool.query("SELECT * FROM usage_hourly").catch(() => [[]]);
    const [syncBuckets] = await this.pool.query("SELECT * FROM usage_sync_buckets").catch(() => [[]]);
    const [syncBucketsHourly] = await this.pool.query("SELECT * FROM usage_sync_buckets_hourly").catch(() => [[]]);
    const [uploadBatches] = await this.pool.query("SELECT * FROM upload_batches").catch(() => [[]]);
    this.db.usageDaily = Object.fromEntries(usageRows.map((row) => [row.usageKey, usageFromRow(row)]));
    this.db.usageHourly = Object.fromEntries(usageHourlyRows.map((row) => [row.usageKey, usageFromRow(row)]));
    this.db.usageSyncBuckets = Object.fromEntries(syncBuckets.map((row) => [row.bucketKey, normalizeRow(row)]));
    this.db.usageSyncBucketsHourly = Object.fromEntries(syncBucketsHourly.map((row) => [row.bucketKey, normalizeRow(row)]));
    this.db.uploadBatches = Object.fromEntries(uploadBatches.map((row) => [row.payloadHash, normalizeRow(row)]));
    this.invalidateAggregateCache();
  }

  async loadUsageDailyForModels(models = []) {
    if (!this.pool) return;
    const normalizedModels = [...new Set((models || []).map((model) => normalizeModelName(model)).filter(Boolean))];
    if (!normalizedModels.length) {
      this.db.usageDaily = {};
      this.invalidateAggregateCache();
      return;
    }
    const [usageRows] = await this.pool.query(
      `SELECT * FROM usage_daily WHERE model IN (${normalizedModels.map(() => "?").join(",")})`,
      normalizedModels
    );
    this.db.usageDaily = Object.fromEntries(usageRows.map((row) => [row.usageKey, usageFromRow(row)]));
    this.invalidateAggregateCache();
  }

  async usageRowsForQuery({ period = "", range = "today", startDay = "", endDay = "", participantId = "", tool = "all" } = {}) {
    const { whereSql, params } = this.mysqlUsageScope({ period, range, startDay, endDay, participantId, tool });
    const sql = `SELECT * FROM usage_daily${whereSql}`;
    const [rows] = await this.pool.query(sql, params);
    return rows.map(usageFromRow);
  }

  mysqlUsageScope({ period = "", range = "today", startDay = "", endDay = "", participantId = "", tool = "all" } = {}, alias = "") {
    const days = mysqlDaysForQuery({ period, range, startDay, endDay }, { businessDay: this.currentBusinessDay() });
    const prefix = alias ? `${alias}.` : "";
    const where = [];
    const params = [];
    if (days) {
      const dayPredicate = mysqlDayPredicate(days, prefix);
      if (dayPredicate.sql) {
        where.push(dayPredicate.sql);
        params.push(...dayPredicate.params);
      }
    }
    if (participantId) {
      where.push(`${prefix}participantId = ?`);
      params.push(participantId);
    }
    if (tool && tool !== "all") {
      where.push(`${prefix}toolCode = ?`);
      params.push(tool);
    }
    return {
      where,
      whereSql: where.length ? ` WHERE ${where.join(" AND ")}` : "",
      params,
      days
    };
  }

  async withScopedUsageRows(rows, fn, { useInheritedPublicLeaderboard = false } = {}) {
    const previousUsageDaily = this.db.usageDaily;
    const previousAggregateCache = this.aggregateCache;
    const previousDbAggregateCache = this.db.aggregateCache;
    const hadOwnPublicLeaderboard = Object.hasOwn(this, "publicLeaderboard");
    const previousPublicLeaderboard = this.publicLeaderboard;
    this.db.usageDaily = Object.fromEntries(rows.map((row, index) => [
      row.usageKey || [row.day, row.participantId, row.deviceId, row.toolCode, row.providerId, row.workdirHash, row.model, index].join("|"),
      row
    ]));
    this.aggregateCache = {};
    this.db.aggregateCache = {};
    if (useInheritedPublicLeaderboard) {
      this.publicLeaderboard = Store.prototype.publicLeaderboard.bind(this);
    }
    try {
      return fn();
    } finally {
      this.db.usageDaily = previousUsageDaily;
      this.aggregateCache = previousAggregateCache;
      this.db.aggregateCache = previousDbAggregateCache;
      if (useInheritedPublicLeaderboard) {
        if (hadOwnPublicLeaderboard) this.publicLeaderboard = previousPublicLeaderboard;
        else delete this.publicLeaderboard;
      }
    }
  }

  async leaderboard(args = {}) {
    const { whereSql, params } = this.mysqlUsageScope({ ...args, tool: args.tool || "all" }, "u");
    const [rows] = await this.pool.query(
      `SELECT u.participantId, p.nickname,
              COALESCE(SUM(u.totalTokens), 0) AS totalTokens,
              CASE WHEN SUM(CASE WHEN u.sourceQuality <> 'exact' THEN 1 ELSE 0 END) > 0 THEN 'partial' ELSE 'exact' END AS sourceQuality,
              MAX(u.uploadedAt) AS lastSyncedAt
       FROM usage_daily u
       JOIN participants p ON p.id = u.participantId
       ${whereSql}
       GROUP BY u.participantId, p.nickname
       ORDER BY totalTokens DESC`,
      params
    );
    const [toolRows] = await this.pool.query(
      `SELECT u.participantId, u.toolCode AS name, COALESCE(SUM(u.totalTokens), 0) AS totalTokens
       FROM usage_daily u
       ${whereSql}
       GROUP BY u.participantId, u.toolCode
       ORDER BY totalTokens DESC`,
      params
    );
    const [workdirRows] = await this.pool.query(
      `SELECT u.participantId, u.workdirDisplayName AS name, COALESCE(SUM(u.totalTokens), 0) AS totalTokens
       FROM usage_daily u
       ${whereSql}
       GROUP BY u.participantId, u.workdirDisplayName
       ORDER BY totalTokens DESC`,
      params
    );
    const toolBreakdowns = groupBreakdowns(toolRows, "participantId");
    const workdirBreakdowns = groupBreakdowns(workdirRows, "participantId");
    return rows.map((row, index) => ({
      rank: index + 1,
      participantId: row.participantId,
      nickname: row.nickname,
      totalTokens: Number(row.totalTokens || 0),
      toolBreakdown: Object.fromEntries((toolBreakdowns.get(row.participantId) || []).map((item) => [item.name, item.totalTokens])),
      workdirBreakdown: Object.fromEntries((workdirBreakdowns.get(row.participantId) || []).map((item) => [item.name, item.totalTokens])),
      sourceQuality: row.sourceQuality || "exact",
      lastSyncedAt: row.lastSyncedAt || "",
      workdirs: workdirBreakdowns.get(row.participantId) || []
    }));
  }

  async publicLeaderboard(args = {}) {
    const { whereSql, params } = this.mysqlUsageScope(args, "u");
    const includeCost = Boolean(args.includeCost);
    const [rows] = await this.pool.query(
      `SELECT u.participantId, p.nickname,
              COALESCE(SUM(u.totalTokens), 0) AS totalTokens,
              COALESCE(SUM(u.inputTokens), 0) AS inputTokens,
              COALESCE(SUM(u.outputTokens), 0) AS outputTokens,
              COALESCE(SUM(u.cacheReadTokens), 0) AS cacheReadTokens,
              COALESCE(SUM(u.cacheWriteTokens), 0) AS cacheWriteTokens,
              COALESCE(SUM(u.reasoningTokens), 0) AS reasoningTokens,
              ${mysqlCostAggregateSelect("u")}
       FROM usage_daily u
       JOIN participants p ON p.id = u.participantId
       ${whereSql}
       GROUP BY u.participantId, p.nickname
       ORDER BY totalTokens DESC`,
      params
    );
    const [modelRows] = await this.pool.query(
      `SELECT u.participantId, u.model AS name,
              COALESCE(SUM(u.totalTokens), 0) AS totalTokens,
              ${mysqlCostAggregateSelect("u")}
       FROM usage_daily u
       ${whereSql}
       GROUP BY u.participantId, u.model
       ORDER BY totalTokens DESC`,
      params
    );
    const modelBreakdowns = groupBreakdowns(modelRows, "participantId", { includeCost });
    return rows.map((row, index) => {
      const item = mysqlAggregateRow(row);
      return {
        rank: index + 1,
        participantId: row.participantId,
        nickname: row.nickname,
        totalTokens: item.totalTokens,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        cacheReadTokens: item.cacheReadTokens,
        cacheWriteTokens: item.cacheWriteTokens,
        reasoningTokens: item.reasoningTokens,
        compositionSummary: tokenCompositionSummary(item),
        dominantComposition: dominantComposition(item),
        models: modelBreakdowns.get(row.participantId) || [],
        ...(includeCost ? mysqlCostFields(row) : {})
      };
    });
  }

  async boardSummary() {
    const businessDay = this.currentBusinessDay();
    const ranges = {
      today: mysqlRangeBounds(mysqlDaysForQuery({ range: "today" }, { businessDay })),
      yesterday: mysqlRangeBounds(mysqlDaysForQuery({ range: "yesterday" }, { businessDay })),
      week: mysqlRangeBounds(mysqlDaysForQuery({ range: "this_week" }, { businessDay })),
      lastWeek: mysqlRangeBounds(mysqlDaysForQuery({ range: "last_week" }, { businessDay })),
      thisMonth: mysqlRangeBounds(mysqlDaysForQuery({ range: "this_month" }, { businessDay })),
      lastMonth: mysqlRangeBounds(mysqlDaysForQuery({ range: "last_month" }, { businessDay }))
    };
    const rangeOrder = [ranges.today, ranges.yesterday, ranges.week, ranges.lastWeek, ranges.thisMonth, ranges.lastMonth];
    const [participants] = await this.pool.query("SELECT COUNT(*) AS count FROM participants");
    const [rows] = await this.pool.query(
      `SELECT
        ${mysqlRangeSum("totalTokens", "today", ranges.today)} AS todayTokens,
        ${mysqlRangeSum("totalTokens", "yesterday", ranges.yesterday)} AS yesterdayTokens,
        ${mysqlRangeSum("totalTokens", "week", ranges.week)} AS weekTokens,
        ${mysqlRangeSum("totalTokens", "lastWeek", ranges.lastWeek)} AS lastWeekTokens,
        ${mysqlRangeSum("totalTokens", "thisMonth", ranges.thisMonth)} AS thisMonthTokens,
        ${mysqlRangeSum("totalTokens", "lastMonth", ranges.lastMonth)} AS lastMonthTokens,
        ${mysqlRangeSum("estimatedCostUsd", "today", ranges.today)} AS todayCost,
        ${mysqlRangeSum("estimatedCostUsd", "yesterday", ranges.yesterday)} AS yesterdayCost,
        ${mysqlRangeSum("estimatedCostUsd", "week", ranges.week)} AS weekCost,
        ${mysqlRangeSum("estimatedCostUsd", "lastWeek", ranges.lastWeek)} AS lastWeekCost,
        ${mysqlRangeSum("estimatedCostUsd", "thisMonth", ranges.thisMonth)} AS thisMonthCost,
       ${mysqlRangeSum("estimatedCostUsd", "lastMonth", ranges.lastMonth)} AS lastMonthCost
       FROM usage_daily`,
      [...rangeOrder, ...rangeOrder].flatMap((range) => [range.from, range.to])
    );
    const row = rows[0] || {};
    return {
      participantCount: Number(participants?.[0]?.count || 0),
      todayTokens: Number(row.todayTokens || 0),
      yesterdayTokens: Number(row.yesterdayTokens || 0),
      weekTokens: Number(row.weekTokens || 0),
      lastWeekTokens: Number(row.lastWeekTokens || 0),
      thisMonthTokens: Number(row.thisMonthTokens || 0),
      lastMonthTokens: Number(row.lastMonthTokens || 0),
      todayCost: Number(row.todayCost || 0),
      yesterdayCost: Number(row.yesterdayCost || 0),
      weekCost: Number(row.weekCost || 0),
      lastWeekCost: Number(row.lastWeekCost || 0),
      thisMonthCost: Number(row.thisMonthCost || 0),
      lastMonthCost: Number(row.lastMonthCost || 0)
    };
  }

  async usageRowsForDays(days) {
    if (!days?.length) return [];
    const [rows] = await this.pool.query(
      `SELECT * FROM usage_daily WHERE day IN (${days.map(() => "?").join(",")})`,
      days
    );
    return rows.map(usageFromRow);
  }

  async participantDetail(participantId, args = {}) {
    const rows = await this.usageRowsForQuery({ ...args, participantId });
    return this.withScopedUsageRows(
      rows,
      () => Store.prototype.participantDetail.call(this, participantId, args),
      { useInheritedPublicLeaderboard: true }
    );
  }

  async participantTrend(participantId, args = {}) {
    const participant = this.db.participants[participantId];
    if (!participant) return null;
    const effectiveArgs = { ...args, participantId, range: args.range || "last30" };
    const grain = mysqlNormalizeGrain(args.grain || "day");
    const { whereSql, params, days } = this.mysqlUsageScope(effectiveArgs, "u");
    const items = await this.mysqlAggregateUsageRows({ whereSql, params, grain, includeCost: Boolean(args.includeCost) });
    return {
      participantId,
      nickname: participant.nickname,
      grain,
      from: days?.[0] || "",
      to: days?.at(-1) || "",
      items
    };
  }

  async analytics(args = {}) {
    const businessDay = this.currentBusinessDay();
    const periodDays = mysqlDaysForQuery(args, { businessDay });
    const heatmapDays = mysqlTrailingDays(90, { businessDay });
    const unionDays = [...new Set([...periodDays, ...heatmapDays])];

    if (!unionDays.length) return Store.prototype.analytics.call(this, args);

    let sql = `SELECT * FROM usage_daily WHERE day IN (${unionDays.map(() => "?").join(",")})`;
    const params = [...unionDays];

    if (args.participantId) {
      sql += " AND participantId = ?";
      params.push(args.participantId);
    }

    const [rows] = await this.pool.query(sql, params);
    const usageRows = rows.map(usageFromRow);

    // Load hourly rows for today/yesterday to enable hourly trend chart
    const isHourly = args.period === "today" || args.period === "yesterday";
    let hourlyRows = [];
    if (isHourly && periodDays.length) {
      const targetDay = periodDays[0];
      let hSql = `SELECT * FROM usage_hourly WHERE day = ?`;
      const hParams = [targetDay];
      if (args.participantId) {
        hSql += " AND participantId = ?";
        hParams.push(args.participantId);
      }
      const [hRows] = await this.pool.query(hSql, hParams);
      hourlyRows = hRows.map(usageFromRow);
    }

    return this.withScopedUsageRows(
      usageRows,
      () => {
        if (isHourly && hourlyRows.length) {
          const previousHourly = this.db.usageHourly;
          this.db.usageHourly = Object.fromEntries(hourlyRows.map((row, i) => [
            [row.day, row.hour ?? 0, row.participantId, row.deviceId, row.providerId, row.model, i].join("|"),
            row
          ]));
          try {
            return Store.prototype.analytics.call(this, args);
          } finally {
            this.db.usageHourly = previousHourly;
          }
        }
        return Store.prototype.analytics.call(this, args);
      }
    );
  }

  async adminUsage(args = {}) {
    const effectiveArgs = { range: "month", ...args };
    const grain = mysqlNormalizeGrain(effectiveArgs.grain || "day");
    const { whereSql, params, days } = this.mysqlUsageScope(effectiveArgs, "u");
    const items = await this.mysqlAggregateUsageRows({
      whereSql,
      params,
      grain,
      includeAdminFields: true,
      includeCost: Boolean(effectiveArgs.includeCost)
    });
    return {
      grain,
      from: days?.[0] || "",
      to: days?.at(-1) || "",
      participants: Object.values(this.db.participants)
        .map((item) => ({ participantId: item.id, nickname: item.nickname }))
        .sort((a, b) => a.nickname.localeCompare(b.nickname)),
      items
    };
  }

  async adminQuality(args = {}) {
    const effectiveArgs = { range: "month", ...args };
    const rows = await this.usageRowsForQuery(effectiveArgs);
    return this.withScopedUsageRows(rows, () => Store.prototype.adminQuality.call(this, effectiveArgs));
  }

  async exportDailyCsv(args = {}) {
    const effectiveArgs = { range: "month", ...args };
    const { whereSql, params } = this.mysqlUsageScope(effectiveArgs);
    const [rows] = await this.pool.query(
      `SELECT u.day, u.participantId, u.workdirDisplayName, u.toolCode, u.providerId, u.model,
              u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.reasoningTokens, u.totalTokens,
              u.estimatedCostUsd, u.costQuality, u.sourceQuality,
              p.nickname
       FROM usage_daily u LEFT JOIN participants p ON p.id = u.participantId${whereSql}
       ORDER BY u.day, u.participantId`,
      params
    );
    return rows.map((row) => ({
      day: toDayString(row.day),
      nickname: row.nickname || row.participantId || "",
      workdirDisplayName: row.workdirDisplayName || "",
      toolCode: row.toolCode || "",
      providerId: row.providerId || "",
      model: row.model || "",
      inputTokens: Number(row.inputTokens || 0),
      outputTokens: Number(row.outputTokens || 0),
      cacheReadTokens: Number(row.cacheReadTokens || 0),
      cacheWriteTokens: Number(row.cacheWriteTokens || 0),
      reasoningTokens: Number(row.reasoningTokens || 0),
      totalTokens: Number(row.totalTokens || 0),
      estimatedCostUsd: row.estimatedCostUsd ?? "",
      costQuality: row.costQuality || "",
      sourceQuality: row.sourceQuality || ""
    }));
  }

  async missingPriceModels(args = {}) {
    const effectiveArgs = { range: "month", ...args };
    const { whereSql, params } = this.mysqlUsageScope(effectiveArgs, "u");
    const [rows] = await this.pool.query(
      `SELECT u.model,
              COALESCE(SUM(u.totalTokens), 0) AS totalTokens,
              COUNT(*) AS rowCount,
              MAX(u.uploadedAt) AS lastSeenAt
       FROM usage_daily u
       ${whereSql ? `${whereSql} AND` : "WHERE"} u.estimatedCostUsd IS NULL
       GROUP BY u.model
       ORDER BY totalTokens DESC`,
      params
    );
    const [providerRows] = await this.pool.query(
      `SELECT u.model, u.providerId AS name, COALESCE(SUM(u.totalTokens), 0) AS totalTokens
       FROM usage_daily u
       ${whereSql ? `${whereSql} AND` : "WHERE"} u.estimatedCostUsd IS NULL
       GROUP BY u.model, u.providerId
       ORDER BY totalTokens DESC`,
      params
    );
    const providers = groupBreakdowns(providerRows, "model");
    return rows.map((row) => ({
      model: row.model || "unknown",
      totalTokens: Number(row.totalTokens || 0),
      rows: Number(row.rowCount || 0),
      providers: providers.get(row.model) || [],
      lastSeenAt: row.lastSeenAt || ""
    }));
  }

  async mysqlAggregateUsageRows({ whereSql = "", params = [], grain = "day", includeAdminFields = false, includeCost = false } = {}) {
    const period = mysqlPeriodExpressions(grain, "u");
    const groupColumns = includeAdminFields
      ? `${period.groupBy}, u.participantId, p.nickname`
      : period.groupBy;
    const selectParticipant = includeAdminFields ? ", u.participantId, p.nickname" : "";
    const joinParticipant = includeAdminFields ? "JOIN participants p ON p.id = u.participantId" : "";
    const [rows] = await this.pool.query(
      `SELECT ${period.selectStart} AS periodStart,
              ${period.selectEnd} AS periodEnd
              ${selectParticipant},
              COALESCE(SUM(u.totalTokens), 0) AS totalTokens,
              COALESCE(SUM(u.inputTokens), 0) AS inputTokens,
              COALESCE(SUM(u.outputTokens), 0) AS outputTokens,
              COALESCE(SUM(u.cacheReadTokens), 0) AS cacheReadTokens,
              COALESCE(SUM(u.cacheWriteTokens), 0) AS cacheWriteTokens,
              COALESCE(SUM(u.reasoningTokens), 0) AS reasoningTokens,
              CASE WHEN SUM(CASE WHEN u.sourceQuality <> 'exact' THEN 1 ELSE 0 END) > 0 THEN 'partial' ELSE 'exact' END AS sourceQuality,
              MAX(u.uploadedAt) AS lastSyncedAt,
              ${mysqlCostAggregateSelect("u")}
       FROM usage_daily u
       ${joinParticipant}
       ${whereSql}
       GROUP BY ${groupColumns}
       ORDER BY periodStart DESC, totalTokens DESC`,
      params
    );
    const keyFor = (row) => includeAdminFields ? `${toDayString(row.periodStart)}|${row.participantId}` : toDayString(row.periodStart);
    const breakdowns = {};
    for (const [field, column] of Object.entries({ models: "model", workdirs: "workdirDisplayName", providers: "providerId" })) {
      const [breakdownRows] = await this.pool.query(
        `SELECT ${period.selectStart} AS periodStart
                ${selectParticipant},
                u.${column} AS name,
                COALESCE(SUM(u.totalTokens), 0) AS totalTokens,
                ${mysqlCostAggregateSelect("u")}
         FROM usage_daily u
         ${joinParticipant}
         ${whereSql}
         GROUP BY ${period.groupBy}${includeAdminFields ? ", u.participantId, p.nickname" : ""}, u.${column}
         ORDER BY totalTokens DESC`,
        params
      );
      breakdowns[field] = groupBreakdowns(breakdownRows.map((row) => ({ ...row, aggregateKey: keyFor(row) })), "aggregateKey", { includeCost });
    }
    return rows.map((row) => {
      const item = mysqlAggregateRow(row);
      const aggregateKey = keyFor(row);
      return {
        ...item,
        ...(includeAdminFields ? { participantId: row.participantId, nickname: row.nickname } : {}),
        compositionSummary: tokenCompositionSummary(item),
        dominantComposition: dominantComposition(item),
        sourceQuality: row.sourceQuality || "exact",
        lastSyncedAt: row.lastSyncedAt || "",
        ...(includeCost ? mysqlCostFields(row) : {}),
        models: breakdowns.models.get(aggregateKey) || [],
        workdirs: breakdowns.workdirs.get(aggregateKey) || [],
        providers: breakdowns.providers.get(aggregateKey) || []
      };
    });
  }

  async listModelPrices() {
    const hadOwnMissingPriceModels = Object.hasOwn(this, "missingPriceModels");
    const previousMissingPriceModels = this.missingPriceModels;
    this.missingPriceModels = () => [];
    let result;
    try {
      result = Store.prototype.listModelPrices.call(this);
    } finally {
      if (hadOwnMissingPriceModels) this.missingPriceModels = previousMissingPriceModels;
      else delete this.missingPriceModels;
    }
    result.missingModels = await this.missingPriceModels();
    return result;
  }

  async compareSyncState({ participantId, deviceId, buckets, mode }) {
    const isFullReconcile = mode === "full_reconcile";
    let cutoffDay = "";
    if (!isFullReconcile) {
      const now = new Date();
      const cutoff = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);
      cutoffDay = utcDateToDay(cutoff);
    }

    const candidates = (buckets || []).filter((bucket) => isFullReconcile || bucket.day >= cutoffDay);
    if (!candidates.length) {
      const empty = { missing: [], different: [], matched: [], serverFingerprint: await this.serverFingerprint() };
      if (isFullReconcile) { empty.unknownLegacy = []; empty.checkedBucketCount = 0; }
      return empty;
    }

    const missing = [];
    const different = [];
    const matched = [];
    const unknownLegacy = [];

    // Separate by granularity for full_reconcile
    const hourlyBuckets = [];
    const dailyBuckets = [];
    for (const bucket of candidates) {
      const granularity = bucket.granularity || (isFullReconcile ? "unknown_legacy" : "hourly");
      if (granularity === "unknown_legacy") { unknownLegacy.push(bucket); continue; }
      if (granularity === "daily") { dailyBuckets.push(bucket); continue; }
      hourlyBuckets.push(bucket);
    }

    // Hourly comparison
    if (hourlyBuckets.length) {
      const clauses = hourlyBuckets.map(() => "(day = ? AND hour = ? AND providerId = ?)").join(" OR ");
      const params = [participantId, deviceId, ...hourlyBuckets.flatMap((b) => [b.day, b.hour ?? 0, b.providerId || ""])];
      const [rows] = await this.pool.query(
        `SELECT day, hour, providerId, bucketFingerprint
         FROM usage_sync_buckets_hourly
         WHERE participantId = ? AND deviceId = ? AND (${clauses})`,
        params
      );
      const byKey = new Map(rows.map((row) => [[toDayString(row.day), Number(row.hour || 0), row.providerId].join("|"), row]));
      const [usageRows] = await this.pool.query(
        `SELECT * FROM usage_hourly
         WHERE participantId = ? AND deviceId = ? AND (${clauses})`,
        params
      );
      const usageByKey = new Map();
      for (const row of usageRows || []) {
        const usage = usageFromRow(row);
        const key = [usage.day, Number(usage.hour || 0), usage.providerId].join("|");
        const rowsForBucket = usageByKey.get(key) || [];
        rowsForBucket.push(usage);
        usageByKey.set(key, rowsForBucket);
      }
      for (const bucket of hourlyBuckets) {
        const key = [bucket.day, Number(bucket.hour || 0), bucket.providerId || ""].join("|");
        const serverBucket = byKey.get(key);
        const derivedRows = usageByKey.get(key) || [];
        const derivedFingerprint = derivedRows.length ? computeBucketFingerprint(derivedRows) : "";
        if (!serverBucket && !derivedFingerprint) missing.push(bucket);
        else {
          const serverFingerprint = serverBucket?.bucketFingerprint || derivedFingerprint;
          if (serverFingerprint !== bucket.fingerprint) different.push({ ...bucket, serverFingerprint });
          else matched.push(bucket);
        }
      }
    }

    // Daily comparison
    if (dailyBuckets.length) {
      const clauses = dailyBuckets.map(() => "(day = ? AND providerId = ?)").join(" OR ");
      const params = [participantId, deviceId, ...dailyBuckets.flatMap((b) => [b.day, b.providerId || ""])];
      const [rows] = await this.pool.query(
        `SELECT day, providerId, bucketFingerprint
         FROM usage_sync_buckets
         WHERE participantId = ? AND deviceId = ? AND (${clauses})`,
        params
      );
      const byKey = new Map(rows.map((row) => [`${toDayString(row.day)}|${row.providerId}`, row]));
      const [usageRows] = await this.pool.query(
        `SELECT * FROM usage_daily
         WHERE participantId = ? AND deviceId = ? AND (${clauses})`,
        params
      );
      const usageByKey = new Map();
      for (const row of usageRows || []) {
        const usage = usageFromRow(row);
        const key = [usage.day, usage.providerId].join("|");
        const rowsForBucket = usageByKey.get(key) || [];
        rowsForBucket.push(usage);
        usageByKey.set(key, rowsForBucket);
      }
      for (const bucket of dailyBuckets) {
        const key = [bucket.day, bucket.providerId || ""].join("|");
        const serverBucket = byKey.get(key);
        const derivedRows = usageByKey.get(key) || [];
        const derivedFingerprint = derivedRows.length ? computeDailyBucketFingerprint(derivedRows) : "";
        if (!serverBucket && !derivedFingerprint) missing.push(bucket);
        else {
          const serverFingerprint = serverBucket?.bucketFingerprint || derivedFingerprint;
          if (serverFingerprint !== bucket.fingerprint) different.push({ ...bucket, serverFingerprint });
          else matched.push(bucket);
        }
      }
    }

    const result = { missing, different, matched, serverFingerprint: await this.serverFingerprint() };
    if (isFullReconcile) {
      result.unknownLegacy = unknownLegacy;
      result.checkedBucketCount = (buckets || []).length;
    }
    return result;
  }

  async serverFingerprint() {
    if (!this.pool) return super.serverFingerprint();
    const [rows] = await this.pool.query(
      "SELECT metaValue FROM app_meta WHERE metaKey = ?",
      ["serverInstanceId"]
    ).catch(() => [[]]);
    return rows?.[0]?.metaValue || "";
  }

  async upsertUsageBatchSet(input) {
    const batches = Array.isArray(input.batches) ? input.batches : [];
    const results = [];
    let accepted = 0;
    let rejected = 0;
    let duplicate = 0;
    let noOp = 0;
    for (const [index, batch] of batches.entries()) {
      const result = await this.upsertUsageBatch({
        participantId: input.participantId,
        deviceId: input.deviceId,
        clientGeneratedAt: input.clientGeneratedAt,
        ...(Object.hasOwn(input, "client") ? { client: input.client } : {}),
        snapshot: batch.snapshot,
        items: batch.items
      });
      accepted += result.accepted || 0;
      rejected += result.rejected || 0;
      if (result.duplicate) duplicate += 1;
      if (result.noOp) noOp += 1;
      results.push({
        index,
        accepted: result.accepted || 0,
        rejected: result.rejected || 0,
        duplicate: Boolean(result.duplicate),
        noOp: Boolean(result.noOp)
      });
    }
    return {
      accepted,
      rejected,
      bucketCount: batches.length,
      duplicateBucketCount: duplicate,
      noOpBucketCount: noOp,
      results
    };
  }

  async upsertSnapshotBatch(input) {
    const result = super.upsertSnapshotBatch(input);
    if (result.noOp) return result;
    try {
      await this.incrementalBucketSync(input, result);
    } catch (error) {
      await this.load();
      throw error;
    }
    return result;
  }

  async incrementalBucketSync(input, result) {
    const snapshot = input.snapshot;
    const bucketKey = this.bucketSyncKey(input.participantId, input.deviceId, snapshot.day, snapshot.providerId);
    await withTransaction(this.pool, async (conn) => {
      const now = new Date().toISOString();
      await conn.query(
        `INSERT IGNORE INTO usage_sync_buckets
          (bucketKey, participantId, deviceId, day, providerId, granularity, bucketFingerprint, rowCount, totalTokens, clientGeneratedAt, syncedAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [bucketKey, input.participantId, input.deviceId, snapshot.day, snapshot.providerId, "daily", "__lock__", 0, 0, input.clientGeneratedAt || "", now, now]
      );
      await conn.query("SELECT bucketKey FROM usage_sync_buckets WHERE bucketKey = ? FOR UPDATE", [bucketKey]);

      // upsert only the identity rows relevant to this bucket
      const participant = this.db.participants[input.participantId];
      if (participant) await replaceParticipants(conn, [participant]);
      const device = this.db.devices[input.deviceId];
      if (device) await replaceDevices(conn, [device]);
      // workdirs touched by this bucket's accepted items
      const workdirSet = new Set();
      for (const uk of (result.incomingKeys || [])) {
        const row = this.db.usageDaily[uk];
        if (row) workdirSet.add(row.workdirId);
      }
      const workdirEntries = [...workdirSet].map((id) => this.db.workdirs[id]).filter(Boolean);
      if (workdirEntries.length) await replaceWorkdirs(conn, workdirEntries);

      // incremental usage row upserts: only the rows that belong to this bucket
      const bucketEntries = Object.entries(this.db.usageDaily).filter(
        ([, row]) => row.participantId === input.participantId && row.deviceId === input.deviceId && row.day === snapshot.day && row.providerId === snapshot.providerId
      );
      for (const [uk, row] of bucketEntries) {
        await conn.query(
          `INSERT INTO usage_daily
            (usageKey, day, participantId, deviceId, toolCode, providerId, workdirId, workdirHash, workdirDisplayName,
             model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens,
             estimatedCostUsd, costQuality, pricingVersion, pricingModel, pricingSource, sourceQuality,
             rawSourceRef, providerVersion, parserVersion, sourceFingerprint, uploadedAt)
           VALUES ?
           ON DUPLICATE KEY UPDATE
             inputTokens = VALUES(inputTokens), outputTokens = VALUES(outputTokens),
             cacheReadTokens = VALUES(cacheReadTokens), cacheWriteTokens = VALUES(cacheWriteTokens),
             reasoningTokens = VALUES(reasoningTokens), totalTokens = VALUES(totalTokens),
             estimatedCostUsd = VALUES(estimatedCostUsd), costQuality = VALUES(costQuality),
             pricingVersion = VALUES(pricingVersion), pricingModel = VALUES(pricingModel),
             pricingSource = VALUES(pricingSource), sourceQuality = VALUES(sourceQuality),
             rawSourceRef = VALUES(rawSourceRef), providerVersion = VALUES(providerVersion),
             parserVersion = VALUES(parserVersion), sourceFingerprint = VALUES(sourceFingerprint),
             uploadedAt = VALUES(uploadedAt), workdirDisplayName = VALUES(workdirDisplayName)`,
          [[[uk, row.day, row.participantId, row.deviceId, row.toolCode, row.providerId, row.workdirId, row.workdirHash, row.workdirDisplayName,
             row.model, row.inputTokens || 0, row.outputTokens || 0, row.cacheReadTokens || 0, row.cacheWriteTokens || 0, row.reasoningTokens || 0, row.totalTokens || 0,
             row.estimatedCostUsd, row.costQuality || "", row.pricingVersion || "", row.pricingModel || "", row.pricingSource || "", row.sourceQuality || "unknown",
             row.rawSourceRef || "", row.providerVersion || "", row.parserVersion || "", row.sourceFingerprint || "", row.uploadedAt || null]]]
        );
      }

      // bucket-scoped delete of stale rows (only accepted keys, not rejected items)
      const incomingKeys = result.incomingKeys || [];
      if (incomingKeys.length > 0) {
        const placeholders = incomingKeys.map(() => "?").join(",");
        await conn.query(
          `DELETE FROM usage_daily WHERE participantId = ? AND deviceId = ? AND day = ? AND providerId = ? AND usageKey NOT IN (${placeholders})`,
          [input.participantId, input.deviceId, snapshot.day, snapshot.providerId, ...incomingKeys]
        );
      } else {
        await conn.query(
          `DELETE FROM usage_daily WHERE participantId = ? AND deviceId = ? AND day = ? AND providerId = ?`,
          [input.participantId, input.deviceId, snapshot.day, snapshot.providerId]
        );
      }

      // upsert bucket metadata
      const meta = this.getBucketSync(input.participantId, input.deviceId, snapshot.day, snapshot.providerId);
      if (meta) {
        await conn.query(
          `REPLACE INTO usage_sync_buckets (bucketKey, participantId, deviceId, day, providerId, granularity, bucketFingerprint, rowCount, totalTokens, clientGeneratedAt, syncedAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [bucketKey, meta.participantId, meta.deviceId, meta.day, meta.providerId, meta.granularity || "daily", meta.bucketFingerprint, meta.rowCount, meta.totalTokens, meta.clientGeneratedAt, meta.syncedAt, meta.updatedAt]
        );
      }
    });
  }

  async incrementalHourlyBucketSync(input, result) {
    const snapshot = input.snapshot;
    const bucketKey = this.hourlyBucketSyncKey(input.participantId, input.deviceId, snapshot.day, snapshot.hour, snapshot.providerId);
    await withTransaction(this.pool, async (conn) => {
      const now = new Date().toISOString();
      await conn.query(
        `INSERT IGNORE INTO usage_sync_buckets_hourly
          (bucketKey, participantId, deviceId, day, hour, providerId, granularity, bucketFingerprint, rowCount, totalTokens, clientGeneratedAt, syncedAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [bucketKey, input.participantId, input.deviceId, snapshot.day, snapshot.hour, snapshot.providerId, "hourly", "__lock__", 0, 0, input.clientGeneratedAt || "", now, now]
      );
      await conn.query("SELECT bucketKey FROM usage_sync_buckets_hourly WHERE bucketKey = ? FOR UPDATE", [bucketKey]);

      const participant = this.db.participants[input.participantId];
      if (participant) await replaceParticipants(conn, [participant]);
      const device = this.db.devices[input.deviceId];
      if (device) await replaceDevices(conn, [device]);

      const affectedDailyScopes = await this.deleteCloudDuplicateHourlyRows(conn, input);
      affectedDailyScopes.add([input.deviceId, snapshot.day, snapshot.providerId].join("|"));

      await this.syncHourlyScope(conn, input.participantId, input.deviceId, snapshot.day, snapshot.hour, snapshot.providerId);

      for (const scope of affectedDailyScopes) {
        const [deviceId, day, providerId] = scope.split("|");
        await this.syncDailyScope(conn, input.participantId, deviceId, day, providerId);
      }

      const meta = this.getHourlyBucketSync(input.participantId, input.deviceId, snapshot.day, snapshot.hour, snapshot.providerId);
      if (meta) {
        await conn.query(
          `REPLACE INTO usage_sync_buckets_hourly
            (bucketKey, participantId, deviceId, day, hour, providerId, granularity, bucketFingerprint, rowCount, totalTokens, clientGeneratedAt, syncedAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [bucketKey, meta.participantId, meta.deviceId, meta.day, meta.hour ?? 0, meta.providerId, meta.granularity || "hourly", meta.bucketFingerprint, meta.rowCount, meta.totalTokens, meta.clientGeneratedAt, meta.syncedAt, meta.updatedAt]
        );
      }
    });
  }

  async deleteCloudDuplicateHourlyRows(conn, input) {
    const snapshot = input.snapshot;
    const affectedDailyScopes = new Set();
    if (!CLOUD_PROVIDER_IDS.has(snapshot.providerId) || !(input.items || []).length) return affectedDailyScopes;

    const conditions = [];
    const params = [input.participantId, input.deviceId, snapshot.providerId];
    for (const item of input.items || []) {
      conditions.push("(day = ? AND hour = ? AND toolCode = ? AND workdirHash = ? AND model = ?)");
      params.push(item.day, item.hour ?? snapshot.hour ?? 0, item.toolCode, item.workdirHash, item.model);
    }
    const where = conditions.join(" OR ");
    const [rows] = await conn.query(
      `SELECT DISTINCT deviceId, day, providerId
       FROM usage_hourly
       WHERE participantId = ? AND deviceId <> ? AND providerId = ? AND (${where})`,
      params
    );
    for (const row of rows || []) {
      affectedDailyScopes.add([row.deviceId, toDayString(row.day), row.providerId].join("|"));
    }
    if ((rows || []).length) {
      await conn.query(
        `DELETE FROM usage_hourly
         WHERE participantId = ? AND deviceId <> ? AND providerId = ? AND (${where})`,
        params
      );
    }
    return affectedDailyScopes;
  }

  async syncHourlyScope(conn, participantId, deviceId, day, hour, providerId) {
    const hourlyEntries = Object.entries(this.db.usageHourly || {}).filter(
      ([, row]) => row.participantId === participantId && row.deviceId === deviceId && row.day === day && row.hour === hour && row.providerId === providerId
    );
    await this.syncWorkdirsForUsageEntries(conn, hourlyEntries);
    await conn.query(
      "DELETE FROM usage_hourly WHERE participantId = ? AND deviceId = ? AND day = ? AND hour = ? AND providerId = ?",
      [participantId, deviceId, day, hour, providerId]
    );
    await insertUsageHourlyRows(conn, hourlyEntries);
  }

  async syncDailyScope(conn, participantId, deviceId, day, providerId) {
    const dailyEntries = Object.entries(this.db.usageDaily || {}).filter(
      ([, row]) => row.participantId === participantId && row.deviceId === deviceId && row.day === day && row.providerId === providerId
    );
    await this.syncWorkdirsForUsageEntries(conn, dailyEntries);
    await conn.query(
      "DELETE FROM usage_daily WHERE participantId = ? AND deviceId = ? AND day = ? AND providerId = ?",
      [participantId, deviceId, day, providerId]
    );
    await insertUsageRows(conn, dailyEntries);
  }

  async syncWorkdirsForUsageEntries(conn, entries) {
    const workdirEntries = [...new Set(entries.map(([, row]) => row.workdirId))]
      .map((id) => this.db.workdirs[id])
      .filter(Boolean);
    if (workdirEntries.length) await replaceWorkdirs(conn, workdirEntries);
  }

  async recalculateCosts(args = {}) {
    return this.withWriteLock(async () => this.recalculateUsageCostsInBatches(args));
  }

  async refreshOpenRouterPrices(input) {
    // Fetch external pricing OUTSIDE the named write lock. The HTTP call can be slow,
    // and holding the cross-process MySQL lock during a remote round-trip would block
    // every other backend instance's writes (snapshot uploads, registers, etc.) for the
    // entire duration. We do the network I/O up-front, then enter the lock only to
    // mutate cache state in MySQL.
    let prefetched = null;
    let prefetchError = null;
    try {
      prefetched = await fetchOpenRouterModelPrices();
    } catch (error) {
      prefetchError = error;
    }
    return this.withWriteLock(async () => {
      const result = Store.prototype.applyOpenRouterPriceFetch.call(
        this,
        prefetched,
        prefetchError,
        { recalculate: false }
      );
      await this.syncPriceCache();
      if (input?.recalculate && result.remote?.status === "fresh") {
        result.recalculated = await this.recalculateUsageCostsInBatches();
      }
      return result;
    });
  }

  async recalculateUsageCostsInBatches({ models = null, batchSize = Number(process.env.MYSQL_RECALCULATE_BATCH_SIZE || 1000) } = {}) {
    const normalizedModels = models ? [...new Set(models.map((model) => normalizeModelName(model)).filter(Boolean))] : null;
    const limit = Math.max(1, Math.min(Number(batchSize) || 1000, 5000));
    let lastUsageKey = "";
    let updated = 0;
    for (;;) {
      const where = ["usageKey > ?"];
      const params = [lastUsageKey];
      if (normalizedModels?.length) {
        where.push(`model IN (${normalizedModels.map(() => "?").join(",")})`);
        params.push(...normalizedModels);
      }
      params.push(limit);
      const [rows] = await this.pool.query(
        `SELECT * FROM usage_daily
         WHERE ${where.join(" AND ")}
         ORDER BY usageKey
         LIMIT ?`,
        params
      );
      if (!rows.length) break;
      lastUsageKey = rows.at(-1).usageKey;
      this.db.usageDaily = Object.fromEntries(rows.map((row) => [row.usageKey, usageFromRow(row)]));
      const result = Store.prototype.recalculateCosts.call(this, { models: normalizedModels });
      await this.syncUsageDailyRows();
      updated += result.updated || 0;
      if (rows.length < limit) break;
    }
    this.db.usageDaily = {};
    this.invalidateAggregateCache();
    return { updated };
  }

  async upsertModelPrice(input) {
    return this.withWriteLock(async () => {
      const model = normalizeModelName(input.model || "");
      if (!model) throw new Error("model is required");
      const affectedModels = this.affectedModelsForPrice(model);
      await this.loadUsageDailyForModels(affectedModels);
      const now = new Date().toISOString();
      const price = {
        model,
        inputCostPerMTok: nonNegativeNumber(input.inputCostPerMTok),
        outputCostPerMTok: nonNegativeNumber(input.outputCostPerMTok),
        cacheReadCostPerMTok: nonNegativeNumber(input.cacheReadCostPerMTok),
        cacheWriteCostPerMTok: nonNegativeNumber(input.cacheWriteCostPerMTok),
        reasoningCostPerMTok: 0,
        source: input.source || "custom",
        notes: input.notes || "",
        updatedAt: now
      };
      this.db.modelPrices[model] = price;
      this.invalidatePriceMap();
      const recalculated = Store.prototype.recalculateCosts.call(this, { models: affectedModels });
      await this.syncPricingTables();
      await this.syncUsageDailyRows();
      return { price, recalculated };
    });
  }

  async deleteModelPrice(model) {
    return this.withWriteLock(async () => {
      const normalized = normalizeModelName(model || "");
      if (!normalized || !this.db.modelPrices[normalized]) return { deleted: false };
      const affectedModels = this.affectedModelsForPrice(normalized);
      await this.loadUsageDailyForModels(affectedModels);
      delete this.db.modelPrices[normalized];
      for (const [sourceModel, targetModel] of Object.entries(this.db.modelPriceAliases || {})) {
        if (targetModel === normalized) delete this.db.modelPriceAliases[sourceModel];
      }
      this.invalidatePriceMap();
      const recalculated = Store.prototype.recalculateCosts.call(this, { models: affectedModels });
      await this.syncPricingTables();
      await this.syncUsageDailyRows();
      return { deleted: true, recalculated };
    });
  }

  async upsertModelPriceAlias(input) {
    return this.withWriteLock(async () => {
      const model = normalizeModelName(input.model || input.sourceModel || "");
      await this.loadUsageDailyForModels(model ? [model] : []);
      const result = Store.prototype.upsertModelPriceAlias.call(this, input);
      await this.syncPricingTables();
      await this.syncUsageDailyRows();
      return result;
    });
  }

  async deleteModelPriceAlias(model) {
    return this.withWriteLock(async () => {
      const normalized = normalizeModelName(model || "");
      if (!normalized || !this.db.modelPriceAliases[normalized]) return { deleted: false };
      await this.loadUsageDailyForModels([normalized]);
      const result = Store.prototype.deleteModelPriceAlias.call(this, model);
      await this.syncPricingTables();
      await this.syncUsageDailyRows();
      return result;
    });
  }

  async deleteParticipantData(participantId) {
    return this.withWriteLock(async () => {
      if (!participantId) throw new Error("participantId is required");
      const removed = {
        participants: 0,
        devices: 0,
        workdirs: 0,
        usageDaily: 0,
        uploadBatches: 0,
        usageSyncBuckets: 0,
        usageHourly: 0,
        usageSyncBucketsHourly: 0
      };
      await withTransaction(this.pool, async (conn) => {
        removed.uploadBatches = await deleteAffected(conn, "DELETE FROM upload_batches WHERE participantId = ?", [participantId]);
        removed.usageSyncBuckets = await deleteAffected(conn, "DELETE FROM usage_sync_buckets WHERE participantId = ?", [participantId]);
        removed.usageSyncBucketsHourly = await deleteAffected(conn, "DELETE FROM usage_sync_buckets_hourly WHERE participantId = ?", [participantId]);
        removed.usageHourly = await deleteAffected(conn, "DELETE FROM usage_hourly WHERE participantId = ?", [participantId]);
        removed.usageDaily = await deleteAffected(conn, "DELETE FROM usage_daily WHERE participantId = ?", [participantId]);
        removed.workdirs = await deleteAffected(conn, "DELETE FROM workdirs WHERE participantId = ?", [participantId]);
        removed.devices = await deleteAffected(conn, "DELETE FROM devices WHERE participantId = ?", [participantId]);
        removed.participants = await deleteAffected(conn, "DELETE FROM participants WHERE id = ?", [participantId]);
      });
      delete this.db.participants[participantId];
      for (const [id, row] of Object.entries(this.db.devices || {})) {
        if (row.participantId === participantId) delete this.db.devices[id];
      }
      for (const [id, row] of Object.entries(this.db.workdirs || {})) {
        if (row.participantId === participantId) delete this.db.workdirs[id];
      }
      this.db.usageDaily = {};
      this.db.usageHourly = {};
      this.db.usageSyncBuckets = {};
      this.db.usageSyncBucketsHourly = {};
      this.db.uploadBatches = {};
      this.invalidateAggregateCache();
      return {
        deleted: Object.values(removed).some((count) => count > 0),
        participantId,
        removed
      };
    });
  }

  async deleteDeviceData(deviceId) {
    return this.withWriteLock(async () => {
      if (!deviceId) throw new Error("deviceId is required");
      const removed = {
        devices: 0,
        usageDaily: 0,
        uploadBatches: 0,
        usageSyncBuckets: 0,
        usageHourly: 0,
        usageSyncBucketsHourly: 0
      };
      let participantId = this.db.devices?.[deviceId]?.participantId || "";
      let cloudHourlyScopes = [];
      await withTransaction(this.pool, async (conn) => {
        if (!participantId) {
          const [devices] = await conn.query("SELECT participantId FROM devices WHERE id = ?", [deviceId]);
          participantId = devices?.[0]?.participantId || "";
        }
        const [scopeRows] = await conn.query(
          `SELECT DISTINCT participantId, day, hour, providerId
           FROM usage_hourly
           WHERE deviceId = ? AND providerId IN (${[...CLOUD_PROVIDER_IDS].map(() => "?").join(",")})`,
          [deviceId, ...CLOUD_PROVIDER_IDS]
        ).catch(() => [[]]);
        cloudHourlyScopes = (scopeRows || []).map((row) => ({
          participantId: row.participantId,
          day: toDayString(row.day),
          hour: Number(row.hour || 0),
          providerId: row.providerId
        }));

        removed.uploadBatches = await deleteAffected(conn, "DELETE FROM upload_batches WHERE deviceId = ?", [deviceId]);
        removed.usageSyncBuckets = await deleteAffected(conn, "DELETE FROM usage_sync_buckets WHERE deviceId = ?", [deviceId]);
        removed.usageSyncBucketsHourly = await deleteAffected(conn, "DELETE FROM usage_sync_buckets_hourly WHERE deviceId = ?", [deviceId]);
        if (cloudHourlyScopes.length) {
          const clauses = cloudHourlyScopes.map(() => "(participantId = ? AND day = ? AND hour = ? AND providerId = ?)").join(" OR ");
          const params = cloudHourlyScopes.flatMap((scope) => [scope.participantId, scope.day, scope.hour, scope.providerId]);
          removed.usageSyncBucketsHourly += await deleteAffected(conn, `DELETE FROM usage_sync_buckets_hourly WHERE ${clauses}`, params);
        }
        removed.usageHourly = await deleteAffected(conn, "DELETE FROM usage_hourly WHERE deviceId = ?", [deviceId]);
        removed.usageDaily = await deleteAffected(conn, "DELETE FROM usage_daily WHERE deviceId = ?", [deviceId]);
        removed.devices = await deleteAffected(conn, "DELETE FROM devices WHERE id = ?", [deviceId]);
      });
      delete this.db.devices[deviceId];
      for (const [key, row] of Object.entries(this.db.usageDaily || {})) {
        if (row.deviceId === deviceId) delete this.db.usageDaily[key];
      }
      for (const [key, row] of Object.entries(this.db.usageHourly || {})) {
        if (row.deviceId === deviceId) delete this.db.usageHourly[key];
      }
      for (const [key, row] of Object.entries(this.db.usageSyncBuckets || {})) {
        if (row.deviceId === deviceId) delete this.db.usageSyncBuckets[key];
      }
      for (const [key, row] of Object.entries(this.db.usageSyncBucketsHourly || {})) {
        const sameDevice = row.deviceId === deviceId;
        const sameCloudScope = cloudHourlyScopes.some((scope) => (
          row.participantId === scope.participantId &&
          row.day === scope.day &&
          Number(row.hour || 0) === scope.hour &&
          row.providerId === scope.providerId
        ));
        if (sameDevice || sameCloudScope) delete this.db.usageSyncBucketsHourly[key];
      }
      this.invalidateAggregateCache();
      return {
        deleted: Object.values(removed).some((count) => count > 0),
        participantId,
        deviceId,
        cloudHourlyScopes,
        removed
      };
    });
  }

  async syncIdentityTables() {
    await withTransaction(this.pool, async (conn) => {
      await replaceParticipants(conn, Object.values(this.db.participants));
      await replaceDevices(conn, Object.values(this.db.devices));
    });
  }

  async syncPriceCache() {
    await withTransaction(this.pool, async (conn) => {
      await replaceModelPriceCache(conn, this.db.modelPriceCache);
    });
  }

  async syncPricingTables() {
    await withTransaction(this.pool, async (conn) => {
      await replaceModelPrices(conn, Object.values(this.db.modelPrices));
      await replaceModelPriceAliases(conn, this.db.modelPriceAliases);
    });
  }

  async syncUsageDailyRows(entries = Object.entries(this.db.usageDaily || {})) {
    await withTransaction(this.pool, async (conn) => {
      await upsertUsageRows(conn, entries);
    });
  }

  async syncLegacyUsageMirror(previousUsageKeys = new Set()) {
    const currentUsage = this.db.usageDaily || {};
    const removedUsageKeys = [...previousUsageKeys].filter((key) => !currentUsage[key]);
    await withTransaction(this.pool, async (conn) => {
      await replaceParticipants(conn, Object.values(this.db.participants));
      await replaceDevices(conn, Object.values(this.db.devices));
      await replaceWorkdirs(conn, Object.values(this.db.workdirs));
      await deleteUsageRowsByKeys(conn, removedUsageKeys);
      await upsertUsageRows(conn, Object.entries(currentUsage));
      await replaceUploadBatches(conn, Object.values(this.db.uploadBatches));
    });
  }

  async close() {
    await this.pool?.end();
  }
}

async function withTransaction(pool, fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await fn(conn);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function ensureIndex(pool, tableName, indexName, createSql) {
  const [rows] = await pool.query(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [tableName, indexName]
  );
  if (!rows.length) await pool.query(createSql);
}

async function deleteAffected(conn, sql, params = []) {
  const [result] = await conn.query(sql, params).catch(() => [{ affectedRows: 0 }]);
  return Number(result?.affectedRows || 0);
}

function normalizeMysqlLockName(name) {
  const normalized = String(name || "").replace(/[^a-zA-Z0-9:_.-]/g, "_");
  return normalized.slice(0, 64);
}

function mysqlLockAcquired(rows) {
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || typeof row !== "object") return false;
  const value = Object.hasOwn(row, "acquired") ? row.acquired : Object.values(row)[0];
  return Number(value) === 1;
}

function mysqlLockUnsupported(rows) {
  const row = Array.isArray(rows) ? rows[0] : rows;
  return Boolean(row && typeof row === "object" && Object.hasOwn(row, "affectedRows") && !Object.hasOwn(row, "acquired"));
}

async function deleteUsageRowsByKeys(conn, usageKeys = []) {
  for (let i = 0; i < usageKeys.length; i += 500) {
    const chunk = usageKeys.slice(i, i + 500);
    if (!chunk.length) continue;
    await conn.query(
      `DELETE FROM usage_daily WHERE usageKey IN (${chunk.map(() => "?").join(",")})`,
      chunk
    );
  }
}

async function replaceParticipants(conn, rows) {
  if (!rows.length) return;
  await conn.query(
    `INSERT INTO participants
      (id, nickname, avatarColor, identityPublicKey, createdAt, updatedAt, lastSeenAt)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      nickname = VALUES(nickname),
      avatarColor = VALUES(avatarColor),
      identityPublicKey = VALUES(identityPublicKey),
      updatedAt = VALUES(updatedAt),
      lastSeenAt = VALUES(lastSeenAt)`,
    [rows.map((row) => [row.id, row.nickname, row.avatarColor, row.identityPublicKey, row.createdAt, row.updatedAt, row.lastSeenAt])]
  );
}

async function replaceDevices(conn, rows) {
  if (!rows.length) return;
  await conn.query(
    `INSERT INTO devices
      (id, participantId, os, appVersion, lanIp, createdAt, lastSeenAt, revokedAt)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      participantId = VALUES(participantId),
      os = VALUES(os),
      appVersion = VALUES(appVersion),
      lanIp = VALUES(lanIp),
      lastSeenAt = VALUES(lastSeenAt),
      revokedAt = VALUES(revokedAt)`,
    [rows.map((row) => [row.id, row.participantId, row.os || "unknown", row.appVersion || "0.0.0", row.lanIp || "", row.createdAt, row.lastSeenAt, row.revokedAt || null])]
  );
}

async function replaceWorkdirs(conn, rows) {
  if (!rows.length) return;
  await conn.query(
    `INSERT INTO workdirs
      (id, participantId, workdirHash, alias, detectedName, displayName, sourceProvider, createdAt, updatedAt, lastSeenAt)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      alias = VALUES(alias),
      detectedName = VALUES(detectedName),
      displayName = VALUES(displayName),
      sourceProvider = VALUES(sourceProvider),
      updatedAt = VALUES(updatedAt),
      lastSeenAt = VALUES(lastSeenAt)`,
    [rows.map((row) => [row.id, row.participantId, row.workdirHash, row.alias || "", row.detectedName || "", row.displayName || "", row.sourceProvider || "", row.createdAt, row.updatedAt, row.lastSeenAt])]
  );
}

async function replaceModelPrices(conn, rows) {
  await conn.query("DELETE FROM model_prices");
  if (!rows.length) return;
  await conn.query(
    `INSERT INTO model_prices
      (model, inputCostPerMTok, outputCostPerMTok, cacheReadCostPerMTok, cacheWriteCostPerMTok, reasoningCostPerMTok, source, notes, updatedAt)
     VALUES ?`,
    [rows.map((row) => [row.model, row.inputCostPerMTok, row.outputCostPerMTok, row.cacheReadCostPerMTok, row.cacheWriteCostPerMTok, row.reasoningCostPerMTok, row.source || "custom", row.notes || "", row.updatedAt])]
  );
}

async function replaceModelPriceAliases(conn, aliases = {}) {
  await conn.query("DELETE FROM model_price_aliases");
  const rows = Object.entries(aliases || {});
  if (!rows.length) return;
  const now = new Date().toISOString();
  await conn.query(
    `INSERT INTO model_price_aliases
      (model, targetModel, updatedAt)
     VALUES ?`,
    [rows.map(([model, targetModel]) => [model, targetModel, now])]
  );
}

async function replaceModelPriceCache(conn, cache) {
  await conn.query("DELETE FROM model_price_cache");
  await conn.query("DELETE FROM model_price_cache_meta WHERE source = 'openrouter'");
  const remote = cache?.remote || {};
  await conn.query(
    `INSERT INTO model_price_cache_meta
      (source, url, status, fetchedAt, expiresAt, pricingVersion, modelCount, skipped, lastError)
     VALUES ?`,
    [[[
      "openrouter",
      remote.url || "",
      remote.status || "empty",
      remote.fetchedAt || "",
      remote.expiresAt || "",
      remote.pricingVersion || "",
      remote.modelCount || 0,
      remote.skipped || 0,
      remote.lastError || ""
    ]]]
  );
  const rows = Object.values(cache?.prices || {});
  if (!rows.length) return;
  await conn.query(
    `INSERT INTO model_price_cache
      (model, inputCostPerToken, outputCostPerToken, cacheReadCostPerToken, cacheWriteCostPerToken,
       reasoningCostPerToken, maxInputTokens, maxOutputTokens, source, pricingVersion, updatedAt, rawJson)
     VALUES ?`,
    [rows.map((row) => [
      row.model,
      row.input_cost_per_token || row.inputCostPerToken || 0,
      row.output_cost_per_token || row.outputCostPerToken || 0,
      row.cache_read_input_token_cost || row.cacheReadCostPerToken || 0,
      row.cache_creation_input_token_cost || row.cacheWriteCostPerToken || 0,
      row.reasoning_cost_per_token || row.reasoningCostPerToken || 0,
      row.max_input_tokens || row.maxInputTokens || 0,
      row.max_output_tokens || row.maxOutputTokens || 0,
      row.source || "openrouter",
      row.pricingVersion || "",
      row.updatedAt || "",
      row.rawJson ? JSON.stringify(row.rawJson) : null
    ])]
  );
}

async function replaceUploadBatches(conn, rows) {
  if (!rows.length) return;
  await conn.query(
    `INSERT INTO upload_batches
      (id, participantId, deviceId, payloadHash, clientGeneratedAt, receivedAt, status, accepted, rejected, errorReason)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      participantId = VALUES(participantId),
      deviceId = VALUES(deviceId),
      clientGeneratedAt = VALUES(clientGeneratedAt),
      receivedAt = VALUES(receivedAt),
      status = VALUES(status),
      accepted = VALUES(accepted),
      rejected = VALUES(rejected),
      errorReason = VALUES(errorReason)`,
    [rows.map((row) => [row.id, row.participantId, row.deviceId, row.payloadHash, row.clientGeneratedAt || "", row.receivedAt, row.status, row.accepted || 0, row.rejected || 0, row.errorReason || ""])]
  );
}

async function insertUsageRows(conn, entries) {
  if (!entries.length) return;
  await conn.query(
    `INSERT INTO usage_daily
      (usageKey, day, participantId, deviceId, toolCode, providerId, workdirId, workdirHash, workdirDisplayName,
       model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens,
       estimatedCostUsd, costQuality, pricingVersion, pricingModel, pricingSource, sourceQuality,
       rawSourceRef, providerVersion, parserVersion, sourceFingerprint, uploadedAt)
     VALUES ?`,
    [entries.map(([usageKey, row]) => [
      usageKey,
      row.day,
      row.participantId,
      row.deviceId,
      row.toolCode,
      row.providerId,
      row.workdirId,
      row.workdirHash,
      row.workdirDisplayName,
      row.model,
      row.inputTokens || 0,
      row.outputTokens || 0,
      row.cacheReadTokens || 0,
      row.cacheWriteTokens || 0,
      row.reasoningTokens || 0,
      row.totalTokens || 0,
      row.estimatedCostUsd,
      row.costQuality || "",
      row.pricingVersion || "",
      row.pricingModel || "",
      row.pricingSource || "",
      row.sourceQuality || "unknown",
      row.rawSourceRef || "",
      row.providerVersion || "",
      row.parserVersion || "",
      row.sourceFingerprint || "",
      row.uploadedAt || null
    ])]
  );
}

async function upsertUsageRows(conn, entries) {
  if (!entries.length) return;
  await conn.query(
    `INSERT INTO usage_daily
      (usageKey, day, participantId, deviceId, toolCode, providerId, workdirId, workdirHash, workdirDisplayName,
       model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens,
       estimatedCostUsd, costQuality, pricingVersion, pricingModel, pricingSource, sourceQuality,
       rawSourceRef, providerVersion, parserVersion, sourceFingerprint, uploadedAt)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       inputTokens = VALUES(inputTokens),
       outputTokens = VALUES(outputTokens),
       cacheReadTokens = VALUES(cacheReadTokens),
       cacheWriteTokens = VALUES(cacheWriteTokens),
       reasoningTokens = VALUES(reasoningTokens),
       totalTokens = VALUES(totalTokens),
       estimatedCostUsd = VALUES(estimatedCostUsd),
       costQuality = VALUES(costQuality),
       pricingVersion = VALUES(pricingVersion),
       pricingModel = VALUES(pricingModel),
       pricingSource = VALUES(pricingSource),
       sourceQuality = VALUES(sourceQuality),
       rawSourceRef = VALUES(rawSourceRef),
       providerVersion = VALUES(providerVersion),
       parserVersion = VALUES(parserVersion),
       sourceFingerprint = VALUES(sourceFingerprint),
       uploadedAt = VALUES(uploadedAt),
       workdirDisplayName = VALUES(workdirDisplayName)`,
    [entries.map(([usageKey, row]) => [
      usageKey,
      row.day,
      row.participantId,
      row.deviceId,
      row.toolCode,
      row.providerId,
      row.workdirId,
      row.workdirHash,
      row.workdirDisplayName,
      row.model,
      row.inputTokens || 0,
      row.outputTokens || 0,
      row.cacheReadTokens || 0,
      row.cacheWriteTokens || 0,
      row.reasoningTokens || 0,
      row.totalTokens || 0,
      row.estimatedCostUsd,
      row.costQuality || "",
      row.pricingVersion || "",
      row.pricingModel || "",
      row.pricingSource || "",
      row.sourceQuality || "unknown",
      row.rawSourceRef || "",
      row.providerVersion || "",
      row.parserVersion || "",
      row.sourceFingerprint || "",
      row.uploadedAt || null
    ])]
  );
}

async function insertUsageHourlyRows(conn, entries) {
  if (!entries.length) return;
  await conn.query(
    `INSERT INTO usage_hourly
      (usageKey, day, hour, participantId, deviceId, toolCode, providerId, workdirId, workdirHash, workdirDisplayName,
       model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens,
       estimatedCostUsd, costQuality, pricingVersion, pricingModel, pricingSource, sourceQuality,
       rawSourceRef, providerVersion, parserVersion, sourceFingerprint, uploadedAt)
     VALUES ?`,
    [entries.map(([usageKey, row]) => [
      usageKey,
      row.day,
      row.hour ?? 0,
      row.participantId,
      row.deviceId,
      row.toolCode,
      row.providerId,
      row.workdirId,
      row.workdirHash,
      row.workdirDisplayName,
      row.model,
      row.inputTokens || 0,
      row.outputTokens || 0,
      row.cacheReadTokens || 0,
      row.cacheWriteTokens || 0,
      row.reasoningTokens || 0,
      row.totalTokens || 0,
      row.estimatedCostUsd,
      row.costQuality || "",
      row.pricingVersion || "",
      row.pricingModel || "",
      row.pricingSource || "",
      row.sourceQuality || "unknown",
      row.rawSourceRef || "",
      row.providerVersion || "",
      row.parserVersion || "",
      row.sourceFingerprint || "",
      row.uploadedAt || null
    ])]
  );
}

function normalizeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (!(value instanceof Date)) return [key, value];
    return [key, key === "day" ? value.toISOString().slice(0, 10) : value.toISOString()];
  }));
}

function usageFromRow(row) {
  const normalizedRow = {
    ...row,
    inputTokens: Number(row.inputTokens || 0),
    outputTokens: Number(row.outputTokens || 0),
    totalTokens: Number(row.totalTokens || 0)
  };
  return {
    usageKey: row.usageKey || "",
    day: toDayString(row.day),
    hour: row.hour ?? 0,
    participantId: row.participantId,
    deviceId: row.deviceId,
    toolCode: row.toolCode,
    providerId: row.providerId,
    workdirId: row.workdirId,
    workdirHash: row.workdirHash,
    workdirDisplayName: row.workdirDisplayName,
    model: row.model,
    inputTokens: Number(row.inputTokens || 0),
    outputTokens: Number(row.outputTokens || 0),
    cacheReadTokens: Number(row.cacheReadTokens || 0),
    cacheWriteTokens: Number(row.cacheWriteTokens || 0),
    reasoningTokens: Number(row.reasoningTokens || 0),
    totalTokens: displayTotalTokens(normalizedRow),
    estimatedCostUsd: row.estimatedCostUsd === null ? null : Number(row.estimatedCostUsd),
    costQuality: row.costQuality || "",
    pricingVersion: row.pricingVersion || "",
    pricingModel: row.pricingModel || "",
    pricingSource: row.pricingSource || "",
    sourceQuality: row.sourceQuality || "unknown",
    rawSourceRef: row.rawSourceRef || "",
    providerVersion: row.providerVersion || "",
    parserVersion: row.parserVersion || "",
    sourceFingerprint: row.sourceFingerprint || "",
    uploadedAt: row.uploadedAt instanceof Date ? row.uploadedAt.toISOString() : row.uploadedAt || ""
  };
}

function priceFromRow(row) {
  return {
    model: row.model,
    inputCostPerMTok: Number(row.inputCostPerMTok || 0),
    outputCostPerMTok: Number(row.outputCostPerMTok || 0),
    cacheReadCostPerMTok: Number(row.cacheReadCostPerMTok || 0),
    cacheWriteCostPerMTok: Number(row.cacheWriteCostPerMTok || 0),
    reasoningCostPerMTok: Number(row.reasoningCostPerMTok || 0),
    source: row.source || "custom",
    notes: row.notes || "",
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt || ""
  };
}

function cachedPriceFromRow(row) {
  return {
    model: row.model,
    input_cost_per_token: Number(row.inputCostPerToken || 0),
    output_cost_per_token: Number(row.outputCostPerToken || 0),
    cache_read_input_token_cost: Number(row.cacheReadCostPerToken || 0),
    cache_creation_input_token_cost: Number(row.cacheWriteCostPerToken || 0),
    reasoning_cost_per_token: Number(row.reasoningCostPerToken || 0),
    max_input_tokens: Number(row.maxInputTokens || 0),
    max_output_tokens: Number(row.maxOutputTokens || 0),
    source: row.source || "openrouter",
    pricingVersion: row.pricingVersion || "",
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt || ""
  };
}

function toDayString(value) {
  if (value instanceof Date) return localDay(value);
  return String(value || "").slice(0, 10);
}

function mysqlAggregateRow(row) {
  return {
    periodStart: toDayString(row.periodStart),
    periodEnd: toDayString(row.periodEnd),
    totalTokens: Number(row.totalTokens || 0),
    inputTokens: Number(row.inputTokens || 0),
    outputTokens: Number(row.outputTokens || 0),
    reasoningTokens: Number(row.reasoningTokens || 0),
    cacheReadTokens: Number(row.cacheReadTokens || 0),
    cacheWriteTokens: Number(row.cacheWriteTokens || 0)
  };
}

function mysqlCostAggregateSelect(alias = "u") {
  const prefix = alias ? `${alias}.` : "";
  return `
    COALESCE(SUM(${prefix}estimatedCostUsd), 0) AS estimatedCostUsd,
    SUM(CASE WHEN ${prefix}estimatedCostUsd IS NULL THEN ${prefix}totalTokens ELSE 0 END) AS missingPriceTokens,
    SUM(CASE WHEN ${prefix}estimatedCostUsd IS NOT NULL THEN 1 ELSE 0 END) AS knownPriceRows,
    MAX(CASE
      WHEN ${prefix}estimatedCostUsd IS NULL OR ${prefix}costQuality = 'unknown_price' THEN 2
      WHEN ${prefix}costQuality = 'estimated_price' THEN 1
      WHEN ${prefix}costQuality = 'exact_price' THEN 0
      ELSE -1
    END) AS costQualityRank,
    MAX(${prefix}pricingVersion) AS pricingVersion,
    MAX(${prefix}pricingSource) AS pricingSource`;
}

function mysqlCostFields(row) {
  const knownPriceRows = Number(row.knownPriceRows || 0);
  const missingPriceTokens = Number(row.missingPriceTokens || 0);
  const hasKnownPrice = knownPriceRows > 0;
  return {
    inputCostUsd: null,
    outputCostUsd: null,
    cacheReadCostUsd: null,
    cacheWriteCostUsd: null,
    reasoningCostUsd: null,
    estimatedCostUsd: hasKnownPrice ? roundMysqlUsd(row.estimatedCostUsd) : null,
    costQuality: mysqlCostQuality(row.costQualityRank),
    pricingVersion: row.pricingVersion || "",
    pricingSource: row.pricingSource || "",
    missingPriceTokens,
    missingPriceModels: []
  };
}

function mysqlCostQuality(rank) {
  const number = Number(rank);
  if (number >= 2) return "unknown_price";
  if (number === 1) return "estimated_price";
  if (number === 0) return "exact_price";
  return "unknown_price";
}

function roundMysqlUsd(value) {
  const number = Number(value || 0);
  return Math.round(number * 100000000) / 100000000;
}

function groupBreakdowns(rows, keyField, { includeCost = false } = {}) {
  const map = new Map();
  for (const row of rows || []) {
    const key = row[keyField] || "";
    const item = {
      name: row.name || "unknown",
      totalTokens: Number(row.totalTokens || 0),
      ...(includeCost ? mysqlCostFields(row) : {})
    };
    const list = map.get(key) || [];
    list.push(item);
    map.set(key, list);
  }
  for (const [key, list] of map.entries()) {
    map.set(key, list.sort((a, b) => b.totalTokens - a.totalTokens));
  }
  return map;
}

function mysqlPeriodExpressions(grain = "day", alias = "u") {
  const day = alias ? `${alias}.day` : "day";
  if (grain === "month") {
    const start = `DATE_FORMAT(${day}, '%Y-%m-01')`;
    return { selectStart: start, selectEnd: `DATE_FORMAT(LAST_DAY(${day}), '%Y-%m-%d')`, groupBy: start };
  }
  if (grain === "week") {
    const start = `DATE_FORMAT(DATE_SUB(${day}, INTERVAL WEEKDAY(${day}) DAY), '%Y-%m-%d')`;
    return { selectStart: start, selectEnd: `DATE_FORMAT(DATE_ADD(DATE_SUB(${day}, INTERVAL WEEKDAY(${day}) DAY), INTERVAL 6 DAY), '%Y-%m-%d')`, groupBy: start };
  }
  return { selectStart: `DATE_FORMAT(${day}, '%Y-%m-%d')`, selectEnd: `DATE_FORMAT(${day}, '%Y-%m-%d')`, groupBy: `DATE_FORMAT(${day}, '%Y-%m-%d')` };
}

function mysqlNormalizeGrain(grain) {
  return ["day", "week", "month"].includes(grain) ? grain : "day";
}

function mysqlRangeBounds(days) {
  const unique = [...new Set(days || [])].sort();
  return { from: unique[0] || "0000-01-01", to: unique.at(-1) || "0000-01-01" };
}

function mysqlRangeSum(field, _name, range) {
  return `COALESCE(SUM(CASE WHEN day BETWEEN ? AND ? THEN COALESCE(${field}, 0) ELSE 0 END), 0)`;
}

function mysqlDaysForQuery({ period = "", range = "today", startDay = "", endDay = "" } = {}, { businessDay = localDay() } = {}) {
  if (period) return mysqlDaysForPeriod(period, { businessDay });
  return mysqlDaysForRange(range, { startDay, endDay, businessDay });
}

function mysqlDayPredicate(days, prefix = "") {
  if (!days) return { sql: "", params: [] };
  const unique = [...new Set(days)].sort();
  if (!unique.length) return { sql: "1 = 0", params: [] };
  if (unique.length === 1) return { sql: `${prefix}day = ?`, params: [unique[0]] };
  return { sql: `${prefix}day BETWEEN ? AND ?`, params: [unique[0], unique.at(-1)] };
}

function mysqlDaysForPeriod(period, { businessDay = localDay() } = {}) {
  const today = businessDay;
  if (period === "today") return [today];
  if (period === "yesterday") return [addDays(today, -1)];
  if (period === "this_week" || period === "last_week") {
    const start = mysqlStartOfUtcWeek(dayToUtcDate(today));
    if (period === "last_week") start.setUTCDate(start.getUTCDate() - 7);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    return daysBetween(mysqlToDay(start), mysqlToDay(period === "this_week" && end > dayToUtcDate(today) ? dayToUtcDate(today) : end));
  }
  if (period === "this_month" || period === "last_month") {
    const todayDate = dayToUtcDate(today);
    const start = new Date(Date.UTC(todayDate.getUTCFullYear(), todayDate.getUTCMonth() + (period === "last_month" ? -1 : 0), 1));
    const end = period === "last_month"
      ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
      : todayDate;
    return daysBetween(mysqlToDay(start), mysqlToDay(end));
  }
  return mysqlDaysForPeriod("today", { businessDay });
}

function mysqlDaysForRange(range, { startDay = "", endDay = "", businessDay = localDay() } = {}) {
  const today = businessDay;
  if (range === "all") return null;
  if (range === "custom" && mysqlIsDay(startDay) && mysqlIsDay(endDay)) return daysBetween(startDay, endDay);
  if (["today", "yesterday", "this_week", "last_week", "this_month", "last_month"].includes(range)) {
    return mysqlDaysForPeriod(range, { businessDay });
  }
  if (range === "month" || range === "lastMonth") {
    const todayDate = dayToUtcDate(today);
    const year = todayDate.getUTCFullYear();
    const month = todayDate.getUTCMonth() + (range === "lastMonth" ? -1 : 0);
    const start = new Date(Date.UTC(year, month, 1));
    const end = range === "lastMonth"
      ? new Date(Date.UTC(year, month + 1, 0))
      : todayDate;
    return daysBetween(mysqlToDay(start), mysqlToDay(end));
  }
  if (range === "last7" || range === "7d") return mysqlTrailingDays(7, { businessDay });
  if (range === "last30" || range === "30d") return mysqlTrailingDays(30, { businessDay });
  if (range === "last12_weeks") return mysqlDaysForLastWeeks(12, { businessDay });
  if (range === "last12_months") return mysqlDaysForLastMonths(12, { businessDay });
  return [today];
}

function mysqlTrailingDays(count, { businessDay = localDay() } = {}) {
  const today = dayToUtcDate(businessDay);
  return Array.from({ length: count }, (_, index) => {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - count + index + 1);
    return mysqlToDay(d);
  });
}

function mysqlDaysForLastWeeks(count, { businessDay = localDay() } = {}) {
  const today = dayToUtcDate(businessDay);
  const start = mysqlStartOfUtcWeek(today);
  start.setUTCDate(start.getUTCDate() - ((count - 1) * 7));
  return daysBetween(mysqlToDay(start), mysqlToDay(today));
}

function mysqlDaysForLastMonths(count, { businessDay = localDay() } = {}) {
  const today = dayToUtcDate(businessDay);
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - count + 1, 1));
  return daysBetween(mysqlToDay(start), mysqlToDay(today));
}

function mysqlToDay(date) {
  return utcDateToDay(date);
}

function mysqlStartOfUtcWeek(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - day + 1);
  return start;
}

function mysqlIsDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function nonNegativeNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0) throw new Error("price fields must be non-negative numbers");
  return n;
}
