import { initI18n, t, getCurrentLang, createLangSwitcher, bindLangSwitcher, updatePageTranslations } from "/shared/i18n.js";
import { formatTokenCompact } from "/shared/display.js";
import { parseLatestChangelog } from "/shared/changelog.js";
import {
  escapeHtml, escapeAttribute, sourceName, formatCost, formatTokenRaw,
  normalizeModelSegments, modelUsageTitle, renderModelSegmentItems,
  renderModelSegments, renderCost, renderTrendChart,
  renderBarChart, renderDonutChart, renderActivityHeatmap, renderParticipantTreemap,
  providerSourceColor
} from "/shared/chart-helpers.js";

initI18n();

const state = { summaryData: null, analyticsData: null, trendData: null, leaderboardData: null, sourceLeaderboardData: null };

function localeTokenCompact(value) {
  return formatTokenCompact(value, getCurrentLang());
}

function applyBoardIdentityEyebrow(mode) {
  const eyebrowKey = {
    anonymous: "web.publicBoardAnonymous",
    public: "web.publicBoardPublic",
    authenticated: "web.publicBoardAuthenticated"
  }[mode] || "web.publicBoard";
  const eyebrow = document.querySelector("#board-identity-eyebrow");
  if (!eyebrow) return;
  eyebrow.setAttribute("data-i18n", eyebrowKey);
  eyebrow.textContent = t(eyebrowKey);
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
  if (selector === "#home-trend-chart") {
    const peakEl = document.querySelector("#home-trend-peak");
    if (peakEl) {
      peakEl.hidden = true;
      peakEl.textContent = "";
      peakEl.removeAttribute("title");
    }
  }
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
        el.className = `val ${tokenSizeClass(tokens)}`;
      } else {
        el.textContent = "--";
      }
    }
    if (costEl) {
      if (cost != null && Number(cost) > 0) {
        costEl.textContent = formatCost(cost);
        costEl.hidden = false;
      } else {
        costEl.textContent = "";
        costEl.hidden = true;
      }
    }
  };

  setTokens("preview-today-tokens", "preview-today-cost", data.todayTokens, data.todayCost);
  setTokens("preview-yesterday-tokens", "preview-yesterday-cost", data.yesterdayTokens, data.yesterdayCost);
  setTokens("preview-week-tokens", "preview-week-cost", data.weekTokens, data.weekCost);
  setTokens("preview-last-week-tokens", "preview-last-week-cost", data.lastWeekTokens, data.lastWeekCost);
  setTokens("preview-month-tokens", "preview-month-cost", data.thisMonthTokens, data.thisMonthCost);
  setTokens("preview-last-month-tokens", "preview-last-month-cost", data.lastMonthTokens, data.lastMonthCost);
  setTokens("preview-all-time-tokens", "preview-all-time-cost", data.allTimeTokens, data.allTimeCost);

  renderDelta("delta-today", data.todayTokens, data.yesterdayTokens);
  renderDelta("delta-week", data.weekTokens, data.lastWeekTokens);
  renderDelta("delta-month", data.thisMonthTokens, data.lastMonthTokens);

  const participantsEl = document.querySelector("#trend-participant-count");
  if (participantsEl) participantsEl.textContent = data.participantCount ?? "--";
}

function renderFlatDelta(elId) {
  const el = document.querySelector(`#${elId}`);
  if (!el) return;
  el.textContent = "--";
  el.className = "delta flat";
  el.hidden = false;
}

function renderDelta(elId, current, previous) {
  const el = document.querySelector(`#${elId}`);
  if (!el) return;
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (!prev || !cur || cur === prev) {
    renderFlatDelta(elId);
    return;
  }
  const pct = Math.round(((cur - prev) / prev) * 100);
  const up = pct > 0;
  el.textContent = `${up ? "+" : ""}${pct}%`;
  el.className = `delta ${up ? "up" : "down"}`;
  el.hidden = false;
}

