import { t, updatePageTranslations } from "/shared/i18n.js";
import { escapeHtml } from "/shared/chart-helpers.js";

const STORAGE_KEY = "ai-token-league.public.lastProfileId";
const EMPTY_SENTINEL = "__empty__";

export function rememberProfileId(displayId) {
  const id = String(displayId || "").trim();
  if (!id) return;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore quota / private mode */
  }
}

export function getRememberedProfileId() {
  try {
    return String(localStorage.getItem(STORAGE_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function profilePageUrl(displayId, { mode = "public" } = {}) {
  const params = new URLSearchParams();
  params.set("id", displayId);
  if (mode === "admin") params.set("mode", "admin");
  return `/profile.html?${params.toString()}`;
}

export async function resolveDefaultProfileId({ mode = "public" } = {}) {
  const remembered = getRememberedProfileId();
  if (remembered) return remembered;

  try {
    if (mode === "admin") {
      const response = await fetch("/api/admin/usage?range=month");
      if (!response.ok) return "";
      const data = await response.json();
      return data.participants?.[0]?.participantId || "";
    }
    const response = await fetch("/api/board/leaderboard?period=all");
    if (!response.ok) return "";
    const data = await response.json();
    return data.items?.[0]?.displayId || "";
  } catch {
    return "";
  }
}

async function loadProfileCandidates({ mode = "public" } = {}) {
  if (mode === "admin") {
    const response = await fetch("/api/admin/usage?range=month");
    if (!response.ok) return [];
    const data = await response.json();
    return (data.participants || []).map((p) => ({
      id: p.participantId,
      name: p.nickname || p.participantId
    }));
  }

  const response = await fetch("/api/board/leaderboard?period=all");
  if (!response.ok) return [];
  const data = await response.json();
  return (data.items || []).map((item) => ({
    id: item.displayId,
    name: item.displayName || item.displayId
  }));
}

function setOpen(root, open) {
  const trigger = root.querySelector("[aria-haspopup]");
  const panel = root.querySelector(".nav-profile-panel, .profile-switcher-panel");
  if (!trigger || !panel) return;
  root.classList.toggle("is-open", open);
  trigger.setAttribute("aria-expanded", open ? "true" : "false");
  panel.hidden = !open;
  if (open) {
    const search = root.querySelector(".nav-profile-search");
    search?.focus();
  }
}

function renderList(root, items, currentId, query = "") {
  const list = root.querySelector(".nav-profile-list");
  if (!list) return;

  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? items.filter((item) => item.name.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle))
    : items;

  if (!filtered.length) {
    list.innerHTML = `<li class="nav-profile-empty" role="presentation">${escapeHtml(t("web.nav.profileEmpty"))}</li>`;
    return;
  }

  list.innerHTML = filtered.map((item) => {
    const selected = item.id === currentId;
    return `<li class="nav-profile-option${selected ? " is-selected" : ""}" role="option" data-id="${escapeHtml(item.id)}" aria-selected="${selected ? "true" : "false"}">
      <span class="nav-profile-option-name">${escapeHtml(item.name)}</span>
      ${selected ? `<span class="nav-profile-option-mark" aria-hidden="true">✓</span>` : ""}
    </li>`;
  }).join("");
}

function bindSwitcherRoot(root, {
  currentId = "",
  mode = "public",
  isProfilePage = false,
  prefetch = false,
  openInNewTab = false
} = {}) {
  const trigger = root.querySelector("[aria-haspopup]");
  const panel = root.querySelector(".nav-profile-panel, .profile-switcher-panel");
  const search = root.querySelector(".nav-profile-search");
  const list = root.querySelector(".nav-profile-list");
  if (!trigger || !panel || !list) return null;

  let items = [];
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    list.innerHTML = `<li class="nav-profile-empty" role="presentation">${escapeHtml(t("loading"))}</li>`;
    try {
      items = await loadProfileCandidates({ mode });
    } catch {
      items = [];
    }
    loaded = true;
    renderList(root, items, currentId, search?.value || "");
    updatePageTranslations();
  }

  trigger.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const willOpen = panel.hidden;
    if (willOpen) await ensureLoaded();
    setOpen(root, willOpen);
  });

  search?.addEventListener("input", () => {
    renderList(root, items, currentId, search.value || "");
  });

  list.addEventListener("click", (event) => {
    const option = event.target.closest("[data-id]");
    if (!option) return;
    const nextId = option.getAttribute("data-id") || "";
    if (!nextId || nextId === EMPTY_SENTINEL) return;
    rememberProfileId(nextId);
    setOpen(root, false);
    if (nextId === currentId && isProfilePage && !openInNewTab) return;
    const url = profilePageUrl(nextId, { mode });
    if (openInNewTab) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    window.location.href = url;
  });

  document.addEventListener("click", (event) => {
    if (!root.contains(event.target)) setOpen(root, false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(root, false);
  });

  if (prefetch) ensureLoaded().catch(() => {});

  return {
    open: async () => {
      await ensureLoaded();
      setOpen(root, true);
    }
  };
}

/**
 * Wire Personal tab:
 * - Profile page: nav is a plain current link; user switcher lives in subbar.
 * - Other pages: nav dropdown picks a person and navigates.
 * - Admin: opens profile in a new browser tab.
 */
export async function initPublicNavProfile({
  currentId = "",
  isProfilePage = false,
  mode = "public"
} = {}) {
  const openInNewTab = mode === "admin" && !isProfilePage;

  if (isProfilePage) {
    const navLink = document.querySelector("#nav-profile-link");
    if (navLink) {
      navLink.classList.add("current");
      const targetId = currentId || getRememberedProfileId();
      if (targetId) navLink.href = profilePageUrl(targetId, { mode });
    }

    const switcher = document.querySelector("[data-profile-switcher]");
    if (!switcher) return null;
    return bindSwitcherRoot(switcher, {
      currentId,
      mode,
      isProfilePage: true,
      prefetch: true,
      openInNewTab: false
    });
  }

  const root = document.querySelector("[data-nav-profile]");
  if (!root) return null;
  return bindSwitcherRoot(root, { currentId, mode, isProfilePage: false, openInNewTab });
}

export function setProfileSwitcherLabel(name) {
  const label = document.querySelector("#profile-switcher-label");
  if (!label) return;
  const text = String(name || "").trim();
  if (!text) return;
  label.textContent = text;
  label.removeAttribute("data-i18n");
}
