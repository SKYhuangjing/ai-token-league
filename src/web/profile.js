import { initI18n, t, getCurrentLang, mountLangSwitcher, updatePageTranslations } from "/shared/i18n.js";
import "/theme-switcher.js";
import { formatTokenCompact } from "/shared/display.js";
import {
  escapeHtml, sourceName, formatTokenRaw, renderCost,
  renderTrendChart, renderBarChart, renderActivityHeatmap,
  renderWeekdayRhythm, renderHourlyRhythm, computeHourlyRhythmStats, rankSeriesColor
} from "/shared/chart-helpers.js";
import {
  initPublicNavProfile,
  rememberProfileId,
  clearRememberedProfileId,
  resolveDefaultProfileId,
  profilePageUrl,
  setProfileSwitcherLabel
} from "/public-nav-profile.js";

// 初始化多语言
initI18n();

const TROPHY_SVG = `<svg class="crest-svg gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a1 1 0 0 1 0-5H6"/><path d="M18 9h1.5a1 1 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17a2 2 0 0 1-.976 1.696A5 5 0 0 0 7 22"/><path d="M14 14.66V17a2 2 0 0 0 .976 1.696A5 5 0 0 1 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`;
const MEDAL_SVG = `<svg class="crest-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15"/><path d="M11 12 5.12 2.2"/><path d="m13 12 5.88-9.8"/><path d="M8 7h8"/><circle cx="12" cy="17" r="5"/><path d="M12 18v-2h-.5"/></svg>`;

const TREND_BUCKET_CAP = 365;
const RECENT_RANGE = "last30";

const urlParams = new URLSearchParams(window.location.search);
const isAdminMode = urlParams.get("mode") === "admin";

const state = {
  displayId: urlParams.get("id") || "",
  mode: isAdminMode ? "admin" : "public",
  range: RECENT_RANGE,
  grain: "day",
  showCost: readBooleanPreference("ai-token-league.public.showCost", false),
  identityMode: isAdminMode ? "admin" : "public",
  notFound: false,
  profile: null,
  recent30: null,
  heatAll: null,
  rangeDetail: null
};

const storageKeys = {
  showCost: "ai-token-league.public.showCost"
};

const statusEl = document.querySelector("#profile-range-status");
const heroEl = document.querySelector("#profile-hero");
const tooltipEl = document.querySelector("#profile-tooltip");
const toastEl = document.querySelector("#profile-toast");
let rangeLoadToken = 0;
let toastTimer = null;

function showToast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.hidden = false;
  toastEl.classList.add("is-visible");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove("is-visible");
    window.setTimeout(() => { toastEl.hidden = true; }, 300);
  }, 2200);
}

// 页面级 data-tooltip 委托
let hintAnchor = null;

function hideHintTooltip() {
  hintAnchor = null;
  if (tooltipEl) tooltipEl.style.opacity = "0";
}

function showHintTooltip(el) {
  if (!tooltipEl || !el) return;
  const text = el.getAttribute("data-tooltip");
  if (!text) return;
  hintAnchor = el;
  tooltipEl.textContent = text;
  tooltipEl.style.opacity = "1";
  const anchorRect = el.getBoundingClientRect();
  const tipRect = tooltipEl.getBoundingClientRect();
  const docWidth = document.documentElement.clientWidth;
  let left = anchorRect.left + window.scrollX + anchorRect.width / 2 - tipRect.width / 2;
  left = Math.max(window.scrollX + 8, Math.min(left, window.scrollX + docWidth - tipRect.width - 8));
  tooltipEl.style.left = `${Math.round(left)}px`;
  tooltipEl.style.top = `${Math.round(anchorRect.top + window.scrollY - tipRect.height - 10)}px`;
}

document.addEventListener("mouseover", (event) => {
  if (!(event.target instanceof Element)) return;
  const el = event.target.closest("[data-tooltip]");
  if (el && el !== hintAnchor) showHintTooltip(el);
});

document.addEventListener("mouseout", (event) => {
  if (!hintAnchor) return;
  const next = event.relatedTarget instanceof Element ? event.relatedTarget.closest("[data-tooltip]") : null;
  if (next !== hintAnchor) hideHintTooltip();
});

document.addEventListener("focusin", (event) => {
  if (!(event.target instanceof Element)) return;
  const el = event.target.closest("[data-tooltip]");
  if (el && el !== hintAnchor) showHintTooltip(el);
});

document.addEventListener("focusout", (event) => {
  if (!hintAnchor) return;
  const next = event.relatedTarget instanceof Element ? event.relatedTarget.closest("[data-tooltip]") : null;
  if (next !== hintAnchor) hideHintTooltip();
});

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const el = event.target.closest("[data-tooltip]");
  if (el) showHintTooltip(el);
  else if (hintAnchor) hideHintTooltip();
});

window.addEventListener("scroll", () => {
  if (hintAnchor) hideHintTooltip();
}, { passive: true });

function localeTokenCompact(value) {
  return formatTokenCompact(value, getCurrentLang());
}

function readBooleanPreference(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) === true;
  } catch {
    return fallback;
  }
}

