# Test Coverage Handoff — 2026-05-24

**Branch**: `feat/performance`
**Total**: 412 unit tests + 52 E2E tests + 193 Rust tests = **657 tests**

---

## 1. Test Inventory

### Unit Tests (Vitest + jsdom): 412

| File | Tests | Covers |
|---|---|---|
| `renderer-helpers.test.js` | 142 | Pure functions: formatting, date math, cost, normalization, predicates |
| `renderer-data.test.js` | 61 | Data transforms: grouping, aggregation, range filtering, trend, health reconciliation |
| `renderer-components.test.js` | 45 | HTML generators: meters, cards, composition, trend dashboard, source switch |
| `shared/schema.test.js` | 21 | Protocol validation, sensitive field detection |
| `shared/pricing.test.js` | 21 | Cost estimation, aggregation, price maps, OpenRouter conversion, fuzzy matching |
| `empty-data.test.js` | 21 | Zero-usage edge cases across all modules |
| `shared/composition.test.js` | 18 | Token composition ratios, details, dominant analysis, cost quality labels |
| `shared/crypto.test.js` | 17 | Ed25519 keygen, signing, PEM, identity |
| `shared/version.test.js` | 13 | Semver comparison, compatibility, client metadata |
| `shared/date.test.js` | 13 | UTC day conversion, local day, week/month ranges |
| `shared/display.test.js` | 12 | Token formatting (compact, raw, locale), USD formatting |
| `loading.test.js` | 12 | *Pattern tests*: dedup, polling, modal (isolated, not production imports) |
| `state.test.js` | 8 | *Pattern tests*: scan state machine (isolated, not production imports) |
| `shared/i18n.test.js` | 8 | Key lookup, interpolation, plural forms |

**Real vs pattern**: 392 tests import and call real production functions. 20 tests (loading + state) test isolated design patterns.

### E2E Tests (Playwright + mock Tauri bridge): 52

| Spec | Tests | Scenario |
|---|---|---|
| `scan-and-view` | 6 | Today=1 provider (8.5K), all=2 providers (13K), models, workdirs |
| `workflows` | 5 | Provider toggle, source rows, update check, reset, backup |
| `responsiveness` | 5 | Stability smoke + performance budgets (5s boot, 2s range switch) |
| `navigation` | 4 | Screen switching, round-trip data preservation |
| `settings` | 4 | Tab panels, save flow (dirty→clean), language switcher, checkbox toggles |
| `i18n-zh` | 4 | zh-CN: lang attr, nav text, data load, range labels |
| `sync` | 3 | Rail state, badge text, API URL dirty state |
| `range-switch` | 3 | Exact values per range (8500/13000), cross-range validation |
| `onboarding` | 3 | Config-injected wizard via `__ATL_E2E_CONFIG__` |
| `large-dataset` | 3 | 1000 rows: render budget, range switch budget, workdir list |
| `empty-data` | 3 | Zero usage: placeholder, empty breakdowns, navigation safety |
| `error-states` | 3 | API errors: failed checkApi, cloud rail, settings status |
| `workdir-alias` | 2 | Drawer open/close, escape key |
| `scan-async` | 2 | Async scan (delay=500), concurrent scan during running |
| `i18n` | 2 | html lang attribute, translated text vs raw key |

### Rust Tests (cargo test): 193

| Module | Tests | Covers |
|---|---|---|
| `provider` | 34 | Provider detection, root scanning, source discovery |
| `observability` | 30 | Runtime event logging, structured events |
| `local_usage_store` | 13 | SQLite store: insert, query, trend (day/hour/week/month), summary, workdirs |
| `crypto` | 13 | Ed25519 keygen, signing, verification, PEM I/O |
| `sidecar` | 15 | Command dispatch, ping, config, providers, scan, workdir alias |
| `scanner` | 10 | File parsing, directory walking, source caching |
| `workdir` | 9 | Workdir hashing, normalization, alias |
| `diagnostics` | 9 | System info collection, export |
| `result` | 8 | Scan result aggregation, dedup |
| `protocol` | 8 | API serialization, transport |
| `schema` | 7 | Data validation, field normalization |
| `date` | 7 | UTC day math, week/month boundaries |
| `version` | 6 | Semver comparison, metadata |
| `sync` | 6 | Cloud sync upload/download |
| `config` | 6 | Config CRUD, persistence |
| `local_backup` | 5 | Backup create/restore/inspect/clear |
| `integration_scan` | 12 | End-to-end: fresh scan, incremental, range queries, crypto identity, backup |

---

## 2. Code Coverage (Vitest V8)

### Extracted Modules (high coverage)

| Module | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| `renderer-helpers.js` | **99.5%** | 89.5% | 98.6% | 99.4% |
| `renderer-data.js` | **96.3%** | 75.9% | 85.4% | 96.2% |
| `renderer-components.js` | **92.1%** | 88.8% | 82.0% | 97.8% |

### Shared Modules

| Module | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| `pricing.js` | **94.4%** | 84.8% | 100% | 100% |
| `date.js` | 89.3% | 68.0% | 100% | 100% |
| `display.js` | 84.2% | 75.9% | 100% | 92.9% |
| `composition.js` | 74.2% | 80.8% | 72.7% | 80.8% |
| `crypto.js` | 81.3% | 66.7% | 100% | 89.3% |
| `version.js` | 59.4% | 46.8% | 63.6% | 61.4% |
| `schema.js` | 41.6% | 37.0% | 50.0% | 41.7% |
| `i18n.js` | 36.2% | 38.9% | 31.3% | 38.2% |

### Uncovered (0%)

