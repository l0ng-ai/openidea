/**
 * Editing and caret keys a macro records in the editor (keys the IDE keymap
 * does not bind run CodeMirror commands directly), and their replay.
 */
import {
  cursorCharLeft,
  cursorCharRight,
  cursorDocEnd,
  cursorDocStart,
  cursorGroupLeft,
  cursorGroupRight,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  cursorPageDown,
  cursorPageUp,
  deleteCharBackward,
  deleteCharForward,
  deleteGroupBackward,
  deleteGroupForward,
  indentLess,
  insertNewlineAndIndent,
  insertTab,
  selectCharLeft,
  selectCharRight,
  selectDocEnd,
  selectDocStart,
  selectGroupLeft,
  selectGroupRight,
  selectLineBoundaryBackward,
  selectLineBoundaryForward,
  selectPageDown,
  selectPageUp,
} from "@codemirror/commands";
import type { Command } from "@codemirror/view";
import { cursorLineDown, cursorLineUp, selectLineDown, selectLineUp } from "@/editor/core/cm/verticalMotion";

/** Recorded key name (`Shift+ArrowLeft`, `Alt+Backspace`) → command. */
export const EDITOR_KEY_COMMANDS: Record<string, Command> = {
  Enter: insertNewlineAndIndent,
  Backspace: deleteCharBackward,
  Delete: deleteCharForward,
  "Alt+Backspace": deleteGroupBackward,
  "Alt+Delete": deleteGroupForward,
  Tab: insertTab,
  "Shift+Tab": indentLess,
  ArrowLeft: cursorCharLeft,
  ArrowRight: cursorCharRight,
  ArrowUp: cursorLineUp,
  ArrowDown: cursorLineDown,
  "Shift+ArrowLeft": selectCharLeft,
  "Shift+ArrowRight": selectCharRight,
  "Shift+ArrowUp": selectLineUp,
  "Shift+ArrowDown": selectLineDown,
  "Alt+ArrowLeft": cursorGroupLeft,
  "Alt+ArrowRight": cursorGroupRight,
  "Alt+Shift+ArrowLeft": selectGroupLeft,
  "Alt+Shift+ArrowRight": selectGroupRight,
  Home: cursorLineBoundaryBackward,
  End: cursorLineBoundaryForward,
  "Shift+Home": selectLineBoundaryBackward,
  "Shift+End": selectLineBoundaryForward,
  PageUp: cursorPageUp,
  PageDown: cursorPageDown,
  "Shift+PageUp": selectPageUp,
  "Shift+PageDown": selectPageDown,
  "Meta+ArrowLeft": cursorLineBoundaryBackward,
  "Meta+ArrowRight": cursorLineBoundaryForward,
  "Meta+Shift+ArrowLeft": selectLineBoundaryBackward,
  "Meta+Shift+ArrowRight": selectLineBoundaryForward,
  "Meta+ArrowUp": cursorDocStart,
  "Meta+ArrowDown": cursorDocEnd,
  "Ctrl+Home": cursorDocStart,
  "Ctrl+End": cursorDocEnd,
  "Ctrl+Shift+Home": selectDocStart,
  "Ctrl+Shift+End": selectDocEnd,
  "Ctrl+ArrowLeft": cursorGroupLeft,
  "Ctrl+ArrowRight": cursorGroupRight,
};

/** The recorded name of a key event, or null when it is not an editor key a macro records. */
export function editorKeyName(
  e: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
): string | null {
  const name = [e.metaKey && "Meta", e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.key]
    .filter(Boolean)
    .join("+");
  return name in EDITOR_KEY_COMMANDS ? name : null;
}
