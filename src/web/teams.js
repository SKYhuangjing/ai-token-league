import { initI18n, t, getCurrentLang, mountLangSwitcher, updatePageTranslations } from "/shared/i18n.js";
import "/theme-switcher.js";
import { formatTokenCompact } from "/shared/display.js";
import { escapeHtml, formatCost, positionTooltip } from "/shared/chart-helpers.js";

const isEmbedded = window.self !== window.top;
if (isEmbedded) {
  document.addEventListener("DOMContentLoaded", () => {
    document.body.classList.add("is-embedded");
  });

  let lastReportedHeight = 0;
  let resizeFramePending = false;

  function notifyHeight() {
    const bodyHeight = document.body ? document.body.scrollHeight : 0;
    const height = Math.ceil(Math.max(document.documentElement.scrollHeight, bodyHeight));
    if (height === lastReportedHeight) return;
    lastReportedHeight = height;
    window.parent.postMessage({ type: "teams-resize", height }, window.location.origin);
  }

  const resizeObserver = new ResizeObserver(() => {
    if (resizeFramePending) return;
    resizeFramePending = true;
    requestAnimationFrame(() => {
      resizeFramePending = false;
      notifyHeight();
    });
  });
  window.addEventListener("load", () => {
    notifyHeight();
    resizeObserver.observe(document.body);
  });
}

initI18n();

const state = {
  days: 7,
  manageOpen: false,
  manageFilter: "untagged",
  search: "",
  management: null,
  analysis: null,
  expanded: new Set(),
  selected: new Set(),
  batchBusy: false,
  armedDelete: null,
  armedDeleteTimer: 0,
  membersViewTeamId: null
};

const loadingEl = document.querySelector("#teams-loading");
const emptyEl = document.querySelector("#teams-empty");
const boardEl = document.querySelector("#teams-board");
const manageEl = document.querySelector("#teams-manage");
const rangeLabel = document.querySelector("#teams-range-label");
const manageStatus = document.querySelector("#teams-manage-status");

function showManageStatus(message) {
  if (!manageStatus) return;
  manageStatus.hidden = !message;
  manageStatus.textContent = message || "";
}

function setLoading(on) {
  loadingEl.hidden = !on;
  document.querySelectorAll("[data-filter='teams-range'] button").forEach((btn) => {
    btn.disabled = on;
  });
}

// toolCode vocabulary comes from collector-core TOOL_CODE constants; the
// board's usage rows carry "claude_code" (not "claude") for Claude Code.
function toolDisplayName(toolCode) {
  const keyMap = { codex: "source.codex", claude_code: "source.claude", claude: "source.claude", cursor: "source.cursor", mimocode: "source.mimocode", opencode: "source.opencode", hermes: "source.hermes", openclaw: "source.openclaw", zcode: "source.zcode", workbuddy: "source.workbuddy", dsh: "source.dsh", kimi: "source.kimi" };
  if (keyMap[toolCode]) {
    const label = t(keyMap[toolCode]);
    if (label) return label;
  }
  return toolCode;
}

function fmtTokens(value) {
  return formatTokenCompact(value || 0, getCurrentLang());
}

function shortDay(day) {
  return String(day || "").slice(5).replace("-", "/");
}

// Floating tooltip for chart marks: marks declare data-tip="…", one delegated
// listener pair covers every (re)rendered chart without per-render rebinding.
const chartTipEl = document.querySelector("#teams-tooltip");
document.addEventListener("mouseover", (event) => {
  const mark = event.target.closest?.("[data-tip]");
  if (!mark || !chartTipEl) return;
  chartTipEl.textContent = mark.dataset.tip;
  chartTipEl.style.opacity = "1";
  positionTooltip(chartTipEl, mark);
});
document.addEventListener("mouseout", (event) => {
  const mark = event.target.closest?.("[data-tip]");
  if (!mark || !chartTipEl) return;
  // moving between children of the same mark keeps the tooltip up
  if (event.relatedTarget && mark.contains(event.relatedTarget)) return;
  chartTipEl.style.opacity = "0";
});
// scrolling under a stationary pointer fires no boundary events; drop the
// tooltip so it cannot linger detached from its mark
document.addEventListener("scroll", () => {
  if (chartTipEl) chartTipEl.style.opacity = "0";
}, { capture: true, passive: true });

function dayLabel(day, index, total) {
  const cadence = total <= 7 ? 1 : total <= 14 ? 2 : 5;
  return index === total - 1 || index % cadence === 0 ? String(day || "").slice(5).replace("-", "/") : "";
}

async function api(path, options = {}) {
  // no-store: the board re-fetches immediately after writes; heuristic cache
  // would serve the pre-write response and the change would look like a no-op.
  const response = await fetch(path, { cache: "no-store", ...options });
  if (response.status === 401) throw Object.assign(new Error("admin auth required"), { status: 401 });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `${response.status}`);
  }
  return response.json();
}

window.addEventListener("atl:themechange", () => {
  if (state.analysis) renderAll();
});

async function loadAll() {
  setLoading(true);
  emptyEl.hidden = true;
  try {
    const [management, analysis] = await Promise.all([
      api("/api/admin/teams"),
      api(`/api/admin/teams/analysis?days=${state.days}`)
    ]);
    state.management = management;
    state.analysis = analysis;
    showManageStatus("");
    renderAll();
  } catch (error) {
    boardEl.hidden = true;
    manageEl.hidden = true;
    emptyEl.hidden = false;
    if (error.status === 401) {
      emptyEl.innerHTML = `<div class="teams-empty-copy"><h2 data-i18n="web.teams.empty.adminTitle">需要管理员权限</h2><p data-i18n="web.teams.empty.adminBody">团队分析仅对管理员开放。请先在管理台登录后再查看。</p><a class="teams-empty-link" href="/admin.html" data-i18n="web.teams.backToAdmin">返回管理台</a></div>`;
    } else {
      emptyEl.innerHTML = `<div class="teams-empty-copy"><h2 data-i18n="web.teams.empty.errorTitle">加载失败</h2><p>${escapeHtml(error.message)}</p></div>`;
    }
    updateDynamicTranslations(emptyEl);
  } finally {
    setLoading(false);
  }
}

