import { initI18n, t, getCurrentLang, createLangSwitcher, bindLangSwitcher, updatePageTranslations } from "/shared/i18n.js";
import { formatTokenCompact } from "/shared/display.js";
import { parseLatestChangelog } from "/shared/changelog.js";
import {
  escapeHtml, escapeAttribute, sourceName, formatCost, formatTokenRaw,
  normalizeModelSegments, modelUsageTitle, renderModelSegmentItems,
  renderModelSegments, renderCost, renderTrendChart, renderGauge,
  renderBarChart
} from "/shared/chart-helpers.js";

const currentLang = initI18n();

const state = { summaryData: null, analyticsData: null, leaderboardData: null };

function localeTokenCompact(value) {
  return formatTokenCompact(value, getCurrentLang());
}

function tokenSizeClass(value) {
  const abs = Math.abs(value);
  if (abs >= 10_000_000_000) return "size-100yi";
  if (abs >= 5_000_000_000) return "size-50yi";
  if (abs >= 1_000_000_000) return "size-10yi";
  return "size-under-yi";
}

function renderAuthFallback(selector) {
  const el = document.querySelector(selector);
  if (el) el.innerHTML = `<div class="meter-empty">${t("web.analytics.noData") || "Data unavailable"}</div>`;
}

// --- 6 Period Preview Cards (original) ---

function renderPreview(data) {
  const lang = getCurrentLang();
  const setTokens = (elId, costId, tokens, cost) => {
    const el = document.querySelector(`#${elId}`);
    const costEl = document.querySelector(`#${costId}`);
    if (el) {
      if (tokens != null) {
        el.textContent = formatTokenCompact(tokens, lang);
        el.className = `preview-value ${tokenSizeClass(tokens)}`;
      } else {
        el.textContent = "--";
      }
    }
    if (costEl) costEl.textContent = cost != null && cost > 0 ? formatCost(cost) : "";
  };

  setTokens("preview-today-tokens", "preview-today-cost", data.todayTokens, data.todayCost);
  setTokens("preview-yesterday-tokens", "preview-yesterday-cost", data.yesterdayTokens, data.yesterdayCost);
  setTokens("preview-week-tokens", "preview-week-cost", data.weekTokens, data.weekCost);
  setTokens("preview-last-week-tokens", "preview-last-week-cost", data.lastWeekTokens, data.lastWeekCost);
  setTokens("preview-month-tokens", "preview-month-cost", data.thisMonthTokens, data.thisMonthCost);
  setTokens("preview-last-month-tokens", "preview-last-month-cost", data.lastMonthTokens, data.lastMonthCost);

  renderDelta("delta-today", data.todayTokens, data.yesterdayTokens);
  renderDelta("delta-week", data.weekTokens, data.lastWeekTokens);
  renderDelta("delta-month", data.thisMonthTokens, data.lastMonthTokens);

  const participantsEl = document.querySelector("#trend-participant-count");
  if (participantsEl) participantsEl.textContent = data.participantCount ?? "--";
}

function renderDelta(elId, current, previous) {
  const el = document.querySelector(`#${elId}`);
  if (!el) return;
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (!prev || !cur || cur === prev) { el.hidden = true; return; }
  const pct = Math.round(((cur - prev) / prev) * 100);
  const up = pct > 0;
  el.textContent = `${up ? "+" : ""}${pct}% ${up ? "↑" : "↓"}`;
  el.className = `preview-delta delta-${up ? "up" : "down"}`;
  el.hidden = false;
}

// --- Chart Rendering (delegates to shared) ---

function homeRenderTrendChart() {
  const svg = document.querySelector("#home-trend-chart");
  if (!svg) return;
  const data = state.analyticsData;
  if (!data) return;
  const tooltip = document.querySelector("#chart-tooltip");
  renderTrendChart(svg, data.timeSeries || [], data.timeGrain || "day", tooltip, localeTokenCompact);
}

function homeRenderGauge() {
  const data = state.analyticsData;
  if (!data) return;
  const summary = data.summary || {};
  renderGauge(
    document.querySelector("#home-gauge-fill"),
    document.querySelector("#home-gauge-val"),
    summary.cacheHitRate || 0
  );
}

function homeRenderBarChart(containerId, items, opts) {
  const container = document.querySelector(containerId);
  if (!container) return;
  renderBarChart(container, items, { localeTokenCompact, ...opts });
}

// --- Leaderboard Preview ---

