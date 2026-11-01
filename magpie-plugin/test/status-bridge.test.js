// P0 design implementation tests (doc/page-content-design.md §3.3/§3.5/§7):
// failures must reach status.js, successes must carry identity fields and
// the board-rank snapshot.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchBoardRank } from "../lib/board-query.js";
import { readStatus, writeStatus } from "../lib/state.js";

const PLUGIN_DIR = join(import.meta.dir, "..");
const SYNC = join(PLUGIN_DIR, "sync.js");

function mockGateway(handler) {
  const server = Bun.serve({ port: 0, fetch: handler });
  return server;
}

// a whole miniature ATL server: register + batch upload + board analytics
function mockAtl() {
  return mockGateway((req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/devices/register") return Response.json({ ok: true, serverTime: new Date().toISOString() });
    if (url.pathname === "/api/usage/daily-batches") {
      return req.json().then((body) => Response.json({
        results: body.batches.map((b) => ({ accepted: b.snapshot.rowCount, rejected: 0 }))
      }));
    }
    if (url.pathname === "/api/board/analytics") {
      return Response.json({ rankStats: { rank: 3, participantCount: 12, leaderDays: 4, isLeaderToday: false }, summary: { totalTokens: 123 } });
    }
    if (url.pathname === "/api/board/my-identity") {
      return Response.json({ identityMode: "anonymous", publicId: "pub_abc", displayName: "Anonymous-Test-Name", businessDay: "2026-11-01" });
    }
    return new Response("nope", { status: 404 });
  });
}

async function runSync(args, extraEnv) {
  const stateDir = mkdtempSync(join(tmpdir(), "atl-design-"));
  const proc = Bun.spawn([process.execPath, SYNC, ...args], {
    cwd: PLUGIN_DIR,
    env: {
      ...process.env,
      MAGPIE_ATL_DIR: stateDir,
      MAGPIE_PLUGINS_JSON: join(stateDir, "plugins-absent.json"),
      MAGPIE_LEDGER: "",
      MAGPIE_BIN: "none",
      MAGPIE_GATEWAY_URL: "http://127.0.0.1:1",
      ...extraEnv
    },
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  const readBack = () => {
    try {
      const text = readFileSync(join(stateDir, "status.js"), "utf8");
      return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    } catch {
      return null;
    }
  };
  return { status, stdout, stderr, stateDir, readBack };
}

describe("fetchBoardRank", () => {
  test("parses rankStats and normalizes the snapshot", async () => {
    const server = mockAtl();
    const rank = await fetchBoardRank({ apiBaseUrl: `http://127.0.0.1:${server.port}`, participantId: "p_x" });
    expect(rank.rank).toBe(3);
    expect(rank.participantCount).toBe(12);
    expect(rank.leaderDays).toBe(4);
    expect(rank.error).toBeNull();
    server.stop(true);
  });

  test("401 and unreachable are typed failures, not crashes", async () => {
    const guarded = mockGateway(() => new Response("no", { status: 401 }));
    await expect(
      fetchBoardRank({ apiBaseUrl: `http://127.0.0.1:${guarded.port}`, participantId: "p_x" })
    ).rejects.toThrow(/sign-in/);
    guarded.stop(true);
    await expect(
      fetchBoardRank({ apiBaseUrl: "http://127.0.0.1:1", participantId: "p_x" })
    ).rejects.toThrow(/unreachable/);
  });
});

describe("status bridge (P0)", () => {
  test("a successful sync writes nickname, deviceId, channel and the board rank", async () => {
    const atl = mockAtl();
    const gw = mockGateway(() => {
      const url = new URL("http://x/v1/magpie/usage/requests?offset=0");
      return Response.json({
        rows: [{
          t: "2026-11-01T10:00:00+08:00", agent: "zcode", provider: "session-unknown",
          model: "GLM-5.3", in: 100, out: 20, cache_read: 5, cache_write: 0,
          reasoning: 0, status: 0, source: "log"
        }],
        total: 1, offset: 0, through: { calls: 0 }, direct: { calls: 1 }
      });
    });
    const { status: exit, readBack } = await runSync(["--source", "gateway", "--api", `http://127.0.0.1:${atl.port}`, "--nickname", "design-nick"], {
      MAGPIE_GATEWAY_URL: `http://127.0.0.1:${gw.port}`
    });
    expect(exit).toBe(0);
    const st = readBack();
    expect(st.ok).toBe(true);
    expect(st.nickname).toBe("design-nick");
    expect(st.deviceId).toMatch(/^d_/);
    expect(st.participantId).toMatch(/^p_/);
    expect(st.sourceChannel).toBe("api");
    expect(st.firstSyncStart).toBeTruthy();
    expect(st.serverRank.rank).toBe(3);
    expect(st.serverRank.participantCount).toBe(12);
    expect(st.serverIdentity.identityMode).toBe("anonymous");
    expect(st.serverIdentity.displayName).toBe("Anonymous-Test-Name");
    expect(st.serverIdentity.avatarColor).toMatch(/^#[0-9a-f]{6}$/);
    atl.stop(true);
    gw.stop(true);
  });

  test("a failed run writes ok:false + error and keeps the old nickname/rank", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "atl-design-fail-"));
    process.env.MAGPIE_ATL_DIR = stateDir;
    try {
      writeStatus({ ok: true, nickname: "kept-nick", participantId: "p_kept", serverRank: { rank: 5, participantCount: 9, fetchedAt: new Date().toISOString() } });
      expect(readStatus().nickname).toBe("kept-nick");
    } finally {
      delete process.env.MAGPIE_ATL_DIR;
    }
    // same state dir via env: a pinned gateway source against a dead port fails
    const proc = Bun.spawn([process.execPath, SYNC, "--source", "gateway", "--api", "http://127.0.0.1:1"], {
      cwd: PLUGIN_DIR,
      env: { ...process.env, MAGPIE_ATL_DIR: stateDir, MAGPIE_PLUGINS_JSON: "/tmp/none.json", MAGPIE_LEDGER: "", MAGPIE_BIN: "none", MAGPIE_GATEWAY_URL: "http://127.0.0.1:1" },
      stdout: "pipe", stderr: "pipe"
    });
    const [, , exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exit).toBe(1);
    const text = readFileSync(join(stateDir, "status.js"), "utf8");
    const st = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    expect(st.ok).toBe(false);
    expect(st.error).toMatch(/unreachable/);
    expect(st.nickname).toBe("kept-nick"); // preserved, not blanked
    expect(st.serverRank.rank).toBe(5);
  });

  test("dry-run failures stay silent (no status poison)", async () => {
    const { readBack } = await runSync(["--source", "gateway", "--dry-run"], {
      MAGPIE_GATEWAY_URL: "http://127.0.0.1:1"
    });
    expect(readBack()).toBeNull();
  });
});

