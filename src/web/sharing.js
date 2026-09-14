// Compute-sharing public directory (CPA plugin edition, R28).
// Read-only: this page only shows which share nodes are online and their
// budgets. Claiming is identity-bound and happens in the desktop client
// (plugins screen → 算力借用), where the league identity key signs the claim.

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

function renderShares() {
  const shares = state.shares.filter((s) => s.online);
  if (!shares.length) {
    els.grid.innerHTML = `<div class="sharing-empty">${escapeHtml(t("web.sharing.empty"))}</div>`;
    return;
  }
  els.grid.innerHTML = shares.map((share) => {
    const status = statusView(share);
    const total = share.budgetTokens || 0;
    const used = share.settledTokens || 0;
    const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
    const exhausted = share.exhausted === true;
    const slots = share.slotsLeft > 0 ? `${share.slotsLeft}` : escapeHtml(t("web.sharing.claimFull"));
    return `<article class="card sharing-card" data-share="${escapeHtml(share.shareId)}">
      <div class="sharing-card-head">
        <div>
          <h3>${escapeHtml(share.title)}</h3>
          <p class="sharing-models">${escapeHtml(t("web.sharing.models"))}: ${escapeHtml((share.models || []).join(", ") || "—")}</p>
        </div>
        <span class="sharing-status sharing-status-${status.cls}"><i></i>${escapeHtml(status.label)}</span>
      </div>
      <div class="sharing-kv">
        <span>${escapeHtml(t("web.sharing.budget"))}</span>
        <span class="num">${formatTokenCompact(used, getCurrentLang())} / ${formatTokenCompact(total, getCurrentLang())}</span>
      </div>
      <div class="sharing-bar"><i style="width:${pct}%"></i></div>
      ${exhausted ? `<div class="sharing-exhausted">${escapeHtml(t("web.sharing.exhausted"))}</div>` : ""}
      <div class="sharing-card-foot">
        <span class="sharing-slots">${escapeHtml(t("web.sharing.slots"))}: ${slots}</span>
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
