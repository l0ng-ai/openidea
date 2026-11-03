/** NEON highlighting: the lexer and token classes of noctud/intellij-neon, on one line at a time. */
import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";
import { isNeonFilePath, isNeonTranslation, type NeonFileKind } from "./neonFileKind";

interface State {
  /** The closing `"""` or `'''` of the multiline string we are in. */
  multiline: string | null;
  /** The scalar being split around its `%parameters%`: where it ends on this line, and its style. */
  scalarEnd: number;
  scalarStyle: string;
}

// The character classes are the flex lexer's, control characters included.
const LITERAL =
  // eslint-disable-next-line no-control-regex
  /^(?:[^-:#"',=[\]{}()\x00-\x20`]|[:-][!#$%&*\x2D-\x5C\x5E-\x7C~\xA0-\uFFFF])(?:[^,:=\]})(\x00-\x20]+|[ \t]+[^#,:=\]})(\x00-\x20]|:(?=[\x21-\x28*\x2D-\x5C\x5E-\x7C~\xA0-\uFFFF]))*/;
const KEY_MARK = /^[ \t]*(?:=|:(?![!#$%&*\x2D-\x5C\x5E-\x7C~\xA0-\uFFFF]))/;
const STRING = /^(?:'[^']*'|"(?:\\.|[^"\\])*")/;
const CONSTANT = /^(?:true|false|null|yes|no|on|off|True|False|Null|Yes|No|On|Off|TRUE|FALSE|NULL|YES|NO|ON|OFF)$/;
const NUMBER = /^-?(?:0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+|[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)$/;
const DATETIME = /^\d{4}-\d{1,2}-\d{1,2}(?:[Tt ]\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\s*(?:Z|[-+]\d{1,2}:?\d{0,2})?)?$/;
const VARIABLE = /%%|%[a-zA-Z_][a-zA-Z0-9._-]*%(?!%)/g;
// `identifier: argument.type` of a PHPStan config, on the key's line. The plugin reads this from its PSI.
const IDENTIFIER_KEY = /(?:^|[\s,{([-])identifier[ \t]*[:=][ \t]*$/;
const PUNCTUATION: Record<string, string> = {
  "(": "paren",
  ")": "paren",
  "{": "brace",
  "}": "brace",
  "[": "squareBracket",
  "]": "squareBracket",
  ",": "separator",
  "=": "punctuation",
  ":": "punctuation",
  "-": "punctuation",
};

function literalStyle(text: string, key: boolean, kind: NeonFileKind): string {
  if (CONSTANT.test(text)) return "atom";
  if (DATETIME.test(text) || NUMBER.test(text)) return "number";
  if (key) return "propertyName";
  // A catalogue's values are prose: `@user` and `C:\temp` mean nothing there.
  if (isNeonTranslation(kind)) return "string";
  if (text.startsWith("@")) return "meta";
  return text.includes("\\") || isNeonFilePath(text) ? "className" : "string";
}

/** The next piece of the scalar up to `scalarEnd`: a `%parameter%`, or the text before one. */
function scalarPiece(stream: StringStream, state: State, kind: NeonFileKind): string {
  const text = stream.string.slice(stream.pos, state.scalarEnd);
  // ICU catalogues have `{name}` placeholders, so a percent there is only a percent.
  const variable = kind === "icuTranslation" ? undefined : [...text.matchAll(VARIABLE)].find((m) => m[0] !== "%%");
  const end = variable?.index === 0 ? variable[0].length : (variable?.index ?? text.length);
  stream.pos += end;
  const style = variable?.index === 0 ? "variableName" : state.scalarStyle;
  if (stream.pos >= state.scalarEnd) state.scalarEnd = 0;
  return style;
}

function parser(kind: NeonFileKind): StreamParser<State> {
  const startScalar = (stream: StringStream, state: State, end: number, style: string) => {
    state.scalarEnd = end;
    state.scalarStyle = style;
    return scalarPiece(stream, state, kind);
  };
  return {
    name: "neon",
    startState: () => ({ multiline: null, scalarEnd: 0, scalarStyle: "string" }),
    languageData: { commentTokens: { line: "#" } },
    token(stream, state) {
      if (stream.pos < state.scalarEnd) return scalarPiece(stream, state, kind);
      if (state.multiline) {
        if (stream.match(new RegExp(`^[ \\t]*${state.multiline}`))) {
          state.multiline = null;
          return "string";
        }
        return startScalar(stream, state, stream.string.length, "string");
      }
      if (stream.eatSpace()) return null;
      const opening = stream.match(/^(?:"""|''')$/);
      if (opening) {
        state.multiline = (opening as RegExpMatchArray)[0];
        return "string";
      }
      const start = stream.pos;
      if (stream.match(STRING)) {
        const end = stream.pos;
        const style = stream.match(KEY_MARK, false) ? "propertyName" : "string";
        stream.pos = start;
        return startScalar(stream, state, end, style);
      }
      if (stream.eat("#")) {
        stream.skipToEnd();
        return "comment";
      }
      const literal = stream.match(LITERAL);
      if (literal) {
        const end = stream.pos;
        const key = !!stream.match(KEY_MARK, false);
        const identifier = kind === "phpstan" && !key && IDENTIFIER_KEY.test(stream.string.slice(0, start));
        const style = identifier ? "meta" : literalStyle((literal as RegExpMatchArray)[0], key, kind);
        stream.pos = start;
        return startScalar(stream, state, end, style);
      }
      return PUNCTUATION[stream.next()!] ?? "invalid";
    },
  };
}

export function neonLanguage(kind: NeonFileKind): StreamLanguage<State> {
  return StreamLanguage.define(parser(kind));
}
