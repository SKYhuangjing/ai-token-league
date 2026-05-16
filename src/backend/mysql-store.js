import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { Store } from "./store.js";
import { normalizeModelName } from "../shared/pricing.js";
import { localDay } from "../shared/date.js";
import { displayTotalTokens } from "../shared/schema.js";

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
    this.config = {
      uri: config.uri || process.env.MYSQL_URL || "",
      host: config.host || process.env.MYSQL_HOST || "127.0.0.1",
      port: Number(config.port || process.env.MYSQL_PORT || 3306),
      user: config.user || process.env.MYSQL_USER || "ai_token",
      password: config.password || process.env.MYSQL_PASSWORD || "ai_token",
      database: config.database || process.env.MYSQL_DATABASE || "ai_token_league",
      connectionLimit: Number(config.connectionLimit || process.env.MYSQL_CONNECTION_LIMIT || 8)
    };
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
  }

  async load() {
    const [participants] = await this.pool.query("SELECT * FROM participants");
    const [devices] = await this.pool.query("SELECT * FROM devices");
    const [workdirs] = await this.pool.query("SELECT * FROM workdirs");
    const [usageRows] = await this.pool.query("SELECT * FROM usage_daily");
    const [uploadBatches] = await this.pool.query("SELECT * FROM upload_batches");
    const [modelPrices] = await this.pool.query("SELECT * FROM model_prices");
    const [modelPriceAliases] = await this.pool.query("SELECT * FROM model_price_aliases");
    const [modelPriceCache] = await this.pool.query("SELECT * FROM model_price_cache");
    const [modelPriceCacheMeta] = await this.pool.query("SELECT * FROM model_price_cache_meta WHERE source = 'openrouter'");
    const syncBuckets = await this.pool.query("SELECT * FROM usage_sync_buckets").catch(() => [[]]);
    const usageHourlyRows = await this.pool.query("SELECT * FROM usage_hourly").catch(() => [[]]);
    const syncBucketsHourly = await this.pool.query("SELECT * FROM usage_sync_buckets_hourly").catch(() => [[]]);
    this.db.participants = Object.fromEntries(participants.map((row) => [row.id, normalizeRow(row)]));
    this.db.devices = Object.fromEntries(devices.map((row) => [row.id, normalizeRow(row)]));
    this.db.workdirs = Object.fromEntries(workdirs.map((row) => [row.id, normalizeRow(row)]));
    this.db.usageDaily = Object.fromEntries(usageRows.map((row) => [row.usageKey, usageFromRow(row)]));
    this.db.uploadBatches = Object.fromEntries(uploadBatches.map((row) => [row.payloadHash, normalizeRow(row)]));
    this.db.modelPrices = Object.fromEntries(modelPrices.map((row) => [row.model, priceFromRow(row)]));
    this.db.modelPriceAliases = Object.fromEntries(modelPriceAliases.map((row) => [row.model, row.targetModel]));
    this.db.modelPriceCache = {
      remote: modelPriceCacheMeta[0] ? normalizeRow(modelPriceCacheMeta[0]) : this.db.modelPriceCache.remote,
      prices: Object.fromEntries(modelPriceCache.map((row) => [row.model, cachedPriceFromRow(row)]))
    };
    this.db.aggregateCache = {};
    this.db.usageSyncBuckets = Object.fromEntries(
      syncBuckets[0].map((row) => [row.bucketKey, normalizeRow(row)])
    );
    this.db.usageHourly = Object.fromEntries(usageHourlyRows[0].map((row) => [row.usageKey, usageFromRow(row)]));
    this.db.usageSyncBucketsHourly = Object.fromEntries(
      syncBucketsHourly[0].map((row) => [row.bucketKey, normalizeRow(row)])
    );
    if (this.migrateLegacyUsageRows()) await this.syncUsageDaily();
  }

  async registerDevice(input) {
    const result = super.registerDevice(input);
    await this.syncIdentityTables();
    return result;
  }

  async upsertUsageBatch(input) {
    if (input.snapshot?.mode === "device_day_hour_provider") {
      const result = Store.prototype.upsertUsageBatch.call(this, input);
      if (!result.noOp) await this.syncAllTables();
      return result;
    }
    if (input.snapshot) return this.upsertSnapshotBatch(input);
    const result = super.upsertUsageBatch(input);
    if (!result.duplicate) await this.syncAllTables();
    return result;
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

  async recalculateCosts() {
    const result = super.recalculateCosts();
    await this.syncUsageDaily();
    return result;
  }

  async refreshOpenRouterPrices(input) {
    const result = await super.refreshOpenRouterPrices(input);
    await this.syncPriceCache();
    if (result.recalculated) await this.syncUsageDaily();
    return result;
  }

  async upsertModelPrice(input) {
    const model = normalizeModelName(input.model || "");
    if (!model) throw new Error("model is required");
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
    const recalculated = Store.prototype.recalculateCosts.call(this);
    await this.syncAllTables();
    return { price, recalculated };
  }

  async deleteModelPrice(model) {
    const normalized = normalizeModelName(model || "");
    if (!normalized || !this.db.modelPrices[normalized]) return { deleted: false };
    delete this.db.modelPrices[normalized];
    for (const [sourceModel, targetModel] of Object.entries(this.db.modelPriceAliases || {})) {
      if (targetModel === normalized) delete this.db.modelPriceAliases[sourceModel];
    }
    const recalculated = Store.prototype.recalculateCosts.call(this);
    await this.syncAllTables();
    return { deleted: true, recalculated };
  }

  async upsertModelPriceAlias(input) {
    const result = Store.prototype.upsertModelPriceAlias.call(this, input);
    await this.syncAllTables();
    return result;
  }

  async deleteModelPriceAlias(model) {
    const result = Store.prototype.deleteModelPriceAlias.call(this, model);
    await this.syncAllTables();
    return result;
  }

  async deleteParticipantData(participantId) {
    const result = Store.prototype.deleteParticipantData.call(this, participantId);
    await withTransaction(this.pool, async (conn) => {
      await conn.query("DELETE FROM upload_batches WHERE participantId = ?", [participantId]);
      await conn.query("DELETE FROM usage_sync_buckets WHERE participantId = ?", [participantId]);
      await conn.query("DELETE FROM usage_sync_buckets_hourly WHERE participantId = ?", [participantId]).catch(() => {});
      await conn.query("DELETE FROM usage_hourly WHERE participantId = ?", [participantId]).catch(() => {});
      await conn.query("DELETE FROM usage_daily WHERE participantId = ?", [participantId]);
      await conn.query("DELETE FROM workdirs WHERE participantId = ?", [participantId]);
      await conn.query("DELETE FROM devices WHERE participantId = ?", [participantId]);
      await conn.query("DELETE FROM participants WHERE id = ?", [participantId]);
    });
    return result;
  }

  async syncIdentityTables() {
    await withTransaction(this.pool, async (conn) => {
      await replaceParticipants(conn, Object.values(this.db.participants));
      await replaceDevices(conn, Object.values(this.db.devices));
    });
  }

  async syncUsageDaily() {
    await withTransaction(this.pool, async (conn) => {
      await conn.query("DELETE FROM usage_daily");
      await conn.query("DELETE FROM usage_hourly").catch(() => {});
      await insertUsageRows(conn, Object.entries(this.db.usageDaily));
      await insertUsageHourlyRows(conn, Object.entries(this.db.usageHourly || {}));
    });
  }

  async syncPriceCache() {
    await withTransaction(this.pool, async (conn) => {
      await replaceModelPriceCache(conn, this.db.modelPriceCache);
    });
  }

  async syncAllTables() {
    await withTransaction(this.pool, async (conn) => {
      await conn.query("DELETE FROM usage_daily");
      await conn.query("DELETE FROM usage_hourly").catch(() => {});
      await conn.query("DELETE FROM usage_sync_buckets");
      await conn.query("DELETE FROM usage_sync_buckets_hourly").catch(() => {});
      await replaceParticipants(conn, Object.values(this.db.participants));
      await replaceDevices(conn, Object.values(this.db.devices));
      await replaceWorkdirs(conn, Object.values(this.db.workdirs));
      await replaceModelPrices(conn, Object.values(this.db.modelPrices));
      await replaceModelPriceAliases(conn, this.db.modelPriceAliases);
      await replaceModelPriceCache(conn, this.db.modelPriceCache);
      await insertUsageRows(conn, Object.entries(this.db.usageDaily));
      await insertUsageHourlyRows(conn, Object.entries(this.db.usageHourly || {}));
      await replaceUsageSyncBuckets(conn, Object.values(this.db.usageSyncBuckets || {}));
      await replaceUsageSyncBucketsHourly(conn, Object.values(this.db.usageSyncBucketsHourly || {}));
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

async function replaceUsageSyncBuckets(conn, rows) {
  if (!rows.length) return;
  await conn.query(
    `INSERT INTO usage_sync_buckets
      (bucketKey, participantId, deviceId, day, providerId, granularity, bucketFingerprint, rowCount, totalTokens, clientGeneratedAt, syncedAt, updatedAt)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      granularity = VALUES(granularity),
      bucketFingerprint = VALUES(bucketFingerprint),
      rowCount = VALUES(rowCount),
      totalTokens = VALUES(totalTokens),
      clientGeneratedAt = VALUES(clientGeneratedAt),
      syncedAt = VALUES(syncedAt),
      updatedAt = VALUES(updatedAt)`,
    [rows.map((row) => [
      [row.participantId, row.deviceId, row.day, row.providerId].join("|"),
      row.participantId,
      row.deviceId,
      row.day,
      row.providerId,
      row.granularity || "daily",
      row.bucketFingerprint,
      row.rowCount || 0,
      row.totalTokens || 0,
      row.clientGeneratedAt || "",
      row.syncedAt || new Date().toISOString(),
      row.updatedAt || new Date().toISOString()
    ])]
  );
}

async function replaceUsageSyncBucketsHourly(conn, rows) {
  if (!rows.length) return;
  await conn.query(
    `INSERT INTO usage_sync_buckets_hourly
      (bucketKey, participantId, deviceId, day, hour, providerId, granularity, bucketFingerprint, rowCount, totalTokens, clientGeneratedAt, syncedAt, updatedAt)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      granularity = VALUES(granularity),
      bucketFingerprint = VALUES(bucketFingerprint),
      rowCount = VALUES(rowCount),
      totalTokens = VALUES(totalTokens),
      clientGeneratedAt = VALUES(clientGeneratedAt),
      syncedAt = VALUES(syncedAt),
      updatedAt = VALUES(updatedAt)`,
    [rows.map((row) => [
      [row.participantId, row.deviceId, row.day, row.hour ?? 0, row.providerId].join("|"),
      row.participantId,
      row.deviceId,
      row.day,
      row.hour ?? 0,
      row.providerId,
      row.granularity || "hourly",
      row.bucketFingerprint,
      row.rowCount || 0,
      row.totalTokens || 0,
      row.clientGeneratedAt || "",
      row.syncedAt || new Date().toISOString(),
      row.updatedAt || new Date().toISOString()
    ])]
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
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
}

function usageFromRow(row) {
  const normalizedRow = {
    ...row,
    inputTokens: Number(row.inputTokens || 0),
    outputTokens: Number(row.outputTokens || 0),
    totalTokens: Number(row.totalTokens || 0)
  };
  return {
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

function nonNegativeNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0) throw new Error("price fields must be non-negative numbers");
  return n;
}
