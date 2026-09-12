# 主题色方案对照

> 记录公开 Web（含 admin 嵌入分析页）的主题色方案演进。切换入口为
> `src/web/styles.css` 中 `THEME SWITCH POINT` 注释所在的 `:root` 块（约 11700 行）——
> 换配色只改这一段，改完刷新页面生效（JS 图表色板在页面加载时读取 CSS 变量，运行中修改变量需刷新）。
> 画布类 token（`--paper/--paper-2/--line/--line-soft/--surface-tint`）已在最末 `:root`（约 13273 行）定义，
> 同样属于切换范围。设计语言详见 `doc/web-ui-optimization-prompt.md`。

> 切换器当前方案顺序：岚紫 → 暖橙 → 墨绿 → 竞技绿（绯红已按用户决定移除）。

## 固定语义（各方案共用，实验时不改动）

| Token | 语义 | 值 |
| --- | --- | --- |
| `--data-cost` | 金额（铜色 + `--font-data` 等宽 + 600） | `#92631c` |
| `--data-positive` / `--data-negative` | 正 / 负状态 | `#2f7a5b` / `#b94a48` |
| 奖牌金 `--gold` | 奖牌身份色 | `#c5a359` |

## 方案 A：暖橙主题（arena 暖白纸系 · 上一版基线）

| Token | 用途 | 值 |
| --- | --- | --- |
| `--accent` | 品牌主色 · 第 1 名 · 选中态 · 主图形 | `#cf6a42` |
| `--accent-ink` | 主色深阶（文字 / 悬停） | `#b4552f` |
| `--accent-soft` | 主色浅底（选中 wash） | `#f9e9df` |
| `--accent-triple` | 主色 RGB 三元组（rgba 洗色） | `207, 106, 66` |
| `--accent-2` | 系列 2：演变第二带 / 树图第 3 名 / 份额第 3 名 | `#2c796c` |
| `--accent-3` | 系列 3：份额第 2 名 / 演变第三带 | `var(--gold) → #c5a359` |
| `--rank-other` | 「其他」兜底灰 | `#92958d` |
| `--tm-2` | 树图第 2 名（浅档） | `#d9a55c` |
| `--trend-4` | 趋势 / 份额第 4 色 | `#8b7355` |
| `--trend-5` | 趋势 / 份额第 5 色 | `#d9a55c` |
| `--trend-6` | 趋势 / 份额第 6 色 | `#6d6a5e` |
| `--trend-7` | 趋势 / 份额第 7 色 | `#9a8f7d` |
| `--comp-1` | 构成环 · 输入（深） | `#b4552f` |
| `--comp-2` | 构成环 · 缓存读取（= 主色） | `var(--accent)` |
| `--comp-3` | 构成环 · 输出 | `#e0956b` |
| `--comp-4` | 构成环 · 缓存写入（最浅） | `#f2ddcd` |
| `--night` | 时钟深夜段 | `#c9c4ba` |
| `--heat` | 热力 RGB 三元组（矩阵 / 年度热力 / 首页热力） | `207, 106, 66` |
| `--paper` | 页面画布底色 | `#fcfaf8` |
| `--paper-2` | 卡片底色 | `#ffffff` |
| `--line` | 标准描边 | `#e4e0d9` |
| `--line-soft` | 浅描边 / 条形轨道 | `#eceae4` |
| `--surface-tint` | 浅填充（chip / 选中底） | `#f4f0eb` |
| `--data-primary` | 主数据墨色 | `#2e2b29` |
| `--data-secondary` | 次级数据灰 | `#6f6a62` |
| `--data-positive` | 正向状态 | `#2f7a5b` |
| `--data-negative` | 负向状态 | `#b94a48` |
| `--data-cost` | 金额语义色（固定，勿随实验改动） | `#92631c` |
| `--green` | 数据辅助绿（meter / 迷你条 / 构成条） | `#2f7a5b` |
| `--jade-deep` | 构成条深档 | `#246b4f` |
| `--jade` | 构成条主档 | `#2f7a5b` |
| `--jade-light` | 构成条浅档 | `-` |
| `--jade-pale` | 构成条最浅档 | `-` |

## 方案 B：绯红（PANTONE 032C 纯系实验 · 已从切换器移除）

