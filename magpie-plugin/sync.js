#!/usr/bin/env bun
// ATL sync entry point. Runnable standalone (bun sync.js), spawned detached
// by hooks.js after gateway activity, and by the page's "sync now" command.
//
// Exit codes: 0 = success or no-op, 1 = error, 2 = busy (another sync holds
// the lock), 3 = ledger integrity refusal (never silent misreporting).
import { readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { appTimeZone, computeBucketFingerprint, localDayAndHour } from "./lib/atl.js";
import { parseLedger, buildBuckets, integrityCheck, firstRouteId, partitionUploadRows } from "./lib/ledger.js";
import {
  GatewayError,
  resolveGatewayBaseUrl,
  fetchGatewayUsage,
  apiRowsToRows,
  gatewayIntegrity,
  windowPeriod
} from "./lib/gateway.js";
import { CsvError, findMagpieBinary, runUsageCsv, parseUsageCsv } from "./lib/magpie-csv.js";
import { resolveIdentity, isValidIdentity } from "./lib/identity.js";
import { summarizeRows, mergeSummaries } from "./lib/usage-summary.js";
import { registerDevice, uploadBuckets, checkHealth } from "./lib/uploader.js";
import {
  readConfig,
  clearPluginOption,
  stateDir,
  readIdentity,
  identityPath,
  writeIdentity,
  writeConfig,
  configPath,
  readManifest,
  writeManifest,
  appendLog,
  withLock,
  writeStatus,
  readStatus,
  writeUsageData
} from "./lib/state.js";
import { fetchBoardRank, fetchMyIdentity } from "./lib/board-query.js";

import pkg from "./package.json" with { type: "json" };
const VERSION = pkg.version || "0.0.0";

function defaultLedgerPath() {
  return process.env.MAGPIE_LEDGER || join(process.env.HOME || "~", ".config", "magpie", "usage.jsonl");
}

// A failed run must reach the page too: without this the panel keeps showing
// the last successful state forever (doc/page-content-design.md §3.5). The
// previous nickname/rank ride along so one bad run never blanks the
// identity row. Dry-runs stay silent — they are diagnostics, not results.
function writeFailStatus(config, message, { dryRun = false } = {}) {
  if (dryRun) return;
  const prev = readStatus() || {};
  writeStatus({
    ...prev,
    ok: false,
    noop: false,
    error: String(message || "sync failed").slice(0, 200),
    apiBaseUrl: config?.apiBaseUrl || prev.apiBaseUrl || ""
  });
}

// The page sandbox has no network: the board rank travels as a snapshot in
// status.js, fetched once after each sync. A failure keeps the previous
// value (with the reason) and never changes the sync's own outcome.
async function enrichStatusWithRank(config, identity) {
  if (!config.apiBaseUrl || !identity?.participantId) return;
  const prev = readStatus() || {};
  try {
    const serverRank = await fetchBoardRank({ apiBaseUrl: config.apiBaseUrl, participantId: identity.participantId });
    writeStatus({ ...prev, serverRank });
  } catch (error) {
    writeStatus({
      ...prev,
      serverRank: { ...(prev.serverRank || {}), error: String(error.message || error).slice(0, 120) }
    });
  }
  // the anonymous board's daily display name, same snapshot discipline: a
  // failure keeps the previous value and never touches the sync outcome
  try {
    const serverIdentity = await fetchMyIdentity({ apiBaseUrl: config.apiBaseUrl, participantId: identity.participantId });
    const latest = readStatus() || prev;
    if (serverIdentity.identityMode === "anonymous") {
      writeStatus({ ...latest, serverIdentity });
    } else {
      // public board: no alias to show — clear any stale anonymous name
      const { serverIdentity: _drop, ...rest } = latest;
      writeStatus(rest);
    }
  } catch {
    // keep whatever the last successful fetch left in status
  }
}

// The page-summary cache holds the last FULL-history view under the state
// dir; windowed syncs overlay onto it so the page never loses history.
function summaryCachePath() {
  return join(stateDir(), "page-summary.json");
}
function readSummaryCache() {
  try {
    return JSON.parse(readFileSync(summaryCachePath(), "utf8"));
  } catch {
    return null;
  }
}
function writeSummaryCache(summary) {
  try {
    const tmp = `${summaryCachePath()}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(summary));
    renameSync(tmp, summaryCachePath());
  } catch {
    // best effort: a lost cache only forces one full read later
  }
}

function parseArgs(argv) {
  const args = { _: [], dryRun: false, once: false, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--once" || arg === "-1") args.once = true;
    else if (arg === "--verbose" || arg === "-v") args.verbose = true;
    else if (arg === "--api") args.api = argv[++i];
    else if (arg === "--ledger") args.ledger = argv[++i];
    else if (arg === "--source") args.source = argv[++i];
    else if (arg === "--window") args.windowDays = Number(argv[++i]);
    else if (arg === "--full") args.full = true;
    else if (arg === "--nickname") args.nickname = argv[++i];
    else if (arg === "--since-day") args.sinceDay = argv[++i];
    else if (arg === "--test-connection") args.testConnection = true;
    else if (arg === "--export-config") args.exportConfig = true;
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else args._.push(arg);
  }
  return args;
}

function usage() {
  return [
    "atl-sync — sync Magpie gateway usage into AI Token League",
    "",
    "  bun sync.js [--dry-run] [--api <url>] [--ledger <path>] [--nickname <name>]",
    "              [--since-day <YYYY-MM-DD>] [--source auto|gateway|ledger]",
    "              [--window <1|7|30>] [--full] [--test-connection]",
    "              [--export-config [--out <file>]] [-v]",
    "",
    "export-config writes the identity as an atl-magpie-migrate JSON (the",
    "same atl-magpie-migrate shape this plugin imports) for another install.",
    "",
    "Sources: gateway = Magpie's unified usage API (ledger + local session",
    "         scans, deduped; default), ledger = raw usage.jsonl fallback.",
    "",
    "Environment: MAGPIE_LEDGER (ledger path), MAGPIE_ATL_DIR (state dir),",
    "             MAGPIE_GATEWAY_URL (gateway API base, tests),",
    "             APP_TIME_ZONE / TZ (bucket timezone, same as ATL)."
  ].join("\n");
}

function printDryRun(buckets, dirtyKeys, identitySource, timeZone, sourceInfo) {
  const lines = [];
  lines.push(`atl-sync ${VERSION} dry-run (tz=${timeZone})`);
  lines.push(`identity source: ${identitySource}`);
  if (sourceInfo.kind === "gateway") {
    const channel = sourceInfo.channel === "csv" ? "csv (full history)" : `api ${sourceInfo.baseUrl}`;
    lines.push(
      `source: gateway ${channel} (${sourceInfo.total} rows` +
        (sourceInfo.through ? `, through ${sourceInfo.through.calls} calls` : "") +
        (sourceInfo.direct ? `, direct ${sourceInfo.direct.calls} calls` : "") +
        ")"
    );
  } else {
    lines.push(
      `source: ledger ${sourceInfo.path} (${sourceInfo.total} lines, ${sourceInfo.malformed} malformed/skipped, ${sourceInfo.counted} counted rows)`
    );
  }
  const totals = { buckets: buckets.size, tokens: 0 };
  const perDay = new Map();
  const perProvider = new Map();
  const sortedKeys = [...buckets.keys()].sort();
  for (const key of sortedKeys) {
    const bucket = buckets.get(key);
    const bucketTokens = bucket.items.reduce((sum, item) => sum + item.totalTokens, 0);
    totals.tokens += bucketTokens;
    perDay.set(bucket.day, (perDay.get(bucket.day) || 0) + bucketTokens);
    perProvider.set(bucket.providerId, (perProvider.get(bucket.providerId) || 0) + bucketTokens);
    const dirty = dirtyKeys.includes(key) ? " (dirty)" : "";
    const displayKey = key.replace(/\|(\d+)\|/, (_m, hour) => `|${String(hour).padStart(2, "0")}|`);
    lines.push(`  ${displayKey}  items=${bucket.items.length} tokens=${bucketTokens}${dirty}`);
  }
  lines.push("");
  lines.push(`total buckets: ${totals.buckets}, total tokens: ${totals.tokens}`);
  for (const [day, tokens] of [...perDay.entries()].sort()) lines.push(`  day ${day}: ${tokens}`);
  for (const [providerId, tokens] of [...perProvider.entries()].sort()) lines.push(`  source ${providerId}: ${tokens}`);
  lines.push(`dirty buckets to upload: ${dirtyKeys.length}`);
  lines.push("dry-run: nothing was uploaded");
  console.log(lines.join("\n"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const overrides = {};
  if (args.api) overrides.apiBaseUrl = args.api;
  if (args.nickname) overrides.nickname = args.nickname;
  if (args.sinceDay) overrides.sinceDay = args.sinceDay;
  const config = readConfig(overrides);

  if (config.sinceDay && !/^\d{4}-\d{2}-\d{2}$/.test(config.sinceDay)) {
    console.error(`atl-sync: invalid --since-day / sinceDay "${config.sinceDay}" — expected YYYY-MM-DD`);
    return 1;
  }

  if (args.testConnection) {
    if (!config.apiBaseUrl) {
      console.error('atl-sync: no API base URL configured — set it in the plugin page, options, config.json, or via --api');
      return 1;
    }
    try {
      const health = await checkHealth(config.apiBaseUrl);
      console.log(JSON.stringify({ apiBaseUrl: config.apiBaseUrl, status: health.status, ok: health.ok, body: health.body }, null, 2));
      return health.ok ? 0 : 1;
    } catch (error) {
      console.log(JSON.stringify({ apiBaseUrl: config.apiBaseUrl, ok: false, error: String(error && error.message ? error.message : error) }, null, 2));
      return 1;
    }
  }

  if (args.exportConfig) {
    // the same atl-magpie-migrate shape ATL exports: this plugin, ATL itself
    // and any other install of either can round-trip one identity
    let identity = null;
    try {
      identity = readIdentity();
    } catch (error) {
      console.error(`atl-sync: ${error.message}`);
      return 1;
    }
    if (!identity) {
      console.error("atl-sync: no identity yet — sync once (or import one) before exporting");
      return 1;
    }
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
    const out = args.out || join(process.env.HOME || "~", "Downloads", `atl-magpie-config-${stamp}.json`);
    const payload = {
      version: 1,
      kind: "atl-magpie-migrate",
      participantId: identity.participantId,
      nickname: identity.nickname || "",
      deviceId: identity.deviceId,
      apiBaseUrl: config.apiBaseUrl || "",
      identityPublicKey: identity.identityPublicKey,
      identityPrivateKey: identity.identityPrivateKey
    };
    if (!isValidIdentity(payload)) {
      console.error("atl-sync: stored identity is incomplete — refusing to export a broken config");
      return 1;
    }
    writeFileSync(out, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
    writeStatus({
      ...(readStatus() || {}),
      ok: true,
      error: null,
      participantId: identity.participantId,
      nickname: identity.nickname || "",
      deviceId: identity.deviceId,
      apiBaseUrl: config.apiBaseUrl || "",
      lastExport: { path: out, at: new Date().toISOString() }
    });
    console.log(`atl-sync: migration config written to ${out} (contains the identity private key — keep it on this machine)`);
    return 0;
  }

  // Page-submitted import (settings › 从 ATL 导入): adopt the pasted export.
  // The option carries the private key, so it is scrubbed from plugins.json
  // the moment it is consumed — whatever the outcome.
  if (config.identityImport && typeof config.identityImport === "object") {
    const payload = config.identityImport;
    const drop = () => clearPluginOption("identityImport");
    // a dedicated migrate export OR a full ATL config export: both carry
    // the identity fields, and only those are kept
    const shaped = isValidIdentity(payload);
    let existing = null;
    let corrupt = false;
    try {
      existing = readIdentity();
    } catch {
      corrupt = true;
    }
    if (!shaped) {
      drop();
      const why = "导入的不是有效的 atl-magpie-migrate 导出(字段缺失或格式不符)";
      writeFailStatus(config, why, { dryRun: args.dryRun });
      console.error(`atl-sync: ${why}`);
      return 1;
    }
    if (corrupt) {
      drop();
      const why = "本机 identity.json 损坏 — 先恢复或 consciously 删除后再导入";
      writeFailStatus(config, why, { dryRun: args.dryRun });
      console.error(`atl-sync: ${why}`);
      return 1;
    }
    if (existing && existing.participantId !== payload.participantId) {
      // A page import is an EXPLICIT user action (button + file picker):
      // replacing the identity is the intent, not an accident. The passive
      // migrate.json drop keeps its loud-refuse guard in identity.js; here
      // the previous identity is backed up (0600) so the switch is a
      // conscious, reversible act, then adoption proceeds this run.
      const bak = join(stateDir(), `identity.json.${existing.participantId}.bak`);
      writeFileSync(bak, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 });
      rmSync(identityPath(), { force: true });
      appendLog(`identity import: replacing ${existing.participantId} (${existing.nickname || "?"}) with ${payload.participantId} — previous identity backed up at ${bak}`);
      existing = null;
    }
    if (existing) {
      drop();
      appendLog(`identity import: already ${payload.participantId} — nothing to do`);
    } else {
      const migrate = {
        version: 1,
        kind: "atl-magpie-migrate",
        participantId: payload.participantId,
        nickname: payload.nickname || "",
        deviceId: payload.deviceId,
        apiBaseUrl: payload.apiBaseUrl || "",
        identityPublicKey: payload.identityPublicKey,
        identityPrivateKey: payload.identityPrivateKey
      };
      writeFileSync(join(stateDir(), "migrate.json"), JSON.stringify(migrate, null, 2) + "\n", { mode: 0o600 });
      drop();
      // The imported identity carries its OWN name. A standing nickname in
      // config.json (seeded before the import) would silently rename the
      // adopted identity back on every run — clear it with the adoption.
      try {
        const stored = JSON.parse(readFileSync(configPath(), "utf8"));
        if (stored.nickname) {
          const stale = stored.nickname;
          delete stored.nickname;
          writeConfig(stored);
          appendLog(`identity import: cleared standing config nickname "${stale}" (identity carries its own)`);
        }
      } catch {
        // no config.json: nothing standing to clear
      }
      appendLog(`identity import: accepted ${payload.participantId} (${payload.nickname || "?"}); adopting on this run`);
    }
    // The export names the server it came from, and a page import is an
    // explicit switch: adopt its apiBaseUrl on BOTH branches — a same-identity
    // re-import carrying a new server is exactly the cutover case (user
    // decision 2026-11-01; the old "never repoint" guard is released). A
    // page-SAVED apiBaseUrl option would outrank config.json, so it goes too.
    if (payload.apiBaseUrl && payload.apiBaseUrl !== config.apiBaseUrl) {
      try {
        const stored = JSON.parse(readFileSync(configPath(), "utf8"));
        stored.apiBaseUrl = payload.apiBaseUrl;
        writeConfig(stored);
      } catch {
        writeConfig({ apiBaseUrl: payload.apiBaseUrl });
      }
      clearPluginOption("apiBaseUrl");
      config.apiBaseUrl = payload.apiBaseUrl;
      appendLog(`identity import: sync repointed at ${payload.apiBaseUrl} (from the export)`);
    }
  }

  if (!config.apiBaseUrl && !args.dryRun) {
    console.error('atl-sync: no API base URL configured — set it in the plugin page, options, config.json, or via --api (refusing to sync anywhere by default)');
    writeFailStatus(config, "no API base URL configured", { dryRun: args.dryRun });
    return 1;
  }

  if (config.enabled === false && !args.dryRun && !args.once) {
    appendLog("disabled via config; skipping sync");
    return 0;
  }

  const timeZone = appTimeZone();

  // Source resolution. The gateway API is the primary source (unified:
  // ledger + local session scans, deduped upstream); the raw ledger file is
  // the fallback. A first sync against a server — or any sync with an empty
  // manifest — covers FULL history even in window mode, so nothing before
  // the routine window is silently missing; later syncs stay in the window.
  const sourceChoice = String(args.source || config.usageSource || "auto").toLowerCase();
  if (!["auto", "gateway", "ledger"].includes(sourceChoice)) {
    console.error(`atl-sync: unknown --source "${sourceChoice}" — expected auto, gateway or ledger`);
    writeFailStatus(config, `unknown --source ${sourceChoice}`, { dryRun: args.dryRun });
    return 1;
  }
  const existingManifest = readManifest(config.apiBaseUrl);
  const manifestEmpty = Object.keys(existingManifest.buckets || {}).length === 0 && !existingManifest.firstSyncStart;
  const windowDays = args.full
    ? 0
    : Number.isFinite(args.windowDays)
      ? args.windowDays
      : manifestEmpty
        ? 0
        : config.gatewayWindowDays;

  let loaded = null; // { rows (upload-eligible), pageRows, sourceInfo, sentinel }
  if (sourceChoice !== "ledger") {
    // Degradation chain, first match wins:
    //   1. `magpie usage --csv all` — the whole unified history in one shot
    //      (~2.5s for ~236k rows), so every sync sees every bucket and the
    //      fingerprint manifest keeps uploads incremental.
    //   2. the gateway's JSON API, paged — slower at depth, so it carries
    //      the routine window only (first syncs and --full go "all").
    //   3. (auto mode) the raw ledger file, below.
    let unavailable = null;
    let unified = null;
    const binary = findMagpieBinary();
    // routine syncs read a rolling window (history is immutable; the bucket
    // manifest keeps uploads incremental either way); full reads happen on
    // --full, first sync, a missing page-summary cache, or ONCE A DAY —
    // the daily full read re-verifies every fingerprint against history and
    // uploads any drift (ATL's daily-full-sync reconciliation semantics)
    let csvWindow = windowDays;
    if (csvWindow !== 0) {
      const todayKey = localDayAndHour(new Date(), appTimeZone()).day;
      const dailyFullDue = existingManifest.lastFullDay !== todayKey;
      if (dailyFullDue || !readSummaryCache()) csvWindow = 0;
    }
    if (binary) {
      try {
        if (args.verbose) console.log(`source: csv via ${binary} period=${csvWindow === 0 ? "all" : csvWindow + "d"}`);
        const csvText = await runUsageCsv({ binary, period: csvWindow === 0 ? "all" : { days: csvWindow } });
        unified = { rows: parseUsageCsv(csvText).rows, channel: "csv", meta: null, windowDays: csvWindow };
      } catch (error) {
        if (!(error instanceof CsvError)) throw error;
        unavailable = error;
        appendLog(`csv channel unavailable (${error.message}); trying the gateway API`);
      }
    }
    if (!unified) {
      try {
        const baseUrl = resolveGatewayBaseUrl();
        const period = windowPeriod(windowDays);
        if (args.verbose) console.log(`source: gateway api ${baseUrl} period=${period}`);
        const fetched = await fetchGatewayUsage({ baseUrl, period });
        unified = { rows: apiRowsToRows(fetched.rows), channel: "api", meta: fetched };
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        unavailable ??= error;
        appendLog(`gateway API unavailable (${error.message})`);
      }
    }
    if (unified) {
      const { rows: uploadRows, skippedAgents } = partitionUploadRows(unified.rows);
      const counted = unified.rows.filter((row) => row.in || row.out || row.cache_read || row.cache_write);
      const integrity = gatewayIntegrity(counted);
      if (!integrity.ok) {
        appendLog(`INTEGRITY REFUSAL (gateway source): ${integrity.issues.slice(0, 3).join("; ")}`);
        console.error(`atl-sync: gateway source integrity check failed, refusing to sync:\n  ${integrity.issues.join("\n  ")}`);
        writeFailStatus(config, `integrity check failed: ${integrity.issues[0] || "gateway source"}`, { dryRun: args.dryRun });
        return 3;
      }
      if (skippedAgents.size) {
        const skipped = [...skippedAgents.entries()].map(([agent, n]) => `${agent}=${n}`).join(", ");
        appendLog(`gateway source: skipped ${[...skippedAgents.values()].reduce((a, b) => a + b, 0)} rows of agents ATL has no source for (${skipped})`);
      }
      const meta = unified.meta;
      loaded = {
        rows: uploadRows,
        pageRows: unified.rows,
        sentinel: null,
        sourceInfo: {
          kind: "gateway",
          channel: unified.channel,
          baseUrl: unified.channel === "csv" ? (binary || "") : resolveGatewayBaseUrl(),
          period: unified.channel === "csv" ? (unified.windowDays === 0 ? "all" : `${unified.windowDays}d`) : windowPeriod(windowDays),
          total: meta ? meta.total : unified.rows.length,
          through: meta ? meta.through : null,
          direct: meta ? meta.direct : null
        }
      };
    } else if (sourceChoice === "gateway") {
      const why = unavailable ? unavailable.message : "no channel available";
      appendLog(`ERROR (gateway source): ${why}`);
      console.error(`atl-sync: ${why}`);
      writeFailStatus(config, why, { dryRun: args.dryRun });
      return 1;
    } else {
      appendLog(`gateway source unavailable; falling back to the ledger file`);
    }
  }

  if (!loaded) {
    const ledgerPath = args.ledger || defaultLedgerPath();
    let text;
    try {
      text = readFileSync(ledgerPath, "utf8");
    } catch (error) {
      appendLog(`ledger unreadable (${ledgerPath}): ${error.message}`);
      console.error(`atl-sync: cannot read ledger at ${ledgerPath}: ${error.message}`);
      writeFailStatus(config, `ledger unreadable: ${error.message}`, { dryRun: args.dryRun });
      return 1;
    }
    let parsed;
    try {
      parsed = parseLedger(text);
    } catch (error) {
      // Shape drift is an integrity refusal: loud, clean, dedicated exit code.
      appendLog(`INTEGRITY REFUSAL (shape drift): ${error.message}`);
      console.error(`atl-sync: ${error.message}`);
      writeFailStatus(config, `ledger shape drift: ${error.message}`, { dryRun: args.dryRun });
      return 3;
    }
    const { rows, malformed, total } = parsed;
    const counted = rows.filter((row) => row.in || row.out || row.cache_read || row.cache_write);
    const integrity = integrityCheck(counted);
    if (!integrity.ok) {
      appendLog(`INTEGRITY REFUSAL: ${integrity.issues.slice(0, 3).join("; ")}`);
      console.error(`atl-sync: ledger integrity check failed, refusing to sync:\n  ${integrity.issues.join("\n  ")}`);
      writeFailStatus(config, `integrity check failed: ${integrity.issues[0] || "ledger"}`, { dryRun: args.dryRun });
      return 3;
    }
    loaded = {
      rows,
      pageRows: rows,
      sentinel: firstRouteId(rows),
      sourceInfo: { kind: "ledger", channel: "ledger", path: ledgerPath, total, malformed, counted: counted.length }
    };
  }

  // Display bridge for the usage page: everything the chosen source sees
  // (every agent, regardless of the magpie_local upload toggle); local
  // only, nothing extra is uploaded. 380 days keeps the 53-week heatmap fed.
  // A windowed read can't shrink the page's history: it overlays onto the
  // cached full summary (missing cache forced a full read above).
  {
    const fresh = summarizeRows(loaded.pageRows, { timeZone, maxDays: 380 });
    const cached = (loaded.sourceInfo.kind === "gateway" && loaded.sourceInfo.channel === "csv" && loaded.sourceInfo.period !== "all")
      ? readSummaryCache()
      : null;
    const merged = mergeSummaries(cached, fresh);
    writeSummaryCache(merged);
    writeUsageData(merged);
  }

  // Identity resolution happens inside the lock for fresh-identity creation.
  const run = async () => {
    const { identity, source } = resolveIdentity(config);
    // One-shot page rename: the page sends nicknameSet when the user saves a
    // new name; it is consumed here (never a standing option — a standing
    // nickname would silently fight every imported identity, as config.json's
    // once did).
    if (typeof config.nicknameSet === "string" && config.nicknameSet && config.nicknameSet !== identity.nickname) {
      identity.nickname = config.nicknameSet;
      writeIdentity(identity);
      appendLog(`nickname set to "${identity.nickname}" (one-shot page command); re-registered on this run`);
    }
    clearPluginOption("nicknameSet");
    const buckets = buildBuckets(loaded.rows, {
      participantId: identity.participantId,
      timeZone,
      sinceDay: config.sinceDay || "",
      includeMagpieLocal: config.includeMagpieLocal !== false,
      rawSourceRef: loaded.sourceInfo.kind === "gateway" ? "magpie:gateway-api" : "magpie:usage.jsonl"
    });

    const manifest = readManifest(config.apiBaseUrl);
    // Ledger rotation sentinel: a new first route_id means the file was
    // rotated/rewritten, so cached fingerprints no longer mean anything.
    // (Gateway-API reads have no sentinel: their rows are recomputed from
    // the whole store, not appended to a rotating file.)
    const sentinel = loaded.sentinel;
    if (manifest.firstRouteId !== null && sentinel !== null && manifest.firstRouteId !== sentinel) {
      appendLog(`ledger rotated (first route_id ${manifest.firstRouteId} -> ${sentinel}); rebuilding manifest`);
      manifest.buckets = {};
    }
    manifest.firstRouteId = sentinel;
    if (!manifest.firstSyncStart) manifest.firstSyncStart = new Date().toISOString();
    if (loaded.sourceInfo.kind === "gateway" && loaded.sourceInfo.channel === "csv" && loaded.sourceInfo.period === "all") {
      manifest.lastFullDay = localDayAndHour(new Date(), timeZone).day;
    }

    const allKeys = [...buckets.keys()].sort();
    // The page must not wait out a long upload to learn who it now is:
    // an interim status lands the identity (and live progress) at once.
    const prevStatus = readStatus() || {};
    const writeSyncing = (done) => {
      writeStatus({
        ...prevStatus,
        ok: true,
        error: null,
        syncing: dirtyKeysForProgress.length ? { done, total: dirtyKeysForProgress.length } : null,
        identitySource: source,
        sourceKind: loaded.sourceInfo.kind,
        sourceChannel: loaded.sourceInfo.channel || loaded.sourceInfo.kind,
        participantId: identity.participantId,
        nickname: identity.nickname || "",
        deviceId: identity.deviceId || "",
        apiBaseUrl: config.apiBaseUrl,
        buckets: allKeys.length,
        lastSyncAt: prevStatus.lastSyncAt
      });
    };
    const dirtyKeysForProgress = allKeys.filter((key) => {
      const bucket = buckets.get(key);
      return !manifest.buckets[key] || manifest.buckets[key] !== computeBucketFingerprint(bucket.items);
    });
    // Without a configured server the manifest comparison is meaningless
    // (dry-run only) — show buckets without misleading dirty markers.
    const evaluateDirty = Boolean(config.apiBaseUrl);
    const dirtyKeys = evaluateDirty
      ? allKeys.filter((key) => {
          const bucket = buckets.get(key);
          const fingerprint = computeBucketFingerprint(bucket.items);
          bucket.fingerprint = fingerprint;
          return manifest.buckets[key] !== fingerprint;
        })
      : [];

    if (args.dryRun) {
      printDryRun(buckets, dirtyKeys, source, timeZone, loaded.sourceInfo);
      if (!evaluateDirty) console.log("note: no API base URL configured — dirty markers are not evaluated in this dry-run");
      return 0;
    }

    if (!dirtyKeys.length) {
      // A rename must reach the server even when nothing else changed, or the
      // leaderboard keeps showing the old nickname until the next dirty bucket.
      if (source === "store-renamed") {
        await registerDevice({ apiBaseUrl: config.apiBaseUrl, identity });
        appendLog(`nickname updated to "${identity.nickname}"; re-registered`);
      }
      appendLog(`noop: ${allKeys.length} buckets up to date (${source}, ${loaded.sourceInfo.kind} source)`);
      writeStatus({
        ok: true,
        noop: true,
        error: null,
        syncing: null,
        identitySource: source,
        sourceKind: loaded.sourceInfo.kind,
        sourceChannel: loaded.sourceInfo.channel || loaded.sourceInfo.kind,
        participantId: identity.participantId,
        nickname: identity.nickname || "",
        deviceId: identity.deviceId || "",
        apiBaseUrl: config.apiBaseUrl,
        buckets: allKeys.length,
        dirty: 0,
        firstSyncStart: manifest.firstSyncStart || null
      });
      await enrichStatusWithRank(config, identity);
      console.log(`atl-sync: noop (${allKeys.length} buckets up to date)`);
      return 0;
    }

    const dirtyBuckets = dirtyKeys.map((key) => buckets.get(key));
    writeSyncing(0);
    let progressDone = 0;
    const registered = await registerDevice({ apiBaseUrl: config.apiBaseUrl, identity });
    if (args.verbose) console.log(`registered device ${identity.deviceId} (server time ${registered.serverTime || "?"})`);
    // checkpoint per chunk: a backfill interrupted mid-way resumes from the
    // last batch the server took (replace semantics make re-runs safe)
    await uploadBuckets({
      apiBaseUrl: config.apiBaseUrl,
      identity,
      buckets: dirtyBuckets,
      onProgress: (chunk) => {
        for (const batch of chunk) {
          const key = `${batch.snapshot.day}|${batch.snapshot.hour}|${batch.snapshot.providerId}`;
          manifest.buckets[key] = batch.snapshot.bucketFingerprint;
        }
        writeManifest(config.apiBaseUrl, manifest);
        progressDone += chunk.length;
        writeSyncing(progressDone);
      }
    });

    for (const key of dirtyKeys) {
      const bucket = buckets.get(key);
      manifest.buckets[key] = bucket.fingerprint;
    }
    writeManifest(config.apiBaseUrl, manifest);

    const uploadedTokens = dirtyBuckets.reduce(
      (sum, bucket) => sum + bucket.items.reduce((inner, item) => inner + item.totalTokens, 0),
      0
    );
    appendLog(`synced ${dirtyKeys.length} buckets (${uploadedTokens} tokens) from ${source}, ${loaded.sourceInfo.kind} source`);
    writeStatus({
      ok: true,
      error: null,
      identitySource: source,
      sourceKind: loaded.sourceInfo.kind,
      sourceChannel: loaded.sourceInfo.channel || loaded.sourceInfo.kind,
      participantId: identity.participantId,
      nickname: identity.nickname || "",
      deviceId: identity.deviceId || "",
      apiBaseUrl: config.apiBaseUrl,
      buckets: allKeys.length,
      dirty: dirtyKeys.length,
      uploadedTokens,
      lastSyncAt: new Date().toISOString(),
      firstSyncStart: manifest.firstSyncStart || null
    });
    await enrichStatusWithRank(config, identity);
    console.log(`atl-sync: uploaded ${dirtyKeys.length} buckets, ${uploadedTokens} tokens -> ${config.apiBaseUrl}`);
    return 0;
  };

  try {
    return await withLock(run);
  } catch (error) {
    if (String(error.message || "").includes("holding the lock")) {
      // busy is not a failure: the run that holds the lock owns the status
      // (its interim progress may be on screen), and painting the panel red
      // for a healthy queue would cry wolf
      appendLog("busy: another sync holds the lock");
      console.error("atl-sync: busy (another sync is running)");
      return 2;
    }
    appendLog(`ERROR: ${error.message}`);
    console.error(`atl-sync: ${error.message}`);
    writeFailStatus(config, error.message, { dryRun: args.dryRun });
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
