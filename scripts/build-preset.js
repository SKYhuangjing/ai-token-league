#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!key || Object.hasOwn(process.env, key)) continue;
    process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

function parseBool(value) {
  return String(value).toLowerCase() === "true";
}

function parsePreset() {
  const preset = {};
  if (process.env.PRESET_API_BASE_URL) preset.apiBaseUrl = process.env.PRESET_API_BASE_URL;
  if (process.env.PRESET_NICKNAME) preset.nickname = process.env.PRESET_NICKNAME;
  if (process.env.PRESET_AUTO_REFRESH) preset.autoRefreshEnabled = parseBool(process.env.PRESET_AUTO_REFRESH);
  if (process.env.PRESET_REFRESH_INTERVAL) preset.refreshIntervalMinutes = Number(process.env.PRESET_REFRESH_INTERVAL);
  if (process.env.PRESET_SILENT_UPDATE) preset.silentUpdateMode = process.env.PRESET_SILENT_UPDATE;
  if (process.env.PRESET_LAUNCH_AT_LOGIN) preset.launchAtLogin = parseBool(process.env.PRESET_LAUNCH_AT_LOGIN);
  if (process.env.PRESET_PUBLIC_UPLOAD) preset.publicUpload = parseBool(process.env.PRESET_PUBLIC_UPLOAD);
  if (process.env.PRESET_SHOW_ESTIMATED_COST) preset.showEstimatedCost = parseBool(process.env.PRESET_SHOW_ESTIMATED_COST);
  if (process.env.PRESET_SHOW_RAW_TOKENS) preset.showRawTokens = parseBool(process.env.PRESET_SHOW_RAW_TOKENS);
  return preset;
}

const envFile = process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : "";
if (envFile) loadEnvFile(path.resolve(envFile));

const preset = parsePreset();
const outDir = path.join(ROOT, "assets");
const outPath = path.join(outDir, "preset.json");

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(preset, null, 2) + "\n");

if (Object.keys(preset).length === 0) {
  console.log("No PRESET_* env vars set. Wrote empty preset to assets/preset.json");
} else {
  console.log(`Wrote preset to assets/preset.json with keys: ${Object.keys(preset).join(", ")}`);
}
