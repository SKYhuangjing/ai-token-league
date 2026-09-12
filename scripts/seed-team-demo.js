#!/usr/bin/env node

// Seed demo participants tagged into admin teams so the admin team-analysis
// board has a reviewable dataset with every story state (steady / light /
// paused / new / rising). Deterministic: re-runs are skipped as duplicates.
//
// Usage:
//   node scripts/seed-team-demo.js --env env.test           # seed demo data
//   node scripts/seed-team-demo.js --env env.test --remove  # purge demo data
//
// Demo participants/teams use fixed `demo-` ids and 示例· nicknames so they are
// easy to spot on the leaderboard and safe to purge with --remove.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/backend/store.js";
import { MySqlStore } from "../src/backend/mysql-store.js";
import { generateIdentity } from "../src/shared/crypto.js";
import { computeDailyBucketFingerprint } from "../src/shared/schema.js";

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

const envFile = process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : "";
if (envFile) loadEnvFile(path.resolve(ROOT, envFile));

const REMOVE = process.argv.includes("--remove");

const DEMO_TEAMS = [
  { id: "demo-team-platform", name: "平台研发" },
  { id: "demo-team-product", name: "业务研发" }
];

// profile drives the usage pattern; the mix guarantees every analysis state:
// steady (≥3 active days), light (1–2), paused (prev window only), new
// (current window only), rising (more days than prev).
const DEMO_MEMBERS = [
  { id: "demo-pt-platform-1", nickname: "示例·陈晨", team: "demo-team-platform", profile: "steady", tools: ["codex", "claude"] },
  { id: "demo-pt-platform-2", nickname: "示例·林悦", team: "demo-team-platform", profile: "steady", tools: ["claude"] },
  { id: "demo-pt-platform-3", nickname: "示例·周航", team: "demo-team-platform", profile: "light", tools: ["codex"] },
  { id: "demo-pt-platform-4", nickname: "示例·王宁", team: "demo-team-platform", profile: "paused", tools: ["codex", "cursor"] },
  { id: "demo-pt-platform-5", nickname: "示例·李然", team: "demo-team-platform", profile: "new", tools: ["claude"] },
  { id: "demo-pt-product-1", nickname: "示例·沈佳", team: "demo-team-product", profile: "steady", tools: ["codex"] },
  { id: "demo-pt-product-2", nickname: "示例·何川", team: "demo-team-product", profile: "steady", tools: ["codex", "cursor"] },
  { id: "demo-pt-product-3", nickname: "示例·许诺", team: "demo-team-product", profile: "light", tools: ["cursor"] },
  { id: "demo-pt-product-4", nickname: "示例·唐乐", team: "demo-team-product", profile: "rising", tools: ["claude", "codex"] }
];

const TOOL_SOURCES = {
  codex: { providerId: "codex_local", model: "gpt-5" },
  claude: { providerId: "claude_code_local", model: "claude-sonnet-4-5" },
  cursor: { providerId: "cursor_dashboard_usage", model: "gpt-5" }
};

