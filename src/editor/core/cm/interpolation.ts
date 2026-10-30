import { StringStream, type StreamParser } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export type InterpolationDialect = "Kotlin" | "Scala" | "Dart" | "Groovy" | "C#";
type Literal = {
  quote: string;
  interpolate: boolean;
  escape: boolean;
  verbatim: boolean;
  multiline: boolean;
  braces: number;
};
type Frame<S> = { code: S; literal?: Literal; depth: number; name?: boolean; close?: string };
type State<S> = { frames: Frame<S>[]; indentUnit: number };

/** Preserve the stock code tokenizer while suspending strings around embedded code. */
export function interpolationParser<S>(base: StreamParser<S>, dialect: InterpolationDialect): StreamParser<State<S>> {
  const start = (unit: number) => base.startState!(unit);
  const copy = (state: S): S =>
    base.copyState
      ? base.copyState(state)
      : (Object.fromEntries(
          Object.entries(state as object).map(([key, value]) => [key, Array.isArray(value) ? value.slice() : value]),
        ) as S);
  return {
    name: base.name,
    languageData: base.languageData,
    tokenTable: { ...base.tokenTable, templateDelimiter: tags.special(tags.brace) },
    startState: (indentUnit) => ({ frames: [{ code: start(indentUnit), depth: 0 }], indentUnit }),
    copyState: (state) => ({
      ...state,
      frames: state.frames.map((frame) => ({
        ...frame,
        code: copy(frame.code),
        literal: frame.literal && { ...frame.literal },
      })),
    }),
    indent: (state, text, cx) => base.indent?.(state.frames.at(-1)!.code, text, cx) ?? null,
    token(stream, state) {
      const frame = state.frames.at(-1)!;
      if (frame.name) {
        if (dialect === "Groovy" && stream.eat(".")) return "punctuation";
        stream.match(/^[\p{L}_][\p{L}\p{N}_]*/u);
        if (dialect !== "Groovy" || !stream.match(/^\.[\p{L}_]/u, false)) state.frames.pop();
        return "variableName";
      }
      const literal = frame.literal;
      if (literal) {
        const marker = () =>
          literal.interpolate &&
          (dialect === "C#"
            ? literal.quote.length >= 3
              ? stream.match("{".repeat(literal.braces), false)
              : stream.match(/^\{(?!\{)/, false)
            : stream.match(/^\$(?:\{|[\p{L}_])/u, false));
        if (marker()) {
          stream.pos += dialect === "C#" ? literal.braces : 1;
          const expression = dialect === "C#" || !!stream.eat("{");
          state.frames.push({
            code: start(state.indentUnit),
            depth: 0,
            name: !expression,
            close: "}".repeat(literal.braces),
          });
          return "templateDelimiter";
        }
        while (!stream.eol()) {
          if (literal.verbatim && stream.match('""')) continue;
          if (stream.match(literal.quote)) {
            frame.literal = undefined;
            break;
          }
          if (dialect === "C#" && literal.quote.length === 1 && (stream.match("{{") || stream.match("}}"))) continue;
          if (dialect === "Scala" && literal.interpolate && stream.match("$$")) continue;
          if (marker()) break;
          if (stream.next() === "\\" && literal.escape) stream.next();
        }
        if (stream.eol() && !literal.multiline) frame.literal = undefined;
        return "string";
      }
      // Probe with a copy so quotes/braces inside comments or characters stay opaque.
      const from = stream.pos;
      const probe = copy(frame.code);
      const style = base.token(stream, probe);
      const end = stream.pos;
      stream.pos = from;
      const text = stream.string.slice(from);
      let opening: string | undefined;
      let quote = '"';
      let interpolate = true;
      let verbatim = false;
      let braces = 1;
      if (dialect === "C#") {
        const raw = text.match(/^(\$+)("{3,})/);
        opening = raw?.[0] ?? text.match(/^(?:\$@|@\$|\$)"/)?.[0];
        if (raw) {
          quote = raw[2]!;
          braces = raw[1]!.length;
        }
        verbatim = !!opening?.includes("@");
      } else if (style === "string" && (text[0] === '"' || (dialect === "Dart" && text[0] === "'"))) {
        quote = text.startsWith(text[0]!.repeat(3)) ? text[0]!.repeat(3) : text[0]!;
        opening = quote;
        const prefix = stream.string.slice(0, from).match(/[\p{L}_][\p{L}\p{N}_]*$/u)?.[0];
        interpolate = dialect === "Scala" ? !!prefix : !(dialect === "Dart" && prefix === "r");
      }
      if (opening && style !== "comment" && style !== "string.special") {
        stream.pos = from + opening.length;
        base.token(new StringStream('""', 4, state.indentUnit), frame.code);
        frame.literal = {
          quote,
          braces,
          interpolate,
          verbatim,
          escape:
            !verbatim &&
            !(["Kotlin", "Scala", "C#"].includes(dialect) && quote.length >= 3) &&
            !(dialect === "Scala" && stream.string.slice(0, from).endsWith("raw")),
          multiline: quote.length >= 3 || verbatim,
        };
        return "string";
      }
      if (state.frames.length > 1 && style !== "comment" && !style?.startsWith("string") && end === from + 1) {
        if (frame.depth === 0 && stream.match(frame.close ?? "}")) {
          state.frames.pop();
          return "templateDelimiter";
        }
        if (text[0] === "{") frame.depth++;
        if (text[0] === "}") frame.depth--;
      }
      stream.pos = from;
      return base.token(stream, frame.code);
    },
  };
}
