/**
 * External tokens of `angular.grammar`. From @codemirror/lang-angular 0.1.4
 * (MIT, see LICENSE); text stopping at blocks, and the block tokens, added by
 * OpenIDEA.
 */
import { ExternalTokenizer, type InputStream } from "@lezer/lr";
import {
  Brace,
  Expression,
  Text,
  Time,
  attributeContentDouble,
  attributeContentSingle,
  scriptAttributeContentDouble,
  scriptAttributeContentSingle,
} from "./parser.terms";

const NEWLINE = 10,
  DOUBLE_QUOTE = 34,
  DOLLAR = 36,
  AMPERSAND = 38,
  SINGLE_QUOTE = 39,
  PAREN_L = 40,
  PAREN_R = 41,
  DOT = 46,
  SEMICOLON = 59,
  AT = 64,
  BRACKET_L = 91,
  BACKSLASH = 92,
  BRACKET_R = 93,
  UNDERSCORE = 95,
  BACKTICK = 96,
  BRACE_L = 123,
  BRACE_R = 125;

const BLOCKS = new Set([
  "if",
  "else",
  "for",
  "empty",
  "switch",
  "case",
  "default",
  "defer",
  "placeholder",
  "loading",
  "error",
  "let",
]);

const isLetter = (ch: number) => (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122);
const isDigit = (ch: number) => ch >= 48 && ch <= 57;
const isIdentifierStart = (ch: number) => isLetter(ch) || ch == UNDERSCORE || ch == DOLLAR || ch >= 0xc0;
const isIdentifierChar = (ch: number) => isIdentifierStart(ch) || isDigit(ch);
const isSpace = (ch: number) => ch == 32 || ch == 9 || ch == 10 || ch == 13;

/**
 * `@if (`, `@else {`, `@let x`, ...: a block rather than an `@` of text
 * (pre-v17 templates, or a block name being typed). `at` is the offset of the `@`.
 */
function blockAt(input: InputStream, at = 0): boolean {
  let name = "",
    i = at + 1;
  for (let ch = input.peek(i); isLetter(ch); ch = input.peek(++i)) name += String.fromCharCode(ch);
  if (!BLOCKS.has(name)) return false;
  let next = input.peek(i);
  if (!isSpace(next) && next != PAREN_L && next != BRACE_L) return false;
  while (isSpace(next)) next = input.peek(++i);
  if (name == "let") return isIdentifierStart(next);
  if (name == "else" && next == 105 /* i */ && input.peek(i + 1) == 102 /* f */) return true;
  return next == PAREN_L || next == BRACE_L;
}

export const text = new ExternalTokenizer((input) => {
  const start = input.pos;
  for (;;) {
    if (input.next == NEWLINE) {
      input.advance();
      break;
    } else if (
      input.next < 0 ||
      input.next == BRACE_L ||
      input.next == BRACE_R ||
      input.next == AMPERSAND ||
      (input.next == AT && blockAt(input))
    ) {
      break;
    }
    input.advance();
  }
  if (input.pos > start) input.acceptToken(Text);
});

/**
 * A block's `{` or `}`, or one of text (ICU messages). `{{` in text starts an
 * interpolation, and `{{{` is a brace before one.
 */
export const brace = new ExternalTokenizer(
  (input, stack) => {
    const interpolation = input.peek(1) == BRACE_L && input.peek(2) != BRACE_L && stack.canShift(Text);
    if (input.next == BRACE_R || (input.next == BRACE_L && !interpolation)) input.acceptToken(Brace, 1);
  },
  { contextual: true },
);

/** `500ms`, `1.5s` or `100` (milliseconds). */
export const time = new ExternalTokenizer((input) => {
  const start = input.pos;
  while (isDigit(input.next) || input.next == DOT) input.advance();
  if (input.pos == start) return;
  if (input.next == 109 /* m */ && input.peek(1) == 115 /* s */) input.advance(2);
  else if (input.next == 115 /* s */) input.advance();
  if (!isIdentifierChar(input.next)) input.acceptToken(Time);
});

/**
 * Moves past the next code unit; false when that leaves the parsed range, i.e.
 * a child element or comment follows.
 */
function step(input: InputStream): boolean {
  const pos = input.pos;
  input.advance();
  return input.pos == pos + 1;
}

/** At a newline: the next line starts with a block (`@if (`, `@let x`, ...). */
function blockOnNextLine(input: InputStream): boolean {
  let i = 1;
  while (isSpace(input.peek(i))) i++;
  return input.peek(i) == AT && blockAt(input, i);
}

/**
 * A block parameter's or `@let`'s expression: up to a `;` or a closing bracket
 * outside brackets and strings, without the spaces around it. An unterminated
 * one (being typed) also ends before a child element or comment and before a
 * line starting with a block, so the blocks after it keep their highlighting.
 */
export const expression = new ExternalTokenizer((input) => {
  if (isSpace(input.next)) return;
  const start = input.pos;
  let depth = 0,
    quote = 0,
    escaped = false,
    end = start;
  for (;;) {
    const ch = input.next;
    if (ch < 0 || (ch == NEWLINE && blockOnNextLine(input))) break;
    if (escaped) {
      escaped = false;
    } else if (quote) {
      // Strings but template literals end with their line, like in JavaScript.
      if (ch == quote || (ch == NEWLINE && quote != BACKTICK)) quote = 0;
      else escaped = ch == BACKSLASH;
    } else if (ch == SINGLE_QUOTE || ch == DOUBLE_QUOTE || ch == BACKTICK) {
      quote = ch;
    } else if (ch == PAREN_L || ch == BRACKET_L || ch == BRACE_L) {
      depth++;
    } else if (ch == PAREN_R || ch == BRACKET_R || ch == BRACE_R) {
      if (depth == 0) break;
      depth--;
    } else if (ch == SEMICOLON && depth == 0) {
      break;
    }
    if (!isSpace(ch)) end = input.pos + 1;
    if (!step(input)) break;
  }
  // `end` is a document position: the stream skips the ranges' gaps.
  if (end > start) input.acceptTokenTo(Expression, end);
});

function attrContent(quote: number, token: number, script: boolean) {
  return new ExternalTokenizer((input) => {
    const start = input.pos;
    while (
      input.next != quote &&
      input.next >= 0 &&
      (script || (input.next != AMPERSAND && (input.next != BRACE_L || input.peek(1) != BRACE_L)))
    )
      input.advance();
    if (input.pos > start) input.acceptToken(token);
  });
}

export const attrSingle = attrContent(SINGLE_QUOTE, attributeContentSingle, false);
export const attrDouble = attrContent(DOUBLE_QUOTE, attributeContentDouble, false);
export const scriptAttrSingle = attrContent(SINGLE_QUOTE, scriptAttributeContentSingle, true);
export const scriptAttrDouble = attrContent(DOUBLE_QUOTE, scriptAttributeContentDouble, true);
