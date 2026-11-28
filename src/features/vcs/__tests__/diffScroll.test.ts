import { describe, expect, it, vi } from "vitest";
import { Chunk, MergeView } from "@codemirror/merge";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { bandAt, bandPath, transferY, PaddedPanes, UnalignedPanes, type Band } from "../diffScroll";
import { collapsedDiffLines } from "../collapsedDiffLines";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const doc = (s: string) => Text.of(s.split("\n"));
const LINE = 20;

/** The band at `y` of side `from` in two texts with every line LINE px tall. */
function bands(a: string, b: string) {
  const da = doc(a);
  const db = doc(b);
  const ext = (d: Text, from: number, to: number): [number, number] => {
    if (from > d.length) return [d.lines * LINE, d.lines * LINE];
    const top = (d.lineAt(from).number - 1) * LINE;
    return from >= to ? [top, top] : [top, d.lineAt(Math.min(to - 1, d.length)).number * LINE];
  };
  const chunks = Chunk.build(da, db);
  return (y: number, from: "a" | "b"): Band =>
    bandAt(
      chunks,
      (c) => ext(da, c.fromA, c.toA),
      (c) => ext(db, c.fromB, c.toB),
      da.lines * LINE,
      db.lines * LINE,
      y,
      from,
    );
}

describe("unaligned side-by-side scrolling", () => {
  // Right side inserts three lines after line 2 and changes line 5 into two lines.
  const a = "1\n2\n3\n4\n5\n6\n7";
  const b = "1\n2\nx\ny\nz\n3\n4\nfive\nfive'\n6\n7";
  const bandOf = bands(a, b);
  const at = (y: number, from: "a" | "b") => transferY([bandOf(y, from)], y, from);

  it("splits both documents into unchanged and changed bands", () => {
    const row = (x: Band) => [x.a0, x.a1, x.b0, x.b1, x.changed];
    expect([0, 39, 40, 79, 80, 99, 100, 139].map((y) => row(bandOf(y, "a")))).toEqual([
      [0, 40, 0, 40, false],
      [0, 40, 0, 40, false],
      [40, 80, 100, 140, false],
      [40, 80, 100, 140, false],
      [80, 100, 140, 180, true],
      [80, 100, 140, 180, true],
      [100, 140, 180, 220, false],
      [100, 140, 180, 220, false],
    ]);
    expect([0, 40, 99, 100, 140, 179, 180].map((y) => row(bandOf(y, "b")))).toEqual([
      [0, 40, 0, 40, false],
      [40, 40, 40, 100, true],
      [40, 40, 40, 100, true],
      [40, 80, 100, 140, false],
      [80, 100, 140, 180, true],
      [80, 100, 140, 180, true],
      [100, 140, 180, 220, false],
    ]);
  });

  it("maps unchanged text straight through", () => {
    expect(at(10, "a")).toBe(10);
    expect(at(50, "a")).toBe(110);
    expect(at(130, "a")).toBe(210);
    expect(at(210, "b")).toBe(130);
  });

  it("jumps over an insertion when scrolling the side without it", () => {
    expect(at(39, "a")).toBe(39);
    expect(at(40, "a")).toBe(100);
  });

  it("waits at the boundary while the inserted lines scroll by", () => {
    for (const y of [40, 60, 99]) expect(at(y, "b")).toBe(40);
  });

  it("follows line by line inside a change, then waits at the shorter end", () => {
    expect(at(150, "b")).toBe(90);
    expect(at(170, "b")).toBe(100);
    expect(at(90, "a")).toBe(150);
  });

  it("scales unchanged text of different heights (wrapped lines)", () => {
    const stretched = [{ a0: 0, a1: 100, b0: 0, b1: 200, changed: false }];
    expect(transferY(stretched, 50, "a")).toBe(100);
    expect(transferY(stretched, 50, "b")).toBe(25);
  });

  it("draws an empty side as a sliver on its boundary", () => {
    expect(bandPath(30, 40, 40, 40, 100)).toBe("M0 39C9 39 21 40 30 40L30 100C21 100 9 41 0 41Z");
  });

  it("can keep MergeView from padding the panes", () => {
    // UnalignedPanes replaces this (private) method; a rename upstream would bring the padding back.
    expect(typeof (MergeView.prototype as unknown as { measure: unknown }).measure).toBe("function");
  });
});

