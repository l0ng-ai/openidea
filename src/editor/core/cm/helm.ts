// Helm Template editor mode: YAML outside `{{ … }}`, Go `text/template` + Sprig/Helm
// actions and `{{/* … */}}` comments inside. Each region runs on a sub-stream bounded
// at the next delimiter so `{{ … }}` never breaks YAML key/value tokenization.
import { LanguageSupport, StreamLanguage, StringStream, type StreamParser } from "@codemirror/language";
import { tags } from "@lezer/highlight";

type HelmState<Y> = {
  yaml: Y;
  inAction: boolean;
  inComment: boolean;
  inRawString: boolean;
  quote: '"' | "'" | null;
  indentUnit: number;
};

const OPEN = /\{\{-?/;
const CLOSE = /-?\}\}/;
const COMMENT_CLOSE = /\*\/-?\}\}/;

const KEYWORDS = new Set(["if", "else", "end", "range", "with", "define", "template", "block", "break", "continue"]);
const ATOMS = new Set(["true", "false", "nil"]);
const FUNCTIONS = new Set([
  "and",
  "b64dec",
  "b64enc",
  "call",
  "coalesce",
  "contains",
  "default",
  "dict",
  "empty",
  "eq",
  "fail",
  "first",
  "fromJson",
  "fromYaml",
  "ge",
  "get",
  "gt",
  "has",
  "hasKey",
  "hasPrefix",
  "hasSuffix",
  "html",
  "include",
  "indent",
  "index",
  "int",
  "int64",
  "join",
  "js",
  "keys",
  "kindIs",
  "kindOf",
  "last",
  "le",
  "len",
  "list",
  "lookup",
  "lower",
  "lt",
  "merge",
  "mustMerge",
  "ne",
  "nindent",
  "not",
  "or",
  "pluck",
  "print",
  "printf",
  "println",
  "quote",
  "regexMatch",
  "replace",
  "required",
  "semverCompare",
  "set",
  "sha256sum",
  "slice",
  "snakecase",
  "squote",
  "ternary",
  "title",
  "toJson",
  "toPrettyJson",
  "toString",
  "toStrings",
  "toToml",
  "toYaml",
  "tpl",
  "trim",
  "trimAll",
  "trimPrefix",
  "trimSuffix",
  "trunc",
  "typeIs",
  "typeOf",
  "unset",
  "upper",
  "urlquery",
  "values",
]);

function tokenAction<Y>(stream: StringStream, state: HelmState<Y>): string | null {
  if (state.inRawString) {
    const end = stream.string.indexOf("`", stream.pos);
    if (end < 0) {
      stream.skipToEnd();
      return "string";
    }
    stream.pos = end + 1;
    state.inRawString = false;
    return "string";
  }

  if (stream.eatSpace()) return null;

  const rest = stream.string.slice(stream.pos);
  const close = CLOSE.exec(rest);
  if (close?.index === 0) {
    stream.pos += close[0].length;
    state.inAction = false;
    return "helmDelimiter";
  }

  const ch = stream.peek();
  if (ch === "`") {
    stream.next();
    state.inRawString = true;
    return tokenAction(stream, state);
  }
  if (ch === '"') {
    stream.match(/^"(?:[^"\\]|\\.)*"?/);
    return "string";
  }
  if (ch === "'") {
    stream.match(/^'(?:[^'\\]|\\.)*'?/);
    return "string";
  }
  if (stream.match(/^:=/)) return "operator";
  if (ch === "|" || ch === "=" || ch === "(" || ch === ")") {
    stream.next();
    return ch === "|" ? "operator" : "punctuation";
  }
  if (ch === "$") {
    stream.match(/^\$[A-Za-z0-9_]*/);
    return "variableName";
  }
  if (ch === ".") {
    if (stream.match(/^\.[A-Za-z_][A-Za-z0-9_]*/)) return "propertyName";
    stream.next();
    return "operator";
  }
  if (stream.match(/^-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)/)) return "number";
  if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
    const word = stream.current();
    if (KEYWORDS.has(word)) return "keyword";
    if (ATOMS.has(word)) return "bool";
    if (FUNCTIONS.has(word)) return "helmFunc";
    return "variableName";
  }

  stream.next();
  return null;
}

