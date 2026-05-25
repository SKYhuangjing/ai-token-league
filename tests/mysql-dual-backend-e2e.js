// Dual-backend end-to-end concurrency test against a REAL MySQL.
//
// Goal: prove that two independent backend instances pointing at the same MySQL
// (sharing MYSQL_WRITE_LOCK_NAME) cannot lose existing rows when they
// concurrently hammer the legacy and snapshot upload paths for the same
// (participantId, deviceId).
//
// Run:
//   set -a && . ./env.local && set +a && node tests/mysql-dual-backend-e2e.js
//
// Safe to run repeatedly. Scoped to a unique participantId of the form
// `p_e2etest_<pid>_<rand>`; never touches pre-existing dev data.

import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { generateIdentity, signPayload } from "../src/shared/crypto.js";
import { computeBucketFingerprint, computeDailyBucketFingerprint } from "../src/shared/schema.js";
import { APP_VERSION } from "../src/shared/version.js";

function log(stage, ...rest) { console.log(`[dual] ${stage}`, ...rest); }

const lockName = `ai-token-league:e2etest:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
const participantSeed = `e2etest_${process.pid}_${Math.random().toString(36).slice(2, 6)}`;

async function bootInstance(label) {
  const nonce = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  process.env.DB_TYPE = "mysql";
  process.env.MYSQL_WRITE_LOCK_NAME = lockName;
  process.env.MYSQL_WRITE_LOCK_TIMEOUT_SECONDS = "10";
  process.env.OPENROUTER_PRICING_AUTO_REFRESH = "false";
  process.env.ADMIN_USERNAME = "";
  process.env.ADMIN_PASSWORD = "";
  const mod = await import(`../src/backend/server.js?dual=${nonce}`);
  const server = mod.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  log(`boot ${label} on ${baseUrl}`);
  return {
    server,
    baseUrl,
    store: mod.store,
    close: async () => {
      // Closing both the HTTP server AND the MySqlStore (which owns the
      // mysql2 pool with persistent socket handles) is required for the
      // Node process to exit cleanly. Without store.close() the test
      // would hang on background pool keep-alive timers.
      await new Promise((r) => server.close(() => r()));
      await mod.store?.close?.();
    }
  };
}

function makeItem(overrides) {
  return {
    day: "2026-05-14",
    toolCode: "codex",
    providerId: "codex_local",
    workdirHash: "wd_dual_e2e",
    workdirDisplayName: "Dual E2E",
    model: "gpt-5",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 150,
    sourceQuality: "exact",
    sourceFingerprint: "sf_dual",
    ...overrides
  };
}

function makeHourlyPayload(participantId, deviceId, { day, hour, providerId }) {
  const items = [makeItem({ day, providerId, hour, sourceFingerprint: `sf_${day}_${hour}_${providerId}` })];
  return {
    participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    snapshot: {
      mode: "device_day_hour_provider",
      day, hour, providerId,
      bucketFingerprint: computeBucketFingerprint(items),
      rowCount: items.length,
      totalTokens: 150
    },
    items
  };
}

function makeDailyPayload(participantId, deviceId, { day, providerId }) {
  const items = [makeItem({ day, providerId, sourceFingerprint: `sf_${day}_${providerId}_daily` })];
  return {
    participantId, deviceId,
    clientGeneratedAt: new Date().toISOString(),
    snapshot: {
      mode: "device_day_provider",
      day, providerId,
      bucketFingerprint: computeDailyBucketFingerprint(items),
      rowCount: items.length,
      totalTokens: 150
    },
    items
  };
}

// Legacy upload (no `snapshot`) — exercises MySqlStore's
// loadUsageMirrorForMaintenance + syncLegacyUsageMirror path. This is the
// path whose pre-fix all-table DELETE caused production data loss when
// concurrent requests' working mirrors collided. The legacy upload uses a
// DIFFERENT providerId (`claude_code_local`) than the snapshot uploads
// (`codex_local`) so the snapshot path's bucket-scoped DELETE never
// shadow-deletes the legacy rows; that lets us assert the legacy "only
// grows" invariant cleanly under concurrent cross-process traffic.
function makeLegacyPayload(participantId, deviceId, { day, providerId }) {
  const items = [
    makeItem({
      day,
      providerId,
      toolCode: "claude",
      sourceFingerprint: `sf_${day}_${providerId}_legacy_${deviceId}`,
      model: "claude-sonnet-4-5",
      inputTokens: 80,
      outputTokens: 40,
      totalTokens: 120
    })
  ];
  return {
    participantId,
    deviceId,
    clientGeneratedAt: new Date().toISOString(),
    items
  };
}

async function registerDevice(baseUrl, identity, deviceId) {
  const res = await fetch(`${baseUrl}/api/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      participantId: identity.participantId,
      deviceId,
      nickname: `dual-e2e-${deviceId}`,
      identityPublicKey: identity.identityPublicKey,
      os: "test",
      appVersion: APP_VERSION
    })
  });
  assert.equal(res.status, 200, `register ${deviceId} via ${baseUrl}`);
}

