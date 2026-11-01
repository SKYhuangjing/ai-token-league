// The options bridge must speak Magpie's REAL plugins.json shape, not an
// invented one. internal/plugin/store.go Entry = {spec, off, options} where
// spec is how the plugin was added: npm name("name"|"name@version"), a git
// remote, or a local path. A matcher that misses this shape silently drops
// every page-submitted option (imports, syncNow clicks, settings) — exactly
// the "点了没反应" class of bug. Fixtures here mirror the real host file.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPluginOptions, clearPluginOption } from "../lib/state.js";

const PLUGIN_DIR = join(import.meta.dir, "..");

function withPluginsJson(doc, fn) {
  const dir = mkdtempSync(join(tmpdir(), "atl-options-"));
  const path = join(dir, "plugins.json");
  writeFileSync(path, JSON.stringify(doc, null, 2));
  const prevDir = process.env.MAGPIE_PLUGINS_JSON;
  const prevAt = process.env.MAGPIE_ATL_DIR;
  process.env.MAGPIE_PLUGINS_JSON = path;
  process.env.MAGPIE_ATL_DIR = dir; // keep any status writes inside the sandbox
  try {
    return fn(path);
  } finally {
    if (prevDir === undefined) delete process.env.MAGPIE_PLUGINS_JSON;
    else process.env.MAGPIE_PLUGINS_JSON = prevDir;
    if (prevAt === undefined) delete process.env.MAGPIE_ATL_DIR;
    else process.env.MAGPIE_ATL_DIR = prevAt;
  }
}

// the exact shape on a real machine: this plugin added by local path
// (how it is installed in dev), beside vendor plugins added by npm spec
function realHostDoc(ourOptions = {}) {
  return {
    plugins: [
      { spec: "@magpie-community/opencode-zcode-auth@latest" },
      { spec: PLUGIN_DIR, options: ourOptions },
      { spec: "/some/other/plugin-dir", options: { apiBaseUrl: "http://not-us" } }
    ]
  };
}

describe("readPluginOptions against the real host shape", () => {
  test("finds our entry by spec path (the real install shape)", () => {
    withPluginsJson(realHostDoc({ apiBaseUrl: "http://127.0.0.1:8787", nickname: "sky" }), () => {
      const opts = readPluginOptions();
      expect(opts.apiBaseUrl).toBe("http://127.0.0.1:8787");
      // nickname is intentionally NOT whitelisted: a standing option
      // nickname would rename an adopted identity on every run
      expect(opts.nickname).toBeUndefined();
    });
  });

  test("finds our entry by npm spec (published install shape)", () => {
    withPluginsJson({ plugins: [{ spec: "magpie-atl-sync@0.1.1", options: { sinceDay: "2026-01-01" } }] }, () => {
      expect(readPluginOptions().sinceDay).toBe("2026-01-01");
    });
  });

  test("other plugins' options never leak into ours", () => {
    withPluginsJson(realHostDoc(), () => {
      expect(readPluginOptions()).toEqual({});
    });
  });

  test("legacy {name, options} and plain-map shapes still match", () => {
    withPluginsJson({ plugins: [{ name: "magpie-atl-sync", options: { sinceDay: "2026-02-02" } }] }, () => {
      expect(readPluginOptions().sinceDay).toBe("2026-02-02");
    });
    withPluginsJson({ "magpie-atl-sync": { options: { sinceDay: "2026-03-03" } } }, () => {
      expect(readPluginOptions().sinceDay).toBe("2026-03-03");
    });
  });

  test("git-remote specs are never mistaken for us", () => {
    withPluginsJson({ plugins: [{ spec: "github:skyhuangjing/magpie-atl-sync", options: { nickname: "nope" } }] }, () => {
      expect(readPluginOptions()).toEqual({});
    });
  });
});

describe("clearPluginOption against the real host shape", () => {
  test("scrubs one key from the spec-shaped entry, preserving the rest of the file", () => {
    withPluginsJson(realHostDoc({ identityImport: { secret: true }, nickname: "keep-me" }), (path) => {
      clearPluginOption("identityImport");
      const doc = JSON.parse(readFileSync(path, "utf8"));
      const ours = doc.plugins.find((e) => e.spec === PLUGIN_DIR);
      expect(ours.options.identityImport).toBeUndefined();
      expect(ours.options.nickname).toBe("keep-me");
      expect(doc.plugins.length).toBe(3); // other plugins untouched
    });
  });
});

describe("openBoard command channel", () => {
  test("readPendingCommand carries the url for the host to open", () => {
    withPluginsJson(
      { plugins: [{ spec: PLUGIN_DIR, options: { pendingCommand: { command: "openBoard", nonce: "n1", url: "http://127.0.0.1:8787/" } } }] },
      () => {
        const pending = readPluginOptions().pendingCommand;
        expect(pending.command).toBe("openBoard");
        expect(pending.url).toBe("http://127.0.0.1:8787/");
      }
    );
  });
});