// --- Chart Rendering (delegates to shared) ---

function homeRenderTrendChart() {
  const svg = document.querySelector("#home-trend-chart");
  if (!svg) return;
  const data = state.trendData || state.analyticsData;
  if (!data) return;
  const series = data.timeSeries || [];
  const tooltip = document.querySelector("#chart-tooltip");
  renderTrendChart(svg, series, data.timeGrain || "day", tooltip, localeTokenCompact, {
    showActiveSeries: true,
    highlightPeak: true,
    height: 260,
    padding: { left: 52, right: 10, top: 8, bottom: 22 }
  });
  renderHomeTrendPeak(series, data.timeGrain || "day");
}

function renderHomeTrendPeak(series = [], grain = "day") {
  const peakEl = document.querySelector("#home-trend-peak");
  if (!peakEl) return;
  let tokenPeak = null;
  let activePeak = null;
  for (const point of series) {
    const tokens = Number(point.totalTokens || 0);
    const activeCount = Number(point.activeCount || 0);
    if (!tokenPeak || tokens > tokenPeak.totalTokens) {
      tokenPeak = { ...point, totalTokens: tokens };
    }
    if (!activePeak || activeCount > activePeak.activeCount) {
      activePeak = { ...point, activeCount };
    }
  }
  if (!tokenPeak || !(tokenPeak.totalTokens > 0)) {
    peakEl.hidden = true;
    peakEl.textContent = "";
    peakEl.removeAttribute("title");
    return;
  }
  const tokenDay = formatTrendPeakLabel(tokenPeak, grain);
  const value = localeTokenCompact(tokenPeak.totalTokens);
  const activeCount = Number(activePeak?.activeCount || 0);
  const activeDay = activeCount > 0 ? formatTrendPeakLabel(activePeak, grain) : "";
  peakEl.hidden = false;
  peakEl.textContent = activeCount > 0
    ? t("web.home.trendPeakWithActive", { day: tokenDay, value, activeDay, active: activeCount })
    : t("web.home.trendPeak", { day: tokenDay, value });
  peakEl.title = t("web.home.trendPeakTitle", {
    day: tokenDay,
    value,
    activeDay: activeDay || "-",
    active: activeCount || "-"
  });
}

function formatTrendPeakLabel(point = {}, grain = "day") {
  if (grain === "hour") return `${point.day || ""} ${point.label || ""}`.trim();
  if (grain === "week") return point.label || point.day || "";
  return formatTrendPeakDay(point.day);
}

function formatTrendPeakDay(day = "") {
  const parts = String(day || "").split("-");
  return parts.length >= 3 ? `${parts[1]}-${parts[2]}` : day;
}

function homeRenderDonut() {
  const data = state.analyticsData;
  if (!data) return;
  renderDonutChart(
    document.querySelector("#home-provider-donut"),
    (data.providers || []).map((provider) => ({
      id: provider.name,
      label: sourceName(provider.name),
      ratio: provider.ratio
    })),
    { collapseAfter: 4, collapseLabel: t("web.analytics.otherSources") }
  );
}

function homeRenderHeatmap() {
  const data = state.analyticsData;
  if (!data) return;
  renderActivityHeatmap(document.querySelector("#home-heatmap-grid"), data.heatmap || [], {
    from: data.from,
    to: data.to,
    businessDay: data.businessDay,
    tooltip: document.querySelector("#chart-tooltip"),
    localeTokenCompact
  });
}

function homeRenderBarChart(containerId, items, opts) {
  const container = document.querySelector(containerId);
  if (!container) return;
  renderBarChart(container, items, { localeTokenCompact, ...opts });
}

