import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/backend/store.js";
import { generateIdentity, newId, signPayload } from "../src/shared/crypto.js";
import { assertNoForbiddenUploadFields, USAGE_CACHE_VERSION } from "../src/shared/schema.js";
import { scanUsage } from "../src/collector/core.js";
import { exportIdentity, importIdentity, updateConfig } from "../src/collector/config.js";
import { eventsToUsageEvents } from "../src/collector/providers/cursor-dashboard-usage.js";
import { formatTokenCompact, formatUsd } from "../src/shared/display.js";
import { createPriceMap, estimateUsageCost } from "../src/shared/pricing.js";
import { localDay } from "../src/shared/date.js";

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
  assert.ok(codex.sourceFingerprint);
  assert.ok(codex.rawSourceRef);
  assert.ok(codex.providerVersion);
  assert.ok(codex.parserVersion);
  const cachedResult = await scanUsage({ ...config, __usageCacheIndex: result.sourceIndex });
  assert.equal(cachedResult.items.length, 2);
  assert.ok(cachedResult.health.some((item) => item.reusedFiles > 0));
  return { identity, items: result.items };
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
  assert.equal(localDay("2026-04-29T18:30:00.000Z", "Asia/Shanghai"), "2026-04-30");
}

function testBackendUpload(identity, items) {
  const store = new Store(path.join(tmp, "db.json"));
  const deviceId = newId("d");
  const testDay = localDay();
  const uploadItems = items.map((item) => ({ ...item, day: testDay }));
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
  store.upsertUsageBatch({
    ...payload,
    clientGeneratedAt: new Date(Date.now() + 1).toISOString(),
    items: [
      {
        ...uploadItems[0],
        model: "codex-default",
        inputTokens: 600,
        outputTokens: 400,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 1000,
        sourceFingerprint: "test-codex-default"
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
  const detail = store.participantDetail(identity.participantId, { period: "today", includeCost: true });
  assert.equal(detail.selectedPeriod, "today");
  assert.equal(detail.rank, 1);
  assert.equal(detail.isSingleDay, true);
  assert.ok(detail.models.length >= 1);
  assert.ok(detail.workdirs.length >= 1);
  assert.ok(detail.providers.length >= 1);
  assert.ok(detail.periodRows.length >= 1);
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
  const quality = store.adminQuality({ range: "month" });
  assert.equal(quality.rows, 3);
  assert.equal(quality.missingSourceFingerprintRows, 0);
  assert.equal(quality.unknownWorkdirRows, 0);
  assert.equal(store.db.uploadBatches[Object.keys(store.db.uploadBatches)[0]].status, "accepted");
  assert.ok(Object.values(store.db.usageDaily).every((item) => item.sourceFingerprint));
  const recalculated = store.recalculateCosts();
  assert.ok(recalculated.updated >= 1);
  const beforePrice = store.missingPriceModels();
  assert.ok(beforePrice.some((item) => item.model === "codex-default"));
  const savedPrice = store.upsertModelPrice({
    model: "codex-default",
    inputCostPerMTok: 1,
    outputCostPerMTok: 2,
    cacheReadCostPerMTok: 0.1,
    cacheWriteCostPerMTok: 1,
    reasoningCostPerMTok: 2
  });
  assert.equal(savedPrice.price.model, "codex-default");
  assert.ok(store.listModelPrices().custom.some((item) => item.model === "codex-default"));
  assert.ok(!store.missingPriceModels().some((item) => item.model === "codex-default"));
  const customCostBoard = store.publicLeaderboard({ period: "this_month", includeCost: true });
  assert.notEqual(customCostBoard[0].estimatedCostUsd, null);
  assert.ok(signature);
}

function testForbiddenUploadFields() {
  assert.throws(() => assertNoForbiddenUploadFields({ prompt: "secret" }), /forbidden upload field/);
  assert.throws(() => assertNoForbiddenUploadFields({ nested: { identityPrivateKey: "secret" } }), /forbidden upload field/);
  assert.equal(USAGE_CACHE_VERSION, 2);
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
    autoRefreshEnabled: true,
    refreshIntervalMinutes: 15
  };
  const updated = updateConfig({
    nickname: "renamed",
    apiBaseUrl: "",
    autoRefreshEnabled: false,
    refreshIntervalMinutes: 3
  }, current, { persist: false });
  assert.equal(updated.participantId, current.participantId);
  assert.equal(updated.deviceId, current.deviceId);
  assert.equal(updated.nickname, "renamed");
  assert.equal(updated.apiBaseUrl, "");
  assert.equal(updated.showEstimatedCost, false);
  assert.equal(updated.autoRefreshEnabled, false);
  assert.equal(updated.refreshIntervalMinutes, 3);
}

function testDisplayAndPricing() {
  assert.equal(formatTokenCompact(120456222), "1.20亿");
  assert.equal(formatTokenCompact(80450000), "8045万");
  assert.equal(formatUsd(null), "-");
  const exact = estimateUsageCost({ model: "gpt-5", inputTokens: 1000, outputTokens: 1000 });
  assert.equal(exact.costQuality, "exact_price");
  assert.ok(exact.estimatedCostUsd > 0);
  const estimated = estimateUsageCost({ model: "gpt-5.5", inputTokens: 1000, outputTokens: 1000 });
  assert.equal(estimated.costQuality, "estimated_price");
  const unknown = estimateUsageCost({ model: "unknown-model", inputTokens: 1000, outputTokens: 1000 });
  assert.equal(unknown.costQuality, "unknown_price");
  assert.equal(unknown.estimatedCostUsd, null);
  const custom = estimateUsageCost({ model: "codex-default", inputTokens: 1000, outputTokens: 1000 }, createPriceMap({
    "codex-default": { model: "codex-default", inputCostPerMTok: 1, outputCostPerMTok: 2 }
  }));
  assert.equal(custom.costQuality, "exact_price");
  assert.equal(custom.estimatedCostUsd, 0.003);
}

const { identity, items } = await testScan();
testBackendUpload(identity, items);
testIdentityImport();
testUpdateConfigKeepsIdentity();
testCursorDashboardMapping();
testForbiddenUploadFields();
testDisplayAndPricing();
console.log("All tests passed");
