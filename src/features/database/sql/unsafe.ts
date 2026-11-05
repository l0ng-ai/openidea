/**
 * IDEA's unsafe-query check: statements that wipe a whole table or more. A
 * DELETE or UPDATE without WHERE, or whose WHERE is always true (`WHERE 1=1`),
 * touches every row of its table, as does a MERGE whose ON is always true;
 * TRUNCATE, DROP TABLE / DATABASE / SCHEMA and ALTER TABLE … DROP COLUMN /
 * PARTITION lose data outright. Such a statement is found inside parentheses,
 * a WITH clause's queries and EXPLAIN ANALYZE (which runs it) too. The console
 * asks before running one.
 *
 * Conditions are evaluated compositionally (`evaluate` → `term` → `value`):
 * each operator is supported once and combines with the others. Anything
 * uncertain (data, functions, collations, dialect differences) counts as not
 * constant, so the check never warns about a statement it cannot prove unsafe.
 */
import type { DbDriver } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { lex, type Token } from "./lexer";

export interface UnsafeStatement {
  kind: "delete" | "update" | "merge-delete" | "merge-update" | "truncate" | "drop" | "alter";
  reason:
    | "no-where"
    | "always-true"
    | "clears-table"
    | "drops-table"
    | "drops-database"
    | "drops-schema"
    | "drops-column"
    | "drops-partition"
    | "clears-partition"
    | "drops-history";
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
/** `ALTER TABLE … DROP <word>` forms that remove no data. */
const DROP_NOT_COLUMN = new Set([
  "CONSTRAINT",
  "INDEX",
  "KEY",
  "PRIMARY",
  "FOREIGN",
  "UNIQUE",
  "CHECK",
  "DEFAULT",
  "NOT",
  "IDENTITY",
  "EXPRESSION",
  "STORED",
  "PERIOD",
  "TRIGGER",
  "RULE",
  "PROJECTION",
  "STATISTICS",
]);
/** `ALTER TABLE … DROP <word>` forms that remove data other than a column. */
const DROP_DATA: Record<string, UnsafeStatement["reason"]> = {
  PARTITION: "drops-partition",
  SUBPARTITION: "drops-partition",
  // MariaDB's `DROP SYSTEM VERSIONING` deletes the row history.
  SYSTEM: "drops-history",
};
/** `EXPLAIN` options before the statement; ANALYZE runs it. */
const EXPLAIN_OPTIONS = new Set(["ANALYZE", "ANALYSE", "VERBOSE"]);

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
  return check(lex(text, driver).tokens.filter((t) => t.text !== ";"));
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function closing(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i]!.text === "(") depth++;
    else if (tokens[i]!.text === ")" && --depth === 0) return i;
  }
  return -1;
}

