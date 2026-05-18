# Changelog English · [简体中文](CHANGELOG.zh-CN.md)

All notable changes to AI Token League will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.6.4] - 2026-05-18

### Fixed

- [Desktop] Show all 24 hourly labels (HH:00) in overview trend spark axis instead of only every 6th hour.
- [Desktop] Fixed scan interval (refreshIntervalMinutes) save not taking effect by parsing the input value as a number before sending to the backend.

---

## [0.6.3-test.1] - 2026-05-17

### Fixed

- [Desktop] Fixed GitHub draft release updater JSON generation by reading signature assets through the release asset API and writing stable tag-based updater download URLs.
- [Desktop, Web] Updated GitHub release notes generation to include both English and Simplified Chinese changelog sections.

---

## [0.6.3] - 2026-05-16

### Changed

- [Desktop] Migrated local collection, desktop sidecar, and CLI runtime from Node.js to the bundled Rust `atl-collector` binary.
- [Desktop] Added hourly local collection and hourly snapshot upload so future reporting can analyze daily working-time bands.
- [Desktop] Updated Tauri packaging and GitHub release builds to bundle the Rust collector sidecar for each target platform.

### Fixed

- [Desktop] Preserved Cursor dashboard collection, packaged preset loading, background refresh, launch-at-login, and offline upload queue behavior on the Rust runtime path.
- [Web] Kept legacy daily uploads compatible while new hourly uploads derive protected daily totals on the server.

---

## [0.6.2] - 2026-05-14

### Added

- [Desktop] Added system tray and macOS menu bar support with quick access to open the app, refresh usage, cloud sync, and source status.
- [Desktop] Added cloud usage bucket snapshot sync so local collector state can reconcile aggregate usage bucket state from the server.
- [Web] Redesigned the public leaderboard with a compact masthead, Top 3 medal cards, and Meter/List view switching.

### Fixed

- [Desktop] Corrected the client version shown in desktop update status so it follows the packaged app version.
- [Desktop] Fixed desktop refresh and update policy defaults so they are owned by the app instead of preset/runtime env injection.
- Fixed Cursor dashboard token parsing when the token is provided through a cookie header.

### Changed

- [Desktop] Reordered the tray menu so open, refresh, and cloud actions are grouped at the top.

---

## [0.6.1] - 2026-05-13

### Fixed

- [Desktop] Fixed desktop auto-refresh scheduling so the periodic scan timer starts and stops correctly.
- [Web] Updated leaderboard identity copy for clarity.
- [Web] Swapped cost-quality label/amount styling and isolated composition cost display in breakdown tiles.
- [Web] Restored `colAlias` i18n key and inlined composition percentages into each token column in the raw data table.

### Changed

- [Web] Inlined estimated cost into token cells and removed the standalone cost column from admin and leaderboard detail tables.
- [Web] Hardened XSS escaping on all formatted cost values with `escapeHtml()`.
- [Web] Simplified download landing page by removing redundant preview header.

---

## [0.6.0] - 2026-05-13

### Added

- [Desktop] Redesigned the desktop client into a token workstation with `Overview`, `Workdirs`, `Sources`, and `Settings` as primary navigation.
- [Desktop] Added range-aware Overview metrics for total tokens, composition, trends, top providers, top models, top workdirs, source readiness, and cloud/sync status.
- [Desktop] Added a first-class Workdirs analysis surface with contribution, model split, usage history, and alias management.
- [Desktop] Added a first-class Sources management surface for provider enablement, detected/manual/ignored/preset sources, Cursor tokens, and scan cadence.
- [Desktop] Added auto-sync after foreground scan: when source fingerprint changes since the last successful sync, the desktop automatically uploads without requiring manual Sync Now.
- [Desktop] Added spark bar value overlays showing token count and estimated cost per bar on the Overview trend chart.
- [Desktop] Added auto-check for updates when opening the Cloud settings tab when cloud is reachable and no update is already downloaded.
- [Desktop] Added auto-download when checking updates and silent update mode is `auto_download` or `auto_apply_on_idle`.
- [Desktop] Added centralized update action rendering with distinct badge states for available, downloading, and ready-to-install.
- [Web] Redesigned the public download page with a product hero, installer cards, board preview, desktop screenshot gallery, and latest updates.
- Added shared changelog parsing so the public download page can show tagged user-facing release notes.

### Changed

