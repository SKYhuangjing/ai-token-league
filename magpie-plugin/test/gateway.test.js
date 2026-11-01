import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GatewayError,
  GATEWAY_PAGE_LIMIT,
  resolveGatewayBaseUrl,
  fetchGatewayUsage,
  apiRowsToRows,
  gatewayIntegrity,
  windowPeriod
} from "../lib/gateway.js";
import { partitionUploadRows } from "../lib/ledger.js";

// --- base URL resolution ---------------------------------------------------

describe("resolveGatewayBaseUrl", () => {
  test("MAGPIE_GATEWAY_URL wins and drops trailing slashes", () => {
    expect(resolveGatewayBaseUrl({ MAGPIE_GATEWAY_URL: "http://127.0.0.1:9999//" })).toBe("http://127.0.0.1:9999");
  });

  test("MAGPIE_ADDR is honoured (with and without port)", () => {
    expect(resolveGatewayBaseUrl({ MAGPIE_ADDR: "http://127.0.0.1:8123" })).toBe("http://127.0.0.1:8123");
    expect(resolveGatewayBaseUrl({ MAGPIE_ADDR: "http://127.0.0.1" })).toBe(`http://127.0.0.1:3425`);
  });

  test("settings.json port beats the default; garbage env URLs refuse", () => {
    const home = mkdtempSync(join(tmpdir(), "atl-gw-home-"));
    mkdirSync(join(home, ".config", "magpie"), { recursive: true });
    writeFileSync(join(home, ".config", "magpie", "settings.json"), JSON.stringify({ port: 4567 }));
    expect(resolveGatewayBaseUrl({ HOME: home })).toBe("http://127.0.0.1:4567");
    // the host hands children MAGPIE_ADDR without a scheme — that works
    expect(resolveGatewayBaseUrl({ MAGPIE_ADDR: "127.0.0.1:3425" })).toBe("http://127.0.0.1:3425");
    // a host-less spelling is still refused
    expect(() => resolveGatewayBaseUrl({ MAGPIE_GATEWAY_URL: "http://" })).toThrow(GatewayError);
  });
});

// --- fetching (mock gateway) -----------------------------------------------

const rows = (n, offset) =>
  Array.from({ length: n }, (_, i) => ({
    t: `2026-11-01T0${(offset + i) % 10}:00:00+08:00`,
    agent: "zcode",
    provider: "session-unknown",
    model: "GLM-5.3",
    in: 100 + offset + i,
    out: 10,
    cache_read: 5,
    cache_write: 0,
    reasoning: 1,
    status: 0,
    source: "log",
    session: "sess_should_not_survive",
    providerAccount: "someone@example.com"
  }));

function mockGateway(handler) {
  const server = Bun.serve({ port: 0, fetch: handler });
  afterAll(() => server.stop(true));
  return server;
}

describe("fetchGatewayUsage", () => {
  test("paginates through every page and totals up", async () => {
    const total = GATEWAY_PAGE_LIMIT + 3;
    const server = mockGateway((req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/v1/magpie/usage/requests") return new Response("nope", { status: 404 });
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      const slice = rows(Math.max(0, Math.min(limit, total - offset)), offset);
      return Response.json({
        rows: slice,
        total,
        offset,
        through: { calls: 2 },
        direct: { calls: total - 2 }
      });
    });
    const got = await fetchGatewayUsage({ baseUrl: `http://127.0.0.1:${server.port}`, period: "7d" });
    expect(got.rows.length).toBe(total);
    expect(got.total).toBe(total);
    expect(got.through.calls).toBe(2);
    expect(got.direct.calls).toBe(total - 2);
  });

  test("HTTP error, non-JSON and shape drift each refuse", async () => {
    const server = mockGateway((req) => {
      const url = new URL(req.url);
      if (url.searchParams.get("offset") === "0" && url.searchParams.get("limit") === "500") {
        return new Response("boom", { status: 500 });
      }
      return Response.json({});
    });
    await expect(
      fetchGatewayUsage({ baseUrl: `http://127.0.0.1:${server.port}` })
    ).rejects.toThrow(/HTTP 500/);

    const notJson = mockGateway(() => new Response("<html>"));
    await expect(
      fetchGatewayUsage({ baseUrl: `http://127.0.0.1:${notJson.port}` })
    ).rejects.toThrow(/non-JSON/);

    const noRows = mockGateway(() => Response.json({ something: 1 }));
    await expect(
      fetchGatewayUsage({ baseUrl: `http://127.0.0.1:${noRows.port}` })
    ).rejects.toThrow(/shape drift/);
  });

  test("a dead gateway is a GatewayError (never a crash)", async () => {
    await expect(
      fetchGatewayUsage({ baseUrl: "http://127.0.0.1:1" })
    ).rejects.toThrow(GatewayError);
  });
});

// --- row mapping / integrity / partitioning --------------------------------

