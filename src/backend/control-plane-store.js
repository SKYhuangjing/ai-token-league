// Plugin listings and the compute-sharing ledger follow DB_TYPE.
// mysql → dedicated tables. json → fields on the JSON store, not sidecar files.
// Existing sidecar files are imported once when the selected store is empty.
//
// MySQL write path mirrors the main store's conventions: the transaction's
// own connection takes the same named write lock (GET_LOCK is per-connection),
// and each flush is a row-level diff (upsert changed rows, delete vanished
// ids) — heartbeats touch one share row per ~8s, so a full-table rewrite per
// flush would be pure write amplification. A failed flush retries on a 30s
// timer: the heartbeat path swallows persist errors by design (a 500 would
// make the CPA re-send usage deltas and double-count), so the adapter heals
// on its own instead of stranding the tail state.

import fs from "node:fs";
import path from "node:path";

import { acquireWriteLockOnConnection, releaseWriteLockOnConnection } from "./mysql-store.js";

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function retireSidecar(file) {
  if (!fs.existsSync(file)) return;
  const target = `${file}.migrated`;
  fs.renameSync(file, fs.existsSync(target) ? `${file}.migrated.${Date.now()}` : target);
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function shareToRow(share) {
  return {
    shareId: share.shareId,
    shareSecret: share.shareSecret,
    state: share.state || "active",
    title: String(share.title || "").slice(0, 80),
    baseURL: String(share.baseURL || "").slice(0, 200),
    modelsJson: JSON.stringify(share.models || []),
    policyJson: JSON.stringify(share.policy || {}),
    settledJson: JSON.stringify(share.settled || {}),
    // lanes-design fields: absent → null → parseJson keeps them undefined so
    // effectiveLanes falls back to the implicit default lane (old rows)
    lanesJson: JSON.stringify(share.lanes ?? null),
    laneSettledJson: JSON.stringify(share.laneSettled ?? null),
    wallSignalJson: JSON.stringify(share.wallSignal ?? null),
    lifetimeSettled: Number(share.lifetimeSettled) || 0,
    claimsIssued: Number(share.claimsIssued) || 0,
    participantId: share.participantId || "",
    ownerDisplayId: share.ownerDisplayId || "",
    ownerNickname: String(share.ownerNickname || "").slice(0, 80),
    windowDay: share.windowDay || "",
    lastHeartbeatAt: Number(share.lastHeartbeatAt) || 0,
    lastPluginVersion: String(share.lastPluginVersion || "").slice(0, 64),
    createdAt: Number(share.createdAt) || 0,
    updatedAt: Number(share.updatedAt) || 0,
  };
}

export function rowToShare(row) {
  const share = {
    shareId: row.shareId,
    shareSecret: row.shareSecret,
    state: row.state,
    title: row.title,
    baseURL: row.baseURL,
    models: parseJson(row.modelsJson, []),
    policy: parseJson(row.policyJson, {}),
    settled: parseJson(row.settledJson, {}),
    lifetimeSettled: Number(row.lifetimeSettled) || 0,
    claimsIssued: Number(row.claimsIssued) || 0,
    participantId: row.participantId || "",
    ownerDisplayId: row.ownerDisplayId || "",
    ownerNickname: row.ownerNickname || "",
    windowDay: row.windowDay || "",
    lastHeartbeatAt: Number(row.lastHeartbeatAt) || 0,
    lastPluginVersion: row.lastPluginVersion || "",
    createdAt: Number(row.createdAt) || 0,
    updatedAt: Number(row.updatedAt) || 0,
  };
  const lanes = parseJson(row.lanesJson, null);
  if (Array.isArray(lanes) && lanes.length) share.lanes = lanes;
  const laneSettled = parseJson(row.laneSettledJson, null);
  if (laneSettled && typeof laneSettled === "object") share.laneSettled = laneSettled;
  const wallSignal = parseJson(row.wallSignalJson, null);
  if (wallSignal && typeof wallSignal === "object") share.wallSignal = wallSignal;
  return share;
}

export function claimToRow(claim) {
  return {
    keyId: claim.keyId,
    shareId: claim.shareId,
    laneId: claim.laneId || "",
    shareTitle: claim.shareTitle || "",
    token: claim.token,
    borrower: claim.borrower || "",
    participantId: claim.participantId || "",
    displayId: claim.displayId || "",
    state: claim.state || "valid",
    usedTokens: Number(claim.usedTokens) || 0,
    requests: Number(claim.requests) || 0,
    failedRequests: Number(claim.failedRequests) || 0,
    createdAt: Number(claim.createdAt) || 0,
    expiresAt: Number(claim.expiresAt) || 0,
    lastUsedAt: Number(claim.lastUsedAt) || 0,
  };
}

export function rowToClaim(row) {
  return {
    keyId: row.keyId,
    shareId: row.shareId,
    laneId: row.laneId || "",
    shareTitle: row.shareTitle || "",
    token: row.token,
    borrower: row.borrower || "",
    participantId: row.participantId || "",
    displayId: row.displayId || "",
    state: row.state,
    usedTokens: Number(row.usedTokens) || 0,
    requests: Number(row.requests) || 0,
    failedRequests: Number(row.failedRequests) || 0,
    createdAt: Number(row.createdAt) || 0,
    expiresAt: Number(row.expiresAt) || 0,
    lastUsedAt: Number(row.lastUsedAt) || 0,
  };
}

function emptySharing() {
  return { version: 1, shares: {}, claims: {} };
}

function createJsonControlPlane(store) {
  store.db.moduleListings ||= {};
  store.db.sharingCpa ||= emptySharing();
  return {
    listings: {
      async load() {
        return { version: 1, modules: store.db.moduleListings || {} };
      },
      async save(modules) {
        store.db.moduleListings = modules || {};
        store.saveDocuments();
      },
    },
    sharing: {
      async load() {
        const doc = store.db.sharingCpa || emptySharing();
        return { version: 1, shares: doc.shares || {}, claims: doc.claims || {} };
      },
      async save(db) {
        store.db.sharingCpa = { version: 1, shares: db.shares || {}, claims: db.claims || {} };
        store.saveDocuments();
      },
    },
    async migrateSidecars(dataDir) {
      const listingsFile = path.join(dataDir, "module-listings.json");
      const sharingFile = path.join(dataDir, "sharing-cpa.json");
      if (!Object.keys(store.db.moduleListings || {}).length) {
        const parsed = readJsonFile(listingsFile);
        if (parsed?.modules && Object.keys(parsed.modules).length) {
          store.db.moduleListings = parsed.modules;
          store.saveDocuments();
          retireSidecar(listingsFile);
        }
      }
      const sharing = store.db.sharingCpa || emptySharing();
      if (!Object.keys(sharing.shares || {}).length && !Object.keys(sharing.claims || {}).length) {
        const parsed = readJsonFile(sharingFile);
        if (parsed && (Object.keys(parsed.shares || {}).length || Object.keys(parsed.claims || {}).length)) {
          store.db.sharingCpa = { version: 1, shares: parsed.shares || {}, claims: parsed.claims || {} };
          store.saveDocuments();
          retireSidecar(sharingFile);
        }
      }
    },
  };
}

const SHARE_COLUMNS = [
  "shareId", "shareSecret", "state", "title", "baseURL", "modelsJson", "policyJson", "settledJson",
  "lanesJson", "laneSettledJson", "wallSignalJson",
  "lifetimeSettled", "claimsIssued", "participantId", "ownerDisplayId", "ownerNickname",
  "windowDay", "lastHeartbeatAt", "lastPluginVersion", "createdAt", "updatedAt",
];
const CLAIM_COLUMNS = [
  "keyId", "shareId", "laneId", "shareTitle", "token", "borrower", "participantId", "displayId", "state",
  "usedTokens", "requests", "failedRequests", "createdAt", "expiresAt", "lastUsedAt",
];

function upsertSql(table, columns) {
  const updates = columns.slice(1).map((column) => `${column} = VALUES(${column})`).join(", ");
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON DUPLICATE KEY UPDATE ${updates}`;
}

// Row-level diff between the last flushed state and the next snapshot. Rows
// are compared by their serialized row shape, so a heartbeat that only moves
// lastHeartbeatAt produces exactly one share upsert and no claim writes.
export function diffSharingRows(prevRows, next) {
  const prevShares = prevRows?.shares || {};
  const prevClaims = prevRows?.claims || {};
  const rows = { shares: {}, claims: {} };
  const upsertShares = [];
  const deleteShareIds = [];
  const upsertClaims = [];
  const deleteClaimIds = [];
  for (const [id, share] of Object.entries(next?.shares || {})) {
    const rowJson = JSON.stringify(shareToRow(share));
    rows.shares[id] = rowJson;
    if (prevShares[id] !== rowJson) upsertShares.push(JSON.parse(rowJson));
  }
  for (const id of Object.keys(prevShares)) {
    if (!(id in rows.shares)) deleteShareIds.push(id);
  }
  for (const [keyId, claim] of Object.entries(next?.claims || {})) {
    const rowJson = JSON.stringify(claimToRow(claim));
    rows.claims[keyId] = rowJson;
    if (prevClaims[keyId] !== rowJson) upsertClaims.push(JSON.parse(rowJson));
  }
  for (const keyId of Object.keys(prevClaims)) {
    if (!(keyId in rows.claims)) deleteClaimIds.push(keyId);
  }
  return { upsertShares, deleteShareIds, upsertClaims, deleteClaimIds, rows };
}

export function diffListingRows(prevRows, nextModules) {
  const prev = prevRows || {};
  const rows = {};
  const upserts = [];
  const deletes = [];
  for (const [id, record] of Object.entries(nextModules || {})) {
    const rowJson = JSON.stringify({ listed: record?.listed !== false, updatedAt: String(record?.updatedAt || "") });
    rows[id] = rowJson;
    if (prev[id] !== rowJson) upserts.push({ id, ...JSON.parse(rowJson) });
  }
  for (const id of Object.keys(prev)) {
    if (!(id in rows)) deletes.push(id);
  }
  return { upserts, deletes, rows };
}

function createMysqlControlPlane(store) {
  const pool = store.pool;
  const lockConfig = {
    writeLockName: store.config?.writeLockName || "",
    writeLockTimeoutSeconds: store.config?.writeLockTimeoutSeconds ?? 30,
  };
  let flushedSharingRows = null;
  let flushedListingRows = null;
  // Snapshots of saves that failed (MySQL blip) awaiting the retry timer.
  const pending = { sharing: null, listings: null };
  let retryTimer = null;

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const jobs = [];
      if (pending.sharing) jobs.push(flushSharing(pending.sharing).then(() => { pending.sharing = null; }).catch(() => {}));
      if (pending.listings) jobs.push(flushListings(pending.listings).then(() => { pending.listings = null; }).catch(() => {}));
      Promise.all(jobs).then(() => {
        if (pending.sharing || pending.listings) scheduleRetry();
      });
    }, 30_000);
    retryTimer.unref?.();
  }

  async function runWriteTransaction(work) {
    const conn = await pool.getConnection();
    let locked = false;
    try {
      await acquireWriteLockOnConnection(conn, lockConfig);
      locked = true;
      await conn.beginTransaction();
      await work(conn);
      await conn.commit();
    } catch (error) {
      try { await conn.rollback(); } catch { /* connection already broken */ }
      throw error;
    } finally {
      if (locked) await releaseWriteLockOnConnection(conn, lockConfig).catch(() => {});
      conn.release();
    }
  }

  async function flushSharing(db) {
    const diff = diffSharingRows(flushedSharingRows, db);
    if (!diff.upsertShares.length && !diff.deleteShareIds.length && !diff.upsertClaims.length && !diff.deleteClaimIds.length) {
      flushedSharingRows = diff.rows;
      return;
    }
    await runWriteTransaction(async (conn) => {
      for (const id of diff.deleteShareIds) {
        await conn.query("DELETE FROM sharing_shares WHERE shareId = ?", [id]);
      }
      for (const row of diff.upsertShares) {
        await conn.query(upsertSql("sharing_shares", SHARE_COLUMNS), SHARE_COLUMNS.map((column) => row[column]));
      }
      for (const keyId of diff.deleteClaimIds) {
        await conn.query("DELETE FROM sharing_claims WHERE keyId = ?", [keyId]);
      }
      for (const row of diff.upsertClaims) {
        await conn.query(upsertSql("sharing_claims", CLAIM_COLUMNS), CLAIM_COLUMNS.map((column) => row[column]));
      }
    });
    flushedSharingRows = diff.rows;
  }

  async function flushListings(modules) {
    const diff = diffListingRows(flushedListingRows, modules);
    if (!diff.upserts.length && !diff.deletes.length) {
      flushedListingRows = diff.rows;
      return;
    }
    await runWriteTransaction(async (conn) => {
      for (const id of diff.deletes) {
        await conn.query("DELETE FROM module_listings WHERE id = ?", [id]);
      }
      for (const row of diff.upserts) {
        await conn.query(upsertSql("module_listings", ["id", "listed", "updatedAt"]), [row.id, row.listed ? 1 : 0, row.updatedAt]);
      }
    });
    flushedListingRows = diff.rows;
  }

  return {
    listings: {
      async load() {
        const [rows] = await pool.query("SELECT id, listed, updatedAt FROM module_listings");
        const modules = {};
        flushedListingRows = {};
        for (const row of rows) {
          modules[row.id] = { listed: Boolean(row.listed), updatedAt: row.updatedAt };
          flushedListingRows[row.id] = JSON.stringify({ listed: Boolean(row.listed), updatedAt: String(row.updatedAt || "") });
        }
        return { version: 1, modules };
      },
      async save(modules) {
        try {
          await flushListings(modules);
          pending.listings = null;
        } catch (error) {
          pending.listings = modules;
          scheduleRetry();
          throw error;
        }
      },
    },
    sharing: {
      async load() {
        const [shares] = await pool.query("SELECT * FROM sharing_shares");
        const [claims] = await pool.query("SELECT * FROM sharing_claims");
        const state = {
          version: 1,
          shares: Object.fromEntries(shares.map((row) => [row.shareId, rowToShare(row)])),
          claims: Object.fromEntries(claims.map((row) => [row.keyId, rowToClaim(row)])),
        };
        flushedSharingRows = diffSharingRows(null, state).rows;
        return state;
      },
      async save(db) {
        try {
          await flushSharing(db);
          pending.sharing = null;
        } catch (error) {
          pending.sharing = db;
          scheduleRetry();
          throw error;
        }
      },
    },
    async migrateSidecars(dataDir) {
      const listingsFile = path.join(dataDir, "module-listings.json");
      const sharingFile = path.join(dataDir, "sharing-cpa.json");
      const [listingCount] = await pool.query("SELECT COUNT(*) AS n FROM module_listings");
      if (!Number(listingCount[0]?.n)) {
        const parsed = readJsonFile(listingsFile);
        if (parsed?.modules && Object.keys(parsed.modules).length) {
          await this.listings.save(parsed.modules);
          retireSidecar(listingsFile);
        }
      }
      const [shareCount] = await pool.query("SELECT COUNT(*) AS n FROM sharing_shares");
      const [claimCount] = await pool.query("SELECT COUNT(*) AS n FROM sharing_claims");
      if (!Number(shareCount[0]?.n) && !Number(claimCount[0]?.n)) {
        const parsed = readJsonFile(sharingFile);
        if (parsed && (Object.keys(parsed.shares || {}).length || Object.keys(parsed.claims || {}).length)) {
          await this.sharing.save({ shares: parsed.shares || {}, claims: parsed.claims || {} });
          retireSidecar(sharingFile);
        }
      }
    },
  };
}

export function createControlPlaneStore(store) {
  if (store?.dbType === "mysql") return createMysqlControlPlane(store);
  return createJsonControlPlane(store);
}