function rankIcon(rank) {
  const trophy = `<svg class="lucide lucide-trophy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14.66v1.626a2 2 0 0 1-.976 1.696A5 5 0 0 0 7 21.978"/><path d="M14 14.66v1.626a2 2 0 0 0 .976 1.696A5 5 0 0 1 17 21.978"/><path d="M18 9h1.5a1 1 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"/><path d="M6 9H4.5a1 1 0 0 1 0-5H6"/></svg>`;
  const medal = `<svg class="lucide lucide-medal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15"/><path d="M11 12 5.12 2.2"/><path d="m13 12 5.88-9.8"/><path d="M8 7h8"/><circle cx="12" cy="17" r="5"/><path d="M12 18v-2h-.5"/></svg>`;
  return rank === 1 ? trophy : medal;
}

function orderPodium(items) {
  if (items.length < 3) return items;
  return [items[1], items[0], items[2]];
}

function renderTopThree(items) {
  const el = document.querySelector("#home-top-three");
  if (!el) return;
  if (!items.length) {
    el.innerHTML = `<div class="meter-empty">${t("web.leaderboard.noUsage")}</div>`;
    return;
  }
  el.innerHTML = items
    .map((item) => `<article class="medal-card medal-rank-${Math.min(item.rank, 3)}" data-tooltip="${escapeHtml(modelUsageTitle(item, localeTokenCompact))}">
      <span class="medal-icon" aria-hidden="true">${rankIcon(item.rank)}</span>
      <div class="medal-card-head">
        <span class="medal-rank">#${item.rank}</span>
        <span class="participant-link">${escapeHtml(item.displayName)}</span>
      </div>
      <strong class="medal-total" title="${formatTokenRaw(item.totalTokens)}">${localeTokenCompact(item.totalTokens)}</strong>
      <span class="medal-cost">${renderCost(item)}</span>
      ${renderModelSegments(item, { className: "composition-strip", title: modelUsageTitle(item, localeTokenCompact) })}
    </article>`)
    .join("");
}

function renderMeterView(items) {
  const el = document.querySelector("#home-meter-rest");
  if (!el) return;
  if (!items.length) {
    el.innerHTML = "";
    return;
  }
  const max = Math.max(...items.map((item) => item.totalTokens), 1);
  const colorCycle = ["", "meter-yellow", "meter-violet"];
  el.innerHTML = items
    .map((item) => {
      const pct = Math.max(3, (item.totalTokens / max) * 100);
      const colorClass = colorCycle[(item.rank - 1) % colorCycle.length];
      return `<div class="meter-row" data-tooltip="${escapeHtml(modelUsageTitle(item, localeTokenCompact))}">
        <span class="meter-name">
          <span class="rank">#${item.rank}</span>
          <span class="participant-link">${escapeHtml(item.displayName)}</span>
        </span>
        <div class="meter-bar ${colorClass}">
          <div class="meter-fill" style="width:${pct}%">
            ${renderModelSegmentItems(item)}
          </div>
        </div>
        <span class="meter-value">
          <strong title="${formatTokenRaw(item.totalTokens)}">${localeTokenCompact(item.totalTokens)}</strong>
          <span class="cost-amount">${renderCost(item)}</span>
        </span>
      </div>`;
    })
    .join("");
}

function renderLeaderboardPreview(items) {
  const top = orderPodium(items.slice(0, 3));
  const rest = items.slice(3, 5);
  renderTopThree(top);
  renderMeterView(rest);
}

// --- Download Cards ---

const PLATFORM_META = {
  "win32-x64":   { os: "Windows", arch: "x64",   icon: "win",  desc: () => t("web.download.winDesc"),     ext: ".exe" },
  "darwin-arm64": { os: "macOS",   arch: "arm64", icon: "mac",  desc: () => t("web.download.macArmDesc"),  ext: ".dmg" },
  "darwin-x64":   { os: "macOS",   arch: "Intel", icon: "mac",  desc: () => t("web.download.macIntelDesc"), ext: ".dmg" }
};

const PLATFORM_ICONS = {
  win: `<svg class="lucide" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>`,
  mac: `<svg class="lucide" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9"/><path d="M2 20h20"/><path d="M8 20v-1h8v1"/></svg>`
};

const DOWNLOAD_ICON = `<svg class="lucide" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>`;

function platformSort(platform) {
  return { "darwin-arm64": 1, "darwin-x64": 2, "win32-x64": 3 }[platform] || 99;
}

function preferredPlatform() {
  const userAgent = window.navigator.userAgent || "";
  if (/Windows/i.test(userAgent)) return "win32-x64";
  if (/Mac/i.test(userAgent)) {
    if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return "darwin-arm64";
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl");
      const debugInfo = gl?.getExtension("WEBGL_debug_renderer_info");
      const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : "";
      if (/Apple/i.test(renderer)) return "darwin-arm64";
    } catch {}
    return "darwin-arm64";
  }
  return "";
}