describe("apiRowsToRows", () => {
  test("maps pipeline fields and drops PII carriers", () => {
    const [row] = apiRowsToRows(rows(1, 0));
    expect(row).toEqual({
      t: "2026-11-01T00:00:00+08:00",
      agent: "zcode",
      provider: "session-unknown",
      model: "GLM-5.3",
      in: 100,
      out: 10,
      cache_read: 5,
      cache_write: 0,
      reasoning: 1,
      cost: 0,
      status: 0,
      source: "log"
    });
    expect("session" in row).toBe(false);
    expect("providerAccount" in row).toBe(false);
  });

  test("non-finite numbers coerce to 0, junk rows are skipped", () => {
    const [row] = apiRowsToRows([{ t: "x", agent: "zcode", in: "abc" }]);
    expect(row.in).toBe(0);
    expect(apiRowsToRows([null, 5])).toEqual([]);
  });
});

describe("gatewayIntegrity", () => {
  test("negative tokens and unparseable timestamps refuse", () => {
    const bad = gatewayIntegrity([
      { t: "2026-11-01T00:00:00+08:00", in: -1 },
      { t: "not-a-time", in: 1 }
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.issues.length).toBe(2);
    expect(gatewayIntegrity([{ t: "2026-11-01T00:00:00+08:00", in: 1 }]).ok).toBe(true);
  });
});

describe("windowPeriod", () => {
  test("presets and the full-history fallback", () => {
    expect(windowPeriod(1)).toBe("today");
    expect(windowPeriod(7)).toBe("7d");
    expect(windowPeriod(30)).toBe("30d");
    expect(windowPeriod(0)).toBe("all");
    expect(windowPeriod(3)).toBe("all");
  });
});

describe("partitionUploadRows", () => {
  test("keeps mapped agents and magpie, counts unknown agents out", () => {
    const { rows: keep, skippedAgents } = partitionUploadRows([
      { agent: "zcode", t: "2026-11-01T00:00:00+08:00", in: 1 },
      { agent: "kimi", t: "2026-11-01T00:00:00+08:00", in: 1 },
      { agent: "magpie", t: "2026-11-01T00:00:00+08:00", in: 1 },
      { agent: "minimax", t: "2026-11-01T00:00:00+08:00", in: 1 },
      { agent: "qoder", t: "2026-11-01T00:00:00+08:00", in: 1 },
      { agent: "qoder", t: "2026-11-01T01:00:00+08:00", in: 1 }
    ]);
    expect(keep.map((r) => r.agent).sort()).toEqual(["kimi", "magpie", "zcode"]);
    expect(Object.fromEntries(skippedAgents)).toEqual({ minimax: 1, qoder: 2 });
  });
});

// --- child-process contract (sync.js against a mock gateway) ---------------

import { spawnSync } from "node:child_process";

const PLUGIN_DIR = join(import.meta.dir, "..");
const SYNC = join(PLUGIN_DIR, "sync.js");

// Async on purpose: the mock gateway lives in THIS process, and spawnSync
// would block the event loop that has to answer the child's fetches.
async function runSync(args, extraEnv) {
  const stateDir = mkdtempSync(join(tmpdir(), "atl-gw-sync-"));
  const proc = Bun.spawn([process.execPath, SYNC, ...args], {
    cwd: PLUGIN_DIR,
    env: {
      ...process.env,
      MAGPIE_ATL_DIR: stateDir,
      MAGPIE_PLUGINS_JSON: join(stateDir, "plugins-absent.json"),
      MAGPIE_LEDGER: "",
      // Never let a child reach this machine's real magpie binary: the CSV
      // channel must come only from an explicit fixture (or stay off).
      MAGPIE_BIN: "none",
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
  return { res: { status, stdout, stderr }, stateDir };
}

describe("sync.js gateway source (child process)", () => {
  test("--source gateway dry-run reads the mock and prints the unified source line", async () => {
    const server = mockGateway((req) => {
      const url = new URL(req.url);
      const offset = Number(url.searchParams.get("offset"));
      const page = rows(2, offset);
      return Response.json({ rows: page, total: 2, offset, through: { calls: 0 }, direct: { calls: 2 } });
    });
    const { res } = await runSync(["--source", "gateway", "--dry-run"], {
      MAGPIE_GATEWAY_URL: `http://127.0.0.1:${server.port}`
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("source: gateway");
    expect(res.stdout).toContain("direct 2 calls");
    expect(res.stdout).toContain("zcode_local");
  });

  test("--source gateway against a dead gateway exits 1 loudly", async () => {
    const { res } = await runSync(["--source", "gateway", "--dry-run"], {
      MAGPIE_GATEWAY_URL: "http://127.0.0.1:1"
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/gateway usage API unreachable/);
  });

  test("auto mode falls back to the ledger file when the gateway is dead", async () => {
    const home = mkdtempSync(join(tmpdir(), "atl-gw-fb-"));
    const ledger = join(home, "usage.jsonl");
    writeFileSync(
      ledger,
      [
        JSON.stringify({ route_id: 1, t: "2026-11-01T10:00:00+08:00", agent: "zcode", provider: "antigravity", model: "m", req: "antigravity/m", in: 100, out: 20, cache_read: 0, cache_write: 0, status: 200, response_id: "r1" })
      ].join("\n") + "\n"
    );
    const { res } = await runSync(["--dry-run"], {
      MAGPIE_GATEWAY_URL: "http://127.0.0.1:1",
      MAGPIE_LEDGER: ledger
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("source: ledger");
    expect(res.stdout).toContain("zcode_local");
  });
});
