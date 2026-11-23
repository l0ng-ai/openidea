import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { InlayHint } from "@/bindings";
import { completedSyntaxState, completedSyntaxTree } from "@/test/syntax";
import { findLanguageDescription, loadSupport } from "../../../core/cm/languages";

const ipc = vi.hoisted(() => ({ lspInlayHints: vi.fn(), lspHover: vi.fn() }));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
const files = vi.hoisted(() => ({ readFileLines: vi.fn() }));
vi.mock("../../files", () => files);

const { annotationTarget, builtinHoverType, minorNeeded, requiredMinor, pythonTypeHintIntentions } =
  await import("./typeHints");
const { lspDoc } = await import("../../lsp");
const { useProject } = await import("@/platform/project");

const support = await loadSupport(findLanguageDescription("Python", "demo.py")!);

async function targetAt(source: string, marker: string, delta = 0) {
  const state = EditorState.create({ doc: source, extensions: [support!] });
  const target = annotationTarget(completedSyntaxTree(state), state.doc, source.indexOf(marker) + delta);
  if (target?.kind !== "function")
    return target && { kind: target.kind, end: source.slice(0, target.slot.end), evaluated: target.evaluated };
  return {
    kind: target.kind,
    name: target.name,
    returns: target.returns && source.slice(0, target.returns.end),
    params: target.params.map((p) => source.slice(0, p.end).split(/\W/).pop()),
  };
}

describe("Python type annotation targets", () => {
  const source =
    "class A:\n    def run(self, path, limit=10, *rest, flag: bool = False, mode='r', **kw):\n" +
    "        count = len(path)\n        a = b = 1\n        x, y = 1, 2\n        typed: int = 3\n        return count\n";

  it("finds a plain assignment target, with the caret on either side of the name", async () => {
    expect(await targetAt(source, "count =")).toEqual({
      kind: "variable",
      end: source.slice(0, source.indexOf("count =") + 5),
      evaluated: false,
    });
    expect((await targetAt(source, "count =", 5))?.kind).toBe("variable");
    expect((await targetAt("total = 0\n", "total"))?.evaluated).toBe(true);
  });

  it("skips chained, tuple and annotated targets and other statements", async () => {
    expect(await targetAt(source, "a = b")).toBeNull();
    expect(await targetAt(source, "x, y")).toBeNull();
    expect(await targetAt(source, "typed")).toBeNull();
    expect(await targetAt(source, "return count", 3)).toBeNull();
  });

  it("skips class attributes and names declared global or nonlocal", async () => {
    expect(await targetAt("@dataclass\nclass C:\n    retries = 3\n", "retries")).toBeNull();
    expect(await targetAt("def f():\n    global hits, total\n    total = 1\n", "total =")).toBeNull();
    expect(
      await targetAt("def f():\n    x = 0\n    def g():\n        nonlocal x\n        x = 1\n", "x = 1"),
    ).toBeNull();
    expect(await targetAt("def f():\n    global hits\n    total = 1\n", "total =")).not.toBeNull();
    expect(await targetAt("total = 0\n\ndef f():\n    global total\n    total = 1\n", "total = 0")).not.toBeNull();
    expect(await targetAt("def f():\n    x = 0\n    def g():\n        nonlocal x\n", "x = 0")).not.toBeNull();
  });

  it("finds a function header with its unannotated defaulted parameters", async () => {
    expect(await targetAt(source, "def run", 5)).toEqual({
      kind: "function",
      name: "run",
      returns: source.slice(0, source.indexOf("**kw)") + 5),
      params: ["limit", "mode"],
    });
    expect((await targetAt('def connect(host="localhost", port=8080):\n    pass\n', "connect"))?.params).toEqual([
      "host",
      "port",
    ]);
    expect((await targetAt("def f() -> int:\n    pass\n", "f("))?.returns).toBeNull();
  });
});

describe("annotation syntax by Python version", () => {
  it("knows which types need 3.9 or 3.10 when evaluated", () => {
    expect(minorNeeded(": str | None")).toBe(10);
    expect(minorNeeded("-> list[int]")).toBe(9);
    expect(minorNeeded(": List[int]")).toBe(0);
    expect(minorNeeded(": int")).toBe(0);
  });

  it("reads the lowest version from requires-python", () => {
    expect(requiredMinor(["[project]", 'requires-python = ">=3.10"'])).toBe(10);
    expect(requiredMinor(["requires-python = '~=3.8'"])).toBe(8);
    expect(requiredMinor(["[project]", 'name = "x"'])).toBe(0);
  });
});

describe("builtinHoverType", () => {
  it("keeps types made of builtins only", () => {
    expect(builtinHoverType("```python\n(parameter) limit: int\n```")).toBe("int");
    expect(builtinHoverType("```python\n(variable) names: list[str]\n```")).toBe("list[str]");
    expect(builtinHoverType("```python\n(parameter) mode: str | None\n```")).toBe("str | None");
    expect(builtinHoverType("```python\n(parameter) p: Path\n```")).toBeNull();
    expect(builtinHoverType("```python\n(parameter) x: None\n```")).toBeNull();
    expect(builtinHoverType("```python\n(variable) v: Unknown\n```")).toBeNull();
  });
});

