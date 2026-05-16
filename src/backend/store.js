import fs from "node:fs";
import path from "node:path";
import { newId, sha256Hex } from "../shared/crypto.js";
import { compositionRatio, costQualityLabel, dominantComposition, tokenCompositionSummary } from "../shared/composition.js";
import { addCostToUsageItem, aggregateCost, createPriceMap, normalizeModelName, priceToPublic } from "../shared/pricing.js";
import { STORAGE_SCHEMA_VERSION, assertNoForbiddenUploadFields, assertSnapshot, assertUsageItem, computeBucketFingerprint, displayTotalTokens, hourlyUsageKey, usageKey } from "../shared/schema.js";
import { addDays, dayToUtcDate, daysBetween, localDay, utcDateToDay } from "../shared/date.js";
import { fetchOpenRouterModelPrices } from "./openrouter-pricing.js";
import { currentBusinessDay } from "./day-context.js";

export const DEFAULT_DB = {
  schemaVersion: STORAGE_SCHEMA_VERSION,
  participants: {},
  devices: {},
  workdirs: {},
  usageDaily: {},
  usageHourly: {},
  usageSyncBuckets: {},
  usageSyncBucketsHourly: {},
  modelPrices: {},
  modelPriceAliases: {},
  modelPriceCache: {
    remote: { source: "openrouter", status: "empty", url: "", fetchedAt: "", expiresAt: "", pricingVersion: "", lastError: "" },
    prices: {}
  },
  uploadBatches: {},
  aggregateCache: {}
};

