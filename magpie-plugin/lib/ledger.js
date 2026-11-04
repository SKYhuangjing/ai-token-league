// Reads the Magpie gateway ledger (~/.config/magpie/usage.jsonl), validates
// it, and aggregates rows into ATL hourly buckets. The ledger is Magpie's
// internal format (no upstream compat promise): we shape-check it and fail
// loud instead of silently misreporting.
import { localDayAndHour, normalizeUsageModel, buildPublicUsageItem, virtualWorkdirHash } from "./atl.js";

// agent (client tool that made the request) -> ATL providerId/toolCode.
// Attribution is by CLIENT, matching how ATL's local collectors attribute
// usage (a ZCode request borrowing a codex model is zcode usage, not codex).
// Magpie's session scans name the same agents the gateway ledger does, plus
// the ones only local session files record (kimi, workbuddy, dsh, hermes).
export const AGENT_PROVIDER_MAP = {
  zcode: { providerId: "zcode_local", toolCode: "zcode" },
  claude: { providerId: "claude_code_local", toolCode: "claude_code" },
  codex: { providerId: "codex_local", toolCode: "codex" },
  opencode: { providerId: "opencode_local", toolCode: "opencode" },
  kimi: { providerId: "kimi_local", toolCode: "kimi" },
  workbuddy: { providerId: "workbuddy_local", toolCode: "workbuddy" },
  dsh: { providerId: "dsh_local", toolCode: "dsh" },
  hermes: { providerId: "hermes_local", toolCode: "hermes" }
};

// magpie's own UI plus anything we cannot map (scripts, future clients) lands
// in the dedicated magpie_local source — traffic ATL never measured before.
export const MAGPIE_FALLBACK = { providerId: "magpie_local", toolCode: "magpie" };

/**
 * A row belongs to this computer's local usage if:
 * 1. It is from a local session log scan (source === 'log'), OR
 * 2. It is a gateway request without a caller key (callerKeyId is empty or 'none';
 *    loopback 127.0.0.1 requests made by local agents carry no key).
 * Requests carrying a gateway caller key (LAN callers, external API consumers)
 * belong to other callers using this gateway and are filtered out.
 */
export function isLocalUsage(row) {
  if (!row || typeof row !== "object") return false;
  const source = String(row.source ?? "").trim();
  if (source === "log") return true;
  const callerKey = String(row.callerKeyId || row.caller_key_id || row.callerKey || "").trim();
  return callerKey === "" || callerKey === "none";
}

/**
 * Filters rows to local callers only and partitions into supported vs skipped agents:
 * - Drops external caller rows (carrying a gateway caller key);
 * - Keeps mapped agents plus magpie's own;
 * - Counts unmapped agents out instead of folding them into magpie_local.
 */
export function partitionUploadRows(rows) {
  const keep = [];
  const skippedAgents = new Map();
  let skippedExternal = 0;
  for (const row of rows) {
    if (!isLocalUsage(row)) {
      skippedExternal += 1;
      continue;
    }
    const agent = String(row.agent ?? "").trim();
    if (AGENT_PROVIDER_MAP[agent] || agent === "magpie") keep.push(row);
    else skippedAgents.set(agent, (skippedAgents.get(agent) || 0) + 1);
  }
  return { rows: keep, skippedAgents, skippedExternal };
}

export const WORKDIR_NAME = "magpie";

export function mapAgent(agent) {
  return AGENT_PROVIDER_MAP[String(agent ?? "").trim()] || MAGPIE_FALLBACK;
}

export function rowTokenTotal(row) {
  return (
    (Number(row.in) || 0) +
    (Number(row.out) || 0) +
    (Number(row.cache_read) || 0) +
    (Number(row.cache_write) || 0)
  );
}

function isCountable(row) {
  if (!row || typeof row !== "object") return false;
  // Probes / capability listings carry no tokens by definition, but be explicit.
  if (row.kind === "model_list" || row.kind === "provider_test" || row.source === "probe") return false;
  return rowTokenTotal(row) > 0;
}

function rowModel(row) {
  const raw = row.req || row.model || row.served || `${row.provider || "unknown"}/other`;
  return normalizeUsageModel(raw);
}

/**
 * Parses the raw ledger text. The gateway appends to this file concurrently:
 * a truncated trailing line is normal and skipped. Individually malformed
 * lines are skipped and counted; if they exceed 5% the whole file is treated
 * as a format drift and we refuse loudly.
 */
