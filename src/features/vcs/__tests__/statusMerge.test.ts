import { describe, expect, it } from "vitest";
import type { FileStatus } from "@/bindings";
import { mergeStatus, pairsRenames } from "../store";

const file = (
  path: string,
  relPath = path.slice("/r/".length),
  unstaged: FileStatus["unstaged"] = "modified",
): FileStatus => ({
  path,
  relPath,
  staged: null,
  unstaged,
  renamedFrom: null,
});

describe("mergeStatus", () => {
  it("replaces the entry of a path the batch re-read", () => {
    const merged = mergeStatus([file("/r/a", "a", "modified")], ["/r/a"], [file("/r/a", "a", "added")]);
    expect(merged).toEqual([file("/r/a", "a", "added")]);
  });

  it("drops a path that is no longer changed", () => {
    expect(mergeStatus([file("/r/a", "a")], ["/r/a"], [])).toEqual([]);
  });

  it("drops everything below a directory the batch names, as a removed directory arrives", () => {
    const base = [file("/r/dir/x", "dir/x"), file("/r/dir/y", "dir/y"), file("/r/keep", "keep")];
    expect(mergeStatus(base, ["/r/dir"], []).map((f) => f.relPath)).toEqual(["keep"]);
  });

  it("adds a file the batch found, in path order", () => {
    const base = [file("/r/b", "b")];
    const merged = mergeStatus(base, ["/r/a"], [file("/r/a", "a", "untracked")]);
    expect(merged.map((f) => f.relPath)).toEqual(["a", "b"]);
  });

  it("matches whole segments only, so a sibling name is not swallowed", () => {
    const base = [file("/r/src/a.txt.bak", "src/a.txt.bak")];
    expect(mergeStatus(base, ["/r/src/a.txt"], []).map((f) => f.relPath)).toEqual(["src/a.txt.bak"]);
  });

  it("replaces an entry the read answered for even when the batch did not name it", () => {
    const merged = mergeStatus(
      [file("/r/a[1]"), file("/r/a1")],
      ["/r/a[1]"],
      [file("/r/a[1]"), file("/r/a1", "a1", "added")],
    );
    expect(merged.map((f) => [f.relPath, f.unstaged])).toEqual([
      ["a1", "added"],
      ["a[1]", "modified"],
    ]);
  });

  it("keeps entries outside the batch untouched", () => {
    const base = [file("/r/a", "a"), file("/r/z", "z")];
    expect(mergeStatus(base, ["/r/a"], [file("/r/a", "a", "added")]).map((f) => f.relPath)).toEqual(["a", "z"]);
  });
});

describe("pairsRenames", () => {
  const staged = (path: string, kind: FileStatus["staged"], renamedFrom: string | null = null): FileStatus => ({
    ...file(path),
    staged: kind,
    unstaged: null,
    renamedFrom,
  });

  it("takes the full status when the batch touches either side of a staged rename", () => {
    const base = [staged("/r/b.txt", "renamed", "a.txt")];
    // `git status -- b.txt` reports the rename's target as an addition and drops `a.txt`.
    expect(pairsRenames(base, ["/r/b.txt"], [staged("/r/b.txt", "added")])).toBe(true);
    expect(pairsRenames(base, ["/r/a.txt"], [])).toBe(true);
    expect(pairsRenames(base, ["/r"], [])).toBe(true);
  });

  it("takes the full status when the read itself reports a rename", () => {
    expect(pairsRenames([], ["/r/b.txt", "/r/a.txt"], [staged("/r/b.txt", "renamed", "a.txt")])).toBe(true);
  });

  it("takes the full status when an addition and a deletion could pair across the batch", () => {
    expect(pairsRenames([staged("/r/old.txt", "deleted")], ["/r/new.txt"], [staged("/r/new.txt", "added")])).toBe(true);
    expect(pairsRenames([staged("/r/new.txt", "added")], ["/r/old.txt"], [staged("/r/old.txt", "deleted")])).toBe(true);
  });

  it("keeps the scoped read for plain edits", () => {
    const base = [staged("/r/b.txt", "renamed", "a.txt"), file("/r/c.txt")];
    expect(pairsRenames(base, ["/r/c.txt"], [file("/r/c.txt")])).toBe(false);
    expect(pairsRenames([staged("/r/new.txt", "added")], ["/r/new.txt"], [staged("/r/new.txt", "added")])).toBe(false);
  });
});
