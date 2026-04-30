import path from "node:path";
import { sha256Hex } from "../shared/crypto.js";

export function normalizePathForHash(inputPath) {
  return path.resolve(inputPath).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

export function detectDisplayName(inputPath) {
  const normalized = path.resolve(inputPath);
  const base = path.basename(normalized);
  return base || "root";
}

export function workdirFromCandidate(candidate, participantId) {
  if (String(candidate || "").startsWith("virtual:")) {
    const displayName = String(candidate).split(":").at(-1) || "virtual";
    return {
      localPath: "",
      workdirHash: sha256Hex(`${candidate}:${participantId}`),
      detectedName: displayName,
      displayName
    };
  }
  const resolved = candidate ? path.resolve(candidate) : process.cwd();
  const normalized = normalizePathForHash(resolved);
  return {
    localPath: resolved,
    workdirHash: sha256Hex(`${normalized}:${participantId}`),
    detectedName: detectDisplayName(resolved),
    displayName: detectDisplayName(resolved)
  };
}
