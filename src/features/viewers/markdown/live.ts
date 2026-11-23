/**
 * Live Markdown source for the preview: an editor contribution on Markdown
 * files publishes the text, scroll position, and caret moves per path.
 * Preview Only follows navigation in the hidden editor.
 */
import { StateEffect, Text, type EditorState } from "@codemirror/state";
import { Decoration, Direction, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { SearchCursor, getSearchQuery } from "@codemirror/search";
import { create } from "zustand";
import { registerEditorContribution, useEditorRegistry } from "@/editor/api";
import { MAX_COUNT, findExcluded, findOpen, findScope } from "@/editor/core/cm/find";
import { fontZoom, resetConfiguredEditorsFontZoom, stepConfiguredEditorsFontZoom } from "@/editor/core/cm/prefs";
import { editorPrefs } from "@/platform/editorSettings";
import { useProject } from "@/platform/project";

export interface LiveMarkdownFind {
  search: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  /** 0-based source lines of each match in the document, in order. */
  matchLines: readonly number[];
  /** 0-based index of the selected match in `matchLines` (-1 when none). */
  currentMatchIndex: number;
}

export interface LiveMarkdown {
  text: Text;
  /** 0-based source line at the top of the editor, including progress through the line. */
  topLine: number;
  /** Whether the scrolling editor has reached its bottom. */
  sourceAtEnd: boolean;
  /** Bumped when the editor scrolls, so equal lines still resync. */
  scrollSeq: number;
  /** The editor's font zoom in px; the preview scales its text by the same amount. */
  fontZoom: number;
  /** The preview div's own scrollTop, kept so Preview Only survives a remount. */
  previewTop: number;
  /** 0-based caret line, set when the caret moves without an edit (navigation). */
  caretLine: number;
  /** Bumped with `caretLine`, so going to the same place again still scrolls. */
  caretSeq: number;
  /** Active Find in File query and match state for the preview. */
  find?: LiveMarkdownFind | null;
  /** Single-line text selected in the editor (2..200 chars), for preview occurrence highlighting. */
  editorSelection?: string;
  /** Single-line text selected in the preview (2..200 chars), for editor occurrence highlighting. */
  previewSelection?: string;
}

export const useLiveMarkdown = create<Record<string, LiveMarkdown | undefined>>(() => ({}));

const TEXT_DELAY = 120;
const setPreviewSelectionEffect = StateEffect.define<string>();
const previewSelectionMark = Decoration.mark({ class: "cm-selectionMatch" });

function publish(path: string, patch: Partial<LiveMarkdown>) {
  useLiveMarkdown.setState((s) => {
    const prev = s[path] ?? {
      text: Text.empty,
      topLine: 0,
      sourceAtEnd: false,
      scrollSeq: 0,
      fontZoom: 0,
      caretLine: 0,
      caretSeq: 0,
      previewTop: 0,
    };
    return { [path]: { ...prev, ...patch } };
  });
}

/** Steps or resets the Markdown preview's font zoom through its backing editor. */
export function stepMarkdownPreviewFontZoom(path: string, previewRoot: HTMLElement | null, delta: number): void {
  const pane = previewRoot?.closest("[data-pane-id]");
  const editors = [...useEditorRegistry.getState().editors].filter((ed) => ed.ctx.path === path);
  const match = (pane ? editors.find((ed) => pane.contains(ed.view.dom)) : undefined) ?? editors[0];
  if (!match) return;
  if (delta === 0) resetConfiguredEditorsFontZoom(match.view);
  else stepConfiguredEditorsFontZoom(match.view, delta);
}

/** Records the preview's own scroll offset, published by the preview's scroll listener. */
export function publishPreviewTop(path: string, top: number) {
  publish(path, { previewTop: top });
}

/** Records single-line text selected in the preview so a split editor highlights its occurrences. */
export function publishPreviewSelection(path: string, previewSelection: string) {
  if ((useLiveMarkdown.getState()[path]?.previewSelection ?? "") === previewSelection) return;
  publish(path, { previewSelection });
}

function findStateOf(state: EditorState): LiveMarkdownFind | null {
  if (!state.field(findOpen, false)) return null;
  const query = getSearchQuery(state);
  if (!query.valid) return null;
  const main = state.selection.main;
  const scope = state.field(findScope, false) ?? { from: 0, to: state.doc.length };
  const matchLines: number[] = [];
  let currentMatchIndex = -1;
  const cursor = query.getCursor(state, scope.from, scope.to);
  for (let r = cursor.next(); !r.done && matchLines.length < MAX_COUNT; r = cursor.next()) {
    const m = r.value;
    if (m.to === m.from) continue;
    if (m.from === main.from && m.to === main.to) currentMatchIndex = matchLines.length;
    matchLines.push(state.doc.lineAt(m.from).number - 1);
  }
  return {
    search: query.search,
    caseSensitive: query.caseSensitive,
    wholeWord: query.wholeWord,
    regexp: query.regexp,
    matchLines,
    currentMatchIndex,
  };
}

function sameFind(a: LiveMarkdownFind | null | undefined, b: LiveMarkdownFind | null): boolean {
  if ((a ?? null) === b) return true;
  if (!a || !b) return false;
  return (
    a.search === b.search &&
    a.caseSensitive === b.caseSensitive &&
    a.wholeWord === b.wholeWord &&
    a.regexp === b.regexp &&
    a.currentMatchIndex === b.currentMatchIndex &&
    a.matchLines.length === b.matchLines.length &&
    a.matchLines.every((l, i) => l === b.matchLines[i])
  );
}

function editorSelectionOf(state: EditorState): string {
  if (state.field(findOpen, false) || state.selection.ranges.length !== 1) return "";
  const main = state.selection.main;
  const len = main.to - main.from;
  if (len < 2 || len > 200) return "";
  const text = state.sliceDoc(main.from, main.to);
  if (text.includes("\n") || !text.trim()) return "";
  return text;
}

function previewSelectionDecorations(view: EditorView, query: string): DecorationSet {
  if (!query || query.length < 2 || query.length > 200) return Decoration.none;
  if (!editorPrefs(useProject.getState().settings).codeEditing.highlightSelection) return Decoration.none;
  const ranges = [];
  for (const part of view.visibleRanges) {
    const cursor = new SearchCursor(view.state.doc, query, part.from, part.to);
    while (!cursor.next().done) {
      ranges.push(previewSelectionMark.range(cursor.value.from, cursor.value.to));
      if (ranges.length > 500) return Decoration.none;
    }
  }
  return Decoration.set(ranges);
}

function sourcePositionOf(view: EditorView) {
  const scroller = view.scrollDOM;
  if (!view.inView || !scroller.clientHeight) return null;
  const y = Math.max(0, sourceViewportTop(view));
  const block = view.lineBlockAtHeight(y);
  const line = view.state.doc.lineAt(block.from);
  let fraction = block.height > 0 ? Math.max(0, Math.min(1, (y - block.top) / block.height)) : 0;
  const rowHeight = view.defaultLineHeight;
  if (
    view.lineWrapping &&
    rowHeight > 0 &&
    block.height > rowHeight * 1.5 &&
    block.from === line.from &&
    block.to === line.to
  ) {
    // Interpolate between the source offsets of the visible wrapped row and the following row.
    const row = Math.floor((y - block.top) / rowHeight);
    const rowTop = block.top + row * rowHeight;
    const rect = view.contentDOM.getBoundingClientRect();
    const x = view.textDirectionAt(line.from) === Direction.LTR ? rect.left + 1 : rect.right - 1;
    const middle = view.documentTop + rowTop + rowHeight / 2;
    const start = view.posAtCoords({ x, y: middle });
    const next =
      rowTop + rowHeight >= block.bottom - 0.5 ? line.to + 1 : view.posAtCoords({ x, y: middle + rowHeight });
    if (start !== null && next !== null && start >= line.from && next >= start && next <= line.to + 1) {
      const withinRow = Math.max(0, Math.min(1, (y - rowTop) / rowHeight));
      const span = line.length + Number(line.number < view.state.doc.lines);
      if (span) fraction = Math.min(1, (start - line.from + withinRow * (next - start)) / span);
    }
  }
  const topLine = line.number - 1 + fraction;
  const sourceAtEnd = scroller.scrollTop > 0 && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1;
  return { topLine, sourceAtEnd };
}

/** Redraws the split source before paint when a wheel jump passes its rendered lines. */
export function installMarkdownSourceScroll(root: HTMLElement): () => void {
  const onWheel = (event: WheelEvent) => {
    if (
      event.defaultPrevented ||
      !event.cancelable ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
      !event.deltaY ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
      !(event.target instanceof Element)
    )
      return;

    const scroller = event.target.closest<HTMLElement>(".cm-scroller");
    const view = scroller && EditorView.findFromDOM(scroller);
    if (!scroller || !view) return;

    const current = scroller.scrollTop;
    const height = scroller.clientHeight;
    const max = scroller.scrollHeight - height;
    const target = Math.min(max, Math.max(0, current + event.deltaY));
    if (max <= 0 || target === current) return;

    const scale = view.scaleY;
    const nextTop = sourceViewportTop(view) + (target - current) * scale;
    const blocks = view.viewportLineBlocks;
    const first = blocks[0];
    const last = blocks.at(-1);
    if (!first || !last) return;
    if (
      (view.viewport.from === 0 || nextTop >= first.top) &&
      (view.viewport.to === view.state.doc.length || nextTop + height * scale <= last.bottom)
    )
      return;

    // A native jump can expose a virtual gap before CodeMirror redraws. Move and measure together.
    event.preventDefault();
    scroller.scrollBy(event.deltaX, target - current);
    view.requestMeasure();
    view.lineBlockAtHeight(nextTop);
  };
  root.addEventListener("wheel", onWheel, { passive: false });
  return () => root.removeEventListener("wheel", onWheel);
}

function sourceViewportTop(view: EditorView): number {
  const scroller = view.scrollDOM;
  return scroller.getBoundingClientRect().top + scroller.clientTop * view.scaleY - view.documentTop;
}

function livePlugin(path: string) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private timer: ReturnType<typeof setTimeout> | undefined;
      private scrolled = false;
      private destroyed = false;
      private previewSel = "";
      private unsubscribe: () => void;
      private readonly measureSource = {
        read: sourcePositionOf,
        write: (position: ReturnType<typeof sourcePositionOf>) => {
          const scrolled = this.scrolled;
          this.scrolled = false;
          if (this.destroyed || !position) return;
          const prev = useLiveMarkdown.getState()[path];
          if (scrolled || position.topLine !== prev?.topLine || position.sourceAtEnd !== prev?.sourceAtEnd) {
            publish(path, { ...position, scrollSeq: (prev?.scrollSeq ?? 0) + Number(scrolled) });
          }
        },
      };
      private readonly onScroll = () => {
        this.scrolled = true;
        this.view.requestMeasure(this.measureSource);
      };

      constructor(private view: EditorView) {
        const current = useLiveMarkdown.getState()[path];
        this.previewSel = current?.previewSelection ?? "";
        this.decorations = previewSelectionDecorations(view, this.previewSel);
        publish(path, {
          text: view.state.doc,
          fontZoom: view.state.field(fontZoom, false) ?? 0,
          find: findStateOf(view.state),
          editorSelection: editorSelectionOf(view.state),
        });
        view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
        this.unsubscribe = useLiveMarkdown.subscribe((s) => {
          const next = s[path]?.previewSelection ?? "";
          if (next === this.previewSel) return;
          this.previewSel = next;
          queueMicrotask(() => {
            if (this.previewSel === next) this.view.dispatch({ effects: setPreviewSelectionEffect.of(next) });
          });
        });
      }

      private publishCaret() {
        const caretLine = this.view.state.doc.lineAt(this.view.state.selection.main.head).number - 1;
        publish(path, { caretLine, caretSeq: (useLiveMarkdown.getState()[path]?.caretSeq ?? 0) + 1 });
      }

      update(u: ViewUpdate) {
        const zoom = u.state.field(fontZoom, false) ?? 0;
        if (zoom !== (u.startState.field(fontZoom, false) ?? 0)) publish(path, { fontZoom: zoom });

        const findChanged =
          u.docChanged ||
          u.selectionSet ||
          u.startState.field(findOpen, false) !== u.state.field(findOpen, false) ||
          getSearchQuery(u.startState) !== getSearchQuery(u.state) ||
          u.startState.field(findScope, false) !== u.state.field(findScope, false) ||
          u.startState.field(findExcluded, false) !== u.state.field(findExcluded, false);

        if (findChanged) {
          const prev = useLiveMarkdown.getState()[path];
          const nextFind = findStateOf(u.state);
          const nextEditorSel = editorSelectionOf(u.state);
          const patch: Partial<LiveMarkdown> = {};
          if (!sameFind(prev?.find, nextFind)) patch.find = nextFind;
          if ((prev?.editorSelection ?? "") !== nextEditorSel) patch.editorSelection = nextEditorSel;
          if (u.selectionSet && nextEditorSel && this.previewSel) {
            this.previewSel = "";
            patch.previewSelection = "";
          }
          if (Object.keys(patch).length) publish(path, patch);
        }

        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          u.transactions.some((tr) => tr.effects.some((e) => e.is(setPreviewSelectionEffect)))
        ) {
          this.decorations = previewSelectionDecorations(u.view, this.previewSel);
        }

        if (u.geometryChanged) u.view.requestMeasure(this.measureSource);
        if (!u.docChanged) {
          if (u.selectionSet) this.publishCaret();
          return;
        }
        clearTimeout(this.timer);
        this.timer = setTimeout(() => publish(path, { text: this.view.state.doc }), TEXT_DELAY);
      }

      destroy() {
        this.destroyed = true;
        clearTimeout(this.timer);
        this.unsubscribe();
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        // Flush the latest edit for a preview that outlives this view.
        publish(path, { text: this.view.state.doc });
      }
    },
    { decorations: (v) => v.decorations },
  );
}

export function registerMarkdownLiveSource(): () => void {
  return registerEditorContribution({
    id: "viewers.markdownLive",
    // The document's language: contributions are rebuilt when File Types change it.
    extensions: (ctx) => (!ctx.virtual && ctx.language === "markdown" ? [livePlugin(ctx.path)] : []),
  });
}