describe("synchronized navigation scrolling", () => {
  function panes(sync = true) {
    const root = document.createElement("div");
    const text = doc(Array.from({ length: 200 }, () => "line").join("\n"));
    const view = () => {
      const wrapper = root.appendChild(document.createElement("div"));
      const dom = wrapper.appendChild(document.createElement("div"));
      const scrollDOM = dom.appendChild(document.createElement("div"));
      Object.defineProperty(scrollDOM, "scrollHeight", { value: 4000 });
      scrollDOM.scrollTo = vi.fn();
      return {
        dom,
        scrollDOM,
        state: { doc: text },
        get documentTop() {
          return -scrollDOM.scrollTop;
        },
        lineBlockAt: (pos: number) => ({ bottom: text.lineAt(pos).number * LINE }),
      } as unknown as EditorView;
    };
    const a = view();
    const b = view();
    const controller = new UnalignedPanes({ sync });
    controller.attach({ a, b, chunks: [] } as unknown as MergeView);
    const scroll = (view: EditorView, top: number) => {
      view.scrollDOM.scrollTop = top;
      view.scrollDOM.dispatchEvent(new Event("scroll"));
    };
    return { a, b, controller, scroll };
  }

  it.each([
    ["a", "smooth"],
    ["b", "smooth"],
    ["a", "instant"],
    ["b", "instant"],
  ] as const)("keeps %s as the source during a %s jump", (side, behavior) => {
    vi.useFakeTimers();
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const p = panes();
    try {
      const leader = p[side];
      const follower = p[side === "a" ? "b" : "a"];
      p.controller.scrollTo(side, { top: 2000, behavior });
      p.scroll(leader, 1000);
      expect(follower.scrollDOM.scrollTop).toBe(1000);
      p.scroll(follower, 200);
      expect(leader.scrollDOM.scrollTop).toBe(1000);
      expect(follower.scrollDOM.scrollTop).toBe(1000);
      p.scroll(leader, 2000);
      expect(follower.scrollDOM.scrollTop).toBe(2000);
      vi.advanceTimersByTime(150);
      p.scroll(follower, 300);
      expect(leader.scrollDOM.scrollTop).toBe(300);
    } finally {
      p.controller.destroy();
      frame.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(["wheel", "pointerdown"])("lets %s interrupt an animated jump", (event) => {
    vi.useFakeTimers();
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const p = panes();
    try {
      p.controller.scrollTo("a", { top: 2000, behavior: "smooth" });
      p.scroll(p.a, 1000);
      p.b.scrollDOM.dispatchEvent(new Event(event));
      expect(p.a.scrollDOM.scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: "instant" });
      p.scroll(p.b, 400);
      expect(p.a.scrollDOM.scrollTop).toBe(400);
    } finally {
      p.controller.destroy();
      frame.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps the wheel-scrolled pane in charge when the follower pane adjusts scrollTop on measure", () => {
    vi.useFakeTimers();
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const p = panes();
    try {
      p.b.scrollDOM.dispatchEvent(new Event("wheel"));
      p.scroll(p.b, 1200);
      expect(p.a.scrollDOM.scrollTop).toBe(1200);
      // Repeated wheel events must not cancel native momentum with scrollTo(instant).
      p.b.scrollDOM.dispatchEvent(new Event("wheel"));
      expect(p.b.scrollDOM.scrollTo).not.toHaveBeenCalled();
      // Follower shifts from CodeMirror height measurement must not yank the wheel source back.
      p.scroll(p.a, 800);
      expect(p.b.scrollDOM.scrollTop).toBe(1200);
      expect(p.a.scrollDOM.scrollTop).toBe(1200);
      // Pointer interaction on the other pane hands control back immediately.
      p.a.scrollDOM.dispatchEvent(new Event("pointerdown"));
      p.scroll(p.a, 400);
      expect(p.b.scrollDOM.scrollTop).toBe(400);
    } finally {
      p.controller.destroy();
      frame.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("wheel over a pane that cannot scroll further", () => {
  // Lines deleted at the end: the left pane is long, the right one fits without scrolling.
  // `lead` lines come above those in the left pane only.
  function panes(sync = true, { left = 200, right = 25, lead = 0 } = {}) {
    const root = document.createElement("div");
    const text = (lines: number, own = 0) =>
      doc(Array.from({ length: own + lines }, (_, i) => (i < own ? `lead ${i}` : `line ${i - own}`)).join("\n"));
    const view = (text: Text) => {
      const lines = text.lines;
      const wrapper = root.appendChild(document.createElement("div"));
      const dom = wrapper.appendChild(document.createElement("div"));
      const scrollDOM = dom.appendChild(document.createElement("div"));
      Object.defineProperty(scrollDOM, "scrollHeight", { value: lines * LINE });
      Object.defineProperty(scrollDOM, "clientHeight", { value: 500 });
      scrollDOM.scrollBy = vi.fn((_x: number, y: number) => {
        scrollDOM.scrollTop = Math.max(0, Math.min(scrollDOM.scrollTop + y, lines * LINE - 500));
      }) as unknown as typeof scrollDOM.scrollBy;
      return {
        dom,
        scrollDOM,
        defaultLineHeight: LINE,
        state: { doc: text },
        get documentTop() {
          return -scrollDOM.scrollTop;
        },
        lineBlockAt: (pos: number) => {
          const line = text.lineAt(pos).number;
          return { top: (line - 1) * LINE, bottom: line * LINE };
        },
      } as unknown as EditorView;
    };
    const a = view(text(left, lead));
    const b = view(text(right));
    const controller = new UnalignedPanes({ sync });
    controller.attach({ a, b, chunks: Chunk.build(a.state.doc, b.state.doc) } as unknown as MergeView);
    const wheel = (el: Element, deltaY: number, deltaMode = 0, init: WheelEventInit = {}) => {
      const e = new WheelEvent("wheel", { deltaY, deltaMode, cancelable: true, ...init });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    };
    return { a, b, controller, wheel, divider: root.querySelector(".cm-diffDivider")! };
  }

  it("scrolls the other pane when synchronized", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const p = panes();
    try {
      expect(p.wheel(p.b.scrollDOM, 120)).toBe(false);
      expect(p.a.scrollDOM.scrollBy).toHaveBeenLastCalledWith(0, 120);
      p.wheel(p.divider, 80);
      expect(p.a.scrollDOM.scrollBy).toHaveBeenLastCalledWith(0, 80);
      // The left pane can still scroll down itself: nothing is passed on.
      vi.mocked(p.b.scrollDOM.scrollBy).mockClear();
      p.wheel(p.a.scrollDOM, 120);
      expect(p.b.scrollDOM.scrollBy).not.toHaveBeenCalled();
    } finally {
      p.controller.destroy();
      frame.mockRestore();
    }
  });

  it("scrolls the right pane over a left pane at its end (lines added at the end)", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const p = panes(true, { left: 25, right: 200 });
    try {
      expect(p.wheel(p.a.scrollDOM, 120)).toBe(false);
      expect(p.b.scrollDOM.scrollBy).toHaveBeenLastCalledWith(0, 120);
      p.b.scrollDOM.dispatchEvent(new Event("scroll"));
      expect(p.b.scrollDOM.scrollTop).toBe(120);
    } finally {
      p.controller.destroy();
      frame.mockRestore();
    }
  });

  it("scrolls the other pane back when a wheel turns after taking it past where this one maps it", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const p = panes();
    try {
      p.wheel(p.b.scrollDOM, 3000);
      p.a.scrollDOM.dispatchEvent(new Event("scroll"));
      expect(p.a.scrollDOM.scrollTop).toBe(3000);
      // The right pane can't scroll at all: the left one comes back by the wheel's own distance.
      expect(p.wheel(p.b.scrollDOM, -3, WheelEvent.DOM_DELTA_LINE)).toBe(false);
      expect(p.a.scrollDOM.scrollBy).toHaveBeenLastCalledWith(0, -3 * LINE);
      p.a.scrollDOM.dispatchEvent(new Event("scroll"));
      expect(p.a.scrollDOM.scrollTop).toBe(3000 - 3 * LINE);
      p.wheel(p.divider, -80);
      expect(p.a.scrollDOM.scrollBy).toHaveBeenLastCalledWith(0, -80);
      p.a.scrollDOM.dispatchEvent(new Event("scroll"));
      expect(p.a.scrollDOM.scrollTop).toBe(3000 - 3 * LINE - 80);
    } finally {
      p.controller.destroy();
      frame.mockRestore();
    }
  });

  it("forgets a passed-on wheel once the user scrolls that pane", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const p = panes();
    try {
      p.wheel(p.b.scrollDOM, 3000);
      p.a.scrollDOM.dispatchEvent(new Event("scroll"));
      p.a.scrollDOM.scrollTop = 2000;
      p.a.scrollDOM.dispatchEvent(new Event("scroll"));
      vi.mocked(p.a.scrollDOM.scrollBy).mockClear();
      expect(p.wheel(p.b.scrollDOM, -120)).toBe(false);
      expect(p.a.scrollDOM.scrollBy).toHaveBeenLastCalledWith(0, -120);
    } finally {
      p.controller.destroy();
      frame.mockRestore();
    }
  });

  it("forgets a passed-on wheel once that pane is back where this one maps it", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    // The right pane scrolls, so a wheel up over it at its end is not passed on for being stuck.
    const p = panes(true, { left: 200, right: 50 });
    try {
      p.b.scrollDOM.scrollTop = 50 * LINE - 500;
      p.b.scrollDOM.dispatchEvent(new Event("scroll"));
      p.wheel(p.b.scrollDOM, 120);
      p.a.scrollDOM.dispatchEvent(new Event("scroll"));
      p.wheel(p.b.scrollDOM, -120);
      p.b.scrollDOM.scrollTop -= 120; // the native scroll
      p.b.scrollDOM.dispatchEvent(new Event("scroll"));
      p.a.scrollDOM.dispatchEvent(new Event("scroll"));
      expect(p.a.scrollDOM.scrollTop).toBeCloseTo(p.b.scrollDOM.scrollTop);
      vi.mocked(p.a.scrollDOM.scrollBy).mockClear();
      expect(p.wheel(p.b.scrollDOM, -120)).toBe(false);
      // Elsewhere again, by something other than a wheel passed on.
      p.a.scrollDOM.scrollTop = 3000;
      expect(p.wheel(p.b.scrollDOM, -120)).toBe(false);
      expect(p.a.scrollDOM.scrollBy).not.toHaveBeenCalled();
    } finally {
      p.controller.destroy();
      frame.mockRestore();
    }
  });

  it("leaves a wheel the same way over the pane a wheel was passed on to", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const p = panes(true, { left: 200, right: 50 });
    try {
      p.b.scrollDOM.scrollTop = 50 * LINE - 500;
      p.b.scrollDOM.dispatchEvent(new Event("scroll"));
      const mapped = p.a.scrollDOM.scrollTop;
      for (let i = 1; i <= 4; i++) {
        expect(p.wheel(p.b.scrollDOM, 120)).toBe(false);
        p.a.scrollDOM.dispatchEvent(new Event("scroll"));
        expect(p.a.scrollDOM.scrollTop).toBe(mapped + i * 120);
      }
      // The pointer moves to the left pane, which can still scroll: the wheel is its own.
      expect(p.wheel(p.a.scrollDOM, 120)).toBe(false);
      expect(p.b.scrollDOM.scrollBy).not.toHaveBeenCalled();
      expect(p.a.scrollDOM.scrollTop).toBe(mapped + 480);
    } finally {
      p.controller.destroy();
      frame.mockRestore();
    }
  });

  it("scrolls the other pane back no further than where this one maps it", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const p = panes(true, { left: 200, right: 50 });
    try {
      p.b.scrollDOM.scrollTop = 50 * LINE - 500;
      p.b.scrollDOM.dispatchEvent(new Event("scroll"));
      const mapped = p.a.scrollDOM.scrollTop;
      p.wheel(p.b.scrollDOM, 100);
      p.a.scrollDOM.dispatchEvent(new Event("scroll"));
      expect(p.a.scrollDOM.scrollTop).toBe(mapped + 100);
      // A wheel longer than what is left: the left pane stops where the right one will map it.
      p.wheel(p.b.scrollDOM, -120);
      expect(p.a.scrollDOM.scrollBy).toHaveBeenLastCalledWith(0, -220);
      p.b.scrollDOM.scrollTop -= 120; // the native scroll
      p.b.scrollDOM.dispatchEvent(new Event("scroll"));
      p.a.scrollDOM.dispatchEvent(new Event("scroll"));
      expect(p.a.scrollDOM.scrollTop).toBeCloseTo(mapped - 120);
      expect(p.a.scrollDOM.scrollTop).toBeCloseTo(p.b.scrollDOM.scrollTop);
    } finally {
      p.controller.destroy();
      frame.mockRestore();
    }
  });

  it("leaves the wheel to a pane whose other pane is elsewhere without a wheel passed on", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    // The left pane starts with 1,000 lines of its own: the right one's first lines map far down it.
    const p = panes(true, { left: 300, right: 300, lead: 1000 });
    try {
      for (let i = 0; i < 3; i++) expect(p.wheel(p.b.scrollDOM, 120)).toBe(false);
      expect(p.wheel(p.divider, 120)).toBe(true);
      expect(p.b.scrollDOM.scrollBy).toHaveBeenLastCalledWith(0, 120);
      expect(p.a.scrollDOM.scrollBy).not.toHaveBeenCalled();
    } finally {
      p.controller.destroy();
      frame.mockRestore();
    }
  });

  it("keeps a horizontal wheel on the pane under the pointer at its end", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const p = panes(); // both panes at the top
    try {
      p.wheel(p.b.scrollDOM, -1, 0, { deltaX: 40 });
      p.b.scrollDOM.scrollLeft = 40; // the native horizontal scroll
      p.b.scrollDOM.dispatchEvent(new Event("scroll"));
      expect(p.b.scrollDOM.scrollLeft).toBe(40);
      expect(p.a.scrollDOM.scrollLeft).toBe(40);
      p.wheel(p.b.scrollDOM, 120, 0, { shiftKey: true });
      expect(p.a.scrollDOM.scrollBy).not.toHaveBeenCalled();
    } finally {
      p.controller.destroy();
      frame.mockRestore();
    }
  });

  it("passes on the vertical part of a mostly vertical wheel and keeps its horizontal part", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const p = panes();
    try {
      expect(p.wheel(p.b.scrollDOM, 120, 0, { deltaX: 10 })).toBe(false);
      expect(p.a.scrollDOM.scrollBy).toHaveBeenLastCalledWith(0, 120);
      p.a.scrollDOM.dispatchEvent(new Event("scroll"));
      p.b.scrollDOM.scrollLeft = 10; // the native horizontal scroll
      p.b.scrollDOM.dispatchEvent(new Event("scroll"));
      expect(p.b.scrollDOM.scrollLeft).toBe(10);
      expect(p.a.scrollDOM.scrollLeft).toBe(10);
      expect(p.a.scrollDOM.scrollTop).toBe(120);
    } finally {
      p.controller.destroy();
      frame.mockRestore();
    }
  });

  it("closes an overshoot over several uncancellable wheels back, never in one jump", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const p = panes(true, { left: 200, right: 50 });
    try {
      const end = 50 * LINE - 500;
      p.b.scrollDOM.scrollTop = end;
      p.b.scrollDOM.dispatchEvent(new Event("scroll"));
      for (let i = 0; i < 3; i++) {
        p.wheel(p.b.scrollDOM, 120, 0, { cancelable: false });
        p.a.scrollDOM.dispatchEvent(new Event("scroll"));
      }
      expect(p.a.scrollDOM.scrollTop - p.b.scrollDOM.scrollTop).toBe(360);
      // A trackpad gesture back: WebKit lets none of these be cancelled, so the right pane scrolls natively.
      for (let i = 0; i < 12; i++) {
        const before = p.a.scrollDOM.scrollTop;
        expect(p.wheel(p.b.scrollDOM, -40, 0, { cancelable: false })).toBe(false);
        p.b.scrollDOM.scrollTop -= 40;
        p.b.scrollDOM.dispatchEvent(new Event("scroll"));
        p.a.scrollDOM.dispatchEvent(new Event("scroll"));
        expect(Math.abs(p.a.scrollDOM.scrollTop - before)).toBeLessThanOrEqual(80);
        expect(p.a.scrollDOM.scrollTop).toBeGreaterThan(p.b.scrollDOM.scrollTop - 1);
      }
      expect(p.a.scrollDOM.scrollTop).toBeCloseTo(p.b.scrollDOM.scrollTop);
    } finally {
      p.controller.destroy();
      frame.mockRestore();
    }
  });

  it("leaves the other pane alone when scrolling is not synchronized", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const p = panes(false);
    try {
      p.wheel(p.b.scrollDOM, 120);
      p.a.scrollDOM.scrollTop = 3000;
      p.wheel(p.b.scrollDOM, -120);
      expect(p.a.scrollDOM.scrollBy).not.toHaveBeenCalled();
    } finally {
      p.controller.destroy();
      frame.mockRestore();
    }
  });
});

