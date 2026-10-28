import { editorsFor } from "@/editor/api";
import { clearLineTokens, readFileText } from "@/editor/lineTokens";

/**
 * File text for the preview pane: the live buffer of an open editor, else a
 * read-only backend read (doesn't open a document or touch recent files).
 * Shared with the result lines' syntax colours.
 */
export function loadPreviewText(path: string): Promise<string> {
  const view = editorsFor(path)[0]?.view;
  if (view) return Promise.resolve(view.state.doc.toString());
  return readFileText(path);
}

export function clearPreviewCache() {
  clearLineTokens();
}
