# HANDOFF — Cursor 采集断流:根因、修复与交接状态

> 交接时点:2026-08-28(Mac 真机验证后更新)。修复已提交、已推送;Windows + Mac 真机均验证通过。
> 本文件为会话交接文档,合并后可删除。

## 0. 交接快照

| 项 | 状态 |
| --- | --- |
| 分支 | `fix/cursor-dashboard-auth-hardening`(基于 develop `e99e271e` 切出,tip `fb9a7d99` 已推送) |
| 已提交 | `3154053d` P0 四项防御 → `fb826dda` cookie 规范 id / latestUsageDay / email 修复 → `3ded3213` 本文档 → `fb9a7d99` reqwest `rustls-tls` → `native-tls` + `setup-build-env-linux.sh` 补 `libssl-dev` |
| Windows 真机验证 | ✅ 2026-08-28:rustls 403 复现 + native-tls(schannel)后 413 events / 409 items 拉通(见 §10) |
| Mac 门禁(native-tls 后) | ✅ `cargo test --workspace` exit 0(363+18+12+9+3)、`npm test` 全过、`node --check` ok、`test:ui` 544 过、`test:e2e` 94 过 |
| Mac 真机验证 | ✅ 2026-08-28:SecureTransport 通过 Vercel 检查点,装包回归全绿(见 §11) |
| 待办 | Linux 真机各验一次(OpenSSL 指纹) → 合回 develop → 随 0.7.14+ 发布;用户侧通报"升级客户端"(见 §7) |

## 1. 发生了什么

2026-08-27 夜 ~ 8/28 上午 ~10:30(北京时间),Cursor 服务端拒绝 `type:"session"` 型 token 访问 `cursor.com` 的 dashboard 用量接口(307 重定向到 WorkOS 登录页),持续约 12 小时。全站 13 个参与者中所有用 Cursor 的人采集断流。

~10:30 后上游回滚。**Windows 真机验证(§10)表明还存在第二层持续性问题:cursor.com 的 Vercel Security Checkpoint 按 TLS 指纹拦截 rustls 客户端(采集器所用),对 schannel/OpenSSL 客户端放行。** 因此"重连即恢复"对 Rust 采集器不成立——重连铸出的新 token 本身有效,但采集器仍被 403,并再次翻成 `reauth_required`,静默零行。

~~结论:每位用户需要在桌面端断开重连一次 Cursor。~~ **修正(2026-08-28):用户必须升级到含 native-tls 修复的客户端(0.7.14+);仅重连无效。** 已被翻成 `reauth_required` 的账号在升级后于应用内断开重连一次即可恢复(此时 fetch 能通过,状态会保持 active)。

注意曾被排除的疑点(避免重查):

- `tokenUsage ⟺ isTokenBasedCall=true` 的判定规则**没有变**。对 1000+ 事件做过相关性核对,0 错配。某账号(jasper,user_01K7…)近期事件全无 `tokenUsage`,只因那些全是 Pro included 的非 token 计费调用,属正常。
- 另一账号(user_01K3…)99/100 事件带 `tokenUsage`,采集口径本身健康。
- cockpit-tools(jlcodes99)用同款 device flow,其 issue 区 8/27–28 无同类断流报告(那波 issue 风暴是其自家 1.3.31 更新),旁证是 Cursor 服务端短时事故而非协议变更。
- §10 补充:事故期间的"接口恢复"探测用的是 curl/浏览器(schannel/OpenSSL 指纹),它们不在被拦之列——这解释了为何探测全绿而采集器(rustls)持续零行。

## 2. 根因链(全部实验证实)

1. 上游:cursor.com 短时拒绝 session 型 token,返回 307 → WorkOS 登录;随后回滚,但存量 token 被作废。
2. **上游(持续):Vercel Security Checkpoint 按 TLS 指纹拦 rustls → 403 + HTML 挑战页(§10)。**
3. 采集器:reqwest 默认跟随 307,POST 到 workos authorize 得到 404 JSON,错误串为 `"HTTP 404 Not Found"`——不含 401/403,不匹配鉴权失败判定 → 不触发 reactive refresh,账号 `authStatus` 停留 `active`,表面一切正常。
4. 可见性:诊断导出原本不含 providerErrors,用户导出的诊断 JSON 里完全看不到 cursor 报错。
5. 数据破坏:用户"断开账号 → 扫描"后,无账号=无 fetch=无 error,`replace_usage_facts` 用零行结果整库覆盖,**本地 cursor 历史被清空**。
6. **状态卡死(§10):403 → reactive refresh 成功(token 轮换)→ 重试仍 403 → 账号翻 `reauth_required` → `discover_sources` 跳过非 active 账号 → 此后 0 请求、0 报错、0 行,UI 永远"需要重连",重连也无法自愈。**
7. 服务器侧风险:`full-reconcile` 会 prune 本地缺失的 server-only scope(超过 `RECENT_SCOPE_PROTECTION_DAYS = 2` 天的部分)。本次服务器历史幸存,仅因为事故窗口内没有人跑完一次 full-reconcile——是运气,不是防御。

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