export class Store {
  constructor(dbPath = path.resolve("data/db.json"), options = {}) {
    this.persist = options.persist !== false;
    this.dbPath = dbPath;
    if (this.persist) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.businessDayProvider = options.businessDayProvider || currentBusinessDay;
    this.db = this.persist && fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, "utf8")) : structuredClone(DEFAULT_DB);
    this.db.schemaVersion ||= STORAGE_SCHEMA_VERSION;
    this.db.aggregateCache ||= {};
    this.db.modelPrices ||= {};
    this.db.modelPriceAliases ||= {};
    this.db.modelPriceCache ||= structuredClone(DEFAULT_DB.modelPriceCache);
    this.db.modelPriceCache.remote ||= structuredClone(DEFAULT_DB.modelPriceCache.remote);
    this.db.modelPriceCache.prices ||= {};
    this.db.usageSyncBuckets ||= {};
    this.db.usageHourly ||= {};
    this.db.usageSyncBucketsHourly ||= {};
    if (this.migrateLegacyUsageRows()) this.save();
  }

  save() {
    if (!this.persist) return;
    fs.writeFileSync(this.dbPath, `${JSON.stringify(this.db, null, 2)}\n`);
  }

  currentBusinessDay() {
    return this.businessDayProvider();
  }

  registerDevice(input) {
    const now = new Date().toISOString();
    if (!input.participantId || !input.deviceId || !input.identityPublicKey) {
      throw new Error("participantId, deviceId and identityPublicKey are required");
    }
    const existing = this.db.participants[input.participantId];
    if (existing && existing.identityPublicKey !== input.identityPublicKey) {
      throw new Error("participant identityPublicKey mismatch");
    }
    this.db.participants[input.participantId] = {
      id: input.participantId,
      nickname: input.nickname || existing?.nickname || "anonymous",
      avatarColor: existing?.avatarColor || colorFromId(input.participantId),
      identityPublicKey: input.identityPublicKey,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastSeenAt: now
    };
    this.db.devices[input.deviceId] = {
      id: input.deviceId,
      participantId: input.participantId,
      os: input.os || "unknown",
      appVersion: input.appVersion || "0.0.0",
      clientAppVersion: input.clientAppVersion || input.client?.clientAppVersion || input.appVersion || "0.0.0",
      clientProtocolVersion: input.clientProtocolVersion ?? input.client?.clientProtocolVersion ?? null,
      clientPlatform: input.clientPlatform || input.client?.clientPlatform || input.os || "unknown",
      clientBuild: input.clientBuild || input.client?.clientBuild || "",
      lanIp: input.networkInfo?.lanIps?.join(", ") || this.db.devices[input.deviceId]?.lanIp || "",
      createdAt: this.db.devices[input.deviceId]?.createdAt || now,
      lastSeenAt: now
    };
    this.invalidateAggregateCache();
    this.save();
    return { deviceId: input.deviceId, serverTime: now };
  }

  getParticipant(participantId) {
    return this.db.participants[participantId] || null;
  }

  deleteParticipantData(participantId) {
    if (!participantId) throw new Error("participantId is required");
    const removed = {
      participants: this.db.participants[participantId] ? 1 : 0,
      devices: 0,
      workdirs: 0,
      usageDaily: 0,
      uploadBatches: 0,
      usageSyncBuckets: 0
    };
    delete this.db.participants[participantId];
    for (const [id, row] of Object.entries(this.db.devices || {})) {
      if (row.participantId === participantId) {
        delete this.db.devices[id];
        removed.devices += 1;
      }
    }
    for (const [id, row] of Object.entries(this.db.workdirs || {})) {
      if (row.participantId === participantId) {
        delete this.db.workdirs[id];
        removed.workdirs += 1;
      }
    }
    for (const [key, row] of Object.entries(this.db.usageDaily || {})) {
      if (row.participantId === participantId) {
        delete this.db.usageDaily[key];
        removed.usageDaily += 1;
      }
    }
    for (const [key, row] of Object.entries(this.db.uploadBatches || {})) {
      if (row.participantId === participantId) {
        delete this.db.uploadBatches[key];
        removed.uploadBatches += 1;
      }
    }
    for (const [key, row] of Object.entries(this.db.usageSyncBuckets || {})) {
      if (row.participantId === participantId) {
        delete this.db.usageSyncBuckets[key];
        removed.usageSyncBuckets += 1;
      }
    }
    this.invalidateAggregateCache();
    this.save();
    return {
      deleted: Object.values(removed).some((count) => count > 0),
      participantId,
      removed
    };
  }

  upsertUsageBatch(input) {
    if (input.snapshot?.mode === "device_day_hour_provider") return this.upsertHourlySnapshotBatch(input);
    if (input.snapshot) return this.upsertSnapshotBatch(input);
    const now = new Date().toISOString();
    assertNoForbiddenUploadFields(input);
    const batchPayloadHash = sha256Hex(JSON.stringify({ ...input, signature: undefined }));
    if (this.db.uploadBatches[batchPayloadHash]) {
      return { accepted: 0, rejected: 0, duplicate: true, batchId: this.db.uploadBatches[batchPayloadHash].id };
    }
    let accepted = 0;
    let rejected = 0;
    for (const incoming of input.items || []) {
      try {
        const raw = normalizeUsageTotal(incoming);
        assertUsageItem(raw);
        const workdirId = `${input.participantId}:${raw.workdirHash}`;
        this.db.workdirs[workdirId] = {
          id: workdirId,
          participantId: input.participantId,
          workdirHash: raw.workdirHash,
          alias: raw.workdirAlias || "",
          detectedName: raw.workdirDisplayName,
          displayName: raw.workdirAlias || raw.workdirDisplayName,
          sourceProvider: raw.providerId,
          updatedAt: now,
          lastSeenAt: now,
          createdAt: this.db.workdirs[workdirId]?.createdAt || now
        };
        const key = usageKey(raw, input.participantId, input.deviceId);
        if (raw.model && raw.model !== "unknown") {
          delete this.db.usageDaily[
            [raw.day, input.participantId, input.deviceId, raw.toolCode, raw.providerId, raw.workdirHash, "unknown"].join("|")
          ];
        }
        if (raw.sourceFingerprint) {
          for (const [existingKey, existing] of Object.entries(this.db.usageDaily)) {
            if (
              existingKey !== key &&
              existing.day === raw.day &&
              existing.participantId === input.participantId &&
              existing.deviceId === input.deviceId &&
              existing.toolCode === raw.toolCode &&
              existing.providerId === raw.providerId &&
              existing.workdirHash === raw.workdirHash &&
              existing.model === raw.model &&
              existing.sourceFingerprint === raw.sourceFingerprint
            ) {
              delete this.db.usageDaily[existingKey];
            }
          }
        }
        if (raw.toolCode === "cursor" && raw.workdirDisplayName === "Cursor") {
          for (const [existingKey, existing] of Object.entries(this.db.usageDaily)) {
            if (
              existingKey !== key &&
              existing.day === raw.day &&
              existing.participantId === input.participantId &&
              existing.deviceId === input.deviceId &&
              existing.toolCode === raw.toolCode &&
              existing.providerId === raw.providerId &&
              existing.model === raw.model &&
              existing.workdirDisplayName === raw.workdirDisplayName
            ) {
              delete this.db.usageDaily[existingKey];
            }
          }
        }
        if (this.db.usageDaily[key]?.hourlyDerived) {
          accepted += 1;
          continue;
        }
        const withCost = addCostToUsageItem(raw, this.priceMap());
        this.db.usageDaily[key] = {
          ...raw,
          inputCostUsd: withCost.inputCostUsd,
          outputCostUsd: withCost.outputCostUsd,
          cacheReadCostUsd: withCost.cacheReadCostUsd,
          cacheWriteCostUsd: withCost.cacheWriteCostUsd,
          reasoningCostUsd: withCost.reasoningCostUsd,
          estimatedCostUsd: withCost.estimatedCostUsd,
          costQuality: withCost.costQuality,
          pricingVersion: withCost.pricingVersion,
          pricingModel: withCost.pricingModel,
          pricingSource: withCost.pricingSource || "",
          participantId: input.participantId,
          deviceId: input.deviceId,
          workdirId,
          rawSourceRef: raw.rawSourceRef || "",
          providerVersion: raw.providerVersion || "",
          parserVersion: raw.parserVersion || raw.providerVersion || "",
          sourceFingerprint: raw.sourceFingerprint || "",
          uploadedAt: now
        };
        accepted += 1;
      } catch {
        rejected += 1;
      }
    }
    const batchId = newId("ub");
    this.db.uploadBatches[batchPayloadHash] = {
      id: batchId,
      participantId: input.participantId,
      deviceId: input.deviceId,
      payloadHash: batchPayloadHash,
      clientGeneratedAt: input.clientGeneratedAt || "",
      receivedAt: now,
      status: rejected ? (accepted ? "partial" : "rejected") : "accepted",
      accepted,
      rejected
    };
    this.invalidateAggregateCache();
    this.save();
    return { accepted, rejected, batchId };
  }

  upsertSnapshotBatch(input) {
    const now = new Date().toISOString();
    const snapshot = input.snapshot;
    assertSnapshot(snapshot, input.items, input.participantId, input.deviceId);
    const serverBucketFingerprint = computeBucketFingerprint(input.items || []);
    const serverBucketTotalTokens = (input.items || []).reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);

    // Idempotency is based on the server-computed bucket fingerprint, not the client-declared value.
    const existing = this.getBucketSync(input.participantId, input.deviceId, snapshot.day, snapshot.providerId);
    if (existing && existing.bucketFingerprint === serverBucketFingerprint) {
      return { accepted: existing.rowCount, rejected: 0, duplicate: true, noOp: true };
    }

    assertNoForbiddenUploadFields(input);
    let accepted = 0;
    let rejected = 0;
    const incomingKeys = new Set();

    for (const incoming of input.items || []) {
      try {
        const raw = normalizeUsageTotal(incoming);
        assertUsageItem(raw);
        const workdirId = `${input.participantId}:${raw.workdirHash}`;
        this.db.workdirs[workdirId] = {
          id: workdirId,
          participantId: input.participantId,
          workdirHash: raw.workdirHash,
          alias: raw.workdirAlias || "",
          detectedName: raw.workdirDisplayName,
          displayName: raw.workdirAlias || raw.workdirDisplayName,
          sourceProvider: raw.providerId,
          updatedAt: now,
          lastSeenAt: now,
          createdAt: this.db.workdirs[workdirId]?.createdAt || now
        };
        const key = usageKey(raw, input.participantId, input.deviceId);
        incomingKeys.add(key);

        // unknown model cleanup (keep)
        if (raw.model && raw.model !== "unknown") {
          delete this.db.usageDaily[
            [raw.day, input.participantId, input.deviceId, raw.toolCode, raw.providerId, raw.workdirHash, "unknown"].join("|")
          ];
        }

        if (this.db.usageDaily[key]?.hourlyDerived) {
          accepted += 1;
          continue;
        }
        const withCost = addCostToUsageItem(raw, this.priceMap());
        this.db.usageDaily[key] = {
          ...raw,
          inputCostUsd: withCost.inputCostUsd,
          outputCostUsd: withCost.outputCostUsd,
          cacheReadCostUsd: withCost.cacheReadCostUsd,
          cacheWriteCostUsd: withCost.cacheWriteCostUsd,
          reasoningCostUsd: withCost.reasoningCostUsd,
          estimatedCostUsd: withCost.estimatedCostUsd,
          costQuality: withCost.costQuality,
          pricingVersion: withCost.pricingVersion,
          pricingModel: withCost.pricingModel,
          pricingSource: withCost.pricingSource || "",
          participantId: input.participantId,
          deviceId: input.deviceId,
          workdirId,
          rawSourceRef: raw.rawSourceRef || "",
          providerVersion: raw.providerVersion || "",
          parserVersion: raw.parserVersion || raw.providerVersion || "",
          sourceFingerprint: raw.sourceFingerprint || "",
          uploadedAt: now
        };
        accepted += 1;
      } catch {
        rejected += 1;
      }
    }

    // bucket-scoped delete of stale rows
    this.deleteBucketUsageRows(input.participantId, input.deviceId, snapshot.day, snapshot.providerId, [...incomingKeys]);

    // record bucket metadata
    this.recordBucketSync({
      participantId: input.participantId,
      deviceId: input.deviceId,
      day: snapshot.day,
      providerId: snapshot.providerId,
      granularity: "daily",
      bucketFingerprint: serverBucketFingerprint,
      rowCount: accepted,
      totalTokens: serverBucketTotalTokens,
      clientGeneratedAt: input.clientGeneratedAt || ""
    });

    this.invalidateAggregateCache();
    this.save();
    return { accepted, rejected, incomingKeys: [...incomingKeys] };
  }

  /// Hourly snapshot: write to usageHourly, then derive daily aggregates into usageDaily.
  upsertHourlySnapshotBatch(input) {
    const now = new Date().toISOString();
    const snapshot = input.snapshot;
    assertSnapshot(snapshot, input.items, input.participantId, input.deviceId);
    const serverBucketFingerprint = computeBucketFingerprint(input.items || []);
    const serverBucketTotalTokens = (input.items || []).reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);
    const snapshotHour = snapshot.hour;

    // Idempotency check
    const existing = this.getHourlyBucketSync(input.participantId, input.deviceId, snapshot.day, snapshotHour, snapshot.providerId);
    if (existing && existing.bucketFingerprint === serverBucketFingerprint) {
      return { accepted: existing.rowCount, rejected: 0, duplicate: true, noOp: true };
    }

    assertNoForbiddenUploadFields(input);
    let accepted = 0;
    let rejected = 0;
    const incomingHourlyKeys = new Set();

    // Write hourly rows
    for (const incoming of input.items || []) {
      try {
        const raw = normalizeUsageTotal(incoming);
        assertUsageItem(raw);
        const workdirId = `${input.participantId}:${raw.workdirHash}`;
        this.db.workdirs[workdirId] = {
          id: workdirId,
          participantId: input.participantId,
          workdirHash: raw.workdirHash,
          alias: raw.workdirAlias || "",
          detectedName: raw.workdirDisplayName,
          displayName: raw.workdirAlias || raw.workdirDisplayName,
          sourceProvider: raw.providerId,
          updatedAt: now,
          lastSeenAt: now,
          createdAt: this.db.workdirs[workdirId]?.createdAt || now
        };
        const hKey = hourlyUsageKey(raw, input.participantId, input.deviceId);
        incomingHourlyKeys.add(hKey);

        const withCost = addCostToUsageItem(raw, this.priceMap());
        this.db.usageHourly[hKey] = {
          ...raw,
          hour: snapshotHour,
          inputCostUsd: withCost.inputCostUsd,
          outputCostUsd: withCost.outputCostUsd,
          cacheReadCostUsd: withCost.cacheReadCostUsd,
          cacheWriteCostUsd: withCost.cacheWriteCostUsd,
          reasoningCostUsd: withCost.reasoningCostUsd,
          estimatedCostUsd: withCost.estimatedCostUsd,
          costQuality: withCost.costQuality,
          pricingVersion: withCost.pricingVersion,
          pricingModel: withCost.pricingModel,
          pricingSource: withCost.pricingSource || "",
          participantId: input.participantId,
          deviceId: input.deviceId,
          workdirId,
          rawSourceRef: raw.rawSourceRef || "",
          providerVersion: raw.providerVersion || "",
          parserVersion: raw.parserVersion || raw.providerVersion || "",
          sourceFingerprint: raw.sourceFingerprint || "",
          uploadedAt: now
        };
        accepted += 1;
      } catch {
        rejected += 1;
      }
    }

    // Delete stale hourly rows for this bucket
    this.deleteHourlyBucketUsageRows(input.participantId, input.deviceId, snapshot.day, snapshotHour, snapshot.providerId, [...incomingHourlyKeys]);

    // Record hourly bucket metadata
    this.recordHourlyBucketSync({
      participantId: input.participantId,
      deviceId: input.deviceId,
      day: snapshot.day,
      hour: snapshotHour,
      providerId: snapshot.providerId,
      granularity: "hourly",
      bucketFingerprint: serverBucketFingerprint,
      rowCount: accepted,
      totalTokens: serverBucketTotalTokens,
      clientGeneratedAt: input.clientGeneratedAt || ""
    });

    // Derive daily aggregates from hourly for the affected day+provider
    this.deriveDailyFromHourly(input.participantId, input.deviceId, snapshot.day, snapshot.providerId);

    this.invalidateAggregateCache();
    this.save();
    return { accepted, rejected, incomingKeys: [...incomingHourlyKeys] };
  }

  /// Derive daily rows from hourly rows for a given participant+device+day+provider.
  /// Hourly-derived daily rows take priority over legacy daily rows.
  deriveDailyFromHourly(participantId, deviceId, day, providerId) {
    const now = new Date().toISOString();
    // Collect all hourly rows for this bucket
    const hourlyRows = Object.entries(this.db.usageHourly).filter(
      ([, row]) => row.participantId === participantId && row.deviceId === deviceId && row.day === day && row.providerId === providerId
    );
    if (!hourlyRows.length) return;

    // Group by (toolCode, workdirHash, model) and sum tokens
    const groups = {};
    for (const [, row] of hourlyRows) {
      const gKey = [row.toolCode, row.workdirHash, row.model].join("|");
      if (!groups[gKey]) {
        groups[gKey] = { first: row, count: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
      }
      const g = groups[gKey];
      g.count++;
      g.inputTokens += Number(row.inputTokens || 0);
      g.outputTokens += Number(row.outputTokens || 0);
      g.cacheReadTokens += Number(row.cacheReadTokens || 0);
      g.cacheWriteTokens += Number(row.cacheWriteTokens || 0);
      g.reasoningTokens += Number(row.reasoningTokens || 0);
      g.totalTokens += Number(row.totalTokens || 0);
      g.estimatedCostUsd += Number(row.estimatedCostUsd || 0);
    }

    // Write derived daily rows, marking them as hourly-derived
    const derivedKeys = new Set();
    for (const [, g] of Object.entries(groups)) {
      const r = g.first;
      const dKey = usageKey(r, participantId, deviceId);
      derivedKeys.add(dKey);
      this.db.usageDaily[dKey] = {
        day,
        participantId,
        deviceId,
        toolCode: r.toolCode,
        providerId,
        workdirId: r.workdirId,
        workdirHash: r.workdirHash,
        workdirDisplayName: r.workdirDisplayName,
        model: r.model,
        inputTokens: g.inputTokens,
        outputTokens: g.outputTokens,
        cacheReadTokens: g.cacheReadTokens,
        cacheWriteTokens: g.cacheWriteTokens,
        reasoningTokens: g.reasoningTokens,
        totalTokens: g.totalTokens,
        estimatedCostUsd: g.estimatedCostUsd || null,
        costQuality: r.costQuality || "",
        pricingVersion: r.pricingVersion || "",
        pricingModel: r.pricingModel || "",
        pricingSource: r.pricingSource || "",
        sourceQuality: r.sourceQuality || "unknown",
        rawSourceRef: r.rawSourceRef || "",
        providerVersion: r.providerVersion || "",
        parserVersion: r.parserVersion || "",
        sourceFingerprint: r.sourceFingerprint || "",
        uploadedAt: now,
        hourlyDerived: true
      };
    }

    // Delete any non-derived daily rows for this bucket that are no longer valid
    // (legacy rows that should be replaced by hourly-derived rows)
    for (const [key, row] of Object.entries(this.db.usageDaily)) {
      if (
        row.participantId === participantId &&
        row.deviceId === deviceId &&
        row.day === day &&
        row.providerId === providerId &&
        row.hourlyDerived &&
        !derivedKeys.has(key)
      ) {
        delete this.db.usageDaily[key];
      }
    }
  }

  invalidateAggregateCache() {
    this.db.aggregateCache = {};
  }

  bucketSyncKey(participantId, deviceId, day, providerId) {
    return [participantId, deviceId, day, providerId].join("|");
  }

  getBucketSync(participantId, deviceId, day, providerId) {
    return this.db.usageSyncBuckets[this.bucketSyncKey(participantId, deviceId, day, providerId)] || null;
  }

  recordBucketSync({ participantId, deviceId, day, providerId, granularity, bucketFingerprint, rowCount, totalTokens, clientGeneratedAt }) {
    const now = new Date().toISOString();
    const key = this.bucketSyncKey(participantId, deviceId, day, providerId);
    this.db.usageSyncBuckets[key] = {
      participantId, deviceId, day, providerId,
      granularity: granularity || "daily",
      bucketFingerprint, rowCount, totalTokens,
      clientGeneratedAt: clientGeneratedAt || "",
      syncedAt: now,
      updatedAt: now
    };
  }

  deleteBucketUsageRows(participantId, deviceId, day, providerId, incomingUsageKeys) {
    const keySet = new Set(incomingUsageKeys);
    for (const [key, row] of Object.entries(this.db.usageDaily)) {
      if (
        row.participantId === participantId &&
        row.deviceId === deviceId &&
        row.day === day &&
        row.providerId === providerId &&
        !row.hourlyDerived &&
        !keySet.has(key)
      ) {
        delete this.db.usageDaily[key];
      }
    }
  }

  // Hourly bucket methods
  hourlyBucketSyncKey(participantId, deviceId, day, hour, providerId) {
    return [participantId, deviceId, day, hour, providerId].join("|");
  }

  getHourlyBucketSync(participantId, deviceId, day, hour, providerId) {
    return this.db.usageSyncBucketsHourly[this.hourlyBucketSyncKey(participantId, deviceId, day, hour, providerId)] || null;
  }

  recordHourlyBucketSync({ participantId, deviceId, day, hour, providerId, granularity, bucketFingerprint, rowCount, totalTokens, clientGeneratedAt }) {
    const now = new Date().toISOString();
    const key = this.hourlyBucketSyncKey(participantId, deviceId, day, hour, providerId);
    this.db.usageSyncBucketsHourly[key] = {
      participantId, deviceId, day, hour, providerId,
      granularity: granularity || "hourly",
      bucketFingerprint, rowCount, totalTokens,
      clientGeneratedAt: clientGeneratedAt || "",
      syncedAt: now,
      updatedAt: now
    };
  }

  deleteHourlyBucketUsageRows(participantId, deviceId, day, hour, providerId, incomingUsageKeys) {
    const keySet = new Set(incomingUsageKeys);
    for (const [key, row] of Object.entries(this.db.usageHourly)) {
      if (
        row.participantId === participantId &&
        row.deviceId === deviceId &&
        row.day === day &&
        row.hour === hour &&
        row.providerId === providerId &&
        !keySet.has(key)
      ) {
        delete this.db.usageHourly[key];
      }
    }
  }

  migrateLegacyUsageRows() {
    let changed = false;
    for (const [key, item] of Object.entries(this.db.usageDaily || {})) {
      if (!item.sourceFingerprint) {
        item.rawSourceRef ||= "legacy";
        item.providerVersion ||= "legacy";
        item.parserVersion ||= "legacy";
        item.sourceFingerprint = sha256Hex(`legacy|${key}`);
        changed = true;
      }
      if (!item.costQuality || !item.pricingVersion || item.inputCostUsd === undefined) {
        Object.assign(item, addCostToUsageItem(item, this.priceMap()));
        changed = true;
      }
      const nextTotalTokens = displayTotalTokens(item);
      if (item.totalTokens !== nextTotalTokens) {
        item.totalTokens = nextTotalTokens;
        Object.assign(item, addCostToUsageItem(item, this.priceMap()));
        changed = true;
      }
    }
    if (changed) this.invalidateAggregateCache();
    return changed;
  }

  leaderboard({ period, range = "today", tool = "all", startDay = "", endDay = "" } = {}) {
    const businessDay = this.currentBusinessDay();
    const days = period ? daysForPeriod(period, { businessDay }) : daysForDetailRange(range, { startDay, endDay, businessDay });
    const rows = Object.values(this.db.usageDaily).filter((item) => {
      return days.includes(item.day) && (tool === "all" || item.toolCode === tool);
    });
    const byParticipant = new Map();
    for (const item of rows) {
      const participant = this.db.participants[item.participantId];
      if (!participant) continue;
      const current =
        byParticipant.get(item.participantId) ||
        {
          participantId: item.participantId,
          nickname: participant.nickname,
          totalTokens: 0,
          toolBreakdown: {},
          workdirBreakdown: {},
          sourceQuality: "exact",
          lastSyncedAt: item.uploadedAt
        };
      current.totalTokens += item.totalTokens;
      current.toolBreakdown[item.toolCode] = (current.toolBreakdown[item.toolCode] || 0) + item.totalTokens;
      current.workdirBreakdown[item.workdirDisplayName] = (current.workdirBreakdown[item.workdirDisplayName] || 0) + item.totalTokens;
      if (item.sourceQuality !== "exact") current.sourceQuality = "partial";
      if (item.uploadedAt > current.lastSyncedAt) current.lastSyncedAt = item.uploadedAt;
      byParticipant.set(item.participantId, current);
    }
    return [...byParticipant.values()]
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .map((item, index) => ({
        rank: index + 1,
        ...item,
        workdirs: sortedBreakdown(item.workdirBreakdown)
      }));
  }

  publicLeaderboard({ period, range = "today", startDay = "", endDay = "", includeCost = false } = {}) {
    const args = { period, range, startDay, endDay, includeCost };
    return this.cachedAggregate("publicLeaderboard", args, () => this.computePublicLeaderboard(args), { dayScoped: isDayScopedRange({ period, range, startDay, endDay }) });
  }

  boardSummary() {
    return this.cachedAggregate("boardSummary", {}, () => this.computeBoardSummary(), { dayScoped: true });
  }

  computeBoardSummary() {
    const todayItems = this.publicLeaderboard({ range: "today", includeCost: true });
    const yesterdayItems = this.publicLeaderboard({ range: "yesterday", includeCost: true });
    const weekItems = this.publicLeaderboard({ range: "this_week", includeCost: true });
    const lastWeekItems = this.publicLeaderboard({ range: "last_week", includeCost: true });
    const monthItems = this.publicLeaderboard({ range: "this_month", includeCost: true });
    const lastMonthItems = this.publicLeaderboard({ range: "last_month", includeCost: true });
    const sumTokens = (items) => items.reduce((s, i) => s + i.totalTokens, 0);
    const sumCost = (items) => items.reduce((s, i) => s + (i.estimatedCostUsd || 0), 0);
    return {
      participantCount: Object.keys(this.db.participants).length,
      todayTokens: sumTokens(todayItems),
      yesterdayTokens: sumTokens(yesterdayItems),
      weekTokens: sumTokens(weekItems),
      lastWeekTokens: sumTokens(lastWeekItems),
      thisMonthTokens: sumTokens(monthItems),
      lastMonthTokens: sumTokens(lastMonthItems),
      todayCost: sumCost(todayItems),
      yesterdayCost: sumCost(yesterdayItems),
      weekCost: sumCost(weekItems),
      lastWeekCost: sumCost(lastWeekItems),
      thisMonthCost: sumCost(monthItems),
      lastMonthCost: sumCost(lastMonthItems)
    };
  }

  computePublicLeaderboard({ period, range = "today", startDay = "", endDay = "", includeCost = false } = {}) {
    const days = daysForQuery({ period, range, startDay, endDay }, { businessDay: this.currentBusinessDay() });
    const rows = Object.values(this.db.usageDaily).filter((item) => days.includes(item.day));
    const byParticipant = new Map();
    for (const item of rows) {
      const participant = this.db.participants[item.participantId];
      if (!participant) continue;
      const current =
        byParticipant.get(item.participantId) ||
        {
          participantId: item.participantId,
          nickname: participant.nickname,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          modelBreakdown: {},
          modelCostBreakdown: {},
          estimatedCostUsd: 0,
          costQuality: ""
        };
      current.totalTokens += item.totalTokens;
      current.inputTokens += item.inputTokens || 0;
      current.outputTokens += item.outputTokens || 0;
      current.cacheReadTokens += item.cacheReadTokens || 0;
      current.cacheWriteTokens += item.cacheWriteTokens || 0;
      current.reasoningTokens += item.reasoningTokens || 0;
      current.modelBreakdown[item.model] = (current.modelBreakdown[item.model] || 0) + item.totalTokens;
      if (includeCost) {
        aggregateCost(current, item);
        addCostBreakdownItem(current.modelCostBreakdown, item.model || "unknown", item);
      }
      byParticipant.set(item.participantId, current);
    }
    return [...byParticipant.values()]
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .map((item, index) => ({
        rank: index + 1,
        participantId: item.participantId,
        nickname: item.nickname,
        totalTokens: item.totalTokens,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        cacheReadTokens: item.cacheReadTokens,
        cacheWriteTokens: item.cacheWriteTokens,
        reasoningTokens: item.reasoningTokens,
        compositionSummary: tokenCompositionSummary(item),
        dominantComposition: dominantComposition(item),
        models: includeCost ? finalizeCostBreakdown(item.modelCostBreakdown) : sortedBreakdown(item.modelBreakdown),
        ...(includeCost ? costFields(item) : {})
      }));
  }

  participantDetail(participantId, { period, range = "today", startDay = "", endDay = "", includeCost = false } = {}) {
    const participant = this.db.participants[participantId];
    if (!participant) return null;
    const days = daysForQuery({ period, range, startDay, endDay }, { businessDay: this.currentBusinessDay() });
    const rows = Object.values(this.db.usageDaily).filter((item) => item.participantId === participantId && days.includes(item.day));
    const selectedPeriod = period || range;
    const rankRow = this.publicLeaderboard({ period, range, startDay, endDay, includeCost }).find((item) => item.participantId === participantId);
    const detail = {
      participantId,
      nickname: participant.nickname,
      selectedPeriod,
      from: days[0] || "",
      to: days.at(-1) || "",
      isSingleDay: days.length <= 1,
      rank: rankRow?.rank || null,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      byDay: {},
      byModel: {},
      byModelCost: {},
      byWorkdir: {},
      byWorkdirCost: {},
      byProvider: {},
      byProviderCost: {},
      byTool: {},
      byToolCost: {},
      estimatedCostUsd: 0,
      costQuality: "",
      rows: rows
        .sort((a, b) => b.day.localeCompare(a.day) || b.totalTokens - a.totalTokens)
        .map((item) => ({
          day: item.day,
          toolCode: item.toolCode,
          providerId: item.providerId,
          workdirDisplayName: item.workdirDisplayName,
          model: item.model,
          inputTokens: item.inputTokens || 0,
          outputTokens: item.outputTokens || 0,
          cacheReadTokens: item.cacheReadTokens || 0,
          cacheWriteTokens: item.cacheWriteTokens || 0,
          reasoningTokens: item.reasoningTokens || 0,
          totalTokens: item.totalTokens,
          compositionSummary: tokenCompositionSummary(item),
          ...(includeCost ? costFields(item) : {}),
          sourceQuality: item.sourceQuality
        }))
    };
    for (const item of rows) {
      detail.totalTokens += item.totalTokens;
      detail.inputTokens += item.inputTokens || 0;
      detail.outputTokens += item.outputTokens || 0;
      detail.cacheReadTokens += item.cacheReadTokens || 0;
      detail.cacheWriteTokens += item.cacheWriteTokens || 0;
      detail.reasoningTokens += item.reasoningTokens || 0;
      detail.byDay[item.day] = (detail.byDay[item.day] || 0) + item.totalTokens;
      detail.byModel[item.model] = (detail.byModel[item.model] || 0) + item.totalTokens;
      detail.byWorkdir[item.workdirDisplayName] = (detail.byWorkdir[item.workdirDisplayName] || 0) + item.totalTokens;
      detail.byProvider[item.providerId] = (detail.byProvider[item.providerId] || 0) + item.totalTokens;
      detail.byTool[item.toolCode] = (detail.byTool[item.toolCode] || 0) + item.totalTokens;
      if (includeCost) {
        aggregateCost(detail, item);
        addCostBreakdownItem(detail.byModelCost, item.model || "unknown", item);
        addCostBreakdownItem(detail.byWorkdirCost, item.workdirDisplayName || "unknown", item);
        addCostBreakdownItem(detail.byProviderCost, item.providerId || "unknown", item);
        addCostBreakdownItem(detail.byToolCost, item.toolCode || "unknown", item);
      }
    }
    const periodRows = aggregateUsageRows(rows, "day", { participants: this.db.participants, includeCost });
    return {
      ...detail,
      compositionSummary: tokenCompositionSummary(detail),
      dominantComposition: dominantComposition(detail),
      ...(includeCost ? costFields(detail) : {}),
      days: sortedBreakdown(detail.byDay),
      periodRows,
      models: includeCost ? finalizeCostBreakdown(detail.byModelCost) : sortedBreakdown(detail.byModel),
      workdirs: includeCost ? finalizeCostBreakdown(detail.byWorkdirCost) : sortedBreakdown(detail.byWorkdir),
      providers: includeCost ? finalizeCostBreakdown(detail.byProviderCost) : sortedBreakdown(detail.byProvider),
      tools: includeCost ? finalizeCostBreakdown(detail.byToolCost) : sortedBreakdown(detail.byTool)
    };
  }

  participantTrend(participantId, { grain = "day", range = "last30", startDay = "", endDay = "", includeCost = false } = {}) {
    const participant = this.db.participants[participantId];
    if (!participant) return null;
    const days = daysForDetailRange(range, { startDay, endDay, businessDay: this.currentBusinessDay() });
    const rows = Object.values(this.db.usageDaily).filter((item) => item.participantId === participantId && days.includes(item.day));
    return {
      participantId,
      nickname: participant.nickname,
      grain: normalizeGrain(grain),
      from: days[0] || "",
      to: days.at(-1) || "",
      items: aggregateUsageRows(rows, normalizeGrain(grain), { participants: this.db.participants, includeCost })
    };
  }

  adminUsage({ grain = "day", range = "month", startDay = "", endDay = "", participantId = "", includeCost = false } = {}) {
    const args = { grain, range, startDay, endDay, participantId, includeCost };
    return this.cachedAggregate("adminUsage", args, () => this.computeAdminUsage(args), { dayScoped: isDayScopedRange({ range, startDay, endDay }) });
  }

  computeAdminUsage({ grain = "day", range = "month", startDay = "", endDay = "", participantId = "", includeCost = false } = {}) {
    const days = daysForDetailRange(range, { startDay, endDay, businessDay: this.currentBusinessDay() });
    const rows = Object.values(this.db.usageDaily).filter((item) => {
      return days.includes(item.day) && (!participantId || item.participantId === participantId);
    });
    return {
      grain: normalizeGrain(grain),
      from: days[0] || "",
      to: days.at(-1) || "",
      participants: Object.values(this.db.participants)
        .map((item) => ({ participantId: item.id, nickname: item.nickname }))
        .sort((a, b) => a.nickname.localeCompare(b.nickname)),
      items: aggregateUsageRows(rows, normalizeGrain(grain), { includeAdminFields: true, participants: this.db.participants, includeCost })
    };
  }

  cachedAggregate(name, args, compute, { dayScoped = false } = {}) {
    const cacheArgs = dayScoped ? { ...args, businessDay: this.currentBusinessDay() } : args;
    const key = sha256Hex(JSON.stringify({ name, args: cacheArgs, schemaVersion: STORAGE_SCHEMA_VERSION }));
    const cached = this.db.aggregateCache?.[key];
    if (cached) return cached.value;
    const value = compute();
    this.db.aggregateCache ||= {};
    this.db.aggregateCache[key] = {
      key,
      name,
      args: cacheArgs,
      createdAt: new Date().toISOString(),
      value
    };
    this.save();
    return value;
  }

  adminQuality({ range = "month", startDay = "", endDay = "", participantId = "" } = {}) {
    const days = daysForDetailRange(range, { startDay, endDay, businessDay: this.currentBusinessDay() });
    const rows = Object.values(this.db.usageDaily).filter((item) => {
      return days.includes(item.day) && (!participantId || item.participantId === participantId);
    });
    const totals = {
      rows: rows.length,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      unknownModelRows: 0,
      unknownWorkdirRows: 0,
      missingSourceFingerprintRows: 0,
      nonExactRows: 0,
      bySourceQuality: {},
      byProvider: {},
      abnormalDays: [],
      multiDeviceParticipants: [],
      pricingCoverage: {
        knownTokens: 0,
        missingTokens: 0,
        rowsByQuality: {
          exact_price: 0,
          estimated_price: 0,
          unknown_price: 0
        },
        participants: {},
        periods: {}
      }
    };
    const byDay = new Map();
    const devicesByParticipant = new Map();
    const byBucket = new Map();
    for (const item of rows) {
      totals.totalTokens += item.totalTokens || 0;
      totals.inputTokens += item.inputTokens || 0;
      totals.outputTokens += item.outputTokens || 0;
      totals.cacheReadTokens += item.cacheReadTokens || 0;
      totals.cacheWriteTokens += item.cacheWriteTokens || 0;
      totals.reasoningTokens += item.reasoningTokens || 0;
      if (!item.model || item.model === "unknown") totals.unknownModelRows += 1;
      if (!item.workdirDisplayName || item.workdirDisplayName === "unknown") totals.unknownWorkdirRows += 1;
      if (!item.sourceFingerprint) totals.missingSourceFingerprintRows += 1;
      if (item.sourceQuality !== "exact") totals.nonExactRows += 1;
      totals.bySourceQuality[item.sourceQuality || "unknown"] = (totals.bySourceQuality[item.sourceQuality || "unknown"] || 0) + 1;
      totals.byProvider[item.providerId || "unknown"] = (totals.byProvider[item.providerId || "unknown"] || 0) + (item.totalTokens || 0);
      byDay.set(item.day, (byDay.get(item.day) || 0) + (item.totalTokens || 0));
      const bucket = byBucket.get(item.day) || {
        day: item.day,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        participants: new Set()
      };
      bucket.totalTokens += item.totalTokens || 0;
      bucket.inputTokens += item.inputTokens || 0;
      bucket.outputTokens += item.outputTokens || 0;
      bucket.cacheReadTokens += item.cacheReadTokens || 0;
      bucket.cacheWriteTokens += item.cacheWriteTokens || 0;
      bucket.reasoningTokens += item.reasoningTokens || 0;
      bucket.participants.add(item.participantId);
      byBucket.set(item.day, bucket);
      const coverageRow = addCostToUsageItem(item, this.priceMap());
      totals.pricingCoverage.rowsByQuality[coverageRow.costQuality || "unknown_price"] += 1;
      if (coverageRow.estimatedCostUsd === null || coverageRow.estimatedCostUsd === undefined) {
        totals.pricingCoverage.missingTokens += item.totalTokens || 0;
      } else {
        totals.pricingCoverage.knownTokens += item.totalTokens || 0;
      }
      const participantCoverage = totals.pricingCoverage.participants[item.participantId] || {
        participantId: item.participantId,
        nickname: this.db.participants[item.participantId]?.nickname || item.participantId,
        totalTokens: 0,
        missingPriceTokens: 0
      };
      participantCoverage.totalTokens += item.totalTokens || 0;
      if (coverageRow.estimatedCostUsd === null || coverageRow.estimatedCostUsd === undefined) {
        participantCoverage.missingPriceTokens += item.totalTokens || 0;
      }
      totals.pricingCoverage.participants[item.participantId] = participantCoverage;
      const periodCoverage = totals.pricingCoverage.periods[item.day] || { day: item.day, totalTokens: 0, missingPriceTokens: 0 };
      periodCoverage.totalTokens += item.totalTokens || 0;
      if (coverageRow.estimatedCostUsd === null || coverageRow.estimatedCostUsd === undefined) {
        periodCoverage.missingPriceTokens += item.totalTokens || 0;
      }
      totals.pricingCoverage.periods[item.day] = periodCoverage;
      const devices = devicesByParticipant.get(item.participantId) || new Set();
      devices.add(item.deviceId);
      devicesByParticipant.set(item.participantId, devices);
    }
    const values = [...byDay.values()];
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    for (const [day, totalTokens] of byDay.entries()) {
      if (average > 0 && totalTokens > average * 3) totals.abnormalDays.push({ day, totalTokens });
    }
    const anomalies = [];
    for (const bucket of byBucket.values()) {
      const ratioSummary = {
        inputRatio: compositionRatio(bucket.inputTokens, bucket.totalTokens),
        outputRatio: compositionRatio(bucket.outputTokens, bucket.totalTokens),
        cacheRatio: compositionRatio(bucket.cacheReadTokens + bucket.cacheWriteTokens, bucket.totalTokens),
        reasoningRatio: compositionRatio(bucket.reasoningTokens, bucket.totalTokens)
      };
      const anomalyTypes = [];
      if (ratioSummary.inputRatio >= 0.7) anomalyTypes.push("input-heavy");
      if (ratioSummary.outputRatio >= 0.45) anomalyTypes.push("output-heavy");
      if (ratioSummary.cacheRatio >= 0.35) anomalyTypes.push("cache-heavy");
      if (ratioSummary.reasoningRatio >= 0.25) anomalyTypes.push("reasoning-heavy");
      if (anomalyTypes.length) {
        anomalies.push({
          day: bucket.day,
          totalTokens: bucket.totalTokens,
          participantCount: bucket.participants.size,
          compositionSummary: tokenCompositionSummary(bucket),
          anomalyTypes
        });
      }
    }
    for (const [id, devices] of devicesByParticipant.entries()) {
      if (devices.size > 1) {
        totals.multiDeviceParticipants.push({
          participantId: id,
          nickname: this.db.participants[id]?.nickname || id,
          deviceCount: devices.size
        });
      }
    }
    return {
      range,
      from: days[0] || "",
      to: days.at(-1) || "",
      ...totals,
      compositionRatios: {
        inputRatio: compositionRatio(totals.inputTokens, totals.totalTokens),
        outputRatio: compositionRatio(totals.outputTokens, totals.totalTokens),
        cacheRatio: compositionRatio(totals.cacheReadTokens + totals.cacheWriteTokens, totals.totalTokens),
        reasoningRatio: compositionRatio(totals.reasoningTokens, totals.totalTokens)
      },
      anomalies: anomalies.sort((a, b) => b.totalTokens - a.totalTokens),
      pricingCoverage: {
        knownTokens: totals.pricingCoverage.knownTokens,
        missingTokens: totals.pricingCoverage.missingTokens,
        missingTokenRatio: compositionRatio(totals.pricingCoverage.missingTokens, totals.totalTokens),
        costExplainability: Object.entries(totals.pricingCoverage.rowsByQuality).map(([name, count]) => ({
          name,
          label: costQualityLabel(name),
          count
        })),
        participants: Object.values(totals.pricingCoverage.participants)
          .sort((a, b) => b.missingPriceTokens - a.missingPriceTokens)
          .map((item) => ({
            ...item,
            missingPriceRatio: compositionRatio(item.missingPriceTokens, item.totalTokens)
          })),
        periods: Object.values(totals.pricingCoverage.periods)
          .sort((a, b) => b.day.localeCompare(a.day))
          .map((item) => ({
            ...item,
            missingPriceRatio: compositionRatio(item.missingPriceTokens, item.totalTokens)
          }))
      },
      byProvider: sortedBreakdown(totals.byProvider),
      bySourceQuality: Object.entries(totals.bySourceQuality).map(([name, count]) => ({ name, count }))
    };
  }

  adminDevices() {
    return Object.values(this.db.devices || {}).map((device) => {
      const participant = this.db.participants[device.participantId] || {};
      return {
        deviceId: device.id,
        participantId: device.participantId,
        nickname: participant.nickname || device.participantId,
        clientAppVersion: device.clientAppVersion || device.appVersion || "",
        clientProtocolVersion: device.clientProtocolVersion ?? null,
        clientPlatform: device.clientPlatform || device.os || "",
        clientBuild: device.clientBuild || "",
        os: device.os || "",
        lanIp: device.lanIp || "",
        lastSeenAt: device.lastSeenAt || "",
        createdAt: device.createdAt || ""
      };
    }).sort((a, b) => (b.lastSeenAt || "").localeCompare(a.lastSeenAt || ""));
  }

  recalculateCosts() {
    let updated = 0;
    for (const item of Object.values(this.db.usageDaily || {})) {
      Object.assign(item, addCostToUsageItem(item, this.priceMap()));
      updated += 1;
    }
    this.invalidateAggregateCache();
    this.save();
    return { updated };
  }

  priceMap() {
    return createPriceMap(this.db.modelPrices, this.db.modelPriceCache?.prices, this.db.modelPriceAliases);
  }

  listModelPrices() {
    return {
      pricingVersion: "custom+openrouter",
      remote: this.db.modelPriceCache?.remote || structuredClone(DEFAULT_DB.modelPriceCache.remote),
      openrouter: Object.entries(this.db.modelPriceCache?.prices || {}).map(([model, price]) => priceToPublic(model, price)),
      custom: Object.values(this.db.modelPrices || {}).sort((a, b) => a.model.localeCompare(b.model)),
      aliases: Object.entries(this.db.modelPriceAliases || {})
        .map(([model, targetModel]) => ({ model, targetModel }))
        .sort((a, b) => a.model.localeCompare(b.model)),
      missingModels: this.missingPriceModels()
    };
  }

  async refreshOpenRouterPrices({ recalculate = false } = {}) {
    try {
      this.db.modelPriceCache = await fetchOpenRouterModelPrices();
      let recalculated = null;
      if (recalculate) recalculated = this.recalculateCosts();
      this.save();
      return { remote: this.db.modelPriceCache.remote, recalculated };
    } catch (error) {
      const previous = this.db.modelPriceCache || structuredClone(DEFAULT_DB.modelPriceCache);
      previous.remote = {
        ...(previous.remote || {}),
        source: "openrouter",
        status: Object.keys(previous.prices || {}).length ? "stale" : "failed",
        lastError: error.message
      };
      this.db.modelPriceCache = previous;
      this.save();
      return { remote: this.db.modelPriceCache.remote, recalculated: null };
    }
  }

  upsertModelPrice(input) {
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
    const recalculated = this.recalculateCosts();
    return { price, recalculated };
  }

  deleteModelPrice(modelInput) {
    const model = normalizeModelName(modelInput || "");
    if (!model || !this.db.modelPrices[model]) return { deleted: false };
    delete this.db.modelPrices[model];
    for (const [sourceModel, targetModel] of Object.entries(this.db.modelPriceAliases || {})) {
      if (targetModel === model) delete this.db.modelPriceAliases[sourceModel];
    }
    const recalculated = this.recalculateCosts();
    return { deleted: true, recalculated };
  }

  upsertModelPriceAlias(input) {
    const model = normalizeModelName(input.model || input.sourceModel || "");
    const targetModel = normalizeModelName(input.targetModel || "");
    if (!model) throw new Error("model is required");
    if (!targetModel) throw new Error("targetModel is required");
    if (model === targetModel) throw new Error("model alias must target a different model");
    const basePriceMap = createPriceMap(this.db.modelPrices, this.db.modelPriceCache?.prices);
    if (!basePriceMap[targetModel]) throw new Error(`target model price not found: ${targetModel}`);
    this.db.modelPriceAliases[model] = targetModel;
    const recalculated = this.recalculateCosts();
    return { alias: { model, targetModel }, recalculated };
  }

  deleteModelPriceAlias(modelInput) {
    const model = normalizeModelName(modelInput || "");
    if (!model || !this.db.modelPriceAliases[model]) return { deleted: false };
    delete this.db.modelPriceAliases[model];
    const recalculated = this.recalculateCosts();
    return { deleted: true, recalculated };
  }

  missingPriceModels({ range = "month", startDay = "", endDay = "" } = {}) {
    const days = daysForDetailRange(range, { startDay, endDay, businessDay: this.currentBusinessDay() });
    const map = new Map();
    for (const item of Object.values(this.db.usageDaily || {})) {
      if (!days.includes(item.day)) continue;
      if (item.estimatedCostUsd !== null && item.estimatedCostUsd !== undefined) continue;
      const model = item.model || "unknown";
      const current = map.get(model) || { model, totalTokens: 0, rows: 0, providers: {}, lastSeenAt: "" };
      current.totalTokens += item.totalTokens || 0;
      current.rows += 1;
      current.providers[item.providerId || "unknown"] = (current.providers[item.providerId || "unknown"] || 0) + (item.totalTokens || 0);
      if (item.uploadedAt > current.lastSeenAt) current.lastSeenAt = item.uploadedAt;
      map.set(model, current);
    }
    return [...map.values()]
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .map((item) => ({
        ...item,
        providers: sortedBreakdown(item.providers)
      }));
  }
}

