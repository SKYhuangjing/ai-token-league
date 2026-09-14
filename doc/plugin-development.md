# ATL 插件接入文档（面向所有开发者）

> 版本：v1（2026-09-14，对应 feat/compute-sharing 工作区现状）
> 适用：想为 AI Token League 桌面端开发插件的任何开发者。

## 0. 三层插件体系总览

| 层 | 形态 | 跑在哪 | 面向谁 | 例子 |
|---|---|---|---|---|
| ① 桌面远端插件 | JS（`mount(el, ctx)`） | 桌面 App webview | **用户可装卸**（本文重点） | compute-sharing（算力共享：借用+分享者控制台合并卡）、zhipu-plan（智谱用量） |
| ② Sidecar 插件 | Rust（`SidecarPlugin` trait） | collector sidecar 进程 | 一方能力开发者（需要本地 IO/托盘） | zhipu 配额查询+托盘 |
| ③ CPA 插件 | Rust cdylib（C ABI） | 用户的 CLIProxyAPI 进程 | 共享执行引擎 | atl-share |

**关系**：①是产品形态（用户视角的"插件"）；②是①背后需要 Rust 能力时的供给位（①经 `ctx.invoke` 调到②暴露的命令）；③是完全另一个宿主（CPA）里的原生插件，与桌面插件体系互不相干。

---

## 1. 桌面远端插件标准（①，主标准）

### 1.1 一个插件 = 两个文件

```text
plugins/<your-plugin>/
├── manifest.json    # 元数据 + 能力声明
└── index.js         # 唯一入口：export default { async mount(el, ctx) }
```

**manifest.json 全字段**：

```jsonc
{
  "id": "share-borrow",              // 必填。插件 id，同时是命令命名空间和 modules.json 的 key。[a-z0-9-]
  "version": "0.2.1",                // 必填。语义化版本，目录按版本区分文件
  "type": "query",                   // 必填。"query"（按需/周期查询）| "serving"（长期本地服务）
  "title": "算力借用",                // 必填。目录展示标题（目录元数据，预翻译）
  "desc": "……",                      // 必填。目录展示描述
  "titleKey": "desktop.sharing.borrow.title",  // 可选。i18n 键——配置后已装卡片离线也显示本地化标题（优先于 title）
  "descKey": "desktop.sharing.borrow.desc",    // 可选。同上
  "entry": "index.js",               // 必填。入口文件名
  "permissions": [                   // 能力声明——【已强制执行】挂载后 invoke 越权调用直接 reject（见 §4）
    "sidecar:sharing:claim-sign",
    "sidecar:modules:get"
  ]
}
```

**index.js 契约**：

```js
// 完全自包含的 ES module。不得 import 宿主内部模块（如 ../../src/...）。
export default {
  async mount(el, ctx) {
    // el：宿主给的挂载容器（卡片详情区，已含版本行+卸载按钮，不要自己画）
    // ctx：平台能力，见 §1.2
    el.innerHTML = `<div class="muted">${ctx.escapeHtml(ctx.t("your.key"))}</div>`;
  },
};
```

可以额外具名导出纯函数供单元测试（参考 plugins/zhipu-plan/index.js 的 `renderResult/windowLabel`）。

### 1.2 ctx 能力清单（平台给你的全部，共 5 项）

| 能力 | 签名 | 用途 |
|---|---|---|
| `ctx.t(key, params?)` | `(string, object?) => string` | 平台双语 i18n（zh-CN/en 自动跟随用户语言）。键定义在 `src/shared/i18n.js` |
| `ctx.invoke(command, args?)` | `(string, object?) => Promise<any>` | **sidecar 通道**。命令格式 `{插件id}:{子命令}`（自己插件的命令）或平台命令。见 §1.3 |
| `ctx.escapeHtml(text)` | `(string) => string` | HTML 转义（& < > " '，属性安全）。**所有动态文本入模板前必须过它** |
| `ctx.apiBase()` | `() => string` | 后端 API 根地址（活取，随用户配置变化，已去尾斜杠）。`fetch(\`${ctx.apiBase()}/api/...\`)` 走云端 HTTP |
| `ctx.notify(text, opts?)` | `(string, { duration }?) => void` | App 全局 toast（与总览扫描提示同一表现层；纯文本、自动消失）。操作回执用它，错误建议留在卡片内常驻。旧宿主可能不提供——`ctx.notify ? ctx.notify(x) : 卡内状态行(x)` 兜底。无需权限声明 |

### 1.3 当前可用的 sidecar 命令

**平台命令（任何插件可调，收敛到调用者自身记录）**：