function updateDynamicTranslations(root = document) {
  root.querySelectorAll("[data-dyn-i18n]").forEach((el) => {
    const key = el.getAttribute("data-dyn-i18n");
    const text = t(key);
    if (text) el.textContent = text;
  });
  // Freshly rendered [data-i18n] nodes (management chips, empty states) also
  // need the static translation pass, which only runs on init/language change.
  updatePageTranslations();
}

function renderAll() {
  renderRangeLabel();
  const { management, analysis } = state;
  const hasTeams = management.teams.length > 0;
  boardEl.hidden = !hasTeams;
  if (!hasTeams) {
    emptyEl.hidden = false;
    emptyEl.innerHTML = `<div class="teams-empty-copy"><h2 data-i18n="web.teams.empty.noTeamsTitle">还没有团队</h2><p data-i18n="web.teams.empty.noTeamsBody">先创建团队并给成员打上团队标签，这里会呈现按团队聚合的使用分析。</p><button type="button" class="teams-empty-link" id="teams-empty-open-manage" data-i18n="web.teams.manage.toggle">管理团队</button></div>`;
    updateDynamicTranslations(emptyEl);
    document.querySelector("#teams-empty-open-manage")?.addEventListener("click", () => {
      setManageOpen(true);
      emptyEl.hidden = true;
      document.querySelector("#teams-create-name")?.focus();
    });
  } else {
    emptyEl.hidden = true;
  }
  renderManage();
  if (hasTeams) {
    renderStory();
    renderDailyActive();
    renderDailyTokens();
    renderCompare();
    renderTeams();
  }
}

function renderRangeLabel() {
  const { analysis } = state;
  if (!analysis) return;
  rangeLabel.textContent = t("web.teams.rangeCaption", {
    from: analysis.range.from.slice(5).replace("-", "/"),
    to: analysis.range.to.slice(5).replace("-", "/")
  });
}

function signedDelta(n) {
  if (n === 0) return "±0";
  return n > 0 ? `+${n}` : `${n}`;
}

function jumpToTeam(teamId) {
  const el = document.getElementById(`team-${teamId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  // brief outline so the row/card that triggered the jump is findable among
  // structurally identical team cards
  el.classList.add("is-target");
  clearTimeout(jumpToTeam._timer);
  jumpToTeam._timer = setTimeout(() => el.classList.remove("is-target"), 1600);
}

function renderStory() {
  const { analysis } = state;
  const { org, teams } = analysis;
  const storyEl = document.querySelector("#teams-story");
  // Focus on churn first (members starting/pausing), then net deltas: a flat
  // net with one paused + one new member is still the biggest story.
  const churned = [...teams]
    .filter((team) => team.newCount + team.pausedCount > 0)
    .sort((a, b) => (b.newCount + b.pausedCount) - (a.newCount + a.pausedCount) || b.pausedCount - a.pausedCount);
  const changed = [...teams].filter((team) => team.deltaActive !== 0).sort((a, b) => a.deltaActive - b.deltaActive);
  const churnFocus = churned[0] || null;
  const focus = churnFocus || changed[0] || null;

  const deltaLine = org.deltaActive > 0
    ? t("web.teams.story.deltaUp", { n: org.deltaActive })
    : org.deltaActive < 0
      ? t("web.teams.story.deltaDown", { n: Math.abs(org.deltaActive) })
      : t("web.teams.story.deltaFlat");
  let focusLine;
  if (churnFocus) {
    focusLine = churnFocus.pausedCount > 0 && churnFocus.newCount > 0
      ? t("web.teams.story.focusChurnBoth", { name: churnFocus.name, paused: churnFocus.pausedCount, added: churnFocus.newCount })
      : churnFocus.pausedCount > 0
        ? t("web.teams.story.focusChurnPaused", { name: churnFocus.name, n: churnFocus.pausedCount })
        : t("web.teams.story.focusChurnNew", { name: churnFocus.name, n: churnFocus.newCount });
  } else if (focus) {
    focusLine = t("web.teams.story.focus", { name: focus.name, delta: signedDelta(focus.deltaActive) });
  } else {
    focusLine = t("web.teams.story.noFocus");
  }
  const link = focus ? `<a class="teams-story-link" href="#team-${escapeHtml(focus.id)}">${escapeHtml(t("web.teams.story.link"))}</a>` : "";

  const total = Math.max(1, org.taggedMembers);
  const segs = [
    { cls: "steady", n: org.steady, labelKey: "web.teams.cohort.steady" },
    { cls: "light", n: org.light, labelKey: "web.teams.cohort.light" },
    { cls: "none", n: org.taggedMembers - org.active, labelKey: "web.teams.cohort.none" }
  ].filter((seg) => seg.n > 0);

  storyEl.innerHTML = `
    <div class="teams-story-grid">
      <div class="teams-story-copy">
        <span class="section-kicker" data-i18n="web.teams.story.kicker">本期关键发现</span>
        <h2>${escapeHtml(t("web.teams.story.headline", { active: org.active, tagged: org.taggedMembers }))}</h2>
        <p>${escapeHtml(deltaLine)}${escapeHtml(focusLine)}</p>
        ${link}
      </div>
      <div class="teams-cohort">
        <div class="teams-cohort-strip" role="img" aria-label="${escapeHtml(t("web.teams.cohort.aria", { steady: org.steady, light: org.light, none: org.taggedMembers - org.active }))}">
          ${segs.map((seg) => `<span class="seg ${seg.cls}" style="width:${(seg.n / total) * 100}%"></span>`).join("")}
        </div>
        <div class="teams-cohort-key">
          ${segs.map((seg) => `<span class="key-item ${seg.cls}"><i aria-hidden="true"></i><b>${seg.n}</b><em data-dyn-i18n="${seg.labelKey}"></em></span>`).join("")}
        </div>
      </div>
    </div>`;
  updateDynamicTranslations(storyEl);
  storyEl.querySelector(".teams-story-link")?.addEventListener("click", (event) => {
    event.preventDefault();
    jumpToTeam(focus.id);
  });
  // coverage line lives in the cohort column: the strip above counts the
  // tagged people, this line closes the loop with the org-wide denominator
  const { untagged } = analysis.org;
  const coverage = untagged.members
    ? `<p class="teams-coverage"><span>${escapeHtml(t("web.teams.story.coverage", { tagged: org.taggedMembers, total: org.taggedMembers + untagged.members }))}</span><button type="button" class="teams-coverage-link" id="teams-coverage-open">${escapeHtml(t("web.teams.story.coverageLink", { members: untagged.members }))}</button></p>`
    : "";
  document.querySelector(".teams-cohort").insertAdjacentHTML("beforeend", coverage);
  document.querySelector("#teams-coverage-open")?.addEventListener("click", () => {
    setManageOpen(true);
    setManageFilter("untagged");
    document.querySelector("#teams-member-search")?.focus();
  });
}

function lineChartSvg({ values, prevValues = [], labels, yMax, formatValue }) {
  const width = 640;
  const height = 220;
  const padLeft = 36;
  const padRight = 12;
  const padTop = 14;
  const padBottom = 26;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const n = values.length;
  const xAt = (i) => padLeft + (plotW * i) / Math.max(1, n - 1);
  const yAt = (v) => padTop + plotH * (1 - Math.max(0, v) / yMax);
  const path = (arr) => arr.map((v, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`).join(" ");

  const grid = [0, 0.5, 1].map((ratio) => {
    const y = yAt(yMax * ratio);
    return `<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" class="t-grid${ratio === 0 ? " t-baseline" : ""}"></line>` +
      `<text x="${padLeft - 6}" y="${y + 3.5}" text-anchor="end" class="t-axis">${escapeHtml(formatValue(Math.round(yMax * ratio)))}</text>`;
  }).join("");

  const prevPath = prevValues.length === n && n > 1 ? `<path d="${path(prevValues)}" class="t-line-prev"></path>` : "";
  const dots = values.map((v, i) => {
    const label = labels[i];
    const last = i === values.length - 1;
    // last label right-aligns inside the viewBox so long dates never clip
    const anchor = last ? "end" : "middle";
    const lx = last ? width - 1 : xAt(i);
    const prev = prevValues[i];
    const tip = Number.isFinite(prev)
      ? t("web.teams.daily.tipActivePrev", { day: label.title, n: v, prev })
      : t("web.teams.daily.tipActive", { day: label.title, n: v });
    return `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(v).toFixed(1)}" r="2.6" class="t-dot" data-tip="${escapeHtml(tip)}"></circle>` +
      (label.text ? `<text x="${lx.toFixed(1)}" y="${height - 8}" text-anchor="${anchor}" class="t-axis">${escapeHtml(label.text)}</text>` : "");
  }).join("");

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img">${grid}${prevPath}<path d="${path(values)}" class="t-line"></path>${dots}</svg>`;
}

