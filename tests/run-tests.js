import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Store } from "../src/backend/store.js";
import { generateIdentity, newId, signPayload } from "../src/shared/crypto.js";
import { assertNoForbiddenUploadFields, displayTotalTokens, USAGE_CACHE_VERSION } from "../src/shared/schema.js";
import { compatibilityResult, clientMetadata, CLIENT_PROTOCOL_VERSION, APP_VERSION } from "../src/shared/version.js";
import { releasePublicConfig, updatePreflightState, validateInstallerMetadata, validateReleaseConfig, verifyFileChecksum } from "../src/shared/update.js";
import { scanUsage } from "../src/collector/core.js";
import { addCursorToken, exportConfig, exportIdentity, importIdentity, initConfig, normalizeSilentUpdateMode, updateConfig } from "../src/collector/config.js";
import { claudeCodeLocalProvider } from "../src/collector/providers/claude-code-local.js";
import { codexLocalProvider } from "../src/collector/providers/codex-local.js";
import { cursorDashboardUsageProvider, eventsToUsageEvents } from "../src/collector/providers/cursor-dashboard-usage.js";
import { formatTokenCompact, formatUsd } from "../src/shared/display.js";
import { createPriceMap, estimateUsageCost, openRouterModelToPrice } from "../src/shared/pricing.js";
import { addDays, localDay } from "../src/shared/date.js";

const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js/dist/sql-asm.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-token-league-test-"));

async function testScan() {
  const identity = generateIdentity();
  const config = {
    participantId: identity.participantId,
    workdirAliases: {},
    providerRootsOnly: true,
    providerRoots: {
      codex_local: path.resolve("samples/codex"),
      claude_code_local: path.resolve("samples/claude/projects")
    }
  };
  const result = await scanUsage(config);
  assert.equal(result.items.length, 2);
  const codex = result.items.find((item) => item.toolCode === "codex");
  const claude = result.items.find((item) => item.toolCode === "claude_code");
  assert.ok(codex.totalTokens > 0);
  assert.ok(claude.totalTokens > 0);
  assert.equal(codex.workdirDisplayName, "codex-project");
  assert.equal(claude.workdirDisplayName, "claude-project");
  assert.equal(claude.inputTokens, 1540);
  assert.equal(claude.cacheReadTokens, 260);
  assert.equal(claude.cacheWriteTokens, 200);
  assert.equal(claude.totalTokens, claude.inputTokens + claude.outputTokens + claude.cacheReadTokens + claude.cacheWriteTokens);
  assert.ok(codex.sourceFingerprint);
  assert.ok(codex.rawSourceRef);
  assert.ok(codex.providerVersion);
  assert.ok(codex.parserVersion);
  const cachedResult = await scanUsage({ ...config, __usageCacheIndex: result.sourceIndex });
  assert.equal(cachedResult.items.length, 2);
  assert.ok(cachedResult.health.some((item) => item.reusedFiles > 0));
  return { identity, items: result.items };
}

async function testProviderEnabledSwitches() {
  const identity = generateIdentity();
  const config = {
    participantId: identity.participantId,
    workdirAliases: {},
    providerRootsOnly: true,
    providerEnabled: {
      codex_local: false,
      claude_code_local: true
    },
    providerRoots: {
      codex_local: path.resolve("samples/codex"),
      claude_code_local: path.resolve("samples/claude/projects")
    }
  };
  const result = await scanUsage(config);
  assert.equal(result.items.some((item) => item.providerId === "codex_local"), false);
  assert.equal(result.items.some((item) => item.providerId === "claude_code_local"), true);
  assert.equal(codexLocalProvider.reportHealth(config).enabled, false);
  assert.equal(claudeCodeLocalProvider.reportHealth(config).enabled, true);
  assert.equal(cursorDashboardUsageProvider.reportHealth({ providerEnabled: { cursor_dashboard_usage: true } }).enabled, true);
  const updated = updateConfig({ providerEnabled: { codex_local: true } }, config, { persist: false });
  assert.equal(updated.providerEnabled.codex_local, true);
  assert.equal(updated.providerEnabled.claude_code_local, true);
}

