import { t, getCurrentLang } from "/shared/i18n.js";

const PERIOD_LABEL_KEYS = {
  today: "web.period.today",
  yesterday: "web.period.yesterday",
  this_week: "web.period.thisWeek",
  last_week: "web.period.lastWeek",
  this_month: "web.period.thisMonth",
  last_month: "web.period.lastMonth",
  all: "web.period.all"
};

function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseDay(day = "") {
  const match = String(day).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]), raw: match[0] };
}

function toDay(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function fromParts(y, m, d) {
  return new Date(y, m - 1, d);
}

export function resolvePeriodBounds(period, businessDay = "") {
  const parts = parseDay(businessDay);
  if (!parts) return { from: "", to: "", businessDay: businessDay || "" };
  const anchor = fromParts(parts.y, parts.m, parts.d);
  if (period === "today") {
    const day = toDay(anchor);
    return { from: day, to: day, businessDay: parts.raw };
  }
  if (period === "yesterday") {
    const y = new Date(anchor);
    y.setDate(y.getDate() - 1);
    const day = toDay(y);
    return { from: day, to: day, businessDay: parts.raw };
  }
  if (period === "this_week" || period === "last_week") {
    const day = new Date(anchor);
    const weekday = (day.getDay() + 6) % 7;
    day.setDate(day.getDate() - weekday);
    if (period === "last_week") day.setDate(day.getDate() - 7);
    const from = toDay(day);
    const end = new Date(day);
    end.setDate(end.getDate() + 6);
    if (period === "this_week" && end > anchor) return { from, to: parts.raw, businessDay: parts.raw };
    return { from, to: toDay(end), businessDay: parts.raw };
  }
  if (period === "this_month") {
    const from = `${parts.y}-${pad2(parts.m)}-01`;
    return { from, to: parts.raw, businessDay: parts.raw };
  }
  if (period === "last_month") {
    const first = fromParts(parts.y, parts.m, 1);
    first.setMonth(first.getMonth() - 1);
    const from = toDay(first);
    const end = fromParts(parts.y, parts.m, 1);
    end.setDate(0);
    return { from, to: toDay(end), businessDay: parts.raw };
  }
  return { from: "", to: parts.raw, businessDay: parts.raw };
}

export function formatDayShort(day = "") {
  const parts = parseDay(day);
  if (!parts) return "";
  return `${pad2(parts.m)}.${pad2(parts.d)}`;
}

export function formatMonthLabel(dayOrMonth = "") {
  const text = String(dayOrMonth || "");
  const month = text.length >= 7 ? text.slice(5, 7) : "";
  if (!month) return "";
  const lang = getCurrentLang();
  return lang === "zh-CN" ? `${Number(month)} 月` : text.slice(0, 7);
}

export function formatPeriodCaption(period, { from = "", to = "", businessDay = "" } = {}) {
  const bounds = (!from || !to) ? resolvePeriodBounds(period, businessDay || to || from) : { from, to, businessDay };
  const label = t(PERIOD_LABEL_KEYS[period] || "web.period.all");
  if (period === "today" || period === "yesterday") {
    const day = formatDayShort(bounds.to || bounds.from || businessDay);
    return day ? `${label} · ${day}` : label;
  }
  if (period === "this_week" || period === "last_week") {
    const start = formatDayShort(bounds.from);
    const end = formatDayShort(bounds.to || businessDay);
    return start && end ? `${label} · ${start}–${end}` : label;
  }
  if (period === "this_month" || period === "last_month") {
    const month = formatMonthLabel(bounds.from || bounds.to || businessDay);
    return month ? `${label} · ${month}` : label;
  }
  if (bounds.from && bounds.to) return `${label} · ${bounds.from}–${bounds.to}`;
  return label;
}

export function updatePeriodPillCaptions(root = document, meta = {}) {
  root.querySelectorAll("[data-filter='period'] button[data-value]").forEach((button) => {
    const period = button.dataset.value;
    const base = t(PERIOD_LABEL_KEYS[period] || "web.period.all");
    const active = button.classList.contains("active");
    button.dataset.baseLabel = base;
    button.textContent = active ? formatPeriodCaption(period, meta) : base;
  });
}

export function ensureToastHost() {
  let toast = document.querySelector(".console-toast");
  if (toast) return toast;
  toast = document.createElement("div");
  toast.className = "console-toast";
  toast.hidden = true;
  toast.setAttribute("role", "status");
  document.body.appendChild(toast);
  return toast;
}

export function showToast(message, ms = 2600) {
  const toast = ensureToastHost();
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.hidden = true;
  }, ms);
}

export function downloadCsv(filename, rows) {
  const blob = new Blob([`\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`], {
    type: "text/csv;charset=utf-8;"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

const detailConfigs = new WeakMap();
let detailDelegationBound = false;

function ensureDetailDelegation() {
  if (detailDelegationBound) return;
  detailDelegationBound = true;
  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("button.panel-action[data-detail-kind], button[data-detail-kind]");
    if (!button) return;
    const config = detailConfigs.get(button);
    if (!config) return;
    event.preventDefault();
    toggleDetailPanel(button, config);
  });
}

function toggleDetailPanel(button, { buildRows, kind = "detail" } = {}) {
  const panel = button.closest(".card, .panel, article, section") || button.parentElement;
  if (!panel) return;

  let box = panel.querySelector(`.detail-panel[data-kind="${kind}"]`);
  const opening = !box || box.hidden;

  if (!box) {
    box = document.createElement("div");
    box.className = "detail-panel";
    box.dataset.kind = kind;
    panel.appendChild(box);
  }

  if (opening) {
    try {
      const built = typeof buildRows === "function" ? buildRows() : null;
      const head = built?.head || [];
      const rows = built?.rows || [];
      box.innerHTML = renderDetailTable(head, rows);
    } catch (error) {
      console.error("detail panel render failed", error);
      box.innerHTML = `<div class="meter-empty">${t("web.analytics.noData")}</div>`;
    }
    box.hidden = false;
    button.setAttribute("aria-expanded", "true");
    button.textContent = button.dataset.closeLabel || t("web.console.hideDetail");
    return;
  }

  box.hidden = true;
  button.setAttribute("aria-expanded", "false");
  button.textContent = button.dataset.openLabel || t("web.console.viewDetail");
}

/**
 * 绑定明细展开按钮。使用 document 委托，避免节点替换或重复绑定时失效。
 */
export function bindDetailToggle(button, { buildRows, kind = "detail" } = {}) {
  if (!button) return;
  button.dataset.detailKind = kind;
  button.setAttribute("aria-expanded", button.getAttribute("aria-expanded") || "false");
  if (!button.dataset.openLabel) {
    button.dataset.openLabel = button.textContent.trim() || t("web.console.viewDetail");
  }
  if (!button.dataset.closeLabel) {
    button.dataset.closeLabel = t("web.console.hideDetail");
  }
  detailConfigs.set(button, { buildRows, kind });
  button.dataset.boundDetail = "1";
  ensureDetailDelegation();
}

export function renderDetailTable(head = [], rows = []) {
  if (!rows.length) {
    return `<div class="meter-empty">${t("web.analytics.noData")}</div>`;
  }
  return `<table><thead><tr>${head.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

export function formatSyncStamp(isoOrDay = "") {
  const raw = String(isoOrDay || "");
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const now = new Date();
    return `${raw} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export { PERIOD_LABEL_KEYS };
