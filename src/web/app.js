const state = {
  period: "today",
  detailParticipantId: "",
  detailTab: "period",
  historyView: "daily",
  showCost: false
};

const tbody = document.querySelector("#leaderboard");
const statusEl = document.querySelector("#status");
const detailEl = document.querySelector("#participant-detail");
const detailBackdrop = document.querySelector("#detail-backdrop");

document.querySelectorAll("[data-filter='period']").forEach((group) => {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    setActive(group, button);
    state.period = button.dataset.value;
    loadLeaderboard();
    if (state.detailParticipantId) loadDetail(state.detailParticipantId);
  });
});

document.querySelector("[data-detail-tab]").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || !state.detailParticipantId) return;
  setActive(event.currentTarget, button);
  state.detailTab = button.dataset.value;
  renderDetailPanels();
  if (state.detailTab === "history") loadHistory(state.detailParticipantId);
});

document.querySelector("[data-history-view]").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || !state.detailParticipantId) return;
  setActive(event.currentTarget, button);
  state.historyView = button.dataset.value;
  loadHistory(state.detailParticipantId);
});

document.querySelector("#close-detail").addEventListener("click", closeDetail);
detailBackdrop.addEventListener("click", closeDetail);

document.querySelector("#show-cost").addEventListener("change", (event) => {
  state.showCost = event.target.checked;
  document.querySelectorAll(".cost-col").forEach((item) => {
    item.hidden = !state.showCost;
  });
  loadLeaderboard();
  if (state.detailParticipantId) loadDetail(state.detailParticipantId);
});

async function loadLeaderboard() {
  statusEl.textContent = "Loading...";
  const params = new URLSearchParams({ period: state.period });
  if (state.showCost) params.set("includeCost", "1");
  const response = await fetch(`/api/public-leaderboard?${params.toString()}`);
  const data = await response.json();
  render(data.items || []);
  statusEl.textContent = `${data.items.length} ranked participant${data.items.length === 1 ? "" : "s"}`;
}

