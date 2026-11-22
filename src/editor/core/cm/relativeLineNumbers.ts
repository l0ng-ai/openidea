/**
 * Relative and hybrid line numbers (IDEA's Show line numbers › Relative / Hybrid):
 * every line shows its distance from the caret line; hybrid keeps the caret
 * line's own number instead of 0.
 */
import { Facet, type EditorState, type Extension } from "@codemirror/state";
import { GutterMarker, gutter, type ViewUpdate } from "@codemirror/view";

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

const relativeMode = Facet.define<"relative" | "hybrid", "relative" | "hybrid" | null>({
  combine: (modes) => modes[0] ?? null,
});

export function editorLineNumber(state: EditorState, line: number): string {
  const mode = state.facet(relativeMode);
  if (!mode) return String(line);
  const distance = Math.abs(line - state.doc.lineAt(state.selection.main.head).number);
  return String(mode === "hybrid" && distance === 0 ? line : distance);
}

export function relativeLineNumbers(hybrid: boolean): Extension {
  return [
    relativeMode.of(hybrid ? "hybrid" : "relative"),
    gutter({
      class: "cm-lineNumbers",
      renderEmptyElements: false,
      lineMarker(view, line) {
        return new NumberMarker(editorLineNumber(view.state, view.state.doc.lineAt(line.from).number));
      },
      lineMarkerChange: (update: ViewUpdate) =>
        update.selectionSet &&
        update.startState.doc.lineAt(update.startState.selection.main.head).number !==
          update.state.doc.lineAt(update.state.selection.main.head).number,
      initialSpacer: (view) => new NumberMarker(String(view.state.doc.lines)),
      updateSpacer: (spacer, update) => (update.docChanged ? new NumberMarker(String(update.state.doc.lines)) : spacer),
    }),
  ];
}
