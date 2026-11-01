// Page wiring, v3: i18n (host language via magpie.ready/onTheme), seg
// thumbs, data polling (script-injection bridge — the page sandbox has no
// network), the board card, the sync-chip, toasts, and settings via
// magpie.options. Copy table lives here; view.js renders from it.
(async function () {
  "use strict";

  const T = {
    "zh": {
      title: "AI Token League", usage: "用量", settings: "设置",
      today: "今日", d7: "近 7 天", d30: "近 30 天", all: "全部",
      chipSynced: "同步 {time}", chipJustNow: "刚刚同步", chipSyncing: "同步中 {done}/{total} 批",
      chipFailed: "同步失败", chipNever: "尚未同步",
      boardLabel: "总榜战况", rankNone: "未上榜",
      streakDays: "连续 {n} 天", streakActive: "累计 {days} 天", streakPeak: "峰值 {d} {t}",
      rankNeverTip: "尚未同步到云端", rankStaleTip: "云端暂不可达，显示 {time} 的结果",
      openBoard: "打开榜单",
      kTotal: "总量", kCache: "缓存读取", kRequests: "请求", kCost: "费用",
      kTotalSub: "输入 {a} · 输出 {b} · 缓存 {c}", kYda: "昨日 {tokens}",
      kTotalTip: "排名口径：总量 = 输入 + 输出 + 缓存读 + 缓存写",
      kCacheSub: "命中 {p}",
      kCacheTip: "命中率 = 缓存读取 ÷（缓存读取 + 输入 + 缓存写入），即提示词中来自缓存的部分。缓存写入 {n}",
      kReqOk: "全部成功", kReqFail: "失败 {n}", kReqTip: "失败：本口径下请求未成功返回",
      kCostSub: "按当前单价估算", kCostTip: "按最新生效的模型牌价估算的费用，仅展示用，不参与排名",
      trend: "趋势", mTokens: "Token", mCalls: "请求", mCost: "费用",
      splitBy: "按", splitSource: "来源", splitModel: "模型",
      grainHour: "按小时 · 来源", grainDay: "按日", timesUnit: "次", tokensUnit: "tokens",
      heat: "活跃热力图", heatSub: "53 周 · 按日", less: "少", more: "多",
      heatNone: "无用量",
      scopeNote: "口径:Magpie 统一读数(网关 + 本地会话)· 本页数据本地生成",
      emptyToday: "今天还没有用量", emptyAll: "还没有用量数据",
      emptyBody: "通过 Magpie 的用量会自动出现在这里",
      emptyCta: "去设置",
      importBtn: "导入", exportBtn: "导出",
      importHint: "导入 ATL「导出配置」的 JSON;导出同格式，可导入其他 Magpie 或 ATL。",
      importQueued: "已提交，同步后生效", importBadFile: "这不是有效的 ATL 导出文件",
      importReadFail: "文件读取失败", exportQueued: "导出中，见 Downloads",
      cfgTitle: "配置", cfgApi: "服务端地址",
      cfgNick: "昵称", cfgNickHint: "改名下次同步生效",
      cfgSince: "起始日期", cfgSinceHint: "留空为全部历史",
      cfgFreq: "同步频率", f5: "5 分钟", f15: "15 分钟", f30: "30 分钟", f60: "1 小时",
      cfgFreqTip: "定期补同步的间隔；网关有请求时也会即时触发（≥1 分钟节流）",
      save: "保存", saved: "已保存", test: "测试连接",
      privacyHint: "隐私:仅上报 token 数与模型名,账号、会话、响应 ID 不离开本机。",
      heatSubTip: "最近 53 周 · 按日 tokens", exportBtnTip: "导出同格式，可导入其他 Magpie 或 ATL",
      aliasLabel: "匿名名称", aliasTip: "匿名榜单今日展示的名称，每日轮换",
      syncTitle: "同步", lastResult: "上次结果", dataSource: "数据源", syncStats: "同步统计",
      server: "服务端", lastExport: "最近导出",
      syncNow: "立即同步", syncNowBusy: "同步中…",
      syncNowTip: "Ed25519 签名小时桶，服务端整桶覆盖幂等",
      syncing: "同步中", batchUnit: "批", ok: "成功", noop: "无变化", err: "失败",
      neverSynced: "尚未同步",
      uploadedSummary: "上传 {buckets} 桶 / {tokens} tokens", noopSummary: "已最新({buckets} 桶)",
      totalBuckets: "累计 {buckets} 桶", firstSync: "首次同步",
      sourceCsv: "CSV · 全史", sourceApi: "API · 7 天", sourceLedger: "账本 · 仅网关",
      idSourceStore: "本机存储", idSourceMigrate: "迁移文件导入", idSourceAdopt: "继承 ATL 客户端",
      idSourceFresh: "全新创建", idSourceRenamed: "本机存储(已改名)",
      justNow: "刚刚", relMin: "{n} 分钟前", relHour: "{n} 小时前", relDay: "{n} 天前",
      toastCmdSent: "已发送", noMagpie: "请在 Magpie 插件面板中打开"
    },
    "en": {
      title: "AI Token League", usage: "Usage", settings: "Settings",
      today: "Today", d7: "7 days", d30: "30 days", all: "All",
      chipSynced: "Synced {time}", chipJustNow: "Synced just now", chipSyncing: "Syncing {done}/{total}",
      chipFailed: "Sync failed", chipNever: "Never synced",
      boardLabel: "League standing", rankNone: "not ranked yet",
      streakDays: "{n}-day streak", streakActive: "{days} days active", streakPeak: "peak {d} {t}",
      rankNeverTip: "not synced to the board yet", rankStaleTip: "board unreachable — showing result from {time}",
      openBoard: "Open board",
      kTotal: "Total tokens", kCache: "Cache read", kRequests: "Requests", kCost: "Cost",
      kTotalSub: "{a} in · {b} out · {c} cache", kYda: "yesterday {tokens}",
      kTotalTip: "Board metric: input + output + cache read + cache write",
      kCacheSub: "hit rate {p}",
      kCacheTip: "Hit rate = cache read ÷ (cache read + input + cache write): the share of the prompt served from cache. Cache written {n}",
      kReqOk: "none failed", kReqFail: "{n} failed", kReqTip: "Failed: requests that did not return successfully",
      kCostSub: "at current prices", kCostTip: "Estimated with the latest effective model prices; display only, never ranked",
      trend: "Trend", mTokens: "Tokens", mCalls: "Requests", mCost: "Cost",
      splitBy: "by", splitSource: "Source", splitModel: "Model",
      grainHour: "hourly · by source", grainDay: "daily", timesUnit: "calls", tokensUnit: "tokens",
      heat: "Activity heatmap", heatSub: "53 weeks · daily", less: "Less", more: "More",
      heatNone: "no usage",
      scopeNote: "Scope: Magpie's unified readings (gateway + local sessions) · computed locally",
      emptyToday: "No usage today yet", emptyAll: "No usage yet",
      emptyBody: "Usage routed through Magpie appears here automatically",
      emptyCta: "Open settings",
      importBtn: "Import", exportBtn: "Export",
      importHint: "Import the JSON from ATL's Export Config; the export uses the same shape.",
      importQueued: "Submitted — applies on next sync", importBadFile: "Not a valid ATL export file",
      importReadFail: "Could not read the file", exportQueued: "Exporting — see Downloads",
      cfgTitle: "Configuration", cfgApi: "API base URL",
      cfgNick: "Nickname", cfgNickHint: "renames apply on next sync",
      cfgSince: "Start date", cfgSinceHint: "empty = full history",
      cfgFreq: "Sync interval", f5: "5 min", f15: "15 min", f30: "30 min", f60: "1 h",
      cfgFreqTip: "Catch-up cadence; gateway activity also triggers a sync (1-min throttle)",
      save: "Save", saved: "Saved", test: "Test connection",
      privacyHint: "Only token counts and model names leave this machine",
      heatSubTip: "Last 53 weeks · daily tokens", exportBtnTip: "Same shape — importable into other Magpie installs or ATL",
      aliasLabel: "Board alias", aliasTip: "Your name on the anonymous board today — rotates daily",
      syncTitle: "Sync", lastResult: "Last run", dataSource: "Data source", syncStats: "Sync stats",
      server: "Server", lastExport: "Last export",
      syncNow: "Sync now", syncNowBusy: "Syncing…",
      syncNowTip: "Ed25519-signed hourly buckets, idempotent replace on the server",
      syncing: "syncing", batchUnit: "batches", ok: "ok", noop: "no change", err: "error",
      neverSynced: "Never synced",
      uploadedSummary: "uploaded {buckets} buckets / {tokens} tokens", noopSummary: "up to date ({buckets} buckets)",
      totalBuckets: "{buckets} buckets total", firstSync: "First sync",
      sourceCsv: "CSV · full history", sourceApi: "API · 7d", sourceLedger: "Ledger · gateway only",
      idSourceStore: "local store", idSourceMigrate: "migration file", idSourceAdopt: "adopted from ATL client",
      idSourceFresh: "freshly created", idSourceRenamed: "local store (renamed)",
      justNow: "just now", relMin: "{n} min ago", relHour: "{n} h ago", relDay: "{n} d ago",
      toastCmdSent: "Sent", noMagpie: "Open inside the Magpie plugin panel"
    }
  };
  // Host language: magpie.ready resolves to the theme object (carries lang);
  // navigator.language is only the pre-bridge fallback (webviews often report en).
  let lang = (navigator.language || "zh-CN").toLowerCase().startsWith("zh") ? "zh" : "en";
  let t = T[lang];
  const locale = () => (lang === "zh" ? "zh-CN" : "en");

  const applyI18n = () => {
    document.title = t.title;
    document.documentElement.lang = lang === "zh" ? "zh" : "en";
    for (const el of document.querySelectorAll("[data-t]")) {
      const key = el.getAttribute("data-t");
      if (t[key]) el.textContent = t[key];
    }
    const board = document.getElementById("board");
    if (board) board.setAttribute("aria-label", t.boardLabel);
    // explanatory copy lives in titles, never on the page surface
    for (const [id, key] of [
      ["f-nickname", "cfgNickHint"], ["f-since", "cfgSinceHint"],
      ["h-privacy", "privacyHint"], ["heat-sub", "heatSubTip"],
      ["b-import", "importHint"], ["b-export", "exportBtnTip"]
    ]) {
      const el = document.getElementById(id);
      if (el && t[key]) el.title = t[key];
    }
  };
  applyI18n();
  // view.js rebuilds KPI nodes and rank rows; let it re-apply i18n / repaint
  window.__ATLApplyI18n = applyI18n;

  const $ = (id) => document.getElementById(id);
  const hasMagpie = () => typeof window.magpie === "object" && window.magpie !== null;

  // ── toast (bottom-right, 4s, one at a time; commands never write the chip) ──
  let toastTimer = null;
  function toast(text, isErr) {
    const node = $("toast");
    if (!node) return;
    node.textContent = text;
    node.className = "toast" + (isErr ? " err" : "");
    node.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
  }

  // ── segmented controls (thumb slides like the built-in pages) ──
  function moveThumb(seg) {
    const on = seg.querySelector(".opt.on");
    const thumb = seg.querySelector(".thumb");
    if (!on || !thumb) return;
    thumb.style.left = on.offsetLeft + "px";
    thumb.style.width = on.offsetWidth + "px";
  }
  function segInit(seg, onClick) {
    if (!seg) return;
    const opts = [...seg.querySelectorAll(".opt")];
    for (const btn of opts) {
      btn.classList.toggle("on", btn.getAttribute("aria-selected") === "true");
      btn.addEventListener("click", () => {
        for (const b of opts) {
          const active = b === btn;
          b.classList.toggle("on", active);
          b.setAttribute("aria-selected", String(active));
        }
        moveThumb(seg);
        onClick(btn);
      });
    }
    requestAnimationFrame(() => moveThumb(seg));
  }

  // ── views / periods / metric / split ──
  let currentView = "usage";
  let currentRange = 1;
  let currentMetric = "tokens";
  let currentSplit = "source";

  // An optimistic identity (import submit / nickname save) must SURVIVE the
  // 4s bridge poll: status.js still carries the old identity until the sync
  // process writes the new one, and a bare re-read would flip the name back
  // mid-flight. The override yields only when the bridge catches up, the
  // sync fails, or it expires.
  let pendingIdentity = null;
  function adoptPending(fields) {
    pendingIdentity = { at: Date.now(), ...fields };
    render();
  }
  function effectiveStatus() {
    const s = window.__ATL_SYNC_STATUS__ || null;
    const p = pendingIdentity;
    if (!p) return s;
    const caughtUp = s && (!p.participantId || s.participantId === p.participantId)
      && (!p.nickname || s.nickname === p.nickname);
    const failed = s && s.ok === false && !(s.syncing && s.syncing.total);
    if (caughtUp || failed || Date.now() - p.at > 5 * 60 * 1000) {
      pendingIdentity = null;
      return s;
    }
    return { ...(s || {}), ...p };
  }

  function render() {
    const usage = window.__ATL_USAGE_DATA__;
    const status = effectiveStatus();
    // Magpie's chineseUnits display setting rides the status bridge (absent
    // = its default OFF = the B/M/K ladder); numbers must match the host app
    if (window.ATLView) window.ATLView.chineseUnits = status?.chineseUnits === true;
    if (!usage) {
      // skeleton until the first bridge payload lands (never "—" numbers)
      ATLView.renderSkeleton();
    } else {
      ATLView.render(usage, currentRange, t, locale(), { metric: currentMetric, split: currentSplit });
    }
    ATLView.renderBoard(status, t, locale());
    ATLView.renderStatus(status, t, locale());
    // sync button busy state follows the live status
    const bSync = $("b-sync");
    if (bSync) {
      const busy = !!(status && status.syncing && status.syncing.total);
      bSync.disabled = busy;
      bSync.textContent = busy ? t.syncNowBusy : t.syncNow;
      bSync.title = t.syncNowTip;
    }
  }
  window.__ATLRepaint = render;

  function applyRangeVisibility() {
    // today has no hourly-by-model series: the split segs hide, #grain says so
    const split = $("splitby");
    if (split) {
      if (currentRange === 1) split.setAttribute("data-off", "");
      else split.removeAttribute("data-off");
    }
  }

  segInit($("views"), (btn) => {
    currentView = btn.dataset.view;
    $("view-usage").hidden = currentView !== "usage";
    $("view-settings").hidden = currentView !== "settings";
    $("periods").hidden = currentView !== "usage";
    if (currentView === "usage") {
      ATLView.invalidate();
      render();
    }
  });
  segInit($("periods"), (btn) => {
    currentRange = Number(btn.dataset.range);
    applyRangeVisibility();
    ATLView.invalidate();
    render();
  });
  segInit($("metric"), (btn) => {
    currentMetric = btn.dataset.metric;
    ATLView.invalidate();
    render();
  });
  segInit($("splitby"), (btn) => {
    currentSplit = btn.dataset.split;
    ATLView.invalidate();
    render();
  });
  // sync interval applies instantly — a cadence pick is not a form draft
  const freqLabel = $("freq-label");
  if (freqLabel) freqLabel.title = t.cfgFreqTip;
  segInit($("freq"), (btn) => {
    setOptions({ syncIntervalMinutes: Number(btn.dataset.interval) });
  });
  applyRangeVisibility();
  window.addEventListener("resize", () => {
    moveThumb($("views"));
    moveThumb($("periods"));
    moveThumb($("metric"));
    moveThumb($("splitby"));
    // the chart is measured-then-drawn: a resize must re-measure it, and the
    // render signature alone would skip that (same data, new width)
    ATLView.invalidate();
    render();
  });

  // the chip is the one status affordance and a jump target on failure
  const chip = $("sync-chip");
  if (chip) chip.addEventListener("click", () => {
    const views = $("views");
    const settingsBtn = views && views.querySelector('[data-view="settings"]');
    if (settingsBtn) settingsBtn.click();
    const syncCard = $("b-sync") && $("b-sync").closest(".card");
    if (syncCard) syncCard.scrollIntoView({ block: "center" });
  });

  // ── data bridge ──
  // The page sandbox blocks network requests; the sync process writes
  // status.js / usage-data.js next to this page and we load them as scripts.
  // Cache-busting alternates between two spellings of the SAME file (plain vs
  // one percent-encoded character): the panel file server may reject query
  // strings, and a bare repeated URL would serve a stale cached copy.
  let pollFlip = 0;
  function loadBridge(file) {
    const encoded = pollFlip % 2 === 0 ? file : file.replace(/^u/, "%75");
    const old = document.getElementById("bridge-" + file);
    if (old) old.remove();
    const script = document.createElement("script");
    script.id = "bridge-" + file;
    script.src = "./" + encoded;
    script.onerror = () => { /* not written yet */ };
    document.head.appendChild(script);
  }
  // settings form state: filled-once-from-status latch + user-edit dirty flag
  const formState = { dirty: false, filled: false };
  function poll() {
    pollFlip += 1;
    loadBridge("status.js");
    loadBridge("usage-data.js");
    render();
    // The form initializes before the first status.js lands (script loads
    // are async); when it does arrive carrying the effective apiBaseUrl,
    // re-fill the form once — unless the user is already typing in it.
    if (!formState.filled && !formState.dirty && window.__ATL_SYNC_STATUS__ && window.__ATL_SYNC_STATUS__.apiBaseUrl) {
      formState.filled = true;
      loadForm();
    }
  }
  poll();
  setInterval(poll, 4000);
  // the repaint is signature-skipped in ATLView.render: cheap, and a refresh
  // that changed nothing moves nothing (hover states survive)
  setInterval(render, 1500);

  // ── settings ──
  // The form must show the EFFECTIVE config, never the marketing default:
  // status.js carries the apiBaseUrl the Bun side actually merged
  // (config.json + options + CLI), so a page that never saved options
  // still opens with the server that is really in use. Falling back to
  // the default URL here would let one 保存配置 click silently repoint
  // the sync at another server.
  for (const id of ["f-api", "f-nickname", "f-since"]) {
    const el = $(id);
    if (el) el.addEventListener(el.type === "checkbox" ? "change" : "input", () => { formState.dirty = true; });
  }
  function loadForm() {
    const effective = effectiveStatus() || {};
    const fallbackApi = effective.apiBaseUrl || "http://ai-token-league.dev.1datatm.info";
    const setFreqSeg = (minutes) => {
      const seg = $("freq");
      if (!seg) return;
      const want = String(Number(minutes) || 15);
      for (const b of seg.querySelectorAll(".opt")) {
        const active = b.dataset.interval === want;
        b.classList.toggle("on", active);
        b.setAttribute("aria-selected", String(active));
      }
      moveThumb(seg);
    };
    if (!hasMagpie() || !window.magpie.options || !window.magpie.options.get) {
      $("f-api").value = fallbackApi;
      $("f-nickname").value = effective.nickname || "";
      setFreqSeg(15);
      return;
    }
    Promise.resolve(window.magpie.options.get()).then((options) => {
      options = options || {};
      knownOptions = options;
      $("f-api").value = options.apiBaseUrl || fallbackApi;
      // nicknameSet is one-shot (already consumed): the live identity name
      // from status is the form's truth
      $("f-nickname").value = effective.nickname || "";
      $("f-since").value = options.sinceDay || "";
      setFreqSeg(options.syncIntervalMinutes);
    }).catch(() => {
      $("f-api").value = fallbackApi;
      $("f-nickname").value = effective.nickname || "";
      setFreqSeg(15);
    });
  }

  // The host's options.set REPLACES the whole options map: a bare patch
  // would wipe every sibling key (a 打开榜单 click once erased the saved
  // apiBaseUrl this way). So every write is read-modify-write against the
  // last known full map, and the answer (the new full map) becomes truth.
  let knownOptions = null;
  async function refreshOptions() {
    if (!hasMagpie() || !window.magpie.options || !window.magpie.options.get) return null;
    try {
      knownOptions = (await window.magpie.options.get()) || {};
      return knownOptions;
    } catch {
      return null;
    }
  }
  function setOptions(patch, successText) {
    if (!hasMagpie() || !window.magpie.options || !window.magpie.options.set) {
      toast(t.noMagpie, true);
      return;
    }
    const send = (full) =>
      Promise.resolve(window.magpie.options.set(full))
        .then((answer) => {
          if (answer && typeof answer === "object") knownOptions = answer;
          toast(successText || t.saved);
        })
        .catch((e) => toast(String(e), true));
    if (knownOptions) {
      send({ ...knownOptions, ...patch });
    } else {
      // no known map yet: fetch it first, then merge (never blind-write)
      refreshOptions().then((current) => send({ ...(current || {}), ...patch }));
    }
  }

  $("b-save").addEventListener("click", () => {
    const nickname = $("f-nickname").value.trim();
    setOptions({
      apiBaseUrl: $("f-api").value.trim(),
      // one-shot by design: a standing nickname option would fight an
      // imported identity's own name on every run
      nicknameSet: nickname,
      sinceDay: $("f-since").value || "",
    });
    // optimistic: the new name shows at once and survives polling until
    // status.js confirms it (a stale screenshot must not outlive the click)
    if (nickname && (!window.__ATL_SYNC_STATUS__ || window.__ATL_SYNC_STATUS__.nickname !== nickname)) {
      adoptPending({ nickname });
    }
  });
  function sendCommand(command, queuedText) {
    const nonce = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
    setOptions({ pendingCommand: { command, nonce } }, queuedText || t.toastCmdSent);
  }
  $("b-sync").addEventListener("click", () => sendCommand("syncNow"));
  $("b-test").addEventListener("click", () => sendCommand("testConnection"));
  $("b-export").addEventListener("click", () => sendCommand("exportConfig", t.exportQueued));

  // import: read the picked JSON in-page, shape-check, hand it to the Bun
  // side through options (one write also queues the adopting sync)
  $("b-import").addEventListener("click", () => $("f-import").click());
  $("f-import").addEventListener("change", () => {
    const file = $("f-import").files && $("f-import").files[0];
    $("f-import").value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => toast(t.importReadFail, true);
    reader.onload = () => {
      let payload = null;
      try {
        payload = JSON.parse(String(reader.result));
      } catch {
        payload = null;
      }
      // a dedicated migrate export OR a full ATL config export (设置›导出配置)
      const shaped = payload && typeof payload === "object"
        && typeof payload.participantId === "string" && payload.participantId.startsWith("p_")
        && typeof payload.deviceId === "string" && payload.deviceId.startsWith("d_")
        && typeof payload.identityPublicKey === "string" && payload.identityPublicKey.includes("BEGIN PUBLIC KEY")
        && typeof payload.identityPrivateKey === "string" && payload.identityPrivateKey.includes("BEGIN PRIVATE KEY");
      if (!shaped) {
        toast(t.importBadFile, true);
        return;
      }
      const nonce = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
      setOptions({ identityImport: payload, pendingCommand: { command: "syncNow", nonce } }, t.importQueued);
      // optimistic: the incoming name/id shows at once and survives polling
      // until the adopting sync's status lands (then it confirms or errors)
      adoptPending({
        nickname: payload.nickname || "",
        participantId: payload.participantId,
        deviceId: payload.deviceId,
        ...(payload.apiBaseUrl ? { apiBaseUrl: payload.apiBaseUrl } : {})
      });
    };
    reader.readAsText(file);
  });
  const openBoard = () => {
    const status = effectiveStatus();
    const base = (status && status.apiBaseUrl) || "http://ai-token-league.dev.1datatm.info";
    const url = base.replace(/\/+$/, "") + "/";
    if (hasMagpie() && window.magpie.options && window.magpie.options.set) {
      // the page frame is sandboxed (no popups): the host opens the browser
      const nonce = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
      setOptions({ pendingCommand: { command: "openBoard", nonce, url } });
    } else {
      window.open(url, "_blank");
    }
  };
  for (const btn of document.querySelectorAll("[data-open-board]")) btn.addEventListener("click", openBoard);

  loadForm();

  // Host language (after all helpers exist): magpie.ready resolves to the
  // theme object carrying lang; onTheme follows live switches.
  try {
    if (hasMagpie()) {
      const theme = await window.magpie.ready;
      if (theme && theme.lang) {
        lang = String(theme.lang).toLowerCase().startsWith("zh") ? "zh" : "en";
        t = T[lang];
        applyI18n();
        ATLView.invalidate();
        render();
        requestAnimationFrame(() => {
          moveThumb($("views"));
          moveThumb($("periods"));
        });
      }
      if (window.magpie.onTheme) {
        window.magpie.onTheme((next) => {
          if (next && next.lang) {
            lang = String(next.lang).toLowerCase().startsWith("zh") ? "zh" : "en";
            t = T[lang];
            applyI18n();
            ATLView.invalidate();
            render();
          }
        });
      }
    }
  } catch {
    // bridge absent (standalone preview) — keep the fallback language
  }
  if (!hasMagpie()) {
    // standalone preview (outside magpie): usage view still works from the
    // bridge files; say once that actions need the real panel
    setTimeout(() => toast(t.noMagpie, true), 800);
  }
})();