function testCursorDashboardMapping() {
  const items = eventsToUsageEvents([
    {
      timestamp: "1776866406216",
      model: "composer-2-fast",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 300,
        cacheWriteTokens: 40
      }
    }
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].toolCode, "cursor");
  assert.equal(items[0].workdirCandidate, "virtual:cursor-dashboard:Cursor");
  assert.equal(items[0].model, "composer-2-fast");
  assert.equal(items[0].totalTokens, 460);
  assert.ok(items[0].sourceFingerprint);
  const defaultModelItems = eventsToUsageEvents([
    {
      timestamp: "1776866406216",
      model: "default",
      tokenUsage: { inputTokens: 10, outputTokens: 20 }
    },
    {
      timestamp: "1776866406217",
      tokenUsage: { inputTokens: 5, outputTokens: 5 }
    }
  ]);
  assert.deepEqual(defaultModelItems.map((item) => item.model), ["Auto", "Auto"]);
  const premiumModelItems = eventsToUsageEvents([
    {
      timestamp: "1776866406218",
      model: "Premium (Codex 5.3)",
      tokenUsage: { inputTokens: 3, outputTokens: 4 }
    }
  ]);
  assert.equal(premiumModelItems[0].model, "Premium (Codex 5.3)");
  assert.equal(localDay("2026-04-29T18:30:00.000Z", "Asia/Shanghai"), "2026-04-30");
  const namedItems = eventsToUsageEvents([
    {
      timestamp: "1776866406216",
      model: "gpt-5",
      tokenUsage: { inputTokens: 1, outputTokens: 2 }
    }
  ], { accountName: "cursor@example.com" });
  assert.equal(namedItems[0].workdirCandidate, "virtual:cursor-dashboard:Cursor · cursor@example.com");
  const duplicateSources = cursorDashboardUsageProvider.scanSessions({
    cursorDashboardUsage: {
      enabled: true,
      autoDetectLocal: false,
      workosSessionTokens: [
        { token: "user_01TESTCURSOR::manual", accountName: "user_01TESTCURSOR" },
        { token: "user_01TESTCURSOR::manual", accountName: "cursor@example.com" }
      ]
    }
  });
  assert.equal(duplicateSources.length, 1);
  assert.equal(duplicateSources[0].accountName, "cursor@example.com");
  const duplicateAccounts = cursorDashboardUsageProvider.scanSessions({
    cursorDashboardUsage: {
      enabled: true,
      autoDetectLocal: false,
      workosSessionTokens: [
        { token: "user_01TESTCURSOR::state-token", accountName: "cursor@example.com" },
        { token: "user_01TESTCURSOR::account-token", accountName: "cursor@example.com" }
      ]
    }
  });
  assert.equal(duplicateAccounts.length, 1);
}

async function testCursorLocalTokenDetection() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const token = jwtWithSub("auth0|user_01TESTCURSOR");
  db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO ItemTable VALUES (?, ?)", ["cursorAuth/accessToken", token]);
  const dbPath = path.join(tmp, "cursor-state.vscdb");
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
  process.env.CURSOR_STATE_DB_PATH = dbPath;
  try {
    const sources = cursorDashboardUsageProvider.scanSessions({ cursorDashboardUsage: { enabled: true } });
    const localSource = sources.find((source) => source.sourceKind === "local_cursor_state");
    assert.ok(localSource);
    assert.ok(decodeURIComponent(localSource.cookie).includes("user_01TESTCURSOR::"));
    const health = cursorDashboardUsageProvider.reportHealth({ cursorDashboardUsage: { enabled: false } });
    assert.equal(health.detected, true);
    assert.equal(health.enabled, false);
    assert.ok(health.roots.includes("user_01TESTCURSOR"));
    assert.ok(health.roots.every((root) => !root.startsWith("local_cursor_")));
  } finally {
    delete process.env.CURSOR_STATE_DB_PATH;
  }
}

