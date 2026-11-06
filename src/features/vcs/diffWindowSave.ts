import { emitTo } from "@tauri-apps/api/event";
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { auxiliaryWindow } from "@/platform/auxWindow";
import { isTauri } from "@/platform/ipc";
import { tx } from "@/platform/i18n";

const SAVE = "openidea://diff/save";
const SAVED = "openidea://diff/saved";
interface SaveResult {
  id: string;
  label: string;
  error?: string;
}

/** 保存完成后再允许父窗口执行 Git 操作，避免遗漏仅在差异窗口打开的文档。 */
export async function saveDiffWindows(): Promise<void> {
  if (!isTauri()) return;
  const parent = getCurrentWindow();
  const children = (await getAllWindows()).filter(({ label }) => {
    const aux = auxiliaryWindow(label);
    return aux?.kind === "diff" && aux.parent === parent.label;
  });
  await Promise.all(
    children.map(async (child) => {
      const id = crypto.randomUUID();
      let finish!: (result: SaveResult) => void;
      const result = new Promise<SaveResult>((resolve) => (finish = resolve));
      const off = await parent.listen<SaveResult>(SAVED, ({ payload }) => {
        if (payload.id === id && payload.label === child.label) finish(payload);
      });
      const timer = setTimeout(() => finish({ id, label: child.label, error: tx("Could not save diff") }), 15000);
      try {
        await emitTo(child.label, SAVE, { id, parent: parent.label });
        const saved = await result;
        if (saved.error) throw new Error(saved.error);
      } finally {
        clearTimeout(timer);
        off();
      }
    }),
  );
}

export function installDiffWindowSave(parent: string, save: () => Promise<void>): Promise<() => void> {
  const native = getCurrentWindow();
  return native.listen<{ id: string; parent: string }>(SAVE, async ({ payload }) => {
    if (payload.parent !== parent) return;
    const result: SaveResult = { id: payload.id, label: native.label };
    try {
      await save();
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    await emitTo(parent, SAVED, result);
  });
}
