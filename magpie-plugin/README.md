# magpie-atl-sync

[![npm version](https://img.shields.io/npm/v/magpie-atl-sync.svg)](https://www.npmjs.com/package/magpie-atl-sync)

A usage page in [magpie](https://usemagpie.ai)'s window that syncs everything magpie sees — the unified ledger (gateway ledger plus every local agent session magpie scans, deduped by request id) — to an [AI Token League](https://github.com/SKYhuangjing/ai-token-league) leaderboard, signed with its own Ed25519 identity.

Made by **Sky Huang**, part of [SKYhuangjing/ai-token-league](https://github.com/SKYhuangjing/ai-token-league) (this package lives in its `magpie-plugin/` directory).

## Install

```sh
magpie plugin add magpie-atl-sync
```

Or, for development, load the repo checkout in place:

```sh
magpie plugin add ./ai-token-league/magpie-plugin
```

It then has a page, **AI Token League** (用量), under Plugins in the sidebar. Installing from a git URL is not offered: magpie resolves a git repo's root `package.json`, and this plugin is a subdirectory — npm is the only outside channel.

The **请求 Hook** badge and **选项** button on the plugin card are magpie's standard furniture for every gateway-hook plugin: the hook is the sync trigger (and the anchor that keeps the host resident), and 选项 is magpie's own JSON editor over the same options the settings page writes. You normally touch neither.

## What it does

- **The same numbers magpie's usage page shows.** Unified scope — gateway ledger plus the local sessions magpie scans (ZCode, Claude Code, Codex, OpenCode, Kimi, WorkBuddy, DSH, Hermes), request-id deduped. Not "gateway-only traffic": any usage magpie can see is carried up.
- **Attribution by agent.** `zcode→zcode_local`, `claude→claude_code_local`, `codex→codex_local`, `opencode→opencode_local`, `kimi→kimi_local`, `workbuddy→workbuddy_local`, `dsh→dsh_local`, `hermes→hermes_local`; magpie's own traffic lands in `magpie_local`, a source the ATL client never measured. An agent ATL has no source for is skipped and counted, never mis-attributed.
- **Signed hourly buckets.** The same protocol as the official collector: Ed25519-signed hourly snapshot buckets to `/api/usage/daily-batches`. Whole-bucket overwrites are idempotent — repeated uploads are safe.
- **A usage page.** Ranges today / 7d / 30d / all. KPIs: total (today carries yesterday as a reference sub-row), cache read with a prompt-basis hit rate, requests (failures in red), cost (`≈$`, the list-price estimate from magpie's own cost column; blank when the channel carries none). A trend chart — tokens/requests/cost × source/model — whose legend rows double as filters. A 53-week heatmap. A board line `● nickname · anonymous name · #all-time rank · N-day streak · 打开榜单` from one `/api/board/profile` call; the button opens the board in your browser. Skeleton, empty, syncing and failed states all exist; on failure the last data stays.
- **A settings page.** An identity row (nickname, source chip, truncated id, import/export), server URL, a one-shot rename, start date, sync frequency (5/15/30/60 minutes, immediate), test connection, sync now. No standing explainer text — scopes, formulas and privacy notes live in tooltips.
- **Numbers look like magpie's.** K/M/B, or 万/亿 when magpie's `chineseUnits` setting is on (it rides the status bridge; off by default, as in magpie). Colors, fonts and language come from the window.
- **A portable identity.** Import adopts an ATL config export as an explicit identity switch — server URL included, old identity backed up beside it — so the same identity can move between machines, or between this plugin and the ATL client. Export writes the same shape to `~/Downloads/atl-magpie-config-<timestamp>.json` (0600, contains the private key, stays on your machine).
- **Privacy.** Upload items are whitelist-built: day, hour, toolCode, providerId, a salted virtual workdir hash, display name "Magpie", lowercased model, the four token counts, reasoning, quality, and a ≤160-char trace text. `providerAccount`, `host`, `session`, `native_session`, `response_id` and friends are dropped at the parse layer and physically absent from the payload — test-asserted.

It registers no provider, asks for no sign-in and keeps no gateway key. The page frame has no network of its own; every byte it shows arrives through files the sync writes.

## How it works

A plugin page runs in a sandboxed frame with no network (`connect-src 'none'`). So this plugin has two parts:

1. `page/`: the page magpie hosts. It reads theme, language and options through `_magpie/bridge.js`, and loads `status.js` / `usage-data.js` as same-origin `<script src>` — that is the only way data crosses into it. Its buttons cannot leave the sandbox: sync now / test connection / export write a pending command with a nonce into options, which the host executes exactly once; 打开榜单 hands an http(s) URL to the host, which opens your browser (the URL goes as an argument, never through a shell).
2. `hooks.js` + `sync.js` + `lib/`: run by magpie's Bun plugin host. Every trigger spawns a detached one-shot `bun sync.js`; the hooks never throw and never block the gateway. Triggers: gateway activity (throttled to one sync a minute), a resident catch-up timer at the configured frequency, host startup, and page commands.

### What the sync reads and sends

- From magpie, in order: `magpie usage --csv`, the official CLI export of the unified ledger (routine syncs read a rolling window, default 7 days, ~0.8s; the first sync of each day — also the first ever, `--full`, or a missing page-summary cache — reads full history and re-verifies every bucket fingerprint, uploading any drift); the gateway JSON API `GET /v1/magpie/usage/requests` when the CLI is unavailable (loopback needs no key; paged, so window-only); the raw ledger `~/.config/magpie/usage.jsonl` as last resort (gateway-only scope).
- To the configured server only: the signed hourly buckets above. Nothing else, nowhere else.
- State under `~/.config/magpie/atl-sync/`: `identity.json` (0600), per-server `sync-state.<server>.json` bucket-fingerprint manifests (resumable incremental syncs), the page-summary cache, and `sync.log`.

### Sharing an identity with the ATL client

Since 2026-11-01 the server arbitrates writers, so running the ATL desktop client and this plugin on one identity at the same time is supported: the client's version of an hour bucket always wins, the plugin fills the hours the client cannot see (background gateway batches), and `magpie_local` is always the plugin's. A request crossing midnight may be counted by both in adjacent hours — tens of thousands of tokens, by design. One device identity imported onto two machines at once is still out of scope: register each machine as its own device.

## Options

```json
{ "apiBaseUrl": "", "syncIntervalMinutes": 15, "gatewayWindowDays": 7, "usageSource": "auto" }
```

The settings page writes these same keys. `apiBaseUrl` starts empty on purpose — the sync refuses until a server is configured. `syncIntervalMinutes` is the catch-up cadence (5/15/30/60 in the page; any whole minute via options). `gatewayWindowDays` is how far back routine syncs look (1/7/30; 0 = always full history). `usageSource` pins the channel: `auto` tries CSV, then the API, then the ledger; `gateway` / `ledger` pin one.

## Diagnostics from a terminal

```sh
cd <plugin dir>
bun sync.js --dry-run           # print buckets and totals; upload nothing
bun sync.js --test-connection   # probe the configured server
bun sync.js --export-config     # write a migration file to ~/Downloads
```

`--full`, `--window <1|7|30>`, `--api`, `--since-day`, `--source` exist too; `bun sync.js` with no arguments prints the full list. Exit code 3 is an integrity refusal, not a crash.

## Integrity fuse

Before any upload the data is checked for shape and completeness: route-id form, response-id uniqueness, bad-row share (over 5% reads as format drift). Anything anomalous refuses loudly (exit 3); it never silently misreports.

## Known limits

- Workdir / project attribution degrades to one virtual bucket, "Magpie" (CSV and API carry no cwd).
- Usage of a tool that never routes through magpie and whose sessions magpie does not scan is invisible here — leave that source to the ATL client.
- The gateway-API fallback is window-limited; deep paging through months is too slow to be useful.
- Cloud-side pruning (full reconcile) and sync-state diff reconciliation are future work.

## Test

```sh
cd magpie-plugin && bun test
```

Covers signing golden samples and fingerprints, aggregation, PII assertions, integrity checks, the real host's `plugins.json` shape, identity migration, import-with-server, and the units bridge.

## License

MIT, © 2026 Sky Huang. See [LICENSE](LICENSE).

---

中文：把 Magpie 看得见的全部用量（网关账本 + 全部本地 agent 会话扫描，按 request id 去重，与自带「用量」页同口径）以 Ed25519 签名的小时桶同步到 AI Token League 榜单。按 agent 归因到 ATL 既有来源，Magpie 自身流量进新来源 `magpie_local`；上传载荷白名单构造，账号邮箱、host、session 等永不离开本机（有测试断言）。插件页提供用量看板（KPI、趋势、53 周热力图、榜单名次条）与设置（服务端地址、同步频率、身份导入/导出）。与 ATL 桌面客户端同身份双开自 2026-11-01 起由服务端写者优先级仲裁，安全；npm 是唯一对外安装通道。
