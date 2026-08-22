import { formatTokenCompact } from "/shared/display.js";

const locale = "zh-CN";
const publicPeriodMeta = {
  today: {
    label: "今日",
    chartLabel: "今日逐时 Token",
    currentKey: "todayTokens",
    previousKey: "yesterdayTokens",
    previousLabel: "昨日",
    costKey: "todayCost",
    code: "DAY",
  },
  this_week: {
    label: "本周",
    chartLabel: "本周逐日 Token",
    currentKey: "weekTokens",
    previousKey: "lastWeekTokens",
    previousLabel: "上周",
    costKey: "weekCost",
    code: "7D",
  },
  this_month: {
    label: "本月",
    chartLabel: "本月逐日 Token",
    currentKey: "thisMonthTokens",
    previousKey: "lastMonthTokens",
    previousLabel: "上月",
    costKey: "thisMonthCost",
    code: "MTD",
  },
  all: {
    label: "累计",
    chartLabel: "累计 Token 趋势",
    currentKey: "allTimeTokens",
    previousKey: null,
    previousLabel: "全部历史",
    costKey: "allTimeCost",
    code: "ALL",
  },
};

const sourceNames = {
  codex_local: "Codex",
  claude_code_local: "Claude Code",
  cursor_dashboard_usage: "Cursor",
  mimocode_local: "MiMoCode",
  opencode_local: "OpenCode",
  hermes_local: "Hermes",
  openclaw_local: "OpenClaw",
  zcode_local: "ZCode",
  workbuddy_local: "WorkBuddy",
  dsh_local: "DeepSeek Harness",
};

const qualityNames = {
  exact: "精确",
  partial: "部分估算",
  unknown: "待确认",
};

const state = {
  publicPeriod: "today",
  adminRange: "month",
  publicRequest: 0,
  adminRequest: 0,
  loadingCount: 0,
  publicLoading: false,
  adminLoading: false,
  currentView: "home",
  publicData: null,
  adminData: null,
};

function byId(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const element = byId(id);
  if (element) element.textContent = value;
}

function setHtml(id, value) {
  const element = byId(id);
  if (element) element.innerHTML = value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function token(value) {
  return formatTokenCompact(Number(value) || 0, locale);
}

function integer(value) {
  return new Intl.NumberFormat(locale).format(Number(value) || 0);
}

function usd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}

