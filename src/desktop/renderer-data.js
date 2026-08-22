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
import {
  RAIL_SYNC_STATE as S,
  RAIL_SYNC_REASON as R,
} from "../shared/sync-status.js";

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
  if (providerId === "mimocode_local") return t("source.mimocode");
  if (providerId === "opencode_local") return t("source.opencode");
  if (providerId === "hermes_local") return t("source.hermes");
  if (providerId === "openclaw_local") return t("source.openclaw");
  if (providerId === "zcode_local") return t("source.zcode");
  if (providerId === "workbuddy_local") return t("source.workbuddy");
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

// ── Sync Status Derivation ──

function isSyncRecordForCurrentServer(config) {
  const configured = normalizeApiBaseUrl(config?.apiBaseUrl || "");
  if (!configured) return false;
  const syncStatus = config?.syncStatus || {};
  const recorded = normalizeApiBaseUrl(
    syncStatus.apiBaseUrl || config?.lastSyncApiBaseUrl || ""
  );
  return recorded === configured;
}

function syncDetailLabel(state, reason, t, formatDateTime, lastSuccessAt) {
  if (state === S.LOCAL_ONLY) return t("desktop.syncStatus.localOnlyDetail");
  if (state === S.SYNCING) {
    if (reason === R.SCANNING) return t("desktop.syncStatus.syncingDetail.scanning");
    if (reason === R.UPLOADING) return t("desktop.syncStatus.syncingDetail.uploading");
    if (reason === R.RETRYING_QUEUE) return t("desktop.syncStatus.syncingDetail.retryingQueue");
    return t("desktop.syncStatus.syncingDetail.checkingConnection");
  }
  if (state === S.NEEDS_SYNC) {
    if (reason === R.LOCAL_CHANGED_AFTER_SYNC) return t("desktop.syncStatus.needsSyncDetail.localChangedAfterSync");
    return t("desktop.syncStatus.needsSyncDetail.neverSyncedCurrentServer");
  }
  if (state === S.SYNCED) {
    return lastSuccessAt ? t("desktop.syncStatus.syncedDetail", { time: formatDateTime(lastSuccessAt) }) : "";
  }
  if (state === S.ATTENTION) {
    if (reason === R.QUEUED_RETRY) return t("desktop.syncStatus.attentionDetail.queuedRetry");
    if (reason === R.LAST_FAILED) return t("desktop.syncStatus.attentionDetail.lastFailed");
    if (reason === R.CLOUD_UNREACHABLE) return t("desktop.syncStatus.attentionDetail.cloudUnreachable");
    if (reason === R.CLOUD_INCOMPATIBLE) return t("desktop.syncStatus.attentionDetail.cloudIncompatible");
    return t("desktop.syncStatus.attentionDetail.lastFailed");
  }
  return "";
}

function syncActionForState(state, reason) {
  if (state === S.LOCAL_ONLY) return "configure_cloud";
  if (state === S.NEEDS_SYNC) return "sync_now";
  if (state === S.ATTENTION) {
    if (reason === R.CLOUD_UNREACHABLE) return "check_connection";
    if (reason === R.CLOUD_INCOMPATIBLE) return "update_client";
    return "retry_sync";
  }
  return null;
}

function syncActionLabel(action, t) {
  if (action === "configure_cloud") return t("desktop.syncStatus.action.configureCloud");
  if (action === "sync_now") return t("desktop.syncStatus.action.syncNow");
  if (action === "retry_sync") return t("desktop.syncStatus.action.retrySync");
  if (action === "check_connection") return t("desktop.syncStatus.action.checkConnection");
  if (action === "update_client") return t("desktop.syncStatus.action.updateClient");
  if (action === "open_settings") return t("desktop.syncStatus.action.openSettings");
  return "";
}

