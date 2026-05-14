#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";

const DEFAULT_ENV = "env.test";
const DEFAULT_PARTICIPANT = "p_27f18eaa61476c6f6e1793ad";
const DEFAULT_DAY = "2026-05-13";

function usage() {
  console.log(`Usage:
  node scripts/query-usage-daily.js [options]

Options:
  --env <file>             Env file to read. Default: ${DEFAULT_ENV}
  --participant <id>       Participant id. Default: ${DEFAULT_PARTICIPANT}
  --day <YYYY-MM-DD>       Usage day. Default: ${DEFAULT_DAY}
  --provider <id>          Optional provider filter
  --workdir-hash <hash>    Optional workdirHash filter
  --limit <n>              Detail row limit. Default: 100
  --sync-buckets           Query sync bucket metadata instead of usage rows
  --json                   Print raw JSON only
  --help                   Show this help
`);
}

function parseArgs(argv) {
  const args = {
    envFile: DEFAULT_ENV,
    participantId: DEFAULT_PARTICIPANT,
    day: DEFAULT_DAY,
    providerId: "",
    workdirHash: "",
    limit: 100,
    syncBuckets: false,
    json: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--sync-buckets") {
      args.syncBuckets = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === "--env") args.envFile = next;
    else if (arg === "--participant") args.participantId = next;
    else if (arg === "--day") args.day = next;
    else if (arg === "--provider") args.providerId = next;
    else if (arg === "--workdir-hash") args.workdirHash = next;
    else if (arg === "--limit") args.limit = Number(next);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.day)) throw new Error("--day must be YYYY-MM-DD");
  if (!Number.isInteger(args.limit) || args.limit <= 0) throw new Error("--limit must be a positive integer");
  return args;
}

function parseEnvFile(file) {
  const envPath = path.resolve(file);
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  const env = {};
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith("\"") && value.endsWith("\""))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function requireEnv(env, key) {
  if (!env[key]) throw new Error(`${key} is required in env file`);
  return env[key];
}

function dayExpr(column = "day") {
  return `DATE_FORMAT(${column}, '%Y-%m-%d')`;
}