| 命令 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `modules:get` | `{}` | `{ version, modules: { <id>: { enabled, config, installedVersion } } }` | 只返回**你自己的**安装态记录（宿主过滤，看不到其他插件的 config） |
| `modules:set` | `{ id, enabled?, config?, installedVersion? }` | 更新后的完整 state | 只写**你自己的**条目（`id` 由宿主强制为本插件 id；config 任意 JSON，浅合并语义） |

**共享 owner 命令（`sharing:owner-*`，为分享者控制台提供；sidecar 读 CPA 插件的 identity.json 代发，share secret 不进 webview）**：

| 命令 | 入参 | 返回 |
|---|---|---|
| `sharing:owner-status` | `{}` | `{ share, claims }` —— 本机分享节点账本/认领明细；未注册 reject `not_registered` |
| `sharing:owner-policy` | `{ policy }` | 更新后的 policy（留空字段不变更，下次插件心跳生效） |
| `sharing:owner-unregister` | `{}` | 停止分享 + 级联撤销全部认领 Key（恢复走云端 admin resume） |

**共享借用命令（`sharing:*`，为算力借用提供）**：

| 命令 | 入参 | 返回 |
|---|---|---|
| `sharing:claim-sign` | `{ shareId, ts? }` | `{ participantId, ts, signature }` —— 用本机联赛身份私钥对 `{kind:"share-claim", participantId, shareId, ts}` 签名（私钥永不出 sidecar） |
| `sharing:borrow-get` | `{}` | `{ claims: [...] }` —— 本机持久化的认领记录（app 数据目录 sharing-borrow.json） |
| `sharing:borrow-set` | `{ claims: [...] }` | 清洗后的存储结果（白名单字段、≤50 条、字段限长） |

**其他插件暴露的命令（经其 manifest.permissions 声明）**：`zhipu-plan:usage`（智谱配额查询，带 60s 缓存）。

> 新增自己的 sidecar 命令：在 `collector-core`/`atl-collector` 实现并注册（②层），或提需求给平台。

### 1.4 生命周期（务必理解）

```text
安装（在线目录点「安装」）
  └─ 从分发代理下载该版本 index.js，写入本机 plugin-packages/<id>/<version>/
     再把 {id, version} 记到 modules.json —— 【不执行任何插件代码】
挂载（已装+启用+卡片可见时）
  └─ 优先读本机已下载的那一版 → blob URL import → mount(el, ctx)
     没有本地副本时才向云端拉一次并保存（旧安装升级后的第一次打开）
     同一版本视为不可变；写入新版本时删掉该插件的其他版本目录
卸载
  └─ 先摘安装记录，再删本机副本。删包失败仍算卸载成功，状态栏会提示副本没删掉。
     config 默认保留（重装可恢复）
```

插件脚本下载后不依赖云端就能挂载。插件自己再去请求云端（智谱用量、算力目录）时，那些请求仍需要网络；挂载本身不再每次都拉 `index.js`。

### 1.5 分发流程

```bash
# 本地目录结构就绪后，发布到 OSS 模块目录（需 env.local 的 RELEASE_OSS_* 凭证）
node scripts/publish-module.js --module-dir plugins/<your-plugin> --env env.local

# 客户端从云端后端代理拉目录/文件（不直连 OSS）：
#   GET {apiBase}/api/modules/remote/catalog
#   GET {apiBase}/api/modules/remote/file/<id>/<version>/index.js
# 客户端把下载到的 index.js 存在 app 数据目录 plugin-packages/<id>/<version>/
```

发布进 OSS 目录不等于对客户端可见。默认上架；后台「插件」页可下架某个 id。下架只影响公开目录（不能新安装），已安装客户端仍可拉取该版本文件。上下架状态跟 `DB_TYPE`：`mysql` 写入 `module_listings`，`json` 写入 JSON store 的 `moduleListings`。不改写 OSS catalog。

### 1.6 渲染与样式约定

- 宿主已渲染：卡头（图标/标题/启停开关）、版本行 + 卸载按钮。你只填 `el` 内部。
- 可复用 App 皮肤类：`.module-inline-actions`、`.module-meter`、`.outline-button`、`.primary-pill`、`.source-switch`、`.muted`、`.mono`、`.modules-section-title` 等（皮肤是外观不是逻辑，允许复用）。
- 也可以完全自带样式：注入 `<style id="your-plugin-style">`（参考 share-borrow 的 `sb-*` 前缀，避免碰撞）。
- 元素 id 建议 `data-<your-plugin>="..."` 属性选择器风格，避免全局 id 冲突。

