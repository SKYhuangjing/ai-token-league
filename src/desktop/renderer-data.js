// Data transformation functions extracted from renderer.js.
// Functions that need priceMap, t(), or config accept them as parameters.

import { addCostToUsageItem, aggregateCost } from "../shared/pricing.js";
import { tokenCompositionSummary } from "../shared/composition.js";
import { localDay } from "../shared/date.js";
import {
  bucketForDay, trailingDays, emptyTrendRow, sortedBreakdown, finalizeCostBreakdown,
  addCostBreakdownItem, hasPositiveUsage, normalizeApiBaseUrl, clampHour, formatHourLabel,
  normalizeTokenAggregate, normalizeBreakdownItems, normalizeUsageTrend,
  normalizeUsageWorkdirs, normalizeUsageSummary, normalizeUsageTotal, positiveInteger,
  reconcileHealthWithConfig
} from "./renderer-helpers.js";

// ── Internal helpers ──

function addDisplayCostToUsageItem(item, priceMap) {
  if (priceMap && Object.keys(priceMap || {}).length) return addCostToUsageItem(item, priceMap);
  if (item.estimatedCostUsd !== null && item.estimatedCostUsd !== undefined) {
    return {
      ...item,
      hasKnownPrice: true,
      costQuality: item.costQuality || "estimated_price",
      pricingVersion: item.pricingVersion || "",
      missingPriceTokens: item.missingPriceTokens || 0
    };
  }
  return addCostToUsageItem(item, priceMap);
}

function addUsageToTrendRow(row, item, withCost) {
  row.inputTokens += item.inputTokens || 0;
  row.outputTokens += item.outputTokens || 0;
  row.reasoningTokens += item.reasoningTokens || 0;
  row.cacheReadTokens += item.cacheReadTokens || 0;
  row.cacheWriteTokens += item.cacheWriteTokens || 0;
  row.totalTokens += item.totalTokens || 0;
  aggregateCost(row, withCost);
  return row;
}

function finalizeTrendRow(row) {
  return {
    ...row,
    compositionSummary: tokenCompositionSummary(row),
    missingPriceModels: sortedBreakdown(row.missingPriceModels || {}),
    modelBreakdown: finalizeCostBreakdown(row.modelBreakdownMap || {}),
    workdirBreakdown: finalizeCostBreakdown(row.workdirBreakdownMap || {})
  };
}

// ── Source / Provider helpers ──

export function sourceName(providerId, t = (k) => k) {
  if (providerId === "codex_local") return t("source.codex");
  if (providerId === "claude_code_local") return t("source.claude");
  if (providerId === "cursor_dashboard_usage") return t("source.cursor");
  return providerId;
}

export function sourceDescription(providerId, t = (k) => k) {
  if (providerId === "cursor_dashboard_usage") return t("desktop.sources.cursorDesc");
  return t("desktop.sources.localDesc");
}

export function sourceSummary(item, t = (k) => k) {
  const sources = item.sources || [];
  const autoCount = sources.filter(s => s.kind === "auto" && !s.ignored).length;
  const manualCount = sources.filter(s => s.kind === "manual").length;
  const totalCount = autoCount + manualCount;
  if (item.providerId === "cursor_dashboard_usage") {
    if (!totalCount) return t("desktop.sources.noCursorAccountDetected");
    return totalCount === 1 ? t("desktop.sources.accountSourceOne") : t("desktop.sources.accountSources", { count: totalCount });
  }
  if (!item.detected) return t("desktop.renderer.notFound");
  return totalCount === 1 ? t("desktop.sources.locationOne") : t("desktop.sources.locations", { count: totalCount });
}

// ── Range / Label ──

export function daysForRange(range) {
  if (range === "all") return null;
  if (range === "7d") return new Set(trailingDays(7));
  if (range === "30d") return new Set(trailingDays(30));
  return new Set([localDay()]);
}