function persistPreference(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function costParams(extra = {}) {
  const params = new URLSearchParams(extra);
  if (state.showCost) params.set("includeCost", "1");
  return params.toString();
}

function setActive(group, button) {
  group.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
}

function formatRange(from, to) {
  if (!from && !to) return "-";
  if (from === to) return from;
  return t("common.dateRange", { from, to });
}

function avatarHue(id) {
  let hash = 0;
  for (const ch of String(id || "")) {
    hash = (hash * 31 + ch.codePointAt(0)) % 360;
  }
  return hash;
}

function emptyState(message, { hint = "" } = {}) {
  return `<article class="empty-state profile-empty">${escapeHtml(message)}${hint ? `<small>${escapeHtml(hint)}</small>` : ""}</article>`;
}

function renderNotFound({ status = 0 } = {}) {
  state.notFound = true;
  if (state.displayId) clearRememberedProfileId();
  heroEl?.setAttribute("aria-busy", "false");
  document.body.classList.add("profile-error");
  const nameEl = document.querySelector("#profile-name");
  if (nameEl) nameEl.textContent = t("web.profile.notFoundTitle");
  const statsEl = document.querySelector("#profile-stats");
  if (statsEl) statsEl.innerHTML = "";
  const avatarEl = document.querySelector("#profile-avatar");
  if (avatarEl) avatarEl.hidden = true;
  document.title = `${t("web.profile.notFoundTitle")} · AI Token League`;
  const notFoundEl = document.querySelector("#profile-not-found");
  if (notFoundEl) {
    notFoundEl.hidden = false;
    if (status === 401) {
      notFoundEl.innerHTML = `${escapeHtml(t("web.profile.authRequired"))} <a class="link-button" href="/admin.html">${escapeHtml(t("web.profile.openAdmin"))}</a>`;
    } else if (status === 404 && state.mode === "admin") {
      notFoundEl.textContent = `${t("web.profile.notFound")} ${t("web.profile.notFoundAdminHint")}`;
    } else {
      notFoundEl.textContent = t("web.profile.notFound");
    }
  }
  const notFoundBack = document.querySelector("#profile-not-found-back");
  if (notFoundBack) notFoundBack.hidden = false;
  document.querySelectorAll("[data-profile-range] button, [data-profile-grain] button, #show-cost").forEach((control) => {
    control.disabled = true;
  });
  if (statusEl) statusEl.textContent = "";
}

function getRankQuote(rank) {
  if (!rank || rank > 100) return t("desktop.share.rankQuote.top50.0") || "每一次坚持都在缩小你和前方的距离。";
  if (rank === 1) return t("desktop.share.rankQuote.1.0");
  if (rank === 2) return t("desktop.share.rankQuote.2.0");
  if (rank === 3) return t("desktop.share.rankQuote.3.0");
  if (rank <= 10) return t("desktop.share.rankQuote.top10.0");
  if (rank <= 30) return t("desktop.share.rankQuote.top30.0");
  return t("desktop.share.rankQuote.top50.0");
}

function renderLiveStatus(profile) {
  const liveStatusEl = document.querySelector("#profile-live-status");
  const liveTextEl = document.querySelector("#profile-live-status-text");
  if (!liveStatusEl || !liveTextEl) return;
  const lastActive = profile.lastActiveDay;
  const today = profile.businessDay || new Date().toISOString().slice(0, 10);
  if (lastActive === today) {
    liveStatusEl.className = "profile-live-status active-today";
    liveTextEl.textContent = t("web.profile.activeToday");
  } else if (lastActive) {
    liveStatusEl.className = "profile-live-status active-recent";
    liveTextEl.textContent = `${t("web.profile.lastActive")}: ${lastActive}`;
  } else {
    liveStatusEl.className = "profile-live-status inactive";
    liveTextEl.textContent = t("web.profile.noData") || "Inactive";
  }
}

function renderFeaturesStrip(profile) {
  const strip = document.querySelector("#profile-features-strip");
  if (!strip) return;
  // Hour-rhythm badges are appended by renderHourlyFeatureTags on range
  // switches; keep them across this innerHTML overwrite (loadHero and
  // loadRange run concurrently on the cost toggle).
  const hourTags = [...strip.querySelectorAll(".feature-tag.feature-hour")];
  hourTags.forEach((tag) => tag.remove());
  const tags = [];
  const topSource = profile.providers?.[0];
  if (topSource) {
    tags.push(`<span class="feature-tag feature-engine">${escapeHtml(t("web.profile.featureEngineCore", { source: sourceName(topSource.name) }))}</span>`);
  }
  const total = Number(profile.totalTokens || 0);
  const cacheTokens = Number(profile.cacheReadTokens || 0) + Number(profile.cacheWriteTokens || 0);
  const cacheHitPct = total ? Math.round((cacheTokens / total) * 100) : 0;
  if (cacheHitPct >= 65) {
    tags.push(`<span class="feature-tag feature-cache">${escapeHtml(t("web.profile.featureCacheMaster", { pct: cacheHitPct }))}</span>`);
  }
  if (Number(profile.currentStreak || 0) >= 5) {
    tags.push(`<span class="feature-tag feature-streak">${escapeHtml(t("web.profile.featureStreakIron", { days: profile.currentStreak }))}</span>`);
  }
  if (Number(profile.peakDay?.totalTokens || 0) >= 50_000_000) {
    tags.push(`<span class="feature-tag feature-throughput">${escapeHtml(t("web.profile.featureThroughput"))}</span>`);
  }
  strip.innerHTML = tags.join("");
  strip.append(...hourTags);
}

function renderHero(profile) {
  state.profile = profile;
  state.notFound = false;
  heroEl?.setAttribute("aria-busy", "false");
  document.body.classList.remove("profile-error");
  const notFoundEl = document.querySelector("#profile-not-found");
  if (notFoundEl) notFoundEl.hidden = true;
  const notFoundBack = document.querySelector("#profile-not-found-back");
  if (notFoundBack) notFoundBack.hidden = true;
  document.querySelectorAll("[data-profile-range] button, [data-profile-grain] button, #show-cost").forEach((control) => {
    control.disabled = false;
  });

  const displayName = profile.displayName || profile.nickname || profile.displayId || "";
  const nameEl = document.querySelector("#profile-name");
  if (nameEl) nameEl.textContent = displayName;
  setProfileSwitcherLabel(displayName);

  const isAnonymous = state.mode !== "admin" && state.identityMode === "anonymous";
  nameEl?.classList.toggle("anonymous-name", isAnonymous);

  const aliasPill = document.querySelector("#profile-alias-note");
  if (aliasPill) aliasPill.hidden = !isAnonymous;

  const adminPill = document.querySelector("#profile-admin-pill");
  if (adminPill) adminPill.hidden = state.mode !== "admin";

  // Rank Chip & Percentile
  const rankChip = document.querySelector("#profile-rank-chip");
  if (rankChip) {
    if (profile.rank) {
      rankChip.textContent = `#${profile.rank}`;
      rankChip.hidden = false;
    } else {
      rankChip.hidden = true;
    }
  }

  const percentilePill = document.querySelector("#profile-percentile-pill");
  if (percentilePill) {
    const beatPct = profile.percentile !== null && profile.percentile !== undefined ? profile.percentile : null;
    if (beatPct !== null) {
      percentilePill.textContent = t("web.profile.beatPctText", { pct: beatPct });
      percentilePill.hidden = false;
    } else {
      percentilePill.hidden = true;
    }
  }

  // Avatar and Crest
  const avatarEl = document.querySelector("#profile-avatar");
  if (avatarEl) {
    if (profile.avatarColor && isAnonymous) {
      avatarEl.style.background = profile.avatarColor;
      avatarEl.style.color = "#fffaf0";
    } else {
      const hue = avatarHue(profile.displayId || displayName);
      avatarEl.style.background = `hsl(${hue} 42% 88%)`;
      avatarEl.style.color = `hsl(${hue} 45% 26%)`;
    }
    avatarEl.textContent = displayName.trim().charAt(0).toUpperCase() || "·";
    avatarEl.hidden = false;
  }

  // Crest Medal
  const crestBadge = document.querySelector("#profile-crest-badge");
  if (crestBadge) {
    if (profile.rank === 1) {
      crestBadge.innerHTML = TROPHY_SVG;
      crestBadge.className = "profile-crest-badge crest-gold";
      crestBadge.hidden = false;
    } else if (profile.rank === 2) {
      crestBadge.innerHTML = MEDAL_SVG;
      crestBadge.className = "profile-crest-badge crest-silver";
      crestBadge.hidden = false;
    } else if (profile.rank === 3) {
      crestBadge.innerHTML = MEDAL_SVG;
      crestBadge.className = "profile-crest-badge crest-bronze";
      crestBadge.hidden = false;
    } else {
      crestBadge.hidden = true;
    }
  }

  // Rank Quote
  const quoteCard = document.querySelector("#profile-quote-card");
  const quoteText = document.querySelector("#profile-quote-text");
  if (quoteCard && quoteText) {
    const quote = getRankQuote(profile.rank);
    if (quote) {
      quoteText.textContent = quote;
      quoteCard.hidden = false;
    } else {
      quoteCard.hidden = true;
    }
  }

  // Metadata
  const lastActiveText = profile.lastActiveDay || "-";
  const joinedText = profile.createdAt ? String(profile.createdAt).slice(0, 10) : "-";
  const lastActiveEl = document.querySelector("#profile-last-active");
  if (lastActiveEl) lastActiveEl.textContent = lastActiveText;
  const joinedEl = document.querySelector("#profile-joined");
  if (joinedEl) joinedEl.textContent = joinedText;

  renderLiveStatus(profile);
  renderFeaturesStrip(profile);
  renderScoreboard(profile.summary || {}, profile);
  renderBentoStats(profile);
  document.title = `${displayName} · AI Token League`;
}

function renderBentoStats(profile) {
  const container = document.querySelector("#profile-stats");
  if (!container) return;

  const totalTokens = Number(profile.totalTokens || 0);
  const peakDay = profile.peakDay || null;
  const peakValue = peakDay ? localeTokenCompact(peakDay.totalTokens) : localeTokenCompact(0);
  const peakDate = peakDay?.day ? String(peakDay.day).slice(5) : "-";
  const peakHint = peakDay ? `${peakDay.day} · ${formatTokenRaw(peakDay.totalTokens)}` : "";

  const beatPct = profile.percentile !== null && profile.percentile !== undefined ? profile.percentile : 0;
  const beatText = t("web.profile.beatPctText", { pct: beatPct });

  const inputTokens = Number(profile.inputTokens || profile.summary?.inputTokens || 0);
  const outputTokens = Number(profile.outputTokens || profile.summary?.outputTokens || 0);
  const cacheReadTokens = Number(profile.cacheReadTokens || profile.summary?.cacheReadTokens || 0);
  const promptTokens = inputTokens + outputTokens;
  const leverage = promptTokens > 0 ? (cacheReadTokens / promptTokens).toFixed(1) : "0.0";
  const cacheTotal = cacheReadTokens + Number(profile.cacheWriteTokens || 0);
  const cacheHitPct = totalTokens ? Math.round((cacheTotal / totalTokens) * 100) : 0;

  let consistencyRate = 0;
  if (profile.createdAt && profile.activeDays) {
    const createdTime = new Date(profile.createdAt).getTime();
    const daysSince = Math.max(1, Math.round((Date.now() - createdTime) / 86_400_000));
    consistencyRate = Math.min(100, Math.round((profile.activeDays / daysSince) * 100));
  }

  const activeDays = Number(profile.activeDays || 0);
  const avgDaily = activeDays > 0 ? Math.round(totalTokens / activeDays) : 0;
  const currentStreak = Number(profile.currentStreak ?? 0);
  const bestStreak = Number(profile.bestStreak || 0);
  const streakMeter = bestStreak > 0 ? Math.min(100, Math.round((currentStreak / bestStreak) * 100)) : 0;

  let peakMonthLabel = "-";
  let peakMonthTokens = 0;
  if (profile.monthlyRanks?.length) {
    const sorted = [...profile.monthlyRanks].sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
    if (sorted[0]) {
      peakMonthLabel = sorted[0].month;
      peakMonthTokens = sorted[0].totalTokens || 0;
    }
  }

  const providersCount = profile.providers?.length || 1;
  const topProvider = profile.providers?.[0];
  const topProviderName = topProvider ? sourceName(topProvider.name) : "Codex";

  // 三排拼版：跨列制造节奏，三行等高避免高低差
  const cards = [
    {
      cls: "metric-peak bento-span-2",
      label: t("web.profile.peakDay"),
      val: peakValue,
      sub: peakDate,
      hint: peakHint,
      monoSub: true
    },
    {
      cls: "metric-rank",
      label: t("web.profile.rank"),
      val: profile.rank ? `#${profile.rank}` : "-",
      sub: beatText,
      hint: profile.rank && profile.participantCount ? t("web.profile.rankHint", { rank: profile.rank, count: profile.participantCount }) : "",
      meter: beatPct
    },
    {
      cls: "metric-leverage",
      label: t("web.profile.cacheLeverage"),
      val: `${leverage} <small class="stat-unit">x</small>`,
      sub: `${t("web.analytics.cacheHitRate")}: ${cacheHitPct}%`,
      hint: t("web.profile.cacheHint", { pct: cacheHitPct }),
      meter: cacheHitPct
    },
    {
      cls: "metric-days",
      label: t("web.profile.activeDays"),
      val: `${activeDays} <small class="stat-unit">${t("web.profile.daysUnit")}</small>`,
      sub: consistencyRate > 0 ? `${t("web.profile.consistencyRate")}: ${consistencyRate}%` : "",
      hint: `${activeDays} active days`,
      meter: consistencyRate || null
    },
    {
      cls: "metric-avg",
      label: t("web.profile.dailyAverage"),
      val: localeTokenCompact(avgDaily),
      sub: t("web.profile.perActiveDay"),
      hint: formatTokenRaw(avgDaily)
    },
    {
      cls: "metric-streak bento-span-2",
      label: t("web.profile.currentStreak"),
      val: `${currentStreak} <small class="stat-unit">${t("web.profile.daysUnit")}</small>`,
      sub: bestStreak ? `${t("web.profile.bestStreak")}: ${bestStreak} ${t("web.profile.daysUnit")}` : "",
      hint: bestStreak ? t("web.profile.streakHint", { days: bestStreak }) : "",
      meter: streakMeter
    },
    {
      cls: "metric-peakmonth bento-span-2",
      label: t("web.profile.peakMonth"),
      val: escapeHtml(peakMonthLabel),
      sub: peakMonthTokens ? localeTokenCompact(peakMonthTokens) : "",
      hint: peakMonthTokens ? formatTokenRaw(peakMonthTokens) : "",
      monoSub: true
    },
    {
      cls: "metric-breadth bento-span-2",
      label: t("web.profile.toolBreadth"),
      val: `${providersCount} <small class="stat-unit">${t("web.detail.sources")}</small>`,
      sub: t("web.profile.topShare", { name: topProviderName }),
      hint: `${providersCount} sources connected`
    }
  ];

  container.innerHTML = cards.map((c) => {
    const meterHtml = c.meter != null && c.meter > 0
      ? `<div class="stat-tile-meter" aria-hidden="true"><i style="width:${Math.max(4, Math.min(100, c.meter))}%"></i></div>`
      : `<div class="stat-tile-meter is-empty" aria-hidden="true"></div>`;
    return `
    <article class="profile-stat-tile ${c.cls}"${c.hint ? ` data-tooltip="${escapeHtml(c.hint)}" tabindex="0"` : ""}>
      <span class="stat-tile-label">${escapeHtml(c.label)}</span>
      <strong class="stat-tile-value mono">${c.val}</strong>
      <div class="stat-tile-foot">
        <span class="stat-tile-sub${c.monoSub ? " mono" : ""}">${c.sub ? escapeHtml(c.sub) : "&nbsp;"}</span>
        ${meterHtml}
      </div>
    </article>`;
  }).join("");
}

function renderScoreboard(data = {}, profile = null) {
  setElementText("#kpi-today-tokens", localeTokenCompact(data.todayTokens || 0));
  setElementText("#kpi-yesterday-tokens", localeTokenCompact(data.yesterdayTokens || 0));
  setElementText("#kpi-week-tokens", localeTokenCompact(data.weekTokens || 0));
  setElementText("#kpi-last-week-tokens", localeTokenCompact(data.lastWeekTokens || 0));
  setElementText("#kpi-month-tokens", localeTokenCompact(data.thisMonthTokens || 0));
  setElementText("#kpi-last-month-tokens", localeTokenCompact(data.lastMonthTokens || 0));
  if (profile) {
    setElementText("#profile-all-time-tokens", localeTokenCompact(profile.totalTokens || 0));
  }

  renderDelta("delta-today", data.todayTokens, data.yesterdayTokens);
  renderDelta("delta-week", data.weekTokens, data.lastWeekTokens);
  renderDelta("delta-month", data.thisMonthTokens, data.lastMonthTokens);

  if (state.showCost) {
    setCostBadge("#kpi-today-cost", data.todayCost);
    setCostBadge("#kpi-yesterday-cost", data.yesterdayCost);
    setCostBadge("#kpi-week-cost", data.weekCost);
    setCostBadge("#kpi-last-week-cost", data.lastWeekCost);
    setCostBadge("#kpi-month-cost", data.thisMonthCost);
    setCostBadge("#kpi-last-month-cost", data.lastMonthCost);
    if (profile) setCostBadge("#profile-all-time-cost", profile.estimatedCostUsd);
  } else {
    document.querySelectorAll(".profile-kpi-scoreboard .cost-amount").forEach((el) => { el.hidden = true; });
  }
}

function setElementText(sel, text) {
  const el = document.querySelector(sel);
  if (el) el.textContent = text;
}

function setCostBadge(sel, costVal) {
  const el = document.querySelector(sel);
  if (!el) return;
  if (costVal !== null && costVal !== undefined && Number(costVal) > 0) {
    el.textContent = renderCost({ estimatedCostUsd: Number(costVal) }).replace(/<[^>]+>/g, "");
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function renderDelta(elId, current, previous) {
  const el = document.querySelector(`#${elId}`);
  if (!el) return;
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (!prev || !cur || cur === prev) {
    el.textContent = "--";
    el.className = "delta flat";
    el.hidden = false;
    return;
  }
  const pct = Math.round(((cur - prev) / prev) * 100);
  // cur > 0 can still round to -100%, which reads as "dropped to zero"; clamp it.
  const clamped = cur > 0 && pct === -100 ? -99 : pct;
  const up = clamped > 0;
  el.textContent = `${up ? "+" : ""}${clamped}%`;
  el.className = `delta ${up ? "up" : "down"}`;
  el.hidden = false;
}

function renderMonthlyRankChart(container, monthlyRanks = []) {
  if (!container) return;
  const activeMonths = monthlyRanks.filter((m) => m.rank !== null || m.totalTokens > 0);
  if (!activeMonths.length) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(t("web.analytics.noData"))}</div>`;
    return;
  }

  const displayMonths = activeMonths.slice(-8);
  const maxTokens = Math.max(...displayMonths.map((m) => m.totalTokens), 1);

  // Peak month note
  const peakMonth = [...displayMonths].sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0))[0];
  const peakNoteEl = document.querySelector("#monthly-peak-note");
  if (peakNoteEl && peakMonth) {
    peakNoteEl.textContent = t("web.profile.peakMonthNote", {
      month: peakMonth.month,
      tokens: localeTokenCompact(peakMonth.totalTokens),
      rank: peakMonth.rank || "-"
    });
  }

  const colsHtml = displayMonths.map((m) => {
    const barHeightPct = Math.max(6, Math.round((m.totalTokens / maxTokens) * 100));
    const rankLabel = m.rank ? `#${m.rank}` : "—";
    const isTop1 = m.rank === 1;
    const isTop2 = m.rank === 2;
    const isTop3 = m.rank === 3;
    const badgeClass = isTop1 ? "rank-gold" : isTop2 ? "rank-silver" : isTop3 ? "rank-bronze" : "";
    const shortMonth = m.month.slice(2);
    const tooltipText = m.rank
      ? t("web.profile.monthlyRankTooltip", { month: m.month, rank: m.rank, count: m.totalParticipants, tokens: localeTokenCompact(m.totalTokens) })
      : t("web.profile.monthlyRankTooltipUnranked", { month: m.month, tokens: localeTokenCompact(m.totalTokens) });

    return `
      <div class="mrank-col" data-tooltip="${escapeHtml(tooltipText)}" tabindex="0">
        <div class="mrank-val-area">
          <span class="mrank-badge ${badgeClass}">${rankLabel}</span>
        </div>
        <div class="mrank-bar-track">
          <div class="mrank-bar-fill ${m === peakMonth ? 'is-peak-bar' : ''}" style="height: ${barHeightPct}%"></div>
        </div>
        <div class="mrank-label mono">${shortMonth}</div>
      </div>
    `;
  }).join("");

  container.innerHTML = `
    <div class="monthly-rank-chart">
      <div class="mrank-grid">${colsHtml}</div>
      <div class="mrank-legend">
        <span><i class="legend-bar-sample"></i><span>${t("web.profile.monthlyBurn") || "月度消耗"}</span></span>
        <span><i class="legend-rank-sample"></i><span>${t("web.profile.leagueRank") || "全联盟排名"}</span></span>
      </div>
    </div>
  `;
}

