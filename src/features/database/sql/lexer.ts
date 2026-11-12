/**
 * SQL tokens for completion and resolution: words, quoted identifiers, string
 * literals, numbers and punctuation, with comments and whitespace dropped.
 * Dialect-aware (MySQL backticks / `#` comments / backslash escapes,
 * PostgreSQL dollar quoting). Offsets are UTF-16, like the editor's.
 */
import type { DbDriver } from "@/platform/ipc";

export type TokenKind = "word" | "quoted" | "string" | "number" | "param" | "punct";

export interface Token {
  kind: TokenKind;
  /** Source text (quotes included for `quoted` / `string`). */
  text: string;
  from: number;
  to: number;
  /** Upper-cased `text` of words, for keyword checks. */
  upper: string;
  value?: string;
}

export interface Lexed {
  tokens: Token[];
  /** Comments; a caret at `to` is still inside line comments and unterminated block comments. */
  comments: Array<{ from: number; to: number; open: boolean }>;
}

const WORD_START = /[\p{L}_]/u;
const WORD_PART = /[\p{L}\p{N}_$]/u;
const TWO_CHAR = new Set(["::", "<=", ">=", "<>", "!=", "||", "->", "=>", ":="]);

export function lex(text: string, driver: DbDriver = "sqlite"): Lexed {
  const mysql = driver === "mysql";
  const clickhouse = driver === "clickhouse";
  const tokens: Token[] = [];
  const comments: Lexed["comments"] = [];
  const n = text.length;
  let i = 0;
  const push = (kind: TokenKind, from: number, to: number) => {
    const t = text.slice(from, to);
    tokens.push({
      kind,
      text: t,
      from,
      to,
      upper: kind === "word" ? t.toUpperCase() : t,
      ...(kind === "quoted" && clickhouse
        ? { value: t.slice(1, t.endsWith(t[0]!) ? -1 : undefined).replace(/\\([\\'"`])/g, "$1") }
        : {}),
    });
  };
  /** End of a quoted run starting at `i` (closing char doubled = escaped). */
  const quoted = (start: number, close: string, backslash: boolean): number => {
    let j = start + 1;
    while (j < n) {
      const c = text[j]!;
      if (backslash && c === "\\") j += 2;
      else if (c === close) {
        if (text[j + 1] === close) j += 2;
        else return j + 1;
      } else j++;
    }
    return n;
  };
  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if ((c === "-" && next === "-") || (c === "#" && mysql)) {
      const end = text.indexOf("\n", i);
      const to = end < 0 ? n : end;
      comments.push({ from: i, to, open: true });
      i = to;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const to = end < 0 ? n : end + 2;
      comments.push({ from: i, to, open: end < 0 });
      i = to;
    } else if (c === "'") {
      const to = quoted(i, "'", mysql || clickhouse);
      push("string", i, to);
      i = to;
    } else if (c === '"') {
      const to = quoted(i, '"', clickhouse);
      push(mysql ? "string" : "quoted", i, to);
      i = to;
    } else if (c === "`" && (mysql || clickhouse)) {
      const to = quoted(i, "`", clickhouse);
      push("quoted", i, to);
      i = to;
    } else if (c === "$" && driver === "postgres") {
      const m = /^\$([\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(text.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const close = text.indexOf(tag, i + tag.length);
        const to = close < 0 ? n : close + tag.length;
        push("string", i, to);
        i = to;
      } else {
        let j = i + 1;
        while (j < n && /\d/.test(text[j]!)) j++;
        push("param", i, j);
        i = j;
      }
    } else if (/\d/.test(c) || (c === "." && next !== undefined && /\d/.test(next))) {
      let j = i + 1;
      while (j < n && /[\d.eE_xXa-fA-F]/.test(text[j]!)) j++;
      push("number", i, j);
      i = j;
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(text[j]!)) j++;
      push("word", i, j);
      i = j;
    } else if (
      (c === "?" || c === ":" || c === "@") &&
      next !== undefined &&
      WORD_START.test(next) &&
      !(c === ":" && text[i - 1] === ":")
    ) {
      let j = i + 1;
      while (j < n && WORD_PART.test(text[j]!)) j++;
      push("param", i, j);
      i = j;
    } else {
      const two = text.slice(i, i + 2);
      const len = TWO_CHAR.has(two) ? 2 : 1;
      push("punct", i, i + len);
      i += len;
    }
  }
  return { tokens, comments };
}

/** Whether `pos` lies inside a string literal, quoted identifier or comment (not at its edge). */
export function inLiteral(lexed: Lexed, pos: number): "string" | "quoted" | "comment" | null {
  for (const c of lexed.comments) if (pos > c.from && (pos < c.to || (c.open && pos === c.to))) return "comment";
  for (const t of lexed.tokens) {
    if (t.from >= pos) break;
    if ((t.kind === "string" || t.kind === "quoted") && pos > t.from && (pos < t.to || !closed(t))) return t.kind;
  }
  return null;
}

/** Whether a quoted token has its closing quote. */
function closed(t: Token): boolean {
  if (t.text.length < 2) return false;
  const open = t.text[0]!;
  if (open === "$") {
    const tag = /^\$[\p{L}\p{N}_]*\$/u.exec(t.text)?.[0] ?? "$";
    return t.text.length >= tag.length * 2 && t.text.endsWith(tag);
  }
  return t.text.endsWith(open);
}

/** The identifier a word / quoted token names (quotes removed, doubled quotes collapsed). */
export function identName(t: Token): string {
  if (t.kind !== "quoted") return t.text;
  if (t.value !== undefined) return t.value;
  const q = t.text[0]!;
  const body = t.text.endsWith(q) && t.text.length > 1 ? t.text.slice(1, -1) : t.text.slice(1);
  return body.split(q + q).join(q);
}
