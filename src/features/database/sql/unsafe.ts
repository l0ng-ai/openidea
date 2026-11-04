/**
 * IDEA's unsafe-query check: statements that wipe a whole table or more. A
 * DELETE or UPDATE without WHERE, or whose WHERE is always true (`WHERE 1=1`),
 * touches every row of its table; TRUNCATE, DROP TABLE / DATABASE / SCHEMA and
 * ALTER TABLE … DROP COLUMN lose data outright. The console asks before running one.
 */
import type { DbDriver } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { lex, type Token } from "./lexer";

export interface UnsafeStatement {
  kind: "delete" | "update" | "truncate" | "drop" | "alter";
  reason:
    | "no-where"
    | "always-true"
    | "clears-table"
    | "drops-table"
    | "drops-database"
    | "drops-schema"
    | "drops-column";
  /** What to mark, offsets into the statement text: the condition, else the whole statement. */
  from: number;
  to: number;
}

/** Words ending a DELETE / UPDATE condition. */
const AFTER_WHERE = new Set(["RETURNING", "ORDER", "LIMIT", "OFFSET", "OPTION", "SETTINGS"]);
const STATEMENT = new Set(["DELETE", "UPDATE", "SELECT", "INSERT", "MERGE", "VALUES", "TABLE"]);
/** What `DROP <word>` removes, by the object word (after TEMPORARY / TEMP). */
const DROPPED: Record<string, UnsafeStatement["reason"]> = {
  TABLE: "drops-table",
  DATABASE: "drops-database",
  SCHEMA: "drops-schema",
};
/** `ALTER TABLE … DROP <word>` forms that remove no column data. */
const DROP_NOT_COLUMN = new Set([
  "CONSTRAINT",
  "INDEX",
  "KEY",
  "PRIMARY",
  "FOREIGN",
  "CHECK",
  "DEFAULT",
  "NOT",
  "IDENTITY",
  "EXPRESSION",
  "PARTITION",
  "TRIGGER",
  "RULE",
  "PROJECTION",
  "STATISTICS",
]);

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

const isWord = (t: Token | undefined, word: string) => t?.kind === "word" && t.upper === word;

export function unsafeStatement(text: string, driver: DbDriver): UnsafeStatement | null {
  const tokens = lex(text, driver).tokens.filter((t) => t.text !== ";");
  if (!tokens.length) return null;
  const depth = depths(tokens);
  const last = tokens.at(-1)!;
  const whole = (kind: UnsafeStatement["kind"], reason: UnsafeStatement["reason"]): UnsafeStatement => ({
    kind,
    reason,
    from: tokens[0]!.from,
    to: last.to,
  });
  // The statement's own verb: the first word at depth 0 (after a WITH clause's queries).
  let verb = 0;
  if (tokens[0]!.upper === "WITH") {
    verb = tokens.findIndex((t, i) => i > 0 && depth[i] === 0 && t.kind === "word" && STATEMENT.has(t.upper));
    if (verb < 0) return null;
  }
  const v = tokens[verb]!.kind === "word" ? tokens[verb]!.upper : "";
  if (v === "TRUNCATE") return whole("truncate", "clears-table");
  if (v === "DROP") {
    let i = verb + 1;
    if (isWord(tokens[i], "TEMPORARY") || isWord(tokens[i], "TEMP")) i++;
    const reason = tokens[i]?.kind === "word" ? DROPPED[tokens[i]!.upper] : undefined;
    return reason ? whole("drop", reason) : null;
  }
  if (v === "ALTER")
    return isWord(tokens[verb + 1], "TABLE") && dropsColumn(tokens, depth) ? whole("alter", "drops-column") : null;
  if (v !== "DELETE" && v !== "UPDATE") return null;
  const kind = v === "DELETE" ? "delete" : "update";
  const where = tokens.findIndex((t, i) => i > verb && depth[i] === 0 && t.kind === "word" && t.upper === "WHERE");
  if (where < 0) return whole(kind, "no-where");
  let end = tokens.findIndex((t, i) => i > where && depth[i] === 0 && t.kind === "word" && AFTER_WHERE.has(t.upper));
  if (end < 0) end = tokens.length;
  if (end === where + 1) return null;
  const condition = tokens.slice(where + 1, end);
  if (evaluate(condition) !== true) return null;
  return { kind, reason: "always-true", from: condition[0]!.from, to: condition.at(-1)!.to };
}