function renderHeatmap() {
  const grid = document.querySelector("#profile-heatmap");
  if (!state.heatAll || !grid) return;
  const series = state.heatAll.map((item) => ({
    day: item.periodStart || item.day,
    totalTokens: Number(item.totalTokens || 0)
  }));
  renderActivityHeatmap(grid, series, {
    layout: "heatfull",
    levels: 12,
    businessDay: state.heatAll.businessDay || state.profile?.businessDay || "",
    to: state.heatAll.businessDay || state.profile?.businessDay || "",
    tooltip: tooltipEl,
    localeTokenCompact
  });
  const metaEl = document.querySelector("#profile-recent-meta");
  if (metaEl && series.length) {
    const firstDay = series[0].day;
    const lastDay = series[series.length - 1].day;
    metaEl.textContent = `${formatRange(firstDay < lastDay ? firstDay : lastDay, firstDay < lastDay ? lastDay : firstDay)} · ${t("web.profile.totalDays", { count: series.length })}`;
  }
}

async function loadHeatmap() {
  if (!state.displayId) return;
  try {
    // fields=totals：热力图只需要 日→总token，避免全量分维度明细
    const trendUrl = state.mode === "admin"
      ? `/api/admin/participants/${encodeURIComponent(state.displayId)}/trend?grain=day&range=all&fields=totals`
      : `/api/board/participants/${encodeURIComponent(state.displayId)}/trend?grain=day&range=all&fields=totals`;
    const response = await fetch(trendUrl);
    if (!response.ok) return;
    const trend = await response.json();
    state.heatAll = trend.items || [];
    state.heatAll.businessDay = trend.businessDay || "";
    renderHeatmap();
  } catch {}
}

