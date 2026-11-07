import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAction } from "./actions";
import { setContext } from "./context";
import {
  installKeyboardDispatcher,
  normalizeBinding,
  primaryKeyBinding,
  suspendKeyboardDispatch,
  useKeymap,
} from "./keymap";
import { installPageSwipeTracking, ownsHorizontalScroll, PAGE_SWIPE_EVENT } from "./pageSwipe";

const emitTo = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "project-2", emitTo }) }));

describe("native page swipes", () => {
  const back = vi.fn();
  const forward = vi.fn();
  let dispose: (() => void)[];
  beforeEach(() => {
    back.mockReset();
    forward.mockReset();
    useKeymap.setState({ preset: "intellij-macos", overrides: {} });
    dispose = [
      registerAction({ id: "navigate.back", title: "Back", run: back }),
      registerAction({ id: "navigate.forward", title: "Forward", run: forward }),
      installKeyboardDispatcher(window),
    ];
  });
  afterEach(() => {
    dispose.reverse().forEach((fn) => fn());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    emitTo.mockClear();
  });
  const swipe = (stroke: string) => window.dispatchEvent(new CustomEvent(PAGE_SWIPE_EVENT, { detail: stroke }));

  it("only starts native tracking for the requesting window and a non-scrolling target", () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    document.body.innerHTML = '<div class="xterm"><span>x</span></div><button>Navigate</button>';
    const hitTest = vi.fn(() => document.querySelector("span"));
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hitTest });
    const stop = installPageSwipeTracking(window);
    try {
      const candidate = () =>
        window.dispatchEvent(new CustomEvent("ide:page-swipe-candidate", { detail: { id: 42, x: 10, y: 20 } }));
      candidate();
      expect(emitTo).not.toHaveBeenCalled();
      hitTest.mockReturnValue(document.querySelector("button"));
      candidate();
      expect(emitTo).toHaveBeenCalledWith({ kind: "WebviewWindow", label: "project-2" }, "ide://page-swipe-track", 42);
      stop();
      candidate();
      expect(emitTo).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });

  it("maps physical right to Back and left to Forward", async () => {
    swipe("SwipeRight");
    swipe("SwipeLeft");
    await Promise.resolve();
    expect(back).toHaveBeenCalledOnce();
    expect(forward).toHaveBeenCalledOnce();
  });
  it("supports removing and rebinding gestures", async () => {
    useKeymap.setState({ overrides: { "navigate.back": [], "navigate.forward": ["SwipeRight"] } });
    swipe("SwipeLeft");
    swipe("SwipeRight");
    await Promise.resolve();
    expect(back).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledOnce();
  });
  it("honors action context and recorder suspension", async () => {
    dispose.push(registerAction({ id: "navigate.back", title: "Back", when: "editorFocus", run: back }));
    setContext("editorFocus", false);
    swipe("SwipeRight");
    setContext("editorFocus", true);
    const resume = suspendKeyboardDispatch();
    swipe("SwipeRight");
    resume();
    swipe("invalid");
    await Promise.resolve();
    expect(back).not.toHaveBeenCalled();
    setContext("editorFocus", false);
  });
  it("keeps gestures out of keyboard menu labels", () => {
    expect(normalizeBinding("swiperight")).toBe("SwipeRight");
    useKeymap.setState({ overrides: { "navigate.back": ["SwipeRight"] } });
    expect(primaryKeyBinding("navigate.back")).toBeUndefined();
  });
  it.each(["auto", "scroll", "overlay"])("preserves horizontal %s scrolling even at the edge", (overflow) => {
    document.body.innerHTML = `<div style="overflow-x:${overflow}"><span>x</span></div>`;
    const el = document.body.firstElementChild!;
    Object.defineProperties(el, { clientWidth: { value: 100 }, scrollWidth: { value: 500 } });
    expect(ownsHorizontalScroll(el.firstElementChild)).toBe(true);
  });
  it("does not classify clipped content or vertical-only content as horizontal scrolling", () => {
    document.body.innerHTML = '<div style="overflow-x:hidden"><span>x</span></div>';
    const el = document.body.firstElementChild!;
    Object.defineProperties(el, { clientWidth: { value: 100 }, scrollWidth: { value: 500 } });
    expect(ownsHorizontalScroll(el)).toBe(false);
    expect(ownsHorizontalScroll(document.body)).toBe(false);
  });
  it("preserves custom wheel handlers such as image panning and diff dividers", () => {
    document.body.innerHTML = "<div data-wheel-scroll><span>canvas</span></div>";
    expect(ownsHorizontalScroll(document.querySelector("span"))).toBe(true);
  });
  it("leaves terminal wheel handling to the terminal application", () => {
    document.body.innerHTML = '<div class="xterm"><textarea></textarea></div>';
    expect(ownsHorizontalScroll(document.querySelector("textarea"))).toBe(true);
  });
});
