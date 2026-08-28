# Plugin Platform Goal (P0–P3)

Branch: `feat/plugin-platform` (from `develop`). Status: in progress.

## Goal (single sentence)

On `feat/plugin-platform`, deliver a plugin-based collection & tools platform across P0–P3 — provider trait + unified metadata registry, declarative SourcePacks, process-plugin source protocol, and admin-gated tool plugins with tray + in-page entries — with all gates green and no bundled runtimes.

## Decisions (confirmed by owner)

- **No bundled runtime.** Tool/source plugins declare their interpreter in the manifest (`interpreter.command`). The desktop/sidecar probes availability; missing runtime is a visible, non-runnable state — never a silent failure, never a bundled interpreter.
- **New sources are admin-controlled (revised 2026-08-25).** Plugin-origin providerIds (SourcePack + process source plugins) are quarantined server-side until an admin allows them in the source catalog. Native built-in providerIds (seeded from `src/shared/provider-registry.json`) are always allowed. Quarantined buckets are dropped from storage with a warning in the sync response (not a hard reject — native providers keep syncing), and the first upload auto-registers the providerId as `pending` in the catalog for the admin to decide.
- **Tools are NOT admin-controlled (revised 2026-08-25).** Tool plugins are local utilities: no server catalog, no gating. Results render in the in-app Tools page and via tray.
- **Tool output is parse-defined (declared 2026-08-26).** Tools emit typed metrics (`{type:"metric", id, label, value, unit?, state?}`) alongside human-readable sections; the manifest tray config (`summaryLines` referencing metric ids, zh-CN/en variants, `refreshMinutes`) renders metrics into tray summary lines. First concrete case: zhipu-usage quota displayed live in the tray.
- **Tools get two entry points:** in-app Tools page (list / run / render structured output) and a tray submenu (click → focus window, navigate to Tools page, auto-run).
- **All sources are comparison-verified; switchable sources switch (declared 2026-08-26).** SourcePack is not a new-source-only channel: every one of the 11 native providers enters a comparison matrix. A source switches its runtime engine to pack ONLY after (a) samples golden test byte-identical on ALL public fields (incl. workdirHash/workdirDisplayName), (b) real-machine `pack-compare` diff = 0, (c) `verify:ccusage` still green post-switch. Engine is per-source and rollback-capable (`ATL_PROVIDER_ENGINE=<id>:pack|native` override). Sources that cannot reach field-identity stay native with the failing reason recorded — the comparison matrix still covers them via P0 baseline fixtures.
- **Privacy pipeline unchanged.** Every path — native provider, SourcePack, process plugin — feeds the same `finalize_event → public_usage_item` pipeline with `FORBIDDEN_UPLOAD_FIELDS` whitelisting before aggregation, signature, and upload.

## Phase scope & acceptance

### P0 — Provider trait + metadata registry (pure refactor)

- Define `LocalProvider` trait in `collector-core/src/provider/mod.rs`; all 12 native providers implement it.
- `scanner.rs` scan/health/async dispatch iterates a registry instead of per-provider hardcoded blocks (behavior identical; cursor stays on its async path).
- New single source of truth `src/shared/provider-registry.json`: id, toolCode, display name (zh-CN/en), icon, palette color, UI order, tray name, add-root labels.
- Consumers converge: `renderer.js` + `renderer-data.js` sourceName, `chart-helpers.js` palette/name, `admin.js` + `data-value-demo-live.js` display maps (via `/api/providers` from backend reading the same JSON), Rust tray `TRAY_PROVIDER_NAMES` (compile-time include of the same JSON).
- **Accept:** `cargo test --workspace`, `npm test`, `npm run test:ui`, `npm run test:e2e` green with no behavior change; new provider needs only provider file + `mod.rs` + registry entry.

### P1 — Declarative SourcePack: all-source comparison & switch

**Schema & interpreter:**

- JSON packs describe: roots (env override + candidates + file matcher), formats `jsonl` | `sqlite` (embedded SQL + column mapping), record filters, timestamp/model fields, token field aliases + semantics `disjoint-sum|direct|openai-split`, dedup policies `none|global-field-keep-max`, workdir resolution (path-derived / index-file / sqlite-column), display metadata, `parserVersion` (pack-carried so source fingerprints stay stable).
- Built-in packs ship in-repo and load alongside user packs from `~/.ai-token-league/sources/` (override: `ATL_SOURCES_DIR`). All packs run through the P0 trait registry → same scan/health/cache/sync path.
- Per-source engine switch: registry entry `engine: native|pack`; runtime override `ATL_PROVIDER_ENGINE=<id>:pack|native` for A/B and rollback.

**Universal comparison harness (covers 11/11 providers):**

- Samples golden: pack engine vs native engine on `samples/**`, ALL public fields byte-identical (day/hour/model/4 token classes/total/workdirHash/workdirDisplayName/trace fields).
- Real-machine compare: `atl-collector pack-compare [--provider <id>]` runs both engines against real home data and prints per-field diffs; exit 0 iff zero diff across switched sources.
- Native-only sources are covered by P0 baseline fixtures (integration tests assert refactored native output matches pre-refactor recorded output).

**Migration waves & target matrix:**

