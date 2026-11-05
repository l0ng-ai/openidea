import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetFilters, loadFilters, rememberFilter } from "./history";

const KEY = "openidea.logcat.filters";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
  forgetFilters();
});

afterEach(() => vi.unstubAllGlobals());

describe("filter history", () => {
  it("keeps the newest first without duplicates", () => {
    rememberFilter("tag:aa");
    rememberFilter("tag:bb");
    expect(loadFilters()).toEqual(["tag:bb", "tag:aa"]);
    expect(rememberFilter("  tag:aa ")).toEqual(["tag:aa", "tag:bb"]);
  });

  it("takes ↑/↓ order from the list and ignores an empty filter", () => {
    expect(rememberFilter("   ")).toEqual([]);
    for (let i = 0; i < 30; i++) rememberFilter(`tag:${i}`);
    const list = loadFilters();
    expect(list).toHaveLength(20);
    expect(list[0]).toBe("tag:29");
    expect(list.at(-1)).toBe("tag:10");
  });

  it("survives storage content that is not a list", () => {
    localStorage.setItem(KEY, "{not json");
    expect(loadFilters()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify([1, "", "tag:x"]));
    expect(loadFilters()).toEqual(["tag:x"]);
  });

  it("works when storage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadFilters()).toEqual([]);
    expect(rememberFilter("tag:aa")).toEqual(["tag:aa"]);
  });
});
