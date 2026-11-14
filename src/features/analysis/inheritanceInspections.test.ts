import { expect, it } from "vitest";
import type { ClassInheritance, Diagnostic, OutlineItem } from "@/platform/ipc";
import { inheritanceIndex } from "@/editor/navigation/inheritanceGraph";
import { inheritanceDiagnostics, pythonInheritanceExtension } from "./inheritanceInspections";

interface MethodSpec {
  name: string;
  /** Line of the `def` (the identifier's line). */
  line: number;
  /** Last body line. */
  end: number;
  /** Line the symbol range starts at (a server includes the decorators). */
  start?: number;
  kind?: "method" | "property" | "field";
}

interface ClassSpec {
  name: string;
  line: number;
  bases: string[];
  methods?: MethodSpec[];
}

/** A project of source files with the graph, outlines and lines the inspections read. */
class Fixture {
  private sources = new Map<string, string[]>();
  private outlines = new Map<string, OutlineItem[]>();
  private graph: ClassInheritance[] = [];

  constructor(private readonly current: string) {}

  add(path: string, source: string, classes: readonly ClassSpec[]): this {
    const lines = source.split("\n");
    this.sources.set(path, lines);
    this.outlines.set(
      path,
      classes.map((spec) => this.classItem(path, lines, spec)),
    );
    return this;
  }

  private classItem(path: string, lines: readonly string[], spec: ClassSpec): OutlineItem {
    const col = (lines[spec.line] ?? "").indexOf(spec.name);
    this.graph.push({ path, line: spec.line, col, name: spec.name, bases: spec.bases });
    return {
      name: spec.name,
      detail: null,
      kind: "class",
      range: { start: { line: spec.line, col: 0 }, end: { line: lines.length - 1, col: 0 } },
      selection_range: { start: { line: spec.line, col }, end: { line: spec.line, col: col + spec.name.length } },
      children: (spec.methods ?? []).map((method) => this.methodItem(lines, method)),
      visibility: null,
    };
  }

  private methodItem(lines: readonly string[], spec: MethodSpec): OutlineItem {
    const col = (lines[spec.line] ?? "").indexOf(spec.name);
    return {
      name: spec.name,
      detail: null,
      kind: spec.kind ?? "method",
      range: { start: { line: spec.start ?? spec.line, col: 0 }, end: { line: spec.end, col: 0 } },
      selection_range: { start: { line: spec.line, col }, end: { line: spec.line, col: col + spec.name.length } },
      children: [],
      visibility: null,
    };
  }

  async run(): Promise<Diagnostic[]> {
    const readFiles = async (paths: readonly string[]) =>
      new Map(paths.map((path) => [path, this.sources.get(path) ?? null]));
    const outlineOf = async (path: string) => this.outlines.get(path) ?? [];
    const index = inheritanceIndex(this.graph, { readFiles });
    return inheritanceDiagnostics({
      path: this.current,
      lines: this.sources.get(this.current) ?? [],
      outline: this.outlines.get(this.current) ?? [],
      index,
      readFiles,
      outlineOf,
    });
  }
}

const codes = (found: readonly Diagnostic[]) => found.map((d) => [d.code, d.severity, d.range.start.line]);

it("reports a class that ends up among its own ancestors", async () => {
  const project = new Fixture("/p/a.py")
    .add("/p/a.py", "class A(B):\n    pass", [{ name: "A", line: 0, bases: ["B"] }])
    .add("/p/b.py", "class B(A):\n    pass", [{ name: "B", line: 0, bases: ["A"] }]);
  expect(codes(await project.run())).toEqual([["circular-bases", "error", 0]]);
});

it("reports nothing for a legal diamond", async () => {
  const project = new Fixture("/p/d.py")
    .add("/p/d.py", "class D(B, C):\n    pass", [{ name: "D", line: 0, bases: ["B", "C"] }])
    .add("/p/b.py", "class B(A):\n    pass", [{ name: "B", line: 0, bases: ["A"] }])
    .add("/p/c.py", "class C(A):\n    pass", [{ name: "C", line: 0, bases: ["A"] }])
    .add("/p/a.py", "class A:\n    pass", [{ name: "A", line: 0, bases: [] }]);
  expect(await project.run()).toEqual([]);
});

