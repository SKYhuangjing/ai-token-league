# AI Token League MVP Smoke Checklist

## Local Run

```bash
npm test
npm run desktop:smoke
npm start
```

Open:

```text
http://127.0.0.1:8787
```

## Collector E2E

Use an isolated home directory for smoke runs:

```bash
rm -rf .tmp-smoke
mkdir -p .tmp-smoke/home .tmp-smoke/data
HOME="$PWD/.tmp-smoke/home" DB_PATH="$PWD/.tmp-smoke/data/db.json" PORT=8787 npm start
```

In another terminal:

```bash
HOME="$PWD/.tmp-smoke/home" npm run collector:init -- --nickname smoke --api http://127.0.0.1:8787
HOME="$PWD/.tmp-smoke/home" npm run collector -- scan
HOME="$PWD/.tmp-smoke/home" npm run collector -- sync
curl -s 'http://127.0.0.1:8787/api/leaderboard?range=today&tool=all'
```

## Expected Result

- collector scan returns `claude_code_local` and `codex_local` provider health.
- upload returns `accepted: 2`, `rejected: 0`.
- leaderboard contains nickname `smoke`.
- leaderboard total tokens are `6260` for bundled samples.
- top workdir is `claude-project`.
- payload contains `workdirHash` and `workdirDisplayName`, not real local source paths.

## Duplicate Upload Check

Run sync twice:

```bash
HOME="$PWD/.tmp-smoke/home" npm run collector -- sync
HOME="$PWD/.tmp-smoke/home" npm run collector -- sync
```

Expected:

- API accepts the latest batch.
- leaderboard total remains `6260`, proving usage is upserted rather than added repeatedly.

## Current MVP Distribution

The MVP is distributed as:

- Backend and Web: `npm start`
- Collector CLI: `npm run collector -- <command>`
- Desktop collector UI: `npm run desktop`
- macOS arm64 app bundle: `dist/AI Token League-darwin-arm64.zip`
- Windows x64 app bundle: `dist/AI Token League-win32-x64.zip`

The Windows x64 bundle is produced on macOS and must be E2E tested on a Windows host.
