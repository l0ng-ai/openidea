import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IpcError,
  type HierarchyItem,
  type Location,
  type OutlineItem,
  type Pos,
  type SymbolKind,
} from "@/platform/ipc";

const nav = vi.hoisted(() => ({ navigateTo: vi.fn(async () => {}), openPopup: vi.fn() }));
vi.mock("@/editor/lsp/navigation", async (orig) => ({
  ...(await orig<typeof import("@/editor/lsp/navigation")>()),
  navigateTo: nav.navigateTo,
  locationItems: async (locs: Location[]) => locs.map((l, i) => ({ id: `${i}`, label: l.path, run: () => {} })),
}));
vi.mock("@/editor/lsp/popupStore", async (orig) => ({
  ...(await orig<typeof import("@/editor/lsp/popupStore")>()),
  openPopup: nav.openPopup,
}));

import { candidateKey, markerCandidates, type MarkerCandidate } from "./lineMarkers";
import { Text } from "@codemirror/state";
import {
  affectsMarkers,
  cachedMarkers,
  emptyCache,
  enabledGroups,
  fillMarkers,
  markerBatches,
  markersOf,
  noteOtherChanges,
  openMarkerTargets,
  type MarkerDeps,
} from "./implementationGutter";

const ALL = enabledGroups({ showGutterIcons: true, gutterIconsDisabled: [] });

function item(
  name: string,
  kind: SymbolKind,
  line: number,
  end: number,
  children: OutlineItem[] = [],
  col = 4,
): OutlineItem {
  return {
    name,
    kind,
    detail: null,
    range: { start: { line, col: 0 }, end: { line: end, col: 1 } },
    selection_range: { start: { line, col }, end: { line, col: col + name.length } },
    children,
  };
}

const loc = (path: string, line: number, col = 4): Location => ({
  path,
  range: { start: { line, col }, end: { line, col: col + 3 } },
});

const hier = (name: string, kind: SymbolKind, path: string, line = 0): HierarchyItem => ({
  name,
  kind,
  detail: null,
  path,
  range: { start: { line, col: 0 }, end: { line: line + 20, col: 1 } },
  selectionRange: { start: { line, col: 4 }, end: { line, col: 4 + name.length } },
  fromRanges: [],
});

// Shape.java, as jdtls outlines it.
const SHAPE = [
  "public interface Shape {",
  "    double area();",
  '    default String label() { return ""; }',
  "    static Shape unit() { return null; }",
  "}",
];
const SHAPE_OUTLINE = [
  item(
    "Shape",
    "interface",
    0,
    4,
    [
      item("area()", "method", 1, 1, [], 11),
      item("label()", "method", 2, 2, [], 19),
      item("unit()", "method", 3, 3, [], 17),
    ],
    17,
  ),
];
const SHAPE_PATH = "/p/Shape.java";

// Circle.java: implements Shape, overrides Base.label().
const CIRCLE = [
  "public class Circle extends Base implements Shape {",
  "    @Override",
  "    public double area() { return 1; }",
  "    private void helper() {}",
  '    public final String label() { return "c"; }',
  "}",
];
const CIRCLE_OUTLINE = [
  item(
    "Circle",
    "class",
    0,
    5,
    [item("area()", "method", 1, 2), item("helper()", "method", 3, 3, [], 17), item("label()", "method", 4, 4, [], 24)],
    13,
  ),
];
// Make `area()`'s identifier sit on line 2 (its range starts at the annotation).
CIRCLE_OUTLINE[0]!.children[0]!.selection_range = { start: { line: 2, col: 18 }, end: { line: 2, col: 22 } };

const BASE = [
  "public abstract class Base {",
  "    public abstract void run();",
  '    public String label() { return ""; }',
  "}",
];
const BASE_OUTLINE = [
  item("Base", "class", 0, 3, [item("run()", "method", 1, 1, [], 25), item("label()", "method", 2, 2, [], 18)], 22),
];

const FILES: Record<string, string[]> = {
  [SHAPE_PATH]: SHAPE,
  "/p/Circle.java": CIRCLE,
  "/p/Square.java": ["public class Square implements Shape {", "    public double area() { return 2; }", "}"],
  "/p/Base.java": BASE,
};