function renderDailyActive() {
  const { analysis } = state;
  const { org } = analysis;
  const days = org.daily.map((item) => item.day);
  const values = org.daily.map((item) => item.active);
  const prevValues = (org.prevDaily || []).map((item) => item.active);
  const yMax = Math.max(4, ...values, ...prevValues);
  const labels = days.map((day, index) => ({
    text: dayLabel(day, index, days.length),
    title: shortDay(day)
  }));
  document.querySelector("#teams-daily-active").innerHTML = lineChartSvg({ values, prevValues, labels, yMax, formatValue: (v) => String(v) });
}

function renderDailyTokens() {
  const { analysis } = state;
  const { org } = analysis;
  const days = org.daily.map((item) => item.day);
  const values = org.daily.map((item) => item.tokens);
  const rawMax = Math.max(1, ...values);
  // round the scale up to 2 significant digits so the 0/mid/max ticks stay
  // mentally rounding-friendly (e.g. 1253万 window reads as 650万 of 1300万)
  const mag = 10 ** Math.floor(Math.log10(rawMax));
  const max = Math.ceil(rawMax / (mag / 10)) * (mag / 10);
  const width = 640;
  const height = 220;
  // compact-token labels ("6.77万") are wider than people counts; size the
  // left gutter from the longest tick so it never clips at the svg edge
  const padLeft = Math.max(36, ...[max, max / 2].map((v) => fmtTokens(v).length * 6.2 + 12));
  const padRight = 12;
  const padTop = 14;
  const padBottom = 26;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const n = values.length;
  const slot = plotW / n;
  const barW = Math.max(3, slot * 0.62);

  const grid = [0, 0.5, 1].map((ratio) => {
    const y = padTop + plotH * (1 - ratio);
    return `<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" class="t-grid${ratio === 0 ? " t-baseline" : ""}"></line>` +
      `<text x="${padLeft - 6}" y="${y + 3.5}" text-anchor="end" class="t-axis">${escapeHtml(fmtTokens(max * ratio))}</text>`;
  }).join("");

  const windowTotal = values.reduce((sum, item) => sum + item, 0);

  const bars = values.map((v, i) => {
    const x = padLeft + slot * i + (slot - barW) / 2;
    const h = (v / max) * plotH;
    const y = padTop + plotH - h;
    const text = dayLabel(days[i], i, n);
    const tip = t("web.teams.daily.tipTokens", {
      day: shortDay(days[i]),
      tokens: fmtTokens(v),
      pct: windowTotal ? Math.round((v / windowTotal) * 100) : 0
    });
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(v > 0 ? 1 : 0, h).toFixed(1)}" rx="2" class="t-bar" data-tip="${escapeHtml(tip)}"></rect>` +
      (text ? `<text x="${(padLeft + slot * i + slot / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle" class="t-axis">${escapeHtml(text)}</text>` : "");
  }).join("");

  document.querySelector("#teams-daily-tokens").innerHTML =
    `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img">${grid}${bars}</svg>`;
}

