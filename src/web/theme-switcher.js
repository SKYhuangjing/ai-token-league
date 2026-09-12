// 实验用主题切换器:下拉选择配色方案(岚紫/暖橙/墨绿/绿茵),选择持久化在
// localStorage,启动时把方案 token 写到 <html> 内联样式上(覆盖默认 :root),
// 切换后刷新页面让 JS 图表色板重新读取。admin 与公开页共用。
const STORAGE_KEY = "ai-token-league.theme-scheme";

const SCHEMES = {
  oneaix: { labelKey: "web.theme.oneaix", tokens: {
    "--accent": "#fe010f",
    "--accent-ink": "#c60e1f",
    "--accent-soft": "#fdecee",
    "--accent-triple": "254, 16, 15",
    "--accent-2": "#7d8cff",
    "--accent-3": "#f139b0",
    "--rank-other": "#909399",
    "--tm-2": "#f6a9c6",
    "--trend-4": "#1d1d1f",
    "--trend-5": "#b3a5ff",
    "--trend-6": "#303133",
    "--trend-7": "#dcdce8",
    "--comp-1": "#c60e1f",
    "--comp-3": "#f139b0",
    "--comp-4": "#fdecee",
    "--night": "#b8b3d6",
    "--heat": "254, 16, 15",
    "--paper": "#ffffff",
    "--paper-2": "#ffffff",
    "--line": "#e4e7ed",
    "--line-soft": "#ebeef5",
    "--surface-tint": "#f5f7fa",
    "--data-primary": "#303133",
    "--data-secondary": "#909399"
  } },
  orange: { labelKey: "web.theme.orange", tokens: {
    "--accent": "#cf6a42",
    "--accent-ink": "#b4552f",
    "--accent-soft": "#f9e9df",
    "--accent-triple": "207, 106, 66",
    "--accent-2": "#2c796c",
    "--accent-3": "#c5a359",
    "--rank-other": "#92958d",
    "--tm-2": "#d9a55c",
    "--trend-4": "#8b7355",
    "--trend-5": "#d9a55c",
    "--trend-6": "#6d6a5e",
    "--trend-7": "#9a8f7d",
    "--comp-1": "#b4552f",
    "--comp-3": "#e0956b",
    "--comp-4": "#f2ddcd",
    "--night": "#c9c4ba",
    "--heat": "207, 106, 66"
  } },
  prod: { labelKey: "web.theme.prod", tokens: {
    "--accent": "#058f7e",
    "--accent-ink": "#075e5b",
    "--accent-soft": "#edf5f1",
    "--accent-triple": "5, 143, 126",
    "--accent-2": "#006d77",
    "--accent-3": "#b67810",
    "--rank-other": "#a8a89e",
    "--tm-2": "#b67810",
    "--trend-4": "#1c7c54",
    "--trend-5": "#5db091",
    "--trend-6": "#a2d2bf",
    "--trend-7": "#dcece5",
    "--comp-1": "#1c7c54",
    "--comp-2": "#5db091",
    "--comp-3": "#a2d2bf",
    "--comp-4": "#edf5f1",
    "--night": "#a8b0a6",
    "--heat": "5, 143, 126",
    "--paper": "#f6f2ea",
    "--paper-2": "#fffefb",
    "--line": "#d8d1c4",
    "--line-soft": "#ebe5da",
    "--surface-tint": "#edf5f1",
    "--data-primary": "#18332e",
    "--data-secondary": "#657069"
  } },
  arena: { labelKey: "web.theme.arena", tokens: {
    "--accent": "#309c3c",
    "--accent-ink": "#1f7030",
    "--accent-soft": "#eaf4ea",
    "--accent-triple": "48, 156, 60",
    "--accent-2": "#1f6b35",
    "--accent-3": "#74b878",
    "--rank-other": "#909399",
    "--tm-2": "#74b878",
    "--trend-4": "#1f6b35",
    "--trend-5": "#74b878",
    "--trend-6": "#2d2d2d",
    "--trend-7": "#d9d6d0",
    "--comp-1": "#1f6b35",
    "--comp-2": "#74b878",
    "--comp-3": "#a8ccb0",
    "--comp-4": "#e2efe4",
    "--night": "#9cb5a0",
    "--heat": "48, 156, 60",
    "--paper": "#fcfaf8",
    "--line": "#eeedec",
    "--line-soft": "#f4f0eb",
    "--surface-tint": "#f4f0eb"
  } }
};

const ALL_TOKEN_KEYS = [...new Set(Object.values(SCHEMES).flatMap((s) => Object.keys(s.tokens)))];

export function currentThemeScheme() {
  const name = localStorage.getItem(STORAGE_KEY);
  return SCHEMES[name] ? name : "orange";
}

export function applyThemeScheme(name) {
  const scheme = SCHEMES[name];
  if (!scheme) return;
  const rootStyle = document.documentElement.style;
  for (const key of ALL_TOKEN_KEYS) rootStyle.removeProperty(key);
  for (const [key, value] of Object.entries(scheme.tokens)) rootStyle.setProperty(key, value);
}

function injectSwitcher() {
  const anchor = document.querySelector("#lang-switcher-container");
  if (!anchor || anchor.parentElement.querySelector(".theme-switcher-container")) return;

  const container = document.createElement("div");
  container.className = "theme-switcher-container";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "theme-switcher-btn";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  const renderBtnLabel = () => {
    const name = currentThemeScheme();
    btn.innerHTML = `<span class="theme-switcher-dot" data-scheme="${name}"></span><span data-i18n="${SCHEMES[name].labelKey}">${SCHEMES[name].labelKey.split(".").pop()}</span><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  };
  renderBtnLabel();

  const panel = document.createElement("div");
  panel.className = "theme-switcher-panel";
  panel.setAttribute("role", "listbox");
  panel.hidden = true;
  const renderItems = () => {
    panel.innerHTML = "";
    const active = currentThemeScheme();
    for (const [name, scheme] of Object.entries(SCHEMES)) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `theme-switcher-item${name === active ? " is-active" : ""}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", name === active ? "true" : "false");
      item.dataset.themeScheme = name;
      item.innerHTML = `<span class="theme-switcher-dot" data-scheme="${name}"></span><span data-i18n="${scheme.labelKey}">${scheme.labelKey.split(".").pop()}</span>${name === active ? '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ""}`;
      item.addEventListener("click", () => {
        if (currentThemeScheme() !== name) {
          localStorage.setItem(STORAGE_KEY, name);
          applyThemeScheme(name);
          window.location.reload();
          return;
        }
        close();
      });
      panel.appendChild(item);
    }
  };
  renderItems();

  const open = () => { panel.hidden = false; btn.setAttribute("aria-expanded", "true"); document.addEventListener("click", onOutside); document.addEventListener("keydown", onEscape); };
  const close = () => { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); document.removeEventListener("click", onOutside); document.removeEventListener("keydown", onEscape); };
  const onOutside = (e) => { if (!container.contains(e.target)) close(); };
  const onEscape = (e) => { if (e.key === "Escape") close(); };
  btn.addEventListener("click", (e) => { e.stopPropagation(); panel.hidden ? open() : close(); });

  container.appendChild(btn);
  container.appendChild(panel);
  anchor.parentElement.insertBefore(container, anchor.nextSibling);
}

applyThemeScheme(currentThemeScheme());
injectSwitcher();
