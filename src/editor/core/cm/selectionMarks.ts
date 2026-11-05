import { Prec, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

/**
 * `drawSelection` paints the selection in a layer behind the text, so any mark with its own
 * background (light-scheme warnings, find matches, usages, semantic backgrounds…) hides it.
 * This repaints selected text in the innermost span: higher-precedence marks nest closer to the
 * text, and the only other `Prec.highest` marks (LSP semantic tokens) set colour, not background.
 */
const selectedMark = Decoration.mark({ class: "cm-openidea-selected" });

function selectedRanges(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const ranges = view.state.selection.ranges.filter((r) => !r.empty);
  if (!ranges.length) return Decoration.none;
  for (const { from: vFrom, to: vTo } of view.visibleRanges)
    for (const r of ranges) {
      const from = Math.max(r.from, vFrom);
      const to = Math.min(r.to, vTo);
      if (from < to) builder.add(from, to, selectedMark);
    }
  return builder.finish();
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = selectedRanges(view);
    }
    update(u: ViewUpdate) {
      if (u.selectionSet || u.docChanged || u.viewportChanged) this.decorations = selectedRanges(u.view);
    }
  },
  { decorations: (p) => p.decorations },
);

const theme = EditorView.baseTheme({
  ".cm-openidea-selected": {
    backgroundColor: "var(--editor-selection-inactive, var(--bg-editor-selection-inactive))",
  },
  "&.cm-focused .cm-openidea-selected": {
    backgroundColor: "var(--editor-selection, var(--bg-editor-selection))",
  },
});

export const selectionMarks: Extension = [Prec.highest(plugin), theme];
