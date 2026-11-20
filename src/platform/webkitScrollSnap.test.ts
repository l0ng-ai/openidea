import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installWebKitScrollSnap } from "./webkitScrollSnap";

let dispose: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  dispose = installWebKitScrollSnap();
});
afterEach(() => {
  dispose();
  vi.useRealTimers();
  document.body.replaceChildren();
});

/** A scroller that records offset writes; jsdom has no layout, so its own setters do nothing. */
function scroller(top: number, left = 0) {
  const el = document.createElement("div");
  const writes: string[] = [];
  const pos = { top, left };
  for (const [prop, key] of [
    ["scrollTop", "top"],
    ["scrollLeft", "left"],
  ] as const) {
    Object.defineProperty(el, prop, {
      get: () => pos[key],
      set: (v: number) => {
        pos[key] = v;
        writes.push(`${key}=${v}`);
      },
    });
  }
  document.body.append(el);
  return { el, writes };
}

const scroll = (el: Element) => el.dispatchEvent(new Event("scroll"));

describe("installWebKitScrollSnap", () => {
  it("moves a box that stopped scrolling a pixel away and back", () => {
    const { el, writes } = scroller(40, 7);
    scroll(el);
    vi.advanceTimersByTime(100);
    scroll(el);
    vi.advanceTimersByTime(149);
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual(["top=39", "left=6", "top=40", "left=7"]);
  });

  it("moves away from the start of the range", () => {
    const { el, writes } = scroller(0);
    scroll(el);
    vi.advanceTimersByTime(150);
    expect(writes).toEqual(["top=1", "left=1", "top=0", "left=0"]);
  });

  it("does not snap again for the scroll events of its own snap", () => {
    const { el, writes } = scroller(40);
    scroll(el);
    vi.advanceTimersByTime(150);
    scroll(el);
    vi.advanceTimersByTime(150);
    expect(writes).toHaveLength(4);
    // A later user scroll snaps again.
    scroll(el);
    vi.advanceTimersByTime(150);
    expect(writes).toHaveLength(8);
  });

  it("skips boxes removed before they settle", () => {
    const { el, writes } = scroller(40);
    scroll(el);
    el.remove();
    vi.advanceTimersByTime(150);
    expect(writes).toEqual([]);
  });
});