describe("padded pane scrolling (aligned diff)", () => {
  function panes(sync = true) {
    const root = document.createElement("div");
    const view = () => {
      const wrapper = root.appendChild(document.createElement("div"));
      const dom = wrapper.appendChild(document.createElement("div"));
      const scrollDOM = dom.appendChild(document.createElement("div"));
      Object.defineProperty(scrollDOM, "scrollHeight", { value: 4000 });
      scrollDOM.scrollTo = vi.fn();
      return { dom, scrollDOM } as unknown as EditorView;
    };
    const a = view();
    const b = view();
    const controller = new PaddedPanes(sync);
    controller.attach({ a, b } as unknown as MergeView);
    const scroll = (view: EditorView, top: number) => {
      view.scrollDOM.scrollTop = top;
      view.scrollDOM.dispatchEvent(new Event("scroll"));
    };
    return { a, b, controller, scroll };
  }

  it("copies the scrolled pane's top to the other one", () => {
    const p = panes();
    try {
      p.scroll(p.b, 500);
      expect(p.a.scrollDOM.scrollTop).toBe(500);
      p.scroll(p.a, 200);
      expect(p.b.scrollDOM.scrollTop).toBe(200);
    } finally {
      p.controller.destroy();
    }
  });

  it("leaves the panes alone when synchronized scrolling is off", () => {
    const p = panes(false);
    try {
      p.scroll(p.b, 500);
      expect(p.a.scrollDOM.scrollTop).toBe(0);
    } finally {
      p.controller.destroy();
    }
  });

  it("keeps the navigation source in charge while its scroll animates", () => {
    vi.useFakeTimers();
    const p = panes();
    try {
      p.controller.scrollTo("b", { top: 2000, behavior: "smooth" });
      p.scroll(p.b, 300);
      expect(p.a.scrollDOM.scrollTop).toBe(300);
      // The follower's echo must not pull the source back.
      p.scroll(p.a, 300);
      expect(p.b.scrollDOM.scrollTop).toBe(300);
      vi.advanceTimersByTime(150);
      p.scroll(p.a, 100);
      expect(p.b.scrollDOM.scrollTop).toBe(100);
    } finally {
      p.controller.destroy();
      vi.useRealTimers();
    }
  });

  it("keeps the wheel-scrolled pane in charge when the follower shifts during layout", () => {
    vi.useFakeTimers();
    const p = panes();
    try {
      p.b.scrollDOM.dispatchEvent(new Event("wheel"));
      p.scroll(p.b, 900);
      expect(p.a.scrollDOM.scrollTop).toBe(900);
      p.scroll(p.a, 500);
      expect(p.b.scrollDOM.scrollTop).toBe(900);
      expect(p.a.scrollDOM.scrollTop).toBe(900);
      vi.advanceTimersByTime(150);
      p.scroll(p.a, 200);
      expect(p.b.scrollDOM.scrollTop).toBe(200);
    } finally {
      p.controller.destroy();
      vi.useRealTimers();
    }
  });
});

