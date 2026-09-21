// Compute-sharing public directory (CPA plugin edition, R28).
// Read-only: this page only shows which share nodes are online and their
// lane budgets. Claiming is identity-bound and happens in the desktop client
// (plugins screen → 算力借用), where the league identity key signs the claim.
// Lane-level data (CS-05/F09): the web directory uses the same lane shapes
// the app directory consumes, so "web shows budget, app says exhausted"
// can't diverge anymore.

import { initI18n, t, getCurrentLang, mountLangSwitcher, updatePageTranslations } from "/shared/i18n.js";
import "/theme-switcher.js";
import { formatTokenCompact } from "/shared/display.js";
import { escapeHtml } from "/shared/chart-helpers.js";

initI18n();

const els = {
  grid: document.getElementById("sharing-grid"),
};

const state = {
  shares: [],
};

function statusView(share) {
  if (!share.online) return { cls: "off", label: t("web.sharing.offline") };
  if (share.state && share.state !== "active") return { cls: "paused", label: t("web.sharing.paused") };
  return { cls: "on", label: t("web.sharing.online") };
}

const windowLabel = (window) => {
  const unit = window && window.unit ? String(window.unit) : "day";
  const n = Math.max(1, Math.round(Number(window && window.n) || 1));
  if (n === 1) return t(`web.sharing.window.${unit}One`);
  return t(`web.sharing.window.${unit}`, { n: String(n) });
};

const LANES_SHOWN = 4;

function laneRow(lane) {
  const total = lane.budgetTokens || 0;
  const used = lane.settledTokens || 0;
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const paused = lane.state === "paused";
  const suspended = lane.state === "suspended";
  const closed = !lane.open && !paused && !suspended;
  const slots = (lane.slotsLeft ?? 0) > 0 ? String(lane.slotsLeft) : escapeHtml(t("web.sharing.claimFull"));
  const note = suspended
    ? t("web.sharing.laneSuspended")
    : paused
      ? t("web.sharing.lanePaused")
      : lane.exhausted
        ? t("web.sharing.exhausted")
        : closed
          ? t("web.sharing.laneClosed")
          : "";
  return `<div class="sharing-lane${paused || suspended || closed ? " sharing-lane-off" : ""}">
    <div class="sharing-lane-head">
      <span class="sharing-lane-title">${escapeHtml(lane.title || lane.id)}</span>
      <span class="sharing-lane-window">${escapeHtml(windowLabel(lane.window))}</span>
    </div>
    <p class="sharing-models">${escapeHtml((lane.models || []).join(", ") || "—")}</p>
    <div class="sharing-kv">
      <span>${escapeHtml(t("web.sharing.budget"))}</span>
      <span class="num">${formatTokenCompact(used, getCurrentLang())} / ${formatTokenCompact(total, getCurrentLang())}</span>
    </div>
    <div class="sharing-bar"><i style="width:${pct}%"></i></div>
    ${note ? `<div class="sharing-lane-note">${escapeHtml(note)}</div>` : ""}
    <div class="sharing-card-foot">
      <span class="sharing-slots">${escapeHtml(t("web.sharing.slots"))}: ${slots}</span>
      <span class="sharing-lane-tz">${escapeHtml(lane.tzLabel || "")}</span>
    </div>
  </div>`;
}

function renderShares() {
  const shares = state.shares.filter((s) => s.online);
  if (!shares.length) {
    els.grid.innerHTML = `
      <article class="card sharing-guide-card">
        <div class="sharing-guide-header">
          <div class="sharing-guide-badge">⚡</div>
          <div>
            <h3>${escapeHtml(t("web.sharing.empty"))}</h3>
            <p class="sharing-guide-sub">${escapeHtml(t("web.sharing.guideTitle"))}</p>
          </div>
        </div>
        <div class="sharing-steps">
          <div class="sharing-step">
            <span class="step-num">1</span>
            <span class="step-desc">${escapeHtml(t("web.sharing.step1"))}</span>
          </div>
          <div class="sharing-step">
            <span class="step-num">2</span>
            <span class="step-desc">${escapeHtml(t("web.sharing.step2"))}</span>
          </div>
          <div class="sharing-step">
            <span class="step-num">3</span>
            <span class="step-desc">${escapeHtml(t("web.sharing.step3"))}</span>
          </div>
        </div>
      </article>`;
    return;
  }
  els.grid.innerHTML = shares.map((share) => {
    const status = statusView(share);
    const lanes = share.lanes || [];
    const shown = lanes.slice(0, LANES_SHOWN);
    const more = lanes.length - shown.length;
    // Aggregate view only when a share has no lane data (pre-lane nodes)
    const total = share.budgetTokens || 0;
    const used = share.settledTokens || 0;
    const legacyBudget = lanes.length ? "" : `
      <div class="sharing-kv">
        <span>${escapeHtml(t("web.sharing.budget"))}</span>
        <span class="num">${formatTokenCompact(used, getCurrentLang())} / ${formatTokenCompact(total, getCurrentLang())}</span>
      </div>`;
    return `<article class="card sharing-card" data-share="${escapeHtml(share.shareId)}">
      <div class="sharing-card-head">
        <div>
          <h3>${escapeHtml(share.title)}</h3>
          <p class="sharing-models">${escapeHtml(t("web.sharing.models"))}: ${escapeHtml((share.models || []).join(", ") || "—")}</p>
        </div>
        <span class="sharing-status sharing-status-${status.cls}"><i></i>${escapeHtml(status.label)}</span>
      </div>
      ${legacyBudget}
      ${shown.map(laneRow).join("")}
      ${more > 0 ? `<div class="sharing-lane-more">+${more}</div>` : ""}
      <div class="sharing-card-foot">
        <span class="sharing-claim-btn" disabled>${escapeHtml(t("web.sharing.claimInApp"))}</span>
      </div>
    </article>`;
  }).join("");
}

async function refreshShares() {
  try {
    const res = await fetch("/api/shares");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.shares = data.shares || [];
  } catch { /* keep last known */ }
  renderShares();
}

const langContainer = document.getElementById("lang-switcher-container");
mountLangSwitcher(langContainer, () => {
  updatePageTranslations();
  renderShares();
});

refreshShares();
setInterval(refreshShares, 6000);