it("reports @override on a method no base declares", async () => {
  const project = new Fixture("/p/a.py").add(
    "/p/a.py",
    [
      "from typing import override",
      "",
      "class Base:",
      "    def build(self):",
      "        return 1",
      "",
      "class C(Base):",
      "    @override",
      "    def save(self):",
      "        return 2",
    ].join("\n"),
    [
      { name: "Base", line: 2, bases: [], methods: [{ name: "build", line: 3, end: 4 }] },
      { name: "C", line: 6, bases: ["Base"], methods: [{ name: "save", line: 8, end: 9, start: 7 }] },
    ],
  );
  expect(codes(await project.run())).toEqual([["override", "warning", 8]]);
});

it("accepts @override that overrides a base method", async () => {
  const project = new Fixture("/p/a.py").add(
    "/p/a.py",
    [
      "from typing import override",
      "",
      "class Base:",
      "    def build(self):",
      "        return 1",
      "",
      "class C(Base):",
      "    @override",
      "    def build(self):",
      "        return 2",
    ].join("\n"),
    [
      { name: "Base", line: 2, bases: [], methods: [{ name: "build", line: 3, end: 4 }] },
      { name: "C", line: 6, bases: ["Base"], methods: [{ name: "build", line: 8, end: 9, start: 7 }] },
    ],
  );
  expect(await project.run()).toEqual([]);
});

it("does not guess about a base outside the project", async () => {
  const project = new Fixture("/p/a.py").add(
    "/p/a.py",
    ["class C(dict):", "    @override", "    def get(self, key):", "        return super().get(key)"].join("\n"),
    [{ name: "C", line: 0, bases: ["dict"], methods: [{ name: "get", line: 2, end: 3, start: 1 }] }],
  );
  expect(await project.run()).toEqual([]);
});

it("accepts @override of a member a base declares without a method", async () => {
  const project = new Fixture("/p/a.py").add(
    "/p/a.py",
    [
      "from typing import override",
      "",
      "class Base:",
      "    run = 1",
      "",
      "class C(Base):",
      "    @override",
      "    def run(self):",
      "        return 2",
    ].join("\n"),
    [
      { name: "Base", line: 2, bases: [], methods: [{ name: "run", line: 3, end: 3, kind: "field" }] },
      { name: "C", line: 5, bases: ["Base"], methods: [{ name: "run", line: 7, end: 8, start: 6 }] },
    ],
  );
  expect(await project.run()).toEqual([]);
});

it("does not report @override of an object dunder", async () => {
  const project = new Fixture("/p/a.py").add(
    "/p/a.py",
    [
      "from typing import override",
      "",
      "class C:",
      "    @override",
      "    def __eq__(self, other):",
      "        return True",
    ].join("\n"),
    [{ name: "C", line: 2, bases: [], methods: [{ name: "__eq__", line: 4, end: 5, start: 3 }] }],
  );
  expect(await project.run()).toEqual([]);
});

it("reports an unimplemented abstract method", async () => {
  const project = new Fixture("/p/a.py")
    .add("/p/a.py", "class C(Base):\n    pass", [{ name: "C", line: 0, bases: ["Base"] }])
    .add(
      "/p/base.py",
      [
        "from abc import ABC, abstractmethod",
        "",
        "class Base(ABC):",
        "    @abstractmethod",
        "    def run(self):",
        "        ...",
      ].join("\n"),
      [{ name: "Base", line: 2, bases: ["ABC"], methods: [{ name: "run", line: 4, end: 5, start: 3 }] }],
    );
  expect(codes(await project.run())).toEqual([["abstract-method", "warning", 0]]);
});

it("accepts a class that implements the abstract method", async () => {
  const project = new Fixture("/p/a.py")
    .add("/p/a.py", "class C(Base):\n    def run(self):\n        return 1", [
      { name: "C", line: 0, bases: ["Base"], methods: [{ name: "run", line: 1, end: 2 }] },
    ])
    .add(
      "/p/base.py",
      [
        "from abc import ABC, abstractmethod",
        "",
        "class Base(ABC):",
        "    @abstractmethod",
        "    def run(self):",
        "        ...",
      ].join("\n"),
      [{ name: "Base", line: 2, bases: ["ABC"], methods: [{ name: "run", line: 4, end: 5, start: 3 }] }],
    );
  expect(await project.run()).toEqual([]);
});

