import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Store, ANALYTICS_ALL_CACHE_TTL_MS } from "../src/backend/store.js";
import { MySqlStore } from "../src/backend/mysql-store.js";
import { canonicalJson, sha256Hex, generateIdentity, newId, signPayload, hmacSha256Hex, verifyPayload, normalizeLegacyEd25519Pem } from "../src/shared/crypto.js";
import { BoardAnonymizer, loadOrGenerateSalt, loadNames, todayStr } from "../src/backend/board-anonymizer.js";
import { assertNoForbiddenUploadFields, assertSnapshot, BUCKET_FINGERPRINT_FIELDS, computeBucketFingerprint, computeDailyBucketFingerprint, displayTotalTokens, USAGE_CACHE_VERSION, usageKey, normalizeTokenNumber, cloudNaturalKey, todayLocal, CLOUD_PROVIDER_IDS } from "../src/shared/schema.js";
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
import { formatContributionPercent, formatTokenCompact, formatTokenRaw, formatUsd } from "../src/shared/display.js";
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

if (!process.env.APP_TIME_ZONE && !process.env.TZ) {
  process.env.APP_TIME_ZONE = "Asia/Shanghai";
}

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
  const lightTrend = store.participantTrend(identity.participantId, { grain: "day", range: "last30", fields: "totals" });
  assert.ok(lightTrend.items.length >= 1, "fields=totals keeps aggregated day rows");
  assert.ok(lightTrend.items[0].totalTokens >= 0);
  assert.ok(!Object.hasOwn(lightTrend.items[0], "models"), "fields=totals strips model breakdowns");
  assert.ok(!Object.hasOwn(lightTrend.items[0], "workdirs"), "fields=totals strips workdir breakdowns");
  assert.ok(!Object.hasOwn(lightTrend.items[0], "providers"), "fields=totals strips provider breakdowns");
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
        deviceId: "d_missing",
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
  assert.equal(d2Summary.allTimeTokens, 300);
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

function testExportDailyCsv() {
  const identity = generateIdentity();
  const store = new Store(path.join(tmp, "db-export-csv.json"));
  const deviceId = newId("d");
  const today = localDay();
  store.registerDevice({
    participantId: identity.participantId,
    deviceId,
    nickname: "csv-user",
    identityPublicKey: identity.identityPublicKey,
    os: "test",
    appVersion: APP_VERSION
  });
  store.upsertUsageBatch({
    participantId: identity.participantId,
    deviceId,
    clientGeneratedAt: "2026-05-07T00:00:00.000Z",
    items: [
      {
        day: today,
        toolCode: "codex",
        providerId: "codex_local",
        workdirHash: "wd_csv",
        workdirDisplayName: "csv-project",
        model: "gpt-5",
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        reasoningTokens: 20,
        totalTokens: 155,
        sourceQuality: "exact",
        rawSourceRef: "csv.jsonl",
        providerVersion: "0.1.0",
        parserVersion: "0.1.0",
        sourceFingerprint: "csv-fp-1"
      }
    ]
  });

  const rows = store.exportDailyCsv({ range: "today" });
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.day, today);
  assert.equal(row.nickname, "csv-user");
  assert.equal(row.workdirDisplayName, "csv-project");
  assert.equal(row.toolCode, "codex");
  assert.equal(row.providerId, "codex_local");
  assert.equal(row.model, "gpt-5");
  assert.equal(row.inputTokens, 100);
  assert.equal(row.outputTokens, 40);
  assert.equal(row.cacheReadTokens, 10);
  assert.equal(row.cacheWriteTokens, 5);
  assert.equal(row.reasoningTokens, 20);
  assert.equal(row.totalTokens, 155);
  assert.equal(row.sourceQuality, "exact");
  assert.ok(row.costQuality === "" || row.costQuality === "unknown_price", `unexpected costQuality: ${row.costQuality}`);
}

function testExportDailyCsvWithCost() {
  const identity = generateIdentity();
  const store = new Store(path.join(tmp, "db-export-csv-cost.json"));
  const deviceId = newId("d");
  const today = localDay();
  store.registerDevice({
    participantId: identity.participantId,
    deviceId,
    nickname: "csv-cost-user",
    identityPublicKey: identity.identityPublicKey,
    os: "test",
    appVersion: APP_VERSION
  });
  store.upsertModelPrice({ model: "gpt-5", inputCostPerMTok: 2, outputCostPerMTok: 8, cacheReadCostPerMTok: 0.5, cacheWriteCostPerMTok: 1 });
  store.upsertUsageBatch({
    participantId: identity.participantId,
    deviceId,
    clientGeneratedAt: "2026-05-07T00:00:00.000Z",
    items: [
      {
        day: today,
        toolCode: "codex",
        providerId: "codex_local",
        workdirHash: "wd_csv_cost",
        workdirDisplayName: "csv-cost-project",
        model: "gpt-5",
        inputTokens: 1000000,
        outputTokens: 500000,
        cacheReadTokens: 100000,
        cacheWriteTokens: 50000,
        reasoningTokens: 0,
        totalTokens: 1650000,
        sourceQuality: "exact",
        rawSourceRef: "csv-cost.jsonl",
        providerVersion: "0.1.0",
        parserVersion: "0.1.0",
        sourceFingerprint: "csv-cost-fp"
      }
    ]
  });

  const rows = store.exportDailyCsv({ range: "today" });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(typeof row.estimatedCostUsd, "number");
  assert.ok(row.estimatedCostUsd > 0);
  assert.equal(row.costQuality, "exact_price");
}

function testExportDailyCsvFiltersByParticipant() {
  const identity1 = generateIdentity();
  const identity2 = generateIdentity();
  const store = new Store(path.join(tmp, "db-export-csv-filter.json"));
  const today = localDay();
  store.registerDevice({ participantId: identity1.participantId, deviceId: newId("d"), nickname: "user1", identityPublicKey: identity1.identityPublicKey, os: "test", appVersion: APP_VERSION });
  store.registerDevice({ participantId: identity2.participantId, deviceId: newId("d"), nickname: "user2", identityPublicKey: identity2.identityPublicKey, os: "test", appVersion: APP_VERSION });
  store.upsertUsageBatch({ participantId: identity1.participantId, deviceId: newId("d"), clientGeneratedAt: "2026-05-07T00:00:00.000Z", items: [{ day: today, toolCode: "codex", providerId: "codex_local", workdirHash: "wd1", workdirDisplayName: "proj1", model: "gpt-5", inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 140, sourceQuality: "exact", rawSourceRef: "a.jsonl", providerVersion: "0.1.0", parserVersion: "0.1.0", sourceFingerprint: "fp-a" }] });
  store.upsertUsageBatch({ participantId: identity2.participantId, deviceId: newId("d"), clientGeneratedAt: "2026-05-07T00:00:00.000Z", items: [{ day: today, toolCode: "claude", providerId: "claude_code_local", workdirHash: "wd2", workdirDisplayName: "proj2", model: "claude-sonnet-4-20250514", inputTokens: 200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 280, sourceQuality: "exact", rawSourceRef: "b.jsonl", providerVersion: "0.1.0", parserVersion: "0.1.0", sourceFingerprint: "fp-b" }] });

  const allRows = store.exportDailyCsv({ range: "today" });
  assert.equal(allRows.length, 2);

  const user1Rows = store.exportDailyCsv({ range: "today", participantId: identity1.participantId });
  assert.equal(user1Rows.length, 1);
  assert.equal(user1Rows[0].nickname, "user1");
}

function testExportDailyCsvEmpty() {
  const store = new Store(path.join(tmp, "db-export-csv-empty.json"));
  const rows = store.exportDailyCsv({ range: "today" });
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 0);
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
      bucketFingerprint: computeDailyBucketFingerprint(snapshotItems),
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

