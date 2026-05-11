import { localDay } from "../shared/date.js";

export function businessTimeZone() {
  return process.env.APP_TIME_ZONE || process.env.TZ || "Asia/Shanghai";
}

export function currentBusinessDay(value = new Date()) {
  const forced = process.env.AI_TOKEN_LEAGUE_BUSINESS_DAY || "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(forced)) return forced;
  return localDay(value, businessTimeZone());
}
