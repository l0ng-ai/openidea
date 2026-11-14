/**
 * SQL injected into PHP strings, as IntelliJ's language injection does:
 * a string is SQL when a `/** @lang SQL *\/` or `// language=SQL` comment
 * precedes it (on the string, or on its statement), when it is a heredoc or
 * nowdoc labelled `SQL`, or when its text starts like a statement
 * (`SELECT … FROM`, `INSERT INTO`, `UPDATE … SET`, `DELETE FROM`, DDL, `WITH … AS (`).
 * A comment naming another language turns the heuristic off for that string.
 *
 * The SQL parser is mounted as an overlay on the string's content, leaving
 * out the interpolations of double-quoted strings (they stay PHP), so the
 * highlighter colours SQL tokens there. Completion reads the same ranges
 * through `sqlStringAt` (see `features/database/phpSql.ts`).
 */
import { parseMixed, type Input, type Parser, type SyntaxNode } from "@lezer/common";
import { LRLanguage, LanguageSupport, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export interface Span {
  from: number;
  to: number;
}

export interface SqlString {
  /** Start and end of the content (quotes and heredoc label lines excluded). */
  from: number;
  to: number;
  /** Parts of the content that are SQL text; interpolations fall between them. */
  ranges: Span[];
  /** The PHP quote around the content (`'` or `"`), `null` for heredoc and nowdoc. */
  quote: "'" | '"' | null;
}

/** `/** @lang SQL *\/`, `// language=SQL`, `# language = MySQL`: the language named. */
const LANG_COMMENT = /(?:@lang\s+|\blanguage\s*=\s*)["']?([A-Za-z][\w-]*)/;
const SQL_LANGS =
  /^(?:sql|mysql|mariadb|postgres(?:ql)?|pgsql|sqlite|tsql|plsql|oracle|sqlserver|clickhouse|db2|h2|hsqldb)$/i;

const STATEMENT = new RegExp(
  "^\\s*(?:" +
    [
      '(select)\\s[\\s\\S]*?\\b(?:from|FROM)\\s+[`"\\[\\w]',
      "(select)\\s+(?:\\d|\\*|@@?\\w|\\w+\\s*\\()",
      "(insert)\\s+(?:ignore\\s+)?into\\s",
      "(replace)\\s+into\\s",
      '(update)\\s+[`"\\[]?[\\w.]+[`"\\]]?(?:\\s+\\w+)?\\s+set\\s',
      "(delete)\\s+from\\s",
      "(create)\\s+(?:or\\s+replace\\s+)?(?:temporary\\s+|temp\\s+)?(?:table|view|(?:unique\\s+)?index|database|schema|trigger|procedure|function|sequence)\\s",
      "(alter)\\s+table\\s",
      "(drop)\\s+(?:table|view|index|database|schema|trigger|procedure|function|sequence)\\s",
      '(truncate)\\s+(?:table\\s+)?[`"\\w]',
      '(with)\\s+(?:recursive\\s+)?[`"\\w]+(?:\\s*\\([^)]*\\))?\\s+as\\s*\\(',
    ].join("|") +
    ")",
  "i",
);

/**
 * Whether string text reads as an SQL statement. The leading keyword must be
 * all upper or all lower case, so prose such as "Select an item from the
 * list" is not taken for a query.
 */
export function looksLikeSql(text: string): boolean {
  const m = STATEMENT.exec(text);
  if (!m) return false;
  const keyword = m.slice(1).find((g) => g !== undefined) ?? "";
  return keyword === keyword.toUpperCase() || keyword === keyword.toLowerCase();
}

const COMMENTS = new Set(["BlockComment", "LineComment"]);

/** The language an injection comment just before `node` (or before its statement) names, lower-cased. */
function commentLanguage(node: SyntaxNode, read: (from: number, to: number) => string): string | null {
  let at: SyntaxNode | null = node;
  for (let depth = 0; at && depth < 8; depth++) {
    const prev = at.prevSibling;
    if (prev && COMMENTS.has(prev.name)) {
      const m = LANG_COMMENT.exec(read(prev.from, prev.to));
      if (m) return m[1]!.toLowerCase();
    }
    if (/Statement$|Declaration$/.test(at.name)) break;
    const parent: SyntaxNode | null = at.parent;
    if (!parent || parent.type.isTop || parent.name === "Block" || parent.name === "Program") break;
    at = parent;
  }
  return null;
}

const HEREDOC_OPEN = /^<<<[ \t]*(["']?)([A-Za-z_]\w*)\1\r?\n/;

/** The SQL injected into a PHP `String` / `HeredocString` node, or `null` when it is not SQL. */
export function sqlStringOf(node: SyntaxNode, read: (from: number, to: number) => string): SqlString | null {
  let from: number;
  let to: number;
  let quote: SqlString["quote"] = null;
  let label = "";
  if (node.name === "HeredocString") {
    const text = read(node.from, node.to);
    const open = HEREDOC_OPEN.exec(text);
    if (!open) return null;
    label = open[2]!;
    from = node.from + open[0].length;
    const close = text.lastIndexOf("\n");
    to = close >= open[0].length ? node.from + (text[close - 1] === "\r" ? close - 1 : close) : node.to;
  } else if (node.name === "String") {
    const head = read(node.from, Math.min(node.to, node.from + 2));
    const start = node.from + (/^[bB]/.test(head) ? 1 : 0);
    const q = read(start, start + 1);
    if (q !== "'" && q !== '"') return null;
    quote = q;
    from = start + 1;
    to = node.to > from && read(node.to - 1, node.to) === q ? node.to - 1 : node.to;
  } else return null;
  if (to <= from) return null;

  // Interpolations (`$id`, `{$user->id}`) and escapes stay PHP.
  const ranges: Span[] = [];
  let pos = from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from || child.from >= to) continue;
    if (child.from > pos) ranges.push({ from: pos, to: child.from });
    pos = Math.max(pos, child.to);
  }
  if (pos < to) ranges.push({ from: pos, to });
  if (!ranges.length) return null;

  const lang = commentLanguage(node, read);
  const sql =
    lang !== null
      ? SQL_LANGS.test(lang)
      : label.toUpperCase() === "SQL" || looksLikeSql(sqlText({ from, to, ranges }, read));
  return sql ? { from, to, ranges, quote } : null;
}

/** The content with every interpolation replaced by `_`s of the same length, so offsets line up. */
export function sqlText(
  s: Pick<SqlString, "from" | "to" | "ranges">,
  read: (from: number, to: number) => string,
): string {
  let out = "";
  let pos = s.from;
  for (const r of s.ranges) {
    out += "_".repeat(r.from - pos) + read(r.from, r.to);
    pos = r.to;
  }
  return out + "_".repeat(s.to - pos);
}

/** The SQL string whose SQL text contains `pos` (an end counts), or `null`. */
export function sqlStringAt(state: EditorState, pos: number): SqlString | null {
  const read = (from: number, to: number) => state.sliceDoc(from, to);
  for (let node: SyntaxNode | null = syntaxTree(state).resolve(pos, -1); node; node = node.parent) {
    if (node.name !== "String" && node.name !== "HeredocString") continue;
    const s = sqlStringOf(node, read);
    return s && s.ranges.some((r) => pos >= r.from && pos <= r.to) ? s : null;
  }
  return null;
}

/**
 * `php` (as loaded from `@codemirror/language-data`) with SQL mounted in SQL
 * strings; `html` keeps the template text outside `<?php ?>` HTML, as the
 * stock mode does.
 */
export function phpWithSql(php: LanguageSupport, sql: Parser, html: Parser | null): LanguageSupport {
  if (!(php.language instanceof LRLanguage)) return php;
  const wrap = parseMixed((ref, input: Input) => {
    if (ref.type.isTop) return html ? { parser: html, overlay: (n) => n.name === "Text" } : null;
    if (ref.name !== "String" && ref.name !== "HeredocString") return null;
    const s = sqlStringOf(ref.node, (from, to) => input.read(from, to));
    return s ? { parser: sql, overlay: s.ranges } : null;
  });
  return new LanguageSupport(php.language.configure({ wrap }, "php"), php.support);
}
