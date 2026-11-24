/**
 * CodeMirror setup for the VCS viewers (diff, merge, local history): token
 * based theme + syntax colours and lazy language loading through the editor's
 * language pipeline, so colours match the editor.
 */
import { highlightingFor, language, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
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
  gutter,
  gutterLineClass,
  highlightActiveLine,
  keymap,
  lineNumberMarkers,
  lineNumberWidgetMarker,
  lineNumbers,
  tooltips,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { getChunks, getOriginalDoc, mergeViewSiblings, type Chunk } from "@codemirror/merge";
import { defaultKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { scrollbarMarks, type ScrollbarMark } from "@/editor/api";
import { openideaHighlightStyle } from "@/editor/core/cm/highlight";
import { inlineBackground } from "@/editor/core/cm/inlineBg";
import { languageDescriptionFor, loadSupport } from "@/editor/core/cm/languages";
import { occurrenceSearch } from "@/editor/core/cm/editing";
import { findExtension } from "@/editor/core/cm/find";
import { overviewLane } from "@/editor/core/cm/lanes";
import { LINE_INSET } from "@/editor/core/cm/lineInset";
import { caretExtension } from "@/editor/core/cm/prefs";
import { fontExtension, tooltipBounds } from "@/editor/core/cm/setup";
import { caretStyles, findLocals, findStyles, markWidgetStyles, overviewStyles } from "@/editor/core/cm/theme";
import { editorPrefs } from "@/platform/editorSettings";
import { useProject } from "@/platform/project";
import { getDiffInsights, hasInnerFragments } from "./diffOptions";

/** IDEA's change types (TextDiffType): both sides have text, only the new side, only the old side. */
export type DiffKind = "modified" | "inserted" | "deleted";

const kindOf = (hasA: boolean, hasB: boolean): DiffKind => (hasA && hasB ? "modified" : hasA ? "deleted" : "inserted");

/** A chunk's type (DiffUtil.getLineDiffType), by the sides it has lines on. */
export const chunkKind = (chunk: Chunk): DiffKind => kindOf(chunk.fromA !== chunk.toA, chunk.fromB !== chunk.toB);

const KINDS: readonly DiffKind[] = ["modified", "inserted", "deleted"];

const byKind = <T>(make: (kind: DiffKind) => T) =>
  Object.fromEntries(KINDS.map((k) => [k, make(k)])) as Record<DiffKind, T>;

/**
 * Text-area diff backgrounds stay translucent so the selection layer, painted
 * below the content, shows through them; opaque line colours hide it. Gutters
 * have no selection and keep the full colour.
 */
const diffTint = (kind: DiffKind, pct: number) => `color-mix(in srgb, var(--diff-${kind}) ${pct}%, transparent)`;

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
  const moved = getDiffInsights(info.chunks)
    .moves.map((m) => (isA ? { from: m.fromA, to: m.toA } : { from: m.fromB, to: m.toB }))
    .sort((a, b) => a.from - b.from);
  let moveIndex = 0;
  for (const chunk of info.chunks) {
    const base = isA ? chunk.fromA : chunk.fromB;
    if (base > vpTo) break;
    if ((isA ? chunk.toA : chunk.toB) < vpFrom || !hasInnerFragments(chunk)) continue;
    for (const c of chunk.changes) {
      const [from, to] = isA ? [c.fromA, c.toA] : [c.fromB, c.toB];
      const kind = kindOf(c.fromA !== c.toA, c.fromB !== c.toB);
      let cursor = base + from;
      const end = base + to;
      while (moveIndex < moved.length && moved[moveIndex]!.to <= cursor) moveIndex++;
      if (from === to) {
        if (!moved[moveIndex] || moved[moveIndex]!.from > cursor) builder.add(cursor, cursor, emptyWordDecos[kind]);
        continue;
      }
      // Moved ranges have their own comparison against the actual counterpart.
      for (let i = moveIndex; i < moved.length && moved[i]!.from < end; i++) {
        const move = moved[i]!;
        if (move.from > cursor) builder.add(cursor, Math.min(move.from, end), wordDecos[kind]);
        cursor = Math.max(cursor, move.to);
      }
      if (cursor < end) builder.add(cursor, end, wordDecos[kind]);
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
export const chunkDecorations = (build: (view: EditorView) => DecorationSet) =>
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

/** Stripe colours by type (TextDiffType.getMarkerColor: the keys' ERROR_STRIPE_COLOR). */
const stripeColor = byKind((kind) => `var(--diff-${kind}-stripe)`);

/** The diff viewer's layouts, as the overview lane sees them. */
export type DiffLayout = "split" | "unified";

/**
 * The changes on the overview lane as marks across its width, after IDEA's diff error stripe
 * (DiffDrawUtil.LineHighlighterBuilder): a side-by-side pane marks each chunk's lines in the
 * chunk's type, an empty side a point where the lines would be. The unified view has no modified type: the old lines are marked deleted and the
 * new ones inserted (createUnifiedChunkHighlighters); the old lines sit above the new ones in a
 * widget, so their mark is a point on top of the inserted lines.
 */
export function diffScrollbarMarks(state: EditorState, unified: boolean, unifiedOnLeft = false): ScrollbarMark[] {
  const info = getChunks(state);
  if (!info) return [];
  if (unified)
    return info.chunks.flatMap((c) => {
      const marks: ScrollbarMark[] = [];
      if (c.fromB !== c.toB)
        marks.push({
          from: c.fromB,
          to: c.endB,
          color: stripeColor[unifiedOnLeft ? "deleted" : "inserted"],
          kind: "full",
        });
      if (c.fromA !== c.toA)
        marks.push({
          from: unifiedOnLeft ? c.endB : c.fromB,
          color: stripeColor[unifiedOnLeft ? "inserted" : "deleted"],
          kind: "full",
          priority: 1,
        });
      return marks;
    });
  const isA = info.side === "a";
  return info.chunks.map((c) => ({
    from: isA ? c.fromA : c.fromB,
    to: isA ? c.endA : c.endB,
    color: stripeColor[chunkKind(c)],
    kind: "full",
  }));
}

type ChunkMarks = { chunks: readonly Chunk[] | undefined; marks: readonly ScrollbarMark[] };

/** Recomputed when the chunks change, which can happen without a document change (MergeView, `updateOriginalDoc`). */
const chunkMarks = (unified: boolean, unifiedOnLeft: boolean) =>
  StateField.define<ChunkMarks>({
    create: (state) => ({ chunks: getChunks(state)?.chunks, marks: diffScrollbarMarks(state, unified, unifiedOnLeft) }),
    update: (value, tr) => {
      const chunks = getChunks(tr.state)?.chunks;
      return chunks === value.chunks ? value : { chunks, marks: diffScrollbarMarks(tr.state, unified, unifiedOnLeft) };
    },
    provide: (f) => scrollbarMarks.from(f, (v) => v.marks),
  });

/**
 * The overview lane with the diff's changes, over the pane's scrollbar. Every
 * diff pane scrolls itself, so each carries its own lane.
 */
export function diffOverview(layout: DiffLayout, unifiedOnLeft = false): Extension {
  return [chunkMarks(layout === "unified", unifiedOnLeft), overviewLane];
}

class WorkingChunk extends WidgetType {
  constructor(
    readonly text: string,
    readonly chunk: Chunk,
    readonly words: boolean,
  ) {
    super();
  }

  eq(other: WorkingChunk) {
    return other.chunk === this.chunk && other.text === this.text && other.words === this.words;
  }

  toDOM(view: EditorView) {
    const block = document.createElement("div");
    block.className = "cm-unifiedWorkingChunk";
    block.dataset.diffFirstLine = String(getOriginalDoc(view.state).lineAt(this.chunk.fromA).number);
    const makeRow = () => block.appendChild(document.createElement("div"));
    let row = makeRow();
    const tokens: Array<{ from: number; to: number; classes: string }> = [];
    const lang = view.state.facet(language);
    if (lang && this.text.length <= 3000)
      highlightTree(
        lang.parser.parse(this.text),
        { style: (tags) => highlightingFor(view.state, tags) },
        (from, to, classes) => {
          tokens.push({ from, to, classes });
        },
      );
    const words = this.words ? this.chunk.changes.filter((c) => c.fromA < c.toA) : [];
    let tokenIndex = 0;
    let wordIndex = 0;
    for (let at = 0; at < this.text.length;) {
      while (tokens[tokenIndex] && tokens[tokenIndex]!.to <= at) tokenIndex++;
      while (words[wordIndex] && words[wordIndex]!.toA <= at) wordIndex++;
      const token = tokens[tokenIndex];
      const word = words[wordIndex];
      const insideToken = token && token.from <= at;
      const insideWord = word && word.fromA <= at;
      const end = Math.min(
        this.text.length,
        (insideToken ? token.to : token?.from) ?? this.text.length,
        (insideWord ? word.toA : word?.fromA) ?? this.text.length,
      );
      const text = this.text.slice(at, end);
      const classes = [insideToken && token.classes, insideWord && "cm-unifiedWorkingWord"].filter(Boolean).join(" ");
      for (const [index, part] of text.split("\n").entries()) {
        if (index) {
          if (!row.firstChild) row.appendChild(document.createElement("br"));
          row = makeRow();
        }
        if (!part) continue;
        if (classes) {
          const span = row.appendChild(document.createElement("span"));
          span.className = classes;
          span.textContent = part;
        } else row.append(part);
      }
      at = end;
    }
    if (!row.firstChild) row.appendChild(document.createElement("br"));
    return block;
  }
}

/** CodeMirror stores the editable document on B. Keep the logical right text below the index lines. */
export function unifiedLeftDiff(words: boolean): Extension {
  const build = (state: EditorState): DecorationSet => {
    const original = getOriginalDoc(state);
    return Decoration.set(
      (getChunks(state)?.chunks ?? []).flatMap((chunk) => {
        if (chunk.fromA === chunk.toA) return [];
        const hasIndexLines = chunk.fromB !== chunk.toB;
        const at = Math.min(state.doc.length, hasIndexLines ? chunk.endB : chunk.fromB);
        const widget = new WorkingChunk(original.sliceString(chunk.fromA, chunk.endA), chunk, words);
        return [Decoration.widget({ widget, block: true, side: hasIndexLines ? 1 : -1 }).range(at)];
      }),
      true,
    );
  };
  const decorations = StateField.define<DecorationSet>({
    create: build,
    update: (value, tr) => (getChunks(tr.startState)?.chunks === getChunks(tr.state)?.chunks ? value : build(tr.state)),
    provide: (field) => EditorView.decorations.from(field),
  });
  return [decorations, EditorView.editorAttributes.of({ class: "cm-unified-left" })];
}

/**
 * IDEA's "Highlight words" for a side-by-side pane: the inner fragments of
 * chunks whose words were compared, over their lighter line background.
 */
export const diffWords: Extension = [
  chunkDecorations(wordDeco),
  EditorView.editorAttributes.of({ class: "cm-diffWords" }),
];

export const viewerTheme = EditorView.theme(
  {
    ...overviewStyles,
    "&.cm-editor": { height: "100%" },
    "&": {
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
    ".cm-content": {
      padding: "0 0 4px",
      caretColor: "var(--caret, var(--fg-strong))",
      WebkitUserSelect: "text",
      userSelect: "text",
    },
    ".cm-line": { padding: `0 2px 0 ${LINE_INSET}px` },
    ...caretStyles,
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "var(--bg-selected-strong)",
      // Unset (the default `inherit`): the declaration drops and the syntax colours show through.
      color: "var(--fg-editor-selection)",
    },
    ".cm-openidea-selected, &.cm-focused .cm-openidea-selected": {
      "--openidea-selected-bg": "var(--bg-selected-strong)",
      color: "var(--fg-editor-selection)",
    },
    ".cm-activeLine": { backgroundColor: "var(--bg-current-line)" },
    ".cm-gutters": {
      backgroundColor: "var(--bg-app)",
      color: "var(--fg-gutter)",
      border: "none",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "32px" },
    ".cm-gutters-after .cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 8px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg-secondary)" },
    // Side-by-side panes colour lines by their chunk's type (changedLines) instead of the library's tint.
    "&.cm-merge-a .cm-changedLine, &.cm-merge-b .cm-changedLine": { backgroundColor: "transparent" },
    // The unified view's own line tint (cm-inlineChangedLine), keyed to the inserted colour.
    ".cm-inlineChangedLine": { backgroundColor: diffTint("inserted", 70) },
    "&.cm-unified-left .cm-deletedChunk": { display: "none" },
    "&.cm-unified-left .cm-inlineChangedLine, &.cm-unified-left .cm-diffLine-inserted": {
      backgroundColor: diffTint("deleted", 70),
    },
    "&.cm-unified-left .cm-inlineChangedLine.cm-diffLine-fine": { backgroundColor: diffTint("deleted", 28) },
    "&.cm-unified-left .cm-changedText": { background: diffTint("deleted", 85) },
    ".cm-unifiedWorkingChunk": { paddingInline: `${LINE_INSET}px`, backgroundColor: diffTint("inserted", 70) },
    ".cm-unifiedWorkingWord": { background: diffTint("inserted", 85) },
    ".cm-line.cm-diffLine-modified": { backgroundColor: diffTint("modified", 70) },
    ".cm-line.cm-diffLine-inserted": { backgroundColor: diffTint("inserted", 70) },
    ".cm-line.cm-diffLine-deleted": { backgroundColor: diffTint("deleted", 70) },
    ".cm-diffGutter-modified": { backgroundColor: "var(--diff-modified)" },
    ".cm-diffGutter-inserted": { backgroundColor: "var(--diff-inserted)" },
    ".cm-diffGutter-deleted": { backgroundColor: "var(--diff-deleted)" },
    // Chunks whose words were compared take the lighter colour (TextDiffType.getIgnoredColor), their
    // fragments the full one; lines translucent so the selection shows through, gutters opaque.
    ...Object.assign(
      {},
      ...KINDS.flatMap((k) => [
        {
          [`.cm-line.cm-diffLine-fine.cm-diffLine-${k}`]: {
            backgroundColor: `color-mix(in srgb, var(--diff-${k}) 28%, transparent)`,
          },
        },
        {
          [`.cm-diffGutter-fine.cm-diffGutter-${k}`]: {
            backgroundColor: `color-mix(in srgb, var(--diff-${k}) 40%, var(--bg-app))`,
          },
        },
      ]),
    ),
    // Full line height, as IDEA paints them: an inline background only covers the font's height,
    // leaving stripes between the lines of a multi-line fragment.
    ".cm-diffWord": { display: "inline-block" },
    ".cm-diffWord-modified": { backgroundColor: diffTint("modified", 85) },
    ".cm-diffWord-inserted": { backgroundColor: diffTint("inserted", 85) },
    ".cm-diffWord-deleted": { backgroundColor: diffTint("deleted", 85) },
    ".cm-diffWordEmpty": {
      display: "inline-block",
      width: "2px",
      height: "1lh",
      margin: "0 -1px",
      verticalAlign: "top",
    },
    // The unified view: old lines deleted, new lines inserted. The old lines of a chunk whose words
    // were compared sit right above its first new line and take the lighter colour too.
    ".cm-deletedChunk": { backgroundColor: diffTint("deleted", 70) },
    "&.cm-diffWords .cm-deletedChunk:has(+ .cm-diffLine-fine)": { backgroundColor: diffTint("deleted", 28) },
    // Full line height, as `.cm-diffWord`.
    ".cm-deletedChunk .cm-deletedText": { display: "inline-block", background: diffTint("deleted", 85) },
    ".cm-content .cm-line.cm-unified-commit-selected, .cm-deletedChunk > .cm-unified-commit-selected": {
      backgroundColor: "var(--bg-editor-selection)",
      color: "var(--fg-editor-selection)",
    },
    "&.cm-merge-a .cm-changedText": { background: diffTint("deleted", 85) },
    "&.cm-merge-b .cm-changedText": { display: "inline-block", background: diffTint("inserted", 85) },
    ".cm-changeGutter": { width: "3px", paddingLeft: "0" },
    "&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter": { background: "var(--gutter-deleted)" },
    "&.cm-merge-b .cm-changedLineGutter": { background: "var(--gutter-modified)" },
    ".cm-collapsedLines": {
      WebkitUserSelect: "none",
      userSelect: "none",
      padding: "0",
      background: "var(--bg-editor)",
    },
    ".cm-collapsedLines > button": {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-1)",
      width: "100%",
      minHeight: "max(27px, var(--openidea-editor-line-height, var(--lh-code)))",
      padding: "0 var(--space-3)",
      color: "var(--fg-secondary)",
      fontFamily: "var(--font-ui)",
      fontSize: "var(--fs-ui)",
      lineHeight: "1.4",
      textAlign: "start",
      cursor: "pointer",
    },
    ".cm-collapsedLines > button:hover, .cm-collapsedLines > button:focus-visible": {
      backgroundColor: "var(--bg-hover)",
      color: "var(--fg-strong)",
    },
    ".cm-collapsedLines > button:focus-visible": { outlineOffset: "-2px" },
    ".cm-collapsedLines > button::after": {
      content: '""',
      flex: "1",
      height: "var(--space-1)",
      marginInlineStart: "var(--space-2)",
      background: "repeating-linear-gradient(-45deg, var(--diff-separator-wave) 0 1px, transparent 1px 5px)",
    },
    ".cm-diffCollapseLabel": {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
    ".cm-collapsedLines:before": { content: "none" },
    ".cm-collapsedLines:after": { content: "none" },
    // Clear of the overview lane over the scrollbar (12px wide).
    "&.cm-openidea-withOverview .cm-deletedChunk .cm-chunkButtons": { insetInlineEnd: "17px" },
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
    ".cm-searchMatch": inlineBackground("color-mix(in srgb, var(--accent) 22%, transparent)"),
    ...findStyles,
    ...markWidgetStyles,
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

export class LineNumber extends GutterMarker {
  constructor(readonly number: string) {
    super();
  }
  eq(other: LineNumber) {
    return this.number === other.number;
  }
  toDOM() {
    return document.createTextNode(this.number);
  }
}

export function maxLineNumber(lines: number): number {
  let last = 9;
  while (last < lines) last = last * 10 + 9;
  return last;
}

/**
 * Line numbers after the text, facing the divider: IDEA mirrors the left editor of a
 * side-by-side diff (TwosideTextDiffViewer moves its scrollbar to the left, and a mirrored
 * editor draws its gutter on the right). `lineNumbers()` has no `side`, so this is its gutter.
 */
const lineNumbersAfter: Extension = gutter({
  class: "cm-lineNumbers",
  side: "after",
  renderEmptyElements: false,
  markers: (view) => view.state.facet(lineNumberMarkers),
  lineMarker: (view, line, others) =>
    others.some((m) => m.toDOM) ? null : new LineNumber(String(view.state.doc.lineAt(line.from).number)),
  widgetMarker: (view, widget, block) => {
    for (const marker of view.state.facet(lineNumberWidgetMarker)) {
      const result = marker(view, widget, block);
      if (result) return result;
    }
    return null;
  },
  initialSpacer: (view) => new LineNumber(String(maxLineNumber(view.state.doc.lines))),
  updateSpacer: (spacer, update) => {
    const max = String(maxLineNumber(update.view.state.doc.lines));
    return (spacer as LineNumber).number === max ? spacer : new LineNumber(max);
  },
});

/**
 * Base extensions for a read-only (or editable) viewer pane. `findBar`: the
 * viewer shows the editor's find bar (FindPanel) instead of CodeMirror's panel.
 * `lineNumbers: "after"` puts them on the right, for the left pane of a side-by-side diff.
 */
export function viewerBase(opts: {
  readOnly: boolean;
  lineNumbers?: boolean | "after";
  findBar?: boolean;
}): Extension[] {
  return [
    opts.lineNumbers === false ? [] : opts.lineNumbers === "after" ? lineNumbersAfter : lineNumbers(),
    viewerEditorLook(),
    highlightActiveLine(),
    opts.findBar
      ? [findExtension(), keymap.of(defaultKeymap)]
      : [search({ top: true }), keymap.of([...searchKeymap, ...defaultKeymap])],
    syntaxHighlighting(openideaHighlightStyle),
    viewerTheme,
    changedLines,
    EditorState.readOnly.of(opts.readOnly),
    EditorView.editable.of(!opts.readOnly),
    // Add Selection for Next Occurrence, Clone Caret: several carets, as in the editor.
    EditorState.allowMultipleSelections.of(true),
    occurrenceSearch,
    // Non-editable revision panes still need keyboard selection and copy.
    opts.readOnly ? EditorView.contentAttributes.of({ tabindex: "0" }) : [],
  ];
}

/**
 * Tooltips of a pane showing an open document (quick docs, ⌘-hover info), parented to the
 * body as the editor's are, so the pane neither clips them nor keeps them under the tool
 * window stripes, and they move left to fit.
 */
export const documentTooltips: Extension = tooltips({
  parent: typeof document === "undefined" ? undefined : document.body,
  tooltipSpace: tooltipBounds,
});

/** The first line of a side's text, which decides hashbang-only scripts' language. */
export const firstLineOf = (text: string): string => text.slice(0, text.search(/\r?\n|$/));

/**
 * Loads the language `path` is shown with in the editor (`languageDescriptionFor`: Override
 * File Type, File Types patterns, hashbangs, framework modes, then the extension) through
 * the editor's pipeline (`loadSupport`): the same modes, tag patches and `data-language`
 * attribute, so colours match. `firstLine` is the shown text's (`firstLineOf`); without it
 * the file's own counts.
 */
export function languageFor(path: string, firstLine?: string | null): Promise<LanguageSupport | null> {
  return languageDescriptionFor(path, firstLine ?? undefined)
    .then((desc) => (desc ? loadSupport(desc) : null))
    .catch(() => null);
}
