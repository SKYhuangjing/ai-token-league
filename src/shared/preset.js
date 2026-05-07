import fs from "node:fs";
import path from "node:path";

export const PRESET_ALLOWED_KEYS = [
  "apiBaseUrl",
  "nickname",
  "language",
  "autoRefreshEnabled",
  "refreshIntervalMinutes",
  "silentUpdateMode",
  "launchAtLogin",
  "showEstimatedCost",
  "showRawTokens",
  "providerEnabled"
];

export function loadBuildPreset(appPath) {
  try {
    const presetPath = path.join(appPath, "assets", "preset.json");
    if (!fs.existsSync(presetPath)) return {};
    const raw = JSON.parse(fs.readFileSync(presetPath, "utf8"));
    if (!raw || typeof raw !== "object") return {};
    const result = {};
    for (const key of PRESET_ALLOWED_KEYS) {
      if (Object.hasOwn(raw, key)) {
        result[key] = raw[key];
      }
    }
    return result;
  } catch {
    return {};
  }
}
