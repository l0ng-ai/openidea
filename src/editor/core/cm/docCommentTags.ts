/**
 * Doc comment tags, as IntelliJ colours them inside `/** … *\/`: a block tag at the start of a
 * line and an inline `{@tag`, the value some tags take (a `@param` name, a KDoc subject or
 * `[link]`, a PHPDoc `$variable`) and HTML markup. Only comment nodes in the visible ranges are
 * scanned; the colours come from the highlight style (`--syn-doc-comment-tag*`, `--syn-doc-markup`).
 */
import { highlightingFor, syntaxTree } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { Prec, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { docCommentMarkup, docCommentTag, docCommentTagValue } from "./highlight";

export type DocCommentTagKind = "tag" | "value" | "markup";

export interface DocCommentTagRange {
  from: number;
  to: number;
  kind: DocCommentTagKind;
}

interface Dialect {
  /** Inline tags: `{@link …}`. */
  inline: boolean;
  /** HTML tags in the text. */
  markup: boolean;
  /** KDoc `[links]` in the text. */
  links?: boolean;
  /** The value of a block tag as `[from, to)` in `rest`, the line after the tag. */
  value?: (tag: string, rest: string) => [number, number] | null;
}

/** The value of `tags`: the last group of `value`, which ends the match. */
function valueOf(tags: RegExp, value: RegExp): Dialect["value"] {
  return (tag, rest) => {
    if (!tags.test(tag)) return null;
    const m = value.exec(rest);
    return m ? [m.index + m[0].length - m[1]!.length, m.index + m[0].length] : null;
  };
}

const JAVADOC: Dialect = { inline: true, markup: true, value: valueOf(/^@param$/, /^\s+(<\w+>|[\w$]+)/) };
const JSDOC: Dialect = { inline: true, markup: true };
// KDoc links the subject of these tags; a `[name]` anywhere in the text is a link too.
const KDOC: Dialect = {
  inline: false,
  markup: false,
  links: true,
  value: valueOf(/^@(?:param|property|throws|exception|see|sample)$/, /^\s+(\[[^\]\n]+\]|[\w.]+)/),
};
const PHPDOC: Dialect = {
  inline: true,
  markup: true,
  value: valueOf(/^@(?:[a-z]+-)?(?:param|var|property(?:-read|-write)?)$/, /^.*?(?:\s|&|\.\.\.)(\$[A-Za-z_]\w*)/),
};

/** By CodeMirror language name (`LanguageDescription.name`). */
const DIALECTS: Record<string, Dialect> = {
  Java: JAVADOC,
  Kotlin: KDOC,
  JavaScript: JSDOC,
  TypeScript: JSDOC,
  JSX: JSDOC,
  TSX: JSDOC,
  "Angular TypeScript": JSDOC,
  PHP: PHPDOC,
};

