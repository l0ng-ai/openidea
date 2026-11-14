/**
 * Whether a console result can be edited in place, like DataGrip's: only when
 * the query is a plain select of one base table's rows — no joins, derived
 * tables, CTEs, `DISTINCT` / `GROUP BY` / `HAVING` / window functions or set
 * operations — and its select list maps to that table's columns (plain column
 * references and `*`; aliased columns and expressions stay read-only). Purely
 * lexical over the statement's tokens, like the completion analysis.
 */
import type { DbCellValue, DbCompletion, DbDriver, DbRowEdit } from "@/platform/ipc";
import { quoteIdent } from "./sql/complete";
import { CLAUSE_WORDS, functions } from "./sql/dialect";
import { identName, lex, type Token } from "./sql/lexer";

const sqlName = (token: Token, driver: DbDriver): string => {
  const name = identName(token);
  if (token.kind === "quoted") return name;
  if (driver === "postgres") return name.toLowerCase();
  return driver === "oracle" || driver === "snowflake" ? name.toUpperCase() : name;
};

/** One select list item. */
export type SelectItem =
  /** `*` or `t.*`: every column of the table. */
  | { kind: "star"; qualifier: string | null }
  /** A plain column reference (`col`, `t.col`…); `qualifier` is what it is qualified with, when written. */
  | { kind: "column"; qualifier: string | null; name: string }
  /** Anything else — an aliased column, a literal, a function call…: the column stays read-only. */
  | { kind: "expression" };

/** Why a result cannot be edited. */
export type EditBlockReason =
  /** The query joins several tables. */
  | "joined"
  /** `DISTINCT`, `GROUP BY` / `HAVING`, a window function or an aggregate. */
  | "aggregated"
  /** `UNION` / `INTERSECT` / `EXCEPT`. */
  | "setOp"
  /** Not a plain select of one base table (another verb, a CTE, a derived table, no `FROM`…). */
  | "plain";

export type ResultEditability =
  | {
      kind: "editable";
      /** The table's schema as written (`null`: unqualified). */
      schema: string | null;
      table: string;
      /** The FROM item's alias, when written (`users u`, `users AS u`). */
      alias: string | null;
      /** The select list, positionally aligned with the result's columns. */
      items: SelectItem[];
    }
  | { kind: "readonly"; reason: EditBlockReason };

const SET_OPS = new Set(["UNION", "INTERSECT", "EXCEPT", "MINUS"]);
const JOIN_WORDS = new Set([
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "NATURAL",
  "OUTER",
  "STRAIGHT_JOIN",
  "LATERAL",
]);
/** Words that end the FROM items (the clauses that may follow them). */
const AFTER_FROM = new Set(["WHERE", "ORDER", "LIMIT", "OFFSET", "FETCH", "FOR"]);

const isIdent = (t: Token | undefined): t is Token =>
  !!t && (t.kind === "quoted" || (t.kind === "word" && !CLAUSE_WORDS.has(t.upper)));
const isStar = (t: Token | undefined) => !!t && t.kind === "punct" && t.text === "*";
const readonly = (reason: EditBlockReason): ResultEditability => ({ kind: "readonly", reason });

/** The aggregate functions of the driver's dialect (`COUNT`, `SUM`…). */
const aggregatesOf = (driver: DbDriver) =>
  new Set(
    functions(driver)
      .filter((f) => f.aggregate)
      .map((f) => f.name.toUpperCase()),
  );

/** Length of the identifier chain (`a`, `a.b`, `a.b.c`…, dots included) the tokens start with. */
const chainLength = (tokens: readonly Token[]): number => {
  if (!isIdent(tokens[0])) return 0;
  let n = 1;
  while (tokens[n]?.kind === "punct" && tokens[n]!.text === "." && isIdent(tokens[n + 1])) n += 2;
  return n;
};

/** One select list item: an identifier chain, plain or ending in `.*`, or an expression. */
const selectItemOf = (item: readonly Token[], driver: DbDriver): SelectItem => {
  if (item.length === 1 && isStar(item[0])) return { kind: "star", qualifier: null };
  if (item.length >= 3 && isStar(item.at(-1)) && item.at(-2)!.text === "." && item.at(-2)!.kind === "punct") {
    const chain = item.slice(0, -2);
    const n = chainLength(chain);
    return n === chain.length && n > 0
      ? { kind: "star", qualifier: sqlName(chain.at(-1)!, driver) }
      : { kind: "expression" };
  }
  const n = chainLength(item);
  if (n !== item.length || n === 0) return { kind: "expression" };
  return n === 1
    ? { kind: "column", qualifier: null, name: sqlName(item[0]!, driver) }
    : // `a.b` / `a.b.c`: the qualifier is the ident before the last dot.
      { kind: "column", qualifier: sqlName(item.at(-3)!, driver), name: sqlName(item.at(-1)!, driver) };
};

