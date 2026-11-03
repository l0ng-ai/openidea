/**
 * Changes of the backend's language list (plugins add and remove languages),
 * for the views that cache it: File Types, Override File Type, Code Style
 * pages, Inspections.
 */
import { create } from "zustand";

export const useLanguageListVersion = create<{ version: number }>(() => ({ version: 0 }));

/** The backend's language list changed. */
export function languageListChanged() {
  useLanguageListVersion.setState((s) => ({ version: s.version + 1 }));
}

/** Calls `cb` after each change; returns the unsubscribe function. */
export function onLanguageListChanged(cb: () => void): () => void {
  return useLanguageListVersion.subscribe((s, prev) => {
    if (s.version !== prev.version) cb();
  });
}
