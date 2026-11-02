import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { TauriEvent } from "@tauri-apps/api/event";
import { isTauri } from "./ipc";

export const COMPARISON_CLOSED = "openidea://comparison/closed";

export interface ComparisonCloseResult {
  label: string;
  closed: boolean;
  documents: number[];
}

export function comparisonWindowParent(label = isTauri() ? getCurrentWindow().label : ""): string | null {
  return /^comparison-(.+)-\d+$/.exec(label)?.[1] ?? null;
}

/** Finish each comparison's own unsaved-changes decision before its project goes away. */
export async function closeComparisonWindows(): Promise<boolean> {
  if (!isTauri()) return true;
  const parent = getCurrentWindow();
  const children = (await getAllWindows()).filter((window) => comparisonWindowParent(window.label) === parent.label);
  for (const child of children) {
    let finish!: (closed: boolean) => void;
    const result = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const offResult = await parent.listen<ComparisonCloseResult>(COMPARISON_CLOSED, ({ payload }) => {
      if (payload.label === child.label && !payload.closed) finish(false);
    });
    const offDestroyed = await child.once(TauriEvent.WINDOW_DESTROYED, () => finish(true));
    try {
      await child.unminimize();
      await child.show();
      await child.setFocus();
      await child.close();
      if (!(await result)) return false;
    } finally {
      offResult();
      offDestroyed();
    }
  }
  return true;
}
