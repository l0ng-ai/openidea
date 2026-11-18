/**
 * The system clipboard in Vim: the `+` and `*` registers and IdeaVim's
 * `set clipboard=unnamed,unnamedplus`, which sends unnamed yanks, deletes and
 * puts through it. `+` and `*` are one register, as in Vim on macOS and
 * Windows: there is no X11 PRIMARY selection here. codemirror-vim's own `+`
 * uses `navigator.clipboard`, which WebKitGTK refuses; this uses the IDE's
 * native clipboard.
 */
import { Vim } from "@replit/codemirror-vim";
import type { ActionArgs, ActionFn, CodeMirrorV, vimState } from "@replit/codemirror-vim";
import { readClipboardPlainText, writeClipboardText } from "@/platform/clipboard";

type RegisterController = ReturnType<typeof Vim.getRegisterController>;
type Register = ReturnType<RegisterController["getRegister"]>;

/** Vim's `'clipboard'` values that make the unnamed register the clipboard. */
const UNNAMED_VALUES = ["unnamed", "unnamedplus"];
/** codemirror-vim writes `+` to `navigator.clipboard` itself, so the shared register lives under `*`. */
const CLIPBOARD = "*";

const installed = new WeakSet<RegisterController>();
let optionDefined = false;

function isUnnamedClipboard(): boolean {
  const value = Vim.getOption("clipboard");
  return typeof value === "string" && value.split(",").some((v) => UNNAMED_VALUES.includes(v));
}

function usesClipboard(registerName: string | null | undefined): boolean {
  return registerName === "+" || registerName === "*" || (!registerName && isUnnamedClipboard());
}

/** Clipboard text another app put there carries no Vim register type: it pastes characterwise. */
function charwise(text: string): Register {
  const Register = Vim.getRegisterController().unnamedRegister.constructor as new (text: string) => Register;
  return new Register(text);
}

function paste(
  this: { continuePaste(cm: CodeMirrorV, args: ActionArgs, vim: vimState, text: string, register: Register): void },
  cm: CodeMirrorV,
  args: ActionArgs,
  vim: vimState,
) {
  const controller = Vim.getRegisterController();
  if (!usesClipboard(args.registerName)) {
    const register = controller.getRegister(args.registerName ?? undefined);
    this.continuePaste(cm, args, vim, register.toString(), register);
    return;
  }
  const register = controller.getRegister(CLIPBOARD);
  void readClipboardPlainText()
    .catch(() => register.toString())
    .then((raw) => {
      const text = raw.replace(/\r\n?/g, "\n");
      this.continuePaste(cm, args, vim, text, text === register.toString() ? register : charwise(text));
    });
}

/** Defines `'clipboard'` and routes `+`, `*` and (per the option) the unnamed register to the OS clipboard. */
export function installClipboardRegisters() {
  if (!optionDefined) {
    optionDefined = true;
    Vim.defineOption("clipboard", "", "string", ["cb"]);
    Vim.defineAction("paste", paste as unknown as ActionFn);
  }
  const controller = Vim.getRegisterController();
  if (installed.has(controller)) return;
  installed.add(controller);
  // `+` and `*` are the same register object.
  if (!controller.registers[CLIPBOARD]) Vim.defineRegister(CLIPBOARD, controller.getRegister("+"));
  const push = controller.pushText.bind(controller);
  controller.pushText = (name, operator, text, linewise, blockwise) => {
    if (!usesClipboard(name)) return push(name, operator, text, linewise, blockwise);
    push(name ? CLIPBOARD : name, operator, text, linewise, blockwise);
    const register = controller.getRegister(CLIPBOARD);
    // Unnamed: `"0`/`"1`/`"-` as usual, and the clipboard as well, as Vim does.
    if (!name) register.setText(controller.unnamedRegister.toString(), linewise, blockwise);
    writeClipboardText(register.toString()).catch((e) => console.warn("vim: clipboard write failed", e));
  };
}