function percent(value, digits = 1) {
  if (!Number.isFinite(Number(value))) return "--";
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function sourceName(value) {
  return sourceNames[value] || value || "未知来源";
}

function modelName(item) {
  return item?.models?.[0]?.name || "未识别模型";
}

function providerName(item) {
  return sourceName(item?.providers?.[0]?.name);
}

function formatDateTime(value) {
  if (!value) return "从未同步";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function ageHours(value) {
  if (!value) return Infinity;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? Math.max(0, (Date.now() - time) / 3_600_000) : Infinity;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function withLoading(task) {
  state.loadingCount += 1;
  document.body.classList.add("loading");
  try {
    return await task();
  } finally {
    state.loadingCount = Math.max(0, state.loadingCount - 1);
    if (state.loadingCount === 0) document.body.classList.remove("loading");
  }
}

function reportError(error) {
  console.error(error);
  setText("live-data-status", `真实数据读取失败：${error.message}`);
}

function syncPeriodButtons() {
  document.querySelectorAll("[data-public-period] button").forEach((button) => {
    button.classList.toggle("active", button.dataset.period === state.publicPeriod);
  });
  document.querySelectorAll("[data-admin-range] button").forEach((button) => {
    button.classList.toggle("active", button.dataset.range === state.adminRange);
  });
}

function currentSummaryValue(summary, meta) {
  return Number(summary?.[meta.currentKey]) || 0;
}

function comparison(summary, meta) {
  if (!meta.previousKey) return { previous: null, ratio: null };
  const previous = Number(summary?.[meta.previousKey]) || 0;
  const current = currentSummaryValue(summary, meta);
  return {
    previous,
    ratio: previous > 0 ? current / previous : null,
  };
}

function contribution(item, total) {
  return total > 0 ? Number(item?.totalTokens || item?.tokens || 0) / total : 0;
}

function geometry(series, width, height, horizontalPadding, topPadding, bottomPadding) {
  const values = series.map((item) => Math.max(0, Number(item.totalTokens) || 0));
  if (values.length === 0) {
    return { line: "", area: "", peak: { x: horizontalPadding, y: height - bottomPadding, index: 0 } };
  }
  const max = Math.max(...values, 1);
  const usableWidth = width - horizontalPadding * 2;
  const usableHeight = height - topPadding - bottomPadding;
  const points = values.map((value, index) => {
    const x = values.length === 1
      ? width / 2
      : horizontalPadding + (index / (values.length - 1)) * usableWidth;
    const y = topPadding + (1 - value / max) * usableHeight;
    return { x, y };
  });
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const bottom = height - bottomPadding;
  const area = `${line} L${points.at(-1).x.toFixed(1)},${bottom} L${points[0].x.toFixed(1)},${bottom} Z`;
  const peakIndex = values.indexOf(max);
  return { line, area, peak: { ...points[peakIndex], index: peakIndex } };
}

function seriesLabel(item) {
  return item?.label || item?.day || item?.hour || item?.bucket || "--";
}

function visibleSeries(analytics, businessDay) {
  const series = analytics.timeSeries || [];
  if (analytics.timeGrain !== "hour") return series;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (businessDay !== today) return series;
  const currentHour = now.getHours();
  return series.filter((item) => Number(item.hour) <= currentHour);
}

function renderChart(series, options) {
  const chart = geometry(series, options.width, options.height, options.padding, options.top, options.bottom);
  byId(options.areaId)?.setAttribute("d", chart.area);
  byId(options.lineId)?.setAttribute("d", chart.line);
  const peak = byId(options.peakId);
  peak?.setAttribute("cx", chart.peak.x.toFixed(1));
  peak?.setAttribute("cy", chart.peak.y.toFixed(1));
  const annotationX = Math.min(options.width - 92, Math.max(options.padding, chart.peak.x));
  const annotationY = Math.max(18, chart.peak.y - 16);
  const peakLabel = byId(options.peakLabelId);
  peakLabel?.setAttribute("x", annotationX.toFixed(1));
  peakLabel?.setAttribute("y", annotationY.toFixed(1));
  if (peakLabel) peakLabel.textContent = series.length ? token(series[chart.peak.index]?.totalTokens) : "暂无数据";
  if (options.peakDateId) {
    const date = byId(options.peakDateId);
    date?.setAttribute("x", annotationX.toFixed(1));
    date?.setAttribute("y", (annotationY + 12).toFixed(1));
    if (date) date.textContent = series.length ? seriesLabel(series[chart.peak.index]) : "--";
  }
}

function renderHome(summary, leaderboard, analytics) {
  const meta = publicPeriodMeta[state.publicPeriod];
  const current = currentSummaryValue(summary, meta);
  const { previous, ratio } = comparison(summary, meta);
  const items = leaderboard.items || [];
  const participantCount = items.length;
  const topOneShare = contribution(items[0], current);
  const topThreeShare = items.slice(0, 3).reduce((sum, item) => sum + contribution(item, current), 0);
  const topProvider = analytics.providers?.[0];

  setText("home-current-label", `社区${meta.label} Token`);
  setText("home-business-day", summary.businessDay || leaderboard.businessDay || "--");
  setText("home-current-value", token(current));
  setText("home-current-meta", `${integer(current)} Token，排名按 totalTokens 计算`);
  setText("home-compare-label", meta.previousKey ? `相对${meta.previousLabel}` : "统计范围");
  setText("home-range-code", meta.code);
  setText("home-compare-value", previous === null ? "全部历史" : percent(ratio));
  setText("home-compare-meta", previous === null ? "从首条有效记录累计" : `相当于${meta.previousLabel}完整周期`);
  setText("home-active-value", integer(participantCount));
  setText("home-active-meta", `${meta.label}有用量记录的参与者`);
  setText("home-cost-value", usd(summary[meta.costKey]));
  setText("home-cost-meta", "成本仅为估算，不参与排名");

  if (ratio === null) {
    setHtml("home-insight-title", `累计用量达到 <em>${escapeHtml(token(current))}</em>`);
  } else if (ratio >= 1) {
    setHtml("home-insight-title", `${meta.label}截至当前已超过${meta.previousLabel} <em>${escapeHtml(percent(ratio - 1))}</em>`);
  } else {
    setHtml("home-insight-title", `${meta.label}截至当前达到${meta.previousLabel}的 <em>${escapeHtml(percent(ratio))}</em>`);
  }
  const leaderName = items[0]?.displayName || "暂无领先者";
  const sourceCopy = topProvider ? `${sourceName(topProvider.name)} 占 ${percent(topProvider.ratio)}` : "来源数据不足";
  setText("home-insight-copy", `${participantCount} 位参与者产生有效用量，${leaderName} 贡献 ${percent(topOneShare)}，${sourceCopy}。`);
  setText("home-fact-one-value", percent(topOneShare));
  setText("home-fact-one-label", "Top 1 贡献占比");
  setText("home-fact-two-value", previous === null ? percent(topThreeShare) : percent(ratio));
  setText("home-fact-two-label", previous === null ? "Top 3 集中度" : `对${meta.previousLabel}完整周期`);

  setText("home-chart-label", meta.chartLabel);
  const series = visibleSeries(analytics, summary.businessDay);
  renderChart(series, {
    width: 520,
    height: 250,
    padding: 20,
    top: 32,
    bottom: 50,
    areaId: "home-chart-area",
    lineId: "home-chart-line",
    peakId: "home-chart-peak",
    peakLabelId: "home-chart-peak-value",
    peakDateId: "home-chart-peak-date",
  });
  setText("home-chart-from", series.length ? seriesLabel(series[0]) : analytics.from || "--");
  setText("home-chart-to", series.length ? seriesLabel(series.at(-1)) : analytics.to || "--");

  setText("home-contributor-title", `${meta.label}由谁贡献`);
  setText("home-contributor-count", `${participantCount} 位参与者`);
  setHtml("home-contributors", items.slice(0, 4).map((item, index) => `
    <div class="story-item">
      <span class="story-index">TOP ${index + 1}</span>
      <div><strong>${escapeHtml(item.displayName)}</strong><small>${escapeHtml(modelName(item))} · ${escapeHtml(item.compositionSummary || "暂无组成")}</small></div>
      <span class="story-value">${escapeHtml(token(item.totalTokens))}<small>${escapeHtml(percent(contribution(item, current)))}</small></span>
    </div>`).join("") || '<div class="story-item"><div><strong>暂无贡献数据</strong></div></div>');

  renderProviders(analytics.providers || []);
  setText("home-table-title", `${meta.label}贡献排名`);
  setHtml("home-ranking-body", items.slice(0, 6).map((item) => publicRankingRow(item, current)).join(""));
}

function renderProviders(providers) {
  const colors = [
    "var(--accent)",
    "color-mix(in srgb, var(--accent) 60%, var(--muted))",
    "color-mix(in srgb, var(--accent) 24%, var(--line))",
    "var(--line)",
  ];
  const visible = providers.slice(0, 3);
  const segments = [];
  let offset = 0;
  visible.forEach((provider, index) => {
    const next = Math.min(100, offset + Number(provider.ratio || 0) * 100);
    segments.push(`${colors[index]} ${offset.toFixed(1)}% ${next.toFixed(1)}%`);
    offset = next;
  });
  if (offset < 100) segments.push(`${colors[3]} ${offset.toFixed(1)}% 100%`);
  const donut = byId("home-provider-donut");
  if (donut) donut.style.background = `conic-gradient(${segments.join(", ")})`;
  const otherRatio = Math.max(0, 1 - visible.reduce((sum, item) => sum + Number(item.ratio || 0), 0));
  const rows = [
    ...visible.map((item) => ({ name: sourceName(item.name), ratio: item.ratio })),
    ...(otherRatio > 0.001 ? [{ name: "其他来源", ratio: otherRatio }] : []),
  ];
  setHtml("home-provider-legend", rows.map((item) => `
    <div class="legend-row"><span>${escapeHtml(item.name)}</span><span>${escapeHtml(percent(item.ratio))}</span></div>`).join("") ||
    '<div class="legend-row"><span>暂无来源数据</span><span>--</span></div>');
}

function publicRankingRow(item, total) {
  return `<tr data-display-id="${escapeHtml(item.displayId)}">
    <td><span class="rank-number">${escapeHtml(item.rank)}</span></td>
    <td><span class="person-name">${escapeHtml(item.displayName)}<small>${escapeHtml(item.displayId)}</small></span></td>
    <td><span class="table-number">${escapeHtml(token(item.totalTokens))}</span></td>
    <td>${escapeHtml(percent(contribution(item, total)))}</td>
    <td>${escapeHtml(item.compositionSummary || "暂无组成")}</td>
    <td><span class="source-label">${escapeHtml(modelName(item))}</span></td>
  </tr>`;
}

function renderLeaderboard(summary, leaderboard, analytics) {
  const meta = publicPeriodMeta[state.publicPeriod];
  const total = currentSummaryValue(summary, meta);
  const items = leaderboard.items || [];
  const topOneShare = contribution(items[0], total);
  const topThreeShare = items.slice(0, 3).reduce((sum, item) => sum + contribution(item, total), 0);

  setText("leader-summary-label", `${meta.label} Token`);
  setText("leader-summary-tokens", token(total));
  setText("leader-summary-participants", integer(items.length));
  setText("leader-summary-top1", percent(topOneShare));
  setText("leader-summary-top3", percent(topThreeShare));
  setText("leader-podium-title", `${meta.label}领先者`);
  setText("leader-count", `展示前 ${Math.min(items.length, 12)} 位`);
  setHtml("leader-podium", items.slice(0, 3).map((item, index) => `
    <div class="podium-entry">
      <span class="place">第 ${index + 1} 名 · 社区贡献 ${escapeHtml(percent(contribution(item, total)))}</span>
      <h3>${escapeHtml(item.displayName)}</h3>
      <p>${escapeHtml(modelName(item))} · ${escapeHtml(item.compositionSummary || "暂无组成")}</p>
      <strong>${escapeHtml(token(item.totalTokens))}</strong>
    </div>`).join("") || '<div class="podium-entry"><h3>暂无排名数据</h3></div>');
  setHtml("leaderboard-body", items.map((item) => publicRankingRow(item, total)).join(""));
  byId("leaderboard-body")?.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", () => {
      const selected = items.find((item) => item.displayId === row.dataset.displayId);
      if (!selected) return;
      row.parentElement.querySelectorAll("tr").forEach((item) => item.classList.toggle("selected", item === row));
      renderParticipantDetail(selected, total);
    });
  });
  if (items[0]) renderParticipantDetail(items[0], total);
}

