import { describe, expect, it } from "vitest";
import { buildFileTree, dirKeys } from "../fileTree";

describe("buildFileTree", () => {
  it("groups by directory, merges single-child chains and counts files", () => {
    const tree = buildFileTree(["src/app/a.ts", "src/app/b.ts", "README.md", "docs/x/y/z.md"], (p) => p);
    expect(tree.map((n) => n.name)).toEqual(["docs/x/y", "src/app", "README.md"]);
    expect(tree[1]!.count).toBe(2);
    expect(tree[1]!.children.map((c) => c.name)).toEqual(["a.ts", "b.ts"]);
    expect(dirKeys(tree)).toEqual(["d:docs/x/y", "d:src/app"]);
  });

  it("retains explicit empty directories and their entries for subtree operations", () => {
    const entries = [
      { path: "empty", dir: true },
      { path: "src", dir: true },
      { path: "src/nested", dir: true },
      { path: "src/nested/a", dir: false },
    ];
    const tree = buildFileTree(
      entries,
      (e) => e.path,
      (e) => e.dir,
    );
    expect(tree[0]).toMatchObject({ name: "empty", directory: entries[0], children: [], count: 0 });
    expect(tree[1]).toMatchObject({ name: "src", directory: entries[1] });
    expect(tree[1]!.children[0]).toMatchObject({ name: "nested", directory: entries[2] });
  });
});
