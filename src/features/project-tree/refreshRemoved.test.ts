import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "@/bindings";
import { dropListings, planRefresh } from "./model";
import { isSameOrInside as realIsSameOrInside } from "@/platform/paths";

// Counts the path-helper calls `planRefresh` / `dropListings` make: the work they do must grow with
// loaded folders + removed paths, not with their product.
const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/platform/paths", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/paths")>();
  return {
    ...real,
    ipcPath: (p: string) => (calls.n++, real.ipcPath(p)),
    isSameOrInside: (p: string, a: string) => (calls.n++, real.isSameOrInside(p, a)),
  };
});

beforeEach(() => {
  calls.n = 0;
});

/** A balanced 8-ary tree of `count` folders under a deep project root, in breadth-first order. */
function folderTree(count: number): string[] {
  const dirs = ["/Users/dev/workspace/projects/acme/monorepo"];
  for (let i = 1; i < count; i++) dirs.push(`${dirs[Math.floor((i - 1) / 8)]}/package-${i}`);
  return dirs;
}

const D = 2000;
const dirs = folderTree(D);
const loaded = new Set(dirs);

describe("removed paths scale with loaded folders + removed paths", () => {
  // `rm -rf` of a loaded subtree: every folder below `dirs[1]` plus 5 files in each.
  const subtree = dirs.filter((d) => d === dirs[1] || d.startsWith(`${dirs[1]}/`));
  const loadedSubtree = subtree.flatMap((d) => [d, ...Array.from({ length: 5 }, (_, i) => `${d}/file-${i}.ts`)]);
  // The same size of removal below a folder the tree never loaded.
  const unloadedSubtree = Array.from(
    { length: loadedSubtree.length },
    (_, i) => `/Users/dev/workspace/other/dir-${i % 300}/file-${i}.ts`,
  );

  it.each([
    ["a loaded subtree", loadedSubtree],
    ["a subtree that was never loaded", unloadedSubtree],
  ])("planRefresh handles %s without testing every removed path against every folder", (_name, removed) => {
    expect(removed.length).toBeGreaterThan(D / 2);
    const plan = planRefresh({ created: [], modified: [], removed }, loaded);
    expect(calls.n).toBeLessThan(10 * (D + removed.length));
    expect(plan.drop.length).toBe(removed === loadedSubtree ? subtree.length : 0);
  });

  it("dropListings handles many dropped folders without a pairwise scan", () => {
    const listings = new Map<string, readonly FileEntry[]>(dirs.map((d) => [d, []]));
    dropListings(listings, subtree);
    expect(calls.n).toBeLessThan(10 * (D + subtree.length));
    expect(listings.size).toBe(D - subtree.length);
  });
});

// The pairwise semantics `planRefresh` / `dropListings` had before: a differential reference.
function referencePlan(
  event: { created: string[]; modified: string[]; removed: string[]; ignoreRules?: string[] },
  loaded: Set<string>,
) {
  const parentOf = (p: string) => {
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
  };
  const reload = new Set<string>();
  const drop = new Set<string>();
  for (const p of event.removed) {
    for (const dir of loaded) if (realIsSameOrInside(dir, p)) drop.add(dir);
    if (loaded.has(parentOf(p))) reload.add(parentOf(p));
  }
  for (const p of [...event.created, ...event.modified]) {
    if (loaded.has(parentOf(p))) reload.add(parentOf(p));
    if (loaded.has(p)) {
      reload.add(p);
      drop.delete(p);
    }
  }
  for (const dir of loaded) if (event.ignoreRules?.some((r) => realIsSameOrInside(dir, r))) reload.add(dir);
  for (const d of drop) reload.delete(d);
  return { reload: [...reload].sort(), drop: [...drop].sort() };
}

describe("planRefresh / dropListings keep the pairwise semantics", () => {
  const names = ["a", "ab", "a b", "A", "src", "Src", "x.y"];
  const roots = [
    "/",
    "/r",
    "/r/",
    "/ab",
    "C:/w",
    "C:\\w",
    "c:/w",
    "\\\\?\\C:\\w",
    "//srv/share",
    "\\\\srv\\share",
    "//?/UNC/srv/share",
  ];

  // Small deterministic generator so failures replay.
  const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

  function randomPath(next: () => number): string {
    const root = roots[Math.floor(next() * roots.length)]!;
    const sep = root.includes("\\") ? "\\" : "/";
    let p = root;
    for (let depth = Math.floor(next() * 4); depth > 0; depth--) {
      p += (p.endsWith("/") || p.endsWith("\\") ? "" : sep) + names[Math.floor(next() * names.length)]!;
    }
    return next() < 0.08 ? p + sep : p;
  }

  it("agrees with the pairwise implementation on random trees and batches", () => {
    const next = rng(7);
    for (let round = 0; round < 300; round++) {
      const loaded = new Set(Array.from({ length: 1 + Math.floor(next() * 25) }, () => randomPath(next)));
      const pick = (n: number) =>
        Array.from({ length: Math.floor(next() * n) }, () =>
          next() < 0.4 ? [...loaded][Math.floor(next() * loaded.size)]! : randomPath(next),
        );
      const event = {
        created: pick(4),
        modified: pick(4),
        removed: pick(6),
        ignoreRules: next() < 0.3 ? pick(2) : undefined,
      };
      const plan = planRefresh(event, loaded);
      const want = referencePlan(event, loaded);
      expect(
        { reload: [...plan.reload].sort(), drop: [...plan.drop].sort() },
        JSON.stringify([...loaded]) + JSON.stringify(event),
      ).toEqual(want);

      const listings = new Map<string, readonly FileEntry[]>([...loaded].map((d) => [d, []]));
      dropListings(listings, plan.drop);
      expect([...listings.keys()].sort()).toEqual(
        [...loaded].filter((d) => !plan.drop.some((x) => realIsSameOrInside(d, x))).sort(),
      );
    }
  });

  it("does not treat a sibling that shares a name prefix as inside", () => {
    const plan = planRefresh(
      { created: [], modified: [], removed: ["/a/a"] },
      new Set(["/a", "/a/a", "/a/ab", "/a/a/b"]),
    );
    expect([...plan.drop].sort()).toEqual(["/a/a", "/a/a/b"]);
    expect(plan.reload).toEqual(["/a"]);
  });

  it("drops everything when the filesystem root is removed", () => {
    const plan = planRefresh({ created: [], modified: [], removed: ["/"] }, new Set(["/", "/a", "/a/b"]));
    expect([...plan.drop].sort()).toEqual(["/", "/a", "/a/b"]);
  });

  it("reads Windows spellings of one folder as the same folder", () => {
    const plan = planRefresh(
      { created: [], modified: [], removed: ["C:\\w\\src"] },
      new Set(["C:/w", "C:/w/src", "C:/w/src/deep"]),
    );
    expect([...plan.drop].sort()).toEqual(["C:/w/src", "C:/w/src/deep"]);
  });
});
