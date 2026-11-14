import { expect, it } from "vitest";
import type {
  ClassInheritance,
  Diagnostic,
  MethodBody,
  OutlineItem,
  PythonClassFacts,
  PythonFacts,
  PythonMethodFacts,
  Range,
} from "@/platform/ipc";
import { inheritanceIndex } from "@/editor/navigation/inheritanceGraph";
import { inheritanceDiagnostics, pythonInheritanceExtension } from "./inheritanceInspections";

interface MethodSpec {
  name: string;
  line: number;
  col?: number;
  params?: string[] | null;
  abstract?: boolean;
  override?: boolean;
  body?: MethodBody;
}

interface ClassSpec {
  name: string;
  line: number;
  col?: number;
  /** The bases the *index* saw (defaults to `bases`). */
  indexedBases?: string[];
  bases: string[];
  methods?: MethodSpec[];
  /** Extra members (fields, properties, nested classes) the class declares. */
  members?: string[];
}

const range = (line: number, col: number): Range => ({ start: { line, col }, end: { line, col: col + 1 } });
const EMPTY: MethodBody = { kind: "empty" };
const OTHER: MethodBody = { kind: "other" };
const forward = (target: string, args: string[], returns = false): MethodBody => ({
  kind: "superCall",
  returns,
  target,
  args,
});

const methodFacts = (spec: MethodSpec): PythonMethodFacts => ({
  name: spec.name,
  selection: range(spec.line, spec.col ?? 8),
  params: spec.params === undefined ? ["self"] : spec.params,
  abstractMethod: spec.abstract ?? false,
  overrideDecorated: spec.override ?? false,
  body: spec.body ?? EMPTY,
});

const classItem = (spec: ClassSpec, col: number, methods: PythonMethodFacts[]): OutlineItem => ({
  name: spec.name,
  detail: null,
  kind: "class",
  range: range(spec.line, 0),
  selection_range: range(spec.line, col),
  children: [
    ...methods.map((m): OutlineItem => ({
      name: m.name,
      detail: null,
      kind: "method",
      range: m.selection,
      selection_range: m.selection,
      children: [],
      visibility: null,
    })),
    ...(spec.members ?? []).map((name): OutlineItem => ({
      name,
      detail: null,
      kind: "field",
      range: range(spec.line, 0),
      selection_range: range(spec.line, 0),
      children: [],
      visibility: null,
    })),
  ],
  visibility: null,
});

/** A project held as the facts, outlines and graph the inspections read. */
class Fixture {
  private facts = new Map<string, PythonFacts>();
  private outlines = new Map<string, OutlineItem[]>();
  private graph: ClassInheritance[] = [];

  constructor(private readonly current: string) {}

  add(path: string, classes: readonly ClassSpec[]): this {
    const classFacts: PythonClassFacts[] = [];
    for (const spec of classes) {
      const col = spec.col ?? 6;
      const methods = (spec.methods ?? []).map(methodFacts);
      classFacts.push({ name: spec.name, selection: range(spec.line, col), bases: spec.bases, methods });
      this.graph.push({ path, line: spec.line, col, name: spec.name, bases: spec.indexedBases ?? spec.bases });
      this.outlines.set(path, [...(this.outlines.get(path) ?? []), classItem(spec, col, methods)]);
    }
    this.facts.set(path, { classes: [...(this.facts.get(path)?.classes ?? []), ...classFacts] });
    return this;
  }

  async run(enabled?: ReadonlySet<string>): Promise<Diagnostic[]> {
    const facts = this.facts.get(this.current);
    if (!facts) throw new Error(`no fixture for ${this.current}`);
    return inheritanceDiagnostics({
      path: this.current,
      outline: this.outlines.get(this.current) ?? [],
      facts,
      index: inheritanceIndex(this.graph, { readFiles: async () => new Map() }),
      factsOf: async (path) => this.facts.get(path) ?? null,
      outlineOf: async (path) => this.outlines.get(path) ?? [],
      enabled,
    });
  }
}

const codes = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => [d.code, d.severity, d.range.start.line]);

/** `/p/base.py` declares the bases; `/p/a.py` holds the class under test. */
const withBase = (child: ClassSpec, base: ClassSpec[], basePath = "/p/base.py") =>
  new Fixture("/p/a.py").add(basePath, base).add("/p/a.py", [child]);