async function loadHero() {
  if (!state.displayId) {
    renderNotFound();
    return;
  }
  try {
    const profileUrl = state.mode === "admin"
      ? `/api/admin/profile/${encodeURIComponent(state.displayId)}?${costParams()}`
      : `/api/board/profile/${encodeURIComponent(state.displayId)}?${costParams()}`;
    const response = await fetch(profileUrl);
    if (!response.ok) {
      const error = new Error("profile request failed");
      error.status = response.status;
      throw error;
    }
    const profile = await response.json();
    if (profile.identityMode) state.identityMode = profile.identityMode;
    if (!profile.displayId && !profile.displayName && !profile.nickname) throw new Error("profile empty");
    if (profile.displayId) {
      state.displayId = profile.displayId;
      rememberProfileId(profile.displayId);
    }
    renderHero(profile);
    const monthlyRankEl = document.querySelector("#profile-monthly-rank-chart");
    if (monthlyRankEl && profile.monthlyRanks) {
      renderMonthlyRankChart(monthlyRankEl, profile.monthlyRanks);
    }
    renderHeatmap();
  } catch (error) {
    renderNotFound({ status: Number(error?.status) || 0 });
  }
}

async function loadRange() {
  if (state.notFound || !state.displayId) return;
  const loadToken = ++rangeLoadToken;
  if (statusEl) statusEl.textContent = t("loading");

  const interactiveScope = document.querySelector(".profile-interactive-scope");
  if (interactiveScope) {
    interactiveScope.classList.add("is-switching");
    interactiveScope.classList.remove("is-refreshed");
  }
  const buttons = document.querySelectorAll("[data-profile-range] button, [data-profile-grain] button");
  buttons.forEach((b) => b.classList.add("is-waiting"));

  const detailUrl = state.mode === "admin"
    ? `/api/admin/participants/${encodeURIComponent(state.displayId)}?${costParams({ range: state.range })}`
    : `/api/board/participants/${encodeURIComponent(state.displayId)}?${costParams({ range: state.range })}`;

  // fields=totals：趋势图只消费 日/周期→总token，不需要分维度明细
  const trendUrl = state.mode === "admin"
    ? `/api/admin/participants/${encodeURIComponent(state.displayId)}/trend?${costParams({ grain: state.grain, range: state.range })}&fields=totals`
    : `/api/board/participants/${encodeURIComponent(state.displayId)}/trend?${costParams({ grain: state.grain, range: state.range })}&fields=totals`;

  // grain=hour-of-day：时段节律的 24 桶分布
  const hourlyUrl = state.mode === "admin"
    ? `/api/admin/participants/${encodeURIComponent(state.displayId)}/trend?${costParams({ grain: "hour-of-day", range: state.range })}`
    : `/api/board/participants/${encodeURIComponent(state.displayId)}/trend?${costParams({ grain: "hour-of-day", range: state.range })}`;

  const detailPromise = fetch(detailUrl);
  const trendPromise = fetch(trendUrl);
  const hourlyPromise = fetch(hourlyUrl).catch(() => null);
  const timerPromise = new Promise((resolve) => setTimeout(resolve, 240));

  try {
    const [detailResponse, trendResponse, hourlyResponse] = await Promise.all([detailPromise, trendPromise, hourlyPromise, timerPromise]);
    if (rangeLoadToken !== loadToken) return;
    const detail = await detailResponse.json();
    const trend = await trendResponse.json();
    const hourly = hourlyResponse && hourlyResponse.ok ? await hourlyResponse.json() : null;
    if (rangeLoadToken !== loadToken) return;
    state.rangeDetail = detail;

    if (state.range === RECENT_RANGE) {
      state.recent30 = detail;
    }

    renderTrend(trend.items || [], { from: trend.from, to: trend.to });
    renderHourlyRhythmCard(hourly);
    renderBreakdowns(detail);
    renderWeekdayAndSplit(detail);
    renderLogWorkbench(detail.rows || []);
    if (statusEl) statusEl.textContent = formatRange(detail.from, detail.to);
  } catch {
    if (rangeLoadToken !== loadToken) return;
    if (statusEl) statusEl.textContent = t("web.analytics.noData");
  } finally {
    if (rangeLoadToken === loadToken) {
      buttons.forEach((b) => b.classList.remove("is-waiting"));
      if (interactiveScope) {
        interactiveScope.classList.remove("is-switching");
        interactiveScope.classList.add("is-refreshed");
        setTimeout(() => interactiveScope.classList.remove("is-refreshed"), 400);
      }
    }
  }
}

