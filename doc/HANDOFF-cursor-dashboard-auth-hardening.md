# HANDOFF — Cursor 采集断流:根因、修复与交接状态

> 交接时点:2026-08-28。修复已提交、已推送、Mac 侧门禁全绿;**Windows 侧验证与合回 develop 尚未做**。
> 本文件为会话交接文档(untracked),合并后可删除。

## 0. 交接快照

| 项 | 状态 |
| --- | --- |
| 分支 | `fix/cursor-dashboard-auth-hardening`(基于 develop `e99e271e` 切出) |
| 提交 | `3154053d` fix(collector): surface Cursor dashboard auth failures and protect usage history |
| 规模 | 5 文件,+336/−28(纯 Rust,无 JS/前端改动) |
| 推送 | 已推送 origin,remote tip == 本地 `3154053d`(develop 本身也已同步推送) |
| Mac 门禁 | `cargo test --workspace` 全绿(交接当日复跑,exit 0:collector-core 358 单测 + 18 集成,atl-collector 12 + 9);提交时 `npm test` 亦全绿(本次未触 JS) |
| 新增测试 | 8 个(名单见 §4) |
| 待办 | Windows 验证 → 合回 develop → 随下一客户端版本发布;用户侧通报重连(见 §7) |

## 1. 发生了什么

2026-08-27 夜 ~ 8/28 上午 ~10:30(北京时间),Cursor 服务端拒绝 `type:"session"` 型 token 访问 `cursor.com` 的 dashboard 用量接口(307 重定向到 WorkOS 登录页),持续约 12 小时。全站 13 个参与者中所有用 Cursor 的人采集断流。

~10:30 后上游回滚,接口恢复(新铸的 session token 20/20 成功,两个月老的 web token 也成功)。**但事故前签发的存量 session token 仍被拒**——接口恢复 1 小时后 dev 库 cursor 仍零新增、其他来源正常,即为佐证。

结论:每位用户需要在桌面端**断开重连一次 Cursor**。窗口覆盖上个自然月,重连后 8 月数据自动回补(8/20–27 数据已在接口里确认完好)。

注意曾被排除的疑点(避免重查):

- `tokenUsage ⟺ isTokenBasedCall=true` 的判定规则**没有变**。对 1000+ 事件做过相关性核对,0 错配。某账号(jasper,user_01K7…)近期事件全无 `tokenUsage`,只因那些全是 Pro included 的非 token 计费调用,属正常。
- 另一账号(user_01K3…)99/100 事件带 `tokenUsage`,采集口径本身健康。
- cockpit-tools(jlcodes99)用同款 device flow,其 issue 区 8/27–28 无同类断流报告(那波 issue 风暴是其自家 1.3.31 更新),旁证是 Cursor 服务端短时事故而非协议变更。

## 2. 根因链(全部实验证实)

1. 上游:cursor.com 短时拒绝 session 型 token,返回 307 → WorkOS 登录;随后回滚,但存量 token 被作废。
2. 采集器:reqwest 默认跟随 307,POST 到 workos authorize 得到 404 JSON,错误串为 `"HTTP 404 Not Found"`——不含 401/403,不匹配鉴权失败判定 → 不触发 reactive refresh,账号 `authStatus` 停留 `active`,表面一切正常。
3. 可见性:诊断导出原本不含 providerErrors,用户导出的诊断 JSON 里完全看不到 cursor 报错。
4. 数据破坏:用户"断开账号 → 扫描"后,无账号=无 fetch=无 error,`replace_usage_facts` 用零行结果整库覆盖,**本地 cursor 历史被清空**。
5. 服务器侧风险:`full-reconcile` 会 prune 本地缺失的 server-only scope(超过 `RECENT_SCOPE_PROTECTION_DAYS = 2` 天的部分)。本次服务器历史幸存,仅因为事故窗口内没有人跑完一次 full-reconcile——是运气,不是防御。

## 3. 修复内容(commit `3154053d`)

四层防御,把"上游鉴权事故"从静默数据丢失变成可见、可恢复、不破坏历史:

| 文件 | 改动 |
| --- | --- |
| `collector-core/src/provider/cursor_dashboard.rs` | dashboard client 禁止重定向(`Policy::none()`);30x/401/403 统一归类为鉴权错误(`is_auth_http_error`,含 `(login redirect)` 标记)→ 触发 reactive refresh,刷新仍失败则账号翻 `reauth_required`;`fetch_usage` 拆出 URL 可注入的 `fetch_usage_at` 供测试 |
| `collector-core/src/provider/cursor_auth.rs` | `fetch_account_info` 同样禁重定向,避免账号信息探测被 307 带偏 |
| `collector-core/src/diagnostics.rs` | 诊断导出的 usageCache 摘要补 `partial` / `failedProviderIds` / `providerErrors`——下次任何人导诊断,一眼能看到 cursor 报错 |
| `collector-core/src/reconcile.rs` | `FullReconcileOptions` 新增 `protected_provider_ids`(serde 默认空);上次扫描报错的 provider,其 server-only scope 不再 prune,计入 `protectedScopeCount`(state/result/InventoryReconcileOutcome 均带该字段);纯函数 `scope_prune_allowed` 集中决策 |
| `atl-collector/src/sidecar.rs` | ① `preserve_providers_with_missing_rows`:provider 上次有行、本次零行、无报错、且仍启用(cursor 需显式 `Some(true)`,其他 `!= Some(false)`)→ 保留旧行并注入 provider error `"scan returned no rows; previous rows preserved"`——防"断开账号→扫描→整库覆盖";显式禁用的 provider 照常移除。② `failed_provider_ids_from_last_scan()`:从 usage cache 读 `failedProviderIds`,注入 full-reconcile 的 protected 集合。③ `usage_snapshot` 无条件加载 previous items(原来仅在 partial 时加载) |

