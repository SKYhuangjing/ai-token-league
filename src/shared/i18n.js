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
    "cancel": "取消",
    "close": "关闭",
    "refresh": "刷新",
    "language.zh": "中文",
    "language.en": "English",
    "unit.tokens": "令牌",
    "common.dateRange": "{from} 至 {to}",
    "common.cost": "成本",
    "common.total": "总计",
    "common.peak": "峰值",

    // Web 端 - 导航和标题
    "web.publicBoard": "公开社区榜单",
    "web.rankingMetric": "排名指标",
    "web.totalTokens": "总令牌数",
    "web.modelTotalsContext": "模型总数仅供参考显示",
    "web.checkingRelease": "检查最新版本...",
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
    "web.leaderboard.participantCount": "{count} 位参与者",
    "web.leaderboard.anonymousTitle": "匿名公开榜",
    "web.leaderboard.anonymousDesc": "名称为系统生成的匿名展示名，真实昵称不会公开。",
    "web.leaderboard.colNickname": "昵称",
    "web.leaderboard.colAlias": "匿名名",
    "web.leaderboard.aliasMark": "匿名",
    "web.leaderboard.aliasRotatesDaily": "匿名展示名 · 今日有效",

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
    "web.detail.cacheRead": "缓存读取",
    "web.detail.cacheWrite": "缓存写入",
    "web.detail.reasoning": "推理",
    "web.detail.priceQuality": "价格质量",
    "web.detail.noUsagePeriod": "该时间段无使用数据",

    // Web 端 - 成分摘要
    "web.composition.inputHeavy": "输入为主",
    "web.composition.outputHeavy": "输出为主",
    "web.composition.cacheHeavy": "缓存为主",
    "web.composition.reasoningHeavy": "推理为主",
    "web.composition.noUsage": "无使用数据",

    // Web 端 - 详情补充
    "web.detail.periodDetailLabel": "排行榜时间段详情",
    "web.detail.loadingHistory": "加载历史中...",
    "web.detail.historyWindow": "历史窗口",
    "web.detail.singleDayNote": "单日排行榜时间段由构成解释，不使用趋势图表。",
    "web.detail.noUsagePeriod": "该时间段无使用数据。",
    "web.detail.noUsageHistory": "该历史窗口无使用数据。",
    "web.detail.noUsageSlice": "该切片无使用数据。",
    "web.detail.topDate": "主要日期贡献",
    "web.detail.topPeriod": "主要时间段贡献",
    "web.detail.historyBuckets": "历史桶数",
    "web.detail.windowTokens": "窗口令牌数",
    "web.detail.peakPeriod": "峰值时间段",
    "web.detail.windowCost": "窗口成本",
    "web.detail.dailyHistory": "每日历史",
    "web.detail.weeklyHistory": "每周历史",
    "web.detail.monthlyHistory": "每月历史",
    "web.detail.participant": "参与者",
    "web.detail.periodTokens": "时间段令牌",
    "web.detail.dominant": "主导",
    "web.detail.rank": "排名",

    // Web 端 - 下载面板
    "web.download.latest": "最新版本",
    "web.download.downloadBtn": "下载",
    "web.releaseMetadata": "版本元数据加载中",
    "web.download.notConfigured": "客户端下载未在此应用服务器上配置",
    "web.download.pageTitle": "下载桌面客户端",
    "web.download.selectPlatform": "选择你的平台，直接下载",
    "web.download.recommended": "推荐",
    "web.download.winDesc": "适用于 Windows 10 / 11",
    "web.download.macArmDesc": "Apple Silicon（M1 及以上）",
    "web.download.macIntelDesc": "Intel 处理器（2020 前）",

    // Web 端 - 首页
    "web.landing.features": "功能特性",
    "web.landing.featureLocalTitle": "本地优先",
    "web.landing.featureLocalDesc": "数据不离开设备",
    "web.landing.featureMultiTitle": "多来源支持",
    "web.landing.featureMultiDesc": "Claude Code / Codex / Cursor",
    "web.landing.featureBoardTitle": "社区排行榜",
    "web.landing.featureBoardDesc": "匿名 Token 使用量排名",
    "web.landing.viewLeaderboard": "查看社区排行榜",
    "web.landing.participants": "参与者",
    "web.landing.todayTokens": "今日令牌",
    "web.landing.weekTokens": "本周令牌",
    "web.landing.monthTokens": "本月令牌",
    "web.landing.lastMonthTokens": "上月令牌",
    "web.landing.serverVersion": "服务端版本",
    "web.landing.compatibility": "兼容性",
    "web.landing.compatible": "兼容",
    "web.landing.incompatible": "不兼容",

    // Web 端 - 成本相关
    "web.cost.exactPrice": "精确价格",
    "web.cost.estimatedPrice": "预估价格",
    "web.cost.unknownPrice": "未知价格",
    "web.cost.noPricingVersion": "无定价版本",
    "web.cost.missingModels": "缺失模型",
    "web.cost.missingModelPrices": "部分模型价格缺失",

    // 桌面端 - 导航
    "desktop.nav.today": "今日",
    "desktop.nav.trend": "趋势",
    "desktop.nav.settings": "设置",
    "desktop.nav.syncNow": "立即同步",

    // 桌面端 - 同步状态
    "desktop.sync.notSynced": "未同步",
    "desktop.sync.settingsSaved": "设置已保存",
    "desktop.sync.settingsSavedNextCycle": "设置已保存，扫描或更新策略变更将在下一轮生效",
    "desktop.sync.unsavedChanges": "有未保存更改",
    "desktop.sync.unsavedApiBaseUrl": "API 地址有未保存的更改。是否使用已保存的地址继续？",
    "desktop.sync.profileReady": "配置就绪",
    "desktop.sync.apiNotConfigured": "API 未配置",

    // 桌面端 - 今日面板
    "desktop.today.title": "今日",
    "desktop.today.scanning": "扫描本地使用中...",
    "desktop.today.lastScan": "上次扫描",
    "desktop.today.workdirs": "工作目录",
    "desktop.today.models": "模型",
    "desktop.today.dominant": "主要构成",
    "desktop.today.estCost": "预估成本",
    "desktop.today.pricingUnavailable": "定价不可用",

    // 桌面端 - Token 构成
    "desktop.composition.tokenComposition": "令牌构成",
    "desktop.composition.todayLoading": "今日构成加载中",

    // 桌面端 - 工作目录
    "desktop.workdir.consumption": "工作目录消耗",
    "desktop.workdir.publicNames": "仅显示公开目录名",
    "desktop.workdir.aliasPlaceholder": "别名",
    "desktop.workdir.saveAlias": "保存别名",

    // 桌面端 - 模型
    "desktop.model.consumption": "模型消耗",
    "desktop.model.tokenTotals": "按模型分组的令牌总数",

    // 桌面端 - 趋势面板
    "desktop.trend.title": "使用趋势",
    "desktop.trend.dailyReview": "每日回顾",
    "desktop.trend.weeklyReview": "每周回顾",
    "desktop.trend.monthlyReview": "每月回顾",
    "desktop.trend.groupedFromCache": "从缓存的本地使用记录分组",
    "desktop.trend.chart": "图表",
    "desktop.trend.table": "表格",
    "desktop.trend.detailEyebrow": "趋势详情",
    "desktop.trend.periodDetail": "时间段详情",
    "desktop.trend.closeDetail": "关闭趋势详情",

    // 桌面端 - 趋势表格
    "desktop.trend.period": "时间段",
    "desktop.trend.composition": "构成",
    "desktop.trend.workdirs": "工作目录",

    // 桌面端 - 设置面板
    "desktop.settings.title": "账户、来源、云端和应用",
    "desktop.settings.notConfigured": "未配置",

    // 桌面端 - 设置标签
    "desktop.settings.tab.account": "资料",
    "desktop.settings.tab.sources": "来源",
    "desktop.settings.tab.cloud": "云端",
    "desktop.settings.tab.app": "应用",
    "desktop.settings.tab.about": "关于",

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
    "desktop.sources.localDesc": "扫描本机使用记录，只上传每日汇总。",
    "desktop.sources.cursorDesc": "从 Cursor 仪表盘读取用量；令牌保留在本机。",
    "desktop.sources.alwaysEnabled": "此来源始终启用",
    "desktop.sources.toggleEnabledTitle": "已开启，点击停用",
    "desktop.sources.toggleDisabledTitle": "未开启，点击启用",
    "desktop.sources.kindAuto": "自动",
    "desktop.sources.kindManual": "手工",
    "desktop.sources.kindIgnored": "已忽略",
    "desktop.sources.ignore": "忽略",
    "desktop.sources.unignore": "恢复",
    "desktop.sources.ignoreTitle": "忽略此自动发现来源",
    "desktop.sources.removeTitle": "删除此手工来源",
    "desktop.sources.deleteBtn": "删除",
    "desktop.sources.ignoreConfirm": "忽略此来源？不会删除本地原始数据。",
    "desktop.sources.removeConfirm": "删除此来源？不会删除本地原始数据。",
    "desktop.sources.sourceIgnored": "已忽略",
    "desktop.sources.sourceRemoved": "已删除",
    "desktop.sources.sourceRestored": "已恢复",
    "desktop.sources.noCursorAccountDetected": "未检测到 Cursor 账号",
    "desktop.sources.accountSourceOne": "1 个账号来源",
    "desktop.sources.accountSources": "{count} 个账号来源",
    "desktop.sources.locationOne": "1 个位置",
    "desktop.sources.locations": "{count} 个位置",
    "desktop.sources.scanCadence": "来源扫描周期",
    "desktop.sources.scanCadenceDescription": "控制桌面端多久扫描一次本地用量来源。",
    "desktop.sources.scanCadenceTooltip": "未配置云端时只扫描本地数据源；配置云端后，扫描完成会上传每日汇总数据。",
    "desktop.sources.workdirAliases": "工作目录别名",

    // 桌面端 - 云端设置
    "desktop.cloud.title": "云端连接",
    "desktop.cloud.description": "一个应用服务器目标用于同步、定价、兼容性和更新检查",
    "desktop.cloud.apiBaseUrl": "API 基础 URL",
    "desktop.cloud.cloudStatus": "云端状态",

    // 桌面端 - 同步设置
    "desktop.sync.refreshInterval": "扫描间隔（分钟）",
    "desktop.sync.backgroundRefresh": "定时扫描",
    "desktop.sync.syncStatus": "同步状态",
    "desktop.sync.lastSync": "上次同步",
    "desktop.sync.result": "结果",
    "desktop.sync.backgroundState": "定时扫描尚未运行",

    // 桌面端 - 应用设置
    "desktop.app.title": "应用",
    "desktop.app.description": "应用语言、显示偏好和本地启动行为",
    "desktop.app.versionStatus": "版本状态",
    "desktop.app.notifyOnly": "仅通知",
    "desktop.app.notifyOnlyHint": "仅检查，不下载",
    "desktop.app.autoDownload": "自动下载",
    "desktop.app.autoDownloadHint": "下载并校验压缩包",
    "desktop.app.autoApplyIdle": "空闲时自动应用",
    "desktop.app.autoApplyIdleHint": "空闲时重启应用",
    "desktop.app.checkUpdate": "检查更新",
    "desktop.app.downloadRestart": "下载并重启",
    "desktop.app.downloadInstaller": "下载安装包",
    "desktop.app.installRestart": "重启安装",
    "desktop.app.exportDiagnostics": "导出诊断",
    "desktop.app.displayTitle": "显示偏好",
    "desktop.app.displayDescription": "控制桌面端视图里是否展示成本和原始令牌数。",
    "desktop.app.behaviorTitle": "语言和启动",
    "desktop.app.behaviorDescription": "把应用语言和启动行为放在一起，便于统一管理客户端体验。",

    // 桌面端 - 关于
    "desktop.about.title": "关于",
    "desktop.about.description": "版本状态、更新策略、诊断导出和本地数据重置。",
    "desktop.about.updatePolicy": "更新策略",
    "desktop.about.updateDescription": "选择如何检查和准备已验证的客户端更新。",
    "desktop.about.diagnosticsTitle": "诊断导出",
    "desktop.about.diagnosticsDescription": "导出运行日志和缓存用量摘要，用于本地排查。",

    // 桌面端 - 显示选项
    "desktop.display.showEstCost": "显示预估成本",
    "desktop.display.showRawTokens": "显示原始令牌数",
    "desktop.display.launchAtLogin": "登录时启动",

    // 桌面端 - 重置区域
    "desktop.reset.title": "重置本地数据",
    "desktop.reset.description": "清除此桌面配置文件、上传队列、缓存使用扫描、本地令牌、别名和设置。Codex、Claude Code 和 Cursor 源文件不会被删除。",
    "desktop.reset.button": "重置数据",
    "desktop.reset.modalTitle": "重置数据",
    "desktop.reset.modalDescription": "选择是否同时删除云端服务器上已上传的数据。Codex、Claude Code 和 Cursor 中的源文件不会被删除。",
    "desktop.reset.localOnly": "仅本地",
    "desktop.reset.localAndCloud": "本地 + 云端",
    "desktop.reset.cloudClearing": "正在清除云端数据...",
    "desktop.reset.cloudFailed": "清除云端数据失败: {error}",

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
    "desktop.wizard.firstRun": "首次运行",
    "desktop.wizard.welcomeEyebrow": "欢迎",
    "desktop.wizard.identityEyebrow": "身份",
    "desktop.wizard.sourcesEyebrow": "来源",
    "desktop.wizard.cloudEyebrow": "云端",
    "desktop.wizard.readyEyebrow": "就绪",
    "desktop.wizard.back": "返回",
    "desktop.wizard.next": "下一步",

    // 桌面端 - Cursor 令牌
    "desktop.cursorToken.description": "Cursor 凭证保留在此计算机上，不会上传。",
    "desktop.cursorToken.label": "Cursor 令牌",
    "desktop.cursorToken.save": "保存令牌",

    // 来源名称
    "source.codex": "Codex",
    "source.claude": "Claude Code",
    "source.cursor": "Cursor",

    // 平台标签
    "platform.darwinArm64": "macOS Apple Silicon",
    "platform.darwinX64": "macOS Intel",
    "platform.win32X64": "Windows x64",

    // 桌面端 - 渲染器补充
    "desktop.renderer.checkingApi": "检查 API 中...",
    "desktop.renderer.savingSettings": "保存设置...",
    "desktop.renderer.exportCanceled": "导出已取消",
    "desktop.renderer.configExported": "配置已导出",
    "desktop.renderer.found": "已发现 · {count} 个位置",
    "desktop.renderer.foundOne": "已发现 · 1 个位置",
    "desktop.renderer.notFound": "在此设备上未找到",
    "desktop.renderer.requiresToken": "需要在设置中配置 Cursor token",
    "desktop.renderer.accountSources": "{count} 个账号来源",
    "desktop.renderer.none": "无",
    "desktop.renderer.localOnly": "仅本地",
    "desktop.renderer.confirmReset": "重置此桌面配置文件、缓存使用量、别名、本地 Cursor token、同步队列和设置？Codex、Claude Code 和 Cursor 中的源文件不会被删除。",
    "desktop.renderer.resetting": "正在重置本地数据...",
    "desktop.renderer.openSettings": "打开设置开始追踪。",
    "desktop.renderer.scanningLocal": "正在扫描本地使用量。首次扫描在大型历史上可能需要较长时间。",
    "desktop.renderer.refreshingBg": "正在后台刷新。你可以继续使用应用。",
    "desktop.renderer.refreshFailed": "刷新失败: {error}",
    "desktop.renderer.refreshStatusFailed": "刷新状态失败: {error}",
    "desktop.renderer.noLocalUsage": "今天未找到本地使用量。",
    "desktop.renderer.lastScan": "上次扫描 {time}",
    "desktop.renderer.syncCanceled": "同步已取消",
    "desktop.renderer.syncing": "同步中...",
    "desktop.renderer.confirmUpload": "上传本地聚合使用量到配置的 API？\n\n目标: {url}\n行数: {rows}\n上次扫描: {scannedAt}\n\n不会上传提示词、回复、代码或真实路径。",
    "desktop.renderer.configureCloudFirst": "请先配置云连接再同步。",
    "desktop.renderer.cursorTokenRequired": "Cursor token 为必填项",
    "desktop.renderer.cursorTokenInvalid": "Cursor token 无效",
    "desktop.renderer.cursorTokenAdded": "Cursor token 已添加",
    "desktop.renderer.preparingDiag": "正在准备诊断数据...",
    "desktop.renderer.diagCanceled": "导出已取消",
    "desktop.renderer.diagExported": "已导出 {logs} 个日志事件, {rows} 行使用量",
    "desktop.renderer.client": "客户端 {version} · 协议 {protocol} · {platform}",
    "desktop.renderer.clientDash": "客户端 -",
    "desktop.renderer.latest": "最新 {version}",
    "desktop.renderer.latestDash": "最新 -",
    "desktop.renderer.lastCheck": "上次检查 {time}",
    "desktop.renderer.lastCheckDash": "上次检查 -",
    "desktop.renderer.silentUpdateDash": "静默更新 -",
    "desktop.renderer.checking": "检查中...",
    "desktop.renderer.downloading": "下载中...",
    "desktop.renderer.downloadedInstalling": "已下载并验证。正在安装更新并重启...",
    "desktop.renderer.downloadedVerified": "已下载并验证",
    "desktop.renderer.downloadedReady": "已下载，准备就绪，可重启安装",
    "desktop.renderer.configureCloudUpdate": "请先配置云连接再检查更新",
    "desktop.renderer.releaseNotConfigured": "应用服务器上未配置发布清单",
    "desktop.renderer.updateCheckFinished": "更新检查完成",
    "desktop.renderer.cloudNotConfigured": "云未配置",
    "desktop.renderer.health": "健康 {status}",
    "desktop.renderer.healthDash": "健康 -",
    "desktop.renderer.server": "服务器 {version}",
    "desktop.renderer.serverDash": "服务器 -",
    "desktop.renderer.protocol": "协议 {version} · 客户端 {min}-{max}",
    "desktop.renderer.protocolDash": "协议 -",
    "desktop.renderer.compatibility": "兼容性 {status}",
    "desktop.renderer.compatibilityDash": "兼容性 -",
    "desktop.renderer.releaseManifest": "发布清单已配置",
    "desktop.renderer.releaseManifestDash": "发布清单 -",
    "desktop.renderer.apiNotConfigured": "API 未配置",
    "desktop.renderer.apiChecked": "API 检查于 {time}",
    "desktop.renderer.lastSync": "上次同步 {time}",
    "desktop.renderer.lastSyncDash": "上次同步 -",
    "desktop.renderer.syncedRows": "已同步 {scanned} 行 ({accepted} 已接受{rejected}{queued})",
    "desktop.renderer.rejected": ", {count} 已拒绝",
    "desktop.renderer.queued": ", {count} 已排队",
    "desktop.renderer.queuedRows": "已排队 {scanned} 行{pending}",
    "desktop.renderer.pending": " ({count} 待处理)",
    "desktop.renderer.updateRequiredQueued": "需要更新; {count} 行保留在队列中",
    "desktop.renderer.serverIncompatible": "服务器不兼容; {count} 行保留在队列中",
    "desktop.renderer.syncFailed": "同步失败: {error}",
    "desktop.renderer.syncFailedSimple": "同步失败",
    "desktop.renderer.apiReachable": "API 可达; 未同步",
    "desktop.renderer.apiUnreachable": "API 不可达: {error}",
    "desktop.renderer.apiUnreachableSimple": "API 不可达",
    "desktop.renderer.notSynced": "未同步",
    "desktop.renderer.noCursorToken": "未配置 Cursor token 且未检测到本地 Cursor 账号。",
    "desktop.renderer.localCursorAccounts": "检测到 {count} 个本地 Cursor 账号",
    "desktop.renderer.localCursorAccountsOne": "检测到 1 个本地 Cursor 账号",
    "desktop.renderer.cursorTokensConfigured": "已配置 {count} 个 Cursor token",
    "desktop.renderer.cursorTokensConfiguredOne": "已配置 1 个 Cursor token",
    "desktop.renderer.localAccountDetected": "; 本地账号检测到",
    "desktop.renderer.actionFailed": "操作失败",
    "desktop.renderer.openSettingsFirst": "请先打开设置",
    "desktop.renderer.enabling": "启用中...",
    "desktop.renderer.disabling": "禁用中...",
    "desktop.renderer.enabled": "已启用; 刷新使用量以更新总数",
    "desktop.renderer.disabled": "已禁用; 刷新使用量以更新总数",
    "desktop.renderer.bgRefreshOn": "定时扫描开启",
    "desktop.renderer.bgRefreshOff": "定时扫描关闭",
    "desktop.renderer.autoUpload": "已自动上传",
    "desktop.renderer.localOnlyMode": "仅本地",
    "desktop.renderer.next": "下次 {time}",
    "desktop.renderer.error": "错误: {error}",
    "desktop.renderer.silentUpdate": "静默更新 {parts}",
    "desktop.renderer.notifyOnly": "仅通知",
    "desktop.renderer.autoDownload": "自动下载",
    "desktop.renderer.autoApplyIdle": "空闲时自动应用",
    "desktop.renderer.ready": "就绪 {version}",
    "desktop.renderer.noWorkdirs": "本地使用量中未找到工作目录。",
    "desktop.renderer.noModelUsage": "今天无模型使用量。",
    "desktop.renderer.noWorkdirUsage": "今天无工作目录使用量。",
    "desktop.renderer.noLocalUsageFound": "未找到本地使用量。",
    "desktop.renderer.peak": "峰值",
    "desktop.renderer.latestLabel": "最新",
    "desktop.renderer.viewTotal": "视图总计",
    "desktop.renderer.cost": "成本",
    "desktop.renderer.dominant": "主导",
    "desktop.renderer.recentContribution": "最近贡献",
    "desktop.renderer.topModels": "主要模型",
    "desktop.renderer.topWorkdirs": "主要工作目录",
    "desktop.renderer.modelDetail": "模型详情",
    "desktop.renderer.groupedBy": "按此时间段的工作目录和模型分组。",
    "desktop.renderer.dayBucket": "天桶",
    "desktop.renderer.weekBucket": "周桶",
    "desktop.renderer.monthBucket": "月桶",
    "desktop.renderer.last30Days": "最近 30 天",
    "desktop.renderer.last12Weeks": "最近 12 周",
    "desktop.renderer.last12Months": "最近 12 个月",
    "desktop.renderer.noComposition": "无构成",

    // 通用状态
    "status.on": "开启",
    "status.off": "关闭",

    // Admin 面板 - 通用
    "admin.workbench": "管理工作台",
    "admin.usageOps": "使用量运营",
    "admin.usageOpsDesc": "已上传的使用量、定价覆盖、质量诊断和参与者详情。",
    "admin.costStatus": "成本状态",
    "admin.estimatedMissing": "预估 + 缺失价格",
    "admin.costStatusNote": "精确、预估和缺失价格行在管理端和公开视图中使用相同标签。",
    "admin.authRequired": "需要登录。请刷新页面并在浏览器提示时输入凭据。",
    "admin.loading": "加载中...",
    "admin.saving": "保存中...",
    "admin.deleting": "删除中...",
    "admin.deletingAlias": "删除别名中...",
    "admin.mappingAlias": "映射价格别名中...",
    "admin.refreshing": "刷新 OpenRouter...",
    "admin.refreshingRecalc": "刷新并重新计算...",

    // Admin - Tabs
    "admin.tab.usage": "使用量排名",
    "admin.tab.pricing": "模型价格",
    "admin.tab.quality": "质量",
    "admin.tab.devices": "设备",

    // Admin - Usage panel
    "admin.usage.thisMonth": "本月",
    "admin.usage.allUsers": "所有用户",
    "admin.usage.apply": "应用",
    "admin.usage.rawTokens": "原始令牌",
    "admin.usage.estCost": "预估成本",
    "admin.usage.aggregates": "使用量聚合",
    "admin.usage.period": "时间段",
    "admin.usage.user": "用户",
    "admin.usage.totalTokens": "总令牌数",
    "admin.usage.costQuality": "成本质量",
    "admin.usage.topWorkdir": "主要工作目录",
    "admin.usage.topModel": "主要模型",
    "admin.usage.action": "操作",
    "admin.usage.noUsage": "该查询无使用量上传。",
    "admin.usage.rows": "{count} 条聚合行 · {from} 至 {to}",
    "admin.usage.expandRow": "展开行",
    "admin.usage.collapseRow": "收起行",
    "admin.usage.resetUser": "重置用户",
    "admin.usage.deleteConfirm": "删除 {label} 所有已上传的服务器数据？\n\n用户客户端需要重新同步才能重新上传聚合数据。",
    "admin.usage.deletingUser": "删除 {label} 中...",
    "admin.usage.deleted": "已删除 {label}: {usage} 行使用量, {batches} 个上传批次。",
    "admin.usage.noData": "未找到 {label} 的服务器数据。",
    "admin.usage.today": "今天",
    "admin.usage.last7": "最近 7 天",
    "admin.usage.last30": "最近 30 天",
    "admin.usage.lastMonth": "上月",
    "admin.usage.mtd": "本月至今",
    "admin.usage.grainAuto": "自动",
    "admin.usage.grainDay": "日",
    "admin.usage.grainWeek": "周",
    "admin.usage.grainMonth": "月",
    "admin.usage.grainLabel": "{label} · {grain}",

    // Admin - Detail panel
    "admin.detail.selectNickname": "选择一个昵称",
    "admin.detail.grain": "粒度",
    "admin.detail.rawRows": "原始行",
    "admin.detail.tokenComposition": "令牌构成",
    "admin.detail.workdirConsumption": "工作目录消耗",
    "admin.detail.dailyTrend": "每日趋势",
    "admin.detail.day": "日期",
    "admin.detail.workdir": "工作目录",
    "admin.detail.model": "模型",
    "admin.detail.tokens": "令牌",
    "admin.detail.input": "输入",
    "admin.detail.output": "输出",
    "admin.detail.cache": "缓存",
    "admin.detail.cacheRead": "缓存读取",
    "admin.detail.cacheWrite": "缓存写入",
    "admin.detail.reasoning": "推理",
    "admin.detail.estCost": "预估成本",
    "admin.detail.priceQuality": "价格质量",
    "admin.detail.quality": "质量",
    "admin.detail.total": "总计",
    "admin.detail.composition": "构成",
    "admin.detail.workdirs": "工作目录",
    "admin.detail.models": "模型",
    "admin.detail.compositionDetail": "构成详情",
    "admin.detail.topSlices": "主要切片",
    "admin.detail.modelsLabel": "模型 ·",
    "admin.detail.workdirsLabel": "工作目录 ·",
    "admin.detail.sourcesLabel": "来源 ·",
    "admin.detail.pricingLabel": "定价 ·",
    "admin.detail.sourceQuality": "来源质量 ·",

    // Admin - Pricing panel
    "admin.pricing.title": "模型定价",
    "admin.pricing.refreshOpenRouter": "刷新 OpenRouter",
    "admin.pricing.refreshRecalculate": "刷新 + 重新计算",
    "admin.pricing.remoteNotLoaded": "远程定价未加载。",
    "admin.pricing.modelPlaceholder": "模型, 如 gpt-5",
    "admin.pricing.inputPlaceholder": "输入 $/1M",
    "admin.pricing.outputPlaceholder": "输出 $/1M",
    "admin.pricing.cacheReadPlaceholder": "缓存读取 $/1M",
    "admin.pricing.cacheWritePlaceholder": "缓存写入 $/1M",
    "admin.pricing.savePrice": "保存价格",
    "admin.pricing.missingPriceTasks": "缺失价格任务",
    "admin.pricing.customPrices": "自定义价格",
    "admin.pricing.modelAliases": "模型别名",
    "admin.pricing.openRouterCache": "OpenRouter 缓存",
    "admin.pricing.missingModels": "{missing} 个缺失模型 · {aliases} 个别名 · {custom} 个自定义价格 · {openrouter} 个 OpenRouter 价格",
    "admin.pricing.noMissing": "本月无缺失价格。",
    "admin.pricing.noCustom": "暂无自定义模型价格。",
    "admin.pricing.noAliases": "暂无模型别名。",
    "admin.pricing.noOpenRouter": "暂无 OpenRouter 缓存价格。",
    "admin.pricing.noSourceBreakdown": "无来源明细",
    "admin.pricing.mapToExisting": "映射到已有定价模型",
    "admin.pricing.map": "映射",
    "admin.pricing.delete": "删除",
    "admin.pricing.targetRequired": "目标模型为必填项",
    "admin.pricing.openrouterStatus": "OpenRouter {status}",
    "admin.pricing.openrouterDetail": "{count} 个模型 · 获取于 {fetched} · 过期于 {expires}",
    "admin.pricing.priceLine": "输入 {input} · 输出 {output} · 缓存读取 {cacheRead}",
    "admin.pricing.aliasUses": "使用 {target}",

    // Admin - Quality panel
    "admin.quality.title": "质量和可解释性",
    "admin.quality.rows": "行",
    "admin.quality.tokens": "令牌",
    "admin.quality.composition": "构成",
    "admin.quality.missingPrice": "缺失价格",
    "admin.quality.anomalies": "构成异常",
    "admin.quality.pricingCoverage": "定价覆盖",
    "admin.quality.missingByParticipant": "按参与者统计缺失价格",
    "admin.quality.costExplainability": "成本可解释性",
    "admin.quality.noAnomaly": "该范围内未检测到构成异常。",
    "admin.quality.noParticipant": "无参与者受缺失定价影响。",
    "admin.quality.noExplainability": "无可解释性数据。",
    "admin.quality.knownPrice": "已知价格",
    "admin.quality.missingPriceLabel": "缺失价格",
    "admin.quality.inputHeavy": "输入密集行",
    "admin.quality.outputHeavy": "输出密集行",
    "admin.quality.cacheHeavy": "缓存密集行",
    "admin.quality.reasoningHeavy": "推理密集行",
    "admin.quality.unclassified": "未分类行",
    "admin.quality.ofRows": "共 {total} 行中的 {shown} 行 · {tokens}",
    "admin.quality.status": "{from} 至 {to} · {rows} 行",
    "admin.quality.explainabilityRows": "{count} 行",

    // Admin - Cost labels
    "admin.cost.exactPrice": "精确价格",
    "admin.cost.estimatedPrice": "预估价格",
    "admin.cost.unknownPrice": "缺失价格",
    "admin.cost.noPricingVersion": "无定价版本",
    "admin.cost.missingModels": "缺失",
    "admin.cost.missingModelPrices": "部分模型价格缺失",

    // Admin - Quality labels
    "admin.quality.exactField": "完整字段",
    "admin.quality.partialField": "部分字段",
    "admin.quality.exactDesc": "工具日志提供了明确 token 字段",
    "admin.quality.partialDesc": "部分 token 字段缺失或只能按可用 usage 字段统计",

    // Admin - Devices panel
    "admin.devices.title": "客户端设备",
    "admin.devices.nickname": "昵称",
    "admin.devices.device": "设备",
    "admin.devices.lanIp": "局域网 IP",
    "admin.devices.clientVersion": "客户端版本",
    "admin.devices.platform": "平台",
    "admin.devices.build": "构建",
    "admin.devices.lastSeen": "最后在线",
    "admin.devices.empty": "暂无注册设备。",
    "admin.devices.count": "{count} 台设备",
    "admin.devices.countOne": "1 台设备"
  },

  "en": {
    // Common
    "app.name": "AI Token League",
    "app.tagline": "AI Coding Token Usage Leaderboard",
    "loading": "Loading...",
    "cancel": "Cancel",
    "close": "Close",
    "refresh": "Refresh",
    "language.zh": "中文",
    "language.en": "English",
    "unit.tokens": "tokens",
    "common.dateRange": "{from} to {to}",
    "common.cost": "cost",
    "common.total": "Total",
    "common.peak": "Peak",

    // Web - Navigation and Headers
    "web.publicBoard": "Public community board",
    "web.rankingMetric": "Ranking metric",
    "web.totalTokens": "Total tokens",
    "web.modelTotalsContext": "Model totals are shown for context",
    "web.checkingRelease": "Checking latest release...",
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
    "web.leaderboard.participantCount": "{count} ranked participant{plural}",
    "web.leaderboard.anonymousTitle": "Anonymous public board",
    "web.leaderboard.anonymousDesc": "Names are generated aliases. Real nicknames are not shown.",
    "web.leaderboard.colNickname": "Nickname",
    "web.leaderboard.colAlias": "Alias",
    "web.leaderboard.aliasMark": "Alias",
    "web.leaderboard.aliasRotatesDaily": "Generated alias · rotates daily",

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
    "web.detail.cacheRead": "Cache read",
    "web.detail.cacheWrite": "Cache write",
    "web.detail.reasoning": "Reasoning",
    "web.detail.priceQuality": "Price quality",
    "web.detail.noUsagePeriod": "No usage in this period",

    // Web - Composition Summary
    "web.composition.inputHeavy": "Input-heavy",
    "web.composition.outputHeavy": "Output-heavy",
    "web.composition.cacheHeavy": "Cache-heavy",
    "web.composition.reasoningHeavy": "Reasoning-heavy",
    "web.composition.noUsage": "No usage",

    // Web - Detail supplement
    "web.detail.periodDetailLabel": "leaderboard period detail",
    "web.detail.loadingHistory": "Loading history...",
    "web.detail.historyWindow": "history window",
    "web.detail.singleDayNote": "Single-day leaderboard periods are explained by composition, not a trend chart.",
    "web.detail.noUsagePeriod": "No usage in this period.",
    "web.detail.noUsageHistory": "No usage in this history window.",
    "web.detail.noUsageSlice": "No usage in this slice.",
    "web.detail.topDate": "Top date contribution",
    "web.detail.topPeriod": "Top period contribution",
    "web.detail.historyBuckets": "History buckets",
    "web.detail.windowTokens": "Window tokens",
    "web.detail.peakPeriod": "Peak period",
    "web.detail.windowCost": "Window cost",
    "web.detail.dailyHistory": "Daily history",
    "web.detail.weeklyHistory": "Weekly history",
    "web.detail.monthlyHistory": "Monthly history",
    "web.detail.participant": "Participant",
    "web.detail.periodTokens": "Period tokens",
    "web.detail.dominant": "Dominant",
    "web.detail.rank": "Rank",

    // Web - Download Panel
    "web.download.latest": "Latest",
    "web.download.downloadBtn": "Download",
    "web.releaseMetadata": "Release metadata loading",
    "web.download.notConfigured": "Client downloads are not configured on this app server",
    "web.download.pageTitle": "Download the desktop client",
    "web.download.selectPlatform": "Select your platform and download",
    "web.download.recommended": "Recommended",
    "web.download.winDesc": "For Windows 10 / 11",
    "web.download.macArmDesc": "Apple Silicon (M1 and later)",
    "web.download.macIntelDesc": "Intel processor (pre-2020)",

    // Web - Landing page
    "web.landing.features": "Features",
    "web.landing.featureLocalTitle": "Local-first",
    "web.landing.featureLocalDesc": "Data stays on your device",
    "web.landing.featureMultiTitle": "Multi-source",
    "web.landing.featureMultiDesc": "Claude Code / Codex / Cursor",
    "web.landing.featureBoardTitle": "Community leaderboard",
    "web.landing.featureBoardDesc": "Anonymous token usage ranking",
    "web.landing.viewLeaderboard": "View community leaderboard",
    "web.landing.participants": "Participants",
    "web.landing.todayTokens": "Today's tokens",
    "web.landing.weekTokens": "This week's tokens",
    "web.landing.monthTokens": "This month's tokens",
    "web.landing.lastMonthTokens": "Last month's tokens",
    "web.landing.serverVersion": "Server version",
    "web.landing.compatibility": "Compatibility",
    "web.landing.compatible": "Compatible",
    "web.landing.incompatible": "Incompatible",

    // Web - Cost Related
    "web.cost.exactPrice": "exact_price",
    "web.cost.estimatedPrice": "estimated_price",
    "web.cost.unknownPrice": "unknown_price",
    "web.cost.noPricingVersion": "no pricing version",
    "web.cost.missingModels": "missing",
    "web.cost.missingModelPrices": "Some model prices are missing",

    // Desktop - Navigation
    "desktop.nav.today": "Today",
    "desktop.nav.trend": "Trend",
    "desktop.nav.settings": "Settings",
    "desktop.nav.syncNow": "Sync now",

    // Desktop - Sync Status
    "desktop.sync.notSynced": "Not synced",
    "desktop.sync.settingsSaved": "Settings saved",
    "desktop.sync.settingsSavedNextCycle": "Settings saved. Scan or update policy changes take effect on the next cycle.",
    "desktop.sync.unsavedChanges": "Unsaved changes",
    "desktop.sync.unsavedApiBaseUrl": "API base URL has unsaved changes. Continue with the saved URL?",
    "desktop.sync.profileReady": "Profile ready",
    "desktop.sync.apiNotConfigured": "API not configured",

    // Desktop - Today Panel
    "desktop.today.title": "Today",
    "desktop.today.scanning": "Scanning local usage...",
    "desktop.today.lastScan": "Last scan",
    "desktop.today.workdirs": "Workdirs",
    "desktop.today.models": "Models",
    "desktop.today.dominant": "Dominant composition",
    "desktop.today.estCost": "Est. cost",
    "desktop.today.pricingUnavailable": "pricing unavailable",

    // Desktop - Token Composition
    "desktop.composition.tokenComposition": "Token composition",
    "desktop.composition.todayLoading": "Today composition is loading",

    // Desktop - Workdirs
    "desktop.workdir.consumption": "Workdir consumption",
    "desktop.workdir.publicNames": "Only public directory names are shown",
    "desktop.workdir.aliasPlaceholder": "Alias",
    "desktop.workdir.saveAlias": "Save alias",

    // Desktop - Models
    "desktop.model.consumption": "Model consumption",
    "desktop.model.tokenTotals": "Token totals grouped by model",

    // Desktop - Trend Panel
    "desktop.trend.title": "Usage rhythm",
    "desktop.trend.dailyReview": "Daily review",
    "desktop.trend.weeklyReview": "Weekly review",
    "desktop.trend.monthlyReview": "Monthly review",
    "desktop.trend.groupedFromCache": "Grouped from cached local usage rows",
    "desktop.trend.chart": "Chart",
    "desktop.trend.table": "Table",
    "desktop.trend.detailEyebrow": "Trend detail",
    "desktop.trend.periodDetail": "Period detail",
    "desktop.trend.closeDetail": "Close trend detail",

    // Desktop - Trend Table
    "desktop.trend.period": "Period",
    "desktop.trend.composition": "Composition",
    "desktop.trend.workdirs": "Workdirs",

    // Desktop - Settings Panel
    "desktop.settings.title": "Profile, sources, cloud, and app",
    "desktop.settings.notConfigured": "Not configured",

    // Desktop - Settings Tabs
    "desktop.settings.tab.account": "Profile",
    "desktop.settings.tab.sources": "Sources",
    "desktop.settings.tab.cloud": "Cloud",
    "desktop.settings.tab.app": "App",
    "desktop.settings.tab.about": "About",

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
    "desktop.sources.localDesc": "Scans local usage records and uploads only daily aggregates.",
    "desktop.sources.cursorDesc": "Reads usage from the Cursor dashboard; tokens stay on this computer.",
    "desktop.sources.alwaysEnabled": "Always enabled",
    "desktop.sources.toggleEnabledTitle": "Enabled. Click to disable.",
    "desktop.sources.toggleDisabledTitle": "Disabled. Click to enable.",
    "desktop.sources.kindAuto": "Auto",
    "desktop.sources.kindManual": "Manual",
    "desktop.sources.kindIgnored": "Ignored",
    "desktop.sources.ignore": "Ignore",
    "desktop.sources.unignore": "Restore",
    "desktop.sources.ignoreTitle": "Ignore this auto-detected source",
    "desktop.sources.removeTitle": "Remove this manual source",
    "desktop.sources.deleteBtn": "Remove",
    "desktop.sources.ignoreConfirm": "Ignore this source? Local data will not be deleted.",
    "desktop.sources.removeConfirm": "Remove this source? Local data will not be deleted.",
    "desktop.sources.sourceIgnored": "Ignored",
    "desktop.sources.sourceRemoved": "Removed",
    "desktop.sources.sourceRestored": "Restored",
    "desktop.sources.noCursorAccountDetected": "No Cursor account detected",
    "desktop.sources.accountSourceOne": "1 account source",
    "desktop.sources.accountSources": "{count} account sources",
    "desktop.sources.locationOne": "1 location",
    "desktop.sources.locations": "{count} locations",
    "desktop.sources.scanCadence": "Source scan cadence",
    "desktop.sources.scanCadenceDescription": "Control how often the desktop scans local usage sources.",
    "desktop.sources.scanCadenceTooltip": "Without cloud configured, this only scans local sources. With cloud configured, each scan also uploads daily aggregates.",
    "desktop.sources.workdirAliases": "Workdir aliases",

    // Desktop - Cloud Settings
    "desktop.cloud.title": "Cloud connection",
    "desktop.cloud.description": "One app-server target is used by sync, pricing, compatibility, and update checks",
    "desktop.cloud.apiBaseUrl": "API base URL",
    "desktop.cloud.cloudStatus": "Cloud status",

    // Desktop - Sync Settings
    "desktop.sync.refreshInterval": "Scan interval (minutes)",
    "desktop.sync.backgroundRefresh": "Scheduled scan",
    "desktop.sync.syncStatus": "Sync status",
    "desktop.sync.lastSync": "Last sync",
    "desktop.sync.result": "Result",
    "desktop.sync.backgroundState": "Scheduled scan has not run yet",

    // Desktop - App Settings
    "desktop.app.title": "App",
    "desktop.app.description": "Application language, display preferences, and local startup behavior",
    "desktop.app.versionStatus": "Version status",
    "desktop.app.notifyOnly": "Notify only",
    "desktop.app.notifyOnlyHint": "Check only",
    "desktop.app.autoDownload": "Auto-download",
    "desktop.app.autoDownloadHint": "Download verified zip",
    "desktop.app.autoApplyIdle": "Auto-apply when idle",
    "desktop.app.autoApplyIdleHint": "Restart when idle",
    "desktop.app.checkUpdate": "Check update",
    "desktop.app.downloadRestart": "Download and restart",
    "desktop.app.downloadInstaller": "Download installer",
    "desktop.app.installRestart": "Restart to install",
    "desktop.app.exportDiagnostics": "Export diagnostics",
    "desktop.app.displayTitle": "Display",
    "desktop.app.displayDescription": "Control whether desktop views show cost and raw token numbers.",
    "desktop.app.behaviorTitle": "Language and startup",
    "desktop.app.behaviorDescription": "Keep application language and startup behavior close to the client controls they affect.",

    // Desktop - About
    "desktop.about.title": "About",
    "desktop.about.description": "Version status, update policy, diagnostics export, and local data reset.",
    "desktop.about.updatePolicy": "Update policy",
    "desktop.about.updateDescription": "Choose how verified client updates are checked and prepared.",
    "desktop.about.diagnosticsTitle": "Diagnostics export",
    "desktop.about.diagnosticsDescription": "Export runtime logs and cached usage summary for local troubleshooting.",

    // Desktop - Display Options
    "desktop.display.showEstCost": "Show estimated cost",
    "desktop.display.showRawTokens": "Show raw token numbers",
    "desktop.display.launchAtLogin": "Launch at login",

    // Desktop - Reset Zone
    "desktop.reset.title": "Reset local data",
    "desktop.reset.description": "Clears this desktop profile, upload queue, cached usage scan, local tokens, aliases, and settings. Codex, Claude Code, and Cursor source files are not deleted.",
    "desktop.reset.button": "Reset data",
    "desktop.reset.modalTitle": "Reset data",
    "desktop.reset.modalDescription": "Choose whether to also delete your uploaded data from the cloud server. Source files in Codex, Claude Code, and Cursor are never deleted.",
    "desktop.reset.localOnly": "Local only",
    "desktop.reset.localAndCloud": "Local + Cloud",
    "desktop.reset.cloudClearing": "Clearing cloud data...",
    "desktop.reset.cloudFailed": "Failed to clear cloud data: {error}",

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
    "desktop.wizard.firstRun": "First run",
    "desktop.wizard.welcomeEyebrow": "Welcome",
    "desktop.wizard.identityEyebrow": "Identity",
    "desktop.wizard.sourcesEyebrow": "Sources",
    "desktop.wizard.cloudEyebrow": "Cloud",
    "desktop.wizard.readyEyebrow": "Ready",
    "desktop.wizard.back": "Back",
    "desktop.wizard.next": "Next",

    // Desktop - Cursor Token
    "desktop.cursorToken.description": "Cursor credentials stay on this computer and are never uploaded.",
    "desktop.cursorToken.label": "Cursor token",
    "desktop.cursorToken.save": "Save token",

    // Source Names
    "source.codex": "Codex",
    "source.claude": "Claude Code",
    "source.cursor": "Cursor",

    // Platform Labels
    "platform.darwinArm64": "macOS Apple silicon",
    "platform.darwinX64": "macOS Intel",
    "platform.win32X64": "Windows x64",

    // Desktop - Renderer supplement
    "desktop.renderer.checkingApi": "Checking API...",
    "desktop.renderer.savingSettings": "Saving settings...",
    "desktop.renderer.exportCanceled": "Export canceled",
    "desktop.renderer.configExported": "Config exported",
    "desktop.renderer.found": "Found · {count} locations",
    "desktop.renderer.foundOne": "Found · 1 location",
    "desktop.renderer.notFound": "Not found on this machine",
    "desktop.renderer.requiresToken": "Requires Cursor token in Settings",
    "desktop.renderer.accountSources": "{count} account sources",
    "desktop.renderer.none": "None",
    "desktop.renderer.localOnly": "Local only",
    "desktop.renderer.confirmReset": "Reset this desktop profile, cached usage, aliases, local Cursor tokens, sync queue, and settings? Source files in Codex, Claude Code, and Cursor are not deleted.",
    "desktop.renderer.resetting": "Resetting local data...",
    "desktop.renderer.openSettings": "Open Settings to start tracking.",
    "desktop.renderer.scanningLocal": "Scanning local usage. First scan can take a while on large histories.",
    "desktop.renderer.refreshingBg": "Refreshing in background. You can keep using the app.",
    "desktop.renderer.refreshFailed": "Refresh failed: {error}",
    "desktop.renderer.refreshStatusFailed": "Refresh status failed: {error}",
    "desktop.renderer.noLocalUsage": "No local usage found for today.",
    "desktop.renderer.lastScan": "Last scan {time}",
    "desktop.renderer.syncCanceled": "Sync canceled",
    "desktop.renderer.syncing": "Syncing...",
    "desktop.renderer.confirmUpload": "Upload local aggregate usage to the configured API?\n\nTarget: {url}\nRows: {rows}\nLast scan: {scannedAt}\n\nNo prompts, responses, code, or real paths are uploaded.",
    "desktop.renderer.configureCloudFirst": "Configure Cloud Connection before syncing.",
    "desktop.renderer.cursorTokenRequired": "Cursor token is required",
    "desktop.renderer.cursorTokenInvalid": "Cursor token is invalid",
    "desktop.renderer.cursorTokenAdded": "Cursor token added",
    "desktop.renderer.preparingDiag": "Preparing diagnostics...",
    "desktop.renderer.diagCanceled": "Export canceled",
    "desktop.renderer.diagExported": "Exported {logs} log events, {rows} usage rows",
    "desktop.renderer.client": "Client {version} · protocol {protocol} · {platform}",
    "desktop.renderer.clientDash": "Client -",
    "desktop.renderer.latest": "Latest {version}",
    "desktop.renderer.latestDash": "Latest -",
    "desktop.renderer.lastCheck": "Last check {time}",
    "desktop.renderer.lastCheckDash": "Last check -",
    "desktop.renderer.silentUpdateDash": "Silent update -",
    "desktop.renderer.checking": "Checking...",
    "desktop.renderer.downloading": "Downloading...",
    "desktop.renderer.downloadedInstalling": "Downloaded and verified. Installing update and restarting...",
    "desktop.renderer.downloadedVerified": "Downloaded and verified",
    "desktop.renderer.downloadedReady": "Downloaded and ready. Restart to install",
    "desktop.renderer.configureCloudUpdate": "Configure Cloud Connection before checking updates",
    "desktop.renderer.releaseNotConfigured": "Release manifest is not configured on the app server",
    "desktop.renderer.updateCheckFinished": "Update check finished",
    "desktop.renderer.cloudNotConfigured": "Cloud not configured",
    "desktop.renderer.health": "Health {status}",
    "desktop.renderer.healthDash": "Health -",
    "desktop.renderer.server": "Server {version}",
    "desktop.renderer.serverDash": "Server -",
    "desktop.renderer.protocol": "Protocol {version} · clients {min}-{max}",
    "desktop.renderer.protocolDash": "Protocol -",
    "desktop.renderer.compatibility": "Compatibility {status}",
    "desktop.renderer.compatibilityDash": "Compatibility -",
    "desktop.renderer.releaseManifest": "Release manifest configured",
    "desktop.renderer.releaseManifestDash": "Release manifest -",
    "desktop.renderer.apiNotConfigured": "API not configured",
    "desktop.renderer.apiChecked": "API checked {time}",
    "desktop.renderer.lastSync": "Last sync {time}",
    "desktop.renderer.lastSyncDash": "Last sync -",
    "desktop.renderer.syncedRows": "Synced {scanned} rows ({accepted} accepted{rejected}{queued})",
    "desktop.renderer.rejected": ", {count} rejected",
    "desktop.renderer.queued": ", {count} queued",
    "desktop.renderer.queuedRows": "Queued {scanned} rows{pending}",
    "desktop.renderer.pending": " ({count} pending)",
    "desktop.renderer.updateRequiredQueued": "Update required; {count} rows kept in queue",
    "desktop.renderer.serverIncompatible": "Server is not compatible; {count} rows kept in queue",
    "desktop.renderer.syncFailed": "Sync failed: {error}",
    "desktop.renderer.syncFailedSimple": "Sync failed",
    "desktop.renderer.apiReachable": "API reachable; not synced",
    "desktop.renderer.apiUnreachable": "API unreachable: {error}",
    "desktop.renderer.apiUnreachableSimple": "API unreachable",
    "desktop.renderer.notSynced": "Not synced",
    "desktop.renderer.noCursorToken": "No Cursor token configured and no local Cursor account detected.",
    "desktop.renderer.localCursorAccounts": "Detected {count} local Cursor accounts",
    "desktop.renderer.localCursorAccountsOne": "Detected 1 local Cursor account",
    "desktop.renderer.cursorTokensConfigured": "{count} Cursor tokens configured",
    "desktop.renderer.cursorTokensConfiguredOne": "1 Cursor token configured",
    "desktop.renderer.localAccountDetected": "; local account detected",
    "desktop.renderer.actionFailed": "Action failed",
    "desktop.renderer.openSettingsFirst": "Open Settings first",
    "desktop.renderer.enabling": "enabling...",
    "desktop.renderer.disabling": "disabling...",
    "desktop.renderer.enabled": "enabled; refresh usage to update totals",
    "desktop.renderer.disabled": "disabled; refresh usage to update totals",
    "desktop.renderer.bgRefreshOn": "Scheduled scan on",
    "desktop.renderer.bgRefreshOff": "Scheduled scan off",
    "desktop.renderer.autoUpload": "auto uploaded",
    "desktop.renderer.localOnlyMode": "local only",
    "desktop.renderer.next": "next {time}",
    "desktop.renderer.error": "error: {error}",
    "desktop.renderer.silentUpdate": "Silent update {parts}",
    "desktop.renderer.notifyOnly": "Notify only",
    "desktop.renderer.autoDownload": "Auto-download",
    "desktop.renderer.autoApplyIdle": "Auto-apply when idle",
    "desktop.renderer.ready": "ready {version}",
    "desktop.renderer.noWorkdirs": "No workdirs found in local usage.",
    "desktop.renderer.noModelUsage": "No model usage today.",
    "desktop.renderer.noWorkdirUsage": "No workdir usage today.",
    "desktop.renderer.noLocalUsageFound": "No local usage found.",
    "desktop.renderer.peak": "Peak",
    "desktop.renderer.latestLabel": "Latest",
    "desktop.renderer.viewTotal": "View total",
    "desktop.renderer.cost": "Cost",
    "desktop.renderer.dominant": "Dominant",
    "desktop.renderer.recentContribution": "Recent contribution",
    "desktop.renderer.topModels": "Top models",
    "desktop.renderer.topWorkdirs": "Top workdirs",
    "desktop.renderer.modelDetail": "Model detail",
    "desktop.renderer.groupedBy": "Grouped by workdir and model for this period.",
    "desktop.renderer.dayBucket": "day bucket",
    "desktop.renderer.weekBucket": "week bucket",
    "desktop.renderer.monthBucket": "month bucket",
    "desktop.renderer.last30Days": "last 30 days",
    "desktop.renderer.last12Weeks": "last 12 weeks",
    "desktop.renderer.last12Months": "last 12 months",
    "desktop.renderer.noComposition": "No composition",

    // Common Status
    "status.on": "On",
    "status.off": "Off",

    // Admin - General
    "admin.workbench": "Admin workbench",
    "admin.usageOps": "Usage operations",
    "admin.usageOpsDesc": "Uploaded usage, pricing coverage, quality diagnostics, and participant detail.",
    "admin.costStatus": "Cost status",
    "admin.estimatedMissing": "Estimated + missing price",
    "admin.costStatusNote": "Exact, estimated, and missing-price rows use the same labels across Admin and public views.",
    "admin.authRequired": "Admin access requires login. Refresh the page and enter your credentials when the browser prompts you.",
    "admin.loading": "Loading...",
    "admin.saving": "Saving...",
    "admin.deleting": "Deleting...",
    "admin.deletingAlias": "Deleting alias...",
    "admin.mappingAlias": "Mapping price alias...",
    "admin.refreshing": "Refreshing OpenRouter...",
    "admin.refreshingRecalc": "Refreshing and recalculating...",

    // Admin - Tabs
    "admin.tab.usage": "Usage ranking",
    "admin.tab.pricing": "Model prices",
    "admin.tab.quality": "Quality",
    "admin.tab.devices": "Devices",

    // Admin - Usage panel
    "admin.usage.thisMonth": "This month",
    "admin.usage.allUsers": "All users",
    "admin.usage.apply": "Apply",
    "admin.usage.rawTokens": "Raw tokens",
    "admin.usage.estCost": "Estimated cost",
    "admin.usage.aggregates": "Usage aggregates",
    "admin.usage.period": "Period",
    "admin.usage.user": "User",
    "admin.usage.totalTokens": "Total tokens",
    "admin.usage.costQuality": "Cost quality",
    "admin.usage.topWorkdir": "Top workdir",
    "admin.usage.topModel": "Top model",
    "admin.usage.action": "Action",
    "admin.usage.noUsage": "No usage uploaded for this query.",
    "admin.usage.rows": "{count} aggregate row{plural} · {from} to {to}",
    "admin.usage.expandRow": "Expand row",
    "admin.usage.collapseRow": "Collapse row",
    "admin.usage.resetUser": "Reset user",
    "admin.usage.deleteConfirm": "Delete all uploaded server data for {label}?\n\nThe user's client must sync again to re-upload fresh aggregate data.",
    "admin.usage.deletingUser": "Deleting {label}...",
    "admin.usage.deleted": "Deleted {label}: {usage} usage rows, {batches} upload batches.",
    "admin.usage.noData": "No server data found for {label}.",
    "admin.usage.today": "Today",
    "admin.usage.last7": "Last 7 days",
    "admin.usage.last30": "Last 30 days",
    "admin.usage.lastMonth": "Last month",
    "admin.usage.mtd": "MTD",
    "admin.usage.grainAuto": "Auto",
    "admin.usage.grainDay": "Day",
    "admin.usage.grainWeek": "Week",
    "admin.usage.grainMonth": "Month",
    "admin.usage.grainLabel": "{label} · {grain}",

    // Admin - Detail panel
    "admin.detail.selectNickname": "Select a nickname",
    "admin.detail.grain": "grain",
    "admin.detail.rawRows": "raw rows",
    "admin.detail.tokenComposition": "Token composition",
    "admin.detail.workdirConsumption": "Workdir Consumption",
    "admin.detail.dailyTrend": "Daily Trend",
    "admin.detail.day": "Day",
    "admin.detail.workdir": "Workdir",
    "admin.detail.model": "Model",
    "admin.detail.tokens": "Tokens",
    "admin.detail.input": "Input",
    "admin.detail.output": "Output",
    "admin.detail.cache": "Cache",
    "admin.detail.cacheRead": "Cache read",
    "admin.detail.cacheWrite": "Cache write",
    "admin.detail.reasoning": "Reasoning",
    "admin.detail.estCost": "Est. cost",
    "admin.detail.priceQuality": "Price quality",
    "admin.detail.quality": "Quality",
    "admin.detail.total": "Total",
    "admin.detail.composition": "Composition",
    "admin.detail.workdirs": "Workdirs",
    "admin.detail.models": "Models",
    "admin.detail.compositionDetail": "Composition detail",
    "admin.detail.topSlices": "Top slices",
    "admin.detail.modelsLabel": "Models ·",
    "admin.detail.workdirsLabel": "Workdirs ·",
    "admin.detail.sourcesLabel": "Sources ·",
    "admin.detail.pricingLabel": "Pricing ·",
    "admin.detail.sourceQuality": "Source quality ·",

    // Admin - Pricing panel
    "admin.pricing.title": "Model pricing",
    "admin.pricing.refreshOpenRouter": "Refresh OpenRouter",
    "admin.pricing.refreshRecalculate": "Refresh + recalculate",
    "admin.pricing.remoteNotLoaded": "Remote pricing not loaded.",
    "admin.pricing.modelPlaceholder": "model, e.g. gpt-5",
    "admin.pricing.inputPlaceholder": "Input $/1M",
    "admin.pricing.outputPlaceholder": "Output $/1M",
    "admin.pricing.cacheReadPlaceholder": "Cache read $/1M",
    "admin.pricing.cacheWritePlaceholder": "Cache write $/1M",
    "admin.pricing.savePrice": "Save price",
    "admin.pricing.missingPriceTasks": "Missing price tasks",
    "admin.pricing.customPrices": "Custom prices",
    "admin.pricing.modelAliases": "Model aliases",
    "admin.pricing.openRouterCache": "OpenRouter cache",
    "admin.pricing.missingModels": "{missing} missing model{p1} · {aliases} alias{p2} · {custom} custom price{p3} · {openrouter} OpenRouter price{p4}",
    "admin.pricing.noMissing": "No missing prices in this month.",
    "admin.pricing.noCustom": "No custom model prices yet.",
    "admin.pricing.noAliases": "No model aliases yet.",
    "admin.pricing.noOpenRouter": "No OpenRouter prices cached.",
    "admin.pricing.noSourceBreakdown": "No source breakdown",
    "admin.pricing.mapToExisting": "Map to existing priced model",
    "admin.pricing.map": "Map",
    "admin.pricing.delete": "Delete",
    "admin.pricing.targetRequired": "Target model is required",
    "admin.pricing.openrouterStatus": "OpenRouter {status}",
    "admin.pricing.openrouterDetail": "{count} models · fetched {fetched} · expires {expires}",
    "admin.pricing.priceLine": "in {input} · out {output} · cache read {cacheRead}",
    "admin.pricing.aliasUses": "uses {target}",

    // Admin - Quality panel
    "admin.quality.title": "Quality and explainability",
    "admin.quality.rows": "Rows",
    "admin.quality.tokens": "Tokens",
    "admin.quality.composition": "Composition",
    "admin.quality.missingPrice": "Missing price",
    "admin.quality.anomalies": "Composition anomalies",
    "admin.quality.pricingCoverage": "Pricing coverage",
    "admin.quality.missingByParticipant": "Missing price by participant",
    "admin.quality.costExplainability": "Cost explainability",
    "admin.quality.noAnomaly": "No composition anomaly detected in this range.",
    "admin.quality.noParticipant": "No participant is impacted by missing pricing.",
    "admin.quality.noExplainability": "No explainability data.",
    "admin.quality.knownPrice": "Known price",
    "admin.quality.missingPriceLabel": "Missing price",
    "admin.quality.inputHeavy": "Input-heavy rows",
    "admin.quality.outputHeavy": "Output-heavy rows",
    "admin.quality.cacheHeavy": "Cache-heavy rows",
    "admin.quality.reasoningHeavy": "Reasoning-heavy rows",
    "admin.quality.unclassified": "Unclassified rows",
    "admin.quality.ofRows": "{shown} of {total} rows · {tokens}",
    "admin.quality.status": "{from} to {to} · {rows} rows",
    "admin.quality.explainabilityRows": "{count} rows",

    // Admin - Cost labels
    "admin.cost.exactPrice": "Exact",
    "admin.cost.estimatedPrice": "Estimated",
    "admin.cost.unknownPrice": "Missing price",
    "admin.cost.noPricingVersion": "no pricing version",
    "admin.cost.missingModels": "missing",
    "admin.cost.missingModelPrices": "Some model prices are missing",

    // Admin - Quality labels
    "admin.quality.exactField": "exact",
    "admin.quality.partialField": "partial",
    "admin.quality.exactDesc": "Tool logs provide explicit token fields",
    "admin.quality.partialDesc": "Some token fields are missing or can only be counted from available usage fields",

    // Admin - Devices panel
    "admin.devices.title": "Client devices",
    "admin.devices.nickname": "Nickname",
    "admin.devices.device": "Device",
    "admin.devices.lanIp": "LAN IP",
    "admin.devices.clientVersion": "Client version",
    "admin.devices.platform": "Platform",
    "admin.devices.build": "Build",
    "admin.devices.lastSeen": "Last seen",
    "admin.devices.empty": "No devices registered.",
    "admin.devices.count": "{count} devices",
    "admin.devices.countOne": "1 device"
  }
};

// 默认语言
const DEFAULT_LANG = "zh-CN";
const STORAGE_KEY = "ai-token-league.language";

// 当前语言
let currentLang = DEFAULT_LANG;

/**
 * 初始化 i18n，优先使用 configLanguage，其次从 localStorage 读取
 * @param {string} [configLanguage] - 从 config.json 传入的语言设置
 */
export function initI18n(configLanguage) {
  if (configLanguage && translations[configLanguage]) {
    currentLang = configLanguage;
    try {
      localStorage.setItem(STORAGE_KEY, configLanguage);
    } catch {
      // localStorage 不可用
    }
  } else {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && translations[saved]) {
        currentLang = saved;
      }
    } catch {
      // localStorage 不可用，使用默认语言
    }
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