function makeMysqlUsageRow(item, participantId, deviceId, overrides = {}) {
  const row = {
    ...item,
    participantId,
    deviceId,
    workdirId: `${participantId}:${item.workdirHash}`,
    rawSourceRef: item.rawSourceRef || "",
    providerVersion: item.providerVersion || "",
    parserVersion: item.parserVersion || "",
    uploadedAt: item.uploadedAt || "2026-05-14T00:00:00.000Z",
    ...overrides
  };
  return {
    usageKey: usageKey(row, participantId, deviceId),
    ...row
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
  const serverFingerprint = computeDailyBucketFingerprint(staleFingerprintPayload.items);
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

function testHourlySnapshotMixedCaseModelMerges() {
  const tmp = path.join(os.tmpdir(), `test-hourly-mixed-case-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_mixed_case", did = "d_mixed_case";
  store.registerDevice({
    participantId: pid, deviceId: did,
    nickname: "mixed-case", identityPublicKey: "pk_mixed", os: "test", appVersion: "0.1.0"
  });

  // Reproduces the dev-server incident: hour 17 synced first with lowercase model,
  // hour 12 arrives later with uppercase model for the SAME workdir. deriveDailyFromHourly
  // must not produce two daily rows whose usageKey differs only by model casing
  // (MySQL utf8mb4_unicode_ci PRIMARY KEY would reject the second one with ER_DUP_ENTRY).
  const hour17 = makeHourlySnapshotPayload([
    makeSnapshotItem({ hour: 17, workdirHash: "wh_default", model: "glm-5.3", inputTokens: 100, outputTokens: 0, totalTokens: 100 })
  ], pid, did, { hour: 17 });
  const hour12 = makeHourlySnapshotPayload([
    makeSnapshotItem({ hour: 12, workdirHash: "wh_default", model: "GLM-5.3", inputTokens: 200, outputTokens: 0, totalTokens: 200 }),
    makeSnapshotItem({ hour: 12, workdirHash: "wh_other", model: "GLM-5.3", inputTokens: 50, outputTokens: 0, totalTokens: 50 })
  ], pid, did, { hour: 12 });
  store.upsertUsageBatch(hour17);
  store.upsertUsageBatch(hour12);

  const dailyKeys = Object.keys(store.db.usageDaily);
  assert.equal(dailyKeys.length, 2, "same workdir with mixed-case model must merge into one daily row");
  for (const key of dailyKeys) {
    assert.equal(key, key.toLowerCase(), "usage keys must be stored with normalized model casing");
  }
  const defaultRow = Object.values(store.db.usageDaily).find((row) => row.workdirHash === "wh_default");
  assert.equal(defaultRow.model, "glm-5.3");
  assert.equal(defaultRow.totalTokens, 300, "mixed-case hourly rows must sum into the merged daily row");
  const hourlyKeys = Object.keys(store.db.usageHourly);
  assert.equal(hourlyKeys.length, 3);
  for (const key of hourlyKeys) {
    assert.equal(key, key.toLowerCase(), "hourly usage keys must use normalized model casing");
  }

  // Legacy daily overwrite path must normalize too (legacy upsertUsageBatch items)
  store.upsertUsageBatch({
    participantId: pid, deviceId: did, clientGeneratedAt: new Date().toISOString(),
    items: [makeSnapshotItem({ workdirHash: "wh_legacy", model: "GPT-5.6-Sol" })]
  });
  const legacyRow = Object.values(store.db.usageDaily).find((row) => row.workdirHash === "wh_legacy");
  assert.equal(legacyRow.model, "gpt-5.6-sol", "legacy ingest path must normalize model casing");

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testHourlySnapshotMixedCaseModelMerges passed");
}

function testHourlySnapshotSameBucketCaseCollisionSums() {
  const tmp = path.join(os.tmpdir(), `test-hourly-case-collision-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_case_bucket", did = "d_case_bucket";
  store.registerDevice({
    participantId: pid, deviceId: did,
    nickname: "case-bucket", identityPublicKey: "pk_case_bucket", os: "test", appVersion: "0.1.0"
  });

  // Reproduces the dev-server 2026-08-22 incident: ONE hour bucket contains both
  // model casings for the same workdir. Item-by-item writes kept only the last
  // variant and silently dropped the other variant's tokens; the items must sum.
  const payload = makeHourlySnapshotPayload([
    makeSnapshotItem({
      hour: 15, workdirHash: "wh_control", workdirDisplayName: "control",
      model: "glm-5.3", inputTokens: 16328591, outputTokens: 0, totalTokens: 16328591,
      sourceFingerprint: "sf_collision_lower"
    }),
    makeSnapshotItem({
      hour: 15, workdirHash: "wh_control", workdirDisplayName: "control",
      model: "GLM-5.3", inputTokens: 5131373, outputTokens: 0, totalTokens: 5131373,
      sourceFingerprint: "sf_collision_upper"
    })
  ], pid, did, { hour: 15 });

  const result = store.upsertUsageBatch(payload);
  assert.equal(result.accepted, 2, "accepted counts uploaded items (protocol rowCount), not merged rows");
  assert.equal(result.rejected, 0);
  const hourlyRows = Object.values(store.db.usageHourly).filter((row) => row.workdirHash === "wh_control");
  assert.equal(hourlyRows.length, 1);
  assert.equal(hourlyRows[0].model, "glm-5.3");
  assert.equal(hourlyRows[0].totalTokens, 21459964, "merged row must keep the SUM of both variants");
  const dailyRow = Object.values(store.db.usageDaily).find((row) => row.workdirHash === "wh_control");
  assert.equal(dailyRow.totalTokens, 21459964, "derived daily row must carry the summed total");

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testHourlySnapshotSameBucketCaseCollisionSums passed");
}

function testHourlySnapshotPoisonedBucketHealsOnReupload() {
  const tmp = path.join(os.tmpdir(), `test-hourly-heal-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_case_heal", did = "d_case_heal";
  store.registerDevice({
    participantId: pid, deviceId: did,
    nickname: "case-heal", identityPublicKey: "pk_case_heal", os: "test", appVersion: "0.1.0"
  });

  const payload = makeHourlySnapshotPayload([
    makeSnapshotItem({
      hour: 10, workdirHash: "wh_repo", workdirDisplayName: "repo",
      model: "glm-5.3", inputTokens: 16551461, outputTokens: 0, totalTokens: 16551461,
      sourceFingerprint: "sf_heal_lower"
    }),
    makeSnapshotItem({
      hour: 10, workdirHash: "wh_repo", workdirDisplayName: "repo",
      model: "GLM-5.3", inputTokens: 8410422, outputTokens: 0, totalTokens: 8410422,
      sourceFingerprint: "sf_heal_upper"
    })
  ], pid, did, { hour: 10 });
  store.upsertUsageBatch(payload);

  // Simulate legacy damage: the stored row keeps only the surviving variant's
  // tokens while the bucket metadata still matches the uploaded fingerprint.
  // A metadata-only idempotency check would no-op forever and never heal.
  const key = Object.keys(store.db.usageHourly).find((k) => k.includes("wh_repo"));
  const damaged = store.db.usageHourly[key];
  store.db.usageHourly[key] = { ...damaged, inputTokens: 8410422, totalTokens: 8410422 };

  const heal = store.upsertUsageBatch(payload);
  assert.notEqual(heal.noOp, true, "metadata match must not no-op when stored rows lost tokens");
  assert.equal(heal.accepted, 2, "accepted counts uploaded items even when they merge into one row");
  assert.equal(store.db.usageHourly[key].totalTokens, 24961883, "re-upload must restore the summed row");
  const healedDaily = Object.values(store.db.usageDaily).find((row) => row.workdirHash === "wh_repo");
  assert.equal(healedDaily.totalTokens, 24961883, "derived daily row must be healed too");

  // Once healed, the same upload is a stable no-op (no repair churn).
  const again = store.upsertUsageBatch(payload);
  assert.equal(again.noOp, true, "healed bucket must go back to no-op");
  assert.equal(again.accepted, 2, "no-op reports the recorded item count");
  assert.equal(store.db.usageHourly[key].totalTokens, 24961883);

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testHourlySnapshotPoisonedBucketHealsOnReupload passed");
}

async function testMysqlReadBackNormalizesModelCasing() {
  const store = new MySqlStore({ writeLockName: "" });
  const pid = "p_rb_case", did = "d_rb_case";

  // Simulate a MySQL read-back where stored rows carry mixed-case models for the
  // same workdir (the exact state that wedged the retry queue). loadWriteScope must
  // index rows under recomputed normalized keys so the next scope sync rewrites the
  // day with a single casing instead of inserting both variants.
  const legacyDailyRows = [
    {
      usageKey: "2026-08-16|p_rb_case|d_rb_case|zcode|zcode_local|wh_default|GLM-5.3",
      day: "2026-08-16", participantId: pid, deviceId: did,
      toolCode: "zcode", providerId: "zcode_local",
      workdirId: `${pid}:wh_default`, workdirHash: "wh_default", workdirDisplayName: "default",
      model: "GLM-5.3", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, totalTokens: 3, estimatedCostUsd: null, costQuality: "",
      pricingVersion: "", pricingModel: "", pricingSource: "", sourceQuality: "exact",
      rawSourceRef: "", providerVersion: "", parserVersion: "", sourceFingerprint: "sf_a", uploadedAt: ""
    },
    {
      usageKey: "2026-08-16|p_rb_case|d_rb_case|zcode|zcode_local|wh_default|glm-5.3",
      day: "2026-08-16", participantId: pid, deviceId: did,
      toolCode: "zcode", providerId: "zcode_local",
      workdirId: `${pid}:wh_default`, workdirHash: "wh_default", workdirDisplayName: "default",
      model: "glm-5.3", inputTokens: 4, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, totalTokens: 9, estimatedCostUsd: null, costQuality: "",
      pricingVersion: "", pricingModel: "", pricingSource: "", sourceQuality: "exact",
      rawSourceRef: "", providerVersion: "", parserVersion: "", sourceFingerprint: "sf_b", uploadedAt: ""
    }
  ];
  store.pool = {
    query: async (sql) => {
      if (sql.includes("FROM usage_daily")) return [legacyDailyRows];
      if (sql.includes("FROM usage_hourly")) return [[]];
      return [[]];
    }
  };
  await store.loadWriteScope(pid, did, { day: "2026-08-16", providerId: "zcode_local" });

  const dailyKeys = Object.keys(store.db.usageDaily);
  assert.equal(dailyKeys.length, 1, "mixed-case read-back rows must collapse onto one normalized key");
  assert.equal(dailyKeys[0], "2026-08-16|p_rb_case|d_rb_case|zcode|zcode_local|wh_default|glm-5.3");
  assert.equal(Object.values(store.db.usageDaily)[0].model, "glm-5.3");
  console.log("  testMysqlReadBackNormalizesModelCasing passed");
}

async function testMysqlBatchSetIsolatesPoisonedBucket() {
  const store = new MySqlStore({ writeLockName: "" });
  const pid = "p_mysql_poison", did = "d_mysql_poison";
  Store.prototype.registerDevice.call(store, {
    participantId: pid, deviceId: did,
    nickname: "mysql-poison", identityPublicKey: "pk_mysql_poison", os: "test", appVersion: "0.1.0"
  });

  const healthy = makeHourlySnapshotPayload([
    makeSnapshotItem({ hour: 10, workdirHash: "mp_h10", sourceFingerprint: "mp_sf_10" })
  ], pid, did, { hour: 10 });
  const poisoned = makeHourlySnapshotPayload([
    makeSnapshotItem({ hour: 11, workdirHash: "mp_h11", sourceFingerprint: "mp_sf_11" })
  ], pid, did, { hour: 11, providerId: "claude_code_local" });

  // Stub the MySQL sync layer: the healthy bucket syncs fine, the poisoned one
  // throws the way a real ER_DUP_ENTRY would propagate out of the transaction.
  // load() is stubbed because upsertUsageBatch's error path reloads full state
  // from MySQL before rethrowing, and this test store has no pool.
  store.load = async () => {};
  store.incrementalHourlyBucketSync = async (input) => {
    if (input.snapshot.providerId === "claude_code_local") {
      throw new Error("Duplicate entry 'x' for key 'PRIMARY'");
    }
  };

  const result = await store.upsertUsageBatchSet({
    participantId: pid,
    deviceId: did,
    clientGeneratedAt: new Date().toISOString(),
    batches: [
      { snapshot: healthy.snapshot, items: healthy.items },
      { snapshot: poisoned.snapshot, items: poisoned.items }
    ]
  });

  assert.equal(result.failedBucketCount, 1, "poisoned MySQL bucket is isolated");
  assert.equal(result.accepted, 1, "healthy MySQL bucket still counts as accepted");
  const failedResult = result.results.find((r) => r.failed);
  assert.equal(failedResult.index, 1);
  assert.match(failedResult.error, /Duplicate entry/);
  console.log("  testMysqlBatchSetIsolatesPoisonedBucket passed");
}

async function testMysqlHourlySnapshotUsesIncrementalSync() {
  const store = new MySqlStore({});
  const pid = "p_mysql_hourly", did = "d_mysql_hourly";
  Store.prototype.registerDevice.call(store, {
    participantId: pid, deviceId: did,
    nickname: "mysql-hourly", identityPublicKey: "pk_mysql_hourly", os: "test", appVersion: "0.1.0"
  });

  let incrementalCalled = false;
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
  assert.equal(typeof store.syncAllTables, "undefined", "syncAllTables full-table flush must not exist on MySqlStore");
  assert.equal(typeof store.syncUsageDaily, "undefined", "syncUsageDaily full-table flush must not exist on MySqlStore");
  console.log("  testMysqlHourlySnapshotUsesIncrementalSync passed");
}

async function testMysqlUsageWritesAreSerialized() {
  const store = new MySqlStore({});
  const pid = "p_mysql_lock", did = "d_mysql_lock";
  Store.prototype.registerDevice.call(store, {
    participantId: pid, deviceId: did,
    nickname: "mysql-lock", identityPublicKey: "pk_mysql_lock", os: "test", appVersion: "0.7.1"
  });

  store.pool = {};
  let active = 0;
  let maxActive = 0;
  store.loadWriteScope = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  store.incrementalHourlyBucketSync = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
  };

  await Promise.all([
    store.upsertUsageBatch(makeHourlySnapshotPayload([
      makeSnapshotItem({ hour: 10, workdirHash: "mysql_lock_a", sourceFingerprint: "mysql_lock_a" })
    ], pid, did, { day: "2026-05-14", hour: 10, providerId: "codex_local" })),
    store.upsertUsageBatch(makeHourlySnapshotPayload([
      makeSnapshotItem({ hour: 11, workdirHash: "mysql_lock_b", sourceFingerprint: "mysql_lock_b" })
    ], pid, did, { day: "2026-05-14", hour: 11, providerId: "codex_local" }))
  ]);

  assert.equal(maxActive, 1, "MySQL usage writes must not share mutable in-memory scope concurrently");
  assert.equal(active, 0);
  console.log("  testMysqlUsageWritesAreSerialized passed");
}

async function testMysqlUsageWritesUseDistributedLock() {
  const storeA = new MySqlStore({ writeLockName: "atl-test-distributed-lock" });
  const storeB = new MySqlStore({ writeLockName: "atl-test-distributed-lock" });
  const pid = "p_mysql_dist_lock", did = "d_mysql_dist_lock";
  for (const store of [storeA, storeB]) {
    Store.prototype.registerDevice.call(store, {
      participantId: pid, deviceId: did,
      nickname: "mysql-dist-lock", identityPublicKey: "pk_mysql_dist_lock", os: "test", appVersion: "0.7.1"
    });
  }

  let dbLocked = false;
  const waiters = [];
  const lockEvents = [];
  const pool = {
    async getConnection() {
      return {
        async query(sql, params = []) {
          const normalized = String(sql).replace(/\s+/g, " ").trim();
          if (normalized.startsWith("SELECT GET_LOCK")) {
            while (dbLocked) {
              await new Promise((resolve) => waiters.push(resolve));
            }
            dbLocked = true;
            lockEvents.push({ type: "acquire", name: params[0] });
            return [[{ acquired: 1 }], []];
          }
          if (normalized.startsWith("SELECT RELEASE_LOCK")) {
            dbLocked = false;
            lockEvents.push({ type: "release", name: params[0] });
            waiters.shift()?.();
            return [[{ released: 1 }], []];
          }
          throw new Error(`unexpected distributed lock query: ${normalized}`);
        },
        release() {}
      };
    }
  };

  let active = 0;
  let maxActive = 0;
  for (const store of [storeA, storeB]) {
    store.pool = pool;
    store.loadWriteScope = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
    };
    store.incrementalHourlyBucketSync = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    };
  }

  await Promise.all([
    storeA.upsertUsageBatch(makeHourlySnapshotPayload([
      makeSnapshotItem({ hour: 10, workdirHash: "mysql_dist_lock_a", sourceFingerprint: "mysql_dist_lock_a" })
    ], pid, did, { day: "2026-05-14", hour: 10, providerId: "codex_local" })),
    storeB.upsertUsageBatch(makeHourlySnapshotPayload([
      makeSnapshotItem({ hour: 11, workdirHash: "mysql_dist_lock_b", sourceFingerprint: "mysql_dist_lock_b" })
    ], pid, did, { day: "2026-05-14", hour: 11, providerId: "codex_local" }))
  ]);

  assert.equal(maxActive, 1, "separate MySqlStore instances must serialize through the MySQL named lock");
  assert.equal(active, 0);
  assert.deepEqual(lockEvents.map((event) => event.type), ["acquire", "release", "acquire", "release"]);
  assert.ok(lockEvents.every((event) => event.name === "atl-test-distributed-lock"));
  console.log("  testMysqlUsageWritesUseDistributedLock passed");
}

async function testMysqlWriteLockTimeoutFailsClosed() {
  const store = new MySqlStore({ writeLockName: "atl-test-timeout-lock", writeLockTimeoutSeconds: 0 });
  const pid = "p_mysql_timeout_lock", did = "d_mysql_timeout_lock";
  Store.prototype.registerDevice.call(store, {
    participantId: pid, deviceId: did,
    nickname: "mysql-timeout-lock", identityPublicKey: "pk_mysql_timeout_lock", os: "test", appVersion: "0.7.1"
  });
  assert.equal(
    store.config.writeLockTimeoutSeconds,
    0,
    "writeLockTimeoutSeconds=0 from config must NOT be replaced by the default"
  );

  let enteredWriteScope = false;
  let observedLockParams = null;
  store.pool = {
    async getConnection() {
      return {
        async query(sql, params) {
          const normalized = String(sql).replace(/\s+/g, " ").trim();
          if (normalized.startsWith("SELECT GET_LOCK")) {
            observedLockParams = params;
            return [[{ acquired: 0 }], []];
          }
          throw new Error(`unexpected timeout lock query: ${normalized}`);
        },
        release() {}
      };
    }
  };
  store.loadWriteScope = async () => {
    enteredWriteScope = true;
  };

  await assert.rejects(
    () => store.upsertUsageBatch(makeHourlySnapshotPayload([
      makeSnapshotItem({ hour: 10, workdirHash: "mysql_timeout_lock", sourceFingerprint: "mysql_timeout_lock" })
    ], pid, did, { day: "2026-05-14", hour: 10, providerId: "codex_local" })),
    /Timed out acquiring MySQL write lock/
  );
  assert.equal(enteredWriteScope, false, "MySQL writes must fail closed when the distributed lock cannot be acquired");
  assert.deepEqual(observedLockParams, ["atl-test-timeout-lock", 0], "GET_LOCK must receive the configured timeout verbatim");
  console.log("  testMysqlWriteLockTimeoutFailsClosed passed");
}

async function testMysqlConnectionLimitFloorsWhenLockEnabled() {
  const lockedDefault = new MySqlStore({ writeLockName: "atl-floor-default", connectionLimit: 1 });
  assert.equal(
    lockedDefault.config.connectionLimit,
    2,
    "connectionLimit must be floored to 2 when the named lock is enabled to avoid deadlock"
  );

  const lockedEnv = new MySqlStore({ writeLockName: "atl-floor-env", connectionLimit: 0 });
  // connectionLimit=0 is invalid and is caught by the `|| 8` fallback in the constructor,
  // so it ends up at the default (8). The hard requirement is "must be >= 2 whenever the
  // named lock is enabled" — the default already satisfies this, so we assert the floor,
  // not the exact value, to avoid coupling to the default constant.
  assert.ok(
    lockedEnv.config.connectionLimit >= 2,
    `connectionLimit=0/invalid must still satisfy the >=2 floor, got ${lockedEnv.config.connectionLimit}`
  );

  const lockedAmple = new MySqlStore({ writeLockName: "atl-floor-ample", connectionLimit: 8 });
  assert.equal(
    lockedAmple.config.connectionLimit,
    8,
    "connectionLimit must not be lowered when caller already requested >= 2"
  );

  const lockDisabled = new MySqlStore({ writeLockName: "", connectionLimit: 1 });
  // writeLockName falls back to the auto-derived name; the floor still applies.
  assert.ok(
    lockDisabled.config.writeLockName.length > 0,
    "writeLockName must default to the auto-derived value"
  );
  assert.equal(
    lockDisabled.config.connectionLimit,
    2,
    "auto-derived lock name still triggers the connectionLimit floor"
  );
  console.log("  testMysqlConnectionLimitFloorsWhenLockEnabled passed");
}

async function testMysqlWriteLockResetsUsageWorkingState() {
  const store = new MySqlStore({});
  const pid = "p_mysql_reset", did = "d_mysql_reset";
  Store.prototype.registerDevice.call(store, {
    participantId: pid, deviceId: did,
    nickname: "mysql-reset", identityPublicKey: "pk_mysql_reset", os: "test", appVersion: "0.7.1"
  });
  store.pool = {};
  store.loadWriteScope = async () => {
    store.db.usageDaily = { "scoped|usage": { participantId: pid, deviceId: did } };
    store.db.usageHourly = { "scoped|usage|hourly": { participantId: pid, deviceId: did } };
    store.db.usageSyncBuckets = { "scoped|bucket": { participantId: pid, deviceId: did } };
    store.db.usageSyncBucketsHourly = { "scoped|bucket|hourly": { participantId: pid, deviceId: did } };
    store.db.uploadBatches = { "scoped|payload": { id: "u1" } };
  };
  let observedDuringWrite = null;
  store.incrementalHourlyBucketSync = async () => {
    observedDuringWrite = {
      usageDaily: Object.keys(store.db.usageDaily).length,
      usageHourly: Object.keys(store.db.usageHourly).length,
      usageSyncBuckets: Object.keys(store.db.usageSyncBuckets).length,
      usageSyncBucketsHourly: Object.keys(store.db.usageSyncBucketsHourly).length,
      uploadBatches: Object.keys(store.db.uploadBatches).length
    };
  };

  await store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ hour: 10, workdirHash: "mysql_reset_h1", sourceFingerprint: "mysql_reset_h1" })
  ], pid, did, { day: "2026-05-14", hour: 10, providerId: "codex_local" }));

  assert.ok(observedDuringWrite, "write lambda must run");
  assert.ok(observedDuringWrite.usageDaily > 0, "loadWriteScope must populate usageDaily during the write");
  assert.deepEqual(Object.keys(store.db.usageDaily), [], "usageDaily must be reset after writeLock release");
  assert.deepEqual(Object.keys(store.db.usageHourly), [], "usageHourly must be reset after writeLock release");
  assert.deepEqual(Object.keys(store.db.usageSyncBuckets), [], "usageSyncBuckets must be reset after writeLock release");
  assert.deepEqual(Object.keys(store.db.usageSyncBucketsHourly), [], "usageSyncBucketsHourly must be reset after writeLock release");
  assert.deepEqual(Object.keys(store.db.uploadBatches), [], "uploadBatches must be reset after writeLock release");
  console.log("  testMysqlWriteLockResetsUsageWorkingState passed");
}

async function testMysqlWriteLockResetsUsageWorkingStateOnError() {
  const store = new MySqlStore({});
  const pid = "p_mysql_reset_err", did = "d_mysql_reset_err";
  Store.prototype.registerDevice.call(store, {
    participantId: pid, deviceId: did,
    nickname: "mysql-reset-err", identityPublicKey: "pk_mysql_reset_err", os: "test", appVersion: "0.7.1"
  });
  store.pool = {};
  store.loadWriteScope = async () => {
    store.db.usageDaily = { "scoped|usage|err": { participantId: pid, deviceId: did } };
  };
  store.load = async () => {};
  store.incrementalHourlyBucketSync = async () => {
    throw new Error("synthetic write failure");
  };

  await assert.rejects(
    () => store.upsertUsageBatch(makeHourlySnapshotPayload([
      makeSnapshotItem({ hour: 10, workdirHash: "mysql_reset_err_h1", sourceFingerprint: "mysql_reset_err_h1" })
    ], pid, did, { day: "2026-05-14", hour: 10, providerId: "codex_local" })),
    /synthetic write failure/
  );
  assert.deepEqual(Object.keys(store.db.usageDaily), [], "usageDaily must be reset even when write throws");
  console.log("  testMysqlWriteLockResetsUsageWorkingStateOnError passed");
}

async function testMysqlLegacyUploadDoesNotFullTableWipe() {
  const store = new MySqlStore({});
  const pid = "p_mysql_legacy", did = "d_mysql_legacy";
  Store.prototype.registerDevice.call(store, {
    participantId: pid, deviceId: did,
    nickname: "mysql-legacy", identityPublicKey: "pk_mysql_legacy", os: "test", appVersion: "0.6.1"
  });

  const unknownExisting = makeMysqlUsageRow(
    makeSnapshotItem({ workdirHash: "mysql_legacy_h1", model: "unknown", sourceFingerprint: "legacy_unknown" }),
    pid,
    did
  );
  const otherExisting = makeMysqlUsageRow(
    makeSnapshotItem({ workdirHash: "mysql_other_h1", sourceFingerprint: "legacy_other" }),
    "p_mysql_other",
    "d_mysql_other"
  );
  const queries = [];
  const conn = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params = []) {
      queries.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
      return [{ affectedRows: 0 }, []];
    }
  };
  store.pool = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      if (normalized === "SELECT * FROM usage_daily") return [[unknownExisting, otherExisting]];
      if (normalized === "SELECT * FROM usage_hourly") return [[]];
      if (normalized === "SELECT * FROM usage_sync_buckets") return [[]];
      if (normalized === "SELECT * FROM usage_sync_buckets_hourly") return [[]];
      if (normalized === "SELECT * FROM upload_batches") return [[]];
      throw new Error(`unexpected query: ${normalized}`);
    },
    getConnection: async () => conn
  };

  const result = await store.upsertUsageBatch({
    participantId: pid,
    deviceId: did,
    clientGeneratedAt: "2026-05-14T01:00:00.000Z",
    items: [makeSnapshotItem({ workdirHash: "mysql_legacy_h1", model: "gpt-5", sourceFingerprint: "legacy_known" })]
  });

  const statements = queries.map((q) => q.sql);
  assert.equal(result.accepted, 1);
  assert.equal(statements.some((sql) => sql === "DELETE FROM usage_daily"), false, "legacy MySQL upload must not wipe usage_daily");
  assert.equal(statements.some((sql) => sql === "DELETE FROM usage_hourly"), false, "legacy MySQL upload must not wipe usage_hourly");
  assert.equal(statements.some((sql) => sql === "DELETE FROM usage_sync_buckets"), false, "legacy MySQL upload must not wipe sync metadata");
  assert.equal(statements.some((sql) => sql === "DELETE FROM usage_sync_buckets_hourly"), false, "legacy MySQL upload must not wipe hourly sync metadata");
  const deleteByKey = queries.find((q) => q.sql.startsWith("DELETE FROM usage_daily WHERE usageKey IN"));
  assert.deepEqual(deleteByKey?.params, [unknownExisting.usageKey], "legacy cleanup should delete only rows removed by business logic");
  assert.ok(statements.some((sql) => sql.startsWith("INSERT INTO usage_daily")), "legacy upload should still upsert usage rows");
  assert.ok(statements.some((sql) => sql.startsWith("INSERT INTO upload_batches")), "legacy upload should still persist upload audit rows");
  console.log("  testMysqlLegacyUploadDoesNotFullTableWipe passed");
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

async function testMysqlFullReconcileDailyFallbackDoesNotRequireHourlyDerivedColumn() {
  const store = new MySqlStore({});
  const pid = "p_mysql_fr", did = "d_mysql_fr", day = "2026-03-10", providerId = "codex_local";
  const usage = {
    usageKey: "u_mysql_fr",
    day,
    hour: 0,
    participantId: pid,
    deviceId: did,
    toolCode: "codex",
    providerId,
    workdirId: `${pid}:h1`,
    workdirHash: "h1",
    workdirDisplayName: "proj",
    model: "gpt-5",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 25,
    cacheWriteTokens: 25,
    reasoningTokens: 0,
    totalTokens: 200,
    estimatedCostUsd: null,
    costQuality: "",
    pricingVersion: "",
    pricingModel: "",
    pricingSource: "",
    sourceQuality: "exact",
    rawSourceRef: "",
    providerVersion: "",
    parserVersion: "",
    sourceFingerprint: "sf1",
    uploadedAt: "2026-03-10T00:00:00.000Z"
  };
  const fp = computeDailyBucketFingerprint([usage]);
  const queries = [];
  store.pool = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push(normalized);
      assert.equal(/hourlyDerived/i.test(normalized), false, "MySQL full reconcile must not reference JSON-only hourlyDerived");
      if (normalized.includes("FROM usage_sync_buckets ")) return [[]];
      if (normalized.includes("FROM usage_daily")) return [[usage]];
      if (normalized.includes("FROM app_meta")) return [[{ metaValue: "srv_test" }]];
      throw new Error(`unexpected query: ${normalized}`);
    }
  };

  const result = await store.compareSyncState({
    participantId: pid,
    deviceId: did,
    mode: "full_reconcile",
    buckets: [{ day, providerId, fingerprint: fp, granularity: "daily" }]
  });
  assert.equal(result.matched.length, 1);
  assert.equal(result.missing.length, 0);
  assert.equal(queries.some((sql) => sql.includes("FROM usage_daily")), true);
  console.log("  testMysqlFullReconcileDailyFallbackDoesNotRequireHourlyDerivedColumn passed");
}

function testMysqlCustomRangePrecedenceMatchesJsonStore() {
  const store = new MySqlStore({});
  store.currentBusinessDay = () => "2026-06-26";
  const mysqlScope = store.mysqlUsageScope({
    period: "today",
    range: "custom",
    startDay: "2026-06-24",
    endDay: "2026-06-25"
  });
  assert.equal(mysqlScope.whereSql, " WHERE day BETWEEN ? AND ?");
  assert.deepEqual(mysqlScope.params, ["2026-06-24", "2026-06-25"]);

  const jsonStore = new Store(path.join(tmp, "db-custom-range-precedence.json"));
  jsonStore.currentBusinessDay = () => "2026-06-26";
  const identity = generateIdentity();
  const deviceId = newId("d");
  jsonStore.registerDevice({
    participantId: identity.participantId,
    deviceId,
    nickname: "custom-precedence",
    identityPublicKey: identity.identityPublicKey,
    os: "test",
    appVersion: APP_VERSION
  });
  jsonStore.upsertUsageBatch({
    participantId: identity.participantId,
    deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [
      {
        day: "2026-06-24",
        toolCode: "codex",
        providerId: "codex_local",
        workdirHash: "custom_precedence",
        workdirDisplayName: "custom-precedence",
        model: "gpt-5",
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 100,
        sourceQuality: "exact",
        sourceFingerprint: "custom-precedence-0624"
      },
      {
        day: "2026-06-26",
        toolCode: "codex",
        providerId: "codex_local",
        workdirHash: "custom_precedence",
        workdirDisplayName: "custom-precedence",
        model: "gpt-5",
        inputTokens: 900,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 900,
        sourceQuality: "exact",
        sourceFingerprint: "custom-precedence-0626"
      }
    ]
  });
  const detail = jsonStore.participantDetail(identity.participantId, {
    period: "today",
    range: "custom",
    startDay: "2026-06-24",
    endDay: "2026-06-25"
  });
  assert.equal(detail.totalTokens, 100);
  assert.deepEqual(detail.rows.map((item) => item.day), ["2026-06-24"]);

  console.log("  testMysqlCustomRangePrecedenceMatchesJsonStore passed");
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

async function testOpenRouterRefreshFetchOutsideLockSplit() {
  // Verifies the split introduced for MySqlStore safety: refreshOpenRouterPrices
  // performs the external HTTP fetch first (so a slow remote does not hold the
  // cross-process MySQL named lock), then calls applyOpenRouterPriceFetch synchronously
  // to mutate cache state. We exercise the split on the JSON Store because
  // applyOpenRouterPriceFetch lives on the base class and MySqlStore re-uses it.
  const originalFetch = globalThis.fetch;

  // Case 1: happy path — prefetched applied directly.
  {
    const store = new Store(path.join(tmp, "openrouter-split-fresh.json"), { persist: false });
    const sample = {
      version: "test-or-fresh",
      generatedAt: "2026-04-30T00:00:00.000Z",
      prices: {
        "openai/gpt-5-test": {
          model: "openai/gpt-5-test",
          inputCostPerMTok: 1,
          outputCostPerMTok: 2,
          cacheReadCostPerMTok: 0,
          cacheWriteCostPerMTok: 0,
          reasoningCostPerMTok: 0,
          source: "openrouter",
          notes: "",
          updatedAt: "2026-04-30T00:00:00.000Z"
        }
      },
      remote: { source: "openrouter", status: "fresh", lastError: "" }
    };
    const result = store.applyOpenRouterPriceFetch(sample, null, {});
    assert.equal(result.remote.status, "fresh");
    assert.equal(result.recalculated, null);
    assert.equal(Object.keys(store.db.modelPriceCache.prices).length, 1);
  }

  // Case 2: fetch failed but prior prices exist → status "stale", prior prices preserved.
  {
    const store = new Store(path.join(tmp, "openrouter-split-stale.json"), { persist: false });
    store.db.modelPriceCache = {
      version: "preexisting",
      generatedAt: "2026-04-29T00:00:00.000Z",
      prices: {
        "openai/gpt-5-test": {
          model: "openai/gpt-5-test",
          inputCostPerMTok: 9,
          outputCostPerMTok: 9,
          cacheReadCostPerMTok: 0,
          cacheWriteCostPerMTok: 0,
          reasoningCostPerMTok: 0,
          source: "openrouter",
          notes: "",
          updatedAt: "2026-04-29T00:00:00.000Z"
        }
      },
      remote: { source: "openrouter", status: "fresh", lastError: "" }
    };
    store.invalidatePriceMap();
    const result = store.applyOpenRouterPriceFetch(null, new Error("network down"), {});
    assert.equal(result.remote.status, "stale");
    assert.equal(result.remote.lastError, "network down");
    assert.equal(Object.keys(store.db.modelPriceCache.prices).length, 1, "prior prices retained on stale");
  }

  // Case 3: fetch failed and no prior prices → status "failed".
  {
    const store = new Store(path.join(tmp, "openrouter-split-failed.json"), { persist: false });
    const result = store.applyOpenRouterPriceFetch(null, new Error("dns lookup failed"), {});
    assert.equal(result.remote.status, "failed");
    assert.equal(result.remote.lastError, "dns lookup failed");
  }

  // Case 4: refreshOpenRouterPrices fetches successfully then applies (full path).
  {
    const store = new Store(path.join(tmp, "openrouter-split-refresh-ok.json"), { persist: false });
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "openai/gpt-5-split",
            canonical_slug: "openai/gpt-5-split-20260430",
            context_length: 128000,
            pricing: { prompt: "0.000001", completion: "0.000002" }
          }
        ]
      })
    });
    try {
      const refreshed = await store.refreshOpenRouterPrices();
      assert.equal(refreshed.remote.status, "fresh");
      assert.equal(Object.keys(store.db.modelPriceCache.prices).length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // Case 5: refreshOpenRouterPrices propagates fetch failure to applyOpenRouterPriceFetch
  // → ends up as "failed" (no prior prices). Proves the wrapper does NOT throw on fetch error.
  {
    const store = new Store(path.join(tmp, "openrouter-split-refresh-fail.json"), { persist: false });
    globalThis.fetch = async () => {
      throw new Error("simulated http timeout");
    };
    try {
      const refreshed = await store.refreshOpenRouterPrices();
      assert.equal(refreshed.remote.status, "failed");
      assert.equal(refreshed.remote.lastError, "simulated http timeout");
      assert.equal(refreshed.recalculated, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // Case 6: recalculate=true on JSON store triggers cost recalc on existing usage rows.
  {
    const store = new Store(path.join(tmp, "openrouter-split-recalc.json"), { persist: false });
    // Seed one daily row that should be re-costed when prices arrive. recalculateCosts
    // on the JSON store iterates db.usageDaily, so we seed there.
    const dailyKey = "2026-04-30|p1|d1|codex|codex_local|wh|openai/gpt-5-recalc";
    store.db.usageDaily = {
      [dailyKey]: {
        usageKey: dailyKey,
        day: "2026-04-30",
        participantId: "p1",
        deviceId: "d1",
        toolCode: "codex",
        providerId: "codex_local",
        workdirHash: "wh",
        workdirDisplayName: "wd",
        model: "openai/gpt-5-recalc",
        inputTokens: 1000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 2000,
        estimatedCostUsd: 0,
        cacheReadCostUsd: 0,
        cacheWriteCostUsd: 0,
        reasoningCostUsd: 0,
        costQuality: "missing_price",
        pricingSource: "",
        pricingVersion: "",
        sourceFingerprint: "sf",
        ingestedAt: "2026-04-30T00:00:00.000Z",
        sourceQuality: "auto"
      }
    };
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "openai/gpt-5-recalc",
            canonical_slug: "openai/gpt-5-recalc-20260430",
            context_length: 128000,
            pricing: { prompt: "0.000010", completion: "0.000030" }
          }
        ]
      })
    });
    try {
      const refreshed = await store.refreshOpenRouterPrices({ recalculate: true });
      assert.equal(refreshed.remote.status, "fresh");
      assert.ok(refreshed.recalculated, "recalculated summary returned");
      assert.equal(refreshed.recalculated.updated, 1, "exactly one daily row recalculated");
      assert.equal(store.db.usageDaily[dailyKey].pricingSource, "openrouter");
      assert.notEqual(store.db.usageDaily[dailyKey].estimatedCostUsd, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
testHourlySnapshotMixedCaseModelMerges();
testHourlySnapshotSameBucketCaseCollisionSums();
testHourlySnapshotPoisonedBucketHealsOnReupload();
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
await testOpenRouterRefreshFetchOutsideLockSplit();
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
  assert.ok(PRESET_ALLOWED_KEYS.includes("theme"));
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
    theme: "dark",
    identityPrivateKey: "secret",
    extraKey: "ignored"
  }));
  const loaded = loadBuildPreset(presetDir);
  assert.equal(loaded.apiBaseUrl, "https://example.com");
  assert.equal(loaded.language, "en");
  assert.equal(loaded.theme, "dark");
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
  const envKeys = ["DB_PATH", "ADMIN_USERNAME", "ADMIN_PASSWORD", "BOARD_SECURITY_LEVEL", "BOARD_ANONYMIZATION_SALT", "PUBLIC_BOARD_AUTH_USERNAME", "PUBLIC_BOARD_AUTH_PASSWORD", "OPENROUTER_PRICING_AUTO_REFRESH", "BRAND_LOGO_URL"];
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
  if (envOverrides.BRAND_LOGO_URL !== undefined) process.env.BRAND_LOGO_URL = envOverrides.BRAND_LOGO_URL;
  else delete process.env.BRAND_LOGO_URL;
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
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.serverVersion);
    assert.ok(body.serverProtocolVersion);
    assert.ok(body.serverTime);
    assert.ok(body.compatibility);
    assert.ok(body.compatibility.status);
    const optionsRes = await fetch(`${baseUrl}/api/health`, { method: "OPTIONS" });
    assert.equal(optionsRes.status, 204);
    assert.equal(optionsRes.headers.get("access-control-allow-origin"), "*");
    console.log("  testHealthEndpoint passed");
  } finally { await cleanup(); }
}

// PROFILE_WORK_START/END must flow from env into the hour-of-day trend
// response (workWindow), never into day-grain responses, and invalid values
// fall back to the 09:30–18:30 defaults.
async function testHourlyWorkWindowEnv() {
  const saved = {
    DB_PATH: process.env.DB_PATH,
    BOARD_SECURITY_LEVEL: process.env.BOARD_SECURITY_LEVEL,
    PROFILE_WORK_START: process.env.PROFILE_WORK_START,
    PROFILE_WORK_END: process.env.PROFILE_WORK_END
  };
  const dbPath = path.join(tmp, `db-work-window-${Date.now()}.json`);
  process.env.DB_PATH = dbPath;
  delete process.env.BOARD_SECURITY_LEVEL;
  process.env.PROFILE_WORK_START = "10:00";
  process.env.PROFILE_WORK_END = "19:30";
  const nonce = Date.now();
  const { createServer, store, PROFILE_WORK_WINDOW } = await import(`../src/backend/server.js?work-window-${nonce}=${nonce}`);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(PROFILE_WORK_WINDOW, { start: "10:00", end: "19:30" }, "valid env values are honored");

    const identity = generateIdentity();
    const deviceId = newId("d");
    store.registerDevice({
      participantId: identity.participantId, deviceId,
      nickname: "work-window-user",
      identityPublicKey: identity.identityPublicKey,
      os: "test", appVersion: APP_VERSION
    });
    const today = localDay();
    store.upsertUsageBatch(makeHourlySnapshotPayload(
      [makeSnapshotItem({ day: today, hour: 10, inputTokens: 4000, totalTokens: 4000, sourceFingerprint: `ww_${today}` })],
      identity.participantId, deviceId, { day: today, hour: 10 }
    ));

    const hourlyRes = await fetch(`${baseUrl}/api/board/participants/${identity.participantId}/trend?grain=hour-of-day&range=last7`);
    assert.equal(hourlyRes.status, 200);
    const hourly = await hourlyRes.json();
    assert.equal(hourly.grain, "hour-of-day");
    assert.deepEqual(hourly.workWindow, { start: "10:00", end: "19:30" }, "hour-of-day response carries the env work window");

    const dayRes = await fetch(`${baseUrl}/api/board/participants/${identity.participantId}/trend?grain=day&range=last7`);
    const day = await dayRes.json();
    assert.equal(Object.hasOwn(day, "workWindow"), false, "day-grain responses must not carry workWindow");

    process.env.PROFILE_WORK_START = "25:99";
    const fallback = await import(`../src/backend/server.js?work-window-fallback-${nonce}=${nonce}`);
    assert.equal(fallback.PROFILE_WORK_WINDOW.start, "09:30", "invalid start falls back to default");
    assert.equal(fallback.PROFILE_WORK_WINDOW.end, "19:30", "valid end survives an invalid start");
    console.log("  testHourlyWorkWindowEnv passed");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
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

async function testUsageBatchUploadIsolatesPoisonedBucket() {
  const tmp = path.join(os.tmpdir(), `test-batch-poison-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_batch_poison", did = "d_batch_poison";
  store.registerDevice({
    participantId: pid, deviceId: did,
    nickname: "batch-poison", identityPublicKey: "pk_poison", os: "test", appVersion: "0.1.0"
  });

  // Reproduces the dev-server incident shape: one bucket whose store write
  // throws (e.g. a MySQL duplicate-key error) travels in the same 25-bucket
  // chunk as healthy buckets. upsertUsageBatchSet must not let the poisoned
  // bucket abort the whole chunk — siblings persist, the failure is reported
  // per bucket so the client only re-queues the poisoned one.
  const healthyA = makeHourlySnapshotPayload([
    makeSnapshotItem({ hour: 10, workdirHash: "poison_h10", sourceFingerprint: "poison_sf_10" })
  ], pid, did, { hour: 10 });
  const healthyB = makeHourlySnapshotPayload([
    makeSnapshotItem({ hour: 11, workdirHash: "poison_h11", sourceFingerprint: "poison_sf_11" })
  ], pid, did, { hour: 11 });
  const poisoned = makeHourlySnapshotPayload([
    makeSnapshotItem({ hour: 12, workdirHash: "poison_h12", sourceFingerprint: "poison_sf_12" })
  ], pid, did, { hour: 12, providerId: "claude_code_local" });

  const originalUpsert = store.upsertUsageBatch.bind(store);
  let poisonArmed = false;
  store.upsertUsageBatch = (input) => {
    if (poisonArmed && input.snapshot?.providerId === "claude_code_local") {
      throw new Error("simulated store write failure");
    }
    return originalUpsert(input);
  };

  poisonArmed = true;
  const result = await store.upsertUsageBatchSet({
    participantId: pid,
    deviceId: did,
    clientGeneratedAt: new Date().toISOString(),
    batches: [
      { snapshot: healthyA.snapshot, items: healthyA.items },
      { snapshot: poisoned.snapshot, items: poisoned.items },
      { snapshot: healthyB.snapshot, items: healthyB.items }
    ]
  });

  assert.equal(result.bucketCount, 3);
  assert.equal(result.failedBucketCount, 1, "exactly the poisoned bucket fails");
  assert.equal(result.accepted, 2, "healthy siblings are persisted");
  assert.equal(result.rejected, 0);
  const failedResult = result.results.find((r) => r.failed);
  assert.equal(failedResult.index, 1);
  assert.equal(failedResult.error, "simulated store write failure");
  assert.ok(result.results.filter((r) => !r.failed).every((r) => r.accepted === 1));

  // verify healthy buckets actually landed in storage under their normalized keys
  const hourlyWorkdirs = Object.values(store.db.usageHourly)
    .filter((row) => row.participantId === pid)
    .map((row) => row.workdirHash)
    .sort();
  assert.deepEqual(hourlyWorkdirs, ["poison_h10", "poison_h11"], "poisoned bucket rows must not be stored");

  // a retry containing only healthy buckets succeeds again (no residual state)
  poisonArmed = false;
  store.upsertUsageBatch = originalUpsert;
  const retry = await store.upsertUsageBatchSet({
    participantId: pid,
    deviceId: did,
    clientGeneratedAt: new Date().toISOString(),
    batches: [{ snapshot: poisoned.snapshot, items: poisoned.items }]
  });
  assert.equal(retry.failedBucketCount, 0);
  assert.equal(retry.accepted, 1);

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testUsageBatchUploadIsolatesPoisonedBucket passed");
}

async function testSyncStateEndpointLimitAndRecentSignatureCompatibility() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const identity = generateIdentity();
    const participantId = "p_sync_state_http";
    const deviceId = "d_sync_state_http";
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId,
        deviceId,
        nickname: "sync-state-http",
        identityPublicKey: identity.identityPublicKey,
        os: "test",
        appVersion: "0.1.0"
      })
    });

    const recentPayload = {
      participantId,
      deviceId,
      clientGeneratedAt: "2026-05-25T00:00:00.000Z",
      buckets: [{ day: "2026-05-25", hour: 0, providerId: "codex_local", fingerprint: "fp" }]
    };
    const recentRes = await fetch(`${baseUrl}/api/usage/sync-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...recentPayload, signature: signPayload(identity.identityPrivateKey, recentPayload) })
    });
    assert.equal(recentRes.status, 200, "recent sync-state payloads signed without mode must remain compatible");
    const recentBody = await recentRes.json();
    assert.match(recentBody.serverFingerprint || "", /^srv_/, "sync-state should expose stable server fingerprint");

    const explicitRecentPayload = { ...recentPayload, mode: "recent" };
    const explicitRecentRes = await fetch(`${baseUrl}/api/usage/sync-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...explicitRecentPayload,
        signature: signPayload(identity.identityPrivateKey, explicitRecentPayload)
      })
    });
    assert.equal(explicitRecentRes.status, 200, "recent sync-state payloads signed with explicit mode must be accepted");

    const emptyProbePayload = {
      participantId,
      deviceId,
      clientGeneratedAt: "2026-05-25T00:00:01.000Z",
      buckets: []
    };
    const emptyProbeRes = await fetch(`${baseUrl}/api/usage/sync-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...emptyProbePayload,
        signature: signPayload(identity.identityPrivateKey, emptyProbePayload)
      })
    });
    assert.equal(emptyProbeRes.status, 200, "empty sync-state probes should be allowed for server identity checks");
    const emptyProbeBody = await emptyProbeRes.json();
    assert.equal(emptyProbeBody.serverFingerprint, recentBody.serverFingerprint, "server fingerprint should be stable across probes");

    const malformedBucketsPayload = {
      participantId,
      deviceId,
      clientGeneratedAt: "2026-05-25T00:00:01.000Z",
      buckets: {}
    };
    const malformedBucketsRes = await fetch(`${baseUrl}/api/usage/sync-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...malformedBucketsPayload,
        signature: signPayload(identity.identityPrivateKey, malformedBucketsPayload)
      })
    });
    assert.equal(malformedBucketsRes.status, 400, "sync-state should reject non-array buckets with a controlled error");

    const fullPayload = {
      participantId,
      deviceId,
      clientGeneratedAt: "2026-05-25T00:00:00.000Z",
      mode: "full_reconcile",
      buckets: Array.from({ length: 251 }, (_, i) => ({
        day: "2026-05-25",
        hour: i % 24,
        providerId: "codex_local",
        fingerprint: `fp_${i}`,
        granularity: "hourly"
      }))
    };
    const fullRes = await fetch(`${baseUrl}/api/usage/sync-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...fullPayload, signature: signPayload(identity.identityPrivateKey, fullPayload) })
    });
    assert.equal(fullRes.status, 400, "full reconcile endpoint must enforce bucket limit");

    const recentTooLargePayload = {
      participantId,
      deviceId,
      clientGeneratedAt: "2026-05-25T00:00:00.000Z",
      buckets: Array.from({ length: 251 }, (_, i) => ({
        day: "2026-05-25",
        hour: i % 24,
        providerId: "codex_local",
        fingerprint: `fp_recent_${i}`
      }))
    };
    const recentTooLargeRes = await fetch(`${baseUrl}/api/usage/sync-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...recentTooLargePayload,
        signature: signPayload(identity.identityPrivateKey, recentTooLargePayload)
      })
    });
    assert.equal(recentTooLargeRes.status, 400, "recent sync-state endpoint must enforce bucket limit");
    console.log("  testSyncStateEndpointLimitAndRecentSignatureCompatibility passed");
  } finally { await cleanup(); }
}