function grainLabel(item) {
  if (state.grain === "month") return String(item.periodStart || "").slice(0, 7);
  if (state.grain === "week") return String(item.periodStart || "").slice(5);
  return "";
}

function renderTrend(items, { from, to }) {
  const frame = document.querySelector(".profile-trend-frame");
  const metaEl = document.querySelector("#profile-trend-meta");
  const sparkContainer = document.querySelector("#profile-trend-spark-stats");
  const capped = (items || []).slice(-TREND_BUCKET_CAP);
  if (!capped.length) {
    if (metaEl) metaEl.textContent = formatRange(from, to);
    if (frame) frame.innerHTML = emptyState(t("web.profile.emptyRange"), state.range === "all" ? {} : { hint: t("web.profile.emptyRangeHint") });
    if (sparkContainer) sparkContainer.innerHTML = "";
    return;
  }
  const sorted = [...capped].sort((a, b) => String(a.periodStart).localeCompare(String(b.periodStart)));
  const rangeFrom = from || sorted[0]?.periodStart || "";
  const rangeTo = to || sorted.at(-1)?.periodEnd || sorted.at(-1)?.periodStart || "";
  if (metaEl) metaEl.textContent = `${formatRange(rangeFrom, rangeTo)} · ${t("web.profile.buckets", { count: sorted.length })}`;

  // Spark stats pills
  let rangePeak = null;
  let rangeSum = 0;
  for (const item of sorted) {
    const val = Number(item.totalTokens || 0);
    rangeSum += val;
    if (!rangePeak || val > rangePeak.tokens) {
      rangePeak = { tokens: val, date: item.periodStart };
    }
  }
  const rangeAvg = Math.round(rangeSum / sorted.length);

  if (sparkContainer) {
    sparkContainer.innerHTML = `
      <div class="spark-pill" title="${rangePeak ? `${rangePeak.date} · ${formatTokenRaw(rangePeak.tokens)}` : ''}">
        <span class="spark-label">${t("web.profile.rangePeak") || "Range Peak"}</span>
        <strong class="spark-val mono">${rangePeak ? localeTokenCompact(rangePeak.tokens) : '-'}</strong>
      </div>
      <div class="spark-pill" title="${formatTokenRaw(rangeAvg)}">
        <span class="spark-label">${t("web.profile.dailyAverage") || "Average"}</span>
        <strong class="spark-val mono">${localeTokenCompact(rangeAvg)}</strong>
      </div>
      <div class="spark-pill" title="${formatTokenRaw(rangeSum)}">
        <span class="spark-label">${t("web.profile.rangeTotal") || "Total"}</span>
        <strong class="spark-val mono">${localeTokenCompact(rangeSum)}</strong>
      </div>
    `;
  }

  if (frame) {
    frame.innerHTML = `<svg id="profile-trend-svg" class="chart-svg" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(t("web.profile.trend"))}"></svg>`;
    const svg = frame.querySelector("svg");
    const series = sorted.map((item) => ({
      day: item.periodStart,
      label: grainLabel(item),
      totalTokens: Number(item.totalTokens || 0)
    }));
    renderTrendChart(svg, series, state.grain, tooltipEl, localeTokenCompact, { highlightPeak: true, height: 220 });
  }
}

let hourlyItemsCache = [];
let hourlyWorkWindow = null;