export function deriveRailSyncStatus({
  config,
  usageScanStatus = null,
  backgroundStatus = null,
  latestLocalSnapshot = null,
  foregroundSyncRunning = false,
  t: translate = (k) => k,
  formatDateTime: fmtDt = (v) => v,
} = {}) {
  const cfg = config || {};
  const apiBaseUrl = normalizeApiBaseUrl(cfg.apiBaseUrl || "");
  const connection = cfg.apiConnection || {};
  const syncStatus = cfg.syncStatus || {};
  const scanStatus = usageScanStatus || {};

  const isRunning = scanStatus.running || scanStatus.syncRunning || foregroundSyncRunning;
  const bgRunning = backgroundStatus?.running || false;
  const activelySyncing = isRunning || bgRunning;

  const lastSuccessAt = syncStatus.lastSuccessAt || "";
  const lastAttemptAt = syncStatus.lastAttemptAt || "";
  const lastStatus = syncStatus.lastStatus || cfg.lastSyncStatus || "";
  const lastError = syncStatus.lastError || cfg.lastSyncError || "";
  const lastResult = syncStatus.lastResult || null;
  const queuePending = lastResult?.queuePending || 0;
  const lastSuccessFp = syncStatus.lastSuccessSourceFingerprint || "";

  // 1. local_only / no_api
  if (!apiBaseUrl) {
    const reason = R.NO_API;
    const action = "configure_cloud";
    return {
      state: S.LOCAL_ONLY, reason,
      label: translate("desktop.syncStatus.localOnly"),
      detail: syncDetailLabel(S.LOCAL_ONLY, reason, translate, fmtDt, ""),
      title: translate("desktop.syncStatus.localOnlyDetail"),
      action, actionLabel: syncActionLabel(action, translate),
      apiBaseUrl: "", lastSuccessAt: "", lastAttemptAt: "", queuePending: 0, lastError: "",
    };
  }

  // 2. syncing
  if (activelySyncing) {
    let reason;
    const phase = scanStatus.phase;
    if (phase === "scanning") reason = R.SCANNING;
    else if (phase === "uploading") reason = R.UPLOADING;
    else if (phase === "retrying_queue") reason = R.RETRYING_QUEUE;
    else if (bgRunning && !isRunning) reason = R.CHECKING_CONNECTION;
    else if (scanStatus.syncRunning) reason = R.UPLOADING;
    else reason = R.SCANNING;

    return {
      state: S.SYNCING, reason,
      label: translate("desktop.syncStatus.syncing"),
      detail: syncDetailLabel(S.SYNCING, reason, translate, fmtDt, ""),
      title: translate("desktop.syncStatus.syncing"),
      action: null, actionLabel: "",
      apiBaseUrl, lastSuccessAt, lastAttemptAt, queuePending, lastError,
    };
  }

  const compatibility = connection.compatibility || {};

  // 3. syncing / checking_connection
  if (!connection.checkedAt) {
    const reason = R.CHECKING_CONNECTION;
    return {
      state: S.SYNCING, reason,
      label: translate("desktop.syncStatus.syncing"),
      detail: syncDetailLabel(S.SYNCING, reason, translate, fmtDt, ""),
      title: apiBaseUrl,
      action: null, actionLabel: "",
      apiBaseUrl, lastSuccessAt, lastAttemptAt, queuePending, lastError,
    };
  }

  // 4. attention / cloud_incompatible
  if (connection.status === "reachable" && compatibility.compatible === false) {
    const reason = R.CLOUD_INCOMPATIBLE;
    const action = "update_client";
    return {
      state: S.ATTENTION, reason,
      label: translate("desktop.syncStatus.attention"),
      detail: syncDetailLabel(S.ATTENTION, reason, translate, fmtDt, lastSuccessAt),
      title: connection.message || compatibility.reason || apiBaseUrl,
      action, actionLabel: syncActionLabel(action, translate),
      apiBaseUrl, lastSuccessAt, lastAttemptAt, queuePending, lastError,
    };
  }

  // 5. attention / cloud_unreachable
  if (connection.status && connection.status !== "reachable" && connection.status !== "not_configured" && connection.checkedAt) {
    const reason = R.CLOUD_UNREACHABLE;
    const action = "check_connection";
    return {
      state: S.ATTENTION, reason,
      label: translate("desktop.syncStatus.attention"),
      detail: syncDetailLabel(S.ATTENTION, reason, translate, fmtDt, lastSuccessAt),
      title: connection.message || apiBaseUrl,
      action, actionLabel: syncActionLabel(action, translate),
      apiBaseUrl, lastSuccessAt, lastAttemptAt, queuePending, lastError,
    };
  }

  const syncedForCurrentServer = isSyncRecordForCurrentServer(cfg);

  // 6. needs_sync / never_synced_current_server
  if (!syncedForCurrentServer || !lastStatus) {
    const reason = R.NEVER_SYNCED_CURRENT_SERVER;
    const action = "sync_now";
    return {
      state: S.NEEDS_SYNC, reason,
      label: translate("desktop.syncStatus.needsSync"),
      detail: syncDetailLabel(S.NEEDS_SYNC, reason, translate, fmtDt, ""),
      title: translate("desktop.syncStatus.needsSyncDetail.neverSyncedCurrentServer"),
      action, actionLabel: syncActionLabel(action, translate),
      apiBaseUrl, lastSuccessAt, lastAttemptAt, queuePending, lastError,
    };
  }

  // 7. needs_sync / local_changed_after_sync
  const localFp = latestLocalSnapshot?.sourceFingerprint || "";
  if (localFp && lastSuccessFp && localFp !== lastSuccessFp) {
    const reason = R.LOCAL_CHANGED_AFTER_SYNC;
    const action = "sync_now";
    return {
      state: S.NEEDS_SYNC, reason,
      label: translate("desktop.syncStatus.needsSync"),
      detail: syncDetailLabel(S.NEEDS_SYNC, reason, translate, fmtDt, lastSuccessAt),
      title: translate("desktop.syncStatus.needsSyncDetail.localChangedAfterSync"),
      action, actionLabel: syncActionLabel(action, translate),
      apiBaseUrl, lastSuccessAt, lastAttemptAt, queuePending, lastError,
    };
  }

  // 8. attention / queued_retry
  if (queuePending > 0) {
    const reason = R.QUEUED_RETRY;
    const action = "retry_sync";
    return {
      state: S.ATTENTION, reason,
      label: translate("desktop.syncStatus.attention"),
      detail: syncDetailLabel(S.ATTENTION, reason, translate, fmtDt, lastSuccessAt),
      title: translate("desktop.syncStatus.attentionDetail.queuedRetry"),
      action, actionLabel: syncActionLabel(action, translate),
      apiBaseUrl, lastSuccessAt, lastAttemptAt, queuePending, lastError,
    };
  }

  // 9. attention / last_failed
  if (lastStatus === "failed") {
    const reason = R.LAST_FAILED;
    const action = "retry_sync";
    return {
      state: S.ATTENTION, reason,
      label: translate("desktop.syncStatus.attention"),
      detail: syncDetailLabel(S.ATTENTION, reason, translate, fmtDt, lastSuccessAt),
      title: lastError || translate("desktop.syncStatus.attentionDetail.lastFailed"),
      action, actionLabel: syncActionLabel(action, translate),
      apiBaseUrl, lastSuccessAt, lastAttemptAt, queuePending, lastError,
    };
  }

  // 10. synced
  return {
    state: S.SYNCED, reason: null,
    label: translate("desktop.syncStatus.synced"),
    detail: syncDetailLabel(S.SYNCED, null, translate, fmtDt, lastSuccessAt),
    title: lastSuccessAt ? translate("desktop.syncStatus.syncedDetail", { time: fmtDt(lastSuccessAt) }) : translate("desktop.syncStatus.synced"),
    action: null, actionLabel: "",
    apiBaseUrl, lastSuccessAt, lastAttemptAt, queuePending, lastError,
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
