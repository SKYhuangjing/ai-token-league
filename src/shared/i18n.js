/**
 * AI Token League - 轻量级多语言解决方案
 * 支持中文(zh-CN)和英文(en)
 */

// 翻译字典
const translations = {
  "zh-CN": {
    // 通用
    "app.name": "AI Token League",
    "app.tagline": "AI 编码令牌使用排行榜",
    "loading": "加载中...",
    "save": "保存",
    "cancel": "取消",
    "close": "关闭",
    "refresh": "刷新",
    "settings": "设置",
    "language": "语言",
    "language.zh": "中文",
    "language.en": "English",

    // Web 端 - 导航和标题
    "web.publicBoard": "公开社区榜单",
    "web.rankingMetric": "排名指标",
    "web.totalTokens": "总令牌数",
    "web.modelTotalsContext": "模型总数仅供参考显示",
    "web.downloadClient": "下载客户端",
    "web.checkingRelease": "检查最新版本...",
    "web.releaseMetadata": "版本元数据加载中",
    "web.estimatedCost": "预估成本",

    // Web 端 - 时间段筛选
    "web.period.today": "今天",
    "web.period.yesterday": "昨天",
    "web.period.thisWeek": "本周",
    "web.period.lastWeek": "上周",
    "web.period.thisMonth": "本月",
    "web.period.lastMonth": "上月",

    // Web 端 - 排行榜
    "web.leaderboard.title": "社区排行榜",
    "web.leaderboard.username": "用户名",
    "web.leaderboard.totalTokens": "总令牌数",
    "web.leaderboard.estCost": "预估成本",
    "web.leaderboard.models": "模型",
    "web.leaderboard.noUsage": "暂无使用数据上传",
    "web.leaderboard.participants": "位参与者",

    // Web 端 - 详情面板
    "web.detail.title": "参与者详情",
    "web.detail.selectUser": "从排行榜中选择一个用户",
    "web.detail.periodDetail": "时间段详情",
    "web.detail.historyTrend": "历史趋势",
    "web.detail.daily": "按日",
    "web.detail.weekly": "按周",
    "web.detail.monthly": "按月",
    "web.detail.usageComposition": "使用构成",
    "web.detail.models": "模型",
    "web.detail.sources": "来源",
    "web.detail.rawData": "原始数据",
    "web.detail.period": "时间段",
    "web.detail.composition": "构成",
    "web.detail.input": "输入",
    "web.detail.output": "输出",
    "web.detail.cache": "缓存",
    "web.detail.reasoning": "推理",
    "web.detail.priceQuality": "价格质量",
    "web.detail.noUsagePeriod": "该时间段无使用数据",

    // Web 端 - 趋势图表
    "web.trend.topContribution": "主要贡献",
    "web.trend.peak": "峰值",
    "web.trend.latest": "最新",

    // Web 端 - 成分摘要
    "web.composition.inputHeavy": "输入为主",
    "web.composition.outputHeavy": "输出为主",
    "web.composition.cacheHeavy": "缓存为主",
    "web.composition.reasoningHeavy": "推理为主",
    "web.composition.noUsage": "无使用数据",

    // Web 端 - 下载面板
    "web.download.latest": "最新版本",
    "web.download.platforms": "个平台",
    "web.download.recommended": "推荐此设备使用",
    "web.download.chooseMac": "选择 macOS Apple Silicon 或 macOS Intel",
    "web.download.notConfigured": "客户端下载未在此应用服务器上配置",

    // Web 端 - 成本相关
    "web.cost.exactPrice": "精确价格",
    "web.cost.estimatedPrice": "预估价格",
    "web.cost.unknownPrice": "未知价格",
    "web.cost.noPricingVersion": "无定价版本",
    "web.cost.missingModels": "缺失模型",

    // 桌面端 - 导航
    "desktop.nav.today": "今日",
    "desktop.nav.trend": "趋势",
    "desktop.nav.settings": "设置",

    // 桌面端 - 同步状态
    "desktop.sync.notSynced": "未同步",
    "desktop.sync.syncing": "同步中...",
    "desktop.sync.synced": "已同步",
    "desktop.sync.syncFailed": "同步失败",
    "desktop.sync.settingsSaved": "设置已保存",
    "desktop.sync.profileReady": "配置就绪",
    "desktop.sync.apiNotConfigured": "API 未配置",

    // 桌面端 - 今日面板
    "desktop.today.title": "今日",
    "desktop.today.scanning": "扫描本地使用中...",
    "desktop.today.noUsage": "今天无本地使用数据",
    "desktop.today.rowsFromSources": "条来自本地来源的日记录",
    "desktop.today.lastScan": "上次扫描",
    "desktop.today.workdirs": "工作目录",
    "desktop.today.models": "模型",
    "desktop.today.dominant": "主要构成",
    "desktop.today.estCost": "预估成本",
    "desktop.today.pricingUnavailable": "定价不可用",

    // 桌面端 - Token 构成
    "desktop.composition.tokenComposition": "令牌构成",
    "desktop.composition.todayLoading": "今日构成加载中",
    "desktop.composition.noComposition": "无构成数据",

    // 桌面端 - 工作目录
    "desktop.workdir.consumption": "工作目录消耗",
    "desktop.workdir.publicNames": "仅显示公开目录名",
    "desktop.workdir.noUsage": "今天无工作目录使用数据",

    // 桌面端 - 模型
    "desktop.model.consumption": "模型消耗",
    "desktop.model.tokenTotals": "按模型分组的令牌总数",
    "desktop.model.noUsage": "今天无模型使用数据",

    // 桌面端 - 趋势面板
    "desktop.trend.title": "使用趋势",
    "desktop.trend.dailyReview": "每日回顾",
    "desktop.trend.weeklyReview": "每周回顾",
    "desktop.trend.monthlyReview": "每月回顾",
    "desktop.trend.groupedFromCache": "从缓存的本地使用记录分组",
    "desktop.trend.noLocalUsage": "无本地使用数据",
    "desktop.trend.chart": "图表",
    "desktop.trend.table": "表格",

    // 桌面端 - 趋势表格
    "desktop.trend.period": "时间段",
    "desktop.trend.composition": "构成",
    "desktop.trend.workdirs": "工作目录",

    // 桌面端 - 设置面板
    "desktop.settings.title": "账户、云端和应用",
    "desktop.settings.notConfigured": "未配置",
    "desktop.settings.ready": "就绪",
    "desktop.settings.firstRun": "首次运行",

    // 桌面端 - 设置标签
    "desktop.settings.tab.account": "账户",
    "desktop.settings.tab.sources": "来源",
    "desktop.settings.tab.cloud": "云端",
    "desktop.settings.tab.sync": "同步",
    "desktop.settings.tab.app": "应用",

    // 桌面端 - 账户设置
    "desktop.account.nickname": "昵称",
    "desktop.account.saveSettings": "保存设置",
    "desktop.account.exportConfig": "导出配置",
    "desktop.account.importConfig": "导入配置",

    // 桌面端 - 来源设置
    "desktop.sources.localSources": "本地来源",
    "desktop.sources.manageProviders": "管理本地提供商、Cursor 令牌和公开工作目录别名",
    "desktop.sources.refreshSources": "刷新来源",
    "desktop.sources.addCodex": "添加 Codex 位置",
    "desktop.sources.addClaude": "添加 Claude Code 位置",
    "desktop.sources.addCursor": "添加 Cursor 令牌",
    "desktop.sources.noCursorToken": "未配置 Cursor 令牌",
    "desktop.sources.workdirAliases": "工作目录别名",

    // 桌面端 - 云端设置
    "desktop.cloud.title": "云端连接",
    "desktop.cloud.description": "一个应用服务器目标用于同步、定价、兼容性和更新检查",
    "desktop.cloud.apiBaseUrl": "API 基础 URL",
    "desktop.cloud.cloudStatus": "云端状态",
    "desktop.cloud.api": "API",
    "desktop.cloud.health": "健康",
    "desktop.cloud.server": "服务器",
    "desktop.cloud.protocol": "协议",
    "desktop.cloud.compatibility": "兼容性",
    "desktop.cloud.latest": "最新版本",
    "desktop.cloud.releaseManifest": "发布清单",
    "desktop.cloud.notConfigured": "云端未配置",
    "desktop.cloud.manifestConfigured": "发布清单已配置",

    // 桌面端 - 同步设置
    "desktop.sync.title": "同步和刷新",
    "desktop.sync.description": "控制本地刷新频率和上传队列行为",
    "desktop.sync.refreshInterval": "刷新间隔（分钟）",
    "desktop.sync.backgroundRefresh": "后台刷新",
    "desktop.sync.syncStatus": "同步状态",
    "desktop.sync.lastSync": "上次同步",
    "desktop.sync.result": "结果",
    "desktop.sync.backgroundState": "后台刷新尚未运行",
    "desktop.sync.rowsKeptQueue": "行保留在队列中",

    // 桌面端 - 应用设置
    "desktop.app.title": "应用",
    "desktop.app.description": "客户端版本、验证更新下载、显示偏好和本地启动行为",
    "desktop.app.versionStatus": "版本状态",
    "desktop.app.client": "客户端",
    "desktop.app.latest": "最新版本",
    "desktop.app.lastCheck": "上次检查",
    "desktop.app.silentUpdate": "静默更新",
    "desktop.app.notifyOnly": "仅通知",
    "desktop.app.autoDownload": "自动下载",
    "desktop.app.autoApplyIdle": "空闲时自动应用",
    "desktop.app.checkUpdate": "检查更新",
    "desktop.app.downloadRestart": "下载并重启",
    "desktop.app.exportDiagnostics": "导出诊断",

    // 桌面端 - 风险控件
    "desktop.risk.syncUpload": "同步上传",
    "desktop.risk.syncDescription": "同步将本地汇总使用记录发送到配置的 API。应用会在上传前显示目标和行数预览。",
    "desktop.risk.cursorCredentials": "Cursor 凭证",
    "desktop.risk.cursorDescription": "Cursor 令牌保留在此计算机上。从来源添加或轮换；保存后不会再次显示。",
    "desktop.risk.profileFiles": "配置文件",
    "desktop.risk.profileDescription": "导入和导出在本地文件之间移动您的匿名配置文件身份。保持导出的配置文件私密。",
    "desktop.risk.resetData": "重置本地数据",
    "desktop.risk.resetDescription": "重置清除此应用配置文件、缓存、别名、队列、令牌和设置。来源应用历史不会被删除。",

    // 桌面端 - 显示选项
    "desktop.display.showEstCost": "显示预估成本",
    "desktop.display.showRawTokens": "显示原始令牌数",
    "desktop.display.launchAtLogin": "登录时启动",

    // 桌面端 - 重置区域
    "desktop.reset.title": "重置本地数据",
    "desktop.reset.description": "清除此桌面配置文件、上传队列、缓存使用扫描、本地令牌、别名和设置。Codex、Claude Code 和 Cursor 源文件不会被删除。",
    "desktop.reset.button": "重置数据",

    // 桌面端 - 向导
    "desktop.wizard.welcome": "欢迎使用 AI Token League",
    "desktop.wizard.welcomeDesc": "跟踪您的 AI 编码令牌使用情况并与社区比较。应用扫描来自 Codex、Claude Code 和 Cursor 的本地使用文件，然后汇总每日令牌数。",
    "desktop.wizard.privacyTitle": "您的数据保持私密",
    "desktop.wizard.privacy1": "永远不会收集提示和助手响应。",
    "desktop.wizard.privacy2": "永远不会收集源代码和文件内容。",
    "desktop.wizard.privacy3": "真实文件路径被替换为 SHA-256 哈希。",
    "desktop.wizard.privacy4": "Cursor 会话令牌保留在您的计算机上。",
    "desktop.wizard.privacy5": "您的身份私钥永远不会离开您的机器。",
    "desktop.wizard.identity": "您的身份",
    "desktop.wizard.identityDesc": "AI Token League 在此设备上创建加密身份。它签署您的使用数据，以便服务器可以验证它来自您，而无需登录。",
    "desktop.wizard.participantId": "参与者 ID",
    "desktop.wizard.importExisting": "导入现有配置",
    "desktop.wizard.dataSources": "数据来源",
    "desktop.wizard.sourcesDesc": "我们检查了您的机器上的 AI 编码工具。启用您想要跟踪的工具。",
    "desktop.wizard.cloud": "云端连接（可选）",
    "desktop.wizard.cloudDesc": "连接到应用服务器以将您的使用同步到社区排行榜、检查更新和查看模型定价。",
    "desktop.wizard.withCloud": "使用云端",
    "desktop.wizard.withCloudDesc": "上传到公开排行榜、检查更新和获取模型定价。",
    "desktop.wizard.localOnly": "仅本地",
    "desktop.wizard.localOnlyDesc": "所有数据保留在此设备上。您仍然可以查看本地使用数据。",
    "desktop.wizard.skipCloud": "跳过云端",
    "desktop.wizard.ready": "您已就绪",
    "desktop.wizard.startTracking": "开始跟踪",
    "desktop.wizard.skipSetup": "跳过设置",

    // 来源名称
    "source.codex": "Codex",
    "source.claude": "Claude Code",
    "source.cursor": "Cursor",

    // 平台标签
    "platform.darwinArm64": "macOS Apple Silicon",
    "platform.darwinX64": "macOS Intel",
    "platform.win32X64": "Windows x64",

    // 通用状态
    "status.enabled": "已启用",
    "status.disabled": "已禁用",
    "status.on": "开启",
    "status.off": "关闭",
    "status.ok": "正常",
    "status.error": "错误",
    "status.notFound": "未找到"
  },

  "en": {
    // Common
    "app.name": "AI Token League",
    "app.tagline": "AI Coding Token Usage Leaderboard",
    "loading": "Loading...",
    "save": "Save",
    "cancel": "Cancel",
    "close": "Close",
    "refresh": "Refresh",
    "settings": "Settings",
    "language": "Language",
    "language.zh": "中文",
    "language.en": "English",

    // Web - Navigation and Headers
    "web.publicBoard": "Public community board",
    "web.rankingMetric": "Ranking metric",
    "web.totalTokens": "Total tokens",
    "web.modelTotalsContext": "Model totals are shown for context",
    "web.downloadClient": "Download client",
    "web.checkingRelease": "Checking latest release...",
    "web.releaseMetadata": "Release metadata loading",
    "web.estimatedCost": "Estimated cost",

    // Web - Period Filters
    "web.period.today": "Today",
    "web.period.yesterday": "Yesterday",
    "web.period.thisWeek": "This week",
    "web.period.lastWeek": "Last week",
    "web.period.thisMonth": "This month",
    "web.period.lastMonth": "Last month",

    // Web - Leaderboard
    "web.leaderboard.title": "Community Leaderboard",
    "web.leaderboard.username": "Username",
    "web.leaderboard.totalTokens": "Total tokens",
    "web.leaderboard.estCost": "Est. cost",
    "web.leaderboard.models": "Models",
    "web.leaderboard.noUsage": "No usage uploaded yet",
    "web.leaderboard.participants": "ranked participant",

    // Web - Detail Panel
    "web.detail.title": "Participant detail",
    "web.detail.selectUser": "Select a user from the leaderboard",
    "web.detail.periodDetail": "Period detail",
    "web.detail.historyTrend": "History trend",
    "web.detail.daily": "Daily",
    "web.detail.weekly": "Weekly",
    "web.detail.monthly": "Monthly",
    "web.detail.usageComposition": "Usage composition",
    "web.detail.models": "Models",
    "web.detail.sources": "Sources",
    "web.detail.rawData": "Raw data",
    "web.detail.period": "Period",
    "web.detail.composition": "Composition",
    "web.detail.input": "Input",
    "web.detail.output": "Output",
    "web.detail.cache": "Cache",
    "web.detail.reasoning": "Reasoning",
    "web.detail.priceQuality": "Price quality",
    "web.detail.noUsagePeriod": "No usage in this period",

    // Web - Trend Charts
    "web.trend.topContribution": "Top contribution",
    "web.trend.peak": "Peak",
    "web.trend.latest": "Latest",

    // Web - Composition Summary
    "web.composition.inputHeavy": "Input-heavy",
    "web.composition.outputHeavy": "Output-heavy",
    "web.composition.cacheHeavy": "Cache-heavy",
    "web.composition.reasoningHeavy": "Reasoning-heavy",
    "web.composition.noUsage": "No usage",

    // Web - Download Panel
    "web.download.latest": "Latest",
    "web.download.platforms": "platform",
    "web.download.recommended": "recommended for this device",
    "web.download.chooseMac": "choose macOS Apple silicon or macOS Intel",
    "web.download.notConfigured": "Client downloads are not configured on this app server",

    // Web - Cost Related
    "web.cost.exactPrice": "exact_price",
    "web.cost.estimatedPrice": "estimated_price",
    "web.cost.unknownPrice": "unknown_price",
    "web.cost.noPricingVersion": "no pricing version",
    "web.cost.missingModels": "missing",

    // Desktop - Navigation
    "desktop.nav.today": "Today",
    "desktop.nav.trend": "Trend",
    "desktop.nav.settings": "Settings",

    // Desktop - Sync Status
    "desktop.sync.notSynced": "Not synced",
    "desktop.sync.syncing": "Syncing...",
    "desktop.sync.synced": "Synced",
    "desktop.sync.syncFailed": "Sync failed",
    "desktop.sync.settingsSaved": "Settings saved",
    "desktop.sync.profileReady": "Profile ready",
    "desktop.sync.apiNotConfigured": "API not configured",

    // Desktop - Today Panel
    "desktop.today.title": "Today",
    "desktop.today.scanning": "Scanning local usage...",
    "desktop.today.noUsage": "No local usage found for today",
    "desktop.today.rowsFromSources": "daily rows from local sources",
    "desktop.today.lastScan": "Last scan",
    "desktop.today.workdirs": "Workdirs",
    "desktop.today.models": "Models",
    "desktop.today.dominant": "Dominant composition",
    "desktop.today.estCost": "Est. cost",
    "desktop.today.pricingUnavailable": "pricing unavailable",

    // Desktop - Token Composition
    "desktop.composition.tokenComposition": "Token composition",
    "desktop.composition.todayLoading": "Today composition is loading",
    "desktop.composition.noComposition": "No composition",

    // Desktop - Workdirs
    "desktop.workdir.consumption": "Workdir consumption",
    "desktop.workdir.publicNames": "Only public directory names are shown",
    "desktop.workdir.noUsage": "No workdir usage today",

    // Desktop - Models
    "desktop.model.consumption": "Model consumption",
    "desktop.model.tokenTotals": "Token totals grouped by model",
    "desktop.model.noUsage": "No model usage today",

    // Desktop - Trend Panel
    "desktop.trend.title": "Usage rhythm",
    "desktop.trend.dailyReview": "Daily review",
    "desktop.trend.weeklyReview": "Weekly review",
    "desktop.trend.monthlyReview": "Monthly review",
    "desktop.trend.groupedFromCache": "Grouped from cached local usage rows",
    "desktop.trend.noLocalUsage": "No local usage found",
    "desktop.trend.chart": "Chart",
    "desktop.trend.table": "Table",

    // Desktop - Trend Table
    "desktop.trend.period": "Period",
    "desktop.trend.composition": "Composition",
    "desktop.trend.workdirs": "Workdirs",

    // Desktop - Settings Panel
    "desktop.settings.title": "Account, cloud, and app",
    "desktop.settings.notConfigured": "Not configured",
    "desktop.settings.ready": "Ready",
    "desktop.settings.firstRun": "First run",

    // Desktop - Settings Tabs
    "desktop.settings.tab.account": "Account",
    "desktop.settings.tab.sources": "Sources",
    "desktop.settings.tab.cloud": "Cloud",
    "desktop.settings.tab.sync": "Sync",
    "desktop.settings.tab.app": "App",

    // Desktop - Account Settings
    "desktop.account.nickname": "Nickname",
    "desktop.account.saveSettings": "Save settings",
    "desktop.account.exportConfig": "Export config",
    "desktop.account.importConfig": "Import config",

    // Desktop - Sources Settings
    "desktop.sources.localSources": "Local sources",
    "desktop.sources.manageProviders": "Manage local providers, Cursor tokens, and public workdir aliases",
    "desktop.sources.refreshSources": "Refresh sources",
    "desktop.sources.addCodex": "Add Codex location",
    "desktop.sources.addClaude": "Add Claude Code location",
    "desktop.sources.addCursor": "Add Cursor token",
    "desktop.sources.noCursorToken": "No Cursor token configured",
    "desktop.sources.workdirAliases": "Workdir aliases",

    // Desktop - Cloud Settings
    "desktop.cloud.title": "Cloud connection",
    "desktop.cloud.description": "One app-server target is used by sync, pricing, compatibility, and update checks",
    "desktop.cloud.apiBaseUrl": "API base URL",
    "desktop.cloud.cloudStatus": "Cloud status",
    "desktop.cloud.api": "API",
    "desktop.cloud.health": "Health",
    "desktop.cloud.server": "Server",
    "desktop.cloud.protocol": "Protocol",
    "desktop.cloud.compatibility": "Compatibility",
    "desktop.cloud.latest": "Latest",
    "desktop.cloud.releaseManifest": "Release manifest",
    "desktop.cloud.notConfigured": "Cloud not configured",
    "desktop.cloud.manifestConfigured": "Release manifest configured",

    // Desktop - Sync Settings
    "desktop.sync.title": "Sync and refresh",
    "desktop.sync.description": "Controls local refresh cadence and upload queue behavior",
    "desktop.sync.refreshInterval": "Refresh interval (minutes)",
    "desktop.sync.backgroundRefresh": "Background refresh",
    "desktop.sync.syncStatus": "Sync status",
    "desktop.sync.lastSync": "Last sync",
    "desktop.sync.result": "Result",
    "desktop.sync.backgroundState": "Background refresh has not run yet",
    "desktop.sync.rowsKeptQueue": "rows kept in queue",

    // Desktop - App Settings
    "desktop.app.title": "App",
    "desktop.app.description": "Client version, verified update download, display preferences, and local startup behavior",
    "desktop.app.versionStatus": "Version status",
    "desktop.app.client": "Client",
    "desktop.app.latest": "Latest",
    "desktop.app.lastCheck": "Last check",
    "desktop.app.silentUpdate": "Silent update",
    "desktop.app.notifyOnly": "Notify only",
    "desktop.app.autoDownload": "Auto-download",
    "desktop.app.autoApplyIdle": "Auto-apply when idle",
    "desktop.app.checkUpdate": "Check update",
    "desktop.app.downloadRestart": "Download and restart",
    "desktop.app.exportDiagnostics": "Export diagnostics",

    // Desktop - Risk Controls
    "desktop.risk.syncUpload": "Sync upload",
    "desktop.risk.syncDescription": "Sync sends local aggregate usage rows to the configured API. The app shows a target and row-count preview before upload.",
    "desktop.risk.cursorCredentials": "Cursor credentials",
    "desktop.risk.cursorDescription": "Cursor tokens stay on this computer. Add or rotate them from Sources; they are not rendered back after save.",
    "desktop.risk.profileFiles": "Profile files",
    "desktop.risk.profileDescription": "Import and export move your anonymous profile identity between local files. Keep exported profiles private.",
    "desktop.risk.resetData": "Reset local data",
    "desktop.risk.resetDescription": "Reset clears this desktop profile, upload queue, cached usage scan, local tokens, aliases, and settings. Source files in Codex, Claude Code, and Cursor are not deleted.",

    // Desktop - Display Options
    "desktop.display.showEstCost": "Show estimated cost",
    "desktop.display.showRawTokens": "Show raw token numbers",
    "desktop.display.launchAtLogin": "Launch at login",

    // Desktop - Reset Zone
    "desktop.reset.title": "Reset local data",
    "desktop.reset.description": "Clears this desktop profile, upload queue, cached usage scan, local tokens, aliases, and settings. Codex, Claude Code, and Cursor source files are not deleted.",
    "desktop.reset.button": "Reset data",

    // Desktop - Wizard
    "desktop.wizard.welcome": "Welcome to AI Token League",
    "desktop.wizard.welcomeDesc": "Track your AI coding token usage and compare with the community. The app scans local usage files from Codex, Claude Code, and Cursor, then aggregates daily token counts.",
    "desktop.wizard.privacyTitle": "Your data stays private",
    "desktop.wizard.privacy1": "Prompts and assistant responses are never collected.",
    "desktop.wizard.privacy2": "Source code and file content are never collected.",
    "desktop.wizard.privacy3": "Real file paths are replaced with SHA-256 hashes.",
    "desktop.wizard.privacy4": "Cursor session tokens stay on your computer.",
    "desktop.wizard.privacy5": "Your identity private key never leaves your machine.",
    "desktop.wizard.identity": "Your identity",
    "desktop.wizard.identityDesc": "AI Token League creates a cryptographic identity on this device. It signs your usage data so the server can verify it came from you, without requiring a login.",
    "desktop.wizard.participantId": "Participant ID",
    "desktop.wizard.importExisting": "Import existing config",
    "desktop.wizard.dataSources": "Data sources",
    "desktop.wizard.sourcesDesc": "We checked your machine for AI coding tools. Enable the ones you want to track.",
    "desktop.wizard.cloud": "Cloud connection (optional)",
    "desktop.wizard.cloudDesc": "Connect to an app server to sync your usage to the community leaderboard, check for updates, and view model pricing.",
    "desktop.wizard.withCloud": "With cloud",
    "desktop.wizard.withCloudDesc": "Upload to the public leaderboard, check for updates, and fetch model pricing.",
    "desktop.wizard.localOnly": "Local only",
    "desktop.wizard.localOnlyDesc": "All data stays on this device. You can still view your local usage.",
    "desktop.wizard.skipCloud": "Skip cloud",
    "desktop.wizard.ready": "You're ready",
    "desktop.wizard.startTracking": "Start tracking",
    "desktop.wizard.skipSetup": "Skip setup",

    // Source Names
    "source.codex": "Codex",
    "source.claude": "Claude Code",
    "source.cursor": "Cursor",

    // Platform Labels
    "platform.darwinArm64": "macOS Apple silicon",
    "platform.darwinX64": "macOS Intel",
    "platform.win32X64": "Windows x64",

    // Common Status
    "status.enabled": "Enabled",
    "status.disabled": "Disabled",
    "status.on": "On",
    "status.off": "Off",
    "status.ok": "OK",
    "status.error": "Error",
    "status.notFound": "Not found"
  }
};

