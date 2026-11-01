// ATL cloud protocol client: device registration (heartbeat) and hourly
// bucket snapshot upload. Bucket replace semantics make every upload
// idempotent, so retries are always safe.
import pkg from "../package.json" with { type: "json" };
import { computeBucketFingerprint, signPayload } from "./atl.js";

export const MAX_BATCH_BUCKETS = 25;
// A full-history backfill is ~90 batches, and the slowest single batch on a
// shared dev MySQL measured ~100s of server processing — the client ceiling
// must sit above the server's worst case or every retry just piles more
// work onto the same wedged batch.
const FETCH_TIMEOUT_MS = 180_000;

function pluginVersion() {
  return pkg.version || "0.0.0";
}

export function clientInfo() {
  return {
    clientAppVersion: pluginVersion(),
    clientProtocolVersion: 2,
    clientPlatform: "magpie-plugin",
    clientBuild: `magpie-bun-${pluginVersion()}`,
    runtime: "bun",
    os: `${process.platform}-${process.arch}`
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, ok: response.ok, body };
}

export async function checkHealth(apiBaseUrl) {
  const { status, ok, body } = await fetchJson(`${apiBaseUrl.replace(/\/+$/, "")}/api/health`);
  return { status, ok, body };
}

export async function registerDevice({ apiBaseUrl, identity }) {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const payload = {
    participantId: identity.participantId,
    nickname: identity.nickname,
    deviceId: identity.deviceId,
    identityPublicKey: identity.identityPublicKey,
    os: `${process.platform}-${process.arch}`,
    appVersion: pluginVersion(),
    client: clientInfo()
  };
  const { status, ok, body } = await fetchJson(`${base}/api/devices/register`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (!ok) {
    const detail = body && body.error ? body.error : JSON.stringify(body);
    throw new Error(`register failed (HTTP ${status}): ${detail}`);
  }
  return body;
}

/** Builds one bucket's {snapshot, items} pair with locally recomputed fingerprint. */
export function buildBucketBatch(bucket) {
  const items = bucket.items;
  if (!items.length) throw new Error(`empty bucket ${bucket.day}|${bucket.hour}|${bucket.providerId}`);
  const fingerprint = computeBucketFingerprint(items);
  const totalTokens = items.reduce((sum, item) => sum + item.totalTokens, 0);
  return {
    snapshot: {
      mode: "device_day_hour_provider",
      day: bucket.day,
      hour: bucket.hour,
      providerId: bucket.providerId,
      bucketFingerprint: fingerprint,
      rowCount: items.length,
      totalTokens
    },
    items
  };
}

function uploadBody(identity, batchesOrSnapshot, items) {
  const clientGeneratedAt = new Date().toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
  const payload = {
    participantId: identity.participantId,
    deviceId: identity.deviceId,
    clientGeneratedAt,
    client: clientInfo(),
    ...(Array.isArray(batchesOrSnapshot) ? { batches: batchesOrSnapshot } : { snapshot: batchesOrSnapshot })
  };
  if (items) payload.items = items;
  return { ...payload, signature: signPayload(identity.identityPrivateKey, payload) };
}

function bucketAccepted(result, batch) {
  if (!result || result.failed) return false;
  if (result.duplicate || result.noOp) return true;
  return result.accepted === batch.snapshot.rowCount && (result.rejected ?? 0) === 0;
}

/**
 * Uploads buckets in batches of at most MAX_BATCH_BUCKETS. Falls back to the
 * single-bucket route when the batch route is unavailable (404/405/501).
 * onProgress(chunk) fires after each chunk the server took, so the caller
 * can checkpoint; every upload is idempotent, so a timeout retried from the
 * last checkpoint never double-counts.
 */
export async function uploadBuckets({ apiBaseUrl, identity, buckets, onProgress }) {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const batches = buckets.map(buildBucketBatch);
  const results = [];
  for (let offset = 0; offset < batches.length; offset += MAX_BATCH_BUCKETS) {
    const chunk = batches.slice(offset, offset + MAX_BATCH_BUCKETS);
    const send = () =>
      fetchJson(`${base}/api/usage/daily-batches`, {
        method: "POST",
        body: JSON.stringify(uploadBody(identity, chunk))
      });
    // one retry on a timeout or a transient network failure: replace
    // semantics make a re-sent batch safe
    let response;
    try {
      response = await send();
    } catch (error) {
      response = await send(); // throws for good on the second failure
    }
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      // legacy server without the batch route: one bucket per request
      for (const batch of chunk) {
        const single = await fetchJson(`${base}/api/usage/daily-batch`, {
          method: "POST",
          body: JSON.stringify(uploadBody(identity, batch.snapshot, batch.items))
        });
        if (!single.ok) {
          const detail = single.body && single.body.error ? single.body.error : JSON.stringify(single.body);
          throw new Error(`daily-batch upload failed (HTTP ${single.status}): ${detail}`);
        }
        results.push({ bucket: batch, response: single.body });
      }
      continue;
    }
    if (!response.ok) {
      const detail = response.body && response.body.error ? response.body.error : JSON.stringify(response.body);
      throw new Error(`daily-batches upload failed (HTTP ${response.status}): ${detail}`);
    }
    const bodyResults = (response.body && Array.isArray(response.body.results)) ? response.body.results : [];
    if (bodyResults.length !== chunk.length) {
      // A 200 without one result per bucket must not be treated as success —
      // that would mark unverified buckets as synced in the manifest.
      throw new Error(
        `daily-batches response missing per-bucket results (got ${bodyResults.length}, expected ${chunk.length}) — refusing to trust this upload`
      );
    }
    bodyResults.forEach((result, index) => {
      const batch = chunk[index];
      if (batch && !bucketAccepted(result, batch)) {
        const detail = result && result.error ? result.error : JSON.stringify(result);
        throw new Error(`bucket ${batch.snapshot.day}|${batch.snapshot.hour}|${batch.snapshot.providerId} rejected: ${detail}`);
      }
    });
    results.push({ chunk, response: response.body });
    if (onProgress) onProgress(chunk);
  }
  return results;
}
