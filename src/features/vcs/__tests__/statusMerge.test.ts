import { describe, expect, it } from "vitest";
import type { FileStatus } from "@/bindings";
import { mergeStatus } from "../store";

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

  it("keeps entries outside the batch untouched", () => {
    const base = [file("/r/a", "a"), file("/r/z", "z")];
    expect(mergeStatus(base, ["/r/a"], [file("/r/a", "a", "added")]).map((f) => f.relPath)).toEqual(["a", "z"]);
  });
});
