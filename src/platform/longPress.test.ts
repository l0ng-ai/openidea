import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLongPressContextMenu, LONG_PRESS_MS, LONG_PRESS_SLOP } from "./longPress";

function pointer(type: string, x: number, y: number, extra: { pointerType?: string; pointerId?: number } = {}) {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
  });
  Object.assign(e, {
    pointerType: extra.pointerType ?? "touch",
    pointerId: extra.pointerId ?? 1,
    isPrimary: true,
  });
  return e;
}

describe("installLongPressContextMenu", () => {
  let uninstall: () => void;
  let el: HTMLElement;
  let menus: MouseEvent[];
  let clicks: number;

  beforeEach(() => {
    vi.useFakeTimers();
    uninstall = installLongPressContextMenu({ isTrusted: () => true });
    el = document.body.appendChild(document.createElement("div"));
    menus = [];
    clicks = 0;
    el.addEventListener("contextmenu", (e) => menus.push(e));
    el.addEventListener("click", () => clicks++);
  });
  afterEach(() => {
    uninstall();
    el.remove();
    vi.useRealTimers();
  });

  const release = (x = 20, y = 30) => {
    el.dispatchEvent(pointer("pointerup", x, y));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  };

  it("opens the context menu at the press point after a still press, and swallows the release click", () => {
    el.dispatchEvent(pointer("pointerdown", 20, 30));
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(menus).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(menus).toHaveLength(1);
    expect(menus[0]).toMatchObject({ clientX: 20, clientY: 30, button: 2 });
    release();
    expect(clicks).toBe(0);
  });

  it("leaves a tap alone", () => {
    el.dispatchEvent(pointer("pointerdown", 20, 30));
    vi.advanceTimersByTime(100);
    release();
    vi.runAllTimers();
    expect(menus).toHaveLength(0);
    expect(clicks).toBe(1);
  });

  it("cancels when the finger moves (a scroll)", () => {
    el.dispatchEvent(pointer("pointerdown", 20, 30));
    el.dispatchEvent(pointer("pointermove", 20, 30 + LONG_PRESS_SLOP + 1));
    vi.runAllTimers();
    expect(menus).toHaveLength(0);
  });

  it("ignores the mouse, which has its own right click", () => {
    el.dispatchEvent(pointer("pointerdown", 20, 30, { pointerType: "mouse" }));
    vi.runAllTimers();
    expect(menus).toHaveLength(0);
  });

  it("keeps the system long press in text fields", () => {
    const input = el.appendChild(document.createElement("input"));
    input.dispatchEvent(pointer("pointerdown", 20, 30));
    vi.runAllTimers();
    expect(menus).toHaveLength(0);
  });

  it("drops its own menu when the engine fires one first (Android)", () => {
    el.dispatchEvent(pointer("pointerdown", 20, 30));
    vi.advanceTimersByTime(300);
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    vi.runAllTimers();
    expect(menus).toHaveLength(1);
    release();
    expect(clicks).toBe(1);
  });

  it("swallows the engine's menu when its own came first", () => {
    el.dispatchEvent(pointer("pointerdown", 20, 30));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    const native = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(native);
    expect(menus).toHaveLength(1);
    expect(native.defaultPrevented).toBe(true);
  });
});
