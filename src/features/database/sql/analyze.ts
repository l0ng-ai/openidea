/**
 * Caret analysis for SQL completion: the statement and query block around the
 * caret, the tables it can see (FROM / JOIN items with aliases, CTEs, derived
 * tables, enclosing queries for correlated subqueries) and what is expected at
 * the caret (a statement, a table, a column expression, a join condition…).
 * Purely lexical: works on half-typed statements a parser would reject.
 */
import type { DbDriver } from "@/platform/ipc";
import { CLAUSE_WORDS, isReserved } from "./dialect";
import { identName, inLiteral, lex, type Lexed, type Token } from "./lexer";

export interface TableRef {
  /** Schema as written (`null`: unqualified). */
  schema: string | null;
  /** Table / CTE name; a derived table's alias. */
  name: string;
  alias: string | null;
  /** Offsets of the alias token. */
  aliasAt: { from: number; to: number } | null;
  kind: "table" | "cte" | "derived";
  /** Columns known from the query text (CTEs, derived tables); `null` for catalog tables. */
  columns: string[] | null;
  /** Offsets of the (last part of the) name. */
  from: number;
  to: number;
  /** 0: the caret's query block; 1+: enclosing blocks (correlated references). */
  depth: number;
  /** Introduced by JOIN (so `ON` may follow). */
  viaJoin: boolean;
}

export type Clause =
  | "select"
  | "from"
  | "where"
  | "group"
  | "order"
  | "having"
  | "limit"
  | "set"
  | "values"
  | "on"
  | "returning"
  | "other";

export type SqlContext =
  | { kind: "none" }
  | { kind: "statement" }
  | { kind: "table"; join: boolean }
  /** Right after a FROM / JOIN item (alias, JOIN, WHERE…). */
  | { kind: "afterTable"; ref: TableRef }
  | { kind: "column"; clause: Clause }
  | { kind: "joinCondition"; ref: TableRef }
  | { kind: "insertColumns"; target: TableRef }
  | { kind: "afterInsertColumns" };

export interface Analysis {
  context: SqlContext;
  /** Identifier chain before the caret word: `s.t.na|` → `["s", "t"]`. */
  qualifier: string[] | null;
  /** The word being typed (start offset and text up to the caret). */
  prefix: { from: number; text: string };
  /** Tables visible at the caret, innermost block first. */
  refs: TableRef[];
  ctes: TableRef[];
  statement: { from: number; to: number; text: string };
  /** First word of the statement, upper-cased. */
  verb: string;
  /** Where `FROM t` goes for a SELECT that has no FROM yet (`null`: it has one). */
  fromInsert: number | null;
  /** Keyword case the statement is written in. */
  lowerKeywords: boolean;
  /** The token before the caret word (and its qualifier), upper-cased: `(`, `UNION`… */
  previous: string | null;
}

const WORD_BEFORE = /[\p{L}\p{N}_$]*$/u;
const TABLE_INTRO = new Set(["FROM", "JOIN", "UPDATE", "INTO", "TABLE", "TRUNCATE", "DESCRIBE", "STRAIGHT_JOIN"]);
const CLAUSES: Record<string, Clause> = {
  SELECT: "select",
  FROM: "from",
  JOIN: "from",
  STRAIGHT_JOIN: "from",
  WHERE: "where",
  GROUP: "group",
  ORDER: "order",
  HAVING: "having",
  LIMIT: "limit",
  OFFSET: "limit",
  SET: "set",
  VALUES: "values",
  ON: "on",
  USING: "on",
  RETURNING: "returning",
  WINDOW: "other",
};
const SET_OPS = new Set(["UNION", "INTERSECT", "EXCEPT"]);
const QUERY_START = new Set(["SELECT", "WITH", "VALUES", "TABLE"]);

const isIdent = (t: Token | undefined): t is Token =>
  !!t && (t.kind === "quoted" || (t.kind === "word" && !CLAUSE_WORDS.has(t.upper)));
const isP = (t: Token | undefined, p: string) => !!t && t.kind === "punct" && t.text === p;
const isW = (t: Token | undefined, ...w: string[]) => !!t && t.kind === "word" && w.includes(t.upper);