const lines = (text: string[]) => (l: number) => text[l] ?? "";

describe("marker candidates", () => {
  it("covers inheritable types and their methods, without private / static / final ones", () => {
    const shape = markerCandidates(SHAPE_OUTLINE, lines(SHAPE));
    expect(shape.map((c) => [c.name, c.abstract, c.inheritable, c.overriding])).toEqual([
      ["Shape", true, true, false],
      ["area", true, true, true],
      // A default method has a body: overriding it is not implementing it.
      ["label", false, true, true],
      ["unit", true, false, false],
    ]);
    const circle = markerCandidates(CIRCLE_OUTLINE, lines(CIRCLE));
    expect(circle.map((c) => [c.name, c.line, c.inheritable, c.overriding])).toEqual([
      ["Circle", 0, true, false],
      ["area", 2, true, true],
      ["helper", 3, false, false],
      ["label", 4, false, true],
    ]);
    expect(markerCandidates(BASE_OUTLINE, lines(BASE)).map((c) => [c.name, c.abstract])).toEqual([
      ["Base", true],
      ["run", true],
      ["label", false],
    ]);
  });

  it("skips structs, enums and free functions for implementation requests", () => {
    const outline = [item("Point", "struct", 0, 3, [item("len", "method", 1, 1)]), item("main", "function", 5, 6)];
    const found = markerCandidates(outline, () => "");
    expect(found.map((c) => [c.name, c.inheritable, c.overriding])).toEqual([["len", false, true]]);
  });
});

/** A server answering implementation and type hierarchy requests over the files above. */
function server(
  impls: Record<string, Location[]>,
  supers: Record<string, HierarchyItem[]>,
  subtypes: Record<string, HierarchyItem[]> = {},
) {
  const calls = { implementations: [] as Pos[][], supertypes: 0, subtypes: 0 };
  const outlines: Record<string, OutlineItem[]> = {
    [SHAPE_PATH]: SHAPE_OUTLINE,
    "/p/Circle.java": CIRCLE_OUTLINE,
    "/p/Base.java": BASE_OUTLINE,
  };
  const deps = (path: string): MarkerDeps => ({
    implementations: async (positions) => {
      calls.implementations.push(positions);
      return positions.map((p) => impls[`${path}:${p.line}`] ?? []);
    },
    supers: {
      supertypes: async (p) => {
        calls.supertypes++;
        return supers[p] ?? [];
      },
      subtypes: async (p) => {
        calls.subtypes++;
        // A path without an entry: the server has no type hierarchy for it.
        if (!(p in subtypes)) throw new IpcError({ kind: "unavailable", message: "no type hierarchy" });
        return subtypes[p]!;
      },
      outline: async (p) => outlines[p] ?? [],
    },
    readFiles: async (paths) => new Map(paths.map((p) => [p, FILES[p] ?? null])),
  });
  return { calls, deps };
}