function renderCompare() {
  const { analysis } = state;
  const sorted = [...analysis.teams].sort((a, b) => a.deltaActive - b.deltaActive || b.tokens - a.tokens);
  const orgTokens = sorted.reduce((sum, team) => sum + team.tokens, 0);
  const rows = sorted.map((team) => {
    const size = Math.max(1, team.memberCount);
    const bar = (value, cls) => `<div class="tc-track"><i class="${cls}" style="width:${(value / size) * 100}%"></i></div>`;
    const share = orgTokens ? Math.round((team.tokens / orgTokens) * 100) : 0;
    return `
      <div class="teams-compare-row" data-team-jump="${escapeHtml(team.id)}" role="button" tabindex="0">
        <div class="tc-label"><b>${escapeHtml(team.name)}</b><span>${escapeHtml(t("web.teams.compare.members", { n: team.memberCount }))}</span></div>
        <div class="tc-bars">
          <div class="tc-line"><span class="tc-name" data-dyn-i18n="web.teams.compare.prev"></span>${bar(team.prevActive, "is-prev")}<span class="tc-count">${team.prevActive} / ${team.memberCount}</span></div>
          <div class="tc-line"><span class="tc-name" data-dyn-i18n="web.teams.compare.cur"></span>${bar(team.active, "is-cur")}<span class="tc-count"><b>${team.active}</b> / ${team.memberCount}</span><b class="tc-delta ${team.deltaActive > 0 ? "is-up" : team.deltaActive < 0 ? "is-down" : "is-flat"}" title="${escapeHtml(t("web.teams.compare.members", { n: team.memberCount }))}">${escapeHtml(signedDelta(team.deltaActive))}</b></div>
        </div>
        <div class="tc-side">
          <span class="tc-tokens">${escapeHtml(fmtTokens(team.tokens))}</span>
          <span class="tc-share" title="${escapeHtml(t("web.teams.compare.shareOfTeams"))}">${share}%</span>
        </div>
      </div>`;
  }).join("");
  document.querySelector("#teams-compare").innerHTML = `
    <div class="card-head">
      <span class="section-kicker" data-i18n="web.teams.compare.kicker">差异 · 团队</span>
      <h2 data-i18n="web.teams.compare.title">变化发生在哪些团队？</h2>
      <span class="meta" data-i18n="web.teams.compare.note">条长 = 团队内有使用人数占比 · 点击查看团队明细</span>
    </div>
    <p class="teams-compare-caption"><span data-dyn-i18n="web.teams.compare.prev"></span> ${escapeHtml(analysis.range.prevFrom)} ~ ${escapeHtml(analysis.range.prevTo)} · <span data-dyn-i18n="web.teams.compare.cur"></span> ${escapeHtml(analysis.range.from)} ~ ${escapeHtml(analysis.range.to)}</p>
    ${rows}`;
  updateDynamicTranslations(document.querySelector("#teams-compare"));
}

function kindChip(kind) {
  return `<span class="teams-kind is-${kind}" data-dyn-i18n="web.teams.kind.${kind}"></span>`;
}

function renderTeams() {
  const { analysis } = state;
  const host = document.querySelector("#teams-teams");
  host.innerHTML = analysis.teams.map((team) => teamCardHtml(team)).join("");
  updateDynamicTranslations(host);
}

