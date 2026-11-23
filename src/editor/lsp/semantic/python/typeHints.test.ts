import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { completedSyntaxTree } from "@/test/syntax";
import { findLanguageDescription, loadSupport } from "../../../core/cm/languages";
import { annotationTarget, builtinHoverType } from "./typeHints";

async function targetAt(source: string, marker: string, delta = 0) {
  const support = await loadSupport(findLanguageDescription("Python", "demo.py")!);
  const state = EditorState.create({ doc: source, extensions: [support!] });
  const target = annotationTarget(completedSyntaxTree(state), state.doc, source.indexOf(marker) + delta);
  if (target?.kind !== "function") return target && { kind: target.kind, end: source.slice(0, target.slot.end) };
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
    });
    expect((await targetAt(source, "count =", 5))?.kind).toBe("variable");
  });

  it("skips chained, tuple and annotated targets and other statements", async () => {
    expect(await targetAt(source, "a = b")).toBeNull();
    expect(await targetAt(source, "x, y")).toBeNull();
    expect(await targetAt(source, "typed")).toBeNull();
    expect(await targetAt(source, "return count", 3)).toBeNull();
  });

  it("finds a function header with its unannotated defaulted parameters", async () => {
    expect(await targetAt(source, "def run", 5)).toEqual({
      kind: "function",
      name: "run",
      returns: source.slice(0, source.indexOf("**kw)") + 5),
      params: ["limit", "mode"],
    });
    expect((await targetAt("def f() -> int:\n    pass\n", "f("))?.returns).toBeNull();
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