describe("markers from server answers", () => {
  const shapeImpls = {
    // The server lists the declaration itself too.
    [`${SHAPE_PATH}:0`]: [loc(SHAPE_PATH, 0), loc("/p/Circle.java", 0, 13), loc("/p/Square.java", 0, 13)],
    [`${SHAPE_PATH}:1`]: [loc("/p/Circle.java", 2, 18), loc("/p/Square.java", 1, 18)],
  };

  it("marks implemented interfaces and methods with every implementation as targets", async () => {
    const { deps, calls } = server(shapeImpls, {});
    const candidates = markerCandidates(SHAPE_OUTLINE, lines(SHAPE));
    const cache = emptyCache();
    await fillMarkers(SHAPE_PATH, candidates, ALL, deps(SHAPE_PATH), cache);
    // One batch for every inheritable declaration.
    expect(calls.implementations).toEqual([
      [
        { line: 0, col: 17 },
        { line: 1, col: 11 },
        { line: 2, col: 19 },
      ],
    ]);
    const markers = cachedMarkers(candidates, ALL, cache);
    expect(markers.map((m) => [m.line, m.kind, m.targets.length, m.tooltip])).toEqual([
      [0, "implemented", 2, "Is implemented by Circle, Square"],
      [1, "implemented", 2, "Is implemented in Circle, Square"],
    ]);
    expect(markers[0]!.chooserTitle).toBe("Choose Implementation of Shape (2 found)");
  });

  it("marks subclassed classes and overridden methods", async () => {
    const { deps } = server(
      {
        "/p/Base.java:0": [loc("/p/Circle.java", 0, 13)],
        "/p/Base.java:2": [loc("/p/Circle.java", 4, 25)],
      },
      {},
    );
    const candidates = markerCandidates(BASE_OUTLINE, lines(BASE));
    const cache = emptyCache();
    await fillMarkers("/p/Base.java", candidates, ALL, deps("/p/Base.java"), cache);
    const markers = cachedMarkers(candidates, ALL, cache);
    // `abstract class Base` is implemented, `label()` overridden.
    expect(markers.map((m) => [m.line, m.kind, m.tooltip])).toEqual([
      [0, "implemented", "Is implemented by Circle"],
      [2, "overridden", "Is overridden in Circle"],
    ]);
  });

  it("uses the type hierarchy's subtypes when implementation requests are empty", async () => {
    const circle: HierarchyItem = {
      ...hier("Circle", "class", "/p/Circle.java"),
      selectionRange: { start: { line: 0, col: 13 }, end: { line: 0, col: 19 } },
    };
    const { deps, calls } = server({}, {}, { "/p/Base.java": [circle] });
    const candidates = markerCandidates(BASE_OUTLINE, lines(BASE));
    const cache = emptyCache();
    await fillMarkers("/p/Base.java", candidates, ALL, deps("/p/Base.java"), cache);
    const markers = cachedMarkers(candidates, ALL, cache);
    // Pyrefly answers implementation requests with nothing; the hierarchy still knows Circle.
    expect(markers.map((m) => [m.line, m.kind, m.tooltip])).toEqual([[0, "implemented", "Is implemented by Circle"]]);
    expect(calls.subtypes).toBeGreaterThan(0);
  });

  it("marks implementing and overriding methods from the type hierarchy", async () => {
    const supers = {
      "/p/Circle.java": [hier("Base", "class", "/p/Base.java"), hier("Shape", "interface", SHAPE_PATH)],
    };
    const { deps, calls } = server({}, supers);
    const candidates = markerCandidates(CIRCLE_OUTLINE, lines(CIRCLE));
    const cache = emptyCache();
    await fillMarkers("/p/Circle.java", candidates, ALL, deps("/p/Circle.java"), cache);
    const markers = cachedMarkers(candidates, ALL, cache);
    expect(
      markers.map((m) => [m.line, m.kind, m.tooltip, m.targets.map((t) => `${t.path}:${t.range.start.line}`)]),
    ).toEqual([
      [2, "implementing", "Implements method in Shape", [`${SHAPE_PATH}:1`]],
      // Base.label() and the default Shape.label() have bodies.
      [4, "overriding", "Overrides method in Base, Shape", ["/p/Base.java:2", `${SHAPE_PATH}:2`]],
    ]);
    expect(markers[1]!.chooserTitle).toBe("Choose Super Method of label (2 found)");
    expect(calls.supertypes).toBeGreaterThan(0);
  });

  it("asks once per document version and only for enabled groups", async () => {
    const { deps, calls } = server(shapeImpls, {});
    const candidates = markerCandidates(SHAPE_OUTLINE, lines(SHAPE));
    const cache = emptyCache();
    await fillMarkers(SHAPE_PATH, candidates, ALL, deps(SHAPE_PATH), cache);
    await fillMarkers(SHAPE_PATH, candidates, ALL, deps(SHAPE_PATH), cache);
    expect(calls.implementations).toHaveLength(1);
    // A new document version starts from an empty cache.
    await fillMarkers(SHAPE_PATH, candidates, ALL, deps(SHAPE_PATH), emptyCache());
    expect(calls.implementations).toHaveLength(2);

    const supersOnly = enabledGroups({ showGutterIcons: true, gutterIconsDisabled: ["inheritors"] });
    const fresh = emptyCache();
    await fillMarkers(SHAPE_PATH, candidates, supersOnly, deps(SHAPE_PATH), fresh);
    expect(calls.implementations).toHaveLength(2);
    expect(cachedMarkers(candidates, ALL, cache)).toHaveLength(2);
    expect(cachedMarkers(candidates, supersOnly, cache)).toHaveLength(0);
  });

  it("stops asking a server that cannot answer, and caches nothing when cancelled", async () => {
    const candidates = markerCandidates(SHAPE_OUTLINE, lines(SHAPE));
    const failing = (kind: "unavailable" | "cancelled") => {
      const calls = { n: 0 };
      const deps: MarkerDeps = {
        implementations: async () => {
          calls.n++;
          throw new IpcError({ kind, message: kind });
        },
        supers: { supertypes: async () => [], outline: async () => [] },
        readFiles: async () => new Map(),
      };
      return { calls, deps };
    };
    const off = failing("unavailable");
    const cache = emptyCache();
    await fillMarkers(SHAPE_PATH, candidates, ALL, off.deps, cache);
    await fillMarkers(SHAPE_PATH, candidates, ALL, off.deps, cache);
    expect(off.calls.n).toBe(1);
    expect(cache.unsupported.has("inheritors")).toBe(true);

    const cancelled = failing("cancelled");
    const kept = emptyCache();
    await expect(fillMarkers(SHAPE_PATH, candidates, ALL, cancelled.deps, kept)).rejects.toThrow();
    expect(kept.entries.size).toBe(0);
  });
});

