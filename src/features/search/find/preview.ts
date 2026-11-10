import { useProject } from "@/platform/project";
import { onEditorEvent, type DocumentAttachment } from "@/editor/api";
import { clearLineTokens } from "@/editor/lineTokens";

export function clearPreviewCache() {
  clearLineTokens();
}

// Closing a preview must not discard unsaved edits when autosave is off.
const heldPreviews = new Map<string, DocumentAttachment>();

export function takePreview(path: string): DocumentAttachment | undefined {
  const held = heldPreviews.get(path);
  heldPreviews.delete(path);
  return held;
}

export function releasePreview(attachment: DocumentAttachment) {
  if (attachment.dirty()) {
    const previous = heldPreviews.get(attachment.path);
    if (previous && previous !== attachment) previous.release();
    heldPreviews.set(attachment.path, attachment);
  } else attachment.release();
}

onEditorEvent((event) => {
  if (event.type !== "docSaved" && event.type !== "docClosed") return;
  const held = heldPreviews.get(event.path);
  if (!held) return;
  heldPreviews.delete(event.path);
  held.release();
});

useProject.subscribe((state, previous) => {
  if (state.project?.root === previous.project?.root) return;
  for (const attachment of heldPreviews.values()) attachment.release();
  heldPreviews.clear();
});
