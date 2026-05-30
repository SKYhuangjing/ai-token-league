# AI Token League 分享数据图设计方案

## 1. 目标和边界
- 功能目标：在本地客户端生成一张可复制、可保存、可分享的个人数据战报图，以 Polaroid 相片风格呈现，增强参与感和分享表达。
- 核心价值：用户不仅能展示"用了多少 Token"，还可以展示来源分布、模型偏好、工作目录活跃度、趋势走势和云端排名。
- 适用位置：桌面客户端 `Overview` 页面的 `Share` 按钮。
- 不做事项：
  - 不截图完整分析页面。
  - 不在本地模式伪造云端排名。
  - 不默认展示工作目录，避免泄露项目名。
  - 不展示 prompt、response、源码、绝对路径、Cursor token、identity private key。
  - 不支持用户手动选择多种图表样式——当前实现为单一 Overview 综合布局。

## 2. 用户流程
- 用户在 Overview 页点击 `Share` 按钮。
- 触发 Polaroid 动画序列：闪光 → 弹出相片 → 显影 → 显示操作栏。
- 分享图以 Overview 综合布局渲染，包含身份、指标、趋势、来源、模型、工作目录和底部语录。
- 用户点击操作栏按钮：
  - `复制图片`（Copy）：优先使用 Tauri 原生剪贴板，降级到浏览器 ClipboardItem，最终降级为保存文件。
  - `保存 PNG`（Download）：通过 Tauri 原生对话框保存，浏览器环境降级为 `<a>` 下载。
  - `关闭`（X）：关闭弹窗，触发收回动画。
- 保存文件名格式：`ai-token-league-share-<period>-<businessDay>.png`。
- 分享图跟随 Overview 当前选中的周期（today / 7d / 30d / all）。

## 3. 数据模式
- `local`：未配置云端，或云端不可达，或用户未同步。
  - 显示本地昵称、本地统计、总 Tokens、Token 构成、来源、模型、工作目录、趋势图。
  - 排名区显示 `Local stats` 标签，不显示排名、登顶次数、今日匿名名。
- `cloud_public`：服务端排行榜为公开昵称。
  - 显示昵称、排名徽章（金/银/铜/普通）、登顶天数、参与人数。
- `cloud_anonymous`：服务端排行榜为匿名身份。
  - 显示排名徽章 + 今日代号（`Today's Code · XXXX`）。
  - 不显示真实 participantId，使用 `publicId / displayName` 作为前端唯一身份字段。
- `cloud_pending`：云端配置了但请求失败。
  - 使用本地数据生成图，不显示排名区。
  - 状态栏提示 `云端状态不可用`。

## 4. 周期定义
- `today`：当前业务日，单日。
- `7d`（this_week）：当前业务周一到当前业务日。
- `30d`（this_month）：当月 1 日到当前业务日。
- `all`：截止到当前业务日。`sharePeriodBounds` 对 `all` 走默认分支返回 `{ from: day, to: day }`，卡片标题显示 "Through {date}"。本地使用全部历史数据；云端 enrichment 跳过（云端 API 无 all-time 周期），卡片显示 Local 模式。
- 本地和云端使用同一套周期口径。
- 本周的周一计算使用 UTC `getUTCDay()`：周日回退 6 天，其余回退 `1 - dow` 天。
- 今日趋势粒度为 `hour`，本周/本月/全部粒度为 `day`。

## 5. 分享图画布
- 卡片规格：`1200 × 720` px，横版。
- 导出规格：`1236 × 782` px（含 Polaroid 白边框：左右各 18px，顶部 18px，底部 44px）。
- 导出倍率：html2canvas `scale: 2`，实际输出 PNG 分辨率为 2472 × 1564。
- 背景：
  - 网格纹理：24px 间距的半透明网格线。
  - 径向渐变光晕：左上暖黄 `rgba(244, 176, 0, 0.18)`，右上青绿 `rgba(5, 143, 126, 0.15)`。
  - 底色：`#f5efe3`。
- 主卡片（stat-card、visual-card）：
  - 圆角 12px，1px `#11120f` 边框，半透明米白背景 `rgba(255, 249, 237, 0.78)`。
- Hero Score 卡片：
  - 深色渐变背景 `#171815 → #2a2b25`，右下角青绿光晕。
  - 金色成本数字 `#f4b000`。
- 字体：标题和正文使用 `ui-serif, Georgia, "Times New Roman", serif`；数字和标签使用 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`。
- 色彩：
  - 正文：`#10110f`
  - 品牌红：`#b43b32`
  - 青绿：`#058f7e`
  - 金黄：`#f4b000`
  - 紫色：`#9d78dc`
  - 辅助灰：`#6f695e`
  - 排名徽章：金 `#daa520`、银 `#a0a8b0`、铜 `#b46a2f`、普通 `#3d8a7a`、Local `#3a3b34`

