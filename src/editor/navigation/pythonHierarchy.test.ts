import { describe, expect, it } from "vitest";
import type { ClassInheritance, OutlineItem } from "@/platform/ipc";
import { superMethods } from "./structureNav";
import {
  classAt,
  classItem,
  isPythonPath,
  pythonAncestors,
  pythonDescendants,
  pythonHierarchy,
  pythonImplementationTargets,
  pythonSuperDeps,
  pythonSupertypes,
} from "./pythonHierarchy";

const cls = (path: string, line: number, name: string, bases: string[] = []): ClassInheritance => ({
  path,
  line,
  col: 6,
  name,
  bases,
});

// `from .animal import Base` in dog.py: two modules declare a `Base`, the import picks one.
const GRAPH = [
  cls("/p/animal.py", 0, "Base"),
  cls("/p/other.py", 0, "Base"),
  cls("/p/living.py", 0, "Living"),
  cls("/p/dog.py", 2, "Dog", ["Base"]),
  cls("/p/puppy.py", 4, "Puppy", ["Dog"]),
];
const FILES: Record<string, string[]> = {
  "/p/dog.py": ["from .animal import Base", "", "class Dog(Base):", "    def bark(self):\n", "        pass\n"],
};

const hierarchy = pythonHierarchy(GRAPH, {
  readFiles: async (paths) => new Map(paths.map((p) => [p, FILES[p] ?? null])),
  // `.animal` names the animal module, as the backend's module resolver would.
  moduleFile: async (module) => (module === ".animal" ? "/p/animal.py" : null),
});

const item = (name: string, kind: OutlineItem["kind"], start: number, end: number, children: OutlineItem[] = []) => ({
  name,
  detail: null,
  kind,
  range: { start: { line: start, col: 0 }, end: { line: end, col: 1 } },
  selection_range: { start: { line: start, col: 6 }, end: { line: start, col: 6 + name.length } },
  children,
});

const OUTLINES: Record<string, OutlineItem[]> = {
  "/p/dog.py": [item("Dog", "class", 2, 6, [item("bark", "method", 3, 4)])],
  "/p/animal.py": [item("Base", "class", 0, 5, [item("bark", "method", 1, 2), item("eat", "method", 3, 4)])],
  "/p/living.py": [item("Living", "class", 0, 5, [item("age", "field", 1, 2)])],
  "/p/puppy.py": [item("Puppy", "class", 4, 9, [item("bark", "method", 5, 6)])],
};
const outlineOf = async (path: string) => OUTLINES[path] ?? [];

describe("Python inheritance graph helpers", () => {
  it("knows Python sources and finds the class declared at a position", () => {
    expect(isPythonPath("/p/dog.py")).toBe(true);
    expect(isPythonPath("/p/dog.pyi")).toBe(true);
    expect(isPythonPath("/p/Dog.java")).toBe(false);
    expect(classAt(hierarchy, "/p/dog.py", { line: 2, col: 6 })?.name).toBe("Dog");
    expect(classAt(hierarchy, "/p/dog.py", { line: 2, col: 0 })?.name).toBe("Dog");
    expect(classAt(hierarchy, "/p/dog.py", { line: 7, col: 6 })).toBeNull();
  });

  it("resolves an ambiguous base name through the file's imports", async () => {
    const dog = classAt(hierarchy, "/p/dog.py", { line: 2, col: 6 })!;
    expect((await pythonSupertypes(hierarchy, dog)).map((c) => c.path)).toEqual(["/p/animal.py"]);
    expect((await pythonAncestors(hierarchy, dog)).map((c) => c.name)).toEqual(["Base"]);
    // A Base in another module is no supertype of Dog.
    const other = classAt(hierarchy, "/p/other.py", { line: 0, col: 6 })!;
    expect(await pythonDescendants(hierarchy, other)).toEqual([]);
  });

  it("lists every descendant level by level", async () => {
    const base = classAt(hierarchy, "/p/animal.py", { line: 0, col: 6 })!;
    expect((await pythonDescendants(hierarchy, base)).map((c) => c.name)).toEqual(["Dog", "Puppy"]);
  });

  it("shapes graph classes as hierarchy items at their name", () => {
    const dog = classAt(hierarchy, "/p/dog.py", { line: 2, col: 6 })!;
    expect(classItem(dog)).toMatchObject({
      name: "Dog",
      kind: "class",
      path: "/p/dog.py",
      selectionRange: { start: { line: 2, col: 6 }, end: { line: 2, col: 9 } },
    });
  });
});

describe("Python Super Method", () => {
  it("finds the nearest super method through the graph's supertypes", async () => {
    const deps = pythonSuperDeps(hierarchy, outlineOf);
    const locs = await superMethods("/p/dog.py", { line: 2, col: 6 }, "bark", deps);
    // Dog inherits from Base, which declares bark.
    expect(locs.map((l) => `${l.path}:${l.range.start.line}`)).toEqual(["/p/animal.py:1"]);
  });

  it("answers the super class of a type with no method at the caret", async () => {
    const items = await pythonSuperDeps(hierarchy, outlineOf).supertypes("/p/dog.py", { line: 2, col: 6 });
    expect(items.map((i) => i.name)).toEqual(["Base"]);
  });
});

describe("Python Go to Implementation", () => {
  it("targets every descendant class of the class at the caret", async () => {
    const targets = await pythonImplementationTargets(hierarchy, "/p/dog.py", { line: 2, col: 6 }, outlineOf);
    expect(targets.map((l) => `${l.path}:${l.range.start.line}`)).toEqual(["/p/puppy.py:4"]);
  });

  it("targets the overriding methods of a method at the caret", async () => {
    const targets = await pythonImplementationTargets(hierarchy, "/p/dog.py", { line: 3, col: 8 }, outlineOf);
    expect(targets.map((l) => `${l.path}:${l.range.start.line}`)).toEqual(["/p/puppy.py:5"]);
  });

  it("keeps the server's answer useful when the project graph knows nothing", async () => {
    // The graph's own answer: a class without descendants has no implementation.
    const targets = await pythonImplementationTargets(hierarchy, "/p/puppy.py", { line: 4, col: 6 }, outlineOf);
    expect(targets).toEqual([]);
  });
});
