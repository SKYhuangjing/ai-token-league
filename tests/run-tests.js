import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/backend/store.js";
import { MySqlStore } from "../src/backend/mysql-store.js";
import { canonicalJson, sha256Hex, generateIdentity, newId, signPayload, hmacSha256Hex, verifyPayload, normalizeLegacyEd25519Pem } from "../src/shared/crypto.js";
import { BoardAnonymizer, loadOrGenerateSalt, loadNames, todayStr } from "../src/backend/board-anonymizer.js";
import { assertNoForbiddenUploadFields, assertSnapshot, BUCKET_FINGERPRINT_FIELDS, computeBucketFingerprint, displayTotalTokens, USAGE_CACHE_VERSION, usageKey, normalizeTokenNumber, cloudNaturalKey, todayLocal, CLOUD_PROVIDER_IDS } from "../src/shared/schema.js";
import { compatibilityResult, clientMetadata, CLIENT_PROTOCOL_VERSION, SNAPSHOT_PROTOCOL_VERSION, APP_VERSION, PRODUCT_BASELINE, compareSemver, normalizeClientMetadata, collectNetworkInfo, clientPlatform, clientBuild, packageVersion, productBaseline } from "../src/shared/version.js";
import {
  buildInstallerMetadataFromGithubRelease,
  buildLatestYml,
  buildReleaseManifest,
  buildTauriUpdateJson,
  githubReleaseApiUrl,
  installerMetadataPlatforms,
  releaseConfigFromEnv,
  releaseDistributionFromEnv,
  releasePublicConfig,
  releasePlatformsFromEnv,
  selectInstallerArtifact,
  selectUpdateArtifact,
  sha512Base64,
  updatePreflightState,
  updateStateFromManifest,
  validateInstallerMetadata,
  validateReleaseConfig,
  validateReleaseManifest,
  verifyFileChecksum
} from "../src/shared/update.js";
import { parseLatestChangelog, parseChangelogVersion } from "../src/shared/changelog.js";
import { formatTokenCompact, formatTokenRaw, formatUsd } from "../src/shared/display.js";
import {
  compositionRatio, createEmptyComposition, dominantComposition,
  mergeTokenComposition, tokenCompositionSummary, tokenCompositionDetails,
  costQualityLabel, TOKEN_COMPOSITION_FIELDS, COST_COMPOSITION_FIELDS
} from "../src/shared/composition.js";
import { generateNickname, loadClientNicknames } from "../src/shared/nickname-generator.js";
import { PRESET_ALLOWED_KEYS, loadBuildPreset } from "../src/shared/preset.js";
import { hourlyUsageKey, publicUsageItem, assertUsageItem, primaryTokenTotal, SOURCE_QUALITY, FORBIDDEN_UPLOAD_FIELDS } from "../src/shared/schema.js";
import { createPriceMap, estimateUsageCost, openRouterModelToPrice, aggregateCost, mergeCostQuality, normalizeModelName, priceToPublic, addCostToUsageItem } from "../src/shared/pricing.js";
import { addDays, localDay, daysBetween, dayToUtcDate, utcDateToDay } from "../src/shared/date.js";
import { currentBusinessDay } from "../src/backend/day-context.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-token-league-test-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function withLegacyEd25519Oid(pem) {
  const match = pem.match(/^-----BEGIN ([A-Z ]+)-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END \1-----\s*$/s);
  assert.ok(match);
  const [, label, body] = match;
  const der = Buffer.from(body.replace(/\s+/g, ""), "base64");
  const offset = der.indexOf(Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]));
  assert.ok(offset >= 0);
  Buffer.from([0x06, 0x03, 0x55, 0x3d, 0x65]).copy(der, offset);
  return `-----BEGIN ${label}-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`;
}

function testLegacyEd25519PemCompatibility() {
  const identity = generateIdentity();
  const legacyPublicKey = withLegacyEd25519Oid(identity.identityPublicKey);
  const legacyPrivateKey = withLegacyEd25519Oid(identity.identityPrivateKey);
  const payload = { probe: "legacy-ed25519-pem" };
  const signature = signPayload(legacyPrivateKey, payload);

  assert.equal(verifyPayload(legacyPublicKey, payload, signature), true);
  assert.equal(normalizeLegacyEd25519Pem(legacyPublicKey), identity.identityPublicKey);

  const store = new Store(path.join(tmp, "legacy-ed25519-db.json"));
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId,
    deviceId,
    nickname: "legacy",
    identityPublicKey: legacyPublicKey,
    os: "test",
    appVersion: "0.1.0"
  });
  store.registerDevice({
    participantId: identity.participantId,
    deviceId,
    nickname: "legacy",
    identityPublicKey: identity.identityPublicKey,
    os: "test",
    appVersion: "0.1.0"
  });
  assert.equal(store.getParticipant(identity.participantId).identityPublicKey, identity.identityPublicKey);
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
  assert.ok(Object.keys(store.aggregateCache).length >= 1);
  assert.equal(Object.keys(store.db.aggregateCache).length, 0);
  store.aggregateCache = {};
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
  assert.ok(Object.keys(store.aggregateCache).length >= 1);

  const deleted = store.deleteParticipantData(identity.participantId);
  assert.equal(deleted.deleted, true);
  assert.deepEqual(deleted.removed, {
    participants: 1,
    devices: 1,
    workdirs: 1,
    usageDaily: 1,
    uploadBatches: 1,
    usageSyncBuckets: 0,
    usageHourly: 0,
    usageSyncBucketsHourly: 0
  });
  assert.equal(store.getParticipant(identity.participantId), null);
  assert.equal(Object.values(store.db.devices).some((row) => row.participantId === identity.participantId), false);
  assert.equal(Object.values(store.db.workdirs).some((row) => row.participantId === identity.participantId), false);
  assert.equal(Object.values(store.db.usageDaily).some((row) => row.participantId === identity.participantId), false);
  assert.equal(Object.values(store.db.uploadBatches).some((row) => row.participantId === identity.participantId), false);
  assert.equal(Object.keys(store.aggregateCache).length, 0);
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

function testDeleteDeviceDataKeepsParticipantAndOtherDevices() {
  const tmpPath = path.join(tmp, `db-delete-device-${Date.now()}.json`);
  const store = new Store(tmpPath);
  const identity = generateIdentity();
  const didA = newId("d");
  const didB = newId("d");
  const day = "2026-05-14";

  store.registerDevice({ participantId: identity.participantId, deviceId: didA, nickname: "reset-device", identityPublicKey: identity.identityPublicKey, os: "test", appVersion: APP_VERSION });
  store.registerDevice({ participantId: identity.participantId, deviceId: didB, nickname: "reset-device", identityPublicKey: identity.identityPublicKey, os: "test", appVersion: APP_VERSION });
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash: "wd_device_a", totalTokens: 100, providerId: "codex_local", day, hour: 9 })
  ], identity.participantId, didA, { providerId: "codex_local", day, hour: 9 }));
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash: "wd_device_b", totalTokens: 200, providerId: "codex_local", day, hour: 9 })
  ], identity.participantId, didB, { providerId: "codex_local", day, hour: 9 }));

  const deleted = store.deleteDeviceData(didA);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.participantId, identity.participantId);
  assert.equal(deleted.removed.devices, 1);
  assert.equal(deleted.removed.usageHourly, 1);
  assert.equal(store.getParticipant(identity.participantId)?.id, identity.participantId);
  assert.equal(Boolean(store.db.devices[didA]), false);
  assert.equal(Boolean(store.db.devices[didB]), true);
  assert.equal(Object.values(store.db.usageHourly).some((row) => row.deviceId === didA), false);
  assert.equal(Object.values(store.db.usageHourly).some((row) => row.deviceId === didB), true);
  assert.equal(Object.values(store.db.usageSyncBucketsHourly).some((row) => row.deviceId === didA), false);

  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  console.log("  testDeleteDeviceDataKeepsParticipantAndOtherDevices passed");
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
      usageSyncBuckets: 0,
      usageHourly: 0,
      usageSyncBucketsHourly: 0
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
  assert.equal(Object.values(store.aggregateCache).some((entry) => entry.args.businessDay === "2026-05-10"), true);

  businessDay = "2026-05-11";
  const d2Board = store.publicLeaderboard({ period: "today" });
  assert.equal(d2Board[0].totalTokens, 200);
  const d2Summary = store.boardSummary();
  assert.equal(d2Summary.todayTokens, 200);
  assert.equal(d2Summary.yesterdayTokens, 100);
  assert.equal(Object.values(store.aggregateCache).some((entry) => entry.args.businessDay === "2026-05-11"), true);

  const customD1 = store.publicLeaderboard({ range: "custom", startDay: "2026-05-10", endDay: "2026-05-10" });
  assert.equal(customD1[0].totalTokens, 100);
  const customEntries = Object.values(store.aggregateCache).filter((entry) => entry.name === "publicLeaderboard" && entry.args.range === "custom");
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

async function testMysqlHourlySnapshotUsesIncrementalSync() {
  const store = new MySqlStore({});
  const pid = "p_mysql_hourly", did = "d_mysql_hourly";
  Store.prototype.registerDevice.call(store, {
    participantId: pid, deviceId: did,
    nickname: "mysql-hourly", identityPublicKey: "pk_mysql_hourly", os: "test", appVersion: "0.1.0"
  });

  let fullSyncCalled = false;
  let incrementalCalled = false;
  store.syncAllTables = async () => {
    fullSyncCalled = true;
  };
  store.incrementalHourlyBucketSync = async (_input, result) => {
    incrementalCalled = true;
    assert.equal(result.noOp, undefined);
    assert.equal(result.accepted, 1);
    assert.equal(result.incomingKeys.length, 1);
  };

  await store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash: "mysql_hourly_h1", inputTokens: 5, outputTokens: 7, totalTokens: 12 })
  ], pid, did, { day: "2026-05-14", hour: 10, providerId: "codex_local" }));

  assert.equal(incrementalCalled, true, "hourly snapshots should use incremental MySQL sync");
  assert.equal(fullSyncCalled, false, "hourly snapshots must not trigger full-table MySQL sync");
  console.log("  testMysqlHourlySnapshotUsesIncrementalSync passed");
}

async function testMysqlHourlyIncrementalSyncScopesDeletes() {
  const store = new MySqlStore({});
  const pid = "p_mysql_scope", did = "d_mysql_scope";
  Store.prototype.registerDevice.call(store, {
    participantId: pid, deviceId: did,
    nickname: "mysql-scope", identityPublicKey: "pk_mysql_scope", os: "test", appVersion: "0.1.0"
  });
  const payload = makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash: "mysql_scope_h1", inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  ], pid, did, { day: "2026-05-14", hour: 11, providerId: "codex_local" });
  const result = Store.prototype.upsertUsageBatch.call(store, payload);
  const queries = [];
  const conn = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params = []) {
      queries.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
      return [[], []];
    }
  };
  store.pool = { getConnection: async () => conn };

  await store.incrementalHourlyBucketSync(payload, result);

  const statements = queries.map((q) => q.sql);
  assert.equal(statements.includes("DELETE FROM usage_daily"), false, "incremental hourly sync must not wipe usage_daily");
  assert.equal(statements.includes("DELETE FROM usage_hourly"), false, "incremental hourly sync must not wipe usage_hourly");
  assert.ok(
    statements.some((sql) => sql.startsWith("DELETE FROM usage_hourly WHERE participantId = ? AND deviceId = ? AND day = ? AND hour = ? AND providerId = ?")),
    "hourly cleanup should be scoped to one participant/device/day/hour/provider bucket"
  );
  assert.ok(
    statements.some((sql) => sql.startsWith("DELETE FROM usage_daily WHERE participantId = ? AND deviceId = ? AND day = ? AND providerId = ?")),
    "daily serving cleanup should be scoped to the affected participant/device/day/provider"
  );
  assert.ok(
    statements.some((sql) => sql.startsWith("REPLACE INTO usage_sync_buckets_hourly")),
    "hourly bucket metadata should be updated"
  );
  console.log("  testMysqlHourlyIncrementalSyncScopesDeletes passed");
}

async function testMysqlLoadSkipsUsageMirrors() {
  const store = new MySqlStore({});
  const queries = [];
  store.pool = {
    async query(sql) {
      queries.push(String(sql).replace(/\s+/g, " ").trim());
      if (String(sql).includes("FROM participants")) return [[{
        id: "p_mysql_load",
        nickname: "mysql-load",
        avatarColor: "#000",
        identityPublicKey: "pk",
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        lastSeenAt: "2026-05-14T00:00:00.000Z"
      }]];
      if (String(sql).includes("FROM devices")) return [[]];
      if (String(sql).includes("FROM workdirs")) return [[]];
      if (String(sql).includes("FROM model_prices")) return [[]];
      if (String(sql).includes("FROM model_price_aliases")) return [[]];
      if (String(sql).includes("FROM model_price_cache_meta")) return [[]];
      if (String(sql).includes("FROM model_price_cache")) return [[]];
      throw new Error(`unexpected query: ${sql}`);
    }
  };
  await store.load();
  assert.equal(queries.some((sql) => /SELECT \* FROM usage_daily/.test(sql)), false);
  assert.equal(queries.some((sql) => /SELECT \* FROM usage_hourly/.test(sql)), false);
  assert.equal(queries.some((sql) => /SELECT \* FROM upload_batches/.test(sql)), false);
  assert.equal(Object.keys(store.db.usageDaily).length, 0);
  assert.equal(Object.keys(store.db.usageHourly).length, 0);
  console.log("  testMysqlLoadSkipsUsageMirrors passed");
}

async function testMysqlReadPathUsesRequestScopedRows() {
  const store = new MySqlStore({});
  store.businessDayProvider = () => "2026-05-14";
  store.db.participants = {
    p_mysql_read: {
      id: "p_mysql_read",
      nickname: "mysql-read",
      avatarColor: "#000",
      identityPublicKey: "pk",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
      lastSeenAt: "2026-05-14T00:00:00.000Z"
    }
  };
  const queries = [];
  store.pool = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      if (normalized.includes("JOIN participants") && normalized.includes("GROUP BY u.participantId")) {
        return [[{
          participantId: "p_mysql_read",
          nickname: "mysql-read",
          totalTokens: 15,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          estimatedCostUsd: 0,
          missingPriceTokens: 15,
          knownPriceRows: 0,
          costQualityRank: 2,
          pricingVersion: "",
          pricingSource: ""
        }]];
      }
      if (normalized.includes("GROUP BY u.participantId, u.model")) {
        return [[{
          participantId: "p_mysql_read",
          name: "gpt-5",
          totalTokens: 15,
          estimatedCostUsd: 0,
          missingPriceTokens: 15,
          knownPriceRows: 0,
          costQualityRank: 2,
          pricingVersion: "",
          pricingSource: ""
        }]];
      }
      return [[{
        usageKey: "uk_mysql_read",
        day: "2026-05-14",
        participantId: "p_mysql_read",
        deviceId: "d_mysql_read",
        toolCode: "codex",
        providerId: "codex_local",
        workdirId: "p_mysql_read:h_mysql_read",
        workdirHash: "h_mysql_read",
        workdirDisplayName: "mysql-read-workdir",
        model: "gpt-5",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 15,
        estimatedCostUsd: null,
        costQuality: "",
        pricingVersion: "",
        pricingModel: "",
        pricingSource: "",
        sourceQuality: "exact",
        rawSourceRef: "",
        providerVersion: "",
        parserVersion: "",
        sourceFingerprint: "fp_mysql_read",
        uploadedAt: "2026-05-14T00:00:00.000Z"
      }]];
    }
  };
  const board = await store.publicLeaderboard({ range: "today" });
  assert.equal(board.length, 1);
  assert.equal(board[0].totalTokens, 15);
  assert.equal(queries.length, 2);
  assert.ok(queries[0].sql.includes("JOIN participants"));
  assert.ok(queries[0].sql.includes("GROUP BY u.participantId"));
  assert.equal(queries.some((q) => q.sql.startsWith("SELECT * FROM usage_daily")), false);
  assert.deepEqual(queries[0].params, ["2026-05-14"]);
  assert.equal(Object.keys(store.db.usageDaily).length, 0, "request-scoped rows must not remain resident after the read");
  console.log("  testMysqlReadPathUsesRequestScopedRows passed");
}

async function testMysqlDeleteDeviceDataClearsCloudSyncScopesFromSql() {
  const store = new MySqlStore({});
  store.db.devices = {
    d_mysql_delete: {
      id: "d_mysql_delete",
      participantId: "p_mysql_delete",
      os: "test",
      appVersion: "0.7.0",
      createdAt: "2026-05-14T00:00:00.000Z",
      lastSeenAt: "2026-05-14T00:00:00.000Z"
    }
  };
  const queries = [];
  const conn = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT DISTINCT participantId, day, hour, providerId")) {
        return [[{
          participantId: "p_mysql_delete",
          day: "2026-05-14",
          hour: 10,
          providerId: "cursor_dashboard_usage"
        }], []];
      }
      if (normalized.startsWith("DELETE FROM usage_sync_buckets_hourly WHERE deviceId")) {
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("DELETE FROM usage_sync_buckets_hourly WHERE (participantId")) {
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("DELETE FROM devices WHERE id")) {
        return [{ affectedRows: 1 }, []];
      }
      return [{ affectedRows: 0 }, []];
    }
  };
  store.pool = { getConnection: async () => conn };

  const result = await store.deleteDeviceData("d_mysql_delete");
  assert.equal(result.participantId, "p_mysql_delete");
  assert.equal(result.removed.devices, 1);
  assert.equal(result.removed.usageSyncBucketsHourly, 2);
  assert.deepEqual(result.cloudHourlyScopes, [{
    participantId: "p_mysql_delete",
    day: "2026-05-14",
    hour: 10,
    providerId: "cursor_dashboard_usage"
  }]);
  assert.ok(
    queries.some((q) => q.sql.startsWith("DELETE FROM usage_sync_buckets_hourly WHERE (participantId = ? AND day = ? AND hour = ? AND providerId = ?)")),
    "cloud provider device deletion must clear same-scope sync buckets so remaining devices can reupload"
  );
  assert.equal(store.db.devices.d_mysql_delete, undefined);
  console.log("  testMysqlDeleteDeviceDataClearsCloudSyncScopesFromSql passed");
}

