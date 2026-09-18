// 算力共享插件（compute-sharing 0.2.0 车道版）。
// 一张卡两个区：
//   「我的分享」 owner 控制台：车道（订阅切片：预算周期+开放时段+模型范围+名额）、
//               高级策略、停止/重新开启——未注册时整区隐藏；share secret 经 sidecar 代发。
//   「算力借用」 在线节点车道目录 + 实名签名按车道认领 + 我的认领。
// 车道绑定认领 Key（CPA 拦截点无 model 字段的 ABI 约束下按 key→lane 硬执行时段/预算）。
// 平台能力经 ctx（t / invoke(守门) / escapeHtml / apiBase / notify）。

const STYLE = `
.cs-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 2px 0 6px; }
.cs-head .modules-section-title { margin: 0; }
.cs-row { display: grid; gap: 4px; padding: 8px 10px; border: 1px solid var(--border-subtle, #e3e3e0); border-radius: 10px; background: transparent; margin-bottom: 6px; }
.cs-kv { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; }
.cs-kv .num { font-family: var(--mono-font, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
.cs-meter { height: 4px; border-radius: 999px; background: var(--subtle-bg, #eee); overflow: hidden; }
.cs-meter i { display: block; height: 100%; width: 0; border-radius: 999px; background: var(--green, #2f9e79); }
.cs-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cs-actions .cs-grow { flex: 1; }
.cs-config { display: grid; gap: 4px; margin-top: 2px; }
.cs-config-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cs-config-row code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 11px; font-family: var(--mono-font, ui-monospace, monospace); }
.cs-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--muted, #999); }
.cs-dot-on { background: var(--green, #2f9e79); }
.cs-dot-paused { background: var(--gold, #c90); }
.cs-dot-off { background: var(--muted, #999); opacity: 0.6; }
.cs-fields { display: flex; gap: 8px; flex-wrap: wrap; }
.cs-fields label { display: inline-flex; flex-direction: column; gap: 2px; font-size: 12px; }
.cs-fields input, .cs-fields select { width: 110px; }
.cs-fields label.grow { flex: 1 1 240px; }
.cs-fields label.grow input { width: 100%; }
.cs-muted { color: var(--muted, #888); font-size: 12.5px; line-height: 1.4; }
.cs-state { color: var(--red, #c0392b); font-weight: 600; }
.cs-status { min-height: 16px; font-size: 12.5px; }
.cs-board { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 1fr); gap: 8px 28px; align-items: start; }
.cs-board .cs-section { margin-top: 0; }
@media (max-width: 1000px) { .cs-board { grid-template-columns: 1fr; } .cs-board .cs-section { margin-top: 10px; } }
.cs-board.cs-stacked { grid-template-columns: 1fr; }
.cs-lane { display: grid; gap: 4px; padding: 7px 10px; border: 1px dashed var(--border-subtle, #e3e3e0); border-radius: 10px; margin-bottom: 6px; }
.cs-lane .cs-kv { align-items: baseline; }
.cs-tabs-row { display: flex; align-items: center; gap: 8px; margin: 2px 0 8px; }
.cs-tabs-row .cs-grow { flex: 1; }
/* tab 外观复用宿主 .segmented 分段控件（含深色主题）；这里只收窄到卡片内尺寸，
   参数与宿主紧凑变体 .segmented.modules-online-filter 一致 */
.cs-tabs { flex: 0 1 auto; }
.cs-tabs button { padding: 5px 12px; font-size: 12px; font-weight: 650; }
.cs-lane-tag { font-size: 11px; color: var(--muted, #888); border: 1px solid var(--border-subtle, #e3e3e0); border-radius: 999px; padding: 1px 8px; }
.cs-wall { display: flex; gap: 8px; align-items: baseline; padding: 7px 10px; border: 1px solid var(--gold, #c90); border-radius: 10px; margin-bottom: 6px; font-size: 12.5px; }
.cs-templates { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
/* 认领卡（我的认领）：标签/值/操作网格，值不折行 */
.cs-claim-config { display: flex; flex-direction: column; gap: 5px; }
.cs-claim-row { display: flex; align-items: center; gap: 8px; }
.cs-claim-label { flex: 0 0 96px; font-size: 11px; color: var(--muted, #888); white-space: nowrap; }
.cs-claim-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; }
.cs-claim-mini { padding: 2px 8px; font-size: 11px; white-space: nowrap; }
.cs-claim-row .outline-button { white-space: nowrap; }
.cs-claim-section { margin: 10px 0 4px; font-size: 11px; letter-spacing: .06em; color: var(--muted, #888); border-bottom: 1px solid var(--border-subtle, #e3e3e0); padding-bottom: 2px; }
.cs-claim-meta { line-height: 1.5; }
.cs-test-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cs-test-row .grow { flex: 1 1 160px; min-width: 0; }
.cs-claim-footer { justify-content: flex-end; border-top: 1px dashed var(--border-subtle, #e3e3e0); padding-top: 6px; }
.cs-dir-tools { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.cs-chips { display: flex; gap: 4px; flex-wrap: wrap; }
.cs-chip { border: 1px solid var(--border-subtle, #e3e3e0); border-radius: 999px; background: transparent; padding: 2px 10px; font-size: 11.5px; cursor: pointer; color: var(--muted, #888); white-space: nowrap; }
.cs-chip.active { background: var(--subtle-bg, #eee); color: inherit; font-weight: 600; }
.cs-check { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--muted, #888); white-space: nowrap; }
.cs-dir-card { margin-bottom: 6px; }
.cs-lane-more { font-size: 11.5px; color: var(--muted, #888); cursor: pointer; background: transparent; border: 0; padding: 2px 0; }
.cs-t3 { margin-top: 6px; border-top: 1px dashed var(--border-subtle, #e3e3e0); padding-top: 6px; }
.cs-t3-row { padding: 2px 0; opacity: .7; }
.cs-hidden-note { margin-top: 6px; opacity: .8; }
.cs-suggest-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 2px; }
.cs-reserve { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted, #888); }
.cs-reserve input { width: 52px; text-align: right; }
.cs-tpl-chip { display: inline-flex; align-items: center; gap: 2px; }
.cs-tpl-del { border: 0; background: transparent; color: var(--muted, #888); cursor: pointer; font-size: 13px; line-height: 1; padding: 2px 4px; }
.cs-tpl-del:hover { color: var(--red, #c0392b); }
.cs-suggest [data-cs-family] { margin-left: 6px; padding: 2px 10px; font-size: 12px; }
`;

