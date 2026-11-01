// The host-side link opener: only http(s) passes, and the URL travels as an
// argument (never through a shell). Reject cases must not spawn anything.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOKS = join(import.meta.dir, "..", "hooks.js");
const PROBE = `
const hooks = await import(${JSON.stringify(HOOKS)});
const out = {
  javascript: hooks._internal.openExternal("javascript:alert(1)"),
  file: hooks._internal.openExternal("file:///etc/passwd"),
  empty: hooks._internal.openExternal("")
};
process.stdout.write(JSON.stringify(out));
process.exit(0);
`;

describe("openExternal (host link opener)", () => {
  test("rejects non-http(s) schemes without spawning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atl-open-"));
    const proc = Bun.spawn([process.execPath, "-e", PROBE], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        MAGPIE_ATL_DIR: dir,
        MAGPIE_PLUGINS_JSON: join(dir, "plugins-absent.json"),
        MAGPIE_GATEWAY_URL: "http://127.0.0.1:1",
        MAGPIE_BIN: "none",
        MAGPIE_LEDGER: ""
      },
      stdout: "pipe",
      stderr: "pipe"
    });
    const out = JSON.parse(await new Response(proc.stdout).text());
    expect(out.javascript).toBe(false);
    expect(out.file).toBe(false);
    expect(out.empty).toBe(false);
  });
});