async function testCodexLocalSkipsUnknownModel() {
  const file = path.join(tmp, "codex-missing-model.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({
    timestamp: "2026-04-29T08:00:00.000Z",
    session_id: "codex-missing-model",
    cwd: "/Users/sky/demo/codex-project",
    token_count: { input_tokens: 1200, output_tokens: 300, reasoning_tokens: 150, total_tokens: 1650 }
  })}\n`);
  const items = await codexLocalProvider.parseUsage(file);
  assert.equal(items.length, 0);
}

async function testCodexLocalNormalizesInputTokens() {
  const file = path.join(tmp, "codex-cache-normalized.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({
    timestamp: "2026-04-29T08:00:00.000Z",
    session_id: "codex-cache-normalized",
    cwd: "/Users/sky/demo/codex-project",
    model: "gpt-5",
    token_count: {
      input_tokens: 1200,
      output_tokens: 300,
      cached_input_tokens: 200,
      cache_creation_input_tokens: 50,
      reasoning_tokens: 150,
      total_tokens: 1500
    }
  })}\n`);
  const items = await codexLocalProvider.parseUsage(file);
  assert.equal(items.length, 1);
  assert.equal(items[0].inputTokens, 950);
  assert.equal(items[0].cacheReadTokens, 200);
  assert.equal(items[0].cacheWriteTokens, 50);
  assert.equal(items[0].totalTokens, 1500);
}

