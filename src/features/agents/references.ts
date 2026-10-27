/** "Send to Agent": the editor selection or Project view files as `@` references. */
import { activeEditor } from "@/editor/api";
import { useProject } from "@/platform/project";
import { isVirtualUri } from "@/platform/virtualDocs";
import { mentionOf } from "./composerModel";
import { addReferences } from "./store";

const relTo = (root: string, path: string) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null);

/** The active editor's file, with the selected lines when there is a selection. */
export function sendSelection(): boolean {
  const handle = activeEditor();
  const root = useProject.getState().project?.root;
  if (!handle || !root || isVirtualUri(handle.ctx.path)) return false;
  const rel = relTo(root, handle.ctx.path);
  if (!rel) return false;
  const { state } = handle.view;
  const sel = state.selection.main;
  // A selection ending at a line start does not include that line.
  const end = sel.to > sel.from && state.doc.lineAt(sel.to).from === sel.to ? sel.to - 1 : sel.to;
  const lines = sel.empty ? undefined : { from: state.doc.lineAt(sel.from).number, to: state.doc.lineAt(end).number };
  addReferences([{ path: handle.ctx.path, rel, mention: mentionOf(rel, lines) }]);
  return true;
}

/** Files and folders from the Project view. */
export function sendPaths(paths: readonly string[]): boolean {
  const root = useProject.getState().project?.root;
  if (!root) return false;
  const refs = paths.flatMap((path) => {
    const rel = relTo(root, path);
    return rel ? [{ path, rel, mention: mentionOf(rel) }] : [];
  });
  if (refs.length) addReferences(refs);
  return refs.length > 0;
}