function daysForQuery({ period = "", range = "today", startDay = "", endDay = "" } = {}, { businessDay = localDay() } = {}) {
  if (period) return daysForPeriod(period, { businessDay });
  return daysForRange(range, { startDay, endDay, businessDay });
}

function daysForPeriod(period, { businessDay = localDay() } = {}) {
  const today = businessDay;
  if (period === "today") return [today];
  if (period === "yesterday") {
    return [addDays(today, -1)];
  }
  if (period === "this_week" || period === "last_week") {
    const start = startOfUtcWeek(dayToUtcDate(today));
    if (period === "last_week") start.setUTCDate(start.getUTCDate() - 7);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    return daysBetween(toDay(start), toDay(period === "this_week" && end > dayToUtcDate(today) ? dayToUtcDate(today) : end));
  }
  if (period === "this_month" || period === "last_month") {
    const todayDate = dayToUtcDate(today);
    const start = new Date(Date.UTC(todayDate.getUTCFullYear(), todayDate.getUTCMonth() + (period === "last_month" ? -1 : 0), 1));
    const end = period === "last_month"
      ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
      : todayDate;
    return daysBetween(toDay(start), toDay(end));
  }
  return daysForPeriod("today", { businessDay });
}

function daysForDetailRange(range, { startDay = "", endDay = "", businessDay = localDay() } = {}) {
  if (range === "custom" && isDay(startDay) && isDay(endDay)) return daysBetween(startDay, endDay);
  if (range === "today" || range === "yesterday") return daysForPeriod(range, { businessDay });
  if (range === "last7") return trailingDays(7, { businessDay });
  if (range === "7d") return trailingDays(7, { businessDay });
  if (range === "last30") return trailingDays(30, { businessDay });
  if (range === "last12_weeks") return daysForLastWeeks(12, { businessDay });
  if (range === "last12_months") return daysForLastMonths(12, { businessDay });
  if (range === "last_month" || range === "lastMonth") return daysForPeriod("last_month", { businessDay });
  if (range === "month" || range === "this_month") return daysForPeriod("this_month", { businessDay });
  if (range === "last_week") return daysForPeriod("last_week", { businessDay });
  if (range === "this_week") return daysForPeriod("this_week", { businessDay });
  return trailingDays(30, { businessDay });
}

