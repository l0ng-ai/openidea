import type { EditorState } from "@codemirror/state";

/** The main selection's lines (1-based), leaving out the one a selection ends at the start of, as IDEA. */
export function selectedLines(state: EditorState): { first: number; last: number } {
  const { doc, selection } = state;
  const { from, to } = selection.main;
  const first = doc.lineAt(from).number;
  const last = Math.max(first, doc.lineAt(to).number - (to > from && doc.lineAt(to).from === to ? 1 : 0));
  return { first, last };
}

/** The selected lines as a menu group's 0-based `line` / `endLine` (absent for a single line). */
export function selectedLineContext(state: EditorState): { line: number; endLine?: number } {
  const { first, last } = selectedLines(state);
  return { line: first - 1, endLine: last > first ? last - 1 : undefined };
}
