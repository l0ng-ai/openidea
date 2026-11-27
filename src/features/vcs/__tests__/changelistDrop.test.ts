import { describe, expect, it } from "vitest";
import type { FileStatus } from "@/bindings";
import { changedPathsUnder } from "../changes";

const file = (path: string, staged: FileStatus["staged"], unstaged: FileStatus["unstaged"]): FileStatus => ({
  path,
  relPath: path.replace(/^\/p\//, ""),
  staged,
  unstaged,
  renamedFrom: null,
});

describe("files dropped on a changelist", () => {
  const status = [
    file("/p/src/a.ts", null, "modified"),
    file("/p/src/sub/b.ts", null, "modified"),
    file("/p/new/n.txt", "added", null),
    file("/p/new/untracked.txt", null, "untracked"),
    file("/p/conflict.txt", null, "conflicted"),
  ];

  it("expands a dropped directory to the changed files below it", () => {
    expect(changedPathsUnder(["/p/new"], status)).toEqual(["/p/new/n.txt"]);
    expect(changedPathsUnder(["/p/src"], status)).toEqual(["/p/src/a.ts", "/p/src/sub/b.ts"]);
  });

  it("matches a single dropped file and ignores the trailing slash", () => {
    expect(changedPathsUnder(["/p/src/a.ts/"], status)).toEqual(["/p/src/a.ts"]);
  });

  it("leaves out unversioned and conflicted files", () => {
    expect(changedPathsUnder(["/p/new", "/p/conflict.txt"], status)).toEqual(["/p/new/n.txt"]);
  });

  it("finds nothing for paths that are not changed", () => {
    expect(changedPathsUnder(["/p/elsewhere"], status)).toEqual([]);
  });
});
