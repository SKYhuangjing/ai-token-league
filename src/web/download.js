import { initI18n, t, getCurrentLang, createLangSwitcher, bindLangSwitcher, updatePageTranslations } from "/shared/i18n.js";
import { formatTokenCompact, formatUsd } from "/shared/display.js";

const currentLang = initI18n();

const downloadActionsEl = document.querySelector("#download-actions");
const releaseInfoEl = document.querySelector("#release-info");

const PLATFORM_META = {
  "win32-x64":   { os: "Windows", arch: "x64",   icon: "win",  desc: () => t("web.download.winDesc"),     ext: ".exe" },
  "darwin-arm64": { os: "macOS",   arch: "arm64", icon: "mac",  desc: () => t("web.download.macArmDesc"),  ext: ".dmg" },
  "darwin-x64":   { os: "macOS",   arch: "Intel", icon: "mac",  desc: () => t("web.download.macIntelDesc"), ext: ".dmg" }
};

const PLATFORM_ICONS = {
  win: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.5L10.5 4.5V11.5H3V5.5Z"/><path d="M10.5 4.5L21 3V11.5H10.5V4.5Z"/><path d="M3 11.5H10.5V18.5L3 17.5V11.5Z"/><path d="M10.5 11.5H21V20L10.5 18.5V11.5Z"/></svg>`,
  mac: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C9.5 2 8 4 8 4S6 2 4 4C2 6 3 8 3 8s-2 2-2 4c0 3 2.5 5.5 5 7 .5.3 1 .5 1.5.5h5c.5 0 1-.2 1.5-.5 2.5-1.5 5-4 5-7 0-2-2-4-2-4s1-2-1-4c-2-2-3.5 0-6 0Z"/><path d="M12 2c1 0 2 1 2.5 2"/></svg>`
};

const DOWNLOAD_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v9m0 0l-3-3m3 3l3-3M3 13h10"/></svg>`;

async function loadReleaseConfig() {
  try {
    const response = await fetch("/api/release/config");
    const data = await response.json();
    if (!data.ok) {
      renderDownloadUnavailable(data.error || "release unavailable");
      return;
    }
    renderPlatformCards(data.release || {}, data.latestClientVersion || "");
    renderReleaseInfo(data);
  } catch (error) {
    renderDownloadUnavailable(error.message);
  }
}

function renderPlatformCards(release, version) {
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

function renderReleaseInfo(data) {
  if (!releaseInfoEl) return;
  const parts = [];
  if (data.latestClientVersion) parts.push(`v${data.latestClientVersion}`);
  if (data.serverVersion) parts.push(`${t("web.landing.serverVersion")} ${data.serverVersion}`);
  releaseInfoEl.textContent = parts.join(" · ");
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

  setTokens("preview-today-tokens", "preview-today-cost", data.todayTokens, data.todayCost);
  setTokens("preview-yesterday-tokens", "preview-yesterday-cost", data.yesterdayTokens, data.yesterdayCost);
  setTokens("preview-week-tokens", "preview-week-cost", data.weekTokens, data.weekCost);
  setTokens("preview-last-week-tokens", "preview-last-week-cost", data.lastWeekTokens, data.lastWeekCost);
  setTokens("preview-month-tokens", "preview-month-cost", data.thisMonthTokens, data.thisMonthCost);
  setTokens("preview-last-month-tokens", "preview-last-month-cost", data.lastMonthTokens, data.lastMonthCost);
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