async function testMysqlModelPriceRecalculationIsModelScoped() {
  const store = new MySqlStore({});
  const queries = [];
  store.pool = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT * FROM usage_daily WHERE model IN")) {
        return [[{
          usageKey: "uk_mysql_price",
          day: "2026-05-14",
          participantId: "p_mysql_price",
          deviceId: "d_mysql_price",
          toolCode: "codex",
          providerId: "codex_local",
          workdirId: "p_mysql_price:h_mysql_price",
          workdirHash: "h_mysql_price",
          workdirDisplayName: "mysql-price-workdir",
          model: "gpt-5",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 150,
          estimatedCostUsd: null,
          costQuality: "",
          pricingVersion: "",
          pricingModel: "",
          pricingSource: "",
          sourceQuality: "exact",
          rawSourceRef: "",
          providerVersion: "",
          parserVersion: "",
          sourceFingerprint: "fp_mysql_price",
          uploadedAt: "2026-05-14T00:00:00.000Z"
        }], []];
      }
      return [[], []];
    },
    async getConnection() {
      return {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
        async query(sql, params = []) {
          queries.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
          return [{ affectedRows: 1 }, []];
        }
      };
    }
  };

  const result = await store.upsertModelPrice({
    model: "gpt-5",
    inputCostPerMTok: 1,
    outputCostPerMTok: 2,
    cacheReadCostPerMTok: 0,
    cacheWriteCostPerMTok: 0
  });

  assert.equal(result.recalculated.updated, 1);
  assert.ok(
    queries.some((q) => q.sql.startsWith("SELECT * FROM usage_daily WHERE model IN") && q.params.length === 1 && q.params[0] === "gpt-5"),
    "price recalculation should load only affected model rows"
  );
  assert.ok(
    queries.some((q) => q.sql.startsWith("INSERT INTO usage_daily") && q.sql.includes("ON DUPLICATE KEY UPDATE")),
    "price recalculation should upsert affected usage rows"
  );
  assert.equal(
    queries.some((q) => q.sql === "DELETE FROM usage_daily"),
    false,
    "price recalculation must not wipe usage_daily"
  );
  console.log("  testMysqlModelPriceRecalculationIsModelScoped passed");
}

async function testMysqlFullPriceRecalculationUsesBatches() {
  const store = new MySqlStore({});
  store.db.modelPrices = {
    "gpt-5": {
      model: "gpt-5",
      inputCostPerMTok: 1,
      outputCostPerMTok: 2,
      cacheReadCostPerMTok: 0,
      cacheWriteCostPerMTok: 0,
      reasoningCostPerMTok: 0,
      source: "custom",
      notes: "",
      updatedAt: "2026-05-14T00:00:00.000Z"
    }
  };
  const queries = [];
  let batchSelects = 0;
  store.pool = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT * FROM usage_daily WHERE usageKey > ?")) {
        batchSelects += 1;
        if (batchSelects > 1) return [[], []];
        return [[{
          usageKey: "uk_mysql_recalc",
          day: "2026-05-14",
          participantId: "p_mysql_recalc",
          deviceId: "d_mysql_recalc",
          toolCode: "codex",
          providerId: "codex_local",
          workdirId: "p_mysql_recalc:h_mysql_recalc",
          workdirHash: "h_mysql_recalc",
          workdirDisplayName: "mysql-recalc-workdir",
          model: "gpt-5",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 150,
          estimatedCostUsd: null,
          costQuality: "",
          pricingVersion: "",
          pricingModel: "",
          pricingSource: "",
          sourceQuality: "exact",
          rawSourceRef: "",
          providerVersion: "",
          parserVersion: "",
          sourceFingerprint: "fp_mysql_recalc",
          uploadedAt: "2026-05-14T00:00:00.000Z"
        }], []];
      }
      throw new Error(`unexpected query: ${normalized}`);
    },
    async getConnection() {
      return {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
        async query(sql, params = []) {
          queries.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
          return [{ affectedRows: 1 }, []];
        }
      };
    }
  };

  const result = await store.recalculateCosts({ batchSize: 1 });
  assert.equal(result.updated, 1);
  assert.equal(batchSelects, 2);
  assert.ok(
    queries.some((q) => q.sql.startsWith("INSERT INTO usage_daily") && q.sql.includes("ON DUPLICATE KEY UPDATE")),
    "batched recalculation should upsert recalculated rows"
  );
  assert.equal(
    queries.some((q) => q.sql === "SELECT * FROM usage_daily" || q.sql === "DELETE FROM usage_daily"),
    false,
    "full price recalculation must not load or rewrite the full usage table"
  );
  console.log("  testMysqlFullPriceRecalculationUsesBatches passed");
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
  const staticRelease = releaseDistributionFromEnv({
    RELEASE_SOURCE: "static",
    RELEASE_PUBLIC_BASE_URL: "https://cdn.example/ai-token-league"
  });
  assert.equal(staticRelease.releasePath, "tauri-releases");
  assert.equal(staticRelease.tauriUpdateUrl, "https://cdn.example/ai-token-league/tauri-releases/tauri-update.json");
  assert.equal(staticRelease.installerUrl, "https://cdn.example/ai-token-league/tauri-releases/installer.json");
  const ossRelease = releaseConfigFromEnv({
    RELEASE_PUBLIC_BASE_URL: "https://cdn.example/ai-token-league",
    RELEASE_RELEASE_PATH: "desktop-updates",
    RELEASE_REQUIRED_PLATFORMS: "darwin-arm64,win32-x64"
  });
  assert.equal(ossRelease.manifestPath, "desktop-updates/latest.json");
  assert.deepEqual(ossRelease.requiredPlatforms, ["darwin-arm64", "win32-x64"]);
  assert.equal(githubReleaseApiUrl({
    repository: "SKYhuangjing/ai-token-league",
    tag: "v0.6.3"
  }), "https://api.github.com/repos/SKYhuangjing/ai-token-league/releases/tags/v0.6.3");
  assert.equal(githubReleaseApiUrl({
    repository: "SKYhuangjing/ai-token-league",
    releaseId: "123456"
  }), "https://api.github.com/repos/SKYhuangjing/ai-token-league/releases/123456");
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
  assert.equal(Object.keys(validateInstallerMetadata({
    platforms: {
      "darwin-arm64": installerMetadata.platforms["darwin-arm64"],
      "win32-x64": installerMetadata.platforms["win32-x64"]
    }
  }, { publicBaseUrl: "https://cdn.example", requiredPlatforms: ["darwin-arm64", "win32-x64"] })).length, 2);
  assert.deepEqual(installerMetadataPlatforms({
    platforms: {
      "darwin-arm64": installerMetadata.platforms["darwin-arm64"],
      "darwin-x64": installerMetadata.platforms["darwin-x64"],
      "win32-x64": installerMetadata.platforms["win32-x64"]
    }
  }), ["darwin-arm64", "darwin-x64", "win32-x64"]);
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

