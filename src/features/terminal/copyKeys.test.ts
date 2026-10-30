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
});