- [Desktop] Consolidated Settings around profile, app preferences, cloud, updates, diagnostics, reset, import, and export after Sources moved to primary navigation.
- [Desktop] Refreshed rail and cloud status behavior so saved API base URL changes clear stale cloud/update state and the rail reflects local, checking, online, offline, and unavailable states.
- [Desktop] Clicking `Overview` now triggers a local usage refresh using the existing scan path.
- [Desktop] Updated card inline actions and destructive row styling so contextual operations stay with their rows and destructive actions are visually distinct.
- [Desktop, Web] Updated desktop screenshots used by README and the public download page.
- [Desktop, Web] Breakdown items (models, workdirs, providers, tools) now carry per-item cost fields (`estimatedCostUsd`, `costQuality`) so cost is visible alongside token counts.
- [Web] Public latest updates now show only changelog entries tagged `[Desktop]`, `[Web]`, or `[Desktop, Web]`.
- [Web] Leaderboard breakdown bars now show estimated cost alongside token counts.
- Board summary responses now include identity display metadata for public preview copy.
- OpenRouter warm refresh recalculates costs when a fresh cache still has missing-price models.
- Upload queue dedup now matches on source fingerprint in addition to payload hash, preventing duplicate entries when the same scan result is re-queued.
- Source fingerprint moved from upload payload to queue entry level so it is not sent to the server; payloads are re-signed without the field before upload.
- Config import and first-run now initialize API connection state so the rail reflects the actual cloud status immediately.

### Documentation

- Updated the 0.7 baseline and development task docs with a reverse-sync ledger for the 0.7.0 implementation commits.
- Updated release workflow reminders so public-download-page changelog items are tagged explicitly.

---

## [0.5.3] - 2026-05-09

### Added

- Added interactive `scripts/release.sh` release builder with platform, env, installer, and upload options.
- Added bilingual `mac-install-readme.txt` injection into generated macOS DMGs.
- [Desktop] Added anonymous identity display in the desktop rail and refined anonymous leaderboard labels.
- [Web] Added home navigation links to Admin and leaderboard mastheads.
- Added admin participant detail route that works under board authentication.
- [Desktop] Settings effect model: display preferences (showRawTokens, showEstimatedCost) now auto-save instantly on toggle.
- [Desktop] Dirty state tracking for save-required settings (nickname, API base URL, launch at login, auto-refresh, update mode) with visual Save button highlight.
- [Desktop] Reset data confirmation modal with "Local only" and "Local + Cloud" deletion options.
- New `DELETE /api/participant/data` API endpoint for server-side participant data deletion.
- [Desktop] Unsaved API base URL warning before Sync now / Check update actions.

### Changed

- [Web] Redesigned public download preview cards and participant badge presentation.
- [Desktop] Source toggle controls now use a switch-style UI.
- Participant cloud reset is now idempotent.
- Board views now refresh against the active business-day state.
- [Desktop, Web] Completed Chinese locale coverage for current UI surfaces.
- `scripts/release.sh --platform current` now builds a single zip for the current machine.
- `scripts/release.sh --upload` now automatically switches to all platforms and enables installer builds so release upload does not fail after partial packaging due to missing zip or DMG/NSIS artifacts.
- [Desktop] Source toggle buttons now use icon-only design instead of ON/OFF text labels.
- [Desktop] Trend dashboard metrics respect showRawTokens setting for consistent formatting.

### Documentation

- Updated developer docs to prefer `scripts/start-server.sh` for local service startup and `scripts/release.sh` for local packaging/release flows.
- Documented the local development rule that package-related work should produce one current-machine zip artifact for fast debugging.

---

## [0.5.2] - 2026-05-07

### Fixed

- [Desktop] Fixed electron-updater download path, macOS update bundle detection, and restart button behavior.
- [Desktop] Restored macOS zip updater with dual-path update architecture: Windows uses electron-updater + NSIS, macOS uses custom zip updater (no Developer ID required).
- Restored `/api/release/latest` endpoint and `latest.json` manifest for macOS zip updater compatibility.
- Fixed cursor provider enabled check logic.

### Changed

- Release script now archives `installer.json` and `latest.json` to versioned folder in OSS.

---

## [0.5.1] - 2026-05-07

### Changed

- [Desktop] Replaced custom update system with `electron-updater` for Windows desktop updates.
- [Desktop] Windows now uses NSIS installer updates with built-in file lock handling.
- [Desktop] Added three update modes: `notify`, `auto_download`, `auto_apply_on_idle`.
- [Desktop] Added download progress push via IPC `update:progress` events.

---

## [0.5.0] - 2026-05-07

### Added