function daysForRange(range, { startDay = "", endDay = "", businessDay = localDay() } = {}) {
  const today = businessDay;
  if (range === "custom" && isDay(startDay) && isDay(endDay)) {
    return daysBetween(startDay, endDay);
  }
  if (range === "today" || range === "yesterday" || range === "this_week" || range === "last_week" || range === "this_month" || range === "last_month") {
    return daysForPeriod(range, { businessDay });
  }
  if (range === "month" || range === "lastMonth") {
    const todayDate = dayToUtcDate(today);
    const year = todayDate.getUTCFullYear();
    const month = todayDate.getUTCMonth() + (range === "lastMonth" ? -1 : 0);
    const start = new Date(Date.UTC(year, month, 1));
    const end = range === "lastMonth"
      ? new Date(Date.UTC(year, month + 1, 0))
      : todayDate;
    return daysBetween(toDay(start), toDay(end));
  }
  const offset = range === "yesterday" ? 1 : 0;
  const count = range === "7d" ? 7 : 1;
  return Array.from({ length: count }, (_, index) => {
    return addDays(today, -index - offset);
  });
}

function trailingDays(count, { businessDay = localDay() } = {}) {
  const today = dayToUtcDate(businessDay);
  return Array.from({ length: count }, (_, index) => {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - count + index + 1);
    return toDay(d);
  });
}

