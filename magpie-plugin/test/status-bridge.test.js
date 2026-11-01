// P0 design implementation tests (doc/page-content-design.md §3.3/§3.5/§7):
// failures must reach status.js, successes must carry identity fields and
// the board standing snapshot (serverProfile: rank + persistence stats).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchBoardProfile } from "../lib/board-query.js";
import { readStatus, writeStatus } from "../lib/state.js";

const PLUGIN_DIR = join(import.meta.dir, "..");
const SYNC = join(PLUGIN_DIR, "sync.js");

function mockGateway(handler) {
  const server = Bun.serve({ port: 0, fetch: handler });
  return server;
}

// a whole miniature ATL server: register + batch upload + board profile +
// daily identity. Captures every request path for displayId assertions.
function mockAtl({ profileBody, identityBody } = {}) {
  const paths = [];
  const server = mockGateway((req) => {
    const url = new URL(req.url);
    paths.push(url.pathname);
    if (url.pathname === "/api/devices/register") return Response.json({ ok: true, serverTime: new Date().toISOString() });
    if (url.pathname === "/api/usage/daily-batches") {
      return req.json().then((body) => Response.json({
        results: body.batches.map((b) => ({ accepted: b.snapshot.rowCount, rejected: 0 }))
      }));
    }
    if (url.pathname.startsWith("/api/board/profile/")) {
      return Response.json(profileBody ?? {
        rank: 3, currentStreak: 42, bestStreak: 50, activeDays: 220,
        peakDay: { day: "2026-08-22", totalTokens: 1109649487 }
      });
    }
    if (url.pathname === "/api/board/my-identity") {
      return Response.json(identityBody ?? { identityMode: "anonymous", publicId: "pub_abc", displayName: "Anonymous-Test-Name", businessDay: "2026-11-01" });
    }
    return new Response("nope", { status: 404 });
  });
  return { server, paths };
}

