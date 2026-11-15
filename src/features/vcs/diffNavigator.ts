/** The focused diff editor's chunk navigation, for actions that must not load the diff editor. */
import type { DiffViewerHost } from "./diffViewerProviders";

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
  /** IDEA's Select Opposite Diff Pane: focus the other side of a side-by-side diff; false when there is none. */
  focusOpposite(): boolean;
  /** IDEA's Close Diff Editor (Esc): closes the diff's editor tab; false when the diff isn't one. */
  close(): boolean;
  /** Swap Sides of a diff whose sides the user picked; false when it has none to swap. */
  swapSides(): boolean;
  /** Show Diff in External Tool; false when none is set up. */
  showInExternalTool(): boolean;
  /** The built panes, for diff viewer contributions' actions (null while loading). */
  viewer?(): DiffViewerHost | null;
}

let focused: DiffNavigator | null = null;

export function focusedDiffNavigator(): DiffNavigator | null {
  return focused;
}

export function setFocusedDiffNavigator(nav: DiffNavigator | null) {
  focused = nav;
}