function renderParticipantDetail(item, total) {
  setText("detail-person", item.displayName);
  setText("detail-model", modelName(item));
  setText("detail-composition", item.compositionSummary || "暂无组成");
  setText("detail-share", percent(contribution(item, total)));
}

function renderAnalytics(summary, leaderboard, analytics) {
  const meta = publicPeriodMeta[state.publicPeriod];
  const current = currentSummaryValue(summary, meta);
  const { previous, ratio } = comparison(summary, meta);
  const items = leaderboard.items || [];
  const topProvider = analytics.providers?.[0];
  const topThreeShare = items.slice(0, 3).reduce((sum, item) => sum + contribution(item, current), 0);

  setText("analytics-delta", ratio === null ? token(current) : percent(ratio));
  setText("analytics-delta-title", ratio === null ? "累计用量" : `${meta.label}周期进度`);
  setText("analytics-delta-copy", ratio === null
    ? "累计值来自服务端全部有效日用量。"
    : `${meta.label}截至当前 ${token(current)}，相当于${meta.previousLabel}完整周期 ${token(previous)} 的 ${percent(ratio)}。`);
  setText("analytics-cache-rate", percent(analytics.summary?.cacheHitRate));
  setText("analytics-cache-copy", `缓存读取 ${token(analytics.summary?.cacheReadTokens)}，节省估算 ${usd(analytics.summary?.cacheSavingsUsd)}。`);
  setText("analytics-primary-source-ratio", topProvider ? percent(topProvider.ratio) : "--");
  setText("analytics-primary-source-title", topProvider ? sourceName(topProvider.name) : "主要来源");
  setText("analytics-primary-source-copy", topProvider ? `${sourceName(topProvider.name)} 贡献 ${token(topProvider.tokens)}。` : "当前周期暂无来源数据。");
  setText("analytics-range", `${analytics.from || "--"} 至 ${analytics.to || "--"}`);

  const series = visibleSeries(analytics, summary.businessDay);
  renderChart(series, {
    width: 800,
    height: 300,
    padding: 25,
    top: 34,
    bottom: 58,
    areaId: "analytics-chart-area",
    lineId: "analytics-chart-line",
    peakId: "analytics-chart-peak",
    peakLabelId: "analytics-chart-peak-label",
  });

  const drivers = [
    { title: "最大单一贡献者", copy: items[0]?.displayName || "暂无数据", value: items[0] ? token(items[0].totalTokens) : "--" },
    { title: "Top 3 集中度", copy: "判断总量是否依赖少数参与者", value: percent(topThreeShare) },
    { title: "有效参与人数", copy: "当前周期有用量记录", value: `${integer(items.length)} 人` },
    { title: "预估成本", copy: "只用于解释，不参与排名", value: usd(analytics.summary?.estimatedCostUsd) },
  ];
  setHtml("analytics-drivers", drivers.map((item) => `
    <div class="driver"><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.copy)}</small></div><span class="driver-value">${escapeHtml(item.value)}</span></div>`).join(""));

  setHtml("analytics-models", (analytics.models || []).slice(0, 5).map((item) => `
    <div class="mix-row">
      <span>${escapeHtml(item.name)}</span>
      <div class="thin-bar"><i style="--value:${Math.max(0, Math.min(100, Number(item.ratio || 0) * 100)).toFixed(1)}%"></i></div>
      <strong>${escapeHtml(percent(item.ratio))}</strong>
    </div>`).join("") || '<div class="mix-row"><span>暂无模型数据</span><strong>--</strong></div>');

  renderHeatmap(analytics.heatmap || []);
}