/** Bracket structure of a token list. */
class Parens {
  /** `(` index → matching `)` index (or `tokens.length` when unclosed). */
  readonly close = new Map<number, number>();
  /** Token index → index of the innermost enclosing `(` (−1 at top level). */
  readonly parent: number[];
  constructor(readonly t: Token[]) {
    const stack: number[] = [];
    this.parent = t.map((tok, i) => {
      const p = stack.at(-1) ?? -1;
      if (isP(tok, "(")) stack.push(i);
      else if (isP(tok, ")") && stack.length) {
        this.close.set(stack.pop()!, i);
        return stack.at(-1) ?? -1;
      }
      return p;
    });
    for (const open of stack) this.close.set(open, t.length);
  }
  /** Indices in `a..b` directly inside group `g` (not nested deeper). */
  level(g: number, a: number, b: number): number[] {
    const out: number[] = [];
    for (let i = a; i < b; i++) if (this.parent[i] === g) out.push(i);
    return out;
  }
}

export function analyze(text: string, pos: number, driver: DbDriver, lexed: Lexed = lex(text, driver)): Analysis {
  const word = WORD_BEFORE.exec(text.slice(Math.max(0, pos - 256), pos))![0];
  const prefix = { from: pos - word.length, text: word };
  const all = lexed.tokens;

  // The statement: between the `;` before the caret word and the next one.
  let a = 0;
  let b = all.length;
  for (let i = 0; i < all.length; i++) {
    if (!isP(all[i], ";")) continue;
    if (all[i]!.to <= prefix.from) a = i + 1;
    else {
      b = i;
      break;
    }
  }
  const st = all.slice(a, b);
  const sFrom = a > 0 ? all[a - 1]!.to : 0;
  const sTo = b < all.length ? all[b]!.from : text.length;
  const statement = { from: sFrom, to: sTo, text: text.slice(sFrom, sTo) };
  const verb = st[0]?.kind === "word" ? st[0].upper : "";
  const firstKeyword = st.find((t) => t.kind === "word" && CLAUSE_WORDS.has(t.upper));
  const lowerKeywords = !!firstKeyword && firstKeyword.text === firstKeyword.text.toLowerCase();

  const parens = new Parens(st);
  // Tokens before the caret word (a word the caret is inside of is the prefix).
  let nb = 0;
  while (nb < st.length && st[nb]!.to <= prefix.from) nb++;
  const before = st.slice(0, nb);

  // Open parens around the caret, innermost last.
  const open: number[] = [];
  for (let i = 0; i < nb; i++) {
    if (isP(st[i], "(")) open.push(i);
    else if (isP(st[i], ")")) open.pop();
  }
  const isQuery = (p: number) => p === -1 || (st[p + 1]?.kind === "word" && QUERY_START.has(st[p + 1]!.upper));
  const blocks = [...open.filter(isQuery).reverse(), -1];

  const ctes = parseCtes(st, parens);
  const refs: TableRef[] = [];
  const refEnds = new Map<number, TableRef>();
  blocks.forEach((g, depth) => {
    // Within an enclosing block, the "caret" is the paren of the block nested in it.
    const [ra, rb] = blockRange(st, parens, g, depth === 0 ? nb : blocks[depth - 1]!);
    for (const r of parseRefs(st, parens, g, ra, rb, ctes, depth, driver)) {
      refs.push(r.ref);
      if (depth === 0) refEnds.set(r.end, r.ref);
    }
  });

  const literal = inLiteral(lexed, pos);
  const qualifier: string[] = [];
  let k = before.length - 1;
  while (
    isP(before[k], ".") &&
    (before[k - 1]?.kind === "word" || before[k - 1]?.kind === "quoted") &&
    before[k]!.to === (k + 1 < before.length ? before[k + 1]!.from : prefix.from)
  ) {
    qualifier.unshift(identName(before[k - 1]!));
    k -= 2;
  }
  const p = before[k];
  const pi = k;
  const block = blocks[0]!;
  const clause = clauseAt(st, parens, block, open.length ? open.at(-1)! : -1, nb);

  let context: SqlContext;
  if (literal) context = { kind: "none" };
  else if (!p) context = qualifier.length ? { kind: "column", clause: "other" } : { kind: "statement" };
  else if (
    p.kind === "word" &&
    TABLE_INTRO.has(p.upper) &&
    !(p.upper === "TABLE" && verb !== "TABLE" && !isW(before[pi - 1], "ALTER", "DROP", "TRUNCATE", "LOCK"))
  )
    context = { kind: "table", join: p.upper === "JOIN" || p.upper === "STRAIGHT_JOIN" };
  else if (isW(p, "LATERAL", "ONLY") && isW(before[pi - 1], "JOIN", "FROM"))
    context = { kind: "table", join: isW(before[pi - 1], "JOIN") };
  else if (isP(p, ",") && clause === "from" && parens.parent[pi] === block) context = { kind: "table", join: false };
  else if (isW(p, "AS") || isP(p, "::")) context = { kind: "none" };
  else if (refEnds.has(pi) && !qualifier.length && (clause === "from" || clause === "other")) {
    const ref = refEnds.get(pi)!;
    context = { kind: "afterTable", ref };
  } else if (isW(p, "ON") || (clause === "on" && isW(p, "AND", "OR"))) {
    const joined = [...refs].filter((r) => r.depth === 0 && r.from < (p?.from ?? pos)).at(-1);
    context = joined ? { kind: "joinCondition", ref: joined } : { kind: "column", clause: "on" };
  } else {
    const ins = insertTarget(st, parens, open.at(-1), refEnds);
    if (ins && (isP(p, "(") || isP(p, ","))) context = { kind: "insertColumns", target: ins };
    else if (isP(p, ")") && insertTarget(st, parens, [...parens.close].find(([, c]) => c === pi)?.[0], refEnds))
      context = { kind: "afterInsertColumns" };
    else context = { kind: "column", clause };
  }

  return {
    context,
    qualifier: qualifier.length ? qualifier : null,
    prefix,
    refs,
    ctes,
    statement,
    verb,
    fromInsert: fromInsertPos(st, parens, block, pos),
    lowerKeywords,
    previous: p ? p.upper : null,
  };
}

