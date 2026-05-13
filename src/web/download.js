import { initI18n, t, getCurrentLang, createLangSwitcher, bindLangSwitcher, updatePageTranslations } from "/shared/i18n.js";
import { formatTokenCompact, formatUsd } from "/shared/display.js";
import { parseLatestChangelog } from "/shared/changelog.js";

const currentLang = initI18n();

const downloadActionsEl = document.querySelector("#download-actions");
const galleryScrollEl = document.querySelector("#gallery-scroll");
const changelogSectionEl = document.querySelector("#changelog-section");
const changelogVersionEl = document.querySelector("#changelog-version");
const changelogBodyEl = document.querySelector("#changelog-body");

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

async function loadReleaseConfig() {
  try {
    const response = await fetch("/api/release/config");
    const data = await response.json();
    if (!data.ok) {
      renderDownloadUnavailable(data.error || "release unavailable");
      return;
    }
    renderPlatformCards(data.release || {});
  } catch (error) {
    renderDownloadUnavailable(error.message);
  }
}

function renderPlatformCards(release) {
  const installers = release.installers || {};
  const platforms = Object.entries(installers)
    .filter(([, info]) => info?.url)
    .sort(([a], [b]) => platformSort(a) - platformSort(b));
  const preferred = preferredPlatform();

  if (!platforms.length) {
    downloadActionsEl.innerHTML = `<span class="download-placeholder">${t("web.releaseMetadata")}</span>`;
    return;
  }

  downloadActionsEl.innerHTML = platforms.map(([platform, info]) => {
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

function renderDownloadUnavailable(reason) {
  downloadActionsEl.innerHTML = `<span class="download-placeholder">${escapeHtml(reason)}</span>`;
}

async function loadBoardSummary() {
  try {
    const response = await fetch("/api/board/summary");
    const data = await response.json();
    renderPreview(data);
  } catch {
    const section = document.querySelector("#preview-section");
    if (section) section.hidden = true;
  }
}

function tokenSizeClass(value) {
  const abs = Math.abs(value);
  if (abs >= 10_000_000_000) return "size-100yi";
  if (abs >= 5_000_000_000) return "size-50yi";
  if (abs >= 1_000_000_000) return "size-10yi";
  return "size-under-yi";
}

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
    if (costEl) costEl.textContent = cost != null && cost > 0 ? formatUsd(cost) : "";
  };

  const participantsEl = document.querySelector("#preview-participants");
  if (participantsEl) participantsEl.textContent = data.participantCount ?? "--";
  renderBoardIdentityCopy(data.identityMode);

  setTokens("preview-today-tokens", "preview-today-cost", data.todayTokens, data.todayCost);
  setTokens("preview-yesterday-tokens", "preview-yesterday-cost", data.yesterdayTokens, data.yesterdayCost);
  setTokens("preview-week-tokens", "preview-week-cost", data.weekTokens, data.weekCost);
  setTokens("preview-last-week-tokens", "preview-last-week-cost", data.lastWeekTokens, data.lastWeekCost);
  setTokens("preview-month-tokens", "preview-month-cost", data.thisMonthTokens, data.thisMonthCost);
  setTokens("preview-last-month-tokens", "preview-last-month-cost", data.lastMonthTokens, data.lastMonthCost);
}

function renderBoardIdentityCopy(identityMode = "") {
  const key = {
    anonymous: "web.landing.featureBoardDescAnonymous",
    public: "web.landing.featureBoardDescPublic",
    authenticated: "web.landing.featureBoardDescAuthenticated"
  }[identityMode] || "web.landing.featureBoardDesc";
  document.querySelectorAll("[data-board-identity-copy]").forEach((el) => {
    el.textContent = t(key);
  });
}

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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value);
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

const langContainer = document.querySelector("#lang-switcher-container");
if (langContainer) {
  langContainer.innerHTML = createLangSwitcher();
  bindLangSwitcher("lang-switcher", () => {
    window.location.reload();
  });
}

updatePageTranslations();
loadReleaseConfig();
loadBoardSummary();
renderGallery();
fetchAndRenderChangelog();
