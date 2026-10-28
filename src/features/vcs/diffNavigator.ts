/** The focused diff editor's chunk navigation, for actions that must not load the diff editor. */

export interface DiffNavigator {
  next(): void;
  prev(): void;
  jumpToSource(): void;
  /** Apply the change at the caret from the left side to the right (`a`) or back (`b`). */
  applyChange(source: "a" | "b"): boolean;
  /** Open the next / previous file of the diff chain (changes of a commit or change list). */
  file(dir: 1 | -1): void;
  /** The viewer's settings as a popup menu (⇧⌘D). */
  showSettings(): void;
}

let focused: DiffNavigator | null = null;

export function focusedDiffNavigator(): DiffNavigator | null {
  return focused;
}

export function setFocusedDiffNavigator(nav: DiffNavigator | null) {
  focused = nav;
}
