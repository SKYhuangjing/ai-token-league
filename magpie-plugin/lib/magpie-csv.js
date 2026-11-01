// The whole-history channel: `magpie usage --csv all` streams the same
// unified, request-id-deduped rows the gateway API pages through (gateway
// ledger + every local agent session scan) as ONE CSV — ~236k rows in
// ~2.5s, where the JSON API's 500-row pages take minutes at that depth.
// The CSV is a user-facing export ("set it beside a vendor's bill"), and
// running the CLI beside the app is safe: it only reads.
//
// Only the columns the pipeline needs are ever read out of it; session ids,
// accounts and hosts ride along in the file but are dropped at parse time.
import { existsSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";

export class CsvError extends Error {
  constructor(message) {
    super(message);
    this.name = "CsvError";
  }
}

// MAGPIE_BIN wins ("none" disables this channel — tests use it); then the
// shell shim the app installs, then the usual bundle locations.
const CANDIDATES = [
  () => process.env.MAGPIE_BIN,
  () => join(process.env.HOME || "~", ".local", "bin", "magpie"),
  () => "/Applications/magpie.app/Contents/MacOS/magpie",
  () => "/usr/local/bin/magpie",
  () => "/opt/homebrew/bin/magpie"
];

export function findMagpieBinary() {
  if (process.env.MAGPIE_BIN === "none") return null;
  for (const pick of CANDIDATES) {
    const path = pick();
    if (!path || !existsSync(path)) continue;
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not executable — keep looking
    }
  }
  return null;
}

/** Runs `magpie usage --csv <period>` and answers its stdout. `period` is a
 * preset ("all"|"today"|"7d"|"30d") or {days:N} for a rolling window —
 * history is immutable, so routine syncs read only the window. */
export function runUsageCsv({ binary, period = "all", timeoutMs = 180_000 } = {}) {
  if (!binary) throw new CsvError("runUsageCsv requires a binary path");
  const periodArgs = period && typeof period === "object" && Number.isFinite(period.days)
    ? ["--csv", "--days", String(Math.max(1, Math.floor(period.days)))]
    : ["--csv", String(period)];
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      ["usage", ...periodArgs],
      { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          const why = error.killed ? `timed out after ${timeoutMs}ms` : error.message;
          reject(new CsvError(`magpie usage --csv failed: ${why}`));
          return;
        }
        resolve(stdout);
      }
    );
    child.stdin?.end();
  });
}

// Columns the pipeline consumes, by header name (order-independent: the
// header row is mapped, never assumed).
const NEEDED = [
  "time",
  "agent",
  "requested_model",
  "provider",
  "model",
  "served_model",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "cost_usd",
  "status",
  "source",
  "rejected"
];

// RFC 4180 record parser: quoted fields may hold commas, quotes (doubled)
// and newlines. Returns arrays of fields, one per record.
function* csvRecords(text) {
  let field = "";
  let record = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      record.push(field);
      field = "";
      if (record.length > 1 || record[0] !== "") yield record;
      record = [];
    } else field += ch;
  }
  if (field !== "" || record.length) {
    record.push(field);
    if (record.length > 1 || record[0] !== "") yield record;
  }
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Parses the CSV into ledger-shaped rows (t/agent/provider/model/…), the
 * same shape the gateway API mapper produces. `rejected` rows (the usage
 * pages' own exclusion) are dropped here. Shape drift refuses loudly.
 */
export function parseUsageCsv(text) {
  const records = csvRecords(String(text || ""));
  const head = records.next();
  if (head.done || !Array.isArray(head.value)) {
    throw new CsvError("usage CSV is empty — no header row");
  }
  const index = new Map(head.value.map((name, i) => [name, i]));
  const missing = NEEDED.filter((name) => !index.has(name));
  if (missing.length) {
    throw new CsvError(`usage CSV shape drift: missing columns ${missing.join(", ")}`);
  }
  const at = (row, name) => row[index.get(name)] ?? "";
  const rows = [];
  let rejected = 0;
  for (const row of records) {
    if (at(row, "rejected") === "true") {
      rejected += 1;
      continue;
    }
    rows.push({
      t: at(row, "time"),
      agent: at(row, "agent"),
      provider: at(row, "provider"),
      model: at(row, "requested_model") || at(row, "model") || at(row, "served_model"),
      in: num(at(row, "input_tokens")),
      out: num(at(row, "output_tokens")),
      cache_read: num(at(row, "cache_read_tokens")),
      cache_write: num(at(row, "cache_write_tokens")),
      reasoning: num(at(row, "reasoning_tokens")),
      cost: num(at(row, "cost_usd")),
      status: num(at(row, "status")),
      source: at(row, "source")
    });
  }
  return { rows, rejected };
}
