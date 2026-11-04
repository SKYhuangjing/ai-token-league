// Reads Magpie's unified usage over the gateway's own read API:
// GET /v1/magpie/usage/requests — the same JSON the built-in Usage page's
// Requests tab shows: gateway ledger rows PLUS every local agent session
// scan, already deduped by request id (source: "log" rows are the calls the
// gateway never saw). The endpoint answers this machine without a key; it
// was added for exactly this use case (third-party local apps reading
// magpie's usage — see internal/gateway/usage_api.go upstream).
//
// Loopback only, read-only, and the page sandbox's CSP never sees this:
// all fetching happens in the Bun host (sync.js), same as the uploads.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const GATEWAY_DEFAULT_PORT = 3425;
export const GATEWAY_PAGE_LIMIT = 500; // server caps limit at 500
const GATEWAY_MAX_PAGES = 2000; // a runaway pager never loops forever

export class GatewayError extends Error {
  constructor(message) {
    super(message);
    this.name = "GatewayError";
  }
}

/**
 * Where the gateway listens. Precedence: MAGPIE_GATEWAY_URL (tests and
 * explicit override) → MAGPIE_ADDR (what magpie itself honours) → the
 * `port` field of ~/.config/magpie/settings.json → the default port.
 */
export function resolveGatewayBaseUrl(env = process.env) {
  const direct = env.MAGPIE_GATEWAY_URL || env.MAGPIE_ADDR;
  if (direct) {
    // the host hands its children MAGPIE_ADDR as "127.0.0.1:3425" — no
    // scheme. Treat a scheme-less host[:port] as http, refuse real garbage.
    const spelled = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(direct) ? direct : `http://${direct}`;
    try {
      const url = new URL(spelled);
      if (!url.hostname) throw new Error("no host");
      return `${url.protocol}//${url.hostname}:${url.port || GATEWAY_DEFAULT_PORT}`;
    } catch {
      throw new GatewayError(`MAGPIE_GATEWAY_URL/MAGPIE_ADDR is not an address: ${direct}`);
    }
  }
  let port = GATEWAY_DEFAULT_PORT;
  try {
    const settings = JSON.parse(
      readFileSync(join(env.HOME || process.env.HOME || "~", ".config", "magpie", "settings.json"), "utf8")
    );
    if (Number.isInteger(settings?.port) && settings.port > 0) port = settings.port;
  } catch {
    // no settings file / no port field — the default stands
  }
  return `http://127.0.0.1:${port}`;
}

/** The period value for a window of days: presets where they exist, else all. */
export function windowPeriod(days) {
  if (days === 1) return "today";
  if (days === 7) return "7d";
  if (days === 30) return "30d";
  return "all";
}

/**
 * Fetches every row of a period, page by page (newest first, but order is
 * irrelevant to bucketing). Gives up loudly on anything but a well-shaped
 * answer — a half-read history must never become a half-uploaded one.
 */
export async function fetchGatewayUsage({ baseUrl, period = "7d", signal } = {}) {
  if (!baseUrl) throw new GatewayError("fetchGatewayUsage requires baseUrl");
  const rows = [];
  let total = null;
  let through;
  let direct;
  let offset = 0;
  for (let page = 0; page < GATEWAY_MAX_PAGES; page += 1) {
    const url = `${baseUrl}/v1/magpie/usage/requests?period=${encodeURIComponent(period)}&offset=${offset}&limit=${GATEWAY_PAGE_LIMIT}`;
    let res;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: signal || AbortSignal.timeout(15_000)
      });
    } catch (error) {
      throw new GatewayError(`gateway usage API unreachable (${error.name || "error"}: ${error.message})`);
    }
    if (!res.ok) throw new GatewayError(`gateway usage API answered HTTP ${res.status}`);
    let body;
    try {
      body = await res.json();
    } catch {
      throw new GatewayError("gateway usage API answered non-JSON");
    }
    if (!body || !Array.isArray(body.rows)) {
      throw new GatewayError("gateway usage API shape drift: no rows array (upstream format changed?)");
    }
    rows.push(...body.rows);
    total = Number.isFinite(Number(body.total)) ? Number(body.total) : rows.length;
    if (through === undefined && body.through) through = body.through;
    if (direct === undefined && body.direct) direct = body.direct;
    offset += body.rows.length;
    if (body.rows.length === 0 || offset >= total) break;
  }
  if (total !== null && rows.length !== total) {
    throw new GatewayError(`gateway usage API paging incomplete: ${rows.length}/${total} rows read`);
  }
  return { rows, total, through, direct };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * API rows → the ledger-row shape the rest of the pipeline speaks
 * (t/agent/model/in/out/cache_read/cache_write/reasoning). Only fields the
 * pipeline needs are carried on: session ids, accounts and other PII the
 * API also names are dropped here and never reach state or logs.
 */
export function apiRowsToRows(apiRows) {
  const rows = [];
  for (const r of apiRows || []) {
    if (!r || typeof r !== "object") continue;
    rows.push({
      t: r.t,
      agent: String(r.agent ?? ""),
      provider: String(r.provider ?? ""),
      model: String(r.model || r.served || ""),
      in: num(r.in),
      out: num(r.out),
      cache_read: num(r.cache_read),
      cache_write: num(r.cache_write),
      reasoning: num(r.reasoning),
      status: num(r.status),
      cost: num(r.cost),
      source: String(r.source || ""),
      callerKeyId: String(r.callerKeyId || r.callerKey || r.caller_key_id || "")
    });
  }
  return rows;
}

/**
 * Integrity fuse for API rows: parseable timestamps and non-negative token
 * fields. (route_id / response_id uniqueness is a ledger-file concern; the
 * API's rows are already deduped upstream.)
 */
export function gatewayIntegrity(rows) {
  const issues = [];
  for (const row of rows) {
    if (Number.isNaN(new Date(row.t).getTime())) {
      issues.push(`row with unparseable timestamp: ${JSON.stringify(row.t)}`);
      continue;
    }
    for (const field of ["in", "out", "cache_read", "cache_write"]) {
      if (Number(row[field]) < 0) issues.push(`row with negative ${field} (${row[field]}, t=${row.t})`);
    }
  }
  return { ok: issues.length === 0, issues };
}