function check(tokens: readonly Token[]): UnsafeStatement | null {
  if (!tokens.length) return null;
  // `(DELETE FROM t)`
  if (wrapped(tokens)) return check(tokens.slice(1, -1));
  if (isWord(tokens[0], "EXPLAIN")) return explained(tokens);
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
  if (isWord(tokens[0], "WITH")) {
    verb = tokens.findIndex((t, i) => i > 0 && depth[i] === 0 && t.kind === "word" && STATEMENT.has(t.upper));
    // A query of the WITH clause can modify data itself: `WITH d AS (DELETE FROM t RETURNING *) SELECT …`.
    for (let i = 1; i < (verb < 0 ? tokens.length : verb); i++) {
      if (tokens[i]!.text !== "(" || depth[i] !== 0) continue;
      const close = closing(tokens, i);
      if (close < 0) break;
      // A query follows AS [[NOT] MATERIALIZED]; other parentheses list the columns.
      if (isWord(tokens[i - 1], "AS") || isWord(tokens[i - 1], "MATERIALIZED")) {
        const found = check(tokens.slice(i + 1, close));
        if (found) return found;
      }
      i = close;
    }
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
  if (v === "ALTER") {
    const reason = isWord(tokens[verb + 1], "TABLE") ? alterLoses(tokens, depth) : null;
    return reason ? whole("alter", reason) : null;
  }
  if (v === "MERGE") return merged(tokens, depth);
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

/**
 * The statement an EXPLAIN runs: `EXPLAIN ANALYZE …` / `EXPLAIN (ANALYZE, …) …`
 * execute it; a plain EXPLAIN (or `EXPLAIN (ANALYZE false)`) only plans it.
 */
function explained(tokens: readonly Token[]): UnsafeStatement | null {
  let i = 1;
  let analyze = false;
  if (tokens[1]?.text === "(") {
    const close = closing(tokens, 1);
    if (close < 0) return null;
    for (const option of commaList(tokens.slice(2, close))) {
      const [name, setting] = option;
      if (!isWord(name, "ANALYZE") && !isWord(name, "ANALYSE")) continue;
      analyze = !setting || !["FALSE", "OFF", "0"].includes(setting.upper);
    }
    i = close + 1;
  }
  while (tokens[i]?.kind === "word" && EXPLAIN_OPTIONS.has(tokens[i]!.upper)) {
    if (tokens[i]!.upper !== "VERBOSE") analyze = true;
    i++;
  }
  return analyze ? check(tokens.slice(i)) : null;
}

/**
 * A MERGE that deletes or updates every row of its target: its ON is always
 * true and a `WHEN MATCHED [AND <always true>] THEN DELETE / UPDATE` applies.
 */
function merged(tokens: readonly Token[], depth: readonly number[]): UnsafeStatement | null {
  const on = tokens.findIndex((t, i) => depth[i] === 0 && isWord(t, "ON"));
  const whens = tokens.flatMap((t, i) => (depth[i] === 0 && isWord(t, "WHEN") ? [i] : []));
  if (on < 0 || !whens.length || whens[0]! <= on + 1) return null;
  const condition = tokens.slice(on + 1, whens[0]);
  if (evaluate(condition) !== true) return null;
  let kind: "merge-delete" | "merge-update" | null = null;
  for (const [n, w] of whens.entries()) {
    const clause = tokens.slice(w + 1, whens[n + 1] ?? tokens.length);
    if (!isWord(clause[0], "MATCHED")) continue;
    const then = clause.findIndex((t) => isWord(t, "THEN"));
    if (then < 0) continue;
    // `WHEN MATCHED AND <cond>` narrows the rows unless <cond> is always true too.
    if (then > 1 && !(isWord(clause[1], "AND") && evaluate(clause.slice(2, then)) === true)) continue;
    const verb = clause[then + 1]?.upper;
    if (verb === "DELETE") kind = "merge-delete";
    else if (verb === "UPDATE") kind ??= "merge-update";
  }
  if (!kind) return null;
  return {
    kind,
    reason: "always-true",
    from: condition[0]!.from,
    to: condition.at(-1)!.to,
  };
}

/**
 * What an ALTER TABLE loses: a column (`DROP [COLUMN] [IF EXISTS] c`), a
 * partition (`DROP / TRUNCATE PARTITION`) or the row history (`DROP SYSTEM
 * VERSIONING`); `null` for drops of constraints, defaults, indexes, ….
 */
function alterLoses(tokens: readonly Token[], depth: readonly number[]): UnsafeStatement["reason"] | null {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (depth[i] !== 0) continue;
    const next = tokens[i + 1]!;
    const word = next.kind === "word" ? next.upper : "";
    if (isWord(tokens[i], "TRUNCATE") && (word === "PARTITION" || word === "SUBPARTITION")) return "clears-partition";
    if (!isWord(tokens[i], "DROP")) continue;
    if (word === "COLUMN") return "drops-column";
    if (DROP_DATA[word]) return DROP_DATA[word];
    if (!DROP_NOT_COLUMN.has(word)) return "drops-column";
  }
  return null;
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
    case "drops-partition":
      return tx("Unsafe query: 'Alter' statement drops a partition with all its data");
    case "clears-partition":
      return tx("Unsafe query: 'Alter' statement clears all data in a partition");
    case "drops-history":
      return tx("Unsafe query: 'Alter' statement deletes the history of all rows");
  }
  if (u.kind === "merge-delete")
    return tx("Unsafe query: 'Merge' statement deletes all rows in the table because 'on' condition is always true");
  if (u.kind === "merge-update")
    return tx("Unsafe query: 'Merge' statement updates all rows in the table because 'on' condition is always true");
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

/** A number literal SQL and JavaScript read alike: no hex (a MySQL string), no integer past 2^53. */
function numberLiteral(text: string): number | undefined {
  if (!/^(\d+(\.\d*)?|\.\d+)([eE]\d+)?$/.test(text)) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) return undefined;
  // `0.1000000000000000001` would round to `0.1`.
  return text.replace(/^[0.]+|\.|[eE].*$/g, "").length <= 15 ? n : undefined;
}

/**
 * Integer arithmetic only: SQL's exact decimals (`0.1 + 0.2 = 0.3`) differ
 * from JavaScript's floating point.
 */
function arithmetic(op: string, a: number, b: number): number | undefined {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return undefined;
  const r = integerArithmetic(op, a, b);
  return r === undefined || Number.isSafeInteger(r) ? r : undefined;
}

function integerArithmetic(op: string, a: number, b: number): number | undefined {
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
      return b !== 0 ? a % b : undefined;
  }
  return undefined;
}

const INTEGER_TYPES = new Set([
  "INT",
  "INTEGER",
  "INT2",
  "INT4",
  "INT8",
  "SMALLINT",
  "BIGINT",
  "TINYINT",
  "MEDIUMINT",
  "SIGNED",
  "NUMERIC",
  "DECIMAL",
  "DEC",
]);
const TEXT_TYPES = new Set(["TEXT", "VARCHAR", "NVARCHAR", "STRING"]);
const BOOLEAN_TYPES = new Set(["BOOLEAN", "BOOL"]);

