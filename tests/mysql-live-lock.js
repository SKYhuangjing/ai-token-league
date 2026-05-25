// Live MySQL integration check for MySqlStore write-lock fixes.
// Verifies on a REAL MySQL (not the mocked unit tests):
//   1. acquire / release of GET_LOCK named lock works
//   2. writeLockTimeoutSeconds=0 fails immediately when the lock is held elsewhere
//   3. concurrent withWriteLock() calls serialize (no overlap)
//   4. connectionLimit=2 + named lock does NOT self-deadlock under concurrency
//   5. resetUsageWorkingState clears the in-memory working mirror after every critical section
//
// Run with the env.local credentials loaded:
//   set -a && . ./env.local && set +a && node tests/mysql-live-lock.js
//
// Uses a unique lock name (`ai-token-league:livetest:<pid>:<rand>`) per run and
// touches NO usage tables — safe against shared dev databases.

import { MySqlStore } from "../src/backend/mysql-store.js";
import assert from "node:assert/strict";

const lockName = `ai-token-league:livetest:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
const baseConfig = {
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  writeLockName: lockName
};

function log(step, ...rest) {
  console.log(`[live] ${step}`, ...rest);
}

async function step1_acquireRelease() {
  log("1/5 acquire+release one named lock");
  const store = new MySqlStore({ ...baseConfig, writeLockTimeoutSeconds: 5 });
  await store.connect();
  assert.equal(store.config.writeLockName, lockName, "lock name normalized verbatim");
  assert.ok(store.config.connectionLimit >= 2, "connectionLimit must be >= 2 when lock enabled");
  let entered = false;
  await store.withWriteLock(async () => { entered = true; });
  assert.ok(entered, "withWriteLock body must run");
  await store.close();
}

async function step2_failFastTimeoutZero() {
  log("2/5 timeout=0 fails fast when lock already held");
  // Holder uses a small ample timeout so it definitely owns the lock.
  const holder = new MySqlStore({ ...baseConfig, writeLockTimeoutSeconds: 5 });
  const challenger = new MySqlStore({ ...baseConfig, writeLockTimeoutSeconds: 0 });
  await Promise.all([holder.connect(), challenger.connect()]);
  assert.equal(challenger.config.writeLockTimeoutSeconds, 0, "explicit 0 must NOT be replaced by default 30");

  let releaseHolder;
  const holderHolds = new Promise((resolve) => { releaseHolder = resolve; });
  const holderTask = holder.withWriteLock(async () => {
    log("    holder acquired lock");
    await holderHolds;
  });

  // Give holder a moment to actually call GET_LOCK on MySQL.
  await new Promise((r) => setTimeout(r, 200));

  const startedAt = Date.now();
  let threw = null;
  try {
    await challenger.withWriteLock(async () => {
      throw new Error("challenger must not enter the critical section");
    });
  } catch (e) {
    threw = e;
  }
  const elapsed = Date.now() - startedAt;
  log(`    challenger result: ${threw?.message || "(no error)"} after ${elapsed}ms`);
  assert.ok(threw, "challenger must fail when timeout=0 and lock is held");
  assert.match(threw.message, /Timed out acquiring MySQL write lock/, "fail-fast error wording");
  // fail-fast means GET_LOCK(?, 0) returns 0 immediately — should be well under 1s.
  assert.ok(elapsed < 2000, `fail-fast must be quick, got ${elapsed}ms`);

  releaseHolder();
  await holderTask;
  await Promise.all([holder.close(), challenger.close()]);
}

async function step3_concurrentSerialization() {
  log("3/5 concurrent withWriteLock() across two pools serializes");
  const a = new MySqlStore({ ...baseConfig, writeLockTimeoutSeconds: 10 });
  const b = new MySqlStore({ ...baseConfig, writeLockTimeoutSeconds: 10 });
  await Promise.all([a.connect(), b.connect()]);
  const events = [];
  const HOLD_MS = 150;
  const tasks = [];
  for (let i = 0; i < 5; i++) {
    const store = i % 2 === 0 ? a : b;
    tasks.push(store.withWriteLock(async () => {
      const entry = { idx: i, store: store === a ? "A" : "B", enter: Date.now() };
      events.push(entry);
      await new Promise((r) => setTimeout(r, HOLD_MS));
      entry.exit = Date.now();
    }));
  }
  await Promise.all(tasks);

  // Sort by enter time, then check no critical section overlaps another.
  events.sort((x, y) => x.enter - y.enter);
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const cur = events[i];
    log(`    ${prev.store}#${prev.idx} ${prev.enter}->${prev.exit} | ${cur.store}#${cur.idx} ${cur.enter}->${cur.exit}`);
    assert.ok(
      cur.enter >= prev.exit - 5,
      `critical sections must serialize: ${prev.store}#${prev.idx} exits at ${prev.exit}, ${cur.store}#${cur.idx} enters at ${cur.enter}`
    );
  }
  await Promise.all([a.close(), b.close()]);
}