async function testFullReconcileHttpCompareRepairFlow() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const identity = generateIdentity();
    const deviceId = newId("d");
    const day = "2026-02-10";
    const hour = 9;
    const providerId = "codex_local";
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId,
        deviceId,
        nickname: "full-reconcile-http",
        identityPublicKey: identity.identityPublicKey,
        os: "test",
        appVersion: APP_VERSION
      })
    });

    const upload = makeHourlySnapshotPayload([
      makeSnapshotItem({
        day,
        hour,
        providerId,
        workdirHash: "fr_http_h1",
        sourceFingerprint: "fr_http_sf1",
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        totalTokens: 165
      })
    ], identity.participantId, deviceId, { day, hour, providerId });
    const bucket = {
      day,
      hour,
      providerId,
      granularity: "hourly",
      fingerprint: upload.snapshot.bucketFingerprint,
      rowCount: upload.snapshot.rowCount,
      totalTokens: upload.snapshot.totalTokens
    };
    const comparePayload = {
      participantId: identity.participantId,
      deviceId,
      clientGeneratedAt: "2026-05-25T00:00:00.000Z",
      mode: "full_reconcile",
      buckets: [bucket]
    };

    const beforeCompare = await fetch(`${baseUrl}/api/usage/sync-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...comparePayload,
        signature: signPayload(identity.identityPrivateKey, comparePayload)
      })
    });
    assert.equal(beforeCompare.status, 200);
    const beforeBody = await beforeCompare.json();
    assert.equal(beforeBody.missing.length, 1, "server should report missing historical bucket before repair upload");
    assert.equal(beforeBody.matched.length, 0);

    const repairPayload = {
      participantId: identity.participantId,
      deviceId,
      clientGeneratedAt: new Date().toISOString(),
      batches: [{ snapshot: upload.snapshot, items: upload.items }]
    };
    const repairRes = await fetch(`${baseUrl}/api/usage/daily-batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...repairPayload,
        signature: signPayload(identity.identityPrivateKey, repairPayload)
      })
    });
    assert.equal(repairRes.status, 200);
    const repairBody = await repairRes.json();
    assert.equal(repairBody.accepted, 1);
    assert.equal(repairBody.rejected, 0);

    const afterCompare = await fetch(`${baseUrl}/api/usage/sync-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...comparePayload,
        signature: signPayload(identity.identityPrivateKey, comparePayload)
      })
    });
    assert.equal(afterCompare.status, 200);
    const afterBody = await afterCompare.json();
    assert.equal(afterBody.matched.length, 1, "repaired historical bucket should match on the next full compare");
    assert.equal(afterBody.missing.length, 0);
    assert.equal(afterBody.different.length, 0);

    const duplicateRes = await fetch(`${baseUrl}/api/usage/daily-batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...repairPayload,
        signature: signPayload(identity.identityPrivateKey, repairPayload)
      })
    });
    assert.equal(duplicateRes.status, 200);
    const duplicateBody = await duplicateRes.json();
    assert.equal(duplicateBody.noOpBucketCount, 1, "repair upload should be idempotent");

    const boardRes = await fetch(`${baseUrl}/api/leaderboard?range=custom&start=${day}&end=${day}`);
    assert.equal(boardRes.status, 200);
    const board = await boardRes.json();
    assert.equal(board.items.length, 1);
    assert.equal(board.items[0].totalTokens, 165, "repair retry must not inflate public totals");

    console.log("  testFullReconcileHttpCompareRepairFlow passed");
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

async function testAdminUsageRankingPagination() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const day = localDay();
    async function uploadRankedUsage(nickname, totalTokens, usageDay = day) {
      const identity = generateIdentity();
      const deviceId = newId("d");
      const registerRes = await fetch(`${baseUrl}/api/devices/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          participantId: identity.participantId,
          deviceId,
          nickname,
          identityPublicKey: identity.identityPublicKey,
          os: "test",
          appVersion: APP_VERSION
        })
      });
      assert.equal(registerRes.status, 200);
      const payload = {
        participantId: identity.participantId,
        deviceId,
        clientGeneratedAt: new Date().toISOString(),
        items: [{
          day: usageDay,
          toolCode: "codex",
          providerId: "codex_local",
          workdirHash: `h_${nickname}`,
          workdirDisplayName: `wd_${nickname}`,
          model: `model_${nickname}`,
          inputTokens: totalTokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens,
          sourceQuality: "exact",
          sourceFingerprint: `sf_${nickname}`
        }]
      };
      const uploadRes = await fetch(`${baseUrl}/api/usage/daily-batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, signature: signPayload(identity.identityPrivateKey, payload) })
      });
      assert.equal(uploadRes.status, 200);
      return { ...identity, deviceId };
    }

    const low = await uploadRankedUsage("rank-low", 100);
    await uploadRankedUsage("rank-high", 300);
    await uploadRankedUsage("rank-mid", 200);
    await uploadRankedUsage("rank-old", 500, addDays(day, -45));
    const secondDeviceId = newId("d");
    const registerSecondDevice = await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: low.participantId,
        deviceId: secondDeviceId,
        nickname: "rank-low",
        identityPublicKey: low.identityPublicKey,
        clientPlatform: "test-second-device",
        os: "test",
        appVersion: APP_VERSION
      })
    });
    assert.equal(registerSecondDevice.status, 200);
    const secondDevicePayload = {
      participantId: low.participantId,
      deviceId: secondDeviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: [{
        day,
        toolCode: "codex",
        providerId: "codex_local",
        workdirHash: "h_rank-low-second-device",
        workdirDisplayName: "wd_rank-low-second-device",
        model: "model_rank-low-second-device",
        inputTokens: 40,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 40,
        sourceQuality: "exact",
        sourceFingerprint: "sf_rank-low-second-device"
      }]
    };
    const uploadSecondDevice = await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...secondDevicePayload, signature: signPayload(low.identityPrivateKey, secondDevicePayload) })
    });
    assert.equal(uploadSecondDevice.status, 200);

    const pageOneRes = await fetch(`${baseUrl}/api/admin/usage-ranking?range=today&page=1&pageSize=2`);
    assert.equal(pageOneRes.status, 200);
    const pageOne = await pageOneRes.json();
    assert.equal(pageOne.total, 3);
    assert.equal(pageOne.totalPages, 2);
    assert.equal(pageOne.hasNext, true);
    assert.deepEqual(pageOne.items.map((item) => [item.rank, item.nickname, item.totalTokens]), [
      [1, "rank-high", 300],
      [2, "rank-mid", 200]
    ]);
    assert.equal(pageOne.items[0].workdirs[0].name, "wd_rank-high");
    assert.equal(pageOne.items[0].models[0].name, "model_rank-high");

    const pageTwoRes = await fetch(`${baseUrl}/api/admin/usage-ranking?range=today&page=2&pageSize=2`);
    const pageTwo = await pageTwoRes.json();
    assert.equal(pageTwo.hasPrev, true);
    assert.equal(pageTwo.hasNext, false);
    assert.deepEqual(pageTwo.items.map((item) => [item.rank, item.nickname, item.totalTokens]), [
      [3, "rank-low", 140]
    ]);
    assert.deepEqual(pageTwo.items[0].devices, [
      { deviceId: low.deviceId, clientPlatform: "test", totalTokens: 100 },
      { deviceId: secondDeviceId, clientPlatform: "test-second-device", totalTokens: 40 }
    ]);

    const filteredRes = await fetch(`${baseUrl}/api/admin/usage-ranking?range=today&page=1&pageSize=2&participantId=${low.participantId}`);
    const filtered = await filteredRes.json();
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].participantId, low.participantId);
    assert.equal(filtered.items[0].rank, 1);

    const allRes = await fetch(`${baseUrl}/api/admin/usage-ranking?range=all&page=1&pageSize=2`);
    const all = await allRes.json();
    assert.equal(all.total, 4);
    assert.equal(all.from, addDays(day, -45));
    assert.equal(all.to, day);
    assert.deepEqual(all.items.map((item) => [item.rank, item.nickname, item.totalTokens]), [
      [1, "rank-old", 500],
      [2, "rank-high", 300]
    ]);

    const aggregateAllRes = await fetch(`${baseUrl}/api/admin/usage?range=all&grain=month`);
    const aggregateAll = await aggregateAllRes.json();
    assert.equal(aggregateAll.from, addDays(day, -45));
    assert.equal(aggregateAll.to, day);
    assert.ok(aggregateAll.items.some((item) => item.nickname === "rank-old"));
    console.log("  testAdminUsageRankingPagination passed");
  } finally { await cleanup(); }
}

