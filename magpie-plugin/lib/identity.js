// Identity resolution order:
//   1. own store (~/.config/magpie/atl-sync/identity.json)
//   2. migration file at atl-sync/migrate.json (this plugin's own export
//   3. adopt the local ATL client identity (~/.ai-token-league/config.json)
//      — implemented and tested, but gated OFF this phase (shadow identity)
//   4. fresh identity (onboarding / shadow validation)
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { generateIdentity, newId } from "./atl.js";
import { stateDir, identityPath, readIdentity, writeIdentity } from "./state.js";

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function isValidIdentity(value) {
  return Boolean(
    value &&
      typeof value.participantId === "string" && /^p_[0-9a-f]{24}$/.test(value.participantId) &&
      typeof value.deviceId === "string" && /^d_[0-9a-f]{24}$/.test(value.deviceId) &&
      typeof value.identityPublicKey === "string" && value.identityPublicKey.includes("BEGIN PUBLIC KEY") &&
      typeof value.identityPrivateKey === "string" && value.identityPrivateKey.includes("BEGIN PRIVATE KEY")
  );
}

function normalizeIdentity(value, fallbackNickname = "") {
  return {
    participantId: value.participantId,
    deviceId: value.deviceId,
    nickname: typeof value.nickname === "string" && value.nickname ? value.nickname : fallbackNickname,
    identityPublicKey: value.identityPublicKey,
    identityPrivateKey: value.identityPrivateKey
  };
}

/** Fresh shadow/onboarding identity. */
export function createFreshIdentity(nickname = "") {
  const identity = generateIdentity();
  return {
    ...identity,
    deviceId: newId("d"),
    nickname: nickname || `magpie-${identity.participantId.slice(-6)}`
  };
}

/**
 * Resolves (and persists) the sync identity.
 * Returns { identity, source } where source is
 * "store" | "migrate-file" | "adopt-atl" | "fresh" | "store-renamed".
 */
export function resolveIdentity(config = {}) {
  // 1. own store — a CORRUPTED identity file is a loud error, never a silent
  // fresh identity: silently minting a new participant would orphan this
  // device's server-side data (split identity).
  const stored = readIdentity();
  if (stored !== null && !isValidIdentity(stored)) {
    throw new Error(
      `identity file ${identityPath()} is corrupt (invalid/missing fields) — restore it from backup or remove it consciously; refusing to mint a replacement identity`
    );
  }
  // a migration file dropped while a store identity already exists must
  // never be silently ignored: same identity → consume it as a no-op,
  // another identity → refuse loudly (an unnoticed second export would
  // otherwise sit here forever or, worse, feel ignored on purpose)
  const droppedPath = join(stateDir(), "migrate.json");
  if (isValidIdentity(stored) && existsSync(droppedPath)) {
    const dropped = readJsonFile(droppedPath);
    // a dedicated migrate export OR a full ATL config export (the settings
    // page's plain 导出配置): both carry the identity fields
    if (dropped && isValidIdentity(dropped)) {
      if (dropped.participantId === stored.participantId) {
        renameSync(droppedPath, `${droppedPath}.imported`);
      } else {
        throw new Error(
          `migrate.json carries ${dropped.participantId} but this plugin already is ${stored.participantId} — remove identity.json consciously if a replacement is really meant`
        );
      }
    } else {
      throw new Error(
        `${droppedPath} exists but is not a valid atl-magpie-migrate export (missing/invalid fields) — remove it or re-export`
      );
    }
  }

  if (isValidIdentity(stored)) {
    const identity = normalizeIdentity(stored);
    // A nickname set later (page/CLI) is applied to the existing identity;
    // registration re-posts it, so the server-side name follows.
    if (config.nickname && config.nickname !== stored.nickname) {
      identity.nickname = config.nickname;
      writeIdentity(identity);
      return { identity, source: "store-renamed" };
    }
    return { identity, source: "store" };
  }

  // 2. migration file exported by this plugin's --export-config
  const migratePath = join(stateDir(), "migrate.json");
  if (existsSync(migratePath)) {
    const migrated = readJsonFile(migratePath);
    if (migrated && isValidIdentity(migrated)) {
      const identity = normalizeIdentity(migrated, config.nickname);
      writeIdentity(identity);
      renameSync(migratePath, `${migratePath}.imported`);
      return { identity, source: "migrate-file" };
    }
    throw new Error(
      `${migratePath} exists but carries no complete identity (missing/invalid fields) — remove it or re-export`
    );
  }

  // 3. adopt the local ATL client identity — phase 2 only, opt-in
  if (config.allowAdopt === true) {
    const atlConfig = readJsonFile(join(process.env.ATL_HOME || process.env.HOME || "~", ".ai-token-league", "config.json"));
    if (atlConfig && isValidIdentity(atlConfig)) {
      const identity = normalizeIdentity(atlConfig, config.nickname);
      writeIdentity(identity);
      return { identity, source: "adopt-atl" };
    }
  }

  // 4. fresh identity
  const identity = createFreshIdentity(config.nickname);
  writeIdentity(identity);
  return { identity, source: "fresh" };
}