function render(items) {
  if (!items.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="${state.showCost ? 4 : 3}">No usage uploaded yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = items
    .map(
      (item) => `<tr>
        <td>
          <span class="rank">#${item.rank}</span>
          <button class="link-button participant-link" data-participant="${escapeHtml(item.participantId)}">
            ${escapeHtml(item.nickname)}
          </button>
        </td>
        <td class="tokens" title="${formatTokenRaw(item.totalTokens)}">${formatTokenCompact(item.totalTokens)}</td>
        ${state.showCost ? `<td class="tokens" title="${escapeHtml(costTitle(item))}">${renderCost(item)}</td>` : ""}
        <td>${renderModels(item.models)}</td>
      </tr>`
    )
    .join("");
  tbody.querySelectorAll("[data-participant]").forEach((button) => {
    button.addEventListener("click", () => loadDetail(button.dataset.participant));
  });
}

async function loadDetail(participantId) {
  state.detailParticipantId = participantId;
  state.detailTab = "period";
  setActive(document.querySelector("[data-detail-tab]"), document.querySelector("[data-detail-tab] [data-value='period']"));
  detailEl.hidden = false;
  detailBackdrop.hidden = false;
  document.body.classList.add("detail-open");
  document.querySelector("#detail-status").textContent = "Loading...";
  const params = new URLSearchParams({ period: state.period });
  if (state.showCost) params.set("includeCost", "1");
  const response = await fetch(`/api/participants/${encodeURIComponent(participantId)}?${params.toString()}`);
  const detail = await response.json();
  document.querySelector("#detail-title").textContent = `${detail.nickname} · ${periodLabel(state.period)}`;
  document.querySelector("#detail-status").textContent = `${formatPeriodRange(detail.from, detail.to)} · leaderboard period detail`;
  renderDetail(detail);
}

async function loadHistory(participantId) {
  document.querySelector("#detail-status").textContent = "Loading history...";
  const params = new URLSearchParams(historyParams(state.historyView));
  if (state.showCost) params.set("includeCost", "1");
  const response = await fetch(`/api/participants/${encodeURIComponent(participantId)}/trend?${params.toString()}`);
  const detail = await response.json();
  document.querySelector("#detail-status").textContent = `${historyLabel(state.historyView)} · ${detail.from || "-"} to ${detail.to || "-"}`;
  renderHistory(detail.items || []);
}

function renderDetail(detail) {
  renderDetailPanels();
  document.querySelector("#detail-summary").innerHTML = renderSummary(detail);
  document.querySelector("#period-chart").innerHTML = detail.isSingleDay
    ? `<article class="empty-state">Single-day leaderboard periods are explained by composition, not a trend chart.</article>`
    : detail.periodRows?.length
      ? renderCompactTrend([...detail.periodRows].reverse(), { topTitle: "Top date contribution" })
      : `<article class="empty-state">No usage in this period.</article>`;
  document.querySelector("#detail-models").innerHTML = renderBreakdownBars(detail.models);
  document.querySelector("#detail-workdirs").innerHTML = renderBreakdownBars(detail.workdirs);
  document.querySelector("#detail-sources").innerHTML = renderBreakdownBars(detail.providers?.map((item) => ({ ...item, name: sourceName(item.name) })));
  renderRawRows(detail.rows || [], { mode: "period" });
}

function renderHistory(items) {
  document.querySelector("#history-chart").innerHTML = items.length
    ? renderCompactTrend([...items].reverse(), { topTitle: "Top period contribution" })
    : `<article class="empty-state">No usage in this history window.</article>`;
  renderRawRows(items, { mode: "history" });
}

function closeDetail() {
  state.detailParticipantId = "";
  detailEl.hidden = true;
  detailBackdrop.hidden = true;
  document.body.classList.remove("detail-open");
}

function renderDetailPanels() {
  const isHistory = state.detailTab === "history";
  document.querySelector("[data-history-view]").hidden = !isHistory;
  document.querySelector("#period-detail-panel").hidden = isHistory;
  document.querySelector("#history-trend-panel").hidden = !isHistory;
}

function renderSummary(detail) {
  const items = [
    ["Rank", detail.rank ? `#${detail.rank}` : "-"],
    ["Period tokens", formatTokenCompact(detail.totalTokens), formatTokenRaw(detail.totalTokens)],
    ["Models", String(detail.models?.length || 0)],
    ["Workdirs", String(detail.workdirs?.length || 0)]
  ];
  if (state.showCost) items.push(["Est. cost", renderCost(detail), costTitle(detail)]);
  return items
    .map(([label, value, title]) => `<article class="summary-tile"${title ? ` title="${escapeHtml(title)}"` : ""}>
      <span>${escapeHtml(label)}</span>
      <strong>${value}</strong>
    </article>`)
    .join("");
}

function renderRawRows(items, { mode }) {
  document.querySelector("#detail-rows").innerHTML = items.length
    ? items
        .map((item) => `<tr>
          <td>${mode === "history" ? formatPeriod(item) : item.day}</td>
          <td class="tokens" title="${formatTokenRaw(item.totalTokens)}">${formatTokenCompact(item.totalTokens)}</td>
          ${state.showCost ? `<td class="tokens" title="${escapeHtml(costTitle(item))}">${renderCost(item)}</td>` : ""}
          <td>${mode === "history" ? renderModels(item.models) : renderModels([{ name: item.model, totalTokens: item.totalTokens }])}</td>
        </tr>`)
        .join("")
    : `<tr><td class="empty" colspan="${state.showCost ? 4 : 3}">No usage in this period.</td></tr>`;
}

function renderBreakdownBars(items = []) {
  if (!items.length) return `<article class="empty-state">No usage in this slice.</article>`;
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  return items
    .map((item) => `<article class="bar-row">
      <span>${escapeHtml(item.name)}</span>
      <strong title="${formatTokenRaw(item.totalTokens)}">${formatTokenCompact(item.totalTokens)}</strong>
      <i style="width:${Math.max(3, (item.totalTokens / max) * 100)}%"></i>
    </article>`)
    .join("");
}

function renderCompactTrend(items, { topTitle }) {
  const sorted = [...items].sort((a, b) => formatPeriod(a).localeCompare(formatPeriod(b)));
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  const latest = sorted.at(-1);
  const peak = sorted.reduce((current, item) => (item.totalTokens > current.totalTokens ? item : current), sorted[0]);
  const top = [...items].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 5);
  return `<div class="compact-trend">
    <div class="compact-bars" aria-label="Usage trend">
      ${sorted
        .map((item) => {
          const title = escapeHtml(trendItemTitle(item));
          return `<span class="${item === latest ? "latest" : ""} ${item === peak ? "peak" : ""}" style="height:${Math.max(4, (item.totalTokens / max) * 100)}%" title="${title}" data-tooltip="${title}" tabindex="0"></span>`;
        })
        .join("")}
    </div>
    <div class="compact-axis">
      <span>${escapeHtml(formatPeriod(sorted[0]))}</span>
      <strong>Peak ${escapeHtml(formatPeriod(peak))} · ${formatTokenCompact(peak.totalTokens)}</strong>
      <span>${escapeHtml(formatPeriod(latest))}</span>
    </div>
    <div class="top-contributors">
      <h3>${escapeHtml(topTitle)}</h3>
      ${top
        .map((item, index) => `<article>
          <span>#${index + 1} ${escapeHtml(formatPeriod(item))}</span>
          <strong title="${escapeHtml(trendItemTitle(item))}">${formatTokenCompact(item.totalTokens)}${state.showCost ? ` · ${renderCost(item)}` : ""}</strong>
        </article>`)
        .join("")}
    </div>
  </div>`;
}

function renderModels(items = []) {
  return items
    .map((item) => `<span class="pill" title="${formatTokenRaw(item.totalTokens)}">${escapeHtml(item.name)} ${formatTokenCompact(item.totalTokens)}</span>`)
    .join("");
}

function setActive(group, button) {
  group.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
}

function formatPeriod(item) {
  return item.periodStart === item.periodEnd ? item.periodStart : `${item.periodStart} - ${item.periodEnd}`;
}

function formatPeriodRange(from, to) {
  if (!from && !to) return "-";
  return from === to ? from : `${from} to ${to}`;
}

function periodLabel(period) {
  return {
    today: "Today",
    yesterday: "Yesterday",
    this_week: "This week",
    last_week: "Last week",
    this_month: "This month",
    last_month: "Last month"
  }[period] || period;
}

function historyParams(view) {
  if (view === "weekly") return { grain: "week", range: "last12_weeks" };
  if (view === "monthly") return { grain: "month", range: "last12_months" };
  return { grain: "day", range: "last30" };
}

function historyLabel(view) {
  if (view === "weekly") return "Weekly history";
  if (view === "monthly") return "Monthly history";
  return "Daily history";
}

function sourceName(providerId) {
  if (providerId === "codex_local") return "Codex";
  if (providerId === "claude_code_local") return "Claude Code";
  if (providerId === "cursor_dashboard_usage") return "Cursor";
  return providerId;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
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

function trendItemTitle(item) {
  const cost = state.showCost ? ` · cost ${renderCost(item).replace(/<[^>]+>/g, "")}` : "";
  return `${formatPeriod(item)} · ${formatTokenRaw(item.totalTokens)}${cost}`;
}

function trimFixed(value, digits) {
  return Number(value).toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

loadLeaderboard().catch((error) => {
  statusEl.textContent = error.message;
});