const COMMENT = /comment/i;
/** Indentation and the leading `*` of a comment line. */
const LEAD = /^\s*\**\s*/;
const BLOCK_TAG = /^@[A-Za-z][\w\\-]*/;
const INLINE_TAG = /\{@[A-Za-z][\w-]*/g;
const LINK = /\[[^[\]\n]+\](?![([])/g;
// Known HTML elements only, so generics such as `List<String>` stay text.
const MARKUP =
  /<\/?(?:a|abbr|b|big|blockquote|br|caption|cite|code|dd|del|details|div|dl|dt|em|h[1-6]|hr|i|img|ins|kbd|li|ol|p|pre|q|s|samp|section|small|span|strong|sub|summary|sup|table|tbody|td|th|thead|tr|tt|u|ul|var)\b[^<>]*>/gi;
/** `/**` opens a doc comment; `/**\/` is an empty block comment. */
const opensDoc = (head: string) => head.startsWith("/**") && !head.startsWith("/**/");

function scanComment(
  state: EditorState,
  dialect: Dialect,
  comment: { from: number; to: number },
  range: { from: number; to: number },
  out: DocCommentTagRange[],
) {
  const end = Math.min(comment.to, range.to);
  for (let pos = Math.max(comment.from, range.from); pos <= end;) {
    const line = state.doc.lineAt(pos);
    const from = Math.max(line.from, comment.from);
    let text = state.sliceDoc(from, Math.min(line.to, comment.to));
    if (text.endsWith("*/")) text = text.slice(0, -2);
    const skip = from === comment.from && opensDoc(text.slice(0, 4)) ? 3 : 0;
    const lead = skip + LEAD.exec(text.slice(skip))![0].length;
    const tag = BLOCK_TAG.exec(text.slice(lead));
    if (tag) {
      const at = from + lead;
      out.push({ from: at, to: at + tag[0].length, kind: "tag" });
      const value = dialect.value?.(tag[0], text.slice(lead + tag[0].length));
      if (value) out.push({ from: at + tag[0].length + value[0], to: at + tag[0].length + value[1], kind: "value" });
    }
    const rest = text.slice(skip);
    const base = from + skip;
    if (dialect.inline)
      for (const m of rest.matchAll(INLINE_TAG))
        out.push({ from: base + m.index + 1, to: base + m.index + m[0].length, kind: "tag" });
    if (dialect.links)
      for (const m of rest.matchAll(LINK))
        out.push({ from: base + m.index, to: base + m.index + m[0].length, kind: "value" });
    if (dialect.markup)
      for (const m of rest.matchAll(MARKUP))
        out.push({ from: base + m.index, to: base + m.index + m[0].length, kind: "markup" });
    pos = line.to + 1;
  }
}

/** Tag, value and markup ranges in the doc comments between `from` and `to`, sorted, without overlaps. */
export function docCommentTagRanges(
  state: EditorState,
  language: string,
  from: number,
  to: number,
): DocCommentTagRange[] {
  const dialect = Object.hasOwn(DIALECTS, language) ? DIALECTS[language] : undefined;
  if (!dialect) return [];
  const found: DocCommentTagRange[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (!COMMENT.test(node.name)) return;
      const doc =
        language === "Kotlin" ? node.name === "docComment" : opensDoc(state.sliceDoc(node.from, node.from + 4));
      if (doc) scanComment(state, dialect, node, { from, to }, found);
      return false;
    },
  });
  found.sort((a, b) => a.from - b.from);
  const out: DocCommentTagRange[] = [];
  for (const r of found) if (!out.length || r.from >= out[out.length - 1]!.to) out.push(r);
  return out;
}

/**
 * The doc comments between `from` and `to`, clipped to them. A Lezer grammar has one
 * node for `/* *\/` and `/** *\/` alike, so the highlighter gives a doc comment the plain
 * comment colour; IntelliJ gives it the doc comment colour, and these ranges carry it.
 */
export function docCommentBodies(
  state: EditorState,
  language: string,
  from: number,
  to: number,
): Array<{ from: number; to: number }> {
  if (!Object.hasOwn(DIALECTS, language)) return [];
  const out: Array<{ from: number; to: number }> = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (!COMMENT.test(node.name)) return;
      const doc =
        language === "Kotlin" ? node.name === "docComment" : opensDoc(state.sliceDoc(node.from, node.from + 4));
      const body = { from: Math.max(node.from, from), to: Math.min(node.to, to) };
      if (doc && body.from < body.to) out.push(body);
      return false;
    },
  });
  return out;
}

const TAGS = { tag: docCommentTag, value: docCommentTagValue, markup: docCommentMarkup };
const marks = new Map<string, Decoration>();

function markFor(cls: string): Decoration {
  let mark = marks.get(cls);
  if (!mark) marks.set(cls, (mark = Decoration.mark({ class: cls })));
  return mark;
}

function decorations(view: EditorView, language: string): DecorationSet {
  const ranges = [];
  // The comment's own colour first: a mark spanning the tags' wraps theirs, so a tag keeps its colour.
  const body = highlightingFor(view.state, [tags.docComment]);
  if (body)
    for (const range of view.visibleRanges)
      for (const r of docCommentBodies(view.state, language, range.from, range.to))
        ranges.push(markFor(body).range(r.from, r.to));
  // A fold inside one line splits it into two visible ranges that both scan that whole line.
  const found = view.visibleRanges
    .flatMap((range) => docCommentTagRanges(view.state, language, range.from, range.to))
    .sort((a, b) => a.from - b.from);
  let end = -1;
  for (const r of found) {
    if (r.from < end) continue;
    const cls = highlightingFor(view.state, [TAGS[r.kind]]);
    if (!cls) continue;
    ranges.push(markFor(cls).range(r.from, r.to));
    end = r.to;
  }
  return Decoration.set(ranges, true);
}

/** Doc comment tag highlighting for a CodeMirror language (by name); none where IntelliJ has none. */
export function docCommentTags(language: string): Extension {
  if (!Object.hasOwn(DIALECTS, language)) return [];
  // Above the syntax highlighters (Lezer and tree-sitter), so the marks nest inside the comment's and win.
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorations(view, language);
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.transactions.some((t) => t.reconfigured) ||
          syntaxTree(u.state) !== syntaxTree(u.startState)
        )
          this.decorations = decorations(u.view, language);
      }
    },
    { decorations: (v) => v.decorations },
  );
  return Prec.highest(plugin);
}
