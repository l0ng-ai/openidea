/**
 * GitHub-style relative dates: "just now", "N minutes ago", "N hours ago",
 * "yesterday", "N days ago", then "on Oct 12" (with the year when it differs).
 * With Settings › Date Formats › pretty formatting off, the plain date and time.
 */
import {
  dateFormatOptions,
  formatClock,
  formatDay,
  formatPattern,
  type DateFormatOptions,
} from "@/platform/dateFormat";
import { tx } from "@/platform/i18n";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function onDay(d: Date, now: number, o: DateFormatOptions): string {
  if (o.overrideSystem) return tx`on ${formatPattern(d, o.pattern)}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const day = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return tx`on ${day}`;
}

const toMs = (date: string | number | Date) =>
  typeof date === "number" ? date : date instanceof Date ? date.getTime() : Date.parse(date);

/** List rows, timeline headers, commits and replies. Empty for an invalid date. */
export function prettyDate(date: string | number | Date, now = Date.now(), o = dateFormatOptions()): string {
  const ms = toMs(date);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  if (!o.pretty) return `${formatDay(d, o)} ${formatClock(d, o)}`;
  const delta = Math.max(0, now - ms);
  if (delta < MINUTE) return tx("just now");
  if (delta < HOUR) {
    const n = Math.floor(delta / MINUTE);
    return n === 1 ? tx("1 minute ago") : tx`${n} minutes ago`;
  }
  if (delta < DAY) {
    const n = Math.floor(delta / HOUR);
    return n === 1 ? tx("1 hour ago") : tx`${n} hours ago`;
  }
  const days = Math.floor(delta / DAY);
  if (days === 1) return tx("yesterday");
  if (days < 30) return tx`${days} days ago`;
  return onDay(d, now, o);
}

/** The full date and time, for a tooltip on a relative date. */
export function fullDateTime(date: string | number | Date, o = dateFormatOptions()): string {
  const ms = toMs(date);
  return Number.isNaN(ms) ? "" : `${formatDay(new Date(ms), o)} ${formatClock(new Date(ms), o)}`;
}
