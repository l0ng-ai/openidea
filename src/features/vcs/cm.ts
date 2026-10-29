/**
 * CodeMirror setup for the VCS viewers (diff, merge, local history): token
 * based theme + syntax colours and lazy language loading by file name.
 */
import { HighlightStyle, LanguageDescription, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import {
  Compartment,
  EditorState,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type Line,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutterLineClass,
  highlightActiveLine,
  keymap,
  lineNumbers,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { getChunks, mergeViewSiblings, type Chunk } from "@codemirror/merge";
import { defaultKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { findExtension } from "@/editor/core/cm/find";
import { caretExtension } from "@/editor/core/cm/prefs";
import { fontExtension } from "@/editor/core/cm/setup";
import { caretStyles, findLocals, findStyles } from "@/editor/core/cm/theme";
import { editorPrefs } from "@/platform/editorSettings";
import { useProject } from "@/platform/project";
import { hasInnerFragments } from "./diffOptions";

/** IDEA's change types (TextDiffType): both sides have text, only the new side, only the old side. */
export type DiffKind = "modified" | "inserted" | "deleted";

const kindOf = (hasA: boolean, hasB: boolean): DiffKind => (hasA && hasB ? "modified" : hasA ? "deleted" : "inserted");

/** A chunk's type (DiffUtil.getLineDiffType), by the sides it has lines on. */
export const chunkKind = (chunk: Chunk): DiffKind => kindOf(chunk.fromA !== chunk.toA, chunk.fromB !== chunk.toB);

const KINDS: readonly DiffKind[] = ["modified", "inserted", "deleted"];

const byKind = <T>(make: (kind: DiffKind) => T) =>
  Object.fromEntries(KINDS.map((k) => [k, make(k)])) as Record<DiffKind, T>;

/** Line backgrounds by type; `fine` ones (words compared) are lighter. */
const lineDecos = byKind((kind) => ({
  coarse: Decoration.line({ class: `cm-diffLine cm-diffLine-${kind}` }),
  fine: Decoration.line({ class: `cm-diffLine cm-diffLine-${kind} cm-diffLine-fine` }),
}));

const wordDecos = byKind((kind) => Decoration.mark({ class: `cm-diffWord cm-diffWord-${kind}` }));

/** A word on the other side only: a thin bar where it would be (DiffEmptyHighlighterRenderer). */
class EmptyWordMarker extends WidgetType {
  constructor(readonly kind: DiffKind) {
    super();
  }
  eq(other: EmptyWordMarker) {
    return other.kind === this.kind;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = `cm-diffWordEmpty cm-diffWord-${this.kind}`;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

const emptyWordDecos = byKind((kind) => Decoration.widget({ widget: new EmptyWordMarker(kind), side: 1 }));

/**
 * Calls `f` for the changed lines of a side-by-side pane between `vpFrom` and
 * `vpTo`, with the type of their chunk (DiffUtil.getLineDiffType): a chunk
 * with lines on both sides is modified as a whole, however its words changed.
 */
function forChangedLines(
  state: EditorState,
  vpFrom: number,
  vpTo: number,
  f: (line: Line, kind: DiffKind, fine: boolean) => void,
) {
  const info = getChunks(state);
  if (!info || !info.side) return;
  const isA = info.side === "a";
  const { doc } = state;
  for (const chunk of info.chunks) {
    const from = isA ? chunk.fromA : chunk.fromB;
    const to = isA ? chunk.toA : chunk.toB;
    if (from > vpTo) break;
    if (from === to || to < vpFrom) continue;
    const kind = chunkKind(chunk);
    const fine = hasInnerFragments(chunk);
    // A line starting at `vpTo` is still in view (the empty last line).
    for (let line = doc.lineAt(Math.max(from, vpFrom)); line.from < to && line.from <= vpTo;) {
      f(line, kind, fine);
      if (line.number === doc.lines) break;
      line = doc.line(line.number + 1);
    }
  }
}

/**
 * Line backgrounds in the colour of their chunk's type
 * (DiffDrawUtil.LineHighlighterBuilder). The unified view shows every new
 * line as inserted, below the old ones as deleted (createUnifiedChunkHighlighters).
 */
function lineDeco(view: EditorView): DecorationSet {
  const unified = !mergeViewSiblings(view);
  const builder = new RangeSetBuilder<Decoration>();
  forChangedLines(view.state, view.viewport.from, view.viewport.to, (line, kind, fine) => {
    const decos = lineDecos[unified ? "inserted" : kind];
    builder.add(line.from, line.from, fine ? decos.fine : decos.coarse);
  });
  return builder.finish();
}

/**
 * The inner fragments of chunks whose words were compared, each in the colour
 * of its own type (SimpleDiffChangeUi.createInlineHighlighter); a fragment
 * empty on this side is a thin bar.
 */
function wordDeco(view: EditorView): DecorationSet {
  const info = getChunks(view.state);
  // The unified view highlights words itself (`highlightChanges`).
  if (!info || !info.side || !mergeViewSiblings(view)) return Decoration.none;
  const isA = info.side === "a";
  const { from: vpFrom, to: vpTo } = view.viewport;
  const builder = new RangeSetBuilder<Decoration>();
  for (const chunk of info.chunks) {
    const base = isA ? chunk.fromA : chunk.fromB;
    if (base > vpTo) break;
    if ((isA ? chunk.toA : chunk.toB) < vpFrom || !hasInnerFragments(chunk)) continue;
    for (const c of chunk.changes) {
      const [from, to] = isA ? [c.fromA, c.toA] : [c.fromB, c.toB];
      const kind = kindOf(c.fromA !== c.toA, c.fromB !== c.toB);
      if (from < to) builder.add(base + from, base + to, wordDecos[kind]);
      else builder.add(base + from, base + from, emptyWordDecos[kind]);
    }
  }
  return builder.finish();
}

class LineClassMarker extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }
}

const gutterMarkers = byKind((kind) => ({
  coarse: new LineClassMarker(`cm-diffChangedGutter cm-diffGutter-${kind}`),
  fine: new LineClassMarker(`cm-diffChangedGutter cm-diffGutter-${kind} cm-diffGutter-fine`),
}));

/** The line background of changed lines carried into the gutters (line numbers, inclusion boxes), as in IDEA. */
export const changedLineGutters = StateField.define<RangeSet<GutterMarker>>({
  create: (state) => changedGutterMarkers(state),
  update: (value, tr) =>
    tr.docChanged || getChunks(tr.startState)?.chunks !== getChunks(tr.state)?.chunks
      ? changedGutterMarkers(tr.state)
      : value,
  provide: (f) => gutterLineClass.from(f),
});

function changedGutterMarkers(state: EditorState): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  forChangedLines(state, 0, state.doc.length, (line, kind, fine) =>
    builder.add(line.from, line.from, fine ? gutterMarkers[kind].fine : gutterMarkers[kind].coarse),
  );
  return builder.finish();
}

/** Recomputes `build` when the document, viewport or chunks change. */
const chunkDecorations = (build: (view: EditorView) => DecorationSet) =>
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          getChunks(update.startState)?.chunks !== getChunks(update.state)?.chunks
        )
          this.decorations = build(update.view);
      }
    },
    { decorations: (value) => value.decorations },
  );

