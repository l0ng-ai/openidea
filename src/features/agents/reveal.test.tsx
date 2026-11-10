import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVEAL_HORIZON_MS, revealStep, useRevealedText } from "./reveal";

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

  it("never paints half an emoji", () => {
    const { result, rerender } = renderHook(({ text }) => useRevealedText(text, true), {
      initialProps: { text: "a" },
    });
    rerender({ text: "a👋" });
    frame(1);
    expect(result.current).toBe("a👋");
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
