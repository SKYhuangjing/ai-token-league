import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/backend/store.js";
import { generateIdentity, newId, signPayload, hmacSha256Hex } from "../src/shared/crypto.js";
import { BoardAnonymizer, loadOrGenerateSalt, loadNames, todayStr } from "../src/backend/board-anonymizer.js";
import { assertNoForbiddenUploadFields, assertSnapshot, BUCKET_FINGERPRINT_FIELDS, computeBucketFingerprint, displayTotalTokens, USAGE_CACHE_VERSION, usageKey, normalizeTokenNumber } from "../src/shared/schema.js";
import { compatibilityResult, clientMetadata, CLIENT_PROTOCOL_VERSION, SNAPSHOT_PROTOCOL_VERSION, APP_VERSION, PRODUCT_BASELINE } from "../src/shared/version.js";
import {
  buildInstallerMetadataFromGithubRelease,
  buildTauriUpdateJson,
  githubReleaseApiUrl,
  releaseDistributionFromEnv,
  releasePublicConfig,
  updatePreflightState,
  validateInstallerMetadata,
  validateReleaseConfig,
  verifyFileChecksum
} from "../src/shared/update.js";
import { parseLatestChangelog } from "../src/shared/changelog.js";
import { formatTokenCompact, formatUsd } from "../src/shared/display.js";
import { createPriceMap, estimateUsageCost, openRouterModelToPrice } from "../src/shared/pricing.js";
import { addDays, localDay } from "../src/shared/date.js";
import { currentBusinessDay } from "../src/backend/day-context.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-token-league-test-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function testBackendUpload(identity, items) {
  const store = new Store(path.join(tmp, "db.json"));
  const deviceId = newId("d");
  const testDay = localDay();
  const uploadItems = items.map((item) => ({ ...item, day: testDay }));
  store.db.modelPriceCache.prices = Object.fromEntries(uploadItems.map((item) => [item.model, {
    model: item.model,
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000002,
    cache_read_input_token_cost: 0.0000001,
    cache_creation_input_token_cost: 0.000001,
    reasoning_cost_per_token: 0.000002,
    source: "openrouter",
    pricingVersion: "test-openrouter"
  }]));
  store.registerDevice({
    participantId: identity.participantId,
    deviceId,
    nickname: "tester",
    identityPublicKey: identity.identityPublicKey,
    os: "test",
    appVersion: "0.1.0"
  });
  const payload = {
    participantId: identity.participantId,
    deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: uploadItems
  };
  const signature = signPayload(identity.identityPrivateKey, payload);
  const first = store.upsertUsageBatch(payload);
  const duplicate = store.upsertUsageBatch(payload);
  assert.equal(first.accepted, 2);
  assert.equal(duplicate.duplicate, true);
  assert.equal(
    Object.values(store.db.usageDaily).every((item) => item.totalTokens === displayTotalTokens(item)),
    true
  );
  store.upsertUsageBatch({
    ...payload,
    clientGeneratedAt: new Date(Date.now() + 1).toISOString(),
    items: [
      {
        ...uploadItems[0],
        model: "custom-test-model",
        inputTokens: 600,
        outputTokens: 400,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 1000,
        sourceFingerprint: "test-custom-test-model"
      }
    ]
  });
  const board = store.leaderboard({ range: "today", tool: "all" });
  assert.equal(board.length, 1);
  assert.equal(board[0].nickname, "tester");
  const publicBoard = store.publicLeaderboard({ range: "today" });
  assert.equal(publicBoard.length, 1);
  assert.equal(publicBoard[0].nickname, "tester");
  assert.equal(publicBoard[0].models.length, 3);
  assert.equal(
    publicBoard[0].totalTokens,
    publicBoard[0].inputTokens + publicBoard[0].outputTokens + publicBoard[0].cacheReadTokens + publicBoard[0].cacheWriteTokens
  );
  assert.ok(publicBoard[0].compositionSummary);
  assert.ok(Object.keys(store.db.aggregateCache).length >= 1);
  store.db.aggregateCache = {};
  assert.equal(store.publicLeaderboard({ range: "today" }).length, 1);
  const customBoard = store.publicLeaderboard({ range: "custom", startDay: testDay, endDay: testDay });
  assert.equal(customBoard.length, 1);
  const monthBoard = store.leaderboard({ range: "month" });
  assert.equal(monthBoard.length, 1);
  const periodBoard = store.publicLeaderboard({ period: "this_month" });
  assert.equal(periodBoard.length, 1);
  assert.ok(periodBoard[0].participantId);
  const costBoard = store.publicLeaderboard({ period: "this_month", includeCost: true });
  assert.ok(Object.hasOwn(costBoard[0], "estimatedCostUsd"));
  assert.ok(costBoard[0].costQuality);
  assert.ok(Object.hasOwn(costBoard[0].models[0], "estimatedCostUsd"));
  assert.equal(
    costBoard[0].estimatedCostUsd,
    Number((
      (costBoard[0].inputCostUsd || 0) +
      (costBoard[0].outputCostUsd || 0) +
      (costBoard[0].cacheReadCostUsd || 0) +
      (costBoard[0].cacheWriteCostUsd || 0) +
      (costBoard[0].reasoningCostUsd || 0)
    ).toFixed(6))
  );
  const detail = store.participantDetail(identity.participantId, { period: "today", includeCost: true });
  assert.equal(detail.selectedPeriod, "today");
  assert.equal(detail.rank, 1);
  assert.equal(detail.isSingleDay, true);
  assert.ok(detail.models.length >= 1);
  assert.ok(detail.workdirs.length >= 1);
  assert.ok(detail.providers.length >= 1);
  assert.ok(detail.periodRows.length >= 1);
  assert.ok(Object.hasOwn(detail.models[0], "estimatedCostUsd"));
  assert.ok(Object.hasOwn(detail.workdirs[0], "estimatedCostUsd"));
  assert.ok(Object.hasOwn(detail.providers[0], "estimatedCostUsd"));
  assert.ok(Object.hasOwn(detail.periodRows[0].models[0], "estimatedCostUsd"));
  assert.ok(Object.hasOwn(detail.periodRows[0].workdirs[0], "estimatedCostUsd"));
  assert.ok(detail.compositionSummary);
  assert.equal(detail.rows[0].compositionSummary.length > 0, true);
  const trend = store.participantTrend(identity.participantId, { grain: "week", range: "last30", includeCost: true });
  assert.equal(trend.participantId, identity.participantId);
  assert.ok(trend.items.length >= 1);
  assert.equal(trend.items[0].nickname, "tester");
  assert.ok(trend.items[0].periodStart);
  assert.ok(trend.items[0].models.length >= 1);
  assert.ok(Object.hasOwn(trend.items[0].models[0], "estimatedCostUsd"));
  const monthlyTrend = store.participantTrend(identity.participantId, { grain: "month", range: "last12_months" });
  assert.ok(monthlyTrend.items.length >= 1);
  const admin = store.adminUsage({ grain: "day", range: "month" });
  assert.equal(admin.participants.length, 1);
  assert.equal(admin.items.length, 1);
  assert.equal(admin.items[0].nickname, "tester");
  assert.ok(admin.items[0].workdirs.length >= 1);
  const adminWithCost = store.adminUsage({ grain: "day", range: "month", includeCost: true });
  assert.ok(Object.hasOwn(adminWithCost.items[0], "estimatedCostUsd"));
  assert.ok(adminWithCost.items[0].compositionSummary);
  const quality = store.adminQuality({ range: "month" });
  assert.equal(quality.rows, 3);
  assert.equal(quality.missingSourceFingerprintRows, 0);
  assert.equal(quality.unknownWorkdirRows, 0);
  assert.ok(quality.compositionRatios.inputRatio > 0);
  assert.ok(Array.isArray(quality.anomalies));
  assert.ok(Array.isArray(quality.pricingCoverage.costExplainability));
  assert.equal(store.db.uploadBatches[Object.keys(store.db.uploadBatches)[0]].status, "accepted");
  assert.ok(Object.values(store.db.usageDaily).every((item) => item.sourceFingerprint));
  const recalculated = store.recalculateCosts();
  assert.ok(recalculated.updated >= 1);
  const beforePrice = store.missingPriceModels();
  assert.ok(beforePrice.some((item) => item.model === "custom-test-model"));
  const aliasTargetModel = uploadItems[0].model;
  const savedAlias = store.upsertModelPriceAlias({
    model: "custom-test-model",
    targetModel: aliasTargetModel
  });
  assert.deepEqual(savedAlias.alias, { model: "custom-test-model", targetModel: aliasTargetModel });
  assert.ok(store.listModelPrices().aliases.some((item) => item.model === "custom-test-model" && item.targetModel === aliasTargetModel));
  assert.ok(!store.missingPriceModels().some((item) => item.model === "custom-test-model"));
  assert.equal(Object.values(store.db.usageDaily).find((item) => item.model === "custom-test-model").pricingModel, aliasTargetModel);
  assert.equal(store.deleteModelPriceAlias("custom-test-model").deleted, true);
  assert.ok(store.missingPriceModels().some((item) => item.model === "custom-test-model"));
  const savedPrice = store.upsertModelPrice({
    model: "custom-test-model",
    inputCostPerMTok: 1,
    outputCostPerMTok: 2,
    cacheReadCostPerMTok: 0.1,
    cacheWriteCostPerMTok: 1,
    reasoningCostPerMTok: 2
  });
  assert.equal(savedPrice.price.model, "custom-test-model");
  assert.ok(store.listModelPrices().custom.some((item) => item.model === "custom-test-model"));
  assert.ok(!store.missingPriceModels().some((item) => item.model === "custom-test-model"));
  const customCostBoard = store.publicLeaderboard({ period: "this_month", includeCost: true });
  assert.notEqual(customCostBoard[0].estimatedCostUsd, null);
  assert.ok(signature);
}

