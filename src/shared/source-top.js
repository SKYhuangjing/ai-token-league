import { t } from "./i18n.js";
import { formatTokenCompact } from "./display.js";
import { escapeHtml, sourceName, modelUsageTitle } from "./chart-helpers.js";

function itemId(item = {}) {
  return item.displayId || item.participantId || "";
}

function itemName(item = {}) {
  return item.displayName || item.nickname || "";
}

/**
 * Shared source-top grid markup used by the public home card and admin source stats.
 * @param {Array} sources - [{ name, totalTokens, participantCount, items: [{ displayId|participantId, displayName|nickname, totalTokens, models? }] }]
 * @param {{ formatToken?: Function, emptyMessage?: string, rowTooltip?: Function|boolean }} [options]
 */
export function renderSourceTopHtml(sources = [], options = {}) {
  const formatToken = options.formatToken || ((value) => formatTokenCompact(value));
  const emptyMessage = options.emptyMessage || t("web.leaderboard.noUsage");
  const rowTooltip = options.rowTooltip === false
    ? null
    : typeof options.rowTooltip === "function"
      ? options.rowTooltip
      : (item) => modelUsageTitle(item, formatToken);

  const blocks = (sources || []).filter((source) => (source.items || []).length);
  if (!blocks.length) {
    return `<div class="meter-empty">${escapeHtml(emptyMessage)}</div>`;
  }

  return blocks
    .map((source) => {
      const count = Number(source.participantCount || 0);
      const rows = (source.items || [])
        .map((item, index) => {
          const id = itemId(item);
          const idAttr = id ? ` data-display-id="${escapeHtml(id)}"` : "";
          const tip = rowTooltip ? rowTooltip(item) : "";
          const tipAttr = tip ? ` data-tooltip="${escapeHtml(tip)}"` : "";
          return `<li${idAttr}${tipAttr}>
            <span class="source-top-row-name">#${index + 1} · ${escapeHtml(itemName(item))}</span>
            <b>${formatToken(item.totalTokens)}</b>
          </li>`;
        })
        .join("");
      return `<div class="source-top-block">
        <h3 class="source-top-name">${escapeHtml(sourceName(source.name))}</h3>
        <strong class="source-top-total">${formatToken(Number(source.totalTokens || 0))}</strong>
        <p class="source-top-sub">${escapeHtml(t("web.home.sourceTopParticipantCount", { count, plural: count === 1 ? "" : "s" }))}</p>
        <ol class="source-top-rows">${rows}</ol>
      </div>`;
    })
    .join("");
}

export function bindSourceTopNavigation(container, { profileUrl } = {}) {
  if (!container || typeof profileUrl !== "function") return;
  container.querySelectorAll("[data-display-id]").forEach((row) => {
    row.addEventListener("click", () => {
      window.location.assign(profileUrl(row.dataset.displayId));
    });
  });
}

/**
 * Render + optionally bind profile click-through into a container.
 * @param {Element|null} container
 * @param {Array} sources
 * @param {{ formatToken?: Function, emptyMessage?: string, rowTooltip?: Function|boolean, profileUrl?: Function }} [options]
 */
export function mountSourceTop(container, sources = [], options = {}) {
  if (!container) return;
  container.innerHTML = renderSourceTopHtml(sources, options);
  if (options.profileUrl) bindSourceTopNavigation(container, options);
}
