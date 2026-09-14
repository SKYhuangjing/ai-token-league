// Compute-sharing control plane — CPA plugin edition (R23).
//
// The execution layer lives inside the owner's CPA as the `atl-share` plugin
// (cpa-plugin/); this module is the single source of truth the plugin syncs
// against: share registry, claim-key minting/revocation, window-budget
// accounting from plugin usage reports, and the owner/admin views. Persistence
// follows DB_TYPE (MySQL tables or the JSON store). Tests may still pass
// dataDir to use an isolated sidecar file.
//
// Contract (see doc/compute-sharing-handoff.md R23):
//   owner  x-atl-share-secret: POST /api/shares/register|heartbeat|unregister,
//                              POST /api/shares/owner/policy, GET  /api/shares/owner/status
//   public:                    GET  /api/shares, POST /api/shares/claim,
//                              POST /api/shares/claims/revoke, POST /api/shares/claims/mine
//   admin (basic auth):        GET  /api/admin/shares[+/claims],
//                              POST /api/admin/shares/{revoke,suspend,resume,delete,policy}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_POLICY = {
  budget: 1_000_000,     // window token pool (local-day window)
  maxClaims: 5,          // concurrently-valid claim keys
  keyMaxTokens: 0,       // per-key window cap; 0 = auto = budget / maxClaims
  keyConcurrency: 3,     // per-key in-flight cap (enforced by the plugin)
  ttlHours: 168,         // claim key lifetime (7 days)
};
const HEARTBEAT_ONLINE_MS = 120_000; // claim requires a live plugin heartbeat
const CLAIM_RATE_PER_MINUTE = 6;
// Signed-claim freshness window: the device signature covers {kind,
// participantId, shareId, ts}; stale signatures are rejected to prevent replay.
const CLAIM_TS_WINDOW_MS = 10 * 60 * 1000;

const now = () => Date.now();