export function usageForRange(range, allUsage) {
  const allowed = daysForRange(range);
  if (!allowed) return [...allUsage];
  return allUsage.filter((item) => allowed.has(item.day));
}

export function rangeLabel(range, t = (k) => k) {
  if (range === "7d") return t("desktop.range.7d");
  if (range === "30d") return t("desktop.range.30d");
  if (range === "all") return t("desktop.range.all");
  return t("desktop.range.today");
}

export function overviewTrendGrain(overviewRange) {
  if (overviewRange === "today") return "hour";
  if (overviewRange === "30d") return "week";
  if (overviewRange === "all") return "month";
  return "day";
}

// ── Cloud Status ──

export function railCloudStatus(config, t = (k) => k) {
  const connection = config?.apiConnection || {};
  const apiBaseUrl = normalizeApiBaseUrl(config?.apiBaseUrl || connection.apiBaseUrl || "");
  if (!apiBaseUrl) {
    return { state: "local", label: t("desktop.rail.cloudLocal"), title: t("desktop.renderer.cloudNotConfigured") };
  }
  if (!connection.checkedAt) {
    return { state: "checking", label: t("desktop.rail.cloudChecking"), title: apiBaseUrl };
  }
  const compatibility = connection.compatibility || {};
  if (connection.status === "reachable" && compatibility.compatible === false) {
    return {
      state: "unavailable",
      label: t("desktop.rail.cloudUnavailable"),
      title: connection.message || compatibility.reason || compatibility.status || apiBaseUrl
    };
  }
  if (connection.status === "reachable") {
    const version = connection.serverVersion ? `v${connection.serverVersion}` : apiBaseUrl;
    return { state: "online", label: t("desktop.rail.cloudOnline"), title: version };
  }
  if (connection.status === "not_configured") {
    return { state: "local", label: t("desktop.rail.cloudLocal"), title: t("desktop.renderer.cloudNotConfigured") };
  }
  return {
    state: "offline",
    label: t("desktop.rail.cloudOffline"),
    title: connection.message || apiBaseUrl
  };
}

// ── Grouping / Aggregation ──

export function groupBy(items, key, priceMap) {
  const map = {};
  for (const item of items) {
    const name = item[key] || "unknown";
    const withCost = addDisplayCostToUsageItem(item, priceMap);
    addCostBreakdownItem(map, name, item, withCost);
  }
  return finalizeCostBreakdown(map);
}

export function groupProviders(items, priceMap, t = (k) => k) {
  const rows = groupBy(items, "providerId", priceMap);
  return rows.map((row) => ({ ...row, name: sourceName(row.name, t) }));
}

export function groupByGrain(items, grain, priceMap) {
  const map = new Map();
  for (const item of items) {
    const bucket = bucketForDay(item.day, grain);
    const row = map.get(bucket.key) || {
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0,
      costQuality: "",
      pricingVersion: "",
      totalTokens: 0
    };
    const withCost = addDisplayCostToUsageItem(item, priceMap);
    row.inputTokens += item.inputTokens || 0;
    row.outputTokens += item.outputTokens || 0;
    row.reasoningTokens += item.reasoningTokens || 0;
    row.cacheReadTokens += item.cacheReadTokens || 0;
    row.cacheWriteTokens += item.cacheWriteTokens || 0;
    row.totalTokens += item.totalTokens || 0;
    aggregateCost(row, withCost);
    map.set(bucket.key, row);
  }
  return [...map.values()]
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart))
    .map((row) => ({ ...row, missingPriceModels: sortedBreakdown(row.missingPriceModels || {}) }));
}