新增 8 个测试:

- `auth_error_classification_includes_login_redirects`(30x 归类)
- `fetch_usage_at_surfaces_login_redirect_as_error` / `fetch_usage_at_returns_events_on_success`(TcpListener 单连接 mock,仿 cursor_auth.rs 的 `mock_dashboard_response` 助手)
- `test_export_diagnostics_includes_provider_errors`
- `scope_prune_allowed_respects_recent_days_and_failed_providers`(+ 序列化 camelCase 断言补 `protectedScopeCount`)
- `preserve_marks_enabled_provider_that_lost_all_rows` / `preserve_skips_provider_with_current_rows_or_existing_error` / `preserve_respects_disable_semantics`

## 4. 已验证 / 未验证

**已验证(Mac,develop 基线 e99e271e + 本提交):**

- `cargo test --workspace` 全绿,交接当日复跑确认(exit 0)。
- 提交时 `npm test` 全绿(纯 Rust 改动,backend/shared 未动,本次交接未重跑)。
- 307 场景的行为由 mock 单测覆盖,不依赖真实 Cursor。

**未验证(接手人补):**

- Windows 主机编译 + 测试(命令见 §5)。
- 真机手工回归(可选,建议至少走一遍):断开 Cursor → 扫描 → 本地 cursor 历史仍在 + 诊断导出含 providerErrors;重连 → 扫描 → 8 月数据回补。
- `npm run verify:ccusage` 不适用于本次(针对 Claude/Codex 采集器口径,本次未触碰)。

## 5. 接手人操作清单

**① Windows 验证**(分支已在 origin,fetch 即可;仓库在 `C:\Users\1data\source\ai-token-league`):

```bash
cd /c/Users/1data/source/ai-token-league
git fetch origin
git checkout fix/cursor-dashboard-auth-hardening
cargo test --workspace
```

只编译不跑测试用 `cargo build --release`。PowerShell 里调 Git Bash:`& "C:\Program Files\Git\bin\bash.exe" -c "cd /c/Users/1data/source/ai-token-league && git fetch origin && git checkout fix/cursor-dashboard-auth-hardening && cargo test --workspace"`。测试自带 ATL_HOME 沙箱,不会碰真实用户数据。

**② 合回 develop**(develop tip == 分支基点,可直接 fast-forward):

```bash
git checkout develop
git merge fix/cursor-dashboard-auth-hardening
```

**③ 发版**:修复需随下一客户端版本(0.7.14+)发布才对全部用户生效。走常规 release 流程(`npm run bump` → CHANGELOG → 门禁 → tag)。CHANGELOG 建议条目:`[Desktop] Cursor 采集在上游鉴权异常时不再静默清空历史,并可在诊断中看到具体报错`。

**④ 用户侧通报**(不需要等新版本,当前版本即可恢复):让用 Cursor 的同学在桌面端**断开重连一次**,8 月数据自动回补。

**⑤ 服务器数据**:无需修复——历史未被 prune(事故窗口无人跑完 full-reconcile),断流期间的零新增会随各用户重连回补。

## 6. 运维红线(修复上线前)

**未包含本修复的客户端(≤0.7.13)不要跑 full-reconcile**,尤其在其 cursor token 处于失效状态时——会把服务器侧 cursor 的 server-only scope prune 掉。修复后的版本有 `protected_provider_ids` 保护,可以跑。

## 7. 暂缓与遗留

- **P1 webview web-token 登录:暂缓**。立项前提(session token 被永久拒绝)已被上游回滚推翻。若 Cursor 将来永久只认 web 型 token 再启动:方案笔记在记忆 `cursor-dashboard-api-outage-2026-08-28`(Tauri 2.11.1 有 `Webview::cookies_for_url`,可取 HttpOnly cookie 铸 `WorkosCursorSessionToken`)。兜底:桌面端手动粘贴 token 入口已存在(`src/desktop/renderer.js` 的 `addCursorToken`)。
- 各用户被作废的存量 token 无法由产品侧远程修复,只能逐用户重连。
- 本文档(untracked)合并后删除即可。

## 8. 调试事实速查(复用时直接查这里)

- 用量接口:`POST https://cursor.com/api/dashboard/get-filtered-usage-events`,body `{ teamId: 0, startDate/endDate: 毫秒时间戳, page, pageSize: 100 }`,响应 `totalUsageEventsCount` + `usageEventsDisplay`。
- 判定规则:`tokenUsage` 字段 ⟺ `isTokenBasedCall === true`;Pro included 调用无 token 属正常。
- `GET /api/usage-summary` 只有配额百分比,无 token 明细;api2 的 GetUserMeta / stripe_profile 接受 session token。
- token 两种:浏览器登录为 `type:"web"`(带 `workosSessionId`);device flow(`cursor.com/loginDeepControl?uuid=&challenge=&mode=login`,PKCE S256 → `api2.cursor.sh/auth/poll?uuid=&verifier=`)铸 `type:"session"` JWT(60 天,无 workosSessionId)。
- cookie 构造:`WorkosCursorSessionToken=<sub>::<jwt>` URL 编码(`auth0|` 前缀或纯 `user_` 前缀均可)。
- 事故窗口:8/27 夜 ~ 8/28 ~10:30(北京);回滚后新铸 session token 可用、存量 session token 仍被拒、老 web token 可用。

## 9. 安全与卫生

- 调试期间经手了两位同学的真实 session token / cookie:仅用于对 cursor.com 的诊断请求,**未写入任何仓库文件**;`/tmp` 下的探测文件已全部删除。
- `~/Downloads/cursor.com.har` 含用户本人完整会话信息,勿外传。
- `env.test` 的 `MYSQL_PASSWORD` 永不回显。