function renderHourlySplit() {
  const splitEl = document.querySelector("#profile-hourly-split");
  if (!splitEl) return;
  const stats = computeHourlyRhythmStats(hourlyItemsCache, hourlyWorkWindow || {});
  if (!stats.total) {
    splitEl.innerHTML = "";
    return;
  }
  const workPct = Math.round(stats.workShare * 100);
  const offPct = 100 - workPct;
  const offTokens = stats.total - stats.workTokens;
  let archetype = t("web.profile.hourlyArchetypeAll");
  if (stats.nightShare >= 0.25) archetype = t("web.profile.hourlyArchetypeNight");
  else if (workPct >= 65) archetype = t("web.profile.hourlyArchetypeWork");
  const workLabel = t("web.profile.hourlyWorkShare", { from: stats.workStart, to: stats.workEnd });
  const offLabel = t("web.profile.hourlyOffShare");
  splitEl.innerHTML = `
    <div class="split-rhythm-box">
      <div class="split-label-row">
        <span class="split-title mono">${escapeHtml(t("web.profile.hourlySplitTitle"))}</span>
        <span class="split-tag">${escapeHtml(archetype)}</span>
      </div>
      <div class="split-track">
        <div class="split-fill work" style="width: ${workPct}%"></div>
        <div class="split-fill off" style="width: ${offPct}%"></div>
      </div>
      <div class="split-values">
        <span>${escapeHtml(workLabel)}: <strong class="mono">${workPct}%</strong> <small>(${localeTokenCompact(stats.workTokens)})</small></span>
        <span>${escapeHtml(offLabel)}: <strong class="mono">${offPct}%</strong> <small>(${localeTokenCompact(offTokens)})</small></span>
      </div>
    </div>
  `;
}

// Hour-rhythm badges appended to the hero features strip. Re-rendered on
// every range switch; max two badges, priority night > overtime > daytime.
function renderHourlyFeatureTags(stats) {
  const strip = document.querySelector("#profile-features-strip");
  if (!strip) return;
  strip.querySelectorAll(".feature-tag.feature-hour").forEach((tag) => tag.remove());
  if (!stats || !stats.total) return;
  const pct = (share) => String(Math.round(share * 100));
  const candidates = [
    stats.nightShare >= 0.20 && {
      cls: "feature-night",
      label: t("web.profile.hourlyTagNight"),
      hint: t("web.profile.hourlyTagNightHint", { pct: pct(stats.nightShare) })
    },
    stats.eveningShare >= 0.35 && {
      cls: "feature-overtime",
      label: t("web.profile.hourlyTagOvertime"),
      hint: t("web.profile.hourlyTagOvertimeHint", { pct: pct(stats.eveningShare) })
    },
    stats.workShare >= 0.60 && {
      cls: "feature-daytime",
      label: t("web.profile.hourlyTagDaytime"),
      hint: t("web.profile.hourlyTagDaytimeHint", { pct: pct(stats.workShare) })
    }
  ].filter(Boolean).slice(0, 2);
  for (const item of candidates) {
    const span = document.createElement("span");
    span.className = `feature-tag feature-hour ${item.cls}`;
    span.title = item.hint;
    span.textContent = item.label;
    strip.appendChild(span);
  }
}

function renderHourlyRhythmCard(hourly) {
  const chartEl = document.querySelector("#profile-hourly-chart");
  const metaEl = document.querySelector("#profile-hourly-meta");
  const statsEl = document.querySelector("#profile-hourly-stats");
  const card = document.querySelector(".profile-hourly-card");
  if (card) card.setAttribute("aria-busy", "false");
  if (!chartEl) return;
  const items = (hourly && hourly.items) || [];
  hourlyItemsCache = items;
  hourlyWorkWindow = (hourly && hourly.workWindow) || null;
  const stats = computeHourlyRhythmStats(items, hourlyWorkWindow || {});
  renderHourlyFeatureTags(stats);
  if (!stats.total) {
    // Keep the card compact: message goes in the subtitle slot, the 168px bar grid collapses.
    chartEl.hidden = true;
    chartEl.innerHTML = "";
    if (metaEl) metaEl.textContent = t("web.profile.emptyHourly");
    if (statsEl) statsEl.innerHTML = "";
    renderHourlySplit();
    return;
  }
  chartEl.hidden = false;
  renderHourlyRhythm(chartEl, items, { localeTokenCompact, tooltip: tooltipEl });
  renderHourlySplit();
  if (metaEl) {
    const rangeLabel = formatRange(hourly.from, hourly.to);
    const coverage = t("web.profile.hourlyCoverage", { count: hourly.coverage?.days ?? 0 });
    metaEl.textContent = `${rangeLabel} · ${coverage}`;
  }
  if (statsEl) {
    const peakLabel = stats.peakHour >= 0 ? `${String(stats.peakHour).padStart(2, "0")}:00` : "-";
    const peakTitle = stats.peakHour >= 0 ? `${peakLabel} · ${formatTokenRaw(items.find((item) => Number(item.hour) === stats.peakHour)?.totalTokens || 0)}` : "";
    statsEl.innerHTML = `
      <div class="spark-pill" title="${escapeHtml(peakTitle)}">
        <span class="spark-label">${t("web.profile.hourlyGoldenHour")}</span>
        <strong class="spark-val mono">${peakLabel} · ${(stats.peakShare * 100).toFixed(1)}%</strong>
      </div>
      <div class="spark-pill" title="">
        <span class="spark-label">${t("web.profile.hourlyNightShare")}</span>
        <strong class="spark-val mono">${(stats.nightShare * 100).toFixed(1)}%</strong>
      </div>
    `;
  }
}

function renderBreakdowns(detail) {
  const total = Number(detail.totalTokens || 0);
  const models = detail.models || [];

  const modelsMetaEl = document.querySelector("#profile-models-meta");
  if (modelsMetaEl) {
    const topModel = models[0];
    const topModelPct = (topModel && total) ? Math.round((topModel.totalTokens / total) * 100) : 0;
    modelsMetaEl.textContent = models.length
      ? `${t("web.profile.modelsCount", { count: models.length })} · ${topModel ? `${topModel.name} (${topModelPct}%)` : ""}`
      : "";
  }

  renderBarChart(
    document.querySelector("#profile-models"),
    models.map((item) => ({
      name: item.name || "unknown",
      tokens: Number(item.totalTokens || 0),
      ratio: total ? Number(item.totalTokens || 0) / total : 0,
      estimatedCostUsd: item.estimatedCostUsd,
      costQuality: item.costQuality,
      missingPriceTokens: item.missingPriceTokens
    })),
    {
      collapseAfter: 8,
      localeTokenCompact,
      showCost: state.showCost,
      renderCost
    }
  );
  renderSourcesBreakdown(detail);
}

