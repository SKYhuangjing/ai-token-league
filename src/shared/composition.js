import { t } from "./i18n.js";

export const TOKEN_COMPOSITION_FIELDS = [
  ["inputTokens", "common.input"],
  ["outputTokens", "common.output"],
  ["cacheReadTokens", "common.cacheRead"],
  ["cacheWriteTokens", "common.cacheWrite"],
  ["reasoningTokens", "common.reasoning"]
];

export const COST_COMPOSITION_FIELDS = [
  ["inputCostUsd", "common.input"],
  ["outputCostUsd", "common.output"],
  ["cacheReadCostUsd", "common.cacheRead"],
  ["cacheWriteCostUsd", "common.cacheWrite"],
  ["reasoningCostUsd", "common.reasoning"]
];

export function createEmptyComposition() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };
}

export function mergeTokenComposition(target, source = {}) {
  for (const [field] of TOKEN_COMPOSITION_FIELDS) {
    target[field] = Number(target[field] || 0) + Number(source[field] || 0);
  }
  target.totalTokens = Number(target.totalTokens || 0) + Number(source.totalTokens || 0);
  return target;
}

export function compositionRatio(value, total) {
  const left = Number(value || 0);
  const right = Number(total || 0);
  if (!Number.isFinite(left) || !Number.isFinite(right) || right <= 0) return 0;
  return left / right;
}

export function tokenCompositionSummary(item = {}) {
  const total = Number(item.totalTokens || 0);
  if (!total) return t("common.noComposition");
  const cacheTokens = Number(item.cacheReadTokens || 0) + Number(item.cacheWriteTokens || 0);
  const parts = [
    [t("common.in"), item.inputTokens],
    [t("common.out"), item.outputTokens],
    [t("common.cache"), cacheTokens],
    [t("common.reasoning"), item.reasoningTokens]
  ];
  return parts
    .filter(([, value]) => Number(value || 0) > 0)
    .map(([label, value]) => `${label} ${Math.round(compositionRatio(value, total) * 100)}%`)
    .join(" · ");
}

export function tokenCompositionDetails(item = {}) {
  const total = Number(item.totalTokens || 0);
  return TOKEN_COMPOSITION_FIELDS.map(([field, labelKey]) => ({
    field,
    label: t(labelKey),
    tokens: Number(item[field] || 0),
    ratio: compositionRatio(item[field], total)
  }));
}

export function dominantComposition(item = {}) {
  const ranked = [
    ["input-heavy", Number(item.inputTokens || 0)],
    ["output-heavy", Number(item.outputTokens || 0)],
    ["cache-heavy", Number(item.cacheReadTokens || 0) + Number(item.cacheWriteTokens || 0)],
    ["reasoning-heavy", Number(item.reasoningTokens || 0)]
  ].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[1] ? ranked[0][0] : "no-usage";
}

export function costQualityLabel(value = "") {
  if (value === "exact_price") return t("common.exact");
  if (value === "estimated_price") return t("common.estimated");
  return t("common.missingPrice");
}
