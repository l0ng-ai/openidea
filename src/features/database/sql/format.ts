/**
 * Reformat Code for SQL, laid out like IDEA's default SQL code style: clauses
 * on their own lines, select / set / values items one per line aligned after
 * their keyword, joins indented under FROM, AND / OR of WHERE right-aligned,
 * subqueries aligned after their parenthesis, CREATE TABLE bodies one
 * definition per line. Comments are kept, and keywords and unquoted identifiers
 * take the case of Code Style › SQL › Case; each statement is replaced on its
 * own, so text between statements is left alone.
 */
import type { DbDriver } from "@/platform/ipc";
import type { SqlCaseStyle, SqlWordCase } from "@/platform/editorSettings";
import { CLAUSE_WORDS, isReserved, joinKeywords, predicateKeywords, statementStarters } from "./dialect";
import { lex, type Token } from "./lexer";

export interface SqlEdit {
  from: number;
  to: number;
  insert: string;
}

interface Item {
  kind: Token["kind"] | "comment";
  text: string;
  upper: string;
  from: number;
  to: number;
}

/** Edits formatting every statement (or those overlapping `range`). */
export function formatSql(
  text: string,
  driver: DbDriver,
  range: { from: number; to: number } | null = null,
  wordCase: SqlCaseStyle = KEEP_CASE,
): SqlEdit[] {
  const lexed = lex(text, driver);
  const items: Item[] = [
    ...lexed.tokens,
    ...lexed.comments.map((c) => ({
      kind: "comment" as const,
      text: text.slice(c.from, c.to),
      upper: "",
      from: c.from,
      to: c.to,
    })),
  ].sort((a, b) => a.from - b.from);

  const edits: SqlEdit[] = [];
  let start = 0;
  let depth = 0;
  const flush = (end: number) => {
    // Comments before a statement stay where they are.
    let a = start;
    while (a < end && items[a]!.kind === "comment") a++;
    if (a >= end) return;
    const first = items[a]!;
    const last = items[end - 1]!;
    if (range && (last.to < range.from || first.from > range.to)) return;
    const line = text.lastIndexOf("\n", first.from - 1) + 1;
    const lead = text.slice(line, first.from);
    const indent = /^[ \t]*$/.test(lead) ? lead : "";
    edits.push({
      from: first.from,
      to: last.to,
      insert: formatStatement(items.slice(a, end), indent, driver, wordCase),
    });
  };
  items.forEach((it, i) => {
    if (it.kind === "punct" && it.text === "(") depth++;
    else if (it.kind === "punct" && it.text === ")") depth = Math.max(0, depth - 1);
    else if (it.kind === "punct" && it.text === ";" && depth === 0) {
      flush(i + 1);
      start = i + 1;
    }
  });
  flush(items.length);
  return edits;
}

const NEWLINE_CLAUSES = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "WINDOW",
  "RETURNING",
  "VALUES",
  "SET",
  "UNION",
  "INTERSECT",
  "EXCEPT",
]);
const JOIN_START = new Set(["JOIN", "LEFT", "RIGHT", "FULL", "INNER", "CROSS", "NATURAL", "STRAIGHT_JOIN"]);
const JOIN_MODIFIERS = new Set(["LEFT", "RIGHT", "FULL", "INNER", "CROSS", "NATURAL", "OUTER"]);
/** Clauses whose AND / OR start a line. */
const AND_OR_CLAUSES = new Set(["WHERE", "HAVING", "QUALIFY"]);
/** Where a list item continues: the width of `select `, `from `, `set `, `values `. */
const ITEM_COLUMN: Record<string, number> = { SELECT: 7, FROM: 5, SET: 4, VALUES: 7 };
/** Keywords written like functions: `cast(x as int)`. */
const CALL_KEYWORDS = new Set(["CAST"]);

interface Frame {
  kind: "query" | "create" | "plain";
  /** Column where the block's clauses start. */
  indent: number;
  clause: string;
  /** Tokens written in this frame so far. */
  count: number;
  /** A BETWEEN waits for its AND. */
  between: boolean;
}

const KEEP_CASE: SqlCaseStyle = { keywords: "keep", identifiers: "keep" };

/** Words outside the reserved list that read as keywords wherever they are not a qualified name. */
const MORE_KEYWORDS =
  "ADD ALTER AUTO_INCREMENT AUTOINCREMENT BEGIN CASCADE COMMIT CONFLICT DATABASE DO DISTINCT DROP ESCAPE EXPLAIN " +
  "IF IGNORE INDEX KEY LIMIT MERGE NOTHING NULLS OFFSET OVER PARTITION RECURSIVE RENAME REPLACE RESTRICT " +
  "RETURNING ROLLBACK SCHEMA TEMPORARY TRUNCATE VIEW";

