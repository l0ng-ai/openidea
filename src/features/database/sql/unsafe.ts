/**
 * IDEA's unsafe-query check: a DELETE or UPDATE without WHERE, or whose WHERE
 * is always true (`WHERE 1=1`), touches every row of its table. The console
 * asks before running one.
 */
import type { DbDriver } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { lex, type Token } from "./lexer";

export interface UnsafeStatement {
  kind: "delete" | "update";
  reason: "no-where" | "always-true";
  /** What to mark, offsets into the statement text: the condition, else the whole statement. */
  from: number;
  to: number;
}

/** Words ending a DELETE / UPDATE condition. */
const AFTER_WHERE = new Set(["RETURNING", "ORDER", "LIMIT", "OFFSET", "OPTION", "SETTINGS"]);
const STATEMENT = new Set(["DELETE", "UPDATE", "SELECT", "INSERT", "MERGE", "VALUES", "TABLE"]);

/** Depth of each token in parentheses (a token's own `(` / `)` counts outside). */
function depths(tokens: readonly Token[]): number[] {
  let depth = 0;
  return tokens.map((t) => {
    if (t.text === ")") depth = Math.max(0, depth - 1);
    const d = depth;
    if (t.text === "(") depth++;
    return d;
  });
}

export function unsafeStatement(text: string, driver: DbDriver): UnsafeStatement | null {
  const tokens = lex(text, driver).tokens.filter((t) => t.text !== ";");
  if (!tokens.length) return null;
  const depth = depths(tokens);
  // The statement's own verb: the first word at depth 0 (after a WITH clause's queries).
  let verb = 0;
  if (tokens[0]!.upper === "WITH") {
    verb = tokens.findIndex((t, i) => i > 0 && depth[i] === 0 && t.kind === "word" && STATEMENT.has(t.upper));
    if (verb < 0) return null;
  }
  const v = tokens[verb]!.upper;
  if (v !== "DELETE" && v !== "UPDATE") return null;
  const kind = v === "DELETE" ? "delete" : "update";
  const where = tokens.findIndex((t, i) => i > verb && depth[i] === 0 && t.kind === "word" && t.upper === "WHERE");
  const last = tokens.at(-1)!;
  if (where < 0) return { kind, reason: "no-where", from: tokens[0]!.from, to: last.to };
  let end = tokens.findIndex((t, i) => i > where && depth[i] === 0 && t.kind === "word" && AFTER_WHERE.has(t.upper));
  if (end < 0) end = tokens.length;
  if (end === where + 1) return null;
  const condition = tokens.slice(where + 1, end);
  if (evaluate(condition) !== true) return null;
  return { kind, reason: "always-true", from: condition[0]!.from, to: condition.at(-1)!.to };
}

/** The banner's text for `u`. */
export function unsafeMessage(u: UnsafeStatement): string {
  if (u.kind === "delete")
    return u.reason === "no-where"
      ? tx("Unsafe query: 'Delete' statement without 'where' clears all data in the table")
      : tx("Unsafe query: 'Delete' statement clears all data in the table because 'where' condition is always true");
  return u.reason === "no-where"
    ? tx("Unsafe query: 'Update' statement without 'where' updates all rows in the table")
    : tx("Unsafe query: 'Update' statement updates all rows in the table because 'where' condition is always true");
}

type Truth = boolean | null;

/** Splits `tokens` at depth-0 words `word` (an AND closing a BETWEEN stays inside its term). */
function split(tokens: readonly Token[], word: "OR" | "AND"): Token[][] {
  const depth = depths(tokens);
  const parts: Token[][] = [[]];
  let between = false;
  tokens.forEach((t, i) => {
    if (depth[i] === 0 && t.kind === "word") {
      if (t.upper === "BETWEEN") between = true;
      else if (t.upper === word) {
        if (word === "AND" && between) between = false;
        else {
          parts.push([]);
          return;
        }
      }
    }
    parts.at(-1)!.push(t);
  });
  return parts;
}

/** The constant truth value of a condition; `null` when it depends on the rows. */
function evaluate(tokens: readonly Token[]): Truth {
  const ors = split(tokens, "OR").map((branch) => {
    const ands = split(branch, "AND").map(term);
    if (ands.some((a) => a === false)) return false;
    return ands.every((a) => a === true) ? true : null;
  });
  if (ors.some((o) => o === true)) return true;
  return ors.every((o) => o === false) ? false : null;
}

/** A literal's value: numbers as numbers, strings without their quotes. */
function literal(tokens: readonly Token[]): number | string | null {
  const [a, b] = tokens;
  if (tokens.length === 2 && a!.text === "-" && b!.kind === "number") return -Number(b!.text);
  if (tokens.length !== 1) return null;
  if (a!.kind === "number" && Number.isFinite(Number(a!.text))) return Number(a!.text);
  if (a!.kind === "string" && a!.text.startsWith("'") && a!.text.endsWith("'") && a!.text.length > 1)
    return a!.text.slice(1, -1).replaceAll("''", "'");
  return null;
}

const COMPARE: Record<string, (a: number | string, b: number | string) => boolean> = {
  "=": (a, b) => a === b,
  "==": (a, b) => a === b,
  "<>": (a, b) => a !== b,
  "!=": (a, b) => a !== b,
  "<": (a, b) => a < b,
  ">": (a, b) => a > b,
  "<=": (a, b) => a <= b,
  ">=": (a, b) => a >= b,
};

function term(tokens: readonly Token[]): Truth {
  if (!tokens.length) return null;
  const first = tokens[0]!;
  if (first.kind === "word" && first.upper === "NOT") {
    const inner = term(tokens.slice(1));
    return inner === null ? null : !inner;
  }
  // `( … )` around the whole term.
  if (first.text === "(" && tokens.at(-1)!.text === ")") {
    const depth = depths(tokens);
    if (depth.slice(1, -1).every((d) => d > 0)) return evaluate(tokens.slice(1, -1));
  }
  if (tokens.length === 1 && first.kind === "word") {
    if (first.upper === "TRUE") return true;
    if (first.upper === "FALSE") return false;
  }
  const value = literal(tokens);
  if (typeof value === "number") return value !== 0;
  // `<literal> IS [NOT] NULL`
  const n = tokens.length;
  if (n >= 3 && tokens[n - 1]!.upper === "NULL") {
    const not = tokens[n - 2]!.upper === "NOT";
    const is = tokens[n - (not ? 3 : 2)];
    if (is?.upper === "IS" && literal(tokens.slice(0, n - (not ? 3 : 2))) !== null) return not;
  }
  // `<literal> <op> <literal>`
  const op = tokens.findIndex((t) => t.kind === "punct" && t.text in COMPARE);
  if (op > 0) {
    const a = literal(tokens.slice(0, op));
    const b = literal(tokens.slice(op + 1));
    if (a !== null && b !== null && typeof a === typeof b) return COMPARE[tokens[op]!.text]!(a, b);
  }
  return null;
}
