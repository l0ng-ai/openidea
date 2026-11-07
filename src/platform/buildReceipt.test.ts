import { describe, expect, it, vi, afterEach } from "vitest";
import { clearProjectBuild, consumeProjectBuild, recordProjectBuild } from "./buildReceipt";

afterEach(() => vi.useRealTimers());

describe("Before launch build receipt", () => {
  it("stays valid for the same project until a new top-level launch clears it", () => {
    recordProjectBuild("/p");
    expect(consumeProjectBuild("/p")).toBe(true);
    expect(consumeProjectBuild("/p")).toBe(true);
    clearProjectBuild();
    expect(consumeProjectBuild("/p")).toBe(false);
  });

  it("does not cover another project", () => {
    recordProjectBuild("/p");
    expect(consumeProjectBuild("/other")).toBe(false);
    expect(consumeProjectBuild("/p")).toBe(true);
  });

  it("expires", () => {
    vi.useFakeTimers();
    recordProjectBuild("/p");
    vi.advanceTimersByTime(31_000);
    expect(consumeProjectBuild("/p")).toBe(false);
  });
});
