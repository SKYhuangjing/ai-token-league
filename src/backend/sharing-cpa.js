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
//                              POST /api/shares/owner/policy|resume, GET  /api/shares/owner/status
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
// Anti-hoarding (M4): one borrower holding every node's slots must not be
// possible once the directory grows. Counted per participant over valid
// claims; revoking frees capacity immediately.
const MAX_ACTIVE_CLAIMS_PER_BORROWER = 5;
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

// ── Sharing lanes (compute-sharing-lanes-design.md) ─────────────────────────
// A share slices into lanes; each lane binds a budget window {unit,n} (R50
// generalized rolling grid; legacy day/week/hour5 normalize on read), a
// local-time schedule, and its own claim slots. Claim
// keys carry their lane id — the CPA plugin gates on key→lane because the
// intercept ABI has no request model field.

const WINDOW_UNITS = new Set(["hour", "day", "week"]);
const WINDOW_N_RANGE = { hour: [1, 48], day: [1, 31], week: [1, 12] };
const MAX_LANES = 8;

// Lane budget window {unit, n} (R50): "hour5" was Zhipu's plan window burned
// into a generic enum — the schema now expresses any rolling window. The
// legacy period strings ("day" | "week" | "hour5") normalize on read so
// persisted lanes and old wire payloads keep working; every write stores the
// {unit, n} form.
function clampWindowSpec(raw) {
  const spec = raw && typeof raw.window === "object" && raw.window ? raw.window : null;
  let unit = spec ? String(spec.unit || "") : "";
  let n = spec ? Number(spec.n) : NaN;
  if (!WINDOW_UNITS.has(unit) || !Number.isFinite(n)) {
    const legacy = { day: ["day", 1], week: ["week", 1], hour5: ["hour", 5] }[raw && raw.period] || ["day", 1];
    [unit, n] = legacy;
  }
  const [minN, maxN] = WINDOW_N_RANGE[unit];
  return { unit, n: Math.min(maxN, Math.max(minN, Math.round(n))) };
}