async function registerAndUploadUsage(baseUrl, nickname, items) {
  const identity = generateIdentity();
  const deviceId = newId("d");
  const registerRes = await fetch(`${baseUrl}/api/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      participantId: identity.participantId,
      deviceId,
      nickname,
      identityPublicKey: identity.identityPublicKey,
      os: "test",
      appVersion: APP_VERSION
    })
  });
  assert.equal(registerRes.status, 200);
  const payload = {
    participantId: identity.participantId,
    deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items
  };
  const uploadRes = await fetch(`${baseUrl}/api/usage/daily-batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, signature: signPayload(identity.identityPrivateKey, payload) })
  });
  assert.equal(uploadRes.status, 200);
  return { ...identity, deviceId };
}

function sourceFilterUsageItem(nickname, providerId, totalTokens, usageDay) {
  return {
    day: usageDay,
    toolCode: providerId.startsWith("claude") ? "claude" : "codex",
    providerId,
    workdirHash: `h_${nickname}_${providerId}`,
    workdirDisplayName: `wd_${nickname}_${providerId}`,
    model: `model_${providerId}`,
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens,
    sourceQuality: "exact",
    sourceFingerprint: `sf_${nickname}_${providerId}_${usageDay}`
  };
}

async function testAdminUsageRankingSourceFilter() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const day = localDay();
    await registerAndUploadUsage(baseUrl, "src-alpha", [
      sourceFilterUsageItem("src-alpha", "codex_local", 100, day),
      sourceFilterUsageItem("src-alpha", "claude_code_local", 40, day)
    ]);
    await registerAndUploadUsage(baseUrl, "src-beta", [
      sourceFilterUsageItem("src-beta", "codex_local", 70, day)
    ]);

    const unfilteredRes = await fetch(`${baseUrl}/api/admin/usage-ranking?range=today`);
    assert.equal(unfilteredRes.status, 200);
    const unfiltered = await unfilteredRes.json();
    assert.equal(unfiltered.total, 2);
    assert.deepEqual(unfiltered.items.map((item) => [item.nickname, item.totalTokens]), [
      ["src-alpha", 140],
      ["src-beta", 70]
    ]);

    const codexRes = await fetch(`${baseUrl}/api/admin/usage-ranking?range=today&source=codex_local`);
    const codex = await codexRes.json();
    assert.equal(codex.total, 2);
    assert.deepEqual(codex.items.map((item) => [item.nickname, item.totalTokens]), [
      ["src-alpha", 100],
      ["src-beta", 70]
    ]);

    const claudeRes = await fetch(`${baseUrl}/api/admin/usage-ranking?range=today&source=claude_code_local`);
    const claude = await claudeRes.json();
    assert.equal(claude.total, 1);
    assert.deepEqual(claude.items.map((item) => [item.nickname, item.totalTokens]), [
      ["src-alpha", 40]
    ]);

    const unknownSourceRes = await fetch(`${baseUrl}/api/admin/usage-ranking?range=today&source=no_such_source`);
    const unknownSource = await unknownSourceRes.json();
    assert.equal(unknownSource.total, 0);
    assert.deepEqual(unknownSource.items, []);
    assert.equal(unknownSource.from, day);
    assert.equal(unknownSource.to, day);

    // Filtered and unfiltered results must not share cache entries.
    const unfilteredAgain = await (await fetch(`${baseUrl}/api/admin/usage-ranking?range=today`)).json();
    assert.deepEqual(unfilteredAgain.items.map((item) => [item.nickname, item.totalTokens]), [
      ["src-alpha", 140],
      ["src-beta", 70]
    ]);
    console.log("  testAdminUsageRankingSourceFilter passed");
  } finally { await cleanup(); }
}

function testPublicLeaderboardSourceFilterAggregation() {
  const store = new Store(path.join(tmp, "db-public-source-filter.json"));
  store.currentBusinessDay = () => "2026-08-27";
  const day = "2026-08-27";
  const yesterday = "2026-08-26";
  const baseItem = {
    toolCode: "codex",
    workdirHash: "wd_public_source_filter",
    workdirDisplayName: "public-source-filter",
    model: "gpt-5",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    sourceQuality: "exact",
    rawSourceRef: "",
    providerVersion: "0.1.0",
    parserVersion: "0.1.0"
  };
  const seed = (nickname, rows) => {
    const identity = generateIdentity();
    const deviceId = newId("d");
    store.registerDevice({
      participantId: identity.participantId,
      deviceId,
      nickname,
      identityPublicKey: identity.identityPublicKey,
      os: "test",
      appVersion: APP_VERSION
    });
    store.upsertUsageBatch({
      participantId: identity.participantId,
      deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: rows.map(({ providerId, totalTokens, usageDay }) => ({
        ...baseItem,
        toolCode: providerId.startsWith("claude") ? "claude" : "codex",
        providerId,
        day: usageDay,
        model: `model_${providerId}`,
        inputTokens: totalTokens,
        totalTokens,
        sourceFingerprint: `sf_${nickname}_${providerId}_${usageDay}`
      }))
    });
    return identity;
  };

  const alpha = seed("pub-src-alpha", [
    { providerId: "codex_local", totalTokens: 100, usageDay: day },
    { providerId: "claude_code_local", totalTokens: 40, usageDay: day }
  ]);
  seed("pub-src-beta", [{ providerId: "codex_local", totalTokens: 70, usageDay: day }]);
  seed("pub-src-gamma", [{ providerId: "claude_code_local", totalTokens: 90, usageDay: yesterday }]);
  seed("pub-src-delta", [{ providerId: "kimi_local", totalTokens: 500, usageDay: day }]);

  const unfiltered = store.publicLeaderboard({ period: "today" });
  assert.deepEqual(unfiltered.map((item) => [item.nickname, item.totalTokens, item.rank]), [
    ["pub-src-delta", 500, 1],
    ["pub-src-alpha", 140, 2],
    ["pub-src-beta", 70, 3]
  ]);

  const codex = store.publicLeaderboard({ period: "today", source: "codex_local" });
  assert.deepEqual(codex.map((item) => [item.nickname, item.totalTokens, item.rank]), [
    ["pub-src-alpha", 100, 1],
    ["pub-src-beta", 70, 2]
  ], "source filter re-ranks participants and drops participants without that source");

  const claude = store.publicLeaderboard({ period: "today", source: "claude_code_local" });
  assert.deepEqual(claude.map((item) => [item.nickname, item.totalTokens, item.rank]), [
    ["pub-src-alpha", 40, 1]
  ], "out-of-window rows for the requested source are excluded");

  const kimi = store.publicLeaderboard({ period: "today", source: "kimi_local" });
  assert.deepEqual(kimi.map((item) => [item.nickname, item.totalTokens]), [["pub-src-delta", 500]]);

  assert.deepEqual(store.publicLeaderboard({ period: "today", source: "no_such_source" }), []);

  // Filtered models breakdown only contains the filtered source's models.
  assert.deepEqual(codex[0].models.map((model) => model.name), ["model_codex_local"]);

  // source is part of the aggregate cache key: filtered and unfiltered coexist.
  const boardEntries = Object.values(store.aggregateCache).filter((entry) => entry.name === "publicLeaderboard");
  assert.ok(boardEntries.some((entry) => entry.args.source === ""));
  assert.ok(boardEntries.some((entry) => entry.args.source === "codex_local"));
  assert.equal(
    store.publicLeaderboard({ period: "today" })[0].totalTokens,
    500,
    "unfiltered result must stay intact after filtered queries"
  );

  // Participant detail keeps the unfiltered overall rank even when the board is filtered.
  const detail = store.participantDetail(alpha.participantId, { period: "today" });
  assert.equal(detail.rank, 2);
  assert.equal(detail.totalTokens, 140);
  console.log("  testPublicLeaderboardSourceFilterAggregation passed");
}

async function testBoardLeaderboardSourceFilter() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const day = localDay();
    const yesterday = addDays(day, -1);
    const alpha = await registerAndUploadUsage(baseUrl, "board-lb-src-a", [
      sourceFilterUsageItem("board-lb-src-a", "codex_local", 100, day),
      sourceFilterUsageItem("board-lb-src-a", "claude_code_local", 40, day)
    ]);
    await registerAndUploadUsage(baseUrl, "board-lb-src-b", [
      sourceFilterUsageItem("board-lb-src-b", "codex_local", 70, day)
    ]);
    await registerAndUploadUsage(baseUrl, "board-lb-src-c", [
      sourceFilterUsageItem("board-lb-src-c", "claude_code_local", 90, yesterday)
    ]);
    await registerAndUploadUsage(baseUrl, "board-lb-src-d", [
      sourceFilterUsageItem("board-lb-src-d", "kimi_local", 500, day)
    ]);

    // Backward compatibility: request without source keeps today's default behavior and shape.
    const unfilteredRes = await fetch(`${baseUrl}/api/board/leaderboard?period=today`);
    assert.equal(unfilteredRes.status, 200);
    const unfiltered = await unfilteredRes.json();
    assert.equal(unfiltered.period, "today");
    assert.equal(unfiltered.identityMode, "public");
    assert.deepEqual(unfiltered.items.map((item) => [item.displayName, item.totalTokens, item.rank]), [
      ["board-lb-src-d", 500, 1],
      ["board-lb-src-a", 140, 2],
      ["board-lb-src-b", 70, 3]
    ]);

    const codex = await (await fetch(`${baseUrl}/api/board/leaderboard?period=today&source=codex_local`)).json();
    assert.deepEqual(codex.items.map((item) => [item.displayName, item.totalTokens, item.rank]), [
      ["board-lb-src-a", 100, 1],
      ["board-lb-src-b", 70, 2]
    ]);

    const claude = await (await fetch(`${baseUrl}/api/board/leaderboard?period=today&source=claude_code_local`)).json();
    assert.deepEqual(claude.items.map((item) => [item.displayName, item.totalTokens, item.rank]), [
      ["board-lb-src-a", 40, 1]
    ], "yesterday-only claude usage stays outside the today window");

    const kimi = await (await fetch(`${baseUrl}/api/board/leaderboard?period=today&source=kimi_local`)).json();
    assert.deepEqual(kimi.items.map((item) => [item.displayName, item.totalTokens]), [
      ["board-lb-src-d", 500]
    ]);

    const unknown = await (await fetch(`${baseUrl}/api/board/leaderboard?period=today&source=no_such_source`)).json();
    assert.equal(unknown.period, "today");
    assert.deepEqual(unknown.items, []);

    // Filtered and unfiltered results must not share cache entries.
    const unfilteredAgain = await (await fetch(`${baseUrl}/api/board/leaderboard?period=today`)).json();
    assert.deepEqual(unfilteredAgain.items.map((item) => [item.displayName, item.totalTokens]), [
      ["board-lb-src-d", 500],
      ["board-lb-src-a", 140],
      ["board-lb-src-b", 70]
    ]);

    // Participant detail endpoints stay unfiltered by source (whole-participant view).
    const detailRes = await fetch(`${baseUrl}/api/board/participants/${alpha.participantId}?period=today&source=codex_local`);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.rank, 2, "detail rank stays the overall board rank");
    assert.equal(detail.totalTokens, 140, "detail totals stay whole-participant");
    console.log("  testBoardLeaderboardSourceFilter passed");
  } finally { await cleanup(); }
}

async function testBoardSourceLeaderboardEndpoint() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const day = localDay();
    const yesterday = addDays(day, -1);
    const alpha = await registerAndUploadUsage(baseUrl, "board-src-a", [
      sourceFilterUsageItem("board-src-a", "codex_local", 300, day),
      sourceFilterUsageItem("board-src-a", "claude_code_local", 100, day),
      sourceFilterUsageItem("board-src-a", "codex_local", 999, yesterday)
    ]);
    await registerAndUploadUsage(baseUrl, "board-src-b", [
      sourceFilterUsageItem("board-src-b", "codex_local", 150, day)
    ]);
    await registerAndUploadUsage(baseUrl, "board-src-c", [
      sourceFilterUsageItem("board-src-c", "codex_local", 50, day)
    ]);

    const res = await fetch(`${baseUrl}/api/board/source-leaderboard?period=today&top=2`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.period, "today");
    assert.equal(body.identityMode, "public");
    assert.equal(body.businessDay, currentBusinessDay());
    assert.equal(body.totalTokens, 600);
    assert.deepEqual(body.sources.map((source) => [source.name, source.totalTokens, source.participantCount]), [
      ["codex_local", 500, 3],
      ["claude_code_local", 100, 1]
    ]);
    const codexItems = body.sources[0].items;
    assert.equal(codexItems.length, 2);
    assert.deepEqual(codexItems.map((item) => [item.rank, item.displayName, item.totalTokens]), [
      [1, "board-src-a", 300],
      [2, "board-src-b", 150]
    ]);
    assert.equal(codexItems[0].displayId, alpha.participantId);
    assert.equal(codexItems[0].models[0].name, "model_codex_local");
    assert.ok(codexItems[0].compositionSummary);
    assert.ok(codexItems[0].dominantComposition);
    const claudeItems = body.sources[1].items;
    assert.deepEqual(claudeItems.map((item) => [item.rank, item.displayName, item.totalTokens]), [
      [1, "board-src-a", 100]
    ]);

    // Default top=3, and out-of-window (yesterday) rows excluded under period=today.
    const defaultTop = await (await fetch(`${baseUrl}/api/board/source-leaderboard?period=today`)).json();
    assert.equal(defaultTop.sources[0].items.length, 3);
    assert.equal(defaultTop.sources[0].totalTokens, 500);

    // this_month default range: yesterday row still inside the month in most cases,
    // so assert a deterministic custom window instead.
    const custom = await (await fetch(`${baseUrl}/api/board/source-leaderboard?range=custom&start=${yesterday}&end=${yesterday}`)).json();
    assert.equal(custom.period, "custom");
    assert.deepEqual(custom.sources.map((source) => [source.name, source.totalTokens]), [
      ["codex_local", 999]
    ]);
    console.log("  testBoardSourceLeaderboardEndpoint passed");
  } finally { await cleanup(); }
}

