import { costQualityLabel, dominantComposition, tokenCompositionDetails, tokenCompositionSummary } from "/shared/composition.js";

const state = {
  period: "today",
  detailParticipantId: "",
  detailTab: "period",
  historyView: "daily",
  showCost: false
};
const storageKeys = {
  showCost: "ai-token-league.public.showCost"
};

const tbody = document.querySelector("#leaderboard");
const statusEl = document.querySelector("#status");
const downloadStatusEl = document.querySelector("#download-status");
const downloadActionsEl = document.querySelector("#download-actions");
const detailEl = document.querySelector("#participant-detail");
const detailBackdrop = document.querySelector("#detail-backdrop");
let detailCloseTimer = null;

hydratePreferences();
applyToggleState();

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
  persistPreference(storageKeys.showCost, state.showCost);
  applyToggleState();
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

async function loadReleaseDownloads() {
  try {
    const response = await fetch("/api/release/latest");
    const data = await response.json();
    if (!data.ok || !data.manifest) {
      renderDownloadUnavailable(data.code || data.error || "release unavailable");
      return;
    }
    renderReleaseDownloads(data.manifest);
  } catch (error) {
    renderDownloadUnavailable(error.message);
  }
}

function renderReleaseDownloads(manifest) {
  const platforms = Object.entries(manifest.platforms || {})
    .filter(([, artifact]) => artifact?.url)
    .sort(([left], [right]) => platformSort(left) - platformSort(right));
  const preferred = preferredPlatform();
  const preferredArtifact = platforms.find(([platform]) => platform === preferred);
  downloadStatusEl.textContent = `Latest ${manifest.version} · ${platforms.length} platform${platforms.length === 1 ? "" : "s"}`;
  downloadActionsEl.innerHTML = platforms.length
    ? platforms
        .map(([platform, artifact]) => {
          const link = artifact.installer || artifact;
          const ext = artifact.installer ? artifact.installer.ext : "zip";
          return `<a class="download-link${platform === preferred ? " primary" : ""}" href="${escapeAttribute(link.url)}" target="_blank" rel="noreferrer">
            <strong>${escapeHtml(platformLabel(platform))}</strong>
            <span>${escapeHtml(fileSize(link.size))} · ${ext.toUpperCase()}</span>
          </a>`;
        })
        .join("")
    : `<span class="download-placeholder">No downloadable client artifacts</span>`;
  if (preferredArtifact) downloadStatusEl.textContent = `Latest ${manifest.version} · recommended for this device: ${platformLabel(preferred)}`;
  else if (isMacBrowser() && platforms.some(([platform]) => platform === "darwin-arm64") && platforms.some(([platform]) => platform === "darwin-x64")) {
    downloadStatusEl.textContent = `Latest ${manifest.version} · choose macOS Apple silicon or macOS Intel`;
  }
}

function renderDownloadUnavailable(reason) {
  downloadStatusEl.textContent = "Client downloads are not configured on this app server.";
  downloadActionsEl.innerHTML = `<span class="download-placeholder">${escapeHtml(reason)}</span>`;
}

async function loadDetail(participantId) {
  if (detailCloseTimer) clearTimeout(detailCloseTimer);
  state.detailParticipantId = participantId;
  state.detailTab = "period";
  setActive(document.querySelector("[data-detail-tab]"), document.querySelector("[data-detail-tab] [data-value='period']"));
  detailEl.hidden = false;
  detailBackdrop.hidden = false;
  requestAnimationFrame(() => {
    detailEl.classList.add("is-open");
    detailBackdrop.classList.add("is-open");
    document.body.classList.add("detail-open");
  });
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
  document.querySelector("#detail-title").textContent = `${detail.nickname || "Participant"} · ${historyLabel(state.historyView)}`;
  document.querySelector("#detail-status").textContent = `${detail.from || "-"} to ${detail.to || "-"} · history window`;
  renderHistory(detail.items || []);
}

function renderDetail(detail) {
  renderDetailPanels();
  document.querySelector("#detail-summary").innerHTML = renderSummary(detail);
  document.querySelector("#detail-composition").innerHTML = renderCompositionBlock(detail, { showCost: state.showCost });
  document.querySelector("#period-chart").innerHTML = detail.isSingleDay
    ? `<article class="empty-state">Single-day leaderboard periods are explained by composition, not a trend chart.</article>`
    : detail.periodRows?.length
      ? renderCompactTrend([...detail.periodRows].reverse(), { topTitle: "Top date contribution" })
      : `<article class="empty-state">No usage in this period.</article>`;
  document.querySelector("#detail-models").innerHTML = renderBreakdownBars(detail.models);
  document.querySelector("#detail-sources").innerHTML = renderBreakdownBars(detail.providers?.map((item) => ({ ...item, name: sourceName(item.name) })));
  renderRawRows(detail.rows || [], { mode: "period" });
}