function renderSourcesBreakdown(detail) {
  const container = document.querySelector("#profile-sources");
  const countBadge = document.querySelector("#profile-sources-count");
  const metaEl = document.querySelector("#profile-sources-meta");
  if (!container) return;

  const providers = detail.providers || [];
  const total = Number(detail.totalTokens || 0);

  if (countBadge) {
    countBadge.textContent = t("web.profile.sourceCount", { count: providers.length });
    countBadge.hidden = !providers.length;
  }
  if (metaEl) {
    metaEl.textContent = providers.length ? t("web.profile.filterWorkbenchHint") : "";
  }

  if (!providers.length) {
    container.innerHTML = `<div class="meter-empty">${escapeHtml(t("web.analytics.noData") || "No usage data")}</div>`;
    return;
  }

  // Calculate detailed stats per provider from detail.rows
  const statsMap = {};
  for (const r of (detail.rows || [])) {
    const pid = r.providerId || "unknown";
    if (!statsMap[pid]) {
      statsMap[pid] = { days: new Set(), models: new Map(), tokens: 0 };
    }
    if (r.day) statsMap[pid].days.add(r.day);
    const tokens = Number(r.totalTokens || 0);
    statsMap[pid].tokens += tokens;
    if (r.model) {
      statsMap[pid].models.set(r.model, (statsMap[pid].models.get(r.model) || 0) + tokens);
    }
  }

  // 1. Multi-segment distribution stack bar
  const stackSegments = providers.map((item, sourceIndex) => {
    const tokens = Number(item.totalTokens || 0);
    const pct = total ? Math.round((tokens / total) * 100) : 0;
    const color = rankSeriesColor(sourceIndex);
    const name = sourceName(item.name);
    return `<div class="source-stack-seg" style="width: ${Math.max(1, pct)}%; background: ${color};" title="${escapeHtml(name)}: ${escapeHtml(localeTokenCompact(tokens))} (${pct}%)"></div>`;
  }).join("");

  // 2. Provider eco-cards
  const cardsHtml = providers.map((item, sourceIndex) => {
    const tokens = Number(item.totalTokens || 0);
    const rawPct = total ? (tokens / total) * 100 : 0;
    let pctLabel = "0%";
    if (rawPct >= 1) {
      pctLabel = `${Math.round(rawPct)}%`;
    } else if (rawPct >= 0.05) {
      pctLabel = `${rawPct.toFixed(1)}%`;
    } else if (tokens > 0) {
      pctLabel = "<0.1%";
    }
    const color = rankSeriesColor(sourceIndex);
    const name = sourceName(item.name);

    let roleText = t("web.profile.trialEngine");
    let roleClass = "role-trial";
    if (rawPct >= 50) {
      roleText = t("web.profile.dominantEngine");
      roleClass = "role-dominant";
    } else if (rawPct >= 15) {
      roleText = t("web.profile.coreEngine");
      roleClass = "role-core";
    } else if (rawPct >= 2) {
      roleText = t("web.profile.collabEngine");
      roleClass = "role-collab";
    }

    const providerStats = statsMap[item.name];
    const daysCount = providerStats ? providerStats.days.size : 0;

    let topModel = "";
    if (providerStats && providerStats.models.size) {
      const sortedModels = [...providerStats.models.entries()].sort((a, b) => b[1] - a[1]);
      topModel = sortedModels[0]?.[0] || "";
    }

    const isFiltered = rawWorkbench.sourceFilter === item.name;

    return `
      <div class="provider-eco-card${isFiltered ? " is-active-filter" : ""}" data-provider-id="${escapeHtml(item.name)}" role="button" tabindex="0" title="${escapeHtml(t("web.profile.filterWorkbenchHint"))}">
        <div class="provider-eco-head">
          <div class="provider-eco-brand" title="${escapeHtml(item.name)}">
            <span class="provider-eco-dot" style="background: ${color}; box-shadow: 0 0 8px ${color}66;"></span>
            <strong class="provider-eco-name">${escapeHtml(name)}</strong>
          </div>
          <span class="provider-eco-role ${roleClass}">${escapeHtml(roleText)}</span>
        </div>
        <div class="provider-eco-metrics">
          <div class="provider-eco-val-row">
            <span class="provider-eco-tokens mono" title="${escapeHtml(formatTokenRaw(tokens))}">${localeTokenCompact(tokens)}</span>
            <span class="provider-eco-pct mono">${pctLabel}</span>
          </div>
          ${state.showCost ? `<div class="provider-eco-cost">${renderCost(item)}</div>` : ""}
          <div class="provider-eco-meter-track">
            <div class="provider-eco-meter-fill" style="width: ${Math.max(tokens > 0 ? 1.5 : 0, Math.min(100, rawPct))}%; background: ${color};"></div>
          </div>
        </div>
        <div class="provider-eco-footer">
          <span class="provider-eco-tag mono">${t("web.profile.activeDaysCount", { days: daysCount })}</span>
          ${topModel ? `<span class="provider-eco-tag mono" title="${escapeHtml(topModel)}">${escapeHtml(t("web.profile.primaryModel"))}: ${escapeHtml(topModel)}</span>` : ""}
        </div>
      </div>
    `;
  }).join("");

  container.innerHTML = `
    <div class="source-stack-bar-wrap">
      <div class="source-stack-bar">${stackSegments}</div>
    </div>
    <div class="provider-eco-grid">${cardsHtml}</div>
  `;

  // Bind click on provider cards to filter workbench
  container.querySelectorAll(".provider-eco-card").forEach((card) => {
    card.addEventListener("click", () => {
      const pid = card.dataset.providerId;
      if (rawWorkbench.sourceFilter === pid) {
        rawWorkbench.sourceFilter = "";
      } else {
        rawWorkbench.sourceFilter = pid;
      }
      const sourceSel = document.querySelector("#profile-filter-source");
      if (sourceSel) sourceSel.value = rawWorkbench.sourceFilter;
      renderFilteredLogRows();

      container.querySelectorAll(".provider-eco-card").forEach((c) => {
        c.classList.toggle("is-active-filter", c.dataset.providerId === rawWorkbench.sourceFilter);
      });

      if (rawWorkbench.sourceFilter) {
        showToast(t("web.profile.filteredBySource", { source: sourceName(pid) }));
        document.querySelector(".profile-log-workbench")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  });
}

function renderWeekdayAndSplit(detail) {
  const weekdayEl = document.querySelector("#profile-weekday-chart");
  const splitEl = document.querySelector("#weekday-weekend-split");

  const timeSeries = (detail.periodRows || []).map((r) => ({
    day: r.periodStart || r.day,
    totalTokens: Number(r.totalTokens || 0)
  }));

  if (weekdayEl) {
    renderWeekdayRhythm(weekdayEl, timeSeries, { tooltip: tooltipEl, localeTokenCompact });
  }

  if (splitEl && timeSeries.length) {
    let workdaySum = 0;
    let weekendSum = 0;
    for (const item of timeSeries) {
      if (!item.day) continue;
      const dayOfWeek = new Date(`${item.day}T00:00:00Z`).getUTCDay();
      const tokens = Number(item.totalTokens || 0);
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        weekendSum += tokens;
      } else {
        workdaySum += tokens;
      }
    }
    const totalSum = workdaySum + weekendSum;
    const workdayPct = totalSum > 0 ? Math.round((workdaySum / totalSum) * 100) : 0;
    const weekendPct = totalSum > 0 ? 100 - workdayPct : 0;

    let archetype = t("web.profile.archetypeBalanced");
    if (workdayPct >= 80) archetype = t("web.profile.archetypeWorkday");
    else if (weekendPct >= 35) archetype = t("web.profile.archetypeWeekend");

    const workdayLabel = t("web.profile.splitWorkdayLabel");
    const weekendLabel = t("web.profile.splitWeekendLabel");
    splitEl.innerHTML = `
      <div class="split-rhythm-box">
        <div class="split-label-row">
          <span class="split-title mono">${escapeHtml(t("web.profile.splitTitle"))}</span>
          <span class="split-tag">${escapeHtml(archetype)}</span>
        </div>
        <div class="split-track">
          <div class="split-fill workday" style="width: ${workdayPct}%" title="${escapeHtml(workdayLabel)}: ${workdayPct}% (${localeTokenCompact(workdaySum)})"></div>
          <div class="split-fill weekend" style="width: ${weekendPct}%" title="${escapeHtml(weekendLabel)}: ${weekendPct}% (${localeTokenCompact(weekendSum)})"></div>
        </div>
        <div class="split-values">
          <span>${escapeHtml(workdayLabel)}: <strong class="mono">${workdayPct}%</strong> <small>(${localeTokenCompact(workdaySum)})</small></span>
          <span>${escapeHtml(weekendLabel)}: <strong class="mono">${weekendPct}%</strong> <small>(${localeTokenCompact(weekendSum)})</small></span>
        </div>
      </div>
    `;
  } else if (splitEl) {
    splitEl.innerHTML = "";
  }
}

// 原始数据工作台状态
const rawWorkbench = {
  allRows: [],
  sourceFilter: "",
  modelFilter: ""
};

function renderLogWorkbench(rows) {
  rawWorkbench.allRows = rows || [];
  populateFilterOptions();
  renderFilteredLogRows();
}

function populateFilterOptions() {
  const sourceSel = document.querySelector("#profile-filter-source");
  const modelSel = document.querySelector("#profile-filter-model");
  if (!sourceSel || !modelSel) return;

  const sources = new Set();
  const models = new Set();
  for (const r of rawWorkbench.allRows) {
    if (r.providerId) sources.add(r.providerId);
    if (r.model) models.add(r.model);
  }

  const prevSource = rawWorkbench.sourceFilter;
  const prevModel = rawWorkbench.modelFilter;

  sourceSel.innerHTML = `<option value="">${t("web.profile.filterSourceAll") || "All sources"}</option>` +
    [...sources].map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(sourceName(s))}</option>`).join("");
  modelSel.innerHTML = `<option value="">${t("web.profile.filterModelAll") || "All models"}</option>` +
    [...models].map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");

  if (sources.has(prevSource)) sourceSel.value = prevSource;
  else rawWorkbench.sourceFilter = "";

  if (models.has(prevModel)) modelSel.value = prevModel;
  else rawWorkbench.modelFilter = "";
}

function renderFilteredLogRows() {
  const tbody = document.querySelector("#profile-rows");
  const countPill = document.querySelector("#profile-log-count");
  if (!tbody) return;

  const filtered = rawWorkbench.allRows.filter((r) => {
    if (rawWorkbench.sourceFilter && r.providerId !== rawWorkbench.sourceFilter) return false;
    if (rawWorkbench.modelFilter && r.model !== rawWorkbench.modelFilter) return false;
    return true;
  });

  if (countPill) countPill.textContent = String(filtered.length);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="8">${escapeHtml(t("web.profile.emptyRange"))}</td></tr>`;
    return;
  }

  const maxRowTokens = Math.max(...filtered.map((r) => r.totalTokens || 0), 1);
  const cacheOf = (row) => Number(row.cacheReadTokens || 0) + Number(row.cacheWriteTokens || 0);

  tbody.innerHTML = filtered.map((row) => {
    const totalTokens = Number(row.totalTokens || 0);
    const barPct = Math.max(3, Math.round((totalTokens / maxRowTokens) * 100));
    return `<tr>
      <td class="mono">${escapeHtml(row.day)}</td>
      <td>${escapeHtml(sourceName(row.providerId))}</td>
      <td class="mono model-cell" title="${escapeHtml(row.model || "")}">${escapeHtml(row.model || "unknown")}</td>
      <td class="tokens-col">
        <div class="row-token-wrap">
          <div class="row-token-value">
            <span class="tokens-num mono" title="${escapeHtml(formatTokenRaw(row.totalTokens))}">${localeTokenCompact(row.totalTokens)}</span>
            ${state.showCost ? `<span class="row-cost-badge mono">${renderCost(row)}</span>` : ""}
          </div>
          <div class="log-mini-meter"><div class="log-mini-fill" style="width: ${barPct}%"></div></div>
        </div>
      </td>
      <td class="tokens mono" title="${escapeHtml(formatTokenRaw(row.inputTokens))}">${localeTokenCompact(row.inputTokens)}</td>
      <td class="tokens mono" title="${escapeHtml(formatTokenRaw(row.outputTokens))}">${localeTokenCompact(row.outputTokens)}</td>
      <td class="tokens mono" title="${escapeHtml(formatTokenRaw(cacheOf(row)))}">${localeTokenCompact(cacheOf(row))}</td>
      <td class="tokens mono" title="${escapeHtml(formatTokenRaw(row.reasoningTokens))}">${localeTokenCompact(row.reasoningTokens)}</td>
    </tr>`;
  }).join("");
}

