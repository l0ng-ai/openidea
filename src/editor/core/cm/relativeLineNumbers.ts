/**
 * Relative and hybrid line numbers (IDEA's Show line numbers › Relative / Hybrid):
 * every line shows its distance from the caret line; hybrid keeps the caret
 * line's own number instead of 0.
 */
import type { Extension } from "@codemirror/state";
import { EditorView, GutterMarker, gutter, type ViewUpdate } from "@codemirror/view";

class NumberMarker extends GutterMarker {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof NumberMarker && other.text === this.text;
  }
  override toDOM(): Node {
    return document.createTextNode(this.text);
  }
}

function caretLine(view: EditorView): number {
  return view.state.doc.lineAt(view.state.selection.main.head).number;
}

export function relativeLineNumbers(hybrid: boolean): Extension {
  return gutter({
    class: "cm-lineNumbers",
    renderEmptyElements: false,
    lineMarker(view, line) {
      const number = view.state.doc.lineAt(line.from).number;
      const distance = Math.abs(number - caretLine(view));
      return new NumberMarker(String(distance === 0 && hybrid ? number : distance));
    },
    lineMarkerChange: (update: ViewUpdate) =>
      update.selectionSet &&
      update.startState.doc.lineAt(update.startState.selection.main.head).number !==
        update.state.doc.lineAt(update.state.selection.main.head).number,
    initialSpacer: (view) => new NumberMarker(String(view.state.doc.lines)),
    updateSpacer: (spacer, update) => (update.docChanged ? new NumberMarker(String(update.state.doc.lines)) : spacer),
  });
}
