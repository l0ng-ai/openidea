/** Logcat tool window: filtering and formatting, independent of React. */
import type { LogcatLevel, LogcatLine } from "@/platform/ipc";
import { compileQuery } from "./query";

/** Severity order of the level filter, least severe first. `unknown` sits last so
 * lines logcat prints outside its message format are never filtered away. */
export const LEVELS: readonly LogcatLevel[] = ["verbose", "debug", "info", "warn", "error", "fatal", "unknown"];

/** The levels the filter offers as a minimum; `unknown` always shows, so it is not one. */
export const FILTER_LEVELS = LEVELS.filter((level) => level !== "unknown");

/** Row style per level, matching the classes in `Logcat.module.css`. */
export const LEVEL_CLASS: Record<LogcatLevel, string> = {
  verbose: "levelV",
  debug: "levelD",
  info: "levelI",
  warn: "levelW",
  error: "levelE",
  fatal: "levelF",
  unknown: "levelU",
};

/** "11-04 12:52:39.123" → "12:52:39.123": the date is the same for the whole session. */
export function shortTime(time: string): string {
  return time.length > 6 ? time.slice(6) : time;
}

/** Lines at or above `min`, then only those the query accepts (see `query.ts`). */
export function filterLines<T extends LogcatLine>(lines: readonly T[], min: LogcatLevel, query: string): readonly T[] {
  const floor = LEVELS.indexOf(min);
  const filter = compileQuery(query);
  if (floor === 0 && !query.trim()) return lines;
  return lines.filter((line) => LEVELS.indexOf(line.level) >= floor && filter.test(line));
}
