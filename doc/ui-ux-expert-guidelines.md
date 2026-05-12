# AI Token League UI/UX Expert Guidelines

此文档定义了 AI Token League 客户端 UI/UX 升级的专家级设计准则与业务约束。在后续与 AI 协同进行 UI 迭代时，请直接 `@` 本文档，以确保 AI 生成的设计和代码不偏离产品本质。

## 1. 核心定位与视觉基调 (Core Identity)

- **Local-first 极客美学**：界面需要传达安全、本地、轻量、纯粹的开发者工具属性。视觉上偏向“复古极客/新拟态报纸风”，克制使用全局色彩，利用 CSS 变量（如 `--paper`, `--ink`, `--muted`）构建界面。
- **信息降噪**：摒弃传统后台系统的大面积数据表格，改用高信息密度的卡片（Cards）、数据面板（Panels）、状态标记（Badges/Tags）和趋势图。

## 2. 数据表达的绝对规则 (Data Mapping Rules)

在进行可视化设计或数据绑定时，UI 结构必须严格遵守后端数据定义：

- **Token 构成公式必须完整**：`totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`。
  - **👉 UI 约束**：在任何涉及“Token 构成（Composition）”的图表（如环形图、堆叠柱状图）中，**绝对不可将 Cache 粗暴合并为一项**。必须明确拆分为 `Cache Read`（命中，成本极低）和 `Cache Write`（写入，成本较高），这深刻影响开发者的使用习惯。
- **Cost（成本）的视觉从属性**：
  - **👉 UI 约束**：Token 数量是产品的“唯一核心指标”。预估金额（Estimated Cost）仅作辅助参考。在视图层级上，Cost 信息的字号、字重和色彩对比度，**永远不得超过或抢夺** Total Tokens 的视觉焦点（建议使用 `--muted` 样式或附带开关隐藏）。

## 3. 核心交互范式 (Interaction Paradigms)

- **抽屉模式 (Drawer Pattern) 的深度应用**：
  - **👉 UI 约束**：在处理列表详情或局部编辑（如 Workdirs 目录列表、单个 Model 详情）时，**严禁**使用脱离上下文的独立配置表单，也**严禁**在总览页右侧摆放固定且无关联的输入框。
  - **标准行为**：点击左侧列表对象（Card） -> 当前屏幕滑出 Drawer 抽屉 -> 在 Drawer 内部渲染该特定对象的数据（如单一目录的模型拆解环形图）和操作表单（如修改 Alias）。关闭 Drawer 即可返回完整上下文。
- **拒绝无锚点的可视化 (Anchored Visualizations)**：
  - **👉 UI 约束**：单纯好看的波浪线或柱状图（Sparklines）无法帮开发者排查异常。任何趋势分析图，必须在界面底部（X轴位置）提供极简的时间锚点（例如标出最高峰值的小时数，或早中晚刻度），确保数据具有可读性。
- **隐私保护的视觉心理学**：
  - **👉 UI 约束**：由于是 Local-first 产品，UI 上必须不断给用户建立安全感。当配置目录（Workdir）别名或涉及隐私路径时，应当在界面上醒目展示类似“Real paths are not shown”的安全徽章。

## 4. 面向 AI 的自检 Prompt 准则 (AI Generation Checklist)

当你（AI）被要求生成或修改本项目的 UI 代码时，请先进行以下自检：

1. **[业务校验]** 我的环形图和图例是否区分了 `Cache Read` 和 `Cache Write`？
2. **[视觉校验]** 我有没有把 `$估算金额` 做得比 Token 数还大或者一样大？如果有，立刻改小。
3. **[交互校验]** 用户修改某个项的属性（比如 Workdir Alias）时，表单是不是和被选中的对象紧密绑定在了一起（比如放在点击后弹出的 Drawer 里），而不是随意扔在界面的空白处？
4. **[易用性校验]** 我的趋势折线图/柱状图，是否能够让用户一眼看出峰值发生在几点？