function testDeleteParticipantDataAllowsResync() {
  const identity = generateIdentity();
  const store = new Store(path.join(tmp, "db-delete-participant.json"));
  const deviceId = newId("d");
  const item = {
    day: localDay(),
    toolCode: "codex",
    providerId: "codex_local",
    workdirHash: "wd_reset",
    workdirDisplayName: "reset-project",
    model: "gpt-5",
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    reasoningTokens: 20,
    totalTokens: 155,
    sourceQuality: "exact",
    rawSourceRef: "reset.jsonl",
    providerVersion: "0.1.0",
    parserVersion: "0.1.0",
    sourceFingerprint: "reset-source"
  };
  store.registerDevice({
    participantId: identity.participantId,
    deviceId,
    nickname: "reset-user",
    identityPublicKey: identity.identityPublicKey,
    os: "test",
    appVersion: APP_VERSION
  });
  const payload = {
    participantId: identity.participantId,
    deviceId,
    clientGeneratedAt: "2026-05-06T00:00:00.000Z",
    items: [item]
  };
  const first = store.upsertUsageBatch(payload);
  assert.equal(first.accepted, 1);
  assert.equal(store.publicLeaderboard({ range: "today" }).length, 1);
  assert.ok(Object.keys(store.db.aggregateCache).length >= 1);

  const deleted = store.deleteParticipantData(identity.participantId);
  assert.equal(deleted.deleted, true);
  assert.deepEqual(deleted.removed, {
    participants: 1,
    devices: 1,
    workdirs: 1,
    usageDaily: 1,
    uploadBatches: 1,
    usageSyncBuckets: 0
  });
  assert.equal(store.getParticipant(identity.participantId), null);
  assert.equal(Object.values(store.db.devices).some((row) => row.participantId === identity.participantId), false);
  assert.equal(Object.values(store.db.workdirs).some((row) => row.participantId === identity.participantId), false);
  assert.equal(Object.values(store.db.usageDaily).some((row) => row.participantId === identity.participantId), false);
  assert.equal(Object.values(store.db.uploadBatches).some((row) => row.participantId === identity.participantId), false);
  assert.equal(Object.keys(store.db.aggregateCache).length, 0);

  store.registerDevice({
    participantId: identity.participantId,
    deviceId,
    nickname: "reset-user",
    identityPublicKey: identity.identityPublicKey,
    os: "test",
    appVersion: APP_VERSION
  });
  const second = store.upsertUsageBatch(payload);
  assert.equal(second.duplicate, undefined);
  assert.equal(second.accepted, 1);
}

async function testParticipantDataDeleteMissingIsNoop() {
  const dbPath = path.join(tmp, "db-participant-delete-missing.json");
  const originalDbPath = process.env.DB_PATH;
  const originalOpenRouterAutoRefresh = process.env.OPENROUTER_PRICING_AUTO_REFRESH;
  process.env.DB_PATH = dbPath;
  process.env.OPENROUTER_PRICING_AUTO_REFRESH = "false";
  let server;
  try {
    const { createServer } = await import(`../src/backend/server.js?participant-delete-missing=${Date.now()}`);
    server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/participant/data`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: "p_missing",
        timestamp: new Date().toISOString(),
        signature: "missing-participant-signature"
      })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.deleted, false);
    assert.equal(body.participantId, "p_missing");
    assert.deepEqual(body.removed, {
      participants: 0,
      devices: 0,
      workdirs: 0,
      usageDaily: 0,
      uploadBatches: 0,
      usageSyncBuckets: 0
    });
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    if (originalOpenRouterAutoRefresh === undefined) delete process.env.OPENROUTER_PRICING_AUTO_REFRESH;
    else process.env.OPENROUTER_PRICING_AUTO_REFRESH = originalOpenRouterAutoRefresh;
  }
}

async function testBoardApiBusinessDayMetadata() {
  const originalDbPath = process.env.DB_PATH;
  const originalSecurityLevel = process.env.BOARD_SECURITY_LEVEL;
  const originalSalt = process.env.BOARD_ANONYMIZATION_SALT;
  const originalBusinessDay = process.env.AI_TOKEN_LEAGUE_BUSINESS_DAY;
  const originalOpenRouterAutoRefresh = process.env.OPENROUTER_PRICING_AUTO_REFRESH;
  process.env.DB_PATH = path.join(tmp, "db-board-business-day-api.json");
  process.env.BOARD_SECURITY_LEVEL = "anonymous";
  process.env.BOARD_ANONYMIZATION_SALT = "business-day-api-test-salt";
  process.env.AI_TOKEN_LEAGUE_BUSINESS_DAY = "2026-05-11";
  process.env.OPENROUTER_PRICING_AUTO_REFRESH = "false";
  let server;
  try {
    const { createServer } = await import(`../src/backend/server.js?board-business-day=${Date.now()}`);
    server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const identity = await (await fetch(`http://127.0.0.1:${port}/api/board/my-identity?participantId=p_business_day`)).json();
    const leaderboard = await (await fetch(`http://127.0.0.1:${port}/api/board/leaderboard?period=today`)).json();
    const summary = await (await fetch(`http://127.0.0.1:${port}/api/board/summary`)).json();
    assert.equal(identity.businessDay, "2026-05-11");
    assert.equal(leaderboard.businessDay, "2026-05-11");
    assert.equal(summary.businessDay, "2026-05-11");
    assert.equal(identity.identityMode, "anonymous");
    assert.equal(summary.identityMode, "anonymous");
    assert.equal(summary.identityLabel, "anonymousDisplayName");
    assert.ok(identity.publicId);
    assert.equal(Object.hasOwn(identity, "participantId"), false);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    restoreEnv("DB_PATH", originalDbPath);
    restoreEnv("BOARD_SECURITY_LEVEL", originalSecurityLevel);
    restoreEnv("BOARD_ANONYMIZATION_SALT", originalSalt);
    restoreEnv("AI_TOKEN_LEAGUE_BUSINESS_DAY", originalBusinessDay);
    restoreEnv("OPENROUTER_PRICING_AUTO_REFRESH", originalOpenRouterAutoRefresh);
  }
}