/** Token range of block `g`, cut to the UNION / INTERSECT / EXCEPT branch containing `caret` (a token index). */
function blockRange(st: Token[], parens: Parens, g: number, caret: number): [number, number] {
  let a = g + 1;
  let b = g === -1 ? st.length : (parens.close.get(g) ?? st.length);
  for (const i of parens.level(g, a, b)) {
    if (!SET_OPS.has(st[i]!.upper) || st[i]!.kind !== "word") continue;
    if (i < caret) a = i + 1;
    else {
      b = i;
      break;
    }
  }
  return [a, b];
}

/** The clause the caret is in: the last clause keyword of its block before it. */
function clauseAt(st: Token[], parens: Parens, block: number, innermost: number, caret: number): Clause {
  // Inside a non-query paren (function call, IN list), the clause is the one around that paren.
  const limit = innermost > block ? innermost : caret;
  let clause: Clause = "other";
  for (const i of parens.level(block, block + 1, limit)) {
    const t = st[i]!;
    if (t.kind !== "word") continue;
    if (SET_OPS.has(t.upper)) clause = "other";
    const c = CLAUSES[t.upper];
    if (c) clause = c;
  }
  return clause;
}

function parseCtes(st: Token[], parens: Parens): TableRef[] {
  const out: TableRef[] = [];
  if (!isW(st[0], "WITH")) return out;
  let i = 1;
  if (isW(st[i], "RECURSIVE")) i++;
  while (i < st.length && isIdent(st[i])) {
    const nameTok = st[i]!;
    i++;
    let columns: string[] | null = null;
    if (isP(st[i], "(")) {
      const c = parens.close.get(i)!;
      columns = parens
        .level(i, i + 1, c)
        .filter((j) => isIdent(st[j]))
        .map((j) => identName(st[j]!));
      i = c + 1;
    }
    if (!isW(st[i], "AS")) break;
    i++;
    while (isW(st[i], "NOT", "MATERIALIZED")) i++;
    if (!isP(st[i], "(")) break;
    const c = parens.close.get(i)!;
    columns ??= outputColumns(st, parens, i, i + 1, c);
    out.push({
      schema: null,
      name: identName(nameTok),
      alias: null,
      aliasAt: null,
      kind: "cte",
      columns,
      from: nameTok.from,
      to: nameTok.to,
      depth: 0,
      viaJoin: false,
    });
    i = c + 1;
    if (!isP(st[i], ",")) break;
    i++;
  }
  return out;
}

