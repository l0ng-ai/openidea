/**
 * Markdown editor layout per editor tab: Editor only / Editor and Preview / Preview only. Split
 * panes showing the same file each keep their own.
 */
import { create } from "zustand";

export type MarkdownMode = "editor" | "split" | "preview";

const DEFAULT_KEY = "openidea.markdown.defaultMode";
const MODES: readonly MarkdownMode[] = ["editor", "split", "preview"];

function storedDefault(): MarkdownMode {
  try {
    const v = localStorage.getItem(DEFAULT_KEY);
    return MODES.includes(v as MarkdownMode) ? (v as MarkdownMode) : "split";
  } catch {
    return "split";
  }
}

interface ModesState {
  byTab: Record<string, MarkdownMode>;
  /** Mode of tabs opened since: the last one chosen. */
  fallback: MarkdownMode;
}

export const useMarkdownModes = create<ModesState>(() => ({ byTab: {}, fallback: storedDefault() }));

export const modeOf = (s: ModesState, tabId: string): MarkdownMode => s.byTab[tabId] ?? s.fallback;

/** Preview Only hides the source editor of `tabId`. */
export const useMarkdownSourceHidden = (tabId: string) => useMarkdownModes((s) => modeOf(s, tabId) === "preview");

/** Fixes a shown tab's mode, so choosing one in another tab doesn't change it. */
export function pinMarkdownMode(tabId: string) {
  if (useMarkdownModes.getState().byTab[tabId]) return;
  useMarkdownModes.setState((s) => ({ byTab: { ...s.byTab, [tabId]: s.fallback } }));
}

export function setMarkdownMode(tabId: string, mode: MarkdownMode) {
  useMarkdownModes.setState((s) => ({ byTab: { ...s.byTab, [tabId]: mode }, fallback: mode }));
  try {
    localStorage.setItem(DEFAULT_KEY, mode);
  } catch {
    // Per-viewer convenience only.
  }
}
