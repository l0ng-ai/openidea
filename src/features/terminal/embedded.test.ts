import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmbeddedTerminal } from "./embedded";
import { installTerminalKeys } from "./keys";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { registerAction } from "@/platform/actions";
import { usePlatform } from "@/platform/platformInfo";
import type { ITerminalOptions } from "@xterm/xterm";

const terminal = vi.hoisted(() => ({
  selection: "selected run output",
  handler: (_e: KeyboardEvent): boolean => true,
  input: vi.fn(),
  options: {} as ITerminalOptions,
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    constructor(options: ITerminalOptions) {
      terminal.options = options;
    }
    textarea?: HTMLTextAreaElement;
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
    input(data: string) {
      terminal.input(data);
    }
    open(host: HTMLElement) {
      this.textarea = document.createElement("textarea");
      host.append(this.textarea);
    }
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

beforeEach(() => usePlatform.setState({ os: "windows", windowsBuildNumber: null }));
afterEach(() => usePlatform.setState({ os: "macos", windowsBuildNumber: null }));
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each([
  ["windows", 19045, { backend: "conpty", buildNumber: 19045 }],
  ["windows", 22631, { backend: "conpty", buildNumber: 22631 }],
  ["windows", null, { backend: "conpty", buildNumber: undefined }],
  ["macos", null, undefined],
  ["linux", null, undefined],
] as const)("configures embedded terminals for %s build %s", (os, windowsBuildNumber, expected) => {
  usePlatform.setState({ os, windowsBuildNumber });
  const term = createEmbeddedTerminal(document.createElement("div"), { onData() {}, onResize() {} });
  try {
    expect(terminal.options.windowsPty).toEqual(expected);
  } finally {
    term.dispose();
  }
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

it("delivers input-method commits to the owner on macOS as the terminal sessions do", () => {
  usePlatform.setState({ os: "macos" });
  const host = document.createElement("div");
  document.body.append(host);
  const onData = vi.fn();
  const term = createEmbeddedTerminal(host, { onData, onResize: vi.fn() });
  const textarea = host.querySelector("textarea")!;
  const keydown = new KeyboardEvent("keydown", { key: "1", bubbles: true });
  Object.defineProperty(keydown, "keyCode", { value: 229 });
  textarea.dispatchEvent(keydown);
  const input = new InputEvent("input", { inputType: "insertText", data: "1", bubbles: true });
  textarea.dispatchEvent(input);
  expect(onData).toHaveBeenCalledWith("1");
  term.dispose();
});

it("sends Shift+Enter in embedded Run terminals as Esc+Return", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const onData = vi.fn();
  const term = createEmbeddedTerminal(host, { onData, onResize: vi.fn() });
  try {
    const shiftEnter = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", shiftKey: true, cancelable: true });
    expect(terminal.handler(shiftEnter)).toBe(false);
    expect(shiftEnter.defaultPrevented).toBe(true);
    expect(terminal.handler(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", shiftKey: true }))).toBe(false);
    expect(terminal.input).toHaveBeenCalledExactlyOnceWith("\x1b\r");
    for (const init of [{}, { altKey: true }, { ctrlKey: true, shiftKey: true }, { shiftKey: true, isComposing: true }])
      expect(terminal.handler(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", ...init }))).toBe(true);
    expect(terminal.input).toHaveBeenCalledOnce();
  } finally {
    term.dispose();
  }
});
