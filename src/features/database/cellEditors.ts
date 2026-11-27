/**
 * Type-aware cell editing (issue #2331, phase 1): which editor a column's SQL
 * type gets and the values it writes. Values come from the column metadata the
 * database introspection already returns — the type string itself (MySQL's
 * `ENUM('a','b')`, the table details' column default) — so no new backend
 * support is needed. Date / time pickers, foreign-key lookups and enum value
 * lists for types that don't carry them (PostgreSQL) are follow-ups.
 */
import type { DbDriver } from "@/platform/ipc";

/** The select editor's option that writes SQL NULL (not a possible cell value). */
export const NULL_INPUT = "\u0000null";

export interface BooleanLiterals {
  /** What the driver renders `true` / `false` as (the values the editor writes back). */
  t: string;
  f: string;
}

/**
 * The column's SQL type edits as a boolean: a real `BOOLEAN`, MySQL / SQLite's
 * `TINYINT(1)` alias or SQL Server's one-bit `BIT`.
 */
export function isBooleanType(type: string, driver?: DbDriver): boolean {
  if (/^bit$/i.test(type.trim()) && (driver === "postgres" || driver === "mysql")) return false;
  return /^(boolean|bool|tinyint\(1\)|bit)$/i.test(type.trim());
}

/** The literals the editor writes, matching what the driver renders (`t`/`f` on PostgreSQL, `1`/`0` on MySQL). */
export function booleanLiterals(driver: DbDriver | undefined): BooleanLiterals {
  switch (driver) {
    case "postgres":
      return { t: "t", f: "f" };
    case "mysql":
    case "sqlite":
      return { t: "1", f: "0" };
    default:
      return { t: "true", f: "false" };
  }
}

/**
 * The allowed values of a MySQL `ENUM('a','b')` type, in definition order;
 * `null` when the type string doesn't list them (other drivers, or the driver's
 * own short name like the console results' `ENUM`). `''` is a doubled quote.
 */
export function enumValuesOfType(type: string): readonly string[] | null {
  const m = /^enum\s*\(([\s\S]*)\)$/i.exec(type.trim());
  if (!m) return null;
  const body = m[1]!;
  const values: string[] = [];
  let at = 0;
  for (;;) {
    while (at < body.length && /\s/.test(body[at]!)) at++;
    if (body[at] !== "'") return null; // every value is a quoted string
    at++;
    let value = "";
    for (;;) {
      if (at >= body.length) return null; // unterminated string
      const ch = body[at]!;
      if (ch === "\\") {
        const escaped = body[++at];
        if (escaped === undefined) return null;
        const escapes: Record<string, string> = { "0": "\0", b: "\b", n: "\n", r: "\r", t: "\t", Z: "\x1a" };
        value += escapes[escaped] ?? escaped;
        at++;
        continue;
      }
      if (ch === "'") {
        if (body[at + 1] === "'") {
          value += "'";
          at += 2;
          continue;
        }
        at++;
        break;
      }
      value += ch;
      at++;
    }
    values.push(value);
    while (at < body.length && /\s/.test(body[at]!)) at++;
    if (at >= body.length) return values;
    if (body[at] !== ",") return null;
    at++;
  }
}

/**
 * The literal a Set DEFAULT action puts in the cell: the column's introspected
 * default when it is a plain value — a quoted string (with an optional
 * `::type` cast) or a bare number. `null` for anything else (`now()`,
 * `nextval('…')`, `CURRENT_TIMESTAMP`): the grid's pending edits send text or
 * SQL NULL only, so an expression default can't be applied from here.
 */
export function defaultLiteralOf(defaultExpr: string): string | null {
  let s = defaultExpr.trim();
  while (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1).trim();
  if (/^(true|false)$/i.test(s)) return s.toLowerCase();
  const quoted = quotedLiteral(s);
  if (quoted !== null) return quoted;
  return /^[-+]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? s : null;
}

/** The text of one SQL quoted string at the start of `s`, with an optional trailing `::type` cast. */
function quotedLiteral(s: string): string | null {
  if (!s.startsWith("'")) return null;
  let value = "";
  let at = 1;
  for (;;) {
    if (at >= s.length) return null; // unterminated string
    const ch = s[at]!;
    if (ch === "'") {
      if (s[at + 1] === "'") {
        value += "'";
        at += 2;
        continue;
      }
      at++;
      break;
    }
    value += ch;
    at++;
  }
  const rest = s.slice(at).trim();
  if (
    rest &&
    !/^::\s*(?:[\w]+|"[^"]+")(?:\s*\.\s*(?:[\w]+|"[^"]+"))*(?:\s+(?:varying|precision|with(?:out)?\s+time\s+zone))?(?:\s*\(\d+(?:\s*,\s*\d+)?\))?(?:\[\])?$/i.test(
      rest,
    )
  )
    return null;
  return value;
}
