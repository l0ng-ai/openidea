/**
 * Highlights other visible occurrences of the selected text (`.cm-selectionMatch`),
 * skipping selections that contain only whitespace (spaces, tabs, newlines) so
 * selecting indentation never floods the editor with match highlights.
 */
import type { Extension, Range } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { SearchCursor } from "@codemirror/search";

const MAX_SELECTION_LENGTH = 200;
const matchDeco = Decoration.mark({ class: "cm-selectionMatch" });

interface SelectionMatchOptions {
  minSelectionLength?: number;
  maxMatches?: number;
}

function matchDecorations(view: EditorView, minSelectionLength: number, maxMatches: number): DecorationSet {
  const { state } = view;
  const sel = state.selection;
  if (sel.ranges.length > 1) return Decoration.none;
  const range = sel.main;
  if (range.empty) return Decoration.none;
  const len = range.to - range.from;
  if (len < minSelectionLength || len > MAX_SELECTION_LENGTH) return Decoration.none;
  const query = state.sliceDoc(range.from, range.to);
  if (!query.trim()) return Decoration.none;

  const deco: Range<Decoration>[] = [];
  for (const part of view.visibleRanges) {
    const cursor = new SearchCursor(state.doc, query, part.from, part.to);
    while (!cursor.next().done) {
      const { from, to } = cursor.value;
      if (from >= range.to || to <= range.from) {
        deco.push(matchDeco.range(from, to));
        if (deco.length > maxMatches) return Decoration.none;
      }
    }
  }
  return Decoration.set(deco);
}

/** Highlights non-whitespace selection occurrences in visible ranges. */
export function selectionMatches(options: SelectionMatchOptions = {}): Extension {
  const minSelectionLength = options.minSelectionLength ?? 2;
  const maxMatches = options.maxMatches ?? 500;
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = matchDecorations(view, minSelectionLength, maxMatches);
      }
      update(u: ViewUpdate) {
        if (u.selectionSet || u.docChanged || u.viewportChanged) {
          this.decorations = matchDecorations(u.view, minSelectionLength, maxMatches);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
