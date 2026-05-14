#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
import { initConfig, loadConfig, saveConfig, exportIdentity, importIdentity, loadSyncManifest, saveSyncManifest } from "./config.js";
import { scanUsage, providerHealth, groupByBucket } from "./core.js";
import { signPayload } from "../shared/crypto.js";
import { computeBucketFingerprint } from "../shared/schema.js";
import { clientMetadata, collectNetworkInfo } from "../shared/version.js";

const command = process.argv[2] || "help";

function requireConfig() {
  const config = loadConfig();
  if (!config) throw new Error("collector is not initialized. Run: npm run collector:init -- --nickname your-name");
  return config;
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const error = new Error(`${response.status} ${text}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  return text ? JSON.parse(text) : {};
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  if (command === "init") {
    const hasNicknameFlag = process.argv.includes("--nickname");
    const hasApiFlag = process.argv.includes("--api");
    if (hasNicknameFlag || hasApiFlag || loadConfig()) {
      const nickname = argValue("nickname", "anonymous");
      const apiBaseUrl = argValue("api", "");
      const config = initConfig({ nickname, apiBaseUrl });
      console.log(JSON.stringify({ participantId: config.participantId, deviceId: config.deviceId, nickname: config.nickname }, null, 2));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));
    console.log("Welcome to AI Token League");
    console.log("Track your AI coding token usage and compare with the community.\n");
    console.log("Your data stays private:");
    console.log("  - Prompts and responses are never collected.");
    console.log("  - Source code is never collected.");
    console.log("  - Real file paths are replaced with hashes.");
    console.log("  - Cursor tokens stay on your computer.\n");
    const nickname = (await ask("Nickname [anonymous]: ")).trim() || "anonymous";
    const tempConfig = initConfig({ nickname, apiBaseUrl: "" });
    console.log("\nChecking local sources...");
    const health = providerHealth(tempConfig);
    for (const item of health) {
      const detected = item.detected || (item.roots && item.roots.length > 0);
      const label = item.providerId === "cursor_dashboard_usage" ? "Cursor" : item.providerId === "codex_local" ? "Codex" : "Claude Code";
      const status = detected ? `found · ${item.roots?.length || 0} location${(item.roots?.length || 0) === 1 ? "" : "s"}` : "not found";
      console.log(`  ${label}: ${status}`);
    }
    console.log("\nCloud connection (optional)");
    const apiBaseUrl = (await ask("  API base URL (leave empty to skip): ")).trim();
    rl.close();
    const config = apiBaseUrl ? initConfig({ nickname, apiBaseUrl }) : tempConfig;
    if (apiBaseUrl) saveConfig(config);
    console.log("\nConfiguration saved:");
    console.log(`  Participant ID: ${config.participantId}`);
    console.log(`  Device ID: ${config.deviceId}`);
    console.log(`  Nickname: ${config.nickname}`);
    console.log(`  Cloud: ${apiBaseUrl || "Local only"}`);
    console.log("\nRun `npm run collector -- scan` to check your usage.");
    return;
  }

  if (command === "health") {
    const config = requireConfig();
    const client = clientMetadata();
    let server = null;
    if (config.apiBaseUrl) {
      const params = new URLSearchParams({
        clientAppVersion: client.clientAppVersion,
        clientProtocolVersion: String(client.clientProtocolVersion),
        clientPlatform: client.clientPlatform,
        clientBuild: client.clientBuild
      });
      server = await getJson(`${config.apiBaseUrl}/api/health?${params}`);
    }
    console.log(JSON.stringify({ client, server, providers: providerHealth(config) }, null, 2));
    return;
  }

  if (command === "status") {
    const config = requireConfig();
    const client = clientMetadata();
    let server = null;
    if (config.apiBaseUrl) {
      const params = new URLSearchParams({
        clientAppVersion: client.clientAppVersion,
        clientProtocolVersion: String(client.clientProtocolVersion),
        clientPlatform: client.clientPlatform,
        clientBuild: client.clientBuild
      });
      server = await getJson(`${config.apiBaseUrl}/api/health?${params}`);
    }
    console.log(JSON.stringify({
      client,
      apiBaseUrl: config.apiBaseUrl || "",
      compatibility: server?.compatibility || null,
      serverVersion: server?.serverVersion || "",
      latestClientVersion: server?.latestClientVersion || ""
    }, null, 2));
    return;
  }

  if (command === "scan") {
    const result = await scanUsage(requireConfig());
    const { sourceIndex, ...publicResult } = result;
    console.log(JSON.stringify(publicResult, null, 2));
    return;
  }

  if (command === "register") {
    const config = requireConfig();
    const result = await postJson(`${config.apiBaseUrl}/api/devices/register`, {
      participantId: config.participantId,
      deviceId: config.deviceId,
      nickname: config.nickname,
      identityPublicKey: config.identityPublicKey,
      os: process.platform,
      appVersion: clientMetadata().clientAppVersion,
      ...clientMetadata(),
      networkInfo: collectNetworkInfo()
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "sync") {
    const config = requireConfig();
    await postJson(`${config.apiBaseUrl}/api/devices/register`, {
      participantId: config.participantId,
      deviceId: config.deviceId,
      nickname: config.nickname,
      identityPublicKey: config.identityPublicKey,
      os: process.platform,
      appVersion: clientMetadata().clientAppVersion,
      ...clientMetadata(),
      networkInfo: collectNetworkInfo()
    });
    const scanned = await scanUsage(config);
    const buckets = groupByBucket(scanned.items);
    const fullResync = hasFlag("full-resync");

    let manifest = fullResync ? null : loadSyncManifest();
    const isNewManifest = !manifest;
    if (isNewManifest) {
      manifest = { version: 1, buckets: {} };
    }

    let uploadedBucketCount = 0;
    let noopBucketCount = 0;
    const failedBuckets = [];

    // collect dirty buckets to upload
    const dirty = [];
    for (const [bucketKey, bucket] of buckets) {
      if (!bucket.items.length) continue;
      const fingerprint = computeBucketFingerprint(bucket.items);
      const totalTokens = bucket.items.reduce((s, i) => s + (i.totalTokens || 0), 0);
      const existing = manifest.buckets[bucketKey];

      if (!fullResync && existing && existing.fingerprint === fingerprint) {
        noopBucketCount += 1;
        continue;
      }

      dirty.push({ bucketKey, bucket, fingerprint, totalTokens });
    }

    // upload with bounded concurrency
    const BUCKET_CONCURRENCY = 3;
    for (let i = 0; i < dirty.length; i += BUCKET_CONCURRENCY) {
      const batch = dirty.slice(i, i + BUCKET_CONCURRENCY);
      const results = await Promise.all(batch.map(async ({ bucketKey, bucket, fingerprint, totalTokens }) => {
        const snapshot = {
          mode: "device_day_provider",
          day: bucket.day,
          providerId: bucket.providerId,
          bucketFingerprint: fingerprint,
          rowCount: bucket.items.length,
          totalTokens
        };
        const payload = {
          participantId: config.participantId,
          deviceId: config.deviceId,
          clientGeneratedAt: new Date().toISOString(),
          client: clientMetadata(),
          snapshot,
          items: bucket.items
        };
        try {
          await postJson(`${config.apiBaseUrl}/api/usage/daily-batch`, {
            ...payload,
            signature: signPayload(config.identityPrivateKey, payload)
          });
        } catch (error) {
          return { bucketKey, ok: false, error: error.message };
        }

        manifest.buckets[bucketKey] = {
          day: bucket.day,
          providerId: bucket.providerId,
          fingerprint,
          rowCount: bucket.items.length,
          totalTokens,
          syncedAt: new Date().toISOString()
        };
        return { bucketKey, ok: true };
      }));
      for (const result of results) {
        if (result.ok) uploadedBucketCount += 1;
        else failedBuckets.push(result);
      }
      // persist manifest after each batch so progress survives a crash
      saveSyncManifest(manifest);
    }

    if (!dirty.length) saveSyncManifest(manifest);
    console.log(JSON.stringify({
      scannedRows: scanned.items.length,
      bucketCount: buckets.size,
      uploadedBucketCount,
      noopBucketCount,
      failedBucketCount: failedBuckets.length,
      failedBuckets,
      fullResync
    }, null, 2));
    if (failedBuckets.length) process.exitCode = 1;
    return;
  }

  if (command === "export-identity") {
    console.log(JSON.stringify(exportIdentity(requireConfig()), null, 2));
    return;
  }

  if (command === "import-identity") {
    const file = argValue("file");
    if (!file) throw new Error("missing --file");
    const identity = JSON.parse(fs.readFileSync(file, "utf8"));
    const config = importIdentity(identity, loadConfig() || {});
    console.log(JSON.stringify({ participantId: config.participantId, deviceId: config.deviceId }, null, 2));
    return;
  }

  console.log(`Usage:
  npm run collector:init -- --nickname sky [--api https://your-api.example]
  npm run collector -- health
  npm run collector -- status
  npm run collector -- scan
  npm run collector -- register
  npm run collector -- sync
  npm run collector -- export-identity
  npm run collector -- import-identity --file identity.json`);
}

main().catch((error) => {
  if (error.status === 426) {
    const compat = error.body?.compatibility || {};
    const reason = compat.reason || error.body?.error || "unsupported_client";
    const latest = compat.server?.latestClientVersion || "";
    const current = compat.client?.clientAppVersion || "";
    console.error(`Update required: your client ${current || "(unknown)"} is not compatible with this server.`);
    if (latest) console.error(`Latest client version: ${latest}`);
    if (reason === "client_app_version_too_old") console.error("Your client version is below the server minimum. Please update.");
    else if (reason === "client_protocol_too_old") console.error("Your client protocol is too old. Please update.");
    else console.error(`Reason: ${reason}`);
    process.exit(1);
  }
  console.error(error.message);
  process.exit(1);
});