const clampInt = (v, fallback, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

// "22:00" | "22:00:30" -> minutes-of-day (seconds truncated); null if invalid
function parseHHMM(text) {
  const m = String(text || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

// schedule/peak windows: [{start,end}] HH:MM local (end may wrap past
// midnight). Stored normalized items ({startM,endM} minute marks) pass
// through so effectiveLanes re-clamps persisted lanes idempotently.
function clampWindows(input, max = 4) {
  const out = [];
  for (const raw of Array.isArray(input) ? input.slice(0, max) : []) {
    if (!raw || typeof raw !== "object") continue;
    if (Number.isFinite(raw.startM) && Number.isFinite(raw.endM) && raw.startM !== raw.endM) {
      out.push({ startM: Math.round(raw.startM), endM: Math.round(raw.endM) });
      continue;
    }
    const start = parseHHMM(raw.start);
    const end = parseHHMM(raw.end);
    if (start === null || end === null || start === end) continue;
    out.push({ startM: start, endM: end });
  }
  return out;
}

function laneSlug(text, index) {
  const slug = String(text || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return slug || `lane-${index + 1}`;
}

function clampLane(raw, index, existing = []) {
  const id = laneSlug(raw && (raw.id || raw.title), index);
  // Accept both the wire shape (budget/schedule/peak nests) and the stored
  // normalized shape (budgetTokens/scheduleWindows/...) so effectiveLanes can
  // re-clamp persisted lanes idempotently.
  const scheduleInput = (raw && raw.schedule && raw.schedule.windows) || (raw && raw.scheduleWindows) || [];
  const peakInput = (raw && raw.peak && raw.peak.windows) || (raw && raw.peakWindows) || [];
  const budgetInput = raw && raw.budget ? raw.budget.tokens : raw && raw.budgetTokens;
  const lane = {
    id: existing.includes(id) ? `${id}-${index + 1}` : id,
    title: String((raw && raw.title) || id).slice(0, 40),
    models: Array.isArray(raw && raw.models) && raw.models.length
      ? raw.models.map((m) => String(m).slice(0, 80)).slice(0, 10)
      : ["*"],
    budgetTokens: clampInt(budgetInput, DEFAULT_POLICY.budget, 1_000, 1_000_000_000_000),
    window: clampWindowSpec(raw),
    scheduleWindows: clampWindows(scheduleInput),
    maxClaims: clampInt(raw && raw.maxClaims, DEFAULT_POLICY.maxClaims, 1, 200),
    peakWindows: clampWindows(peakInput),
    peakMultiplier: clampInt(raw && raw.peak && raw.peak.multiplier, raw && raw.peakMultiplier, 1, 10),
    state: (raw && raw.state) === "suspended" ? "suspended" : "active",
  };
  return lane;
}

function clampLanes(input) {
  if (!Array.isArray(input) || !input.length) return null;
  const ids = [];
  const lanes = [];
  for (const raw of input.slice(0, MAX_LANES)) {
    const lane = clampLane(raw, lanes.length, ids);
    ids.push(lane.id);
    lanes.push(lane);
  }
  return lanes;
}

// Legacy flat policies migrate lazily into one implicit default lane; the
// stored share is never rewritten, so old clients and old data stay intact.
function effectiveLanes(share) {
  if (Array.isArray(share.lanes) && share.lanes.length) {
    return share.lanes.map((lane) => clampLane(lane, 0, []));
  }
  return [{
    id: "default",
    title: share.title || "default",
    models: share.models && share.models.length ? share.models : ["*"],
    budgetTokens: share.policy.budget,
    window: { unit: "day", n: 1 },
    scheduleWindows: [],
    maxClaims: share.policy.maxClaims,
    peakWindows: [],
    peakMultiplier: 1,
    state: "active",
  }];
}

function weekStartTs(ts, offsetMinutes = serverOffsetMinutes()) {
  // Monday 00:00 in the anchor timezone (owner tz when reported by the
  // plugin; server-local fallback keeps legacy semantics).
  const shifted = ts + offsetMinutes * 60_000;
  const dayStartUtc = Math.floor(shifted / 86_400_000) * 86_400_000;
  const start = dayStartUtc - offsetMinutes * 60_000;
  const d = new Date(start + offsetMinutes * 60_000);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0 in the anchor tz
  return start - dow * 86_400_000;
}

const serverOffsetMinutes = () => -new Date().getTimezoneOffset();

// The lane's effective budget window at ts. All units are fixed grids (R50):
// hour windows align to the epoch in n-hour steps, day/week windows to the
// owner timezone in n-day / n-week steps — a 2-day window does not restart
// every midnight, it belongs to a stable grid. Fixed-length spans across DST
// shifts are a documented approximation (design doc §9).
function laneWindowOf(lane, ts = now(), offsetMinutes = serverOffsetMinutes()) {
  const spec = lane.window || { unit: "day", n: 1 };
  const n = Math.max(1, Number(spec.n) || 1);
  if (spec.unit === "hour") {
    const span = n * 3_600_000;
    const start = Math.floor(ts / span) * span;
    return { key: `h${n}:${start}`, startMs: start, endMs: start + span };
  }
  const day = Math.floor((ts + offsetMinutes * 60_000) / 86_400_000); // anchor-tz epoch day
  if (spec.unit === "week") {
    const weekIdx = Math.floor((day + 3) / 7); // epoch day 0 = Thursday → Monday-aligned weeks
    const startIdx = Math.floor(weekIdx / n) * n;
    const start = (startIdx * 7 - 3) * 86_400_000 - offsetMinutes * 60_000;
    return { key: `week:${anchorDayString(start, offsetMinutes)}`, startMs: start, endMs: start + n * 7 * 86_400_000 };
  }
  const startIdx = Math.floor(day / n) * n;
  const start = startIdx * 86_400_000 - offsetMinutes * 60_000;
  return { key: `day:${anchorDayString(start, offsetMinutes)}`, startMs: start, endMs: start + n * 86_400_000 };
}

// YYYY-MM-DD of an epoch ms rendered in the anchor timezone (UTC getters on
// the shifted instant).
function anchorDayString(ts, offsetMinutes) {
  const d = new Date(ts + offsetMinutes * 60_000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function minutesOfDayAt(ts, offsetMinutes) {
  const shifted = ts + offsetMinutes * 60_000;
  return Math.floor((shifted % 86_400_000) / 60_000);
}

function tzLabelOf(offsetMinutes) {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

const inWindow = (m, w) => (w.startM < w.endM
  ? m >= w.startM && m < w.endM
  : m >= w.startM || m < w.endM); // wraps midnight

function scheduleStateAt(lane, ts, offsetMinutes = serverOffsetMinutes()) {
  if (!lane.scheduleWindows.length) return { open: true, nextChangeMs: 0 };
  const m = minutesOfDayAt(ts, offsetMinutes);
  const open = lane.scheduleWindows.some((w) => inWindow(m, w));
  // next boundary: scan forward minute by minute (≤1440 iterations, called on
  // claim/directory paths only — the hot request path lives in the plugin)
  for (let i = 1; i <= 1440; i += 1) {
    const mm = (m + i) % 1440;
    const nowOpen = lane.scheduleWindows.some((w) => inWindow(mm, w));
    if (nowOpen !== open) return { open, nextChangeMs: ts + i * 60_000 };
  }
  return { open, nextChangeMs: 0 };
}

function peakActiveAt(lane, ts, offsetMinutes = serverOffsetMinutes()) {
  if (!lane.peakWindows.length || lane.peakMultiplier <= 1) return false;
  const m = minutesOfDayAt(ts, offsetMinutes);
  return lane.peakWindows.some((w) => inWindow(m, w));
}

function laneLedgerOf(share, laneId) {
  share.laneSettled = share.laneSettled || {};
  return share.laneSettled[laneId] || { windowKey: "", tokens: 0, byKey: {} };
}

// Roll the lane window and settle tokens (peak multiplier applied when the
// usage event falls inside a peak window). Returns the applied delta.
// Owner-machine tz (minutes east of UTC), reported by the CPA plugin each
// heartbeat. Gates execute on the owner machine, so the owner tz is the
// authoritative anchor for schedule/day/week windows; the server-local
// fallback keeps legacy (plugin-not-reporting / between-heartbeat) behavior.
function tzOf(share) {
  const value = Number(share && share.tzOffsetMinutes);
  if (!Number.isFinite(value)) return serverOffsetMinutes();
  return Math.max(-840, Math.min(840, Math.round(value)));
}

function settleLaneUsage(share, lane, keyId, tokens, ts = now()) {
  const window = laneWindowOf(lane, ts, tzOf(share));
  const ledger = laneLedgerOf(share, lane.id);
  if (ledger.windowKey !== window.key) {
    ledger.windowKey = window.key;
    ledger.tokens = 0;
    ledger.byKey = {};
  }
  const applied = peakActiveAt(lane, ts, tzOf(share))
    ? Math.max(1, Math.round(tokens * lane.peakMultiplier))
    : tokens;
  ledger.tokens += applied;
  ledger.byKey[keyId] = (ledger.byKey[keyId] || 0) + applied;
  share.laneSettled[lane.id] = ledger;
  return applied;
}

export function createSharingCpa({ dataDir, initial, persistState, verifyIdentity, claimRatePerMinute } = {}) {
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

  const laneSlotsLeft = (shareId, laneId, maxClaims) =>
    Math.max(0, maxClaims - activeClaimsOf(shareId).filter((c) => (c.laneId || "default") === laneId).length);

  // Public/directory view of a lane: no secrets, no byKey detail. Schedule
  // and peak ride along so the owner card can edit and borrowers can see
  // when the lane opens (transparency over obscurity).
  const hhmmOf = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  function lanePublicView(share, lane, ts = now()) {
    const tz = tzOf(share);
    const window = laneWindowOf(lane, ts, tz);
    const ledger = laneLedgerOf(share, lane.id);
    const settled = ledger.windowKey === window.key ? ledger.tokens : 0;
    const schedule = scheduleStateAt(lane, ts, tz);
    const closed = lane.state !== "active" || !schedule.open;
    return {
      id: lane.id,
      title: lane.title,
      models: lane.models,
      window: lane.window,
      budgetTokens: lane.budgetTokens,
      settledTokens: settled,
      availableTokens: Math.max(0, lane.budgetTokens - settled),
      exhausted: lane.state === "active" && schedule.open && settled >= lane.budgetTokens,
      state: lane.state,
      open: lane.state === "active" && schedule.open,
      retryAfterMs: closed ? Math.max(0, schedule.nextChangeMs - ts) : 0,
      slotsLeft: laneSlotsLeft(share.shareId, lane.id, lane.maxClaims),
      maxClaims: lane.maxClaims,
      windowEndsAtMs: window.endMs,
      // Borrower-facing anchor label ("UTC+8"): schedule times are owner-tz
      // because that is where the gates execute.
      tzLabel: tzLabelOf(tz),
      schedule: lane.scheduleWindows.map((w) => ({ start: hhmmOf(w.startM), end: hhmmOf(w.endM) })),
      peak: {
        windows: lane.peakWindows.map((w) => ({ start: hhmmOf(w.startM), end: hhmmOf(w.endM) })),
        multiplier: lane.peakMultiplier,
      },
    };
  }

  // Sync view for the CPA plugin: schedule/peak ride as minute-of-day marks
  // so the plugin gates locally without duplicating timezone math.
  function laneSyncView(share, lane, ts = now()) {
    const tz = tzOf(share);
    const window = laneWindowOf(lane, ts, tz);
    const ledger = laneLedgerOf(share, lane.id);
    const settled = ledger.windowKey === window.key ? ledger.tokens : 0;
    return {
      id: lane.id,
      state: lane.state,
      models: lane.models,
      budgetTokens: lane.budgetTokens,
      window: lane.window,
      windowKey: window.key,
      windowStartMs: window.startMs,
      windowEndMs: window.endMs,
      settledTokens: settled,
      scheduleWindows: lane.scheduleWindows.map((w) => ({ startM: w.startM, endM: w.endM })),
      peakWindows: lane.peakWindows.map((w) => ({ startM: w.startM, endM: w.endM })),
      peakMultiplier: lane.peakMultiplier,
    };
  }

  function publicShareView(share) {
    const online = now() - (share.lastHeartbeatAt || 0) < HEARTBEAT_ONLINE_MS;
    const settled = windowSettled(share);
    const available = Math.max(0, share.policy.budget - settled);
    const ts = now();
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
      lanes: effectiveLanes(share).map((lane) => lanePublicView(share, lane, ts)),
    };
  }

  function claimView(claim, { withToken = false } = {}) {
    const view = {
      keyId: claim.keyId,
      shareId: claim.shareId,
      laneId: claim.laneId || "default",
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
    const ts = now();
    const lanes = effectiveLanes(share);
    // Legacy settledByKey stays a flat keyId→tokens map (merged across lane
    // ledgers' current windows) so pre-lane plugins keep working unchanged.
    const settledByKey = {};
    for (const lane of lanes) {
      const window = laneWindowOf(lane, ts, tzOf(share));
      const ledger = laneLedgerOf(share, lane.id);
      if (ledger.windowKey !== window.key) continue;
      for (const [keyId, tokens] of Object.entries(ledger.byKey || {})) {
        settledByKey[keyId] = (settledByKey[keyId] || 0) + tokens;
      }
    }
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
        laneId: c.laneId || "default",
      })),
      settledByKey,
      lanes: lanes.map((lane) => laneSyncView(share, lane, ts)),
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
    return entry.hits <= (claimRatePerMinute || CLAIM_RATE_PER_MINUTE);
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
    // Participant-idempotent rebind (R51-3): without this, every re-register
    // after a backend switch mints a duplicate share. A signed register from
    // an owner who already has an active share rebinds to it (returns the
    // original credentials); stopped/suspended shares are never rebound —
    // unregister then register stays the explicit fresh-start door.
    const ownedActive = existing ? null : Object.values(db.shares)
      .filter((s) => s.participantId === String(body.participantId) && s.state === "active")
      .sort((a, b) => a.createdAt - b.createdAt)[0] || null;
    let share = existing || ownedActive;
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
    } else if (share.state === "stopped") {
      // Owner-initiated stop is reversible: a signed register with the same
      // secret is an explicit intent to share again. Admin suspension
      // ("suspended") is NOT overridden here.
      share.state = "active";
    }
    share.title = String(body.title || "CPA share").slice(0, 60) || "CPA share";
    share.baseURL = String(body.baseURL || "").trim().slice(0, 200);
    share.models = Array.isArray(body.models) && body.models.length
      ? body.models.map((m) => String(m).slice(0, 80)).slice(0, 50)
      : ["*"];
    share.policy = clampPolicy({ ...share.policy, ...(body.policy || {}) });
    const lanes = clampLanes(body.lanes);
    if (lanes) share.lanes = lanes;
    share.updatedAt = now();
    share.participantId = String(body.participantId);
    share.ownerDisplayId = String(owner.displayId || "");
    share.ownerNickname = String(owner.nickname || "");
    persist();
    sendJson(res, 200, {
      shareId: share.shareId,
      shareSecret: share.shareSecret,
      registered: true,
      rebind: Boolean(existing || ownedActive),
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
    const reportedTz = Number(body.tzOffsetMinutes);
    if (Number.isFinite(reportedTz)) {
      share.tzOffsetMinutes = Math.max(-840, Math.min(840, Math.round(reportedTz)));
    }
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
    const lanes = effectiveLanes(share);
    const ts = now();
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
      claim.lastUsedAt = ts;
      share.settled[keyId] = (share.settled[keyId] || 0) + tokens;
      share.lifetimeSettled = (share.lifetimeSettled || 0) + tokens;
      const laneId = claim.laneId || "default";
      const lane = lanes.find((l) => l.id === laneId);
      if (lane) settleLaneUsage(share, lane, keyId, tokens, ts);
      applied += 1;
    }
    // Wall signal (advisory): owner-side failures observed by the plugin. No
    // automatic action — the owner card surfaces it as a one-click lane pause.
    const wallFailed = Math.max(0, Number(body.wallSignals && body.wallSignals.ownerFailed) || 0);
    if (wallFailed > 0) {
      share.wallSignal = {
        at: ts,
        ownerFailed: (share.wallSignal && share.wallSignal.ownerFailed || 0) + wallFailed,
      };
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
        wallSignal: share.wallSignal || null,
      },
      claims,
    });
  }

  // Replace/patch the lane set. A lane flipped away from "active" suspends:
  // its valid claims are revoked (same cascade semantics as share suspend).
  // A lane REMOVED from the set cascades the same way — the card's delete
  // dialog promises "revoke its claim keys" — and its settled ledger is
  // dropped so a same-id recreation starts from a clean window. Applying a
  // lanes update also clears the wall signal: the owner just acted on it.
  function applyLanesUpdate(share, input) {
    const lanes = clampLanes(input);
    if (!lanes) return { ok: false, error: "invalid_lanes" };
    const ts = now();
    const keptIds = new Set(lanes.map((lane) => lane.id));
    for (const lane of lanes) {
      if (lane.state === "active") continue;
      for (const claim of Object.values(db.claims)) {
        if (claim.shareId === share.shareId && (claim.laneId || "default") === lane.id && claim.state === "valid") {
          claim.state = "revoked";
        }
      }
    }
    for (const claim of Object.values(db.claims)) {
      if (claim.shareId === share.shareId && claim.state === "valid" && !keptIds.has(claim.laneId || "default")) {
        claim.state = "revoked";
      }
    }
    if (share.laneSettled) {
      for (const laneId of Object.keys(share.laneSettled)) {
        if (!keptIds.has(laneId)) delete share.laneSettled[laneId];
      }
    }
    share.wallSignal = null;
    share.lanes = lanes;
    share.updatedAt = ts;
    return { ok: true };
  }

  async function handleOwnerPolicy(req, res, body) {
    const share = findShareBySecret(req.headers["x-atl-share-secret"]);
    if (!share) {
      sendJson(res, 404, { error: "share_not_found" });
      return;
    }
    if (Array.isArray(body.lanes)) {
      const result = applyLanesUpdate(share, body.lanes);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return;
      }
    }
    share.policy = clampPolicy({ ...share.policy, ...(body.policy || body) });
    share.updatedAt = now();
    persist();
    sendJson(res, 200, { policy: share.policy, lanes: effectiveLanes(share).map((lane) => lanePublicView(share, lane)) });
  }

  async function handleOwnerResume(req, res) {
    const share = findShareBySecret(req.headers["x-atl-share-secret"]);
    if (!share) {
      sendJson(res, 404, { error: "share_not_found" });
      return;
    }
    if (share.state === "suspended") {
      // Admin-controlled state: the owner cannot lift a suspension.
      sendJson(res, 409, { error: "share_suspended" });
      return;
    }
    share.state = "active";
    share.updatedAt = now();
    persist();
    sendJson(res, 200, { shareId: share.shareId, state: share.state });
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
    const activeMine = Object.values(db.claims).filter(
      (c) => c.state === "valid" && c.participantId === String(body.participantId || ""),
    ).length;
    if (body.participantId && activeMine >= MAX_ACTIVE_CLAIMS_PER_BORROWER) {
      sendJson(res, 409, {
        error: "too_many_active_claims",
        active: activeMine,
        max: MAX_ACTIVE_CLAIMS_PER_BORROWER,
      });
      return;
    }
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
    // Lane resolution (lanes design): a claim targets one lane. Omitting
    // laneId is only valid on single-lane (legacy) shares.
    const nowTs = now();
    const lanes = effectiveLanes(share);
    const laneOptions = lanes.map((l) => ({ id: l.id, title: l.title, models: l.models, window: l.window }));
    let lane = null;
    if (body.laneId) {
      lane = lanes.find((l) => l.id === String(body.laneId)) || null;
      if (!lane) {
        sendJson(res, 404, { error: "lane_not_found", lanes: laneOptions });
        return;
      }
    } else if (lanes.length === 1) {
      lane = lanes[0];
    } else {
      sendJson(res, 409, { error: "lane_required", lanes: laneOptions });
      return;
    }
    if (lane.state !== "active") {
      sendJson(res, 409, { error: "lane_suspended", laneId: lane.id });
      return;
    }
    const schedule = scheduleStateAt(lane, nowTs, tzOf(share));
    if (!schedule.open) {
      sendJson(res, 409, { error: "lane_closed", laneId: lane.id, retryAfterMs: Math.max(0, schedule.nextChangeMs - nowTs) });
      return;
    }
    const window = laneWindowOf(lane, nowTs, tzOf(share));
    const ledger = laneLedgerOf(share, lane.id);
    const laneSettled = ledger.windowKey === window.key ? ledger.tokens : 0;
    // Legacy single-lane shares keep the historical error code so old
    // borrower cards still map it to a friendly message.
    const exhaustedError = (share.lanes && share.lanes.length) ? "lane_exhausted" : "budget_exhausted";
    if (laneSettled >= lane.budgetTokens) {
      sendJson(res, 409, { error: exhaustedError, laneId: lane.id, retryAfterMs: Math.max(0, window.endMs - nowTs) });
      return;
    }
    if (laneSlotsLeft(share.shareId, lane.id, lane.maxClaims) <= 0) {
      sendJson(res, 409, { error: "no_claim_slots", laneId: lane.id });
      return;
    }
    const participant = identity.participant || {};
    const claim = {
      keyId: randomId("csk_", 8),
      shareId: share.shareId,
      laneId: lane.id,
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
      laneId: lane.id,
      laneTitle: lane.title,
      models: lane.models,
      window: lane.window,
      tzLabel: tzLabelOf(tzOf(share)),
      laneBudgetTokens: lane.budgetTokens,
      expiresAt: claim.expiresAt,
      shareTitle: share.title,
      keyMaxTokens: Math.min(share.policy.keyMaxTokens, lane.budgetTokens),
      borrower: claim.borrower,
      displayId: claim.displayId,
    });
  }

  async function handleRevokeClaim(req, res, body) {
    pruneExpiredClaims();
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

  // Renewal keeps the SAME key (G3): no slot churn, no client re-config — the
  // next heartbeat delivers the extended expiresAtMs to the owner plugin.
  async function handleRenewClaim(req, res, body) {
    // expired-but-not-yet-pruned claims must not resurrect via renewal
    pruneExpiredClaims();
    const token = String(body.token || "");
    const claim = Object.values(db.claims).find((c) => c.token === token && c.state === "valid");
    if (!claim) {
      sendJson(res, 404, { error: "claim_not_found" });
      return;
    }
    const share = db.shares[claim.shareId];
    if (!share || share.state !== "active") {
      sendJson(res, 409, { error: "share_not_active" });
      return;
    }
    claim.expiresAt = now() + share.policy.ttlHours * 3_600_000;
    persist();
    sendJson(res, 200, { renewed: claim.keyId, expiresAt: claim.expiresAt });
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
        // health columns (G4): why a share is offline is a local status.json
        // on the owner box — the server side reports heartbeat age + plugin
        // version + live claim pressure instead
        plugin: {
          online: now() - (s.lastHeartbeatAt || 0) <= HEARTBEAT_ONLINE_MS,
          version: s.lastPluginVersion || "",
          lastHeartbeatAt: s.lastHeartbeatAt || 0,
        },
        validClaims: activeClaimsOf(s.shareId).length,
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
    if (action === "claims-clear-ended") {
      // Purge every non-valid claim (revoked/expired) across all shares —
      // verification rounds and churn otherwise accumulate forever. Valid
      // keys are never touched.
      pruneExpiredClaims();
      let removed = 0;
      for (const [keyId, claim] of Object.entries(db.claims)) {
        if (claim.state !== "valid") {
          delete db.claims[keyId];
          removed += 1;
        }
      }
      persist();
      sendJson(res, 200, { removed });
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
      if (Array.isArray(body.lanes)) {
        const result = applyLanesUpdate(share, body.lanes);
        if (!result.ok) {
          sendJson(res, 400, { error: result.error });
          return;
        }
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
      if (p === "/api/shares/owner/resume" && req.method === "POST") return void await handleOwnerResume(req, res);
      if (p === "/api/shares" && req.method === "GET") return void await handleListShares(req, res);
      if (p === "/api/shares/claim" && req.method === "POST") return void await handleClaim(req, res, await readBody(req));
      if (p === "/api/shares/claims/revoke" && req.method === "POST") return void await handleRevokeClaim(req, res, await readBody(req));
      if (p === "/api/shares/claims/renew" && req.method === "POST") return void await handleRenewClaim(req, res, await readBody(req));
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

// Pure lane helpers exported for unit tests (window arithmetic, schedule
// truth tables, lane clamping) — see tests/run-tests.js testSharingLaneUnits.
export { clampLanes, clampLane, clampWindows, parseHHMM, effectiveLanes, laneWindowOf, scheduleStateAt, settleLaneUsage, peakActiveAt, weekStartTs, tzLabelOf, minutesOfDayAt };