// 默认语言
const DEFAULT_LANG = "zh-CN";
const STORAGE_KEY = "ai-token-league.language";

// 当前语言
let currentLang = DEFAULT_LANG;

/**
 * 初始化 i18n，从 localStorage 读取保存的语言设置
 */
export function initI18n() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && translations[saved]) {
      currentLang = saved;
    }
  } catch {
    // localStorage 不可用，使用默认语言
  }
  document.documentElement.lang = currentLang === "zh-CN" ? "zh-CN" : "en";
  return currentLang;
}

/**
 * 获取当前语言
 */
export function getCurrentLang() {
  return currentLang;
}

/**
 * 获取支持的语言列表
 */
export function getSupportedLangs() {
  return [
    { code: "zh-CN", name: "中文" },
    { code: "en", name: "English" }
  ];
}

/**
 * 切换语言
 */
export function setLang(lang) {
  if (!translations[lang]) return false;
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // localStorage 不可用
  }
  document.documentElement.lang = lang === "zh-CN" ? "zh-CN" : "en";
  return true;
}

/**
 * 翻译函数
 * @param {string} key - 翻译键
 * @param {Object} params - 替换参数，如 { count: 5 }
 * @returns {string} 翻译后的文本
 */
export function t(key, params = {}) {
  const dict = translations[currentLang] || translations[DEFAULT_LANG];
  let text = dict[key] || key;

  // 替换参数
  Object.entries(params).forEach(([k, v]) => {
    text = text.replace(new RegExp(`{${k}}`, "g"), String(v));
  });

  return text;
}

