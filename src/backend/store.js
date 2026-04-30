import fs from "node:fs";
import path from "node:path";
import { newId, sha256Hex } from "../shared/crypto.js";
import { addCostToUsageItem, aggregateCost, createPriceMap, FALLBACK_PRICE_MAP, normalizeModelName, priceToPublic } from "../shared/pricing.js";
import { STORAGE_SCHEMA_VERSION, assertNoForbiddenUploadFields, assertUsageItem, usageKey } from "../shared/schema.js";

export const DEFAULT_DB = {
  schemaVersion: STORAGE_SCHEMA_VERSION,
  participants: {},
  devices: {},
  workdirs: {},
  usageDaily: {},
  modelPrices: {},
  uploadBatches: {},
  aggregateCache: {}
};

export class Store {
  constructor(dbPath = path.resolve("data/db.json"), options = {}) {
    this.persist = options.persist !== false;
    this.dbPath = dbPath;
    if (this.persist) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = this.persist && fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, "utf8")) : structuredClone(DEFAULT_DB);
    this.db.schemaVersion ||= STORAGE_SCHEMA_VERSION;
    this.db.aggregateCache ||= {};
    this.db.modelPrices ||= {};
    if (this.migrateLegacyUsageRows()) this.save();
  }

  save() {
    if (!this.persist) return;
    fs.writeFileSync(this.dbPath, `${JSON.stringify(this.db, null, 2)}\n`);
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

  upsertUsageBatch(input) {
    const now = new Date().toISOString();
    assertNoForbiddenUploadFields(input);
    const batchPayloadHash = sha256Hex(JSON.stringify({ ...input, signature: undefined }));
    if (this.db.uploadBatches[batchPayloadHash]) {
      return { accepted: 0, rejected: 0, duplicate: true, batchId: this.db.uploadBatches[batchPayloadHash].id };
    }
    let accepted = 0;
    let rejected = 0;
    for (const raw of input.items || []) {
      try {
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
        const withCost = addCostToUsageItem(raw, this.priceMap());
        this.db.usageDaily[key] = {
          ...raw,
          estimatedCostUsd: withCost.estimatedCostUsd,
          costQuality: withCost.costQuality,
          pricingVersion: withCost.pricingVersion,
          pricingModel: withCost.pricingModel,
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

  invalidateAggregateCache() {
    this.db.aggregateCache = {};
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
      if (!item.costQuality || !item.pricingVersion) {
        Object.assign(item, addCostToUsageItem(item, this.priceMap()));
        changed = true;
      }
    }
    return changed;
  }

  leaderboard({ period, range = "today", tool = "all", startDay = "", endDay = "" } = {}) {
    const days = period ? daysForPeriod(period) : daysForDetailRange(range, { startDay, endDay });
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
    return this.cachedAggregate("publicLeaderboard", { period, range, startDay, endDay, includeCost }, () => this.computePublicLeaderboard({ period, range, startDay, endDay, includeCost }));
  }

  computePublicLeaderboard({ period, range = "today", startDay = "", endDay = "", includeCost = false } = {}) {
    const days = daysForQuery({ period, range, startDay, endDay });
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
          modelBreakdown: {},
          estimatedCostUsd: 0,
          costQuality: ""
        };
      current.totalTokens += item.totalTokens;
      current.modelBreakdown[item.model] = (current.modelBreakdown[item.model] || 0) + item.totalTokens;
      if (includeCost) aggregateCost(current, item);
      byParticipant.set(item.participantId, current);
    }
    return [...byParticipant.values()]
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .map((item, index) => ({
        rank: index + 1,
        participantId: item.participantId,
        nickname: item.nickname,
        totalTokens: item.totalTokens,
        models: sortedBreakdown(item.modelBreakdown),
        ...(includeCost ? costFields(item) : {})
      }));
  }

  participantDetail(participantId, { period, range = "today", startDay = "", endDay = "", includeCost = false } = {}) {
    const participant = this.db.participants[participantId];
    if (!participant) return null;
    const days = daysForQuery({ period, range, startDay, endDay });
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
      byDay: {},
      byModel: {},
      byWorkdir: {},
      byProvider: {},
      byTool: {},
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
          totalTokens: item.totalTokens,
          ...(includeCost ? costFields(item) : {}),
          sourceQuality: item.sourceQuality
        }))
    };
    for (const item of rows) {
      detail.totalTokens += item.totalTokens;
      detail.byDay[item.day] = (detail.byDay[item.day] || 0) + item.totalTokens;
      detail.byModel[item.model] = (detail.byModel[item.model] || 0) + item.totalTokens;
      detail.byWorkdir[item.workdirDisplayName] = (detail.byWorkdir[item.workdirDisplayName] || 0) + item.totalTokens;
      detail.byProvider[item.providerId] = (detail.byProvider[item.providerId] || 0) + item.totalTokens;
      detail.byTool[item.toolCode] = (detail.byTool[item.toolCode] || 0) + item.totalTokens;
      if (includeCost) aggregateCost(detail, item);
    }
    const periodRows = aggregateUsageRows(rows, "day", { participants: this.db.participants, includeCost });
    return {
      ...detail,
      ...(includeCost ? costFields(detail) : {}),
      days: sortedBreakdown(detail.byDay),
      periodRows,
      models: sortedBreakdown(detail.byModel),
      workdirs: sortedBreakdown(detail.byWorkdir),
      providers: sortedBreakdown(detail.byProvider),
      tools: sortedBreakdown(detail.byTool)
    };
  }

  participantTrend(participantId, { grain = "day", range = "last30", startDay = "", endDay = "", includeCost = false } = {}) {
    const participant = this.db.participants[participantId];
    if (!participant) return null;
    const days = daysForDetailRange(range, { startDay, endDay });
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
    return this.cachedAggregate("adminUsage", { grain, range, startDay, endDay, participantId, includeCost }, () => this.computeAdminUsage({ grain, range, startDay, endDay, participantId, includeCost }));
  }

  computeAdminUsage({ grain = "day", range = "month", startDay = "", endDay = "", participantId = "", includeCost = false } = {}) {
    const days = daysForDetailRange(range, { startDay, endDay });
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

  cachedAggregate(name, args, compute) {
    const key = sha256Hex(JSON.stringify({ name, args, schemaVersion: STORAGE_SCHEMA_VERSION }));
    const cached = this.db.aggregateCache?.[key];
    if (cached) return cached.value;
    const value = compute();
    this.db.aggregateCache ||= {};
    this.db.aggregateCache[key] = {
      key,
      name,
      args,
      createdAt: new Date().toISOString(),
      value
    };
    this.save();
    return value;
  }

  adminQuality({ range = "month", startDay = "", endDay = "", participantId = "" } = {}) {
    const days = daysForDetailRange(range, { startDay, endDay });
    const rows = Object.values(this.db.usageDaily).filter((item) => {
      return days.includes(item.day) && (!participantId || item.participantId === participantId);
    });
    const totals = {
      rows: rows.length,
      totalTokens: 0,
      unknownModelRows: 0,
      unknownWorkdirRows: 0,
      missingSourceFingerprintRows: 0,
      nonExactRows: 0,
      bySourceQuality: {},
      byProvider: {},
      abnormalDays: [],
      multiDeviceParticipants: []
    };
    const byDay = new Map();
    const devicesByParticipant = new Map();
    for (const item of rows) {
      totals.totalTokens += item.totalTokens || 0;
      if (!item.model || item.model === "unknown") totals.unknownModelRows += 1;
      if (!item.workdirDisplayName || item.workdirDisplayName === "unknown") totals.unknownWorkdirRows += 1;
      if (!item.sourceFingerprint) totals.missingSourceFingerprintRows += 1;
      if (item.sourceQuality !== "exact") totals.nonExactRows += 1;
      totals.bySourceQuality[item.sourceQuality || "unknown"] = (totals.bySourceQuality[item.sourceQuality || "unknown"] || 0) + 1;
      totals.byProvider[item.providerId || "unknown"] = (totals.byProvider[item.providerId || "unknown"] || 0) + (item.totalTokens || 0);
      byDay.set(item.day, (byDay.get(item.day) || 0) + (item.totalTokens || 0));
      const devices = devicesByParticipant.get(item.participantId) || new Set();
      devices.add(item.deviceId);
      devicesByParticipant.set(item.participantId, devices);
    }
    const values = [...byDay.values()];
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    for (const [day, totalTokens] of byDay.entries()) {
      if (average > 0 && totalTokens > average * 3) totals.abnormalDays.push({ day, totalTokens });
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
      byProvider: sortedBreakdown(totals.byProvider),
      bySourceQuality: Object.entries(totals.bySourceQuality).map(([name, count]) => ({ name, count }))
    };
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
    return createPriceMap(this.db.modelPrices);
  }

  listModelPrices() {
    return {
      pricingVersion: "custom-overrides",
      builtin: Object.entries(FALLBACK_PRICE_MAP).map(([model, price]) => priceToPublic(model, price)),
      custom: Object.values(this.db.modelPrices || {}).sort((a, b) => a.model.localeCompare(b.model)),
      missingModels: this.missingPriceModels()
    };
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
      reasoningCostPerMTok: nonNegativeNumber(input.reasoningCostPerMTok),
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
    const recalculated = this.recalculateCosts();
    return { deleted: true, recalculated };
  }

  missingPriceModels({ range = "month", startDay = "", endDay = "" } = {}) {
    const days = daysForDetailRange(range, { startDay, endDay });
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

function daysForQuery({ period = "", range = "today", startDay = "", endDay = "" } = {}) {
  if (period) return daysForPeriod(period);
  return daysForRange(range, { startDay, endDay });
}

function daysForPeriod(period) {
  const today = utcToday();
  if (period === "today") return [toDay(today)];
  if (period === "yesterday") {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() - 1);
    return [toDay(day)];
  }
  if (period === "this_week" || period === "last_week") {
    const start = startOfUtcWeek(today);
    if (period === "last_week") start.setUTCDate(start.getUTCDate() - 7);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    return daysBetween(toDay(start), toDay(period === "this_week" && end > today ? today : end));
  }
  if (period === "this_month" || period === "last_month") {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + (period === "last_month" ? -1 : 0), 1));
    const end = period === "last_month"
      ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
      : today;
    return daysBetween(toDay(start), toDay(end));
  }
  return daysForPeriod("today");
}