it("reports circular inheritance", async () => {
  const project = new Fixture("/p/a.py").add("/p/a.py", [
    { name: "First", line: 0, bases: ["Second"] },
    { name: "Second", line: 4, bases: ["First"] },
  ]);
  expect(codes(await project.run())).toEqual([
    ["builtin:python-circular-bases", "error", 0],
    ["builtin:python-circular-bases", "error", 4],
  ]);
});

it("accepts a legal diamond", async () => {
  const project = new Fixture("/p/a.py")
    .add("/p/base.py", [
      { name: "Root", line: 0, bases: [] },
      { name: "Left", line: 3, bases: ["Root"] },
      { name: "Right", line: 6, bases: ["Root"] },
    ])
    .add("/p/a.py", [{ name: "Leaf", line: 0, bases: ["Left", "Right"] }]);
  expect(await project.run()).toEqual([]);
});

it("reports an @override no ancestor declares", async () => {
  const project = withBase(
    { name: "C", line: 0, bases: ["Base"], methods: [{ name: "run", line: 1, override: true }] },
    [{ name: "Base", line: 0, bases: [], methods: [{ name: "other", line: 1 }] }],
  );
  expect(codes(await project.run())).toEqual([["builtin:python-override", "warning", 1]]);
});

it("accepts an @override of a method, a field or a property", async () => {
  const project = withBase(
    {
      name: "C",
      line: 0,
      bases: ["Base"],
      methods: [
        { name: "run", line: 1, override: true, body: OTHER },
        { name: "limit", line: 3, override: true },
        { name: "label", line: 5, override: true },
      ],
    },
    [{ name: "Base", line: 0, bases: [], methods: [{ name: "run", line: 1 }], members: ["limit", "label"] }],
  );
  expect(await project.run()).toEqual([]);
});

it("never reports @override on a dunder", async () => {
  const project = withBase(
    { name: "C", line: 0, bases: ["Base"], methods: [{ name: "__eq__", line: 1, override: true }] },
    [{ name: "Base", line: 0, bases: [] }],
  );
  expect(await project.run()).toEqual([]);
});

it("stays silent when a base is outside the project", async () => {
  // `dict` is not in the graph: it may declare or implement anything.
  const project = withBase(
    {
      name: "C",
      line: 0,
      bases: ["dict"],
      methods: [
        { name: "run", line: 1, override: true },
        { name: "go", line: 3, abstract: true },
      ],
    },
    [],
  );
  expect(await project.run()).toEqual([]);
});

it("reports an unimplemented abstract method", async () => {
  const project = withBase({ name: "Half", line: 0, bases: ["Base"] }, [
    { name: "Base", line: 0, bases: [], methods: [{ name: "dispatch", line: 1, abstract: true }] },
  ]);
  expect(codes(await project.run())).toEqual([["builtin:python-abstract-method", "warning", 0]]);
});

it("still reports an abstract method whose declarer has a foreign base", async () => {
  // `class TokenDispatcher(ABC)` in an attached project: `ABC` is outside the graph, but
  // that cannot hide the abstract method the declarer does define.
  const project = withBase({ name: "Half", line: 0, bases: ["Base"] }, [
    { name: "Base", line: 0, bases: ["ABC"], methods: [{ name: "dispatch", line: 1, abstract: true }] },
  ]);
  expect(codes(await project.run())).toEqual([["builtin:python-abstract-method", "warning", 0]]);
});

it("accepts a class that implements the abstract method", async () => {
  const project = withBase({ name: "Done", line: 0, bases: ["Base"], methods: [{ name: "dispatch", line: 1 }] }, [
    { name: "Base", line: 0, bases: [], methods: [{ name: "dispatch", line: 1, abstract: true }] },
  ]);
  expect(await project.run()).toEqual([]);
});

it("accepts a property that implements the abstract method", async () => {
  const project = withBase({ name: "Done", line: 0, bases: ["Base"], members: ["dispatch"] }, [
    { name: "Base", line: 0, bases: [], methods: [{ name: "dispatch", line: 1, abstract: true }] },
  ]);
  expect(await project.run()).toEqual([]);
});

it("accepts an abstract method an intermediate ancestor implements", async () => {
  const project = new Fixture("/p/a.py")
    .add("/p/base.py", [{ name: "Base", line: 0, bases: [], methods: [{ name: "run", line: 1, abstract: true }] }])
    .add("/p/mid.py", [{ name: "Mid", line: 0, bases: ["Base"], methods: [{ name: "run", line: 1 }] }])
    .add("/p/a.py", [{ name: "Leaf", line: 0, bases: ["Mid"] }]);
  expect(await project.run()).toEqual([]);
});

