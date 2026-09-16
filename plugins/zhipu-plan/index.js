// 智谱套餐用量插件（zhipu-plan）——完全可插拔远端插件（R28c：宿主卡退役）。
// 契约：export default { mount(el, ctx) }；从 OSS 目录安装，卸载即消失，
// 宿主不再携带任何插件卡片代码。平台能力经 ctx 提供：
//   ctx.t / ctx.escapeHtml / ctx.invoke(sidecar 通道) / ctx.apiBase
// Key 为用户自管（modules.json config.keys，经 modules:get/set 读写）；
// 查询走 zhipu-plan:usage（sidecar 60s 缓存 + 托盘同源状态机）。
// 渲染复用宿主按钮/开关皮肤；布局和套餐标签样式由本插件注入，不写进平台样式表。
// 刷新：挂载即查 + 每分钟轻 tick（只改倒计时文本）+ 手动强制刷新。

const STYLE = `
.zhipu-ledger-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 28px; margin-bottom: 4px; }
.zhipu-kicker { font-size: 11.5px; font-weight: 700; letter-spacing: 0.04em; color: var(--muted); }
.zhipu-board { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 28px 32px; align-items: start; }
.zhipu-tools { display: flex; flex-direction: column; gap: 18px; min-width: 0; padding: 2px 0 0 24px; border-left: 1px solid var(--border-subtle); }
.zhipu-config-row { display: flex; flex-direction: column; width: 100%; }
.zhipu-config-toggle { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 40px; gap: 16px; border-bottom: 1px solid var(--border-subtle); }
.zhipu-config-toggle:last-child { border-bottom: 0; }
.zhipu-keys-block { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.zhipu-account { padding: 14px 0 12px; border-bottom: 1px solid var(--border-subtle); }
.zhipu-account:first-child { padding-top: 4px; }
.zhipu-account:last-child { border-bottom: 0; padding-bottom: 0; }
.zhipu-account-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
.zhipu-account-name strong { font-size: 16px; font-weight: 680; letter-spacing: -0.02em; }
.zhipu-account.is-error p, .zhipu-account > p { margin: 6px 0 0; }
.zhipu-windows { display: flex; flex-direction: row; flex-wrap: nowrap; align-items: baseline; gap: 28px; margin-top: 8px; }
.zhipu-line { flex: 0 1 auto; min-width: 0; display: flex; align-items: baseline; justify-content: flex-start; padding: 0; border-bottom: 0; }
.zhipu-status { display: inline-flex; align-items: baseline; gap: 10px; white-space: nowrap; }
.zhipu-status-win { font-size: 13px; font-weight: 650; min-width: 3.4em; color: var(--muted); }
.zhipu-pct { font-size: 22px; font-weight: 720; font-variant-numeric: tabular-nums; letter-spacing: -0.03em; line-height: 1; }
.zhipu-pct[data-level="ok"] { color: var(--green); }
.zhipu-pct[data-level="warn"] { color: var(--cost-accent); }
.zhipu-pct[data-level="crit"] { color: var(--red); }
.zhipu-time { display: inline-flex; align-items: center; gap: 4px; margin-left: 2px; color: var(--muted); }
.zhipu-keys-list:not(:empty) { display: flex; flex-direction: column; gap: 0; margin-top: 2px; border-top: 1px solid var(--border-subtle); }
.zhipu-key-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "name remove" "mask remove"; align-items: center; gap: 1px 16px; min-height: 52px; padding: 10px 0; border-bottom: 1px solid var(--border-subtle); }
.zhipu-key-row strong { grid-area: name; font-size: 13.5px; }
.zhipu-key-mask { grid-area: mask; font-size: 12px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zhipu-key-actions { grid-area: remove; display: flex; gap: 6px; align-self: center; }
.zhipu-key-row.is-editing { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.zhipu-key-edit-label { flex: 0 1 170px; min-width: 130px; }
.zhipu-key-edit-key { flex: 1 1 220px; min-width: 150px; }
.zhipu-key-edit-actions { flex: none; display: flex; gap: 6px; }
.zhipu-key-row.is-editing input { font-size: 13px; padding: 8px 10px; }
.zhipu-add { display: grid; gap: 8px; margin-top: 12px; }
.zhipu-add-key { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
.zhipu-board .zhipu-add input { font-size: 13px; padding: 8px 10px; }
.zhipu-result-output:not(:empty) { margin-top: 2px; }
.zhipu-ledger { display: flex; flex-direction: column; }
.zhipu-clock { width: 13px; height: 13px; flex: none; display: block; }
.zhipu-tier { flex: none; display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 999px; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 10.5px; font-weight: 720; letter-spacing: 0.03em; line-height: 1; text-transform: lowercase; }
.zhipu-tier[data-tier="lite"] { color: #6e4524; background: #f0d7bc; box-shadow: inset 0 0 0 1px rgba(122, 78, 45, 0.28); }
.zhipu-tier[data-tier="pro"] { color: #3c3a36; background: #e4e1d8; box-shadow: inset 0 0 0 1px rgba(70, 66, 58, 0.22); }
.zhipu-tier[data-tier="max"] { color: #6a4708; background: #f6e3a4; box-shadow: inset 0 0 0 1px rgba(180, 122, 16, 0.35); }
.zhipu-tier[data-tier="other"] { color: var(--muted); background: transparent; box-shadow: inset 0 0 0 1px var(--line); }
:root[data-theme="dark"] .zhipu-tier[data-tier="lite"] { color: #f0d2b4; background: rgba(184, 122, 74, 0.28); box-shadow: inset 0 0 0 1px rgba(232, 184, 138, 0.35); }
:root[data-theme="dark"] .zhipu-tier[data-tier="pro"] { color: #e6e2d8; background: rgba(196, 198, 206, 0.16); box-shadow: inset 0 0 0 1px rgba(220, 222, 228, 0.28); }
:root[data-theme="dark"] .zhipu-tier[data-tier="max"] { color: #f6e3a4; background: rgba(244, 176, 0, 0.22); box-shadow: inset 0 0 0 1px rgba(244, 196, 80, 0.4); }
.zhipu-reset, .zhipu-line .muted { font-size: 12.5px; line-height: 1; font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted); white-space: nowrap; }
.zhipu-refreshed { margin-left: auto; animation: zhipu-fade 200ms ease; }
.zhipu-refreshed .zhipu-reset { font-size: 12px; }
.zhipu-refreshed[hidden] { display: none; }
.zhipu-result-output { transition: opacity 140ms ease; }
.zhipu-result-output.is-refreshing { opacity: 0.5; }
#zhipu-refresh-btn.is-busy::before { content: ""; width: 11px; height: 11px; margin-right: 6px; border-radius: 50%; border: 1.5px solid currentColor; border-top-color: transparent; display: inline-block; vertical-align: -1px; animation: zhipu-spin 700ms linear infinite; }
@keyframes zhipu-spin { to { transform: rotate(360deg); } }
@keyframes zhipu-fade { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .zhipu-refreshed, .zhipu-result-output { animation: none; transition: none; }
}
@media (max-width: 860px) {
  .zhipu-board { grid-template-columns: 1fr; }
  .zhipu-tools { border-left: 0; border-top: 1px solid var(--border-subtle); padding: 16px 0 0; }
}
`;