function renderHeatmap(heatmap) {
  const visible = heatmap.slice(-98);
  const max = Math.max(...visible.map((item) => Number(item.totalTokens) || 0), 1);
  setHtml("heatmap", visible.map((item) => {
    const level = Math.max(0.35, ((Number(item.totalTokens) || 0) / max) * 5);
    return `<i style="--level:${level.toFixed(2)}" title="${escapeHtml(seriesLabel(item))} · ${escapeHtml(token(item.totalTokens))}"></i>`;
  }).join("") || '<span class="panel-meta">暂无活跃数据</span>');
}

function renderAdmin(ranking, quality, devices) {
  const items = ranking.items || [];
  const missingRatio = Number(quality.pricingCoverage?.missingTokenRatio) || 0;
  const exactRows = Number(quality.bySourceQuality?.find((item) => item.name === "exact")?.count) || 0;
  const rowCount = Number(quality.rows) || 0;
  const staleDevices = devices.filter((device) => ageHours(device.lastSeenAt) > 24);
  const latestDevice = devices.reduce((latest, device) => {
    if (!latest) return device;
    return new Date(device.lastSeenAt || 0) > new Date(latest.lastSeenAt || 0) ? device : latest;
  }, null);

  setText("admin-total-tokens", token(quality.totalTokens));
  setText("admin-user-count", integer(ranking.total));
  setText("admin-pricing-coverage", percent(1 - missingRatio));
  setText("admin-device-count", integer(devices.length));
  setText("admin-ranking-range", `${ranking.from || "--"} 至 ${ranking.to || "--"}，共 ${integer(ranking.total)} 位用户`);
  setHtml("admin-ranking-body", items.map((item) => `
    <tr>
      <td><span class="rank-number">${escapeHtml(item.rank)}</span></td>
      <td><span class="person-name">${escapeHtml(item.nickname)}<small>${escapeHtml(item.compositionSummary || "暂无组成")}</small></span></td>
      <td><span class="table-number">${escapeHtml(token(item.totalTokens))}</span></td>
      <td>${escapeHtml(modelName(item))}</td>
      <td><span class="source-label">${escapeHtml(providerName(item))}</span></td>
      <td>${escapeHtml(qualityNames[item.sourceQuality] || item.sourceQuality || "待确认")}</td>
      <td>${escapeHtml(formatDateTime(item.lastSyncedAt))}</td>
    </tr>`).join("") || '<tr><td colspan="7">当前周期暂无用户用量</td></tr>');

  const tasks = [
    {
      title: `价格缺口 ${token(quality.pricingCoverage?.missingTokens)}`,
      copy: `${percent(missingRatio)} 的 Token 暂无价格覆盖，共影响 ${quality.pricingCoverage?.participants?.filter((item) => item.missingPriceTokens > 0).length || 0} 位用户。`,
      active: missingRatio > 0,
      status: missingRatio > 0 ? "需关注" : "已覆盖",
    },
    {
      title: `${integer(staleDevices.length)} 台设备超过 24 小时未同步`,
      copy: staleDevices.length ? `最久未同步设备属于 ${staleDevices.at(-1)?.nickname || "未知用户"}。` : "全部登记设备均在最近 24 小时内同步。",
      active: staleDevices.length > 0,
      status: staleDevices.length > 0 ? "需跟进" : "正常",
    },
    {
      title: `${integer(quality.nonExactRows)} 条非精确记录`,
      copy: `当前范围共有 ${integer(rowCount)} 条日用量记录，来源精确率为 ${percent(rowCount ? exactRows / rowCount : 0)}。`,
      active: Number(quality.nonExactRows) > 0,
      status: Number(quality.nonExactRows) > 0 ? "需核对" : "精确",
    },
    {
      title: `${integer(quality.multiDeviceParticipants?.length)} 位多设备用户`,
      copy: "多设备本身不是异常，用于核对排名聚合是否完整。",
      active: false,
      status: "辅助信息",
    },
  ];
  setText("admin-task-meta", `${tasks.filter((task) => task.active).length} 项需要关注`);
  setHtml("admin-tasks", tasks.map((task) => `
    <div class="task"><div><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(task.copy)}</p></div><span class="task-status ${task.active ? "warn" : "ok"}">${escapeHtml(task.status)}</span></div>`).join(""));

  const statusRows = [
    { label: "日用量记录", value: `${integer(rowCount)} 条`, className: "ok" },
    { label: "来源精确率", value: percent(rowCount ? exactRows / rowCount : 0), className: exactRows === rowCount ? "ok" : "warn" },
    { label: "价格缺失率", value: percent(missingRatio), className: missingRatio < 0.01 ? "ok" : "warn" },
    { label: "异常日期", value: `${integer(quality.abnormalDays?.length)} 天`, className: quality.abnormalDays?.length ? "warn" : "ok" },
    { label: "最近设备上报", value: latestDevice ? formatDateTime(latestDevice.lastSeenAt) : "暂无", className: latestDevice && ageHours(latestDevice.lastSeenAt) <= 24 ? "ok" : "warn" },
  ];
  setHtml("admin-status", statusRows.map((item) => `
    <div class="status-row"><span>${escapeHtml(item.label)}</span><strong class="${item.className}">${escapeHtml(item.value)}</strong></div>`).join(""));

  const visibleDevices = [...devices].sort((a, b) => ageHours(b.lastSeenAt) - ageHours(a.lastSeenAt)).slice(0, 10);
  setText("admin-device-meta", `${devices.length - staleDevices.length} 台正常，${staleDevices.length} 台待同步`);
  setHtml("admin-device-body", visibleDevices.map((device) => {
    const stale = ageHours(device.lastSeenAt) > 24;
    return `<tr>
      <td><span class="person-name">${escapeHtml(String(device.deviceId || "未知设备").slice(-8))}<small>${escapeHtml(device.os || device.clientPlatform || "未知系统")}</small></span></td>
      <td>${escapeHtml(device.nickname || "未知用户")}</td>
      <td>${escapeHtml(formatDateTime(device.lastSeenAt))}</td>
      <td>${escapeHtml(device.clientAppVersion || "未知")}</td>
      <td>${escapeHtml(device.clientPlatform || "未知")}</td>
      <td><span class="${stale ? "delta-down" : "delta-up"}">${stale ? "待同步" : "正常"}</span></td>
    </tr>`;
  }).join("") || '<tr><td colspan="6">暂无登记设备</td></tr>');
}