async function postSigned(baseUrl, url, identity, payload) {
  const signature = signPayload(identity.identityPrivateKey, payload);
  const res = await fetch(`${baseUrl}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, signature })
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

(async () => {
  const mysqlOpts = {
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    connectionLimit: 4
  };
  if (!mysqlOpts.host || !mysqlOpts.user) {
    console.error("[dual] missing MYSQL_* env. Run: set -a && . ./env.local && set +a && node ...");
    process.exit(2);
  }
  log("lock:", lockName);
  log("mysql:", `${mysqlOpts.user}@${mysqlOpts.host}:${mysqlOpts.port}/${mysqlOpts.database}`);

  const adminPool = mysql.createPool(mysqlOpts);
  const identity = generateIdentity();
  identity.participantId = `p_${participantSeed}`;
  const deviceA = `d_${participantSeed}_A`;
  const deviceB = `d_${participantSeed}_B`;

  const tablesToClean = [
    { name: "usage_daily", col: "participantId" },
    { name: "usage_hourly", col: "participantId" },
    { name: "usage_sync_buckets", col: "participantId" },
    { name: "usage_sync_buckets_hourly", col: "participantId" },
    { name: "devices", col: "participantId" },
    { name: "participants", col: "id" }
  ];
  async function cleanupOnce() {
    for (const t of tablesToClean) {
      try { await adminPool.query(`DELETE FROM ${t.name} WHERE ${t.col} = ?`, [identity.participantId]); }
      catch { /* ignore */ }
    }
  }
  await cleanupOnce();

  let backendA, backendB;
  try {
    backendA = await bootInstance("A");
    backendB = await bootInstance("B");

    await registerDevice(backendA.baseUrl, identity, deviceA);
    await registerDevice(backendB.baseUrl, identity, deviceB);
    log("registered participant + 2 devices");

    const days = ["2026-05-10", "2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14"];
    const hours = [9, 10, 11, 12];
    const providerId = "codex_local";
    const legacyProviderId = "claude_code_local";

    const expectedHourly = new Set();
    const expectedDaily = new Set();
    const expectedLegacyDaily = new Set();
    for (const device of [deviceA, deviceB]) {
      for (const day of days) {
        expectedDaily.add(`${device}|${day}|${providerId}`);
        expectedLegacyDaily.add(`${device}|${day}|${legacyProviderId}`);
        for (const hour of hours) {
          expectedHourly.add(`${device}|${day}|${hour}|${providerId}`);
        }
      }
    }

    // Fire every bucket to BOTH backends simultaneously. With the pre-fix race
    // the two backends' `this.db.usage*` working mirrors would clobber each
    // other; with the fix the named lock serializes them and each row ends up
    // persisted exactly once. We mix three upload variants:
    //   - hourly snapshot      -> incrementalHourlyBucketSync
    //   - daily snapshot       -> incrementalBucketSync (daily)
    //   - legacy (no snapshot) -> loadUsageMirrorForMaintenance + syncLegacyUsageMirror
    // Legacy uses a different providerId so the snapshot daily DELETE
    // (scoped to the snapshot's providerId) cannot scope-delete legacy rows.
    const tasks = [];
    for (const device of [deviceA, deviceB]) {
      for (const day of days) {
        for (const hour of hours) {
          const payload = makeHourlyPayload(identity.participantId, device, { day, hour, providerId });
          tasks.push(postSigned(backendA.baseUrl, "/api/usage/daily-batch", identity, payload));
          tasks.push(postSigned(backendB.baseUrl, "/api/usage/daily-batch", identity, payload));
        }
        const dailyPayload = makeDailyPayload(identity.participantId, device, { day, providerId });
        tasks.push(postSigned(backendA.baseUrl, "/api/usage/daily-batch", identity, dailyPayload));
        tasks.push(postSigned(backendB.baseUrl, "/api/usage/daily-batch", identity, dailyPayload));
        const legacyPayload = makeLegacyPayload(identity.participantId, device, { day, providerId: legacyProviderId });
        tasks.push(postSigned(backendA.baseUrl, "/api/usage/daily-batch", identity, legacyPayload));
        tasks.push(postSigned(backendB.baseUrl, "/api/usage/daily-batch", identity, legacyPayload));
      }
    }
    log(`firing ${tasks.length} concurrent uploads across both backends`);
    const t0 = Date.now();
    const results = await Promise.all(tasks);
    log(`uploads finished in ${Date.now() - t0}ms`);

    let okCount = 0, dupCount = 0, badCount = 0;
    for (const r of results) {
      if (r.status !== 200) {
        badCount++;
        console.error("[dual] non-200 upload:", r.status, r.body);
        continue;
      }
      okCount++;
      if (r.body?.duplicate || r.body?.noOp) dupCount++;
    }
    log(`outcome: ok=${okCount} dup=${dupCount} bad=${badCount}`);
    assert.equal(badCount, 0, "no upload may return non-200");

    // Verify MySQL state: usage_daily / usage_hourly must contain EXACTLY the
    // expected unique bucket keys for our participant. No row may have been
    // deleted by an interleaving writer. We use DATE_FORMAT to avoid mysql2
    // returning DATE values as JS Date objects, which would otherwise shift
    // them by the session timezone on read.
    //
    // usage_daily holds rows from BOTH the snapshot daily path (codex_local)
    // AND the legacy path (claude_code_local). The expected set is the union;
    // missing legacy keys would prove the legacy fix regressed.
    const expectedAllDaily = new Set([...expectedDaily, ...expectedLegacyDaily]);
    const [dailyRows] = await adminPool.query(
      "SELECT deviceId, DATE_FORMAT(day, '%Y-%m-%d') AS day, providerId FROM usage_daily WHERE participantId = ?",
      [identity.participantId]
    );
    const dailyActual = new Set(dailyRows.map((r) => `${r.deviceId}|${r.day}|${r.providerId}`));
    log(`usage_daily: actual=${dailyRows.length} expected=${expectedAllDaily.size} (snapshot=${expectedDaily.size} legacy=${expectedLegacyDaily.size})`);
    const missingDaily = [...expectedAllDaily].filter((k) => !dailyActual.has(k));
    const extraDaily = [...dailyActual].filter((k) => !expectedAllDaily.has(k));
    if (missingDaily.length) console.error("[dual] missing daily keys:", missingDaily);
    if (extraDaily.length) console.error("[dual] extra daily keys:", extraDaily);
    assert.equal(missingDaily.length, 0, `DATA LOSS: ${missingDaily.length} daily rows missing`);
    assert.equal(extraDaily.length, 0, `unexpected daily rows`);

    // Explicit legacy-only assertion: every (device, day, claude_code_local)
    // legacy row produced by the dual-backend race must survive. This is the
    // direct regression for the original full-table-DELETE bug, which
    // manifested only on the legacy upsert path under cross-process load.
    const legacyActual = new Set(
      [...dailyActual].filter((k) => k.endsWith(`|${legacyProviderId}`))
    );
    const missingLegacy = [...expectedLegacyDaily].filter((k) => !legacyActual.has(k));
    if (missingLegacy.length) console.error("[dual] missing legacy keys:", missingLegacy);
    assert.equal(missingLegacy.length, 0, `LEGACY DATA LOSS: ${missingLegacy.length} legacy daily rows missing`);
    log(`legacy usage_daily: actual=${legacyActual.size} expected=${expectedLegacyDaily.size}`);

    const [hourlyRows] = await adminPool.query(
      "SELECT deviceId, DATE_FORMAT(day, '%Y-%m-%d') AS day, hour, providerId FROM usage_hourly WHERE participantId = ?",
      [identity.participantId]
    );
    const hourlyActual = new Set(hourlyRows.map((r) => `${r.deviceId}|${r.day}|${r.hour}|${r.providerId}`));
    log(`usage_hourly: actual=${hourlyRows.length} expected=${expectedHourly.size}`);
    const missingHourly = [...expectedHourly].filter((k) => !hourlyActual.has(k));
    const extraHourly = [...hourlyActual].filter((k) => !expectedHourly.has(k));
    if (missingHourly.length) console.error("[dual] missing hourly keys:", missingHourly);
    if (extraHourly.length) console.error("[dual] extra hourly keys:", extraHourly);
    assert.equal(missingHourly.length, 0, `DATA LOSS: ${missingHourly.length} hourly rows missing`);
    assert.equal(extraHourly.length, 0, `unexpected hourly rows`);

    // Idempotent replay: a single bucket re-uploaded through both backends
    // must return duplicate / noOp without changing row counts.
    const replayPayload = makeHourlyPayload(identity.participantId, deviceA, {
      day: days[0], hour: hours[0], providerId
    });
    const dupA = await postSigned(backendA.baseUrl, "/api/usage/daily-batch", identity, replayPayload);
    const dupB = await postSigned(backendB.baseUrl, "/api/usage/daily-batch", identity, replayPayload);
    assert.equal(dupA.status, 200);
    assert.equal(dupB.status, 200);
    assert.ok(
      dupA.body?.duplicate || dupA.body?.noOp,
      `replay on A should be no-op, got ${JSON.stringify(dupA.body)}`
    );
    assert.ok(
      dupB.body?.duplicate || dupB.body?.noOp,
      `replay on B should be no-op, got ${JSON.stringify(dupB.body)}`
    );
    log("idempotent replay: both backends returned duplicate/noOp");

    const [[afterDaily]] = await adminPool.query(
      "SELECT COUNT(*) AS c FROM usage_daily WHERE participantId = ?", [identity.participantId]
    );
    const [[afterHourly]] = await adminPool.query(
      "SELECT COUNT(*) AS c FROM usage_hourly WHERE participantId = ?", [identity.participantId]
    );
    assert.equal(Number(afterDaily.c), expectedAllDaily.size, "daily count drift after replay");
    assert.equal(Number(afterHourly.c), expectedHourly.size, "hourly count drift after replay");
    log(`post-replay counts unchanged: daily=${afterDaily.c} hourly=${afterHourly.c}`);

    log("ALL DUAL-BACKEND CONCURRENT UPLOAD CHECKS PASSED");
  } catch (e) {
    console.error("[dual] FAILED:", e);
    process.exitCode = 1;
  } finally {
    await cleanupOnce();
    await adminPool.end();
    if (backendA) await backendA.close();
    if (backendB) await backendB.close();
  }
})();