describe("collapsed diff lines", () => {
  it("defers button DOM replacement from docViewUpdate into CodeMirror's measure write phase", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: "a\nb\nc", extensions: [collapsedDiffLines()] }),
      parent,
    });
    const measureSpy = vi.spyOn(view, "requestMeasure");
    try {
      const row = document.createElement("div");
      row.className = "cm-collapsedLines";
      row.textContent = "10 unchanged lines";
      view.contentDOM.appendChild(row);
      const plugin = (
        view as unknown as { plugins: Array<{ value: { docViewUpdate?: () => void } | null }> }
      ).plugins.find((p) => typeof p.value?.docViewUpdate === "function");
      expect(plugin).toBeDefined();
      measureSpy.mockClear();
      plugin!.value!.docViewUpdate!();
      // Must not mutate DOM synchronously during docViewUpdate (triggers WebKit scrollTop clamping).
      expect(row.querySelector("button")).toBeNull();
      expect(measureSpy).toHaveBeenCalledTimes(1);
      const req = measureSpy.mock.calls[0]![0] as { write?: (v: unknown, view: EditorView) => void };
      req.write?.(null, view);
      expect(row.querySelector("button")).not.toBeNull();
      expect(row.querySelector("button")?.textContent).toBe("10 unchanged lines");
    } finally {
      measureSpy.mockRestore();
      view.destroy();
      parent.remove();
    }
  });
});

