import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { Store } from "./store.js";
import { normalizeModelName } from "../shared/pricing.js";

const MIGRATION_PATH = path.resolve("migrations/001_init_mysql.sql");

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
  }

  async load() {
    const [participants] = await this.pool.query("SELECT * FROM participants");
    const [devices] = await this.pool.query("SELECT * FROM devices");
    const [workdirs] = await this.pool.query("SELECT * FROM workdirs");
    const [usageRows] = await this.pool.query("SELECT * FROM usage_daily");
    const [uploadBatches] = await this.pool.query("SELECT * FROM upload_batches");
    const [modelPrices] = await this.pool.query("SELECT * FROM model_prices");
    this.db.participants = Object.fromEntries(participants.map((row) => [row.id, normalizeRow(row)]));
    this.db.devices = Object.fromEntries(devices.map((row) => [row.id, normalizeRow(row)]));
    this.db.workdirs = Object.fromEntries(workdirs.map((row) => [row.id, normalizeRow(row)]));
    this.db.usageDaily = Object.fromEntries(usageRows.map((row) => [row.usageKey, usageFromRow(row)]));
    this.db.uploadBatches = Object.fromEntries(uploadBatches.map((row) => [row.payloadHash, normalizeRow(row)]));
    this.db.modelPrices = Object.fromEntries(modelPrices.map((row) => [row.model, priceFromRow(row)]));
    this.db.aggregateCache = {};
  }

  async registerDevice(input) {
    const result = super.registerDevice(input);
    await this.syncIdentityTables();
    return result;
  }

  async upsertUsageBatch(input) {
    const result = super.upsertUsageBatch(input);
    if (!result.duplicate) await this.syncAllTables();
    return result;
  }

  async recalculateCosts() {
    const result = super.recalculateCosts();
    await this.syncUsageDaily();
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
      reasoningCostPerMTok: nonNegativeNumber(input.reasoningCostPerMTok),
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
    const recalculated = Store.prototype.recalculateCosts.call(this);
    await this.syncAllTables();
    return { deleted: true, recalculated };
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
      await insertUsageRows(conn, Object.entries(this.db.usageDaily));
    });
  }

  async syncAllTables() {
    await withTransaction(this.pool, async (conn) => {
      await conn.query("DELETE FROM usage_daily");
      await replaceParticipants(conn, Object.values(this.db.participants));
      await replaceDevices(conn, Object.values(this.db.devices));
      await replaceWorkdirs(conn, Object.values(this.db.workdirs));
      await replaceModelPrices(conn, Object.values(this.db.modelPrices));
      await insertUsageRows(conn, Object.entries(this.db.usageDaily));
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
      (id, participantId, os, appVersion, createdAt, lastSeenAt, revokedAt)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      participantId = VALUES(participantId),
      os = VALUES(os),
      appVersion = VALUES(appVersion),
      lastSeenAt = VALUES(lastSeenAt),
      revokedAt = VALUES(revokedAt)`,
    [rows.map((row) => [row.id, row.participantId, row.os || "unknown", row.appVersion || "0.0.0", row.createdAt, row.lastSeenAt, row.revokedAt || null])]
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
       estimatedCostUsd, costQuality, pricingVersion, pricingModel, sourceQuality,
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
  return {
    day: toDayString(row.day),
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
    totalTokens: Number(row.totalTokens || 0),
    estimatedCostUsd: row.estimatedCostUsd === null ? null : Number(row.estimatedCostUsd),
    costQuality: row.costQuality || "",
    pricingVersion: row.pricingVersion || "",
    pricingModel: row.pricingModel || "",
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

function toDayString(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || "").slice(0, 10);
}

function nonNegativeNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0) throw new Error("price fields must be non-negative numbers");
  return n;
}
