import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { completedSyntaxTree } from "@/test/syntax";
import { findLanguageDescription, loadSupport } from "../../../core/cm/languages";
import { createForAttribute, createForName, type CreateFix } from "./createFromUsage";

async function parse(source: string) {
  const support = await loadSupport(findLanguageDescription("Python", "demo.py")!);
  const state = EditorState.create({ doc: source, extensions: [support!] });
  return { doc: state.doc, tree: completedSyntaxTree(state) };
}

function applied(source: string, fix: CreateFix): string {
  const { from, text } = fix.insert;
  return source.slice(0, from) + text + source.slice(from);
}

const at = (source: string, needle: string) => source.indexOf(needle);

describe("Python create from usage", () => {
  it("creates a function above the top-level statement with parameters from the call", async () => {
    const source =
      "import os\n\n\ndef main():\n    r = make(count, label=x, *rest, **opts)\n    make2(1, a.b, count, count)\n";
    const { doc, tree } = await parse(source);
    const [fn, cls] = createForName(tree, doc, at(source, "make("), "    ");
    expect(fn!.kind).toBe("function");
    expect(applied(source, fn!)).toBe(
      "import os\n\n\ndef make(count, *args, label, **kwargs):\n    pass\n\n\ndef main():\n" +
        "    r = make(count, label=x, *rest, **opts)\n    make2(1, a.b, count, count)\n",
    );
    expect(fn!.insert.text.slice(fn!.body, fn!.body + 4)).toBe("pass");
    expect(cls!.insert.text).toBe(
      "class make:\n    def __init__(self, count, *args, label, **kwargs):\n        pass\n\n\n",
    );
    expect(cls!.insert.text.slice(cls!.body, cls!.body + 4)).toBe("pass");

    const [fn2] = createForName(tree, doc, at(source, "make2"), "    ");
    expect(fn2!.insert.text).toMatch(/^def make2\(param1, param2, count, count1\):/);
  });

  it("offers only a class for a name that is not called", async () => {
    const source = "x = isinstance(y, Widget)\n";
    const { doc, tree } = await parse(source);
    const fixes = createForName(tree, doc, at(source, "Widget"), "  ");
    expect(fixes.map((f) => f.kind)).toEqual(["class"]);
    expect(fixes[0]!.insert.text).toBe("class Widget:\n  pass\n\n\n");
  });

  it("creates a method at the end of the class for self and cls calls", async () => {
    const source =
      "class Greeter:\n    def greet(self, name):\n        self.helper(name, 3)\n\n    @classmethod\n" +
      "    def make(cls):\n        return cls.build()\n\n\nprint(1)\n";
    const { doc, tree } = await parse(source);
    const [method] = createForAttribute(tree, doc, at(source, "helper"), "    ");
    expect(method!.owner).toBe("Greeter");
    const result = applied(source, method!);
    expect(result).toContain(
      "        return cls.build()\n\n    def helper(self, name, param1):\n        pass\n\n\nprint(1)\n",
    );
    expect(method!.insert.text.slice(method!.body, method!.body + 4)).toBe("pass");

    const [classMethod] = createForAttribute(tree, doc, at(source, "build"), "    ");
    expect(classMethod!.insert.text).toBe("\n\n    @classmethod\n    def build(cls):\n        pass");
  });

  it("offers no method for another receiver or an attribute that is not called", async () => {
    const source = "class A:\n    def f(self, other):\n        other.g()\n        self.h\n";
    const { doc, tree } = await parse(source);
    expect(createForAttribute(tree, doc, at(source, "g()"), "    ")).toEqual([]);
    expect(createForAttribute(tree, doc, at(source, "h\n"), "    ")).toEqual([]);
  });

  it("never repeats a name: the receiver and keywords win, positional and starred names are renamed", async () => {
    const source =
      "def run():\n    f(args, *rest)\n    g(kwargs, **o)\n    h(x, x=1)\n    k(a,  # note\n      label=1)\n" +
      "    panel = Panel(self)\n";
    const { doc, tree } = await parse(source);
    const head = (needle: string, kind = 0) =>
      createForName(tree, doc, at(source, needle), "    ")[kind]!.insert.text.split("\n")[0];
    expect(head("f(")).toBe("def f(args, *args1):");
    expect(head("g(")).toBe("def g(kwargs, **kwargs1):");
    expect(head("h(")).toBe("def h(x1, x):");
    expect(head("k(")).toBe("def k(a, label):");
    expect(createForName(tree, doc, at(source, "Panel"), "    ")[1]!.insert.text).toMatch(
      /^class Panel:\n {4}def __init__\(self, self1\):/,
    );
  });

  it("follows the calling method's decorators, not the receiver's name", async () => {
    const source =
      "class A:\n    def f(self):\n        self.register(self)\n\n    @classmethod\n    def make(klass):\n" +
      "        return klass.build()\n\n    @staticmethod\n    def s(x):\n        x.g()\n";
    const { doc, tree } = await parse(source);
    const text = (needle: string) =>
      createForAttribute(tree, doc, at(source, needle), "    ").map((f) => f.insert.text);
    expect(text("register")).toEqual(["\n\n    def register(self, self1):\n        pass"]);
    expect(text("build")).toEqual(["\n\n    @classmethod\n    def build(klass):\n        pass"]);
    expect(text("g()")).toEqual([]);
  });
  it("keeps receiver keywords and makes normalized parameter names unique", async () => {
    const source = "def run(K):\n    work(K, K, 1, param1)\n    return Widget(self=1)\n";
    const { doc, tree } = await parse(source);
    expect(createForName(tree, doc, at(source, "work"), "    ")[0]!.insert.text).toMatch(
      /^def work\(K, K1, param2, param1\):/,
    );
    expect(createForName(tree, doc, at(source, "Widget"), "    ")[1]!.insert.text).toMatch(
      /^class Widget:\n {4}def __init__\(self1, self\):/,
    );
  });

  it("creates async functions and methods for awaited calls, including grouped calls", async () => {
    const source =
      "async def run():\n    await (work(1))\n\nclass A:\n    @builtins.classmethod\n" +
      "    async def run(cls):\n        await (cls.load)(cls=1)\n\n" +
      "    @builtins.staticmethod\n    def other(x):\n        x.missing()\n";
    const { doc, tree } = await parse(source);
    expect(createForName(tree, doc, at(source, "work"), "    ")[0]!.insert.text).toMatch(/^async def work\(param1\):/);
    expect(createForAttribute(tree, doc, at(source, "load"), "    ")[0]!.insert.text).toContain(
      "    @classmethod\n    async def load(cls1, cls):",
    );
    expect(createForAttribute(tree, doc, at(source, "missing"), "    ")).toEqual([]);
  });
});
