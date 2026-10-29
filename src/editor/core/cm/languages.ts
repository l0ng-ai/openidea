/**
 * Language support: backend `LanguageInfo` (from `languages()`, fetched once)
 * maps a document's language id to the exact `@codemirror/language-data` name
 * (`uiMode`); the CodeMirror mode is loaded lazily and cached. Comment tokens
 * and indentation fall back to the backend definition when the mode lacks them.
 */
import { EditorState, Prec, type Extension } from "@codemirror/state";
import {
  LRLanguage,
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
  indentService,
  language as languageFacet,
  type StreamParser,
} from "@codemirror/language";
import { styleTags, tags as t } from "@lezer/highlight";
import { languages as languageData } from "@codemirror/language-data";
import type { DocBackend, LanguageInfo } from "../backend";
import { _languageMode } from "@/editor/api";

let infos: Map<string, LanguageInfo> | null = null;
let infosPromise: Promise<Map<string, LanguageInfo>> | null = null;

export function loadLanguageInfos(backend: DocBackend): Promise<Map<string, LanguageInfo>> {
  return (infosPromise ??= backend
    .languages()
    .then((list) => (infos = new Map(list.map((l) => [l.id, l]))))
    .catch((e) => {
      console.warn("languages() failed", e);
      infosPromise = null;
      return (infos = new Map());
    }));
}

export function languageInfo(id: string): LanguageInfo | undefined {
  return infos?.get(id);
}

/** Test hook. */
export function _resetLanguages() {
  infos = null;
  infosPromise = null;
}

/**
 * `uiMode` of the backend language for a file name (longest extension first,
 * like the backend's detection); `undefined` when the languages are not loaded
 * or none matches.
 */
export function uiModeForPath(path: string): string | null | undefined {
  if (!infos) return undefined;
  let rest = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  for (let dot = rest.indexOf("."); dot >= 0; dot = rest.indexOf(".")) {
    rest = rest.slice(dot + 1);
    for (const info of infos.values()) if (info.extensions.includes(rest)) return info.uiMode;
  }
  return undefined;
}

const supports = new Map<string, Promise<LanguageSupport | null>>();

const BATCH_KEYWORDS = new Set([
  "echo",
  "set",
  "if",
  "else",
  "goto",
  "call",
  "for",
  "in",
  "do",
  "exit",
  "setlocal",
  "endlocal",
  "not",
  "exist",
  "defined",
  "errorlevel",
  "shift",
  "pushd",
  "popd",
  "cd",
  "start",
  "pause",
  "title",
  "cls",
]);

const batchParser: StreamParser<null> = {
  name: "bat",
  startState: () => null,
  token(stream) {
    if (stream.eatSpace()) return null;
    const lineStart = /^\s*$/.test(stream.string.slice(0, stream.start));
    if (lineStart) {
      if (stream.match(/^@?::.*$/)) return "comment";
      if (stream.match(/^@?rem(?:\s.*|$)/i)) return "comment";
      if (stream.match(/^:[A-Za-z0-9_.-]+/)) return "labelName";
    }
    if (stream.match(/^::.*$/)) return "comment";
    if (stream.match(/^"(?:[^"]|"")*(?:"|$)/)) return "string";
    if (
      stream.match(/^%%(?:~[a-zA-Z]*)?[a-zA-Z0-9_]|^%[^%\s]+%|^%(?:~[a-zA-Z]*[0-9]|\*|[0-9])|^![A-Za-z_][A-Za-z0-9_]*!/)
    )
      return "variableName";
    if ((lineStart || /\s/.test(stream.string[stream.start - 1]!)) && stream.match(/^:[A-Za-z0-9_.-]+/))
      return "labelName";
    if (stream.eat("@")) return "punctuation";
    if (stream.match(/^\d+\b/)) return "number";
    const word =
      (stream.start === 0 || !/[A-Za-z0-9_.]/.test(stream.string[stream.start - 1]!)) &&
      stream.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (word) {
      const lower = (typeof word === "object" ? word[0] : "").toLowerCase();
      return BATCH_KEYWORDS.has(lower) ? "keyword" : null;
    }
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "@REM" } },
};