const keywordSets = new Map<DbDriver, Set<string>>();

/** The words Reformat Code treats as keywords for `driver`. */
function keywordsOf(driver: DbDriver): Set<string> {
  let set = keywordSets.get(driver);
  if (!set) {
    const phrases = [...statementStarters(driver), ...joinKeywords(driver), ...predicateKeywords(driver)];
    set = new Set([
      ...CLAUSE_WORDS,
      ...MORE_KEYWORDS.split(" "),
      ...phrases.flatMap((p) => p.split(" ")).filter((w) => /^[A-Z_]+$/.test(w)),
    ]);
    keywordSets.set(driver, set);
  }
  return set;
}

function applyCase(text: string, wordCase: SqlWordCase): string {
  return wordCase === "upper" ? text.toUpperCase() : wordCase === "lower" ? text.toLowerCase() : text;
}

/**
 * `it`'s text in the configured case: a keyword (not part of a qualified name such as `t.key`) takes
 * the keyword case, any other unquoted name the identifier case — except on ClickHouse, whose names
 * are case-sensitive, and for bind parameters (`:name`, `@name`) and Snowflake paths (`col:Key`).
 */
function casedWord(it: Item, prev: Item | null, next: Item | undefined, driver: DbDriver, wordCase: SqlCaseStyle) {
  if (it.kind !== "word" || (wordCase.keywords === "keep" && wordCase.identifiers === "keep")) return it.text;
  if (isP(prev, ":") || isP(prev, "@") || isP(prev, "$")) return it.text;
  const qualified = isP(prev, ".") || isP(next, ".") || isP(prev, "::");
  const keyword = !qualified && (isReserved(it.text, driver) || keywordsOf(driver).has(it.upper));
  if (keyword) return applyCase(it.text, wordCase.keywords);
  if (!/^[\p{L}_][\p{L}\p{N}_$]*$/u.test(it.text)) return it.text;
  return driver === "clickhouse" ? it.text : applyCase(it.text, wordCase.identifiers);
}

