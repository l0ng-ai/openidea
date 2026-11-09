/**
 * Live Markdown source for the preview: an editor contribution on Markdown
 * files publishes the document text (debounced while typing), the first
 * visible line of the editor (for scroll sync) and caret moves (so a Preview
 * only preview follows navigation in its hidden editor), per path.
 */
import { StateEffect, type EditorState } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { SearchCursor, getSearchQuery } from "@codemirror/search";
import { create } from "zustand";
import { registerEditorContribution } from "@/editor/api";
import { MAX_COUNT, findExcluded, findOpen, findScope } from "@/editor/core/cm/find";
import { fontZoom } from "@/editor/core/cm/prefs";
import { editorPrefs } from "@/platform/editorSettings";
import { useProject } from "@/platform/project";
import { isMarkdownPath } from "../fileKinds";

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
  text: string;
  /** 0-based first visible source line of the editor that scrolled last. */
  topLine: number;
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
      text: "",
      topLine: 0,
      scrollSeq: 0,
      fontZoom: 0,
      caretLine: 0,
      caretSeq: 0,
      previewTop: 0,
    };
    return { [path]: { ...prev, ...patch } };
  });
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

function topLineOf(view: EditorView): number {
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
  return view.state.doc.lineAt(block.from).number - 1;
}

function livePlugin(path: string) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private timer: ReturnType<typeof setTimeout> | undefined;
      private frame = 0;
      private previewSel = "";
      private unsubscribe: () => void;
      private readonly onScroll = () => {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
          this.frame = 0;
          const seq = (useLiveMarkdown.getState()[path]?.scrollSeq ?? 0) + 1;
          publish(path, { topLine: topLineOf(this.view), scrollSeq: seq });
        });
      };

      constructor(private view: EditorView) {
        const current = useLiveMarkdown.getState()[path];
        this.previewSel = current?.previewSelection ?? "";
        this.decorations = previewSelectionDecorations(view, this.previewSel);
        publish(path, {
          text: view.state.doc.toString(),
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

        if (!u.docChanged) {
          if (u.selectionSet) this.publishCaret();
          return;
        }
        clearTimeout(this.timer);
        this.timer = setTimeout(() => publish(path, { text: this.view.state.doc.toString() }), TEXT_DELAY);
      }

      destroy() {
        clearTimeout(this.timer);
        cancelAnimationFrame(this.frame);
        this.unsubscribe();
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        // Flush the latest edit for a preview that outlives this view.
        publish(path, { text: this.view.state.doc.toString() });
      }
    },
    { decorations: (v) => v.decorations },
  );
}

export function registerMarkdownLiveSource(): () => void {
  return registerEditorContribution({
    id: "viewers.markdownLive",
    extensions: (ctx) => (!ctx.virtual && isMarkdownPath(ctx.path) ? [livePlugin(ctx.path)] : []),
  });
}