function toDay(date) {
  return utcDateToDay(date);
}

function startOfUtcWeek(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - day + 1);
  return start;
}

function normalizeGrain(grain) {
  return ["day", "week", "month"].includes(grain) ? grain : "day";
}

function bucketForDay(day, grain) {
  const date = new Date(`${day}T00:00:00Z`);
  if (grain === "month") {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    return { key: toDay(start), periodStart: toDay(start), periodEnd: toDay(end) };
  }
  if (grain === "week") {
    const start = startOfUtcWeek(date);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    return { key: toDay(start), periodStart: toDay(start), periodEnd: toDay(end) };
  }
  return { key: day, periodStart: day, periodEnd: day };
}

function emptyAggregate(bucket, item, participants = {}) {
  const participant = participants[item.participantId];
  return {
    periodStart: bucket.periodStart,
    periodEnd: bucket.periodEnd,
    participantId: item.participantId,
    nickname: participant?.nickname || item.participantId,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    modelsMap: {},
    workdirsMap: {},
    providersMap: {},
    modelsCostMap: {},
    workdirsCostMap: {},
    providersCostMap: {},
    estimatedCostUsd: 0,
    costQuality: "",
    pricingVersion: "",
    sourceQuality: "exact",
    lastSyncedAt: item.uploadedAt || ""
  };
}

