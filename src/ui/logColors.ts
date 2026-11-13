/**
 * Console log-line colours by level (Settings › Build, Execution, Deployment ›
 * Console). Detection mirrors the `log` editor mode (`editor/core/cm/log.ts`):
 * explicit `level=`/`severity=` fields and `[warn]`/`<Info>` markers match in
 * any case, bare words only in upper case, so prose stays plain.
 */
import { LEVELS } from "@/editor/core/cm/log";

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

/** Explicit level fields: JSON `"level":"info"`, logfmt `level=error`, GCP `severity`. */
const KEY_RE = new RegExp(`(?:^|[^A-Za-z0-9_])(?:level|lvl|severity)["']?\\s*[:=]\\s*["']?(${LEVELS})\\b`, "i");
/** Bracketed markers: Maven `[ERROR]`, log4j2 `<Info>`. */
const MARK_RE = new RegExp(`[\\[<](${LEVELS})[\\]>]`, "i");
/** Bare upper-case words at a word start (the `log` mode's rule). */
const BARE_RE = new RegExp(`(?:^|[^A-Za-z0-9_$.-])(${LEVELS})(?![A-Za-z0-9_])`);

const ALIAS: Record<string, LogLevel> = {
  FATAL: "error",
  CRITICAL: "error",
  SEVERE: "error",
  EMERG: "error",
  ALERT: "error",
  ERROR: "error",
  ERR: "error",
  WARNING: "warn",
  WARN: "warn",
  NOTICE: "warn",
  INFO: "info",
  DEBUG: "debug",
  VERBOSE: "trace",
  TRACE: "trace",
  FINEST: "trace",
  FINER: "trace",
  FINE: "trace",
};

function detectLogLevel(text: string): LogLevel | null {
  // An explicit declaration is the most trusted, then a marker, then a bare word.
  const m = KEY_RE.exec(text) ?? MARK_RE.exec(text) ?? BARE_RE.exec(text);
  return m ? (ALIAS[m[1]!.toUpperCase()] ?? null) : null;
}

/** A line's colour, or `undefined`: colouring off, a stream the IDE owns, or no level. */
export function logLineColor(
  text: string,
  kind: string,
  colors: { enabled: boolean } & Record<LogLevel, string>,
): string | undefined {
  if (!colors.enabled || (kind !== "stdout" && kind !== "stderr")) return undefined;
  const level = detectLogLevel(text);
  return level ? colors[level] : undefined;
}