function daysForDetailRange(range, { startDay = "", endDay = "" } = {}) {
  if (range === "custom" && isDay(startDay) && isDay(endDay)) return daysBetween(startDay, endDay);
  if (range === "today" || range === "yesterday") return daysForPeriod(range);
  if (range === "last7") return trailingDays(7);
  if (range === "7d") return trailingDays(7);
  if (range === "last30") return trailingDays(30);
  if (range === "last12_weeks") return daysForLastWeeks(12);
  if (range === "last12_months") return daysForLastMonths(12);
  if (range === "last_month" || range === "lastMonth") return daysForPeriod("last_month");
  if (range === "month" || range === "this_month") return daysForPeriod("this_month");
  if (range === "last_week") return daysForPeriod("last_week");
  if (range === "this_week") return daysForPeriod("this_week");
  return trailingDays(30);
}

function daysForRange(range, { startDay = "", endDay = "" } = {}) {
  const today = new Date();
  if (range === "custom" && isDay(startDay) && isDay(endDay)) {
    return daysBetween(startDay, endDay);
  }
  if (range === "month" || range === "lastMonth") {
    const year = today.getUTCFullYear();
    const month = today.getUTCMonth() + (range === "lastMonth" ? -1 : 0);
    const start = new Date(Date.UTC(year, month, 1));
    const end = range === "lastMonth"
      ? new Date(Date.UTC(year, month + 1, 0))
      : today;
    return daysBetween(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
  }
  const offset = range === "yesterday" ? 1 : 0;
  const count = range === "7d" ? 7 : 1;
  return Array.from({ length: count }, (_, index) => {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - index - offset);
    return d.toISOString().slice(0, 10);
  });
}

