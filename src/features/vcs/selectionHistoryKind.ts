/** History for Selection tab input; kept apart from `SelectionHistory` so opening one does not load it. */
import { activeEditor } from "@/editor/api";
import { isVirtualUri } from "@/platform/virtualDocs";
import { editorService, notifications, type EditorInput } from "@/workbench/contributions";

export const SELECTION_HISTORY_KIND = "selectionHistory";

export interface SelectionHistoryData {
  path: string;
  /** 0-based first and last selected line of `text`. */
  lines: [number, number];
  /** The editor's text when the history was asked for (unsaved edits included). */
  text: string;
}

export function selectionHistoryInput(data: SelectionHistoryData): EditorInput {
  const [from, to] = data.lines;
  return { kind: SELECTION_HISTORY_KIND, key: `selectionHistory:${data.path}:${from}-${to}`, path: data.path, data };
}

/**
 * The selected lines of a text (IDEA): the caret line without a selection, and a
 * selection ending at the start of a line leaves that line out.
 */
export function selectedLines(
  doc: { lineAt(pos: number): { number: number; from: number } },
  from: number,
  to: number,
): [number, number] {
  const first = doc.lineAt(from);
  const last = doc.lineAt(to);
  const end = to > from && last.from === to && last.number > first.number ? last.number - 1 : last.number;
  return [first.number - 1, end - 1];
}

/** Git › Show History for Selection: the active editor's selected lines. */
export function showSelectionHistory() {
  const editor = activeEditor();
  if (!editor || isVirtualUri(editor.ctx.path)) {
    notifications().notify({ group: "vcs", level: "info", title: "Open a file to show the history of its selection" });
    return;
  }
  const { state } = editor.view;
  const { from, to } = state.selection.main;
  const data = { path: editor.ctx.path, lines: selectedLines(state.doc, from, to), text: state.doc.toString() };
  void editorService().openInput(selectionHistoryInput(data), { focus: true });
}
