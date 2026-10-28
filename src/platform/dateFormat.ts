/**
 * Date / time formatting per Settings › System Settings › Date Formats:
 * "Override system date and time format" (pattern + 24-hour time) and
 * "Use pretty formatting" (Today / Yesterday / N min ago). Used by the Git
 * log, Local History, commit details and blame.
 */
import { tx } from "./i18n";
import { useProject } from "./project";

export interface DateFormatOptions {
  overrideSystem: boolean;
  /** `yyyy`, `yy`, `MMMM`, `MMM`, `MM`, `M`, `dd`, `d` placeholders. */
  pattern: string;
  use24Hour: boolean;
  pretty: boolean;
}

export const DEFAULT_DATE_FORMAT: DateFormatOptions = {
  overrideSystem: false,
  pattern: "dd.MM.yyyy",
  use24Hour: true,
  pretty: true,
};

export function dateFormatOptions(): DateFormatOptions {
  const raw = useProject.getState().settings?.general?.dateFormat as Partial<DateFormatOptions> | undefined;
  return {
    overrideSystem: typeof raw?.overrideSystem === "boolean" ? raw.overrideSystem : DEFAULT_DATE_FORMAT.overrideSystem,
    pattern: typeof raw?.pattern === "string" && raw.pattern.trim() ? raw.pattern : DEFAULT_DATE_FORMAT.pattern,
    use24Hour: typeof raw?.use24Hour === "boolean" ? raw.use24Hour : DEFAULT_DATE_FORMAT.use24Hour,
    pretty: typeof raw?.pretty === "boolean" ? raw.pretty : DEFAULT_DATE_FORMAT.pretty,
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Formats the date part with a `dd.MM.yyyy`-style pattern. */
export function formatPattern(d: Date, pattern: string): string {
  const tokens: Record<string, () => string> = {
    yyyy: () => String(d.getFullYear()),
    yy: () => pad(d.getFullYear() % 100),
    MMMM: () => d.toLocaleString("en", { month: "long" }),
    MMM: () => d.toLocaleString("en", { month: "short" }),
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    dd: () => pad(d.getDate()),
    d: () => String(d.getDate()),
  };
  return pattern.replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d/g, (m) => tokens[m]!());
}

export function formatClock(d: Date, o: DateFormatOptions = dateFormatOptions()): string {
  if (!o.overrideSystem) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (o.use24Hour) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const h = d.getHours() % 12 || 12;
  return `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

/** Date only (blame gutter, compact columns). */
export function formatDay(d: Date, o: DateFormatOptions = dateFormatOptions(), short = false): string {
  if (o.overrideSystem) return formatPattern(d, o.pattern);
  return short
    ? d.toLocaleDateString(undefined, { year: "2-digit", month: "2-digit", day: "2-digit" })
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Timestamp for lists: pretty ("Today 10:42", "5 min ago") when enabled, else date + time. */
export function formatTimestamp(ms: number, now = Date.now(), o: DateFormatOptions = dateFormatOptions()): string {
  const d = new Date(ms);
  if (o.pretty) {
    const diff = now - ms;
    const min = 60_000;
    if (diff >= 0 && diff < min) return tx("Moments ago");
    if (diff >= 0 && diff < 60 * min) return tx`${Math.floor(diff / min)} min ago`;
    const today = new Date(now);
    if (d.toDateString() === today.toDateString()) return tx`Today ${formatClock(d, o)}`;
    if (d.toDateString() === new Date(now - 86_400_000).toDateString()) return tx`Yesterday ${formatClock(d, o)}`;
    return formatDay(d, o);
  }
  return `${formatDay(d, o)} ${formatClock(d, o)}`;
}
