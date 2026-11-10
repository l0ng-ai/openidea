import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installReorderedTapClick } from "./reordered-tap-click";

/** An event as the engine would deliver it: native `timeStamp`, mouse pointer. */
function ev(type: string, timeStamp: number, extra: { detail?: number; pointerType?: string } = {}) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, detail: extra.detail ?? 0 });
  Object.defineProperty(e, "timeStamp", { value: timeStamp });
  if (type.startsWith("pointer")) Object.assign(e, { pointerType: extra.pointerType ?? "mouse", isPrimary: true });
  return e;
}

describe("installReorderedTapClick", () => {
  let uninstall: () => void;
  let el: HTMLElement;
  let log: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    uninstall = installReorderedTapClick({ isTrusted: () => true });
    el = document.body.appendChild(document.createElement("div"));
    log = [];
    for (const t of ["pointerdown", "pointerup", "mouseup", "click", "dblclick"])
      el.addEventListener(t, (e) => log.push(`${t}:${(e as MouseEvent).detail}`));
  });
  afterEach(() => {
    uninstall();
    el.remove();
    vi.useRealTimers();
  });

  /** WebKit's order for a tap while an input method is active: up, then the stale down. */
  const reversedTap = (up: number, down: number, detail = 1) => {
    el.dispatchEvent(ev("pointerup", up));
    el.dispatchEvent(ev("mouseup", up));
    el.dispatchEvent(ev("pointerdown", down));
    el.dispatchEvent(ev("mousedown", down, { detail }));
    vi.runAllTimers();
  };
  const inOrderTap = (down: number, up: number) => {
    el.dispatchEvent(ev("pointerdown", down));
    el.dispatchEvent(ev("mousedown", down, { detail: 1 }));
    el.dispatchEvent(ev("pointerup", up));
    el.dispatchEvent(ev("mouseup", up));
    el.dispatchEvent(ev("click", up, { detail: 1 }));
    vi.runAllTimers();
  };

  it("leaves an in-order tap alone", () => {
    inOrderTap(10, 20);
    expect(log).toEqual(["pointerdown:0", "pointerup:0", "mouseup:0", "click:1"]);
  });

  it("finishes a reordered tap with exactly one click", () => {
    reversedTap(1393, 1386);
    // The engine's own pointerup/mouseup, then ours; one click only.
    expect(log.filter((l) => l.startsWith("click"))).toEqual(["click:1"]);
    expect(log.filter((l) => l.startsWith("pointerup"))).toHaveLength(2);
  });

  it("gives the next press the pointerdown the engine skips, and keeps its click", () => {
    reversedTap(1393, 1386);
    log = [];
    // The engine still considers the button down: the next tap starts with a bare mousedown.
    el.dispatchEvent(ev("mousedown", 2000, { detail: 1 }));
    el.dispatchEvent(ev("pointerup", 2050));
    el.dispatchEvent(ev("mouseup", 2050));
    el.dispatchEvent(ev("click", 2050, { detail: 1 }));
    vi.runAllTimers();
    expect(log).toEqual(["pointerdown:0", "pointerup:0", "mouseup:0", "click:1"]);
  });

  it("adds no pointerdown to an in-order press", () => {
    inOrderTap(10, 20);
    inOrderTap(30, 40);
    expect(log.filter((l) => l.startsWith("pointerdown"))).toEqual(["pointerdown:0", "pointerdown:0"]);
  });

  it("adds no pointerdown to a press another pointer type started", () => {
    el.dispatchEvent(ev("pointerdown", 10, { pointerType: "touch" }));
    el.dispatchEvent(ev("mousedown", 10, { detail: 1 }));
    expect(log).toEqual(["pointerdown:0"]);
  });

  it("does not drop the click of an in-order tap that follows a reordered one", () => {
    reversedTap(1393, 1386);
    inOrderTap(3000, 3050);
    expect(log.filter((l) => l.startsWith("click"))).toEqual(["click:1", "click:1"]);
  });

  it("leaves a quick double-click alone when its second press shares the first release's timestamp", () => {
    // Fast input (automation, a quick double-click) stamps both at the same time step.
    el.dispatchEvent(ev("pointerdown", 5900.9));
    el.dispatchEvent(ev("mousedown", 5900.9, { detail: 1 }));
    el.dispatchEvent(ev("pointerup", 5901));
    el.dispatchEvent(ev("mouseup", 5901));
    el.dispatchEvent(ev("click", 5901, { detail: 1 }));
    el.dispatchEvent(ev("pointerdown", 5901));
    el.dispatchEvent(ev("mousedown", 5901, { detail: 2 }));
    el.dispatchEvent(ev("pointerup", 5901));
    el.dispatchEvent(ev("mouseup", 5901));
    el.dispatchEvent(ev("click", 5901, { detail: 2 }));
    el.dispatchEvent(ev("dblclick", 5912, { detail: 2 }));
    vi.runAllTimers();
    expect(log.filter((l) => /^(click|dblclick)/.test(l))).toEqual(["click:1", "click:2", "dblclick:2"]);
  });

  it("finishes nothing when the engine releases the press before the tick", () => {
    el.dispatchEvent(ev("pointerup", 1393));
    el.dispatchEvent(ev("pointerdown", 1386));
    el.dispatchEvent(ev("mousedown", 1386, { detail: 1 }));
    el.dispatchEvent(ev("pointerup", 1400));
    el.dispatchEvent(ev("mouseup", 1400));
    el.dispatchEvent(ev("click", 1400, { detail: 1 }));
    vi.runAllTimers();
    expect(log.filter((l) => l.startsWith("click"))).toEqual(["click:1"]);
    expect(log.filter((l) => l.startsWith("pointerup"))).toHaveLength(2);
  });

  it("repeats the double-click detail of the stale press", () => {
    reversedTap(1393, 1386, 2);
    expect(log).toContain("click:2");
    expect(log).toContain("dblclick:2");
  });

  it("ignores touch and pen pointers", () => {
    el.dispatchEvent(ev("pointerup", 1393, { pointerType: "touch" }));
    el.dispatchEvent(ev("pointerdown", 1386, { pointerType: "touch" }));
    vi.runAllTimers();
    expect(log).toEqual(["pointerup:0", "pointerdown:0"]);
  });

  it("does nothing when the target left the document before the tick", () => {
    el.dispatchEvent(ev("pointerup", 1393));
    el.dispatchEvent(ev("pointerdown", 1386));
    el.remove();
    vi.runAllTimers();
    expect(log).toEqual(["pointerup:0", "pointerdown:0"]);
  });

  it("stops intercepting after uninstall", () => {
    uninstall();
    reversedTap(1393, 1386);
    expect(log.filter((l) => l.startsWith("click"))).toEqual([]);
  });
});