// 事件绑定
document.querySelector("#profile-filter-source")?.addEventListener("change", (e) => {
  rawWorkbench.sourceFilter = e.target.value;
  renderFilteredLogRows();
  document.querySelectorAll(".provider-eco-card").forEach((c) => {
    c.classList.toggle("is-active-filter", c.dataset.providerId === rawWorkbench.sourceFilter);
  });
});

document.querySelector("#profile-filter-model")?.addEventListener("change", (e) => {
  rawWorkbench.modelFilter = e.target.value;
  renderFilteredLogRows();
});




document.querySelectorAll("[data-profile-range]").forEach((group) => {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || state.notFound) return;
    setActive(group, button);
    state.range = button.dataset.value;
    loadRange();
  });
});

document.querySelectorAll("[data-profile-grain]").forEach((group) => {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || state.notFound) return;
    setActive(group, button);
    state.grain = button.dataset.value;
    loadRange();
  });
});

const showCostToggle = document.querySelector("#show-cost");
if (showCostToggle) {
  showCostToggle.checked = state.showCost;
  showCostToggle.addEventListener("change", () => {
    state.showCost = showCostToggle.checked;
    persistPreference(storageKeys.showCost, state.showCost);
    if (!state.showCost) {
      document.querySelectorAll(".cost-amount").forEach((el) => { el.hidden = true; });
    }
    loadHero();
    loadRange();
  });
}

const langContainer = document.querySelector("#lang-switcher-container");
if (langContainer) {
  mountLangSwitcher(langContainer, () => {
    window.location.reload();
  });
}

updatePageTranslations();

// 名字元素不挂 data-i18n（避免全局重翻译覆盖已渲染值），占位文案在此手动本地化
const namePlaceholderEl = document.querySelector("#profile-name");
if (namePlaceholderEl) namePlaceholderEl.textContent = t("loading");

const profileSwitcher = initPublicNavProfile({
  currentId: state.displayId,
  isProfilePage: true,
  mode: state.mode
});

document.querySelector("#profile-pick-another")?.addEventListener("click", async () => {
  const api = await profileSwitcher;
  if (api?.open) await api.open();
  else document.querySelector("#profile-switcher-trigger")?.click();
});

(async () => {
  if (!state.displayId) {
    const fallbackId = await resolveDefaultProfileId({ mode: state.mode });
    if (fallbackId) {
      window.location.replace(profilePageUrl(fallbackId, { mode: state.mode }));
      return;
    }
  }
  await loadHero();
  if (state.notFound) {
    const retryKey = "ai-token-league.public.profileFallbackTried";
    try {
      if (!sessionStorage.getItem(retryKey)) {
        const fallbackId = await resolveDefaultProfileId({ mode: state.mode });
        if (fallbackId && fallbackId !== state.displayId) {
          sessionStorage.setItem(retryKey, "1");
          window.location.replace(profilePageUrl(fallbackId, { mode: state.mode }));
          return;
        }
      }
      sessionStorage.removeItem(retryKey);
    } catch {
      /* stay on not-found */
    }
    return;
  }
  await loadRange();
  loadHeatmap();
})();