/**
 * What a console statement's result grid can do: `editable` with the base
 * table and the select list, or `readonly` with the reason.
 */
export function resultEditability(text: string, driver: DbDriver): ResultEditability {
  const lexed = lex(text, driver);
  if (lexed.comments.some((c) => text.slice(c.from + 2, c.to).includes("/*"))) return readonly("plain");
  if (driver === "mysql" && lexed.comments.some((c) => /^\/\*(?:!|M!)/i.test(text.slice(c.from, c.to))))
    return readonly("plain");
  const all = lexed.tokens;
  if (driver === "postgres" && all.some((t) => t.kind === "string" && t.text.includes("\\"))) return readonly("plain");
  if (all.some((t) => t.kind === "word" && SET_OPS.has(t.upper))) return readonly("setOp");
  if (all.at(-1)?.text === ";") all.pop();
  if (
    all.some(
      (t, i) =>
        (t.kind === "word" && (t.upper === "SELECT" || t.upper === "WITH") && i > 0) ||
        (t.kind === "punct" && t.text === ";"),
    )
  )
    return readonly("plain");
  const start = 0;
  const t0 = all[start];
  if (!t0 || t0.kind !== "word" || t0.upper !== "SELECT") return readonly("plain");
  const aggregates = aggregatesOf(driver);

  // Top-level landmarks over the whole statement (the lexer dropped comments).
  let depth = 0;
  let from = -1;
  for (let j = start; j < all.length; j++) {
    const tok = all[j]!;
    if (tok.kind === "punct") {
      if (tok.text === "(") depth++;
      else if (tok.text === ")") depth--;
    }
    if (tok.kind === "word" && (tok.upper === "OVER" || tok.upper === "WINDOW")) return readonly("aggregated");
    if (tok.kind === "word" && aggregates.has(tok.upper) && all[j + 1]?.text === "(") return readonly("aggregated");
    if (depth !== 0 || tok.kind !== "word") continue;
    const w = tok.upper;
    if (j === start + 1 && w === "DISTINCT") return readonly("aggregated");
    if (w === "INTO") return readonly("plain");
    if (w === "GROUP" || w === "HAVING") return readonly("aggregated");
    if (w === "FROM" && from < 0) from = j;
  }
  if (from < 0) return readonly("plain");

  const selectList = all.slice(start + 1, from);
  if (!selectList.length) return readonly("plain");

  // Select items: top-level commas separate them.
  const items: SelectItem[] = [];
  let itemStart = 0;
  let itemDepth = 0;
  for (let j = 0; j <= selectList.length; j++) {
    const tok = selectList[j];
    const ends = j === selectList.length;
    if (tok?.kind === "punct") {
      if (tok.text === "(") itemDepth++;
      else if (tok.text === ")") itemDepth--;
    }
    if (!ends && !(itemDepth === 0 && tok!.kind === "punct" && tok!.text === ",")) continue;
    const item = selectList.slice(itemStart, j);
    itemStart = j + 1;
    if (item.length) items.push(selectItemOf(item, driver));
  }
  if (!items.length) return readonly("plain");

  // The FROM items: one `[schema.]table` (with an optional alias) and nothing else.
  const rest = all.slice(from + 1);
  let end = rest.length;
  depth = 0;
  for (let j = 0; j < rest.length; j++) {
    const tok = rest[j]!;
    if (tok.kind === "punct") {
      if (tok.text === "(") depth++;
      else if (tok.text === ")") depth--;
    }
    if (depth === 0 && tok.kind === "word" && AFTER_FROM.has(tok.upper)) {
      end = j;
      break;
    }
  }
  const item = rest.slice(0, end);
  if (item[0]?.kind === "word" && item[0].upper === "ONLY") return readonly("plain");
  // A statement's trailing `;` is not part of the FROM item.
  while (item.at(-1)?.kind === "punct" && item.at(-1)!.text === ";") item.pop();
  if (!item.length || item[0]!.kind === "punct") return readonly("plain"); // a derived table or a parenthesized join
  const n = chainLength(item);
  if (!n || n > 3) return readonly("plain");
  let at = n;
  let alias: string | null = null;
  if (item[at]?.kind === "word" && item[at]!.upper === "AS") {
    at++;
    if (!isIdent(item[at])) return readonly("plain");
    alias = sqlName(item[at]!, driver);
    at++;
  } else if (isIdent(item[at])) {
    alias = sqlName(item[at]!, driver);
    at++;
  }
  if (at < item.length) {
    const tok = item[at]!;
    if (tok.kind === "punct" && tok.text === ",") return readonly("joined");
    if (tok.kind === "word" && JOIN_WORDS.has(tok.upper)) return readonly("joined");
    return readonly("plain");
  }
  return {
    kind: "editable",
    // The ident before the last one (`public.users`, `db.schema.table`; dots are part of `n`).
    schema: n >= 3 ? sqlName(item[n - 3]!, driver) : null,
    table: sqlName(item[n - 1]!, driver),
    alias,
    items,
  };
}