## 6. 布局结构
```text
┌─────────────────────────────────────────────────────────────────┐
│ Header                                                          │
│   左：品牌名（大写 monospace）+ 用户名 + 匿名代号               │
│   右：日期范围 pill + 排名徽章 / Local stats                    │
├─────────────────────────────────────────────────────────────────┤
│ Dashboard Row                                                   │
│   ┌──────────────┐  ┌──────────────────────────────────────┐   │
│   │ Hero Score    │  │ Stat Cards (3列)                     │   │
│   │ Total Tokens  │  │ Input · Output · Cache               │   │
│   │ 预估成本      │  │ 各含 token 数、百分比、成本           │   │
│   └──────────────┘  └──────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│ Meter Columns (3列)                                             │
│   Source mix        │ Model mix        │ Top Workdirs           │
│   水平进度条 ×4      │ 水平进度条 ×4     │ 水平进度条 ×4          │
├─────────────────────────────────────────────────────────────────┤
│ Spark Bars                                                      │
│   趋势柱状图（今日24柱 / 本周7柱 / 本月多柱）                    │
│   最高柱高亮为金黄色                                             │
│   每柱显示 token 数和成本                                        │
├─────────────────────────────────────────────────────────────────┤
│ Footer                                                          │
│   语录（排名语录或通用语录）│ 品牌Logo │ 品牌URL                 │
└─────────────────────────────────────────────────────────────────┘
```

## 7. 图表组件
- `renderShareHeader`：品牌名、用户名、日期范围、排名徽章、匿名代号徽章。
  - 排名 1-3 分别使用金/银/铜配色 + 奖杯/奖牌 SVG 图标。
  - 排名 >3 使用青绿色普通徽章。
  - Local 模式使用深灰色 `Local stats` 标签。
- `renderShareHeroScore`：深色大卡片，显示总 Token 数（48px monospace）和预估成本。
- `renderShareStatCards`：3 列网格，分别显示 Input（青绿 `#058f7e`）、Output（金黄 `#f4b000`）、Cache（紫色 `#9d78dc`）的 token 数、占比百分比和成本。
- `renderShareSparkBars`：CSS Grid 柱状趋势图。
  - 每根柱子高度 = `(value / max) * 100%`，最低 6%。
  - 最高柱标记为 `hot`，使用金黄渐变，其余为青绿渐变。
  - 柱顶悬浮显示 token 数和成本。
  - 底部轴标签：今日显示 `H:00`，其余显示 `MM-DD`。
- `renderShareMiniMeters`：水平进度条，用于展示来源、模型、工作目录的 Top 排名。
  - 超过 4 项时合并为 `Other`（`collapseTop(data, 4, ...)`，保留前 3 + Other）。
  - 进度条使用 `<i style="width:{pct}%">` 实现，支持颜色类 `sc-color-teal`、`sc-color-yellow`、`sc-color-violet`，默认色为青绿 `#058f7e`。
  - 名称截断长度为 20 字符（`truncateText(item.name, 20)`）。
- `renderShareFooter`：排名语录（按排名等级选择）或通用语录、品牌 Logo（居中半透明）、品牌 URL。

## 8. 排名语录系统
- 12 条通用语录（`desktop.share.quote.0..11`），随机选择。
- 排名等级语录（`desktop.share.rankQuote.{tier}.{index}`）：
  - 等级：`1`、`2`、`3`、`top10`、`top30`、`top50`，每级 3 条。
  - 优先使用排名语录，无匹配时降级到通用语录。
- 语录在数据初始化时通过 `randomShareQuoteIndex()` 随机确定，导出时保持一致。

## 9. 数据结构
```ts
type ShareCardData = {
  range: string;                    // "today" | "7d" | "30d" | "all"
  from: string;                     // "YYYY-MM-DD"
  to: string;                       // "YYYY-MM-DD"
  businessDay: string;              // "YYYY-MM-DD"
  identity: {
    displayName: string;
    nickname: string;
    displayId?: string;
    anonymousName?: string;         // 仅 cloud_anonymous
  };
  mode: "local" | "cloud_public" | "cloud_anonymous" | "cloud_pending";
  rankStats: {
    rank: number;
    participantCount: number;
    leaderDays: number;
  } | null;
  totals: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
      reasoningTokens: number;           // 已采集但未在卡片中展示
    estimatedCostUsd: number | null;
    inputCostUsd: number | null;
    outputCostUsd: number | null;
    cacheReadCostUsd: number | null;
    cacheWriteCostUsd: number | null;
    missingPriceTokens: number;
    costQuality: string;
  };
  providers: Array<{ name: string; tokens: number; ratio: number; estimatedCostUsd?: number; missingPriceTokens?: number }>;
  models: Array<{ name: string; tokens: number; ratio: number; estimatedCostUsd?: number; missingPriceTokens?: number }>;
  workdirs: Array<{ name: string; tokens: number; ratio: number; estimatedCostUsd?: number; missingPriceTokens?: number }>;
  trendRows: Array<{ label: string; day?: string; hour?: number; totalTokens: number; estimatedCostUsd?: number; missingPriceTokens?: number }>;
  trendGrain: "hour" | "day";
  timeSeries: Array<{ hour?: number; day?: string; totalTokens: number }>;  // 仅 normalizeLocalShareData 填充，buildOverviewShareData 不填充
  heatmap: Array<{ hour?: number; day?: string; totalTokens: number }>;     // 同上
  estimatedCostUsd: number | null;
  quoteIndex: number;               // 0-11，随机
};
```

