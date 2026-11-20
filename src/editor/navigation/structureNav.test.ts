import { describe, expect, it } from "vitest";
import type { HierarchyItem, OutlineItem, SymbolKind } from "@/platform/ipc";
import { memberAt, methodStop, methodStops, superMethods, topLevelTypeAt } from "./structureNav";

const r = (l1: number, l2: number) => ({ start: { line: l1, col: 0 }, end: { line: l2, col: 1 } });
function item(name: string, kind: SymbolKind, from: number, to: number, children: OutlineItem[] = []): OutlineItem {
  return {
    name,
    kind,
    detail: null,
    range: r(from, to),
    selection_range: { start: { line: from, col: 4 }, end: { line: from, col: 4 + name.length } },
    children,
  };
}

const OUTLINE = [
  item("Foo", "class", 0, 20, [
    item("x", "field", 1, 1),
    item("a", "method", 2, 5),
    item("b", "method", 7, 9),
    item("Inner", "class", 11, 18, [item("c", "method", 12, 14)]),
  ]),
  item("main", "function", 22, 25),
];

describe("Next / Previous Method", () => {
  it("stops at methods and types in document order", () => {
    expect(methodStops(OUTLINE).map((p) => p.line)).toEqual([0, 2, 7, 11, 12, 22]);
  });

  it("moves by line", () => {
    expect(methodStop(OUTLINE, { line: 3, col: 0 }, 1)?.line).toBe(7);
    expect(methodStop(OUTLINE, { line: 7, col: 0 }, 1)?.line).toBe(11);
    expect(methodStop(OUTLINE, { line: 7, col: 8 }, -1)?.line).toBe(7);
    expect(methodStop(OUTLINE, { line: 7, col: 2 }, -1)?.line).toBe(2);
    expect(methodStop(OUTLINE, { line: 0, col: 0 }, -1)).toBeNull();
    expect(methodStop(OUTLINE, { line: 23, col: 0 }, 1)).toBeNull();
  });
});

describe("Super Method", () => {
  it("finds the method and type at the caret", () => {
    expect(memberAt(OUTLINE, { line: 13, col: 2 })).toMatchObject({ method: { name: "c" }, type: { name: "Inner" } });
    expect(memberAt(OUTLINE, { line: 10, col: 0 })).toMatchObject({ method: null, type: { name: "Foo" } });
    expect(memberAt(OUTLINE, { line: 23, col: 0 })).toMatchObject({ method: { name: "main" }, type: null });
  });

  it("looks for the method in supertypes, level by level", async () => {
    const hier = (name: string, path: string, line: number): HierarchyItem => ({
      name,
      kind: "class",
      detail: null,
      path,
      range: r(line, line + 10),
      selectionRange: { start: { line, col: 4 }, end: { line, col: 7 } },
      fromRanges: [],
    });
    const outlines: Record<string, OutlineItem[]> = {
      "/Base.java": [item("Base", "class", 0, 10, [item("other", "method", 2, 3)])],
      "/Root.java": [item("Root", "interface", 0, 10, [item("a", "method", 4, 4)])],
    };
    const supers: Record<string, HierarchyItem[]> = {
      "/Foo.java": [hier("Base", "/Base.java", 0)],
      "/Base.java": [hier("Root", "/Root.java", 0)],
    };
    const deps = {
      supertypes: async (path: string) => supers[path] ?? [],
      outline: async (path: string) => outlines[path] ?? [],
    };
    expect(await superMethods("/Foo.java", { line: 0, col: 4 }, "a", deps)).toEqual([
      { path: "/Root.java", range: { start: { line: 4, col: 4 }, end: { line: 4, col: 5 } } },
    ]);
    expect(await superMethods("/Foo.java", { line: 0, col: 4 }, "missing", deps)).toEqual([]);
    // jdtls names methods with their parameters.
    expect(await superMethods("/Foo.java", { line: 0, col: 4 }, "a() : void", deps)).toHaveLength(1);
  });

  it("prefers the overload with the same signature", async () => {
    const base: HierarchyItem = {
      name: "Base",
      kind: "class",
      detail: null,
      path: "/Base.java",
      range: r(0, 10),
      selectionRange: { start: { line: 0, col: 4 }, end: { line: 0, col: 8 } },
      fromRanges: [],
    };
    const deps = {
      supertypes: async (path: string) => (path === "/Foo.java" ? [base] : []),
      outline: async () => [
        item("Base", "class", 0, 10, [item("eat(String)", "method", 2, 2), item("eat(int)", "method", 4, 4)]),
      ],
    };
    const lines = async (name: string) =>
      (await superMethods("/Foo.java", { line: 0, col: 4 }, name, deps)).map((l) => l.range.start.line);
    expect(await lines("eat(int)")).toEqual([4]);
    // Without a matching signature (or without signatures at all), every overload.
    expect(await lines("eat(T)")).toEqual([2, 4]);
    expect(await lines("eat")).toEqual([2, 4]);
  });
});

describe("topLevelTypeAt", () => {
  it("answers the outermost type, through namespaces, and nothing outside a type", () => {
    expect(topLevelTypeAt(OUTLINE, { line: 13, col: 2 })?.name).toBe("Foo");
    expect(topLevelTypeAt(OUTLINE, { line: 23, col: 0 })).toBeNull();
    const ns = [item("App", "namespace", 0, 30, [item("Widget", "class", 1, 10), item("Helper", "class", 12, 20)])];
    expect(topLevelTypeAt(ns, { line: 15, col: 0 })?.name).toBe("Helper");
  });
});