const changedLines = chunkDecorations(lineDeco);

/**
 * IDEA's "Highlight words" for a side-by-side pane: the inner fragments of
 * chunks whose words were compared, over their lighter line background.
 */
export const diffWords: Extension = [
  chunkDecorations(wordDeco),
  EditorView.editorAttributes.of({ class: "cm-diffWords" }),
];

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
      fontSize: "var(--openidea-editor-font-size, var(--fs-code))",
      ...findLocals,
    },
    ".cm-scroller": {
      fontFamily: "var(--openidea-editor-font, var(--font-mono))",
      fontWeight: "var(--fw-code, 400)",
      lineHeight: "var(--openidea-editor-line-height, var(--lh-code))",
      fontVariantLigatures: "none",
    },
    "&.cm-openidea-ligatures .cm-scroller": { fontVariantLigatures: "normal" },
    ".cm-content": { caretColor: "var(--caret, var(--fg-strong))", WebkitUserSelect: "text", userSelect: "text" },
    ...caretStyles,
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
    // Side-by-side panes colour lines by their chunk's type (changedLines) instead of the library's tint.
    "&.cm-merge-a .cm-changedLine, &.cm-merge-b .cm-changedLine": { backgroundColor: "transparent" },
    ".cm-line.cm-diffLine-modified, .cm-diffGutter-modified": { backgroundColor: "var(--diff-modified)" },
    ".cm-line.cm-diffLine-inserted, .cm-diffGutter-inserted": { backgroundColor: "var(--diff-inserted)" },
    ".cm-line.cm-diffLine-deleted, .cm-diffGutter-deleted": { backgroundColor: "var(--diff-deleted)" },
    // Chunks whose words were compared take the lighter colour (TextDiffType.getIgnoredColor), their fragments the full one.
    ...Object.fromEntries(
      KINDS.map((k) => [
        `.cm-line.cm-diffLine-fine.cm-diffLine-${k}, .cm-diffGutter-fine.cm-diffGutter-${k}`,
        { backgroundColor: `color-mix(in srgb, var(--diff-${k}) 40%, var(--bg-app))` },
      ]),
    ),
    // Full line height, as IDEA paints them: an inline background only covers the font's height,
    // leaving stripes between the lines of a multi-line fragment.
    ".cm-diffWord": { display: "inline-block" },
    ".cm-diffWord-modified": { backgroundColor: "var(--diff-modified)" },
    ".cm-diffWord-inserted": { backgroundColor: "var(--diff-inserted)" },
    ".cm-diffWord-deleted": { backgroundColor: "var(--diff-deleted)" },
    ".cm-diffWordEmpty": {
      display: "inline-block",
      width: "2px",
      height: "1lh",
      margin: "0 -1px",
      verticalAlign: "top",
    },
    // The unified view: old lines deleted, new lines inserted.
    ".cm-deletedChunk": { backgroundColor: "var(--diff-deleted)" },
    "&.cm-diffWords .cm-deletedChunk": {
      backgroundColor: "color-mix(in srgb, var(--diff-deleted) 40%, var(--bg-app))",
    },
    ".cm-deletedChunk .cm-deletedText": { background: "var(--diff-deleted)" },
    "&.cm-merge-b .cm-changedText": { background: "var(--diff-inserted)" },
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
    ...findStyles,
  },
  { dark: true },
);

