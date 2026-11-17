/**
 * Name resolution over console SQL: what an identifier refers to (table, CTE,
 * alias, column) for inspections (IDEA's "Unable to resolve…"), Go to
 * Declaration and Quick Documentation. Built on the caret analysis, so it is
 * as lexical and forgiving as completion; names it cannot judge (unknown
 * tables' columns, dialect pseudo-columns) are left alone.
 */
import type { DbCompletion, DbCompletionColumn, DbCompletionTable, DbDriver } from "@/platform/ipc";
import { analyze, type TableRef } from "./analyze";
import { CLAUSE_WORDS, DATA_TYPES, functions, isReserved, nameMatcher } from "./dialect";
import { identName, lex, type Lexed, type Token } from "./lexer";

export type SqlSymbol =
  | { kind: "table"; table: DbCompletionTable }
  | { kind: "cte"; name: string; def: Span }
  /** A FROM item's alias (or a derived table); `table` when it aliases a catalog table. */
  | { kind: "alias"; name: string; def: Span; table?: DbCompletionTable }
  | { kind: "column"; name: string; column?: DbCompletionColumn; table?: DbCompletionTable; owner: string }
  | { kind: "schema"; name: string };

export interface Span {
  from: number;
  to: number;
}

export interface Resolved extends Span {
  symbol: SqlSymbol | null;
  /** Set when the name should resolve but doesn't. */
  problem?: string;
}

export interface SqlProblem extends Span {
  message: string;
}

