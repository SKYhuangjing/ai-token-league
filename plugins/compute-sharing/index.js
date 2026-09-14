// 算力共享插件（compute-sharing）——完全可插拔远端插件（R29b：借用与控制台合并）。
// 一张卡两个区：
//   「我的分享」 owner 控制台（账本/借用者/策略/停止）——未注册时整区隐藏，
//               纯借用者不受打扰；share secret 经 sidecar 代发，不进 webview。
//   「算力借用」 在线节点目录 + 实名签名认领 + 我的认领（env 配置/撤销）。
// 平台能力经 ctx（t / invoke(守门) / escapeHtml / apiBase）。

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
.cs-fields input { width: 110px; }
.cs-muted { color: var(--muted, #888); font-size: 12.5px; line-height: 1.4; }
.cs-state { color: var(--red, #c0392b); font-weight: 600; }
.cs-status { min-height: 16px; font-size: 12.5px; }
.cs-board { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(240px, 0.8fr); gap: 8px 32px; align-items: start; }
.cs-board .cs-section { margin-top: 0; }
@media (max-width: 860px) { .cs-board { grid-template-columns: 1fr; } .cs-board .cs-section { margin-top: 10px; } }
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
      <div data-cs="owner" hidden>
        <div class="cs-head"><div class="modules-section-title">${esc(t("desktop.sharing.owner.title"))}</div></div>
        <div data-cs="owner-body" aria-live="polite"></div>
      </div>
      <div class="cs-board">
        <section>
          <div class="cs-head">
            <div class="modules-section-title">${esc(t("desktop.sharing.borrow.section"))}</div>
            <button class="outline-button" type="button" data-cs="refresh">${esc(t("desktop.sharing.borrow.refresh"))}</button>
          </div>
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
          no_claim_slots: "web.sharing.claimFull",
          rate_limited: "desktop.sharing.borrow.rateLimited",
          identity_required: "desktop.sharing.borrow.identityFailed",
          participant_not_registered: "desktop.sharing.borrow.identityFailed",
          invalid_signature: "desktop.sharing.borrow.identityFailed",
        }[data.error];
        throw new Error(errorKey ? t(errorKey) : (data.error || `HTTP ${response.status}`));
      }
      return data;
    }

    // ── 我的分享（owner 控制台；未注册整区隐藏） ─────────────────────────
    const ownerFieldDefs = [
      ["budget", "desktop.sharing.owner.f.budget"],
      ["maxClaims", "desktop.sharing.owner.f.maxClaims"],
      ["keyMaxTokens", "desktop.sharing.owner.f.keyMax"],
      ["keyConcurrency", "desktop.sharing.owner.f.keyConc"],
      ["ttlHours", "desktop.sharing.owner.f.ttl"],
    ];

    function renderOwner(data) {
      const share = (data && data.share) || {};
      const claims = (data && data.claims) || [];
      // not registered yet, or stopped via 停止分享 (the backend keeps the
      // record with state "stopped" and keeps answering owner-status) —
      // either way the console collapses to the borrower-only card
      if (!share.shareId || share.state === "stopped") {
        els.owner.hidden = true;
        els.ownerBody.innerHTML = "";
        return;
      }
      els.owner.hidden = false;
      const total = share.budgetTokens || 0;
      const used = share.settledTokens || 0;
      const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
      const stateLabel = share.state === "active"
        ? t("web.sharing.online")
        : share.state === "suspended" ? t("web.sharing.paused") : t("web.sharing.offline");
      const rows = claims.map((c) => `
        <div class="cs-kv">
          <span>${esc(c.borrower || c.keyId)}${c.displayId ? ` <span class="cs-muted">${esc(c.displayId)}</span>` : ""} · <span class="num">${esc(String(c.keyId).slice(0, 11))}…</span></span>
          <span class="num">${esc(compact(c.usedTokens))} · ${esc(c.state)}</span>
        </div>`).join("");
      els.ownerBody.innerHTML = `
        <div class="cs-row">
          <div class="cs-kv"><strong>${esc(share.title || share.shareId)}</strong>
            <span>${esc(stateLabel)}${share.plugin && share.plugin.online ? "" : ` · ${esc(t("desktop.sharing.owner.pluginOffline"))}`}</span></div>
          <div class="cs-kv"><span class="cs-muted">${esc(t("web.sharing.budget"))}</span><span class="num">${esc(compact(used))} / ${esc(compact(total))}</span></div>
          <div class="cs-meter"><i style="width:${pct}%"></i></div>
          <div class="cs-kv"><span class="cs-muted">${esc(t("web.sharing.slots"))}</span><span class="num">${esc(String(share.slotsLeft ?? "—"))}</span></div>
          <div class="cs-kv"><span class="cs-muted">${esc(t("desktop.sharing.owner.lifetime"))}</span><span class="num">${esc(compact(share.lifetimeSettled))}</span></div>
          ${rows ? `<div class="cs-muted">${esc(t("desktop.sharing.owner.claims"))}</div>${rows}` : `<div class="cs-muted">${esc(t("desktop.sharing.owner.noClaims"))}</div>`}
        </div>
        <div class="cs-row">
          <div class="cs-muted">${esc(t("desktop.sharing.owner.policyTitle"))}</div>
          <div class="cs-fields">${ownerFieldDefs.map(([key, labelKey]) => `
            <label>${esc(t(labelKey))}<input data-cs-policy="${key}" type="number" step="1" placeholder="${esc(String((share.policy && share.policy[key]) ?? ""))}" /></label>`).join("")}
          </div>
          <div class="cs-actions">
            <button class="outline-button" type="button" data-cs="savePolicy">${esc(t("desktop.sharing.owner.savePolicy"))}</button>
            <button class="outline-button" type="button" data-cs="stop">${esc(t("desktop.sharing.owner.stop"))}</button>
          </div>
        </div>`;
      els.ownerBody.querySelector('[data-cs="savePolicy"]').addEventListener("click", () => guard(async () => {
        const policy = {};
        for (const [key] of ownerFieldDefs) {
          const raw = els.ownerBody.querySelector(`[data-cs-policy="${key}"]`)?.value;
          if (raw === undefined || String(raw).trim() === "") continue;
          const value = Number(raw);
          if (!Number.isFinite(value) || value < 0) throw new Error(t("desktop.sharing.owner.policyInvalid"));
          policy[key] = Math.round(value);
        }
        if (!Object.keys(policy).length) throw new Error(t("desktop.sharing.owner.policyEmpty"));
        await ctx.invoke("sharing:owner-policy", { policy });
        notify(t("desktop.sharing.owner.policySaved"));
        await refresh();
      }));
      els.ownerBody.querySelector('[data-cs="stop"]').addEventListener("click", () => guard(async () => {
        if (!window.confirm(t("desktop.sharing.owner.stopConfirm"))) return;
        await ctx.invoke("sharing:owner-unregister", {});
        notify(t("desktop.sharing.owner.stopped"));
        await refresh();
      }));
    }

    // ── 算力借用（目录 + 我的认领） ──────────────────────────────────────
    function configBlock(claim) {
      const base = String(claim.baseURL || "").replace(/\/+$/, "");
      const block = document.createElement("div");
      block.className = "cs-config";
      for (const [name, value] of [
        ["OPENAI_BASE_URL", `${base}/v1`],
        ["OPENAI_API_KEY", claim.token],
        ["ANTHROPIC_BASE_URL", base],
        ["ANTHROPIC_AUTH_TOKEN", claim.token],
      ]) {
        const row = document.createElement("div");
        row.className = "cs-config-row";
        const code = document.createElement("code");
        code.textContent = `export ${name}=${value}`;
        const copy = document.createElement("button");
        copy.className = "outline-button";
        copy.type = "button";
        copy.textContent = t("desktop.sharing.borrow.copy");
        copy.addEventListener("click", () => {
          navigator.clipboard?.writeText(value).then(() => {
            copy.textContent = t("desktop.sharing.borrow.copied");
            setTimeout(() => { copy.textContent = t("desktop.sharing.borrow.copy"); }, 1200);
          });
        });
        row.append(code, copy);
        block.appendChild(row);
      }
      return block;
    }

    function borrowStatusView(share) {
      if (!share.online) return { cls: "off", label: t("web.sharing.offline") };
      if (share.state && share.state !== "active") return { cls: "paused", label: t("web.sharing.paused") };
      return { cls: "on", label: t("web.sharing.online") };
    }

    function renderDirectory(shares, noBase) {
      const online = (shares || []).filter((s) => s.online);
      if (noBase) {
        els.directory.innerHTML = `<div class="cs-muted">${esc(t("desktop.modules.onlineNoCloud"))}</div>`;
        return;
      }
      if (!online.length) {
        els.directory.innerHTML = `<div class="cs-muted">${esc(t("web.sharing.empty"))}</div>`;
        return;
      }
      els.directory.innerHTML = online.map((share) => {
        const status = borrowStatusView(share);
        const total = share.budgetTokens || 0;
        const used = share.settledTokens || 0;
        const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
        const claimable = share.state === "active" && share.slotsLeft > 0 && !share.exhausted;
        return `<div class="cs-row" data-share="${esc(share.shareId)}">
          <div class="cs-kv">
            <strong>${esc(share.title)}</strong>
            <span class="cs-dot cs-dot-${status.cls}" title="${esc(status.label)}"></span>
          </div>
          <div class="cs-muted">${esc(t("web.sharing.models"))}: ${esc((share.models || []).join(", ") || "—")}</div>
          <div class="cs-muted">${esc(compact(used))} / ${esc(compact(total))}</div>
          <div class="cs-meter"><i style="width:${pct}%"></i></div>
          <div class="cs-actions">
            <span class="cs-muted">${esc(t("web.sharing.slots"))}: ${share.slotsLeft > 0 ? share.slotsLeft : esc(t("web.sharing.claimFull"))}</span>
            <button class="primary-pill" data-cs-claim="${esc(share.shareId)}" type="button"${claimable ? "" : " disabled"}>${esc(t("desktop.sharing.borrow.claim"))}</button>
          </div>
        </div>`;
      }).join("");
      for (const button of els.directory.querySelectorAll("[data-cs-claim]")) {
        button.addEventListener("click", () => guard(() => claimShare(button.dataset.csClaim)));
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
          <div class="cs-muted">${esc(t("desktop.sharing.borrow.expires"))}: ${esc(new Date(claim.expiresAt).toLocaleString())}${live ? ` · ${esc(t("desktop.sharing.borrow.used"))}: ${esc(compact(live.usedTokens))}` : ""}${state !== "valid" ? ` · <span class="cs-state">${esc(t(state === "revoked" ? "desktop.sharing.borrow.stateRevoked" : "desktop.sharing.borrow.stateExpired"))}</span>` : ""}</div>`;
        if (state === "valid") {
          row.appendChild(configBlock(claim));
          const actions = document.createElement("div");
          actions.className = "cs-actions";
          const revoke = document.createElement("button");
          revoke.className = "outline-button";
          revoke.type = "button";
          revoke.textContent = t("desktop.sharing.borrow.revoke");
          revoke.addEventListener("click", () => guard(() => revokeClaim(claim)));
          actions.appendChild(revoke);
          row.appendChild(actions);
        }
        els.mine.appendChild(row);
      }
    }

    async function claimShare(shareId) {
      notify(t("desktop.sharing.borrow.claiming"));
      const ts = Date.now();
      const signed = await ctx.invoke("sharing:claim-sign", { shareId, ts });
      const data = await apiPost("/api/shares/claim", {
        shareId,
        participantId: signed.participantId,
        ts: signed.ts ?? ts,
        signature: signed.signature,
      });
      const store = await ctx.invoke("sharing:borrow-get");
      const claims = Array.isArray(store && store.claims) ? store.claims : [];
      const record = {
        keyId: data.keyId,
        token: data.token,
        baseURL: data.baseURL,
        shareId,
        shareTitle: data.shareTitle,
        models: data.models || [],
        expiresAt: data.expiresAt,
      };
      await ctx.invoke("sharing:borrow-set", { claims: [record, ...claims.filter((c) => c.keyId !== record.keyId)] });
      notify(t("desktop.sharing.borrow.claimed"));
      await refresh({ forceShares: true });
    }

    async function revokeClaim(claim) {
      await apiPost("/api/shares/claims/revoke", { token: claim.token });
      const store = await ctx.invoke("sharing:borrow-get");
      const claims = (Array.isArray(store && store.claims) ? store.claims : []).filter((c) => c.keyId !== claim.keyId);
      await ctx.invoke("sharing:borrow-set", { claims });
      notify(t("desktop.sharing.borrow.revoked"));
      await refresh({ forceShares: true });
    }

    // ── 统一刷新 ──────────────────────────────────────────────────────────
    async function refresh({ forceShares = false } = {}) {
      // owner: not_registered (never registered, or unregistered) collapses
      // the section; any other error collapses it too — owner data never
      // blocks the borrow flow below.
      try {
        renderOwner(await ctx.invoke("sharing:owner-status", {}));
      } catch {
        renderOwner({});
      }
      // borrow: local claims + live usage
      const store = await ctx.invoke("sharing:borrow-get");
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