/**
 * `v` cast to the type `type` names, when the cast keeps it as it is: an
 * integer to a number type, a string to an unsized text type, a boolean to
 * boolean. Others (`1.5::int` rounds, `'ab'::varchar(1)` truncates, `'1'::int`
 * parses) are not certain.
 */
function cast(v: Value, type: readonly Token[]): Value {
  if (v === undefined || v === null) return v;
  if (type.length !== 1 || type[0]!.kind !== "word") return undefined;
  const name = type[0]!.upper;
  if (typeof v === "number") return Number.isInteger(v) && INTEGER_TYPES.has(name) ? v : undefined;
  if (typeof v === "string") return TEXT_TYPES.has(name) ? v : undefined;
  return BOOLEAN_TYPES.has(name) ? v : undefined;
}

/** `a IS NOT DISTINCT FROM b` / MySQL's `a <=> b`: equality where NULL equals NULL. */
function nullSafeEqual(a: Value, b: Value): Truth {
  if (a === undefined || b === undefined) return null;
  if (a === null || b === null) return a === b;
  const c = compare(a, b, true);
  return c === undefined ? null : c === 0;
}

/**
 * The value of a constant expression: literals (`N'…'` too), NULL, TRUE /
 * FALSE, parentheses, `+ - * / %` and casts that keep the value.
 */
function value(tokens: readonly Token[]): Value {
  if (!tokens.length) return undefined;
  if (wrapped(tokens)) return value(tokens.slice(1, -1));
  // `N'a'` (national), `E'a'` (escapes: only without any).
  const [prefix, literal] = tokens;
  if (tokens.length === 2 && prefix!.kind === "word" && literal!.kind === "string" && prefix!.to === literal!.from) {
    const plain = prefix!.upper === "N" || (prefix!.upper === "E" && !literal!.text.includes("\\"));
    return plain ? value([literal!]) : undefined;
  }
  if (tokens.length === 1) {
    const t = tokens[0]!;
    if (t.kind === "number") return numberLiteral(t.text);
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
  // `CAST(<expr> AS <type>)`
  if (isWord(tokens[0], "CAST") && wrapped(tokens.slice(1))) {
    const inner = tokens.slice(2, -1);
    const d = depths(inner);
    const as = inner.findIndex((t, i) => d[i] === 0 && isWord(t, "AS"));
    return as > 0 ? cast(value(inner.slice(0, as)), inner.slice(as + 1)) : undefined;
  }
  // `<expr>::<type>`, binding tighter than a sign (`-1::int`).
  for (let i = tokens.length - 1; i > 0; i--)
    if (depth[i] === 0 && tokens[i]!.text === "::") return cast(value(tokens.slice(0, i)), tokens.slice(i + 1));
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

  // `<expr> IS [NOT] NULL / TRUE / FALSE / UNKNOWN / DISTINCT FROM <expr>`
  const is = at("IS");
  if (is > 0) {
    const not = isWord(tokens[is + 1], "NOT");
    const rest = tokens.slice(is + (not ? 2 : 1));
    const left = tokens.slice(0, is);
    if (isWord(rest[0], "DISTINCT") && isWord(rest[1], "FROM")) {
      const same = nullSafeEqual(value(left), value(rest.slice(2)));
      return same === null ? null : same === not;
    }
    if (rest.length !== 1 || rest[0]!.kind !== "word") return null;
    const what = rest[0]!.upper;
    if (what === "NULL") {
      const v = value(left);
      return v === undefined ? null : (v === null) !== not;
    }
    if (what !== "TRUE" && what !== "FALSE" && what !== "UNKNOWN") return null;
    // An unknown left side (`NULL IS UNKNOWN`) counts as not constant: `term` does not tell it from data.
    const truth = term(left);
    if (truth === null) return null;
    return (what !== "UNKNOWN" && truth === (what === "TRUE")) !== not;
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
    // MySQL's null-safe `<=>` lexes as `<=` `>`.
    const next = tokens[op + 1];
    if (tokens[op]!.text === "<=" && next?.text === ">" && next.from === tokens[op]!.to)
      return nullSafeEqual(value(tokens.slice(0, op)), value(tokens.slice(op + 2)));
    const c = compare(
      value(tokens.slice(0, op)),
      value(tokens.slice(op + 1)),
      ["=", "<>", "!="].includes(tokens[op]!.text),
    );
    return c === undefined ? null : COMPARE[tokens[op]!.text]!(c);
  }

  // A bare constant: numbers are true unless 0 (MySQL, SQLite). NULL is unknown, not false:
  // `NOT NULL` matches nothing either.
  const v = value(tokens);
  if (typeof v === "number") return v !== 0;
  if (typeof v === "boolean") return v;
  return null;
}
