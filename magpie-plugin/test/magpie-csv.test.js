import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CsvError, findMagpieBinary, runUsageCsv, parseUsageCsv } from "../lib/magpie-csv.js";
import { localDayAndHour } from "../lib/atl.js";

const HEADER =
  "time,agent,requested_model,provider,host,model,served_model,swapped,effort,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,reasoning_tokens,cost_usd,status,session,kind,provider_account,source,rejected";

const csvOf = (lines) => [HEADER, ...lines].join("\n") + "\n";

describe("parseUsageCsv", () => {
  test("maps needed columns, drops rejected rows and PII", () => {
    const { rows, rejected } = parseUsageCsv(
      csvOf([
        "2026-11-01T09:00:00+08:00,zcode,antigravity/glm,zhipu,h,glm,GLM-5.3,false,,100,20,0,300,1,0,200,sess_x,thread_title,someone@example.com,log,false",
        "2026-11-01T10:00:00+08:00,codex,,codex,,gpt,gpt,false,,10,5,0,0,0,0,200,sess_y,,other@example.com,,false",
        "2026-11-01T11:00:00+08:00,codex,,codex,,gpt,gpt,false,,1,1,0,0,0,0,429,sess_z,,a@b.c,,true"
      ])
    );
    expect(rejected).toBe(1);
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({
      t: "2026-11-01T09:00:00+08:00",
      agent: "zcode",
      provider: "zhipu",
      model: "antigravity/glm",
      in: 100,
      out: 20,
      cache_read: 300,
      cache_write: 0,
      reasoning: 1,
      cost: 0,
      status: 200,
      source: "log",
      callerKeyId: ""
    });
    expect(rows[1].model).toBe("gpt"); // falls back to model, then served
    for (const row of rows) {
      expect("session" in row).toBe(false);
      expect("providerAccount" in row).toBe(false);
    }
  });

  test("extracts caller_key_id when present in the header", () => {
    const customHeader = `${HEADER},caller_key_id`;
    const { rows } = parseUsageCsv(
      [
        customHeader,
        "2026-11-01T09:00:00+08:00,zcode,m,p,h,m,s,false,,1,1,0,0,0,0,200,s1,,acc,gateway,false,key_123"
      ].join("\n") + "\n"
    );
    expect(rows[0].callerKeyId).toBe("key_123");
    expect(rows[0].source).toBe("gateway");
  });

  test("quoted fields with commas, doubled quotes and CRLF parse intact", () => {
    const { rows } = parseUsageCsv(
      [
        HEADER,
        '2026-11-01T09:00:00+08:00,zcode,"a,b","say ""hi""",h,"m,x",served,false,,1,2,0,3,0,0,200,s1,,acc@x,log,false'
      ].join("\r\n") + "\r\n"
    );
    expect(rows[0].model).toBe("a,b");
    expect(rows[0].provider).toBe('say "hi"');
    expect(rows[0].in).toBe(1);
  });

  test("empty input and missing columns refuse loudly", () => {
    expect(() => parseUsageCsv("")).toThrow(CsvError);
    expect(() => parseUsageCsv("a,b\n1,2\n")).toThrow(/missing columns/);
  });
});

describe("findMagpieBinary", () => {
  test("MAGPIE_BIN=none disables the channel; an explicit path wins", () => {
    const bin = join(mkdtempSync(join(tmpdir(), "atl-bin-")), "magpie");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const saved = process.env.MAGPIE_BIN;
    try {
      process.env.MAGPIE_BIN = bin;
      expect(findMagpieBinary()).toBe(bin);
      process.env.MAGPIE_BIN = "none";
      expect(findMagpieBinary()).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.MAGPIE_BIN;
      else process.env.MAGPIE_BIN = saved;
    }
  });
});

describe("runUsageCsv", () => {
  test("captures stdout and passes the period; failures are CsvErrors", async () => {
    const bin = join(mkdtempSync(join(tmpdir(), "atl-bin-")), "magpie");
    writeFileSync(bin, "#!/bin/sh\necho \"period=$3\"\n", { mode: 0o755 });
    await expect(runUsageCsv({ binary: bin, period: "7d" })).resolves.toContain("period=7d");

    // rolling-day windows: {days:N} becomes --csv --days N (incremental reads)
    const win = join(mkdtempSync(join(tmpdir(), "atl-bin-")), "magpie");
    writeFileSync(win, "#!/bin/sh\necho \"$@\"\n", { mode: 0o755 });
    await expect(runUsageCsv({ binary: win, period: { days: 7 } })).resolves.toContain("--csv --days 7");

    const failing = join(mkdtempSync(join(tmpdir(), "atl-bin-")), "magpie");
    writeFileSync(failing, "#!/bin/sh\necho oops >&2\nexit 3\n", { mode: 0o755 });
    await expect(runUsageCsv({ binary: failing })).rejects.toThrow(CsvError);
  });
});

// --- child-process contract (CSV channel end to end) -----------------------

import { spawnSync } from "node:child_process";

const PLUGIN_DIR = join(import.meta.dir, "..");
const SYNC = join(PLUGIN_DIR, "sync.js");