describe("marker cache across views", () => {
  it("keeps a document's answers until its text or other files change", () => {
    const doc = Text.of(["interface Shape {", "  double area();", "}"]);
    const first = markersOf("/p/Shape.java", doc);
    first.cache.entries.set("k", { inheritors: null });
    // A remounted editor (tab switch) with the same text reuses the answers.
    expect(markersOf("/p/Shape.java", doc).cache.entries.has("k")).toBe(true);
    // Edited text starts over.
    const edited = Text.of(["interface Shape {", "  double area();", "  double perimeter();", "}"]);
    expect(markersOf("/p/Shape.java", edited).cache.entries.size).toBe(0);
    // Other files changed: the answers are asked again, the outline is kept.
    const again = markersOf("/p/Shape.java", edited);
    again.cache.entries.set("k", { inheritors: null });
    again.outline = { items: [], candidates: [] };
    noteOtherChanges();
    const after = markersOf("/p/Shape.java", edited);
    expect(after.cache.entries.size).toBe(0);
    expect(after.outline).toBe(again.outline);
  });

  it("ignores changes to build output", () => {
    expect(affectsMarkers(["/p/target/classes/a/Shape.class"])).toBe(false);
    expect(affectsMarkers(["/p/build/tmp/x.txt", "/p/.git/index", "C:\\p\\out\\Main.class"])).toBe(false);
    expect(affectsMarkers(["/p/target/classes/a/Shape.class", "/p/src/main/java/a/Circle.java"])).toBe(true);
    expect(affectsMarkers(["/p/src/builder/Shape.java"])).toBe(true);
  });
});

describe("marker batches", () => {
  const at = (line: number) => ({ line }) as MarkerCandidate;

  it("asks the viewport first, then the rest of the file nearest first", () => {
    const candidates = [0, 100, 300, 400, 650, 900].map(at);
    const batches = markerBatches(candidates, 380, 420);
    expect(batches.flat().map((c) => c.line)).toEqual([400, 300, 650, 100, 0, 900]);
  });

  it("covers every declaration in batches", () => {
    const candidates = Array.from({ length: 150 }, (_, i) => at(i * 4));
    const batches = markerBatches(candidates, 0, 40);
    expect(batches.map((b) => b.length)).toEqual([60, 60, 30]);
    expect(new Set(batches.flat()).size).toBe(150);
  });
});