- [Web] Added HTTP Basic Auth protection for admin routes (`/admin.html` and `/api/admin/*`), configured via `ADMIN_USERNAME` + `ADMIN_PASSWORD` environment variables.
- [Web] Added `MIN_CLIENT_ENFORCE` to block outdated clients from uploading when enabled.
- [Web] Added admin devices panel showing registered devices per participant.
- [Desktop, Web] Added multi-language (i18n) support for desktop and web UI.
- Added admin usage row detail semantic optimization.
- [Desktop] Added a reworked desktop Settings information architecture: Profile, App, Sources, Cloud, and About.
- [Web] Added cache read price visibility to the admin model pricing UI.
- [Web] Added Missing Price task click-through that fills and focuses the model price input.
- Added `scripts/bump-version.js` and `npm run bump -- <version>` for coordinated release version updates.
- Added `scripts/start-server.sh` for local server startup with env selection, smoke mode, detached mode, log, and pid options.

### Changed

- [Desktop] Desktop Settings > App now owns language, estimated cost display, raw token display, and launch-at-login preferences only.
- [Desktop] Desktop Settings > Sources now owns local sources, Cursor token configuration, workdir aliases, and the local source scan cadence.
- [Desktop] Desktop Settings > Cloud now owns API base URL, cloud status, manual sync, and sync status.
- [Desktop] Desktop Settings > About now owns version status, update policy, diagnostics export, and local data reset.
- Source scan cadence now explicitly means local data source scanning; when cloud is configured, the same cadence also uploads daily aggregates after scanning.
- [Web] Public Web masthead and download controls were compressed to free more first-screen space for the leaderboard table.
- [Web] Public Web download controls now keep platform selection and download action while removing the redundant "Download client" title copy.
- [Web] Admin language switcher was moved into the masthead and aligned to the right on desktop layouts.
- [Desktop] Desktop language switcher was moved into Settings > App with the other application preferences.
- [Web] Admin model price lists now show input, output, and cache read prices for custom prices and OpenRouter cache entries.
- Desktop and Web UI text added in this release continues to use `src/shared/i18n.js`.

### Documentation

- Updated `doc/0.5-baseline.md` with the complete 0.5.0 product baseline and temporary/opportunistic change ledger.
- Updated `doc/0.5-development-tasks.md` with Epic 1 through Epic 10 task status and verification criteria.
- Updated release/version workflow documentation for `npm run bump`.
- Updated local development startup guidance for `scripts/start-server.sh`.

### Verification Coverage Added

- Admin Basic Auth 401/200 behavior and public route non-regression.
- `MIN_CLIENT_ENFORCE` compatibility blocking and default non-blocking behavior.
- Admin devices route and panel rendering.
- Public Web, Admin, and Desktop i18n switching.
- Admin Usage row-click date bucket semantics.
- Desktop Settings tab ownership and source scan cadence tooltip semantics.
- Model Price cache read display and Missing Price form fill interaction.
- Public download controls and language switcher positioning.
- Version bump script syntax and version-source rules.
- Local server startup script syntax and option surface.

---

## [0.4.0] - 2026-05-06

### Added

- Added a first-run desktop setup wizard that replaces silent onboarding with explicit identity, privacy, source, cloud connection, and ready-to-start steps.
- Added interactive CLI initialization when no config exists and no `--nickname` flag is provided.
- Added full config export/import for desktop users, while keeping older identity-only profile imports compatible.
- Added local desktop runtime logs and a sanitized diagnostics export from Settings > App.
- Added admin-side participant reset through `DELETE /api/admin/participants/:participantId`, including upload batch cleanup so corrected clients can re-sync the same aggregate facts.
- Added explicit model price aliases through Admin APIs and UI:
  - `POST /api/admin/model-price-aliases`
  - `DELETE /api/admin/model-price-aliases/:model`
- Added MySQL persistence for model price aliases.
- Added restart-based zip update application for macOS and Windows desktop packages.
- Added configurable silent update behavior:
  - `notify`
  - `auto_download`
  - `auto_apply_on_idle`
- Added native installer builds:
  - macOS Apple silicon DMG
  - macOS Intel DMG
  - Windows x64 NSIS installer
- Added installer metadata into the release manifest when installer artifacts are available.
- Added installer download preference on the public Web download panel.

### Changed

- Cursor dashboard model normalization now maps `default`, `auto`, and empty model names to display model `Auto`.
- Cursor `Premium (...)` display models are preserved as uploaded/displayed model names instead of being rewritten.
- Pricing no longer guesses `Premium (...)` or `Codex x.y` model mappings implicitly; missing prices require an explicit admin alias.
- Settings > App now owns diagnostics and update controls.
- Update application no longer asks users to manually replace app files when a supported zip package is available.
- Release publishing now supports native installer upload alongside zip artifacts.
- `release:publish` now builds release artifacts before upload.

