import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatBinding,
  installKeyboardDispatcher,
  isMouseBinding,
  isValidBinding,
  mouseStrokeOf,
  normalizeBinding,
  PRESETS,
  primaryKeyBinding,
  shortcutLabel,
  suspendKeyboardDispatch,
  useKeymap,
} from "./keymap";
import { registerAction } from "./actions";

const noMods = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

describe("mouse shortcuts", () => {
  it.each(Object.keys(PRESETS))("%s binds the side buttons to Back / Forward", (preset) => {
    expect(PRESETS[preset]!["navigate.back"]).toContain("Button4");
    expect(PRESETS[preset]!["navigate.forward"]).toContain("Button5");
  });

  it("names DOM side buttons 1-based, with modifiers", () => {
    expect(mouseStrokeOf({ ...noMods, button: 3 })).toBe("Button4");
    expect(mouseStrokeOf({ ...noMods, button: 4 })).toBe("Button5");
    expect(mouseStrokeOf({ ...noMods, button: 3, altKey: true, shiftKey: true })).toBe("Alt+Shift+Button4");
    for (const button of [0, 1, 2]) expect(mouseStrokeOf({ ...noMods, button })).toBeNull();
  });

  it("parses, normalizes and formats mouse bindings", () => {
    expect(isValidBinding("Button4")).toBe(true);
    expect(isMouseBinding("shift+button5")).toBe(true);
    expect(isMouseBinding("Meta+B")).toBe(false);
    expect(normalizeBinding("shift+button5")).toBe("Shift+Button5");
    expect(formatBinding("Button4", true)).toBe("Button4 Click");
    expect(formatBinding("Shift+Button4", true)).toBe("⇧Button4 Click");
    expect(formatBinding("Ctrl+Button5", false)).toBe("Ctrl+Button5 Click");
  });

  it("keeps mouse bindings out of menu / tooltip shortcuts", () => {
    useKeymap.setState({ preset: "intellij-windows", overrides: { "t.mouseFirst": ["Button4", "Ctrl+Alt+Q"] } });
    expect(primaryKeyBinding("t.mouseFirst")).toBe("Ctrl+Alt+Q");
    useKeymap.setState({ overrides: { "t.mouseFirst": ["Button4"] } });
    expect(shortcutLabel("t.mouseFirst")).toBeUndefined();
  });

  describe("dispatch", () => {
    let uninstall = () => {};
    const back = vi.fn();
    const forward = vi.fn();
    let editor: HTMLElement;

    beforeEach(() => {
      back.mockReset();
      forward.mockReset();
      registerAction({ id: "navigate.back", title: "Back", run: back });
      registerAction({ id: "navigate.forward", title: "Forward", run: forward });
      useKeymap.setState({ preset: "intellij-macos", overrides: {} });
      document.body.innerHTML = `<div class="cm-editor"><div class="cm-content" contenteditable="true">x</div></div><div id="tree"></div>`;
      editor = document.querySelector(".cm-content")!;
      uninstall = installKeyboardDispatcher(window);
    });
    afterEach(() => {
      uninstall();
      document.body.innerHTML = "";
    });

    const click = (target: Element, button: number, init: MouseEventInit = {}) => {
      const events = (["mousedown", "mouseup", "auxclick"] as const).map(
        (type) => new MouseEvent(type, { button, bubbles: true, cancelable: true, ...init }),
      );
      for (const e of events) target.dispatchEvent(e);
      return events;
    };

    it.each([
      ["the editor", () => editor],
      ["another component", () => document.getElementById("tree")!],
      ["the body", () => document.body],
    ])("runs Back / Forward from %s", async (_, target) => {
      click(target(), 3);
      await Promise.resolve();
      expect(back).toHaveBeenCalledOnce();
      expect(forward).not.toHaveBeenCalled();
      click(target(), 4);
      await Promise.resolve();
      expect(forward).toHaveBeenCalledOnce();
    });

    it("keeps side-button events from the target and from webview history navigation", () => {
      const reached = vi.fn();
      editor.addEventListener("mousedown", reached);
      editor.addEventListener("mouseup", reached);
      editor.addEventListener("auxclick", reached);
      const events = click(editor, 3);
      expect(reached).not.toHaveBeenCalled();
      expect(events.every((e) => e.defaultPrevented)).toBe(true);
    });

    it("leaves left, middle and right clicks alone", async () => {
      const reached = vi.fn();
      editor.addEventListener("mousedown", reached);
      for (const button of [0, 1, 2]) {
        const [down] = click(editor, button);
        expect(down!.defaultPrevented).toBe(false);
      }
      await Promise.resolve();
      expect(reached).toHaveBeenCalledTimes(3);
      expect(back).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();
    });

    it("follows keymap overrides and modifiers", async () => {
      useKeymap.setState({ overrides: { "navigate.back": ["Meta+["], "navigate.forward": ["Shift+Button4"] } });
      click(editor, 3);
      await Promise.resolve();
      expect(back).not.toHaveBeenCalled();
      click(editor, 3, { shiftKey: true });
      await Promise.resolve();
      expect(forward).toHaveBeenCalledOnce();
    });

    it("does nothing while shortcuts are being recorded", async () => {
      const resume = suspendKeyboardDispatch();
      click(editor, 3);
      resume();
      await Promise.resolve();
      expect(back).not.toHaveBeenCalled();
    });
  });
});
