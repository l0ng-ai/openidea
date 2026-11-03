/**
 * External tokens of `jsp.grammar`: the runs the JSP layer leaves to HTML and
 * Java, the comments, and the extent of EL expressions.
 */
import { ExternalTokenizer, type InputStream } from "@lezer/lr";
import { ELContent, JavaCode, JspComment, Namespace, Text } from "./parser.terms";

const DOUBLE_QUOTE = 34,
  HASH = 35,
  DOLLAR = 36,
  PERCENT = 37,
  SINGLE_QUOTE = 39,
  PAREN_L = 40,
  DASH = 45,
  COLON = 58,
  LT = 60,
  GT = 62,
  BACKSLASH = 92,
  UNDERSCORE = 95,
  BRACE_L = 123,
  BRACE_R = 125;

/** Whether `<%` starts `offset` code units ahead. */
function scriptStart(input: InputStream, offset = 0): boolean {
  return input.peek(offset) == LT && input.peek(offset + 1) == PERCENT;
}

/** Whether `${` or `#{` starts `offset` code units ahead. */
function elStart(input: InputStream, offset = 0): boolean {
  const ch = input.peek(offset);
  return (ch == DOLLAR || ch == HASH) && input.peek(offset + 1) == BRACE_L;
}

/** `<%-- … --%>`, to the end of the page when unterminated. */
export const jspComment = new ExternalTokenizer((input) => {
  if (!scriptStart(input) || input.peek(2) != DASH || input.peek(3) != DASH) return;
  input.advance(4);
  while (input.next >= 0) {
    if (input.next == DASH && input.peek(1) == DASH && input.peek(2) == PERCENT && input.peek(3) == GT) {
      input.advance(4);
      break;
    }
    input.advance();
  }
  input.acceptToken(JspComment);
});

/**
 * Template text: up to a scripting element or an EL expression. Escaped ones
 * (`<\%`, `\${`, `\#{`) are text.
 */
export const text = new ExternalTokenizer((input) => {
  const start = input.pos;
  while (input.next >= 0 && !scriptStart(input) && !elStart(input)) {
    input.advance(input.next == BACKSLASH && elStart(input, 1) ? 2 : 1);
  }
  if (input.pos > start) input.acceptToken(Text);
});

/** The code of a scripting element, up to its `%>` (`%\>` quotes one). */
export const javaCode = new ExternalTokenizer((input) => {
  const start = input.pos;
  while (input.next >= 0 && !(input.next == PERCENT && input.peek(1) == GT)) {
    input.advance(input.next == PERCENT && input.peek(1) == BACKSLASH && input.peek(2) == GT ? 3 : 1);
  }
  if (input.pos > start) input.acceptToken(JavaCode);
});

/** An EL expression's content: up to the `}` closing it, past nested braces and strings. */
export const elContent = new ExternalTokenizer((input) => {
  const start = input.pos;
  let depth = 0;
  for (let ch; (ch = input.next) >= 0; input.advance()) {
    if (ch == BRACE_R) {
      if (!depth) break;
      depth--;
    } else if (ch == BRACE_L) {
      depth++;
    } else if (ch == DOUBLE_QUOTE || ch == SINGLE_QUOTE) {
      input.advance();
      while (input.next >= 0 && input.next != ch) input.advance(input.next == BACKSLASH ? 2 : 1);
      if (input.next < 0) break;
    }
  }
  if (input.pos > start) input.acceptToken(ELContent);
});

const isIdentifierStart = (ch: number) =>
  (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch == UNDERSCORE || ch == DOLLAR || ch >= 0xa1;
const isIdentifier = (ch: number) => isIdentifierStart(ch) || (ch >= 48 && ch <= 57);

/** An identifier followed by `:name(`, a function's namespace (`fn:join(…)`). */
export const namespace = new ExternalTokenizer((input, stack) => {
  if (!isIdentifierStart(input.next) || !stack.canShift(Namespace)) return;
  let i = 1;
  while (isIdentifier(input.peek(i))) i++;
  const end = i;
  if (input.peek(i++) != COLON || !isIdentifierStart(input.peek(i++))) return;
  while (isIdentifier(input.peek(i))) i++;
  if (input.peek(i) == PAREN_L) input.acceptToken(Namespace, end);
});