async function testBuildGithubTauriUpdateJsonUsesReleaseId() {
  const releaseId = "123456";
  const output = path.join(tmp, "mock-latest.json");
  const server = http.createServer((req, res) => {
    if (req.url === `/repos/SKYhuangjing/ai-token-league/releases/${releaseId}`) {
      const base = `http://127.0.0.1:${server.address().port}`;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: Number(releaseId),
        tag_name: "untagged-draft",
        name: "AI Token League 0.6.3",
        html_url: "https://github.com/SKYhuangjing/ai-token-league/releases/tag/untagged-draft",
        created_at: "2026-05-16T00:00:00Z",
        assets: [
          { name: "AI Token League_0.6.3_darwin_aarch64.app.tar.gz", browser_download_url: `${base}/download/untagged/mac-arm64` },
          { name: "AI Token League_0.6.3_darwin_aarch64.app.tar.gz.sig", url: `${base}/asset/sig/mac-arm64`, browser_download_url: `${base}/download/untagged/mac-arm64.sig` },
          { name: "AI Token League_0.6.3_darwin_x64.app.tar.gz", browser_download_url: `${base}/download/untagged/mac-x64` },
          { name: "AI Token League_0.6.3_darwin_x64.app.tar.gz.sig", url: `${base}/asset/sig/mac-x64`, browser_download_url: `${base}/download/untagged/mac-x64.sig` },
          { name: "AI Token League_0.6.3_windows_x64-setup.exe", browser_download_url: `${base}/download/untagged/win` },
          { name: "AI Token League_0.6.3_windows_x64-setup.exe.sig", url: `${base}/asset/sig/win`, browser_download_url: `${base}/download/untagged/win.sig` },
          { name: "AI Token League_0.6.3_linux_amd64.AppImage", browser_download_url: `${base}/download/untagged/linux` },
          { name: "AI Token League_0.6.3_linux_amd64.AppImage.sig", url: `${base}/asset/sig/linux`, browser_download_url: `${base}/download/untagged/linux.sig` }
        ]
      }));
      return;
    }
    if (req.url?.startsWith("/asset/sig/")) {
      res.setHeader("content-type", "text/plain");
      res.end(`signature-${req.url.slice("/asset/sig/".length)}`);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const apiBaseUrl = `http://127.0.0.1:${server.address().port}`;
    await runNodeScript([
      "scripts/build-github-tauri-update-json.js",
      "--repo", "SKYhuangjing/ai-token-league",
      "--release-id", releaseId,
      "--tag", "v0.6.3",
      "--api-base-url", apiBaseUrl,
      "--output", output
    ]);
    const latest = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(latest.version, "0.6.3");
    assert.equal(latest.notes, "https://github.com/SKYhuangjing/ai-token-league/releases/tag/v0.6.3");
    assert.equal(latest.platforms["darwin-aarch64"].signature, "signature-mac-arm64");
    assert.equal(
      latest.platforms["darwin-aarch64"].url,
      "https://github.com/SKYhuangjing/ai-token-league/releases/download/v0.6.3/AI%20Token%20League_0.6.3_darwin_aarch64.app.tar.gz"
    );
    assert.equal(latest.platforms["windows-x86_64"].signature, "signature-win");
    assert.equal(latest.platforms["linux-x86_64"].signature, "signature-linux");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testPublishReleaseFinalizeKeepsAllChecksums() {
  const version = "9.9.9";
  const shaA = "a".repeat(64);
  const shaB = "b".repeat(64);
  const shaC = "c".repeat(64);
  const parts = {
    "darwin-arm64": releasePart(version, "darwin-arm64", "AI Token League-darwin-arm64.app.tar.gz", "AI Token League-darwin-arm64.dmg", shaA),
    "darwin-x64": releasePart(version, "darwin-x64", "AI Token League-darwin-x64.app.tar.gz", "AI Token League-darwin-x64.dmg", shaB),
    "win32-x64": releasePart(version, "win32-x64", "AI Token League_9.9.9_x64-setup.exe", "AI Token League_9.9.9_x64-setup.exe", shaC)
  };
  const server = http.createServer((req, res) => {
    const fileName = path.basename(new URL(req.url || "/", "http://127.0.0.1").pathname);
    const platform = fileName.endsWith(".json") ? fileName.slice(0, -".json".length) : "";
    if (!parts[platform]) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(parts[platform]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const publicBaseUrl = `http://127.0.0.1:${server.address().port}`;
    for (const part of Object.values(parts)) {
      part.updaterArtifact.url = `${publicBaseUrl}/tauri-releases/${version}/${encodeURIComponent(part.updaterArtifact.fileName)}`;
      part.installerArtifact.url = `${publicBaseUrl}/tauri-releases/${version}/${encodeURIComponent(part.installerArtifact.fileName)}`;
    }
    const envFile = path.join(tmp, "publish-release-finalize.env");
    fs.writeFileSync(envFile, [
      `RELEASE_PUBLIC_BASE_URL=${publicBaseUrl}`,
      "RELEASE_RELEASE_PATH=tauri-releases",
      "RELEASE_OSS_ENDPOINT=oss.example.com",
      "RELEASE_OSS_BUCKET=test-bucket",
      "RELEASE_OSS_PREFIX=ai-token-league",
      "RELEASE_REQUIRED_PLATFORMS=darwin-arm64,darwin-x64,win32-x64"
    ].join("\n"));
    const stdout = await runNodeScript([
      "scripts/publish-release.js",
      "--env", envFile,
      "--version", version,
      "--finalize",
      "--dry-run"
    ]);
    const result = JSON.parse(stdout);
    const checksums = result.uploads.find((item) => item.key.endsWith(`/${version}/checksums.txt`));
    const expected = [
      `${shaA}  AI Token League-darwin-arm64.app.tar.gz`,
      `${shaB}  AI Token League-darwin-x64.app.tar.gz`,
      `${shaC}  AI Token League_9.9.9_x64-setup.exe`,
      `${shaA}  AI Token League-darwin-arm64.dmg`,
      `${shaB}  AI Token League-darwin-x64.dmg`
    ].join("\n") + "\n";
    assert.equal(checksums.size, Buffer.byteLength(expected));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function releasePart(version, platform, updaterFileName, installerFileName, sha256) {
  const artifact = (fileName, ext, signature = "") => ({
    platform,
    tauriPlatform: platform === "darwin-arm64" ? "darwin-aarch64" : platform === "win32-x64" ? "windows-x86_64" : platform,
    fileName,
    ext,
    size: 100,
    sha256,
    signature,
    url: ""
  });
  return {
    schemaVersion: 1,
    version,
    releasePath: "tauri-releases",
    platform,
    updaterArtifact: artifact(updaterFileName, platform === "win32-x64" ? "exe" : "app.tar.gz", `signature-${platform}`),
    installerArtifact: artifact(installerFileName, platform === "win32-x64" ? "exe" : "dmg")
  };
}

async function runNodeScript(args) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) {
    throw new Error(`script failed (${code}): ${args.join(" ")}\n${stdout}${stderr}`);
  }
  return stdout;
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

  const targeted = parseChangelogVersion(`## [0.6.3] - 2026-05-16

### Changed

- [Desktop] Current release.

## [0.6.2] - 2026-05-14

### Fixed

- [Web] Previous release.
`, "0.6.2");
  assert.equal(targeted.version, "0.6.2");
  assert.equal(targeted.sections[0].items[0].text, "Previous release.");

  const prerelease = parseChangelogVersion(`## [0.6.3-test.1] - 2026-05-17

### Fixed

- [Desktop] Test release.
`, "0.6.3-test.1");
  assert.equal(prerelease.version, "0.6.3-test.1");
  assert.equal(prerelease.sections[0].items[0].text, "Test release.");
}

function testDesktopDataProtectionControls() {
  const html = fs.readFileSync("src/desktop/index.html", "utf8");
  const renderer = fs.readFileSync("src/desktop/renderer.js", "utf8");
  const i18n = fs.readFileSync("src/shared/i18n.js", "utf8");

  for (const id of [
    "localBackupRetention",
    "choose-backup-directory",
    "reveal-backup-directory",
    "backup-now",
    "restore-local-backup",
    "clear-local-backups"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing backup control ${id}`);
  }
  assert.match(html, /id="runtimeLogRetentionDays"/);
  assert.match(html, /id="reveal-runtime-log-directory"/);
  assert.match(html, /id="clear-runtime-log"/);
  assert.match(html, /icons\/file-text\.svg/);
  assert.match(html, /id="backup-schedule-copy"/);
  assert.doesNotMatch(html, /backup-recent-list/);
  assert.doesNotMatch(html, /diagnostics-log-size|diagnostics-log-events|diagnostics-log-latest/);
  assert.match(renderer, /restoreLocalBackup/);
  assert.match(renderer, /clearLocalBackups/);
  assert.match(i18n, /"desktop\.backup\.restore": "备份恢复"/);
  assert.match(i18n, /"desktop\.backup\.schedule": "每天 \{time\} 后自动备份数据。"/);
}

function testLocalBackupSchedulerIsIndependent() {
  const lib = fs.readFileSync("src-tauri/src/lib.rs", "utf8");
  assert.match(lib, /fn start_local_backup_scheduler/);
  assert.match(lib, /start_local_backup_scheduler\(app\.handle\(\)\.clone\(\)\)/);
  const refreshStart = lib.indexOf("fn start_background_refresh");
  const refreshEnd = lib.indexOf("fn start_local_backup_scheduler");
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, "missing background refresh or backup scheduler");
  const refreshBody = lib.slice(refreshStart, refreshEnd);
  assert.doesNotMatch(refreshBody, /local-backup:run-due-auto/);
}

async function testReleaseBodyUsesChangelog() {
  const changelog = path.join(tmp, "CHANGELOG-release-body.md");
  const changelogZh = path.join(tmp, "CHANGELOG-release-body.zh-CN.md");
  fs.writeFileSync(changelog, `# Changelog

## [0.6.3] - 2026-05-16

### Changed

- [Desktop] Migrated the desktop collector runtime to Rust.
- Internal build cleanup.

### Fixed

- [Web] Kept legacy daily uploads compatible.
`);
  fs.writeFileSync(changelogZh, `# 更新日志

## [0.6.3] - 2026-05-16

### 变更

- [Desktop] 将桌面采集运行时迁移到 Rust。
- 内部构建清理。

### 修复

- [Web] 保持 legacy daily 上报兼容。
`);
  const output = await runNodeScript([
    "scripts/build-release-body.js",
    "--version", "0.6.3",
    "--changelog", changelog,
    "--changelog-zh", changelogZh
  ]);
  assert.match(output, /AI Token League 0\.6\.3/);
  assert.match(output, /## English/);
  assert.match(output, /## 简体中文/);
  assert.match(output, /Migrated the desktop collector runtime to Rust/);
  assert.match(output, /将桌面采集运行时迁移到 Rust/);
  assert.match(output, /Kept legacy daily uploads compatible/);
  assert.match(output, /保持 legacy daily 上报兼容/);
  assert.doesNotMatch(output, /Internal build cleanup/);
  assert.doesNotMatch(output, /内部构建清理/);
  assert.doesNotMatch(output, /Automated release/);
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
testDeleteDeviceDataKeepsParticipantAndOtherDevices();
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
testDesktopDataProtectionControls();
testLocalBackupSchedulerIsIndependent();
await testReleaseBodyUsesChangelog();
await testVersionCompatibilityAndManifest();
await testBuildGithubTauriUpdateJsonUsesReleaseId();
await testPublishReleaseFinalizeKeepsAllChecksums();
testDisplayAndPricing();
await testOpenRouterRefresh();
// ─── Composition module tests ────────────────────────────────────────────────

function testCompositionRatio() {
  assert.equal(compositionRatio(50, 100), 0.5);
  assert.equal(compositionRatio(0, 100), 0);
  assert.equal(compositionRatio(100, 0), 0);
  assert.equal(compositionRatio(null, 100), 0);
  assert.equal(compositionRatio(100, null), 0);
  assert.equal(compositionRatio(-1, 100), -0.01);
  assert.ok(Math.abs(compositionRatio(1, 3) - 0.3333) < 0.01);
  console.log("  testCompositionRatio passed");
}

function testCreateEmptyComposition() {
  const empty = createEmptyComposition();
  assert.equal(empty.inputTokens, 0);
  assert.equal(empty.outputTokens, 0);
  assert.equal(empty.cacheReadTokens, 0);
  assert.equal(empty.cacheWriteTokens, 0);
  assert.equal(empty.reasoningTokens, 0);
  assert.equal(empty.totalTokens, 0);
  console.log("  testCreateEmptyComposition passed");
}

function testMergeTokenComposition() {
  const target = createEmptyComposition();
  mergeTokenComposition(target, { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  assert.equal(target.inputTokens, 100);
  assert.equal(target.outputTokens, 50);
  assert.equal(target.totalTokens, 150);

  mergeTokenComposition(target, { inputTokens: 200, outputTokens: 100, totalTokens: 300 });
  assert.equal(target.inputTokens, 300);
  assert.equal(target.outputTokens, 150);
  assert.equal(target.totalTokens, 450);

  const empty = createEmptyComposition();
  mergeTokenComposition(empty, {});
  assert.equal(empty.totalTokens, 0);

  const withCache = createEmptyComposition();
  mergeTokenComposition(withCache, { cacheReadTokens: 80, cacheWriteTokens: 20, totalTokens: 100 });
  assert.equal(withCache.cacheReadTokens, 80);
  assert.equal(withCache.cacheWriteTokens, 20);
  console.log("  testMergeTokenComposition passed");
}

function testDominantComposition() {
  assert.equal(dominantComposition({ inputTokens: 900, outputTokens: 100 }), "input-heavy");
  assert.equal(dominantComposition({ inputTokens: 100, outputTokens: 900 }), "output-heavy");
  assert.equal(dominantComposition({ cacheReadTokens: 500, cacheWriteTokens: 400 }), "cache-heavy");
  assert.equal(dominantComposition({ reasoningTokens: 800 }), "reasoning-heavy");
  assert.equal(dominantComposition({}), "no-usage");
  assert.equal(dominantComposition({ inputTokens: 0, outputTokens: 0 }), "no-usage");
  assert.equal(dominantComposition({ inputTokens: 50, outputTokens: 50, cacheReadTokens: 50, cacheWriteTokens: 50 }), "cache-heavy");
  console.log("  testDominantComposition passed");
}

function testTokenCompositionSummary() {
  const input = tokenCompositionSummary({ inputTokens: 800, outputTokens: 200, totalTokens: 1000 });
  assert.match(input, /输入/);
  assert.match(input, /输出/);
  assert.ok(input.includes("80%"));
  assert.ok(input.includes("20%"));

  const empty = tokenCompositionSummary({ totalTokens: 0 });
  assert.equal(empty, "无构成");

  const withCache = tokenCompositionSummary({ inputTokens: 100, outputTokens: 100, cacheReadTokens: 200, totalTokens: 400 });
  assert.match(withCache, /缓存/);
  console.log("  testTokenCompositionSummary passed");
}

function testTokenCompositionDetails() {
  const item = { inputTokens: 500, outputTokens: 300, totalTokens: 1000 };
  const details = tokenCompositionDetails(item);
  assert.equal(details.length, TOKEN_COMPOSITION_FIELDS.length);
  assert.equal(details[0].field, "inputTokens");
  assert.equal(details[0].tokens, 500);
  assert.ok(Math.abs(details[0].ratio - 0.5) < 0.001);
  console.log("  testTokenCompositionDetails passed");
}

function testCostQualityLabel() {
  assert.equal(costQualityLabel("exact_price"), "精确");
  assert.equal(costQualityLabel("estimated_price"), "预估");
  assert.equal(costQualityLabel("unknown_price"), "缺失价格");
  assert.equal(costQualityLabel(""), "缺失价格");
  assert.equal(costQualityLabel("other"), "缺失价格");
  console.log("  testCostQualityLabel passed");
}

function testCompositionFieldCounts() {
  assert.equal(TOKEN_COMPOSITION_FIELDS.length, 5);
  assert.equal(COST_COMPOSITION_FIELDS.length, 5);
  console.log("  testCompositionFieldCounts passed");
}

// ─── Nickname generator tests ────────────────────────────────────────────────

function testNicknameGenerator() {
  const nick = generateNickname(["快乐猫", "小熊猫", "向日葵"]);
  assert.ok(nick.includes("-"));
  const [noun, suffix] = nick.split("-");
  assert.ok(["快乐猫", "小熊猫", "向日葵"].includes(noun));
  assert.equal(suffix.length, 3);
  assert.match(suffix, /^[A-Z]\d{2}$/);

  const names = loadClientNicknames();
  assert.ok(Array.isArray(names));
  assert.ok(names.length >= 10);

  const withoutArg = generateNickname();
  assert.ok(typeof withoutArg === "string");
  assert.ok(withoutArg.length > 0);

  const nicks = new Set();
  for (let i = 0; i < 200; i++) nicks.add(generateNickname(["测试"]));
  assert.ok(nicks.size > 50, "nickname should have sufficient randomness");
  console.log("  testNicknameGenerator passed");
}

// ─── Preset module tests ─────────────────────────────────────────────────────

function testPresetModule() {
  assert.ok(PRESET_ALLOWED_KEYS.includes("apiBaseUrl"));
  assert.ok(PRESET_ALLOWED_KEYS.includes("language"));
  assert.ok(PRESET_ALLOWED_KEYS.includes("refreshIntervalMinutes"));
  assert.ok(PRESET_ALLOWED_KEYS.includes("providerEnabled"));
  assert.ok(!PRESET_ALLOWED_KEYS.includes("identityPrivateKey"));

  const preset = loadBuildPreset("/nonexistent/path");
  assert.deepEqual(preset, {});

  const presetDir = path.join(tmp, "preset-app");
  const presetAssetDir = path.join(presetDir, "assets");
  fs.mkdirSync(presetAssetDir, { recursive: true });
  fs.writeFileSync(path.join(presetAssetDir, "preset.json"), JSON.stringify({
    apiBaseUrl: "https://example.com",
    language: "en",
    identityPrivateKey: "secret",
    extraKey: "ignored"
  }));
  const loaded = loadBuildPreset(presetDir);
  assert.equal(loaded.apiBaseUrl, "https://example.com");
  assert.equal(loaded.language, "en");
  assert.equal(Object.hasOwn(loaded, "identityPrivateKey"), false);
  assert.equal(Object.hasOwn(loaded, "extraKey"), false);
  console.log("  testPresetModule passed");
}

// ─── Schema module extended tests ────────────────────────────────────────────

function testSchemaNormalizeTokenNumber() {
  assert.equal(normalizeTokenNumber(100), 100);
  assert.equal(normalizeTokenNumber(100.7), 101);
  assert.equal(normalizeTokenNumber(0), 0);
  assert.equal(normalizeTokenNumber(-5), 0);
  assert.equal(normalizeTokenNumber(null), 0);
  assert.equal(normalizeTokenNumber(undefined), 0);
  assert.equal(normalizeTokenNumber("100"), 100);
  assert.equal(normalizeTokenNumber(NaN), 0);
  assert.equal(normalizeTokenNumber(Infinity), 0);
  console.log("  testSchemaNormalizeTokenNumber passed");
}

function testSchemaDisplayTotalTokens() {
  assert.equal(displayTotalTokens({ inputTokens: 100, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 25 }), 375);
  assert.equal(displayTotalTokens({}), 0);
  assert.equal(displayTotalTokens({ inputTokens: 100 }), 100);
  assert.equal(displayTotalTokens({ inputTokens: 100, reasoningTokens: 50 }), 100);
  console.log("  testSchemaDisplayTotalTokens passed");
}

function testSchemaPrimaryTokenTotal() {
  assert.equal(primaryTokenTotal({ inputTokens: 100, outputTokens: 200 }), 300);
  assert.equal(primaryTokenTotal({}), 0);
  assert.equal(primaryTokenTotal({ inputTokens: 100 }), 100);
  console.log("  testSchemaPrimaryTokenTotal passed");
}

function testSchemaUsageKey() {
  const item = { day: "2026-05-14", toolCode: "codex", providerId: "codex_local", workdirHash: "hash1", model: "gpt-5" };
  const key = usageKey(item, "p_1", "d_1");
  assert.equal(key, "2026-05-14|p_1|d_1|codex|codex_local|hash1|gpt-5");
  console.log("  testSchemaUsageKey passed");
}

function testSchemaHourlyUsageKey() {
  const item = { day: "2026-05-14", hour: 10, toolCode: "codex", providerId: "codex_local", workdirHash: "hash1", model: "gpt-5" };
  const key = hourlyUsageKey(item, "p_1", "d_1");
  assert.equal(key, "2026-05-14|10|p_1|d_1|codex|codex_local|hash1|gpt-5");
  const noHour = hourlyUsageKey({ day: "2026-05-14", toolCode: "codex", providerId: "codex_local", workdirHash: "hash1", model: "gpt-5" }, "p_1", "d_1");
  assert.ok(noHour.includes("|0|"));
  console.log("  testSchemaHourlyUsageKey passed");
}

function testSchemaPublicUsageItem() {
  const raw = {
    day: "2026-05-14", toolCode: "codex", providerId: "codex_local",
    workdirHash: "hash1", workdirDisplayName: "my-project",
    model: "gpt-5", inputTokens: 100.7, outputTokens: 200,
    cacheReadTokens: 50, cacheWriteTokens: 25, reasoningTokens: 10,
    totalTokens: 386, sourceQuality: "exact",
    rawSourceRef: "session.jsonl", providerVersion: "0.1", parserVersion: "0.1",
    sourceFingerprint: "fp_1"
  };
  const pub = publicUsageItem(raw);
  assert.equal(pub.inputTokens, 101);
  assert.equal(pub.outputTokens, 200);
  assert.equal(pub.totalTokens, 376);
  assert.equal(pub.sourceQuality, "exact");
  assert.equal(Object.hasOwn(pub, "prompt"), false);

  const minimal = publicUsageItem({ day: "2026-05-14", toolCode: "codex", providerId: "codex_local", workdirHash: "h", workdirDisplayName: "p", model: "m" });
  assert.equal(minimal.sourceQuality, "unknown");
  assert.equal(minimal.hour, 0);
  console.log("  testSchemaPublicUsageItem passed");
}

function testSchemaAssertUsageItem() {
  assert.doesNotThrow(() => assertUsageItem({
    day: "2026-05-14", toolCode: "codex", providerId: "codex_local",
    workdirHash: "h", workdirDisplayName: "p", model: "m",
    totalTokens: 100, sourceQuality: "exact"
  }));
  assert.throws(() => assertUsageItem({ day: "2026-05-14", toolCode: "codex", providerId: "codex_local", workdirHash: "h", workdirDisplayName: "p", model: "m", totalTokens: 100, sourceQuality: "bad" }), /invalid sourceQuality/);
  assert.throws(() => assertUsageItem({ toolCode: "codex", providerId: "codex_local", workdirHash: "h", workdirDisplayName: "p", model: "m", totalTokens: 100, sourceQuality: "exact" }), /missing day/);
  assert.throws(() => assertUsageItem({ day: "2026-05-14", toolCode: "codex", providerId: "codex_local", workdirHash: "h", workdirDisplayName: "p", model: "m", totalTokens: -1, sourceQuality: "exact" }), /invalid totalTokens/);
  assert.throws(() => assertUsageItem({ day: "2026-05-14", toolCode: "codex", providerId: "codex_local", workdirHash: "h", workdirDisplayName: "p", model: "m", totalTokens: 100, sourceQuality: "exact", prompt: "secret" }), /forbidden/);
  console.log("  testSchemaAssertUsageItem passed");
}

function testSchemaSourceQuality() {
  assert.equal(SOURCE_QUALITY.size, 5);
  assert.ok(SOURCE_QUALITY.has("exact"));
  assert.ok(SOURCE_QUALITY.has("partial"));
  assert.ok(SOURCE_QUALITY.has("estimated"));
  assert.ok(SOURCE_QUALITY.has("imported"));
  assert.ok(SOURCE_QUALITY.has("unknown"));
  console.log("  testSchemaSourceQuality passed");
}

function testSchemaForbiddenFields() {
  assert.ok(FORBIDDEN_UPLOAD_FIELDS.has("prompt"));
  assert.ok(FORBIDDEN_UPLOAD_FIELDS.has("identityPrivateKey"));
  assert.ok(FORBIDDEN_UPLOAD_FIELDS.has("assistantResponse"));
  assert.ok(FORBIDDEN_UPLOAD_FIELDS.has("fullTranscript"));
  assert.ok(FORBIDDEN_UPLOAD_FIELDS.has("absolutePath"));
  assert.ok(FORBIDDEN_UPLOAD_FIELDS.has("localPath"));
  assert.ok(FORBIDDEN_UPLOAD_FIELDS.has("access_token"));
  assert.ok(FORBIDDEN_UPLOAD_FIELDS.has("refresh_token"));
  assert.ok(FORBIDDEN_UPLOAD_FIELDS.has("cookie"));
  assert.ok(FORBIDDEN_UPLOAD_FIELDS.has("sourceFileContent"));
  assert.ok(FORBIDDEN_UPLOAD_FIELDS.has("workosSessionToken"));
  assert.ok(FORBIDDEN_UPLOAD_FIELDS.has("cursor_auth_raw"));
  assert.ok(FORBIDDEN_UPLOAD_FIELDS.has("cursor_usage_raw"));
  assert.ok(FORBIDDEN_UPLOAD_FIELDS.has("content"));
  console.log("  testSchemaForbiddenFields passed");
}

// ─── HTTP API server-level tests ─────────────────────────────────────────────

async function createTestServer(envOverrides = {}) {
  const dbPath = path.join(tmp, `db-api-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const saved = {};
  const envKeys = ["DB_PATH", "ADMIN_USERNAME", "ADMIN_PASSWORD", "BOARD_SECURITY_LEVEL", "BOARD_ANONYMIZATION_SALT", "PUBLIC_BOARD_AUTH_USERNAME", "PUBLIC_BOARD_AUTH_PASSWORD", "OPENROUTER_PRICING_AUTO_REFRESH"];
  for (const key of envKeys) saved[key] = process.env[key];
  process.env.DB_PATH = dbPath;
  process.env.OPENROUTER_PRICING_AUTO_REFRESH = "false";
  if (envOverrides.ADMIN_USERNAME !== undefined) process.env.ADMIN_USERNAME = envOverrides.ADMIN_USERNAME;
  else delete process.env.ADMIN_USERNAME;
  if (envOverrides.ADMIN_PASSWORD !== undefined) process.env.ADMIN_PASSWORD = envOverrides.ADMIN_PASSWORD;
  else delete process.env.ADMIN_PASSWORD;
  if (envOverrides.BOARD_SECURITY_LEVEL) process.env.BOARD_SECURITY_LEVEL = envOverrides.BOARD_SECURITY_LEVEL;
  else delete process.env.BOARD_SECURITY_LEVEL;
  if (envOverrides.BOARD_ANONYMIZATION_SALT) process.env.BOARD_ANONYMIZATION_SALT = envOverrides.BOARD_ANONYMIZATION_SALT;
  else delete process.env.BOARD_ANONYMIZATION_SALT;
  if (envOverrides.PUBLIC_BOARD_AUTH_USERNAME) process.env.PUBLIC_BOARD_AUTH_USERNAME = envOverrides.PUBLIC_BOARD_AUTH_USERNAME;
  else delete process.env.PUBLIC_BOARD_AUTH_USERNAME;
  if (envOverrides.PUBLIC_BOARD_AUTH_PASSWORD) process.env.PUBLIC_BOARD_AUTH_PASSWORD = envOverrides.PUBLIC_BOARD_AUTH_PASSWORD;
  else delete process.env.PUBLIC_BOARD_AUTH_PASSWORD;
  const nonce = Date.now();
  const { createServer } = await import(`../src/backend/server.js?api-test-${nonce}=${nonce}`);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const cleanup = async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  return { server, port, baseUrl, cleanup, dbPath };
}

async function testHealthEndpoint() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.serverVersion);
    assert.ok(body.serverProtocolVersion);
    assert.ok(body.serverTime);
    assert.ok(body.compatibility);
    assert.ok(body.compatibility.status);
    console.log("  testHealthEndpoint passed");
  } finally { await cleanup(); }
}

async function testDeviceRegistrationEndpoint() {
  const { baseUrl, cleanup, dbPath } = await createTestServer();
  try {
    const identity = generateIdentity();
    const regRes = await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId,
        deviceId: newId("d"),
        nickname: "reg-test",
        identityPublicKey: identity.identityPublicKey,
        os: "test",
        appVersion: APP_VERSION,
        networkInfo: { lanIps: ["192.168.1.8", "10.0.0.2"] }
      })
    });
    assert.equal(regRes.status, 200);
    const regBody = await regRes.json();
    assert.ok(regBody.deviceId);
    assert.ok(regBody.compatibility);
    const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    assert.equal(db.devices[regBody.deviceId].lanIp, "192.168.1.8, 10.0.0.2");

    const dupRes = await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId,
        deviceId: newId("d2"),
        nickname: "reg-test",
        identityPublicKey: identity.identityPublicKey,
        os: "test",
        appVersion: APP_VERSION
      })
    });
    assert.equal(dupRes.status, 200);

    const badRes = await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(badRes.status, 500);
    console.log("  testDeviceRegistrationEndpoint passed");
  } finally { await cleanup(); }
}

async function testUsageUploadEndpointSignatureVerification() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const identity = generateIdentity();
    const deviceId = newId("d");
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId, deviceId, nickname: "sig-test",
        identityPublicKey: identity.identityPublicKey, os: "test", appVersion: APP_VERSION
      })
    });
    const payload = {
      participantId: identity.participantId, deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: [{
        day: localDay(), toolCode: "codex", providerId: "codex_local",
        workdirHash: "wd_sig", workdirDisplayName: "sig-project",
        model: "gpt-5", inputTokens: 100, outputTokens: 50,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        totalTokens: 150, sourceQuality: "exact", sourceFingerprint: "sf_sig"
      }]
    };
    const signature = signPayload(identity.identityPrivateKey, payload);
    const validRes = await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, signature })
    });
    assert.equal(validRes.status, 200);
    const validBody = await validRes.json();
    assert.equal(validBody.accepted, 1);

    const invalidSigRes = await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, signature: "invalid-signature" })
    });
    assert.equal(invalidSigRes.status, 401);
    assert.equal((await invalidSigRes.json()).error, "invalid signature");

    const nullSnapshotRes = await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, snapshot: null, signature: "invalid-signature" })
    });
    assert.equal(nullSnapshotRes.status, 401);
    assert.equal((await nullSnapshotRes.json()).error, "invalid signature");

    const noSigRes = await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    assert.equal(noSigRes.status, 401);
    console.log("  testUsageUploadEndpointSignatureVerification passed");
  } finally { await cleanup(); }
}

