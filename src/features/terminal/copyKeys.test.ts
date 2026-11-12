import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTerminalKeys } from "./keys";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { registerAction } from "@/platform/actions";
import { usePlatform } from "@/platform/platformInfo";

const mock = vi.hoisted(() => ({
  session: { hasSelection: true, send: vi.fn(), copySelection: vi.fn() },
  settings: { terminal: { overrideIdeShortcuts: true } },
}));
vi.mock("./loader", () => ({ terminalRuntime: () => ({ sessionFromElement: () => mock.session }) }));
vi.mock("@/platform/workflowSettings", () => ({ workflowSettings: () => mock.settings }));

beforeEach(() => usePlatform.setState({ os: "windows" }));
afterEach(() => usePlatform.setState({ os: "macos" }));
afterEach(() => vi.clearAllMocks());

describe("terminal copy capture", () => {
  it.each([true, false])("copies before xterm and IDE dispatch with override shortcuts %s", (override) => {
    mock.settings.terminal.overrideIdeShortcuts = override;
    mock.session.hasSelection = true;
    useKeymap.setState({ preset: "intellij-windows", overrides: {} });
    const globalCopy = vi.fn();
    const removeAction = registerAction({ id: "edit.copy", title: "Copy", run: globalCopy });
    const removeKeys = installTerminalKeys();
    const removeDispatcher = installKeyboardDispatcher();
    const downstream = vi.fn();
    window.addEventListener("keydown", downstream);
    try {
      for (const shiftKey of [false, true]) {
        const event = new KeyboardEvent("keydown", {
          key: "c",
          code: "KeyC",
          ctrlKey: true,
          shiftKey,
          bubbles: true,
          cancelable: true,
        });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(mock.session.copySelection).toHaveBeenCalledTimes(2);
      expect(mock.session.send).not.toHaveBeenCalled();
      expect(globalCopy).not.toHaveBeenCalled();
      expect(downstream).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", downstream);
      removeDispatcher();
      removeKeys();
      removeAction();
    }
  });

  it("sends SIGINT when there is no selection", () => {
    mock.settings.terminal.overrideIdeShortcuts = true;
    mock.session.hasSelection = false;
    const dispose = installTerminalKeys();
    try {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true }));
      expect(mock.session.send).toHaveBeenCalledWith("\x03");
      expect(mock.session.copySelection).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it.each([true, false])("sends Shift+Enter as Esc+Return with override shortcuts %s", (override) => {
    mock.settings.terminal.overrideIdeShortcuts = override;
    useKeymap.setState({ preset: "intellij-windows", overrides: {} });
    const removeKeys = installTerminalKeys();
    const removeDispatcher = installKeyboardDispatcher();
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    const xterm = vi.fn();
    textarea.addEventListener("keydown", xterm);
    const press = (init: KeyboardEventInit, keyCode?: number) => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: keyCode });
      textarea.dispatchEvent(event);
      return event;
    };
    try {
      expect(press({ shiftKey: true }).defaultPrevented).toBe(true);
      expect(mock.session.send).toHaveBeenCalledExactlyOnceWith("\x1b\r");
      expect(xterm).not.toHaveBeenCalled();
      mock.session.send.mockClear();
      // Plain Enter, other modifiers and an input method's Enter stay with xterm.
      for (const init of [
        {},
        { altKey: true },
        { ctrlKey: true, shiftKey: true },
        { shiftKey: true, isComposing: true },
      ])
        press(init);
      press({ shiftKey: true }, 229);
      expect(mock.session.send).not.toHaveBeenCalled();
      expect(xterm).toHaveBeenCalledTimes(5);
    } finally {
      textarea.remove();
      removeDispatcher();
      removeKeys();
    }
  });
});

it.each([
  ["Ctrl+C", "c", "KeyC", true],
  ["Ctrl+R", "r", "KeyR", false],
  ["Shift+Enter", "Enter", "Enter", false],
] as const)("keeps terminal handling for %s even when bound to font zoom", (stroke, key, code, selection) => {
  mock.settings.terminal.overrideIdeShortcuts = true;
  mock.session.hasSelection = selection;
  useKeymap.setState({ preset: "intellij-windows", overrides: { "editor.increaseFontSize": [stroke] } });
  const zoom = vi.fn();
  const removeAction = registerAction({ id: "editor.increaseFontSize", title: "Increase Font Size", run: zoom });
  const removeKeys = installTerminalKeys();
  const removeDispatcher = installKeyboardDispatcher();
  try {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        code,
        ctrlKey: stroke.startsWith("Ctrl"),
        shiftKey: stroke.startsWith("Shift"),
        cancelable: true,
      }),
    );
    expect(zoom).not.toHaveBeenCalled();
    if (selection) expect(mock.session.copySelection).toHaveBeenCalledOnce();
    else expect(mock.session.send).toHaveBeenCalledWith(key === "r" ? "\x12" : "\x1b\r");
  } finally {
    removeDispatcher();
    removeKeys();
    removeAction();
    useKeymap.setState({ overrides: {} });
  }
});
