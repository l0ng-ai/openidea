import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdeEvent } from "@/bindings";

const listeners = vi.hoisted(() => new Set<(e: IdeEvent) => void>());
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    onIdeEvent: (_type: string, fn: (e: IdeEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
});

const { onServerSettled, featureBackoff, installAvailabilityEvents } = await import("./availability");

const status = (s: string) => {
  for (const fn of listeners) fn({ type: "languageServer", server: 1, status: s } as unknown as IdeEvent);
};

describe("onServerSettled", () => {
  afterEach(() => {
    vi.useRealTimers();
    listeners.clear();
  });

  it("re-runs a callback that keeps the server busy only once", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    onServerSettled(fn);
    status("starting");
    status("ready");
    expect(fn).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 2; i++) {
      status("busy");
      vi.advanceTimersByTime(2000);
      status("ready");
    }
    expect(fn).toHaveBeenCalledTimes(2);
    // Indexing that starts later is a new settle.
    vi.advanceTimersByTime(10_000);
    status("busy");
    vi.advanceTimersByTime(5000);
    status("ready");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("ignores short busy spells", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    onServerSettled(fn);
    status("busy");
    vi.advanceTimersByTime(100);
    status("ready");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("featureBackoff", () => {
  afterEach(() => {
    vi.useRealTimers();
    listeners.clear();
  });

  it("leaves a document alone until the back-off expires", () => {
    vi.useFakeTimers();
    const backoff = featureBackoff(1000);
    expect(backoff.active(1)).toBe(false);
    backoff.mark(1);
    expect(backoff.active(1)).toBe(true);
    expect(backoff.active(2)).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(backoff.active(1)).toBe(false);
  });

  it("keeps features independent: one feature backing off does not stop another", () => {
    const inlay = featureBackoff();
    const completion = featureBackoff();
    inlay.mark(1);
    expect(inlay.active(1)).toBe(true);
    expect(completion.active(1)).toBe(false);
  });

  it("is cleared for every feature when a server becomes ready", () => {
    const a = featureBackoff();
    const b = featureBackoff();
    const off = installAvailabilityEvents();
    a.mark(1);
    b.mark(2);
    status("starting");
    expect(a.active(1)).toBe(true);
    status("ready");
    expect(a.active(1)).toBe(false);
    expect(b.active(2)).toBe(false);
    off();
  });
});