export function parseLedger(text) {
  const lines = String(text || "").split("\n");
  const rows = [];
  let malformed = 0;
  let total = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    total += 1;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      malformed += 1;
      continue;
    }
    if (typeof row.t !== "string" || typeof row.agent !== "string" || !("in" in row || "out" in row)) {
      malformed += 1;
      continue;
    }
    rows.push(row);
  }
  const malformedRatio = total > 0 ? malformed / total : 0;
  // A single bad line (typical: truncated trailing line from a concurrent
  // append) never trips the fuse; systematic drift does.
  if ((malformed >= 2 && malformedRatio > 0.05) || (malformed >= 1 && malformedRatio > 0.5)) {
    throw new Error(
      `magpie ledger shape drift: ${malformed}/${total} lines malformed — refusing to sync (upstream format changed?)`
    );
  }
  return { rows, malformed, total };
}

/**
 * Integrity fuse for counted rows: every counted row needs a numeric
 * route_id, and upstream response ids must be unique — a duplicate
 * response_id would mean the same upstream response is recorded twice
 * (the only legit case is 0-token failed hand-over retries, which are
 * not counted). Duplicate counting is refused loudly.
 */
export function integrityCheck(rows) {
  const issues = [];
  const seenResponseIds = new Map();
  for (const row of rows) {
    if (!Number.isFinite(Number(row.route_id)) || Number(row.route_id) < 0) {
      issues.push(`row without valid route_id (t=${row.t})`);
      continue;
    }
    if (Number.isNaN(new Date(row.t).getTime())) {
      issues.push(`row with unparseable timestamp: ${JSON.stringify(row.t)}`);
      continue;
    }
    for (const field of ["in", "out", "cache_read", "cache_write"]) {
      if (Number(row[field]) < 0) {
        issues.push(`row with negative ${field} (${row[field]}, t=${row.t})`);
      }
    }
    if (typeof row.response_id === "string" && row.response_id) {
      if (seenResponseIds.has(row.response_id)) {
        issues.push(`duplicate response_id ${row.response_id} (t=${row.t} and t=${seenResponseIds.get(row.response_id)})`);
      } else {
        seenResponseIds.set(row.response_id, row.t);
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Aggregates ledger rows into hourly buckets keyed `day|hour|providerId`.
 * Each bucket value is a sorted list of ATL usage items (one per model,
 * whitelist-built). Rows before `sinceDay` (local) are skipped. When
 * `includeMagpieLocal` is false, rows that map to magpie_local are dropped.
 */
export function buildBuckets(rows, options = {}) {
  const {
    participantId,
    timeZone,
    sinceDay = "",
    includeMagpieLocal = true,
    rawSourceRef = "magpie:usage.jsonl",
    now = new Date()
  } = options;
  if (!participantId) throw new Error("buildBuckets requires participantId");
  const workdirHash = virtualWorkdirHash(WORKDIR_NAME, participantId);
  const buckets = new Map();
  const todayDay = localDayAndHour(now, timeZone).day;

  for (const row of rows) {
    if (!isCountable(row)) continue;
    const mapping = mapAgent(row.agent);
    if (mapping === MAGPIE_FALLBACK && !includeMagpieLocal) continue;
    const date = new Date(row.t);
    if (Number.isNaN(date.getTime())) continue; // integrityCheck reports this separately
    const { day, hour } = localDayAndHour(date, timeZone);
    if (day > todayDay) continue; // clock skew guard: never write future days
    if (sinceDay && day < sinceDay) continue;
    const key = `${day}|${hour}|${mapping.providerId}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { day, hour, providerId: mapping.providerId, toolCode: mapping.toolCode, byModel: new Map() };
      buckets.set(key, bucket);
    }
    const model = rowModel(row);
    let agg = bucket.byModel.get(model);
    if (!agg) {
      agg = {
        day,
        hour,
        toolCode: bucket.toolCode,
        providerId: bucket.providerId,
        workdirHash,
        workdirDisplayName: "Magpie",
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        sourceQuality: "exact",
        rawSourceRef
      };
      bucket.byModel.set(model, agg);
    }
    agg.inputTokens += Number(row.in) || 0;
    agg.outputTokens += Number(row.out) || 0;
    agg.cacheReadTokens += Number(row.cache_read) || 0;
    agg.cacheWriteTokens += Number(row.cache_write) || 0;
    agg.reasoningTokens += Number(row.reasoning) || 0;
  }

  const result = new Map();
  for (const [key, bucket] of buckets) {
    const items = [...bucket.byModel.values()]
      .map((agg) => buildPublicUsageItem(agg))
      .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
    result.set(key, { day: bucket.day, hour: bucket.hour, providerId: bucket.providerId, items });
  }
  return result;
}

/** First route_id in the ledger (rotation sentinel), or null when empty. */
export function firstRouteId(rows) {
  for (const row of rows) {
    const id = Number(row.route_id);
    if (Number.isFinite(id)) return id;
  }
  return null;
}