describe("settings", () => {
  it("follows Settings › Gutter Icons", () => {
    expect([...enabledGroups({ showGutterIcons: true, gutterIconsDisabled: [] })]).toEqual(["inheritors", "supers"]);
    expect([...enabledGroups({ showGutterIcons: true, gutterIconsDisabled: ["supers", "run"] })]).toEqual([
      "inheritors",
    ]);
    expect(enabledGroups({ showGutterIcons: false, gutterIconsDisabled: [] }).size).toBe(0);
  });
});

describe("clicking a marker", () => {
  beforeEach(() => {
    nav.navigateTo.mockClear();
    nav.openPopup.mockClear();
  });
  const candidate = (): MarkerCandidate => markerCandidates(SHAPE_OUTLINE, lines(SHAPE))[0]!;

  it("navigates to a single target", async () => {
    const target = loc("/p/Circle.java", 0, 13);
    await openMarkerTargets(
      { kind: "implemented", line: 0, name: "Shape", targets: [target], tooltip: "", chooserTitle: "" },
      { x: 1, y: 2 },
    );
    expect(nav.navigateTo).toHaveBeenCalledWith(target);
    expect(nav.openPopup).not.toHaveBeenCalled();
  });

  it("opens the chooser over several targets", async () => {
    const targets = [loc("/p/Circle.java", 0, 13), loc("/p/Square.java", 0, 13)];
    expect(candidateKey(candidate())).toBe("0:17:Shape");
    await openMarkerTargets(
      {
        kind: "implemented",
        line: 0,
        name: "Shape",
        targets,
        tooltip: "",
        chooserTitle: "Choose Implementation of Shape (2 found)",
      },
      { x: 1, y: 2 },
    );
    expect(nav.navigateTo).not.toHaveBeenCalled();
    expect(nav.openPopup).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "list",
        anchor: { x: 1, y: 2 },
        title: "Choose Implementation of Shape (2 found)",
      }),
    );
    expect(nav.openPopup.mock.calls[0]![0].items).toHaveLength(2);
  });
});

