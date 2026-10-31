/**
 * IntelliJ's `DateFormatUtil.formatPrettyDate` / `formatPrettyDateTime`, honouring
 * Settings › Date Formats: "Moments ago", "N minutes ago" within the hour, "Today" /
 * "Yesterday" (with the time for `prettyDateTime`), else the date. With pretty
 * formatting off, the plain date (and time).
 */
import { dateFormatOptions, formatClock, formatDay, type DateFormatOptions } from "@/platform/dateFormat";
import { tx } from "@/platform/i18n";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function pretty(ms: number, withTime: boolean, now: number, o: DateFormatOptions): string {
  const d = new Date(ms);
  const time = withTime ? ` ${formatClock(d, o)}` : "";
  if (o.pretty) {
    const delta = now - ms;
    const today = new Date(now);
    if (d.toDateString() === today.toDateString()) {
      if (delta >= 0 && delta < MINUTE) return tx("Moments ago");
      if (delta >= 0 && delta <= HOUR) {
        const n = Math.floor(delta / MINUTE);
        return n === 1 ? tx("1 minute ago") : tx`${n} minutes ago`;
      }
      return withTime ? tx`Today ${formatClock(d, o)}` : tx("Today");
    }
    if (d.toDateString() === new Date(now - 86_400_000).toDateString())
      return withTime ? tx`Yesterday ${formatClock(d, o)}` : tx("Yesterday");
  }
  return `${formatDay(d, o)}${time}`;
}

const toMs = (date: string | number | Date) =>
  typeof date === "number" ? date : date instanceof Date ? date.getTime() : Date.parse(date);

/** `formatPrettyDate`: list rows ("created {date}"). Empty for an invalid date. */
export function prettyDate(date: string | number | Date, now = Date.now(), o = dateFormatOptions()): string {
  const ms = toMs(date);
  return Number.isNaN(ms) ? "" : pretty(ms, false, now, o);
}

/** `formatPrettyDateTime`: timeline headers, commits, replies. */
export function prettyDateTime(date: string | number | Date, now = Date.now(), o = dateFormatOptions()): string {
  const ms = toMs(date);
  return Number.isNaN(ms) ? "" : pretty(ms, true, now, o);
}
