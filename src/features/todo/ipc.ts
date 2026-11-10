import { editorsFor } from "@/editor/api";
import { call, commands } from "@/platform/ipc";
import type { RequestId } from "@/platform/ipc";
import { heldAttachment } from "./PreviewEditor";

export { call, commands, isTauri, nextRequestId, onIdeEvent } from "@/platform/ipc";

export function cancelRequestSafe(id: RequestId) {
  try {
    void commands.cancelRequest(id).catch(() => {});
  } catch {
    // not running under Tauri
  }
}

/**
 * File text for the preview pane: the open buffer, else the file on disk.
 * Held dirty attachments first — a buffer edited in the preview then unmounted
 * is no longer in `editorsFor`, but its edits must still show (see PreviewEditor).
 */
export function previewText(path: string): Promise<string> {
  const held = heldAttachment(path);
  if (held) return Promise.resolve(held.text());
  const view = editorsFor(path)[0]?.view;
  return view ? Promise.resolve(view.state.doc.toString()) : call(commands.fsReadText(path));
}