function teamCardHtml(team) {
  const size = Math.max(1, team.memberCount);
  const pausedCount = team.members.filter((m) => m.kind === "paused").length;
  const newCount = team.members.filter((m) => m.kind === "new").length;
  const tokenDelta = team.prevTokens > 0
    ? { pct: Math.round(((team.tokens - team.prevTokens) / team.prevTokens) * 100), cls: team.tokens >= team.prevTokens ? "is-up" : "is-down" }
    : team.tokens > 0 ? { pct: null, cls: "is-up" } : { pct: null, cls: "is-flat" };
  const tokenDeltaHtml = tokenDelta.pct === null
    ? (team.tokens > 0 ? `<span class="teams-tokens-delta is-up" data-dyn-i18n="web.teams.team.newUsage"></span>` : "")
    : `<span class="teams-tokens-delta ${tokenDelta.cls}">${escapeHtml(signedDelta(tokenDelta.pct))}%</span>`;

  const maxDaily = Math.max(1, ...team.daily.map((d) => d.tokens));
  const n = team.daily.length;
  const bars = team.daily.map((d, i) => {
    const text = dayLabel(d.day, i, n);
    return `<span class="teams-bar" data-tip="${escapeHtml(t("web.teams.team.tipDayTokens", { day: shortDay(d.day), tokens: fmtTokens(d.tokens) }))}"><i style="height:${Math.max(d.tokens > 0 ? 2 : 0, (d.tokens / maxDaily) * 100).toFixed(1)}%"></i><em>${escapeHtml(text)}</em></span>`;
  }).join("");

  const toolTotal = Math.max(1, team.tools.reduce((sum, item) => sum + item.tokens, 0));
  const toolRows = team.tools.map((item) => `
    <tr>
      <td>${escapeHtml(toolDisplayName(item.tool))}</td>
      <td class="num">${escapeHtml(t("web.teams.team.toolUsers", { n: item.users }))}</td>
      <td class="num">${escapeHtml(fmtTokens(item.tokens))}</td>
      <td class="num teams-tool-share"><span class="teams-share-track"><i style="width:${(item.tokens / toolTotal) * 100}%"></i></span>${Math.round((item.tokens / toolTotal) * 100)}%</td>
    </tr>`).join("");

  const comboChips = team.combos.slice(0, 3).map((combo) => {
    const label = combo.label.split(" + ").map(toolDisplayName).join(" + ");
    return `<span class="teams-combo-chip">${escapeHtml(label)}<b>${combo.count}</b></span>`;
  }).join("");
  const comboLine = team.multiToolUsers > 0
    ? `<p class="teams-combos">${escapeHtml(t("web.teams.team.multiTool", { n: team.multiToolUsers }))}${comboChips}</p>`
    : "";

  // stable reading order across cards: active members first, inactive after
  const activeMembers = team.members.filter((m) => m.kind !== "paused" && m.kind !== "absent");
  const inactiveMembers = team.members.filter((m) => m.kind === "paused" || m.kind === "absent");
  const maxMemberTokens = Math.max(1, ...team.members.map((m) => m.tokens));
  const toolsSep = getCurrentLang().startsWith("zh") ? "、" : ", ";
  const memberRows = [];
  for (const [groupMembers, group] of [[activeMembers, "active"], [inactiveMembers, "inactive"]]) {
    if (!groupMembers.length) continue;
    memberRows.push(`<tr class="teams-group"><td colspan="5">${escapeHtml(t(group === "inactive" ? "web.teams.team.groupInactive" : "web.teams.team.groupActive"))} · ${escapeHtml(t("web.teams.team.groupCount", { n: groupMembers.length }))}</td></tr>`);
    for (const member of groupMembers) {
      const toolsText = member.tools.length ? member.tools.map((tool) => toolDisplayName(tool)).join(toolsSep) : "—";
      const open = state.expanded.has(`${team.id}:${member.participantId}`);
      const evidence = open ? memberEvidenceHtml(member) : "";
      const barWidth = member.tokens > 0 ? Math.max(3, (member.tokens / maxMemberTokens) * 100) : 0;
      memberRows.push(`
      <tr class="teams-member-row${member.activeDays === 0 ? " is-inactive" : ""}" data-member-toggle="${escapeHtml(team.id)}:${escapeHtml(member.participantId)}" tabindex="0" aria-expanded="${open}">
        <td><a class="teams-member-name" href="/profile.html?id=${encodeURIComponent(member.participantId)}&mode=admin" target="_blank" rel="noopener" title="${escapeHtml(t("web.teams.team.memberProfile"))}">${escapeHtml(member.nickname)}</a>${kindChip(member.kind)}</td>
        <td class="num">${member.prevActiveDays} / ${state.days}</td>
        <td class="num"><b>${member.activeDays}</b> / ${state.days}</td>
        <td class="num"><span class="teams-token-num">${escapeHtml(fmtTokens(member.tokens))}</span><span class="teams-token-bar"><i style="width:${barWidth.toFixed(1)}%"></i></span></td>
        <td class="teams-member-tools">${escapeHtml(toolsText)}</td>
      </tr>
      ${open ? `<tr class="teams-evidence-row"><td colspan="5">${evidence}</td></tr>` : ""}`);
    }
  }

  return `
    <article class="card teams-team" id="team-${escapeHtml(team.id)}">
      <div class="teams-team-head">
        <div class="card-head">
          <span class="section-kicker">${escapeHtml(t("web.teams.team.kicker", { n: team.memberCount }))}</span>
          <h2>${escapeHtml(team.name)}</h2>
        </div>
        <div class="teams-team-metrics">
          <div class="tm-item"><small data-dyn-i18n="web.teams.team.telActive"></small><strong>${team.active}<i> / ${team.memberCount}</i></strong></div>
          <div class="tm-item"><small data-dyn-i18n="web.teams.team.telPaused"></small><strong>${pausedCount}</strong></div>
          <div class="tm-item"><small data-dyn-i18n="web.teams.team.telNew"></small><strong>${newCount}</strong></div>
          <div class="tm-item"><small data-dyn-i18n="web.teams.team.tokens"></small><strong class="mono">${escapeHtml(fmtTokens(team.tokens))}</strong>${tokenDeltaHtml}</div>
          <div class="tm-item" title="${escapeHtml(t("web.teams.team.perCapitaTip"))}"><small data-dyn-i18n="web.teams.team.perCapita"></small><strong class="mono">${escapeHtml(fmtTokens(team.active ? team.tokens / team.active : 0))}</strong></div>
          <div class="tm-item"><small data-dyn-i18n="web.teams.team.cost"></small><strong class="cost-amount">${escapeHtml(formatCost(team.costUsd))}</strong></div>
        </div>
      </div>
      <div class="teams-team-cohort">
        <div class="teams-cohort-strip small"><span class="seg steady" style="width:${(team.steady / size) * 100}%"></span><span class="seg light" style="width:${(team.light / size) * 100}%"></span><span class="seg none" style="width:${(team.none / size) * 100}%"></span></div>
        ${[["steady", team.steady], ["light", team.light], ["none", team.none]].filter(([, n]) => n > 0).map(([cls, n]) => `<span class="teams-cohort-mini"><i class="is-${cls}"></i>${n}</span>`).join("")}
      </div>
      <div class="teams-bars">${bars}</div>
      <div class="teams-team-body">
        <div class="teams-tools">
          <h3 data-dyn-i18n="web.teams.team.toolsTitle"></h3>
          <div class="table-wrap"><table>
            <thead><tr><th data-dyn-i18n="web.teams.team.colTool"></th><th data-dyn-i18n="web.teams.team.colUsers"></th><th class="num" data-dyn-i18n="web.teams.team.colTokens"></th><th class="num" data-dyn-i18n="web.teams.team.colShare"></th></tr></thead>
            <tbody>${toolRows || `<tr><td colspan="4" class="teams-table-empty" data-dyn-i18n="web.teams.team.noTools"></td></tr>`}</tbody>
          </table></div>
          ${comboLine}
        </div>
        <div class="teams-members">
          <h3 data-dyn-i18n="web.teams.team.membersTitle"></h3>
          <p class="teams-members-note" data-dyn-i18n="web.teams.team.membersNote"></p>
          <div class="table-wrap"><table class="teams-member-table">
            <thead><tr><th data-dyn-i18n="web.teams.team.colMember"></th><th class="num" data-dyn-i18n="web.teams.team.colPrevDays"></th><th class="num" data-dyn-i18n="web.teams.team.colDays"></th><th class="num" data-dyn-i18n="web.teams.team.colTokens"></th><th data-dyn-i18n="web.teams.team.colTools"></th></tr></thead>
            <tbody>${memberRows.join("")}</tbody>
          </table></div>
        </div>
      </div>
    </article>`;
}