function testBusinessDayContextEnvOverride() {
  const original = process.env.AI_TOKEN_LEAGUE_BUSINESS_DAY;
  try {
    process.env.AI_TOKEN_LEAGUE_BUSINESS_DAY = "2026-05-12";
    assert.equal(currentBusinessDay(), "2026-05-12");
    process.env.AI_TOKEN_LEAGUE_BUSINESS_DAY = "not-a-day";
    assert.match(currentBusinessDay(new Date("2026-05-13T03:00:00.000Z")), /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    restoreEnv("AI_TOKEN_LEAGUE_BUSINESS_DAY", original);
  }
}

function testTrayLocalDayUsesConfiguredTimezone() {
  const originalAppTimeZone = process.env.APP_TIME_ZONE;
  const originalTz = process.env.TZ;
  try {
    process.env.APP_TIME_ZONE = "Asia/Shanghai";
    process.env.TZ = "UTC";
    const instant = "2026-04-29T18:30:00.000Z";
    assert.equal(localDay(instant), "2026-04-30");
    assert.equal(new Date(instant).toISOString().slice(0, 10), "2026-04-29");

    delete process.env.APP_TIME_ZONE;
    process.env.TZ = "UTC";
    assert.equal(localDay(instant), "2026-04-29");
  } finally {
    restoreEnv("APP_TIME_ZONE", originalAppTimeZone);
    restoreEnv("TZ", originalTz);
  }
}

function testStoreBusinessDayScopedCache() {
  let businessDay = "2026-05-10";
  const identity = generateIdentity();
  const store = new Store(path.join(tmp, "db-business-day-cache.json"), {
    businessDayProvider: () => businessDay
  });
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId,
    deviceId,
    nickname: "business-day-user",
    identityPublicKey: identity.identityPublicKey,
    os: "test",
    appVersion: APP_VERSION
  });
  const baseItem = {
    toolCode: "codex",
    providerId: "codex_local",
    workdirHash: "wd_business_day",
    workdirDisplayName: "business-day-project",
    model: "gpt-5",
    inputTokens: 100,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    sourceQuality: "exact",
    rawSourceRef: "business-day.jsonl",
    providerVersion: "0.1.0",
    parserVersion: "0.1.0"
  };
  store.upsertUsageBatch({
    participantId: identity.participantId,
    deviceId,
    clientGeneratedAt: "2026-05-10T00:00:00.000Z",
    items: [
      { ...baseItem, day: "2026-05-10", totalTokens: 100, sourceFingerprint: "business-day-d1" },
      { ...baseItem, day: "2026-05-11", inputTokens: 200, totalTokens: 200, sourceFingerprint: "business-day-d2" }
    ]
  });

  const d1Board = store.publicLeaderboard({ period: "today" });
  assert.equal(d1Board[0].totalTokens, 100);
  const d1Summary = store.boardSummary();
  assert.equal(d1Summary.todayTokens, 100);
  assert.equal(Object.values(store.db.aggregateCache).some((entry) => entry.args.businessDay === "2026-05-10"), true);

  businessDay = "2026-05-11";
  const d2Board = store.publicLeaderboard({ period: "today" });
  assert.equal(d2Board[0].totalTokens, 200);
  const d2Summary = store.boardSummary();
  assert.equal(d2Summary.todayTokens, 200);
  assert.equal(d2Summary.yesterdayTokens, 100);
  assert.equal(Object.values(store.db.aggregateCache).some((entry) => entry.args.businessDay === "2026-05-11"), true);

  const customD1 = store.publicLeaderboard({ range: "custom", startDay: "2026-05-10", endDay: "2026-05-10" });
  assert.equal(customD1[0].totalTokens, 100);
  const customEntries = Object.values(store.db.aggregateCache).filter((entry) => entry.name === "publicLeaderboard" && entry.args.range === "custom");
  assert.equal(customEntries.every((entry) => !Object.hasOwn(entry.args, "businessDay")), true);
}

function testAdminUsageRowRangeFeedsParticipantDetail() {
  const identity = generateIdentity();
  const store = new Store(path.join(tmp, "db-admin-row-detail.json"));
  const deviceId = newId("d");
  const today = localDay();
  const previousDay = addDays(today, -9);
  store.registerDevice({
    participantId: identity.participantId,
    deviceId,
    nickname: "row-detail-user",
    identityPublicKey: identity.identityPublicKey,
    os: "test",
    appVersion: APP_VERSION
  });
  const baseItem = {
    toolCode: "codex",
    providerId: "codex_local",
    workdirHash: "wd_row_detail",
    workdirDisplayName: "row-detail-project",
    model: "gpt-5",
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    reasoningTokens: 20,
    totalTokens: 155,
    sourceQuality: "exact",
    rawSourceRef: "row-detail.jsonl",
    providerVersion: "0.1.0",
    parserVersion: "0.1.0"
  };
  store.upsertUsageBatch({
    participantId: identity.participantId,
    deviceId,
    clientGeneratedAt: "2026-05-07T00:00:00.000Z",
    items: [
      { ...baseItem, day: previousDay, sourceFingerprint: "row-detail-previous", totalTokens: 155 },
      { ...baseItem, day: today, sourceFingerprint: "row-detail-today", totalTokens: 310, inputTokens: 200, outputTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 10 }
    ]
  });

  const dayRows = store.adminUsage({ grain: "day", range: "last30" }).items;
  const previousDayRow = dayRows.find((item) => item.participantId === identity.participantId && item.periodStart === previousDay);
  assert.ok(previousDayRow);
  const dayDetail = store.participantDetail(identity.participantId, {
    range: "custom",
    startDay: previousDayRow.periodStart,
    endDay: previousDayRow.periodEnd
  });
  assert.equal(dayDetail.from, previousDay);
  assert.equal(dayDetail.to, previousDay);
  assert.deepEqual([...new Set(dayDetail.rows.map((item) => item.day))], [previousDay]);
  assert.equal(dayDetail.totalTokens, previousDayRow.totalTokens);

  for (const grain of ["week", "month"]) {
    const row = store.adminUsage({ grain, range: "last30" }).items.find((item) => item.participantId === identity.participantId);
    assert.ok(row);
    const detail = store.participantDetail(identity.participantId, {
      range: "custom",
      startDay: row.periodStart,
      endDay: row.periodEnd
    });
    assert.equal(detail.from, row.periodStart);
    assert.equal(detail.to, row.periodEnd);
    assert.equal(detail.rows.every((item) => item.day >= row.periodStart && item.day <= row.periodEnd), true);
  }
}

function testSourceFingerprintDedupeKeepsDistinctDays() {
  const identity = generateIdentity();
  const store = new Store(path.join(tmp, "db-source-fingerprint.json"));
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId,
    deviceId,
    nickname: "tester",
    identityPublicKey: identity.identityPublicKey,
    os: "test",
    appVersion: "0.3.0"
  });
  const baseItem = {
    toolCode: "codex",
    providerId: "codex_local",
    workdirHash: "wd_test",
    workdirDisplayName: "project",
    model: "gpt-5.5",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 115,
    sourceQuality: "exact",
    rawSourceRef: "session.jsonl",
    providerVersion: "0.1.2",
    parserVersion: "0.1.2",
    sourceFingerprint: "same-session-file"
  };
  const first = store.upsertUsageBatch({
    participantId: identity.participantId,
    deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [
      { ...baseItem, day: "2026-04-29" },
      { ...baseItem, day: "2026-04-30", inputTokens: 20, totalTokens: 125 }
    ]
  });
  assert.equal(first.accepted, 2);
  assert.equal(Object.values(store.db.usageDaily).length, 2);
  assert.deepEqual(
    Object.values(store.db.usageDaily).map((item) => item.day).sort(),
    ["2026-04-29", "2026-04-30"]
  );

  const second = store.upsertUsageBatch({
    participantId: identity.participantId,
    deviceId,
    clientGeneratedAt: new Date(Date.now() + 1).toISOString(),
    items: [
      { ...baseItem, day: "2026-04-29", inputTokens: 30, totalTokens: 135 }
    ]
  });
  assert.equal(second.accepted, 1);
  assert.equal(Object.values(store.db.usageDaily).length, 2);
  assert.equal(store.participantTrend(identity.participantId, { range: "custom", startDay: "2026-04-29", endDay: "2026-04-30" }).items.length, 2);
}

