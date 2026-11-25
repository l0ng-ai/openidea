/**
 * TOML coloured like IntelliJ's TOML plugin (TomlHighlighter, TomlHighlightingAnnotator): a bare
 * key is KEYWORD wherever it stands (headers, dotted keys, inline tables), even when it reads as
 * a number, date or boolean; booleans and dates are PREDEFINED_SYMBOL; escapes in basic strings
 * are valid or invalid as in TomlEscapeLexer. `=`, brackets, `,` and `.` stay plain. Values
 * follow the TOML 1.0 lexer (TomlLexer.flex), so a time needs its seconds.
 */
import type { StreamParser, StringStream } from "@codemirror/language";

type Delimiter = '"' | "'" | '"""' | "'''";

export interface TomlState {
  /** The string being read; a multi-line one carries over to the next lines. */
  string: Delimiter | null;
  /** Open arrays and inline tables, innermost last. */
  stack: Array<"array" | "inline">;
  position: "key" | "value";
}

const KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const DOTTED_KEY = String.raw`${KEY_PART}(?:\s*\.\s*${KEY_PART})*`;
/** A key/value line ends a container left open by a typo; no valid array or inline table holds one. */
const NEW_ENTRY = new RegExp(String.raw`^\s*${DOTTED_KEY}\s*=`);

const BARE_KEY = /^[A-Za-z0-9_-]+/;
const DATE_TIME =
  /^(?:\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:[Zz]|[+-]\d{2}:\d{2})?/;
const BOOLEAN = /^(?:true|false)/;
const DEC_INT = String.raw`[-+]?(?:0|[1-9](?:_?\d)*)`;
const DIGITS = String.raw`\d(?:_?\d)*`;
const NUMBERS = [
  new RegExp(String.raw`^${DEC_INT}(?:[eE][-+]?${DIGITS}|\.${DIGITS}(?:[eE][-+]?${DIGITS})?)`),
  /^[-+]?(?:inf|nan)/,
  /^0x[0-9a-fA-F](?:_?[0-9a-fA-F])*/,
  /^0o[0-7](?:_?[0-7])*/,
  /^0b[01](?:_?[01])*/,
  new RegExp(`^${DEC_INT}`),
  // Leading zeros: a key in IntelliJ's lexer, a number where a value stands.
  /^-?\d+/,
];

function matchLength(stream: StringStream, pattern: RegExp): number {
  const match = stream.match(pattern, false) as RegExpMatchArray | null;
  return match ? match[0].length : 0;
}

/**
 * Numbers, dates and booleans by the longest match, as JFlex picks. A longer bare word is a
 * bare key to IntelliJ's lexer, which colours it as one wherever it stands.
 */
function scalar(stream: StringStream): string | null {
  const word = matchLength(stream, BARE_KEY);
  const date = matchLength(stream, DATE_TIME);
  const bool = matchLength(stream, BOOLEAN);
  const number = Math.max(...NUMBERS.map((pattern) => matchLength(stream, pattern)));
  const longest = Math.max(date, bool, number);
  if (longest === 0 || longest < word) {
    if (!word) {
      stream.next();
      return null;
    }
    stream.pos += word;
    return "keyword";
  }
  stream.pos += longest;
  return number === longest ? "number" : "builtin";
}

function isScalarValue(value: number): boolean {
  return value <= 0xd7ff || (value >= 0xe000 && value <= 0x10ffff);
}

function escape(stream: StringStream, multiline: boolean): string {
  stream.next();
  // A line-ending backslash, whitespace after it allowed, trims the line break of a multi-line string.
  if (multiline && stream.match(/^[ \t]*$/)) return "escape";
  const ch = stream.next();
  if (ch === undefined) return "invalid";
  if (ch === "u" || ch === "U") {
    const hex = stream.match(ch === "u" ? /^[0-9a-fA-F]{4}/ : /^[0-9a-fA-F]{8}/) as RegExpMatchArray | null;
    return hex && isScalarValue(parseInt(hex[0], 16)) ? "escape" : "invalid";
  }
  return 'btnfr"\\'.includes(ch) ? "escape" : "invalid";
}

function stringBody(stream: StringStream, state: TomlState): string {
  const delimiter = state.string!;
  const quote = delimiter.charAt(0);
  const basic = quote === '"';
  if (basic && stream.peek() === "\\") return escape(stream, delimiter === '"""');
  while (!stream.eol()) {
    if (basic && stream.peek() === "\\") return "string";
    if (stream.match(delimiter)) {
      // A multi-line string may end in up to two quotes of its own right before the closing three.
      if (delimiter.length === 3) for (let i = 0; i < 2 && stream.eat(quote); i++);
      state.string = null;
      return "string";
    }
    stream.next();
  }
  if (delimiter.length === 1) state.string = null;
  return "string";
}

function openString(stream: StringStream, state: TomlState): boolean {
  const quote = stream.match(/^(?:"""|'''|"|')/) as RegExpMatchArray | null;
  if (quote) state.string = quote[0] as Delimiter;
  return quote !== null;
}

export const tomlParser: StreamParser<TomlState> = {
  name: "toml",
  startState: () => ({ string: null, stack: [], position: "key" }),
  token(stream, state) {
    if (stream.sol()) {
      if (state.string === '"' || state.string === "'") state.string = null;
      if (!state.string && (!state.stack.length || NEW_ENTRY.test(stream.string))) {
        state.stack = [];
        state.position = "key";
      }
    }
    if (state.string) return stringBody(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    if (openString(stream, state)) return "string";
    const top = state.stack[state.stack.length - 1];
    if (state.position === "key") {
      if (stream.match(BARE_KEY)) return "keyword";
      const ch = stream.next();
      if (ch === "=") state.position = "value";
      else if (ch === "}" && top === "inline") {
        state.stack.pop();
        state.position = "value";
      }
      return null;
    }
    const ch = stream.peek();
    if (ch === "[" || ch === "{") {
      stream.next();
      state.stack.push(ch === "[" ? "array" : "inline");
      if (ch === "{") state.position = "key";
      return null;
    }
    if (ch === "]" || ch === "}") {
      stream.next();
      if (top === (ch === "]" ? "array" : "inline")) state.stack.pop();
      return null;
    }
    if (ch === ",") {
      stream.next();
      if (top === "inline") state.position = "key";
      return null;
    }
    return scalar(stream);
  },
  languageData: { commentTokens: { line: "#" } },
};
