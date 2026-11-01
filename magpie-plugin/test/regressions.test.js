// Regression tests for issues found by the independent blind review
// (P0 lock, P1 exit codes / identity / nickname / since-day, P2 guards).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, readConfig, configPath, writeConfig } from "../lib/state.js";
import { resolveIdentity } from "../lib/identity.js";
import { integrityCheck, parseLedger } from "../lib/ledger.js";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SYNC = join(PLUGIN_DIR, "sync.js");

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "atl-reg-"));
  return dir;
}

function runSync(args, { stateDir, ledger }) {
  return spawnSync(process.execPath, [SYNC, ...args], {
    cwd: PLUGIN_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      MAGPIE_ATL_DIR: stateDir,
      MAGPIE_PLUGINS_JSON: join(stateDir, "plugins-absent.json"),
      MAGPIE_LEDGER: ledger || "",
      // Never touch a real gateway or a real magpie binary from tests: auto
      // mode must take its ledger fallback here (a dead loopback port
      // refuses instantly, and the CSV channel is switched off).
      MAGPIE_BIN: "none",
      MAGPIE_GATEWAY_URL: args.includes("--source") ? process.env.MAGPIE_GATEWAY_URL : "http://127.0.0.1:1"
    }
  });
}

const FIXTURE_LEDGER = [
  JSON.stringify({ route_id: 1, t: "2026-11-01T10:00:00+08:00", agent: "zcode", provider: "antigravity", model: "m", req: "antigravity/m", in: 100, out: 20, cache_read: 0, cache_write: 0, status: 200, response_id: "r1" }),
  JSON.stringify({ route_id: 2, t: "2026-11-01T11:00:00+08:00", agent: "codex", provider: "codex", model: "g", req: "g", in: 10, out: 5, cache_read: 0, cache_write: 0, status: 200, response_id: "r2" })
].join("\n") + "\n";