| Token | 用途 | 值 |
| --- | --- | --- |
| `--accent` | 品牌主色 · 第 1 名 · 选中态 · 主图形 | `#fe010f` |
| `--accent-ink` | 主色深阶（文字 / 悬停） | `#c60e1f` |
| `--accent-soft` | 主色浅底（选中 wash） | `#fdecee` |
| `--accent-triple` | 主色 RGB 三元组（rgba 洗色） | `254, 16, 15` |
| `--accent-2` | 系列 2：演变第二带 / 树图第 3 名 / 份额第 3 名 | `#664eff` |
| `--accent-3` | 系列 3：份额第 2 名 / 演变第三带 | `#f139b0` |
| `--rank-other` | 「其他」兜底灰 | `#a8a8a8` |
| `--tm-2` | 树图第 2 名（浅档） | `#f139b0` |
| `--trend-4` | 趋势 / 份额第 4 色 | `#1d1d1f` |
| `--trend-5` | 趋势 / 份额第 5 色 | `#b3a5ff` |
| `--trend-6` | 趋势 / 份额第 6 色 | `#303133` |
| `--trend-7` | 趋势 / 份额第 7 色 | `#dcdce8` |
| `--comp-1` | 构成环 · 输入（深） | `#c60e1f` |
| `--comp-2` | 构成环 · 缓存读取（= 主色） | `var(--accent)` |
| `--comp-3` | 构成环 · 输出 | `#f07878` |
| `--comp-4` | 构成环 · 缓存写入（最浅） | `#fdecee` |
| `--night` | 时钟深夜段 | `#b8b3d6` |
| `--heat` | 热力 RGB 三元组（矩阵 / 年度热力 / 首页热力） | `254, 16, 15` |
| `--paper` | 页面画布底色 | `#fdfdff` |
| `--paper-2` | 卡片底色 | `#ffffff` |
| `--line` | 标准描边 | `#e4e2f0` |
| `--line-soft` | 浅描边 / 条形轨道 | `#eceaf6` |
| `--surface-tint` | 浅填充（chip / 选中底） | `#eef0fa` |
| `--data-primary` | 主数据墨色 | `#2e2b29` |
| `--data-secondary` | 次级数据灰 | `#6f6a62` |
| `--data-positive` | 正向状态 | `#2f7a5b` |
| `--data-negative` | 负向状态 | `#b94a48` |
| `--data-cost` | 金额语义色（固定，勿随实验改动） | `#92631c` |
| `--green` | 数据辅助绿（meter / 迷你条 / 构成条） | `#2f7a5b` |
| `--jade-deep` | 构成条深档 | `#246b4f` |
| `--jade` | 构成条主档 | `#2f7a5b` |
| `--jade-light` | 构成条浅档 | `#5f9b7c` |
| `--jade-pale` | 构成条最浅档 | `#a7c4b5` |

## 方案 C：岚紫（ONEAIX 官网对齐 · 当前实验态）

> 依据官网 oneaix.com 实测：白底画布 + `#303133` 墨（Element Plus 体系）+
> 品牌渐变 `#664EFF → #F139B0 → #FE010F` 仅作点缀；大面用柔和过渡档，全饱和留给小焦点。

| Token | 用途 | 值 |
| --- | --- | --- |
| `--accent` | 品牌主色 · 第 1 名 · 选中态 · 主图形 | `#fe010f` |
| `--accent-ink` | 主色深阶（文字 / 悬停） | `#c60e1f` |
| `--accent-soft` | 主色浅底（选中 wash） | `#fdecee` |
| `--accent-triple` | 主色 RGB 三元组（rgba 洗色） | `254, 16, 15` |
| `--accent-2` | 系列 2：演变第二带 / 树图第 3 名 / 份额第 3 名 | `#7d8cff` |
| `--accent-3` | 系列 3：份额第 2 名 / 演变第三带 | `#f139b0` |
| `--rank-other` | 「其他」兜底灰 | `#909399` |
| `--tm-2` | 树图第 2 名（浅档） | `#f6a9c6` |
| `--trend-4` | 趋势 / 份额第 4 色 | `#1d1d1f` |
| `--trend-5` | 趋势 / 份额第 5 色 | `#b3a5ff` |
| `--trend-6` | 趋势 / 份额第 6 色 | `#303133` |
| `--trend-7` | 趋势 / 份额第 7 色 | `#dcdce8` |
| `--comp-1` | 构成环 · 输入（深） | `#c60e1f` |
| `--comp-2` | 构成环 · 缓存读取（= 主色） | `var(--accent)` |
| `--comp-3` | 构成环 · 输出 | `#f07878` |
| `--comp-4` | 构成环 · 缓存写入（最浅） | `#fdecee` |
| `--night` | 时钟深夜段 | `#b8b3d6` |
| `--heat` | 热力 RGB 三元组（矩阵 / 年度热力 / 首页热力） | `254, 16, 15` |
| `--paper` | 页面画布底色 | `#ffffff` |
| `--paper-2` | 卡片底色 | `#ffffff` |
| `--line` | 标准描边 | `#e4e7ed` |
| `--line-soft` | 浅描边 / 条形轨道 | `#ebeef5` |
| `--surface-tint` | 浅填充（chip / 选中底） | `#f5f7fa` |
| `--data-primary` | 主数据墨色 | `#303133` |
| `--data-secondary` | 次级数据灰 | `#909399` |
| `--data-positive` | 正向状态 | `#2f7a5b` |
| `--data-negative` | 负向状态 | `#b94a48` |
| `--data-cost` | 金额语义色（固定，勿随实验改动） | `#92631c` |
| `--green` | 数据辅助绿（meter / 迷你条 / 构成条） | `#2f7a5b` |
| `--jade-deep` | 构成条深档 | `#246b4f` |
| `--jade` | 构成条主档 | `#2f7a5b` |
| `--jade-light` | 构成条浅档 | `#5f9b7c` |
| `--jade-pale` | 构成条最浅档 | `#a7c4b5` |