function compact(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  const zh = (document.documentElement.lang || "").startsWith("zh");
  if (zh) {
    if (Math.abs(n) >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`;
    if (Math.abs(n) >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
    return String(n);
  }
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function fmtDateTime(ms) {
  const zh = (document.documentElement.lang || "").startsWith("zh");
  return new Date(ms).toLocaleString(zh ? "zh-CN" : "en-US");
}

function clockText(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Lane creation entrypoints are derived, not hardcoded (R49): the suggest
// block turns the owner's own usage families into pre-filled editors, and
// personal templates (module config laneTemplates) are user-saved presets.
// Every prefilled number stays adjustable before saving.

export default {
  async mount(el, ctx) {
    const esc = ctx.escapeHtml;
    const t = ctx.t;

    let style = document.getElementById("compute-sharing-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "compute-sharing-style";
      style.textContent = STYLE;
      document.head.appendChild(style);
    }

    el.innerHTML = `
      <div class="cs-tabs-row">
        <div class="cs-tabs segmented" data-cs="tabs" hidden>
          <button class="cs-tab" type="button" data-cs-tab="owner">${esc(t("desktop.sharing.tab.owner"))}</button>
          <button class="cs-tab" type="button" data-cs-tab="borrow">${esc(t("desktop.sharing.tab.borrow"))}</button>
        </div>
        <span class="cs-grow"></span>
        <button class="outline-button" type="button" data-cs="refresh">${esc(t("desktop.sharing.borrow.refresh"))}</button>
      </div>
      <div data-cs="owner" hidden>
        <div data-cs="owner-body" aria-live="polite"></div>
      </div>
      <div class="cs-board" data-cs="board" hidden>
        <section>
          <div class="modules-section-title" style="margin:2px 0 6px">${esc(t("desktop.sharing.borrow.section"))}</div>
          <div data-cs="directory" aria-live="polite"></div>
        </section>
        <section>
          <div class="cs-head cs-section">
            <div class="modules-section-title">${esc(t("desktop.sharing.borrow.myClaims"))}</div>
          </div>
          <div data-cs="mine" aria-live="polite"></div>
        </section>
      </div>
      <span class="cs-status action-message" data-cs="status" aria-live="polite"></span>`;

    const els = {
      tabs: el.querySelector('[data-cs="tabs"]'),
      board: el.querySelector('[data-cs="board"]'),
      owner: el.querySelector('[data-cs="owner"]'),
      ownerBody: el.querySelector('[data-cs="owner-body"]'),
      directory: el.querySelector('[data-cs="directory"]'),
      mine: el.querySelector('[data-cs="mine"]'),
      status: el.querySelector('[data-cs="status"]'),
    };

    const busy = (on) => {
      const button = el.querySelector('[data-cs="refresh"]');
      if (button) button.disabled = on;
    };
    const message = (text) => { els.status.textContent = text || ""; };
    // Receipts ride the host toast (ctx.notify) with an in-card fallback for
    // older hosts; errors keep the persistent in-card status line.
    const notify = (text) => (ctx.notify ? ctx.notify(text, { duration: 4000 }) : message(text));
    const guard = async (fn) => {
      busy(true);
      try { await fn(); } catch (error) { message(String(error.message || error)); } finally { busy(false); }
    };

    async function apiPost(path, body) {
      const base = ctx.apiBase && ctx.apiBase();
      if (!base) throw new Error(t("desktop.sharing.borrow.noCloud"));
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errorKey = {
          share_offline: "web.sharing.offline",
          budget_exhausted: "web.sharing.exhausted",
          lane_exhausted: "desktop.sharing.borrow.laneExhausted",
          lane_closed: "desktop.sharing.borrow.laneClosed",
          lane_suspended: "desktop.sharing.borrow.laneSuspended",
          lane_required: "desktop.sharing.borrow.laneRequired",
          lane_not_found: "desktop.sharing.borrow.laneRequired",
          no_claim_slots: "web.sharing.claimFull",
          rate_limited: "desktop.sharing.borrow.rateLimited",
          identity_required: "desktop.sharing.borrow.identityFailed",
          participant_not_registered: "desktop.sharing.borrow.identityFailed",
          invalid_signature: "desktop.sharing.borrow.identityFailed",
          claim_not_found: "desktop.sharing.borrow.claimGone",
          share_not_active: "web.sharing.paused",
          too_many_active_claims: "desktop.sharing.borrow.tooManyClaims",
        }[data.error];
        if (data.error === "too_many_active_claims") {
          throw new Error(t("desktop.sharing.borrow.tooManyClaims", { active: String(data.active ?? "?"), max: String(data.max ?? "?") }));
        }
        const detail = data.retryAfterMs
          ? t("desktop.sharing.borrow.retryAt", { time: clockText(Date.now() + data.retryAfterMs) })
          : "";
        throw new Error(errorKey ? (detail ? `${t(errorKey)} · ${detail}` : t(errorKey)) : (data.error || `HTTP ${response.status}`));
      }
      return data;
    }

    // ── 我的分享（owner 控制台；未注册整区隐藏） ─────────────────────────
    // Share-level knobs kept after lanes moved budget/maxClaims into lanes.
    const ownerFieldDefs = [
      ["keyMaxTokens", "desktop.sharing.owner.f.keyMax"],
      ["keyConcurrency", "desktop.sharing.owner.f.keyConc"],
      ["ttlHours", "desktop.sharing.owner.f.ttl"],
    ];

    // window spec label (R50): {hour|day|week, n} → 每天 / 每 5 小时 / 每 2 周…
    const windowLabel = (window) => {
      const unit = window && window.unit ? String(window.unit) : "day";
      const n = Math.max(1, Math.round(Number(window && window.n) || 1));
      if (n === 1) return t(`desktop.sharing.lane.window.${unit}One`);
      return t(`desktop.sharing.lane.window.${unit}`, { n: String(n) });
    };
    const scheduleText = (lane) => (lane.schedule && lane.schedule.length
      ? lane.schedule.map((w) => `${w.start}–${w.end}`).join(", ")
      : t("desktop.sharing.lane.scheduleAllDay"));

    // lane edit state: null = closed; {isNew, index, draft fields}
    let laneEditor = null;
    let showAllClaims = false;
    // Tab categorization: owners get 我的分享/算力借用; pure borrowers keep a
    // single-column card (no tab bar). Selection survives refreshes.
    let activeTab = "owner";
    // "pending" until the first owner-status settles — the tab bar's
    // data-owner attribute is the test/UX contract that removes the
    // board-temporarily-visible race for pure borrowers
    let ownerSettled = false;
    const hasOwnerConsole = () => Boolean(lastOwnerData && lastOwnerData.share && lastOwnerData.share.shareId);
    function applyTabs() {
      const hasOwner = hasOwnerConsole();
      els.tabs.dataset.owner = ownerSettled ? (hasOwner ? "yes" : "no") : "pending";
      els.tabs.hidden = !hasOwner;
      els.owner.hidden = !hasOwner || activeTab !== "owner";
      els.board.hidden = hasOwner && activeTab !== "borrow";
      // Stacking is measured, not a viewport media query (R52 review): the
    // card sits inside the app layout, so 1120px viewport can still mean a
    // ~830px board — the borrow pane needs the full row there.
    const stackBoard = () => {
      const width = els.board.clientWidth || 0;
      els.board.classList.toggle("cs-stacked", width > 0 && width < 980);
    };
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(stackBoard).observe(els.board);
    stackBoard();

    for (const button of els.tabs.querySelectorAll("[data-cs-tab]")) {
        button.classList.toggle("active", button.dataset.csTab === (hasOwner ? activeTab : "borrow"));
      }
    }
    for (const button of Array.from(el.querySelectorAll("[data-cs-tab]"))) {
      button.addEventListener("click", () => {
        activeTab = button.dataset.csTab;
        applyTabs();
      });
    }

    // Peak multiplier chip + owner-tz label: borrowers must see the billing
    // rule and whose clock the schedule follows (review B12 / B10).
    const laneTags = (lane) => {
      const tags = [];
      if (lane.peak && lane.peak.multiplier > 1 && lane.peak.windows && lane.peak.windows.length) {
        const wins = lane.peak.windows.map((w) => `${w.start}–${w.end}`).join(", ");
        tags.push(`<span class="cs-lane-tag">${esc(t("desktop.sharing.lane.peakTag", { n: String(lane.peak.multiplier) }))} ${esc(wins)}</span>`);
      }
      if (lane.tzLabel) tags.push(`<span class="cs-lane-tag">${esc(lane.tzLabel)}</span>`);
      return tags.join(" ");
    };

    function laneDot(lane) {
      if (lane.state === "suspended") return "paused";
      if (!lane.open) return "off";
      if (lane.exhausted) return "paused";
      return "on";
    }
    const laneStatusText = (lane) => {
      if (lane.state === "suspended") return `<span class="cs-state">${esc(t("desktop.sharing.lane.paused"))}</span>`;
      if (!lane.open) return `${esc(t("desktop.sharing.lane.closedUntil"))} · ${esc(clockText(Date.now() + (lane.retryAfterMs || 0)))}`;
      if (lane.exhausted) return `<span class="cs-state">${esc(t("desktop.sharing.lane.exhausted"))}</span> ${esc(t("desktop.sharing.lane.resetAt", { time: clockText(lane.windowEndsAtMs || Date.now()) }))}`;
      return esc(t("web.sharing.online"));
    };

    // claim.state i18n map (review B1: no bare enums on a zh card)
    const claimStateText = (state) => ({
      valid: t("desktop.sharing.owner.claimValid"),
      revoked: t("desktop.sharing.borrow.stateRevoked"),
      expired: t("desktop.sharing.borrow.stateExpired"),
    }[state] || state);

    function renderLaneRow(lane, index) {
      const total = lane.budgetTokens || 0;
      const used = lane.settledTokens || 0;
      const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
      return `
        <div class="cs-lane" data-cs-lane="${esc(lane.id)}">
          <div class="cs-kv">
            <span><span class="cs-dot cs-dot-${laneDot(lane)}"></span> <strong>${esc(lane.title)}</strong>
              <span class="cs-lane-tag">${esc(lane.models.join(", "))}</span></span>
            <span>${laneStatusText(lane)}</span>
          </div>
          <div class="cs-kv"><span class="cs-muted">${esc(windowLabel(lane.window))} · ${esc(scheduleText(lane))} ${laneTags(lane)}</span>
            <span class="num">${esc(compact(used))} / ${esc(compact(total))}</span></div>
          <div class="cs-meter"><i style="width:${pct}%"></i></div>
          <div class="cs-actions">
            <span class="cs-muted">${esc(t("desktop.sharing.lane.slots"))}: ${esc(String(lane.slotsLeft))}/${esc(String(lane.maxClaims))}</span>
            <span class="cs-grow"></span>
            <button class="outline-button" type="button" data-cs-lane-edit="${index}">${esc(t("desktop.sharing.lane.edit"))}</button>
            <button class="outline-button" type="button" data-cs-lane-toggle="${index}">${esc(t(lane.state === "suspended" ? "desktop.sharing.lane.resumeLane" : "desktop.sharing.lane.pause"))}</button>
          </div>
        </div>`;
    }

    function renderLaneEditor(lanes) {
      const editing = laneEditor;
      if (!editing) return "";
      const draft = editing.draft;
      return `
        <div class="cs-row" data-cs="lane-form">
          <div class="cs-muted">${esc(t(editing.isNew ? "desktop.sharing.lane.addTitle" : "desktop.sharing.lane.editTitle"))}</div>
          <div class="cs-fields">
            <label class="grow">${esc(t("desktop.sharing.lane.f.title"))}<input data-cs-f="title" type="text" value="${esc(draft.title)}" /></label>
            <label class="grow">${esc(t("desktop.sharing.lane.f.models"))}<input data-cs-f="models" type="text" placeholder="*" value="${esc(draft.models)}" /></label>
            <label>${esc(t("desktop.sharing.lane.f.period"))}<select data-cs-f="windowUnit">
              ${["day", "week", "hour"].map((u) => `<option value="${u}"${draft.windowUnit === u ? " selected" : ""}>${esc(windowLabel({ unit: u, n: 1 }))}</option>`).join("")}
            </select></label>
            <label>${esc(t("desktop.sharing.lane.f.windowN"))}<input data-cs-f="windowN" type="number" min="1" max="48" step="1" value="${esc(String(draft.windowN || 1))}" /></label>
            <label>${esc(t("desktop.sharing.lane.f.budget"))}<input data-cs-f="budget" type="number" step="1000" min="1000" value="${esc(String(draft.budget))}" /><span class="cs-muted" data-cs="budgetHint">${esc(t("desktop.sharing.lane.budgetHint", { text: compact(draft.budget) }))}</span></label>
            <label>${esc(t("desktop.sharing.lane.f.maxClaims"))}<input data-cs-f="maxClaims" type="number" step="1" min="1" value="${esc(String(draft.maxClaims))}" /></label>
          </div>
          <div class="cs-fields">
            <label>${esc(t("desktop.sharing.lane.f.winStart"))}<input data-cs-f="winStart" type="time" value="${esc(draft.winStart)}" /></label>
            <label>${esc(t("desktop.sharing.lane.f.winEnd"))}<input data-cs-f="winEnd" type="time" value="${esc(draft.winEnd)}" /></label>
            <label>${esc(t("desktop.sharing.lane.f.peakStart"))}<input data-cs-f="peakStart" type="time" value="${esc(draft.peakStart)}" /></label>
            <label>${esc(t("desktop.sharing.lane.f.peakEnd"))}<input data-cs-f="peakEnd" type="time" value="${esc(draft.peakEnd)}" /></label>
            <label>${esc(t("desktop.sharing.lane.f.peakMultiplier"))}<input data-cs-f="peakMultiplier" type="number" step="1" min="1" max="10" value="${esc(String(draft.peakMultiplier))}" /></label>
          </div>
          <div class="cs-muted">${esc(t("desktop.sharing.lane.formHint"))}</div>
          ${editing.multiWindow ? `<div class="cs-state">${esc(t("desktop.sharing.lane.multiWindowHint"))}</div>` : ""}
          <div class="cs-actions">
            <span class="cs-grow"></span>
            <button class="outline-button" type="button" data-cs="laneSaveTpl">${esc(t("desktop.sharing.lane.saveTemplate"))}</button>
            <button class="outline-button" type="button" data-cs="laneCancel">${esc(t("desktop.sharing.lane.cancel"))}</button>
            ${editing.isNew ? "" : `<button class="outline-button" type="button" data-cs="laneDelete">${esc(t("desktop.sharing.lane.delete"))}</button>`}
            <button class="primary-pill" type="button" data-cs="laneSave">${esc(t("desktop.sharing.lane.save"))}</button>
          </div>
        </div>`;
    }

    // owner lanes come from owner-status share.lanes (full lane views)
    // Editing a different lane/template must not inherit the old form's
    // unsaved values: those handlers raise skipFormReadback for one render.
    let skipFormReadback = false;
    function renderOwner(data) {
      const share = (data && data.share) || {};
      const claims = (data && data.claims) || [];
      // Preserve in-progress editor input across refresh re-renders: the DOM
      // still holds the live values at this point (review A1 fix).
      if (laneEditor && !skipFormReadback) {
        const live = readLaneForm();
        if (live) Object.assign(laneEditor.draft, live);
      }
      skipFormReadback = false;
      applyTabs();
      if (!share.shareId) {
        els.ownerBody.innerHTML = "";
        return;
      }
      if (share.state === "stopped") {
        els.ownerBody.innerHTML = `
          <div class="cs-row">
            <div class="cs-kv"><strong>${esc(share.title || share.shareId)}</strong>
              <span class="cs-state">${esc(t("desktop.sharing.owner.stoppedState"))}</span></div>
            <div class="cs-muted">${esc(t("desktop.sharing.owner.stoppedHint"))}</div>
            <div class="cs-actions">
              <span class="cs-muted">${esc(t("desktop.sharing.owner.lifetime"))}: ${esc(compact(share.lifetimeSettled))}</span>
              <span class="cs-grow"></span>
              <button class="primary-pill" type="button" data-cs="resume">${esc(t("desktop.sharing.owner.resume"))}</button>
            </div>
          </div>`;
        els.ownerBody.querySelector('[data-cs="resume"]').addEventListener("click", () => guard(async () => {
          await ctx.invoke("compute-sharing:owner-resume", {});
          notify(t("desktop.sharing.owner.resumed"));
          await refresh();
        }));
        return;
      }
      const lanes = share.lanes || [];
      const wall = share.wallSignal;
      // R53-1: advisory endpoint misconfiguration (LAN baseURL + loopback
      // CPA bind) — loud from day one, right where the owner looks
      const endpointWarn = data.pluginStatus && data.pluginStatus.endpointWarning
        ? `<div class="cs-wall"><span>⚠️</span><span>${esc(t("desktop.sharing.owner.endpointWarn"))}: ${esc(data.pluginStatus.endpointWarning)}</span></div>`
        : "";
      const wallBanner = wall && wall.ownerFailed
        ? `<div class="cs-wall"><span>⚠️</span><span>${esc(t("desktop.sharing.owner.wall", { count: String(wall.ownerFailed) }))}</span></div>`
        : "";
      const shortId = (id) => (id && id.length > 10 ? `${id.slice(0, 8)}…` : id || "");
      const laneLabelOf = (laneId) => (laneId === "default" ? t("desktop.sharing.lane.defaultTitle") : laneTitleOf(lanes, laneId));
      const claimRow = (c) => `
        <div class="cs-kv" style="${c.state !== "valid" ? "opacity:.55" : ""}">
          <span>${esc(c.borrower || c.keyId)}${c.displayId ? ` <span class="cs-muted" title="${esc(c.displayId)}">${esc(shortId(c.displayId))}</span>` : ""}${c.laneId ? ` <span class="cs-lane-tag">${esc(laneLabelOf(c.laneId))}</span>` : ""} · <span class="num">${esc(String(c.keyId).slice(0, 11))}…</span></span>
          <span class="num">${esc(compact(c.usedTokens))} · ${esc(claimStateText(c.state))}</span>
        </div>`;
      // valid claims always show; the ended tail collapses to a recent slice so
      // the console stays readable as history accumulates
      const ENDED_SHOWN = 4;
      const ended = claims.filter((c) => c.state !== "valid");
      let endedShown = 0;
      const rows = claims
        .filter((c) => c.state === "valid" || showAllClaims || endedShown++ < ENDED_SHOWN)
        .map(claimRow)
        .join("");
      const claimsToggle = ended.length > ENDED_SHOWN
        ? `<button class="outline-button" type="button" data-cs="claimsToggle">${esc(t(showAllClaims ? "desktop.sharing.owner.claimsCollapse" : "desktop.sharing.owner.claimsShowAll", { n: String(ended.length) }))}</button>`
        : "";
      els.ownerBody.innerHTML = `
        ${endpointWarn}${wallBanner}
        <div class="cs-row">
          <div class="cs-kv"><strong>${esc(share.title || share.shareId)}</strong>
            <span>${esc(t("web.sharing.online"))}${share.plugin && share.plugin.online ? "" : ` · ${esc(t("desktop.sharing.owner.pluginOffline"))}${pluginOfflineReason(data)}`}</span></div>
          <div class="cs-kv"><span class="cs-muted">${esc(t("desktop.sharing.owner.lifetime"))}</span><span class="num">${esc(compact(share.lifetimeSettled))}</span></div>
          ${lanes.map(renderLaneRow).join("")}
          ${renderLaneEditor(lanes)}
          ${laneEditor ? "" : templateBlock()}
          ${suggestBlock()}
          ${rows ? `<div class="cs-muted">${esc(t("desktop.sharing.owner.claims"))}</div>${rows}${claimsToggle}` : `<div class="cs-muted">${esc(t("desktop.sharing.owner.noClaims"))}</div>`}
        </div>
        <div class="cs-row">
          <div class="cs-muted">${esc(t("desktop.sharing.owner.advanced"))}</div>
          <div class="cs-fields">${ownerFieldDefs.map(([key, labelKey]) => `
            <label>${esc(t(labelKey))}<input data-cs-policy="${key}" type="number" step="1" placeholder="${esc(String((share.policy && share.policy[key]) ?? ""))}" /></label>`).join("")}
          </div>
          <div class="cs-actions">
            <button class="outline-button" type="button" data-cs="savePolicy">${esc(t("desktop.sharing.owner.savePolicy"))}</button>
            <button class="outline-button" type="button" data-cs="stop">${esc(t("desktop.sharing.owner.stop"))}</button>
          </div>
        </div>`;
      applyTabs();
      wireOwnerEvents(lanes);
    }

    // R51-4: the plugin writes status.json beside its identity; owner-status
    // merges it — surface WHY it is offline, not just that it is. Raw reason
    // text is diagnostic (transport/status strings), not localized UI copy.
    const pluginOfflineReason = (data) => {
      const status = data && data.pluginStatus;
      return status && status.lastError ? ` · ${esc(status.lastError)}` : "";
    };

    const laneTitleOf = (lanes, laneId) => {
      const lane = (lanes || []).find((l) => l.id === laneId);
      return lane ? lane.title : laneId;
    };

    const laneSlotsUsedOf = (lanes, laneId) => {
      const claims = (lastOwnerData && lastOwnerData.claims) || [];
      return claims.filter((c) => (c.laneId || "default") === laneId && c.state === "valid").length;
    };

    function readLaneForm() {
      const form = els.ownerBody.querySelector('[data-cs="lane-form"]');
      if (!form) return null;
      const val = (name) => form.querySelector(`[data-cs-f="${name}"]`)?.value ?? "";
      return {
        title: val("title").trim(),
        models: val("models").trim(),
        windowUnit: val("windowUnit") || "day",
        windowN: Number(val("windowN")) || 1,
        budget: Number(val("budget")),
        maxClaims: Number(val("maxClaims")),
        winStart: val("winStart"),
        winEnd: val("winEnd"),
        peakStart: val("peakStart"),
        peakEnd: val("peakEnd"),
        peakMultiplier: Number(val("peakMultiplier")) || 1,
      };
    }

    async function saveLanes(lanes, { successKey = "desktop.sharing.lane.saved" } = {}) {
      await ctx.invoke("compute-sharing:owner-policy", { lanes });
      notify(t(successKey));
      laneEditor = null;
      await refresh();
    }

    // lanes wire format: budget/schedule/peak nests; id/title/models flat.
    // Accepts view-shaped lanes (models array, schedule/peak view) — the only
    // shape owner-status and the editor produce.
    function toWireLane(lane) {
      const wire = {
        id: lane.id,
        title: lane.title,
        models: Array.isArray(lane.models) ? lane.models : String(lane.models).split(",").map((m) => m.trim()).filter(Boolean),
        budget: { tokens: lane.budgetTokens },
        window: { unit: lane.windowUnit || "day", n: Math.max(1, Math.round(Number(lane.windowN) || 1)) },
        maxClaims: lane.maxClaims,
        state: lane.state,
      };
      if (lane.schedule && lane.schedule.length) {
        wire.schedule = { windows: lane.schedule.map((w) => ({ start: w.start, end: w.end })) };
      }
      if (lane.peak && lane.peak.windows && lane.peak.windows.length && lane.peak.multiplier > 1) {
        wire.peak = { windows: lane.peak.windows.map((w) => ({ start: w.start, end: w.end })), multiplier: lane.peak.multiplier };
      }
      return wire;
    }

    function wireOwnerEvents(lanes) {
      const savePolicy = els.ownerBody.querySelector('[data-cs="savePolicy"]');
      if (savePolicy) savePolicy.addEventListener("click", () => guard(async () => {
        const policy = {};
        for (const [key] of ownerFieldDefs) {
          const raw = els.ownerBody.querySelector(`[data-cs-policy="${key}"]`)?.value;
          if (raw === undefined || String(raw).trim() === "") continue;
          const value = Number(raw);
          if (!Number.isFinite(value) || value < 0) throw new Error(t("desktop.sharing.owner.policyInvalid"));
          policy[key] = Math.round(value);
        }
        if (!Object.keys(policy).length) throw new Error(t("desktop.sharing.owner.policyEmpty"));
        await ctx.invoke("compute-sharing:owner-policy", { policy });
        notify(t("desktop.sharing.owner.policySaved"));
        await refresh();
      }));
      const stop = els.ownerBody.querySelector('[data-cs="stop"]');
      if (stop) stop.addEventListener("click", () => guard(async () => {
        if (!window.confirm(t("desktop.sharing.owner.stopConfirm"))) return;
        await ctx.invoke("compute-sharing:owner-unregister", {});
        notify(t("desktop.sharing.owner.stopped"));
        await refresh();
      }));

      for (const button of els.ownerBody.querySelectorAll("[data-cs-lane-edit]")) {
        button.addEventListener("click", () => {
          const lane = lanes[Number(button.dataset.csLaneEdit)];
          // switching edit targets: the old form's unsaved values must NOT
          // bleed into the new draft (review B-1 regression guard)
          skipFormReadback = true;
          laneEditor = {
            isNew: false,
            // multi-window lanes (built via admin/API) collapse to their first
            // window on save — surface that instead of dropping it silently
            multiWindow: (lane.schedule?.length || 0) > 1 || (lane.peak?.windows?.length || 0) > 1,
            draft: {
              id: lane.id, title: lane.title, models: lane.models.join(", "),
              windowUnit: (lane.window && lane.window.unit) || "day", windowN: (lane.window && lane.window.n) || 1,
              budget: lane.budgetTokens, maxClaims: lane.maxClaims,
              winStart: lane.schedule?.[0]?.start || "", winEnd: lane.schedule?.[0]?.end || "",
              peakStart: lane.peak?.windows?.[0]?.start || "", peakEnd: lane.peak?.windows?.[0]?.end || "",
              peakMultiplier: lane.peak?.multiplier || 1, state: lane.state,
            },
          };
          renderOwnerLast();
        });
      }
      // derived suggestion → pre-filled editor: family wildcard, complement of
      // the owner's busy window, budget = own use × (1 − reserve). All editable.
      for (const button of els.ownerBody.querySelectorAll("[data-cs-family]")) {
        button.addEventListener("click", () => {
          const fam = ((suggestData && suggestData.families) || [])[Number(button.dataset.csFamily)];
          if (!fam) return;
          skipFormReadback = true;
          const open = fam.busy ? { start: fam.busy.end, end: fam.busy.start } : null;
          laneEditor = {
            isNew: true,
            draft: {
              id: "", title: fam.family, models: fam.family, windowUnit: "week", windowN: 1,
              budget: suggestedBudget(fam.weeklyTokens), maxClaims: 2,
              winStart: open?.start || "", winEnd: open?.end || "",
              peakStart: "", peakEnd: "", peakMultiplier: 1, state: "active",
            },
          };
          renderOwnerLast();
        });
      }
      for (const button of els.ownerBody.querySelectorAll("[data-cs-tpl]")) {
        button.addEventListener("click", () => {
          const key = button.dataset.csTpl;
          skipFormReadback = true;
          const tpl = key === "blank" ? null : cardConfig.laneTemplates[Number(key)];
          if (key !== "blank" && !tpl) return;
          laneEditor = {
            isNew: true,
            draft: tpl ? {
              id: "", title: tpl.title || tpl.models, models: tpl.models, windowUnit: tpl.windowUnit || "week", windowN: Number(tpl.windowN) || 1,
              budget: Number(tpl.budget) || 10_000_000, maxClaims: Number(tpl.maxClaims) || 1,
              winStart: tpl.winStart || "", winEnd: tpl.winEnd || "",
              peakStart: "", peakEnd: "", peakMultiplier: 1, state: "active",
            } : {
              id: "", title: "", models: "*", windowUnit: "day", windowN: 1, budget: 10_000_000, maxClaims: 1,
              winStart: "", winEnd: "", peakStart: "", peakEnd: "", peakMultiplier: 1, state: "active",
            },
          };
          renderOwnerLast();
        });
      }
      for (const button of els.ownerBody.querySelectorAll("[data-cs-tpl-del]")) {
        button.addEventListener("click", () => guard(async () => {
          const index = Number(button.dataset.csTplDel);
          const list = cardConfig.laneTemplates.filter((_, i) => i !== index);
          cardConfig.laneTemplates = list;
          await saveCardConfig({ laneTemplates: list });
          renderOwnerLast();
        }));
      }
      const reserveInput = els.ownerBody.querySelector('[data-cs="reserve"]');
      if (reserveInput) reserveInput.addEventListener("change", () => guard(async () => {
        const value = Math.min(95, Math.max(5, Math.round(Number(reserveInput.value) || 25)));
        reserveInput.value = String(value);
        cardConfig.reservePct = value;
        await saveCardConfig({ reservePct: value });
        renderOwnerLast();
      }));
      const laneSaveTpl = els.ownerBody.querySelector('[data-cs="laneSaveTpl"]');
      if (laneSaveTpl) laneSaveTpl.addEventListener("click", () => guard(async () => {
        const form = readLaneForm();
        if (!form || !form.models.trim() || !Number.isFinite(form.budget) || form.budget < 1000) {
          throw new Error(t("desktop.sharing.lane.templateInvalid"));
        }
        if (cardConfig.laneTemplates.length >= 6) throw new Error(t("desktop.sharing.lane.templatesFull"));
        const tpl = {
          title: form.title.trim() || form.models.trim(), models: form.models.trim(), windowUnit: form.windowUnit, windowN: form.windowN,
          budget: Math.round(form.budget), maxClaims: Math.round(form.maxClaims) || 1,
          winStart: form.winStart, winEnd: form.winEnd,
        };
        const list = [...cardConfig.laneTemplates.filter((x) => x.title !== tpl.title), tpl].slice(-6);
        cardConfig.laneTemplates = list;
        await saveCardConfig({ laneTemplates: list });
        notify(t("desktop.sharing.lane.templateSaved"));
      }));
      for (const button of els.ownerBody.querySelectorAll("[data-cs-lane-toggle]")) {
        button.addEventListener("click", () => guard(async () => {
          const index = Number(button.dataset.csLaneToggle);
          const lane = lanes[index];
          const suspending = lane.state !== "suspended";
          // Pausing revokes every borrower key on this lane (review B5):
          // same destructive weight as 停止分享, so it confirms first.
          if (suspending && !window.confirm(t("desktop.sharing.lane.pauseConfirm", { count: String(lanes ? laneSlotsUsedOf(lanes, lane.id) : 0) }))) return;
          const next = lanes.map((l, i) => (i === index ? { ...l, state: l.state === "suspended" ? "active" : "suspended" } : l));
          await saveLanes(next.map(toWireLane), {
            successKey: suspending ? "desktop.sharing.lane.pausedSaved" : "desktop.sharing.lane.resumed",
          });
        }));
      }
      const claimsToggle = els.ownerBody.querySelector('[data-cs="claimsToggle"]');
      if (claimsToggle) claimsToggle.addEventListener("click", () => {
        showAllClaims = !showAllClaims;
        renderOwnerLast();
      });
      const laneCancel = els.ownerBody.querySelector('[data-cs="laneCancel"]');
      if (laneCancel) laneCancel.addEventListener("click", () => { laneEditor = null; renderOwnerLast(); });
      const laneDelete = els.ownerBody.querySelector('[data-cs="laneDelete"]');
      if (laneDelete) laneDelete.addEventListener("click", () => guard(async () => {
        if (!window.confirm(t("desktop.sharing.lane.deleteConfirm"))) return;
        const id = laneEditor.draft.id;
        await saveLanes(lanes.filter((l) => l.id !== id).map(toWireLane), { successKey: "desktop.sharing.lane.deleted" });
      }));
      const laneSave = els.ownerBody.querySelector('[data-cs="laneSave"]');
      if (laneSave) laneSave.addEventListener("click", () => guard(async () => {
        const form = readLaneForm();
        if (!form) return;
        if (!form.title) throw new Error(t("desktop.sharing.lane.titleRequired"));
        const titleTaken = lanes.some((l) => l.id !== laneEditor.draft.id && l.title === form.title);
        if (titleTaken) throw new Error(t("desktop.sharing.lane.titleDuplicate"));
        if (!Number.isFinite(form.budget) || form.budget < 1000) throw new Error(t("desktop.sharing.lane.budgetInvalid"));
        if (!Number.isFinite(form.maxClaims) || form.maxClaims < 1) throw new Error(t("desktop.sharing.lane.maxClaimsInvalid"));
        // Half-filled windows must never degrade into "open all day" silently
        // (review B4): both bounds or neither; equal bounds are rejected too
        // instead of silently collapsing to all-day (review B2).
        const winComplete = (form.winStart && form.winEnd) || (!form.winStart && !form.winEnd);
        if (!winComplete) throw new Error(t("desktop.sharing.lane.windowIncomplete"));
        if (form.winStart && form.winStart === form.winEnd) throw new Error(t("desktop.sharing.lane.windowEqual"));
        const peakComplete = (form.peakStart && form.peakEnd) || (!form.peakStart && !form.peakEnd);
        if (!peakComplete) throw new Error(t("desktop.sharing.lane.peakIncomplete"));
        if (form.peakStart && form.peakStart === form.peakEnd) throw new Error(t("desktop.sharing.lane.windowEqual"));
        const halfWin = (start, end) => (start && end && start !== end) ? [{ start, end }] : [];
        const schedule = halfWin(form.winStart, form.winEnd);
        const peak = halfWin(form.peakStart, form.peakEnd);
        const draft = {
          id: laneEditor.draft.id || form.title,
          title: form.title,
          models: form.models.split(",").map((m) => m.trim()).filter(Boolean),
          budgetTokens: Math.round(form.budget),
          windowUnit: form.windowUnit,
          windowN: Math.max(1, Math.min(48, Math.round(form.windowN) || 1)),
          maxClaims: Math.round(form.maxClaims),
          state: laneEditor.draft.state || "active",
          schedule,
          peak: { windows: peak, multiplier: Math.round(form.peakMultiplier) },
        };
        const next = laneEditor.isNew
          ? [...lanes, draft]
          : lanes.map((l) => (l.id === laneEditor.draft.id ? draft : l));
        await saveLanes(next.map(toWireLane));
      }));

      // Live budget conversion hint (review B2): raw tokens <-> compact display
      const budgetInput = els.ownerBody.querySelector('[data-cs-f="budget"]');
      const budgetHint = els.ownerBody.querySelector('[data-cs="budgetHint"]');
      if (budgetInput && budgetHint) {
        budgetInput.addEventListener("input", () => {
          budgetHint.textContent = t("desktop.sharing.lane.budgetHint", { text: compact(Number(budgetInput.value) || 0) });
        });
      }
    }

    let lastOwnerData = {};
    const renderOwnerLast = () => renderOwner(lastOwnerData);

    // Lane budget suggestions (R49 productized): the sidecar derives usage
    // families + busy windows from the owner's own CPA usage; the card turns
    // them into per-family pre-fills. The reserve ratio is a user knob —
    // suggested budget = own use × (1 − reserve), recomputed live.
    let suggestData = null;
    ctx.invoke("compute-sharing:owner-suggest", {}).then((data) => {
      if (!data || (!data.families && !data.zhipu)) return;
      suggestData = data;
      renderOwnerLast();
    }).catch(() => { /* advisory: stay silent when unavailable */ });

    // card-side config: reserve ratio + personal lane templates, persisted in
    // the module config store (same channel the zhipu-plan card uses)
    let cardConfig = { reservePct: 25, laneTemplates: [] };
    ctx.invoke("modules:get", {}).then((state) => {
      const entry = ((state || {}).modules || {})["compute-sharing"] || {};
      const config = entry.config || {};
      const reserve = Number(config.reservePct);
      if (Number.isFinite(reserve)) cardConfig.reservePct = Math.min(95, Math.max(5, Math.round(reserve)));
      if (Array.isArray(config.laneTemplates)) {
        cardConfig.laneTemplates = config.laneTemplates.filter((tpl) => tpl && tpl.models && Number.isFinite(Number(tpl.budget))).slice(0, 6);
      }
      renderOwnerLast();
    }).catch(() => { /* defaults hold when the store is unreadable */ });
    const saveCardConfig = (patch) => ctx.invoke("modules:set", { id: "compute-sharing", config: patch })
      .catch(() => { /* keep UI state even if persistence fails */ });

    const suggestedBudget = (weeklyTokens) => Math.max(1000, Math.round(weeklyTokens * (1 - cardConfig.reservePct / 100)));

    function suggestBlock() {
      const families = (suggestData && suggestData.families) || [];
      const zhipuKeys = (suggestData && suggestData.zhipu && suggestData.zhipu.results) || [];
      if (!families.length && !zhipuKeys.length) return "";
      const zhipuParts = zhipuKeys
        .map((result) => {
          const window = result.quota && result.quota.windows && result.quota.windows[0];
          return window ? `${result.label} ${window.pct ?? "?"}%` : null;
        })
        .filter(Boolean);
      const familyLines = families.map((fam, i) => {
        const sched = fam.busy
          ? t("desktop.sharing.suggest.schedOffpeak", { busy: `${fam.busy.start}–${fam.busy.end}`, open: `${fam.busy.end}–${fam.busy.start}` })
          : t("desktop.sharing.suggest.schedAllDay");
        return `<div class="cs-muted">· ${esc(fam.family)} · ${esc(t("desktop.sharing.suggest.famUsed", { used: compact(fam.weeklyTokens) }))} · ${esc(sched)} · ${esc(t("desktop.sharing.suggest.famBudget", { budget: compact(suggestedBudget(fam.weeklyTokens)) }))} <button class="outline-button" type="button" data-cs-family="${i}">${esc(t("desktop.sharing.suggest.createLane"))}</button></div>`;
      });
      return `<div class="cs-suggest">
        <div class="cs-suggest-head">
          <strong>${esc(t("desktop.sharing.suggest.title"))}</strong>
          <label class="cs-reserve">${esc(t("desktop.sharing.suggest.reserve"))} <input data-cs="reserve" type="number" min="5" max="95" step="1" value="${esc(String(cardConfig.reservePct))}" />%</label>
        </div>
        ${familyLines.map((line) => `<div>${line}</div>`).join("")}
        ${zhipuParts.length ? `<div class="cs-muted">· ${esc(t("desktop.sharing.suggest.zhipu", { list: zhipuParts.join(" · ") }))}</div>` : ""}
        <div class="cs-muted">${esc(t("desktop.sharing.suggest.reserveHint"))}</div>
      </div>`;
    }

    // personal templates + the blank entry: chips fill the editor as drafts
    function templateBlock() {
      const chips = cardConfig.laneTemplates.map((tpl, i) => `
        <span class="cs-tpl-chip">
          <button class="outline-button" type="button" data-cs-tpl="${i}">${esc(tpl.title || tpl.models)}</button>
          <button class="cs-tpl-del" type="button" data-cs-tpl-del="${i}" title="${esc(t("desktop.sharing.lane.templateRemove"))}">×</button>
        </span>`).join("");
      return `<div class="cs-templates">
        <span class="cs-muted">${esc(t("desktop.sharing.lane.add"))}:</span>
        ${chips}
        <button class="outline-button" type="button" data-cs-tpl="blank">${esc(t("desktop.sharing.lane.template.blank"))}</button>
      </div>`;
    }

    // ── 算力借用（车道目录 + 我的认领） ────────────────────────────────────
    // 认领卡「接入配置」：标签/值/操作三列网格。值单行省略号截断（悬停看全量），
    // 复制始终给完整可执行行（B11）——可读性来自不折行，不是靠缩短内容。
    function configBlock(claim) {
      const base = String(claim.baseURL || "").replace(/\/+$/, "");
      const block = document.createElement("div");
      block.className = "cs-claim-config";
      const maskOf = (value) => (value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : "…");
      for (const [id, labelKey, name, value, secret] of [
        ["openai-url", "desktop.sharing.borrow.label.openaiUrl", "OPENAI_BASE_URL", `${base}/v1`, false],
        ["openai-key", "desktop.sharing.borrow.label.openaiKey", "OPENAI_API_KEY", claim.token, true],
        ["anthropic-url", "desktop.sharing.borrow.label.anthropicUrl", "ANTHROPIC_BASE_URL", base, false],
        ["anthropic-token", "desktop.sharing.borrow.label.anthropicToken", "ANTHROPIC_AUTH_TOKEN", claim.token, true],
      ]) {
        const label = document.createElement("span");
        label.className = "cs-claim-label";
        label.textContent = t(labelKey);
        const code = document.createElement("code");
        code.className = "cs-claim-value";
        code.dataset.csConfig = id;
        code.title = `export ${name}=${value}`;
        const line = () => `export ${name}=${value}`;
        const copy = document.createElement("button");
        copy.className = "outline-button cs-claim-mini";
        copy.type = "button";
        copy.textContent = t("desktop.sharing.borrow.copy");
        copy.addEventListener("click", () => {
          navigator.clipboard?.writeText(line()).then(() => {
            copy.textContent = t("desktop.sharing.borrow.copied");
            setTimeout(() => { copy.textContent = t("desktop.sharing.borrow.copy"); }, 1200);
          });
        });
        const row = document.createElement("div");
        row.className = "cs-claim-row";
        if (!secret) code.textContent = value;
        row.append(label, code);
        if (secret) {
          let revealed = false;
          const render = () => { code.textContent = revealed ? value : maskOf(value); };
          render();
          const reveal = document.createElement("button");
          reveal.className = "outline-button cs-claim-mini";
          reveal.type = "button";
          reveal.textContent = t("desktop.sharing.borrow.reveal");
          reveal.addEventListener("click", () => {
            revealed = !revealed;
            render();
            reveal.textContent = t(revealed ? "desktop.sharing.borrow.hide" : "desktop.sharing.borrow.reveal");
          });
          row.append(reveal);
        }
        row.append(copy);
        block.append(row);
      }
      return block;
    }

    function laneClaimRow(share, lane) {
      const total = lane.budgetTokens || 0;
      const used = lane.settledTokens || 0;
      const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
      const claimable = lane.open && !lane.exhausted && lane.slotsLeft > 0;
      const status = lane.state === "suspended"
        ? `<span class="cs-state">${esc(t("desktop.sharing.lane.paused"))}</span>`
        : lane.open
          ? (lane.exhausted
            ? `<span class="cs-state">${esc(t("desktop.sharing.lane.exhausted"))}</span> ${esc(t("desktop.sharing.lane.resetAt", { time: clockText(lane.windowEndsAtMs || Date.now()) }))}`
            : esc(t("web.sharing.online")))
          : `${esc(t("desktop.sharing.lane.closedUntil"))} · ${esc(clockText(Date.now() + (lane.retryAfterMs || 0)))}`;
      return `<div class="cs-lane">
        <div class="cs-kv">
          <span><span class="cs-dot cs-dot-${laneDot(lane)}"></span> <strong>${esc(lane.title)}</strong>
            <span class="cs-lane-tag">${esc(lane.models.join(", "))}</span></span>
          <span>${status}</span>
        </div>
        <div class="cs-kv"><span class="cs-muted">${esc(windowLabel(lane.window))} · ${esc(scheduleText(lane))} ${laneTags(lane)}</span>
          <span class="num">${esc(compact(used))} / ${esc(compact(total))}</span></div>
        <div class="cs-meter"><i style="width:${pct}%"></i></div>
        <div class="cs-actions">
          <span class="cs-muted">${esc(t("web.sharing.slots"))}: ${lane.slotsLeft > 0 ? lane.slotsLeft : esc(t("web.sharing.claimFull"))}</span>
          <span class="cs-grow"></span>
          <button class="primary-pill" data-cs-claim="${esc(share.shareId)}" data-cs-claim-lane="${esc(lane.id)}" type="button"${claimable ? "" : " disabled"}>${esc(t("desktop.sharing.borrow.claim"))}</button>
        </div>
      </div>`;
    }

    const hbAgeOf = (share) => Date.now() - (((share.plugin || {}).lastHeartbeatAt) || 0);

    function borrowStatusView(share) {
      if (!share.online) return { cls: "off", label: t("web.sharing.offline") };
      if (share.state && share.state !== "active") return { cls: "paused", label: t("web.sharing.paused") };
      return { cls: "on", label: t("web.sharing.online") };
    }

    // ── 目录规模化（M1-M3/M5）：分层 → 排序 → 过滤 → 折叠，先算后渲染 ──
    const laneClaimable = (lane) => lane.state !== "suspended" && lane.open && !lane.exhausted
      && (lane.slotsLeft ?? 0) > 0 && (lane.availableTokens ?? lane.budgetTokens ?? 1) > 0;
    // T1 可认领 / T2 等待开放（时段未开但有名额有量）/ T3 其余（耗尽·满员·暂停）
    const shareTierOf = (share) => {
      const lanes = share.lanes || [];
      if (lanes.length) {
        if (lanes.some(laneClaimable)) return 1;
        if (lanes.some((l) => l.state !== "suspended" && !l.open && (l.slotsLeft ?? 0) > 0 && !l.exhausted)) return 2;
        return 3;
      }
      if (share.state === "active" && (share.slotsLeft ?? 0) > 0 && !share.exhausted) return 1;
      return share.state === "active" ? 2 : 3;
    };
    const shareRemainingRatio = (share) => {
      const lanes = share.lanes || [];
      const ratio = (budget, available) => (budget > 0 ? Math.min(1, (available ?? budget) / budget) : 0);
      return lanes.length
        ? Math.max(...lanes.map((l) => ratio(l.budgetTokens, l.availableTokens)))
        : ratio(share.budgetTokens, share.availableTokens);
    };
    const familyOfModel = (model) => (model.includes("*") ? model : `${model.split("-")[0]}-*`);
    const laneMatchesFamily = (lane, family) => (lane.models || []).some((m) => {
      if (m === family) return true;
      const lanePrefix = m.endsWith("*") ? m.slice(0, -1) : null;
      const famPrefix = family.endsWith("*") ? family.slice(0, -1) : null;
      return (lanePrefix !== null && family.startsWith(lanePrefix)) || (famPrefix !== null && m.startsWith(famPrefix));
    });
    // 会话内过滤态：目录是低频操作面，不持久化（方案 §5.2）
    let borrowFilterFamily = null;
    let borrowOnlyAvailable = true;
    const borrowExpandedLanes = new Set();
    let borrowT3Open = false;

    function renderDirectory(shares, noBase) {
      if (noBase) {
        els.directory.innerHTML = `<div class="cs-muted">${esc(t("desktop.modules.onlineNoCloud"))}</div>`;
        return;
      }
      const online = (shares || []).filter((s) => s.online);
      if (!online.length) {
        els.directory.innerHTML = `<div class="cs-muted">${esc(t("web.sharing.empty"))}</div>`;
        return;
      }
      // M1: tier → remaining ratio → heartbeat freshness → title（稳定排序）
      const ranked = online
        .map((share) => ({ share, tier: shareTierOf(share) }))
        .sort((a, b) => (a.tier - b.tier)
          || (shareRemainingRatio(b.share) - shareRemainingRatio(a.share))
          || (hbAgeOf(a.share) - hbAgeOf(b.share))
          || String(a.share.title).localeCompare(String(b.share.title)));
      const families = [...new Set(online.flatMap((s) => (s.lanes || []).flatMap((l) => (l.models || []).map(familyOfModel))))].sort();
      const filterLanes = (lanes) => (borrowFilterFamily ? lanes.filter((l) => laneMatchesFamily(l, borrowFilterFamily)) : lanes);
      // T3 never renders as a card — it lives in the collapsed tail group;
      // the claimable-only toggle additionally hides waiting (T2) nodes
      const visible = ranked.filter(({ share, tier }) => {
        if (tier === 3) return false;
        if (borrowOnlyAvailable && tier !== 1) return false;
        if (borrowFilterFamily && !(share.lanes || []).some((l) => laneMatchesFamily(l, borrowFilterFamily))) return false;
        return true;
      });
      const hiddenCount = ranked.length - visible.length;

      const chips = [`<button class="cs-chip${borrowFilterFamily === null ? " active" : ""}" type="button" data-cs-family="">${esc(t("desktop.sharing.borrow.filterAll"))}</button>`,
        ...families.map((f) => `<button class="cs-chip${borrowFilterFamily === f ? " active" : ""}" type="button" data-cs-family="${esc(f)}">${esc(f)}</button>`)].join("");
      const toolbar = `<div class="cs-dir-tools">
        <span class="cs-chips">${chips}</span>
        <label class="cs-check"><input type="checkbox" data-cs="onlyAvailable"${borrowOnlyAvailable ? " checked" : ""} /><span>${esc(t("desktop.sharing.borrow.onlyAvailable"))}</span></label>
      </div>`;

      const LANES_SHOWN = 3;
      const cardOf = ({ share }) => {
        const status = borrowStatusView(share);
        const lanes = filterLanes(share.lanes || []);
        const expanded = borrowExpandedLanes.has(share.shareId);
        const shown = expanded ? lanes : lanes.slice(0, LANES_SHOWN);
        const more = lanes.length - shown.length;
        const header = `<div class="cs-row">
          <div class="cs-kv"><strong>${esc(share.title)}</strong>
            <span class="cs-dot cs-dot-${status.cls}" title="${esc(status.label)}"></span></div>
          ${lanes.length ? "" : `<div class="cs-actions">
            <span class="cs-muted">${esc(t("web.sharing.slots"))}: ${share.slotsLeft > 0 ? share.slotsLeft : esc(t("web.sharing.claimFull"))}</span>
            <span class="cs-grow"></span>
            <button class="primary-pill" data-cs-claim="${esc(share.shareId)}" type="button"${share.state === "active" && share.slotsLeft > 0 && !share.exhausted ? "" : " disabled"}>${esc(t("desktop.sharing.borrow.claim"))}</button>
          </div>`}
        </div>`;
        const expander = more > 0
          ? `<button class="cs-tpl-del cs-lane-more" type="button" data-cs-lanes-more="${esc(share.shareId)}">${esc(t("desktop.sharing.borrow.expandLanes", { n: String(more) }))}</button>`
          : (expanded && lanes.length > LANES_SHOWN
            ? `<button class="cs-tpl-del cs-lane-more" type="button" data-cs-lanes-more="${esc(share.shareId)}">${esc(t("desktop.sharing.borrow.collapseLanes"))}</button>`
            : "");
        return `<div class="cs-dir-card">${header}${shown.map((lane) => laneClaimRow(share, lane)).join("")}${expander}</div>`;
      };

      const t3Group = (!borrowOnlyAvailable || hiddenCount > 0) && !borrowOnlyAvailable
        ? "" : ""; // placeholder, replaced below
      const t3 = ranked.filter((x) => x.tier === 3);
      const t3Section = t3.length && !borrowOnlyAvailable
        ? `<div class="cs-t3">
            <button class="cs-lane-more" type="button" data-cs="t3Toggle">${esc(t("desktop.sharing.borrow.hiddenGroup", { n: String(t3.length) }))}${borrowT3Open ? " ▴" : " ▾"}</button>
            ${borrowT3Open ? t3.map(({ share }) => `<div class="cs-kv cs-t3-row"><span>${esc(share.title)}</span><span class="cs-muted">${esc(borrowStatusView(share).label)} · ${esc(t("web.sharing.slots"))}: ${share.slotsLeft > 0 ? share.slotsLeft : esc(t("web.sharing.claimFull"))}</span></div>`).join("") : ""}
          </div>`
        : "";

      const body = visible.length
        ? visible.map(cardOf).join("")
        : `<div class="cs-muted">${esc(t("desktop.sharing.borrow.emptyFiltered"))} <button class="cs-tpl-del" type="button" data-cs="clearFilter">${esc(t("desktop.sharing.borrow.clearFilter"))}</button></div>`;
      const hiddenNote = borrowOnlyAvailable && hiddenCount > 0
        ? `<div class="cs-muted cs-hidden-note">${esc(t("desktop.sharing.borrow.hiddenNote", { n: String(hiddenCount) }))}</div>`
        : "";
      els.directory.innerHTML = toolbar + body + hiddenNote + t3Section;

      for (const chip of els.directory.querySelectorAll("[data-cs-family]")) {
        chip.addEventListener("click", () => {
          borrowFilterFamily = chip.dataset.csFamily || null;
          renderDirectory(shares, noBase);
        });
      }
      const onlyBox = els.directory.querySelector('[data-cs="onlyAvailable"]');
      if (onlyBox) onlyBox.addEventListener("change", () => {
        borrowOnlyAvailable = onlyBox.checked;
        renderDirectory(shares, noBase);
      });
      for (const btn of els.directory.querySelectorAll("[data-cs-lanes-more]")) {
        btn.addEventListener("click", () => {
          const id = btn.dataset.csLanesMore;
          if (borrowExpandedLanes.has(id)) borrowExpandedLanes.delete(id); else borrowExpandedLanes.add(id);
          renderDirectory(shares, noBase);
        });
      }
      const t3Btn = els.directory.querySelector('[data-cs="t3Toggle"]');
      if (t3Btn) t3Btn.addEventListener("click", () => { borrowT3Open = !borrowT3Open; renderDirectory(shares, noBase); });
      const clearBtn = els.directory.querySelector('[data-cs="clearFilter"]');
      if (clearBtn) clearBtn.addEventListener("click", () => { borrowFilterFamily = null; borrowOnlyAvailable = true; renderDirectory(shares, noBase); });
      for (const button of els.directory.querySelectorAll("[data-cs-claim]")) {
        button.addEventListener("click", () => guard(() => claimShare(button.dataset.csClaim, button.dataset.csClaimLane || null)));
      }
    }

    function renderMine(claims, liveById) {
      if (!claims.length) {
        els.mine.innerHTML = `<div class="cs-muted">${esc(t("desktop.sharing.borrow.myClaimsEmpty"))}</div>`;
        return;
      }
      els.mine.innerHTML = "";
      for (const claim of claims) {
        const live = liveById && liveById.get(claim.keyId);
        const state = live && live.state
          ? live.state
          : (claim.expiresAt && claim.expiresAt <= Date.now() ? "expired" : "valid");
        const row = document.createElement("div");
        row.className = "cs-row";
        row.innerHTML = `
          <div class="cs-kv">
            <strong>${esc(claim.shareTitle || claim.shareId)}</strong>
            <span class="cs-muted">${esc(String(claim.keyId).slice(0, 11))}…</span>
          </div>
          <div class="cs-muted cs-claim-meta">${claim.laneTitle ? `<span class="cs-lane-tag">${esc(claim.laneTitle)}</span>${claim.models && claim.models.length ? ` <span class="cs-lane-tag">${esc(claim.models.join(", "))}</span>` : ""}${claim.tzLabel ? ` <span class="cs-lane-tag">${esc(claim.tzLabel)}</span>` : ""}` : ""}</div>
          <div class="cs-muted cs-claim-meta">${esc(t("desktop.sharing.borrow.expires"))}: ${esc(fmtDateTime(claim.expiresAt))}${live ? ` · ${esc(t("desktop.sharing.borrow.used"))}: ${esc(compact(live.usedTokens))}` : ""}${state !== "valid" ? ` · <span class="cs-state">${esc(t(state === "revoked" ? "desktop.sharing.borrow.stateRevoked" : "desktop.sharing.borrow.stateExpired"))}</span>` : ""}</div>
          <div class="cs-claim-section">${esc(t("desktop.sharing.borrow.sectionConfig"))}</div>`;
        if (state === "valid") {
          row.appendChild(configBlock(claim));
          const testHead = document.createElement("div");
          testHead.className = "cs-claim-section";
          testHead.textContent = t("desktop.sharing.borrow.sectionTest");
          row.appendChild(testHead);
          // connectivity test (G3): one minimal generation through the owner's
          // CPA — the sidecar relays it (no CORS on CPA). The model input
          // defaults to the lane's exact model; wildcards need a real name.
          const exactModel = (claim.models || []).find((m) => m && !m.includes("*"));
          const test = document.createElement("div");
          test.className = "cs-fields cs-test-row";
          test.innerHTML = `
            <input class="grow" data-cs-test-model="${esc(claim.keyId)}" type="text" placeholder="${esc(t("desktop.sharing.borrow.testModel"))}: ${esc(exactModel || "gemini-3.8-flash-high")}" />
            <button class="outline-button" type="button" data-cs-test="${esc(claim.keyId)}">${esc(t("desktop.sharing.borrow.test"))}</button>
            <span class="cs-status" data-cs-test-result="${esc(claim.keyId)}"></span>`;
          row.appendChild(test);
          row.querySelector(`[data-cs-test="${CSS.escape(claim.keyId)}"]`).addEventListener("click", () => guard(async () => {
            const model = String(row.querySelector(`[data-cs-test-model="${CSS.escape(claim.keyId)}"]`).value || exactModel || "").trim();
            const resultEl = row.querySelector(`[data-cs-test-result="${CSS.escape(claim.keyId)}"]`);
            if (!model) {
              resultEl.textContent = t("desktop.sharing.borrow.testModelRequired");
              resultEl.className = "cs-status cs-state";
              return;
            }
            resultEl.textContent = t("desktop.sharing.borrow.testing");
            try {
              const result = await ctx.invoke("compute-sharing:borrow-test", { token: claim.token, baseURL: claim.baseURL, model });
              resultEl.textContent = result.ok
                ? t("desktop.sharing.borrow.testOk", { model })
                : t("desktop.sharing.borrow.testFail", { status: String(result.status), reason: result.error || "" });
              resultEl.className = `cs-status ${result.ok ? "" : "cs-state"}`;
            } catch (error) {
              resultEl.textContent = t("desktop.sharing.borrow.testFail", { status: "-", reason: String(error).slice(0, 120) });
              resultEl.className = "cs-status cs-state";
            }
          }));
          const actions = document.createElement("div");
          actions.className = "cs-actions cs-claim-footer";
          const revoke = document.createElement("button");
          revoke.className = "link-button";
          revoke.type = "button";
          revoke.textContent = t("desktop.sharing.borrow.revoke");
          revoke.addEventListener("click", () => guard(() => revokeClaim(claim)));
          actions.appendChild(revoke);
          // renewal keeps the same key (G3): offered when under a day is left,
          // the extended expiry reaches the owner plugin on its next heartbeat
          const dayLeft = claim.expiresAt - Date.now() < 24 * 3_600_000;
          if (dayLeft) {
            const renew = document.createElement("button");
            renew.className = "outline-button";
            renew.type = "button";
            renew.textContent = t("desktop.sharing.borrow.renew");
            renew.addEventListener("click", () => guard(() => renewClaim(claim)));
            actions.appendChild(renew);
          }
          row.appendChild(actions);
        }
        els.mine.appendChild(row);
      }
    }

    async function claimShare(shareId, laneId) {
      notify(t("desktop.sharing.borrow.claiming"));
      const ts = Date.now();
      const signed = await ctx.invoke("compute-sharing:claim-sign", { shareId, ts });
      const data = await apiPost("/api/shares/claim", {
        shareId,
        laneId: laneId || undefined,
        participantId: signed.participantId,
        ts: signed.ts ?? ts,
        signature: signed.signature,
      });
      const store = await ctx.invoke("compute-sharing:borrow-get");
      const claims = Array.isArray(store && store.claims) ? store.claims : [];
      const record = {
        keyId: data.keyId,
        token: data.token,
        baseURL: data.baseURL,
        shareId,
        laneId: data.laneId || null,
        laneTitle: data.laneTitle || "",
        tzLabel: data.tzLabel || "",
        shareTitle: data.shareTitle,
        models: data.models || [],
        expiresAt: data.expiresAt,
      };
      await ctx.invoke("compute-sharing:borrow-set", { claims: [record, ...claims.filter((c) => c.keyId !== record.keyId)] });
      notify(t("desktop.sharing.borrow.claimed"));
      await refresh({ forceShares: true });
    }

    async function renewClaim(claim) {
      const data = await apiPost("/api/shares/claims/renew", { token: claim.token });
      const store = await ctx.invoke("compute-sharing:borrow-get");
      const claims = (Array.isArray(store && store.claims) ? store.claims : [])
        .map((c) => (c.keyId === claim.keyId ? { ...c, expiresAt: data.expiresAt } : c));
      await ctx.invoke("compute-sharing:borrow-set", { claims });
      notify(t("desktop.sharing.borrow.renewed"));
      await refresh({ forceShares: true });
    }

    async function revokeClaim(claim) {
      await apiPost("/api/shares/claims/revoke", { token: claim.token });
      const store = await ctx.invoke("compute-sharing:borrow-get");
      const claims = (Array.isArray(store && store.claims) ? store.claims : []).filter((c) => c.keyId !== claim.keyId);
      await ctx.invoke("compute-sharing:borrow-set", { claims });
      notify(t("desktop.sharing.borrow.revoked"));
      await refresh({ forceShares: true });
    }

    // ── 统一刷新 ──────────────────────────────────────────────────────────
    async function refresh({ forceShares = false } = {}) {
      // owner: not_registered (never registered, or unregistered) collapses
      // the section; any other error collapses it too — owner data never
      // blocks the borrow flow below.
      try {
        lastOwnerData = await ctx.invoke("compute-sharing:owner-status", {});
      } catch (error) {
        // A transient failure must not freeze the card into the borrower-only
        // layout: retry briefly before settling the definitive "no owner".
        lastOwnerData = {};
        for (let attempt = 0; attempt < 2 && !lastOwnerData.share; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          try {
            lastOwnerData = await ctx.invoke("compute-sharing:owner-status", {});
          } catch { /* keep retrying */ }
        }
      }
      ownerSettled = true;
      renderOwner(lastOwnerData);
      // borrow: local claims + live usage
      const store = await ctx.invoke("compute-sharing:borrow-get");
      const claims = Array.isArray(store && store.claims) ? store.claims : [];
      let liveById = null;
      if (claims.length) {
        try {
          const base = ctx.apiBase && ctx.apiBase();
          if (base) {
            const response = await fetch(`${base}/api/shares/claims/mine`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ tokens: claims.map((c) => c.token) }),
              signal: AbortSignal.timeout(8000),
            });
            if (response.ok) {
              const data = await response.json();
              liveById = new Map((data.claims || []).map((c) => [c.keyId, c]));
            }
          }
        } catch { /* keep last known usage */ }
      }
      renderMine(claims, liveById);
      if (forceShares || !els.directory.childElementCount) {
        try {
          const base = ctx.apiBase && ctx.apiBase();
          if (!base) {
            renderDirectory([], true);
          } else {
            const response = await fetch(`${base}/api/shares`, { signal: AbortSignal.timeout(8000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            renderDirectory(((await response.json()).shares) || []);
          }
        } catch (error) {
          els.directory.innerHTML = `<div class="cs-muted">${esc(t("desktop.sharing.borrow.directoryFailed", { error: String(error.message || error) }))}</div>`;
        }
      }
    }

    el.querySelector('[data-cs="refresh"]').addEventListener("click", () => guard(() => refresh({ forceShares: true })));

    // Re-entering view re-fetches (throttled) so an early network failure
    // doesn't freeze the error message until a manual refresh.
    let lastFetchMs = Date.now();
    if (typeof IntersectionObserver === "function") {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting) && Date.now() - lastFetchMs > 15_000) {
          lastFetchMs = Date.now();
          guard(() => refresh({ forceShares: true }));
        }
      }, { threshold: 0.2 });
      observer.observe(el);
    }

    await guard(() => refresh({ forceShares: true }));
  },
};