export const batchLanguage = StreamLanguage.define(batchParser);

const batchLanguageDescription = LanguageDescription.of({
  name: "Batch",
  alias: ["bat", "cmd"],
  extensions: ["bat", "cmd"],
  support: new LanguageSupport(batchLanguage),
});

const BUILTIN_MODES: readonly LanguageDescription[] = [...languageData, batchLanguageDescription];

export function findLanguageDescription(uiMode: string | null, path: string): LanguageDescription | null {
  if (uiMode) {
    const contributed = _languageMode(uiMode);
    if (contributed) return contributed;
    const exact = BUILTIN_MODES.find((l) => l.name === uiMode);
    if (exact) return exact;
    const loose = LanguageDescription.matchLanguageName(BUILTIN_MODES, uiMode, false);
    if (loose) return loose;
  }
  return uiMode === null && infos
    ? null
    : LanguageDescription.matchFilename(BUILTIN_MODES, path.slice(path.lastIndexOf("/") + 1));
}

/** Loads (once) the CodeMirror language for `desc`. */
export function loadSupport(desc: LanguageDescription): Promise<LanguageSupport | null> {
  let p = supports.get(desc.name);
  if (!p) {
    p = desc
      .load()
      .then((support) => patchSupport(desc, support))
      .catch((e) => {
        console.warn(`failed to load language ${desc.name}`, e);
        supports.delete(desc.name);
        return null;
      });
    supports.set(desc.name, p);
  }
  return p;
}

/**
 * PyCharm CSS colours: selectors fall back to HTML tag name, property names to
 * HTML attribute name, values and units to HTML attribute value.
 */
const CSS_TAGS: Parameters<typeof styleTags>[0] = {
  "FeatureName PropertyName": t.attributeName,
  "ValueName FontName Unit": t.attributeValue,
  "ClassName IdName PseudoClassName ColorLiteral CallTag": t.tagName,
};

/** Highlighting the stock grammars lack or colour unlike IntelliJ. */
const EXTRA_TAGS: Record<string, Parameters<typeof styleTags>[0]> = {
  // @lezer/java tags annotations as plain identifiers.
  Java: { "MarkerAnnotation/Identifier Annotation/Identifier MarkerAnnotation Annotation": t.annotation },
  CSS: CSS_TAGS,
  SCSS: CSS_TAGS,
  Sass: CSS_TAGS,
  // YAML keys are keywords in IntelliJ.
  YAML: { "Key/Literal Key/QuotedLiteral": t.keyword },
};

function patchSupport(desc: LanguageDescription, support: LanguageSupport): LanguageSupport {
  const extra = EXTRA_TAGS[desc.name];
  if (!extra || !(support.language instanceof LRLanguage)) return support;
  const patched = new LanguageSupport(support.language.configure({ props: [styleTags(extra)] }), support.support);
  // `loadedSupport` reads `desc.support` synchronously; keep it on the patched instance.
  (desc as { support: LanguageSupport | undefined }).support = patched;
  return patched;
}

/** Already-loaded support (synchronous), so reopening a file paints highlighted at once. */
export function loadedSupport(desc: LanguageDescription | null): LanguageSupport | null {
  return desc?.support ?? null;
}

const COLON_INDENT_LANGS = new Set(["gdscript", "python"]);
const DEDENT_STATEMENT = /^\s*(?:pass|break|continue|return)\b/;
const KEYWORD_OPEN_LANGS = new Set(["elixir", "ruby", "lua"]);
const KEYWORD_OPEN =
  /\b(?:do(?:\s*\|[^|]*\|)?|then|->)$|^\s*(?:def|defp|defmodule|class|module|function|local\s+function|if|unless|elsif|elseif|else|while|until|for|case|begin|cond|with|receive|try)\b/;
const NO_INDENT_LANGS = new Set(["plaintext", "markdown", "log", "diff", "ignore", "gitattributes"]);