describe("overriders of a type's methods from its subtypes", () => {
  // Shapes and names as jdtls answers them (outline names carry the signature).
  const REPO = [
    "public interface Repo<T> {",
    "    void save(T item);",
    "    void save(T item, int times);",
    "    T find(String id);",
    "    default int count() { return 0; }",
    "    void flush();",
    "    void onlyAnon();",
    "}",
  ];
  const REPO_OUTLINE = [
    item(
      "Repo<T>",
      "interface",
      0,
      7,
      [
        item("save(T)", "method", 1, 1, [], 9),
        item("save(T, int)", "method", 2, 2, [], 9),
        item("find(String)", "method", 3, 3, [], 6),
        item("count()", "method", 4, 4, [], 16),
        item("flush()", "method", 5, 5, [], 9),
        item("onlyAnon()", "method", 6, 6, [], 9),
      ],
      17,
    ),
  ];
  const ORDER_REPO_OUTLINE = [
    item("OrderRepo", "class", 0, 7, [
      item("save(Order)", "method", 1, 1),
      item("save(Order, int)", "method", 2, 2),
      item("find(String)", "method", 3, 3),
      item("count()", "method", 4, 4),
      // An overload, not an override.
      item("save(String)", "method", 5, 5),
      item("onlyAnon()", "method", 6, 6),
    ]),
  ];
  const SUB_REPO_OUTLINE = [item("SubRepo", "class", 0, 3, [item("find(String)", "method", 1, 1)])];
  // jdtls lists anonymous classes as subtypes, nested under the field they initialize.
  const ANON_OUTLINE = [
    item("Anon", "class", 0, 9, [
      item("repo", "field", 2, 8, [
        item("new Repo() {...}", "class", 2, 8, [
          item("save(String)", "method", 3, 3),
          item("save(String, int)", "method", 4, 4),
          item("find(String)", "method", 5, 5),
          item("flush()", "method", 6, 6),
          item("onlyAnon()", "method", 7, 7),
        ]),
      ]),
    ]),
  ];
  const at = (name: string, path: string, line: number, col = 4): HierarchyItem => ({
    ...hier(name, "class", path),
    selectionRange: { start: { line, col }, end: { line, col: col + name.length } },
  });
  const orderRepo = at("OrderRepo", "/p/OrderRepo.java", 0);
  const subRepo = at("SubRepo", "/p/SubRepo.java", 0);
  const anon = at("new Repo() {...}", "/p/Anon.java", 2, 30);

  function repoServer(subtypes: Record<string, HierarchyItem[]>) {
    const calls = { implementations: [] as Pos[][], subtypes: 0 };
    const outlines: Record<string, OutlineItem[]> = {
      "/p/Repo.java": REPO_OUTLINE,
      "/p/OrderRepo.java": ORDER_REPO_OUTLINE,
      "/p/SubRepo.java": SUB_REPO_OUTLINE,
      "/p/Anon.java": ANON_OUTLINE,
    };
    const deps: MarkerDeps = {
      implementations: async (positions) => {
        calls.implementations.push(positions);
        return positions.map(() => [loc("/p/OrderRepo.java", 1)]);
      },
      supers: {
        supertypes: async () => [],
        subtypes: async (p) => {
          calls.subtypes++;
          return subtypes[p] ?? [];
        },
        outline: async (p) => outlines[p] ?? [],
      },
      readFiles: async (paths) => new Map(paths.map((p) => [p, null])),
    };
    return { calls, deps };
  }
  const targetsOf = (cache: ReturnType<typeof emptyCache>, candidates: MarkerCandidate[]) =>
    cachedMarkers(candidates, ALL, cache).map((m) => [
      m.line,
      m.targets.map((t) => `${t.path.slice(3)}:${t.range.start.line}`).sort(),
    ]);

  it("walks the subtypes once instead of asking for each method", async () => {
    const { deps, calls } = repoServer({
      "/p/Repo.java": [orderRepo, anon],
      "/p/OrderRepo.java": [subRepo],
    });
    const candidates = markerCandidates(REPO_OUTLINE, lines(REPO));
    const cache = emptyCache();
    await fillMarkers("/p/Repo.java", candidates, ALL, deps, cache);
    // Repo, OrderRepo, Anon and SubRepo: fewer requests than the six methods.
    expect(calls.subtypes).toBe(4);
    // Only the generic save(T) overloads need the server: save(Order) / save(String) may or may not override them.
    expect(calls.implementations).toEqual([
      [
        { line: 1, col: 9 },
        { line: 2, col: 9 },
      ],
    ]);
    expect(targetsOf(cache, candidates)).toEqual([
      [0, ["Anon.java:2", "OrderRepo.java:0", "SubRepo.java:0"]],
      [1, ["OrderRepo.java:1"]],
      [2, ["OrderRepo.java:1"]],
      [3, ["Anon.java:5", "OrderRepo.java:3", "SubRepo.java:1"]],
      [4, ["OrderRepo.java:4"]],
      [5, ["Anon.java:6"]],
      [6, ["Anon.java:7", "OrderRepo.java:6"]],
    ]);
  });

  it("needs one request for a type without subtypes", async () => {
    const { deps, calls } = repoServer({});
    const candidates = markerCandidates(REPO_OUTLINE, lines(REPO));
    const cache = emptyCache();
    await fillMarkers("/p/Repo.java", candidates, ALL, deps, cache);
    expect(calls.subtypes).toBe(1);
    expect(calls.implementations).toEqual([]);
    expect(cachedMarkers(candidates, ALL, cache)).toEqual([]);
  });

  it("asks for each method when the walk would cost more than it saves", async () => {
    const { deps, calls } = repoServer({ "/p/Repo.java": [orderRepo], "/p/OrderRepo.java": [subRepo] });
    // Two methods: walking Repo, OrderRepo and SubRepo would take more requests than asking twice.
    const candidates = markerCandidates(REPO_OUTLINE, lines(REPO)).filter((c) => !c.method || c.line >= 5);
    await fillMarkers("/p/Repo.java", candidates, ALL, deps, emptyCache());
    expect(calls.subtypes).toBe(1);
    expect(calls.implementations).toEqual([
      [
        { line: 0, col: 17 },
        { line: 5, col: 9 },
        { line: 6, col: 9 },
      ],
    ]);
  });
});
