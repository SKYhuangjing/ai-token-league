# Test Infrastructure Handoff — Independent Review

**Date**: 2026-05-24
**Branch**: `feat/performance`
**Status**: 412 unit tests + 52 E2E tests — all passing

---

## 1. Background & Goals

The desktop app (`src/desktop/`) is a vanilla JS renderer loaded by Tauri v2. It had **zero automated test coverage** before this work. The goal was to build a test foundation that:

1. **Tests real production code** — not re-implemented logic inside test files
2. **Verifies product behavior** — assertions match actual user-facing data, not just "element exists"
3. **Has no side effects on the source tree** — no persistent symlinks, no scattered artifacts
4. **Is maintainable** — extracted modules with clear boundaries, reusable mock infrastructure

---

## 2. Architecture Overview

### Two Test Layers

| Layer | Tool | Count | Config |
|---|---|---|---|
| Renderer unit tests | Vitest + jsdom | 412 | `vitest.config.js` |
| E2E (mock Tauri) | Playwright | 52 | `playwright.mock.config.js` |

### Source Module Extraction

`renderer.js` is a ~3900-line monolith with no exports (calls `boot()` on import). To test real functions, three modules were extracted:

```
src/desktop/renderer-helpers.js    — pure functions (formatting, date math, cost, normalization)
src/desktop/renderer-data.js       — data transforms (grouping, aggregation, range filtering)
src/desktop/renderer-components.js — HTML generators (meters, cards, trend charts)
```

`renderer.js` imports from these modules — no behavior change, same function signatures.

---

## 3. Key Design Decisions

### 3.1 Test Server Replaces Symlink

**Problem**: The renderer imports `../shared/display.js` etc. via ES module relative paths. When serving `src/desktop/` as HTTP root, the browser resolves `../shared/` to a path traversal that static servers block. The previous solution was a **persistent symlink** `src/desktop/shared → ../shared` created at test time but never cleaned up.

**Solution**: A 60-line Node HTTP server (`tests/e2e/test-server.js`) that:
- Serves `src/desktop/` as document root
- Proxies `/shared/*` requests to `src/shared/`
- Returns proper MIME types
- No symlink, no source tree pollution

### 3.2 Mock Bridge via `Object.defineProperty` Setter

**Problem**: The renderer reads `window.tokenLeague` (Tauri IPC API) at boot. Early mocking used `setInterval` polling to detect when the property was available — caused a 10ms race window and flaky failures.

**Solution**: `Object.defineProperty` with a `set` trap. The mock overrides the API synchronously the instant `renderer.js` assigns `window.tokenLeague`:

```javascript
let _tokenLeague;
Object.defineProperty(window, "tokenLeague", {
  set(value) { _tokenLeague = value; applyOverrides(_tokenLeague); },
  get() { return _tokenLeague; },
  configurable: true,
});
```

### 3.3 Range-Aware Mock Data

Mock data (`tests/e2e/mock-tauri.js`) provides deterministic, timezone-safe values:

| Range | Total Tokens | Source |
|---|---|---|
| today | 8,500 | 1 usage item (claude_code, today, current hour) |
| 7d / all | 13,000 | 2 items (today 8500 + yesterday 4500) |

Dates use `localDateStr()` (not UTC) to match the renderer's `localDay()` which uses `Intl.DateTimeFormat`. This eliminates timezone-dependent test failures.

### 3.4 Consolidated Test Output

**Before**: Artifacts scattered across `test-results/`, `coverage/`, `src-tauri/coverage/`, plus a dangling symlink.

**After**: All test artifacts under `tests/output/`:

```
tests/output/
  coverage/       — Vitest V8 coverage (HTML + JSON)
  playwright/     — Playwright traces, screenshots (failure only)
```

`.gitignore` entry: `tests/output/`

---

## 4. E2E Test Quality Improvements

All 38 E2E cases were rewritten from tautological assertions to product-verified ones. Examples:

### Before (tautological — always passes)
```javascript
// range-switch: asserted >= 0 (any non-negative number passes)
expect(total).toBeGreaterThanOrEqual(0);

// scan-and-view: asserted count >= 0 (empty DOM passes)
expect(count).toBeGreaterThanOrEqual(0);
```

### After (product-verified — exact expected values)
```javascript
// range-switch: exact values + cross-validation
expect(total).toBe(8500);           // today
expect(total).toBe(13000);          // 7d/all
expect(allVal).toBeGreaterThan(todayVal);  // all > today

// scan-and-view today: only today providers (range-aware)
expect(await providerList.locator('.mini-meter-row').count()).toBe(1);
await expect(providerList).toContainText('Claude Code');  // display name, not providerId
await expect(providerList).toContainText('8.5K');         // formatted token value
```

### Per-spec summary

| Spec | Tests | What changed |
|---|---|---|
| `scan-and-view` | 6 | Range-aware: today=1 provider, all=2 providers. Token values (8500/5000/2000). |
| `range-switch` | 3 | Exact values per range, cross-range validation (all > today) |
| `navigation` | 4 | Target screen content verification, round-trip data preservation |
| `settings` | 4 | Full save flow (edit → dirty → save → clean), tab panel visibility |
| `i18n` | 2 | `html lang` attribute, translated text vs raw key |
| `i18n-zh` | 4 | zh-CN locale: lang attr, nav text, data load, range labels |
| `sync` | 3 | Rail `data-state` attribute, badge text, API URL dirty state |
| `workdir-alias` | 2 | Drawer open/close class, row count assertion before interaction |
| `onboarding` | 3 | Config-injected fixture (`__ATL_E2E_CONFIG__`) |
| `scan-async` | 2 | Async scan (scanDelay=500), data after completion, concurrent scan during running |
| `empty-data` | 3 | Zero usage: placeholder, empty breakdowns, navigation safety |
| `error-states` | 3 | API errors: boot with failed checkApi, cloud rail, settings status |
| `large-dataset` | 3 | 1000 rows: render budget, range switch budget, workdir list |
| `workflows` | 6 | Provider toggle, roots, reset button, backup status, update version |
| `responsiveness` | 5 | Stability smoke + performance budgets (5s boot, 2s range switch) |

