/** Action-backed context menus and drop-downs of the merge editor. */
import type { EditorView } from "@codemirror/view";
import { showContextMenu, type MenuItem } from "@/ui";
import type { MergeSide } from "./mergeModel";

export type MenuPosition = { clientX: number; clientY: number };

function selectUnderPointer(view: EditorView, e: React.MouseEvent) {
  const at = view.posAtCoords({ x: e.clientX, y: e.clientY });
  const picked = view.state.selection.main;
  if (at !== null && (at < picked.from || at > picked.to)) view.dispatch({ selection: { anchor: at } });
  view.focus();
}

export function showResultMenu(e: React.MouseEvent, view: EditorView) {
  e.preventDefault();
  selectUnderPointer(view, e);
  showContextMenu(e.nativeEvent, [
    { kind: "action", action: "merge.resolveAutomatically" },
    { kind: "action", action: "merge.ignore" },
    { kind: "separator" },
    { kind: "action", action: "merge.cut" },
    { kind: "action", action: "merge.copy" },
    { kind: "action", action: "merge.paste" },
    { kind: "action", action: "merge.selectAll" },
  ]);
}

export function showSideMenu(e: React.MouseEvent, view: EditorView, which: MergeSide) {
  e.preventDefault();
  selectUnderPointer(view, e);
  showContextMenu(e.nativeEvent, [
    { kind: "action", action: "merge.accept" },
    { kind: "action", action: which === "left" ? "merge.resolveUsingYours" : "merge.resolveUsingTheirs" },
    { kind: "action", action: "merge.ignore" },
    { kind: "separator" },
    { kind: "action", action: "merge.annotate" },
  ]);
}

export const COMPARISONS = {
  compareYoursResult: ["yours", "result"],
  compareResultTheirs: ["result", "theirs"],
  compareYoursTheirs: ["yours", "theirs"],
  compareBaseYours: ["base", "yours"],
  compareBaseResult: ["base", "result"],
  compareBaseTheirs: ["base", "theirs"],
} as const;

export function showCompareMenu(at: MenuPosition) {
  const items: MenuItem[] = Object.keys(COMPARISONS).map((command) => ({
    kind: "action",
    action: `merge.${command}`,
  }));
  items.splice(3, 0, { kind: "separator" });
  showContextMenu(at, items);
}

export function showSettingsMenu(at: MenuPosition) {
  showContextMenu(at, [{ kind: "action", action: "merge.autoApply" }]);
}
