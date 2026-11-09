/**
 * Auxiliary windows: Settings, comparison and deployment windows that belong
 * to a project window (their parent) and share its project. Labels name the
 * kind and the parent (`settings-main`, `comparison-project-2-3`), mirroring
 * `windows::auxiliary` in src-tauri/src/windows.rs.
 */
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { TauriEvent } from "@tauri-apps/api/event";
import { isTauri } from "./ipc";

export type AuxKind = "settings" | "comparison" | "deployment";

/** Kinds with several windows per parent (`<kind>-<parent>-<n>`); the others have one (`<kind>-<parent>`). */
const MULTIPLE: ReadonlySet<AuxKind> = new Set(["comparison"]);
const KINDS: readonly AuxKind[] = ["settings", "comparison", "deployment"];

/** An auxiliary window reports to its parent whether it closed, and which documents it released. */
export const AUX_CLOSED = "openidea://auxiliary/closed";

export interface AuxCloseResult {
  label: string;
  closed: boolean;
  documents: number[];
}

function currentLabel(): string {
  if (!isTauri()) return "";
  try {
    return getCurrentWindow().label;
  } catch {
    return "";
  }
}

/** The kind and parent of an auxiliary window, or null for a project window. */
export function auxiliaryWindow(label = currentLabel()): { kind: AuxKind; parent: string } | null {
  for (const kind of KINDS) {
    if (!label.startsWith(`${kind}-`)) continue;
    const rest = label.slice(kind.length + 1);
    const parent = MULTIPLE.has(kind) ? /^(.+)-\d+$/.exec(rest)?.[1] : rest;
    if (parent) return { kind, parent };
  }
  return null;
}

/**
 * Closes this project window's auxiliary windows that show documents, one at a time: each settles
 * its own unsaved changes first. False when one stays open (the user cancelled).
 */
export async function closeDocumentWindows(): Promise<boolean> {
  if (!isTauri()) return true;
  const parent = getCurrentWindow();
  const children = (await getAllWindows()).filter((window) => {
    const aux = auxiliaryWindow(window.label);
    return aux !== null && aux.kind !== "settings" && aux.parent === parent.label;
  });
  for (const child of children) {
    let finish!: (closed: boolean) => void;
    const result = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const offResult = await parent.listen<AuxCloseResult>(AUX_CLOSED, ({ payload }) => {
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
