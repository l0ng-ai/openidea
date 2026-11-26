/**
 * Layout of a text editor with a preview (IDEA's TextEditorWithPreview): Editor Only / Editor and
 * Preview / Preview Only, per editor tab. Split panes showing the same file each keep their own;
 * tabs opened later take the layout chosen last for that kind of file.
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";

export type LayoutMode = "editor" | "split" | "preview";

const MODES: readonly LayoutMode[] = ["editor", "split", "preview"];

export interface LayoutModesState {
  byTab: Record<string, LayoutMode>;
  /** Mode of tabs opened since: the last one chosen. */
  fallback: LayoutMode;
}

export const modeOf = (s: LayoutModesState, tabId: string): LayoutMode => s.byTab[tabId] ?? s.fallback;

export interface LayoutModes {
  useModes: UseBoundStore<StoreApi<LayoutModesState>>;
  /** Preview Only hides the source editor of `tabId`. */
  useSourceHidden: (tabId: string) => boolean;
  /** Fixes a shown tab's mode, so choosing one in another tab doesn't change it. */
  pin: (tabId: string) => void;
  set: (tabId: string, mode: LayoutMode) => void;
}

/** The layouts of one kind of file, the last one chosen kept under `storageKey`. */
export function createLayoutModes(storageKey: string): LayoutModes {
  const stored = (): LayoutMode => {
    try {
      const v = localStorage.getItem(storageKey);
      return MODES.includes(v as LayoutMode) ? (v as LayoutMode) : "split";
    } catch {
      return "split";
    }
  };
  const useModes = create<LayoutModesState>(() => ({ byTab: {}, fallback: stored() }));
  return {
    useModes,
    useSourceHidden: (tabId) => useModes((s) => modeOf(s, tabId) === "preview"),
    pin: (tabId) => {
      if (useModes.getState().byTab[tabId]) return;
      useModes.setState((s) => ({ byTab: { ...s.byTab, [tabId]: s.fallback } }));
    },
    set: (tabId, mode) => {
      useModes.setState((s) => ({ byTab: { ...s.byTab, [tabId]: mode }, fallback: mode }));
      try {
        localStorage.setItem(storageKey, mode);
      } catch {
        // Per-viewer convenience only.
      }
    },
  };
}
