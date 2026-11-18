import { emitTo } from "@tauri-apps/api/event";
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { auxiliaryWindow } from "@/platform/auxWindow";
import { isTauri } from "@/platform/ipc";
import { tx } from "@/platform/i18n";

const SAVE = "openidea://document-window/save";
const SAVED = "openidea://document-window/saved";
interface SaveResult {
  id: string;
  label: string;
  error?: string;
}

/** Flush and save peer views before project operations. */
export async function saveDocumentWindows(options?: { skipUntitled?: boolean }): Promise<void> {
  if (!isTauri()) return;
  const caller = getCurrentWindow();
  const owner = auxiliaryWindow()?.parent ?? caller.label;
  const children = (await getAllWindows()).filter(({ label }) => {
    const aux = auxiliaryWindow(label);
    return (
      label !== caller.label &&
      (label === owner || ((aux?.kind === "diff" || aux?.kind === "editor") && aux.parent === owner))
    );
  });
  await Promise.all(
    children.map(async (child) => {
      const id = crypto.randomUUID();
      let finish!: (result: SaveResult) => void;
      const result = new Promise<SaveResult>((resolve) => (finish = resolve));
      const off = await caller.listen<SaveResult>(SAVED, ({ payload }) => {
        if (payload.id === id && payload.label === child.label) finish(payload);
      });
      const timer = setTimeout(
        () => finish({ id, label: child.label, error: tx("Could not save files in another window") }),
        15000,
      );
      try {
        await emitTo(child.label, SAVE, { id, parent: owner, replyTo: caller.label, options });
        const saved = await result;
        if (saved.error) throw new Error(saved.error);
      } finally {
        clearTimeout(timer);
        off();
      }
    }),
  );
}

export function installDocumentWindowSave(
  parent: string,
  save: (options?: { skipUntitled?: boolean }) => Promise<void>,
): Promise<() => void> {
  const native = getCurrentWindow();
  return native.listen<{
    id: string;
    parent: string;
    replyTo?: string;
    options?: { skipUntitled?: boolean };
  }>(SAVE, async ({ payload }) => {
    if (payload.parent !== parent) return;
    const replyTo = payload.replyTo ?? parent;
    if (replyTo !== parent && auxiliaryWindow(replyTo)?.parent !== parent) return;
    const result: SaveResult = { id: payload.id, label: native.label };
    try {
      await save(payload.options);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    await emitTo(replyTo, SAVED, result);
  });
}
