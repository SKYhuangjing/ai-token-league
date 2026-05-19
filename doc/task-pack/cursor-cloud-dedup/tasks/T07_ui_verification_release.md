# T07_ui_verification_release

## Task ID

- `T07_ui_verification_release`

## Owner Lens

- User-visible closure, regression, and release readiness.

## Goal

- 收口 UI 文案、i18n、诊断隐私、验证矩阵和发布动作，确保需求可交付而不是只有底层能力。

## Primary Executor

- main-agent / QA owner.

## Scope

- Update Sources UI copy from Add Cursor Token to Connect Cursor.
- Show active / refresh_failed / reauth_required states.
- Add i18n keys for zh-CN and en.
- Run verification matrix.
- Update release checklist or external actions if implementation changes release behavior.

## Out of Scope

- No new auth protocol decisions.
- No server dedup implementation.

## Owned Files / Modules

- `src/desktop/renderer.js`
- `src/desktop/index.html`
- `src/desktop/styles.css`
- `src/shared/i18n.js`
- `doc/task-pack/cursor-cloud-dedup/verification_matrix.md`
- `doc/task-pack/cursor-cloud-dedup/DEVELOPMENT_HANDOFF.md`
- `doc/task-pack/cursor-cloud-dedup/external_actions.md`

## Dependencies

- T03/T04/T05/T06 completed or ready for integration.

## Source Design Anchors

- `验证与可观察性`
- `发布策略`
- `待确认项`
- `输出检查清单`

## Independent Execution

- Read current desktop Sources rendering and i18n.
- No need to inspect private protocol internals beyond final states.

## Implementation Requirements

- User-facing text must use i18n.
- Do not show tokens or raw auth errors.
- Provide clear reconnect action for `reauth_required`.
- Handoff evidence must reference actual commands, outputs, screenshots if UI changed.
- Release notes must mention private protocol drift and fallback if relevant.

## Comment Requirements

- No comments unless UI state branching becomes non-obvious.

## Subagent Verification

- A verifier should run browser/desktop smoke and privacy grep.

## Acceptance

- API: All backend/client tests required by matrix pass.
- DB: No unexpected schema changes.
- Log: Privacy grep clean.
- State / Enum: UI renders all authStatus states.
- Permission / Tenant: No secret leakage in diagnostics/export.
- User-visible Output: Connect/Reconnect Cursor flows are understandable.
- Context / Evidence Fields: command outputs, screenshots, sanitized diagnostics.

## Verification

- `node --check src/desktop/renderer.js`
- `npm test`
- `cargo test --workspace`
- Desktop quick self-test if UI changed.
- Privacy grep for token field names and sample values.

## Evidence

- Required evidence: command outputs, UI evidence, privacy grep, updated handoff.
- Actual evidence belongs in handoff/evidence files, not by rewriting this task card.
