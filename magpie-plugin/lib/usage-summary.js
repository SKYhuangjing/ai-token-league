// Day-level usage summary for the plugin's usage page. This is a DISPLAY
// view over the full gateway ledger (every agent, regardless of the
// magpie_local upload toggle) — same measurement point as what gets
// uploaded, never Magpie's synthesized UI numbers.
import { localDayAndHour } from "./atl.js";
import { mapAgent, rowTokenTotal } from "./ledger.js";

const isCountable = (row) =>
  row &&
  typeof row === "object" &&
  row.kind !== "model_list" &&
  row.kind !== "provider_test" &&
  row.source !== "probe" &&
  rowTokenTotal(row) > 0;

// failures count toward 请求/失败 even when they carry no tokens (the
// native Requests page counts them too); rejected rows never arrive here
const isFailure = (row) => Number(row && row.status) >= 400;
const rowCost = (row) => (Number.isFinite(Number(row && row.cost)) ? Number(row.cost) : 0);

/**
 * Aggregates ledger rows into per-day entries:
 *   { day, total, input, output, cacheRead, cacheWrite, reasoning,
 *     sources: { providerId: total }, models: { model: total } }
 * Days are capped to the newest `maxDays` (default 90) to keep the page
 * payload small.
 */
export function summarizeRows(rows, { timeZone, now = new Date(), maxDays = 90 } = {}) {
  const byDay = new Map();
  const todayDay = localDayAndHour(now, timeZone).day;
  const todayHours = new Array(24).fill(0);
  const todayHoursBySource = Array.from({ length: 24 }, () => ({}));
  const todayHoursByModel = Array.from({ length: 24 }, () => ({}));
  const todayHoursMeta = Array.from({ length: 24 }, () => ({ sources: {}, models: {} }));
  for (const row of rows) {
    const date = new Date(row.t);
    if (Number.isNaN(date.getTime())) continue;
    const { day, hour } = localDayAndHour(date, timeZone);
    if (day > todayDay) continue; // clock-skew guard, same as upload path
    let entry = byDay.get(day);
    if (!entry) {
      entry = {
        day,
        total: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        calls: 0,
        errors: 0,
        cost: 0,
        sources: {},
        models: {}
      };
      byDay.set(day, entry);
    }
    const providerId = mapAgent(row.agent).providerId;
    const model = String(row.req || row.model || row.served || `${row.provider || "unknown"}/other`).toLowerCase();

    const srcAgg = entry.sources[providerId] || (entry.sources[providerId] = {
      t: 0, c: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, errors: 0
    });
    const modelAgg = entry.models[model] || (entry.models[model] = {
      t: 0, c: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, errors: 0
    });

    const failed = isFailure(row);
    const countable = isCountable(row);
    // every real call counts toward 请求/失败, token-less failures included
    if (countable || failed) {
      entry.calls += 1;
      srcAgg.c += 1;
      modelAgg.c += 1;
    }
    if (failed) {
      entry.errors += 1;
      srcAgg.errors += 1;
      modelAgg.errors += 1;
    }

    if (day === todayDay) {
      const hSrc = todayHoursMeta[hour].sources[providerId] || (todayHoursMeta[hour].sources[providerId] = { t: 0, c: 0, cost: 0, errors: 0 });
      const hMdl = todayHoursMeta[hour].models[model] || (todayHoursMeta[hour].models[model] = { t: 0, c: 0, cost: 0, errors: 0 });
      if (countable || failed) {
        hSrc.c += 1;
        hMdl.c += 1;
      }
      if (failed) {
        hSrc.errors += 1;
        hMdl.errors += 1;
      }
    }

    if (!countable) continue;
    const inT = Number(row.in) || 0;
    const outT = Number(row.out) || 0;
    const crT = Number(row.cache_read) || 0;
    const cwT = Number(row.cache_write) || 0;
    const rowTotal = inT + outT + crT + cwT;
    const costT = rowCost(row);
    entry.total += rowTotal;
    entry.input += inT;
    entry.output += outT;
    entry.cacheRead += crT;
    entry.cacheWrite += cwT;
    entry.reasoning += Number(row.reasoning) || 0;
    entry.cost += costT;

    if (day === todayDay) {
      todayHours[hour] += rowTotal;
      todayHoursBySource[hour][providerId] = (todayHoursBySource[hour][providerId] || 0) + rowTotal;
      todayHoursByModel[hour][model] = (todayHoursByModel[hour][model] || 0) + rowTotal;
      todayHoursMeta[hour].sources[providerId].t += rowTotal;
      todayHoursMeta[hour].sources[providerId].cost += costT;
      todayHoursMeta[hour].models[model].t += rowTotal;
      todayHoursMeta[hour].models[model].cost += costT;
    }

    srcAgg.t += rowTotal;
    srcAgg.input += inT;
    srcAgg.output += outT;
    srcAgg.cacheRead += crT;
    srcAgg.cacheWrite += cwT;
    srcAgg.cost += costT;

    modelAgg.t += rowTotal;
    modelAgg.input += inT;
    modelAgg.output += outT;
    modelAgg.cacheRead += crT;
    modelAgg.cacheWrite += cwT;
    modelAgg.cost += costT;
  }
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-maxDays);
  return { generatedAt: now.toISOString(), today: todayDay, todayHours, todayHoursBySource, todayHoursByModel, todayHoursMeta, days };
}