function homeRenderParticipantTreemap() {
  const svg = document.querySelector("#home-participant-treemap-svg");
  const labels = document.querySelector("#home-participant-treemap-labels");
  if (!svg || !labels) return;
  renderParticipantTreemap(svg, labels, state.analyticsData?.participantRanking || [], {
    localeTokenCompact,
    tooltip: document.querySelector("#chart-tooltip"),
    sideContainer: document.querySelector("#home-treemap-side"),
    legendContainer: document.querySelector("#home-treemap-legend")
  });
}

function renderHomeParticipantTreemapFallback() {
  const fallback = document.querySelector("#home-participant-treemap-fallback");
  if (!fallback) return;
  fallback.hidden = false;
  fallback.innerHTML = `<div class="meter-empty">${t("web.analytics.noData")}</div>`;
}

// --- Leaderboard Preview ---

const HOME_TOP_LIMIT = 5;

function profileUrl(displayId) {
  return `/profile.html?id=${encodeURIComponent(displayId)}`;
}

// Click-through only: rows keep their original markup and styling, a data attribute gates navigation.
function bindProfileRowNavigation(container) {
  if (!container) return;
  container.querySelectorAll(".top-row[data-display-id]").forEach((row) => {
    row.addEventListener("click", () => {
      window.location.assign(profileUrl(row.dataset.displayId));
    });
  });
}

function renderLeaderboardPreview(items) {
  const el = document.querySelector("#home-top-today");
  if (!el) return;
  const countEl = document.querySelector("#home-top-count");
  if (countEl) {
    countEl.textContent = items.length
      ? t("web.leaderboard.participantCount", { count: items.length, plural: items.length === 1 ? "" : "s" })
      : "--";
  }
  const preview = items.slice(0, HOME_TOP_LIMIT);
  if (!preview.length) {
    el.innerHTML = `<div class="meter-empty">${t("web.leaderboard.noUsage")}</div>`;
    return;
  }
  const max = Math.max(...preview.map((item) => item.totalTokens), 1);
  el.innerHTML = preview
    .map((item) => {
      const pct = Math.max(6, (item.totalTokens / max) * 100);
      const displayIdAttr = item.displayId ? ` data-display-id="${escapeHtml(item.displayId)}"` : "";
      return `<article class="top-row"${displayIdAttr} data-tooltip="${escapeHtml(modelUsageTitle(item, localeTokenCompact))}">
        <span class="n">${item.rank}</span>
        <span class="nm">${escapeHtml(item.displayName)}</span>
        <span class="tv" title="${formatTokenRaw(item.totalTokens)}">${localeTokenCompact(item.totalTokens)}</span>
        <div class="mini-bar"><i style="width:${pct}%"></i></div>
      </article>`;
    })
    .join("");
  bindProfileRowNavigation(el);
}

function rankIconSvg(rank) {
  if (rank === 1) {
    return `<svg class="rank-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14.66v1.626a2 2 0 0 1-.976 1.696A5 5 0 0 0 7 21.978"/><path d="M14 14.66v1.626a2 2 0 0 0 .976 1.696A5 5 0 0 1 17 21.978"/><path d="M18 9h1.5a1 1 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"/><path d="M6 9H4.5a1 1 0 0 1 0-5H6"/></svg>`;
  }
  return `<svg class="rank-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15"/><path d="M11 12 5.12 2.2"/><path d="m13 12 5.88-9.8"/><path d="M8 7h8"/><circle cx="12" cy="17" r="5"/><path d="M12 18v-2h-.5"/></svg>`;
}