export function helmParser<Y>(yaml: StreamParser<Y>): StreamParser<HelmState<Y>> {
  const copy = (base: StreamParser<Y>, state: Y): Y =>
    base.copyState
      ? base.copyState(state)
      : (Object.fromEntries(
          Object.entries(state as object).map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v]),
        ) as Y);

  const withinYaml = (stream: StringStream, end: number, state: HelmState<Y>): string | null => {
    if (state.quote) {
      const q = state.quote;
      while (stream.pos < end) {
        const ch = stream.string[stream.pos];
        if (ch === "\\" && q === '"' && stream.pos + 1 < end) {
          stream.pos += 2;
          continue;
        }
        stream.pos++;
        if (ch === q) {
          state.quote = null;
          break;
        }
      }
      return "string";
    }
    const ch = stream.string[stream.pos];
    if (ch === '"' || ch === "'") {
      // Quoted scalar containing `{{ … }}` later on the same line: consume up to `end` or closing quote.
      if (end < stream.string.length) {
        stream.pos++;
        state.quote = ch;
        while (stream.pos < end) {
          const c = stream.string[stream.pos];
          if (c === "\\" && ch === '"' && stream.pos + 1 < end) {
            stream.pos += 2;
            continue;
          }
          stream.pos++;
          if (c === ch) {
            state.quote = null;
            break;
          }
        }
        return "string";
      }
    }
    const sub = new StringStream(stream.string.slice(0, end), 2, stream.indentUnit);
    sub.pos = stream.pos;
    sub.start = stream.start;
    const style = yaml.token(sub, state.yaml);
    stream.pos = Math.max(sub.pos, stream.pos + (sub.pos === stream.pos ? 1 : 0));
    return style;
  };

  return {
    name: "helm-template",
    languageData: {
      ...yaml.languageData,
      commentTokens: { line: "#", block: { open: "{{/*", close: "*/}}" } },
    },
    tokenTable: {
      ...yaml.tokenTable,
      atom: tags.propertyName,
      helmDelimiter: tags.special(tags.brace),
      helmFunc: tags.function(tags.variableName),
    },
    startState: (indentUnit) => ({
      yaml: yaml.startState!(indentUnit),
      inAction: false,
      inComment: false,
      inRawString: false,
      quote: null,
      indentUnit,
    }),
    copyState: (s) => ({ ...s, yaml: copy(yaml, s.yaml) }),
    blankLine: (s, unit) => {
      s.quote = null;
      yaml.blankLine?.(s.yaml, unit);
    },
    token(stream, state) {
      if (stream.sol()) state.quote = null;

      if (state.inComment) {
        const rest = stream.string.slice(stream.pos);
        const close = COMMENT_CLOSE.exec(rest);
        if (!close) {
          stream.skipToEnd();
          return "comment";
        }
        stream.pos += close.index + close[0].length;
        state.inComment = false;
        return "comment";
      }

      if (state.inAction) {
        return tokenAction(stream, state);
      }

      const rest = stream.string.slice(stream.pos);
      const open = OPEN.exec(rest);
      if (open?.index === 0) {
        const afterOpen = stream.string.slice(stream.pos + open[0].length);
        if (afterOpen.startsWith("/*")) {
          stream.pos += open[0].length + 2;
          const close = COMMENT_CLOSE.exec(stream.string.slice(stream.pos));
          if (!close) {
            stream.skipToEnd();
            state.inComment = true;
          } else {
            stream.pos += close.index + close[0].length;
          }
          return "comment";
        }
        stream.pos += open[0].length;
        state.inAction = true;
        return "helmDelimiter";
      }

      const end = open ? stream.pos + open.index : stream.string.length;
      return withinYaml(stream, end, state);
    },
  };
}

export async function helmTemplate(): Promise<LanguageSupport> {
  const { yaml } = await import("@codemirror/legacy-modes/mode/yaml");
  return new LanguageSupport(StreamLanguage.define(helmParser(yaml)));
}