function testSnapshotWorkdirHashChange() {
  const tmp = path.join(os.tmpdir(), `test-wd-hash-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_wd", did = "d_wd";
  store.registerDevice({ participantId: pid, deviceId: did, nickname: "wd", identityPublicKey: "pk", os: "test", appVersion: "0.1.0" });

  // initial upload with hash_old
  const items = [makeSnapshotItem({ workdirHash: "hash_old", workdirDisplayName: "Old Dir" })];
  const snap1 = makeSnapshotPayload(items, pid, did);
  store.upsertSnapshotBatch(snap1);
  assert.equal(Object.keys(store.db.usageDaily).length, 1);

  // now workdirHash changed to hash_new
  const newItems = [makeSnapshotItem({ workdirHash: "hash_new", workdirDisplayName: "New Dir" })];
  const snap2 = makeSnapshotPayload(newItems, pid, did);
  store.upsertSnapshotBatch(snap2);

  // old hash row should be deleted, new hash row exists
  const keys = Object.keys(store.db.usageDaily);
  assert.equal(keys.length, 1, "old hash row should be deleted");
  assert.ok(keys[0].includes("hash_new"), "new hash row should remain");
  assert.ok(!keys[0].includes("hash_old"));

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testSnapshotWorkdirHashChange passed");
}

function testSnapshotProviderDisabled() {
  const tmp = path.join(os.tmpdir(), `test-prov-disabled-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_pd", did = "d_pd";
  store.registerDevice({ participantId: pid, deviceId: did, nickname: "pd", identityPublicKey: "pk", os: "test", appVersion: "0.1.0" });

  // upload codex + claude items
  const codex = [makeSnapshotItem({ providerId: "codex_local", toolCode: "codex", workdirHash: "h1" })];
  const claude = [makeSnapshotItem({ providerId: "claude_code_local", toolCode: "claude_code", workdirHash: "h2" })];
  store.upsertUsageBatch({ participantId: pid, deviceId: did, clientGeneratedAt: new Date().toISOString(), items: [...codex, ...claude] });
  assert.equal(Object.keys(store.db.usageDaily).length, 2);

  // provider disabled: no local rows for codex → client does NOT upload an empty bucket
  // only upload claude snapshot
  const claudeSnap = makeSnapshotPayload(claude, pid, did, { providerId: "claude_code_local" });
  store.upsertSnapshotBatch(claudeSnap);

  // codex rows still exist (no empty-bucket deletion)
  const keys = Object.keys(store.db.usageDaily);
  assert.equal(keys.length, 2, "codex rows should remain when provider has no local items");
  assert.ok(keys.some((k) => k.includes("codex_local")));
  assert.ok(keys.some((k) => k.includes("claude_code_local")));

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testSnapshotProviderDisabled passed");
}

function testSnapshotLegacyCoexistence() {
  const tmp = path.join(os.tmpdir(), `test-coexist-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_co", did = "d_co";
  store.registerDevice({ participantId: pid, deviceId: did, nickname: "co", identityPublicKey: "pk", os: "test", appVersion: "0.1.0" });

  // initial upload with 3 rows
  const items3 = [
    makeSnapshotItem({ workdirHash: "h1" }),
    makeSnapshotItem({ workdirHash: "h2" }),
    makeSnapshotItem({ workdirHash: "h3" })
  ];
  store.upsertUsageBatch({ participantId: pid, deviceId: did, clientGeneratedAt: new Date().toISOString(), items: items3 });
  assert.equal(Object.keys(store.db.usageDaily).length, 3);

  // snapshot deletes h2 and h3, keeps h1
  const items1 = [makeSnapshotItem({ workdirHash: "h1" })];
  const snap = makeSnapshotPayload(items1, pid, did);
  store.upsertSnapshotBatch(snap);
  assert.equal(Object.keys(store.db.usageDaily).length, 1);

  // legacy client re-upserts h2 (coexistence tradeoff)
  const legacyReup = [makeSnapshotItem({ workdirHash: "h2" })];
  store.upsertUsageBatch({ participantId: pid, deviceId: did, clientGeneratedAt: new Date().toISOString(), items: legacyReup });
  assert.equal(Object.keys(store.db.usageDaily).length, 2, "legacy re-upsert should add h2 back");
  assert.ok(Object.keys(store.db.usageDaily).some((k) => k.includes("h2")));

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testSnapshotLegacyCoexistence passed");
}

function makeSnapshotItem(overrides) {
  return {
    day: "2026-05-14", toolCode: "codex", providerId: "codex_local",
    workdirHash: "hash_default", workdirDisplayName: "Default Dir",
    model: "gpt-5", inputTokens: 100, outputTokens: 50,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    totalTokens: 150, sourceQuality: "exact", sourceFingerprint: "sf_1",
    ...overrides
  };
}

function makeSnapshotPayload(items, participantId, deviceId, options = {}) {
  const { providerId = items[0]?.providerId || "codex_local", day = items[0]?.day || "2026-05-14" } =
    typeof options === "string" ? { providerId: options } : options;
  const overrideDay = day;
  const overrideProvider = providerId;
  const snapshotItems = items.map((i) => ({ ...i, providerId: overrideProvider, day: overrideDay }));
  return {
    participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    snapshot: {
      mode: "device_day_provider",
      day: overrideDay,
      providerId: overrideProvider,
      bucketFingerprint: computeBucketFingerprint(snapshotItems),
      rowCount: snapshotItems.length,
      totalTokens: snapshotItems.reduce((s, i) => s + (i.totalTokens || 0), 0)
    },
    items: snapshotItems
  };
}

function makeHourlySnapshotPayload(items, participantId, deviceId, options = {}) {
  const {
    providerId = items[0]?.providerId || "codex_local",
    day = items[0]?.day || "2026-05-14",
    hour = items[0]?.hour ?? 10
  } = typeof options === "string" ? { providerId: options } : options;
  const snapshotItems = items.map((i) => ({ ...i, providerId, day, hour }));
  return {
    participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    snapshot: {
      mode: "device_day_hour_provider",
      day,
      hour,
      providerId,
      bucketFingerprint: computeBucketFingerprint(snapshotItems),
      rowCount: snapshotItems.length,
      totalTokens: snapshotItems.reduce((s, i) => s + (i.totalTokens || 0), 0)
    },
    items: snapshotItems
  };
}

function testSnapshotReplaceSemantics() {
  const tmp = path.join(os.tmpdir(), `test-snapshot-replace-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_test", did = "d_test";

  // setup: register device (also creates participant)
  store.registerDevice({
    participantId: pid, deviceId: did,
    nickname: "tester", identityPublicKey: "pk_test", os: "test", appVersion: "0.1.0"
  });

  const items3 = [
    makeSnapshotItem({ workdirHash: "h1", model: "gpt-5" }),
    makeSnapshotItem({ workdirHash: "h2", model: "gpt-5" }),
    makeSnapshotItem({ workdirHash: "h3", model: "claude-4" })
  ];
  const legacyResult = store.upsertUsageBatch({ participantId: pid, deviceId: did, clientGeneratedAt: new Date().toISOString(), items: items3 });
  assert.equal(legacyResult.accepted, 3);
  assert.equal(Object.keys(store.db.usageDaily).length, 3);

  // snapshot upload: remove h2, keep h1 and h3
  const items2 = [
    makeSnapshotItem({ workdirHash: "h1", model: "gpt-5" }),
    makeSnapshotItem({ workdirHash: "h3", model: "claude-4" })
  ];
  const snapPayload = makeSnapshotPayload(items2, pid, did);
  const snapResult = store.upsertSnapshotBatch(snapPayload);
  assert.equal(snapResult.accepted, 2);
  assert.equal(Object.keys(store.db.usageDaily).length, 2, "h2 should be deleted by snapshot replace");

  // verify h2 is gone, h1 and h3 remain
  const remainingKeys = Object.keys(store.db.usageDaily);
  assert.ok(remainingKeys.every((k) => !k.includes("h2")));

  // verify bucket metadata was recorded
  const meta = store.getBucketSync(pid, did, "2026-05-14", "codex_local");
  assert.ok(meta);
  assert.equal(meta.rowCount, 2);
  assert.equal(meta.bucketFingerprint, snapPayload.snapshot.bucketFingerprint);

  // same fingerprint → noOp
  const noOpPayload = makeSnapshotPayload(items2, pid, did);
  noOpPayload.snapshot.bucketFingerprint = snapPayload.snapshot.bucketFingerprint;
  const noOpResult = store.upsertSnapshotBatch(noOpPayload);
  assert.equal(noOpResult.noOp, true);
  assert.equal(noOpResult.duplicate, true);

  // stale client-declared fingerprint must not drive server no-op decisions
  const changedItems = [
    makeSnapshotItem({ workdirHash: "h1", model: "gpt-5", inputTokens: 200, outputTokens: 50, totalTokens: 250 }),
    makeSnapshotItem({ workdirHash: "h3", model: "claude-4" })
  ];
  const staleFingerprintPayload = makeSnapshotPayload(changedItems, pid, did);
  const serverFingerprint = computeBucketFingerprint(staleFingerprintPayload.items);
  staleFingerprintPayload.snapshot.bucketFingerprint = snapPayload.snapshot.bucketFingerprint;
  staleFingerprintPayload.snapshot.totalTokens = 999999;
  const changedResult = store.upsertSnapshotBatch(staleFingerprintPayload);
  assert.equal(changedResult.noOp, undefined);
  const changedMeta = store.getBucketSync(pid, did, "2026-05-14", "codex_local");
  assert.equal(changedMeta.bucketFingerprint, serverFingerprint);
  assert.equal(changedMeta.totalTokens, 400);

  // multi-provider independence: add claude_code_local rows, then snapshot codex_local only
  const claudeItems = [
    makeSnapshotItem({ providerId: "claude_code_local", toolCode: "claude_code", workdirHash: "ch1" })
  ];
  store.upsertUsageBatch({ participantId: pid, deviceId: did, clientGeneratedAt: new Date().toISOString(), items: claudeItems });
  assert.equal(Object.keys(store.db.usageDaily).length, 3, "should have 2 codex + 1 claude");

  // snapshot codex_local that only has h1
  const items1 = [makeSnapshotItem({ workdirHash: "h1", model: "gpt-5" })];
  const snap2 = makeSnapshotPayload(items1, pid, did, { providerId: "codex_local" });
  store.upsertSnapshotBatch(snap2);
  // h3 should be deleted from codex bucket, claude row untouched
  const afterDelete = Object.keys(store.db.usageDaily);
  assert.equal(afterDelete.length, 2, "h3 deleted from codex bucket, claude untouched");
  assert.ok(afterDelete.some((k) => k.includes("claude_code_local")));

  // legacy upsert still does NOT delete
  const itemsLegacyPartial = [makeSnapshotItem({ workdirHash: "h1", model: "gpt-5" })];
  store.upsertUsageBatch({ participantId: pid, deviceId: did, clientGeneratedAt: new Date().toISOString(), items: itemsLegacyPartial });
  // claude row should still exist (legacy doesn't delete)
  assert.ok(Object.keys(store.db.usageDaily).some((k) => k.includes("claude_code_local")));

  // multi-device independence
  store.registerDevice({ participantId: pid, deviceId: "d_other", nickname: "other", identityPublicKey: "pk_test", os: "test", appVersion: "0.1.0" });
  const otherDeviceItems = [makeSnapshotItem({ workdirHash: "h_other" })];
  store.upsertUsageBatch({ participantId: pid, deviceId: "d_other", clientGeneratedAt: new Date().toISOString(), items: otherDeviceItems });
  // empty bucket deletion is intentionally not supported in protocol v2
  const emptySnap = makeSnapshotPayload([], pid, did, { providerId: "codex_local" });
  emptySnap.snapshot.rowCount = 0;
  emptySnap.snapshot.totalTokens = 0;
  emptySnap.snapshot.bucketFingerprint = computeBucketFingerprint([]);
  assert.throws(() => store.upsertSnapshotBatch(emptySnap), /empty-bucket snapshot is not supported/);
  const remaining = Object.keys(store.db.usageDaily);
  assert.ok(remaining.some((k) => k.includes("d_other")), "other device rows should survive");
  assert.ok(remaining.some((k) => k.includes("d_test") && k.includes("codex_local")), "d_test codex rows should remain");

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testSnapshotReplaceSemantics passed");
}

function testHourlySnapshotDerivesDailyAndProtectsFromLegacy() {
  const tmp = path.join(os.tmpdir(), `test-hourly-snapshot-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_hourly", did = "d_hourly";
  store.registerDevice({
    participantId: pid, deviceId: did,
    nickname: "hourly", identityPublicKey: "pk_hourly", os: "test", appVersion: "0.1.0"
  });

  const hour10 = makeHourlySnapshotPayload([
    makeSnapshotItem({ hour: 10, workdirHash: "h1", inputTokens: 100, outputTokens: 50, totalTokens: 150 })
  ], pid, did, { hour: 10 });
  const hour11 = makeHourlySnapshotPayload([
    makeSnapshotItem({ hour: 11, workdirHash: "h1", inputTokens: 20, outputTokens: 30, totalTokens: 50 })
  ], pid, did, { hour: 11 });
  store.upsertUsageBatch(hour10);
  store.upsertUsageBatch(hour11);

  assert.equal(Object.keys(store.db.usageHourly).length, 2);
  const dailyRows = Object.values(store.db.usageDaily);
  assert.equal(dailyRows.length, 1);
  assert.equal(dailyRows[0].totalTokens, 200);
  assert.equal(dailyRows[0].hourlyDerived, true);

  const legacyOverwrite = [makeSnapshotItem({ workdirHash: "h1", inputTokens: 999, outputTokens: 1, totalTokens: 1000 })];
  store.upsertUsageBatch({ participantId: pid, deviceId: did, clientGeneratedAt: new Date().toISOString(), items: legacyOverwrite });
  assert.equal(Object.values(store.db.usageDaily)[0].totalTokens, 200, "legacy daily must not overwrite hourly-derived daily");

  const hour10Reduced = makeHourlySnapshotPayload([
    makeSnapshotItem({ hour: 10, workdirHash: "h1", inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  ], pid, did, { hour: 10 });
  store.upsertUsageBatch(hour10Reduced);
  assert.equal(Object.keys(store.db.usageHourly).length, 2, "hourly replace must not delete other hours");
  assert.equal(Object.values(store.db.usageDaily)[0].totalTokens, 65);

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testHourlySnapshotDerivesDailyAndProtectsFromLegacy passed");
}

function testBucketMetadataSchema() {
  const tmp = path.join(os.tmpdir(), `test-bucket-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_test1", did = "d_test1", day = "2026-05-14", prov = "codex_local";

  // initially no metadata
  assert.equal(store.getBucketSync(pid, did, day, prov), null);

  // record a bucket sync
  store.recordBucketSync({
    participantId: pid, deviceId: did, day, providerId: prov,
    bucketFingerprint: "fp_abc", rowCount: 3, totalTokens: 450,
    clientGeneratedAt: "2026-05-14T10:00:00Z"
  });
  const meta = store.getBucketSync(pid, did, day, prov);
  assert.ok(meta);
  assert.equal(meta.bucketFingerprint, "fp_abc");
  assert.equal(meta.rowCount, 3);
  assert.equal(meta.totalTokens, 450);
  assert.ok(meta.syncedAt);

  // update with new fingerprint
  store.recordBucketSync({
    participantId: pid, deviceId: did, day, providerId: prov,
    bucketFingerprint: "fp_def", rowCount: 2, totalTokens: 300,
    clientGeneratedAt: "2026-05-14T11:00:00Z"
  });
  const meta2 = store.getBucketSync(pid, did, day, prov);
  assert.equal(meta2.bucketFingerprint, "fp_def");
  assert.equal(meta2.rowCount, 2);

  // deleteBucketUsageRows: set up some usage rows in the bucket
  const key1 = `2026-05-14|${pid}|${did}|codex|${prov}|hash1|model-a`;
  const key2 = `2026-05-14|${pid}|${did}|codex|${prov}|hash2|model-b`;
  const key3 = `2026-05-14|${pid}|${did}|codex|other_prov|hash3|model-c`;
  store.db.usageDaily[key1] = { participantId: pid, deviceId: did, day, providerId: prov, totalTokens: 100 };
  store.db.usageDaily[key2] = { participantId: pid, deviceId: did, day, providerId: prov, totalTokens: 200 };
  store.db.usageDaily[key3] = { participantId: pid, deviceId: did, day, providerId: "other_prov", totalTokens: 300 };

  // delete rows in bucket not in incoming set (keep key1 only)
  store.deleteBucketUsageRows(pid, did, day, prov, [key1]);
  assert.ok(store.db.usageDaily[key1], "key1 should be kept");
  assert.equal(store.db.usageDaily[key2], undefined, "key2 should be deleted");
  assert.ok(store.db.usageDaily[key3], "key3 in different provider should be untouched");

  store.save();
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testBucketMetadataSchema passed");
}

function testSnapshotProtocolPayload() {
  const day = "2026-05-14";
  const makeItems = (count, overrides) => {
    const items = [];
    for (let i = 0; i < count; i++) {
      items.push({
        day, toolCode: "codex", providerId: "codex_local",
        workdirHash: `hash_${i}`, workdirDisplayName: `dir_${i}`,
        model: "gpt-5", inputTokens: 100, outputTokens: 50,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        totalTokens: 150, sourceQuality: "exact",
        ...overrides
      });
    }
    return items;
  };
  const makeSnapshot = (items, overrides) => ({
    mode: "device_day_provider", day, providerId: "codex_local",
    bucketFingerprint: computeBucketFingerprint(items),
    rowCount: items.length,
    totalTokens: items.reduce((s, i) => s + (i.totalTokens || 0), 0),
    ...overrides
  });

  // assertSnapshot: valid payload passes
  const items3 = makeItems(3);
  const snap3 = makeSnapshot(items3);
  assert.doesNotThrow(() => assertSnapshot(snap3, items3, "p_abc", "d_xyz"));

  // mixed day rejected
  const mixedDay = [...items3, { ...items3[0], day: "2026-05-13" }];
  assert.throws(() => assertSnapshot(makeSnapshot(mixedDay), mixedDay, "p_abc", "d_xyz"), /does not match snapshot day/);

  // mixed provider rejected
  const mixedProv = [...items3, { ...items3[0], providerId: "claude_code_local" }];
  assert.throws(() => assertSnapshot(makeSnapshot(mixedProv), mixedProv, "p_abc", "d_xyz"), /does not match snapshot providerId/);

  // rowCount mismatch rejected
  assert.throws(() => assertSnapshot({ ...snap3, rowCount: 99 }, items3, "p_abc", "d_xyz"), /does not match items length/);

  // missing fields rejected
  assert.throws(() => assertSnapshot({}, items3, "p_abc", "d_xyz"), /mode must be/);
  assert.throws(() => assertSnapshot({ mode: "device_day_provider" }, items3, "p_abc", "d_xyz"), /day must be/);

  // fingerprint determinism
  const fp1 = computeBucketFingerprint(items3);
  const fp2 = computeBucketFingerprint([...items3].reverse());
  assert.equal(fp1, fp2, "fingerprint should be deterministic regardless of input order");

  // fingerprint changes when a tracked field changes
  const modified = makeItems(3, { inputTokens: 999 });
  const fp3 = computeBucketFingerprint(modified);
  assert.notEqual(fp1, fp3, "fingerprint should change when a fingerprint field changes");

  // fingerprint stable when non-fingerprint fields change
  const extraFields = makeItems(3, { rawSourceRef: "different", providerVersion: "2.0" });
  const fp4 = computeBucketFingerprint(extraFields);
  assert.equal(fp1, fp4, "fingerprint should not change when non-fingerprint fields change");

  assert.throws(() => assertSnapshot({ ...snap3, rowCount: 0 }, [], "p_abc", "d_xyz"), /empty-bucket snapshot is not supported/);

  // BUCKET_FINGERPRINT_FIELDS has exactly 15 fields (including hour)
  assert.equal(BUCKET_FINGERPRINT_FIELDS.length, 15);

  console.log("  testSnapshotProtocolPayload passed");
}

function testForbiddenUploadFields() {
  assert.throws(() => assertNoForbiddenUploadFields({ prompt: "secret" }), /forbidden upload field/);
  assert.throws(() => assertNoForbiddenUploadFields({ nested: { identityPrivateKey: "secret" } }), /forbidden upload field/);
  assert.equal(USAGE_CACHE_VERSION, 3);
}

async function testVersionCompatibilityAndManifest() {
  assert.equal(clientMetadata().clientProtocolVersion, CLIENT_PROTOCOL_VERSION);
  assert.equal(SNAPSHOT_PROTOCOL_VERSION, 2);
  assert.equal(compatibilityResult({ clientProtocolVersion: CLIENT_PROTOCOL_VERSION }).status, "compatible");
  assert.equal(compatibilityResult({ clientProtocolVersion: 0 }).status, "unsupported_client");
  assert.equal(compatibilityResult({ clientProtocolVersion: 99 }).status, "unsupported_server");
  assert.equal(compatibilityResult({}).status, "upgrade_recommended");
  assert.equal(compatibilityResult({ clientProtocolVersion: "bad" }).status, "unsupported_client");

  // minClientEnforce: blocked when below latest
  assert.equal(compatibilityResult({ clientProtocolVersion: 1, clientAppVersion: "0.3.0" }, { latestClientVersion: "0.4.0", minClientEnforce: true }).status, "unsupported_client");
  assert.equal(compatibilityResult({ clientProtocolVersion: 1, clientAppVersion: "0.3.0" }, { latestClientVersion: "0.4.0", minClientEnforce: true }).compatible, false);
  assert.equal(compatibilityResult({ clientProtocolVersion: 1, clientAppVersion: "0.3.0" }, { latestClientVersion: "0.4.0", minClientEnforce: true }).mandatory, true);
  // minClientEnforce: pass when equal to latest
  assert.equal(compatibilityResult({ clientProtocolVersion: 1, clientAppVersion: "0.4.0" }, { latestClientVersion: "0.4.0", minClientEnforce: true }).status, "compatible");
  // minClientEnforce: pass when above latest
  assert.equal(compatibilityResult({ clientProtocolVersion: 1, clientAppVersion: "0.4.1" }, { latestClientVersion: "0.4.0", minClientEnforce: true }).status, "compatible");
  // minClientEnforce=false (default): not blocked, only informational
  assert.equal(compatibilityResult({ clientProtocolVersion: 1, clientAppVersion: "0.3.0" }, { latestClientVersion: "0.4.0" }).status, "upgrade_available");
  assert.equal(compatibilityResult({ clientProtocolVersion: 1, clientAppVersion: "0.3.0" }, { latestClientVersion: "0.4.0" }).compatible, true);
  // minClientEnforce exposed in server payload
  assert.equal(compatibilityResult({ clientProtocolVersion: 1, clientAppVersion: APP_VERSION }, { latestClientVersion: APP_VERSION, minClientEnforce: true }).server.minClientEnforce, true);
  assert.equal(compatibilityResult({ clientProtocolVersion: 1, clientAppVersion: APP_VERSION }, { latestClientVersion: APP_VERSION }).server.minClientEnforce, false);

  assert.throws(() => validateReleaseConfig({ publicBaseUrl: "" }), /missing release config/);
  const artifactFile = path.join(tmp, "AI Token League-darwin-arm64.zip");
  fs.writeFileSync(artifactFile, "test-artifact");
  const expectedSha = "a5db9b186b4b28674910702a72ba352b9e71cd699e8e186b4b7c931412edd5f3";
  await verifyFileChecksum(artifactFile, expectedSha);
  await assert.rejects(() => verifyFileChecksum(artifactFile, "bad"), /checksum mismatch/);
  assert.equal(updatePreflightState({ apiBaseUrl: "" }).code, "cloud_not_configured");
  assert.equal(updatePreflightState({ apiBaseUrl: "https://api.example" }), null);
  assert.equal(updatePreflightState({ apiBaseUrl: "https://api.example", release: {} }).code, "release_not_configured");
  assert.equal(updatePreflightState({ apiBaseUrl: "https://api.example", release: { publicBaseUrl: "https://cdn.example" } }), null);
  const publicRelease = releasePublicConfig({
    release: {
      source: "static",
      endpoint: "oss-cn-shanghai.aliyuncs.com",
      bucket: "private-bucket",
      prefix: "private-prefix",
      publicBaseUrl: "https://cdn.example"
    },
    latestClientVersion: "0.3.1"
  });
  assert.equal(publicRelease.latestClientVersion, "0.3.1");
  assert.equal(publicRelease.publicBaseUrl, "https://cdn.example");
  assert.equal(Object.hasOwn(publicRelease, "endpoint"), false);
  assert.equal(Object.hasOwn(publicRelease, "bucket"), false);
  assert.equal(Object.hasOwn(publicRelease, "prefix"), false);
  assert.equal(Object.hasOwn(publicRelease, "manifestUrl"), false);
  assert.equal(publicRelease.source, "static");

  const githubRelease = releaseDistributionFromEnv({
    RELEASE_SOURCE: "github",
    RELEASE_GITHUB_REPOSITORY: "SKYhuangjing/ai-token-league",
    RELEASE_GITHUB_TAG: "v0.6.3"
  });
  assert.equal(githubRelease.source, "github");
  assert.equal(githubRelease.githubRepository, "SKYhuangjing/ai-token-league");
  assert.equal(githubRelease.githubTag, "v0.6.3");
  assert.equal(githubReleaseApiUrl({
    repository: "SKYhuangjing/ai-token-league",
    tag: "v0.6.3"
  }), "https://api.github.com/repos/SKYhuangjing/ai-token-league/releases/tags/v0.6.3");
  assert.equal(githubReleaseApiUrl({
    repository: "SKYhuangjing/ai-token-league"
  }), "https://api.github.com/repos/SKYhuangjing/ai-token-league/releases/latest");

  const installerMetadata = {
    version: APP_VERSION,
    platforms: {
      "darwin-arm64": {
        url: `https://cdn.example/releases/${APP_VERSION}/AI%20Token%20League-${APP_VERSION}-mac-arm64-installer.dmg`,
        fileName: `AI Token League-${APP_VERSION}-mac-arm64-installer.dmg`,
        sha256: expectedSha,
        size: 200,
        ext: "dmg"
      },
      "darwin-x64": {
        url: `https://cdn.example/releases/${APP_VERSION}/AI%20Token%20League-${APP_VERSION}-mac-x64-installer.dmg`,
        fileName: `AI Token League-${APP_VERSION}-mac-x64-installer.dmg`,
        sha256: expectedSha.toUpperCase(),
        size: 201,
        ext: "dmg"
      },
      "win32-x64": {
        url: `https://cdn.example/releases/${APP_VERSION}/AI%20Token%20League-${APP_VERSION}-win-x64-installer.exe`,
        fileName: `AI Token League-${APP_VERSION}-win-x64-installer.exe`,
        sha256: expectedSha,
        size: 202,
        ext: "exe"
      },
      "linux-x64": {
        url: `https://cdn.example/releases/${APP_VERSION}/AI%20Token%20League-${APP_VERSION}-linux-x64.AppImage`,
        fileName: `AI Token League-${APP_VERSION}-linux-x64.AppImage`,
        sha256: expectedSha,
        size: 203,
        ext: "AppImage"
      }
    }
  };
  const installers = validateInstallerMetadata(installerMetadata, { publicBaseUrl: "https://cdn.example" });
  assert.equal(installers["darwin-arm64"].ext, "dmg");
  assert.equal(installers["darwin-x64"].sha256, expectedSha);
  assert.throws(() => validateInstallerMetadata({
    platforms: {
      "darwin-arm64": installerMetadata.platforms["darwin-arm64"],
      "darwin-x64": installerMetadata.platforms["darwin-x64"]
    }
  }, { publicBaseUrl: "https://cdn.example" }), /installer (win32-x64|linux-x64) missing/);
  assert.throws(() => validateInstallerMetadata({
    platforms: {
      ...installerMetadata.platforms,
      "darwin-arm64": { ...installerMetadata.platforms["darwin-arm64"], url: "https://evil.example/installer.dmg" }
    }
  }, { publicBaseUrl: "https://cdn.example" }), /outside release public base url/);
  assert.throws(() => validateInstallerMetadata({
    platforms: {
      ...installerMetadata.platforms,
      "win32-x64": { ...installerMetadata.platforms["win32-x64"], fileName: "../installer.exe" }
    }
  }, { publicBaseUrl: "https://cdn.example" }), /fileName must be basename/);

  const ghAssetBase = "https://github.com/SKYhuangjing/ai-token-league/releases/download/v0.6.3";
  const githubInstallerMeta = buildInstallerMetadataFromGithubRelease({
    tag_name: "v0.6.3",
    assets: [
      githubAsset("AI Token League_0.6.3_macos_aarch64.dmg", 200, `${ghAssetBase}/mac-arm64.dmg`, expectedSha),
      githubAsset("AI Token League_0.6.3_macos_x64.dmg", 201, `${ghAssetBase}/mac-x64.dmg`, expectedSha),
      githubAsset("AI Token League_0.6.3_windows_x64-setup.exe", 202, `${ghAssetBase}/win.exe`, expectedSha),
      githubAsset("AI Token League_0.6.3_linux_amd64.AppImage", 203, `${ghAssetBase}/linux.AppImage`, expectedSha)
    ]
  });
  assert.equal(validateInstallerMetadata(githubInstallerMeta)["win32-x64"].fileName, "AI Token League_0.6.3_windows_x64-setup.exe");

  const tauriJson = buildTauriUpdateJson({
    version: "0.6.3",
    publicBaseUrl: "https://github.com/SKYhuangjing/ai-token-league",
    artifacts: [
      { platform: "darwin-arm64", url: `${ghAssetBase}/mac-arm64.app.tar.gz`, signature: "sig-a" },
      { platform: "darwin-x64", url: `${ghAssetBase}/mac-x64.app.tar.gz`, signature: "sig-b" },
      { platform: "win32-x64", url: `${ghAssetBase}/win.nsis.zip`, signature: "sig-c" },
      { platform: "linux-x64", url: `${ghAssetBase}/linux.AppImage.tar.gz`, signature: "sig-d" }
    ]
  });
  assert.equal(tauriJson.platforms["darwin-aarch64"].signature, "sig-a");
  assert.equal(tauriJson.platforms["windows-x86_64"].url, `${ghAssetBase}/win.nsis.zip`);
}

function githubAsset(name, size, url, sha256) {
  return {
    name,
    size,
    browser_download_url: url,
    digest: `sha256:${sha256}`
  };
}

function testProductBaseline() {
  assert.match(PRODUCT_BASELINE, /^\d+\.\d+$/, "PRODUCT_BASELINE should be major.minor format");
}

function testPublicChangelogParsing() {
  const parsed = parseLatestChangelog(`# Changelog

## [0.5.3] - 2026-05-09

### Added

- [Desktop] Source toggle controls now use a switch-style UI.
- Added internal release helper.
- [Desktop, Web] Completed locale coverage.

### Fixed

- [Web] Public download cards render current release metadata.

---

## [0.5.2] - 2026-05-07

### Fixed

- [Desktop] Older entry.
`);
  assert.equal(parsed.version, "0.5.3");
  assert.equal(parsed.date, "2026-05-09");
  assert.deepEqual(parsed.sections.map((section) => section.heading), ["Added", "Fixed"]);
  assert.deepEqual(parsed.sections[0].items.map((item) => item.tag), ["Desktop", "Desktop, Web"]);
  assert.equal(parsed.sections[0].items[0].text, "Source toggle controls now use a switch-style UI.");
  assert.equal(parsed.sections[1].items[0].tag, "Web");

  const noPublicItems = parseLatestChangelog(`## [0.5.3] - 2026-05-09

### Added

- Internal release helper.
`);
  assert.equal(noPublicItems.sections.length, 0);
}

function testDisplayAndPricing() {
  assert.equal(formatTokenCompact(120456222), "1.20亿");
  assert.equal(formatTokenCompact(80450000), "8045万");
  assert.equal(formatUsd(null), "-");
  const openrouterPrice = openRouterModelToPrice({
    id: "openai/gpt-5",
    pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001" },
    top_provider: { max_completion_tokens: 128000 },
    context_length: 400000
  }, "2026-04-30T00:00:00.000Z", "test-openrouter");
  const exact = estimateUsageCost({ model: "openai/gpt-5", inputTokens: 1000, outputTokens: 1000 }, createPriceMap({}, { [openrouterPrice.model]: openrouterPrice }));
  assert.equal(exact.costQuality, "exact_price");
  assert.ok(exact.estimatedCostUsd > 0);
  assert.equal(exact.inputCostUsd, 0.001);
  assert.equal(exact.pricingSource, "openrouter");
  const estimated = estimateUsageCost({ model: "gpt-5", inputTokens: 1000, outputTokens: 1000 }, createPriceMap({}, { [openrouterPrice.model]: openrouterPrice }));
  assert.equal(estimated.costQuality, "estimated_price");
  const codexPrice = openRouterModelToPrice({
    id: "openai/gpt-5.3-codex",
    pricing: { prompt: "0.000003", completion: "0.000006" }
  }, "2026-04-30T00:00:00.000Z", "test-openrouter");
  const unmappedPremium = estimateUsageCost({ model: "Premium (Codex 5.3)", inputTokens: 1000, outputTokens: 1000 }, createPriceMap({}, {
    "openai/gpt-5.3-codex": codexPrice
  }));
  assert.equal(unmappedPremium.costQuality, "unknown_price");
  const premiumCodex = estimateUsageCost({ model: "Premium (Codex 5.3)", inputTokens: 1000, outputTokens: 1000 }, createPriceMap({}, {
    "openai/gpt-5.3-codex": codexPrice
  }, {
    "Premium (Codex 5.3)": "openai/gpt-5.3-codex"
  }));
  assert.equal(premiumCodex.costQuality, "exact_price");
  assert.equal(premiumCodex.pricingModel, "openai/gpt-5.3-codex");
  assert.equal(premiumCodex.estimatedCostUsd, 0.009);
  const unknown = estimateUsageCost({ model: "unknown-model", inputTokens: 1000, outputTokens: 1000 });
  assert.equal(unknown.costQuality, "unknown_price");
  assert.equal(unknown.estimatedCostUsd, null);
  const custom = estimateUsageCost({ model: "custom-test-model", inputTokens: 1000, outputTokens: 1000 }, createPriceMap({
    "custom-test-model": { model: "custom-test-model", inputCostPerMTok: 1, outputCostPerMTok: 2 }
  }));
  assert.equal(custom.costQuality, "exact_price");
  assert.equal(custom.estimatedCostUsd, 0.003);
  const autoReview = estimateUsageCost({ model: "codex-auto-review", inputTokens: 1000, outputTokens: 1000 }, createPriceMap({
    auto: { model: "auto", inputCostPerMTok: 1.25, outputCostPerMTok: 6 }
  }));
  assert.equal(autoReview.costQuality, "unknown_price");
  assert.equal(autoReview.estimatedCostUsd, null);
  const cachedInput = estimateUsageCost({
    model: "custom-test-model",
    inputTokens: 100,
    outputTokens: 100,
    cacheReadTokens: 800,
    cacheWriteTokens: 100,
    reasoningTokens: 50
  }, createPriceMap({
    "custom-test-model": {
      model: "custom-test-model",
      inputCostPerMTok: 1,
      outputCostPerMTok: 2,
      cacheReadCostPerMTok: 0.1,
      cacheWriteCostPerMTok: 0.2,
      reasoningCostPerMTok: 3
    }
  }));
  assert.equal(cachedInput.inputCostUsd, 0.0001);
  assert.equal(cachedInput.cacheReadCostUsd, 0.00008);
  assert.equal(cachedInput.cacheWriteCostUsd, 0.00002);
  assert.equal(cachedInput.reasoningCostUsd, 0);
  assert.equal(cachedInput.estimatedCostUsd, 0.0004);
}

async function testOpenRouterRefresh() {
  const store = new Store(path.join(tmp, "openrouter-db.json"), { persist: false });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: [
        {
          id: "openai/gpt-5-test",
          canonical_slug: "openai/gpt-5-test-20260430",
          context_length: 128000,
          pricing: {
            prompt: "0.000001",
            completion: "0.000002",
            input_cache_read: "0.0000001",
            input_cache_write: "0.000001",
            internal_reasoning: "0.000002"
          },
          top_provider: { max_completion_tokens: 64000 }
        }
      ]
    })
  });
  try {
    const refreshed = await store.refreshOpenRouterPrices();
    assert.equal(refreshed.remote.status, "fresh");
    assert.equal(Object.keys(store.db.modelPriceCache.prices).length, 1);
    const remoteCost = estimateUsageCost({ model: "gpt-5-test", inputTokens: 1000, outputTokens: 1000 }, store.priceMap());
    assert.equal(remoteCost.costQuality, "estimated_price");
    assert.equal(remoteCost.pricingSource, "openrouter");
    store.upsertModelPrice({ model: "gpt-5-test", inputCostPerMTok: 10, outputCostPerMTok: 20 });
    const customCost = estimateUsageCost({ model: "gpt-5-test", inputTokens: 1000, outputTokens: 1000 }, store.priceMap());
    assert.equal(customCost.costQuality, "exact_price");
    assert.equal(customCost.pricingSource, "custom");
    assert.equal(customCost.estimatedCostUsd, 0.03);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function testHmacSha256Hex() {
  // determinism
  const a = hmacSha256Hex("salt", "data");
  const b = hmacSha256Hex("salt", "data");
  assert.equal(a, b);
  assert.equal(a.length, 64);
  // different key produces different output
  const c = hmacSha256Hex("other-salt", "data");
  assert.notEqual(a, c);
  // different data produces different output
  const d = hmacSha256Hex("salt", "other-data");
  assert.notEqual(a, d);
}

function testBoardAnonymizer() {
  const anonymizer = new BoardAnonymizer("test-salt-12345");

  // publicId stability
  const id1 = anonymizer.getPublicId("p_abc123");
  const id2 = anonymizer.getPublicId("p_abc123");
  assert.equal(id1, id2);
  assert.equal(id1.length, 16);

  // different participantId → different publicId
  const id3 = anonymizer.getPublicId("p_def456");
  assert.notEqual(id1, id3);

  // displayName stability
  const name1 = anonymizer.getDisplayName(id1);
  const name2 = anonymizer.getDisplayName(id1);
  assert.equal(name1, name2);
  assert.ok(typeof name1 === "string" && name1.length > 0);

  // custom names
  const custom = new BoardAnonymizer("salt", ["Alpha", "Beta", "Gamma"]);
  const cname = custom.getDisplayName(id1);
  assert.ok(["Alpha", "Beta", "Gamma"].includes(cname));

  // deduplication: force collisions by using single-name wordlist
  const dedup = new BoardAnonymizer("salt", ["火星"]);
  const pids = ["p_aaa", "p_bbb", "p_ccc"];
  dedup.buildReverseMap(pids);
  const names = pids.map((pid) => dedup.getDisplayName(dedup.getPublicId(pid)));
  assert.equal(names[0], "火星");
  assert.equal(names[1], "火星 2");
  assert.equal(names[2], "火星 3");

  // reverse map
  const ids = ["p_abc123", "p_def456", "p_ghi789"];
  anonymizer.buildReverseMap(ids);
  for (const pid of ids) {
    const pubId = anonymizer.getPublicId(pid);
    assert.equal(anonymizer.resolveParticipantId(pubId), pid);
  }
  assert.equal(anonymizer.resolveParticipantId("nonexistent"), null);
  assert.equal(anonymizer.dirty, false);

  // markDirty
  anonymizer.markDirty();
  assert.equal(anonymizer.dirty, true);
}

function testBoardAnonymizerDailyRotation() {
  // todayStr returns YYYY-MM-DD in Asia/Shanghai by default
  const today = todayStr();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);

  // same day: publicId is stable
  const anon = new BoardAnonymizer("daily-test-salt", ["甲", "乙", "丙"]);
  const id1 = anon.getPublicId("p_user1");
  const id2 = anon.getPublicId("p_user1");
  assert.equal(id1, id2);

  // stale is false when _buildDate matches today
  anon.buildReverseMap(["p_user1", "p_user2"]);
  assert.equal(anon.stale, false);

  // stale is true when _buildDate is set to a past date
  anon._buildDate = "2020-01-01";
  assert.equal(anon.stale, true);

  // after rebuild, stale is false again
  anon.buildReverseMap(["p_user1", "p_user2"]);
  assert.equal(anon.stale, false);

  // todayStr with custom timezone returns valid date
  const todayUtc = todayStr("UTC");
  assert.match(todayUtc, /^\d{4}-\d{2}-\d{2}$/);

  let businessDay = "2026-05-10";
  const injected = new BoardAnonymizer("injected-day-salt", ["甲", "乙", "丙"], () => businessDay);
  const d1PublicId = injected.getPublicId("p_user1");
  assert.equal(injected.getPublicId("p_user1"), d1PublicId);
  injected.buildReverseMap(["p_user1"]);
  assert.equal(injected.resolveParticipantId(d1PublicId), "p_user1");
  assert.equal(injected.stale, false);
  businessDay = "2026-05-11";
  assert.equal(injected.stale, true);
  const d2PublicId = injected.getPublicId("p_user1");
  assert.notEqual(d2PublicId, d1PublicId);
  injected.buildReverseMap(["p_user1"]);
  assert.equal(injected.resolveParticipantId(d2PublicId), "p_user1");
}