function renderHistory(items) {
  document.querySelector("#detail-summary").innerHTML = renderHistorySummary(items);
  document.querySelector("#history-chart").innerHTML = items.length
    ? renderCompactTrend([...items].reverse(), { topTitle: "Top period contribution" })
    : `<article class="empty-state">No usage in this history window.</article>`;
  renderRawRows(items, { mode: "history" });
}

function renderHistorySummary(items) {
  const total = items.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);
  const peak = items.reduce((current, item) => (!current || item.totalTokens > current.totalTokens ? item : current), null);
  const aggregate = items.reduce((current, item) => ({
    inputTokens: current.inputTokens + Number(item.inputTokens || 0),
    outputTokens: current.outputTokens + Number(item.outputTokens || 0),
    cacheReadTokens: current.cacheReadTokens + Number(item.cacheReadTokens || 0),
    cacheWriteTokens: current.cacheWriteTokens + Number(item.cacheWriteTokens || 0),
    reasoningTokens: current.reasoningTokens + Number(item.reasoningTokens || 0),
    totalTokens: current.totalTokens + Number(item.totalTokens || 0),
    estimatedCostUsd: current.estimatedCostUsd + Number(item.estimatedCostUsd || 0),
    missingPriceTokens: current.missingPriceTokens + Number(item.missingPriceTokens || 0),
    costQuality: mergeCostQuality(current.costQuality, item.costQuality)
  }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    missingPriceTokens: 0,
    costQuality: ""
  });
  const summary = [
    ["History buckets", String(items.length)],
    ["Window tokens", formatTokenCompact(total), formatTokenRaw(total)],
    ["Peak period", peak ? `${formatPeriod(peak)} · ${formatTokenCompact(peak.totalTokens)}` : "-"],
    ["Composition", tokenCompositionSummary(aggregate)]
  ];
  if (state.showCost) summary.push(["Window cost", renderCost(aggregate), costQualityLabel(aggregate.costQuality)]);
  return summary.map(([label, value, title]) => `<article class="summary-tile"${title ? ` title="${escapeHtml(title)}"` : ""}>
    <span>${escapeHtml(label)}</span>
    <strong class="${summaryValueClass(value)}">${value}</strong>
  </article>`).join("");
}

function mergeCostQuality(left = "", right = "") {
  const rank = { exact_price: 0, estimated_price: 1, unknown_price: 2 };
  if (!left) return right || "";
  if (!right) return left;
  return rank[right] > rank[left] ? right : left;
}

function closeDetail() {
  state.detailParticipantId = "";
  detailEl.classList.remove("is-open");
  detailBackdrop.classList.remove("is-open");
  document.body.classList.remove("detail-open");
  if (detailEl.hidden) return;
  detailCloseTimer = setTimeout(() => {
    detailEl.hidden = true;
    detailBackdrop.hidden = true;
  }, 180);
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
    ["Composition", detail.compositionSummary || tokenCompositionSummary(detail)],
    ["Dominant", humanDominant(detail.dominantComposition || dominantComposition(detail))],
    ["Models", String(detail.models?.length || 0)]
  ];
  if (state.showCost) items.push(["Est. cost", renderCost(detail), costTitle(detail)]);
  return items
    .map(([label, value, title]) => `<article class="summary-tile"${title ? ` title="${escapeHtml(title)}"` : ""}>
      <span>${escapeHtml(label)}</span>
      <strong class="${summaryValueClass(value)}">${value}</strong>
    </article>`)
    .join("");
}

function renderRawRows(items, { mode }) {
  document.querySelector("#detail-rows").innerHTML = items.length
    ? items
        .map((item) => `<tr>
          <td>${mode === "history" ? formatPeriod(item) : item.day}</td>
          <td class="tokens" title="${formatTokenRaw(item.totalTokens)}">${formatTokenCompact(item.totalTokens)}</td>
          <td>${escapeHtml(item.compositionSummary || tokenCompositionSummary(item))}</td>
          <td class="tokens" title="${formatTokenRaw(item.inputTokens)}">${renderAccountingToken(item.inputTokens, item.inputCostUsd)}</td>
          <td class="tokens" title="${formatTokenRaw(item.outputTokens)}">${renderAccountingToken(item.outputTokens, item.outputCostUsd)}</td>
          <td class="tokens" title="${formatTokenRaw((item.cacheReadTokens || 0) + (item.cacheWriteTokens || 0))}">${renderAccountingToken((item.cacheReadTokens || 0) + (item.cacheWriteTokens || 0), sumKnownCosts(item.cacheReadCostUsd, item.cacheWriteCostUsd))}</td>
          <td class="tokens" title="${formatTokenRaw(item.reasoningTokens)}">${renderAccountingToken(item.reasoningTokens, item.reasoningCostUsd)}</td>
          ${state.showCost ? `<td class="tokens" title="${escapeHtml(costTitle(item))}">${renderCost(item)}</td>` : ""}
          ${state.showCost ? `<td>${escapeHtml(costQualityLabel(item.costQuality))}</td>` : ""}
          <td>${mode === "history" ? renderModels(item.models) : renderModels([{ name: item.model, totalTokens: item.totalTokens }])}</td>
        </tr>`)
        .join("")
    : `<tr><td class="empty" colspan="${state.showCost ? 10 : 8}">No usage in this period.</td></tr>`;
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
          <small>${escapeHtml(item.compositionSummary || tokenCompositionSummary(item))}</small>
        </article>`)
        .join("")}
    </div>
  </div>`;
}