export function groupByHour(items, priceMap) {
  const map = new Map();
  for (const item of items) {
    const hour = clampHour(item.hour);
    const key = `${item.day}|${hour}`;
    const row = map.get(key) || emptyTrendRow({
      periodStart: item.day,
      periodEnd: item.day,
      hour,
      bucketLabel: formatHourLabel(hour)
    });
    const withCost = addDisplayCostToUsageItem(item, priceMap);
    addUsageToTrendRow(row, item, withCost);
    addCostBreakdownItem(row.modelBreakdownMap, item.model || "unknown", item, withCost);
    addCostBreakdownItem(row.workdirBreakdownMap, item.workdirDisplayName || "unknown", item, withCost);
    map.set(key, row);
  }
  return [...map.values()]
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart) || (a.hour ?? 0) - (b.hour ?? 0))
    .map(finalizeTrendRow)
    .filter(hasPositiveUsage);
}

export function groupTrend(items, { trendView = "daily", priceMap } = {}) {
  const viewMeta = trendView === "weekly"
    ? { grain: "week" }
    : trendView === "monthly"
      ? { grain: "month" }
      : { grain: "day" };
  const allowedDays = trendView === "weekly"
    ? new Set(trailingDays(7 * 12))
    : trendView === "monthly"
      ? new Set(trailingDays(30 * 12))
      : new Set(trailingDays(30));
  const map = new Map();
  for (const item of items) {
    if (!allowedDays.has(item.day)) continue;
    const bucket = bucketForDay(item.day, viewMeta.grain);
    const row =
      map.get(bucket.key) ||
      {
        periodStart: bucket.periodStart,
        periodEnd: bucket.periodEnd,
        models: new Set(),
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        costQuality: "",
        modelBreakdownMap: {},
        workdirBreakdownMap: {},
        modelDetailMap: {},
        detailItems: []
      };
    const withCost = addDisplayCostToUsageItem(item, priceMap);
    const modelDetailKey = `${item.workdirDisplayName || "unknown"}|${item.model || "unknown"}`;
    const modelDetail = row.modelDetailMap[modelDetailKey] || {
      workdirDisplayName: item.workdirDisplayName || "unknown",
      model: item.model || "unknown",
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      costQuality: "",
      pricingVersion: ""
    };
    row.models.add(item.model || "unknown");
    row.inputTokens += item.inputTokens || 0;
    row.outputTokens += item.outputTokens || 0;
    row.reasoningTokens += item.reasoningTokens || 0;
    row.cacheReadTokens += item.cacheReadTokens || 0;
    row.cacheWriteTokens += item.cacheWriteTokens || 0;
    row.totalTokens += item.totalTokens || 0;
    aggregateCost(row, withCost);
    addCostBreakdownItem(row.modelBreakdownMap, item.model || "unknown", item, withCost);
    addCostBreakdownItem(row.workdirBreakdownMap, item.workdirDisplayName || "unknown", item, withCost);
    row.detailItems.push(item);
    modelDetail.inputTokens += item.inputTokens || 0;
    modelDetail.outputTokens += item.outputTokens || 0;
    modelDetail.reasoningTokens += item.reasoningTokens || 0;
    modelDetail.cacheReadTokens += item.cacheReadTokens || 0;
    modelDetail.cacheWriteTokens += item.cacheWriteTokens || 0;
    modelDetail.totalTokens += item.totalTokens || 0;
    aggregateCost(modelDetail, withCost);
    row.modelDetailMap[modelDetailKey] = modelDetail;
    map.set(bucket.key, row);
  }
  return [...map.values()]
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart))
    .map((row) => ({
      ...row,
      compositionSummary: tokenCompositionSummary(row),
      missingPriceModels: sortedBreakdown(row.missingPriceModels || {}),
      modelBreakdown: finalizeCostBreakdown(row.modelBreakdownMap || {}),
      workdirBreakdown: finalizeCostBreakdown(row.workdirBreakdownMap || {}),
      detailBreakdown: groupOverviewDetailBreakdown(row.detailItems || [], viewMeta.grain, priceMap),
      detailBreakdownTitle: detailBreakdownTitleForParentGrain(viewMeta.grain),
      modelDetails: Object.values(row.modelDetailMap || {}).sort((a, b) => b.totalTokens - a.totalTokens),
      models: [...row.models].sort()
    }))
    .filter(hasPositiveUsage);
}

