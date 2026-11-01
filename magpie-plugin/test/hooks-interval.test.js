// The user-configurable sync cadence: intervalDue must fire on the first
// boot, hold for the configured gap, and fire again once the gap passed.
// hooks.js has import-time side effects (resident timers + a startup spawn),
// so each case runs in a child bun process that exits before the 5s startup
// trigger — the cadence logic is what's under test, not the spawning.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLUGIN_DIR = join(import.meta.dir, "..");

const PROBE = `
const hooks = await import(${JSON.stringify(join(PLUGIN_DIR, "hooks.js"))});
const out = { first: hooks._internal.intervalDue(15) };
out.immediatelyAgain = hooks._internal.intervalDue(15);
out.afterFive = hooks._internal.intervalDue(5);   // shorter gap: still held? stamp is fresh
process.stdout.write(JSON.stringify(out));
process.exit(0);
`;

function runProbe(stateDir) {
  const proc = Bun.spawn([process.execPath, "-e", PROBE], {
    cwd: PLUGIN_DIR,
    env: {
      ...process.env,
      MAGPIE_ATL_DIR: stateDir,
      MAGPIE_PLUGINS_JSON: join(stateDir, "plugins-absent.json"),
      MAGPIE_GATEWAY_URL: "http://127.0.0.1:1",
      MAGPIE_BIN: "none",
      MAGPIE_LEDGER: ""
    },
    stdout: "pipe",
    stderr: "pipe"
  });
  return new Response(proc.stdout).text();
}

describe("intervalDue (sync cadence)", () => {
  test("fires on first boot, holds within the gap, honors a shorter setting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atl-interval-"));
    const out = JSON.parse(await runProbe(dir));
    expect(out.first).toBe(true);       // no stamp yet → due
    expect(out.immediatelyAgain).toBe(false); // stamp just written → not due
    expect(out.afterFive).toBe(false);  // 5-min gap vs a seconds-old stamp → not due
    const stamp = JSON.parse(readFileSync(join(dir, ".last-interval.json"), "utf8"));
    expect(Number.isFinite(stamp.at)).toBe(true);
  });

  test("fires again once the configured gap has elapsed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atl-interval-2-"));
    // backdate the stamp beyond a 15-minute gap
    writeFileSync(join(dir, ".last-interval.json"), JSON.stringify({ at: Date.now() - 16 * 60 * 1000 }));
    const out = JSON.parse(await runProbe(dir));
    expect(out.first).toBe(true);
  });
});
