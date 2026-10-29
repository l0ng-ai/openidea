/**
 * IDEA mouse multi-caret gestures (macOS keymap): ⌥⇧click adds a caret (or
 * removes the one under the pointer), ⌥⇧drag adds a selection, ⌥drag and
 * middle-button drag make a column (rectangular) selection. Middle-button
 * drag is left alone on Linux, where a middle click pastes the primary selection.
 */
import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, type MouseSelectionStyle } from "@codemirror/view";
import { usePlatform } from "@/platform/platformInfo";
import { blockMouseSelection } from "./columnMode";

/** The selection after ⌥⇧click / drag from `anchor` to `head` on top of `start`. */
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

const addCaretStyle = EditorView.mouseSelectionStyle.of((view, event): MouseSelectionStyle | null => {
  if (event.button !== 0 || !event.altKey || !event.shiftKey || event.metaKey || event.ctrlKey) return null;
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
    if (e.shiftKey || e.metaKey || e.ctrlKey) return false;
    if (e.button === 0) return e.altKey;
    return e.button === 1 && !e.altKey && usePlatform.getState().os !== "linux";
  }),
];