function testLoadNames() {
  const namesPath = path.join(tmp, "test-names.json");
  // valid file
  fs.writeFileSync(namesPath, JSON.stringify(["甲", "乙", "丙"]));
  const names = loadNames(namesPath);
  assert.deepEqual(names, ["甲", "乙", "丙"]);
  // missing file → default
  const defaultNames = loadNames(path.join(tmp, "nonexistent.json"));
  assert.ok(defaultNames.length > 10);
  // empty path → default
  const emptyPath = loadNames("");
  assert.ok(emptyPath.length > 10);
  fs.unlinkSync(namesPath);
}

function testLoadOrGenerateSalt() {
  const saltPath = path.join(tmp, "test-salt.key");
  // clean up if exists
  try { fs.unlinkSync(saltPath); } catch {}
  // first call generates
  const salt1 = loadOrGenerateSalt(saltPath);
  assert.ok(salt1.length >= 32);
  assert.ok(fs.existsSync(saltPath));
  // second call reads same salt
  const salt2 = loadOrGenerateSalt(saltPath);
  assert.equal(salt1, salt2);
  // cleanup
  fs.unlinkSync(saltPath);
}

function makeBackendUploadFixture() {
  const identity = generateIdentity();
  const items = [
    {
      day: localDay(),
      toolCode: "codex",
      providerId: "codex_local",
      workdirHash: "wd_codex",
      workdirDisplayName: "codex-project",
      model: "gpt-5",
      inputTokens: 950,
      outputTokens: 300,
      cacheReadTokens: 200,
      cacheWriteTokens: 50,
      reasoningTokens: 150,
      totalTokens: 1500,
      sourceQuality: "exact",
      rawSourceRef: "codex-sample.jsonl",
      providerVersion: "0.1.2",
      parserVersion: "0.1.2",
      sourceFingerprint: "sf_codex"
    },
    {
      day: localDay(),
      toolCode: "claude_code",
      providerId: "claude_code_local",
      workdirHash: "wd_claude",
      workdirDisplayName: "claude-project",
      model: "claude-sonnet-4",
      inputTokens: 2000,
      outputTokens: 500,
      cacheReadTokens: 260,
      cacheWriteTokens: 200,
      reasoningTokens: 0,
      totalTokens: 2960,
      sourceQuality: "exact",
      rawSourceRef: "claude-sample.jsonl",
      providerVersion: "0.1.1",
      parserVersion: "0.1.1",
      sourceFingerprint: "sf_claude"
    }
  ];
  return { identity, items };
}

const { identity, items } = makeBackendUploadFixture();
testHmacSha256Hex();
testBoardAnonymizer();
testBoardAnonymizerDailyRotation();
testBusinessDayContextEnvOverride();
testTrayLocalDayUsesConfiguredTimezone();
testLoadOrGenerateSalt();
testLoadNames();
testBackendUpload(identity, items);
testDeleteParticipantDataAllowsResync();
await testParticipantDataDeleteMissingIsNoop();
await testBoardApiBusinessDayMetadata();
testStoreBusinessDayScopedCache();
testAdminUsageRowRangeFeedsParticipantDetail();
testSourceFingerprintDedupeKeepsDistinctDays();
testForbiddenUploadFields();
testSnapshotProtocolPayload();
testBucketMetadataSchema();
testSnapshotReplaceSemantics();
testHourlySnapshotDerivesDailyAndProtectsFromLegacy();
testSnapshotWorkdirHashChange();
testSnapshotProviderDisabled();
testSnapshotLegacyCoexistence();
testProductBaseline();
testPublicChangelogParsing();
await testVersionCompatibilityAndManifest();
testDisplayAndPricing();
await testOpenRouterRefresh();
console.log("All tests passed");