function memberEvidenceHtml(member) {
  const max = Math.max(1, ...member.daily.map((d) => d.tokens));
  const bars = member.daily.map((d, i) => {
    const text = dayLabel(d.day, i, member.daily.length);
    return `<span class="teams-bar evidence" data-tip="${escapeHtml(t("web.teams.team.tipDayTokens", { day: shortDay(d.day), tokens: fmtTokens(d.tokens) }))}"><i style="height:${Math.max(d.tokens > 0 ? 2 : 0, (d.tokens / max) * 100).toFixed(1)}%"></i><em>${escapeHtml(text)}</em></span>`;
  }).join("");
  return `<div class="teams-evidence">
    <div class="teams-bars evidence">${bars}</div>
    <p class="teams-evidence-meta">${escapeHtml(t("web.teams.team.lastSync", { time: member.lastSyncedAt ? member.lastSyncedAt.slice(0, 16).replace("T", " ") : "-" }))}</p>
  </div>`;
}

function filteredParticipants() {
  const { management } = state;
  const keyword = state.search.trim().toLowerCase();
  return management.participants
    .filter((item) => {
      if (state.manageFilter === "untagged") return !item.teamId;
      if (state.manageFilter === "tagged") return Boolean(item.teamId);
      return true;
    })
    .filter((item) => !keyword || item.nickname.toLowerCase().includes(keyword) || item.participantId.toLowerCase().includes(keyword));
}

function updateAssignBar(batchText) {
  const count = document.querySelector("#teams-assign-count");
  if (count) count.textContent = batchText || t("web.teams.manage.selectedCount", { n: state.selected.size });
  const idle = !state.batchBusy && state.selected.size === 0;
  document.querySelectorAll("[data-assign-team], [data-assign-remove], #teams-select-all, #teams-clear-selection").forEach((btn) => {
    btn.disabled = state.batchBusy || idle;
  });
}

function renderMembersPanel() {
  const host = document.querySelector("#teams-members-panel-host");
  if (!host) return;
  const { management } = state;
  const team = management.teams.find((item) => item.id === state.membersViewTeamId) || null;
  if (!team) {
    host.innerHTML = "";
    return;
  }
  const members = management.participants.filter((item) => item.teamId === team.id);
  const chips = members.map((item) =>
    `<button type="button" class="teams-person is-tagged${state.selected.has(item.participantId) ? " is-selected" : ""}" data-person="${escapeHtml(item.participantId)}">${escapeHtml(item.nickname)}</button>`
  ).join("") || `<p class="teams-manage-empty" data-i18n="web.teams.manage.noMembers"></p>`;
  host.innerHTML = `
    <div class="teams-members-panel" role="region" aria-label="${escapeHtml(team.name)}">
      <div class="teams-members-panel-head">
        <b>${escapeHtml(team.name)}</b>
        <span class="teams-members-panel-count">${escapeHtml(t("web.teams.manage.teamCount", { n: team.memberCount }))}</span>
        <button type="button" class="teams-chip-action" data-panel-jump="${escapeHtml(team.id)}" data-i18n="web.teams.manage.jumpToBoard"></button>
        <button type="button" class="teams-chip-action is-danger" data-panel-close data-i18n="web.teams.manage.closePanel"></button>
      </div>
      <p class="teams-members-panel-hint" data-i18n="web.teams.manage.membersPanelHint"></p>
      <div class="teams-people-cloud is-panel">${chips}</div>
    </div>`;
  updateDynamicTranslations(host);
}

function renderManage() {
  const { management } = state;
  if (state.membersViewTeamId && !management.teams.some((team) => team.id === state.membersViewTeamId)) {
    state.membersViewTeamId = null;
  }
  const listEl = document.querySelector("#teams-manage-list");
  listEl.innerHTML = management.teams.map((team) => `
    <div class="teams-chip" data-team-id="${escapeHtml(team.id)}">
      <span class="teams-chip-name">${escapeHtml(team.name)}</span>
      <span class="teams-chip-count">${escapeHtml(t("web.teams.manage.teamCount", { n: team.memberCount }))}</span>
      <button type="button" class="teams-chip-action${state.membersViewTeamId === team.id ? " is-active" : ""}" data-chip-members="${escapeHtml(team.id)}" aria-expanded="${state.membersViewTeamId === team.id}" data-i18n="web.teams.manage.viewMembers"></button>
      <button type="button" class="teams-chip-action" data-chip-rename="${escapeHtml(team.id)}" data-i18n="web.teams.manage.rename"></button>
      <button type="button" class="teams-chip-action is-danger" data-chip-delete="${escapeHtml(team.id)}" data-i18n="web.teams.manage.delete"></button>
    </div>`).join("") || `<p class="teams-manage-empty" data-i18n="web.teams.manage.noTeams"></p>`;
  updateDynamicTranslations(listEl);
  renderMembersPanel();

  const assignHost = document.querySelector("#teams-assign-team-buttons");
  assignHost.innerHTML = management.teams.map((team) =>
    `<button type="button" class="teams-assign-team" data-assign-team="${escapeHtml(team.id)}">${escapeHtml(team.name)}</button>`
  ).join("") + `<button type="button" class="teams-assign-team is-remove" data-assign-remove data-i18n="web.teams.manage.removeTeam"></button>`;
  updateDynamicTranslations(assignHost);

  const rows = filteredParticipants();
  const cloud = document.querySelector("#teams-people-cloud");
  cloud.innerHTML = rows.map((item) => {
    const selected = state.selected.has(item.participantId);
    return `<button type="button" class="teams-person${selected ? " is-selected" : ""}${item.teamId ? " is-tagged" : ""}" data-person="${escapeHtml(item.participantId)}">${escapeHtml(item.nickname)}</button>`;
  }).join("") || `<p class="teams-manage-empty" data-i18n="web.teams.manage.noMatch"></p>`;
  updateDynamicTranslations(cloud);

  const countEl = document.querySelector("#teams-manage-count");
  if (countEl) countEl.textContent = t("web.teams.manage.count", { shown: rows.length, total: management.participants.length });
  updateAssignBar();
}