### Fixed

- Admin participant reset now clears upload-batch dedupe state together with uploaded usage facts.
- Deleting a custom price target also removes aliases pointing to that target and recalculates costs.
- Silent update apply is guarded by an idle check so it does not run during foreground scan, sync, diagnostics export, config import/export, identity import/export, or another update operation.

### Documentation

- Added `doc/0.4-baseline.md`.
- Added `doc/0.4-development-tasks.md`.
- Updated `doc/packaging.md` with native installer build, release, and verification steps.
- Updated roadmap status for the 0.4.0 release scope.
- Added MySQL migration for `model_price_aliases`.

### Verification Coverage Added

- Participant reset allows the same client payload to sync again after server-side cleanup.
- Cursor `Auto` display behavior.
- Cursor `Premium (...)` display preservation.
- No implicit Premium/Codex pricing conversion.
- Explicit alias pricing with `pricingModel` pointing to the mapped target.
- Silent update mode normalization and update state behavior.
- Native installer manifest compatibility.

---

## [0.3.0] - 2026-05-06

### Added

- Added app, client protocol, server, and provider/parser version separation.
- Added client metadata to registration, health, and daily batch upload flows:
  - `clientAppVersion`
  - `clientProtocolVersion`
  - `clientPlatform`
  - `clientBuild`
- Added server compatibility responses with current/latest version and protocol support details.
- Added Desktop and CLI visibility for local version, server version, latest version, and compatibility status.
- Added update manifest schema and checksum verification helpers.
- Added OSS-backed release publishing script.
- Added `/api/release/latest` and `/api/release/config` release metadata endpoints.
- Added public Web client download entry for macOS Apple silicon, macOS Intel, and Windows x64 artifacts.
- Added macOS Intel x64 desktop package support.
- Added checksum generation for packaged release zips.

### Changed

- Settings were reorganized into clearer Account, Sources, Cloud, Sync, and App domains.
- Cloud Connection became the single source for API target, server compatibility, release config, pricing, and update checks.
- Sync settings no longer own the global API base URL.
- App update checks no longer read local release environment fallback values from the client.
- Public Web download links are fetched from the app-server release API instead of embedding OSS details in the frontend.
- Packaging excludes local env files, docs, tests, Docker assets, backend/Web server assets, previous release artifacts, and release scripts from the desktop client package.

### Fixed

- Unsupported client/server compatibility outcomes now block upload without deleting queued usage.
- Update download and checksum failures leave the current client usable and preserve identity, config, tokens, aliases, cache, and upload queue.
- Cursor first-install status now distinguishes local detected accounts from manually configured tokens and from not-detected state.
- Cursor source wording now avoids implying that only manually saved tokens count as detection.

### Documentation

- Added `doc/0.3-baseline.md`.
- Added `doc/0.3-development-tasks.md`.
- Updated packaging, smoke, deployment, README, and roadmap docs for the 0.3 release/update flow.
- Added release environment placeholders to `env.example`.

### Verification Coverage Added

- Compatibility matrix for current, old, future, missing, and malformed client metadata.
- Register/upload/health version metadata handling.
- Update manifest validation for unsupported platforms and missing/bad checksums.
- Release publishing order: versioned artifacts first, manifest/latest last.
- Desktop smoke coverage for version and update UI.
- Package artifact version and checksum coverage for macOS arm64, macOS x64, and Windows x64.

---

## [0.2.0] - 2026-04-30

### Added

- Added sync status visibility and safer background refresh controls in the desktop app.
- Added env-based MySQL test deployment support, including documented Docker Compose startup and deployment configuration.
- Added the 0.2 desktop baseline with generated app icons, refreshed desktop assets, and packaging documentation.
- Added Cursor dashboard account/token handling with modal-based token entry, local validation, dedupe, and account summary display.
- Added source-card ownership for Codex, Claude Code, and Cursor enablement.
- Added token composition design and cache-token normalization rules.
- Added OpenRouter-backed model pricing refresh and token composition accounting.
- Added model-price administration, missing-price visibility, and cost recalculation support.
- Added web and desktop UI surfaces for token buckets, estimated cost, model/workdir composition, and pricing quality.
- Added `AGENTS.md` with project instructions, commands, API surface, storage paths, and verification rules.

### Changed

