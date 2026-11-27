// Go text/template actions over plain text or Helm YAML. The YAML parser reads up to the
// next template delimiter so the action never breaks YAML key/value tokenization.
import { LanguageSupport, StreamLanguage, StringStream, type StreamParser } from "@codemirror/language";
import { tags } from "@lezer/highlight";

type TemplateState<Y> = {
  yaml: Y;
  inAction: boolean;
  inComment: boolean;
  inRawString: boolean;
  quote: '"' | "'" | null;
};

const OPEN = /\{\{-?/;
const CLOSE = /-?\}\}/;
// `{{/* … */}}`, or with trim markers `{{- /* … */ -}}` (Go requires the space there).
const COMMENT_OPEN = /^\s*\/\*/;
const COMMENT_CLOSE = /\*\/\s*-?\}\}/;

const KEYWORDS = new Set(["if", "else", "end", "range", "with", "define", "template", "block", "break", "continue"]);
const ATOMS = new Set(["true", "false", "nil"]);
const BUILTINS = new Set([
  "and",
  "call",
  "eq",
  "ge",
  "gt",
  "html",
  "index",
  "js",
  "le",
  "len",
  "lt",
  "ne",
  "not",
  "or",
  "print",
  "printf",
  "println",
  "slice",
  "urlquery",
]);
const HELM_FUNCTIONS = new Set([
  "b64dec",
  "b64enc",
  "coalesce",
  "contains",
  "default",
  "dict",
  "empty",
  "fail",
  "first",
  "fromJson",
  "fromYaml",
  "get",
  "has",
  "hasKey",
  "hasPrefix",
  "hasSuffix",
  "include",
  "indent",
  "int",
  "int64",
  "join",
  "keys",
  "kindIs",
  "kindOf",
  "last",
  "list",
  "lookup",
  "lower",
  "merge",
  "mustMerge",
  "nindent",
  "pluck",
  "quote",
  "regexMatch",
  "replace",
  "required",
  "semverCompare",
  "set",
  "sha256sum",
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
  "values",
]);

function tokenAction<Y>(stream: StringStream, state: TemplateState<Y>, helm: boolean): string | null {
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
    return "templateDelimiter";
  }

  const ch = stream.peek();
  if (ch === "`") {
    stream.next();
    state.inRawString = true;
    return tokenAction(stream, state, helm);
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
    if (BUILTINS.has(word) || (helm && HELM_FUNCTIONS.has(word))) return "templateFunc";
    return "variableName";
  }

  stream.next();
  return null;
}

function templateParser<Y>(yaml?: StreamParser<Y>): StreamParser<TemplateState<Y | undefined>> {
  const helm = yaml !== undefined;
  const copy = (base: StreamParser<Y>, state: Y): Y =>
    base.copyState
      ? base.copyState(state)
      : (Object.fromEntries(
          Object.entries(state as object).map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v]),
        ) as Y);

  const tokenHost = (stream: StringStream, end: number, state: TemplateState<Y | undefined>): string | null => {
    if (!yaml || state.yaml === undefined) {
      stream.pos = end;
      return null;
    }
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

  const block = { open: "{{/*", close: "*/}}" };
  return {
    name: helm ? "helm-template" : "gotmpl",
    languageData: {
      ...yaml?.languageData,
      commentTokens: helm ? { line: "#", block } : { block },
    },
    tokenTable: {
      ...yaml?.tokenTable,
      atom: tags.propertyName,
      templateDelimiter: tags.special(tags.brace),
      templateFunc: tags.function(tags.variableName),
    },
    startState: (indentUnit) => ({
      yaml: yaml?.startState?.(indentUnit),
      inAction: false,
      inComment: false,
      inRawString: false,
      quote: null,
    }),
    copyState: (s) => ({ ...s, yaml: yaml && s.yaml !== undefined ? copy(yaml, s.yaml) : s.yaml }),
    blankLine: (s, unit) => {
      s.quote = null;
      if (yaml && s.yaml !== undefined) yaml.blankLine?.(s.yaml, unit);
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
        return tokenAction(stream, state, helm);
      }

      const rest = stream.string.slice(stream.pos);
      const open = OPEN.exec(rest);
      if (open?.index === 0) {
        const comment = COMMENT_OPEN.exec(stream.string.slice(stream.pos + open[0].length));
        if (comment) {
          stream.pos += open[0].length + comment[0].length;
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
        return "templateDelimiter";
      }

      const end = open ? stream.pos + open.index : stream.string.length;
      return tokenHost(stream, end, state);
    },
  };
}

export async function helmTemplate(): Promise<LanguageSupport> {
  const { yaml } = await import("@codemirror/legacy-modes/mode/yaml");
  return new LanguageSupport(StreamLanguage.define(templateParser(yaml)));
}

export function goTemplate(): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(templateParser()));
}