function renderSourceTop(sources = []) {
  const el = document.querySelector("#home-source-top");
  if (!el) return;
  const blocks = sources.filter((source) => (source.items || []).length);
  if (!blocks.length) {
    el.innerHTML = `<div class="meter-empty">${t("web.leaderboard.noUsage")}</div>`;
    return;
  }
  el.innerHTML = blocks
    .map((source) => {
      const sourceTotal = Number(source.totalTokens || 0);
      const barColor = providerSourceColor(source.name);
      const rows = (source.items || [])
        .map((item) => {
          const share = sourceTotal > 0
            ? Math.max(6, (Number(item.totalTokens || 0) / sourceTotal) * 100)
            : 0;
          const rank = Number(item.rank) || 0;
          const rankClass = rank >= 1 && rank <= 3 ? ` is-rank-${rank}` : "";
          const avatar = item.avatarColor
            ? `<i class="source-top-avatar" style="background:${escapeAttribute(item.avatarColor)}"></i>`
            : "";
          const medalIcon = rank >= 1 && rank <= 3
            ? `<span class="source-top-medal-icon medal-icon-${rank}">${rankIconSvg(rank)}</span>`
            : "";
          const displayIdAttr = item.displayId ? ` data-display-id="${escapeHtml(item.displayId)}"` : "";
          return `<article class="top-row${rankClass}"${displayIdAttr} data-tooltip="${escapeHtml(modelUsageTitle(item, localeTokenCompact))}">
            <span class="rank-badge rank-badge-${rank}">${medalIcon}<span class="n">${rank || ""}</span></span>
            <span class="nm">${avatar}${escapeHtml(item.displayName || "")}</span>
            <span class="tv" title="${escapeHtml(formatTokenRaw(item.totalTokens))}">${localeTokenCompact(item.totalTokens)}</span>
            <div class="mini-bar"><i style="width:${share}%;background:${barColor}"></i></div>
          </article>`;
        })
        .join("");
      const count = Number(source.participantCount || 0);
      return `<div class="source-top-block">
        <div class="source-top-head">
          <span class="source-top-title">
            <i class="source-top-dot" style="background:${barColor}"></i>
            <span class="source-top-name">${escapeHtml(sourceName(source.name))}</span>
          </span>
          <span class="source-top-total" title="${escapeHtml(formatTokenRaw(sourceTotal))}">${localeTokenCompact(sourceTotal)}</span>
        </div>
        <div class="source-top-sub">${escapeHtml(t("web.home.sourceTopParticipantCount", { count, plural: count === 1 ? "" : "s" }))}</div>
        <div class="source-top-rows">${rows}</div>
      </div>`;
    })
    .join("");
  bindProfileRowNavigation(el);
}

async function loadSourceLeaderboard() {
  try {
    const params = new URLSearchParams({ range: "this_month", top: "3" });
    const response = await fetch(`/api/board/source-leaderboard?${params.toString()}`);
    if (!response.ok) {
      renderAuthFallback("#home-source-top");
      return;
    }
    const data = await response.json();
    state.sourceLeaderboardData = data;
    renderSourceTop(data.sources || []);
  } catch {
    renderAuthFallback("#home-source-top");
  }
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
  const cardsEl = document.querySelector("#download-cards");
  if (!cardsEl) return;
  try {
    const response = await fetch("/api/release/config");
    const data = await response.json();
    if (!data.ok) {
      cardsEl.innerHTML = `<span class="download-placeholder">${escapeHtml(data.error || "release unavailable")}</span>`;
      return;
    }
    renderPlatformCards(data.release || {});
  } catch (error) {
    cardsEl.innerHTML = `<span class="download-placeholder">${escapeHtml(error.message)}</span>`;
  }
}

