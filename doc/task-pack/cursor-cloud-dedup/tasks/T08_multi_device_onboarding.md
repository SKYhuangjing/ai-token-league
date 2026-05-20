# T08_multi_device_onboarding

## Task ID

- `T08_multi_device_onboarding`

## Owner Lens

- Multi-device onboarding and user intent clarity.

## Goal

- 在初次引导中把“创建新身份”和“加入已有排行榜身份”分清，确保第二台设备加入同一 `participantId` 时仍保留自己的 `deviceId`。

## Primary Executor

- worker / frontend-desktop engineer.

## Scope

- Add onboarding choice for new identity vs join existing participant.
- Make new identity the default for fresh users.
- Make join existing participant the recommended path when user imports an identity/config from another device.
- Route join flow to identity/config import behavior that preserves local `deviceId`.
- Add zh-CN / en i18n for the choice, warning, success, and follow-up `Connect Cursor` prompt.

## Out of Scope

- No server dedup implementation.
- No Cursor OAuth protocol changes.
- No local backup restore implementation.

## Owned Files / Modules

- `src/desktop/renderer.js`
- `src/desktop/index.html`
- `src/desktop/styles.css`
- `src/shared/i18n.js`
- `src/desktop/tauri-bridge.js`
- Relevant desktop command bridge files if onboarding calls Tauri commands.

## Dependencies

- T09 must provide the underlying `join_existing_participant` import mode before this flow can be fully wired.
- T03/T04 provide the follow-up `Connect Cursor` action and states.

## Source Design Anchors

- `成功标准`
- `多设备身份引导与导入配置`
- `用户意图选择`
- `验收口径`

## Independent Execution

- Read the desktop onboarding / first-run rendering path, config import bridge, and i18n keys.
- Read only enough of `collector-core/src/config.rs` to understand the command return shape.
- No need to inspect backend Store internals or Cursor protocol details.

## Implementation Requirements

- Do not expose `deviceId` as the primary user choice.
- UI must ask for user intent: create new identity vs join existing leaderboard identity.
- Join flow must preserve current local `deviceId`; if no local config exists, it must generate a fresh `deviceId`.
- After join succeeds, prompt the user to run `Connect Cursor` on this device instead of implying Cursor credentials were imported.
- User-facing text must use i18n.
- Do not show identity private key, Cursor tokens, or raw config secrets in renderer-visible output.

## Comment Requirements

- No comments unless the onboarding state machine becomes non-obvious.

## Subagent Verification

- A verifier should run desktop onboarding smoke with mocked import responses and inspect both zh-CN and en strings.

## Acceptance

- API: Onboarding calls an import path that preserves or creates local `deviceId` for join mode.
- DB: No server DB change.
- Log: No identity private key or Cursor token in logs.
- State / Enum: create_new_identity and join_existing_participant states are represented.
- Permission / Tenant: No.
- User-visible Output: Fresh install defaults to creating a new identity; imported existing identity path clearly says this is for a second device.
- Context / Evidence Fields: participantId equality, deviceId difference, masked identity/account labels.

## Verification

- `node --check src/desktop/renderer.js`
- Focused desktop command / renderer test or manual smoke showing create and join paths.
- i18n check for zh-CN and en.

## Evidence

- Required evidence: command output, UI screenshot or concise UI state notes, config before/after showing same `participantId` and different `deviceId`.
- Actual evidence belongs in handoff/evidence files, not by rewriting this task card.