function renderCompositionBlock(item, { showCost = false } = {}) {
  const rows = tokenCompositionDetails(item)
    .map((entry) => {
      const cost = showCost ? renderCostPart(item, entry.field) : "";
      return `<article class="summary-tile composition-tile">
        <span>${escapeHtml(entry.label)}</span>
        <strong title="${formatTokenRaw(entry.tokens)}">${formatTokenCompact(entry.tokens)}</strong>
        <small>${Math.round(entry.ratio * 100)}%${cost ? ` · ${cost}` : ""}</small>
      </article>`;
    })
    .join("");
  const footer = showCost
    ? `<p class="composition-note">Total ${renderCost(item)} · ${escapeHtml(costQualityLabel(item.costQuality))}</p>`
    : `<p class="composition-note">${escapeHtml(item.compositionSummary || tokenCompositionSummary(item))}</p>`;
  return `<div class="detail-summary composition-grid">${rows}</div>${footer}`;
}

function renderAccountingToken(tokens, cost) {
  const costLine = state.showCost ? `<small>${formatCost(cost)}</small>` : "";
  return `<span class="token-accounting">${formatTokenCompact(tokens || 0)}${costLine}</span>`;
}

function sumKnownCosts(...values) {
  const known = values.filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
  if (!known.length) return null;
  return known.reduce((sum, value) => sum + Number(value), 0);
}

function renderCostPart(item, tokenField) {
  const mapping = {
    inputTokens: item.inputCostUsd,
    outputTokens: item.outputCostUsd,
    cacheReadTokens: item.cacheReadCostUsd,
    cacheWriteTokens: item.cacheWriteCostUsd,
    reasoningTokens: item.reasoningCostUsd
  };
  return formatCost(mapping[tokenField]);
}

function summaryValueClass(value) {
  const text = String(value || "").replace(/<[^>]+>/g, "");
  return text.length > 14 || text.includes("·") ? "compact-value" : "";
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

function platformSort(platform) {
  return {
    "darwin-arm64": 1,
    "darwin-x64": 2,
    "win32-x64": 3
  }[platform] || 99;
}

function platformLabel(platform) {
  return {
    "darwin-arm64": "macOS Apple silicon",
    "darwin-x64": "macOS Intel",
    "win32-x64": "Windows x64"
  }[platform] || platform;
}

function preferredPlatform() {
  const userAgent = window.navigator.userAgent || "";
  if (/Windows/i.test(userAgent)) return "win32-x64";
  return "";
}

function isMacBrowser() {
  return /Mac OS X|Macintosh/i.test(window.navigator.userAgent || "");
}

function fileSize(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "download";
  if (value >= 1024 * 1024 * 1024) return `${trimFixed(value / 1024 / 1024 / 1024, 1)} GB`;
  if (value >= 1024 * 1024) return `${trimFixed(value / 1024 / 1024, 0)} MB`;
  if (value >= 1024) return `${trimFixed(value / 1024, 0)} KB`;
  return `${value} B`;
}

function hydratePreferences() {
  state.showCost = readBooleanPreference(storageKeys.showCost, false);
}

function applyToggleState() {
  document.querySelector("#show-cost").checked = state.showCost;
  document.querySelectorAll(".cost-col").forEach((item) => {
    item.hidden = !state.showCost;
  });
}

function persistPreference(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(Boolean(value)));
  } catch {}
}

function readBooleanPreference(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) === true;
  } catch {
    return fallback;
  }
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
  const missing = normalizeMissingPriceModels(item.missingPriceModels).map((model) => `${model.name} ${formatTokenRaw(model.totalTokens)}`).join(", ");
  return `${item.costQuality || "unknown_price"} · ${item.pricingVersion || "no pricing version"}${missing ? ` · missing: ${missing}` : ""}`;
}

function normalizeMissingPriceModels(value) {
  if (Array.isArray(value)) return value;
  return Object.entries(value || {})
    .sort((a, b) => b[1] - a[1])
    .map(([name, totalTokens]) => ({ name, totalTokens }));
}

function renderCost(item) {
  const value = formatCost(item.estimatedCostUsd);
  if (value === "-") return value;
  return `${value}${item.missingPriceTokens ? `<sup title="Some model prices are missing">*</sup>` : ""}`;
}

function humanDominant(value = "") {
  return {
    "input-heavy": "Input-heavy",
    "output-heavy": "Output-heavy",
    "cache-heavy": "Cache-heavy",
    "reasoning-heavy": "Reasoning-heavy",
    "no-usage": "No usage"
  }[value] || value || "-";
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

function escapeAttribute(value) {
  return escapeHtml(value);
}

loadReleaseDownloads();
loadLeaderboard().catch((error) => {
  statusEl.textContent = error.message;
});