describe("anonymous board alias", () => {
  test("a public board leaves no serverIdentity in the status", async () => {
    const atl = mockGateway((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/devices/register") return Response.json({ ok: true, serverTime: new Date().toISOString() });
      if (url.pathname === "/api/usage/daily-batches") {
        return req.json().then((body) => Response.json({ results: body.batches.map((b) => ({ accepted: b.snapshot.rowCount, rejected: 0 })) }));
      }
      if (url.pathname === "/api/board/analytics") {
        return Response.json({ rankStats: { rank: 1, participantCount: 2, leaderDays: 0, isLeaderToday: true }, summary: { totalTokens: 5 } });
      }
      if (url.pathname === "/api/board/my-identity") {
        return Response.json({ identityMode: "public", displayName: "" });
      }
      return new Response("nope", { status: 404 });
    });
    const gw = mockGateway(() => new Response(JSON.stringify({
      rows: [{ t: "2026-11-01T10:00:00+08:00", agent: "zcode", provider: "p", model: "m", in: 1, out: 1, cache_read: 0, cache_write: 0, reasoning: 0, status: 0, source: "log" }],
      total: 1, offset: 0
    }), { headers: { "content-type": "application/json" } }));
    const { status: exit, readBack } = await runSync(["--source", "gateway", "--api", `http://127.0.0.1:${atl.port}`], {
      MAGPIE_GATEWAY_URL: `http://127.0.0.1:${gw.port}`
    });
    expect(exit).toBe(0);
    const st = readBack();
    expect(st.serverRank.rank).toBe(1);
    expect(st.serverIdentity).toBeUndefined(); // public board: no alias slot
    atl.stop(true);
    gw.stop(true);
  });
});