const caretSlot = new Compartment();
const fontSlot = new Compartment();

const editorSettings = () => useProject.getState().settings?.editor;

/**
 * The editor's caret (Settings › Editor › General › Appearance) and font
 * (Settings › Editor › Font), kept in step with the settings.
 */
function viewerEditorLook(): Extension {
  return [
    caretSlot.of(caretExtension(editorPrefs())),
    fontSlot.of(fontExtension(editorSettings())),
    ViewPlugin.define((view) => {
      let appearance = editorPrefs().appearance;
      let editor = editorSettings();
      const unsubscribe = useProject.subscribe(() => {
        const effects: StateEffect<unknown>[] = [];
        const next = editorPrefs();
        if (JSON.stringify(next.appearance) !== JSON.stringify(appearance)) {
          appearance = next.appearance;
          effects.push(caretSlot.reconfigure(caretExtension(next)));
        }
        if (editorSettings() !== editor) {
          editor = editorSettings();
          effects.push(fontSlot.reconfigure(fontExtension(editor)));
        }
        if (effects.length) view.dispatch({ effects });
      });
      return { destroy: unsubscribe };
    }),
  ];
}

/**
 * Base extensions for a read-only (or editable) viewer pane. `findBar`: the
 * viewer shows the editor's find bar (FindPanel) instead of CodeMirror's panel.
 */
export function viewerBase(opts: { readOnly: boolean; lineNumbers?: boolean; findBar?: boolean }): Extension[] {
  return [
    opts.lineNumbers === false ? [] : lineNumbers(),
    viewerEditorLook(),
    highlightActiveLine(),
    opts.findBar
      ? [findExtension(), keymap.of(defaultKeymap)]
      : [search({ top: true }), keymap.of([...searchKeymap, ...defaultKeymap])],
    syntaxHighlighting(viewerHighlight),
    viewerTheme,
    changedLines,
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
