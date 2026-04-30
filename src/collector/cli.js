#!/usr/bin/env node
import fs from "node:fs";
import { initConfig, loadConfig, saveConfig, exportIdentity, importIdentity } from "./config.js";
import { scanUsage, providerHealth } from "./core.js";
import { signPayload } from "../shared/crypto.js";

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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  if (command === "init") {
    const nickname = argValue("nickname", "anonymous");
    const apiBaseUrl = argValue("api", "http://127.0.0.1:8787");
    const config = initConfig({ nickname, apiBaseUrl });
    console.log(JSON.stringify({ participantId: config.participantId, deviceId: config.deviceId, nickname: config.nickname }, null, 2));
    return;
  }

  if (command === "health") {
    console.log(JSON.stringify(providerHealth(requireConfig()), null, 2));
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
      appVersion: "0.1.0"
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
      appVersion: "0.1.0"
    });
    const scanned = await scanUsage(config);
    const payload = {
      participantId: config.participantId,
      deviceId: config.deviceId,
      clientGeneratedAt: new Date().toISOString(),
      items: scanned.items
    };
    const result = await postJson(`${config.apiBaseUrl}/api/usage/daily-batch`, {
      ...payload,
      signature: signPayload(config.identityPrivateKey, payload)
    });
    console.log(JSON.stringify({ ...result, scanned: scanned.items.length }, null, 2));
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
  npm run collector:init -- --nickname sky [--api http://127.0.0.1:8787]
  npm run collector -- health
  npm run collector -- scan
  npm run collector -- register
  npm run collector -- sync
  npm run collector -- export-identity
  npm run collector -- import-identity --file identity.json`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