async function testAdminSourceStatsEndpoint() {
  const { baseUrl, cleanup } = await createTestServer({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "secret" });
  try {
    const noAuthRes = await fetch(`${baseUrl}/api/admin/source-stats`);
    assert.equal(noAuthRes.status, 401);
    const badAuthRes = await fetch(`${baseUrl}/api/admin/source-stats`, {
      headers: { authorization: `Basic ${Buffer.from("admin:wrong").toString("base64")}` }
    });
    assert.equal(badAuthRes.status, 401);
    const authHeader = { authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` };

    const day = localDay();
    const previousDay = addDays(day, -1);
    await registerAndUploadUsage(baseUrl, "stats-alpha", [
      sourceFilterUsageItem("stats-alpha", "codex_local", 500, day),
      sourceFilterUsageItem("stats-alpha", "codex_local", 300, previousDay)
    ]);
    await registerAndUploadUsage(baseUrl, "stats-beta", [
      sourceFilterUsageItem("stats-beta", "claude_code_local", 200, day)
    ]);

    const todayRes = await fetch(`${baseUrl}/api/admin/source-stats?range=today&trendDays=7`, { headers: authHeader });
    assert.equal(todayRes.status, 200);
    const today = await todayRes.json();
    assert.equal(today.range, "today");
    assert.equal(today.from, day);
    assert.equal(today.to, day);
    assert.equal(today.trendDays, 7);
    assert.equal(today.trendFrom, addDays(day, -6));
    assert.equal(today.trendTo, day);
    assert.equal(today.totalTokens, 700);
    assert.equal(today.sources.length, 2);
    const codex = today.sources[0];
    assert.equal(codex.name, "codex_local");
    assert.equal(codex.totalTokens, 500);
    assert.ok(Math.abs(codex.ratio - 500 / 700) < 1e-9);
    assert.equal(codex.activeParticipants, 1);
    assert.equal(codex.rows, 1);
    assert.deepEqual(codex.peakDay, { day, totalTokens: 500 });
    assert.equal(codex.trend.length, 7);
    assert.deepEqual(codex.trend.at(-1), { day, totalTokens: 500 });
    assert.deepEqual(codex.trend.find((entry) => entry.day === previousDay), { day: previousDay, totalTokens: 300 });
    assert.deepEqual(codex.trend[0], { day: addDays(day, -6), totalTokens: 0 });
    const claude = today.sources[1];
    assert.equal(claude.name, "claude_code_local");
    assert.equal(claude.totalTokens, 200);
    assert.equal(claude.rows, 1);

    const allRes = await fetch(`${baseUrl}/api/admin/source-stats?range=all&trendDays=1`, { headers: authHeader });
    const all = await allRes.json();
    assert.equal(all.totalTokens, 1000);
    assert.equal(all.from, previousDay);
    assert.equal(all.to, day);
    assert.equal(all.sources[0].totalTokens, 800);
    assert.equal(all.sources[0].rows, 2);
    assert.equal(all.sources[0].activeParticipants, 1);
    assert.deepEqual(all.sources[0].peakDay, { day, totalTokens: 500 });
    assert.equal(all.sources[0].trend.length, 1);

    const clampedRes = await fetch(`${baseUrl}/api/admin/source-stats?range=today&trendDays=500`, { headers: authHeader });
    const clamped = await clampedRes.json();
    assert.equal(clamped.trendDays, 90);
    assert.equal(clamped.sources[0].trend.length, 90);
    console.log("  testAdminSourceStatsEndpoint passed");
  } finally { await cleanup(); }
}

function testSourceLeaderboardStoreAggregation() {
  const store = new Store(path.join(tmp, "db-source-leaderboard.json"), {
    businessDayProvider: () => "2026-08-27"
  });
  const identities = [generateIdentity(), generateIdentity(), generateIdentity()];
  const nicknames = ["src-lead-a", "src-lead-b", "src-lead-c"];
  const deviceIds = identities.map((identity, index) => store.registerDevice({
    participantId: identity.participantId,
    deviceId: newId("d"),
    nickname: nicknames[index],
    identityPublicKey: identity.identityPublicKey,
    os: "test",
    appVersion: APP_VERSION
  }).deviceId);
  const upload = (participantIndex, providerId, model, totalTokens, usageDay) => {
    store.upsertUsageBatch({
      participantId: identities[participantIndex].participantId,
      deviceId: deviceIds[participantIndex],
      clientGeneratedAt: "2026-08-27T00:00:00.000Z",
      items: [{
        day: usageDay,
        toolCode: providerId.startsWith("claude") ? "claude" : "codex",
        providerId,
        workdirHash: `h_${providerId}_${model}`,
        workdirDisplayName: `wd_${providerId}`,
        model,
        inputTokens: totalTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens,
        sourceQuality: "exact",
        sourceFingerprint: `sf_${participantIndex}_${providerId}_${usageDay}_${model}`
      }]
    });
  };
  upload(0, "codex_local", "gpt-5", 300, "2026-08-20");
  upload(0, "codex_local", "gpt-5-codex", 120, "2026-08-25");
  upload(1, "codex_local", "gpt-5", 260, "2026-08-22");
  upload(2, "codex_local", "gpt-5", 80, "2026-08-25");
  upload(0, "claude_code_local", "claude-sonnet-4", 90, "2026-08-26");
  upload(1, "claude_code_local", "claude-sonnet-4", 400, "2026-08-26");
  // Out of window for every query below.
  upload(0, "codex_local", "gpt-5", 9999, "2026-01-05");

  const result = store.sourceLeaderboard({ range: "this_month", top: 2 });
  assert.equal(result.totalTokens, 1250);
  assert.deepEqual(result.sources.map((source) => [source.name, source.totalTokens, source.participantCount]), [
    ["codex_local", 760, 3],
    ["claude_code_local", 490, 2]
  ]);
  const codexItems = result.sources[0].items;
  assert.equal(codexItems.length, 2);
  assert.deepEqual(codexItems.map((item) => [item.rank, item.nickname, item.totalTokens]), [
    [1, "src-lead-a", 420],
    [2, "src-lead-b", 260]
  ]);
  assert.deepEqual(codexItems[0].models, [
    { name: "gpt-5", totalTokens: 300 },
    { name: "gpt-5-codex", totalTokens: 120 }
  ]);
  assert.equal(codexItems[0].inputTokens, 420);
  assert.ok(codexItems[0].compositionSummary);
  assert.deepEqual(result.sources[1].items.map((item) => [item.rank, item.nickname, item.totalTokens]), [
    [1, "src-lead-b", 400],
    [2, "src-lead-a", 90]
  ]);

  const singleDay = store.sourceLeaderboard({ range: "custom", startDay: "2026-08-25", endDay: "2026-08-25" });
  assert.deepEqual(singleDay.sources.map((source) => [source.name, source.totalTokens]), [
    ["codex_local", 200]
  ]);

  const emptyStore = new Store(path.join(tmp, "db-source-leaderboard-empty.json"), { persist: false, businessDayProvider: () => "2026-08-27" });
  const empty = emptyStore.sourceLeaderboard({ range: "this_month" });
  assert.equal(empty.totalTokens, 0);
  assert.deepEqual(empty.sources, []);
  console.log("  testSourceLeaderboardStoreAggregation passed");
}

async function testMysqlSourceAggregations() {
  const store = new MySqlStore({});
  store.currentBusinessDay = () => "2026-08-27";
  const queries = [];
  const usageRow = (day, providerId, participantId, totalTokens) => ({
    usageKey: `uk_${providerId}_${participantId}_${day}`,
    day,
    participantId,
    deviceId: `d_${participantId}`,
    toolCode: "codex",
    providerId,
    workdirId: `${participantId}:h1`,
    workdirHash: "h1",
    workdirDisplayName: "mysql-source-stats",
    model: "gpt-5",
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens,
    estimatedCostUsd: null,
    costQuality: "",
    pricingVersion: "",
    pricingModel: "",
    pricingSource: "",
    sourceQuality: "exact",
    rawSourceRef: "",
    providerVersion: "",
    parserVersion: "",
    sourceFingerprint: `fp_${providerId}_${participantId}_${day}`,
    uploadedAt: "2026-08-27T00:00:00.000Z"
  });
  store.pool = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      if (normalized.includes("GROUP BY u.providerId, u.participantId, p.nickname")) {
        return [[
          { providerId: "codex_local", participantId: "p1", nickname: "mysql-src-a", totalTokens: 300, inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          { providerId: "codex_local", participantId: "p2", nickname: "mysql-src-b", totalTokens: 150, inputTokens: 150, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          { providerId: "claude_code_local", participantId: "p1", nickname: "mysql-src-a", totalTokens: 100, inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
        ]];
      }
      if (normalized.includes("GROUP BY u.providerId, u.participantId, u.model")) {
        return [[
          { providerId: "codex_local", participantId: "p1", name: "gpt-5", totalTokens: 300 },
          { providerId: "codex_local", participantId: "p2", name: "gpt-5", totalTokens: 150 },
          { providerId: "claude_code_local", participantId: "p1", name: "claude-sonnet-4", totalTokens: 100 }
        ]];
      }
      if (normalized.startsWith("SELECT * FROM usage_daily WHERE day IN")) {
        return [[
          usageRow("2026-08-27", "codex_local", "p1", 500),
          usageRow("2026-08-26", "codex_local", "p1", 300),
          usageRow("2026-08-27", "claude_code_local", "p2", 200)
        ]];
      }
      return [[]];
    }
  };

  const board = await store.sourceLeaderboard({ range: "this_month", top: 2 });
  assert.equal(board.totalTokens, 550);
  assert.deepEqual(board.sources.map((source) => [source.name, source.totalTokens, source.participantCount]), [
    ["codex_local", 450, 2],
    ["claude_code_local", 100, 1]
  ]);
  assert.deepEqual(board.sources[0].items.map((item) => [item.rank, item.nickname, item.totalTokens]), [
    [1, "mysql-src-a", 300],
    [2, "mysql-src-b", 150]
  ]);
  assert.deepEqual(board.sources[0].items[0].models, [{ name: "gpt-5", totalTokens: 300 }]);
  assert.ok(board.sources[0].items[0].compositionSummary);
  const boardQuery = queries.find((q) => q.sql.includes("GROUP BY u.providerId, u.participantId, p.nickname"));
  assert.ok(boardQuery.sql.includes("JOIN participants"));
  assert.deepEqual(boardQuery.params, ["2026-08-01", "2026-08-27"]);
  assert.equal(Object.keys(store.db.usageDaily).length, 0, "source leaderboard must not leave rows resident");

  const stats = await store.adminSourceStats({ range: "today", trendDays: 3 });
  assert.equal(stats.range, "today");
  assert.equal(stats.totalTokens, 700);
  assert.equal(stats.sources.length, 2);
  assert.equal(stats.sources[0].name, "codex_local");
  assert.equal(stats.sources[0].totalTokens, 500);
  assert.equal(stats.sources[0].rows, 1);
  assert.equal(stats.sources[0].activeParticipants, 1);
  assert.deepEqual(stats.sources[0].peakDay, { day: "2026-08-27", totalTokens: 500 });
  assert.equal(stats.sources[0].trend.length, 3);
  assert.deepEqual(stats.sources[0].trend[0], { day: "2026-08-25", totalTokens: 0 });
  assert.deepEqual(stats.sources[0].trend[1], { day: "2026-08-26", totalTokens: 300 });
  assert.equal(stats.trendFrom, "2026-08-25");
  assert.equal(stats.trendTo, "2026-08-27");
  const statsQuery = queries.find((q) => q.sql.startsWith("SELECT * FROM usage_daily WHERE day IN"));
  assert.deepEqual(statsQuery.params, ["2026-08-25", "2026-08-26", "2026-08-27"]);

  queries.length = 0;
  await store.adminUsageRanking({ range: "today", source: "codex_local" });
  assert.ok(queries.some((q) => q.sql.includes("providerId = ?") && q.params.includes("codex_local")));
  queries.length = 0;
  await store.adminUsageRanking({ range: "today" });
  assert.equal(queries.some((q) => q.sql.includes("providerId = ?")), false, "no source filter must not add a providerId predicate");

  queries.length = 0;
  await store.publicLeaderboard({ range: "today", source: "codex_local" });
  assert.ok(
    queries.some((q) => q.sql.includes("GROUP BY u.participantId, p.nickname") && q.sql.includes("providerId = ?") && q.params.includes("codex_local")),
    "public leaderboard source filter must add a providerId predicate"
  );
  queries.length = 0;
  await store.publicLeaderboard({ range: "today" });
  assert.equal(
    queries.some((q) => q.sql.includes("GROUP BY u.participantId, p.nickname") && q.sql.includes("providerId = ?")),
    false,
    "public leaderboard without source must not add a providerId predicate"
  );
  console.log("  testMysqlSourceAggregations passed");
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

    const analyticsRes = await fetch(`${baseUrl}/api/board/analytics?period=today`);
    assert.equal(analyticsRes.status, 200);
    const analytics = await analyticsRes.json();
    assert.deepEqual(analytics.participantRanking.map((item) => [item.rank, item.displayName, item.totalTokens]), [[1, "board-pub", 150]]);
    assert.equal(Object.hasOwn(analytics.participantRanking[0], "participantId"), false, "public analytics ranking must not expose participantId");

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
    const delPayload = { participantId: identity.participantId, deviceId, timestamp: freshTs };
    const delSig = signPayload(identity.identityPrivateKey, delPayload);
    const delRes = await fetch(`${baseUrl}/api/participant/data`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...delPayload, signature: delSig })
    });
    assert.equal(delRes.status, 200);
    assert.equal((await delRes.json()).deleted, true);

    const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const oldPayload = { participantId: identity.participantId, deviceId, timestamp: oldTs };
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

async function testSelfServiceDeletionMultiDevice() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const identity = generateIdentity();
    const deviceIdA = newId("d");
    const deviceIdB = newId("d");
    // Register participant with two devices
    for (const did of [deviceIdA, deviceIdB]) {
      await fetch(`${baseUrl}/api/devices/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          participantId: identity.participantId, deviceId: did, nickname: "multi-del",
          identityPublicKey: identity.identityPublicKey, os: "test", appVersion: APP_VERSION
        })
      });
    }
    // Upload usage for device A
    const payloadA = { participantId: identity.participantId, deviceId: deviceIdA,
      clientGeneratedAt: new Date().toISOString(),
      items: [{ day: localDay(), toolCode: "codex", providerId: "codex_local", workdirHash: "hA", workdirDisplayName: "pA", model: "gpt-5", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 150, sourceQuality: "exact", sourceFingerprint: "sfA" }]
    };
    await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payloadA, signature: signPayload(identity.identityPrivateKey, payloadA) })
    });
    // Upload usage for device B
    const payloadB = { participantId: identity.participantId, deviceId: deviceIdB,
      clientGeneratedAt: new Date().toISOString(),
      items: [{ day: localDay(), toolCode: "codex", providerId: "codex_local", workdirHash: "hB", workdirDisplayName: "pB", model: "gpt-5", inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 300, sourceQuality: "exact", sourceFingerprint: "sfB" }]
    };
    await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payloadB, signature: signPayload(identity.identityPrivateKey, payloadB) })
    });

    // Delete device A's cloud data
    const freshTs = new Date().toISOString();
    const delPayload = { participantId: identity.participantId, deviceId: deviceIdA, timestamp: freshTs };
    const delSig = signPayload(identity.identityPrivateKey, delPayload);
    const delRes = await fetch(`${baseUrl}/api/participant/data`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...delPayload, signature: delSig })
    });
    assert.equal(delRes.status, 200);
    const delBody = await delRes.json();
    assert.equal(delBody.deviceId, deviceIdA);
    assert.equal(delBody.removed.devices, 1);
    assert.ok(delBody.removed.usageDaily >= 1);

    // Verify device B's data is still intact via leaderboard
    const lbRes = await fetch(`${baseUrl}/api/leaderboard?range=today&tool=all`);
    const lbBody = await lbRes.json();
    const entry = lbBody.items.find(i => i.participantId === identity.participantId);
    assert.ok(entry, "participant should still exist on leaderboard after single-device delete");
    assert.equal(entry.totalTokens, 300, "device B tokens should remain");

    console.log("  testSelfServiceDeletionMultiDevice passed");
  } finally { await cleanup(); }
}

async function testSelfServiceDeletionSingleDeviceWipesAll() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const identity = generateIdentity();
    const deviceId = newId("d");
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId, deviceId, nickname: "single-del",
        identityPublicKey: identity.identityPublicKey, os: "test", appVersion: APP_VERSION
      })
    });
    const payload = { participantId: identity.participantId, deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: [{ day: localDay(), toolCode: "codex", providerId: "codex_local", workdirHash: "h", workdirDisplayName: "p", model: "gpt-5", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 150, sourceQuality: "exact", sourceFingerprint: "sf" }]
    };
    await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, signature: signPayload(identity.identityPrivateKey, payload) })
    });

    const freshTs = new Date().toISOString();
    const delPayload = { participantId: identity.participantId, deviceId, timestamp: freshTs };
    const delSig = signPayload(identity.identityPrivateKey, delPayload);
    const delRes = await fetch(`${baseUrl}/api/participant/data`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...delPayload, signature: delSig })
    });
    assert.equal(delRes.status, 200);
    const delBody = await delRes.json();
    assert.equal(delBody.deleted, true);
    assert.equal(delBody.participantId, identity.participantId);

    // Participant should be fully gone from leaderboard
    const lbRes = await fetch(`${baseUrl}/api/leaderboard?range=today&tool=all`);
    const lbBody = await lbRes.json();
    const entry = lbBody.items.find(i => i.participantId === identity.participantId);
    assert.equal(entry, undefined, "single-device participant should be fully deleted");

    console.log("  testSelfServiceDeletionSingleDeviceWipesAll passed");
  } finally { await cleanup(); }
}

async function testSelfServiceDeletionRejectsCrossParticipantDevice() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    // Participant A: two devices
    const identityA = generateIdentity();
    const deviceIdA1 = newId("d");
    const deviceIdA2 = newId("d");
    for (const did of [deviceIdA1, deviceIdA2]) {
      await fetch(`${baseUrl}/api/devices/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          participantId: identityA.participantId, deviceId: did, nickname: "cross-a",
          identityPublicKey: identityA.identityPublicKey, os: "test", appVersion: APP_VERSION
        })
      });
    }
    // Upload usage for A's devices
    for (const [did, tokens] of [[deviceIdA1, 100], [deviceIdA2, 200]]) {
      const p = { participantId: identityA.participantId, deviceId: did,
        clientGeneratedAt: new Date().toISOString(),
        items: [{ day: localDay(), toolCode: "codex", providerId: "codex_local", workdirHash: "h" + did, workdirDisplayName: "p" + did, model: "gpt-5", inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: tokens, sourceQuality: "exact", sourceFingerprint: "sf" + did }]
      };
      await fetch(`${baseUrl}/api/usage/daily-batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...p, signature: signPayload(identityA.identityPrivateKey, p) })
      });
    }

    // Participant B: one device
    const identityB = generateIdentity();
    const deviceIdB = newId("d");
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: identityB.participantId, deviceId: deviceIdB, nickname: "cross-b",
        identityPublicKey: identityB.identityPublicKey, os: "test", appVersion: APP_VERSION
      })
    });
    const payloadB = { participantId: identityB.participantId, deviceId: deviceIdB,
      clientGeneratedAt: new Date().toISOString(),
      items: [{ day: localDay(), toolCode: "codex", providerId: "codex_local", workdirHash: "hB", workdirDisplayName: "pB", model: "gpt-5", inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 500, sourceQuality: "exact", sourceFingerprint: "sfB" }]
    };
    await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payloadB, signature: signPayload(identityB.identityPrivateKey, payloadB) })
    });

    // A signs a request targeting B's deviceId — must be rejected
    const freshTs = new Date().toISOString();
    const delPayload = { participantId: identityA.participantId, deviceId: deviceIdB, timestamp: freshTs };
    const delSig = signPayload(identityA.identityPrivateKey, delPayload);
    const delRes = await fetch(`${baseUrl}/api/participant/data`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...delPayload, signature: delSig })
    });
    assert.equal(delRes.status, 403, "cross-participant device delete must be rejected");

    // B's data must remain intact
    const lbRes = await fetch(`${baseUrl}/api/leaderboard?range=today&tool=all`);
    const lbBody = await lbRes.json();
    const entryB = lbBody.items.find(i => i.participantId === identityB.participantId);
    assert.ok(entryB, "participant B should still exist on leaderboard");
    assert.equal(entryB.totalTokens, 500, "participant B tokens must be unchanged");

    // A's data must also remain intact (nothing was deleted)
    const entryA = lbBody.items.find(i => i.participantId === identityA.participantId);
    assert.ok(entryA, "participant A should still exist on leaderboard");
    assert.equal(entryA.totalTokens, 300, "participant A tokens must be unchanged");

    console.log("  testSelfServiceDeletionRejectsCrossParticipantDevice passed");
  } finally { await cleanup(); }
}

async function testSelfServiceDeletionRejectsInvalidSignature() {
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
    const payload = { participantId: identity.participantId, deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: [{ day: localDay(), toolCode: "codex", providerId: "codex_local", workdirHash: "h", workdirDisplayName: "p", model: "gpt-5", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 150, sourceQuality: "exact", sourceFingerprint: "sf" }]
    };
    await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, signature: signPayload(identity.identityPrivateKey, payload) })
    });

    // Send DELETE with valid participantId + deviceId + fresh timestamp but forged signature
    const freshTs = new Date().toISOString();
    const delRes = await fetch(`${baseUrl}/api/participant/data`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId,
        deviceId,
        timestamp: freshTs,
        signature: "forged-signature-not-signed-by-owner"
      })
    });
    assert.equal(delRes.status, 401, "invalid signature must be rejected");

    // Data must remain intact
    const lbRes = await fetch(`${baseUrl}/api/leaderboard?range=today&tool=all`);
    const lbBody = await lbRes.json();
    const entry = lbBody.items.find(i => i.participantId === identity.participantId);
    assert.ok(entry, "participant should still exist after rejected invalid signature");
    assert.equal(entry.totalTokens, 150, "tokens must be unchanged");

    console.log("  testSelfServiceDeletionRejectsInvalidSignature passed");
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

