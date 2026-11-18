import { beforeEach, describe, expect, it, vi } from "vitest";
import { Vim } from "@replit/codemirror-vim";
import {
  _installClipboardHooksFor,
  _installPasteActionFor,
  installClipboardHooks,
  type ClipboardRegisterController,
  type VimPasteAction,
} from "../clipboard";

const clipboard = vi.hoisted(() => ({ write: vi.fn<(text: string) => Promise<void>>() }));

vi.mock("@/platform/clipboard", () => ({
  writeClipboardText: (text: string) => clipboard.write(text),
  // Outside the desktop app the platform helper reads through the WebView.
  readClipboardPlainText: () => navigator.clipboard.readText(),
}));

function fakeController(pasted = "unused") {
  const pushes: unknown[][] = [];
  const register = { linewise: true, blockwise: false, toString: () => pasted };
  const controller: ClipboardRegisterController = {
    pushText: (...args) => void pushes.push(args),
    getRegister: () => register,
  };
  return { controller, pushes, register };
}

/** Runs the action `_installPasteActionFor` defines, against a fake actions object and controller. */
function pasteHarness(controller: ClipboardRegisterController) {
  let action: VimPasteAction | undefined;
  _installPasteActionFor((name, fn) => {
    expect(name).toBe("paste");
    action = fn;
  });
  const pastes: unknown[][] = [];
  const context = { continuePaste: (...args: unknown[]) => void pastes.push(args) };
  const state = vi.spyOn(Vim, "getVimGlobalState_").mockReturnValue({ registerController: controller } as never);
  return {
    run(actionArgs: Record<string, unknown> = { registerName: "+" }) {
      action!.call(context as never, {}, actionArgs, {});
    },
    pastes,
    restore: () => state.mockRestore(),
  };
}

/** A promise rejection is reported to the caller, not to the process. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Vim clipboard hooks", () => {
  beforeEach(() => {
    clipboard.write.mockReset();
    clipboard.write.mockResolvedValue(undefined);
    Vim.setOption("clipboard", "ideaput,autoselect");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn(async () => ""), writeText: vi.fn(async () => {}) },
    });
  });

  it("installs once per controller", () => {
    const { controller, pushes } = fakeController();
    _installClipboardHooksFor(controller);
    _installClipboardHooksFor(controller);
    controller.pushText(null, "yank", "one", false);
    expect(pushes).toHaveLength(1);
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it("is a no-op without a register controller", () => {
    const state = vi.spyOn(Vim, "getVimGlobalState_").mockReturnValue({} as never);
    const define = vi.spyOn(Vim, "defineAction").mockImplementation(() => {});
    try {
      expect(() => installClipboardHooks()).not.toThrow();
      expect(define).toHaveBeenCalledWith("paste", expect.any(Function));
    } finally {
      state.mockRestore();
      define.mockRestore();
    }
  });

  it("keeps the system clipboard out of unnamed register writes by default", () => {
    const { controller, pushes } = fakeController();
    _installClipboardHooksFor(controller);
    controller.pushText(null, "yank", "one\n", true);
    controller.pushText(null, "delete", "two\n", true);
    expect(pushes).toHaveLength(2);
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it.each([
    ["yank", null, "one\n", true, "one\n"],
    ["delete", null, "abc", false, "abc"],
    ["change", undefined, "x", false, "x"],
    ["yank", '"', "alpha", false, "alpha"],
    ["yank", null, "line", true, "line\n"],
  ])(
    "mirrors %s into the system clipboard with clipboard=unnamed",
    (operator, registerName, text, linewise, expected) => {
      Vim.setOption("clipboard", "ideaput,autoselect,unnamed");
      const { controller } = fakeController();
      _installClipboardHooksFor(controller);
      controller.pushText(registerName, operator, text, linewise);
      expect(clipboard.write).toHaveBeenCalledWith(expected);
    },
  );

  it("mirrors with clipboard=unnamedplus too", () => {
    Vim.setOption("clipboard", "unnamedplus");
    const { controller } = fakeController();
    _installClipboardHooksFor(controller);
    controller.pushText(null, "yank", "one\n", true);
    expect(clipboard.write).toHaveBeenCalledWith("one\n");
  });

  it.each([["a"], ["0"], ["_"], ["+"]])("leaves explicit register %s out of the system clipboard", (registerName) => {
    Vim.setOption("clipboard", "ideaput,autoselect,unnamed");
    const { controller } = fakeController();
    _installClipboardHooksFor(controller);
    controller.pushText(registerName, "yank", "one\n", true);
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it("does not write empty text", () => {
    Vim.setOption("clipboard", "ideaput,autoselect,unnamed");
    const { controller } = fakeController();
    _installClipboardHooksFor(controller);
    controller.pushText(null, "delete", "", false);
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it("keeps Vim state when the clipboard rejects and keeps trying", async () => {
    Vim.setOption("clipboard", "ideaput,autoselect,unnamed");
    clipboard.write.mockRejectedValueOnce(new Error("denied"));
    const { controller, pushes } = fakeController();
    _installClipboardHooksFor(controller);
    controller.pushText(null, "yank", "one", false);
    await settle();
    expect(pushes).toHaveLength(1);
    controller.pushText(null, "yank", "two", false);
    await settle();
    expect(clipboard.write).toHaveBeenCalledTimes(2);
  });

  it("normalizes clipboard text and derives the paste shape for the + register", async () => {
    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue("hello\r\n");
    const { controller, register } = fakeController();
    register.linewise = false;
    register.blockwise = true;
    const harness = pasteHarness(controller);
    try {
      harness.run();
      await settle();
      const [_cm, actionArgs, _vim, text, passedRegister] = harness.pastes[0]!;
      expect(text).toBe("hello\n");
      expect(actionArgs).toEqual({ registerName: "+", linewise: true });
      expect(passedRegister).toBe(register);
      expect(register).toEqual({ linewise: true, blockwise: false, toString: expect.any(Function) });
      expect(JSON.stringify(text)).not.toContain("\\r");
    } finally {
      harness.restore();
    }
  });

  it("pastes clipboard text without a trailing line break character-wise", async () => {
    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue("hello");
    const { controller, register } = fakeController();
    const harness = pasteHarness(controller);
    try {
      harness.run();
      await settle();
      expect(harness.pastes[0]![3]).toBe("hello");
      expect((harness.pastes[0]![1] as { linewise?: boolean }).linewise).toBe(false);
      expect(register.linewise).toBe(false);
    } finally {
      harness.restore();
    }
  });

  it("falls back to the register text when the clipboard read is denied", async () => {
    vi.spyOn(navigator.clipboard, "readText").mockRejectedValue(new Error("denied"));
    const { controller, register } = fakeController("stale\n");
    const harness = pasteHarness(controller);
    try {
      harness.run();
      await settle();
      expect(harness.pastes).toHaveLength(1);
      const [_cm, _actionArgs, _vim, text, passedRegister] = harness.pastes[0]!;
      expect(text).toBe("stale\n");
      expect(passedRegister).toBe(register);
    } finally {
      harness.restore();
    }
  });

  it("leaves internal register pastes alone", () => {
    const { controller } = fakeController("a\r\nb");
    const harness = pasteHarness(controller);
    try {
      harness.run({ registerName: "0" });
      expect(harness.pastes[0]![3]).toBe("a\r\nb");
    } finally {
      harness.restore();
    }
  });
});
