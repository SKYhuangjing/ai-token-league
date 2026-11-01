// Round-trip identity portability: the plugin exports the SAME
// atl-magpie-migrate shape ATL produces, and the page-submitted import
// adopts it (scrubbing the private key from plugins.json immediately).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

const PLUGIN_DIR = join(import.meta.dir, "..");
const SYNC = join(PLUGIN_DIR, "sync.js");

function makeAtlExport(participantId = "p_2de62c2f4b4b18c05991a1b0", deviceId = "d_f60efc6dc4958516bbf27255") {
  return {
    version: 1,
    kind: "atl-magpie-migrate",
    participantId,
    nickname: "Sky Huang",
    deviceId,
    apiBaseUrl: "http://127.0.0.1:8787",
    identityPublicKey: "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----\n",
    identityPrivateKey: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n"
  };
}

async function runSync(args, { pluginsJson, stateDir } = {}) {
  const dir = stateDir || mkdtempSync(join(tmpdir(), "atl-port-"));
  if (pluginsJson) {
    writeFileSync(join(dir, "plugins.json"), JSON.stringify(pluginsJson));
  }
  // a local ledger fixture: the gateway channels are dead here, and the
  // fallback must never reach this machine's real usage.jsonl
  const ledger = join(dir, "usage.jsonl");
  try {
    readFileSync(ledger);
  } catch {
    writeFileSync(ledger, JSON.stringify({ route_id: 1, t: "2026-11-01T10:00:00+08:00", agent: "zcode", provider: "antigravity", model: "m", req: "antigravity/m", in: 100, out: 20, cache_read: 0, cache_write: 0, status: 200, response_id: "r1" }) + "\n");
  }
  const proc = Bun.spawn([process.execPath, SYNC, ...args], {
    cwd: PLUGIN_DIR,
    env: {
      ...process.env,
      MAGPIE_ATL_DIR: dir,
      MAGPIE_PLUGINS_JSON: join(dir, "plugins.json"),
      MAGPIE_LEDGER: ledger,
      MAGPIE_BIN: "none",
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
  const readState = (name) => {
    try {
      return JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      return null;
    }
  };
  return { status, stdout, stderr, stateDir: dir, readState };
}

const optionsWith = (options) => ({
  plugins: [{ name: pkg.name, options }]
});

describe("export-config", () => {
  test("writes the atl-magpie-migrate shape from the stored identity", async () => {
    // seed an identity by importing one first (no identity yet → export refuses)
    const seed = makeAtlExport();
    const imported = await runSync(["--dry-run"], {
      pluginsJson: optionsWith({ identityImport: seed })
    });
    expect(imported.status).toBe(0);
    const out = join(imported.stateDir, "exported.json");
    const re = await runSync(["--export-config", "--out", out], { stateDir: imported.stateDir });
    expect(re.status).toBe(0);
    const exported = JSON.parse(readFileSync(out, "utf8"));
    expect(exported.kind).toBe("atl-magpie-migrate");
    expect(exported.participantId).toBe(seed.participantId);
    expect(exported.deviceId).toBe(seed.deviceId);
    expect(exported.nickname).toBe("Sky Huang");
    expect(exported.identityPublicKey).toContain("BEGIN PUBLIC KEY");
    expect(exported.identityPrivateKey).toContain("BEGIN PRIVATE KEY");
  });

  test("refuses to export before any identity exists", async () => {
    const r = await runSync(["--export-config", "--out", "/tmp/should-not-exist.json"], {});
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no identity yet/);
  });
});

describe("page-submitted import", () => {
  test("adopts the export, adopts identity, scrubs the option from plugins.json", async () => {
    const r = await runSync(["--dry-run"], {
      pluginsJson: optionsWith({ identityImport: makeAtlExport(), apiBaseUrl: "" })
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("identity source: migrate-file");
    // private key must NOT linger in plugins.json after consumption
    const pluginsDoc = JSON.parse(readFileSync(join(r.stateDir, "plugins.json"), "utf8"));
    expect(pluginsDoc.plugins[0].options.identityImport).toBeUndefined();
    const ident = r.readState("identity.json");
    expect(ident.participantId).toBe("p_2de62c2f4b4b18c05991a1b0");
    expect(ident.nickname).toBe("Sky Huang");
  });

  test("garbage payloads are refused loudly and scrubbed", async () => {
    const r = await runSync(["--dry-run"], {
      pluginsJson: optionsWith({ identityImport: { kind: "atl-magpie-migrate", participantId: "p_x" } })
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/不是有效的/);
    const pluginsDoc = JSON.parse(readFileSync(join(r.stateDir, "plugins.json"), "utf8"));
    expect(pluginsDoc.plugins[0].options.identityImport).toBeUndefined();
  });

  test("a different existing identity is never silently replaced (passive file drop)", async () => {
    // first import adopts p_2de6...
    const first = await runSync(["--dry-run"], { pluginsJson: optionsWith({ identityImport: makeAtlExport() }) });
    expect(first.status).toBe(0);
    // now try to import p_ffff... (a different identity) directly via file drop
    const other = makeAtlExport("p_ffffffffffffffffffffffff", "d_aaaaaaaaaaaaaaaaaaaaaaaa");
    writeFileSync(join(first.stateDir, "migrate.json"), JSON.stringify(other));
    const second = await runSync(["--dry-run"], { pluginsJson: optionsWith({}), stateDir: first.stateDir });
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/already is p_2de62c2f4b4b18c05991a1b0/);
  });

  test("a page-submitted import REPLACES a different identity (explicit intent), backing the old one up", async () => {
    // the machine already is p_2de6... (adopted above from the first import)
    const first = await runSync(["--dry-run"], { pluginsJson: optionsWith({ identityImport: makeAtlExport() }) });
    expect(first.status).toBe(0);
    // the user picks a DIFFERENT export in the page: button + file picker is
    // explicit intent — the guard belongs to the passive migrate.json drop,
    // not here
    const replacement = makeAtlExport("p_ffffffffffffffffffffffff", "d_aaaaaaaaaaaaaaaaaaaaaaaa");
    replacement.nickname = "Replacement User";
    const second = await runSync(["--dry-run"], {
      pluginsJson: optionsWith({ identityImport: replacement, apiBaseUrl: "" }),
      stateDir: first.stateDir
    });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("identity source: migrate-file");
    const ident = second.readState("identity.json");
    expect(ident.participantId).toBe("p_ffffffffffffffffffffffff");
    expect(ident.nickname).toBe("Replacement User");
    // the replaced identity survives as a 0600 backup, not vaporized
    const bak = second.readState("identity.json.p_2de62c2f4b4b18c05991a1b0.bak");
    expect(bak && bak.participantId).toBe("p_2de62c2f4b4b18c05991a1b0");
    // the private key never lingers in plugins.json after consumption
    const pluginsDoc = JSON.parse(readFileSync(join(second.stateDir, "plugins.json"), "utf8"));
    expect(pluginsDoc.plugins[0].options.identityImport).toBeUndefined();
  });

  test("a page import adopts the export's server (explicit switch, user decision)", async () => {
    const export1 = makeAtlExport();
    export1.apiBaseUrl = "http://export-server.example:9999"; // a DIFFERENT server
    const first = await runSync(["--dry-run"], {
      pluginsJson: optionsWith({ identityImport: export1, apiBaseUrl: "http://127.0.0.1:8787" })
    });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("identity source: migrate-file");
    // the export's server wins, and a page-saved apiBaseUrl option (which
    // would outrank config.json) is cleared with the adoption
    expect(first.readState("config.json").apiBaseUrl).toBe("http://export-server.example:9999");
    const pluginsDoc = JSON.parse(readFileSync(join(first.stateDir, "plugins.json"), "utf8"));
    expect(pluginsDoc.plugins[0].options.apiBaseUrl).toBeUndefined();
  });

  test("re-importing the SAME identity is an idempotent no-op", async () => {
    const first = await runSync(["--dry-run"], { pluginsJson: optionsWith({ identityImport: makeAtlExport() }) });
    expect(first.status).toBe(0);
    const again = await runSync(["--dry-run"], {
      pluginsJson: optionsWith({ identityImport: makeAtlExport() }),
      stateDir: first.stateDir
    });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("identity source: store");
  });
});

describe("nickname must never fight the adopted identity", () => {
  test("adoption clears a standing config.json nickname (the silent-rename bug)", async () => {
    // a shadow-era config.json carries nickname: "old-shadow"; the import
    // of Sky Huang must remove it, or every later run renames him back
    const dir = mkdtempSync(join(tmpdir(), "atl-nickfix-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ apiBaseUrl: "", nickname: "old-shadow" }));
    const r = await runSync(["--dry-run"], {
      pluginsJson: optionsWith({ identityImport: makeAtlExport() }),
      stateDir: dir
    });
    expect(r.status).toBe(0);
    const cfg = r.readState("config.json");
    expect(cfg.nickname).toBeUndefined();
    expect(r.readState("identity.json").nickname).toBe("Sky Huang");
  });

  test("nicknameSet is a one-shot: renames once, scrubs, never standing", async () => {
    const first = await runSync(["--dry-run"], { pluginsJson: optionsWith({ identityImport: makeAtlExport() }) });
    expect(first.status).toBe(0);
    const renamed = await runSync(["--dry-run"], {
      pluginsJson: optionsWith({ nicknameSet: "New Name" }),
      stateDir: first.stateDir
    });
    expect(renamed.status).toBe(0);
    expect(renamed.readState("identity.json").nickname).toBe("New Name");
    const pluginsDoc = JSON.parse(readFileSync(join(renamed.stateDir, "plugins.json"), "utf8"));
    expect(pluginsDoc.plugins[0].options.nicknameSet).toBeUndefined();
    // a later run with nothing pending keeps the name
    const again = await runSync(["--dry-run"], { pluginsJson: optionsWith({}), stateDir: first.stateDir });
    expect(again.readState("identity.json").nickname).toBe("New Name");
  });

  test("a legacy standing options nickname is ignored (not whitelisted)", async () => {
    const first = await runSync(["--dry-run"], { pluginsJson: optionsWith({ identityImport: makeAtlExport() }) });
    expect(first.status).toBe(0);
    const second = await runSync(["--dry-run"], {
      pluginsJson: optionsWith({ nickname: "Sneaky Rename" }),
      stateDir: first.stateDir
    });
    expect(second.readState("identity.json").nickname).toBe("Sky Huang");
  });
});

describe("import carries the server on a same-identity re-import (cutover)", () => {
  test("re-importing the SAME identity with a different apiBaseUrl repoints the sync", async () => {
    const first = await runSync(["--dry-run"], { pluginsJson: optionsWith({ identityImport: makeAtlExport(), apiBaseUrl: "http://old-server:1" }) });
    expect(first.status).toBe(0);
    const again = makeAtlExport();
    again.apiBaseUrl = "http://new-server:2";
    const second = await runSync(["--dry-run"], {
      pluginsJson: optionsWith({ identityImport: again }),
      stateDir: first.stateDir
    });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("identity source: store"); // same identity, no re-adoption
    expect(second.readState("config.json").apiBaseUrl).toBe("http://new-server:2");
  });
});
