import { beforeEach, describe, expect, it } from "vitest";
import { addWatch, loadWatches, useDebug } from "../state";

const SHARED = "openidea.debugger.watches";
const of = (root: string) => `${SHARED}:${root}`;
const watches = () => useDebug.getState().watches;

beforeEach(() => {
  localStorage.clear();
  loadWatches(null);
});

describe("watch storage", () => {
  it("loads a project's own watches", () => {
    localStorage.setItem(of("/a"), '["x"]');
    loadWatches("/a");
    expect(watches()).toEqual(["x"]);
  });

  it("starts a project from the shared list once", () => {
    localStorage.setItem(SHARED, '["legacy"]');
    loadWatches("/b");
    expect(watches()).toEqual(["legacy"]);
    expect(localStorage.getItem(of("/b"))).toBe('["legacy"]');
    expect(localStorage.getItem(SHARED)).toBe('["legacy"]');
  });

  it("keeps projects apart", () => {
    loadWatches("/a");
    addWatch("y");
    loadWatches("/b");
    expect(watches()).not.toContain("y");
    loadWatches("/a");
    expect(watches()).toContain("y");
  });

  it("an emptied list stays empty", () => {
    localStorage.setItem(SHARED, '["legacy"]');
    localStorage.setItem(of("/a"), "[]");
    loadWatches("/a");
    expect(watches()).toEqual([]);
  });

  it("without a project nothing is stored", () => {
    loadWatches(null);
    addWatch("z");
    expect(localStorage.length).toBe(0);
  });
});