export function groupWorkdirs(items) {
  const map = new Map();
  for (const item of items) {
    const row = map.get(item.workdirHash) || {
      workdirHash: item.workdirHash,
      name: item.workdirDisplayName,
      totalTokens: 0
    };
    row.totalTokens += item.totalTokens || 0;
    map.set(item.workdirHash, row);
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

export function groupWorkdirDetails(items, priceMap) {
  const map = new Map();
  for (const item of items) {
    const key = item.workdirHash || item.workdirDisplayName || "unknown";
    const current = map.get(key) || {
      workdirHash: item.workdirHash || key,
      name: item.workdirDisplayName || "unknown",
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      modelMap: {},
      modelCostMap: {},
      dailyMap: {},
      dailyCostMap: {},
      estimatedCostUsd: 0,
      costQuality: "",
      pricingVersion: ""
    };
    const withCost = addDisplayCostToUsageItem(item, priceMap);
    current.totalTokens += item.totalTokens || 0;
    current.inputTokens += item.inputTokens || 0;
    current.outputTokens += item.outputTokens || 0;
    current.cacheReadTokens += item.cacheReadTokens || 0;
    current.cacheWriteTokens += item.cacheWriteTokens || 0;
    current.reasoningTokens += item.reasoningTokens || 0;
    current.modelMap[item.model || "unknown"] = (current.modelMap[item.model || "unknown"] || 0) + (item.totalTokens || 0);
    const modelCost = current.modelCostMap[item.model || "unknown"] || { name: item.model || "unknown", totalTokens: 0, estimatedCostUsd: 0, costQuality: "", pricingVersion: "" };
    modelCost.totalTokens += item.totalTokens || 0;
    aggregateCost(modelCost, withCost);
    current.modelCostMap[item.model || "unknown"] = modelCost;
    current.dailyMap[item.day] = (current.dailyMap[item.day] || 0) + (item.totalTokens || 0);
    const dailyCost = current.dailyCostMap[item.day] || { name: item.day, totalTokens: 0, estimatedCostUsd: 0, costQuality: "", pricingVersion: "" };
    dailyCost.totalTokens += item.totalTokens || 0;
    aggregateCost(dailyCost, withCost);
    current.dailyCostMap[item.day] = dailyCost;
    aggregateCost(current, withCost);
    map.set(key, current);
  }
  const total = items.reduce((sum, item) => sum + (item.totalTokens || 0), 0) || 1;
  return [...map.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((item) => ({
      ...item,
      contributionRatio: item.totalTokens / total,
      modelBreakdown: finalizeCostBreakdown(item.modelCostMap || {}),
      dailyBreakdown: finalizeCostBreakdown(item.dailyCostMap || {}).sort((a, b) => a.name.localeCompare(b.name)),
      missingPriceModels: sortedBreakdown(item.missingPriceModels || {})
    }));
}

export function groupDailyRows(items, priceMap) {
  const map = new Map();
  for (const item of items) {
    const row = map.get(item.day) || {
      periodStart: item.day,
      periodEnd: item.day,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      costQuality: "",
      pricingVersion: "",
      modelBreakdownMap: {},
      workdirBreakdownMap: {}
    };
    const withCost = addDisplayCostToUsageItem(item, priceMap);
    row.inputTokens += item.inputTokens || 0;
    row.outputTokens += item.outputTokens || 0;
    row.reasoningTokens += item.reasoningTokens || 0;
    row.cacheReadTokens += item.cacheReadTokens || 0;
    row.cacheWriteTokens += item.cacheWriteTokens || 0;
    row.totalTokens += item.totalTokens || 0;
    aggregateCost(row, withCost);
    addCostBreakdownItem(row.modelBreakdownMap, item.model || "unknown", item, withCost);
    addCostBreakdownItem(row.workdirBreakdownMap, item.workdirDisplayName || "unknown", item, withCost);
    map.set(item.day, row);
  }
  return [...map.values()]
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart))
    .map((row) => ({
      ...row,
      modelBreakdown: finalizeCostBreakdown(row.modelBreakdownMap || {}),
      workdirBreakdown: finalizeCostBreakdown(row.workdirBreakdownMap || {}),
      compositionSummary: tokenCompositionSummary(row),
      missingPriceModels: sortedBreakdown(row.missingPriceModels || {})
    }));
}

export function aggregateComposition(items) {
  return items.reduce((current, item) => ({
    inputTokens: current.inputTokens + Number(item.inputTokens || 0),
    outputTokens: current.outputTokens + Number(item.outputTokens || 0),
    cacheReadTokens: current.cacheReadTokens + Number(item.cacheReadTokens || 0),
    cacheWriteTokens: current.cacheWriteTokens + Number(item.cacheWriteTokens || 0),
    reasoningTokens: current.reasoningTokens + Number(item.reasoningTokens || 0),
    totalTokens: current.totalTokens + Number(item.totalTokens || 0)
  }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  });
}

export function aggregatePeriodRow(items, periodStart, periodEnd, hour, parentGrain, priceMap) {
  const row = {
    periodStart,
    periodEnd,
    ...(hour === null || hour === undefined ? {} : { hour, bucketLabel: formatHourLabel(hour) }),
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    costQuality: "",
    pricingVersion: "",
    modelBreakdownMap: {},
    workdirBreakdownMap: {}
  };
  for (const item of items) {
    const withCost = addDisplayCostToUsageItem(item, priceMap);
    row.inputTokens += item.inputTokens || 0;
    row.outputTokens += item.outputTokens || 0;
    row.reasoningTokens += item.reasoningTokens || 0;
    row.cacheReadTokens += item.cacheReadTokens || 0;
    row.cacheWriteTokens += item.cacheWriteTokens || 0;
    row.totalTokens += item.totalTokens || 0;
    aggregateCost(row, withCost);
    addCostBreakdownItem(row.modelBreakdownMap, item.model || "unknown", item, withCost);
    addCostBreakdownItem(row.workdirBreakdownMap, item.workdirDisplayName || "unknown", item, withCost);
  }
  return {
    ...row,
    compositionSummary: tokenCompositionSummary(row),
    missingPriceModels: sortedBreakdown(row.missingPriceModels || {}),
    modelBreakdown: finalizeCostBreakdown(row.modelBreakdownMap || {}),
    workdirBreakdown: finalizeCostBreakdown(row.workdirBreakdownMap || {}),
    detailBreakdown: groupOverviewDetailBreakdown(items, parentGrain, priceMap, hour),
    detailBreakdownTitle: detailBreakdownTitleForParentGrain(parentGrain)
  };
}

function groupOverviewDetailBreakdown(items, parentGrain, priceMap, hour = null) {
  if (hour !== null || parentGrain === "hour") return [];
  if (parentGrain === "day") return groupByHour(items, priceMap);
  if (parentGrain === "week") return groupByGrain(items, "day", priceMap).filter(hasPositiveUsage);
  if (parentGrain === "month") return groupByGrain(items, "week", priceMap).filter(hasPositiveUsage);
  if (parentGrain === "year") return groupByGrain(items, "month", priceMap).filter(hasPositiveUsage);
  return [];
}

function detailBreakdownTitleForParentGrain(parentGrain, t = (k) => k) {
  if (parentGrain === "day") return t("desktop.trend.hourlyDetail");
  if (parentGrain === "week") return t("desktop.trend.dailyDetail");
  if (parentGrain === "month") return t("desktop.trend.weeklyDetail");
  if (parentGrain === "year") return t("desktop.trend.monthlyDetail");
  return "";
}

// ── Re-exports for renderer.js convenience ──

export {
  normalizeUsageSummary,
  normalizeUsageTrend,
  normalizeUsageWorkdirs,
  normalizeUsageTotal,
  normalizeBreakdownItems,
  normalizeTokenAggregate,
  positiveInteger,
  reconcileHealthWithConfig
};
