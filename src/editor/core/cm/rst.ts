import { StreamLanguage, type StreamParser } from "@codemirror/language";

/** An indented block that belongs to the line that opened it. */
interface Block {
  kind: "literal" | "comment";
  /** Indent of the owner line; the block is every following line indented deeper (blank lines included). */
  base: number;
  /** A literal directive's `:option:` lines come before its first content line. */
  options: boolean;
  /** Set on the owner line, so the block starts to apply with the next one. */
  pending: boolean;
}

interface State {
  block: Block | null;
  /** What the previous line was, for section adornments: a stream sees one line at a time. */
  prev: "blank" | "text" | "overline" | "other";
  /** Length of the previous line when it was `text`. */
  prevLength: number;
}

const ADORNMENT = /^([!-/:-@[-`{-~])\1{2,}\s*$/;
const DIRECTIVE = /^\.\. [\w:+.-]+::(?:\s|$)/;
const CODE_DIRECTIVE = /^\.\. (?:code-block|sourcecode|code|parsed-literal|math)::/;
const TARGET = /^\.\. _[^\n]*?:(?:\s|$)/;
const REFERENCE_MARK = /^\.\. (?:\[[^\]\n]+\]|\|[^|\n]+\|)/;
const FIELD = /^\s*:[^:\s][^:\n]*:(?=\s|$)/;
const LIST_MARKER = /^\s*(?:[-*+•]|\(?(?:\d+|[a-zA-Z]|#)[.)])(?=\s)/;

const indentOf = (line: string) => /^\s*/.exec(line)![0].length;

/*
 * A title is a line of text with an underline (or an overline and an underline) of
 * punctuation at least as long as the text. A stream cannot look ahead, so a title that has
 * only an underline gets the underline styled and its text plain; with an overline the
 * text can be told apart too, because it follows the overline directly.
 */
const parser: StreamParser<State> = {
  startState: () => ({ block: null, prev: "blank", prevLength: 0 }),
  copyState: ({ block, prev, prevLength }) => ({ block: block && { ...block }, prev, prevLength }),
  blankLine(state) {
    if (state.block) state.block.options = false;
    state.prev = "blank";
  },
  token(stream, state) {
    if (stream.sol()) {
      const line = stream.string;
      const indent = indentOf(line);
      const prev = state.prev;
      const prevLength = state.prevLength;
      state.prev = "other";
      if (!line.trim()) {
        if (state.block) state.block.options = false;
        state.prev = "blank";
        stream.skipToEnd();
        return null;
      }
      const block = state.block;
      if (block?.pending) block.pending = false;
      else if (block && indent <= block.base) state.block = null;
      if (state.block) {
        if (state.block.kind === "comment") {
          stream.skipToEnd();
          return "comment";
        }
        if (state.block.options && FIELD.test(line)) {
          stream.match(FIELD);
          return "attributeName";
        }
        state.block.options = false;
        stream.skipToEnd();
        return "monospace";
      }

      if (ADORNMENT.test(line)) {
        stream.skipToEnd();
        const underline = (prev === "text" && line.trimEnd().length >= prevLength) || prev === "overline";
        if (underline) return "heading";
        // After a blank line it is a transition, or the overline of the title that follows.
        if (prev === "blank") state.prev = "overline";
        return "meta";
      }
      if (prev === "overline") {
        state.prev = "text";
        state.prevLength = line.trimEnd().length;
        stream.skipToEnd();
        return "heading";
      }
      if (line.startsWith("..")) {
        if (DIRECTIVE.test(line)) {
          if (CODE_DIRECTIVE.test(line)) state.block = { kind: "literal", base: indent, options: true, pending: true };
          stream.match(/^\.\. [\w:+.-]+::/);
          return "meta";
        }
        if (TARGET.test(line)) {
          stream.match(/^\.\. _[^\n]*?:/);
          return "link";
        }
        if (REFERENCE_MARK.test(line)) {
          stream.match(REFERENCE_MARK);
          return "meta";
        }
        state.block = { kind: "comment", base: indent, options: false, pending: true };
        stream.skipToEnd();
        return "comment";
      }
      if (indent === 0) {
        state.prev = "text";
        state.prevLength = line.trimEnd().length;
      }
      // A paragraph ending in `::` opens a literal block; the paragraph itself is tokenised below.
      if (line.trimEnd().endsWith("::")) state.block = { kind: "literal", base: indent, options: false, pending: true };
      if (FIELD.test(line)) {
        stream.match(FIELD);
        return "attributeName";
      }
      if (stream.match(LIST_MARKER)) return "meta";
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^\*\*[^*\n]+\*\*/)) return "strong";
    if (stream.match(/^``[^`\n]+(?:`(?!`)[^`\n]*)*``/)) return "monospace";
    if (stream.match(/^:[\w.+-]+:(?=`)/)) return "attributeName";
    if (stream.match(/^`[^`\n]+`__?/)) return "link";
    // `text` right after a role (`:class:`Foo``) names code; on its own it is the default role.
    if (stream.match(/^`[^`\n]+`/)) return stream.string[stream.start - 1] === ":" ? "monospace" : "emphasis";
    if (stream.match(/^\*[^*\s][^*\n]*\*(?![\w*])/)) return "emphasis";
    if (stream.match(/^https?:\/\/[^\s<>`]+/)) return "link";
    if (stream.match(/^\|[^|\s][^|\n]*\|/)) return "meta";
    // A word ending in `_` / `__` is a hyperlink reference; `__init__` and `snake_case` are not.
    const inName = stream.pos > 0 && stream.string[stream.pos - 1] === "_";
    const word = stream.match(/^[A-Za-z0-9][\w.-]*/) as RegExpMatchArray | null;
    if (word) return !inName && /[A-Za-z0-9]__?$/.test(word[0]) ? "link" : null;
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: ".." } },
};

export const rstLanguage = StreamLanguage.define(parser);