describe("divider arrows", () => {
  const dividerOf = (arrows: { toA: boolean; toB: boolean } | undefined) => {
    const root = document.createElement("div");
    const wrapper = root.appendChild(document.createElement("div"));
    const dom = wrapper.appendChild(document.createElement("div"));
    const view = { dom, scrollDOM: dom.appendChild(document.createElement("div")) } as unknown as EditorView;
    const controller = new UnalignedPanes({ sync: false, arrows: arrows && { ...arrows, apply: () => {} } });
    controller.attach({ a: view, b: view, chunks: [] } as unknown as MergeView);
    const divider = root.querySelector(".cm-diffDivider")!;
    controller.destroy();
    return divider;
  };

  it.each([
    ["only the right pane is editable", { toA: false, toB: true }, true],
    ["only the left pane is editable", { toA: true, toB: false }, true],
    ["both panes are editable", { toA: true, toB: true }, false],
    ["no pane is editable", { toA: false, toB: false }, false],
    ["there are no arrows", undefined, false],
  ])("centres a lone arrow only: %s", (_, arrows, lone) => {
    expect(dividerOf(arrows).classList.contains("cm-diffDivider-lone")).toBe(lone);
  });
});

describe("diff controls in the stylesheet", () => {
  // jsdom has no layout, so the selectors that decide how the controls are centred are read from the source.
  const css = readFileSync(resolve(import.meta.dirname, "../DiffEditor.module.css"), "utf8");

  it("lets only the band layer fill the divider, not the chevrons inside the arrow buttons", () => {
    expect(css).toMatch(/\.cm-diffDivider > svg\)\s*\{[^}]*position: absolute;[^}]*inset: 0;/);
    expect(css).not.toMatch(/\.cm-diffDivider svg\)/);
  });

  it("centres the hover Revert button on the line's own height", () => {
    const rule = css.match(/\.cm-diffHoverRevert\)\s*\{([^}]*)\}/)![1]!;
    expect(rule).toContain("top: calc((var(--openidea-editor-line-height, var(--lh-code)) - var(--space-4)) / 2);");
    expect(rule).not.toMatch(/top: 0;/);
  });
});
