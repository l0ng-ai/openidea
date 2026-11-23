import { create } from "zustand";
import { useFormFactor } from "@/platform/formFactor";

/**
 * Settings › Appearance › Compact mode, for sizes set from JS (virtualised rows,
 * icon props). CSS reads the same switch from `:root[data-compact]` (tokens.css).
 * Steps follow IDEA's Islands theme `*.compact` keys: rows −2 (Tree/List 24 → 22,
 * VCS log 26 → 24), main-toolbar and stripe icons 20 → 16. On a touch screen
 * (`platform/formFactor`) rows grow instead and compact mode is ignored; CSS reads
 * that from `:root[data-touch]`.
 */
export const useCompactMode = create<boolean>(() => false);

export function setCompactMode(on: boolean): void {
  useCompactMode.setState(on, true);
}

export function compactRowHeight(base: number, compact: boolean): number {
  return compact ? base - 2 : base;
}

/** Rows on a touch screen grow by this much (24 → 36), whatever the compact setting. */
export const TOUCH_ROW_EXTRA = 12;

export function densityRowHeight(base: number, compact: boolean, touch: boolean): number {
  return touch ? base + TOUCH_ROW_EXTRA : compactRowHeight(base, compact);
}

/** Height of a list / tree row whose regular height is `base`. */
export function useRowHeight(base = 24): number {
  return densityRowHeight(
    base,
    useCompactMode(),
    useFormFactor((s) => s.touch),
  );
}

/** Icon size for window chrome: main toolbar, run widget, tool window stripes. */
export function useChromeIconSize(base = 20): number {
  const compact = useCompactMode();
  const touch = useFormFactor((s) => s.touch);
  return compact && !touch ? base - 4 : base;
}