function aggregateUsageRows(rows, grain, { includeAdminFields = false, participants = {}, includeCost = false } = {}) {
  const map = new Map();
  for (const item of rows) {
    const bucket = bucketForDay(item.day, grain);
    const key = includeAdminFields ? `${bucket.key}|${item.participantId}` : bucket.key;
    const current = map.get(key) || emptyAggregate(bucket, item, participants);
    current.totalTokens += item.totalTokens || 0;
    current.inputTokens += item.inputTokens || 0;
    current.outputTokens += item.outputTokens || 0;
    current.reasoningTokens += item.reasoningTokens || 0;
    current.cacheReadTokens += item.cacheReadTokens || 0;
    current.cacheWriteTokens += item.cacheWriteTokens || 0;
    current.modelsMap[item.model || "unknown"] = (current.modelsMap[item.model || "unknown"] || 0) + (item.totalTokens || 0);
    current.workdirsMap[item.workdirDisplayName || "unknown"] = (current.workdirsMap[item.workdirDisplayName || "unknown"] || 0) + (item.totalTokens || 0);
    current.providersMap[item.providerId || "unknown"] = (current.providersMap[item.providerId || "unknown"] || 0) + (item.totalTokens || 0);
    if (includeCost) {
      aggregateCost(current, item);
      addCostBreakdownItem(current.modelsCostMap, item.model || "unknown", item);
      addCostBreakdownItem(current.workdirsCostMap, item.workdirDisplayName || "unknown", item);
      addCostBreakdownItem(current.providersCostMap, item.providerId || "unknown", item);
    }
    if (item.sourceQuality !== "exact") current.sourceQuality = "partial";
    if (item.uploadedAt > current.lastSyncedAt) current.lastSyncedAt = item.uploadedAt;
    map.set(key, current);
  }
  return [...map.values()]
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart) || b.totalTokens - a.totalTokens)
    .map(({ modelsMap, workdirsMap, providersMap, modelsCostMap, workdirsCostMap, providersCostMap, ...item }) => ({
      ...item,
      compositionSummary: tokenCompositionSummary(item),
      dominantComposition: dominantComposition(item),
      ...(includeCost ? costFields(item) : {}),
      models: includeCost ? finalizeCostBreakdown(modelsCostMap) : sortedBreakdown(modelsMap),
      workdirs: includeCost ? finalizeCostBreakdown(workdirsCostMap) : sortedBreakdown(workdirsMap),
      providers: includeCost ? finalizeCostBreakdown(providersCostMap) : sortedBreakdown(providersMap)
    }));
}