function formatStatement(items: Item[], base: string, driver: DbDriver, wordCase: SqlCaseStyle): string {
  const lines: string[] = [];
  let line = "";
  const newline = (column: number) => {
    lines.push(line.trimEnd());
    line = " ".repeat(column);
  };
  const atLineStart = () => line.trim() === "";
  const create = isCreateTable(items);
  const frames: Frame[] = [{ kind: "query", indent: 0, clause: "", count: 0, between: false }];
  let prev: Item | null = null;
  let unary = false;
  // Snowflake's QUALIFY is a clause of its own, like HAVING.
  const isClause = (word: string) => NEWLINE_CLAUSES.has(word) || (driver === "snowflake" && word === "QUALIFY");

  items.forEach((it, i) => {
    const frame = frames.at(-1)!;
    const word = it.kind === "word" ? it.upper : "";
    const isQuery = frame.kind === "query";

    // Line breaks before the token.
    const afterLineComment = prev?.kind === "comment" && /^(--|#|\/\/)/.test(prev.text);
    if (afterLineComment) {
      newline(isQuery && frame.clause in ITEM_COLUMN ? frame.indent + ITEM_COLUMN[frame.clause]! : frame.indent);
    } else if (it.kind === "punct" && it.text === ")" && frame.kind === "create") {
      newline(frames.at(-2)!.indent);
    } else if (isQuery && word && frame.count > 0) {
      if (isClause(word)) {
        if (!atLineStart()) newline(frame.indent);
      } else if (word === "ON" && frame.clause === "VALUES") {
        newline(frame.indent);
      } else if (JOIN_START.has(word) && !JOIN_MODIFIERS.has(prev?.upper ?? "") && frame.clause === "FROM") {
        newline(frame.indent + 9);
      } else if ((word === "AND" || word === "OR") && AND_OR_CLAUSES.has(frame.clause)) {
        if (word === "AND" && frame.between) frame.between = false;
        else newline(frame.indent + (word === "AND" ? 2 : 3));
      } else if ((word === "INSERT" || word === "UPDATE" || word === "DELETE") && isP(prev, ")")) {
        // The statement after `with x as (…)`.
        newline(frame.indent);
      }
    }

    // The token itself; a comma after a line comment moves before it (`a, -- why`).
    if (afterLineComment && isP(it, ",")) {
      const last = lines.at(-1)!;
      const at = last.lastIndexOf(prev!.text);
      lines[lines.length - 1] = `${last.slice(0, at).trimEnd()}, ${last.slice(at)}`;
    } else {
      if (
        !atLineStart() &&
        !(driver === "snowflake" && isTightPath(prev, it)) &&
        spaceBefore(prev, it, items[i - 2], unary)
      )
        line += " ";
      line += casedWord(it, prev, items[i + 1], driver, wordCase);
    }
    unary = it.kind === "punct" && (it.text === "-" || it.text === "+") && (!prev || isOperatorLike(prev));

    // Bookkeeping and breaks after the token.
    frame.count++;
    if (isQuery && word) {
      if (isClause(word)) frame.clause = word;
      else if (word === "ON" && frame.clause === "VALUES") frame.clause = "CONFLICT";
      if (word === "BETWEEN") frame.between = true;
    }
    if (it.kind === "punct" && it.text === "(") {
      const next = items[i + 1];
      if (create && frames.length === 1 && isCreateBodyParen(items, i)) {
        // `create table t\n(\n    a int,\n    …\n)`.
        line = line.slice(0, -1).trimEnd();
        newline(frame.indent);
        line += "(";
        frames.push({ kind: "create", indent: frame.indent + 4, clause: "", count: 0, between: false });
        newline(frame.indent + 4);
      } else if (next?.kind === "word" && (next.upper === "SELECT" || next.upper === "WITH")) {
        frames.push({ kind: "query", indent: line.length, clause: "", count: 0, between: false });
      } else {
        frames.push({ kind: "plain", indent: frame.indent, clause: "", count: 0, between: false });
      }
    } else if (it.kind === "punct" && it.text === ")" && frames.length > 1) {
      frames.pop();
    } else if (it.kind === "punct" && it.text === ",") {
      if (atLineStart()) {
        // Already broken after a line comment.
      } else if (frame.kind === "create") newline(frame.indent);
      else if (isQuery && frame.clause in ITEM_COLUMN) newline(frame.indent + ITEM_COLUMN[frame.clause]!);
    }
    prev = it;
  });
  lines.push(line.trimEnd());
  return lines.map((l, i) => (i === 0 ? l.trimStart() : l ? base + l : l)).join("\n");
}

const isP = (t: Item | null | undefined, p: string) => !!t && t.kind === "punct" && t.text === p;

function isOperatorLike(t: Item): boolean {
  if (t.kind === "punct") return t.text !== ")";
  return t.kind === "word" && isReserved(t.text);
}

/** Snowflake `col:key` / `col['key']`: a colon or bracket written without spaces stays so. */
function isTightPath(prev: Item | null, it: Item): boolean {
  return (
    !!prev &&
    prev.to === it.from &&
    // `name!member` is a service role or a model's method.
    (isP(it, ":") || isP(prev, ":") || isP(it, "[") || isP(prev, "[") || isP(it, "]") || isP(it, "!") || isP(prev, "!"))
  );
}

function spaceBefore(prev: Item | null, it: Item, beforePrev: Item | undefined, unary: boolean): boolean {
  if (!prev) return false;
  if (unary) return false;
  if (it.kind === "comment" || prev.kind === "comment") return true;
  if (it.kind === "punct" && [",", ";", ")", ".", "::"].includes(it.text)) return false;
  if (prev.kind === "punct" && ["(", ".", "::"].includes(prev.text)) return false;
  if (it.kind === "punct" && it.text === "(") {
    if (prev.kind === "word" && CALL_KEYWORDS.has(prev.upper)) return false;
    if (prev.kind === "word" && !isReserved(prev.text)) return isInsertTarget(beforePrev);
    if (prev.kind === "quoted") return isInsertTarget(beforePrev);
    return true;
  }
  if (it.kind === "punct" && it.text === "*" && prev.kind === "punct" && prev.text === ".") return false;
  return true;
}

/** `into users (` — a column list, written with a space. */
function isInsertTarget(beforePrev: Item | undefined): boolean {
  return (
    beforePrev?.kind === "word" &&
    (beforePrev.upper === "INTO" || beforePrev.upper === "TABLE" || beforePrev.upper === "EXISTS")
  );
}

function isCreateTable(items: Item[]): boolean {
  const words = items
    .filter((t) => t.kind === "word")
    .slice(0, 3)
    .map((t) => t.upper);
  return words[0] === "CREATE" && words.includes("TABLE");
}

/** The first top-level `(` of `CREATE TABLE name (`, not `AS (select…)`. */
function isCreateBodyParen(items: Item[], i: number): boolean {
  for (let j = 0; j < i; j++) if (isP(items[j], "(")) return false;
  const prev = items[i - 1];
  return !!prev && (prev.kind === "word" || prev.kind === "quoted") && prev.upper !== "AS";
}

/** `text` with every statement formatted. */
export function formatted(text: string, driver: DbDriver, wordCase: SqlCaseStyle = KEEP_CASE): string {
  let out = text;
  for (const e of formatSql(text, driver, null, wordCase).reverse())
    out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}