/** Range view over the summary: last `count` calendar days ending today (0 = all). */
export function rangeView(summary, count = 0, today = summary.today) {
  const days = count > 0 ? summary.days.filter((d) => d.day > shiftDay(today, -count)) : summary.days;
  const totals = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0, errors: 0, cost: 0 };
  const sources = {};
  const models = {};
  const mergeAgg = (into, key, value) => {
    const agg = into[key] || (into[key] = {
      t: 0, c: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, errors: 0
    });
    agg.t += value.t;
    agg.c += value.c;
    agg.cost += value.cost;
    agg.input += (value.input || 0);
    agg.output += (value.output || 0);
    agg.cacheRead += (value.cacheRead || 0);
    agg.cacheWrite += (value.cacheWrite || 0);
    agg.errors += (value.errors || 0);
  };
  for (const day of days) {
    // a bridge file written before calls/cost existed must not paint NaN
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    totals.total += num(day.total);
    totals.input += num(day.input);
    totals.output += num(day.output);
    totals.cacheRead += num(day.cacheRead);
    totals.cacheWrite += num(day.cacheWrite);
    totals.reasoning += num(day.reasoning);
    totals.calls += num(day.calls);
    totals.errors += num(day.errors);
    totals.cost += num(day.cost);
    // flat numeric maps (pre-multi-dimension payload) merge as tokens-only
    const asAgg = (v) => (v && typeof v === "object" ? {
      t: num(v.t),
      c: num(v.c),
      cost: num(v.cost),
      input: num(v.input),
      output: num(v.output),
      cacheRead: num(v.cacheRead),
      cacheWrite: num(v.cacheWrite),
      errors: num(v.errors)
    } : { t: num(v), c: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, errors: 0 });
    for (const [key, value] of Object.entries(day.sources)) mergeAgg(sources, key, asAgg(value));
    for (const [key, value] of Object.entries(day.models)) mergeAgg(models, key, asAgg(value));
  }
  return { days, totals, sources, models };
}

/** YYYY-MM-DD minus n days (UTC-safe string math on the day axis). */
export function shiftDay(day, delta) {
  const [y, m, d] = String(day || "").split("-").map(Number);
  if (!y || !m || !d) return day;
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** Top-N entries of a {name: value} map, descending. */
export function topEntries(map, limit = 5) {
  return Object.entries(map)
    .sort((a, b) => (b[1]?.t ?? b[1]) - (a[1]?.t ?? a[1]))
    .slice(0, limit);
}

// mergeSummaries overlays a windowed read onto the cached full-history
// summary: history is immutable, so days outside the window keep their
// cached values and the window's days replace theirs; today/hourly fields
// come from the fresh read. Keeps the page's 全部 range and 53-week heatmap
// fed without re-reading all history every sync.
export function mergeSummaries(cached, recent, { maxDays = 380 } = {}) {
  if (!cached) return recent;
  if (!recent) return cached;
  const byDay = new Map(cached.days.map((d) => [d.day, d]));
  for (const d of recent.days) byDay.set(d.day, d);
  const days = [...byDay.values()]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .slice(-maxDays);
  return { ...recent, days };
}
