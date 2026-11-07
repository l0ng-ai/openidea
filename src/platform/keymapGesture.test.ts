import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchGestureStroke,
  formatBinding,
  gestureStrokeOf,
  isGestureBinding,
  isMouseBinding,
  isPointerBinding,
  isValidBinding,
  normalizeBinding,
  PRESETS,
  primaryKeyBinding,
  shortcutLabel,
  suspendKeyboardDispatch,
  useKeymap,
} from "./keymap";
import { registerAction } from "./actions";
import { setContext } from "./context";

const noMods = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

describe("trackpad swipe shortcuts", () => {
  it.each(Object.keys(PRESETS).filter((p) => p.endsWith("-macos")))(
    "%s binds a right swipe to Back and a left swipe to Forward",
    (preset) => {
      expect(PRESETS[preset]!["navigate.back"]).toContain("SwipeRight");
      expect(PRESETS[preset]!["navigate.forward"]).toContain("SwipeLeft");
    },
  );

  it.each(Object.keys(PRESETS).filter((p) => !p.endsWith("-macos")))("%s has no swipe bindings", (preset) => {
    const bound = Object.values(PRESETS[preset]!).flat();
    expect(bound.some(isGestureBinding)).toBe(false);
  });

  it("names a swipe by the direction the fingers move, with modifiers in canonical order", () => {
    expect(gestureStrokeOf({ ...noMods, direction: "right" })).toBe("SwipeRight");
    expect(gestureStrokeOf({ ...noMods, direction: "left" })).toBe("SwipeLeft");
    expect(gestureStrokeOf({ ...noMods, direction: "left", metaKey: true, altKey: true })).toBe("Alt+Meta+SwipeLeft");
    expect(gestureStrokeOf({ direction: "right", metaKey: true, ctrlKey: true, altKey: true, shiftKey: true })).toBe(
      "Ctrl+Alt+Shift+Meta+SwipeRight",
    );
  });

  it("recognises swipe bindings without mistaking them for mouse buttons or keys", () => {
    for (const b of ["SwipeLeft", "swiperight", "Alt+SwipeRight"]) {
      expect(isGestureBinding(b), b).toBe(true);
      expect(isPointerBinding(b), b).toBe(true);
      expect(isMouseBinding(b), b).toBe(false);
      expect(isValidBinding(b), b).toBe(true);
    }
    for (const b of ["Meta+B", "Button4", "SwipeUp", "Swipe", "Meta+K SwipeLeft", "SwipeLeft Meta+K"]) {
      expect(isGestureBinding(b), b).toBe(false);
    }
    expect(isPointerBinding("Button4")).toBe(true);
    expect(isPointerBinding("Meta+B")).toBe(false);
  });

  it("rejects a swipe inside a chord", () => {
    expect(isValidBinding("Meta+K SwipeLeft")).toBe(false);
    expect(isValidBinding("SwipeRight Meta+K")).toBe(false);
    expect(isValidBinding("Meta+K Meta+C")).toBe(true);
  });

  it("normalizes case and modifier order", () => {
    expect(normalizeBinding("swiperight")).toBe("SwipeRight");
    expect(normalizeBinding("SWIPELEFT")).toBe("SwipeLeft");
    expect(normalizeBinding("meta+alt+swipeleft")).toBe("Alt+Meta+SwipeLeft");
  });

  it("formats like the mouse shortcuts do on each platform", () => {
    expect(formatBinding("SwipeRight", true)).toBe("Swipe Right");
    expect(formatBinding("Alt+SwipeLeft", true)).toBe("⌥Swipe Left");
    expect(formatBinding("Alt+Meta+SwipeLeft", true)).toBe("⌥⌘Swipe Left");
    expect(formatBinding("SwipeRight", false)).toBe("Swipe Right");
    expect(formatBinding("Ctrl+Alt+SwipeLeft", false)).toBe("Ctrl+Alt+Swipe Left");
  });

  it("keeps swipes out of menu and tooltip shortcuts", () => {
    useKeymap.setState({ preset: "intellij-windows", overrides: { "t.swipeFirst": ["SwipeLeft", "Ctrl+Alt+Q"] } });
    expect(primaryKeyBinding("t.swipeFirst")).toBe("Ctrl+Alt+Q");
    useKeymap.setState({ overrides: { "t.swipeFirst": ["SwipeLeft"] } });
    expect(shortcutLabel("t.swipeFirst")).toBeUndefined();
  });

  describe("dispatch", () => {
    const back = vi.fn();
    const forward = vi.fn();
    let remove: Array<() => void> = [];

    beforeEach(() => {
      back.mockReset();
      forward.mockReset();
      remove = [
        registerAction({ id: "navigate.back", title: "Back", run: back }),
        registerAction({ id: "navigate.forward", title: "Forward", run: forward }),
      ];
      useKeymap.setState({ preset: "intellij-macos", overrides: {} });
    });
    afterEach(() => remove.forEach((r) => r()));

    it("runs Back for a right swipe and Forward for a left swipe", async () => {
      expect(dispatchGestureStroke({ ...noMods, direction: "right" })).toBe(true);
      await Promise.resolve();
      expect(back).toHaveBeenCalledOnce();
      expect(forward).not.toHaveBeenCalled();
      expect(dispatchGestureStroke({ ...noMods, direction: "left" })).toBe(true);
      await Promise.resolve();
      expect(forward).toHaveBeenCalledOnce();
    });

    it("follows the user's override instead of the preset", async () => {
      const run = vi.fn();
      remove.push(registerAction({ id: "t.swipeAction", title: "Swipe action", run }));
      useKeymap.setState({ overrides: { "t.swipeAction": ["Alt+SwipeRight"] } });
      expect(dispatchGestureStroke({ ...noMods, direction: "right", altKey: true })).toBe(true);
      await Promise.resolve();
      expect(run).toHaveBeenCalledOnce();
      expect(back).not.toHaveBeenCalled();
    });

    it("does nothing for a swipe that is not bound, or whose modifiers differ", () => {
      expect(dispatchGestureStroke({ ...noMods, direction: "right", shiftKey: true })).toBe(false);
      useKeymap.setState({ overrides: { "navigate.back": [], "navigate.forward": [] } });
      expect(dispatchGestureStroke({ ...noMods, direction: "right" })).toBe(false);
      expect(back).not.toHaveBeenCalled();
    });

    it("skips an action whose context does not allow it", () => {
      const run = vi.fn();
      remove.push(registerAction({ id: "t.pausedSwipe", title: "Evaluate", when: "debugSessionPaused", run }));
      useKeymap.setState({ overrides: { "t.pausedSwipe": ["Alt+SwipeLeft"] } });
      setContext("debugSessionPaused", false);
      expect(dispatchGestureStroke({ ...noMods, direction: "left", altKey: true })).toBe(false);
      expect(run).not.toHaveBeenCalled();
    });

    it("stays quiet while shortcuts are suspended, e.g. during recording", () => {
      const resume = suspendKeyboardDispatch();
      try {
        expect(dispatchGestureStroke({ ...noMods, direction: "right" })).toBe(false);
        expect(back).not.toHaveBeenCalled();
      } finally {
        resume();
      }
    });
  });
});