async function testAdminParticipantDetailUsesRangeAndGrainSeparately() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const identity = generateIdentity();
    const deviceId = newId("d");
    const yesterday = addDays(localDay(), -1);
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId,
        deviceId,
        nickname: "admin-detail-range",
        identityPublicKey: identity.identityPublicKey,
        os: "test",
        appVersion: APP_VERSION
      })
    });
    const payload = {
      participantId: identity.participantId,
      deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: [{
        day: yesterday,
        toolCode: "codex",
        providerId: "codex_local",
        workdirHash: "admin_detail_range",
        workdirDisplayName: "admin-detail-project",
        model: "gpt-5",
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 150,
        sourceQuality: "exact",
        sourceFingerprint: "admin-detail-range-yesterday"
      }]
    };
    await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, signature: signPayload(identity.identityPrivateKey, payload) })
    });

    const dayDetailRes = await fetch(`${baseUrl}/api/admin/participants/${identity.participantId}?grain=day&range=month`);
    assert.equal(dayDetailRes.status, 200);
    const dayDetail = await dayDetailRes.json();
    assert.equal(dayDetail.rows.length, 1);
    assert.equal(dayDetail.rows[0].day, yesterday);
    assert.equal(dayDetail.totalTokens, 150);
    assert.equal(dayDetail.periodRows.length, 1);
    assert.equal(dayDetail.periodRows[0].periodStart, yesterday);

    for (const grain of ["week", "month"]) {
      const detailRes = await fetch(`${baseUrl}/api/admin/participants/${identity.participantId}?grain=${grain}&range=month`);
      assert.equal(detailRes.status, 200);
      const detail = await detailRes.json();
      assert.equal(detail.rows.length, 1);
      assert.equal(detail.totalTokens, 150);
      assert.equal(detail.periodRows.length, 1);
      assert.ok(detail.periodRows[0].periodStart <= yesterday);
      assert.ok(detail.periodRows[0].periodEnd >= yesterday);
    }

    console.log("  testAdminParticipantDetailUsesRangeAndGrainSeparately passed");
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
  assert.match(html, /id="open-share-card"/, "missing share card entry");
  assert.match(html, /id="share-card-modal"/, "missing share card modal");
  for (const chart of ["auto", "trend", "heatmap"]) {
    // Chart style buttons removed in overview-based share card redesign
  }
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
  const js = fs.readFileSync("src/web/leaderboard.js", "utf8");
  const styles = fs.readFileSync("src/web/styles.css", "utf8");
  assert.match(html, /leaderboard/i);
  assert.match(html, /period/i);
  assert.doesNotMatch(html, /board-title-block/);
  assert.match(html, /toolbar-right[\s\S]*id="status"[^>]*class="leaderboard-status"/);
  assert.match(html, /href="\/leaderboard\.html"/);
  assert.match(html, /id="leaderboard-surface"[^>]*aria-busy="true"/);
  assert.match(html, /data-i18n="web\.leaderboard\.contribution"/);
  assert.match(js, /renderTopThree\(top, communityTotal\)/);
  assert.match(js, /renderMeterView\(rest, communityTotal\)/);
  assert.match(js, /renderListView\(rest, communityTotal\)/);
  assert.strictEqual(
    (js.match(/\$\{renderLeaderboardValueMeta\(item, communityTotal,/g) || []).length,
    1,
    "Top 3 should keep the compact contribution and cost layout"
  );
  assert.match(js, /class="meter-value\$\{state\.showCost \? " has-cost" : ""\}"/);
  assert.match(js, /class="meter-total"/);
  assert.match(js, /class="leaderboard-value-meta \$\{className\}"/);
  assert.match(styles, /\.leaderboard-value-meta/);
  assert.match(styles, /grid-template-areas:\s*"share total"/);
  assert.match(styles, /\.meter-value > strong/);
  assert.match(js, /function setLeaderboardLoading/);
  assert.match(js, /surface\?\.classList\.toggle\("is-refreshing", on\)/);
  assert.match(js, /surface\.classList\.add\("is-settled"\)/);
  assert.match(styles, /\.motion-surface\.is-refreshing::before/);
  console.log("  testWebLeaderboardStructure passed");
}

function testWebAnalyticsParticipantRankingStructure() {
  const html = fs.readFileSync("src/web/analytics.html", "utf8");
  const js = fs.readFileSync("src/web/analytics.js", "utf8");
  const shared = fs.readFileSync("src/shared/chart-helpers.js", "utf8");
  assert.match(html, /id="participant-ranking-card"/);
  assert.match(html, /usage-share-chart/);
  assert.doesNotMatch(html, /share-list/);
  assert.match(html, /id="participant-treemap-svg"/);
  assert.match(html, /id="participant-treemap-labels"/);
  assert.match(html, /class="an-main"/);
  assert.match(html, /class="[^"]*\ban-composition-card\b/);
  assert.match(html, /id="analytics-loading"[^>]*aria-live="polite"/);
  assert.match(js, /function renderParticipantTreemapPanel/);
  assert.match(js, /sharedRenderParticipantTreemap/);
  assert.match(js, /classList\.add\("is-embedded"\)/);
  assert.match(js, /analytics-resize/);
  assert.match(js, /let lastReportedHeight = 0/);
  assert.match(js, /height === lastReportedHeight/);
  assert.match(js, /requestAnimationFrame/);
  assert.match(js, /shell\?\.classList\.toggle\("is-refreshing", on\)/);
  assert.match(js, /setLoading\(true\)[\s\S]*loadParticipantDropdown\(\)[\s\S]*setLoading\(false\)/);
  assert.match(shared, /export function renderParticipantTreemap/);
  assert.match(shared, /linePath\.setAttribute\("pathLength", "1"\)/);
  assert.match(shared, /TREEMAP_MAX_PARTICIPANTS = 30/);
  assert.match(shared, /Math\.min\(\s*rankings\.length,\s*TREEMAP_MAX_PARTICIPANTS/);
  assert.match(js, /card\.hidden = !isCommunityScope/);
  console.log("  testWebAnalyticsParticipantRankingStructure passed");
}

function testWebAdminStructure() {
  const html = fs.readFileSync("src/web/admin.html", "utf8");
  const styles = fs.readFileSync("src/web/styles.css", "utf8");
  assert.match(html, /admin/i);
  assert.match(html, /usage/i);
  assert.match(html, /pricing/i);
  assert.match(html, /quality/i);
  assert.match(html, /devices/i);
  assert.match(html, /ranking-tbody/i);
  assert.match(html, /ranking-pagination/i);
  assert.match(html, /usage-view-tabs/i);
  assert.match(html, /data-usage-panel="ranking"/i);
  assert.match(html, /data-usage-panel="aggregate"/i);
  assert.strictEqual((html.match(/data-i18n="admin\.usage\.topSource"/g) || []).length, 2, "ranking and aggregate tables should include the top source column");
  assert.match(html, /data-value="all"/i);
  assert.match(html, /admin-analytics-panel/);
  assert.match(html, /admin-analytics-frame/);
  assert.match(html, /data-src="\/analytics\.html"/);
  assert.match(html, /class="pricing-priority"/);
  assert.ok(html.indexOf("pricing-priority") < html.indexOf('id="pricing-form"'), "missing-price tasks should precede secondary pricing management");
  for (const field of ["model", "input", "output", "cacheRead", "cacheWrite"]) {
    assert.match(html, new RegExp(`data-i18n="admin\\.pricing\\.${field}Label"`));
  }
  assert.doesNotMatch(styles, /\.admin-shell \.admin-analytics-frame\s*\{[^}]*height:\s*(?:600|720|760)px/is);
  assert.match(styles, /body\.is-embedded \.public-masthead\s*\{\s*display:\s*none/);
  const js = fs.readFileSync("src/web/admin.js", "utf8");
  assert.match(js, /state\.range === "all"\) return "month"/);
  assert.match(js, /analytics-resize/);
  assert.match(js, /Number\.isFinite\(height\)/);
  assert.match(js, /event\.origin !== window\.location\.origin/);
  assert.match(js, /event\.source !== iframe\?\.contentWindow/);
  assert.match(js, /Math\.abs\(currentHeight - nextHeight\) > 1/);
  assert.match(js, /iframe && !iframe\.dataset\.loaded/);
  assert.match(js, /function setAdminPanelBusy/);
  assert.strictEqual((js.match(/renderPrimarySource\(item\.providers\)/g) || []).length, 2, "ranking and aggregate rows should render provider data");
  assert.match(js, /codex_local:\s*"Codex"/);
  assert.match(js, /panel\.classList\.toggle\("is-refreshing", on\)/);
  assert.match(js, /panel\.classList\.add\("is-entering"\)/);
  assert.match(styles, /\.admin-shell \.admin-panel\.is-entering/);
  console.log("  testWebAdminStructure passed");
}

function testWebDownloadStructure() {
  const html = fs.readFileSync("src/web/download.html", "utf8");
  const js = fs.readFileSync("src/web/download.js", "utf8");
  const shared = fs.readFileSync("src/shared/chart-helpers.js", "utf8");
  assert.match(html, /download-cards/);
  assert.match(html, /usage-share-chart/);
  assert.doesNotMatch(html, /share-list/);
  assert.match(html, /kpi-scoreboard/);
  assert.strictEqual((html.match(/class="kpi-pair"/g) || []).length, 3, "home should group six KPIs into three pairs");
  assert.match(html, /class="card-head-link"/);
  assert.match(html, /href="\/leaderboard\.html"/);
  assert.doesNotMatch(html, /site-footer/);
  assert.match(html, /home-hero-grid/);
  assert.match(html, /home-trend-chart/);
  assert.match(html, /home-top-today/);
  assert.match(html, /home-model-chart/);
  assert.match(html, /home-provider-donut/);
  assert.match(html, /home-heatmap-grid/);
  assert.match(html, /burn-legend/);
  assert.match(html, /home-participant-treemap-svg/);
  assert.match(html, /home-participant-treemap-labels/);
  assert.match(js, /loadSummary/);
  assert.match(js, /loadAnalytics/);
  assert.match(js, /loadLeaderboard/);
  assert.match(js, /range=this_month/);
  assert.match(js, /range=last30/);
  assert.match(js, /renderParticipantTreemap/);
  assert.match(js, /renderDonutChart/);
  assert.match(js, /renderActivityHeatmap/);
  assert.match(js, /document\.body\.classList\.add\("is-refreshing"\)/);
  assert.match(js, /document\.body\.classList\.add\("is-settled"\)/);
  assert.match(js, /from\s+["']\/shared\/chart-helpers\.js["']/);
  assert.match(shared, /export function renderTrendChart/);
  assert.match(shared, /export function renderBarChart/);
  assert.match(shared, /export function renderDonutChart/);
  assert.match(shared, /export function renderActivityHeatmap/);
  assert.match(shared, /export function renderParticipantTreemap/);
  assert.match(shared, /export function formatCost/);
  assert.match(shared, /export function sourceName/);
  assert.match(shared, /export function normalizeModelSegments/);
  assert.match(js, /darwin|windows|platform/i);
  assert.match(fs.readFileSync("src/web/styles.css", "utf8"), /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0\.01ms/);
  console.log("  testWebDownloadStructure passed");
}

function testWebProfileHeatmapScale() {
  const shared = fs.readFileSync("src/shared/chart-helpers.js", "utf8");
  const js = fs.readFileSync("src/web/profile.js", "utf8");
  const html = fs.readFileSync("src/web/profile.html", "utf8");
  const css = fs.readFileSync("src/web/styles.css", "utf8");

  // heatLevel must keep the legacy linear buckets for 4-level layouts and
  // switch to a sqrt scale for finer profiles (heavy-tailed daily usage).
  assert.match(shared, /function heatLevel\(tokens, maxVal, levels = 4\)/);
  assert.match(shared, /if \(levels <= 4\)[\s\S]*?if \(ratio > 0\.75\) return 4;/);
  assert.match(shared, /Math\.sqrt\(ratio\) \* levels/);
  assert.match(shared, /levels = 4\s*\n\} = \{\}\)/);
  assert.match(js, /levels: 12/);

  // Legend must expose one dot per level (level-0 empty plus 12 active shades).
  const dots = html.match(/<i class="heatmap-cell level-\d+"><\/i>/g) || [];
  assert.equal(dots.length, 13, "profile legend must show 13 heatmap dots");

  // CSS must define a monotonic 12-step alpha ladder scoped to the profile page
  // without touching the shared analytics block.
  const alphas = [...css.matchAll(/\.page-profile :is\(\.heatmap-grid, \.heat-legend-dots\) \.heatmap-cell\.level-(\d+) \{ background: rgba\(var\(--heat\), ([\d.]+)\); \}/g)]
    .map((m) => ({ level: Number(m[1]), alpha: Number(m[2]) }))
    .sort((a, b) => a.level - b.level);
  assert.equal(alphas.length, 12, "profile scope must define 12 active heat levels");
  assert.equal(alphas[0].level, 1);
  assert.equal(alphas[11].level, 12);
  for (let i = 1; i < alphas.length; i++) {
    assert.ok(alphas[i].alpha > alphas[i - 1].alpha, "heat alpha ladder must be strictly monotonic");
  }
  console.log("  testWebProfileHeatmapScale passed");
}

function testWebProfileHourlyCard() {
  const shared = fs.readFileSync("src/shared/chart-helpers.js", "utf8");
  const js = fs.readFileSync("src/web/profile.js", "utf8");
  const html = fs.readFileSync("src/web/profile.html", "utf8");
  const css = fs.readFileSync("src/web/styles.css", "utf8");
  const i18n = fs.readFileSync("src/shared/i18n.js", "utf8");

  // Shared chart library exposes the hourly rhythm render + stats helpers.
  assert.match(shared, /export function renderHourlyRhythm\(/);
  assert.match(shared, /export function computeHourlyRhythmStats\(/);

  // Profile page renders the card and fetches grain=hour-of-day with the range.
  assert.match(html, /profile-hourly-card/);
  assert.match(html, /id="profile-hourly-chart"/);
  assert.match(html, /id="profile-hourly-stats"/);
  assert.match(html, /id="profile-hourly-split"/);
  assert.match(html, /data-i18n="web\.profile\.hourlyTitle"/);
  assert.match(js, /grain: "hour-of-day"/);
  assert.match(js, /renderHourlyRhythmCard/);
  assert.match(js, /renderHourlyRhythm, computeHourlyRhythmStats/);
  assert.match(js, /hourly\.workWindow/);
  const serverJs = fs.readFileSync("src/backend/server.js", "utf8");
  assert.match(serverJs, /PROFILE_WORK_START/);
  assert.match(serverJs, /PROFILE_WORK_END/);
  assert.match(serverJs, /workWindow = PROFILE_WORK_WINDOW/);

  // Card chart styling exists and i18n keys ship in both locales.
  assert.match(css, /\.hourly-rhythm\b/);
  assert.match(css, /\.hourly-rhythm \.d\.peak \.col/);
  assert.match(i18n, /"web\.profile\.hourlyTitle": "编码时段节律"/);
  assert.match(i18n, /"web\.profile\.hourlyTitle": "Hourly rhythm"/);
  assert.match(i18n, /"web\.profile\.hourlyCoverage"/);
  assert.match(i18n, /"web\.profile\.hourlyGoldenHour"/);
  assert.match(i18n, /"web\.profile\.hourlySplitTitle"/);
  assert.match(i18n, /"web\.profile\.hourlyWorkShare"/);
  assert.match(i18n, /"web\.profile\.hourlyOffShare"/);
  assert.match(i18n, /"web\.profile\.hourlyArchetypeWork"/);
  assert.match(i18n, /"web\.profile\.hourlyArchetypeNight"/);
  assert.match(i18n, /"web\.profile\.hourlyArchetypeAll"/);
  assert.match(i18n, /"web\.profile\.hourlyTagNight"/);
  assert.match(i18n, /"web\.profile\.hourlyTagOvertime"/);
  assert.match(i18n, /"web\.profile\.hourlyTagDaytime"/);
  assert.match(i18n, /"web\.profile\.hourlyNightShare"/);
  assert.match(js, /renderHourlyFeatureTags/);
  assert.match(css, /\.feature-tag\.feature-night/);
  assert.match(css, /\.feature-tag\.feature-overtime/);
  assert.match(css, /\.feature-tag\.feature-daytime/);
  assert.match(i18n, /"web\.profile\.emptyHourly"/);

  console.log("  testWebProfileHourlyCard passed");
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
  assert.match(renderer, /fullReconcileStatus/);
  assert.match(renderer, /diag-background-sync/);
  console.log("  testDesktopRendererExports passed");
}

function testTauriBridgeExports() {
  const bridge = fs.readFileSync("src/desktop/tauri-bridge.js", "utf8");
  assert.match(bridge, /forwardToSidecar|forward_to_sidecar/);
  assert.match(bridge, /export/);
  assert.match(bridge, /saveShareImage/);
  assert.match(bridge, /save_share_image_dialog/);
  assert.match(bridge, /cursor:connect:start/);
  assert.match(bridge, /cursor:connect:poll/);
  assert.match(bridge, /cursor:connect:cancel/);
  assert.match(bridge, /usage:full-reconcile-status/);
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
  assert.ok(summary.allTimeTokens === 0 || typeof summary.allTimeTokens === "number");
  assert.ok(summary.allTimeCost === 0 || typeof summary.allTimeCost === "number");
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

function testStoreAnalytics() {
  const store = new Store(path.join(tmp, "db-analytics-test.json"));
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId,
    nickname: "analytics-user", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });
  
  store.upsertModelPrice({
    model: "claude-3-5-sonnet",
    inputCostPerMTok: 3,
    outputCostPerMTok: 15,
    cacheReadCostPerMTok: 0.3,
    cacheWriteCostPerMTok: 3.75
  });

  const day = localDay();
  store.upsertUsageBatch({
    participantId: identity.participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [{
      day, toolCode: "claude", providerId: "claude_code_local",
      workdirHash: "wd_analytics", workdirDisplayName: "analytics-project",
      model: "claude-3-5-sonnet", inputTokens: 100000, outputTokens: 50000,
      cacheReadTokens: 50000, cacheWriteTokens: 10000, reasoningTokens: 0,
      totalTokens: 210000, sourceQuality: "exact", sourceFingerprint: "sf_analytics"
    }]
  });

  const data = store.analytics({ period: "today", participantId: identity.participantId });
  assert.equal(data.summary.totalTokens, 210000);
  assert.equal(data.summary.inputTokens, 100000);
  assert.equal(data.summary.outputTokens, 50000);
  assert.equal(data.summary.cacheReadTokens, 50000);
  assert.equal(data.summary.cacheWriteTokens, 10000);
  
  assert.ok(Math.abs(data.summary.cacheSavingsUsd - 0.135) < 0.00001);
  assert.ok(Math.abs(data.summary.cacheHitRate - 50000 / 150000) < 0.00001);
  assert.equal(data.models.length, 1);
  assert.equal(data.models[0].name, "claude-3-5-sonnet");
  assert.equal(data.providers.length, 1);
  assert.equal(data.providers[0].name, "claude_code_local");
  assert.equal(data.timeSeries.length, 1);
  assert.equal(data.timeGrain, "day");
  assert.equal(data.timeSeries[0].totalTokens, 210000);
  assert.equal(data.timeSeries[0].activeCount, 1);
  assert.equal(data.heatmap.length, 365);
  assert.equal(data.heatmap.find(h => h.day === day).totalTokens, 210000);

  console.log("  testStoreAnalytics passed");
}

function testStoreAnalyticsHourly() {
  const store = new Store(path.join(tmp, "db-analytics-hourly.json"));
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId,
    nickname: "hourly-user", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });

  const today = localDay();
  // Write hourly snapshots for hours 9, 10, 11
  // Note: normalizeUsageTotal recalculates totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  const hourTokens = { 9: { input: 3000, output: 2000, cacheRead: 5000, cacheWrite: 0 }, 10: { input: 4000, output: 3000, cacheRead: 4000, cacheWrite: 0 }, 11: { input: 2000, output: 1000, cacheRead: 7000, cacheWrite: 0 } };
  for (const [h, t] of Object.entries(hourTokens)) {
    const hour = Number(h);
    const total = t.input + t.output + t.cacheRead + t.cacheWrite;
    store.upsertUsageBatch(makeHourlySnapshotPayload([
      makeSnapshotItem({ day: today, hour, workdirHash: "wd_h", inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cacheRead, cacheWriteTokens: t.cacheWrite, reasoningTokens: 0, totalTokens: total })
    ], identity.participantId, deviceId, { day: today, hour }));
  }

  const data = store.analytics({ period: "today", participantId: identity.participantId });
  assert.equal(data.timeGrain, "hour", "timeGrain must be 'hour' when hourly data exists");
  assert.equal(data.timeSeries.length, 24, "timeSeries must have 24 entries for hourly");
  // Hours 9,10,11 should have tokens; others zero
  assert.equal(data.timeSeries[9].totalTokens, 10000);
  assert.equal(data.timeSeries[10].totalTokens, 11000);
  assert.equal(data.timeSeries[11].totalTokens, 10000);
  assert.equal(data.timeSeries[0].totalTokens, 0, "hour 0 should be zero");
  assert.equal(data.timeSeries[9].label, "09:00", "label format must be HH:00");
  assert.equal(data.timeSeries[9].hour, 9);
  assert.equal(data.timeSeries[9].day, today);
  // Summary should include hourly-derived daily total (31000 = 10000+11000+10000)
  assert.equal(data.summary.totalTokens, 31000, "summary must reflect hourly-derived daily total");
  assert.equal(data.heatmap.length, 365);
  assert.equal(data.heatmap.find(hm => hm.day === today).totalTokens, 31000, "heatmap must reflect today total");

  if (fs.existsSync(path.join(tmp, "db-analytics-hourly.json"))) fs.unlinkSync(path.join(tmp, "db-analytics-hourly.json"));
  console.log("  testStoreAnalyticsHourly passed");
}

function testStoreAnalyticsHourlyYesterday() {
  const store = new Store(path.join(tmp, "db-analytics-hourly-y.json"));
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId,
    nickname: "hourly-yesterday", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });

  const yesterday = addDays(localDay(), -1);
  const yTokens = { 14: 7500, 15: 8000 };
  for (const [h, tokens] of Object.entries(yTokens)) {
    const hour = Number(h);
    store.upsertUsageBatch(makeHourlySnapshotPayload([
      makeSnapshotItem({ day: yesterday, hour, workdirHash: "wd_hy", inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: tokens })
    ], identity.participantId, deviceId, { day: yesterday, hour }));
  }

  const data = store.analytics({ period: "yesterday", participantId: identity.participantId });
  assert.equal(data.timeGrain, "hour", "yesterday with hourly data must return timeGrain=hour");
  assert.equal(data.timeSeries.length, 24);
  assert.equal(data.timeSeries[14].totalTokens, 7500);
  assert.equal(data.timeSeries[15].totalTokens, 8000);
  assert.equal(data.summary.totalTokens, 15500);
  assert.equal(data.period, "yesterday");
  assert.equal(data.from, yesterday);
  assert.equal(data.to, yesterday);

  if (fs.existsSync(path.join(tmp, "db-analytics-hourly-y.json"))) fs.unlinkSync(path.join(tmp, "db-analytics-hourly-y.json"));
  console.log("  testStoreAnalyticsHourlyYesterday passed");
}

function testStoreAnalyticsDailyFallbackWhenNoHourly() {
  const store = new Store(path.join(tmp, "db-analytics-daily-fb.json"));
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId,
    nickname: "daily-fb", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });

  const today = localDay();
  // Write daily-only data (no hourly)
  store.upsertUsageBatch({
    participantId: identity.participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [makeSnapshotItem({ day: today, workdirHash: "wd_dfb", totalTokens: 5000, inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 1500, cacheWriteTokens: 500, reasoningTokens: 0 })]
  });

  const data = store.analytics({ period: "today", participantId: identity.participantId });
  assert.equal(data.timeGrain, "day", "without hourly data, timeGrain must be 'day'");
  assert.equal(data.timeSeries.length, 1, "daily fallback should produce 1 timeSeries entry");
  assert.equal(data.timeSeries[0].day, today);
  assert.equal(data.timeSeries[0].totalTokens, 5000);
  assert.equal(data.summary.totalTokens, 5000);

  if (fs.existsSync(path.join(tmp, "db-analytics-daily-fb.json"))) fs.unlinkSync(path.join(tmp, "db-analytics-daily-fb.json"));
  console.log("  testStoreAnalyticsDailyFallbackWhenNoHourly passed");
}

function testStoreAnalyticsCacheCalculations() {
  const store = new Store(path.join(tmp, "db-analytics-cache.json"));
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId,
    nickname: "cache-user", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });

  store.upsertModelPrice({
    model: "claude-3-5-sonnet",
    inputCostPerMTok: 3,
    outputCostPerMTok: 15,
    cacheReadCostPerMTok: 0.3,
    cacheWriteCostPerMTok: 3.75
  });

  const day = localDay();
  store.upsertUsageBatch({
    participantId: identity.participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [{
      day, toolCode: "claude", providerId: "claude_code_local",
      workdirHash: "wd_cache", workdirDisplayName: "cache-project",
      model: "claude-3-5-sonnet", inputTokens: 200000, outputTokens: 100000,
      cacheReadTokens: 600000, cacheWriteTokens: 50000, reasoningTokens: 0,
      totalTokens: 950000, sourceQuality: "exact", sourceFingerprint: "sf_cache"
    }]
  });

  const data = store.analytics({ period: "today", participantId: identity.participantId });
  // cacheHitRate = cacheRead / (input + cacheRead) = 600000 / (200000 + 600000) = 0.75
  assert.ok(Math.abs(data.summary.cacheHitRate - 0.75) < 0.00001, "cacheHitRate must be 0.75");
  // cacheSavingsUsd = cacheRead * (inputPrice - cacheReadPrice) = 600000 * (3e-6 - 0.3e-6) = 600000 * 2.7e-6 = 1.62
  assert.ok(Math.abs(data.summary.cacheSavingsUsd - 1.62) < 0.0001, "cacheSavingsUsd must be ~1.62");
  assert.equal(data.summary.inputTokens, 200000);
  assert.equal(data.summary.outputTokens, 100000);
  assert.equal(data.summary.cacheReadTokens, 600000);
  assert.equal(data.summary.cacheWriteTokens, 50000);

  if (fs.existsSync(path.join(tmp, "db-analytics-cache.json"))) fs.unlinkSync(path.join(tmp, "db-analytics-cache.json"));
  console.log("  testStoreAnalyticsCacheCalculations passed");
}

function testStoreAnalyticsMultiModel() {
  const store = new Store(path.join(tmp, "db-analytics-multi.json"));
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId,
    nickname: "multi-user", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });

  const day = localDay();
  store.upsertUsageBatch({
    participantId: identity.participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [
      { day, toolCode: "claude", providerId: "claude_code_local", workdirHash: "wd_m1", workdirDisplayName: "p1", model: "claude-sonnet-4-5", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 1500, sourceQuality: "exact", sourceFingerprint: "sf_m1" },
      { day, toolCode: "codex", providerId: "codex_local", workdirHash: "wd_m2", workdirDisplayName: "p2", model: "gpt-5", inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 3000, sourceQuality: "exact", sourceFingerprint: "sf_m2" },
      { day, toolCode: "claude", providerId: "claude_code_local", workdirHash: "wd_m3", workdirDisplayName: "p3", model: "claude-sonnet-4-5", inputTokens: 500, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 750, sourceQuality: "exact", sourceFingerprint: "sf_m3" }
    ]
  });

  const data = store.analytics({ period: "today", participantId: identity.participantId });
  assert.equal(data.summary.totalTokens, 5250);
  // Models sorted by tokens desc: gpt-5 (3000) > claude-sonnet-4-5 (2250)
  assert.equal(data.models.length, 2);
  assert.equal(data.models[0].name, "gpt-5");
  assert.equal(data.models[0].tokens, 3000);
  assert.equal(data.models[1].name, "claude-sonnet-4-5");
  assert.equal(data.models[1].tokens, 2250);
  // Ratios
  assert.ok(Math.abs(data.models[0].ratio - 3000 / 5250) < 0.00001);
  assert.ok(Math.abs(data.models[1].ratio - 2250 / 5250) < 0.00001);
  // Providers sorted by tokens desc
  assert.equal(data.providers.length, 2);
  assert.equal(data.providers[0].name, "codex_local");
  assert.equal(data.providers[0].tokens, 3000);
  assert.equal(data.providers[1].name, "claude_code_local");
  assert.equal(data.providers[1].tokens, 2250);

  if (fs.existsSync(path.join(tmp, "db-analytics-multi.json"))) fs.unlinkSync(path.join(tmp, "db-analytics-multi.json"));
  console.log("  testStoreAnalyticsMultiModel passed");
}