/** Resolve unqualified names in the schema used to execute this result. */
export function resolveTarget(
  e: Extract<ResultEditability, { kind: "editable" }>,
  model: DbCompletion | null,
  schema?: string,
  driver: DbDriver = "postgres",
): { schema: string | null; table: string; alias: string | null } | null {
  // SQL Server switches databases, but table details and edits take a table schema.
  if (driver === "sqlServer" && (e.schema === null || (schema && schema !== model?.defaultSchema))) return null;
  if (e.schema === null && schema === "") return null;
  return { schema: e.schema ?? (schema || model?.defaultSchema || null), table: e.table, alias: e.alias };
}

/**
 * The table column behind each result column: the select items aligned
 * positionally with the result's columns. `null` for expressions and aliased
 * columns, and for `*` columns the table doesn't have. `tableColumns` may be
 * `null` while the table's details are loading (the names are then trusted).
 */
export function resultColumnSources(
  items: readonly SelectItem[],
  resultNames: readonly string[],
  tableColumns: readonly string[] | null,
  eq: (a: string | null | undefined, b: string | null | undefined) => boolean,
): Array<string | null> {
  const sources: Array<string | null> = resultNames.map(() => null);
  let r = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const pending = items.length - i - 1;
    if (r >= resultNames.length) break;
    if (item.kind === "column") {
      const name = tableColumns?.find((c) => eq(c, item.name)) ?? (tableColumns ? null : item.name);
      sources[r] = name && eq(resultNames[r], name) ? name : null;
      r++;
    } else if (item.kind === "expression") {
      r++;
    } else {
      // `*`: every result column left for it (the items after it need theirs).
      const take = Math.max(0, resultNames.length - r - pending);
      for (let k = 0; k < take && r < resultNames.length; k++, r++) {
        const name = resultNames[r]!;
        if (!tableColumns || tableColumns.some((c) => eq(c, name))) sources[r] = name;
      }
    }
  }
  return r === resultNames.length ? sources : resultNames.map(() => null);
}

/**
 * The result columns that carry the table's primary key (their names go into
 * the generated `UPDATE` / `DELETE`), or `null` when the result doesn't
 * include every key column.
 */
export function pkResultColumns(
  tablePk: readonly string[],
  sources: ReadonlyArray<string | null>,
  resultNames: readonly string[],
  eq: (a: string | null | undefined, b: string | null | undefined) => boolean,
): string[] | null {
  if (!tablePk.length || resultNames.some((name, i) => resultNames.slice(0, i).some((other) => eq(name, other))))
    return null;
  const out: string[] = [];
  for (const key of tablePk) {
    const at = sources.findIndex((s) => s !== null && eq(s, key));
    if (at < 0) return null;
    out.push(resultNames[at]!);
  }
  return out;
}

const literalOf = (driver: DbDriver, v: string | null): string => {
  if (v === null) return "NULL";
  let s = v.replace(/'/g, "''");
  if (driver === "mysql" || driver === "clickhouse" || driver === "snowflake") s = s.replace(/\\/g, "\\\\");
  return `'${s}'`;
};

const conditionOf = (driver: DbDriver, key: readonly DbCellValue[]): string =>
  key
    .map((c) =>
      c.value === null
        ? `${quoteIdent(c.column, driver)} IS NULL`
        : `${quoteIdent(c.column, driver)} = ${literalOf(driver, c.value)}`,
    )
    .join(" AND ");

/**
 * The statements `dbApplyEdits` runs for `edits`, for the console's Output
 * log: the same `UPDATE` / `INSERT` / `DELETE` the backend generates.
 */
export function editStatements(driver: DbDriver, schema: string, table: string, edits: readonly DbRowEdit[]): string[] {
  const quoted = (name: string) => quoteIdent(name, driver);
  const target = schema ? `${quoted(schema)}.${quoted(table)}` : quoted(table);
  return edits.map((e) => {
    const literal = (c: DbCellValue) => `${quoted(c.column)} = ${literalOf(driver, c.value)}`;
    switch (e.kind) {
      case "update":
        return `UPDATE ${target} SET ${e.values.map(literal).join(", ")} WHERE ${conditionOf(driver, e.key)}`;
      case "delete":
        return `DELETE FROM ${target} WHERE ${conditionOf(driver, e.key)}`;
      default:
        return e.values.length
          ? `INSERT INTO ${target} (${e.values.map((c) => quoted(c.column)).join(", ")}) VALUES (${e.values
              .map((c) => literalOf(driver, c.value))
              .join(", ")})`
          : driver === "mysql"
            ? `INSERT INTO ${target} () VALUES ()`
            : `INSERT INTO ${target} DEFAULT VALUES`;
    }
  });
}