---

## 5. Files Changed

### New Files
```
src/desktop/renderer-helpers.js          — extracted pure functions
src/desktop/renderer-data.js             — extracted data transforms
src/desktop/renderer-components.js       — extracted HTML generators
tests/e2e/test-server.js                 — lightweight E2E HTTP server
tests/e2e/mock-setup-onboarding.js       — onboarding fixture (config injection)
tests/e2e/mock-setup-zh.js              — zh-CN locale fixture
tests/e2e/mock-setup-async-scan.js      — async scan fixture (scanDelay=500)
tests/e2e/mock-setup-empty.js           — empty data fixture
tests/e2e/mock-setup-error.js           — API error fixture
tests/e2e/mock-setup-large.js           — 1000-row dataset fixture
tests/e2e/i18n-zh.spec.js               — zh-CN E2E tests (4 tests)
tests/e2e/scan-async.spec.js             — async scan E2E tests (2 tests)
tests/e2e/empty-data.spec.js             — empty data E2E tests (3 tests)
tests/e2e/error-states.spec.js           — API error E2E tests (3 tests)
tests/e2e/large-dataset.spec.js          — large dataset E2E tests (3 tests)
tests/e2e/workflows.spec.js              — product workflow E2E tests (6 tests)
tests/renderer/                          — 14 test files, 341 tests (321 import real production code, 20 are isolated pattern tests)
tests/renderer/setup.js                  — jsdom test setup + symlink pre-check
```

### Modified Files
```
package.json                              — split test:e2e:mock / test:e2e:tauri
playwright.mock.config.js                 — test-server + outputDir
playwright.config.js                      — outputDir
vitest.config.js                          — reportsDirectory
.gitignore                                — consolidated tests/output/
tests/e2e/mock-tauri.js                   — config injection, range-aware filtering, scan state machine
tests/e2e/mock-setup.js                   — __ATL_E2E_CONFIG__ injection
tests/e2e/mock-setup-onboarding.js        — __ATL_E2E_CONFIG__ injection (no string replace)
tests/e2e/helpers.js                      — getTokenValue compact notation
tests/e2e/scan-and-view.spec.js           — range-aware breakdown tests (today vs all)
tests/e2e/perf/responsiveness.spec.js     — performance budgets added
tests/e2e/*.spec.js                       — all specs reviewed and tightened
```

### Removed
```
src/desktop/shared                        — symlink (eliminated by test-server.js)
src/shared/shared                         — symlink (leftover, removed)
test-results/                             — consolidated into tests/output/
coverage/                                 — consolidated into tests/output/
```

---

## 6. Known Limitations & Future Work

1. **20 pattern tests don't exercise production code**: `loading.test.js` and `state.test.js` test isolated patterns (dedup, poll, modal, state machine) but don't import real renderer functions. Real regression coverage for these patterns comes from E2E tests. 392 unit tests DO import and call real production functions.

2. **Mock vs protocol drift**: `mock-tauri.js` generates responses in-browser. If the real Rust API shapes change, tests will still pass with stale shapes. A contract/fixture test binding mock generators to real protocol structs would catch this.

3. **Scenario matrix coverage**: E2E tests now cover happy path, empty data, API errors, 1000-row datasets, concurrent scan, zh-CN locale, and basic settings/source workflows. Still not covered: Cursor OAuth connect flow (requires external redirect), detailed backup/restore file operations, update download lifecycle, provider root add/remove dialog interactions.

4. **No real Tauri E2E in CI**: `test:e2e:tauri` requires a full Rust toolchain and native Tauri binary. Only `test:e2e` (mock) runs without native dependencies.

5. **Performance budgets**: Tested against both 2-row (2s range switch) and 1000-row (5s range switch, 10s boot) datasets. No memory or rendering FPS budgets yet.

6. **Scan delay tested for basic flow**: `scan-async.spec.js` exercises scanDelay=500 (running→done) and re-scan safety. Not yet tested: rapid double-click during running state, scan cancellation.

---

## 7. Test Gates

### PR Base Gate (every PR)
```bash
npm test                      # Backend + shared module tests
npm run test:ui               # Renderer unit tests (412 tests)
cargo test --workspace        # Rust collector + sidecar
```

### Desktop UI Gate (desktop changes)
```bash
npm run test:e2e              # Mock E2E (52 tests: happy + error + empty + large + zh-CN + async + perf + workflows)
npm run test:e2e:mock:headed  # Same with visible browser (debugging)
```

### Collector Correctness Gate (collector changes)
```bash
npm run verify:ccusage        # Compare against ccusage/ccusage-codex output
```

### Release / Packaging Gate
```bash
# All of the above, plus:
npm run desktop               # Verify Tauri app launches
scripts/release.sh --platform current --env <env> --yes  # Package build
```

### Performance Gate
```bash
npm run test:ui:bench         # Vitest benchmarks for hot-path functions
# E2E performance budgets are in tests/e2e/perf/responsiveness.spec.js
```

### Real Tauri E2E (requires full Rust toolchain + Tauri dev)
```bash
npm run test:e2e:tauri        # Uses playwright.config.js → npx tauri dev
```