test("sync.js --source gateway dry-run rides the CSV channel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atl-csv-sync-"));
  const bin = join(dir, "magpie-fake");
  writeFileSync(
    bin,
    "#!/bin/sh\n" +
      // $1=usage $2=--csv $3=period
      'printf "%s\\n" "time,agent,requested_model,provider,model,served_model,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,reasoning_tokens,cost_usd,status,source,rejected"\n' +
      'printf "%s\\n" "2026-11-01T09:00:00+08:00,zcode,glm-5.3,zhipu,glm-5.3,GLM-5.3,100,20,0,300,1,0.05,200,log,false"\n',
    { mode: 0o755 }
  );
  const stateDir = mkdtempSync(join(tmpdir(), "atl-csv-state-"));
  const proc = Bun.spawn([process.execPath, SYNC, "--source", "gateway", "--dry-run"], {
    cwd: PLUGIN_DIR,
    env: {
      ...process.env,
      MAGPIE_ATL_DIR: stateDir,
      MAGPIE_PLUGINS_JSON: join(stateDir, "plugins-absent.json"),
      MAGPIE_LEDGER: "",
      MAGPIE_BIN: bin,
      MAGPIE_GATEWAY_URL: "http://127.0.0.1:1"
    },
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  expect(status).toBe(0);
  expect(stdout).toContain("source: gateway csv (full history)");
  expect(stdout).toContain("zcode_local");
  expect(stdout).toContain("tokens=420"); // 100+20+300
  expect(stderr).toBe("");
}, 20000); // spawns a child amid the parallel suite's own servers

// The daily reconciliation contract: routine syncs read a rolling window
// (--days), and ONCE A DAY the first sync upgrades to a full read that
// re-verifies every fingerprint against history (ATL daily-full semantics).
import { readFileSync, writeFileSync as wfs, mkdirSync } from "node:fs";

describe("csv rolling window + daily full reconciliation", () => {
  const CSV_LINE = "time,agent,requested_model,provider,model,served_model,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,reasoning_tokens,cost_usd,status,source,rejected\n" +
    "2026-11-01T09:00:00+08:00,zcode,glm-5.3,zhipu,glm-5.3,GLM-5.3,100,20,0,300,1,0.05,200,log,false\n";

  function runWindowSync({ manifest, cache }) {
    const dir = mkdtempSync(join(tmpdir(), "atl-csv-win-"));
    const argsFile = join(dir, "args.txt");
    const bin = join(dir, "magpie-fake");
    wfs(bin, `#!/bin/sh\necho "$@" > "${argsFile}"\nprintf '%s\\n' '${CSV_LINE}'\n`, { mode: 0o755 });
    const state = mkdtempSync(join(tmpdir(), "atl-csv-win-state-"));
    if (manifest) {
      wfs(join(state, "sync-state..json"), JSON.stringify(manifest));
    }
    if (cache) {
      wfs(join(state, "page-summary.json"), JSON.stringify(cache));
    }
    const proc = Bun.spawn([process.execPath, SYNC, "--source", "gateway", "--dry-run"], {
      cwd: PLUGIN_DIR,
      env: {
        ...process.env,
        MAGPIE_ATL_DIR: state,
        MAGPIE_PLUGINS_JSON: join(state, "plugins-absent.json"),
        MAGPIE_LEDGER: "",
        MAGPIE_BIN: bin,
        APP_TIME_ZONE: TEST_TZ,
        MAGPIE_GATEWAY_URL: "http://127.0.0.1:1"
      },
      stdout: "pipe",
      stderr: "pipe"
    });
    return new Response(proc.stdout).text().then(() => readFileSync(argsFile, "utf8").trim());
  }

  // Pin the timezone on both sides of the spawn: bun test resolves Intl to
  // UTC while the spawned sync reads the system zone, and toISOString()
  // seeds the UTC day — unpinned, the pair disagreed past local midnight
  // (UTC+8) and the daily-full decision flaked every night.
  const TEST_TZ = "UTC";
  const today = localDayAndHour(new Date(), TEST_TZ).day;
  const seededManifest = { firstRouteId: null, firstSyncStart: "2026-01-01T00:00:00Z", buckets: { "2026-05-01|10|zcode_local": "fp" }, lastFullDay: today };
  const seededCache = { today, days: [{ day: "2026-05-01", total: 420 }], todayHours: [], todayHoursBySource: [] };

  test("a full-read day already done + cache present → routine takes the 7-day window", async () => {
    const args = await runWindowSync({ manifest: seededManifest, cache: seededCache });
    expect(args).toBe("usage --csv --days 7");
  });

  test("a new day → the first sync upgrades to the daily full read", async () => {
    const args = await runWindowSync({
      manifest: { ...seededManifest, lastFullDay: "2000-01-01" },
      cache: seededCache
    });
    expect(args).toBe("usage --csv all");
  });

  test("no manifest (first sync) or no cache → full read", async () => {
    expect(await runWindowSync({ cache: seededCache })).toBe("usage --csv all");
    expect(await runWindowSync({ manifest: seededManifest })).toBe("usage --csv all");
  });
});