// batch-assign (teamId set) or unassign (teamId empty) every selected person;
// sequential requests keep the remote MySQL write path gentle
async function assignSelected(teamId) {
  const { management } = state;
  if (!management || state.batchBusy) return;
  const ids = [...state.selected].filter((pid) => {
    const row = management.participants.find((item) => item.participantId === pid);
    return row && row.teamId !== teamId;
  });
  if (!ids.length) {
    state.selected.clear();
    renderManage();
    return;
  }
  state.batchBusy = true;
  updateAssignBar(t("web.teams.manage.batchBusy", { done: 0, total: ids.length }));
  let failed = 0;
  for (let i = 0; i < ids.length; i++) {
    updateAssignBar(t("web.teams.manage.batchBusy", { done: i, total: ids.length }));
    const row = management.participants.find((item) => item.participantId === ids[i]);
    try {
      if (teamId) {
        await api(`/api/admin/teams/${encodeURIComponent(teamId)}/members`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ participantId: ids[i] }) });
      } else if (row?.teamId) {
        await api(`/api/admin/teams/${encodeURIComponent(row.teamId)}/members/${encodeURIComponent(ids[i])}`, { method: "DELETE" });
      }
    } catch (error) {
      failed += 1;
    }
  }
  state.batchBusy = false;
  state.selected.clear();
  await loadAll();
  if (failed) showManageStatus(t("web.teams.manage.actionFailed", { message: `${failed}` }));
}

function setManageOpen(open) {
  const wasOpen = state.manageOpen;
  state.manageOpen = open;
  manageEl.hidden = !open;
  const toggle = document.querySelector("#teams-manage-toggle");
  toggle.setAttribute("aria-expanded", String(open));
  toggle.classList.toggle("is-open", open);
  toggle.textContent = t(open ? "web.teams.manage.close" : "web.teams.manage.toggle");
  if (open) document.querySelector("#teams-manage").scrollIntoView({ behavior: "smooth", block: "start" });
  else if (wasOpen) toggle.scrollIntoView({ behavior: "smooth", block: "center" });
}

function setManageFilter(value) {
  state.manageFilter = value;
  document.querySelectorAll("#teams-manage-filter button").forEach((item) => {
    item.classList.toggle("active", item.dataset.value === value);
  });
  renderManage();
}

