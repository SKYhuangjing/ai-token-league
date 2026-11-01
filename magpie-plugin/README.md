# magpie-atl-sync

把 Magpie 采集的**全部用量**（统一口径）同步到 AI Token League 榜单。

**口径**：与 Magpie「用量」页所见同源——网关账本 + 全部 agent 的本地会话扫描，request id 去重。不是"只走网关的流量"：只要 Magpie 能看见的用量（含 ZCode/Claude Code/Codex/Kimi/WorkBuddy/DSH/Hermes 等本地会话），本插件都会带上传。

- **数据源**（降级链，按序取用）:
  1. `magpie usage --csv` —— 官方 CLI 导出统一口径。**例行同步只读滚动窗口**（`--days N`，默认 7 天，历史不可变+桶指纹清单保证增量正确;~0.8 秒）。**每天第一个同步自动升为全量读取对账一次**（与 ATL 的每日全量同步同语义:重核全部指纹、漂移即上传）;`--full`、首次同步、页面摘要缓存缺失时也为全量。页面所需的全史视图由 `page-summary.json` 缓存与窗口日覆盖合并供给
  2. 网关只读 API `GET /v1/magpie/usage/requests`（JSON 分页，本机免 key）—— CLI 不可用时后备，默认只拉近 7 天窗口
  3. 网关账本文件 `~/.config/magpie/usage.jsonl` —— 末位兜底（仅网关口径）
- **归因**:按 `agent`（发起请求的客户端）映射到 ATL 既有来源——`zcode→zcode_local`、`claude→claude_code_local`、`codex→codex_local`、`opencode→opencode_local`、`kimi→kimi_local`、`workbuddy→workbuddy_local`、`dsh→dsh_local`、`hermes→hermes_local`;`magpie` → 新来源 `magpie_local`;ATL 没有对应来源的 agent 明确跳过并计数，不误归因
- **协议**:与官方 collector 完全一致的 Ed25519 签名 + 小时桶快照（`/api/usage/daily-batches`），整桶覆盖幂等，重复上报安全
- **隐私**:白名单 18 字段显式构造;账号邮箱、host、session、response_id 在解析层即被丢弃，永不上传

## 安装

**本地开发（官方就地加载标准）**:

```bash
git clone https://github.com/SKYhuangjing/ai-token-league.git
magpie plugin add ./ai-token-league/magpie-plugin
```

**从 npm 安装**（首选——Magpie 装载先问 npm）:

```bash
magpie plugin add magpie-atl-sync
```

**从 GitHub 源码安装**——独立 dist 分支（`magpie-plugin-dist`，目录内容置于仓库根）:

```bash
magpie plugin add github:SKYhuangjing/ai-token-league#magpie-plugin-dist
```

> 主仓 `develop` 分支的 `magpie-plugin/` 是开发源;`magpie-plugin-dist` 分支与 npm 包均由 `scripts/publish-magpie-plugin.sh` 生成（`PUSH=1` 推 dist 分支，`NPM=1 NPM_PUBLISH=1` 发 npm），因为 Magpie 的 git 安装按仓库根解析入口，不支持子目录。

安装后在 Magpie 侧栏打开「AI Token League」页。

> 插件卡片上的**「请求 Hook」徽章**与**「选项」按钮**是 Magpie 给所有带网关 hooks 插件的标准件:hooks 是同步触发器（onRequest 为宿主要求必须导出）;「选项」是宿主原生的 options JSON 编辑器，与插件页设置写同一份数据，正常使用不需要碰它。

## 插件页

**用量视图**

- 控制行:用量/设置 · 时间范围（今日/近 7 天/近 30 天/全部） · 同步 chip（成功=绿·相对时间;同步中=琥珀·N/M 批;失败=红·点击跳详情）
- 状态条（配置服务端后显示）:`● 昵称 · #名次 · 领先/榜首 N 天 · 云端今日 X · 与本地一致/落后 · [打开榜单]`——完整参与者 ID 在悬停里;「打开榜单」由宿主进程开浏览器（页面沙箱无弹窗能力）
- KPI×4:总量（副行给输入/输出/缓存推导）、缓存读取（提示词口径命中率，公式在悬停）、请求（失败数红显）、费用（`≈$` 牌价估算，无价显示空）
- 趋势:Token/请求/费用 × 来源/模型（今日固定按小时·按来源）;右侧图例=排名=过滤器，点行聚焦图中该序列
- 活跃热力图:53 周按日
- 四态齐备:骨架屏/空态（一句话+去设置）/同步中进度/失败保留最后数据

