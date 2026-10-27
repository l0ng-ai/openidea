/**
 * Shortcut conflicts between Vim and the IDE keymap (IdeaVim's Settings ›
 * Editor › Vim table). Each Vim key has a handler: `vim` hands the keystroke
 * to the editor even when an IDE action is bound to it; `ide` lets the IDE
 * keymap run first (Vim still gets the key when no IDE action is enabled).
 */
import { normalizeBinding, type KeyClaim } from "@/platform/keymap";
import type { Handler, VimSettings } from "./settings";

export interface VimKey {
  /** Canonical stroke (`Ctrl+R`). */
  stroke: string;
  /** What Vim does with it. */
  vim: string;
  /** IdeaVim's default handler. */
  handler: Handler;
}

export const VIM_KEYS: readonly VimKey[] = [
  { stroke: "Escape", vim: "Exit to Normal mode", handler: "ide" },
  { stroke: "Ctrl+[", vim: "Exit to Normal mode", handler: "vim" },
  { stroke: "Ctrl+A", vim: "Increment number", handler: "vim" },
  { stroke: "Ctrl+B", vim: "Page up", handler: "vim" },
  { stroke: "Ctrl+C", vim: "Exit to Normal mode", handler: "ide" },
  { stroke: "Ctrl+D", vim: "Scroll half page down / unindent", handler: "vim" },
  { stroke: "Ctrl+E", vim: "Scroll line down", handler: "vim" },
  { stroke: "Ctrl+F", vim: "Page down", handler: "vim" },
  { stroke: "Ctrl+I", vim: "Jump forward", handler: "vim" },
  { stroke: "Ctrl+N", vim: "Next line", handler: "ide" },
  { stroke: "Ctrl+O", vim: "Jump back / one Normal command", handler: "vim" },
  { stroke: "Ctrl+P", vim: "Previous line", handler: "ide" },
  { stroke: "Ctrl+Q", vim: "Visual block", handler: "ide" },
  { stroke: "Ctrl+R", vim: "Redo / insert register", handler: "vim" },
  { stroke: "Ctrl+T", vim: "Indent", handler: "ide" },
  { stroke: "Ctrl+U", vim: "Scroll half page up / delete to line start", handler: "vim" },
  { stroke: "Ctrl+V", vim: "Visual block", handler: "vim" },
  { stroke: "Ctrl+W", vim: "Delete word before caret", handler: "vim" },
  { stroke: "Ctrl+X", vim: "Decrement number", handler: "vim" },
  { stroke: "Ctrl+Y", vim: "Scroll line up", handler: "vim" },
];

const byStroke = new Map(VIM_KEYS.map((k) => [normalizeBinding(k.stroke), k]));

/** The handler of `stroke`, or null when Vim does not use it. */
export function handlerFor(stroke: string, handlers: VimSettings["handlers"]): Handler | null {
  const key = byStroke.get(normalizeBinding(stroke));
  if (!key) return null;
  return handlers[key.stroke] ?? key.handler;
}

export interface ConflictRow extends VimKey {
  /** IDE actions bound to the stroke (first stroke of a binding included). */
  actions: string[];
  /** Effective handler. */
  current: Handler;
}

/** The conflicts table: every Vim key with the IDE actions bound to it. */
export function conflictRows(
  bindings: ReadonlyArray<readonly [string, string]>,
  handlers: VimSettings["handlers"],
): ConflictRow[] {
  return VIM_KEYS.map((k) => {
    const stroke = normalizeBinding(k.stroke);
    const actions = [
      ...new Set(bindings.filter(([b]) => b === stroke || b.startsWith(stroke + " ")).map(([, id]) => id)),
    ];
    return { ...k, actions, current: handlers[k.stroke] ?? k.handler };
  });
}

/** Marks the `.cm-editor` of an editor with Vim on. */
export const VIM_EDITOR_ATTR = "data-openidea-vim";

function inVimEditor(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return !!el?.closest?.(`[${VIM_EDITOR_ATTR}]`);
}

/** Dispatcher claim: keystrokes whose handler is Vim go to a focused Vim editor. */
export function vimKeyClaim(settings: () => VimSettings): KeyClaim {
  return (e, stroke) => {
    const s = settings();
    return s.enabled && inVimEditor(e.target) && handlerFor(stroke, s.handlers) === "vim";
  };
}