async function testUsageBatchUploadEndpoint() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const identity = generateIdentity();
    const deviceId = newId("d");
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId, deviceId, nickname: "batch-test",
        identityPublicKey: identity.identityPublicKey, os: "test", appVersion: APP_VERSION
      })
    });

    const hour10 = makeHourlySnapshotPayload([
      makeSnapshotItem({ hour: 10, workdirHash: "batch_h10", sourceFingerprint: "batch_sf_10" })
    ], identity.participantId, deviceId, { hour: 10 });
    const hour11 = makeHourlySnapshotPayload([
      makeSnapshotItem({ hour: 11, workdirHash: "batch_h11", sourceFingerprint: "batch_sf_11" })
    ], identity.participantId, deviceId, { hour: 11 });
    const payload = {
      participantId: identity.participantId,
      deviceId,
      clientGeneratedAt: new Date().toISOString(),
      batches: [
        { snapshot: hour10.snapshot, items: hour10.items },
        { snapshot: hour11.snapshot, items: hour11.items }
      ]
    };
    const signature = signPayload(identity.identityPrivateKey, payload);
    const res = await fetch(`${baseUrl}/api/usage/daily-batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, signature })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.bucketCount, 2);
    assert.equal(body.accepted, 2);
    assert.equal(body.rejected, 0);

    const duplicateRes = await fetch(`${baseUrl}/api/usage/daily-batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, signature })
    });
    assert.equal(duplicateRes.status, 200);
    const duplicateBody = await duplicateRes.json();
    assert.equal(duplicateBody.noOpBucketCount, 2);

    const invalidSigRes = await fetch(`${baseUrl}/api/usage/daily-batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, signature: "invalid-signature" })
    });
    assert.equal(invalidSigRes.status, 401);
    console.log("  testUsageBatchUploadEndpoint passed");
  } finally { await cleanup(); }
}

async function testUsageUploadRejectsUnregistered() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const identity = generateIdentity();
    const payload = {
      participantId: identity.participantId, deviceId: newId("d"),
      clientGeneratedAt: new Date().toISOString(),
      items: [{ day: localDay(), toolCode: "codex", providerId: "codex_local", workdirHash: "h", workdirDisplayName: "p", model: "m", totalTokens: 100, sourceQuality: "exact", sourceFingerprint: "sf" }]
    };
    const res = await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, signature: signPayload(identity.identityPrivateKey, payload) })
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "participant is not registered");
    console.log("  testUsageUploadRejectsUnregistered passed");
  } finally { await cleanup(); }
}

async function testAdminAuthEnforcement() {
  const { baseUrl, cleanup } = await createTestServer({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "secret" });
  try {
    const noAuthRes = await fetch(`${baseUrl}/api/admin/usage`);
    assert.equal(noAuthRes.status, 401);

    const badAuthRes = await fetch(`${baseUrl}/api/admin/usage`, {
      headers: { authorization: `Basic ${Buffer.from("admin:wrong").toString("base64")}` }
    });
    assert.equal(badAuthRes.status, 401);

    const goodAuthRes = await fetch(`${baseUrl}/api/admin/usage`, {
      headers: { authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` }
    });
    assert.equal(goodAuthRes.status, 200);

    const adminHtmlNoAuth = await fetch(`${baseUrl}/admin.html`);
    assert.equal(adminHtmlNoAuth.status, 401);

    const adminHtmlAuth = await fetch(`${baseUrl}/admin.html`, {
      headers: { authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` }
    });
    assert.equal(adminHtmlAuth.status, 200);
    console.log("  testAdminAuthEnforcement passed");
  } finally { await cleanup(); }
}

async function testAdminAuthDisabledWhenNotConfigured() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/admin/usage`);
    assert.equal(res.status, 200);
    console.log("  testAdminAuthDisabledWhenNotConfigured passed");
  } finally { await cleanup(); }
}

async function testBoardPublicMode() {
  const { baseUrl, cleanup } = await createTestServer({ BOARD_SECURITY_LEVEL: "public" });
  try {
    const identity = generateIdentity();
    const deviceId = newId("d");
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId, deviceId, nickname: "board-pub",
        identityPublicKey: identity.identityPublicKey, os: "test", appVersion: APP_VERSION
      })
    });
    const payload = {
      participantId: identity.participantId, deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: [{ day: localDay(), toolCode: "codex", providerId: "codex_local", workdirHash: "h", workdirDisplayName: "p", model: "gpt-5", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 150, sourceQuality: "exact", sourceFingerprint: "sf_bp" }]
    };
    await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, signature: signPayload(identity.identityPrivateKey, payload) })
    });

    const lbRes = await fetch(`${baseUrl}/api/board/leaderboard?period=today`);
    assert.equal(lbRes.status, 200);
    const lb = await lbRes.json();
    assert.equal(lb.identityMode, "public");
    assert.equal(lb.identityLabel, "nickname");
    assert.equal(lb.items[0].displayName, "board-pub");

    const summaryRes = await fetch(`${baseUrl}/api/board/summary`);
    assert.equal(summaryRes.status, 200);
    const summary = await summaryRes.json();
    assert.equal(summary.identityMode, "public");
    assert.ok(summary.todayTokens >= 150);

    const idRes = await fetch(`${baseUrl}/api/board/my-identity?participantId=${identity.participantId}`);
    assert.equal(idRes.status, 200);
    const idBody = await idRes.json();
    assert.equal(idBody.identityMode, "public");
    console.log("  testBoardPublicMode passed");
  } finally { await cleanup(); }
}

async function testBoardAuthenticatedMode() {
  const { baseUrl, cleanup } = await createTestServer({
    BOARD_SECURITY_LEVEL: "authenticated",
    PUBLIC_BOARD_AUTH_USERNAME: "boarduser",
    PUBLIC_BOARD_AUTH_PASSWORD: "boardpass"
  });
  try {
    const noAuthRes = await fetch(`${baseUrl}/api/board/leaderboard?period=today`);
    assert.equal(noAuthRes.status, 401);

    const authRes = await fetch(`${baseUrl}/api/board/leaderboard?period=today`, {
      headers: { authorization: `Basic ${Buffer.from("boarduser:boardpass").toString("base64")}` }
    });
    assert.equal(authRes.status, 200);

    const noAuthHtml = await fetch(`${baseUrl}/leaderboard.html`);
    assert.equal(noAuthHtml.status, 401);

    const authHtml = await fetch(`${baseUrl}/leaderboard.html`, {
      headers: { authorization: `Basic ${Buffer.from("boarduser:boardpass").toString("base64")}` }
    });
    assert.equal(authHtml.status, 200);
    console.log("  testBoardAuthenticatedMode passed");
  } finally { await cleanup(); }
}

async function testSelfServiceDeletionReplayProtection() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const identity = generateIdentity();
    const deviceId = newId("d");
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId, deviceId, nickname: "del-test",
        identityPublicKey: identity.identityPublicKey, os: "test", appVersion: APP_VERSION
      })
    });
    const payload = { participantId: identity.participantId, deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: [{ day: localDay(), toolCode: "codex", providerId: "codex_local", workdirHash: "h", workdirDisplayName: "p", model: "gpt-5", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 150, sourceQuality: "exact", sourceFingerprint: "sf_del" }]
    };
    await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, signature: signPayload(identity.identityPrivateKey, payload) })
    });

    const freshTs = new Date().toISOString();
    const delPayload = { participantId: identity.participantId, timestamp: freshTs };
    const delSig = signPayload(identity.identityPrivateKey, delPayload);
    const delRes = await fetch(`${baseUrl}/api/participant/data`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...delPayload, signature: delSig })
    });
    assert.equal(delRes.status, 200);
    assert.equal((await delRes.json()).deleted, true);

    const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const oldPayload = { participantId: identity.participantId, timestamp: oldTs };
    const oldSig = signPayload(identity.identityPrivateKey, oldPayload);
    const oldRes = await fetch(`${baseUrl}/api/participant/data`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...oldPayload, signature: oldSig })
    });
    assert.equal(oldRes.status, 401);
    assert.equal((await oldRes.json()).error, "timestamp is too old or invalid");

    const missingFields = await fetch(`${baseUrl}/api/participant/data`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participantId: identity.participantId })
    });
    assert.equal(missingFields.status, 400);
    console.log("  testSelfServiceDeletionReplayProtection passed");
  } finally { await cleanup(); }
}

async function testLeaderboardEndpoint() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/leaderboard?range=today&tool=all`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.items));
    assert.equal(body.tool, "all");
    console.log("  testLeaderboardEndpoint passed");
  } finally { await cleanup(); }
}

async function testBoardParticipantDetailAndTrend() {
  const { baseUrl, cleanup } = await createTestServer({ BOARD_SECURITY_LEVEL: "public" });
  try {
    const identity = generateIdentity();
    const deviceId = newId("d");
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId, deviceId, nickname: "detail-test",
        identityPublicKey: identity.identityPublicKey, os: "test", appVersion: APP_VERSION
      })
    });
    const payload = {
      participantId: identity.participantId, deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: [{ day: localDay(), toolCode: "codex", providerId: "codex_local", workdirHash: "h", workdirDisplayName: "p", model: "gpt-5", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 150, sourceQuality: "exact", sourceFingerprint: "sf_dt" }]
    };
    await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, signature: signPayload(identity.identityPrivateKey, payload) })
    });

    const detailRes = await fetch(`${baseUrl}/api/board/participants/${identity.participantId}?period=today`);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.rank, 1);
    assert.ok(detail.models.length >= 1);

    const trendRes = await fetch(`${baseUrl}/api/board/participants/${identity.participantId}/trend?grain=week&range=last30`);
    assert.equal(trendRes.status, 200);
    const trend = await trendRes.json();
    assert.ok(trend.items.length >= 1);

    const missingRes = await fetch(`${baseUrl}/api/board/participants/p_missing?period=today`);
    assert.equal(missingRes.status, 404);
    console.log("  testBoardParticipantDetailAndTrend passed");
  } finally { await cleanup(); }
}

async function testModelPricesPublicEndpoint() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/model-prices`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.custom !== undefined);
    assert.ok(body.openrouter !== undefined);
    assert.ok(body.aliases !== undefined);
    console.log("  testModelPricesPublicEndpoint passed");
  } finally { await cleanup(); }
}