## 10. 接口和实现

### 10.1 数据聚合
- `normalizeLocalShareData(input)`：将本地 usage store 数据归一化为 `ShareCardData`。
  - 输入：`{ period, businessDay, identity, summary, trend, workdirs }`。
  - 输出：mode 为 `"local"`，rankStats 为 null。
  - 今日 timeSeries 补齐为 24 小时。
- `normalizeCloudShareData(input)`：将云端 API 数据归一化为 `ShareCardData`。
  - 输入：`{ period, businessDay, identity, analytics }`。
  - 根据 `identity.identityMode === "anonymous"` 设置 mode。
- `withCloudPending(data)`：浅拷贝数据并将 mode 设为 `"cloud_pending"`。
- `buildOverviewShareData(range)`（renderer.js）：
  - 复用 Overview 的数据管线：`usageQueryState.summaries`、`usageQueryState.trends`。
  - 本地降级：`groupByHour` / `groupByGrain` + `aggregateComposition`。
  - 计算 provider/model/workdir 比例。
  - 通过 `aggregateUsageCost` 计算本地成本。
  - 若已配置云端，调用 `fetchCloudShareData` 获取排名数据。

### 10.2 云端数据获取
- `fetchCloudShareData(range, config)`（renderer.js）：
  - `GET /api/board/my-identity?participantId=...` → 获取身份模式。
  - `GET /api/board/analytics?period=...&participantId=...` → 获取分析数据和排名。
  - 匿名用户使用 `publicId` 查询。
  - 云端 `analytics` 接口返回：`summary`、`models`、`providers`、`timeSeries`、`timeGrain`、`heatmap`、`rankStats`。
- `fetchBrandLogo()`：获取品牌 Logo，通过 `FileReader.readAsDataURL` 转为 data URL——html2canvas 导出时无法访问跨域 blob URL，必须使用 data URL 才能正确渲染到 canvas。

### 10.3 渲染和导出
- `renderShareCardHtml(data, opts)`：返回完整的卡片 HTML 字符串。
  - opts 包含：`t`、`formatToken`、`formatUsd`、`sourceName`、`formatAxisLabel`、`logoUrl`、`cloudUrl`。
- `shareCardCss()`：返回卡片内联 CSS 字符串（随 HTML 注入）。
- `renderExportPolaroidHtml(cardHtml, caption)`：将卡片 HTML 包裹在 Polaroid 白边框中。
- `polaroidExportCss()`：Polaroid 导出帧的 CSS。
- `exportShareCardBlob()`：
  1. 创建离屏 DOM 容器（`position:fixed; left:-9999px`）。
  2. 注入 CSS + Polaroid 包裹的卡片 HTML。
  3. `html2canvas(target, { scale: 2, useCORS: true, logging: false })` 渲染为 canvas。
  4. `canvas.toBlob()` 转为 PNG blob。
  5. 清理离屏 DOM。

### 10.4 复制和保存
- `copyShareCardImage()`：三级降级策略。
  1. Tauri 原生剪贴板：`window.tokenLeague.writeImageToClipboard(base64Png)`。
  2. 浏览器 Clipboard API：`navigator.clipboard.write([new ClipboardItem({"image/png": blob})])`。
  3. 降级保存：调用 `saveShareCardImage(blob)`。
- `saveShareCardImage(blob)`：
  - Tauri：`window.tokenLeague.saveShareImage({ fileName, base64Png })`，打开原生保存对话框。
  - 浏览器：创建 `<a>` 元素触发下载。
- `blobToBase64(blob)`：通过 `FileReader.readAsDataURL` 转换。
- 复制和保存成功后均自动关闭弹窗（`closeShareCardModal()`）并触发 `polaroidFlashSuccess` 成功反馈动画。

