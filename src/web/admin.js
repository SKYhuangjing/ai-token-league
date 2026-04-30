const state = {
  grainMode: "auto",
  grain: "day",
  range: "month",
  start: "",
  end: "",
  participantId: "",
  rawTokens: false,
  showCost: false
};
const tbody = document.querySelector("#leaderboard");
const statusEl = document.querySelector("#status");
const detailBoard = document.querySelector("#detail-board");
const detailBackdrop = document.querySelector("#admin-detail-backdrop");
const participantFilter = document.querySelector("#participant-filter");
const pricingStatus = document.querySelector("#pricing-status");

document.querySelector(".admin-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  document.querySelectorAll("[data-admin-tab]").forEach((item) => item.classList.remove("active"));
  document.querySelectorAll("[data-admin-panel]").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  document.querySelector(`[data-admin-panel="${button.dataset.adminTab}"]`).classList.add("active");
});

document.querySelector("[data-filter='quick-range']").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  setActive(event.currentTarget, button);
  state.range = button.dataset.value;
  state.start = "";
  state.end = "";
  updateAutoGrain();
  syncRangeInputs();
  loadUsage();
});

document.querySelector("[data-filter='grain']").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  setActive(event.currentTarget, button);
  state.grainMode = button.dataset.value;
  updateAutoGrain();
  loadUsage();
});

participantFilter.addEventListener("change", () => {
  state.participantId = participantFilter.value;
  loadUsage();
});

document.querySelector("#apply-custom-range").addEventListener("click", () => {
  state.range = "custom";
  state.start = document.querySelector("#start-date").value;
  state.end = document.querySelector("#end-date").value;
  document.querySelectorAll("[data-filter='quick-range'] button").forEach((item) => item.classList.remove("active"));
  updateAutoGrain();
  syncRangeInputs();
  loadUsage();
});

document.querySelector("#raw-tokens").addEventListener("change", (event) => {
  state.rawTokens = event.target.checked;
  loadUsage();
});

document.querySelector("#show-cost").addEventListener("change", (event) => {
  state.showCost = event.target.checked;
  document.querySelectorAll(".cost-col").forEach((item) => {
    item.hidden = !state.showCost;
  });
  loadUsage();
});

document.querySelector("#close-admin-detail").addEventListener("click", closeDetail);
detailBackdrop.addEventListener("click", closeDetail);

document.querySelector("#pricing-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  pricingStatus.textContent = "Saving...";
  const body = {
    model: document.querySelector("#price-model").value,
    inputCostPerMTok: document.querySelector("#price-input").value,
    outputCostPerMTok: document.querySelector("#price-output").value,
    cacheReadCostPerMTok: document.querySelector("#price-cache-read").value,
    cacheWriteCostPerMTok: document.querySelector("#price-cache-write").value,
    reasoningCostPerMTok: document.querySelector("#price-reasoning").value,
    source: "admin"
  };
  const response = await fetch("/api/admin/model-prices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error((await response.json()).error || "failed to save model price");
  event.target.reset();
  await loadPricing();
  await loadUsage();
});

async function loadUsage() {
  updateAutoGrain();
  syncRangeInputs();
  statusEl.textContent = "Loading...";
  const response = await fetch(`/api/admin/usage?${queryString()}`);
  const data = await response.json();
  renderParticipantOptions(data.participants || []);
  render(data.items || []);
  statusEl.textContent = `${data.items.length} aggregate row${data.items.length === 1 ? "" : "s"} · ${data.from || "-"} to ${data.to || "-"}`;
}

async function loadPricing() {
  const response = await fetch("/api/admin/model-prices");
  const data = await response.json();
  renderPricing(data);
}

function renderPricing(data) {
  const missing = data.missingModels || [];
  const custom = data.custom || [];
  pricingStatus.textContent = `${missing.length} missing model${missing.length === 1 ? "" : "s"} · ${custom.length} custom price${custom.length === 1 ? "" : "s"}`;
  document.querySelector("#missing-prices").innerHTML = missing.length
    ? missing
        .map((item) => `<button class="price-suggestion" type="button" data-model="${escapeHtml(item.model)}" title="${escapeHtml(renderProviderTitle(item.providers))}">
          <strong>${escapeHtml(item.model)}</strong>
          <span>${formatToken(item.totalTokens)}</span>
        </button>`)
        .join("")
    : `<article class="empty-state">No missing prices in this month.</article>`;
  document.querySelectorAll("[data-model]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelector("#price-model").value = button.dataset.model;
      document.querySelector("#price-model").focus();
    });
  });
  document.querySelector("#custom-prices").innerHTML = custom.length
    ? custom
        .map((item) => `<article class="price-row">
          <strong>${escapeHtml(item.model)}</strong>
          <span>in ${formatUsdPerMillion(item.inputCostPerMTok)} · out ${formatUsdPerMillion(item.outputCostPerMTok)}</span>
          <button type="button" data-delete-price="${escapeHtml(item.model)}">Delete</button>
        </article>`)
        .join("")
    : `<article class="empty-state">No custom model prices yet.</article>`;
  document.querySelectorAll("[data-delete-price]").forEach((button) => {
    button.addEventListener("click", async () => {
      pricingStatus.textContent = "Deleting...";
      await fetch(`/api/admin/model-prices/${encodeURIComponent(button.dataset.deletePrice)}`, { method: "DELETE" });
      await loadPricing();
      await loadUsage();
    });
  });
}

