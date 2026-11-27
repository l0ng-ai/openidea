/** "Send to Agent": the editor selection or Project view files as `@` references. */
import { activeEditor, useEditorRegistry } from "@/editor/api";
import { noteCopySource } from "@/platform/clipboardSource";
import { isVirtualUri } from "@/platform/virtualDocs";
import { addReferences } from "./store";

/** The active editor's file, with the selected lines when there is a selection. */
export function sendSelection(): boolean {
  const handle = activeEditor();
  if (!handle || isVirtualUri(handle.ctx.path)) return false;
  const { state } = handle.view;
  const sel = state.selection.main;
  // A selection ending at a line start does not include that line.
  const end = sel.to > sel.from && state.doc.lineAt(sel.to).from === sel.to ? sel.to - 1 : sel.to;
  const lines = sel.empty ? undefined : { from: state.doc.lineAt(sel.from).number, to: state.doc.lineAt(end).number };
  return addReferences([{ path: handle.ctx.path, lines }]) > 0;
}

/** Files and folders (with a trailing slash) from the Project view. */
export const sendPaths = (paths: readonly string[]): boolean => addReferences(paths.map((path) => ({ path }))) > 0;

/**
 * Notes the lines an editor's copy takes (the whole line when nothing is selected), so pasting
 * them into the composer references the file's lines.
 */
export function trackEditorCopies(): () => void {
  const onCopy = (e: ClipboardEvent) => {
    const handle = [...useEditorRegistry.getState().editors].find((h) =>
      h.view.contentDOM.contains(e.target as Node | null),
    );
    if (!handle || isVirtualUri(handle.ctx.path)) return;
    const { state } = handle.view;
    const sel = state.selection.main;
    const first = state.doc.lineAt(sel.from);
    // A selection ending at a line start does not include that line.
    const last = state.doc.lineAt(sel.to > sel.from && state.doc.lineAt(sel.to).from === sel.to ? sel.to - 1 : sel.to);
    const text = sel.empty ? first.text : state.sliceDoc(sel.from, sel.to);
    noteCopySource(text, { kind: "file", path: handle.ctx.path, from: first.number, to: last.number });
  };
  document.addEventListener("copy", onCopy, true);
  return () => document.removeEventListener("copy", onCopy, true);
}