/**
 * 翻译并渲染 HTML（简单版本，不支持复数等复杂规则）
 */
export function $t(key, params = {}) {
  return t(key, params);
}

/**
 * 更新页面中所有带有 data-i18n 属性的元素
 */
export function updatePageTranslations() {
  // 翻译文本内容
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (key) {
      el.textContent = t(key);
    }
  });

  // 翻译 placeholder
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.dataset.i18nPlaceholder;
    if (key) {
      el.placeholder = t(key);
    }
  });

  // 翻译 title
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (key) {
      el.title = t(key);
    }
  });
}

/**
 * 创建语言切换器 HTML
 */
export function createLangSwitcher(onChange) {
  const langs = getSupportedLangs();
  const current = getCurrentLang();

  return `
    <div class="lang-switcher">
      <select id="lang-switcher" class="lang-select">
        ${langs.map((lang) => `
          <option value="${lang.code}" ${lang.code === current ? "selected" : ""}>
            ${lang.name}
          </option>
        `).join("")}
      </select>
    </div>
  `;
}

/**
 * 绑定语言切换器事件
 */
export function bindLangSwitcher(elementId, onChange) {
  const select = document.getElementById(elementId);
  if (!select) return;

  select.addEventListener("change", (e) => {
    const newLang = e.target.value;
    if (setLang(newLang)) {
      updatePageTranslations();
      if (onChange) onChange(newLang);
    }
  });
}

// 默认导出
export default {
  init: initI18n,
  getLang: getCurrentLang,
  setLang,
  getSupportedLangs,
  t,
  $t,
  updatePageTranslations,
  createLangSwitcher,
  bindLangSwitcher
};
