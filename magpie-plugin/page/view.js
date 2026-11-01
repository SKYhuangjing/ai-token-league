// Render helpers for the atl-sync page, v3 (product teardown redesign).
// The chart/heatmap cores stay Magpie-native in spirit (internal/gui/assets
// app.css + plugins/usage/page.js): measured-then-drawn stacked columns,
// 53-week CSS-grid heatmap, locale-compact numbers. v3 changes: the board
// card is the only identity slot, KPIs go 8 → 4 with derivation sublines,
// the rank legend doubles as the split dimension AND a focus filter, plus
// skeleton / empty / syncing / failed states and a sync-chip.
(function () {
  "use strict";

  window.addEventListener("error", (e) => {
    window.__ATL_ERRORS = (window.__ATL_ERRORS || []).concat(String(e && e.message ? e.message : e));
  });

  const ATLView = {};

  const compactCache = new Map();
  function compact(locale) {
    if (!compactCache.has(locale)) {
      compactCache.set(locale, new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }));
    }
    return compactCache.get(locale);
  }

  ATLView.fmtTokens = function (n, locale) {
    if (typeof n !== "number" || !isFinite(n)) return "—";
    return compact(locale || "en").format(n);
  };

  // Magpie's fmtCost: no fake precision, and unknown ≠ $0 — an empty string
  // reads "no price", $0 reads "free".
  ATLView.fmtCost = function (usd) {
    const v = Number(usd);
    if (!Number.isFinite(v)) return "";
    if (v >= 100) return "$" + Math.round(v).toLocaleString("en-US");
    if (v >= 1) return "$" + v.toFixed(2);
    return "$" + v.toFixed(3);
  };

  ATLView.shiftDay = function (day, delta) {
    const parts = String(day).split("-").map(Number);
    if (!parts[0]) return day;
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  };

  ATLView.rangeView = function (summary, count) {
    const days = count > 0 ? summary.days.filter((d) => d.day > ATLView.shiftDay(summary.today, -count)) : summary.days;
    // mirrors lib/usage-summary.js rangeView: multi-metric totals, tolerant of
    // older bridge payloads (flat maps, missing calls/cost)
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const totals = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, errors: 0, cost: 0 };
    const sources = {};
    const models = {};
    const asAgg = (v) => (v && typeof v === "object" ? { t: num(v.t), c: num(v.c), cost: num(v.cost) } : { t: num(v), c: 0, cost: 0 });
    const mergeAgg = (into, key, value) => {
      const agg = into[key] || (into[key] = { t: 0, c: 0, cost: 0 });
      agg.t += value.t;
      agg.c += value.c;
      agg.cost += value.cost;
    };
    for (const day of days) {
      totals.total += num(day.total);
      totals.input += num(day.input);
      totals.output += num(day.output);
      totals.cacheRead += num(day.cacheRead);
      totals.cacheWrite += num(day.cacheWrite);
      totals.calls += num(day.calls);
      totals.errors += num(day.errors);
      totals.cost += num(day.cost);
      for (const [k, v] of Object.entries(day.sources || {})) mergeAgg(sources, k, asAgg(v));
      for (const [k, v] of Object.entries(day.models || {})) mergeAgg(models, k, asAgg(v));
    }
    return { days, totals, sources, models };
  };

  const SOURCE_LABELS = {
    zcode_local: "ZCode",
    claude_code_local: "Claude Code",
    codex_local: "Codex",
    opencode_local: "OpenCode",
    magpie_local: "Magpie",
    kimi_local: "Kimi",
    workbuddy_local: "WorkBuddy",
    dsh_local: "DeepSeek Harness",
    hermes_local: "Hermes"
  };
  function sourceLabel(id) {
    return SOURCE_LABELS[id] || id;
  }

  // Top 7 series keep the built-in page's --c1..--c7; everything else folds
  // into "Other" on --magpie-faint (ledCategories, LED_SHOWN=7).
  const SERIES_VARS = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7"];
  const OTHER_LABEL = { zh: "其他", en: "Other" };

  function buildSeries(points, lang) {
    const order = [];
    const totalsBySource = {};
    for (const p of points) {
      for (const src of Object.keys(p.stacks || {})) {
        if (!totalsBySource[src]) {
          totalsBySource[src] = 0;
          order.push(src);
        }
        totalsBySource[src] += p.stacks[src];
      }
    }
    order.sort((a, b) => totalsBySource[b] - totalsBySource[a]);
    const callsBySource = {};
    for (const p of points) {
      for (const src of Object.keys(p.meta || {})) {
        callsBySource[src] = (callsBySource[src] || 0) + (Number(p.meta[src].c) || 0);
      }
    }
    const shown = order.slice(0, 7).map((src, i) => ({
      key: src,
      label: sourceLabel(src),
      color: `var(${SERIES_VARS[i]})`,
      total: totalsBySource[src],
      calls: callsBySource[src] || 0,
      values: points.map((p) => p.stacks[src] || 0)
    }));
    const rest = order.slice(7);
    if (rest.length) {
      const values = points.map((p) => rest.reduce((sum, src) => sum + (p.stacks[src] || 0), 0));
      shown.push({
        key: "__other__",
        label: OTHER_LABEL[lang] || "Other",
        color: "var(--magpie-faint, var(--magpie-muted))",
        total: values.reduce((a, b) => a + b, 0),
        calls: rest.reduce((sum, src) => sum + (callsBySource[src] || 0), 0),
        values
      });
    }
    return shown;
  }

  // ---- trend chart (measured first, then drawn 1:1 — drawLedColumns) -----

  function renderChart(points, fmt, focusKey) {
    const plot = document.getElementById("chart");
    plot.innerHTML = "";
    const tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    if (!points.length) {
      plot.appendChild(tip);
      return;
    }
    const series = buildSeries(points);
    const W = Math.max(280, Math.floor(plot.clientWidth || 640));
    const H = 236;

    // y max: a friendly step over 4 gridlines
    const max = Math.max(...points.map((p) => p.total), 1);
    const rawStep = max / 4;
    const pow = 10 ** Math.floor(Math.log10(rawStep));
    const step = Math.ceil(rawStep / pow) * pow;
    const yMax = step * 4;
    const t = 8, r = 6, b = 22;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("role", "img");

    // measure the widest axis label first (M.l = widest + 6, min 34)
    let labelW = 34;
    for (let g = 0; g <= 4; g += 1) {
      const probe = document.createElementNS(ns, "text");
      probe.setAttribute("font-size", "10.5");
      probe.textContent = fmt(step * g);
      svg.appendChild(probe);
      labelW = Math.max(labelW, probe.getComputedTextLength() + 6);
      probe.remove();
    }
    const l = labelW;
    const pw = W - l - r;
    const ph = H - t - b;
    const slot = pw / points.length;
    const bw = Math.max(2, Math.min(30, slot * 0.68));

    for (let g = 0; g <= 4; g += 1) {
      const value = step * g;
      const y = t + ph - (value / yMax) * ph;
      const grid = document.createElementNS(ns, "line");
      grid.setAttribute("x1", l);
      grid.setAttribute("x2", W - r);
      grid.setAttribute("y1", y.toFixed(1));
      grid.setAttribute("y2", y.toFixed(1));
      grid.setAttribute("stroke", "var(--line-2)");
      grid.setAttribute("stroke-width", "1");
      grid.setAttribute("stroke-dasharray", g === 0 ? "none" : "2 3");
      svg.appendChild(grid);
      const label = document.createElementNS(ns, "text");
      label.setAttribute("x", l - 6);
      label.setAttribute("y", (y + 3.5).toFixed(1));
      label.setAttribute("font-size", "10.5");
      label.setAttribute("fill", "var(--magpie-muted)");
      label.setAttribute("text-anchor", "end");
      label.textContent = fmt(value);
      svg.appendChild(label);
    }

    // column highlights live UNDER the bars (a soft band behind them, the
    // built-in page's rect.hot) — on top they would paint the column away
    const hots = points.map((_, i) => {
      const hot = document.createElementNS(ns, "rect");
      hot.setAttribute("x", (l + i * slot).toFixed(1));
      hot.setAttribute("y", t);
      hot.setAttribute("width", Math.ceil(slot).toFixed(1));
      hot.setAttribute("height", ph);
      hot.setAttribute("fill", "var(--pill)");
      hot.setAttribute("rx", "3");
      hot.style.display = "none";
      hot.style.pointerEvents = "none";
      svg.appendChild(hot);
      return hot;
    });

    // each source's segments share one <g class="bar"> so a legend click can
    // dim every other source at once (rank-as-filter)
    const groups = new Map(series.map((s) => [s.key, document.createElementNS(ns, "g")]));
    for (const g of groups.values()) g.setAttribute("class", "bar");
    points.forEach((point, i) => {
      let acc = 0;
      for (const s of series) {
        const v = s.values[i];
        if (!v) continue;
        const hTop = (v / yMax) * ph;
        const hBottom = (acc / yMax) * ph;
        const rect = document.createElementNS(ns, "rect");
        rect.setAttribute("x", (l + i * slot + (slot - bw) / 2).toFixed(1));
        rect.setAttribute("y", (t + ph - hTop - hBottom).toFixed(1));
        rect.setAttribute("width", bw.toFixed(1));
        rect.setAttribute("height", Math.max(1, hTop).toFixed(1));
        rect.setAttribute("fill", s.color);
        rect.setAttribute("rx", "1");
        groups.get(s.key).appendChild(rect);
        acc += v;
      }
    });
    for (const s of series) if (groups.get(s.key).childNodes.length) svg.appendChild(groups.get(s.key));
    if (focusKey && groups.has(focusKey)) {
      plot.classList.add("has-focus");
      groups.get(focusKey).classList.add("focus");
    } else {
      plot.classList.remove("has-focus");
    }

    // invisible hit areas on top drive highlight + tooltip
    points.forEach((point, i) => {
      const hit = document.createElementNS(ns, "rect");
      hit.setAttribute("x", (l + i * slot).toFixed(1));
      hit.setAttribute("y", t);
      hit.setAttribute("width", Math.ceil(slot).toFixed(1));
      hit.setAttribute("height", ph);
      hit.setAttribute("fill", "transparent");
      hit.addEventListener("mouseenter", () => {
        hots[i].style.display = "";
        tip.hidden = false;
        tip.replaceChildren();
        const title = document.createElement("div");
        title.textContent = point.label;
        title.style.marginBottom = "3px";
        tip.appendChild(title);
        for (const s of series) {
          const v = s.values[i];
          if (!v) continue;
          const row = document.createElement("div");
          row.className = "tr";
          const dot = document.createElement("i");
          dot.style.background = s.color;
          const name = document.createElement("span");
          name.textContent = s.label;
          const val = document.createElement("b");
          val.textContent = fmt(v);
          row.append(dot, name, val);
          tip.appendChild(row);
        }
        const sum = document.createElement("div");
        sum.className = "sum";
        const sumLabel = document.createElement("span");
        sumLabel.textContent = point.label;
        const sumVal = document.createElement("b");
        sumVal.textContent = fmt(point.total);
        sum.append(sumLabel, sumVal);
        tip.appendChild(sum);
        const x = Math.min(Math.max(l + i * slot - 70, 0), W - 180);
        tip.style.left = x + "px";
      });
      hit.addEventListener("mouseleave", () => {
        hots[i].style.display = "none";
        tip.hidden = true;
      });
      svg.appendChild(hit);
    });

    const every = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(pw / 62))));
    points.forEach((point, i) => {
      if (i % every !== 0) return;
      const text = document.createElementNS(ns, "text");
      text.setAttribute("x", (l + i * slot + slot / 2).toFixed(1));
      text.setAttribute("y", H - 6);
      text.setAttribute("font-size", "10.5");
      text.setAttribute("fill", "var(--magpie-muted)");
      text.setAttribute("text-anchor", "middle");
      text.textContent = point.label;
      svg.appendChild(text);
    });

    plot.append(svg, tip);
  }

  // the rank legend is also the split view AND a focus filter: clicking a row
  // dims every other series in the chart (Magpie's rank rows are click
  // targets too — we have no request list, so focus is the mapping)
  function renderRank(series, fmt, T, focusKey) {
    const legend = document.getElementById("chart-legend");
    legend.innerHTML = "";
    const grand = series.reduce((sum, s) => sum + s.total, 0) || 1;
    for (const s of series) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "rk" + (focusKey === s.key ? " focus" : "");
      const a = document.createElement("div");
      a.className = "rk-a";
      const dot = document.createElement("i");
      dot.style.background = s.color;
      const name = document.createElement("span");
      name.textContent = s.label;
      name.title = s.label;
      const val = document.createElement("b");
      val.textContent = fmt(s.total);
      a.append(dot, name, val);
      const bar = document.createElement("div");
      bar.className = "rk-bar";
      const fill = document.createElement("i");
      fill.style.width = Math.max(2, (s.total / grand) * 100).toFixed(1) + "%";
      fill.style.background = s.color;
      bar.appendChild(fill);
      const sub = document.createElement("div");
      sub.className = "rk-b";
      const sharePct = (s.total / grand) * 100;
      sub.textContent = `${s.calls ? s.calls + " " + T.timesUnit + " · " : ""}${sharePct > 0 && sharePct < 1 ? "<1%" : Math.round(sharePct) + "%"}`;
      row.append(a, bar, sub);
      row.addEventListener("click", () => {
        ATLView.setFocus(focusKey === s.key ? null : s.key);
      });
      legend.appendChild(row);
    }
  }

  // ---- heatmap (CSS grid, 53 weeks, 5 discrete levels — sessLevels) ------

  function quartileLevels(values) {
    const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
    if (nz.length < 8) {
      const max = nz.length ? nz[nz.length - 1] : 0;
      return (v) => (v <= 0 ? 0 : Math.min(4, Math.ceil((4 * v) / max)));
    }
    const q = (p) => nz[Math.min(nz.length - 1, Math.floor(p * (nz.length - 1)))];
    return (v) => {
      if (v <= 0) return 0;
      if (v <= q(0.25)) return 1;
      if (v <= q(0.5)) return 2;
      if (v <= q(0.75)) return 3;
      return 4;
    };
  }

  function renderHeat(summary, lang, locale, T) {
    const grid = document.getElementById("heat");
    const tip = document.getElementById("heat-tip");
    grid.innerHTML = "";
    const byDay = new Map(summary.days.map((d) => [d.day, Number(d.total) || 0]));
    if (!byDay.size) return;

    const today = new Date(summary.today + "T00:00:00Z");
    const dow = (today.getUTCDay() + 6) % 7; // 0 = Monday
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - dow - 52 * 7); // 53 full weeks, Mon-first
    const weeks = Math.ceil((today - start) / 86400000 / 7) + 1;
    grid.style.setProperty("--weeks", String(weeks));

    const levelOf = quartileLevels([...byDay.values()]);
    const monthFmt = new Intl.DateTimeFormat(locale || "en", { month: "short", timeZone: "UTC" });
    const dateFmt = new Intl.DateTimeFormat(locale || "en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    const weekdays = lang === "zh" ? { 0: "一", 2: "三", 4: "五" } : { 0: "Mon", 2: "Wed", 4: "Fri" };

    let lastMonth = -1;
    let lastMoCol = -99;
    for (const [d, label] of Object.entries(weekdays)) {
      const wd = document.createElement("span");
      wd.className = "wd";
      wd.style.gridColumn = "1";
      wd.style.gridRow = String(Number(d) + 2);
      wd.textContent = label;
      grid.appendChild(wd);
    }
    for (let w = 0; w < weeks; w += 1) {
      const monday = new Date(start);
      monday.setUTCDate(start.getUTCDate() + w * 7);
      const m = monday.getUTCMonth();
      if (m !== lastMonth && w - lastMoCol >= 3 && w < weeks - 1) {
        const mo = document.createElement("span");
        mo.className = "mo";
        mo.style.gridColumn = String(w + 2);
        mo.style.gridRow = "1";
        mo.textContent = monthFmt.format(monday);
        grid.appendChild(mo);
        lastMonth = m;
        lastMoCol = w;
      }
      for (let d = 0; d < 7; d += 1) {
        const date = new Date(start);
        date.setUTCDate(start.getUTCDate() + w * 7 + d);
        if (date > today) continue;
        const day = date.toISOString().slice(0, 10);
        const total = byDay.get(day) || 0;
        const cell = document.createElement("i");
        cell.style.gridColumn = String(w + 2);
        cell.style.gridRow = String(d + 2);
        const level = levelOf(total);
        if (level) cell.className = `l${level}`;
        cell.addEventListener("mouseenter", () => {
          tip.hidden = false;
          tip.replaceChildren();
          const b = document.createElement("b");
          b.textContent = dateFmt.format(date);
          const span = document.createElement("span");
          span.style.marginLeft = "8px";
          span.style.color = "var(--magpie-muted)";
          // blind-review P2-1: never a bare number — and an empty day says so
          // instead of showing a lone 0
          span.textContent = total > 0 ? ATLView.fmtTokens(total, locale) + " " + T.tokensUnit : T.heatNone;
          tip.append(b, span);
          const wrap = tip.parentElement.getBoundingClientRect();
          const box = cell.getBoundingClientRect();
          const x = Math.min(Math.max(box.left - wrap.left + box.width / 2 - 60, 0), wrap.width - 130);
          tip.style.left = x + "px";
          tip.style.top = Math.max(0, box.top - wrap.top - 40) + "px";
        });
        cell.addEventListener("mouseleave", () => {
          tip.hidden = true;
        });
        grid.appendChild(cell);
      }
    }
  }

  // ---- skeleton (R6: same shape as the content, never a "—" placeholder) --

  ATLView.renderSkeleton = function () {
    const stats = document.getElementById("stats");
    if (stats && !stats.classList.contains("empty") && !stats.querySelector(".sk")) {
      stats.innerHTML = Array.from({ length: 4 })
        .map(() => '<div class="kpi"><div class="sk sk-num"></div><div class="sk sk-label"></div></div>')
        .join("");
    }
    const chart = document.getElementById("chart");
    if (chart && !chart.firstChild) chart.innerHTML = '<div class="sk sk-plot"></div>';
  };

  // ---- main render ---------------------------------------------------------

  let lastSignature = "";
  let focusKey = null;
  ATLView.invalidate = function () {
    lastSignature = "";
  };
  ATLView.setFocus = function (key) {
    focusKey = key;
    lastSignature = ""; // force a redraw with the new focus
    if (typeof window.__ATLRepaint === "function") window.__ATLRepaint();
  };

  const METRIC_KEYS = { tokens: "t", calls: "c", cost: "cost" };

  // value formatter per metric: compact tokens, plain calls, fmtCost cost
  function metricFmt(metric, locale) {
    if (metric === "cost") return (v) => ATLView.fmtCost(v) || "—";
    if (metric === "calls") return (v) => compact(locale || "en").format(v);
    return (v) => ATLView.fmtTokens(v, locale);
  }

  ATLView.render = function (summary, range, T, locale, dims = {}) {
    const metric = METRIC_KEYS[dims.metric] ? dims.metric : "tokens";
    // today has no hourly-by-model series in the data: today is pinned to
    // hourly·by-source (the split segs hide, #grain says so)
    const split = range === 1 ? "source" : (dims.split === "model" ? "model" : "source");
    const lang = locale && String(locale).toLowerCase().startsWith("zh") ? "zh" : "en";
    const signature = `${locale}|${range}|${metric}|${split}|${focusKey}|${summary ? summary.generatedAt + "|" + summary.days.length + "|" + summary.days.map((d) => d.day + ":" + d.total).join(",") : ""}`;
    if (signature === lastSignature) return; // a refresh that changed nothing moves nothing
    lastSignature = signature;

    const grain = document.getElementById("grain");
    if (grain) grain.textContent = range === 1 ? T.grainHour : T.grainDay;

    // legacy flat payloads (numbers) only ever carry tokens; other metrics read 0
    const pick = (o) => {
      if (o && typeof o === "object") {
        const v = Number(o[METRIC_KEYS[metric]]);
        return Number.isFinite(v) ? v : 0;
      }
      return metric === "tokens" ? (Number(o) || 0) : 0;
    };
    let points;
    if (range === 1) {
      const hours = summary.todayHours || [];
      const bySource = summary.todayHoursBySource || [];
      points = hours.map((value, hour) => ({
        label: String(hour).padStart(2, "0"),
        total: Number(value) || 0,
        stacks: bySource[hour] || {}
      }));
    } else {
      const days = range > 0
        ? summary.days.filter((d) => d.day > ATLView.shiftDay(summary.today, -range))
        : summary.days;
      points = days.map((d) => {
        const agg = split === "model" ? d.models : d.sources;
        const stacks = {};
        let total = 0;
        for (const [m, o] of Object.entries(agg || {})) {
          stacks[m] = pick(o);
          total += pick(o);
        }
        return { label: d.day.slice(5).replace("-", "/"), total, stacks, meta: agg || {} };
      });
    }
    const view = ATLView.rangeView(summary, range);
    const t = view.totals;
    const hasData = summary.days.some((d) => (Number(d.total) || 0) > 0) || (summary.todayHours || []).some((h) => Number(h) > 0);

    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };
    const el = (id) => document.getElementById(id);

    // empty state replaces the whole KPI grid + hides the chart shells (R5)
    const stats = el("stats");
    const trend = el("trend-card");
    const heatCard = el("heat-card");
    if (!hasData) {
      const head = range === 1 ? T.emptyToday : T.emptyAll;
      stats.classList.add("empty");
      stats.innerHTML = `<b>${head}</b><div><button class="btn" type="button" id="empty-cta">${T.emptyCta}</button></div>`;
      const cta = el("empty-cta");
      if (cta) cta.title = T.emptyBody;
      if (cta) cta.addEventListener("click", () => {
        const btn = document.querySelector('#views [data-view="settings"]');
        if (btn) btn.click();
      });
      trend.hidden = true;
      heatCard.hidden = true;
      return;
    }
    stats.classList.remove("empty");
    trend.hidden = false;
    heatCard.hidden = false;
    stats.innerHTML =
      '<div class="kpi"><b id="k-total">—</b><span data-t="kTotal"></span><small id="k-total-s"></small></div>' +
      '<div class="kpi"><b id="k-cache">—</b><span data-t="kCache"></span><small id="k-cache-s"></small></div>' +
      '<div class="kpi"><b id="k-calls">—</b><span data-t="kRequests"></span><small id="k-calls-s"></small></div>' +
      '<div class="kpi"><b id="k-cost" class="cost">—</b><span data-t="kCost"></span><small id="k-cost-s"></small></div>';
    // re-apply static i18n on the rebuilt nodes
    if (typeof window.__ATLApplyI18n === "function") window.__ATLApplyI18n();

    // KPI 1: the league number, with its derivation as the subline
    set("k-total", ATLView.fmtTokens(t.total, locale));
    const kts = el("k-total-s");
    if (kts) {
      kts.title = T.kTotalTip;
      kts.textContent = T.kTotalSub
        .replace("{a}", ATLView.fmtTokens(t.input, locale))
        .replace("{b}", ATLView.fmtTokens(t.output, locale))
        .replace("{c}", ATLView.fmtTokens(t.cacheRead + t.cacheWrite, locale));
    }
    // KPI 2: cache read with the prompt-calibre hit rate (title shows the
    // formula — cacheRead/total names itself wrong)
    set("k-cache", ATLView.fmtTokens(t.cacheRead, locale));
    const kcs = el("k-cache-s");
    if (kcs) {
      const denom = t.cacheRead + t.input + t.cacheWrite;
      const hit = denom ? Math.round((t.cacheRead / denom) * 100) : null;
      kcs.title = T.kCacheTip.replace("{n}", ATLView.fmtTokens(t.cacheWrite, locale));
      kcs.textContent = hit === null ? "" : T.kCacheSub.replace("{p}", hit + "%");
    }
    // KPI 3: requests, failures turn the subline red
    set("k-calls", compact(locale || "en").format(t.calls || 0));
    const krs = el("k-calls-s");
    if (krs) {
      krs.title = T.kReqTip;
      if (t.errors > 0) {
        krs.innerHTML = `<span class="err">${T.kReqFail.replace("{n}", compact(locale || "en").format(t.errors))}</span>`;
      } else {
        krs.textContent = t.calls ? T.kReqOk : "";
      }
    }
    // KPI 4: estimated cost, in magpie's own voice — the amount in green
    // with ≈, and its qualifier ("生效价格/effective prices") as the muted
    // note beside it; unknown reads empty, never a fake $0
    const costText = ATLView.fmtCost(t.cost);
    set("k-cost", costText ? "≈" + costText : "");
    const kcost = el("k-cost-s");
    if (kcost) {
      kcost.title = T.kCostTip;
      kcost.textContent = costText ? T.kCostSub : "";
    }

    const fmtValue = metricFmt(metric, locale);
    renderChart(points, fmtValue, focusKey);
    renderRank(buildSeries(points, lang), fmtValue, T, focusKey);
    renderHeat(summary, lang, locale, T);
  };

  // shared relative time: minutes / hours / days
  ATLView.relTime = function (iso, T) {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return "";
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 1) return T.justNow;
    if (mins < 60) return T.relMin.replace("{n}", String(mins));
    const hours = Math.round(mins / 60);
    if (hours < 24) return T.relHour.replace("{n}", String(hours));
    return T.relDay.replace("{n}", String(Math.round(hours / 24)));
  };

  // sync-chip: the one status affordance — ok/busy/err/never, clickable
  ATLView.renderSyncChip = function (status, T) {
    const chip = document.getElementById("sync-chip");
    if (!chip) return;
    chip.classList.remove("ok", "busy", "err");
    if (status && status.syncing && status.syncing.total) {
      chip.classList.add("busy");
      chip.textContent = T.chipSyncing
        .replace("{done}", String(status.syncing.done || 0))
        .replace("{total}", String(status.syncing.total));
      chip.title = "";
    } else if (status && status.ok === false) {
      chip.classList.add("err");
      chip.textContent = T.chipFailed;
      chip.title = String(status.error || "").slice(0, 80);
    } else if (status && (status.lastSyncAt || status.updatedAt)) {
      chip.classList.add("ok");
      const when = ATLView.relTime(status.lastSyncAt || status.updatedAt, T);
      chip.textContent = when === T.justNow ? T.chipJustNow : T.chipSynced.replace("{time}", when);
      chip.title = "";
    } else {
      chip.textContent = T.chipNever;
      chip.title = "";
    }
  };

  // the board card: identity · rank · cloud-vs-local, with its degrade
  // matrix — hidden whole when no server is configured
  ATLView.renderBoard = function (status, T, locale, localTodayTokens) {
    const board = document.getElementById("board");
    if (!board) return;
    if (!status || !status.apiBaseUrl) {
      board.hidden = true;
      return;
    }
    board.hidden = false;
    const set = (id, value, title) => {
      const node = document.getElementById(id);
      if (node) {
        node.textContent = value;
        if (title !== undefined) node.title = title;
      }
    };
    // the strip is one line: full ids live in titles, never on the surface
    const nickEl = document.getElementById("bd-nick");
    if (nickEl) {
      nickEl.textContent = status.nickname || (status.participantId || "").slice(0, 8) || "—";
      nickEl.title = status.participantId || "";
    }
    // anonymous boards replace the public name with a daily alias (ATL
    // semantics): show it beside the local name; public boards hide it
    const aliasEl = document.getElementById("bd-alias");
    if (aliasEl) {
      const id = status.serverIdentity;
      const name = id && id.identityMode === "anonymous" ? id.displayName : "";
      aliasEl.hidden = !name;
      aliasEl.title = T.aliasTip || "";
      if (name) {
        // Magpie chip language: soft tint of the participant's board color
        aliasEl.style.setProperty("--alias-color", id.avatarColor || "var(--magpie-accent)");
        const dot = document.createElement("i");
        dot.className = "dot";
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = name;
        aliasEl.replaceChildren(dot, nm);
      } else {
        aliasEl.replaceChildren();
      }
    }

    const rank = status.serverRank;
    const rankEl = document.getElementById("bd-rank");
    const countEl = document.getElementById("bd-count");
    const leadEl = document.getElementById("bd-lead");
    const daysEl = document.getElementById("bd-days");
    const stale = !!(rank && rank.fetchedAt && Date.now() - new Date(rank.fetchedAt).getTime() > 86400_000);
    if (!rank || !Number.isFinite(Number(rank.rank))) {
      if (rankEl) {
        rankEl.textContent = T.rankNone;
        rankEl.title = rank && rank.error && rank.fetchedAt
          ? T.rankStaleTip.replace("{time}", ATLView.relTime(rank.fetchedAt, T))
          : T.rankNeverTip;
      }
      if (countEl) countEl.textContent = "";
    } else {
      if (rankEl) {
        rankEl.textContent = "#" + rank.rank;
        rankEl.classList.toggle("stale", stale);
        rankEl.title = stale ? T.rankStaleTip.replace("{time}", ATLView.relTime(rank.fetchedAt, T)) : "";
      }
      if (countEl) countEl.textContent = T.rankOf.replace("{count}", String(rank.participantCount));
    }
    if (leadEl) leadEl.hidden = !(rank && rank.isLeaderToday);
    if (daysEl) {
      const d = rank ? Number(rank.leaderDays) : 0;
      daysEl.textContent = d >= 1 ? (d === 1 ? T.leaderDaysOne : T.leaderDays.replace("{n}", String(d))) : "";
    }

    // cloud today + the one-line health verdict against local
    const cloud = document.getElementById("bd-cloud");
    const cmp = document.getElementById("bd-compare");
    if (rank && Number.isFinite(Number(rank.cloudTodayTokens))) {
      if (cloud) cloud.textContent = ATLView.fmtTokens(rank.cloudTodayTokens, locale);
      if (cmp) {
        if (status.syncing && status.syncing.total) {
          cmp.textContent = T.syncingShort;
          cmp.className = "";
        } else if (Number(localTodayTokens) > 0) {
          const diff = localTodayTokens - rank.cloudTodayTokens;
          if (diff > localTodayTokens * 0.01) {
            cmp.textContent = T.cloudBehind.replace("{tokens}", ATLView.fmtTokens(diff, locale));
            cmp.className = "warn";
          } else {
            cmp.textContent = T.cloudMatch;
            cmp.className = "";
          }
        } else {
          cmp.textContent = "";
          cmp.className = "";
        }
      }
    } else {
      if (cloud) cloud.textContent = "—";
      if (cmp) cmp.textContent = "";
    }
  };

  // settings rows (identity / config / sync cards) + sync button busy state
  ATLView.renderStatus = function (status, T, locale) {
    if (!status) return;
    ATLView.renderSyncChip(status, T);

    const set = (id, value, title) => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = value;
        if (title !== undefined) el.title = title;
      }
    };
    const shortId = status.participantId ? status.participantId.slice(0, 12) + "…" : "—";
    const shortDev = status.deviceId ? status.deviceId.slice(0, 12) + "…" : "—";
    set("s-nick", status.nickname || shortId || "—");
    set("s-pid", shortId, status.participantId || "");
    set("s-device", shortDev, status.deviceId || "");
    const fromMap = {
      store: T.idSourceStore, "migrate-file": T.idSourceMigrate, "adopt-atl": T.idSourceAdopt,
      fresh: T.idSourceFresh, "store-renamed": T.idSourceRenamed
    };
    set("s-source", status.identitySource ? (fromMap[status.identitySource] || status.identitySource) : "—");
    const aliasRow = document.getElementById("s-alias-row");
    const aliasVal = document.getElementById("s-alias");
    if (aliasRow && aliasVal) {
      const id = status.serverIdentity;
      const name = id && id.identityMode === "anonymous" ? id.displayName : "";
      aliasRow.hidden = !name;
      if (name) {
        aliasVal.title = T.aliasTip || "";
        aliasVal.style.color = id.avatarColor || "";
        aliasVal.textContent = name;
        const dot = document.createElement("i");
        dot.className = "alias-dot";
        dot.style.background = id.avatarColor || "var(--magpie-accent)";
        aliasVal.prepend(dot);
      }
    }

    set("s-server", status.apiBaseUrl || "—");
    const last = document.getElementById("s-last");
    if (last) {
      last.replaceChildren();
      if (status.syncing && status.syncing.total) {
        const b = document.createElement("span");
        b.textContent = `${T.syncing} ${status.syncing.done}/${status.syncing.total} ${T.batchUnit}`;
        last.appendChild(b);
      } else if (status.ok === false) {
        const b = document.createElement("span");
        b.className = "err";
        b.textContent = `${T.err}: ${String(status.error || "").slice(0, 80)}`;
        last.appendChild(b);
      } else if (status.lastSyncAt) {
        const when = ATLView.relTime(status.lastSyncAt, T);
        const uploaded = status.noop
          ? T.noopSummary.replace("{buckets}", String(status.buckets ?? "—"))
          : T.uploadedSummary
              .replace("{buckets}", String(status.dirty ?? "—"))
              .replace("{tokens}", ATLView.fmtTokens(status.uploadedTokens || 0, locale));
        const b = document.createElement("span");
        b.className = "ok";
        b.textContent = `${status.noop ? T.noop : T.ok} · ${when} · ${uploaded}`;
        last.appendChild(b);
      } else {
        last.textContent = T.neverSynced;
      }
    }
    const channelMap = { csv: T.sourceCsv, api: T.sourceApi, ledger: T.sourceLedger };
    set("s-channel", status.sourceChannel ? (channelMap[status.sourceChannel] || status.sourceChannel) : "—");
    const chanEl = document.getElementById("s-channel");
    if (chanEl) chanEl.title = T.scopeNote;
    const statsBits = [];
    if (Number.isFinite(Number(status.buckets))) statsBits.push(T.totalBuckets.replace("{buckets}", String(status.buckets)));
    if (status.firstSyncStart) statsBits.push(`${T.firstSync} ${String(status.firstSyncStart).slice(0, 10)}`);
    set("s-stats", statsBits.join(" · ") || "—");
    const exportRow = document.getElementById("s-export-row");
    if (exportRow) exportRow.hidden = !status.lastExport;
    if (status.lastExport) set("s-export", status.lastExport.path || "—");
  };

  window.ATLView = ATLView;
})();