### 10.5 Polaroid 动画
- 四阶段动画序列：
  1. 闪光（0ms）：全屏白色闪光 `#polaroid-flash`，0.12s ease-out。
  2. 弹出（35ms）：相片从上方滑入（`polaroidPrint` 关键帧）。
  3. 显影（400ms）：白色遮罩渐隐（`polaroid-develop-overlay`，0.9s），内容渐入（0.6s + 0.2s delay）。
  4. 操作栏（700ms）：右侧按钮栏渐入。
- 关闭动画：相片向上滑出（`polaroidDismiss`），400ms 后隐藏 modal。
- 成功反馈：`polaroidFlashSuccess` 动画——缩放 + 青绿光晕。

### 10.6 Preview 缩放
- `renderShareCardPreview()`：
  - 将卡片 HTML + CSS 注入 `#share-card-preview`。
  - 卡片 `.sc-root` 使用 `position: absolute` + `transform-origin: top left` 定位。
  - 根据容器宽度计算 `zoom` 比例：`containerWidth / 1200`。
  - 设置 `root.style.zoom` 和容器高度以适配。

### 10.7 Tauri 后端 API
- `save_share_image_dialog`：打开原生文件保存对话框，接收 `{ fileName, base64Png }`。
- `write_image_to_clipboard`：写入系统剪贴板，接收单个字符串参数 `base64Png`（Tauri Rust 端签名为 `base64_png: String`）。

## 11. 文案和状态
- 空数据：`该周期暂无可分享数据` / `No shareable data for this period`。
- 本地模式排名区：`本地统计，未参与云端排名` / `Local stats`。
- 云端不可达：`云端状态不可用` / `Cloud status unavailable`。
- 匿名模式身份：`今日代号 · XXXX` / `Today's Code · XXXX`。
- 保存成功：`分享图已保存` / `Share image saved`。
- 复制成功：`分享图已复制` / `Share image copied`。
- 复制降级：`已降级为保存文件` / `Fallback to save`。
- 导出取消：`导出已取消` / `Export canceled`。
- 导出失败：`导出失败` / `Export failed`。
- i18n：所有用户可见文案均提供 `zh-CN` 和 `en` 双语。

## 12. XSS 安全
- 所有动态文本通过 `escapeHtml()` 转义 `&`、`<`、`>`、`"`。
- Logo URL 通过 `escapeHtml()` 转义后写入 `src` 属性。
- 语录、用户名、排名数字等均经过转义。

## 13. 验收标准
- 用户能在 Overview 页点击 Share 打开 Polaroid 风格弹窗。
- 弹窗播放完整的闪光-弹出-显影-操作栏动画序列。
- 卡片正确显示：用户名、日期范围、总 Token、Input/Output/Cache 分解、趋势柱状图、来源/模型/工作目录 Top 排名、底部语录。
- 本地模式不出现排名徽章和匿名代号，显示 `Local stats`。
- 云端公开模式显示排名徽章（金/银/铜/普通）+ 登顶天数 + 参考人数。
- 云端匿名模式显示排名徽章 + 今日代号，不暴露真实 participantId。
- cloud_pending 模式使用本地数据，不显示排名。
- 复制功能在 Tauri 桌面端使用原生剪贴板，浏览器端降级到 ClipboardItem 或文件保存。
- 保存功能在 Tauri 端打开原生对话框，浏览器端触发下载。
- 导出 PNG 为 Polaroid 白边框包裹的 2472×1564 图片。
- 导出 PNG 中无真实路径、源码、prompt、response、Cursor token、identity private key。
- 所有动态文本经过 XSS 转义。
- 小窗口下弹窗可滚动，预览不撑破布局：
  - 880px 以下：卡片预览缩放到 `min(560px, calc(100vw - 80px))`。
  - 768px 以下：`.polaroid-container` 切换为 `flex-direction: column`，`.polaroid-actions` 切换为 `flex-direction: row` 水平布局。

## 14. 测试计划
- 单元测试（`tests/renderer/share-card.test.js`）：
  - `sharePeriodBounds`：周一计算、月份起始。
  - `normalizeLocalShareData`：mode 为 local、totals 正确、今日 24 条 timeSeries、provider/model 比例。
  - `normalizeCloudShareData`：匿名模式保留 displayId、rankStats 透传。
  - `withCloudPending`：mode 变更、原数据不可变。
  - `renderShareCardHtml`：包含 `data-share-card-style="overview"`、Source mix / Model mix / Top Workdirs、XSS 转义、成本格式、排名数字、Local 标签、Logo 显隐和转义。
- E2E 测试（`tests/e2e/share-card.spec.js`）：
  - 打开弹窗：验证 `.polaroid-stage` 可见、卡片内容包含用户名和各区块。
  - 操作栏：验证复制（降级到保存）和保存（验证文件名格式和 base64 PNG）。
  - 空数据状态：Share 按钮禁用。
  - 品牌 Logo：侧边栏和分享图 footer 显隐。
