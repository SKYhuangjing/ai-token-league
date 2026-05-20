# External Actions

> Use this file to expose release-time actions during task-pack decomposition.
> Before production release, keep DDL/DML/config/job/cutover operations in one executable release checklist or cutover SOP.

## Required Release Assets

| Asset | Status | Purpose |
|---|---|---|
| release checklist / cutover SOP | pending | publish order, protocol gate, reset/reupload flow, rollback, observation |
| DDL / DML scripts | not expected | no server DDL currently planned; revisit if account data moves server-side |

## Action Checklist

| Category | Required Action | Evidence |
|---|---|---|
| Protocol Gate | verify Cursor `auth/poll` and `oauth/token` before release | sanitized probe output |
| Configuration | document `cursorDashboardUsage.accounts[]` shape and redaction rules | config sample + diagnostics export |
| Reset / Reupload | define cloud reset and local manifest invalidation order | API output + local manifest evidence |
| Rollback | revert to the prior release if Cursor OAuth is unavailable; legacy manual token is not a supported product entry in this version | release notes + UI evidence |
| Observation | monitor Cursor reauth_required count, sync-state missing count, dedup deleted count | log/admin output |
