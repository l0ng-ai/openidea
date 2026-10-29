/**
 * Terminal keyboard handling that must run before the IDE keymap dispatcher
 * (IDEA's "Override IDE shortcuts"): Ctrl+letter goes to the shell (Ctrl+R
 * reverse search, Ctrl+D EOF…), plus the macOS conveniences ⌘C / ⌘V / ⌘K /
 * ⌘W, ⌘F (find) and ⌘/⌥ arrow navigation, and Ctrl+Shift+C / V (copy / paste
 * on Windows and Linux, where Ctrl+C must reach the shell).
 *
 * With "Override IDE shortcuts" on, a Ctrl or Escape stroke still reaches the IDE when the
 * keymap binds it to one of IDEA's terminal-allowed actions (Find Action, Go to
 * File…).
 *
 * Registered on `window` in the capture phase during feature activation, i.e.
 * before `installKeyboardDispatcher`, so `stopImmediatePropagation` keeps the
 * dispatcher from seeing these strokes. Until the terminal runtime has loaded
 * there is no terminal, so there is nothing to handle.
 */
import { executeAction } from "@/platform/actions";
import { effectiveBindings, letterOf, strokeOf } from "@/platform/keymap";
import { workflowSettings } from "@/platform/workflowSettings";
import { terminalRuntime } from "./loader";
import { isImeKey } from "@/platform/ime";