/** Whether an ALTER TABLE drops a column (`DROP [COLUMN] [IF EXISTS] c`, not a constraint, default, …). */
function dropsColumn(tokens: readonly Token[], depth: readonly number[]): boolean {
  return tokens.some((t, i) => {
    if (depth[i] !== 0 || !isWord(t, "DROP")) return false;
    const next = tokens[i + 1];
    if (!next) return false;
    if (isWord(next, "COLUMN")) return true;
    return !(next.kind === "word" && DROP_NOT_COLUMN.has(next.upper));
  });
}

/** The banner's text for `u`. */
export function unsafeMessage(u: UnsafeStatement): string {
  switch (u.reason) {
    case "clears-table":
      return tx("Unsafe query: 'Truncate' statement clears all data in the table");
    case "drops-table":
      return tx("Unsafe query: 'Drop' statement deletes the table with all its data");
    case "drops-database":
      return tx("Unsafe query: 'Drop' statement deletes the database with all its data");
    case "drops-schema":
      return tx("Unsafe query: 'Drop' statement deletes the schema with all its objects");
    case "drops-column":
      return tx("Unsafe query: 'Alter' statement drops a column with all its data");
  }
  if (u.kind === "delete")
    return u.reason === "no-where"
      ? tx("Unsafe query: 'Delete' statement without 'where' clears all data in the table")
      : tx("Unsafe query: 'Delete' statement clears all data in the table because 'where' condition is always true");
  return u.reason === "no-where"
    ? tx("Unsafe query: 'Update' statement without 'where' updates all rows in the table")
    : tx("Unsafe query: 'Update' statement updates all rows in the table because 'where' condition is always true");
}

/** A condition's constant truth; `null` when it depends on the rows (or is SQL's unknown). */
type Truth = boolean | null;
/** A constant expression's value: SQL NULL as `null`, `undefined` when it is not a constant. */
type Value = number | string | boolean | null | undefined;

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

/** Splits `tokens` at depth-0 commas. */
function commaList(tokens: readonly Token[]): Token[][] {
  const depth = depths(tokens);
  const parts: Token[][] = [[]];
  tokens.forEach((t, i) => {
    if (depth[i] === 0 && t.text === ",") parts.push([]);
    else parts.at(-1)!.push(t);
  });
  return parts;
}

/** Whether one pair of parentheses encloses all of `tokens`. */
function wrapped(tokens: readonly Token[]): boolean {
  if (tokens.length < 2 || tokens[0]!.text !== "(" || tokens.at(-1)!.text !== ")") return false;
  return depths(tokens)
    .slice(1, -1)
    .every((d) => d > 0);
}

/** The constant truth value of a condition; `null` when it depends on the rows. */
function evaluate(tokens: readonly Token[]): Truth {
  const branches = split(tokens, "OR");
  if (coversNull(branches)) return true;
  const ors = branches.map((branch) => {
    const ands = split(branch, "AND").map(term);
    if (ands.some((a) => a === false)) return false;
    return ands.every((a) => a === true) ? true : null;
  });
  if (ors.some((o) => o === true)) return true;
  return ors.every((o) => o === false) ? false : null;
}

const key = (tokens: readonly Token[]) => tokens.map((t) => t.upper).join(" ");

/** `e IS NULL OR e IS NOT NULL` (any order, among other branches): true for every row. */
function coversNull(branches: readonly Token[][]): boolean {
  const isNull = new Set<string>();
  const notNull = new Set<string>();
  for (const b of branches) {
    const n = b.length;
    if (n < 3 || !isWord(b[n - 1], "NULL")) continue;
    if (isWord(b[n - 2], "NOT") && isWord(b[n - 3], "IS") && n > 3) notNull.add(key(b.slice(0, n - 3)));
    else if (isWord(b[n - 2], "IS")) isNull.add(key(b.slice(0, n - 2)));
  }
  return [...isNull].some((k) => notNull.has(k));
}