| Provider | Target engine | Wave | Reason if native-only |
|---|---|---|---|
| `kimi_local` | pack | W1 jsonl | — |
| `openclaw_local` | pack | W1 jsonl | — |
| `mimocode_local` | pack | W2 sqlite | — |
| `opencode_local` | pack | W2 sqlite | — |
| `hermes_local` | pack | W2 sqlite | — |
| `zcode_local` | pack | W2 sqlite | — |
| `claude_code_local` | pack candidate | W3 (global dedup keep-max + projects-dir workdir) | falls back to native if golden can't reach field-identity |
| `codex_local` | native-only | — | replay plan is imperative cross-file logic |
| `dsh_local` | native-only | — | zstd multi-frame binary scan |
| `workbuddy_local` | native-only | — | workdir attribution depends on stateful snapshot outside trace files |
| `cursor_dashboard_usage` | native-only | — | async OAuth cloud provider (different kind) |

- **Accept:** comparison matrix delivered for 11/11 providers with final engine + evidence; ≥6 sources switched to pack with all three gates passed (samples golden / real-machine diff 0 / verify:ccusage green), claude attempted; interpreter unit tests cover aliases ×3 semantics, filters, dedup modes, workdir rules, malformed packs rejected, env override.

### P2 — Process plugin protocol (kind: `source`)

- External executable/script plugins in `~/.ai-token-league/plugins/<id>/` (`plugin.json` manifest, `kind: "source"`, `protocolVersion: 1`).
- NDJSON contract: sidecar sends `{type:"scan", roots}` on stdin; plugin replies `{type:"event", event}`*, then `{type:"done", parserVersion}` or `{type:"error", message}` on stdout.
- Events re-enter the standard finalize/public pipeline (privacy whitelist enforced core-side). Guards: per-run timeout, stdout byte cap, non-zero exit / malformed line / crash → `provider_errors` entry, scan continues.
- **Accept:** integration tests using the re-exec-self trick (portable, no interpreter dependency): happy path, timeout, oversized output, crash, missing binary. Windows-safe (`CREATE_NO_WINDOW`).

### P3 — Tool plugins (kind: `tool`) + source admin gate + tray & page

**Tools (local, no admin gate):**

- Tool manifest: `kind: "tool"`, interpreter declaration, timeout, declarative permissions (paths/network domains — transparency only, not a sandbox).
- NDJSON output contract (v1): human layer `{type:"section"|"text"|"kv"|"table"}` + **parse layer `{type:"metric", id, label, value, unit?, state?}`** (`state: ok|warn|alert`), then `{type:"done"|"error"}`. Metrics are keyed by declared `id`; consumers (tray, page, future automation) read metrics by id, never scrape display strings.
- Manifest tray config: `tray: {enabled, summaryLines: {"zh-CN": ["..."], "en": ["..."]}, refreshMinutes}` where each line is a template referencing metric ids (`"5h {fiveHourPercent}% · 重置 {fiveHourResetAt}"`). Sidecar keeps a last-run metric cache (persisted under `~/.ai-token-league/`) so the tray has content after restart; clicking the tray tool line re-runs and updates; `refreshMinutes` optionally drives background refresh.
- Sidecar: `tools:list` (local manifests + interpreter probe → `ok|missing-runtime|invalid`), `tools:run` (spawn, capture structured output, timeout, extract metrics).
- Desktop: Tools page (nav item; cards with name, runtime status, run button; metric chips rendered from the parse layer, then human-layer sections; zh-CN/en via i18n); tray "Tools" section shows rendered `summaryLines` per tool (click → refresh; menu item → focus window + navigate to Tools page).
- First tool: `zhipu-usage` ported to the NDJSON contract, shipped as a sample plugin dir (`samples/plugins/zhipu-usage/`, install = copy to `~/.ai-token-league/plugins/`); emits metrics `planName`, `fiveHourPercent`, `fiveHourResetAt`, `weeklyPercent`, `weeklyResetAt` (+ per-key human sections); CLI `atl-collector tools list|run <id>` for headless runs.
- **Accept (tools):** unit tests for metric extraction + summary-line template rendering (pure functions, ≥6 cases incl. missing-metric fallback and warn/alert state); renderer unit tests for tools-page pure functions; mock E2E ≥5 specs (list, run happy path with metric chips, missing runtime, error output, zh/en); tray wiring compiles + manual desktop smoke showing the real zhipu summary lines in tray; sample plugin runs against real keys via CLI (manual evidence).

**Source admin gate (server-side quarantine):**

- Backend source catalog: allowed set = native providerIds seeded from `src/shared/provider-registry.json` ∪ catalog entries with status `allowed`. Any other providerId on upload → buckets dropped from storage, providerId auto-registered as `pending`, warning included in sync response; client does not mark quarantined buckets as synced (they retry after admin allows).
- Admin page: source catalog section listing `pending|allowed|denied` plugin-origin providers with allow/deny actions. Admin auth per existing `/api/admin/*` rules.
- Storage: JSON store + MySQL migration `003_source_catalog.sql` (parity).
- **Accept (gate):** ≥4 backend tests — unknown plugin providerId quarantined + registered pending; admin allow → next upload stored; deny → dropped; native providerId always allowed without catalog entry. Client retry-after-allow covered by a sync test.

## Final gate (all on the branch)

```
cargo test --workspace
npm test
npm run test:ui
npm run test:e2e
npm run verify:ccusage
node --check src/desktop/renderer.js
atl-collector pack-compare --all   # real-machine, exit 0 iff zero diff on all switched sources
```

## Non-goals

- No remote plugin store, auto-update, or signed distribution (local install only).
- No sandbox enforcement of manifest permissions (they are declared transparency + first-run consent).
- No change to ranking semantics, upload routes, or the self-report trust model for sources.
- No bundled Node/Python runtimes.