function localDayString(ts = now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function randomId(prefix, bytes = 16) {
  return `${prefix}${crypto.randomBytes(bytes).toString("hex")}`;
}

function mintToken() {
  return `atl_sk_${crypto.randomBytes(24).toString("base64url")}`;
}

function clampPolicy(input = {}) {
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const policy = {
    budget: num(input.budget, DEFAULT_POLICY.budget, 1_000, 1_000_000_000_000),
    maxClaims: num(input.maxClaims, DEFAULT_POLICY.maxClaims, 1, 200),
    keyMaxTokens: num(input.keyMaxTokens, 0, 0, 1_000_000_000_000),
    keyConcurrency: num(input.keyConcurrency, DEFAULT_POLICY.keyConcurrency, 1, 64),
    ttlHours: num(input.ttlHours, DEFAULT_POLICY.ttlHours, 1, 24 * 30),
  };
  if (!policy.keyMaxTokens) {
    // fair split: budget ÷ slots (R19/D5 semantics carried over)
    policy.keyMaxTokens = Math.max(1, Math.floor(policy.budget / policy.maxClaims));
  }
  return policy;
}

export function createSharingCpa({ dataDir, initial, persistState, verifyIdentity } = {}) {
  const file = dataDir ? path.join(dataDir, "sharing-cpa.json") : "";
  let db = initial && typeof initial === "object"
    ? { version: 1, shares: initial.shares || {}, claims: initial.claims || {} }
    : { version: 1, shares: {}, claims: {} };
  let saveTimer = null;
  let saveChain = Promise.resolve();
  const claimHits = new Map(); // ip -> minute-window hits
  // Claiming is identity-bound (R28): the desktop client signs the claim with
  // its league identity key and the caller wires this verifier to the usage
  // store's participant registry. No verifier = claiming is impossible.
  const identityGuard = verifyIdentity || (async () => ({ ok: false, reason: "identity_verification_unavailable" }));

  if (!initial && file) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") db = { version: 1, shares: parsed.shares || {}, claims: parsed.claims || {} };
    } catch { /* fresh start */ }
  }

  function writeNow() {
    const snapshot = JSON.parse(JSON.stringify({ version: 1, shares: db.shares, claims: db.claims }));
    if (persistState) {
      saveChain = saveChain.then(() => persistState(snapshot)).catch(() => {});
      return saveChain;
    }
    if (!file) return Promise.resolve();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
    } catch { /* best effort; next change retries */ }
    return Promise.resolve();
  }

  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeNow();
    }, 150);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  const activeClaimsOf = (shareId) =>
    Object.values(db.claims).filter((c) => c.shareId === shareId && c.state === "valid" && c.expiresAt > now());

  const windowSettled = (share) => Object.values(share.settled || {}).reduce((a, b) => a + b, 0);

  function rollShareWindow(share) {
    const today = localDayString();
    if (share.windowDay !== today) {
      share.windowDay = today;
      share.settled = {};
    }
    return today;
  }

  function pruneExpiredClaims() {
    const ts = now();
    for (const claim of Object.values(db.claims)) {
      if (claim.state === "valid" && claim.expiresAt <= ts) claim.state = "expired";
    }
  }

  function publicShareView(share) {
    const online = now() - (share.lastHeartbeatAt || 0) < HEARTBEAT_ONLINE_MS;
    const settled = windowSettled(share);
    const available = Math.max(0, share.policy.budget - settled);
    return {
      shareId: share.shareId,
      title: share.title,
      models: share.models || [],
      online,
      state: share.state,
      slotsLeft: Math.max(0, share.policy.maxClaims - activeClaimsOf(share.shareId).length),
      budgetTokens: share.policy.budget,
      settledTokens: settled,
      availableTokens: available,
      exhausted: share.state === "active" && available <= 0,
      updatedAt: share.lastHeartbeatAt || share.updatedAt || 0,
    };
  }

  function claimView(claim, { withToken = false } = {}) {
    const view = {
      keyId: claim.keyId,
      shareId: claim.shareId,
      shareTitle: claim.shareTitle,
      borrower: claim.borrower,
      participantId: claim.participantId || "",
      displayId: claim.displayId || "",
      state: claim.state,
      createdAt: claim.createdAt,
      expiresAt: claim.expiresAt,
      usedTokens: claim.usedTokens,
      requests: claim.requests,
      failedRequests: claim.failedRequests || 0,
      lastUsedAt: claim.lastUsedAt || 0,
    };
    if (withToken) view.token = claim.token;
    return view;
  }

  function findShareBySecret(secret) {
    if (!secret || typeof secret !== "string" || secret.length < 16) return null;
    const share = Object.values(db.shares).find((s) => s.shareSecret === secret);
    return share || null;
  }

  function heartbeatResponse(share) {
    const windowDay = rollShareWindow(share);
    pruneExpiredClaims();
    return {
      state: share.state,
      windowDay,
      policy: {
        budget: share.policy.budget,
        keyMaxTokens: share.policy.keyMaxTokens,
        keyConcurrency: share.policy.keyConcurrency,
        ttlHours: share.policy.ttlHours,
      },
      keys: activeClaimsOf(share.shareId).map((c) => ({
        keyId: c.keyId,
        token: c.token,
        keyMaxTokens: share.policy.keyMaxTokens,
        expiresAtMs: c.expiresAt,
      })),
      settledByKey: share.settled || {},
    };
  }

  // ── request plumbing ─────────────────────────────────────────────────────

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    // Desktop plugins fetch this API from the webview origin. Without these
    // headers WebKit reports the cross-origin GET as "Load failed".
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1 << 20) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch (e) {
          reject(new Error("invalid json"));
        }
      });
      req.on("error", reject);
    });
  }

  function claimRateOk(ip) {
    const bucket = Math.floor(now() / 60_000);
    // prune stale IPs so rotating clients can't grow the map without bound
    if (claimHits.size > 512) {
      for (const [key, entry] of claimHits) {
        if (bucket - entry.bucket > 5) claimHits.delete(key);
      }
    }
    const entry = claimHits.get(ip);
    if (!entry || entry.bucket !== bucket) {
      claimHits.set(ip, { bucket, hits: 1 });
      return true;
    }
    entry.hits += 1;
    return entry.hits <= CLAIM_RATE_PER_MINUTE;
  }

  // ── handlers ─────────────────────────────────────────────────────────────

  async function handleRegister(req, res, body) {
    // Identity gate (A.1): registering a share requires a league device
    // signature — the same chain as claims, kind "share-register". Anyone
    // can no longer mint shares into the public directory.
    const ts = Number(body.ts) || 0;
    if (!body.participantId || !body.signature || Math.abs(now() - ts) > CLAIM_TS_WINDOW_MS) {
      sendJson(res, 401, { error: "identity_required" });
      return;
    }
    const identity = await identityGuard({
      kind: "share-register",
      participantId: String(body.participantId),
      ts,
      signature: String(body.signature || ""),
    });
    if (!identity || !identity.ok) {
      sendJson(res, 401, { error: (identity && identity.reason) || "identity_required" });
      return;
    }
    const owner = identity.participant || {};
    const existing = findShareBySecret(req.headers["x-atl-share-secret"]);
    let share = existing;
    if (!share) {
      // register-trust: a new registration goes live immediately (same
      // semantics as the stashed control plane; admin can suspend after).
      share = {
        shareId: randomId("shr_"),
        shareSecret: crypto.randomBytes(32).toString("hex"),
        createdAt: now(),
        state: "active",
        settled: {},
        lifetimeSettled: 0,
        claimsIssued: 0,
      };
      db.shares[share.shareId] = share;
    }
    share.title = String(body.title || "CPA share").slice(0, 60) || "CPA share";
    share.baseURL = String(body.baseURL || "").trim().slice(0, 200);
    share.models = Array.isArray(body.models) && body.models.length
      ? body.models.map((m) => String(m).slice(0, 80)).slice(0, 50)
      : ["*"];
    share.policy = clampPolicy({ ...share.policy, ...(body.policy || {}) });
    share.updatedAt = now();
    share.participantId = String(body.participantId);
    share.ownerDisplayId = String(owner.displayId || "");
    share.ownerNickname = String(owner.nickname || "");
    persist();
    sendJson(res, 200, {
      shareId: share.shareId,
      shareSecret: share.shareSecret,
      registered: true,
      rebind: Boolean(existing),
    });
  }

  async function handleHeartbeat(req, res, body) {
    const share = findShareBySecret(req.headers["x-atl-share-secret"]);
    if (!share || (body.shareId && body.shareId !== share.shareId)) {
      sendJson(res, 401, { error: "invalid_share_secret" });
      return;
    }
    share.lastHeartbeatAt = now();
    share.lastPluginVersion = String(body.pluginVersion || "");
    // The plugin re-detects its public endpoint every heartbeat; a changed
    // LAN IP or CPA port updates the share so borrowers never claim keys
    // pointing at a dead endpoint (B2, review R28b).
    const liveBaseURL = String(body.baseURL || "").trim();
    if (liveBaseURL && liveBaseURL !== share.baseURL) {
      share.baseURL = liveBaseURL.slice(0, 200);
      share.updatedAt = now();
    }
    const windowDay = rollShareWindow(share);
    share.settled = share.settled || {};

    let applied = 0;
    let orphaned = 0;
    for (const delta of Array.isArray(body.usage) ? body.usage : []) {
      const keyId = String(delta.keyId || "");
      const tokens = Math.max(0, Number(delta.tokens) || 0);
      const requests = Math.max(0, Number(delta.requests) || 0);
      const failed = Math.max(0, Number(delta.failed) || 0);
      const claim = db.claims[keyId];
      if (!claim || claim.shareId !== share.shareId) {
        orphaned += 1;
        continue;
      }
      claim.usedTokens = (claim.usedTokens || 0) + tokens;
      claim.requests = (claim.requests || 0) + requests;
      claim.failedRequests = (claim.failedRequests || 0) + failed;
      claim.lastUsedAt = now();
      share.settled[keyId] = (share.settled[keyId] || 0) + tokens;
      share.lifetimeSettled = (share.lifetimeSettled || 0) + tokens;
      applied += 1;
    }
    pruneExpiredClaims();
    persist();
    sendJson(res, 200, { ...heartbeatResponse(share), applied, orphaned, windowDay });
  }

  async function handleUnregister(req, res) {
    const share = findShareBySecret(req.headers["x-atl-share-secret"]);
    if (!share) {
      sendJson(res, 404, { error: "share_not_found" });
      return;
    }
    share.state = "stopped";
    share.updatedAt = now();
    for (const claim of Object.values(db.claims)) {
      if (claim.shareId === share.shareId && claim.state === "valid") claim.state = "revoked";
    }
    persist();
    sendJson(res, 200, { unregistered: true, shareId: share.shareId });
  }

  async function handleOwnerStatus(req, res, url) {
    const share = findShareBySecret(req.headers["x-atl-share-secret"]);
    if (!share) {
      sendJson(res, 404, { error: "share_not_found" });
      return;
    }
    rollShareWindow(share);
    pruneExpiredClaims();
    const claims = Object.values(db.claims)
      .filter((c) => c.shareId === share.shareId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((c) => claimView(c));
    sendJson(res, 200, {
      share: {
        ...publicShareView(share),
        baseURL: share.baseURL,
        plugin: { online: now() - (share.lastHeartbeatAt || 0) < HEARTBEAT_ONLINE_MS, version: share.lastPluginVersion || null, lastHeartbeatAt: share.lastHeartbeatAt || 0 },
        lifetimeSettled: share.lifetimeSettled || 0,
        claimsIssued: share.claimsIssued || 0,
        windowDay: share.windowDay,
      },
      claims,
    });
  }

  async function handleOwnerPolicy(req, res, body) {
    const share = findShareBySecret(req.headers["x-atl-share-secret"]);
    if (!share) {
      sendJson(res, 404, { error: "share_not_found" });
      return;
    }
    share.policy = clampPolicy({ ...share.policy, ...(body.policy || body) });
    share.updatedAt = now();
    persist();
    sendJson(res, 200, { policy: share.policy });
  }

  async function handleListShares(req, res) {
    pruneExpiredClaims();
    for (const share of Object.values(db.shares)) rollShareWindow(share);
    const shares = Object.values(db.shares)
      .filter((s) => s.state !== "stopped")
      .map(publicShareView)
      .sort((a, b) => Number(b.online) - Number(a.online) || a.title.localeCompare(b.title));
    sendJson(res, 200, { shares });
  }

  async function handleClaim(req, res, body) {
    const ip = req.socket.remoteAddress || "unknown";
    if (!claimRateOk(ip)) {
      sendJson(res, 429, { error: "rate_limited" });
      return;
    }
    const share = db.shares[String(body.shareId || "")];
    if (!share || share.state !== "active") {
      sendJson(res, 404, { error: "share_not_found" });
      return;
    }
    // Identity first (R28): the payload {kind:"share-claim", participantId,
    // shareId, ts} is signed with the league identity key on the client.
    // Anonymous callers learn nothing about share availability/budget state.
    const ts = Number(body.ts) || 0;
    if (!body.participantId || !body.signature || Math.abs(now() - ts) > CLAIM_TS_WINDOW_MS) {
      sendJson(res, 401, { error: "identity_required" });
      return;
    }
    const identity = await identityGuard({
      kind: "share-claim",
      participantId: String(body.participantId),
      shareId: share.shareId,
      ts,
      signature: String(body.signature || ""),
    });
    if (!identity || !identity.ok) {
      sendJson(res, 401, { error: (identity && identity.reason) || "identity_required" });
      return;
    }
    rollShareWindow(share);
    pruneExpiredClaims();
    if (now() - (share.lastHeartbeatAt || 0) > HEARTBEAT_ONLINE_MS) {
      sendJson(res, 409, { error: "share_offline", message: "share plugin is not heartbeating" });
      return;
    }
    if (windowSettled(share) >= share.policy.budget) {
      sendJson(res, 409, { error: "budget_exhausted" });
      return;
    }
    if (activeClaimsOf(share.shareId).length >= share.policy.maxClaims) {
      sendJson(res, 409, { error: "no_claim_slots" });
      return;
    }
    const participant = identity.participant || {};
    const claim = {
      keyId: randomId("csk_", 8),
      shareId: share.shareId,
      shareTitle: share.title,
      token: mintToken(),
      borrower: String(participant.nickname || participant.displayId || participant.participantId || body.participantId).slice(0, 40),
      participantId: String(body.participantId),
      displayId: String(participant.displayId || ""),
      createdAt: now(),
      expiresAt: now() + share.policy.ttlHours * 3_600_000,
      state: "valid",
      usedTokens: 0,
      requests: 0,
      failedRequests: 0,
    };
    db.claims[claim.keyId] = claim;
    share.claimsIssued = (share.claimsIssued || 0) + 1;
    persist();
    sendJson(res, 200, {
      keyId: claim.keyId,
      token: claim.token,
      baseURL: share.baseURL,
      models: share.models,
      expiresAt: claim.expiresAt,
      shareTitle: share.title,
      keyMaxTokens: share.policy.keyMaxTokens,
      borrower: claim.borrower,
      displayId: claim.displayId,
    });
  }

  async function handleRevokeClaim(req, res, body) {
    const token = String(body.token || "");
    const claim = Object.values(db.claims).find((c) => c.token === token && c.state === "valid");
    if (!claim) {
      sendJson(res, 404, { error: "claim_not_found" });
      return;
    }
    claim.state = "revoked";
    persist();
    sendJson(res, 200, { revoked: claim.keyId });
  }

  async function handleMyClaims(req, res, body) {
    const tokens = new Set((Array.isArray(body.tokens) ? body.tokens : []).map(String));
    pruneExpiredClaims();
    const claims = Object.values(db.claims)
      .filter((c) => tokens.has(c.token))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((c) => claimView(c, { withToken: true }));
    sendJson(res, 200, { claims });
  }

  async function handleAdminShares(req, res) {
    pruneExpiredClaims();
    const shares = Object.values(db.shares)
      .map((s) => ({
        ...publicShareView(s),
        baseURL: s.baseURL,
        claimsIssued: s.claimsIssued || 0,
        lifetimeSettled: s.lifetimeSettled || 0,
        ownerNickname: s.ownerNickname || "",
        ownerDisplayId: s.ownerDisplayId || "",
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    sendJson(res, 200, { shares });
  }

  async function handleAdminClaims(req, res) {
    pruneExpiredClaims();
    const claims = Object.values(db.claims)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((c) => ({
        ...claimView(c, { withToken: false }),
        borrower: `${c.borrower}${c.participantId ? "" : " (anonymous)"}`,
        token: `${c.token.slice(0, 12)}…`,
      }));
    sendJson(res, 200, { claims });
  }

  async function handleAdminAction(req, res, body, url) {
    const action = url.pathname.split("/").pop();
    if (action === "revoke") {
      const claim = db.claims[String(body.keyId || "")];
      if (!claim) {
        sendJson(res, 404, { error: "claim_not_found" });
        return;
      }
      claim.state = "revoked";
      persist();
      sendJson(res, 200, { revoked: claim.keyId });
      return;
    }
    if (action === "suspend" || action === "resume") {
      const share = db.shares[String(body.shareId || "")];
      if (!share) {
        sendJson(res, 404, { error: "share_not_found" });
        return;
      }
      share.state = action === "suspend" ? "suspended" : "active";
      share.updatedAt = now();
      if (share.state !== "active") {
        for (const claim of Object.values(db.claims)) {
          if (claim.shareId === share.shareId && claim.state === "valid") claim.state = "revoked";
        }
      }
      persist();
      sendJson(res, 200, { shareId: share.shareId, state: share.state });
      return;
    }
    if (action === "policy") {
      const share = db.shares[String(body.shareId || "")];
      if (!share) {
        sendJson(res, 404, { error: "share_not_found" });
        return;
      }
      share.policy = clampPolicy({ ...share.policy, ...(body.policy || {}) });
      share.updatedAt = now();
      persist();
      sendJson(res, 200, { shareId: share.shareId, policy: share.policy });
      return;
    }
    if (action === "delete") {
      const share = db.shares[String(body.shareId || "")];
      if (!share) {
        sendJson(res, 404, { error: "share_not_found" });
        return;
      }
      delete db.shares[share.shareId];
      for (const [keyId, claim] of Object.entries(db.claims)) {
        if (claim.shareId === share.shareId) delete db.claims[keyId];
      }
      persist();
      sendJson(res, 200, { deleted: share.shareId });
      return;
    }
    sendJson(res, 404, { error: "unknown_admin_action" });
  }

  // ── router ───────────────────────────────────────────────────────────────

  async function handle(req, res) {
    const url = new URL(req.url, "http://local");
    const p = url.pathname;
    try {
      if (p === "/api/shares/register" && req.method === "POST") return void await handleRegister(req, res, await readBody(req));
      if (p === "/api/shares/heartbeat" && req.method === "POST") return void await handleHeartbeat(req, res, await readBody(req));
      if (p === "/api/shares/unregister" && req.method === "POST") return void await handleUnregister(req, res);
      if (p === "/api/shares/owner/status" && req.method === "GET") return void await handleOwnerStatus(req, res, url);
      if (p === "/api/shares/owner/policy" && req.method === "POST") return void await handleOwnerPolicy(req, res, await readBody(req));
      if (p === "/api/shares" && req.method === "GET") return void await handleListShares(req, res);
      if (p === "/api/shares/claim" && req.method === "POST") return void await handleClaim(req, res, await readBody(req));
      if (p === "/api/shares/claims/revoke" && req.method === "POST") return void await handleRevokeClaim(req, res, await readBody(req));
      if (p === "/api/shares/claims/mine" && req.method === "POST") return void await handleMyClaims(req, res, await readBody(req));
      if (p === "/api/admin/shares" && req.method === "GET") return void await handleAdminShares(req, res);
      if (p === "/api/admin/shares/claims" && req.method === "GET") return void await handleAdminClaims(req, res);
      if (p.startsWith("/api/admin/shares/") && req.method === "POST") return void await handleAdminAction(req, res, await readBody(req), url);
      sendJson(res, 404, { error: "unknown_sharing_endpoint" });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "bad_request" });
    }
  }

  return {
    handle,
    close() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      return writeNow();
    },
  };
}