async function testAdminCrudViaHttp() {
  const { baseUrl, cleanup } = await createTestServer({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "secret" });
  const auth = { authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` };
  try {
    const identity = generateIdentity();
    const deviceId = newId("d");
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId,
        deviceId,
        nickname: "admin-device-reset",
        identityPublicKey: identity.identityPublicKey,
        os: "test",
        appVersion: APP_VERSION
      })
    });

    const devicesRes = await fetch(`${baseUrl}/api/admin/devices`, { headers: auth });
    assert.equal(devicesRes.status, 200);
    const devices = await devicesRes.json();
    assert.ok(devices.some((item) => item.deviceId === deviceId));

    const deleteDeviceRes = await fetch(`${baseUrl}/api/admin/devices/${encodeURIComponent(deviceId)}/data`, {
      method: "DELETE", headers: auth
    });
    assert.equal(deleteDeviceRes.status, 200);
    const deleteDeviceBody = await deleteDeviceRes.json();
    assert.equal(deleteDeviceBody.deviceId, deviceId);
    assert.equal(deleteDeviceBody.removed.devices, 1);

    const qualityRes = await fetch(`${baseUrl}/api/admin/quality?range=month`, { headers: auth });
    assert.equal(qualityRes.status, 200);

    const priceRes = await fetch(`${baseUrl}/api/admin/model-prices`, { headers: auth });
    assert.equal(priceRes.status, 200);

    const upsertRes = await fetch(`${baseUrl}/api/admin/model-prices`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ model: "http-test-model", inputCostPerMTok: 1, outputCostPerMTok: 2 })
    });
    const upsertBody = await upsertRes.json();
    assert.equal(upsertRes.status, 200, `upsert model price: ${JSON.stringify(upsertBody)}`);
    assert.equal(upsertBody.price.model, "http-test-model");

    const aliasRes = await fetch(`${baseUrl}/api/admin/model-price-aliases`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ model: "alias-test", targetModel: "http-test-model" })
    });
    assert.equal(aliasRes.status, 200);

    const delAliasRes = await fetch(`${baseUrl}/api/admin/model-price-aliases/alias-test`, {
      method: "DELETE", headers: auth
    });
    assert.equal(delAliasRes.status, 200);
    assert.equal((await delAliasRes.json()).deleted, true);

    const recalcRes = await fetch(`${baseUrl}/api/admin/recalculate-costs`, {
      method: "POST", headers: auth
    });
    assert.equal(recalcRes.status, 200);
    console.log("  testAdminCrudViaHttp passed");
  } finally { await cleanup(); }
}

async function testStaticFileServing() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const rootRes = await fetch(`${baseUrl}/`);
    assert.equal(rootRes.status, 200);
    assert.ok(rootRes.headers.get("content-type").includes("text/html"));

    const changelogRes = await fetch(`${baseUrl}/CHANGELOG.md`);
    assert.equal(changelogRes.status, 200);
    assert.ok(changelogRes.headers.get("content-type").includes("text/markdown"));

    const changelogZhRes = await fetch(`${baseUrl}/CHANGELOG.zh-CN.md`);
    assert.equal(changelogZhRes.status, 200);

    const notFound = await fetch(`${baseUrl}/api/nonexistent`);
    assert.equal(notFound.status, 404);
    console.log("  testStaticFileServing passed");
  } finally { await cleanup(); }
}

async function testSnapshotUploadViaHttp() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const identity = generateIdentity();
    const deviceId = newId("d");
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId, deviceId, nickname: "snap-http",
        identityPublicKey: identity.identityPublicKey, os: "test", appVersion: APP_VERSION
      })
    });
    const items = [makeSnapshotItem({ workdirHash: "h_snap_http" })];
    const payload = {
      participantId: identity.participantId, deviceId,
      clientGeneratedAt: new Date().toISOString(),
      snapshot: {
        mode: "device_day_provider", day: "2026-05-14", providerId: "codex_local",
        bucketFingerprint: computeBucketFingerprint(items),
        rowCount: items.length,
        totalTokens: items.reduce((s, i) => s + (i.totalTokens || 0), 0)
      },
      items
    };
    const signature = signPayload(identity.identityPrivateKey, payload);
    const res = await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, signature })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.accepted, 1);

    const badSnapRes = await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...payload,
        snapshot: { ...payload.snapshot, rowCount: 99 },
        signature: signPayload(identity.identityPrivateKey, { ...payload, snapshot: { ...payload.snapshot, rowCount: 99 } })
      })
    });
    assert.equal(badSnapRes.status, 400);
    assert.match((await badSnapRes.json()).error, /rowCount/);
    console.log("  testSnapshotUploadViaHttp passed");
  } finally { await cleanup(); }
}

async function testDeviceRegistrationCompatibilityCheck() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const identity = generateIdentity();
    const goodRes = await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId, deviceId: newId("d"),
        nickname: "compat", identityPublicKey: identity.identityPublicKey,
        os: "test", appVersion: APP_VERSION,
        client: { clientProtocolVersion: CLIENT_PROTOCOL_VERSION }
      })
    });
    assert.equal(goodRes.status, 200);
    assert.equal((await goodRes.json()).compatibility.status, "compatible");
    console.log("  testDeviceRegistrationCompatibilityCheck passed");
  } finally { await cleanup(); }
}

// ─── Desktop/web UI structure validation tests ───────────────────────────────

function testDesktopHtmlSections() {
  const html = fs.readFileSync("src/desktop/index.html", "utf8");
  for (const section of ["overview", "workdirs", "sources", "settings"]) {
    assert.match(html, new RegExp(`data-section="${section}"`), `missing data-section="${section}"`);
  }
  assert.match(html, /id="wizard-overlay"/, "missing wizard overlay");
  assert.match(html, /id="onboarding-wizard"/, "missing onboarding wizard");
  assert.match(html, /id="trend-drawer"/, "missing trend drawer");
  assert.match(html, /data-section="overview"/);
  assert.match(html, /data-section="workdirs"/);
  assert.match(html, /data-section="sources"/);
  assert.match(html, /data-section="settings"/);
  console.log("  testDesktopHtmlSections passed");
}

function testDesktopHtmlSettingsTabs() {
  const html = fs.readFileSync("src/desktop/index.html", "utf8");
  for (const tab of ["app", "cloud", "about"]) {
    assert.match(html, new RegExp(`data-settings-tab="${tab}"`), `missing settings tab ${tab}`);
  }
  assert.match(html, /id="apiBaseUrl"/);
  assert.match(html, /id="launchAtLogin"/);
  assert.match(html, /id="showRawTokens"/);
  console.log("  testDesktopHtmlSettingsTabs passed");
}

function testDesktopHtmlDataI18n() {
  const html = fs.readFileSync("src/desktop/index.html", "utf8");
  const i18nAttrs = html.match(/data-i18n="([^"]+)"/g) || [];
  assert.ok(i18nAttrs.length > 50, `expected many data-i18n attributes, got ${i18nAttrs.length}`);
  const titleAttrs = html.match(/data-i18n-title="([^"]+)"/g) || [];
  assert.ok(titleAttrs.length >= 1, "expected data-i18n-title attributes");
  console.log("  testDesktopHtmlDataI18n passed");
}

function testWebLeaderboardStructure() {
  const html = fs.readFileSync("src/web/leaderboard.html", "utf8");
  assert.match(html, /leaderboard/i);
  assert.match(html, /period/i);
  console.log("  testWebLeaderboardStructure passed");
}

function testWebAdminStructure() {
  const html = fs.readFileSync("src/web/admin.html", "utf8");
  assert.match(html, /admin/i);
  assert.match(html, /usage/i);
  assert.match(html, /pricing/i);
  assert.match(html, /quality/i);
  assert.match(html, /devices/i);
  console.log("  testWebAdminStructure passed");
}

function testWebDownloadStructure() {
  const html = fs.readFileSync("src/web/download.html", "utf8");
  const js = fs.readFileSync("src/web/download.js", "utf8");
  assert.match(html, /download/i);
  assert.match(html, /download-actions/);
  assert.match(js, /darwin|windows|platform/i);
  console.log("  testWebDownloadStructure passed");
}

function testDesktopRendererExports() {
  const renderer = fs.readFileSync("src/desktop/renderer.js", "utf8");
  for (const fn of [
    "boot", "renderToday", "renderWorkdirs", "renderHealth",
    "renderConfig", "syncNow", "loadHealth", "loadToday", "connectCursor"
  ]) {
    assert.match(renderer, new RegExp(`(function|const|let|var)\\s+${fn}|${fn}\\s*[:=]`), `missing function ${fn} in renderer.js`);
  }
  assert.match(renderer, /cursorAuthStatusLabel/);
  assert.match(renderer, /data-disconnect-cursor-account/);
  console.log("  testDesktopRendererExports passed");
}

function testTauriBridgeExports() {
  const bridge = fs.readFileSync("src/desktop/tauri-bridge.js", "utf8");
  assert.match(bridge, /forwardToSidecar|forward_to_sidecar/);
  assert.match(bridge, /export/);
  assert.match(bridge, /cursor:connect:start/);
  assert.match(bridge, /cursor:connect:poll/);
  assert.match(bridge, /cursor:connect:cancel/);
  console.log("  testTauriBridgeExports passed");
}

// ─── Store-level edge case tests ─────────────────────────────────────────────

function testMultiParticipantLeaderboard() {
  const store = new Store(path.join(tmp, "db-multi-participant.json"));
  const participants = [];
  for (let i = 0; i < 5; i++) {
    const id = generateIdentity();
    const deviceId = newId("d");
    store.registerDevice({
      participantId: id.participantId, deviceId,
      nickname: `user-${i}`, identityPublicKey: id.identityPublicKey,
      os: "test", appVersion: APP_VERSION
    });
    store.upsertUsageBatch({
      participantId: id.participantId, deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: [{
        day: localDay(), toolCode: "codex", providerId: "codex_local",
        workdirHash: `wd_${i}`, workdirDisplayName: `project-${i}`,
        model: "gpt-5", inputTokens: (i + 1) * 100, outputTokens: 50,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        totalTokens: (i + 1) * 100 + 50, sourceQuality: "exact",
        sourceFingerprint: `sf_multi_${i}`
      }]
    });
    participants.push(id);
  }
  const board = store.publicLeaderboard({ range: "today" });
  assert.equal(board.length, 5);
  assert.ok(board[0].totalTokens >= board[1].totalTokens, "board should be sorted descending");
  assert.equal(board[0].rank, 1);
  assert.equal(board[4].rank, 5);
  console.log("  testMultiParticipantLeaderboard passed");
}

function testDeviceManagementStore() {
  const store = new Store(path.join(tmp, "db-device-mgmt.json"));
  const identity = generateIdentity();
  const d1 = newId("d");
  const d2 = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId: d1,
    nickname: "dev-user", identityPublicKey: identity.identityPublicKey,
    os: "macos", appVersion: APP_VERSION, clientAppVersion: "0.6.0",
    clientPlatform: "darwin-arm64", clientProtocolVersion: 2
  });
  store.registerDevice({
    participantId: identity.participantId, deviceId: d2,
    nickname: "dev-user", identityPublicKey: identity.identityPublicKey,
    os: "windows", appVersion: APP_VERSION, clientAppVersion: "0.6.0",
    clientPlatform: "win32-x64", clientProtocolVersion: 2
  });
  const devices = store.adminDevices();
  const myDevices = devices.filter((d) => d.participantId === identity.participantId);
  assert.equal(myDevices.length, 2);
  assert.ok(myDevices.some((d) => d.os === "macos"));
  assert.ok(myDevices.some((d) => d.os === "windows"));
  assert.ok(myDevices[0].lastSeenAt);
  console.log("  testDeviceManagementStore passed");
}

function testWorkdirAliasUpdate() {
  const store = new Store(path.join(tmp, "db-workdir-alias.json"));
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId,
    nickname: "wd-alias-user", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });
  store.upsertUsageBatch({
    participantId: identity.participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [{
      day: localDay(), toolCode: "codex", providerId: "codex_local",
      workdirHash: "wd_alias_hash", workdirDisplayName: "original-name",
      model: "gpt-5", inputTokens: 100, outputTokens: 50,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      totalTokens: 150, sourceQuality: "exact", sourceFingerprint: "sf_wd_alias"
    }]
  });
  const workdirs = Object.values(store.db.workdirs).filter((w) => w.participantId === identity.participantId);
  assert.equal(workdirs.length, 1);
  assert.equal(workdirs[0].workdirHash, "wd_alias_hash");
  assert.equal(workdirs[0].displayName, "original-name");

  workdirs[0].alias = "my-alias";
  workdirs[0].displayName = "my-alias";
  store.save();
  const updated = Object.values(store.db.workdirs).find((w) => w.participantId === identity.participantId);
  assert.equal(updated.alias, "my-alias");
  assert.equal(updated.displayName, "my-alias");
  console.log("  testWorkdirAliasUpdate passed");
}

function testStoreAggregateCacheInvalidation() {
  const store = new Store(path.join(tmp, "db-cache-invalidation.json"));
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId,
    nickname: "cache-user", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });
  const baseItem = {
    day: localDay(), toolCode: "codex", providerId: "codex_local",
    workdirHash: "wd_cache", workdirDisplayName: "cache-project",
    model: "gpt-5", outputTokens: 50, cacheReadTokens: 0,
    cacheWriteTokens: 0, reasoningTokens: 0, sourceQuality: "exact",
    sourceFingerprint: "sf_cache"
  };
  store.upsertUsageBatch({
    participantId: identity.participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [{ ...baseItem, inputTokens: 100, totalTokens: 150 }]
  });
  const board1 = store.publicLeaderboard({ range: "today" });
  assert.equal(board1[0].totalTokens, 150);
  assert.ok(Object.keys(store.aggregateCache).length >= 1);

  store.upsertUsageBatch({
    participantId: identity.participantId, deviceId,
    clientGeneratedAt: new Date(Date.now() + 1).toISOString(),
    items: [
      { ...baseItem, inputTokens: 200, totalTokens: 250, sourceFingerprint: "sf_cache_v2" },
      { ...baseItem, workdirHash: "wd_cache_2", workdirDisplayName: "cache-project-2", inputTokens: 100, totalTokens: 150, sourceFingerprint: "sf_cache_3" }
    ]
  });
  const board2 = store.publicLeaderboard({ range: "today" });
  assert.equal(board2[0].totalTokens, 400);
  console.log("  testStoreAggregateCacheInvalidation passed");
}

function testStoreBoardSummary() {
  const store = new Store(path.join(tmp, "db-board-summary.json"));
  const summary = store.boardSummary();
  assert.ok(summary.todayTokens === 0 || typeof summary.todayTokens === "number");
  assert.ok(summary.yesterdayTokens === 0 || typeof summary.yesterdayTokens === "number");
  assert.ok(typeof summary.participantCount === "number");
  console.log("  testStoreBoardSummary passed");
}

function testStoreDeleteModelPrice() {
  const store = new Store(path.join(tmp, "db-del-price.json"));
  store.upsertModelPrice({ model: "del-test", inputCostPerMTok: 1, outputCostPerMTok: 2 });
  assert.ok(store.listModelPrices().custom.some((p) => p.model === "del-test"));
  const result = store.deleteModelPrice("del-test");
  assert.equal(result.deleted, true);
  assert.ok(!store.listModelPrices().custom.some((p) => p.model === "del-test"));
  const result2 = store.deleteModelPrice("del-test");
  assert.equal(result2.deleted, false);
  console.log("  testStoreDeleteModelPrice passed");
}

function testNormalizeTokenNumberIntegration() {
  const identity = generateIdentity();
  const store = new Store(path.join(tmp, "db-normalize.json"));
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId,
    nickname: "norm-user", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });
  store.upsertUsageBatch({
    participantId: identity.participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [{
      day: localDay(), toolCode: "codex", providerId: "codex_local",
      workdirHash: "wd_norm", workdirDisplayName: "norm-project",
      model: "gpt-5", inputTokens: 100.7, outputTokens: 50,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      totalTokens: 151, sourceQuality: "exact", sourceFingerprint: "sf_norm"
    }]
  });
  const rows = Object.values(store.db.usageDaily);
  assert.equal(rows[0].inputTokens, 100.7);
  assert.equal(rows[0].totalTokens, 151);
  const pubItem = publicUsageItem(rows[0]);
  assert.equal(pubItem.inputTokens, 101);
  assert.equal(pubItem.totalTokens, 151);
  console.log("  testNormalizeTokenNumberIntegration passed");
}

// ─── i18n completeness test ──────────────────────────────────────────────────

function testI18nCompleteness() {
  const i18n = fs.readFileSync("src/shared/i18n.js", "utf8");
  const zhStart = i18n.indexOf('"zh-CN"');
  const enStart = i18n.indexOf('"en"');
  assert.ok(zhStart >= 0, "zh-CN section not found");
  assert.ok(enStart >= 0, "en section not found");
  const zhBlock = i18n.slice(zhStart, enStart);
  const enBlock = i18n.slice(enStart);
  const keyPattern = /^\s*"([^"]+)":\s*"/gm;
  const zhKeys = new Set();
  const enKeys = new Set();
  let m;
  while ((m = keyPattern.exec(zhBlock)) !== null) zhKeys.add(m[1]);
  keyPattern.lastIndex = 0;
  while ((m = keyPattern.exec(enBlock)) !== null) enKeys.add(m[1]);
  const missingEn = [...zhKeys].filter((k) => !enKeys.has(k));
  const missingZh = [...enKeys].filter((k) => !zhKeys.has(k));
  assert.equal(missingEn.length, 0, `en missing keys: ${missingEn.slice(0, 10).join(", ")}`);
  assert.equal(missingZh.length, 0, `zh-CN missing keys: ${missingZh.slice(0, 10).join(", ")}`);
  console.log("  testI18nCompleteness passed");
}

function testI18nDataAttributesMatchKeys() {
  const html = fs.readFileSync("src/desktop/index.html", "utf8");
  const i18n = fs.readFileSync("src/shared/i18n.js", "utf8");
  const dataI18nKeys = [...new Set((html.match(/data-i18n="([^"]+)"/g) || []).map((m) => m.match(/"([^"]+)"/)[1]))];
  const dataPlaceholderKeys = [...new Set((html.match(/data-i18n-placeholder="([^"]+)"/g) || []).map((m) => m.match(/"([^"]+)"/)[1]))];
  const dataTitleKeys = [...new Set((html.match(/data-i18n-title="([^"]+)"/g) || []).map((m) => m.match(/"([^"]+)"/)[1]))];
  const allUsedKeys = [...dataI18nKeys, ...dataPlaceholderKeys, ...dataTitleKeys];
  let missing = 0;
  for (const key of allUsedKeys) {
    if (!i18n.includes(`"${key}":`)) {
      console.error(`  missing i18n key: ${key}`);
      missing++;
    }
  }
  assert.equal(missing, 0, `${missing} i18n keys used in HTML but missing from i18n.js`);
  console.log("  testI18nDataAttributesMatchKeys passed");
}

// ─── Run all new tests ───────────────────────────────────────────────────────

// Composition module tests
testCompositionRatio();
testCreateEmptyComposition();
testMergeTokenComposition();
testDominantComposition();
testTokenCompositionSummary();
testTokenCompositionDetails();
testCostQualityLabel();
testCompositionFieldCounts();

// Nickname generator tests
testNicknameGenerator();

// Preset module tests
testPresetModule();

// Schema extended tests
testSchemaNormalizeTokenNumber();
testSchemaDisplayTotalTokens();
testSchemaPrimaryTokenTotal();
testSchemaUsageKey();
testSchemaHourlyUsageKey();
testSchemaPublicUsageItem();
testSchemaAssertUsageItem();
testSchemaSourceQuality();
testSchemaForbiddenFields();

// HTTP API server-level tests
await testHealthEndpoint();
await testDeviceRegistrationEndpoint();
await testUsageUploadEndpointSignatureVerification();
await testUsageBatchUploadEndpoint();
await testUsageUploadRejectsUnregistered();
await testAdminAuthEnforcement();
await testAdminAuthDisabledWhenNotConfigured();
await testBoardPublicMode();
await testBoardAuthenticatedMode();
await testSelfServiceDeletionReplayProtection();
await testLeaderboardEndpoint();
await testBoardParticipantDetailAndTrend();
await testModelPricesPublicEndpoint();
await testAdminCrudViaHttp();
await testStaticFileServing();
await testSnapshotUploadViaHttp();
await testDeviceRegistrationCompatibilityCheck();

// Desktop/web UI structure tests
testDesktopHtmlSections();
testDesktopHtmlSettingsTabs();
testDesktopHtmlDataI18n();
testWebLeaderboardStructure();
testWebAdminStructure();
testWebDownloadStructure();
testDesktopRendererExports();
testTauriBridgeExports();

// Store-level edge case tests
testMultiParticipantLeaderboard();
testDeviceManagementStore();
testWorkdirAliasUpdate();
testStoreAggregateCacheInvalidation();
testStoreBoardSummary();
testStoreDeleteModelPrice();
testNormalizeTokenNumberIntegration();

// ── Cloud provider dedup tests ──

function testCursorSameAccountDedupAcrossDevices() {
  const tmp = path.join(os.tmpdir(), `test-cloud-dedup-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_dedup", didA = "d_cursor_a", didB = "d_cursor_b";
  const workdirHash = "cursor_acct_hash_abc";
  const day = "2026-05-14", hour = 10, providerId = "cursor_dashboard_usage";

  store.registerDevice({ participantId: pid, deviceId: didA, nickname: "A", identityPublicKey: "pk_dedup", os: "test", appVersion: "0.1.0" });
  store.registerDevice({ participantId: pid, deviceId: didB, nickname: "B", identityPublicKey: "pk_dedup", os: "test", appVersion: "0.1.0" });

  // Device A uploads Cursor usage first
  const uploadA = makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash, inputTokens: 100, outputTokens: 50, totalTokens: 150, providerId, model: "gpt-5" })
  ], pid, didA, { providerId, day, hour });
  store.upsertUsageBatch(uploadA);
  assert.equal(Object.keys(store.db.usageHourly).length, 1);

  // Device B uploads same Cursor account same hour — should dedup A's row
  const uploadB = makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash, inputTokens: 100, outputTokens: 50, totalTokens: 150, providerId, model: "gpt-5" })
  ], pid, didB, { providerId, day, hour });
  store.upsertUsageBatch(uploadB);

  const hourlyRows = Object.values(store.db.usageHourly);
  assert.equal(hourlyRows.length, 1, "same Cursor account across devices should keep only 1 hourly row");
  assert.equal(hourlyRows[0].deviceId, didB, "should keep the latest device's row");

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testCursorSameAccountDedupAcrossDevices passed");
}

function testDeleteCloudDeviceForcesEarlierDeviceReupload() {
  const tmpPath = path.join(os.tmpdir(), `test-cloud-device-reset-${Date.now()}.json`);
  const store = new Store(tmpPath);
  const pid = "p_cloud_reset", didA = "d_cloud_reset_a", didB = "d_cloud_reset_b";
  const workdirHash = "cursor_reset_acct";
  const day = "2026-05-14", hour = 10, providerId = "cursor_dashboard_usage";

  store.registerDevice({ participantId: pid, deviceId: didA, nickname: "A", identityPublicKey: "pk_cloud_reset", os: "test", appVersion: "0.1.0" });
  store.registerDevice({ participantId: pid, deviceId: didB, nickname: "B", identityPublicKey: "pk_cloud_reset", os: "test", appVersion: "0.1.0" });
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash, inputTokens: 100, outputTokens: 50, totalTokens: 150, providerId, model: "gpt-5" })
  ], pid, didA, { providerId, day, hour }));
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash, inputTokens: 100, outputTokens: 50, totalTokens: 150, providerId, model: "gpt-5" })
  ], pid, didB, { providerId, day, hour }));

  assert.equal(Object.values(store.db.usageHourly).some((row) => row.deviceId === didA), false, "device A row should be deduped by device B");
  assert.ok(store.getHourlyBucketSync(pid, didA, day, hour, providerId), "device A sync bucket is preserved before reset");

  const deleted = store.deleteDeviceData(didB);
  assert.equal(deleted.removed.usageHourly, 1);
  assert.equal(Object.values(store.db.usageHourly).some((row) => row.deviceId === didB), false);
  assert.equal(store.getHourlyBucketSync(pid, didA, day, hour, providerId), null, "device A bucket should be missing so it can reupload the deduped cloud row");

  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  console.log("  testDeleteCloudDeviceForcesEarlierDeviceReupload passed");
}

function testCursorDifferentAccountsNoDedup() {
  const tmp = path.join(os.tmpdir(), `test-cloud-nodedup-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_dedup2", didA = "d_a2", didB = "d_b2";
  const hash1 = "cursor_acct_hash_acc1";
  const hash2 = "cursor_acct_hash_acc2";
  const day = "2026-05-14", hour = 11, providerId = "cursor_dashboard_usage";

  store.registerDevice({ participantId: pid, deviceId: didA, nickname: "A", identityPublicKey: "pk_nodedup", os: "test", appVersion: "0.1.0" });
  store.registerDevice({ participantId: pid, deviceId: didB, nickname: "B", identityPublicKey: "pk_nodedup", os: "test", appVersion: "0.1.0" });

  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash: hash1, inputTokens: 200, outputTokens: 100, totalTokens: 300, providerId, model: "gpt-5" })
  ], pid, didA, { providerId, day, hour }));

  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash: hash2, inputTokens: 50, outputTokens: 25, totalTokens: 75, providerId, model: "gpt-5" })
  ], pid, didB, { providerId, day, hour }));

  assert.equal(Object.keys(store.db.usageHourly).length, 2, "different Cursor accounts should both be kept");
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testCursorDifferentAccountsNoDedup passed");
}

function testLocalProviderNoDedup() {
  const tmp = path.join(os.tmpdir(), `test-local-nodedup-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_local", didA = "d_la", didB = "d_lb";
  const workdirHash = "local_workdir_same";
  const day = "2026-05-14", hour = 12, providerId = "codex_local";

  store.registerDevice({ participantId: pid, deviceId: didA, nickname: "A", identityPublicKey: "pk_local", os: "test", appVersion: "0.1.0" });
  store.registerDevice({ participantId: pid, deviceId: didB, nickname: "B", identityPublicKey: "pk_local", os: "test", appVersion: "0.1.0" });

  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash, inputTokens: 100, outputTokens: 50, totalTokens: 150, providerId, model: "codex-1" })
  ], pid, didA, { providerId, day, hour }));

  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash, inputTokens: 80, outputTokens: 40, totalTokens: 120, providerId, model: "codex-1" })
  ], pid, didB, { providerId, day, hour }));

  assert.equal(Object.keys(store.db.usageHourly).length, 2, "local providers from different devices should accumulate, not dedup");
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testLocalProviderNoDedup passed");
}

function testCursorDedupSyncBucketPreserved() {
  const tmp = path.join(os.tmpdir(), `test-sync-bucket-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_sync", didA = "d_sa", didB = "d_sb";
  const workdirHash = "cursor_sync_hash";
  const day = "2026-05-14", hour = 13, providerId = "cursor_dashboard_usage";

  store.registerDevice({ participantId: pid, deviceId: didA, nickname: "A", identityPublicKey: "pk_sync", os: "test", appVersion: "0.1.0" });
  store.registerDevice({ participantId: pid, deviceId: didB, nickname: "B", identityPublicKey: "pk_sync", os: "test", appVersion: "0.1.0" });

  // Device A uploads
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash, inputTokens: 100, outputTokens: 50, totalTokens: 150, providerId, model: "gpt-5" })
  ], pid, didA, { providerId, day, hour }));

  // A's sync bucket should exist
  const bucketA = store.getHourlyBucketSync(pid, didA, day, hour, providerId);
  assert.ok(bucketA, "device A should have a sync bucket after upload");

  // Device B overwrites via dedup
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash, inputTokens: 100, outputTokens: 50, totalTokens: 150, providerId, model: "gpt-5" })
  ], pid, didB, { providerId, day, hour }));

  // A's sync bucket should still be there (dedup removes usage rows, not sync buckets)
  const bucketAAfter = store.getHourlyBucketSync(pid, didA, day, hour, providerId);
  assert.ok(bucketAAfter, "device A sync bucket must survive cloud dedup");

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testCursorDedupSyncBucketPreserved passed");
}

function testCursorDedupDailyDerivedCorrectly() {
  const tmp = path.join(os.tmpdir(), `test-daily-derived-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_daily", didA = "d_da", didB = "d_db";
  const workdirHash = "cursor_daily_hash";
  const day = "2026-05-14", providerId = "cursor_dashboard_usage";

  store.registerDevice({ participantId: pid, deviceId: didA, nickname: "A", identityPublicKey: "pk_daily", os: "test", appVersion: "0.1.0" });
  store.registerDevice({ participantId: pid, deviceId: didB, nickname: "B", identityPublicKey: "pk_daily", os: "test", appVersion: "0.1.0" });

  // Device A uploads hour 10
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash, inputTokens: 100, outputTokens: 50, totalTokens: 150, providerId, model: "gpt-5" })
  ], pid, didA, { providerId, day, hour: 10 }));

  // Device B uploads hour 10 (same natural key — dedup A's row) + hour 11
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash, inputTokens: 100, outputTokens: 50, totalTokens: 150, providerId, model: "gpt-5" })
  ], pid, didB, { providerId, day, hour: 10 }));

  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash, inputTokens: 200, outputTokens: 100, totalTokens: 300, providerId, model: "gpt-5" })
  ], pid, didB, { providerId, day, hour: 11 }));

  // After dedup: only B's rows remain. B has hour 10 + hour 11.
  // Daily for B should be 150 + 300 = 450.
  const dailyRows = Object.values(store.db.usageDaily);
  const bDaily = dailyRows.find(r => r.deviceId === didB && r.hourlyDerived);
  assert.ok(bDaily, "device B should have a derived daily row");
  assert.equal(bDaily.totalTokens, 450, "daily total should be sum of B's hours after dedup removed A's row");

  // A should have no daily rows (its hourly was deduped away)
  const aDaily = dailyRows.find(r => r.deviceId === didA && r.hourlyDerived);
  assert.ok(!aDaily, "device A should have no hourly-derived daily after dedup");

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testCursorDedupDailyDerivedCorrectly passed");
}