async function loadPublic(period = state.publicPeriod) {
  state.publicPeriod = period;
  state.publicLoading = true;
  syncPeriodButtons();
  const requestId = ++state.publicRequest;
  return withLoading(async () => {
    try {
      const [summary, leaderboard, analytics] = await Promise.all([
        fetchJson("/api/board/summary"),
        fetchJson(`/api/board/leaderboard?period=${encodeURIComponent(period)}&limit=100`),
        fetchJson(`/api/board/analytics?period=${encodeURIComponent(period)}`),
      ]);
      if (requestId !== state.publicRequest) return;
      state.publicData = { summary, leaderboard, analytics };
      renderHome(summary, leaderboard, analytics);
      renderLeaderboard(summary, leaderboard, analytics);
      renderAnalytics(summary, leaderboard, analytics);
      setText("live-data-status", `真实数据更新于 ${new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date())}，业务日 ${summary.businessDay || "--"}。公开端匿名，Admin 保留真实昵称。`);
    } catch (error) {
      if (requestId === state.publicRequest) reportError(error);
    }
  }).finally(() => {
    if (requestId === state.publicRequest) state.publicLoading = false;
  });
}

async function loadAdmin(range = state.adminRange) {
  state.adminRange = range;
  state.adminLoading = true;
  syncPeriodButtons();
  const requestId = ++state.adminRequest;
  return withLoading(async () => {
    try {
      const [ranking, quality, devices] = await Promise.all([
        fetchJson(`/api/admin/usage-ranking?range=${encodeURIComponent(range)}&page=1&pageSize=10`),
        fetchJson(`/api/admin/quality?range=${encodeURIComponent(range)}`),
        fetchJson("/api/admin/devices"),
      ]);
      if (requestId !== state.adminRequest) return;
      state.adminData = { ranking, quality, devices };
      renderAdmin(ranking, quality, Array.isArray(devices) ? devices : devices.items || []);
    } catch (error) {
      if (requestId === state.adminRequest) reportError(error);
    }
  }).finally(() => {
    if (requestId === state.adminRequest) state.adminLoading = false;
  });
}