/** Output column names of the query in group `g` (`a..b`): aliases and plain column references. */
export function outputColumns(st: Token[], parens: Parens, g: number, a: number, b: number): string[] {
  const level = parens.level(g, a, b);
  const sel = level.find((i) => isW(st[i], "SELECT"));
  if (sel === undefined) return [];
  const out: string[] = [];
  let item: number[] = [];
  const flush = () => {
    const last = st[item.at(-1)!];
    const prev = item.length > 1 ? st[item.at(-2)!] : undefined;
    if (last && (last.kind === "word" || last.kind === "quoted") && !isW(last, "DISTINCT")) {
      if (
        item.length === 1 ||
        isW(prev, "AS") ||
        isP(prev, ".") ||
        isP(prev, ")") ||
        prev?.kind === "word" ||
        prev?.kind === "quoted"
      )
        out.push(identName(last));
    }
    item = [];
  };
  for (const i of level) {
    if (i <= sel) continue;
    const t = st[i]!;
    if (
      t.kind === "word" &&
      (t.upper === "FROM" ||
        t.upper === "WHERE" ||
        t.upper === "GROUP" ||
        t.upper === "ORDER" ||
        t.upper === "LIMIT" ||
        SET_OPS.has(t.upper))
    )
      break;
    if (isW(t, "DISTINCT", "ALL") && !item.length) continue;
    if (isP(t, ",")) flush();
    else item.push(i);
  }
  if (item.length) flush();
  return out;
}

/** FROM / JOIN / UPDATE / INTO items of block `g` within `a..b`, each with the index of its last token. */
function parseRefs(
  st: Token[],
  parens: Parens,
  g: number,
  a: number,
  b: number,
  ctes: TableRef[],
  depth: number,
  driver: DbDriver,
): Array<{ ref: TableRef; end: number }> {
  const out: Array<{ ref: TableRef; end: number }> = [];
  const level = parens.level(g, a, b);
  let clause: Clause = "other";
  const item = (j: number, viaJoin = false, into = false) => {
    while (isW(st[j], "LATERAL", "ONLY")) j++;
    const t = st[j];
    if (!t || j >= b) return;
    if (isP(t, "(")) {
      const c = parens.close.get(j)!;
      const columns = outputColumns(st, parens, j, j + 1, c);
      const al = alias(st, c + 1, b);
      if (al)
        out.push({
          ref: {
            schema: null,
            name: al.name,
            alias: al.name,
            aliasAt: { from: al.tok.from, to: al.tok.to },
            kind: "derived",
            columns,
            from: al.tok.from,
            to: al.tok.to,
            depth,
            viaJoin,
          },
          end: al.end,
        });
      return;
    }
    if (!isIdent(t)) return;
    const parts = [t];
    let k = j + 1;
    while (isP(st[k], ".") && (st[k + 1]?.kind === "word" || st[k + 1]?.kind === "quoted")) {
      parts.push(st[k + 1]!);
      k += 2;
    }
    let end = k - 1;
    if (isP(st[k], "(") && !into) {
      // Table function: `generate_series(1, 3) g` (`INSERT INTO t (` is a column list).
      end = parens.close.get(k) ?? k;
      k = end + 1;
    }
    const last = parts.at(-1)!;
    const name = identName(last);
    const schema = parts.length > 1 ? identName(parts.at(-2)!) : null;
    const al = alias(st, k, b);
    const cte =
      schema === null
        ? ctes.find((c) => (driver === "clickhouse" ? c.name === name : c.name.toLowerCase() === name.toLowerCase()))
        : undefined;
    out.push({
      ref: {
        schema,
        name,
        alias: al?.name ?? null,
        aliasAt: al ? { from: al.tok.from, to: al.tok.to } : null,
        kind: cte ? "cte" : "table",
        columns: cte?.columns ?? null,
        from: last.from,
        to: last.to,
        depth,
        viaJoin,
      },
      end: al?.end ?? end,
    });
  };
  for (const i of level) {
    const t = st[i]!;
    if (t.kind === "word") {
      if (TABLE_INTRO.has(t.upper) && t.upper !== "TABLE") {
        // `INSERT INTO`, `DELETE FROM`, `SELECT … INTO var` (MySQL) — only tables matter here.
        clause = "from";
        item(i + 1, t.upper === "JOIN" || t.upper === "STRAIGHT_JOIN", t.upper === "INTO");
        continue;
      }
      const c = CLAUSES[t.upper];
      if (c) clause = c;
    } else if (isP(t, ",") && clause === "from") item(i + 1);
  }
  return out;
}

