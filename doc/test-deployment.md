# AI Token League Test Deployment

This document describes the v0.2 test-environment deployment target introduced by E18.

## Scope

The test deployment uses:

- Docker Compose.
- Node.js backend and static Web in one container.
- An existing external MySQL service as persistent storage.
- The same public and admin Web pages as local development.

This is a test environment, not a public production deployment. Do not expose `/admin.html` to the public Internet until admin access protection is added.

## Start Backend Against Existing MySQL

For local debugging against the development database, use:

```bash
docker compose -f docker-compose.mysql.example.yml up --build -d
```

For test deployment against the test database, use:

```bash
ENV_FILE=env.test docker compose -f docker-compose.mysql.example.yml up --build -d
```

`docker-compose.mysql.example.yml` reads `${ENV_FILE:-env.local}` through `env_file`. The compose YAML intentionally does not repeat database credentials or runtime environment variables. `env.local` and `env.test` are local-only and ignored by git because they contain credentials. `env.example` is the committed template.

Current database split:

```text
env.local -> MYSQL_DATABASE=ai_token_league_dev
env.test  -> MYSQL_DATABASE=ai_token_league
```

The desktop client only stores `apiBaseUrl`. If both env files publish the backend on `http://127.0.0.1:8787`, the active container decides which database receives the upload.

Set the business day timezone with `TZ`. The default env files use:

```text
TZ=Asia/Shanghai
```

This matters because collector events and MySQL `DATE` values must be grouped by the user's business day, not by UTC midnight.

Alternative without storing credentials in compose:

```bash
cp env.example env.my-test
# edit env.my-test
ENV_FILE=env.my-test docker compose -f docker-compose.mysql.example.yml up --build -d
```

Open:

```text
http://127.0.0.1:8787
http://127.0.0.1:8787/admin.html
```

Health:

```bash
curl -s http://127.0.0.1:8787/api/health
```

Expected:

```json
{
  "ok": true,
  "dbType": "mysql"
}
```

## Migration

The backend can run `migrations/001_init_mysql.sql` at startup when:

```bash
MYSQL_AUTO_MIGRATE=true
```

Because this changes an external database schema, enable it only after confirming the target database is dedicated to this test environment or the table names are acceptable.

Current E18 decision:

- Do not use `cube-center-deploy`.
- Use dedicated databases:
  - `ai_token_league_dev` for local debugging.
  - `ai_token_league` for test deployment.
- Do not store credentials in this repository.

Core tables created by the migration:

```text
participants
devices
workdirs
usage_daily
upload_batches
model_prices
```

The migration file is:

```text
migrations/001_init_mysql.sql
```

When `MYSQL_AUTO_MIGRATE=false`, the backend expects these tables to already exist.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DB_TYPE` | `json` | Set to `mysql` for test deployment |
| `TZ` | `Asia/Shanghai` | Business day timezone for today/yesterday/week/month grouping |
| `MYSQL_HOST` | `127.0.0.1` | MySQL host |
| `MYSQL_PORT` | `3306` | MySQL port inside Docker network |
| `MYSQL_DATABASE` | `ai_token_league` | Database name |
| `MYSQL_USER` | `ai_token` | Database user |
| `MYSQL_PASSWORD` | `ai_token` | Database password |
| `MYSQL_AUTO_MIGRATE` | `true` | Whether backend runs migration SQL at startup |
| `HOST` | `127.0.0.1` | Server bind host; compose uses `0.0.0.0` |
| `PORT` | `8787` | Server port |

Committed template:

```text
env.example
```

Local ignored files:

```text
env.local
env.test
```

Compose selector:

```text
ENV_FILE=env.local  -> local debugging
ENV_FILE=env.test   -> test deployment
HOST_PORT=8788      -> optional host port override
```

## Smoke

Run local syntax and JSON-store regression:

```bash
npm test
node src/backend/server.js --smoke
```

Run MySQL smoke against the external service:

```bash
DB_TYPE=mysql \
MYSQL_HOST="$MYSQL_HOST" \
MYSQL_PORT="$MYSQL_PORT" \
MYSQL_DATABASE="$MYSQL_DATABASE" \
MYSQL_USER="$MYSQL_USER" \
MYSQL_PASSWORD="$MYSQL_PASSWORD" \
MYSQL_AUTO_MIGRATE=false \
node src/backend/server.js --smoke
```

Then run a collector sync against:

```text
http://127.0.0.1:8787
```

## Known Limits

- Docker build defaults to China-friendly mirrors:
  - base image: `docker.m.daocloud.io/library/node:22-bookworm-slim`
  - npm registry: `https://registry.npmmirror.com`
  Override with `NODE_IMAGE` or `NPM_REGISTRY` if a mirror is unavailable.
- The MySQL store keeps the existing in-memory aggregation logic and persists facts to MySQL. It is suitable for test deployment, not final production scaling.
- Aggregate cache is still in process memory for the MySQL deployment.
- Admin page access is not protected yet.
- Windows x64 client has been validated by external users on real Windows machines; repeat this check after packaging, updater, or Windows-specific changes.
- On the current macOS development machine, Docker containers cannot complete a MySQL connection to the external service and receive `PROTOCOL_CONNECTION_LOST`; the same credentials work from the host Node process. This needs test-environment network/VPN/MySQL access-policy validation before Docker runtime can be marked fully passed.