**设置视图**（一行身份 + 双列配置/同步）

- 身份:昵称 + 来源 chip + 截断 ID + **导入/导出**
- 配置:服务端地址、昵称（一次性改名）、起始日期、**同步频率 5/15/30/60 分钟**（即时生效）、保存/测试连接
- 同步:上次结果/数据源/统计/服务端 + 立即同步

页面零说明文:口径、公式、隐私、导入格式全部在 tooltip。

## 导入 / 导出（身份迁移）

- **导入**（ATL 设置页「导出配置」生成的 JSON）= 明确的身份切换:
  - 旧身份自动备份为 `identity.json.<旧pid>.bak`（0600），可换回
  - **服务端地址一并采用**（导出带哪个服务器就切哪个——同身份重导入换服务器即切换后端的正规路径）
  - 首次导入到全新机器时，若本机尚未配置任何服务端，也直接采用导出的地址
- **导出**:同格式写 `~/Downloads/atl-magpie-config-<时间戳>.json`（0600，含私钥，留在本机）
- 昵称改名是**一次性命令**（保存即提交、用后即焚），不存在常驻昵称配置——常驻值会与导入来的身份互相改写（已修的历史 bug）

## 触发机制

- 每个网关请求前后（onRequest/onResponse）节流 60s 拉起独立同步进程
- 常驻兜底间隔 = 插件页「同步频率」（`syncIntervalMinutes`，默认 15 分钟）
- 页面按钮（立即同步/测试连接/导出配置/打开榜单）经 options 命令握手，由宿主进程代执（页面沙箱无网络无弹窗）

CLI/诊断:

```bash
cd <插件目录>
bun sync.js --dry-run          # 只打印分桶与总量,不上传
bun sync.js --test-connection  # 探活服务端
bun sync.js --export-config    # 导出迁移配置到 Downloads
```

状态文件:`~/.config/magpie/atl-sync/`（identity.json 0600 / sync-state.<server>.json 按服务端分清单，断点续传 / sync.log）。

## 隐私红线

上传 items 为白名单构造，仅含:day/hour/toolCode/providerId/workdirHash（虚拟桶，participantId 加盐）/workdirDisplayName（"Magpie"）/model（小写）/token 四分项/reasoning/sourceQuality/exact/trace 文本（≤160 字符）。采集数据中的 `providerAccount`、`host`、`session`、`native_session`、`response_id`、`err`、`ep` 等字段物理上不会出现在上传载荷中（有测试断言）。

## 能力边界（重要）

- 覆盖 **Magpie 能看见的全部用量**（统一口径）。工具完全不接 Magpie 时该部分用量本插件看不到，应继续由 ATL 客户端对应来源采集——**一源一写入者**:某来源要么交给本插件，要么归 ATL 客户端，不要两边同时开（同 participant+device 下同源双写会互相覆盖，数字摆动但不会翻倍）
- 与 ATL 客户端在重叠时段的日常残差属正常（后台流量、跨午夜归日差异）;详见 doc/magpie-plugin.md
- workdir/项目维度退化为虚拟桶（CSV/API 通道无 cwd）
- full-reconcile 云端修剪、sync-state 差异对账为后续版本项

## 完整性保险丝

同步前对数据做形状与完整性校验:route_id 形态、response_id 唯一性、坏行占比（>5% 判格式漂移）。任何异常**响亮拒传**（退出码 3），绝不静默错报。

## 测试

```bash
cd <插件目录> && bun test    # 签名金样/指纹、聚合、PII 断言、完整性校验、
                              # 真实宿主 plugins.json 形状、身份迁移、导入携带服务端
```
