import { describe, expect, it } from "vitest";
import { foreground, foregroundStarted, inForeground, onForeground } from "./foreground";

describe("requests the user waits for before background requests", () => {
  it("reports the first foreground request starting and the last one finishing", () => {
    const seen: boolean[] = [];
    const off = onForeground((n) => seen.push(n));
    const a = foregroundStarted();
    const b = foregroundStarted();
    expect(inForeground()).toBe(true);
    a();
    a();
    expect(inForeground()).toBe(true);
    b();
    expect(inForeground()).toBe(false);
    expect(seen).toEqual([true, false]);
    off();
  });

  it("runs a request in the foreground until it settles, also when it fails", async () => {
    let fail!: (e: Error) => void;
    const running = foreground(() => new Promise((_, reject) => (fail = reject)));
    expect(inForeground()).toBe(true);
    fail(new Error("boom"));
    await expect(running).rejects.toThrow("boom");
    expect(inForeground()).toBe(false);
  });
});