async function runSync(args, extraEnv, prepare) {
  const stateDir = mkdtempSync(join(tmpdir(), "atl-design-"));
  if (prepare) prepare(stateDir);
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

describe("fetchBoardProfile", () => {
  test("parses the standing and normalizes the snapshot", async () => {
    const { server } = mockAtl();
    const profile = await fetchBoardProfile({ apiBaseUrl: `http://127.0.0.1:${server.port}`, displayId: "pub_x" });
    expect(profile.rank).toBe(3);
    expect(profile.currentStreak).toBe(42);
    expect(profile.activeDays).toBe(220);
    expect(profile.peakDay).toEqual({ day: "2026-08-22", totalTokens: 1109649487 });
    expect(profile.error).toBeNull();
    server.stop(true);
  });

  test("401, 404 and unreachable are typed failures, not crashes", async () => {
    const guarded = mockGateway(() => new Response("no", { status: 401 }));
    await expect(
      fetchBoardProfile({ apiBaseUrl: `http://127.0.0.1:${guarded.port}`, displayId: "pub_x" })
    ).rejects.toThrow(/sign-in/);
    guarded.stop(true);
    const missing = mockGateway(() => new Response("gone", { status: 404 }));
    await expect(
      fetchBoardProfile({ apiBaseUrl: `http://127.0.0.1:${missing.port}`, displayId: "pub_x" })
    ).rejects.toThrow(/not found/);
    missing.stop(true);
    await expect(
      fetchBoardProfile({ apiBaseUrl: "http://127.0.0.1:1", displayId: "pub_x" })
    ).rejects.toThrow(/unreachable/);
  });
});

describe("status bridge (P0)", () => {
  test("a successful sync writes identity fields and the standing snapshot", async () => {
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
    const { status: exit, readBack } = await runSync(["--source", "gateway", "--api", `http://127.0.0.1:${atl.server.port}`, "--nickname", "design-nick"], {
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
    expect(st.serverProfile.rank).toBe(3);
    expect(st.serverProfile.currentStreak).toBe(42);
    expect(st.serverIdentity.identityMode).toBe("anonymous");
    expect(st.serverIdentity.displayName).toBe("Anonymous-Test-Name");
    expect(st.serverIdentity.avatarColor).toMatch(/^#[0-9a-f]{6}$/);
    // the anonymous board's publicId is the profile displayId
    expect(atl.paths).toContain("/api/board/profile/pub_abc");
    atl.server.stop(true);
    gw.stop(true);
  });

  test("a failed run writes ok:false + error and keeps the old nickname/standing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "atl-design-fail-"));
    process.env.MAGPIE_ATL_DIR = stateDir;
    try {
      writeStatus({ ok: true, nickname: "kept-nick", participantId: "p_kept", serverProfile: { rank: 5, currentStreak: 9, fetchedAt: new Date().toISOString() } });
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
    expect(st.serverProfile.rank).toBe(5);
  });

  test("dry-run failures stay silent (no status poison)", async () => {
    const { readBack } = await runSync(["--source", "gateway", "--dry-run"], {
      MAGPIE_GATEWAY_URL: "http://127.0.0.1:1"
    });
    expect(readBack()).toBeNull();
  });
});

describe("board standing snapshot", () => {
  test("a public board leaves no serverIdentity and queries the profile with the raw participant id", async () => {
    const atl = mockAtl({ identityBody: { identityMode: "public", displayName: "" } });
    const gw = mockGateway(() => new Response(JSON.stringify({
      rows: [{ t: "2026-11-01T10:00:00+08:00", agent: "zcode", provider: "p", model: "m", in: 1, out: 1, cache_read: 0, cache_write: 0, reasoning: 0, status: 0, source: "log" }],
      total: 1, offset: 0
    }), { headers: { "content-type": "application/json" } }));
    const { status: exit, readBack } = await runSync(["--source", "gateway", "--api", `http://127.0.0.1:${atl.server.port}`], {
      MAGPIE_GATEWAY_URL: `http://127.0.0.1:${gw.port}`
    });
    expect(exit).toBe(0);
    const st = readBack();
    expect(st.serverProfile.rank).toBe(3);
    expect(st.serverIdentity).toBeUndefined(); // public board: no alias slot
    const profilePath = atl.paths.find((p) => p.startsWith("/api/board/profile/"));
    expect(profilePath).toMatch(/\/api\/board\/profile\/p_/); // participantId fallback
    atl.server.stop(true);
    gw.stop(true);
  });

  test("a legacy serverRank snapshot never survives into the new status shape", async () => {
    const atl = mockAtl();
    const gw = mockGateway(() => new Response(JSON.stringify({
      rows: [{ t: "2026-11-01T10:00:00+08:00", agent: "zcode", provider: "p", model: "m", in: 1, out: 1, cache_read: 0, cache_write: 0, reasoning: 0, status: 0, source: "log" }],
      total: 1, offset: 0
    }), { headers: { "content-type": "application/json" } }));
    const { status: exit, readBack } = await runSync(
      ["--source", "gateway", "--api", `http://127.0.0.1:${atl.server.port}`],
      { MAGPIE_GATEWAY_URL: `http://127.0.0.1:${gw.port}` },
      (stateDir) => {
        // simulate an upgraded install whose last status still carries the
        // pre-profile rank snapshot; writeStatus must target the sandbox dir
        process.env.MAGPIE_ATL_DIR = stateDir;
        try {
          writeStatus({ ok: true, serverRank: { rank: 7, participantCount: 9, fetchedAt: "2026-10-01T00:00:00.000Z" } });
        } finally {
          delete process.env.MAGPIE_ATL_DIR;
        }
      }
    );
    expect(exit).toBe(0);
    const st = readBack();
    expect(st.serverProfile.rank).toBe(3);
    expect(st.serverRank).toBeUndefined(); // the old shape never reaches the page
    atl.server.stop(true);
    gw.stop(true);
  });
});
