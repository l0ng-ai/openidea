import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVEAL_HORIZON_MS, revealBoundary, revealStep, useRevealedText, withoutBrokenTail } from "./reveal";

describe("revealStep", () => {
  it("drains the backlog over the horizon, at least a character a frame", () => {
    expect(revealStep(0, 16)).toBe(0);
    expect(revealStep(300, 15)).toBe(30);
    expect(revealStep(3, 1)).toBe(1);
    expect(revealStep(300, REVEAL_HORIZON_MS)).toBe(300);
    expect(revealStep(300, 10_000)).toBe(300);
    expect(revealStep(300, 0)).toBe(1);
  });
});

describe("revealBoundary", () => {
  it("cuts only between graphemes", () => {
    expect(revealBoundary("a👋b", 2)).toBe(1);
    expect(revealBoundary("ae\u0301", 2)).toBe(1);
    expect(revealBoundary("a🇯🇵", 3)).toBe(1);
    expect(revealBoundary("abc", 2)).toBe(2);
  });
});

describe("withoutBrokenTail", () => {
  it("holds back a cluster's first half until the rest arrives", () => {
    expect(withoutBrokenTail("a\ud83d")).toBe("a");
    expect(withoutBrokenTail("a👨\u200d")).toBe("a👨");
    expect(withoutBrokenTail("a🇯")).toBe("a");
    expect(withoutBrokenTail("a🇯🇵")).toBe("a🇯🇵");
    expect(withoutBrokenTail("done")).toBe("done");
  });
});

describe("useRevealedText", () => {
  let frames: FrameRequestCallback[] = [];
  let now = 0;
  beforeEach(() => {
    frames = [];
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const frame = (ms: number) =>
    act(() => {
      now += ms;
      const run = frames;
      frames = [];
      run.forEach((cb) => cb(now));
    });

  it("reveals appended text over frames while live", () => {
    const { result, rerender } = renderHook(({ text, live }) => useRevealedText(text, live), {
      initialProps: { text: "Hi", live: true },
    });
    expect(result.current).toBe("Hi");
    rerender({ text: `Hi${"x".repeat(100)}`, live: true });
    expect(result.current).toBe("Hi");
    frame(15);
    expect(result.current.length).toBe(12);
    frame(200);
    expect(result.current.length).toBe(102);
  });

  it("never paints part of a grapheme", () => {
    const family = "👨‍👩‍👧";
    const { result, rerender } = renderHook(({ text }) => useRevealedText(text, true), {
      initialProps: { text: "a" },
    });
    rerender({ text: `a${family}` });
    for (let i = 0; i < 20 && result.current !== `a${family}`; i++) {
      frame(16);
      expect([`a`, `a${family}`]).toContain(result.current);
    }
    expect(result.current).toBe(`a${family}`);
  });

  it("commits at most at 60 Hz on a faster display", () => {
    const { result, rerender } = renderHook(({ text }) => useRevealedText(text, true), {
      initialProps: { text: "" },
    });
    rerender({ text: "x".repeat(1000) });
    frame(8);
    expect(result.current).toBe("");
    frame(8);
    expect(result.current.length).toBeGreaterThan(0);
  });

  it("shows text whole once it stops streaming or is replaced", () => {
    const { result, rerender } = renderHook(({ text, live }) => useRevealedText(text, live), {
      initialProps: { text: "Hi", live: true },
    });
    rerender({ text: "Hi there", live: true });
    rerender({ text: "Hi there", live: false });
    expect(result.current).toBe("Hi there");
    rerender({ text: "Other", live: true });
    expect(result.current).toBe("Other");
  });
});
