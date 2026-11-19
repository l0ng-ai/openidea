import { create } from "zustand";

/**
 * Settings › Appearance › Compact mode, for sizes set from JS (virtualised rows,
 * icon props). CSS reads the same switch from `:root[data-compact]` (tokens.css).
 * Steps follow IDEA's Islands theme `*.compact` keys: rows −2 (Tree/List 24 → 22,
 * VCS log 26 → 24), main-toolbar and stripe icons 20 → 16.
 */
export const useCompactMode = create<boolean>(() => false);

export function setCompactMode(on: boolean): void {
  useCompactMode.setState(on, true);
}

export function compactRowHeight(base: number, compact: boolean): number {
  return compact ? base - 2 : base;
}

/** Height of a list / tree row whose regular height is `base`. */
export function useRowHeight(base = 24): number {
  return compactRowHeight(base, useCompactMode());
}

/** Icon size for window chrome: main toolbar, run widget, tool window stripes. */
export function useChromeIconSize(base = 20): number {
  return useCompactMode() ? base - 4 : base;
}
