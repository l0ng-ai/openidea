import { describe, expect, it } from "vitest";
import { chainNeighbour, revisionChangeDiffData, withChain, type DiffData } from "../diffInput";

const diff = (path: string): DiffData => ({ path, left: { type: "rev", rev: "HEAD" }, right: { type: "worktree" } });

describe("diff chain", () => {
  const items = [diff("/r/a"), diff("/r/b"), diff("/r/c")];

  it("moves to the neighbouring file, revealing the nearest difference", () => {
    const b = withChain(items, 1);
    expect(b.path).toBe("/r/b");
    const next = chainNeighbour(b, 1)!;
    expect(next).toMatchObject({ path: "/r/c", reveal: "first" });
    expect(chainNeighbour(b, -1)).toMatchObject({ path: "/r/a", reveal: "last" });
    // The neighbour keeps the chain, so F7 can continue from it.
    expect(chainNeighbour(next, -1)).toMatchObject({ path: "/r/b" });
  });

  it("stops at the ends and without a chain", () => {
    expect(chainNeighbour(withChain(items, 2), 1)).toBeNull();
    expect(chainNeighbour(withChain(items, 0), -1)).toBeNull();
    expect(chainNeighbour(withChain([diff("/r/a")], 0), 1)).toBeNull();
    expect(chainNeighbour(diff("/r/a"), 1)).toBeNull();
  });
});

describe("combined changes of several commits", () => {
  const base = { oldPath: null, before: "b".repeat(40), after: "a".repeat(40) };

  it("diffs the state before the first commit with the state after the last", () => {
    expect(revisionChangeDiffData({ ...base, path: "src/x.ts", kind: "modified" })).toMatchObject({
      path: "src/x.ts",
      left: { type: "rev", rev: base.before, label: "bbbbbbbb" },
      right: { type: "rev", rev: base.after, label: "aaaaaaaa" },
    });
  });

  it("reads a renamed file's old content at its old path", () => {
    const d = revisionChangeDiffData({ ...base, path: "new.ts", oldPath: "old.ts", kind: "renamed" });
    expect(d.left).toMatchObject({ type: "rev", rev: base.before, path: "old.ts" });
  });

  it("shows an empty side for added and deleted files", () => {
    const added = revisionChangeDiffData({ ...base, path: "n.ts", kind: "added", before: null });
    expect(added.left).toMatchObject({ type: "text", text: "" });
    const deleted = revisionChangeDiffData({ ...base, path: "d.ts", kind: "deleted", after: null });
    expect(deleted.right).toMatchObject({ type: "text", text: "" });
  });
});