it("accepts a property that shadows the abstract method", async () => {
  const project = new Fixture("/p/a.py")
    .add("/p/a.py", "class C(Base):\n    @property\n    def run(self):\n        return 1", [
      { name: "C", line: 0, bases: ["Base"], methods: [{ name: "run", line: 2, end: 3, start: 1, kind: "property" }] },
    ])
    .add(
      "/p/base.py",
      [
        "from abc import ABC, abstractmethod",
        "",
        "class Base(ABC):",
        "    @abstractmethod",
        "    def run(self):",
        "        ...",
      ].join("\n"),
      [{ name: "Base", line: 2, bases: ["ABC"], methods: [{ name: "run", line: 4, end: 5, start: 3 }] }],
    );
  expect(await project.run()).toEqual([]);
});

it("reports a redundant override", async () => {
  const project = new Fixture("/p/a.py")
    .add("/p/a.py", "class C(Base):\n    def run(self):\n        pass", [
      { name: "C", line: 0, bases: ["Base"], methods: [{ name: "run", line: 1, end: 2 }] },
    ])
    .add("/p/base.py", "class Base:\n    def run(self):\n        pass", [
      { name: "Base", line: 0, bases: [], methods: [{ name: "run", line: 1, end: 2 }] },
    ]);
  expect(codes(await project.run())).toEqual([["redundant-override", "info", 1]]);
});

it("reports a redundant super() call with the same arguments", async () => {
  const project = new Fixture("/p/a.py")
    .add("/p/a.py", "class C(Base):\n    def run(self, speed):\n        return super().run(speed)", [
      { name: "C", line: 0, bases: ["Base"], methods: [{ name: "run", line: 1, end: 2 }] },
    ])
    .add("/p/base.py", "class Base:\n    def run(self, speed):\n        return speed", [
      { name: "Base", line: 0, bases: [], methods: [{ name: "run", line: 1, end: 2 }] },
    ]);
  expect(codes(await project.run())).toEqual([["redundant-override", "info", 1]]);
});

it("keeps an override whose base method does work", async () => {
  const project = new Fixture("/p/a.py")
    .add("/p/a.py", "class C(Base):\n    def run(self):\n        pass", [
      { name: "C", line: 0, bases: ["Base"], methods: [{ name: "run", line: 1, end: 2 }] },
    ])
    .add("/p/base.py", "class Base:\n    def run(self):\n        return 1", [
      { name: "Base", line: 0, bases: [], methods: [{ name: "run", line: 1, end: 2 }] },
    ]);
  expect(await project.run()).toEqual([]);
});

it("skips a signature whose string default hides a bracket", async () => {
  // The signature scan is a bracket counter, not a lexer: a quote makes the
  // parsing unreliable, so the rule stays silent rather than guess.
  const project = new Fixture("/p/a.py")
    .add("/p/a.py", 'class C(Base):\n    def run(self, sep="("):\n        pass', [
      { name: "C", line: 0, bases: ["Base"], methods: [{ name: "run", line: 1, end: 2 }] },
    ])
    .add("/p/base.py", 'class Base:\n    def run(self, sep="("):\n        pass', [
      { name: "Base", line: 0, bases: [], methods: [{ name: "run", line: 1, end: 2 }] },
    ]);
  expect(await project.run()).toEqual([]);
});

it("skips a class whose header no longer matches the cached graph", async () => {
  // The graph was indexed when the class read `Base`; the document now reads `Other`.
  const project = new Fixture("/p/a.py").add("/p/a.py", "class C(Other):\n    pass", [
    { name: "C", line: 0, bases: ["Base"] },
  ]);
  expect(await project.run()).toEqual([]);
});

it("installs the inspections for Python documents only", () => {
  const ctx = (language: string) => ({ doc: 1, path: "/p/a.py", language, uiMode: null, readOnly: false });
  expect(pythonInheritanceExtension(ctx("typescript"))).toEqual([]);
  expect(pythonInheritanceExtension(ctx("python"))).not.toEqual([]);
});