async function loadReleaseConfig() {
  const el = document.querySelector("#download-actions");
  if (!el) return;
  try {
    const response = await fetch("/api/release/config");
    const data = await response.json();
    if (!data.ok) {
      el.innerHTML = `<span class="download-placeholder">${escapeHtml(data.error || "release unavailable")}</span>`;
      return;
    }
    renderPlatformCards(data.release || {});
  } catch (error) {
    el.innerHTML = `<span class="download-placeholder">${escapeHtml(error.message)}</span>`;
  }
}

function renderPlatformCards(release) {
  const el = document.querySelector("#download-actions");
  if (!el) return;
  const installers = release.installers || {};
  const platforms = Object.entries(installers)
    .filter(([, info]) => info?.url)
    .sort(([a], [b]) => platformSort(a) - platformSort(b));
  const preferred = preferredPlatform();

  if (!platforms.length) {
    el.innerHTML = `<span class="download-placeholder">${t("web.releaseMetadata")}</span>`;
    return;
  }

  el.innerHTML = platforms.map(([platform, info]) => {
    const meta = PLATFORM_META[platform] || { os: platform, arch: "", icon: "win", desc: () => "", ext: "" };
    const isRecommended = platform === preferred;
    const recommendedBadge = isRecommended ? `<span class="recommend-badge">${t("web.download.recommended")}</span>` : `<span class="dl-arch">${escapeHtml(meta.arch)}</span>`;
    const cardStyle = isRecommended ? ` style="border-color: var(--blue); border-width: 1.5px;"` : "";
    return `<div class="dl-card"${cardStyle}>
      <div class="dl-card-head">
        <span class="dl-icon">${PLATFORM_ICONS[meta.icon] || ""}</span>
        <span class="dl-os">${escapeHtml(meta.os)}</span>
        ${recommendedBadge}
      </div>
      <div class="dl-divider"></div>
      <div class="dl-meta">
        <span>${escapeHtml(meta.desc())}</span>
      </div>
      <a class="dl-btn" href="${escapeAttribute(info.url)}" target="_blank" rel="noreferrer">
        ${DOWNLOAD_ICON}<span>${t("web.download.downloadBtn")} ${escapeHtml(meta.ext)}</span>
      </a>
    </div>`;
  }).join("");
}

// --- Screenshots gallery ---

const SCREENSHOTS = [
  { src: "/screenshots/desktop-workdirs.png", labelKey: "web.screenshot.desktopWorkdirs" },
  { src: "/screenshots/desktop-client.png", labelKey: "web.screenshot.desktopOverview" },
  { src: "/screenshots/desktop-sources.png", labelKey: "web.screenshot.desktopSources" }
];
let activeScreenshotIndex = 0;
let galleryTimer = null;

function renderGallery() {
  const galleryScrollEl = document.querySelector("#gallery-scroll");
  if (!galleryScrollEl) return;
  const current = SCREENSHOTS[activeScreenshotIndex] || SCREENSHOTS[0];
  galleryScrollEl.innerHTML = `<div class="gallery-stage">
      <button class="gallery-nav gallery-prev" type="button" data-gallery-step="-1" aria-label="${escapeAttribute(t("web.screenshot.previous"))}">‹</button>
      <img class="gallery-main-image" src="${current.src}" alt="${t(current.labelKey)}" loading="lazy" />
      <button class="gallery-nav gallery-next" type="button" data-gallery-step="1" aria-label="${escapeAttribute(t("web.screenshot.next"))}">›</button>
    </div>
    <div class="gallery-meta-row">
      <span class="gallery-label">${t(current.labelKey)}</span>
      <span class="gallery-count">${activeScreenshotIndex + 1}/${SCREENSHOTS.length}</span>
    </div>`;
  galleryScrollEl.onclick = (e) => {
    const stepButton = e.target.closest("[data-gallery-step]");
    if (stepButton) {
      rotateGallery(Number(stepButton.dataset.galleryStep) || 1);
      return;
    }
    const img = e.target.closest(".gallery-main-image");
    if (img) openLightbox(img.src, img.alt);
  };
  startGalleryTimer();
}

function selectGallery(index) {
  activeScreenshotIndex = (index + SCREENSHOTS.length) % SCREENSHOTS.length;
  renderGallery();
}

function rotateGallery(step) {
  selectGallery(activeScreenshotIndex + step);
}

