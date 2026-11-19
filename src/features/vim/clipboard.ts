import { Vim } from "@replit/codemirror-vim";
import { readClipboardPlainText, writeClipboardText } from "@/platform/clipboard";

/**
 * The system clipboard is the other half of Vim's clipboard registers. codemirror-vim
 * only reaches it for an explicit `"+` and reads its text back without normalizing it.
 * These hooks add IdeaVim's `clipboard` option: unnamed register writes (yank, delete,
 * change) reach the clipboard only with `set clipboard+=unnamed` (or `unnamedplus`) in
 * the rc file, as in IdeaVim; the engine's own `+` path stays untouched.
 */

/** IdeaVim's default: `ideaput` pastes through the IDE, `autoselect` copies a Visual selection. */
const CLIPBOARD_DEFAULT = "ideaput,autoselect";

/** `set clipboard+=unnamed` / `unnamedplus` opts unnamed register writes into the clipboard. */
const MIRROR_OPTIONS = new Set(["unnamed", "unnamedplus"]);

// The rc file's `set clipboard=…` lines need the option to exist before they are applied.
Vim.defineOption("clipboard", CLIPBOARD_DEFAULT, "string", ["cb"]);

/** Whether the user asked for unnamed register writes to reach the system clipboard. */
function unnamedMirrors(): boolean {
  const value = Vim.getOption("clipboard");
  return typeof value === "string" && value.split(",").some((v) => MIRROR_OPTIONS.has(v.trim()));
}

type RegisterLike = { linewise?: boolean; blockwise?: boolean; toString(): string };

type ActionArgsLike = { registerName?: string; linewise?: boolean };

export type ClipboardRegisterController = {
  pushText(
    registerName: string | null | undefined,
    operator: string,
    text: string,
    linewise?: boolean,
    blockwise?: boolean,
  ): void;
  getRegister(name?: string): RegisterLike;
};

/** How vim.js dispatches its `paste` action: a method on the actions object, not the register controller. */
type PasteActions = {
  continuePaste(cm: unknown, actionArgs: ActionArgsLike, vim: unknown, text: string, register: RegisterLike): void;
};

export type VimPasteAction = (this: PasteActions, cm: unknown, actionArgs: ActionArgsLike, vim: unknown) => void;

/** Operators that write the unnamed register; with `clipboard=unnamed` they also write the system clipboard. */
const MIRRORED_OPERATORS = new Set(["yank", "delete", "change"]);

/** Controllers whose paste path is already wrapped; reinspection is a no-op. */
const installed = new WeakSet<object>();

/** Registers the IDE copies to the system clipboard itself; `_` goes nowhere. */
function mirrorsToClipboard(registerName: string | null | undefined): boolean {
  return !registerName || registerName === '"';
}

function clipboardText(text: string, linewise: boolean | undefined): string {
  return linewise && !text.endsWith("\n") ? `${text}\n` : text;
}

function install(controller: ClipboardRegisterController): void {
  if (installed.has(controller)) return;
  installed.add(controller);

  const pushText = controller.pushText;
  controller.pushText = function (registerName, operator, text, linewise, blockwise) {
    pushText.call(this, registerName, operator, text, linewise, blockwise);
    if (!MIRRORED_OPERATORS.has(operator) || !mirrorsToClipboard(registerName) || !unnamedMirrors()) return;
    const value = clipboardText(text, linewise);
    // Vim's registers stay authoritative: a denied clipboard never fails the command.
    if (value) void writeClipboardText(value).catch(() => {});
  };
}

/**
 * vim.js's `paste` action reads `+` from the system clipboard itself and calls its own
 * `continuePaste`, so the register controller cannot normalize that text. Wrap the action.
 */
function pasteAction(): VimPasteAction {
  return function (cm, actionArgs, vim) {
    const register = _vimRegisterController()?.getRegister(actionArgs?.registerName);
    if (!register) return;
    if (actionArgs.registerName !== "+") {
      this.continuePaste(cm, actionArgs, vim, register.toString(), register);
      return;
    }
    // Read natively where the backend can: WebKitGTK's `navigator.clipboard.readText()` gives no text.
    void readClipboardPlainText().then(
      (value) => {
        // Windows clipboards deliver CRLF; Vim treats a trailing line break as linewise.
        const text = value.replace(/\r\n?/g, "\n");
        const linewise = text.endsWith("\n");
        actionArgs.linewise = linewise;
        register.linewise = linewise;
        // External text has no Vim block shape, even if the last `"+` write did.
        register.blockwise = false;
        this.continuePaste(cm, actionArgs, vim, text, register);
      },
      // A denied read (permission, insecure context) leaves the last `"+` write in the
      // register; paste that rather than dropping the command, as the yank side does.
      () => this.continuePaste(cm, actionArgs, vim, register.toString(), register),
    );
  };
}

/** `define` is `Vim.defineAction`, injectable so tests need not replace the engine's action. */
export function _installPasteActionFor(define: (name: string, fn: VimPasteAction) => void): void {
  define("paste", pasteAction());
}

/** The paste action is global to the engine; the first setup defines it. */
let pasteActionInstalled = false;

/** Adds clipboard integration to the engine; safe to call repeatedly. */
export function installClipboardHooks(): void {
  const controller = _vimRegisterController();
  if (controller) install(controller);
  if (pasteActionInstalled) return;
  pasteActionInstalled = true;
  _installPasteActionFor(Vim.defineAction as unknown as (name: string, fn: VimPasteAction) => void);
}

/** Test hook: the engine's register controller. */
export function _vimRegisterController(): ClipboardRegisterController | undefined {
  const state = (Vim.getVimGlobalState_?.() ?? undefined) as
    | { registerController?: ClipboardRegisterController }
    | undefined;
  return state?.registerController;
}

/** Test hook: installs on a controller the caller controls. */
export function _installClipboardHooksFor(controller: ClipboardRegisterController): void {
  install(controller);
}