async function tableColumns(conn, table) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM ${table}`);
  return new Set(rows.map((row) => row.Field));
}

function selectColumns(available, wanted) {
  return wanted.filter((column) => available.has(column));
}

function buildWhere(args) {
  const conditions = [`participantId = ?`, `${dayExpr()} = ?`];
  const values = [args.participantId, args.day];
  if (args.providerId) {
    conditions.push("providerId = ?");
    values.push(args.providerId);
  }
  if (args.workdirHash) {
    conditions.push("workdirHash = ?");
    values.push(args.workdirHash);
  }
  return { sql: conditions.join(" AND "), values };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = parseEnvFile(args.envFile);
  const conn = await mysql.createConnection({
    host: requireEnv(env, "MYSQL_HOST"),
    port: Number(env.MYSQL_PORT || 3306),
    user: requireEnv(env, "MYSQL_USER"),
    password: requireEnv(env, "MYSQL_PASSWORD"),
    database: requireEnv(env, "MYSQL_DATABASE"),
    dateStrings: true
  });

  try {
    if (args.syncBuckets) {
      const bucketConditions = ["participantId = ?"];
      const bucketValues = [args.participantId];
      if (args.day) {
        bucketConditions.push("day = ?");
        bucketValues.push(args.day);
      }
      if (args.providerId) {
        bucketConditions.push("providerId = ?");
        bucketValues.push(args.providerId);
      }
      const [bucketRows] = await conn.query(
        `SELECT bucketKey, participantId, deviceId, day, providerId,
           bucketFingerprint, rowCount, totalTokens,
           clientGeneratedAt, syncedAt, updatedAt
         FROM usage_sync_buckets
         WHERE ${bucketConditions.join(" AND ")}
         ORDER BY day DESC, providerId`,
        bucketValues
      );
      const result = {
        env: {
          file: path.resolve(args.envFile),
          host: env.MYSQL_HOST,
          database: env.MYSQL_DATABASE
        },
        query: {
          participantId: args.participantId,
          day: args.day,
          providerId: args.providerId || null,
          syncBuckets: true
        },
        buckets: bucketRows
      };
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printSyncBucketSummary(result);
      return;
    }

    const where = buildWhere(args);
    const [participantRows] = await conn.query(
      "SELECT id, nickname, createdAt, updatedAt, lastSeenAt FROM participants WHERE id = ?",
      [args.participantId]
    );
    const deviceColumns = await tableColumns(conn, "devices");
    const deviceSelect = selectColumns(deviceColumns, [
      "id",
      "participantId",
      "os",
      "appVersion",
      "clientAppVersion",
      "clientProtocolVersion",
      "clientPlatform",
      "clientBuild",
      "lanIp",
      "createdAt",
      "lastSeenAt"
    ]);
    const [deviceRows] = await conn.query(
      `SELECT ${deviceSelect.join(", ")} FROM devices WHERE participantId = ? ORDER BY lastSeenAt DESC`,
      [args.participantId]
    );
    const [summaryRows] = await conn.query(
      `SELECT
         COUNT(*) AS rowCount,
         COALESCE(SUM(totalTokens), 0) AS totalTokens,
         COALESCE(SUM(inputTokens), 0) AS inputTokens,
         COALESCE(SUM(outputTokens), 0) AS outputTokens,
         COALESCE(SUM(cacheReadTokens), 0) AS cacheReadTokens,
         COALESCE(SUM(cacheWriteTokens), 0) AS cacheWriteTokens,
         COALESCE(SUM(reasoningTokens), 0) AS reasoningTokens
       FROM usage_daily
       WHERE ${where.sql}`,
      where.values
    );
    const [byWorkdirRows] = await conn.query(
      `SELECT workdirHash, workdirDisplayName, providerId, model,
         COUNT(*) AS rowCount,
         COALESCE(SUM(totalTokens), 0) AS totalTokens,
         COALESCE(SUM(inputTokens), 0) AS inputTokens,
         COALESCE(SUM(outputTokens), 0) AS outputTokens,
         COALESCE(SUM(cacheReadTokens), 0) AS cacheReadTokens
       FROM usage_daily
       WHERE ${where.sql}
       GROUP BY workdirHash, workdirDisplayName, providerId, model
       ORDER BY totalTokens DESC`,
      where.values
    );
    const [detailRows] = await conn.query(
      `SELECT usageKey, ${dayExpr()} AS day, participantId, deviceId, toolCode, providerId,
         workdirId, workdirHash, workdirDisplayName, model,
         inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens,
         sourceQuality, rawSourceRef, providerVersion, parserVersion, sourceFingerprint, uploadedAt
       FROM usage_daily
       WHERE ${where.sql}
       ORDER BY totalTokens DESC
       LIMIT ?`,
      [...where.values, args.limit]
    );

    const result = {
      env: {
        file: path.resolve(args.envFile),
        host: env.MYSQL_HOST,
        database: env.MYSQL_DATABASE
      },
      query: {
        participantId: args.participantId,
        day: args.day,
        providerId: args.providerId || null,
        workdirHash: args.workdirHash || null,
        limit: args.limit
      },
      participant: participantRows[0] || null,
      devices: deviceRows,
      summary: summaryRows[0],
      byWorkdir: byWorkdirRows,
      rows: detailRows
    };

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printUsageSummary(result);
  } finally {
    await conn.end();
  }
}

function printUsageSummary(result) {
  console.log(`env: ${result.env.host}/${result.env.database}`);
  console.log(`participant: ${result.query.participantId}`);
  console.log(`day: ${result.query.day}`);
  if (result.query.providerId) console.log(`provider: ${result.query.providerId}`);
  if (result.query.workdirHash) console.log(`workdirHash: ${result.query.workdirHash}`);
  console.log(`summary: rows=${result.summary.rowCount} totalTokens=${result.summary.totalTokens}`);
  console.log("byWorkdir:");
  for (const row of result.byWorkdir) {
    console.log(`  ${row.providerId} ${row.model} ${row.workdirDisplayName} ${row.workdirHash}: rows=${row.rowCount} totalTokens=${row.totalTokens}`);
  }
  console.log("rows:");
  for (const row of result.rows) {
    console.log(`  ${row.usageKey} totalTokens=${row.totalTokens} uploadedAt=${row.uploadedAt}`);
  }
}

function printSyncBucketSummary(result) {
  console.log(`env: ${result.env.host}/${result.env.database}`);
  console.log(`participant: ${result.query.participantId}`);
  console.log(`day: ${result.query.day}`);
  if (result.query.providerId) console.log(`provider: ${result.query.providerId}`);
  console.log(`syncBuckets: ${result.buckets.length}`);
  for (const row of result.buckets) {
    console.log(`  ${row.bucketKey}: rows=${row.rowCount} totalTokens=${row.totalTokens} fingerprint=${row.bucketFingerprint} syncedAt=${row.syncedAt}`);
  }
}

main().catch((error) => {
  console.error(`query failed: ${error.message}`);
  process.exit(1);
});
