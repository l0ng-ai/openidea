import { Prec, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { inlineBackground } from "./inlineBg";

/**
 * `drawSelection` paints the selection in a layer behind the text, so any mark with its own
 * background (light-scheme warnings, find matches, usages, semantic backgrounds…) hides it.
 * This repaints selected text in the innermost span. At equal precedence the earlier source
 * nests inside, so this must precede find and semantic decorations at `Prec.highest`.
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
    "--openidea-selected-bg": "var(--editor-selection-inactive, var(--bg-editor-selection-inactive))",
    ...inlineBackground("var(--openidea-selected-bg)"),
    // Unset (the default `inherit`): the declaration drops and the syntax colours show through.
    color: "var(--fg-editor-selection)",
    WebkitTextFillColor: "var(--fg-editor-selection)",
  },
  "&.cm-focused .cm-openidea-selected": {
    "--openidea-selected-bg": "var(--editor-selection, var(--bg-editor-selection))",
  },
  // Leave the 1px frame painted by `inlineFramedModern` visible around selected text inside it.
  "@supports (height: 1lh)": {
    ":is(.cm-openidea-findMatch-current, .cm-lsp-inplace-primary) .cm-openidea-selected": {
      backgroundSize: "calc(100% - 2px) calc(min(100%, 1lh) - 2px)",
    },
  },
});

export const selectionMarks: Extension = [Prec.highest(plugin), theme];