const WINDOW_DAYS = 35;

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Identities must stay stable across re-runs: registerDevice rejects a
// participant whose publicKey changed. Generated once, cached under data/.
const IDENTITY_CACHE_PATH = path.resolve(ROOT, "data/team-demo-identities.json");
function identityForMember(memberId) {
  let cache = {};
  if (fs.existsSync(IDENTITY_CACHE_PATH)) {
    cache = JSON.parse(fs.readFileSync(IDENTITY_CACHE_PATH, "utf8"));
  }
  if (!cache[memberId]) {
    cache[memberId] = generateIdentity();
    fs.mkdirSync(path.dirname(IDENTITY_CACHE_PATH), { recursive: true });
    fs.writeFileSync(IDENTITY_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
  }
  return cache[memberId];
}

function profileActive(profile, dayIndex, weekday, rand) {
  switch (profile) {
    case "steady": return weekday !== 0 && rand() < 0.92;
    case "light": return weekday >= 1 && weekday <= 5 && dayIndex % 7 === 2;
    case "paused": return dayIndex < WINDOW_DAYS - 12 && weekday !== 0;
    case "new": return dayIndex >= WINDOW_DAYS - 6 && weekday !== 0 && rand() < 0.85;
    case "rising": return weekday !== 0 && rand() < (dayIndex < WINDOW_DAYS - 14 ? 0.45 : 0.9);
    default: return false;
  }
}

function usageItemsForMember(member, days) {
  const rand = mulberry32(member.id.length * 7919 + member.profile.charCodeAt(0));
  const items = [];
  days.forEach((day, dayIndex) => {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (!profileActive(member.profile, dayIndex, weekday, rand)) return;
    const toolsToday = member.tools.length > 1 && rand() < 0.45 ? member.tools : [member.tools[Math.floor(rand() * member.tools.length)]];
    for (const tool of toolsToday) {
      const source = TOOL_SOURCES[tool];
      const scale = 0.8 + rand() * 1.6;
      const cacheRead = Math.round(520000 * scale);
      const input = Math.round(180000 * scale);
      const cacheWrite = Math.round(70000 * scale);
      const output = Math.round(95000 * scale);
      items.push({
        day,
        toolCode: tool,
        providerId: source.providerId,
        workdirHash: `demo-wd-${member.id}`,
        workdirDisplayName: "demo-league",
        model: source.model,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        reasoningTokens: Math.round(output * 0.4),
        totalTokens: input + output + cacheRead + cacheWrite,
        sourceQuality: "exact",
        rawSourceRef: "seed-team-demo",
        providerVersion: "0.7.15",
        parserVersion: "0.7.15",
        sourceFingerprint: `demo-${member.id}-${day}-${tool}`
      });
    }
  });
  return items;
}

async function main() {
  const dbType = String(process.env.DB_TYPE || "json").toLowerCase();
  const store = dbType === "mysql" ? await MySqlStore.create() : new Store(process.env.DB_PATH || path.resolve(ROOT, "data/db.json"));
  try {
    if (REMOVE) {
      let removed = 0;
      for (const member of DEMO_MEMBERS) {
        if (store.getParticipant(member.id)) {
          await store.deleteParticipantData(member.id);
          removed += 1;
        }
      }
      let removedTeams = 0;
      for (const team of DEMO_TEAMS) {
        if (store.db.teams?.[team.id]) {
          await store.deleteTeam(team.id);
          removedTeams += 1;
        }
      }
      console.log(JSON.stringify({ removed: true, dbType, participants: removed, teams: removedTeams }, null, 2));
      return;
    }

    const now = new Date().toISOString();
    for (const team of DEMO_TEAMS) {
      const existing = store.db.teams?.[team.id];
      const row = { id: team.id, name: team.name, createdAt: existing?.createdAt || now, updatedAt: now };
      store.db.teams ||= {};
      store.db.teams[team.id] = row;
      if (store.dbType === "mysql") await store.persistTeamRow(row);
      else store.save();
    }

    let seeded = 0;
    let skipped = 0;
    let usageRows = 0;
    const days = [];
    const today = store.currentBusinessDay();
    const endDate = new Date(`${today}T00:00:00Z`);
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const d = new Date(endDate);
      d.setUTCDate(endDate.getUTCDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }

    for (const member of DEMO_MEMBERS) {
      const identity = identityForMember(member.id);
      const deviceId = `demo-dev-${member.id}`;
      store.registerDevice({
        participantId: member.id,
        deviceId,
        nickname: member.nickname,
        identityPublicKey: identity.identityPublicKey,
        os: "demo",
        appVersion: "0.7.15"
      });
      // Upload through the daily snapshot protocol (device_day_provider) so the
      // MySQL path writes scoped buckets instead of rewriting the legacy usage
      // mirror — the legacy batch path is a full-table maintenance flow.
      const items = usageItemsForMember(member, days);
      const buckets = new Map();
      for (const item of items) {
        const key = `${item.day}|${item.providerId}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(item);
      }
      let memberSeeded = false;
      for (const bucketItems of buckets.values()) {
        const result = await store.upsertUsageBatch({
          participantId: member.id,
          deviceId,
          clientGeneratedAt: "2026-01-01T00:00:00.000Z",
          snapshot: {
            mode: "device_day_provider",
            day: bucketItems[0].day,
            providerId: bucketItems[0].providerId,
            bucketFingerprint: computeDailyBucketFingerprint(bucketItems),
            rowCount: bucketItems.length,
            totalTokens: bucketItems.reduce((sum, item) => sum + item.totalTokens, 0)
          },
          items: bucketItems
        });
        if (result.duplicate) skipped += 1;
        else {
          memberSeeded = true;
          usageRows += result.accepted || bucketItems.length;
        }
      }
      if (memberSeeded) seeded += 1;
      await store.setParticipantTeam(member.id, member.team);
      process.stdout.write(`.`);
    }
    process.stdout.write("\n");

    console.log(JSON.stringify({
      seeded: true,
      dbType,
      teams: DEMO_TEAMS.map((team) => team.name),
      participants: seeded,
      duplicatesSkipped: skipped,
      usageItems: usageRows,
      windowDays: WINDOW_DAYS
    }, null, 2));
  } finally {
    await store.close?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