| Module | Reason |
|---|---|
| `renderer.js` (3866 lines) | Monolith — functions extracted to helpers/data/components. Remaining is DOM side effects, Tauri IPC, boot sequence |
| `update.js` (398 lines) | Release/packaging pipeline — tested via `scripts/release.sh`, not unit testable |
| `changelog.js` (59 lines) | Release notes parser — used at build time |
| `nickname-generator.js` (32 lines) | Client nickname generation — trivial, used once |
| `preset.js` (29 lines) | Build-time preset loader |

---

## 3. Not Yet Covered

### High Impact

| Gap | Why it matters | Recommended approach |
|---|---|---|
| `renderer.js` boot & DOM side effects | The 3866-line monolith still contains IPC handlers, boot sequence, UI state management, and DOM event wiring. Extracted functions are covered, but the glue code that calls them is not. | Continue extraction of stateless functions. For boot/DOM wiring, rely on E2E tests (52 cases already cover major flows). Full extraction to 0% monolith is unrealistic — target is to keep monolith as thin glue. |
| `renderer-data.js` branch coverage (75.9%) | 25% of branches uncovered — mostly in `groupWorkdirDetails`, `groupDailyRows`, `addDisplayCostToUsageItem` error/null paths. | Add edge-case tests: items with null model, null workdir, null cost fields, mixed null/undefined inputs. |
| Mock ↔ protocol drift | `mock-tauri.js` generates responses in-browser. If Rust API shapes change, mock tests still pass with stale shapes. | Add a contract test that compares mock response shapes against `sidecar.rs` command output schemas. |
| Native runtime boundary | Mock E2E validates product behavior through the browser renderer and mocked Tauri bridge, not real OS dialogs, updater install flows, shell URL opening, or platform-specific window behavior. | Treat mock E2E as the local product iteration gate. For release, packaging, updater, OAuth, backup filesystem, or platform integration changes, add real Tauri/manual smoke evidence on top of the mock gate. |

### Medium Impact

| Gap | Status |
|---|---|
| `i18n.js` (36% stmts) | 12/16 functions tested. Uncovered: `setLang`, `updatePageTranslations`, `createLangSwitcher`, `bindLangSwitcher` — all require DOM, covered by E2E `i18n-zh` spec. |
| `schema.js` (42% stmts) | 8/16 functions. Uncovered: `hourlyUsageKey`, `cloudNaturalKey`, `assertSnapshot`, `computeBucketFingerprint` — internal protocol helpers. |
| `version.js` (59% stmts) | Uncovered: `clientPlatform`, `clientBuild`, `clientMetadata`, `collectNetworkInfo` — platform detection, tested via integration tests. |
| `update.js` (0%) | Release/packaging — tested via `scripts/release.sh` and manual packaging. Not suitable for unit testing. |

### E2E Scenarios Not Covered

| Scenario | Complexity | Notes |
|---|---|---|
| Cursor OAuth connect flow | High | Requires external redirect to cursor.sh, not mockable in-process |
| Backup file operations (create→inspect→restore cycle) | Medium | Mock returns stub; real cycle requires filesystem |
| Update download lifecycle (download→verify→install) | High | Requires real Tauri binary and network |
| Provider root add/remove dialog interactions | Medium | Dialog open/close/save flow |
| Scan cancellation mid-flight | Low | `scanDelay` tested for completion, not for abort |
| Rapid double-scan during running state | Low | Partially covered by `scan-async` "rapid refresh" test |

### Sidecar API Coverage

61 total API commands in `sidecar.rs`. 55 have direct mock stubs in `mock-tauri.js`. The remaining 6 are native, scheduled, or external-auth commands that do not have first-class browser-mock behavior:

| Command | Notes |
|---|---|
| `platform` | Native platform query — mock not needed (E2E runs in browser) |
| `runDueAutoBackup` | Scheduled backup trigger — internal timer |
| `revealBackupDirectory` | Native shell reveal — no-op in mock |
| `addCursorToken` | Token storage — covered by Cursor connect E2E (requires real OAuth) |
| `openUrl` | Native shell operation — no-op in mock |
| `setDockVisible` | Native dock/window operation — no-op in mock |

`exportLocalBackup` is counted in the 55 direct mock stubs: E2E can assert that the backup action is wired and returns a stubbed success payload, but it does not validate the real create→inspect→restore filesystem cycle.

---

## 4. Bug Fix (2026-05-24)

**`local_usage_store.rs:281` — missing `"week"` grain in `trend()` method.**

Commit `103d6ff` moved trend aggregation from JS to Rust sidecar but omitted the `"week"` match arm. When `overviewRange === "30d"`, the frontend calls `api.usageTrend({ range: "30d", grain: "week" })`, and Rust fell through to the `_` default (day grouping), returning 30 daily buckets instead of 4-5 weekly buckets.

**Fix**: Added `"week"` branch using SQLite `date(day, '-' || ((strftime('%w', day) + 6) % 7) || ' days')` to compute ISO week start (Monday), matching the JS `startOfUtcWeek()` algorithm exactly.

**Tests added**:
- Unit: `trend_weekly_grain` — verifies 3 days across 2 weeks aggregate correctly
- Integration: week trend assertion in `scenario_multi_day_range_queries`

---

## 5. Test Gates

### PR Base (every PR)
```bash
npm test                      # Backend + shared module tests
npm run test:ui               # Renderer unit tests (412 tests)
cargo test --workspace        # Rust collector + sidecar (193 tests)
```

### Desktop UI Gate (desktop changes)
```bash
npm run test:e2e              # Mock E2E (52 tests)
```

### Full Gate (before release)
```bash
npm test && npm run test:ui && cargo test --workspace && npm run test:e2e
```
