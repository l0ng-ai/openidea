/**
 * CodeMirror's default keymap minus the bindings that clash with IntelliJ IDEA.
 * Those keys belong to IDE actions instead (keymaps in `platform/keymaps/`):
 * ⌘/Ctrl+Enter is Split Line, Ctrl+M / ⌃L Scroll to Center, Ctrl+[ / ] code
 * block navigation, ⌥⌘↑↓ / Ctrl+Alt+↑↓ Previous / Next Occurrence.
 * Line up / down (with ⇧ too) keep the caret's visible column (`verticalMotion`).
 */
import type { Command, KeyBinding } from "@codemirror/view";
import {
  addCursorAbove,
  addCursorBelow,
  cursorLineDown as cmCursorLineDown,
  cursorLineUp as cmCursorLineUp,
  defaultKeymap,
  historyKeymap,
  indentLess,
  indentMore,
  insertBlankLine,
  redo,
  selectLine,
  selectLineDown as cmSelectLineDown,
  selectLineUp as cmSelectLineUp,
  toggleTabFocusMode,
} from "@codemirror/commands";
import { cursorLineDown, cursorLineUp, selectLineDown, selectLineUp } from "./verticalMotion";

const DROPPED = new Set<unknown>([
  insertBlankLine, // Mod-Enter
  toggleTabFocusMode, // Ctrl-m / Shift-Alt-m
  selectLine, // Alt-l / Ctrl-l
  addCursorAbove, // Mod-Alt-ArrowUp
  addCursorBelow, // Mod-Alt-ArrowDown
  indentLess, // Mod-[
  indentMore, // Mod-]
]);

const VERTICAL = new Map<Command | undefined, Command>([
  [cmCursorLineUp, cursorLineUp],
  [cmCursorLineDown, cursorLineDown],
  [cmSelectLineUp, selectLineUp],
  [cmSelectLineDown, selectLineDown],
]);

const vertical = (b: KeyBinding): KeyBinding =>
  VERTICAL.has(b.run) || VERTICAL.has(b.shift)
    ? { ...b, run: VERTICAL.get(b.run) ?? b.run, shift: VERTICAL.get(b.shift) ?? b.shift }
    : b;

export const editorBaseKeymap: readonly KeyBinding[] = [
  ...defaultKeymap.filter((b) => !DROPPED.has(b.run)).map(vertical),
  ...historyKeymap,
  // IDEA's Windows Redo is Ctrl+Shift+Z (Ctrl+Y is Delete Line); CodeMirror only binds it on macOS and Linux.
  { win: "Ctrl-Shift-z", run: redo, preventDefault: true },
];
