/** Mouse caret gestures follow the keymap; Alt and middle-button drags select columns. */
import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, type MouseSelectionStyle } from "@codemirror/view";
import { bindingsFor, mouseStrokeOf, normalizeBinding } from "@/platform/keymap";
import { usePlatform } from "@/platform/platformInfo";
import { blockMouseSelection } from "./columnMode";

/** The selection after a caret click / drag from `anchor` to `head` on top of `start`. */
export function toggleCaret(start: EditorSelection, anchor: number, head: number): EditorSelection {
  if (anchor === head) {
    const hit = start.ranges.findIndex((r) => r.empty && r.head === head);
    if (hit >= 0 && start.ranges.length > 1) {
      const ranges = start.ranges.filter((_, i) => i !== hit);
      return EditorSelection.create(ranges, Math.min(start.mainIndex, ranges.length - 1));
    }
  }
  return start.addRange(EditorSelection.range(anchor, head));
}

export function isAddCaretGesture(event: MouseEvent): boolean {
  if (event.button !== 0) return false;
  const stroke = mouseStrokeOf(event);
  return (
    stroke !== null && bindingsFor("editor.addOrRemoveCaret").some((binding) => normalizeBinding(binding) === stroke)
  );
}

const addCaretStyle = EditorView.mouseSelectionStyle.of((view, event): MouseSelectionStyle | null => {
  if (!isAddCaretGesture(event)) return null;
  let start = view.state.selection;
  const anchor = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  return {
    get(cur) {
      const head = view.posAtCoords({ x: cur.clientX, y: cur.clientY }, false);
      return toggleCaret(start, anchor, head);
    },
    update(update) {
      if (update.docChanged) start = start.map(update.changes);
    },
  };
});

export const multiCaretMouse: Extension = [
  addCaretStyle,
  // CodeMirror's default (⌘click) would clash with ⌘click navigation.
  EditorView.clickAddsSelectionRange.of(() => false),
  blockMouseSelection((e) => {
    if (isAddCaretGesture(e) || e.shiftKey || e.metaKey || e.ctrlKey) return false;
    if (e.button === 0) return e.altKey;
    return e.button === 1 && !e.altKey && usePlatform.getState().os !== "linux";
  }),
];