function renderPlatformCards(release) {
  const cardsEl = document.querySelector("#download-cards");
  if (!cardsEl) return;
  const installers = release.installers || {};
  const platforms = Object.entries(installers)
    .filter(([, info]) => info?.url)
    .sort(([a], [b]) => platformSort(a) - platformSort(b));
  const preferred = preferredPlatform();

  if (!platforms.length) {
    cardsEl.innerHTML = `<span class="download-placeholder">${t("web.releaseMetadata")}</span>`;
    return;
  }

  cardsEl.innerHTML = platforms.map(([platform, info]) => {
    const meta = PLATFORM_META[platform] || { os: platform, arch: "", icon: "win", desc: () => "", ext: "" };
    const isRecommended = platform === preferred;
    return `<a class="download-card${isRecommended ? " recommended" : ""}" href="${escapeAttribute(info.url)}" target="_blank" rel="noreferrer">
      <span class="download-card-icon">${PLATFORM_ICONS[meta.icon] || PLATFORM_ICONS.win}</span>
      <span class="download-card-copy">
        <strong>${escapeHtml(meta.os)}${meta.arch ? ` · ${escapeHtml(meta.arch)}` : ""}</strong>
        <small>${escapeHtml(meta.desc())}</small>
        ${isRecommended ? `<span class="download-card-badge">${escapeHtml(t("web.download.recommended"))}</span>` : ""}
      </span>
      <span class="download-card-action">${DOWNLOAD_ICON}</span>
    </a>`;
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
  galleryScrollEl.onmouseenter = () => stopGalleryTimer();
  galleryScrollEl.onmouseleave = () => startGalleryTimer();
  galleryScrollEl.onfocusin = () => stopGalleryTimer();
  galleryScrollEl.onfocusout = (e) => {
    if (!galleryScrollEl.contains(e.relatedTarget)) startGalleryTimer();
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

function stopGalleryTimer() {
  if (galleryTimer) {
    window.clearInterval(galleryTimer);
    galleryTimer = null;
  }
}

function startGalleryTimer() {
  stopGalleryTimer();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
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
    if (data.identityMode) applyBoardIdentityEyebrow(data.identityMode);
    renderPreview(data);
  } catch {
    const section = document.querySelector("#preview-section");
    if (section) section.hidden = true;
  }
}

async function loadAnalytics() {
  try {
    const [monthResponse, trendResponse] = await Promise.all([
      fetch("/api/board/analytics?range=this_month"),
      fetch("/api/board/analytics?range=last30")
    ]);
    if (!monthResponse.ok) {
      renderAuthFallback("#home-trend-chart");
      renderAuthFallback("#home-model-chart");
      renderAuthFallback("#home-provider-donut");
      renderAuthFallback("#home-heatmap-grid");
      renderHomeParticipantTreemapFallback();
      return;
    }
    const monthData = await monthResponse.json();
    state.analyticsData = monthData;
    state.trendData = trendResponse.ok ? await trendResponse.json() : monthData;
    const fallback = document.querySelector("#home-participant-treemap-fallback");
    if (fallback) {
      fallback.hidden = true;
      fallback.innerHTML = "";
    }
    homeRenderTrendChart();
    homeRenderBarChart("#home-model-chart", monthData.models, { collapseAfter: 4 });
    homeRenderDonut();
    homeRenderHeatmap();
    homeRenderParticipantTreemap();
  } catch {
    renderAuthFallback("#home-trend-chart");
    renderAuthFallback("#home-model-chart");
    renderAuthFallback("#home-provider-donut");
    renderAuthFallback("#home-heatmap-grid");
    renderHomeParticipantTreemapFallback();
  }
}

async function loadLeaderboard() {
  try {
    const params = new URLSearchParams({ period: "today", includeCost: "1" });
    const response = await fetch(`/api/board/leaderboard?${params.toString()}`);
    if (!response.ok) {
      renderAuthFallback("#home-top-today");
      return;
    }
    const data = await response.json();
    state.leaderboardData = data;
    renderLeaderboardPreview(data.items || []);
  } catch {
    renderAuthFallback("#home-top-today");
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
  document.body.classList.add("is-refreshing");
  try {
    await Promise.allSettled([
      loadSummary(),
      loadAnalytics(),
      loadLeaderboard(),
      loadSourceLeaderboard(),
      loadReleaseConfig(),
      fetchAndRenderChangelog()
    ]);
    renderGallery();
  } finally {
    document.body.classList.remove("is-refreshing");
    requestAnimationFrame(() => document.body.classList.add("is-settled"));
  }
}

init().catch(err => console.error("Init failed:", err));
