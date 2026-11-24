/**
 * FreeMarker editor mode: HTML outside the template syntax, FreeMarker inside
 * directives (`<#if …>`, `<@macro …/>`), interpolations (`${…}`) and comments.
 * The first directive fixes the tag syntax, angle (`<#if>`) or square (`[#if]`),
 * as FreeMarker itself does; `[=…]` interpolations count only in square syntax.
 */
import { LanguageSupport, StreamLanguage, StringStream, type StreamParser } from "@codemirror/language";
import { tags } from "@lezer/highlight";

type State<H> = {
  html: H;
  mode: "comment" | "directive" | "interpolation" | null;
  /** Tag syntax: `null` until the first directive, then square or not. */
  square: boolean | null;
  /** What ends the current comment, directive or interpolation. */
  close: string;
  /** Brackets open inside the expression; the closer counts only at 0. */
  depth: number;
  /** The directive's name comes next. */
  name: "#" | "@" | null;
};

// `(?=…)` lookahead only: WebKit lacks lookbehind.
const OPENER = /<#--|\[#--|<\/?[#@](?=[A-Za-z_])|\[\/?[#@](?=[A-Za-z_])|\$\{|\[=/g;
const KEYWORDS = new Set(["as", "in", "using", "gt", "gte", "lt", "lte"]);

function nextOpener(line: string, from: number, square: boolean | null): RegExpExecArray | null {
  OPENER.lastIndex = from;
  for (let m = OPENER.exec(line); m; m = OPENER.exec(line)) {
    const text = m[0];
    if (text === "${") return m;
    if (text === "[=" ? square === true : square === null || square === (text[0] === "[")) return m;
  }
  return null;
}

function tokenComment<H>(stream: StringStream, state: State<H>): string {
  const end = stream.string.indexOf(state.close, stream.pos);
  stream.pos = end < 0 ? stream.string.length : end + state.close.length;
  if (end >= 0) state.mode = null;
  return "comment";
}

function tokenExpression<H>(stream: StringStream, state: State<H>): string | null {
  if (stream.eatSpace()) return null;
  if (state.depth === 0 && stream.match(state.close)) {
    state.mode = null;
    return "ftlDelimiter";
  }
  if (state.depth === 0 && state.mode === "directive" && stream.match("/" + state.close)) {
    state.mode = null;
    return "ftlDelimiter";
  }
  if (stream.match(/^r?"(?:[^"\\]|\\.)*"?/) || stream.match(/^r?'(?:[^'\\]|\\.)*'?/)) return "string";
  if (stream.match(/^\d+(?:\.\d+)?/)) return "number";
  if (stream.match("??")) return "operator";
  if (stream.match(/^\?[A-Za-z_]\w*/)) return "ftlBuiltin";
  if (stream.match(/^\.[A-Za-z_]\w*/)) return "propertyName";
  if (stream.match(/^[A-Za-z_$][\w$]*/)) {
    const word = stream.current();
    if (word === "true" || word === "false") return "bool";
    return KEYWORDS.has(word) ? "keyword" : "variableName";
  }
  const ch = stream.next()!;
  if ("([{".includes(ch)) {
    state.depth++;
    return "bracket";
  }
  if (")]}".includes(ch)) {
    state.depth = Math.max(0, state.depth - 1);
    return "bracket";
  }
  if (ch === "." && stream.match(/^\.[<!*]?/)) return "operator";
  return "+-*/%!=<>&|:,;.".includes(ch) ? "operator" : null;
}

function freemarkerParser<H>(html: StreamParser<H>): StreamParser<State<H>> {
  const copy = (state: H): H =>
    html.copyState
      ? html.copyState(state)
      : (Object.fromEntries(
          Object.entries(state as object).map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v]),
        ) as H);

  /** Runs the HTML mode on `stream` cut at `end`, then advances `stream` to where it stopped. */
  const tokenHtml = (stream: StringStream, end: number, state: H): string | null => {
    const sub = new StringStream(stream.string.slice(0, end), 4, stream.indentUnit);
    sub.pos = stream.pos;
    sub.start = stream.start;
    const style = html.token(sub, state);
    stream.pos = Math.max(sub.pos, stream.pos + (sub.pos === stream.pos ? 1 : 0));
    return style;
  };

  return {
    name: "freemarker",
    languageData: { ...html.languageData, commentTokens: { block: { open: "<#--", close: "-->" } } },
    tokenTable: {
      ...html.tokenTable,
      ftlDelimiter: tags.special(tags.brace),
      ftlBuiltin: tags.standard(tags.function(tags.variableName)),
      ftlMacro: tags.function(tags.variableName),
    },
    startState: (indentUnit) => ({
      html: html.startState!(indentUnit),
      mode: null,
      square: null,
      close: "",
      depth: 0,
      name: null,
    }),
    copyState: (s) => ({ ...s, html: copy(s.html) }),
    blankLine: (s, unit) => (s.mode ? undefined : html.blankLine?.(s.html, unit)),
    indent: (s, text, cx) => (s.mode ? null : (html.indent?.(s.html, text, cx) ?? null)),
    token(stream, state) {
      if (state.mode === "comment") return tokenComment(stream, state);
      if (state.name) {
        const sigil = state.name;
        state.name = null;
        if (stream.match(/^[A-Za-z_][\w.:-]*/)) return sigil === "#" ? "keyword" : "ftlMacro";
      }
      if (state.mode) return tokenExpression(stream, state);

      const open = nextOpener(stream.string, stream.pos, state.square);
      if (open?.index !== stream.pos) {
        return tokenHtml(stream, open ? open.index : stream.string.length, state.html);
      }
      const text = open[0];
      stream.pos += text.length;
      const square = text[0] === "[";
      state.depth = 0;
      if (text.endsWith("--")) {
        state.mode = "comment";
        state.close = square ? "--]" : "-->";
        return tokenComment(stream, state);
      }
      if (text === "${" || text === "[=") {
        state.mode = "interpolation";
        state.close = text === "${" ? "}" : "]";
        return "ftlDelimiter";
      }
      state.square ??= square;
      state.mode = "directive";
      state.close = square ? "]" : ">";
      state.name = text.endsWith("@") ? "@" : "#";
      return "ftlDelimiter";
    },
  };
}

export async function freemarker(): Promise<LanguageSupport> {
  const { html } = await import("@codemirror/legacy-modes/mode/xml");
  return new LanguageSupport(StreamLanguage.define(freemarkerParser(html)));
}
