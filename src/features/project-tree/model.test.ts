import { describe, expect, it } from "vitest";
import type { FileEntry } from "@/bindings";
import {
  DEFAULT_TREE_OPTIONS,
  buildModel,
  mergeListing,
  nodeKeyFor,
  planRefresh,
  visibleEntries,
  visibleInfo,
  type Listings,
  type TreeOptions,
} from "./model";

const entry = (path: string, kind: "file" | "dir" = "file", extra: Partial<FileEntry> = {}): FileEntry => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    name,
    path,
    kind,
    size: 0,
    mtimeMs: 1,
    ignored: false,
    excluded: false,
    hidden: name.startsWith("."),
    ...extra,
  };
};

const ROOT = { path: "/r", name: "acme" };

function listings(map: Record<string, FileEntry[]>): Map<string, FileEntry[]> {
  return new Map(Object.entries(map));
}

const labels = (model: ReturnType<typeof buildModel>, key: string) =>
  (model.children.get(key) ?? []).map((n) => n.label);

describe("buildModel", () => {
  const base: Listings = listings({
    "/r": [
      entry("/r/src", "dir"),
      entry("/r/build", "dir", { ignored: true }),
      entry("/r/.git", "dir", { hidden: true }),
      entry("/r/.gitignore"),
      entry("/r/README.md"),
    ],
  });

  it("builds lazily: only loaded folders have children", () => {
    const m = buildModel(ROOT, base, DEFAULT_TREE_OPTIONS);
    expect(m.roots).toHaveLength(1);
    expect(m.roots[0]).toMatchObject({ key: "/r", label: "acme", root: true, dir: true });
    expect(labels(m, "/r")).toEqual(["src", "build", ".gitignore", "README.md"]);
    expect(m.children.has("/r/src")).toBe(false);
    expect(m.byKey.get("/r/build")?.ignored).toBe(true);
  });

  it("filters IDE-hidden names and excluded entries by option", () => {
    const opts: TreeOptions = { ...DEFAULT_TREE_OPTIONS, showHidden: true, showExcluded: false };
    expect(labels(buildModel(ROOT, base, opts), "/r")).toEqual(["src", ".git", ".gitignore", "README.md"]);
  });

  it("sorts names naturally, optionally mixing folders and files", () => {
    const l = listings({
      "/r": [entry("/r/b", "dir"), entry("/r/a10.txt"), entry("/r/a2.txt"), entry("/r/c.txt")],
    });
    expect(labels(buildModel(ROOT, l, DEFAULT_TREE_OPTIONS), "/r")).toEqual(["b", "a10.txt", "a2.txt", "c.txt"]);
    const mixed = buildModel(ROOT, l, { ...DEFAULT_TREE_OPTIONS, foldersFirst: false });
    expect(labels(mixed, "/r")).toEqual(["a2.txt", "a10.txt", "b", "c.txt"]);
  });

  describe("compact middle packages", () => {
    const chain = listings({
      "/r": [entry("/r/src", "dir"), entry("/r/README.md")],
      "/r/src": [entry("/r/src/main", "dir")],
      "/r/src/main": [entry("/r/src/main/kotlin", "dir")],
      "/r/src/main/kotlin": [entry("/r/src/main/kotlin/com", "dir")],
      "/r/src/main/kotlin/com": [entry("/r/src/main/kotlin/com/acme", "dir")],
      "/r/src/main/kotlin/com/acme": [entry("/r/src/main/kotlin/com/acme/orders", "dir")],
      "/r/src/main/kotlin/com/acme/orders": [
        entry("/r/src/main/kotlin/com/acme/orders/model", "dir"),
        entry("/r/src/main/kotlin/com/acme/orders/Order.kt"),
      ],
    });

    it("merges single-folder chains, ending at source roots, packages joined with '.'", () => {
      const m = buildModel(ROOT, chain, DEFAULT_TREE_OPTIONS);
      expect(labels(m, "/r")).toEqual(["src/main/kotlin", "README.md"]);
      const node = m.byKey.get("/r/src")!;
      expect(node.path).toBe("/r/src/main/kotlin");
      expect(node.chain).toHaveLength(3);
      expect(labels(m, "/r/src")).toEqual(["com.acme.orders"]);
      const pkg = m.byKey.get("/r/src/main/kotlin/com")!;
      expect(pkg.path).toBe("/r/src/main/kotlin/com/acme/orders");
      expect(labels(m, pkg.key)).toEqual(["model", "Order.kt"]);
      // Every merged folder resolves to its chain node.
      expect(m.keyOfPath.get("/r/src/main")).toBe("/r/src");
      expect(m.keyOfPath.get("/r/src/main/kotlin/com/acme")).toBe("/r/src/main/kotlin/com");
      expect(nodeKeyFor(m, "/r/src/main/kotlin/com/acme/orders/Order.kt")).toBe(
        "/r/src/main/kotlin/com/acme/orders/Order.kt",
      );
    });

    it("uses '.' for chains below a JVM source folder", () => {
      const l = new Map(chain);
      l.set("/r/src/main/kotlin", [entry("/r/src/main/kotlin/com", "dir"), entry("/r/src/main/kotlin/App.kt")]);
      const m = buildModel(ROOT, l, DEFAULT_TREE_OPTIONS);
      expect(labels(m, "/r")).toEqual(["src/main/kotlin", "README.md"]);
      expect(labels(m, "/r/src")).toEqual(["com.acme.orders", "App.kt"]);
    });

    it("stops at unloaded folders and can be switched off", () => {
      const l = listings({ "/r": [entry("/r/a", "dir")], "/r/a": [entry("/r/a/b", "dir")] });
      expect(labels(buildModel(ROOT, l, DEFAULT_TREE_OPTIONS), "/r")).toEqual(["a/b"]);
      expect(labels(buildModel(ROOT, l, { ...DEFAULT_TREE_OPTIONS, compact: false }), "/r")).toEqual(["a"]);
    });

    it("does not merge across excluded boundaries or into a folder being edited", () => {
      const l = listings({
        "/r": [entry("/r/a", "dir")],
        "/r/a": [entry("/r/a/out", "dir", { ignored: true })],
        "/r/a/out": [entry("/r/a/out/x", "dir", { ignored: true })],
      });
      expect(labels(buildModel(ROOT, l, DEFAULT_TREE_OPTIONS), "/r")).toEqual(["a"]);
      expect(labels(buildModel(ROOT, l, DEFAULT_TREE_OPTIONS), "/r/a")).toEqual(["out/x"]);
      const editing = buildModel(ROOT, l, DEFAULT_TREE_OPTIONS, { parent: "/r/a/out", kind: "file" });
      expect(labels(editing, "/r/a")).toEqual(["out"]);
    });
  });

  it("inserts the inline-editor placeholder first in the target folder", () => {
    const m = buildModel(ROOT, base, DEFAULT_TREE_OPTIONS, { parent: "/r", kind: "file" });
    const kids = m.children.get("/r")!;
    expect(kids[0]).toMatchObject({ placeholder: "file", path: "/r" });
    expect(kids).toHaveLength(5);
  });
});