async function step4_noSelfDeadlockWithSmallPool() {
  log("4/5 connectionLimit=2 + named lock does not self-deadlock under load");
  // Caller asks for 2 explicitly to prove pool size 2 is sufficient.
  const store = new MySqlStore({ ...baseConfig, connectionLimit: 2, writeLockTimeoutSeconds: 10 });
  await store.connect();
  assert.equal(store.config.connectionLimit, 2);

  const startedAt = Date.now();
  // Force several writeLock cycles back-to-back; each cycle pins one pool conn
  // for the lock and asks for another for the work — connectionLimit=2 must be enough.
  await Promise.all([0, 1, 2, 3].map((i) =>
    store.withWriteLock(async () => {
      // do a trivial query inside the critical section to actually grab a 2nd connection
      await store.pool.query("SELECT 1 AS ok");
      log(`    cycle ${i} done at +${Date.now() - startedAt}ms`);
    })
  ));
  log(`    4 serialized cycles finished in ${Date.now() - startedAt}ms`);
  await store.close();
}

async function step5_workingStateReset() {
  log("5/5 withWriteLock resets db.usage* working state on exit");
  const store = new MySqlStore({ ...baseConfig, writeLockTimeoutSeconds: 5 });
  await store.connect();
  await store.withWriteLock(async () => {
    store.db.usageDaily["p_live_test"] = { d_live: { "2026-05-25": { totalTokens: 1 } } };
    store.db.usageHourly["p_live_test"] = { d_live: { "2026-05-25T12": { totalTokens: 1 } } };
    store.db.usageSyncBuckets["fp_live"] = { keys: ["x"] };
    store.db.usageSyncBucketsHourly["fp_live"] = { keys: ["x"] };
    store.db.uploadBatches["b_live"] = { status: "queued" };
  });
  assert.deepEqual(store.db.usageDaily, {}, "usageDaily must reset to {}");
  assert.deepEqual(store.db.usageHourly, {}, "usageHourly must reset to {}");
  assert.deepEqual(store.db.usageSyncBuckets, {}, "usageSyncBuckets must reset to {}");
  assert.deepEqual(store.db.usageSyncBucketsHourly, {}, "usageSyncBucketsHourly must reset to {}");
  assert.deepEqual(store.db.uploadBatches, {}, "uploadBatches must reset to {}");

  // Same invariant on error path.
  await assert.rejects(
    store.withWriteLock(async () => {
      store.db.usageDaily["dirty"] = {};
      throw new Error("boom");
    }),
    /boom/
  );
  assert.deepEqual(store.db.usageDaily, {}, "usageDaily must reset to {} even on error");
  await store.close();
}

(async () => {
  log("lock name:", lockName);
  log("target:", `${baseConfig.user}@${baseConfig.host}:${baseConfig.port}/${baseConfig.database}`);
  try {
    await step1_acquireRelease();
    await step2_failFastTimeoutZero();
    await step3_concurrentSerialization();
    await step4_noSelfDeadlockWithSmallPool();
    await step5_workingStateReset();
    log("ALL LIVE MYSQL CHECKS PASSED");
  } catch (e) {
    console.error("[live] FAILED:", e);
    process.exit(1);
  }
})();
