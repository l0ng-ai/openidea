/**
 * Query parameters of console statements (`:id`, `?`, `?1`, `@name`, `$1`),
 * filled in before execution as IDEA does: each value is inserted as SQL
 * text, so strings carry their quotes. Named parameters share one value;
 * every bare `?` is its own.
 */
import type { DbDriver } from "@/platform/ipc";
import { lex } from "./lexer";

export interface SqlParam {
  /** Shown in the dialog and the key of its value (`:id`, `?2`). */
  name: string;
  from: number;
  to: number;
  /** A bare `?`, numbered in order. */
  positional?: boolean;
}

/** Parameters of `text`; bare `?` are numbered from `numbered + 1` (earlier statements' count). */
export function findParams(text: string, driver: DbDriver, numbered = 0): SqlParam[] {
  const toks = lex(text, driver).tokens;
  const out: SqlParam[] = [];
  let positional = numbered;
  let typedEnd = -1;
  toks.forEach((t, i) => {
    if (t.from < typedEnd) return;
    if (driver === "clickhouse" && t.kind === "punct" && t.text === "{") {
      const end = toks.slice(i + 1).find((candidate) => candidate.kind === "punct" && candidate.text === "}");
      const name = end ? text.slice(t.from, end.to) : "";
      if (end && /^\{[A-Za-z_][A-Za-z0-9_]*\s*:\s*[^{}]+\}$/.test(name)) {
        out.push({ name, from: t.from, to: end.to });
        typedEnd = end.to;
        return;
      }
    }
    if (t.kind === "param") {
      // MySQL `@var` / `@@var` are session variables.
      if (driver === "mysql" && t.text.startsWith("@")) return;
      if (toks[i - 1]?.text === "@") return;
      out.push({ name: t.text, from: t.from, to: t.to });
    } else if (t.kind === "punct" && t.text === "?" && driver !== "postgres") {
      // PostgreSQL's `?` is a jsonb operator; its parameters are `$1`.
      const n = toks[i + 1];
      if (n?.kind === "number" && n.from === t.to) out.push({ name: `?${n.text}`, from: t.from, to: n.to });
      else out.push({ name: `?${++positional}`, from: t.from, to: t.to, positional: true });
    }
  });
  return out;
}

/** `text` with each parameter replaced by its value (empty: `NULL`). */
export function bindParams(
  text: string,
  params: readonly SqlParam[],
  values: Readonly<Record<string, string>>,
): string {
  let out = "";
  let at = 0;
  for (const p of params) {
    out += text.slice(at, p.from) + (values[p.name]?.trim() || "NULL");
    at = p.to;
  }
  return out + text.slice(at);
}