function renderParticipantOptions(participants) {
  const current = participantFilter.value;
  participantFilter.innerHTML = `<option value="">All users</option>${participants
    .map((item) => `<option value="${escapeHtml(item.participantId)}">${escapeHtml(item.nickname)}</option>`)
    .join("")}`;
  participantFilter.value = current;
}

function render(items) {
  if (!items.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="${state.showCost ? 8 : 7}">No usage uploaded for this query.</td></tr>`;
    return;
  }
  tbody.innerHTML = items
    .map(
      (item) => `<tr>
        <td>${formatPeriod(item)}</td>
        <td><button class="link-button" data-participant="${escapeHtml(item.participantId)}">${escapeHtml(item.nickname)}</button></td>
        <td class="tokens" title="${formatTokenRaw(item.totalTokens)}">${formatToken(item.totalTokens)}</td>
        ${state.showCost ? `<td class="tokens" title="${escapeHtml(costTitle(item))}">${renderCost(item)}</td>` : ""}
        <td>${renderBreakdown(item.workdirs)}</td>
        <td>${renderBreakdown(item.models)}</td>
        <td>${renderBreakdown(item.providers)}</td>
        <td>${renderQuality(item.sourceQuality)}</td>
      </tr>`
    )
    .join("");
  tbody.querySelectorAll("[data-participant]").forEach((button) => {
    button.addEventListener("click", () => loadDetail(button.dataset.participant));
  });
}

async function loadDetail(participantId) {
  detailBoard.hidden = false;
  detailBackdrop.hidden = false;
  document.body.classList.add("detail-open");
  document.querySelector("#detail-status").textContent = "Loading...";
  const response = await fetch(`/api/participants/${encodeURIComponent(participantId)}?${queryString()}`);
  const detail = await response.json();
  document.querySelector("#detail-title").textContent = `${detail.nickname} detail`;
  document.querySelector("#detail-status").textContent = `${formatToken(detail.totalTokens)} tokens`;
  document.querySelector("#detail-workdirs").innerHTML = renderBars(detail.workdirs);
  document.querySelector("#detail-days").innerHTML = renderBars((detail.periodRows || []).map((item) => ({ ...item, name: formatPeriod(item) })));
  document.querySelector("#detail-rows").innerHTML = detail.rows
    .map((row) => `<tr>
      <td>${escapeHtml(row.day)}</td>
      <td>${escapeHtml(row.workdirDisplayName)}</td>
      <td>${escapeHtml(row.model)}</td>
      <td class="tokens" title="${formatTokenRaw(row.totalTokens)}">${formatToken(row.totalTokens)}</td>
      ${state.showCost ? `<td class="tokens" title="${escapeHtml(costTitle(row))}">${renderCost(row)}</td>` : ""}
      <td>${renderQuality(row.sourceQuality)}</td>
    </tr>`)
    .join("");
}

function closeDetail() {
  detailBoard.hidden = true;
  detailBackdrop.hidden = true;
  document.body.classList.remove("detail-open");
}

function queryString() {
  const params = new URLSearchParams({
    grain: state.grain,
    range: state.range
  });
  if (state.participantId) params.set("participantId", state.participantId);
  if (state.showCost) params.set("includeCost", "1");
  if (state.range === "custom") {
    if (state.start) params.set("start", state.start);
    if (state.end) params.set("end", state.end);
  }
  return params.toString();
}

function setActive(group, button) {
  group.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
}

function updateAutoGrain() {
  state.grain = state.grainMode === "auto" ? autoGrain() : state.grainMode;
}

function autoGrain() {
  if (state.range === "last_month") return "week";
  if (state.range === "custom") {
    const span = daySpan(state.start, state.end);
    if (span > 120) return "month";
    if (span > 31) return "week";
  }
  return "day";
}

function syncRangeInputs() {
  const { start, end, label } = selectedRange();
  if (state.range !== "custom") {
    document.querySelector("#start-date").value = start;
    document.querySelector("#end-date").value = end;
  }
  document.querySelector("#date-range-display").textContent = `${label} · ${state.grain}`;
}

function selectedRange() {
  if (state.range === "custom") {
    return { start: state.start || "", end: state.end || "", label: `${state.start || "-"} - ${state.end || "-"}` };
  }
  const today = utcToday();
  if (state.range === "today") return { start: toDay(today), end: toDay(today), label: "Today" };
  if (state.range === "last7") return trailingRange(7, "Last 7 days");
  if (state.range === "last30") return trailingRange(30, "Last 30 days");
  if (state.range === "last_month") return monthRange(-1, "Last month");
  return monthRange(0, "MTD");
}

function trailingRange(count, label) {
  const end = utcToday();
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - count + 1);
  return { start: toDay(start), end: toDay(end), label };
}

function monthRange(offset, label) {
  const today = utcToday();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + offset, 1));
  const end = offset === 0 ? today : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return { start: toDay(start), end: toDay(end), label };
}

function daySpan(start, end) {
  if (!start || !end) return 0;
  return Math.max(1, Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000) + 1);
}

function utcToday() {
  return dayToUtcDate(localDay());
}

function toDay(date) {
  return utcDateToDay(date);
}

function localDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dayToUtcDate(day) {
  const [year, month, date] = String(day || "").split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date));
}

function utcDateToDay(date) {
  return date.toISOString().slice(0, 10);
}

function renderBreakdown(items = []) {
  return items
    .map((item) => `<span class="pill" title="${formatTokenRaw(item.totalTokens)}">${escapeHtml(item.name)} ${formatToken(item.totalTokens)}</span>`)
    .join("");
}

function renderBars(items = []) {
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  return items
    .map((item) => `<div class="bar-row" title="${escapeHtml(chartItemTitle(item))}">
      <span>${escapeHtml(item.name)}</span>
      <strong title="${escapeHtml(chartItemTitle(item))}">${formatToken(item.totalTokens)}${state.showCost ? ` · ${renderCost(item)}` : ""}</strong>
      <i style="width:${Math.max(3, (item.totalTokens / max) * 100)}%"></i>
    </div>`)
    .join("");
}

function renderQuality(value) {
  const label = value === "exact" ? "完整字段" : "部分字段";
  const title = value === "exact" ? "工具日志提供了明确 token 字段" : "部分 token 字段缺失或只能按可用 usage 字段统计";
  return `<span class="pill" title="${escapeHtml(title)}">${label}</span>`;
}

function formatPeriod(item) {
  return item.periodStart === item.periodEnd ? item.periodStart : `${item.periodStart} - ${item.periodEnd}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
}

function formatToken(value) {
  return state.rawTokens ? formatNumber(value) : formatTokenCompact(value);
}

function formatTokenCompact(value) {
  const n = Number(value || 0);
  const abs = Math.abs(n);
  if (abs >= 100_000_000) return `${Number(n / 100_000_000).toFixed(abs >= 1_000_000_000 ? 1 : 2)}亿`;
  if (abs >= 10_000) return `${trimFixed(n / 10_000, abs >= 10_000_000 ? 0 : 1)}万`;
  return formatNumber(n);
}

function formatTokenRaw(value) {
  return `${formatNumber(value)} tokens`;
}

function formatCost(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  const n = Number(value);
  if (n > 0 && n < 0.01) return "<$0.01";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
}

function costTitle(item) {
  const missing = (item.missingPriceModels || []).map((model) => `${model.name} ${formatTokenRaw(model.totalTokens)}`).join(", ");
  return `${item.costQuality || "unknown_price"} · ${item.pricingVersion || "no pricing version"}${missing ? ` · missing: ${missing}` : ""}`;
}

function renderCost(item) {
  const value = formatCost(item.estimatedCostUsd);
  if (value === "-") return value;
  return `${value}${item.missingPriceTokens ? `<sup title="Some model prices are missing">*</sup>` : ""}`;
}

function chartItemTitle(item) {
  const cost = state.showCost ? ` · cost ${renderCost(item).replace(/<[^>]+>/g, "")}` : "";
  return `${item.name || item.day || ""} · ${formatTokenRaw(item.totalTokens)}${cost}`;
}

function formatUsdPerMillion(value) {
  return `$${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}/1M`;
}

function renderProviderTitle(items = []) {
  return items.map((item) => `${item.name}: ${formatTokenRaw(item.totalTokens)}`).join(", ");
}

function trimFixed(value, digits) {
  return Number(value).toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

loadUsage().catch((error) => {
  statusEl.textContent = error.message;
});
loadPricing().catch((error) => {
  pricingStatus.textContent = error.message;
});