**④ 用户侧通报**(**必须等新版本,当前版本重连无效**):让用 Cursor 的同学升级到含 native-tls 修复的客户端(0.7.14+),然后在桌面端断开重连一次(或等待扫描自动恢复),8 月数据自动回补。原因见 §10:旧客户端的 rustls 指纹被 Vercel 检查点持续拦截。

**⑤ 服务器数据**:无需修复——历史未被 prune(事故窗口无人跑完 full-reconcile),断流期间的零新增会随各用户升级客户端后回补。

## 6. 运维红线(修复上线前)

**未包含本修复的客户端(≤0.7.13)不要跑 full-reconcile**,尤其在其 cursor token 处于失效状态时——会把服务器侧 cursor 的 server-only scope prune 掉。修复后的版本有 `protected_provider_ids` 保护,可以跑。

## 7. 暂缓与遗留

- **P1 webview web-token 登录:暂缓,但升级为指纹风险预案**。§10 证实 Vercel 检查点按 TLS 指纹拦截,若将来 schannel/OpenSSL 也被纳入拦截,该方案(浏览器内登录、取 HttpOnly cookie 铸 `WorkosCursorSessionToken`)就是唯一出路:方案笔记在记忆 `cursor-dashboard-api-outage-2026-08-28`(Tauri 2.11.1 有 `Webview::cookies_for_url`)。兜底:桌面端手动粘贴 token 入口已存在(`src/desktop/renderer.js` 的 `addCursorToken`)。
- 各用户被作废的存量 token 无法由产品侧远程修复,只能逐用户在**升级后的客户端**里重连。
- 本文档(untracked)合并后删除即可。

## 8. 调试事实速查(复用时直接查这里)

- 用量接口:`POST https://cursor.com/api/dashboard/get-filtered-usage-events`,body `{ teamId: 0, startDate/endDate: 毫秒时间戳, page, pageSize: 100 }`,响应 `totalUsageEventsCount` + `usageEventsDisplay`。
- 判定规则:`tokenUsage` 字段 ⟺ `isTokenBasedCall === true`;Pro included 调用无 token 属正常。
- `GET /api/usage-summary` 只有配额百分比,无 token 明细;api2 的 GetUserMeta / stripe_profile 接受 session token。
- token 两种:浏览器登录为 `type:"web"`(带 `workosSessionId`);device flow(`cursor.com/loginDeepControl?uuid=&challenge=&mode=login`,PKCE S256 → `api2.cursor.sh/auth/poll?uuid=&verifier=`)铸 `type:"session"` JWT(60 天,无 workosSessionId)。
- cookie 构造:`WorkosCursorSessionToken=<sub>::<jwt>` URL 编码(`auth0|` 前缀或纯 `user_` 前缀均可)。
- 事故窗口:8/27 夜 ~ 8/28 ~10:30(北京);回滚后新铸 session token 可用、存量 session token 仍被拒、老 web token 可用。
- **指纹矩阵(2026-08-28,Windows 真机,同一 token/头/体)**:Node undici(OpenSSL)200、系统 curl(Schannel,h2)200、Git curl(Schannel)200、reqwest+rustls **403**(Vercel Security Checkpoint HTML)、reqwest+native-tls(Schannel)200 + 413 events / 409 items。

## 9. 安全与卫生

- 调试期间经手了两位同学的真实 session token / cookie:仅用于对 cursor.com 的诊断请求,**未写入任何仓库文件**;`/tmp` 下的探测文件已全部删除。
- Windows 真机调试(§10)同样只在本机内存中读取本人 token,未落盘、未回显全文。
- `~/Downloads/cursor.com.har` 含用户本人完整会话信息,勿外传。
- `env.test` 的 `MYSQL_PASSWORD` 永不回显。

## 10. Windows 真机验证记录(2026-08-28)

现象:用户(Windows,新装含 `3154053d` 的 0.7.13 自建包)重连 Cursor 后仍"需要重连"、本机无 cursor 数据。

逐层定位(全部本机实验):

1. 配置 `~/.ai-token-league/config.json`:账号 token 在、`authStatus` 曾为 `active`,但用量缓存 `providerErrors` 记录 `authorized: HTTP 403 Forbidden`,`failedProviderIds: [cursor_dashboard_usage]`,cursor 零行。
2. 用存储 token 以 Node undici 复刻采集器请求(同 URL/header/UA/cookie):**200,416 events** → token 有效,问题在客户端。
3. CLI `scan`(只读,不打印 provider 错误)cursor 零行;随后一次 `sync` 前的扫描触发 reactive refresh:403 → refresh 成功(token 轮换,`accessTokenExpiresAt` 变化)→ 重试仍 403 → `update_status_after_usage_retry` 翻 `reauth_required`。
4. `reauth_required` 后 `discover_sources` 跳过该账号 → **0 请求 0 报错 0 行**,静默空转;这就是"重连无效"的机制。
5. Rust 原地直连(临时 example,绕过状态过滤):**403**,`server: Vercel`,响应体为 Vercel Security Checkpoint HTML 挑战页 → 上游按 TLS 指纹拦截。
6. 指纹矩阵(§8):仅 rustls 被拦。
7. 根 `Cargo.toml` reqwest `rustls-tls` → `native-tls` 后重跑:同 token **200,413 events / 409 parsed items**。
8. 本机恢复:配置中 `authStatus` 手动改回 `active`(token 未失效,免重连);重打安装包。

