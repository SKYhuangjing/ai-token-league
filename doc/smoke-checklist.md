# AI Token League MVP Smoke Checklist

## Local Run

```bash
npm test
npm run desktop:smoke
scripts/start-server.sh --env env.local
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
cat > .tmp-smoke/env.smoke << EOF
HOME=$PWD/.tmp-smoke/home
DB_PATH=$PWD/.tmp-smoke/data/db.json
PORT=8787
EOF
scripts/start-server.sh --env .tmp-smoke/env.smoke
```

In another terminal:

```bash
HOME="$PWD/.tmp-smoke/home" npm run collector:init -- --nickname smoke --api http://127.0.0.1:8787
HOME="$PWD/.tmp-smoke/home" npm run collector -- scan
HOME="$PWD/.tmp-smoke/home" npm run collector -- health
HOME="$PWD/.tmp-smoke/home" npm run collector -- sync
curl -s 'http://127.0.0.1:8787/api/leaderboard?range=today&tool=all'
```

## Expected Result

- collector scan returns `claude_code_local` and `codex_local` provider health.
- upload returns `accepted: 2`, `rejected: 0`.
- health/status output includes client version, client protocol, server version, latest client version, and compatibility.
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

## Admin BasicAuth

Start with auth enabled:

```bash
cat > .tmp-smoke/env.admin << EOF
HOME=$PWD/.tmp-smoke/home
DB_PATH=$PWD/.tmp-smoke/data/db.json
ADMIN_USERNAME=admin
ADMIN_PASSWORD=secret
EOF
scripts/start-server.sh --env .tmp-smoke/env.admin
```

Verify:

```bash
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/admin.html
# expect: 401

curl -s -o /dev/null -w '%{http_code}' -u admin:secret http://127.0.0.1:8787/admin.html
# expect: 200

curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/admin/usage
# expect: 401

curl -s -o /dev/null -w '%{http_code}' -u admin:secret http://127.0.0.1:8787/api/admin/usage
# expect: 200

curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/board/leaderboard
# expect: 200 (public when PUBLIC_BOARD_AUTH_USERNAME is not set)

curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/public-leaderboard
# expect: 404 (removed in 0.6)
```

## Board Security Levels

### Default (public)

```bash
scripts/start-server.sh --env .tmp-smoke/env.smoke
```

Verify:

```bash
curl -s http://127.0.0.1:8787/api/board/leaderboard | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.items[0]?.displayId?'OK: has displayId':'FAIL: missing displayId');console.log(d.items[0]?.displayName?'OK: has displayName':'FAIL: missing displayName')"
# expect: OK: has displayId, OK: has displayName

curl -s http://127.0.0.1:8787/api/board/leaderboard | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.items[0]?.participantId!==undefined?'FAIL: leaked participantId':'OK: no participantId')"
# expect: OK: no participantId
```

### Anonymous mode

```bash
cat > .tmp-smoke/env.board-anonymous << EOF
HOME=$PWD/.tmp-smoke/home
DB_PATH=$PWD/.tmp-smoke/data/db.json
BOARD_SECURITY_LEVEL=anonymous
EOF
scripts/start-server.sh --env .tmp-smoke/env.board-anonymous
```

Verify:

```bash
curl -s http://127.0.0.1:8787/api/board/leaderboard | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));const item=d.items[0]||{};console.log(item.displayId?.length===16?'OK: 16-char displayId':'FAIL: bad displayId');console.log(item.displayName?'OK: has displayName':'FAIL: missing displayName');console.log(item.participantId!==undefined?'FAIL: leaked participantId':'OK: no participantId');console.log(item.nickname!==undefined?'FAIL: leaked nickname':'OK: no nickname')"
# expect: all OK
```

### Authenticated mode (startup failure without credentials)

```bash
cat > .tmp-smoke/env.board-auth-missing << EOF
HOME=$PWD/.tmp-smoke/home
DB_PATH=$PWD/.tmp-smoke/data/db.json
BOARD_SECURITY_LEVEL=authenticated
EOF
scripts/start-server.sh --env .tmp-smoke/env.board-auth-missing 2>&1
# expect: FATAL error and process exit
```

### Authenticated mode (with credentials)

```bash
cat > .tmp-smoke/env.board-auth << EOF
HOME=$PWD/.tmp-smoke/home
DB_PATH=$PWD/.tmp-smoke/data/db.json
BOARD_SECURITY_LEVEL=authenticated
PUBLIC_BOARD_AUTH_USERNAME=board
PUBLIC_BOARD_AUTH_PASSWORD=secret
EOF
scripts/start-server.sh --env .tmp-smoke/env.board-auth
```

Verify:

```bash
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/leaderboard.html
# expect: 401

curl -s -o /dev/null -w '%{http_code}' -u board:secret http://127.0.0.1:8787/leaderboard.html
# expect: 200

curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/board/leaderboard
# expect: 401

curl -s -o /dev/null -w '%{http_code}' -u board:secret http://127.0.0.1:8787/api/board/leaderboard
# expect: 200

curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/release/config
# expect: 200 (public, no auth required)
```

## Current MVP Distribution

The MVP is distributed as:

- Backend and Web: `scripts/start-server.sh --env env.local`
- Collector CLI: `npm run collector -- <command>`
- Desktop collector UI: `npm run desktop`
- macOS arm64 app bundle: `dist/AI Token League-darwin-arm64.zip`
- macOS Intel x64 app bundle: `dist/AI Token League-darwin-x64.zip`
- Windows x64 app bundle: `dist/AI Token League-win32-x64.zip`
- Release checksum file: `dist/checksums.txt`
- Release manifest dry run: `node scripts/publish-release.js --env env.local --dry-run`

The Windows x64 bundle is produced on macOS and has been validated by external users on real Windows machines.
