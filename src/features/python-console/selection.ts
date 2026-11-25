import type { EditorState } from "@codemirror/state";

/**
 * The selection, or the caret's line when nothing is selected. A selection that starts after a
 * line's indentation gets that indentation back, so its lines dedent together.
 */
export function selectionCode(state: EditorState): string {
  const sel = state.selection.main;
  if (sel.empty) return state.doc.lineAt(sel.head).text;
  const lead = state.sliceDoc(state.doc.lineAt(sel.from).from, sel.from);
  return (/^[ \t]*$/.test(lead) ? lead : "") + state.sliceDoc(sel.from, sel.to);
}