- Promoted the active upload API from the v0.1 `/api/usage/upload` shape to `POST /api/usage/daily-batch`.
- Defined ranking truth as `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`, with reasoning tokens kept as diagnostic/cost fields.
- Normalized Codex and Claude Code input tokens at collection time by subtracting cache read/write tokens from raw input.
- Kept Cursor dashboard usage semantics aligned with Cursor's own API definition instead of applying local input normalization.
- Moved Cursor settings into the Sources card model instead of keeping a separate Cursor dashboard settings block.
- Made source On/Off a configuration action only; it no longer forces immediate usage scanning or Cursor dashboard calls.
- Updated public README positioning for GitHub discovery, privacy model, supported providers, and desktop packaging status.

### Fixed

- Fixed the desktop first-run scan flow so the initial experience no longer blocks on avoidable scan/config timing.
- Fixed Claude Code parsing so model names carry forward when individual records omit repeated model fields.
- Changed local provider parsing to async file I/O to reduce UI freezes during large Codex or Claude Code scans.
- Fixed token composition denominator behavior so cache-inclusive totals no longer produce impossible composition percentages.
- Regenerated favicon/app icon assets for desktop and Web packaging.

### Documentation

- Added `doc/0.2-baseline.md`.
- Added `doc/usage-composition-design.md`.
- Added `doc/openrouter-pricing-design.md`.
- Updated `doc/packaging.md`, `doc/test-deployment.md`, `doc/product-design.md`, and `doc/mvp-development-tasks.md`.
- Added roadmap material in `doc/roadmap.md`.

### Verification Coverage Added

- Provider cache normalization and total-token invariants.
- Cursor token input parsing and account summary behavior.
- Desktop source toggle behavior without forced scan.
- OpenRouter price refresh, custom price handling, and missing-price quality labels.
- JSON and MySQL persistence paths for usage and pricing data.

---

## [0.1.0] - 2026-04-30

### Added

- Established the AI Token League MVP as a local-first AI coding token usage collector plus public leaderboard.
- Added local collectors for:
  - Codex local session JSONL logs.
  - Claude Code local project logs.
  - Cursor dashboard usage when explicitly enabled.
- Added anonymous local identity generation with `participantId`, `deviceId`, signing key, profile export, and profile import.
- Added privacy-preserving workdir handling with `workdirHash`, display names, and user aliases instead of real absolute paths.
- Added signed usage upload and backend storage for daily aggregate usage facts.
- Added JSON backend storage and an initial MySQL store/migration path.
- Added public Web leaderboard, participant detail view, and trend data APIs.
- Added Admin usage ranking and model price management pages.
- Added Electron desktop app with Today, Trend, and Settings views.
- Added CLI commands for init, scan, register, sync, profile export, and profile import.
- Added token, cost, date, display, schema, and crypto shared helpers.
- Added smoke, unit-style Node tests, Docker deployment examples, and sample usage data.
- Added macOS arm64 and Windows x64 packaging scripts and zip generation.

### Changed

- Defined the core privacy boundary: the server must not receive prompts, assistant responses, source code, full transcripts, real absolute paths, Cursor session tokens, or identity private keys.
- Defined `totalTokens` as the public ranking metric, with estimated cost as secondary display data.
- Kept Cursor workdir attribution virtual because Cursor dashboard usage does not provide local project paths.
- Structured docs around product design, ER model, MVP task history, smoke checklist, and test deployment.

### Verification

- macOS collector-to-Web flow verified locally.
- Backend smoke verified locally.
- Desktop smoke verified locally.
- macOS arm64 and Windows x64 packages generated.
- Windows host E2E was still pending at the 0.1.0 baseline.

---

## Build And Release Tooling

- Added `scripts/publish-release.js` for release artifact planning, checksum generation, manifest generation, and OSS upload.
- Added `scripts/zip-dist.js` for packaged zip generation.
- Added `electron-builder.yml` for native DMG/NSIS installer builds.
- Added `release:build`, `release:dry-run`, `release:upload`, and `release:publish` scripts.
- Added macOS Intel packaging scripts.
- Added `dist-installer/` release artifact flow.

## Upgrade Notes

- The active upload route remains `POST /api/usage/daily-batch`.
- Ranking truth remains `totalTokens`; cost remains optional display data.
- Desktop updates require a configured Cloud Connection because update metadata is served by the app-server.
- Native installers are generated for distribution, but zip artifacts remain part of the updater flow.
- Admin model price aliases change cost calculation only; uploaded/displayed usage model names remain unchanged.
- Admin participant reset deletes server-side aggregate data only. It does not delete local identity, local usage cache, upload queue files, source config, Cursor tokens, or user machine data.