修复(已随 `fb9a7d99` 提交):

- 根 `Cargo.toml`:`reqwest` features `["json","rustls-tls"]` → `["json","native-tls"]`(Windows=schannel,macOS=SecureTransport,Linux=OpenSSL)。
- `scripts/setup-build-env-linux.sh`:apt 列表与 verify 增加 `libssl-dev`(native-tls 构建依赖)。
- 已删除临时诊断 example(`collector-core/examples/cursor_debug.rs`)。

遗留风险与待办:

- **Vercel 检查点是旁路防御**:若 Cursor 将来把 schannel/OpenSSL 指纹也纳入拦截,采集器会再次全军覆没;届时只能走浏览器 cookie 铸 token(§7 暂缓方案)或正式 HTTP 客户端伪装。
- ~~Mac(SecureTransport)真机验证~~ ✅ 已通过(§11);Linux(OpenSSL)真机仍需验证一次。
- 旧版客户端(≤0.7.13)用户即使重连也会复现卡死循环;发版通报要讲清楚"必须升级"。

## 11. Mac 真机验证记录(2026-08-28)

环境:macOS arm64,分支 tip `fb9a7d99`,`scripts/release.sh --platform current --env env.local --yes` 构建,产物 `dist/AI Token League-darwin-arm64.dmg` / `.app`(arm64;主程序与 `atl-collector` 均已链接 Security.framework = native-tls/SecureTransport 生效)。

装前基线(旧 0.7.13 自建包,已含 `3154053d`):

1. 本机 cursor 账号 jasper.cui@oneaix.com,`authStatus: active` 但 `ignored: true`(事故期间断开连接所致)→ discover 跳过、零 fetch。
2. usage cache:`partial: true`、`failedProviderIds: [cursor_dashboard_usage]`、`providerErrors: {"cursor_dashboard_usage": "scan returned no rows; previous rows preserved"}`、cursor 48 行 —— **P0-4 防御已在真实事故中生效,48 行历史被保住**。

操作与结果:

1. 门禁(native-tls 后):`cargo test --workspace` exit 0(collector-core 363 单测 + 18 集成,atl-collector 12 + 9 + 3);`npm test` 全过;`node --check src/desktop/renderer.js` ok;`npm run test:ui` 544 过;`npm run test:e2e` 94 过(含 `fb826dda` 新增 cursor/latestUsageDay 用例)。
2. 安装:退出旧实例 → 备份 `~/.ai-token-league/config.json.bak-20260828-pre-native-tls` → 账号 `ignored` 改回 `false`(token 未失效,免重连)→ 替换 `/Applications/AI Token League.app`。
   - ⚠️ 打包注意:`release.sh` 收集产物后的 `.app` 内**无 `_CodeSignature`**(`codesign -v` 报 "code has no resources but signature indicates they must be present"),本机安装前用 `codesign --force --deep -s -` ad-hoc 重签修复。正式发版走 `patch-dmg-layout.sh` / publish 流程时需确认签名完整。
3. 启动安装版,开机自动扫描(15:32)后 usage cache:

   ```text
   partial: false | failedProviderIds: [] | providerErrors: {}
   items: 2694(装前 2693)| cursor items: 48(稳定,无丢失)
   cursor health: detected/enabled/ok = true
                 latestUsageDay: "2026-08-27"
                 sources[0]: label=jasper.cui@oneaix.com, authStatus=active, ignored=false
   ```

4. **结论:macOS SecureTransport(native-tls)通过 cursor.com Vercel 检查点 ✅**。`latestUsageDay` 从原始事件流推导(含 Pro included 零 token 事件),只有 fetch 拿到 200 才会有值——它就是"指纹放行"的直接证据。扫描非 partial、零 provider 错误,说明本次扫描产出了当前 cursor 行(重算出等量 48 个小时桶),故 preserve 错误按设计未再出现。
5. UI 目检:回归模型无图片输入,Tauri WKWebView 不暴露 AX;渲染层(fb826dda 的 latestUsageDay → 来源卡"最后使用")由 e2e 新用例覆盖,真机截图存档 `/tmp/atl-installed-01-initial.png`,来源页建议人工目检一次。
6. 稳定性:App + sidecar 进程持续存活,无上传队列积压文件。

与 Windows 记录(§10)合并后的指纹矩阵:**rustls 全平台被拦;schannel(Windows ✅)、SecureTransport(macOS ✅)放行;OpenSSL(Linux + 各机 Node/curl 探测)放行**。