### 1.7 i18n 约定

文案键放平台表 `src/shared/i18n.js`（zh-CN + en 双语都必须有），命名空间建议 `desktop.plugins.<your-id>.*`（现状两插件暂用 `desktop.modules.zhipu.*` / `desktop.sharing.borrow.*` 历史命名）。manifest 的 `titleKey/descKey` 让已装卡片离线也有本地化标题。

---

## 2. Sidecar 插件（②，需要 Rust 能力时）

当插件需要**本地文件、托盘、网络 IO、定时任务**等 webview 做不了的事，能力实现在 sidecar：

- trait：`collector-core/src/plugin.rs` 的 `SidecarPlugin { id, handle(cmd, PluginCtx), tray... }`
- 注册：`atl-collector/src/plugins.rs` 组合根加一行
- 约束：插件不碰文件系统——宿主把 modules.json 状态以 `PluginCtx::modules_state` 递进来；命令路由按 `{id}:{sub}` 命名空间
- 之后前端远端插件经 `ctx.invoke("your-id:sub")` 调用

现有居民：`plugin_zhipu`（配额查询 + 托盘段落 + 阈值通知）。

## 3. CPA 插件（③，共享执行引擎专用）

跑在 CLIProxyAPI 内的原生插件（与 ATL 桌面插件体系无关，仅云端协议相通）：

- C ABI 四符号（`cliproxy_plugin_init` + call/free_buffer/shutdown），JSON 方法协议（`plugin.register`/`frontend_auth.authenticate`/`request.intercept_before|after`/`request.complete`/`usage.handle`）
- 配置经 CPA 自身 `plugins.configs.<id>` 嵌套 YAML 下发（宿主 `yaml.Marshal` 成规范化 YAML 字节，JSON RPC 里以 base64 `config_yaml` 传递；改配置走 `plugin.reconfigure` 热重载）。不要把该子树写成一行 JSON 对象。
- 我们的实现：`cpa-plugin/`（atl-share，算力共享执行引擎），安装 `scripts/install-cpa-plugin.sh`
- **注册实名制（A.1）**：插件用本机 ATL 联赛身份对 register 签名（Ed25519，与认领同链）；身份目录可用 CPA 配置 `identityDir` 手动指定（默认 `~/.ai-token-league`，`ATL_HOME` 感知）——多实例/自定目录场景
- 详见 `doc/compute-sharing-handoff.md` R23 节

---

## 4. 能力边界与信任模型（v1 现状，诚实清单）

### 插件可以
- 在自己的卡片容器内任意渲染 DOM、注入样式
- 读写**自己的** config（modules:get/set）
- 调用已注册的 sidecar 命令（上表）
- `fetch` 云端后端 API（ctx.apiBase）
- 弹 App 全局 toast（ctx.notify，纯文本回执；无需权限声明）
- 使用剪贴板（navigator.clipboard）、IntersectionObserver、setInterval 等标准 web API

### 插件不可以 / 平台不提供
- 文件系统、进程、任意原生能力（webview 沙箱）
- 直接 import 宿主内部模块（无路径约定， blob 隔离）
- 读其他插件的敏感 config（`modules:get`/`modules:set` 已收敛到调用者自身记录，跨插件读写不可达）
- 读写本机已下载的插件包（`modules:package-get/put/delete` 仅宿主可用，manifest 声明也不放行）
- Tauri 原生 invoke（插件只拿 sidecarInvoke 通道）

### 已知信任缺口（v1 明示，加固待排期）
1. **目录无签名**：入口源经后端代理拉取，未做签名校验（声明与代码的一致性依赖目录可信）——二期加固项
2. ~~permissions 未强制~~ **已强制（R28d）**：`ctx.invoke` 经 `createGuardedInvoke` 守门——平台命令（modules:get/set，自身安装态）永远放行；其余命令必须被 manifest permissions 精确或通配声明，越权调用 reject `permission_denied:<cmd>`；目录不可达时回退 App 内置 FIRST_PARTY 声明（zhipu），再退化为仅平台命令
3. **安装不执行代码**已做到（R28c），挂载时执行是唯一代码入口

### 给插件作者的纪律
- 所有动态文本 `ctx.escapeHtml` 后入模板（防 XSS）
- 密钥类数据只存自己 config（modules.json 在用户本机）；绝不要把密钥打到远端
- 网络调用设超时（AbortSignal.timeout）+ 失败降级文案
- 自己的定时器/观察器注意重复挂载幂等（每次进入插件屏都会重新 mount）
