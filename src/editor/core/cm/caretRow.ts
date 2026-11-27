import type { Extension, Range } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";

const caretRow = Decoration.line({ class: "cm-activeLine" });

function rows(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  let last = -1;
  for (const r of view.state.selection.ranges) {
    // The caret's row stays highlighted under a selection too, as in IDEA; the row paints beneath the
    // selection layer (theme.ts), so it does not hide the selection.
    const from = view.lineBlockAt(r.head).from;
    if (from > last) out.push(caretRow.range(from));
    last = from;
  }
  return Decoration.set(out, true);
}

/** `highlightActiveLine` that marks the line of each caret (the head of each selection range). */
export const caretRowHighlight: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = rows(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet) this.decorations = rows(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