function daysForLastWeeks(count, { businessDay = localDay() } = {}) {
  const today = dayToUtcDate(businessDay);
  const start = startOfUtcWeek(today);
  start.setUTCDate(start.getUTCDate() - ((count - 1) * 7));
  return daysBetween(toDay(start), toDay(today));
}

function daysForLastMonths(count, { businessDay = localDay() } = {}) {
  const today = dayToUtcDate(businessDay);
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - count + 1, 1));
  return daysBetween(toDay(start), toDay(today));
}

function isDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isDayScopedRange({ period = "", range = "today", startDay = "", endDay = "" } = {}) {
  if (!period && range === "custom" && isDay(startDay) && isDay(endDay)) return false;
  return true;
}

function sortedBreakdown(obj) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([name, totalTokens]) => ({ name, totalTokens }));
}

function addCostBreakdownItem(map, name, item) {
  const key = name || "unknown";
  const current = map[key] || {
    name: key,
    totalTokens: 0,
    estimatedCostUsd: 0,
    costQuality: "",
    pricingVersion: ""
  };
  current.totalTokens += item.totalTokens || 0;
  aggregateCost(current, item);
  map[key] = current;
  return current;
}

function finalizeCostBreakdown(map = {}) {
  return Object.values(map)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((item) => ({
      ...item,
      ...costFields(item)
    }));
}