## 方案 D：竞技绿（Arena Agent 榜绿 · 实验态，来自 arena.ai 实测）

> 依据 arena.ai/leaderboard 实测 token：画布 `#fcfaf8`、墨 `#2e2b29`、卡片白、
> 米灰阶 `#f4f0eb/#eeedec`、交互主色近黑 `#1d1d1b`、链接蓝 `#268be3`。
> 特点：近乎单色（黑白灰），蓝色是唯一彩色点缀（对应 arena 的链接色），
> 金额铜色在墨系中成为唯一的暖色点缀。

| Token | 值 |
| --- | --- |
| `--accent` / `--accent-ink` / `--tm-1` | `#1d1d1b` |
| `--accent-soft` / `--surface-tint` / `--line-soft` | `#f4f0eb` |
| `--accent-triple` / `--heat` | `29, 29, 27` |
| `--accent-2` | `#67625b` |
| `--accent-3` | `#268be3`（链接蓝） |
| `--rank-other` | `#b5b3af` |
| `--tm-2` | `#8a8781` |
| `--trend-4/5/6/7` | `#2d2d2d` / `#67625b` / `#a8a8a8` / `#d9d6d0` |
| `--comp-1/2/3/4` | `#1d1d1b` / `#67625b` / `#a8a8a8` / `#e5e2dd` |
| `--night` | `#b5b3af` |
| `--paper` / `--paper-2` | `#fcfaf8` / `#ffffff` |
| `--line` | `#eeedec` |
| `--data-primary` / `--data-secondary` | `#2e2b29` / `#413d39` |
| `--data-cost` | `#92631c`（固定铜色） |

## 方案 E：墨绿（生产现网 · 0.7.15 Editorial League 暖沙 + 墨绿）

> 提取自 v0.7.15 发布提交（95925404）的 styles.css 生效值：暖沙纸 `#f6f2ea`、
> 墨绿 `#18332e`、青绿主色 `#058f7e`、青色热力 `5,143,126`、沙色描边。
> 切换器中的「生产」chip 即此方案。

| Token | 值 |
| --- | --- |
| `--accent` / `--accent-ink` / `--tm-1` | `#058f7e` / `#075e5b` / `#058f7e` |
| `--accent-soft` / `--accent-triple` | `#edf5f1` / `5, 143, 126` |
| `--accent-2` / `--accent-3` | `#006d77` / `#b67810` |
| `--tm-2` | `#b67810` |
| `--trend-4/5/6/7` | `#1c7c54` / `#5db091` / `#a2d2bf` / `#dcece5` |
| `--comp-1/2/3/4` | `#1c7c54` / `#5db091` / `#a2d2bf` / `#edf5f1` |
| `--night` / `--rank-other` | `#a8b0a6` / `#a8a89e` |
| `--paper` / `--paper-2` | `#f6f2ea` / `#fffefb` |
| `--line` / `--line-soft` | `#d8d1c4` / `#ebe5da` |
| `--surface-tint` | `#edf5f1` |
| `--heat` | `5, 143, 126` |
| `--data-primary` / `--data-secondary` / `--data-cost` | `#18332e` / `#657069` / `#92631c` |

## 实验与还原

```bash
# 当前三种状态的备份
#   /tmp/styles-orange-backup.css  方案 A（橙）
#   /tmp/styles-red-backup.css     方案 B（红纯系）
#   src/web/styles.css             方案 C（官网对齐，当前）

cp /tmp/styles-orange-backup.css src/web/styles.css   # 还原方案 A
```

注意事项：

- JS 图表色板（`chart-helpers.js` 的 `theme()`）在页面加载时读取一次 CSS 变量并缓存；
  运行中修改 CSS 变量后需刷新页面才会反映到 SVG 图表。
- `--heat` 与 `--paper` 等在文件头部旧 `:root` 中有同名定义，会被更晚的层覆盖；
  实验时建议同步修改，保持一致。
- 系列区分色不必拘泥主色系：方案 C 的蓝/品红即来自品牌渐变的两端。
