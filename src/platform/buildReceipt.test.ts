import { describe, expect, it, vi, afterEach } from "vitest";
import { consumeProjectBuild, recordProjectBuild } from "./buildReceipt";

afterEach(() => vi.useRealTimers());

describe("Before launch build receipt", () => {
  it("is consumed once by the same project", () => {
    recordProjectBuild("/p");
    expect(consumeProjectBuild("/p")).toBe(true);
    expect(consumeProjectBuild("/p")).toBe(false);
  });

  it("does not cover another project", () => {
    recordProjectBuild("/p");
    expect(consumeProjectBuild("/other")).toBe(false);
    expect(consumeProjectBuild("/p")).toBe(false);
  });

  it("expires", () => {
    vi.useFakeTimers();
    recordProjectBuild("/p");
    vi.advanceTimersByTime(31_000);
    expect(consumeProjectBuild("/p")).toBe(false);
  });
});
