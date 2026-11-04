/** Logcat tool window: filtering and formatting, independent of React. */
import type { LogcatLevel, LogcatLine } from "@/platform/ipc";

/** Severity order of the level filter, least severe first. `unknown` sits last so
 * lines logcat prints outside its message format are never filtered away. */
export const LEVELS: readonly LogcatLevel[] = ["verbose", "debug", "info", "warn", "error", "fatal", "unknown"];

export const LEVEL_LETTER: Record<LogcatLevel, string> = {
  verbose: "V",
  debug: "D",
  info: "I",
  warn: "W",
  error: "E",
  fatal: "F",
  unknown: "?",
};

/** "11-04 12:52:39.123" → "12:52:39.123": the date is the same for the whole session. */
export function shortTime(time: string): string {
  return time.length > 6 ? time.slice(6) : time;
}

function matches(line: LogcatLine, needle: string): boolean {
  return (
    line.message.toLowerCase().includes(needle) ||
    line.tag.toLowerCase().includes(needle) ||
    (needle.startsWith("#") && String(line.pid) === needle.slice(1))
  );
}

/** Lines at or above `min`, then only those mentioning `query` (tag, message or `#pid`). */
export function filterLines(lines: readonly LogcatLine[], min: LogcatLevel, query: string): readonly LogcatLine[] {
  const floor = LEVELS.indexOf(min);
  const needle = query.trim().toLowerCase();
  if (floor === 0 && !needle) return lines;
  return lines.filter((line) => LEVELS.indexOf(line.level) >= floor && (!needle || matches(line, needle)));
}
