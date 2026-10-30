import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmbeddedTerminal } from "./embedded";
import { installTerminalKeys } from "./keys";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { registerAction } from "@/platform/actions";
import { usePlatform } from "@/platform/platformInfo";

const terminal = vi.hoisted(() => ({
  selection: "selected run output",
  handler: (_e: KeyboardEvent): boolean => true,
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    hasSelection() {
      return !!terminal.selection;
    }
    getSelection() {
      return terminal.selection;
    }
    attachCustomKeyEventHandler(handler: typeof terminal.handler) {
      terminal.handler = handler;
    }
    loadAddon() {}
    open() {}
    dispose() {}
    onData() {
      return { dispose() {} };
    }
    onBinary() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    registerLinkProvider() {
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("./session", () => ({ fontFor: () => ({}), LINK_HANDLER: {}, openExternal: vi.fn(), openFileLink: vi.fn() }));
vi.mock("./theme", () => ({ readTerminalTheme: () => ({}), remeasureWhenFontsLoad: vi.fn(), MIN_CONTRAST_RATIO: 1 }));
vi.mock("./fit", () => ({
  fitScheduler: () => ({ schedule() {}, cancel() {} }),
  settledResize: () => ({ resized() {}, cancel() {} }),
}));

beforeEach(() => usePlatform.setState({ os: "windows" }));
afterEach(() => usePlatform.setState({ os: "macos" }));
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("copies embedded Run terminal selections before xterm can send Ctrl+C", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const host = document.createElement("div");
  host.className = "xterm";
  document.body.append(host);
  const term = createEmbeddedTerminal(host, { onData: vi.fn(), onResize: vi.fn() });
  const globalCopy = vi.fn();
  const disposeAction = registerAction({ id: "edit.copy", title: "Copy", run: globalCopy });
  useKeymap.setState({ preset: "intellij-windows", overrides: {} });
  const disposeKeys = installTerminalKeys();
  const disposeDispatcher = installKeyboardDispatcher();
  const shell = vi.fn();
  host.addEventListener("keydown", (event) => {
    if (terminal.handler(event)) shell();
  });
  try {
    terminal.selection = "selected run output";
    for (const modifiers of [{ ctrlKey: true }, { ctrlKey: true, shiftKey: true }, { metaKey: true }]) {
      host.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "c",
          code: "KeyC",
          bubbles: true,
          cancelable: true,
          ...modifiers,
        }),
      );
    }
    expect(writeText).toHaveBeenCalledTimes(3);
    expect(writeText).toHaveBeenCalledWith("selected run output");
    expect(shell).not.toHaveBeenCalled();
    expect(globalCopy).not.toHaveBeenCalled();
    terminal.handler(new KeyboardEvent("keyup", { key: "c", code: "KeyC", ctrlKey: true }));
    expect(writeText).toHaveBeenCalledTimes(3);
    terminal.selection = "";
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, bubbles: true }));
    expect(shell).toHaveBeenCalledOnce();
    expect(globalCopy).not.toHaveBeenCalled();
  } finally {
    disposeDispatcher();
    disposeKeys();
    disposeAction();
    term.dispose();
  }
});
