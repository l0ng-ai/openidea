/**
 * The diff of the focused view's selection, for Show Diff and Show Diff in New Window (IDEA's
 * data context with `VcsDataKeys.CHANGES`).
 *
 * A view that lists changes of its own (two revisions, a shelf, a stash, a patch, a commit in the
 * log) registers its element with {@link useDiffSource}. The diff actions ask the source around
 * the focused element first, and guess a file's local changes only when there is none. So every
 * way in reaches the view's diff, whatever the keymap binds: a shortcut, a menu, Find Action.
 *
 * Views don't claim the diff actions' keystrokes themselves (`registerKeyClaim` on Show Diff's
 * bindings): such a claim misses a key the user bound to a sibling action (Show Diff in New
 * Window), and the action then diffed an unrelated file against HEAD. A test guards this.
 */
import { useEffect, type RefObject } from "react";
import type { DiffData } from "./diffInput";

export interface DiffSource {
  /**
   * The selection's diff with the view's files as its chain, for Show Diff in New Window;
   * null (or absent) when the view shows its diffs another way, then {@link show} stands in.
   */
  diff?(): DiffData | null | Promise<DiffData | null>;
  /** Show Diff the view's own way (a diff in front of a dialog, its own window); default: {@link diff} in the editor. */
  show?(): void | Promise<void>;
}

const sources = new Map<Element, DiffSource>();

/** Makes `source` the diff of `element`'s selection while the focus is inside it; returns the unregister. */
export function registerDiffSource(element: Element, source: DiffSource): () => void {
  sources.set(element, source);
  return () => {
    if (sources.get(element) === source) sources.delete(element);
  };
}

/** The source of the innermost registered view around the focused element, if any. */
export function focusedDiffSource(
  active: Element | null = typeof document === "undefined" ? null : document.activeElement,
): DiffSource | null {
  for (let el = active; el; el = el.parentElement) {
    const source = sources.get(el);
    if (source) return source;
  }
  return null;
}

/** Registers `source` (the latest render's) for the element `ref` holds; `null` registers nothing. */
export function useDiffSource(ref: RefObject<Element | null>, source: DiffSource | null) {
  useEffect(() => {
    const element = ref.current;
    if (!element || !source) return;
    return registerDiffSource(element, source);
  });
}
