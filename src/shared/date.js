export function appTimeZone() {
  const envTimeZone = typeof process !== "undefined" ? process.env.APP_TIME_ZONE : "";
  const tz = typeof process !== "undefined" ? process.env.TZ : "";
  return envTimeZone || tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function localDay(value = new Date(), timeZone = appTimeZone()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return localDay(new Date(), timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function dayToUtcDate(day) {
  const [year, month, date] = String(day || "").split("-").map(Number);
  if (!year || !month || !date) return new Date(Date.UTC(1970, 0, 1));
  return new Date(Date.UTC(year, month - 1, date));
}

export function utcDateToDay(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(day, count) {
  const date = dayToUtcDate(day);
  date.setUTCDate(date.getUTCDate() + count);
  return utcDateToDay(date);
}

export function daysBetween(startDay, endDay) {
  const start = dayToUtcDate(startDay);
  const end = dayToUtcDate(endDay);
  if (start > end) return [];
  const days = [];
  for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    days.push(utcDateToDay(date));
  }
  return days;
}
