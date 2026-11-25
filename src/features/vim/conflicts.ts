/**
 * Shortcut conflicts between Vim and the IDE keymap (IdeaVim's Settings ›
 * Editor › Vim table). Each Vim key has a handler: `vim` hands the keystroke
 * to the editor even when an IDE action is bound to it; `ide` lets the IDE
 * keymap run first (Vim still gets the key when no IDE action is enabled).
 * A key the user moves from `vim` to `ide` is never Vim's, as with IdeaVim:
 * without an IDE action it does what the editor does with it (`movedToIde`).
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
  { stroke: "Ctrl+C", vim: "Exit to Normal mode; copy a Visual selection", handler: "ide" },
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
  { stroke: "Ctrl+V", vim: "Visual block; paste in Insert mode", handler: "vim" },
  { stroke: "Ctrl+W", vim: "Delete word before caret", handler: "vim" },
  { stroke: "Ctrl+X", vim: "Decrement number", handler: "vim" },
  { stroke: "Ctrl+Y", vim: "Scroll line up", handler: "vim" },
];

const byStroke = new Map(VIM_KEYS.map((k) => [normalizeBinding(k.stroke), k]));

/**
 * IdeaVim hands these strokes to the IDE in one Vim mode only: an editing mode pastes,
 * Visual mode copies. Every other mode keeps the stroke's Vim meaning, so Ctrl+V still
 * starts a Visual block in Normal mode.
 */
const MODE_ACTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "Ctrl+V": { insert: "edit.paste" },
  "Shift+Insert": { insert: "edit.paste" },
  "Ctrl+C": { visual: "edit.copy" },
};

/** The IDE action that replaces Vim's meaning of `stroke` in `mode`, if the mode changes it. */
export function modeAction(stroke: string, mode: string | null | undefined): string | null {
  if (!mode) return null;
  return MODE_ACTIONS[normalizeBinding(stroke)]?.[mode] ?? null;
}

/** The handler the mode gives `stroke`, or null when the stroke's normal handler still applies. */
export function modeHandler(stroke: string, mode: string | null | undefined): Handler | null {
  return modeAction(stroke, mode) ? "ide" : null;
}

/** The handler of `stroke`, or null when Vim does not use it. */
export function handlerFor(stroke: string, handlers: VimSettings["handlers"], mode?: string | null): Handler | null {
  const key = byStroke.get(normalizeBinding(stroke));
  if (!key) return null;
  return handlers[key.stroke] ?? modeHandler(stroke, mode) ?? key.handler;
}

/**
 * Whether the mode, rather than the user's per-stroke setting, gives `stroke` to the IDE.
 * Unlike `movedToIde`, this covers keys Vim owns by default (Ctrl+V), and a user override
 * takes precedence over the mode default, as `sethandler` would.
 */
export function modeMovedToIde(
  stroke: string,
  handlers: VimSettings["handlers"],
  mode: string | null | undefined,
): boolean {
  const key = byStroke.get(normalizeBinding(stroke));
  const name = key?.stroke ?? normalizeBinding(stroke);
  return !(name in handlers) && modeHandler(stroke, mode) === "ide";
}

/**
 * Whether the user moved `stroke` from Vim to the IDE. Vim then leaves it alone even when no
 * IDE action takes it: in the editor, `Ctrl+A` selects all and `Ctrl+X` / `Ctrl+V` cut and paste
 * (IdeaVim's `$SelectAll`, `$Cut`, `$Paste`). Keys that are the IDE's by default still reach Vim
 * when no IDE action wants them, so Escape leaves Insert mode.
 */
export function movedToIde(stroke: string, handlers: VimSettings["handlers"]): boolean {
  const key = byStroke.get(normalizeBinding(stroke));
  return key?.handler === "vim" && handlers[key.stroke] === "ide";
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

/** The editor's current Vim mode, mirrored by `modeTracker` so claims stay synchronous. */
export const VIM_MODE_ATTR = "data-vim-mode";

function inVimEditor(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return !!el?.closest?.(`[${VIM_EDITOR_ATTR}]`);
}

/** The Vim mode of the editor `target` is in, or null when it is not a Vim editor (yet). */
export function vimModeOf(target: EventTarget | null): string | null {
  const el = target as Element | null;
  return el?.closest?.(`[${VIM_EDITOR_ATTR}]`)?.getAttribute(VIM_MODE_ATTR) ?? null;
}

/**
 * Dispatcher claim: keystrokes whose handler is Vim go to a focused Vim editor. A stroke the
 * mode gives to the IDE is claimed too: the editor runs that IDE action itself, so an unrelated
 * keymap binding on the same stroke (VCS Operations on macOS's Ctrl+V) cannot run instead.
 */
export function vimKeyClaim(settings: () => VimSettings): KeyClaim {
  return (e, stroke) => {
    const s = settings();
    const mode = vimModeOf(e.target);
    return (
      s.enabled &&
      inVimEditor(e.target) &&
      (handlerFor(stroke, s.handlers, mode) === "vim" || modeMovedToIde(stroke, s.handlers, mode))
    );
  };
}
