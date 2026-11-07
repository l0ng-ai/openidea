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

const status = (s: string, server = 1) => {
  for (const fn of [...listeners]) fn({ type: "languageServer", server, status: s } as unknown as IdeEvent);
};

describe("onServerSettled", () => {
  // Spells are followed once for the whole app: each test uses its own server.
  const offs: (() => void)[] = [];
  const settled = (fn: () => void) => offs.push(onServerSettled(fn));
  afterEach(() => {
    vi.useRealTimers();
    for (const off of offs.splice(0)) off();
  });

  it("re-runs a callback that keeps the server busy only once", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    settled(fn);
    status("starting", 1);
    status("ready", 1);
    expect(fn).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 2; i++) {
      status("busy", 1);
      vi.advanceTimersByTime(2000);
      status("ready", 1);
    }
    expect(fn).toHaveBeenCalledTimes(2);
    // Indexing that starts later is a new settle.
    vi.advanceTimersByTime(10_000);
    status("busy", 1);
    vi.advanceTimersByTime(5000);
    status("ready", 1);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("ignores short busy spells", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    settled(fn);
    status("busy", 2);
    vi.advanceTimersByTime(100);
    status("ready", 2);
    expect(fn).not.toHaveBeenCalled();
  });

  it("re-runs after the project loads right after a start, however briefly", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    settled(fn);
    status("starting", 3);
    status("ready", 3);
    expect(fn).toHaveBeenCalledTimes(1);
    // vtsls loads a small project in about a second; answers given meanwhile were partial.
    status("busy", 3);
    vi.advanceTimersByTime(1000);
    status("ready", 3);
    expect(fn).toHaveBeenCalledTimes(2);
    // Later short spells are requests again.
    status("busy", 3);
    vi.advanceTimersByTime(100);
    status("ready", 3);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("tells a callback added while the project loads that it has", () => {
    vi.useFakeTimers();
    settled(() => {});
    status("starting", 4);
    status("ready", 4);
    status("busy", 4);
    // An editor restored at launch mounts now.
    const fn = vi.fn();
    settled(fn);
    vi.advanceTimersByTime(800);
    status("ready", 4);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("ignores a short spell that begins well after a start", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    settled(fn);
    status("starting", 5);
    status("ready", 5);
    vi.advanceTimersByTime(10_000);
    status("busy", 5);
    vi.advanceTimersByTime(100);
    status("ready", 5);
    expect(fn).toHaveBeenCalledTimes(1);
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