describe("P0: cross-process lock", () => {
  test("mutual exclusion actually serializes", async () => {
    const dir = sandbox();
    process.env.MAGPIE_ATL_DIR = dir;
    try {
      let inside = 0;
      let maxInside = 0;
      const worker = async () => {
        await withLock(async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await new Promise((r) => setTimeout(r, 250));
          inside -= 1;
        });
      };
      await Promise.all([worker(), worker(), worker()]);
      expect(maxInside).toBe(1);
    } finally {
      delete process.env.MAGPIE_ATL_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fresh lock is never stolen (owner.json is read, not the directory)", async () => {
    const dir = sandbox();
    process.env.MAGPIE_ATL_DIR = dir;
    try {
      // an active young lock held by another "process"
      mkdirSync(join(dir, ".lock"), { recursive: true });
      writeFileSync(join(dir, ".lock", "owner.json"), JSON.stringify({ pid: 999999, born: Date.now() }));
      let ran = false;
      await withLock(async () => {
        ran = true;
      }).then(
        () => { throw new Error("lock was stolen while fresh"); },
        (error) => {
          expect(String(error.message)).toMatch(/holding the lock/);
        }
      );
      expect(ran).toBe(false);
    } finally {
      delete process.env.MAGPIE_ATL_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000); // lock retry loop is 50 × 200ms by design; allow the full wait

  test("stale lock (older than 5 minutes) is taken over", async () => {
    const dir = sandbox();
    process.env.MAGPIE_ATL_DIR = dir;
    try {
      mkdirSync(join(dir, ".lock"), { recursive: true });
      writeFileSync(join(dir, ".lock", "owner.json"), JSON.stringify({ pid: 999999, born: Date.now() - 6 * 60 * 1000 }));
      let ran = false;
      await withLock(async () => {
        ran = true;
      });
      expect(ran).toBe(true);
    } finally {
      delete process.env.MAGPIE_ATL_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P1: identity and config hardening", () => {
  test("corrupted identity.json is a loud error, never a silent fresh identity", () => {
    const dir = sandbox();
    process.env.MAGPIE_ATL_DIR = dir;
    try {
      writeFileSync(join(dir, "identity.json"), "{ this is not json");
      expect(() => resolveIdentity({})).toThrow(/corrupt/);
      expect(readFileSync(join(dir, "identity.json"), "utf8")).toContain("this is not json"); // untouched
      expect(existsSync(join(dir, "identity.json.tmp"))).toBe(false);
    } finally {
      delete process.env.MAGPIE_ATL_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("nickname override renames the existing identity and persists", () => {
    const dir = sandbox();
    process.env.MAGPIE_ATL_DIR = dir;
    try {
      const first = resolveIdentity({ nickname: "alice" });
      expect(first.source).toBe("fresh");
      const renamed = resolveIdentity({ nickname: "bob" });
      expect(renamed.source).toBe("store-renamed");
      expect(renamed.identity.nickname).toBe("bob");
      expect(renamed.identity.participantId).toBe(first.identity.participantId);
      const stored = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
      expect(stored.nickname).toBe("bob");
    } finally {
      delete process.env.MAGPIE_ATL_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("apiBaseUrl is normalized (trailing slashes collapse to one manifest key)", () => {
    const dir = sandbox();
    process.env.MAGPIE_ATL_DIR = dir;
    process.env.MAGPIE_PLUGINS_JSON = join(dir, "plugins-absent.json");
    try {
      writeConfig({ apiBaseUrl: "http://127.0.0.1:8787/" });
      expect(readConfig({}).apiBaseUrl).toBe("http://127.0.0.1:8787");
      writeConfig({ apiBaseUrl: "http://127.0.0.1:8787///" });
      expect(readConfig({}).apiBaseUrl).toBe("http://127.0.0.1:8787");
      expect(configPath()).toContain(dir);
    } finally {
      delete process.env.MAGPIE_ATL_DIR;
      delete process.env.MAGPIE_PLUGINS_JSON;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P1: CLI contract (child process, sandboxed)", () => {
  test("invalid --since-day is refused loudly (no silent data wipe)", () => {
    const dir = sandbox();
    const ledger = join(dir, "ledger.jsonl");
    writeFileSync(ledger, FIXTURE_LEDGER);
    const result = runSync(["--dry-run", "--since-day", "2026/11/01", "--ledger", ledger], { stateDir: dir });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/invalid --since-day/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no API configured refuses to sync (exit 1), dry-run still works", () => {
    const dir = sandbox();
    const ledger = join(dir, "ledger.jsonl");
    writeFileSync(ledger, FIXTURE_LEDGER);
    const refused = runSync(["--ledger", ledger], { stateDir: dir });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/no API base URL configured/);
    const dry = runSync(["--dry-run", "--ledger", ledger], { stateDir: dir });
    expect(dry.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("shape drift exits 3 with a clean message (no stack dump)", () => {
    const dir = sandbox();
    const ledger = join(dir, "ledger.jsonl");
    const lines = [];
    for (let i = 0; i < 10; i += 1) lines.push(FIXTURE_LEDGER.split("\n")[0]);
    for (let i = 0; i < 6; i += 1) lines.push("totally not json {{{");
    writeFileSync(ledger, lines.join("\n") + "\n");
    const result = runSync(["--dry-run", "--ledger", ledger], { stateDir: dir });
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/shape drift/);
    expect(result.stderr).not.toMatch(/at \w+ \(.*sync\.js/); // no stack frames
    rmSync(dir, { recursive: true, force: true });
  });

  test("--test-connection against a dead port returns clean JSON, exit 1 (no crash dump)", () => {
    const dir = sandbox();
    const result = runSync(["--test-connection", "--api", "http://127.0.0.1:9"], { stateDir: dir });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/"ok": false/);
    expect(result.stdout).toMatch(/"error"/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("P2: integrity guards", () => {
  test("negative token fields are integrity issues", () => {
    const check = integrityCheck([{ route_id: 1, t: "2026-11-01T10:00:00+08:00", in: -100, out: 200, response_id: "x" }]);
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/negative in/);
  });

  test("two malformed lines in a small file trip the shape fuse; one does not", () => {
    const goodRow = FIXTURE_LEDGER.split("\n")[0];
    const oneBad = [goodRow, goodRow, goodRow, goodRow, "truncated {\"route_id\":3"].join("\n");
    expect(() => parseLedger(oneBad)).not.toThrow();
    const twoBad = [goodRow, goodRow, goodRow, goodRow, "garbage{", "garbage{"].join("\n");
    expect(() => parseLedger(twoBad)).toThrow(/shape drift/);
  });
});