function opensBlock(code: string, language: string | undefined): boolean {
  if (!code) return false;
  if (/[{([]$/.test(code)) return true;
  if (COLON_INDENT_LANGS.has(language ?? "") && code.endsWith(":")) return true;
  if (language === "elixir") return /\bdo$|->$/.test(code);
  if (KEYWORD_OPEN_LANGS.has(language ?? "") && !/\bend$/.test(code) && KEYWORD_OPEN.test(code)) return true;
  return false;
}

function dedentsAfter(code: string, language: string | undefined): boolean {
  if (!COLON_INDENT_LANGS.has(language ?? "")) return false;
  return DEDENT_STATEMENT.test(code) && !/[,\\]$/.test(code);
}

/** Hide literal contents before interpreting punctuation as block syntax. */
function indentationCode(text: string, lineComment: string | undefined): string {
  let code = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      code += "x";
    } else if (lineComment && text.startsWith(lineComment, i)) break;
    else code += ch;
  }
  return code.trimEnd();
}

/**
 * Fallback indentation for languages without a CodeMirror mode (GDScript, Zig,
 * Elixir, HCL, Terraform…): preserves the previous line's indentation and
 * indents one unit deeper after a block opener (`:`, `{`, `(`, `[` or keyword).
 */
export function fallbackIndent(language?: string): Extension {
  return indentService.of((cx, pos) => {
    if (cx.state.facet(languageFacet)) return undefined;
    const lineComment = cx.state.languageDataAt<{ line?: string }>("commentTokens", pos)[0]?.line;
    const stripComment = (text: string) => indentationCode(text, lineComment);

    const after = cx.textAfterPos(pos);
    const closingBracket = /^\s*[}\])]/.test(after);

    if (cx.simulatedBreak != null) {
      const line = cx.state.doc.lineAt(pos);
      const before = line.text.slice(0, pos - line.from);
      const base = cx.countColumn(before, before.search(/\S|$/));
      if (/\S/.test(before)) {
        const code = stripComment(before);
        if (closingBracket) return /[{([]$/.test(code) ? base : Math.max(0, base - cx.unit);
        if (opensBlock(code, language)) return base + cx.unit;
        if (dedentsAfter(code, language)) return Math.max(0, base - cx.unit);
        return base;
      }
      return base;
    }

    const curLine = cx.state.doc.lineAt(pos);
    for (let n = curLine.number - 1; n >= 1; n--) {
      const prev = cx.state.doc.line(n);
      if (!/\S/.test(prev.text)) continue;
      const base = cx.countColumn(prev.text, prev.text.search(/\S|$/));
      const code = stripComment(prev.text);
      if (closingBracket) return /[{([]$/.test(code) ? base : Math.max(0, base - cx.unit);
      if (opensBlock(code, language)) return base + cx.unit;
      if (dedentsAfter(code, language)) return Math.max(0, base - cx.unit);
      return base;
    }
    return 0;
  });
}

/** Comment tokens and fallback indentation from the backend definition, below the mode's own data. */
export function commentTokens(info: LanguageInfo | undefined, language = info?.id): Extension {
  const lang = language ?? info?.id;
  const hasComments = !!info && !!(info.lineComment || info.blockComment);
  const needsIndent = !!lang && !NO_INDENT_LANGS.has(lang);
  if (!hasComments && !needsIndent) return [];
  const data: Record<string, unknown> = {};
  if (hasComments) {
    const tokens: { line?: string; block?: { open: string; close: string } } = {};
    if (info!.lineComment) tokens.line = info!.lineComment;
    if (info!.blockComment) tokens.block = { open: info!.blockComment[0], close: info!.blockComment[1] };
    data.commentTokens = tokens;
  }
  if (needsIndent) data.indentOnInput = /^\s*[}\])]$/;
  const out: Extension[] = [Prec.lowest(EditorState.languageData.of(() => [data]))];
  if (needsIndent) out.push(Prec.lowest(fallbackIndent(lang)));
  return out;
}