function testStoreAnalyticsHeatmap() {
  const store = new Store(path.join(tmp, "db-analytics-heatmap.json"));
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId,
    nickname: "heatmap-user", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });

  const today = localDay();
  const day30 = addDays(today, -30);
  store.upsertUsageBatch({
    participantId: identity.participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [makeSnapshotItem({ day: today, workdirHash: "wd_hm1", inputTokens: 400, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 100, totalTokens: 1000 })]
  });
  store.upsertUsageBatch({
    participantId: identity.participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [makeSnapshotItem({ day: day30, workdirHash: "wd_hm2", inputTokens: 800, outputTokens: 400, cacheReadTokens: 600, cacheWriteTokens: 200, totalTokens: 2000 })]
  });

  const data = store.analytics({ period: "today", participantId: identity.participantId });
  assert.equal(data.heatmap.length, 365, "heatmap covers trailing year by day");
  // Verify continuity
  for (let i = 1; i < data.heatmap.length; i++) {
    const prev = new Date(data.heatmap[i - 1].day + "T00:00:00Z");
    const curr = new Date(data.heatmap[i].day + "T00:00:00Z");
    const diffMs = curr.getTime() - prev.getTime();
    assert.equal(diffMs, 86400000, `heatmap gap at index ${i}: ${data.heatmap[i - 1].day} -> ${data.heatmap[i].day}`);
  }
  // Verify today's data
  const todayEntry = data.heatmap.find(h => h.day === today);
  assert.ok(todayEntry, "heatmap must contain today");
  assert.equal(todayEntry.totalTokens, 1000);
  // Verify day-30 data
  const day30Entry = data.heatmap.find(h => h.day === day30);
  assert.ok(day30Entry, "heatmap must contain day-30");
  assert.equal(day30Entry.totalTokens, 2000);
  // Period change should not affect heatmap window
  const dataWeek = store.analytics({ period: "this_week", participantId: identity.participantId });
  assert.equal(dataWeek.heatmap.length, 365, "heatmap must stay trailing-year regardless of period");
  assert.equal(dataWeek.heatmap.find((h) => h.day === day30)?.totalTokens, 2000);

  if (fs.existsSync(path.join(tmp, "db-analytics-heatmap.json"))) fs.unlinkSync(path.join(tmp, "db-analytics-heatmap.json"));
  console.log("  testStoreAnalyticsHeatmap passed");
}

function testStoreAnalyticsEmptyStore() {
  const store = new Store(path.join(tmp, "db-analytics-empty.json"));
  const data = store.analytics({ period: "today" });
  assert.equal(data.summary.totalTokens, 0);
  assert.equal(data.models.length, 0);
  assert.equal(data.providers.length, 0);
  assert.equal(data.timeGrain, "day");
  assert.equal(data.timeSeries.length, 1, "empty today should still have 1 timeSeries entry");
  assert.equal(data.timeSeries[0].totalTokens, 0);
  assert.equal(data.heatmap.length, 365, "empty store still returns trailing-year heatmap skeleton");
  assert.equal(data.period, "today");
  assert.ok(data.from, "from must be set");
  assert.ok(data.to, "to must be set");

  if (fs.existsSync(path.join(tmp, "db-analytics-empty.json"))) fs.unlinkSync(path.join(tmp, "db-analytics-empty.json"));
  console.log("  testStoreAnalyticsEmptyStore passed");
}

function testStoreAnalyticsDateRanges() {
  const store = new Store(path.join(tmp, "db-analytics-ranges.json"));
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId, deviceId,
    nickname: "range-user", identityPublicKey: identity.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });

  // Insert data for today only — guaranteed to be in every period (this_week, this_month, etc.)
  // This avoids boundary failures when today is Monday (ISO week start) and yesterday
  // falls in the previous week, or when today is the 1st and yesterday is last month.
  const today = localDay();
  store.upsertUsageBatch({
    participantId: identity.participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [makeSnapshotItem({ day: today, workdirHash: "wd_r1", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 150 })]
  });

  // period=this_week — today is always in the current week
  const week = store.analytics({ period: "this_week", participantId: identity.participantId });
  assert.equal(week.period, "this_week");
  assert.equal(week.summary.totalTokens, 150);

  // period=this_month — today is always in the current month
  const month = store.analytics({ period: "this_month", participantId: identity.participantId });
  assert.equal(month.period, "this_month");
  assert.equal(month.summary.totalTokens, 150);

  // range=this_week
  const rangeWeek = store.analytics({ range: "this_week", participantId: identity.participantId });
  assert.equal(rangeWeek.summary.totalTokens, 150);

  // range=last30 — covers trailing 30 days, always includes today
  const rangeLast30 = store.analytics({ range: "last30", participantId: identity.participantId });
  assert.equal(rangeLast30.summary.totalTokens, 150);

  // custom range — single day, only today
  const custom = store.analytics({ range: "custom", startDay: today, endDay: today, participantId: identity.participantId });
  assert.equal(custom.summary.totalTokens, 150, "custom range single day should only include today");
  assert.equal(custom.from, today);
  assert.equal(custom.to, today);

  // No participantId = all users
  const all = store.analytics({ period: "today" });
  assert.equal(all.summary.totalTokens, 150, "no participantId should aggregate all");

  if (fs.existsSync(path.join(tmp, "db-analytics-ranges.json"))) fs.unlinkSync(path.join(tmp, "db-analytics-ranges.json"));
  console.log("  testStoreAnalyticsDateRanges passed");
}

function testStoreAnalyticsRankStats() {
  const store = new Store(path.join(tmp, "db-analytics-rank-stats.json"));
  const identityA = generateIdentity();
  const identityB = generateIdentity();
  const deviceA = newId("d");
  const deviceB = newId("d");
  store.registerDevice({
    participantId: identityA.participantId, deviceId: deviceA,
    nickname: "rank-a", identityPublicKey: identityA.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });
  store.registerDevice({
    participantId: identityB.participantId, deviceId: deviceB,
    nickname: "rank-b", identityPublicKey: identityB.identityPublicKey,
    os: "test", appVersion: APP_VERSION
  });

  const today = localDay();
  const yesterday = addDays(today, -1);
  store.upsertUsageBatch({
    participantId: identityA.participantId, deviceId: deviceA,
    clientGeneratedAt: new Date().toISOString(),
    items: [
      makeSnapshotItem({ day: yesterday, workdirHash: "rank_a_y", inputTokens: 300, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 300 }),
      makeSnapshotItem({ day: today, workdirHash: "rank_a_t", inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 100 })
    ]
  });
  store.upsertUsageBatch({
    participantId: identityB.participantId, deviceId: deviceB,
    clientGeneratedAt: new Date().toISOString(),
    items: [
      makeSnapshotItem({ day: yesterday, workdirHash: "rank_b_y", inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 100 }),
      makeSnapshotItem({ day: today, workdirHash: "rank_b_t", inputTokens: 200, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 200 })
    ]
  });

  const data = store.analytics({
    range: "custom",
    startDay: yesterday,
    endDay: today,
    participantId: identityA.participantId
  });
  assert.equal(data.rankStats.rank, 1);
  assert.equal(data.rankStats.participantCount, 2);
  assert.equal(data.rankStats.leaderDays, 1);
  assert.equal(data.rankStats.isLeaderToday, false);

  const community = store.analytics({
    range: "custom",
    startDay: yesterday,
    endDay: today
  });
  assert.deepEqual(community.participantRanking.map((item) => [item.rank, item.nickname, item.totalTokens]), [
    [1, "rank-a", 400],
    [2, "rank-b", 300]
  ]);
  assert.equal(Object.hasOwn(data, "participantRanking"), false, "individual analytics must not include community ranking");

  if (fs.existsSync(path.join(tmp, "db-analytics-rank-stats.json"))) fs.unlinkSync(path.join(tmp, "db-analytics-rank-stats.json"));
  console.log("  testStoreAnalyticsRankStats passed");
}

function testStoreAnalyticsAllPeriodCache() {
  assert.equal(ANALYTICS_ALL_CACHE_TTL_MS, 2 * 60 * 60 * 1000);

  const store = new Store(path.join(tmp, "db-analytics-all-cache.json"), {
    persist: false,
    businessDayProvider: () => "2026-07-17"
  });
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId,
    deviceId,
    nickname: "all-cache-user",
    identityPublicKey: identity.identityPublicKey,
    os: "test",
    appVersion: APP_VERSION
  });

  store.upsertUsageBatch({
    participantId: identity.participantId,
    deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [
      makeSnapshotItem({
        day: "2026-06-01",
        workdirHash: "all_a",
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 100
      }),
      makeSnapshotItem({
        day: "2026-07-01",
        workdirHash: "all_b",
        inputTokens: 200,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 200
      })
    ]
  });

  const first = store.analytics({ period: "all" });
  assert.equal(first.summary.totalTokens, 300);
  assert.equal(Object.keys(store.analyticsAllCache).length, 1);
  const cacheKey = Object.keys(store.analyticsAllCache)[0];
  assert.ok(store.analyticsAllCache[cacheKey].expiresAt > Date.now());
  assert.ok(
    store.analyticsAllCache[cacheKey].expiresAt <= Date.now() + ANALYTICS_ALL_CACHE_TTL_MS + 1000
  );

  // Fresh upload + aggregate-cache invalidation must not drop the 2h all-period cache.
  store.upsertUsageBatch({
    participantId: identity.participantId,
    deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items: [
      makeSnapshotItem({
        day: "2026-07-10",
        workdirHash: "all_c",
        inputTokens: 999,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 999
      })
    ]
  });
  store.invalidateAggregateCache();
  const second = store.analytics({ period: "all" });
  assert.equal(second.summary.totalTokens, 300, "all-period cache should survive invalidateAggregateCache");
  assert.equal(Object.keys(store.aggregateCache).length, 0);

  store.analyticsAllCache[cacheKey].expiresAt = Date.now() - 1;
  const third = store.analytics({ period: "all" });
  assert.equal(third.summary.totalTokens, 1299, "expired all-period cache should recompute");

  const byRange = store.analytics({ range: "all" });
  assert.equal(byRange.summary.totalTokens, 1299);
  assert.ok(Object.keys(store.analyticsAllCache).length >= 1);

  console.log("  testStoreAnalyticsAllPeriodCache passed");
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
await testUsageBatchUploadIsolatesPoisonedBucket();
await testSyncStateEndpointLimitAndRecentSignatureCompatibility();
await testFullReconcileHttpCompareRepairFlow();
await testUsageUploadRejectsUnregistered();
await testAdminAuthEnforcement();
await testAdminAuthDisabledWhenNotConfigured();
await testAdminUsageRankingPagination();
await testAdminUsageRankingSourceFilter();
testPublicLeaderboardSourceFilterAggregation();
await testBoardLeaderboardSourceFilter();
await testBoardSourceLeaderboardEndpoint();
await testAdminSourceStatsEndpoint();
await testMysqlSourceAggregations();
await testBoardPublicMode();
await testBoardAuthenticatedMode();
await testSelfServiceDeletionReplayProtection();
await testSelfServiceDeletionMultiDevice();
await testSelfServiceDeletionSingleDeviceWipesAll();
await testSelfServiceDeletionRejectsCrossParticipantDevice();
await testSelfServiceDeletionRejectsInvalidSignature();
await testLeaderboardEndpoint();
await testBoardParticipantDetailAndTrend();
await testHourlyWorkWindowEnv();
await testAdminParticipantDetailUsesRangeAndGrainSeparately();
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
testWebAnalyticsParticipantRankingStructure();
testWebAdminStructure();
testWebDownloadStructure();
testWebProfileHeatmapScale();
testWebProfileHourlyCard();
testDesktopRendererExports();
testTauriBridgeExports();

// Store-level edge case tests
testMultiParticipantLeaderboard();
testDeviceManagementStore();
testWorkdirAliasUpdate();
testStoreAggregateCacheInvalidation();
testStoreBoardSummary();
testStoreDeleteModelPrice();
testStoreAnalytics();
testStoreAnalyticsHourly();
testStoreAnalyticsHourlyYesterday();
testStoreAnalyticsDailyFallbackWhenNoHourly();
testStoreAnalyticsCacheCalculations();
testStoreAnalyticsMultiModel();
testStoreAnalyticsHeatmap();
testStoreAnalyticsEmptyStore();
testStoreAnalyticsDateRanges();
testStoreAnalyticsRankStats();
testStoreAnalyticsAllPeriodCache();
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
  const day = localDay(), providerId = "codex_local";

  store.registerDevice({ participantId: pid, deviceId: did, nickname: "SS", identityPublicKey: "pk_ss", os: "test", appVersion: "0.1.0" });

  // Upload a snapshot to create a sync bucket
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash: "h1", totalTokens: 100, providerId, day, hour: 10 })
  ], pid, did, { providerId, day, hour: 10 }));
  const factualFingerprint = computeBucketFingerprint(Object.values(store.db.usageHourly).filter((item) => (
    item.participantId === pid && item.deviceId === did && item.day === day
      && item.hour === 10 && item.providerId === providerId
  )));

  const result = store.compareSyncState({
    participantId: pid, deviceId: did,
    buckets: [
      { day, hour: 10, providerId, fingerprint: factualFingerprint },
      { day, hour: 11, providerId, fingerprint: "nonexistent_fp" }
    ]
  });

  assert.equal(result.matched.length, 1, "hour 10 should match");
  assert.equal(result.missing.length, 1, "hour 11 should be missing");
  assert.equal(result.different.length, 0, "no different buckets");

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testSyncStateReturnsMissingAndMatched passed");
}

function testSyncStateFallsBackToHourlyRowsWhenMetadataMissing() {
  const tmp = path.join(os.tmpdir(), `test-sync-state-hourly-fallback-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_ssh", did = "d_ssh";
  const day = localDay(), providerId = "codex_local";

  store.registerDevice({ participantId: pid, deviceId: did, nickname: "SSH", identityPublicKey: "pk_ssh", os: "test", appVersion: "0.1.0" });

  const payload = makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash: "h1", totalTokens: 150, providerId, day, hour: 10 })
  ], pid, did, { providerId, day, hour: 10 });
  store.upsertUsageBatch(payload);
  store.db.usageSyncBucketsHourly = {};

  const result = store.compareSyncState({
    participantId: pid, deviceId: did,
    buckets: [{ day, hour: 10, providerId, fingerprint: payload.snapshot.bucketFingerprint }]
  });

  assert.equal(result.matched.length, 1, "hourly rows with matching fingerprint should count as matched");
  assert.equal(result.missing.length, 0, "metadata-only loss should not force retry when facts exist");
  assert.equal(result.different.length, 0, "matching hourly facts should not be different");

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testSyncStateFallsBackToHourlyRowsWhenMetadataMissing passed");
}

function testSyncStateUsesFactsWhenMetadataIsStale() {
  const tmp = path.join(os.tmpdir(), `test-sync-state-stale-metadata-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_stale", did = "d_stale", day = localDay(), providerId = "codex_local";
  store.registerDevice({ participantId: pid, deviceId: did, nickname: "Stale", identityPublicKey: "pk_stale", os: "test", appVersion: "0.1.0" });
  const payload = makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash: "h1", totalTokens: 100, providerId, day, hour: 10 })
  ], pid, did, { providerId, day, hour: 10 });
  store.upsertUsageBatch(payload);
  const row = Object.values(store.db.usageHourly).find((item) => item.participantId === pid && item.deviceId === did);
  row.inputTokens = 200;
  row.totalTokens = 200;
  const result = store.compareSyncState({
    participantId: pid, deviceId: did, mode: "full_reconcile",
    buckets: [{ day, hour: 10, providerId, fingerprint: payload.snapshot.bucketFingerprint, granularity: "hourly" }]
  });
  assert.equal(result.different.length, 1, "raw hourly facts must override stale bucket metadata");
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testSyncStateUsesFactsWhenMetadataIsStale passed");
}

function testSyncStateAfterResetDetectsMissing() {
  const tmp = path.join(os.tmpdir(), `test-sync-reset-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_ssr", did = "d_ssr";
  const day = localDay(), providerId = "cursor_dashboard_usage";

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

function testReconcileDailyScopeInventoryIsDeviceScopedAndPaged() {
  const tmp = path.join(os.tmpdir(), `test-reconcile-inventory-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_inventory", didA = "d_inventory_a", didB = "d_inventory_b";
  const providerId = "codex_local";
  store.registerDevice({ participantId: pid, deviceId: didA, nickname: "A", identityPublicKey: "pk_a", os: "test", appVersion: "0.1.0" });
  store.registerDevice({ participantId: pid, deviceId: didB, nickname: "B", identityPublicKey: "pk_a", os: "test", appVersion: "0.1.0" });
  for (const day of ["2026-03-01", "2026-03-02"]) {
    store.upsertUsageBatch(makeHourlySnapshotPayload([
      makeSnapshotItem({ day, hour: 8, providerId, workdirHash: `a_${day}`, totalTokens: 100 })
    ], pid, didA, { day, hour: 8, providerId }));
  }
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ day: "2026-03-03", hour: 8, providerId, workdirHash: "b_only", totalTokens: 100 })
  ], pid, didB, { day: "2026-03-03", hour: 8, providerId }));

  const first = store.listReconcileDailyScopes(pid, didA, { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.hasMore, true);
  assert.equal(first.items[0].day, "2026-03-01");
  const second = store.listReconcileDailyScopes(pid, didA, { cursor: first.nextCursor, limit: 1 });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].day, "2026-03-02");
  assert.equal(second.hasMore, false);
  assert.equal(second.items.some((item) => item.day === "2026-03-03"), false, "other device scope must never be inventoried");

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testReconcileDailyScopeInventoryIsDeviceScopedAndPaged passed");
}

function testReconcileDailyScopesPrunesServerOnlyAndRebuildsCurrentDeviceDaily() {
  const tmp = path.join(os.tmpdir(), `test-reconcile-scopes-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_scope", didA = "d_scope_a", didB = "d_scope_b";
  const providerId = "codex_local", localDay = "2026-03-10", staleDay = "2026-02-10";
  store.registerDevice({ participantId: pid, deviceId: didA, nickname: "A", identityPublicKey: "pk_a", os: "test", appVersion: "0.1.0" });
  store.registerDevice({ participantId: pid, deviceId: didB, nickname: "B", identityPublicKey: "pk_a", os: "test", appVersion: "0.1.0" });
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ day: localDay, hour: 8, providerId, workdirHash: "local_hourly", totalTokens: 100 })
  ], pid, didA, { day: localDay, hour: 8, providerId }));
  // Simulate a legacy daily row that remained beside the hourly-derived fact.
  store.upsertUsageBatch(makeSnapshotPayload([
    makeSnapshotItem({ day: localDay, providerId, workdirHash: "legacy_extra", totalTokens: 900 })
  ], pid, didA, { day: localDay, providerId }));
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ day: staleDay, hour: 8, providerId, workdirHash: "stale", totalTokens: 500 })
  ], pid, didA, { day: staleDay, hour: 8, providerId }));
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ day: staleDay, hour: 8, providerId, workdirHash: "other_device", totalTokens: 700 })
  ], pid, didB, { day: staleDay, hour: 8, providerId }));

  const inventory = store.listReconcileDailyScopes(pid, didA);
  const scope = (day) => inventory.items.find((item) => item.day === day);
  const result = store.reconcileDailyScopes(pid, didA, [
    { day: localDay, providerId, action: "rebuild", expectedFingerprint: scope(localDay).fingerprint },
    { day: staleDay, providerId, action: "prune", expectedFingerprint: scope(staleDay).fingerprint }
  ]);
  assert.equal(result.rebuilt, 1);
  assert.equal(result.pruned, 1);
  const currentDaily = Object.values(store.db.usageDaily).filter((row) => row.participantId === pid && row.deviceId === didA && row.day === localDay);
  assert.equal(currentDaily.length, 1);
  assert.equal(currentDaily[0].totalTokens, 150, "rebuild must remove legacy daily residue");
  assert.equal(Object.values(store.db.usageDaily).some((row) => row.participantId === pid && row.deviceId === didA && row.day === staleDay), false);
  assert.equal(Object.values(store.db.usageHourly).some((row) => row.participantId === pid && row.deviceId === didA && row.day === staleDay), false);
  assert.equal(Object.values(store.db.usageDaily).some((row) => row.participantId === pid && row.deviceId === didB && row.day === staleDay), true, "other device facts must be preserved");

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testReconcileDailyScopesPrunesServerOnlyAndRebuildsCurrentDeviceDaily passed");
}

function testFullReconcileModeNoCutoff() {
  const tmp = path.join(os.tmpdir(), `test-full-reconcile-no-cutoff-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_fr", did = "d_fr";
  const oldDay = "2026-01-01", providerId = "codex_local";

  store.registerDevice({ participantId: pid, deviceId: did, nickname: "FR", identityPublicKey: "pk_fr", os: "test", appVersion: "0.1.0" });

  // Upload an old hourly bucket
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash: "h1", totalTokens: 100, providerId, day: oldDay, hour: 8 })
  ], pid, did, { providerId, day: oldDay, hour: 8 }));

  const fp = computeBucketFingerprint(Object.values(store.db.usageHourly).filter((item) => (
    item.participantId === pid && item.deviceId === did && item.day === oldDay
      && item.hour === 8 && item.providerId === providerId
  )));

  // recent mode would skip this old bucket; full_reconcile should not
  const recentResult = store.compareSyncState({
    participantId: pid, deviceId: did,
    buckets: [{ day: oldDay, hour: 8, providerId, fingerprint: fp, granularity: "hourly" }],
    mode: "recent"
  });
  assert.equal(recentResult.matched.length, 0, "recent mode should skip old bucket");

  const fullResult = store.compareSyncState({
    participantId: pid, deviceId: did,
    buckets: [{ day: oldDay, hour: 8, providerId, fingerprint: fp, granularity: "hourly" }],
    mode: "full_reconcile"
  });
  assert.equal(fullResult.matched.length, 1, "full_reconcile should not skip old bucket");
  assert.equal(fullResult.checkedBucketCount, 1, "should report checkedBucketCount");
  assert.equal(fullResult.unknownLegacy.length, 0, "hourly bucket should not be unknownLegacy");

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testFullReconcileModeNoCutoff passed");
}