function testSyncStateReturnsMissingAndMatched() {
  const tmp = path.join(os.tmpdir(), `test-sync-state-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_ss", did = "d_ss";
  const day = "2026-05-14", providerId = "codex_local";

  store.registerDevice({ participantId: pid, deviceId: did, nickname: "SS", identityPublicKey: "pk_ss", os: "test", appVersion: "0.1.0" });

  // Upload a snapshot to create a sync bucket
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash: "h1", totalTokens: 100, providerId, day, hour: 10 })
  ], pid, did, { providerId, day, hour: 10 }));

  const result = store.compareSyncState({
    participantId: pid, deviceId: did,
    buckets: [
      { day, hour: 10, providerId, fingerprint: store.getHourlyBucketSync(pid, did, day, 10, providerId).bucketFingerprint },
      { day, hour: 11, providerId, fingerprint: "nonexistent_fp" }
    ]
  });

  assert.equal(result.matched.length, 1, "hour 10 should match");
  assert.equal(result.missing.length, 1, "hour 11 should be missing");
  assert.equal(result.different.length, 0, "no different buckets");

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testSyncStateReturnsMissingAndMatched passed");
}

function testSyncStateAfterResetDetectsMissing() {
  const tmp = path.join(os.tmpdir(), `test-sync-reset-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_ssr", did = "d_ssr";
  const day = "2026-05-14", providerId = "cursor_dashboard_usage";

  store.registerDevice({ participantId: pid, deviceId: did, nickname: "SSR", identityPublicKey: "pk_ssr", os: "test", appVersion: "0.1.0" });

  // Upload then simulate cloud reset by deleting sync buckets
  const fp = "some_fingerprint";
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash: "h1", totalTokens: 100, providerId, day, hour: 10 })
  ], pid, did, { providerId, day, hour: 10 }));

  // Verify bucket exists
  assert.ok(store.getHourlyBucketSync(pid, did, day, 10, providerId));

  // Simulate cloud reset: wipe usage + sync buckets
  store.db.usageHourly = {};
  store.db.usageSyncBucketsHourly = {};
  store.db.usageDaily = {};
  store.save();

  // Load fresh store to simulate server restart
  const store2 = new Store(tmp);

  const result = store2.compareSyncState({
    participantId: pid, deviceId: did,
    buckets: [{ day, hour: 10, providerId, fingerprint: fp }]
  });

  assert.equal(result.missing.length, 1, "after reset, bucket should be missing");
  assert.equal(result.matched.length, 0);

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testSyncStateAfterResetDetectsMissing passed");
}

