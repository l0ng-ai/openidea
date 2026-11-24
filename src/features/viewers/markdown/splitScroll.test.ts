import { afterEach, expect, it, vi } from "vitest";
import { useLiveMarkdown } from "./live";
import { followMarkdownSource } from "./splitScroll";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useLiveMarkdown.setState({}, true);
});

it("retargets one animation, settles exactly, and yields to manual scrolling", () => {
  const root = document.createElement("div");
  Object.defineProperties(root, { scrollHeight: { value: 900 }, clientHeight: { value: 100 } });
  let callback: FrameRequestCallback | undefined;
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const schedule = vi.fn((cb: FrameRequestCallback) => {
    callback = cb;
    return 1;
  });
  vi.stubGlobal("requestAnimationFrame", schedule);
  vi.stubGlobal("cancelAnimationFrame", () => {
    callback = undefined;
  });
  const tick = (dt: number) => {
    const cb = callback;
    callback = undefined;
    now += dt;
    cb?.(now);
  };
  const move = (topLine: number, sourceAtEnd = false) =>
    useLiveMarkdown.setState((s) => ({
      doc: { ...s.doc!, topLine, sourceAtEnd, scrollSeq: (s.doc?.scrollSeq ?? 0) + 1 },
    }));
  const follow = followMarkdownSource("doc", root, (line) => line * 10);
  try {
    move(10);
    move(40);
    expect(schedule).toHaveBeenCalledTimes(1);
    tick(40);
    expect(root.scrollTop).toBeCloseTo(400 * (1 - Math.exp(-1)));
    move(50, true);
    for (let i = 0; i < 10; i++) tick(40);
    expect(root.scrollTop).toBe(800);
    expect(callback).toBeUndefined();
    move(5);
    tick(16);
    root.scrollTop = 350;
    tick(16);
    expect(root.scrollTop).toBe(350);
    expect(callback).toBeUndefined();
    move(20);
    root.dispatchEvent(new Event("wheel"));
    expect(callback).toBeUndefined();
  } finally {
    follow.dispose();
  }
});