/** Whether `tokens[i]` ends an operand (so a following `-` / `+` is binary). */
function endsOperand(t: Token | undefined): boolean {
  return (
    !!t && (t.text === ")" || t.kind === "number" || t.kind === "string" || t.kind === "quoted" || t.kind === "word")
  );
}

function arithmetic(op: string, a: number, b: number): number | undefined {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    // Integer division truncates in some dialects: only exact quotients are certain.
    case "/":
      return b !== 0 && a % b === 0 ? a / b : undefined;
    case "%":
      return b !== 0 && Number.isInteger(a) && Number.isInteger(b) ? a % b : undefined;
  }
  return undefined;
}

/** The value of a constant expression: literals, NULL, TRUE / FALSE, parentheses and `+ - * / %`. */
function value(tokens: readonly Token[]): Value {
  if (!tokens.length) return undefined;
  if (wrapped(tokens)) return value(tokens.slice(1, -1));
  if (tokens.length === 1) {
    const t = tokens[0]!;
    if (t.kind === "number") {
      const n = Number(t.text);
      return Number.isFinite(n) ? n : undefined;
    }
    if (t.kind === "string" && t.text.startsWith("'") && t.text.endsWith("'") && t.text.length > 1)
      return t.text.slice(1, -1).replaceAll("''", "'");
    if (t.kind === "word") {
      if (t.upper === "NULL") return null;
      if (t.upper === "TRUE") return true;
      if (t.upper === "FALSE") return false;
    }
    return undefined;
  }
  const depth = depths(tokens);
  for (const ops of [
    ["+", "-"],
    ["*", "/", "%"],
  ]) {
    // The rightmost operator splits first: left-associative.
    for (let i = tokens.length - 1; i > 0; i--) {
      const t = tokens[i]!;
      if (depth[i] !== 0 || t.kind !== "punct" || !ops.includes(t.text) || !endsOperand(tokens[i - 1])) continue;
      const a = value(tokens.slice(0, i));
      const b = value(tokens.slice(i + 1));
      if (a === undefined || b === undefined) return undefined;
      if (a === null || b === null) return null;
      return typeof a === "number" && typeof b === "number" ? arithmetic(t.text, a, b) : undefined;
    }
  }
  const sign = tokens[0]!.text;
  if (sign === "-" || sign === "+") {
    const v = value(tokens.slice(1));
    if (v === null) return null;
    return typeof v === "number" ? (sign === "-" ? -v : v) : undefined;
  }
  return undefined;
}

/**
 * Order of two constants (negative, 0, positive); `undefined` when they are
 * not comparable for certain (different types, or strings a collation may
 * order or equate differently).
 */
function compare(a: Value, b: Value, equalityOnly: boolean): number | undefined {
  if (a === undefined || b === undefined || a === null || b === null || typeof a !== typeof b) return undefined;
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return 0;
    // Case-insensitive collations (MySQL's default) equate these.
    if (a.toLowerCase() === b.toLowerCase() || !equalityOnly) return undefined;
    return 1;
  }
  return a === b ? 0 : a < b ? -1 : 1;
}

const COMPARE: Record<string, (c: number) => boolean> = {
  "=": (c) => c === 0,
  "<>": (c) => c !== 0,
  "!=": (c) => c !== 0,
  "<": (c) => c < 0,
  ">": (c) => c > 0,
  "<=": (c) => c <= 0,
  ">=": (c) => c >= 0,
};