function testFullReconcileDailyGranularity() {
  const tmp = path.join(os.tmpdir(), `test-full-reconcile-daily-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_frd", did = "d_frd";
  const day = "2026-03-10", providerId = "codex_local";

  store.registerDevice({ participantId: pid, deviceId: did, nickname: "FRD", identityPublicKey: "pk_frd", os: "test", appVersion: "0.1.0" });

  // Upload a daily bucket using legacy protocol
  store.upsertUsageBatch(makeSnapshotPayload([
    makeSnapshotItem({ workdirHash: "h1", totalTokens: 200, providerId, day })
  ], pid, did, { providerId, day }));

  const fp = computeDailyBucketFingerprint(Object.values(store.db.usageDaily).filter((item) => (
    item.participantId === pid && item.deviceId === did && item.day === day
      && item.providerId === providerId
  )));

  const result = store.compareSyncState({
    participantId: pid, deviceId: did,
    buckets: [{ day, providerId, fingerprint: fp, granularity: "daily" }],
    mode: "full_reconcile"
  });
  assert.equal(result.matched.length, 1, "daily bucket should match via daily sync metadata");
  assert.equal(result.missing.length, 0);

  // A daily bucket should NOT match hourly metadata
  const hourlyOnlyResult = store.compareSyncState({
    participantId: pid, deviceId: did,
    buckets: [{ day, hour: 0, providerId, fingerprint: fp, granularity: "hourly" }],
    mode: "full_reconcile"
  });
  assert.equal(hourlyOnlyResult.matched.length, 0, "hourly query should not match daily-only data");

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testFullReconcileDailyGranularity passed");
}

function testFullReconcileDailyFallbackMatchesHourlyDerivedUsageDaily() {
  const tmp = path.join(os.tmpdir(), `test-full-reconcile-daily-derived-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_frdd", did = "d_frdd";
  const day = "2026-03-10", providerId = "codex_local";

  store.registerDevice({ participantId: pid, deviceId: did, nickname: "FRDD", identityPublicKey: "pk_frdd", os: "test", appVersion: "0.1.0" });
  store.upsertUsageBatch(makeHourlySnapshotPayload([
    makeSnapshotItem({ workdirHash: "h1", totalTokens: 200, providerId, day, hour: 8 })
  ], pid, did, { providerId, day, hour: 8 }));

  store.db.usageSyncBuckets = {};
  const dailyRows = Object.values(store.db.usageDaily).filter((item) => {
    return item.participantId === pid && item.deviceId === did && item.day === day && item.providerId === providerId;
  });
  assert.equal(dailyRows.some((item) => item.hourlyDerived), true, "test setup should use hourly-derived daily facts");
  const fp = computeDailyBucketFingerprint(dailyRows);

  const result = store.compareSyncState({
    participantId: pid, deviceId: did,
    buckets: [{ day, providerId, fingerprint: fp, granularity: "daily" }],
    mode: "full_reconcile"
  });
  assert.equal(result.matched.length, 1, "daily fallback should use usage_daily facts even when rows are hourly-derived");
  assert.equal(result.missing.length, 0);

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testFullReconcileDailyFallbackMatchesHourlyDerivedUsageDaily passed");
}

function testFullReconcileDailyFallbackIgnoresHour() {
  const tmp = path.join(os.tmpdir(), `test-full-reconcile-daily-ignore-hour-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_frdi", did = "d_frdi";
  const day = "2026-03-10", providerId = "codex_local";

  store.registerDevice({ participantId: pid, deviceId: did, nickname: "FRDI", identityPublicKey: "pk_frdi", os: "test", appVersion: "0.1.0" });
  store.upsertUsageBatch(makeSnapshotPayload([
    makeSnapshotItem({ workdirHash: "h1", inputTokens: 50, outputTokens: 50, totalTokens: 100, providerId, day, hour: 8 })
  ], pid, did, { providerId, day }));

  store.db.usageSyncBuckets = {};
  const localRowsWithHour = [
    makeSnapshotItem({ workdirHash: "h1", inputTokens: 50, outputTokens: 50, totalTokens: 100, providerId, day, hour: 8 })
  ];
  const fp = computeDailyBucketFingerprint(localRowsWithHour);

  const result = store.compareSyncState({
    participantId: pid, deviceId: did,
    buckets: [{ day, providerId, fingerprint: fp, granularity: "daily" }],
    mode: "full_reconcile"
  });
  assert.equal(result.matched.length, 1, "daily fallback should ignore hour when metadata is missing");
  assert.equal(result.different.length, 0);
  assert.equal(result.missing.length, 0);

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testFullReconcileDailyFallbackIgnoresHour passed");
}

function testFullReconcileUnknownLegacy() {
  const tmp = path.join(os.tmpdir(), `test-full-reconcile-legacy-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_frl", did = "d_frl";

  store.registerDevice({ participantId: pid, deviceId: did, nickname: "FRL", identityPublicKey: "pk_frl", os: "test", appVersion: "0.1.0" });

  const result = store.compareSyncState({
    participantId: pid, deviceId: did,
    buckets: [
      { day: "2026-03-01", providerId: "codex_local", fingerprint: "fp1", granularity: "unknown_legacy" },
      { day: "2026-03-01", hour: 5, providerId: "codex_local", fingerprint: "fp2", granularity: "hourly" }
    ],
    mode: "full_reconcile"
  });
  assert.equal(result.unknownLegacy.length, 1, "unknown_legacy bucket should be reported");
  assert.equal(result.missing.length, 1, "hourly bucket with no server data should be missing");
  assert.equal(result.checkedBucketCount, 2);

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testFullReconcileUnknownLegacy passed");
}

function testFullReconcileBucketLimit() {
  const tmp = path.join(os.tmpdir(), `test-full-reconcile-limit-${Date.now()}.json`);
  const store = new Store(tmp);
  const pid = "p_limit", did = "d_limit";

  store.registerDevice({ participantId: pid, deviceId: did, nickname: "LIM", identityPublicKey: "pk_limit", os: "test", appVersion: "0.1.0" });

  // Store-level compare does not enforce the HTTP request limit; the route test covers 250.
  const buckets251 = Array.from({ length: 251 }, (_, i) => ({
    day: "2026-03-01", hour: i % 24, providerId: "codex_local", fingerprint: `fp_${i}`, granularity: "hourly"
  }));
  const result = store.compareSyncState({
    participantId: pid, deviceId: did,
    buckets: buckets251,
    mode: "full_reconcile"
  });
  assert.equal(result.checkedBucketCount, 251);

  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log("  testFullReconcileBucketLimit passed");
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

function testFormatContributionPercent() {
  assert.equal(formatContributionPercent(16, 100), "16.0%");
  assert.equal(formatContributionPercent(1, 2000), "<0.1%");
  assert.equal(formatContributionPercent(0, 100), "0.0%");
  assert.equal(formatContributionPercent(100, 0), "0.0%");
  assert.equal(formatContributionPercent(Number.NaN, 100), "0.0%");
  console.log("  testFormatContributionPercent passed");
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

function testDesktopCspAllowsBrandLogoDataImages() {
  const configPath = path.join(process.cwd(), "src-tauri", "tauri.conf.json");
  const tauriConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const csp = tauriConfig?.app?.security?.csp || "";
  const imgSrc = csp.match(/(?:^|;)\s*img-src\s+([^;]+)/)?.[1] || "";

  assert.ok(imgSrc, "desktop CSP must define img-src explicitly");
  assert.ok(imgSrc.split(/\s+/).includes("data:"), "desktop CSP img-src must allow data: brand logo images");
  assert.ok(imgSrc.split(/\s+/).includes("https:"), "desktop CSP img-src must allow https: brand logo sources");

  console.log("  testDesktopCspAllowsBrandLogoDataImages passed");
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

function testParticipantProfile() {
  const store = new Store(path.join(tmp, "db-participant-profile.json"));
  store.currentBusinessDay = () => "2026-08-27";
  const baseItem = {
    toolCode: "codex",
    workdirHash: "wd_participant_profile",
    workdirDisplayName: "participant-profile",
    model: "model_codex_local",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    sourceQuality: "exact",
    rawSourceRef: "",
    providerVersion: "0.1.0",
    parserVersion: "0.1.0"
  };
  const seed = (nickname, rows) => {
    const identity = generateIdentity();
    const deviceId = newId("d");
    store.registerDevice({
      participantId: identity.participantId,
      deviceId,
      nickname,
      identityPublicKey: identity.identityPublicKey,
      os: "test",
      appVersion: APP_VERSION
    });
    store.upsertUsageBatch({
      participantId: identity.participantId,
      deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: rows.map(({ providerId, totalTokens, usageDay, model }) => ({
        ...baseItem,
        providerId,
        day: usageDay,
        model: model || `model_${providerId}`,
        inputTokens: totalTokens,
        totalTokens,
        sourceFingerprint: `pp_${nickname}_${providerId}_${usageDay}_${model || ""}`
      }))
    });
    return identity.participantId;
  };

  assert.equal(store.participantProfile("nonexistent"), null);

  const alpha = seed("pp-alpha", [
    { providerId: "codex_local", totalTokens: 200, usageDay: "2026-08-25" },
    { providerId: "codex_local", totalTokens: 100, usageDay: "2026-08-26" },
    { providerId: "claude_code_local", totalTokens: 40, usageDay: "2026-08-27", model: "model_claude" },
    { providerId: "codex_local", totalTokens: 100, usageDay: "2026-08-27", model: "model_gpt52" }
  ]);
  const beta = seed("pp-beta", [
    { providerId: "codex_local", totalTokens: 50, usageDay: "2026-08-20" }
  ]);
  const gamma = seed("pp-gamma", [
    { providerId: "codex_local", totalTokens: 1000, usageDay: "2026-08-27" }
  ]);

  const alphaProfile = store.participantProfile(alpha);
  assert.equal(alphaProfile.nickname, "pp-alpha");
  assert.equal(alphaProfile.totalTokens, 440);
  assert.equal(alphaProfile.lastActiveDay, "2026-08-27");
  assert.equal(alphaProfile.activeDays, 3);
  assert.equal(alphaProfile.currentStreak, 3, "streak counts consecutive days up to the last active day");
  assert.equal(alphaProfile.bestStreak, 3);
  assert.equal(alphaProfile.rank, 2);
  assert.equal(alphaProfile.percentile, 33);
  assert.equal(alphaProfile.participantCount, 3, "participantCount reflects the all-time leaderboard size");
  assert.ok(Array.isArray(alphaProfile.monthlyRanks), "monthlyRanks must be an array");
  assert.ok(alphaProfile.monthlyRanks.length >= 1, "monthlyRanks must contain active months");
  assert.equal(alphaProfile.monthlyRanks.at(-1).rank, 2);
  assert.deepEqual(alphaProfile.providers, [
    { name: "codex_local", totalTokens: 400 },
    { name: "claude_code_local", totalTokens: 40 }
  ]);
  assert.deepEqual(alphaProfile.models, [
    { name: "model_codex_local", totalTokens: 300 },
    { name: "model_gpt52", totalTokens: 100 },
    { name: "model_claude", totalTokens: 40 }
  ]);
  assert.equal(Object.hasOwn(alphaProfile, "workdirs"), false, "profile must not expose workdir data");
  assert.equal(Object.hasOwn(alphaProfile, "rows"), false, "profile must not expose raw rows");
  assert.deepEqual(alphaProfile.peakDay, { day: "2026-08-25", totalTokens: 200 }, "peakDay aggregates every row of the all-time peak day");
  assert.ok(alphaProfile.peakDay.totalTokens <= alphaProfile.totalTokens, "peakDay tokens must stay within the career total");
  assert.ok(alphaProfile.peakDay.day >= "2026-08-25" && alphaProfile.peakDay.day <= alphaProfile.lastActiveDay, "peakDay day must be one of the active days");

  const betaProfile = store.participantProfile(beta);
  assert.equal(betaProfile.activeDays, 1);
  assert.equal(betaProfile.currentStreak, 1, "streak of the latest run survives idle days");
  assert.equal(betaProfile.bestStreak, 1);
  assert.equal(betaProfile.rank, 3);
  assert.equal(betaProfile.percentile, 0);
  assert.deepEqual(betaProfile.peakDay, { day: "2026-08-20", totalTokens: 50 });

  const gammaProfile = store.participantProfile(gamma);
  assert.equal(gammaProfile.rank, 1);
  assert.equal(gammaProfile.percentile, 67);
  assert.deepEqual(gammaProfile.peakDay, { day: "2026-08-27", totalTokens: 1000 });

  const costProfile = store.participantProfile(alpha, { includeCost: true });
  assert.equal(costProfile.estimatedCostUsd, null, "unpriced tokens surface as null cost");
  assert.equal(costProfile.missingPriceTokens, 440);
  assert.equal(costProfile.costQuality, "unknown_price");

  console.log("  testParticipantProfile passed");
}

function testParticipantHourlyRhythm() {
  const store = new Store(path.join(tmp, "db-participant-hourly-rhythm.json"));
  store.currentBusinessDay = () => "2026-08-27";
  const identity = generateIdentity();
  const deviceId = newId("d");
  store.registerDevice({
    participantId: identity.participantId,
    deviceId,
    nickname: "hourly-rhythm-user",
    identityPublicKey: identity.identityPublicKey,
    os: "test",
    appVersion: APP_VERSION
  });

  const seedHourly = (day, hour, tokens) => {
    store.upsertUsageBatch(makeHourlySnapshotPayload(
      [makeSnapshotItem({
        day, hour,
        inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        totalTokens: tokens,
        sourceFingerprint: `hr_${day}_${hour}`
      })],
      identity.participantId, deviceId, { day, hour }
    ));
  };
  seedHourly("2026-08-26", 14, 5000);
  seedHourly("2026-08-26", 15, 3000);
  seedHourly("2026-08-25", 14, 2000);
  seedHourly("2026-08-25", 2, 1000);
  seedHourly("2026-07-01", 14, 999000); // outside last30

  assert.equal(store.participantTrend("nonexistent", { grain: "hour-of-day" }), null);

  const rhythm = store.participantTrend(identity.participantId, { grain: "hour-of-day", range: "last30" });
  assert.equal(rhythm.grain, "hour-of-day");
  assert.equal(rhythm.items.length, 24, "hourly rhythm must always return 24 buckets");
  assert.equal(rhythm.items[14].totalTokens, 7000, "hour 14 sums across days in range");
  assert.equal(rhythm.items[15].totalTokens, 3000);
  assert.equal(rhythm.items[2].totalTokens, 1000);
  assert.equal(rhythm.items[0].totalTokens, 0, "unused hours stay zero");
  assert.equal(rhythm.items[14].label, "14:00");
  assert.equal(rhythm.items[14].hour, 14);
  assert.equal(rhythm.coverage.days, 2, "coverage counts distinct days with hourly rows in range");
  assert.equal(rhythm.from, "2026-08-25");
  assert.equal(rhythm.to, "2026-08-26");
  assert.ok(!("estimatedCostUsd" in rhythm.items[14]), "cost fields stay off without includeCost");

  const withCost = store.participantTrend(identity.participantId, { grain: "hour-of-day", range: "last30", includeCost: true });
  assert.ok("estimatedCostUsd" in withCost.items[14], "includeCost adds cost fields");

  const empty = store.participantHourlyRhythm(identity.participantId, { range: "custom", startDay: "2026-01-01", endDay: "2026-01-07" });
  assert.equal(empty.coverage.days, 0);
  assert.equal(empty.from, "", "empty range has no coverage extent");
  assert.ok(empty.items.every((item) => item.totalTokens === 0), "empty range returns zeroed buckets");

  if (fs.existsSync(path.join(tmp, "db-participant-hourly-rhythm.json"))) fs.unlinkSync(path.join(tmp, "db-participant-hourly-rhythm.json"));
  console.log("  testParticipantHourlyRhythm passed");
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

async function testBrandLogoEndpoint() {
  // Without BRAND_LOGO_URL: logoUrl should be null
  {
    const { baseUrl, cleanup } = await createTestServer();
    try {
      const res = await fetch(`${baseUrl}/api/brand/logo`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.logoUrl, null);
    } finally { await cleanup(); }
  }
  // With BRAND_LOGO_URL: logoUrl should match
  {
    const logoUrl = "https://example.com/logo.png";
    const { baseUrl, cleanup } = await createTestServer({ BRAND_LOGO_URL: logoUrl });
    try {
      const res = await fetch(`${baseUrl}/api/brand/logo`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.logoUrl, logoUrl);
      // CORS headers present
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
    } finally { await cleanup(); }
  }
  console.log("  testBrandLogoEndpoint passed");
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

async function testExportCsvEndpoint() {
  const { baseUrl, cleanup } = await createTestServer();
  try {
    const identity = generateIdentity();
    const deviceId = newId("d");
    const today = localDay();
    await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participantId: identity.participantId, deviceId,
        nickname: "csv-api-user", identityPublicKey: identity.identityPublicKey,
        os: "test", appVersion: APP_VERSION
      })
    });
    const payload = {
      participantId: identity.participantId, deviceId,
      clientGeneratedAt: "2026-05-07T00:00:00.000Z",
      items: [{
        day: today, toolCode: "codex", providerId: "codex_local",
        workdirHash: "wd_csv_api", workdirDisplayName: "csv-api-project",
        model: "gpt-5", inputTokens: 200, outputTokens: 80,
        cacheReadTokens: 20, cacheWriteTokens: 10, reasoningTokens: 15,
        totalTokens: 310, sourceQuality: "exact", sourceFingerprint: "sf_csv_api"
      }]
    };
    const signature = signPayload(identity.identityPrivateKey, payload);
    const uploadRes = await fetch(`${baseUrl}/api/usage/daily-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, signature })
    });
    assert.equal(uploadRes.status, 200, `upload failed: ${await uploadRes.text()}`);

    const res = await fetch(`${baseUrl}/api/admin/export/csv?range=today`);
    assert.equal(res.status, 200);
    const contentType = res.headers.get("content-type");
    assert.ok(contentType.includes("text/csv"), `expected text/csv, got ${contentType}`);
    const disposition = res.headers.get("content-disposition");
    assert.ok(disposition.includes("attachment"), `expected attachment disposition, got ${disposition}`);
    const text = await res.text();
    assert.ok(text.includes("Date,User,Workdir"), "CSV must have header row");
    assert.ok(text.includes("csv-api-user"), "CSV must contain the user nickname");
    assert.ok(text.includes("csv-api-project"), "CSV must contain workdir name");
    assert.ok(text.includes("gpt-5"), "CSV must contain model name");
    assert.ok(text.includes("csv-api-user"), `CSV must contain the user nickname, got: ${text.slice(0, 500)}`);
    assert.ok(text.includes("csv-api-project"), `CSV must contain workdir name, got: ${text.slice(0, 500)}`);
    assert.ok(text.includes("310"), `CSV must contain total tokens, got: ${text.slice(0, 500)}`);

    // Test with participant filter
    const filteredRes = await fetch(`${baseUrl}/api/admin/export/csv?range=today&participantId=${identity.participantId}`);
    assert.equal(filteredRes.status, 200);
    const filteredText = await filteredRes.text();
    const filteredLines = filteredText.trim().split("\n");
    assert.equal(filteredLines.length, 2, "filtered CSV should have header + 1 data row");

    // Test empty result
    const emptyRes = await fetch(`${baseUrl}/api/admin/export/csv?range=today&participantId=nonexistent`);
    assert.equal(emptyRes.status, 200);
    const emptyText = await emptyRes.text();
    const emptyLines = emptyText.trim().split("\n");
    assert.equal(emptyLines.length, 1, "empty CSV should have only header");

    // Test range exceeds 90 days
    const tooLargeRes = await fetch(`${baseUrl}/api/admin/export/csv?range=custom&start=2025-01-01&end=2026-05-27`);
    assert.equal(tooLargeRes.status, 400, "range >90 days should be rejected");
    const tooLargeBody = await tooLargeRes.json();
    assert.ok(tooLargeBody.error, "should return error message");

    // Test range within 90 days is accepted
    const okRes = await fetch(`${baseUrl}/api/admin/export/csv?range=custom&start=2026-03-01&end=2026-05-27`);
    assert.equal(okRes.status, 200, "range ≤90 days should be accepted");
  } finally {
    await cleanup();
  }
  console.log("  testExportCsvEndpoint passed");
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
await testMysqlReadBackNormalizesModelCasing();
await testMysqlBatchSetIsolatesPoisonedBucket();
await testMysqlUsageWritesAreSerialized();
await testMysqlUsageWritesUseDistributedLock();
await testMysqlWriteLockTimeoutFailsClosed();
await testMysqlConnectionLimitFloorsWhenLockEnabled();
await testMysqlWriteLockResetsUsageWorkingState();
await testMysqlWriteLockResetsUsageWorkingStateOnError();
await testMysqlLegacyUploadDoesNotFullTableWipe();
await testMysqlHourlyIncrementalSyncScopesDeletes();
await testMysqlLoadSkipsUsageMirrors();
await testMysqlReadPathUsesRequestScopedRows();
await testMysqlDeleteDeviceDataClearsCloudSyncScopesFromSql();
await testMysqlModelPriceRecalculationIsModelScoped();
await testMysqlFullPriceRecalculationUsesBatches();
await testMysqlFullReconcileDailyFallbackDoesNotRequireHourlyDerivedColumn();
testMysqlCustomRangePrecedenceMatchesJsonStore();

// Cloud provider dedup tests
testCursorSameAccountDedupAcrossDevices();
testDeleteCloudDeviceForcesEarlierDeviceReupload();
testCursorDifferentAccountsNoDedup();
testLocalProviderNoDedup();
testCursorDedupSyncBucketPreserved();
testCursorDedupDailyDerivedCorrectly();

// Sync-state tests
testSyncStateReturnsMissingAndMatched();
testSyncStateFallsBackToHourlyRowsWhenMetadataMissing();
testSyncStateUsesFactsWhenMetadataIsStale();
testSyncStateAfterResetDetectsMissing();
testDeleteParticipantDataClearsHourlySyncState();
testReconcileDailyScopeInventoryIsDeviceScopedAndPaged();
testReconcileDailyScopesPrunesServerOnlyAndRebuildsCurrentDeviceDaily();

// Full reconcile tests
testFullReconcileModeNoCutoff();
testFullReconcileDailyGranularity();
testFullReconcileDailyFallbackMatchesHourlyDerivedUsageDaily();
testFullReconcileDailyFallbackIgnoresHour();
testFullReconcileUnknownLegacy();
testFullReconcileBucketLimit();

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
testFormatContributionPercent();
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
testDesktopCspAllowsBrandLogoDataImages();

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
testSourceLeaderboardStoreAggregation();
testExportDailyCsv();
testExportDailyCsvWithCost();
testExportDailyCsvFiltersByParticipant();
testExportDailyCsvEmpty();

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
await testExportCsvEndpoint();
await testBrandLogoEndpoint();

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

// Participant profile
testParticipantProfile();
testParticipantHourlyRhythm();

console.log("All tests passed");
