/** Excalidraw editor layout per file: Editor only / Editor and Preview / Preview only. */
import { create } from "zustand";

export type ExcalidrawMode = "editor" | "split" | "preview";

const DEFAULT_KEY = "openidea.excalidraw.defaultMode";
const MODES: readonly ExcalidrawMode[] = ["editor", "split", "preview"];

/** Default to visual whiteboard canvas so `.excalidraw` files open ready to view/edit. */
export const DEFAULT_EXCALIDRAW_MODE: ExcalidrawMode = "preview";

function storedDefault(): ExcalidrawMode {
  try {
    const v = localStorage.getItem(DEFAULT_KEY);
    return MODES.includes(v as ExcalidrawMode) ? (v as ExcalidrawMode) : DEFAULT_EXCALIDRAW_MODE;
  } catch {
    return DEFAULT_EXCALIDRAW_MODE;
  }
}

interface ModesState {
  byPath: Record<string, ExcalidrawMode>;
  /** Mode of files not switched yet: the last one chosen. */
  fallback: ExcalidrawMode;
}

export const useExcalidrawModes = create<ModesState>(() => ({
  byPath: {},
  fallback: storedDefault(),
}));

export const modeOf = (s: ModesState, path: string): ExcalidrawMode => s.byPath[path] ?? s.fallback;

export function setExcalidrawMode(path: string, mode: ExcalidrawMode): void {
  useExcalidrawModes.setState((s) => ({ byPath: { ...s.byPath, [path]: mode }, fallback: mode }));
  try {
    localStorage.setItem(DEFAULT_KEY, mode);
  } catch {
    // Per-viewer convenience only.
  }
}
