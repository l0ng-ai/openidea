import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { moveServiceOrder, orderServices, readServiceOrder, saveServiceOrder, useServiceOrder } from "./serviceOrder";

beforeEach(() => localStorage.clear());

describe("service display order", () => {
  it("orders known IDs, appends new ones and leaves configurations untouched", () => {
    const entries = [{ id: "gateway" }, { id: "portal" }, { id: "new" }];
    expect(orderServices(entries, ["gone", "portal", "gateway"]).map((x) => x.id)).toEqual([
      "portal",
      "gateway",
      "new",
    ]);
    expect(entries.map((x) => x.id)).toEqual(["gateway", "portal", "new"]);
  });

  it("moves before or after the target while retaining temporarily hidden IDs", () => {
    expect(moveServiceOrder(["a", "hidden", "b"], ["a", "b", "new"], "b", "a", "before")).toEqual([
      "b",
      "a",
      "hidden",
      "new",
    ]);
    expect(moveServiceOrder([], ["a", "b", "c"], "a", "b", "after")).toEqual(["b", "a", "c"]);
  });

  it("ignores missing, self and stale drop targets", () => {
    for (const [source, target] of [
      ["a", "a"],
      ["gone", "b"],
      ["a", "gone"],
    ]) {
      expect(moveServiceOrder(["b", "a"], ["a", "b"], source!, target!, "before")).toEqual(["b", "a"]);
    }
  });
});

describe("service order storage", () => {
  it("isolates project locations and normalizes malformed records and duplicate IDs", () => {
    localStorage.setItem(
      "openidea.services.runOrder:/app",
      JSON.stringify({ npm: ["b", "b", 4, "", "a"], python: null }),
    );
    expect(readServiceOrder("/app")).toEqual({ npm: ["b", "a"] });
    expect(readServiceOrder("ssh://other/app")).toEqual({});
    localStorage.setItem("openidea.services.runOrder:/app", "broken");
    expect(readServiceOrder("/app")).toEqual({});
    localStorage.setItem("openidea.services.runOrder:/app", "[]");
    expect(readServiceOrder("/app")).toEqual({});
  });

  it("continues with default order when storage cannot be read", () => {
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      expect(readServiceOrder("/denied")).toEqual({});
    } finally {
      read.mockRestore();
    }
  });

  it("updates mounted views, survives remounts, and reads changes from other windows", () => {
    const { result, unmount } = renderHook(() => useServiceOrder("/persist"));
    act(() => {
      saveServiceOrder("/persist", { npm: ["b", "a"] });
    });
    expect(result.current).toEqual({ npm: ["b", "a"] });
    unmount();
    const next = renderHook(() => useServiceOrder("/persist"));
    expect(next.result.current).toEqual({ npm: ["b", "a"] });
    act(() => {
      localStorage.setItem("openidea.services.runOrder:/persist", '{"npm":["a","b"]}');
      window.dispatchEvent(
        new StorageEvent("storage", { key: "openidea.services.runOrder:/persist", storageArea: localStorage }),
      );
    });
    expect(next.result.current).toEqual({ npm: ["a", "b"] });
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
    });
    expect(next.result.current).toEqual({});
  });

  it("switches projects without leaking the previous project's order", () => {
    saveServiceOrder("/one", { npm: ["b", "a"] });
    saveServiceOrder("/two", { python: ["y", "x"] });
    const { result, rerender } = renderHook(({ location }) => useServiceOrder(location), {
      initialProps: { location: "/one" },
    });
    expect(result.current).toEqual({ npm: ["b", "a"] });
    rerender({ location: "/two" });
    expect(result.current).toEqual({ python: ["y", "x"] });
  });

  it("keeps the in-memory order when writing storage fails", () => {
    const { result, unmount } = renderHook(() => useServiceOrder("/unavailable"));
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    try {
      act(() => {
        expect(saveServiceOrder("/unavailable", { npm: ["b", "a"] })).toBe(false);
      });
      expect(result.current).toEqual({ npm: ["b", "a"] });
      unmount();
      const next = renderHook(() => useServiceOrder("/unavailable"));
      expect(next.result.current).toEqual({ npm: ["b", "a"] });
    } finally {
      write.mockRestore();
    }
  });
});