function trailingDays(count) {
  const today = utcToday();
  return Array.from({ length: count }, (_, index) => {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - count + index + 1);
    return toDay(d);
  });
}

function utcToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function toDay(date) {
  return date.toISOString().slice(0, 10);
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
    if (includeCost) aggregateCost(current, item);
    if (item.sourceQuality !== "exact") current.sourceQuality = "partial";
    if (item.uploadedAt > current.lastSyncedAt) current.lastSyncedAt = item.uploadedAt;
    map.set(key, current);
  }
  return [...map.values()]
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart) || b.totalTokens - a.totalTokens)
    .map(({ modelsMap, workdirsMap, providersMap, ...item }) => ({
      ...item,
      ...(includeCost ? costFields(item) : {}),
      models: sortedBreakdown(modelsMap),
      workdirs: sortedBreakdown(workdirsMap),
      providers: sortedBreakdown(providersMap)
    }));
}

function daysBetween(startDay, endDay) {
  const start = new Date(`${startDay}T00:00:00Z`);
  const end = new Date(`${endDay}T00:00:00Z`);
  if (start > end) return [];
  const days = [];
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

function daysForLastWeeks(count) {
  const today = utcToday();
  const start = startOfUtcWeek(today);
  start.setUTCDate(start.getUTCDate() - ((count - 1) * 7));
  return daysBetween(toDay(start), toDay(today));
}

function daysForLastMonths(count) {
  const today = utcToday();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - count + 1, 1));
  return daysBetween(toDay(start), toDay(today));
}

function isDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function sortedBreakdown(obj) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([name, totalTokens]) => ({ name, totalTokens }));
}

function costFields(item) {
  const hasOnlyMissingPrices = !item.hasKnownPrice && item.missingPriceTokens > 0;
  return {
    estimatedCostUsd: hasOnlyMissingPrices ? null : (item.estimatedCostUsd ?? null),
    costQuality: item.costQuality || "unknown_price",
    pricingVersion: item.pricingVersion || "",
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