function startGalleryTimer() {
  if (galleryTimer) window.clearInterval(galleryTimer);
  galleryTimer = window.setInterval(() => rotateGallery(1), 5200);
}

function openLightbox(src, alt) {
  const overlay = document.createElement("div");
  overlay.className = "lightbox";
  overlay.innerHTML = `<img src="${escapeAttribute(src)}" alt="${escapeHtml(alt || "")}" />
    <button class="lightbox-close" aria-label="Close">&times;</button>`;
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay || e.target.classList.contains("lightbox-close")) close(); });
  document.body.appendChild(overlay);
  document.addEventListener("keydown", function handler(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", handler); }
  });
}

// --- Changelog ---

const changelogSectionEl = document.querySelector("#changelog-section");
const changelogVersionEl = document.querySelector("#changelog-version");
const changelogBodyEl = document.querySelector("#changelog-body");

async function fetchAndRenderChangelog() {
  if (!changelogBodyEl) return;
  const lang = getCurrentLang();
  const url = lang === "zh-CN" ? "/CHANGELOG.zh-CN.md" : "/CHANGELOG.md";
  try {
    const resp = await fetch(url);
    if (!resp.ok) return;
    const md = await resp.text();
    const parsed = parseLatestChangelog(md);
    if (!parsed || parsed.sections.length === 0) return;
    renderChangelog(parsed);
  } catch {}
}

const SECTION_CLASS = {
  Added: "cl-added", Changed: "cl-changed", Fixed: "cl-fixed",
  "新增": "cl-added", "变更": "cl-changed", "修复": "cl-fixed"
};

function renderChangelog({ version, date, sections }) {
  if (changelogSectionEl) changelogSectionEl.hidden = false;
  if (changelogVersionEl) changelogVersionEl.textContent = `v${version} · ${date}`;
  changelogBodyEl.innerHTML = sections.map(sec =>
    `<div class="cl-group ${SECTION_CLASS[sec.heading] || ""}">
      <h3>${escapeHtml(sec.heading)}</h3>
      <ul>${sec.items.map(item => `<li><span class="cl-badge cl-badge-${badgeClass(item.tag)}">${escapeHtml(item.tag)}</span>${escapeHtml(item.text)}</li>`).join("")}</ul>
    </div>`
  ).join("");
}

function badgeClass(tag) {
  if (tag === "Desktop") return "desktop";
  if (tag === "Web") return "web";
  return "both";
}

// --- Data Loading ---

async function loadSummary() {
  try {
    const response = await fetch("/api/board/summary");
    const data = await response.json();
    state.summaryData = data;
    renderPreview(data);
  } catch {
    const section = document.querySelector("#preview-section");
    if (section) section.hidden = true;
  }
}

async function loadAnalytics() {
  try {
    const params = new URLSearchParams({ range: "last30" });
    const response = await fetch(`/api/board/analytics?${params.toString()}`);
    if (!response.ok) {
      renderAuthFallback("#home-trend-chart");
      renderAuthFallback("#home-model-chart");
      renderAuthFallback("#home-provider-chart");
      return;
    }
    const data = await response.json();
    state.analyticsData = data;
    homeRenderTrendChart();
    homeRenderGauge();
    homeRenderBarChart("#home-model-chart", data.models, { collapseAfter: 4 });
    homeRenderBarChart("#home-provider-chart", (data.providers || []).map(p => ({ ...p, name: sourceName(p.name) })));
  } catch {
    renderAuthFallback("#home-trend-chart");
    renderAuthFallback("#home-model-chart");
    renderAuthFallback("#home-provider-chart");
  }
}

async function loadLeaderboard() {
  try {
    const params = new URLSearchParams({ period: "today", includeCost: "1" });
    const response = await fetch(`/api/board/leaderboard?${params.toString()}`);
    if (!response.ok) {
      renderAuthFallback("#home-top-three");
      return;
    }
    const data = await response.json();
    state.leaderboardData = data;
    renderLeaderboardPreview(data.items || []);
  } catch {
    renderAuthFallback("#home-top-three");
  }
}

// --- Boot ---

const langContainer = document.querySelector("#lang-switcher-container");
if (langContainer) {
  langContainer.innerHTML = createLangSwitcher();
  bindLangSwitcher("lang-switcher", () => { window.location.reload(); });
}
updatePageTranslations();

async function init() {
  await Promise.allSettled([
    loadSummary(),
    loadAnalytics(),
    loadLeaderboard()
  ]);
  await Promise.allSettled([
    loadReleaseConfig(),
    fetchAndRenderChangelog()
  ]);
  renderGallery();
}

init().catch(err => console.error("Init failed:", err));