it("reports a redundant pass over a pass", async () => {
  const project = withBase({ name: "C", line: 0, bases: ["Base"], methods: [{ name: "run", line: 1 }] }, [
    { name: "Base", line: 0, bases: [], methods: [{ name: "run", line: 1 }] },
  ]);
  expect(codes(await project.run())).toEqual([["builtin:python-redundant-override", "info", 1]]);
});

it("reports a redundant returned super() forward with the same arguments", async () => {
  const project = withBase(
    {
      name: "C",
      line: 0,
      bases: ["Base"],
      methods: [{ name: "run", line: 1, params: ["self", "speed"], body: forward("run", ["speed"], true) }],
    },
    [{ name: "Base", line: 0, bases: [], methods: [{ name: "run", line: 1, params: ["self", "speed"], body: OTHER }] }],
  );
  expect(codes(await project.run())).toEqual([["builtin:python-redundant-override", "info", 1]]);
});

it("still reports a redundant forward whose declarer has a foreign base", async () => {
  // The declarer inherits from `ABC` outside the graph; it still decides what runs.
  const project = withBase(
    {
      name: "C",
      line: 0,
      bases: ["Base"],
      methods: [{ name: "run", line: 1, params: ["self", "x"], body: forward("run", ["x"], true) }],
    },
    [
      {
        name: "Base",
        line: 0,
        bases: ["ABC"],
        methods: [{ name: "run", line: 1, params: ["self", "x"] }],
      },
    ],
  );
  expect(codes(await project.run())).toEqual([["builtin:python-redundant-override", "info", 1]]);
});

it("keeps a bare super() forward over a base that returns a value", async () => {
  // Dropping the override would return the base's value instead of None.
  const project = withBase(
    {
      name: "C",
      line: 0,
      bases: ["Base"],
      methods: [{ name: "run", line: 1, params: ["self", "speed"], body: forward("run", ["speed"]) }],
    },
    [{ name: "Base", line: 0, bases: [], methods: [{ name: "run", line: 1, params: ["self", "speed"], body: OTHER }] }],
  );
  expect(await project.run()).toEqual([]);
});

it("accepts a bare super() forward over a base that returns nothing", async () => {
  const project = withBase(
    {
      name: "C",
      line: 0,
      bases: ["Base"],
      methods: [{ name: "run", line: 1, params: ["self", "speed"], body: forward("run", ["speed"]) }],
    },
    [{ name: "Base", line: 0, bases: [], methods: [{ name: "run", line: 1, params: ["self", "speed"] }] }],
  );
  expect(codes(await project.run())).toEqual([["builtin:python-redundant-override", "info", 1]]);
});

it("keeps an override whose base method does other work", async () => {
  const project = withBase({ name: "C", line: 0, bases: ["Base"], methods: [{ name: "run", line: 1, body: OTHER }] }, [
    { name: "Base", line: 0, bases: [], methods: [{ name: "run", line: 1, body: OTHER }] },
  ]);
  expect(await project.run()).toEqual([]);
});

it("keeps an override that changes the arguments it forwards", async () => {
  const project = withBase(
    {
      name: "C",
      line: 0,
      bases: ["Base"],
      methods: [{ name: "run", line: 1, params: ["self", "speed"], body: forward("run", ["speed", "1"], true) }],
    },
    [{ name: "Base", line: 0, bases: [], methods: [{ name: "run", line: 1, params: ["self", "speed"], body: OTHER }] }],
  );
  expect(await project.run()).toEqual([]);
});

it("skips a class whose header no longer matches the indexed graph", async () => {
  // The graph was indexed when the class read `Base`; the document now reads `Other`.
  const project = withBase({ name: "C", line: 0, bases: ["Other"], indexedBases: ["Base"] }, [
    { name: "Base", line: 0, bases: [] },
  ]);
  expect(await project.run()).toEqual([]);
});

it("runs only the producers that are enabled", async () => {
  const project = new Fixture("/p/a.py").add("/p/a.py", [
    { name: "First", line: 0, bases: ["Second"] },
    { name: "Second", line: 4, bases: ["First"] },
  ]);
  expect(await project.run(new Set())).toEqual([]);
  expect((await project.run()).length).toBe(2);
});

it("installs the inspections for Python documents only", () => {
  const ctx = (language: string) => ({ doc: 1, path: "/p/a.py", language, uiMode: null, readOnly: false });
  expect(pythonInheritanceExtension(ctx("typescript"))).toEqual([]);
  expect(pythonInheritanceExtension(ctx("python"))).not.toEqual([]);
});