function bindEvents() {
  document.querySelectorAll("[data-filter='teams-range'] button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-filter='teams-range'] button").forEach((item) => item.classList.remove("active"));
      btn.classList.add("active");
      state.days = Number(btn.dataset.value) || 7;
      state.expanded.clear();
      loadAll();
    });
  });

  document.querySelectorAll("#teams-manage-filter button").forEach((btn) => {
    btn.addEventListener("click", () => setManageFilter(btn.dataset.value));
  });

  document.querySelector("#teams-manage-toggle").addEventListener("click", () => setManageOpen(!state.manageOpen));

  const createForm = document.querySelector("#teams-create-form");
  const createInput = document.querySelector("#teams-create-name");
  const createButton = createForm.querySelector("button[type=submit]");
  const createError = document.querySelector("#teams-create-error");
  const showCreateError = (message) => {
    if (!createError) return;
    createError.hidden = !message;
    createError.textContent = message || "";
  };
  const setCreateBusy = (busy) => {
    createButton.disabled = busy;
    createButton.textContent = t(busy ? "web.teams.manage.creating" : "web.teams.manage.create");
    createInput.disabled = busy;
  };
  createInput.addEventListener("input", () => showCreateError(""));
  setCreateBusy(false);
  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = createInput.value.trim();
    if (!name) {
      showCreateError(t("web.teams.manage.nameRequired"));
      createInput.focus();
      return;
    }
    if (createButton.disabled) return;
    showCreateError("");
    setCreateBusy(true);
    setLoading(true);
    try {
      await api("/api/admin/teams", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      createInput.value = "";
      await loadAll();
    } catch (error) {
      showCreateError(error.message);
    } finally {
      setCreateBusy(false);
      setLoading(false);
    }
  });

  document.querySelector("#teams-member-search").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderManage();
  });

  const defsToggle = document.querySelector("#teams-defs-toggle");
  defsToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const pop = document.querySelector("#teams-defs-pop");
    const open = pop.hidden;
    pop.hidden = !open;
    defsToggle.setAttribute("aria-expanded", String(open));
  });

  document.addEventListener("click", async (event) => {
    const defsPop = document.querySelector("#teams-defs-pop");
    if (defsPop && !defsPop.hidden && !event.target.closest("#teams-defs-pop, #teams-defs-toggle")) {
      defsPop.hidden = true;
      defsToggle.setAttribute("aria-expanded", "false");
    }
    const person = event.target.closest("[data-person]");
    if (person) {
      if (state.batchBusy) return;
      const pid = person.dataset.person;
      if (state.selected.has(pid)) state.selected.delete(pid);
      else state.selected.add(pid);
      // the same member renders in the people cloud and (when open) the team
      // members panel; keep every chip for this pid in sync
      document.querySelectorAll(`[data-person="${CSS.escape(pid)}"]`).forEach((el) => {
        el.classList.toggle("is-selected", state.selected.has(pid));
      });
      updateAssignBar();
      return;
    }
    const assignTeam = event.target.closest("[data-assign-team]");
    if (assignTeam) {
      await assignSelected(assignTeam.dataset.assignTeam);
      return;
    }
    if (event.target.closest("[data-assign-remove]")) {
      await assignSelected("");
      return;
    }
    if (event.target.closest("#teams-select-all")) {
      filteredParticipants().forEach((item) => state.selected.add(item.participantId));
      renderManage();
      return;
    }
    if (event.target.closest("#teams-clear-selection")) {
      state.selected.clear();
      renderManage();
      return;
    }
    const membersBtn = event.target.closest("[data-chip-members]");
    if (membersBtn) {
      const teamId = membersBtn.dataset.chipMembers;
      state.membersViewTeamId = state.membersViewTeamId === teamId ? null : teamId;
      renderManage();
      return;
    }
    const panelJump = event.target.closest("[data-panel-jump]");
    if (panelJump) {
      setManageOpen(false);
      jumpToTeam(panelJump.dataset.panelJump);
      return;
    }
    if (event.target.closest("[data-panel-close]")) {
      state.membersViewTeamId = null;
      renderManage();
      return;
    }
    const renameBtn = event.target.closest("[data-chip-rename]");
    if (renameBtn) {
      startChipRename(renameBtn.closest(".teams-chip"));
      return;
    }
    const deleteBtn = event.target.closest("[data-chip-delete]");
    if (deleteBtn) {
      const teamId = deleteBtn.dataset.chipDelete;
      // two-step confirm: first click arms the button, second click deletes
      if (state.armedDelete !== teamId) {
        state.armedDelete = teamId;
        deleteBtn.classList.add("is-armed");
        deleteBtn.textContent = t("web.teams.manage.confirmDelete");
        clearTimeout(state.armedDeleteTimer);
        state.armedDeleteTimer = setTimeout(() => {
          state.armedDelete = null;
          renderManage();
        }, 4000);
        return;
      }
      state.armedDelete = null;
      clearTimeout(state.armedDeleteTimer);
      deleteBtn.disabled = true;
      setLoading(true);
      try {
        await api(`/api/admin/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" });
        await loadAll();
      } catch (error) {
        showManageStatus(t("web.teams.manage.actionFailed", { message: error.message }));
        await loadAll();
      } finally {
        setLoading(false);
      }
      return;
    }
    const jump = event.target.closest("[data-team-jump]");
    if (jump) {
      jumpToTeam(jump.dataset.teamJump);
      return;
    }
    const memberToggle = event.target.closest("[data-member-toggle]");
    if (memberToggle && !event.target.closest("a, button")) {
      const key = memberToggle.dataset.memberToggle;
      if (state.expanded.has(key)) state.expanded.delete(key);
      else state.expanded.add(key);
      renderTeams();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const defsPop = document.querySelector("#teams-defs-pop");
      if (defsPop && !defsPop.hidden) {
        defsPop.hidden = true;
        document.querySelector("#teams-defs-toggle")?.setAttribute("aria-expanded", "false");
        return;
      }
      if (state.membersViewTeamId) {
        state.membersViewTeamId = null;
        renderManage();
        return;
      }
      if (state.selected.size && !event.target.closest("input")) {
        state.selected.clear();
        renderManage();
      }
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    // native controls keep their own keyboard behavior (Enter on the member
    // link must open the profile, not toggle the row)
    if (event.target.closest("a, button, select, input, textarea")) return;
    const memberToggle = event.target.closest?.("[data-member-toggle]");
    if (memberToggle) {
      event.preventDefault();
      memberToggle.click();
    }
    const jump = event.target.closest?.("[data-team-jump]");
    if (jump) {
      event.preventDefault();
      jump.click();
    }
  });
}

function startChipRename(chip) {
  const teamId = chip.dataset.teamId;
  const nameEl = chip.querySelector(".teams-chip-name");
  const current = nameEl.textContent;
  chip.classList.add("is-renaming");
  nameEl.innerHTML = `<input class="teams-chip-input" value="${escapeHtml(current)}" maxlength="48" aria-label="${escapeHtml(t("web.teams.manage.namePlaceholder"))}" /><button type="button" class="teams-chip-action" data-chip-save="${escapeHtml(teamId)}" data-dyn-i18n="web.teams.manage.save"></button>`;
  updateDynamicTranslations(chip);
  const input = chip.querySelector(".teams-chip-input");
  input.focus();
  input.select();
  input.addEventListener("keydown", async (event) => {
    if (event.key === "Escape") {
      renderManage();
    } else if (event.key === "Enter") {
      event.preventDefault();
      await saveChipRename(teamId, input.value);
    }
  });
  chip.querySelector("[data-chip-save]").addEventListener("click", () => saveChipRename(teamId, chip.querySelector(".teams-chip-input").value));
}

async function saveChipRename(teamId, name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  const chip = document.querySelector(`.teams-chip[data-team-id="${teamId}"]`);
  const saveBtn = chip?.querySelector("[data-chip-save]");
  if (saveBtn) saveBtn.disabled = true;
  setLoading(true);
  try {
    await api(`/api/admin/teams/${encodeURIComponent(teamId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed })
    });
    await loadAll();
  } catch (error) {
    showManageStatus(t("web.teams.manage.actionFailed", { message: error.message }));
    await loadAll();
  } finally {
    setLoading(false);
  }
}

const langContainer = document.querySelector("#lang-switcher-container");
if (langContainer) {
  mountLangSwitcher(langContainer, () => {
    if (state.analysis) renderAll();
    setManageOpen(state.manageOpen);
  });
}

bindEvents();
setManageOpen(false);
loadAll();
