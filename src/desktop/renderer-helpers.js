// Pure helper functions extracted from renderer.js for testability.
// All functions here are side-effect free with no DOM or global state dependencies.

import { formatTokenCompact, formatTokenRaw, formatUsd } from "../shared/display.js";
import { aggregateCost, addCostToUsageItem } from "../shared/pricing.js";
import { tokenCompositionSummary } from "../shared/composition.js";
import { dayToUtcDate, localDay, utcDateToDay } from "../shared/date.js";

// ── String / Number Utilities ──

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export function cssEscape(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function clampHour(value) {
  const hour = Number(value ?? 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return 0;
  return hour;
}

export function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
}

export function formatHourLabel(hour) {
  return `${String(clampHour(hour)).padStart(2, "0")}:00`;
}

export function formatTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(value) {
  const date = new Date(value);
  return `${date.toLocaleDateString([], { month: "short", day: "2-digit" })} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit", year: "numeric", timeZone: "UTC" }).format(date);
}

export function formatTrendPeriod(row) {
  if (row?.hour !== undefined) return `${formatDate(row.periodStart)} ${formatHourLabel(row.hour)}`;
  if (row.periodStart === row.periodEnd) return formatDate(row.periodStart);
  return `${formatDate(row.periodStart)} - ${formatDate(row.periodEnd)}`;
}

export function formatAxisLabel(row, grain) {
  if (grain === "hour") {
    const hour = clampHour(row.hour);
    return `<span>${String(hour).padStart(2, "0")}:00</span>`;
  }
  const start = new Date(row.periodStart + "T00:00:00Z");
  const end = new Date(row.periodEnd + "T00:00:00Z");
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  if (grain === "month") {
    return `<span>${start.toLocaleString(undefined, { month: "short", year: "numeric", timeZone: "UTC" })}</span>`;
  }
  if (grain === "week") {
    const startStr = start.toLocaleString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
    const endStr = sameMonth
      ? end.toLocaleString(undefined, { day: "numeric", timeZone: "UTC" })
      : end.toLocaleString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
    return `<span>${startStr}–${endStr}</span>`;
  }
  return `<span>${start.toLocaleString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}</span>`;
}

export function formatDetailBreakdownPeriod(row) {
  if (row?.hour !== undefined) return formatHourLabel(row.hour);
  return formatTrendPeriod(row);
}

// ── Predicates ──

export function hasPositiveUsage(row) {
  return Number(row?.totalTokens || 0) > 0;
}

export function hasConfiguredApiBaseUrl(config) {
  return Boolean(String(config?.apiBaseUrl || "").trim());
}

export function normalizeApiBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

// ── Date Math ──

function toDay(date) {
  return utcDateToDay(date);
}

function utcToday() {
  return dayToUtcDate(localDay());
}

export function startOfUtcWeek(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - weekday + 1);
  return start;
}

export function trailingDays(count) {
  const today = utcToday();
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(today);
    day.setUTCDate(today.getUTCDate() - count + index + 1);
    return toDay(day);
  });
}

export function daysForLastWeeks(count) {
  const today = utcToday();
  const start = startOfUtcWeek(today);
  start.setUTCDate(start.getUTCDate() - ((count - 1) * 7));
  const days = [];
  for (const day = new Date(start); day <= today; day.setUTCDate(day.getUTCDate() + 1)) {
    days.push(toDay(day));
  }
  return days;
}

export function daysForLastMonths(count) {
  const today = utcToday();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - count + 1, 1));
  const days = [];
  for (const day = new Date(start); day <= today; day.setUTCDate(day.getUTCDate() + 1)) {
    days.push(toDay(day));
  }
  return days;
}

export function bucketForDay(day, grain) {
  const date = new Date(`${day}T00:00:00Z`);
  if (grain === "month") {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    return { key: toDay(start), periodStart: toDay(start), periodEnd: toDay(end) };
  }
  if (grain === "week") {
    const start = startOfUtcWeek(date);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    return { key: toDay(start), periodStart: toDay(start), periodEnd: toDay(end) };
  }
  return { key: day, periodStart: day, periodEnd: day };
}

// ── Cost Functions ──

export function renderCostValue(item) {
  if (!item.hasKnownPrice && item.missingPriceTokens > 0) return "-";
  return formatUsd(item.estimatedCostUsd);
}

export function renderCostAmountValue(value) {
  const text = typeof value === "string" ? value : formatUsd(value);
  return `<span class="cost-amount">${escapeHtml(text)}</span>`;
}

export function renderCost(item) {
  const value = renderCostValue(item);
  if (value === "-") return value;
  return `${value}${item.missingPriceTokens ? " *" : ""}`;
}

export function renderCostAmount(item) {
  return renderCostAmountValue(renderCost(item));
}

export function costValueForField(item, field) {
  return {
    inputTokens: item.inputCostUsd,
    outputTokens: item.outputCostUsd,
    cacheTokens: sumKnownCosts(item.cacheReadCostUsd, item.cacheWriteCostUsd),
    cacheReadTokens: item.cacheReadCostUsd,
    cacheWriteTokens: item.cacheWriteCostUsd,
    reasoningTokens: item.reasoningCostUsd
  }[field];
}

export function cacheTokens(item = {}) {
  return Number(item.cacheReadTokens || 0) + Number(item.cacheWriteTokens || 0);
}

export function sumKnownCosts(...values) {
  const known = values.filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
  if (!known.length) return null;
  return known.reduce((sum, value) => sum + Number(value), 0);
}

export function mergeCostQualityForDisplay(left = "", right = "") {
  const rank = { exact_price: 0, estimated_price: 1, unknown_price: 2 };
  if (!left) return right || "";
  if (!right) return left;
  return rank[right] > rank[left] ? right : left;
}

export function costTitle(item, { pricingSource = "", t = (k) => k } = {}) {
  const missing = normalizeMissingPriceModels(item.missingPriceModels).map((model) => `${model.name} ${formatTokenRaw(model.totalTokens)}`).join(", ");
  return `${item.costQuality || t("desktop.renderer.unknownPrice")} · ${item.pricingVersion || t("desktop.renderer.noPricingVersion")} · ${pricingSource}${missing ? ` · ${t("desktop.renderer.missing")}: ${missing}` : ""}`;
}

export function renderAccountingToken(tokens, cost, { showEstimatedCost = false } = {}) {
  const costLine = showEstimatedCost ? `<small>${renderCostAmountValue(cost)}</small>` : "";
  return `<span class="token-accounting">${formatNumber(tokens || 0)}${costLine}</span>`;
}

// ── Data Transforms ──

export function sortedBreakdown(obj) {
  return Object.entries(obj || {})
    .sort((a, b) => b[1] - a[1])
    .map(([name, totalTokens]) => ({ name, totalTokens }));
}

export function finalizeCostBreakdown(map) {
  return Object.values(map || {})
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((item) => ({
      ...item,
      missingPriceModels: sortedBreakdown(item.missingPriceModels || {})
    }));
}

export function addCostBreakdownItem(map, name, item, withCost) {
  const key = name || "unknown";
  const current = map[key] || {
    name: key,
    totalTokens: 0,
    estimatedCostUsd: 0,
    costQuality: "",
    pricingVersion: ""
  };
  current.totalTokens += item.totalTokens || 0;
  aggregateCost(current, withCost);
  map[key] = current;
  return current;
}

export function aggregateUsageCost(items, priceMap) {
  const current = {
    estimatedCostUsd: 0,
    costQuality: "",
    pricingVersion: "",
    missingPriceTokens: 0,
    missingPriceModels: {}
  };
  for (const item of items) {
    const withCost = priceMap ? addCostToUsageItem(item, priceMap) : item;
    aggregateCost(current, withCost);
  }
  return { ...current, missingPriceModels: sortedBreakdown(current.missingPriceModels || {}) };
}

export function aggregateTrendRowCost(rows) {
  const current = {
    estimatedCostUsd: 0,
    costQuality: "",
    pricingVersion: "",
    missingPriceTokens: 0,
    missingPriceModels: {}
  };
  for (const row of rows) {
    if (row.hasKnownPrice) {
      current.hasKnownPrice = true;
      current.estimatedCostUsd += row.estimatedCostUsd || 0;
      current.costQuality = mergeCostQualityForDisplay(current.costQuality, row.costQuality);
      current.pricingVersion ||= row.pricingVersion || "";
    }
    for (const item of row.missingPriceModels || []) {
      current.missingPriceModels[item.name] = (current.missingPriceModels[item.name] || 0) + (item.totalTokens || 0);
      current.missingPriceTokens += item.totalTokens || 0;
      current.costQuality = mergeCostQualityForDisplay(current.costQuality, "unknown_price");
    }
  }
  current.missingPriceModels = sortedBreakdown(current.missingPriceModels);
  return current;
}

export function normalizeMissingPriceModels(value) {
  if (Array.isArray(value)) return value;
  return sortedBreakdown(value || {});
}

export function trendBucketKey(row) {
  return `${row.periodStart}|${row.periodEnd}`;
}

export function emptyTrendRow(extra = {}) {
  return {
    periodStart: "",
    periodEnd: "",
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
    costQuality: "",
    pricingVersion: "",
    totalTokens: 0,
    modelBreakdownMap: {},
    workdirBreakdownMap: {},
    ...extra
  };
}

export function summaryLabel(items = []) {
  if (!items.length) return "-";
  const top = items.slice(0, 2).map((item) => item.name).join(", ");
  return items.length > 2 ? `${top} +${items.length - 2}` : top;
}

export function summaryTitle(items = []) {
  return items.map((item) => `${item.name} ${formatTokenRaw(item.totalTokens)}`).join(", ");
}

// ── Normalization ──

export function positiveInteger(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

export function normalizeTokenAggregate(item = {}) {
  const inputTokens = positiveInteger(item.inputTokens);
  const outputTokens = positiveInteger(item.outputTokens);
  const cacheReadTokens = positiveInteger(item.cacheReadTokens);
  const cacheWriteTokens = positiveInteger(item.cacheWriteTokens);
  const reasoningTokens = positiveInteger(item.reasoningTokens);
  const explicitTotal = positiveInteger(item.totalTokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: explicitTotal || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  };
}

export function normalizeBreakdownItems(items = []) {
  return items
    .map((item) => ({
      ...normalizeTokenAggregate(item),
      name: item.name || "unknown",
      rows: positiveInteger(item.rows)
    }))
    .filter(hasPositiveUsage)
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

export function normalizeUsageSummary(summary = {}) {
  return {
    ...summary,
    totals: normalizeTokenAggregate(summary.totals || {}),
    providers: normalizeBreakdownItems(summary.providers || []),
    workdirs: normalizeBreakdownItems(summary.workdirs || []),
    models: normalizeBreakdownItems(summary.models || [])
  };
}

export function normalizeUsageTrend(trend = {}) {
  return {
    ...trend,
    items: (trend.items || []).map((item) => {
      const aggregate = normalizeTokenAggregate(item);
      return {
        periodStart: item.periodStart || item.day || "",
        periodEnd: item.periodEnd || item.periodStart || item.day || "",
        ...(item.hour === null || item.hour === undefined ? {} : { hour: clampHour(Number(item.hour)) }),
        ...aggregate,
        compositionSummary: tokenCompositionSummary(aggregate),
        modelBreakdown: [],
        workdirBreakdown: [],
        detailBreakdown: [],
        modelDetails: []
      };
    }).filter(hasPositiveUsage)
  };
}

export function normalizeUsageWorkdirs(workdirs = {}) {
  return {
    ...workdirs,
    items: (workdirs.items || []).map((item) => ({
      ...normalizeTokenAggregate(item),
      workdirHash: item.workdirHash || item.name || "unknown",
      name: item.name || item.workdirDisplayName || "unknown",
      rows: positiveInteger(item.rows)
    })).filter(hasPositiveUsage)
  };
}

export function normalizeUsageTotal(item) {
  const inputTokens = positiveInteger(item.inputTokens);
  const outputTokens = positiveInteger(item.outputTokens);
  return {
    ...item,
    inputTokens,
    outputTokens,
    cacheReadTokens: positiveInteger(item.cacheReadTokens),
    cacheWriteTokens: positiveInteger(item.cacheWriteTokens),
    reasoningTokens: positiveInteger(item.reasoningTokens),
    totalTokens: inputTokens + positiveInteger(item.cacheReadTokens) + positiveInteger(item.cacheWriteTokens) + outputTokens
  };
}

export function reconcileHealthWithConfig(health = [], config) {
  if (!config?.providerRoots) return health;
  return health.map((item) => {
    if (!["codex_local", "claude_code_local"].includes(item.providerId)) return item;
    const manualRoots = config.providerRoots?.[item.providerId] || [];
    const existingSources = item.sources || [];
    const existingManualByPath = new Map(
      existingSources
        .filter((source) => source.kind === "manual")
        .map((source) => [source.path || source.id, source])
    );
    const nonManualSources = existingSources.filter((source) => source.kind !== "manual");
    const manualSources = manualRoots.map((root) => ({
      kind: "manual",
      id: root,
      label: existingManualByPath.get(root)?.label || root,
      path: root,
      ignored: false
    }));
    const sourceIds = new Set([...nonManualSources, ...manualSources].map((source) => source.path || source.id).filter(Boolean));
    const roots = (item.roots || []).filter((root) => sourceIds.has(root));
    for (const root of manualRoots) {
      if (!roots.includes(root)) roots.push(root);
    }
    return {
      ...item,
      roots,
      sources: [...nonManualSources, ...manualSources],
      detected: roots.length > 0,
      ok: roots.length > 0
    };
  });
}

const UI_PROVIDER_ORDER = [
  "claude_code_local",
  "codex_local",
  "cursor_dashboard_usage",
  "opencode_local",
  "openclaw_local",
  "hermes_local",
  "mimocode_local",
  "zcode_local",
  "workbuddy_local",
  "dsh_local",
  "kimi_local"
];

export function sortProviderHealth(health = []) {
  return [...health].sort((a, b) => {
    const ia = UI_PROVIDER_ORDER.indexOf(a.providerId);
    const ib = UI_PROVIDER_ORDER.indexOf(b.providerId);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}

// Status group for the Sources screen provider nav:
// 1 = enabled && detected && ok (healthy, green dot)
// 2 = enabled && (not detected or not ok) (needs attention, warn dot)
// 3 = disabled (muted, gray dot)
// Within each group, UI_PROVIDER_ORDER wins; unknown providers go last sorted by providerId.
export function providerStatusGroup(item) {
  const enabled = item?.enabled !== false;
  if (!enabled) return 3;
  if (item?.detected && item?.ok !== false) return 1;
  return 2;
}

export function sortProviderHealthByStatus(health = []) {
  return [...health].sort((a, b) => {
    const ga = providerStatusGroup(a);
    const gb = providerStatusGroup(b);
    if (ga !== gb) return ga - gb;
    const ia = UI_PROVIDER_ORDER.indexOf(a.providerId);
    const ib = UI_PROVIDER_ORDER.indexOf(b.providerId);
    const oa = ia === -1 ? UI_PROVIDER_ORDER.length : ia;
    const ob = ib === -1 ? UI_PROVIDER_ORDER.length : ib;
    if (oa !== ob) return oa - ob;
    return String(a.providerId || "").localeCompare(String(b.providerId || ""));
  });
}