/** Statements whose names are checked; DDL and dialect commands are left alone. */
const CHECKED = new Set(["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "REPLACE"]);
/** Qualifiers with a meaning of their own (upserts, triggers). */
const PSEUDO_TABLES = new Set(["EXCLUDED", "NEW", "OLD"]);
/** Bare words that are not column references. */
const NOT_COLUMNS = new Set(
  (
    "TRUE FALSE NULL DEFAULT UNKNOWN CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP LOCALTIME LOCALTIMESTAMP " +
    "CURRENT_USER SESSION_USER USER INTERVAL ESCAPE COLLATE NULLS FIRST LAST DO NOTHING CONFLICT RECURSIVE " +
    "ROWID OID CTID _ROWID_ GLOB REGEXP MATCH ROWS RANGE GROUPS PRECEDING FOLLOWING UNBOUNDED CURRENT ROW OVER " +
    "PARTITION FILTER WITHIN ONLY TIES NEXT IGNORE ABORT FAIL ROLLBACK DUPLICATE KEY ISNULL NOTNULL SIMILAR " +
    "TOP PERCENT ANY SOME ALL DISTINCT ZONE YEAR MONTH DAY HOUR MINUTE SECOND EPOCH SEPARATOR PRIOR LEADING " +
    "TRAILING BOTH NOWAIT SKIP LOCKED SHARE MODE BINARY UNSIGNED SIGNED"
  ).split(" "),
);
/** Snowflake: select-list modifiers, sampling words, pseudo-columns and date parts. */
const SNOWFLAKE_NOT_COLUMNS = new Set(
  (
    "EXCLUDE RENAME REPLACE BERNOULLI SYSTEM BLOCK SEED REPEATABLE LEVEL RESPECT QUARTER WEEK WEEKOFYEAR DAYOFWEEK " +
    "DAYOFYEAR DAYOFMONTH MILLISECOND MICROSECOND NANOSECOND YEARS MONTHS DAYS HOURS MINUTES SECONDS WEEKS YY YYYY " +
    "MM MON DD HH MI SS MS US NS"
  ).split(" "),
);

export function findTable(
  model: DbCompletion | null,
  schema: string | null,
  name: string,
  driver: DbDriver = "sqlite",
): DbCompletionTable | undefined {
  const eq = nameMatcher(driver);
  const tables = model?.tables ?? [];
  if (schema) return tables.find((t) => eq(t.schema, schema) && eq(t.name, name));
  return (
    tables.find((t) => eq(t.schema, model?.defaultSchema) && eq(t.name, name)) ?? tables.find((t) => eq(t.name, name))
  );
}

const isName = (t: Token | undefined): t is Token => !!t && (t.kind === "word" || t.kind === "quoted");
const isP = (t: Token | undefined, p: string) => !!t && t.kind === "punct" && t.text === p;

export class SqlResolver {
  readonly lexed: Lexed;
  private readonly words: Set<string>;
  /** Token ranges `[a, b)` of the statements (`;` included), and each token's statement. */
  private readonly statements: Array<[number, number]> = [];
  private readonly statementOf: number[] = [];
  private readonly statementLexed = new Map<number, Lexed>();

  constructor(
    readonly text: string,
    readonly driver: DbDriver,
    readonly model: DbCompletion | null,
  ) {
    this.lexed = lex(text, driver);
    this.words = new Set([
      ...DATA_TYPES[driver].map((t) => t.toUpperCase()),
      ...functions(driver).map((f) => f.name.toUpperCase()),
    ]);
    let a = 0;
    this.lexed.tokens.forEach((t, i) => {
      this.statementOf.push(this.statements.length);
      if (isP(t, ";")) {
        this.statements.push([a, i + 1]);
        a = i + 1;
      }
    });
    this.statements.push([a, this.lexed.tokens.length]);
  }

  /** The tokens of token `i`'s statement: analysing only those keeps a long console linear. */
  private lexedFor(i: number): Lexed {
    const s = this.statementOf[i]!;
    let l = this.statementLexed.get(s);
    if (!l) {
      const [a, b] = this.statements[s]!;
      l = { tokens: this.lexed.tokens.slice(a, b), comments: this.lexed.comments };
      this.statementLexed.set(s, l);
    }
    return l;
  }

  /** The name token at `pos` (caret inside or at either edge). */
  tokenAt(pos: number): number {
    const toks = this.lexed.tokens;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.from > pos) break;
      if (pos <= t.to && isName(t)) return i;
    }
    return -1;
  }

  resolveAt(pos: number): Resolved | null {
    const i = this.tokenAt(pos);
    return i < 0 ? null : this.resolve(i);
  }

  /** Resolves token `i`; `null` when it is no name (keywords, function names…). */
  resolve(i: number): Resolved | null {
    const eq = nameMatcher(this.driver);
    const toks = this.lexed.tokens;
    const t = toks[i]!;
    if (!isName(t) || (t.kind === "word" && CLAUSE_WORDS.has(t.upper))) return null;
    if (this.driver === "snowflake" && isVariantKey(toks, i)) return null;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    const name = identName(t);
    const span = { from: t.from, to: t.to };
    const a = analyze(this.text, t.from, this.driver, this.lexedFor(i));
    const checked = CHECKED.has(a.verb);
    const loaded = !!this.model?.tables.length;
    const ctx = a.context;
    const qualifier = a.qualifier;

    // `x.` — a table reference (or schema) qualifying the next name.
    if (isP(next, ".") && next!.from === t.to && isName(toks[i + 2])) {
      if (ctx.kind === "table" || (qualifier && qualifier.length)) return this.schema(name, span);
      const ref = this.findRef(a.refs, null, name);
      if (ref) return { ...span, symbol: this.refSymbol(ref) };
      const cte = a.ctes.find((c) => eq(c.name, name));
      if (cte) return { ...span, symbol: { kind: "cte", name: cte.name, def: { from: cte.from, to: cte.to } } };
      if (this.model?.tables.some((x) => eq(x.schema, name))) return this.schema(name, span);
      if (!checked || PSEUDO_TABLES.has(name.toUpperCase()) || ctx.kind === "none") return { ...span, symbol: null };
      // Snowflake `database.schema.table.column`: other databases are not in the model.
      if (this.driver === "snowflake" && isP(toks[i + 3], ".") && isP(toks[i + 5], ".") && isName(toks[i + 6]))
        return { ...span, symbol: null };
      return { ...span, symbol: null, problem: `Unable to resolve symbol '${name}'` };
    }

    // An alias being defined.
    const defined = a.refs.find((r) => r.aliasAt?.from === t.from);
    if (defined) return { ...span, symbol: this.refSymbol(defined) };

    switch (ctx.kind) {
      case "none":
      case "statement":
        return null;
      case "table": {
        // Table functions (`generate_series(1, 3)`), `DROP TABLE IF EXISTS`.
        if (isP(next, "(") && !isIntoTarget(toks, i)) return null;
        if (t.kind === "word" && (t.upper === "IF" || t.upper === "ONLY" || t.upper === "LATERAL")) return null;
        const schema = qualifier?.at(-1) ?? null;
        const cte = schema ? undefined : a.ctes.find((c) => eq(c.name, name));
        if (cte) return { ...span, symbol: { kind: "cte", name: cte.name, def: { from: cte.from, to: cte.to } } };
        const table = findTable(this.model, schema, name, this.driver);
        if (table) return { ...span, symbol: { kind: "table", table } };
        if (!loaded || (a.verb !== "DROP" && a.verb !== "ALTER" && !checked)) return { ...span, symbol: null };
        if (schema && !this.model!.tables.some((x) => eq(x.schema, schema))) return { ...span, symbol: null };
        // Snowflake `database.schema.table`: the table may live in a database the model does not hold.
        if (this.driver === "snowflake" && qualifier && qualifier.length > 1) return { ...span, symbol: null };
        return { ...span, symbol: null, problem: `Unable to resolve table '${name}'` };
      }
      case "afterTable":
        return null;
      case "insertColumns": {
        const cols = this.columnsOf(ctx.target);
        const col = cols?.find((c) => eq(c.name, name));
        if (col || !cols || ctx.target.database)
          return { ...span, symbol: col ? this.columnSymbol(ctx.target, col) : null };
        return { ...span, symbol: null, problem: `Unable to resolve column '${name}'` };
      }
      case "afterInsertColumns":
        return null;
      case "column":
      case "joinCondition":
        break;
    }

    if (qualifier) {
      const ref =
        qualifier.length === 1
          ? this.findRef(a.refs, null, qualifier[0]!)
          : this.findRef(a.refs, qualifier.at(-2)!, qualifier.at(-1)!);
      if (!ref) return { ...span, symbol: null };
      const cols = this.columnsOf(ref);
      const col = cols?.find((c) => eq(c.name, name));
      if (col) return { ...span, symbol: this.columnSymbol(ref, col) };
      if (!cols || !checked || ref.database) return { ...span, symbol: null };
      return { ...span, symbol: null, problem: `Unable to resolve column '${name}'` };
    }

    // A bare word: a column unless it is a function, a type, a keyword or an alias being defined.
    if (isP(next, "(") || isP(next, "=>") || isP(prev, "::") || (prev?.kind === "word" && prev.upper === "AS"))
      return null;
    if (
      t.kind === "word" &&
      (isReserved(t.text, this.driver) ||
        NOT_COLUMNS.has(t.upper) ||
        this.words.has(t.upper) ||
        (this.driver === "snowflake" && (SNOWFLAKE_NOT_COLUMNS.has(t.upper) || t.upper.startsWith("METADATA$"))))
    )
      return null;
    // `count(*) n`, `x total`: an alias after an expression.
    if (
      prev &&
      (prev.kind === "quoted" ||
        prev.kind === "number" ||
        prev.kind === "string" ||
        isP(prev, ")") ||
        (prev.kind === "word" && !CLAUSE_WORDS.has(prev.upper)))
    )
      return null;
    for (const ref of a.refs) {
      const col = this.columnsOf(ref)?.find((c) => eq(c.name, name));
      if (col) return { ...span, symbol: this.columnSymbol(ref, col) };
    }
    const ref = this.findRef(a.refs, null, name);
    if (ref) return { ...span, symbol: this.refSymbol(ref) };
    const clause = ctx.kind === "column" ? ctx.clause : "on";
    const judged =
      checked &&
      loaded &&
      a.refs.length > 0 &&
      a.refs.every((r) => this.columnsOf(r) !== null && !r.database) &&
      clause !== "other" &&
      clause !== "values" &&
      clause !== "limit" &&
      !this.outputAliases(i).has(this.driver === "clickhouse" ? name : name.toLowerCase());
    return judged
      ? { ...span, symbol: null, problem: `Unable to resolve column '${name}'` }
      : { ...span, symbol: null };
  }

  /** Every unresolved name of the text. */
  problems(): SqlProblem[] {
    const out: SqlProblem[] = [];
    if (!this.model?.tables.length) return out;
    this.lexed.tokens.forEach((t, i) => {
      if (!isName(t)) return;
      const r = this.resolve(i);
      if (r?.problem) out.push({ from: r.from, to: r.to, message: r.problem });
    });
    return out;
  }

  private schema(name: string, span: Span): Resolved {
    const eq = nameMatcher(this.driver);
    return { ...span, symbol: this.model?.tables.some((x) => eq(x.schema, name)) ? { kind: "schema", name } : null };
  }

  private findRef(refs: readonly TableRef[], schema: string | null, name: string): TableRef | undefined {
    const eq = nameMatcher(this.driver);
    return refs.find((r) => (r.alias ? eq(r.alias, name) : eq(r.name, name) && (!schema || eq(r.schema, schema))));
  }

  private refSymbol(ref: TableRef): SqlSymbol {
    const table = ref.kind === "table" ? findTable(this.model, ref.schema, ref.name, this.driver) : undefined;
    if (ref.alias && ref.aliasAt) return { kind: "alias", name: ref.alias, def: ref.aliasAt, table };
    if (table) return { kind: "table", table };
    return { kind: "cte", name: ref.name, def: { from: ref.from, to: ref.to } };
  }

  /** Columns of a FROM item; `null` when unknown (not in the model, `select *` subqueries). */
  private columnsOf(ref: TableRef): Array<{ name: string; column?: DbCompletionColumn }> | null {
    if (ref.columns) return ref.columns.length ? ref.columns.map((name) => ({ name })) : null;
    const table = findTable(this.model, ref.schema, ref.name, this.driver);
    // A table listed without columns is one whose columns were not read (a large Snowflake database).
    return table?.columns.length ? table.columns.map((c) => ({ name: c.name, column: c })) : null;
  }

  private columnSymbol(ref: TableRef, col: { name: string; column?: DbCompletionColumn }): SqlSymbol {
    const table = ref.kind === "table" ? findTable(this.model, ref.schema, ref.name, this.driver) : undefined;
    return { kind: "column", name: col.name, column: col.column, table, owner: ref.alias ?? ref.name };
  }

  /** Select-list aliases of token `i`'s statement (usable in ORDER BY / GROUP BY / HAVING). */
  private outputAliases(i: number): Set<string> {
    const out = new Set<string>();
    const toks = this.lexedFor(i).tokens;
    for (let k = 1; k < toks.length; k++) {
      const t = toks[k]!;
      if (!isName(t)) continue;
      const prev = toks[k - 1]!;
      if (
        (prev.kind === "word" && prev.upper === "AS") ||
        isP(prev, ")") ||
        prev.kind === "number" ||
        prev.kind === "string"
      )
        out.add(this.driver === "clickhouse" ? identName(t) : identName(t).toLowerCase());
    }
    return out;
  }
}

/** Whether name token `i` is a key of a Snowflake VARIANT path: `src:a.b`, `src['a'].b`. */
function isVariantKey(toks: readonly Token[], i: number): boolean {
  let j = i;
  while (isP(toks[j - 1], ".")) {
    if (isP(toks[j - 2], "]")) return true;
    if (!isName(toks[j - 2])) return false;
    j -= 2;
  }
  return isP(toks[j - 1], ":") && toks[j - 1]!.to === toks[j]!.from;
}

/** Whether token `i` follows INSERT / REPLACE INTO (so a `(` after it lists columns). */
function isIntoTarget(toks: readonly Token[], i: number): boolean {
  let j = i - 1;
  while (isP(toks[j], ".") && isName(toks[j - 1])) j -= 2;
  return toks[j]?.kind === "word" && toks[j]!.upper === "INTO";
}