function normalizeUsageTotal(item) {
  return {
    ...item,
    totalTokens: displayTotalTokens(item)
  };
}

function costFields(item) {
  const hasOnlyMissingPrices = !item.hasKnownPrice && item.missingPriceTokens > 0;
  return {
    inputCostUsd: hasOnlyMissingPrices ? null : (item.inputCostUsd ?? null),
    outputCostUsd: hasOnlyMissingPrices ? null : (item.outputCostUsd ?? null),
    cacheReadCostUsd: hasOnlyMissingPrices ? null : (item.cacheReadCostUsd ?? null),
    cacheWriteCostUsd: hasOnlyMissingPrices ? null : (item.cacheWriteCostUsd ?? null),
    reasoningCostUsd: hasOnlyMissingPrices ? null : (item.reasoningCostUsd ?? null),
    estimatedCostUsd: hasOnlyMissingPrices ? null : (item.estimatedCostUsd ?? null),
    costQuality: item.costQuality || "unknown_price",
    pricingVersion: item.pricingVersion || "",
    pricingSource: item.pricingSource || "",
    missingPriceTokens: item.missingPriceTokens || 0,
    missingPriceModels: sortedBreakdown(item.missingPriceModels || {})
  };
}

function colorFromId(id) {
  const colors = ["#1c7c54", "#ba3b46", "#006d77", "#8f5f00", "#3d5a80", "#7b2cbf"];
  return colors[Number.parseInt(sha256Hex(id).slice(0, 2), 16) % colors.length];
}

function nonNegativeNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0) throw new Error("price fields must be non-negative numbers");
  return n;
}

function sumRows(rows, field) {
  return rows.reduce((sum, item) => sum + Number(item[field] || 0), 0);
}