/** An alias at `k` (`AS x`, or a bare non-keyword identifier). */
function alias(st: Token[], k: number, b: number): { name: string; tok: Token; end: number } | null {
  let j = k;
  const as = isW(st[j], "AS");
  if (as) j++;
  const t = st[j];
  if (j >= b || !t) return null;
  if (t.kind === "quoted" || (t.kind === "word" && !CLAUSE_WORDS.has(t.upper) && (as || !isReserved(t.text)))) {
    return { name: identName(t), tok: t, end: j };
  }
  return null;
}

/** The INSERT target when `open` is the `(` right after it (`INSERT INTO t (`). */
function insertTarget(
  st: Token[],
  parens: Parens,
  open: number | undefined,
  refEnds: Map<number, TableRef>,
): TableRef | null {
  if (open === undefined || !isP(st[open], "(")) return null;
  const ref = refEnds.get(open - 1);
  if (!ref) return null;
  // The ref must be introduced by INTO.
  for (let i = open - 1; i >= 0; i--) {
    if (isW(st[i], "INTO")) return parens.parent[i] === parens.parent[open] ? ref : null;
    if (st[i]!.kind === "word" && CLAUSE_WORDS.has(st[i]!.upper)) return null;
  }
  return null;
}

/** For a SELECT block without FROM: the offset to append `FROM t` at (end of its select list). */
function fromInsertPos(st: Token[], parens: Parens, block: number, pos: number): number | null {
  const end = block === -1 ? st.length : (parens.close.get(block) ?? st.length);
  const level = parens.level(block, block + 1, end);
  if (!level.length || !isW(st[level[0]!], "SELECT")) return null;
  for (const i of level) {
    const t = st[i]!;
    if (t.kind === "word" && CLAUSES[t.upper] && t.upper !== "SELECT") return null;
    if (t.kind === "word" && (SET_OPS.has(t.upper) || t.upper === "INTO")) return null;
  }
  const last = st[end - 1];
  return Math.max(pos, last && end - 1 >= 0 ? last.to : pos);
}

/**
 * Live template contexts at the analysed caret (IDEA's SQL ones): `sql-statement`
 * where a statement starts, `sql-query` where a query may (subqueries, set
 * operations), `sql-code` anywhere in code.
 */
export function templateContexts(a: Analysis): string[] {
  if (a.context.kind === "none" || a.qualifier) return [];
  const out = ["sql-code"];
  if (a.context.kind === "statement") out.push("sql-statement", "sql-query");
  else if (a.previous && (a.previous === "(" || SET_OPS.has(a.previous) || a.previous === "ALL")) out.push("sql-query");
  return out;
}

/** The VALUES tuple slot at the caret of an INSERT: its target, explicit column list and value index. */
export interface ValuesSlot {
  target: TableRef;
  /** The `(a, b)` list after the table; `null` when the INSERT lists none. */
  columns: string[] | null;
  index: number;
}

export function valuesSlot(text: string, pos: number, driver: DbDriver): ValuesSlot | null {
  const a = analyze(text, pos, driver);
  if (a.verb !== "INSERT" && a.verb !== "REPLACE") return null;
  const target = a.refs.find((r) => r.depth === 0 && r.kind === "table");
  if (!target) return null;
  const toks = lex(a.statement.text, driver).tokens;
  const caret = pos - a.statement.from;
  let depth = 0;
  let columns: string[] | null = null;
  let afterValues = false;
  let index = -1;
  let inTuple = false;
  for (const t of toks) {
    if (t.from >= caret) break;
    if (isP(t, "(")) {
      depth++;
      if (depth === 1 && afterValues) {
        inTuple = true;
        index = 0;
      } else if (depth === 1 && !afterValues && columns === null && t.from > target.from) columns = [];
      continue;
    }
    if (isP(t, ")")) {
      depth--;
      if (depth === 0) inTuple = false;
      continue;
    }
    if (depth === 0 && isW(t, "VALUES")) afterValues = true;
    else if (depth === 1 && !afterValues && columns && (t.kind === "word" || t.kind === "quoted"))
      columns.push(identName(t));
    else if (depth === 1 && inTuple && isP(t, ",")) index++;
  }
  return inTuple ? { target, columns: columns?.length ? columns : null, index } : null;
}
