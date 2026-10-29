import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatBinding,
  installKeyboardDispatcher,
  isAltGrTyping,
  isValidBinding,
  letterOf,
  normalizeBinding,
  parseDoubleModifier,
  strokeOf,
  useKeymap,
} from "./keymap";
import { executeAction, registerAction } from "./actions";
import { usePlatform } from "./platformInfo";

describe("keymap", () => {
  it("normalizes modifier order and case", () => {
    expect(normalizeBinding("Shift+Meta+o")).toBe("Shift+Meta+O");
    expect(normalizeBinding("meta+K  meta+c")).toBe("Meta+K Meta+C");
  });

  it("formats macOS style", () => {
    expect(formatBinding("Meta+Shift+O")).toBe("⇧⌘O");
    expect(formatBinding("Alt+Enter")).toBe("⌥↵");
    expect(formatBinding("Shift Shift")).toBe("⇧⇧");
  });

  it("labels numeric-keypad operators", () => {
    expect(formatBinding("Meta+Shift+NumpadDivide", true)).toBe("⇧⌘NumPad /");
    expect(formatBinding("Ctrl+NumpadSubtract", false)).toBe("Ctrl+NumPad -");
  });

  it("names letters by the character typed, so AZERTY's Ctrl+Z is not Ctrl+W", () => {
    // AZERTY: the key typing "z" is physically KeyW.
    expect(letterOf({ code: "KeyW", key: "z", altKey: false })).toBe("Z");
    expect(letterOf({ code: "KeyF", key: "ƒ", altKey: true })).toBe("F");
    expect(letterOf({ code: "Digit1", key: "1", altKey: false })).toBeNull();
    expect(strokeOf({ code: "KeyW", key: "z", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false })).toBe(
      "Ctrl+Z",
    );
    expect(strokeOf({ code: "KeyW", key: "Z", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true })).toBe(
      "Ctrl+Shift+Z",
    );
  });

  it("uses physical key codes", () => {
    expect(strokeOf({ code: "KeyF", key: "ƒ", metaKey: false, ctrlKey: false, altKey: true, shiftKey: false })).toBe(
      "Alt+F",
    );
    expect(
      strokeOf({ code: "ShiftLeft", key: "Shift", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }),
    ).toBeNull();
  });

  describe("dispatcher", () => {
    let uninstall = () => {};
    afterEach(() => uninstall());

    it("runs bound actions and chords", async () => {
      const single = vi.fn();
      const chord = vi.fn();
      registerAction({ id: "t.single", title: "single", run: single });
      registerAction({ id: "t.chord", title: "chord", run: chord });
      useKeymap.setState({ overrides: { "t.single": ["Meta+J"], "t.chord": ["Meta+K Meta+C"] } });
      uninstall = installKeyboardDispatcher(window);
      const press = (code: string, init: KeyboardEventInit) =>
        window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, ...init }));
      press("KeyJ", { key: "j", metaKey: true });
      press("KeyK", { key: "k", metaKey: true });
      press("KeyC", { key: "c", metaKey: true });
      await Promise.resolve();
      expect(single).toHaveBeenCalledOnce();
      expect(chord).toHaveBeenCalledOnce();
    });

    it("respects when clauses", async () => {
      const run = vi.fn();
      registerAction({ id: "t.gated", title: "gated", when: "never", run });
      useKeymap.setState({ overrides: { "t.gated": ["Meta+G"] } });
      uninstall = installKeyboardDispatcher(window);
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyG", key: "g", metaKey: true }));
      await Promise.resolve();
      expect(run).not.toHaveBeenCalled();
    });

    it("applies keyWhen to shortcuts only", async () => {
      const run = vi.fn();
      registerAction({ id: "t.keyGated", title: "keyGated", keyWhen: "never", run });
      useKeymap.setState({ overrides: { "t.keyGated": ["Meta+H"] } });
      uninstall = installKeyboardDispatcher(window);
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyH", key: "h", metaKey: true }));
      await Promise.resolve();
      expect(run).not.toHaveBeenCalled();
      expect(await executeAction("t.keyGated")).toBe(true);
      expect(run).toHaveBeenCalledOnce();
    });

    it("waits 2s for a chord's second stroke and swallows a wrong one", async () => {
      vi.useFakeTimers();
      try {
        const chord = vi.fn();
        registerAction({ id: "t.chord2", title: "chord2", run: chord });
        useKeymap.setState({ overrides: { "t.chord2": ["Meta+K Meta+C"] } });
        uninstall = installKeyboardDispatcher(window);
        const press = (code: string, init: KeyboardEventInit) => {
          const e = new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true, ...init });
          window.dispatchEvent(e);
          return e;
        };
        press("KeyK", { key: "k", metaKey: true });
        vi.advanceTimersByTime(1900);
        press("KeyC", { key: "c", metaKey: true });
        await Promise.resolve();
        expect(chord).toHaveBeenCalledOnce();

        press("KeyK", { key: "k", metaKey: true });
        expect(press("KeyX", { key: "x" }).defaultPrevented).toBe(true);
        // The chord is over: the next stroke is an ordinary key again.
        expect(press("KeyC", { key: "c", metaKey: true }).defaultPrevented).toBe(false);

        press("KeyK", { key: "k", metaKey: true });
        vi.advanceTimersByTime(2001);
        press("KeyC", { key: "c", metaKey: true });
        await Promise.resolve();
        expect(chord).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("double Shift", () => {
    let uninstall = () => {};
    afterEach(() => uninstall());

    function setup() {
      const run = vi.fn();
      registerAction({ id: "t.doubleShift", title: "double shift", run });
      useKeymap.setState({ overrides: { "t.doubleShift": ["Shift Shift"] } });
      let t = 1000;
      uninstall = installKeyboardDispatcher(window, () => t);
      const at = (ms: number) => (t = ms);
      const shift = (type: "keydown" | "keyup", ms: number) => {
        at(ms);
        window.dispatchEvent(
          new KeyboardEvent(type, { key: "Shift", code: "ShiftLeft", shiftKey: type === "keydown" }),
        );
      };
      const tap = (ms: number, hold = 50) => {
        shift("keydown", ms);
        shift("keyup", ms + hold);
      };
      return { run, at, shift, tap };
    }

    it("fires on the second release when every step is within 300ms", async () => {
      const { run, tap } = setup();
      tap(1000);
      tap(1200);
      await Promise.resolve();
      expect(run).toHaveBeenCalledOnce();
    });

    it("ignores slow steps", () => {
      const { run, tap, shift } = setup();
      tap(1000);
      tap(1400);
      expect(run).not.toHaveBeenCalled();
      shift("keydown", 2000);
      shift("keyup", 2400); // held too long
      tap(2500);
      expect(run).not.toHaveBeenCalled();
    });

    it("ignores Shift tapped right after typing", () => {
      const { run, tap, at } = setup();
      at(990);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA" }));
      tap(1000);
      tap(1150);
      expect(run).not.toHaveBeenCalled();
    });

    it("is cancelled by a click or another key while Shift is held", () => {
      const { run, tap, shift } = setup();
      shift("keydown", 1000);
      window.dispatchEvent(new MouseEvent("mousedown", { shiftKey: true }));
      shift("keyup", 1100);
      tap(1200);
      expect(run).not.toHaveBeenCalled();

      shift("keydown", 3000);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", shiftKey: true }));
      shift("keyup", 3100);
      tap(3400);
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe("double modifier with a key", () => {
    let uninstall = () => {};
    afterEach(() => uninstall());

    it("parses, validates and formats the gesture", () => {
      expect(parseDoubleModifier("alt alt+up")).toEqual({ modifier: "Alt", key: "up" });
      expect(parseDoubleModifier("Ctrl Ctrl")).toEqual({ modifier: "Ctrl", key: null });
      expect(parseDoubleModifier("Alt Ctrl+Up")).toBeNull();
      expect(isValidBinding("Alt Alt+Up")).toBe(true);
      expect(normalizeBinding("alt ALT+Down")).toBe("Alt Alt+Down");
      expect(formatBinding("Alt Alt+Up", true)).toBe("⌥⌥↑");
      expect(formatBinding("Ctrl Ctrl+Up", false)).toBe("Ctrl, Ctrl+Up");
    });

    function setup() {
      const above = vi.fn();
      const anything = vi.fn();
      registerAction({ id: "t.cloneAbove", title: "clone above", run: above });
      registerAction({ id: "t.ctrlCtrl", title: "ctrl ctrl", run: anything });
      useKeymap.setState({ overrides: { "t.cloneAbove": ["Alt Alt+Up"], "t.ctrlCtrl": ["Ctrl Ctrl"] } });
      let t = 1000;
      uninstall = installKeyboardDispatcher(window, () => t);
      const mod = (type: "keydown" | "keyup", key: "Alt" | "Control", ms: number) => {
        t = ms;
        const held = type === "keydown";
        window.dispatchEvent(
          new KeyboardEvent(type, {
            key,
            code: `${key}Left`,
            altKey: key === "Alt" && held,
            ctrlKey: key === "Control" && held,
          }),
        );
      };
      const up = (ms: number) => {
        t = ms;
        const e = new KeyboardEvent("keydown", { key: "ArrowUp", code: "ArrowUp", altKey: true, cancelable: true });
        window.dispatchEvent(e);
        return e;
      };
      return { above, anything, mod, up };
    }

    it("runs while the second press is held, once per key press", async () => {
      const { above, mod, up } = setup();
      mod("keydown", "Alt", 1000);
      mod("keyup", "Alt", 1100);
      mod("keydown", "Alt", 1200);
      expect(up(1500).defaultPrevented).toBe(true);
      up(1700);
      mod("keyup", "Alt", 1800);
      await Promise.resolve();
      expect(above).toHaveBeenCalledTimes(2);
      // A single press is plain Alt+Up again.
      mod("keydown", "Alt", 3000);
      expect(up(3100).defaultPrevented).toBe(false);
    });

    it("fires a bare double tap of another modifier on its second release", async () => {
      const { anything, mod } = setup();
      mod("keydown", "Control", 1000);
      mod("keyup", "Control", 1050);
      mod("keydown", "Control", 1150);
      mod("keyup", "Control", 1200);
      await Promise.resolve();
      expect(anything).toHaveBeenCalledOnce();
    });
  });

  describe("AltGr", () => {
    let uninstall = () => {};
    afterEach(() => {
      uninstall();
      usePlatform.setState({ os: "macos" });
      document.body.innerHTML = "";
    });

    const altGr = (key: string, code: string, target: EventTarget) => {
      const e = new KeyboardEvent("keydown", {
        key,
        code,
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(e, "getModifierState", { value: (k: string) => k === "AltGraph" });
      target.dispatchEvent(e);
      return e;
    };

    it("lets AltGr characters reach text fields on Windows / Linux", async () => {
      usePlatform.setState({ os: "windows" });
      const run = vi.fn();
      registerAction({ id: "t.altGr", title: "altGr", run });
      useKeymap.setState({ overrides: { "t.altGr": ["Ctrl+Alt+0"] } });
      uninstall = installKeyboardDispatcher(window);
      const input = document.body.appendChild(document.createElement("textarea"));
      expect(altGr("}", "Digit0", input).defaultPrevented).toBe(false);
      await Promise.resolve();
      expect(run).not.toHaveBeenCalled();
      // No AltGr character on that key (or not typing): it is the shortcut.
      altGr("0", "Digit0", input);
      altGr("}", "Digit0", document.body);
      await Promise.resolve();
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("never applies on macOS, where ⌥ shortcuts type symbols", () => {
      usePlatform.setState({ os: "macos" });
      const input = document.createElement("input");
      const e = {
        key: "ƒ",
        code: "KeyF",
        target: input,
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
        getModifierState: () => true,
      };
      expect(isAltGrTyping(e)).toBe(false);
    });
  });
});