describe("pythonTypeHintIntentions", () => {
  const ctx = { doc: 3, path: "/p/m.py", language: "python", uiMode: "Python", readOnly: false };
  const views: EditorView[] = [];
  const range = (line: number, col: number) => ({ start: { line, col }, end: { line, col } });
  const hint = (line: number, col: number, label: string, edits: [number, number, string][]): InlayHint => ({
    position: { line, col },
    label,
    kind: "type",
    paddingLeft: false,
    paddingRight: false,
    tooltip: null,
    parts: [],
    textEdits: edits.map(([l, c, text]) => ({ range: range(l, c), new_text: text })),
  });
  const hover = (text: string) => ({
    status: "ok",
    data: { contents: { kind: "markdown", value: text }, range: null },
  });

  function mount(doc: string, caret: string, delta = 0) {
    const state = completedSyntaxState(
      EditorState.create({
        doc,
        selection: { anchor: doc.indexOf(caret) + delta },
        extensions: [support!, lspDoc.of(ctx)],
      }),
    );
    const view = new EditorView({ state, parent: document.body });
    views.push(view);
    return view;
  }

  async function run(view: EditorView, label: string) {
    const found = await pythonTypeHintIntentions(view, new AbortController().signal);
    await found.find((i) => i.label === label)!.run();
    return { labels: found.map((i) => i.label), text: view.state.doc.toString() };
  }

  afterEach(() => {
    for (const v of views.splice(0)) v.destroy();
    vi.clearAllMocks();
    useProject.setState({ project: null });
  });

  it("inserts a variable's hint with its import edit", async () => {
    ipc.lspInlayHints.mockResolvedValue({
      status: "ok",
      data: [
        hint(3, 9, ": Any", [
          [3, 9, ": Any"],
          [0, 0, "from typing import Any\n"],
        ]),
      ],
    });
    const view = mount("import os\n\ndef f():\n    chart = make()\n", "chart");
    // A local's annotation never runs, so no version lookup.
    expect(await run(view, "Add type annotation ': Any'")).toEqual({
      labels: ["Add type annotation ': Any'"],
      text: "from typing import Any\nimport os\n\ndef f():\n    chart: Any = make()\n",
    });
    expect(files.readFileLines).not.toHaveBeenCalled();
  });

  it("merges the return hint with hovered parameter types, once per import", async () => {
    files.readFileLines.mockResolvedValue(['requires-python = ">=3.10"']);
    useProject.setState({ project: { root: "/p" } } as never);
    ipc.lspInlayHints.mockResolvedValue({
      status: "ok",
      data: [hint(0, 29, "-> str | None", [[0, 29, " -> str | None"]])],
    });
    ipc.lspHover.mockImplementation(async (_id: number, _doc: number, pos: { col: number }) =>
      hover(pos.col < 20 ? "(parameter) host: str" : "(parameter) port: int"),
    );
    const view = mount('def connect(host="h", port=1):\n    return None\n', "connect");
    expect(await run(view, "Add type hints for function 'connect'")).toEqual({
      labels: ["Add return type annotation '-> str | None'", "Add type hints for function 'connect'"],
      text: 'def connect(host: str = "h", port: int = 1) -> str | None:\n    return None\n',
    });
  });

  it("declines 3.10 syntax in an evaluated annotation for an older or unknown Python", async () => {
    files.readFileLines.mockResolvedValue(['requires-python = ">=3.8"']);
    useProject.setState({ project: { root: "/p" } } as never);
    ipc.lspInlayHints.mockResolvedValue({ status: "ok", data: [hint(0, 5, ": str | None", [[0, 5, ": str | None"]])] });
    ipc.lspHover.mockResolvedValue(hover("(variable) maybe: str | None"));
    const old = await pythonTypeHintIntentions(mount("maybe = find()\n", "maybe"), new AbortController().signal);
    expect(old).toEqual([]);
    const future = mount("from __future__ import annotations\nmaybe = find()\n", "maybe");
    ipc.lspInlayHints.mockResolvedValue({ status: "ok", data: [hint(1, 5, ": str | None", [[1, 5, ": str | None"]])] });
    expect((await run(future, "Add type annotation ': str | None'")).text).toContain("maybe: str | None = find()");
  });

  it("only postpones annotation evaluation for an actual future import of annotations", async () => {
    files.readFileLines.mockResolvedValue(['requires-python = ">=3.8"']);
    useProject.setState({ project: { root: "/p" } } as never);
    ipc.lspInlayHints.mockResolvedValue({ status: "ok", data: [] });
    ipc.lspHover.mockResolvedValue(hover("(variable) maybe: str | None"));
    for (const prefix of [
      '"""\nfrom __future__ import annotations\n"""',
      "from __future__ import division as annotations",
      "from __future__ import division # annotations",
    ]) {
      const view = mount(`${prefix}\nmaybe = find()\n`, "maybe");
      expect(await pythonTypeHintIntentions(view, new AbortController().signal)).toEqual([]);
    }
    for (const prefix of [
      "from __future__ import (\n    annotations,\n)",
      "from __future__ import annotations; pass",
    ]) {
      const view = mount(`${prefix}\nmaybe = find()\n`, "maybe");
      expect((await run(view, "Add type annotation ': str | None'")).text).toContain("maybe: str | None = find()");
    }
  });

  it("falls back to hover for older servers returning hints without insertion edits", async () => {
    ipc.lspInlayHints.mockResolvedValue({
      status: "ok",
      data: [{ ...hint(0, 5, ": int", []), textEdits: undefined }],
    });
    ipc.lspHover.mockResolvedValue(hover("(variable) count: int"));
    const view = mount("count = 1\n", "count");
    expect((await run(view, "Add type annotation ': int'")).text).toEqual("count: int = 1\n");
  });
});