/** A LIKE pattern as a regular expression (`%` any run, `_` one character). */
function likePattern(pattern: string, flags: string): RegExp {
  const body = [...pattern]
    .map((c) => (c === "%" ? "[\\s\\S]*" : c === "_" ? "[\\s\\S]" : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`, flags);
}

/** Words of a sub-SELECT that make its result depend on data. */
const SELECT_SOURCES = new Set([
  "FROM",
  "WHERE",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "FETCH",
  "GROUP",
  "UNION",
  "INTERSECT",
  "EXCEPT",
]);

function term(tokens: readonly Token[]): Truth {
  if (!tokens.length) return null;
  const first = tokens[0]!;
  if (isWord(first, "NOT")) {
    const inner = term(tokens.slice(1));
    return inner === null ? null : !inner;
  }
  if (wrapped(tokens)) return evaluate(tokens.slice(1, -1));
  // `EXISTS (SELECT 1)`: a SELECT without a source always has a row.
  if (isWord(first, "EXISTS") && wrapped(tokens.slice(1))) {
    const inner = tokens.slice(2, -1);
    const d = depths(inner);
    const constant =
      isWord(inner[0], "SELECT") &&
      !inner.some((t, i) => d[i] === 0 && t.kind === "word" && SELECT_SOURCES.has(t.upper));
    return constant ? true : null;
  }
  const depth = depths(tokens);
  const at = (word: string) => tokens.findIndex((t, i) => i > 0 && depth[i] === 0 && isWord(t, word));
  /** Whether NOT precedes the operator word at `i` (`NOT IN`, `NOT LIKE`, …). */
  const negated = (i: number) => isWord(tokens[i - 1], "NOT");

  // `<expr> IS [NOT] NULL`
  const is = at("IS");
  if (is > 0) {
    const not = isWord(tokens[is + 1], "NOT");
    const rest = tokens.slice(is + (not ? 2 : 1));
    if (rest.length !== 1 || !isWord(rest[0], "NULL")) return null;
    const v = value(tokens.slice(0, is));
    return v === undefined ? null : (v === null) !== not;
  }

  // `<expr> [NOT] BETWEEN <expr> AND <expr>`
  const between = at("BETWEEN");
  if (between > 0) {
    const not = negated(between);
    const and = tokens.findIndex((t, i) => i > between && depth[i] === 0 && isWord(t, "AND"));
    if (and < 0) return null;
    const v = value(tokens.slice(0, not ? between - 1 : between));
    const lo = compare(v, value(tokens.slice(between + 1, and)), false);
    const hi = compare(v, value(tokens.slice(and + 1)), false);
    if (lo === undefined || hi === undefined) return null;
    return lo >= 0 && hi <= 0 ? !not : not;
  }

  // `<expr> [NOT] IN (<expr>, …)`
  const inAt = at("IN");
  if (inAt > 0) {
    const not = negated(inAt);
    const list = tokens.slice(inAt + 1);
    if (!wrapped(list) || isWord(list[1], "SELECT")) return null;
    const v = value(tokens.slice(0, not ? inAt - 1 : inAt));
    if (v === undefined || v === null) return null;
    const items = commaList(list.slice(1, -1)).map(value);
    if (items.some((i) => i === undefined)) return null;
    const order = items.map((i) => compare(v, i, true));
    if (order.some((o) => o === 0)) return !not;
    // A NULL item (or an uncertain comparison) leaves a miss unknown.
    if (items.some((i) => i === null) || order.some((o) => o === undefined)) return null;
    return not;
  }

  // `<expr> [NOT] LIKE / ILIKE <pattern>`
  const like = Math.max(at("LIKE"), at("ILIKE"));
  if (like > 0) {
    if (at("ESCAPE") > 0) return null;
    const not = negated(like);
    const v = value(tokens.slice(0, not ? like - 1 : like));
    const p = value(tokens.slice(like + 1));
    if (typeof v !== "string" || typeof p !== "string") return null;
    const insensitive = likePattern(p, "i").test(v);
    // LIKE's case sensitivity is the collation's: only agreeing answers are certain.
    const matches = isWord(tokens[like], "ILIKE") ? insensitive : likePattern(p, "").test(v);
    if (matches !== insensitive) return null;
    return matches !== not;
  }

  // `<expr> <op> <expr>`
  const op = tokens.findIndex((t, i) => i > 0 && depth[i] === 0 && t.kind === "punct" && t.text in COMPARE);
  if (op > 0) {
    const c = compare(
      value(tokens.slice(0, op)),
      value(tokens.slice(op + 1)),
      ["=", "<>", "!="].includes(tokens[op]!.text),
    );
    return c === undefined ? null : COMPARE[tokens[op]!.text]!(c);
  }

  // A bare constant: numbers are true unless 0 (MySQL, SQLite); NULL matches nothing.
  const v = value(tokens);
  if (typeof v === "number") return v !== 0;
  if (typeof v === "boolean") return v;
  if (v === null) return false;
  return null;
}