function testDeleteParticipantDataClearsHourlySyncState() {
  const tmp = path.join(os.tmpdir(), `test-reset-hourly-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_reset_hourly", did = "d_reset_hourly";
  const day = "2026-05-14", hour = 10, providerId = "cursor_dashboard_usage";

  store.registerDevice({ participantId: pid, deviceId: did, nickname: "Reset", identityPublicKey: "pk_reset", os: "test", appVersion: "0.1.0" });
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash: "cursor_reset_hash", totalTokens: 100, providerId, day, hour })
  ], pid, did, { providerId, day, hour }));

  assert.ok(Object.values(store.db.usageHourly).some(row => row.participantId === pid));
  assert.ok(Object.values(store.db.usageSyncBucketsHourly).some(row => row.participantId === pid));

  const result = store.deleteParticipantData(pid);
  assert.equal(result.removed.usageHourly, 1);
  assert.equal(result.removed.usageSyncBucketsHourly, 1);
  assert.equal(Object.values(store.db.usageHourly).some(row => row.participantId === pid), false);
  assert.equal(Object.values(store.db.usageSyncBucketsHourly).some(row => row.participantId === pid), false);

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testDeleteParticipantDataClearsHourlySyncState passed");
}

// ─── Crypto edge case tests ─────────────────────────────────────────────────

function testCanonicalJson() {
  // Primitive values
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson(true), "true");
  assert.equal(canonicalJson(false), "false");
  assert.equal(canonicalJson(42), "42");
  assert.equal(canonicalJson("hello"), '"hello"');
  assert.equal(canonicalJson(""), '""');

  // Object key sorting
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonicalJson({ z: 0, a: 0, m: 0 }), '{"a":0,"m":0,"z":0}');

  // Nested objects
  assert.equal(
    canonicalJson({ outer: { d: 4, c: 3 } }),
    '{"outer":{"c":3,"d":4}}'
  );

  // Arrays preserve order
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
  assert.equal(canonicalJson([]), "[]");

  // Array of objects
  assert.equal(
    canonicalJson([{ b: 2 }, { a: 1 }]),
    '[{"b":2},{"a":1}]'
  );

  // Mixed nesting
  assert.equal(
    canonicalJson({ items: [{ z: 1 }, { a: 2 }], count: 2 }),
    '{"count":2,"items":[{"z":1},{"a":2}]}'
  );

  // Unicode keys
  assert.ok(canonicalJson({ "中文": 1 }).includes('"中文"'));
  assert.equal(canonicalJson({ "中文": 1 }), '{"中文":1}');

  // Numeric-looking string keys sort lexicographically
  assert.equal(canonicalJson({ "10": "a", "2": "b" }), '{"10":"a","2":"b"}');

  // Determinism: same object always produces same output
  const obj = { c: 3, a: 1, b: 2 };
  for (let i = 0; i < 10; i++) {
    assert.equal(canonicalJson(obj), '{"a":1,"b":2,"c":3}');
  }

  console.log("  testCanonicalJson passed");
}

function testSha256Hex() {
  // Basic determinism
  assert.equal(sha256Hex("hello"), sha256Hex("hello"));
  assert.ok(sha256Hex("hello").length === 64);
  assert.ok(/^[a-f0-9]{64}$/.test(sha256Hex("test")));

  // Different inputs produce different hashes
  assert.notEqual(sha256Hex("a"), sha256Hex("b"));

  // Empty string
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

  // Long string
  const long = "x".repeat(100000);
  assert.ok(sha256Hex(long).length === 64);

  console.log("  testSha256Hex passed");
}

function testSignVerifyEdgeCases() {
  const identity = generateIdentity();
  const payload = { action: "test", value: 42 };

  // Sign and verify round-trip
  const sig = signPayload(identity.identityPrivateKey, payload);
  assert.equal(verifyPayload(identity.identityPublicKey, payload, sig), true);

  // Tampered payload fails verification
  assert.equal(
    verifyPayload(identity.identityPublicKey, { ...payload, value: 99 }, sig),
    false
  );

  // Wrong key fails
  const other = generateIdentity();
  assert.equal(
    verifyPayload(other.identityPublicKey, payload, sig),
    false
  );

  // Wrong signature fails
  assert.equal(
    verifyPayload(identity.identityPublicKey, payload, "AAAA" + sig.slice(4)),
    false
  );

  // Different payload objects with same content verify correctly
  const payload2 = { value: 42, action: "test" };
  assert.equal(verifyPayload(identity.identityPublicKey, payload2, sig), true);

  // Empty payload
  const emptySig = signPayload(identity.identityPrivateKey, {});
  assert.equal(verifyPayload(identity.identityPublicKey, {}, emptySig), true);

  console.log("  testSignVerifyEdgeCases passed");
}

function testNewIdUniqueness() {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    ids.add(newId("test"));
  }
  assert.equal(ids.size, 1000, "newId should produce unique IDs");

  // Prefix is preserved
  for (const id of ids) {
    assert.ok(id.startsWith("test_"), `id ${id} should start with test_`);
  }

  // Different prefixes
  const pId = newId("p");
  const dId = newId("d");
  assert.ok(pId.startsWith("p_"));
  assert.ok(dId.startsWith("d_"));
  assert.notEqual(pId, dId);

  console.log("  testNewIdUniqueness passed");
}

// ─── Date utility edge case tests ─────────────────────────────────────────────

function testDayToUtcDate() {
  // Valid date
  const d = dayToUtcDate("2026-05-14");
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 4);
  assert.equal(d.getUTCDate(), 14);

  // Invalid/empty returns epoch fallback
  const epoch = dayToUtcDate("");
  assert.equal(epoch.getUTCFullYear(), 1970);

  const nullEpoch = dayToUtcDate(null);
  assert.equal(nullEpoch.getUTCFullYear(), 1970);

  const undefEpoch = dayToUtcDate(undefined);
  assert.equal(undefEpoch.getUTCFullYear(), 1970);

  // Month boundary
  const mar1 = dayToUtcDate("2026-03-01");
  assert.equal(mar1.getUTCMonth(), 2);

  console.log("  testDayToUtcDate passed");
}

function testUtcDateToDay() {
  assert.equal(utcDateToDay(new Date(Date.UTC(2026, 4, 14))), "2026-05-14");
  assert.equal(utcDateToDay(new Date(Date.UTC(2026, 0, 1))), "2026-01-01");
  assert.equal(utcDateToDay(new Date(Date.UTC(2026, 11, 31))), "2026-12-31");

  console.log("  testUtcDateToDay passed");
}

function testAddDaysEdgeCases() {
  // Zero days
  assert.equal(addDays("2026-05-14", 0), "2026-05-14");

  // Negative days
  assert.equal(addDays("2026-05-15", -1), "2026-05-14");
  assert.equal(addDays("2026-05-01", -1), "2026-04-30");

  // Cross month boundary
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");

  // Cross year boundary
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2027-01-01", -1), "2026-12-31");

  // Large offset
  assert.equal(addDays("2026-01-01", 365), "2027-01-01");

  console.log("  testAddDaysEdgeCases passed");
}

function testDaysBetweenEdgeCases() {
  // Same day
  assert.deepEqual(daysBetween("2026-05-14", "2026-05-14"), ["2026-05-14"]);

  // Consecutive days
  assert.deepEqual(daysBetween("2026-05-14", "2026-05-15"), ["2026-05-14", "2026-05-15"]);

  // Inverted range returns empty
  assert.deepEqual(daysBetween("2026-05-15", "2026-05-14"), []);

  // Week span
  const week = daysBetween("2026-05-14", "2026-05-20");
  assert.equal(week.length, 7);
  assert.equal(week[0], "2026-05-14");
  assert.equal(week[6], "2026-05-20");

  // Cross month
  const crossMonth = daysBetween("2026-01-30", "2026-02-02");
  assert.equal(crossMonth.length, 4);
  assert.equal(crossMonth[0], "2026-01-30");
  assert.equal(crossMonth[3], "2026-02-02");

  console.log("  testDaysBetweenEdgeCases passed");
}

function testLocalDayEdgeCases() {
  // Valid date string
  const d = localDay("2026-05-14");
  assert.equal(d, "2026-05-14");

  // Date object
  const dateObj = localDay(new Date(Date.UTC(2026, 4, 14, 12, 0, 0)));
  assert.match(dateObj, /^\d{4}-\d{2}-\d{2}$/);

  // Invalid date string falls back to now
  const fallback = localDay("not-a-date");
  assert.match(fallback, /^\d{4}-\d{2}-\d{2}$/);

  // Explicit timezone
  const utcDay = localDay(new Date(Date.UTC(2026, 4, 14, 23, 0, 0)), "UTC");
  assert.equal(utcDay, "2026-05-14");

  console.log("  testLocalDayEdgeCases passed");
}

// ─── Pricing edge case tests ─────────────────────────────────────────────────

function testNormalizeModelName() {
  assert.equal(normalizeModelName("GPT-5"), "gpt-5");
  assert.equal(normalizeModelName(" OpenAI/gpt-5 "), "openai/gpt-5");
  assert.equal(normalizeModelName("~anthropic/claude-4"), "anthropic/claude-4");
  assert.equal(normalizeModelName("openrouter/google/gemini"), "google/gemini");
  assert.equal(normalizeModelName(""), "");
  assert.equal(normalizeModelName(null), "");
  assert.equal(normalizeModelName(undefined), "");
  assert.equal(normalizeModelName(42), "42");
  assert.equal(normalizeModelName("MODEL"), "model");

  console.log("  testNormalizeModelName passed");
}

function testMergeCostQuality() {
  assert.equal(mergeCostQuality("exact_price", "exact_price"), "exact_price");
  assert.equal(mergeCostQuality("exact_price", "estimated_price"), "estimated_price");
  assert.equal(mergeCostQuality("exact_price", "unknown_price"), "unknown_price");
  assert.equal(mergeCostQuality("estimated_price", "unknown_price"), "unknown_price");
  assert.equal(mergeCostQuality("estimated_price", "exact_price"), "estimated_price");
  assert.equal(mergeCostQuality("unknown_price", "exact_price"), "unknown_price");

  // Empty strings
  assert.equal(mergeCostQuality("", "exact_price"), "exact_price");
  assert.equal(mergeCostQuality("exact_price", ""), "exact_price");
  assert.equal(mergeCostQuality("", ""), "");

  // Undefined/null defaults
  assert.equal(mergeCostQuality(undefined, "exact_price"), "exact_price");
  assert.equal(mergeCostQuality("exact_price", undefined), "exact_price");

  console.log("  testMergeCostQuality passed");
}

function testAggregateCost() {
  // Accumulate costs
  const target = {};
  aggregateCost(target, { estimatedCostUsd: 1.5, inputCostUsd: 1.0, outputCostUsd: 0.5, model: "gpt-5", costQuality: "exact_price" });
  assert.equal(target.estimatedCostUsd, 1.5);
  assert.equal(target.hasKnownPrice, true);
  assert.equal(target.costQuality, "exact_price");

  // Accumulate more
  aggregateCost(target, { estimatedCostUsd: 2.0, inputCostUsd: 1.5, outputCostUsd: 0.5, model: "gpt-5", costQuality: "estimated_price" });
  assert.equal(target.estimatedCostUsd, 3.5);
  assert.equal(target.costQuality, "estimated_price");

  // Null cost tracks missing models
  const target2 = {};
  aggregateCost(target2, { estimatedCostUsd: null, model: "unknown-model", totalTokens: 500 });
  assert.equal(target2.hasKnownPrice, undefined);
  assert.equal(target2.missingPriceModels["unknown-model"], 500);
  assert.equal(target2.missingPriceTokens, 500);
  assert.equal(target2.costQuality, "unknown_price");

  // Undefined cost also tracks missing
  const target3 = {};
  aggregateCost(target3, { estimatedCostUsd: undefined, model: "missing-model", totalTokens: 100 });
  assert.equal(target3.missingPriceModels["missing-model"], 100);

  console.log("  testAggregateCost passed");
}

function testPriceToPublic() {
  const result = priceToPublic("gpt-5", {
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000002,
    cache_read_input_token_cost: 0.0000001,
    cache_creation_input_token_cost: 0.000001,
    source: "openrouter",
    pricingVersion: "v1",
    updatedAt: "2026-05-14"
  });
  assert.equal(result.model, "gpt-5");
  assert.ok(result.inputCostPerMTok > 0);
  assert.ok(result.outputCostPerMTok > 0);
  assert.equal(result.source, "openrouter");
  assert.equal(result.reasoningCostPerMTok, 0);

  // Missing fields default
  const sparse = priceToPublic("test", {
    input_cost_per_token: 0,
    output_cost_per_token: 0
  });
  assert.equal(sparse.model, "test");
  assert.equal(sparse.inputCostPerMTok, 0);
  assert.equal(sparse.source, "builtin");

  console.log("  testPriceToPublic passed");
}

function testAddCostToUsageItem() {
  const item = { model: "gpt-5", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const priceMap = createPriceMap({}, {
    "gpt-5": {
      model: "gpt-5",
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002
    }
  });
  const result = addCostToUsageItem(item, priceMap);
  assert.ok(result.estimatedCostUsd > 0);
  assert.equal(result.costQuality, "exact_price");
  // Original item is not mutated (spread)
  assert.equal(item.estimatedCostUsd, undefined);

  // Unknown model
  const unknownResult = addCostToUsageItem({ model: "unknown", inputTokens: 100 }, {});
  assert.equal(unknownResult.costQuality, "unknown_price");
  assert.equal(unknownResult.estimatedCostUsd, null);

  console.log("  testAddCostToUsageItem passed");
}

// ─── Schema edge case tests ───────────────────────────────────────────────────

function testCloudNaturalKey() {
  const item = { day: "2026-05-14", hour: 10, toolCode: "cursor", providerId: "cursor_dashboard_usage", workdirHash: "abc", model: "gpt-5" };
  const key1 = cloudNaturalKey(item, "p1");
  assert.ok(key1.includes("2026-05-14"));
  assert.ok(key1.includes("10"));
  assert.ok(key1.includes("p1"));
  assert.ok(key1.includes("cursor"));
  assert.ok(key1.includes("gpt-5"));

  // Hour defaults to 0
  const itemNoHour = { day: "2026-05-14", toolCode: "cursor", providerId: "cursor_dashboard_usage", workdirHash: "abc", model: "gpt-5" };
  const key2 = cloudNaturalKey(itemNoHour, "p1");
  assert.ok(key2.includes("|0|"));

  // Different participants produce different keys
  const key3 = cloudNaturalKey(item, "p2");
  assert.notEqual(key1, key3);

  // Same participant and item produces same key
  const key4 = cloudNaturalKey(item, "p1");
  assert.equal(key1, key4);

  console.log("  testCloudNaturalKey passed");
}

function testTodayLocal() {
  const result = todayLocal();
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/, "todayLocal should return YYYY-MM-DD");
  assert.equal(result, localDay());
  console.log("  testTodayLocal passed");
}

function testAssertSnapshotHourlyBounds() {
  // Valid hour 0
  assert.doesNotThrow(() => assertSnapshot({
    mode: "device_day_hour_provider", day: "2026-05-14", hour: 0,
    providerId: "codex_local", bucketFingerprint: "fp", rowCount: 1, totalTokens: 100
  }, [{ day: "2026-05-14", hour: 0, providerId: "codex_local" }], "p1", "d1"));

  // Valid hour 23
  assert.doesNotThrow(() => assertSnapshot({
    mode: "device_day_hour_provider", day: "2026-05-14", hour: 23,
    providerId: "codex_local", bucketFingerprint: "fp", rowCount: 1, totalTokens: 100
  }, [{ day: "2026-05-14", hour: 23, providerId: "codex_local" }], "p1", "d1"));

  // Invalid hour -1
  assert.throws(() => assertSnapshot({
    mode: "device_day_hour_provider", day: "2026-05-14", hour: -1,
    providerId: "codex_local", bucketFingerprint: "fp", rowCount: 1, totalTokens: 100
  }, [{ day: "2026-05-14", hour: -1, providerId: "codex_local" }], "p1", "d1"), /hour must be 0-23/);

  // Invalid hour 24
  assert.throws(() => assertSnapshot({
    mode: "device_day_hour_provider", day: "2026-05-14", hour: 24,
    providerId: "codex_local", bucketFingerprint: "fp", rowCount: 1, totalTokens: 100
  }, [{ day: "2026-05-14", hour: 24, providerId: "codex_local" }], "p1", "d1"), /hour must be 0-23/);

  // Hour mismatch between snapshot and items
  assert.throws(() => assertSnapshot({
    mode: "device_day_hour_provider", day: "2026-05-14", hour: 5,
    providerId: "codex_local", bucketFingerprint: "fp", rowCount: 1, totalTokens: 100
  }, [{ day: "2026-05-14", hour: 10, providerId: "codex_local" }], "p1", "d1"), /hour/);

  // Missing hour in hourly mode
  assert.throws(() => assertSnapshot({
    mode: "device_day_hour_provider", day: "2026-05-14",
    providerId: "codex_local", bucketFingerprint: "fp", rowCount: 1, totalTokens: 100
  }, [{ day: "2026-05-14", providerId: "codex_local" }], "p1", "d1"), /hour must be 0-23/);

  // Non-integer hour
  assert.throws(() => assertSnapshot({
    mode: "device_day_hour_provider", day: "2026-05-14", hour: 5.5,
    providerId: "codex_local", bucketFingerprint: "fp", rowCount: 1, totalTokens: 100
  }, [{ day: "2026-05-14", hour: 5.5, providerId: "codex_local" }], "p1", "d1"), /hour must be 0-23/);

  console.log("  testAssertSnapshotHourlyBounds passed");
}

function testCloudProviderIdsSet() {
  assert.ok(CLOUD_PROVIDER_IDS.has("cursor_dashboard_usage"));
  assert.ok(!CLOUD_PROVIDER_IDS.has("codex_local"));
  assert.ok(!CLOUD_PROVIDER_IDS.has("claude_code_local"));
  assert.equal(CLOUD_PROVIDER_IDS.size, 1);

  console.log("  testCloudProviderIdsSet passed");
}

// ─── Version module edge case tests ───────────────────────────────────────────

function testCompareSemver() {
  // Equal versions
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("0.7.0", "0.7.0"), 0);

  // Major comparison
  assert.equal(compareSemver("2.0.0", "1.0.0"), 1);
  assert.equal(compareSemver("1.0.0", "2.0.0"), -1);

  // Minor comparison
  assert.equal(compareSemver("0.8.0", "0.7.0"), 1);
  assert.equal(compareSemver("0.7.0", "0.8.0"), -1);

  // Patch comparison
  assert.equal(compareSemver("0.7.1", "0.7.0"), 1);
  assert.equal(compareSemver("0.7.0", "0.7.1"), -1);

  // All three components
  assert.equal(compareSemver("1.2.3", "1.2.2"), 1);
  assert.equal(compareSemver("1.2.3", "1.3.0"), -1);
  assert.equal(compareSemver("1.2.3", "2.0.0"), -1);

  // Pre-release tags are ignored (parsed as 0.0.0 for non-matching)
  assert.equal(compareSemver("1.0.0", "invalid"), 1);

  // Empty/null/undefined
  assert.equal(compareSemver("", ""), 0);
  assert.equal(compareSemver("0.0.0", ""), 0);
  assert.equal(compareSemver(null, undefined), 0);

  console.log("  testCompareSemver passed");
}

function testNormalizeClientMetadata() {
  // Full metadata
  const full = normalizeClientMetadata({
    clientAppVersion: "0.7.0",
    clientProtocolVersion: 2,
    clientPlatform: "darwin-arm64",
    clientBuild: "darwin-arm64-0.7.0"
  });
  assert.equal(full.clientAppVersion, "0.7.0");
  assert.equal(full.clientProtocolVersion, 2);
  assert.equal(full.clientPlatform, "darwin-arm64");
  assert.equal(full.clientBuild, "darwin-arm64-0.7.0");

  // Legacy field names
  const legacy = normalizeClientMetadata({
    appVersion: "0.6.0",
    clientProtocolVersion: 1,
    platform: "win32-x64",
    build: "win32-x64-0.6.0"
  });
  assert.equal(legacy.clientAppVersion, "0.6.0");
  assert.equal(legacy.clientPlatform, "win32-x64");

  // Missing protocol returns null
  const noProtocol = normalizeClientMetadata({ clientAppVersion: "0.7.0" });
  assert.equal(noProtocol.clientProtocolVersion, null);

  // Empty object
  const empty = normalizeClientMetadata({});
  assert.equal(empty.clientAppVersion, "");
  assert.equal(empty.clientProtocolVersion, null);

  // Values are trimmed and truncated to 160 chars
  const long = "a".repeat(200);
  const truncated = normalizeClientMetadata({ clientAppVersion: ` ${long} ` });
  assert.equal(truncated.clientAppVersion.length, 160);

  // null/undefined input defaults to empty
  const nullInput = normalizeClientMetadata(null ?? {});
  assert.equal(nullInput.clientAppVersion, "");

  console.log("  testNormalizeClientMetadata passed");
}

function testClientPlatformVariants() {
  assert.equal(clientPlatform({ platform: "darwin", arch: "arm64" }), "darwin-arm64");
  assert.equal(clientPlatform({ platform: "darwin", arch: "x64" }), "darwin-x64");
  assert.equal(clientPlatform({ platform: "win32", arch: "x64" }), "win32-x64");
  assert.equal(clientPlatform({ platform: "linux", arch: "x64" }), "linux-x64");
  // Unknown platform
  assert.equal(clientPlatform({ platform: "freebsd", arch: "x64" }), "freebsd-x64");
  console.log("  testClientPlatformVariants passed");
}

function testCollectNetworkInfo() {
  const info = collectNetworkInfo();
  assert.ok(Array.isArray(info.lanIps));
  // On a real machine, lanIps may or may not have entries, but it should not throw
  console.log("  testCollectNetworkInfo passed");
}

function testPackageVersionAndBaseline() {
  const ver = packageVersion();
  assert.match(ver, /^\d+\.\d+\.\d+$/);

  const bl = productBaseline();
  assert.match(bl, /^\d+\.\d+$/);

  console.log("  testPackageVersionAndBaseline passed");
}

// ─── Display edge case tests ──────────────────────────────────────────────────

function testFormatTokenCompactEdgeCases() {
  // Zero
  assert.equal(formatTokenCompact(0), "0");

  // Small numbers under 10000
  assert.ok(formatTokenCompact(100).length > 0);
  assert.ok(formatTokenCompact(9999).length > 0);

  // Negative
  assert.ok(formatTokenCompact(-1000).length > 0);

  // Non-finite
  assert.equal(formatTokenCompact(Infinity), "0");
  assert.equal(formatTokenCompact(NaN), "0");

  // null/undefined
  assert.equal(formatTokenCompact(null), "0");
  assert.equal(formatTokenCompact(undefined), "0");

  // English locale
  const en = formatTokenCompact(120000000, "en");
  assert.ok(en.length > 0);
  assert.ok(!en.includes("亿"));

  // Very large number
  const huge = formatTokenCompact(999999999);
  assert.ok(huge.length > 0);

  console.log("  testFormatTokenCompactEdgeCases passed");
}

function testFormatTokenRaw() {
  const result = formatTokenRaw(1234567);
  assert.ok(result.includes("1,234,567") || result.includes("1234567"));
  // t("unit.tokens") returns localized token label (e.g. "令牌" or "tokens")
  assert.ok(result.length > 10);

  // Zero
  const zero = formatTokenRaw(0);
  assert.ok(zero.includes("0"));

  console.log("  testFormatTokenRaw passed");
}

function testFormatUsdEdgeCases() {
  // Normal values
  const normal = formatUsd(10.5);
  assert.ok(normal.includes("$") || normal.includes("10.5"));

  // Zero
  const zero = formatUsd(0);
  assert.ok(zero.includes("$") || zero.includes("0"));

  // Negative
  const neg = formatUsd(-5);
  assert.ok(neg.includes("$") || neg.includes("5"));

  // Sub-cent positive value
  const tiny = formatUsd(0.001);
  assert.ok(tiny.length > 0);

  // null
  assert.equal(formatUsd(null), "-");

  // undefined
  assert.equal(formatUsd(undefined), "-");

  // NaN
  assert.equal(formatUsd(NaN), "-");

  // Infinity
  assert.equal(formatUsd(Infinity), "-");

  console.log("  testFormatUsdEdgeCases passed");
}

// ─── Update/release module edge case tests ────────────────────────────────────

function testBuildLatestYml() {
  const artifacts = [
    { fileName: "app.tar.gz", sha512: "a".repeat(88), size: 12345 }
  ];
  const yml = buildLatestYml("0.7.0", artifacts);
  assert.ok(yml.includes("version: 0.7.0"));
  assert.ok(yml.includes("sha512: " + "a".repeat(88)));
  assert.ok(yml.includes("size: 12345"));
  assert.ok(yml.includes("path: app.tar.gz"));

  // Multiple artifacts
  const multi = [
    { fileName: "app-aarch64.tar.gz", sha512: "a".repeat(88), size: 100 },
    { fileName: "app-x64.tar.gz", sha512: "b".repeat(88), size: 200 }
  ];
  const multiYml = buildLatestYml("0.7.0", multi);
  assert.ok(multiYml.includes("app-aarch64.tar.gz"));
  assert.ok(multiYml.includes("app-x64.tar.gz"));

  // Empty artifacts throws
  assert.throws(() => buildLatestYml("0.7.0", []), /no artifacts/);

  console.log("  testBuildLatestYml passed");
}

function testSha512Base64() {
  const tmpFile = path.join(tmp, "sha512-test.txt");
  fs.writeFileSync(tmpFile, "hello world");
  const hash = sha512Base64(tmpFile);
  assert.ok(hash.length > 0);
  assert.ok(/^[A-Za-z0-9+/]+=*$/.test(hash));

  // Deterministic
  const hash2 = sha512Base64(tmpFile);
  assert.equal(hash, hash2);

  // Different content = different hash
  fs.writeFileSync(tmpFile, "goodbye world");
  const hash3 = sha512Base64(tmpFile);
  assert.notEqual(hash, hash3);

  console.log("  testSha512Base64 passed");
}

function testBuildReleaseManifest() {
  const publicUrl = "https://releases.example.com";
  const manifest = buildReleaseManifest({
    version: "0.7.0",
    publicBaseUrl: publicUrl,
    manifestPath: "tauri-releases/latest.json",
    artifacts: [{
      platform: "darwin-arm64",
      fileName: "app.tar.gz",
      url: `${publicUrl}/app.tar.gz`,
      sha256: "a".repeat(64),
      signature: "sig",
      size: 12345
    }],
    installerArtifacts: [{
      platform: "darwin-arm64",
      fileName: "app.dmg",
      url: `${publicUrl}/app.dmg`,
      sha256: "b".repeat(64),
      size: 54321,
      ext: "dmg"
    }]
  });
  assert.equal(manifest.version, "0.7.0");
  assert.ok(manifest.platforms["darwin-arm64"]);
  assert.ok(manifest.platforms["darwin-arm64"].installer);
  assert.equal(manifest.platforms["darwin-arm64"].installer.ext, "dmg");

  // Missing checksum throws
  assert.throws(() => buildReleaseManifest({
    version: "0.7.0",
    publicBaseUrl: publicUrl,
    manifestPath: "latest.json",
    artifacts: [{ platform: "darwin-arm64", url: "x", size: 1 }]
  }), /missing checksum/);

  // Unsupported platform throws
  assert.throws(() => buildReleaseManifest({
    version: "0.7.0",
    publicBaseUrl: publicUrl,
    manifestPath: "latest.json",
    artifacts: [{ platform: "android-arm64", sha256: "a".repeat(64), url: "x", size: 1 }]
  }), /unsupported platform/);

  console.log("  testBuildReleaseManifest passed");
}

function testValidateReleaseManifest() {
  const publicUrl = "https://releases.example.com";
  const valid = {
    schemaVersion: 1,
    version: "0.7.0",
    channel: "stable",
    protocol: { client: 2, supportedClient: { min: 1, max: 2 } },
    platforms: {
      "darwin-arm64": {
        url: `${publicUrl}/app.tar.gz`,
        sha256: "a".repeat(64),
        size: 12345,
        fileName: "app.tar.gz"
      }
    }
  };
  const result = validateReleaseManifest(valid, { publicBaseUrl: publicUrl });
  assert.equal(result.version, "0.7.0");

  // Missing version
  assert.throws(() => validateReleaseManifest({ ...valid, version: "" }), /missing version/);

  // Missing channel
  assert.throws(() => validateReleaseManifest({ ...valid, channel: "" }), /missing channel/);

  // Missing protocol
  assert.throws(() => validateReleaseManifest({ ...valid, protocol: null }), /missing protocol/);

  // URL outside base URL
  assert.throws(() => validateReleaseManifest({
    ...valid,
    platforms: { "darwin-arm64": { url: "https://evil.com/app.tar.gz", sha256: "a".repeat(64) } }
  }, { publicBaseUrl: publicUrl }), /outside release public base url/);

  // Not an object
  assert.throws(() => validateReleaseManifest(null), /must be an object/);
  assert.throws(() => validateReleaseManifest("string"), /must be an object/);

  console.log("  testValidateReleaseManifest passed");
}

function testSelectUpdateArtifact() {
  const manifest = {
    version: "0.7.0",
    channel: "stable",
    protocol: { client: 2, supportedClient: { min: 1, max: 2 } },
    platforms: {
      "darwin-arm64": { url: "https://example.com/a.tar.gz", sha256: "a".repeat(64) },
      "win32-x64": { url: "https://example.com/a.exe", sha256: "b".repeat(64) }
    }
  };
  const mac = selectUpdateArtifact(manifest, "darwin-arm64");
  assert.ok(mac.url.includes("a.tar.gz"));

  const win = selectUpdateArtifact(manifest, "win32-x64");
  assert.ok(win.url.includes("a.exe"));

  // Missing platform
  assert.throws(() => selectUpdateArtifact(manifest, "linux-x64"), /does not support/);

  console.log("  testSelectUpdateArtifact passed");
}

function testSelectInstallerArtifact() {
  const manifest = {
    version: "0.7.0",
    channel: "stable",
    protocol: { client: 2, supportedClient: { min: 1, max: 2 } },
    platforms: {
      "darwin-arm64": {
        url: "https://example.com/a.tar.gz",
        sha256: "a".repeat(64),
        installer: {
          fileName: "app.dmg",
          url: "https://example.com/app.dmg",
          sha256: "c".repeat(64),
          size: 54321,
          ext: "dmg"
        }
      },
      "win32-x64": {
        url: "https://example.com/a.exe",
        sha256: "b".repeat(64)
      }
    }
  };

  // Platform with installer
  const dmg = selectInstallerArtifact(manifest, "darwin-arm64");
  assert.ok(dmg);
  assert.equal(dmg.ext, "dmg");
  assert.equal(dmg.platform, "darwin-arm64");

  // Platform without installer
  const noInstaller = selectInstallerArtifact(manifest, "win32-x64");
  assert.equal(noInstaller, null);

  console.log("  testSelectInstallerArtifact passed");
}

function testUpdateStateFromManifest() {
  const publicUrl = "https://releases.example.com";
  const manifest = {
    version: "0.8.0",
    channel: "stable",
    protocol: { client: 2, supportedClient: { min: 1, max: 2 } },
    platforms: {
      "darwin-arm64": {
        url: `${publicUrl}/app.tar.gz`,
        sha256: "a".repeat(64),
        mandatory: true
      }
    }
  };

  // Older current version => update available
  const oldResult = updateStateFromManifest(manifest, { currentVersion: "0.7.0", platform: "darwin-arm64" });
  assert.equal(oldResult.updateAvailable, true);
  assert.equal(oldResult.currentVersion, "0.7.0");
  assert.equal(oldResult.latestVersion, "0.8.0");
  assert.equal(oldResult.mandatory, true);

  // Same version => no update
  const sameResult = updateStateFromManifest(manifest, { currentVersion: "0.8.0", platform: "darwin-arm64" });
  assert.equal(sameResult.updateAvailable, false);

  // Newer version => no update
  const newerResult = updateStateFromManifest(manifest, { currentVersion: "0.9.0", platform: "darwin-arm64" });
  assert.equal(newerResult.updateAvailable, false);

  console.log("  testUpdateStateFromManifest passed");
}

function testReleasePlatformsFromEnv() {
  // Default: all platforms
  const saved = process.env.RELEASE_REQUIRED_PLATFORMS;
  delete process.env.RELEASE_REQUIRED_PLATFORMS;
  const all = releasePlatformsFromEnv();
  assert.equal(all.length, 4);
  assert.ok(all.includes("darwin-arm64"));

  // Custom valid platforms
  process.env.RELEASE_REQUIRED_PLATFORMS = "darwin-arm64,win32-x64";
  const custom = releasePlatformsFromEnv();
  assert.equal(custom.length, 2);
  assert.ok(custom.includes("darwin-arm64"));
  assert.ok(custom.includes("win32-x64"));

  // Invalid platform throws
  process.env.RELEASE_REQUIRED_PLATFORMS = "android-arm64";
  assert.throws(() => releasePlatformsFromEnv(), /unsupported release platform/);

  // Restore
  if (saved === undefined) delete process.env.RELEASE_REQUIRED_PLATFORMS;
  else process.env.RELEASE_REQUIRED_PLATFORMS = saved;

  console.log("  testReleasePlatformsFromEnv passed");
}

// ─── Store-level edge case tests ──────────────────────────────────────────────

function testStoreEmptyDatabase() {
  const dbPath = path.join(tmp, "db-empty-test.json");
  const store = new Store(dbPath);

  // Leaderboard on empty DB
  const board = store.publicLeaderboard({ range: "today" });
  assert.deepEqual(board, []);

  // Participant detail on missing
  const detail = store.participantDetail("nonexistent", "today");
  assert.equal(detail, null);

  // Admin usage on empty DB
  const usage = store.adminUsage({ range: "today" });
  assert.ok(typeof usage === "object");
  assert.ok(Array.isArray(usage.items));

  // Admin quality on empty DB
  const quality = store.adminQuality();
  assert.ok(typeof quality === "object");

  console.log("  testStoreEmptyDatabase passed");
}

function testStoreZeroTokenItems() {
  const store = new Store(path.join(tmp, "db-zero-tokens.json"));
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId,
    nickname: "zero-user", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });

  store.upsertUsageBatch({
    participantId: identity.participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [{
      day: localDay(), toolCode: "codex", providerId: "codex_local",
      workdirHash: "wd_zero", workdirDisplayName: "zero-project",
      model: "gpt-5", inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      totalTokens: 0, sourceQuality: "exact", sourceFingerprint: "sf_zero"
    }]
  });

  const board = store.publicLeaderboard({ range: "today" });
  assert.equal(board.length, 1);
  assert.equal(board[0].totalTokens, 0);

  console.log("  testStoreZeroTokenItems passed");
}

function testStoreMultiDayRangeLeaderboard() {
  const store = new Store(path.join(tmp, "db-multi-day.json"));
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId,
    nickname: "multi-day-user", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });

  const day1 = "2026-01-10";
  const day2 = "2026-01-11";
  const day3 = "2026-01-12";

  // Upload usage for 3 consecutive days
  for (const day of [day1, day2, day3]) {
    store.upsertUsageBatch({
      participantId: identity.participantId, deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: [{
        day, toolCode: "codex", providerId: "codex_local",
        workdirHash: "wd_multi", workdirDisplayName: "multi-project",
        model: "gpt-5", inputTokens: 100, outputTokens: 50,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        totalTokens: 150, sourceQuality: "exact", sourceFingerprint: `sf_multi_${day}`
      }]
    });
  }

  // "custom" range with startDay/endDay covering all three days
  const customBoard = store.publicLeaderboard({ range: "custom", startDay: day1, endDay: day3 });
  assert.equal(customBoard.length, 1);
  assert.equal(customBoard[0].totalTokens, 450);

  // "custom" range for single day
  const singleDayBoard = store.publicLeaderboard({ range: "custom", startDay: day1, endDay: day1 });
  assert.equal(singleDayBoard.length, 1);
  assert.equal(singleDayBoard[0].totalTokens, 150);

  // "today" range should not show old data
  const todayBoard = store.publicLeaderboard({ range: "today" });
  assert.equal(todayBoard.length, 0);

  console.log("  testStoreMultiDayRangeLeaderboard passed");
}

function testStoreDuplicateDeviceRegistrationSameKey() {
  const store = new Store(path.join(tmp, "db-dup-device.json"));
  const identity = generateIdentity();
  const d1 = newId("d");

  store.registerDevice({
    participantId: identity.participantId, deviceId: d1,
    nickname: "dup-user", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });

  // Re-register same device with same key should succeed
  store.registerDevice({
    participantId: identity.participantId, deviceId: d1,
    nickname: "dup-user", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });

  const devices = store.adminDevices();
  const myDevices = devices.filter(d => d.participantId === identity.participantId);
  assert.equal(myDevices.length, 1);

  console.log("  testDuplicateDeviceRegistrationSameKey passed");
}

function testStoreCorruptJsonRecovery() {
  const dbPath = path.join(tmp, "db-corrupt-test.json");
  fs.writeFileSync(dbPath, "{ corrupt json !!!");

  // Store throws on corrupt JSON (expected behavior)
  assert.throws(() => new Store(dbPath), /SyntaxError|JSON/);

  console.log("  testStoreCorruptJsonRecovery passed");
}

function testStoreLargeTokenValues() {
  const store = new Store(path.join(tmp, "db-large-tokens.json"));
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId,
    nickname: "large-user", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });

  // Very large token counts
  const largeTokens = Number.MAX_SAFE_INTEGER;
  store.upsertUsageBatch({
    participantId: identity.participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [{
      day: localDay(), toolCode: "codex", providerId: "codex_local",
      workdirHash: "wd_large", workdirDisplayName: "large-project",
      model: "gpt-5", inputTokens: largeTokens, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      totalTokens: largeTokens, sourceQuality: "exact", sourceFingerprint: "sf_large"
    }]
  });

  const board = store.publicLeaderboard({ range: "today" });
  assert.equal(board.length, 1);
  assert.equal(board[0].totalTokens, largeTokens);

  console.log("  testStoreLargeTokenValues passed");
}

function testStoreWorkdirAliasPersistence() {
  const store = new Store(path.join(tmp, "db-workdir-persist.json"));
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId,
    nickname: "wd-persist", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });

  // Upload usage creating a workdir entry
  store.upsertUsageBatch({
    participantId: identity.participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [{
      day: localDay(), toolCode: "codex", providerId: "codex_local",
      workdirHash: "wd_persist", workdirDisplayName: "original",
      model: "gpt-5", inputTokens: 100, outputTokens: 50,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      totalTokens: 150, sourceQuality: "exact", sourceFingerprint: "sf_persist"
    }]
  });

  // Reload from disk
  const store2 = new Store(path.join(tmp, "db-workdir-persist.json"));
  const workdirs = Object.values(store2.db.workdirs).filter(w => w.participantId === identity.participantId);
  assert.equal(workdirs.length, 1);
  assert.equal(workdirs[0].workdirHash, "wd_persist");

  console.log("  testStoreWorkdirAliasPersistence passed");
}

function testStoreParticipantDetailMissingDay() {
  const store = new Store(path.join(tmp, "db-detail-missing.json"));
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId,
    nickname: "detail-user", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });

  const detail = store.participantDetail(identity.participantId, "2020-01-01");
  // Should return null or empty structure, not throw
  assert.ok(detail === null || detail);

  console.log("  testStoreParticipantDetailMissingDay passed");
}

function testStoreBoardSummaryEmpty() {
  const store = new Store(path.join(tmp, "db-summary-empty.json"));
  const summary = store.boardSummary();
  assert.ok(summary);
  assert.equal(summary.totalParticipants || summary.participantCount || 0, 0);

  console.log("  testStoreBoardSummaryEmpty passed");
}

// ─── HTTP API edge case tests ─────────────────────────────────────────────────

async function testMalformedJsonPayload() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json {{{"
    });
    assert.ok(res.status >= 400, `expected error status, got ${res.status}`);
  } finally {
    await cleanup();
  }
  console.log("  testMalformedJsonPayload passed");
}

async function testMissingContentTypeHeader() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      body: JSON.stringify({ participantId: "p1", deviceId: "d1", nickname: "test" })
    });
    // Should either work or return error, not crash
    assert.ok(res.status >= 200);
  } finally {
    await cleanup();
  }
  console.log("  testMissingContentTypeHeader passed");
}

async function testEmptyBodyPost() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: ""
    });
    assert.ok(res.status >= 400, `expected error status, got ${res.status}`);
  } finally {
    await cleanup();
  }
  console.log("  testEmptyBodyPost passed");
}

async function testUsageUploadMissingRequiredFields() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const identity = generateIdentity();
    const deviceId = newId("d");

    // Register device
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId, deviceId,
        nickname: "missing-fields-user",
        identityPublicKey: identity.identityPublicKey,
        os: "test", appVersion: APP_VERSION
      })
    });

    // Upload with missing required fields
    const payload = {
      participantId: identity.participantId, deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: [{ day: "2026-05-14", model: "gpt-5" }] // missing toolCode, providerId, etc.
    };
    const sig = signPayload(identity.identityPrivateKey, payload);
    const res = await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": sig },
      body: JSON.stringify(payload)
    });
    assert.ok(res.status >= 400, `expected error for missing fields, got ${res.status}`);
  } finally {
    await cleanup();
  }
  console.log("  testUsageUploadMissingRequiredFields passed");
}

async function testDeviceRegistrationWithConflictingKey() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const identity = generateIdentity();
    const d1 = newId("d");
    const d2 = newId("d");

    // First registration
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId, deviceId: d1,
        nickname: "user1", identityPublicKey: identity.identityPublicKey,
        os: "test", appVersion: APP_VERSION
      })
    });

    // Second registration with different device but different key should fail
    const otherIdentity = generateIdentity();
    const res = await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId, deviceId: d2,
        nickname: "user2", identityPublicKey: otherIdentity.identityPublicKey,
        os: "test", appVersion: APP_VERSION
      })
    });
    assert.ok(res.status >= 400, `expected error for conflicting key, got ${res.status}`);
  } finally {
    await cleanup();
  }
  console.log("  testDeviceRegistrationWithConflictingKey passed");
}

async function testUsageUploadNegativeTokens() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const identity = generateIdentity();
    const deviceId = newId("d");
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId, deviceId,
        nickname: "neg-user", identityPublicKey: identity.identityPublicKey,
        os: "test", appVersion: APP_VERSION
      })
    });

    const payload = {
      participantId: identity.participantId, deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: [{
        day: localDay(), toolCode: "codex", providerId: "codex_local",
        workdirHash: "wd_neg", workdirDisplayName: "neg",
        model: "gpt-5", inputTokens: -100, outputTokens: 50,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        totalTokens: -50, sourceQuality: "exact", sourceFingerprint: "sf_neg"
      }]
    };
    const sig = signPayload(identity.identityPrivateKey, payload);
    const res = await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": sig },
      body: JSON.stringify(payload)
    });
    assert.ok(res.status >= 400, `expected error for negative tokens, got ${res.status}`);
  } finally {
    await cleanup();
  }
  console.log("  testUsageUploadNegativeTokens passed");
}

async function testHealthEndpointDetails() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.serverVersion);
  } finally {
    await cleanup();
  }
  console.log("  testHealthEndpointDetails passed");
}

async function testModelPricesPublicEndpointStructure() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/model-prices`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(typeof data === "object" || Array.isArray(data));
  } finally {
    await cleanup();
  }
  console.log("  testModelPricesPublicEndpointStructure passed");
}