export type TerminalKeyResult =
  | { kind: "send"; data: string }
  | { kind: "copy" }
  | { kind: "paste" }
  | { kind: "clear" }
  | { kind: "close" }
  | { kind: "find" }
  | { kind: "clearSelection" }
  | { kind: "pass" };

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** Maps a key event in a terminal to what the terminal should do with it. */
export function terminalKeyAction(e: KeyLike, hasSelection: boolean): TerminalKeyResult {
  const { metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = e;
  if (meta && !ctrl && !alt) {
    const k = e.key.toLowerCase();
    if (k === "c" && !shift) return hasSelection ? { kind: "copy" } : { kind: "pass" };
    if (k === "v" && !shift) return { kind: "paste" };
    if (k === "k" && !shift) return { kind: "clear" };
    if (k === "w" && !shift) return { kind: "close" };
    if (k === "f" && !shift) return { kind: "find" };
    if (e.key === "ArrowLeft") return { kind: "send", data: "\x01" };
    if (e.key === "ArrowRight") return { kind: "send", data: "\x05" };
    if (e.key === "Backspace") return { kind: "send", data: "\x15" };
    return { kind: "pass" };
  }
  if (alt && !ctrl && !meta && !shift) {
    if (e.key === "ArrowLeft") return { kind: "send", data: "\x1bb" };
    if (e.key === "ArrowRight") return { kind: "send", data: "\x1bf" };
    if (e.key === "Backspace") return { kind: "send", data: "\x17" };
    return { kind: "pass" };
  }
  const letter = letterOf(e);
  if (ctrl && shift && !meta && !alt) {
    if (letter === "C") return hasSelection ? { kind: "copy" } : { kind: "pass" };
    if (letter === "V") return { kind: "paste" };
    // New Tab on Windows / Linux (IDEA keymap); plain Ctrl+T still reaches the shell.
    if (letter === "T") return { kind: "pass" };
  }
  if (ctrl && !meta && !alt) {
    // The letter the key types, so Shift doesn't change the control code and AZERTY's Ctrl+Z is ^Z, not ^W.
    if (letter) return { kind: "send", data: String.fromCharCode(letter.charCodeAt(0) - 64) };
    if (e.code === "BracketLeft") return { kind: "send", data: "\x1b" };
    if (e.code === "Backslash") return { kind: "send", data: "\x1c" };
    if (e.code === "BracketRight") return { kind: "send", data: "\x1d" };
    if (e.code === "Space") return { kind: "send", data: "\x00" };
    return { kind: "pass" };
  }
  if (!meta && !ctrl && !alt && e.key === "Escape") {
    // IDEA's Terminal.Escape: a selection is cleared first.
    return hasSelection && !shift ? { kind: "clearSelection" } : { kind: "send", data: "\x1b" };
  }
  return { kind: "pass" };
}

/**
 * Actions whose shortcuts the terminal leaves to the IDE (the same set
 * IDEA allows). Next/Previous
 * Tab are left out as on Windows/Linux, where the shell needs those keys.
 */
const ALLOWED_ACTION_IDS = new Set([
  "toolwindow.terminal",
  "toolwindow.project",
  "toolwindow.bookmarks",
  "toolwindow.find",
  "toolwindow.run",
  "toolwindow.debug",
  "toolwindow.problems",
  "toolwindow.structure",
  "toolwindow.services",
  "toolwindow.commit",
  "toolwindow.git",
  "toolwindow.hideActive",
  "toolwindow.hideAll",
  "toolwindow.maximize",
  "window.next",
  "window.previous",
  "navigate.showBookmarks",
  "find.inPath",
  "navigate.findAction",
  "navigate.gotoFile",
  "navigate.gotoClass",
  "navigate.gotoSymbol",
  "vcs.push",
  "file.settings",
  "navigate.recentFiles",
  "navigate.switcher",
  "navigate.switcherBack",
  "terminal.new",
  "terminal.find",
  "terminal.clear",
  "terminal.closeSession",
  "terminal.splitRight",
  "terminal.splitDown",
]);

/** Whether `stroke` starts a binding of an allowed action. */
export function isAllowedIdeShortcut(stroke: string, bindings: ReadonlyArray<readonly [string, string]>): boolean {
  return bindings.some(([binding, id]) => {
    if (!ALLOWED_ACTION_IDS.has(id) || (binding !== stroke && !binding.startsWith(`${stroke} `))) return false;
    // Ctrl+E stays with the shell (end of line), as in IDEA.
    return !(id === "navigate.recentFiles" && stroke === "Ctrl+E");
  });
}

export function installTerminalKeys(target: Window = window): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const rt = terminalRuntime();
    if (isImeKey(e) || !rt) return;
    // The terminal find bar: Escape closes it (instead of "focus editor"), ⌘F reselects the query.
    if ((e.target as Element | null)?.closest?.("[data-terminal-find]")) {
      const plain = !e.ctrlKey && !e.altKey && !e.shiftKey;
      if (plain && !e.metaKey && e.key === "Escape") rt.closeTerminalFind();
      else if (plain && e.metaKey && e.key.toLowerCase() === "f") rt.openTerminalFind();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const session = rt.sessionFromElement(e.target as Element | null);
    if (!session) return;
    const action = terminalKeyAction(e, session.hasSelection);
    // "Override IDE shortcuts" off: Ctrl+key and Escape reach the IDE keymap first;
    // keys it doesn't bind still get to xterm through its own key handling.
    const t = workflowSettings().terminal;
    if (action.kind === "send" && (e.ctrlKey || e.key === "Escape") && !t.overrideIdeShortcuts) return;
    if (action.kind === "send" && (e.ctrlKey || e.key === "Escape")) {
      const stroke = strokeOf(e);
      if (stroke && isAllowedIdeShortcut(stroke, effectiveBindings())) return;
    }
    // "Move focus to the Editor with Escape": the IDE keymap's Escape (Focus Editor) runs instead.
    if (action.kind === "send" && e.key === "Escape" && t.escapeToEditor) return;
    switch (action.kind) {
      case "pass":
        return;
      case "paste":
        // Let the native paste reach xterm's textarea; only keep the IDE keymap out.
        e.stopImmediatePropagation();
        return;
      case "send":
        session.send(action.data);
        break;
      case "copy":
        session.copySelection();
        break;
      case "clearSelection":
        session.clearSelection();
        break;
      case "clear":
        session.clear();
        break;
      case "close":
        void executeAction("terminal.closeSession");
        break;
      case "find":
        void executeAction("terminal.find");
        break;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  target.addEventListener("keydown", onKeyDown, true);
  return () => target.removeEventListener("keydown", onKeyDown, true);
}
