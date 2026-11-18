/**
 * Typst markup, code and math as Typst's own lexer splits them (typst-syntax `lexer.rs`): markup
 * with `#` embedding a code expression, `[...]` content blocks and `$...$` math nesting in code
 * and back. A `#keyword` statement lasts to the end of its line unless a bracket keeps it open.
 */
import type { StreamParser, StringStream } from "@codemirror/language";

type Frame =
  /** Markup inside `[...]`; the document itself is the markup below every frame. */
  | { kind: "content" }
  /** Code in `(...)` or `{...}`, closed by `close`. */
  | { kind: "code"; close: ")" | "}" }
  /** A `#let` / `#set` / `#show` … statement, ending with its line. */
  | { kind: "statement" }
  /** An embedded `#name`: calls, content arguments and field accesses may follow it directly. */
  | { kind: "expr" }
  | { kind: "math" };

export interface TypstState {
  stack: Frame[];
  strong: boolean;
  emph: boolean;
  heading: boolean;
  /** Nesting depth of an open block comment. */
  comment: number;
  /** The backtick fence of an open raw block. */
  raw: string | null;
}

const KEYWORDS = new Set([
  "let",
  "set",
  "show",
  "context",
  "if",
  "else",
  "for",
  "in",
  "while",
  "break",
  "continue",
  "return",
  "import",
  "include",
  "as",
  "and",
  "or",
  "not",
]);
const ATOMS = new Set(["none", "auto", "true", "false"]);
const IDENT = /^[\p{L}_][\p{L}\p{N}_-]*/u;
const NUMBER = /^(?:0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:pt|mm|cm|in|em|fr|deg|rad|%)?)/;
const LABEL = /^<[\p{L}\p{N}_\-.:]+>/u;
const REF = /^@[\p{L}\p{N}_\-.:]*[\p{L}\p{N}_]/u;
const URL = /^https?:\/\/[^\s<>[\](){}"]*[^\s<>[\](){}".,;:!?'"]/;
const MARKUP_TEXT = /^[^\\#$*_`<@/[\]\nhH-]+/;

const top = (state: TypstState): Frame | undefined => state.stack[state.stack.length - 1];

function blockComment(stream: StringStream, state: TypstState): string {
  while (!stream.eol()) {
    if (stream.match("/*")) state.comment++;
    else if (stream.match("*/")) {
      if (--state.comment === 0) break;
    } else stream.next();
  }
  return "comment";
}

function comment(stream: StringStream, state: TypstState): string | null {
  if (stream.match("//")) {
    stream.skipToEnd();
    return "comment";
  }
  if (stream.match("/*")) {
    state.comment = 1;
    return blockComment(stream, state);
  }
  return null;
}

function string(stream: StringStream): string {
  stream.next();
  let escaped = false;
  for (let ch = stream.next(); ch !== undefined; ch = stream.next()) {
    if (ch === '"' && !escaped) break;
    escaped = !escaped && ch === "\\";
  }
  return "string";
}

function raw(stream: StringStream, state: TypstState): string {
  const fence = (stream.match(/^`+/) as RegExpMatchArray)[0];
  if (fence.length === 2) return "monospace";
  if (fence.length >= 3) {
    state.raw = fence;
    if (!stream.match(/^[\p{L}\p{N}_-]+/u)) return rawBody(stream, state);
    return "monospace";
  }
  while (!stream.eol()) if (stream.next() === "`") break;
  return "monospace";
}

function rawBody(stream: StringStream, state: TypstState): string {
  const fence = state.raw!;
  while (!stream.eol()) {
    if (stream.match(fence)) {
      state.raw = null;
      break;
    }
    stream.next();
  }
  return "monospace";
}

/** `#` followed by a keyword, a name, or a bracketed expression. */
function embed(stream: StringStream, state: TypstState): string {
  stream.next();
  const word = stream.match(IDENT, false) as RegExpMatchArray | null;
  if (word && KEYWORDS.has(word[0])) {
    stream.pos += word[0].length;
    state.stack.push({ kind: "statement" });
    return "keyword";
  }
  if (word) {
    state.stack.push({ kind: "expr" });
    return name(stream);
  }
  const ch = stream.peek();
  if (ch === "(" || ch === "{") {
    stream.next();
    state.stack.push({ kind: "code", close: ch === "(" ? ")" : "}" });
    return "keyword";
  }
  if (ch === "[") {
    stream.next();
    state.stack.push({ kind: "content" });
    return "keyword";
  }
  if (ch === '"') return string(stream);
  return "keyword";
}

/** An identifier: a function when a call or content block follows, a value otherwise. */
function name(stream: StringStream): string {
  const word = (stream.match(IDENT) as RegExpMatchArray)[0];
  if (ATOMS.has(word)) return "atom";
  const next = stream.peek();
  return next === "(" || next === "[" ? "variableName.function" : "variableName";
}

function code(stream: StringStream, state: TypstState): string | null {
  if (stream.eatSpace()) return null;
  const c = comment(stream, state);
  if (c) return c;
  const ch = stream.peek()!;
  if (ch === '"') return string(stream);
  if (ch === "$") {
    stream.next();
    state.stack.push({ kind: "math" });
    return "keyword";
  }
  if (ch === "(" || ch === "{") {
    stream.next();
    state.stack.push({ kind: "code", close: ch === "(" ? ")" : "}" });
    return "bracket";
  }
  if (ch === "[") {
    stream.next();
    state.stack.push({ kind: "content" });
    return "bracket";
  }
  const frame = top(state);
  if (ch === ")" || ch === "}") {
    stream.next();
    if (frame?.kind === "code" && frame.close === ch) state.stack.pop();
    return "bracket";
  }
  if (stream.match(LABEL)) return "labelName";
  if (stream.match(NUMBER)) return "number";
  const word = stream.match(IDENT, false) as RegExpMatchArray | null;
  if (word) {
    if (KEYWORDS.has(word[0])) {
      stream.pos += word[0].length;
      return "keyword";
    }
    return name(stream);
  }
  if (stream.match(/^(?:=>|==|!=|<=|>=|\+=|-=|\*=|\/=|\.\.|[-+*/=<>.:,;!])/)) return "operator";
  stream.next();
  return null;
}

/** What may directly follow an embedded name: `(args)`, `[content]` or `.field`. */
function exprTail(stream: StringStream, state: TypstState): string | null | undefined {
  const ch = stream.peek();
  if (ch === "(") {
    stream.next();
    state.stack.push({ kind: "code", close: ")" });
    return "bracket";
  }
  if (ch === "[") {
    stream.next();
    state.stack.push({ kind: "content" });
    return "bracket";
  }
  if (ch === "." && stream.match(/^\.(?=[\p{L}_])/u, false)) {
    stream.next();
    return name(stream);
  }
  state.stack.pop();
  return undefined;
}

function math(stream: StringStream, state: TypstState): string | null {
  if (stream.eatSpace()) return null;
  const c = comment(stream, state);
  if (c) return c;
  const ch = stream.peek()!;
  if (ch === "$") {
    stream.next();
    state.stack.pop();
    return "keyword";
  }
  if (ch === "#") return embed(stream, state);
  if (ch === "\\") {
    stream.next();
    stream.next();
    return "escape";
  }
  if (ch === '"') return string(stream);
  if (stream.match(/^\d+(?:\.\d+)?/)) return "number";
  if (stream.match(/^[\p{L}][\p{L}.]+/u)) return "variableName";
  if (stream.match(/^[\^_/&=<>+\-*|!']/)) return "operator";
  stream.next();
  return null;
}

function markup(stream: StringStream, state: TypstState): string | null {
  const inline = (style: string | null): string | null => {
    const extra = [state.heading && "heading", state.strong && "strong", state.emph && "emphasis"].filter(Boolean);
    return [...new Set([style, ...extra].filter(Boolean))].join(" ") || null;
  };
  if (stream.sol()) {
    state.heading = false;
    if (stream.match(/^\s*=+(?=\s|$)/)) {
      state.heading = true;
      return "heading";
    }
    if (stream.match(/^\s*(?:[-+]|\d+\.)(?=\s|$)/) || stream.match(/^\s*\/(?=\s)/)) return "list";
  }
  const c = comment(stream, state);
  if (c) return c;
  const ch = stream.peek()!;
  switch (ch) {
    case "#":
      return embed(stream, state);
    case "$":
      stream.next();
      state.stack.push({ kind: "math" });
      return "keyword";
    case "`":
      return raw(stream, state);
    case "\\":
      stream.next();
      if (!stream.match(/^u\{[0-9a-fA-F]+\}/)) stream.next();
      return "escape";
    case "]":
      stream.next();
      if (top(state)?.kind === "content") state.stack.pop();
      return "bracket";
    case "*":
    case "_": {
      // Inside a word, `*` and `_` are text (`snake_case`, `2*3`).
      const before = stream.string.charAt(stream.pos - 1);
      const after = stream.string.charAt(stream.pos + 1);
      stream.next();
      if (/[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) return inline(null);
      if (ch === "*") state.strong = !state.strong;
      else state.emph = !state.emph;
      return inline(ch === "*" ? "strong" : "emphasis");
    }
  }
  if (stream.match(LABEL)) return "labelName";
  if (stream.match(REF)) return "labelName";
  if (stream.match(URL)) return "url";
  if (stream.match(/^\/ (?=[^:]*:)/) || stream.match(/^-{2,3}|^~/)) return inline(null);
  if (!stream.match(MARKUP_TEXT)) stream.next();
  return inline(null);
}

export const typstParser: StreamParser<TypstState> = {
  name: "typst",
  startState: () => ({ stack: [], strong: false, emph: false, heading: false, comment: 0, raw: null }),
  copyState: (state) => ({ ...state, stack: state.stack.slice() }),
  blankLine(state) {
    state.strong = state.emph = false;
  },
  token(stream, state) {
    if (state.comment) return blockComment(stream, state);
    if (state.raw) return rawBody(stream, state);
    let style: string | null | undefined;
    do {
      const frame = top(state);
      if (frame?.kind === "expr") style = exprTail(stream, state);
      else if (frame?.kind === "code" || frame?.kind === "statement") style = code(stream, state);
      else if (frame?.kind === "math") style = math(stream, state);
      else style = markup(stream, state);
    } while (style === undefined);
    // A statement ends with its line once its brackets are closed.
    if (stream.eol()) {
      while (top(state)?.kind === "expr") state.stack.pop();
      if (top(state)?.kind === "statement") state.stack.pop();
    }
    return style;
  },
  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    closeBrackets: { brackets: ["(", "[", "{", '"', "$"] },
  },
};