async function testLeaderboardWithNoData() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/leaderboard`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.items));
    assert.equal(data.items.length, 0);
  } finally {
    await cleanup();
  }
  console.log("  testLeaderboardWithNoData passed");
}

async function testUsageUploadForbiddenFields() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const identity = generateIdentity();
    const deviceId = newId("d");
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId, deviceId,
        nickname: "forbidden-user", identityPublicKey: identity.identityPublicKey,
        os: "test", appVersion: APP_VERSION
      })
    });

    const payload = {
      participantId: identity.participantId, deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: [{
        day: localDay(), toolCode: "codex", providerId: "codex_local",
        workdirHash: "wd_forbidden", workdirDisplayName: "forbidden",
        model: "gpt-5", inputTokens: 100, outputTokens: 50,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        totalTokens: 150, sourceQuality: "exact", sourceFingerprint: "sf_forbidden",
        prompt: "this should be rejected",
        assistantResponse: "this too"
      }]
    };
    const sig = signPayload(identity.identityPrivateKey, payload);
    const res = await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": sig },
      body: JSON.stringify(payload)
    });
    assert.ok(res.status >= 400, `expected error for forbidden fields, got ${res.status}`);
  } finally {
    await cleanup();
  }
  console.log("  testUsageUploadForbiddenFields passed");
}

// ─── Changelog and preset edge case tests ─────────────────────────────────────

function testParseChangelogEmptyInput() {
  assert.equal(parseLatestChangelog(""), null);
  assert.equal(parseLatestChangelog(null), null);
  assert.equal(parseLatestChangelog(undefined), null);
  console.log("  testParseChangelogEmptyInput passed");
}

function testParseChangelogNoMatchingVersion() {
  const md = "## [0.5.0] - 2026-01-01\n\n### Features\n- [Desktop] Something\n";
  assert.equal(parseChangelogVersion(md, "0.99.0"), null);
  console.log("  testParseChangelogNoMatchingVersion passed");
}

function testParseChangelogDividerTruncation() {
  const md = "## [0.7.0] - 2026-05-22\n\n### Features\n- [Desktop] Feature A\n- [Web] Feature B\n\n---\n\n### Internal\n- Internal refactor\n";
  const result = parseLatestChangelog(md);
  assert.ok(result);
  assert.equal(result.version, "0.7.0");
  // Items after divider should be excluded
  const allItems = result.sections.flatMap(s => s.items);
  assert.ok(allItems.some(i => i.text.includes("Feature A")));
  assert.ok(!allItems.some(i => i.text.includes("Internal refactor")));

  console.log("  testParseChangelogDividerTruncation passed");
}

function testLoadBuildPresetEdgeCases() {
  // Nonexistent path returns empty
  const empty = loadBuildPreset("/nonexistent/path");
  assert.deepEqual(empty, {});

  // Preset with mixed keys - only allowed keys pass through
  const appDir = path.join(tmp, "preset-app-mixed");
  const assetsDir = path.join(appDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "preset.json"), JSON.stringify({
    apiBaseUrl: "https://example.com",
    nickname: "test",
    invalidKey: "should-be-filtered",
    anotherInvalid: true
  }));
  const mixed = loadBuildPreset(appDir);
  assert.equal(mixed.apiBaseUrl, "https://example.com");
  assert.equal(mixed.nickname, "test");
  assert.ok(!mixed.invalidKey);
  assert.ok(!mixed.anotherInvalid);

  // Empty preset file
  fs.writeFileSync(path.join(assetsDir, "preset.json"), "{}");
  const emptyPreset = loadBuildPreset(appDir);
  assert.deepEqual(emptyPreset, {});

  // Corrupted preset file returns empty
  fs.writeFileSync(path.join(assetsDir, "preset.json"), "not json!!!");
  const corrupted = loadBuildPreset(appDir);
  assert.deepEqual(corrupted, {});

  console.log("  testLoadBuildPresetEdgeCases passed");
}

function testPresetAllowedKeysContainsExpected() {
  assert.ok(PRESET_ALLOWED_KEYS.length > 0);
  assert.ok(PRESET_ALLOWED_KEYS.includes("apiBaseUrl"));
  assert.ok(PRESET_ALLOWED_KEYS.includes("nickname"));
  assert.ok(!PRESET_ALLOWED_KEYS.includes("invalidKey"));
  console.log("  testPresetAllowedKeysContainsExpected passed");
}

// ─── Composition edge case tests ──────────────────────────────────────────────

function testCompositionAllZero() {
  const comp = createEmptyComposition();
  assert.equal(comp.inputTokens, 0);
  assert.equal(comp.outputTokens, 0);
  assert.equal(comp.totalTokens, 0);

  // compositionRatio returns a number (0 when total is 0)
  const ratio = compositionRatio(comp);
  assert.equal(ratio, 0);

  const summary = tokenCompositionSummary(comp);
  assert.ok(typeof summary === "string");

  console.log("  testCompositionAllZero passed");
}

function testCompositionMergeWithZeros() {
  const a = createEmptyComposition();
  const b = createEmptyComposition();
  const merged = mergeTokenComposition(a, b);
  assert.equal(merged.inputTokens, 0);
  assert.equal(merged.outputTokens, 0);

  console.log("  testCompositionMergeWithZeros passed");
}

function testDominantCompositionTie() {
  const comp = { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const result = dominantComposition(comp);
  assert.ok(result); // Should return some category even on tie

  console.log("  testDominantCompositionTie passed");
}

// ─── Board anonymizer edge case tests ─────────────────────────────────────────

function testBoardAnonymizerConsistency() {
  const saltPath = path.join(tmp, "salt-consistency.txt");
  const salt = loadOrGenerateSalt(saltPath);
  const anon = new BoardAnonymizer(salt);

  const pid = "p_test_consistency";
  // Same participant should get consistent public ID
  const id1 = anon.getPublicId(pid);
  const id2 = anon.getPublicId(pid);
  assert.equal(id1, id2);

  // Different participants get different IDs
  const id3 = anon.getPublicId("p_other");
  assert.notEqual(id1, id3);

  console.log("  testBoardAnonymizerConsistency passed");
}

// ─── i18n completeness tests
testLegacyEd25519PemCompatibility();
testI18nCompleteness();
testI18nDataAttributesMatchKeys();

// MySQL incremental sync tests
await testMysqlHourlySnapshotUsesIncrementalSync();
await testMysqlHourlyIncrementalSyncScopesDeletes();
await testMysqlLoadSkipsUsageMirrors();
await testMysqlReadPathUsesRequestScopedRows();
await testMysqlDeleteDeviceDataClearsCloudSyncScopesFromSql();
await testMysqlModelPriceRecalculationIsModelScoped();
await testMysqlFullPriceRecalculationUsesBatches();

// Cloud provider dedup tests
testCursorSameAccountDedupAcrossDevices();
testDeleteCloudDeviceForcesEarlierDeviceReupload();
testCursorDifferentAccountsNoDedup();
testLocalProviderNoDedup();
testCursorDedupSyncBucketPreserved();
testCursorDedupDailyDerivedCorrectly();

// Sync-state tests
testSyncStateReturnsMissingAndMatched();
testSyncStateAfterResetDetectsMissing();
testDeleteParticipantDataClearsHourlySyncState();

// ─── New edge case tests ────────────────────────────────────────────────────

// Crypto edge cases
testCanonicalJson();
testSha256Hex();
testSignVerifyEdgeCases();
testNewIdUniqueness();

// Date edge cases
testDayToUtcDate();
testUtcDateToDay();
testAddDaysEdgeCases();
testDaysBetweenEdgeCases();
testLocalDayEdgeCases();

// Pricing edge cases
testNormalizeModelName();
testMergeCostQuality();
testAggregateCost();
testPriceToPublic();
testAddCostToUsageItem();

// Schema edge cases
testCloudNaturalKey();
testTodayLocal();
testAssertSnapshotHourlyBounds();
testCloudProviderIdsSet();

// Version edge cases
testCompareSemver();
testNormalizeClientMetadata();
testClientPlatformVariants();
testCollectNetworkInfo();
testPackageVersionAndBaseline();

// Display edge cases
testFormatTokenCompactEdgeCases();
testFormatTokenRaw();
testFormatUsdEdgeCases();

// Update/release edge cases
testBuildLatestYml();
testSha512Base64();
testBuildReleaseManifest();
testValidateReleaseManifest();
testSelectUpdateArtifact();
testSelectInstallerArtifact();
testUpdateStateFromManifest();
testReleasePlatformsFromEnv();

// Store edge cases
testStoreEmptyDatabase();
testStoreZeroTokenItems();
testStoreMultiDayRangeLeaderboard();
testStoreDuplicateDeviceRegistrationSameKey();
testStoreCorruptJsonRecovery();
testStoreLargeTokenValues();
testStoreWorkdirAliasPersistence();
testStoreParticipantDetailMissingDay();
testStoreBoardSummaryEmpty();

// HTTP API edge cases
await testMalformedJsonPayload();
await testMissingContentTypeHeader();
await testEmptyBodyPost();
await testUsageUploadMissingRequiredFields();
await testDeviceRegistrationWithConflictingKey();
await testUsageUploadNegativeTokens();
await testHealthEndpointDetails();
await testModelPricesPublicEndpointStructure();
await testLeaderboardWithNoData();
await testUsageUploadForbiddenFields();

// Changelog and preset edge cases
testParseChangelogEmptyInput();
testParseChangelogNoMatchingVersion();
testParseChangelogDividerTruncation();
testLoadBuildPresetEdgeCases();
testPresetAllowedKeysContainsExpected();

// Composition edge cases
testCompositionAllZero();
testCompositionMergeWithZeros();
testDominantCompositionTie();

// Board anonymizer edge cases
testBoardAnonymizerConsistency();

console.log("All tests passed");