function ensureStyle() {
  let style = document.getElementById("zhipu-plan-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "zhipu-plan-style";
    document.head.appendChild(style);
  }
  if (style.textContent !== STYLE) style.textContent = STYLE;
}

export function maskApiKey(key) {
  const s = String(key || "").trim();
  if (!s) return "";
  if (s.length <= 8) return `${s.slice(0, 2)}••••`;
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

// ── Pure helpers (named exports; unit-tested without a DOM) ──────────────

const TIER_RANKS = ["max", "pro", "lite"];

// Coding Plan ranks: max (gold) > pro (silver) > lite (bronze). Unknown
// levels stay visible as a neutral capsule instead of being dropped.
export function planTier(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return null;
  const rank = TIER_RANKS.find((key) => text === key) || null;
  return { key: rank || "other", label: rank || text };
}

const escOf = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function resetCountdown(resetMs, nowMs, t) {
  const diff = Number(resetMs) - Number(nowMs);
  if (!Number.isFinite(diff) || diff <= 0) return null;
  const mins = Math.ceil(diff / 60000);
  if (mins < 60) return t("desktop.modules.zhipu.resetsInMinutes", { m: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 48) return t("desktop.modules.zhipu.resetsInHm", { h: hours, m: mins % 60 });
  return t("desktop.modules.zhipu.resetsInDays", { d: Math.round(mins / 1440) });
}

// Compact remainder matching the status phrase: "55m", "4h57m", "2d".
export function compactReset(resetMs, nowMs) {
  const diff = Number(resetMs) - Number(nowMs);
  if (!Number.isFinite(diff) || diff <= 0) return null;
  const mins = Math.ceil(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 48) return rem ? `${hours}h${String(rem).padStart(2, "0")}m` : `${hours}h`;
  return `${Math.round(mins / 1440)}d`;
}

const CLOCK = `<svg class="zhipu-clock" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.7V8.15l2.15 1.25" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// How long ago the data was fetched. Same bands as resetCountdown so the two
// clock annotations read as one family (this one counts up from the fetch).
export function refreshedAgeLabel(refreshedMs, nowMs, t) {
  const diff = Number(nowMs) - Number(refreshedMs);
  if (!Number.isFinite(diff) || refreshedMs <= 0 || diff < 0) return null;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("desktop.modules.zhipu.refreshedJustNow");
  if (mins < 60) return t("desktop.modules.zhipu.refreshedMinutesAgo", { m: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("desktop.modules.zhipu.refreshedHoursAgo", { h: hours, m: mins % 60 });
  return t("desktop.modules.zhipu.refreshedDaysAgo", { d: Math.floor(mins / 1440) });
}

// Edit-control keys postdate some hosts; fall back to built-in strings the
// same way (language sniffed via an always-present key).
const EDIT_FALLBACK = {
  "desktop.modules.zhipu.editKey": { zh: "编辑", en: "Edit" },
  "desktop.modules.zhipu.saveKey": { zh: "保存", en: "Save" },
  "desktop.modules.zhipu.cancelKey": { zh: "取消", en: "Cancel" },
};

// The four refreshed-age keys postdate some hosts; fall back to built-in
// strings (language sniffed via an always-present key) instead of raw keys.
const REFRESHED_FALLBACK = {
  "desktop.modules.zhipu.refreshedJustNow": { zh: "刚刚", en: "just now" },
  "desktop.modules.zhipu.refreshedMinutesAgo": { zh: "{m} 分钟前", en: "{m} min ago" },
  "desktop.modules.zhipu.refreshedHoursAgo": { zh: "{h} 小时 {m} 分前", en: "{h} h {m} m ago" },
  "desktop.modules.zhipu.refreshedDaysAgo": { zh: "{d} 天前", en: "{d} d ago" },
};

// Same bands as the menu-bar dot and cc-switch utilizationColor:
// ok <70, warn 70–89, crit ≥90.
export function usageLevel(pct) {
  if (pct == null || pct === "") return null;
  const n = Number(pct);
  if (!Number.isFinite(n)) return null;
  if (n >= 90) return "crit";
  if (n >= 70) return "warn";
  return "ok";
}

function windowPhrase(windowText, pctHtml, resetHtml) {
  const timeHtml = resetHtml ? `<span class="zhipu-time">${CLOCK}${resetHtml}</span>` : "";
  return `<div class="zhipu-line"><span class="zhipu-status"><span class="zhipu-status-win">${escOf(windowText)}:</span>${pctHtml}${timeHtml}</span></div>`;
}

// Window label. The Rust parser stamps a stable `window` name
// ("five_hour"|"weekly"); unit mapping only serves older payloads.
export function windowLabel(w, t) {
  const win = w || {};
  if (win.window === "five_hour") return t("desktop.modules.zhipu.window5h");
  if (win.window === "weekly") return t("desktop.modules.zhipu.windowWeekly");
  if (win.unit === 3) return t("desktop.modules.zhipu.window5h");
  if (win.unit === 6) return t("desktop.modules.zhipu.windowWeekly");
  if (win.unit != null) return t("desktop.modules.zhipu.windowNumbered", { unit: win.unit });
  return t("desktop.modules.zhipu.windowFallback");
}

export function renderResult(data, t) {
  if (!data || data.error) {
    return `<div class="muted">${escOf(data && data.error ? data.error : t("desktop.modules.zhipu.noKeys"))}</div>`;
  }
  if (!Array.isArray(data.results) || !data.results.length) {
    return `<div class="muted">${escOf(t("desktop.modules.zhipu.noKeys"))}</div>`;
  }
  return `<div class="zhipu-ledger">${data.results.map((r, index) => {
    const label = String(r.label || "").trim() || t("desktop.modules.zhipu.keyFallback", { n: index + 1 });
    const name = `<strong>${escOf(label)}</strong>`;
    if (!r.ok) {
      return `<article class="zhipu-account is-error"><header class="zhipu-account-name">${name}</header><p class="muted">${escOf(r.error)}</p></article>`;
    }
    const q = r.quota || {};
    const tierInfo = planTier(q.tier);
    const tier = tierInfo
      ? `<span class="zhipu-tier" data-tier="${escOf(tierInfo.key)}">${escOf(tierInfo.label)}</span>`
      : "";
    const windows = q.windows || [];
    const five = windows.find((w) => w && (w.window === "five_hour" || w.unit === 3)) || null;
    const weekly = windows.find((w) => w && w !== five && (w.window === "weekly" || w.unit === 6)) || null;
    const rest = windows.filter((w) => w && w !== five && w !== weekly);
    const phrase = (w) => {
      const pct = w.pct == null ? null : Number(w.pct);
      const level = usageLevel(pct);
      const pctHtml = level == null
        ? `<span class="muted">—</span>`
        : `<strong class="zhipu-pct" data-level="${level}">${escOf(`${pct}%`)}</strong>`;
      const absText = w.resetIso ? String(w.resetIso).replace("T", " ").replace("Z", "").slice(0, 16) : "";
      const resetMs = w.resetMs != null ? Number(w.resetMs) : (w.resetIso ? Date.parse(w.resetIso) : null);
      const countdown = resetMs != null && Number.isFinite(resetMs) ? compactReset(resetMs, Date.now()) : null;
      const title = absText ? t("desktop.modules.zhipu.resetAt") + " " + absText : "";
      const resetHtml = countdown
        ? `<span class="muted zhipu-reset" data-reset-ms="${resetMs}" data-reset-abs="${escOf(absText)}" title="${escOf(title)}">${escOf(countdown)}</span>`
        : (absText ? `<span class="muted zhipu-reset" title="${escOf(title)}">${escOf(absText.slice(5, 16))}</span>` : "");
      return windowPhrase(windowLabel(w, t), pctHtml, resetHtml);
    };
    const slots = [five, weekly, ...rest].filter(Boolean);
    const body = slots.length ? slots.map((w) => phrase(w)).join("") : `<p class="muted">—</p>`;
    return `<article class="zhipu-account"><header class="zhipu-account-name">${name}${tier}</header><div class="zhipu-windows">${body}</div></article>`;
  }).join("")}</div>`;
}

let usageData = null;
let usageRunning = false;
let tickTimer = null;
let refreshedAt = null; // last real fetch time (ms), restored from config on mount

export default {
  async mount(el, ctx) {
    ensureStyle();
    const esc = ctx.escapeHtml;
    const t = ctx.t;
    let config = {}; // modules.json 的 zhipu-plan config（本卡生命周期内缓存）
    const zhHost = String(t("desktop.modules.zhipu.window5h")).includes("小");
    const ageT = (key, params) => {
      const out = t(key, params);
      if (out !== key) return out;
      const template = REFRESHED_FALLBACK[key];
      if (!template) return out;
      let text = template[zhHost ? "zh" : "en"];
      for (const [name, value] of Object.entries(params || {})) text = text.replace(`{${name}}`, String(value));
      return text;
    };
    const editT = (key) => {
      const out = t(key);
      if (out !== key) return out;
      const template = EDIT_FALLBACK[key];
      return template ? template[zhHost ? "zh" : "en"] : key;
    };
    let editingKeyIndex = null;

    const readConfig = async () => {
      const state = await ctx.invoke("modules:get", {});
      const entry = ((state || {}).modules || {})["zhipu-plan"] || {};
      config = entry.config || {};
      return entry;
    };
    const writeConfig = async (patch) => {
      await ctx.invoke("modules:set", { id: "zhipu-plan", config: patch });
      config = { ...config, ...patch };
    };
    const configKeys = () =>
      Array.isArray(config.keys) ? config.keys.filter((k) => k && typeof k.apiKey === "string" && k.apiKey.trim()) : [];

    const status = (text) => {
      const target = document.getElementById("modules-status");
      if (target) target.textContent = text || "";
    };
    const guard = async (fn) => {
      try {
        await fn();
      } catch (error) {
        status(String(error.message || error));
      }
    };

    function updateResultDom() {
      const resultEl = el.querySelector("#zhipu-result");
      if (!resultEl) return;
      resultEl.innerHTML = usageData
        ? renderResult(usageData, t)
        : `<div class="muted">${esc(t("desktop.modules.zhipu.noKeys"))}</div>`;
      updateRefreshedDom();
    }

    // "refreshed N min ago" — anchored left of the refresh button, same clock
    // annotation family as the reset countdowns. Updated by the minute tick.
    function updateRefreshedDom() {
      const node = el.querySelector("#zhipu-refreshed");
      if (!node) return;
      // only meaningful while real usage data is on screen (no keys / error
      // states carry no freshness story)
      const label = refreshedAt && usageData && !usageData.error
        ? refreshedAgeLabel(refreshedAt, Date.now(), ageT)
        : null;
      if (!label) {
        node.hidden = true;
        delete node.dataset.refreshedMs;
        return;
      }
      node.hidden = false;
      node.dataset.refreshedMs = String(refreshedAt);
      const textEl = node.querySelector(".zhipu-reset");
      if (textEl) textEl.textContent = label;
    }

    async function persistRefreshedAt(stamp) {
      if (config.refreshedAt === stamp) return;
      config.refreshedAt = stamp;
      try { await ctx.invoke("modules:set", { id: "zhipu-plan", config: { refreshedAt: stamp } }); } catch { /* best effort */ }
    }

    function renderKeysList() {
      const listEl = el.querySelector("#zhipu-keys-list");
      if (!listEl) return;
      const keys = configKeys();
      if (editingKeyIndex != null && (editingKeyIndex < 0 || editingKeyIndex >= keys.length)) editingKeyIndex = null;
      listEl.innerHTML = keys.map((k, i) => {
        if (i === editingKeyIndex) {
          // inline edit: both fields prefilled — the key is the user's own
          // local secret, editing it verbatim is the whole point
          return `
        <div class="zhipu-key-row is-editing">
          <input class="zhipu-key-edit-label" data-zhipu-edit-label value="${esc(String(k.label || ""))}" placeholder="${esc(t("desktop.modules.zhipu.keyLabelPlaceholder"))}" autocomplete="off" />
          <input class="zhipu-key-edit-key mono" data-zhipu-edit-key value="${esc(String(k.apiKey || ""))}" autocomplete="off" spellcheck="false" />
          <div class="zhipu-key-edit-actions">
            <button class="outline-button row-inline-action" data-zhipu-key-save="${i}" type="button">${esc(editT("desktop.modules.zhipu.saveKey"))}</button>
            <button class="outline-button row-inline-action" data-zhipu-key-cancel="${i}" type="button">${esc(editT("desktop.modules.zhipu.cancelKey"))}</button>
          </div>
        </div>`;
        }
        return `
        <div class="zhipu-key-row">
          <strong>${esc(String(k.label || "").trim() || t("desktop.modules.zhipu.keyFallback", { n: i + 1 }))}</strong>
          <span class="muted mono zhipu-key-mask">${esc(maskApiKey(k.apiKey))}</span>
          <div class="zhipu-key-actions">
            <button class="outline-button row-inline-action" data-zhipu-key-edit="${i}" type="button">${esc(editT("desktop.modules.zhipu.editKey"))}</button>
            <button class="outline-button row-inline-action" data-zhipu-key-del="${i}" type="button">${esc(t("desktop.modules.zhipu.removeKey"))}</button>
          </div>
        </div>`;
      }).join("");
    }

    async function refreshUsage({ force = false } = {}) {
      const btn = el.querySelector("#zhipu-refresh-btn");
      const resultEl = el.querySelector("#zhipu-result");
      if (!resultEl || usageRunning) return;
      usageRunning = true;
      if (btn) {
        btn.disabled = true;
        btn.classList.add("is-busy");
      }
      // stale-while-revalidate: a manual refresh keeps the previous ledger on
      // screen (dimmed) instead of flashing the content away
      if (force && usageData) resultEl.classList.add("is-refreshing");
      try {
        const keys = configKeys();
        if (!keys.length) {
          usageData = null;
          updateResultDom();
          return;
        }
        usageData = await ctx.invoke("zhipu-plan:usage", { keys, force });
        // fetchedAt = when the sidecar actually hit the quota API (a cache hit
        // returns the original moment); hosts without it fall back to now.
        const fetched = Number(usageData && usageData.fetchedAt);
        refreshedAt = Number.isFinite(fetched) && fetched > 0 ? fetched : Date.now();
        persistRefreshedAt(refreshedAt);
        updateResultDom();
      } catch (error) {
        usageData = { error: String(error.message || error) };
        updateResultDom();
      } finally {
        usageRunning = false;
        resultEl.classList.remove("is-refreshing");
        if (btn) {
          btn.disabled = false;
          btn.classList.remove("is-busy");
        }
      }
    }

    // ── card skeleton ──
    const entry = await readConfig();
    const persisted = Number(config.refreshedAt);
    if (!refreshedAt && Number.isFinite(persisted) && persisted > 0) refreshedAt = persisted;
    const menubar = config.menubar !== false;
    const alerts = config.alerts !== false;
    const configToggle = (key, on, labelKey) => `
      <span class="zhipu-config-toggle">
        <span class="modules-toggle-label">${esc(t(labelKey))}</span>
        <button class="source-switch ${on ? "is-on" : "is-off"}" data-zp-config="${key}" type="button" role="switch" aria-checked="${on ? "true" : "false"}" aria-pressed="${on ? "true" : "false"}" aria-label="${esc(t(labelKey))}"></button>
      </span>`;
    el.innerHTML = `
      <div class="zhipu-board">
        <section class="zhipu-read">
          <div class="zhipu-ledger-head">
            <span class="zhipu-kicker">${esc(t("desktop.modules.zhipu.usageHeading"))}</span>
            <span class="zhipu-time zhipu-refreshed" id="zhipu-refreshed" hidden>${CLOCK}<span class="zhipu-reset"></span></span>
            <button class="outline-button row-inline-action" id="zhipu-refresh-btn" type="button">${esc(t("desktop.modules.zhipu.refresh"))}</button>
          </div>
          <div id="zhipu-result" class="zhipu-result-output"></div>
        </section>
        <aside class="zhipu-tools">
          <div class="zhipu-config-row">
            ${configToggle("menubar", menubar, "desktop.modules.zhipu.menubarSwitch")}
            ${configToggle("alerts", alerts, "desktop.modules.zhipu.alertsSwitch")}
          </div>
          <div class="zhipu-keys-block">
            <span class="zhipu-kicker">${esc(t("desktop.modules.zhipu.keysHeading"))}</span>
            <div id="zhipu-keys-list" class="zhipu-keys-list"></div>
            <div class="zhipu-add">
              <input id="zhipu-key-label" placeholder="${esc(t("desktop.modules.zhipu.keyLabelPlaceholder"))}" autocomplete="off" />
              <div class="zhipu-add-key">
                <input id="zhipu-key-input" class="mono" placeholder="${esc(t("desktop.modules.zhipu.apiKeyPlaceholder"))}" autocomplete="off" spellcheck="false" />
                <button class="outline-button row-inline-action" id="zhipu-key-add" type="button">${esc(t("desktop.modules.zhipu.addKey"))}</button>
              </div>
            </div>
          </div>
        </aside>
      </div>`;

    renderKeysList();
    updateResultDom();

    // toggles (menubar/alerts ride the plugin config, independent of on/off)
    for (const button of el.querySelectorAll("[data-zp-config]")) {
      button.addEventListener("click", () => guard(async () => {
        const key = button.dataset.zpConfig;
        const next = config[key] === false; // default-on
        await writeConfig({ [key]: next });
        button.classList.toggle("is-on", next);
        button.classList.toggle("is-off", !next);
        button.setAttribute("aria-checked", String(next));
        button.setAttribute("aria-pressed", String(next));
      }));
    }

    // key editor
    el.querySelector("#zhipu-key-add")?.addEventListener("click", () => guard(async () => {
      const label = (el.querySelector("#zhipu-key-label")?.value || "").trim();
      const apiKey = (el.querySelector("#zhipu-key-input")?.value || "").trim();
      if (!apiKey) {
        status(t("desktop.modules.zhipu.error.noKey"));
        return;
      }
      await writeConfig({ keys: [...configKeys(), { label, apiKey }] });
      el.querySelector("#zhipu-key-input").value = "";
      el.querySelector("#zhipu-key-label").value = "";
      renderKeysList();
      await refreshUsage({ force: true });
    }));
    el.addEventListener("click", (event) => {
      const editBtn = event.target.closest("[data-zhipu-key-edit]");
      if (editBtn) {
        editingKeyIndex = Number(editBtn.dataset.zhipuKeyEdit);
        renderKeysList();
        el.querySelector(".zhipu-key-edit-label")?.focus();
        return;
      }
      const cancelBtn = event.target.closest("[data-zhipu-key-cancel]");
      if (cancelBtn) {
        editingKeyIndex = null;
        renderKeysList();
        return;
      }
      const saveBtn = event.target.closest("[data-zhipu-key-save]");
      if (saveBtn) {
        const row = saveBtn.closest(".zhipu-key-row");
        const index = Number(saveBtn.dataset.zhipuKeySave);
        const label = (row?.querySelector("[data-zhipu-edit-label]")?.value || "").trim();
        const apiKey = (row?.querySelector("[data-zhipu-edit-key]")?.value || "").trim();
        if (!apiKey) {
          status(t("desktop.modules.zhipu.error.noKey"));
          return;
        }
        guard(async () => {
          const keys = configKeys();
          if (index >= 0 && index < keys.length) keys[index] = { label, apiKey };
          await writeConfig({ keys });
          editingKeyIndex = null;
          renderKeysList();
          await refreshUsage({ force: true });
        });
        return;
      }
      const btn = event.target.closest("[data-zhipu-key-del]");
      if (!btn) return;
      guard(async () => {
        const keys = configKeys();
        keys.splice(Number(btn.dataset.zhipuKeyDel), 1);
        editingKeyIndex = null;
        await writeConfig({ keys });
        renderKeysList();
        usageData = null;
        updateResultDom();
      });
    });

    el.querySelector("#zhipu-refresh-btn")?.addEventListener("click", () => guard(() => refreshUsage({ force: true })));

    // One lightweight tick per minute (module-scope singleton): countdown
    // text nodes + a non-forced refresh (the sidecar's 60s cache decides
    // whether the quota API is actually hit).
    if (!tickTimer) {
      tickTimer = setInterval(() => {
        document.querySelectorAll("[data-reset-ms]").forEach((node) => {
          const ms = Number(node.dataset.resetMs);
          const text = Number.isFinite(ms) ? compactReset(ms, Date.now()) : null;
          if (text) node.textContent = text;
          else if (node.dataset.resetAbs) node.textContent = node.dataset.resetAbs.slice(5, 16);
        });
        document.querySelectorAll("[data-refreshed-ms]").forEach((node) => {
          const ms = Number(node.dataset.refreshedMs);
          const text = Number.isFinite(ms) && ms > 0 ? refreshedAgeLabel(ms, Date.now(), ageT) : null;
          const textEl = node.querySelector(".zhipu-reset");
          if (textEl) textEl.textContent = text || "";
        });
        if (el.isConnected) refreshUsage({ force: false }).catch(() => {});
      }, 60_000);
    }

    // Entering the plugin screen shows current data immediately; the sidecar
    // cache keeps repeated entries from re-hitting the quota API.
    await refreshUsage({ force: false });
  },
};