function jwtWithSub(sub) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.signature`;
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
  assert.ok(detail.compositionSummary);
  assert.equal(detail.rows[0].compositionSummary.length > 0, true);
  const trend = store.participantTrend(identity.participantId, { grain: "week", range: "last30" });
  assert.equal(trend.participantId, identity.participantId);
  assert.ok(trend.items.length >= 1);
  assert.equal(trend.items[0].nickname, "tester");
  assert.ok(trend.items[0].periodStart);
  assert.ok(trend.items[0].models.length >= 1);
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
    uploadBatches: 1
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

function testForbiddenUploadFields() {
  assert.throws(() => assertNoForbiddenUploadFields({ prompt: "secret" }), /forbidden upload field/);
  assert.throws(() => assertNoForbiddenUploadFields({ nested: { identityPrivateKey: "secret" } }), /forbidden upload field/);
  assert.equal(USAGE_CACHE_VERSION, 3);
}

async function testVersionCompatibilityAndManifest() {
  assert.equal(clientMetadata().clientProtocolVersion, CLIENT_PROTOCOL_VERSION);
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
  }, { publicBaseUrl: "https://cdn.example" }), /installer win32-x64 missing/);
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
}

function testIdentityImport() {
  const identity = generateIdentity();
  const config = {
    participantId: identity.participantId,
    nickname: "origin",
    identityPublicKey: identity.identityPublicKey,
    identityPrivateKey: identity.identityPrivateKey,
    deviceId: newId("d")
  };
  const exported = exportIdentity(config);
  const imported = importIdentity(exported, { deviceId: newId("d"), apiBaseUrl: "http://127.0.0.1:8787" }, { persist: false });
  assert.equal(imported.participantId, config.participantId);
  assert.notEqual(imported.deviceId, "");
}

function testUpdateConfigKeepsIdentity() {
  const identity = generateIdentity();
  const current = {
    participantId: identity.participantId,
    nickname: "origin",
    identityPublicKey: identity.identityPublicKey,
    identityPrivateKey: identity.identityPrivateKey,
    deviceId: newId("d"),
    apiBaseUrl: "http://127.0.0.1:8787",
    apiConnection: { status: "reachable", apiBaseUrl: "http://127.0.0.1:8787" },
    syncStatus: { status: "success", apiBaseUrl: "http://127.0.0.1:8787" },
    lastSyncAt: "2026-04-30T01:00:00.000Z",
    autoRefreshEnabled: true,
    refreshIntervalMinutes: 15
  };
  const updated = updateConfig({
    nickname: "renamed",
    apiBaseUrl: "",
    apiConnection: { status: "not_configured", apiBaseUrl: "" },
    syncStatus: {},
    lastSyncAt: "",
    autoRefreshEnabled: false,
    refreshIntervalMinutes: 3
  }, current, { persist: false });
  assert.equal(updated.participantId, current.participantId);
  assert.equal(updated.deviceId, current.deviceId);
  assert.equal(updated.nickname, "renamed");
  assert.equal(updated.apiBaseUrl, "");
  assert.equal(updated.apiConnection.status, "not_configured");
  assert.deepEqual(updated.syncStatus, {});
  assert.equal(updated.lastSyncAt, "");
  assert.equal(updated.showEstimatedCost, false);
  assert.equal(updated.autoRefreshEnabled, false);
  assert.equal(updated.refreshIntervalMinutes, 3);
  assert.equal(updated.silentUpdateMode, "notify");
  const silentUpdated = updateConfig({ silentUpdateMode: "auto_apply_on_idle" }, updated, { persist: false });
  assert.equal(silentUpdated.silentUpdateMode, "auto_apply_on_idle");
  const invalidSilentUpdate = updateConfig({ silentUpdateMode: "bad" }, silentUpdated, { persist: false });
  assert.equal(invalidSilentUpdate.silentUpdateMode, "notify");
  assert.equal(normalizeSilentUpdateMode("auto_download"), "auto_download");
  assert.equal(normalizeSilentUpdateMode("bad"), "notify");
  const exported = exportConfig(silentUpdated);
  assert.equal(exported.silentUpdateMode, "auto_apply_on_idle");
}

function testInitConfigKeepsPresetFields() {
  const config = initConfig({
    nickname: "preset-user",
    apiBaseUrl: "https://api.example",
    language: "en",
    showEstimatedCost: true,
    providerEnabled: {
      codex_local: false,
      claude_code_local: true,
      cursor_dashboard_usage: true
    }
  }, { persist: false });
  assert.equal(config.nickname, "preset-user");
  assert.equal(config.apiBaseUrl, "https://api.example");
  assert.equal(config.language, "en");
  assert.equal(config.showEstimatedCost, true);
  assert.equal(config.cursorDashboardUsage.enabled, true);
  assert.deepEqual(config.providerEnabled, {
    claude_code_local: true,
    codex_local: false,
    cursor_dashboard_usage: true
  });
}

function testAddCursorTokenKeepsMultipleAccounts() {
  const identity = generateIdentity();
  const current = {
    participantId: identity.participantId,
    nickname: "origin",
    identityPublicKey: identity.identityPublicKey,
    identityPrivateKey: identity.identityPrivateKey,
    deviceId: newId("d"),
    cursorDashboardUsage: { enabled: false, workosSessionToken: "", workosSessionTokens: [] }
  };
  const first = addCursorToken(JSON.stringify({
    email: "a@example.com",
    access_token: jwtWithSub("auth0|user_01A")
  }), current, { persist: false });
  const second = addCursorToken(JSON.stringify({
    email: "b@example.com",
    access_token: jwtWithSub("auth0|user_01B")
  }), first, { persist: false });
  assert.equal(second.cursorDashboardUsage.enabled, true);
  assert.equal(second.cursorDashboardUsage.workosSessionTokens.length, 2);
  assert.deepEqual(second.cursorDashboardUsage.workosSessionTokens.map((item) => item.accountName), ["a@example.com", "b@example.com"]);
  assert.throws(() => addCursorToken("not-a-token", current, { persist: false }), /Cursor token is empty or invalid/);
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

const { identity, items } = await testScan();
await testProviderEnabledSwitches();
testBackendUpload(identity, items);
testDeleteParticipantDataAllowsResync();
testAdminUsageRowRangeFeedsParticipantDetail();
testSourceFingerprintDedupeKeepsDistinctDays();
testIdentityImport();
testUpdateConfigKeepsIdentity();
testInitConfigKeepsPresetFields();
testAddCursorTokenKeepsMultipleAccounts();
await testCursorLocalTokenDetection();
testCursorDashboardMapping();
await testCodexLocalSkipsUnknownModel();
await testCodexLocalNormalizesInputTokens();
testForbiddenUploadFields();
await testVersionCompatibilityAndManifest();
testDisplayAndPricing();
await testOpenRouterRefresh();
console.log("All tests passed");
