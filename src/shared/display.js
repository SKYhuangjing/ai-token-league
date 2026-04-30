export function formatTokenCompact(value, locale = "zh-CN") {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (locale.startsWith("zh")) {
    if (abs >= 100_000_000) return `${Number(n / 100_000_000).toFixed(abs >= 1_000_000_000 ? 1 : 2)}亿`;
    if (abs >= 10_000) return `${trimFixed(n / 10_000, abs >= 10_000_000 ? 0 : 1)}万`;
    return new Intl.NumberFormat("zh-CN").format(n);
  }
  return new Intl.NumberFormat(locale || undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function formatTokenRaw(value, locale = undefined) {
  return `${new Intl.NumberFormat(locale).format(value || 0)} tokens`;
}

export function formatUsd(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  const n = Number(value);
  if (n > 0 && n < 0.01) return "<$0.01";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
}

function trimFixed(value, digits) {
  return Number(value).toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}
