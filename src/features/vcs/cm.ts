/**
 * CodeMirror setup for the VCS viewers (diff, merge, local history): token
 * based theme + syntax colours and lazy language loading by file name.
 */
import { HighlightStyle, LanguageDescription, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { EditorState, RangeSetBuilder, type Extension, type Line } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { getChunks } from "@codemirror/merge";
import { defaultKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";

const wholeLine = Decoration.line({ class: "cm-diffWholeLine" });

/**
 * Marks the changed lines that have no counterpart on the other side (inserted
 * or deleted as a whole) so they get a solid background. Lines paired with a
 * line on the other side keep the line tint plus word-level highlights.
 */
function wholeLineDeco(view: EditorView): DecorationSet {
  const info = getChunks(view.state);
  if (!info || !info.side) return Decoration.none;
  const isA = info.side === "a";
  const { doc } = view.state;
  const { from: vpFrom, to: vpTo } = view.viewport;
  const builder = new RangeSetBuilder<Decoration>();
  for (const chunk of info.chunks) {
    const from = isA ? chunk.fromA : chunk.fromB;
    const to = isA ? chunk.toA : chunk.toB;
    if (from >= vpTo) break;
    if (from === to || to < vpFrom) continue;
    const otherEmpty = isA ? chunk.fromB === chunk.toB : chunk.fromA === chunk.toA;
    const ranges = chunk.changes.map((c) => (isA ? [c.fromA, c.toA] : [c.fromB, c.toB]).map((p) => p + from));
    // Covered including the line break after it, or the one before it (a deleted last line).
    const covered = (line: Line) =>
      ranges.some(([f = 0, t = 0]) => (f <= line.from && t > line.to) || (f < line.from && t >= line.to));
    for (let line = doc.lineAt(Math.max(from, vpFrom)); line.from < Math.min(to, vpTo);) {
      if (otherEmpty || covered(line)) builder.add(line.from, line.from, wholeLine);
      if (line.number === doc.lines) break;
      line = doc.line(line.number + 1);
    }
  }
  return builder.finish();
}

const wholeChangedLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = wholeLineDeco(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        getChunks(update.startState)?.chunks !== getChunks(update.state)?.chunks
      )
        this.decorations = wholeLineDeco(update.view);
    }
  },
  { decorations: (value) => value.decorations },
);

export const viewerHighlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword],
    color: "var(--syn-keyword)",
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--syn-string)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--syn-type)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-function)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.annotation, t.meta, t.attributeName], color: "var(--syn-annotation)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: "var(--syn-constant)" },
  { tag: [t.punctuation, t.bracket, t.operator], color: "var(--syn-punct)" },
  { tag: [t.propertyName], color: "var(--syn-property)" },
  { tag: [t.variableName], color: "var(--syn-variable)" },
  { tag: t.invalid, color: "var(--syn-invalid)" },
  { tag: t.heading, fontWeight: "var(--fw-code-bold, 700)", color: "var(--fg-strong)" },
  { tag: t.link, color: "var(--link)", textDecoration: "underline" },
]);

export const viewerTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--bg-app)",
      color: "var(--fg)",
      fontSize: "var(--fs-code)",
    },
    ".cm-scroller": { fontFamily: "var(--font-mono)", fontWeight: "var(--fw-code, 400)", lineHeight: "var(--lh-code)" },
    ".cm-content": { caretColor: "var(--accent)", WebkitUserSelect: "text", userSelect: "text" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "var(--bg-selected-strong)",
    },
    ".cm-activeLine": { backgroundColor: "var(--bg-current-line)" },
    ".cm-gutters": {
      backgroundColor: "var(--bg-app)",
      color: "var(--fg-gutter)",
      border: "none",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "32px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg-secondary)" },
    // @codemirror/merge
    "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": {
      backgroundColor: "color-mix(in srgb, var(--gutter-deleted) 12%, transparent)",
    },
    "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": {
      backgroundColor: "color-mix(in srgb, var(--gutter-added) 12%, transparent)",
    },
    "&.cm-merge-a .cm-changedLine.cm-diffWholeLine": {
      backgroundColor: "color-mix(in srgb, var(--danger) 26%, transparent)",
    },
    "&.cm-merge-b .cm-changedLine.cm-diffWholeLine": {
      backgroundColor: "color-mix(in srgb, var(--success) 26%, transparent)",
    },
    "&.cm-merge-a .cm-diffWholeLine .cm-changedText, &.cm-merge-b .cm-diffWholeLine .cm-changedText": {
      background: "transparent",
    },
    "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": {
      background: "color-mix(in srgb, var(--danger) 26%, transparent)",
    },
    "&.cm-merge-b .cm-changedText": {
      background: "color-mix(in srgb, var(--success) 26%, transparent)",
    },
    "&.cm-merge-b .cm-changedText, .cm-insertedLine .cm-changedText": {
      background: "color-mix(in srgb, var(--success) 26%, transparent)",
    },
    ".cm-changeGutter": { width: "3px", paddingLeft: "0" },
    "&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter": { background: "var(--gutter-deleted)" },
    "&.cm-merge-b .cm-changedLineGutter": { background: "var(--gutter-modified)" },
    ".cm-collapsedLines": {
      padding: "2px 10px",
      background: "var(--bg-elev)",
      color: "var(--fg-subtle)",
      fontFamily: "var(--font-ui)",
      fontSize: "var(--fs-small)",
      cursor: "pointer",
    },
    ".cm-collapsedLines:before": { content: "none" },
    ".cm-collapsedLines:after": { content: "none" },
    ".cm-chunkButtons button": {
      font: "inherit",
      fontFamily: "var(--font-ui)",
      fontSize: "var(--fs-tiny)",
      padding: "0 6px",
      border: "1px solid var(--border-strong)",
      borderRadius: "var(--radius-small)",
      background: "var(--bg-elev)",
      color: "var(--fg-secondary)",
    },
    ".cm-panels": { backgroundColor: "var(--bg-elev)", color: "var(--fg)" },
    ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)" },
  },
  { dark: true },
);

/** Base extensions for a read-only (or editable) viewer pane. */
export function viewerBase(opts: { readOnly: boolean; lineNumbers?: boolean }): Extension[] {
  return [
    opts.lineNumbers === false ? [] : lineNumbers(),
    drawSelection(),
    highlightActiveLine(),
    search({ top: true }),
    keymap.of([...searchKeymap, ...defaultKeymap]),
    syntaxHighlighting(viewerHighlight),
    viewerTheme,
    wholeChangedLines,
    EditorState.readOnly.of(opts.readOnly),
    EditorView.editable.of(!opts.readOnly),
    // Non-editable revision panes still need keyboard selection and copy.
    opts.readOnly ? EditorView.contentAttributes.of({ tabindex: "0" }) : [],
  ];
}

let languagesPromise: Promise<readonly LanguageDescription[]> | null = null;
const cache = new Map<string, Promise<LanguageSupport | null>>();

/** Loads the language for `fileName` (by extension / name), or null. */
export function languageFor(fileName: string): Promise<LanguageSupport | null> {
  const name = fileName.slice(fileName.lastIndexOf("/") + 1);
  const hit = cache.get(name);
  if (hit) return hit;
  languagesPromise ??= import("@codemirror/language-data").then((m) => m.languages);
  const p = languagesPromise
    .then((langs) => LanguageDescription.matchFilename(langs, name))
    .then((desc) => (desc ? desc.load() : null))
    .catch(() => null);
  cache.set(name, p);
  return p;
}
