import { afterEach, describe, expect, it, vi } from "vitest";
import { startSampleOutput, subscribeOutput, useRun } from "./store";

describe("run output for other views", () => {
  afterEach(() => vi.useRealTimers());

  it("gives a subscriber the output so far, then each new chunk until it unsubscribes", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
    const done = startSampleOutput(40, 10);
    await vi.advanceTimersByTimeAsync(40);
    const session = useRun.getState().sessions.at(-1)!;
    // The sample has no process; give it one, as a started run gets.
    useRun.setState((s) => ({ sessions: s.sessions.map((x) => (x.id === session.id ? { ...x, runId: 7 } : x)) }));

    const seen: string[] = [];
    const unsubscribe = subscribeOutput(7, (kind, text) => seen.push(`${kind}:${text}`));
    const before = seen.length;
    expect(before).toBeGreaterThan(0);
    expect(seen.every((c) => c.endsWith("\n"))).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(seen.length).toBeGreaterThan(before);
    unsubscribe();
    const after = seen.length;
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(seen.length).toBe(after);
    // Every line arrived once: the snapshot and the stream don't overlap.
    const lines = seen.join("").split("\n").filter(Boolean);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("gives nothing for a process no session owns", () => {
    const seen: string[] = [];
    subscribeOutput(12345, (_, text) => seen.push(text))();
    expect(seen).toEqual([]);
  });
});
