import { afterEach, describe, expect, it, vi } from "vitest";
import { startSampleOutput, useRun } from "./store";

describe("console output", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a flood of output at most every 50 ms, a first line on the next frame", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
    const updates: number[] = [];
    const stop = useRun.subscribe((s, prev) => {
      if (s.versions !== prev.versions) updates.push(performance.now());
    });
    // 60 frames of output, 10 lines each.
    const done = startSampleOutput(600, 10);
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    stop();
    const session = useRun.getState().sessions.at(-1)!;
    expect(session.status).not.toBe("running");
    // Creating the session; the first lines (enqueued a frame later) on the next frame; then every ≥ 50 ms.
    expect(updates[1]! - updates[0]!).toBeLessThanOrEqual(34);
    const gaps = updates.slice(2, -2).map((t, i) => t - updates[i + 1]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(50);
    expect(updates.length).toBeLessThan(30);
  });
});
