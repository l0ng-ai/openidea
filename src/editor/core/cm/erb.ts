/**
 * ERB (Embedded Ruby) editor mode: HTML outside `<% … %>`, Ruby inside. Each
 * region is tokenized by its own legacy stream mode on a sub-stream bounded at
 * the next delimiter, so neither mode sees the other's text.
 */
import { LanguageSupport, StreamLanguage, StringStream, type StreamParser } from "@codemirror/language";
import { tags } from "@lezer/highlight";

type State<H, R> = { html: H; ruby: R; inRuby: boolean; indentUnit: number };

const OPEN = /<%(?:==|=|-|#)?/;
const CLOSE = /-?%>/;

export function erbParser<H, R>(html: StreamParser<H>, ruby: StreamParser<R>): StreamParser<State<H, R>> {
  const copy = <S>(base: StreamParser<S>, state: S): S =>
    base.copyState
      ? base.copyState(state)
      : (Object.fromEntries(
          Object.entries(state as object).map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v]),
        ) as S);

  /** Runs `base` on `stream` cut at `end`, then advances `stream` to where it stopped. */
  const within = <S>(stream: StringStream, end: number, base: StreamParser<S>, state: S): string | null => {
    const sub = new StringStream(stream.string.slice(0, end), 4, stream.indentUnit);
    sub.pos = stream.pos;
    sub.start = stream.start;
    const style = base.token(sub, state);
    stream.pos = Math.max(sub.pos, stream.pos + (sub.pos === stream.pos ? 1 : 0));
    return style;
  };

  return {
    name: "erb",
    languageData: { ...html.languageData, commentTokens: { block: { open: "<%#", close: "%>" } } },
    tokenTable: { ...html.tokenTable, ...ruby.tokenTable, erbDelimiter: tags.special(tags.brace) },
    startState: (indentUnit) => ({
      html: html.startState!(indentUnit),
      ruby: ruby.startState!(indentUnit),
      inRuby: false,
      indentUnit,
    }),
    copyState: (s) => ({ ...s, html: copy(html, s.html), ruby: copy(ruby, s.ruby) }),
    blankLine: (s, unit) => (s.inRuby ? ruby.blankLine?.(s.ruby, unit) : html.blankLine?.(s.html, unit)),
    indent: (s, text, cx) => (s.inRuby ? ruby.indent?.(s.ruby, text, cx) : html.indent?.(s.html, text, cx)) ?? null,
    token(stream, state) {
      const rest = stream.string.slice(stream.pos);
      if (!state.inRuby) {
        const open = OPEN.exec(rest);
        if (open?.index === 0) {
          stream.pos += open[0].length;
          if (open[0] === "<%#") {
            const close = CLOSE.exec(stream.string.slice(stream.pos));
            stream.pos = close ? stream.pos + close.index + close[0].length : stream.string.length;
            return "comment";
          }
          state.inRuby = true;
          return "erbDelimiter";
        }
        return within(stream, open ? stream.pos + open.index : stream.string.length, html, state.html);
      }
      const close = CLOSE.exec(rest);
      if (close?.index === 0) {
        stream.pos += close[0].length;
        state.inRuby = false;
        return "erbDelimiter";
      }
      return within(stream, close ? stream.pos + close.index : stream.string.length, ruby, state.ruby);
    },
  };
}

export async function erb(): Promise<LanguageSupport> {
  const [{ html }, { ruby }] = await Promise.all([
    import("@codemirror/legacy-modes/mode/xml"),
    import("@codemirror/legacy-modes/mode/ruby"),
  ]);
  return new LanguageSupport(StreamLanguage.define(erbParser(html, ruby)));
}
