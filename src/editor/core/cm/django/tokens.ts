/**
 * External tokens of `django.grammar`: the text between template elements, the
 * comments, the raw content of `comment` and `verbatim`, and the start of each
 * tag, classified by its name against the blocks open around it.
 */
import { ContextTracker, ExternalTokenizer, type InputStream, type Stack } from "@lezer/lr";
import {
  Comment,
  CommentBody,
  CommentElement,
  CommentTagStart,
  Element,
  EndTagStart,
  MidTagStart,
  OpenTagStart,
  TagStart,
  Text,
  VerbatimBody,
  VerbatimElement,
  VerbatimTagStart,
} from "./parser.terms";

const BRACE_L = 123,
  BRACE_R = 125,
  HASH = 35,
  PERCENT = 37;

/**
 * Block tags of Django and its contrib libraries (`i18n`, `l10n`, `tz`, `cache`), with the
 * middle tags each one allows.
 */
export const BLOCK_TAGS: ReadonlyMap<string, readonly string[]> = new Map([
  ["autoescape", []],
  ["block", []],
  ["blocktrans", ["plural"]],
  ["blocktranslate", ["plural"]],
  ["cache", []],
  ["comment", []],
  ["filter", []],
  ["for", ["empty"]],
  ["if", ["elif", "else"]],
  ["ifchanged", ["else"]],
  ["language", []],
  ["localize", []],
  ["localtime", []],
  ["partialdef", []],
  ["spaceless", []],
  ["timezone", []],
  ["verbatim", []],
  ["with", []],
]);

/** The block tags open around a position, innermost first. */
class Block {
  readonly hash: number;
  constructor(
    readonly name: string,
    readonly parent: Block | null,
  ) {
    let hash = parent ? parent.hash : 0;
    for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    this.hash = hash;
  }
}

const isNameStart = (ch: number) => (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch == 95;
const isName = (ch: number) => isNameStart(ch) || (ch >= 48 && ch <= 57);
const isSpace = (ch: number) => ch == 32 || ch == 9 || ch == 10 || ch == 13;

/** The name of a tag whose `{%` is `offset` code units ahead. */
function tagName(input: InputStream, offset = 0): string {
  let i = offset + 2;
  while (isSpace(input.peek(i))) i++;
  let name = "";
  for (let ch; isName((ch = input.peek(i))); i++) {
    if (!name && !isNameStart(ch)) break;
    name += String.fromCharCode(ch);
  }
  return name;
}

const tagAt = (input: InputStream, offset = 0) => input.peek(offset) == BRACE_L && input.peek(offset + 1) == PERCENT;

/** Whether `{{`, `{%` or `{#` starts `offset` code units ahead. */
function elementStart(input: InputStream, offset = 0): boolean {
  if (input.peek(offset) != BRACE_L) return false;
  const next = input.peek(offset + 1);
  return next == BRACE_L || next == PERCENT || next == HASH;
}

export const blocks = new ContextTracker<Block | null>({
  start: null,
  shift(context, term, _stack, input) {
    return term == OpenTagStart || term == CommentTagStart || term == VerbatimTagStart
      ? new Block(tagName(input), context)
      : context;
  },
  reduce(context, term) {
    return (term == Element || term == CommentElement || term == VerbatimElement) && context ? context.parent : context;
  },
  hash: (context) => (context ? context.hash : 0),
  strict: false,
});

/** `{# … #}`, to the end of the line when unterminated (it can't span lines). */
export const comment = new ExternalTokenizer((input) => {
  if (input.next != BRACE_L || input.peek(1) != HASH) return;
  input.advance(2);
  for (let ch; (ch = input.peek(0)) >= 0 && ch != 10;) {
    if (ch == HASH && input.peek(1) == BRACE_R) {
      input.advance(2);
      break;
    }
    input.advance();
  }
  input.acceptToken(Comment);
});

/** Template text: up to a tag, a variable or a comment. */
export const text = new ExternalTokenizer((input) => {
  const start = input.pos;
  while (input.next >= 0 && !elementStart(input)) input.advance();
  if (input.pos > start) input.acceptToken(Text);
});

/** The `{%` of a tag, a token telling what the tag is in the blocks open around it. */
export const tagStart = new ExternalTokenizer((input, stack: Stack) => {
  if (!tagAt(input)) return;
  const name = tagName(input);
  const open: Block | null = stack.context;
  let term = TagStart;
  if (name == "comment") term = CommentTagStart;
  else if (name == "verbatim") term = VerbatimTagStart;
  else if (BLOCK_TAGS.has(name)) term = OpenTagStart;
  else if (open && name == `end${open.name}`) term = EndTagStart;
  else if (open && BLOCK_TAGS.get(open.name)?.includes(name)) term = MidTagStart;
  if (!stack.canShift(term)) term = TagStart;
  if (stack.canShift(term)) input.acceptToken(term, 2);
});

/** The content of a raw block: up to the `{% end<name>` closing it. */
function rawBody(name: string, token: number) {
  const end = `end${name}`;
  return new ExternalTokenizer((input) => {
    const start = input.pos;
    while (input.next >= 0 && !(tagAt(input) && tagName(input) == end)) input.advance();
    if (input.pos > start) input.acceptToken(token);
  });
}

export const commentBody = rawBody("comment", CommentBody);
export const verbatimBody = rawBody("verbatim", VerbatimBody);