describe("visibleInfo", () => {
  it("reports visible rows and expanded folders still to load", () => {
    const l = listings({ "/r": [entry("/r/a", "dir"), entry("/r/b", "dir"), entry("/r/f.txt")] });
    const m = buildModel(ROOT, l, { ...DEFAULT_TREE_OPTIONS, compact: false });
    const info = visibleInfo(m, new Set(["/r", "/r/a"]));
    expect([...info.visible]).toEqual(["/r", "/r/a", "/r/b", "/r/f.txt"]);
    expect(info.pending).toEqual(["/r/a"]);
    expect(visibleInfo(m, new Set()).visible.size).toBe(1);
    expect(visibleInfo(m, new Set()).pending).toEqual([]);
    expect(visibleInfo(buildModel(ROOT, new Map(), DEFAULT_TREE_OPTIONS), new Set(["/r"])).pending).toEqual(["/r"]);
  });
});

describe("planRefresh", () => {
  const loaded = new Set(["/r", "/r/src", "/r/src/deep", "/r/docs"]);

  it("reloads only the loaded parents of changed paths", () => {
    const plan = planRefresh({ created: ["/r/src/New.kt", "/r/unloaded/x"], modified: [], removed: [] }, loaded);
    expect(plan.reload).toEqual(["/r/src"]);
    expect(plan.drop).toEqual([]);
  });

  it("drops removed folders with their loaded descendants", () => {
    const plan = planRefresh({ created: [], modified: [], removed: ["/r/src"] }, loaded);
    expect(plan.drop.sort()).toEqual(["/r/src", "/r/src/deep"]);
    expect(plan.reload).toEqual(["/r"]);
  });

  it("handles renames (removed + created) and folders reported themselves", () => {
    const plan = planRefresh({ created: ["/r/docs2"], modified: ["/r/docs"], removed: ["/r/src/deep"] }, loaded);
    expect(plan.reload.sort()).toEqual(["/r", "/r/docs", "/r/src"]);
    expect(plan.drop).toEqual(["/r/src/deep"]);
  });

  it("keeps a folder that was removed and recreated in the same batch", () => {
    const plan = planRefresh({ created: ["/r/docs"], modified: [], removed: ["/r/docs"] }, loaded);
    expect(plan.drop).toEqual([]);
    expect(plan.reload.sort()).toEqual(["/r", "/r/docs"]);
  });
});

describe("mergeListing", () => {
  it("returns the previous array when nothing changed and keeps unchanged entries", () => {
    const a = entry("/r/a"),
      b = entry("/r/b");
    const prev = [a, b];
    expect(mergeListing(prev, [entry("/r/a"), entry("/r/b")])).toBe(prev);
    const next = mergeListing(prev, [entry("/r/a"), entry("/r/b", "file", { size: 9 }), entry("/r/c")]);
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(a);
    expect(next[1]).not.toBe(b);
    expect(next).toHaveLength(3);
    expect(mergeListing(undefined, prev)).toBe(prev);
  });
});

describe("visibleEntries sorting", () => {
  const files = [
    entry("/r/b.ts", "file", { mtimeMs: 30 }),
    entry("/r/a.md", "file", { mtimeMs: 10 }),
    entry("/r/c.md", "file", { mtimeMs: 20 }),
    entry("/r/src", "dir", { mtimeMs: 5 }),
  ];
  const names = (sortBy: TreeOptions["sortBy"], foldersFirst = true) =>
    visibleEntries(files, { ...DEFAULT_TREE_OPTIONS, sortBy, foldersFirst }).map((e) => e.name);

  it("sorts by type, then name, folders first", () => {
    expect(names("type")).toEqual(["src", "a.md", "c.md", "b.ts"]);
  });

  it("sorts by modification time, newest first", () => {
    expect(names("modified")).toEqual(["src", "b.ts", "c.md", "a.md"]);
    expect(names("modified", false)).toEqual(["b.ts", "c.md", "a.md", "src"]);
  });
});
