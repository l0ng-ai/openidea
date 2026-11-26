import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyKeymapSettings,
  bindingsFor,
  formatBinding,
  dispatchMouseShortcut,
  installKeyboardDispatcher,
  installMouseShortcuts,
  isMouseBinding,
  isValidBinding,
  keyboardDispatchSuspended,
  mouseStrokeOf,
  normalizeBinding,
  PRESETS,
  primaryKeyBinding,
  shortcutLabel,
  suspendKeyboardDispatch,
  useKeymap,
} from "./keymap";
import { registerAction } from "./actions";
import { setContext } from "./context";
import { setLocale, useI18n } from "./i18n";

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
    for (const button of [0, 2]) expect(mouseStrokeOf({ ...noMods, button })).toBeNull();
    expect(mouseStrokeOf({ ...noMods, button: 1 })).toBe("Button2");
    expect(mouseStrokeOf({ ...noMods, button: 1, altKey: true })).toBe("Alt+Button2");
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

  it.each([
    ["en", "Middle Click"],
    ["zh", "鼠标中键"],
  ])("formats middle mouse shortcuts in %s", async (locale, label) => {
    const originalLocale = useI18n.getState().locale;
    try {
      await setLocale(locale);
      expect(formatBinding("Button2", false)).toBe(label);
      expect(formatBinding("Button2", true)).toBe(label);
      expect(formatBinding("Ctrl+Alt+Button2", false)).toBe(`Ctrl+Alt+${label}`);
      expect(formatBinding("Alt+Meta+Button2", true)).toBe(`⌥⌘${label}`);
    } finally {
      await setLocale(originalLocale);
    }
  });

  it("records modified left clicks without capturing selection and context-menu clicks", () => {
    expect(mouseStrokeOf({ ...noMods, button: 0, altKey: true, metaKey: true })).toBe("Alt+Meta+Button1");
    expect(mouseStrokeOf({ ...noMods, button: 0, shiftKey: true })).toBeNull();
    expect(mouseStrokeOf({ ...noMods, button: 2, metaKey: true })).toBeNull();
    expect(normalizeBinding("Meta+Alt+Button1")).toBe("Alt+Meta+Button1");
    expect(formatBinding("Alt+Meta+Button1", true)).toBe("⌥⌘Left Click");
    expect(formatBinding("Ctrl+Alt+Button1", false)).toBe("Ctrl+Alt+Left Click");
  });

  it("keeps mouse bindings out of menu / tooltip shortcuts", () => {
    useKeymap.setState({ preset: "intellij-windows", overrides: { "t.mouseFirst": ["Button4", "Ctrl+Alt+Q"] } });
    expect(primaryKeyBinding("t.mouseFirst")).toBe("Ctrl+Alt+Q");
    useKeymap.setState({ overrides: { "t.mouseFirst": ["Button4"] } });
    expect(shortcutLabel("t.mouseFirst")).toBeUndefined();
  });

  it.each([
    ["en", "Wheel Up", "Wheel Down"],
    ["zh", "滚轮向上", "滚轮向下"],
  ])("formats wheel directions in %s", async (locale, up, down) => {
    const originalLocale = useI18n.getState().locale;
    try {
      await setLocale(locale);
      expect(formatBinding("ctrl+wheelup", false)).toBe(`Ctrl+${up}`);
      expect(formatBinding("meta+shift+wheeldown", true)).toBe(`⇧⌘${down}`);
    } finally {
      await setLocale(originalLocale);
    }
  });

  it("loads canonical single-stroke wheel bindings from preset and custom overrides", () => {
    const original = useKeymap.getState();
    const overrides = {
      "t.wheel": ["alt+ctrl+wheelup", "Ctrl+Alt+WheelUp", "WheelDown", "Ctrl+K WheelDown", "Alt Alt+WheelUp"],
    };
    try {
      for (const id of ["intellij-windows", "user:wheel"]) {
        applyKeymapSettings(id, overrides, { "user:wheel": { parent: "intellij-windows", overrides } });
        expect(bindingsFor("t.wheel")).toEqual(["Ctrl+Alt+WheelUp", "WheelDown"]);
        expect(bindingsFor("t.wheel").every(isMouseBinding)).toBe(true);
        expect(primaryKeyBinding("t.wheel")).toBeUndefined();
      }
    } finally {
      useKeymap.setState(original);
    }
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

    const wheel = (init: WheelEventInit, at: number, ticks?: number) => {
      const event = new WheelEvent("wheel", { deltaY: -1, bubbles: true, cancelable: true, ...init });
      Object.defineProperty(event, "timeStamp", { value: at });
      if (ticks !== undefined) Object.defineProperty(event, "wheelDeltaY", { value: ticks });
      editor.dispatchEvent(event);
      return event;
    };

    it("consumes one shortcut per notch and leaves unmatched and horizontal scroll events alone", () => {
      useKeymap.setState({ overrides: { "navigate.back": ["Ctrl+WheelUp"], "navigate.forward": ["WheelDown"] } });
      const scroll = vi.fn();
      editor.addEventListener("wheel", scroll);
      expect(wheel({ ctrlKey: true, deltaMode: WheelEvent.DOM_DELTA_LINE }, 1).defaultPrevented).toBe(true);
      expect(wheel({ ctrlKey: true }, 2, 120).defaultPrevented).toBe(true);
      expect(wheel({ ctrlKey: true }, 3, 120).defaultPrevented).toBe(true);
      expect(wheel({ deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_LINE }, 4).defaultPrevented).toBe(true);
      expect(wheel({ ctrlKey: true, deltaY: 1 }, 5).defaultPrevented).toBe(false);
      expect(wheel({ ctrlKey: true, deltaY: 0, deltaX: -10 }, 6).defaultPrevented).toBe(false);
      expect(wheel({ deltaMode: WheelEvent.DOM_DELTA_LINE }, 7).defaultPrevented).toBe(false);
      expect(back).toHaveBeenCalledTimes(3);
      expect(forward).toHaveBeenCalledOnce();
      expect(scroll).toHaveBeenCalledTimes(3);
    });

    it("swallows a bound trackpad burst without repeating the action or taking over unbound momentum", () => {
      useKeymap.setState({ overrides: { "navigate.back": ["Alt+WheelUp"], "navigate.forward": ["Alt+WheelDown"] } });
      expect(wheel({ deltaY: -30 }, 0).defaultPrevented).toBe(false);
      expect(wheel({ altKey: true, deltaY: -20 }, 20).defaultPrevented).toBe(false);
      expect(back).not.toHaveBeenCalled();
      expect(wheel({ altKey: true, deltaY: -30 }, 200).defaultPrevented).toBe(true);
      expect(wheel({ altKey: true, deltaY: -20 }, 220).defaultPrevented).toBe(true);
      expect(wheel({ altKey: true, deltaY: -10 }, 240).defaultPrevented).toBe(true);
      expect(back).toHaveBeenCalledOnce();
      expect(wheel({ altKey: true, deltaY: 20 }, 260).defaultPrevented).toBe(true);
      expect(forward).toHaveBeenCalledOnce();
      expect(wheel({ altKey: true, deltaY: -30 }, 450).defaultPrevented).toBe(true);
      expect(back).toHaveBeenCalledTimes(2);
    });

    it("does not prepare the editor for a disabled mouse action", () => {
      const run = vi.fn();
      const prepare = vi.fn(() => true);
      const remove = registerAction({ id: "test.pausedMouse", title: "Evaluate", when: "debugSessionPaused", run });
      useKeymap.setState({ overrides: { "test.pausedMouse": ["Alt+Button1"] } });
      setContext("debugSessionPaused", false);
      const e = new MouseEvent("mousedown", { button: 0, altKey: true, cancelable: true });
      try {
        expect(dispatchMouseShortcut(e, prepare)).toBe(false);
        expect(prepare).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        expect(e.defaultPrevented).toBe(false);
      } finally {
        remove();
      }
    });

    it("does not consume a rectangular gesture or run its action outside the editor", () => {
      const run = vi.fn();
      const id = "editor.createRectangularSelectionOnMouseDrag";
      const remove = registerAction({ id, title: "Create Rectangular Selection on Mouse Drag", run });
      try {
        const [down] = click(document.getElementById("tree")!, 0, { altKey: true });
        expect(down!.defaultPrevented).toBe(false);
        expect(run).not.toHaveBeenCalled();
      } finally {
        remove();
      }
    });

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

    it("leaves a configured middle gesture to the editor and other components", () => {
      const run = vi.fn();
      const remove = registerAction({ id: "test.middle", title: "Middle", run });
      useKeymap.setState({ overrides: { "test.middle": ["Button2"] } });
      const reached = vi.fn();
      editor.addEventListener("mousedown", reached);
      const tree = document.getElementById("tree")!;
      tree.addEventListener("mousedown", reached);
      try {
        for (const target of [editor, tree]) {
          const [down] = click(target, 1);
          expect(down!.defaultPrevented).toBe(false);
        }
        expect(reached).toHaveBeenCalledTimes(2);
        expect(run).not.toHaveBeenCalled();
      } finally {
        remove();
      }
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

    it("dispatches a bound modified left click outside the editor, but leaves an unbound one alone", async () => {
      useKeymap.setState({ overrides: { "navigate.back": ["Alt+Meta+Button1"] } });
      const tree = document.getElementById("tree")!;
      const [unbound] = click(tree, 0, { altKey: true });
      expect(unbound!.defaultPrevented).toBe(false);
      const [bound] = click(tree, 0, { altKey: true, metaKey: true });
      expect(bound!.defaultPrevented).toBe(true);
      await Promise.resolve();
      expect(back).toHaveBeenCalledOnce();
    });

    it("defers modified left clicks inside the editor to its caret-aware handler", () => {
      useKeymap.setState({ overrides: { "navigate.back": ["Alt+Meta+Button1"] } });
      const reached = vi.fn();
      editor.addEventListener("mousedown", reached);
      const [down] = click(editor, 0, { altKey: true, metaKey: true });
      expect(down!.defaultPrevented).toBe(false);
      expect(reached).toHaveBeenCalledOnce();
      expect(back).not.toHaveBeenCalled();
    });
  });

  describe("installMouseShortcuts (windows without the workbench dispatcher)", () => {
    let uninstall = () => {};
    const back = vi.fn();
    const forward = vi.fn();
    let target: HTMLElement;

    beforeEach(() => {
      back.mockReset();
      forward.mockReset();
      registerAction({ id: "navigate.back", title: "Back", run: back });
      registerAction({ id: "navigate.forward", title: "Forward", run: forward });
      useKeymap.setState({ preset: "intellij-windows", overrides: {} });
      document.body.innerHTML = `<div id="page"><p>settings</p></div>`;
      target = document.getElementById("page")!;
      uninstall = installMouseShortcuts(window);
    });
    afterEach(() => {
      uninstall();
      document.body.innerHTML = "";
    });

    const click = (t: Element, button: number, init: MouseEventInit = {}) => {
      const events = (["mousedown", "mouseup", "auxclick"] as const).map(
        (type) => new MouseEvent(type, { button, bubbles: true, cancelable: true, ...noMods, ...init }),
      );
      for (const e of events) t.dispatchEvent(e);
      return events;
    };

    it("runs navigate.back / navigate.forward from the side buttons", async () => {
      click(target, 3);
      await Promise.resolve();
      expect(back).toHaveBeenCalledOnce();
      expect(forward).not.toHaveBeenCalled();
      click(target, 4);
      await Promise.resolve();
      expect(forward).toHaveBeenCalledOnce();
    });

    it("swallows the side-button events so the webview does not navigate history", () => {
      const reached = vi.fn();
      target.addEventListener("mousedown", reached);
      target.addEventListener("mouseup", reached);
      target.addEventListener("auxclick", reached);
      const events = click(target, 3);
      expect(events.every((e) => e.defaultPrevented)).toBe(true);
      expect(reached).not.toHaveBeenCalled();
      expect(back).toHaveBeenCalledOnce();
    });

    it("leaves left, middle and right clicks alone", () => {
      const reached = vi.fn();
      target.addEventListener("mousedown", reached);
      for (const button of [0, 1, 2]) {
        const [down] = click(target, button);
        expect(down!.defaultPrevented).toBe(false);
      }
      expect(reached).toHaveBeenCalledTimes(3);
      expect(back).not.toHaveBeenCalled();
    });

    it("follows a keymap override on a modifier + side button", async () => {
      useKeymap.setState({ overrides: { "navigate.back": ["Shift+Button4"], "navigate.forward": ["Shift+Button5"] } });
      // Without the modifier the side button is unbound now.
      click(target, 3);
      await Promise.resolve();
      expect(back).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();
      click(target, 3, { shiftKey: true });
      await Promise.resolve();
      expect(back).toHaveBeenCalledOnce();
      click(target, 4, { shiftKey: true });
      await Promise.resolve();
      expect(forward).toHaveBeenCalledOnce();
    });

    it("does nothing while shortcuts are being recorded", async () => {
      const resume = suspendKeyboardDispatch();
      expect(keyboardDispatchSuspended()).toBe(true);
      click(target, 3);
      resume();
      await Promise.resolve();
      expect(back).not.toHaveBeenCalled();
    });
  });
});