function showView(view) {
  const validView = ["home", "leaderboard", "analytics", "admin"].includes(view) ? view : "home";
  state.currentView = validView;
  document.querySelectorAll("[data-view]").forEach((section) => section.classList.toggle("active", section.dataset.view === validView));
  document.querySelectorAll("[data-view-target]").forEach((button) => {
    const active = button.dataset.viewTarget === validView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  if (window.location.hash !== `#${validView}`) history.replaceState(null, "", `#${validView}`);
  window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  if (validView === "admin" && !state.adminData && !state.adminLoading) loadAdmin();
  if (validView !== "admin" && !state.publicData && !state.publicLoading) loadPublic();
}

document.querySelectorAll("[data-view-target]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.viewTarget));
});

document.querySelectorAll("[data-public-period] button").forEach((button) => {
  button.addEventListener("click", () => loadPublic(button.dataset.period));
});

document.querySelectorAll("[data-admin-range] button").forEach((button) => {
  button.addEventListener("click", () => loadAdmin(button.dataset.range));
});

byId("theme-toggle")?.addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  byId("theme-toggle").textContent = dark ? "浅色" : "深色";
  byId("theme-toggle").setAttribute("aria-pressed", String(dark));
});

byId("refresh-demo")?.addEventListener("click", () => {
  if (state.currentView === "admin") return loadAdmin(state.adminRange);
  return loadPublic(state.publicPeriod);
});

window.addEventListener("hashchange", () => showView(window.location.hash.slice(1)));

syncPeriodButtons();
showView(window.location.hash.slice(1) || "home");
